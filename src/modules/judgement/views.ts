// 页面的查询服务（design §15）：页面只经这里与各 Module 取数，不直接查 A / C 的表。
// 授权全部复用既有的 authz（读 = Capability + 范围；越范围的对象表现为不存在）；这里只做「拼装」，不新增判断规则。
// 对外的 ID 一律是十进制字符串（页面 URL 与客户端组件用），时间是 Date（服务端组件内使用，传给客户端前自行格式化）。
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { judgementPlanVersions, judgementRuns, runContents, runParticipants } from "../../db/schema";
import { constraintOf, type AuthContext } from "../access-control";
import { parseConfig, type Config } from "./config";
import { JudgementError } from "./errors";
import type { JudgementPlanRef } from "./authz";
import { outcomeWhere, type Outcomes } from "./outcomes";
import { loadPlan, type JudgementDeps, type Plans } from "./plans";
import type { Runs, TrialAbilityReport } from "./runs";
import type { Versions } from "./versions";

export interface ExecutionBrief {
  runId: string;
  version: number;
  status: string;
  phase: string | null;
  waitingOn: "demand" | "signals" | "collection" | null;
  /** 等待列表采集时：还有多少个账号在采集、等待截止时间（ISO）；其他情况 null。 */
  collectWait: { pendingAccounts: number; deadline: string | null } | null;
  lastErrorCode: string | null;
  participants: number | null;
  contentTotal: number | null;
  c1: number | null;
  startedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  outcomes: { success: number; notMet: number; unobtained: number } | null;
  c2: number | null;
  c3: number | null;
  staleUsed: boolean;
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

/** 圈定结果摘要（第 1 页）。 */
export interface CircleBrief {
  runId: string;
  generatedAt: Date | null;
  c1: number;
  participants: number;
  contents: number;
  unobtained: number;
  byReason: Record<string, number>;
}
export interface TrialAbilityView extends Omit<TrialAbilityReport, "samples"> {
  samples: string[][];
}
export interface TrialBrief {
  generatedAt: Date | null;
  c1: number;
  abilities: TrialAbilityView[];
}
export interface WizardView {
  detail: PlanDetail;
  /** 当前可进入的最远一页：第 2 页没有能力时，圈定后即可进第 3 页 */
  current: 1 | 2 | 3;
  circle: CircleBrief | null;
  trial: TrialBrief | null;
  /** abilityId → 标准图 / 元素图是否已上传 */
  uploaded: Record<string, boolean>;
  /** 草稿版本上还在排队 / 执行中的试跑（页面据此轮询）；终态失败时带稳定错误码 */
  trialRun: { status: string; lastErrorCode: string | null } | null;
  /** 第 3 页：能否确认执行及阻塞项（稳定码）；没有执行权限时为 null */
  publish: { ready: boolean; blockers: string[] } | null;
}
export interface ExecutionRow extends ExecutionBrief {
  planId: string;
  alias: string;
}
export interface ExecutionDetail {
  run: ExecutionBrief;
  planId: string;
  alias: string;
  planStatus: string;
  canAct: boolean;
  canReadContent: boolean;
  submittedBy: string;
  window: { from: string; to: string | null } | null;
  syncIncomplete: number;
  /** 同步不完整的专员里，因「还在采集」（执行时账号的列表任务还没跑完）而不完整的人数。 */
  syncPending: number;
  contentsPruned: boolean;
}
export type ParticipantFilter = "all" | "success" | "not_met" | "unobtained" | "sync";
export interface ParticipantRow {
  staffId: string;
  name: string;
  store: string;
  branch: string;
  total: number | null;
  c1: number | null;
  c2: number | null;
  c3: number | null;
  p: number | null;
  u: number | null;
  f: number | null;
  contentResult: string | null;
  commentResult: string | null;
  accountResult: string | null;
  planResult: string | null;
  primaryReason: string | null;
  syncComplete: boolean | null;
  syncReason: string | null;
  stale: boolean;
}
export interface StaffContentRow {
  contentId: string;
  publishedAt: Date | null;
  l1: string | null;
  l2: string | null;
  l3: string | null;
  final: string | null;
  reason: string | null;
  stale: boolean;
  selected: boolean | null;
}

export function createViews(deps: JudgementDeps & { plans: Plans; runs: Runs; versions: Versions; outcomes: Outcomes }) {
  const { db, facts, authz } = deps;
  const waitingOn = (phaseDetail: unknown): ExecutionBrief["waitingOn"] => {
    // 运行器写的是驼峰 waitingOn；此前这里读蛇形 waiting_on，永远是 null，页面的「等待采集 / 等待识别」状态一直没显示（2026-11-20 修复）
    const w = (phaseDetail as { waitingOn?: string; waiting_on?: string } | null)?.waitingOn ?? (phaseDetail as { waiting_on?: string } | null)?.waiting_on;
    return w === "demand" || w === "signals" || w === "collection" ? w : null;
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
    collectWait: r.status === "waiting" && waitingOn(r.phaseDetail) === "collection" ? { pendingAccounts: Number((r.phaseDetail as { pendingAccounts?: number }).pendingAccounts ?? 0), deadline: (r.phaseDetail as { waitDeadline?: string }).waitDeadline ?? null } : null,
    lastErrorCode: r.lastErrorCode,
    participants: r.participantCount,
    contentTotal: r.contentTotal,
    c1: r.c1Count,
    startedAt: r.startedAt,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    outcomes: r.status === "completed" ? (outcomes.get(r.runId) ?? { success: 0, notMet: 0, unobtained: 0 }) : null,
    c2: r.c2Count,
    c3: r.c3Count,
    staleUsed: r.staleUsed,
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

  // ---- 向导（任务 14） -------------------------------------------------------------------------------------
  /** 向导页数据：没有草稿返回 null（页面回详情）。越范围 / 无读权限与详情一致。 */
  async function wizard(ctx: AuthContext, planId: bigint): Promise<WizardView | null> {
    const d = await detail(ctx, planId);
    const draft = d.draft;
    if (!draft || !d.shown || d.shown.status === "published") return null;
    const cfg = d.shown.config;
    const noL2 = cfg.layer2.abilities.length === 0;
    const current: 1 | 2 | 3 = draft.wizardStep === "compared" ? 3 : draft.wizardStep === "circled" ? (noL2 ? 3 : 2) : 1;
    let circle: CircleBrief | null = null;
    if (draft.wizardStep !== "draft") {
      const [run] = await db.select().from(judgementRuns).where(and(eq(judgementRuns.planId, planId), eq(judgementRuns.version, draft.version), eq(judgementRuns.runKind, "circle"), eq(judgementRuns.status, "completed"))).orderBy(desc(judgementRuns.runId)).limit(1);
      if (run) {
        const sum = await deps.runs.summaryOf(run.runId);
        circle = { runId: String(run.runId), generatedAt: run.completedAt, c1: sum.c1, participants: sum.participants, contents: sum.contents, unobtained: sum.unobtained, byReason: sum.byReason };
      }
    }
    let trial: TrialBrief | null = null;
    let uploaded: Record<string, boolean> = {};
    let publish: WizardView["publish"] = null;
    // 试跑结果与素材状态是「读」：只读角色也能看到向导里已有的内容；只有确认执行的预览需要执行权限
    if (draft.wizardStep === "compared") {
      try {
        const rep = await deps.runs.trialReport(ctx, planId);
        const [run] = await deps.runs.runRow(rep.runId);
        trial = { generatedAt: run?.completedAt ?? null, c1: rep.c1, abilities: rep.abilities.map((a) => ({ ...a, samples: a.samples.map((b) => b.map(String)) })) };
      } catch (e) {
        if (!(e instanceof JudgementError)) throw e;
      }
    }
    uploaded = Object.fromEntries(cfg.layer2.abilities.map((a) => [a.abilityId, a.kind === "image_element" ? a.elementKey !== undefined : false]));
    if (cfg.layer2.abilities.some((a) => a.kind === "whole_image")) {
      try {
        const shown = (await deps.signals.segments.show(await authz.toSignalActor(ctx), { planId, version: draft.version })) as unknown as { images: Array<{ kind: string; target: string }> };
        for (const a of cfg.layer2.abilities) if (a.kind === "whole_image") uploaded[a.abilityId] = shown.images.some((i) => i.kind === "template" && i.target === a.target);
      } catch {
        // C 暂时读不到：按未上传显示，不挡页面；上传 / 试跑时 C 会给出确定的错误
      }
    }
    if (d.canWrite && current === 3) {
      try {
        const p = await deps.versions.previewPublish(ctx, planId);
        publish = { ready: p.ready, blockers: p.blockers.map((b) => b.code) };
      } catch (e) {
        if (!(e instanceof JudgementError)) publish = { ready: false, blockers: ["not_executable"] }; // C 读不到：按「现在不能执行」显示，不让页面 500
      }
    }
    const [tr] = await db.select().from(judgementRuns).where(and(eq(judgementRuns.planId, planId), eq(judgementRuns.version, draft.version), eq(judgementRuns.runKind, "compare"))).orderBy(desc(judgementRuns.runId)).limit(1);
    const trialRun = tr && tr.status !== "completed" && tr.status !== "cancelled" ? { status: tr.status, lastErrorCode: tr.lastErrorCode } : null;
    return { detail: d, current, circle, trial, uploaded, trialRun, publish };
  }

  // ---- 执行记录（任务 15） ---------------------------------------------------------------------------------
  /** 范围内全部判定计划的执行记录，最近在前（最多 200 条）。 */
  async function executions(ctx: AuthContext): Promise<ExecutionRow[]> {
    const plans = await list(ctx);
    if (plans.length === 0) return [];
    const byId = new Map(plans.map((p) => [p.planId, p]));
    const runs = (await executionsOf([...byId.keys()].map(BigInt))).slice(0, 200);
    const outcomes = await outcomesOf(runs.filter((r) => r.status === "completed").map((r) => r.runId));
    return runs.map((r) => ({ ...briefOf(r, outcomes), planId: String(r.planId), alias: byId.get(String(r.planId))?.alias ?? "" }));
  }
  async function runOf(ctx: AuthContext, runId: bigint) {
    await deps.runs.show(ctx, runId); // 授权：read + 范围；越范围 = 不存在
    const [row] = await db.select().from(judgementRuns).where(eq(judgementRuns.runId, runId));
    if (!row || row.runKind !== "execution") throw new JudgementError("not_found", "execution_not_found", "没有这个执行");
    return row;
  }
  async function executionDetail(ctx: AuthContext, runId: bigint): Promise<ExecutionDetail> {
    const row = await runOf(ctx, runId);
    const { plan, ref } = await loadPlan(deps, row.planId);
    let canAct = false;
    try {
      await authz.require(ctx, "execute", ref);
      canAct = plan.status === "active";
    } catch (e) {
      if (!(e instanceof JudgementError)) throw e;
    }
    const outcomes = await outcomesOf(row.status === "completed" ? [row.runId] : []);
    const [bad] = await db.select({ n: sql<number>`COUNT(*)` }).from(runParticipants).where(and(eq(runParticipants.runId, runId), eq(runParticipants.syncComplete, false)));
    const [pending] = await db.select({ n: sql<number>`COUNT(*)` }).from(runParticipants).where(and(eq(runParticipants.runId, runId), eq(runParticipants.syncReason, "sync_pending")));
    const frozen = row.frozen as { window?: { from: string; to?: string } } | null;
    return {
      run: briefOf(row, outcomes),
      planId: String(row.planId),
      alias: plan.alias,
      planStatus: plan.status,
      canAct,
      canReadContent: ctx.capabilities.has("data.content.read"),
      submittedBy: row.submittedByActor,
      window: frozen?.window ? { from: frozen.window.from, to: frozen.window.to ?? null } : null,
      syncIncomplete: Number(bad?.n ?? 0),
      syncPending: Number(pending?.n ?? 0),
      contentsPruned: Boolean((row.phaseDetail as { contentsPruned?: boolean } | null)?.contentsPruned),
    };
  }
  const participantFilter = (f: ParticipantFilter): SQL | undefined =>
    f === "sync" ? eq(runParticipants.syncComplete, false) : f === "all" ? undefined : eq(runParticipants.planResult, f);
  /** 参与专员（分页，按专员范围裁剪；只含已完成的执行）。 */
  async function participants(ctx: AuthContext, runId: bigint, o: { filter: ParticipantFilter; offset: number; limit: number }): Promise<{ total: number; rows: ParticipantRow[] }> {
    const row = await runOf(ctx, runId);
    if (row.status !== "completed") return { total: 0, rows: [] };
    const scope = outcomeWhere(constraintOf(ctx.scope));
    if (!scope) return { total: 0, rows: [] };
    const where = and(eq(runParticipants.runId, runId), scope, participantFilter(o.filter));
    const [t] = await db.select({ n: sql<number>`COUNT(*)` }).from(runParticipants).where(where);
    const rows = await db
      .select()
      .from(runParticipants)
      .where(where)
      // 不达标在前，其次未获取成功，最后成功：先看需要处理的人
      .orderBy(sql`FIELD(${runParticipants.planResult}, 'not_met', 'unobtained', 'success')`, asc(runParticipants.accountId))
      .limit(o.limit)
      .offset(o.offset);
    const labels = await facts.staffLabelsOf(rows.map((r) => r.staffId));
    return {
      total: Number(t?.n ?? 0),
      rows: rows.map((r) => {
        const l = labels.get(r.staffId);
        return {
          staffId: String(r.staffId),
          name: l?.staffName ?? "—",
          store: l?.storeName ?? "—",
          branch: l?.branchName ?? "—",
          total: r.contentTotal,
          c1: r.c1Count,
          c2: r.c2Count,
          c3: r.c3Count,
          p: r.contentPass,
          u: r.contentUnobtained,
          f: r.contentFail,
          contentResult: r.contentResult,
          commentResult: r.commentResult,
          accountResult: r.accountResult,
          planResult: r.planResult,
          primaryReason: r.primaryReason,
          syncComplete: r.syncComplete,
          syncReason: r.syncReason,
          stale: r.staleUsed,
        };
      }),
    };
  }
  /** 证据抽屉：一位专员的逐层结果。内容级行需要 data.content.read；不含内容与评论原文。 */
  async function staffEvidence(ctx: AuthContext, runId: bigint, staffId: bigint): Promise<{ participant: ParticipantRow; contents: StaffContentRow[] | null; pruned: boolean; truncated: boolean }> {
    const run = await runOf(ctx, runId);
    const scope = outcomeWhere(constraintOf(ctx.scope));
    const [p] = scope ? await db.select().from(runParticipants).where(and(eq(runParticipants.runId, runId), eq(runParticipants.staffId, staffId), scope)) : [];
    if (!p) throw new JudgementError("not_found", "explain_target_not_found", "没有找到");
    const labels = await facts.staffLabelsOf([p.staffId]);
    const l = labels.get(p.staffId);
    const participant: ParticipantRow = {
      staffId: String(p.staffId), name: l?.staffName ?? "—", store: l?.storeName ?? "—", branch: l?.branchName ?? "—", total: p.contentTotal, c1: p.c1Count, c2: p.c2Count, c3: p.c3Count, p: p.contentPass, u: p.contentUnobtained, f: p.contentFail,
      contentResult: p.contentResult, commentResult: p.commentResult, accountResult: p.accountResult, planResult: p.planResult, primaryReason: p.primaryReason, syncComplete: p.syncComplete, syncReason: p.syncReason, stale: p.staleUsed,
    };
    const pruned = Boolean((run.phaseDetail as { contentsPruned?: boolean } | null)?.contentsPruned);
    if (!ctx.capabilities.has("data.content.read") || pruned) return { participant, contents: null, pruned, truncated: false };
    const LIMIT = 200;
    const rows = await db.select().from(runContents).where(and(eq(runContents.runId, runId), eq(runContents.accountId, p.accountId))).orderBy(asc(runContents.contentId)).limit(LIMIT + 1);
    return {
      participant,
      pruned,
      truncated: rows.length > LIMIT,
      contents: rows.slice(0, LIMIT).map((r) => ({ contentId: String(r.contentId), publishedAt: r.publishedAt, l1: r.l1, l2: r.l2, l3: r.l3, final: r.final, reason: r.reasonCode, stale: r.stale, selected: r.layer1Selected })),
    };
  }
  return { list, creatableActivityPlans, detail, wizard, executions, executionDetail, participants, staffEvidence };
}
export type Views = ReturnType<typeof createViews>;
