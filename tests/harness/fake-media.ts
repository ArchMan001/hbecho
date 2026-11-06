// 默认测试用的媒资 transport / 转换器：全部在内存里，不碰网络；未登记的 URL 立即失败。
import { createHash } from "node:crypto";
import { ConverterError, type AudioExtraction, type CapabilityClient, type ImageConverter, type MediaResponse, type MediaTransport, type VideoStreamResponse, type VideoTransport } from "../../src/modules/media-archive";
import type { MediaObjectStore } from "../../src/modules/raw-capture";

const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** 带唯一载荷的最小「图片」字节：只有魔数合法，用于类型嗅探与去重（相同 tag → 相同字节）。 */
export const jpegBytes = (tag: string) => cat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), enc.encode(`JFIF:${tag}`));
export const webpBytes = (tag: string) => cat(enc.encode("RIFF"), Uint8Array.from([0, 0, 0, 0]), enc.encode("WEBP"), enc.encode(tag));
export const heicBytes = (tag: string) => cat(Uint8Array.from([0, 0, 0, 24]), enc.encode("ftypheic"), enc.encode(tag));

export type MediaRoute = MediaResponse | ((url: string, n: number) => MediaResponse | Promise<MediaResponse>);

export class FakeMediaTransport implements MediaTransport {
  readonly requested: string[] = [];
  private readonly routes = new Map<string, MediaRoute>();
  private counts = new Map<string, number>();
  /** 每次请求前调用：测试用它断言「此刻没有打开的数据库事务」。 */
  onRequest: ((url: string) => Promise<void> | void) | null = null;

  route(url: string, r: Partial<MediaResponse> | MediaRoute): void {
    this.routes.set(url, typeof r === "function" ? r : { status: 200, contentType: "image/jpeg", contentLength: null, location: null, body: new Uint8Array(), ...r });
  }
  routeAll(urls: string[], r: Partial<MediaResponse>): void {
    for (const u of urls) this.route(u, r);
  }
  callsTo(url: string): number {
    return this.counts.get(url) ?? 0;
  }
  async get(url: string): Promise<MediaResponse> {
    this.requested.push(url);
    this.counts.set(url, (this.counts.get(url) ?? 0) + 1);
    await this.onRequest?.(url);
    const r = this.routes.get(url);
    if (!r) throw new Error(`fake media transport 没有登记该 URL：${url}`);
    return typeof r === "function" ? r(url, this.counts.get(url)!) : r;
  }
}

/** 确定性的假转换器：输出由输入派生（不同输入 → 不同 JPEG 字节），固定 540×960。 */
export class FakeImageConverter implements ImageConverter {
  readonly inputs: Array<{ mimeType: string; bytes: Uint8Array }> = [];
  fail: null | "unsupported" | "unavailable" = null;
  /** 转换服务返回了不是 JPEG 的字节（服务端缺陷）。 */
  returnNonJpeg = false;
  async toNormalizedJpeg(input: { bytes: Uint8Array; mimeType: string }) {
    this.inputs.push({ mimeType: input.mimeType, bytes: input.bytes });
    if (this.fail === "unsupported") throw new ConverterError("unsupported", "无法解码");
    if (this.fail === "unavailable") throw new ConverterError("unavailable", "能力服务不可用");
    if (this.returnNonJpeg) return { bytes: new TextEncoder().encode("not a jpeg"), width: 540, height: 960 };
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    return { bytes: jpegBytes(`derived:${digest}`), width: 540, height: 960 };
  }
}

// ── 视频 / 音频 ──

/** 最小的 MP4 头（ftyp）+ 填充：魔数合法，字节由 tag 决定（相同 tag → 相同字节）。 */
export function mp4Header(tag: string): Uint8Array {
  return cat(Uint8Array.from([0, 0, 0, 24]), enc.encode("ftypisom"), Uint8Array.from([0, 0, 2, 0]), enc.encode(`isomiso2${tag}`));
}
export interface VideoRoute {
  status?: number;
  contentType?: string | null;
  /** 响应头声明的长度；不给则取实际总字节数。给错的值用来测截断。 */
  contentLength?: number | null;
  location?: string | null;
  /** 总字节数与块大小：按需生成，不预先分配整个文件（大文件测试）。 */
  total?: number;
  chunk?: number;
  tag?: string;
  /** 自定义响应体块（优先于 total / chunk）。 */
  chunks?: Uint8Array[];
  /** 每产出一块调用（测试用来采样内存）。 */
  onChunk?: (produced: number) => void;
  /** 抛出的传输失败（例如超时）。 */
  throws?: Error;
}
export class FakeVideoTransport implements VideoTransport {
  readonly requested: string[] = [];
  private readonly routes = new Map<string, VideoRoute | ((n: number) => VideoRoute)>();
  private readonly counts = new Map<string, number>();
  route(url: string, r: VideoRoute | ((n: number) => VideoRoute)): void {
    this.routes.set(url, r);
  }
  callsTo(url: string): number {
    return this.counts.get(url) ?? 0;
  }
  async stream(url: string): Promise<VideoStreamResponse> {
    this.requested.push(url);
    const n = (this.counts.get(url) ?? 0) + 1;
    this.counts.set(url, n);
    const raw = this.routes.get(url);
    if (!raw) throw new Error(`fake video transport 没有登记该 URL：${url}`);
    const r = typeof raw === "function" ? raw(n) : raw;
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    const total = r.chunks ? r.chunks.reduce((a, c) => a + c.byteLength, 0) : (r.total ?? 1024);
    const body: AsyncIterable<Uint8Array> | null =
      status >= 200 && status < 300
        ? {
            async *[Symbol.asyncIterator]() {
              if (r.chunks) {
                let produced = 0;
                for (const c of r.chunks) {
                  produced += c.byteLength;
                  r.onChunk?.(produced);
                  yield c;
                }
                return;
              }
              const size = r.chunk ?? 64 * 1024;
              const head = mp4Header(r.tag ?? "v");
              let produced = 0;
              while (produced < total) {
                const len = Math.min(size, total - produced);
                const block = new Uint8Array(len);
                if (produced === 0) block.set(head.subarray(0, Math.min(head.byteLength, len)));
                else block.fill(produced % 251);
                produced += len;
                r.onChunk?.(produced);
                yield block;
              }
            },
          }
        : null;
    return { status, contentType: r.contentType === undefined ? "video/mp4" : r.contentType, contentLength: r.contentLength === undefined ? total : r.contentLength, location: r.location ?? null, body };
  }
}

/** 假的 Python 能力服务客户端：按签名 URL 里的 key 从假 OSS 读回视频，输出由视频字节派生的 m4a 样字节。 */
export class FakeCapabilityClient implements CapabilityClient {
  readonly calls: Array<{ sourceUrl: string; maxBytes: number }> = [];
  noAudio = false;
  fail: null | "unavailable" | "unsupported" = null;
  constructor(private readonly store: Pick<MediaObjectStore, "get">) {}
  async extractAudio(input: { sourceUrl: string; maxBytes: number }): Promise<AudioExtraction> {
    this.calls.push(input);
    if (this.fail === "unavailable") throw new ConverterError("unavailable", "能力服务不可用");
    if (this.fail === "unsupported") throw new ConverterError("unsupported", "无法抽取音频");
    if (this.noAudio) return { kind: "no_audio_track" };
    const key = decodeURIComponent(new URL(input.sourceUrl).pathname.slice(1));
    const video = await this.store.get(key);
    if (!video) throw new ConverterError("unavailable", "签名 URL 读不到视频");
    const digest = createHash("sha256").update(video).digest("hex");
    return { kind: "ok", bytes: cat(Uint8Array.from([0, 0, 0, 24]), enc.encode("ftypM4A "), enc.encode(`audio:${digest}`)), durationMs: 12_345 };
  }
}
