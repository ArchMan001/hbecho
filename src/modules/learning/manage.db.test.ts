// g-learning-min 任务 8（G-9 / G-13，acceptance F1–F4、I4）：课程维护——列表、编辑、替换、下架 / 上架。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { SAMPLE } from "../../../tests/harness/fake-course-store";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, fails, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { courseBrandScopes, courseMediaDeletions, courses, courseTags, learningProgress } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { requestUpload } from "./courses";
import { downloadDocument } from "./download";
import { getManageCourse, listManageCourses, parseManageQuery, ARCHIVE_AFTER_MS, replaceDocumentFile, replaceVideoFile, republishCourse, unpublishCourse, updateCourse } from "./manage";
import { getCourse, listCourses, parseListQuery } from "./read";

const t = useTestDb();
let e: LearningEnv;
let admin: AuthContext;
beforeEach(async () => {
  e = await learningEnv(t);
  admin = await e.actor("platform_admin");
});
const mq = (s = "") => parseManageQuery(new URLSearchParams(s));
const put = async (slot: "doc" | "cover", mime: string, bytes: Uint8Array) => {
  const tk = await requestUpload(e.deps, admin, { slot, mime, size: bytes.byteLength });
  e.store.upload(tk.key, bytes, mime);
  return tk.key;
};
const rowOf = async (id: bigint) => (await t.db.select().from(courses).where(eq(courses.courseId, id)))[0]!;

describe("维护范围", () => {
  it("管理列表：hq 只看到「指定品牌完全落在自己授权品牌内」和「全部品牌」的课；学员 / 分公司没有入口", async () => {
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    const a = await e.insertCourse({ title: "仅海信", brandIds: [e.org.hisense] });
    await e.insertCourse({ title: "海信+日立", brandIds: [e.org.hisense, e.org.hitachi] });
    await e.insertCourse({ title: "仅日立", brandIds: [e.org.hitachi] });
    const all = await e.insertCourse({ title: "全部品牌" });
    await e.insertCourse({ title: "已下架", brandIds: [e.org.hisense], status: "unpublished" });
    const list = (await listManageCourses(e.deps, hq, mq())).items;
    expect(list.map((i) => i.title).sort()).toEqual(["仅海信", "全部品牌", "已下架"]);
    expect((await listManageCourses(e.deps, admin, mq())).items).toHaveLength(5);
    expect(list.find((i) => i.courseId === a.toString())).toMatchObject({ brandScope: "specified", brandNames: ["海信"], status: "published" });
    expect(list.find((i) => i.courseId === all.toString())).toMatchObject({ brandScope: "all", brandNames: [] });
    for (const role of ["branch_manager", "store_staff"] as const) {
      const ctx = await e.actor(role, { brandIds: [e.org.hisense], branchIds: [e.org.bj], ...(role === "store_staff" ? { staff: e.org.staffA } : {}) });
      await fails(listManageCourses(e.deps, ctx, mq()), 403);
      await fails(unpublishCourse(e.deps, ctx, a.toString()), 403);
    }
  });

  it("管理列表筛选：状态 / 类型 / 标题；非法筛选 400", async () => {
    await e.insertCourse({ title: "甲" });
    await e.insertCourse({ title: "乙", status: "archived" });
    await e.insertCourse({ title: "丙", kind: "video", vodVideoId: "v1", vodVideoStatus: "failed", fileKey: null, fileMime: null, fileSize: null });
    expect((await listManageCourses(e.deps, admin, mq("status=archived"))).items.map((i) => i.title)).toEqual(["乙"]);
    expect((await listManageCourses(e.deps, admin, mq("kind=video"))).items.map((i) => [i.title, i.vodVideoStatus])).toEqual([["丙", "failed"]]);
    expect((await listManageCourses(e.deps, admin, mq("q=甲"))).items).toHaveLength(1);
    expect(() => mq("status=deleted")).toThrow(/不合法/);
  });

  it("范围外的课：读 / 改 / 下架 / 替换都 403（先于任何改动）；不存在 404", async () => {
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    const other = await e.insertCourse({ brandIds: [e.org.hitachi] });
    await fails(getManageCourse(e.deps, hq, other.toString()), 403, "out_of_scope");
    await fails(updateCourse(e.deps, hq, other.toString(), { title: "改" }), 403);
    await fails(unpublishCourse(e.deps, hq, other.toString()), 403);
    await fails(republishCourse(e.deps, hq, other.toString()), 403);
    await fails(replaceDocumentFile(e.deps, hq, other.toString(), { fileKey: "doc/x" }), 403);
    await fails(getManageCourse(e.deps, hq, "99999"), 404);
    expect((await rowOf(other)).status).toBe("published");
  });
});

describe("维护范围：对象判断与查询条件一致", () => {
  it("canManage ≡ manageSql（hq 单品牌 / 多品牌 / 超管 × 各种品牌范围）", async () => {
    const { manageSql, canManage } = await import("./visibility");
    const sets: bigint[][] = [[], [e.org.hisense], [e.org.hitachi], [e.org.hisense, e.org.hitachi], [e.org.hisense, e.org.york]];
    for (const b of sets) await e.insertCourse({ brandIds: b });
    const who = [admin, await e.actor("hq_manager", { brandIds: [e.org.hisense] }), await e.actor("hq_manager", { brandIds: [e.org.hisense, e.org.hitachi] })];
    const all = await t.db.select({ id: courses.courseId }).from(courses);
    for (const ctx of who) {
      const bySql = (await t.db.select({ id: courses.courseId }).from(courses).where(manageSql(ctx.scope))).map((r) => r.id).sort();
      const byObj: bigint[] = [];
      for (const { id } of all) {
        const [c] = await t.db.select().from(courses).where(eq(courses.courseId, id));
        const brandIds = (await t.db.select({ b: courseBrandScopes.brandId }).from(courseBrandScopes).where(eq(courseBrandScopes.courseId, id))).map((r) => r.b);
        if (canManage(ctx.scope, { brandScope: c!.brandScope as "all" | "specified", brandIds })) byObj.push(id);
      }
      expect(bySql).toEqual(byObj.sort());
    }
  });
});

describe("编辑（G-13 审计）", () => {
  it("改标题 / 简介 / 级别 / 标签：直接生效，审计含前后值；没变化不写审计", async () => {
    const tagA = await e.insertTag("甲");
    const tagB = await e.insertTag("乙");
    const id = await e.insertCourse({ title: "旧标题", description: "旧简介", tagIds: [tagA] });
    const r = await updateCourse(e.deps, admin, id.toString(), { title: "新标题", description: "新简介", audienceLevel: "hq_and_above", tagIds: [tagB.toString()] });
    expect(r.changed.sort()).toEqual(["audienceLevel", "description", "tagIds", "title"]);
    expect(await rowOf(id)).toMatchObject({ title: "新标题", description: "新简介", audienceLevel: "hq_and_above" });
    expect((await t.db.select().from(courseTags)).map((x) => x.tagId)).toEqual([tagB]);
    const [ev] = await auditOf(t, "learning_course_updated");
    expect(ev!.detail).toMatchObject({ changed: expect.arrayContaining(["title"]), before: { title: "旧标题" }, after: { title: "新标题" } });
    expect(await updateCourse(e.deps, admin, id.toString(), { title: "新标题" })).toEqual({ changed: [] });
    expect(await auditOf(t, "learning_course_updated")).toHaveLength(1);
  });

  it("改品牌范围：减少后原学员立即看不到，进度仍在；hq 不能逐个勾未授权品牌", async () => {
    const hisenseStaff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({ brandIds: [e.org.hisense, e.org.hitachi] });
    await t.db.insert(learningProgress).values({ userId: hisenseStaff.userId!, courseId: id, positionSec: 0, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });
    expect((await listCourses(e.deps, hisenseStaff, parseListQuery(new URLSearchParams()))).items).toHaveLength(1);

    await updateCourse(e.deps, admin, id.toString(), { brandScope: { brandIds: [e.org.hitachi.toString()] } });
    expect((await t.db.select().from(courseBrandScopes)).map((s) => s.brandId)).toEqual([e.org.hitachi]);
    await fails(getCourse(e.deps, hisenseStaff, id.toString()), 403);
    expect((await listCourses(e.deps, hisenseStaff, parseListQuery(new URLSearchParams()))).items).toEqual([]);
    expect(await t.db.select().from(learningProgress)).toHaveLength(1); // 进度保留

    const hq = await e.actor("hq_manager", { brandIds: [e.org.hitachi] });
    await fails(updateCourse(e.deps, hq, id.toString(), { brandScope: { brandIds: [e.org.hitachi.toString(), e.org.hisense.toString()] } }), 403, "brand_out_of_scope");
    await updateCourse(e.deps, hq, id.toString(), { brandScope: { all: true } }); // 走「全部品牌」这个显式动作可以
    expect(await t.db.select().from(courseBrandScopes)).toEqual([]);
    expect((await rowOf(id)).brandScope).toBe("all");
  });

  it("改封面：旧封面进删除队列并立即尝试删除；新封面校验同创建", async () => {
    const id = await e.insertCourse({ coverKey: "cover/00000000-0000-0000-0000-0000000000aa.png" });
    e.store.upload("cover/00000000-0000-0000-0000-0000000000aa.png", SAMPLE.png, "image/png");
    const next = await put("cover", "image/png", SAMPLE.png);
    await updateCourse(e.deps, admin, id.toString(), { coverKey: next });
    expect((await rowOf(id)).coverKey).toBe(next);
    expect(e.store.deleted).toEqual(["cover/00000000-0000-0000-0000-0000000000aa.png"]);
    expect((await t.db.select().from(courseMediaDeletions))[0]).toMatchObject({ status: "done", reason: "replaced" });
    const bad = await put("cover", "image/png", SAMPLE.jpg);
    await fails(updateCourse(e.deps, admin, id.toString(), { coverKey: bad }), 400, "file_content_mismatch");
    expect((await rowOf(id)).coverKey).toBe(next);
  });

  it("原样回传当前封面不是错误：当作没改（表单整体提交时），其余字段照常保存", async () => {
    const id = await e.insertCourse({ title: "旧", coverKey: "cover/00000000-0000-0000-0000-0000000000b1.png" });
    expect(await updateCourse(e.deps, admin, id.toString(), { coverKey: "cover/00000000-0000-0000-0000-0000000000b1.png" })).toEqual({ changed: [] });
    expect(await updateCourse(e.deps, admin, id.toString(), { coverKey: "cover/00000000-0000-0000-0000-0000000000b1.png", title: "新" })).toEqual({ changed: ["title"] });
    expect(e.store.deleted).toEqual([]);
  });

  it("G-D36：改视频课程标题同步到 VOD；同步失败不影响保存，留一条失败记录", async () => {
    const v = e.vod.add({ title: "旧" });
    const id = await e.insertCourse({ kind: "video", vodVideoId: v, vodVideoStatus: "normal", fileKey: null, fileMime: null, fileSize: null, title: "旧" });
    await updateCourse(e.deps, admin, id.toString(), { title: "新" });
    expect(e.vod.titleUpdates).toEqual([{ videoId: v, title: "新" }]);
    e.vod.failNext.updateTitle = 1;
    await updateCourse(e.deps, admin, id.toString(), { title: "更新" });
    expect((await rowOf(id)).title).toBe("更新");
    expect(await auditOf(t, "learning_vod_title_sync_failed")).toHaveLength(1);
  });

  it("没有要改的字段 / 多余字段 → 400；归档课程不能改 → 409", async () => {
    const id = await e.insertCourse({});
    await fails(updateCourse(e.deps, admin, id.toString(), {}), 400, "invalid_input");
    await fails(updateCourse(e.deps, admin, id.toString(), { status: "archived" }), 400, "invalid_input"); // 状态不能经编辑改
    const gone = await e.insertCourse({ status: "archived" });
    await fails(updateCourse(e.deps, admin, gone.toString(), { title: "x" }), 409, "course_archived");
  });
});

describe("下架与重新上架（F3、I4）", () => {
  it("F3：下架后学员列表不出现、详情 / 下载 403；进度保留；审计；重复下架无操作", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({});
    await t.db.insert(learningProgress).values({ userId: staff.userId!, courseId: id, positionSec: 0, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });
    expect(await unpublishCourse(e.deps, admin, id.toString())).toEqual({ changed: true });
    expect(await rowOf(id)).toMatchObject({ status: "unpublished", unpublishedAt: e.env.clock.now() });
    expect((await listCourses(e.deps, staff, parseListQuery(new URLSearchParams()))).items).toEqual([]);
    await fails(getCourse(e.deps, staff, id.toString()), 403);
    await fails(downloadDocument(e.deps, staff, id.toString()), 403);
    expect(await t.db.select().from(learningProgress)).toHaveLength(1);
    expect(await unpublishCourse(e.deps, admin, id.toString())).toEqual({ changed: false });
    expect(await auditOf(t, "learning_course_unpublished")).toHaveLength(1);
  });

  it("I4：下架 29 天可重新上架，进度继续；满 30 天不可（即使归档任务还没跑）", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({});
    await unpublishCourse(e.deps, admin, id.toString());
    e.env.clock.advance(29 * 86_400_000);
    expect(await republishCourse(e.deps, admin, id.toString())).toEqual({ changed: true });
    expect(await rowOf(id)).toMatchObject({ status: "published", unpublishedAt: null });
    expect((await listCourses(e.deps, staff, parseListQuery(new URLSearchParams()))).items).toHaveLength(1);
    expect(await republishCourse(e.deps, admin, id.toString())).toEqual({ changed: false });

    await unpublishCourse(e.deps, admin, id.toString());
    e.env.clock.advance(ARCHIVE_AFTER_MS);
    await fails(republishCourse(e.deps, admin, id.toString()), 409, "archive_due");
    expect((await rowOf(id)).status).toBe("unpublished");
    const gone = await e.insertCourse({ status: "archived" });
    await fails(republishCourse(e.deps, admin, gone.toString()), 409, "course_archived");
  });
});

describe("替换文件（F1、F2、G-D46）", () => {
  it("资料：新文件生效、旧对象立即删除、审计含旧文件标识与操作者、进度与位置不变", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const oldKey = "doc/00000000-0000-0000-0000-0000000000bb.pdf";
    e.store.upload(oldKey, SAMPLE.pdf, "application/pdf");
    const id = await e.insertCourse({ fileKey: oldKey });
    await t.db.insert(learningProgress).values({ userId: staff.userId!, courseId: id, positionSec: 42, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });

    const next = await put("doc", "image/png", SAMPLE.png);
    await replaceDocumentFile(e.deps, admin, id.toString(), { fileKey: next });
    expect(await rowOf(id)).toMatchObject({ fileKey: next, fileMime: "image/png", fileSize: SAMPLE.png.byteLength });
    expect(e.store.objects.has(oldKey)).toBe(false);
    const [ev] = await auditOf(t, "learning_course_file_replaced");
    expect(ev).toMatchObject({ actor: admin.actor, targetId: id.toString() });
    expect(ev!.detail).toMatchObject({ kind: "document", oldFileId: oldKey, newFileId: next });
    expect((await t.db.select().from(learningProgress))[0]!.positionSec).toBe(42);
  });

  it("资料：新文件校验不过 → 400，旧文件和课程都不动，新对象被删", async () => {
    const oldKey = "doc/00000000-0000-0000-0000-0000000000cc.pdf";
    e.store.upload(oldKey, SAMPLE.pdf, "application/pdf");
    const id = await e.insertCourse({ fileKey: oldKey });
    const bad = await put("doc", "application/pdf", SAMPLE.exe);
    await fails(replaceDocumentFile(e.deps, admin, id.toString(), { fileKey: bad }), 400, "file_content_mismatch");
    expect((await rowOf(id)).fileKey).toBe(oldKey);
    expect(e.store.objects.has(oldKey)).toBe(true);
    expect(e.store.objects.has(bad)).toBe(false);
    expect(await t.db.select().from(courseMediaDeletions)).toEqual([]);
  });

  it("资料：旧对象删除失败不影响新文件生效，进队列按退避重试，成功后标 done", async () => {
    const oldKey = "doc/00000000-0000-0000-0000-0000000000dd.pdf";
    e.store.upload(oldKey, SAMPLE.pdf, "application/pdf");
    const id = await e.insertCourse({ fileKey: oldKey });
    const next = await put("doc", "application/pdf", SAMPLE.pdf);
    e.store.failDelete = (k) => k === oldKey;
    await replaceDocumentFile(e.deps, admin, id.toString(), { fileKey: next });
    expect((await rowOf(id)).fileKey).toBe(next);
    const [q] = await t.db.select().from(courseMediaDeletions);
    expect(q).toMatchObject({ status: "pending", attempts: 1, lastError: "delete_failed", targetId: oldKey });
    expect(q!.nextAttemptAt.getTime()).toBe(e.env.clock.now().getTime() + 60_000); // 退避 1 分钟
    const { processDeletions } = await import("./media-deletions");
    expect(await processDeletions(e.deps)).toEqual({ done: 0, failed: 0, stuck: 0 }); // 还没到时间
    e.store.failDelete = null;
    e.env.clock.advance(61_000);
    expect(await processDeletions(e.deps)).toEqual({ done: 1, failed: 0, stuck: 0 });
    expect((await t.db.select().from(courseMediaDeletions))[0]).toMatchObject({ status: "done", lastError: null });
    expect(e.store.objects.has(oldKey)).toBe(false);
  });

  it("F2：视频换新：旧 VOD 视频被删，审计含旧 VideoId；新视频转码中学员暂不可播；位置保留", async () => {
    const oldV = e.vod.add({});
    const id = await e.insertCourse({ kind: "video", vodVideoId: oldV, vodVideoStatus: "normal", durationSec: 600, fileKey: null, fileMime: null, fileSize: null });
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    await t.db.insert(learningProgress).values({ userId: staff.userId!, courseId: id, positionSec: 300, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });
    const newV = e.vod.add({ status: "transcoding", durationSec: null });
    await replaceVideoFile(e.deps, admin, id.toString(), { videoId: newV });
    expect(await rowOf(id)).toMatchObject({ vodVideoId: newV, vodVideoStatus: "transcoding", durationSec: null });
    expect(e.vod.deleted).toEqual([oldV]);
    expect((await auditOf(t, "learning_course_file_replaced"))[0]!.detail).toMatchObject({ kind: "video", oldFileId: oldV, newFileId: newV });
    expect((await t.db.select().from(learningProgress))[0]!.positionSec).toBe(300);
    expect((await listCourses(e.deps, staff, parseListQuery(new URLSearchParams()))).items).toEqual([]); // 转码完成前不可见
  });

  it("视频换新：旧视频删除失败进队列；类型不符 409；新视频已被占用 409；VOD 暂不可用 503", async () => {
    const oldV = e.vod.add({});
    const id = await e.insertCourse({ kind: "video", vodVideoId: oldV, vodVideoStatus: "normal", fileKey: null, fileMime: null, fileSize: null });
    const doc = await e.insertCourse({});
    const newV = e.vod.add({});
    await fails(replaceVideoFile(e.deps, admin, doc.toString(), { videoId: newV }), 409, "wrong_kind");
    await fails(replaceDocumentFile(e.deps, admin, id.toString(), { fileKey: "doc/x" }), 409, "wrong_kind");
    await fails(replaceVideoFile(e.deps, admin, id.toString(), { videoId: oldV }), 409, "file_already_used");
    e.vod.failNext.getVideo = 1;
    await fails(replaceVideoFile(e.deps, admin, id.toString(), { videoId: newV }), 503, "vod_unavailable");
    e.vod.failNext.deleteVideo = 1;
    await replaceVideoFile(e.deps, admin, id.toString(), { videoId: newV });
    expect((await t.db.select().from(courseMediaDeletions))[0]).toMatchObject({ targetKind: "vod_video", targetId: oldV, status: "pending", attempts: 1 });
  });
});

describe("没有物理删除入口（F4）", () => {
  it("模块导出里没有删除课程的函数，源码里没有对 courses 的 delete", async () => {
    const api = await import("./index");
    expect(Object.keys(api).filter((k) => /^(delete|remove|purge)/i.test(k)).sort()).toEqual(["deleteTag", "deleteTagCategory"]); // 只有标签可删
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.includes(".test."))) {
      expect(readFileSync(dir + f, "utf8"), f).not.toMatch(/\.delete\(\s*courses\s*\)|DELETE\s+FROM\s+courses\b/i);
    }
  });
});
