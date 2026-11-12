// 活动计划 / 账号与监控页面共用的小工具：URL 即状态、分页、北京时间日期、目录名称。
import { cache } from "react";
import { PlanError } from "../../modules/activity-plan";
import { notFound } from "next/navigation";
import { web } from "./session";

export { bjtToday, hrefWith, PAGE_SIZE, pageOf } from "./plan-url";

/** 品牌 / 分公司目录（同一请求内只查一次）。 */
export const directory = cache(() => web().directory());
export async function brandNameByCode(): Promise<Map<string, string>> {
  return new Map((await directory()).brands.map((b) => [b.code, b.name]));
}

/** Module 的「未找到」在页面上表现为 404 页（越范围与不存在不可区分）；其余错误交给 error.tsx。 */
export async function orNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof Error && e.name === "PlanError" && (e as PlanError).category === "not_found") notFound();
    throw e;
  }
}
