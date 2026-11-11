// 课程维护（G-9、PRD §4.4 / §4.5）：管理列表、编辑、替换文件、下架 / 重新上架。
// 授权 = `learning.manage` + 维护范围（canManage）；范围外 403。没有物理删除入口（F4）。
// 并发编辑不处理（G-D24，后写覆盖）；状态流转在事务里锁行，避免下架与归档互相踩。
import { and, desc, eq, inArray, like, type SQL } from "drizzle-orm";
import { z } from "zod";
import { brands, courseBrandScopes, courses, courseTags, tags } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { assertKeysFree, audienceInput, brandScopeInput, descriptionInput, parseOrThrow, resolveBrands, resolveTags, tagIdsInput, titleInput, verifyAll } from "./course-common";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError, mysqlErrorCode } from "./errors";
import { parseId } from "./ids";
import { enqueueDeletion, processDeletions } from "./media-deletions";
import { canManage, manageSql, type AudienceLevel, type CourseVisibilityRef } from "./visibility";

const CAP_MANAGE = "learning.manage";
/** 下架满 30 天归档，之后不可重新上架（G-D37）。 */
export const ARCHIVE_AFTER_MS = 30 * 86_400_000;

type Course = typeof courses.$inferSelect;
type Tx = Parameters<Parameters<LearningDeps["db"]["transaction"]>[0]>[0];

// ---- 管理列表 ---------------------------------------------------------------------------------------------

export interface ManageQuery {
  status?: "published" | "unpublished" | "archived";
  kind?: "video" | "document";
  q?: string;
  limit: number;
  offset: number;
}

export function parseManageQuery(params: URLSearchParams): ManageQuery {
  const pick = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
    const v = params.get(name);
    if (v === null || v === "") return undefined;
    if (!(allowed as readonly string[]).includes(v)) throw new LearningError("input", "invalid_filter", `${name} 不合法`);
    return v as T;
  };
  const q = params.get("q")?.trim();
  if (q !== undefined && [...q].length > 100) throw new LearningError("input", "query_too_long", "搜索词最长 100 个字符");
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = params.get(name);
    if (raw === null) return def;
    if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new LearningError("input", "invalid_paging", `${name} 不合法`);
    return Number(raw);
  };
  const status = pick("status", ["published", "unpublished", "archived"] as const);
  const kind = pick("kind", ["video", "document"] as const);
  return { ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...(q ? { q } : {}), limit: num("limit", 20, 1, 100), offset: num("offset", 0, 0, 100_000) };
}

export interface ManageListItem {
  courseId: string;
  title: string;
  kind: "video" | "document";
  status: "published" | "unpublished" | "archived";
  vodVideoStatus: string | null;
  brandScope: "all" | "specified";
  brandNames: string[];
  audienceLevel: AudienceLevel;
  tags: Array<{ tagId: string; name: string }>;
  updatedAt: string;
}

export async function listManageCourses(deps: LearningDeps, ctx: AuthContext, q: ManageQuery): Promise<{ items: ManageListItem[]; hasMore: boolean }> {
  requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const conds: SQL[] = [manageSql(ctx.scope)];
  if (q.status) conds.push(eq(courses.status, q.status));
  if (q.kind) conds.push(eq(courses.kind, q.kind));
  if (q.q) conds.push(like(courses.title, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  const rows = await deps.db.select().from(courses).where(and(...conds)).orderBy(desc(courses.updatedAt), desc(courses.courseId)).limit(q.limit + 1).offset(q.offset);
  const page = rows.slice(0, q.limit);
  const ids = page.map((r) => r.courseId);
  const [tagRows, brandRows] = ids.length
    ? [
        await deps.db.select({ courseId: courseTags.courseId, tagId: tags.tagId, name: tags.name }).from(courseTags).innerJoin(tags, eq(tags.tagId, courseTags.tagId)).where(inArray(courseTags.courseId, ids)).orderBy(tags.name),
        await deps.db.select({ courseId: courseBrandScopes.courseId, name: brands.brandName }).from(courseBrandScopes).innerJoin(brands, eq(brands.brandId, courseBrandScopes.brandId)).where(inArray(courseBrandScopes.courseId, ids)).orderBy(brands.brandId),
      ]
    : [[], []];
  return {
    hasMore: rows.length > q.limit,
    items: page.map((r) => ({
      courseId: r.courseId.toString(),
      title: r.title,
      kind: r.kind as ManageListItem["kind"],
      status: r.status as ManageListItem["status"],
      vodVideoStatus: r.vodVideoStatus,
      brandScope: r.brandScope as ManageListItem["brandScope"],
      brandNames: brandRows.filter((b) => b.courseId === r.courseId).map((b) => b.name),
      audienceLevel: r.audienceLevel as AudienceLevel,
      tags: tagRows.filter((t) => t.courseId === r.courseId).map((t) => ({ tagId: t.tagId.toString(), name: t.name })),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

// ---- 取一门课（编辑表单用）---------------------------------------------------------------------------------

async function brandIdsOf(db: Pick<LearningDeps["db"], "select">, courseId: bigint): Promise<bigint[]> {
  return (await db.select({ b: courseBrandScopes.brandId }).from(courseBrandScopes).where(eq(courseBrandScopes.courseId, courseId))).map((r) => r.b);
}
const refOf = (c: Course, brandIds: bigint[]): Pick<CourseVisibilityRef, "brandScope" | "brandIds"> => ({ brandScope: c.brandScope as "all" | "specified", brandIds });

/** 读课程并确认在维护范围内；不存在 404，不在范围 403。先查动作权限，探不到存在性。 */
async function loadManageable(deps: LearningDeps, ctx: AuthContext, courseId: bigint, db: Pick<LearningDeps["db"], "select"> = deps.db) {
  const [c] = await db.select().from(courses).where(eq(courses.courseId, courseId)).limit(1);
  if (!c) throw new LearningError("not_found", "course_not_found", "课程不存在");
  const brandIds = await brandIdsOf(db, courseId);
  if (!canManage(ctx.scope, refOf(c, brandIds))) throw new LearningError("authorization", "out_of_scope", "这门课不在你的维护范围内");
  return { course: c, brandIds };
}

export interface ManageCourseView {
  courseId: string;
  title: string;
  description: string | null;
  kind: "video" | "document";
  status: "published" | "unpublished" | "archived";
  vodVideoStatus: string | null;
  brandScope: "all" | "specified";
  brandIds: string[];
  audienceLevel: AudienceLevel;
  tagIds: string[];
  coverUrl: string;
  fileMime: string | null;
  fileSize: number | null;
  durationSec: number | null;
  /** 下架满 30 天的日期（只在已下架时有值），页面提示「X 天后归档」。 */
  archiveAt: string | null;
}

export async function getManageCourse(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<ManageCourseView> {
  requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const { course: c, brandIds } = await loadManageable(deps, ctx, courseId);
  const tagRows = await deps.db.select({ t: courseTags.tagId }).from(courseTags).where(eq(courseTags.courseId, courseId));
  return {
    courseId: c.courseId.toString(),
    title: c.title,
    description: c.description,
    kind: c.kind as ManageCourseView["kind"],
    status: c.status as ManageCourseView["status"],
    vodVideoStatus: c.vodVideoStatus,
    brandScope: c.brandScope as "all" | "specified",
    brandIds: brandIds.map(String),
    audienceLevel: c.audienceLevel as AudienceLevel,
    tagIds: tagRows.map((r) => r.t.toString()),
    coverUrl: await deps.store.signedGetUrl(c.coverKey, deps.config.coverUrlTtlSeconds),
    fileMime: c.fileMime,
    fileSize: c.fileSize,
    durationSec: c.durationSec,
    archiveAt: c.status === "unpublished" && c.unpublishedAt ? new Date(c.unpublishedAt.getTime() + ARCHIVE_AFTER_MS).toISOString() : null,
  };
}

// ---- 事务里的通用部分 -------------------------------------------------------------------------------------

async function lock(deps: LearningDeps, ctx: AuthContext, tx: Tx, courseId: bigint) {
  const [c] = await tx.select().from(courses).where(eq(courses.courseId, courseId)).for("update");
  if (!c) throw new LearningError("not_found", "course_not_found", "课程不存在");
  const brandIds = await brandIdsOf(tx, courseId);
  if (!canManage(ctx.scope, refOf(c, brandIds))) throw new LearningError("authorization", "out_of_scope", "这门课不在你的维护范围内");
  if (c.status === "archived") throw new LearningError("conflict", "course_archived", "课程已归档，不能再修改");
  return { course: c, brandIds };
}

function audit(deps: LearningDeps, ctx: AuthContext, tx: Tx, eventType: string, courseId: bigint, detail: Record<string, unknown>) {
  return deps.audit.write(
    { actor: ctx.actor, actorUserId: ctx.userId, eventType, outcome: "succeeded", reasonCode: eventType.replace(/^learning_/, ""), targetType: "course", targetId: courseId.toString(), detail },
    { tx, risk: "high" },
  );
}

/** 提交后立即尝试一次删除；失败留在队列里按退避重试。 */
const flushDeletions = (deps: LearningDeps) => processDeletions(deps).catch(() => undefined);

// ---- 编辑 -------------------------------------------------------------------------------------------------

const patchInput = z
  .object({
    title: titleInput.optional(),
    description: descriptionInput.optional(),
    audienceLevel: audienceInput.optional(),
    brandScope: brandScopeInput.optional(),
    tagIds: tagIdsInput.optional(),
    coverKey: z.string().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "没有要修改的内容" });
export type UpdateCourseInput = z.input<typeof patchInput>;

/** 修改标题 / 简介 / 适用级别 / 品牌范围 / 标签 / 封面。直接生效并记审计；品牌减少时已不在范围内的学员立即看不到（进度保留）。 */
export async function updateCourse(deps: LearningDeps, ctx: AuthContext, rawId: unknown, raw: unknown): Promise<{ changed: string[] }> {
  requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const patch = parseOrThrow(patchInput, raw);
  await loadManageable(deps, ctx, courseId); // 先确认存在与范围，再做昂贵校验

  const scope = patch.brandScope ? await resolveBrands(deps, ctx, patch.brandScope) : null;
  const tagIds = patch.tagIds ? await resolveTags(deps, patch.tagIds) : null;
  if (patch.coverKey !== undefined) {
    const uploads = [{ slot: "cover" as const, key: patch.coverKey }];
    await assertKeysFree(deps, uploads);
    await verifyAll(deps, uploads);
  }

  let result;
  try {
    result = await deps.db.transaction(async (tx) => {
      const { course: c, brandIds } = await lock(deps, ctx, tx, courseId);
      const changed: string[] = [];
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const set: Partial<typeof courses.$inferInsert> = { updatedAt: deps.clock.now() };
      const note = (k: string, b: unknown, a: unknown) => {
        changed.push(k);
        before[k] = b;
        after[k] = a;
      };
      if (patch.title !== undefined && patch.title !== c.title) {
        set.title = patch.title;
        note("title", c.title, patch.title);
      }
      if (patch.description !== undefined && patch.description !== c.description) {
        set.description = patch.description;
        note("description", c.description, patch.description);
      }
      if (patch.audienceLevel !== undefined && patch.audienceLevel !== c.audienceLevel) {
        set.audienceLevel = patch.audienceLevel;
        note("audienceLevel", c.audienceLevel, patch.audienceLevel);
      }
      if (scope) {
        const same = (scope.allBrands ? "all" : "specified") === c.brandScope && [...scope.brandIds].sort().join() === [...brandIds].sort().join();
        if (!same) {
          set.brandScope = scope.allBrands ? "all" : "specified";
          await tx.delete(courseBrandScopes).where(eq(courseBrandScopes.courseId, courseId));
          if (scope.brandIds.length) await tx.insert(courseBrandScopes).values(scope.brandIds.map((brandId) => ({ courseId, brandId })));
          note("brandScope", { scope: c.brandScope, brandIds: brandIds.map(String) }, { scope: set.brandScope, brandIds: scope.brandIds.map(String) });
        }
      }
      if (tagIds) {
        const cur = (await tx.select({ t: courseTags.tagId }).from(courseTags).where(eq(courseTags.courseId, courseId))).map((r) => r.t.toString()).sort();
        const next = tagIds.map(String).sort();
        if (cur.join() !== next.join()) {
          await tx.delete(courseTags).where(eq(courseTags.courseId, courseId));
          await tx.insert(courseTags).values(tagIds.map((tagId) => ({ courseId, tagId })));
          note("tagIds", cur, next);
        }
      }
      if (patch.coverKey !== undefined && patch.coverKey !== c.coverKey) {
        set.coverKey = patch.coverKey;
        await enqueueDeletion(tx, deps, { kind: "oss_object", id: c.coverKey }, "replaced", courseId);
        note("coverKey", c.coverKey, patch.coverKey);
      }
      if (changed.length === 0) return { changed, title: null as string | null, vodVideoId: null as string | null };
      await tx.update(courses).set(set).where(eq(courses.courseId, courseId));
      await audit(deps, ctx, tx, "learning_course_updated", courseId, { changed, before, after });
      return { changed, title: set.title ?? null, vodVideoId: c.vodVideoId };
    });
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "file_already_used", "这个文件已被其他课程使用");
    if (mysqlErrorCode(e) === "ER_NO_REFERENCED_ROW_2") throw new LearningError("conflict", "reference_changed", "品牌或标签刚刚被改动，请刷新后重试");
    if (patch.coverKey !== undefined) await deps.store.delete(patch.coverKey).catch(() => undefined); // 没换成：新封面不留
    throw e;
  }
  if (result.title && result.vodVideoId) {
    // G-D36：标题同步到 VOD，尽力而为；失败不影响保存，留一条记录
    await deps.vod.updateTitle(result.vodVideoId, result.title).catch(() =>
      deps.audit.write(
        { actor: ctx.actor, actorUserId: ctx.userId, eventType: "learning_vod_title_sync_failed", outcome: "failed", reasonCode: "vod_title_sync_failed", targetType: "course", targetId: courseId.toString() },
        { risk: "low" },
      ),
    );
  }
  if (result.changed.includes("coverKey")) await flushDeletions(deps);
  return { changed: result.changed };
}

// ---- 下架 / 重新上架 --------------------------------------------------------------------------------------

/** 下架是全局的（G-D28）：学员列表立即不出现，已持有的直链下一次请求 403。已下架时是无操作。 */
export async function unpublishCourse(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<{ changed: boolean }> {
  requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  return deps.db.transaction(async (tx) => {
    const { course: c } = await lock(deps, ctx, tx, courseId);
    if (c.status === "unpublished") return { changed: false };
    const now = deps.clock.now();
    await tx.update(courses).set({ status: "unpublished", unpublishedAt: now, updatedAt: now }).where(eq(courses.courseId, courseId));
    await audit(deps, ctx, tx, "learning_course_unpublished", courseId, { title: c.title });
    return { changed: true };
  });
}

/** 下架 30 天内可重新上架，进度继续使用；满 30 天（或已归档）不可上架。 */
export async function republishCourse(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<{ changed: boolean }> {
  requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  return deps.db.transaction(async (tx) => {
    const { course: c } = await lock(deps, ctx, tx, courseId);
    if (c.status === "published") return { changed: false };
    const now = deps.clock.now();
    // 满 30 天但归档任务还没跑到：同样不可上架（媒体马上会被删）
    if (!c.unpublishedAt || now.getTime() - c.unpublishedAt.getTime() >= ARCHIVE_AFTER_MS) throw new LearningError("conflict", "archive_due", "课程下架已满 30 天，不能再上架");
    await tx.update(courses).set({ status: "published", unpublishedAt: null, updatedAt: now }).where(eq(courses.courseId, courseId));
    await audit(deps, ctx, tx, "learning_course_republished", courseId, { title: c.title });
    return { changed: true };
  });
}

// ---- 替换文件 ---------------------------------------------------------------------------------------------

/** 资料换文件：直接覆盖，不保留旧版本；旧对象入删除队列；审计记旧文件标识；进度不动（G-D10）。 */
export async function replaceDocumentFile(deps: LearningDeps, ctx: AuthContext, rawId: unknown, raw: unknown): Promise<void> {
  requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const { fileKey } = parseOrThrow(z.object({ fileKey: z.string() }).strict(), raw);
  const { course: pre } = await loadManageable(deps, ctx, courseId);
  if (pre.kind !== "document") throw new LearningError("conflict", "wrong_kind", "这不是资料课程");
  const uploads = [{ slot: "doc" as const, key: fileKey }];
  await assertKeysFree(deps, uploads);
  const v = (await verifyAll(deps, uploads)).doc!;
  try {
    await deps.db.transaction(async (tx) => {
      const { course: c } = await lock(deps, ctx, tx, courseId);
      if (c.kind !== "document" || !c.fileKey) throw new LearningError("conflict", "wrong_kind", "这不是资料课程");
      await tx.update(courses).set({ fileKey, fileMime: v.mime, fileSize: v.size, updatedAt: deps.clock.now() }).where(eq(courses.courseId, courseId));
      await enqueueDeletion(tx, deps, { kind: "oss_object", id: c.fileKey }, "replaced", courseId);
      await audit(deps, ctx, tx, "learning_course_file_replaced", courseId, { kind: "document", oldFileId: c.fileKey, newFileId: fileKey, fileMime: v.mime, fileSize: v.size });
    });
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "file_already_used", "这个文件已被其他课程使用");
    await deps.store.delete(fileKey).catch(() => undefined);
    throw e;
  }
  await flushDeletions(deps);
}

/** 视频换文件：新视频已直传 VOD；旧视频入删除队列（G-D46）。新视频转码期间学员侧暂不可播。 */
export async function replaceVideoFile(deps: LearningDeps, ctx: AuthContext, rawId: unknown, raw: unknown): Promise<void> {
  requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const { videoId: rawVideoId } = parseOrThrow(z.object({ videoId: z.string().regex(/^[0-9a-fA-F]{32}$/) }).strict(), raw);
  const videoId = rawVideoId.toLowerCase();
  const { course: pre } = await loadManageable(deps, ctx, courseId);
  if (pre.kind !== "video") throw new LearningError("conflict", "wrong_kind", "这不是视频课程");
  const [used] = await deps.db.select({ id: courses.courseId }).from(courses).where(eq(courses.vodVideoId, videoId)).limit(1);
  if (used) throw new LearningError("conflict", "file_already_used", "这个视频已被其他课程使用");
  let info;
  try {
    info = await deps.vod.getVideo(videoId);
  } catch {
    throw new LearningError("unavailable", "vod_unavailable", "视频服务暂时不可用，请稍后重试");
  }
  if (!info) throw new LearningError("input", "video_missing", "没有找到已上传的视频，请重新上传");
  if (info.status === "uploading") throw new LearningError("conflict", "video_uploading", "视频还没有上传完成");
  if ((info.durationSec ?? 0) > deps.config.videoMaxSeconds || (info.sizeBytes ?? 0) > deps.config.videoMaxBytes) {
    await deps.vod.deleteVideo(videoId).catch(() => undefined);
    throw new LearningError("input", "video_too_large", "视频超出时长或大小上限");
  }
  await deps.db.transaction(async (tx) => {
    const { course: c } = await lock(deps, ctx, tx, courseId);
    if (c.kind !== "video" || !c.vodVideoId) throw new LearningError("conflict", "wrong_kind", "这不是视频课程");
    await tx.update(courses).set({ vodVideoId: videoId, vodVideoStatus: info.status, durationSec: info.durationSec, updatedAt: deps.clock.now() }).where(eq(courses.courseId, courseId));
    await enqueueDeletion(tx, deps, { kind: "vod_video", id: c.vodVideoId }, "replaced", courseId);
    await audit(deps, ctx, tx, "learning_course_file_replaced", courseId, { kind: "video", oldFileId: c.vodVideoId, newFileId: videoId, vodVideoStatus: info.status });
  });
  await flushDeletions(deps);
}
