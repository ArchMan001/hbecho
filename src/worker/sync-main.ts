// `pnpm sync ...` 的进程入口：组装真实依赖后交给 runSyncCli。
// 子命令：tick / supplement / batch cancel / batches（运营）；worker（常驻）/ run-once（跑到队列空，测试与演练）。
// 环境变量缺失即启动失败，不设默认值：生产不写死同步或异步（R13.4），花钱的上限也没有默认值（C18）。
// worker 需要的全部变量见 sync-config.ts；运营命令只需要：
//   HBECHO_DATABASE_URL、HBECHO_ENV（缺省 production，fail closed）、HBECHO_SYNC_PROFILE_MODE、HBECHO_SYNC_LIST_MODE
import pino from "pino";
import { z } from "zod";
import { createDb, createPool } from "../db/client";
import { createDemandModule } from "../modules/demand";
import { cleanStaleTmp } from "../modules/media-archive";
import { createMonitoringResolver } from "../modules/monitoring";
import { createLogSyncAuditSink, createSyncCommands, createSyncScheduler } from "../modules/sync-schedule";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../modules/tracer-command";
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
  })
  .safeParse(process.env);

const actorFor = (id: string): ActorContext => ({ actorId: id, capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all", mediaStaffIds: "all" } });

if (isWorkerCommand) {
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
    app = buildSyncApp(cfg, { makeRunners: ({ db, clock }) => buildAccountRunners({ db, clock, cfg, env: process.env }) });
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
  await runForever(app, cfg, process);
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
const commands = createSyncCommands({ db, clock, resolver, planner: scheduler.planner, runtime, audit: createLogSyncAuditSink(logger) });
const actor = actorFor(cfg.HBECHO_ACTOR_ID);
const demand =
  cfg.HBECHO_SYNC_DETAIL_MODE && cfg.HBECHO_SYNC_COMMENTS_MODE
    ? createDemandModule({ db, clock, runtime: { environment: cfg.HBECHO_ENV, modes: { media_stats_number: cfg.HBECHO_SYNC_DETAIL_MODE, post_comments_list: cfg.HBECHO_SYNC_COMMENTS_MODE } }, audit: createLogSyncAuditSink(logger) })
    : undefined;
const code = await runSyncCli(process.argv.slice(2), {
  scheduler,
  commands,
  ...(demand ? { demand } : {}),
  actor,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => logger.error({ err: e }, "sync-cli internal error"),
});
await pool.end();
process.exit(code);
