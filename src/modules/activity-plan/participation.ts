// 分公司参与（requirements AP-3；design §5.1）：加入、退出、重新加入。
// 退出在一个事务里：参与关系置 exited → 该分公司全部「在名单」项置 removed(branch_exit) → 释放全部名额 → 立即重算引用。
// 重新加入只恢复参与关系，名单项保持 removed，直到该分公司重新提交到对应账号（走名单导入的 update 路径）。
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { activityPlanBranches, activityPlanRoster, branches } from "../../db/schema";
import { bjtDate, EVENTS, reconcileAccounts } from "../plan-references";
import type { Clock } from "../raw-capture";
import type { PlanAuditEvent, PlanAuditSink } from "./audit";
import { assert, CAP_PLAN_JOIN, type PlanActor } from "./authz";
import { recordChange } from "./changes";
import { PlanError } from "./errors";
import { ownersOf, releaseAll } from "./owners";
import { assertCollecting } from "./plans";
import { loadPlanFor } from "./visibility";

export function createParticipation(deps: { db: Db; clock: Clock; audit: PlanAuditSink }) {
  const { db, clock, audit } = deps;

  async function join(actor: PlanActor, planId: bigint, branchId: bigint): Promise<{ kind: "joined" | "rejoined" | "noop"; branchId: string }> {
    assert(actor, CAP_PLAN_JOIN, { branchId });
    const now = clock.now();
    const events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx) => {
      const plan = await loadPlanFor(tx, actor, CAP_PLAN_JOIN, planId, { lock: "share" });
      assertCollecting(plan);
      const [br] = await tx.select().from(branches).where(eq(branches.branchId, branchId));
      if (!br) throw new PlanError("not_found", "branch_not_found", "分公司不存在");
      if (br.status !== "active") throw new PlanError("input", "branch_inactive", "分公司已停用");
      const [cur] = await tx.select().from(activityPlanBranches).where(and(eq(activityPlanBranches.planId, planId), eq(activityPlanBranches.branchId, branchId))).for("update");
      if (cur?.status === "joined") return { kind: "noop" as const, branchId: branchId.toString() };
      if (cur) await tx.update(activityPlanBranches).set({ status: "joined", joinedAt: now, joinedByActor: actor.actor, exitedAt: null, exitedByActor: null, updatedAt: now }).where(and(eq(activityPlanBranches.planId, planId), eq(activityPlanBranches.branchId, branchId)));
      else await tx.insert(activityPlanBranches).values({ planId, branchId, status: "joined", joinedAt: now, joinedByActor: actor.actor, updatedAt: now });
      await recordChange(tx, { planId, branchId, eventType: "branch_joined", actor: actor.actor, now, detail: { rejoin: !!cur } });
      events.push({ event_type: "branch_joined", actor: actor.actor, occurred_at: now.toISOString(), plan_id: planId.toString(), target_type: "branch", target_id: branchId.toString(), target_code: br.branchCode, after: { rejoin: !!cur } });
      return { kind: cur ? ("rejoined" as const) : ("joined" as const), branchId: branchId.toString() };
    });
    events.forEach((e) => audit(e));
    return out;
  }

  type ExitResult =
    | { kind: "preview"; branchId: string; rosterEntries: number; owners: string[]; accountsToClose: number; apply: false }
    | { kind: "applied"; branchId: string; rosterEntries: number; releasedOwners: string[]; accountsClosed: number };
  async function exit(actor: PlanActor, planId: bigint, branchId: bigint, o: { apply?: boolean } = {}): Promise<ExitResult> {
    assert(actor, CAP_PLAN_JOIN, { branchId });
    const now = clock.now();
    const events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx) => {
      const plan = await loadPlanFor(tx, actor, CAP_PLAN_JOIN, planId, { lock: "share" });
      assertCollecting(plan);
      const [cur] = await tx.select().from(activityPlanBranches).where(and(eq(activityPlanBranches.planId, planId), eq(activityPlanBranches.branchId, branchId))).for("update");
      if (!cur || cur.status !== "joined") throw new PlanError("conflict", "branch_not_joined", "该分公司没有参加这个计划");
      const entries = await tx.select({ id: activityPlanRoster.rosterEntryId, accountId: activityPlanRoster.accountId }).from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.branchId, branchId), eq(activityPlanRoster.entryState, "in_roster")));
      const owners = await ownersOf(tx, planId, branchId);
      if (!o.apply) {
        const ids = entries.map((e) => e.accountId);
        const [res] = ids.length === 0 ? [[{ n: 0 }]] : await tx.execute(sql`
          SELECT COUNT(*) AS n FROM staff_account_assignments a
          WHERE a.watch_type = 'staff' AND a.monitoring_enabled = 1 AND a.account_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
            AND NOT EXISTS (SELECT 1 FROM activity_plan_roster r JOIN activity_plans p ON p.plan_id = r.plan_id
              WHERE r.account_id = a.account_id AND r.entry_state = 'in_roster' AND p.status = 'collecting' AND (p.ends_on IS NULL OR p.ends_on >= ${bjtDate(now)})
                AND r.plan_id <> ${planId})`);
        return { kind: "preview" as const, branchId: branchId.toString(), rosterEntries: entries.length, owners: owners.map((x) => x.ownerDisplayName ?? x.ownerActor), accountsToClose: Number((res as unknown as Array<{ n: number | string }>)[0]?.n ?? 0), apply: false as const };
      }
      await tx.update(activityPlanBranches).set({ status: "exited", exitedAt: now, exitedByActor: actor.actor, updatedAt: now }).where(and(eq(activityPlanBranches.planId, planId), eq(activityPlanBranches.branchId, branchId)));
      if (entries.length > 0) {
        await tx.update(activityPlanRoster).set({ entryState: "removed", removedAt: now, removedByActor: actor.actor, removedReason: "branch_exit", updatedAt: now }).where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.branchId, branchId), eq(activityPlanRoster.entryState, "in_roster")));
      }
      const released = await releaseAll(tx, planId, branchId, actor.actor, now);
      const report = await reconcileAccounts(tx, entries.map((e) => e.accountId), { ...EVENTS.branchExit, now, actor: actor.actor });
      await recordChange(tx, { planId, branchId, eventType: "branch_exited", actor: actor.actor, now, detail: { roster_entries_removed: entries.length, owners_released: released.released.length, accounts_closed: report.closed.length } });
      events.push({ event_type: "branch_exited", actor: actor.actor, occurred_at: now.toISOString(), plan_id: planId.toString(), target_type: "branch", target_id: branchId.toString(), counts: { roster_entries_removed: entries.length, owners_released: released.released.length, accounts_closed: report.closed.length } }, ...released.events, ...report.events);
      return { kind: "applied" as const, branchId: branchId.toString(), rosterEntries: entries.length, releasedOwners: released.released, accountsClosed: report.closed.length };
    });
    events.forEach((e) => audit(e));
    return out;
  }

  return { join, exit };
}
export type Participation = ReturnType<typeof createParticipation>;
