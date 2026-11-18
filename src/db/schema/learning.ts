// G 域（学习平台）自有表（g-learning-min design §3；不写入 v2）。
// 约定同 src/db/columns.ts：signed BIGINT、UTC DATETIME(6)、状态 VARCHAR + CHECK、无 ON DELETE CASCADE（全部 RESTRICT）。
// 课程对象不进 A 域的 media_assets / oss_objects（design §3.6）。
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, int, mysqlTable, primaryKey, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { asciiBin, counter, id, inList, utc } from "../columns";
import { accessUsers } from "./access";
import { brands } from "./org";

export const COURSE_KINDS = ["video", "document"] as const;
export const COURSE_STATUSES = ["published", "unpublished", "archived"] as const;
export const COURSE_BRAND_SCOPES = ["specified", "all"] as const;
/** 适用人员级别（G-D40）：与品牌取交集；由 DataScope.level 映射，不建职级字段。 */
export const AUDIENCE_LEVELS = ["all", "branch_and_above", "hq_and_above"] as const;
export const VOD_VIDEO_STATUSES = ["uploading", "transcoding", "normal", "failed"] as const;
export const DOCUMENT_MIMES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const DELETION_TARGET_KINDS = ["vod_video", "oss_object"] as const;
export const DELETION_REASONS = ["replaced", "archived", "orphan", "create_failed"] as const;
export const DELETION_STATUSES = ["pending", "done"] as const;

export const courses = mysqlTable(
  "courses",
  {
    courseId: id("course_id").primaryKey().autoincrement(),
    title: varchar("title", { length: 200 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    description: text("description"),
    // 无草稿态；archived 由「下架满 30 天」的清理任务置位（G-D37）
    status: varchar("status", { length: 16 }).notNull(),
    brandScope: varchar("brand_scope", { length: 16 }).notNull(),
    audienceLevel: varchar("audience_level", { length: 24 }).notNull().default("all"),
    // 资料是否允许下载原件（G-D50）：对所有人一样；关闭后只能在线预览。已有课程默认允许（与现状一致）
    allowDownload: boolean("allow_download").notNull().default(true),
    // 对象 key 由我们生成，约束为 ASCII；所有课程封面必填（G-D48）
    coverKey: asciiBin("cover_key", { length: 512 }).notNull(),
    vodVideoId: varchar("vod_video_id", { length: 64 }),
    vodVideoStatus: varchar("vod_video_status", { length: 16 }),
    fileKey: asciiBin("file_key", { length: 512 }),
    fileMime: varchar("file_mime", { length: 128 }),
    fileSize: counter("file_size"),
    durationSec: int("duration_sec"),
    // 下架时刻：30 天后归档的起点（G-D37）；重新上架清空。归档课程保留它
    unpublishedAt: utc("unpublished_at"),
    // 创建请求的幂等键（视频课程）：同一用户同一键只建一门课
    createKey: asciiBin("create_key", { length: 64 }),
    createdBy: id("created_by").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_courses_created_by", columns: [t.createdBy], foreignColumns: [accessUsers.userId] }),
    // 同一个对象不能被两门课引用：替换 / 归档删除对象时不会误伤另一门课
    uniqueIndex("uq_courses_file_key").on(t.fileKey),
    uniqueIndex("uq_courses_cover_key").on(t.coverKey),
    uniqueIndex("uq_courses_create_key").on(t.createdBy, t.createKey),
    index("idx_courses_unpublished").on(t.status, t.unpublishedAt),
    check("ck_courses_unpublished_at", sql`(${t.status} = 'published') = (${t.unpublishedAt} IS NULL)`),
    index("idx_courses_status_updated").on(t.status, t.updatedAt),
    check("ck_courses_kind", inList(t.kind, COURSE_KINDS)),
    check("ck_courses_status", inList(t.status, COURSE_STATUSES)),
    check("ck_courses_brand_scope", inList(t.brandScope, COURSE_BRAND_SCOPES)),
    check("ck_courses_audience", inList(t.audienceLevel, AUDIENCE_LEVELS)),
    check("ck_courses_vod_status", sql`${t.vodVideoStatus} IS NULL OR ${inList(t.vodVideoStatus, VOD_VIDEO_STATUSES)}`),
    check("ck_courses_file_mime", sql`${t.fileMime} IS NULL OR ${inList(t.fileMime, DOCUMENT_MIMES)}`),
    check("ck_courses_file_size", sql`${t.fileSize} IS NULL OR ${t.fileSize} > 0`),
    check("ck_courses_duration", sql`${t.durationSec} IS NULL OR ${t.durationSec} >= 0`),
    // kind × 文件字段的组合（G-15）：视频要 VOD 标识、不带资料文件；资料要文件三件套、不带 VOD 标识
    check(
      "ck_courses_kind_fields",
      sql`(${t.kind} = 'video' AND ${t.vodVideoId} IS NOT NULL AND ${t.vodVideoStatus} IS NOT NULL
            AND ${t.fileKey} IS NULL AND ${t.fileMime} IS NULL AND ${t.fileSize} IS NULL)
        OR (${t.kind} = 'document' AND ${t.fileKey} IS NOT NULL AND ${t.fileMime} IS NOT NULL AND ${t.fileSize} IS NOT NULL
            AND ${t.vodVideoId} IS NULL AND ${t.vodVideoStatus} IS NULL)`,
    ),
  ],
);

// brand_scope = 'all' 时不写行（MySQL 没有跨表 CHECK，由应用保证并有测试覆盖）；下架 / 归档后行保留，汇总的范围条件照常生效
export const courseBrandScopes = mysqlTable(
  "course_brand_scopes",
  {
    courseId: id("course_id").notNull(),
    brandId: id("brand_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_course_brand_scopes", columns: [t.courseId, t.brandId] }),
    foreignKey({ name: "fk_course_brand_scopes_course", columns: [t.courseId], foreignColumns: [courses.courseId] }),
    foreignKey({ name: "fk_course_brand_scopes_brand", columns: [t.brandId], foreignColumns: [brands.brandId] }),
    index("idx_course_brand_scopes_brand").on(t.brandId, t.courseId),
  ],
);

// 一级标签（g-learning-tags-v2）：由超管维护，课程只能选择它下面的二级标签。
export const tagCategories = mysqlTable(
  "tag_categories",
  {
    categoryId: id("category_id").primaryKey().autoincrement(),
    name: varchar("name", { length: 32 }).notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_tag_categories_name").on(t.name)],
);

// 二级标签。本版只「扩展」：保留 uq_tags_name（标签名暂时全局唯一），下一版再收缩为只剩 (category_id, name)——
// 一个发布里只加不删，应用回滚时不用回滚结构（dev-test-deploy-workflow §7.2）。
export const tags = mysqlTable(
  "tags",
  {
    tagId: id("tag_id").primaryKey().autoincrement(),
    categoryId: id("category_id").notNull(),
    name: varchar("name", { length: 32 }).notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_tags_name").on(t.name),
    uniqueIndex("uq_tags_category_name").on(t.categoryId, t.name),
    foreignKey({ name: "fk_tags_category", columns: [t.categoryId], foreignColumns: [tagCategories.categoryId] }),
  ],
);

export const courseTags = mysqlTable(
  "course_tags",
  {
    courseId: id("course_id").notNull(),
    tagId: id("tag_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_course_tags", columns: [t.courseId, t.tagId] }),
    foreignKey({ name: "fk_course_tags_course", columns: [t.courseId], foreignColumns: [courses.courseId] }),
    foreignKey({ name: "fk_course_tags_tag", columns: [t.tagId], foreignColumns: [tags.tagId] }),
    index("idx_course_tags_tag").on(t.tagId),
  ],
);

// 一个 User 对一门课的当前进度，不建事件流水（design §9 第 1 项）。换店 = 新 User，进度不迁移（G-D41）
export const learningProgress = mysqlTable(
  "learning_progress",
  {
    progressId: id("progress_id").primaryKey().autoincrement(),
    userId: id("user_id").notNull(),
    courseId: id("course_id").notNull(),
    positionSec: int("position_sec").notNull().default(0),
    watchedSec: counter("watched_sec").notNull().default(0),
    playCount: int("play_count").notNull().default(0),
    firstLearnedAt: utc("first_learned_at").notNull(),
    lastLearnedAt: utc("last_learned_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_learning_progress_user", columns: [t.userId], foreignColumns: [accessUsers.userId] }),
    foreignKey({ name: "fk_learning_progress_course", columns: [t.courseId], foreignColumns: [courses.courseId] }),
    uniqueIndex("uq_learning_progress_user_course").on(t.userId, t.courseId),
    index("idx_learning_progress_user_last").on(t.userId, t.lastLearnedAt),
    check("ck_learning_progress_nonneg", sql`${t.positionSec} >= 0 AND ${t.watchedSec} >= 0 AND ${t.playCount} >= 0`),
  ],
);

// 待删除的媒体（替换的旧文件、归档的课程媒体、无引用的残渣）：删除失败不回滚业务，进这里重试（design §6）。
// 不用外键指向 courses：残渣没有课程；归档课程的行永远保留，所以 course_id 只作排查线索。
export const courseMediaDeletions = mysqlTable(
  "course_media_deletions",
  {
    deletionId: id("deletion_id").primaryKey().autoincrement(),
    targetKind: varchar("target_kind", { length: 16 }).notNull(),
    targetId: asciiBin("target_id", { length: 512 }).notNull(),
    courseId: id("course_id"),
    reason: varchar("reason", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    attempts: int("attempts").notNull().default(0),
    nextAttemptAt: utc("next_attempt_at").notNull(),
    lastError: varchar("last_error", { length: 64 }),
    createdAt: utc("created_at").notNull(),
    doneAt: utc("done_at"),
  },
  (t) => [
    uniqueIndex("uq_course_media_deletions_target").on(t.targetKind, t.targetId),
    index("idx_course_media_deletions_due").on(t.status, t.nextAttemptAt),
    check("ck_course_media_deletions_kind", inList(t.targetKind, DELETION_TARGET_KINDS)),
    check("ck_course_media_deletions_reason", inList(t.reason, DELETION_REASONS)),
    check("ck_course_media_deletions_status", inList(t.status, DELETION_STATUSES)),
    check("ck_course_media_deletions_done", sql`(${t.status} = 'done') = (${t.doneAt} IS NOT NULL)`),
    check("ck_course_media_deletions_attempts", sql`${t.attempts} >= 0`),
  ],
);
