// `pnpm square ...` 的进程入口：组装真实依赖后交给 runSquareCli。
// 环境变量：HBECHO_DATABASE_URL 必填；HBECHO_ACCESS_ACTOR 必填（user:<id>，持有 config.manage 的有效用户）。
// 不连 OSS：这里只改策略，不签封面。
import { eq } from "drizzle-orm";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { brands } from "../db/schema";
import { AccessError, createAccessServices, createAuditWriter, userIdOf } from "../modules/access-control";
import { assembleSquare } from "../modules/video-square";
import { runSquareCli } from "./square-cli";

const logger = pino({ name: "square-cli" }, pino.destination(2));
const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  process.stderr.write("缺少 HBECHO_DATABASE_URL\n");
  process.exit(1);
}
const pool = createPool(url);
const db = createDb(pool);
const clock = { now: () => new Date() };
const { resolver } = createAccessServices({ db, clock, audit: createAuditWriter({ db, clock, logger }), logger });
const code = await runSquareCli(process.argv.slice(2), {
  square: assembleSquare({ db, clock, env: process.env, logger, covers: null }),
  actorId: process.env.HBECHO_ACCESS_ACTOR?.trim() || undefined,
  async context(actorId) {
    const id = userIdOf(actorId);
    if (id === null) throw new AccessError("configuration", "actor_invalid", "HBECHO_ACCESS_ACTOR 必须是 user:<数字 ID>");
    const r = await resolver.contextForUser(id, null);
    if (!r.ok) throw new AccessError("authorization", "actor_not_active", `HBECHO_ACCESS_ACTOR 对应的用户不是有效用户（${r.reason}）`);
    return r.ctx;
  },
  async brandIdOf(c) {
    const [b] = await db.select({ id: brands.brandId }).from(brands).where(eq(brands.brandCode, c));
    return b?.id;
  },
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => logger.error({ err: e }, "square-cli internal error"),
});
await pool.end();
process.exit(code);
