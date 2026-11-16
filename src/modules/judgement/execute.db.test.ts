// d-rule-engine 任务 7：执行（第 1、2 层 + 账号要求）——JP-3（确认执行即发布）、JP-9（专员级达标与零内容）、JP-8、JP-11、JP-15。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityPlans, externalAccounts, judgementPlanVersions, judgementRuns, runContents, runParticipants, staffAccountAssignments } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertBatch, insertProfileSnapshot } from "../../../tests/harness/factories";
import { addContent, addListTask, addParticipant, judgementEnv, judgementWorld, T0, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { JudgementError } from "./errors";

const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const ab = (o: Record<string, unknown> = {}) => ({ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5", ...o });
const TEXT = { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] };
const BASE = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { ...TEXT, quantity: { n: 2 } } };

async function setup(cfg: unknown = BASE, over: Parameters<typeof judgementEnv>[2] = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, over);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  await e.versions.setConfig(e.creator, planId, cfg);
  return { w, e, planId };
}
/** 内容 + 文本信号（title 命中与否由 hit 决定）。 */
async function content(w: JudgementWorld, e: JudgementEnv, id: string, o: { account?: bigint; like?: number; hit?: boolean; score?: number | "pending" } = {}) {
  const c = await addContent(t.db, { accountId: o.account ?? w.accZhao, platformContentId: id, kind: "video", like: o.like ?? 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: o.hit === false ? "无关" : "海信新品", normalizerVersion: 1 });
  if (o.score === "pending") e.fake.setValue("content.cover_template_score", c.contentId, { state: "missing", usable: false, reason: "media_pending" });
  else if (o.score !== undefined) e.fake.setValue("content.cover_template_score", c.contentId, { state: "valid", usable: true, score: o.score });
  return c.contentId;
}
const syncOk = (accountId: bigint) => addListTask(t.db, { accountId, status: "succeeded", at: day(6) });
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return err instanceof JudgementError ? err.code : `非 JudgementError：${String(err)}`;
  }
  return "no_error";
};
/** 发布并执行，驱动到终态。 */
async function run(e: JudgementEnv, planId: bigint, key = "k1") {
  await e.versions.setConfig; // 进度：直接置 circled（圈定本身在 circle.db 里证明）
  await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
  const r = await e.runs.execute(e.creator, planId, { key });
  const done = await e.runs.drive(r.runId, "w", e.sleep);
  return { ...r, done };
}
const partOf = async (runId: bigint, accountId: bigint) => (await t.db.select().from(runParticipants).where(and(eq(runParticipants.runId, runId), eq(runParticipants.accountId, accountId))))[0]!;

describe("专员级结果（JP-9，经 PRD §六的各情形）", () => {
  it("N=2：点赞前 2 条都通过 → 成功；只有 1 条命中 → 不达标；没有任何命中 → 不达标（不走零内容）；一条也没发且同步完整 → 不达标", async () => {
    const { w, e, planId } = await setup();
    const p2 = await addParticipant(t, w, "老孙", "13800010041");
    const p3 = await addParticipant(t, w, "老周", "13800010042");
    const p4 = await addParticipant(t, w, "老吴", "13800010043");
    for (const a of [w.accZhao, p2.accountId, p3.accountId, p4.accountId]) await syncOk(a);
    await content(w, e, "a1", { like: 30 });
    await content(w, e, "a2", { like: 20 });
    await content(w, e, "a3", { like: 10, hit: false });
    await content(w, e, "b1", { account: p2.accountId });
    await content(w, e, "c1", { account: p3.accountId, hit: false });
    await content(w, e, "c2", { account: p3.accountId, hit: false });
    const { done } = await run(e, planId);
    expect(done.status).toBe("completed");
    const r = done.runId;
    expect(await partOf(r, w.accZhao)).toMatchObject({ contentResult: "success", planResult: "success", contentPass: 2, contentFail: 1, contentSkipped: 0, c1Count: 2, c2Count: 2, c3Count: 2, state: "done" });
    expect(await partOf(r, p2.accountId)).toMatchObject({ contentResult: "not_met", planResult: "not_met", contentPass: 1, c1Count: 1 });
    expect(await partOf(r, p3.accountId)).toMatchObject({ contentResult: "not_met", contentTotal: 2, contentFail: 2, c1Count: 0 });
    expect(await partOf(r, p4.accountId)).toMatchObject({ contentResult: "not_met", contentTotal: 0 });
    // 恒等式：成功 + 不达标 + 未获取成功 = 参与专员数；每个成功的专员在参与专员里
    const ps = await t.db.select().from(runParticipants).where(eq(runParticipants.runId, r));
    expect(ps).toHaveLength(4);
    expect(ps.every((p) => p.planResult !== null && p.state === "done")).toBe(true);
    expect(done).toMatchObject({ participantCount: 4, c1Count: 3, c2Count: 3, c3Count: 3, completedAt: expect.any(Date), activeKey: null });
  });
  it("零内容：同步完整 → 不达标；同步失败 / 有缺口 → 未获取成功并带原因；参与内容 10 条都没命中话题 + 同步有缺口 → 仍是不达标", async () => {
    const { w, e, planId } = await setup();
    const failed = await addParticipant(t, w, "老孙", "13800010051");
    const gap = await addParticipant(t, w, "老周", "13800010052");
    const noHit = await addParticipant(t, w, "老吴", "13800010053");
    await syncOk(w.accZhao);
    await addListTask(t.db, { accountId: failed.accountId, status: "failed", at: day(7) });
    await addListTask(t.db, { accountId: gap.accountId, status: "succeeded_with_gap", at: day(7) });
    await addListTask(t.db, { accountId: noHit.accountId, status: "succeeded_with_gap", at: day(7) });
    for (let i = 0; i < 10; i++) await content(w, e, `n${i}`, { account: noHit.accountId, hit: false });
    const { done } = await run(e, planId);
    const r = done.runId;
    expect(await partOf(r, w.accZhao)).toMatchObject({ contentResult: "not_met", syncComplete: true });
    expect(await partOf(r, failed.accountId)).toMatchObject({ contentResult: "unobtained", planResult: "unobtained", primaryReason: "sync_failed", syncComplete: false });
    expect(await partOf(r, gap.accountId)).toMatchObject({ contentResult: "unobtained", primaryReason: "sync_gap" });
    expect(await partOf(r, noHit.accountId)).toMatchObject({ contentResult: "not_met", planResult: "not_met", contentFail: 10, syncComplete: false, syncReason: "sync_gap" });
  });
  it("N=2：1 条通过 + 1 条第 2 层素材 pending → 未获取成功（不是不达标）；第 2 层不通过 → 不达标；第 6 名不替补", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer2: { abilities: [ab()] } });
    const p2 = await addParticipant(t, w, "老孙", "13800010061");
    const p3 = await addParticipant(t, w, "老周", "13800010062");
    for (const a of [w.accZhao, p2.accountId, p3.accountId]) await syncOk(a);
    await content(w, e, "a1", { like: 30, score: 9 });
    await content(w, e, "a2", { like: 20, score: "pending" });
    await content(w, e, "a3", { like: 10, score: 9 }); // 第 3 名：被数量要求截掉，不会替补
    await content(w, e, "b1", { account: p2.accountId, like: 30, score: 9 });
    await content(w, e, "b2", { account: p2.accountId, like: 20, score: 2 }); // 第 2 层不通过
    await content(w, e, "b3", { account: p2.accountId, like: 10, score: 9 });
    await content(w, e, "c1", { account: p3.accountId, like: 30, score: 9 });
    await content(w, e, "c2", { account: p3.accountId, like: 20, score: 8 });
    await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1]));
    const { done } = await run(e, planId);
    const r = done.runId;
    expect(await partOf(r, w.accZhao)).toMatchObject({ contentResult: "unobtained", primaryReason: "media_pending", contentPass: 1, contentUnobtained: 1, contentSkipped: 1, c1Count: 2, c2Count: 1, c3Count: 1 });
    expect(await partOf(r, p2.accountId)).toMatchObject({ contentResult: "not_met", contentPass: 1, contentFail: 1, contentSkipped: 1 });
    expect(await partOf(r, p3.accountId)).toMatchObject({ contentResult: "success", c2Count: 2, c3Count: 2 });
  });
  it("第 2 层未获取成功的内容不进入后续：没有为它们发过额外请求；只对选中的 N 条请求比对", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer2: { abilities: [ab()] } });
    await syncOk(w.accZhao);
    for (let i = 0; i < 4; i++) await content(w, e, `c${i}`, { like: i, score: 9 });
    await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1]));
    await run(e, planId);
    expect(e.fake.callsOf("requestScores").flatMap((c) => (c.args as { subjects: string[] }).subjects)).toHaveLength(2);
  });
});

describe("账号要求与计划总结果（JP-9 / JP-11）", () => {
  const AVATAR = { window: BASE.window, kinds: ["video"], layer2: { abilities: [ab({ abilityId: "av1", target: "avatar" })] } };
  async function withProfile(w: JudgementWorld) {
    const batchId = await insertBatch(t.db, T0);
    const [asg] = await t.db.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.accountId, w.accZhao));
    const id = await insertProfileSnapshot(t.db, { batchId, accountId: w.accZhao, assignmentId: asg!.assignmentId, now: T0 });
    await t.db.update(externalAccounts).set({ currentProfileSnapshotId: id }).where(eq(externalAccounts.accountId, w.accZhao));
  }
  it("只考账号（头像）：内容要求不启用，内容结果为空；计划总结果 = 账号结果；分数等于阈值判通过", async () => {
    const { w, e, planId } = await setup(AVATAR);
    await withProfile(w);
    await e.versions.putTemplate(e.creator, planId, "av1", new Uint8Array([1]));
    e.fake.setValue("account.avatar_template_score", w.accZhao, { state: "valid", usable: true, score: 6.5 });
    const { done } = await run(e, planId);
    expect(await partOf(done.runId, w.accZhao)).toMatchObject({ contentResult: null, contentTotal: null, accountResult: "success", planResult: "success" });
  });
  it("账号分数不够 → 不达标；内容与账号各自出结果、总结果不达标", async () => {
    const a = await setup({ ...AVATAR, layer1: { ...TEXT } });
    await withProfile(a.w);
    await a.e.versions.putTemplate(a.e.creator, a.planId, "av1", new Uint8Array([1]));
    a.e.fake.setValue("account.avatar_template_score", a.w.accZhao, { state: "valid", usable: true, score: 3 });
    await syncOk(a.w.accZhao);
    const r1 = (await run(a.e, a.planId)).done.runId;
    expect(await partOf(r1, a.w.accZhao)).toMatchObject({ accountResult: "not_met", contentResult: "not_met", planResult: "not_met" });
  });
  it("没有主页快照 → 账号要求未获取成功 no_profile_snapshot", async () => {
    const b = await setup(AVATAR);
    await b.e.versions.putTemplate(b.e.creator, b.planId, "av1", new Uint8Array([1]));
    const r2 = (await run(b.e, b.planId)).done.runId;
    expect(await partOf(r2, b.w.accZhao)).toMatchObject({ accountResult: "unobtained", planResult: "unobtained", primaryReason: "no_profile_snapshot" });
  });
  it("内容成功 + 账号未获取成功 → 计划总结果未获取成功", async () => {
    const a = await setup({ ...AVATAR, layer1: { ...TEXT, quantity: { n: 1 } } });
    await syncOk(a.w.accZhao);
    await content(a.w, a.e, "x", { like: 1 });
    await a.e.versions.putTemplate(a.e.creator, a.planId, "av1", new Uint8Array([1]));
    const r1 = (await run(a.e, a.planId)).done.runId;
    expect(await partOf(r1, a.w.accZhao)).toMatchObject({ contentResult: "success", accountResult: "unobtained", planResult: "unobtained" });
  });
  it("内容不达标 + 账号成功 → 不达标（不达标优先）", async () => {
    const b = await setup({ ...AVATAR, layer1: { ...TEXT, quantity: { n: 1 } } });
    await withProfile(b.w);
    await syncOk(b.w.accZhao);
    await content(b.w, b.e, "x", { hit: false });
    await b.e.versions.putTemplate(b.e.creator, b.planId, "av1", new Uint8Array([1]));
    b.e.fake.setValue("account.avatar_template_score", b.w.accZhao, { state: "valid", usable: true, score: 9 });
    const r2 = (await run(b.e, b.planId)).done.runId;
    expect(await partOf(r2, b.w.accZhao)).toMatchObject({ contentResult: "not_met", accountResult: "success", planResult: "not_met" });
  });
});

describe("确认执行与重新执行（JP-3）", () => {
  const ready = async () => {
    const s = await setup();
    await syncOk(s.w.accZhao);
    await content(s.w, s.e, "a");
    await t.db.update(judgementPlanVersions).set({ wizardStep: "circled" }).where(eq(judgementPlanVersions.planId, s.planId));
    return s;
  };
  it("草稿确认执行 = 发布为 v1 并在同一事务里建执行运行；之后再执行两次不升版：一个已发布版本、三次执行", async () => {
    const { e, planId } = await ready();
    const first = await e.runs.execute(e.creator, planId, { key: "k1" });
    expect(first).toMatchObject({ version: 1, created: true });
    expect((await t.db.select().from(judgementPlanVersions))[0]!.status).toBe("published");
    expect((await e.runs.drive(first.runId, "w", e.sleep)).status).toBe("completed");
    const second = await e.runs.execute(e.creator, planId, { key: "k2" });
    expect((await e.runs.drive(second.runId, "w", e.sleep)).status).toBe("completed");
    const third = await e.runs.execute(e.creator, planId, { key: "k3" });
    expect((await e.runs.drive(third.runId, "w", e.sleep)).status).toBe("completed");
    expect(await t.db.select().from(judgementPlanVersions)).toHaveLength(1);
    expect((await t.db.select().from(judgementRuns).where(eq(judgementRuns.runKind, "execution"))).map((r) => r.version)).toEqual([1, 1, 1]);
    expect(e.audits.filter((a) => a.event === "execution_started").every((a) => a.risk === "high" && a.hasTx)).toBe(true);
  });
  it("同幂等键重复提交只一个运行（含发布后的第二次「确认」）；换键则同版本已有未终态运行 → run_active", async () => {
    const { e, planId } = await ready();
    const a = await e.runs.execute(e.creator, planId, { key: "same" });
    const b = await e.runs.execute(e.creator, planId, { key: "same" });
    expect(b).toEqual({ version: 1, runId: a.runId, created: false });
    expect(await code(e.runs.execute(e.creator, planId, { key: "other" }))).toBe("run_active");
    expect(await t.db.select().from(judgementRuns)).toHaveLength(1);
  });
  it("新建草稿改阈值再确认 → 版本 +1，旧版本及其执行仍可读", async () => {
    const { e, planId } = await ready();
    const a = await e.runs.execute(e.creator, planId, { key: "k1" });
    await e.runs.drive(a.runId, "w", e.sleep);
    await e.versions.newDraft(e.creator, planId);
    await t.db.update(judgementPlanVersions).set({ wizardStep: "circled" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
    const b = await e.runs.execute(e.creator, planId, { key: "k2" });
    expect(b.version).toBe(2);
    expect((await t.db.select().from(judgementRuns).where(eq(judgementRuns.runId, a.runId)))[0]!.status).toBe("completed");
  });
  it("归档的判定计划被拒；非创建者被拒；暂停的活动计划仍可手动执行", async () => {
    const { w, e, planId } = await ready();
    expect(await code(e.runs.execute(e.other, planId, { key: "k" }))).toBe("denied_predicate_failed");
    await t.db.update(activityPlans).set({ status: "paused" }).where(eq(activityPlans.planId, w.planId));
    const r = await e.runs.execute(e.creator, planId, { key: "k1" });
    expect((await e.runs.drive(r.runId, "w", e.sleep)).status).toBe("completed");
    await e.plans.archive(e.creator, planId);
    expect(await code(e.runs.execute(e.creator, planId, { key: "k2" }))).toBe("plan_archived");
  });
  it("对已发布版本重新执行时能力不可执行 → 被拒并带阻塞项，不建运行", async () => {
    const { e, planId } = await ready();
    const a = await e.runs.execute(e.creator, planId, { key: "k1" });
    await e.runs.drive(a.runId, "w", e.sleep);
    e.fake.blockers = [{ code: "capability_disabled", signal: "content.cover_template_score" }];
    expect(await code(e.runs.execute(e.creator, planId, { key: "k2" }))).toBe("not_executable");
    expect(await t.db.select().from(judgementRuns)).toHaveLength(1);
  });
  it("第 3 层 / 评论要求在任务 8 之前显式失败（not_implemented），不把「没做」写成「通过」", async () => {
    const { w, e, planId } = await setup({ ...BASE, commentRequirement: { mode: "any", keywords: ["安装"], method: { type: "any" } } });
    await syncOk(w.accZhao);
    await content(w, e, "a");
    const { done } = await run(e, planId);
    expect(done).toMatchObject({ status: "failed", lastErrorCode: "not_implemented" });
  });
});

describe("可复现与取消", () => {
  it("同一冻结输入跑两次，参与专员与内容行逐行相同", async () => {
    const { w, e, planId } = await setup();
    await syncOk(w.accZhao);
    for (let i = 0; i < 4; i++) await content(w, e, `c${i}`, { like: i + 1 });
    const a = (await run(e, planId, "k1")).done.runId;
    const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ runId: _r, ...rest }) => JSON.stringify(rest, (_k, v) => (typeof v === "bigint" ? String(v) : v))).sort();
    const rowsA = strip(await t.db.select().from(runContents).where(eq(runContents.runId, a)));
    const partsA = strip(await t.db.select().from(runParticipants).where(eq(runParticipants.runId, a)));
    const second = await e.runs.execute(e.creator, planId, { key: "k2" });
    await e.runs.drive(second.runId, "w", e.sleep);
    expect(strip(await t.db.select().from(runContents).where(eq(runContents.runId, second.runId)))).toEqual(rowsA);
    expect(strip(await t.db.select().from(runParticipants).where(eq(runParticipants.runId, second.runId)))).toEqual(partsA);
  });
  it("取消后不再被领取；serveOnce 领取并推进所有可领取的运行", async () => {
    const { w, e, planId } = await setup();
    await syncOk(w.accZhao);
    await content(w, e, "a");
    await t.db.update(judgementPlanVersions).set({ wizardStep: "circled" }).where(eq(judgementPlanVersions.planId, planId));
    const r = await e.runs.execute(e.creator, planId, { key: "k1" });
    expect(await e.runs.cancel(e.creator, r.runId)).toBe(true);
    expect((await e.runs.serveOnce("w")).ticks).toBe(0);
    const again = await e.runs.execute(e.creator, planId, { key: "k2" });
    const { ticks } = await e.runs.serveOnce("w");
    expect(ticks).toBeGreaterThan(0);
    expect((await t.db.select().from(judgementRuns).where(eq(judgementRuns.runId, again.runId)))[0]!.status).toBe("completed");
    expect(e.audits.some((a) => a.event === "run_cancelled" && a.risk === "high")).toBe(true);
  });
});
