// `pnpm sync ...` 的进程入口：组装真实依赖后交给 runSyncCli。
// 子命令：tick / supplement / batch cancel / batches（运营）；worker（常驻）/ run-once（跑到队列空，测试与演练）。
// 环境变量缺失即启动失败，不设默认值：生产不写死同步或异步（R13.4），花钱的上限也没有默认值（C18）。
// worker 需要的全部变量见 sync-config.ts；运营命令只需要：
//   HBECHO_DATABASE_URL、HBECHO_ENV（缺省 production，fail closed）、HBECHO_SYNC_PROFILE_MODE、HBECHO_SYNC_LIST_MODE
import pino from "pino";
import { z } from "zod";
import { createDb, createPool } from "../db/client";
import { createMonitoringResolver } from "../modules/monitoring";
import { RUNNERS } from "../modules/sync-runner";
import { createLogSyncAuditSink, createSyncCommands, createSyncScheduler } from "../modules/sync-schedule";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../modules/tracer-command";
import { runSyncCli } from "./sync-cli";
import { parseSyncWorkerConfig } from "./sync-config";
import { buildSyncApp, runForever } from "./sync-wiring";

const sub = process.argv[2];
const isWorkerCommand = sub === "worker" || sub === "run-once";

// worker / run-once 需要完整的运行配置（缺失即启动失败，一次列出所有缺项）；
// 其余命令（tick / supplement / batch cancel / batches）只需要数据库与模式。
const cliEnv = z
  .object({
    HBECHO_DATABASE_URL: z.string().min(1),
    HBECHO_ENV: z.enum(["test", "staging", "production"]).default("production"),
    HBECHO_SYNC_PROFILE_MODE: z.enum(["synchronous", "asynchronous"]),
    HBECHO_SYNC_LIST_MODE: z.enum(["synchronous", "asynchronous"]),
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
  const app = buildSyncApp(cfg);
  if (Object.keys(RUNNERS).length === 0) app.logger.warn("没有注册任何 Runner：worker 不会领取任何任务（任务 5 起逐个注册）");
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
const code = await runSyncCli(process.argv.slice(2), {
  scheduler,
  commands,
  actor,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => logger.error({ err: e }, "sync-cli internal error"),
});
await pool.end();
process.exit(code);
