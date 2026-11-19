// 筛选解析与小工具（design §5.4）：固定顺序校验，首个失败即抛 invalid_filter；拒绝即错误，不静默放宽成「全部」。
// 纯函数，不依赖数据库。「brandId / branchId 是否在可见集合」由 browse 在拿到可见品牌后再判。
import { SEGMENT_PLATFORMS } from "../../db/schema/signals";
import { SquareError } from "./errors";

export const PAGE_SIZE = 20;
export const MAX_QUERY_CHARS = 100;
/** 点赞恒定下限（SQ-D05）：只展示点赞大于它的作品。 */
export const LIKE_FLOOR = 50n;
export const WITHIN_DAYS = [7, 30, 90, 180] as const;
/** 区间含两端；null = 无上界。 */
export const LIKE_BANDS = {
  "51-100": [51n, 100n],
  "101-300": [101n, 300n],
  "301-500": [301n, 500n],
  "501+": [501n, null],
} as const satisfies Record<string, readonly [bigint, bigint | null]>;
export type LikeBand = keyof typeof LIKE_BANDS;
export type PlatformCode = (typeof SEGMENT_PLATFORMS)[number];
export type SquareKind = "video" | "image" | "all";

export interface SquareFilter {
  brandId?: bigint;
  platformCode?: PlatformCode;
  /** 缺省 video（D5）。 */
  kind: SquareKind;
  branchId?: bigint;
  withinDays?: (typeof WITHIN_DAYS)[number];
  likeBand?: LikeBand;
  /** 搜索词，已 trim；空串不会出现。 */
  q?: string;
  /** 1 起；越界由 browse 夹到最后一页。 */
  page: number;
}

export type RawFilter = Readonly<Record<string, string | readonly string[] | undefined>>;

const invalid = (what: string): never => {
  throw new SquareError("input", "invalid_filter", `筛选条件无效：${what}`);
};
const first = (raw: RawFilter, key: string): string | undefined => {
  const v = raw[key];
  return Array.isArray(v) ? (v as readonly string[])[0] : (v as string | undefined);
};
/** 缺省、空串、"all" 都表示「这一项不筛」。 */
const picked = (raw: RawFilter, key: string): string | undefined => {
  const v = first(raw, key);
  return v === undefined || v === "" || v === "all" ? undefined : v;
};
const MAX_ID = 9_223_372_036_854_775_807n;
const idOf = (v: string, what: string): bigint => {
  if (!/^[1-9][0-9]{0,18}$/.test(v)) return invalid(what);
  const n = BigInt(v);
  return n > MAX_ID ? invalid(what) : n;
};

export function parseSquareFilter(raw: RawFilter): SquareFilter {
  const kindRaw = first(raw, "kind");
  const kind: SquareKind = kindRaw === undefined || kindRaw === "" ? "video" : kindRaw === "video" || kindRaw === "image" || kindRaw === "all" ? kindRaw : invalid("类型");
  const platform = picked(raw, "platform");
  if (platform !== undefined && !(SEGMENT_PLATFORMS as readonly string[]).includes(platform)) invalid("平台");
  const brand = picked(raw, "brand");
  const branch = picked(raw, "branch");
  const within = picked(raw, "within");
  if (within !== undefined && !WITHIN_DAYS.some((d) => String(d) === within)) invalid("发布时间");
  const like = picked(raw, "like");
  if (like !== undefined && !Object.hasOwn(LIKE_BANDS, like)) invalid("点赞数");
  const qRaw = first(raw, "q")?.trim();
  if (qRaw !== undefined && [...qRaw].length > MAX_QUERY_CHARS) throw new SquareError("input", "invalid_filter", `搜索词最长 ${MAX_QUERY_CHARS} 个字，不会被截断`);
  // 活动计划筛选 v1 置灰（requirements R6）：传入就拒绝，不忽略参数
  if (picked(raw, "plan") !== undefined) throw new SquareError("input", "plan_filter_unavailable", "参与活动计划筛选暂未开放");
  const pageRaw = first(raw, "page");
  if (pageRaw !== undefined && pageRaw !== "" && !/^[1-9][0-9]{0,5}$/.test(pageRaw)) invalid("页码");
  return {
    kind,
    page: pageRaw ? Number(pageRaw) : 1,
    ...(platform ? { platformCode: platform as PlatformCode } : {}),
    ...(brand ? { brandId: idOf(brand, "品牌") } : {}),
    ...(branch ? { branchId: idOf(branch, "分公司") } : {}),
    ...(within ? { withinDays: Number(within) as (typeof WITHIN_DAYS)[number] } : {}),
    ...(like ? { likeBand: like as LikeBand } : {}),
    ...(qRaw ? { q: qRaw } : {}),
  };
}

/** `%` `_` `\` 按字面匹配（MySQL LIKE 默认转义符是反斜杠）。 */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 观看链接只放行 http / https；其它协议（javascript:、data: 等）与空值一律 null。 */
export function watchUrlOf(shareUrl: string | null | undefined): string | null {
  if (!shareUrl) return null;
  try {
    const u = new URL(shareUrl.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 视频 = video；图文 = image + text（与 D 域口径一致，R3.4）；unknown 永不展示。 */
export const kindsOf = (k: SquareKind): readonly string[] => (k === "video" ? ["video"] : k === "image" ? ["image", "text"] : ["video", "image", "text"]);
