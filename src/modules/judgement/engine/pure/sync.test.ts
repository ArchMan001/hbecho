import { describe, expect, it } from "vitest";
import { syncCompleteness, type SyncInput } from "./sync";

const FROM = new Date("2026-11-01T00:00:00Z");
const ok = (over: Partial<SyncInput> = {}): SyncInput => ({ latest: { status: "succeeded" }, sinceWindow: [{ status: "succeeded", continuityGapDetected: false }], checkpoint: { continuityStatus: "ready", lastGapAt: null }, fromUtc: FROM, ...over });
const t = (status: string, gap = false) => ({ status, continuityGapDetected: gap });

describe("syncCompleteness（design §7.5 的结局）", () => {
  it("最近一次成功且窗口内有成功、无缺口 → 完整", () => expect(syncCompleteness(ok())).toEqual({ complete: true, reason: null }));
  it("没有任何列表任务 / 最近一次 failed / dead / cancelled → sync_failed", () => {
    expect(syncCompleteness(ok({ latest: null })).reason).toBe("sync_failed");
    for (const status of ["failed", "dead", "cancelled"]) expect(syncCompleteness(ok({ latest: { status } })).reason, status).toBe("sync_failed");
  });
  it("最近一次 succeeded_with_gap → sync_gap（A 的 freshness 算成功，这里不能算完整）", () => {
    expect(syncCompleteness(ok({ latest: { status: "succeeded_with_gap" } })).reason).toBe("sync_gap");
  });
  it("窗口内有 succeeded_with_gap 或连续性缺口标记，而最近一次是 succeeded → sync_gap", () => {
    expect(syncCompleteness(ok({ sinceWindow: [t("succeeded_with_gap"), t("succeeded")] })).reason).toBe("sync_gap");
    expect(syncCompleteness(ok({ sinceWindow: [t("succeeded", true)] })).reason).toBe("sync_gap");
  });
  it("检查点 blocked → sync_gap；rebased_after_gap 且缺口晚于窗口起点 → sync_gap，早于窗口起点 → 完整", () => {
    expect(syncCompleteness(ok({ checkpoint: { continuityStatus: "blocked", lastGapAt: null } })).reason).toBe("sync_gap");
    expect(syncCompleteness(ok({ checkpoint: { continuityStatus: "rebased_after_gap", lastGapAt: new Date("2026-11-05T00:00:00Z") } })).reason).toBe("sync_gap");
    expect(syncCompleteness(ok({ checkpoint: { continuityStatus: "rebased_after_gap", lastGapAt: new Date("2026-10-20T00:00:00Z") } })).complete).toBe(true);
    expect(syncCompleteness(ok({ checkpoint: { continuityStatus: "rebased_after_gap", lastGapAt: FROM } })).reason).toBe("sync_gap"); // 等于窗口起点算在窗口内
  });
  it("没有检查点行不当作缺口", () => expect(syncCompleteness(ok({ checkpoint: null })).complete).toBe(true));
  it("窗口内没有任何 succeeded → no_sync_in_window", () => {
    expect(syncCompleteness(ok({ sinceWindow: [] })).reason).toBe("no_sync_in_window");
  });
  it("宽松版：窗口内某次失败、之后又 succeeded 且无缺口 → 完整", () => {
    expect(syncCompleteness(ok({ sinceWindow: [t("failed"), t("succeeded")] })).complete).toBe(true);
  });
});
