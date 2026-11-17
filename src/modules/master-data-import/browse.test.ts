// 主数据浏览：纯函数部分（a-master-data-browse MDB-4）。不需要数据库。
import { describe, expect, it } from "vitest";
import { escapeLike, normalizeFilter, PAGE_SIZES, type BrowseFilter } from "./browse";

const base: BrowseFilter = { page: 1, pageSize: 20 };

describe("escapeLike：LIKE 元字符按字面处理", () => {
  it("转义 % 与 _", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
  });
  it("转义反斜杠本身，且不重复转义", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("\\%")).toBe("\\\\\\%");
  });
  it("普通字符不变", () => {
    expect(escapeLike("HB-BJ-0231 日立")).toBe("HB-BJ-0231 日立");
  });
});

describe("normalizeFilter：非法筛选一律报错，不静默退化", () => {
  const reject = (patch: Partial<BrowseFilter>, code = "invalid_filter") => {
    expect(() => normalizeFilter({ ...base, ...patch })).toThrow(expect.objectContaining({ category: "input", code }));
  };

  it("页码与每页大小", () => {
    reject({ page: 0 });
    reject({ page: 1.5 });
    reject({ pageSize: 10 as BrowseFilter["pageSize"] });
    expect(PAGE_SIZES).toEqual([20, 50, 100]);
  });

  it("状态只接受 active / closed，可多选并去重", () => {
    reject({ statuses: ["deleted" as never] });
    expect(normalizeFilter({ ...base, statuses: ["closed"] }).statuses).toEqual(["closed"]);
    expect(normalizeFilter({ ...base, statuses: ["closed", "active", "closed"] }).statuses).toEqual(["closed", "active"]);
    expect(normalizeFilter({ ...base, statuses: [] }).statuses).toBeUndefined();
  });

  it("品牌 / 大区 / 分公司 ID 必须是十进制且为正，可多选", () => {
    reject({ brandIds: ["abc"] });
    reject({ brandIds: ["0"] });
    reject({ brandIds: ["-1"] });
    reject({ brandIds: ["1.5"] });
    reject({ branchIds: ["1", "x"] });
    reject({ regionIds: ["x"] });
    expect(normalizeFilter({ ...base, brandIds: ["9007199254740993"] }).brandIds).toEqual(["9007199254740993"]);
    expect(normalizeFilter({ ...base, regionIds: ["1", "2", "1"] }).regionIds).toEqual(["1", "2"]);
  });

  it("板块 / 店面标准长度与数量上限；「未设置」与具体值可同时选", () => {
    reject({ sectorNames: ["板".repeat(129)] });
    reject({ tiers: ["级".repeat(65)] });
    reject({ brandIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) });
    expect(normalizeFilter({ ...base, sectorNames: ["水机"], tiers: ["旗舰店"] })).toMatchObject({ sectorNames: ["水机"], tiers: ["旗舰店"] });
    expect(normalizeFilter({ ...base, tiers: ["旗舰店"], tierMissing: true })).toMatchObject({ tiers: ["旗舰店"], tierMissing: true });
    expect(normalizeFilter({ ...base, tierMissing: false }).tierMissing).toBeUndefined();
  });

  it("关键字超长报错；空白视为未指定", () => {
    reject({ keyword: "k".repeat(65) });
    expect(normalizeFilter({ ...base, keyword: "  " }).keyword).toBeUndefined();
    expect(normalizeFilter({ ...base, keyword: " 门店 " }).keyword).toBe("门店");
  });

  it("板块 / 店面标准空白视为未指定", () => {
    expect(normalizeFilter({ ...base, sectorNames: ["  "] }).sectorNames).toBeUndefined();
    expect(normalizeFilter({ ...base, tiers: ["  ", " 旗舰店 "] }).tiers).toEqual(["旗舰店"]);
  });
});