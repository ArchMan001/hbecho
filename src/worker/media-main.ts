// `pnpm media renormalize [--limit N] [--dry-run]` 的进程入口：回填「转换服务不可用期间」留下的失败衍生图（头像 / 背景 / 封面的 JPEG）。
// 部署能力服务之后在 ECS 上跑一次（`--env-file /data/app/sync.env`）；先 --dry-run 看数量。不调供应商、不花点数；只读正式媒资桶、写衍生图。
// 环境变量：HBECHO_DATABASE_URL、HBECHO_CAPABILITY_URL、OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_REGION / OSS_BUCKET_MEDIA（可选 OSS_ENDPOINT）。
import { parseArgs } from "node:util";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { HttpCapabilityClient, renormalizeUnavailable } from "../modules/media-archive";
import { OssObjectStore } from "../modules/raw-capture";

const logger = pino({ name: "media-cli" }, pino.destination(2));
const need = (k: string): string => {
  const v = process.env[k]?.trim();
  if (!v) {
    process.stderr.write(`缺少环境变量 ${k}\n`);
    process.exit(1);
  }
  return v;
};
const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "renormalize") {
  process.stderr.write("用法：media renormalize [--limit <N>] [--dry-run]\n");
  process.exit(2);
}
const { values } = parseArgs({ args: rest, strict: true, options: { limit: { type: "string" }, "dry-run": { type: "boolean" } } });
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  process.stderr.write("--limit 必须是正整数\n");
  process.exit(2);
}
const region = need("OSS_REGION");
const bucket = need("OSS_BUCKET_MEDIA");
const endpoint = process.env.OSS_ENDPOINT?.trim();
const pool = createPool(need("HBECHO_DATABASE_URL"));
try {
  const report = await renormalizeUnavailable(
    {
      db: createDb(pool),
      clock: { now: () => new Date() },
      mediaStore: new OssObjectStore({ accessKeyId: need("OSS_ACCESS_KEY_ID"), accessKeySecret: need("OSS_ACCESS_KEY_SECRET"), region, bucket, ...(endpoint ? { endpoint } : {}) }),
      location: { providerCode: "aliyun-oss", region, bucket },
      converter: new HttpCapabilityClient({ baseUrl: need("HBECHO_CAPABILITY_URL") }),
    },
    { ...(limit === undefined ? {} : { limit }), dryRun: values["dry-run"] === true },
  );
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: values["dry-run"] === true, ...report })}\n`);
  process.exitCode = report.stoppedEarly ? 3 : 0;
} catch (e) {
  logger.error({ err: e }, "media-cli failed");
  process.stdout.write(`${JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
