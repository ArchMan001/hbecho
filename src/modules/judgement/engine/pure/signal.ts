// 信号状态 → 条件输入（design §7.4 fromSignal）。
import type { SignalLike } from "./types";

export type SignalInput =
  | { kind: "value"; value: unknown; stale: boolean; normalizerVersion?: number }
  | { kind: "unobtained"; reason: string; awaiting: boolean };

/** C 的这两个原因码 + queued / running 是「还在等」，其余原因对本次执行是终态（design §1.4 第 9 项）。 */
const AWAITING_REASONS: ReadonlySet<string> = new Set(["not_computed", "failed_under_old_version"]);

export function fromSignal(s: SignalLike): SignalInput {
  if (s.usable && (s.state === "valid" || s.state === "stale")) {
    return { kind: "value", value: s.value, stale: s.state === "stale", ...(s.normalizerVersion === undefined ? {} : { normalizerVersion: s.normalizerVersion }) };
  }
  const awaiting = s.pending === "queued" || s.pending === "running" || (s.state === "missing" && s.reason !== undefined && AWAITING_REASONS.has(s.reason));
  if (s.state === "stale") return { kind: "unobtained", reason: "stale_not_usable", awaiting: false };
  // missing / failed / not_applicable 一律未获取成功（PRD D §1.4：结构不适用也归未获取）；原因码逐字沿用 C 的
  return { kind: "unobtained", reason: s.reason ?? s.state, awaiting };
}
