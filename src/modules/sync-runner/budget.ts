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

export const BUDGET_REASONS = ["call_budget", "points_budget", "poll_budget", "year_budget"] as const;
/** 网关把策略封口记为 `policy:<reason>`。 */
export const isBudgetReason = (reason: string): boolean => BUDGET_REASONS.some((r) => reason === `policy:${r}`);

/**
 * 最近 365 天的累计点数（年度硬护栏，刘学奎 2026-11-19：年度上限 3 万元 = 300 万点）。口径同 spentForBatch：
 * 没有被封口的调用里，succeeded / ambiguous / reconciled_succeeded 或尚未有结果的算点；轮询不计。按 prepared_at 取窗口（有索引）。
 */
export async function spentInWindow(db: Db, since: Date, exclude?: Pick<PolicyContext, "syncTaskId" | "attemptNo" | "callSequence">): Promise<number> {
  const rows = await db
    .select({ action: odsProviderCalls.requestedAction, outcome: odsProviderCalls.outcome, platform: platforms.platformCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(odsProviderCalls)
    .leftJoin(platforms, eq(platforms.platformId, odsProviderCalls.platformId))
    .where(
      and(
        sql`${odsProviderCalls.preparedAt} >= ${since}`,
        sql`(${odsProviderCalls.outcome} IS NULL OR ${odsProviderCalls.outcome} <> 'not_sent')`,
        exclude ? sql`NOT (${odsProviderCalls.syncTaskId} = ${exclude.syncTaskId} AND ${odsProviderCalls.attemptNo} = ${exclude.attemptNo} AND ${odsProviderCalls.callSequence} = ${exclude.callSequence})` : undefined,
      ),
    )
    .groupBy(odsProviderCalls.requestedAction, odsProviderCalls.outcome, platforms.platformCode);
  let points = 0;
  for (const r of rows) {
    if (r.action === "task_lookup") continue;
    const billable = r.outcome === null || r.outcome === "succeeded" || r.outcome === "ambiguous" || r.outcome === "reconciled_succeeded";
    if (billable) points += r.n * pointsOf(r.platform ?? "", r.action);
  }
  return points;
}
const YEAR_MS = 365 * 24 * 3600_000;
export interface YearBudget {
  maxPoints: number;
  now?: () => Date;
}
export function createBatchBudgetPolicy(db: Db, limits: BatchBudgetLimits, year?: YearBudget): SendPolicy {
  // ponytail: 每次检查都聚合最近 365 天的调用（走 prepared_at 索引），与批次口径一样每次现算；年调用量在十万量级时每次几十毫秒，QPS≈2 可以接受。
  // 调用量到百万级后改成进程内累计值并定期校准。
  const now = year?.now ?? (() => new Date());
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
      if (year && (await spentInWindow(db, new Date(now().getTime() - YEAR_MS), ctx)) + pointsOf(task.platform, ctx.requestedAction) > year.maxPoints) return "year_budget";
      return null;
    },
  };
}
