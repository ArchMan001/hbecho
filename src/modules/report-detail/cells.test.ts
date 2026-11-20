import { describe, expect, it } from "vitest";
import type { ConditionDesc } from "../judgement/config";
import type { ContentEvidence } from "../judgement/outcomes";
import { accountCell, contentCell, fmtBjt, httpUrl, kindLabel, resultCell, safeText, secondsText, SKIPPED_TEXT, valueCell, type ContentCellInput } from "./cells";

const C = (key: string, layer: ConditionDesc["layer"], kind: ConditionDesc["kind"], o: Partial<ConditionDesc> = {}): ConditionDesc => ({ key, layer, kind, target: null, subject: "content", alias: null, ...o });
const TEXT = C("l1.0", 1, "text");
const DUR = C("l1.1", 1, "duration");
const COVER = C("l2.a1", 2, "whole_image", { target: "cover" });
const ASR = C("l3", 3, "asr");
const CM = C("comment", "comment", "comment");
const base = (o: Partial<ContentCellInput> = {}): ContentCellInput => ({ final: "pass", stopLayer: null, reasonCode: null, evidence: {}, comments: { total: null, pass: null }, ...o });

describe("contentCell：每种条件 × 每种状态", () => {
  const ev: ContentEvidence = { l1: [{ idx: 0, state: "pass", hit: ["日立", "中央空调"] }, { idx: 1, state: "fail", seconds: "8" }], l2: [{ id: "a1", state: "pass", score: "7.80" }], l3: { state: "pass", verdict: "meets" } };
  it("文本 / 话题：通过写命中词；不通过且无命中写「未命中」", () => {
    expect(contentCell(TEXT, base({ evidence: ev }))).toEqual({ text: "日立、中央空调", tone: "pass" });
    expect(contentCell(TEXT, base({ evidence: { l1: [{ idx: 0, state: "fail", hit: [] }] } }))).toEqual({ text: "未命中", tone: "fail" });
  });
  it("时长写秒数；图片类写分数；语音写达标 / 不达标", () => {
    expect(contentCell(DUR, base({ evidence: ev }))).toEqual({ text: "8 秒", tone: "fail" });
    expect(contentCell(COVER, base({ evidence: ev }))).toEqual({ text: "7.80", tone: "pass" });
    expect(contentCell(ASR, base({ evidence: ev }))).toEqual({ text: "达标", tone: "pass" });
    expect(contentCell(ASR, base({ evidence: { l3: { state: "fail", verdict: "not_meets" } } }))).toEqual({ text: "不达标", tone: "fail" });
  });
  it("获取失败写原因码，不写 0、不留空：条件自带原因优先，否则用行原因码", () => {
    expect(contentCell(COVER, base({ evidence: { l2: [{ id: "a1", state: "unobtained", reason: "dependency_timeout" }] } }))).toEqual({ text: "dependency_timeout", tone: "unobtained" });
    expect(contentCell(TEXT, base({ reasonCode: "not_computed", evidence: { l1: [{ idx: 0, state: "unobtained" }] } }))).toEqual({ text: "not_computed", tone: "unobtained" });
  });
  it("没评估到：被更早的层判不通过 / 没被选中 → 前置条件未满足", () => {
    expect(contentCell(COVER, base({ final: "fail", stopLayer: "1", evidence: { l1: [{ idx: 0, state: "fail" }] } }))).toEqual({ text: SKIPPED_TEXT, tone: "skipped" });
    expect(contentCell(ASR, base({ final: "skipped", stopLayer: "1", reasonCode: "layer1_not_selected", evidence: { l1: [{ idx: 0, state: "pass" }] } }))).toEqual({ text: SKIPPED_TEXT, tone: "skipped" });
  });
  it("没评估到：更早的层是获取失败 → 该行原因码（不是前置条件未满足）", () => {
    const l0 = base({ final: "unobtained", stopLayer: "0", reasonCode: "published_at_missing" });
    for (const c of [TEXT, COVER, ASR, CM]) expect(contentCell(c, l0)).toEqual({ text: "published_at_missing", tone: "unobtained" });
    // 封面获取失败停在第 2 层：语音与评论都是「更早层获取失败」
    const l2 = base({ final: "unobtained", stopLayer: "2", reasonCode: "dependency_timeout", evidence: { l2: [{ id: "a1", state: "unobtained", reason: "dependency_timeout" }] } });
    expect(contentCell(ASR, l2)).toEqual({ text: "dependency_timeout", tone: "unobtained" });
    expect(contentCell(CM, l2)).toEqual({ text: "dependency_timeout", tone: "unobtained" });
    // 第 3 层停下（语音失败）：评论已走完候选，有评论数就写命中数
    expect(contentCell(CM, base({ final: "fail", stopLayer: "3", comments: { total: 9, pass: 2 } }))).toEqual({ text: "命中 2 / 共 9 条", tone: "plain" });
  });
  it("评论：走完第 2 层的内容写 命中 x / 共 y 条；没评估到且不是获取失败 → 前置条件未满足", () => {
    expect(contentCell(CM, base({ comments: { total: 27, pass: 10 } }))).toEqual({ text: "命中 10 / 共 27 条", tone: "plain" });
    expect(contentCell(CM, base({ final: "skipped", stopLayer: "1" }))).toEqual({ text: SKIPPED_TEXT, tone: "skipped" });
  });
});
describe("accountCell / resultCell：四态", () => {
  const rs = [{ key: "l1.0", result: "success" as const }, { key: "l1.1", result: "not_met" as const }, { key: "l2.a1", result: "unobtained" as const, reason: "no_profile_snapshot" }, { key: "l3", result: "skipped" as const }];
  it("通过 / 不通过 / 获取失败（带原因）/ 前置条件未满足", () => {
    expect(accountCell(TEXT, rs)).toEqual({ text: "通过", tone: "pass" });
    expect(accountCell(DUR, rs)).toEqual({ text: "不通过", tone: "fail" });
    expect(accountCell(COVER, rs)).toEqual({ text: "获取失败：no_profile_snapshot", tone: "unobtained" });
    expect(accountCell(ASR, rs)).toEqual({ text: SKIPPED_TEXT, tone: "skipped" });
  });
  it("旧执行（null）整列空；没有这一项也空", () => {
    expect(accountCell(TEXT, null)).toEqual({ text: "", tone: "plain" });
    expect(accountCell(CM, rs)).toEqual({ text: "", tone: "plain" });
  });
  it("判定结果：成功 → 通过、不达标 → 不通过、未获取成功 → 获取失败", () => {
    expect(["success", "not_met", "unobtained"].map((x) => resultCell(x).text)).toEqual(["通过", "不通过", "获取失败"]);
  });
});
describe("值与格式", () => {
  it("互动值四态：真实 0 显示 0；缺失 / null 留空；invalid 写「无效」；19 位值不丢位（只放 text）", () => {
    expect(valueCell("value", 0n)).toEqual({ text: "0", tone: "plain", num: 0 });
    expect(valueCell("missing", null).text).toBe("");
    expect(valueCell("explicit_null", null).text).toBe("");
    expect(valueCell("invalid", null).text).toBe("无效");
    const big = valueCell("value", 7703376750574989926n);
    expect(big.text).toBe("7703376750574989926");
    expect(big.num).toBeUndefined();
  });
  it("北京时间格式；缺失留空", () => {
    expect(fmtBjt(new Date("2026-11-18T12:20:00Z"))).toBe("2026-11-18 20:20");
    expect(fmtBjt(new Date("2026-11-17T16:00:00Z"))).toBe("2026-11-18 00:00");
    expect(fmtBjt(null)).toBe("");
  });
  it("分享文案里取出第一个网址（账号主页链接存的是整段「长按复制此条消息…」文案）；文案里没有网址 / 只有危险协议 → 不输出", () => {
    expect(httpUrl("9- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/1BNjIHNOMA0/ 5@7.com :8pm")).toBe("https://v.douyin.com/1BNjIHNOMA0/");
    expect(httpUrl("长按复制此条消息 https://v.douyin.com/hAdTE2ioejk/")).toBe("https://v.douyin.com/hAdTE2ioejk/");
    expect(httpUrl("请补充")).toBeUndefined();
    expect(httpUrl("点这里 javascript:alert(1) 或 data:text/html,x")).toBeUndefined();
  });
  it("链接只放行 http / https", () => {
    expect(httpUrl("https://www.douyin.com/video/1")).toBeDefined();
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "", null, undefined, "not a url", "ftp://x"]) expect(httpUrl(bad)).toBeUndefined();
  });
  it("公式注入：以 = + - @ \\t \\r 开头加 '", () => {
    for (const s of ["=SUM(A1)", "+1", "-1", "@x", "\tx", "\rx"]) expect(safeText(s)).toBe(`'${s}`);
    expect(safeText("日立中央空调")).toBe("日立中央空调");
  });
  it("秒数：DECIMAL 文本去掉多余的小数零；非数字原样", () => {
    expect([secondsText("30.000000"), secondsText("8"), secondsText("12.500000"), secondsText("abc"), secondsText("")]).toEqual(["30", "8", "12.5", "abc", ""]);
  });
  it("类型标签", () => {
    expect([kindLabel("video"), kindLabel("image"), kindLabel("text"), kindLabel("unknown")]).toEqual(["视频", "图文", "图文", "未知"]);
  });
});
import { isReportError, ReportError } from "./types";
describe("isReportError：模块被打包成两份时也认得", () => {
  it("同一个类、另一份拷贝（同名同字段）都算；普通 Error 不算", () => {
    expect(isReportError(new ReportError("auth", "x", "m"))).toBe(true);
    class Copy extends Error { name = "ReportError"; kind = "auth"; code = "x"; }
    expect(isReportError(new Copy("m"))).toBe(true);
    expect(isReportError(new Error("m"))).toBe(false);
    expect(isReportError({ name: "ReportError", kind: "auth", code: "x" })).toBe(false);
  });
});
