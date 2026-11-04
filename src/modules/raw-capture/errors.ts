export type RawCaptureErrorCode =
  | "request_intent_failed" // 请求意图没能可靠落 ODS：没有发送
  | "integrity_mismatch" // 从 ODS 读回的字节与登记的摘要/长度不一致
  | "call_not_found"
  | "ambiguous_resend_not_allowed"
  | "ambiguous_resend_exhausted"
  | "pairing_mismatch" // locator 与账号 ID 不来自同一条 captured payload
  | "pairing_identity_unavailable";

export class RawCaptureError extends Error {
  constructor(
    readonly code: RawCaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RawCaptureError";
  }
}

export type FenceFailureReason = "cancelled" | "stale_fence" | "lease_expired" | "task_not_running" | "task_not_found";

/** 陈旧 worker 想创建新的调用意图：拒绝，不留任何调用行。 */
export class StaleFenceError extends Error {
  constructor(readonly reason: FenceFailureReason) {
    super(`fencing 校验失败：${reason}`);
    this.name = "StaleFenceError";
  }
}
