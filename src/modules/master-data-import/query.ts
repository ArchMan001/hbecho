// 批次与行结果查询、回流文件（design §4.4）。只读，不触发业务写入；BIGINT 一律十进制字符串；范围外批次不可见。
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { dataQualityIssues, importBatches, importRowResults } from "../../db/schema";
import { assertImport, type ActorContext } from "./authorization";
import { MasterDataError } from "./errors";
import { buildReturnFile, isReturned } from "./return-file";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function visible(actor: ActorContext, scope: unknown): boolean {
  if (actor.brandScope === "all") return true;
  return Array.isArray(scope) && scope.every((b) => typeof b === "string" && (actor.brandScope as ReadonlySet<string>).has(b));
}

type BatchRow = typeof importBatches.$inferSelect;
const view = (b: BatchRow) => ({
  batchId: String(b.importBatchId),
  fileName: b.fileName,
  status: b.status,
  uploadedByActor: b.uploadedByActor,
  uploadedAt: iso(b.uploadedAt),
  confirmedByActor: b.confirmedByActor,
  confirmedAt: iso(b.confirmedAt),
  totalRows: b.totalRows,
  summary: b.summary,
});

async function loadVisible(db: Db, actor: ActorContext, batchId: string): Promise<BatchRow> {
  assertImport(actor);
  if (!/^\d+$/.test(batchId)) throw new MasterDataError("input", "invalid_batch_id", "批次 ID 必须是十进制数字");
  const [b] = await db.select().from(importBatches).where(and(eq(importBatches.importBatchId, BigInt(batchId)), eq(importBatches.importKind, "master_data")));
  // 范围外的批次与不存在的批次表现一致，不泄露存在性
  if (!b || !visible(actor, b.brandScope)) throw new MasterDataError("not_found", "batch_not_found", "批次不存在");
  return b;
}

export interface Page {
  offset?: number;
  limit?: number;
  /** 只看某一预检分类（new / update / unchanged / error / needs_superadmin）。 */
  precheckClass?: string;
}
const clampLimit = (n: number | undefined, dflt: number): number => Math.min(Math.max(n ?? dflt, 1), 1000);

export function createQuery(db: Db) {
  return {
    async list(page: Page, actor: ActorContext) {
      assertImport(actor);
      const all = await db
        .select()
        .from(importBatches)
        .where(eq(importBatches.importKind, "master_data"))
        .orderBy(desc(importBatches.importBatchId))
        .limit(clampLimit(page.limit, 50))
        .offset(Math.max(page.offset ?? 0, 0));
      return all.filter((b) => visible(actor, b.brandScope)).map(view);
    },

    async get(batchId: string, actor: ActorContext) {
      const b = await loadVisible(db, actor, batchId);
      const issues = await db
        .select()
        .from(dataQualityIssues)
        .where(and(eq(dataQualityIssues.importBatchId, b.importBatchId), eq(dataQualityIssues.issueCode, "store_missing_from_export")))
        .orderBy(asc(dataQualityIssues.entityId));
      const [r] = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(importRowResults)
        .where(
          and(
            eq(importRowResults.importBatchId, b.importBatchId),
            sql`(${importRowResults.precheckClass} IN ('error','needs_superadmin') OR ${importRowResults.outcome} = 'conflict')`,
          ),
        );
      return {
        ...view(b),
        pendingClosures: issues.map((i) => ({ storeId: String(i.entityId), status: i.status, resolutionNote: i.resolutionNote, detail: i.detail })),
        returnFile: { available: Number(r?.n ?? 0) > 0, rows: Number(r?.n ?? 0) },
      };
    },

    async rows(batchId: string, page: Page, actor: ActorContext) {
      const b = await loadVisible(db, actor, batchId);
      const rows = await db
        .select()
        .from(importRowResults)
        .where(page.precheckClass ? and(eq(importRowResults.importBatchId, b.importBatchId), eq(importRowResults.precheckClass, page.precheckClass)) : eq(importRowResults.importBatchId, b.importBatchId))
        .orderBy(asc(importRowResults.rowNo))
        .limit(clampLimit(page.limit, 100))
        .offset(Math.max(page.offset ?? 0, 0));
      return rows.map((r) => ({
        rowNo: r.rowNo,
        precheckClass: r.precheckClass,
        outcome: r.outcome,
        reasonCode: r.reasonCode,
        reasonDetail: r.reasonDetail,
        storeId: r.storeId === null ? null : String(r.storeId),
        rawRow: r.rawRow,
      }));
    },

    /** 回流 CSV 正文（带 BOM）与行数。 */
    async returnFile(batchId: string, actor: ActorContext): Promise<{ content: string; rows: number }> {
      const b = await loadVisible(db, actor, batchId);
      const rows = await db.select().from(importRowResults).where(eq(importRowResults.importBatchId, b.importBatchId)).orderBy(asc(importRowResults.rowNo));
      const mapped = rows.map((r) => ({
        raw: r.rawRow as Record<string, string>,
        precheckClass: r.precheckClass,
        outcome: r.outcome,
        reasonCode: r.reasonCode,
        reasonDetail: r.reasonDetail,
      }));
      return { content: buildReturnFile(mapped), rows: mapped.filter(isReturned).length };
    },
  };
}

export type ImportBatchQuery = ReturnType<typeof createQuery>;
