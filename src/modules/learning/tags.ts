// 标签集合管理（G-3，g-learning-tags-v2）：两级——一级标签（tag_categories）+ 二级标签（tags）。
// 列表所有人可读（筛选要用），增删改只给 `learning.tag.manage`。课程只引用二级标签。
import { asc, eq, sql } from "drizzle-orm";
import { courseTags, tagCategories, tags } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { authorizeOrThrow, requireUser, writeAudit, type LearningDeps, type PendingAudit } from "./deps";
import { LearningError, mysqlErrorCode } from "./errors";
import { parseId } from "./ids";

export interface TagView {
  tagId: string;
  name: string;
  /** 只在 withCounts 时给出（需要 learning.tag.manage）：引用它的课程数，含已下架与归档。 */
  courseCount?: number;
}

export interface TagCategoryView {
  categoryId: string;
  name: string;
  tags: TagView[];
  /** 只在 withCounts 时给出：引用过它下面任一二级标签的课程数（去重）。 */
  courseCount?: number;
}

const CAP_READ = "learning.read";
const CAP_TAG = "learning.tag.manage";

function cleanName(raw: unknown, what: string, code: string): string {
  if (typeof raw !== "string") throw new LearningError("input", code, `${what}名称必须是文本`);
  const name = raw.trim();
  if (name === "" || [...name].length > 32 || /\p{C}/u.test(name)) throw new LearningError("input", code, `${what}名称需为 1–32 个字符，且不含控制字符`);
  return name;
}
const cleanTagName = (raw: unknown): string => cleanName(raw, "二级标签", "tag_name_invalid");
const cleanCategoryName = (raw: unknown): string => cleanName(raw, "一级标签", "category_name_invalid");

/** 一级标签及其二级标签，按创建顺序。空的一级标签也会列出（标签管理要能在里面新建）。 */
export async function listTagTree(deps: LearningDeps, ctx: AuthContext, opts: { withCounts?: boolean } = {}): Promise<TagCategoryView[]> {
  requireUser(ctx);
  await authorizeOrThrow(deps, ctx, opts.withCounts ? CAP_TAG : CAP_READ);
  const [cats, rows] = await Promise.all([
    deps.db.select({ categoryId: tagCategories.categoryId, name: tagCategories.name }).from(tagCategories).orderBy(asc(tagCategories.categoryId)),
    deps.db.select({ tagId: tags.tagId, categoryId: tags.categoryId, name: tags.name }).from(tags).orderBy(asc(tags.tagId)),
  ]);
  let perTag = new Map<bigint, number>();
  let perCategory = new Map<bigint, number>();
  if (opts.withCounts) {
    const t = await deps.db.select({ tagId: courseTags.tagId, n: sql<string>`COUNT(*)` }).from(courseTags).groupBy(courseTags.tagId);
    perTag = new Map(t.map((r) => [r.tagId, Number(r.n)]));
    const c = await deps.db
      .select({ categoryId: tags.categoryId, n: sql<string>`COUNT(DISTINCT ${courseTags.courseId})` })
      .from(courseTags)
      .innerJoin(tags, eq(tags.tagId, courseTags.tagId))
      .groupBy(tags.categoryId);
    perCategory = new Map(c.map((r) => [r.categoryId, Number(r.n)]));
  }
  return cats.map((cat) => ({
    categoryId: cat.categoryId.toString(),
    name: cat.name,
    ...(opts.withCounts ? { courseCount: perCategory.get(cat.categoryId) ?? 0 } : {}),
    // 同一一级标签下按名称排，便于查找；创建顺序对二级标签没有意义
    tags: rows
      .filter((r) => r.categoryId === cat.categoryId)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
      .map((r) => ({ tagId: r.tagId.toString(), name: r.name, ...(opts.withCounts ? { courseCount: perTag.get(r.tagId) ?? 0 } : {}) })),
  }));
}

/* ---------- 一级标签 ---------- */

export async function createTagCategory(deps: LearningDeps, ctx: AuthContext, rawName: unknown): Promise<{ categoryId: string; name: string }> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const name = cleanCategoryName(rawName);
  try {
    const [r] = await deps.db.insert(tagCategories).values({ name, createdAt: deps.clock.now() });
    const categoryId = BigInt(r.insertId);
    await writeAudit(deps, [{ actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_category_created", outcome: "succeeded", reasonCode: "tag_category_created", targetType: "tag_category", targetId: categoryId.toString(), detail: { name } }]);
    return { categoryId: categoryId.toString(), name };
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "category_exists", "已有同名一级标签");
    throw e;
  }
}

export async function renameTagCategory(deps: LearningDeps, ctx: AuthContext, rawId: unknown, rawName: unknown): Promise<{ categoryId: string; name: string }> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const categoryId = parseId(rawId, "categoryId");
  const name = cleanCategoryName(rawName);
  const events: PendingAudit[] = [];
  try {
    await deps.db.transaction(async (tx) => {
      const [cur] = await tx.select({ name: tagCategories.name }).from(tagCategories).where(eq(tagCategories.categoryId, categoryId)).for("update");
      if (!cur) throw new LearningError("not_found", "category_not_found", "一级标签不存在");
      await tx.update(tagCategories).set({ name }).where(eq(tagCategories.categoryId, categoryId));
      events.push({ actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_category_renamed", outcome: "succeeded", reasonCode: "tag_category_renamed", targetType: "tag_category", targetId: categoryId.toString(), detail: { before: cur.name, after: name } });
    });
    await writeAudit(deps, events);
    return { categoryId: categoryId.toString(), name };
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "category_exists", "已有同名一级标签");
    throw e;
  }
}

/** 只能删空的一级标签：下面还有二级标签 409 并给出数量。以外键 RESTRICT 为准（先检查再删会有竞态）。 */
export async function deleteTagCategory(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<void> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const categoryId = parseId(rawId, "categoryId");
  const events: PendingAudit[] = [];
  try {
    await deps.db.transaction(async (tx) => {
      const [cur] = await tx.select({ name: tagCategories.name }).from(tagCategories).where(eq(tagCategories.categoryId, categoryId)).for("update");
      if (!cur) throw new LearningError("not_found", "category_not_found", "一级标签不存在");
      await tx.delete(tagCategories).where(eq(tagCategories.categoryId, categoryId));
      events.push({ actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_category_deleted", outcome: "succeeded", reasonCode: "tag_category_deleted", targetType: "tag_category", targetId: categoryId.toString(), detail: { name: cur.name } });
    });
    await writeAudit(deps, events);
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_ROW_IS_REFERENCED_2") {
      const [r] = await deps.db.select({ n: sql<string>`COUNT(*)` }).from(tags).where(eq(tags.categoryId, categoryId));
      throw new LearningError("conflict", "category_not_empty", "一级标签下还有二级标签，不能删除", { tagCount: Number(r?.n ?? 0) });
    }
    throw e;
  }
}

/* ---------- 二级标签 ---------- */

export async function createTag(deps: LearningDeps, ctx: AuthContext, rawCategoryId: unknown, rawName: unknown): Promise<TagView & { categoryId: string }> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const categoryId = parseId(rawCategoryId, "categoryId");
  const name = cleanTagName(rawName);
  try {
    const [r] = await deps.db.insert(tags).values({ categoryId, name, createdAt: deps.clock.now() });
    const tagId = BigInt(r.insertId);
    await writeAudit(deps, [{ actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_created", outcome: "succeeded", reasonCode: "tag_created", targetType: "tag", targetId: tagId.toString(), detail: { name, categoryId: categoryId.toString() } }]);
    return { tagId: tagId.toString(), categoryId: categoryId.toString(), name };
  } catch (e) {
    const code = mysqlErrorCode(e);
    if (code === "ER_DUP_ENTRY") throw new LearningError("conflict", "tag_exists", "已有同名二级标签");
    if (code === "ER_NO_REFERENCED_ROW_2") throw new LearningError("not_found", "category_not_found", "一级标签不存在");
    throw e;
  }
}

export async function renameTag(deps: LearningDeps, ctx: AuthContext, rawId: unknown, rawName: unknown): Promise<TagView> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const tagId = parseId(rawId, "tagId");
  const name = cleanTagName(rawName);
  const events: PendingAudit[] = [];
  try {
    await deps.db.transaction(async (tx) => {
      const [cur] = await tx.select({ name: tags.name }).from(tags).where(eq(tags.tagId, tagId)).for("update");
      if (!cur) throw new LearningError("not_found", "tag_not_found", "标签不存在");
      await tx.update(tags).set({ name }).where(eq(tags.tagId, tagId));
      events.push({ actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_renamed", outcome: "succeeded", reasonCode: "tag_renamed", targetType: "tag", targetId: tagId.toString(), detail: { before: cur.name, after: name } });
    });
    await writeAudit(deps, events);
    return { tagId: tagId.toString(), name };
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "tag_exists", "已有同名二级标签");
    throw e;
  }
}

/** 被引用的标签不能删：409 并给出引用数。以外键 RESTRICT 为准（先检查再删会有竞态）。 */
export async function deleteTag(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<void> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const tagId = parseId(rawId, "tagId");
  const events: PendingAudit[] = [];
  try {
    await deps.db.transaction(async (tx) => {
      const [cur] = await tx.select({ name: tags.name }).from(tags).where(eq(tags.tagId, tagId)).for("update");
      if (!cur) throw new LearningError("not_found", "tag_not_found", "标签不存在");
      await tx.delete(tags).where(eq(tags.tagId, tagId));
      events.push({ actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_deleted", outcome: "succeeded", reasonCode: "tag_deleted", targetType: "tag", targetId: tagId.toString(), detail: { name: cur.name } });
    });
    await writeAudit(deps, events);
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_ROW_IS_REFERENCED_2") {
      const [r] = await deps.db.select({ n: sql<string>`COUNT(*)` }).from(courseTags).where(eq(courseTags.tagId, tagId));
      throw new LearningError("conflict", "tag_in_use", "标签正被课程使用，不能删除", { referenceCount: Number(r?.n ?? 0) });
    }
    throw e;
  }
}
