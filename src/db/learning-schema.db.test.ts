// g-learning-min 任务 1（acceptance A1–A4）：五张新表在真实 MySQL 8.4 上是否真的强制设计里的约束。
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, seedAccessOrg } from "../../tests/harness/access";
import { expectRejected, useTestDb } from "../../tests/harness/db";
import { runMigrations } from "./client";
import { courseBrandScopes, courseMediaDeletions, courses, courseTags, learningProgress, tagCategories, tags } from "./schema";

const NOW = new Date("2026-11-11T02:00:00.000000Z");
const t = useTestDb();

async function setup() {
  const env = accessEnv(t, { flow: false });
  const org = await seedAccessOrg(env);
  const userId = await insertAccessUser(env, { role: "hq_manager", phone: "13900000001", password: false, brandIds: [org.hisense] });
  return { org, userId };
}
type NewCourse = typeof courses.$inferInsert;
const doc = (createdBy: bigint, over: Partial<NewCourse> = {}): NewCourse => ({
  title: "资料",
  kind: "document",
  status: "published",
  brandScope: "all",
  coverKey: `cover/${Math.random().toString(16).slice(2)}.png`,
  fileKey: `doc/${Math.random().toString(16).slice(2)}.pdf`,
  fileMime: "application/pdf",
  fileSize: 1024,
  createdBy,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const video = (createdBy: bigint, over: Partial<NewCourse> = {}): NewCourse => ({
  title: "视频",
  kind: "video",
  status: "published",
  brandScope: "all",
  coverKey: `cover/${Math.random().toString(16).slice(2)}.jpg`,
  vodVideoId: "vod-1",
  vodVideoStatus: "normal",
  createdBy,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const insertId = async (v: NewCourse) => BigInt((await t.db.insert(courses).values(v))[0].insertId);

describe("课程表约束", () => {
  it("A1：迁移连跑两次无变更", async () => {
    await runMigrations(t.db);
    await runMigrations(t.db);
  });

  it("A2：kind × 文件字段的组合由 CHECK 守护", async () => {
    const { userId } = await setup();
    await expectRejected(t.db.insert(courses).values(video(userId, { vodVideoId: null })), "ck_courses_kind_fields");
    await expectRejected(t.db.insert(courses).values(video(userId, { vodVideoStatus: null })), "ck_courses_kind_fields");
    await expectRejected(t.db.insert(courses).values(video(userId, { coverKey: null as never })), "cover_key"); // 封面必填（G-D48）：视频与资料一样
    await expectRejected(t.db.insert(courses).values(doc(userId, { coverKey: null as never })), "cover_key");
    await expectRejected(t.db.insert(courses).values(video(userId, { fileKey: "doc/x.pdf", fileMime: "application/pdf", fileSize: 1 })), "ck_courses_kind_fields");
    await expectRejected(t.db.insert(courses).values(doc(userId, { fileKey: null })), "ck_courses_kind_fields");
    await expectRejected(t.db.insert(courses).values(doc(userId, { fileMime: null })), "ck_courses_kind_fields");
    await expectRejected(t.db.insert(courses).values(doc(userId, { vodVideoId: "v", vodVideoStatus: "normal" })), "ck_courses_kind_fields");
    // 合法形态
    await insertId(doc(userId));
    await insertId(video(userId));
  });

  it("枚举、数值范围与 MIME 白名单", async () => {
    const { userId } = await setup();
    await expectRejected(t.db.insert(courses).values(doc(userId, { kind: "audio" })), "ck_courses_kind");
    await expectRejected(t.db.insert(courses).values(doc(userId, { status: "draft" })), "ck_courses_status");
    await expectRejected(t.db.insert(courses).values(doc(userId, { brandScope: "some" })), "ck_courses_brand_scope");
    await expectRejected(t.db.insert(courses).values(doc(userId, { audienceLevel: "everyone" })), "ck_courses_audience");
    await expectRejected(t.db.insert(courses).values(video(userId, { vodVideoStatus: "ok" })), "ck_courses_vod_status");
    await expectRejected(t.db.insert(courses).values(doc(userId, { fileMime: "application/msword" })), "ck_courses_file_mime");
    await expectRejected(t.db.insert(courses).values(doc(userId, { fileSize: 0 })), "ck_courses_file_size");
    await expectRejected(t.db.insert(courses).values(video(userId, { durationSec: -1 })), "ck_courses_duration");
    const id = await insertId(doc(userId));
    const [row] = await t.db.select().from(courses);
    expect(row!.courseId).toBe(id);
    expect(row!.audienceLevel).toBe("all"); // 缺省值
  });

  it("同一个对象不能被两门课引用", async () => {
    const { userId } = await setup();
    await insertId(doc(userId, { fileKey: "doc/same.pdf" }));
    await expectRejected(t.db.insert(courses).values(doc(userId, { fileKey: "doc/same.pdf" })), "uq_courses_file_key");
    await insertId(doc(userId, { coverKey: "cover/same.png" }));
    await expectRejected(t.db.insert(courses).values(doc(userId, { coverKey: "cover/same.png" })), "uq_courses_cover_key");
  });

  it("下架时刻与状态一致：已发布不带、下架 / 归档必带（G-D37 的起算点）", async () => {
    const { userId } = await setup();
    await expectRejected(t.db.insert(courses).values(doc(userId, { unpublishedAt: NOW })), "ck_courses_unpublished_at");
    await expectRejected(t.db.insert(courses).values(doc(userId, { status: "unpublished" })), "ck_courses_unpublished_at");
    await expectRejected(t.db.insert(courses).values(doc(userId, { status: "archived" })), "ck_courses_unpublished_at");
    await insertId(doc(userId, { status: "unpublished", unpublishedAt: NOW }));
    await insertId(doc(userId, { status: "archived", unpublishedAt: NOW }));
  });

  it("创建幂等键：同一用户同一键只能有一门课，不同用户可以重复；缺省（NULL）不受限", async () => {
    const { org, userId } = await setup();
    const other = await insertAccessUser(accessEnv(t, { flow: false }), { role: "hq_manager", phone: "13900000002", password: false, brandIds: [org.hisense] });
    await insertId(video(userId, { createKey: "key-0000000000000001" }));
    await expectRejected(t.db.insert(courses).values(video(userId, { createKey: "key-0000000000000001", vodVideoId: "vod-2" })), "uq_courses_create_key");
    await insertId(video(other, { createKey: "key-0000000000000001", vodVideoId: "vod-3" }));
    await insertId(doc(userId));
    await insertId(doc(userId));
  });

  it("created_by 必须是真实用户", async () => {
    await setup();
    await expectRejected(t.db.insert(courses).values(doc(987654321n)), "fk_courses_created_by");
  });
});

describe("关联表与外键", () => {
  it("A3：被引用的课程 / 标签 / 品牌删不掉（RESTRICT），且没有任何 CASCADE", async () => {
    const { org, userId } = await setup();
    const courseId = await insertId(doc(userId, { brandScope: "specified" }));
    const [cat] = await t.db.insert(tagCategories).values({ name: "阶段", createdAt: NOW });
    const [tg] = await t.db.insert(tags).values({ categoryId: BigInt(cat.insertId), name: "新员工", createdAt: NOW });
    const tagId = BigInt(tg.insertId);
    await t.db.insert(courseTags).values({ courseId, tagId });
    await t.db.insert(courseBrandScopes).values({ courseId, brandId: org.york });
    // 课程同时被标签和品牌范围引用，MySQL 报先检查到的那条；这里只关心「被拒绝」，具体外键名在下面逐个核对
    await expectRejected(t.db.delete(courses).where(sql`course_id = ${courseId}`), "foreign key constraint fails");
    await expectRejected(t.db.delete(tags).where(sql`tag_id = ${tagId}`), "fk_course_tags_tag");
    await expectRejected(t.db.execute(sql`DELETE FROM brands WHERE brand_id = ${org.york}`), "fk_course_brand_scopes_brand");

    const [rules] = await t.db.execute(
      sql`SELECT constraint_name AS n, delete_rule AS d FROM information_schema.referential_constraints
          WHERE constraint_schema = DATABASE() AND table_name IN ('courses','course_brand_scopes','course_tags','learning_progress')`,
    );
    const list = rules as unknown as Array<{ n: string; d: string }>;
    expect(list.length).toBe(7); // courses 1 + course_brand_scopes 2 + course_tags 2 + learning_progress 2
    expect(list.filter((r) => r.d === "CASCADE" || r.d === "SET NULL")).toEqual([]);
  });

  it("关联行的引用必须真实存在", async () => {
    const { userId } = await setup();
    const courseId = await insertId(doc(userId));
    await expectRejected(t.db.insert(courseBrandScopes).values({ courseId, brandId: 424242n }), "fk_course_brand_scopes_brand");
    await expectRejected(t.db.insert(courseTags).values({ courseId, tagId: 424242n }), "fk_course_tags_tag");
    await expectRejected(t.db.insert(courseBrandScopes).values({ courseId: 424242n, brandId: 1n }), "fk_course_brand_scopes_course");
  });

  it("标签名暂时全局唯一；一级标签名唯一", async () => {
    await setup();
    const [a] = await t.db.insert(tagCategories).values({ name: "阶段", createdAt: NOW });
    const [b] = await t.db.insert(tagCategories).values({ name: "板块", createdAt: NOW });
    await expectRejected(t.db.insert(tagCategories).values({ name: "阶段", createdAt: NOW }), "uq_tag_categories_name");
    await t.db.insert(tags).values({ categoryId: BigInt(a.insertId), name: "合规", createdAt: NOW });
    await expectRejected(t.db.insert(tags).values({ categoryId: BigInt(a.insertId), name: "合规", createdAt: NOW }), "uq_tags_");
    await expectRejected(t.db.insert(tags).values({ categoryId: BigInt(b.insertId), name: "合规", createdAt: NOW }), "uq_tags_name"); // 下一版收缩后才允许跨一级标签重名
  });
  it("二级标签必须挂在存在的一级标签下；有二级标签的一级标签删不掉（RESTRICT）", async () => {
    await setup();
    await expectRejected(t.db.insert(tags).values({ categoryId: 424242n, name: "孤儿", createdAt: NOW }), "fk_tags_category");
    const [cat] = await t.db.insert(tagCategories).values({ name: "阶段", createdAt: NOW });
    await t.db.insert(tags).values({ categoryId: BigInt(cat.insertId), name: "入门", createdAt: NOW });
    await expectRejected(t.db.execute(sql`DELETE FROM tag_categories WHERE category_id = ${BigInt(cat.insertId)}`), "fk_tags_category");
  });
});

describe("待删除媒体队列", () => {
  const row = (over: Partial<typeof courseMediaDeletions.$inferInsert> = {}): typeof courseMediaDeletions.$inferInsert => ({
    targetKind: "vod_video",
    targetId: "vod-1",
    reason: "replaced",
    status: "pending",
    nextAttemptAt: NOW,
    createdAt: NOW,
    ...over,
  });
  it("枚举、完成时刻与同一对象只入队一次", async () => {
    await setup();
    await expectRejected(t.db.insert(courseMediaDeletions).values(row({ targetKind: "bucket" })), "ck_course_media_deletions_kind");
    await expectRejected(t.db.insert(courseMediaDeletions).values(row({ reason: "because" })), "ck_course_media_deletions_reason");
    await expectRejected(t.db.insert(courseMediaDeletions).values(row({ status: "retry" })), "ck_course_media_deletions_status");
    await expectRejected(t.db.insert(courseMediaDeletions).values(row({ status: "done" })), "ck_course_media_deletions_done");
    await expectRejected(t.db.insert(courseMediaDeletions).values(row({ attempts: -1 })), "ck_course_media_deletions_attempts");
    await t.db.insert(courseMediaDeletions).values(row());
    await expectRejected(t.db.insert(courseMediaDeletions).values(row()), "uq_course_media_deletions_target");
    await t.db.insert(courseMediaDeletions).values(row({ targetKind: "oss_object" })); // 同 ID 不同种类可以
  });
});

describe("学习进度表", () => {
  it("A4：同一 (user, course) 只能有一行；数值非负；引用必须真实", async () => {
    const { userId } = await setup();
    const courseId = await insertId(doc(userId));
    const row = { userId, courseId, firstLearnedAt: NOW, lastLearnedAt: NOW };
    await t.db.insert(learningProgress).values(row);
    await expectRejected(t.db.insert(learningProgress).values(row), "uq_learning_progress_user_course");
    const other = await insertId(doc(userId));
    await expectRejected(t.db.insert(learningProgress).values({ ...row, courseId: other, positionSec: -1 }), "ck_learning_progress_nonneg");
    await expectRejected(t.db.insert(learningProgress).values({ ...row, courseId: 424242n }), "fk_learning_progress_course");
    await expectRejected(t.db.insert(learningProgress).values({ ...row, userId: 424242n, courseId: other }), "fk_learning_progress_user");
    const [p] = await t.db.select().from(learningProgress);
    expect([p!.positionSec, p!.watchedSec, p!.playCount]).toEqual([0, 0, 0]);
  });
});
