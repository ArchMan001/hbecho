// 稳定错误码。CLI 按 category 映射退出码（沿用 master-data：input/authorization 2、conflict 3、not_found 4、limit 5、其余 1）。
// message 只面向操作者，不含密码、令牌、验证码、整行原文。
export type AccessErrorCategory = "input" | "authorization" | "conflict" | "not_found" | "limit" | "configuration";

export class AccessError extends Error {
  constructor(
    readonly category: AccessErrorCategory,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

/** MySQL 1062，穿透 drizzle 的 cause 链；可选地要求错误信息点名某个唯一键。 */
export function isDuplicateKey(e: unknown, key?: string): boolean {
  for (let cur = e as { code?: string; sqlMessage?: string; message?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_DUP_ENTRY") return key === undefined || `${cur.sqlMessage ?? ""} ${cur.message ?? ""}`.includes(key);
  }
  return false;
}
