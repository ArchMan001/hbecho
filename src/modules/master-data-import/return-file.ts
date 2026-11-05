// 回流 CSV（design §7.8、MD-8）：原 11 列 + 预检分类 / 结果 / 原因；只含 error、needs_superadmin、conflict 行。
// 单元格以 = + - @ \t \r 开头加 ' 前缀（F-D11，展示保护，业务重新上传前需去掉）；输出带 BOM 的 UTF-8，Excel 直接打开不乱码。
import { HEADER } from "./file-parser";

export const RETURN_COLUMNS = [...HEADER, "预检分类", "结果", "原因"] as const;

const CLASS_TEXT: Record<string, string> = { new: "新增", update: "更新", unchanged: "未变", error: "错误", needs_superadmin: "需超管处理" };
const OUTCOME_TEXT: Record<string, string> = { imported: "已写入", unchanged: "未变", conflict: "冲突", invalid: "无效" };

/** 面向业务的下一步提示；代码保留在括号里，便于回溯。 */
export const REASON_TEXT: Record<string, string> = {
  missing_required_field: "必填列为空，请补全",
  row_withdrawn: "撤店情况不是「无撤销」，该行不导入",
  row_digital_store: "是否数字门店不是「否」，该行不导入",
  dealer_code_missing: "门店所属商家渠道编码缺失（空 / -- / #N/A），请补全后重传",
  main_business_code_unmapped: "主营业务编码不在 13/15/23/25/33 内，系统不猜品牌",
  brand_not_authorized: "该品牌不在你的授权范围内",
  duplicate_store_code_in_file: "同一品牌的门店编码在文件内重复，请只保留一行",
  dealer_name_conflict_in_file: "同一商家渠道编码在文件内对应多个商家名称，请统一",
  brand_not_found: "品牌不存在，需超管处理",
  brand_inactive: "品牌已停用，需超管处理",
  branch_not_found: "分公司编码不在种子里，需超管补种子后重跑 bootstrap",
  branch_inactive: "分公司已停用，需超管处理",
  sector_not_found: "分公司下没有该板块，需超管处理",
  sector_inactive: "板块已停用，需超管处理",
  dealer_not_found: "经销商（门店所属商家）不存在，需超管以 structure 模式导入",
  dealer_inactive: "经销商已停用，需超管处理",
  dealer_name_mismatch: "商家名称与库中不一致，需超管处理",
  store_relation_change: "门店的经销商或板块变了，需超管处理",
  precheck_stale: "预检之后数据已变化，请重新上传预检",
  store_unique_conflict: "写入时门店编码冲突，请重新上传预检",
  dealer_name_conflict: "写入时经销商名称冲突，请重新上传预检",
};

export const csvCell = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export interface ReturnRow {
  raw: Record<string, string>;
  precheckClass: string | null;
  outcome: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
}

export const isReturned = (r: Pick<ReturnRow, "precheckClass" | "outcome">): boolean =>
  r.precheckClass === "error" || r.precheckClass === "needs_superadmin" || r.outcome === "conflict";

export function buildReturnFile(rows: readonly ReturnRow[]): string {
  const lines = [RETURN_COLUMNS.map(csvCell).join(",")];
  for (const r of rows) {
    if (!isReturned(r)) continue;
    const reason = r.reasonCode ? `${REASON_TEXT[r.reasonCode] ?? r.reasonCode}（${r.reasonCode}${r.reasonDetail ? `：${r.reasonDetail}` : ""}）` : "";
    const cells = [
      ...HEADER.map((h) => r.raw[h] ?? ""),
      CLASS_TEXT[r.precheckClass ?? ""] ?? "",
      r.outcome ? (OUTCOME_TEXT[r.outcome] ?? r.outcome) : "未写入",
      reason,
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
