// 计划生命周期（requirements AP-1、AP-2；design §5.1、§7.9）：创建、编辑、暂停 / 归档 / 恢复、删除、回收站恢复、回收站列表。
// 品牌 / 平台 / 板块没有任何更新路径：edit 只接受名称、说明、起止日期，带其他参数一律 immutable_field。
// 每一步在一个事务里完成「状态写入 + 引用重算 + 变更记录」；审计与下游通知在事务提交之后发出。
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { activityPlanRoster, activityPlanSectors, activityPlans, brands, platforms } from "../../db/schema";
import { reconcileAccounts, EVENTS, bjtDate, type ReconcileReport } from "../plan-references";
import type { Clock } from "../raw-capture";
import type { PlanAuditEvent, PlanAuditEventType, PlanAuditSink } from "./audit";
import { assert, CAP_PLAN_CREATE, type PlanActor } from "./authz";
import { recordChange } from "./changes";
import { PLAN_DESCRIPTION_MAX, PLAN_NAME_MAX, PLAN_PLATFORMS, SECTOR_KEYS, TRASH_DAYS } from "./constants";
import type { PlanDownstream } from "./downstream";
import { PlanError } from "./errors";
import { planColumns, requiredJudgementPlans, sectorsOf, type PlanRow } from "./visibility";

export type PlanStatus = "collecting" | "paused" | "archived" | "deleted";
export interface PlansDeps {
  db: Db;
  clock: Clock;
  audit: PlanAuditSink;
  downstream: PlanDownstream;
}
export interface CreatePlanInput {
  brand: string;
  platform: string;
  sectors?: readonly string[];
  name: string;
  description?: string | null;
  startsOn: string;
  endsOn?: string | null;
}
export interface EditPlanInput {
  name?: string;
  description?: string | null;
  startsOn?: string;
  endsOn?: string | null;
}
export interface PlanView {
  planId: string;
  name: string;
  description: string | null;
  brand: string;
  platform: string;
  sectors: string[];
  startsOn: string;
  endsOn: string | null;
  status: string;
  createdBy: string;
  statusChangedAt: string;
  deletedAt: string | null;
  purgeAfter: string | null;
}
export type StatusAction = "pause" | "archive" | "resume";
const IMMUTABLE_KEYS = ["brand", "brandId", "platform", "platformId", "sectors"] as const;
const DAY = 86_400_000;

/** 非 collecting 时冻结名单导入、移出、分公司加入 / 退出、负责人替换（供任务 5、7、9 复用）。 */
export function assertCollecting(plan: { status: string }): void {
  if (plan.status !== "collecting") throw new PlanError("conflict", "plan_not_collecting", `计划当前是「${plan.status}」状态，只有采集中的计划可以执行这个操作`);
}

const validDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const bad = (code: string, msg: string): never => {
  throw new PlanError("input", code, msg);
};

function validateText(name: unknown, description: unknown): { name?: string; description?: string | null } {
  const out: { name?: string; description?: string | null } = {};
  if (name !== undefined) {
    const n = typeof name === "string" ? name.trim() : "";
    if (n.length < 1 || n.length > PLAN_NAME_MAX) bad("name_invalid", `名称去首尾空白后须为 1–${PLAN_NAME_MAX} 字`);
    out.name = n;
  }
  if (description !== undefined) {
    if (description !== null && (typeof description !== "string" || description.length > PLAN_DESCRIPTION_MAX)) bad("description_invalid", `说明至多 ${PLAN_DESCRIPTION_MAX} 字`);
    out.description = typeof description === "string" && description.trim() !== "" ? description : null;
  }
  return out;
}

export function createPlans(deps: PlansDeps) {
  const { db, clock, audit, downstream } = deps;

  const evt = (type: PlanAuditEventType, actor: string, now: Date, e: Partial<PlanAuditEvent> = {}): PlanAuditEvent => ({ event_type: type, actor, occurred_at: now.toISOString(), ...e });
  const emit = (events: PlanAuditEvent[]): void => events.forEach((e) => audit(e));
  const withReconcile = (events: PlanAuditEvent[], report: ReconcileReport): PlanAuditEvent[] => [...events, ...report.events];

  async function view(tx: Db | DbTx, r: PlanRow): Promise<PlanView> {
    return {
      planId: r.planId.toString(),
      name: r.planName,
      description: r.description,
      brand: r.brandCode,
      platform: r.platformCode,
      sectors: await sectorsOf(tx, r.planId),
      startsOn: r.startsOn,
      endsOn: r.endsOn,
      status: r.status,
      createdBy: r.createdByActor,
      statusChangedAt: r.statusChangedAt.toISOString(),
      deletedAt: r.deletedAt?.toISOString() ?? null,
      purgeAfter: r.purgeAfter?.toISOString() ?? null,
    };
  }

  /**
   * 取计划并完成授权：Capability（先于任何读库）→ 读计划 → 品牌范围（越范围 = 未找到）→ 创建者谓词。
   * 回收站里的计划只对创建者与超管可见，其他人一律未找到。lock 时只锁计划行，不锁品牌 / 平台行。
   */
  async function load(tx: Db | DbTx, actor: PlanActor, planId: bigint, o: { lock?: boolean; deleted?: "no" | "only" | "any" } = {}): Promise<PlanRow> {
    assert(actor, CAP_PLAN_CREATE);
    if (o.lock) await tx.select({ id: activityPlans.planId }).from(activityPlans).where(eq(activityPlans.planId, planId)).for("update");
    const [row] = await tx
      .select(planColumns)
      .from(activityPlans)
      .innerJoin(brands, eq(brands.brandId, activityPlans.brandId))
      .innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId))
      .where(eq(activityPlans.planId, planId));
    const deleted = row?.status === "deleted";
    if (!row || (o.deleted === "only" ? !deleted : o.deleted === "any" ? false : deleted)) throw new PlanError("not_found", "not_found", "未找到");
    assert(actor, CAP_PLAN_CREATE, { brandCode: row.brandCode, outOfScope: "hide" });
    if (deleted && row.createdByActor !== actor.actor && !actor.platformAdmin) throw new PlanError("not_found", "not_found", "未找到");
    assert(actor, CAP_PLAN_CREATE, { creator: row.createdByActor });
    return row;
  }

  const rosterAccounts = async (tx: Db | DbTx, planId: bigint): Promise<bigint[]> =>
    (await tx.select({ id: activityPlanRoster.accountId }).from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.entryState, "in_roster")))).map((r) => r.id);

  async function create(actor: PlanActor, input: CreatePlanInput): Promise<{ plan: PlanView; required: ReturnType<typeof requiredJudgementPlans> }> {
    assert(actor, CAP_PLAN_CREATE, { brandCode: input.brand });
    const text = validateText(input.name, input.description);
    if (!(PLAN_PLATFORMS as readonly string[]).includes(input.platform)) bad("platform_unsupported", `1.0 只支持 ${PLAN_PLATFORMS.join(" / ")}，不支持 ${input.platform}`);
    const sectors = [...new Set(input.sectors ?? SECTOR_KEYS)];
    if (sectors.length === 0 || sectors.some((s) => !(SECTOR_KEYS as readonly string[]).includes(s))) bad("sectors_invalid", "板块须是水机 / 家装的非空子集");
    if (!validDate(input.startsOn)) bad("dates_invalid", "开始日期必须是 YYYY-MM-DD");
    const endsOn = input.endsOn ?? null;
    if (endsOn !== null && !validDate(endsOn)) bad("dates_invalid", "结束日期必须是 YYYY-MM-DD");
    if (endsOn !== null && endsOn < input.startsOn) bad("dates_invalid", "结束日期不能早于开始日期");
    const now = clock.now();
    const out = await db.transaction(async (tx) => {
      const [brand] = await tx.select().from(brands).where(eq(brands.brandCode, input.brand));
      if (!brand) throw new PlanError("input", "brand_not_found", "品牌不存在");
      if (brand.status !== "active") throw new PlanError("input", "brand_inactive", "品牌已停用");
      const [plat] = await tx.select().from(platforms).where(eq(platforms.platformCode, input.platform));
      if (!plat || plat.status !== "active") throw new PlanError("input", "platform_not_found", "平台不存在或已停用");
      const [ins] = await tx.insert(activityPlans).values({
        planName: text.name!,
        description: text.description ?? null,
        brandId: brand.brandId,
        platformId: plat.platformId,
        startsOn: input.startsOn,
        endsOn,
        status: "collecting",
        statusChangedAt: now,
        createdByActor: actor.actor,
        createdAt: now,
        updatedAt: now,
      });
      const planId = BigInt(ins.insertId);
      for (const sectorKey of sectors) await tx.insert(activityPlanSectors).values({ planId, sectorKey });
      await recordChange(tx, { planId, eventType: "plan_created", actor: actor.actor, now, detail: { name: text.name, platform: input.platform, sectors: [...sectors].sort(), starts_on: input.startsOn, ends_on: endsOn } });
      const [row] = await tx.select(planColumns).from(activityPlans).innerJoin(brands, eq(brands.brandId, activityPlans.brandId)).innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId)).where(eq(activityPlans.planId, planId));
      return { plan: await view(tx, row!), planId };
    });
    emit([evt("plan_created", actor.actor, now, { plan_id: out.plan.planId, target_type: "plan", target_id: out.plan.planId, target_code: text.name!, after: { brand: input.brand, platform: input.platform, sectors: out.plan.sectors } })]);
    return { plan: out.plan, required: requiredJudgementPlans(out.plan.sectors) };
  }

  async function edit(actor: PlanActor, planId: bigint, patch: EditPlanInput & Record<string, unknown>): Promise<{ plan: PlanView; changed: string[] }> {
    assert(actor, CAP_PLAN_CREATE); // Capability 先于任何读库（连事务都不开）
    const immutable = IMMUTABLE_KEYS.filter((k) => k in patch);
    if (immutable.length > 0) throw new PlanError("input", "immutable_field", `${immutable.join("、")} 创建后不可修改`);
    const unknown = Object.keys(patch).filter((k) => !["name", "description", "startsOn", "endsOn"].includes(k));
    if (unknown.length > 0) bad("unknown_field", `不支持的字段：${unknown.join("、")}`);
    const text = validateText(patch.name, patch.description);
    if (patch.startsOn !== undefined && !validDate(patch.startsOn)) bad("dates_invalid", "开始日期必须是 YYYY-MM-DD");
    if (patch.endsOn !== undefined && patch.endsOn !== null && !validDate(patch.endsOn)) bad("dates_invalid", "结束日期必须是 YYYY-MM-DD");
    const now = clock.now();
    let events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx) => {
      const cur = await load(tx, actor, planId, { lock: true, deleted: "no" });
      const next = { name: text.name ?? cur.planName, description: text.description === undefined ? cur.description : text.description, startsOn: patch.startsOn ?? cur.startsOn, endsOn: patch.endsOn === undefined ? cur.endsOn : patch.endsOn };
      if (next.endsOn !== null && next.endsOn < next.startsOn) bad("dates_invalid", "结束日期不能早于开始日期");
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      if (next.name !== cur.planName) diff.name = { from: cur.planName, to: next.name };
      if (next.description !== cur.description) diff.description = { from: cur.description === null ? null : "（已填写）", to: next.description === null ? null : "（已填写）" }; // 说明正文不进变更记录
      if (next.startsOn !== cur.startsOn) diff.starts_on = { from: cur.startsOn, to: next.startsOn };
      if (next.endsOn !== cur.endsOn) diff.ends_on = { from: cur.endsOn, to: next.endsOn };
      const changed = Object.keys(diff);
      if (changed.length > 0) {
        await tx.update(activityPlans).set({ planName: next.name, description: next.description, startsOn: next.startsOn, endsOn: next.endsOn, updatedAt: now }).where(eq(activityPlans.planId, planId));
        await recordChange(tx, { planId, eventType: "plan_edited", actor: actor.actor, now, detail: diff });
        events.push(evt("plan_edited", actor.actor, now, { plan_id: planId.toString(), target_type: "plan", target_id: planId.toString(), before: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.from])), after: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.to])) }));
        if ("ends_on" in diff) events = withReconcile(events, await reconcileAccounts(tx, await rosterAccounts(tx, planId), { ...EVENTS.endDateChanged, now, actor: actor.actor }));
      }
      const [row] = await tx.select(planColumns).from(activityPlans).innerJoin(brands, eq(brands.brandId, activityPlans.brandId)).innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId)).where(eq(activityPlans.planId, planId));
      return { plan: await view(tx, row!), changed };
    });
    emit(events);
    return out;
  }

  const TRANSITIONS: Record<StatusAction, { from: PlanStatus[]; to: PlanStatus; event: keyof typeof EVENTS }> = {
    pause: { from: ["collecting"], to: "paused", event: "planPaused" },
    archive: { from: ["collecting"], to: "archived", event: "planArchived" },
    resume: { from: ["paused", "archived"], to: "collecting", event: "planResumed" },
  };
  async function setStatus(actor: PlanActor, planId: bigint, action: StatusAction): Promise<{ plan: PlanView; from: string; to: string }> {
    assert(actor, CAP_PLAN_CREATE);
    const tr = TRANSITIONS[action];
    if (!tr) bad("invalid_action", `未知操作 ${String(action)}`);
    const now = clock.now();
    let events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx) => {
      const cur = await load(tx, actor, planId, { lock: true, deleted: "any" });
      if (!tr.from.includes(cur.status as PlanStatus)) throw new PlanError("conflict", "invalid_transition", `${cur.status} 状态不能 ${action}`);
      await tx.update(activityPlans).set({ status: tr.to, statusChangedAt: now, updatedAt: now }).where(eq(activityPlans.planId, planId));
      await recordChange(tx, { planId, eventType: "plan_status_changed", actor: actor.actor, now, detail: { from: cur.status, to: tr.to } });
      events.push(evt("plan_status_changed", actor.actor, now, { plan_id: planId.toString(), target_type: "plan", target_id: planId.toString(), before: { status: cur.status }, after: { status: tr.to } }));
      events = withReconcile(events, await reconcileAccounts(tx, await rosterAccounts(tx, planId), { ...EVENTS[tr.event], now, actor: actor.actor }));
      const [row] = await tx.select(planColumns).from(activityPlans).innerJoin(brands, eq(brands.brandId, activityPlans.brandId)).innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId)).where(eq(activityPlans.planId, planId));
      return { plan: await view(tx, row!), from: cur.status, to: tr.to };
    });
    emit(events);
    return out;
  }

  /** 本计划名单内「只被本计划引用」且当前开启的账号数：删除后会被立即关闭的账号。 */
  async function accountsToClose(tx: Db | DbTx, planId: bigint, today: string): Promise<number> {
    const [res] = await tx.execute(sql`
      SELECT COUNT(*) AS n FROM activity_plan_roster r
      JOIN staff_account_assignments a ON a.account_id = r.account_id AND a.watch_type = 'staff' AND a.monitoring_enabled = 1
      WHERE r.plan_id = ${planId} AND r.entry_state = 'in_roster'
        AND NOT EXISTS (
          SELECT 1 FROM activity_plan_roster r2 JOIN activity_plans p2 ON p2.plan_id = r2.plan_id
          WHERE r2.account_id = r.account_id AND r2.plan_id <> r.plan_id AND r2.entry_state = 'in_roster'
            AND p2.status = 'collecting' AND (p2.ends_on IS NULL OR p2.ends_on >= ${today}))`);
    return Number((res as unknown as Array<{ n: string | number }>)[0]?.n ?? 0);
  }

  type DeleteResult =
    | { kind: "preview"; plan: PlanView; downstream: Awaited<ReturnType<PlanDownstream["summarize"]>>; roster: { inRoster: number; accountsToClose: number }; apply: false }
    | { kind: "applied"; plan: PlanView; purgeAfter: string; accountsClosed: number };
  async function remove(actor: PlanActor, planId: bigint, o: { apply?: boolean } = {}): Promise<DeleteResult> {
    const now = clock.now();
    const pre = await load(db, actor, planId, { deleted: "no" });
    // ponytail: 在途检查在事务外做（跨域调用不得持有数据库事务），检查与写入之间有极小的竞态窗口；D/E 落地后若需要严格，改为下游持有软锁
    const summary = await downstream.summarize(planId);
    if (!o.apply) {
      const [n] = await db.select({ n: sql<string>`COUNT(*)` }).from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.entryState, "in_roster")));
      return { kind: "preview", plan: await view(db, pre), downstream: summary, roster: { inRoster: Number(n?.n ?? 0), accountsToClose: await accountsToClose(db, planId, bjtDate(now)) }, apply: false };
    }
    if (summary.running > 0) throw new PlanError("conflict", "downstream_running", `下游还有 ${summary.running} 个判定正在执行，请等它们结束后再删除`);
    let events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx) => {
      const cur = await load(tx, actor, planId, { lock: true, deleted: "no" });
      const purgeAfter = new Date(now.getTime() + TRASH_DAYS * DAY);
      await tx.update(activityPlans).set({ status: "deleted", statusBeforeDelete: cur.status, deletedAt: now, deletedByActor: actor.actor, purgeAfter, statusChangedAt: now, updatedAt: now }).where(eq(activityPlans.planId, planId));
      await recordChange(tx, { planId, eventType: "plan_deleted", actor: actor.actor, now, detail: { status_before_delete: cur.status, purge_after: purgeAfter.toISOString() } });
      events.push(evt("plan_deleted", actor.actor, now, { plan_id: planId.toString(), target_type: "plan", target_id: planId.toString(), before: { status: cur.status }, after: { status: "deleted", purge_after: purgeAfter.toISOString() } }));
      const report = await reconcileAccounts(tx, await rosterAccounts(tx, planId), { ...EVENTS.planDeleted, now, actor: actor.actor });
      events = withReconcile(events, report);
      const [row] = await tx.select(planColumns).from(activityPlans).innerJoin(brands, eq(brands.brandId, activityPlans.brandId)).innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId)).where(eq(activityPlans.planId, planId));
      return { kind: "applied" as const, plan: await view(tx, row!), purgeAfter: purgeAfter.toISOString(), accountsClosed: report.closed.length };
    });
    emit(events);
    await notify("onDeleted", planId, actor.actor, now);
    return out;
  }

  /** onDeleted / onRestored 是加速通知：失败不回滚本模块已提交的事务，只写审计（D/E 以计划状态对账）。 */
  async function notify(which: "onDeleted" | "onRestored", planId: bigint, actor: string, now: Date): Promise<void> {
    try {
      await downstream[which](planId);
    } catch (e) {
      audit(evt("downstream_notify_failed", actor, now, { plan_id: planId.toString(), reason_code: which, counts: { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" } }));
    }
  }

  async function restore(actor: PlanActor, planId: bigint): Promise<{ plan: PlanView; accountsReopened: number }> {
    assert(actor, CAP_PLAN_CREATE);
    const now = clock.now();
    let events: PlanAuditEvent[] = [];
    const out = await db.transaction(async (tx) => {
      const cur = await load(tx, actor, planId, { lock: true, deleted: "only" });
      if (!cur.purgeAfter || now.getTime() >= cur.purgeAfter.getTime() || !cur.statusBeforeDelete) throw new PlanError("not_found", "not_in_trash", "该计划已超过回收站保留期，不能恢复");
      await tx.update(activityPlans).set({ status: cur.statusBeforeDelete, statusBeforeDelete: null, deletedAt: null, deletedByActor: null, purgeAfter: null, statusChangedAt: now, updatedAt: now }).where(eq(activityPlans.planId, planId));
      await recordChange(tx, { planId, eventType: "plan_restored", actor: actor.actor, now, detail: { status: cur.statusBeforeDelete } });
      events.push(evt("plan_restored", actor.actor, now, { plan_id: planId.toString(), target_type: "plan", target_id: planId.toString(), after: { status: cur.statusBeforeDelete } }));
      const report = await reconcileAccounts(tx, await rosterAccounts(tx, planId), { ...EVENTS.planRestored, now, actor: actor.actor });
      events = withReconcile(events, report);
      const [row] = await tx.select(planColumns).from(activityPlans).innerJoin(brands, eq(brands.brandId, activityPlans.brandId)).innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId)).where(eq(activityPlans.planId, planId));
      return { plan: await view(tx, row!), accountsReopened: report.reopened.length };
    });
    emit(events);
    await notify("onRestored", planId, actor.actor, now);
    return out;
  }

  /** 回收站列表：仅创建者与超管，授权品牌内，按删除时间倒序。 */
  async function trash(actor: PlanActor): Promise<PlanView[]> {
    assert(actor, CAP_PLAN_CREATE);
    const rows = await db
      .select(planColumns)
      .from(activityPlans)
      .innerJoin(brands, eq(brands.brandId, activityPlans.brandId))
      .innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId))
      .where(eq(activityPlans.status, "deleted"))
      .orderBy(desc(activityPlans.deletedAt));
    const mine = rows.filter((r) => (actor.platformAdmin || r.createdByActor === actor.actor) && (actor.brandScope === "all" || actor.brandScope.has(r.brandCode)));
    return Promise.all(mine.map((r) => view(db, r)));
  }

  return { create, edit, setStatus, delete: remove, restore, trash };
}
export type Plans = ReturnType<typeof createPlans>;
