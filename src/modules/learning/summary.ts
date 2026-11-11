// 总部汇总（G-11、design §5.3）：四个累计指标，不含任何个人标识，也没有下钻参数。
//   课程数：已发布且学员可播（视频需转码完成）、与查看范围有交集的课程数（G-D27）。
//   学习人数 / 观看时长 / 播放次数：这些课程上的进度，**含已下架与归档课程**，历史只增不减（G-D20）。
//   观看时长与播放次数只算视频；学习人数含资料。转码失败的视频课不计。
// 范围由课程的品牌范围决定（不是学习者的品牌）；多品牌默认合计、按人去重，可切换单品牌（G-D20）。
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { brands, courseBrandScopes, courses, learningProgress } from "../../db/schema";
import { isEmptyScope, type AuthContext } from "../access-control";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError } from "./errors";
import { parseId } from "./ids";

export interface Summary {
  courseCount: number;
  learnerCount: number;
  watchedSeconds: number;
  playCount: number;
  /** 当前口径：merged = 查看范围内合计（已去重）；brand = 单品牌。 */
  mode: "merged" | "brand";
  brandId: string | null;
  /** 可切换的品牌（查看范围内）。 */
  brandOptions: Array<{ brandId: string; name: string }>;
}

/** 课程是否落在品牌集合内：「全部品牌」课程按查看者范围计入一次；指定集合要有交集。 */
function inBrands(brandIds: readonly bigint[] | "all"): SQL {
  if (brandIds === "all") return sql`1 = 1`;
  return sql`(${courses.brandScope} = 'all' OR EXISTS (SELECT 1 FROM ${courseBrandScopes} WHERE ${and(eq(courseBrandScopes.courseId, courses.courseId), inArray(courseBrandScopes.brandId, [...brandIds]))}))`;
}

export async function getSummary(deps: LearningDeps, ctx: AuthContext, input: { brandId?: unknown; range?: unknown } = {}): Promise<Summary> {
  requireUser(ctx);
  await authorizeOrThrow(deps, ctx, "learning.report.read");
  if (input.range !== undefined && input.range !== "all") throw new LearningError("input", "range_unsupported", "1.0 只提供累计总量，暂不支持时间范围");
  if (isEmptyScope(ctx.scope)) throw new LearningError("authorization", "scope_empty", "当前账号没有可汇总的范围");

  try {
    const options = await deps.db
      .select({ id: brands.brandId, name: brands.brandName })
      .from(brands)
      .where(ctx.scope.brands === "all" ? undefined : inArray(brands.brandId, [...ctx.scope.brands]))
      .orderBy(asc(brands.brandId));

    let brandIds: readonly bigint[] | "all" = ctx.scope.brands === "all" ? "all" : [...ctx.scope.brands];
    let brandId: bigint | null = null;
    if (input.brandId !== undefined && input.brandId !== null && input.brandId !== "") {
      brandId = parseId(input.brandId, "brandId");
      if (ctx.scope.brands !== "all" && !ctx.scope.brands.has(brandId)) throw new LearningError("authorization", "brand_out_of_scope", "品牌不在你的汇总范围内");
      if (!options.some((o) => o.id === brandId)) throw new LearningError("input", "brand_not_found", "品牌不存在");
      brandIds = [brandId];
    }
    const scopeCond = inBrands(brandIds);

    const [counts] = await deps.db
      .select({ n: sql<string>`COUNT(*)` })
      .from(courses)
      .where(and(eq(courses.status, "published"), sql`(${courses.kind} = 'document' OR ${courses.vodVideoStatus} = 'normal')`, scopeCond));
    const [agg] = await deps.db
      .select({
        learners: sql<string>`COUNT(DISTINCT ${learningProgress.userId})`,
        watched: sql<string>`COALESCE(SUM(CASE WHEN ${courses.kind} = 'video' THEN ${learningProgress.watchedSec} END), 0)`,
        plays: sql<string>`COALESCE(SUM(CASE WHEN ${courses.kind} = 'video' THEN ${learningProgress.playCount} END), 0)`,
      })
      .from(learningProgress)
      .innerJoin(courses, eq(courses.courseId, learningProgress.courseId))
      .where(and(sql`NOT (${courses.kind} = 'video' AND ${courses.vodVideoStatus} = 'failed')`, scopeCond));
    return {
      courseCount: Number(counts?.n ?? 0),
      learnerCount: Number(agg?.learners ?? 0),
      watchedSeconds: Number(agg?.watched ?? 0),
      playCount: Number(agg?.plays ?? 0),
      mode: brandId === null ? "merged" : "brand",
      brandId: brandId?.toString() ?? null,
      brandOptions: options.map((o) => ({ brandId: o.id.toString(), name: o.name })),
    };
  } catch (e) {
    if (e instanceof LearningError) throw e;
    // 查询失败 / 超时：不返回部分数字
    throw new LearningError("unavailable", "summary_unavailable", "汇总暂时无法生成，请稍后重试");
  }
}
