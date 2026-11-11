// 课程创建（G-1 / G-2 / G-4 / G-5）。
//   资料：取签名地址 → 浏览器直传 OSS → 服务端 HEAD + 读文件头魔数 → 通过才建课程行（design §4.2）。
//   视频：取 VOD 上传凭证 → 浏览器直传 VOD → 通知「上传完成」→ 服务端查视频状态 → 建课程行（design §4.1）。
// 服务端不中转字节；校验失败删对象、不建行（避免「有记录没文件」，也避免留下伪装的文件）。封面所有课程必填（G-D48）。
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { courseBrandScopes, courses, courseTags } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { assertKeysFree, audienceInput, brandScopeInput, descriptionInput, maxBytesOf, parseOrThrow, resolveBrands, resolveTags, tagIdsInput, titleInput, verifyAll } from "./course-common";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError, mysqlErrorCode } from "./errors";
import { mimeAllowed, newKey, type UploadSlot } from "./files";
import type { VodUploadTicket } from "./vod";

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

/** 取 VOD 上传凭证：强制 MP4、超限在上传前拒绝（G-D33、G-D44）；模板组由 VodClient 固定传入。 */
export async function requestVideoUpload(deps: LearningDeps, ctx: AuthContext, input: { title: string; fileName: string; size: number }): Promise<VodUploadTicket & { maxBytes: number }> {
  requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const title = parseOrThrow(titleInput, input.title);
  if (typeof input.fileName !== "string" || !/\.mp4$/i.test(input.fileName) || input.fileName.length > 200) throw new LearningError("input", "file_type_not_allowed", "视频只支持 MP4 格式（H.264 / AAC）");
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > deps.config.videoMaxBytes) throw new LearningError("input", "file_too_large", "视频大小超出上限");
  try {
    return { ...(await deps.vod.createUpload({ title, fileName: input.fileName, fileSize: input.size })), maxBytes: deps.config.videoMaxBytes };
  } catch {
    // 凭证失败：不建课程行，可重试
    throw new LearningError("unavailable", "vod_unavailable", "视频服务暂时不可用，请稍后重试");
  }
}

// ---- 创建 -------------------------------------------------------------------------------------------------

const commonFields = {
  title: titleInput,
  description: descriptionInput,
  audienceLevel: audienceInput.default("all"),
  brandScope: brandScopeInput,
  tagIds: tagIdsInput,
  coverKey: z.string(),
};
const documentInput = z.object({ ...commonFields, fileKey: z.string() }).strict();
const videoInput = z.object({ ...commonFields, videoId: z.string().regex(/^[0-9a-fA-F]{32}$/) }).strict();
export type CreateDocumentCourseInput = z.input<typeof documentInput>;
export type CreateVideoCourseInput = z.input<typeof videoInput>;

type Common = { title: string; description: string; audienceLevel: string; coverKey: string };

async function insertCourse(
  deps: LearningDeps,
  ctx: AuthContext,
  userId: bigint,
  c: Common,
  scope: { allBrands: boolean; brandIds: bigint[]; tagIds: bigint[] },
  row: Partial<typeof courses.$inferInsert> & Pick<typeof courses.$inferInsert, "kind">,
  audit: Record<string, unknown>,
): Promise<string> {
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const [r] = await tx.insert(courses).values({
      title: c.title,
      description: c.description,
      status: "published",
      brandScope: scope.allBrands ? "all" : "specified",
      audienceLevel: c.audienceLevel,
      coverKey: c.coverKey,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      ...row,
    });
    const courseId = BigInt(r.insertId);
    if (scope.brandIds.length) await tx.insert(courseBrandScopes).values(scope.brandIds.map((brandId) => ({ courseId, brandId })));
    await tx.insert(courseTags).values(scope.tagIds.map((tagId) => ({ courseId, tagId })));
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
          title: c.title,
          kind: row.kind,
          brandScope: scope.allBrands ? "all" : "specified",
          brandIds: scope.brandIds.map(String),
          audienceLevel: c.audienceLevel,
          tagIds: scope.tagIds.map(String),
          coverKey: c.coverKey,
          ...audit,
        },
      },
      { tx, risk: "high" },
    );
    return courseId.toString();
  });
}

export async function createDocumentCourse(deps: LearningDeps, ctx: AuthContext, raw: unknown): Promise<{ courseId: string }> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  const input = parseOrThrow(documentInput, raw);
  const { allBrands, brandIds } = await resolveBrands(deps, ctx, input.brandScope);
  const tagIds = await resolveTags(deps, input.tagIds);

  const uploads = [
    { slot: "doc" as const, key: input.fileKey },
    { slot: "cover" as const, key: input.coverKey },
  ];
  await assertKeysFree(deps, uploads);
  const verified = await verifyAll(deps, uploads);
  const doc = verified.doc!;

  try {
    const courseId = await insertCourse(deps, ctx, userId, input, { allBrands, brandIds, tagIds }, { kind: "document", fileKey: input.fileKey, fileMime: doc.mime, fileSize: doc.size }, { fileKey: input.fileKey, fileMime: doc.mime, fileSize: doc.size });
    return { courseId };
  } catch (e) {
    // 唯一键冲突说明对象已被并发的另一次创建占用，不能删；其余失败（含审计写入失败）没建行，对象删掉免得残留
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") throw new LearningError("conflict", "file_already_used", "这个文件已被其他课程使用");
    for (const u of uploads) await deps.store.delete(u.key).catch(() => undefined);
    if (mysqlErrorCode(e) === "ER_NO_REFERENCED_ROW_2") throw new LearningError("conflict", "reference_changed", "品牌或标签刚刚被改动，请刷新后重试");
    throw e;
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * 视频课程：浏览器已把视频直传 VOD，这里查视频状态后建行。同一 (用户, Idempotency-Key) 只建一门课，重复提交返回第一次的结果（D7）。
 * 转码中 → 建行（vod_video_status=transcoding）；转码失败 → 建行并标 failed，维护者可替换；上传未完成 → 409，不建行。
 */
export async function createVideoCourse(deps: LearningDeps, ctx: AuthContext, raw: unknown, idempotencyKey: string): Promise<{ courseId: string; replayed: boolean }> {
  const userId = requireUser(ctx);
  await authorizeOrThrow(deps, ctx, CAP_MANAGE);
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new LearningError("input", "idempotency_key_required", "缺少或不合法的 Idempotency-Key");
  const input = parseOrThrow(videoInput, raw);
  const videoId = input.videoId.toLowerCase();

  const replay = async (): Promise<{ courseId: string; replayed: true } | null> => {
    const [prev] = await deps.db.select({ id: courses.courseId }).from(courses).where(and(eq(courses.createdBy, userId), eq(courses.createKey, idempotencyKey))).limit(1);
    return prev ? { courseId: prev.id.toString(), replayed: true } : null;
  };
  const again = await replay();
  if (again) return again;

  const { allBrands, brandIds } = await resolveBrands(deps, ctx, input.brandScope);
  const tagIds = await resolveTags(deps, input.tagIds);
  const uploads = [{ slot: "cover" as const, key: input.coverKey }];
  await assertKeysFree(deps, uploads);
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
    await deps.vod.deleteVideo(videoId).catch(() => undefined); // 超限的视频不留；删不掉由残渣清理兜底
    throw new LearningError("input", "video_too_large", "视频超出时长或大小上限");
  }
  await verifyAll(deps, uploads);

  try {
    const courseId = await insertCourse(
      deps,
      ctx,
      userId,
      input,
      { allBrands, brandIds, tagIds },
      { kind: "video", vodVideoId: videoId, vodVideoStatus: info.status, durationSec: info.durationSec, createKey: idempotencyKey },
      { vodVideoId: videoId, vodVideoStatus: info.status },
    );
    return { courseId, replayed: false };
  } catch (e) {
    if (mysqlErrorCode(e) === "ER_DUP_ENTRY") {
      // 并发的同键请求先到：返回它的结果；否则是视频 / 封面被占用
      const prev = await replay();
      if (prev) return prev;
      throw new LearningError("conflict", "file_already_used", "这个文件已被其他课程使用");
    }
    await deps.store.delete(input.coverKey).catch(() => undefined);
    if (mysqlErrorCode(e) === "ER_NO_REFERENCED_ROW_2") throw new LearningError("conflict", "reference_changed", "品牌或标签刚刚被改动，请刷新后重试");
    throw e;
  }
}
