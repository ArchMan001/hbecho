// 课程列表与详情（G-2、G-8）。可见范围一律来自 visibility.ts，不在这里另写条件。
// 范围外的直接访问是 403（不是 404、不是空页）；对象不存在才是 404。
import { and, desc, eq, exists, inArray, like, sql, type SQL } from "drizzle-orm";
import { accessUsers, courseBrandScopes, courses, courseTags, learningProgress, tags } from "../../db/schema";
import { isEmptyScope, type AuthContext } from "../access-control";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError } from "./errors";
import { parseId } from "./ids";
import { visibleSql, type AudienceLevel, type CourseVisibilityRef } from "./visibility";

const CAP_READ = "learning.read";
const RESOURCE = "learning_course";

export interface ListQuery {
  q?: string;
  tagId?: bigint;
  inProgress?: boolean;
  limit: number;
  offset: number;
}

/** 解析列表查询串。多个 tag 参数一律拒绝（G-D14 单标签；多标签不静默取第一个）。 */
export function parseListQuery(params: URLSearchParams): ListQuery {
  const tagParams = params.getAll("tag");
  if (tagParams.length > 1) throw new LearningError("input", "multiple_tags", "只支持按单个标签筛选");
  const q = params.get("q")?.trim();
  if (q !== undefined && [...q].length > 100) throw new LearningError("input", "query_too_long", "搜索词最长 100 个字符");
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = params.get(name);
    if (raw === null) return def;
    if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new LearningError("input", "invalid_paging", `${name} 不合法`);
    return Number(raw);
  };
  const ip = params.get("inProgress");
  if (ip !== null && ip !== "1" && ip !== "true" && ip !== "0" && ip !== "false") throw new LearningError("input", "invalid_filter", "inProgress 只能是 1 / true / 0 / false");
  return {
    ...(q ? { q } : {}),
    ...(tagParams[0] !== undefined ? { tagId: parseId(tagParams[0], "tag") } : {}),
    ...(ip === "1" || ip === "true" ? { inProgress: true } : {}),
    limit: num("limit", 20, 1, 100),
    offset: num("offset", 0, 0, 100_000),
  };
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface CourseListItem {
  courseId: string;
  title: string;
  kind: "video" | "document";
  durationSec: number | null;
  coverUrl: string;
  inProgress: boolean;
  lastLearnedAt: string | null;
  tags: Array<{ tagId: string; name: string }>;
  updatedAt: string;
}

export async function listCourses(deps: LearningDeps, ctx: AuthContext, q: ListQuery): Promise<{ items: CourseListItem[]; hasMore: boolean }> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_READ, { key: RESOURCE });
  // 范围为空（例如门店专员的本人绑定失效）：明确 403，而不是返回一页空列表
  if (isEmptyScope(ctx.scope)) throw new LearningError("authorization", "scope_empty", "当前账号没有可见的学习范围");

  const conds: SQL[] = [
    visibleSql(ctx.scope),
    // 学员只看可播：资料课全部，视频课只有转码完成的（design §4.3）
    sql`(${courses.kind} = 'document' OR ${courses.vodVideoStatus} = 'normal')`,
  ];
  if (q.q) conds.push(like(courses.title, `%${escapeLike(q.q)}%`));
  if (q.tagId !== undefined) conds.push(exists(deps.db.select({ one: sql`1` }).from(courseTags).where(and(eq(courseTags.courseId, courses.courseId), eq(courseTags.tagId, q.tagId)))));
  if (q.inProgress) conds.push(sql`${learningProgress.progressId} IS NOT NULL`);

  const rows = await deps.db
    .select({
      courseId: courses.courseId,
      title: courses.title,
      kind: courses.kind,
      durationSec: courses.durationSec,
      coverKey: courses.coverKey,
      updatedAt: courses.updatedAt,
      progressId: learningProgress.progressId,
      lastLearnedAt: learningProgress.lastLearnedAt,
    })
    .from(courses)
    .leftJoin(learningProgress, and(eq(learningProgress.courseId, courses.courseId), eq(learningProgress.userId, userId)))
    .where(and(...conds))
    .orderBy(desc(courses.updatedAt), desc(courses.courseId))
    .limit(q.limit + 1)
    .offset(q.offset);

  const page = rows.slice(0, q.limit);
  const tagRows = page.length
    ? await deps.db
        .select({ courseId: courseTags.courseId, tagId: tags.tagId, name: tags.name })
        .from(courseTags)
        .innerJoin(tags, eq(tags.tagId, courseTags.tagId))
        .where(inArray(courseTags.courseId, page.map((r) => r.courseId)))
        .orderBy(tags.name)
    : [];
  const items: CourseListItem[] = [];
  for (const r of page) {
    items.push({
      courseId: r.courseId.toString(),
      title: r.title,
      kind: r.kind as CourseListItem["kind"],
      durationSec: r.durationSec,
      coverUrl: await deps.store.signedGetUrl(r.coverKey, deps.config.coverUrlTtlSeconds),
      inProgress: r.progressId !== null,
      lastLearnedAt: r.lastLearnedAt?.toISOString() ?? null,
      tags: tagRows.filter((t) => t.courseId === r.courseId).map((t) => ({ tagId: t.tagId.toString(), name: t.name })),
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  return { items, hasMore: rows.length > q.limit };
}

/** 读课程行及其可见性判断所需的品牌集合；不存在返回 null。下载、播放等入口共用。 */
export async function loadCourse(deps: Pick<LearningDeps, "db">, courseId: bigint) {
  const [c] = await deps.db.select().from(courses).where(eq(courses.courseId, courseId)).limit(1);
  if (!c) return null;
  const scopes = await deps.db.select({ brandId: courseBrandScopes.brandId }).from(courseBrandScopes).where(eq(courseBrandScopes.courseId, courseId));
  const ref: CourseVisibilityRef = {
    status: c.status,
    brandScope: c.brandScope as CourseVisibilityRef["brandScope"],
    brandIds: scopes.map((s) => s.brandId),
    audienceLevel: c.audienceLevel as AudienceLevel,
  };
  return { course: c, ref };
}

export interface CourseDetail extends Omit<CourseListItem, "updatedAt"> {
  description: string | null;
  brandScope: "all" | "specified";
  audienceLevel: AudienceLevel;
  vodVideoStatus: string | null;
  fileMime: string | null;
  fileSize: number | null;
  positionSec: number;
  createdByName: string | null;
  updatedAt: string;
}

export async function getCourse(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<CourseDetail> {
  const userId = requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  // 先查动作权限：没有 learning.read 的人不该靠 404 / 403 的差别探到课程是否存在
  await authorizeOrThrow(deps, ctx, CAP_READ);
  const loaded = await loadCourse(deps, courseId);
  if (!loaded) throw new LearningError("not_found", "course_not_found", "课程不存在");
  const { course: c, ref } = loaded;
  await authorizeOrThrow(deps, ctx, CAP_READ, { key: RESOURCE, ref });

  const [[prog], tagRows, [author]] = await Promise.all([
    deps.db.select().from(learningProgress).where(and(eq(learningProgress.courseId, courseId), eq(learningProgress.userId, userId))).limit(1),
    deps.db.select({ tagId: tags.tagId, name: tags.name }).from(courseTags).innerJoin(tags, eq(tags.tagId, courseTags.tagId)).where(eq(courseTags.courseId, courseId)).orderBy(tags.name),
    deps.db.select({ name: accessUsers.displayName }).from(accessUsers).where(eq(accessUsers.userId, c.createdBy)).limit(1),
  ]);
  return {
    courseId: c.courseId.toString(),
    title: c.title,
    kind: c.kind as CourseDetail["kind"],
    description: c.description,
    brandScope: ref.brandScope,
    audienceLevel: ref.audienceLevel,
    durationSec: c.durationSec,
    vodVideoStatus: c.vodVideoStatus,
    fileMime: c.fileMime,
    fileSize: c.fileSize,
    coverUrl: await deps.store.signedGetUrl(c.coverKey, deps.config.coverUrlTtlSeconds),
    inProgress: prog !== undefined,
    lastLearnedAt: prog?.lastLearnedAt.toISOString() ?? null,
    positionSec: prog?.positionSec ?? 0,
    tags: tagRows.map((t) => ({ tagId: t.tagId.toString(), name: t.name })),
    createdByName: author?.name ?? null,
    updatedAt: c.updatedAt.toISOString(),
  };
}
