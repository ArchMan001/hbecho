// `hbecho-course` 桶的 CourseObjectStore 实现（ADR-0005 登记的 ali-oss 官方 SDK）。
// 默认测试用 tests/harness/fake-course-store.ts；本文件只被注入的假客户端单测，真实调用只在部署与已批准的 smoke 里出现。
// 错误一律去掉可能夹带签名 / 凭证的原始 message，只保留可分类的信息（同 raw-capture/oss-store.ts）。
import { Readable } from "node:stream";
import OSS from "ali-oss";
import type { CredentialSource } from "./credentials";
import { staticCredentials } from "./credentials";
import type { CourseObjectStore } from "./store";

/** ali-oss 客户端里本模块用到的那部分形状。 */
export interface CourseOssClientLike {
  head(name: string, options?: { timeout?: number }): Promise<{ res: { headers: Record<string, unknown> } }>;
  get(name: string, options?: { headers?: Record<string, string>; timeout?: number }): Promise<{ content?: unknown }>;
  getStream(name: string, options?: { timeout?: number }): Promise<{ stream: unknown; res: { headers: Record<string, unknown> } }>;
  delete(name: string, options?: { timeout?: number }): Promise<unknown>;
  list(query: { prefix?: string; marker?: string; "max-keys": number }, options?: { timeout?: number }): Promise<{ objects?: Array<{ name: string; lastModified: string }>; isTruncated?: boolean; nextMarker?: string }>;
  signatureUrl(name: string, options?: { expires?: number; method?: string; "Content-Type"?: string; response?: Record<string, string> }): string;
}

export interface CourseStoreOptions {
  /** 固定 AccessKey；与 credentials 二选一。 */
  accessKeyId?: string;
  accessKeySecret?: string;
  /** 凭证来源（例如 ECS 实例角色，会过期）：每次操作前现取，凭证变了就换客户端。 */
  credentials?: CredentialSource;
  region: string;
  bucket: string;
  endpoint?: string;
  timeoutMs?: number;
  /** 测试注入点：给了就不再构造真实客户端。 */
  client?: CourseOssClientLike;
}

/** 环境变量里是 `cn-beijing`（与 OSS_REGION 一致），ali-oss 要 `oss-cn-beijing`；两种写法都接受。 */
export const normalizeOssRegion = (r: string): string => (r.startsWith("oss-") ? r : `oss-${r}`);

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
  private readonly timeoutMs: number;
  private current: { key: string; client: CourseOssClientLike } | undefined;
  private readonly source: CredentialSource | undefined;

  constructor(private readonly opts: CourseStoreOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (!opts.client) {
      if (opts.credentials) this.source = opts.credentials;
      else if (opts.accessKeyId && opts.accessKeySecret) this.source = staticCredentials({ accessKeyId: opts.accessKeyId, accessKeySecret: opts.accessKeySecret });
      else throw new Error("OssCourseStore 需要 accessKeyId / accessKeySecret 或 credentials");
    }
  }

  /** 凭证变了（STS 轮换）就换客户端；签名 URL 也用当前凭证，所以所有方法都先经过这里。 */
  private async client(): Promise<CourseOssClientLike> {
    if (this.opts.client) return this.opts.client;
    const c = await this.source!();
    const key = `${c.accessKeyId}:${c.securityToken ?? ""}`;
    if (this.current?.key !== key) {
      this.current = {
        key,
        client: new OSS({
          accessKeyId: c.accessKeyId,
          accessKeySecret: c.accessKeySecret,
          ...(c.securityToken ? { stsToken: c.securityToken } : {}),
          region: normalizeOssRegion(this.opts.region),
          bucket: this.opts.bucket,
          ...(this.opts.endpoint === undefined ? {} : { endpoint: this.opts.endpoint }),
          secure: true,
          timeout: this.timeoutMs,
        }) as unknown as CourseOssClientLike,
      };
    }
    return this.current.client;
  }

  async signedPutUrl(key: string, contentType: string, ttlSeconds: number): Promise<string> {
    try {
      return (await this.client()).signatureUrl(key, { expires: ttlSeconds, method: "PUT", "Content-Type": contentType });
    } catch (e) {
      throw wrap(e, "signatureUrl(PUT)");
    }
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const h = (await (await this.client()).head(key, { timeout: this.timeoutMs })).res.headers;
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
      content = (await (await this.client()).get(key, { headers: { Range: `bytes=${start}-${endInclusive}` }, timeout: this.timeoutMs })).content;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw wrap(e, "get");
    }
    if (content instanceof Uint8Array) return content;
    if (Buffer.isBuffer(content)) return new Uint8Array(content);
    throw new Error("OSS get 返回了无法识别的响应体");
  }

  async getObject(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
    try {
      const r = await (await this.client()).getStream(key, { timeout: this.timeoutMs });
      const size = Number(r.res.headers["content-length"]);
      if (!(r.stream instanceof Readable) || !Number.isSafeInteger(size) || size < 0) throw new Error("OSS getStream 返回了无法识别的响应");
      return { body: Readable.toWeb(r.stream) as ReadableStream<Uint8Array>, size };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e instanceof Error && e.message.startsWith("OSS ") ? e : wrap(e, "getStream");
    }
  }

  async signedGetUrl(key: string, ttlSeconds: number, opts: { downloadName?: string } = {}): Promise<string> {
    try {
      return (await this.client()).signatureUrl(key, {
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
      await (await this.client()).delete(key, { timeout: this.timeoutMs });
    } catch (e) {
      if (isNotFound(e)) return;
      throw wrap(e, "delete");
    }
  }

  async list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
    const out: Array<{ key: string; lastModified: Date }> = [];
    let marker: string | undefined;
    for (;;) {
      let page: Awaited<ReturnType<CourseOssClientLike["list"]>>;
      try {
        page = await (await this.client()).list({ prefix, "max-keys": 1000, ...(marker === undefined ? {} : { marker }) }, { timeout: this.timeoutMs });
      } catch (e) {
        throw wrap(e, "list");
      }
      for (const o of page.objects ?? []) out.push({ key: o.name, lastModified: new Date(o.lastModified) });
      if (!page.isTruncated || !page.nextMarker) return out;
      marker = page.nextMarker;
    }
  }
}
