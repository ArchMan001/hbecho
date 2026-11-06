import { describe, expect, it } from "vitest";
import { asyncApproved, effectiveMode } from "./mode-fallback";

const base = { configured: "synchronous", platform: "kuaishou", action: "media_user_info", environment: "test", attemptCount: 1, lastErrorCode: "transport_timeout", lastErrorDetail: null } as const;

describe("effectiveMode", () => {
  it("第 1 次尝试按配置；触发条件之后改异步", () => {
    expect(effectiveMode({ ...base, attemptCount: 0, lastErrorCode: null })).toBe("synchronous");
    for (const code of ["transport_timeout", "ambiguous_unresolved", "provider_validation_failed"]) expect(effectiveMode({ ...base, lastErrorCode: code })).toBe("asynchronous");
  });
  it("其它失败保持同步；上一次已经在用异步则保持异步（粘性）", () => {
    for (const code of ["rate_limited", "provider_server_error", "transport_failure", "profile_fields_missing"]) expect(effectiveMode({ ...base, lastErrorCode: code })).toBe("synchronous");
    expect(effectiveMode({ ...base, lastErrorCode: "rate_limited", lastErrorDetail: { mode_used: "asynchronous" } })).toBe("asynchronous");
    expect(effectiveMode({ ...base, lastErrorCode: "rate_limited", lastErrorDetail: { mode_used: "synchronous" } })).toBe("synchronous");
  });
  it("配置本来就是异步、列表 / 评论、异步没放行、production 都不改", () => {
    expect(effectiveMode({ ...base, configured: "asynchronous" })).toBe("asynchronous");
    expect(effectiveMode({ ...base, action: "user_video_list" })).toBe("synchronous");
    expect(effectiveMode({ ...base, action: "post_comments_list", platform: "douyin" })).toBe("synchronous");
    expect(effectiveMode({ ...base, environment: "production" })).toBe("synchronous");
  });
  it("详情也兜底（三平台异步详情都已放行）", () => {
    for (const platform of ["douyin", "xiaohongshu", "kuaishou"] as const) expect(effectiveMode({ ...base, platform, action: "media_stats_number" })).toBe("asynchronous");
  });
  it("asyncApproved 不抛异常", () => {
    expect(asyncApproved("douyin", "user_video_list", "test")).toBe(false);
    expect(asyncApproved("kuaishou", "media_stats_number", "test")).toBe(true);
  });
});
