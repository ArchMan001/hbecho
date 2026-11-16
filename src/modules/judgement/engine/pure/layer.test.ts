import { describe, expect, it } from "vitest";
import { combineLayer, progressOf, type LayerResult } from "./layer";
import type { CondResult, Tri } from "./types";

const c = (state: Tri, extra: Partial<CondResult> = {}): CondResult => ({ state, ...extra });
const L = (state: LayerResult["state"], reason?: string): LayerResult => ({ state, stale: false, ...(reason ? { reason } : {}) });

describe("combineLayer", () => {
  it("空层 = not_configured", () => expect(combineLayer([])).toEqual({ state: "not_configured", stale: false }));
  it("同层两个条件：一个不通过、一个仍在等 → 立即不通过（提前终止）", () => {
    expect(combineLayer([c("fail"), c("unobtained", { awaiting: true, reason: "not_computed" })]).state).toBe("fail");
  });
  it("没有 fail、任一在等 → waiting；在等的和终态未获取并存时仍是 waiting（可能补齐后不通过）", () => {
    expect(combineLayer([c("pass"), c("unobtained", { awaiting: true })]).state).toBe("waiting");
    expect(combineLayer([c("unobtained", { reason: "media_failed" }), c("unobtained", { awaiting: true })]).state).toBe("waiting");
  });
  it("无在等：AND3；未获取带第一个原因；stale 汇总", () => {
    expect(combineLayer([c("pass"), c("pass")]).state).toBe("pass");
    expect(combineLayer([c("pass"), c("unobtained", { reason: "media_failed" })])).toMatchObject({ state: "unobtained", reason: "media_failed" });
    expect(combineLayer([c("pass", { stale: true }), c("pass")]).stale).toBe(true);
  });
});

describe("progressOf", () => {
  it("全部通过 / 未配置 → pass，无停层", () => {
    expect(progressOf([L("pass"), L("pass"), L("not_configured"), L("not_configured")])).toEqual({ final: "pass", stopLayer: null });
  });
  it("在某层不通过 → fail，停在该层；未获取 → unobtained，停在该层并带原因", () => {
    expect(progressOf([L("pass"), L("fail"), undefined, undefined])).toEqual({ final: "fail", stopLayer: 1 });
    expect(progressOf([L("pass"), L("pass"), L("unobtained", "media_failed"), undefined])).toEqual({ final: "unobtained", stopLayer: 2, reason: "media_failed" });
    expect(progressOf([L("unobtained", "published_at_missing"), undefined, undefined, undefined])).toEqual({ final: "unobtained", stopLayer: 0, reason: "published_at_missing" });
  });
  it("有层在等或尚未评估 → 仍待办", () => {
    expect(progressOf([L("pass"), L("waiting"), undefined, undefined]).final).toBeNull();
    expect(progressOf([L("pass"), L("pass"), undefined, undefined]).final).toBeNull();
  });
});
