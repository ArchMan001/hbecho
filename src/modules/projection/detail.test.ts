import { describe, expect, it } from "vitest";
import type { DetailData } from "../provider-adapter";
import { mergeDetail, type SnapshotRow } from "./detail";

const seed = {
  title: "列表标题",
  tagText: "#话题",
  publishLocation: "上海",
  relatedSearchTerms: null,
  publishedAt: new Date(1000),
  returnedAuthorNamespaceCode: "douyin.user_id",
  returnedAuthorIdentifier: "A1",
  returnedAuthorName: "作者",
  durationValue: "10.000000",
  durationState: "value",
  playValue: null,
  playState: "unsupported",
  likeValue: 5n,
  likeState: "value",
  commentValue: 2n,
  commentState: "value",
  collectValue: null,
  collectState: "missing",
  shareValue: 1n,
  shareState: "value",
} as unknown as SnapshotRow;
const missing = { state: "missing" } as const;
const detail = (over: Partial<DetailData> = {}): DetailData => ({
  postId: { state: "value", value: "P" },
  platformEcho: missing,
  author: { namespace: "douyin.user_id", id: missing },
  authorName: missing,
  authorHomepage: missing,
  title: missing,
  tagText: missing,
  publishLocation: missing,
  relatedSearchTerms: missing,
  publishedAtMs: missing,
  metrics: { play: missing, like: missing, comment: missing, collect: missing, share: missing },
  durationSeconds: missing,
  coverCandidates: [],
  downloadCandidates: [],
  providerUpdatedAtMs: missing,
  ...over,
});

describe("详情合并（LaterValidValueWins）", () => {
  it("详情全缺失：种子里的有效值一个都不被擦除；列表播放数 unsupported 被详情的 missing 取代（详情确实支持播放数）", () => {
    const m = mergeDetail(seed, detail());
    expect(m).toMatchObject({ title: "列表标题", likeValue: 5n, likeState: "value", commentValue: 2n, shareValue: 1n, durationValue: "10.000000", publishedAt: new Date(1000), returnedAuthorIdentifier: "A1" });
    expect(m.playState).toBe("missing");
  });
  it("详情的有效值覆盖，含真实 0；显式 null / 非法不擦除先前有效值", () => {
    const m = mergeDetail(seed, detail({ metrics: { play: { state: "value", value: 0n }, like: { state: "explicit_null" }, comment: { state: "invalid", raw: "x" }, collect: { state: "value", value: 7n }, share: missing }, title: { state: "value", value: "详情标题" } }));
    expect(m).toMatchObject({ playState: "value", playValue: 0n, likeState: "value", likeValue: 5n, commentState: "value", commentValue: 2n, collectValue: 7n, title: "详情标题" });
  });
  it("小红书图文笔记 play_number=null → explicit_null，不是 0", () => {
    const m = mergeDetail(seed, detail({ metrics: { play: { state: "explicit_null" }, like: missing, comment: missing, collect: missing, share: missing } }));
    expect(m).toMatchObject({ playState: "explicit_null", playValue: null });
  });
  it("种子的值本身不是 value 时，后到的缺失 / null / 非法取代它（状态如实）", () => {
    const m = mergeDetail(seed, detail({ metrics: { play: missing, like: missing, comment: missing, collect: { state: "explicit_null" }, share: missing } }));
    expect(m).toMatchObject({ collectState: "explicit_null", collectValue: null });
  });
});
