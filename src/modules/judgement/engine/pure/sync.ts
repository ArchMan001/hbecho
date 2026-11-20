// 同步完整谓词（design §7.5、PRD D-D14）：只用于零内容专员，对每位参与专员都算并存。偏保守：拿不准就判不完整。
import type { ZeroReason } from "./aggregate";

export interface ListTaskFact {
  status: string;
  continuityGapDetected: boolean;
}
export interface CheckpointFact {
  continuityStatus: string;
  lastGapAt: Date | null;
}
export interface SyncInput {
  /** 该账号最近一条已终态的列表任务（任何 purpose 的批次）；没有为 null */
  latest: { status: string } | null;
  /** 所属批次 logical_at ≥ 窗口起点的已终态列表任务 */
  sinceWindow: readonly ListTaskFact[];
  checkpoint: CheckpointFact | null;
  fromUtc: Date;
  /** 账号还有未终态的列表 / 主页 / 解析任务，或名单来自仍在解析的导入批次：不完整时原因记 sync_pending（采集中），不是采集失败。 */
  inFlight?: boolean;
}
export interface SyncResult {
  complete: boolean;
  reason: ZeroReason | null;
}
/**
 * 按顺序判，首个不满足的给出原因。注意 `succeeded_with_gap` 在 A 的 freshness 里算成功，但它带连续性缺口，
 * 对「确实没发」的断言必须判为 sync_gap。窗口前发生的缺口不影响本窗口；窗口内某次失败之后又成功且无缺口判完整（design §14 第 26 项，宽松版）。
 */
export function syncCompleteness(i: SyncInput): SyncResult {
  const r = judge(i);
  return !r.complete && i.inFlight ? { complete: false, reason: "sync_pending" } : r;
}
function judge(i: SyncInput): SyncResult {
  const bad = (reason: ZeroReason): SyncResult => ({ complete: false, reason });
  if (i.latest === null || ["failed", "dead", "cancelled"].includes(i.latest.status)) return bad("sync_failed");
  const cp = i.checkpoint;
  if (
    i.latest.status === "succeeded_with_gap" ||
    i.sinceWindow.some((t) => t.status === "succeeded_with_gap" || t.continuityGapDetected) ||
    cp?.continuityStatus === "blocked" ||
    (cp?.continuityStatus === "rebased_after_gap" && cp.lastGapAt !== null && cp.lastGapAt.getTime() >= i.fromUtc.getTime())
  )
    return bad("sync_gap");
  if (!i.sinceWindow.some((t) => t.status === "succeeded")) return bad("no_sync_in_window");
  return { complete: true, reason: null };
}
