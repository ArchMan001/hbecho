// 稳定错误码。CLI 按 category 映射退出码（与 plan-cli 同一套：0 成功 / 2 输入或授权 / 3 冲突 / 4 不存在 / 5 超限 / 1 其他）；
// message 只面向操作者，不含评论原文、签名 URL 或凭证。
export type JudgementErrorCategory = "input" | "authorization" | "conflict" | "not_found" | "limit" | "configuration" | "dependency";
export class JudgementError extends Error {
  constructor(
    readonly category: JudgementErrorCategory,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "JudgementError";
  }
}
export const exitCodeOf = (e: unknown): number => {
  if (!(e instanceof JudgementError)) return 1;
  switch (e.category) {
    case "input":
    case "authorization":
      return 2;
    case "conflict":
      return 3;
    case "not_found":
      return 4;
    case "limit":
      return 5;
    default:
      return 1;
  }
};
/** MySQL 1062，穿透 drizzle 的 cause 链。 */
export function isDuplicateKey(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_DUP_ENTRY") return true;
  }
  return false;
}
