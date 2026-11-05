// 稳定错误码。CLI 按 category 映射退出码；message 只面向操作者，不含文件全文或凭证。
export type MasterDataErrorCategory = "input" | "authorization" | "conflict" | "not_found" | "limit" | "configuration";

export class MasterDataError extends Error {
  constructor(
    readonly category: MasterDataErrorCategory,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "MasterDataError";
  }
}

/** MySQL 1062，穿透 drizzle 的 cause 链。 */
export function isDuplicateKey(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_DUP_ENTRY") return true;
  }
  return false;
}
