// 单一解析策略（R3.5、R3.10）：清洗后直接调 media_user_info，其返回同时是主页投影来源；
// 「最多三次」只是对 RESULT_VALIDATION_FAILED 的有界重试。成功路径 = 主页 1 次 + 列表 1 页。
import type { AiMasterAction } from "./contract";

export const SUCCESS_CALL_PLAN: readonly AiMasterAction[] = Object.freeze(["media_user_info", "user_video_list"]);

export const MAX_RESOLVE_ATTEMPTS = 3;

export type ProfileAttemptOutcome = "decoded" | "result_validation_failed" | "other_failure";

export type ProfileAttemptDecision =
  | { next: "proceed_to_list" }
  | { next: "retry"; nextAttempt: number }
  | { next: "terminal"; entryOutcome: "invalid_link"; attempts: number }
  | { next: "defer_to_failure_policy" };

/** 终态决定里没有任何账号、归属、快照字段：三次失败不产生业务身份（R4.2）。 */
export function afterProfileAttempt(attempt: number, outcome: ProfileAttemptOutcome): ProfileAttemptDecision {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_RESOLVE_ATTEMPTS) {
    throw new RangeError(`解析尝试序号必须在 1..${MAX_RESOLVE_ATTEMPTS}：${attempt}`);
  }
  if (outcome === "decoded") return { next: "proceed_to_list" };
  if (outcome === "other_failure") return { next: "defer_to_failure_policy" };
  return attempt < MAX_RESOLVE_ATTEMPTS
    ? { next: "retry", nextAttempt: attempt + 1 }
    : { next: "terminal", entryOutcome: "invalid_link", attempts: attempt };
}
