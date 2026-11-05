// `pnpm master-data ...` 的进程入口：组装真实依赖后交给 runCli。
// 环境变量：
//   HBECHO_DATABASE_URL        必填
//   HBECHO_MD_ACTOR            必填，审计归属主体，例如 service:master-data-import
//   HBECHO_MD_CAPABILITIES     必填，逗号分隔：data.master_data.import[,data.master_data.structure]
//   HBECHO_MD_BRAND_SCOPE      必填，all 或品牌编码逗号分隔（hitachi,hisense,york_vrf）；不缺省为全部品牌
// B 域未实现前，权限边界就是持有数据库凭证的服务身份；不提供 HTTP 接口。
import { readFileSync, writeFileSync } from "node:fs";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { actorFromEnv, createLogAudit, createMasterData, MasterDataError } from "../modules/master-data-import";
import { runCli } from "./master-data-cli";

const logger = pino({ name: "master-data-cli" }, pino.destination(2));
const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  process.stderr.write("缺少 HBECHO_DATABASE_URL\n");
  process.exit(1);
}
let actor;
try {
  actor = actorFromEnv(process.env);
} catch (e) {
  process.stderr.write(`${e instanceof MasterDataError ? e.message : String(e)}\n`);
  process.exit(1);
}
const pool = createPool(url);
const code = await runCli(process.argv.slice(2), {
  md: createMasterData(createDb(pool), { now: () => new Date() }, createLogAudit(logger)),
  actor,
  readFile: (p) => readFileSync(p),
  writeFile: (p, c) => writeFileSync(p, c, "utf8"),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => logger.error({ err: e }, "master-data-cli internal error"),
});
await pool.end();
process.exit(code);
