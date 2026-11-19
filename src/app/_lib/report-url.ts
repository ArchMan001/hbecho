// 活动计划判定结果页的 URL 即状态（可分享、可后退）：纯函数，无 Next / 数据库依赖，可直接单测。
// 改任何筛选都回到第 1 页；换大区清掉分公司与门店；换分公司清掉门店；默认值不写进 URL。
import type { ReportFilterInput, Tab } from "../../modules/report-detail";
export const REPORT_KEYS = ["tab", "run", "region", "branch", "sector", "store", "q", "page"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export type ReportQuery = Partial<Record<ReportKey, string>>;
export function reportQueryOf(raw: Record<string, string | string[] | undefined>): ReportQuery {
  const out: ReportQuery = {};
  for (const k of REPORT_KEYS) {
    const v = Array.isArray(raw[k]) ? raw[k]![0] : (raw[k] as string | undefined);
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}
export const tabOf = (q: ReportQuery): Tab => (q.tab === "accounts" ? "accounts" : "videos");
export const pageOf = (q: ReportQuery): number => {
  const n = Number(q.page);
  return Number.isInteger(n) && n >= 1 ? n : 1;
};
export function toFilter(q: ReportQuery): ReportFilterInput {
  return { ...(q.region ? { regionId: q.region } : {}), ...(q.branch ? { branchId: q.branch } : {}), ...(q.sector ? { sectorId: q.sector } : {}), ...(q.store ? { storeId: q.store } : {}), ...(q.q ? { staffQuery: q.q } : {}) };
}
const CASCADE: Partial<Record<ReportKey, ReportKey[]>> = { region: ["branch", "store"], branch: ["store"] };
/** 用 patch 覆盖当前查询生成链接；patch 里值为 undefined / "all" 表示去掉该项。 */
export function reportHref(planId: string, current: ReportQuery, patch: Partial<Record<ReportKey, string | undefined>>, base = "/reports"): string {
  const next: Partial<Record<ReportKey, string | undefined>> = { ...current };
  for (const [k, v] of Object.entries(patch) as Array<[ReportKey, string | undefined]>) {
    next[k] = v;
    for (const c of CASCADE[k] ?? []) if (!(c in patch)) next[c] = undefined;
  }
  // 换执行 / 换标签 / 改筛选都回到第 1 页，除非 patch 自己带了 page
  if (Object.keys(patch).some((k) => k !== "page") && !("page" in patch)) next.page = undefined;
  if ("run" in patch) for (const k of ["region", "branch", "sector", "store", "q"] as const) if (!(k in patch)) next[k] = undefined; // 换执行：组织筛选不带过去
  const sp = new URLSearchParams();
  for (const k of REPORT_KEYS) {
    const v = next[k];
    if (v === undefined || v === "" || v === "all") continue;
    if (k === "tab" && v === "videos") continue;
    if (k === "page" && v === "1") continue;
    sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `${base}/${planId}?${s}` : `${base}/${planId}`;
}
/** 导出链接 / 预览链接：只带「执行」与筛选，不带标签与页码。 */
export function exportHref(planId: string, q: ReportQuery, preview = false): string {
  const sp = new URLSearchParams();
  for (const k of ["run", "region", "branch", "sector", "store", "q"] as const) if (q[k]) sp.set(k, q[k]!);
  if (preview) sp.set("preview", "1");
  const s = sp.toString();
  return `/reports/${planId}/export${s ? `?${s}` : ""}`;
}
/** 与默认条件不同的筛选项个数（手机端「筛选 · N」角标）。页码、标签、执行不算。 */
export const changedFilters = (q: ReportQuery): number => (["region", "branch", "sector", "store", "q"] as const).filter((k) => q[k]).length;
export const parseId = (id: string): string | null => (/^[1-9]\d{0,18}$/.test(id) ? id : null);
