// 资料课程创建（OSS 直传，design §4.2、G-1 / G-2 / G-5）。
// 顺序：取签名地址 → 浏览器直传 → 服务端 HEAD + 读文件头魔数 → 通过才建课程行。
// 服务端不中转字节；校验失败删除对象、不建行（避免「有记录没文件」，也避免留下伪装的文件）。
import { inArray, or } from "drizzle-orm";
import { z } from "zod";
import { AUDIENCE_LEVELS, brands, courseBrandScopes, courses, courseTags, tags } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError, mysqlErrorCode } from "./errors";
import { extOf, hasMagic, keyExt, keyMatches, MAGIC_BYTES_NEEDED, mimeAllowed, newKey, type UploadSlot } from "./files";
import { parseId } from "./ids";

const CAP_MANAGE = "learning.manage";

// ---- 取直传地址 -------------------------------------------------------------------------------------------

export interface UploadTicket {
  key: string;
  uploadUrl: string;
  /** 直传时必须带的 Content-Type（已绑定进签名）。 */
  contentType: string;
  expiresAt: string;
  maxBytes: number;
}

const maxBytesOf = (deps: LearningDeps, slot: UploadSlot): number => (slot === "doc" ? deps.config.docMaxBytes : deps.config.coverMaxBytes);

export async function requestUpload(deps: LearningDeps, ctx: AuthContext, input: { slot: UploadSlot; mime: string; size: number }): Promise<UploadTicket> {
  requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const { slot, mime, size } = input;
  if (slot !== "doc" && slot !== "cover") throw new LearningError("input", "invalid_slot", "slot 只能是 doc 或 cover");
  if (!mimeAllowed(slot, mime)) throw new LearningError("input", "file_type_not_allowed", slot === "doc" ? "资料只支持 PDF、JPG、PNG" : "封面只支持 JPG、PNG");
  const maxBytes = maxBytesOf(deps, slot);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) throw new LearningError("input", "file_too_large", `文件大小需在 1 字节到 ${maxBytes} 字节之间`);
  const key = newKey(slot, mime);
  const ttl = deps.config.uploadUrlTtlSeconds;
  const uploadUrl = await deps.store.signedPutUrl(key, mime, ttl);
  return { key, uploadUrl, contentType: mime, expiresAt: new Date(deps.clock.now().getTime() + ttl * 1000).toISOString(), maxBytes };
}

// ---- 创建 -------------------------------------------------------------------------------------------------

const createInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    audienceLevel: z.enum(AUDIENCE_LEVELS).default("all"),
    // 二选一且必选其一（G-2）：{ all: true } 或非空的 { brandIds }
    brandScope: z.union([z.object({ all: z.literal(true) }).strict(), z.object({ brandIds: z.array(z.string()).min(1).max(100) }).strict()]),
    tagIds: z.array(z.string()).min(1).max(20),
    fileKey: z.string(),
    coverKey: z.string().optional(),
  })
  .strict();
export type CreateDocumentCourseInput = z.input<typeof createInput>;

async function verifyUpload(deps: LearningDeps, slot: UploadSlot, key: string): Promise<{ size: number; mime: string }> {
  const head = await deps.store.head(key);
  if (!head) throw new LearningError("input", "upload_missing", "没有找到已上传的文件，请重新上传");
  const mime = head.contentType.split(";")[0]!.trim().toLowerCase();
  if (!mimeAllowed(slot, mime)) throw new LearningError("input", "file_type_not_allowed", slot === "doc" ? "资料只支持 PDF、JPG、PNG" : "封面只支持 JPG、PNG");
  if (extOf(mime) !== keyExt(key)) throw new LearningError("input", "file_type_mismatch", "文件类型与上传时声明的不一致");
  if (head.size <= 0 || head.size > maxBytesOf(deps, slot)) throw new LearningError("input", "file_too_large", "文件超出大小上限");
  const first = await deps.store.getRange(key, 0, MAGIC_BYTES_NEEDED - 1);
  if (!first || !hasMagic(mime, first)) throw new LearningError("input", "file_content_mismatch", "文件内容与扩展名不符");
  return { size: head.size, mime };
}

export async function createDocumentCourse(deps: LearningDeps, ctx: AuthContext, raw: unknown): Promise<{ courseId: string }> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);

  const parsed = createInput.safeParse(raw);
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join("、");
    throw new LearningError("input", "invalid_input", `字段不合法：${where}`);
  }
  const input = parsed.data;
  const allBrands = "all" in input.brandScope;
  const brandIds = allBrands ? [] : [...new Set((input.brandScope as { brandIds: string[] }).brandIds.map((b) => parseId(b, "brandIds")))];
  const tagIds = [...new Set(input.tagIds.map((t) => parseId(t, "tagIds")))];

  // 只能勾选自己授权的品牌；「全部品牌」不受此限（G-D08）
  if (ctx.scope.brands !== "all") {
    const mine = ctx.scope.brands;
    if (brandIds.some((b) => !mine.has(b))) throw new LearningError("authorization", "brand_out_of_scope", "不能选择未授权的品牌");
  }
  if (brandIds.length) {
    const found = await deps.db.select({ id: brands.brandId }).from(brands).where(inArray(brands.brandId, brandIds));
    if (found.length !== brandIds.length) throw new LearningError("input", "brand_not_found", "所选品牌不存在");
  }
  const foundTags = await deps.db.select({ id: tags.tagId }).from(tags).where(inArray(tags.tagId, tagIds));
  if (foundTags.length !== tagIds.length) throw new LearningError("input", "tag_not_found", "所选标签不存在");

  // 客户端回传的 key 必须是本服务签发的形态，且没被别的课程占用（否则校验失败时的删除会误伤别人的文件）
  const uploads: Array<{ slot: UploadSlot; key: string }> = [{ slot: "doc", key: input.fileKey }];
  if (input.coverKey !== undefined) uploads.push({ slot: "cover", key: input.coverKey });
  for (const u of uploads) if (!keyMatches(u.slot, u.key)) throw new LearningError("input", "invalid_key", "上传凭据不合法，请重新上传");
  const keys = uploads.map((u) => u.key);
  const used = await deps.db
    .select({ id: courses.courseId })
    .from(courses)
    .where(or(inArray(courses.fileKey, keys), inArray(courses.coverKey, keys)))
    .limit(1);
  if (used.length) throw new LearningError("conflict", "file_already_used", "这个文件已被其他课程使用");

  const verified: Record<string, { size: number; mime: string }> = {};
  for (const u of uploads) {
    try {
      verified[u.slot] = await verifyUpload(deps, u.slot, u.key);
    } catch (e) {
      // 校验不通过：删掉这个对象（对象不存在的情况下删除是幂等的）。删除失败不掩盖原因
      if (e instanceof LearningError) await deps.store.delete(u.key).catch(() => undefined);
      throw e;
    }
  }
  const doc = verified.doc!;

  try {
    return await deps.db.transaction(async (tx) => {
      const now = deps.clock.now();
      const [r] = await tx.insert(courses).values({
        title: input.title,
        kind: "document",
        description: input.description,
        status: "published",
        brandScope: allBrands ? "all" : "specified",
        audienceLevel: input.audienceLevel,
        coverKey: input.coverKey ?? null,
        fileKey: input.fileKey,
        fileMime: doc.mime,
        fileSize: doc.size,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const courseId = BigInt(r.insertId);
      if (brandIds.length) await tx.insert(courseBrandScopes).values(brandIds.map((brandId) => ({ courseId, brandId })));
      await tx.insert(courseTags).values(tagIds.map((tagId) => ({ courseId, tagId })));
      await deps.audit.write(
        {
          actor: ctx.actor,
          actorUserId: userId,
          eventType: "learning_course_created",
          outcome: "succeeded",
          reasonCode: "course_created",
          targetType: "course",
          targetId: courseId.toString(),
          detail: {
            title: input.title,
            kind: "document",
            brandScope: allBrands ? "all" : "specified",
            brandIds: brandIds.map(String),
            audienceLevel: input.audienceLevel,
            tagIds: tagIds.map(String),
            fileKey: input.fileKey,
            fileMime: doc.mime,
            fileSize: doc.size,
            coverKey: input.coverKey ?? null,
          },
        },
        { tx, risk: "high" },
      );
      return { courseId: courseId.toString() };
    });
  } catch (e) {
    const code = mysqlErrorCode(e);
    // 唯一键冲突说明对象已被并发的另一次创建占用，不能删；其余失败（含审计写入失败）没建行，对象删掉免得残留
    if (code === "ER_DUP_ENTRY") throw new LearningError("conflict", "file_already_used", "这个文件已被其他课程使用");
    for (const u of uploads) await deps.store.delete(u.key).catch(() => undefined);
    if (code === "ER_NO_REFERENCED_ROW_2") throw new LearningError("conflict", "reference_changed", "品牌或标签刚刚被改动，请刷新后重试");
    throw e;
  }
}
