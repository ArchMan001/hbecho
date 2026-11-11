// g-learning-min 任务 5（G-2 / G-8，acceptance B4–B10、E4/E5 的读侧）：列表、详情与统一的可见范围。
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { AUDIENCE_LEVELS, COURSE_STATUSES, courses, learningProgress } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { LearningError } from "./errors";
import { getCourse, listCourses, loadCourse, parseListQuery } from "./read";
import { courseVisible, visibleSql } from "./visibility";

const t = useTestDb();
let e: LearningEnv;
beforeEach(async () => {
  e = await learningEnv(t);
});

const q = (s = "") => parseListQuery(new URLSearchParams(s));
const ids = async (ctx: AuthContext, query = "") => (await listCourses(e.deps, ctx, q(query))).items.map((i) => i.courseId);
const fails = async (p: Promise<unknown>, status: number, code?: string) => {
  const err = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(err).toBeInstanceOf(LearningError);
  expect((err as LearningError).status).toBe(status);
  if (code) expect((err as LearningError).code).toBe(code);
};

/** 海信 / 日立两个品牌各有总部、分公司（北京）与门店专员，外加超管。 */
const people = async () => ({
  admin: await e.actor("platform_admin"),
  hqHisense: await e.actor("hq_manager", { brandIds: [e.org.hisense] }),
  hqHitachi: await e.actor("hq_manager", { brandIds: [e.org.hitachi, e.org.york] }),
  bmHisense: await e.actor("branch_manager", { brandIds: [e.org.hisense], branchIds: [e.org.bj] }),
  bmHitachi: await e.actor("branch_manager", { brandIds: [e.org.hitachi], branchIds: [e.org.bj] }),
  staffHisense: await e.actor("store_staff", { staff: e.org.staffA }),
  staffHitachi: await e.actor("store_staff", { staff: e.org.staffB }),
});

describe("统一的可见范围：对象判断与查询条件逐项一致（D21）", () => {
  it("3 状态 × 3 级别 × 4 种品牌范围 = 36 门课，对 7 种主体，visibleSql 与 courseVisible 结论相同", async () => {
    const who = await people();
    const brandSets: bigint[][] = [[], [e.org.hisense], [e.org.hitachi], [e.org.hisense, e.org.hitachi]];
    for (const status of COURSE_STATUSES) for (const audienceLevel of AUDIENCE_LEVELS) for (const brandIds of brandSets) await e.insertCourse({ status, audienceLevel, brandIds });
    const all = await t.db.select({ id: courses.courseId }).from(courses).where(sql`${courses.title} LIKE '课程 %'`);
    expect(all).toHaveLength(36);

    const seen: Record<string, number> = {};
    for (const [name, ctx] of Object.entries(who)) {
      const bySql = new Set((await t.db.select({ id: courses.courseId }).from(courses).where(visibleSql(ctx.scope))).map((r) => r.id));
      const byObject = new Set<bigint>();
      for (const { id } of all) if (courseVisible(ctx.scope, (await loadCourse(e.deps, id))!.ref)) byObject.add(id);
      expect([...bySql].sort(), name).toEqual([...byObject].sort());
      seen[name] = bySql.size;
    }
    // 抽查几个边界：超管看全部已发布（12）；海信专员只看 all 级别的已发布且品牌相交（全部品牌 + 海信 + 海信日立 = 3）
    expect(seen.admin).toBe(12);
    expect(seen.staffHisense).toBe(3);
    expect(seen.staffHitachi).toBe(3);
    expect(seen.bmHisense).toBe(6); // 级别 all + branch_and_above 各 3
    expect(seen.hqHisense).toBe(9); // 三个级别各 3
  });
});

describe("可见范围（B4–B10）", () => {
  it("B8 / B9 / B10：适用级别与品牌取交集", async () => {
    const w = await people();
    const forAll = await e.insertCourse({ title: "全员", brandIds: [e.org.hisense] });
    const branchUp = await e.insertCourse({ title: "分公司以上", brandIds: [e.org.hisense], audienceLevel: "branch_and_above" });
    const hqUp = await e.insertCourse({ title: "总部以上", brandIds: [e.org.hisense], audienceLevel: "hq_and_above" });
    const s = (...x: bigint[]) => x.map(String).sort();

    expect(s(...(await ids(w.staffHisense)).map(BigInt))).toEqual(s(forAll));
    expect(s(...(await ids(w.bmHisense)).map(BigInt))).toEqual(s(forAll, branchUp));
    expect(s(...(await ids(w.hqHisense)).map(BigInt))).toEqual(s(forAll, branchUp, hqUp));
    expect(s(...(await ids(w.admin)).map(BigInt))).toEqual(s(forAll, branchUp, hqUp));
    // 海信 × branch_and_above：海信分公司经理可见，日立分公司经理不可见（B10）
    await fails(getCourse(e.deps, w.bmHitachi, branchUp.toString()), 403);
    expect((await getCourse(e.deps, w.bmHisense, branchUp.toString())).title).toBe("分公司以上");
    await fails(getCourse(e.deps, w.staffHisense, branchUp.toString()), 403); // B8
    await fails(getCourse(e.deps, w.bmHisense, hqUp.toString()), 403); // B9
    expect((await getCourse(e.deps, w.hqHisense, hqUp.toString())).title).toBe("总部以上");
  });

  it("全部品牌的课在任何品牌可见；指定集合只对交集可见；新增品牌立刻看到全部品牌课、看不到指定集合课（B4 / B5）", async () => {
    const w = await people();
    const forAll = await e.insertCourse({ title: "全部品牌" });
    const hisenseOnly = await e.insertCourse({ title: "仅海信", brandIds: [e.org.hisense] });
    expect(await ids(w.staffHitachi)).toEqual([forAll.toString()]);
    expect((await ids(w.staffHisense)).sort()).toEqual([forAll, hisenseOnly].map(String).sort());

    // 新增一个品牌及其门店专员（用现有板块 / 经销商造一家店）：不改任何课程数据
    const { brands, stores, mediaStaff } = await import("../../db/schema");
    const now = e.env.clock.now();
    const [b] = await t.db.insert(brands).values({ brandCode: "NEW", brandName: "新品牌", status: "active", createdAt: now, updatedAt: now });
    const newBrand = BigInt(b.insertId);
    const [existing] = await t.db.select({ sectorId: stores.sectorId, dealerId: stores.dealerId }).from(stores).limit(1);
    const [st] = await t.db.insert(stores).values({ storeCode: "S-NEW", storeName: "新品牌店", brandId: newBrand, sectorId: existing!.sectorId, dealerId: existing!.dealerId, status: "active", createdAt: now, updatedAt: now });
    const [sf] = await t.db.insert(mediaStaff).values({ storeId: BigInt(st.insertId), staffName: "新专员", phone: "13800000077", status: "active", createdAt: now, updatedAt: now });
    const fresh = await e.actor("store_staff", { staff: BigInt(sf.insertId) });
    expect(await ids(fresh)).toEqual([forAll.toString()]);
  });

  it("B6 / B7：范围外的详情是 403（不是 404、不是空页）；存在但不在范围，与不存在，是两种不同响应", async () => {
    const w = await people();
    const hitachiCourse = await e.insertCourse({ title: "日立内部课", brandIds: [e.org.hitachi] });
    await fails(getCourse(e.deps, w.staffHisense, hitachiCourse.toString()), 403);
    await fails(getCourse(e.deps, w.hqHisense, hitachiCourse.toString()), 403);
    await fails(getCourse(e.deps, w.staffHisense, "999999"), 404, "course_not_found");
    expect((await getCourse(e.deps, w.hqHitachi, hitachiCourse.toString())).title).toBe("日立内部课");
  });

  it("B7：A 品牌账号的列表与搜索拿不到 B 品牌课程，连标题都不泄露", async () => {
    const w = await people();
    await e.insertCourse({ title: "日立绝密话术", brandIds: [e.org.hitachi] });
    await e.insertCourse({ title: "海信话术", brandIds: [e.org.hisense] });
    expect(await ids(w.staffHisense, "q=日立")).toEqual([]);
    expect(await ids(w.hqHisense, "q=绝密")).toEqual([]);
    expect(await ids(w.staffHisense, "q=话术")).toHaveLength(1);
    expect(await ids(w.admin, "q=话术")).toHaveLength(2);
  });

  it("下架与归档的课不出现在列表，直链 403", async () => {
    const w = await people();
    const off = await e.insertCourse({ status: "unpublished" });
    const gone = await e.insertCourse({ status: "archived" });
    expect(await ids(w.admin)).toEqual([]);
    await fails(getCourse(e.deps, w.admin, off.toString()), 403);
    await fails(getCourse(e.deps, w.admin, gone.toString()), 403);
  });

  it("范围为空（门店专员本人绑定失效）→ 列表 403，而不是一页空列表", async () => {
    const orphan = await e.actor("store_staff"); // 没有绑定专员
    expect(orphan.scope.self).toEqual({ kind: "unresolved", reason: "no_binding" });
    await fails(listCourses(e.deps, orphan, q()), 403, "scope_empty");
  });

  it("没有 learning.read（撤权后的下一次请求）→ 403", async () => {
    const w = await people();
    const revoked = { ...w.staffHisense, capabilities: new Set<string>() };
    await fails(listCourses(e.deps, revoked, q()), 403, "capability_not_granted");
    await fails(getCourse(e.deps, revoked, "1"), 403);
  });

  it("服务身份不能读课程", async () => {
    const svc = { ...(await e.actor("platform_admin")), kind: "service" as const, actor: "service:plan-worker", userId: null, role: null };
    await fails(listCourses(e.deps, svc, q()), 403, "service_principal_forbidden");
  });

  it("策略未注册时一律拒绝（fail-closed）", async () => {
    const w = await people();
    const empty = { ...e.deps, authorizer: (await import("../access-control")).createAuthorizer({ registry: (await import("../access-control")).createRegistry() }) };
    await fails(listCourses(empty, w.admin, q()), 403, "scope_unregistered");
  });
});

describe("列表筛选与排序", () => {
  it("标题子串搜索：大小写不敏感，% 和 _ 按字面处理", async () => {
    const w = await people();
    await e.insertCourse({ title: "Excel 技巧" });
    await e.insertCourse({ title: "折扣 100% 话术" });
    await e.insertCourse({ title: "折扣 1000 话术" });
    await e.insertCourse({ title: "a_b" });
    await e.insertCourse({ title: "axb" });
    expect(await ids(w.admin, "q=excel")).toHaveLength(1);
    expect(await ids(w.admin, `q=${encodeURIComponent("100%")}`)).toHaveLength(1);
    expect(await ids(w.admin, "q=a_b")).toHaveLength(1);
  });

  it("单标签筛选；多标签参数被拒（C4）", async () => {
    const w = await people();
    const safe = await e.insertTag("安全");
    const newbie = await e.insertTag("新人");
    const c1 = await e.insertCourse({ tagIds: [safe] });
    const c2 = await e.insertCourse({ tagIds: [safe, newbie] });
    await e.insertCourse({});
    expect((await ids(w.admin, `tag=${safe}`)).sort()).toEqual([c1, c2].map(String).sort());
    expect(await ids(w.admin, `tag=${newbie}`)).toEqual([c2.toString()]);
    expect(() => q(`tag=${safe}&tag=${newbie}`)).toThrow(/单个标签/);
    const item = (await listCourses(e.deps, w.admin, q(`tag=${newbie}`))).items[0]!;
    expect(item.tags.map((x) => x.name)).toEqual(["安全", "新人"]); // 标签展示的是课程全部标签，不只是筛选项
  });

  it("E4 / E5：在学标记只看本人的进度；inProgress 筛选只返回有进度的课程", async () => {
    const w = await people();
    const a = await e.insertCourse({ title: "有进度" });
    await e.insertCourse({ title: "没进度" });
    const learned = new Date("2026-11-10T08:30:00.000Z");
    await t.db.insert(learningProgress).values({ userId: w.staffHisense.userId!, courseId: a, positionSec: 40, firstLearnedAt: learned, lastLearnedAt: learned });
    // 别人的进度不影响我
    await t.db.insert(learningProgress).values({ userId: w.bmHisense.userId!, courseId: (await e.insertCourse({ title: "别人学的" })), firstLearnedAt: learned, lastLearnedAt: learned });

    const mine = (await listCourses(e.deps, w.staffHisense, q())).items;
    expect(mine.find((i) => i.title === "有进度")).toMatchObject({ inProgress: true, lastLearnedAt: learned.toISOString() });
    expect(mine.find((i) => i.title === "没进度")).toMatchObject({ inProgress: false, lastLearnedAt: null });
    expect(mine.find((i) => i.title === "别人学的")).toMatchObject({ inProgress: false });
    const only = (await listCourses(e.deps, w.staffHisense, q("inProgress=1"))).items;
    expect(only.map((i) => i.title)).toEqual(["有进度"]);
    // 筛选与搜索可以叠加
    expect(await ids(w.staffHisense, "inProgress=true&q=没")).toEqual([]);
  });

  it("学员只看可播：转码中和转码失败的视频课不出现，转码完成的出现", async () => {
    const w = await people();
    const vid = (status: string, title: string) => e.insertCourse({ title, kind: "video", vodVideoId: `vod-${status}`, vodVideoStatus: status, coverKey: `cover/${status}.jpg`, fileKey: null, fileMime: null, fileSize: null });
    await vid("normal", "可播");
    await vid("transcoding", "转码中");
    await vid("failed", "失败");
    await vid("uploading", "上传中");
    await e.insertCourse({ title: "资料" });
    expect((await listCourses(e.deps, w.admin, q())).items.map((i) => i.title).sort()).toEqual(["可播", "资料"]);
  });

  it("按更新时间倒序分页，hasMore 正确", async () => {
    const w = await people();
    for (let i = 1; i <= 5; i++) {
      e.env.clock.advance(1000);
      await e.insertCourse({ title: `第${i}门`, updatedAt: e.env.clock.now() });
    }
    const p1 = await listCourses(e.deps, w.admin, q("limit=2"));
    expect(p1.items.map((i) => i.title)).toEqual(["第5门", "第4门"]);
    expect(p1.hasMore).toBe(true);
    const p3 = await listCourses(e.deps, w.admin, q("limit=2&offset=4"));
    expect(p3.items.map((i) => i.title)).toEqual(["第1门"]);
    expect(p3.hasMore).toBe(false);
  });

  it("封面：有封面给短期签名地址，没有给 null；响应里没有对象 key", async () => {
    const w = await people();
    await e.insertCourse({ title: "有封面", coverKey: "cover/11111111-1111-1111-1111-111111111111.png" });
    await e.insertCourse({ title: "无封面" });
    const items = (await listCourses(e.deps, w.admin, q())).items;
    expect(items.find((i) => i.title === "有封面")!.coverUrl).toContain("cover/11111111");
    expect(items.find((i) => i.title === "无封面")!.coverUrl).toBeNull();
    expect(e.store.signedGet.map((s) => s.ttlSeconds)).toEqual([300]);
    expect(JSON.stringify(items)).not.toContain("doc/0000");
  });
});

describe("详情", () => {
  it("带本人续播位置、上传者姓名与标签；不暴露文件 key", async () => {
    const w = await people();
    const tag = await e.insertTag("安全");
    const id = await e.insertCourse({ title: "详情课", description: "简介", tagIds: [tag], fileSize: 2048 });
    const t0 = new Date("2026-11-10T08:30:00.000Z");
    await t.db.insert(learningProgress).values({ userId: w.staffHisense.userId!, courseId: id, positionSec: 40, firstLearnedAt: t0, lastLearnedAt: t0 });
    const d = await getCourse(e.deps, w.staffHisense, id.toString());
    expect(d).toMatchObject({ courseId: id.toString(), title: "详情课", description: "简介", kind: "document", fileMime: "application/pdf", fileSize: 2048, inProgress: true, positionSec: 40, brandScope: "all", audienceLevel: "all" });
    expect(d.tags.map((x) => x.name)).toEqual(["安全"]);
    expect(d.createdByName).toBe("测试用户");
    expect(JSON.stringify(d)).not.toContain("00000000-0000-0000-0000");
    const other = await getCourse(e.deps, w.bmHisense, id.toString());
    expect(other).toMatchObject({ inProgress: false, positionSec: 0 });
  });

  it("非法 ID 400", async () => {
    const w = await people();
    await fails(getCourse(e.deps, w.admin, "abc"), 400, "invalid_id");
    await fails(getCourse(e.deps, w.admin, "0"), 400, "invalid_id");
  });
});
