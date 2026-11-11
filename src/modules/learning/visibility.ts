// 课程可见范围的唯一定义（design §5.1、D21）。列表、搜索、详情、播放、下载、汇总都从这里取条件，不允许各写各的。
// 两种形态必须一致：courseVisible（对象判断，给 ScopeStrategy / 出口守卫用）与 visibleSql（查询条件，给列表用），
// visibility.db.test.ts 用同一组数据逐项对照。
// 品牌集合与人员级别都来自 B 的 DataScope（brands、level）；本模块不重算组织关系，也不读角色名。
import { and, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { courseBrandScopes, courses, type AUDIENCE_LEVELS } from "../../db/schema";
import { constraintOf, isEmptyScope, type DataScope, type ScopeStrategy } from "../access-control";

export type AudienceLevel = (typeof AUDIENCE_LEVELS)[number];

const BY_LEVEL: Record<1 | 2 | 3, readonly AudienceLevel[]> = {
  1: ["all"],
  2: ["all", "branch_and_above"],
  3: ["all", "branch_and_above", "hq_and_above"],
};
/** 人员级别（B-D23）→ 可见的适用级别。映射只在这里定义一处。 */
export const allowedAudience = (level: 1 | 2 | 3): readonly AudienceLevel[] => BY_LEVEL[level];

export interface CourseVisibilityRef {
  status: string;
  brandScope: "all" | "specified";
  brandIds: readonly bigint[];
  audienceLevel: AudienceLevel;
}

export function courseVisible(scope: DataScope, ref: CourseVisibilityRef): boolean {
  if (isEmptyScope(scope)) return false;
  if (ref.status !== "published") return false;
  if (!allowedAudience(scope.level).includes(ref.audienceLevel)) return false;
  if (scope.brands === "all" || ref.brandScope === "all") return true;
  const mine = scope.brands;
  return ref.brandIds.some((b) => mine.has(b));
}

/** 注册为资源 `learning_course` 的 ScopeStrategy（由装配处 registry.registerScopeStrategy 注册）。 */
export const learningCourseStrategy: ScopeStrategy<CourseVisibilityRef> = {
  contains: async (scope, ref) => courseVisible(scope, ref),
  constraint: constraintOf,
};

/** 列表等查询用的条件；范围为空时恒假（调用方应先把「范围为空」表现为 403，而不是空页）。 */
export function visibleSql(scope: DataScope): SQL {
  if (isEmptyScope(scope)) return sql`1 = 0`;
  const brandCond =
    scope.brands === "all"
      ? sql`1 = 1`
      : sql`(${courses.brandScope} = 'all' OR EXISTS (SELECT 1 FROM ${courseBrandScopes} WHERE ${and(eq(courseBrandScopes.courseId, courses.courseId), inArray(courseBrandScopes.brandId, [...scope.brands]))}))`;
  return sql`(${courses.status} = 'published' AND ${inArray(courses.audienceLevel, [...allowedAudience(scope.level)])} AND ${brandCond})`;
}

// ---- 维护范围（G-D42、PRD §4.5）-------------------------------------------------------------------------------
// 维护 ≠ 可见：不看状态与适用级别。hq 只能维护「指定品牌完全落在自己授权品牌内」的课，以及「全部品牌」课；平台级维护全部。
export function canManage(scope: DataScope, ref: Pick<CourseVisibilityRef, "brandScope" | "brandIds">): boolean {
  if (isEmptyScope(scope)) return false;
  if (scope.brands === "all" || ref.brandScope === "all") return true;
  const mine = scope.brands;
  return ref.brandIds.every((b) => mine.has(b));
}

export function manageSql(scope: DataScope): SQL {
  if (isEmptyScope(scope)) return sql`1 = 0`;
  if (scope.brands === "all") return sql`1 = 1`;
  return sql`(${courses.brandScope} = 'all' OR NOT EXISTS (SELECT 1 FROM ${courseBrandScopes} WHERE ${and(eq(courseBrandScopes.courseId, courses.courseId), notInArray(courseBrandScopes.brandId, [...scope.brands]))}))`;
}
