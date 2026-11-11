// 计划每日维护（requirements AP-12；design §7.8）：两步各自独立失败、独立重试。
//   1. scan_unreferenced：出现过名单项、引用数为 0、监控开关开启的归属型账号 —— 缺无引用起点的补记（取 computeStopAt），起点满 15 天的关闭。
//   2. purge_trash：删除满 30 天的计划 —— 先在事务之外调下游 purge（幂等），成功后再在一个事务里按 FK 顺序显式 DELETE（不是级联）；
//      下游失败则本次不清除、计划行保留，下次重试。导入批次 / 行结果、账号、归属、专员、门店不动。
// 不依赖 OSS：与 createMaintenance（ODS 清理）分开，后者没有 OSS 配置就整体禁用，不能连带禁用 15 天停采（AP-D15）。
// 北京时间 04:00 之后每天一次；失败退避后重试；进程重启当天可能再跑一次，两步幂等所以无副作用。
import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { activityPlanBranches, activityPlanChanges, activityPlanOwners, activityPlanRoster, activityPlanSectors, activityPlans } from "../../db/schema";
import { bjtDate, EVENTS, reconcileAccounts } from "../plan-references";
import type { Clock } from "../raw-capture";
import type { PlanAuditEvent, PlanAuditSink } from "./audit";
import { MAINTENANCE_HOUR_BJT } from "./constants";
import type { PlanDownstream } from "./downstream";

export const SERVICE_ACTOR = "service:plan-worker";
const HOUR = 3_600_000;
const BEIJING_OFFSET = 8 * HOUR;

export interface MaintenanceReport {
  ran: boolean;
  /** ran=false 时的原因 */
  skipped?: "not_due" | "already_done" | "backoff";
  graceMarked: number;
  closed: number;
  purged: number;
  failedSteps: string[];
  /** 下游 purge 失败的计划（保留，下次重试） */
  purgeFailed: string[];
}
export interface PlanMaintenanceDeps {
  db: Db;
  clock: Clock;
  downstream: PlanDownstream;
  audit: PlanAuditSink;
  /** 每块账号数（默认 500） */
  chunkSize?: number;
  /** 失败退避（默认 10 分钟） */
  backoffMs?: number;
  /** 仅测试：模拟步骤抛错 / 崩溃在下游 purge 与数据库清除之间 */
  hooks?: { beforeScan?: () => void | Promise<void>; afterDownstreamPurge?: (planId: bigint) => void | Promise<void> };
}

export function createPlanMaintenance(deps: PlanMaintenanceDeps) {
  const { db, clock, downstream, audit } = deps;
  const chunkSize = deps.chunkSize ?? 500;
  const backoffMs = deps.backoffMs ?? 10 * 60_000;
  let lastDoneDay: string | null = null;
  let lastFailedAt: number | null = null;

  const emit = (events: PlanAuditEvent[]): void => events.forEach((e) => audit(e));

  /** 候选：出现过名单项、当前没有任何有效引用、开关仍开着的归属型账号（按账号升序分块）。 */
  async function candidates(after: bigint | null, today: string): Promise<bigint[]> {
    const rows = await db.execute(sql`
      SELECT a.account_id AS id FROM staff_account_assignments a
      WHERE a.watch_type = 'staff' AND a.monitoring_enabled = 1
        ${after === null ? sql`` : sql`AND a.account_id > ${after}`}
        AND EXISTS (SELECT 1 FROM activity_plan_roster r WHERE r.account_id = a.account_id)
        AND NOT EXISTS (
          SELECT 1 FROM activity_plan_roster r JOIN activity_plans p ON p.plan_id = r.plan_id
          WHERE r.account_id = a.account_id AND r.entry_state = 'in_roster' AND p.status = 'collecting' AND (p.ends_on IS NULL OR p.ends_on >= ${today}))
      ORDER BY a.account_id LIMIT ${chunkSize}`);
    return (rows[0] as unknown as Array<{ id: string | number | bigint }>).map((r) => BigInt(r.id));
  }

  async function scanUnreferenced(now: Date, rep: MaintenanceReport): Promise<void> {
    await deps.hooks?.beforeScan?.();
    const today = bjtDate(now);
    for (let after: bigint | null = null; ; ) {
      const ids = await candidates(after, today);
      if (ids.length === 0) break;
      const report = await db.transaction((tx) => reconcileAccounts(tx, ids, { ...EVENTS.dailyScan, now, actor: SERVICE_ACTOR }));
      emit(report.events);
      rep.graceMarked += report.graceMarked.length;
      rep.closed += report.closed.length;
      after = ids[ids.length - 1]!;
      if (ids.length < chunkSize) break;
    }
  }

  async function purgeTrash(now: Date, rep: MaintenanceReport): Promise<void> {
    const due = await db.select({ planId: activityPlans.planId }).from(activityPlans).where(and(eq(activityPlans.status, "deleted"), lte(activityPlans.purgeAfter, now))).orderBy(activityPlans.planId);
    for (const { planId } of due) {
      try {
        await downstream.purge(planId); // 事务之外：可能是跨域调用，不得持有数据库事务；幂等
      } catch (e) {
        rep.purgeFailed.push(planId.toString());
        audit({ event_type: "downstream_notify_failed", actor: SERVICE_ACTOR, occurred_at: now.toISOString(), plan_id: planId.toString(), reason_code: "purge", counts: { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" } });
        continue;
      }
      await deps.hooks?.afterDownstreamPurge?.(planId);
      const done = await db.transaction(async (tx) => {
        // 复核：期间被恢复 / 状态变化则不删
        const [p] = await tx.select().from(activityPlans).where(eq(activityPlans.planId, planId)).for("update");
        if (!p || p.status !== "deleted" || !p.purgeAfter || p.purgeAfter.getTime() > now.getTime()) return null;
        // 显式 DELETE，按 FK 顺序：变更记录 → 名单项 → 负责人 → 参与关系 → 板块 → 计划（不是级联）
        await tx.delete(activityPlanChanges).where(eq(activityPlanChanges.planId, planId));
        const roster = (await tx.delete(activityPlanRoster).where(eq(activityPlanRoster.planId, planId)))[0].affectedRows;
        const owners = (await tx.delete(activityPlanOwners).where(eq(activityPlanOwners.planId, planId)))[0].affectedRows;
        const branches = (await tx.delete(activityPlanBranches).where(eq(activityPlanBranches.planId, planId)))[0].affectedRows;
        const sectors = (await tx.delete(activityPlanSectors).where(eq(activityPlanSectors.planId, planId)))[0].affectedRows;
        await tx.delete(activityPlans).where(eq(activityPlans.planId, planId));
        return { name: p.planName, counts: { roster, owners, branches, sectors } };
      });
      if (done) {
        rep.purged++;
        audit({ event_type: "plan_purged", actor: SERVICE_ACTOR, occurred_at: now.toISOString(), plan_id: planId.toString(), target_type: "plan", target_id: planId.toString(), target_code: done.name, counts: done.counts });
      }
    }
    if (rep.purgeFailed.length > 0) rep.failedSteps.push("purge_trash");
  }

  /** 立即跑一轮两步（手动命令与测试）；每步各自 try/catch，一步失败不影响另一步。 */
  async function runNow(): Promise<MaintenanceReport> {
    const now = clock.now();
    const rep: MaintenanceReport = { ran: true, graceMarked: 0, closed: 0, purged: 0, failedSteps: [], purgeFailed: [] };
    for (const [name, step] of [["scan_unreferenced", scanUnreferenced], ["purge_trash", purgeTrash]] as const) {
      try {
        await step(now, rep);
      } catch (e) {
        if (!rep.failedSteps.includes(name)) rep.failedSteps.push(name);
        audit({ event_type: "plan_maintenance_completed", actor: SERVICE_ACTOR, occurred_at: now.toISOString(), reason_code: `${name}_failed`, counts: { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" } });
      }
    }
    audit({ event_type: "plan_maintenance_completed", actor: SERVICE_ACTOR, occurred_at: now.toISOString(), counts: { grace_marked: rep.graceMarked, closed: rep.closed, purged: rep.purged, failed_steps: rep.failedSteps.length } });
    return rep;
  }

  /** 每次 tick 后调用：北京时间 04:00 之后每天一次；当日已成功不重复；失败退避。 */
  async function runDaily(): Promise<MaintenanceReport> {
    const now = clock.now();
    const skip = (skipped: NonNullable<MaintenanceReport["skipped"]>): MaintenanceReport => ({ ran: false, skipped, graceMarked: 0, closed: 0, purged: 0, failedSteps: [], purgeFailed: [] });
    const bjtHour = new Date(now.getTime() + BEIJING_OFFSET).getUTCHours();
    if (bjtHour < MAINTENANCE_HOUR_BJT) return skip("not_due");
    if (lastDoneDay === bjtDate(now)) return skip("already_done");
    if (lastFailedAt !== null && now.getTime() - lastFailedAt < backoffMs) return skip("backoff");
    const rep = await runNow();
    if (rep.failedSteps.length === 0) {
      lastDoneDay = bjtDate(now);
      lastFailedAt = null;
    } else {
      lastFailedAt = now.getTime();
    }
    return rep;
  }

  return { runDaily, runNow };
}
export type PlanMaintenance = ReturnType<typeof createPlanMaintenance>;
