// `pnpm signals-smoke`：对真实 `hbecho-signals` 桶与真实 Python 能力服务验证“Node → OSS 签名 URL → Python 匹配”端到端（c-signals acceptance ENV-1 / ENV-2 的端到端档）。
// 不发任何付费调用（不连 AI Master，不连模型）；只在人工批准后运行（2026-11-12 刘学奎同意创建桶并验证）。
// 门槛：HBECHO_SIGNALS_SMOKE=approved；OSS_BUCKET_SIGNALS 必须正好是 hbecho-signals；固定预算：3 个 ≤ 5 MiB 的对象、2 次匹配，全程用完即删。
// 图片由调用方准备在目录 HBECHO_SIGNALS_SMOKE_DIR 里：ref.png（标准图）、same.png（同一张图的轻微变体或本身）、other.png（无关图）。
// 凭证：HBECHO_SIGNALS_CREDENTIALS=ecs_role（测试 ECS 的实例角色，首选）或 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET。不读写数据库，不打印密钥与签名 URL。
import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import OSS from "ali-oss";
import { ecsRoleCredentials, staticCredentials, type CredentialSource } from "../modules/learning/credentials";
import { normalizeOssRegion } from "../modules/learning/oss-course-store";
import { OssObjectStore, type OssClientLike } from "../modules/raw-capture/oss-store";
import { HttpImageMatcher } from "../modules/signals";

try {
  loadEnvFile(".env");
} catch (e) {
  if ((e as { code?: unknown }).code !== "ENOENT") throw e;
}
const env = process.env;
const BUCKET = env.OSS_BUCKET_SIGNALS ?? "";
const dir = env.HBECHO_SIGNALS_SMOKE_DIR ?? "";
const capabilityUrl = env.HBECHO_CAPABILITY_URL ?? "";
const region = env.OSS_REGION;
const useRole = env.HBECHO_SIGNALS_CREDENTIALS === "ecs_role";
const gate: string[] = [];
if (env.HBECHO_SIGNALS_SMOKE !== "approved") gate.push("HBECHO_SIGNALS_SMOKE=approved");
if (BUCKET !== "hbecho-signals") gate.push("OSS_BUCKET_SIGNALS 必须是 hbecho-signals");
if (!dir) gate.push("HBECHO_SIGNALS_SMOKE_DIR");
if (!capabilityUrl) gate.push("HBECHO_CAPABILITY_URL");
if (!region) gate.push("OSS_REGION");
if (!useRole && !(env.OSS_ACCESS_KEY_ID && env.OSS_ACCESS_KEY_SECRET)) gate.push("HBECHO_SIGNALS_CREDENTIALS=ecs_role 或 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
if (gate.length) {
  process.stderr.write(`门槛未满足，未发起任何请求：${gate.join("；")}\n`);
  process.exit(2);
}

const MAX = 5 * 1024 * 1024;
const files = { ref: "ref.png", same: "same.png", other: "other.png" } as const;
const bytes = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(`${dir}/${f}`)])) as Record<keyof typeof files, Buffer>;
for (const [k, b] of Object.entries(bytes)) if (b.byteLength > MAX) throw new Error(`${k} 超过 ${MAX} 字节的预算`);

const source: CredentialSource = useRole ? ecsRoleCredentials() : staticCredentials({ accessKeyId: env.OSS_ACCESS_KEY_ID!, accessKeySecret: env.OSS_ACCESS_KEY_SECRET! });
const c = await source();
const client = new OSS({
  accessKeyId: c.accessKeyId,
  accessKeySecret: c.accessKeySecret,
  ...(c.securityToken ? { stsToken: c.securityToken } : {}),
  region: normalizeOssRegion(region!),
  bucket: BUCKET,
  ...(env.OSS_ENDPOINT ? { endpoint: env.OSS_ENDPOINT } : {}),
  secure: true,
  timeout: 30_000,
});
const store = new OssObjectStore({ accessKeyId: "", accessKeySecret: "", region: region!, bucket: BUCKET, client: client as unknown as OssClientLike });
const matcher = new HttpImageMatcher({ baseUrl: capabilityUrl, timeoutMs: 60_000 });

const prefix = `_smoke/${Date.now()}`;
const keys = { ref: `${prefix}/ref.png`, same: `${prefix}/same.png`, other: `${prefix}/other.png` };
const steps: Array<{ step: string; ok: boolean; note?: string }> = [];
const rec = (step: string, ok: boolean, note?: string) => steps.push({ step, ok, ...(note ? { note } : {}) });
try {
  for (const k of ["ref", "same", "other"] as const) {
    const stored = await store.put(keys[k], bytes[k]);
    rec(`put ${k}`, stored.byteLength === bytes[k].byteLength);
  }
  const url = (k: keyof typeof keys) => store.signedGetUrl(keys[k], 600);
  const same = await matcher.match({ referenceUrl: await url("ref"), candidateUrl: await url("same"), mode: "template", maxBytes: MAX });
  rec("match same", same.score >= 9.5, `score=${same.score} capability=${same.capability.id}@${same.capability.version} evidence=${JSON.stringify(same.evidence)}`);
  const other = await matcher.match({ referenceUrl: await url("ref"), candidateUrl: await url("other"), mode: "template", maxBytes: MAX });
  rec("match other", other.score < 2, `score=${other.score}`);
} catch (e) {
  rec("error", false, e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, "<url>") : "unknown");
} finally {
  for (const k of Object.values(keys)) await store.delete(k).catch(() => undefined);
  const left = await store.list(prefix).catch(() => null);
  rec("cleanup", left !== null && left.length === 0, left === null ? "list 失败" : `剩余 ${left.length}`);
}
const failed = steps.filter((s) => !s.ok);
process.stdout.write(`${JSON.stringify({ bucket: BUCKET, credentials: useRole ? "ecs_role" : "access_key", steps, failed: failed.length }, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
