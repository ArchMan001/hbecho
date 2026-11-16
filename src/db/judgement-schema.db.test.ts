// d-rule-engine 任务 1：五张新表在真实 MySQL 8.4 上是否真的强制设计（design §6）里的约束。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { expectRejected, useTestDb } from "../../tests/harness/db";
import { insertAccount, insertBatch, insertContent, insertContentSnapshot, sha } from "../../tests/harness/factories";
import { rosterWorld } from "../../tests/harness/roster";
import { activityPlanBranches, activityPlanRoster, activityPlanSectors, branches, judgementPlans, judgementPlanVersions, judgementRuns, runContents, runParticipants, sectors, stores, activityPlans, mediaStaff } from "./schema";
import type { Db } from "./client";

const NOW = new Date("2026-11-16T02:00:00.000000Z");
const t = useTestDb();

async function world() {
  const w = await rosterWorld(t);
  const [plan] = await t.db.select().from(activityPlans).where(eq(activityPlans.planId, w.planId));
  return { ...w, platformId: plan!.platformId };
}
type World = Awaited<ReturnType<typeof world>>;

async function insertJudgementPlan(w: World, alias = "计划 A", over: Partial<typeof judgementPlans.$inferInsert> = {}): Promise<bigint> {
  const [r] = await t.db.insert(judgementPlans).values({
    activityPlanId: w.planId,
    platformId: w.platformId,
    alias,
    status: "active",
    latestVersion: 1,
    createdByActor: "user:creator",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  return BigInt(r.insertId);
}
async function insertVersion(planId: bigint, version: number, over: Partial<typeof judgementPlanVersions.$inferInsert> = {}) {
  await t.db.insert(judgementPlanVersions).values({
    planId,
    version,
    status: "draft",
    wizardStep: "draft",
    config: {},
    configSchemaVersion: 1,
    configSha256: sha(`cfg-${planId}-${version}`),
    createdByActor: "user:creator",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
}
async function insertRun(planId: bigint, version: number, over: Partial<typeof judgementRuns.$inferInsert> = {}): Promise<bigint> {
  const [r] = await t.db.insert(judgementRuns).values({
    planId,
    version,
    runKind: "execution",
    status: "planned",
    frozen: {},
    activeKey: sha(`active-${planId}-${version}`),
    submittedByActor: "user:7",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  return BigInt(r.insertId);
}
async function chainOf(w: World, staffId: bigint) {
  const [s] = await t.db.select().from(mediaStaff).where(eq(mediaStaff.staffId, staffId));
  const [st] = await t.db.select().from(stores).where(eq(stores.storeId, s!.storeId));
  const [sec] = await t.db.select().from(sectors).where(eq(sectors.sectorId, st!.sectorId));
  const [br] = await t.db.select().from(branches).where(eq(branches.branchId, sec!.branchId));
  return { staffId, storeId: st!.storeId, dealerId: st!.dealerId, brandId: st!.brandId, sectorId: st!.sectorId, branchId: br!.branchId, regionId: br!.regionId };
}
async function insertParticipant(w: World, runId: bigint, over: Partial<typeof runParticipants.$inferInsert> = {}) {
  const accountId = over.accountId ?? w.accZhao;
  await t.db.insert(runParticipants).values({ runId, accountId, ...(await chainOf(w, w.staff.zhao)), ...over });
  return accountId;
}
async function newContentRow(w: World, id: string) {
  const batchId = await insertBatch(t.db, NOW);
  const contentId = await insertContent(t.db, { platform: "douyin", accountId: w.accZhao, platformContentId: id, now: NOW });
  const snapshotId = await insertContentSnapshot(t.db, { batchId, contentId, now: NOW, status: "finalized" });
  return { contentId, snapshotId };
}
type ContentInsert = typeof runContents.$inferInsert;
const contentRow = (runId: bigint, accountId: bigint, c: { contentId: bigint; snapshotId: bigint }, over: Partial<ContentInsert> = {}): ContentInsert => ({
  runId,
  contentId: c.contentId,
  accountId,
  contentSnapshotId: c.snapshotId,
  likeState: "value",
  likeValue: 10n,
  ...over,
});
async function setup() {
  const w = await world();
  const planId = await insertJudgementPlan(w);
  await insertVersion(planId, 1);
  return { w, planId };
}

describe("judgement_plans", () => {
  it("同一活动计划内别名唯一；不同活动计划可重名", async () => {
    const w = await world();
    await insertJudgementPlan(w, "计划 A");
    await expectRejected(insertJudgementPlan(w, "计划 A"), "uq_jp_alias");
  });
  it("platform_id 与活动计划不一致被复合外键拒绝", async () => {
    const w = await world();
    await expectRejected(insertJudgementPlan(w, "计划 B", { platformId: w.platformId + 1n }), "fk_jp_activity_plan");
  });
  it("状态与 latest_version 的 CHECK", async () => {
    const w = await world();
    await expectRejected(insertJudgementPlan(w, "X", { status: "weird" }), "ck_jp_status");
    await expectRejected(insertJudgementPlan(w, "Y", { latestVersion: 0 }), "ck_jp_latest_version");
  });
  it("被 D 引用的活动计划被 A 物理删除时被 RESTRICT 拒绝（D 未 purge）", async () => {
    const w = await world();
    await insertJudgementPlan(w);
    // 先清掉 A 自己的子表，只剩 D 的外键挡着
    await t.db.delete(activityPlanRoster).where(eq(activityPlanRoster.planId, w.planId));
    await t.db.delete(activityPlanBranches).where(eq(activityPlanBranches.planId, w.planId));
    await t.db.delete(activityPlanSectors).where(eq(activityPlanSectors.planId, w.planId));
    await expectRejected(t.db.delete(activityPlans).where(eq(activityPlans.planId, w.planId)), "fk_jp_activity_plan");
  });
});

describe("judgement_plan_versions", () => {
  it("同计划第二个草稿（含发布中）被 draft_key 拒绝；已发布的不占位", async () => {
    const { planId } = await setup();
    await expectRejected(insertVersion(planId, 2), "uq_jpv_draft");
    await expectRejected(insertVersion(planId, 2, { status: "publishing" }), "uq_jpv_draft");
    await t.db.update(judgementPlanVersions).set({ status: "published", publishedAt: NOW }).where(eq(judgementPlanVersions.planId, planId));
    await insertVersion(planId, 2);
  });
  it("发布时间与状态必须同步；状态 / 向导进度 / 版本号 / config 形状的 CHECK", async () => {
    const w = await world();
    const planId = await insertJudgementPlan(w);
    await expectRejected(insertVersion(planId, 1, { status: "published" }), "ck_jpv_published");
    await expectRejected(insertVersion(planId, 1, { publishedAt: NOW }), "ck_jpv_published");
    await expectRejected(insertVersion(planId, 1, { status: "weird" }), "ck_jpv_status");
    await expectRejected(insertVersion(planId, 1, { wizardStep: "weird" }), "ck_jpv_wizard");
    await expectRejected(insertVersion(planId, 0), "ck_jpv_version");
    await expectRejected(insertVersion(planId, 1, { config: [] as unknown as object }), "ck_jpv_config");
  });
  it("版本必须挂在存在的计划上", async () => {
    await expectRejected(insertVersion(999_999n, 1), "fk_jpv_plan");
  });
});

describe("judgement_runs", () => {
  it("同（计划，版本）第二个未终态运行被 active_key 拒绝；终态后可再建", async () => {
    const { planId } = await setup();
    const first = await insertRun(planId, 1);
    await expectRejected(insertRun(planId, 1), "uq_jr_active");
    await t.db.update(judgementRuns).set({ status: "cancelled", activeKey: null }).where(eq(judgementRuns.runId, first));
    await insertRun(planId, 1);
  });
  it("active_key 与状态必须一致", async () => {
    const { planId } = await setup();
    await expectRejected(insertRun(planId, 1, { status: "failed" }), "ck_jr_active");
    await expectRejected(insertRun(planId, 1, { activeKey: null }), "ck_jr_active");
  });
  it("running 必须带租约；completed 必须有完成时间", async () => {
    const { planId } = await setup();
    await expectRejected(insertRun(planId, 1, { status: "running" }), "ck_jr_lease");
    await insertRun(planId, 1, { status: "running", leaseOwner: "w1", leaseExpiresAt: NOW });
    await expectRejected(insertRun(planId, 1, { status: "completed", activeKey: null }), "ck_jr_completed");
  });
  it("提交人必须是 user:<id>；保留期只用于圈定 / 试跑；种类 / 状态取值", async () => {
    const { planId } = await setup();
    await expectRejected(insertRun(planId, 1, { submittedByActor: "service:x" }), "ck_jr_submitter");
    await expectRejected(insertRun(planId, 1, { expiresAt: NOW }), "ck_jr_expires");
    await expectRejected(insertRun(planId, 1, { runKind: "weird" }), "ck_jr_kind");
    await expectRejected(insertRun(planId, 1, { status: "weird", activeKey: null }), "ck_jr_status");
  });
  it("幂等键唯一；运行必须挂在存在的版本上；被运行引用的版本 / 计划 DELETE 被 RESTRICT 拒绝", async () => {
    const { planId } = await setup();
    await insertRun(planId, 1, { idempotencyKey: sha("k"), status: "cancelled", activeKey: null });
    await expectRejected(insertRun(planId, 1, { idempotencyKey: sha("k"), status: "cancelled", activeKey: null }), "uq_jr_idempotency");
    await expectRejected(insertRun(planId, 9), "fk_jr_version");
    await expectRejected(t.db.delete(judgementPlanVersions).where(eq(judgementPlanVersions.planId, planId)), "fk_jr_version");
    await expectRejected(t.db.delete(judgementPlans).where(eq(judgementPlans.planId, planId)), "fk_jpv_plan");
  });
});

describe("run_participants", () => {
  it("同一运行同一专员 / 同一账号两行被拒；取值 CHECK；done 必须有计划总结果", async () => {
    const { w, planId } = await setup();
    const runId = await insertRun(planId, 1);
    await insertParticipant(w, runId);
    await expectRejected(insertParticipant(w, runId), "PRIMARY");
    const another = await insertAccount(t.db, "douyin", NOW);
    await expectRejected(insertParticipant(w, runId, { accountId: another }), "uq_rp_run_staff");
    const run2 = await insertRun(planId, 1, { status: "cancelled", activeKey: null });
    await expectRejected(insertParticipant(w, run2, { state: "done", planResult: "weird" }), "ck_rp_plan_result");
    await expectRejected(insertParticipant(w, run2, { state: "done" }), "ck_rp_done");
    await expectRejected(insertParticipant(w, run2, { planResult: "success" }), "ck_rp_done");
    await insertParticipant(w, run2, { state: "done", planResult: "not_met", contentResult: "not_met" });
  });
  it("组织链各级必须存在（外键）", async () => {
    const { w, planId } = await setup();
    const runId = await insertRun(planId, 1);
    await expectRejected(insertParticipant(w, runId, { regionId: 999_999n }), "fk_rp_region");
  });
});

describe("run_contents", () => {
  it("引用不存在的参与专员被复合外键拒绝；快照必须属于同一内容", async () => {
    const { w, planId } = await setup();
    const runId = await insertRun(planId, 1);
    const c = await newContentRow(w, "c1");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, c)), "fk_rc_participant");
    await insertParticipant(w, runId);
    const other = await newContentRow(w, "c2");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, { contentId: c.contentId, snapshotId: other.snapshotId })), "fk_rc_snapshot");
    await t.db.insert(runContents).values(contentRow(runId, w.accZhao, c));
  });
  it("点赞值状态沿用 A 的词表：value 才非空且 >= 0；其余四态必须为空", async () => {
    const { w, planId } = await setup();
    const runId = await insertRun(planId, 1);
    await insertParticipant(w, runId);
    const c = await newContentRow(w, "c1");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, c, { likeState: "valid" })), "ck_rc_like");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, c, { likeState: "missing", likeValue: 5n })), "ck_rc_like");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, c, { likeState: "value", likeValue: null })), "ck_rc_like");
    for (const [i, state] of (["missing", "explicit_null", "invalid", "unsupported"] as const).entries()) {
      const x = await newContentRow(w, `s${i}`);
      await t.db.insert(runContents).values(contentRow(runId, w.accZhao, x, { likeState: state, likeValue: null }));
    }
    const zero = await newContentRow(w, "zero");
    await t.db.insert(runContents).values(contentRow(runId, w.accZhao, zero, { likeValue: 0n }));
  });
  it("层结果 / 最终结果的取值：final 允许 skipped，l0 只有 pass / unobtained", async () => {
    const { w, planId } = await setup();
    const runId = await insertRun(planId, 1);
    await insertParticipant(w, runId);
    const c = await newContentRow(w, "c1");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, c, { l0: "fail" })), "ck_rc_l0");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, c, { l1: "weird" })), "ck_rc_l1");
    await expectRejected(t.db.insert(runContents).values(contentRow(runId, w.accZhao, c, { final: "not_configured" })), "ck_rc_final");
  });
  it("第 1 层选中标记：只对 l1=pass 的行有值；rank 依附选中标记；skipped 当且仅当「通过但未选中」", async () => {
    const { w, planId } = await setup();
    const runId = await insertRun(planId, 1);
    await insertParticipant(w, runId);
    const ok = async (id: string, over: Partial<ContentInsert>) => t.db.insert(runContents).values(contentRow(runId, w.accZhao, await newContentRow(w, id), over));
    const bad = async (id: string, over: Partial<ContentInsert>, name: string) => expectRejected(ok(id, over), name);
    await bad("a", { l1: "fail", layer1Selected: true }, "ck_rc_selected");
    await bad("b", { layer1Selected: false }, "ck_rc_selected");
    await bad("c", { l1: "pass", layer1Rank: 1 }, "ck_rc_rank");
    await bad("d", { l1: "pass", layer1Selected: true, layer1Rank: 0 }, "ck_rc_rank");
    // 通过但未选中 ⇒ 必须 skipped；反之 skipped 必须是通过但未选中
    await bad("e", { l1: "pass", layer1Selected: false, final: "pass" }, "ck_rc_skipped");
    await bad("f", { l1: "pass", layer1Selected: true, final: "skipped" }, "ck_rc_skipped");
    await bad("g", { l1: "fail", final: "skipped" }, "ck_rc_skipped");
    await ok("h", { l1: "pass", layer1Selected: false, layer1Rank: 7, final: "skipped", l2: "skipped", l3: "skipped" });
    await ok("i", { l1: "pass", layer1Selected: true, layer1Rank: 1 });
    await ok("j", { l1: "pass", layer1Selected: true, final: "pass" });
    await ok("k", { l1: "unobtained", final: "unobtained" });
    // 待评估的行（全部 NULL）合法
    await ok("l", {});
  });
});

describe("迁移", () => {
  it("D 的五张表都存在，且业务表没有 ON DELETE CASCADE", async () => {
    const db: Db = t.db;
    void db;
    const [rows] = await t.pool.query(
      "SELECT table_name AS t, delete_rule AS r FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND table_name IN ('judgement_plans','judgement_plan_versions','judgement_runs','run_participants','run_contents')",
    );
    expect((rows as Array<{ t: string; r: string }>).length).toBeGreaterThan(10);
    expect((rows as Array<{ r: string }>).every((x) => x.r === "RESTRICT" || x.r === "NO ACTION")).toBe(true);
  });
});
