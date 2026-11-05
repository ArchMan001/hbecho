// 行分类（MD-2/3/4/5，acceptance B 系列）：纯逻辑，RefReader 用内存假实现。
import { describe, expect, it } from "vitest";
import { classifyRow, findGroupErrors, toFileRow, type BrandScope, type Classified, type FileRow, type ImportMode, type RefReader, type StoreRef } from "./classify";

const cells = (o: Partial<Record<string, string>> = {}): string[] => [
  o.name ?? "测试一店",
  o.withdrawn ?? "无撤销",
  o.digital ?? "否",
  o.storeCode ?? "S1",
  o.dealerName ?? "商家甲",
  o.dealerCode ?? "D1",
  o.branchName ?? "上海分公司",
  o.branchCode ?? "110",
  o.mainName ?? "日立家装",
  o.mainCode ?? "13",
  o.tier ?? "A级",
];
const row = (o: Partial<Record<string, string>> = {}, no = 1): FileRow => toFileRow(no, cells(o));

interface World {
  brands?: Record<string, { id: bigint; status: string }>;
  branches?: Record<string, { id: bigint; status: string; name: string }>;
  sectors?: Record<string, { id: bigint; status: string }>; // key: `${branchId}|${name}`
  dealers?: Record<string, { id: bigint; status: string; name: string }>;
  stores?: StoreRef[];
}
const baseWorld = (): Required<World> => ({
  brands: { hitachi: { id: 1n, status: "active" }, hisense: { id: 2n, status: "active" }, york_vrf: { id: 3n, status: "active" } },
  branches: { "110": { id: 10n, status: "active", name: "上海分公司" } },
  sectors: { "10|家装": { id: 100n, status: "active" }, "10|水机": { id: 101n, status: "active" } },
  dealers: { D1: { id: 7n, status: "active", name: "商家甲" } },
  stores: [],
});
const refs = (w: Required<World>): RefReader => ({
  brand: async (c) => w.brands[c],
  branch: async (c) => w.branches[c],
  sector: async (b, n) => w.sectors[`${b}|${n}`],
  dealer: async (c) => w.dealers[c],
  store: async (b, c) => w.stores.find((s) => s.brandId === b && s.code === c),
});
const store = (o: Partial<StoreRef> = {}): StoreRef => ({
  id: 50n,
  brandId: 1n,
  code: "S1",
  name: "测试一店",
  tier: "A级",
  dealerId: 7n,
  sectorId: 100n,
  status: "active",
  sourceBatchId: null,
  ...o,
});

async function run(r: FileRow, w: Required<World> = baseWorld(), mode: ImportMode = "import", scope: BrandScope = "all", group?: ReadonlyMap<number, Classified>): Promise<Classified> {
  return classifyRow(r, { mode, scope, refs: refs(w), ...(group ? { groupErrors: group } : {}) });
}
const tag = (c: Classified) => `${c.cls}/${c.reason}`;

describe("字段与映射（优先级 1–5）", () => {
  it("必填列为空 → missing_required_field（店面标准可空）", async () => {
    expect(tag(await run(row({ name: "" })))).toBe("error/missing_required_field");
    expect(tag(await run(row({ mainName: "" })))).toBe("error/missing_required_field");
    expect(tag(await run(row({ dealerCode: "  " })))).toBe("error/missing_required_field");
    expect((await run(row({ tier: "" }))).cls).toBe("new");
  });

  it("撤店情况不是「无撤销」/ 数字门店不是「否」 → error，原值写进 detail", async () => {
    const w = await run(row({ withdrawn: "审核失败" }));
    expect(tag(w)).toBe("error/row_withdrawn");
    expect(w.detail).toContain("审核失败");
    expect(tag(await run(row({ digital: "是" })))).toBe("error/row_digital_store");
  });

  it("商家渠道编码 -- / #N/A → dealer_code_missing；空值先命中 missing_required_field", async () => {
    expect(tag(await run(row({ dealerCode: "--" })))).toBe("error/dealer_code_missing");
    expect(tag(await run(row({ dealerCode: "#N/A" })))).toBe("error/dealer_code_missing");
    expect(tag(await run(row({ dealerCode: "" })))).toBe("error/missing_required_field");
  });

  it("主营业务编码：13/15/23/25/33 命中；013、13.0、1 3、全角、constructor 一律不命中，不回落默认品牌", async () => {
    for (const code of ["013", "13.0", "1 3", "１３", "constructor", "14", "43"]) {
      expect(tag(await run(row({ mainCode: code })))).toBe("error/main_business_code_unmapped");
    }
    expect((await run(row({ mainCode: " 13 " }))).cls).toBe("new"); // 去首尾空白后等于 13
    const w = baseWorld();
    for (const [code, brandId, sectorId] of [
      ["13", 1n, 100n],
      ["15", 1n, 101n],
      ["23", 2n, 100n],
      ["25", 2n, 101n],
      ["33", 3n, 100n],
    ] as const) {
      const c = await run(row({ mainCode: code }), w);
      expect(c.plan).toMatchObject({ brandId, sectorId });
    }
  });
});

describe("授权（优先级 6）", () => {
  it("范围 {hitachi} 遇海信行 → brand_not_authorized，即使海信在库中缺失或停用", async () => {
    const scope = new Set(["hitachi"]);
    const w = baseWorld();
    expect(tag(await run(row({ mainCode: "23" }), w, "import", scope))).toBe("error/brand_not_authorized");
    delete (w.brands as Record<string, unknown>).hisense;
    expect(tag(await run(row({ mainCode: "23" }), w, "import", scope))).toBe("error/brand_not_authorized");
    expect((await run(row(), baseWorld(), "import", scope)).cls).toBe("new");
  });

  it("structure 模式不按品牌范围过滤", async () => {
    expect(tag(await run(row({ mainCode: "23" }), baseWorld(), "structure", new Set(["hitachi"])))).not.toBe("error/brand_not_authorized");
  });
});

describe("文件内重复（优先级 7、8）", () => {
  it("同一 (品牌, 门店编码) 完全相同 → 组内所有行 error；重复先于结构判断", async () => {
    const rows = [row({}, 1), row({ dealerCode: "D9" }, 2), row({ storeCode: "S2" }, 3)];
    const g = findGroupErrors(rows, "import", "all");
    expect([...g.keys()].sort()).toEqual([1, 2]);
    expect(tag(await run(rows[1]!, baseWorld(), "import", "all", g))).toBe("error/duplicate_store_code_in_file"); // D9 不存在，但重复优先
  });

  it("仅大小写不同是两家不同门店，不报重复；不同品牌同编码也不重复", () => {
    const g = findGroupErrors([row({ storeCode: "NO.a" }, 1), row({ storeCode: "NO.A" }, 2), row({ mainCode: "23" }, 3), row({ mainCode: "13" }, 4)], "import", "all");
    expect([...g.keys()]).toEqual([]);
  });

  it("同一商家渠道编码对应不同商家名称 → 该编码下所有行 error", () => {
    const g = findGroupErrors([row({ storeCode: "A" }, 1), row({ storeCode: "B", dealerName: "另一个名字" }, 2), row({ storeCode: "C", dealerCode: "D2" }, 3)], "import", "all");
    expect([...g.keys()].sort()).toEqual([1, 2]);
    expect(g.get(1)!.reason).toBe("dealer_name_conflict_in_file");
  });
});

describe("结构缺失与停用（9–17）", () => {
  it("品牌 / 分公司 / 板块 / 经销商 不存在或停用 → needs_superadmin 与对应 reason", async () => {
    const w = baseWorld();
    delete (w.brands as Record<string, unknown>).hitachi;
    expect(tag(await run(row(), w))).toBe("needs_superadmin/brand_not_found");
    const w2 = baseWorld();
    w2.brands.hitachi = { id: 1n, status: "inactive" };
    expect(tag(await run(row(), w2))).toBe("needs_superadmin/brand_inactive");
    expect(tag(await run(row({ branchCode: "999" })))).toBe("needs_superadmin/branch_not_found");
    const w3 = baseWorld();
    w3.branches["110"] = { id: 10n, status: "inactive", name: "上海分公司" };
    expect(tag(await run(row(), w3))).toBe("needs_superadmin/branch_inactive");
    const w4 = baseWorld();
    delete (w4.sectors as Record<string, unknown>)["10|家装"];
    expect(tag(await run(row(), w4))).toBe("needs_superadmin/sector_not_found");
    const w5 = baseWorld();
    w5.sectors["10|家装"] = { id: 100n, status: "inactive" };
    expect(tag(await run(row(), w5))).toBe("needs_superadmin/sector_inactive");
    expect(tag(await run(row({ dealerCode: "D9" })))).toBe("needs_superadmin/dealer_not_found");
    const w6 = baseWorld();
    w6.dealers.D1 = { id: 7n, status: "inactive", name: "商家甲" };
    expect(tag(await run(row(), w6))).toBe("needs_superadmin/dealer_inactive");
    expect(tag(await run(row({ dealerName: "改名后" })))).toBe("needs_superadmin/dealer_name_mismatch");
  });

  it("分公司名称与库中不同、编码相同 → 照常分类，detail 记 branch_name_differs", async () => {
    const c = await run(row({ branchName: "写法不同的上海分公司" }));
    expect(c.cls).toBe("new");
    expect(c.detail).toContain("branch_name_differs");
  });

  it("structure 模式：经销商缺失/停用/改名 → 可写；品牌、分公司、板块相关仍 Q", async () => {
    expect(tag(await run(row({ dealerCode: "D9" }), baseWorld(), "structure"))).toBe("new/create_dealer");
    const w = baseWorld();
    w.dealers.D1 = { id: 7n, status: "inactive", name: "商家甲" };
    w.stores = [store()];
    expect(tag(await run(row(), w, "structure"))).toBe("update/activate_dealer");
    const w2 = baseWorld();
    w2.stores = [store()];
    expect(tag(await run(row({ dealerName: "改名后" }), w2, "structure"))).toBe("update/update_dealer_name");
    expect(tag(await run(row({ branchCode: "999" }), baseWorld(), "structure"))).toBe("needs_superadmin/branch_not_found");
    const w3 = baseWorld();
    delete (w3.sectors as Record<string, unknown>)["10|家装"];
    expect(tag(await run(row(), w3, "structure"))).toBe("needs_superadmin/sector_not_found");
  });
});

describe("门店匹配（18–22）", () => {
  it("不存在 → new；名称相同 → unchanged；名称或等级不同 → update/store_fields_changed", async () => {
    expect(tag(await run(row()))).toBe("new/null");
    const w = baseWorld();
    w.stores = [store()];
    expect(tag(await run(row(), w))).toBe("unchanged/null");
    expect(tag(await run(row({ name: "新名字" }), w))).toBe("update/store_fields_changed");
    expect(tag(await run(row({ tier: "B级" }), w))).toBe("update/store_fields_changed");
    expect(tag(await run(row({ tier: "" }), w))).toBe("update/store_fields_changed"); // 等级清空
  });

  it("店面标准为空 → plan.storeTier 是 null，不是空串", async () => {
    expect((await run(row({ tier: "" }))).plan!.storeTier).toBeNull();
  });

  it("已 closed 且本行合法 → update/reactivate_store", async () => {
    const w = baseWorld();
    w.stores = [store({ status: "closed" })];
    const c = await run(row(), w);
    expect(tag(c)).toBe("update/reactivate_store");
    expect(c.storeId).toBe(50n);
  });

  it("经销商或板块不同 → import 模式 needs_superadmin/store_relation_change；structure 模式 update/change_store_relation", async () => {
    const w = baseWorld();
    w.stores = [store({ dealerId: 8n })];
    expect(tag(await run(row(), w))).toBe("needs_superadmin/store_relation_change");
    expect(tag(await run(row(), w, "structure"))).toBe("update/change_store_relation");
    const w2 = baseWorld();
    w2.stores = [store({ sectorId: 101n })];
    expect(tag(await run(row(), w2))).toBe("needs_superadmin/store_relation_change");
  });

  it("不同品牌同编码各自匹配", async () => {
    const w = baseWorld();
    w.stores = [store({ brandId: 2n })];
    expect(tag(await run(row({ mainCode: "13" }), w))).toBe("new/null");
    expect(tag(await run(row({ mainCode: "23" }), w))).toBe("unchanged/null");
  });
});
