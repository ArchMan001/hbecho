// 媒资失败码 → 任务失败码（task 7）。media-failure 判为 terminal 的原因必须映射成不可重试的稳定失败码，
// retryable 才走 media_download_failed / converter_unavailable，needs_fresh_url 走 media_source_expired（先重新取详情）。
import { classifyMediaFailure, type MediaFailureCode } from "../media-failure";
import type { FailureCode } from "./failure-map";

const TERMINAL: Partial<Record<MediaFailureCode, FailureCode>> = {
  too_large: "media_too_large",
  url_rejected: "media_url_rejected",
  content_type_not_allowed: "media_content_type_not_allowed",
  unsupported_format: "media_unsupported_format",
  too_many_redirects: "media_too_many_redirects",
  no_source_locator: "media_no_source",
  convert_failed: "media_convert_failed",
  cover_unavailable: "media_cover_unavailable",
};

export function failureCodeOfMedia(code: MediaFailureCode): FailureCode {
  switch (classifyMediaFailure(code)) {
    case "needs_fresh_url":
      return "media_source_expired";
    case "retryable":
      return code === "converter_unavailable" ? "converter_unavailable" : "media_download_failed";
    case "terminal":
      return TERMINAL[code] ?? "media_download_failed";
    default:
      // informational（no_audio_track）不是任务失败，调用方不应把它当失败码用；unknown 保守走稳定失败
      throw new Error(`媒资失败码 ${code} 没有任务失败码`);
  }
}
