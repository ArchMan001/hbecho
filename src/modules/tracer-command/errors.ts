export type TracerErrorCategory = "input" | "authorization" | "unsupported" | "conflict" | "not_found" | "configuration";

/** 稳定的拒绝原因。调用方（CLI、将来的 HTTP）只依赖 code，不解析 message。 */
export type TracerErrorCode =
  | "invalid_input"
  | "forbidden"
  | "out_of_scope"
  | "unsupported_capability"
  | "media_staff_not_found"
  | "media_staff_inactive"
  | "idempotency_conflict"
  | "not_found"
  | "sync_settings_missing";

const CATEGORY: Record<TracerErrorCode, TracerErrorCategory> = {
  invalid_input: "input",
  media_staff_not_found: "input",
  media_staff_inactive: "input",
  forbidden: "authorization",
  out_of_scope: "authorization",
  unsupported_capability: "unsupported",
  idempotency_conflict: "conflict",
  not_found: "not_found",
  sync_settings_missing: "configuration",
};

export class TracerError extends Error {
  readonly category: TracerErrorCategory;
  constructor(
    readonly code: TracerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TracerError";
    this.category = CATEGORY[code];
  }
}
