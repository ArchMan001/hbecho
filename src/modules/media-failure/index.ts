// 媒资归档失败码的分类（叶子模块，无依赖）：状态查询与归档模块共用，避免各写一份。
//  - retryable：同一个 URL 还可能成功（网络、供应商 CDN 抖动、转换服务暂不可用），有界地重试；
//  - needs_fresh_url：签名 URL 过期 / 失效，重试必须重新获取有效地址（下一次主页 / 列表采集），不能复用旧地址；
//  - terminal：重试没有意义（超限、类型不允许、地址被拒绝、无法转换）；
//  - informational：不是故障，是事实（视频没有音轨）：终态、不重试、不计入批次的媒资失败数。
export const MEDIA_FAILURES = {
  source_expired: "needs_fresh_url",
  source_unavailable: "retryable",
  timeout: "retryable",
  transport_error: "retryable",
  truncated: "retryable",
  converter_unavailable: "retryable",
  too_large: "terminal",
  content_type_not_allowed: "terminal",
  unsupported_format: "terminal",
  url_rejected: "terminal",
  too_many_redirects: "terminal",
  no_source_locator: "terminal",
  convert_failed: "terminal",
  cover_unavailable: "terminal", // 快手封面的 CDN 转换来源取不到：封面不可用（D-62），内容不受影响
  no_audio_track: "informational", // 视频没有音轨（FS-11.7）
} as const;

export type MediaFailureCode = keyof typeof MEDIA_FAILURES;
export type MediaFailureClass = (typeof MEDIA_FAILURES)[MediaFailureCode];

export class MediaFailure extends Error {
  constructor(
    readonly code: MediaFailureCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MediaFailure";
  }
}

export function classifyMediaFailure(code: string | null): MediaFailureClass | "unknown" {
  return code !== null && Object.hasOwn(MEDIA_FAILURES, code) ? MEDIA_FAILURES[code as MediaFailureCode] : "unknown";
}

/** 同一个 URL 还值得再试一次（不含需要新地址的）。 */
export const isRetryableWithSameUrl = (code: string | null) => classifyMediaFailure(code) === "retryable";
