// 默认测试用的媒资 transport / 转换器：全部在内存里，不碰网络；未登记的 URL 立即失败。
import { createHash } from "node:crypto";
import { ConverterError, type ImageConverter, type MediaResponse, type MediaTransport } from "../../src/modules/media-archive";

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
