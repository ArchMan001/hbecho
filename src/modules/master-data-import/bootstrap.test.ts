// 种子解析、映射常量与服务身份（MD-3、MD-5、MD-9 的纯函数部分）。bootstrap 写库的部分在 bootstrap.db.test.ts。
import { describe, expect, it } from "vitest";
import { actorFromEnv, assertMode, assertStructure, CAP_IMPORT, CAP_STRUCTURE } from "./authorization";
import { loadSeed, parseSeed } from "./bootstrap";
import { MasterDataError } from "./errors";
import { BRANDS, mapMainBusiness, sectorCodeOf, sectorKeyOf } from "./mappings.v1";

describe("种子 CSV", () => {
  it("仓库里的种子：42 个分公司、4 个大区，每个分公司恰好一个大区", () => {
    const rows = loadSeed();
    expect(rows).toHaveLength(42);
    expect(new Set(rows.map((r) => r.regionCode)).size).toBe(4);
    expect(new Set(rows.map((r) => r.branchCode)).size).toBe(42);
  });

  it("读时去掉 UTF-8 BOM", () => {
    expect(parseSeed("\uFEFF大区编码,大区,分公司编码,分公司\n1,华东,110,上海分公司\n")).toEqual([
      { regionCode: "1", regionName: "华东", branchCode: "110", branchName: "上海分公司" },
    ]);
  });

  it("种子损坏：分公司重复 / 对应两个大区 / 大区两个名字 / 字段缺失 / 表头错 → 整批失败", () => {
    const h = "大区编码,大区,分公司编码,分公司\n";
    expect(() => parseSeed(`${h}1,华东,110,甲\n2,北区,110,甲\n`)).toThrow(MasterDataError);
    expect(() => parseSeed(`${h}1,华东,110,甲\n1,华东,110,甲\n`)).toThrow(MasterDataError);
    expect(() => parseSeed(`${h}1,华东,110,甲\n1,东区,111,乙\n`)).toThrow(MasterDataError);
    expect(() => parseSeed(`${h}1,华东,110\n`)).toThrow(MasterDataError);
    expect(() => parseSeed("a,b,c,d\n1,华东,110,甲\n")).toThrow(MasterDataError);
  });
});

describe("映射常量", () => {
  it("品牌三个，板块编码带分公司前缀", () => {
    expect(BRANDS.map((b) => b.code)).toEqual(["hitachi", "hisense", "york_vrf"]);
    expect(sectorCodeOf("110", "water")).toBe("110-water");
    expect(mapMainBusiness("33")).toEqual({ brand: "york_vrf", sector: "home" });
    expect(mapMainBusiness("toString")).toBeUndefined();
  });
});

describe("服务身份", () => {
  const env = { HBECHO_MD_ACTOR: "service:t", HBECHO_MD_CAPABILITIES: CAP_IMPORT, HBECHO_MD_BRAND_SCOPE: "hitachi, hisense" };

  it("缺 actor / capabilities / brand_scope 启动失败，不缺省为全部品牌", () => {
    for (const k of Object.keys(env)) {
      const e = { ...env } as Record<string, string | undefined>;
      delete e[k];
      expect(() => actorFromEnv(e)).toThrow(MasterDataError);
    }
  });

  it("brand_scope 为品牌集合或 all", () => {
    expect(actorFromEnv(env).brandScope).toEqual(new Set(["hitachi", "hisense"]));
    expect(actorFromEnv({ ...env, HBECHO_MD_BRAND_SCOPE: "all" }).brandScope).toBe("all");
  });

  it("结构类操作要求 structure Capability 且品牌范围 all；import 模式要求 import Capability", () => {
    const imp = actorFromEnv(env);
    expect(() => assertStructure(imp)).toThrow(MasterDataError);
    expect(() => assertMode(imp, "structure")).toThrow(MasterDataError);
    expect(() => assertMode(imp, "import")).not.toThrow();
    const partial = actorFromEnv({ ...env, HBECHO_MD_CAPABILITIES: CAP_STRUCTURE });
    expect(() => assertStructure(partial)).toThrow(MasterDataError); // 品牌范围不是 all
    const admin = actorFromEnv({ ...env, HBECHO_MD_CAPABILITIES: `${CAP_IMPORT},${CAP_STRUCTURE}`, HBECHO_MD_BRAND_SCOPE: "all" });
    expect(() => assertStructure(admin)).not.toThrow();
    expect(() => assertMode(admin, "import")).not.toThrow();
  });
});

describe("sectorKeyOf 是 sectorCodeOf 的反函数（a-activity-plan 预检按它判断门店板块种类）", () => {
  it("种子里 42 个分公司 × 2 个种类全部往返不变", () => {
    for (const r of loadSeed()) {
      expect(sectorKeyOf(sectorCodeOf(r.branchCode, "water"))).toBe("water");
      expect(sectorKeyOf(sectorCodeOf(r.branchCode, "home"))).toBe("home");
    }
  });
  it("不是约定形态一律 undefined", () => {
    for (const bad of ["SEC-HOME", "home", "101-kitchen", "", "101-"]) expect(sectorKeyOf(bad)).toBeUndefined();
  });
});
