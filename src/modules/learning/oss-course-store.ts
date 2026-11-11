// `hbecho-course` 桶的 CourseObjectStore 实现（ADR-0005 登记的 ali-oss 官方 SDK）。
// 默认测试用 tests/harness/fake-course-store.ts；本文件只被注入的假客户端单测，真实调用只在部署与已批准的 smoke 里出现。
// 错误一律去掉可能夹带签名 / 凭证的原始 message，只保留可分类的信息（同 raw-capture/oss-store.ts）。
import OSS from "ali-oss";
import type { CourseObjectStore } from "./store";

/** ali-oss 客户端里本模块用到的那部分形状。 */
export interface CourseOssClientLike {
  head(name: string, options?: { timeout?: number }): Promise<{ res: { headers: Record<string, unknown> } }>;
  get(name: string, options?: { headers?: Record<string, string>; timeout?: number }): Promise<{ content?: unknown }>;
  delete(name: string, options?: { timeout?: number }): Promise<unknown>;
  signatureUrl(name: string, options?: { expires?: number; method?: string; "Content-Type"?: string; response?: Record<string, string> }): string;
}

export interface CourseStoreOptions {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  endpoint?: string;
  timeoutMs?: number;
  /** 测试注入点：给了就不再构造真实客户端。 */
  client?: CourseOssClientLike;
}

function isNotFound(e: unknown): boolean {
  for (let cur = e as { code?: unknown; status?: unknown; name?: unknown } | undefined; cur; cur = (cur as { cause?: unknown }).cause as typeof cur) {
    if (cur.code === "NoSuchKey" || cur.status === 404 || cur.name === "NoSuchKeyError") return true;
  }
  return false;
}
function wrap(e: unknown, op: string): Error {
  const code = (e as { code?: unknown })?.code;
  const status = (e as { status?: unknown })?.status;
  const detail = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : typeof status === "number" ? `status=${status}` : "unknown";
  return new Error(`OSS ${op} 失败（${detail}）`);
}

/** RFC 5987：filename 给 ASCII 兜底，filename* 带 UTF-8 原名。 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export class OssCourseStore implements CourseObjectStore {
  private readonly client: CourseOssClientLike;
  private readonly timeoutMs: number;

  constructor(opts: CourseStoreOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.client =
      opts.client ??
      (new OSS({
        accessKeyId: opts.accessKeyId,
        accessKeySecret: opts.accessKeySecret,
        region: opts.region,
        bucket: opts.bucket,
        ...(opts.endpoint === undefined ? {} : { endpoint: opts.endpoint }),
        secure: true,
        timeout: this.timeoutMs,
      }) as unknown as CourseOssClientLike);
  }

  async signedPutUrl(key: string, contentType: string, ttlSeconds: number): Promise<string> {
    try {
      return this.client.signatureUrl(key, { expires: ttlSeconds, method: "PUT", "Content-Type": contentType });
    } catch (e) {
      throw wrap(e, "signatureUrl(PUT)");
    }
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const h = (await this.client.head(key, { timeout: this.timeoutMs })).res.headers;
      const size = Number(h["content-length"]);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("OSS head 返回了无法识别的 content-length");
      return { size, contentType: String(h["content-type"] ?? "") };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e instanceof Error && e.message.startsWith("OSS ") ? e : wrap(e, "head");
    }
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null> {
    let content: unknown;
    try {
      content = (await this.client.get(key, { headers: { Range: `bytes=${start}-${endInclusive}` }, timeout: this.timeoutMs })).content;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw wrap(e, "get");
    }
    if (content instanceof Uint8Array) return content;
    if (Buffer.isBuffer(content)) return new Uint8Array(content);
    throw new Error("OSS get 返回了无法识别的响应体");
  }

  async signedGetUrl(key: string, ttlSeconds: number, opts: { downloadName?: string } = {}): Promise<string> {
    try {
      return this.client.signatureUrl(key, {
        expires: ttlSeconds,
        method: "GET",
        ...(opts.downloadName === undefined ? {} : { response: { "content-disposition": attachmentDisposition(opts.downloadName) } }),
      });
    } catch (e) {
      throw wrap(e, "signatureUrl(GET)");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(key, { timeout: this.timeoutMs });
    } catch (e) {
      if (isNotFound(e)) return;
      throw wrap(e, "delete");
    }
  }
}
