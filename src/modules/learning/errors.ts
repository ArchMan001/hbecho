// 稳定错误码。category 决定 HTTP 状态；范围外一律 403，不是 404（requirements §5.5）。
// message 只面向操作者，不含对象 key 以外的存储细节、签名串或凭证。
export type LearningErrorCategory = "input" | "authorization" | "not_found" | "conflict" | "unavailable";

const STATUS: Record<LearningErrorCategory, 400 | 403 | 404 | 409 | 503> = { input: 400, authorization: 403, not_found: 404, conflict: 409, unavailable: 503 };

export class LearningError extends Error {
  constructor(
    readonly category: LearningErrorCategory,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LearningError";
  }
  get status(): 400 | 403 | 404 | 409 | 503 {
    return STATUS[this.category];
  }
}

/** 穿透 drizzle 的 cause 链取 MySQL 错误码（ER_DUP_ENTRY、ER_ROW_IS_REFERENCED_2……）。 */
export function mysqlErrorCode(e: unknown): string | undefined {
  for (let cur = e as { code?: unknown; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (typeof cur.code === "string" && cur.code.startsWith("ER_")) return cur.code;
  }
  return undefined;
}
