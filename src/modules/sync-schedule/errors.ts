export type SyncErrorCategory = "input" | "authorization" | "conflict" | "not_found" | "configuration";
/** 稳定的拒绝原因；CLI 与将来的 HTTP 只依赖 code。 */
export type SyncErrorCode =
  | "invalid_input"
  | "forbidden"
  | "out_of_scope"
  | "idempotency_conflict"
  | "not_found"
  | "not_cancellable"
  | "slot_taken"
  | "not_retryable"
  | "unsupported_capability"
  | "sync_settings_missing"
  | "invalid_settings";
const CATEGORY: Record<SyncErrorCode, SyncErrorCategory> = {
  invalid_input: "input",
  forbidden: "authorization",
  out_of_scope: "authorization",
  idempotency_conflict: "conflict",
  not_cancellable: "conflict",
  slot_taken: "conflict",
  not_retryable: "conflict",
  unsupported_capability: "input",
  not_found: "not_found",
  sync_settings_missing: "configuration",
  invalid_settings: "configuration",
};
export class SyncError extends Error {
  readonly category: SyncErrorCategory;
  constructor(
    readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyncError";
    this.category = CATEGORY[code];
  }
}
