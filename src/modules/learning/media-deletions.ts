// 待删除媒体的队列与执行（G-D46、design §6）：替换的旧文件、归档的课程媒体、无引用的残渣。
// 业务先提交，删除失败不回滚业务，进队列按指数退避重试；队列行唯一 (kind, target)，重复入队是无操作。
import { and, eq, lte } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { DELETION_REASONS, courseMediaDeletions } from "../../db/schema";
import type { LearningDeps } from "./deps";

export type DeletionTarget = { kind: "vod_video" | "oss_object"; id: string };
type Reason = (typeof DELETION_REASONS)[number];

/** 在调用方的事务里入队（与业务写入同提交）；已在队列里则忽略。 */
export async function enqueueDeletion(tx: Db | DbTx, deps: Pick<LearningDeps, "clock">, target: DeletionTarget, reason: Reason, courseId: bigint | null): Promise<void> {
  const now = deps.clock.now();
  await tx
    .insert(courseMediaDeletions)
    .values({ targetKind: target.kind, targetId: target.id, courseId, reason, status: "pending", nextAttemptAt: now, createdAt: now })
    .onDuplicateKeyUpdate({ set: { targetKind: target.kind } }); // 无操作：保持原行
}

const BACKOFF_CAP_MS = 6 * 3600_000;
/** 失败后的下次尝试间隔：1、2、4……分钟，封顶 6 小时。 */
export const backoffMs = (attempts: number): number => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
/** 24 小时仍删不掉就告警（G-D46）；那时它也已满足「无引用超过 24 小时」，残渣清理会继续盯着。 */
export const STUCK_AFTER_MS = 24 * 3600_000;

export interface DeletionRun {
  done: number;
  failed: number;
  stuck: number;
}

/** 处理到期的待删除项。逐项独立：一项失败不影响其余。 */
export async function processDeletions(deps: LearningDeps, opts: { limit?: number } = {}): Promise<DeletionRun> {
  const now = deps.clock.now();
  const due = await deps.db
    .select()
    .from(courseMediaDeletions)
    .where(and(eq(courseMediaDeletions.status, "pending"), lte(courseMediaDeletions.nextAttemptAt, now)))
    .orderBy(courseMediaDeletions.deletionId)
    .limit(opts.limit ?? 100);
  const run: DeletionRun = { done: 0, failed: 0, stuck: 0 };
  for (const d of due) {
    try {
      if (d.targetKind === "vod_video") await deps.vod.deleteVideo(d.targetId);
      else await deps.store.delete(d.targetId);
      await deps.db.update(courseMediaDeletions).set({ status: "done", doneAt: deps.clock.now(), lastError: null }).where(eq(courseMediaDeletions.deletionId, d.deletionId));
      run.done += 1;
    } catch {
      const attempts = d.attempts + 1;
      await deps.db
        .update(courseMediaDeletions)
        .set({ attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), lastError: "delete_failed" })
        .where(eq(courseMediaDeletions.deletionId, d.deletionId));
      run.failed += 1;
      if (now.getTime() - d.createdAt.getTime() >= STUCK_AFTER_MS) {
        run.stuck += 1;
        deps.alert?.({ code: "media_deletion_stuck", targetKind: d.targetKind, targetId: d.targetId, attempts });
      }
    }
  }
  return run;
}
