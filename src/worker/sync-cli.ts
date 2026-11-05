// CLI：`pnpm sync tick|supplement|batch cancel|batches`（design §15，任务 3 范围；worker / demand / 运营处置命令在后续任务补）。
// 只调用 Module，不直接写库；输出 JSON。退出码：0 成功 / 2 校验、授权 / 3 冲突 / 4 不存在 / 1 其他。
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { DemandModule } from "../modules/demand";
import { SyncError, type SyncCommands, type SyncScheduler } from "../modules/sync-schedule";
import type { ActorContext } from "../modules/tracer-command";

export interface SyncCliDeps {
  scheduler: Pick<SyncScheduler, "tick">;
  commands: Pick<SyncCommands, "createSupplement" | "cancelBatch" | "listBatches">;
  /** 按需采集入口（规则域的提交 / 查询）；运营 CLI 只在配置了详情 / 评论模式时提供。 */
  demand?: Pick<DemandModule, "submit" | "get">;
  readFile?(path: string): Promise<string>;
  actor: ActorContext;
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}

const USAGE = [
  "用法：",
  "  sync tick",
  "  sync supplement --accounts <id,id,...> --key <幂等key> [--only profile|full] [--if-older-than <小时>] [--on-busy run_now|queue|cancel_current] [--apply]",
  "  sync batch cancel <batch_id> [--apply]      默认只预览，--apply 才取消",
  "  sync demand submit --file <需求.json>        提交按需采集需求（详情 / 评论 / 视频 / 音频）",
  "  sync demand get <demand_batch_id>             查询逐项状态与读取指针（只读本地）",
  "  sync batches [--limit N] [--purpose full|supplement|demand|intake] [--status <状态>]",
].join("\n");

const EXIT: Record<SyncError["category"], number> = { input: 2, authorization: 2, conflict: 3, not_found: 4, configuration: 1 };

export async function runSyncCli(argv: string[], deps: SyncCliDeps): Promise<number> {
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v)}\n`);
  const bad = (msg: string) => new SyncError("invalid_input", `${msg}\n${USAGE}`);
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "tick": {
        parseArgs({ args: rest, strict: true, options: {} });
        print(await deps.scheduler.tick());
        return 0;
      }
      case "supplement": {
        const { values } = parseArgs({
          args: rest,
          strict: true,
          options: {
            accounts: { type: "string" },
            key: { type: "string" },
            only: { type: "string" },
            "if-older-than": { type: "string" },
            "on-busy": { type: "string" },
            apply: { type: "boolean" },
          },
        });
        if (values.accounts === undefined) throw bad("缺少 --accounts");
        if (values.key === undefined) throw bad("缺少 --key");
        const hours = values["if-older-than"];
        // 非数字原样交给 Module 的校验拒绝；CLI 不自己解释
        const r = await deps.commands.createSupplement(
          {
            accountIds: values.accounts.split(",").map((s) => s.trim()).filter((s) => s !== ""),
            idempotencyKey: values.key,
            ...(values.only === undefined ? {} : { only: values.only }),
            ...(hours === undefined ? {} : { ifOlderThanHours: Number(hours) }),
            ...(values["on-busy"] === undefined ? {} : { onBusy: values["on-busy"] }),
            ...(values.apply ? { apply: true } : {}),
          } as never,
          deps.actor,
        );
        print(r);
        return r.kind === "no_accounts" ? 2 : 0;
      }
      case "batch": {
        const [sub, ...args] = rest;
        if (sub !== "cancel") throw bad("未知子命令");
        const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { apply: { type: "boolean" } } });
        if (positionals.length !== 1) throw bad("需要且只需要一个 batch_id");
        print(await deps.commands.cancelBatch(positionals[0]!, deps.actor, { apply: values.apply === true }));
        return 0;
      }
      case "demand": {
        const [sub, ...args] = rest;
        if (!deps.demand) throw bad("按需采集未启用（缺少 HBECHO_SYNC_DETAIL_MODE / HBECHO_SYNC_COMMENTS_MODE）");
        if (sub === "submit") {
          const { values } = parseArgs({ args, strict: true, options: { file: { type: "string" } } });
          if (values.file === undefined) throw bad("缺少 --file");
          let payload: unknown;
          try {
            payload = JSON.parse(await (deps.readFile ?? ((p: string) => readFile(p, "utf8")))(values.file));
          } catch {
            throw bad("--file 不是可读取的 JSON 文件");
          }
          const r = await deps.demand.submit(payload, deps.actor);
          print(r);
          return 0;
        }
        if (sub === "get") {
          const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} });
          if (positionals.length !== 1) throw bad("需要且只需要一个 demand_batch_id");
          print(await deps.demand.get(positionals[0]!, deps.actor));
          return 0;
        }
        throw bad("未知子命令");
      }
      case "batches": {
        const { values } = parseArgs({ args: rest, strict: true, options: { limit: { type: "string" }, purpose: { type: "string" }, status: { type: "string" } } });
        if (values.limit !== undefined && !/^\d+$/.test(values.limit)) throw bad("--limit 必须是正整数");
        print(
          await deps.commands.listBatches({
            ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
            ...(values.purpose === undefined ? {} : { purpose: values.purpose }),
            ...(values.status === undefined ? {} : { status: values.status }),
          }),
        );
        return 0;
      }
      default:
        throw bad("未知子命令");
    }
  } catch (e) {
    if (e instanceof SyncError) {
      print({ ok: false, error: { code: e.code, message: e.message } });
      return EXIT[e.category];
    }
    if (e instanceof TypeError && String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) {
      print({ ok: false, error: { code: "invalid_input", message: `${e.message}\n${USAGE}` } });
      return 2;
    }
    deps.onInternalError?.(e);
    print({ ok: false, error: { code: "internal_error", message: "内部错误，详见服务端日志" } });
    deps.stderr(`internal_error (${e instanceof Error ? e.name : typeof e})\n`);
    return 1;
  }
}
