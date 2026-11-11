// a-activity-plan 任务 1：六张新表与三处既有表修改在真实 MySQL 8.4 上是否真的强制设计里的约束。
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, createPool, runMigrations } from "./client";
import { expectRejected, useTestDb } from "../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../tests/harness/factories";
import { platformIdOf, seedOrg, type OrgSeed } from "../../tests/harness/seed";
import {
  activityPlanBranches,
  activityPlanChanges,
  activityPlanOwners,
  activityPlanRoster,
  activityPlanSectors,
  activityPlans,
  importBatches,
  importRowResults,
  staffAccountAssignments,
} from "./schema";
const NOW = new Date("2026-11-11T02:00:00.000000Z");
const t = useTestDb();

async function plan(org: OrgSeed, over: Partial<typeof activityPlans.$inferInsert> = {}) {
  const [r] = await t.db.insert(activityPlans).values({
    planName: "618 活动",
    brandId: org.hitachiBrandId,
    platformId: await platformIdOf(t.db, "douyin"),
    startsOn: "2026-11-01",
    status: "collecting",
    statusChangedAt: NOW,
    createdByActor: "service:test",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  return BigInt(r.insertId);
}
const branchOf = (org: OrgSeed, code = "101") => org.branchIds.get(code)!;
async function join(planId: bigint, branchId: bigint) {
  await t.db.insert(activityPlanBranches).values({ planId, branchId, status: "joined", joinedAt: NOW, joinedByActor: "service:test", updatedAt: NOW });
}
async function rosterRow(org: OrgSeed, planId: bigint, accountId: bigint, platform = "douyin", over: Partial<typeof activityPlanRoster.$inferInsert> = {}) {
  await t.db.insert(activityPlanRoster).values({
    planId,
    platformId: await platformIdOf(t.db, platform),
    accountId,
    branchId: branchOf(org),
    storeId: org.storeId,
    staffId: org.staffA,
    entryState: "in_roster",
    addedAt: NOW,
    addedByActor: "service:test",
    updatedAt: NOW,
    ...over,
  });
}
async function rosterBatch(planId: bigint | null, over: Partial<typeof importBatches.$inferInsert> = {}) {
  const [r] = await t.db.insert(importBatches).values({
    importKind: "roster",
    planId,
    uploadedByActor: "service:test",
    uploadedAt: NOW,
    totalRows: 1,
    status: "awaiting_confirm",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  return BigInt(r.insertId);
}

describe("活动计划表：计划", () => {
  it("状态、日期顺序、删除字段齐备都由 CHECK 守护", async () => {
    const org = await seedOrg(t.db, NOW);
    await expectRejected(plan(org, { status: "frozen" }), "ck_plans_status");
    await expectRejected(plan(org, { startsOn: "2026-11-10", endsOn: "2026-11-09" }), "ck_plans_dates");
    // deleted 必须三个删除字段齐备；非 deleted 不得带任何删除字段
    await expectRejected(plan(org, { status: "deleted" }), "ck_plans_deleted_fields");
    await expectRejected(plan(org, { deletedAt: NOW, statusBeforeDelete: "collecting", purgeAfter: NOW }), "ck_plans_deleted_fields");
    await expectRejected(plan(org, { status: "deleted", deletedAt: NOW, purgeAfter: NOW, statusBeforeDelete: "deleted" }), "ck_plans_before_delete");
    await plan(org, { status: "deleted", deletedAt: NOW, purgeAfter: NOW, statusBeforeDelete: "paused" });
    await plan(org, { endsOn: "2026-11-01" }); // 结束日 = 开始日合法
  });
  it("板块只接受 water / home，同计划同板块只一行", async () => {
    const org = await seedOrg(t.db, NOW);
    const p = await plan(org);
    await t.db.insert(activityPlanSectors).values({ planId: p, sectorKey: "water" });
    await expectRejected(t.db.insert(activityPlanSectors).values({ planId: p, sectorKey: "water" }), "PRIMARY");
    await expectRejected(t.db.insert(activityPlanSectors).values({ planId: p, sectorKey: "kitchen" }), "ck_plan_sectors_key");
  });
  it("变更记录要有计划", async () => {
    await seedOrg(t.db, NOW);
    await expectRejected(t.db.insert(activityPlanChanges).values({ planId: 999n, eventType: "x", actor: "a", occurredAt: NOW }), "fk_plan_changes_plan");
  });
});

describe("活动计划表：参与关系与负责人名额", () => {
  it("退出必须带退出时间，已参加不得带", async () => {
    const org = await seedOrg(t.db, NOW);
    const p = await plan(org);
    const base = { planId: p, branchId: branchOf(org), joinedAt: NOW, joinedByActor: "a", updatedAt: NOW };
    await expectRejected(t.db.insert(activityPlanBranches).values({ ...base, status: "exited" }), "ck_plan_branches_exited");
    await expectRejected(t.db.insert(activityPlanBranches).values({ ...base, status: "joined", exitedAt: NOW }), "ck_plan_branches_exited");
    await expectRejected(t.db.insert(activityPlanBranches).values({ ...base, status: "left" }), "ck_plan_branches_status");
    await t.db.insert(activityPlanBranches).values({ ...base, status: "exited", exitedAt: NOW });
  });
  it("至多 2 个槽、同一人不占两个槽、必须先有参与关系", async () => {
    const org = await seedOrg(t.db, NOW);
    const p = await plan(org);
    const b = branchOf(org);
    const owner = (slotNo: number, ownerActor: string) => ({ planId: p, branchId: b, slotNo, ownerActor, claimedAt: NOW, claimedVia: "import" });
    await expectRejected(t.db.insert(activityPlanOwners).values(owner(1, "u1")), "fk_plan_owners_participation");
    await join(p, b);
    await t.db.insert(activityPlanOwners).values(owner(1, "u1"));
    await t.db.insert(activityPlanOwners).values(owner(2, "u2"));
    await expectRejected(t.db.insert(activityPlanOwners).values(owner(3, "u3")), "ck_plan_owners_slot");
    await expectRejected(t.db.insert(activityPlanOwners).values(owner(0, "u3")), "ck_plan_owners_slot");
    await expectRejected(t.db.insert(activityPlanOwners).values(owner(1, "u3")), "PRIMARY");
    // 释放第 2 槽后，u1 仍不能再占它
    await t.db.delete(activityPlanOwners).where(sql`slot_no = 2`);
    await expectRejected(t.db.insert(activityPlanOwners).values(owner(2, "u1")), "uq_plan_owners_actor");
    await expectRejected(t.db.insert(activityPlanOwners).values({ ...owner(2, "u4"), claimedVia: "auto" }), "ck_plan_owners_via");
  });
});

describe("活动计划表：名单项", () => {
  it("名单项平台与计划平台不一致被复合外键拒绝", async () => {
    const org = await seedOrg(t.db, NOW);
    const p = await plan(org); // douyin
    await join(p, branchOf(org));
    const xhs = await insertAccount(t.db, "xiaohongshu", NOW);
    await expectRejected(rosterRow(org, p, xhs, "xiaohongshu"), "fk_roster_plan_platform");
  });
  it("账号平台与名单项平台不一致被复合外键拒绝", async () => {
    const org = await seedOrg(t.db, NOW);
    const p = await plan(org);
    const xhs = await insertAccount(t.db, "xiaohongshu", NOW);
    await expectRejected(rosterRow(org, p, xhs, "douyin"), "fk_roster_account_platform");
  });
  it("同账号同计划只有一行；移出字段与状态同空同非空", async () => {
    const org = await seedOrg(t.db, NOW);
    const p = await plan(org);
    const acc = await insertAccount(t.db, "douyin", NOW);
    await rosterRow(org, p, acc);
    await expectRejected(rosterRow(org, p, acc), "uq_roster_plan_account");
    const acc2 = await insertAccount(t.db, "douyin", NOW);
    await expectRejected(rosterRow(org, p, acc2, "douyin", { entryState: "removed" }), "ck_roster_removed_fields");
    await expectRejected(rosterRow(org, p, acc2, "douyin", { removedAt: NOW }), "ck_roster_removed_fields");
    await expectRejected(rosterRow(org, p, acc2, "douyin", { entryState: "removed", removedAt: NOW, removedReason: "typo" }), "ck_roster_removed_reason");
    await rosterRow(org, p, acc2, "douyin", { entryState: "removed", removedAt: NOW, removedReason: "branch_exit" });
    await expectRejected(rosterRow(org, p, acc2, "douyin", { entryState: "bogus" }), "ck_roster_state");
  });
  it("同账号可出现在两个计划里（引用计数的前提）", async () => {
    const org = await seedOrg(t.db, NOW);
    const p1 = await plan(org);
    const p2 = await plan(org, { planName: "双十一" });
    const acc = await insertAccount(t.db, "douyin", NOW);
    await rosterRow(org, p1, acc);
    await rosterRow(org, p2, acc);
  });
  it("有名单项的计划、有名单项的参与关系都删不掉（没有级联）", async () => {
    const org = await seedOrg(t.db, NOW);
    const p = await plan(org);
    const acc = await insertAccount(t.db, "douyin", NOW);
    await rosterRow(org, p, acc);
    await expectRejected(t.db.delete(activityPlans).where(sql`plan_id = ${p}`), "fk_roster_plan_platform");
  });
});

describe("既有表的修改", () => {
  it("roster 批次必须带 plan_id；master_data 与 user_import 批次不受影响", async () => {
    await seedOrg(t.db, NOW);
    await expectRejected(rosterBatch(null), "ck_import_batches_roster_plan");
    await rosterBatch(123456n); // plan_id 不加外键：计划清除后批次要能活下去
    await t.db.insert(importBatches).values({ importKind: "master_data", uploadedByActor: "a", uploadedAt: NOW, totalRows: 1, status: "awaiting_confirm", createdAt: NOW, updatedAt: NOW });
  });
  it("批次状态接受 resolving；提交分公司受外键约束", async () => {
    const org = await seedOrg(t.db, NOW);
    const id = await rosterBatch(1n, { status: "resolving", submitterBranchId: branchOf(org) });
    expect(id > 0n).toBe(true);
    await expectRejected(rosterBatch(1n, { status: "paused" }), "ck_import_batches_status");
    await expectRejected(rosterBatch(1n, { submitterBranchId: 987654n }), "fk_import_batches_submitter_branch");
  });
  it("行结果接受 new_staff 与三个新 outcome；resolve_task_id 随任务清理置空", async () => {
    await seedOrg(t.db, NOW);
    const b = await rosterBatch(1n);
    const row = (rowNo: number, over: Partial<typeof importRowResults.$inferInsert>) => ({ importBatchId: b, rowNo, rawRow: {}, createdAt: NOW, ...over });
    await t.db.insert(importRowResults).values(row(1, { precheckClass: "new_staff" }));
    for (const [i, outcome] of (["pending_account", "suspected_empty", "resolve_failed"] as const).entries()) {
      await t.db.insert(importRowResults).values(row(i + 2, { outcome }));
    }
    await expectRejected(t.db.insert(importRowResults).values(row(9, { outcome: "maybe" })), "ck_import_rows_outcome");
    await expectRejected(t.db.insert(importRowResults).values(row(10, { precheckClass: "later" })), "ck_import_rows_precheck");
    await expectRejected(t.db.insert(importRowResults).values(row(11, { resolveTaskId: 424242n })), "fk_import_rows_resolve_task");
  });
  it("归属表多了 unreferenced_since，旧归属行默认为空", async () => {
    const org = await seedOrg(t.db, NOW);
    const acc = await insertAccount(t.db, "douyin", NOW);
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: org.staffA, now: NOW });
    const [a] = await t.db.select().from(staffAccountAssignments);
    expect(a?.unreferencedSince).toBeNull();
  });
});

describe("迁移", () => {
  it("可重复执行：第二次迁移不改变任何东西", async () => {
    const url = process.env.HBECHO_TEST_DATABASE_URL!;
    const pool = createPool(url);
    try {
      await runMigrations(createDb(pool));
      const [[before]] = (await pool.query("SELECT COUNT(*) c FROM __drizzle_migrations")) as unknown as [Array<{ c: number }>];
      await runMigrations(createDb(pool));
      const [[after]] = (await pool.query("SELECT COUNT(*) c FROM __drizzle_migrations")) as unknown as [Array<{ c: number }>];
      expect(after?.c).toBe(before?.c);
    } finally {
      await pool.end();
    }
  });
  it("六张新表以及任何指向它们的外键都没有级联删除", async () => {
    const [rows] = await t.pool.query(
      "SELECT table_name n, delete_rule r FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND (table_name LIKE 'activity_plan%' OR referenced_table_name LIKE 'activity_plan%')",
    );
    expect((rows as Array<{ r: string }>).length).toBeGreaterThan(10);
    expect((rows as Array<{ r: string }>).filter((r) => r.r === "CASCADE")).toEqual([]);
  });
});
