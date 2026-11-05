// 同步 worker 的执行循环（FS-3、design §7.5）：领取 → 并发 → 执行 → 记账。
//  - 并发：非媒资 ≤ concurrency，媒资 ≤ mediaConcurrency（两个独立槽位池）；
//  - 熔断：打开的 provider 不再被领取，任务保持原状且不消耗额度；
//  - 速率限制套在 transport 外面（token-bucket.ts），不在这里；
//  - 优雅停机：停止领取，等在途至多 graceMs，放弃的任务不改状态，租约过期后自然被重新领取。
// 只领已注册 Runner 的动作：未实现的动作绝不会被领走后失败。
import { dataProviders } from "../db/schema";
import type { Db } from "../db/client";
import { claimNext, unclaim, type ClaimedTask } from "../modules/orchestrator";
import type { Clock } from "../modules/raw-capture";
import { createTaskExecutor, isProviderBound, type BreakerLike, type ExecutorDeps, type RetryConfig, type RunnerRegistry, type TaskResult } from "../modules/sync-runner";
import type { MonitoringResolver } from "../modules/monitoring";
import type { BreakerSet } from "./provider-breaker";

export interface WorkerDeps {
  db: Db;
  clock: Clock;
  resolver: Pick<MonitoringResolver, "explain">;
  runners: RunnerRegistry;
  breakers: BreakerSet;
  workerId: string;
  concurrency: number;
  mediaConcurrency: number;
  leaseMs: number;
  retry: RetryConfig;
  idlePollMs: number;
  sleep(ms: number): Promise<void>;
  log?: ExecutorDeps["log"];
}

export type RunStats = Record<TaskResult, number> & { claimed: number; released: number };
const emptyStats = (): RunStats => ({ claimed: 0, released: 0, done: 0, retry_wait: 0, failed: 0, dead: 0, cancelled: 0, abandoned: 0 });

export function createSyncWorker(d: WorkerDeps) {
  let stopping = false;
  const inflight = new Map<bigint, { promise: Promise<void>; media: boolean }>();
  const wake: Array<() => void> = [];
  const notify = () => wake.splice(0).forEach((f) => f());
  const nextCompletion = () => new Promise<void>((r) => wake.push(r));
  const providerIds = new Set<bigint>();

  const executor = createTaskExecutor({
    db: d.db,
    clock: d.clock,
    resolver: d.resolver,
    runners: d.runners,
    breakerFor: (t): BreakerLike => d.breakers.get(t.providerId.toString()),
    retry: d.retry,
    leaseMs: d.leaseMs,
    shouldStop: () => stopping,
    ...(d.log ? { log: d.log } : {}),
  });

  async function loadProviders(): Promise<void> {
    if (providerIds.size > 0) return;
    for (const p of await d.db.select({ id: dataProviders.providerId }).from(dataProviders)) providerIds.add(p.id);
  }

  async function claimOne(stats: RunStats) {
    const media = [...inflight.values()].filter((x) => x.media).length;
    const calls = inflight.size - media;
    const excludeActions = [...(calls >= d.concurrency ? ["resolve_account", "fetch_profile", "fetch_content_list", "fetch_content_detail", "fetch_comments"] : []), ...(media >= d.mediaConcurrency ? ["download_media"] : [])];
    const actions = Object.keys(d.runners).filter((a) => !excludeActions.includes(a));
    if (actions.length === 0) return null;
    // 熔断打开（或已有探测在途）的 provider 本轮不领取；peek 不改变状态，真正占用探测名额在领取之后
    const excludeProviderIds = [...providerIds].filter((id) => d.breakers.get(id.toString()).peek() === "no");
    const [c] = await claimNext(d.db, { workerId: d.workerId, leaseMs: d.leaseMs, now: d.clock.now(), limit: 1, actions, excludeActions, excludeProviderIds });
    if (!c) return null;
    stats.claimed++;
    if (isProviderBound(c.task.requestedAction) && d.breakers.get(c.task.providerId.toString()).tryAcquire() === "no") {
      // 领取的间隙里熔断器打开了：放回去，不消耗额度
      await unclaim(d.db, c, d.clock.now());
      stats.released++;
      return "released" as const;
    }
    return c;
  }

  function start(c: ClaimedTask, stats: RunStats): void {
    const promise = executor
      .execute(c)
      .then((r) => void stats[r]++)
      .catch((e) => d.log?.({ taskId: c.task.taskId.toString(), err: e }, "executor failed"))
      .finally(() => {
        inflight.delete(c.task.taskId);
        notify();
      });
    inflight.set(c.task.taskId, { promise, media: c.task.requestedAction === "download_media" });
  }

  /** 领取并执行，直到队列里没有可领任务且没有在途任务（run-once / 测试 / 演练），或收到停机信号。 */
  async function run(opts: { untilIdle: boolean }): Promise<RunStats> {
    const stats = emptyStats();
    await loadProviders();
    while (!stopping) {
      const c = await claimOne(stats);
      if (c === "released") continue;
      if (c) {
        start(c, stats);
        continue;
      }
      if (inflight.size > 0) await nextCompletion(); // 槽位满或暂无可领：等一个在途任务结束再看
      else if (opts.untilIdle) break;
      else await d.sleep(d.idlePollMs);
    }
    if (!stopping) while (inflight.size > 0) await nextCompletion();
    return stats;
  }

  /** 停止领取，等待在途任务至多 graceMs；返回放弃的任务数（它们的状态不被改写，租约到期后可被重新领取）。 */
  async function stop(graceMs: number): Promise<{ abandoned: number }> {
    stopping = true;
    notify();
    const deadline = d.clock.now().getTime() + graceMs;
    while (inflight.size > 0 && d.clock.now().getTime() < deadline) {
      await Promise.race([nextCompletion(), d.sleep(Math.min(100, Math.max(1, deadline - d.clock.now().getTime())))]);
    }
    return { abandoned: inflight.size };
  }

  return { run, stop, get inflightCount() { return inflight.size; } };
}
export type SyncWorker = ReturnType<typeof createSyncWorker>;
