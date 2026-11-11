// g-learning-min 任务 7（G-7 / G-8，acceptance E1–E6）：进度上报与续播；以及 Route Handler 的来源 / 认证 / 状态映射。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { fails, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { learningProgress } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { createProgressHandler } from "./http";
import { unpublishCourse } from "./manage";
import { getPlayback } from "./playback";
import { MAX_DELTA_SEC, reportProgress } from "./progress";
import { getCourse, listCourses, parseListQuery } from "./read";

const t = useTestDb();
let e: LearningEnv;
let staff: AuthContext;
beforeEach(async () => {
  e = await learningEnv(t);
  staff = await e.actor("store_staff", { staff: e.org.staffA });
});
const video = (over: Record<string, unknown> = {}) =>
  e.insertCourse({ kind: "video", vodVideoId: e.vod.add({}), vodVideoStatus: "normal", durationSec: 600, fileKey: null, fileMime: null, fileSize: null, ...over });
const report = (courseId: bigint, positionSec: number, deltaWatchedSec = 0, started = false, ctx = staff) => reportProgress(e.deps, ctx, { courseId: courseId.toString(), positionSec, deltaWatchedSec, started });
const rows = () => t.db.select().from(learningProgress);

describe("视频进度", () => {
  it("E1 / E3：同一用户同一课程只有一行；位置取最后一次；首次时间不变、最近时间推进", async () => {
    const id = await video();
    await report(id, 40, 15, true);
    const first = (await rows())[0]!;
    e.env.clock.advance(15_000);
    await report(id, 55, 15);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ positionSec: 55, watchedSec: 30, playCount: 1 });
    expect(all[0]!.firstLearnedAt).toEqual(first.firstLearnedAt);
    expect(all[0]!.lastLearnedAt.getTime()).toBe(first.lastLearnedAt.getTime() + 15_000);
    expect((await getPlayback(e.deps, staff, id.toString()))).toMatchObject({ positionSec: 55 });
  });

  it("E2：已 40 秒，上报 0 秒 → 变成 0 秒（没有隐藏的回退保护）", async () => {
    const id = await video();
    await report(id, 40, 5);
    await report(id, 0, 5);
    expect((await rows())[0]!.positionSec).toBe(0);
    expect(await getPlayback(e.deps, staff, id.toString())).toMatchObject({ positionSec: 0 });
  });

  it("E6：单次增量 600 秒只计 60 秒，位置照常更新；超出片长的位置截断到片长", async () => {
    const id = await video({ durationSec: 100 });
    await report(id, 90, 600);
    expect((await rows())[0]).toMatchObject({ watchedSec: MAX_DELTA_SEC, positionSec: 90 });
    await report(id, 5000, 0);
    expect((await rows())[0]!.positionSec).toBe(100);
  });

  it("播放次数只在 started 时 +1：续播重新打开计 1，心跳与暂停后继续不计", async () => {
    const id = await video();
    await report(id, 0, 0, true);
    await report(id, 15, 15);
    await report(id, 30, 15);
    await report(id, 30, 0, true); // 关闭后重新打开并起播
    expect((await rows())[0]!.playCount).toBe(2);
  });

  it("换设备后读到同一位置：进度属于 User，不属于设备", async () => {
    const id = await video();
    await report(id, 77, 10);
    const sameUserOtherDevice: AuthContext = { ...staff, sessionId: "another-device" };
    expect(await getPlayback(e.deps, sameUserOtherDevice, id.toString())).toMatchObject({ positionSec: 77 });
    const detail = await getCourse(e.deps, sameUserOtherDevice, id.toString());
    expect(detail).toMatchObject({ inProgress: true, positionSec: 77 });
  });

  it("并发上报不产生重复行，累计值不丢（逐个 await 模拟，唯一键兜底）", async () => {
    const id = await video();
    for (let i = 0; i < 5; i++) await report(id, i, 10);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]!.watchedSec).toBe(50);
  });

  it("E4：上报后列表出现「在学」与最近学习时间", async () => {
    const id = await video();
    await report(id, 10, 10, true);
    const item = (await listCourses(e.deps, staff, parseListQuery(new URLSearchParams("inProgress=1")))).items[0]!;
    expect(item).toMatchObject({ courseId: id.toString(), inProgress: true, lastLearnedAt: e.env.clock.now().toISOString() });
  });
});

describe("资料进度", () => {
  it("只记首末时间与打开次数；不计观看时长，位置恒为 0", async () => {
    const id = await e.insertCourse({});
    await report(id, 999, 500, true);
    e.env.clock.advance(60_000);
    await report(id, 5, 5, true);
    const [r] = await rows();
    expect(r).toMatchObject({ positionSec: 0, watchedSec: 0, playCount: 2 });
    expect(r!.lastLearnedAt.getTime()).toBe(r!.firstLearnedAt.getTime() + 60_000);
  });
});

describe("授权与输入", () => {
  it("范围外 / 下架后 / 无权限 → 403，不写进度", async () => {
    const hitachi = await e.actor("store_staff", { staff: e.org.staffB });
    const id = await video({ brandIds: [e.org.hisense] });
    await fails(report(id, 1, 1, false, hitachi), 403);
    await report(id, 1, 1);
    const admin = await e.actor("platform_admin");
    await unpublishCourse(e.deps, admin, id.toString());
    await fails(report(id, 2, 2), 403);
    await fails(report(id, 2, 2, false, { ...staff, capabilities: new Set() }), 403);
    expect((await rows())[0]).toMatchObject({ positionSec: 1, watchedSec: 1 });
  });

  it("服务身份 403；课程不存在 404；非法数值 400", async () => {
    const id = await video();
    await fails(reportProgress(e.deps, { ...staff, kind: "service", actor: "service:plan-worker", userId: null, role: null }, { courseId: id.toString(), positionSec: 1 }), 403);
    await fails(report(99999n, 1), 404);
    for (const bad of [{ positionSec: -1 }, { positionSec: 1.5 }, { positionSec: Number.NaN }, { deltaWatchedSec: -3 }, { started: "yes" }, { courseId: "abc" }, { extra: 1 }]) {
      await fails(reportProgress(e.deps, staff, { courseId: id.toString(), positionSec: 1, ...bad }), 400);
    }
    expect(await rows()).toEqual([]);
  });
});

describe("Route Handler", () => {
  const ORIGIN = "https://hbecho.example";
  const mk = (auth: Parameters<typeof createProgressHandler>[0]["authenticate"]) => createProgressHandler({ authenticate: auth, deps: () => e.deps, trustedOrigins: [ORIGIN] });
  const post = (h: ReturnType<typeof mk>, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    h(new Request("https://hbecho.example/api/learning/progress", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));

  it("受信来源 + 已登录：写进度并返回位置；缺 Origin 或来源不受信 → 403，不查登录也不写库", async () => {
    const id = await video();
    let authCalls = 0;
    const h = mk(async () => (authCalls++, { ok: true, ctx: staff }));
    const res = await post(h, { courseId: id.toString(), positionSec: 33, deltaWatchedSec: 10, started: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ positionSec: 33 });
    expect((await rows())[0]).toMatchObject({ positionSec: 33, watchedSec: 10 });
    expect((await post(h, { courseId: id.toString(), positionSec: 1 }, {})).status).toBe(403);
    expect((await post(h, { courseId: id.toString(), positionSec: 1 }, { origin: "https://evil.example" })).status).toBe(403);
    expect(authCalls).toBe(1);
    expect((await rows())[0]!.positionSec).toBe(33);
  });

  it("状态映射：未登录 401、登录库不可用 503、坏 JSON / 过大 400、非 POST 405、LearningError 用它自己的状态", async () => {
    const id = await video();
    expect((await post(mk(async () => ({ ok: false, kind: "unauthenticated" })), {})).status).toBe(401);
    expect((await post(mk(async () => ({ ok: false, kind: "unavailable" })), {})).status).toBe(503);
    const h = mk(async () => ({ ok: true, ctx: staff }));
    expect((await post(h, "{oops")).status).toBe(400);
    expect((await post(h, "x".repeat(3000))).status).toBe(400);
    expect((await h(new Request("https://hbecho.example/api/learning/progress", { method: "GET" }))).status).toBe(405);
    expect((await post(h, { courseId: "99999", positionSec: 1 })).status).toBe(404);
    expect((await post(h, { courseId: id.toString(), positionSec: -1 })).status).toBe(400);
    expect(await t.db.select().from(learningProgress).where(eq(learningProgress.courseId, id))).toEqual([]);
  });
});
