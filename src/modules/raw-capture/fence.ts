import type { syncTasks } from "../../db/schema";
import type { FenceFailureReason } from "./errors";

type TaskRow = typeof syncTasks.$inferSelect;

/**
 * 任务是否仍允许这个 worker 继续（R18.1）：任务存在、未取消、fencing token 一致、处于租约状态且租约未过期。
 * 返回 null 表示有效；否则返回稳定原因。
 */
export function fenceFailure(task: TaskRow | undefined, token: bigint, now: Date): FenceFailureReason | null {
  if (!task) return "task_not_found";
  if (task.status === "cancelled") return "cancelled";
  if (task.fencingToken !== token) return "stale_fence";
  if (task.status !== "leased" && task.status !== "running") return "task_not_running";
  if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime()) return "lease_expired";
  return null;
}
