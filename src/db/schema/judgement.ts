// d-rule-engine design §6：D 域五张新表，不入 v2。内部 ID 为 signed BIGINT；时间 UTC DATETIME(6)；状态 VARCHAR + CHECK；
// 哈希 BINARY(32)；业务表无 ON DELETE CASCADE（全部 RESTRICT）。对 A、C 的表零修改，外键只指向 A 的表（方向 D → A）。
import { sql, type SQL } from "drizzle-orm";
import { boolean, check, foreignKey, index, int, json, mysqlTable, primaryKey, uniqueIndex, varchar, type MySqlTableExtraConfigValue } from "drizzle-orm/mysql-core";
import { id, inList, sha256, utc, valueStateCheck } from "../columns";
import { externalAccounts } from "./accounts";
import { activityPlans } from "./activity-plan";
import { contentSnapshots } from "./content";
import { branches, brands, dealers, mediaStaff, regions, sectors, stores } from "./org";

export const JUDGEMENT_PLAN_STATUSES = ["provisioning", "active", "archived"] as const;
export const JUDGEMENT_VERSION_STATUSES = ["draft", "publishing", "published"] as const;
export const JUDGEMENT_WIZARD_STEPS = ["draft", "circled", "compared"] as const;
export const JUDGEMENT_RUN_KINDS = ["circle", "compare", "execution"] as const;
export const JUDGEMENT_RUN_STATUSES = ["planned", "running", "waiting", "completed", "failed", "cancelled"] as const;
/** 未终态：参与 `active_key` 的唯一约束，也是 A 的「在途」定义（JP-17）。 */
export const JUDGEMENT_RUN_ACTIVE_STATUSES = ["planned", "running", "waiting"] as const;
/** 层结果：`l0` 只有 pass / unobtained；`skipped` = 前层停住或第 1 层未被选中；`not_configured` = 该层没配条件。 */
export const JUDGEMENT_LAYER_RESULTS = ["pass", "fail", "unobtained", "skipped", "not_configured"] as const;
export const JUDGEMENT_FINAL_RESULTS = ["pass", "fail", "unobtained", "skipped"] as const;
export const JUDGEMENT_OUTCOMES = ["success", "not_met", "unobtained"] as const;
export const JUDGEMENT_PARTICIPANT_STATES = ["pending", "done"] as const;

const nullableIn = (col: Parameters<typeof inList>[0], values: readonly string[]): SQL => sql`${col} IS NULL OR ${inList(col, values)}`;

export const judgementPlans = mysqlTable(
  "judgement_plans",
  {
    // 同时是 C 监控段的计划 ID
    planId: id("plan_id").primaryKey().autoincrement(),
    activityPlanId: id("activity_plan_id").notNull(),
    // 复合外键保证判定计划平台等于活动计划平台
    platformId: id("platform_id").notNull(),
    alias: varchar("alias", { length: 200 }).notNull(),
    description: varchar("description", { length: 2000 }),
    status: varchar("status", { length: 16 }).notNull(),
    latestVersion: int("latest_version").notNull(),
    createdByActor: varchar("created_by_actor", { length: 128 }).notNull(),
    // B 域接入后回填，不造假
    createdByUserId: id("created_by_user_id"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t): MySqlTableExtraConfigValue[] => [
    foreignKey({ name: "fk_jp_activity_plan", columns: [t.activityPlanId, t.platformId], foreignColumns: [activityPlans.planId, activityPlans.platformId] }),
    uniqueIndex("uq_jp_alias").on(t.activityPlanId, t.alias),
    index("idx_jp_activity_status").on(t.activityPlanId, t.status),
    check("ck_jp_status", inList(t.status, JUDGEMENT_PLAN_STATUSES)),
    check("ck_jp_latest_version", sql`${t.latestVersion} > 0`),
  ],
);

export const judgementPlanVersions = mysqlTable(
  "judgement_plan_versions",
  {
    planId: id("plan_id").notNull(),
    version: int("version").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    wizardStep: varchar("wizard_step", { length: 16 }).notNull(),
    config: json("config").notNull(),
    configSchemaVersion: int("config_schema_version").notNull(),
    // 规范化 JSON 的哈希；能力别名与 abilityId 不参与（D-D20）
    configSha256: sha256("config_sha256").notNull(),
    basedOnVersion: int("based_on_version"),
    // 每计划至多一个草稿（含发布中）：生成列 + 唯一键（NULL 不冲突）
    draftKey: id("draft_key").generatedAlwaysAs(sql`(CASE WHEN status IN ('draft','publishing') THEN plan_id END)`, { mode: "stored" }),
    publishedAt: utc("published_at"),
    publishedByActor: varchar("published_by_actor", { length: 128 }),
    createdByActor: varchar("created_by_actor", { length: 128 }).notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t): MySqlTableExtraConfigValue[] => [
    primaryKey({ name: "pk_jpv", columns: [t.planId, t.version] }),
    foreignKey({ name: "fk_jpv_plan", columns: [t.planId], foreignColumns: [judgementPlans.planId] }),
    uniqueIndex("uq_jpv_draft").on(t.draftKey),
    check("ck_jpv_status", inList(t.status, JUDGEMENT_VERSION_STATUSES)),
    check("ck_jpv_wizard", inList(t.wizardStep, JUDGEMENT_WIZARD_STEPS)),
    check("ck_jpv_version", sql`${t.version} > 0`),
    check("ck_jpv_published", sql`(${t.status} = 'published') = (${t.publishedAt} IS NOT NULL)`),
    check("ck_jpv_config", sql`JSON_TYPE(${t.config}) = 'OBJECT'`),
  ],
);

export const judgementRuns = mysqlTable(
  "judgement_runs",
  {
    // run_kind = 'execution' 时即 E 所说的「判定执行 ID」
    runId: id("run_id").primaryKey().autoincrement(),
    planId: id("plan_id").notNull(),
    version: int("version").notNull(),
    runKind: varchar("run_kind", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    phase: varchar("phase", { length: 32 }),
    phaseCursor: id("phase_cursor"),
    // 阶段内的依赖句柄：demand 批次、等待截止、waiting_on（null / signals / demand）
    phaseDetail: json("phase_detail"),
    // 窗口 UTC 与北京日期、frozen_at、平台、config_sha256、C 监控段引用；创建时写 {}，freeze 完成后写全
    frozen: json("frozen").notNull(),
    // jcsSha256({plan_id, version, actor, key})
    idempotencyKey: sha256("idempotency_key"),
    // 未终态时 = jcsSha256({plan_id, version})，终态置空：同版本至多一个未终态运行
    activeKey: sha256("active_key"),
    // 必须是 user:<id>（继承提交人身份，design §9）
    submittedByActor: varchar("submitted_by_actor", { length: 128 }).notNull(),
    submittedByUserId: id("submitted_by_user_id"),
    scopeSummary: json("scope_summary"),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseExpiresAt: utc("lease_expires_at"),
    fencingToken: id("fencing_token").notNull().default(sql`0`),
    nextTickAt: utc("next_tick_at"),
    attemptCount: int("attempt_count").notNull().default(0),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorDetail: json("last_error_detail"),
    participantCount: int("participant_count"),
    contentTotal: int("content_total"),
    c1Count: int("c1_count"),
    c2Count: int("c2_count"),
    c3Count: int("c3_count"),
    staleUsed: boolean("stale_used").notNull().default(false),
    startedAt: utc("started_at"),
    completedAt: utc("completed_at"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    // 仅 circle / compare：保留期
    expiresAt: utc("expires_at"),
  },
  (t): MySqlTableExtraConfigValue[] => [
    foreignKey({ name: "fk_jr_version", columns: [t.planId, t.version], foreignColumns: [judgementPlanVersions.planId, judgementPlanVersions.version] }),
    uniqueIndex("uq_jr_idempotency").on(t.idempotencyKey),
    uniqueIndex("uq_jr_active").on(t.activeKey),
    index("idx_jr_claim").on(t.status, t.nextTickAt, t.runId),
    index("idx_jr_plan_version").on(t.planId, t.version, t.runKind, t.status),
    index("idx_jr_completed").on(t.runKind, t.status, t.completedAt, t.runId),
    check("ck_jr_kind", inList(t.runKind, JUDGEMENT_RUN_KINDS)),
    check("ck_jr_status", inList(t.status, JUDGEMENT_RUN_STATUSES)),
    check("ck_jr_active", sql`(${t.status} IN ('planned','running','waiting')) = (${t.activeKey} IS NOT NULL)`),
    check("ck_jr_lease", sql`${t.status} <> 'running' OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`),
    check("ck_jr_completed", sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`),
    check("ck_jr_expires", sql`${t.expiresAt} IS NULL OR ${t.runKind} <> 'execution'`),
    check("ck_jr_submitter", sql`${t.submittedByActor} REGEXP '^user:[0-9]{1,19}$'`),
  ],
);

// 一次运行冻结的参与专员（含冻结的组织链，即 E 需要的归属快照）
export const runParticipants = mysqlTable(
  "run_participants",
  {
    runId: id("run_id").notNull(),
    accountId: id("account_id").notNull(),
    staffId: id("staff_id").notNull(),
    storeId: id("store_id").notNull(),
    // dealer 是交叉维度，不参与上卷
    dealerId: id("dealer_id").notNull(),
    brandId: id("brand_id").notNull(),
    sectorId: id("sector_id").notNull(),
    branchId: id("branch_id").notNull(),
    regionId: id("region_id").notNull(),
    syncComplete: boolean("sync_complete"),
    // sync_failed / sync_gap / no_sync_in_window；完整时为空
    syncReason: varchar("sync_reason", { length: 32 }),
    // 内容要求（未启用时全部为 NULL）：T = P + F + U；skipped 不入 T
    contentTotal: int("content_total"),
    contentPass: int("content_pass"),
    contentFail: int("content_fail"),
    contentUnobtained: int("content_unobtained"),
    contentSkipped: int("content_skipped"),
    // c1 = l1 通过且被第 1 层选中的条数
    c1Count: int("c1_count"),
    c2Count: int("c2_count"),
    c3Count: int("c3_count"),
    // 未配置评论要求时为 NULL
    commentTotal: int("comment_total"),
    commentPass: int("comment_pass"),
    commentUnobtained: int("comment_unobtained"),
    contentResult: varchar("content_result", { length: 16 }),
    commentResult: varchar("comment_result", { length: 16 }),
    accountResult: varchar("account_result", { length: 16 }),
    planResult: varchar("plan_result", { length: 16 }),
    primaryReason: varchar("primary_reason", { length: 64 }),
    // 各类原因计数；含 like_not_value
    reasonDetail: json("reason_detail"),
    accountDetail: json("account_detail"),
    staleUsed: boolean("stale_used").notNull().default(false),
    state: varchar("state", { length: 16 }).notNull().default("pending"),
  },
  (t): MySqlTableExtraConfigValue[] => [
    primaryKey({ name: "pk_run_participants", columns: [t.runId, t.accountId] }),
    uniqueIndex("uq_rp_run_staff").on(t.runId, t.staffId),
    foreignKey({ name: "fk_rp_run", columns: [t.runId], foreignColumns: [judgementRuns.runId] }),
    foreignKey({ name: "fk_rp_account", columns: [t.accountId], foreignColumns: [externalAccounts.accountId] }),
    foreignKey({ name: "fk_rp_staff", columns: [t.staffId], foreignColumns: [mediaStaff.staffId] }),
    foreignKey({ name: "fk_rp_store", columns: [t.storeId], foreignColumns: [stores.storeId] }),
    foreignKey({ name: "fk_rp_dealer", columns: [t.dealerId], foreignColumns: [dealers.dealerId] }),
    foreignKey({ name: "fk_rp_brand", columns: [t.brandId], foreignColumns: [brands.brandId] }),
    foreignKey({ name: "fk_rp_sector", columns: [t.sectorId], foreignColumns: [sectors.sectorId] }),
    foreignKey({ name: "fk_rp_branch", columns: [t.branchId], foreignColumns: [branches.branchId] }),
    foreignKey({ name: "fk_rp_region", columns: [t.regionId], foreignColumns: [regions.regionId] }),
    index("idx_rp_result").on(t.runId, t.planResult),
    index("idx_rp_branch").on(t.runId, t.branchId),
    index("idx_rp_store").on(t.runId, t.storeId),
    check("ck_rp_state", inList(t.state, JUDGEMENT_PARTICIPANT_STATES)),
    check("ck_rp_content_result", nullableIn(t.contentResult, JUDGEMENT_OUTCOMES)),
    check("ck_rp_comment_result", nullableIn(t.commentResult, JUDGEMENT_OUTCOMES)),
    check("ck_rp_account_result", nullableIn(t.accountResult, JUDGEMENT_OUTCOMES)),
    check("ck_rp_plan_result", nullableIn(t.planResult, JUDGEMENT_OUTCOMES)),
    // 聚合完成的专员一定有计划总结果
    check("ck_rp_done", sql`(${t.state} = 'done') = (${t.planResult} IS NOT NULL)`),
  ],
);

// 一次运行里一条参与内容一行；NULL 的层结果 = 还没评估（阶段内的待办标记）
export const runContents = mysqlTable(
  "run_contents",
  {
    runId: id("run_id").notNull(),
    contentId: id("content_id").notNull(),
    accountId: id("account_id").notNull(),
    // 冻结的快照与发布时间、点赞（沿用 A 的值状态词表）
    contentSnapshotId: id("content_snapshot_id").notNull(),
    publishedAt: utc("published_at"),
    likeValue: id("like_value"),
    likeState: varchar("like_state", { length: 32 }).notNull(),
    // 只对 l1 = pass 的行有值；未配置 N 时 l1 = pass 的行全部选中、rank 为 NULL
    layer1Selected: boolean("layer1_selected"),
    layer1Rank: int("layer1_rank"),
    l0: varchar("l0", { length: 16 }),
    l1: varchar("l1", { length: 16 }),
    l2: varchar("l2", { length: 16 }),
    l3: varchar("l3", { length: 16 }),
    final: varchar("final", { length: 16 }),
    reasonCode: varchar("reason_code", { length: 64 }),
    stopLayer: varchar("stop_layer", { length: 8 }),
    stale: boolean("stale").notNull().default(false),
    cmTotal: int("cm_total"),
    cmPass: int("cm_pass"),
    cmUnobtained: int("cm_unobtained"),
    cmSamples: json("cm_samples"),
    // 自包含证据，不含正文 / 评论原文 / 作者
    evidence: json("evidence"),
  },
  (t): MySqlTableExtraConfigValue[] => [
    primaryKey({ name: "pk_run_contents", columns: [t.runId, t.contentId] }),
    foreignKey({ name: "fk_rc_participant", columns: [t.runId, t.accountId], foreignColumns: [runParticipants.runId, runParticipants.accountId] }),
    foreignKey({ name: "fk_rc_snapshot", columns: [t.contentId, t.contentSnapshotId], foreignColumns: [contentSnapshots.contentId, contentSnapshots.contentSnapshotId] }),
    index("idx_rc_account_final").on(t.runId, t.accountId, t.final),
    index("idx_rc_l1").on(t.runId, t.l1),
    index("idx_rc_account_selected").on(t.runId, t.accountId, t.layer1Selected),
    check("ck_rc_like", valueStateCheck(t.likeValue, t.likeState)),
    check("ck_rc_l0", nullableIn(t.l0, ["pass", "unobtained"])),
    check("ck_rc_l1", nullableIn(t.l1, JUDGEMENT_LAYER_RESULTS)),
    check("ck_rc_l2", nullableIn(t.l2, JUDGEMENT_LAYER_RESULTS)),
    check("ck_rc_l3", nullableIn(t.l3, JUDGEMENT_LAYER_RESULTS)),
    check("ck_rc_final", nullableIn(t.final, JUDGEMENT_FINAL_RESULTS)),
    check("ck_rc_selected", sql`${t.layer1Selected} IS NULL OR COALESCE(${t.l1} = 'pass', FALSE)`),
    check("ck_rc_rank", sql`${t.layer1Rank} IS NULL OR (${t.layer1Selected} IS NOT NULL AND ${t.layer1Rank} > 0)`),
    // skipped 当且仅当「第 1 层通过但未被选中」
    check("ck_rc_skipped", sql`COALESCE(${t.final} = 'skipped', FALSE) = COALESCE(${t.l1} = 'pass' AND ${t.layer1Selected} = FALSE, FALSE)`),
  ],
);
