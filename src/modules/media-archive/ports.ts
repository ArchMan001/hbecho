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
