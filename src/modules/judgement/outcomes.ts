// 对 E 的只读口 JudgementOutcomeReader（JP-16）、解释 explain（JP-14）与保留清理 maintain（design §7.13）。
// E 不 JOIN D 的表；只对 completed 的执行可见；回收站里的活动计划的结果不可见；组织链取自冻结值（执行后改绑 / 换店不变）。
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { judgementPlanVersions, judgementPlans, judgementRuns, runContents, runParticipants } from "../../db/schema";
import { constraintOf, type AuthContext, type ResourceConstraint } from "../access-control";
import type { Clock } from "../raw-capture/ports";
import { conditionsOf, contentRequirementEnabled, contentThresholdN, parseConfig, type ConditionDesc } from "./config";
import type { AbilityResult } from "./engine/pure/ability";
import type { JudgementConfig } from "./env";
import { JudgementError } from "./errors";
import type { Facts } from "./facts";
import { loadPlan, type JudgementDeps } from "./plans";
import type { JudgementPlanRef } from "./authz";
import { createRunOps, type RunOps } from "./run-ops";

export interface ExecutionDescriptor {
  executionId: bigint;
  planId: bigint;
  version: number;
  planAlias: string;
  activityPlanId: bigint;
  platform: string;
  window: { from: string; to?: string; fromUtc: string; toUtc: string };
  frozenAt: Date;
  completedAt: Date;
  /** 数据截止：冻结时刻 */
  cutoffAt: Date;
  participantCount: number;
  c1: number;
  c2: number;
  c3: number;
  contentTotal: number;
  staleUsed: boolean;
  config: {
    quantity: number | null;
    contentRequirementEnabled: boolean;
    contentThresholdN: number;
    abilities: Array<{ abilityId: string; kind: string; target: string; threshold: string; alias: string | null }>;
    commentMethod: unknown;
    /** 每个可展示条件的清单（层序；key 与 evidence 的编号一一对应）；下游「每个条件一列」用（JP-22） */
    conditions: ConditionDesc[];
  };
}
type Part = typeof runParticipants.$inferSelect;
export interface ParticipantFact {
  executionId: bigint;
  staffId: bigint;
  accountId: bigint;
  org: { regionId: bigint; branchId: bigint; sectorId: bigint; storeId: bigint; dealerId: bigint; brandId: bigint };
  results: { content: string | null; comment: string | null; account: string | null; plan: string };
  counts: { p: number | null; u: number | null; f: number | null; t: number | null; skipped: number | null; c1: number | null; c2: number | null; c3: number | null; commentTotal: number | null; commentPass: number | null; commentUnobtained: number | null };
  primaryReason: string | null;
  reasonDetail: unknown;
  syncComplete: boolean | null;
  syncReason: string | null;
  staleUsed: boolean;
  /** 每个条件一个结果（D-D23）；旧执行（早于 JP-22）为 null */
  abilityResults: AbilityResult[] | null;
}
type Row = typeof runContents.$inferSelect;
/** 内容证据白名单：只有状态、命中的配置关键词 / 话题、秒数、分数、结论；不含正文、评论原文、作者、第 3 层的模型理由与依赖明细。 */
export interface ContentEvidence {
  l1?: Array<{ idx: number; state: string; hit?: string[]; seconds?: string; reason?: string }>;
  l2?: Array<{ id: string; state: string; score?: string; reason?: string }>;
  l3?: { state: string; verdict?: "meets" | "not_meets" };
}
export interface ContentFact {
  executionId: bigint;
  accountId: bigint;
  contentId: bigint;
  /** 本次执行冻结的内容快照（标题、互动值等由下游按它读，不读 current） */
  contentSnapshotId: bigint;
  staffId: bigint;
  org: { regionId: bigint; branchId: bigint; sectorId: bigint; storeId: bigint; dealerId: bigint; brandId: bigint };
  evidence: ContentEvidence;
  publishedAt: Date | null;
  like: { value: bigint | null; state: string };
  layer1: { selected: boolean | null; rank: number | null };
  layers: { l0: string | null; l1: string | null; l2: string | null; l3: string | null };
  /** pass / fail / unobtained / skipped（skipped = 第 1 层数量要求没选中，原因 layer1_not_selected） */
  final: string | null;
  stopLayer: string | null;
  reasonCode: string | null;
  stale: boolean;
  comments: { total: number | null; pass: number | null; unobtained: number | null };
}
export type CircleRow = ContentFact;
/** 组织过滤：按冻结的组织链；staffIds 为空数组表示没有任何专员（返回空，不是不过滤）。 */
export interface OrgFilter {
  regionId?: bigint;
  branchId?: bigint;
  sectorId?: bigint;
  storeId?: bigint;
  staffIds?: readonly bigint[];
}
const PAGE = 500;
const LIST_MAX = 1000;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const strs = (x: unknown): string[] | undefined => (Array.isArray(x) && x.every((v) => typeof v === "string") ? (x as string[]) : undefined);
/** 白名单投影：只放行已知字段，其余一律丢弃（证据里将来加字段也不会默认外泄）。 */
export function publicEvidence(raw: unknown): ContentEvidence {
  const out: ContentEvidence = {};
  if (!isObj(raw)) return out;
  if (Array.isArray(raw.l1)) {
    out.l1 = raw.l1.filter(isObj).map((e) => ({ idx: Number(e.idx), state: String(e.state), ...(strs(e.hit) ? { hit: strs(e.hit)! } : {}), ...(typeof e.seconds === "string" ? { seconds: e.seconds } : {}), ...(typeof e.reason === "string" ? { reason: e.reason } : {}) }));
  }
  const abilities = isObj(raw.l2) ? raw.l2.abilities : undefined;
  if (Array.isArray(abilities)) {
    out.l2 = abilities.filter(isObj).map((e) => ({ id: String(e.id), state: String(e.state), ...(typeof e.score === "string" ? { score: e.score } : {}), ...(typeof e.reason === "string" ? { reason: e.reason } : {}) }));
  }
  if (isObj(raw.l3)) out.l3 = { state: String(raw.l3.state), ...(raw.l3.verdict === "meets" || raw.l3.verdict === "not_meets" ? { verdict: raw.l3.verdict } : {}) };
  return out;
}
const filterWhere = (f: OrgFilter): SQL | undefined =>
  and(
    f.regionId === undefined ? undefined : eq(runParticipants.regionId, f.regionId),
    f.branchId === undefined ? undefined : eq(runParticipants.branchId, f.branchId),
    f.sectorId === undefined ? undefined : eq(runParticipants.sectorId, f.sectorId),
    f.storeId === undefined ? undefined : eq(runParticipants.storeId, f.storeId),
    f.staffIds === undefined ? undefined : f.staffIds.length ? inArray(runParticipants.staffId, [...f.staffIds]) : sql`1 = 0`,
  );
const orgOrder = [asc(runParticipants.brandId), asc(runParticipants.regionId), asc(runParticipants.branchId), asc(runParticipants.sectorId), asc(runParticipants.storeId), asc(runParticipants.staffId)];
const clampPage = (p: { offset: number; limit: number }) => ({ offset: Math.max(0, Math.floor(p.offset)), limit: Math.min(LIST_MAX, Math.max(0, Math.floor(p.limit))) });

export const outcomeWhere = (c: ResourceConstraint): SQL | null => {
  if (c.empty) return null;
  const parts: SQL[] = [];
  if (c.brands !== "all") parts.push(c.brands.length ? inArray(runParticipants.brandId, [...c.brands]) : sql`1 = 0`);
  if (c.branches !== "all") parts.push(c.branches.length ? inArray(runParticipants.branchId, [...c.branches]) : sql`1 = 0`);
  if (c.self) parts.push(eq(runParticipants.staffId, c.self.mediaStaffId));
  return parts.length ? (and(...parts) as SQL) : sql`1 = 1`;
};

export function createOutcomes(deps: JudgementDeps & { config: JudgementConfig; ops?: RunOps }) {
  const { db, clock, facts, authz } = deps;
  const ops = deps.ops ?? createRunOps(db);

  async function describeRows(rows: Array<typeof judgementRuns.$inferSelect>): Promise<ExecutionDescriptor[]> {
    if (rows.length === 0) return [];
    const plans = await db.select().from(judgementPlans).where(inArray(judgementPlans.planId, [...new Set(rows.map((r) => r.planId))]));
    const byPlan = new Map(plans.map((p) => [p.planId, p]));
    const live = await facts.liveActivityPlans([...new Set(plans.map((p) => p.activityPlanId))]);
    const out: ExecutionDescriptor[] = [];
    for (const r of rows) {
      const p = byPlan.get(r.planId)!;
      if (!live.has(p.activityPlanId)) continue; // 回收站里的活动计划：结果不可见，恢复后可见
      const [v] = await db.select().from(judgementPlanVersions).where(and(eq(judgementPlanVersions.planId, r.planId), eq(judgementPlanVersions.version, r.version)));
      const cfg = parseConfig(v!.config);
      const frozen = r.frozen as { frozenAt: string; window: ExecutionDescriptor["window"]; platform: string };
      out.push({
        executionId: r.runId,
        planId: r.planId,
        version: r.version,
        planAlias: p.alias,
        activityPlanId: p.activityPlanId,
        platform: frozen.platform,
        window: frozen.window,
        frozenAt: new Date(frozen.frozenAt),
        completedAt: r.completedAt!,
        cutoffAt: new Date(frozen.frozenAt),
        participantCount: r.participantCount ?? 0,
        c1: r.c1Count ?? 0,
        c2: r.c2Count ?? 0,
        c3: r.c3Count ?? 0,
        contentTotal: r.contentTotal ?? 0,
        staleUsed: r.staleUsed,
        config: {
          quantity: cfg.layer1.quantity?.n ?? null,
          contentRequirementEnabled: contentRequirementEnabled(cfg),
          contentThresholdN: contentThresholdN(cfg),
          abilities: cfg.layer2.abilities.map((a) => ({ abilityId: a.abilityId, kind: a.kind, target: a.target, threshold: a.threshold, alias: a.alias ?? null })),
          commentMethod: cfg.commentRequirement?.method ?? null,
          conditions: conditionsOf(cfg),
        },
      });
    }
    return out;
  }

  /** 轮询完成通知：游标是 (完成时间, ID)，不是 run_id——并行的执行完成顺序与创建顺序无关。 */
  async function listCompleted(after: { completedAt: Date; executionId: bigint } | null, limit: number): Promise<ExecutionDescriptor[]> {
    const out: ExecutionDescriptor[] = [];
    let cursor = after;
    while (out.length < limit) {
      const rows = await db
        .select()
        .from(judgementRuns)
        .where(and(eq(judgementRuns.runKind, "execution"), eq(judgementRuns.status, "completed"), cursor ? or(gt(judgementRuns.completedAt, cursor.completedAt), and(eq(judgementRuns.completedAt, cursor.completedAt), gt(judgementRuns.runId, cursor.executionId))) : undefined))
        .orderBy(asc(judgementRuns.completedAt), asc(judgementRuns.runId))
        .limit(limit);
      if (rows.length === 0) break;
      out.push(...(await describeRows(rows)));
      const last = rows[rows.length - 1]!;
      cursor = { completedAt: last.completedAt!, executionId: last.runId };
      if (rows.length < limit) break;
    }
    return out.slice(0, limit);
  }

  async function completedRun(executionId: bigint, kind: "execution" | "circle") {
    const [r] = await db.select().from(judgementRuns).where(eq(judgementRuns.runId, executionId));
    if (!r || r.runKind !== kind) throw new JudgementError("not_found", "execution_not_found", "没有这个执行");
    if (r.status !== "completed") throw new JudgementError("conflict", "execution_not_completed", "这次执行还没有完成（或已取消 / 失败），结果不可见");
    const [d] = await describeRows([r]);
    if (!d) throw new JudgementError("not_found", "execution_not_found", "没有这个执行");
    return { run: r, descriptor: d };
  }
  const describe = async (executionId: bigint): Promise<ExecutionDescriptor> => (await completedRun(executionId, "execution")).descriptor;

  const partFact = (r: Part): ParticipantFact => ({
    executionId: r.runId,
    staffId: r.staffId,
    accountId: r.accountId,
    org: { regionId: r.regionId, branchId: r.branchId, sectorId: r.sectorId, storeId: r.storeId, dealerId: r.dealerId, brandId: r.brandId },
    results: { content: r.contentResult, comment: r.commentResult, account: r.accountResult, plan: r.planResult ?? "unobtained" },
    counts: { p: r.contentPass, u: r.contentUnobtained, f: r.contentFail, t: r.contentTotal, skipped: r.contentSkipped, c1: r.c1Count, c2: r.c2Count, c3: r.c3Count, commentTotal: r.commentTotal, commentPass: r.commentPass, commentUnobtained: r.commentUnobtained },
    primaryReason: r.primaryReason,
    reasonDetail: r.reasonDetail,
    syncComplete: r.syncComplete,
    syncReason: r.syncReason,
    staleUsed: r.staleUsed,
    abilityResults: Array.isArray(r.abilityResults) ? (r.abilityResults as AbilityResult[]) : null,
  });
  const contentFact = (r: Row, p: Part): ContentFact => ({
    executionId: r.runId,
    accountId: r.accountId,
    contentId: r.contentId,
    contentSnapshotId: r.contentSnapshotId,
    staffId: p.staffId,
    org: { regionId: p.regionId, branchId: p.branchId, sectorId: p.sectorId, storeId: p.storeId, dealerId: p.dealerId, brandId: p.brandId },
    evidence: publicEvidence(r.evidence),
    publishedAt: r.publishedAt,
    like: { value: r.likeValue, state: r.likeState },
    layer1: { selected: r.layer1Selected, rank: r.layer1Rank },
    layers: { l0: r.l0, l1: r.l1, l2: r.l2, l3: r.l3 },
    final: r.final,
    stopLayer: r.stopLayer,
    reasonCode: r.reasonCode,
    stale: r.stale,
    comments: { total: r.cmTotal, pass: r.cmPass, unobtained: r.cmUnobtained },
  });

  async function* streamParticipants(executionId: bigint, constraint: ResourceConstraint, filter: OrgFilter = {}): AsyncGenerator<ParticipantFact> {
    await completedRun(executionId, "execution");
    const where = outcomeWhere(constraint);
    if (!where) return;
    let cursor: bigint | null = null;
    for (;;) {
      const rows: Part[] = await db.select().from(runParticipants).where(and(eq(runParticipants.runId, executionId), where, filterWhere(filter), cursor === null ? undefined : gt(runParticipants.accountId, cursor))).orderBy(asc(runParticipants.accountId)).limit(PAGE);
      for (const r of rows) yield partFact(r);
      if (rows.length < PAGE) return;
      cursor = rows[rows.length - 1]!.accountId;
    }
  }

  async function* pageContents(runId: bigint, constraint: ResourceConstraint, filter: OrgFilter = {}): AsyncGenerator<{ row: Row; part: Part }> {
    const where = outcomeWhere(constraint);
    if (!where) return;
    let cursor: bigint | null = null;
    for (;;) {
      const rows: Array<{ c: Row; p: Part }> = await db
        .select({ c: runContents, p: runParticipants })
        .from(runContents)
        .innerJoin(runParticipants, and(eq(runParticipants.runId, runContents.runId), eq(runParticipants.accountId, runContents.accountId)))
        .where(and(eq(runContents.runId, runId), where, filterWhere(filter), cursor === null ? undefined : gt(runContents.contentId, cursor)))
        .orderBy(asc(runContents.contentId))
        .limit(PAGE);
      for (const r of rows) yield { row: r.c, part: r.p };
      if (rows.length < PAGE) return;
      cursor = rows[rows.length - 1]!.c.contentId;
    }
  }
  async function* streamContents(executionId: bigint, constraint: ResourceConstraint, filter: OrgFilter = {}): AsyncGenerator<ContentFact> {
    const { run } = await completedRun(executionId, "execution");
    if ((run.phaseDetail as { contentsPruned?: boolean } | null)?.contentsPruned) throw new JudgementError("conflict", "content_rows_pruned", "这次执行的内容级结果已按保留期清理（参与专员与汇总仍保留）");
    for await (const r of pageContents(executionId, constraint, filter)) yield contentFact(r.row, r.part);
  }
  /** 第 1 页下载（经 E6）：圈定运行的全部行——被选中的、未选中的（skipped）、未通过 / 未获取的，都带结果与原因。 */
  async function* streamCircleRows(runId: bigint, constraint: ResourceConstraint): AsyncGenerator<CircleRow> {
    await completedRun(runId, "circle");
    for await (const r of pageContents(runId, constraint)) yield contentFact(r.row, r.part);
  }

  /**
   * 该判定计划已 completed 的执行，completed_at 倒序（e-metrics-lite JP-22）。回收站里的活动计划的结果不可见（与 describe 一致）。
   * 只读、不做能力校验：与 stream* 同构，由调用方负责 report.read 与范围约束。
   */
  async function executionsOf(planId: bigint): Promise<ExecutionDescriptor[]> {
    const rows = await db
      .select()
      .from(judgementRuns)
      .where(and(eq(judgementRuns.planId, planId), eq(judgementRuns.runKind, "execution"), eq(judgementRuns.status, "completed")))
      .orderBy(desc(judgementRuns.completedAt), desc(judgementRuns.runId));
    return describeRows(rows);
  }

  /**
   * 授权引用（JP-22）：判定计划不存在或所属活动计划在回收站 → not_found。
   * 没有调用者身份，**不判断范围**：越范围由调用方 authorize(report.read, ref) 表现为 not_found。
   */
  async function planRefOf(planId: bigint): Promise<{ ref: JudgementPlanRef; alias: string; activityPlanId: bigint; activityPlanName: string; platform: string }> {
    const { plan, ref, activity } = await loadPlan(deps, planId);
    return { ref, alias: plan.alias, activityPlanId: plan.activityPlanId, activityPlanName: activity.planName, platform: activity.platformCode };
  }

  /** 偏移分页的内容行（组织过滤 + 总数）；总数与列表共用同一个 WHERE。排序：冻结组织 ID，再发布时间倒序、内容 ID。 */
  async function listContents(executionId: bigint, constraint: ResourceConstraint, filter: OrgFilter, page: { offset: number; limit: number }): Promise<{ rows: ContentFact[]; total: number }> {
    const { run } = await completedRun(executionId, "execution");
    if ((run.phaseDetail as { contentsPruned?: boolean } | null)?.contentsPruned) throw new JudgementError("conflict", "content_rows_pruned", "这次执行的内容级结果已按保留期清理（参与专员与汇总仍保留）");
    const scope = outcomeWhere(constraint);
    if (!scope) return { rows: [], total: 0 };
    const where = and(eq(runContents.runId, executionId), scope, filterWhere(filter));
    const { offset, limit } = clampPage(page);
    const join = and(eq(runParticipants.runId, runContents.runId), eq(runParticipants.accountId, runContents.accountId));
    const [c] = await db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(runContents).innerJoin(runParticipants, join).where(where);
    if (limit === 0) return { rows: [], total: c?.n ?? 0 };
    const rows = await db
      .select({ c: runContents, p: runParticipants })
      .from(runContents)
      .innerJoin(runParticipants, join)
      .where(where)
      .orderBy(...orgOrder, desc(runContents.publishedAt), asc(runContents.contentId))
      .limit(limit)
      .offset(offset);
    return { rows: rows.map((r) => contentFact(r.c, r.p)), total: c?.n ?? 0 };
  }

  /** 偏移分页的参与专员行（组织过滤 + 总数）。 */
  async function listParticipants(executionId: bigint, constraint: ResourceConstraint, filter: OrgFilter, page: { offset: number; limit: number }): Promise<{ rows: ParticipantFact[]; total: number }> {
    await completedRun(executionId, "execution");
    const scope = outcomeWhere(constraint);
    if (!scope) return { rows: [], total: 0 };
    const where = and(eq(runParticipants.runId, executionId), scope, filterWhere(filter));
    const { offset, limit } = clampPage(page);
    const [c] = await db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(runParticipants).where(where);
    if (limit === 0) return { rows: [], total: c?.n ?? 0 };
    const rows = await db.select().from(runParticipants).where(where).orderBy(...orgOrder).limit(limit).offset(offset);
    return { rows: rows.map(partFact), total: c?.n ?? 0 };
  }

  /**
   * 解释：逐层逐条件输出「用了什么条件、输入、结论、跳过了哪层、为什么停」。调用方需 rule.definition.read + data.content.read，
   * 且专员 / 内容在其数据范围内（越范围表现为未找到）；内容原文不出现（证据自包含，不依赖 C 的结果行是否还在）。
   */
  async function explain(ctx: AuthContext, executionId: bigint, target: { contentId: bigint } | { staffId: bigint }) {
    await authz.require(ctx, "read");
    if (!ctx.capabilities.has("data.content.read")) throw new JudgementError("authorization", "denied_capability_not_granted", "没有查看内容证据的权限");
    const { run, descriptor } = await completedRun(executionId, "execution");
    const { ref } = await loadPlan(deps, run.planId);
    await authz.require(ctx, "read", ref);
    const where = outcomeWhere(constraintOf(ctx.scope));
    const notFound = () => new JudgementError("not_found", "explain_target_not_found", "没有找到");
    if (!where) throw notFound();
    if ("staffId" in target) {
      const [p] = await db.select().from(runParticipants).where(and(eq(runParticipants.runId, executionId), eq(runParticipants.staffId, target.staffId), where));
      if (!p) throw notFound();
      return { kind: "staff" as const, execution: descriptor, participant: partFact(p) };
    }
    const [r] = await db
      .select({ c: runContents, p: runParticipants })
      .from(runContents)
      .innerJoin(runParticipants, and(eq(runParticipants.runId, runContents.runId), eq(runParticipants.accountId, runContents.accountId)))
      .where(and(eq(runContents.runId, executionId), eq(runContents.contentId, target.contentId), where));
    if (!r) throw notFound();
    const f = contentFact(r.c, r.p);
    const ev = (r.c.evidence ?? {}) as Record<string, unknown>;
    const stoppedAt = f.stopLayer === null ? null : Number(f.stopLayer);
    return {
      kind: "content" as const,
      execution: descriptor,
      content: f,
      steps: [
        { layer: 0, name: "范围", result: f.layers.l0 },
        { layer: 1, name: "第 1 层条件", result: f.layers.l1, evidence: ev.l1 ?? null, ...(f.layer1.selected === null ? {} : { selection: { selected: f.layer1.selected, rank: f.layer1.rank, like: f.like } }) },
        { layer: 2, name: "第 2 层比对", result: f.layers.l2, evidence: ev.l2 ?? null },
        { layer: 3, name: "第 3 层判定", result: f.layers.l3, evidence: ev.l3 ?? null },
      ],
      stoppedAt,
      stopReason: f.reasonCode,
      dependencies: ev.dep ?? null,
      comments: ev.cm ?? null,
    };
  }

  /**
   * 保留与清理（每日 maintain；分块、幂等、可重复运行）：
   * ① 圈定 / 试跑运行期满（expires_at）整体删除；② 每个（计划，版本）只保留最近 K 个已完成执行的内容级行，更早的删内容级行并标记，
   * 参与专员行与汇总长期保留；③ 失败 / 取消的执行超过保留天数后删内容级行。
   */
  async function maintain(): Promise<{ expiredRuns: number; prunedExecutions: number; prunedFailed: number }> {
    const now = clock.now();
    const expired = await db.select({ id: judgementRuns.runId }).from(judgementRuns).where(and(isNotNull(judgementRuns.expiresAt), lt(judgementRuns.expiresAt, now), inArray(judgementRuns.status, ["completed", "failed", "cancelled"])));
    const gone = await ops.deleteRunsById(expired.map((r) => r.id));
    let pruned = 0;
    const done = await db.select().from(judgementRuns).where(and(eq(judgementRuns.runKind, "execution"), eq(judgementRuns.status, "completed"))).orderBy(desc(judgementRuns.completedAt), desc(judgementRuns.runId));
    const seen = new Map<string, number>();
    for (const r of done) {
      const key = `${r.planId}:${r.version}`;
      const rank = (seen.get(key) ?? 0) + 1;
      seen.set(key, rank);
      if (rank > deps.config.keepContentRuns && !(r.phaseDetail as { contentsPruned?: boolean } | null)?.contentsPruned) {
        await ops.deleteContentRows(r.runId);
        await db.update(judgementRuns).set({ phaseDetail: { ...((r.phaseDetail as object | null) ?? {}), contentsPruned: true } as never }).where(eq(judgementRuns.runId, r.runId));
        pruned++;
      }
    }
    let prunedFailed = 0;
    const cutoff = new Date(now.getTime() - deps.config.failedRetentionDays * 86_400_000);
    const stale = await db.select().from(judgementRuns).where(and(eq(judgementRuns.runKind, "execution"), inArray(judgementRuns.status, ["failed", "cancelled"]), lt(judgementRuns.updatedAt, cutoff)));
    for (const r of stale) {
      if ((r.phaseDetail as { contentsPruned?: boolean } | null)?.contentsPruned) continue;
      await ops.deleteContentRows(r.runId);
      await db.update(judgementRuns).set({ phaseDetail: { ...((r.phaseDetail as object | null) ?? {}), contentsPruned: true } as never }).where(eq(judgementRuns.runId, r.runId));
      prunedFailed++;
    }
    return { expiredRuns: gone.runs, prunedExecutions: pruned, prunedFailed };
  }

  return { listCompleted, describe, executionsOf, planRefOf, streamParticipants, streamContents, streamCircleRows, listContents, listParticipants, explain, maintain };
}
export type Outcomes = ReturnType<typeof createOutcomes>;
export type { Facts };
