// 待确认撤店（design §7.5）：预检只识别并写 issue，确认才关店；确认完成时收敛旧批次遗留的 open issue。
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { dataQualityIssues, stores } from "../../db/schema";
import type { AuditEvent } from "./audit";
import { type BrandScope, type FileRow, type ImportMode, type StoreRef } from "./classify";
import { mapMainBusiness } from "./mappings.v1";
import type { Snapshot } from "./ref";

export const ISSUE_CODE = "store_missing_from_export";
/** ponytail: 20% 是没有历史数据支撑的阈值；有了几期真实导出再校准。只是提示，不阻止确认。 */
export const SUSPECT_RATIO = 0.2;

export interface PendingResult {
  pending: StoreRef[];
  /** 文件中出现的品牌 ∩ 操作者范围（structure 模式不受范围限制）。 */
  brandsInFile: bigint[];
  activeInScope: number;
  suspectIncompleteExport: boolean;
  /** rowNo → 命中的既有门店（无论该行分类为何）。 */
  matched: Map<number, bigint>;
}

export function computePending(rows: readonly FileRow[], snap: Snapshot, mode: ImportMode, scope: BrandScope): PendingResult {
  const byKey = new Map(snap.allStores.map((s) => [`${s.brandId}|${s.code}`, s]));
  const present = new Set<string>();
  const unresolved = new Set<string>();
  const brandsInFile = new Set<bigint>();
  const matched = new Map<number, bigint>();
  for (const r of rows) {
    if (r.storeCode === "") continue;
    const m = mapMainBusiness(r.mainCode);
    const brandId = m ? snap.brandIdByCode.get(m.brand) : undefined;
    if (!m || brandId === undefined) {
      // 品牌无法解析的行既不能证明门店存在，也不能证明它消失：按门店编码排除，避免误报
      unresolved.add(r.storeCode);
      continue;
    }
    if (mode === "structure" || scope === "all" || scope.has(m.brand)) brandsInFile.add(brandId);
    present.add(`${brandId}|${r.storeCode}`);
    const s = byKey.get(`${brandId}|${r.storeCode}`);
    if (s) matched.set(r.rowNo, s.id);
  }
  const active = snap.allStores.filter((s) => s.status === "active" && brandsInFile.has(s.brandId));
  const pending = active.filter((s) => !present.has(`${s.brandId}|${s.code}`) && !unresolved.has(s.code));
  return {
    pending,
    brandsInFile: [...brandsInFile],
    activeInScope: active.length,
    suspectIncompleteExport: active.length > 0 && pending.length / active.length > SUSPECT_RATIO,
    matched,
  };
}

export const fingerprint = (batchId: bigint, storeId: bigint): Buffer =>
  createHash("sha256").update(`${ISSUE_CODE}:${batchId}:${storeId}`, "utf8").digest();

/** 同一批次同一门店只一条（指纹唯一）；重复写入是空操作。 */
export async function writePendingIssues(db: Db, batchId: bigint, pending: readonly StoreRef[], snap: Snapshot, now: Date): Promise<void> {
  const brandCodeById = new Map([...snap.brandIdByCode].map(([c, i]) => [i, c]));
  for (let i = 0; i < pending.length; i += 500) {
    const chunk = pending.slice(i, i + 500);
    await db
      .insert(dataQualityIssues)
      .values(
        chunk.map((s) => ({
          issueFingerprint: fingerprint(batchId, s.id),
          issueCode: ISSUE_CODE,
          severity: "warning",
          status: "open",
          entityType: "store",
          entityId: s.id,
          importBatchId: batchId,
          detail: {
            store_code: s.code,
            store_name: s.name,
            brand_code: brandCodeById.get(s.brandId) ?? null,
            dealer_code: snap.dealerCodeById.get(s.dealerId) ?? null,
            sector_code: snap.sectorCodeById.get(s.sectorId) ?? null,
            last_seen_batch_id: s.sourceBatchId === null ? null : String(s.sourceBatchId),
          },
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onDuplicateKeyUpdate({ set: { lastSeenAt: now, updatedAt: now } });
  }
}

/** 本批待确认的门店 ID（open 的 issue）。 */
export async function pendingStoreIds(db: Db | DbTx, batchId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ id: dataQualityIssues.entityId })
    .from(dataQualityIssues)
    .where(and(eq(dataQualityIssues.importBatchId, batchId), eq(dataQualityIssues.issueCode, ISSUE_CODE), eq(dataQualityIssues.status, "open")));
  return rows.map((r) => r.id!).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 确认关店：逐店锁行；已 closed 的重复调用是空操作（续跑安全）。返回新关闭的门店用于审计。 */
export async function closeStores(tx: DbTx, batchId: bigint, storeIds: readonly bigint[], actor: string, now: Date): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for (const id of storeIds) {
    const [s] = await tx.select({ status: stores.status }).from(stores).where(eq(stores.storeId, id)).for("update");
    if (!s) continue;
    if (s.status === "active") {
      await tx.update(stores).set({ status: "closed", updatedAt: now }).where(eq(stores.storeId, id));
      events.push({
        event_type: "store_closed",
        actor,
        occurred_at: now.toISOString(),
        target_type: "store",
        target_id: String(id),
        batch_id: String(batchId),
        before: { status: "active" },
        after: { status: "closed" },
      });
    }
    // 本批 issue 解决；同一门店在其他批次遗留的 open issue 一并解决
    await tx
      .update(dataQualityIssues)
      .set({
        status: "resolved",
        resolvedAt: now,
        resolvedByActor: actor,
        resolutionNote: sql`IF(${dataQualityIssues.importBatchId} = ${batchId}, 'confirmed_by_import', 'closed_by_other_batch')`,
        updatedAt: now,
      })
      .where(and(eq(dataQualityIssues.entityId, id), eq(dataQualityIssues.issueCode, ISSUE_CODE), eq(dataQualityIssues.status, "open")));
  }
  return events;
}

/** 确认完成时收敛旧批次遗留的 open issue（限定在本批文件出现的品牌内）：
 *  门店已 closed → resolved；门店在本批重新出现 → resolved；其余 → ignored（由本批自己的待确认项接续）。 */
export async function convergeOldIssues(tx: DbTx, batchId: bigint, brandIds: readonly string[], actor: string, now: Date): Promise<void> {
  if (brandIds.length === 0) return;
  const brands = sql.join(brandIds.map((b) => sql`${b}`), sql`, `);
  const base = sql`i.issue_code = ${ISSUE_CODE} AND i.status = 'open' AND i.import_batch_id <> ${String(batchId)} AND s.brand_id IN (${brands})`;
  const set = (status: string, note: string, extra: ReturnType<typeof sql>) =>
    tx.execute(sql`
      UPDATE data_quality_issues i JOIN stores s ON s.store_id = i.entity_id
      SET i.status = ${status}, i.resolved_at = ${now}, i.resolved_by_actor = ${actor}, i.resolution_note = ${note}, i.updated_at = ${now}
      WHERE ${base} ${extra}`);
  await set("resolved", "closed_by_other_batch", sql`AND s.status = 'closed'`);
  await set(
    "resolved",
    "store_reappeared",
    sql`AND EXISTS (SELECT 1 FROM import_row_results r WHERE r.import_batch_id = ${String(batchId)} AND r.store_id = i.entity_id)`,
  );
  await set("ignored", `superseded_by_batch:${batchId}`, sql``);
}

