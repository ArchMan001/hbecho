// 给 D / E 的只读契约（requirements AP-13）：D 在执行时锁定名单并保存快照。
// 只含「在名单」项，移出后立即消失；计划非采集中（暂停 / 归档）也可读取（暂停期间可手动判定）；回收站里的计划不可读。
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { activityPlanRoster, activityPlans } from "../../db/schema";
import type { MonitoringResolver } from "../monitoring";

export interface RosterSnapshotEntry {
  staffId: string;
  storeId: string;
  branchId: string;
  accountId: string;
  /** 实际监控 = 开关开 ∧ 上级链有效 ∧ 录入状态正常（monitoring.targets 的口径） */
  effectiveMonitoring: boolean;
}
export interface RosterSnapshot {
  planId: string;
  status: string;
  entries: RosterSnapshotEntry[];
}

export function createPlanReader(deps: { db: Db; resolver: MonitoringResolver }) {
  const { db, resolver } = deps;
  /** 计划不存在或已删除（回收站）返回 null。 */
  async function rosterSnapshot(planId: bigint): Promise<RosterSnapshot | null> {
    const [plan] = await db.select({ status: activityPlans.status }).from(activityPlans).where(eq(activityPlans.planId, planId));
    if (!plan || plan.status === "deleted") return null;
    const rows = await db
      .select({ staffId: activityPlanRoster.staffId, storeId: activityPlanRoster.storeId, branchId: activityPlanRoster.branchId, accountId: activityPlanRoster.accountId })
      .from(activityPlanRoster)
      .where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.entryState, "in_roster")))
      .orderBy(asc(activityPlanRoster.accountId));
    const effective = new Set<bigint>();
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((r) => r.accountId);
      for (const t of (await resolver.targets({ afterAccountId: null, limit: ids.length, accountIds: ids })).rows) effective.add(t.accountId);
    }
    return {
      planId: planId.toString(),
      status: plan.status,
      entries: rows.map((r) => ({ staffId: r.staffId.toString(), storeId: r.storeId.toString(), branchId: r.branchId.toString(), accountId: r.accountId.toString(), effectiveMonitoring: effective.has(r.accountId) })),
    };
  }
  /** D / E 对账用：计划当前状态（真相是 activity_plans.status，onDeleted / onRestored 只是加速通知）。 */
  async function statusOf(planId: bigint): Promise<string | null> {
    const [plan] = await db.select({ status: activityPlans.status }).from(activityPlans).where(eq(activityPlans.planId, planId));
    return plan?.status ?? null;
  }
  return { rosterSnapshot, statusOf };
}
export type PlanReader = ReturnType<typeof createPlanReader>;
