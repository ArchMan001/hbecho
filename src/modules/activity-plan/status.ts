// 综合账号状态（A §11.6、requirements AP-13）：读取时按优先级取第一条命中；三个维度（录入状态、名单状态、监控状态）各自存储，不合成一列存。
// 优先级：链接无效 → 疑似空账号 → XX 被关闭（取最上级）→ 被停止监控 → 已移出活动计划 → 正常采集。
import type { ExclusionReason } from "../monitoring/reasons";

export type CompositeCode = "invalid_link" | "suspected_empty" | "upstream_closed" | "monitoring_stopped" | "removed_from_plan" | "normal";
export interface CompositeStatus {
  code: CompositeCode;
  label: string;
  /** 补充说明：哪一级被关闭、人工还是无引用 */
  detail?: string;
}
export interface StatusFacts {
  /** 导入行结果（仅批次行有）：invalid 表示链接无效 */
  rowOutcome?: string | null;
  intakeStatus: string;
  /** monitoring.explain 的第一个失败原因；null 表示有效监控 */
  exclusion: ExclusionReason | null;
  assignmentEnabled: boolean;
  closedReason: string | null;
  entryState: "in_roster" | "removed" | null;
}

/** explain 返回的全部排除原因都必须有业务文案（遗漏使测试失败）；已停用 / 已撤店是显示扩展，不是 PRD 原文。 */
export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  deleted: "账号已确认删除",
  suspected_empty: "疑似空账号",
  brand_inactive: "品牌已停用",
  region_inactive: "大区已停用",
  branch_inactive: "分公司已停用",
  branch_off: "分公司被关闭",
  dealer_inactive: "经销商已停用",
  dealer_off: "经销商被关闭",
  store_closed: "门店已撤店",
  store_off: "门店被关闭",
  staff_inactive: "专员已停用",
  staff_off: "专员被关闭",
  account_off: "账号被停止监控",
  no_assignment: "没有归属",
};
const CLOSED_REASON_LABELS: Record<string, string> = { manual: "人工停止", unreferenced_15d: "无计划引用自动停采" };

export function composeStatus(f: StatusFacts): CompositeStatus {
  if (f.rowOutcome === "invalid") return { code: "invalid_link", label: "链接无效" };
  if (f.intakeStatus === "suspected_empty" || f.exclusion === "suspected_empty") return { code: "suspected_empty", label: "疑似空账号" };
  // 上级（含账号已删除、没有归属）关闭：取最上级，也就是 firstExclusionReason 返回的那一个
  if (f.exclusion !== null && f.exclusion !== "account_off") return { code: "upstream_closed", label: EXCLUSION_LABELS[f.exclusion], detail: f.exclusion };
  if (f.exclusion === "account_off" || !f.assignmentEnabled) {
    return { code: "monitoring_stopped", label: "被停止监控", ...(f.closedReason ? { detail: CLOSED_REASON_LABELS[f.closedReason] ?? f.closedReason } : {}) };
  }
  if (f.entryState === "removed") return { code: "removed_from_plan", label: "已移出活动计划" };
  return { code: "normal", label: "正常采集" };
}
