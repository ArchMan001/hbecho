// 周期 / 补抓批次的账号级媒资任务（design §7.11、FS-11.1）：结构化阶段全部终态后，对有成功结构化任务的账号各建一个 download_media。
// 用对账而不是改规划器：规划器与任务 3 的测试不动；幂等键 = 批次 + 账号 + 动作，重复调用不会重复建任务。
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { syncTasks } from "../../db/schema";
import type { Clock } from "../raw-capture";
import { ONE_YEAR_MS, STRUCTURED_ACTIONS, taskIdempotencyKey } from "./task-keys";

export const ACCOUNT_MEDIA_TASK_SCHEMA = "sync-media-task.v1";
/**
 * 可作为账号级媒资任务模板的成功任务：周期 / 补抓的主页与列表，加上名单导入的 resolve_account（intake 批次）。
 * 2026-11-20：此前漏了 resolve_account，名单导入后新账号的头像 / 主页背景一直停在 pending，直到下一个周一全量才下载（测试机 573 个）。
 */
const MEDIA_TEMPLATE_ACTIONS = [...STRUCTURED_ACTIONS, "resolve_account"] as const;
const CHUNK = 500;

/** 返回新建（或已存在）任务所覆盖的账号数；批次内已有 download_media 的账号不重复建。 */
export async function ensureMediaTasks(db: Db, clock: Clock, batchId: bigint): Promise<number> {
  // 每个账号取一条成功的结构化任务作模板（platform / assignment / provider / maxAttempts 相同）
  const rows = await db
    .select({
      accountId: syncTasks.accountId,
      providerId: sql<bigint>`MIN(${syncTasks.providerId})`.mapWith(BigInt),
      platformId: sql<bigint>`MIN(${syncTasks.platformId})`.mapWith(BigInt),
      assignmentId: sql<bigint | null>`MIN(${syncTasks.assignmentId})`.mapWith((v) => (v === null ? null : BigInt(v))),
      maxAttempts: sql<number>`MIN(${syncTasks.maxAttempts})`.mapWith(Number),
    })
    .from(syncTasks)
    .where(and(eq(syncTasks.batchId, batchId), inArray(syncTasks.requestedAction, [...MEDIA_TEMPLATE_ACTIONS]), inArray(syncTasks.status, ["succeeded", "succeeded_with_gap"])))
    .groupBy(syncTasks.accountId);
  const now = clock.now();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await db
      .insert(syncTasks)
      .values(
        part.map((r) => ({
          batchId,
          providerId: r.providerId,
          platformId: r.platformId,
          assignmentId: r.assignmentId,
          accountId: r.accountId!,
          requestedAction: "download_media",
          subjectType: "external_account",
          subjectId: r.accountId!,
          taskParameters: { schema_version: ACCOUNT_MEDIA_TASK_SCHEMA, scope: "account_batch" },
          idempotencyKey: taskIdempotencyKey({ batchId, accountId: r.accountId!, action: "download_media" }),
          status: "pending",
          priority: 0,
          attemptCount: 0,
          maxAttempts: r.maxAttempts,
          expiresAt: new Date(now.getTime() + ONE_YEAR_MS),
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onDuplicateKeyUpdate({ set: { taskId: sql`task_id` } });
  }
  return rows.length;
}
