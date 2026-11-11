// v2 §22 活动计划（a-activity-plan design §6.1）。六张表；业务表无 ON DELETE CASCADE（全部 RESTRICT）。
// 计划起止日期是北京时间自然日，用 DATE（mode:"string"，不经 JS Date，无时区换算）。
import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, json, mysqlTable, primaryKey, tinyint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { id, inList, utc } from "../columns";
import { externalAccounts } from "./accounts";
import { importBatches } from "./import";
import { branches, brands, mediaStaff, stores } from "./org";
import { platforms } from "./reference";

export const PLAN_STATUSES = ["collecting", "paused", "archived", "deleted"] as const;
export const PLAN_SECTOR_KEYS = ["water", "home"] as const;
export const PARTICIPATION_STATUSES = ["joined", "exited"] as const;
export const OWNER_CLAIM_VIAS = ["import", "replace"] as const;
export const ROSTER_ENTRY_STATES = ["in_roster", "removed"] as const;
export const ROSTER_REMOVED_REASONS = ["manual_remove", "branch_exit"] as const;

export const activityPlans = mysqlTable(
  "activity_plans",
  {
    planId: id("plan_id").primaryKey().autoincrement(),
    planName: varchar("plan_name", { length: 200 }).notNull(),
    // 仅展示，不参与判定
    description: varchar("description", { length: 2000 }),
    // 品牌、平台创建后不可改：没有更新路径，由测试守护
    brandId: id("brand_id").notNull(),
    platformId: id("platform_id").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }),
    status: varchar("status", { length: 16 }).notNull(),
    // 无引用起点的计算依据
    statusChangedAt: utc("status_changed_at").notNull(),
    statusBeforeDelete: varchar("status_before_delete", { length: 16 }),
    deletedAt: utc("deleted_at"),
    deletedByActor: varchar("deleted_by_actor", { length: 128 }),
    purgeAfter: utc("purge_after"),
    createdByActor: varchar("created_by_actor", { length: 128 }).notNull(),
    // B 域接入后回填，不造假
    createdByUserId: id("created_by_user_id"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_plans_brand", columns: [t.brandId], foreignColumns: [brands.brandId] }),
    foreignKey({ name: "fk_plans_platform", columns: [t.platformId], foreignColumns: [platforms.platformId] }),
    // 供名单项的复合外键：数据库保证名单项平台等于计划平台
    uniqueIndex("uq_plans_id_platform").on(t.planId, t.platformId),
    index("idx_plans_brand_status").on(t.brandId, t.status),
    index("idx_plans_creator_status").on(t.createdByActor, t.status),
    index("idx_plans_status_purge").on(t.status, t.purgeAfter),
    check("ck_plans_status", inList(t.status, PLAN_STATUSES)),
    check("ck_plans_dates", sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`),
    check("ck_plans_before_delete", sql`${t.statusBeforeDelete} IS NULL OR ${t.statusBeforeDelete} IN ('collecting','paused','archived')`),
    check(
      "ck_plans_deleted_fields",
      sql`(${t.status} = 'deleted') = (${t.deletedAt} IS NOT NULL AND ${t.statusBeforeDelete} IS NOT NULL AND ${t.purgeAfter} IS NOT NULL)`,
    ),
  ],
);

export const activityPlanSectors = mysqlTable(
  "activity_plan_sectors",
  {
    planId: id("plan_id").notNull(),
    // 板块种类（水机 water / 家装 home），不是某分公司下的板块行
    sectorKey: varchar("sector_key", { length: 16 }).notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_plan_sectors", columns: [t.planId, t.sectorKey] }),
    foreignKey({ name: "fk_plan_sectors_plan", columns: [t.planId], foreignColumns: [activityPlans.planId] }),
    check("ck_plan_sectors_key", inList(t.sectorKey, PLAN_SECTOR_KEYS)),
  ],
);

// 参与关系；该行也是名额与名单操作的串行化锁点（SELECT … FOR UPDATE）
export const activityPlanBranches = mysqlTable(
  "activity_plan_branches",
  {
    planId: id("plan_id").notNull(),
    branchId: id("branch_id").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    joinedAt: utc("joined_at").notNull(),
    joinedByActor: varchar("joined_by_actor", { length: 128 }).notNull(),
    exitedAt: utc("exited_at"),
    exitedByActor: varchar("exited_by_actor", { length: 128 }),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_plan_branches", columns: [t.planId, t.branchId] }),
    foreignKey({ name: "fk_plan_branches_plan", columns: [t.planId], foreignColumns: [activityPlans.planId] }),
    foreignKey({ name: "fk_plan_branches_branch", columns: [t.branchId], foreignColumns: [branches.branchId] }),
    index("idx_plan_branches_branch_status").on(t.branchId, t.status),
    check("ck_plan_branches_status", inList(t.status, PARTICIPATION_STATUSES)),
    check("ck_plan_branches_exited", sql`(${t.status} = 'exited') = (${t.exitedAt} IS NOT NULL)`),
  ],
);

// 负责人名额：行存在即占用；释放 = 删除该行并写 activity_plan_changes
export const activityPlanOwners = mysqlTable(
  "activity_plan_owners",
  {
    planId: id("plan_id").notNull(),
    branchId: id("branch_id").notNull(),
    slotNo: tinyint("slot_no").notNull(),
    ownerActor: varchar("owner_actor", { length: 128 }).notNull(),
    ownerUserId: id("owner_user_id"),
    ownerDisplayName: varchar("owner_display_name", { length: 100 }),
    claimedAt: utc("claimed_at").notNull(),
    claimedVia: varchar("claimed_via", { length: 16 }).notNull(),
    claimedBatchId: id("claimed_batch_id"),
  },
  (t) => [
    primaryKey({ name: "pk_plan_owners", columns: [t.planId, t.branchId, t.slotNo] }),
    foreignKey({ name: "fk_plan_owners_participation", columns: [t.planId, t.branchId], foreignColumns: [activityPlanBranches.planId, activityPlanBranches.branchId] }),
    foreignKey({ name: "fk_plan_owners_batch", columns: [t.claimedBatchId], foreignColumns: [importBatches.importBatchId] }),
    // 同一人不占两个槽
    uniqueIndex("uq_plan_owners_actor").on(t.planId, t.branchId, t.ownerActor),
    index("idx_plan_owners_batch").on(t.claimedBatchId),
    check("ck_plan_owners_slot", sql`${t.slotNo} IN (1,2)`),
    check("ck_plan_owners_via", inList(t.claimedVia, OWNER_CLAIM_VIAS)),
  ],
);

// 名单项 = 计划 × 账号；只在账号解析成功后创建，永不物理删除（计划期满清除时随计划一起显式删除）
export const activityPlanRoster = mysqlTable(
  "activity_plan_roster",
  {
    rosterEntryId: id("roster_entry_id").primaryKey().autoincrement(),
    planId: id("plan_id").notNull(),
    platformId: id("platform_id").notNull(),
    accountId: id("account_id").notNull(),
    // 加入名单当时门店所属分公司，用于可见范围；之后门店换分公司不改它（AP-D23）
    branchId: id("branch_id").notNull(),
    storeId: id("store_id").notNull(),
    staffId: id("staff_id").notNull(),
    entryState: varchar("entry_state", { length: 16 }).notNull(),
    addedAt: utc("added_at").notNull(),
    addedByActor: varchar("added_by_actor", { length: 128 }).notNull(),
    addedBatchId: id("added_batch_id"),
    removedAt: utc("removed_at"),
    removedByActor: varchar("removed_by_actor", { length: 128 }),
    removedReason: varchar("removed_reason", { length: 16 }),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_roster_plan_platform", columns: [t.planId, t.platformId], foreignColumns: [activityPlans.planId, activityPlans.platformId] }),
    foreignKey({ name: "fk_roster_account_platform", columns: [t.accountId, t.platformId], foreignColumns: [externalAccounts.accountId, externalAccounts.platformId] }),
    foreignKey({ name: "fk_roster_branch", columns: [t.branchId], foreignColumns: [branches.branchId] }),
    foreignKey({ name: "fk_roster_store", columns: [t.storeId], foreignColumns: [stores.storeId] }),
    foreignKey({ name: "fk_roster_staff", columns: [t.staffId], foreignColumns: [mediaStaff.staffId] }),
    foreignKey({ name: "fk_roster_batch", columns: [t.addedBatchId], foreignColumns: [importBatches.importBatchId] }),
    // 恢复原行，不新增第二行
    uniqueIndex("uq_roster_plan_account").on(t.planId, t.accountId),
    index("idx_roster_plan_branch_state").on(t.planId, t.branchId, t.entryState),
    index("idx_roster_account_state").on(t.accountId, t.entryState),
    index("idx_roster_staff").on(t.staffId),
    index("idx_roster_batch").on(t.addedBatchId),
    check("ck_roster_state", inList(t.entryState, ROSTER_ENTRY_STATES)),
    check("ck_roster_removed_reason", sql`${t.removedReason} IS NULL OR ${inList(t.removedReason, ROSTER_REMOVED_REASONS)}`),
    check("ck_roster_removed_fields", sql`(${t.entryState} = 'removed') = (${t.removedAt} IS NOT NULL)`),
  ],
);

// 变更记录（页面「变更记录」标签的业务视图）；与审计日志并存，随计划一起清除
export const activityPlanChanges = mysqlTable(
  "activity_plan_changes",
  {
    changeId: id("change_id").primaryKey().autoincrement(),
    planId: id("plan_id").notNull(),
    branchId: id("branch_id"),
    eventType: varchar("event_type", { length: 48 }).notNull(),
    actor: varchar("actor", { length: 128 }).notNull(),
    occurredAt: utc("occurred_at").notNull(),
    // 仅关键字段，不含整行原文
    detail: json("detail"),
  },
  (t) => [
    foreignKey({ name: "fk_plan_changes_plan", columns: [t.planId], foreignColumns: [activityPlans.planId] }),
    index("idx_plan_changes_plan_time").on(t.planId, t.occurredAt),
  ],
);
