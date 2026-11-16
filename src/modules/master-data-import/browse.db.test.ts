// 主数据浏览：读口（a-master-data-browse MDB-1~MDB-7、MDB-10）。只读；品牌范围与筛选在数据库层生效。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { adminActor, bootstrapped, seedStores } from "../../../tests/harness/master-data";
import { CAP_IMPORT } from "./authorization";
import { brands, branches, stores } from "../../db/schema";
import type { ActorContext } from "./authorization";
import type { BrowseFilter } from "./browse";

const t = useTestDb();

const page = { page: 1, pageSize: 20 } as const;
const actor = (brandCodes: string[] | "all", capabilities: string[] = [CAP_IMPORT]): ActorContext => ({
  actor: "service:test-browse",
  capabilities: new Set(capabilities),
  brandScope: brandCodes === "all" ? "all" : new Set(brandCodes),
});

/** 5 家门店：日立（旗舰 / 标准）、海信（等级 / 水机且已撤店）、约克；S-2 的店面标准为空。 */
async function fixture() {
  const env = await bootstrapped(t);
  await seedStores(env, [
    { storeCode: "S-1", branchCode: "110", mainCode: "13", tier: "旗舰店" },
    { storeCode: "S-2", branchCode: "110", mainCode: "15", tier: "标准店" },
    { storeCode: "S-3", branchCode: "101", mainCode: "23", tier: "海信等级" },
    { storeCode: "S-4", branchCode: "110", mainCode: "33", tier: "约克等级" },
    { storeCode: "S-5", branchCode: "101", mainCode: "25", tier: "海信等级" },
  ]);
  await t.db.update(stores).set({ storeTier: null }).where(eq(stores.storeCode, "S-2"));
  await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeCode, "S-5"));
  return env;
}

describe("门店读口", () => {
  it("字段齐全、BIGINT 字符串、时间 ISO；排序为品牌编码 → 分公司编码 → 门店编码", async () => {
    const env = await fixture();
    const r = await env.md.browse.stores({ ...page }, adminActor());
    expect(r.total).toBe(5);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
    expect(r.items.map((s) => s.storeCode)).toEqual(["S-3", "S-5", "S-1", "S-2", "S-4"]); // brand_code 字节序：hisense < hitachi < york_vrf
    const s1 = r.items.find((s) => s.storeCode === "S-1")!;
    expect(s1).toMatchObject({
      storeId: expect.any(String),
      storeName: expect.any(String),
      brandCode: "hitachi",
      brandName: "日立",
      branchCode: "110",
      branchName: "上海分公司",
      sectorName: "家装",
      dealerCode: "9000001",
      dealerName: "商家甲",
      storeTier: "旗舰店",
      status: "active",
    });
    expect(s1.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r.items.find((s) => s.storeCode === "S-3")).toMatchObject({ storeTier: "海信等级", status: "active" });
    expect(r.items.find((s) => s.storeCode === "S-5")).toMatchObject({ status: "closed" });
    expect(r.items.find((s) => s.storeCode === "S-2")!.storeTier).toBeNull();
  });

  it("品牌范围：集合只返回该品牌；all 返回全部；空集合 0 行（不是不加谓词）", async () => {
    const env = await fixture();
    expect((await env.md.browse.stores({ ...page }, actor(["hitachi"]))).items.map((s) => s.storeCode)).toEqual(["S-1", "S-2"]);
    expect((await env.md.browse.stores({ ...page }, actor(["hisense", "york_vrf"]))).total).toBe(3);
    expect((await env.md.browse.stores({ ...page }, actor("all"))).total).toBe(5);
    expect((await env.md.browse.stores({ ...page }, actor([]))).total).toBe(0);
  });

  it("六项筛选：品牌 / 分公司 / 板块 / 状态 / 店面标准 / 关键字，可组合", async () => {
    const env = await fixture();
    const [hitachi] = await t.db.select().from(brands).where(eq(brands.brandCode, "hitachi"));
    const [shanghai] = await t.db.select().from(branches).where(eq(branches.branchCode, "110"));
    const q = (f: Partial<BrowseFilter>) => env.md.browse.stores({ ...page, ...f }, adminActor());

    expect((await q({ brandId: String(hitachi!.brandId) })).total).toBe(2);
    expect((await q({ branchId: String(shanghai!.branchId) })).items.map((s) => s.storeCode)).toEqual(["S-1", "S-2", "S-4"]);
    expect((await q({ sectorName: "水机" })).items.map((s) => s.storeCode)).toEqual(["S-5", "S-2"]);
    expect((await q({ tier: "旗舰店" })).items.map((s) => s.storeCode)).toEqual(["S-1"]);
    expect((await q({ tierMissing: true })).items.map((s) => s.storeCode)).toEqual(["S-2"]);
    expect((await q({ status: "closed" })).items.map((s) => s.storeCode)).toEqual(["S-5"]);
    expect((await q({ keyword: "S-1" })).items.map((s) => s.storeCode)).toEqual(["S-1"]);
    expect((await q({ branchId: String(shanghai!.branchId), sectorName: "水机", status: "active" })).items.map((s) => s.storeCode)).toEqual(["S-2"]);
  });

  it("关键字里的 LIKE 元字符按字面处理，不命中全表", async () => {
    const env = await fixture();
    expect((await env.md.browse.stores({ ...page, keyword: "%" }, adminActor())).total).toBe(0);
    expect((await env.md.browse.stores({ ...page, keyword: "_" }, adminActor())).total).toBe(0);
  });

  it("非法筛选报 invalid_filter，不退化为全部", async () => {
    const env = await fixture();
    await expect(env.md.browse.stores({ ...page, status: "deleted" as never }, adminActor())).rejects.toMatchObject({ category: "input", code: "invalid_filter" });
    await expect(env.md.browse.stores({ ...page, tier: "旗舰店", tierMissing: true }, adminActor())).rejects.toMatchObject({ category: "input", code: "invalid_filter" });
    await expect(env.md.browse.stores({ ...page, pageSize: 10 as never }, adminActor())).rejects.toMatchObject({ category: "input", code: "invalid_filter" });
    const r = await env.md.browse.stores({ ...page, keyword: "  " }, adminActor());
    expect(r.total).toBe(5); // 空白关键字 = 未指定
  });

  it("分页：total 与列表同一谓词，页与页不重不漏", async () => {
    const env = await fixture();
    const [base] = await t.db.select().from(stores).where(eq(stores.storeCode, "S-1"));
    const now = new Date("2026-11-16T00:00:00.000Z");
    await t.db.insert(stores).values(
      Array.from({ length: 25 }, (_, i) => ({
        storeCode: `P-${String(i + 1).padStart(2, "0")}`,
        storeName: `分页门店 ${i + 1}`,
        dealerId: base!.dealerId,
        brandId: base!.brandId,
        sectorId: base!.sectorId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })),
    );
    const p1 = await env.md.browse.stores({ ...page, keyword: "P-" }, adminActor());
    const p2 = await env.md.browse.stores({ ...page, page: 2, keyword: "P-" }, adminActor());
    const all = await env.md.browse.stores({ ...page, pageSize: 50, keyword: "P-" }, adminActor());
    expect(p1.total).toBe(25);
    expect(p1.items).toHaveLength(20);
    expect(p2.items).toHaveLength(5);
    expect([...p1.items, ...p2.items].map((s) => s.storeCode)).toEqual(all.items.map((s) => s.storeCode));
    expect(new Set(all.items.map((s) => s.storeCode)).size).toBe(25);
  });

  it("10,000 行：单页只返回 ≤ pageSize，total 与切片一致（A19）", async () => {
    const env = await fixture();
    const [base] = await t.db.select().from(stores).where(eq(stores.storeCode, "S-1"));
    const now = new Date("2026-11-16T00:00:00.000Z");
    const bulk = Array.from({ length: 10_000 }, (_, i) => ({
      storeCode: `L-${String(i + 1).padStart(5, "0")}`,
      storeName: `规模门店 ${i + 1}`,
      dealerId: base!.dealerId,
      brandId: base!.brandId,
      sectorId: base!.sectorId,
      status: i % 50 === 0 ? "closed" : "active",
      storeTier: i % 7 === 0 ? null : "规模等级",
      createdAt: now,
      updatedAt: now,
    }));
    for (let i = 0; i < bulk.length; i += 2000) await t.db.insert(stores).values(bulk.slice(i, i + 2000));
    const first = await env.md.browse.stores({ page: 1, pageSize: 100, keyword: "L-" }, adminActor());
    expect(first.total).toBe(10_000);
    expect(first.items).toHaveLength(100);
    expect(first.items[0]!.storeCode).toBe("L-00001");
    const last = await env.md.browse.stores({ page: 100, pageSize: 100, keyword: "L-" }, adminActor());
    expect(last.items).toHaveLength(100);
    expect(last.items.at(-1)!.storeCode).toBe("L-10000");
  });

  it("无 Capability 拒绝；读口不改变业务表", async () => {
    const env = await fixture();
    await expect(env.md.browse.stores({ ...page }, actor("all", []))).rejects.toMatchObject({ category: "authorization", code: "forbidden" });
    const snapshot = async () => JSON.stringify((await t.db.select().from(stores)).map((s) => [s.storeCode, s.updatedAt.getTime(), s.status, s.storeTier]));
    const before = await snapshot();
    await env.md.browse.stores({ ...page }, adminActor());
    await env.md.browse.branches({ ...page }, adminActor());
    await env.md.browse.filterOptions(adminActor());
    expect(await snapshot()).toBe(before);
  });
});

describe("分公司读口", () => {
  it("42 个分公司、分页与总数；计数只含授权品牌内门店", async () => {
    const env = await fixture();
    const all = await env.md.browse.branches({ page: 1, pageSize: 50 }, adminActor());
    expect(all.total).toBe(42);
    expect(all.items).toHaveLength(42);
    const byCode = new Map(all.items.map((b) => [b.branchCode, b]));
    expect(byCode.get("110")).toMatchObject({ branchName: "上海分公司", regionName: "华东", activeStoreCount: 3, closedStoreCount: 0 });
    expect(byCode.get("101")).toMatchObject({ activeStoreCount: 1, closedStoreCount: 1 });

    const hitachi = await env.md.browse.branches({ page: 1, pageSize: 50 }, actor(["hitachi"]));
    const h = new Map(hitachi.items.map((b) => [b.branchCode, b]));
    expect(h.get("110")).toMatchObject({ activeStoreCount: 2, closedStoreCount: 0 });
    expect(h.get("101")).toMatchObject({ activeStoreCount: 0, closedStoreCount: 0 });

    const p1 = await env.md.browse.branches({ page: 1, pageSize: 20 }, adminActor());
    const p3 = await env.md.browse.branches({ page: 3, pageSize: 20 }, adminActor());
    expect(p1.items).toHaveLength(20);
    expect(p3.items).toHaveLength(2);
  });

  it("关键字按编码 / 名称筛选；无 Capability 拒绝", async () => {
    const env = await fixture();
    const r = await env.md.browse.branches({ page: 1, pageSize: 20, keyword: "上海" }, adminActor());
    expect(r.total).toBe(1);
    expect(r.items[0]!.branchCode).toBe("110");
    await expect(env.md.browse.branches({ ...page }, actor("all", []))).rejects.toMatchObject({ category: "authorization", code: "forbidden" });
  });
});

describe("筛选选项", () => {
  it("板块 / 店面标准选项按授权品牌收窄；storeTiers 不含空值", async () => {
    const env = await fixture();
    const all = await env.md.browse.filterOptions(adminActor());
    expect([...all.sectorNames].sort()).toEqual(["家装", "水机"]);
    expect([...all.storeTiers].sort()).toEqual(["旗舰店", "海信等级", "约克等级"]);
    expect(all.hasMissingTier).toBe(true);
    expect(all.storeCount).toBe(5);
    expect(all.branchCount).toBe(42);

    const hitachi = await env.md.browse.filterOptions(actor(["hitachi"]));
    expect(hitachi.storeTiers).toEqual(["旗舰店"]);
    expect(hitachi.hasMissingTier).toBe(true);
    expect(hitachi.storeCount).toBe(2);
    expect([...hitachi.sectorNames].sort()).toEqual(["家装", "水机"]);

    const hisense = await env.md.browse.filterOptions(actor(["hisense"]));
    expect(hisense.storeTiers).toEqual(["海信等级"]);
    expect(hisense.hasMissingTier).toBe(false);

    const york = await env.md.browse.filterOptions(actor(["york_vrf"]));
    expect(york.storeTiers).toEqual(["约克等级"]);
    expect(york.sectorNames).toEqual(["家装"]);
  });

  it("无 Capability 拒绝", async () => {
    const env = await fixture();
    await expect(env.md.browse.filterOptions(actor("all", []))).rejects.toMatchObject({ category: "authorization", code: "forbidden" });
  });
});