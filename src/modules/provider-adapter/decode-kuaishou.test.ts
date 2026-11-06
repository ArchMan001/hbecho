import { describe, expect, it } from "vitest";
import { decodedData, envelope } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { decodeProfile } from "./decode-profile";
import { decodeVideoList } from "./decode-video-list";

describe("快手主页（raw12 K1）", () => {
  const d = decodedData(decodeProfile("kuaishou", loadFixtureBytes("raw12.K1")));
  it("账号标识在 kuaishou.user_id，原文保留", () => {
    expect(d.account).toEqual({ namespace: "kuaishou.user_id", id: { state: "value", value: "3xcqkweabmmz6pk" } });
  });
  it("12 个字段：计数取 *_number，*_count 是字符串也不影响；没有位置", () => {
    expect(d.followerCount).toEqual({ state: "value", value: 209n });
    expect(d.followingCount).toEqual({ state: "value", value: 271n });
    expect(d.likeCount).toEqual({ state: "value", value: 917n });
    expect(d.postCount).toEqual({ state: "value", value: 23n });
    expect(d.location).toEqual({ state: "missing" });
  });
  it("没有头像、背景：不臆造媒资候选（FS-7.5）", () => {
    expect(d.mediaCandidates).toEqual([]);
  });
});

describe("快手列表", () => {
  it("K3：20 条，作者都在 kuaishou.user_id，没有第二标识；has_more=true 但 max_cursor 是 no_more 哨兵 → 游标异常，不是字符串游标", () => {
    const d = decodedData(decodeVideoList("kuaishou", loadFixtureBytes("raw12.K3")));
    expect(d.entries).toHaveLength(20);
    expect(new Set(d.entries.map((e) => e.author.namespace))).toEqual(new Set(["kuaishou.user_id"]));
    expect(new Set(d.entries.map((e) => e.authorSecUid))).toEqual(new Set([null]));
    expect(d.hasMore).toEqual({ state: "value", value: true });
    expect(d.maxCursor).toEqual({ kind: "no_more" });
  });
  it("K6：空列表 + no_more + has_more=true（等价于空窗口的输入）", () => {
    const d = decodedData(decodeVideoList("kuaishou", loadFixtureBytes("raw12.K6")));
    expect(d.entries).toEqual([]);
    expect(d.maxCursor).toEqual({ kind: "no_more" });
  });
  it("L3 / L4：科学计数法游标按字符串原样保真，不转数字", () => {
    const l3 = decodedData(decodeVideoList("kuaishou", loadFixtureBytes("raw13.L3")));
    const l4 = decodedData(decodeVideoList("kuaishou", loadFixtureBytes("raw13.L4")));
    expect(l3.entries).toHaveLength(23); // 整页处理：不按 20 截断
    expect(l3.maxCursor).toEqual({ kind: "string", value: "1.785394950371E12" });
    expect(l4.entries).toHaveLength(20);
    expect(l4.maxCursor).toEqual({ kind: "string", value: "1.779437949568E12" });
  });
  it("条目：视频、单值封面、时长保留小数原文；列表播放数一律 unsupported（FS-6.6，播放数以详情为准）", () => {
    const e = decodedData(decodeVideoList("kuaishou", loadFixtureBytes("raw12.K3"))).entries[0]!;
    expect(e.contentKind).toBe("video");
    expect(e.cover.selection).toBe("single_string");
    expect(e.durationSeconds).toEqual({ state: "value", value: "136.022" });
    expect(e.metrics.play).toEqual({ state: "unsupported" });
    expect(e.publishedAtMs).toEqual({ state: "value", value: 1737285504978n });
  });
  it("抖音 / 小红书的 \"no_more\" 之外的字符串游标不受影响；字符串 no_more 在任何平台都不是可回发游标", () => {
    const d = decodedData(decodeVideoList("xiaohongshu", envelope("user_video_list", '{"result":[],"has_more":true,"max_cursor":"6a5098aa000000001603fb07"}')));
    expect(d.maxCursor).toEqual({ kind: "string", value: "6a5098aa000000001603fb07" });
    const n = decodedData(decodeVideoList("douyin", envelope("user_video_list", '{"result":[],"has_more":true,"max_cursor":"no_more"}')));
    expect(n.maxCursor).toEqual({ kind: "no_more" });
  });
});
