// d-rule-engine 任务 10：A 的下游端口 PlanDownstream 的 D 实现——JP-17 / acceptance Q1–Q8。
// 其中 Q2 / Q4 / Q6 用 A 的真实 plans.delete / restore 与 maintenance.runNow 接 D 的真实下游（FakeSignals 代替 C）。
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityPlans, judgementPlanVersions, judgementPlans, judgementRuns, runContents, runParticipants } from "../../db/schema";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { useTestDb } from "../../../tests/harness/db";
import { addContent, addListTask, judgementEnv, judgementWorld, T0, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { insertPlan, MemoryPlanAudit, planActor } from "../../../tests/harness/plan";
import { createPlanMaintenance } from "../activity-plan/maintenance";
import { createPlans } from "../activity-plan/plans";
import type { PlanDownstream } from "../activity-plan/downstream";
import { createJudgementDownstream } from "./downstream";
const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const CFG = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 2 } } };
const PURGE_ACTOR = { actor: "service:judgement-purge", capabilities: new Set(["rule.definition.manage"]), brandScope: "all" as const };
const hq = () => planActor("hq", { actor: "user:7" });

async function setup() {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  await e.versions.setConfig(e.creator, planId, CFG);
  const down = createJudgementDownstream({ db: t.db, signals: e.fake.segments, purgeActor: PURGE_ACTOR });
  return { w, e, planId, down };
}
async function content(w: JudgementWorld, e: JudgementEnv, id: string, like = 1) {
  const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: id, kind: "video", like, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: "海信新品", normalizerVersion: 1 });
  return c.contentId;
}
async function submit(e: JudgementEnv, planId: bigint, key: string) {
  await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(eq(judgementPlanVersions.planId, planId));
  return e.runs.execute(e.creator, planId, { key });
}
/** 已完成的执行 + 一个圈定运行（后者的行不算业务结果）。 */
async function withResults() {
  const s = await setup();
  await addListTask(t.db, { accountId: s.w.accZhao, status: "succeeded", at: day(6) });
  await content(s.w, s.e, "a", 2);
  await content(s.w, s.e, "b", 1);
  await s.e.runs.circle(s.e.creator, s.planId);
  const r = await submit(s.e, s.planId, "k1");
  await s.e.runs.drive(r.runId, "w", s.e.sleep);
  return { ...s, execId: r.runId };
}
const rowCount = async (table: typeof judgementPlans | typeof judgementPlanVersions | typeof judgementRuns | typeof runParticipants | typeof runContents) => Number((await t.db.select({ n: count() }).from(table))[0]!.n);
const dRows = async () => ({ plans: await rowCount(judgementPlans), versions: await rowCount(judgementPlanVersions), runs: await rowCount(judgementRuns), participants: await rowCount(runParticipants), contents: await rowCount(runContents) });

describe("summarize（Q1）", () => {
  it("没有判定计划 → 全 0", async () => {
    const { down } = await setup();
    expect(await down.summarize(999_999n)).toEqual({ judgementPlans: 0, results: 0, running: 0 });
  });
  it("在途数随运行状态变化；results 只数已完成执行的参与专员行（不含圈定 / 试跑）", async () => {
    const { w, e, planId, down } = await withResults();
    // 已有：1 个圈定运行（completed，带参与专员行）+ 1 个已完成执行（1 名参与专员）
    expect(await down.summarize(w.planId)).toEqual({ judgementPlans: 1, results: 1, running: 0 });
    const r = await submit(e, planId, "k2"); // planned
    expect(await down.summarize(w.planId)).toMatchObject({ running: 1, results: 1 });
    await e.runs.cancel(e.creator, r.runId);
    expect(await down.summarize(w.planId)).toMatchObject({ running: 0, results: 1 });
  });
});

describe("purge（Q3 / Q4 / Q8）", () => {
  it("删除全部 D 行并只调用 segments.purge；第二次调用无副作用", async () => {
    const { w, e, planId, down } = await withResults();
    expect((await dRows()).participants).toBeGreaterThan(0);
    e.fake.calls.length = 0;
    await down.purge(w.planId);
    expect(await dRows()).toEqual({ plans: 0, versions: 0, runs: 0, participants: 0, contents: 0 });
    expect(e.fake.calls.map((c) => c.fn)).toEqual(["segments.purge"]); // Q8：不调用任何 C 的清理器
    expect(e.fake.callsOf("segments.purge")[0]!.args).toBe(planId);
    expect(e.fake.segs.size).toBe(0);
    e.fake.calls.length = 0;
    await down.purge(w.planId);
    expect(e.fake.calls).toHaveLength(0);
    expect(await dRows()).toEqual({ plans: 0, versions: 0, runs: 0, participants: 0, contents: 0 });
  });
  it("C 失败：抛出且 D 的行原样保留；重试完成", async () => {
    const { w, e, down } = await withResults();
    const before = await dRows();
    e.fake.failNext = { fn: "segments.purge", error: new Error("C 暂时不可用") };
    await expect(down.purge(w.planId)).rejects.toThrow("C 暂时不可用");
    expect(await dRows()).toEqual(before);
    await down.purge(w.planId);
    expect((await dRows()).plans).toBe(0);
  });
  it("多个判定计划：全部清除；别的活动计划的判定计划不受影响", async () => {
    const { w, e, down } = await withResults();
    await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 B" });
    const otherActivity = await insertPlan(t.db, w.org, { name: "另一个活动", createdBy: "user:7" });
    const keep = await e.plans.create(e.creator, { activityPlanId: otherActivity, alias: "别处" });
    await down.purge(w.planId);
    expect((await t.db.select().from(judgementPlans)).map((p) => p.planId)).toEqual([keep.planId]);
  });
});

describe("onDeleted / onRestored（Q5）", () => {
  it("重复调用无副作用", async () => {
    const { w, e, down } = await withResults();
    const before = await dRows();
    e.fake.calls.length = 0;
    for (let i = 0; i < 3; i++) {
      await down.onDeleted(w.planId);
      await down.onRestored(w.planId);
    }
    expect(await dRows()).toEqual(before);
    expect(e.fake.calls).toHaveLength(0);
  });
});

/** 与 A 的真实 plans / maintenance 联动；下游外面包一层记录顺序。 */
async function withA() {
  const s = await withResults();
  const order: string[] = [];
  const recording: PlanDownstream = {
    summarize: async (id) => (order.push("summarize"), s.down.summarize(id)),
    onDeleted: async (id) => (order.push("onDeleted"), s.down.onDeleted(id)),
    onRestored: async (id) => (order.push("onRestored"), s.down.onRestored(id)),
    purge: async (id) => (order.push("purge"), s.down.purge(id)),
  };
  const aClock = new FakeClock(T0);
  const audit = new MemoryPlanAudit();
  const aPlans = createPlans({ db: t.db, clock: aClock, audit: audit.sink, downstream: recording });
  const maintClock = new FakeClock(new Date(T0.getTime() + 31 * 86_400_000));
  const maint = createPlanMaintenance({ db: t.db, clock: maintClock, downstream: recording, audit: audit.sink });
  return { ...s, order, aPlans, maint };
}

describe("与 A 的真实 plans / maintenance 联动（Q2 / Q4 / Q5 / Q6 / Q7）", () => {
  it("有在途 → 删除被拒；取消后可删；顺序 summarize → onDeleted；删除后结果不可读，恢复后可读", async () => {
    const { w, e, planId, aPlans, order } = await withA();
    const r = await submit(e, planId, "k2");
    await expect(aPlans.delete(hq(), w.planId, { apply: true })).rejects.toMatchObject({ code: "downstream_running" });
    expect((await t.db.select().from(activityPlans).where(eq(activityPlans.planId, w.planId)))[0]!.status).not.toBe("deleted");
    await e.runs.cancel(e.creator, r.runId);
    expect(await e.outcomes.listCompleted(null, 10)).toHaveLength(1);
    order.length = 0;
    await aPlans.delete(hq(), w.planId, { apply: true });
    expect(order).toEqual(["summarize", "onDeleted"]);
    expect(await e.outcomes.listCompleted(null, 10)).toHaveLength(0); // 回收站里不返回其结果
    await aPlans.restore(hq(), w.planId);
    expect(await e.outcomes.listCompleted(null, 10)).toHaveLength(1);
  });
  it("期满 → purge → 删除活动计划；D 的行与 C 监控段一并清掉", async () => {
    const { w, e, aPlans, maint, order } = await withA();
    await aPlans.delete(hq(), w.planId, { apply: true });
    order.length = 0;
    const rep = await maint.runNow();
    expect(rep).toMatchObject({ purged: 1, purgeFailed: [] });
    expect(order).toEqual(["purge"]);
    expect(await t.db.select().from(activityPlans).where(eq(activityPlans.planId, w.planId))).toHaveLength(0);
    expect(await dRows()).toEqual({ plans: 0, versions: 0, runs: 0, participants: 0, contents: 0 });
    expect(e.fake.segs.size).toBe(0);
  });
  it("purge 中途失败：A 不清除活动计划；下一次维护重试完成", async () => {
    const { w, e, aPlans, maint } = await withA();
    await aPlans.delete(hq(), w.planId, { apply: true });
    e.fake.failNext = { fn: "segments.purge", error: new Error("C 暂时不可用") };
    const first = await maint.runNow();
    expect(first.purged).toBe(0);
    expect(first.purgeFailed).toEqual([w.planId.toString()]);
    expect((await t.db.select().from(activityPlans).where(eq(activityPlans.planId, w.planId)))[0]!.status).toBe("deleted");
    expect((await dRows()).plans).toBe(1);
    const second = await maint.runNow();
    expect(second.purged).toBe(1);
    expect(await dRows()).toEqual({ plans: 0, versions: 0, runs: 0, participants: 0, contents: 0 });
  });
  it("D 未清除时物理删除活动计划被外键拒绝，不留孤儿（Q7）", async () => {
    const { w } = await withA();
    await expect(t.db.delete(activityPlans).where(eq(activityPlans.planId, w.planId))).rejects.toThrow();
    expect((await dRows()).plans).toBe(1);
  });
});
