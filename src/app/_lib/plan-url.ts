// 页面共用的纯函数：URL 即状态、分页、北京时间日期（无 Next / 数据库依赖，可直接单测）。
export const PAGE_SIZE = 20;

/** 北京时间今天（YYYY-MM-DD）。 */
export const bjtToday = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** 用 patch 覆盖当前查询参数并生成链接；值为空或 "all" 的参数不进 URL（URL 即状态，可分享可后退）。 */
export function hrefWith(base: string, current: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const next = { ...current, ...patch };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v && v !== "all") sp.set(k, v);
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/** URL 里的页码：只接受正整数，其余（空、小数、负数、非数字）一律按第 1 页。 */
export const pageNumber = (raw: string | undefined): number => {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

export const pageOf = (raw: string | undefined, total: number, size = PAGE_SIZE): { page: number; pages: number; offset: number } => {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, pageNumber(raw));
  return { page, pages, offset: (page - 1) * size };
};

