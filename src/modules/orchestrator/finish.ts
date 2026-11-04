// 根任务 / 子任务的终态写入与批次汇总。只能在 withFences 的事务里调用（先校验租约，再写终态）。
import { eq } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { syncBatches, syncTasks } from "../../db/schema";
import type { EntryOutcome } from "../tracer-command";
import type { TaskRow } from "./fenced";

export type RootTerminal =
  | {
      status: "succeeded";
      entryOutcome: EntryOutcome;
      stopReason?: string;
      summary?: Record<string, unknown>;
      accountId?: bigint;
      assignmentId?: bigint;
    }
  | {
      status: "failed";
      /** 业务阻塞（不是技术失败）：assignment_conflict / staff_platform_slot_taken，状态机用 stop_reason 区分。 */
      stopReason?: string;
      errorCode?: string;
      category?: string;
      entryOutcome?: "invalid_link";
      summary?: Record<string, unknown>;
      accountId?: bigint;
      assignmentId?: bigint;
    };

export async function finishRoot(tx: DbTx, root: TaskRow, t: RootTerminal, now: Date): Promise<void> {
  const summary = { ...(t.summary ?? {}), ...(t.entryOutcome ? { entry_outcome: t.entryOutcome } : {}), warnings: [] };
  await tx
    .update(syncTasks)
    .set({
      status: t.status,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      stopReason: t.stopReason ?? null,
      lastErrorCode: t.status === "failed" ? (t.errorCode ?? null) : null,
      lastErrorDetail: t.status === "failed" && t.category ? { category: t.category } : null,
      resultSummary: summary,
      ...(t.accountId === undefined ? {} : { accountId: t.accountId }),
      ...(t.assignmentId === undefined ? {} : { assignmentId: t.assignmentId }),
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(syncTasks.taskId, root.taskId));
  await settleBatch(tx, root.batchId, now);
}

export async function finishChild(
  tx: DbTx,
  child: TaskRow,
  t: {
    status: "succeeded" | "failed";
    attemptCount: number;
    stopReason?: string;
    errorCode?: string;
    category?: string;
    summary?: Record<string, unknown>;
    counters?: { pageCount: number; fetchedItemCount: number; hasMoreAtStop: boolean | null; oldestPublishedAt: Date | null; newestPublishedAt: Date | null };
  },
  now: Date,
): Promise<void> {
  await tx
    .update(syncTasks)
    .set({
      status: t.status,
      attemptCount: t.attemptCount,
      leaseOwner: null,
      leaseExpiresAt: null,
      stopReason: t.stopReason ?? null,
      lastErrorCode: t.errorCode ?? null,
      lastErrorDetail: t.category ? { category: t.category } : null,
      resultSummary: t.summary ?? null,
      ...(t.counters ?? {}),
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(syncTasks.taskId, child.taskId));
}

const OK = new Set(["succeeded", "succeeded_with_gap"]);
const BAD = new Set(["failed", "dead"]);
const DONE = new Set([...OK, ...BAD, "cancelled"]);

/** 批次汇总：所有任务都终态后才封口；成功数据不因部分失败回滚。 */
export async function settleBatch(tx: DbTx, batchId: bigint, now: Date): Promise<void> {
  const tasks = await tx.select({ status: syncTasks.status }).from(syncTasks).where(eq(syncTasks.batchId, batchId));
  const ok = tasks.filter((t) => OK.has(t.status)).length;
  const bad = tasks.filter((t) => BAD.has(t.status)).length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  const allDone = tasks.every((t) => DONE.has(t.status));
  const status = !allDone ? "running" : bad === 0 && cancelled === 0 ? "succeeded" : ok === 0 ? (bad === 0 ? "cancelled" : "failed") : "partial_succeeded";
  await tx
    .update(syncBatches)
    .set({
      status,
      plannedTaskCount: tasks.length,
      succeededTaskCount: ok,
      failedTaskCount: bad,
      ...(allDone ? { finishedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(syncBatches.batchId, batchId));
}
