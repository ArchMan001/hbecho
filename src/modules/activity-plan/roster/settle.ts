// 名单解析结果归并（design §7.6）：根任务到达终态后，在一个短事务里把结果写回行结果、名单与监控。
// 幂等：只处理 outcome='pending_account' 的行；名单项 UQ(plan_id, account_id)；重复运行不产生第二份结果。
// 技术失败不会被写成 invalid：resolve_failed 与 invalid 是两个不同的结果；不自动重试。
import { and, eq } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { activityPlans, externalAccounts, importBatches, importRowResults, sectors, stores, syncTasks, activityPlanBranches } from "../../../db/schema";
import { EVENTS, reconcileAccounts } from "../../plan-references";
import type { PlanAuditEvent } from "../audit";
import { countOutcomes, upsertEntry } from "./confirm";

export const WORKER_ACTOR = "service:plan-worker";
export type SettleOutcome = "imported" | "unchanged" | "conflict" | "invalid" | "suspected_empty" | "resolve_failed";
export interface RowDecision {
  outcome: SettleOutcome;
  reason?: string;
  detail?: string;
  /** 需要建 / 恢复名单项并开启监控（成功类结果） */
  referenced: boolean;
}

/** 根任务终态 → 行结果（纯映射，design §7.6 表）。accountCreated 缺失时由调用方用 first_seen_at 兜底后传入。 */
export function decideRow(root: { status: string; stopReason: string | null; lastErrorCode: string | null; lastErrorCategory: string | null; entryOutcome: string | null; accountCreated: boolean }): RowDecision {
  if (root.status === "succeeded") {
    if (root.entryOutcome === "suspected_empty" || root.stopReason === "suspected_empty") return { outcome: "suspected_empty", reason: "suspected_empty", referenced: true };
    return root.accountCreated ? { outcome: "imported", referenced: true } : { outcome: "unchanged", reason: "existing_account_referenced", referenced: true };
  }
  if (root.status === "failed") {
    if (root.stopReason === "assignment_conflict") return { outcome: "conflict", reason: "assignment_conflict", detail: "该主页已归属于其他专员，原归属不变", referenced: false };
    if (root.stopReason === "staff_platform_slot_taken") return { outcome: "conflict", reason: "staff_platform_slot_taken", detail: "该专员在这个平台已经有另一个账号", referenced: false };
    if (root.stopReason === "invalid_link" || root.entryOutcome === "invalid_link") {
      return { outcome: "invalid", reason: root.lastErrorCode ?? "result_validation_exhausted", detail: "主页链接无效或无法解析", referenced: false };
    }
  }
  if (root.status === "cancelled") return { outcome: "resolve_failed", reason: "root_cancelled", detail: "解析任务被取消", referenced: false };
  return { outcome: "resolve_failed", reason: "root_failed", detail: `解析失败（${root.lastErrorCategory ?? root.lastErrorCode ?? "unknown"}）`, referenced: false };
}

export interface SettleResult {
  settled: boolean;
  batchId: bigint | null;
  /** 本次让批次变成 completed（事务提交后调用 finalize） */
  completedBatchId: bigint | null;
  events: PlanAuditEvent[];
}
const nothing: SettleResult = { settled: false, batchId: null, completedBatchId: null, events: [] };

/** 根任务已被清理（一年保留期后 resolve_task_id 置空）而行仍挂起：落为 resolve_failed/root_expired，不让它永远悬挂。 */
export async function settleExpired(db: Db, rowId: bigint, now: Date): Promise<SettleResult> {
  return settle(db, rowId, now, "expired");
}

export async function settleRow(db: Db, rowId: bigint, now: Date): Promise<SettleResult> {
  return settle(db, rowId, now, "task");
}

async function settle(db: Db, rowId: bigint, now: Date, mode: "task" | "expired"): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select().from(importRowResults).where(eq(importRowResults.importRowResultId, rowId));
    if (!peek || peek.outcome !== "pending_account") return nothing;
    const [batch] = await tx.select().from(importBatches).where(eq(importBatches.importBatchId, peek.importBatchId)).for("update");
    const [row] = await tx.select().from(importRowResults).where(eq(importRowResults.importRowResultId, rowId)).for("update");
    // 批次还在写入（writing）时不归并：它的挂起行可能还没写完，提前归并会让批次误判为完成
    if (!batch || !row || row.outcome !== "pending_account" || batch.planId === null || batch.status !== "resolving") return nothing;
    let decision: RowDecision;
    let accountId: bigint | null = null;
    if (mode === "expired" || row.resolveTaskId === null) {
      decision = { outcome: "resolve_failed", reason: "root_expired", detail: "解析任务已超过保留期被清理，请重新上传这一行", referenced: false };
    } else {
      const [root] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, row.resolveTaskId));
      if (!root) {
        decision = { outcome: "resolve_failed", reason: "root_expired", detail: "解析任务已被清理，请重新上传这一行", referenced: false };
      } else if (!["succeeded", "failed", "dead", "cancelled"].includes(root.status)) {
        return nothing; // 还没到终态
      } else {
        const summary = (root.resultSummary ?? {}) as { entry_outcome?: string; account_created?: boolean };
        accountId = root.accountId;
        let created = summary.account_created;
        if (created === undefined && root.accountId !== null) {
          // 旧根任务没有 account_created：账号第一次出现的时间不早于根任务创建时间，就认为是这次建的
          const [acct] = await tx.select({ f: externalAccounts.firstSeenAt }).from(externalAccounts).where(eq(externalAccounts.accountId, root.accountId));
          created = acct !== undefined && acct.f.getTime() >= root.createdAt.getTime();
        }
        const category = (root.lastErrorDetail as { category?: string } | null)?.category ?? null;
        decision = decideRow({ status: root.status, stopReason: root.stopReason, lastErrorCode: root.lastErrorCode, lastErrorCategory: category, entryOutcome: summary.entry_outcome ?? null, accountCreated: created ?? false });
      }
    }
    const events: PlanAuditEvent[] = [];
    // 计划已暂停 / 删除，或分公司已退出：不建名单项（账号与归属已由根任务建立，保留——停用不删除）
    if (decision.referenced) {
      const [plan] = await tx.select().from(activityPlans).where(eq(activityPlans.planId, batch.planId)).for("share");
      const [store] = row.storeId === null ? [] : await tx.select({ branchId: sectors.branchId }).from(stores).innerJoin(sectors, eq(sectors.sectorId, stores.sectorId)).where(eq(stores.storeId, row.storeId));
      const [part] = store ? await tx.select().from(activityPlanBranches).where(and(eq(activityPlanBranches.planId, batch.planId), eq(activityPlanBranches.branchId, store.branchId))) : [];
      if (!plan || plan.status !== "collecting" || !part || part.status !== "joined" || accountId === null || row.storeId === null || row.staffId === null || !store) {
        decision = { outcome: "conflict", reason: "plan_state_changed", detail: "解析完成时计划已不在采集中或分公司已退出，未加入名单", referenced: false };
      } else {
        await upsertEntry(tx as DbTx, { planId: batch.planId, platformId: plan.platformId, accountId, branchId: store.branchId, storeId: row.storeId, staffId: row.staffId, actor: batch.confirmedByActor ?? batch.uploadedByActor, batchId: batch.importBatchId, now });
        const report = await reconcileAccounts(tx, [accountId], { ...EVENTS.imported, now, actor: WORKER_ACTOR });
        events.push(...report.events);
      }
    }
    await tx
      .update(importRowResults)
      .set({
        outcome: decision.outcome,
        reasonCode: decision.reason ?? row.reasonCode,
        reasonDetail: (decision.detail ?? row.reasonDetail ?? null)?.slice(0, 1024) ?? null,
        ...(accountId !== null && decision.referenced ? { accountId } : {}),
        resolvedAt: now,
        resolvedByActor: WORKER_ACTOR,
      })
      .where(eq(importRowResults.importRowResultId, rowId));
    // 汇总永远从行结果算出；没有挂起行时批次完成
    const counts = await countOutcomes(tx, batch.importBatchId);
    const done = counts.pending_account === 0;
    await tx
      .update(importBatches)
      .set({
        summary: { ...(batch.summary as Record<string, unknown>), confirm: counts },
        ...(done ? { status: "completed" } : {}),
        newRows: counts.imported,
        skippedRows: counts.unchanged,
        conflictRows: counts.conflict,
        updatedAt: now,
      })
      .where(eq(importBatches.importBatchId, batch.importBatchId));
    return { settled: true, batchId: batch.importBatchId, completedBatchId: done ? batch.importBatchId : null, events };
  });
}
