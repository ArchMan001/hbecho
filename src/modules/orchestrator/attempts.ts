// 一个逻辑请求的有界尝试循环（profile 的 ≤3 次、列表的 ≤3 次、异步的重新提交）。
//
// 重放安全：每次运行都从第 1 次尝试开始「重放」——网关对同一 (task, attempt, sequence) 返回已有调用，不会重复发送；
// 所以崩溃、retry_wait 之后重新运行，会自然走到第一个还没有调用的尝试。只有在**要创建新调用**之前才检查退避时间。
import type { RunResult } from "./tracer-flow";

export type Step<T> =
  | { kind: "ok"; value: T }
  /** 可重试的失败。waitUntil 为空表示立即重试；否则在该时间之前不创建新调用（进入 retry_wait）。fallback：超时 / 结果不明，下一次尝试改走异步（主页）。 */
  | { kind: "again"; category: string; waitUntil?: Date; fallback?: boolean }
  /** RESULT_VALIDATION_FAILED 一类：可能是无效主页，也可能是供应商间歇失败；耗尽后才由业务层判 invalid_link。 */
  | { kind: "validation"; category: string }
  /** 取消 / 被取代 / 其他需要立刻结束运行的情形。 */
  | { kind: "end"; result: RunResult }
  | { kind: "fail"; category: string; code: string };

export type LoopResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "end"; result: RunResult }
  | { kind: "wait"; until: Date; category: string }
  | { kind: "fail"; category: string; code: string }
  | { kind: "exhausted"; validation: boolean; category: string };

export async function attemptLoop<T>(o: {
  max: number;
  now(): Date;
  /** 这一次尝试的调用是否已经存在（存在 = 重放，不受退避约束）。 */
  exists(attempt: number): Promise<boolean>;
  once(attempt: number): Promise<Step<T>>;
}): Promise<LoopResult<T>> {
  let gate: Date | null = null;
  let last: { validation: boolean; category: string } = { validation: false, category: "unspecified" };
  for (let n = 1; n <= o.max; n++) {
    if (gate && gate.getTime() > o.now().getTime() && !(await o.exists(n))) return { kind: "wait", until: gate, category: last.category };
    const step = await o.once(n);
    switch (step.kind) {
      case "ok":
        return step;
      case "end":
        return step;
      case "fail":
        return step;
      case "validation":
        last = { validation: true, category: step.category };
        gate = null;
        break;
      case "again":
        last = { validation: false, category: step.category };
        gate = step.waitUntil ?? null;
        break;
    }
  }
  return { kind: "exhausted", ...last };
}

export function backoffMs(cfg: { baseBackoffMs: number; maxBackoffMs: number }, failedAttempt: number): number {
  return Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** (failedAttempt - 1));
}
