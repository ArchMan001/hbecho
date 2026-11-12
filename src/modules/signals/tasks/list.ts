// 运维查看任务（`signals tasks list [--status dead]`）。只读；不返回 params（只有 ID 与指纹，对排障没有用）。
// last_error_detail 在写入时已脱敏（URL 一律替换为 <url>）。
import { desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { SIGNAL_TASK_STATUSES, signalTasks } from "../../../db/schema";
import { CAP_SEGMENT_MANAGE, assert, type SignalActor } from "../authz";
import { SignalError } from "../errors";

export const MAX_TASK_LIST = 500;

export async function listTasks(deps: { db: Db }, actor: SignalActor, o: { status?: string; limit: number }) {
  assert(actor, CAP_SEGMENT_MANAGE);
  if (o.status !== undefined && !(SIGNAL_TASK_STATUSES as readonly string[]).includes(o.status)) throw new SignalError("input", "invalid_status", `status 只能是 ${SIGNAL_TASK_STATUSES.join("、")}`);
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > MAX_TASK_LIST) throw new SignalError("input", "invalid_limit", `limit 必须是 1–${MAX_TASK_LIST} 的整数`);
  const rows = await deps.db
    .select()
    .from(signalTasks)
    .where(o.status === undefined ? undefined : eq(signalTasks.status, o.status))
    .orderBy(desc(signalTasks.taskId))
    .limit(o.limit);
  return rows.map((r) => ({
    taskId: r.taskId,
    kind: r.kind,
    status: r.status,
    attemptCount: r.attemptCount,
    maxAttempts: r.maxAttempts,
    deferCount: r.deferCount,
    runId: r.runId,
    resultId: r.resultId,
    lastErrorCode: r.lastErrorCode,
    lastErrorDetail: r.lastErrorDetail,
    nextAttemptAt: r.nextAttemptAt,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }));
}
