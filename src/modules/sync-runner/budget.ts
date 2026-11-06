// 批次作用域的调用数 / 点数硬上限（FS-16.4）。达到上限在**下一次调用前**封口（网关把它记为 not_sent），不是调用后告警。
// 点数表见 cost-guard；失败、超时、429 与异步轮询不计点。
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { odsProviderCalls, platforms, syncTasks } from "../../db/schema";
import { pointsOf } from "../cost-guard";
import type { PolicyContext, SendPolicy } from "../raw-capture";

export interface BatchBudgetLimits {
  /** 非轮询的供应商调用数上限（含重试与 ambiguous 重发）。 */
  maxCalls: number;
  maxPoints: number;
  maxPolls?: number;
}
export interface BatchSpent {
  calls: number;
  polls: number;
  points: number;
}

/**
 * 一个批次到目前为止的花费。保守口径：
 *  - 计调用：所有没有被封口（not_sent）的调用，含 prepared / in_flight（别的任务正要发出的也算）；
 *  - 计点：outcome 为 succeeded、ambiguous / reconciled_succeeded（可能已计费）或尚未有结果（prepared / in_flight）的调用。
 * ponytail: 每次检查聚合整个批次的调用，O(批次内调用数)。QPS≈2、一个批次≤25,000 次时每次几十毫秒，可以接受；
 * QPS 上去后改成进程内累计值，按批次定期校准。
 */
export async function spentForBatch(db: Db, batchId: bigint, exclude?: Pick<PolicyContext, "syncTaskId" | "attemptNo" | "callSequence">): Promise<BatchSpent> {
  const rows = await db
    .select({ action: odsProviderCalls.requestedAction, outcome: odsProviderCalls.outcome, platform: platforms.platformCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(odsProviderCalls)
    .innerJoin(syncTasks, eq(syncTasks.taskId, odsProviderCalls.syncTaskId))
    .leftJoin(platforms, eq(platforms.platformId, odsProviderCalls.platformId))
    .where(
      and(
        eq(syncTasks.batchId, batchId),
        sql`(${odsProviderCalls.outcome} IS NULL OR ${odsProviderCalls.outcome} <> 'not_sent')`,
        exclude
          ? sql`NOT (${odsProviderCalls.syncTaskId} = ${exclude.syncTaskId} AND ${odsProviderCalls.attemptNo} = ${exclude.attemptNo} AND ${odsProviderCalls.callSequence} = ${exclude.callSequence})`
          : undefined,
      ),
    )
    .groupBy(odsProviderCalls.requestedAction, odsProviderCalls.outcome, platforms.platformCode);
  const s: BatchSpent = { calls: 0, polls: 0, points: 0 };
  for (const r of rows) {
    if (r.action === "task_lookup") {
      s.polls += r.n;
      continue;
    }
    s.calls += r.n;
    const billable = r.outcome === null || r.outcome === "succeeded" || r.outcome === "ambiguous" || r.outcome === "reconciled_succeeded";
    if (billable) s.points += r.n * pointsOf(r.platform ?? "", r.action);
  }
  return s;
}

export const BUDGET_REASONS = ["call_budget", "points_budget", "poll_budget"] as const;
/** 网关把策略封口记为 `policy:<reason>`。 */
export const isBudgetReason = (reason: string): boolean => BUDGET_REASONS.some((r) => reason === `policy:${r}`);

export function createBatchBudgetPolicy(db: Db, limits: BatchBudgetLimits): SendPolicy {
  return {
    async check(ctx: PolicyContext) {
      const [task] = await db
        .select({ batchId: syncTasks.batchId, platform: platforms.platformCode })
        .from(syncTasks)
        .innerJoin(platforms, eq(platforms.platformId, syncTasks.platformId))
        .where(eq(syncTasks.taskId, ctx.syncTaskId));
      if (!task) return null;
      const spent = await spentForBatch(db, task.batchId, ctx);
      if (ctx.requestedAction === "task_lookup") return limits.maxPolls !== undefined && spent.polls >= limits.maxPolls ? "poll_budget" : null;
      if (spent.calls >= limits.maxCalls) return "call_budget";
      if (spent.points + pointsOf(task.platform, ctx.requestedAction) > limits.maxPoints) return "points_budget";
      return null;
    },
  };
}
