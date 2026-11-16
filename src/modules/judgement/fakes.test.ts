import { describe, expect, it } from "vitest";
import { FakeDemand, FakeSignals } from "./fakes";
import type { SignalActor } from "./ports";

const actor: SignalActor = { actor: "user:7", capabilities: new Set(), brandScope: "all" };
const sigs = () => new FakeSignals(["text.title_normalized", "content.cover_template_score", "content.asr_judgement"]);

describe("FakeSignals", () => {
  it("监控段：create 重复抛 segment_exists；newDraft 版本 +1 且复制；发布后不可改", async () => {
    const f = sigs();
    const k = await f.segments.create(actor, { planId: 1n, platform: "douyin" });
    await expect(f.segments.create(actor, { planId: 1n, platform: "douyin" })).rejects.toMatchObject({ code: "segment_exists" });
    await f.segments.setItems(actor, k, [{ signal: "text.title_normalized" }]);
    await f.segments.publish(actor, k);
    await expect(f.segments.setItems(actor, k, [])).rejects.toMatchObject({ code: "segment_immutable" });
    const d = await f.segments.newDraft(actor, { planId: 1n, fromVersion: 1 });
    expect(d.version).toBe(2);
    expect((await f.segments.show(actor, d)).items).toEqual([{ signal: "text.title_normalized" }]);
  });
  it("executability 的 only 过滤 blockers；不可执行时 requestScores 抛 not_executable，且只看 only 内的信号", async () => {
    const f = sigs();
    f.blockers = [{ code: "capability_disabled", signal: "content.asr_judgement" }];
    const ref = { planId: 1n, version: 1 };
    expect((await f.executability(actor, ref, { only: ["content.cover_template_score"] })).executable).toBe(true);
    expect((await f.executability(actor, ref)).executable).toBe(false);
    await expect(f.requestScores(actor, ref, [], { only: ["content.asr_judgement"] })).rejects.toMatchObject({ code: "not_executable" });
    await expect(f.requestScores(actor, ref, [{ kind: "content", id: 1n }], { only: ["content.cover_template_score"] })).resolves.toMatchObject({ tasks: { created: 1 } });
  });
  it("readMany：未编程的主体读作 missing(not_computed)；可编程元素图信号；调用被记录", async () => {
    const f = sigs();
    f.setValue("content.cover_template_score", 1n, { state: "valid", usable: true, score: 8 });
    const m = await f.readMany(actor, [{ kind: "content", id: 1n }, { kind: "content", id: 2n }], "content.cover_template_score", { param: { segment: { planId: 1n, version: 1 } } });
    expect(m.get(1n)).toMatchObject({ state: "valid", score: 8 });
    expect(m.get(2n)).toMatchObject({ state: "missing", reason: "not_computed" });
    expect(f.callsOf("readMany")).toHaveLength(1);
  });
});

describe("FakeDemand", () => {
  it("同一 (actor, demandKey) 重复提交得到同一批次（幂等），不同提交人是不同批次", async () => {
    const d = new FakeDemand();
    const a = { actorId: "user:7", capabilities: new Set<string>(), scope: { platformCodes: "all" as const, mediaStaffIds: "all" as const } };
    const input = { demandKey: "exec:1:cm:0" } as never;
    const r1 = await d.submit(a, input);
    const r2 = await d.submit(a, input);
    expect(r2.batchId).toBe(r1.batchId);
    expect(r2.kind).toBe("deduplicated");
    expect(d.submitted).toHaveLength(1);
    expect((await d.submit({ ...a, actorId: "user:8" }, input)).batchId).not.toBe(r1.batchId);
  });
});
