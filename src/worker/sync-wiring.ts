// worker 的依赖装配。纯装配、无业务逻辑：配置 → 连接池 → 熔断 / 令牌桶 / 预算 / 调度 / worker。
// 供应商 transport、OSS 等带 secret 的依赖由 makeRunners（sync-runner-wiring.ts）在 worker 命令里装配；
// 不传 runners / makeRunners 时 RUNNERS 为空，这里不读任何 secret。
import pino, { type Logger } from "pino";
import { createDb, createPool, type Db } from "../db/client";
import type { Clock } from "../modules/raw-capture";
import { DEFAULT_RETRY } from "../modules/tracer-command";
import { createDemandModule } from "../modules/demand";
import { createMonitoringResolver } from "../modules/monitoring";
import { RUNNERS, type RunnerRegistry } from "../modules/sync-runner";
import { createSyncCommands, createSyncScheduler, createLogSyncAuditSink } from "../modules/sync-schedule";
import { createBreakerSet } from "./provider-breaker";
import type { SyncWorkerConfig } from "./sync-config";
import { createSyncWorker } from "./sync-worker";

export function buildSyncApp(
  cfg: SyncWorkerConfig,
  opts: { runners?: RunnerRegistry; /** 需要 db / clock 才能装配的 Runner（真实 transport、OSS 等带 secret 的依赖），在连接池建好之后调用。 */ makeRunners?: (c: { db: Db; clock: Clock }) => RunnerRegistry; logger?: Logger; workerId?: string } = {},
) {
  const logger = opts.logger ?? pino({ name: "sync-worker", redact: ["*.apiKey", "*.authorization"] }, pino.destination(2));
  const pool = createPool(cfg.databaseUrl);
  const db = createDb(pool);
  const clock = { now: () => new Date() };
  const resolver = createMonitoringResolver(db);
  const runtime = {
    environment: cfg.environment,
    modes: cfg.modes,
    concurrency: cfg.concurrency,
    provider_qps: cfg.providerQps,
    media_concurrency: cfg.mediaConcurrency,
    breaker: cfg.breaker,
    batch_budget: cfg.batchBudget,
  };
  const scheduler = createSyncScheduler({ db, clock, resolver, runtime });
  const commands = createSyncCommands({ db, clock, resolver, planner: scheduler.planner, runtime, audit: createLogSyncAuditSink(logger) });
  const demand = createDemandModule({ db, clock, runtime: { environment: cfg.environment, modes: cfg.demandModes }, audit: createLogSyncAuditSink(logger) });
  const breakers = createBreakerSet({
    failures: cfg.breaker.failures,
    cooldownMs: cfg.breaker.cooldownMs,
    nowMs: () => Date.now(),
    onChange: (c) => logger.warn(c, "provider breaker state changed"),
  });
  const worker = createSyncWorker({
    db,
    clock,
    resolver,
    runners: opts.runners ?? opts.makeRunners?.({ db, clock }) ?? RUNNERS,
    breakers,
    workerId: opts.workerId ?? `${cfg.actorId}:${process.pid}`,
    concurrency: cfg.concurrency,
    mediaConcurrency: cfg.mediaConcurrency,
    leaseMs: cfg.leaseMs,
    retry: DEFAULT_RETRY,
    idlePollMs: cfg.idlePollMs,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (e, msg) => logger.error(e, msg),
  });
  return { db, pool, clock, resolver, scheduler, commands, demand, breakers, worker, logger, close: () => pool.end() };
}
export type SyncApp = ReturnType<typeof buildSyncApp>;

/** tick 的间隔：时点判断有 10 分钟容忍窗口，30 秒一次足够（design §7.1）。 */
export const TICK_INTERVAL_MS = 30_000;

/** 常驻：定时 tick + worker 循环；SIGTERM / SIGINT → 停止领取，宽限期内完成在途，放弃的任务租约过期后被重新领取。 */
export async function runForever(
  app: SyncApp,
  cfg: SyncWorkerConfig,
  signals: { on(sig: "SIGTERM" | "SIGINT", f: () => void): void },
  /** 每日维护（北京时间 04:00 之后每天一次，由 maintenance.runDaily 自己判断，这里每次 tick 后调用）。 */
  extras: { maintain?: () => Promise<unknown> } = {},
): Promise<void> {
  let stopped = false;
  let stopping: Promise<void> | null = null;
  const tickLoop = (async () => {
    while (!stopped) {
      try {
        await app.scheduler.tick();
      } catch (e) {
        app.logger.error({ err: e }, "tick failed"); // 下一次 tick 再试；配置错误会在日志里反复出现，不会静默
      }
      try {
        await extras.maintain?.();
      } catch (e) {
        app.logger.error({ err: e }, "maintenance failed"); // runDaily 自己吞步骤错误；这里兜底，不让它拖垮 tick 循环
      }
      await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
    }
  })();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopping = app.worker.stop(cfg.graceMs).then((r) => app.logger.warn({ abandoned: r.abandoned }, "worker stopped"));
  };
  signals.on("SIGTERM", stop);
  signals.on("SIGINT", stop);
  const stats = await app.worker.run({ untilIdle: false });
  app.logger.info(stats, "worker loop ended");
  await stopping; // 宽限期内等在途任务结束；放弃的任务不改状态
  void tickLoop;
}
