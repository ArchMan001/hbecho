// 批次终态与汇总（design §7.12、FS-1.7/1.8）。
// 计数列只在汇总时写，不在每个任务完成时对批次行 +1（6,000 个任务争同一行锁，FS-D21）。
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { syncBatches, syncTasks } from "../../db/schema";
import type { Clock } from "../raw-capture";
import { loadSettings } from "./settings";
import { ACTIVE_TASK_STATUSES, STRUCTURED_ACTIONS } from "./task-keys";

export interface StructuredCounts {
  planned: number;
  succeeded: number;
  /** 其中带连续性缺口的任务数（也计入 succeeded）。 */
  gap: number;
  failed: number;
  /** 因监控资格失效在领取前被取消。 */
  skipped: number;
  cancelledOther: number;
  open: number;
}
export type BatchVerdict =
  | { status: "succeeded" | "partial_succeeded" | "failed" }
  | { status: "skipped"; skipReason: "no_targets" | "all_targets_closed" };

/** 纯函数：结构化任务全终态后的批次结论（调用方保证 open=0）。 */
export function verdictOf(c: StructuredCounts): BatchVerdict {
  if (c.planned === 0) return { status: "skipped", skipReason: "no_targets" };
  // 没有任何成功与失败：全部因监控资格失效被取消 → skipped，不能记为 succeeded（FS-1.7）
  if (c.succeeded === 0 && c.failed === 0 && c.skipped > 0 && c.cancelledOther === 0) return { status: "skipped", skipReason: "all_targets_closed" };
  if (c.succeeded === 0) return { status: "failed" }; // 含「只有别的原因被取消」：不是成功
  if (c.failed > 0 || c.gap > 0) return { status: "partial_succeeded" };
  return { status: "succeeded" };
}

export function countStructured(rows: Array<{ status: string; err: string | null; n: number }>): StructuredCounts {
  const c: StructuredCounts = { planned: 0, succeeded: 0, gap: 0, failed: 0, skipped: 0, cancelledOther: 0, open: 0 };
  for (const r of rows) {
    c.planned += r.n;
    if (r.status === "succeeded") c.succeeded += r.n;
    else if (r.status === "succeeded_with_gap") (c.succeeded += r.n), (c.gap += r.n);
    else if (r.status === "failed" || r.status === "dead") c.failed += r.n;
    else if (r.status === "cancelled") r.err === "monitoring_closed" ? (c.skipped += r.n) : (c.cancelledOther += r.n);
    else c.open += r.n;
  }
  return c;
}

export interface FinalizeReport {
  finalized: Array<{ batchId: string; status: string; skipReason: string | null }>;
  mediaFinished: string[];
}

/** 对所有 running 的全量 / 补抓批次汇总；并给已终态批次补写 media_finished_at。 */
export function createBatchSummarizer(deps: { db: Db; clock: Clock }) {
  const { db, clock } = deps;

  async function finalizeOne(batchId: bigint): Promise<FinalizeReport["finalized"][number] | null> {
    return db.transaction(async (tx) => {
      await loadSettings(tx, { lock: true });
      const [b] = await tx.select({ status: syncBatches.status }).from(syncBatches).where(eq(syncBatches.batchId, batchId)).for("update");
      if (b?.status !== "running") return null;
      const rows = await tx
        .select({ status: syncTasks.status, err: syncTasks.lastErrorCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(syncTasks)
        .where(and(eq(syncTasks.batchId, batchId), inArray(syncTasks.requestedAction, [...STRUCTURED_ACTIONS])))
        .groupBy(syncTasks.status, syncTasks.lastErrorCode);
      const c = countStructured(rows);
      if (c.open > 0) return null;
      const v = verdictOf(c);
      const now = clock.now();
      await tx
        .update(syncBatches)
        .set({
          status: v.status,
          skipReason: v.status === "skipped" ? v.skipReason : null,
          plannedTaskCount: c.planned,
          succeededTaskCount: c.succeeded,
          failedTaskCount: c.failed,
          skippedTaskCount: c.skipped,
          gapTaskCount: c.gap,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(syncBatches.batchId, batchId));
      return { batchId: batchId.toString(), status: v.status, skipReason: v.status === "skipped" ? v.skipReason : null };
    });
  }

  async function finalizeAll(): Promise<FinalizeReport> {
    const running = await db
      .select({ id: syncBatches.batchId })
      .from(syncBatches)
      .where(and(eq(syncBatches.status, "running"), inArray(syncBatches.purpose, ["full", "supplement"])));
    const finalized: FinalizeReport["finalized"] = [];
    for (const { id } of running) {
      const r = await finalizeOne(id);
      if (r) finalized.push(r);
    }
    // 媒资：批次已终态（成功 / 部分成功 / 失败）且没有未终态的 download_media → 写 media_finished_at（R5）
    const pending = await db
      .select({ id: syncBatches.batchId })
      .from(syncBatches)
      .where(and(inArray(syncBatches.status, ["succeeded", "partial_succeeded", "failed"]), sql`${syncBatches.mediaFinishedAt} IS NULL`, inArray(syncBatches.purpose, ["full", "supplement"])));
    const mediaFinished: string[] = [];
    for (const { id } of pending) {
      const [open] = await db
        .select({ n: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(syncTasks)
        .where(and(eq(syncTasks.batchId, id), eq(syncTasks.requestedAction, "download_media"), inArray(syncTasks.status, [...ACTIVE_TASK_STATUSES])));
      if ((open?.n ?? 0) > 0) continue;
      const now = clock.now();
      const res = await db.update(syncBatches).set({ mediaFinishedAt: now, updatedAt: now }).where(and(eq(syncBatches.batchId, id), sql`${syncBatches.mediaFinishedAt} IS NULL`));
      if (res[0].affectedRows > 0) mediaFinished.push(id.toString());
    }
    return { finalized, mediaFinished };
  }

  return { finalizeAll, finalizeOne };
}
export type BatchSummarizer = ReturnType<typeof createBatchSummarizer>;
