// 界面用语（ui-foundation §6.6）：内部角色码、状态码、事件码与原因码一律在这里换成人话；
// 未登记的码原样回退显示稳定码，不会被吞掉。
export const ROLE_LABEL: Record<string, string> = {
  platform_admin: "平台超管",
  hq_manager: "总部人员",
  branch_manager: "分公司人员",
  store_staff: "门店专员",
};
export const ROLE_SCOPE: Record<string, string> = {
  platform_admin: "全部品牌 × 全部组织",
  hq_manager: "授权品牌 × 全部组织",
  branch_manager: "授权品牌 × 授权分公司",
  store_staff: "本人",
};
export const USER_STATUS: Record<string, { label: string; tone: "amber" | "green" | "gray" }> = {
  pending_activation: { label: "待激活", tone: "amber" },
  active: { label: "有效", tone: "green" },
  disabled: { label: "停用", tone: "gray" },
};

export const AUDIT_EVENT_LABEL: Record<string, string> = {
  login_succeeded: "登录成功",
  login_failed: "登录失败",
  password_reset: "重置密码",
  password_changed: "修改密码",
  user_created: "创建用户",
  user_activated: "激活账号",
  user_disabled: "停用用户",
  user_restored: "恢复用户",
  access_changed: "变更授权",
  force_logout: "强制下线",
  user_import_confirmed: "批量导入用户",
  user_import_returnfile_downloaded: "下载导入回流文件",
  bootstrap_token_created: "生成引导令牌",
  bootstrap_superadmin: "创建首个超管",
  sms_daily_cap_reached: "短信达到每日上限",
  audit_purged: "清理过期审计",
};
export const AUDIT_RANGES: Array<[string, string]> = [["all", "全部时间"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["1y", "近 1 年"]];
export const AUDIT_EVENT_OPTIONS = Object.keys(AUDIT_EVENT_LABEL);

export const AUDIT_REASON_LABEL: Record<string, string> = {
  login_succeeded: "登录成功",
  invalid_password: "密码错误",
  account_locked: "连续失败，账号已锁定",
  otp_invalid: "验证码错误",
  password_reset: "密码已重置",
  password_changed: "密码已修改",
  user_created: "用户已创建",
  user_activated: "账号已激活",
  user_disabled_manual: "用户已停用（人工）",
  media_staff_disabled: "专员停用联动已处理",
  user_restored: "用户已恢复",
  access_changed: "授权已变更",
  force_logout: "会话已全部撤销",
  user_import_confirmed: "导入批次已确认",
  user_import_returnfile_downloaded: "回流文件已下载",
  bootstrap_token_created: "引导令牌已生成",
  bootstrap_superadmin: "首个超管已创建",
  sms_daily_cap_reached: "达到每日短信上限",
  audit_purged: "过期审计已清理",
  capability_not_granted: "角色没有这项权限",
  brand_not_authorized: "品牌不在授权范围",
  not_authorized: "未授权",
  store_not_in_scope: "门店不在管辖范围",
};

export const IMPORT_REASON_LABEL: Record<string, string> = {
  missing_required_field: "必填列为空",
  name_invalid: "姓名不合法",
  role_invalid: "角色不认识",
  phone_invalid: "手机号格式无效",
  brand_not_found: "品牌编码不存在",
  branch_not_found: "分公司编码不存在",
  brand_required: "缺少品牌",
  branch_required: "缺少分公司",
  store_code_required: "缺少门店编码",
  scope_fields_not_allowed: "多填了不需要的列",
  duplicate_phone_in_file: "文件内手机号重复",
  role_not_grantable: "角色超出可授予范围",
  scope_exceeds_boundary: "范围超出授权边界",
  store_not_in_scope: "门店不在管辖范围",
  shape_invalid: "角色与范围组合不对",
  staff_not_found: "未找到对应专员",
  staff_inactive: "专员已停用",
  staff_already_bound: "专员已有登录账号",
  phone_exists: "手机号已存在",
  conflict_at_confirm: "确认时被别人先建了",
  authorization_changed: "确认时权限已变化",
};
/** 越权行进「跳过」，其余错误进「错误」（design §15.4）。 */
export const SKIP_REASONS = new Set(["role_not_grantable", "scope_exceeds_boundary", "store_not_in_scope"]);

/** 北京时间，精确到分钟（ui-foundation §6.7）。 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}
