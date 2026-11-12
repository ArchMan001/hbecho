// c-signals design §6.1：C 域九张新表，不入 v2。内部 ID 为 signed BIGINT；时间 UTC DATETIME(6)；状态 VARCHAR + CHECK；
// 哈希 BINARY(32)；业务表无 ON DELETE CASCADE。唯一一处 SET NULL：任务 → 结果行（结果行按保留期清理，任务行可能活得更久）。
// 存储态只有 valid / failed（SG-2）：missing / stale / not_applicable 是读取时由「没有行」「版本落后」「输入不存在」推出来的。
import { sql, type SQL } from "drizzle-orm";
import { check, decimal, foreignKey, index, int, json, longtext, mysqlTable, primaryKey, uniqueIndex, varchar, type AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { asciiBin, id, inList, sha256, utc } from "../columns";
import { comments, contents, contentSnapshots } from "./content";

export const SIGNAL_STORED_STATES = ["valid", "failed"] as const;
export const SIGNAL_TASK_KINDS = ["score_template", "score_element", "asr_text", "asr_judgement", "recompute_chunk"] as const;
export const SIGNAL_TASK_STATUSES = ["pending", "running", "retry_wait", "succeeded", "dead"] as const;
export const SEGMENT_STATUSES = ["draft", "published"] as const;
export const SEGMENT_PLATFORMS = ["douyin", "xiaohongshu", "kuaishou"] as const;
export const SEGMENT_IMAGE_KINDS = ["template", "element"] as const;
export const SEGMENT_IMAGE_TARGETS = ["cover", "background", "avatar"] as const;
export const HISTORY_SUBJECT_KINDS = ["content", "comment"] as const;
export const HISTORY_SUPERSEDED_REASONS = ["material_changed", "capability_upgraded"] as const;
export const RECOMPUTE_RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;

/** 信封里某个信号的 state：`$."<signal_key>".state`；条目缺失时为 NULL。 */
const envelopeState = (col: AnyMySqlColumn, signalKey: string): SQL =>
  sql`JSON_UNQUOTE(JSON_EXTRACT(${col}, ${sql.raw(`'$."${signalKey}".state'`)}))`;

/** 值列与信封一致：列非空 ⇔ 信封状态为 valid。用空安全比较 `<=>`，使「信封缺条目」得到确定的真 / 假而不是 NULL（CHECK 遇到 NULL 会放行）。 */
const valueMatchesEnvelope = (value: AnyMySqlColumn, envelope: AnyMySqlColumn, signalKey: string): SQL =>
  sql`(${value} IS NOT NULL) = (${envelopeState(envelope, signalKey)} <=> 'valid')`;

/** 信封里存在的条目状态只能是 valid / failed。 */
const envelopeStateInEnum = (envelope: AnyMySqlColumn, signalKey: string): SQL =>
  sql`COALESCE(${envelopeState(envelope, signalKey)}, 'valid') IN ('valid','failed')`;

/** 特征行：内容的 0 档信号当前值（一个内容一行）。值在可下推的列里，每个信号的状态 / 版本 / 时间在 signals 信封里。 */
export const contentFeatures = mysqlTable(
  "content_features",
  {
    contentId: id("content_id")
      .primaryKey()
      .references((): AnyMySqlColumn => contents.contentId),
    // 本行所基于的 current 快照；复合外键保证它属于同一个内容
    contentSnapshotId: id("content_snapshot_id").notNull(),
    textMaterialSha256: sha256("text_material_sha256").notNull(),
    titleNormalized: longtext("title_normalized"),
    bodyNormalized: longtext("body_normalized"),
    hashtags: json("hashtags"),
    signals: json("signals").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_content_features_snapshot",
      columns: [t.contentId, t.contentSnapshotId],
      foreignColumns: [contentSnapshots.contentId, contentSnapshots.contentSnapshotId],
    }),
    index("idx_content_features_snapshot").on(t.contentSnapshotId),
    check("ck_content_features_signals", sql`JSON_TYPE(${t.signals}) = 'OBJECT'`),
    check("ck_content_features_hashtags", sql`${t.hashtags} IS NULL OR JSON_TYPE(${t.hashtags}) = 'ARRAY'`),
    check("ck_content_features_title", valueMatchesEnvelope(t.titleNormalized, t.signals, "text.title_normalized")),
    check("ck_content_features_body", valueMatchesEnvelope(t.bodyNormalized, t.signals, "text.body_normalized")),
    check("ck_content_features_tags", valueMatchesEnvelope(t.hashtags, t.signals, "text.hashtags")),
    check(
      "ck_content_features_states",
      sql`${envelopeStateInEnum(t.signals, "text.title_normalized")} AND ${envelopeStateInEnum(t.signals, "text.body_normalized")} AND ${envelopeStateInEnum(t.signals, "text.hashtags")}`,
    ),
  ],
);

/** 评论特征行：评论是最新态，没有快照版本。 */
export const commentFeatures = mysqlTable(
  "comment_features",
  {
    commentId: id("comment_id")
      .primaryKey()
      .references((): AnyMySqlColumn => comments.commentId),
    textMaterialSha256: sha256("text_material_sha256").notNull(),
    textNormalized: longtext("text_normalized"),
    signals: json("signals").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    check("ck_comment_features_signals", sql`JSON_TYPE(${t.signals}) = 'OBJECT'`),
    check("ck_comment_features_text", valueMatchesEnvelope(t.textNormalized, t.signals, "comment.text_normalized")),
    check("ck_comment_features_states", envelopeStateInEnum(t.signals, "comment.text_normalized")),
  ],
);

/** 被取代的旧值。subject_id 是多态引用，不设外键（A 的主档不物理删除）。 */
export const signalHistory = mysqlTable(
  "signal_history",
  {
    historyId: id("history_id").primaryKey().autoincrement(),
    subjectKind: varchar("subject_kind", { length: 16 }).notNull(),
    subjectId: id("subject_id").notNull(),
    // 产出该值时所基于的内容快照；评论为空
    subjectSnapshotId: id("subject_snapshot_id"),
    signalKey: varchar("signal_key", { length: 64 }).notNull(),
    state: varchar("state", { length: 16 }).notNull(),
    value: json("value"),
    capabilityId: varchar("capability_id", { length: 64 }).notNull(),
    capabilityVersion: int("capability_version").notNull(),
    // 文本类信号写入时所用的 text.normalize 版本；非文本为空
    normalizerVersion: int("normalizer_version"),
    producedAt: utc("produced_at").notNull(),
    supersededAt: utc("superseded_at").notNull(),
    supersededReason: varchar("superseded_reason", { length: 32 }).notNull(),
    expiresAt: utc("expires_at").notNull(),
  },
  (t) => [
    index("idx_signal_history_subject").on(t.subjectKind, t.subjectId, t.signalKey, t.supersededAt),
    index("idx_signal_history_expires").on(t.expiresAt),
    check("ck_signal_history_kind", inList(t.subjectKind, HISTORY_SUBJECT_KINDS)),
    check("ck_signal_history_state", inList(t.state, SIGNAL_STORED_STATES)),
    check("ck_signal_history_reason", inList(t.supersededReason, HISTORY_SUPERSEDED_REASONS)),
    check("ck_signal_history_version", sql`${t.capabilityVersion} > 0`),
  ],
);

/** 派生信号的不可变结果行；复用键 = 信号键 + 能力标识 + 素材指纹 + 参数指纹 + 能力版本。 */
export const signalResults = mysqlTable(
  "signal_results",
  {
    resultId: id("result_id").primaryKey().autoincrement(),
    signalKey: varchar("signal_key", { length: 64 }).notNull(),
    // 图片 / 音频字节的 SHA-256
    materialSha256: sha256("material_sha256").notNull(),
    // 全局信号为 32 个零字节
    paramSha256: sha256("param_sha256").notNull(),
    capabilityId: varchar("capability_id", { length: 64 }).notNull(),
    capabilityVersion: int("capability_version").notNull(),
    state: varchar("state", { length: 16 }).notNull(),
    // 0.00–10.00 的匹配分
    score: decimal("score", { precision: 4, scale: 2 }),
    // ASR：{text, language}；判定：{verdict, reason}
    value: json("value"),
    evidence: json("evidence").notNull(),
    failureCode: varchar("failure_code", { length: 64 }),
    // 监控判定计划 ID / 版本只作血缘，不进复用键
    lineage: json("lineage"),
    producedAt: utc("produced_at").notNull(),
    expiresAt: utc("expires_at").notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_signal_results_key").on(t.signalKey, t.capabilityId, t.materialSha256, t.paramSha256, t.capabilityVersion),
    index("idx_signal_results_expires").on(t.expiresAt),
    check("ck_signal_results_state", inList(t.state, SIGNAL_STORED_STATES)),
    check("ck_signal_results_version", sql`${t.capabilityVersion} > 0`),
    check("ck_signal_results_score", sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 10)`),
    check(
      "ck_signal_results_shape",
      sql`(${t.state} = 'valid' AND ${t.failureCode} IS NULL AND ((${t.score} IS NOT NULL) <> (${t.value} IS NOT NULL)))
        OR (${t.state} = 'failed' AND ${t.failureCode} IS NOT NULL AND ${t.score} IS NULL AND ${t.value} IS NULL)`,
    ),
  ],
);

/** 监控段：由 D 驱动、C 执行。plan_id 是 D 分配的不透明 ID，故意没有外键。 */
export const monitoringSegments = mysqlTable(
  "monitoring_segments",
  {
    planId: id("plan_id").notNull(),
    version: int("version").notNull(),
    platformCode: varchar("platform_code", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    items: json("items").notNull(),
    createdByActor: varchar("created_by_actor", { length: 128 }).notNull(),
    publishedAt: utc("published_at"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_monitoring_segments", columns: [t.planId, t.version] }),
    check("ck_segments_status", inList(t.status, SEGMENT_STATUSES)),
    check("ck_segments_platform", inList(t.platformCode, SEGMENT_PLATFORMS)),
    check("ck_segments_published", sql`(${t.status} = 'published') = (${t.publishedAt} IS NOT NULL)`),
    check("ck_segments_items", sql`JSON_TYPE(${t.items}) = 'ARRAY'`),
    check("ck_segments_version", sql`${t.version} > 0`),
  ],
);

/** 标准图 / 元素图。每行独占自己的 OSS 对象；对象键含「计划 ID + 版本 + 图像对象 + 图片 SHA-256」。 */
export const segmentImages = mysqlTable(
  "segment_images",
  {
    imageId: id("image_id").primaryKey().autoincrement(),
    planId: id("plan_id").notNull(),
    version: int("version").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    target: varchar("target", { length: 16 }).notNull(),
    // 模板图为空串，元素图为业务标识（写入端 zod 限制字符集）
    elementKey: varchar("element_key", { length: 64 }).notNull().default(""),
    // 原始字节指纹，即参数指纹
    sha256: sha256("sha256").notNull(),
    byteLength: id("byte_length").notNull(),
    width: int("width").notNull(),
    height: int("height").notNull(),
    mime: varchar("mime", { length: 64 }).notNull(),
    bucket: varchar("bucket", { length: 128 }).notNull(),
    objectKey: asciiBin("object_key", { length: 512 }).notNull(),
    createdByActor: varchar("created_by_actor", { length: 128 }).notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_segment_images_segment",
      columns: [t.planId, t.version],
      foreignColumns: [monitoringSegments.planId, monitoringSegments.version],
    }),
    // 同一计划版本、同一对象至多一张模板图（C-D01）；元素图按 element_key 可有多张
    uniqueIndex("uq_segment_images_slot").on(t.planId, t.version, t.kind, t.target, t.elementKey),
    index("idx_segment_images_sha").on(t.sha256),
    check("ck_segment_images_kind", inList(t.kind, SEGMENT_IMAGE_KINDS)),
    check("ck_segment_images_target", inList(t.target, SEGMENT_IMAGE_TARGETS)),
    check("ck_segment_images_element", sql`(${t.kind} = 'template') = (${t.elementKey} = '')`),
    check("ck_segment_images_size", sql`${t.byteLength} > 0 AND ${t.width} > 0 AND ${t.height} > 0`),
  ],
);

/** 重算记录（SG-11）。同范围同一时刻至多一个未完成的 run：active_key 在 running / failed 时有值，其余置空（唯一键允许多个 NULL）。 */
export const signalRecomputeRuns = mysqlTable(
  "signal_recompute_runs",
  {
    runId: id("run_id").primaryKey().autoincrement(),
    requestedByActor: varchar("requested_by_actor", { length: 128 }).notNull(),
    signalKey: varchar("signal_key", { length: 64 }).notNull(),
    scope: json("scope").notNull(),
    scopeSha256: sha256("scope_sha256").notNull(),
    // apply 时对范围展开得到的对象条数
    scopeCount: int("scope_count").notNull(),
    // 范围内对象所持该信号的最低能力版本；范围内全无旧值时为空
    fromVersion: int("from_version"),
    toVersion: int("to_version").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    activeKey: sha256("active_key"),
    cursorId: id("cursor_id").notNull().default(sql`0`),
    processedCount: int("processed_count").notNull().default(0),
    startedAt: utc("started_at").notNull(),
    finishedAt: utc("finished_at"),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_recompute_active").on(t.activeKey),
    index("idx_recompute_signal").on(t.signalKey, t.toVersion, t.scopeSha256),
    check("ck_recompute_status", inList(t.status, RECOMPUTE_RUN_STATUSES)),
    check("ck_recompute_versions", sql`${t.toVersion} > 0 AND (${t.fromVersion} IS NULL OR (${t.fromVersion} > 0 AND ${t.fromVersion} <= ${t.toVersion}))`),
    check("ck_recompute_counts", sql`${t.scopeCount} >= 0 AND ${t.processedCount} >= 0 AND ${t.cursorId} >= 0`),
    check("ck_recompute_active", sql`(${t.status} IN ('running','failed')) = (${t.activeKey} IS NOT NULL)`),
    check("ck_recompute_finished", sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`),
  ],
);

/** C 自己的任务表（SG-D06）：不复用 sync_tasks（它的 batch_id / provider_id / platform_id 为 NOT NULL）。 */
export const signalTasks = mysqlTable(
  "signal_tasks",
  {
    taskId: id("task_id").primaryKey().autoincrement(),
    kind: varchar("kind", { length: 32 }).notNull(),
    idempotencyKey: sha256("idempotency_key").notNull(),
    params: json("params").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    priority: int("priority").notNull().default(0),
    attemptCount: int("attempt_count").notNull().default(0),
    maxAttempts: int("max_attempts").notNull(),
    deferCount: int("defer_count").notNull().default(0),
    nextAttemptAt: utc("next_attempt_at"),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseExpiresAt: utc("lease_expires_at"),
    fencingToken: id("fencing_token").notNull().default(sql`0`),
    runId: id("run_id"),
    resultId: id("result_id"),
    lastErrorCode: varchar("last_error_code", { length: 128 }),
    // 写入前脱敏：URL 一律替换为 <url>
    lastErrorDetail: json("last_error_detail"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    finishedAt: utc("finished_at"),
    expiresAt: utc("expires_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_signal_tasks_run", columns: [t.runId], foreignColumns: [signalRecomputeRuns.runId] }),
    foreignKey({ name: "fk_signal_tasks_result", columns: [t.resultId], foreignColumns: [signalResults.resultId] }).onDelete("set null"),
    uniqueIndex("uq_signal_tasks_idempotency").on(t.idempotencyKey),
    index("idx_signal_tasks_claim").on(t.status, t.nextAttemptAt, t.priority, t.taskId),
    index("idx_signal_tasks_run").on(t.runId),
    index("idx_signal_tasks_expires").on(t.expiresAt),
    check("ck_signal_tasks_kind", inList(t.kind, SIGNAL_TASK_KINDS)),
    check("ck_signal_tasks_status", inList(t.status, SIGNAL_TASK_STATUSES)),
    check("ck_signal_tasks_lease", sql`${t.status} <> 'running' OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`),
    check("ck_signal_tasks_attempts", sql`${t.attemptCount} >= 0 AND ${t.attemptCount} <= ${t.maxAttempts} AND ${t.deferCount} >= 0 AND ${t.fencingToken} >= 0`),
  ],
);

/** 扫描游标：content_scan / comment_scan / content_reconcile。 */
export const signalCursors = mysqlTable("signal_cursors", {
  cursorName: varchar("cursor_name", { length: 64 }).primaryKey(),
  watermarkAt: utc("watermark_at").notNull(),
  watermarkId: id("watermark_id").notNull(),
  updatedAt: utc("updated_at").notNull(),
});
