// `pnpm sync ...` 的进程入口：组装真实依赖后交给 runSyncCli。
// 环境变量（缺失即启动失败，不设默认值：生产不写死同步或异步，R13.4）：
//   HBECHO_DATABASE_URL     必填
//   HBECHO_ENV              test | staging | production；缺省 production（fail closed）
//   HBECHO_SYNC_PROFILE_MODE / HBECHO_SYNC_LIST_MODE   必填，synchronous | asynchronous
//   HBECHO_ACTOR_ID         缺省 service:sync-cli
import pino from "pino";
import { z } from "zod";
import { createDb, createPool } from "../db/client";
import { createMonitoringResolver } from "../modules/monitoring";
import { createLogSyncAuditSink, createSyncCommands, createSyncScheduler } from "../modules/sync-schedule";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../modules/tracer-command";
import { runSyncCli } from "./sync-cli";

const mode = z.enum(["synchronous", "asynchronous"]);
const env = z
  .object({
    HBECHO_DATABASE_URL: z.string().min(1),
    HBECHO_ENV: z.enum(["test", "staging", "production"]).default("production"),
    HBECHO_SYNC_PROFILE_MODE: mode,
    HBECHO_SYNC_LIST_MODE: mode,
    HBECHO_ACTOR_ID: z.string().min(1).default("service:sync-cli"),
  })
  .safeParse(process.env);
if (!env.success) {
  process.stderr.write(`启动失败，环境变量不合法：${env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}\n`);
  process.exit(1);
}
const cfg = env.data;
const logger = pino({ name: "sync-cli", redact: ["*.apiKey", "*.authorization"] }, pino.destination(2));
const pool = createPool(cfg.HBECHO_DATABASE_URL);
const db = createDb(pool);
const clock = { now: () => new Date() };
const resolver = createMonitoringResolver(db);
const runtime = { environment: cfg.HBECHO_ENV, modes: { media_user_info: cfg.HBECHO_SYNC_PROFILE_MODE, user_video_list: cfg.HBECHO_SYNC_LIST_MODE } };
const scheduler = createSyncScheduler({ db, clock, resolver, runtime });
const commands = createSyncCommands({ db, clock, resolver, planner: scheduler.planner, runtime, audit: createLogSyncAuditSink(logger) });
const actor: ActorContext = { actorId: cfg.HBECHO_ACTOR_ID, capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all", mediaStaffIds: "all" } };
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
