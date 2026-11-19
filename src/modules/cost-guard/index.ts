// 调用 / 轮询 / 点数的硬上限与成本估算（design §15.2、R17）。达到上限在下一次调用**前**封口，不是调用后告警。
// 点数表取自 A §6.2 / 计费点数表.md（抖音：主页 10、列表 10/页、详情 10/条、评论 5/页；小红书：均为 15；快手：主页 10、列表 10/页、详情 10/条，评论不支持）；
// 失败、超时、429 与异步轮询不计点；
// 单价 0.01 元/点（1 元 = 100 点；2026-11-19 刘学奎订正，原写 0.02）。QPS 未知。
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { odsProviderCalls, platforms, syncTasks } from "../../db/schema";
import type { PolicyContext, SendPolicy } from "../raw-capture";

export const POINTS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  douyin: Object.freeze({ media_user_info: 10, user_video_list: 10, media_stats_number: 10, post_comments_list: 5 }),
  xiaohongshu: Object.freeze({ media_user_info: 15, user_video_list: 15, media_stats_number: 15, post_comments_list: 15 }),
  // 快手评论不支持：不登记，pointsOf 为 0 只是「没有价目」，真正的拒绝在 capability 门控（D-51）
  kuaishou: Object.freeze({ media_user_info: 10, user_video_list: 10, media_stats_number: 10 }),
});
export const YUAN_PER_POINT = 0.01; // 1 元 = 100 点（2026-11-19 刘学奎订正，原写 0.02）

/** 未登记的平台 / action（例如轮询 task_lookup）不计点。 */
export const pointsOf = (platformCode: string, action: string): number => POINTS[platformCode]?.[action] ?? 0;

export interface BudgetLimits {
  /** 非轮询的供应商调用数上限（含重试与 ambiguous 重发）。 */
  maxCalls?: number;
  maxPolls?: number;
  maxPoints?: number;
}

export interface Spent {
  calls: number;
  polls: number;
  points: number;
}

/** 一个 root（含全部子任务）到目前为止已经发出的调用与估算点数；只数确实发出的调用（不含 prepared、not_sent）。 */
export async function spentFor(db: Db, anyTaskIdOfRoot: bigint): Promise<Spent> {
  const [task] = await db.select().from(syncTasks).where(eq(syncTasks.taskId, anyTaskIdOfRoot));
  if (!task) return { calls: 0, polls: 0, points: 0 };
  const rootId = task.parentTaskId ?? task.taskId;
  const family = (await db.select({ id: syncTasks.taskId }).from(syncTasks).where(or(eq(syncTasks.taskId, rootId), eq(syncTasks.parentTaskId, rootId)))).map((r) => r.id);
  const rows = await db
    .select({ action: odsProviderCalls.requestedAction, status: odsProviderCalls.callStatus, outcome: odsProviderCalls.outcome, platform: platforms.platformCode })
    .from(odsProviderCalls)
    .leftJoin(platforms, eq(platforms.platformId, odsProviderCalls.platformId))
    .where(and(inArray(odsProviderCalls.syncTaskId, family), ne(odsProviderCalls.callStatus, "prepared")));
  const sent = rows.filter((r) => r.outcome !== "not_sent");
  return {
    calls: sent.filter((r) => r.action !== "task_lookup").length,
    polls: sent.filter((r) => r.action === "task_lookup").length,
    points: sent.filter((r) => r.outcome === "succeeded").reduce((n, r) => n + pointsOf(r.platform ?? "", r.action), 0),
  };
}

export function createBudgetPolicy(db: Db, limits: BudgetLimits): SendPolicy {
  return {
    async check(ctx: PolicyContext) {
      const spent = await spentFor(db, ctx.syncTaskId);
      if (ctx.requestedAction === "task_lookup") return limits.maxPolls !== undefined && spent.polls >= limits.maxPolls ? "poll_budget" : null;
      if (limits.maxCalls !== undefined && spent.calls >= limits.maxCalls) return "call_budget";
      if (limits.maxPoints !== undefined) {
        const [task] = await db.select({ platform: platforms.platformCode }).from(syncTasks).innerJoin(platforms, eq(platforms.platformId, syncTasks.platformId)).where(eq(syncTasks.taskId, ctx.syncTaskId));
        if (spent.points + pointsOf(task?.platform ?? "", ctx.requestedAction) > limits.maxPoints) return "points_budget";
      }
      return null;
    },
  };
}
