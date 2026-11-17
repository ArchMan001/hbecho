// 学习平台原型演示数据（g-learning-min）。业务字段取自 spec；
// 数据是脱敏造数，不代表真实课程或学员。

export const ROLES = {
  platform_admin: { label: "平台超管", scope: "全部品牌 × 全部组织" },
  hq_manager: { label: "总部人员", scope: "授权品牌 × 全部组织" },
  branch_manager: { label: "分公司人员", scope: "授权品牌 × 授权分公司" },
  store_staff: { label: "门店专员", scope: "本人" },
};

export const BRANDS = ["日立", "海信", "约克VRF"];

// 各角色的品牌范围（原型固定值，真实实现来自 B 域 DataScope）
export const ROLE_BRANDS = {
  platform_admin: ["日立", "海信", "约克VRF"],
  hq_manager: ["日立", "海信"],
  branch_manager: ["日立"],
  store_staff: ["日立"],
};

export const LEVELS = {
  all: { label: "全部人员", allowed: ["store_staff", "branch_manager", "hq_manager", "platform_admin"] },
  branch_and_above: { label: "分公司及以上", allowed: ["branch_manager", "hq_manager", "platform_admin"] },
  hq_and_above: { label: "总部及以上", allowed: ["hq_manager", "platform_admin"] },
};

// 两级标签：一级标签、二级标签均由平台管理员在「标签管理」维护；这里的名字只是 mock。
// 课程类型（视频/资料）、品牌是固定筛选，不属于标签。
export const TAG_CATEGORIES = [
  { id: "platform", name: "平台", tags: ["抖音", "小红书", "视频号", "GEO"] },
  { id: "sector", name: "板块", tags: ["账号", "短视频", "直播", "投流"] },
  { id: "stage", name: "阶段", tags: ["基础", "进阶"] },
  { id: "standard", name: "门店标准", tags: ["安装规范", "展陈规范", "服务规范"] },
];
export const TAGS = TAG_CATEGORIES.flatMap((c) => c.tags);

// kind: video | document；status: published | unpublished | archived
// brandScope: specified | all；vodStatus: normal | transcoding | failed
export const COURSES = [
  {
    id: "c1",
    title: "日立家装水机安装规范",
    kind: "video",
    description: "覆盖家装与水机场景的安装要点、常见返工原因与验收标准；由总部售后团队录制。",
    status: "published",
    brandScope: "specified",
    brands: ["日立"],
    level: "all",
    tags: ["抖音", "短视频", "基础", "安装规范"],
    coverTone: "teal",
    duration: "18:24",
    durationSec: 1104,
    vodStatus: "normal",
    updatedAt: "2026-11-06",
    uploader: "王敏",
  },
  {
    id: "c2",
    title: "双十一活动话术拆解",
    kind: "video",
    description: "家装活动期间的客户沟通结构：开场、需求确认、异议处理与促单。",
    status: "published",
    brandScope: "specified",
    brands: ["日立", "海信"],
    level: "branch_and_above",
    tags: ["抖音", "小红书", "直播", "进阶", "服务规范"],
    coverTone: "blue",
    duration: "42:10",
    durationSec: 2530,
    vodStatus: "normal",
    updatedAt: "2026-11-08",
    uploader: "刘学奎",
  },
  {
    id: "c3",
    title: "门店安全操作手册",
    kind: "document",
    description: "门店用电、登高与样机操作的底线要求；适合全员阅读。",
    status: "published",
    brandScope: "all",
    brands: [],
    level: "all",
    tags: ["视频号", "账号", "基础", "安装规范"],
    coverTone: "slate",
    fileType: "PDF",
    fileSize: "3.8 MB",
    updatedAt: "2026-11-04",
    uploader: "王敏",
  },
  {
    id: "c4",
    title: "海信水机产品知识",
    kind: "video",
    description: "海信水机产品线、核心卖点与竞品对比口径。",
    status: "published",
    brandScope: "specified",
    brands: ["海信"],
    level: "all",
    tags: ["抖音", "短视频", "基础", "展陈规范"],
    coverTone: "indigo",
    duration: "27:35",
    durationSec: 1655,
    vodStatus: "normal",
    updatedAt: "2026-11-05",
    uploader: "王敏",
  },
  {
    id: "c5",
    title: "约克 VRF 新品介绍",
    kind: "video",
    description: "约克 VRF 新品结构与项目话术，面向总部与分公司。",
    status: "published",
    brandScope: "specified",
    brands: ["约克VRF"],
    level: "hq_and_above",
    tags: ["小红书", "账号", "进阶", "展陈规范"],
    coverTone: "green",
    duration: "33:02",
    durationSec: 1982,
    vodStatus: "normal",
    updatedAt: "2026-11-01",
    uploader: "刘学奎",
  },
  {
    id: "c6",
    title: "家装客户沟通案例",
    kind: "document",
    description: "六组家装客户沟通截图，含需求确认与异议处理示例。",
    status: "published",
    brandScope: "specified",
    brands: ["日立"],
    level: "all",
    tags: ["小红书", "短视频", "基础", "服务规范"],
    coverTone: "amber",
    fileType: "PNG",
    fileSize: "1.2 MB",
    updatedAt: "2026-10-28",
    uploader: "赵倩",
  },
  {
    id: "c7",
    title: "2026 秋季新品培训",
    kind: "video",
    description: "被新版本替换的旧版培训，下架保留，学员不可见。",
    status: "unpublished",
    brandScope: "specified",
    brands: ["日立"],
    level: "all",
    tags: ["抖音", "直播", "进阶", "展陈规范"],
    coverTone: "slate",
    duration: "55:12",
    durationSec: 3312,
    vodStatus: "normal",
    updatedAt: "2026-10-20",
    uploader: "刘学奎",
  },
  {
    id: "c8",
    title: "安装视频",
    kind: "video",
    description: "刚上传的新版本，VOD 仍在转码；学员侧暂不可播。",
    status: "published",
    brandScope: "specified",
    brands: ["日立"],
    level: "all",
    tags: ["抖音", "短视频", "基础", "安装规范"],
    coverTone: "teal",
    duration: "—",
    durationSec: 0,
    vodStatus: "transcoding",
    updatedAt: "2026-11-10",
    uploader: "王敏",
  },
  {
    id: "c9",
    title: "旧版产品册",
    kind: "document",
    description: "下架满 30 天，媒体已删除，记录与进度保留。",
    status: "archived",
    brandScope: "specified",
    brands: ["海信"],
    level: "all",
    tags: ["视频号", "账号", "基础", "展陈规范"],
    coverTone: "slate",
    fileType: "PDF",
    fileSize: "—",
    updatedAt: "2026-09-01",
    uploader: "王敏",
  },
  {
    id: "c10",
    title: "新品演示视频",
    kind: "video",
    description: "转码失败，维护者需要替换文件；学员侧不显示。",
    status: "published",
    brandScope: "specified",
    brands: ["海信"],
    level: "all",
    tags: ["小红书", "短视频", "进阶", "展陈规范"],
    coverTone: "slate",
    duration: "—",
    durationSec: 0,
    vodStatus: "failed",
    updatedAt: "2026-11-09",
    uploader: "王敏",
  },
];

// 每个角色演示账号的进度：positionSec / lastLearnedAt
export const PROGRESS = {
  platform_admin: {
    c1: { positionSec: 512, lastLearnedAt: "2026-11-08 09:40", watchedSec: 512, playCount: 2 },
    c2: { positionSec: 0, lastLearnedAt: "2026-11-07 16:10", watchedSec: 0, playCount: 1 },
  },
  hq_manager: {
    c1: { positionSec: 864, lastLearnedAt: "2026-11-08 08:20", watchedSec: 864, playCount: 1 },
    c4: { positionSec: 240, lastLearnedAt: "2026-11-06 14:05", watchedSec: 240, playCount: 1 },
  },
  branch_manager: {
    c1: { positionSec: 1220, lastLearnedAt: "2026-11-07 18:00", watchedSec: 1220, playCount: 3 },
    c6: { positionSec: 0, lastLearnedAt: "2026-11-05 10:30", watchedSec: 0, playCount: 0 },
  },
  store_staff: {
    c1: { positionSec: 490, lastLearnedAt: "2026-11-09 20:15", watchedSec: 490, playCount: 1 },
    c3: { positionSec: 0, lastLearnedAt: "2026-11-02 09:10", watchedSec: 0, playCount: 0 },
  },
};

// 学习汇总（累计；多品牌合计按人去重）。课程数与当前演示课程集一致：已发布且可播放。
export const SUMMARY = {
  all: { courses: 6, learners: 1842, hours: 2310, plays: 9470, deduped: true, asOf: "2026-11-10 09:00" },
  日立: { courses: 4, learners: 1104, hours: 1390, plays: 5620, deduped: false, asOf: "2026-11-10 09:00" },
  海信: { courses: 3, learners: 612, hours: 740, plays: 3110, deduped: false, asOf: "2026-11-10 09:00" },
  约克VRF: { courses: 2, learners: 207, hours: 180, plays: 740, deduped: false, asOf: "2026-11-10 09:00" },
};

export const TAG_USAGE = {
  产品培训: 12,
  销售话术: 8,
  安装规范: 5,
  安全: 3,
  家装: 6,
  水机: 4,
};

export const COURSE_STATUS = {
  published: { label: "已发布", tone: "green" },
  unpublished: { label: "已下架", tone: "gray" },
  archived: { label: "已归档", tone: "gray" },
};

export const VOD_STATUS = {
  normal: { label: "可播放", tone: "green" },
  transcoding: { label: "转码中", tone: "amber" },
  failed: { label: "转码失败", tone: "red" },
};

export const KIND = {
  video: { label: "视频", icon: "play" },
  document: { label: "资料", icon: "file" },
};

export function brandScopeLabel(course) {
  return course.brandScope === "all" ? "全部品牌" : course.brands.join("、");
}

export function levelLabel(level) {
  return LEVELS[level]?.label ?? level;
}

// 可见性：状态 published × 人员级别 × 品牌范围（design §5.1）
export function canRead(course, role) {
  if (course.status !== "published") return false;
  if (!LEVELS[course.level]?.allowed.includes(role)) return false;
  if (course.brandScope === "all") return true;
  return course.brands.some((b) => ROLE_BRANDS[role].includes(b));
}

// 学员只看可播：视频转码中 / 失败不进入学员列表（design §4.3）
export function isPlayable(course) {
  return course.kind === "document" || course.vodStatus === "normal";
}

export function progressFor(courseId, role) {
  return PROGRESS[role]?.[courseId] ?? null;
}

export const getCourse = (id) => COURSES.find((c) => c.id === id);