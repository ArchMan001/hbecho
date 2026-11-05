// v2 §9 同步控制、ODS 与质量问题（import_batches / import_row_results 在 ./import.ts）。
import { sql } from "drizzle-orm";
import { type AnyMySqlColumn, boolean, check, decimal, foreignKey, index, int, json, mysqlTable, smallint, tinyint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { counter, id, inList, sha256, utc } from "../columns";
import { contents } from "./content";
import { externalAccounts, staffAccountAssignments } from "./accounts";
import { dataProviders, platforms } from "./reference";
import { importBatches } from "./import";
import { ossObjects } from "./media";

export const syncSettings = mysqlTable(
  "sync_settings",
  {
    settingsId: tinyint("settings_id").primaryKey().default(1),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Shanghai"),
    scheduleSlots: json("schedule_slots").notNull(),
    initialContentLimit: int("initial_content_limit").notNull().default(20),
    listSafetyPageLimit: int("list_safety_page_limit").notNull(),
    commentPageLimit: int("comment_page_limit"),
    commentItemLimit: int("comment_item_limit"),
    accountResolveMaxAttempts: int("account_resolve_max_attempts").notNull().default(3),
    taskMaxAttempts: int("task_max_attempts").notNull(),
    configVersion: id("config_version").notNull(),
    updatedByActor: varchar("updated_by_actor", { length: 128 }),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    check("ck_sync_settings_singleton", sql`${t.settingsId} = 1`),
    check("ck_sync_settings_slots", sql`JSON_LENGTH(${t.scheduleSlots}) BETWEEN 1 AND 2`),
    check("ck_sync_settings_initial_limit", sql`${t.initialContentLimit} BETWEEN 1 AND 20`),
    check("ck_sync_settings_positive", sql`${t.listSafetyPageLimit} > 0 AND ${t.taskMaxAttempts} > 0 AND ${t.accountResolveMaxAttempts} > 0`),
    check(
      "ck_sync_settings_comment_limits",
      sql`(${t.commentPageLimit} IS NOT NULL OR ${t.commentItemLimit} IS NOT NULL) AND (${t.commentPageLimit} IS NULL OR ${t.commentPageLimit} > 0) AND (${t.commentItemLimit} IS NULL OR ${t.commentItemLimit} > 0)`,
    ),
  ],
);

export const syncBatches = mysqlTable(
  "sync_batches",
  {
    batchId: id("batch_id").primaryKey().autoincrement(),
    batchKey: sha256("batch_key").notNull(),
    triggerType: varchar("trigger_type", { length: 32 }).notNull(),
    logicalAt: utc("logical_at").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    settingsVersion: id("settings_version").notNull(),
    settingsSnapshot: json("settings_snapshot").notNull(),
    detailRuleVersion: varchar("detail_rule_version", { length: 128 }),
    commentRuleVersion: varchar("comment_rule_version", { length: 128 }),
    plannedTaskCount: counter("planned_task_count").notNull().default(0),
    succeededTaskCount: counter("succeeded_task_count").notNull().default(0),
    failedTaskCount: counter("failed_task_count").notNull().default(0),
    skippedTaskCount: counter("skipped_task_count").notNull().default(0),
    gapTaskCount: counter("gap_task_count").notNull().default(0),
    skipReason: varchar("skip_reason", { length: 128 }),
    startedAt: utc("started_at"),
    finishedAt: utc("finished_at"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_sync_batches_key").on(t.batchKey),
    index("idx_sync_batches_status_logical").on(t.status, t.logicalAt),
    check("ck_sync_batches_trigger", inList(t.triggerType, ["scheduled", "manual"])),
    check(
      "ck_sync_batches_status",
      inList(t.status, ["planned", "queued", "running", "succeeded", "partial_succeeded", "failed", "cancelled", "skipped", "expired"]),
    ),
    check(
      "ck_sync_batches_counts",
      sql`${t.plannedTaskCount} >= 0 AND ${t.succeededTaskCount} >= 0 AND ${t.failedTaskCount} >= 0 AND ${t.skippedTaskCount} >= 0 AND ${t.gapTaskCount} >= 0`,
    ),
  ],
);

export const SYNC_TASK_STATUSES = [
  "pending",
  "leased",
  "running",
  "retry_wait",
  "succeeded",
  "succeeded_with_gap",
  "failed",
  "dead",
  "cancelled",
] as const;

export const SYNC_TASK_ACTIONS = [
  "resolve_account",
  "fetch_profile",
  "fetch_content_list",
  "fetch_content_detail",
  "fetch_comments",
  "download_media",
] as const;

export const syncTasks = mysqlTable(
  "sync_tasks",
  {
    taskId: id("task_id").primaryKey().autoincrement(),
    batchId: id("batch_id")
      .notNull()
      .references((): AnyMySqlColumn => syncBatches.batchId),
    // 一年期：父任务到期清理后置空
    parentTaskId: id("parent_task_id"),
    providerId: id("provider_id")
      .notNull()
      .references((): AnyMySqlColumn => dataProviders.providerId),
    platformId: id("platform_id")
      .notNull()
      .references((): AnyMySqlColumn => platforms.platformId),
    assignmentId: id("assignment_id"),
    accountId: id("account_id").references((): AnyMySqlColumn => externalAccounts.accountId),
    contentId: id("content_id").references((): AnyMySqlColumn => contents.contentId),
    requestedAction: varchar("requested_action", { length: 64 }).notNull(),
    subjectType: varchar("subject_type", { length: 32 }).notNull(),
    subjectId: id("subject_id"),
    subjectKey: varchar("subject_key", { length: 2048 }),
    subjectKeySha256: sha256("subject_key_sha256"),
    taskParameters: json("task_parameters").notNull(),
    ruleDecisionId: varchar("rule_decision_id", { length: 256 }),
    ruleVersion: varchar("rule_version", { length: 128 }),
    sourceContentSnapshotId: id("source_content_snapshot_id"),
    idempotencyKey: sha256("idempotency_key").notNull(),
    submittedByActor: varchar("submitted_by_actor", { length: 128 }),
    callerIdempotencyKeySha256: sha256("caller_idempotency_key_sha256"),
    canonicalCommandSha256: sha256("canonical_command_sha256"),
    status: varchar("status", { length: 32 }).notNull(),
    priority: int("priority").notNull().default(0),
    attemptCount: int("attempt_count").notNull(),
    maxAttempts: int("max_attempts").notNull(),
    nextAttemptAt: utc("next_attempt_at"),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseExpiresAt: utc("lease_expires_at"),
    fencingToken: id("fencing_token").notNull().default(sql`0`),
    pageCount: counter("page_count").notNull().default(0),
    fetchedItemCount: counter("fetched_item_count").notNull().default(0),
    oldestPublishedAt: utc("oldest_published_at"),
    newestPublishedAt: utc("newest_published_at"),
    hasMoreAtStop: boolean("has_more_at_stop"),
    continuityGapDetected: boolean("continuity_gap_detected").notNull().default(false),
    windowOverflowDetected: boolean("window_overflow_detected").notNull().default(false),
    stopReason: varchar("stop_reason", { length: 64 }),
    resultSummary: json("result_summary"),
    lastErrorCode: varchar("last_error_code", { length: 128 }),
    lastErrorDetail: json("last_error_detail"),
    startedAt: utc("started_at"),
    finishedAt: utc("finished_at"),
    expiresAt: utc("expires_at").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_sync_tasks_assignment", columns: [t.assignmentId], foreignColumns: [staffAccountAssignments.assignmentId] }),
    foreignKey({ name: "fk_sync_tasks_parent", columns: [t.parentTaskId], foreignColumns: [t.taskId] }).onDelete("set null"),
    uniqueIndex("uq_sync_tasks_idempotency").on(t.idempotencyKey),
    uniqueIndex("uq_sync_tasks_caller_key").on(t.submittedByActor, t.callerIdempotencyKeySha256),
    index("idx_sync_tasks_claim").on(t.status, t.nextAttemptAt, t.priority, t.taskId),
    index("idx_sync_tasks_batch_status").on(t.batchId, t.status),
    index("idx_sync_tasks_account_action").on(t.accountId, t.requestedAction, t.createdAt),
    index("idx_sync_tasks_content_action").on(t.contentId, t.requestedAction, t.createdAt),
    index("idx_sync_tasks_parent").on(t.parentTaskId),
    // 提交时按 canonical command 查找活动 root（R1.8 复用）；v2 未列，属于查询所需的补充索引
    index("idx_sync_tasks_canonical_command").on(t.canonicalCommandSha256),
    index("idx_sync_tasks_expires").on(t.expiresAt),
    check("ck_sync_tasks_status", inList(t.status, SYNC_TASK_STATUSES)),
    check("ck_sync_tasks_action", inList(t.requestedAction, SYNC_TASK_ACTIONS)),
    // 调用者幂等摘要、canonical command 摘要与 actor 对根命令同空同非空
    check(
      "ck_sync_tasks_command_triple",
      sql`((${t.submittedByActor} IS NULL) = (${t.callerIdempotencyKeySha256} IS NULL)) AND ((${t.callerIdempotencyKeySha256} IS NULL) = (${t.canonicalCommandSha256} IS NULL))`,
    ),
    check("ck_sync_tasks_attempts", sql`${t.attemptCount} >= 0 AND ${t.attemptCount} <= ${t.maxAttempts}`),
    check(
      "ck_sync_tasks_lease",
      sql`${t.status} NOT IN ('leased','running') OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
    check("ck_sync_tasks_overflow", sql`NOT ${t.windowOverflowDetected} OR ${t.continuityGapDetected}`),
    check(
      "ck_sync_tasks_gap",
      sql`${t.status} <> 'succeeded_with_gap' OR (${t.continuityGapDetected} AND ${t.stopReason} IS NOT NULL)`,
    ),
    check("ck_sync_tasks_counts", sql`${t.pageCount} >= 0 AND ${t.fetchedItemCount} >= 0 AND ${t.fencingToken} >= 0`),
    check("ck_sync_tasks_subject_key", sql`(${t.subjectKey} IS NULL) = (${t.subjectKeySha256} IS NULL)`),
  ],
);

export const syncCheckpoints = mysqlTable(
  "sync_checkpoints",
  {
    checkpointId: id("checkpoint_id").primaryKey().autoincrement(),
    accountId: id("account_id")
      .notNull()
      .references((): AnyMySqlColumn => externalAccounts.accountId),
    providerId: id("provider_id")
      .notNull()
      .references((): AnyMySqlColumn => dataProviders.providerId),
    action: varchar("action", { length: 64 }).notNull().default("fetch_content_list"),
    checkpointScope: varchar("checkpoint_scope", { length: 64 }).notNull().default("default"),
    anchorMode: varchar("anchor_mode", { length: 16 }).notNull(),
    highWatermarkPublishedAt: utc("high_watermark_published_at"),
    highWatermarkContentIds: json("high_watermark_content_ids"),
    cursorEnvelope: json("cursor_envelope"),
    cursorSha256: sha256("cursor_sha256"),
    cursorTaskId: id("cursor_task_id").references((): AnyMySqlColumn => syncTasks.taskId, { onDelete: "set null" }),
    lastSuccessfulBatchId: id("last_successful_batch_id"),
    lastSuccessfulTaskId: id("last_successful_task_id").references((): AnyMySqlColumn => syncTasks.taskId, { onDelete: "set null" }),
    continuityStatus: varchar("continuity_status", { length: 32 }).notNull(),
    lastGapAt: utc("last_gap_at"),
    version: id("version").notNull().default(sql`0`),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_checkpoints_batch", columns: [t.lastSuccessfulBatchId], foreignColumns: [syncBatches.batchId] }),
    uniqueIndex("uq_checkpoints_scope").on(t.accountId, t.providerId, t.action, t.checkpointScope),
    index("idx_checkpoints_batch").on(t.lastSuccessfulBatchId),
    check("ck_checkpoints_anchor_mode", inList(t.anchorMode, ["time", "id_window", "empty"])),
    check("ck_checkpoints_continuity", inList(t.continuityStatus, ["ready", "in_progress", "rebased_after_gap", "blocked"])),
    check("ck_checkpoints_cursor_pair", sql`(${t.cursorEnvelope} IS NULL) = (${t.cursorSha256} IS NULL)`),
    check(
      "ck_checkpoints_ids_array",
      sql`${t.highWatermarkContentIds} IS NULL OR JSON_TYPE(${t.highWatermarkContentIds}) = 'ARRAY'`,
    ),
    check(
      "ck_checkpoints_anchor_shape",
      sql`(${t.anchorMode} = 'time' AND ${t.highWatermarkPublishedAt} IS NOT NULL)
        OR (${t.anchorMode} = 'id_window' AND ${t.highWatermarkPublishedAt} IS NULL AND ${t.highWatermarkContentIds} IS NOT NULL AND JSON_LENGTH(${t.highWatermarkContentIds}) > 0)
        OR (${t.anchorMode} = 'empty' AND ${t.highWatermarkPublishedAt} IS NULL AND (${t.highWatermarkContentIds} IS NULL OR JSON_LENGTH(${t.highWatermarkContentIds}) = 0))`,
    ),
    check("ck_checkpoints_version", sql`${t.version} >= 0`),
  ],
);

export const odsProviderCalls = mysqlTable(
  "ods_provider_calls",
  {
    providerCallId: id("provider_call_id").primaryKey().autoincrement(),
    syncTaskId: id("sync_task_id")
      .notNull()
      .references((): AnyMySqlColumn => syncTasks.taskId),
    providerId: id("provider_id")
      .notNull()
      .references((): AnyMySqlColumn => dataProviders.providerId),
    platformId: id("platform_id").references((): AnyMySqlColumn => platforms.platformId),
    attemptNo: int("attempt_no").notNull(),
    callSequence: int("call_sequence").notNull(),
    requestedAction: varchar("requested_action", { length: 64 }).notNull(),
    expectedResponseAction: varchar("expected_response_action", { length: 64 }).notNull(),
    responseAction: varchar("response_action", { length: 64 }),
    endpoint: varchar("endpoint", { length: 1024 }).notNull(),
    requestMethod: varchar("request_method", { length: 16 }),
    httpStatus: smallint("http_status"),
    providerCode: varchar("provider_code", { length: 128 }),
    providerTaskId: varchar("provider_task_id", { length: 512 }),
    providerRequestId: varchar("provider_request_id", { length: 512 }),
    providerTaskStatus: varchar("provider_task_status", { length: 64 }),
    callStatus: varchar("call_status", { length: 32 }).notNull(),
    outcome: varchar("outcome", { length: 32 }),
    transportError: json("transport_error"),
    preparedAt: utc("prepared_at").notNull(),
    requestCapturedAt: utc("request_captured_at").notNull(),
    sendStartedAt: utc("send_started_at"),
    responseReceivedAt: utc("response_received_at"),
    finishedAt: utc("finished_at"),
    elapsedSeconds: decimal("elapsed_seconds", { precision: 20, scale: 6 }),
    terminalCapturedAt: utc("terminal_captured_at"),
    ambiguousAt: utc("ambiguous_at"),
    reconciledAt: utc("reconciled_at"),
    reconciliationMethod: varchar("reconciliation_method", { length: 64 }),
    // 偏离 v2 §9.5 文字（见 drizzle/ 迁移注释与 ADR-0005 已知坑 7）：
    // MySQL 禁止 CHECK 引用带 ON DELETE SET NULL 的列（错误 3823），而 reconciled 终态的 CHECK 必须引用本列，
    // 所以这里用 RESTRICT；v2 §12.7 规定的清理顺序（先删引用方、再删被引用方）本来就满足 RESTRICT。
    reconciledByProviderCallId: id("reconciled_by_provider_call_id"),
    expiresAt: utc("expires_at").notNull(),
  },
  (t) => {
    const sentStarted = sql`${t.sendStartedAt} IS NOT NULL`;
    return [
      foreignKey({
        name: "fk_calls_reconciled_by",
        columns: [t.reconciledByProviderCallId],
        foreignColumns: [t.providerCallId],
      }),
      uniqueIndex("uq_calls_task_attempt_seq").on(t.syncTaskId, t.attemptNo, t.callSequence),
      index("idx_calls_provider_task").on(t.providerTaskId),
      index("idx_calls_provider_request").on(t.providerRequestId),
      index("idx_calls_reconciled_by").on(t.reconciledByProviderCallId),
      index("idx_calls_prepared").on(t.preparedAt, t.providerCallId),
      index("idx_calls_status_prepared").on(t.callStatus, t.preparedAt),
      index("idx_calls_outcome_finished").on(t.outcome, t.finishedAt),
      index("idx_calls_expires").on(t.expiresAt),
      check("ck_calls_status", inList(t.callStatus, ["prepared", "in_flight", "terminal", "ambiguous"])),
      check(
        "ck_calls_outcome",
        sql`${t.outcome} IS NULL OR ${t.outcome} IN ('not_sent','succeeded','http_error','provider_error','invalid_response','transport_error','ambiguous','reconciled_succeeded','reconciled_failed')`,
      ),
      // §9.5 状态矩阵：每个 CHECK 只管一类状态，用「条件 → 要求」的蕴含写法
      check(
        "ck_calls_prepared",
        sql`${t.callStatus} <> 'prepared' OR (${t.outcome} IS NULL AND ${t.sendStartedAt} IS NULL AND ${t.responseReceivedAt} IS NULL AND ${t.finishedAt} IS NULL AND ${t.elapsedSeconds} IS NULL AND ${t.terminalCapturedAt} IS NULL AND ${t.ambiguousAt} IS NULL AND ${t.reconciledAt} IS NULL AND ${t.reconciliationMethod} IS NULL AND ${t.reconciledByProviderCallId} IS NULL AND ${t.transportError} IS NULL)`,
      ),
      check(
        "ck_calls_in_flight",
        sql`${t.callStatus} <> 'in_flight' OR (${t.outcome} IS NULL AND ${sentStarted} AND ${t.responseReceivedAt} IS NULL AND ${t.finishedAt} IS NULL AND ${t.elapsedSeconds} IS NULL AND ${t.terminalCapturedAt} IS NULL AND ${t.ambiguousAt} IS NULL AND ${t.reconciledAt} IS NULL AND ${t.reconciliationMethod} IS NULL AND ${t.reconciledByProviderCallId} IS NULL AND ${t.transportError} IS NULL)`,
      ),
      check(
        "ck_calls_not_sent",
        sql`${t.outcome} IS NULL OR ${t.outcome} <> 'not_sent' OR (${t.callStatus} = 'terminal' AND ${t.finishedAt} IS NOT NULL AND ${t.terminalCapturedAt} IS NOT NULL AND ${t.sendStartedAt} IS NULL AND ${t.responseReceivedAt} IS NULL AND ${t.elapsedSeconds} IS NULL AND ${t.ambiguousAt} IS NULL AND ${t.reconciledAt} IS NULL AND ${t.reconciliationMethod} IS NULL AND ${t.reconciledByProviderCallId} IS NULL AND ${t.transportError} IS NULL)`,
      ),
      check(
        "ck_calls_complete_response",
        sql`${t.outcome} IS NULL OR ${t.outcome} NOT IN ('succeeded','http_error','provider_error','invalid_response') OR (${t.callStatus} = 'terminal' AND ${sentStarted} AND ${t.responseReceivedAt} IS NOT NULL AND ${t.finishedAt} IS NOT NULL AND ${t.elapsedSeconds} IS NOT NULL AND ${t.terminalCapturedAt} IS NOT NULL AND ${t.httpStatus} IS NOT NULL AND ${t.ambiguousAt} IS NULL AND ${t.reconciledAt} IS NULL AND ${t.reconciliationMethod} IS NULL AND ${t.reconciledByProviderCallId} IS NULL AND ${t.transportError} IS NULL)`,
      ),
      check(
        "ck_calls_transport_error",
        sql`${t.outcome} IS NULL OR ${t.outcome} <> 'transport_error' OR (${t.callStatus} = 'terminal' AND ${sentStarted} AND ${t.finishedAt} IS NOT NULL AND ${t.elapsedSeconds} IS NOT NULL AND ${t.terminalCapturedAt} IS NOT NULL AND ${t.transportError} IS NOT NULL AND ${t.responseReceivedAt} IS NULL AND ${t.ambiguousAt} IS NULL AND ${t.reconciledAt} IS NULL AND ${t.reconciliationMethod} IS NULL AND ${t.reconciledByProviderCallId} IS NULL)`,
      ),
      check(
        "ck_calls_ambiguous",
        sql`${t.callStatus} <> 'ambiguous' OR (${t.outcome} = 'ambiguous' AND ${sentStarted} AND ${t.ambiguousAt} IS NOT NULL AND ${t.responseReceivedAt} IS NULL AND ${t.finishedAt} IS NULL AND ${t.elapsedSeconds} IS NULL AND ${t.terminalCapturedAt} IS NULL AND ${t.reconciledAt} IS NULL AND ${t.reconciliationMethod} IS NULL AND ${t.reconciledByProviderCallId} IS NULL)`,
      ),
      check(
        "ck_calls_reconciled",
        sql`${t.outcome} IS NULL OR ${t.outcome} NOT IN ('reconciled_succeeded','reconciled_failed') OR (${t.callStatus} = 'terminal' AND ${sentStarted} AND ${t.finishedAt} IS NOT NULL AND ${t.terminalCapturedAt} IS NOT NULL AND ${t.ambiguousAt} IS NOT NULL AND ${t.reconciledAt} IS NOT NULL AND ${t.reconciliationMethod} IS NOT NULL AND ${t.reconciledByProviderCallId} IS NOT NULL AND ${t.responseReceivedAt} IS NULL AND ${t.elapsedSeconds} IS NULL)`,
      ),
      // 「reconciled_by 不等于自身 ID」不能写成 CHECK：MySQL 禁止 CHECK 引用自增列（错误 3818），改由触发器保证（见 drizzle/ 手写迁移）
      // terminal 必须有 outcome；ambiguous 状态与 outcome 互相对应
      check("ck_calls_terminal_has_outcome", sql`${t.callStatus} <> 'terminal' OR ${t.outcome} IS NOT NULL`),
      check(
        "ck_calls_times",
        sql`(${t.sendStartedAt} IS NULL OR ${t.sendStartedAt} >= ${t.preparedAt})
          AND (${t.responseReceivedAt} IS NULL OR ${t.responseReceivedAt} >= ${t.sendStartedAt})
          AND (${t.ambiguousAt} IS NULL OR ${t.ambiguousAt} >= ${t.sendStartedAt})
          AND (${t.terminalCapturedAt} IS NULL OR ${t.terminalCapturedAt} >= ${t.finishedAt})
          AND (${t.reconciledAt} IS NULL OR (${t.reconciledAt} >= ${t.ambiguousAt} AND ${t.finishedAt} >= ${t.reconciledAt}))
          AND (${t.outcome} IS NULL OR ${t.outcome} IN ('not_sent','reconciled_succeeded','reconciled_failed','ambiguous') OR ${t.finishedAt} >= ${t.sendStartedAt})
          AND (${t.elapsedSeconds} IS NULL OR ${t.elapsedSeconds} >= 0)`,
      ),
    ];
  },
);

export const odsPayloads = mysqlTable(
  "ods_payloads",
  {
    payloadId: id("payload_id").primaryKey().autoincrement(),
    providerCallId: id("provider_call_id")
      .notNull(),
    payloadRole: varchar("payload_role", { length: 32 }).notNull(),
    contentType: varchar("content_type", { length: 255 }),
    contentEncoding: varchar("content_encoding", { length: 64 }),
    ossObjectId: id("oss_object_id").notNull(),
    objectCategory: varchar("object_category", { length: 32 }).notNull().default("ods"),
    byteLength: id("byte_length").notNull(),
    sha256: sha256("sha256").notNull(),
    parseStatus: varchar("parse_status", { length: 32 }).notNull(),
    adapterVersion: varchar("adapter_version", { length: 64 }),
    parseError: varchar("parse_error", { length: 2048 }),
    capturedAt: utc("captured_at").notNull(),
    expiresAt: utc("expires_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_payloads_call", columns: [t.providerCallId], foreignColumns: [odsProviderCalls.providerCallId] }),
    foreignKey({
      name: "fk_payloads_oss_object",
      columns: [t.ossObjectId, t.objectCategory],
      foreignColumns: [ossObjects.ossObjectId, ossObjects.objectCategory],
    }),
    uniqueIndex("uq_payloads_call_role").on(t.providerCallId, t.payloadRole),
    uniqueIndex("uq_payloads_oss_object").on(t.ossObjectId),
    index("idx_payloads_expires").on(t.expiresAt),
    index("idx_payloads_sha").on(t.sha256),
    check("ck_payloads_category", sql`${t.objectCategory} = 'ods'`),
    check("ck_payloads_role", inList(t.payloadRole, ["request_body", "response_body", "transport_error"])),
    check("ck_payloads_parse_status", inList(t.parseStatus, ["not_attempted", "parsed", "invalid"])),
    check(
      "ck_payloads_adapter_version",
      sql`(${t.parseStatus} = 'not_attempted' AND ${t.adapterVersion} IS NULL) OR (${t.parseStatus} IN ('parsed','invalid') AND ${t.adapterVersion} IS NOT NULL)`,
    ),
    check("ck_payloads_length", sql`${t.byteLength} >= 0`),
  ],
);

export const dataQualityIssues = mysqlTable(
  "data_quality_issues",
  {
    issueId: id("issue_id").primaryKey().autoincrement(),
    issueFingerprint: sha256("issue_fingerprint").notNull(),
    issueCode: varchar("issue_code", { length: 128 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }),
    entityId: id("entity_id"),
    batchId: id("batch_id").references((): AnyMySqlColumn => syncBatches.batchId),
    // R4：导入类问题（如待确认撤店）引用导入批次，与同步批次引用互斥
    importBatchId: id("import_batch_id"),
    accountId: id("account_id").references((): AnyMySqlColumn => externalAccounts.accountId),
    contentId: id("content_id").references((): AnyMySqlColumn => contents.contentId),
    assignmentId: id("assignment_id"),
    providerCallId: id("provider_call_id"),
    jsonPath: varchar("json_path", { length: 1024 }),
    detail: json("detail").notNull(),
    occurrenceCount: counter("occurrence_count").notNull().default(1),
    firstSeenAt: utc("first_seen_at").notNull(),
    lastSeenAt: utc("last_seen_at").notNull(),
    resolvedAt: utc("resolved_at"),
    resolvedByActor: varchar("resolved_by_actor", { length: 128 }),
    resolutionNote: varchar("resolution_note", { length: 1024 }),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_issues_import_batch", columns: [t.importBatchId], foreignColumns: [importBatches.importBatchId] }),
    foreignKey({ name: "fk_issues_assignment", columns: [t.assignmentId], foreignColumns: [staffAccountAssignments.assignmentId] }),
    foreignKey({ name: "fk_issues_call", columns: [t.providerCallId], foreignColumns: [odsProviderCalls.providerCallId] }).onDelete("set null"),
    uniqueIndex("uq_issues_fingerprint").on(t.issueFingerprint),
    index("idx_issues_status_severity").on(t.status, t.severity, t.lastSeenAt),
    index("idx_issues_code").on(t.issueCode, t.lastSeenAt),
    index("idx_issues_batch").on(t.batchId),
    index("idx_issues_import_batch").on(t.importBatchId),
    index("idx_issues_account").on(t.accountId),
    index("idx_issues_content").on(t.contentId),
    index("idx_issues_assignment").on(t.assignmentId),
    index("idx_issues_call").on(t.providerCallId),
    check("ck_issues_severity", inList(t.severity, ["info", "warning", "error", "critical"])),
    check("ck_issues_status", inList(t.status, ["open", "acknowledged", "resolved", "ignored"])),
    check("ck_issues_occurrence", sql`${t.occurrenceCount} >= 1`),
    check("ck_issues_one_batch_kind", sql`${t.batchId} IS NULL OR ${t.importBatchId} IS NULL`),
  ],
);
