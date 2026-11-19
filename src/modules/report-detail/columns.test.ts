import { describe, expect, it } from "vitest";
import type { ConditionDesc } from "../judgement/config";
import { buildColumns, conditionHeaders, defaultName } from "./columns";

const C = (key: string, layer: ConditionDesc["layer"], kind: ConditionDesc["kind"], o: Partial<ConditionDesc> = {}): ConditionDesc => ({ key, layer, kind, target: null, subject: "content", alias: null, ...o });
const V3: ConditionDesc[] = [
  C("l1.0", 1, "text", { alias: "品牌词" }), C("l1.1", 1, "text"), C("l1.2", 1, "hashtags"), C("l1.3", 1, "hashtags"), C("l1.4", 1, "duration"),
  C("l2.a1", 2, "whole_image", { target: "cover", alias: "封面模板" }), C("l2.a2", 2, "image_element", { target: "cover" }),
  C("l2.a3", 2, "whole_image", { target: "avatar", subject: "account", alias: "头像比对" }), C("l2.a4", 2, "image_element", { target: "background", subject: "account" }),
  C("l3", 3, "asr"), C("comment", "comment", "comment"),
];
const heads = (cs: ConditionDesc[]) => [...conditionHeaders(cs, "抖音").values()];

describe("固定列表头：逐字等于刘学奎 2026-11-19 给定", () => {
  it("视频明细 21 列", () => {
    expect(buildColumns("videos", [], "抖音").map((c) => c.header)).toEqual([
      "品牌", "大区", "分公司", "板块", "经销商名称", "门店名称", "门店编码", "专员姓名", "平台", "抖音昵称", "主页链接",
      "类型(视频/图文)", "视频/图文标题", "发布时间", "视频/图文链接", "视频/图文唯一ID", "点赞", "评论", "分享", "收藏", "采集时间",
    ]);
  });
  it("账号维度 19 列 + 判定结果", () => {
    expect(buildColumns("accounts", [], "抖音").map((c) => c.header)).toEqual([
      "品牌", "大区", "分公司", "板块", "经销商名称", "门店名称", "门店编码", "专员姓名", "平台", "抖音昵称", "主页链接",
      "粉丝数", "总获赞", "平台作品数", "已采集视频数", "主页是否采集成功", "主页采集时间", "视频列表是否采集成功", "视频列表采集时间", "判定结果",
    ]);
  });
  it("昵称列头随平台：小红书计划是「小红书昵称」", () => {
    expect(buildColumns("videos", [], "小红书").find((c) => c.key === "nickname")!.header).toBe("小红书昵称");
  });
});
describe("能力列头（EL-4）", () => {
  it("有别名用别名；无别名用默认名", () => {
    expect(defaultName(C("x", 2, "whole_image", { target: "cover" }))).toBe("整图对比·封面");
    expect(defaultName(C("x", 2, "image_element", { target: "background" }))).toBe("元素对比·主页背景");
    expect(defaultName(C("x", 2, "whole_image", { target: "avatar" }))).toBe("整图对比·头像");
    expect(heads([C("l1.0", 1, "text", { alias: "品牌词" }), C("l3", 3, "asr"), C("comment", "comment", "comment")])).toEqual(["品牌词", "语音判定", "评论要求"]);
  });
  it("重名的每一列都加序号，按配置顺序从 1 起；单个不加", () => {
    expect(heads(V3)).toEqual(["品牌词", "文本关键词", "话题 #1", "话题 #2", "时长", "封面模板", "元素对比·封面", "头像比对", "元素对比·主页背景", "语音判定", "评论要求"]);
  });
  it("别名撞默认名、别名撞别名 → 全部加序号", () => {
    expect(heads([C("l1.0", 1, "text", { alias: "话题" }), C("l1.1", 1, "hashtags"), C("l1.2", 1, "hashtags", { alias: "话题" })])).toEqual(["话题 #1", "话题 #2", "话题 #3"]);
  });
  it("名字撞固定列表头 → 追加「（能力）」", () => {
    expect(heads([C("l1.0", 1, "text", { alias: "品牌" }), C("l1.1", 1, "text", { alias: "判定结果" }), C("l1.2", 1, "text", { alias: "平台" })])).toEqual(["品牌（能力）", "判定结果（能力）", "平台（能力）"]);
  });
  it("两张表同一条件列头一致：去重在全集上算，视频明细只取内容类子集", () => {
    // 头像 / 背景与封面同名（都没有别名且种类相同）时，若在子集上去重，序号会在两张表里不同
    const cs = [C("l2.a", 2, "whole_image", { target: "cover" }), C("l2.b", 2, "whole_image", { target: "cover", subject: "content" }), C("l2.c", 2, "whole_image", { target: "avatar", subject: "account", alias: "整图对比·封面" })];
    const v = buildColumns("videos", cs, "抖音").filter((c) => c.kind === "condition");
    const a = buildColumns("accounts", cs, "抖音").filter((c) => c.kind === "condition");
    expect(v.map((c) => c.header)).toEqual(["整图对比·封面 #1", "整图对比·封面 #2"]);
    expect(a.map((c) => c.header)).toEqual(["整图对比·封面 #1", "整图对比·封面 #2", "整图对比·封面 #3"]);
    for (const c of v) expect(a.find((x) => x.key === c.key)!.header).toBe(c.header);
  });
});
describe("列序：按层序，头像 / 主页背景留在第 2 层的位置上（EL-D13）", () => {
  it("账号维度：…封面、元素封面、头像、背景、语音、评论；视频明细没有头像 / 背景", () => {
    const a = buildColumns("accounts", V3, "抖音").filter((c) => c.kind === "condition").map((c) => c.key);
    expect(a).toEqual(["l1.0", "l1.1", "l1.2", "l1.3", "l1.4", "l2.a1", "l2.a2", "l2.a3", "l2.a4", "l3", "comment"]);
    expect(buildColumns("videos", V3, "抖音").filter((c) => c.kind === "condition").map((c) => c.key)).toEqual(["l1.0", "l1.1", "l1.2", "l1.3", "l1.4", "l2.a1", "l2.a2", "l3", "comment"]);
  });
});
