// 同步 → 异步兜底（2026-11-06，刘学奎确认）：只用于单次调用的动作（主页、详情）。
// 第 1 次尝试按配置（同步）；同步调用超时 / 结果不明 / RESULT_VALIDATION_FAILED 之后，第 2、3 次尝试改走异步。
// 列表和评论按页翻（call_sequence 就是页号），异步列表三平台都稳定失败，所以不在此列。
// 排在队尾不需要额外机制：claimNext 的排序是 priority DESC, attempt_count ASC，重试过的任务本来就排在同优先级未试过的任务之后。
import { UnsupportedCapabilityError, capabilityGate, type Environment } from "./capability";
import type { AiMasterAction, ExecutionMode, Platform } from "./contract";

const FALLBACK_ACTIONS: ReadonlySet<AiMasterAction> = new Set(["media_user_info", "media_stats_number"]);
/** sync-runner 的失败码：超时、结果不明、RESULT_VALIDATION_FAILED。 */
const TRIGGER_CODES: ReadonlySet<string> = new Set(["transport_timeout", "ambiguous_unresolved", "provider_validation_failed"]);

/** 该平台 × 动作的异步模式在当前环境是否放行（不抛异常）。 */
export function asyncApproved(platform: Platform, action: AiMasterAction, environment: Environment): boolean {
  try {
    capabilityGate.require({ platform, action, mode: "asynchronous", environment });
    return true;
  } catch (e) {
    if (e instanceof UnsupportedCapabilityError) return false;
    throw e;
  }
}

/**
 * 本次尝试实际使用的模式。上一次失败是触发条件，或者上一次已经在用异步（失败时 Runner 会把 `mode_used` 写进 last_error_detail），
 * 就改走异步；异步没放行则保持配置的模式。
 */
export function effectiveMode(p: {
  configured: ExecutionMode;
  platform: Platform;
  action: AiMasterAction;
  environment: Environment;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorDetail: unknown;
}): ExecutionMode {
  if (p.configured !== "synchronous" || p.attemptCount < 1 || !FALLBACK_ACTIONS.has(p.action)) return p.configured;
  const detail = p.lastErrorDetail as { mode_used?: unknown } | null;
  const sticky = detail?.mode_used === "asynchronous";
  if (!sticky && !(p.lastErrorCode !== null && TRIGGER_CODES.has(p.lastErrorCode))) return p.configured;
  return asyncApproved(p.platform, p.action, p.environment) ? "asynchronous" : p.configured;
}
