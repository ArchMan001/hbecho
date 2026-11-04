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

function accountOf(captured: CapturedProviderResult, interpreted: Interpreted<ProfileData>): { namespace: string; id: string } {
  const l = interpreted.lineage;
  if (l.providerCallId !== captured.providerCallId || l.responseSha256 !== captured.responseSha256) {
    throw new RawCaptureError("pairing_mismatch", "账号标识与 payload 不是同一次调用的同一条终态");
  }
  if (interpreted.outcome.outcome !== "decoded") throw new RawCaptureError("pairing_identity_unavailable", "响应未能解码为主页");
  const a = interpreted.outcome.data.account;
  if (a.id.state !== "value") throw new RawCaptureError("pairing_identity_unavailable", "账号 ID 不是有效值");
  return { namespace: a.namespace, id: a.id.value };
}

/**
 * 异步主页：locator 发在提交调用里，账号 ID 来自轮询得到的终态 payload。二者靠供应商任务 ID 精确相等串起来
 * （同一个任务的提交与它的终态），任务 ID 缺失或不一致就拒绝——不是任意两次调用的拼接。
 */
export function pairLocatorWithAsyncAccount(
  submit: CapturedProviderResult,
  terminal: CapturedProviderResult,
  interpreted: Interpreted<ProfileData>,
): LocatorAccountPair {
  const a = submit.meta.providerTaskId;
  const b = terminal.meta.providerTaskId;
  if (a === null || b === null || a !== b) {
    throw new RawCaptureError("pairing_mismatch", "提交与终态不属于同一个供应商任务");
  }
  const account = accountOf(terminal, interpreted); // 校验账号侧：lineage 与终态 payload 一致
  const locator = locatorOfRequest(submit.requestBody);
  if (locator === null) throw new RawCaptureError("pairing_identity_unavailable", "无法从提交调用已落地的请求字节取得 locator");
  return { providerCallId: terminal.providerCallId, locator, account };
}
