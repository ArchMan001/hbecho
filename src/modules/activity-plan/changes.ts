// 变更记录（activity_plan_changes）：页面「变更记录」标签的业务视图，与审计日志并存，随计划一起清除。
// detail 只放关键字段，不放整行原文或文件内容。
import type { Db, DbTx } from "../../db/client";
import { activityPlanChanges } from "../../db/schema";

export async function recordChange(
  tx: Db | DbTx,
  c: { planId: bigint; branchId?: bigint | null; eventType: string; actor: string; now: Date; detail?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityPlanChanges).values({
    planId: c.planId,
    branchId: c.branchId ?? null,
    eventType: c.eventType,
    actor: c.actor,
    occurredAt: c.now,
    detail: c.detail ?? null,
  });
}
