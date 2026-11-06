import { describe, expect, it } from "vitest";
import { bytesOf, decodedData, envelope } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { decodeDetail, expandCandidates } from "./decode-detail";

const detail = (platform: Parameters<typeof decodeDetail>[0], id: string) => decodedData(decodeDetail(platform, loadFixtureBytes(id)));

describe("详情 media_stats_number（请求 / 响应动作分列）", () => {
  it("请求 media_stats_number，期望并实际得到 media_stats", () => {
    const o = decodeDetail("douyin", loadFixtureBytes("raw4.C05"));
    if (o.outcome !== "decoded") throw new Error("expected decoded");
    expect(o.exchange).toEqual({
      requested: "media_stats_number",
      expectedResponse: "media_stats",
      actualResponse: { state: "value", value: "media_stats" },
    });
  });
  it("响应动作不是 media_stats → invalid_response，不解码", () => {
    const o = decodeDetail("douyin", envelope("post_comments_list", "{}"));
    expect(o).toMatchObject({ outcome: "invalid_response", reason: "action_mismatch" });
  });
  it("抖音（raw4 C05）：*_count 全 null、*_number 有值 → 取 *_number；作者是返回作者，不是被采集账号", () => {
    const d = detail("douyin", "raw4.C05");
    expect(d.metrics).toEqual({
      play: { state: "value", value: 73897n },
      like: { state: "value", value: 2921n },
      comment: { state: "value", value: 125n },
      collect: { state: "value", value: 1363n },
      share: { state: "value", value: 76n },
    });
    expect(d.durationSeconds).toEqual({ state: "value", value: "15" });
    expect(d.author).toEqual({ namespace: "douyin.user_id", id: { state: "value", value: "HITACHI1" } });
    expect(d.authorHomepage.state).toBe("value");
    expect(d.postId).toEqual({ state: "value", value: "7676403385372904742" });
    expect(d.publishedAtMs).toEqual({ state: "value", value: 1787301946000n });
  });
  it("related_search_str 按换行拆成搜索词；cover 与 download_urls 展开为候选集并保留全部", () => {
    const d = detail("douyin", "raw4.C05");
    expect(d.relatedSearchTerms.state === "value" && d.relatedSearchTerms.value.length).toBe(10);
    expect(d.coverCandidates.length).toBeGreaterThanOrEqual(1);
    expect(d.downloadCandidates.map((u) => new URL(u).hostname)).toEqual(["v5-hl-zenl-ov.zjcdn.com", "api-play.amemv.com"]);
  });
  it("小红书图文笔记：play_number=null 保持 explicit_null，不是 0；作者在 xiaohongshu.content.user_id", () => {
    const d = detail("xiaohongshu", "raw4.C06");
    expect(d.metrics.play).toEqual({ state: "explicit_null" });
    expect(d.metrics.like).toEqual({ state: "value", value: 71n });
    expect(d.durationSeconds).toEqual({ state: "value", value: "0" }); // 供应商原值，不当作缺失
    expect(d.author.namespace).toBe("xiaohongshu.content.user_id");
    expect(d.publishLocation).toEqual({ state: "missing" });
    expect(d.relatedSearchTerms).toEqual({ state: "missing" });
  });
  it("快手（raw13 V1）：play_number 有值，作者在 kuaishou.user_id，download_urls 一条", () => {
    const d = detail("kuaishou", "raw13.V1");
    expect(d.metrics.play).toEqual({ state: "value", value: 805625n });
    expect(d.author).toEqual({ namespace: "kuaishou.user_id", id: { state: "value", value: "3xgxa5ihm6dke52" } });
    expect(d.platformEcho).toEqual({ state: "value", value: "kuaishou" });
    expect(d.downloadCandidates).toHaveLength(1);
  });
  it("异步轮询得到的成功响应（raw9 A5 poll1）与同步解码结果同形", () => {
    const d = detail("douyin", "raw9.A5.poll1");
    expect(d.metrics.play).toEqual({ state: "value", value: 2060n });
    expect(d.platformEcho).toEqual({ state: "value", value: "douyin" });
  });
  it("*_number 缺失时回退 *_count；两者都无效时按 invalid > explicit_null > missing 取最强，真实 0 不被覆盖", () => {
    const d = decodedData(
      decodeDetail(
        "douyin",
        envelope(
          "media_stats",
          '{"post_id":"p1","play_count":7,"like_number":0,"like_count":9,"comment_number":"x","comment_count":null,"collect_number":null,"share_count":null}',
        ),
      ),
    );
    expect(d.metrics.play).toEqual({ state: "value", value: 7n });
    expect(d.metrics.like).toEqual({ state: "value", value: 0n });
    expect(d.metrics.comment).toEqual({ state: "invalid", raw: '"x"' });
    expect(d.metrics.collect).toEqual({ state: "explicit_null" });
    expect(d.metrics.share).toEqual({ state: "explicit_null" });
  });
  it("*_number 是显式 null 时不回退到 *_count 的占位 0：explicit_null 不能变成真实 0", () => {
    const d = decodedData(decodeDetail("douyin", envelope("media_stats", '{"post_id":"p1","play_number":null,"play_count":0,"like_number":5,"like_count":0,"share_number":"x","share_count":3}')));
    expect(d.metrics.play).toEqual({ state: "explicit_null" });
    expect(d.metrics.like).toEqual({ state: "value", value: 5n });
    expect(d.metrics.share).toEqual({ state: "value", value: 3n }); // 优先字段非法 → 回退到有效的 *_count
  });
  it("19 位内容 ID 与作者 ID 按文本保真，整数 token 取原文", () => {
    const d = decodedData(decodeDetail("douyin", envelope("media_stats", '{"post_id":7676403385372904742,"user_id":"007"}')));
    expect(d.postId).toEqual({ state: "value", value: "7676403385372904742" });
    expect(d.author.id).toEqual({ state: "value", value: "007" });
  });
  it("未知新增字段被忽略；任务未成功 / result 漂移分别报告，不伪装成空详情", () => {
    expect(decodedData(decodeDetail("douyin", envelope("media_stats", '{"post_id":"p","brand_new_field":{"a":1}}'))).postId.state).toBe("value");
    expect(decodeDetail("douyin", envelope("media_stats", "null", { status: "failed" }))).toMatchObject({ outcome: "not_succeeded", taskStatus: "failed" });
    expect(decodeDetail("douyin", envelope("media_stats", "null"))).toMatchObject({ outcome: "schema_drift", issues: ["result_not_object"] });
    expect(decodeDetail("douyin", bytesOf("not json"))).toMatchObject({ outcome: "schema_drift" });
  });
});

describe("expandCandidates", () => {
  it.each([
    ["单个 URL 字符串", "http://a/x", ["http://a/x"]],
    ["换行分隔，去空行与首尾空白", " http://a/x \r\n\nhttp://b/y\n", ["http://a/x", "http://b/y"]],
    ["重复项保序去重", "http://a/x\nhttp://a/x", ["http://a/x"]],
    ["数组（列表形态）只取字符串", ["http://a/x", 1, "", "http://b/y"], ["http://a/x", "http://b/y"]],
    ["其他类型", { a: 1 }, []],
    ["未定义", undefined, []],
  ] as const)("%s", (_n, input, expected) => {
    expect(expandCandidates(input as never)).toEqual(expected);
  });
});
