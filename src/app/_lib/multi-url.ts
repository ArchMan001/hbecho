// 多选筛选的 URL 工具：同名参数重复出现（?brand=1&brand=2），URL 即状态；无 Next / 数据库依赖，可直接单测。
export type Params = Record<string, string | string[] | undefined>;

/** 取一个参数的全部值（单值、重复值、缺省都归一成数组）。 */
export const valuesOf = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter((x) => x !== "");

/** 在列表里加入或去掉一个值。 */
export const toggled = (list: readonly string[], value: string): string[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

/** 用 patch 覆盖当前参数并生成链接；空值、空数组、"all" 不进 URL。 */
export function hrefMulti(base: string, current: Params, patch: Params): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) for (const x of valuesOf(v)) if (x !== "all") sp.append(k, x);
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}
