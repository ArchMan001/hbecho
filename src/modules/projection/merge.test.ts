// 同批次合并（R9.4、R9.5）：重复条目全部处理，后到的有效值（含真实 0）覆盖，后到的非有效态不擦除已有有效值。
import { describe, expect, it } from "vitest";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { decodeVideoList } from "../provider-adapter";
import { mergeEntries } from "./merge";

const merged = (entries: SyntheticEntry[]) => mergeEntries(decodedData(decodeVideoList("douyin", listBytes(entries))).entries);

describe("mergeEntries", () => {
  it("同一内容身份出现多次：每个条目都被处理，只形成一个内容，记录首次位置与全部重复位置", () => {
    const r = merged([{ postId: "a" }, { postId: "b" }, { postId: "a" }, { postId: "a" }]);
    expect(r.merged.map((m) => [m.platformContentId, m.firstPosition, m.positions])).toEqual([
      ["a", 0, [0, 2, 3]],
      ["b", 1, [1]],
    ]);
    expect(r.duplicates).toEqual([{ platformContentId: "a", positions: [0, 2, 3] }]);
    expect(r.unprojectable).toEqual([]);
  });

  it("后到的有效值覆盖先到的有效值，真实 0 也覆盖", () => {
    const r = merged([
      { postId: "a", like: 5, title: "旧" },
      { postId: "a", like: 0, title: "新" },
    ]);
    const e = r.merged[0]!.entry;
    expect(e.metrics.like).toEqual({ state: "value", value: 0n });
    expect(e.title).toEqual({ state: "value", value: "新" });
  });

  it("后到的 missing / explicit_null / invalid 不擦除已有有效值", () => {
    const r = merged([
      { postId: "a", like: 5, title: "有标题", createdMs: 1788169004000 },
      { postId: "a", like: "absent", title: null, createdMs: null },
      { postId: "a", like: null, title: null },
    ]);
    const e = r.merged[0]!.entry;
    expect(e.metrics.like).toEqual({ state: "value", value: 5n });
    expect(e.title).toEqual({ state: "value", value: "有标题" });
    expect(e.publishedAtMs).toEqual({ state: "value", value: 1788169004000n });
  });

  it("先到的非有效态会被后到的有效值替换", () => {
    const r = merged([
      { postId: "a", like: null, title: null },
      { postId: "a", like: 7, title: "后到" },
    ]);
    const e = r.merged[0]!.entry;
    expect(e.metrics.like).toEqual({ state: "value", value: 7n });
    expect(e.title).toEqual({ state: "value", value: "后到" });
  });

  it("列表播放数恒为 unsupported，合并后仍是 unsupported（不会变成 0 或 missing）", () => {
    const r = merged([{ postId: "a" }, { postId: "a" }]);
    expect(r.merged[0]!.entry.metrics.play).toEqual({ state: "unsupported" });
  });

  it("content_kind：后到的 unknown 不覆盖已推断的形态；不输出 mixed", () => {
    const r = merged([{ postId: "a", video: true }, { postId: "a", video: false, title: null }]); // 后者：无视频、无文本 → unknown
    expect(r.merged[0]!.entry.contentKind).toBe("video");
    expect(new Set(merged([{ postId: "x" }, { postId: "y", video: false }]).merged.map((m) => m.entry.contentKind)).has("mixed" as never)).toBe(false);
  });

  it("没有可用 post_id 的条目：不形成内容，但计入「已处理」（unprojectable），不阻塞其余条目", () => {
    const r = merged([{ postId: null }, { postId: "a" }]);
    expect(r.merged.map((m) => m.platformContentId)).toEqual(["a"]);
    expect(r.unprojectable).toEqual([{ position: 0, reason: "post_id_missing" }]);
  });

  it("超长的 post_id（超过 2048 字符）不可投影，而不是让整页写入失败", () => {
    const r = merged([{ postId: "x".repeat(2049) }, { postId: "a" }]);
    expect(r.merged).toHaveLength(1);
    expect(r.unprojectable).toEqual([{ position: 0, reason: "post_id_too_long" }]);
  });

  it("外部 ID 按原文比较：大小写不同、前导零不同是不同内容", () => {
    expect(merged([{ postId: "AbC" }, { postId: "abc" }, { postId: "007" }, { postId: "7" }]).merged).toHaveLength(4);
  });

  it("21 条一页（超过 20）全部保留，没有截断", () => {
    const entries = Array.from({ length: 21 }, (_, i) => ({ postId: `p${i}` }));
    expect(merged(entries).merged).toHaveLength(21);
  });
});
