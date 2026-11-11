// 计划可见性：所有读路径统一走这里，过滤已删除（回收站）与品牌范围。
// 总部 / 超管（持有 activity_plan.create）：授权品牌内全部未删除计划；分公司（只有 join）：授权品牌内「采集中」的计划，用于加入与提报。
// 越范围的对象表现为不存在（不泄露存在性）。回收站是唯一例外，见 plans.trash。
import { and, asc, eq, inArray, ne, type SQL } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { activityPlanSectors, activityPlans, brands, platforms } from "../../db/schema";
import { assert, CAP_PLAN_CREATE, CAP_PLAN_JOIN, type PlanActor } from "./authz";
import { SECTOR_LABELS } from "./constants";
import { PlanError } from "./errors";

export interface PlanRow {
  planId: bigint;
  planName: string;
  description: string | null;
  brandId: bigint;
  brandCode: string;
  platformId: bigint;
  platformCode: string;
  startsOn: string;
  endsOn: string | null;
  status: string;
  statusChangedAt: Date;
  statusBeforeDelete: string | null;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  createdByActor: string;
  createdAt: Date;
  updatedAt: Date;
}
export const planColumns = {
  planId: activityPlans.planId,
  planName: activityPlans.planName,
  description: activityPlans.description,
  brandId: activityPlans.brandId,
  brandCode: brands.brandCode,
  platformId: activityPlans.platformId,
  platformCode: platforms.platformCode,
  startsOn: activityPlans.startsOn,
  endsOn: activityPlans.endsOn,
  status: activityPlans.status,
  statusChangedAt: activityPlans.statusChangedAt,
  statusBeforeDelete: activityPlans.statusBeforeDelete,
  deletedAt: activityPlans.deletedAt,
  purgeAfter: activityPlans.purgeAfter,
  createdByActor: activityPlans.createdByActor,
  createdAt: activityPlans.createdAt,
  updatedAt: activityPlans.updatedAt,
};

/** 操作者能看到的计划条件（不含回收站）。没有任何计划 Capability 返回 null（什么都看不到）。 */
export function visibleCondition(actor: PlanActor): SQL | null {
  const canCreate = actor.capabilities.has(CAP_PLAN_CREATE);
  if (!canCreate && !actor.capabilities.has(CAP_PLAN_JOIN)) return null;
  const parts: SQL[] = [ne(activityPlans.status, "deleted")];
  if (!canCreate) parts.push(eq(activityPlans.status, "collecting"));
  if (actor.brandScope !== "all") {
    if (actor.brandScope.size === 0) return null;
    parts.push(inArray(brands.brandCode, [...actor.brandScope]));
  }
  return and(...parts) ?? null;
}

export async function visiblePlans(db: Db | DbTx, actor: PlanActor, extra?: SQL): Promise<PlanRow[]> {
  const cond = visibleCondition(actor);
  if (!cond) return [];
  return db
    .select(planColumns)
    .from(activityPlans)
    .innerJoin(brands, eq(brands.brandId, activityPlans.brandId))
    .innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId))
    .where(extra ? and(cond, extra) : cond)
    .orderBy(asc(activityPlans.planId));
}

/** 按 ID 取一个对用户可见的计划；不存在、已删除、越范围一律返回 null。 */
export async function getVisiblePlan(db: Db | DbTx, actor: PlanActor, planId: bigint): Promise<PlanRow | null> {
  return (await visiblePlans(db, actor, eq(activityPlans.planId, planId)))[0] ?? null;
}

/** 计划的板块种类（排序固定：家装在前）与「需要 N 份监控判定计划」的文案（A §11.2；本 spec 不创建它们）。 */
export async function sectorsOf(db: Db | DbTx, planId: bigint): Promise<string[]> {
  const rows = await db.select({ k: activityPlanSectors.sectorKey }).from(activityPlanSectors).where(eq(activityPlanSectors.planId, planId));
  return rows.map((r) => r.k).sort();
}
export function requiredJudgementPlans(sectors: readonly string[]): { count: number; sectors: string[]; text: string } {
  const sorted = [...sectors].sort();
  const names = sorted.map((k) => SECTOR_LABELS[k as keyof typeof SECTOR_LABELS] ?? k);
  return { count: sorted.length, sectors: sorted, text: `本计划需要 ${sorted.length} 份监控判定计划：${names.join("、")}` };
}

/**
 * 操作类命令（加入 / 退出 / 名额 / 名单）取计划：Capability 先于读库；已删除或越品牌一律「未找到」。
 * 不按状态隐藏——暂停 / 归档的计划要让调用方得到 plan_not_collecting，而不是未找到。
 * lock：只锁计划行（share：阻止并发的状态变更；update：自己要改计划）。
 */
export async function loadPlanFor(tx: Db | DbTx, actor: PlanActor, capability: string, planId: bigint, o: { lock?: "share" | "update" } = {}): Promise<PlanRow> {
  assert(actor, capability);
  if (o.lock) {
    const q = tx.select({ id: activityPlans.planId }).from(activityPlans).where(eq(activityPlans.planId, planId));
    await (o.lock === "share" ? q.for("share") : q.for("update"));
  }
  const [row] = await tx
    .select(planColumns)
    .from(activityPlans)
    .innerJoin(brands, eq(brands.brandId, activityPlans.brandId))
    .innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId))
    .where(eq(activityPlans.planId, planId));
  if (!row || row.status === "deleted") throw new PlanError("not_found", "not_found", "未找到");
  assert(actor, capability, { brandCode: row.brandCode, outOfScope: "hide" });
  return row;
}
