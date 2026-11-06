// v2 §10 内容、批次快照、列表出现（comments 不在本 spec）。
// 2026-11-04 修订：contents 按被观察账号保存（唯一键含 account_id）；content_kind 不含 mixed。
import { sql } from "drizzle-orm";
import { type AnyMySqlColumn, boolean, check, decimal, foreignKey, index, int, json, longtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { binText, id, inList, sha256, utc, valueStateCheck } from "../columns";
import { externalAccounts, staffAccountAssignments } from "./accounts";
import { brands, mediaStaff, stores } from "./org";
import { platforms } from "./reference";
import { odsProviderCalls, syncBatches } from "./sync";

export const contents = mysqlTable(
  "contents",
  {
    contentId: id("content_id").primaryKey().autoincrement(),
    platformId: id("platform_id")
      .notNull()
      .references((): AnyMySqlColumn => platforms.platformId),
    accountId: id("account_id")
      .notNull()
      .references((): AnyMySqlColumn => externalAccounts.accountId),
    platformContentId: binText("platform_content_id", { length: 2048 }).notNull(),
    platformContentIdSha256: sha256("platform_content_id_sha256").notNull(),
    contentKind: varchar("content_kind", { length: 32 }).notNull().default("unknown"),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    statusReason: varchar("status_reason", { length: 256 }),
    statusChangedAt: utc("status_changed_at"),
    currentSnapshotId: id("current_snapshot_id"),
    currentSnapshotSelectedAt: utc("current_snapshot_selected_at"),
    firstSeenAt: utc("first_seen_at").notNull(),
    lastSeenAt: utc("last_seen_at").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    // 命中后复核原文（platformContentId 为 utf8mb4_bin）；同一作品在两个被观察账号下是两条内容
    uniqueIndex("uq_contents_account_content").on(t.platformId, t.accountId, t.platformContentIdSha256),
    index("idx_contents_platform_content").on(t.platformId, t.platformContentIdSha256),
    index("idx_contents_platform_status").on(t.platformId, t.status, t.lastSeenAt),
    index("idx_contents_current_snapshot").on(t.currentSnapshotId),
    check("ck_contents_kind", inList(t.contentKind, ["unknown", "video", "image", "text"])),
    check("ck_contents_status", inList(t.status, ["active", "unavailable", "deleted"])),
    foreignKey({
      name: "fk_contents_current_snapshot",
      columns: [t.contentId, t.currentSnapshotId],
      foreignColumns: [contentSnapshots.contentId, contentSnapshots.contentSnapshotId],
    }),
  ],
);

export const contentSnapshots = mysqlTable(
  "content_snapshots",
  {
    contentSnapshotId: id("content_snapshot_id").primaryKey().autoincrement(),
    batchId: id("batch_id")
      .notNull()
      .references((): AnyMySqlColumn => syncBatches.batchId),
    contentId: id("content_id")
      .notNull()
      .references((): AnyMySqlColumn => contents.contentId),
    snapshotStatus: varchar("snapshot_status", { length: 16 }).notNull(),
    // v2 修订 7：*_namespace_id → *_namespace_code
    returnedAuthorNamespaceCode: varchar("returned_author_namespace_code", { length: 128 }),
    returnedAuthorIdentifier: binText("returned_author_identifier", { length: 2048 }),
    returnedAuthorName: varchar("returned_author_name", { length: 512 }),
    publishedAt: utc("published_at"),
    title: longtext("title"),
    body: longtext("body"),
    tagText: longtext("tag_text"),
    publishLocation: varchar("publish_location", { length: 512 }),
    relatedSearchTerms: json("related_search_terms"),
    shareUrl: longtext("share_url"),
    shareUrlSha256: sha256("share_url_sha256"),
    durationValue: decimal("duration_value", { precision: 20, scale: 6 }),
    durationState: varchar("duration_state", { length: 32 }).notNull(),
    durationUnit: varchar("duration_unit", { length: 32 }).notNull().default("unknown"),
    playValue: id("play_value"),
    likeValue: id("like_value"),
    commentValue: id("comment_value"),
    collectValue: id("collect_value"),
    shareValue: id("share_value"),
    forwardValue: id("forward_value"),
    playState: varchar("play_state", { length: 32 }).notNull(),
    likeState: varchar("like_state", { length: 32 }).notNull(),
    commentState: varchar("comment_state", { length: 32 }).notNull(),
    collectState: varchar("collect_state", { length: 32 }).notNull(),
    shareState: varchar("share_state", { length: 32 }).notNull(),
    forwardState: varchar("forward_state", { length: 32 }).notNull(),
    listObserved: boolean("list_observed").notNull().default(false),
    detailObserved: boolean("detail_observed").notNull().default(false),
    lastListProviderCallId: id("last_list_provider_call_id"),
    lastDetailProviderCallId: id("last_detail_provider_call_id"),
    listResponseReceivedAt: utc("list_response_received_at"),
    detailResponseReceivedAt: utc("detail_response_received_at"),
    snapshotAt: utc("snapshot_at").notNull(),
    // R1：按需批次以该 finalized 快照为种子建立本行；快照到快照的血缘，不同于 sync_tasks.source_content_snapshot_id
    seededFromSnapshotId: id("seeded_from_snapshot_id"),
    mergePolicyVersion: varchar("merge_policy_version", { length: 64 }).notNull(),
    listAdapterVersion: varchar("list_adapter_version", { length: 64 }),
    detailAdapterVersion: varchar("detail_adapter_version", { length: 64 }),
    finalizedAt: utc("finalized_at"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_content_snap_seeded_from", columns: [t.seededFromSnapshotId], foreignColumns: [t.contentSnapshotId] }),
    index("idx_content_snapshots_seeded_from").on(t.seededFromSnapshotId),
    check("ck_content_snapshots_seeded", sql`${t.seededFromSnapshotId} IS NULL OR (${t.listObserved} = FALSE AND ${t.detailObserved} = TRUE)`),
    foreignKey({ name: "fk_content_snap_list_call", columns: [t.lastListProviderCallId], foreignColumns: [odsProviderCalls.providerCallId] }).onDelete("set null"),
    foreignKey({ name: "fk_content_snap_detail_call", columns: [t.lastDetailProviderCallId], foreignColumns: [odsProviderCalls.providerCallId] }).onDelete("set null"),
    uniqueIndex("uq_content_snapshots_batch_content").on(t.batchId, t.contentId),
    uniqueIndex("uq_content_snapshots_content_id").on(t.contentId, t.contentSnapshotId),
    index("idx_content_snapshots_content_batch").on(t.contentId, t.batchId),
    index("idx_content_snapshots_batch_published").on(t.batchId, t.publishedAt),
    index("idx_content_snapshots_published").on(t.publishedAt, t.contentId),
    check("ck_content_snapshots_status", inList(t.snapshotStatus, ["building", "finalized"])),
    check(
      "ck_content_snapshots_finalized",
      sql`(${t.snapshotStatus} = 'building' AND ${t.finalizedAt} IS NULL) OR (${t.snapshotStatus} = 'finalized' AND ${t.finalizedAt} IS NOT NULL)`,
    ),
    check("ck_content_snapshots_play", valueStateCheck(t.playValue, t.playState)),
    check("ck_content_snapshots_like", valueStateCheck(t.likeValue, t.likeState)),
    check("ck_content_snapshots_comment", valueStateCheck(t.commentValue, t.commentState)),
    check("ck_content_snapshots_collect", valueStateCheck(t.collectValue, t.collectState)),
    check("ck_content_snapshots_share", valueStateCheck(t.shareValue, t.shareState)),
    check("ck_content_snapshots_forward", valueStateCheck(t.forwardValue, t.forwardState)),
    check(
      "ck_content_snapshots_duration",
      sql`(${t.durationState} = 'value' AND ${t.durationValue} IS NOT NULL AND ${t.durationValue} >= 0) OR (${t.durationState} IN ('missing','explicit_null','invalid','unsupported') AND ${t.durationValue} IS NULL)`,
    ),
    check("ck_content_snapshots_share_url", sql`(${t.shareUrl} IS NULL) = (${t.shareUrlSha256} IS NULL)`),
    check(
      "ck_content_snapshots_author_pair",
      sql`(${t.returnedAuthorNamespaceCode} IS NULL) = (${t.returnedAuthorIdentifier} IS NULL)`,
    ),
  ],
);

export const contentDiscoveries = mysqlTable(
  "content_discoveries",
  {
    discoveryId: id("discovery_id").primaryKey().autoincrement(),
    batchId: id("batch_id")
      .notNull()
      .references((): AnyMySqlColumn => syncBatches.batchId),
    assignmentId: id("assignment_id")
      .notNull(),
    contentId: id("content_id")
      .notNull()
      .references((): AnyMySqlColumn => contents.contentId),
    pageNo: int("page_no").notNull(),
    positionInPage: int("position_in_page").notNull(),
    absolutePosition: int("absolute_position").notNull(),
    isPotentiallyPinned: boolean("is_potentially_pinned").notNull(),
    discoveredAt: utc("discovered_at").notNull(),
    sourceProviderCallId: id("source_provider_call_id"),
    // 采集当时的归属快照（CONTEXT 不变量 19、D-67）：改绑只更新归属行，不改写这三列。
    // external 型账号没有专员 / 门店 / 品牌，三列同为空。
    ownerStaffId: id("owner_staff_id"),
    ownerStoreId: id("owner_store_id"),
    ownerBrandId: id("owner_brand_id"),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_discoveries_assignment", columns: [t.assignmentId], foreignColumns: [staffAccountAssignments.assignmentId] }),
    // RESTRICT：被历史发现引用的专员 / 门店 / 品牌不能物理删除
    foreignKey({ name: "fk_discoveries_owner_staff", columns: [t.ownerStaffId], foreignColumns: [mediaStaff.staffId] }),
    foreignKey({ name: "fk_discoveries_owner_store", columns: [t.ownerStoreId], foreignColumns: [stores.storeId] }),
    foreignKey({ name: "fk_discoveries_owner_brand", columns: [t.ownerBrandId], foreignColumns: [brands.brandId] }),
    check(
      "ck_discoveries_owner_snapshot",
      sql`(${t.ownerStaffId} IS NULL AND ${t.ownerStoreId} IS NULL AND ${t.ownerBrandId} IS NULL) OR (${t.ownerStaffId} IS NOT NULL AND ${t.ownerStoreId} IS NOT NULL AND ${t.ownerBrandId} IS NOT NULL)`,
    ),
    foreignKey({ name: "fk_discoveries_call", columns: [t.sourceProviderCallId], foreignColumns: [odsProviderCalls.providerCallId] }).onDelete("set null"),
    uniqueIndex("uq_discoveries_batch_assignment_content").on(t.batchId, t.assignmentId, t.contentId),
    index("idx_discoveries_assignment_batch_pos").on(t.assignmentId, t.batchId, t.absolutePosition),
    index("idx_discoveries_content_batch").on(t.contentId, t.batchId),
    index("idx_discoveries_batch_pinned").on(t.batchId, t.isPotentiallyPinned),
    check("ck_discoveries_positions", sql`${t.pageNo} >= 0 AND ${t.positionInPage} >= 0 AND ${t.absolutePosition} >= 0`),
  ],
);

/**
 * v2 §10.4 `comments`：一级评论最新态。tracer 的初始迁移没有建它（comments 不在 tracer 范围），a-full-sync 任务 6 按 v2 原文补建，
 * 不是新设计：不建作者账号、作者历史、头像媒资或回复树；只有完整抓取才能把缺失的旧评论置 suspected_deleted。
 */
export const comments = mysqlTable(
  "comments",
  {
    commentId: id("comment_id").primaryKey().autoincrement(),
    contentId: id("content_id")
      .notNull()
      .references((): AnyMySqlColumn => contents.contentId),
    platformCommentId: binText("platform_comment_id", { length: 2048 }).notNull(),
    platformCommentIdSha256: sha256("platform_comment_id_sha256").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    authorIdentifier: binText("author_identifier", { length: 2048 }),
    authorName: varchar("author_name", { length: 512 }),
    contentText: longtext("content_text"),
    likeValue: id("like_value"),
    likeState: varchar("like_state", { length: 32 }).notNull(),
    replyValue: id("reply_value"),
    replyState: varchar("reply_state", { length: 32 }).notNull(),
    platformCreatedAt: utc("platform_created_at"),
    providerUpdatedAt: utc("provider_updated_at"),
    firstSeenAt: utc("first_seen_at").notNull(),
    lastSeenAt: utc("last_seen_at").notNull(),
    suspectedDeletedAt: utc("suspected_deleted_at"),
    deletedAt: utc("deleted_at"),
    lastProviderCallId: id("last_provider_call_id"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_comments_call", columns: [t.lastProviderCallId], foreignColumns: [odsProviderCalls.providerCallId] }).onDelete("set null"),
    // 命中后复核原文（platform_comment_id 为 utf8mb4_bin）
    uniqueIndex("uq_comments_content_comment").on(t.contentId, t.platformCommentIdSha256),
    index("idx_comments_content_status_created").on(t.contentId, t.status, t.platformCreatedAt),
    index("idx_comments_last_seen").on(t.lastSeenAt),
    check("ck_comments_status", inList(t.status, ["active", "suspected_deleted", "deleted"])),
    check("ck_comments_like", valueStateCheck(t.likeValue, t.likeState)),
    check("ck_comments_reply", valueStateCheck(t.replyValue, t.replyState)),
  ],
);
