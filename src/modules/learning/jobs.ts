// 定时任务（G-4、G-9、G-D23、G-D37、G-D46）。每个函数独立、幂等，可单独调度；worker/learning-main.ts 负责节奏。
//   refreshVideoStatuses  转码结果回填（状态与时长）
//   processDeletions      待删除媒体重试（media-deletions.ts）
//   archiveDue            下架满 30 天 → 归档并入队删媒体
//   sweepOrphans          无引用超过 24 小时的 VOD 视频与 OSS 对象 → 入队删除
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { courses, courseMediaDeletions } from "../../db/schema";
import type { LearningDeps } from "./deps";
import { ARCHIVE_AFTER_MS } from "./manage";
import { enqueueDeletion, processDeletions, type DeletionRun } from "./media-deletions";

export const ORPHAN_AFTER_MS = 24 * 3600_000;
export const SYSTEM_ACTOR = "service:learning-worker";

/** 轮询转码中的视频，回填状态与时长。VOD 里已经没有这个视频 → 标记失败（学员侧不可播，维护者可替换）。 */
export async function refreshVideoStatuses(deps: LearningDeps): Promise<{ checked: number; changed: number }> {
  const rows = await deps.db
    .select({ id: courses.courseId, vodId: courses.vodVideoId, status: courses.vodVideoStatus, duration: courses.durationSec })
    .from(courses)
    .where(and(eq(courses.kind, "video"), inArray(courses.vodVideoStatus, ["uploading", "transcoding"])))
    .limit(500);
  let changed = 0;
  for (const r of rows) {
    let info;
    try {
      info = await deps.vod.getVideo(r.vodId!);
    } catch {
      continue; // 暂时不可用：下一轮再查
    }
    const status = info?.status ?? "failed";
    const duration = info?.durationSec ?? r.duration;
    if (status === r.status && duration === r.duration) continue;
    await deps.db.update(courses).set({ vodVideoStatus: status, durationSec: duration, updatedAt: deps.clock.now() }).where(eq(courses.courseId, r.id));
    changed += 1;
  }
  return { checked: rows.length, changed };
}

/** 下架满 30 天的课程：状态置 archived，视频 / 资料 / 封面入删除队列。进度、汇总、审计、课程行都保留。 */
export async function archiveDue(deps: LearningDeps): Promise<{ archived: number }> {
  const cutoff = new Date(deps.clock.now().getTime() - ARCHIVE_AFTER_MS);
  const due = await deps.db
    .select({ id: courses.courseId })
    .from(courses)
    .where(and(eq(courses.status, "unpublished"), isNotNull(courses.unpublishedAt), lte(courses.unpublishedAt, cutoff)))
    .limit(200);
  let archived = 0;
  for (const { id } of due) {
    const done = await deps.db.transaction(async (tx) => {
      const [c] = await tx.select().from(courses).where(eq(courses.courseId, id)).for("update");
      if (!c || c.status !== "unpublished") return false; // 刚被重新上架
      await tx.update(courses).set({ status: "archived", updatedAt: deps.clock.now() }).where(eq(courses.courseId, id));
      if (c.vodVideoId) await enqueueDeletion(tx, deps, { kind: "vod_video", id: c.vodVideoId }, "archived", id);
      if (c.fileKey) await enqueueDeletion(tx, deps, { kind: "oss_object", id: c.fileKey }, "archived", id);
      await enqueueDeletion(tx, deps, { kind: "oss_object", id: c.coverKey }, "archived", id);
      await deps.audit.write(
        { actor: SYSTEM_ACTOR, eventType: "learning_course_archived", outcome: "succeeded", reasonCode: "course_archived", targetType: "course", targetId: id.toString(), detail: { title: c.title, vodVideoId: c.vodVideoId, fileKey: c.fileKey, coverKey: c.coverKey } },
        { tx, risk: "high" },
      );
      return true;
    });
    if (done) archived += 1;
  }
  return { archived };
}

/**
 * 残渣：上传中断留下的 VOD 视频、直传后没建课程的 OSS 对象、删除队列放弃的旧文件。
 * 判据是「没有任何课程引用，且创建超过 24 小时」。
 * ponytail: 引用集合整表读入内存，课程数到数万时改为按批 IN 查询。
 */
export async function sweepOrphans(deps: LearningDeps): Promise<{ queued: number }> {
  const cutoff = new Date(deps.clock.now().getTime() - ORPHAN_AFTER_MS);
  const refs = await deps.db.select({ v: courses.vodVideoId, f: courses.fileKey, c: courses.coverKey }).from(courses);
  const videoRefs = new Set(refs.flatMap((r) => (r.v ? [r.v] : [])));
  const objectRefs = new Set(refs.flatMap((r) => [r.c, ...(r.f ? [r.f] : [])]));
  let queued = 0;
  const queue = async (kind: "vod_video" | "oss_object", id: string) => {
    const [exists] = await deps.db.select({ s: courseMediaDeletions.status }).from(courseMediaDeletions).where(and(eq(courseMediaDeletions.targetKind, kind), eq(courseMediaDeletions.targetId, id))).limit(1);
    if (exists) return;
    await enqueueDeletion(deps.db, deps, { kind, id }, "orphan", null);
    queued += 1;
  };
  for (const v of await deps.vod.listVideosBefore(cutoff)) if (!videoRefs.has(v.videoId)) await queue("vod_video", v.videoId);
  for (const prefix of ["doc/", "cover/"]) for (const o of await deps.store.list(prefix)) if (o.lastModified < cutoff && !objectRefs.has(o.key)) await queue("oss_object", o.key);
  return { queued };
}

export interface MaintenanceReport {
  refresh: { checked: number; changed: number };
  deletions: DeletionRun;
  archive?: { archived: number };
  orphans?: { queued: number };
}
/** 一轮维护：每轮都做状态回填与删除重试；归档与残渣较慢（列 VOD / OSS），由 `slow` 控制。每步独立，一步抛错不影响后面的。 */
export async function runMaintenance(deps: LearningDeps, opts: { slow: boolean }): Promise<MaintenanceReport> {
  const report = { refresh: { checked: 0, changed: 0 }, deletions: { done: 0, failed: 0, stuck: 0 } } as MaintenanceReport;
  const safe = async <T>(fn: () => Promise<T>): Promise<T | undefined> => fn().catch(() => undefined);
  report.refresh = (await safe(() => refreshVideoStatuses(deps))) ?? report.refresh;
  if (opts.slow) {
    const archive = await safe(() => archiveDue(deps));
    if (archive) report.archive = archive;
    const orphans = await safe(() => sweepOrphans(deps));
    if (orphans) report.orphans = orphans;
  }
  report.deletions = (await safe(() => processDeletions(deps))) ?? report.deletions;
  return report;
}
