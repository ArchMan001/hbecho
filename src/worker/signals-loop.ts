// `signals run` 的常驻循环（design §9）：扫描 → 对账 → 每日清理 → 领任务，直到收到停止信号。
// 间隔来自配置（scanIntervalMs、reconcileIntervalMs），不写代码默认值；清理固定每 24 小时一次（启动时先跑一次）。
// 某一步抛错只记日志，不让进程退出；没有任务时睡 scanIntervalMs，别空转。
import type { Signals } from "../modules/signals";

export interface SignalsLoopDeps {
  signals: Pick<Signals, "config" | "scanner" | "scoreRunner" | "speechRunner" | "recompute" | "retention">;
  /** 可被停止信号打断的睡眠。 */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  nowMs(): number;
  log(event: Record<string, unknown>, message: string): void;
}

const DAY_MS = 24 * 3600_000;

export async function runSignalsLoop(deps: SignalsLoopDeps, signal: AbortSignal): Promise<void> {
  const { signals, log } = deps;
  const cfg = signals.config;
  let lastScan = -Infinity;
  let lastReconcile = -Infinity;
  let lastPurge = -Infinity;
  const step = async (name: string, fn: () => Promise<unknown>): Promise<number> => {
    if (signal.aborted) return 0;
    try {
      const r = await fn();
      return typeof r === "number" ? r : 0;
    } catch (err) {
      log({ step: name, err: err instanceof Error ? err.message : String(err) }, "signals.step_failed");
      return 0;
    }
  };
  while (!signal.aborted) {
    const now = deps.nowMs();
    if (now - lastScan >= cfg.scanIntervalMs) {
      lastScan = now;
      await step("scan_contents", () => signals.scanner.contents());
      await step("scan_comments", () => signals.scanner.comments());
    }
    if (now - lastReconcile >= cfg.reconcileIntervalMs) {
      lastReconcile = now;
      await step("reconcile", () => signals.scanner.reconcile());
    }
    if (now - lastPurge >= DAY_MS) {
      lastPurge = now;
      await step("retention", async () => log({ ...(await signals.retention.purgeExpired({ shouldStop: () => signal.aborted })) }, "signals.retention"));
    }
    const worked =
      (await step("score", () => signals.scoreRunner.runBatch())) +
      (await step("speech", () => signals.speechRunner.runBatch())) +
      (await step("recompute", () => signals.recompute.runBatch()));
    if (worked === 0 && !signal.aborted) await deps.sleep(cfg.scanIntervalMs, signal);
  }
}
