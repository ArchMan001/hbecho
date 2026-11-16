// 页面的查询服务（design §15）：页面只经这里与各 Module 取数，不直接查 A / C 的表。
// 授权全部复用既有的 authz（读 = Capability + 范围；越范围的对象表现为不存在）；这里只做「拼装」，不新增判断规则。
// 对外的 ID 一律是十进制字符串（页面 URL 与客户端组件用），时间是 Date（服务端组件内使用，传给客户端前自行格式化）。
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { judgementPlanVersions, judgementRuns, runParticipants } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { parseConfig, type Config } from "./config";
import { JudgementError } from "./errors";
import type { JudgementPlanRef } from "./authz";
import { loadPlan, type JudgementDeps, type Plans } from "./plans";

export interface ExecutionBrief {
  runId: string;
  version: number;
  status: string;
  phase: string | null;
  waitingOn: "demand" | "signals" | null;
  lastErrorCode: string | null;
  participants: number | null;
  contentTotal: number | null;
  c1: number | null;
  startedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  outcomes: { success: number; notMet: number; unobtained: number } | null;
}
export interface PlanListItem {
  planId: string;
  alias: string;
  description: string | null;
  status: string;
  activityPlan: { id: string; name: string; brandCode: string; brandName: string; platform: string };
  draft: { version: number; wizardStep: string; publishing: boolean } | null;
  publishedVersion: number | null;
  latestExecution: ExecutionBrief | null;
  updatedAt: Date;
}
export interface PlanDetail extends PlanListItem {
  canWrite: boolean;
  createdByActor: string;
  createdAt: Date;
  activity: { status: string; startsOn: string; endsOn: string | null };
  versions: Array<{ version: number; status: string; wizardStep: string; basedOnVersion: number | null; publishedAt: Date | null; createdAt: Date }>;
  /** 显示的版本：有草稿显示草稿，否则最近已发布版本 */
  shown: { version: number; status: string; config: Config } | null;
  executions: ExecutionBrief[];
}

export function createViews(deps: JudgementDeps & { plans: Plans }) {
  const { db, facts, authz } = deps;
  const waitingOn = (phaseDetail: unknown): ExecutionBrief["waitingOn"] => {
    const w = (phaseDetail as { waiting_on?: string } | null)?.waiting_on;
    return w === "demand" || w === "signals" ? w : null;
  };
  async function outcomesOf(runIds: readonly bigint[]): Promise<Map<bigint, { success: number; notMet: number; unobtained: number }>> {
    const out = new Map<bigint, { success: number; notMet: number; unobtained: number }>();
    if (runIds.length === 0) return out;
    const rows = await db
      .select({ runId: runParticipants.runId, result: runParticipants.planResult, n: sql<number>`COUNT(*)` })
      .from(runParticipants)
      .where(and(inArray(runParticipants.runId, [...runIds]), sql`${runParticipants.planResult} IS NOT NULL`))
      .groupBy(runParticipants.runId, runParticipants.planResult);
    for (const r of rows) {
      const cur = out.get(r.runId) ?? { success: 0, notMet: 0, unobtained: 0 };
      if (r.result === "success") cur.success = Number(r.n);
      else if (r.result === "not_met") cur.notMet = Number(r.n);
      else cur.unobtained = Number(r.n);
      out.set(r.runId, cur);
    }
    return out;
  }
  const briefOf = (r: typeof judgementRuns.$inferSelect, outcomes: Map<bigint, { success: number; notMet: number; unobtained: number }>): ExecutionBrief => ({
    runId: String(r.runId),
    version: r.version,
    status: r.status,
    phase: r.phase,
    waitingOn: r.status === "waiting" ? waitingOn(r.phaseDetail) : null,
    lastErrorCode: r.lastErrorCode,
    participants: r.participantCount,
    contentTotal: r.contentTotal,
    c1: r.c1Count,
    startedAt: r.startedAt,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    outcomes: r.status === "completed" ? (outcomes.get(r.runId) ?? { success: 0, notMet: 0, unobtained: 0 }) : null,
  });
  const executionsOf = (planIds: readonly bigint[]) =>
    db.select().from(judgementRuns).where(and(inArray(judgementRuns.planId, [...planIds]), eq(judgementRuns.runKind, "execution"))).orderBy(desc(judgementRuns.runId));

  async function activityBriefs(activityIds: readonly bigint[]) {
    const activities = await facts.activityPlansOf(activityIds);
    const brands = await facts.brandsOf([...new Set([...activities.values()].map((a) => a.brandId))]);
    return { activities, brands };
  }

  /** 列表：在调用方范围内的判定计划，带活动计划、版本状态与最近一次执行。 */
  async function list(ctx: AuthContext, filter: { activityPlanId?: bigint; status?: "active" | "archived" } = {}): Promise<PlanListItem[]> {
    const plans = await deps.plans.list(ctx, { ...(filter.activityPlanId === undefined ? {} : { activityPlanId: filter.activityPlanId }), ...(filter.status === undefined ? {} : { status: filter.status }) });
    if (plans.length === 0) return [];
    const ids = plans.map((p) => p.planId);
    const { activities, brands } = await activityBriefs([...new Set(plans.map((p) => p.activityPlanId))]);
    const versions = await db.select().from(judgementPlanVersions).where(inArray(judgementPlanVersions.planId, ids)).orderBy(desc(judgementPlanVersions.version));
    const runs = await executionsOf(ids);
    const latest = new Map<bigint, (typeof runs)[number]>();
    for (const r of runs) if (!latest.has(r.planId)) latest.set(r.planId, r); // runs 已按 ID 倒序
    const outcomes = await outcomesOf([...latest.values()].filter((r) => r.status === "completed").map((r) => r.runId));
    return plans.map((p) => {
      const a = activities.get(p.activityPlanId)!;
      const b = brands.get(a.brandId);
      const vs = versions.filter((v) => v.planId === p.planId);
      const draft = vs.find((v) => v.status === "draft" || v.status === "publishing");
      const published = vs.find((v) => v.status === "published");
      const run = latest.get(p.planId);
      return {
        planId: String(p.planId),
        alias: p.alias,
        description: p.description,
        status: p.status,
        activityPlan: { id: String(a.planId), name: a.planName, brandCode: b?.code ?? "", brandName: b?.name ?? "", platform: a.platformCode },
        draft: draft ? { version: draft.version, wizardStep: draft.wizardStep, publishing: draft.status === "publishing" } : null,
        publishedVersion: published?.version ?? null,
        latestExecution: run ? briefOf(run, outcomes) : null,
        updatedAt: p.updatedAt,
      };
    });
  }

  /** 新建弹窗：调用方能为之新建判定计划的活动计划（采集中，且写权限通过——即创建者或超管）。 */
  async function creatableActivityPlans(ctx: AuthContext): Promise<Array<{ id: string; name: string; brandName: string; platform: string }>> {
    await authz.require(ctx, "manage");
    const all = await facts.collectingPlans();
    const brands = await facts.brandsOf([...new Set(all.map((a) => a.brandId))]);
    const out: Array<{ id: string; name: string; brandName: string; platform: string }> = [];
    for (const a of all) {
      const ref: JudgementPlanRef = { brandId: a.brandId, branchIds: await facts.joinedBranchIds(a.planId), planCreatorActor: a.createdByActor };
      try {
        await authz.require(ctx, "manage", ref);
      } catch (e) {
        if (e instanceof JudgementError && (e.category === "not_found" || e.category === "authorization")) continue; // 范围外、不是创建者：不出现在下拉里
        throw e;
      }
      out.push({ id: String(a.planId), name: a.planName, brandName: brands.get(a.brandId)?.name ?? "", platform: a.platformCode });
    }
    return out;
  }

  /** 详情：越范围 = 不存在（plans.show 的授权）；canWrite 只用于页面决定显示哪些按钮，动作自己还会再判一次。 */
  async function detail(ctx: AuthContext, planId: bigint): Promise<PlanDetail> {
    const shown = await deps.plans.show(ctx, planId); // 授权：read + 范围
    const [item] = await list(ctx, { activityPlanId: shown.plan.activityPlanId }).then((xs) => xs.filter((x) => x.planId === String(planId)));
    if (!item) throw new JudgementError("not_found", "judgement_plan_not_found", "判定计划不存在");
    const [activity] = [...(await facts.activityPlansOf([shown.plan.activityPlanId])).values()];
    const vrows = await db.select().from(judgementPlanVersions).where(eq(judgementPlanVersions.planId, planId)).orderBy(desc(judgementPlanVersions.version));
    const runs = (await executionsOf([planId])).slice(0, 20);
    const outcomes = await outcomesOf(runs.filter((r) => r.status === "completed").map((r) => r.runId));
    const view = vrows.find((v) => v.status !== "published") ?? vrows[0];
    let canWrite = false;
    try {
      const { ref } = await loadPlan(deps, planId);
      await authz.require(ctx, "manage", ref);
      canWrite = true;
    } catch (e) {
      if (!(e instanceof JudgementError)) throw e;
    }
    return {
      ...item,
      canWrite,
      createdByActor: shown.plan.createdByActor,
      createdAt: shown.plan.createdAt,
      activity: { status: activity?.status ?? "", startsOn: activity?.startsOn ?? "", endsOn: activity?.endsOn ?? null },
      versions: vrows.map((v) => ({ version: v.version, status: v.status, wizardStep: v.wizardStep, basedOnVersion: v.basedOnVersion, publishedAt: v.publishedAt, createdAt: v.createdAt })),
      shown: view ? { version: view.version, status: view.status, config: parseConfig(view.config) } : null,
      executions: runs.map((r) => briefOf(r, outcomes)),
    };
  }
  return { list, creatableActivityPlans, detail };
}
export type Views = ReturnType<typeof createViews>;
