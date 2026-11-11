// 标签集合管理（G-3）：列表所有人可读（筛选要用），增删改只给 `learning.tag.manage`。
import { asc, count, eq, sql } from "drizzle-orm";
import { courseTags, tags } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError, mysqlErrorCode } from "./errors";
import { parseId } from "./ids";

export interface TagView {
  tagId: string;
  name: string;
  /** 只在 withCounts 时给出（需要 learning.tag.manage）：引用它的课程数，含已下架与归档。 */
  courseCount?: number;
}

const CAP_READ = "learning.read";
const CAP_TAG = "learning.tag.manage";

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new LearningError("input", "tag_name_invalid", "标签名必须是文本");
  const name = raw.trim();
  if (name === "" || [...name].length > 32 || /\p{C}/u.test(name)) throw new LearningError("input", "tag_name_invalid", "标签名需为 1–32 个字符，且不含控制字符");
  return name;
}

export async function listTags(deps: LearningDeps, ctx: AuthContext, opts: { withCounts?: boolean } = {}): Promise<TagView[]> {
  requireUser(ctx);
  await authorizeOrThrow(deps, ctx, opts.withCounts ? CAP_TAG : CAP_READ);
  if (!opts.withCounts) {
    const rows = await deps.db.select({ tagId: tags.tagId, name: tags.name }).from(tags).orderBy(asc(tags.name));
    return rows.map((r) => ({ tagId: r.tagId.toString(), name: r.name }));
  }
  const rows = await deps.db
    .select({ tagId: tags.tagId, name: tags.name, n: count(courseTags.courseId) })
    .from(tags)
    .leftJoin(courseTags, eq(courseTags.tagId, tags.tagId))
    .groupBy(tags.tagId, tags.name)
    .orderBy(asc(tags.name));
  return rows.map((r) => ({ tagId: r.tagId.toString(), name: r.name, courseCount: Number(r.n) }));
}

export async function createTag(deps: LearningDeps, ctx: AuthContext, rawName: unknown): Promise<TagView> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const name = cleanName(rawName);
  try {
    return await deps.db.transaction(async (tx) => {
      const [r] = await tx.insert(tags).values({ name, createdAt: deps.clock.now() });
      const tagId = BigInt(r.insertId);
      await deps.audit.write(
        { actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_created", outcome: "succeeded", reasonCode: "tag_created", targetType: "tag", targetId: tagId.toString(), detail: { name } },
        { tx, risk: "high" },
      );
      return { tagId: tagId.toString(), name };
    });
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "tag_exists", "已有同名标签");
    throw e;
  }
}

export async function renameTag(deps: LearningDeps, ctx: AuthContext, rawId: unknown, rawName: unknown): Promise<TagView> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const tagId = parseId(rawId, "tagId");
  const name = cleanName(rawName);
  try {
    return await deps.db.transaction(async (tx) => {
      const [cur] = await tx.select({ name: tags.name }).from(tags).where(eq(tags.tagId, tagId)).for("update");
      if (!cur) throw new LearningError("not_found", "tag_not_found", "标签不存在");
      await tx.update(tags).set({ name }).where(eq(tags.tagId, tagId));
      await deps.audit.write(
        { actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_renamed", outcome: "succeeded", reasonCode: "tag_renamed", targetType: "tag", targetId: tagId.toString(), detail: { before: cur.name, after: name } },
        { tx, risk: "high" },
      );
      return { tagId: tagId.toString(), name };
    });
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "tag_exists", "已有同名标签");
    throw e;
  }
}

/** 被引用的标签不能删：409 并给出引用数。以外键 RESTRICT 为准（先检查再删会有竞态）。 */
export async function deleteTag(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<void> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_TAG);
  const tagId = parseId(rawId, "tagId");
  try {
    await deps.db.transaction(async (tx) => {
      const [cur] = await tx.select({ name: tags.name }).from(tags).where(eq(tags.tagId, tagId)).for("update");
      if (!cur) throw new LearningError("not_found", "tag_not_found", "标签不存在");
      await tx.delete(tags).where(eq(tags.tagId, tagId));
      await deps.audit.write(
        { actor: ctx.actor, actorUserId: userId, eventType: "learning_tag_deleted", outcome: "succeeded", reasonCode: "tag_deleted", targetType: "tag", targetId: tagId.toString(), detail: { name: cur.name } },
        { tx, risk: "high" },
      );
    });
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_ROW_IS_REFERENCED_2") {
      const [r] = await deps.db.select({ n: sql<string>`COUNT(*)` }).from(courseTags).where(eq(courseTags.tagId, tagId));
      throw new LearningError("conflict", "tag_in_use", "标签正被课程使用，不能删除", { referenceCount: Number(r?.n ?? 0) });
    }
    throw e;
  }
}
