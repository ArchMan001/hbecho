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
