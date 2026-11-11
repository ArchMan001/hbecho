// 引用计数与监控联动的唯一实现（design §7.7、AP-11）。所有联动事件走 reconcileAccounts，各命令不自己判断。
// 全仓库只有本目录写 staff_account_assignments.unreferenced_since，也只有本目录写 monitoring_closed_reason='unreferenced_15d'
// （静态护栏见 acceptance-boundaries.test.ts）。上级开关（分公司 / 经销商 / 门店 / 专员）不读不写。
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { activityPlanRoster, activityPlans, staffAccountAssignments as aa } from "../../db/schema";
import type { PlanAuditEvent } from "../activity-plan/audit";
import { PlanError } from "../activity-plan/errors";
import { bjtDate, entryStopAt, EVENTS, UNREFERENCED_MS, type ReconcileEvent } from "./rules";

/** 单次重算的账号上限（AP-D19）；超过需要分块与 reconcile_pending，现在不需要。 */
export const MAX_RECONCILE_ACCOUNTS = 10_000;
const SERVICE_ACTOR = "service:plan-worker";

export type ReconcileCtx = ReconcileEvent & { now: Date; actor?: string };
export interface ReconcileReport {
  examined: number;
  skipped: number;
  /** 因无引用关闭（原因 unreferenced_15d） */
  closed: bigint[];
  /** 引用恢复，因无引用关闭的账号重开 */
  reopened: bigint[];
  /** 名单导入重开了人工关闭的账号（已接受风险，必须留审计） */
  reopenedByImport: bigint[];
  /** 新记下无引用起点的账号 */
  graceMarked: bigint[];
  /** 事务提交之后由调用方交给审计出口；事务回滚时不应发出 */
  events: PlanAuditEvent[];
}

const idsOf = (rows: Array<{ accountId: bigint }>): Set<bigint> => new Set(rows.map((r) => r.accountId));

/** 账号当前被多少个计划引用（design §7.7）。 */
export async function referenceCount(tx: DbTx, accountId: bigint, now: Date): Promise<number> {
  return (await refCounts(tx, [accountId], bjtDate(now))).get(accountId) ?? 0;
}

async function refCounts(tx: DbTx, ids: bigint[], today: string): Promise<Map<bigint, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ accountId: activityPlanRoster.accountId, n: sql<string>`COUNT(*)` })
    .from(activityPlanRoster)
    .innerJoin(activityPlans, eq(activityPlans.planId, activityPlanRoster.planId))
    .where(
      and(
        inArray(activityPlanRoster.accountId, ids),
        eq(activityPlanRoster.entryState, "in_roster"),
        eq(activityPlans.status, "collecting"),
        sql`(${activityPlans.endsOn} IS NULL OR ${activityPlans.endsOn} >= ${today})`,
      ),
    )
    .groupBy(activityPlanRoster.accountId);
  return new Map(rows.map((r) => [r.accountId, Number(r.n)]));
}

/** 账号「不再被引用」的时刻：全部名单项（含已移出）各自的最早原因里取最晚的一个；没有名单项取 now。 */
export async function computeStopAt(tx: DbTx, accountId: bigint, now: Date): Promise<Date> {
  return (await stopAts(tx, [accountId], now)).get(accountId) ?? now;
}

async function stopAts(tx: DbTx, ids: bigint[], now: Date): Promise<Map<bigint, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      accountId: activityPlanRoster.accountId,
      entryState: activityPlanRoster.entryState,
      removedAt: activityPlanRoster.removedAt,
      status: activityPlans.status,
      endsOn: activityPlans.endsOn,
      statusChangedAt: activityPlans.statusChangedAt,
      deletedAt: activityPlans.deletedAt,
    })
    .from(activityPlanRoster)
    .innerJoin(activityPlans, eq(activityPlans.planId, activityPlanRoster.planId))
    .where(inArray(activityPlanRoster.accountId, ids));
  const out = new Map<bigint, Date>();
  for (const r of rows) {
    const stop = entryStopAt(r, r, now);
    if (!stop) continue;
    const prev = out.get(r.accountId);
    if (!prev || stop.getTime() > prev.getTime()) out.set(r.accountId, stop);
  }
  return out;
}

/**
 * 对一组账号按事件重算监控联动。幂等：同一事件重复调用，状态与审计都不重复变化。
 * 调用方在同一事务里调用；返回的 events 在事务提交后交给审计出口。
 */
export async function reconcileAccounts(tx: DbTx, accountIds: readonly bigint[], ctx: ReconcileCtx): Promise<ReconcileReport> {
  const ids = [...new Set(accountIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 升序加锁，避免死锁
  if (ids.length > MAX_RECONCILE_ACCOUNTS) {
    throw new PlanError("limit", "reconcile_too_large", `单次引用重算最多 ${MAX_RECONCILE_ACCOUNTS} 个账号（当前 ${ids.length}）`);
  }
  const report: ReconcileReport = { examined: ids.length, skipped: 0, closed: [], reopened: [], reopenedByImport: [], graceMarked: [], events: [] };
  if (ids.length === 0) return report;
  const { now } = ctx;
  const actor = ctx.actor ?? SERVICE_ACTOR;
  const locked = await tx
    .select({
      accountId: aa.accountId,
      watchType: aa.watchType,
      enabled: aa.monitoringEnabled,
      reason: aa.monitoringClosedReason,
      since: aa.unreferencedSince,
    })
    .from(aa)
    .where(inArray(aa.accountId, ids))
    .orderBy(asc(aa.accountId))
    .for("update");
  const ever = idsOf(await tx.selectDistinct({ accountId: activityPlanRoster.accountId }).from(activityPlanRoster).where(inArray(activityPlanRoster.accountId, ids)));
  const refs = await refCounts(tx, ids, bjtDate(now));
  const needStop = ctx.since === "stop_at" ? locked.filter((r) => (refs.get(r.accountId) ?? 0) === 0).map((r) => r.accountId) : [];
  const stops = await stopAts(tx, needStop, now);

  const event = (type: PlanAuditEvent["event_type"], accountId: bigint, extra: Partial<PlanAuditEvent> = {}): void => {
    report.events.push({ event_type: type, actor, occurred_at: now.toISOString(), reason_code: ctx.trigger, target_type: "account", target_id: accountId.toString(), ...extra });
  };
  const seen = new Set<bigint>();
  for (const a of locked) {
    seen.add(a.accountId);
    // 外部监控账号不参与引用计数；从未入过名单的账号（tracer / 运维直接提交）不受 15 天规则影响，名单导入除外
    if (a.watchType !== "staff" || (!ever.has(a.accountId) && ctx.trigger !== "import")) {
      report.skipped++;
      continue;
    }
    const n = refs.get(a.accountId) ?? 0;
    const set: Partial<typeof aa.$inferInsert> = {};
    if (n > 0) {
      if (a.since !== null) set.unreferencedSince = null;
      if (!a.enabled && a.reason === "unreferenced_15d") {
        set.monitoringEnabled = true;
        set.monitoringClosedReason = null;
        report.reopened.push(a.accountId);
        event("monitoring_reopened_on_reference", a.accountId, { before: { monitoring_enabled: false, closed_reason: "unreferenced_15d" }, after: { monitoring_enabled: true } });
      } else if (!a.enabled && a.reason === "manual" && ctx.trigger === "import") {
        // 已接受风险（R4-01）：名单导入重开被人工关闭的账号，每次都写审计让它可见
        set.monitoringEnabled = true;
        set.monitoringClosedReason = null;
        report.reopenedByImport.push(a.accountId);
        event("monitoring_reopened_by_import", a.accountId, { before: { monitoring_enabled: false, closed_reason: "manual" }, after: { monitoring_enabled: true } });
      }
    } else {
      let since = a.since;
      if (ctx.resetSince || since === null) {
        since = ctx.since === "stop_at" ? (stops.get(a.accountId) ?? now) : now;
        set.unreferencedSince = since;
        report.graceMarked.push(a.accountId);
      }
      if (a.enabled && (ctx.mode === "immediate" || since.getTime() + UNREFERENCED_MS <= now.getTime())) {
        set.monitoringEnabled = false;
        set.monitoringClosedReason = "unreferenced_15d";
        report.closed.push(a.accountId);
        event("monitoring_closed_unreferenced", a.accountId, { before: { monitoring_enabled: true }, after: { monitoring_enabled: false, closed_reason: "unreferenced_15d" }, counts: { unreferenced_since: since.toISOString() } });
      }
    }
    if (Object.keys(set).length > 0) await tx.update(aa).set({ ...set, updatedAt: now }).where(eq(aa.accountId, a.accountId));
  }
  report.skipped += ids.filter((id) => !seen.has(id)).length; // 没有归属行的账号
  return report;
}

/**
 * 运维手动开启账号后调用：引用为 0 且出现过名单项的账号，把无引用起点重置为现在，给 15 天宽限，
 * 避免下一次扫描立即把它关回去。其余情况不改任何东西。
 */
export async function markGrace(tx: DbTx, accountId: bigint, now: Date, actor?: string): Promise<ReconcileReport> {
  return reconcileAccounts(tx, [accountId], { ...EVENTS.manualEnable, now, ...(actor ? { actor } : {}) });
}
