// 判定计划原型 · 程序合成的脱敏数据（2026-11-12）
// 不连真实接口；数字之间保持直观自洽，只用于界面走查。

export const ROLES = {
  platform_admin: { label: "平台超管", short: "超管", scope: "全部品牌 × 全部组织" },
  hq_manager: { label: "总部人员", short: "总部", scope: "授权品牌 × 全部组织" },
  branch_manager: { label: "分公司人员", short: "分公司", scope: "授权品牌 × 授权分公司" },
  store_staff: { label: "门店专员", short: "门店", scope: "本人" },
};

export const ACTIVITY_PLANS = [
  {
    id: "ap-618",
    name: "618 家电焕新季",
    brand: "海信",
    platform: "抖音",
    period: "2026-05-20 ~ 2026-06-30",
    status: "collecting",
    statusLabel: "采集中",
    roster: 42,
    branches: ["北京", "上海", "广州", "杭州"],
    creator: "刘学奎",
    createdByMe: true,
  },
  {
    id: "ap-1111",
    name: "2026 双十一家装专项",
    brand: "日立",
    platform: "抖音",
    period: "2026-10-20 ~ 2026-11-15",
    status: "collecting",
    statusLabel: "采集中",
    roster: 36,
    branches: ["北京", "西安", "成都"],
    creator: "刘学奎",
    createdByMe: true,
  },
  {
    id: "ap-xhs",
    name: "小红书春季种草",
    brand: "海信",
    platform: "小红书",
    period: "2026-03-01 ~ 2026-04-30",
    status: "paused",
    statusLabel: "暂停",
    roster: 18,
    branches: ["上海", "杭州"],
    creator: "赵倩",
    createdByMe: false,
  },
];

export const JUDGEMENT_PLANS = [
  {
    id: "jp-pub",
    activityPlanId: "ap-618",
    alias: "618 主推视频考核",
    description: "主推视频需带活动话题、封面合规，至少 3 条；评论需提到安装或售后。",
    status: "active",
    statusLabel: "进行中",
    latestVersion: 3,
    publishedVersion: 3,
    draftVersion: null,
    wizardStep: "published",
    platform: "抖音",
    window: "2026-05-20 ~ 2026-06-18",
    kinds: "视频",
    createdAt: "2026-05-18 10:24",
    updatedAt: "2026-06-12 18:40",
    creator: "刘学奎",
    archivedAt: null,
  },
  {
    id: "jp-draft",
    activityPlanId: "ap-618",
    alias: "618 直播切片",
    description: "直播切片的二次剪辑，只看前两层，暂不配评论。",
    status: "active",
    statusLabel: "进行中",
    latestVersion: 1,
    publishedVersion: null,
    draftVersion: 1,
    wizardStep: "circled",
    platform: "抖音",
    window: "2026-05-20 ~ 2026-06-18",
    kinds: "视频",
    createdAt: "2026-06-10 09:12",
    updatedAt: "2026-06-10 09:40",
    creator: "刘学奎",
    archivedAt: null,
  },
  {
    id: "jp-arch",
    activityPlanId: "ap-618",
    alias: "618 图文专项",
    description: "图文内容的封面与话题校验，活动结束后归档。",
    status: "archived",
    statusLabel: "已归档",
    latestVersion: 1,
    publishedVersion: 1,
    draftVersion: null,
    wizardStep: "published",
    platform: "抖音",
    window: "2026-05-20 ~ 2026-06-30",
    kinds: "图文",
    createdAt: "2026-05-19 15:02",
    updatedAt: "2026-06-02 11:20",
    creator: "刘学奎",
    archivedAt: "2026-06-02 11:20",
  },
  {
    id: "jp-1111",
    activityPlanId: "ap-1111",
    alias: "双十一主推视频考核",
    description: "双十一主推视频，按封面模板与话题判定。",
    status: "active",
    statusLabel: "进行中",
    latestVersion: 2,
    publishedVersion: 2,
    draftVersion: null,
    wizardStep: "published",
    platform: "抖音",
    window: "2026-10-20 ~ 2026-11-15",
    kinds: "视频",
    createdAt: "2026-10-18 14:30",
    updatedAt: "2026-10-30 17:05",
    creator: "刘学奎",
    archivedAt: null,
  },
];

// 新建判定计划时默认拷贝活动计划的起止日（§1.4 第 3 项）
export const DEFAULT_CONFIG = {
  window: { from: "2026-05-20", to: "2026-06-18" },
  kinds: ["video"],
  layer1: {
    text: [{ alias: "主推卖点文本", fields: ["title", "body"], mode: "any", keywords: ["海信", "618", "以旧换新"] }],
    hashtags: [{ alias: "活动话题", mode: "all", values: ["618焕新"] }],
    duration: { minSeconds: 15, maxSeconds: 180 },
  },
  layer2: {
    template: { alias: "封面视觉规范", threshold: "6.50" },
    elements: [{ alias: "封面 logo 校验", elementKey: "logo", threshold: "7.00" }],
  },
  contentRequirement: { method: { type: "at_least_n", n: 3 } },
  commentRequirement: { alias: "安装与售后评论", mode: "any", keywords: ["安装", "赠品", "售后"], method: { type: "at_least_n", n: 2 } },
  accountRequirement: { avatar: { alias: "头像视觉规范", template: { threshold: "7.00" }, elements: [] } },
};

// 新建计划的初始配置：只有必选的窗口与形态；所有可选能力由用户自己添加（2026-11-12 刘学奎要求）。
export const EMPTY_CONFIG = {
  window: { from: "2026-05-20", to: "2026-06-18" },
  kinds: ["video"],
  layer1: { text: [], hashtags: [] },
  layer2: { elements: [] },
  contentRequirement: { method: { type: "at_least_n", n: 3 } },
};

export const CIRCLE_RESULT = {
  contents: 128,
  participants: 42,
  c1: 112,
  unobtained: 14,
  reasons: [
    { code: "not_computed", label: "识别尚未补算", count: 9 },
    { code: "published_at_missing", label: "发布时间缺失", count: 3 },
    { code: "content_kind_unknown", label: "内容形态无法归类", count: 2 },
  ],
  generatedAt: "2026-06-13 09:58",
};

export const TRIAL = {
  contents: 112,
  c2: 94,
  conditions: [
    {
      key: "cover_template",
      label: "封面 · 与标准图匹配",
      threshold: "6.50",
      distribution: [0, 2, 5, 9, 14, 21, 18, 12, 7, 4, 2],
      unobtained: 18,
      samples: {
        1: ["c-1042", "c-1098"],
        2: ["c-1102", "c-1120", "c-1131"],
        3: ["c-1011", "c-1024", "c-1066"],
        4: ["c-1038", "c-1077", "c-1090"],
        5: ["c-1004", "c-1019", "c-1058"],
        6: ["c-1009", "c-1031", "c-1062"],
        7: ["c-1002", "c-1027", "c-1054"],
        8: ["c-1014", "c-1046", "c-1088"],
        9: ["c-1001", "c-1033", "c-1071"],
        10: ["c-1006", "c-1022"],
      },
    },
    {
      key: "cover_element",
      label: "封面 · 元素「海信 logo」",
      threshold: "7.00",
      distribution: [0, 1, 3, 6, 11, 17, 22, 19, 13, 6, 3],
      unobtained: 11,
      samples: {
        2: ["c-1110", "c-1145"],
        3: ["c-1008", "c-1050", "c-1072"],
        4: ["c-1017", "c-1036", "c-1081"],
        5: ["c-1003", "c-1029", "c-1064"],
        6: ["c-1012", "c-1041", "c-1094"],
        7: ["c-1005", "c-1021", "c-1057"],
        8: ["c-1013", "c-1044", "c-1069"],
        9: ["c-1001", "c-1030", "c-1078"],
        10: ["c-1007", "c-1025", "c-1059"],
      },
    },
  ],
  accounts: { avatar: { label: "头像 · 与标准图匹配", threshold: "7.00", pass: 31, total: 42, unobtained: 3 } },
  generatedAt: "2026-06-13 10:04",
};

export const VERSIONS = {
  "jp-pub": [
    { version: 3, status: "published", publishedAt: "2026-06-05 16:20", basedOn: 2, note: "阈值从 6.00 调到 6.50；新增评论要求" },
    { version: 2, status: "published", publishedAt: "2026-05-28 14:10", basedOn: 1, note: "新增元素图「海信 logo」" },
    { version: 1, status: "published", publishedAt: "2026-05-21 11:02", basedOn: null, note: "首次发布" },
  ],
  "jp-draft": [{ version: 1, status: "draft", publishedAt: null, basedOn: null, note: "草稿：已圈定，未试跑" }],
  "jp-arch": [{ version: 1, status: "published", publishedAt: "2026-05-20 09:30", basedOn: null, note: "图文专项" }],
  "jp-1111": [
    { version: 2, status: "published", publishedAt: "2026-10-30 17:05", basedOn: 1, note: "话题从任一改为全含" },
    { version: 1, status: "published", publishedAt: "2026-10-22 10:15", basedOn: null, note: "首次发布" },
  ],
};

export const EXECUTIONS = [
  {
    id: 128,
    planId: "jp-pub",
    version: 3,
    status: "completed",
    statusLabel: "已完成",
    startedAt: "2026-06-12 18:22",
    completedAt: "2026-06-12 18:40",
    submittedBy: "刘学奎",
    participants: 42,
    counts: { success: 26, notMet: 11, unobtained: 5 },
    c1: 112,
    c2: 94,
    c3: 61,
    staleUsed: 2,
    window: "2026-05-20 ~ 2026-06-18",
    waitingOn: null,
    progress: 42,
  },
  {
    id: 129,
    planId: "jp-pub",
    version: 3,
    status: "waiting",
    statusLabel: "等待采集",
    startedAt: "2026-06-13 10:20",
    completedAt: null,
    submittedBy: "刘学奎",
    participants: 42,
    counts: null,
    c1: 112,
    c2: 87,
    c3: null,
    staleUsed: 0,
    window: "2026-05-20 ~ 2026-06-18",
    waitingOn: "demand",
    progress: 18,
  },
  {
    id: 127,
    planId: "jp-pub",
    version: 3,
    status: "completed",
    statusLabel: "已完成",
    startedAt: "2026-06-11 18:45",
    completedAt: "2026-06-11 19:05",
    submittedBy: "刘学奎",
    participants: 42,
    counts: { success: 24, notMet: 13, unobtained: 5 },
    c1: 110,
    c2: 92,
    c3: 58,
    staleUsed: 1,
    window: "2026-05-20 ~ 2026-06-18",
    waitingOn: null,
    progress: 42,
  },
  {
    id: 126,
    planId: "jp-pub",
    version: 2,
    status: "completed",
    statusLabel: "已完成",
    startedAt: "2026-06-08 17:10",
    completedAt: "2026-06-08 17:30",
    submittedBy: "刘学奎",
    participants: 42,
    counts: { success: 22, notMet: 15, unobtained: 5 },
    c1: 108,
    c2: 88,
    c3: 52,
    staleUsed: 3,
    window: "2026-05-20 ~ 2026-06-18",
    waitingOn: null,
    progress: 42,
  },
  {
    id: 125,
    planId: "jp-pub",
    version: 2,
    status: "cancelled",
    statusLabel: "已取消",
    startedAt: "2026-06-07 14:10",
    completedAt: "2026-06-07 14:12",
    submittedBy: "刘学奎",
    participants: 42,
    counts: null,
    c1: 108,
    c2: 0,
    c3: null,
    staleUsed: 0,
    window: "2026-05-20 ~ 2026-06-18",
    waitingOn: null,
    progress: 0,
  },
  {
    id: 124,
    planId: "jp-pub",
    version: 2,
    status: "failed",
    statusLabel: "失败",
    startedAt: "2026-06-06 09:30",
    completedAt: "2026-06-06 09:30",
    submittedBy: "刘学奎",
    participants: 42,
    counts: null,
    c1: 0,
    c2: 0,
    c3: null,
    staleUsed: 0,
    window: "2026-05-20 ~ 2026-06-18",
    waitingOn: null,
    progress: 0,
    failure: { code: "not_executable", label: "音频理解暂不可用" },
  },
  {
    id: 123,
    planId: "jp-pub",
    version: 1,
    status: "completed",
    statusLabel: "已完成",
    startedAt: "2026-05-22 15:40",
    completedAt: "2026-05-22 16:00",
    submittedBy: "刘学奎",
    participants: 42,
    counts: { success: 20, notMet: 17, unobtained: 5 },
    c1: 105,
    c2: 81,
    c3: 44,
    staleUsed: 0,
    window: "2026-05-20 ~ 2026-06-18",
    waitingOn: null,
    progress: 42,
  },
];

const SURNAMES = ["王", "李", "张", "赵", "陈", "刘", "周", "孙", "吴", "郑", "冯", "何", "许", "邓", "曹", "彭", "韩", "杨", "朱", "林", "高", "罗"];
const GIVEN = ["敏", "静", "伟", "倩", "晨", "洋", "宁", "悦", "迪", "爽", "雪", "磊", "晴", "超", "颖", "博", "琳", "涛", "丹", "峰", "欣", "瑜"];
const BRANCH_STORES = [
  { branch: "北京", stores: ["北京朝阳大悦城店", "北京西红门荟聚店", "北京丰台万达店"] },
  { branch: "上海", stores: ["上海五角场店", "上海莘庄龙之梦店", "上海浦东世纪汇店"] },
  { branch: "广州", stores: ["广州天河城店", "广州番禺万博店", "广州白云凯德店"] },
  { branch: "杭州", stores: ["杭州湖滨银泰店", "杭州城西银泰店", "杭州滨江龙湖店"] },
];
const PLATFORM_ACCOUNTS = ["hx_bj_01", "hx_bj_02", "hx_sh_01", "hx_sh_02", "hx_gz_01", "hx_gz_02", "hx_hz_01", "hx_hz_02"];

// 42 名专员，结果按 26 / 11 / 5 分布；固定种子，刷新后不变。
export function participantsFor(execution) {
  const dist = execution.counts ?? { success: 26, notMet: 11, unobtained: 5 };
  const rows = [];
  for (let i = 0; i < execution.participants; i += 1) {
    const surname = SURNAMES[i % SURNAMES.length];
    const given = GIVEN[(i * 7 + 3) % GIVEN.length];
    const bs = BRANCH_STORES[i % BRANCH_STORES.length];
    const store = bs.stores[i % bs.stores.length];
    let result;
    if (i < dist.success) result = "success";
    else if (i < dist.success + dist.notMet) result = "not_met";
    else result = "unobtained";

    // 让结果与内容计数自洽：成功至少 3 条通过；不达标有明确不通过；未获取有 U。
    let total = 4 + (i % 4);
    let p;
    let u;
    let f;
    let contentResult;
    if (i === 7) {
      // 零内容 · 同步完整 → 不达标（D-D14）
      total = 0; p = 0; u = 0; f = 0; contentResult = "not_met"; result = "not_met";
    } else if (i === 9) {
      // 零内容 · 同步失败 → 未获取成功（D-D14）
      total = 0; p = 0; u = 0; f = 0; contentResult = "unobtained"; result = "unobtained";
    } else if (result === "success") {
      p = 3 + (i % 3); u = 0; f = Math.max(0, total - p); contentResult = "success";
    } else if (result === "not_met") {
      p = 1 + (i % 2); u = 0; f = Math.max(1, total - p); contentResult = "not_met";
    } else {
      p = 2 + (i % 2); u = Math.max(1, total - p - 1); f = Math.max(0, total - p - u); contentResult = "unobtained";
    }
    const commentResult = result === "success" ? (i % 5 === 0 ? "not_met" : "success") : result === "not_met" ? (i % 4 === 0 ? "unobtained" : "not_met") : "unobtained";
    const accountResult = result === "unobtained" && i % 2 === 0 ? "unobtained" : result === "not_met" && i % 3 === 0 ? "unobtained" : "success";
    const planResult = [contentResult, commentResult, accountResult].includes("not_met")
      ? "not_met"
      : [contentResult, commentResult, accountResult].includes("unobtained")
        ? "unobtained"
        : "success";
    const syncComplete = !(i === 12 || i === 27);
    const reasons = ["media_pending", "audio_not_archived", "comments_incomplete", "account_unavailable", "no_profile_snapshot", "sync_gap"];
    const primaryReason = planResult === "unobtained"
      ? (i === 9 ? "sync_failed" : reasons[(i + 1) % reasons.length])
      : planResult === "not_met" && !syncComplete
        ? "sync_gap"
        : null;
    rows.push({
      staffId: `s-${1000 + i}`,
      name: `${surname}${given}`,
      store,
      branch: bs.branch,
      account: `${PLATFORM_ACCOUNTS[i % PLATFORM_ACCOUNTS.length]}${i < 8 ? "" : `_${i + 1}`}`,
      total, p, u, f,
      c1: Math.max(0, total - (i % 2)),
      c2: Math.max(0, total - 1 - (i % 3)),
      c3: Math.max(0, total - 2 - (i % 4)),
      contentResult, commentResult, accountResult, planResult,
      primaryReason,
      syncComplete,
      staleUsed: i % 9 === 0,
      zeroContent: total === 0,
    });
  }
  return rows;
}

// 专员的内容层证据；不出现标题 / 正文 / 评论原文。
export function contentsFor(row) {
  if (row.zeroContent) return [];
  const items = [];
  const n = Math.max(3, Math.min(6, row.total));
  for (let i = 0; i < n; i += 1) {
    const final = i < row.p ? "pass" : i < row.p + row.u ? "unobtained" : "fail";
    const l1 = final === "pass" ? "pass" : final === "fail" && i % 2 === 0 ? "fail" : "pass";
    const l2 = final === "pass" ? "pass" : final === "unobtained" ? (i % 2 === 0 ? "unobtained" : "pass") : "fail";
    const l3 = "not_configured";
    const reason = final === "unobtained"
      ? ["media_pending", "comments_incomplete", "account_unavailable", "dependency_timeout"][i % 4]
      : final === "fail"
        ? i % 2 === 0 ? "layer1_text_miss" : "layer2_below_threshold"
        : null;
    items.push({
      contentId: `c-${1000 + i * 7 + (Number(row.staffId.slice(2)) % 40)}`,
      publishedAt: `2026-06-${String(2 + (i % 12)).padStart(2, "0")} ${String(9 + i).padStart(2, "0")}:24`,
      kind: "视频",
      duration: `${28 + i * 9} 秒`,
      l1, l2, l3, final, reason,
      evidence: {
        text: i % 3 === 0 ? ["海信", "618"] : ["海信"],
        hashtag: i % 4 === 0 ? ["618焕新"] : [],
        duration: `${28 + i * 9} 秒`,
        cover: ["7.80", "6.20", "8.40", "5.90", "7.10", "6.80"][i % 6],
        element: ["8.20", "7.40", "6.10", "8.80", "7.60", "6.30"][i % 6],
        comment: final === "pass" ? { total: 12, pass: 3, samples: ["cm-88", "cm-92", "cm-101"] } : { total: 9, pass: 0, samples: [] },
      },
      stale: i === 1,
    });
  }
  return items;
}

export function methodLabel(method) {
  if (!method) return "—";
  if (method.type === "at_least_n") return `至少 ${method.n} 条`;
  if (method.type === "all") return "全部通过";
  if (method.type === "any") return "任一条通过";
  if (method.type === "ratio") return `比例 ≥ ${(method.bp / 100).toFixed(0)}%`;
  return "—";
}

export const RESULT_LABEL = { success: "成功", not_met: "不达标", unobtained: "未获取成功", pass: "通过", fail: "不通过", skipped: "跳过", not_configured: "未配置" };
export const RESULT_TONE = { success: "green", not_met: "red", unobtained: "gray", pass: "green", fail: "red", skipped: "plain", not_configured: "plain" };