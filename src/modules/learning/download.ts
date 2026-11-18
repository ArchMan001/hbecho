// 资料原件下载（G-10）：走 B 的出口 10（`learning_download`）——动作权限 + 课程范围 + 仅用户身份，并写审计
// （操作者、课程 ID、文件标识、时间、结果；允许与拒绝都记）。预览不是下载，不经过这里。
import { MAX_SIGNED_LINK_TTL_SECONDS, type AuthContext } from "../access-control";
import type { LearningDeps } from "./deps";
import { authorizeOrThrow, requireUser } from "./deps";
import { LearningError } from "./errors";
import { downloadFileName, extOf } from "./files";
import { parseId } from "./ids";
import { loadCourse } from "./read";
import { courseVisible } from "./visibility";

export interface DownloadLink {
  url: string;
  fileName: string;
  expiresAt: string;
}

export async function downloadDocument(deps: LearningDeps, ctx: AuthContext, rawId: unknown): Promise<DownloadLink> {
  const userId = requireUser(ctx);
  const courseId = parseId(rawId, "courseId");
  await authorizeOrThrow(deps, ctx, "learning.read"); // 同 getCourse：没有动作权限的人探不到课程是否存在
  const loaded = await loadCourse(deps, courseId);
  if (!loaded) throw new LearningError("not_found", "course_not_found", "课程不存在");
  const { course, ref } = loaded;

  // 视频没有原件可下载。先确认范围再说「不是资料」，避免范围外的人借此探到课程类型；范围外的请求照常走守卫留下拒绝记录
  if (courseVisible(ctx.scope, ref) && (course.kind !== "document" || !course.fileKey || !course.fileMime)) {
    throw new LearningError("conflict", "not_a_document", "这门课没有可下载的原件");
  }

  // 关闭下载的课程（G-D50）：对所有人一样，只能在线预览。先于出口守卫拒绝，不签发任何附件链接；留一条拒绝记录便于追查
  if (courseVisible(ctx.scope, ref) && !course.allowDownload) {
    await deps.audit.write(
      { actor: ctx.actor, actorUserId: userId, eventType: "egress.learning_download", outcome: "denied", reasonCode: "download_disabled", targetType: "course", targetId: courseId.toString(), detail: { fileId: course.fileKey } },
      { risk: "low" },
    );
    throw new LearningError("authorization", "download_disabled", "这份资料不允许下载，只能在线查看");
  }

  const decision = await deps.egress.guardExit(10, ctx, {
    capability: "learning.read",
    resource: { key: "learning_course", ref },
    audit: { targetType: "course", targetId: courseId.toString(), detail: { fileId: course.fileKey } },
  });
  if (!decision.ok) throw new LearningError("authorization", decision.reason, "没有权限下载这份资料");

  const fileName = downloadFileName(course.title, extOf(course.fileMime!) ?? "bin");
  const ttl = Math.min(deps.config.downloadUrlTtlSeconds, MAX_SIGNED_LINK_TTL_SECONDS);
  try {
    const url = await deps.store.signedGetUrl(course.fileKey!, ttl, { downloadName: fileName });
    return { url, fileName, expiresAt: new Date(deps.clock.now().getTime() + ttl * 1000).toISOString() };
  } catch {
    // 守卫已记「允许」，但链接没签出来：补一条失败记录，让审计里的结果不是假的成功
    await deps.audit.write(
      {
        actor: ctx.actor,
        actorUserId: userId,
        eventType: "egress.learning_download",
        outcome: "failed",
        reasonCode: "sign_failed",
        targetType: "course",
        targetId: courseId.toString(),
        detail: { fileId: course.fileKey },
      },
      { risk: "low" },
    );
    throw new LearningError("unavailable", "sign_failed", "暂时无法生成下载链接，请稍后重试");
  }
}
