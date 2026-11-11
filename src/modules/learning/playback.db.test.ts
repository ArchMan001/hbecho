// g-learning-min 任务 6（G-5 / G-6，acceptance D4–D6、F7）：播放凭证与资料预览。
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, fails, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { learningProgress } from "../../db/schema";
import { unpublishCourse } from "./manage";
import { createPreviewHandler } from "./http";
import { getPlayback, openDocumentPreview } from "./playback";

const t = useTestDb();
let e: LearningEnv;
beforeEach(async () => {
  e = await learningEnv(t);
});
const video = (over: Record<string, unknown> = {}) =>
  e.insertCourse({ kind: "video", vodVideoId: e.vod.add({}), vodVideoStatus: "normal", durationSec: 600, fileKey: null, fileMime: null, fileSize: null, ...over });

describe("视频", () => {
  it("normal：返回播放凭证与续播位置；响应里没有原始文件地址；每次现取不缓存", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await video();
    await t.db.insert(learningProgress).values({ userId: staff.userId!, courseId: id, positionSec: 120, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });
    const p = await getPlayback(e.deps, staff, id.toString());
    expect(p).toMatchObject({ state: "ready", kind: "video", playAuth: expect.stringContaining("play-auth-for-"), durationSec: 600, positionSec: 120 });
    expect(JSON.stringify(p)).not.toMatch(/https?:|\.mp4|\.m3u8/i); // D4
    await getPlayback(e.deps, staff, id.toString());
    expect(e.vod.playAuthCalls).toHaveLength(2);
  });

  it("续播位置超出（替换后变短的）新时长时截断到片长内", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await video({ durationSec: 100 });
    await t.db.insert(learningProgress).values({ userId: staff.userId!, courseId: id, positionSec: 500, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });
    expect(await getPlayback(e.deps, staff, id.toString())).toMatchObject({ positionSec: 100 });
  });

  it("D5：范围外 / 下架 / 归档 / 无权限 → 403，且没有调用 VOD", async () => {
    const hitachi = await e.actor("store_staff", { staff: e.org.staffB });
    const id = await video({ brandIds: [e.org.hisense] });
    await fails(getPlayback(e.deps, hitachi, id.toString()), 403);
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    await fails(getPlayback(e.deps, { ...staff, capabilities: new Set() }, id.toString()), 403);
    const admin = await e.actor("platform_admin");
    await unpublishCourse(e.deps, admin, id.toString());
    await fails(getPlayback(e.deps, staff, id.toString()), 403);
    const gone = await video({ status: "archived" });
    await fails(getPlayback(e.deps, admin, gone.toString()), 403);
    expect(e.vod.playAuthCalls).toEqual([]);
  });

  it("转码中 → processing（调用方回 202），不给凭证；失败 → 409；两者与 403 是不同的响应", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const tr = await video({ vodVideoStatus: "transcoding", durationSec: null });
    const bad = await video({ vodVideoStatus: "failed" });
    expect(await getPlayback(e.deps, staff, tr.toString())).toEqual({ state: "processing", kind: "video", vodVideoStatus: "transcoding" });
    await fails(getPlayback(e.deps, staff, bad.toString()), 409, "video_failed");
    expect(e.vod.playAuthCalls).toEqual([]);
  });

  it("D6：VOD 抛错 → 503（可重试），失败不缓存，下一次重新取", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await video();
    e.vod.failNext.getPlayAuth = 1;
    await fails(getPlayback(e.deps, staff, id.toString()), 503, "vod_unavailable");
    expect(await getPlayback(e.deps, staff, id.toString())).toMatchObject({ state: "ready" });
  });

  it("不存在的课 404；没有 learning.read 的人探不到存在性（403）", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    await fails(getPlayback(e.deps, staff, "99999"), 404);
    await fails(getPlayback(e.deps, { ...staff, capabilities: new Set() }, "99999"), 403);
  });
});

describe("资料预览（F7）", () => {
  const upload = (key: string) => e.store.upload(key, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), "application/pdf");
  it("getPlayback 对资料只给类型与大小，不给任何存储地址；预览走服务端转发，不产生下载审计", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({ fileSize: 6 });
    const p = await getPlayback(e.deps, staff, id.toString());
    expect(p).toEqual({ state: "ready", kind: "document", mime: "application/pdf", fileSize: 6 });
    expect(e.store.signedGet).toEqual([]);
    expect(await auditOf(t, "egress.learning_download")).toEqual([]);
  });
  it("openDocumentPreview：范围内流式返回，类型取库里校验过的 MIME；不写下载审计", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const key = "doc/00000000-0000-0000-0000-0000000000a1.pdf";
    upload(key);
    const id = await e.insertCourse({ fileKey: key });
    const f = await openDocumentPreview(e.deps, staff, id.toString());
    expect(f).toMatchObject({ size: 6, mime: "application/pdf" });
    expect(Buffer.from(await new Response(f.body).arrayBuffer()).toString()).toBe("%PDF-1");
    expect(await auditOf(t, "egress.learning_download")).toEqual([]);
  });
  it("范围外 / 下架 / 无权限 403 且不读存储；视频没有预览 409；对象丢失 / 存储故障 503", async () => {
    const hitachi = await e.actor("store_staff", { staff: e.org.staffB });
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const key = "doc/00000000-0000-0000-0000-0000000000a2.pdf";
    upload(key);
    const id = await e.insertCourse({ fileKey: key, brandIds: [e.org.hisense] });
    let reads = 0;
    const getObject = e.store.getObject.bind(e.store);
    e.store.getObject = async (k: string) => (reads++, getObject(k));
    await fails(openDocumentPreview(e.deps, hitachi, id.toString()), 403);
    await fails(openDocumentPreview(e.deps, { ...staff, capabilities: new Set() }, id.toString()), 403);
    const admin = await e.actor("platform_admin");
    const off = await e.insertCourse({ status: "unpublished" });
    await fails(openDocumentPreview(e.deps, admin, off.toString()), 403);
    expect(reads).toBe(0);
    await fails(openDocumentPreview(e.deps, staff, "99999"), 404);
    const vid = await video();
    await fails(openDocumentPreview(e.deps, staff, vid.toString()), 409, "not_a_document");
    const lost = await e.insertCourse({ fileKey: "doc/00000000-0000-0000-0000-0000000000a3.pdf" }); // 对象不在桶里
    await fails(openDocumentPreview(e.deps, staff, lost.toString()), 503, "preview_unavailable");
    e.store.failGetObject = true;
    await fails(openDocumentPreview(e.deps, staff, id.toString()), 503, "preview_unavailable");
  });
  it("Route Handler：内联、禁嗅探、不缓存；未登录 401；非 GET 405；范围外 403", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const key = "doc/00000000-0000-0000-0000-0000000000a4.pdf";
    upload(key);
    const id = await e.insertCourse({ fileKey: key });
    const h = createPreviewHandler({ authenticate: async () => ({ ok: true, ctx: staff }), deps: () => e.deps });
    const res = await h(new Request("https://x.test/api/learning/courses/1/preview"), id.toString());
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({ "content-type": "application/pdf", "content-disposition": "inline", "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-length": "6" });
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1");
    expect((await createPreviewHandler({ authenticate: async () => ({ ok: false, kind: "unauthenticated" }), deps: () => e.deps })(new Request("https://x.test/p"), id.toString())).status).toBe(401);
    expect((await h(new Request("https://x.test/p", { method: "POST" }), id.toString())).status).toBe(405);
    const hitachi = await e.actor("store_staff", { staff: e.org.staffB });
    const hh = createPreviewHandler({ authenticate: async () => ({ ok: true, ctx: hitachi }), deps: () => e.deps });
    const other = await e.insertCourse({ fileKey: "doc/00000000-0000-0000-0000-0000000000a5.pdf", brandIds: [e.org.hisense] });
    expect((await hh(new Request("https://x.test/p"), other.toString())).status).toBe(403);
  });
});
