// v2 §9.8 / §9.9 导入批次与行结果。主数据导入（a-master-data-import）与名单导入（a-activity-plan）共用。
// 2026-11-05 修订 R1–R3：只增列、放宽约束，不删除名单导入在用的列。业务主档与批次不使用 ON DELETE CASCADE。
import { sql } from "drizzle-orm";
import { check, foreignKey, index, int, json, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { id, inList, sha256, utc } from "../columns";

export const IMPORT_KINDS = ["master_data", "roster"] as const;
export const IMPORT_STATUSES = ["prechecking", "precheck_failed", "awaiting_confirm", "writing", "completed", "failed"] as const;
export const PRECHECK_CLASSES = ["new", "update", "unchanged", "error", "needs_superadmin"] as const;
export const ROW_OUTCOMES = ["imported", "unchanged", "conflict", "invalid"] as const;

export const importBatches = mysqlTable(
  "import_batches",
  {
    importBatchId: id("import_batch_id").primaryKey().autoincrement(),
    importKind: varchar("import_kind", { length: 16 }).notNull(),
    // roster 时必填，逻辑引用 A 域活动计划；master_data 为空
    planId: id("plan_id"),
    uploadedByActor: varchar("uploaded_by_actor", { length: 128 }).notNull(),
    // B 域接入后回填；不得造假用户 ID
    uploadedByUserId: id("uploaded_by_user_id"),
    uploadedAt: utc("uploaded_at").notNull(),
    fileName: varchar("file_name", { length: 512 }),
    fileSha256: sha256("file_sha256"),
    templateVersion: varchar("template_version", { length: 32 }),
    // 本次可写入的品牌集合："all" 或品牌编码数组
    brandScope: json("brand_scope"),
    totalRows: int("total_rows").notNull(),
    // 以下四列属于名单导入；主数据导入保持 0，汇总在 summary
    newRows: int("new_rows").notNull().default(0),
    skippedRows: int("skipped_rows").notNull().default(0),
    errorRows: int("error_rows").notNull().default(0),
    conflictRows: int("conflict_rows").notNull().default(0),
    summary: json("summary"),
    status: varchar("status", { length: 16 }).notNull(),
    // 确认写入的租约与 fencing：每个块的事务开头核对 token
    writingToken: varchar("writing_token", { length: 36 }),
    heartbeatAt: utc("heartbeat_at"),
    confirmedByActor: varchar("confirmed_by_actor", { length: 128 }),
    confirmedByUserId: id("confirmed_by_user_id"),
    confirmedAt: utc("confirmed_at"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    index("idx_import_batches_kind").on(t.importKind, t.uploadedAt),
    index("idx_import_batches_plan").on(t.planId, t.uploadedAt),
    check("ck_import_batches_kind", inList(t.importKind, IMPORT_KINDS)),
    check("ck_import_batches_status", inList(t.status, IMPORT_STATUSES)),
    check("ck_import_batches_rows", sql`${t.totalRows} >= 0`),
  ],
);

export const importRowResults = mysqlTable(
  "import_row_results",
  {
    importRowResultId: id("import_row_result_id").primaryKey().autoincrement(),
    importBatchId: id("import_batch_id").notNull(),
    // 文件内行号，从 1 开始，不含表头
    rowNo: int("row_no").notNull(),
    // 原始单元格按列名的快照，不做规范化
    rawRow: json("raw_row").notNull(),
    precheckClass: varchar("precheck_class", { length: 32 }),
    outcome: varchar("outcome", { length: 32 }),
    reasonCode: varchar("reason_code", { length: 64 }),
    reasonDetail: varchar("reason_detail", { length: 1024 }),
    storeId: id("store_id"),
    accountId: id("account_id"),
    staffId: id("staff_id"),
    resolvedAt: utc("resolved_at"),
    resolvedByActor: varchar("resolved_by_actor", { length: 128 }),
    resolvedByUserId: id("resolved_by_user_id"),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_import_rows_batch", columns: [t.importBatchId], foreignColumns: [importBatches.importBatchId] }),
    uniqueIndex("uq_import_rows_batch_row").on(t.importBatchId, t.rowNo),
    index("idx_import_rows_precheck").on(t.precheckClass, t.createdAt),
    index("idx_import_rows_outcome").on(t.outcome, t.createdAt),
    index("idx_import_rows_store").on(t.storeId),
    index("idx_import_rows_account").on(t.accountId),
    check("ck_import_rows_precheck", sql`${t.precheckClass} IS NULL OR ${inList(t.precheckClass, PRECHECK_CLASSES)}`),
    check("ck_import_rows_outcome", sql`${t.outcome} IS NULL OR ${inList(t.outcome, ROW_OUTCOMES)}`),
    check("ck_import_rows_row_no", sql`${t.rowNo} >= 1`),
  ],
);
