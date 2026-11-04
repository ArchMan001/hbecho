// `pnpm tracer ...` 的进程入口：组装真实依赖后交给 runCli。
// 环境变量：
//   HBECHO_DATABASE_URL  必填，mysql://user:pass@host:port/db
//   HBECHO_ENV           test | staging | production；缺省 production（fail closed：production 没有任何已批准的 capability，命令会被拒绝）
//   HBECHO_ACTOR_ID      审计与幂等 key 的归属主体；缺省 service:tracer-cli
// B 域未实现前，CLI 的权限边界就是持有数据库凭证的服务身份；不提供 HTTP 接口。
import pino from "pino";
import { createDb, createPool } from "../db/client";
import {
  CAP_SYNC_TRIGGER,
  createLogAuditSink,
  createTracerCommands,
  createTracerStatusQuery,
  type ActorContext,
} from "../modules/tracer-command";
import { runCli } from "./cli";

const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  process.stderr.write("缺少 HBECHO_DATABASE_URL\n");
  process.exit(1);
}
const env = process.env.HBECHO_ENV ?? "production";
if (env !== "test" && env !== "staging" && env !== "production") {
  process.stderr.write(`HBECHO_ENV 必须是 test | staging | production，收到 ${env}\n`);
  process.exit(1);
}

const logger = pino({ name: "tracer-cli", redact: ["*.apiKey", "*.authorization"] }, pino.destination(2));
const pool = createPool(url);
const db = createDb(pool);
const clock = { now: () => new Date() };
const actor: ActorContext = {
  actorId: process.env.HBECHO_ACTOR_ID ?? "service:tracer-cli",
  capabilities: new Set([CAP_SYNC_TRIGGER]),
  scope: { platformCodes: "all", mediaStaffIds: "all" },
};

const code = await runCli(process.argv.slice(2), {
  commands: createTracerCommands({
    db,
    clock,
    audit: createLogAuditSink(logger),
    config: { environment: env, modes: { media_user_info: "synchronous", user_video_list: "synchronous" } },
  }),
  status: createTracerStatusQuery({ db, clock }),
  actor,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => logger.error({ err: e }, "tracer-cli internal error"),
});
await pool.end();
process.exit(code);
