import { describe, expect, it } from "vitest";
import { centsToText, evalAsr, evalDuration, evalHashtags, evalKeywords, evalScore, scoreToCents, stripHash, thresholdToCents } from "./conditions";
import type { NormalizeFn, SignalLike } from "./types";

// 测试用归一化：小写 + 去空白；版本 2 额外去掉连字符（用来证明比较按文本自己的版本归一化）
const normalize: NormalizeFn = (raw, v = 1) => (v >= 2 ? raw.toLowerCase().replace(/[\s-]/g, "") : raw.toLowerCase().replace(/\s/g, ""));
const ok = (value: unknown, extra: Partial<SignalLike> = {}): SignalLike => ({ state: "valid", usable: true, value, normalizerVersion: 1, ...extra });
const missing = (reason: string, extra: Partial<SignalLike> = {}): SignalLike => ({ state: "missing", usable: false, reason, ...extra });

describe("evalKeywords", () => {
  const cfg = (mode: "all" | "any", fields: Array<"title" | "body"> = ["title", "body"]) => ({ fields, mode, keywords: ["海信", "618"] });
  it("all：每个词都在所选字段中命中才通过；少一个不通过", () => {
    expect(evalKeywords(cfg("all"), { title: ok("海信618大促"), body: ok("") }, normalize).state).toBe("pass");
    expect(evalKeywords(cfg("all"), { title: ok("海信新品"), body: ok("") }, normalize)).toMatchObject({ state: "fail", detail: { hit: ["海信"] } });
    expect(evalKeywords(cfg("all"), { title: ok("海信"), body: ok("今天 618") }, normalize).state).toBe("pass"); // 词分散在两个字段里
  });
  it("any：至少一个词命中", () => {
    expect(evalKeywords(cfg("any"), { title: ok("618"), body: ok("") }, normalize).state).toBe("pass");
    expect(evalKeywords(cfg("any"), { title: ok("无关"), body: ok("") }, normalize).state).toBe("fail");
  });
  it("字段选择：只选标题时不看正文", () => {
    expect(evalKeywords(cfg("any", ["title"]), { title: ok("无关"), body: ok("海信") }, normalize).state).toBe("fail");
  });
  it("单调：一个字段不可用但另一字段已命中 → 通过；两个字段都不可用 → 未获取成功", () => {
    expect(evalKeywords(cfg("any"), { title: ok("海信"), body: missing("not_computed") }, normalize).state).toBe("pass");
    expect(evalKeywords(cfg("any"), { title: missing("not_computed"), body: missing("not_computed") }, normalize)).toMatchObject({ state: "unobtained", awaiting: true, reason: "not_computed" });
    // 现有证据下 all 不满足、但缺失字段补齐后可能满足 → 未获取成功；已有字段全部命中则通过
    expect(evalKeywords(cfg("all"), { title: ok("海信"), body: missing("not_computed") }, normalize).state).toBe("unobtained");
    expect(evalKeywords(cfg("all"), { title: ok("海信618"), body: missing("not_computed") }, normalize).state).toBe("pass");
  });
  it("没有任何可用字段且没有命中、不可用原因是终态 → 未获取成功且不再等", () => {
    expect(evalKeywords(cfg("any"), { title: missing("field_absent_on_platform", { state: "not_applicable" }), body: ok("无关") }, normalize)).toMatchObject({ state: "unobtained", awaiting: false });
  });
  it("按文本自己的 normalizerVersion 归一化关键词（C-D17）", () => {
    const c = { fields: ["title" as const], mode: "any" as const, keywords: ["Hi-Sense"] };
    expect(evalKeywords(c, { title: ok("hisense 新品", { normalizerVersion: 2 }) }, normalize).state).toBe("pass");
    expect(evalKeywords(c, { title: ok("hisense 新品", { normalizerVersion: 1 }) }, normalize).state).toBe("fail");
  });
  it("stale 信号使用后带 stale 标记，三态不变", () => {
    expect(evalKeywords(cfg("any"), { title: { ...ok("海信"), state: "stale" }, body: ok("") }, normalize)).toMatchObject({ state: "pass", stale: true });
  });
});

describe("evalHashtags", () => {
  const c = { mode: "any" as const, values: ["#618"] };
  it("整体相等，不做子串：618 不匹配 618大促；去首尾 #", () => {
    expect(evalHashtags(c, ok(["618大促"]), normalize).state).toBe("fail");
    expect(evalHashtags(c, ok(["618"]), normalize).state).toBe("pass");
    expect(evalHashtags({ mode: "any", values: ["618"] }, ok(["#618#"]), normalize).state).toBe("pass");
    expect(stripHash(" ##618# ")).toBe("618");
  });
  it("all / any", () => {
    expect(evalHashtags({ mode: "all", values: ["618", "海信"] }, ok(["618"]), normalize)).toMatchObject({ state: "fail", detail: { hit: ["618"] } });
    expect(evalHashtags({ mode: "any", values: ["618", "海信"] }, ok(["618"]), normalize).state).toBe("pass");
  });
  it("信号不可用 → 未获取成功（在等 / 终态）；值形状不对 → 未获取成功", () => {
    expect(evalHashtags(c, missing("not_computed"), normalize)).toMatchObject({ state: "unobtained", awaiting: true });
    expect(evalHashtags(c, ok("不是数组"), normalize).state).toBe("unobtained");
  });
});

describe("evalDuration", () => {
  const cfg = { minSeconds: 15, maxSeconds: 180 };
  it("恰好等于边界通过；超出不通过；缺省端不限", () => {
    expect(evalDuration(cfg, { state: "value", value: "15.000000", unit: "seconds" }).state).toBe("pass");
    expect(evalDuration(cfg, { state: "value", value: 180, unit: "seconds" }).state).toBe("pass");
    expect(evalDuration(cfg, { state: "value", value: "14.999999", unit: "seconds" }).state).toBe("fail");
    expect(evalDuration(cfg, { state: "value", value: 181, unit: "seconds" }).state).toBe("fail");
    expect(evalDuration({ minSeconds: 15 }, { state: "value", value: 9999, unit: "seconds" }).state).toBe("pass");
  });
  it("真实 0 秒是有效值；单位未知 / 值缺失 → 未获取成功，原因码对应", () => {
    expect(evalDuration({ maxSeconds: 10 }, { state: "value", value: 0, unit: "seconds" }).state).toBe("pass");
    expect(evalDuration(cfg, { state: "value", value: 30, unit: "unknown" })).toMatchObject({ state: "unobtained", reason: "duration_unit_unknown" });
    for (const state of ["missing", "explicit_null", "invalid", "unsupported"]) expect(evalDuration(cfg, { state, value: null, unit: "seconds" })).toMatchObject({ state: "unobtained", reason: "duration_missing" });
  });
});

describe("分数", () => {
  it("阈值字符串 → 整数百分位；格式非法或超范围抛错", () => {
    expect(thresholdToCents("8")).toBe(800);
    expect(thresholdToCents("8.5")).toBe(850);
    expect(thresholdToCents("8.05")).toBe(805);
    expect(thresholdToCents("10.00")).toBe(1000);
    expect(thresholdToCents("0")).toBe(0);
    for (const bad of ["10.01", "11", "-1", "8.123", "abc", "", "8."]) expect(() => thresholdToCents(bad), bad).toThrow();
    expect(centsToText(805)).toBe("8.05");
    expect(centsToText(1000)).toBe("10.00");
  });
  it("score(number，两位小数) → 整数百分位无浮点漂移", () => {
    for (const [x, c] of [[8.1, 810], [0.07, 7], [9.99, 999], [10, 1000], [0, 0], [1.15, 115], [2.675, 268]] as const) expect(scoreToCents(x)).toBe(c);
  });
  it("分数等于阈值判通过（\"8.00\" 对阈值 \"8\"）；低一分不通过；不可用 → 未获取成功", () => {
    expect(evalScore(thresholdToCents("8"), ok(null, { score: 8 })).state).toBe("pass");
    expect(evalScore(thresholdToCents("8"), ok(null, { score: 7.99 }))).toMatchObject({ state: "fail", detail: { score: "7.99" } });
    expect(evalScore(800, missing("media_pending"))).toMatchObject({ state: "unobtained", reason: "media_pending", awaiting: false });
    expect(evalScore(800, ok(null))).toMatchObject({ state: "unobtained", reason: "invalid_signal_value" });
  });
});

describe("evalAsr", () => {
  it("meets → 通过；not_meets → 不通过；failed → 未获取成功（不是不通过）", () => {
    expect(evalAsr(ok({ verdict: "meets", reason: "x" })).state).toBe("pass");
    expect(evalAsr(ok({ verdict: "not_meets", reason: "x" })).state).toBe("fail");
    expect(evalAsr({ state: "failed", usable: false, reason: "invalid_output" })).toMatchObject({ state: "unobtained", reason: "invalid_output" });
    expect(evalAsr({ state: "failed", usable: false, reason: "model_refused" })).toMatchObject({ state: "unobtained", reason: "model_refused" });
    expect(evalAsr(ok({ verdict: "maybe" })).state).toBe("unobtained");
  });
});
