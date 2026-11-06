import { describe, expect, it } from "vitest";
import { bytesOf, decodedData, envelope } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { decodeComments } from "./decode-comments";

const comments = (platform: Parameters<typeof decodeComments>[0], id: string) => decodedData(decodeComments(platform, loadFixtureBytes(id)));

describe("评论 post_comments_list", () => {
  it("抖音（raw4 C07）：20 条一级评论，has_more 为整数 1 归一为 true，游标是字符串 \"20\"，total=125 含回复", () => {
    const d = comments("douyin", "raw4.C07");
    expect(d.entries).toHaveLength(20);
    expect(d.returnedCount).toBe(20);
    expect(d.ignoredReplyCount).toBe(0);
    expect(d.hasMore).toEqual({ state: "value", value: true });
    expect(d.maxCursor).toEqual({ kind: "string", value: "20" });
    expect(d.total).toEqual({ state: "value", value: 125n });
    expect(d.entries[0]).toMatchObject({
      position: 0,
      id: { state: "value", value: "7692933835680744229" }, // 19 位评论 ID 按文本
      postId: { state: "value", value: "7676403385372904742" },
      authorId: { state: "value", value: "1905907340420250" },
      likeCount: { state: "value", value: 0n },
    });
  });
  it("回复与一级评论同数组、用 parent_id 区分（raw11）：回复被分流计数，不进入 entries，position 仍对应原数组", () => {
    const d = comments("douyin", "raw11.reply-count-sample2");
    expect(d.returnedCount).toBe(24);
    expect(d.ignoredReplyCount).toBe(4);
    expect(d.entries).toHaveLength(20);
    expect(d.entries.length + d.ignoredReplyCount).toBe(d.returnedCount);
    const positions = d.entries.map((e) => e.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(Math.max(...positions)).toBeGreaterThanOrEqual(20); // 回复混在中间，一级评论的位置不连续
  });
  it("小红书（raw9 A4）：total=28 但只返回 2 条、has_more=0 —— total 不等于可获取条数", () => {
    const d = comments("xiaohongshu", "raw9.A4.poll1");
    expect(d.entries).toHaveLength(2);
    expect(d.hasMore).toEqual({ state: "value", value: false });
    expect(d.total).toEqual({ state: "value", value: 28n });
    expect(d.maxCursor).toEqual({ kind: "string", value: "" });
  });
  it("total>0 而结果为空数组（raw6 C02）：解码为 0 条一级评论 + total=6，由上层记质量问题，不记为 0 条评论", () => {
    const d = comments("xiaohongshu", "raw6.C02");
    expect(d.entries).toEqual([]);
    expect(d.total).toEqual({ state: "value", value: 6n });
  });
  it("空评论（raw10 V4）：total=0、has_more=0", () => {
    const d = comments("douyin", "raw10.V4");
    expect(d.entries).toEqual([]);
    expect(d.total).toEqual({ state: "value", value: 0n });
    expect(d.hasMore).toEqual({ state: "value", value: false });
  });
  it("parent_id：缺失 / null / 空串是一级评论；非空串或数字是回复", () => {
    const item = (extra: string) => `{"id":"c${extra.length}","post_id":"p"${extra}}`;
    const d = decodedData(
      decodeComments(
        "douyin",
        envelope(
          "post_comments_list",
          `{"result":[${item("")},${item(',"parent_id":null')},${item(',"parent_id":""')},${item(',"parent_id":"c1"')},${item(',"parent_id":123')}],"has_more":0,"max_cursor":"","total":5}`,
        ),
      ),
    );
    expect(d.entries).toHaveLength(3);
    expect(d.ignoredReplyCount).toBe(2);
    expect(d.returnedCount).toBe(5);
  });
  it("has_more 的 0 / 1 / 布尔 / 缺失 / 非法分别归一；max_cursor 的整数、字符串、缺失、no_more 不互转", () => {
    const run = (tail: string) => decodedData(decodeComments("douyin", envelope("post_comments_list", `{"result":[]${tail}}`)));
    expect(run(',"has_more":1').hasMore).toEqual({ state: "value", value: true });
    expect(run(',"has_more":0').hasMore).toEqual({ state: "value", value: false });
    expect(run(',"has_more":true').hasMore).toEqual({ state: "value", value: true });
    expect(run("").hasMore).toEqual({ state: "missing" });
    expect(run(',"has_more":2').hasMore).toEqual({ state: "invalid", raw: "2" });
    expect(run(',"max_cursor":40').maxCursor).toEqual({ kind: "integer", lexeme: "40" });
    expect(run(',"max_cursor":"40"').maxCursor).toEqual({ kind: "string", value: "40" });
    expect(run("").maxCursor).toEqual({ kind: "absent" });
    expect(run(',"max_cursor":"no_more"').maxCursor).toEqual({ kind: "no_more" });
  });
  it("result 不是数组是 schema 漂移，不能当成「没有评论」；非对象条目保留为 invalid，不被悄悄丢弃", () => {
    expect(decodeComments("douyin", envelope("post_comments_list", '{"result":null}'))).toMatchObject({ outcome: "schema_drift", issues: ["result_not_array"] });
    const d = decodedData(decodeComments("douyin", envelope("post_comments_list", '{"result":[5,{"id":"c1"}],"has_more":0}')));
    expect(d.entries).toHaveLength(2);
    expect(d.entries[0]!.id.state).toBe("invalid");
    expect(d.entries[1]!.id).toEqual({ state: "value", value: "c1" });
  });
  it("任务未成功 / 非 JSON：分别报告", () => {
    expect(decodeComments("douyin", envelope("post_comments_list", "null", { status: "failed" }))).toMatchObject({ outcome: "not_succeeded" });
    expect(decodeComments("douyin", bytesOf("<html>"))).toMatchObject({ outcome: "schema_drift" });
  });
});
