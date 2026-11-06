// 单个已领取任务的执行（design §5.1、§7.5）：
//   in_flight 恢复 → 资格复核 → Runner → 失败映射 / 熔断记账。
// 所有状态写入都走 withFences：token 不匹配（被取消 / 被抢占）整笔不写，陈旧 worker 不能改任务状态。
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { syncTasks } from "../../db/schema";
import type { MonitoringResolver } from "../monitoring";
import { heartbeat, withFences, type ClaimedTask } from "../orchestrator";
import { StaleFenceError, recoverInFlightForTasks, type Clock } from "../raw-capture";
import { checkEligibility } from "./eligibility";
import { specOf, transitionFor, type FailureCode, type Transition } from "./failure-map";
import type { RetryConfig } from "./retry";
import type { RunnerOutcome, RunnerRegistry, TerminalHook } from "./types";

export type TaskResult = "done" | "retry_wait" | "failed" | "dead" | "cancelled" | "abandoned";

/** 调用供应商的动作才参与熔断；媒资下载不调供应商。 */
const PROVIDER_BOUND = new Set(["resolve_account", "fetch_profile", "fetch_content_list", "fetch_content_detail", "fetch_comments"]);
export const isProviderBound = (action: string): boolean => PROVIDER_BOUND.has(action);

/** 熔断记账的最小接口（provider-breaker 实现）。 */
export interface BreakerLike {
  recordSuccess(): void;
  recordProviderFailure(): void;
  recordNeutral(): void;
}

export interface ExecutorDeps {
  db: Db;
  clock: Clock;
  resolver: Pick<MonitoringResolver, "explain">;
  runners: RunnerRegistry;
  breakerFor(task: { providerId: bigint }): BreakerLike;
  retry: RetryConfig;
  leaseMs: number;
  shouldStop(): boolean;
  log?(event: Record<string, unknown>, msg: string): void;
}

export function createTaskExecutor(d: ExecutorDeps) {
  /** 把失败写成任务终态 / retry_wait。fence 失效 → 当作被取代，不写。终态时在同一事务里执行 onTerminal。 */
  async function applyFailure(c: ClaimedTask, code: FailureCode, retryAfterMs: number | undefined, detail: Record<string, unknown> | undefined, onTerminal?: TerminalHook): Promise<TaskResult> {
    const now = d.clock.now();
    const t: Transition = transitionFor(c.task, code, now, d.retry, retryAfterMs);
    const write = (hook: TerminalHook | undefined) =>
      withFences(d.db, d.clock, [{ taskId: c.task.taskId, token: c.token }], async (tx) => {
        const terminal = t.status !== "retry_wait";
        await tx
          .update(syncTasks)
          .set({
            status: t.status,
            attemptCount: t.attemptCount,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: t.status === "retry_wait" ? t.nextAttemptAt : null,
            lastErrorCode: code,
            lastErrorDetail: detail ?? null,
            ...(t.status === "cancelled" ? { stopReason: code } : {}),
            ...(terminal ? { finishedAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(syncTasks.taskId, c.task.taskId));
        if (hook && t.status !== "retry_wait") await hook(tx, { status: t.status, now });
      });
    let fenced;
    try {
      fenced = await write(onTerminal);
    } catch (e) {
      if (!onTerminal) throw e;
      // 钩子抛错：整笔已回滚。不带钩子重写终态，否则任务会停在 running、反复被领取
      d.log?.({ taskId: c.task.taskId.toString(), code, err: e }, "onTerminal hook failed; rewriting terminal without it");
      fenced = await write(undefined);
    }
    return fenced.ok ? t.status : "abandoned";
  }

  async function execute(c: ClaimedTask): Promise<TaskResult> {
    const { task, token } = c;
    const breaker = isProviderBound(task.requestedAction) ? d.breakerFor(task) : null;
    let reported = false;
    const report = (kind: "success" | "provider" | "neutral") => {
      if (!breaker || reported) return;
      reported = true;
      if (kind === "success") breaker.recordSuccess();
      else if (kind === "provider") breaker.recordProviderFailure();
      else breaker.recordNeutral();
    };
    try {
      // 接手自失联 worker：先把停在 in_flight 的调用标为 ambiguous（只读调用随后至多重发一次，由网关保证）
      await recoverInFlightForTasks({ db: d.db, clock: d.clock, taskIds: [task.taskId] });

      const eligible = await checkEligibility(d.resolver, task);
      if (!eligible.ok) {
        const r = await applyFailure(c, "monitoring_closed", undefined, { reason: eligible.reason });
        return r;
      }
      const runner = d.runners[task.requestedAction];
      if (!runner) return await applyFailure(c, "unsupported_action", undefined, { action: task.requestedAction });

      let out: RunnerOutcome;
      try {
        out = await runner({
          task,
          token,
          db: d.db,
          clock: d.clock,
          heartbeat: () => heartbeat(d.db, task.taskId, token, { now: d.clock.now(), leaseMs: d.leaseMs }),
          shouldStop: d.shouldStop,
        });
      } catch (e) {
        if (e instanceof StaleFenceError) out = { kind: "abandoned", reason: "stale" };
        else {
          d.log?.({ taskId: task.taskId.toString(), action: task.requestedAction, err: e }, "runner threw");
          out = { kind: "failure", code: "runner_error", detail: { error: e instanceof Error ? e.name : typeof e } };
        }
      }

      switch (out.kind) {
        case "done":
          report("success");
          return "done";
        case "abandoned":
          report("neutral");
          return "abandoned";
        case "failure": {
          report(specOf(out.code).breaker ? "provider" : "neutral");
          return await applyFailure(c, out.code, out.retryAfterMs, out.detail, out.onTerminal);
        }
      }
    } finally {
      // 探测任务无论怎么结束都必须释放探测名额（例如 Runner 之外抛出的错误）
      report("neutral");
    }
  }

  return { execute };
}
export type TaskExecutor = ReturnType<typeof createTaskExecutor>;
