// 负责人名额（requirements AP-4；design §7.4）：每（计划 × 分公司）至多 2 个槽，只作责任标记，不授予任何权限。
// 串行化锁点是 activity_plan_branches 的参与关系行（SELECT … FOR UPDATE）：两个人同时抢最后一个槽，恰好一人成功。
import { and, asc, eq } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { activityPlanBranches, activityPlanOwners } from "../../db/schema";
import type { Clock } from "../raw-capture";
import type { PlanAuditEvent, PlanAuditSink } from "./audit";
import { assert, branchInScope, CAP_PLAN_CREATE, CAP_PLAN_JOIN, type PlanActor } from "./authz";
import { recordChange } from "./changes";
import { MAX_OWNER_SLOTS } from "./constants";
import { PlanError } from "./errors";
import { assertCollecting } from "./plans";
import { loadPlanFor } from "./visibility";

export interface OwnerRow {
  slotNo: number;
  ownerActor: string;
  ownerDisplayName: string | null;
  claimedAt: Date;
  claimedVia: string;
  claimedBatchId: bigint | null;
}
const nameOf = (o: { ownerActor: string; ownerDisplayName: string | null }): string => o.ownerDisplayName ?? o.ownerActor;

export async function ownersOf(tx: Db | DbTx, planId: bigint, branchId: bigint): Promise<OwnerRow[]> {
  return tx
    .select({ slotNo: activityPlanOwners.slotNo, ownerActor: activityPlanOwners.ownerActor, ownerDisplayName: activityPlanOwners.ownerDisplayName, claimedAt: activityPlanOwners.claimedAt, claimedVia: activityPlanOwners.claimedVia, claimedBatchId: activityPlanOwners.claimedBatchId })
    .from(activityPlanOwners)
    .where(and(eq(activityPlanOwners.planId, planId), eq(activityPlanOwners.branchId, branchId)))
    .orderBy(asc(activityPlanOwners.slotNo));
}

/** 锁住参与关系行并要求已参加；名额与名单写入共用这把锁。 */
export async function lockJoined(tx: Db | DbTx, planId: bigint, branchId: bigint): Promise<void> {
  const [row] = await tx
    .select({ status: activityPlanBranches.status })
    .from(activityPlanBranches)
    .where(and(eq(activityPlanBranches.planId, planId), eq(activityPlanBranches.branchId, branchId)))
    .for("update");
  if (!row || row.status !== "joined") throw new PlanError("conflict", "branch_not_joined", "该分公司没有参加这个计划");
}

export type ClaimResult =
  | { claimed: true; slotNo: number; events: PlanAuditEvent[] }
  | { claimed: false; reason: "exempt" | "already_owner" | "no_new_rows"; events: PlanAuditEvent[] };

/**
 * 确认写入时占用名额（design §7.4）。豁免（分公司范围 all）、已是负责人、没有「可能新增」的行 → 不占；
 * 两槽已满且提交人不在其中 → owner_slots_full（带现有负责人姓名，零写入）。
 * 在调用方的事务里执行；返回的 events 在事务提交后发出。
 * ponytail: possiblyNew 按本地可知事实判定，一批全是已存在账号但入口文本不同时也会占用一个名额（创建者 / 超管可替换）；
 *   升级路径是解析完成后再按实际新建数结算并回收，代价是名额检查不能再在写入前整批失败。
 */
export async function claimIfNeeded(
  tx: Db | DbTx,
  a: { planId: bigint; branchId: bigint; actor: PlanActor; possiblyNew: boolean; batchId?: bigint | null; now: Date; displayName?: string },
): Promise<ClaimResult> {
  await lockJoined(tx, a.planId, a.branchId);
  if (a.actor.branchScope === "all") return { claimed: false, reason: "exempt", events: [] };
  const owners = await ownersOf(tx, a.planId, a.branchId);
  if (owners.some((o) => o.ownerActor === a.actor.actor)) return { claimed: false, reason: "already_owner", events: [] };
  if (!a.possiblyNew) return { claimed: false, reason: "no_new_rows", events: [] };
  if (owners.length >= MAX_OWNER_SLOTS) {
    throw new PlanError("conflict", "owner_slots_full", `本计划分公司已有负责人：${owners.map(nameOf).join("、")}（名额已满）`, { owners: owners.map(nameOf) });
  }
  const slotNo = [1, 2].find((n) => !owners.some((o) => o.slotNo === n))!;
  await tx.insert(activityPlanOwners).values({ planId: a.planId, branchId: a.branchId, slotNo, ownerActor: a.actor.actor, ownerDisplayName: (a.displayName ?? a.actor.actor).slice(0, 100), claimedAt: a.now, claimedVia: "import", claimedBatchId: a.batchId ?? null });
  await recordChange(tx, { planId: a.planId, branchId: a.branchId, eventType: "owner_claimed", actor: a.actor.actor, now: a.now, detail: { slot_no: slotNo, via: "import", batch_id: a.batchId?.toString() ?? null } });
  return {
    claimed: true,
    slotNo,
    events: [{ event_type: "owner_claimed", actor: a.actor.actor, occurred_at: a.now.toISOString(), plan_id: a.planId.toString(), target_type: "owner_slot", target_id: `${a.planId}:${a.branchId}:${slotNo}`, ...(a.batchId ? { batch_id: a.batchId.toString() } : {}), after: { owner: a.actor.actor, slot_no: slotNo } }],
  };
}

/** 分公司退出时释放全部名额：删除当前态，历史留在变更记录。 */
export async function releaseAll(tx: Db | DbTx, planId: bigint, branchId: bigint, actor: string, now: Date): Promise<{ released: string[]; events: PlanAuditEvent[] }> {
  const owners = await ownersOf(tx, planId, branchId);
  const events: PlanAuditEvent[] = [];
  for (const o of owners) {
    await tx.delete(activityPlanOwners).where(and(eq(activityPlanOwners.planId, planId), eq(activityPlanOwners.branchId, branchId), eq(activityPlanOwners.slotNo, o.slotNo)));
    await recordChange(tx, { planId, branchId, eventType: "owner_released", actor, now, detail: { slot_no: o.slotNo, owner: o.ownerActor } });
    events.push({ event_type: "owner_released", actor, occurred_at: now.toISOString(), plan_id: planId.toString(), target_type: "owner_slot", target_id: `${planId}:${branchId}:${o.slotNo}`, before: { owner: o.ownerActor, slot_no: o.slotNo } });
  }
  return { released: owners.map(nameOf), events };
}

export function createOwners(deps: { db: Db; clock: Clock; audit: PlanAuditSink }) {
  const { db, clock, audit } = deps;

  /** 名额列表：分公司人员只看到自己分公司的槽位，总部 / 超管看到全部（design §15.5）。 */
  async function list(actor: PlanActor, planId: bigint, branchId?: bigint): Promise<Array<{ branchId: string; slotNo: number; owner: string; displayName: string | null; claimedAt: string; via: string }>> {
    if (!actor.capabilities.has(CAP_PLAN_CREATE) && !actor.capabilities.has(CAP_PLAN_JOIN)) assert(actor, CAP_PLAN_JOIN);
    const cap = actor.capabilities.has(CAP_PLAN_CREATE) ? CAP_PLAN_CREATE : CAP_PLAN_JOIN;
    await loadPlanFor(db, actor, cap, planId);
    const rows = await db.select().from(activityPlanOwners).where(branchId === undefined ? eq(activityPlanOwners.planId, planId) : and(eq(activityPlanOwners.planId, planId), eq(activityPlanOwners.branchId, branchId))).orderBy(asc(activityPlanOwners.branchId), asc(activityPlanOwners.slotNo));
    return rows.filter((r) => branchInScope(actor, r.branchId)).map((r) => ({ branchId: r.branchId.toString(), slotNo: r.slotNo, owner: r.ownerActor, displayName: r.ownerDisplayName, claimedAt: r.claimedAt.toISOString(), via: r.claimedVia }));
  }

  type AssignResult = { kind: "preview"; before: string | null; after: string; slotNo: number } | { kind: "applied"; before: string | null; after: string; slotNo: number } | { kind: "noop"; slotNo: number };
  /**
   * 给空槽指派或替换某个槽的负责人（同一命令；slotNo 缺省 = 最小的空槽，两槽都满必须指定要替换的槽）。
   * 只有计划创建者与超管；仅采集中；默认只预览，apply 才写（AP-14）。分公司人员不能自己换。
   */
  async function assign(actor: PlanActor, a: { planId: bigint; branchId: bigint; owner: string; displayName?: string; slotNo?: number; apply?: boolean }): Promise<AssignResult> {
    if (a.slotNo !== undefined && !(a.slotNo === 1 || a.slotNo === 2)) throw new PlanError("input", "slot_invalid", "槽位号只能是 1 或 2");
    if (a.owner.trim() === "") throw new PlanError("input", "owner_invalid", "负责人不能为空");
    const now = clock.now();
    const events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx) => {
      const plan = await loadPlanFor(tx, actor, CAP_PLAN_CREATE, a.planId, { lock: "share" });
      assert(actor, CAP_PLAN_CREATE, { creator: plan.createdByActor });
      assertCollecting(plan);
      await lockJoined(tx, a.planId, a.branchId);
      const owners = await ownersOf(tx, a.planId, a.branchId);
      const slotNo = a.slotNo ?? [1, 2].find((n) => !owners.some((o) => o.slotNo === n));
      if (slotNo === undefined) throw new PlanError("input", "slot_required", "两个名额都已占用，请指定要替换的槽位号", { owners: owners.map(nameOf) });
      const current = owners.find((o) => o.slotNo === slotNo);
      if (current?.ownerActor === a.owner) return { kind: "noop" as const, slotNo };
      const elsewhere = owners.find((o) => o.ownerActor === a.owner && o.slotNo !== slotNo);
      if (elsewhere) throw new PlanError("conflict", "owner_already_in_slot", `${a.owner} 已经占用了槽位 ${elsewhere.slotNo}`);
      const result = { before: current ? nameOf(current) : null, after: a.displayName ?? a.owner, slotNo };
      if (!a.apply) return { kind: "preview" as const, ...result };
      if (current) await tx.update(activityPlanOwners).set({ ownerActor: a.owner, ownerDisplayName: (a.displayName ?? a.owner).slice(0, 100), ownerUserId: null, claimedAt: now, claimedVia: "replace", claimedBatchId: null }).where(and(eq(activityPlanOwners.planId, a.planId), eq(activityPlanOwners.branchId, a.branchId), eq(activityPlanOwners.slotNo, slotNo)));
      else await tx.insert(activityPlanOwners).values({ planId: a.planId, branchId: a.branchId, slotNo, ownerActor: a.owner, ownerDisplayName: (a.displayName ?? a.owner).slice(0, 100), claimedAt: now, claimedVia: "replace" });
      const type = current ? "owner_replaced" : "owner_claimed";
      await recordChange(tx, { planId: a.planId, branchId: a.branchId, eventType: type, actor: actor.actor, now, detail: { slot_no: slotNo, from: current?.ownerActor ?? null, to: a.owner } });
      events.push({ event_type: type, actor: actor.actor, occurred_at: now.toISOString(), plan_id: a.planId.toString(), target_type: "owner_slot", target_id: `${a.planId}:${a.branchId}:${slotNo}`, before: { owner: current?.ownerActor ?? null }, after: { owner: a.owner, slot_no: slotNo } });
      return { kind: "applied" as const, ...result };
    });
    events.forEach((e) => audit(e));
    return out;
  }

  const replace = (actor: PlanActor, a: { planId: bigint; branchId: bigint; owner: string; displayName?: string; slotNo: number; apply?: boolean }): Promise<AssignResult> => assign(actor, a);

  return { list, assign, replace };
}
export type Owners = ReturnType<typeof createOwners>;
