// `pnpm sync ...` 的进程入口：组装真实依赖后交给 runSyncCli。
// 子命令：tick / supplement / batch cancel / batches（运营）；worker（常驻）/ run-once（跑到队列空，测试与演练）。
// 环境变量缺失即启动失败，不设默认值：生产不写死同步或异步（R13.4），花钱的上限也没有默认值（C18）。
// worker 需要的全部变量见 sync-config.ts；运营命令只需要：
//   HBECHO_DATABASE_URL、HBECHO_ENV（缺省 production，fail closed）、HBECHO_SYNC_PROFILE_MODE、HBECHO_SYNC_LIST_MODE
import pino from "pino";
import { z } from "zod";
import { createDb, createPool } from "../db/client";
import { createAccessMaintenance, createAuditWriter, fromSyncAudit, fromTracerAudit } from "../modules/access-control";
import { createPlanMaintenance, noDownstream } from "../modules/activity-plan";
import { createRosterFinalizer, createRosterResolver } from "../modules/activity-plan/roster";
import { createDemandModule } from "../modules/demand";
import { createMaintenance, type Maintenance } from "../modules/maintenance";
import { cleanStaleTmp } from "../modules/media-archive";
import { createMonitoringResolver } from "../modules/monitoring";
import { createMonitoringSwitch } from "../modules/monitoring/set-switch";
import { runTracerRoot } from "../modules/orchestrator";
import { OssObjectStore, type RawCaptureGateway } from "../modules/raw-capture";
import { readOssSecrets } from "../modules/smoke";
import { createSyncOps } from "../modules/sync-ops";
import { createLogSyncAuditSink, createSyncCommands, createSyncScheduler } from "../modules/sync-schedule";
import { createSyncStatus } from "../modules/sync-status";
import { CAP_ACCOUNT_MANAGE, CAP_EXTERNAL_MANAGE, CAP_MONITORING_MANAGE, CAP_SYNC_TRIGGER, createLogAuditSink, createTracerCommands, type ActorContext } from "../modules/tracer-command";
import { runSyncCli } from "./sync-cli";
import { parseSyncWorkerConfig } from "./sync-config";
import { assertWorkerCanRun, buildAccountRunners } from "./sync-runner-wiring";
import { buildSyncApp, runForever } from "./sync-wiring";

const sub = process.argv[2];
const isWorkerCommand = sub === "worker" || sub === "run-once";

// worker / run-once 需要完整的运行配置（缺失即启动失败，一次列出所有缺项）；
// 其余命令（tick / supplement / batch cancel / batches）只需要数据库与模式。
const cliEnv = z
  .object({
    HBECHO_DATABASE_URL: z.string().min(1),
    // staging 没有任何 capability 行：tick 能建批次但没有 worker 能消费，所以运营命令也一样拒绝（与 sync-config.ts 一致）
    HBECHO_ENV: z.enum(["test", "production"]).default("production"),
    HBECHO_SYNC_PROFILE_MODE: z.enum(["synchronous", "asynchronous"]),
    HBECHO_SYNC_LIST_MODE: z.enum(["synchronous", "asynchronous"]),
    // 按需采集（demand submit / get）需要；缺失时这两个子命令明确报「未启用」，其余命令不受影响
    HBECHO_SYNC_DETAIL_MODE: z.enum(["synchronous", "asynchronous"]).optional(),
    HBECHO_SYNC_COMMENTS_MODE: z.enum(["synchronous", "asynchronous"]).optional(),
    HBECHO_ACTOR_ID: z.string().min(1).default("service:sync-cli"),
    // 超管标记：经销商级监控开关与外部监控账号只给它。B 域接入前由持有数据库凭证的运维显式声明
    HBECHO_ACTOR_PLATFORM_ADMIN: z.enum(["true", "false"]).default("false"),
  })
  .safeParse(process.env);

const actorFor = (id: string, admin: boolean): ActorContext => ({
  actorId: id,
  capabilities: new Set([CAP_SYNC_TRIGGER, CAP_ACCOUNT_MANAGE, CAP_MONITORING_MANAGE, ...(admin ? [CAP_EXTERNAL_MANAGE] : [])]),
  scope: { platformCodes: "all", mediaStaffIds: "all" },
  ...(admin ? { platformAdmin: true } : {}),
});

if (isWorkerCommand) {
  let sharedGateway: RawCaptureGateway | undefined;
  let cfg;
  try {
    cfg = parseSyncWorkerConfig(process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  let app;
  try {
    assertWorkerCanRun(cfg); // 先于连接池与 secret：没有已批准的 capability 就不启动
    app = buildSyncApp(cfg, { makeRunners: ({ db, clock }) => buildAccountRunners({ db, clock, cfg, env: process.env, onGateway: (g) => void (sharedGateway = g) }) });
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  // 启动清理：上次崩溃留下的超过 24 小时的视频临时文件（FS-17.4）
  const cleaned = await cleanStaleTmp(cfg.media.tmpDir, 24 * 3600_000, Date.now());
  if (cleaned > 0) app.logger.warn({ cleaned }, "removed stale media tmp files");
  if (sub === "run-once") {
    await app.scheduler.tick();
    const stats = await app.worker.run({ untilIdle: true });
    process.stdout.write(`${JSON.stringify(stats)}\n`);
    await app.close();
    process.exit(0);
  }
  // 每日维护需要 ODS 桶；配置不全时 worker 仍可运行，只是不清理（日志里可见）
  let maintain: (() => Promise<unknown>) | undefined;
  try {
    const maintenance = createMaintenance({ db: app.db, store: new OssObjectStore(readOssSecrets(process.env)), clock: app.clock, log: (e, m) => app.logger.info(e, m) });
    maintain = () => maintenance.runDaily();
  } catch (e) {
    app.logger.warn({ err: e instanceof Error ? e.message : String(e) }, "daily maintenance disabled");
  }
  // 访问控制维护不依赖 OSS：无论上面是否启用，都接入
  const accessMaintenance = createAccessMaintenance({ db: app.db, clock: app.clock, logger: app.logger });
  // 计划每日维护（15 天无引用停采、回收站清除）同样不依赖 OSS，在上面的 try/catch 之外装配，OSS 配置不全时它仍然运行（AP-D15）。
  // 下游端口（D / E）未建，用默认空实现；D / E 落地后在这里替换。
  const planMaintenance = createPlanMaintenance({ db: app.db, clock: app.clock, downstream: noDownstream, audit: (e) => app.logger.info(e, "activity_plan.audit") });
  // 名单解析驱动：与周期 Runner 共用同一个网关；服务身份 service:plan-worker 只持有 data.sync.trigger，范围限于名单内账号（补抓）
  let resolveRosters: (() => Promise<unknown>) | undefined;
  if (sharedGateway) {
    const gateway = sharedGateway;
    const tracerConfig = { environment: cfg.environment, modes: cfg.modes };
    const planWorker: ActorContext = { actorId: "service:plan-worker", capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all", mediaStaffIds: "all" } };
    const finalize = createRosterFinalizer({ db: app.db, clock: app.clock, supplement: (input) => app.commands.createSupplement(input, planWorker) });
    const rosterResolver = createRosterResolver({
      db: app.db,
      clock: app.clock,
      audit: (e) => app.logger.info(e, "activity_plan.audit"),
      runRoot: (id) => runTracerRoot({ db: app.db, clock: app.clock, gateway, workerId: `${cfg.actorId}:roster:${process.pid}`, config: tracerConfig, leaseMs: cfg.leaseMs }, id),
      finalize,
      monitoring: app.resolver,
      tracerConfig,
    });
    resolveRosters = async () => {
      const r = await rosterResolver.runOnce();
      if (r.examined > 0 || r.failed.length > 0) app.logger.info(r, "roster resolver tick");
    };
  }
  await runForever(app, cfg, process, { ...(maintain ? { maintain } : {}), accessMaintain: () => accessMaintenance.runDaily(), planMaintain: () => planMaintenance.runDaily(), ...(resolveRosters ? { resolveRosters } : {}) });
  await app.close();
  process.exit(0);
}

if (!cliEnv.success) {
  process.stderr.write(`启动失败，环境变量不合法：${cliEnv.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}\n`);
  process.exit(1);
}
const cfg = cliEnv.data;
const logger = pino({ name: "sync-cli", redact: ["*.apiKey", "*.authorization"] }, pino.destination(2));
const pool = createPool(cfg.HBECHO_DATABASE_URL);
const db = createDb(pool);
const clock = { now: () => new Date() };
const resolver = createMonitoringResolver(db);
const runtime = { environment: cfg.HBECHO_ENV, modes: { media_user_info: cfg.HBECHO_SYNC_PROFILE_MODE, user_video_list: cfg.HBECHO_SYNC_LIST_MODE } };
const scheduler = createSyncScheduler({ db, clock, resolver, runtime });
// 审计：日志 + 持久（audit_events）；业务模块仍只认各自的 AuditSink 端口
const auditWriter = createAuditWriter({ db, clock, logger });
const syncAudit = fromSyncAudit(auditWriter, createLogSyncAuditSink(logger));
const commands = createSyncCommands({ db, clock, resolver, planner: scheduler.planner, runtime, audit: syncAudit });
const actor = actorFor(cfg.HBECHO_ACTOR_ID, cfg.HBECHO_ACTOR_PLATFORM_ADMIN === "true");
const audit = syncAudit;
const tracer = createTracerCommands({ db, clock, audit: fromTracerAudit(auditWriter, createLogAuditSink(logger)), config: { environment: cfg.HBECHO_ENV, modes: { media_user_info: cfg.HBECHO_SYNC_PROFILE_MODE, user_video_list: cfg.HBECHO_SYNC_LIST_MODE } } });
let maintain: Maintenance["runNow"] | undefined;
try {
  const maintenance = createMaintenance({ db, store: new OssObjectStore(readOssSecrets(process.env)), clock, log: (e, m) => logger.info(e, m) });
  maintain = maintenance.runNow;
} catch {
  maintain = undefined; // 没有 OSS_* 配置：maintain 子命令报「未启用」
}
const demand =
  cfg.HBECHO_SYNC_DETAIL_MODE && cfg.HBECHO_SYNC_COMMENTS_MODE
    ? createDemandModule({ db, clock, runtime: { environment: cfg.HBECHO_ENV, modes: { media_stats_number: cfg.HBECHO_SYNC_DETAIL_MODE, post_comments_list: cfg.HBECHO_SYNC_COMMENTS_MODE } }, audit: syncAudit })
    : undefined;
const code = await runSyncCli(process.argv.slice(2), {
  scheduler,
  commands,
  ...(demand ? { demand } : {}),
  ops: createSyncOps({ db, clock, audit, tracer }),
  monitoringSwitch: createMonitoringSwitch({ db, clock, audit }),
  status: createSyncStatus({ db, clock, resolver }),
  ...(maintain ? { maintain } : {}),
  actor,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => logger.error({ err: e }, "sync-cli internal error"),
});
await pool.end();
process.exit(code);
