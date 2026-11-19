// 列头规则（requirements EL-3 / EL-4 / EL-5；纯函数）。表头以刘学奎 2026-11-19 给定为准，逐字。
import type { ConditionDesc } from "../judgement/config";
import type { ColumnDef } from "./types";

/** [key, 表头]；「昵称」列头随平台：`<平台>昵称`（抖音 → 抖音昵称）。 */
const NICK = "nickname";
type Fixed = ReadonlyArray<readonly [string, string | ((platformName: string) => string)]>;
const ORG: Fixed = [
  ["brand", "品牌"], ["region", "大区"], ["branch", "分公司"], ["sector", "板块"], ["dealer", "经销商名称"],
  ["store", "门店名称"], ["storeCode", "门店编码"], ["staff", "专员姓名"], ["platform", "平台"],
  [NICK, (p) => `${p}昵称`], ["homeUrl", "主页链接"],
];
const VIDEO: Fixed = [
  ...ORG,
  ["kind", "类型(视频/图文)"], ["title", "视频/图文标题"], ["publishedAt", "发布时间"], ["url", "视频/图文链接"], ["contentId", "视频/图文唯一ID"],
  ["like", "点赞"], ["comment", "评论"], ["share", "分享"], ["collect", "收藏"], ["snapshotAt", "采集时间"],
];
const ACCOUNT: Fixed = [
  ...ORG,
  ["followers", "粉丝数"], ["likesTotal", "总获赞"], ["posts", "平台作品数"], ["collected", "已采集视频数"],
  ["profileOk", "主页是否采集成功"], ["profileAt", "主页采集时间"], ["listOk", "视频列表是否采集成功"], ["listAt", "视频列表采集时间"],
];
export const RESULT_HEADER = "判定结果";
const resolve = (f: Fixed, platformName: string): ColumnDef[] => f.map(([key, h]) => ({ key, header: typeof h === "function" ? h(platformName) : h, kind: "fixed" as const }));
export const videoFixedColumns = (platformName: string): ColumnDef[] => resolve(VIDEO, platformName);
export const accountFixedColumns = (platformName: string): ColumnDef[] => resolve(ACCOUNT, platformName);

const TARGET: Record<string, string> = { cover: "封面", avatar: "头像", background: "主页背景" };
/** 无别名时的默认名（EL-4）。 */
export function defaultName(c: ConditionDesc): string {
  switch (c.kind) {
    case "text": return "文本关键词";
    case "hashtags": return "话题";
    case "duration": return "时长";
    case "whole_image": return `整图对比·${TARGET[c.target ?? ""] ?? ""}`;
    case "image_element": return `元素对比·${TARGET[c.target ?? ""] ?? ""}`;
    case "asr": return "语音判定";
    case "comment": return "评论要求";
  }
}
/**
 * 条件列头：别名 → 默认名；重名的**每一列**加 ` #序号`（按配置顺序从 1 起）；名字与固定列表头（两张表的并集 + 判定结果）相同再加「（能力）」。
 * **在条件全集上一次算好**：账号维度含头像 / 主页背景，视频明细不含；若各自在子集上去重，同一个条件在两张表里会得到不同序号。
 */
export function conditionHeaders(conditions: readonly ConditionDesc[], platformName: string): Map<string, string> {
  const reserved = new Set<string>([...videoFixedColumns(platformName), ...accountFixedColumns(platformName)].map((c) => c.header).concat(RESULT_HEADER));
  const base = conditions.map((c) => c.alias ?? defaultName(c));
  const total = new Map<string, number>();
  for (const n of base) total.set(n, (total.get(n) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  conditions.forEach((c, i) => {
    let n = base[i]!;
    if ((total.get(n) ?? 0) > 1) {
      const k = (seen.get(n) ?? 0) + 1;
      seen.set(n, k);
      n = `${n} #${k}`;
    }
    if (reserved.has(n)) n = `${n}（能力）`;
    out.set(c.key, n);
  });
  return out;
}
export function buildColumns(kind: "videos" | "accounts", conditions: readonly ConditionDesc[], platformName: string): ColumnDef[] {
  const heads = conditionHeaders(conditions, platformName);
  const conds = conditions.filter((c) => kind === "accounts" || c.subject === "content");
  const cols: ColumnDef[] = [
    ...(kind === "videos" ? videoFixedColumns(platformName) : accountFixedColumns(platformName)),
    ...conds.map((c) => ({ key: c.key, header: heads.get(c.key)!, kind: "condition" as const, conditionKey: c.key })),
  ];
  if (kind === "accounts") cols.push({ key: "result", header: RESULT_HEADER, kind: "result" });
  return cols;
}
