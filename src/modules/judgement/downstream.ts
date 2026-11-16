// D 对 A 的下游端口实现 PlanDownstream（JP-17，design §7.12、§10.2）。
// summarize 只读 D 自己的表；onDeleted / onRestored 是幂等空操作（以 activity_plans.status 为准，读取口 facts.liveActivityPlans 已按它过滤）；
// purge 在 A 的事务之外：先让 C 清监控段，再分块显式删 D 的行；任一步失败即抛出，A 不清除活动计划，下次维护重试，已完成的步骤幂等。
import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { judgementPlans, judgementPlanVersions, judgementRuns, runParticipants } from "../../db/schema";
import type { PlanDownstream } from "../activity-plan/downstream";
import { createRunOps } from "./run-ops";
import type { SignalActor, SignalsPort } from "./ports";

const RUN_BATCH = 200;

export interface JudgementDownstreamDeps {
  db: Db;
  signals: Pick<SignalsPort["segments"], "purge">;
  /** 清除由 A 的每日维护触发、没有提交人：调用 C 的 purge 所用的身份由装配处给（需要 C 的 segment 管理能力），D 不自造。 */
  purgeActor: SignalActor;
}

export function createJudgementDownstream(deps: JudgementDownstreamDeps): PlanDownstream {
  const { db, signals, purgeActor } = deps;
  const ops = createRunOps(db);
  const planIdsOf = async (activityPlanId: bigint): Promise<bigint[]> => (await db.select({ id: judgementPlans.planId }).from(judgementPlans).where(eq(judgementPlans.activityPlanId, activityPlanId)).orderBy(judgementPlans.planId)).map((r) => r.id);

  return {
    async summarize(activityPlanId) {
      const ids = await planIdsOf(activityPlanId);
      if (ids.length === 0) return { judgementPlans: 0, results: 0, running: 0 };
      // 圈定 / 试跑的试验数据不算业务结果：只数已完成的执行
      const [res] = await db.select({ n: count() }).from(runParticipants).innerJoin(judgementRuns, eq(judgementRuns.runId, runParticipants.runId)).where(and(inArray(judgementRuns.planId, ids), eq(judgementRuns.runKind, "execution"), eq(judgementRuns.status, "completed")));
      const [run] = await db.select({ n: count() }).from(judgementRuns).where(and(inArray(judgementRuns.planId, ids), inArray(judgementRuns.status, ["planned", "running", "waiting"])));
      return { judgementPlans: ids.length, results: Number(res!.n), running: Number(run!.n) };
    },
    async onDeleted() {},
    async onRestored() {},
    async purge(activityPlanId) {
      for (const planId of await planIdsOf(activityPlanId)) {
        await signals.purge(purgeActor, planId); // C 先清（幂等）；失败则 D 的行原样保留，重试即可
        for (;;) {
          const runIds = (await db.select({ id: judgementRuns.runId }).from(judgementRuns).where(eq(judgementRuns.planId, planId)).limit(RUN_BATCH)).map((r) => r.id);
          if (runIds.length === 0) break;
          await ops.deleteRunsById(runIds); // run_contents → run_participants → judgement_runs
        }
        await db.delete(judgementPlanVersions).where(eq(judgementPlanVersions.planId, planId));
        await db.delete(judgementPlans).where(eq(judgementPlans.planId, planId));
      }
    },
  };
}
