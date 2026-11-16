// `pnpm judgement ...` 的进程入口：组装真实依赖后交给 runJudgementCli。变量名见 .env.example；缺项即启动失败并点名，不设代码默认值。
//   必填：HBECHO_DATABASE_URL；身份 HBECHO_JP_ACTOR=user:<id>（用该用户当前的 AuthContext，没有别的身份入口）；
//         14 项 HBECHO_JP_* 数值配置（env.ts）；C 的 HBECHO_SIGNALS_* 数值配置（D 装配 C 的 Module）
//   用到才读：OSS_BUCKET_SIGNALS / OSS_BUCKET_MEDIA / OSS 凭证 / HBECHO_CAPABILITY_URL（image put、圈定与评分里要读图的路径）
//   serve 另需：HBECHO_SYNC_DETAIL_MODE / HBECHO_SYNC_COMMENTS_MODE（A 需求的同步 / 异步模式；缺则启动失败）
// D 自己不发任何供应商调用；付费调用只在 A 的采集 worker 与 C 的任务里，那里有各自的 capability 门控。
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { exitCodeOf, JudgementError } from "../modules/judgement/errors";
import { runJudgementCli } from "./judgement-cli";
import { runJudgementLoop } from "./judgement-loop";
import { buildJudgementRuntime } from "./judgement-wiring";
const env = process.env;
const logger = pino({ name: "judgement", redact: ["*.apiKey", "*.authorization"] }, pino.destination(2));
const fatal = (e: unknown): never => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  return process.exit(e instanceof JudgementError ? Math.max(exitCodeOf(e), 1) : 1);
};
const url = env.HBECHO_DATABASE_URL;
if (!url) fatal("缺少 HBECHO_DATABASE_URL");
const pool = createPool(url!);
let rt;
let ctx;
try {
  rt = buildJudgementRuntime({ db: createDb(pool), env, logger, strict: process.argv[2] === "serve" });
  ctx = await rt.contextOfActor();
} catch (e) {
  await pool.end();
  fatal(e);
}
const code = await runJudgementCli(process.argv.slice(2), {
  j: rt!.judgement,
  ctx: ctx!,
  readFile: (p) => readFileSync(p),
  serve: async () => {
    // 只有 serve 接管停止信号：其它命令照常被 SIGTERM 终止
    const stop = new AbortController();
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());
    logger.info({ actor: ctx!.actor }, "judgement serve started");
    await runJudgementLoop(
      {
        judgement: rt!.judgement,
        workerId: `judgement:${hostname()}:${process.pid}`,
        nowMs: () => Date.now(),
        log: (e, m) => logger.info(e, m),
        sleep: (ms, sig) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            sig.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
          }),
      },
      stop.signal,
    );
    logger.info("judgement serve stopped");
  },
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  onInternalError: (e) => logger.error({ err: e }, "judgement cli internal error"),
});
await pool.end();
process.exit(code);
