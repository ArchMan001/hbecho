// `pnpm learning-smoke`：对真实 `hbecho-course` 桶验证资料直传链路（g-learning-min acceptance E4）。
// 只在人工批准后运行（2026-11-11 刘学奎批准：直传、HEAD、Range 读取、下载 Content-Disposition）。
// 门槛：HBECHO_LEARNING_SMOKE=approved；桶名必须正好是 hbecho-course；固定预算：1 个 < 1 KB 的对象，全程不超过 ~12 次请求，用完即删。
// 不读写数据库，不打印任何密钥；只打印审计摘要。读取 .env（Node 自带 loadEnvFile）。
import { loadEnvFile } from "node:process";
import { DEFAULT_LEARNING_CONFIG } from "../modules/learning/config";
import { verifyUpload } from "../modules/learning/course-common";
import { newKey } from "../modules/learning/files";
import { OssCourseStore } from "../modules/learning/oss-course-store";
import { parseLearningEnv } from "../modules/learning/runtime";
import type { LearningDeps } from "../modules/learning/deps";

try {
  loadEnvFile(".env");
} catch (e) {
  if ((e as { code?: unknown }).code !== "ENOENT") throw e;
}
const env = process.env;
const BUCKET = env.HBECHO_COURSE_OSS_BUCKET ?? "hbecho-course";
const region = env.HBECHO_COURSE_OSS_REGION ?? env.OSS_REGION;

const gate: string[] = [];
if (env.HBECHO_LEARNING_SMOKE !== "approved") gate.push("HBECHO_LEARNING_SMOKE=approved");
if (BUCKET !== "hbecho-course") gate.push("桶名必须是 hbecho-course");
if (!region && env.HBECHO_LEARNING_CREDENTIALS !== "ecs_role") gate.push("HBECHO_COURSE_OSS_REGION（或 OSS_REGION）");
if (gate.length) {
  process.stderr.write(`门槛未满足，未发起任何请求：${gate.join("；")}\n`);
  process.exit(2);
}

const cfg = parseLearningEnv(env);
const store = new OssCourseStore({ credentials: cfg.credentials, region: cfg.region, bucket: cfg.bucket, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}) });
const deps = { store, config: DEFAULT_LEARNING_CONFIG } as unknown as LearningDeps;

const pdf = new TextEncoder().encode("%PDF-1.4\n% hbecho learning smoke\n");
const key = newKey("doc", "application/pdf");
const steps: Array<{ step: string; ok: boolean; note?: string }> = [];
let requests = 0;
const rec = (step: string, ok: boolean, note?: string) => steps.push({ step, ok, ...(note ? { note } : {}) });
const http = async (url: string, init?: RequestInit) => {
  requests += 1;
  return fetch(url, { ...init, redirect: "manual" });
};
const errCode = (e: unknown) => (e instanceof Error ? e.message.slice(0, 80) : typeof e);

try {
  // 1 浏览器直传：按签名 PUT
  const put = await store.signedPutUrl(key, "application/pdf", 120);
  const up = await http(put, { method: "PUT", headers: { "content-type": "application/pdf" }, body: pdf });
  rec("直传 PUT（签名绑定 Content-Type）", up.status === 200, `HTTP ${up.status}`);

  // 2 签名绑定的 Content-Type 不同 → 必须被拒（防止换类型上传）
  const wrongKey = newKey("doc", "application/pdf");
  const putWrong = await store.signedPutUrl(wrongKey, "application/pdf", 120);
  const wrong = await http(putWrong, { method: "PUT", headers: { "content-type": "text/html" }, body: pdf });
  rec("Content-Type 与签名不符被拒", wrong.status === 403, `HTTP ${wrong.status}`);
  if (wrong.status === 200) await store.delete(wrongKey);

  // 3 HEAD + Range 读魔数（与创建课程时同一段校验代码）
  const v = await verifyUpload(deps, "doc", key);
  rec("HEAD + Range 读取 + 魔数校验", v.size === pdf.byteLength && v.mime === "application/pdf", `size=${v.size}`);
  const head = await store.getRange(key, 0, 7);
  rec("Range 只取前 8 字节", head?.byteLength === 8, `got=${head?.byteLength}`);
  rec("不存在的对象 HEAD 为 null / Range 为 null", (await store.head(`${key}.none`)) === null && (await store.getRange(`${key}.none`, 0, 7)) === null);

  // 4 下载：带附件名的签名 GET，检查 Content-Disposition
  const dl = await http(await store.signedGetUrl(key, 60, { downloadName: "测试 手册.pdf" }));
  const cd = dl.headers.get("content-disposition") ?? "";
  const body = new Uint8Array(await dl.arrayBuffer());
  rec("下载签名 GET 返回原文件", dl.status === 200 && body.byteLength === pdf.byteLength, `HTTP ${dl.status}`);
  rec("Content-Disposition 为附件并带 UTF-8 文件名", /^attachment/i.test(cd) && cd.includes("filename*=UTF-8''%E6%B5%8B%E8%AF%95%20%E6%89%8B%E5%86%8C.pdf"), cd.slice(0, 120));

  // 4b 服务端转发预览用的流式读取
  const obj = await store.getObject(key);
  const streamed = obj ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
  rec("getObject 流式读取整个对象", streamed?.byteLength === pdf.byteLength && obj?.size === pdf.byteLength, `size=${obj?.size}`);
  rec("getObject 对不存在的对象返回 null", (await store.getObject(`${key}.none`)) === null);

  // 5 预览：不带附件名的签名 GET——只记录事实，不预设期望（默认域名可能强制下载）
  const pv = await http(await store.signedGetUrl(key, 60));
  rec("预览签名 GET（记录事实）", pv.status === 200, `HTTP ${pv.status}; content-type=${pv.headers.get("content-type")}; content-disposition=${pv.headers.get("content-disposition") ?? "（无）"}; x-oss-force-download=${pv.headers.get("x-oss-force-download") ?? "（无）"}`);

  // 6 列表权限
  const listed = await store.list("doc/");
  rec("List 前缀能看到刚传的对象", listed.some((o) => o.key === key), `共 ${listed.length} 个`);
} catch (e) {
  rec("异常中止", false, errCode(e));
} finally {
  try {
    await store.delete(key);
    rec("清理：Delete 删除对象", (await store.head(key)) === null);
    await store.delete(key);
    rec("Delete 幂等（对象已不存在也成功）", true);
  } catch (e) {
    rec("清理失败（需要人工删除该对象）", false, `${key}: ${errCode(e)}`);
  }
}

const failed = steps.filter((s) => !s.ok);
process.stdout.write(`${JSON.stringify({ bucket: BUCKET, region: cfg.region, credentials: cfg.credentialsKind, key, httpRequests: requests, bytesUploaded: pdf.byteLength, steps, failed: failed.length }, null, 2)}\n`);
process.exit(failed.length ? 1 : 0);
