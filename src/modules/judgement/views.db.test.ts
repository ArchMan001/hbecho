// d-rule-engine 任务 13：页面查询服务——列表、新建弹窗的活动计划下拉、详情（design §15.1 / §15.5）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityPlans, judgementPlanVersions, judgementRuns } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { addContent, addListTask, judgementEnv, judgementWorld, userCtx } from "../../../tests/harness/judgement";
import { insertPlan } from "../../../tests/harness/plan";
import { JudgementError } from "./errors";
const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const CFG = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] } };
async function setup() {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "618 主推视频考核", description: "说明" });
  await e.versions.setConfig(e.creator, planId, CFG);
  return { w, e, planId };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof JudgementError ? err.code : `非 JudgementError：${String(err)}`;
  }
  return "no_error";
};
describe("views.list", () => {
  it("带活动计划、品牌、草稿 / 已发布版本与最近执行；字符串 ID；越范围的不出现", async () => {
    const { w, e, planId } = await setup();
    const [a] = await e.views.list(e.creator);
    expect(a).toMatchObject({ planId: String(planId), alias: "618 主推视频考核", description: "说明", status: "active", draft: { version: 1, wizardStep: "draft", publishing: false }, publishedVersion: null, latestExecution: null });
    expect(a!.activityPlan).toMatchObject({ id: String(w.planId), platform: "douyin", brandCode: "HITACHI" });
    expect(a!.activityPlan.name).not.toBe("");
    // 执行一次：版本变已发布、出现最近执行与计划总结果计数
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: "a", kind: "video", like: 1, publishedAt: day(5) });
    e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: "海信新品", normalizerVersion: 1 });
    await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(eq(judgementPlanVersions.planId, planId));
    const r = await e.runs.execute(e.creator, planId, { key: "k" });
    await e.runs.drive(r.runId, "w", e.sleep);
    const [b] = await e.views.list(e.creator);
    expect(b).toMatchObject({ draft: null, publishedVersion: 1, latestExecution: { runId: String(r.runId), status: "completed", version: 1, participants: 1, outcomes: { success: 1, notMet: 0, unobtained: 0 } } });
    // 筛选
    expect(await e.views.list(e.creator, { status: "archived" })).toHaveLength(0);
    expect(await e.views.list(e.creator, { activityPlanId: w.planId })).toHaveLength(1);
    // 越范围（别的品牌）看不到；无 Capability 被拒
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect(await e.views.list(stranger)).toEqual([]);
    expect(await code(e.views.list(userCtx("store_staff", 9, e.creator.scope)))).toMatch(/^denied_/);
  });
  it("在途执行：等待采集 / 等待识别带 waitingOn；失败带稳定错误码", async () => {
    const { e, planId } = await setup();
    await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(eq(judgementPlanVersions.planId, planId));
    const r = await e.runs.execute(e.creator, planId, { key: "k" });
    expect((await e.views.list(e.creator))[0]!.latestExecution).toMatchObject({ status: "planned", waitingOn: null, outcomes: null });
        await t.db.update(judgementRuns).set({ status: "waiting", phaseDetail: { waiting_on: "demand" } }).where(eq(judgementRuns.runId, r.runId));
    expect((await e.views.list(e.creator))[0]!.latestExecution).toMatchObject({ status: "waiting", waitingOn: "demand" });
    await t.db.update(judgementRuns).set({ status: "failed", activeKey: null, lastErrorCode: "internal_error", phaseDetail: null }).where(eq(judgementRuns.runId, r.runId));
    expect((await e.views.list(e.creator))[0]!.latestExecution).toMatchObject({ status: "failed", lastErrorCode: "internal_error", waitingOn: null });
  });
});
describe("views.creatableActivityPlans", () => {
  it("只列采集中、且调用方是创建者的活动计划；超管看到全部采集中的；无写 Capability 被拒", async () => {
    const { w, e } = await setup();
    const mine = await insertPlan(t.db, w.org, { name: "我建的另一个", createdBy: "user:7", joined: [w.bj] });
    await insertPlan(t.db, w.org, { name: "别人建的", createdBy: "user:99", joined: [w.bj] });
    await insertPlan(t.db, w.org, { name: "已暂停", createdBy: "user:7", status: "paused", joined: [w.bj] });
    const names = (await e.views.creatableActivityPlans(e.creator)).map((x) => x.name).sort();
    expect(names).toContain("我建的另一个");
    expect(names).not.toContain("别人建的");
    expect(names).not.toContain("已暂停");
    const adminNames = (await e.views.creatableActivityPlans(e.admin)).map((x) => x.name);
    expect(adminNames).toContain("别人建的");
    expect(adminNames).not.toContain("已暂停");
    expect(await code(e.views.creatableActivityPlans(userCtx("store_staff", 9, e.creator.scope)))).toMatch(/^denied_/);
    expect((await e.views.creatableActivityPlans(e.creator)).find((x) => x.name === "我建的另一个")).toMatchObject({ id: String(mine), platform: "douyin" });
  });
});
describe("views.detail", () => {
  it("版本、显示的版本配置、执行记录、写权限；非创建者只读；越范围 = 不存在", async () => {
    const { w, e, planId } = await setup();
    const d = await e.views.detail(e.creator, planId);
    expect(d).toMatchObject({ planId: String(planId), canWrite: true, createdByActor: "user:7", shown: { version: 1, status: "draft" }, executions: [] });
    expect(d.versions).toMatchObject([{ version: 1, status: "draft", wizardStep: "draft", basedOnVersion: null }]);
    expect(d.shown!.config.layer1.text[0]!.keywords).toEqual(["海信"]);
    expect(d.activity).toMatchObject({ startsOn: expect.any(String) });
    // 同品牌的另一位总部：只读
    const other = await e.views.detail(e.other, planId);
    expect(other.canWrite).toBe(false);
    expect(other.alias).toBe("618 主推视频考核");
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect(await code(e.views.detail(stranger, planId))).toBe("judgement_plan_not_found");
    expect(await code(e.views.detail(e.creator, 999999n))).toBe("judgement_plan_not_found");
    // 活动计划进回收站：不可见
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000), deletedByActor: "user:7" }).where(eq(activityPlans.planId, w.planId));
    expect(await code(e.views.detail(e.creator, planId))).toBe("judgement_plan_not_found");
  });
});

// ---- 任务 14 / 15：向导与执行记录 ------------------------------------------------------------------------------
async function withContent(w: Awaited<ReturnType<typeof judgementWorld>>, e: ReturnType<typeof judgementEnv>) {
  await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
  const hit = await addContent(t.db, { accountId: w.accZhao, platformContentId: "h1", kind: "video", like: 5, publishedAt: day(5) });
  const miss = await addContent(t.db, { accountId: w.accZhao, platformContentId: "h2", kind: "video", like: 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", hit.contentId, { state: "valid", usable: true, value: "海信新品", normalizerVersion: 1 });
  e.fake.setValue("text.title_normalized", miss.contentId, { state: "valid", usable: true, value: "无关", normalizerVersion: 1 });
  return { hit: hit.contentId, miss: miss.contentId };
}
describe("views.wizard", () => {
  it("没有草稿 = null；草稿按进度给出 current；圈定后带圈定摘要；写权限者才有确认执行预览", async () => {
    const { w, e, planId } = await setup();
    await withContent(w, e);
    const v0 = (await e.views.wizard(e.creator, planId))!;
    expect(v0).toMatchObject({ current: 1, circle: null, trial: null, trialRun: null });
    expect(v0.detail.draft).toMatchObject({ version: 1, wizardStep: "draft" });
    await e.runs.circle(e.creator, planId, { sleep: e.sleep });
    const v1 = (await e.views.wizard(e.creator, planId))!;
    // 第 2 页没有比对能力：圈定后直接可进第 3 页
    expect(v1.current).toBe(3);
    expect(v1.circle).toMatchObject({ c1: 1, participants: 1, contents: 2, unobtained: 0 });
    expect(v1.circle!.runId).toMatch(/^\d+$/);
    expect(v1.publish).toMatchObject({ ready: true, blockers: [] });
    // 加一个比对能力 → 圈定后只能进第 2 页，并给出「还没上传素材」
    await e.versions.setConfig(e.creator, planId, { ...CFG, layer2: { abilities: [{ abilityId: "cv", kind: "image_element", target: "cover", threshold: "6.50" }] } });
    await e.runs.circle(e.creator, planId, { sleep: e.sleep });
    const v2 = (await e.views.wizard(e.creator, planId))!;
    expect(v2.current).toBe(2);
    expect(v2.uploaded).toEqual({ cv: false });
    // 只读（同品牌另一位总部）：能看到向导里已有的内容（素材状态、试跑结果），但没有确认执行的预览
    const ro = (await e.views.wizard(e.other, planId))!;
    expect(ro.detail.canWrite).toBe(false);
    expect(ro).toMatchObject({ trial: null, publish: null, uploaded: { cv: false } });
    // 越范围 = 不存在；已发布且没有草稿 = null
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect(await code(e.views.wizard(stranger, planId))).toBe("judgement_plan_not_found");
  });
});
describe("views.executions / executionDetail / participants / staffEvidence", () => {
  async function executed() {
    const s = await setup();
    const ids = await withContent(s.w, s.e);
    await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(eq(judgementPlanVersions.planId, s.planId));
    const r = await s.e.runs.execute(s.e.creator, s.planId, { key: "k" });
    await s.e.runs.drive(r.runId, "w", s.e.sleep);
    return { ...s, ...ids, runId: r.runId };
  }
  it("执行记录：带计划别名与计划总结果；越范围的不出现", async () => {
    const { w, e, planId, runId } = await executed();
    const rows = await e.views.executions(e.creator);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: String(runId), planId: String(planId), alias: "618 主推视频考核", status: "completed", outcomes: { success: 1, notMet: 0, unobtained: 0 } });
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect(await e.views.executions(stranger)).toEqual([]);
  });
  it("执行详情：写权限、冻结的时间窗、同步不完整计数；越范围与不存在一致", async () => {
    const { w, e, runId } = await executed();
    const d = await e.views.executionDetail(e.creator, runId);
    expect(d).toMatchObject({ alias: "618 主推视频考核", canAct: true, syncIncomplete: 0, contentsPruned: false, window: { from: "2026-11-01" } });
    expect((await e.views.executionDetail(e.other, runId)).canAct).toBe(false);
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect(await code(e.views.executionDetail(stranger, runId))).toMatch(/^(judgement_plan_not_found|run_not_found|execution_not_found)$/);
    expect(await code(e.views.executionDetail(e.creator, 999999n))).toBe("run_not_found");
  });
  it("参与专员：带姓名 / 门店 / 分公司，没有手机号；按结果与同步缺口筛选；分页", async () => {
    const { e, runId } = await executed();
    const all = await e.views.participants(e.creator, runId, { filter: "all", offset: 0, limit: 10 });
    expect(all.total).toBe(1);
    expect(all.rows[0]).toMatchObject({ planResult: "success", total: 2, c1: 1, p: 1 });
    expect(all.rows[0]!.name).not.toBe("—");
    expect(JSON.stringify(all.rows)).not.toMatch(/(?<!\d)1[3-9]\d{9}(?!\d)/);
    expect((await e.views.participants(e.creator, runId, { filter: "not_met", offset: 0, limit: 10 })).total).toBe(0);
    expect((await e.views.participants(e.creator, runId, { filter: "sync", offset: 0, limit: 10 })).total).toBe(0);
    expect((await e.views.participants(e.creator, runId, { filter: "all", offset: 5, limit: 10 })).rows).toEqual([]);
  });
  it("证据抽屉：内容级行需要 data.content.read；内容原文不出现；越范围的专员 = 没有找到", async () => {
    const { w, e, runId } = await executed();
    const [p] = (await e.views.participants(e.creator, runId, { filter: "all", offset: 0, limit: 1 })).rows;
    const ev = await e.views.staffEvidence(e.creator, runId, BigInt(p!.staffId));
    expect(ev.pruned).toBe(false);
    expect(ev.contents).toHaveLength(2);
    expect(ev.contents!.map((c) => c.final).sort()).toEqual(["fail", "pass"]);
    expect(JSON.stringify(ev)).not.toContain("海信新品"); // 只有结果与原因码，没有正文 / 归一化文本
    const noRead = { ...e.creator, capabilities: new Set([...e.creator.capabilities].filter((c) => c !== "data.content.read")) } as typeof e.creator;
    expect((await e.views.staffEvidence(noRead, runId, BigInt(p!.staffId))).contents).toBeNull();
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect(await code(e.views.staffEvidence(stranger, runId, BigInt(p!.staffId)))).toMatch(/^(judgement_plan_not_found|explain_target_not_found)$/);
  });
});
