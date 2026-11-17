// E 指标与看板 · 可点击原型数据（2026-11-16）
// 全部为程序合成的脱敏数据，不连真实接口；数字之间保持自洽，只用于界面走查。
// 口径依据：prd-domain-e-metrics.md v1.1、.kiro/specs/e-metrics/design.md §6–§8。

export const ROLES = {
  platform_admin: { label: "平台超管", short: "平台超管", scope: "全部品牌 × 全部组织" },
  hq_manager: { label: "总部人员", short: "总部人员", scope: "授权品牌 × 全部组织" },
  branch_manager: { label: "分公司人员", short: "分公司人员", scope: "海信 · 北京分公司" },
  store_staff: { label: "门店专员", short: "门店专员", scope: "本人" },
};

export const ACTIVITY = {
  id: "ap-618",
  name: "618 家电焕新季",
  brand: "海信",
  period: "2026-05-20 ~ 2026-06-30",
  statusLabel: "采集中",
  platforms: ["抖音", "小红书"],
  branchCount: 10,
  staffCount: 190,
};

export const SECTORS = {
  home: { key: "home", label: "家装", note: "家装板块：空调、电视、冰箱、洗衣机" },
  water: { key: "water", label: "水机", note: "水机板块：净水、热水、软水" },
};

export const PLANS = [
  {
    id: "jp-home",
    alias: "618 主推视频考核",
    sector: "home",
    version: 3,
    completedAt: "2026-06-19 01:40",
    status: "completed",
  },
  {
    id: "jp-home-2",
    alias: "618 家装直播切片",
    sector: "home",
    version: 1,
    completedAt: "2026-06-19 01:46",
    status: "completed",
  },
  {
    id: "jp-water",
    alias: "618 水机视频考核",
    sector: "water",
    version: 2,
    completedAt: "2026-06-19 01:52",
    status: "completed",
  },
  {
    id: "jp-water-2",
    alias: "618 水机直播切片",
    sector: "water",
    version: 2,
    completedAt: "2026-06-19 01:52",
    samePeopleAs: "jp-water",
    status: "completed",
  },
  {
    id: "jp-live",
    alias: "618 直播切片",
    sector: null,
    version: 1,
    pending: true,
    status: "not_executed",
  },
];

export const PLAN_BY_ID = Object.fromEntries(PLANS.map((p) => [p.id, p]));

export const PLANS_BY_SECTOR = {
  home: ["jp-home", "jp-home-2"],
  water: ["jp-water", "jp-water-2"],
};

export const PROJECTION = {
  projectionId: "pj-20260619-0214",
  status: "active",
  cutoffAt: "2026-06-18 23:59",
  activatedAt: "2026-06-19 02:14",
  stale: false,
  staleSince: null,
  descriptor: {
    metricSet: "指标集 v3",
    observationPolicy: "last_observed · 修订 2",
    pendingPlans: 1,
    sync: { state: "ok", successRate: 98.6, lastSyncAt: "2026-06-18 23:40" },
    attributionIssues: 3,
    executions: PLANS.filter((p) => !p.pending).map((p) => ({
      id: `ex-${p.id}`,
      planId: p.id,
      alias: p.alias,
      sector: p.sector,
      version: p.version,
      completedAt: p.completedAt,
    })),
  },
};

// 组织：大区 → 分公司 → 门店（原型只到门店；专员由数据生成）
export const REGIONS = [
  {
    id: "r-huabei",
    name: "华北",
    branches: [
      { id: "b-bj", name: "北京分公司", stores: ["朝阳门店", "海淀门店", "通州门店"] },
      { id: "b-tj", name: "天津分公司", stores: ["和平门店", "河西门店"] },
      { id: "b-sjz", name: "石家庄分公司", stores: ["长安门店"] },
    ],
  },
  {
    id: "r-huadong",
    name: "华东",
    branches: [
      { id: "b-sh", name: "上海分公司", stores: ["浦东门店", "徐汇门店", "静安门店"] },
      { id: "b-hz", name: "杭州分公司", stores: ["西湖门店", "滨江门店"] },
      { id: "b-nj", name: "南京分公司", stores: ["鼓楼门店", "江宁门店"] },
    ],
  },
  {
    id: "r-huanan",
    name: "华南",
    branches: [
      { id: "b-gz", name: "广州分公司", stores: ["天河门店", "越秀门店"] },
      { id: "b-sz", name: "深圳分公司", stores: ["南山门店", "福田门店"] },
    ],
  },
  {
    id: "r-xinan",
    name: "西南",
    branches: [
      { id: "b-cd", name: "成都分公司", stores: ["锦江门店"] },
      { id: "b-xa", name: "西安分公司", stores: ["雁塔门店"] },
    ],
  },
];

export const BRANCHES = REGIONS.flatMap((r) =>
  r.branches.map((b) => ({ ...b, regionId: r.id, regionName: r.name })),
);
export const BRANCH_BY_ID = Object.fromEntries(BRANCHES.map((b) => [b.id, b]));
export const REGION_BY_ID = Object.fromEntries(REGIONS.map((r) => [r.id, r]));

// 分公司行集是投影里冻结的名单：石家庄退出过水机板块，仍出现并标注 exited
export const BRANCH_FLAGS = {
  "b-sjz": { exitedSectors: ["water"] },
  "b-nj": { exited: true },
  "b-cd": { partialSectors: ["home"] },
};

// 计划 × 分公司：[考核人数, 完成人数, 未获取成功人数]
export const BRANCH_COUNTS = {
  "b-bj": { "jp-home": [32, 22, 2], "jp-home-2": [16, 11, 1], "jp-water": [26, 18, 1], "jp-water-2": [26, 12, 1] },
  "b-tj": { "jp-home": [18, 11, 2], "jp-home-2": [10, 6, 1], "jp-water": [12, 8, 1], "jp-water-2": [12, 8, 1] },
  "b-sjz": { "jp-home": [12, 6, 1], "jp-home-2": [8, 4, 1], "jp-water": [0, 0, 0], "jp-water-2": [0, 0, 0] },
  "b-sh": { "jp-home": [30, 20, 3], "jp-home-2": [16, 10, 1], "jp-water": [24, 16, 2], "jp-water-2": [24, 16, 2] },
  "b-hz": { "jp-home": [24, 15, 2], "jp-home-2": [12, 8, 1], "jp-water": [16, 11, 1], "jp-water-2": [16, 12, 1] },
  "b-nj": { "jp-home": [14, 9, 1], "jp-home-2": [8, 5, 0], "jp-water": [10, 7, 1], "jp-water-2": [10, 7, 1] },
  "b-gz": { "jp-home": [24, 16, 2], "jp-home-2": [12, 8, 1], "jp-water": [20, 13, 1], "jp-water-2": [20, 13, 2] },
  "b-sz": { "jp-home": [16, 11, 1], "jp-home-2": [8, 5, 0], "jp-water": [14, 9, 1], "jp-water-2": [14, 9, 1] },
  "b-cd": { "jp-home": [10, 7, 0], "jp-home-2": [5, 3, 0], "jp-water": [12, 8, 1], "jp-water-2": [12, 7, 2] },
  "b-xa": { "jp-home": [6, 4, 0], "jp-home-2": [3, 1, 0], "jp-water": [8, 6, 0], "jp-water-2": [8, 4, 1] },
};

export function countsFor(branchId, planId) {
  return BRANCH_COUNTS[branchId]?.[planId] ?? [0, 0, 0];
}

export function regionCounts(regionId, planId) {
  const region = REGION_BY_ID[regionId];
  const sum = [0, 0, 0];
  for (const b of region.branches) {
    const c = countsFor(b.id, planId);
    sum[0] += c[0];
    sum[1] += c[1];
    sum[2] += c[2];
  }
  return sum;
}

export function planTotals(planId) {
  return BRANCHES.reduce(
    (acc, b) => {
      const c = countsFor(b.id, planId);
      acc[0] += c[0];
      acc[1] += c[1];
      acc[2] += c[2];
      return acc;
    },
    [0, 0, 0],
  );
}

// 基础指标按板块各自的人口：账号数 / 粉丝总数 / 发布内容数
export function baseFor(branchId, sector) {
  const plans = PLANS_BY_SECTOR[sector] ?? [];
  const participants = Math.max(...plans.map((p) => countsFor(branchId, p)[0]), 0);
  if (!participants) return null;
  const seed = hash(`${branchId}-${sector}`);
  return {
    accountCount: Math.round(participants * 2.4) + (seed % 3),
    followerTotal: participants * 15400 + (seed % 89) * 100,
    publishedCount: participants * 7 + (seed % 13),
  };
}

export function baseRegion(regionId, sector) {
  const region = REGION_BY_ID[regionId];
  const rows = region.branches.map((b) => baseFor(b.id, sector)).filter(Boolean);
  if (!rows.length) return null;
  return rows.reduce(
    (acc, r) => ({
      accountCount: acc.accountCount + r.accountCount,
      followerTotal: acc.followerTotal + r.followerTotal,
      publishedCount: acc.publishedCount + r.publishedCount,
    }),
    { accountCount: 0, followerTotal: 0, publishedCount: 0 },
  );
}

// ---------------------------------------------------------------------------
// 专员行：来自冻结的参与名单；一人一行，多账号只体现在「账号数」
// ---------------------------------------------------------------------------

const SURNAMES = ["张", "王", "李", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "马", "朱", "胡", "郭", "何", "高", "林", "罗"];
const GIVENS = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "勇", "艳", "杰", "娟", "涛", "明", "超", "秀英", "霞", "平", "刚", "桂英", "晨"];

function nameFor(index) {
  return SURNAMES[index % 20] + GIVENS[Math.floor(index / 20) % 20];
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// 把「成功 / 未获取 / 其余不达标」均匀铺开，避免下钻时前几行全是成功
function splitStatuses(participant, achieved, unobtained) {
  const out = new Array(participant).fill("not_met");
  let placed = 0;
  for (let i = 0; i < participant && placed < achieved; i++) {
    const idx = Math.floor((placed + 0.5) * participant / achieved);
    if (out[idx] === "not_met") {
      out[idx] = "success";
      placed++;
    }
  }
  for (let i = 0; placed < achieved && i < participant; i++) {
    if (out[i] === "not_met") {
      out[i] = "success";
      placed++;
    }
  }
  let up = 0;
  for (let i = participant - 1; i >= 0 && up < unobtained; i--) {
    if (out[i] === "not_met") {
      out[i] = "unobtained";
      up++;
    }
  }
  for (let i = 0; up < unobtained && i < participant; i++) {
    if (out[i] === "not_met") {
      out[i] = "unobtained";
      up++;
    }
  }
  return out;
}

const REASONS = ["评论同步失败", "内容未归档", "平台不支持评论", "账号不可访问", "数据有缺口"];

function detailFor(status, index, platform) {
  if (status === "success") {
    const c3 = 2 + (index % 4);
    return {
      content: "success",
      comment: "success",
      account: "success",
      c1: c3 + 2 + (index % 3),
      c2: c3 + 1 + (index % 2),
      c3,
      reason: null,
      partial: index % 13 === 0,
    };
  }
  if (status === "unobtained") {
    const reason = platform === "小红书" && index % 2 === 0 ? "平台不支持评论" : REASONS[index % REASONS.length];
    return {
      content: "success",
      comment: "unobtained",
      account: "success",
      c1: 2 + (index % 3),
      c2: 0,
      c3: 0,
      reason,
      partial: platform === "小红书" && index % 3 === 0,
    };
  }
  const bucket = index % 3;
  const c3 = index % 3;
  return {
    content: bucket === 0 ? "not_met" : "success",
    comment: bucket === 1 ? "not_met" : "success",
    account: bucket === 2 ? "not_met" : "success",
    c1: c3 + 3 + (index % 3),
    c2: c3 + 1 + (index % 3),
    c3,
    reason: null,
    partial: false,
  };
}

export const STAFF = [];
const DETAIL = {}; // DETAIL[planId][staffId]
let staffSeq = 0;

for (const region of REGIONS) {
  for (const branch of region.branches) {
    const home = countsFor(branch.id, "jp-home");
    const home2 = countsFor(branch.id, "jp-home-2");
    const water = countsFor(branch.id, "jp-water");
    const water2 = countsFor(branch.id, "jp-water-2");
    const union = Math.max(home[0], water[0], home2[0], water2[0]);

    const statuses = {
      "jp-home": splitStatuses(...home),
      "jp-home-2": splitStatuses(...home2),
      "jp-water": splitStatuses(...water),
      "jp-water-2": splitStatuses(...water2),
    };

    for (let i = 0; i < union; i++) {
      const platform = staffSeq % 5 === 0 ? "小红书" : "抖音";
      const store = branch.stores[i % branch.stores.length];
      const staff = {
        id: `s-${staffSeq}`,
        name: nameFor(staffSeq),
        regionId: region.id,
        regionName: region.name,
        branchId: branch.id,
        branchName: branch.name,
        store,
        platform,
        accountCount: 1 + (staffSeq % 3),
        followerTotal: 8600 + ((staffSeq * 1373) % 71200),
        publishedCount: 3 + ((staffSeq * 7) % 16),
        lastObserved: staffSeq % 7 === 0 ? "2026-06-17" : "2026-06-18",
        plans: {},
      };

      for (const planId of ["jp-home", "jp-home-2", "jp-water", "jp-water-2"]) {
        if (i >= statuses[planId].length) continue;
        const status = statuses[planId][i];
        const detail = detailFor(status, i + hash(planId) % 11, platform);
        staff.plans[planId] = { status, ...detail };
        (DETAIL[planId] ??= {})[staff.id] = staff.plans[planId];
      }

      if (Object.keys(staff.plans).length) STAFF.push(staff);
      staffSeq++;
    }
  }
}

export const STAFF_BY_ID = Object.fromEntries(STAFF.map((s) => [s.id, s]));

export function staffForPlan(planId) {
  return STAFF.filter((s) => s.plans[planId]);
}

export function staffCount(planId) {
  return staffForPlan(planId).length;
}

// ---------------------------------------------------------------------------
// 命中内容：内容级通过全部内容层（C3）的行；同一作品在不同账号各一行
// ---------------------------------------------------------------------------

const PRODUCTS = ["海信新风空调", "海信洗烘一体机", "海信激光电视", "日立中央空调", "海信对开门冰箱", "海信零冷水热水器"];
const TITLE_TPL = [
  "{p}安装实录｜618 焕新",
  "{p}开箱与初体验",
  "为什么我最后选了{p}",
  "{p}用了 30 天的真实感受",
  "小户型也能装的{p}",
  "{p}安装避坑指南",
];

export const HITS = [];
let hitSeq = 0;
for (const plan of PLANS.filter((p) => !p.pending)) {
  for (const staff of STAFF) {
    const d = staff.plans[plan.id];
    if (!d || !d.c3) continue;
    for (let k = 0; k < d.c3; k++) {
      const seed = hash(`${plan.id}-${staff.id}-${k}`);
      const product = PRODUCTS[(seed + k) % PRODUCTS.length];
      const day = 20 + (seed % 30);
      const publishedAt = `2026-0${day > 31 ? 6 : 5}-${String(day > 31 ? day - 31 : day).padStart(2, "0")} ${String(8 + (seed % 12)).padStart(2, "0")}:${String(seed % 60).padStart(2, "0")}`;
      HITS.push({
        id: `h-${++hitSeq}`,
        planId: plan.id,
        staffId: staff.id,
        staffName: staff.name,
        regionId: staff.regionId,
        regionName: staff.regionName,
        branchId: staff.branchId,
        branchName: staff.branchName,
        store: staff.store,
        platform: staff.platform,
        nickname: `${staff.name}的焕新日记`,
        title: TITLE_TPL[(seed + k) % TITLE_TPL.length].replace("{p}", product),
        publishedAt,
        contentResult: "success",
        commentResult: "success",
        accountResult: "success",
        interactions: 120 + (seed % 9800),
        observedAt: staff.lastObserved,
        evidence: seed % 17 === 0 ? "expired" : "available",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 未获取成功原因分布（看板卡片 4）
// ---------------------------------------------------------------------------

export function unobtainedByReason(scopeBranchId = null) {
  const rows = scopeBranchId
    ? [{ id: scopeBranchId }]
    : BRANCHES;
  const counts = new Map([
    ["评论同步失败", 0],
    ["内容未归档", 0],
    ["平台不支持评论", 0],
    ["账号不可访问", 0],
    ["数据有缺口", 0],
  ]);
  for (const plan of PLANS.filter((p) => !p.pending)) {
    for (const b of rows) {
      const c = countsFor(b.id, plan.id);
      for (let i = 0; i < c[2]; i++) {
        const reason = REASONS[(i + hash(plan.id + b.id)) % REASONS.length];
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].map(([reason, value]) => ({ reason, value })).filter((r) => r.value);
}

// ---------------------------------------------------------------------------
// 指标字典
// ---------------------------------------------------------------------------

export const BUILTIN_METRICS = [
  { code: "account_count", name: "账号数", calc: "COUNT(DISTINCT 平台账号)", unit: "个", status: "active", note: "限定在判定计划参与名单内" },
  { code: "follower_total", name: "粉丝总数", calc: "SUM(账号最后观测粉丝数)", unit: "人", status: "active", note: "last_observed 快照" },
  { code: "published_content_count", name: "发布内容数", calc: "COUNT(内容快照 in 活动时间窗)", unit: "条", status: "active", note: "按账号各存一条" },
  { code: "interactions_total", name: "互动总数", calc: "SUM(赞 + 评 + 转 + 收)", unit: "次", status: "disabled", note: "跨平台口径未定，1.0 不上线" },
];

export const DERIVED_METRICS = PLANS.filter((p) => !p.pending).flatMap((plan) =>
  [
    { code: `participant_count`, name: "考核人数", calc: "D 的参与名单", unit: "人" },
    { code: `achieved`, name: "完成人数", calc: "COUNT(计划总结果 = 成功)", unit: "人" },
    { code: `rate`, name: "完成率", calc: "完成人数 ÷ 考核人数", unit: "%" },
    { code: `unobtained`, name: "未获取成功人数", calc: "COUNT(计划总结果 = 未获取成功)", unit: "人" },
  ].map((m) => ({ ...m, planId: plan.id, planAlias: plan.alias })),
);

export const CUSTOM_METRICS = [
  {
    code: "publish_per_participant",
    name: "人均发布内容数",
    expression: "发布内容数 ÷ 考核人数",
    operands: ["published_content_count", "participant_count"],
    operator: "÷",
    scope: "海信 · 全部品牌",
    revision: 2,
    status: "active",
    owner: "刘学奎",
    updatedAt: "2026-06-10 14:20",
    usage: { configs: 2, activities: 3 },
  },
  {
    code: "account_per_participant",
    name: "人均账号数",
    expression: "账号数 ÷ 考核人数",
    operands: ["account_count", "participant_count"],
    operator: "÷",
    scope: "海信 · 全部品牌",
    revision: 1,
    status: "draft",
    owner: "王敏",
    updatedAt: "2026-06-12 09:05",
    usage: { configs: 0, activities: 0 },
  },
  {
    code: "follower_per_account",
    name: "单账号平均粉丝数",
    expression: "粉丝总数 ÷ 账号数",
    operands: ["follower_total", "account_count"],
    operator: "÷",
    scope: "海信 · 家装",
    revision: 1,
    status: "archived",
    owner: "王敏",
    updatedAt: "2026-05-28 16:40",
    usage: { configs: 0, activities: 1 },
  },
];

// ---------------------------------------------------------------------------
// 下载中心
// ---------------------------------------------------------------------------

export const EXPORT_JOBS = [
  {
    id: "exp-1",
    object: "组织点检表",
    scope: "618 家电焕新季 · 家装 · 全部组织",
    status: "succeeded",
    rows: 1284,
    size: "82.4 KB",
    createdAt: "2026-06-19 10:24",
    expiresAt: "2026-06-26 10:24",
    warning: null,
  },
  {
    id: "exp-2",
    object: "专员明细",
    scope: "618 家电焕新季 · 家装 · 未达标",
    status: "running",
    rows: 512,
    size: "—",
    createdAt: "2026-06-19 10:31",
    expiresAt: "—",
    warning: null,
  },
  {
    id: "exp-3",
    object: "命中内容",
    scope: "618 家电焕新季 · 水机 · 全部组织",
    status: "queued",
    rows: 861,
    size: "—",
    createdAt: "2026-06-19 10:33",
    expiresAt: "—",
    warning: null,
  },
  {
    id: "exp-4",
    object: "判定结果",
    scope: "618 主推视频考核 · 执行 #ex-jp-home",
    status: "failed",
    rows: 186,
    size: "—",
    createdAt: "2026-06-19 09:58",
    expiresAt: "—",
    warning: null,
    error: "导出执行失败：判定结果读取超时（EXPORT_EXECUTION_TIMEOUT）",
  },
  {
    id: "exp-5",
    object: "命中内容",
    scope: "618 家电焕新季 · 家装 · 含封面",
    status: "succeeded",
    rows: 2196,
    size: "24.8 MB",
    createdAt: "2026-06-19 09:12",
    expiresAt: "2026-06-26 09:12",
    warning: "封面图 1,240 张，超过单文件上限，已降级为链接",
  },
  {
    id: "exp-6",
    object: "圈定结果",
    scope: "618 主推视频考核 · 圈定运行 #cr-118",
    status: "expired",
    rows: 4128,
    size: "1.2 MB",
    createdAt: "2026-06-01 11:20",
    expiresAt: "2026-06-08 11:20",
    warning: null,
  },
];

export const EXPORT_OBJECTS = [
  { key: "checklist", label: "组织点检表", formats: "Excel", note: "组织行 + 计划组列 + 页脚" },
  { key: "staff", label: "专员明细", formats: "Excel", note: "一行一名专员，含三项结果与 C1/C2/C3" },
  { key: "hits", label: "命中内容", formats: "Excel", note: "一行一条通过全部内容层的内容，可嵌封面" },
  { key: "judgement", label: "判定结果", formats: "Excel", note: "三个 sheet：汇总 / 明细 / 未获取成功" },
  { key: "circle", label: "圈定结果", formats: "Excel", note: "来自 D 的圈定运行；需选择完成的运行" },
];

export const FORMAT_HELPERS = {
  fmt(n) {
    if (n === null || n === undefined || n === "—") return "—";
    return Number(n).toLocaleString("zh-CN");
  },
  pct(numerator, denominator) {
    if (!denominator) return "—";
    return `${((numerator / denominator) * 100).toFixed(1)}%`;
  },
};