// v2 §8 账号身份、归属与主页快照。
// 2026-11-04 修订：归属是账号上的当前单一事实（一账号一行，无区间）；命名空间是代码枚举（namespace_code + CHECK）。
import { sql } from "drizzle-orm";
import { type AnyMySqlColumn, type MySqlTableExtraConfigValue, boolean, check, foreignKey, index, json, longtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { binText, id, inList, sha256, utc, valueStateCheck } from "../columns";
import { odsProviderCalls, syncBatches } from "./sync";
import { dataProviders, platforms } from "./reference";
import { mediaStaff } from "./org";

/** D-25：代码枚举。新增 namespace 必须先改 CONTEXT、此处与 CHECK（迁移）。 */
export const IDENTIFIER_NAMESPACES = [
  "douyin.user_id",
  "douyin.sec_uid",
  "xiaohongshu.profile.user_id",
  "xiaohongshu.content.user_id",
  "kuaishou.user_id",
] as const;

export const externalAccounts = mysqlTable(
  "external_accounts",
  {
    accountId: id("account_id").primaryKey().autoincrement(),
    platformId: id("platform_id")
      .notNull()
      .references((): AnyMySqlColumn => platforms.platformId),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    statusReason: varchar("status_reason", { length: 256 }),
    statusChangedAt: utc("status_changed_at"),
    currentProfileSnapshotId: id("current_profile_snapshot_id"),
    currentProfileSelectedAt: utc("current_profile_selected_at"),
    firstSeenAt: utc("first_seen_at").notNull(),
    lastSeenAt: utc("last_seen_at").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t): MySqlTableExtraConfigValue[] => [
    uniqueIndex("uq_accounts_id_platform").on(t.accountId, t.platformId),
    index("idx_accounts_platform_status").on(t.platformId, t.status, t.lastSeenAt),
    index("idx_accounts_current_profile").on(t.currentProfileSnapshotId),
    check("ck_accounts_status", inList(t.status, ["active", "unavailable", "deleted"])),
    // v2 §5.4：current 指针只能指向自身快照；先建根表和快照表，再补这条循环复合 FK
    foreignKey({
      name: "fk_accounts_current_profile",
      columns: [t.accountId, t.currentProfileSnapshotId],
      foreignColumns: [accountProfileSnapshots.accountId, accountProfileSnapshots.profileSnapshotId],
    }),
  ],
);

export const externalAccountIdentifiers = mysqlTable(
  "external_account_identifiers",
  {
    accountIdentifierId: id("account_identifier_id").primaryKey().autoincrement(),
    accountId: id("account_id")
      .notNull(),
    namespaceCode: varchar("namespace_code", { length: 128 }).notNull(),
    identifierValue: binText("identifier_value", { length: 2048 }).notNull(),
    identifierSha256: sha256("identifier_sha256").notNull(),
    bindingMethod: varchar("binding_method", { length: 32 }).notNull(),
    confidence: varchar("confidence", { length: 16 }).notNull(),
    bindingPolicyVersion: varchar("binding_policy_version", { length: 64 }),
    bindingEvidence: json("binding_evidence"),
    bindingEvidenceSha256: sha256("binding_evidence_sha256"),
    evidenceBatchId: id("evidence_batch_id"),
    firstSeenAt: utc("first_seen_at").notNull(),
    lastSeenAt: utc("last_seen_at").notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (t): MySqlTableExtraConfigValue[] => [
    foreignKey({ name: "fk_identifiers_account", columns: [t.accountId], foreignColumns: [externalAccounts.accountId] }),
    foreignKey({ name: "fk_identifiers_evidence_batch", columns: [t.evidenceBatchId], foreignColumns: [syncBatches.batchId] }),
    // 哈希命中后必须复核原文（identifierValue 用 utf8mb4_bin 精确比较）
    uniqueIndex("uq_identifiers_namespace_sha").on(t.namespaceCode, t.identifierSha256),
    index("idx_identifiers_account_ns").on(t.accountId, t.namespaceCode),
    index("idx_identifiers_evidence_batch").on(t.evidenceBatchId),
    check("ck_identifiers_namespace", inList(t.namespaceCode, IDENTIFIER_NAMESPACES)),
    check("ck_identifiers_method", inList(t.bindingMethod, ["same_payload", "dominant_list_author", "provider_mapping", "manual"])),
    check("ck_identifiers_confidence", inList(t.confidence, ["observed", "verified"])),
    // 四个 evidence 字段必须同空同非空；dominant_list_author 时必须全部非空
    check(
      "ck_identifiers_evidence_all_or_none",
      sql`(${t.bindingPolicyVersion} IS NULL AND ${t.bindingEvidence} IS NULL AND ${t.bindingEvidenceSha256} IS NULL AND ${t.evidenceBatchId} IS NULL) OR (${t.bindingPolicyVersion} IS NOT NULL AND ${t.bindingEvidence} IS NOT NULL AND ${t.bindingEvidenceSha256} IS NOT NULL AND ${t.evidenceBatchId} IS NOT NULL)`,
    ),
    check(
      "ck_identifiers_dominant_has_evidence",
      sql`${t.bindingMethod} <> 'dominant_list_author' OR (${t.bindingPolicyVersion} IS NOT NULL AND ${t.bindingEvidence} IS NOT NULL AND ${t.bindingEvidenceSha256} IS NOT NULL AND ${t.evidenceBatchId} IS NOT NULL)`,
    ),
  ],
);

export const staffAccountAssignments = mysqlTable(
  "staff_account_assignments",
  {
    assignmentId: id("assignment_id").primaryKey().autoincrement(),
    watchType: varchar("watch_type", { length: 16 }).notNull().default("staff"),
    staffId: id("staff_id").references((): AnyMySqlColumn => mediaStaff.staffId),
    accountId: id("account_id").notNull(),
    platformId: id("platform_id").notNull(),
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    currentHomeLocator: longtext("current_home_locator").notNull(),
    currentHomeLocatorSha256: sha256("current_home_locator_sha256").notNull(),
    previousHomeLocator: longtext("previous_home_locator"),
    previousHomeLocatorSha256: sha256("previous_home_locator_sha256"),
    resolvedHomeUrl: longtext("resolved_home_url").notNull(),
    resolvedHomeUrlSha256: sha256("resolved_home_url_sha256").notNull(),
    intakeStatus: varchar("intake_status", { length: 32 }).notNull(),
    monitoringClosedReason: varchar("monitoring_closed_reason", { length: 32 }),
    slotReleasedAt: utc("slot_released_at"),
    // D-69：一个专员在同一平台最多一个占用名额的账号
    activeStaffPlatform: id("active_staff_platform").generatedAlwaysAs(
      sql`(CASE WHEN watch_type = 'staff' AND slot_released_at IS NULL THEN staff_id END)`,
      { mode: "stored" },
    ),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t): MySqlTableExtraConfigValue[] => [
    foreignKey({
      name: "fk_assignments_account_platform",
      columns: [t.accountId, t.platformId],
      foreignColumns: [externalAccounts.accountId, externalAccounts.platformId],
    }),
    uniqueIndex("uq_assignments_account").on(t.accountId),
    uniqueIndex("uq_assignments_staff_platform_slot").on(t.activeStaffPlatform, t.platformId),
    index("idx_assignments_staff_platform").on(t.staffId, t.platformId),
    index("idx_assignments_watch_monitoring").on(t.watchType, t.monitoringEnabled),
    check("ck_assignments_watch_type", inList(t.watchType, ["staff", "external"])),
    check(
      "ck_assignments_staff_by_type",
      sql`(${t.watchType} = 'staff' AND ${t.staffId} IS NOT NULL) OR (${t.watchType} = 'external' AND ${t.staffId} IS NULL)`,
    ),
    check("ck_assignments_intake_status", inList(t.intakeStatus, ["normal", "suspected_empty"])),
    check(
      "ck_assignments_previous_locator_pair",
      sql`(${t.previousHomeLocator} IS NULL) = (${t.previousHomeLocatorSha256} IS NULL)`,
    ),
    check("ck_assignments_closed_reason", sql`${t.monitoringEnabled} OR ${t.monitoringClosedReason} IS NOT NULL`),
    check(
      "ck_assignments_closed_reason_values",
      sql`${t.monitoringClosedReason} IS NULL OR ${t.monitoringClosedReason} IN ('manual','unreferenced_15d')`,
    ),
  ],
);

export const accountProfileSnapshots = mysqlTable(
  "account_profile_snapshots",
  {
    profileSnapshotId: id("profile_snapshot_id").primaryKey().autoincrement(),
    batchId: id("batch_id")
      .notNull()
      .references((): AnyMySqlColumn => syncBatches.batchId),
    accountId: id("account_id")
      .notNull(),
    assignmentId: id("assignment_id")
      .notNull(),
    providerId: id("provider_id")
      .notNull(),
    // 一年期来源调用：ODS 到期后置空，快照本身长期保留
    sourceProviderCallId: id("source_provider_call_id"),
    nickname: varchar("nickname", { length: 512 }),
    signature: longtext("signature"),
    location: varchar("location", { length: 256 }),
    followerValue: id("follower_value"),
    followingValue: id("following_value"),
    likeValue: id("like_value"),
    postValue: id("post_value"),
    followerState: varchar("follower_state", { length: 32 }).notNull(),
    followingState: varchar("following_state", { length: 32 }).notNull(),
    likeState: varchar("like_state", { length: 32 }).notNull(),
    postState: varchar("post_state", { length: 32 }).notNull(),
    providerUpdatedAt: utc("provider_updated_at"),
    responseReceivedAt: utc("response_received_at").notNull(),
    adapterVersion: varchar("adapter_version", { length: 64 }).notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (t): MySqlTableExtraConfigValue[] => [
    foreignKey({ name: "fk_profile_snap_account", columns: [t.accountId], foreignColumns: [externalAccounts.accountId] }),
    foreignKey({ name: "fk_profile_snap_assignment", columns: [t.assignmentId], foreignColumns: [staffAccountAssignments.assignmentId] }),
    foreignKey({ name: "fk_profile_snap_provider", columns: [t.providerId], foreignColumns: [dataProviders.providerId] }),
    foreignKey({ name: "fk_profile_snap_call", columns: [t.sourceProviderCallId], foreignColumns: [odsProviderCalls.providerCallId] }).onDelete("set null"),
    uniqueIndex("uq_profile_snapshots_batch_account").on(t.batchId, t.accountId),
    uniqueIndex("uq_profile_snapshots_account_id").on(t.accountId, t.profileSnapshotId),
    index("idx_profile_snapshots_account_batch").on(t.accountId, t.batchId),
    index("idx_profile_snapshots_assignment_batch").on(t.assignmentId, t.batchId),
    check("ck_profile_follower", valueStateCheck(t.followerValue, t.followerState)),
    check("ck_profile_following", valueStateCheck(t.followingValue, t.followingState)),
    check("ck_profile_like", valueStateCheck(t.likeValue, t.likeState)),
    check("ck_profile_post", valueStateCheck(t.postValue, t.postState)),
  ],
);
