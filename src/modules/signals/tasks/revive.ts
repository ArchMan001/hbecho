// 运维复活 dead 任务（`signals tasks revive <taskId>`）：计数清零，回到 pending。
// 拒绝：已取消的重算的 chunk（run_cancelled）、已完成重算的 chunk；failed run 的 chunk 由 recompute.apply 复活，不直接 revive。
import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { signalRecomputeRuns, signalTasks } from "../../../db/schema";
import type { Clock } from "../../raw-capture";
import { CAP_SEGMENT_MANAGE, assert, type SignalActor } from "../authz";
import { SignalError } from "../errors";

export async function reviveTask(deps: { db: Db; clock: Clock }, actor: SignalActor, taskId: bigint): Promise<void> {
  assert(actor, CAP_SEGMENT_MANAGE);
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    const [task] = await tx.select().from(signalTasks).where(eq(signalTasks.taskId, taskId)).for("update");
    if (!task) throw new SignalError("not_found", "task_not_found", "任务不存在");
    if (task.status !== "dead") throw new SignalError("conflict", "task_not_dead", `任务状态是 ${task.status}，只有 dead 的任务可以复活`);
    if (task.lastErrorCode === "run_cancelled") throw new SignalError("conflict", "task_not_revivable", "该任务属于已取消的重算，不能复活；同范围重新 apply 会新建 run");
    if (task.kind === "recompute_chunk" && task.runId !== null) {
      const [run] = await tx.select().from(signalRecomputeRuns).where(eq(signalRecomputeRuns.runId, task.runId));
      if (!run || run.status === "completed" || run.status === "cancelled") throw new SignalError("conflict", "task_not_revivable", `重算已${run?.status === "completed" ? "完成" : "取消"}，不能复活其分块`);
      if (run.status === "failed") throw new SignalError("conflict", "task_not_revivable", "failed 的重算由 recompute apply 续跑，不直接复活分块");
    }
    await tx
      .update(signalTasks)
      .set({ status: "pending", attemptCount: 0, deferCount: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorDetail: null, finishedAt: null, updatedAt: now })
      .where(eq(signalTasks.taskId, taskId));
  });
}
