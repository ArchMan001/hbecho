// 名单维护（requirements AP-10）：移出、疑似空账号人工确认。
// 恢复不是独立命令：重新提交对应账号的行（预检类 update），走预检 / 确认的 update 路径。
// 名单项永不物理删除；移出后立即按引用计数重算账号监控（EVENTS.removed）。
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { activityPlanRoster, brands, externalAccounts, mediaStaff, sectors, staffAccountAssignments as aa, stores } from "../../../db/schema";
import { bjtDate, EVENTS, reconcileAccounts } from "../../plan-references";
import type { Clock } from "../../raw-capture";
import type { PlanAuditEvent, PlanAuditSink } from "../audit";
import { assert, brandInScope, branchInScope, CAP_ACCOUNT_MANAGE, CAP_PLAN_JOIN, type PlanActor } from "../authz";
import { recordChange } from "../changes";
import { PlanError } from "../errors";
import { assertCollecting } from "../plans";
import { loadPlanFor } from "../visibility";

export interface RemoveInput {
  planId: bigint;
  accountIds?: readonly bigint[];
  staffIds?: readonly bigint[];
  apply?: boolean;
}
export type RemoveResult =
  | { kind: "preview"; entries: number; accountsToClose: number; apply: false }
  | { kind: "applied"; entries: number; accountsClosed: number }
  | { kind: "noop"; entries: 0 };

export function createRosterMaintenance(deps: { db: Db; clock: Clock; audit: PlanAuditSink }) {
  const { db, clock, audit } = deps;

  /**
   * 移出名单项：按账号或按专员，单条或批量。仅采集中；分公司只能移出自己分公司的项（越范围的任何一项都使整条命令被拒，零写入）；
   * 总部 / 超管按授权品牌。默认只预览，apply 才写。
   */
  async function remove(actor: PlanActor, input: RemoveInput): Promise<RemoveResult> {
    assert(actor, CAP_PLAN_JOIN);
    if ((input.accountIds?.length ?? 0) + (input.staffIds?.length ?? 0) === 0) throw new PlanError("input", "nothing_selected", "请指定要移出的账号或专员");
    const now = clock.now();
    const events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx): Promise<RemoveResult> => {
      const plan = await loadPlanFor(tx, actor, CAP_PLAN_JOIN, input.planId, { lock: "share" });
      assertCollecting(plan);
      const sel = [
        ...(input.accountIds?.length ? [inArray(activityPlanRoster.accountId, [...input.accountIds])] : []),
        ...(input.staffIds?.length ? [inArray(activityPlanRoster.staffId, [...input.staffIds])] : []),
      ];
      const entries = await tx
        .select({ id: activityPlanRoster.rosterEntryId, accountId: activityPlanRoster.accountId, staffId: activityPlanRoster.staffId, branchId: activityPlanRoster.branchId, state: activityPlanRoster.entryState })
        .from(activityPlanRoster)
        .where(and(eq(activityPlanRoster.planId, input.planId), sql`(${sql.join(sel, sql` OR `)})`))
        .for(input.apply ? "update" : "share");
      const out = entries.filter((e) => !branchInScope(actor, e.branchId));
      if (out.length > 0) throw new PlanError("authorization", "branch_out_of_scope", "所选名单里有其他分公司的项，不能移出", { count: out.length });
      const live = entries.filter((e) => e.state === "in_roster");
      if (live.length === 0) return { kind: "noop", entries: 0 };
      const accountIds = live.map((e) => e.accountId);
      if (!input.apply) {
        const [res] = await tx.execute(sql`
          SELECT COUNT(*) AS n FROM staff_account_assignments a
          WHERE a.watch_type = 'staff' AND a.monitoring_enabled = 1 AND a.account_id IN (${sql.join(accountIds.map((i) => sql`${i}`), sql`, `)})
            AND NOT EXISTS (SELECT 1 FROM activity_plan_roster r JOIN activity_plans p ON p.plan_id = r.plan_id
              WHERE r.account_id = a.account_id AND r.entry_state = 'in_roster' AND p.status = 'collecting' AND (p.ends_on IS NULL OR p.ends_on >= ${bjtDate(now)}) AND r.plan_id <> ${input.planId})`);
        return { kind: "preview", entries: live.length, accountsToClose: Number((res as unknown as Array<{ n: number | string }>)[0]?.n ?? 0), apply: false };
      }
      await tx
        .update(activityPlanRoster)
        .set({ entryState: "removed", removedAt: now, removedByActor: actor.actor, removedReason: "manual_remove", updatedAt: now })
        .where(inArray(activityPlanRoster.rosterEntryId, live.map((e) => e.id)));
      const report = await reconcileAccounts(tx, accountIds, { ...EVENTS.removed, now, actor: actor.actor });
      await recordChange(tx, { planId: input.planId, eventType: "roster_entries_removed", actor: actor.actor, now, detail: { entries: live.length, accounts_closed: report.closed.length } });
      for (const e of live) {
        events.push({ event_type: "roster_entry_removed", actor: actor.actor, occurred_at: now.toISOString(), plan_id: input.planId.toString(), target_type: "account", target_id: e.accountId.toString(), reason_code: "manual_remove", before: { entry_state: "in_roster" }, after: { entry_state: "removed" } });
      }
      events.push(...report.events);
      return { kind: "applied", entries: live.length, accountsClosed: report.closed.length };
    });
    events.forEach((e) => audit(e));
    return out;
  }

  /** 疑似空账号人工确认：intake_status 由 suspected_empty 改为 normal，之后进入常规采集。 */
  async function confirmEmpty(actor: PlanActor, accountId: bigint): Promise<{ accountId: string; intakeStatus: "normal" }> {
    assert(actor, CAP_ACCOUNT_MANAGE);
    const now = clock.now();
    const [a] = await db
      .select({ intake: aa.intakeStatus, watchType: aa.watchType, branchId: sectors.branchId, brandCode: brands.brandCode, status: externalAccounts.status })
      .from(aa)
      .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
      .leftJoin(mediaStaff, eq(mediaStaff.staffId, aa.staffId))
      .leftJoin(stores, eq(stores.storeId, mediaStaff.storeId))
      .leftJoin(sectors, eq(sectors.sectorId, stores.sectorId))
      .leftJoin(brands, eq(brands.brandId, stores.brandId))
      .where(eq(aa.accountId, accountId));
    // 范围外 / 外部监控账号（没有分公司）/ 不存在：一律未找到，零写入
    if (!a || a.branchId === null || a.brandCode === null || !branchInScope(actor, a.branchId) || !brandInScope(actor, a.brandCode)) throw new PlanError("not_found", "not_found", "未找到");
    if (a.intake !== "suspected_empty") throw new PlanError("conflict", "not_suspected_empty", "该账号不是疑似空账号");
    await db.transaction(async (tx) => {
      const res = await tx.update(aa).set({ intakeStatus: "normal", updatedAt: now }).where(and(eq(aa.accountId, accountId), eq(aa.intakeStatus, "suspected_empty")));
      if (res[0].affectedRows === 0) throw new PlanError("conflict", "not_suspected_empty", "该账号不是疑似空账号");
    });
    audit({ event_type: "suspected_empty_confirmed", actor: actor.actor, occurred_at: now.toISOString(), target_type: "account", target_id: accountId.toString(), before: { intake_status: "suspected_empty" }, after: { intake_status: "normal" } });
    return { accountId: accountId.toString(), intakeStatus: "normal" };
  }

  return { remove, confirmEmpty };
}
export type RosterMaintenance = ReturnType<typeof createRosterMaintenance>;
