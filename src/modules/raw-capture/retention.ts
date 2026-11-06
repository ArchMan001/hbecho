// 一年期保留的清理（v2 §12.7）与 ODS orphan sweeper。
//
// 顺序：远端原始字节 → payload 行 → call 行 → task 行 → ODS 对象元数据行。长期业务表对来源 call / task 的引用
// 由 ON DELETE SET NULL 置空；快照、归属、发现、检查点、质量问题、正式媒资（category=media）一概不动，也绝不进入这个流程。
// 每一步都幂等：远端删除失败时对象保持 deleting、数据库行不删，故障恢复后重跑即可完成。
import { and, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { odsPayloads, odsProviderCalls, ossObjects, syncTasks } from "../../db/schema";
import { ODS_PREFIX } from "./keys";
import type { Clock, ObjectStore } from "./ports";

export interface CleanupEvent {
  phase: "payloads" | "calls" | "tasks" | "objects";
  /** 本阶段处理的行数（只含计数，不含载荷内容）。 */
  count: number;
  at: string;
}

export interface CleanupReport {
  payloadsDeleted: number;
  callsDeleted: number;
  tasksDeleted: number;
  objectsDeleted: number;
  /** 远端删除失败、留待下次重试的对象数。 */
  objectsPendingRetry: number;
  /** 已到期但状态非终态、因此没有删除的任务数。 */
  skippedNonTerminalTasks: number;
  /** 已到期，但被未到期调用（reconcile 引用）引用而保留的调用数。 */
  blockedByReference: number;
}

const TERMINAL = ["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"];

export async function cleanupExpired(deps: {
  db: Db;
  store: ObjectStore;
  clock: Clock;
  batchLimit?: number;
  /** 本次运行最多清理多少个 payload / 任务（定时清理有界，剩余留给下一次；缺省不限）。 */
  maxPerRun?: number;
  onEvent?: (e: CleanupEvent) => void;
}): Promise<CleanupReport> {
  const { db, store, clock } = deps;
  const limit = deps.batchLimit ?? 500;
  const now = clock.now();
  const report: CleanupReport = {
    payloadsDeleted: 0,
    callsDeleted: 0,
    tasksDeleted: 0,
    objectsDeleted: 0,
    objectsPendingRetry: 0,
    skippedNonTerminalTasks: 0,
    blockedByReference: 0,
  };
  const skip = new Set<bigint>(); // 本次运行内不再尝试的调用（被引用、或远端删除失败）

  const cap = deps.maxPerRun ?? Number.POSITIVE_INFINITY;
  for (;;) {
    if (report.payloadsDeleted >= cap) break;
    // 1) 候选调用：自身到期，且它的全部 payload 都已到期（多 payload 按整体判断）
    const candidates = await db
      .select({ id: odsProviderCalls.providerCallId })
      .from(odsProviderCalls)
      .where(
        and(
          lte(odsProviderCalls.expiresAt, now),
          sql`NOT EXISTS (SELECT 1 FROM ods_payloads p WHERE p.provider_call_id = ${odsProviderCalls.providerCallId} AND p.expires_at > ${now})`,
          skip.size ? notInArray(odsProviderCalls.providerCallId, [...skip]) : undefined,
        ),
      )
      .orderBy(odsProviderCalls.providerCallId)
      .limit(Number.isFinite(cap) ? Math.max(1, Math.min(limit, cap - report.payloadsDeleted)) : limit);
    let ids = candidates.map((c) => c.id);
    if (ids.length === 0) break;

    // 2) 被未入选调用 reconcile 引用的调用不能先删（RESTRICT）；引用方先删、被引用方后删
    const referenced = await db
      .select({ target: odsProviderCalls.reconciledByProviderCallId })
      .from(odsProviderCalls)
      .where(and(inArray(odsProviderCalls.reconciledByProviderCallId, ids), notInArray(odsProviderCalls.providerCallId, ids)));
    const blocked = new Set(referenced.map((r) => r.target!));
    for (const b of blocked) skip.add(b);
    report.blockedByReference += blocked.size;
    ids = ids.filter((i) => !blocked.has(i));

    // 3) 远端原始字节：先标 deleting，再删；失败则整个调用本轮保留
    const rows = ids.length
      ? await db
          .select({ callId: odsPayloads.providerCallId, objectId: ossObjects.ossObjectId, key: ossObjects.objectKey, status: ossObjects.status })
          .from(odsPayloads)
          .innerJoin(ossObjects, eq(ossObjects.ossObjectId, odsPayloads.ossObjectId))
          .where(inArray(odsPayloads.providerCallId, ids))
      : [];
    const failedCalls = new Set<bigint>();
    const objectsOfCall = new Map<bigint, bigint[]>();
    for (const r of rows) {
      objectsOfCall.set(r.callId, [...(objectsOfCall.get(r.callId) ?? []), r.objectId]);
      if (r.status === "deleted") continue;
      await db.update(ossObjects).set({ status: "deleting", updatedAt: now }).where(eq(ossObjects.ossObjectId, r.objectId));
      try {
        await store.delete(r.key);
        await db.update(ossObjects).set({ status: "deleted", deletedAt: now, updatedAt: now }).where(eq(ossObjects.ossObjectId, r.objectId));
      } catch {
        failedCalls.add(r.callId);
        report.objectsPendingRetry++;
      }
    }
    for (const c of failedCalls) skip.add(c);
    const ok = ids.filter((i) => !failedCalls.has(i));
    if (ok.length === 0) {
      if (ids.length === 0 && blocked.size === 0) break;
      continue; // 本批全被跳过；skip 集合已更新，下一轮会取新的候选
    }

    // 4) payload → call 的数据库行；引用方（reconciled_by 非空）先删
    const [pd] = await db.delete(odsPayloads).where(inArray(odsPayloads.providerCallId, ok));
    report.payloadsDeleted += pd.affectedRows;
    const referencers = await db
      .select({ id: odsProviderCalls.providerCallId })
      .from(odsProviderCalls)
      .where(and(inArray(odsProviderCalls.providerCallId, ok), sql`${odsProviderCalls.reconciledByProviderCallId} IS NOT NULL`));
    const refIds = referencers.map((r) => r.id);
    if (refIds.length) report.callsDeleted += (await db.delete(odsProviderCalls).where(inArray(odsProviderCalls.providerCallId, refIds)))[0].affectedRows;
    const rest = ok.filter((i) => !refIds.includes(i));
    if (rest.length) report.callsDeleted += (await db.delete(odsProviderCalls).where(inArray(odsProviderCalls.providerCallId, rest)))[0].affectedRows;

    // 5) 不再被引用的 ODS 对象元数据行（category=ods）
    const objectIds = ok.flatMap((c) => objectsOfCall.get(c) ?? []);
    if (objectIds.length) {
      const [od] = await db.delete(ossObjects).where(and(inArray(ossObjects.ossObjectId, objectIds), eq(ossObjects.objectCategory, "ods"), eq(ossObjects.status, "deleted")));
      report.objectsDeleted += od.affectedRows;
    }
  }

  // 6) 任务：到期、终态、且已没有任何调用
  const expiredTasks = await db.select({ id: syncTasks.taskId, status: syncTasks.status }).from(syncTasks).where(lte(syncTasks.expiresAt, now));
  report.skippedNonTerminalTasks = expiredTasks.filter((t) => !TERMINAL.includes(t.status)).length;
  const terminalIds = expiredTasks.filter((t) => TERMINAL.includes(t.status)).map((t) => t.id).slice(0, Number.isFinite(cap) ? cap : undefined);
  for (let i = 0; i < terminalIds.length; i += limit) {
    const chunk = terminalIds.slice(i, i + limit);
    const [td] = await db
      .delete(syncTasks)
      .where(and(inArray(syncTasks.taskId, chunk), sql`NOT EXISTS (SELECT 1 FROM ods_provider_calls c WHERE c.sync_task_id = ${syncTasks.taskId})`));
    report.tasksDeleted += td.affectedRows;
  }

  const at = now.toISOString();
  deps.onEvent?.({ phase: "payloads", count: report.payloadsDeleted, at });
  deps.onEvent?.({ phase: "calls", count: report.callsDeleted, at });
  deps.onEvent?.({ phase: "tasks", count: report.tasksDeleted, at });
  deps.onEvent?.({ phase: "objects", count: report.objectsDeleted, at });
  return report;
}

/**
 * ODS orphan sweeper：上传成功但数据库短事务失败时遗留的对象。只扫描 ods/ 前缀（用途限定，正式媒资不受影响），
 * 回收「超过宽限期且没有 oss_objects 记录」的对象。宽限期保护正在上传、事务尚未提交的对象。
 */
export async function sweepOrphans(deps: { db: Db; store: ObjectStore; clock: Clock; graceMs: number; prefix?: string; /** 本次最多删多少个（定时清扫有界）；ponytail: 仍会列出前缀下全部对象，对象数过万时改成按页清扫。 */ maxDelete?: number }): Promise<{ deleted: number; kept: number }> {
  const cutoff = deps.clock.now().getTime() - deps.graceMs;
  const listed = await deps.store.list(deps.prefix ?? ODS_PREFIX);
  const old = listed.filter((o) => o.createdAt.getTime() <= cutoff);
  let deleted = 0;
  for (let i = 0; i < old.length; i += 500) {
    const chunk = old.slice(i, i + 500);
    const known = await deps.db.select({ key: ossObjects.objectKey }).from(ossObjects).where(inArray(ossObjects.objectKey, chunk.map((o) => o.key)));
    const knownKeys = new Set(known.map((k) => k.key));
    for (const o of chunk) {
      if (knownKeys.has(o.key)) continue;
      if (deps.maxDelete !== undefined && deleted >= deps.maxDelete) break;
      await deps.store.delete(o.key);
      deleted++;
    }
  }
  return { deleted, kept: listed.length - deleted };
}
