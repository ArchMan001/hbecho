// `pnpm signals ...` 的进程入口：组装真实依赖后交给 runSignalsCli。变量名见 .env.example；缺项即启动失败并点名，不设代码默认值。
//   必填：HBECHO_DATABASE_URL；身份 HBECHO_SIG_ACTOR / HBECHO_SIG_CAPABILITIES / HBECHO_SIG_BRAND_SCOPE；
//         13 项数值配置（HBECHO_SIGNALS_* 与 HBECHO_MEDIA_MAX_BYTES，见 config.ts）；HBECHO_SIGNALS_ENABLED 可选（缺省只启用文本类）
//   用到 OSS 与能力服务的命令（segment put-image 等、score 之后的任务执行、run）另需：
//         OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_REGION / [OSS_ENDPOINT]、OSS_BUCKET_MEDIA（只读）、OSS_BUCKET_SIGNALS（读写删）、HBECHO_CAPABILITY_URL
//         `signals run` 缺任一项直接退出；其余命令缺这些时只在真正用到时报“未配置”。
// 网关缺省 DisabledAiGateway：不发任何 ASR / 大模型调用（真实网关属 h-ai-min）。
import { readFileSync } from "node:fs";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { HttpCapabilityClient } from "../modules/media-archive";
import { OssObjectStore } from "../modules/raw-capture";
import { actorFromEnv, createLogAudit, createSignals, HttpImageMatcher, parseSignalsConfig, SignalError, SERVICE_ACTOR, type SignalsDeps } from "../modules/signals";
import { readOssSecrets } from "../modules/smoke";
import { runSignalsCli } from "./signals-cli";
import { runSignalsLoop } from "./signals-loop";

const env = process.env;
const logger = pino({ name: "signals", redact: ["*.apiKey", "*.authorization"] }, pino.destination(2));
const fatal = (e: unknown): never => {
  process.stderr.write(`${e instanceof SignalError || e instanceof Error ? e.message : String(e)}\n`);
  return process.exit(1);
};

const url = env.HBECHO_DATABASE_URL;
if (!url) fatal("缺少 HBECHO_DATABASE_URL");
let actor, config;
try {
  actor = actorFromEnv(env);
  config = parseSignalsConfig(env);
} catch (e) {
  fatal(e);
}
const strict = process.argv[2] === "run";

/** 用到时才报“未配置”的占位：不依赖 OSS 与能力服务的命令（catalog、show、tasks、recompute preview 等）不该因为它们没配而无法使用。 */
const unconfigured = <T extends object>(what: string): T =>
  new Proxy({}, { get: () => () => { throw new SignalError("configuration", "not_configured", `${what} 未配置`); } }) as T;
const bucket = (name: string): string => {
  const v = env[name]?.trim();
  if (!v || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v)) throw new Error(`环境变量 ${name} 缺失或不合法`);
  return v;
};
function infra(): Pick<SignalsDeps, "mediaStore" | "signalsStore" | "signalsBucket" | "converter" | "matcher"> {
  try {
    const signalsBucket = bucket("OSS_BUCKET_SIGNALS");
    const mediaBucket = bucket("OSS_BUCKET_MEDIA");
    const oss = readOssSecrets({ ...env, OSS_BUCKET_ODS: signalsBucket }); // 复用凭证与区域校验；桶名换成 signals 桶
    const baseUrl = env.HBECHO_CAPABILITY_URL?.trim();
    if (!baseUrl) throw new Error("环境变量 HBECHO_CAPABILITY_URL 缺失");
    const capability = new HttpCapabilityClient({ baseUrl });
    return {
      mediaStore: new OssObjectStore({ ...oss, bucket: mediaBucket }),
      signalsStore: new OssObjectStore(oss),
      signalsBucket,
      converter: capability,
      matcher: new HttpImageMatcher({ baseUrl, timeoutMs: config!.matchTimeoutMs }),
    };
  } catch (e) {
    if (strict) fatal(e);
    return { mediaStore: unconfigured("media 桶"), signalsStore: unconfigured("hbecho-signals 桶"), signalsBucket: "unconfigured", converter: unconfigured("能力服务"), matcher: unconfigured("能力服务") };
  }
}

const pool = createPool(url!);
const signals = createSignals({ db: createDb(pool), clock: { now: () => new Date() }, audit: createLogAudit(logger), config: config!, ...infra() });

const stop = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());
const code = await runSignalsCli(process.argv.slice(2), {
  signals,
  actor: actor!,
  readFile: (p) => readFileSync(p),
  run: async () => {
    logger.info({ actor: SERVICE_ACTOR, enabled: [...config!.enabled] }, "signals run started");
    await runSignalsLoop(
      {
        signals,
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
    logger.info("signals run stopped");
  },
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  onInternalError: (e) => logger.error({ err: e }, "signals cli internal error"),
});
await pool.end();
process.exit(code);
