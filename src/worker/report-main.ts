// `pnpm report ...` 的进程入口：组装真实依赖后交给 runReportCli。变量名见 .env.example；缺项即启动失败并点名。
//   必填：HBECHO_DATABASE_URL；身份 HBECHO_JP_ACTOR=user:<id>；D 的 HBECHO_JP_* 数值配置与 C 的 HBECHO_SIGNALS_*（读 D 的结果要装配 D 的 Module，与 `pnpm judgement` 同一份）
//   图片不在 CLI 里用（导出无图），所以不需要 OSS 配置。
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { assembleReport } from "../modules/report-detail";
import { runReportCli } from "./report-cli";
import { buildJudgementRuntime } from "./judgement-wiring";
const env = process.env;
const logger = pino({ name: "report" }, pino.destination(2));
const fatal = (e: unknown): never => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  return process.exit(1);
};
const url = env.HBECHO_DATABASE_URL;
if (!url) fatal("缺少 HBECHO_DATABASE_URL");
const pool = createPool(url!);
let report;
let ctx;
try {
  const db = createDb(pool);
  const rt = buildJudgementRuntime({ db, env, logger, strict: false });
  ctx = await rt.contextOfActor();
  report = assembleReport({ db, env, outcomes: rt.judgement.outcomes, logger, media: null });
} catch (e) {
  await pool.end();
  fatal(e);
}
const code = await runReportCli(process.argv.slice(2), { report: report!, ctx: ctx!, stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t) });
await pool.end();
process.exit(code);
