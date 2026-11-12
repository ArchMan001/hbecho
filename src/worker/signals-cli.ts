// CLI：`pnpm signals <命令>`（design §9）。只调用 Module，不直接读写库；输出 JSON，BIGINT 一律十进制字符串。
// 退出码：0 成功 / 2 输入、授权 / 3 冲突 / 4 不存在 / 5 超限 / 1 配置与其他错误（与 plan-cli 一致）。
// 没有 --force、--skip-auth 之类的旁路：权限边界只来自环境变量身份（HBECHO_SIG_*，缺任一项启动失败）。
import { parseArgs } from "node:util";
import { CAP_ACCOUNT_READ, CAP_CONTENT_READ, assert, CATALOG, SignalError, capabilityOf, platformSignals, versionOf, type SignalActor, type SignalReader, type Subject } from "../modules/signals";

export interface SignalsCliDeps {
  reader: SignalReader;
  actor: SignalActor;
  /** 启用的能力标识，catalog 命令用它标注每个信号是否已启用。 */
  enabled: ReadonlySet<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}

const USAGE = [
  "用法：",
  "  signals catalog [--object content|account|comment] [--platform douyin|xiaohongshu|kuaishou]",
  "  signals show --content <ID> | --account <ID> | --comment <ID>",
].join("\n");
const EXIT: Record<SignalError["category"], number> = { input: 2, authorization: 2, conflict: 3, not_found: 4, limit: 5, configuration: 1 };
const bad = (msg: string): never => {
  throw new SignalError("input", "invalid_input", `${msg}\n${USAGE}`);
};
const id = (v: string, what: string): bigint => (/^[1-9]\d*$/.test(v) ? BigInt(v) : bad(`${what}必须是不带前导零的正十进制整数`));

export async function runSignalsCli(argv: string[], deps: SignalsCliDeps): Promise<number> {
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))}\n`);
  const done = (v: object): number => (print({ ok: true, ...v }), 0);
  const fail = (e: SignalError): number => {
    print({ ok: false, error: { code: e.code, message: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) } });
    return EXIT[e.category];
  };
  try {
    const [cmd, ...rest] = argv;
    const parse = <O extends Record<string, { type: "string" }>>(options: O) => parseArgs({ args: rest, strict: true, allowPositionals: false, options });
    switch (cmd) {
      case "catalog": {
        const { values } = parse({ object: { type: "string" }, platform: { type: "string" } });
        if (values.object !== undefined && !["content", "account", "comment"].includes(values.object)) bad("--object 只能是 content、account、comment");
        const allowed = values.platform === undefined ? undefined : new Set(platformSignals(values.platform));
        const signals = CATALOG.filter((e) => (values.object === undefined || e.object === values.object) && (allowed === undefined || allowed.has(e.key))).map((e) => {
          const platforms = values.platform === undefined ? e.platforms : [values.platform];
          return {
            signal: e.key,
            object: e.object,
            scope: e.scope,
            costTier: e.costTier,
            storage: e.storage,
            platforms: e.platforms,
            // 能力标识含平台时逐平台列出
            capabilities: [...new Set(platforms.map((p) => capabilityOf(e, p)))].map((c) => ({ id: c, version: versionOf(c), enabled: deps.enabled.has(c) })),
          };
        });
        return done({ signals });
      }
      case "show": {
        const { values } = parse({ content: { type: "string" }, account: { type: "string" }, comment: { type: "string" } });
        const given = (["content", "account", "comment"] as const).filter((k) => values[k] !== undefined);
        if (given.length !== 1) bad("需要且只需要 --content、--account、--comment 之一");
        const kind = given[0]!;
        const subject: Subject = { kind, id: id(values[kind]!, `--${kind}`) };
        const requires = kind === "account" ? CAP_ACCOUNT_READ : CAP_CONTENT_READ;
        assert(deps.actor, requires); // 先于任何读库
        // 参数化信号需要监控段里的图片 / 判定项才能读，show 只列出它们的名字
        const entries = CATALOG.filter((e) => e.object === kind);
        const signals = [];
        const needParam: string[] = [];
        for (const e of entries) {
          if (e.scope === "parameterized") {
            needParam.push(e.key);
            continue;
          }
          const v = await deps.reader.read(deps.actor, subject, e.key, { requires });
          signals.push({ signal: e.key, ...v });
        }
        return done({ subject, signals, requiresParam: needParam });
      }
      default:
        return bad(cmd === undefined ? "缺少命令" : `未知命令：${cmd}`);
    }
  } catch (e) {
    if (e instanceof SignalError) return fail(e);
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(new SignalError("input", "invalid_input", `${e.message}\n${USAGE}`));
    deps.onInternalError?.(e);
    deps.stderr(`内部错误：${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
