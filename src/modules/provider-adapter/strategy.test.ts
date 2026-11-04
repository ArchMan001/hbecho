import { describe, expect, it } from "vitest";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { FixtureTransport } from "../../../tests/harness/fixture-transport";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { UnsupportedCapabilityError, capabilityGate } from "./capability";
import { decodeProfile } from "./decode-profile";
import { decodeVideoList } from "./decode-video-list";
import { classifyLocator } from "./locator";
import { buildRequest } from "./request";
import { MAX_RESOLVE_ATTEMPTS, SUCCESS_CALL_PLAN, afterProfileAttempt } from "./strategy";

const DY_SHARE = "9- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/MPOAlEqWpec/ 1@3.com :1pm";

describe("单一解析策略（R3.10）", () => {
  it("成功路径固定为主页 1 次 + 列表 1 页", () => {
    expect(SUCCESS_CALL_PLAN).toEqual(["media_user_info", "user_video_list"]);
  });

  it("用 fixture transport 走一遍成功路径：恰好 2 次供应商调用，均先过 capability gate", async () => {
    const t = new FixtureTransport();
    t.register({ path: "/openapi/v1/media_user_info", query: { async: "false" } }, {
      httpStatus: 200,
      body: loadFixtureBytes("raw3.douyin.media_user_info"),
    });
    t.register({ path: "/openapi/v1/user_video_list", query: { async: "false" } }, {
      httpStatus: 200,
      body: loadFixtureBytes("raw3.douyin.user_video_list"),
    });

    const decision = classifyLocator(DY_SHARE);
    if (decision.action !== "send") throw new Error("应发送");

    const run = async () => {
      for (const action of SUCCESS_CALL_PLAN) {
        capabilityGate.require({ platform: "douyin", action, mode: "synchronous", environment: "test" });
        const res = await t.send(buildRequest({ action, mode: "synchronous", locator: decision.cleaned }));
        const bytes = res.body;
        if (action === "media_user_info") {
          expect(decodedData(decodeProfile("douyin", bytes)).account.id).toEqual({ state: "value", value: "HITACHI1" });
        } else {
          expect(decodedData(decodeVideoList("douyin", bytes)).entries).toHaveLength(20);
        }
      }
    };
    await run();
    expect(t.calls).toHaveLength(2);
    expect(t.calls.map((c) => c.request.path)).toEqual(["/openapi/v1/media_user_info", "/openapi/v1/user_video_list"]);
    // 发出的 url 是清洗后的值
    expect(JSON.parse(new TextDecoder().decode(t.calls[0]!.request.body!)).url).toBe(decision.cleaned);
  });

  it("capability 不通过时不发请求：异步列表被拒，transport 调用数为 0（无付费调用）", async () => {
    const t = new FixtureTransport();
    expect(() =>
      capabilityGate.require({ platform: "douyin", action: "user_video_list", mode: "asynchronous", environment: "test" }),
    ).toThrow(UnsupportedCapabilityError);
    expect(t.calls).toHaveLength(0);
    expect(t.rejected).toHaveLength(0);
  });
});

describe("最多三次解析 = 对 RESULT_VALIDATION_FAILED 的有界重试", () => {
  it("上限为 3", () => {
    expect(MAX_RESOLVE_ATTEMPTS).toBe(3);
  });

  it("成功即进入列表阶段，不再重试（第一个已验证 locator 之后停止）", () => {
    for (const attempt of [1, 2, 3]) expect(afterProfileAttempt(attempt, "decoded")).toEqual({ next: "proceed_to_list" });
  });

  it("前两次 RESULT_VALIDATION_FAILED 重试，第三次耗尽 → invalid_link 终态，不含任何身份字段", () => {
    expect(afterProfileAttempt(1, "result_validation_failed")).toEqual({ next: "retry", nextAttempt: 2 });
    expect(afterProfileAttempt(2, "result_validation_failed")).toEqual({ next: "retry", nextAttempt: 3 });
    const last = afterProfileAttempt(3, "result_validation_failed");
    expect(last).toEqual({ next: "terminal", entryOutcome: "invalid_link", attempts: 3 });
  });

  it("其他失败不在此处断言 invalid_link，交给失败分类策略（任务 3/8）", () => {
    expect(afterProfileAttempt(1, "other_failure")).toEqual({ next: "defer_to_failure_policy" });
  });

  it("尝试序号越界时抛出", () => {
    expect(() => afterProfileAttempt(0, "decoded")).toThrow(RangeError);
    expect(() => afterProfileAttempt(4, "decoded")).toThrow(RangeError);
  });
});
