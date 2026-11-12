// c-signals 测试挂具自身的行为：fake 要按承诺工作，否则用它们写的测试什么也证明不了。
import { describe, expect, it } from "vitest";
import { MatcherError } from "../../src/modules/signals/scoring/ports";
import { FakeAiGateway, FakeMatcher } from "./signals";

describe("FakeAiGateway", () => {
  it("同一 callKey 只计费一次；调用仍被记录", async () => {
    const g = new FakeAiGateway();
    const a = await g.transcribe({ callKey: "k1", audioUrl: "https://x" });
    const b = await g.transcribe({ callKey: "k1", audioUrl: "https://x" });
    expect(b).toBe(a);
    await g.transcribe({ callKey: "k2", audioUrl: "https://x" });
    expect([g.billed, g.calls.length]).toEqual([2, 3]);
  });
  it("activeModel 可切换，null 表示禁用；新模型版本进入新结果", async () => {
    const g = new FakeAiGateway();
    expect(await g.activeModel("judge")).toBe("judge-m1");
    const r1 = await g.judge({ callKey: "a", promptId: "p", promptVersion: 1, system: "s", user: "u" });
    g.models.judge = "judge-m2";
    const r2 = await g.judge({ callKey: "b", promptId: "p", promptVersion: 1, system: "s", user: "u" });
    expect([r1.model, r2.model]).toEqual(["judge-m1", "judge-m2"]);
    g.models.asr = null;
    expect(await g.activeModel("asr")).toBeNull();
  });
  it("failNext 只影响下一次调用，失败的调用不计费也不缓存", async () => {
    const g = new FakeAiGateway();
    g.failNext = new Error("瞬时错误");
    await expect(g.transcribe({ callKey: "k", audioUrl: "u" })).rejects.toThrow("瞬时错误");
    expect(g.billed).toBe(0);
    await g.transcribe({ callKey: "k", audioUrl: "u" });
    expect(g.billed).toBe(1);
  });
});

describe("FakeMatcher", () => {
  const req = (referenceUrl: string, mode: "template" | "element" = "template") => ({ referenceUrl, candidateUrl: "c", mode, maxBytes: 1 });
  it("默认分数；on() 按条件覆盖分数或抛 MatcherError；请求被记录", async () => {
    const m = new FakeMatcher(6).on((r) => r.referenceUrl === "ref-bad", new MatcherError("source_missing", "x", "candidate")).on((r) => r.referenceUrl === "ref-low", 1.5);
    expect((await m.match(req("ref-ok"))).score).toBe(6);
    expect((await m.match(req("ref-low"))).score).toBe(1.5);
    await expect(m.match(req("ref-bad"))).rejects.toMatchObject({ code: "source_missing", side: "candidate" });
    expect(m.requests).toHaveLength(3);
  });
  it("回报的能力标识随模式；版本可改（模拟镜像落后）", async () => {
    const m = new FakeMatcher();
    expect((await m.match(req("r", "element"))).capability).toEqual({ id: "image.element", version: 1 });
    m.capabilityVersion = 2;
    expect((await m.match(req("r"))).capability).toEqual({ id: "image.template", version: 2 });
  });
});
