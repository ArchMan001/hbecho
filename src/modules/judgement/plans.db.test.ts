// d-rule-engine 任务 4（plans）：JP-1 验收——活动计划状态限制、创建者谓词、别名唯一、provisioning 恢复、归档、回收站不可见。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityPlans, judgementPlanVersions, judgementPlans } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { expectRejected } from "../../../tests/harness/db";
import { judgementEnv, judgementWorld } from "../../../tests/harness/judgement";
import { JudgementError } from "./errors";

const t = useTestDb();
const setup = async () => {
  const w = await judgementWorld(t);
  return { w, e: judgementEnv(t, w) };
};
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof JudgementError ? e.code : `非 JudgementError：${String(e)}`;
  }
  return "no_error";
};

describe("create", () => {
  it("创建者建出 active 计划与草稿 v1；D 与 C 各一份、计划 ID 相同；时间窗默认拷贝活动计划起止日", async () => {
    const { w, e } = await setup();
    const r = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
    expect(r.version).toBe(1);
    const [p] = await t.db.select().from(judgementPlans).where(eq(judgementPlans.planId, r.planId));
    expect(p).toMatchObject({ status: "active", latestVersion: 1, alias: "计划 A", createdByActor: "user:7" });
    const [v] = await t.db.select().from(judgementPlanVersions).where(eq(judgementPlanVersions.planId, r.planId));
    expect(v).toMatchObject({ status: "draft", wizardStep: "draft", version: 1 });
    expect((v!.config as { window: unknown }).window).toEqual({ from: "2026-11-01" });
    expect(e.fake.callsOf("segments.create")).toHaveLength(1);
    expect((e.fake.callsOf("segments.create")[0]!.args as { planId: bigint }).planId).toBe(r.planId);
    expect(e.audits.map((a) => [a.event, a.risk, a.hasTx])).toEqual([["plan_created", "high", true]]); // 高风险审计与业务写入同事务
  });
  it.each(["paused", "archived", "deleted"] as const)("活动计划为 %s 时被拒，库中没有判定计划行", async (status) => {
    const { w, e } = await setup();
    if (status === "deleted") await t.db.update(activityPlans).set({ status, statusBeforeDelete: "collecting", deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000), deletedByActor: "user:7" }).where(eq(activityPlans.planId, w.planId));
    else await t.db.update(activityPlans).set({ status }).where(eq(activityPlans.planId, w.planId));
    expect(await code(e.plans.create(e.creator, { activityPlanId: w.planId, alias: "X" }))).toBe(status === "deleted" ? "activity_plan_not_found" : "activity_plan_not_collecting");
    expect(await t.db.select().from(judgementPlans)).toHaveLength(0);
  });
  it("非活动计划创建者的 hq_manager 被拒；超管与创建者成功", async () => {
    const { w, e } = await setup();
    expect(await code(e.plans.create(e.other, { activityPlanId: w.planId, alias: "X" }))).toBe("denied_predicate_failed");
    await e.plans.create(e.admin, { activityPlanId: w.planId, alias: "超管建的" });
    await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "创建者建的" });
  });
  it("缺 Capability 先于任何读库被拒（门店专员）", async () => {
    const { w, e } = await setup();
    const staff = { ...e.creator, role: "store_staff" as const, capabilities: new Set<string>() };
    expect(await code(e.plans.create(staff, { activityPlanId: w.planId, alias: "X" }))).toBe("denied_capability_not_granted");
  });
  it("同一活动计划内别名重复被拒；别名首尾空白去掉，空与超长被拒", async () => {
    const { w, e } = await setup();
    await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
    expect(await code(e.plans.create(e.creator, { activityPlanId: w.planId, alias: " 计划 A " }))).toBe("alias_taken");
    expect(await code(e.plans.create(e.creator, { activityPlanId: w.planId, alias: "  " }))).toBe("alias_invalid");
    expect(await code(e.plans.create(e.creator, { activityPlanId: w.planId, alias: "长".repeat(201) }))).toBe("alias_invalid");
    expect(await t.db.select().from(judgementPlans)).toHaveLength(1);
  });
  it("D 已落行、C 调用失败：计划停在 provisioning；reconcile 补齐；C 只有一份草稿", async () => {
    const { w, e } = await setup();
    e.fake.failNext = { fn: "segments.create", error: new Error("C 暂时不可用") };
    await expect(e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" })).rejects.toThrow("C 暂时不可用");
    const [p] = await t.db.select().from(judgementPlans);
    expect(p!.status).toBe("provisioning");
    expect(await code(e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" }))).toBe("alias_taken"); // 重复创建被别名唯一键拒
    expect((await e.plans.reconcile(e.creator)).completed).toEqual([p!.planId]);
    expect((await t.db.select().from(judgementPlans))[0]!.status).toBe("active");
    expect(e.fake.segs.size).toBe(1);
    expect((await e.plans.reconcile(e.creator)).completed).toEqual([]); // 幂等
  });
  it("C 报「已存在」且平台相同视为成功；平台不同报冲突", async () => {
    const { w, e } = await setup();
    const [pre] = await t.db.select({ id: activityPlans.planId }).from(activityPlans); // 为让 planId 可预测：先让 C 里有一份同 ID 的段
    void pre;
    e.fake.failNext = { fn: "segments.create", error: new Error("boom") };
    await expect(e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" })).rejects.toThrow();
    const [p] = await t.db.select().from(judgementPlans);
    await e.fake.segments.create({ actor: "x", capabilities: new Set(), brandScope: "all" }, { planId: p!.planId, platform: "kuaishou" }); // C 里已有、平台不同
    expect(await code(e.plans.reconcile(e.creator, p!.planId))).toBe("segment_platform_mismatch");
    e.fake.segs.clear();
    await e.fake.segments.create({ actor: "x", capabilities: new Set(), brandScope: "all" }, { planId: p!.planId, platform: "douyin" }); // 平台相同
    await e.plans.reconcile(e.creator, p!.planId);
    expect((await t.db.select().from(judgementPlans))[0]!.status).toBe("active");
  });
});

describe("数据库约束", () => {
  it("platform_id 与活动计划不一致被复合外键拒绝", async () => {
    const { w } = await setup();
    await expectRejected(
      t.db.insert(judgementPlans).values({ activityPlanId: w.planId, platformId: 99_999n, alias: "X", status: "active", latestVersion: 1, createdByActor: "user:7", createdAt: new Date(), updatedAt: new Date() }),
      "fk_jp_activity_plan",
    );
  });
});

describe("show / list / archive", () => {
  it("归档后可读；取消归档恢复；provisioning 的不能归档", async () => {
    const { w, e } = await setup();
    const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
    await e.plans.archive(e.creator, planId);
    expect((await e.plans.show(e.creator, planId)).plan.status).toBe("archived");
    expect(e.audits.map((a) => a.event)).toContain("plan_archived");
    await e.plans.archive(e.creator, planId); // 幂等
    await e.plans.unarchive(e.creator, planId);
    expect((await e.plans.show(e.creator, planId)).plan.status).toBe("active");
    e.fake.failNext = { fn: "segments.create", error: new Error("boom") };
    await expect(e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 B" })).rejects.toThrow();
    const [b] = await t.db.select().from(judgementPlans).where(eq(judgementPlans.alias, "计划 B"));
    expect(await code(e.plans.archive(e.creator, b!.planId))).toBe("plan_provisioning");
  });
  it("非创建者不能归档；能读", async () => {
    const { w, e } = await setup();
    const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
    expect(await code(e.plans.archive(e.other, planId))).toBe("denied_predicate_failed");
    expect((await e.plans.show(e.other, planId)).plan.alias).toBe("计划 A");
  });
  it("活动计划进入回收站后，列表与详情都不可见；恢复后可见", async () => {
    const { w, e } = await setup();
    const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
    expect(await e.plans.list(e.creator)).toHaveLength(1);
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000), deletedByActor: "user:7" }).where(eq(activityPlans.planId, w.planId));
    expect(await e.plans.list(e.creator)).toHaveLength(0);
    expect(await code(e.plans.show(e.creator, planId))).toBe("judgement_plan_not_found");
    await t.db.update(activityPlans).set({ status: "collecting", statusBeforeDelete: null, deletedAt: null, purgeAfter: null, deletedByActor: null }).where(eq(activityPlans.planId, w.planId));
    expect(await e.plans.list(e.creator)).toHaveLength(1);
    expect((await e.plans.show(e.creator, planId)).plan.planId).toBe(planId);
  });
  it("越范围的调用方表现为「未找到」，列表里没有它", async () => {
    const { w, e } = await setup();
    const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect(await code(e.plans.show(stranger, planId))).toBe("judgement_plan_not_found");
    expect(await e.plans.list(stranger)).toHaveLength(0);
  });
});
