// 确认写入（design §7.6）：同步、有界、分块、可续跑。
//   租约：writing_token 是 fencing token，每个块的事务开头核对；心跳陈旧（>2 分钟）才允许接手。
//   续跑：只处理 outcome IS NULL 的行；行的 outcome 与它的门店写入同一事务提交，所以已 imported 的行不会被改写。
//   新建门店先 INSERT，唯一键冲突（1062）在保存点内回滚并记 conflict；不先 SELECT … FOR UPDATE 一个不存在的键（间隙锁）。
//   总耗时超过上限时在块边界停下并清空心跳，可立即续跑。
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { dataQualityIssues, importBatches, importRowResults, stores } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import type { AuditEvent, AuditSink } from "./audit";
import { assertMode, type ActorContext } from "./authorization";
import { classifyRow, toFileRow, type Classified } from "./classify";
import { closeStores, convergeOldIssues } from "./closure";
import { isDuplicateKey, MasterDataError } from "./errors";
import { HEADER } from "./file-parser";
import type { BatchSummary } from "./precheck";
import { liveRefs } from "./ref";
import { applyDealer } from "./structure";

export interface ConfirmDeps {
  db: Db;
  clock: Clock;
  audit: AuditSink;
  chunkSize?: number;
  /** 总耗时上限，默认 10 分钟（F-D12）。 */
  maxMs?: number;
  /** 心跳陈旧阈值，默认 2 分钟。 */
  staleMs?: number;
  newToken?: () => string;
  /** 仅测试：每个块提交后调用；抛错即模拟进程在块边界被杀。 */
  hooks?: {
    afterChunk?: (chunkNo: number) => void | Promise<void>;
    /** 仅测试：分类之后、写入之前（用另一个连接制造唯一键竞争）。 */
    beforeApply?: (rowNo: number) => void | Promise<void>;
  };
}

export interface ConfirmCommand {
  closureStoreIds?: readonly string[];
}

export type ConfirmedSummary = BatchSummary & { imported?: number; unchanged_written?: number; conflict?: number };

export interface ImportBatchResult {
  batchId: string;
  status: "completed";
  summary: ConfirmedSummary;
  /** 本次调用新关闭的门店（十进制字符串）。 */
  closedStores: string[];
  alreadyCompleted: boolean;
}

const SAVEPOINT = sql.raw("md_row");

export async function confirm(deps: ConfirmDeps, batchIdText: string, cmd: ConfirmCommand, actor: ActorContext): Promise<ImportBatchResult> {
  if (!/^\d+$/.test(batchIdText)) throw new MasterDataError("input", "invalid_batch_id", "批次 ID 必须是十进制数字");
  const batchId = BigInt(batchIdText);
  const chunkSize = deps.chunkSize ?? 500;
  const maxMs = deps.maxMs ?? 10 * 60_000;
  const staleMs = deps.staleMs ?? 2 * 60_000;
  const reject = (e: MasterDataError): never => {
    deps.audit({
      event_type: "import_confirmation_rejected",
      actor: actor.actor,
      occurred_at: deps.clock.now().toISOString(),
      reason_code: e.code,
      batch_id: batchIdText,
    });
    throw e;
  };

  const [batch] = await deps.db.select().from(importBatches).where(eq(importBatches.importBatchId, batchId));
  if (!batch || batch.importKind !== "master_data") throw new MasterDataError("not_found", "batch_not_found", "批次不存在");
  const summary = batch.summary as BatchSummary;
  try {
    assertMode(actor, summary.mode);
  } catch (e) {
    return reject(e as MasterDataError);
  }
  if (batch.status === "completed") return { batchId: batchIdText, status: "completed", summary: summary as ConfirmedSummary, closedStores: [], alreadyCompleted: true };
  if (batch.status !== "awaiting_confirm" && batch.status !== "writing") {
    return reject(new MasterDataError("conflict", "batch_not_confirmable", `批次状态 ${batch.status} 不能确认`));
  }

  // 勾选的门店必须全部属于本批待确认清单（含续跑时已被前一次关闭的）；否则整条命令拒绝，零写入
  const closureIds = [...new Set((cmd.closureStoreIds ?? []).map((s) => (/^\d+$/.test(s) ? BigInt(s) : -1n)))];
  if (closureIds.length > 0) {
    const listed = await deps.db
      .select({ id: dataQualityIssues.entityId })
      .from(dataQualityIssues)
      .where(and(eq(dataQualityIssues.importBatchId, batchId), eq(dataQualityIssues.issueCode, "store_missing_from_export")));
    const ok = new Set(listed.map((r) => r.id));
    const bad = closureIds.filter((i) => !ok.has(i));
    if (bad.length > 0) {
      return reject(new MasterDataError("input", "closure_store_not_pending", "勾选的门店不在本批待确认清单内", { storeIds: bad.map(String) }));
    }
  }

  // 1) 取得租约
  const token = (deps.newToken ?? randomUUID)();
  const t0 = deps.clock.now();
  const taken = await deps.db.transaction(async (tx) => {
    const [b] = await tx.select().from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
    if (!b) throw new MasterDataError("not_found", "batch_not_found", "批次不存在");
    if (b.status === "completed") return "completed" as const;
    if (b.status === "writing" && b.heartbeatAt && t0.getTime() - b.heartbeatAt.getTime() < staleMs) {
      throw new MasterDataError("conflict", "batch_in_progress", "批次正在被另一个确认写入处理");
    }
    if (b.status !== "awaiting_confirm" && b.status !== "writing") {
      throw new MasterDataError("conflict", "batch_not_confirmable", `批次状态 ${b.status} 不能确认`);
    }
    await tx.update(importBatches).set({ status: "writing", writingToken: token, heartbeatAt: t0, updatedAt: t0 }).where(eq(importBatches.importBatchId, batchId));
    return "acquired" as const;
  });
  if (taken === "completed") {
    const [b] = await deps.db.select().from(importBatches).where(eq(importBatches.importBatchId, batchId));
    return { batchId: batchIdText, status: "completed", summary: b!.summary as ConfirmedSummary, closedStores: [], alreadyCompleted: true };
  }

  // 2) 分块写入
  const started = deps.clock.now().getTime();
  for (let chunkNo = 1; ; chunkNo++) {
    if (deps.clock.now().getTime() - started > maxMs) {
      await deps.db.update(importBatches).set({ heartbeatAt: null, updatedAt: deps.clock.now() }).where(and(eq(importBatches.importBatchId, batchId), eq(importBatches.writingToken, token)));
      throw new MasterDataError("limit", "time_limit_exceeded", "确认写入超过时间上限，已在块边界停下；重新执行 confirm 即可续跑");
    }
    const events: AuditEvent[] = [];
    const n = await processChunk(deps, batchId, token, summary.mode, actor, chunkSize, events);
    for (const e of events) deps.audit(e);
    if (n === 0) break;
    await deps.hooks?.afterChunk?.(chunkNo);
  }

  // 3) 关店确认、旧 issue 收敛、汇总、完成——同一事务，租约失效则整体回滚
  const events: AuditEvent[] = [];
  const closed: string[] = [];
  const final = await deps.db.transaction(async (tx) => {
    const [b] = await tx.select().from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
    if (!b || b.writingToken !== token) throw new MasterDataError("conflict", "lease_lost", "写入租约已被其他进程接手");
    const now = deps.clock.now();
    const closeEvents = await closeStores(tx, batchId, closureIds, actor.actor, now);
    for (const e of closeEvents) {
      events.push(e);
      closed.push(e.target_id!);
    }
    await convergeOldIssues(tx, batchId, summary.brands_in_file, actor.actor, now);
    const counts = await tx
      .select({ outcome: importRowResults.outcome, n: sql<number>`COUNT(*)` })
      .from(importRowResults)
      .where(eq(importRowResults.importBatchId, batchId))
      .groupBy(importRowResults.outcome);
    const c = (k: string): number => Number(counts.find((x) => x.outcome === k)?.n ?? 0);
    const merged: ConfirmedSummary = { ...(b.summary as BatchSummary), imported: c("imported"), unchanged_written: c("unchanged"), conflict: c("conflict") };
    await tx
      .update(importBatches)
      .set({ status: "completed", summary: merged, writingToken: null, heartbeatAt: null, confirmedByActor: actor.actor, confirmedAt: now, updatedAt: now })
      .where(eq(importBatches.importBatchId, batchId));
    events.push({
      event_type: "import_confirmed",
      actor: actor.actor,
      occurred_at: now.toISOString(),
      target_type: "import_batch",
      target_id: batchIdText,
      batch_id: batchIdText,
      counts: { imported: merged.imported, unchanged_written: merged.unchanged_written, conflict: merged.conflict, closed_stores: closed.length },
    });
    return merged;
  });
  for (const e of events) deps.audit(e);
  return { batchId: batchIdText, status: "completed", summary: final, closedStores: closed, alreadyCompleted: false };
}

async function processChunk(
  deps: ConfirmDeps,
  batchId: bigint,
  token: string,
  mode: BatchSummary["mode"],
  actor: ActorContext,
  limit: number,
  events: AuditEvent[],
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const [b] = await tx.select({ token: importBatches.writingToken }).from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
    if (!b || b.token !== token) throw new MasterDataError("conflict", "lease_lost", "写入租约已被其他进程接手");
    const rows = await tx
      .select()
      .from(importRowResults)
      .where(and(eq(importRowResults.importBatchId, batchId), isNull(importRowResults.outcome), inArray(importRowResults.precheckClass, ["new", "update", "unchanged"])))
      .orderBy(asc(importRowResults.rowNo))
      .limit(limit);
    if (rows.length === 0) return 0;
    const refs = liveRefs(tx);
    const scope = mode === "structure" ? ("all" as const) : actor.brandScope;
    const now = deps.clock.now();
    for (const row of rows) {
      const raw = row.rawRow as Record<string, string>;
      const fr = toFileRow(row.rowNo, HEADER.map((h) => raw[h] ?? ""));
      const fresh = await classifyRow(fr, { mode, scope, refs });
      const rec = row.precheckClass!;
      const done = (outcome: "imported" | "unchanged" | "conflict", extra: { reason?: string; detail?: string; storeId?: bigint | null } = {}) =>
        tx
          .update(importRowResults)
          .set({
            outcome,
            ...(extra.reason ? { reasonCode: extra.reason } : {}),
            ...(extra.detail ? { reasonDetail: extra.detail.slice(0, 1024) } : {}),
            ...(extra.storeId ? { storeId: extra.storeId } : {}),
          })
          .where(eq(importRowResults.importRowResultId, row.importRowResultId));
      const stale = (why: string) => done("conflict", { reason: "precheck_stale", detail: `预检为 ${rec}，确认时为 ${why}` });

      if (fresh.cls === "error" || fresh.cls === "needs_superadmin") {
        await stale(`${fresh.cls}/${fresh.reason}`);
      } else if (rec === "unchanged") {
        if (fresh.cls === "unchanged") await done("unchanged");
        else await stale(`${fresh.cls}/${fresh.reason ?? ""}`);
      } else if (rec === "update" && fresh.cls === "unchanged") {
        await done("unchanged"); // 已收敛：别的行或别的人已经把它改到目标值
      } else if (fresh.cls !== rec) {
        await stale(`${fresh.cls}/${fresh.reason ?? ""}`);
      } else {
        await deps.hooks?.beforeApply?.(row.rowNo);
        await applyRow(tx, fresh, batchId, actor.actor, now, events, done);
      }
    }
    await tx.update(importBatches).set({ heartbeatAt: now, updatedAt: now }).where(eq(importBatches.importBatchId, batchId));
    return rows.length;
  });
}

async function applyRow(
  tx: DbTx,
  fresh: Classified,
  batchId: bigint,
  actorId: string,
  now: Date,
  events: AuditEvent[],
  done: (o: "imported" | "unchanged" | "conflict", x?: { reason?: string; detail?: string; storeId?: bigint | null }) => Promise<unknown>,
): Promise<void> {
  const plan = fresh.plan!;
  const rowEvents: AuditEvent[] = [];
  await tx.execute(sql`SAVEPOINT ${SAVEPOINT}`);
  try {
    let dealerId = plan.dealer.id;
    if (plan.dealer.create || plan.dealer.activate || plan.dealer.rename) {
      const d = await applyDealer(tx, plan.dealer, actorId, batchId, now);
      if (!d.ok) {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await done("conflict", { reason: d.reason, detail: `门店所属商家渠道编码=${plan.dealer.code}` });
        return;
      }
      dealerId = d.dealerId;
      rowEvents.push(...d.events);
    }
    let storeId = plan.store.storeId ?? null;
    if (plan.store.kind === "insert") {
      const [r] = await tx.insert(stores).values({
        storeCode: plan.storeCode,
        storeName: plan.storeName,
        dealerId: dealerId!,
        brandId: plan.brandId,
        sectorId: plan.sectorId,
        storeTier: plan.storeTier,
        status: "active",
        sourceBatchId: batchId,
        createdAt: now,
        updatedAt: now,
      });
      storeId = BigInt(r.insertId);
    } else if (plan.store.kind === "update") {
      await tx
        .update(stores)
        .set({
          storeName: plan.storeName,
          storeTier: plan.storeTier,
          sourceBatchId: batchId,
          updatedAt: now,
          ...(plan.store.reactivate ? { status: "active" } : {}),
          ...(plan.store.relationChange ? { dealerId: dealerId!, sectorId: plan.sectorId } : {}),
        })
        .where(eq(stores.storeId, plan.store.storeId!));
      const base = { actor: actorId, occurred_at: now.toISOString(), target_type: "store", target_id: String(storeId), target_code: plan.storeCode, batch_id: String(batchId) };
      if (plan.store.reactivate) rowEvents.push({ event_type: "store_reactivated", ...base, before: { status: "closed" }, after: { status: "active" } });
      if (plan.store.relationChange) rowEvents.push({ event_type: "structure_changed", reason_code: "change_store_relation", ...base });
    }
    await tx.execute(sql`RELEASE SAVEPOINT ${SAVEPOINT}`);
    await done("imported", { storeId });
    events.push(...rowEvents);
  } catch (e) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    if (!isDuplicateKey(e)) throw e;
    await done("conflict", { reason: "store_unique_conflict", detail: `门店编码=${plan.storeCode}` });
  }
}
