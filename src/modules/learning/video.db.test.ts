// g-learning-min 任务 4（G-1 / G-4，acceptance D1–D3、D7）：视频课程创建（fake VOD）。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { SAMPLE } from "../../../tests/harness/fake-course-store";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, fails, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { courseBrandScopes, courses } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { createVideoCourse, requestUpload, requestVideoUpload } from "./courses";

const t = useTestDb();
let e: LearningEnv;
let admin: AuthContext;
let tagId: bigint;
beforeEach(async () => {
  e = await learningEnv(t);
  admin = await e.actor("platform_admin");
  tagId = await e.insertTag("新人");
});

const cover = async (ctx: AuthContext = admin) => {
  const tk = await requestUpload(e.deps, ctx, { slot: "cover", mime: "image/png", size: SAMPLE.png.byteLength });
  e.store.upload(tk.key, SAMPLE.png, "image/png");
  return tk.key;
};
const KEY = "idem-key-0000000001";
const body = async (videoId: string, over: Record<string, unknown> = {}) => ({
  title: "收银台话术",
  description: "新员工必看",
  brandScope: { all: true },
  tagIds: [tagId.toString()],
  coverKey: await cover(),
  videoId,
  ...over,
});

describe("取上传凭证", () => {
  it("D1：凭证经 VOD 端口签发（模板组与 cn-beijing 常量在真实适配器里断言）；只收 MP4 且在上传前拒绝超限", async () => {
    const tk = await requestVideoUpload(e.deps, admin, { title: "收银台话术", fileName: "a.MP4", size: 1_000_000 });
    expect(tk.videoId).toMatch(/^\d{32}$/);
    expect(tk.maxBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(e.vod.uploads).toEqual([{ title: "收银台话术", fileName: "a.MP4", fileSize: 1_000_000 }]);
    await fails(requestVideoUpload(e.deps, admin, { title: "x", fileName: "a.mov", size: 10 }), 400, "file_type_not_allowed");
    await fails(requestVideoUpload(e.deps, admin, { title: "x", fileName: "a.mp4", size: 2 * 1024 * 1024 * 1024 + 1 }), 400, "file_too_large");
    await fails(requestVideoUpload(e.deps, admin, { title: "x", fileName: "a.mp4", size: 0 }), 400, "file_too_large");
    await fails(requestVideoUpload(e.deps, admin, { title: "  ", fileName: "a.mp4", size: 10 }), 400, "invalid_input");
    expect(e.vod.uploads).toHaveLength(1);
  });
  it("VOD 凭证失败 → 503（可重试），不建课程行；无权限 403 且不调 VOD", async () => {
    e.vod.failNext.createUpload = 1;
    await fails(requestVideoUpload(e.deps, admin, { title: "x", fileName: "a.mp4", size: 10 }), 503, "vod_unavailable");
    expect(await t.db.select().from(courses)).toEqual([]);
    const bm = await e.actor("branch_manager", { brandIds: [e.org.hisense], branchIds: [e.org.bj] });
    await fails(requestVideoUpload(e.deps, bm, { title: "x", fileName: "a.mp4", size: 10 }), 403);
    expect(e.vod.uploads).toEqual([]);
  });
});

describe("创建视频课程", () => {
  it("转码完成：课程为已发布 + normal，时长回填", async () => {
    const v = e.vod.add({ status: "normal", durationSec: 754 });
    const r = await createVideoCourse(e.deps, admin, await body(v), KEY);
    expect(r.replayed).toBe(false);
    const [row] = await t.db.select().from(courses);
    expect(row).toMatchObject({ kind: "video", status: "published", vodVideoId: v, vodVideoStatus: "normal", durationSec: 754, fileKey: null, createKey: KEY, unpublishedAt: null });
    expect((await auditOf(t, "learning_course_created"))[0]!.detail).toMatchObject({ kind: "video", vodVideoId: v, vodVideoStatus: "normal" });
  });

  it("D2：转码中可建行（学员不可见），D3：转码失败建行并标 failed", async () => {
    const tr = e.vod.add({ status: "transcoding", durationSec: null });
    const bad = e.vod.add({ status: "failed", durationSec: null });
    await createVideoCourse(e.deps, admin, await body(tr), "idem-key-transcoding-1");
    await createVideoCourse(e.deps, admin, await body(bad), "idem-key-failed-000001");
    const rows = await t.db.select().from(courses).orderBy(courses.courseId);
    expect(rows.map((r) => r.vodVideoStatus)).toEqual(["transcoding", "failed"]);
  });

  it("上传没完成 → 409，不建行；视频不存在 → 400", async () => {
    const up = e.vod.add({ status: "uploading", durationSec: null });
    await fails(createVideoCourse(e.deps, admin, await body(up), KEY), 409, "video_uploading");
    await fails(createVideoCourse(e.deps, admin, await body("f".repeat(32)), KEY), 400, "video_missing");
    expect(await t.db.select().from(courses)).toEqual([]);
  });

  it("超 60 分钟 / 超 2 GB：拒绝并删除这个视频", async () => {
    const long = e.vod.add({ durationSec: 3601 });
    await fails(createVideoCourse(e.deps, admin, await body(long), KEY), 400, "video_too_large");
    expect(e.vod.deleted).toEqual([long]);
    const big = e.vod.add({ sizeBytes: 2 * 1024 * 1024 * 1024 + 1 });
    await fails(createVideoCourse(e.deps, admin, await body(big), "idem-key-0000000002"), 400, "video_too_large");
    const ok = e.vod.add({ durationSec: 3600 });
    await createVideoCourse(e.deps, admin, await body(ok), "idem-key-0000000003"); // 恰好 60 分钟可以
  });

  it("D7：同一 Idempotency-Key 提交两次只建一门课，第二次返回同一结果；不同用户的同一个键互不影响", async () => {
    const v = e.vod.add({});
    const first = await createVideoCourse(e.deps, admin, await body(v), KEY);
    const second = await createVideoCourse(e.deps, admin, await body(v), KEY);
    expect(second).toEqual({ courseId: first.courseId, replayed: true });
    expect(await t.db.select().from(courses)).toHaveLength(1);
    // 第二次的封面对象没有被占用也没有被建行：不动
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    const v2 = e.vod.add({});
    const other = await createVideoCourse(e.deps, hq, await body(v2, { brandScope: { brandIds: [e.org.hisense.toString()] }, coverKey: await cover(hq) }), KEY);
    expect(other.replayed).toBe(false);
    expect(await t.db.select().from(courses)).toHaveLength(2);
  });

  it("缺少或不合法的 Idempotency-Key → 400", async () => {
    const v = e.vod.add({});
    await fails(createVideoCourse(e.deps, admin, await body(v), ""), 400, "idempotency_key_required");
    await fails(createVideoCourse(e.deps, admin, await body(v), "short"), 400, "idempotency_key_required");
  });

  it("封面必填（G-D48）；视频 ID 形态不对 → 400；已被别的课程使用 → 409", async () => {
    const v = e.vod.add({});
    const { coverKey: _c, ...noCover } = await body(v);
    await fails(createVideoCourse(e.deps, admin, noCover, KEY), 400, "invalid_input");
    await fails(createVideoCourse(e.deps, admin, await body("not-a-video-id"), KEY), 400, "invalid_input");
    await createVideoCourse(e.deps, admin, await body(v), KEY);
    await fails(createVideoCourse(e.deps, admin, await body(v), "idem-key-0000000009"), 409, "file_already_used");
  });

  it("品牌范围规则同资料课程：hq 勾未授权品牌 403；指定品牌写品牌范围行", async () => {
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    const v = e.vod.add({});
    await fails(createVideoCourse(e.deps, hq, await body(v, { brandScope: { brandIds: [e.org.hitachi.toString()] }, coverKey: await cover(hq) }), KEY), 403, "brand_out_of_scope");
    await createVideoCourse(e.deps, hq, await body(v, { brandScope: { brandIds: [e.org.hisense.toString()] }, coverKey: await cover(hq) }), KEY);
    expect((await t.db.select().from(courseBrandScopes)).map((s) => s.brandId)).toEqual([e.org.hisense]);
  });

  it("VOD 查询失败 → 503，不建行，封面对象保留给重试", async () => {
    const v = e.vod.add({});
    const b = await body(v);
    e.vod.failNext.getVideo = 1;
    await fails(createVideoCourse(e.deps, admin, b, KEY), 503, "vod_unavailable");
    expect(await t.db.select().from(courses)).toEqual([]);
    expect(e.store.objects.has(b.coverKey)).toBe(true);
    await createVideoCourse(e.deps, admin, b, KEY); // 重试成功
    expect(await t.db.select().from(courses).where(eq(courses.vodVideoId, v))).toHaveLength(1);
  });

  it("审计写入失败 → 回滚；封面对象删除，视频留给残渣清理", async () => {
    const v = e.vod.add({});
    const b = await body(v);
    const deps = { ...e.deps, audit: { write: async () => Promise.reject(new Error("audit down")) } };
    await expect(createVideoCourse(deps, admin, b, KEY)).rejects.toThrow("audit down");
    expect(await t.db.select().from(courses)).toEqual([]);
    expect(e.store.deleted).toEqual([b.coverKey]);
    expect(e.vod.deleted).toEqual([]);
  });
});
