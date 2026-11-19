// f-video-square 任务 5（acceptance A1、A3、A5–A13、A15、A16）：真实 MySQL 8.4 上的读口。
import { describe, expect, it } from "vitest";
import { squareBrandPolicies } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { squareEnv, type SquareEnv } from "../../../tests/harness/square";
import { get, list, options, type SquareCard } from "./browse";
import { isSquareError } from "./errors";
import { parseSquareFilter, type RawFilter, type SquareFilter } from "./filter";
import type { AuthContext } from "../access-control";

const t = useTestDb();
const f = (raw: RawFilter = {}): SquareFilter => parseSquareFilter({ kind: "all", ...raw });
const DAY = 86_400_000;
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return isSquareError(e) ? `${e.kind}:${e.code}` : "other";
  }
  return "ok";
};
const titles = (xs: SquareCard[]): string[] => xs.map((x) => x.title);
const ownPolicy = (w: SquareEnv, brandId: bigint) => t.db.insert(squareBrandPolicies).values({ brandId, viewMode: "own", updatedByActor: "user:1", createdAt: w.env.clock.now(), updatedAt: w.env.clock.now() });

describe("授权与范围（R1）", () => {
  it("没有 square.read、服务身份、空范围都被拒绝，且不返回计数", async () => {
    const w = await squareEnv(t);
    const admin = await w.actor("platform_admin");
    const noCap: AuthContext = { ...admin, capabilities: new Set() };
    expect(await code(list(w.deps, noCap, f()))).toBe("auth:capability_not_granted");
    expect(await code(options(w.deps, noCap))).toBe("auth:capability_not_granted");
    expect(await code(get(w.deps, noCap, 1n))).toBe("auth:capability_not_granted");
    const svc: AuthContext = { kind: "service", actor: "service:sync-worker", userId: null, role: null, capabilities: new Set(["square.read"]), scope: admin.scope, sessionId: null };
    expect(await code(list(w.deps, svc, f()))).toBe("auth:service_principal_forbidden");
    const empty = await w.actor("hq_manager", { brandIds: [] });
    expect(await code(list(w.deps, empty, f()))).toBe("auth:scope_empty");
  });
  it("四个角色看到的字段集合完全相同", async () => {
    const w = await squareEnv(t);
    await w.addWork(await w.addAccount({ store: "A" }), { like: 80 });
    const shape = async (ctx: AuthContext) => Object.keys((await list(w.deps, ctx, f())).items[0]!).sort();
    const shapes = [
      await shape(await w.actor("platform_admin")),
      await shape(await w.actor("hq_manager", { brandIds: [w.org.hisense] })),
      await shape(await w.actor("branch_manager", { brandIds: [w.org.hisense], branchIds: [w.org.bj] })),
      await shape(await w.actor("store_staff", { brandIds: [w.org.hisense], staff: w.org.staffA })),
    ];
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });
});

describe("展示的作品集合（R3）", () => {
  it("点赞 50 不出现、51 出现；0 与非 value 状态都不出现，也不被当成 0", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    await w.addWork(a, { title: "p50", like: 50 });
    await w.addWork(a, { title: "p51", like: 51 });
    await w.addWork(a, { title: "p0", like: 0 });
    for (const likeState of ["missing", "explicit_null", "invalid", "unsupported"] as const) await w.addWork(a, { title: `s-${likeState}`, likeState });
    const admin = await w.actor("platform_admin");
    expect(titles((await list(w.deps, admin, f())).items)).toEqual(["p51"]);
  });
  it("非 active 内容、当前快照未终态、unknown 类型、外部账号、已释放名额的账号都不出现", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    await w.addWork(a, { title: "ok" });
    await w.addWork(a, { title: "gone", contentStatus: "deleted" });
    await w.addWork(a, { title: "off", contentStatus: "unavailable" });
    await w.addWork(a, { title: "building", snapshot: "building" });
    await w.addWork(a, { title: "unknown-kind", kind: "unknown" });
    await w.addWork(await w.addAccount({ store: "A", platform: "kuaishou", assignment: "released" }), { title: "released" });
    await w.addWork(await w.addAccount({ platform: "xiaohongshu", assignment: "external" }), { title: "external" });
    const admin = await w.actor("platform_admin");
    expect(titles((await list(w.deps, admin, f())).items)).toEqual(["ok"]);
  });
  it("视频 = video；图文 = image + text；默认只看视频", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    await w.addWork(a, { title: "v", kind: "video", like: 90 });
    await w.addWork(a, { title: "i", kind: "image", like: 80 });
    await w.addWork(a, { title: "x", kind: "text", like: 70 });
    const admin = await w.actor("platform_admin");
    expect(titles((await list(w.deps, admin, parseSquareFilter({}))).items)).toEqual(["v"]);
    expect(titles((await list(w.deps, admin, f({ kind: "image" }))).items)).toEqual(["i", "x"]);
    expect(titles((await list(w.deps, admin, f())).items)).toEqual(["v", "i", "x"]);
  });
});

describe("观看品牌范围（R2.3–R2.4）", () => {
  async function world() {
    const w = await squareEnv(t);
    await w.addWork(await w.addAccount({ store: "A" }), { title: "海信北京" });
    await w.addWork(await w.addAccount({ store: "C" }), { title: "海信上海" });
    await w.addWork(await w.addAccount({ store: "B" }), { title: "日立北京" });
    return w;
  }
  it("默认看全部品牌；本品牌策略为 own 时只看本品牌，且别的品牌不出选项、不出计数", async () => {
    const w = await world();
    const hq = await w.actor("hq_manager", { brandIds: [w.org.hisense] });
    expect((await list(w.deps, hq, f())).total).toBe(3);
    expect((await options(w.deps, hq)).brands.map((b) => b.name).sort()).toEqual(["日立", "海信"]);
    await ownPolicy(w, w.org.hisense);
    const own = await list(w.deps, hq, f());
    expect(titles(own.items).sort()).toEqual(["海信上海", "海信北京"]);
    expect(own.total).toBe(2);
    expect((await options(w.deps, hq)).brands.map((b) => b.name)).toEqual(["海信"]);
    expect(await code(list(w.deps, hq, f({ brand: String(w.org.hitachi) })))).toBe("input:invalid_filter");
  });
  it("超管不受策略影响", async () => {
    const w = await world();
    for (const b of [w.org.hisense, w.org.hitachi, w.org.york]) await ownPolicy(w, b);
    expect((await list(w.deps, await w.actor("platform_admin"), f())).total).toBe(3);
  });
  it("多品牌观看者：一个 own 一个无行 → 看全部", async () => {
    const w = await world();
    await ownPolicy(w, w.org.hisense);
    const hq = await w.actor("hq_manager", { brandIds: [w.org.hisense, w.org.hitachi] });
    expect((await list(w.deps, hq, f())).total).toBe(3);
  });
});

describe("筛选与搜索（R4）", () => {
  it("平台、品牌、分公司各取一个值", async () => {
    const w = await squareEnv(t);
    await w.addWork(await w.addAccount({ store: "A", platform: "douyin" }), { title: "抖音海信北京" });
    await w.addWork(await w.addAccount({ store: "A", platform: "xiaohongshu" }), { title: "小红书海信北京" });
    await w.addWork(await w.addAccount({ store: "C", platform: "douyin" }), { title: "抖音海信上海" });
    await w.addWork(await w.addAccount({ store: "B", platform: "kuaishou" }), { title: "快手日立北京" });
    const admin = await w.actor("platform_admin");
    expect(titles((await list(w.deps, admin, f({ platform: "xiaohongshu" }))).items)).toEqual(["小红书海信北京"]);
    expect(titles((await list(w.deps, admin, f({ brand: String(w.org.hitachi) }))).items)).toEqual(["快手日立北京"]);
    expect(titles((await list(w.deps, admin, f({ branch: String(w.org.sh) }))).items)).toEqual(["抖音海信上海"]);
    expect((await list(w.deps, admin, f({ branch: String(w.org.bj) }))).total).toBe(3);
    expect(await code(list(w.deps, admin, f({ branch: "999999" })))).toBe("input:invalid_filter");
    expect(await code(list(w.deps, admin, f({ brand: "999999" })))).toBe("input:invalid_filter"); // 不存在的品牌也不当作「没有结果」
  });
  it("发布时间按 UTC 回推 N 天；发布时间缺失的内容在选了范围时不出现", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    const now = w.env.clock.now().getTime();
    await w.addWork(a, { title: "6天前", publishedAt: new Date(now - 6 * DAY) });
    await w.addWork(a, { title: "8天前", publishedAt: new Date(now - 8 * DAY) });
    await w.addWork(a, { title: "100天前", publishedAt: new Date(now - 100 * DAY) });
    await w.addWork(a, { title: "无发布时间", publishedAt: null });
    const admin = await w.actor("platform_admin");
    expect(titles((await list(w.deps, admin, f({ within: "7" }))).items)).toEqual(["6天前"]);
    expect((await list(w.deps, admin, f({ within: "30" }))).total).toBe(2);
    expect((await list(w.deps, admin, f({ within: "180" }))).total).toBe(3);
    expect((await list(w.deps, admin, f())).total).toBe(4);
  });
  it("点赞区间边界：51/100/101/300/301/500/501", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    for (const like of [51, 100, 101, 300, 301, 500, 501, 100_000]) await w.addWork(a, { title: String(like), like });
    const admin = await w.actor("platform_admin");
    const band = async (b: string) => titles((await list(w.deps, admin, f({ like: b }))).items).sort((x, y) => Number(x) - Number(y));
    expect(await band("51-100")).toEqual(["51", "100"]);
    expect(await band("101-300")).toEqual(["101", "300"]);
    expect(await band("301-500")).toEqual(["301", "500"]);
    expect(await band("501+")).toEqual(["501", "100000"]);
  });
  it("标题搜索：包含匹配、大小写不敏感，% _ \\ 按字面处理", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    for (const title of ["Hitachi Care", "满100%好评", "a_b", "axb", "路径\\目录", "普通标题"]) await w.addWork(a, { title });
    const admin = await w.actor("platform_admin");
    const q = async (s: string) => titles((await list(w.deps, admin, f({ q: s }))).items);
    expect(await q("hitachi")).toEqual(["Hitachi Care"]);
    expect(await q("100%")).toEqual(["满100%好评"]);
    expect(await q("a_b")).toEqual(["a_b"]);
    expect(await q("%")).toEqual(["满100%好评"]);
    expect(await q("\\")).toEqual(["路径\\目录"]);
    expect(await q("不存在")).toEqual([]);
  });
});

describe("排序、分页与总数（design §5.5）", () => {
  it("点赞降序、同赞按内容 ID 降序；总数与列表同一条件；翻页稳定无重复；越界夹到最后一页", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    const made: string[] = [];
    for (let i = 0; i < 45; i++) made.push(String((await w.addWork(a, { title: `t${i}`, like: 100 + (i % 5) })).contentId));
    const admin = await w.actor("platform_admin");
    const p1 = await list(w.deps, admin, f({ page: "1" }));
    const p2 = await list(w.deps, admin, f({ page: "2" }));
    const p3 = await list(w.deps, admin, f({ page: "3" }));
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([20, 20, 5]);
    expect([p1.total, p1.pageCount, p3.page]).toEqual([45, 3, 3]);
    const all = [...p1.items, ...p2.items, ...p3.items];
    expect(new Set(all.map((x) => x.contentId)).size).toBe(45);
    for (let i = 1; i < all.length; i++) {
      const [x, y] = [all[i - 1]!, all[i]!];
      expect(BigInt(x.likeCount) > BigInt(y.likeCount) || (x.likeCount === y.likeCount && BigInt(x.contentId) > BigInt(y.contentId))).toBe(true);
    }
    const over = await list(w.deps, admin, f({ page: "99" }));
    expect([over.page, over.items.length, over.total]).toEqual([3, 5, 45]);
    const empty = await list(w.deps, admin, f({ q: "没有这个" , page: "5" }));
    expect([empty.page, empty.items.length, empty.total, empty.pageCount]).toEqual([1, 0, 0, 1]);
  });
});

describe("卡片字段与不泄露（R5、R7）", () => {
  it("评论缺失显示 null 而不是 0；真实 0 保留为 \"0\"；超过 2^53 的点赞数不丢精度", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A", nickname: "甲号" });
    await w.addWork(a, { title: "缺失", comment: null, like: 60 });
    await w.addWork(a, { title: "零", comment: 0, like: 61 });
    await w.addWork(a, { title: "大", comment: 7, like: 9_007_199_254_740_993n });
    const admin = await w.actor("platform_admin");
    const by = Object.fromEntries((await list(w.deps, admin, f())).items.map((x) => [x.title, x]));
    expect(by["缺失"]!.commentCount).toBeNull();
    expect(by["零"]!.commentCount).toBe("0");
    expect(by["大"]!.likeCount).toBe("9007199254740993");
    expect(by["大"]).toMatchObject({ accountName: "甲号", brand: { name: "海信" }, platform: { code: "douyin" }, kind: "video" });
    expect(by["大"]!.publishedAt).toMatch(/Z$/);
  });
  it("shareUrl 的协议白名单；text 并入图文", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    await w.addWork(a, { title: "好", shareUrl: "https://v.test/1", like: 90 });
    await w.addWork(a, { title: "脚本", shareUrl: "javascript:alert(1)", like: 80 });
    await w.addWork(a, { title: "空", shareUrl: null, like: 70 });
    await w.addWork(a, { title: "文", kind: "text", like: 60 });
    const admin = await w.actor("platform_admin");
    const by = Object.fromEntries((await list(w.deps, admin, f())).items.map((x) => [x.title, x]));
    expect(by["好"]!.watchUrl).toBe("https://v.test/1");
    expect(by["脚本"]!.watchUrl).toBeNull();
    expect(by["空"]!.watchUrl).toBeNull();
    expect(by["文"]!.kind).toBe("image");
  });
  it("返回值里没有专员姓名、手机号、门店名与编码、账号内部 ID", async () => {
    const w = await squareEnv(t);
    const accountId = await w.addAccount({ store: "A" });
    const { contentId } = await w.addWork(accountId, { cover: true });
    const admin = await w.actor("platform_admin");
    const json = JSON.stringify([...(await list(w.deps, admin, f())).items, await get(w.deps, admin, contentId)]);
    for (const secret of ["专员甲", "13800000001", "北京海信店", "S-A", "storeId", "staffId", "accountId", "mediaStaff"]) expect(json, secret).not.toContain(secret);
    // 只有公开形态的 contentId；账号内部 ID 不出现为键
    expect(JSON.parse(json)[0]).not.toHaveProperty("accountId");
  });
});

describe("封面（R5.1）", () => {
  it("取当前快照的 cover_normalized 并签短期地址；没有封面的卡片 coverUrl 为 null", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    await w.addWork(a, { title: "有", cover: true, like: 90 });
    await w.addWork(a, { title: "无", like: 80 });
    const admin = await w.actor("platform_admin");
    const by = Object.fromEntries((await list(w.deps, admin, f())).items.map((x) => [x.title, x]));
    expect(by["有"]!.coverUrl).toMatch(/^https:\/\/fake-media\.test\/media\/cover-\d+\.jpg\?ttl=300$/);
    expect(by["无"]!.coverUrl).toBeNull();
  });
  it("单卡签名失败只影响该卡，并告警；未配置签名器时全部占位", async () => {
    const w = await squareEnv(t);
    const a = await w.addAccount({ store: "A" });
    await w.addWork(a, { title: "甲", cover: true, like: 90 }); // 封面对象 media/cover-1.jpg
    await w.addWork(a, { title: "乙", cover: true, like: 80 });
    w.covers.failFor = (key) => key === "media/cover-1.jpg";
    const admin = await w.actor("platform_admin");
    const page = await list(w.deps, admin, f());
    expect(page.items.map((c) => [c.title, c.coverUrl === null])).toEqual([["甲", true], ["乙", false]]);
    expect(w.alerts).toContainEqual({ code: "cover_sign_failed", failed: 1 });
    const unconfigured = { ...w.deps, covers: null };
    expect((await list(unconfigured, admin, f())).items.every((c) => c.coverUrl === null)).toBe(true);
    expect(w.alerts).toContainEqual({ code: "covers_unconfigured" });
  });
});

describe("选项（R4.6）与单个作品", () => {
  it("选项数据驱动：只列真有作品的品牌 / 平台 / 分公司；未采到的平台不出现", async () => {
    const w = await squareEnv(t);
    await w.addWork(await w.addAccount({ store: "A", platform: "douyin" }), { like: 90 });
    await w.addWork(await w.addAccount({ store: "C", platform: "xiaohongshu" }), { like: 90 });
    await w.addWork(await w.addAccount({ store: "B", platform: "kuaishou" }), { like: 40 }); // 点赞不足：日立与快手都不该出现
    const o = await options(w.deps, await w.actor("platform_admin"));
    expect(o.brands.map((b) => b.name)).toEqual(["海信"]);
    expect(o.platforms.map((p) => p.code).sort()).toEqual(["douyin", "xiaohongshu"]);
    expect(o.branches.map((b) => b.name).sort()).toEqual(["上海分公司", "北京分公司"]);
  });
  it("get：可见作品返回详情（含分公司名）；不可见或不存在一律 not_found", async () => {
    const w = await squareEnv(t);
    const mine = await w.addWork(await w.addAccount({ store: "A" }), { title: "海信的" });
    const other = await w.addWork(await w.addAccount({ store: "B" }), { title: "日立的" });
    const hq = await w.actor("hq_manager", { brandIds: [w.org.hisense] });
    expect(await get(w.deps, hq, mine.contentId)).toMatchObject({ title: "海信的", branchName: "北京分公司" });
    expect((await get(w.deps, hq, other.contentId)).title).toBe("日立的"); // 默认看全部品牌
    await ownPolicy(w, w.org.hisense);
    expect(await code(get(w.deps, hq, other.contentId))).toBe("not_found:content_not_found");
    expect(await code(get(w.deps, hq, 999_999n))).toBe("not_found:content_not_found");
  });
});
