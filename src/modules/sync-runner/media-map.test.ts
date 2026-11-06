import { describe, expect, it } from "vitest";
import { MEDIA_FAILURES, classifyMediaFailure, isRetryableWithSameUrl, type MediaFailureCode } from "../media-failure";
import { FAILURE_SPECS, specOf } from "./failure-map";
import { failureCodeOfMedia } from "./media-map";

describe("媒资失败 → 任务失败码", () => {
  const codes = Object.keys(MEDIA_FAILURES) as MediaFailureCode[];
  it("terminal 的每个原因都映射成不可重试的稳定失败码，不会走 media_download_failed 被重试到 dead", () => {
    for (const c of codes.filter((x) => classifyMediaFailure(x) === "terminal")) {
      const t = failureCodeOfMedia(c);
      expect(t, c).not.toBe("media_download_failed");
      expect(specOf(t).retry, c).toBe(false);
      expect(t in FAILURE_SPECS).toBe(true);
    }
  });
  it("retryable → 可重试；needs_fresh_url → media_source_expired（可重试，先重新取详情）；转换服务不可用单独一码", () => {
    for (const c of codes.filter((x) => classifyMediaFailure(x) === "retryable")) expect(specOf(failureCodeOfMedia(c)).retry, c).toBe(true);
    expect(failureCodeOfMedia("source_expired")).toBe("media_source_expired");
    expect(specOf("media_source_expired").retry).toBe(true);
    expect(failureCodeOfMedia("converter_unavailable")).toBe("converter_unavailable");
    expect(failureCodeOfMedia("timeout")).toBe("media_download_failed");
  });
  it("媒资失败不计入熔断（它们不调供应商）", () => {
    for (const c of codes.filter((x) => classifyMediaFailure(x) !== "informational")) expect(specOf(failureCodeOfMedia(c)).breaker, c).toBe(false);
  });
});

describe("informational 分类（no_audio_track）", () => {
  it("不是故障：终态、不重试（既不同 URL 重试也不要新地址）；不会被当作任务失败码", () => {
    expect(classifyMediaFailure("no_audio_track")).toBe("informational");
    expect(isRetryableWithSameUrl("no_audio_track")).toBe(false);
    expect(() => failureCodeOfMedia("no_audio_track")).toThrow();
  });
  it("未知码仍是 unknown；快手封面不可用是 terminal", () => {
    expect(classifyMediaFailure("mystery")).toBe("unknown");
    expect(classifyMediaFailure(null)).toBe("unknown");
    expect(classifyMediaFailure("cover_unavailable")).toBe("terminal");
  });
});
