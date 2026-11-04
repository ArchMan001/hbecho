// 任务领取：限时租约 + 单调递增的 fencing token（R18.1）。任务 8 在此之上补心跳、重试等待与死信。
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { syncTasks } from "../../db/schema";
import type { TaskRow } from "./fenced";

const TERMINAL = new Set(["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"]);
export const isTerminalStatus = (s: string) => TERMINAL.has(s);

export type ClaimResult =
  | { kind: "claimed"; task: TaskRow; token: bigint }
  | { kind: "terminal"; task: TaskRow }
  | { kind: "busy"; task: TaskRow }
  | { kind: "not_found" };

export async function claimTask(db: Db, taskId: bigint, o: { workerId: string; leaseMs: number; now: Date }): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, taskId)).for("update");
    if (!task) return { kind: "not_found" as const };
    if (isTerminalStatus(task.status)) return { kind: "terminal" as const, task };
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
