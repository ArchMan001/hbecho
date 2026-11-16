// 运行入口（JP-5 圈定、JP-15 生命周期）：圈定是同步运算——当前进程自己领租约、跑 tick，直到终态；
// 其余运行由 worker 领取（任务 11 的 serve）。同一个引擎、同一份逻辑，所以圈定条数 = 执行时 C1 条数。
import { and, eq, sql } from "drizzle-orm";
import { judgementRuns, runContents, runParticipants } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { type Claim, type RunRow } from "./engine/claim";
import type { Runner } from "./engine/runner";
import { parseConfig, validateConfig } from "./config";
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
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { circle, drive, summaryOf, cancel, runRow: (runId: bigint) => db.select().from(judgementRuns).where(eq(judgementRuns.runId, runId)) };
}
export type Runs = ReturnType<typeof createRuns>;
