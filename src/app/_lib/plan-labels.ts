// 活动计划页面用语（ui-foundation §6.6）：状态码、平台、板块、预检分类、行结果、变更事件在这里换成人话。
// 未登记的码原样回退显示稳定码，不会被吞掉。内部字段名 / 表名不出现在界面。
import type { Tone } from "../_components/ui";

export const PLAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  collecting: { label: "采集中", tone: "green" },
  paused: { label: "暂停", tone: "amber" },
  archived: { label: "归档", tone: "gray" },
  deleted: { label: "已删除", tone: "gray" },
};
export const PLATFORM_LABEL: Record<string, string> = { douyin: "抖音", xiaohongshu: "小红书", kuaishou: "快手" };
export const SECTOR_LABEL: Record<string, string> = { water: "水机", home: "家装" };
export const sectorText = (keys: readonly string[]): string => keys.map((k) => SECTOR_LABEL[k] ?? k).join("、");

export const PRECHECK_LABEL: Record<string, { label: string; tone: Tone }> = {
  new: { label: "可写入", tone: "green" },
  new_staff: { label: "将新建专员", tone: "blue" },
  update: { label: "恢复", tone: "amber" },
  unchanged: { label: "未变", tone: "plain" },
  error: { label: "错误", tone: "red" },
  needs_superadmin: { label: "需超管处理", tone: "amber" },
};
export const OUTCOME_LABEL: Record<string, { label: string; tone: Tone }> = {
  imported: { label: "已导入", tone: "green" },
  unchanged: { label: "已存在并引用", tone: "plain" },
  conflict: { label: "归属冲突", tone: "red" },
  invalid: { label: "链接无效", tone: "red" },
  pending_account: { label: "解析中", tone: "amber" },
  suspected_empty: { label: "疑似空账号", tone: "amber" },
  resolve_failed: { label: "解析失败", tone: "red" },
};
export const BATCH_STATUS: Record<string, { label: string; tone: Tone }> = {
  prechecking: { label: "预检中", tone: "amber" },
  precheck_failed: { label: "预检失败", tone: "red" },
  awaiting_confirm: { label: "待确认", tone: "blue" },
  writing: { label: "写入中", tone: "amber" },
  resolving: { label: "解析中", tone: "amber" },
  completed: { label: "已完成", tone: "green" },
  failed: { label: "失败", tone: "red" },
};
export const ACCOUNT_STATUS_TONE: Record<string, Tone> = {
  normal: "green",
  suspected_empty: "amber",
  invalid_link: "red",
  upstream_closed: "gray",
  monitoring_stopped: "gray",
  removed_from_plan: "gray",
};
export const SWITCH_LEVEL_LABEL: Record<string, string> = { branch: "分公司", dealer: "经销商", store: "门店", staff: "专员", account: "账号" };

/** 变更记录的一行：标题 + 说明。detail 是模块写入的关键字段，未知字段不展示。 */
export function changeText(event: string, detail: Record<string, unknown> | null, branchName: string | null): { title: string; text: string } {
  const d = detail ?? {};
  const s = (k: string) => (d[k] === null || d[k] === undefined ? "" : String(d[k]));
  const where = branchName ? `${branchName}：` : "";
  switch (event) {
    case "plan_created":
      return { title: "创建计划", text: `${s("name")}（${PLATFORM_LABEL[s("platform")] ?? s("platform")}）` };
    case "plan_edited": {
      const keys = Object.keys(d).map((k) => ({ name: "名称", description: "说明", starts_on: "开始日期", ends_on: "结束日期" })[k] ?? k);
      return { title: "编辑计划", text: keys.length ? `修改了${keys.join("、")}` : "" };
    }
    case "plan_status_changed":
      return { title: "状态变更", text: `${PLAN_STATUS[s("from")]?.label ?? s("from")} → ${PLAN_STATUS[s("to")]?.label ?? s("to")}` };
    case "plan_deleted":
      return { title: "删除计划", text: "移入回收站，保留 30 天" };
    case "plan_restored":
      return { title: "从回收站恢复", text: `回到「${PLAN_STATUS[s("status")]?.label ?? s("status")}」` };
    case "branch_joined":
      return { title: "分公司加入", text: `${where}${d.rejoin ? "重新加入" : "加入计划"}` };
    case "branch_exited":
      return { title: "分公司退出", text: `${where}移出名单 ${s("roster_entries_removed") || 0} 项，释放负责人 ${s("owners_released") || 0} 个，关闭监控 ${s("accounts_closed") || 0} 个` };
    case "owner_claimed":
      return { title: "占用负责人名额", text: `${where}槽位 ${s("slot_no")}` };
    case "owner_replaced":
      return { title: "替换负责人", text: `${where}槽位 ${s("slot_no")}` };
    case "owner_released":
      return { title: "释放负责人名额", text: `${where}槽位 ${s("slot_no")}` };
    case "roster_batch_confirmed":
      return { title: "确认名单批次", text: `${where}已导入 ${s("imported") || 0}，已存在并引用 ${s("unchanged") || 0}，冲突 ${s("conflict") || 0}，解析中 ${s("pending_account") || 0}` };
    case "roster_entries_removed":
      return { title: "移出名单", text: `移出 ${s("entries") || 0} 项，关闭监控 ${s("accounts_closed") || 0} 个` };
    default:
      return { title: event, text: "" };
  }
}

/** 北京时间，精确到分钟（ui-foundation §6.7）。 */
export function bjt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
export const n = (v: number): string => v.toLocaleString("en-US");
