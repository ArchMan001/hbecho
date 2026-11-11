// 稳定错误码。CLI 按 category 映射退出码；message 只面向操作者，不含文件全文或凭证。
// category 与 MasterDataError 同一套，让两个 CLI 的退出码约定一致。
export type PlanErrorCategory = "input" | "authorization" | "conflict" | "not_found" | "limit" | "configuration";
export class PlanError extends Error {
  constructor(
    readonly category: PlanErrorCategory,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PlanError";
  }
}
/** MySQL 1062，穿透 drizzle 的 cause 链。 */
export function isDuplicateKey(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_DUP_ENTRY") return true;
  }
  return false;
}
