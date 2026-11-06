// 媒资归档的端口。默认测试换入 fake；真实实现（HTTP 下载、Python 能力服务客户端）随部署落地。

export interface MediaResponse {
  status: number;
  contentType: string | null;
  /** 响应头声明的长度；用来发现被截断的下载。 */
  contentLength: number | null;
  /** 3xx 的目标地址。 */
  location: string | null;
  body: Uint8Array;
}

/**
 * 单跳 GET：**不跟随重定向**（重定向由 downloadBounded 逐跳校验后再请求）。
 * 真实实现必须：① 超过 maxBytes 就中止读取；② 在连接前解析 DNS 并拒绝私网 / 回环 / 链路本地地址
 * （URL 守卫只能挡住字面量，挡不住解析到内网的域名）；③ 超时抛 MediaFailure("timeout")。
 */
export interface MediaTransport {
  get(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<MediaResponse>;
}

export class ConverterError extends Error {
  constructor(
    readonly kind: "unsupported" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ConverterError";
  }
}

export interface NormalizedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** 标准化衍生图（JPEG q80、540 宽）。真实实现是 Python 能力服务（ADR-0012，ffmpeg ≥ 7.1 解码 HEIC）。 */
export interface ImageConverter {
  toNormalizedJpeg(input: { bytes: Uint8Array; mimeType: string }): Promise<NormalizedImage>;
}

// ── 视频 / 音频（a-full-sync 任务 7）──

export interface VideoStreamResponse {
  status: number;
  contentType: string | null;
  contentLength: number | null;
  /** 3xx 的目标地址。 */
  location: string | null;
  /** 2xx 的响应体：按块产出，调用方边收边写临时文件，内存不随文件大小增长。 */
  body: AsyncIterable<Uint8Array> | null;
}
/**
 * 单跳流式 GET：**不跟随重定向**（由 downloadVideoToFile 逐跳校验后再请求）。
 * 真实实现必须：① 连接前解析 DNS 并拒绝私网 / 回环 / 链路本地地址；② 超时抛 MediaFailure("timeout")；
 * ③ 消费方停止迭代（超限中止）时关闭连接。
 */
export interface VideoTransport {
  stream(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<VideoStreamResponse>;
}

export type AudioExtraction = { kind: "ok"; bytes: Uint8Array; durationMs: number | null } | { kind: "no_audio_track" };
/**
 * Python 能力服务的音频抽取（ADR-0012，FS-11.7）。sourceUrl 是已入库视频的短期签名 URL（服务不持有 OSS 凭证）。
 * 服务不可用抛 ConverterError("unavailable")（可重试）；无法抽取抛 ConverterError("unsupported")。
 */
export interface CapabilityClient {
  extractAudio(input: { sourceUrl: string; maxBytes: number }): Promise<AudioExtraction>;
}
