// 私有 OSS 的 ObjectStore 实现（ADR-0005 登记的 ali-oss 官方 SDK）。
// 只在部署与**已批准**的 smoke 里出现；默认测试一律用 tests/harness/fake-oss.ts。
//
// 边界：这里只做「把给定字节原样存进桶、按 key 取回、删掉、列前缀」。
// 判同仍归调用方（RawCaptureGateway 会在 put 之后回读并比对 SHA-256）；本实现不吞任何异常，
// 也不在错误信息里带 AccessKey、签名串或完整请求头。
import { createHash } from "node:crypto";
import OSS from "ali-oss";
import type { ObjectStore, StoredObject } from "./ports";

/** ali-oss 客户端里本模块用到的那部分形状；单测注入同形的假客户端时不必构造真实 SDK。 */
export interface OssClientLike {
  put(name: string, file: Uint8Array, options?: { timeout?: number; mime?: string }): Promise<unknown>;
  get(name: string): Promise<{ content?: unknown }>;
  delete(name: string, options?: { timeout?: number }): Promise<unknown>;
  list(
    query: { prefix?: string; marker?: string; "max-keys": number },
    options?: { timeout?: number },
  ): Promise<{ objects?: Array<{ name: string; lastModified: string }>; isTruncated?: boolean; nextMarker?: string }>;
}

export interface OssStoreOptions {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  /** 缺省走公网 endpoint；ECS 内网可显式传 oss-<region>-internal.aliyuncs.com。 */
  endpoint?: string;
  timeoutMs?: number;
  /** 测试注入点：给了就不再构造真实客户端。 */
  client?: OssClientLike;
}

/** OSS 侧把「对象不存在」当作可预期的状态，不当作故障。 */
function isNotFound(e: unknown): boolean {
  for (let cur = e as { code?: unknown; status?: unknown; name?: unknown } | undefined; cur; cur = (cur as { cause?: unknown }).cause as typeof cur) {
    if (cur.code === "NoSuchKey" || cur.status === 404) return true;
    if (cur.name === "NoSuchKeyError") return true;
  }
  return false;
}

/** 错误一律去掉可能夹带签名/凭证的原始 message，只保留可分类的信息。 */
function wrap(e: unknown, op: string): Error {
  const code = (e as { code?: unknown })?.code;
  const status = (e as { status?: unknown })?.status;
  const detail = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : typeof status === "number" ? `status=${status}` : "unknown";
  return new Error(`OSS ${op} 失败（${detail}）`);
}

const DEFAULT_TIMEOUT_MS = 30_000;
const LIST_PAGE = 1000;

export class OssObjectStore implements ObjectStore {
  private readonly client: OssClientLike;
  private readonly timeoutMs: number;

  constructor(opts: OssStoreOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      }) as unknown as OssClientLike);
  }

  async put(key: string, bytes: Uint8Array): Promise<StoredObject> {
    try {
      await this.client.put(key, bytes, { timeout: this.timeoutMs });
    } catch (e) {
      throw wrap(e, "put");
    }
    return { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    let res: { content?: unknown };
    try {
      res = await this.client.get(key);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw wrap(e, "get");
    }
    const c = res.content;
    if (c instanceof Uint8Array) return c;
    if (Buffer.isBuffer(c)) return new Uint8Array(c);
    if (typeof c === "string") return new TextEncoder().encode(c);
    throw new Error("OSS get 返回了无法识别的响应体");
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(key, { timeout: this.timeoutMs });
    } catch (e) {
      if (isNotFound(e)) return; // 契约：对象不存在也算成功
      throw wrap(e, "delete");
    }
  }

  async list(prefix: string): Promise<Array<{ key: string; createdAt: Date }>> {
    const out: Array<{ key: string; createdAt: Date }> = [];
    let marker: string | undefined;
    for (;;) {
      let page: Awaited<ReturnType<OssClientLike["list"]>>;
      try {
        page = await this.client.list({ prefix, "max-keys": LIST_PAGE, ...(marker === undefined ? {} : { marker }) }, { timeout: this.timeoutMs });
      } catch (e) {
        throw wrap(e, "list");
      }
      for (const o of page.objects ?? []) out.push({ key: o.name, createdAt: new Date(o.lastModified) });
      if (!page.isTruncated || !page.nextMarker) return out;
      marker = page.nextMarker;
    }
  }
}