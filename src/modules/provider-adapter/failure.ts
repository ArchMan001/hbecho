// 响应级失败分类与有界重试决定（R13.9、R14.1、R14.3；A v1.10 §6.3）。
// 只给出「类别 + 重试策略」，不替业务下结论：RESULT_VALIDATION_FAILED 既可能是无效/私密/已删除主页，
// 也可能是供应商间歇失败，所以首次响应一律 businessMeaning='undetermined'，重试耗尽后才由业务层决定 invalid_link。
import type { ResponseMeta } from "./peek";
import type { ProfileAttemptOutcome } from "./strategy";

export type FailureCategory =
  | "none"
  | "provider_request_rejected" // HTTP 400 INVALID_REQUEST 等：错误 Key 与错误输入都返回它，不能只按状态码区分
  | "provider_auth" // 401 / 403
  | "provider_validation_failed" // HTTP 500 RESULT_VALIDATION_FAILED
  | "provider_null_result" // HTTP 2xx 但 result 为 null / 缺失（间歇性）
  | "provider_task_failed" // 异步任务本身失败（HTTP 200 + data.status=failed）
  | "rate_limited" // 429
  | "provider_server_error" // 其他 5xx
  | "invalid_response"; // action 不一致 / 不可解析

export type CallOutcome = "succeeded" | "http_error" | "provider_error" | "invalid_response";

export interface FailureClassification {
  category: FailureCategory;
  retry: "none" | "bounded";
  /** 写入 ods_provider_calls.outcome 的值（完整响应的终态）。 */
  outcome: CallOutcome;
  businessMeaning: "none" | "undetermined";
}

const VALIDATION_FAILED = "RESULT_VALIDATION_FAILED";

export function classifyResponse(input: { httpStatus: number; expectedAction: string; meta: ResponseMeta }): FailureClassification {
  const { httpStatus: s, meta } = input;
  const make = (
    category: FailureCategory,
    retry: FailureClassification["retry"],
    outcome: CallOutcome,
    businessMeaning: FailureClassification["businessMeaning"] = "none",
  ): FailureClassification => ({ category, retry, outcome, businessMeaning });

  if (s >= 200 && s < 300) {
    if (!meta.parseable || meta.action !== input.expectedAction) return make("invalid_response", "none", "invalid_response");
    if (meta.taskStatus === "failed") {
      return make("provider_task_failed", meta.errorCode === VALIDATION_FAILED ? "bounded" : "none", "provider_error", meta.errorCode === VALIDATION_FAILED ? "undetermined" : "none");
    }
    if (meta.resultIsNull) return make("provider_null_result", "bounded", "succeeded", "undetermined");
    return make("none", "none", "succeeded");
  }
  if (s === 401 || s === 403) return make("provider_auth", "none", "http_error");
  if (s === 429) return make("rate_limited", "bounded", "http_error");
  if (s === 500 && meta.errorCode === VALIDATION_FAILED) return make("provider_validation_failed", "bounded", "http_error", "undetermined");
  if (s >= 500) return make("provider_server_error", "bounded", "http_error");
  return make("provider_request_rejected", "none", "http_error");
}

export type RetryDecision = { retry: true; nextAttempt: number } | { retry: false; exhausted: boolean };

export function decideRetry(c: FailureClassification, attempt: number, maxAttempts: number): RetryDecision {
  if (c.retry !== "bounded") return { retry: false, exhausted: false };
  return attempt < maxAttempts ? { retry: true, nextAttempt: attempt + 1 } : { retry: false, exhausted: true };
}

/** 衔接 strategy.afterProfileAttempt：校验失败类才计入「最多三次 → invalid_link」。 */
export function profileAttemptOutcomeOf(c: FailureClassification): ProfileAttemptOutcome {
  if (c.category === "none") return "decoded";
  if (c.category === "provider_validation_failed" || c.category === "provider_null_result") return "result_validation_failed";
  return "other_failure";
}
