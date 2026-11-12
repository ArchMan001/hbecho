// `pnpm signals ...` 的进程入口：组装真实依赖后交给 runSignalsCli。
// 环境变量（缺任一项启动失败，不退化成全部）：
//   HBECHO_DATABASE_URL        必填
//   HBECHO_SIG_ACTOR           必填，审计归属主体，例如 service:signals-cli
//   HBECHO_SIG_CAPABILITIES    必填，逗号分隔：data.content.read,data.account.read,rule.definition.manage,...
//   HBECHO_SIG_BRAND_SCOPE     必填，all 或品牌编码逗号分隔
//   HBECHO_SIGNALS_ENABLED     可选，启用的能力标识（缺省只启用文本类）
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { actorFromEnv, createReader, parseEnabledCapabilities, SignalError } from "../modules/signals";
import { runSignalsCli } from "./signals-cli";

const logger = pino({ name: "signals-cli" }, pino.destination(2));
const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  process.stderr.write("缺少 HBECHO_DATABASE_URL\n");
  process.exit(1);
}
let actor, enabled;
try {
  actor = actorFromEnv(process.env);
  enabled = parseEnabledCapabilities(process.env.HBECHO_SIGNALS_ENABLED);
} catch (e) {
  process.stderr.write(`${e instanceof SignalError ? e.message : String(e)}\n`);
  process.exit(1);
}
const pool = createPool(url);
const reader = createReader({ db: createDb(pool), enabled });
const code = await runSignalsCli(process.argv.slice(2), {
  reader,
  actor,
  enabled,
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  onInternalError: (e) => logger.error({ err: e }, "signals cli internal error"),
});
await pool.end();
process.exit(code);
