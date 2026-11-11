// 播放凭证与资料预览（G-5 / G-6）。每次起播现取，不缓存凭证，也不缓存失败（D14）；响应里没有原始文件地址。
// 授权在调用 VOD / 签名之前：范围外或无权限 403，且不会调用 VOD（D5）。
// 状态要分得清：转码中（202 语义，不是错误）≠ 转码失败（409）≠ 无权限（403）≠ 凭证失败（503，可重试）。
import { and, eq } from "drizzle-orm";
import { learningProgress } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError } from "./errors";
import { parseId } from "./ids";
import { loadCourse } from "./read";

export type Playback =
  | { state: "ready"; kind: "video"; videoId: string; playAuth: string; durationSec: number | null; positionSec: number }
  | { state: "ready"; kind: "document"; url: string; mime: string; expiresAt: string }
  /** 转码中：调用方应回 HTTP 202，不给凭证。 */
  | { state: "processing"; kind: "video"; vodVideoStatus: "uploading" | "transcoding" };

export async function getPlayback(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<Playback> {
  requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, "learning.read"); // 没有动作权限的人探不到课程是否存在
  const loaded = await loadCourse(deps, courseId);
  if (!loaded) throw new LearningError("not_found", "course_not_found", "课程不存在");
  const { course: c, ref } = loaded;
  await authorizeOrThrow(deps, ctx, "learning.read", { key: "learning_course", ref }); // 范围 + 级别 + 已发布；失败 403，不碰 VOD

  if (c.kind === "document") {
    const ttl = deps.config.previewUrlTtlSeconds;
    return { state: "ready", kind: "document", url: await deps.store.signedGetUrl(c.fileKey!, ttl), mime: c.fileMime!, expiresAt: new Date(deps.clock.now().getTime() + ttl * 1000).toISOString() };
  }
  switch (c.vodVideoStatus) {
    case "uploading":
    case "transcoding":
      return { state: "processing", kind: "video", vodVideoStatus: c.vodVideoStatus };
    case "failed":
      throw new LearningError("conflict", "video_failed", "这门课的视频暂不可播放");
    case "normal":
      break;
    default:
      throw new LearningError("conflict", "video_failed", "这门课的视频暂不可播放");
  }
  let auth;
  try {
    auth = await deps.vod.getPlayAuth(c.vodVideoId!);
  } catch {
    throw new LearningError("unavailable", "vod_unavailable", "播放服务暂时不可用，请稍后重试");
  }
  // 续播位置：新文件时长变短时截断到新时长内（PRD §6.2）
  const { positionSec } = await readPosition(deps, ctx.userId!, courseId, c.durationSec);
  return { state: "ready", kind: "video", videoId: c.vodVideoId!, playAuth: auth.playAuth, durationSec: c.durationSec, positionSec };
}

export async function readPosition(deps: Pick<LearningDeps, "db">, userId: bigint, courseId: bigint, durationSec: number | null): Promise<{ positionSec: number }> {
  const [p] = await deps.db.select({ pos: learningProgress.positionSec }).from(learningProgress).where(and(eq(learningProgress.courseId, courseId), eq(learningProgress.userId, userId))).limit(1);
  const pos = p?.pos ?? 0;
  return { positionSec: durationSec === null ? pos : Math.min(pos, durationSec) };
}
