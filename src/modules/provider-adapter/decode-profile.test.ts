import { describe, expect, it } from "vitest";
import { bytesOf, decodedData, envelope } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { ADAPTER_VERSION } from "./contract";
import { decodeProfile, isSuspectedEmptyProfile } from "./decode-profile";

describe("抖音 media_user_info fixture（raw3 HITACHI1）", () => {
  const outcome = decodeProfile("douyin", loadFixtureBytes("raw3.douyin.media_user_info"));

  it("账号标识是 douyin.user_id 命名空间下的原文 HITACHI1", () => {
    const d = decodedData(outcome);
    expect(d.account).toEqual({ namespace: "douyin.user_id", id: { state: "value", value: "HITACHI1" } });
  });

  it("记录 Adapter 版本、platform、task id 与 action 三元组（requested / expected / actual 分列）", () => {
    if (outcome.outcome !== "decoded") throw new Error("expected decoded");
    expect(outcome.adapterVersion).toBe(ADAPTER_VERSION);
    expect(outcome.platform).toBe("douyin");
    expect(outcome.taskId).toEqual({ state: "value", value: "6a954bef25f71e00016485f6" });
    expect(outcome.exchange).toEqual({
      requested: "media_user_info",
      expectedResponse: "media_user_info",
      actualResponse: { state: "value", value: "media_user_info" },
    });
  });

  it("计数优先取 *_number，真实值保留", () => {
    const d = decodedData(outcome);
    expect(d.followerCount).toEqual({ state: "value", value: 1181412n });
    expect(d.followingCount).toEqual({ state: "value", value: 16n });
    expect(d.likeCount).toEqual({ state: "value", value: 1500879n });
    expect(d.postCount).toEqual({ state: "value", value: 590n });
    expect(d.providerUpdatedAtMs).toEqual({ state: "value", value: 1788169202132n });
  });

  it("抖音形成头像与背景两个媒资候选（背景取 cover 字段）", () => {
    const d = decodedData(outcome);
    expect(d.mediaCandidates.map((m) => m.role)).toEqual(["avatar", "background"]);
    expect(d.mediaCandidates[0]!.url).toContain("aweme-avatar");
  });
});

describe("小红书 media_user_info fixture（raw3 日立中央空调）", () => {
  const outcome = decodeProfile("xiaohongshu", loadFixtureBytes("raw3.xiaohongshu.media_user_info"));

  it("profile ID 49328995493 落在 xiaohongshu.profile.user_id，原文保留", () => {
    const d = decodedData(outcome);
    expect(d.account).toEqual({
      namespace: "xiaohongshu.profile.user_id",
      id: { state: "value", value: "49328995493" },
    });
  });

  it("响应不返回头像与背景：不臆造媒资候选（R12.2）", () => {
    expect(decodedData(outcome).mediaCandidates).toEqual([]);
  });

  it("计数与 provider 时间", () => {
    const d = decodedData(outcome);
    expect(d.followerCount).toEqual({ state: "value", value: 77853n });
    expect(d.postCount).toEqual({ state: "value", value: 615n });
  });
});

describe("值状态与疑似空账号（R5.5、R19.2）", () => {
  const profile = (fields: string) =>
    envelope("media_user_info", `{"user_id":"u1","nickname":"n"${fields ? "," + fields : ""}}`);

  it("粉丝 0 且作品 0 为真实零 → 疑似空账号", () => {
    const d = decodedData(
      decodeProfile("douyin", profile('"follower_number":0,"post_number":0,"follower_count":"0","post_count":"0"')),
    );
    expect(d.followerCount).toEqual({ state: "value", value: 0n });
    expect(isSuspectedEmptyProfile(d)).toBe(true);
  });

  it("作品数缺失 / null / 非法 都不是疑似空账号，状态各自保留", () => {
    const missing = decodedData(decodeProfile("douyin", profile('"follower_number":0')));
    const nul = decodedData(decodeProfile("douyin", profile('"follower_number":0,"post_number":null')));
    const bad = decodedData(decodeProfile("douyin", profile('"follower_number":0,"post_number":"x"')));
    expect(missing.postCount).toEqual({ state: "missing" });
    expect(nul.postCount).toEqual({ state: "explicit_null" });
    expect(bad.postCount.state).toBe("invalid");
    for (const d of [missing, nul, bad]) expect(isSuspectedEmptyProfile(d)).toBe(false);
  });

  it("粉丝非 0 的 0 作品账号不是疑似空账号", () => {
    const d = decodedData(decodeProfile("douyin", profile('"follower_number":3,"post_number":0')));
    expect(isSuspectedEmptyProfile(d)).toBe(false);
  });

  it("超过 2^53 的数字型 user_id 以原文保留", () => {
    const bytes = envelope("media_user_info", '{"user_id":9007199254740993,"follower_number":1,"post_number":1}');
    const d = decodedData(decodeProfile("douyin", bytes));
    expect(d.account.id).toEqual({ state: "value", value: "9007199254740993" });
  });

  it("账号 ID 缺失时保留为 missing，不编造", () => {
    const d = decodedData(decodeProfile("douyin", envelope("media_user_info", '{"nickname":"n"}')));
    expect(d.account.id).toEqual({ state: "missing" });
  });
});

describe("异常响应的分类", () => {
  it("返回 action 与期望不一致：同时保留 expected 与 actual，归类 invalid_response（任务 1 合同）", () => {
    const out = decodeProfile("douyin", envelope("media_stats", "{}"));
    expect(out).toMatchObject({
      outcome: "invalid_response",
      reason: "action_mismatch",
      exchange: {
        requested: "media_user_info",
        expectedResponse: "media_user_info",
        actualResponse: { state: "value", value: "media_stats" },
      },
    });
  });

  it("返回 action 缺失：同样 invalid_response，actual 为 missing", () => {
    const out = decodeProfile(
      "douyin",
      bytesOf('{"code":0,"data":{"task_id":"t","status":"succeeded","result":{"user_id":"u"}}}'),
    );
    expect(out).toMatchObject({ outcome: "invalid_response", exchange: { actualResponse: { state: "missing" } } });
  });

  it("任务未成功：保留 task 状态与供应商错误码，不当作空主页", () => {
    const out = decodeProfile(
      "xiaohongshu",
      bytesOf(
        '{"code":0,"data":{"task_id":"t","action":"media_user_info","status":"failed","result":null,"error":{"code":"RESULT_VALIDATION_FAILED","message":"m"}}}',
      ),
    );
    expect(out).toMatchObject({
      outcome: "not_succeeded",
      taskStatus: "failed",
      error: { code: "RESULT_VALIDATION_FAILED", message: "m" },
    });
  });

  it("非 JSON / 非法 UTF-8 / 缺 data / succeeded 却无 result：schema_drift，不产出任何账号字段", () => {
    for (const bytes of [
      bytesOf("not json"),
      new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      bytesOf('{"code":0}'),
      bytesOf('{"code":0,"data":{"action":"media_user_info","status":"succeeded","result":null}}'),
      bytesOf('{"code":0,"data":{"action":"media_user_info","status":"succeeded","result":[]}}'),
    ]) {
      const out = decodeProfile("douyin", bytes);
      expect(out.outcome).toBe("schema_drift");
      expect(out).not.toHaveProperty("data");
    }
  });
});
