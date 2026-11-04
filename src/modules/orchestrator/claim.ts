// 任务领取：限时租约 + 单调递增的 fencing token（R18.1）。任务 8 在此之上补心跳、重试等待与死信。
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { syncTasks } from "../../db/schema";
import type { TaskRow } from "./fenced";

const TERMINAL = new Set(["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"]);
export const isTerminalStatus = (s: string) => TERMINAL.has(s);

export type ClaimResult =
  | { kind: "claimed"; task: TaskRow; token: bigint }
  | { kind: "terminal"; task: TaskRow }
  | { kind: "busy"; task: TaskRow }
  /** retry_wait 且还没到下一次尝试的时间。 */
  | { kind: "not_due"; task: TaskRow }
  | { kind: "not_found" };

export async function claimTask(db: Db, taskId: bigint, o: { workerId: string; leaseMs: number; now: Date }): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, taskId)).for("update");
    if (!task) return { kind: "not_found" as const };
    if (isTerminalStatus(task.status)) return { kind: "terminal" as const, task };
    if (task.status === "retry_wait" && task.nextAttemptAt && task.nextAttemptAt.getTime() > o.now.getTime()) return { kind: "not_due" as const, task };
    const leased = task.status === "leased" || task.status === "running";
    if (leased && task.leaseExpiresAt && task.leaseExpiresAt.getTime() > o.now.getTime()) return { kind: "busy" as const, task };

    const token = task.fencingToken + 1n; // 每次领取都使旧 worker 的 token 失效
    await tx
      .update(syncTasks)
      .set({
        status: "running",
        leaseOwner: o.workerId,
        leaseExpiresAt: new Date(o.now.getTime() + o.leaseMs),
        fencingToken: token,
        nextAttemptAt: null,
        startedAt: task.startedAt ?? o.now,
        updatedAt: o.now,
      })
      .where(eq(syncTasks.taskId, taskId));
    return { kind: "claimed" as const, task: { ...task, status: "running", fencingToken: token }, token };
  });
}

/**
 * 心跳：续期租约。只有 fencing token 一致、仍处于租约状态且租约未过期时才续期；
 * 否则说明已被取消 / 取代，调用方必须立即停止（不再发起新调用）。
 */
export async function heartbeat(db: Db, taskId: bigint, token: bigint, o: { now: Date; leaseMs: number }): Promise<"ok" | "cancelled" | "stale"> {
  const [r] = await db
    .update(syncTasks)
    .set({ leaseExpiresAt: new Date(o.now.getTime() + o.leaseMs), updatedAt: o.now })
    .where(and(eq(syncTasks.taskId, taskId), eq(syncTasks.fencingToken, token), inArray(syncTasks.status, ["leased", "running"]), gt(syncTasks.leaseExpiresAt, o.now)));
  if (r.affectedRows === 1) return "ok";
  const [row] = await db.select({ status: syncTasks.status }).from(syncTasks).where(eq(syncTasks.taskId, taskId));
  return row?.status === "cancelled" ? "cancelled" : "stale";
}
