// d-rule-engine 任务 8：第 3 层（ASR + 大模型判定）与评论要求——JP-10 / JP-12 / JP-13 / JP-14（保留期）。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { judgementPlanVersions, judgementRuns, runContents, runParticipants } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { addComment, addContent, addListTask, judgementEnv, judgementWorld, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { SignalError } from "../signals/errors";

const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const TEXT = { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] };
const BASE = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { ...TEXT, quantity: { n: 2 } } };
const CM = (method: unknown = { type: "at_least_n", n: 3 }) => ({ commentRequirement: { mode: "any", keywords: ["安装"], method } });
const ASR = { contentRequirement: { layer3: { standardText: "口播提到海信" } } };

async function setup(cfg: Record<string, unknown>, over: Parameters<typeof judgementEnv>[2] = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, over);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  await e.versions.setConfig(e.creator, planId, cfg);
  await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
  return { w, e, planId };
}
async function content(w: JudgementWorld, e: JudgementEnv, id: string, o: { like?: number; hit?: boolean; verdict?: "meets" | "not_meets" | "failed" | "incomplete" | "pending" } = {}) {
  const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: id, kind: "video", like: o.like ?? 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: o.hit === false ? "无关" : "海信新品", normalizerVersion: 1 });
  const v = o.verdict;
  if (v === "meets" || v === "not_meets") e.fake.setValue("content.asr_judgement", c.contentId, { state: "valid", usable: true, value: { verdict: v, reason: "口播内容与标准相关" }, evidence: { model: "judge-1", prompt_version: 2 }, resultId: 1000n + c.contentId });
  else if (v === "failed") e.fake.setValue("content.asr_judgement", c.contentId, { state: "failed", usable: false, reason: "invalid_output" });
  else if (v === "incomplete") e.fake.setValue("content.asr_judgement", c.contentId, { state: "valid", usable: true, value: { verdict: "meets", reason: "x" }, evidence: { model: "judge-1" } });
  return c.contentId;
}
/** 给内容造 k 条评论，其中前 hit 条命中关键词。 */
async function comments(e: JudgementEnv, contentId: bigint, k: number, hit: number) {
  const ids: bigint[] = [];
  for (let i = 0; i < k; i++) {
    const id = await addComment(t.db, { contentId, platformCommentId: `cm-${contentId}-${i}` });
    e.fake.setValue("comment.text_normalized", id, { state: "valid", usable: true, value: i < hit ? "安装很快" : "普通评论", normalizerVersion: 1 });
    ids.push(id);
  }
  return ids;
}
async function exec(e: JudgementEnv, planId: bigint, key = "k1") {
  await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
  const r = await e.runs.execute(e.creator, planId, { key });
  return { ...r, done: await e.runs.drive(r.runId, "w", e.sleep) };
}
const rowOf = async (runId: bigint, contentId: bigint) => (await t.db.select().from(runContents).where(and(eq(runContents.runId, runId), eq(runContents.contentId, contentId))))[0]!;
const partOf = async (runId: bigint) => (await t.db.select().from(runParticipants).where(eq(runParticipants.runId, runId)))[0]!;

describe("评论要求（JP-10）", () => {
  it("评论需求的主体只含 C2（通过第 1、2 层）；键、requester、ruleDecisionId、提交人身份固定", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT, quantity: { n: 2 } }, ...CM() });
    const a = await content(w, e, "a", { like: 30 });
    const b = await content(w, e, "b", { like: 20 });
    await content(w, e, "c", { like: 10 }); // 第 3 名被数量要求截掉
    await content(w, e, "d", { hit: false }); // 第 1 层不通过
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    expect(e.demand.submitted).toHaveLength(1);
    const s = e.demand.submitted[0]!;
    expect(s.actor).toBe("user:7");
    expect(s.input).toMatchObject({ demandKey: `exec:${done.runId}:cm:0`, requester: { kind: "judgement-plan", ref: String(planId), version: "1" }, ruleDecisionId: `run:${done.runId}`, ruleVersion: `${planId}@1` });
    expect((s.input as { items: Array<{ contentId: string; wants: string[] }> }).items.map((i) => [i.contentId, i.wants[0]]).sort()).toEqual([[String(a), "comments"], [String(b), "comments"]].sort());
  });
  it.each([
    [2, "partial", "unobtained", 9],
    [2, "complete", "not_met", 4],
    [3, "complete", "success", 4],
  ] as const)("至少 3 条评论含关键词：命中 %i + 覆盖 %s → %s", async (hit, coverage, want, total) => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT }, ...CM() });
    const a = await content(w, e, "a");
    await comments(e, a, 4, hit);
    e.demand.setOutcome(a, "comments", { state: "ready", comments: { coverage, fetchedCount: 4, reportedTotal: coverage === "partial" ? "9" : "4" } });
    const { done } = await exec(e, planId);
    const p = await partOf(done.runId);
    expect(p.commentResult).toBe(want);
    expect(p.commentTotal).toBe(total); // partial 且总数已知：缺口 = 9 − 4 = 5，计入未获取
  });
  it("覆盖 partial 且总数未知 → 缺口按 1 计；评论证据里只有评论 ID（≤ 3）与计数，没有原文", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT }, ...CM({ type: "any" }) });
    const a = await content(w, e, "a");
    const ids = await comments(e, a, 6, 5);
    e.demand.setOutcome(a, "comments", { state: "ready", comments: { coverage: "unknown", fetchedCount: 6, reportedTotal: null } });
    const { done } = await exec(e, planId);
    const r = await rowOf(done.runId, a);
    expect(r).toMatchObject({ cmTotal: 7, cmPass: 5, cmUnobtained: 1 });
    expect((r.cmSamples as string[]).length).toBe(3);
    expect((r.cmSamples as string[]).every((s) => ids.map(String).includes(s))).toBe(true);
    expect(JSON.stringify(r.evidence)).not.toMatch(/安装很快|普通评论/);
    expect((await partOf(done.runId)).commentResult).toBe("success"); // any：已有命中
  });
  it("评论依赖失败：采集失败 / 内容不存在 / 超时 → 该内容记 1 条未获取，原因逐一对应", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT, quantity: { n: 3 } }, ...CM() });
    const a = await content(w, e, "a", { like: 3 });
    const b = await content(w, e, "b", { like: 2 });
    const c = await content(w, e, "c", { like: 1 });
    e.demand.setOutcome(a, "comments", { state: "failed", reason: "provider_error" });
    e.demand.setOutcome(b, "comments", { state: "unsupported", disposition: "content_not_found" });
    e.demand.setOutcome(c, "comments", { state: "unsupported", disposition: "capability_disabled" });
    const { done } = await exec(e, planId);
    const p = await partOf(done.runId);
    expect(p).toMatchObject({ commentTotal: 3, commentUnobtained: 3, commentPass: 0, commentResult: "unobtained", planResult: "unobtained" });
    expect(p.reasonDetail).toMatchObject({ comment_unobtained_reasons: { demand_failed: 1, content_not_found: 1, capability_disabled: 1 } });
    for (const id of [a, b, c]) expect(await rowOf(done.runId, id)).toMatchObject({ cmTotal: 1, cmUnobtained: 1, cmPass: 0 });
  });
  it("采集一直没完成：超过采集等待上限记 dependency_timeout，运行继续并完成", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT }, ...CM() }, { config: { waitDemandSeconds: 60 } });
    await content(w, e, "a");
    e.demand.pendingGets = 1000;
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    const p = await partOf(done.runId);
    expect(p).toMatchObject({ commentResult: "unobtained" });
    expect(p.reasonDetail).toMatchObject({ comment_unobtained_reasons: { dependency_timeout: 1 } });
    expect(e.clock.now().getTime() - new Date("2026-11-16T02:00:00Z").getTime()).toBeGreaterThanOrEqual(60_000);
  });
  it("评论文本信号还没算出：等待后就绪则正常；一直没有则记 dependency_timeout", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT }, ...CM({ type: "any" }) });
    const a = await content(w, e, "a");
    const id = await addComment(t.db, { contentId: a, platformCommentId: "late" });
    let n = 0;
    e.onSleep.fn = () => {
      if (++n === 2) e.fake.setValue("comment.text_normalized", id, { state: "valid", usable: true, value: "安装", normalizerVersion: 1 });
    };
    const { done } = await exec(e, planId);
    expect(await rowOf(done.runId, a)).toMatchObject({ cmTotal: 1, cmPass: 1 });
  });
  it("评论候选为空：有候选在第 1 / 2 层未获取 → 未获取成功；参与内容全部确定性没通过 → 不达标", async () => {
    const s1 = await setup({ ...BASE, layer1: { ...TEXT }, ...CM() });
    const x = await addContent(t.db, { accountId: s1.w.accZhao, platformContentId: "x", kind: "video", publishedAt: day(5) }); // 文本信号没算出 → 第 1 层未获取
    void x;
    const r1 = await exec(s1.e, s1.planId);
    expect(await partOf(r1.done.runId)).toMatchObject({ commentResult: "unobtained", commentTotal: 0 });
    expect((await partOf(r1.done.runId)).primaryReason).toBe("dependency_timeout"); // 内容类优先：第 1 层文本信号一直没算出
  });
  it("评论候选为空且参与内容都没通过第 1 层 → 不达标；评论结果不反过来过滤内容", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT }, ...CM() });
    const a = await content(w, e, "a", { hit: false });
    const { done } = await exec(e, planId);
    expect(await partOf(done.runId)).toMatchObject({ commentResult: "not_met" });
    expect((await rowOf(done.runId, a)).final).toBe("fail");
  });
});

describe("第 3 层 ASR 判定（JP-12）", () => {
  const cfg = { ...BASE, layer1: { ...TEXT, quantity: { n: 3 } }, ...ASR };
  it("音频需求只含 C2；requestScores 的 only 只含第 3 层信号；meets → 通过、not_meets → 不通过、failed → 未获取成功（不是不通过）", async () => {
    const { w, e, planId } = await setup(cfg);
    const ok = await content(w, e, "ok", { like: 3, verdict: "meets" });
    const no = await content(w, e, "no", { like: 2, verdict: "not_meets" });
    const bad = await content(w, e, "bad", { like: 1, verdict: "failed" });
    await content(w, e, "skip", { hit: false });
    const { done } = await exec(e, planId);
    const audio = e.demand.submitted.filter((s) => (s.input as { demandKey: string }).demandKey.includes(":l3:"));
    expect(audio).toHaveLength(1);
    expect((audio[0]!.input as { items: Array<{ contentId: string }> }).items.map((i) => i.contentId).sort()).toEqual([ok, no, bad].map(String).sort());
    const calls = e.fake.callsOf("requestScores").map((c) => c.args as { only: string[] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.only).toEqual(["content.asr_judgement"]);
    expect(await rowOf(done.runId, ok)).toMatchObject({ l3: "pass", final: "pass" });
    expect(await rowOf(done.runId, no)).toMatchObject({ l3: "fail", final: "fail", stopLayer: "3" });
    expect(await rowOf(done.runId, bad)).toMatchObject({ l3: "unobtained", final: "unobtained", reasonCode: "invalid_output" });
    const p = await partOf(done.runId);
    expect(p).toMatchObject({ contentPass: 1, contentFail: 1 + 1, contentUnobtained: 1, contentResult: "not_met", c3Count: 1 }); // 第 4 条在第 1 层不通过也计 F
  });
  it("证据四要素齐全（结论、理由、模型版本、提示词版本）；缺一样的判定不被当作通过", async () => {
    const { w, e, planId } = await setup(cfg);
    const ok = await content(w, e, "ok", { like: 2, verdict: "meets" });
    const inc = await content(w, e, "inc", { like: 1, verdict: "incomplete" });
    const { done } = await exec(e, planId);
    expect((await rowOf(done.runId, ok)).evidence).toMatchObject({ l3: { state: "pass", verdict: "meets", reason: "口播内容与标准相关", model: "judge-1", promptVersion: 2, resultId: String(1000n + ok) } });
    expect(await rowOf(done.runId, inc)).toMatchObject({ l3: "unobtained", final: "unobtained", reasonCode: "incomplete_judgement_evidence" });
  });
  it("retainUntil：每个求值块写证据之前延长它读到的结果行（resultId 去重，读取时刻 + 3 个月）", async () => {
    const { w, e, planId } = await setup(cfg);
    const a = await content(w, e, "a", { like: 2, verdict: "meets" });
    const b = await content(w, e, "b", { like: 1, verdict: "not_meets" });
    const { done } = await exec(e, planId);
    const all = e.fake.retained.flatMap((r) => r.ids.map(String));
    expect(all.sort()).toEqual([String(1000n + a), String(1000n + b)].sort());
    const until = e.fake.retained[0]!.until;
    expect(until.getUTCMonth()).toBe((new Date("2026-11-16T02:00:00Z").getUTCMonth() + 3) % 12);
    expect(done.status).toBe("completed");
  });
  it("retainUntil 失败：该块重试，运行最终完成，证据不丢", async () => {
    const { w, e, planId } = await setup(cfg);
    const a = await content(w, e, "a", { like: 1, verdict: "meets" });
    e.fake.failNext = { fn: "retainUntil", error: new Error("C 暂时不可用") };
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    expect((await rowOf(done.runId, a)).l3).toBe("pass");
  });
  it("音频需求失败 / 不支持 / 超时：该内容 L3 未获取成功，原因对应；不为它们调用 requestScores", async () => {
    const { w, e, planId } = await setup(cfg);
    const f = await content(w, e, "f", { like: 3, verdict: "meets" });
    const n = await content(w, e, "n", { like: 2, verdict: "meets" });
    const u = await content(w, e, "u", { like: 1, verdict: "meets" });
    e.demand.setOutcome(f, "audio", { state: "failed", reason: "download_failed" });
    e.demand.setOutcome(n, "audio", { state: "unsupported", disposition: "content_not_found" });
    e.demand.setOutcome(u, "audio", { state: "unsupported", disposition: "unsupported_platform" });
    const { done } = await exec(e, planId);
    expect(await rowOf(done.runId, f)).toMatchObject({ l3: "unobtained", reasonCode: "demand_failed" });
    expect((await rowOf(done.runId, n)).reasonCode).toBe("content_not_found");
    expect((await rowOf(done.runId, u)).reasonCode).toBe("unsupported_platform");
    expect(e.fake.callsOf("requestScores")).toHaveLength(0);
  });
  it("执行中途能力丢失（网关被关）：剩余内容 capability_disabled，不发调用；第 2 层已定的结果不受影响", async () => {
    const { w, e, planId } = await setup({ ...cfg, layer2: { abilities: [{ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5" }] } });
    const a = await content(w, e, "a", { like: 1, verdict: "meets" });
    e.fake.setValue("content.cover_template_score", a, { state: "valid", usable: true, score: 9 });
    await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1]));
    await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(eq(judgementPlanVersions.planId, planId));
    const r = await e.runs.execute(e.creator, planId, { key: "k" });
    e.fake.blockers = [{ code: "model_unavailable", signal: "content.asr_judgement" }]; // 发布时可执行，之后丢了
    const done = await e.runs.drive(r.runId, "w", e.sleep);
    expect(done.status).toBe("completed");
    expect(await rowOf(done.runId, a)).toMatchObject({ l2: "pass", l3: "unobtained", reasonCode: "capability_disabled" });
    expect(e.fake.callsOf("requestScores").every((c) => (c.args as { only: string[] }).only[0] !== "content.asr_judgement")).toBe(true);
  });
  it("C 在 requestScores 时整批拒绝 not_executable：同样记 capability_disabled，不重试", async () => {
    const { w, e, planId } = await setup(cfg);
    const a = await content(w, e, "a", { like: 1, verdict: "meets" });
    e.fake.failNext = { fn: "requestScores", error: new SignalError("conflict", "not_executable", "监控段当前不可执行", [{ code: "model_unavailable" }]) };
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    expect(await rowOf(done.runId, a)).toMatchObject({ l3: "unobtained", reasonCode: "capability_disabled" });
  });
  it("第 3 层结果还没出：等待；超时记 dependency_timeout", async () => {
    const { w, e, planId } = await setup(cfg);
    const a = await content(w, e, "a", { like: 1 }); // 判定信号没编程 → not_computed
    const { done } = await exec(e, planId);
    expect(await rowOf(done.runId, a)).toMatchObject({ l3: "unobtained", reasonCode: "dependency_timeout" });
  });
  it("评论与第 3 层同时配置：第 3 层不通过的内容仍是评论候选（评论只看 C2）", async () => {
    const { w, e, planId } = await setup({ ...cfg, ...CM({ type: "any" }) });
    const a = await content(w, e, "a", { like: 1, verdict: "not_meets" });
    await comments(e, a, 2, 2);
    const { done } = await exec(e, planId);
    expect(await rowOf(done.runId, a)).toMatchObject({ final: "fail", cmTotal: 2, cmPass: 2 });
    expect(await partOf(done.runId)).toMatchObject({ contentResult: "not_met", commentResult: "success", planResult: "not_met" });
  });
  it("崩溃续跑：已提交的需求不重复提交（同键同批次）", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TEXT }, ...CM() });
    await content(w, e, "a");
    e.demand.pendingGets = 1;
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    expect(e.demand.submitted).toHaveLength(1);
  });
});
