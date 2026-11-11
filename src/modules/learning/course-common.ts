// 创建与编辑课程共用的校验：品牌范围、标签、上传对象。
import { inArray, or } from "drizzle-orm";
import { z } from "zod";
import { AUDIENCE_LEVELS, brands, courses, tags } from "../../db/schema";
import type { AuthContext } from "../access-control";
import type { LearningDeps } from "./deps";
import { LearningError } from "./errors";
import { extOf, hasMagic, keyExt, keyMatches, MAGIC_BYTES_NEEDED, mimeAllowed, type UploadSlot } from "./files";
import { parseId } from "./ids";

export const maxBytesOf = (deps: Pick<LearningDeps, "config">, slot: UploadSlot): number => (slot === "doc" ? deps.config.docMaxBytes : deps.config.coverMaxBytes);

/** 二选一且必选其一（G-2）：{ all: true } 或非空的 { brandIds }。 */
export const brandScopeInput = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ brandIds: z.array(z.string()).min(1).max(100) }).strict()]);
export const titleInput = z.string().trim().min(1).max(200);
export const descriptionInput = z.string().trim().min(1).max(2000);
export const audienceInput = z.enum(AUDIENCE_LEVELS);
export const tagIdsInput = z.array(z.string()).min(1).max(20);

export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join("、");
    throw new LearningError("input", "invalid_input", `字段不合法：${where}`);
  }
  return parsed.data;
}

export interface ScopeAndTags {
  allBrands: boolean;
  brandIds: bigint[];
  tagIds: bigint[];
}

/** 品牌范围：只能勾选自己授权的品牌，「全部品牌」不受此限（G-D08、G-D42）；品牌与标签必须存在。 */
export async function resolveBrands(deps: LearningDeps, ctx: AuthContext, input: z.infer<typeof brandScopeInput>): Promise<{ allBrands: boolean; brandIds: bigint[] }> {
  const allBrands = "all" in input;
  const brandIds = allBrands ? [] : [...new Set(input.brandIds.map((b) => parseId(b, "brandIds")))];
  if (ctx.scope.brands !== "all") {
    const mine = ctx.scope.brands;
    if (brandIds.some((b) => !mine.has(b))) throw new LearningError("authorization", "brand_out_of_scope", "不能选择未授权的品牌");
  }
  if (brandIds.length) {
    const found = await deps.db.select({ id: brands.brandId }).from(brands).where(inArray(brands.brandId, brandIds));
    if (found.length !== brandIds.length) throw new LearningError("input", "brand_not_found", "所选品牌不存在");
  }
  return { allBrands, brandIds };
}

export async function resolveTags(deps: LearningDeps, raw: string[]): Promise<bigint[]> {
  const tagIds = [...new Set(raw.map((t) => parseId(t, "tagIds")))];
  const found = await deps.db.select({ id: tags.tagId }).from(tags).where(inArray(tags.tagId, tagIds));
  if (found.length !== tagIds.length) throw new LearningError("input", "tag_not_found", "所选标签不存在");
  return tagIds;
}

/** 客户端回传的 key 必须是本服务签发的形态，且没被别的课程占用（否则校验失败时的删除会误伤别人的文件）。 */
export async function assertKeysFree(deps: LearningDeps, uploads: ReadonlyArray<{ slot: UploadSlot; key: string }>): Promise<void> {
  for (const u of uploads) if (!keyMatches(u.slot, u.key)) throw new LearningError("input", "invalid_key", "上传凭据不合法，请重新上传");
  const keys = uploads.map((u) => u.key);
  const used = await deps.db
    .select({ id: courses.courseId })
    .from(courses)
    .where(or(inArray(courses.fileKey, keys), inArray(courses.coverKey, keys)))
    .limit(1);
  if (used.length) throw new LearningError("conflict", "file_already_used", "这个文件已被其他课程使用");
}

/** HEAD + 读文件头魔数。不通过则抛 LearningError；调用方负责删对象。 */
export async function verifyUpload(deps: LearningDeps, slot: UploadSlot, key: string): Promise<{ size: number; mime: string }> {
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

/** 依次校验；失败就删掉失败的那个对象（对象不存在时删除是幂等的），已通过的保留以便客户端只重传失败的一项。 */
export async function verifyAll(deps: LearningDeps, uploads: ReadonlyArray<{ slot: UploadSlot; key: string }>): Promise<Record<UploadSlot, { size: number; mime: string } | undefined>> {
  const out: Record<UploadSlot, { size: number; mime: string } | undefined> = { doc: undefined, cover: undefined };
  for (const u of uploads) {
    try {
      out[u.slot] = await verifyUpload(deps, u.slot, u.key);
    } catch (e) {
      if (e instanceof LearningError) await deps.store.delete(u.key).catch(() => undefined);
      throw e;
    }
  }
  return out;
}
