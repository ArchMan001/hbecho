// 「本轮」与复用条件（FS-8.4、FS-D06）。
import { and, eq, isNotNull, max, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { syncBatches } from "../../db/schema";

/**
 * 本轮起点 = 最近一个**已开始**的 full 批次的 started_at（排除 skipped / expired / cancelled）；没有则 null（不限轮次）。
 * 用 started_at 而不是 logical_at：批次可能排队几小时才晋升，logical_at 是计划时点，早于真正开始，
 * 会把上一批次期间完成的结果误算进本轮。
 */
export async function roundStart(db: Db): Promise<Date | null> {
  const [r] = await db
    .select({ at: max(syncBatches.startedAt) })
    .from(syncBatches)
    .where(and(eq(syncBatches.purpose, "full"), notInArray(syncBatches.status, ["skipped", "expired", "cancelled"]), isNotNull(syncBatches.startedAt)));
  return r?.at ?? null;
}

/** 详情 / 评论的复用：任务完成时间 ≥ 本轮起点，不论批次用途；更早轮次的结果（包括上一轮由按需批次产生的）不复用。 */
export const isFreshForRound = (finishedAt: Date | null, start: Date | null): boolean => finishedAt !== null && (start === null || finishedAt.getTime() >= start.getTime());
