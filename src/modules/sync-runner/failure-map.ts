// 统一的失败映射（FS-12、design §7.11、§8）：一个失败码 → 重试 / 终态 / 是否消耗尝试额度 / 是否计入熔断。
// 技术失败永不变成业务空值，也不改账号 / 内容状态；这里只决定任务怎么走。
import type { RetryConfig } from "./retry";

export interface FailureSpec {
  /** 可重试：进入 retry_wait 并回到队尾；额度耗尽 → dead。不可重试 → failed。 */
  retry: boolean;
  /** 计入 provider 熔断（供应商级：429 / 5xx / 传输 / 超时 / ambiguous）。账号级与我方问题为 false。 */
  breaker: boolean;
  /** 消耗一次尝试额度。没有真的发出调用的失败（预算、资格、能力门控）不消耗。 */
  consumesAttempt: boolean;
  /** 终态种类：failed 或 cancelled（监控资格失效）。 */
  terminal: "failed" | "cancelled";
}

const provider = { retry: true, breaker: true, consumesAttempt: true, terminal: "failed" } as const;
const account = { retry: true, breaker: false, consumesAttempt: true, terminal: "failed" } as const;
const stable = { retry: false, breaker: false, consumesAttempt: true, terminal: "failed" } as const;
const noCall = { retry: false, breaker: false, consumesAttempt: false, terminal: "failed" } as const;

export const FAILURE_SPECS = {
  // 供应商级：计入熔断
  rate_limited: provider,
  provider_server_error: provider,
  transport_failure: provider,
  transport_timeout: provider,
  ambiguous_unresolved: provider,
  // 账号级 / 我方：可重试但不计熔断（换账号照样会成功，说明不了供应商好坏）
  provider_validation_failed: account,
  provider_null_result: account,
  provider_task_failed: account,
  profile_fields_missing: account,
  page_projection_failed: account,
  converter_unavailable: account,
  media_download_failed: account,
  runner_error: account, // Runner 抛出的未预期异常：有界重试，额度用尽后 dead，不会无限重跑
  // 稳定失败：不重试
  provider_input_inaccessible: stable,
  provider_request_rejected: stable,
  provider_auth: stable,
  invalid_response: stable,
  schema_drift: stable,
  profile_uid_mismatch: stable,
  list_author_mismatch: stable,
  detail_inaccessible: stable,
  source_expired_exhausted: stable,
  // 没有发出调用：不消耗额度
  budget_exhausted: noCall,
  capability_disabled: noCall,
  unsupported_platform: noCall,
  content_url_unavailable: noCall,
  unsupported_action: noCall,
  // 监控资格失效：取消，不是失败
  monitoring_closed: { retry: false, breaker: false, consumesAttempt: false, terminal: "cancelled" },
} as const satisfies Record<string, FailureSpec>;

export type FailureCode = keyof typeof FAILURE_SPECS;
export const specOf = (code: FailureCode): FailureSpec => FAILURE_SPECS[code];

export type Transition =
  | { status: "retry_wait"; attemptCount: number; nextAttemptAt: Date }
  | { status: "failed" | "dead" | "cancelled"; attemptCount: number };

/**
 * 纯函数：一次失败之后任务去哪里。
 *  - 可重试且额度未用完 → retry_wait（attempt_count+1，退避后才可再领，且排在同优先级所有未重试任务之后）；
 *  - 可重试但额度用完 → dead（死信）；
 *  - 不可重试 → failed；监控资格失效 → cancelled；
 *  - attempt_count 不超过 max_attempts（CHECK ck_sync_tasks_attempts）。
 */
export function transitionFor(
  task: { attemptCount: number; maxAttempts: number },
  code: FailureCode,
  now: Date,
  retry: RetryConfig,
  retryAfterMs?: number,
): Transition {
  const spec = specOf(code);
  const used = Math.min(task.maxAttempts, task.attemptCount + (spec.consumesAttempt ? 1 : 0));
  if (spec.terminal === "cancelled") return { status: "cancelled", attemptCount: task.attemptCount };
  if (!spec.retry) return { status: "failed", attemptCount: used };
  if (used >= task.maxAttempts) return { status: "dead", attemptCount: task.maxAttempts };
  const wait = Math.max(retryAfterMs ?? 0, Math.min(retry.maxBackoffMs, retry.baseBackoffMs * 2 ** (used - 1)));
  return { status: "retry_wait", attemptCount: used, nextAttemptAt: new Date(now.getTime() + wait) };
}
