// CapturedProviderResult：只能引用已可靠落 ODS 的字节和一条 ProviderCall。
// 构造函数需要模块私有的 token，所以内存里的响应无法伪造成 captured——这是 raw-before-parse 的类型层 seam：
// 版本化 decoder 只接受 CapturedProviderResult.responseBody（它是从 ODS 读回并校验过摘要的字节）。
import type { FailureClassification } from "../provider-adapter/failure";
import type { ResponseMeta } from "../provider-adapter/peek";

const TOKEN = Symbol("captured-provider-result");

export interface CapturedFields {
  providerCallId: bigint;
  payloadId: bigint;
  httpStatus: number;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  responseSha256: string;
  classification: FailureClassification;
  meta: ResponseMeta;
}

export class CapturedProviderResult {
  readonly providerCallId: bigint;
  readonly payloadId: bigint;
  readonly httpStatus: number;
  readonly requestBody: Uint8Array;
  readonly responseBody: Uint8Array;
  readonly responseSha256: string;
  readonly classification: FailureClassification;
  readonly meta: ResponseMeta;

  constructor(token: symbol, f: CapturedFields) {
    if (token !== TOKEN) throw new Error("CapturedProviderResult 只能由 RawCaptureGateway 创建");
    this.providerCallId = f.providerCallId;
    this.payloadId = f.payloadId;
    this.httpStatus = f.httpStatus;
    this.requestBody = f.requestBody.slice();
    this.responseBody = f.responseBody.slice();
    this.responseSha256 = f.responseSha256;
    this.classification = f.classification;
    this.meta = f.meta;
    Object.freeze(this);
  }
}

/** 仅供 raw-capture 模块内部使用；index.ts 不导出。 */
export function createCaptured(f: CapturedFields): CapturedProviderResult {
  return new CapturedProviderResult(TOKEN, f);
}
