// 视频广场的 URL 即状态（可分享、可后退）：纯函数，无 Next / 数据库依赖，可直接单测。
// 与 plan-url 的 hrefWith 不同：类型默认是「视频」，「全部类型」(kind=all) 必须留在 URL 里，不能被当成「全部 = 不写」。
export const SQUARE_KEYS = ["brand", "platform", "kind", "branch", "within", "like", "q", "page"] as const;
export type SquareQuery = Partial<Record<(typeof SQUARE_KEYS)[number], string>>;

export const WITHIN_OPTIONS: Array<[string, string]> = [["all", "全部时间"], ["7", "7天内"], ["30", "30天内"], ["90", "90天内"], ["180", "180天内"]];
export const LIKE_OPTIONS: Array<[string, string]> = [["all", "全部（>50）"], ["51-100", "51-100"], ["101-300", "101-300"], ["301-500", "301-500"], ["501+", "500以上"]];
export const KIND_OPTIONS: Array<[string, string]> = [["all", "全部类型"], ["video", "视频"], ["image", "图文"]];

/** 取出当前查询里认识的键（其余参数一律丢掉，不往下一个链接里带）。 */
export function squareQueryOf(raw: Record<string, string | string[] | undefined>): SquareQuery {
  const out: SquareQuery = {};
  for (const k of SQUARE_KEYS) {
    const v = Array.isArray(raw[k]) ? raw[k]![0] : (raw[k] as string | undefined);
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/** 用 patch 覆盖当前查询生成链接；patch 里值为 undefined 表示去掉该项。改任何筛选都回到第 1 页，除非 patch 自己带了 page。 */
export function squareHref(current: SquareQuery, patch: Partial<Record<(typeof SQUARE_KEYS)[number], string | undefined>>): string {
  const next: Record<string, string | undefined> = { ...current, ...(Object.keys(patch).some((k) => k !== "page") ? { page: undefined } : {}), ...patch };
  const sp = new URLSearchParams();
  for (const k of SQUARE_KEYS) {
    const v = next[k];
    if (v === undefined || v === "") continue;
    if (k === "kind" ? v === "video" : v === "all") continue; // 默认值不写进 URL
    if (k === "page" && v === "1") continue;
    sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `/square?${s}` : "/square";
}

/** 与默认条件不同的筛选项个数（手机端「筛选 · N」角标）。页码不算。 */
export function changedCount(q: SquareQuery): number {
  const nonAll = (v: string | undefined) => (v !== undefined && v !== "all" ? 1 : 0);
  return nonAll(q.brand) + nonAll(q.platform) + nonAll(q.branch) + nonAll(q.within) + nonAll(q.like) + (q.kind !== undefined && q.kind !== "video" ? 1 : 0) + (q.q ? 1 : 0);
}

/** 点赞与评论的紧凑显示：≥1 万用「x.x万」。 */
export const fmtCount = (v: string): string => {
  const n = Number(v);
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : n.toLocaleString("en-US");
};

/** 品牌标签色：按名称包含关系匹配四个品牌，其余用中性色。 */
export const brandTone = (name: string): string => (name.includes("日立") ? "hitachi" : name.includes("海信") ? "hisense" : name.includes("约克") ? "york" : name.includes("科龙") ? "kelon" : "plain");

/** 「N 天前」（按北京时间自然日差；发布时间缺失显示 —）。 */
export function daysAgo(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const bjt = (ms: number) => Math.floor((ms + 8 * 3_600_000) / 86_400_000);
  const d = bjt(nowMs) - bjt(new Date(iso).getTime());
  return d <= 0 ? "今天" : `${d} 天前`;
}
