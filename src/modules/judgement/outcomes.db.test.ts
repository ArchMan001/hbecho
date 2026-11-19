// d-rule-engine 任务 9：对 E 的读取口、解释、保留与清理——JP-16 / JP-14。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityPlans, judgementPlanVersions, judgementRuns, mediaStaff, runContents, runParticipants } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { addContent, addListTask, addParticipant, judgementEnv, judgementWorld, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import type { ResourceConstraint } from "../access-control";
import { JudgementError } from "./errors";

const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const CFG = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 2 } } };
const ALL: ResourceConstraint = { empty: false, brands: "all", branches: "all", self: null };
const collect = async <T,>(g: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
};
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return err instanceof JudgementError ? err.code : `非 JudgementError：${String(err)}`;
  }
  return "no_error";
};

async function setup(over: Parameters<typeof judgementEnv>[2] = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, over);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  await e.versions.setConfig(e.creator, planId, CFG);
  return { w, e, planId };
}
async function content(w: JudgementWorld, e: JudgementEnv, id: string, o: { account?: bigint; like?: number; hit?: boolean } = {}) {
  const c = await addContent(t.db, { accountId: o.account ?? w.accZhao, platformContentId: id, kind: "video", like: o.like ?? 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: o.hit === false ? "无关" : "海信新品", normalizerVersion: 1 });
  return c.contentId;
}
async function executeOnce(e: JudgementEnv, planId: bigint, key: string) {
  await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
  const r = await e.runs.execute(e.creator, planId, { key });
  await e.runs.drive(r.runId, "w", e.sleep);
  return r.runId;
}
/** 一个有两名专员（一人成功、一人不达标）的已完成执行。 */
async function twoStaff() {
  const s = await setup();
  const p2 = await addParticipant(t, s.w, "老孙", "13800010031");
  for (const a of [s.w.accZhao, p2.accountId]) await addListTask(t.db, { accountId: a, status: "succeeded", at: day(6) });
  await content(s.w, s.e, "a", { like: 2 });
  await content(s.w, s.e, "b", { like: 1 });
  await content(s.w, s.e, "c", { account: p2.accountId });
  const execId = await executeOnce(s.e, s.planId, "k1");
  return { ...s, p2, execId };
}

describe("JudgementOutcomeReader（JP-16）", () => {
  it("只对 completed 的执行可见：未完成 / 取消 / 失败不出现在 listCompleted，describe 报 execution_not_completed", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    await t.db.update(judgementPlanVersions).set({ wizardStep: "circled" }).where(eq(judgementPlanVersions.planId, planId));
    const r = await e.runs.execute(e.creator, planId, { key: "k" });
    expect(await e.outcomes.listCompleted(null, 10)).toEqual([]);
    expect(await code(e.outcomes.describe(r.runId))).toBe("execution_not_completed");
    await e.runs.cancel(e.creator, r.runId);
    expect(await e.outcomes.listCompleted(null, 10)).toEqual([]);
    expect(await code(e.outcomes.describe(r.runId))).toBe("execution_not_completed");
    expect(await code(e.outcomes.describe(999n))).toBe("execution_not_found");
  });
  it("描述符：计划别名、窗口、冻结时刻 = 数据截止、参与专员数、C1/C2/C3、配置摘要（含能力别名）", async () => {
    const { e, planId, execId } = await twoStaff();
    const d = await e.outcomes.describe(execId);
    expect(d).toMatchObject({ executionId: execId, planId, version: 1, planAlias: "计划 A", platform: "douyin", participantCount: 2, c1: 3, contentTotal: 3, staleUsed: false });
    expect(d.window).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(d.cutoffAt).toEqual(d.frozenAt);
    expect(d.config).toMatchObject({ quantity: 2, contentRequirementEnabled: true, contentThresholdN: 2, abilities: [], commentMethod: null });
  });
  it("能力别名随执行所用版本冻结：之后新版本改别名，旧执行的描述符仍是旧别名", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    await e.versions.setConfig(e.creator, planId, { ...CFG, layer2: { abilities: [{ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5", alias: "旧名" }] } });
    e.fake.setValue("content.cover_template_score", (await t.db.select().from(runContents))[0]?.contentId ?? 0n, { state: "valid", usable: true, score: 9 });
    await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1]));
    const first = await executeOnce(e, planId, "k1");
    await e.versions.newDraft(e.creator, planId);
    await e.versions.setConfig(e.creator, planId, { ...CFG, layer2: { abilities: [{ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5", alias: "新名" }] } });
    expect((await e.outcomes.describe(first)).config.abilities[0]!.alias).toBe("旧名");
  });
  it("参与专员流：条数 = 冻结的参与专员数；成功 + 不达标 + 未获取成功 = 参与专员数；组织链是冻结值", async () => {
    const { w, e, execId } = await twoStaff();
    const ps = await collect(e.outcomes.streamParticipants(execId, ALL));
    expect(ps).toHaveLength(2);
    const r = ps.map((p) => p.results.plan);
    expect(r.filter((x) => x === "success").length + r.filter((x) => x === "not_met").length + r.filter((x) => x === "unobtained").length).toBe(2);
    expect(ps.find((p) => p.staffId === w.staff.zhao)).toMatchObject({ results: { content: "success", plan: "success" }, counts: { c1: 2, c3: 2, p: 2 }, org: { branchId: w.bj, storeId: w.stores.sW1 }, syncComplete: true });
    // 执行之后改绑 / 门店换分公司：流出的组织链不变
    await t.db.update(mediaStaff).set({ storeId: w.stores.sH1 }).where(eq(mediaStaff.staffId, w.staff.zhao)); // 换到上海的门店
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.staffId, w.staff.zhao)))[0]!.storeId).toBe(w.stores.sH1);
    const frozen = (await collect(e.outcomes.streamParticipants(execId, ALL))).find((p) => p.accountId === w.accZhao)!;
    expect(frozen.org).toMatchObject({ branchId: w.bj, storeId: w.stores.sW1 }); // 流出的仍是冻结时的组织链
  });
  it("范围约束：empty → 空；branches 限定；brands 限定；self 只流出本人", async () => {
    const { w, e, execId } = await twoStaff();
    expect(await collect(e.outcomes.streamParticipants(execId, { empty: true, brands: [], branches: [], self: null }))).toHaveLength(0);
    expect(await collect(e.outcomes.streamParticipants(execId, { ...ALL, branches: [w.bj] }))).toHaveLength(2);
    expect(await collect(e.outcomes.streamParticipants(execId, { ...ALL, branches: [w.sh] }))).toHaveLength(0);
    expect(await collect(e.outcomes.streamParticipants(execId, { ...ALL, brands: [w.org.hisenseBrandId] }))).toHaveLength(0);
    const self = await collect(e.outcomes.streamParticipants(execId, { ...ALL, self: { mediaStaffId: w.staff.zhao, storeId: w.stores.sW1 } }));
    expect(self.map((p) => p.staffId)).toEqual([w.staff.zhao]);
    const contents = await collect(e.outcomes.streamContents(execId, { ...ALL, self: { mediaStaffId: w.staff.zhao, storeId: w.stores.sW1 } }));
    expect(contents.map((c) => c.accountId)).toEqual([w.accZhao, w.accZhao]);
  });
  it("内容流：每条参与内容一行，含各层结果、选中标记与点赞；skipped 照常流出且不影响人数恒等式", async () => {
    const { w, e, execId } = await twoStaff();
    const rows = await collect(e.outcomes.streamContents(execId, ALL));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.executionId === execId)).toBe(true);
    expect(rows.find((r) => r.accountId === w.accZhao && r.like.state === "value")).toMatchObject({ final: "pass", layer1: { selected: true } });
  });
  it("skipped 行：第 1 层数量要求没选中的内容带 layer1_not_selected、名次与点赞值", async () => {
    const { w, e, planId } = await setup();
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    for (let i = 0; i < 4; i++) await content(w, e, `c${i}`, { like: i + 1 });
    const execId = await executeOnce(e, planId, "k1");
    const rows = await collect(e.outcomes.streamContents(execId, ALL));
    const skipped = rows.filter((r) => r.final === "skipped");
    expect(skipped).toHaveLength(2);
    expect(skipped.every((r) => r.reasonCode === "layer1_not_selected" && r.layer1.selected === false && r.layer1.rank! > 2 && r.like.state === "value")).toBe(true);
    const ps = await collect(e.outcomes.streamParticipants(execId, ALL));
    expect(ps[0]!.counts).toMatchObject({ skipped: 2, p: 2, c1: 2 });
  });
  it("游标 (完成时间, ID)：并行的执行完成顺序与创建顺序无关，A 先创建后完成时不被漏掉", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    const a = await executeOnce(e, planId, "kA"); // 先建先完成
    // 第二个计划（run_id 更大）更早「完成时间」：直接改时间模拟乱序
    const second = await executeOnce(e, planId, "kB");
    await t.db.update(judgementRuns).set({ completedAt: new Date("2026-11-16T01:00:00Z") }).where(eq(judgementRuns.runId, second));
    await t.db.update(judgementRuns).set({ completedAt: new Date("2026-11-16T03:00:00Z") }).where(eq(judgementRuns.runId, a));
    const first = await e.outcomes.listCompleted(null, 1);
    expect(first.map((d) => d.executionId)).toEqual([second]);
    const next = await e.outcomes.listCompleted({ completedAt: first[0]!.completedAt, executionId: first[0]!.executionId }, 10);
    expect(next.map((d) => d.executionId)).toEqual([a]);
    void w;
  });
  it("活动计划进回收站：listCompleted 与 describe 不再可见；恢复后可见", async () => {
    const { w, e, execId } = await twoStaff();
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000), deletedByActor: "user:7" }).where(eq(activityPlans.planId, w.planId));
    expect(await e.outcomes.listCompleted(null, 10)).toHaveLength(0);
    expect(await code(e.outcomes.describe(execId))).toBe("execution_not_found");
    await t.db.update(activityPlans).set({ status: "collecting", statusBeforeDelete: null, deletedAt: null, purgeAfter: null, deletedByActor: null }).where(eq(activityPlans.planId, w.planId));
    expect(await e.outcomes.listCompleted(null, 10)).toHaveLength(1);
  });
  it("圈定行：只对圈定运行有效；含被选中的、未选中的（skipped）、未通过的行，带结果与原因", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a", { like: 3 });
    await content(w, e, "b", { like: 2 });
    await content(w, e, "c", { like: 1 });
    await content(w, e, "d", { hit: false });
    const c = await e.runs.circle(e.creator, planId);
    const rows = await collect(e.outcomes.streamCircleRows(c.runId, ALL));
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.layers.l1 === "pass" && r.layer1.selected === true)).toHaveLength(c.c1);
    expect(rows.map((r) => r.final).sort()).toEqual([null, null, "fail", "skipped"].sort());
    expect(rows.every((r) => typeof r.staffId === "bigint")).toBe(true);
    expect(await code(collect(e.outcomes.streamParticipants(c.runId, ALL)))).toBe("execution_not_found"); // 圈定运行不是执行
  });
  it("fake E 消费者走完整序列：listCompleted → describe → streams，游标续传不重不漏", async () => {
    const { e, execId } = await twoStaff();
    const seen: bigint[] = [];
    let cursor: { completedAt: Date; executionId: bigint } | null = null;
    for (;;) {
      const page = await e.outcomes.listCompleted(cursor, 1);
      if (page.length === 0) break;
      for (const d of page) {
        seen.push(d.executionId);
        expect(await collect(e.outcomes.streamParticipants(d.executionId, ALL))).toHaveLength(d.participantCount);
        expect(await collect(e.outcomes.streamContents(d.executionId, ALL))).toHaveLength(d.contentTotal);
      }
      cursor = { completedAt: page[0]!.completedAt, executionId: page[0]!.executionId };
    }
    expect(seen).toEqual([execId]);
  });
});

describe("explain（JP-14）", () => {
  it("逐层逐条件：包含用了什么条件、输入、结论、停在哪层、为什么；越范围表现为未找到；没有内容原文", async () => {
    const { w, e, planId } = await setup();
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    const hit = await content(w, e, "hit", { like: 5 });
    const miss = await content(w, e, "miss", { hit: false });
    const execId = await executeOnce(e, planId, "k1");
    const ok = await e.outcomes.explain(e.creator, execId, { contentId: hit });
    expect(ok).toMatchObject({ kind: "content", stoppedAt: null, content: { final: "pass", layer1: { selected: true } } });
    const no = await e.outcomes.explain(e.creator, execId, { contentId: miss });
    expect(no).toMatchObject({ kind: "content", stoppedAt: 1, content: { final: "fail" } });
    expect((no as { steps: Array<{ layer: number; evidence: unknown }> }).steps[1]!.evidence).toEqual([{ idx: 0, state: "fail", hit: [] }]);
    const staff = await e.outcomes.explain(e.creator, execId, { staffId: w.staff.zhao });
    expect(staff).toMatchObject({ kind: "staff", participant: { staffId: w.staff.zhao } });
    expect(JSON.stringify(ok, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(/海信新品|无关/); // 正文原文不出现
    const stranger = { ...e.creator, scope: { ...e.creator.scope, branches: new Set([w.sh]) } };
    expect(await code(e.outcomes.explain(stranger, execId, { contentId: hit }))).toBe("judgement_plan_not_found"); // 越范围表现为未找到
    const noCap = { ...e.creator, capabilities: new Set([...e.creator.capabilities].filter((c) => c !== "data.content.read")) };
    expect(await code(e.outcomes.explain(noCap, execId, { contentId: hit }))).toBe("denied_capability_not_granted");
  });
  it("C 的结果行清理之后解释依然完整（证据自包含，不读 C）", async () => {
    const { w, e, planId } = await setup();
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    const a = await content(w, e, "a");
    const execId = await executeOnce(e, planId, "k1");
    e.fake.calls.length = 0;
    const r = await e.outcomes.explain(e.creator, execId, { contentId: a });
    expect(r.kind).toBe("content");
    expect(e.fake.calls).toHaveLength(0); // explain 不调 C、不调 A
  });
});

describe("maintain（保留与清理）", () => {
  it("圈定 / 试跑运行期满被删（含行）；未期满的保留", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    const c = await e.runs.circle(e.creator, planId);
    expect(await e.outcomes.maintain()).toMatchObject({ expiredRuns: 0 });
    e.clock.advance(31 * 86_400_000);
    expect(await e.outcomes.maintain()).toMatchObject({ expiredRuns: 1 });
    expect(await t.db.select().from(judgementRuns).where(eq(judgementRuns.runId, c.runId))).toHaveLength(0);
    expect(await t.db.select().from(runContents)).toHaveLength(0);
    expect(await e.outcomes.maintain()).toMatchObject({ expiredRuns: 0 }); // 幂等
  });
  it("每个（计划，版本）只保留最近 K 个已完成执行的内容级行；更早的被修剪，参与专员与汇总保留，内容流报 content_rows_pruned", async () => {
    const { w, e, planId } = await setup({ config: { keepContentRuns: 2 } });
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    await content(w, e, "a");
    const ids: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await executeOnce(e, planId, `k${i}`));
      e.clock.advance(1000);
      await t.db.update(judgementRuns).set({ completedAt: e.clock.now() }).where(eq(judgementRuns.runId, ids[i]!));
    }
    expect(await e.outcomes.maintain()).toMatchObject({ prunedExecutions: 1 });
    expect(await t.db.select().from(runContents).where(eq(runContents.runId, ids[0]!))).toHaveLength(0);
    expect(await t.db.select().from(runContents).where(eq(runContents.runId, ids[2]!))).toHaveLength(1);
    expect(await t.db.select().from(runParticipants).where(eq(runParticipants.runId, ids[0]!))).toHaveLength(1);
    expect(await code(collect(e.outcomes.streamContents(ids[0]!, ALL)))).toBe("content_rows_pruned");
    expect(await collect(e.outcomes.streamParticipants(ids[0]!, ALL))).toHaveLength(1);
    expect(await e.outcomes.maintain()).toMatchObject({ prunedExecutions: 0 }); // 幂等
  });
  it("失败 / 取消的执行超过保留天数后清内容级行", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    await t.db.update(judgementPlanVersions).set({ wizardStep: "circled" }).where(eq(judgementPlanVersions.planId, planId));
    const r = await e.runs.execute(e.creator, planId, { key: "k" });
    await e.runs.serveOnce("w");
    await t.db.update(judgementRuns).set({ status: "failed", activeKey: null, completedAt: null, lastErrorCode: "internal_error" }).where(eq(judgementRuns.runId, r.runId));
    e.clock.advance(31 * 86_400_000);
    await t.db.update(judgementRuns).set({ updatedAt: new Date("2026-10-01T00:00:00Z") }).where(eq(judgementRuns.runId, r.runId));
    expect(await e.outcomes.maintain()).toMatchObject({ prunedFailed: 1 });
    expect(await t.db.select().from(runContents).where(eq(runContents.runId, r.runId))).toHaveLength(0);
  });
});

// ---- JP-22：e-metrics-lite 需要的读口扩展与账号能力结果 ---------------------------------------------------------
describe("JP-22 读口扩展", () => {
  it("描述符带有序的条件清单；key 与证据编号一一对应", async () => {
    const { e, execId } = await twoStaff();
    const d = await e.outcomes.describe(execId);
    expect(d.config.conditions).toEqual([{ key: "l1.0", layer: 1, kind: "text", target: null, subject: "content", alias: null }]);
  });
  it("内容行带冻结的内容快照 ID、专员 ID、冻结组织链与白名单证据", async () => {
    const { w, e, execId } = await twoStaff();
    const rows = await collect(e.outcomes.streamContents(execId, ALL));
    const stored = await t.db.select({ id: runContents.contentId, snap: runContents.contentSnapshotId }).from(runContents);
    for (const r of rows) {
      expect(r.contentSnapshotId).toBe(stored.find((x) => x.id === r.contentId)!.snap);
      expect(r.org).toMatchObject({ branchId: w.bj, storeId: w.stores.sW1 });
      expect(r.evidence.l1).toEqual([{ idx: 0, state: "pass", hit: ["海信"] }]);
    }
    expect(rows.find((r) => r.accountId === w.accZhao)!.staffId).toBe(w.staff.zhao);
  });
  it("证据白名单：正文、评论原文、作者、第 3 层模型理由、依赖明细一律不出读口（即使库里的 evidence 里有）", async () => {
    const { e, execId } = await twoStaff();
    await t.db.update(runContents).set({
      evidence: {
        l1: [{ idx: 0, state: "pass", hit: ["海信"], body: "视频正文原文", author: "某作者" }],
        l2: { abilities: [{ id: "a1", kind: "whole_image", target: "cover", state: "pass", score: "7.80", resultId: "9" }] },
        l3: { state: "pass", verdict: "meets", reason: "模型理由里引用了原文", model: "m", promptVersion: 3, resultId: "7" },
        dep: { audio: "ready" },
        cm: { reasons: { x: 1 }, depFailed: false, text: "评论原文" },
        secret: "不该出现",
      } as never,
    }).where(eq(runContents.runId, execId));
    const rows = await collect(e.outcomes.streamContents(execId, ALL));
    const json = JSON.stringify(rows.map((r) => r.evidence), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const bad of ["视频正文原文", "某作者", "模型理由里引用了原文", "评论原文", "不该出现", "promptVersion", "resultId", "dep", "secret"]) expect(json).not.toContain(bad);
    expect(rows[0]!.evidence).toEqual({
      l1: [{ idx: 0, state: "pass", hit: ["海信"] }],
      l2: [{ id: "a1", state: "pass", score: "7.80" }],
      l3: { state: "pass", verdict: "meets" },
    });
  });
  it("没有证据的行（如发布时间缺失）也返回空对象，不返回 null", async () => {
    const { e, execId } = await twoStaff();
    await t.db.update(runContents).set({ evidence: null }).where(eq(runContents.runId, execId));
    expect((await collect(e.outcomes.streamContents(execId, ALL))).every((r) => JSON.stringify(r.evidence) === "{}")).toBe(true);
  });
  it("账号能力结果：执行聚合时写入；第 1 层条件按 at_least_n（N=2）：老赵 2 条通过 → 成功，老孙 1 条 → 不达标", async () => {
    const { w, e, p2, execId } = await twoStaff();
    const ps = await collect(e.outcomes.streamParticipants(execId, ALL));
    expect(ps.find((p) => p.staffId === w.staff.zhao)!.abilityResults).toEqual([{ key: "l1.0", result: "success" }]);
    expect(ps.find((p) => p.staffId === p2.staffId)!.abilityResults).toEqual([{ key: "l1.0", result: "not_met" }]);
  });
  it("账号能力结果只影响展示：四个结果列与改动前同样（成功 / 不达标）", async () => {
    const { w, e, p2, execId } = await twoStaff();
    const ps = await collect(e.outcomes.streamParticipants(execId, ALL));
    expect(ps.find((p) => p.staffId === w.staff.zhao)!.results).toMatchObject({ content: "success", plan: "success" });
    expect(ps.find((p) => p.staffId === p2.staffId)!.results).toMatchObject({ content: "not_met", plan: "not_met" });
  });
  it("旧执行（ability_results 为 NULL）读出 null", async () => {
    const { e, execId } = await twoStaff();
    await t.db.update(runParticipants).set({ abilityResults: null }).where(eq(runParticipants.runId, execId));
    expect((await collect(e.outcomes.streamParticipants(execId, ALL))).every((p) => p.abilityResults === null)).toBe(true);
  });
  it("listContents / listParticipants：总数与流式条数一致；偏移分页稳定；limit=0 只给总数", async () => {
    const { e, execId } = await twoStaff();
    const all = await collect(e.outcomes.streamContents(execId, ALL));
    const p1 = await e.outcomes.listContents(execId, ALL, {}, { offset: 0, limit: 2 });
    const p2 = await e.outcomes.listContents(execId, ALL, {}, { offset: 2, limit: 2 });
    expect(p1.total).toBe(all.length);
    expect([...p1.rows, ...p2.rows].map((r) => r.contentId).sort()).toEqual(all.map((r) => r.contentId).sort());
    expect((await e.outcomes.listContents(execId, ALL, {}, { offset: 0, limit: 0 })).rows).toEqual([]);
    expect((await e.outcomes.listContents(execId, ALL, {}, { offset: 0, limit: 0 })).total).toBe(all.length);
    const parts = await e.outcomes.listParticipants(execId, ALL, {}, { offset: 0, limit: 10 });
    expect(parts.total).toBe(2);
    expect(parts.rows).toHaveLength(2);
    // 排序稳定：重复读取一致
    const again = await e.outcomes.listContents(execId, ALL, {}, { offset: 0, limit: 2 });
    expect(again.rows.map((r) => r.contentId)).toEqual(p1.rows.map((r) => r.contentId));
  });
  it("组织过滤与范围约束同时生效，总数只算范围内；staffIds 为空数组 → 空", async () => {
    const { w, e, p2, execId } = await twoStaff();
    expect((await e.outcomes.listContents(execId, ALL, { branchId: w.bj }, { offset: 0, limit: 50 })).total).toBe(3);
    expect((await e.outcomes.listContents(execId, ALL, { branchId: w.sh }, { offset: 0, limit: 50 })).total).toBe(0);
    expect((await e.outcomes.listContents(execId, ALL, { storeId: w.stores.sW1 }, { offset: 0, limit: 50 })).total).toBe(3);
    expect((await e.outcomes.listContents(execId, ALL, { staffIds: [p2.staffId] }, { offset: 0, limit: 50 })).total).toBe(1);
    expect((await e.outcomes.listContents(execId, ALL, { staffIds: [] }, { offset: 0, limit: 50 })).total).toBe(0);
    const self = { ...ALL, self: { mediaStaffId: w.staff.zhao, storeId: w.stores.sW1 } };
    expect((await e.outcomes.listContents(execId, self, { staffIds: [p2.staffId] }, { offset: 0, limit: 50 })).total).toBe(0); // 范围 ∩ 过滤
    expect((await e.outcomes.listParticipants(execId, self, {}, { offset: 0, limit: 50 })).rows.map((r) => r.staffId)).toEqual([w.staff.zhao]);
    expect((await e.outcomes.listParticipants(execId, { empty: true, brands: [], branches: [], self: null }, {}, { offset: 0, limit: 50 })).total).toBe(0);
    // 流式读口同样接受过滤
    expect(await collect(e.outcomes.streamContents(execId, ALL, { staffIds: [p2.staffId] }))).toHaveLength(1);
    expect(await collect(e.outcomes.streamParticipants(execId, ALL, { storeId: w.stores.sH1 }))).toHaveLength(0);
  });
  it("内容级行已被保留期清理：listContents 报 content_rows_pruned，listParticipants 仍可读（含 abilityResults）", async () => {
    const { e, execId } = await twoStaff();
    await e.outcomes.maintain();
    await t.db.update(judgementRuns).set({ phaseDetail: { contentsPruned: true } as never }).where(eq(judgementRuns.runId, execId));
    expect(await code(e.outcomes.listContents(execId, ALL, {}, { offset: 0, limit: 10 }))).toBe("content_rows_pruned");
    const parts = await e.outcomes.listParticipants(execId, ALL, {}, { offset: 0, limit: 10 });
    expect(parts.total).toBe(2);
    expect(parts.rows.every((p) => p.abilityResults !== null)).toBe(true);
  });
  it("executionsOf：只列 completed 的执行，completed_at 倒序；未完成 / 取消的不出现", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    const a = await executeOnce(e, planId, "kA");
    const b = await executeOnce(e, planId, "kB");
    await t.db.update(judgementRuns).set({ completedAt: new Date("2026-11-16T01:00:00Z") }).where(eq(judgementRuns.runId, a));
    await t.db.update(judgementRuns).set({ completedAt: new Date("2026-11-16T03:00:00Z") }).where(eq(judgementRuns.runId, b));
    expect((await e.outcomes.executionsOf(planId)).map((d) => d.executionId)).toEqual([b, a]);
    expect(await e.outcomes.executionsOf(999n)).toEqual([]);
  });
  it("planRefOf：带活动计划名；不存在 / 活动计划在回收站 → not_found；不判断范围", async () => {
    const { w, e, planId } = await setup();
    const r = await e.outcomes.planRefOf(planId);
    expect(r).toMatchObject({ alias: "计划 A", activityPlanId: w.planId, platform: "douyin" });
    expect(r.activityPlanName.length).toBeGreaterThan(0);
    expect(r.ref.brandId).toBeTypeOf("bigint");
    expect(await code(e.outcomes.planRefOf(999n))).toBe("judgement_plan_not_found");
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000), deletedByActor: "user:7" }).where(eq(activityPlans.planId, w.planId));
    expect(await code(e.outcomes.planRefOf(planId))).toBe("judgement_plan_not_found");
    expect(await e.outcomes.executionsOf(planId)).toEqual([]); // 回收站里的结果不可见
  });
});
