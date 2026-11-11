// g-learning-min 任务 11（G-4 / G-9，acceptance I1、I2、I4、I5）：定时任务——转码回填、归档、残渣清理、删除重试。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { SAMPLE } from "../../../tests/harness/fake-course-store";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, fails, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { courseMediaDeletions, courses, learningProgress } from "../../db/schema";
import { archiveDue, ORPHAN_AFTER_MS, refreshVideoStatuses, runMaintenance, sweepOrphans } from "./jobs";
import { ARCHIVE_AFTER_MS, republishCourse, unpublishCourse } from "./manage";
import { processDeletions, STUCK_AFTER_MS } from "./media-deletions";
import { getCourse } from "./read";
import { getSummary } from "./summary";

const t = useTestDb();
let e: LearningEnv;
beforeEach(async () => {
  e = await learningEnv(t);
});
const H = 3600_000;
const rowOf = async (id: bigint) => (await t.db.select().from(courses).where(eq(courses.courseId, id)))[0]!;

describe("转码回填", () => {
  it("转码完成 → 状态 normal 并回填时长；VOD 里已没有这个视频 → failed；暂时查不到 → 保持原状", async () => {
    const ok = e.vod.add({ status: "transcoding", durationSec: null });
    const gone = "a".repeat(32);
    const flaky = e.vod.add({ status: "transcoding", durationSec: null });
    const mk = (v: string) => e.insertCourse({ kind: "video", vodVideoId: v, vodVideoStatus: "transcoding", fileKey: null, fileMime: null, fileSize: null });
    const [a, b, c] = [await mk(ok), await mk(gone), await mk(flaky)];
    e.vod.videos.get(ok)!.status = "normal";
    e.vod.videos.get(ok)!.durationSec = 321;
    e.vod.failNext.getVideo = 0;
    // 第 3 个视频查询时失败：用 videos 删掉不合适，这里让 getVideo 在第二次调用后抛
    const origGet = e.vod.getVideo.bind(e.vod);
    e.vod.getVideo = async (id: string) => {
      if (id === flaky) throw new Error("vod down");
      return origGet(id);
    };
    expect(await refreshVideoStatuses(e.deps)).toEqual({ checked: 3, changed: 2 });
    expect(await rowOf(a)).toMatchObject({ vodVideoStatus: "normal", durationSec: 321 });
    expect(await rowOf(b)).toMatchObject({ vodVideoStatus: "failed" });
    expect(await rowOf(c)).toMatchObject({ vodVideoStatus: "transcoding" });
    expect(await refreshVideoStatuses(e.deps)).toEqual({ checked: 1, changed: 0 }); // 只剩还在转码的
  });
});

describe("归档（I4、I5）", () => {
  const setup = async () => {
    const admin = await e.actor("platform_admin");
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const v = e.vod.add({});
    const vid = await e.insertCourse({ kind: "video", vodVideoId: v, vodVideoStatus: "normal", durationSec: 60, fileKey: null, fileMime: null, fileSize: null, coverKey: "cover/00000000-0000-0000-0000-00000000000a.png" });
    const docKey = "doc/00000000-0000-0000-0000-00000000000b.pdf";
    e.store.upload(docKey, SAMPLE.pdf, "application/pdf");
    e.store.upload("cover/00000000-0000-0000-0000-00000000000a.png", SAMPLE.png, "image/png");
    e.store.upload("cover/00000000-0000-0000-0000-00000000000c.png", SAMPLE.png, "image/png");
    const doc = await e.insertCourse({ fileKey: docKey, coverKey: "cover/00000000-0000-0000-0000-00000000000c.png" });
    await t.db.insert(learningProgress).values({ userId: staff.userId!, courseId: vid, watchedSec: 100, playCount: 2, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });
    return { admin, staff, v, vid, doc, docKey };
  };

  it("下架 29 天不动（可重新上架）；31 天归档：状态 archived、媒体与封面已删、行与进度保留、审计留痕", async () => {
    const { admin, staff, v, vid, doc, docKey } = await setup();
    await unpublishCourse(e.deps, admin, vid.toString());
    await unpublishCourse(e.deps, admin, doc.toString());
    e.env.clock.advance(29 * 24 * H);
    expect(await archiveDue(e.deps)).toEqual({ archived: 0 });
    await republishCourse(e.deps, admin, doc.toString()); // 29 天内可以
    await unpublishCourse(e.deps, admin, doc.toString()); // 重新下架：重新起算

    e.env.clock.advance(2 * 24 * H); // vid 已满 31 天，doc 才 2 天
    expect(await archiveDue(e.deps)).toEqual({ archived: 1 });
    expect(await rowOf(vid)).toMatchObject({ status: "archived", vodVideoId: v });
    expect(await rowOf(doc)).toMatchObject({ status: "unpublished" });
    expect(await archiveDue(e.deps)).toEqual({ archived: 0 }); // 幂等

    expect(await processDeletions(e.deps)).toMatchObject({ done: 2, failed: 0 });
    expect(e.vod.deleted).toEqual([v]);
    expect(e.store.deleted).toEqual(["cover/00000000-0000-0000-0000-00000000000a.png"]);
    expect(e.store.objects.has(docKey)).toBe(true); // 未归档的资料文件还在
    expect(await t.db.select().from(learningProgress)).toHaveLength(1);
    const [ev] = await auditOf(t, "learning_course_archived");
    expect(ev).toMatchObject({ actor: "service:learning-worker", targetId: vid.toString() });
    await fails(getCourse(e.deps, staff, vid.toString()), 403);
    await fails(republishCourse(e.deps, admin, vid.toString()), 409, "course_archived");
    // I5：归档课程不计课程数，学习人数与时长不变
    expect(await getSummary(e.deps, admin)).toMatchObject({ learnerCount: 1, watchedSeconds: 100, playCount: 2 });
  });

  it("归档时媒体删除失败：课程仍归档，失败记入队列并重试成功", async () => {
    const { admin, vid, v } = await setup();
    await unpublishCourse(e.deps, admin, vid.toString());
    e.env.clock.advance(ARCHIVE_AFTER_MS + 1000);
    await archiveDue(e.deps);
    e.vod.failNext.deleteVideo = 1;
    const r = await processDeletions(e.deps);
    expect(r.failed).toBe(1);
    expect((await rowOf(vid)).status).toBe("archived");
    e.env.clock.advance(2 * 60_000);
    expect(await processDeletions(e.deps)).toMatchObject({ done: 1, failed: 0 });
    expect(e.vod.deleted).toEqual([v]);
  });
});

describe("删除重试与告警（G-D46）", () => {
  it("退避 1、2、4…分钟；24 小时仍失败触发告警，但继续重试", async () => {
    const alerts: unknown[] = [];
    const deps = { ...e.deps, alert: (a: unknown) => void alerts.push(a) };
    const oldKey = "doc/00000000-0000-0000-0000-0000000000ee.pdf";
    e.store.upload(oldKey, SAMPLE.pdf, "application/pdf");
    const { enqueueDeletion } = await import("./media-deletions");
    await enqueueDeletion(t.db, e.deps, { kind: "oss_object", id: oldKey }, "replaced", null);
    e.store.failDelete = () => true;
    const gaps: number[] = [];
    let last = e.env.clock.now().getTime();
    for (let i = 0; i < 4; i++) {
      await processDeletions(deps);
      const [q] = await t.db.select().from(courseMediaDeletions);
      gaps.push(q!.nextAttemptAt.getTime() - e.env.clock.now().getTime());
      e.env.clock.set(q!.nextAttemptAt);
      last = q!.attempts;
    }
    expect(gaps).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(last).toBe(4);
    expect(alerts).toEqual([]);
    e.env.clock.advance(STUCK_AFTER_MS);
    await processDeletions(deps);
    expect(alerts).toEqual([{ code: "media_deletion_stuck", targetKind: "oss_object", targetId: oldKey, attempts: 5 }]);
    expect((await t.db.select().from(courseMediaDeletions))[0]!.status).toBe("pending");
  });
});

describe("残渣清理（I1、I2）", () => {
  it("I1：孤儿 VOD 视频 12 小时保留、30 小时删除；I2：有课程引用的不删", async () => {
    const referenced = e.vod.add({});
    await e.insertCourse({ kind: "video", vodVideoId: referenced, vodVideoStatus: "normal", fileKey: null, fileMime: null, fileSize: null });
    const orphan = e.vod.add({});
    e.env.clock.advance(12 * H);
    expect(await sweepOrphans(e.deps)).toEqual({ queued: 0 });
    e.env.clock.advance(18 * H); // 现在距上传 30 小时
    expect(await sweepOrphans(e.deps)).toEqual({ queued: 1 });
    expect(await sweepOrphans(e.deps)).toEqual({ queued: 0 }); // 幂等：已在队列
    await processDeletions(e.deps);
    expect(e.vod.deleted).toEqual([orphan]);
    expect(e.vod.videos.has(referenced)).toBe(true);
    expect((await t.db.select().from(courseMediaDeletions))[0]).toMatchObject({ reason: "orphan", status: "done" });
  });

  it("OSS 里直传后没建课程的对象同样按 24 小时清理；被课程引用的（资料与封面）不删", async () => {
    const keep = "doc/00000000-0000-0000-0000-0000000000f1.pdf";
    e.store.upload(keep, SAMPLE.pdf, "application/pdf");
    await e.insertCourse({ fileKey: keep, coverKey: "cover/00000000-0000-0000-0000-0000000000f2.png" });
    e.store.upload("cover/00000000-0000-0000-0000-0000000000f2.png", SAMPLE.png, "image/png");
    const stray = "doc/00000000-0000-0000-0000-0000000000f3.pdf";
    e.store.upload(stray, SAMPLE.pdf, "application/pdf");
    e.env.clock.advance(ORPHAN_AFTER_MS - H);
    expect(await sweepOrphans(e.deps)).toEqual({ queued: 0 }); // 23 小时
    e.env.clock.advance(2 * H);
    expect(await sweepOrphans(e.deps)).toEqual({ queued: 1 });
    await processDeletions(e.deps);
    expect(e.store.deleted).toEqual([stray]);
    expect(e.store.objects.has(keep)).toBe(true);
  });

  it("新传的对象（刚上传、尚未提交课程）不会被误删", async () => {
    e.store.upload("doc/00000000-0000-0000-0000-0000000000f4.pdf", SAMPLE.pdf, "application/pdf");
    e.vod.add({});
    e.env.clock.advance(H);
    expect(await sweepOrphans(e.deps)).toEqual({ queued: 0 });
  });
});

describe("一轮维护", () => {
  it("每步独立：VOD 列表失败不影响归档与删除重试；慢任务按 slow 开关", async () => {
    const admin = await e.actor("platform_admin");
    const id = await e.insertCourse({});
    await unpublishCourse(e.deps, admin, id.toString());
    e.env.clock.advance(ARCHIVE_AFTER_MS + H);
    e.vod.failNext.listVideosBefore = 1;
    const fast = await runMaintenance(e.deps, { slow: false });
    expect(fast.archive).toBeUndefined();
    expect((await rowOf(id)).status).toBe("unpublished");
    const slow = await runMaintenance(e.deps, { slow: true });
    expect(slow.archive).toEqual({ archived: 1 });
    expect(slow.orphans).toBeUndefined(); // 列 VOD 失败（上面注入的那一次被 fast 轮没消耗，在这里消耗）
    expect(slow.deletions.done).toBe(2); // 归档课程的资料文件与封面在同一轮里被删除
  });
});
