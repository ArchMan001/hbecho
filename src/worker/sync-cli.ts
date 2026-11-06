// CLI：`pnpm sync tick|supplement|batch cancel|batches`（design §15，任务 3 范围；worker / demand / 运营处置命令在后续任务补）。
// 只调用 Module，不直接写库；输出 JSON。退出码：0 成功 / 2 校验、授权 / 3 冲突 / 4 不存在 / 1 其他。
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { DemandModule } from "../modules/demand";
import type { MaintenanceReport } from "../modules/maintenance";
import type { MonitoringSwitch } from "../modules/monitoring/set-switch";
import type { SyncOps } from "../modules/sync-ops";
import type { SyncStatus } from "../modules/sync-status";
import { SyncError, type SyncCommands, type SyncScheduler } from "../modules/sync-schedule";
import type { ActorContext } from "../modules/tracer-command";

export interface SyncCliDeps {
  scheduler: Pick<SyncScheduler, "tick">;
  commands: Pick<SyncCommands, "createSupplement" | "cancelBatch" | "listBatches">;
  /** 按需采集入口（规则域的提交 / 查询）；运营 CLI 只在配置了详情 / 评论模式时提供。 */
  demand?: Pick<DemandModule, "submit" | "get">;
  /** 处置命令（改绑、确认删除、质量问题、放回重试、外部账号）；未装配时对应子命令报「未启用」。 */
  ops?: SyncOps;
  monitoringSwitch?: Pick<MonitoringSwitch, "set">;
  /** 只读状态查询。 */
  status?: SyncStatus;
  /** 立刻跑一轮每日维护（需要 ODS 桶的 OSS 配置）。 */
  maintain?: () => Promise<{ ok: boolean; report: MaintenanceReport }>;
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
  "  sync batch retry-failed <batch_id> [--apply] 把本批次 failed / dead 任务放回重试（最新 full 批次，下一批次未开始）；默认只预览",
  "  sync status [--limit N]                      最近批次 + 最新全量批次的完整报告（只读本地）",
  "  sync batch <batch_id>                        单个批次报告：任务计数、失败原因、三态身份校验、媒资进度、调用数与点数",
  "  sync account <account_id>                    单个账号：最近批次结果、检查点、被排除原因、质量问题",
  "  sync account rebind --account <id> --staff <id>",
  "  sync account confirm-deleted --account <id>",
  "  sync freshness [--older-than-hours H]        超过 H 小时（默认 168）没有成功同步的有效监控账号",
  "  sync sample --n <N> [--batch <id>]           随机抽 N 个本批次成功账号，供人工对账（只读）",
  "  sync issue list [--status open|acknowledged|ignored|resolved] [--limit N]",
  "  sync issue set-status --issue <id> --status acknowledged|ignored|resolved [--note <文字>]",
  "  sync monitoring set --level branch|dealer|store|staff|account --id <id> --enabled true|false [--apply]   组织级默认只预览",
  "  sync external add --platform <p> --locator <入口> --key <幂等key> | list | enable --account <id> | disable --account <id>",
  "  sync maintain                                立刻跑一轮每日维护（ODS 清理、孤儿清扫）",
  "  sync demand submit --file <需求.json>        提交按需采集需求（详情 / 评论 / 视频 / 音频）",
  "  sync demand get <demand_batch_id>             查询逐项状态与读取指针（只读本地）",
  "  sync batches [--limit N] [--purpose full|supplement|demand|intake] [--status <状态>]",
].join("\n");

const EXIT: Record<SyncError["category"], number> = { input: 2, authorization: 2, conflict: 3, not_found: 4, configuration: 1 };

export async function runSyncCli(argv: string[], deps: SyncCliDeps): Promise<number> {
  const need = <T>(m: T | undefined, what: string): T => {
    if (m === undefined) throw new SyncError("invalid_input", `${what}未启用\n${USAGE}`);
    return m;
  };
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
        if (sub === "cancel" || sub === "retry-failed") {
          const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { apply: { type: "boolean" } } });
          if (positionals.length !== 1) throw bad("需要且只需要一个 batch_id");
          if (sub === "cancel") print(await deps.commands.cancelBatch(positionals[0]!, deps.actor, { apply: values.apply === true }));
          else print(await need(deps.ops, "处置命令").retryFailed({ batchId: positionals[0], apply: values.apply === true }, deps.actor));
          return 0;
        }
        if (sub !== undefined && /^\d+$/.test(sub)) {
          parseArgs({ args, strict: true, options: {} });
          print(await need(deps.status, "状态查询").batch(sub));
          return 0;
        }
        throw bad("未知子命令");
      }
      case "status": {
        const { values } = parseArgs({ args: rest, strict: true, options: { limit: { type: "string" } } });
        if (values.limit !== undefined && !/^\d+$/.test(values.limit)) throw bad("--limit 必须是正整数");
        print(await need(deps.status, "状态查询").status(values.limit === undefined ? {} : { limit: Number(values.limit) }));
        return 0;
      }
      case "account": {
        const [sub, ...args] = rest;
        if (sub === "rebind" || sub === "confirm-deleted") {
          const { values } = parseArgs({ args, strict: true, options: { account: { type: "string" }, staff: { type: "string" } } });
          if (values.account === undefined) throw bad("缺少 --account");
          const ops = need(deps.ops, "处置命令");
          if (sub === "rebind") {
            if (values.staff === undefined) throw bad("缺少 --staff");
            print(await ops.rebind({ accountId: values.account, staffId: values.staff }, deps.actor));
          } else print(await ops.confirmDeleted({ accountId: values.account }, deps.actor));
          return 0;
        }
        if (sub === undefined || args.length > 0) throw bad("需要 account <id> 或 rebind / confirm-deleted");
        print(await need(deps.status, "状态查询").account(sub));
        return 0;
      }
      case "freshness": {
        const { values } = parseArgs({ args: rest, strict: true, options: { "older-than-hours": { type: "string" } } });
        const h = values["older-than-hours"];
        if (h !== undefined && !/^\d+(\.\d+)?$/.test(h)) throw bad("--older-than-hours 必须是正数");
        print(await need(deps.status, "状态查询").freshness({ olderThanHours: h === undefined ? 168 : Number(h) }));
        return 0;
      }
      case "sample": {
        const { values } = parseArgs({ args: rest, strict: true, options: { n: { type: "string" }, batch: { type: "string" } } });
        if (values.n === undefined || !/^\d+$/.test(values.n)) throw bad("缺少 --n（正整数）");
        print(await need(deps.status, "状态查询").sample({ n: Number(values.n), ...(values.batch === undefined ? {} : { batchId: values.batch }) }));
        return 0;
      }
      case "issue": {
        const [sub, ...args] = rest;
        const ops = need(deps.ops, "处置命令");
        if (sub === "list") {
          const { values } = parseArgs({ args, strict: true, options: { status: { type: "string" }, limit: { type: "string" } } });
          if (values.limit !== undefined && !/^\d+$/.test(values.limit)) throw bad("--limit 必须是正整数");
          print(await ops.listIssues({ ...(values.status === undefined ? {} : { status: values.status }), ...(values.limit === undefined ? {} : { limit: Number(values.limit) }) }));
          return 0;
        }
        if (sub === "set-status") {
          const { values } = parseArgs({ args, strict: true, options: { issue: { type: "string" }, status: { type: "string" }, note: { type: "string" } } });
          if (values.issue === undefined || values.status === undefined) throw bad("缺少 --issue 或 --status");
          print(await ops.setIssueStatus({ issueId: values.issue, status: values.status, ...(values.note === undefined ? {} : { note: values.note }) }, deps.actor));
          return 0;
        }
        throw bad("未知子命令");
      }
      case "monitoring": {
        const [sub, ...args] = rest;
        if (sub !== "set") throw bad("未知子命令");
        const { values } = parseArgs({ args, strict: true, options: { level: { type: "string" }, id: { type: "string" }, enabled: { type: "string" }, apply: { type: "boolean" } } });
        if (values.level === undefined || values.id === undefined) throw bad("缺少 --level 或 --id");
        if (values.enabled !== "true" && values.enabled !== "false") throw bad("--enabled 必须是 true 或 false");
        print(await need(deps.monitoringSwitch, "监控开关").set({ level: values.level, id: values.id, enabled: values.enabled === "true", apply: values.apply === true }, deps.actor));
        return 0;
      }
      case "external": {
        const [sub, ...args] = rest;
        const ops = need(deps.ops, "处置命令");
        if (sub === "list") {
          parseArgs({ args, strict: true, options: {} });
          print(await ops.externalList(deps.actor));
          return 0;
        }
        if (sub === "add") {
          const { values } = parseArgs({ args, strict: true, options: { platform: { type: "string" }, locator: { type: "string" }, key: { type: "string" } } });
          if (values.platform === undefined || values.locator === undefined || values.key === undefined) throw bad("缺少 --platform / --locator / --key");
          print(await ops.externalAdd({ platform: values.platform, locator: values.locator, key: values.key }, deps.actor));
          return 0;
        }
        if (sub === "enable" || sub === "disable") {
          const { values } = parseArgs({ args, strict: true, options: { account: { type: "string" } } });
          if (values.account === undefined) throw bad("缺少 --account");
          print(await (sub === "enable" ? ops.externalEnable : ops.externalDisable)({ accountId: values.account }, deps.actor));
          return 0;
        }
        throw bad("未知子命令");
      }
      case "maintain": {
        parseArgs({ args: rest, strict: true, options: {} });
        if (!deps.maintain) throw bad("维护未启用（需要 OSS_* 环境变量）");
        const r = await deps.maintain();
        print(r);
        return r.ok ? 0 : 1;
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
