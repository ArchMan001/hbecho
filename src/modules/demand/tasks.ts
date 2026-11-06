// 按需任务的创建（submit 与 DetailRunner 的后续任务共用）。幂等键 = 批次 + 账号 + 内容 + 动作：重放同一提交不会重复建任务。
import { and, eq, sql } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { syncTasks } from "../../db/schema";
import { DEMAND_PRIORITY, ONE_YEAR_MS, demandTaskKey } from "../sync-schedule/task-keys";

export const DETAIL_TASK_SCHEMA = "sync-detail-task.v1";
export const COMMENTS_TASK_SCHEMA = "sync-comments-task.v1";
export const MEDIA_VIDEO_TASK_SCHEMA = "sync-media-video-task.v1";
export type DemandAction = "fetch_content_detail" | "fetch_comments" | "download_media";
export type MediaRole = "video" | "audio";

export interface DemandTaskInput {
  batchId: bigint;
  providerId: bigint;
  platformId: bigint;
  assignmentId: bigint;
  accountId: bigint;
  contentId: bigint;
  action: DemandAction;
  params: Record<string, unknown>;
  sourceContentSnapshotId?: bigint | null;
  ruleDecisionId: string | null;
  ruleVersion: string | null;
  maxAttempts: number;
  now: Date;
}

/** 返回任务 id；同一幂等键已存在则返回已有任务（不改写）。必须写 account_id：领取时的监控资格复核靠它（fail closed）。 */
export async function insertDemandTask(tx: DbTx, i: DemandTaskInput): Promise<bigint> {
  const key = demandTaskKey({ batchId: i.batchId, accountId: i.accountId, contentId: i.contentId, action: i.action });
  await tx
    .insert(syncTasks)
    .values({
      batchId: i.batchId,
      providerId: i.providerId,
      platformId: i.platformId,
      assignmentId: i.assignmentId,
      accountId: i.accountId,
      contentId: i.contentId,
      requestedAction: i.action,
      subjectType: "content",
      subjectId: i.contentId,
      taskParameters: i.params,
      ruleDecisionId: i.ruleDecisionId,
      ruleVersion: i.ruleVersion,
      sourceContentSnapshotId: i.sourceContentSnapshotId ?? null,
      idempotencyKey: key,
      status: "pending",
      priority: DEMAND_PRIORITY,
      attemptCount: 0,
      maxAttempts: i.maxAttempts,
      expiresAt: new Date(i.now.getTime() + ONE_YEAR_MS),
      createdAt: i.now,
      updatedAt: i.now,
    })
    .onDuplicateKeyUpdate({ set: { taskId: sql`task_id` } });
  const [row] = await tx.select({ id: syncTasks.taskId }).from(syncTasks).where(and(eq(syncTasks.idempotencyKey, key)));
  return row!.id;
}
