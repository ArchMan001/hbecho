// 稳定错误码。页面只用 kind 决定显示什么（auth → 无权限态、input → 「筛选条件无效」、not_found → 404、unavailable → 通用错误态）。
// message 只面向操作者，不含 SQL、对象 key、签名串。
export type SquareErrorKind = "auth" | "input" | "not_found" | "unavailable";

export class SquareError extends Error {
  constructor(
    readonly kind: SquareErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SquareError";
  }
}

export const isSquareError = (e: unknown): e is SquareError => e instanceof SquareError;
