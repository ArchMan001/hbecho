// 原型演示数据。业务字段与状态取自 hbecho 的 A/B spec；
// 数据本身是脱敏造数，不代表真实客户或账号。

export const ROLES = {
  platform_admin: { label: "平台超管", rank: 4, scope: "全部品牌 × 全部组织" },
  hq_manager: { label: "总部人员", rank: 3, scope: "授权品牌 × 全部组织" },
  branch_manager: { label: "分公司人员", rank: 2, scope: "授权品牌 × 授权分公司" },
  store_staff: { label: "门店专员", rank: 1, scope: "本人" },
};

// 仅用于 ui-lab 静态原型的演示账号，不是生产账号，也不会写入任何数据库。
export const DEMO_ACCOUNT = {
  name: "刘学奎",
  role: "platform_admin",
  phone: "13800002041",
  phoneDisplay: "138 0000 2041",
  password: "Hbecho@2026",
  code: "123456",
};

export const BRANDS = [
  { code: "hitachi", name: "日立" },
  { code: "hisense", name: "海信" },
  { code: "york", name: "约克VRF" },
];

export const PLATFORMS = ["抖音", "小红书", "快手"];
export const SECTORS = ["水机", "家装"];

export const PLANS = [
  {
    id: "p1",
    name: "2026 双十一家装专项",
    brand: "日立",
    platform: "抖音",
    sectors: ["家装"],
    status: "collecting",
    start: "2026-10-20",
    end: "2026-11-20",
    branches: 6,
    accounts: 842,
    owners: 2,
    pending: 3,
    needJudgement: 1,
    creator: "刘学奎",
    created: "2026-10-18",
    description: "双十一家装内容专项，覆盖北京、上海、广州等 6 个分公司；只统计名单内账号的家装内容。",
  },
  {
    id: "p2",
    name: "海信水机年度内容计划",
    brand: "海信",
    platform: "小红书",
    sectors: ["水机"],
    status: "collecting",
    start: "2026-01-01",
    end: null,
    branches: 9,
    accounts: 1216,
    owners: 2,
    pending: 0,
    needJudgement: 1,
    creator: "王敏",
    created: "2026-01-03",
    description: "水机年度内容池；无结束日，视为持续引用。",
  },
  {
    id: "p3",
    name: "约克 VRF 门店焕新活动",
    brand: "约克VRF",
    platform: "快手",
    sectors: ["家装", "水机"],
    status: "paused",
    start: "2026-09-01",
    end: "2026-12-31",
    branches: 4,
    accounts: 318,
    owners: 1,
    pending: 0,
    needJudgement: 2,
    creator: "刘学奎",
    created: "2026-08-28",
    description: "门店焕新活动，暂停中；名单与负责人已冻结。",
  },
  {
    id: "p4",
    name: "日立春季新品预热",
    brand: "日立",
    platform: "抖音",
    sectors: ["家装"],
    status: "archived",
    start: "2026-03-01",
    end: "2026-05-31",
    branches: 5,
    accounts: 467,
    owners: 2,
    pending: 0,
    needJudgement: 1,
    creator: "赵倩",
    created: "2026-02-20",
    description: "春季新品预热，已归档；只读。",
  },
];

export const TRASH = [
  {
    id: "p9",
    name: "2026 端午门店活动",
    brand: "海信",
    platform: "抖音",
    sectors: ["家装"],
    status: "deleted",
    deletedAt: "2026-10-30",
    purgeAt: "2026-11-29",
    statusBefore: "paused",
    accounts: 122,
    branches: 3,
    creator: "刘学奎",
  },
];

export const PARTICIPANTS = {
  p1: [
    { branch: "北京分公司", status: "joined", owners: ["刘学奎", "王敏"], roster: 168, joinedAt: "2026-10-19" },
    { branch: "上海分公司", status: "joined", owners: ["赵倩", "—"], roster: 154, joinedAt: "2026-10-19" },
    { branch: "广州分公司", status: "joined", owners: ["陈晨", "李强"], roster: 131, joinedAt: "2026-10-20" },
    { branch: "成都分公司", status: "joined", owners: ["—", "—"], roster: 98, joinedAt: "2026-10-21" },
    { branch: "武汉分公司", status: "joined", owners: ["周舟", "—"], roster: 121, joinedAt: "2026-10-22" },
    { branch: "西安分公司", status: "exited", owners: ["—", "—"], roster: 0, joinedAt: "2026-10-19" },
  ],
  p2: [
    { branch: "北京分公司", status: "joined", owners: ["王敏", "—"], roster: 212, joinedAt: "2026-01-04" },
    { branch: "上海分公司", status: "joined", owners: ["赵倩", "—"], roster: 198, joinedAt: "2026-01-04" },
    { branch: "广州分公司", status: "joined", owners: ["—", "—"], roster: 176, joinedAt: "2026-01-05" },
  ],
};

export const ROSTER = {
  p1: [
    { id: "r1", store: "北京日立 001 店", staff: "张三", phone: "138****2041", account: "日立北京·小日", platform: "抖音", status: "normal", source: "2026-10-19 导入", batch: "B-20261019-001" },
    { id: "r2", store: "北京日立 002 店", staff: "李四", phone: "139****8820", account: "北京日立暖通", platform: "抖音", status: "normal", source: "2026-10-19 导入", batch: "B-20261019-001" },
    { id: "r3", store: "上海日立 005 店", staff: "王五", phone: "137****5512", account: "上海日立小助手", platform: "抖音", status: "suspected_empty", source: "2026-10-19 导入", batch: "B-20261019-001" },
    { id: "r4", store: "广州日立 003 店", staff: "陈晨", phone: "136****7781", account: "广州日立体验馆", platform: "抖音", status: "normal", source: "2026-10-20 导入", batch: "B-20261020-002" },
    { id: "r5", store: "成都日立 001 店", staff: "周舟", phone: "135****9902", account: "成都日立暖通", platform: "抖音", status: "removed", source: "2026-10-21 导入", batch: "B-20261021-001" },
    { id: "r6", store: "武汉日立 004 店", staff: "赵敏", phone: "133****2100", account: "武汉日立小日", platform: "抖音", status: "store_closed", source: "2026-10-22 导入", batch: "B-20261022-001" },
    { id: "r7", store: "西安日立 001 店", staff: "孙悦", phone: "132****6633", account: "西安日立暖通", platform: "抖音", status: "staff_inactive", source: "2026-10-22 导入", batch: "B-20261022-001" },
    { id: "r8", store: "北京日立 006 店", staff: "刘洋", phone: "131****0099", account: "北京日立新店", platform: "抖音", status: "normal", source: "2026-11-02 导入", batch: "B-20261102-001" },
  ],
  p2: [
    { id: "r21", store: "北京海信 001 店", staff: "王敏", phone: "139****8820", account: "海信北京水机", platform: "小红书", status: "normal", source: "2026-01-04 导入", batch: "B-20260104-001" },
    { id: "r22", store: "上海海信 003 店", staff: "赵倩", phone: "137****5512", account: "上海海信水机", platform: "小红书", status: "normal", source: "2026-01-04 导入", batch: "B-20260104-001" },
  ],
};

export const DOWNSTREAM = {
  p1: [{ sector: "家装", name: "2026 双十一家装判定计划", status: "created", results: 1284, running: 0 }],
  p2: [{ sector: "水机", name: "海信水机年度判定计划", status: "created", results: 2431, running: 0 }],
  p3: [
    { sector: "家装", name: "约克门店焕新·家装判定", status: "created", results: 642, running: 0 },
    { sector: "水机", name: "约克门店焕新·水机判定", status: "pending", results: 0, running: 0 },
  ],
  p4: [{ sector: "家装", name: "日立春季新品判定", status: "created", results: 902, running: 0 }],
};

export const CHANGES = {
  p1: [
    { time: "2026-11-06 10:22", actor: "刘学奎", title: "替换负责人", text: "北京分公司槽位 2：王敏 → 王敏（连任）；记变更。" },
    { time: "2026-11-02 16:40", actor: "赵倩", title: "名单导入确认", text: "批次 B-20261102-001：新增 12 行，恢复 2 行，冲突 1 行。" },
    { time: "2026-10-22 09:10", actor: "刘学奎", title: "分公司退出", text: "西安分公司退出；名单项置为已移出，负责人名额释放。" },
    { time: "2026-10-19 11:05", actor: "刘学奎", title: "创建计划", text: "创建「2026 双十一家装专项」，品牌日立 / 平台抖音 / 板块家装。" },
  ],
  p2: [],
  p3: [],
  p4: [],
};

export const BATCHES = {
  b1: {
    id: "B-20261102-001",
    planId: "p1",
    planName: "2026 双十一家装专项",
    file: "北京分公司_双十一名单_20261102.csv",
    submitter: "赵倩",
    branch: "北京分公司",
    uploadedAt: "2026-11-02 16:38",
    status: "resolving",
    template: "roster-import.v1",
    rows: 200,
    precheck: { new: 128, new_staff: 6, update: 4, unchanged: 52, error: 10, possible_new_accounts: 66, soft_cap_exceeded: false },
    confirm: { imported: 112, unchanged: 52, conflict: 3, invalid: 2, suspected_empty: 1, resolve_failed: 1, pending_account: 29, staff_created: 6, owner_claimed: true },
    results: [
      { row: 1, store: "北京日立 001 店", staff: "张三", phone: "138****2041", locator: "https://www.douyin.com/user/MS4w...", cls: "new", outcome: "imported", reason: "—" },
      { row: 2, store: "北京日立 001 店", staff: "李四", phone: "139****8820", locator: "https://v.douyin.com/abc/", cls: "new", outcome: "unchanged", reason: "existing_account_referenced" },
      { row: 3, store: "北京日立 002 店", staff: "王五", phone: "137****5512", locator: "https://www.douyin.com/user/MS4w...", cls: "new_staff", outcome: "imported", reason: "staff_created" },
      { row: 4, store: "北京日立 003 店", staff: "陈晨", phone: "136****7781", locator: "https://www.xiaohongshu.com/user/profile/...", cls: "error", outcome: "—", reason: "platform_mismatch" },
      { row: 5, store: "北京日立 004 店", staff: "周舟", phone: "1.38E+10", locator: "https://www.douyin.com/user/MS4w...", cls: "error", outcome: "—", reason: "phone_invalid" },
      { row: 6, store: "北京日立 005 店", staff: "赵敏", phone: "133****2100", locator: "https://example.com/user/1", cls: "error", outcome: "—", reason: "platform_unrecognized" },
      { row: 7, store: "北京日立 006 店", staff: "孙悦", phone: "132****6633", locator: "https://www.douyin.com/video/123", cls: "error", outcome: "—", reason: "non_home_locator" },
      { row: 8, store: "北京日立 007 店", staff: "刘洋", phone: "131****0099", locator: "https://www.douyin.com/user/MS4w...", cls: "update", outcome: "pending_account", reason: "restore_roster_entry" },
      { row: 9, store: "北京日立 008 店", staff: "何静", phone: "130****1122", locator: "https://www.douyin.com/user/MS4w...", cls: "new", outcome: "conflict", reason: "assignment_conflict" },
      { row: 10, store: "北京日立 009 店", staff: "马超", phone: "189****3344", locator: "https://www.douyin.com/user/MS4w...", cls: "new", outcome: "suspected_empty", reason: "suspected_empty" },
    ],
  },
  b2: {
    id: "B-20261019-001",
    planId: "p1",
    planName: "2026 双十一家装专项",
    file: "上海分公司_双十一名单_20261019.csv",
    submitter: "赵倩",
    branch: "上海分公司",
    uploadedAt: "2026-10-19 10:12",
    status: "completed",
    rows: 154,
    precheck: { new: 100, new_staff: 2, update: 0, unchanged: 48, error: 4 },
    confirm: { imported: 98, unchanged: 48, conflict: 2, invalid: 1, suspected_empty: 0, resolve_failed: 1, pending_account: 0, staff_created: 2, owner_claimed: true },
    results: [],
  },
};

export const ACCOUNTS = [
  { id: "a1", nickname: "日立北京·小日", platform: "抖音", brand: "日立", staff: "张三", store: "北京日立 001 店", branch: "北京分公司", status: "normal", intake: "normal", monitoring: true, reason: null, fans: "12.8万", works: 86, lastSync: "2026-11-06 08:12" },
  { id: "a2", nickname: "北京日立暖通", platform: "抖音", brand: "日立", staff: "李四", store: "北京日立 002 店", branch: "北京分公司", status: "normal", intake: "normal", monitoring: true, reason: null, fans: "8.4万", works: 41, lastSync: "2026-11-06 08:12" },
  { id: "a3", nickname: "上海日立小助手", platform: "抖音", brand: "日立", staff: "王五", store: "上海日立 005 店", branch: "上海分公司", status: "suspected_empty", intake: "suspected_empty", monitoring: true, reason: null, fans: "0", works: 0, lastSync: "2026-11-05 08:10" },
  { id: "a4", nickname: "广州日立体验馆", platform: "抖音", brand: "日立", staff: "陈晨", store: "广州日立 003 店", branch: "广州分公司", status: "normal", intake: "normal", monitoring: true, reason: null, fans: "5.1万", works: 63, lastSync: "2026-11-06 08:13" },
  { id: "a5", nickname: "成都日立暖通", platform: "抖音", brand: "日立", staff: "周舟", store: "成都日立 001 店", branch: "成都分公司", status: "account_unreferenced", intake: "normal", monitoring: false, reason: "unreferenced_15d", fans: "3.2万", works: 27, lastSync: "2026-10-12 08:09" },
  { id: "a6", nickname: "武汉日立小日", platform: "抖音", brand: "日立", staff: "赵敏", store: "武汉日立 004 店", branch: "武汉分公司", status: "store_closed", intake: "normal", monitoring: true, reason: "store_closed", fans: "2.8万", works: 19, lastSync: "2026-10-28 08:11" },
  { id: "a7", nickname: "西安日立暖通", platform: "抖音", brand: "日立", staff: "孙悦", store: "西安日立 001 店", branch: "西安分公司", status: "staff_inactive", intake: "normal", monitoring: true, reason: "staff_inactive", fans: "1.9万", works: 12, lastSync: "2026-10-20 08:10" },
  { id: "a8", nickname: "北京日立新店", platform: "抖音", brand: "日立", staff: "刘洋", store: "北京日立 006 店", branch: "北京分公司", status: "invalid", intake: "normal", monitoring: false, reason: "manual", fans: "—", works: 0, lastSync: "2026-11-02 16:40" },
];

export const USERS = [
  { id: "u1", name: "刘学奎", role: "platform_admin", phone: "138****2041", brands: ["日立", "海信", "约克VRF"], branches: "全部", store: null, status: "active", pendingDays: 0, lastLogin: "2026-11-08 09:12", createdBy: "运维引导" },
  { id: "u2", name: "王敏", role: "hq_manager", phone: "139****8820", brands: ["日立", "海信"], branches: "全部", store: null, status: "active", pendingDays: 0, lastLogin: "2026-11-08 08:40", createdBy: "刘学奎" },
  { id: "u3", name: "李强", role: "branch_manager", phone: "137****5512", brands: ["日立"], branches: "北京分公司", store: null, status: "active", pendingDays: 0, lastLogin: "2026-11-07 18:21", createdBy: "王敏" },
  { id: "u4", name: "张三", role: "store_staff", phone: "136****7781", brands: ["日立"], branches: "北京分公司", store: "北京日立 001 店", status: "pending_activation", pendingDays: 12, lastLogin: "—", createdBy: "李强" },
  { id: "u5", name: "赵倩", role: "branch_manager", phone: "135****9902", brands: ["海信"], branches: "上海分公司", store: null, status: "disabled", pendingDays: 0, lastLogin: "2026-10-21 11:08", createdBy: "王敏", disabledReason: "manual" },
  { id: "u6", name: "陈晨", role: "store_staff", phone: "133****2100", brands: ["约克VRF"], branches: "广州分公司", store: "广州约克 003 店", status: "active", pendingDays: 0, lastLogin: "2026-11-08 07:55", createdBy: "赵倩" },
];

export const AUDIT = [
  { time: "2026-11-08 09:12", actor: "user:1 刘学奎", action: "登录成功", target: "本人", outcome: "succeeded", reason: "login_succeeded", scope: "全部品牌" },
  { time: "2026-11-08 08:40", actor: "user:2 王敏", action: "登录成功", target: "本人", outcome: "succeeded", reason: "login_succeeded", scope: "日立、海信" },
  { time: "2026-11-07 18:21", actor: "user:3 李强", action: "名单导入确认", target: "B-20261102-001", outcome: "succeeded", reason: "user_import_confirmed", scope: "北京分公司" },
  { time: "2026-11-07 16:05", actor: "user:1 刘学奎", action: "替换负责人", target: "P-2026-001 / 北京分公司 / 槽位 2", outcome: "succeeded", reason: "access_changed", scope: "日立" },
  { time: "2026-11-07 11:32", actor: "user:2 王敏", action: "停用用户", target: "赵倩 (user:5)", outcome: "succeeded", reason: "user_disabled_manual", scope: "海信" },
  { time: "2026-11-06 10:22", actor: "service:access-worker", action: "专员停用联动", target: "user:9 孙悦", outcome: "succeeded", reason: "media_staff_disabled", scope: "系统" },
  { time: "2026-11-06 09:00", actor: "service:access-worker", action: "审计到期清理", target: "366 天前记录", outcome: "succeeded", reason: "audit_purged", scope: "系统" },
  { time: "2026-11-05 20:14", actor: "user:3 李强", action: "登录失败", target: "手机号 137****5512", outcome: "failed", reason: "invalid_password", scope: "北京分公司" },
  { time: "2026-11-05 20:13", actor: "user:3 李强", action: "登录失败", target: "手机号 137****5512", outcome: "failed", reason: "invalid_password", scope: "北京分公司" },
  { time: "2026-11-05 16:20", actor: "user:1 刘学奎", action: "导出提交", target: "账号清单 842 行", outcome: "succeeded", reason: "export_submitted", scope: "全部品牌" },
];

export const PLACEHOLDERS = {
  judgement: {
    title: "判定计划",
    sub: "D 域页面，不在本次 A/B 原型范围。",
    text: "本原型只覆盖 A 活动计划与 B 访问控制的页面。判定计划的三页向导、执行记录与结果由 D 域 spec 设计。",
  },
  reports: {
    title: "报表与看板",
    sub: "E 域页面，不在本次 A/B 原型范围。",
    text: "组织点检表、专员明细、计划看板与指标字典由 E 域 spec 设计；本原型只验证外壳与导航。",
  },
  master: {
    title: "主数据",
    sub: "a-master-data-import 的页面，不在本次 A/B 原型范围。",
    text: "组织与门店浏览、专员列表、权威主档导入、单条纠错与结构变更由主数据导入 spec 设计。",
  },
  learning: {
    title: "学习",
    sub: "G 域页面，不在本次 A/B 原型范围。",
    text: "课程管理、学习中心、学习汇总与标签管理由 G 域 spec 设计。",
  },
  system: {
    title: "系统",
    sub: "横切配置与外部账号页面，不在本次 A/B 原型范围。",
    text: "系统配置、外部监控账号、AI 调用与成本由后续 UI spec 设计。",
  },
};

export const getPlan = (id) => PLANS.find((p) => p.id === id);
export const getTrash = (id) => TRASH.find((p) => p.id === id);
export const getBatch = (id) => BATCHES[id];
export const getUser = (id) => USERS.find((u) => u.id === id);
export const getAccount = (id) => ACCOUNTS.find((a) => a.id === id);

export const PLAN_STATUS = {
  collecting: { label: "采集中", tone: "green" },
  paused: { label: "暂停", tone: "amber" },
  archived: { label: "归档", tone: "gray" },
  deleted: { label: "回收站", tone: "red" },
};

export const USER_STATUS = {
  pending_activation: { label: "待激活", tone: "amber" },
  active: { label: "有效", tone: "green" },
  disabled: { label: "停用", tone: "gray" },
};

export const ROLE_TONE = {
  platform_admin: "blue",
  hq_manager: "green",
  branch_manager: "amber",
  store_staff: "plain",
};

export const ACCOUNT_STATUS = {
  normal: { label: "正常采集", tone: "green" },
  suspected_empty: { label: "疑似空账号", tone: "amber" },
  invalid: { label: "链接无效", tone: "red" },
  store_closed: { label: "门店已撤", tone: "gray" },
  staff_inactive: { label: "专员已停用", tone: "gray" },
  account_manual: { label: "被停止监控", tone: "gray", note: "人工关闭" },
  account_unreferenced: { label: "被停止监控", tone: "gray", note: "15 天无引用" },
  removed: { label: "已移出活动计划", tone: "gray" },
};

export const PRECHECK = {
  new: { label: "可写入", tone: "green" },
  new_staff: { label: "将新建专员", tone: "blue" },
  update: { label: "恢复", tone: "amber" },
  unchanged: { label: "未变", tone: "plain" },
  error: { label: "错误", tone: "red" },
};

export const OUTCOME = {
  imported: { label: "已导入", tone: "green" },
  unchanged: { label: "已存在并引用", tone: "blue" },
  conflict: { label: "归属冲突", tone: "red" },
  invalid: { label: "链接无效", tone: "red" },
  suspected_empty: { label: "疑似空账号", tone: "amber" },
  resolve_failed: { label: "解析技术失败", tone: "gray" },
  pending_account: { label: "解析中", tone: "amber" },
};

export function num(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("zh-CN");
}