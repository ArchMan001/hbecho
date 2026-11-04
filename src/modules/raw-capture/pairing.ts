// 链接与账号 ID 成对写入（A v1.10 §11.2.1、R3.7）：二者必须来自同一条已捕获的终态 payload，不得跨调用拼接。
import type { ProfileData } from "../provider-adapter";
import type { CapturedProviderResult } from "./captured";
import { RawCaptureError } from "./errors";
import { locatorOfRequest } from "./gateway";
import type { Interpreted } from "./interpret";

export interface LocatorAccountPair {
  providerCallId: bigint;
  /** 该次调用实际发给供应商的（清洗后的）入口，取自已落地的请求字节。 */
  locator: string;
  account: { namespace: string; id: string };
}

export function pairLocatorWithAccount(captured: CapturedProviderResult, interpreted: Interpreted<ProfileData>): LocatorAccountPair {
  const l = interpreted.lineage;
  if (l.providerCallId !== captured.providerCallId || l.responseSha256 !== captured.responseSha256) {
    throw new RawCaptureError("pairing_mismatch", "账号标识与 locator 不来自同一次调用的同一条 payload");
  }
  if (interpreted.outcome.outcome !== "decoded") throw new RawCaptureError("pairing_identity_unavailable", "响应未能解码为主页");
  const account = interpreted.outcome.data.account;
  if (account.id.state !== "value") throw new RawCaptureError("pairing_identity_unavailable", "账号 ID 不是有效值");
  const locator = locatorOfRequest(captured.requestBody);
  if (locator === null) throw new RawCaptureError("pairing_identity_unavailable", "无法从已落地的请求字节取得 locator");
  return { providerCallId: captured.providerCallId, locator, account: { namespace: account.namespace, id: account.id.value } };
}
