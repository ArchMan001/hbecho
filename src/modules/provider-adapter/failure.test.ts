import { describe, expect, it } from "vitest";
import { bytesOf } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { classifyResponse, decideRetry, profileAttemptOutcomeOf } from "./failure";
import { peekResponseMeta } from "./peek";

const classify = (httpStatus: number, bytes: Uint8Array, expectedAction = "media_user_info") =>
  classifyResponse({ httpStatus, expectedAction, meta: peekResponseMeta(bytes) });

describe("失败分类与重试策略（R13.9、R14.1、R14.3）", () => {
  it("成功响应：无失败、不重试", () => {
    expect(classify(200, loadFixtureBytes("raw3.douyin.media_user_info"))).toMatchObject({ category: "none", retry: "none", outcome: "succeeded" });
  });

  it("异步提交 202 + running 是成功的调用（任务仍在运行）", () => {
    expect(classify(202, loadFixtureBytes("raw4.C09.submit"))).toMatchObject({ category: "none", outcome: "succeeded" });
  });

  it("HTTP 400 INVALID_REQUEST：认证与输入无法区分 → provider_request_rejected，不重试，也不断言是输入错误", () => {
    expect(classify(400, loadFixtureBytes("raw7.C19.http400"))).toMatchObject({
      category: "provider_request_rejected",
      retry: "none",
      outcome: "http_error",
    });
  });

  it("HTTP 500 RESULT_VALIDATION_FAILED：有界重试，首次响应不断言账号不存在", () => {
    const c = classify(500, loadFixtureBytes("raw7.C20.http500"));
    expect(c).toMatchObject({ category: "provider_validation_failed", retry: "bounded", outcome: "http_error", businessMeaning: "undetermined" });
  });

  it("200 但 result 为 null：另一类（间歇性 result:null），同样有界重试，但不与 500 混为一类", () => {
    const c = classify(200, bytesOf('{"code":0,"data":{"task_id":"t","action":"media_user_info","status":"succeeded","result":null}}'));
    expect(c).toMatchObject({ category: "provider_null_result", retry: "bounded", outcome: "succeeded" });
  });

  it("异步轮询里任务失败（HTTP 200 + failed + RESULT_VALIDATION_FAILED）→ provider_error，有界重试", () => {
    expect(classify(200, loadFixtureBytes("raw4.C10.poll1"), "user_video_list")).toMatchObject({
      category: "provider_task_failed",
      retry: "bounded",
      outcome: "provider_error",
    });
    const other = classify(200, bytesOf('{"code":0,"data":{"action":"media_user_info","status":"failed","error":{"code":"SOMETHING_ELSE"}}}'));
    expect(other).toMatchObject({ category: "provider_task_failed", retry: "none" });
  });

  it("401/403 → provider_auth；429 → rate_limited（有界延迟重试）；其他 5xx → provider_server_error；其他 4xx → rejected", () => {
    const empty = bytesOf("{}");
    expect(classify(401, empty)).toMatchObject({ category: "provider_auth", retry: "none" });
    expect(classify(403, empty)).toMatchObject({ category: "provider_auth", retry: "none" });
    expect(classify(429, empty)).toMatchObject({ category: "rate_limited", retry: "bounded" });
    expect(classify(502, empty)).toMatchObject({ category: "provider_server_error", retry: "bounded" });
    expect(classify(503, bytesOf("<html>"))).toMatchObject({ category: "provider_server_error", retry: "bounded" });
    expect(classify(404, empty)).toMatchObject({ category: "provider_request_rejected", retry: "none" });
  });

  it("返回 action 与期望不一致 → invalid_response，不重试（保留两值由调用记录负责）", () => {
    const c = classify(200, bytesOf('{"code":0,"data":{"task_id":"t","action":"media_stats","status":"succeeded","result":{}}}'));
    expect(c).toMatchObject({ category: "invalid_response", retry: "none", outcome: "invalid_response" });
  });

  it("200 但无法解析 → invalid_response（契约漂移，保留原始字节可重放）", () => {
    expect(classify(200, bytesOf("<html>oops</html>"))).toMatchObject({ category: "invalid_response", retry: "none", outcome: "invalid_response" });
  });
});

describe("decideRetry：有界", () => {
  const bounded = { category: "provider_validation_failed", retry: "bounded", outcome: "http_error", businessMeaning: "undetermined" } as const;

  it("未达上限 → 重试并给出下一次序号；达到上限 → 不再重试且标记已耗尽", () => {
    expect(decideRetry(bounded, 1, 3)).toEqual({ retry: true, nextAttempt: 2 });
    expect(decideRetry(bounded, 2, 3)).toEqual({ retry: true, nextAttempt: 3 });
    expect(decideRetry(bounded, 3, 3)).toEqual({ retry: false, exhausted: true });
  });

  it("不可重试的类别不会被标成『耗尽』", () => {
    expect(decideRetry({ category: "provider_auth", retry: "none", outcome: "http_error", businessMeaning: "none" }, 1, 3)).toEqual({ retry: false, exhausted: false });
  });
});

describe("与单一解析策略衔接（任务 1 的 afterProfileAttempt）", () => {
  it("RESULT_VALIDATION_FAILED 与 result:null 算『校验失败』，成功算 decoded，其余交给失败策略", () => {
    expect(profileAttemptOutcomeOf({ category: "none", retry: "none", outcome: "succeeded", businessMeaning: "none" })).toBe("decoded");
    expect(profileAttemptOutcomeOf({ category: "provider_validation_failed", retry: "bounded", outcome: "http_error", businessMeaning: "undetermined" })).toBe("result_validation_failed");
    expect(profileAttemptOutcomeOf({ category: "provider_null_result", retry: "bounded", outcome: "succeeded", businessMeaning: "undetermined" })).toBe("result_validation_failed");
    expect(profileAttemptOutcomeOf({ category: "provider_task_failed", retry: "bounded", outcome: "provider_error", businessMeaning: "undetermined" })).toBe("result_validation_failed");
    expect(profileAttemptOutcomeOf({ category: "provider_task_failed", retry: "none", outcome: "provider_error", businessMeaning: "none" })).toBe("other_failure");
    expect(profileAttemptOutcomeOf({ category: "provider_auth", retry: "none", outcome: "http_error", businessMeaning: "none" })).toBe("other_failure");
    expect(profileAttemptOutcomeOf({ category: "rate_limited", retry: "bounded", outcome: "http_error", businessMeaning: "none" })).toBe("other_failure");
  });
});
