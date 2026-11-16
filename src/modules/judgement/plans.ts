// 判定计划的生命周期（JP-1）：创建（D 先落行，C 再建监控段，两边同 ID 同版本）、查询、归档、provisioning 对账。
// 对 C 的调用一律在数据库事务之外（data-discipline 纪律 2）。
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { judgementPlans, judgementPlanVersions } from "../../db/schema";
import type { AuthContext } from "../access-control";
import type { Clock } from "../raw-capture/ports";
import { SignalError } from "../signals/errors";
import { configSha256, CONFIG_SCHEMA_VERSION, emptyConfig, type ConfigLimits } from "./config";
import type { JudgementAudit } from "./audit";
import { JudgementError, isDuplicateKey } from "./errors";
import type { JudgementAuthz, JudgementPlanRef } from "./authz";
import type { Facts } from "./facts";
import type { SignalsPort } from "./ports";

export interface JudgementDeps {
  db: Db;
  clock: Clock;
  facts: Facts;
  authz: JudgementAuthz;
  audit: JudgementAudit;
  signals: SignalsPort;
  limits: ConfigLimits;
}
export type PlanRow = typeof judgementPlans.$inferSelect;
export type VersionRow = typeof judgementPlanVersions.$inferSelect;

export const ALIAS_MAX = 200;

/** 读判定计划行并构造授权引用；活动计划在回收站（deleted）或不存在一律表现为「未找到」。 */
export async function loadPlan(deps: Pick<JudgementDeps, "db" | "facts">, planId: bigint): Promise<{ plan: PlanRow; ref: JudgementPlanRef; activity: Awaited<ReturnType<Facts["planOf"]>> & object }> {
  const [plan] = await deps.db.select().from(judgementPlans).where(eq(judgementPlans.planId, planId));
  const activity = plan ? await deps.facts.planOf(plan.activityPlanId) : null;
  if (!plan || !activity || activity.status === "deleted") throw new JudgementError("not_found", "judgement_plan_not_found", "判定计划不存在");
  const branchIds = await deps.facts.joinedBranchIds(plan.activityPlanId);
  return { plan, activity, ref: { brandId: activity.brandId, branchIds, planCreatorActor: activity.createdByActor } };
}

export function createPlans(deps: JudgementDeps) {
  const { db, clock, facts, authz, audit, signals } = deps;

  /** 把提交人身份译成 C 的 Actor（授权已通过；C 的 Capability 检查对提交人生效）。 */
  const signalActor = (ctx: AuthContext) => authz.toSignalActor(ctx);

  async function create(ctx: AuthContext, input: { activityPlanId: bigint; alias: string; description?: string }): Promise<{ planId: bigint; version: number }> {
    await authz.require(ctx, "manage"); // 缺 Capability 先于任何读库被拒
    const alias = input.alias.trim();
    if (alias.length < 1 || [...alias].length > ALIAS_MAX) throw new JudgementError("input", "alias_invalid", `别名需为 1–${ALIAS_MAX} 字`);
    const activity = await facts.planOf(input.activityPlanId);
    if (!activity || activity.status === "deleted") throw new JudgementError("not_found", "activity_plan_not_found", "活动计划不存在");
    await authz.require(ctx, "manage", { brandId: activity.brandId, branchIds: await facts.joinedBranchIds(activity.planId), planCreatorActor: activity.createdByActor });
    if (activity.status !== "collecting") throw new JudgementError("conflict", "activity_plan_not_collecting", "只有采集中的活动计划可以新建判定计划");
    const now = clock.now();
    const config = emptyConfig({ from: activity.startsOn, ...(activity.endsOn ? { to: activity.endsOn } : {}) });
    let planId: bigint;
    try {
      planId = await db.transaction(async (tx) => {
        const [r] = await tx.insert(judgementPlans).values({
          activityPlanId: activity.planId,
          platformId: activity.platformId,
          alias,
          ...(input.description ? { description: input.description } : {}),
          status: "provisioning",
          latestVersion: 1,
          createdByActor: ctx.actor,
          createdByUserId: ctx.userId,
          createdAt: now,
          updatedAt: now,
        });
        const id = BigInt(r.insertId);
        await tx.insert(judgementPlanVersions).values({ planId: id, version: 1, status: "draft", wizardStep: "draft", config, configSchemaVersion: CONFIG_SCHEMA_VERSION, configSha256: configSha256(config), createdByActor: ctx.actor, createdAt: now, updatedAt: now });
        await audit.record({ event: "plan_created", actor: ctx.actor, actorUserId: ctx.userId, planId: id, detail: { activityPlanId: String(activity.planId), alias } }, tx);
        return id;
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new JudgementError("conflict", "alias_taken", "同一活动计划内已有同名判定计划");
      throw e;
    }
    await provision(ctx, planId, activity.platformCode);
    return { planId, version: 1 };
  }

  /** C 侧建监控段（事务外）；已存在且平台相同视为成功；成功后置 active。 */
  async function provision(ctx: AuthContext, planId: bigint, platform: string): Promise<void> {
    const actor = await signalActor(ctx);
    try {
      await signals.segments.create(actor, { planId, platform });
    } catch (e) {
      if (!(e instanceof SignalError) || e.code !== "segment_exists") throw e;
      const shown = await signals.segments.show(actor, { planId, version: 1 });
      if (shown.platform !== platform) throw new JudgementError("conflict", "segment_platform_mismatch", "C 侧已有同 ID 的监控段，但平台不同");
    }
    await db.update(judgementPlans).set({ status: "active", updatedAt: clock.now() }).where(and(eq(judgementPlans.planId, planId), eq(judgementPlans.status, "provisioning")));
  }

  /** 补完 provisioning 的计划（D 已落行、C 调用失败的情形）。幂等。 */
  async function reconcile(ctx: AuthContext, only?: bigint): Promise<{ completed: bigint[] }> {
    await authz.require(ctx, "manage");
    const rows = await db.select().from(judgementPlans).where(only === undefined ? eq(judgementPlans.status, "provisioning") : and(eq(judgementPlans.planId, only), eq(judgementPlans.status, "provisioning")));
    const completed: bigint[] = [];
    for (const p of rows) {
      const { ref, activity } = await loadPlan(deps, p.planId);
      await authz.require(ctx, "manage", ref);
      await provision(ctx, p.planId, activity.platformCode);
      completed.push(p.planId);
    }
    return { completed };
  }

  async function show(ctx: AuthContext, planId: bigint) {
    await authz.require(ctx, "read");
    const { plan, ref, activity } = await loadPlan(deps, planId);
    await authz.require(ctx, "read", ref);
    const versions = await db
      .select({ version: judgementPlanVersions.version, status: judgementPlanVersions.status, wizardStep: judgementPlanVersions.wizardStep, publishedAt: judgementPlanVersions.publishedAt, basedOnVersion: judgementPlanVersions.basedOnVersion })
      .from(judgementPlanVersions)
      .where(eq(judgementPlanVersions.planId, planId))
      .orderBy(desc(judgementPlanVersions.version));
    return { plan, versions, activityPlan: { planId: activity.planId, status: activity.status, platform: activity.platformCode } };
  }

  /** 列表：只含活动计划未进回收站、且在调用方范围内的判定计划。 */
  async function list(ctx: AuthContext, filter: { activityPlanId?: bigint; status?: PlanRow["status"] } = {}): Promise<PlanRow[]> {
    await authz.require(ctx, "read");
    const conds = [filter.activityPlanId === undefined ? undefined : eq(judgementPlans.activityPlanId, filter.activityPlanId), filter.status === undefined ? undefined : eq(judgementPlans.status, filter.status)].filter((c) => c !== undefined);
    const rows = await db.select().from(judgementPlans).where(conds.length ? and(...conds) : undefined).orderBy(desc(judgementPlans.planId));
    const activities = await facts.activityPlansOf([...new Set(rows.map((r) => r.activityPlanId))]);
    const out: PlanRow[] = [];
    for (const r of rows) {
      const a = activities.get(r.activityPlanId);
      if (!a || a.status === "deleted") continue;
      try {
        await authz.require(ctx, "read", { brandId: a.brandId, branchIds: await facts.joinedBranchIds(a.planId), planCreatorActor: a.createdByActor });
        out.push(r);
      } catch (e) {
        if (!(e instanceof JudgementError) || e.category !== "not_found") throw e; // 越范围的不出现；其余错误不吞
      }
    }
    return out;
  }

  /** 归档 / 取消归档：归档后不可新建草稿与执行，历史可读；不改任何版本与结果。 */
  async function setArchived(ctx: AuthContext, planId: bigint, archived: boolean): Promise<void> {
    await authz.require(ctx, "manage");
    const { plan, ref } = await loadPlan(deps, planId);
    await authz.require(ctx, "manage", ref);
    if (plan.status === "provisioning") throw new JudgementError("conflict", "plan_provisioning", "判定计划尚未建好，请先对账");
    const want = archived ? "archived" : "active";
    if (plan.status === want) return;
    await db.transaction(async (tx) => {
      await tx.update(judgementPlans).set({ status: want, updatedAt: clock.now() }).where(eq(judgementPlans.planId, planId));
      await audit.record({ event: archived ? "plan_archived" : "plan_unarchived", actor: ctx.actor, actorUserId: ctx.userId, planId }, tx);
    });
  }

  return { create, reconcile, show, list, archive: (ctx: AuthContext, planId: bigint) => setArchived(ctx, planId, true), unarchive: (ctx: AuthContext, planId: bigint) => setArchived(ctx, planId, false) };
}
export type Plans = ReturnType<typeof createPlans>;
