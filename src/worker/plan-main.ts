// `pnpm plan ...` 的进程入口：组装真实依赖后交给 runPlanCli。
// 环境变量（缺任一项启动失败，不退化成全部）：
//   HBECHO_DATABASE_URL        必填
//   HBECHO_AP_ACTOR            必填，审计归属主体，例如 service:plan-cli
//   HBECHO_AP_CAPABILITIES     必填，逗号分隔：activity_plan.create,activity_plan.join,data.account.manage
//   HBECHO_AP_BRAND_SCOPE      必填，all 或品牌编码逗号分隔
//   HBECHO_AP_BRANCH_SCOPE     必填，all 或分公司编码逗号分隔
//   HBECHO_AP_PLATFORM_ADMIN   可选，true / false，缺省 false
//   HBECHO_ENV                 缺省 production（fail closed）；HBECHO_SYNC_PROFILE_MODE / HBECHO_SYNC_LIST_MODE 决定确认时的 capability 门控
// `plan resolve --once` 额外需要完整的 worker 配置（sync-config.ts 的全部变量，含花钱上限），且只在有已批准 capability 时运行。
//   清除活动计划（plan maintain）要调 C 的 segments.purge：用到才读 C 的数值配置与 OSS_BUCKET_SIGNALS / OSS 凭证，缺项时清除失败、计划留在回收站（见 judgement-wiring.ts）
// B 域落地后，Web 入口用 toPlanActor 构造 PlanActor，这里的环境变量身份只给运维 CLI。
import { readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { branches } from "../db/schema";
import { createAuditWriter, fromPlanAudit, fromSyncAudit } from "../modules/access-control";
import { actorFromEnv, createActivityPlan, createLogAudit, PlanError } from "../modules/activity-plan";
import { createMonitoringResolver } from "../modules/monitoring";
import { runTracerRoot } from "../modules/orchestrator";
import type { RawCaptureGateway } from "../modules/raw-capture";
import { createLogSyncAuditSink, createSyncCommands, createSyncScheduler } from "../modules/sync-schedule";
import { CAP_SYNC_TRIGGER, createLogAuditSink, createTracerCommands, type ActorContext } from "../modules/tracer-command";
import { buildJudgementDownstream } from "./judgement-wiring";
import { runPlanCli } from "./plan-cli";
import { parseSyncWorkerConfig } from "./sync-config";
import { assertWorkerCanRun, buildAccountRunners } from "./sync-runner-wiring";

const logger = pino({ name: "plan-cli" }, pino.destination(2));
const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  process.stderr.write("缺少 HBECHO_DATABASE_URL\n");
  process.exit(1);
}
const pool = createPool(url);
const db = createDb(pool);
const clock = { now: () => new Date() };
const branchIdOf = async (code: string): Promise<bigint> => {
  const [b] = await db.select({ id: branches.branchId }).from(branches).where(eq(branches.branchCode, code));
  if (!b) throw new PlanError("not_found", "branch_not_found", `分公司编码 ${code} 不存在`);
  return b.id;
};
let actor;
try {
  actor = await actorFromEnv(process.env, async (codes) => new Set(await Promise.all(codes.map(branchIdOf))));
} catch (e) {
  process.stderr.write(`${e instanceof PlanError ? e.message : String(e)}\n`);
  await pool.end();
  process.exit(1);
}
const env = (process.env.HBECHO_ENV ?? "production") as "test" | "production";
const modes = {
  media_user_info: (process.env.HBECHO_SYNC_PROFILE_MODE ?? "synchronous") as "synchronous" | "asynchronous",
  user_video_list: (process.env.HBECHO_SYNC_LIST_MODE ?? "synchronous") as "synchronous" | "asynchronous",
};
const tracerConfig = { environment: env, modes };
const writer = createAuditWriter({ db, clock, logger });
const audit = fromPlanAudit(writer, createLogAudit(logger));
const tracer = createTracerCommands({ db, clock, audit: { record: (e) => createLogAuditSink(logger).record(e) }, config: tracerConfig });
const monitoring = createMonitoringResolver(db);

// resolve --once：需要真实 worker 配置、网关与已批准 capability；其它命令不读任何 secret
let runRoot, supplement;
if (process.argv[2] === "resolve") {
  try {
    const cfg = parseSyncWorkerConfig(process.env);
    assertWorkerCanRun(cfg);
    let gateway: RawCaptureGateway | undefined;
    buildAccountRunners({ db, clock, cfg, env: process.env, onGateway: (g) => void (gateway = g) });
    if (!gateway) throw new Error("网关未装配");
    const g = gateway;
    const wcfg = { environment: cfg.environment, modes: cfg.modes };
    runRoot = (rootId: bigint) => runTracerRoot({ db, clock, gateway: g, workerId: `plan-cli:${process.pid}`, config: wcfg, leaseMs: cfg.leaseMs }, rootId);
    const resolver = createMonitoringResolver(db);
    const runtime = { environment: cfg.environment, modes: cfg.modes };
    const scheduler = createSyncScheduler({ db, clock, resolver, runtime });
    const commands = createSyncCommands({ db, clock, resolver, planner: scheduler.planner, runtime, audit: fromSyncAudit(writer, createLogSyncAuditSink(logger)) });
    const planWorker: ActorContext = { actorId: "service:plan-worker", capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all", mediaStaffIds: "all" } };
    supplement = (input: Parameters<typeof commands.createSupplement>[0]) => commands.createSupplement(input, planWorker);
  } catch (e) {
    process.stderr.write(`plan resolve 不能运行：${e instanceof Error ? e.message : String(e)}\n`);
    await pool.end();
    process.exit(1);
  }
}
// 下游：D 的判定计划（E 落地后在这里改成组合下游，任一失败整体失败）；清除用到的 C 配置用到才读
const downstream = buildJudgementDownstream({ db, env: process.env, logger });
const ap = createActivityPlan({ db, clock, audit, monitoring, tracer, tracerConfig, downstream, ...(runRoot ? { runRoot } : {}), ...(supplement ? { supplement } : {}) });
const code = await runPlanCli(process.argv.slice(2), {
  ap,
  actor,
  readFile: (p) => readFileSync(p),
  writeFile: (p, c) => writeFileSync(p, c, "utf8"),
  branchIdOf,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => logger.error({ err: e }, "plan-cli internal error"),
});
await pool.end();
process.exit(code);
