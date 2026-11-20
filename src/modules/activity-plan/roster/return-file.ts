// 回流文件（requirements AP-13；F-D11）：原 4 列 + 预检分类 / 结果 / 原因，只含 error、conflict、invalid、resolve_failed 的行。
// 业务把它改好后作为新文件重新上传（新批次）。单元格以 = + - @ \t \r 开头加 ' 前缀（展示保护）；带 BOM 的 UTF-8、CRLF，Excel 直接打开不乱码。
import { buildCsv } from "../../csv-file";
import { ROSTER_HEADER } from "../constants";

export const RETURN_COLUMNS = [...ROSTER_HEADER, "预检分类", "结果", "原因"] as const;
const CLASS_TEXT: Record<string, string> = { new: "可写入", new_staff: "将新建专员", update: "恢复", unchanged: "未变", error: "错误" };
const OUTCOME_TEXT: Record<string, string> = {
  imported: "已导入",
  unchanged: "已存在并引用",
  conflict: "冲突",
  invalid: "链接无效",
  pending_account: "解析中",
  suspected_empty: "疑似空账号",
  resolve_failed: "解析失败",
};
/** 面向业务的下一步提示；代码保留在括号里，便于回溯。每个 reason_code 都必须有文案（测试守护，遗漏使测试失败）。 */
export const REASON_TEXT: Record<string, string> = {
  // 预检
  required_missing: "有必填列为空，请补全",
  phone_invalid: "手机号不是 11 位大陆手机号（Excel 把手机号当数字会变成科学计数法，请先把整列设为文本再填）",
  name_too_long: "专员姓名太长（最多 100 字）",
  locator_too_long: "主页链接太长（最多 2048 字符）",
  store_not_found: "门店编码在系统中不存在，请联系管理员",
  store_brand_mismatch: "这个门店编码属于其他品牌，不属于本计划的品牌",
  store_closed: "该门店已撤店",
  store_sector_not_in_plan: "门店所属板块不在本计划的板块范围内",
  store_branch_not_authorized: "门店不属于你的分公司，请联系管理员",
  branch_not_joined: "该门店所属分公司还没有加入本计划",
  branch_inactive: "该门店所属分公司已停用",
  phone_belongs_to_other_store: "该手机号属于其他门店的有效专员，请联系超管",
  staff_inactive_restore_needed: "该门店有同手机号的已停用专员，请联系总部或超管恢复原专员",
  non_home_locator: "这是视频或笔记链接，不是主页链接，请换成账号主页链接",
  platform_mismatch: "链接所属平台与计划平台不一致",
  platform_unrecognized: "链接域名无法识别为任何支持的平台",
  locator_no_url: "主页链接里没有网址：请粘贴账号主页的分享链接（以 https:// 开头，或抖音 / 小红书复制出来的整段分享文案）；「请补充」「账号昵称」之类的文字不是链接",
  duplicate_phone_in_file: "同一手机号在文件里出现了多次，每位专员只填一行",
  phone_name_conflict_in_file: "同一手机号在文件里对应了不同姓名",
  duplicate_locator_in_file: "同一主页链接在文件里出现了多次",
  // 提示 / 已存在
  known_account_same_owner: "该主页已是这位专员的账号，已直接引用，无需再次解析",
  known_account_other_owner: "该主页已归属于其他专员，原归属不变",
  already_in_roster: "已经在本计划名单里，无需处理",
  restore_roster_entry: "该账号此前被移出，本次已恢复",
  staff_name_differs: "库中专员姓名与文件不同，以库中为准（不会覆盖）",
  // 确认 / 解析
  precheck_stale: "预检之后数据已变化，请重新上传预检",
  staff_phone_conflict: "新建专员时手机号已被另一位有效专员占用，请重新上传预检",
  assignment_conflict: "该主页已归属于其他专员，原归属不变，已记为冲突待处理",
  staff_platform_slot_taken: "该专员在这个平台已经有另一个账号",
  plan_state_changed: "解析完成时计划已不在采集中或分公司已退出，未加入名单",
  existing_account_referenced: "账号已存在，已加入本计划名单",
  restored_roster_entry: "该账号此前被移出，本次已恢复",
  suspected_empty: "疑似空账号（粉丝与作品都是 0），需有权限的人员确认后才会采集",
  result_validation_exhausted: "多次解析都没有得到有效结果，主页链接可能无效，请核对后重新上传",
  root_failed: "解析时出现技术故障，请稍后重新上传这一行",
  root_cancelled: "解析任务被取消",
  root_expired: "解析任务已超过保留期被清理，请重新上传这一行",
};
export interface ReturnRow {
  raw: Record<string, string>;
  precheckClass: string | null;
  outcome: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
}
export const isReturned = (r: Pick<ReturnRow, "precheckClass" | "outcome">): boolean =>
  r.precheckClass === "error" || r.outcome === "conflict" || r.outcome === "invalid" || r.outcome === "resolve_failed";

export function buildRosterReturnFile(rows: readonly ReturnRow[]): { content: string; rows: number } {
  const out: string[][] = [];
  for (const r of rows) {
    if (!isReturned(r)) continue;
    const reason = r.reasonCode ? `${REASON_TEXT[r.reasonCode] ?? r.reasonCode}（${r.reasonCode}${r.reasonDetail ? `：${r.reasonDetail}` : ""}）` : "";
    out.push([...ROSTER_HEADER.map((h) => r.raw[h] ?? ""), CLASS_TEXT[r.precheckClass ?? ""] ?? "", r.outcome ? (OUTCOME_TEXT[r.outcome] ?? r.outcome) : "未写入", reason]);
  }
  return { content: buildCsv(RETURN_COLUMNS, out), rows: out.length };
}
