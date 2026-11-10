// `pnpm access ...` 的进程入口：组装真实依赖后交给 runAccessCli。
// 环境变量：
//   HBECHO_DATABASE_URL   必填
//   HBECHO_ACCESS_ACTOR   需要身份的命令必填：user:<id>（必须是有效用户；角色与范围一律从数据库现算，不接受自行声明）
// token create / bootstrap-superadmin / maintain 只需要数据库凭证。
import { readFileSync, writeFileSync } from "node:fs";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { runAccessCli } from "./access-cli";
import { buildAccessCliDeps } from "./access-wiring";

const logger = pino({ name: "access-cli" }, pino.destination(2));
const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  process.stderr.write("缺少 HBECHO_DATABASE_URL\n");
  process.exit(1);
}
const pool = createPool(url);
const code = await runAccessCli(
  process.argv.slice(2),
  buildAccessCliDeps({
    db: createDb(pool),
    clock: { now: () => new Date() },
    logger,
    actorId: process.env.HBECHO_ACCESS_ACTOR?.trim() || undefined,
    io: {
      readFile: (p) => readFileSync(p),
      writeFile: (p, c) => writeFileSync(p, c, "utf8"),
      stdout: (s) => void process.stdout.write(s),
      stderr: (s) => void process.stderr.write(s),
      onInternalError: (e) => logger.error({ err: e }, "access-cli internal error"),
    },
  }),
);
await pool.end();
process.exit(code);
