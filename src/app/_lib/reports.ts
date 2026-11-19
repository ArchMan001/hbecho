// 页面进程里的「活动计划判定结果」装配：进程内只建一次，复用访问控制运行时的数据库连接与 D 的运行时（与 _lib/square.ts 同一做法）。
import pino from "pino";
import { getAccessRuntime } from "../../modules/access-control/runtime";
import { assembleReport, type ReportDetail } from "../../modules/report-detail";
import { judgement } from "./judgement";
const KEY = Symbol.for("hbecho.report-detail.web");
export function reports(): ReportDetail {
  const g = globalThis as unknown as Record<symbol, ReportDetail | undefined>;
  return (g[KEY] ??= assembleReport({ db: getAccessRuntime().db, env: process.env, outcomes: judgement().outcomes, logger: pino({ name: "report-detail" }, pino.destination(2)) }));
}
