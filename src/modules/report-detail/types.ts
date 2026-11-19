// 活动计划判定结果（e-metrics-lite）：共用类型。页面、导出、CLI 都只依赖这里与 index.ts。
import type { ConditionDesc } from "../judgement/config";
export type ReportErrorKind = "auth" | "not_found" | "input" | "conflict" | "unavailable";
export class ReportError extends Error {
  constructor(
    readonly kind: ReportErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReportError";
  }
}
/** 按名称与字段判断，不用 instanceof：Next 把同一个模块打包进多个入口时类会有多份，instanceof 会误判成未知错误。 */
export const isReportError = (e: unknown): e is ReportError => e instanceof ReportError || (e instanceof Error && e.name === "ReportError" && typeof (e as { kind?: unknown }).kind === "string" && typeof (e as { code?: unknown }).code === "string");
export const PAGE_SIZE = 50;
/** 导出行数上限：起始值，不是冻结值（e-metrics-lite EL-8；T5 / M3 实测后定稿）。 */
export const DEFAULT_EXPORT_LIMITS = { videoRows: 50_000, accountRows: 5_000 } as const;
export const MAX_CONCURRENT_EXPORTS = 2;
/** 筛选：十进制字符串 ID；staffQuery 解析为专员 ID 集合。 */
export interface ReportFilterInput {
  regionId?: string;
  branchId?: string;
  sectorId?: string;
  storeId?: string;
  staffQuery?: string;
}
export type Tab = "videos" | "accounts";
export interface ColumnDef {
  key: string;
  header: string;
  kind: "fixed" | "condition" | "result";
  conditionKey?: string;
}
export type Tone = "pass" | "fail" | "unobtained" | "skipped" | "plain";
export interface Cell {
  text: string;
  tone: Tone;
  /** 仅 http(s)；其余一律不输出 */
  link?: string;
  /** 数字单元格（导出写成数字）；超过 2^53 的值不放这里，只放 text */
  num?: number;
}
export interface Images {
  cover?: string;
  avatar?: string;
  background?: string;
}
export interface ViewRow {
  cells: Record<string, Cell>;
  /** 签名链接；缺失省略（页面显示占位）。导出不用。 */
  images: Images;
}
export interface ReportHeader {
  planId: string;
  activityPlanName: string;
  planAlias: string;
  platformCode: string;
  platformName: string;
  version: number;
  executionId: string;
  completedAt: string; // ISO UTC
  cutoffAt: string; // ISO UTC
  window: { fromBjt: string; toBjt: string };
  /** false = 内容级行已被保留期清理，视频明细没有行 */
  videosAvailable: boolean;
  /** false = 执行早于 JP-22，账号能力列为空 */
  abilityResultsAvailable: boolean;
}
export interface ExecutionOption {
  executionId: string;
  completedAt: string;
  version: number;
  isLatest: boolean;
}
export interface TableView {
  columns: ColumnDef[];
  rows: ViewRow[];
  total: number;
  page: number;
  pageCount: number;
  /** 读不到快照数据的行数（内容快照 / 主页快照缺失），用于顶部提示；值状态为空（缺失、null）不算 */
  missingRows: number;
}
export type { ConditionDesc };
