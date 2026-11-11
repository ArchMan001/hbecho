// 限额与版本常量（design §7、requirements AP-5/AP-6/AP-8/AP-12）。数值是可配置默认值，不是供应商合同。
export const TEMPLATE_VERSION = "roster-import.v1";
/** 模板四列，没有平台列（平台由计划带出）；不做别名兼容。 */
export const ROSTER_HEADER = ["门店编码", "专员姓名", "手机号", "主页链接"] as const;
/** 模板示例行：与它逐格相同的行标为「示例行」，不进入数据、不产生行结果；改了任一格就按数据行处理。 */
export const EXAMPLE_ROW = ["示例门店编码", "示例姓名", "13800138000", "https://www.douyin.com/user/示例主页链接"] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 2_000;
/** 一份预检里「将新建专员」的上限，超过整批拒绝（D-70，可配置）。 */
export const MAX_NEW_STAFF = 1_000;
/** 计划名单账号数的软提示线：超过只提示，不拒绝。 */
export const SOFT_CAP_ACCOUNTS = 1_200;
export const CONFIRM_CHUNK = 200;
export const LEASE_STALE_MS = 2 * 60_000;
export const CONFIRM_TIME_LIMIT_MS = 10 * 60_000;
export const UNREFERENCED_DAYS = 15;
export const TRASH_DAYS = 30;
export const MAX_OWNER_SLOTS = 2;
export const PLAN_NAME_MAX = 200;
export const PLAN_DESCRIPTION_MAX = 2_000;
export const RESOLVE_CONCURRENCY = 2;
/** 北京时间每日维护开始的小时。 */
export const MAINTENANCE_HOUR_BJT = 4;
/** 板块种类（水机 / 家装）。计划选的是种类，不是某分公司下的板块行。 */
export const SECTOR_KEYS = ["water", "home"] as const;
export const SECTOR_LABELS: Record<(typeof SECTOR_KEYS)[number], string> = { water: "水机", home: "家装" };
/** 1.0 只允许这三个平台建计划（D-47）；视频号等被拒绝。 */
export const PLAN_PLATFORMS = ["douyin", "xiaohongshu", "kuaishou"] as const;
