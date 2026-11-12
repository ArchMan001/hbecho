import { describe, expect, it } from "vitest";
import { CAPABILITY_VERSIONS, CATALOG, DEFAULT_ENABLED_CAPABILITIES, capabilityOf, parseEnabledCapabilities, platformSignals, requireSignal, versionOf } from "./catalog";

// 独立转写自 requirements SG-1 的 12 项（不从 catalog.ts 派生）
const SG1_KEYS = [
  "text.title_normalized",
  "text.body_normalized",
  "text.hashtags",
  "content.cover_template_score",
  "content.cover_element_score",
  "content.asr_text",
  "content.asr_judgement",
  "account.bg_template_score",
  "account.bg_element_score",
  "account.avatar_template_score",
  "account.avatar_element_score",
  "comment.text_normalized",
];

describe("信号目录（SG-1）", () => {
  it("键集合与 requirements 逐项相等，没有重复", () => {
    expect(CATALOG.map((e) => e.key).sort()).toEqual([...SG1_KEYS].sort());
    expect(new Set(CATALOG.map((e) => e.key)).size).toBe(12);
  });
  it("没有 OCR、vision_*、ai_judgement 与聚合比率", () => {
    for (const e of CATALOG) expect(e.key).not.toMatch(/ocr|vision_|ai_judgement|ratio|rate/);
  });
  it("存储位置与成本档自洽：特征行类是 0 档，结果行类 ≥ 1 档", () => {
    for (const e of CATALOG) expect(e.storage === "feature_row" ? e.costTier === 0 : e.costTier >= 1).toBe(true);
  });
  it("platformSignals：快手没有 account.* 与 comment.*；小红书没有 account.*", () => {
    const ks = platformSignals("kuaishou");
    expect(ks.filter((k) => k.startsWith("account.") || k.startsWith("comment."))).toEqual([]);
    expect(ks).toContain("content.cover_template_score");
    // 快手列表从不返回正文（text/fields.ts 的 fixture 依据）：正文信号对快手不可得，标题与话题可得
    expect(ks).not.toContain("text.body_normalized");
    expect(ks).toEqual(expect.arrayContaining(["text.title_normalized", "text.hashtags"]));
    const xhs = platformSignals("xiaohongshu");
    expect(xhs.filter((k) => k.startsWith("account."))).toEqual([]);
    expect(xhs).toContain("comment.text_normalized");
    expect(platformSignals("douyin")).toHaveLength(12);
    expect(platformSignals("xiaohongshu")).toContain("text.body_normalized");
    expect(platformSignals("weibo")).toEqual([]);
  });
  it("目录外的信号键一律 signal_unregistered，包括原型链上的名字", () => {
    for (const k of ["content.cover_ocr_text", "", "toString", "__proto__", "constructor"]) {
      expect(() => requireSignal(k), k).toThrowError(expect.objectContaining({ category: "input", code: "signal_unregistered" }));
    }
    expect(requireSignal("text.hashtags").object).toBe("content");
  });
  it("话题的能力标识含平台，三个平台互不相同；其余信号的标识不含平台", () => {
    const tags = requireSignal("text.hashtags");
    expect(["douyin", "xiaohongshu", "kuaishou"].map((p) => capabilityOf(tags, p))).toEqual(["text.hashtags.douyin", "text.hashtags.xiaohongshu", "text.hashtags.kuaishou"]);
    expect(capabilityOf(requireSignal("text.title_normalized"), "douyin")).toBe("text.normalize");
  });
  it("目录里每个信号在每个可得平台上的能力标识都有版本", () => {
    for (const e of CATALOG) for (const p of e.platforms) expect(versionOf(capabilityOf(e, p)), `${e.key}@${p}`).toBeGreaterThan(0);
    expect(() => versionOf("text.hashtags")).toThrowError(expect.objectContaining({ code: "capability_unregistered" }));
    expect(() => versionOf("toString")).toThrowError(expect.objectContaining({ code: "capability_unregistered" }));
  });
  it("版本表里没有目录用不到的能力（避免启用集里能写一个什么都不对应的标识）", () => {
    const used = new Set(CATALOG.flatMap((e) => e.platforms.map((p) => capabilityOf(e, p))));
    expect([...used].sort()).toEqual(Object.keys(CAPABILITY_VERSIONS).sort());
  });
});

describe("启用集（SG-15）", () => {
  it("缺省或空白：只有文本类", () => {
    for (const raw of [undefined, "", "  "]) expect([...parseEnabledCapabilities(raw)].sort()).toEqual([...DEFAULT_ENABLED_CAPABILITIES].sort());
    for (const id of DEFAULT_ENABLED_CAPABILITIES) expect(id).toMatch(/^text\./);
  });
  it("显式写出的集合就是全集，不在缺省之上叠加", () => {
    expect([...parseEnabledCapabilities(" text.normalize , image.template ")]).toEqual(["text.normalize", "image.template"]);
  });
  it("含目录外的能力标识：启动失败并点名", () => {
    expect(() => parseEnabledCapabilities("text.normalize,image.ocr,toString")).toThrowError(
      expect.objectContaining({ category: "configuration", code: "enabled_unknown_capability", message: expect.stringContaining("image.ocr、toString") }),
    );
  });
});
