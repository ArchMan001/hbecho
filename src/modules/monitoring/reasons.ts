// 有效监控（EffectiveMonitoring）的排除原因：纯函数，按「最上级优先」取第一个失败的条件（A §11.6、FS-2.4）。
// 品牌与大区只有业务状态、没有监控开关（constitution C5 v1.1、CONTEXT）；每一级内「业务状态无效」先于「开关关闭」。

/** FS-2.4 的原因码，加上账号没有归属行时的 no_assignment（不是「被排除」，而是「不在监控清单里」）。 */
export const EXCLUSION_REASONS = [
  "deleted",
  "suspected_empty",
  "brand_inactive",
  "region_inactive",
  "branch_inactive",
  "branch_off",
  "dealer_inactive",
  "dealer_off",
  "store_closed",
  "store_off",
  "staff_inactive",
  "staff_off",
  "account_off",
  "no_assignment",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** 一次评估需要的事实。组织链各级对 external 型为 null；staff 型缺失的级别按「无效」处理。 */
export interface MonitoringFacts {
  accountStatus: string;
  intakeStatus: string;
  watchType: string;
  assignmentEnabled: boolean;
  brandStatus: string | null;
  regionStatus: string | null;
  branch: { status: string | null; enabled: boolean | null };
  dealer: { status: string | null; enabled: boolean | null };
  store: { status: string | null; enabled: boolean | null };
  staff: { status: string | null; enabled: boolean | null };
}

const active = (s: string | null) => s === "active";

/** 返回第一个失败的原因；null 表示有效监控。 */
export function firstExclusionReason(f: MonitoringFacts): ExclusionReason | null {
  if (f.accountStatus === "deleted") return "deleted";
  if (f.intakeStatus === "suspected_empty") return "suspected_empty";
  if (f.watchType === "external") return f.assignmentEnabled ? null : "account_off";
  if (!active(f.brandStatus)) return "brand_inactive";
  if (!active(f.regionStatus)) return "region_inactive";
  if (!active(f.branch.status)) return "branch_inactive";
  if (f.branch.enabled !== true) return "branch_off";
  if (!active(f.dealer.status)) return "dealer_inactive";
  if (f.dealer.enabled !== true) return "dealer_off";
  if (!active(f.store.status)) return "store_closed";
  if (f.store.enabled !== true) return "store_off";
  if (!active(f.staff.status)) return "staff_inactive";
  if (f.staff.enabled !== true) return "staff_off";
  return f.assignmentEnabled ? null : "account_off";
}
