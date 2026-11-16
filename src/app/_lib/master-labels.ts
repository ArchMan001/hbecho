// 主数据导入页面用语（ui-foundation §6.6）：分类、模式在这里换成人话；原因码文案复用 Module 的 REASON_TEXT（回流文件同一份）。
import type { Tone } from "../_components/ui";

export const MD_CLASS: Record<string, { label: string; tone: Tone }> = {
  new: { label: "新增", tone: "green" },
  update: { label: "更新", tone: "blue" },
  unchanged: { label: "未变", tone: "plain" },
  error: { label: "错误", tone: "red" },
  needs_superadmin: { label: "需超管处理", tone: "amber" },
};
export const MD_CLASS_ORDER = ["new", "update", "unchanged", "error", "needs_superadmin"] as const;
export const MD_MODE: Record<string, string> = { import: "普通导入", structure: "结构导入" };
/** 门店状态（主数据浏览）：与 stores.status 的取值一一对应。 */
export const STORE_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "在用", tone: "green" },
  closed: { label: "已撤店", tone: "plain" },
};
export const MD_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  imported: { label: "已写入", tone: "green" },
  unchanged: { label: "未变", tone: "plain" },
  conflict: { label: "冲突", tone: "red" },
  invalid: { label: "无效", tone: "red" },
};
/** 非错误行（更新类）的变化说明；错误 / 需超管处理的原因文案在 Module 的 REASON_TEXT（回流文件同一份）。 */
export const MD_CHANGE_TEXT: Record<string, string> = {
  store_fields_changed: "门店名称或等级有变化",
  reactivate_store: "该门店此前已撤店，本次恢复为在用",
  change_store_relation: "门店与商家 / 板块的关系有变化（结构导入）",
  create_dealer: "新建商家",
  activate_dealer: "启用已停用的商家",
  update_dealer_name: "更新商家名称",
};
