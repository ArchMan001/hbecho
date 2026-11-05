// CLI：`pnpm master-data bootstrap|precheck|confirm|batches|batch|rows|report|store change-code`（design §10）。
// 只调用 Module，不直接写库；输出 JSON，BIGINT 一律十进制字符串。
// 退出码：0 成功 / 2 输入、授权 / 3 冲突 / 4 不存在 / 5 超过时间上限 / 1 其他错误。
// 没有 --skip-auth、--force 之类的旁路：权限边界只来自服务身份（环境变量，缺 brand_scope 启动失败）。
import { parseArgs } from "node:util";
import { loadSeed, MasterDataError, type ActorContext, type MasterData, type SeedRow } from "../modules/master-data-import";

export interface MasterDataCliDeps {
  md: MasterData;
  actor: ActorContext;
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: string): void;
  loadSeed?(path?: string): SeedRow[];
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}

const USAGE = [
  "用法：",
  "  master-data bootstrap [--seed <csv>]",
  "  master-data precheck --file <csv> --mode import|structure",
  "  master-data confirm --batch <id> [--close-store <store_id>]...",
  "  master-data batches [--offset N] [--limit N]",
  "  master-data batch <id>",
  "  master-data rows <id> [--offset N] [--limit N]",
  "  master-data report <id> --out <csv>",
  "  master-data store change-code --store-id <id> --new-code <code>",
].join("\n");

const EXIT: Record<MasterDataError["category"], number> = { input: 2, authorization: 2, conflict: 3, not_found: 4, limit: 5, configuration: 1 };

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new MasterDataError("input", "invalid_input", `不是非负整数：${v}\n${USAGE}`);
  return Number(v);
};

export async function runCli(argv: string[], deps: MasterDataCliDeps): Promise<number> {
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v)}\n`);
  const fail = (e: MasterDataError): number => {
    print({ ok: false, error: { code: e.code, message: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) } });
    return EXIT[e.category];
  };
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "bootstrap": {
        const { values } = parseArgs({ args: rest, strict: true, options: { seed: { type: "string" } } });
        const seed = (deps.loadSeed ?? loadSeed)(values.seed);
        print({ ok: true, ...(await deps.md.structure.bootstrap(seed, deps.actor)) });
        return 0;
      }
      case "precheck": {
        const { values } = parseArgs({ args: rest, strict: true, options: { file: { type: "string" }, mode: { type: "string" } } });
        if (values.file === undefined || (values.mode !== "import" && values.mode !== "structure")) {
          throw new MasterDataError("input", "invalid_input", `需要 --file 与 --mode import|structure\n${USAGE}`);
        }
        const r = await deps.md.imports.precheck({ fileName: values.file.split("/").pop() ?? values.file, bytes: deps.readFile(values.file), mode: values.mode }, deps.actor);
        if (r.summary.suspect_incomplete_export) deps.stderr("警告：疑似导出不完整（待确认撤店占比超过 20%），请核对文件再确认。\n");
        print({ ok: true, ...r });
        return 0;
      }
      case "confirm": {
        const { values } = parseArgs({ args: rest, strict: true, options: { batch: { type: "string" }, "close-store": { type: "string", multiple: true } } });
        if (values.batch === undefined) throw new MasterDataError("input", "invalid_input", `需要 --batch\n${USAGE}`);
        const r = await deps.md.imports.confirm(values.batch, { closureStoreIds: values["close-store"] ?? [] }, deps.actor);
        print({ ok: true, ...r });
        return 0;
      }
      case "batches": {
        const { values } = parseArgs({ args: rest, strict: true, options: { offset: { type: "string" }, limit: { type: "string" } } });
        const page = { ...(values.offset === undefined ? {} : { offset: num(values.offset)! }), ...(values.limit === undefined ? {} : { limit: num(values.limit)! }) };
        print({ ok: true, batches: await deps.md.query.list(page, deps.actor) });
        return 0;
      }
      case "batch": {
        const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} });
        if (positionals.length !== 1) throw new MasterDataError("input", "invalid_input", `需要且只需要一个批次 ID\n${USAGE}`);
        print({ ok: true, ...(await deps.md.query.get(positionals[0]!, deps.actor)) });
        return 0;
      }
      case "rows": {
        const { values, positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { offset: { type: "string" }, limit: { type: "string" } } });
        if (positionals.length !== 1) throw new MasterDataError("input", "invalid_input", `需要且只需要一个批次 ID\n${USAGE}`);
        const page = { ...(values.offset === undefined ? {} : { offset: num(values.offset)! }), ...(values.limit === undefined ? {} : { limit: num(values.limit)! }) };
        print({ ok: true, rows: await deps.md.query.rows(positionals[0]!, page, deps.actor) });
        return 0;
      }
      case "report": {
        const { values, positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { out: { type: "string" } } });
        if (positionals.length !== 1 || values.out === undefined) throw new MasterDataError("input", "invalid_input", `需要批次 ID 与 --out\n${USAGE}`);
        const f = await deps.md.query.returnFile(positionals[0]!, deps.actor);
        deps.writeFile(values.out, f.content);
        print({ ok: true, rows: f.rows, out: values.out });
        return 0;
      }
      case "store": {
        const [sub, ...args] = rest;
        if (sub !== "change-code") throw new MasterDataError("input", "invalid_input", `未知子命令\n${USAGE}`);
        const { values } = parseArgs({ args, strict: true, options: { "store-id": { type: "string" }, "new-code": { type: "string" } } });
        if (values["store-id"] === undefined || values["new-code"] === undefined) throw new MasterDataError("input", "invalid_input", `需要 --store-id 与 --new-code\n${USAGE}`);
        print({ ok: true, ...(await deps.md.structure.changeStoreCode(values["store-id"], values["new-code"], deps.actor)) });
        return 0;
      }
      default:
        throw new MasterDataError("input", "invalid_input", `未知子命令\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof MasterDataError) return fail(e);
    if (e instanceof TypeError && String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) {
      return fail(new MasterDataError("input", "invalid_input", `${e.message}\n${USAGE}`));
    }
    if ((e as { code?: string }).code === "ENOENT") return fail(new MasterDataError("input", "file_not_found", "找不到指定文件"));
    deps.onInternalError?.(e);
    print({ ok: false, error: { code: "internal_error", message: "内部错误，详见服务端日志" } });
    deps.stderr(`internal_error (${e instanceof Error ? e.name : typeof e})\n`);
    return 1;
  }
}
