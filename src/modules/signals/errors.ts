// 稳定错误码。CLI 按 category 映射退出码（与 PlanError / MasterDataError 同一套）；message 只面向操作者，
// 不含文本原文、签名 URL 或凭证。
export type SignalErrorCategory = "input" | "authorization" | "conflict" | "not_found" | "limit" | "configuration";
export class SignalError extends Error {
  constructor(
    readonly category: SignalErrorCategory,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SignalError";
  }
}
