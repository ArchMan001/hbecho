// g-learning-min 任务 6（G-5 / G-6，acceptance D4–D6、F7）：播放凭证与资料预览。
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, fails, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { learningProgress } from "../../db/schema";
import { unpublishCourse } from "./manage";
import { getPlayback } from "./playback";

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
  it("返回短期签名地址（不带附件名），不产生下载审计", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({});
    const p = await getPlayback(e.deps, staff, id.toString());
    expect(p).toMatchObject({ state: "ready", kind: "document", mime: "application/pdf", url: expect.stringContaining("doc/") });
    expect(e.store.signedGet.at(-1)).toMatchObject({ ttlSeconds: 300 });
    expect(e.store.signedGet.at(-1)).not.toHaveProperty("downloadName");
    expect(await auditOf(t, "egress.learning_download")).toEqual([]);
  });
  it("范围外的资料不签发预览地址", async () => {
    const hitachi = await e.actor("store_staff", { staff: e.org.staffB });
    const id = await e.insertCourse({ brandIds: [e.org.hisense] });
    await fails(getPlayback(e.deps, hitachi, id.toString()), 403);
    expect(e.store.signedGet).toEqual([]);
  });
});
