// 活动计划判定结果（e-metrics-lite）：对外入口。页面与 CLI 只从这里导入。
export * from "./assemble";
export { registerReportAuthz, reportStrategy, type ReportRef } from "./authz";
export { buildColumns, conditionHeaders, defaultName } from "./columns";
export { SKIPPED_TEXT } from "./cells";
export { exportFileName } from "./export";
export { createReportDetail, type ExportPlan, type FilterOptions, type OutcomesPort, type OverviewRow, type ReportDeps, type ReportDetail, type ReportView } from "./read";
export * from "./types";
