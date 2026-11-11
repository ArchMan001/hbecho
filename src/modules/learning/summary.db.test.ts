// g-learning-min 任务 10（G-11，acceptance G1–G7、I5）：总部汇总。
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { fails, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { courses, learningProgress } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { eq } from "drizzle-orm";
import { unpublishCourse } from "./manage";
import { getSummary } from "./summary";

const t = useTestDb();
let e: LearningEnv;
let admin: AuthContext;
beforeEach(async () => {
  e = await learningEnv(t);
  admin = await e.actor("platform_admin");
});
const video = (over: Record<string, unknown> = {}) =>
  e.insertCourse({ kind: "video", vodVideoId: e.vod.add({}), vodVideoStatus: "normal", durationSec: 600, fileKey: null, fileMime: null, fileSize: null, ...over });
const learn = (u: AuthContext, courseId: bigint, watched = 0, plays = 0) =>
  t.db.insert(learningProgress).values({ userId: u.userId!, courseId, watchedSec: watched, playCount: plays, firstLearnedAt: e.env.clock.now(), lastLearnedAt: e.env.clock.now() });

describe("授权", () => {
  it("G1：branch_manager / store_staff / 服务身份 403；range 只接受 all", async () => {
    const bm = await e.actor("branch_manager", { brandIds: [e.org.hisense], branchIds: [e.org.bj] });
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    await fails(getSummary(e.deps, bm), 403);
    await fails(getSummary(e.deps, staff), 403);
    await fails(getSummary(e.deps, { ...admin, kind: "service", actor: "service:plan-worker", userId: null, role: null }), 403);
    await fails(getSummary(e.deps, admin, { range: "7d" }), 400, "range_unsupported"); // G4：拒绝，不静默忽略
    expect((await getSummary(e.deps, admin, { range: "all" })).courseCount).toBe(0);
  });
});

describe("口径", () => {
  it("四项均为 0 时显示 0（不是缺省）", async () => {
    expect(await getSummary(e.deps, admin)).toMatchObject({ courseCount: 0, learnerCount: 0, watchedSeconds: 0, playCount: 0, mode: "merged", brandId: null });
  });

  it("G2：同一人学两门「全部品牌」课，学习人数计 1；时长与次数只算视频，资料只让人数 +1", async () => {
    const u = await e.actor("store_staff", { staff: e.org.staffA });
    const v1 = await video();
    const v2 = await video();
    const doc = await e.insertCourse({});
    await learn(u, v1, 100, 2);
    await learn(u, v2, 50, 1);
    await learn(u, doc, 999, 9); // 资料的时长 / 次数不计
    const s = await getSummary(e.deps, admin);
    expect(s).toMatchObject({ courseCount: 3, learnerCount: 1, watchedSeconds: 150, playCount: 3 });
  });

  it("G3：响应没有任何个人标识，也没有下钻字段", async () => {
    const u = await e.actor("store_staff", { staff: e.org.staffA });
    await learn(u, await video(), 10, 1);
    const s = await getSummary(e.deps, admin);
    expect(Object.keys(s).sort()).toEqual(["brandId", "brandOptions", "courseCount", "learnerCount", "mode", "playCount", "watchedSeconds"]);
    expect(JSON.stringify(s)).not.toContain(u.actor);
  });

  it("G6：下架一门有进度的课程，学习人数与累计时长不降，课程数 −1；I5：归档同样", async () => {
    const u = await e.actor("store_staff", { staff: e.org.staffA });
    const a = await video();
    const b = await video();
    await learn(u, a, 100, 1);
    await learn(await e.actor("store_staff", { staff: e.org.staffB }), b, 40, 1);
    const before = await getSummary(e.deps, admin);
    expect(before).toMatchObject({ courseCount: 2, learnerCount: 2, watchedSeconds: 140 });
    await unpublishCourse(e.deps, admin, a.toString());
    expect(await getSummary(e.deps, admin)).toMatchObject({ courseCount: 1, learnerCount: 2, watchedSeconds: 140, playCount: 2 });
    await t.db.update(courses).set({ status: "archived" }).where(eq(courses.courseId, a));
    expect(await getSummary(e.deps, admin)).toMatchObject({ courseCount: 1, learnerCount: 2, watchedSeconds: 140 });
  });

  it("G7：转码中 / 失败的视频课不计入课程数；转码失败视频上的进度不计", async () => {
    const u = await e.actor("store_staff", { staff: e.org.staffA });
    await video();
    await video({ vodVideoStatus: "transcoding", durationSec: null });
    const bad = await video({ vodVideoStatus: "failed" });
    await learn(u, bad, 500, 5);
    expect(await getSummary(e.deps, admin)).toMatchObject({ courseCount: 1, learnerCount: 0, watchedSeconds: 0, playCount: 0 });
  });
});

describe("品牌范围与切换", () => {
  it("hq 只汇总自己授权品牌的课（含全部品牌课、含交集课）；切到未授权品牌 403", async () => {
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    const u = await e.actor("store_staff", { staff: e.org.staffA });
    const ownV = await video({ brandIds: [e.org.hisense] });
    const shared = await video({ brandIds: [e.org.hisense, e.org.hitachi] });
    const hitachiV = await video({ brandIds: [e.org.hitachi] });
    const allV = await video();
    for (const c of [ownV, shared, hitachiV, allV]) await learn(u, c, 10, 1);
    const s = await getSummary(e.deps, hq);
    expect(s).toMatchObject({ courseCount: 3, watchedSeconds: 30, playCount: 3, mode: "merged" });
    expect(s.brandOptions.map((b) => b.name)).toEqual(["海信"]);
    await fails(getSummary(e.deps, hq, { brandId: e.org.hitachi.toString() }), 403, "brand_out_of_scope");
  });

  it("多品牌：默认合计（按人去重），可切换单品牌", async () => {
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense, e.org.hitachi] });
    const u = await e.actor("store_staff", { staff: e.org.staffA });
    const h = await video({ brandIds: [e.org.hisense] });
    const d = await video({ brandIds: [e.org.hitachi] });
    await learn(u, h, 30, 1);
    await learn(u, d, 20, 1);
    expect(await getSummary(e.deps, hq)).toMatchObject({ courseCount: 2, learnerCount: 1, watchedSeconds: 50, mode: "merged" }); // 同一人只计 1
    const one = await getSummary(e.deps, hq, { brandId: e.org.hitachi.toString() });
    expect(one).toMatchObject({ courseCount: 1, learnerCount: 1, watchedSeconds: 20, mode: "brand", brandId: e.org.hitachi.toString() });
    expect(one.brandOptions.map((b) => b.name)).toEqual(["海信", "日立"]);
  });

  it("超管看全部品牌，可切单品牌；品牌不存在 400", async () => {
    await video({ brandIds: [e.org.york] });
    await video({ brandIds: [e.org.hisense] });
    expect((await getSummary(e.deps, admin)).courseCount).toBe(2);
    expect((await getSummary(e.deps, admin, { brandId: e.org.york.toString() })).courseCount).toBe(1);
    await fails(getSummary(e.deps, admin, { brandId: "999999" }), 400, "brand_not_found");
    await fails(getSummary(e.deps, admin, { brandId: "abc" }), 400, "invalid_id");
  });

  it("查询失败 → 503，不返回部分数字", async () => {
    const broken = { ...e.deps, db: new Proxy(e.deps.db, { get: (target, prop) => (prop === "select" ? () => { throw new Error("db down"); } : Reflect.get(target, prop)) }) } as typeof e.deps;
    await fails(getSummary(broken, admin), 503, "summary_unavailable");
  });
});
