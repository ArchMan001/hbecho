// 运行入口（JP-5 圈定、JP-15 生命周期）：圈定是同步运算——当前进程自己领租约、跑 tick，直到终态；
// 其余运行由 worker 领取（任务 11 的 serve）。同一个引擎、同一份逻辑，所以圈定条数 = 执行时 C1 条数。
import { and, desc, eq, sql } from "drizzle-orm";
import { judgementPlanVersions as judgementPlanVersionsTable, judgementPlans, judgementRuns, runContents, runParticipants } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { type Claim, type RunRow } from "./engine/claim";
import type { Runner } from "./engine/runner";
import { accountAbilities, centsOfThreshold, contentAbilities, incompleteAbilities, parseConfig, scoreSignalOf, validateConfig, type Ability } from "./config";
import { bucketize, passCount, type Scored } from "./engine/pure/trial";
import type { JudgementConfig } from "./env";
import { JudgementError } from "./errors";
import { loadPlan, type JudgementDeps } from "./plans";
import type { Versions } from "./versions";
import { createRunOps, type RunOps } from "./run-ops";

export interface CircleSummary {
  runId: bigint;
  /** 圈定条数 = 通过第 1 层且被数量要求选中的内容数（C1） */
  c1: number;
  participants: number;
  /** 参与内容行数（含未选中、未通过、未获取成功） */
  contents: number;
  skipped: number;
  unobtained: number;
  byReason: Record<string, number>;
}
export interface TrialAbilityReport {
  abilityId: string;
  alias?: string;
  kind: string;
  target: string;
  /** 对象：content = 封面（内容 ID），account = 头像 / 主页背景（账号 ID） */
  subject: "content" | "account";
  thresholdCents: number;
  /** 11 档（0..9 为 [k, k+1)，10 为 10.00）的条数 */
  counts: number[];
  /** 每档至多 5 个样例 ID（升序，确定性） */
  samples: bigint[][];
  /** 用当前阈值重算的通过数（换阈值无需重新试跑） */
  pass: number;
  unobtained: { total: number; byReason: Record<string, number> };
}
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const signalsOfAbilities = (abs: readonly Ability[]): string[] => [...new Set(abs.map(scoreSignalOf))];

export function createRuns(deps: JudgementDeps & { claim: Claim; runner: Runner; versions: Versions; config: JudgementConfig; ops?: RunOps }) {
  const { db, clock, authz, audit, claim, runner, versions, config } = deps;
  const ops = deps.ops ?? createRunOps(db);

  /** 当前进程自己领租约并反复 tick，直到终态；还在等依赖时按轮询间隔休眠（测试注入会推进 FakeClock 的 sleep）。 */
  async function drive(runId: bigint, owner: string, sleep: Sleep = realSleep): Promise<RunRow> {
    for (;;) {
      const run = await claim.claim(runId, owner);
      if (!run) {
        const cur = await claim.get(runId);
        if (!cur) throw new JudgementError("not_found", "run_not_found", "运行不存在");
        if (cur.status === "completed" || cur.status === "failed" || cur.status === "cancelled") return cur;
        await sleep(config.pollSeconds * 1000); // 没到下次 tick 时间，或别的 worker 持有租约
        continue;
      }
      const r = await runner.tick(run);
      if (r === "stale") throw new JudgementError("conflict", "lease_lost", "运行的租约已被别人接手或运行已取消");
      if (r === "terminal") return (await claim.get(runId))!;
      if (r === "waiting") await sleep(config.pollSeconds * 1000);
    }
  }

  async function summaryOf(runId: bigint): Promise<CircleSummary> {
    const [p] = await db.select({ n: sql<number>`COUNT(*)`, c1: sql<number>`COALESCE(SUM(${runParticipants.c1Count}), 0)`, skipped: sql<number>`COALESCE(SUM(${runParticipants.contentSkipped}), 0)` }).from(runParticipants).where(eq(runParticipants.runId, runId));
    const [c] = await db.select({ n: sql<number>`COUNT(*)` }).from(runContents).where(eq(runContents.runId, runId));
    const reasons = await db.select({ reason: runContents.reasonCode, n: sql<number>`COUNT(*)` }).from(runContents).where(and(eq(runContents.runId, runId), eq(runContents.final, "unobtained"))).groupBy(runContents.reasonCode);
    const byReason = Object.fromEntries(reasons.map((r) => [r.reason ?? "unknown", Number(r.n)]));
    return { runId, c1: Number(p!.c1), participants: Number(p!.n), contents: Number(c!.n), skipped: Number(p!.skipped), unobtained: Object.values(byReason).reduce((a, b) => a + b, 0), byReason };
  }

  /** 圈定（第 1 页）：同步；只读 A 的快照与 C 的文本信号，不触发任何外部调用（采集、补算、读图、模型）。重新圈定替换上一次。 */
  async function circle(ctx: AuthContext, planId: bigint, o: { sleep?: Sleep } = {}): Promise<CircleSummary> {
    await authz.require(ctx, "manage");
    const { plan, ref, activity } = await loadPlan(deps, planId);
    await authz.require(ctx, "manage", ref);
    if (plan.status !== "active") throw new JudgementError("conflict", plan.status === "archived" ? "plan_archived" : "plan_provisioning", "判定计划当前不可操作");
    const draft = await versions.draftOf(planId);
    if (!draft || draft.status !== "draft") throw new JudgementError("conflict", "version_immutable", "只有草稿可以圈定；请先新建草稿");
    const cfg = parseConfig(draft.config);
    const issues = validateConfig(cfg, activity.platformCode, deps.signals.platformSignals(activity.platformCode), deps.limits, { complete: true });
    if (issues.length) throw new JudgementError("input", "config_invalid", issues.map((i) => i.message).join("；"), { issues });
    if (await ops.activeRunExists(planId, draft.version, ["circle", "compare", "execution"])) throw new JudgementError("conflict", "run_active", "这个版本已有未结束的运行");
    await ops.deleteRuns(planId, draft.version, ["circle"]); // 重新圈定替换上一次
    const now = clock.now();
    const { runId } = await claim.createRun(db, {
      planId, version: draft.version, kind: "circle", actor: ctx.actor, userId: ctx.userId, expiresAt: new Date(now.getTime() + config.trialRetentionDays * 86_400_000),
      scopeSummary: { brands: ctx.scope.brands === "all" ? "all" : [...ctx.scope.brands].map(String), branches: ctx.scope.branches === "all" ? "all" : [...ctx.scope.branches].map(String) },
    });
    const done = await drive(runId, `inline:${ctx.actor}`, o.sleep);
    if (done.status !== "completed") throw new JudgementError(done.status === "cancelled" ? "conflict" : "dependency", done.lastErrorCode ?? `run_${done.status}`, `圈定没有完成（${done.status}）`, done.lastErrorDetail);
    await audit.record({ event: "circle_run", actor: ctx.actor, actorUserId: ctx.userId, planId, runId });
    return summaryOf(runId);
  }

  /**
   * 试跑（第 2 页）：对圈定留下的 C1 比对。先检查可执行性——不可执行就拒绝并返回阻塞项，不建运行、不返回全 0；
   * 异步运行由 worker 领取；`wait` 时当前进程自己跑完（CLI 的 --wait）。不触发第 3 层，不发任何付费调用。
   */
  async function trial(ctx: AuthContext, planId: bigint, o: { wait?: boolean; sleep?: Sleep } = {}): Promise<{ runId: bigint; status: string }> {
    await authz.require(ctx, "manage");
    const { plan, ref, activity } = await loadPlan(deps, planId);
    await authz.require(ctx, "manage", ref);
    if (plan.status !== "active") throw new JudgementError("conflict", plan.status === "archived" ? "plan_archived" : "plan_provisioning", "判定计划当前不可操作");
    const draft = await versions.draftOf(planId);
    if (!draft || draft.status !== "draft") throw new JudgementError("conflict", "version_immutable", "只有草稿可以试跑；请先新建草稿");
    if (draft.wizardStep === "draft") throw new JudgementError("conflict", "wizard_step_required", "请先完成圈定");
    const cfg = parseConfig(draft.config);
    const issues = validateConfig(cfg, activity.platformCode, deps.signals.platformSignals(activity.platformCode), deps.limits, { complete: true });
    if (issues.length) throw new JudgementError("input", "config_invalid", issues.map((i) => i.message).join("；"), { issues });
    if (cfg.layer2.abilities.length === 0) throw new JudgementError("input", "no_abilities", "第 2 页没有比对能力，不需要试跑");
    if (incompleteAbilities(cfg).length) throw new JudgementError("input", "image_missing", "还有图片元素对比没有上传元素图");
    const segment = { planId, version: draft.version };
    const ex = await deps.signals.executability(await authz.toSignalActor(ctx), segment, { only: signalsOfAbilities(cfg.layer2.abilities) });
    if (!ex.executable) throw new JudgementError("conflict", "not_executable", "比对能力当前不可用，不能试跑", { blockers: ex.blockers });
    if (await ops.activeRunExists(planId, draft.version, ["circle", "compare", "execution"])) throw new JudgementError("conflict", "run_active", "这个版本已有未结束的运行");
    await ops.deleteRuns(planId, draft.version, ["compare"]);
    const { runId } = await claim.createRun(db, { planId, version: draft.version, kind: "compare", actor: ctx.actor, userId: ctx.userId, expiresAt: new Date(clock.now().getTime() + config.trialRetentionDays * 86_400_000) });
    await audit.record({ event: "trial_run", actor: ctx.actor, actorUserId: ctx.userId, planId, runId });
    if (!o.wait) return { runId, status: "planned" };
    const done = await drive(runId, `inline:${ctx.actor}`, o.sleep);
    if (done.status !== "completed") throw new JudgementError(done.status === "cancelled" ? "conflict" : "dependency", done.lastErrorCode ?? `run_${done.status}`, `试跑没有完成（${done.status}）`, done.lastErrorDetail);
    return { runId, status: done.status };
  }

  /** 试跑报告：每个比对能力一份连续 0–10 分的 11 档分布与固定每档 5 个样例；通过数用当前阈值重算；素材问题原样汇总为未获取成功。 */
  async function trialReport(ctx: AuthContext, planId: bigint): Promise<{ runId: bigint; c1: number; abilities: TrialAbilityReport[] }> {
    await authz.require(ctx, "manage");
    const { ref } = await loadPlan(deps, planId);
    await authz.require(ctx, "manage", ref);
    const draft = await versions.draftOf(planId);
    const version = draft?.version ?? (await db.select({ v: judgementPlans.latestVersion }).from(judgementPlans).where(eq(judgementPlans.planId, planId)))[0]!.v;
    const [run] = await db.select().from(judgementRuns).where(and(eq(judgementRuns.planId, planId), eq(judgementRuns.version, version), eq(judgementRuns.runKind, "compare"), eq(judgementRuns.status, "completed"))).orderBy(desc(judgementRuns.runId)).limit(1);
    if (!run) throw new JudgementError("not_found", "trial_not_found", "还没有试跑结果");
    const v = draft ?? (await versions.versionOf(planId, version))!;
    const cfg = parseConfig(v.config);
    const contentRows = await db.select({ id: runContents.contentId, evidence: runContents.evidence }).from(runContents).where(and(eq(runContents.runId, run.runId), sql`${runContents.l2} IS NOT NULL`, sql`${runContents.l2} <> 'skipped'`));
    const people = await db.select({ id: runParticipants.accountId, detail: runParticipants.accountDetail }).from(runParticipants).where(eq(runParticipants.runId, run.runId));
    const abilityEvidence = (raw: unknown, key: "l2" | "account", id: string): { state?: string; score?: string; reason?: string } | undefined => {
      const list = (key === "l2" ? (raw as { l2?: { abilities?: unknown[] } } | null)?.l2?.abilities : (raw as { abilities?: unknown[] } | null)?.abilities) as Array<{ id: string; state?: string; score?: string; reason?: string }> | undefined;
      return list?.find((x) => x.id === id);
    };
    const abilities: TrialAbilityReport[] = [];
    for (const a of cfg.layer2.abilities) {
      const isContent = contentAbilities(cfg).includes(a);
      const scored: Scored[] = [];
      const reasons: Record<string, number> = {};
      let unobtained = 0;
      const sources = isContent ? contentRows.map((r) => ({ id: r.id, ev: abilityEvidence(r.evidence, "l2", a.abilityId) })) : people.map((p) => ({ id: p.id, ev: abilityEvidence(p.detail, "account", a.abilityId), whole: p.detail as { result?: string; reason?: string } | null }));
      for (const s of sources) {
        if (s.ev?.score !== undefined) scored.push({ id: s.id, cents: centsOfThreshold(s.ev.score) });
        else {
          unobtained++;
          const reason = s.ev?.reason ?? (s as { whole?: { reason?: string } | null }).whole?.reason ?? "unknown";
          reasons[reason] = (reasons[reason] ?? 0) + 1;
        }
      }
      const { counts, samples } = bucketize(scored);
      const thresholdCents = centsOfThreshold(a.threshold);
      abilities.push({ abilityId: a.abilityId, ...(a.alias ? { alias: a.alias } : {}), kind: a.kind, target: a.target, subject: isContent ? "content" : "account", thresholdCents, counts, samples, pass: passCount(scored, thresholdCents), unobtained: { total: unobtained, byReason: reasons } });
    }
    return { runId: run.runId, c1: run.c1Count ?? 0, abilities };
  }

  /**
   * 确认执行 / 重新执行（JP-3）：存在草稿 → 发布为新版本并在**同一事务**里建执行运行；没有草稿 → 对最近已发布版本再跑一次，不升版。
   * 同一幂等键重复提交返回已有运行；同版本已有未终态运行 → run_active。归档的判定计划被拒；暂停 / 归档的活动计划仍可手动触发。
   */
  async function execute(ctx: AuthContext, planId: bigint, o: { key: string }): Promise<{ version: number; runId: bigint; created: boolean }> {
    await authz.require(ctx, "execute");
    const { plan, ref } = await loadPlan(deps, planId);
    await authz.require(ctx, "execute", ref);
    if (plan.status !== "active") throw new JudgementError("conflict", plan.status === "archived" ? "plan_archived" : "plan_provisioning", "判定计划当前不可执行");
    if (!o.key.trim()) throw new JudgementError("input", "idempotency_key_required", "需要幂等键");
    const start = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], version: number) => {
      const r = await claim.createRun(tx, { planId, version, kind: "execution", actor: ctx.actor, userId: ctx.userId, idempotencyKey: o.key, scopeSummary: { brands: ctx.scope.brands === "all" ? "all" : [...ctx.scope.brands].map(String), branches: ctx.scope.branches === "all" ? "all" : [...ctx.scope.branches].map(String) } });
      if (r.created) await audit.record({ event: "execution_started", actor: ctx.actor, actorUserId: ctx.userId, planId, runId: r.runId, detail: { version } }, tx);
      return r;
    };
    const draft = await versions.draftOf(planId);
    if (draft?.status === "publishing") throw new JudgementError("conflict", "version_publishing", "正在发布，请先对账（reconcile）");
    if (draft) {
      let started: { runId: bigint; created: boolean } | undefined;
      const { version } = await versions.publish(ctx, planId, { onPublished: async (tx, v) => void (started = await start(tx, v.version)) });
      return { version, runId: started!.runId, created: started!.created };
    }
    const published = await db.select({ v: judgementPlanVersionsTable.version }).from(judgementPlanVersionsTable).where(and(eq(judgementPlanVersionsTable.planId, planId), eq(judgementPlanVersionsTable.status, "published"))).orderBy(desc(judgementPlanVersionsTable.version)).limit(1);
    if (published.length === 0) throw new JudgementError("not_found", "version_not_found", "还没有已发布的版本");
    const version = published[0]!.v;
    const ex = await deps.signals.executability(await authz.toSignalActor(ctx), { planId, version });
    if (!ex.executable) throw new JudgementError("conflict", "not_executable", "监控段当前不可执行，不能开始执行", { blockers: ex.blockers });
    const r = await db.transaction(async (tx) => start(tx, version));
    return { version, runId: r.runId, created: r.created };
  }

  /** worker 的一轮：领取所有当前可领取的运行并推进到它们各自「等待 / 终态」为止。 */
  async function serveOnce(owner: string, o: { shouldStop?: () => boolean } = {}): Promise<{ ticks: number }> {
    let ticks = 0;
    for (;;) {
      if (o.shouldStop?.()) return { ticks }; // 停止信号：当前 tick 已结束（租约已在 tick 末尾释放），不再领新的
      const run = await claim.claimNext(owner);
      if (!run) return { ticks };
      ticks++;
      await runner.tick(run);
    }
  }

  async function cancel(ctx: AuthContext, runId: bigint): Promise<boolean> {
    await authz.require(ctx, "manage");
    const run = await claim.get(runId);
    if (!run) throw new JudgementError("not_found", "run_not_found", "运行不存在");
    const { ref } = await loadPlan(deps, run.planId);
    await authz.require(ctx, run.runKind === "execution" ? "execute" : "manage", ref);
    return db.transaction(async (tx) => {
      const ok = await claim.cancel(runId, tx);
      if (ok) await audit.record({ event: "run_cancelled", actor: ctx.actor, actorUserId: ctx.userId, planId: run.planId, runId }, tx);
      return ok;
    });
  }
  const viewOf = (r: RunRow) => ({
    runId: r.runId, planId: r.planId, version: r.version, kind: r.runKind, status: r.status, phase: r.phase, attemptCount: r.attemptCount, lastErrorCode: r.lastErrorCode,
    submittedBy: r.submittedByActor, participants: r.participantCount, contentTotal: r.contentTotal, c1: r.c1Count, c2: r.c2Count, c3: r.c3Count, staleUsed: r.staleUsed,
    createdAt: r.createdAt, startedAt: r.startedAt, completedAt: r.completedAt,
  });
  async function show(ctx: AuthContext, runId: bigint) {
    await authz.require(ctx, "read");
    const run = await claim.get(runId);
    if (!run) throw new JudgementError("not_found", "run_not_found", "运行不存在");
    const { ref } = await loadPlan(deps, run.planId);
    await authz.require(ctx, "read", ref);
    return viewOf(run);
  }
  async function list(ctx: AuthContext, planId: bigint) {
    await authz.require(ctx, "read");
    const { ref } = await loadPlan(deps, planId);
    await authz.require(ctx, "read", ref);
    return (await db.select().from(judgementRuns).where(eq(judgementRuns.planId, planId)).orderBy(desc(judgementRuns.runId)).limit(200)).map(viewOf);
  }
  /** 续跑 failed 的运行（O8）：在原行上从持久化的阶段继续；返回是否真的续了。 */
  async function resume(ctx: AuthContext, runId: bigint): Promise<boolean> {
    await authz.require(ctx, "manage");
    const run = await claim.get(runId);
    if (!run) throw new JudgementError("not_found", "run_not_found", "运行不存在");
    const { ref } = await loadPlan(deps, run.planId);
    await authz.require(ctx, run.runKind === "execution" ? "execute" : "manage", ref);
    return claim.resume(runId);
  }
  return { show, list, resume, circle, trial, trialReport, execute, serveOnce, drive, summaryOf, cancel, runRow: (runId: bigint) => db.select().from(judgementRuns).where(eq(judgementRuns.runId, runId)) };
}
export type Runs = ReturnType<typeof createRuns>;
