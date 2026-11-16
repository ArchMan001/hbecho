// `judgement serve` 的常驻循环（design §9）：领取运行并推进 → 每日 maintain，直到收到停止信号。
// 轮询间隔来自配置（pollSeconds），不写代码默认值；清理固定每 24 小时一次（启动时先跑一次）。
// 某一步抛错只记日志，不让进程退出；没有可领的运行时睡一个轮询间隔，别空转。
// 停止：当前 tick 做完（租约在 tick 末尾释放）后不再领新的，然后返回，所以退出时不留未释放的租约。
import type { Judgement } from "../modules/judgement/assemble";
export interface JudgementLoopDeps {
  judgement: Pick<Judgement, "runs" | "outcomes" | "config">;
  workerId: string;
  /** 可被停止信号打断的睡眠。 */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  nowMs(): number;
  log(event: Record<string, unknown>, message: string): void;
}
const DAY_MS = 24 * 3600_000;
export async function runJudgementLoop(deps: JudgementLoopDeps, signal: AbortSignal): Promise<void> {
  const { judgement, log } = deps;
  let lastMaintain = -Infinity;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      log({ step: name, err: err instanceof Error ? err.message : String(err) }, "judgement.step_failed");
      return null;
    }
  };
  while (!signal.aborted) {
    const now = deps.nowMs();
    if (now - lastMaintain >= DAY_MS) {
      lastMaintain = now;
      const r = await step("maintain", () => judgement.outcomes.maintain());
      if (r) log({ ...r }, "judgement.maintain");
    }
    const r = await step("serve", () => judgement.runs.serveOnce(deps.workerId, { shouldStop: () => signal.aborted }));
    if ((r?.ticks ?? 0) === 0 && !signal.aborted) await deps.sleep(judgement.config.pollSeconds * 1000, signal);
  }
}
