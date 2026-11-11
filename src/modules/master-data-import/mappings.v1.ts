// master-data-mapping.v1：品牌 / 板块映射与 bootstrap 常量（design §7.2）。代码常量，不是数据库表；改动需要单独提交与回归测试。
export const MAPPING_VERSION = "master-data-mapping.v1";
export const TEMPLATE_VERSION = "master-data-export.v1";

export type SectorKey = "water" | "home";

export const SECTOR_NAMES: Record<SectorKey, string> = { water: "水机", home: "家装" };

export const BRANDS = [
  { code: "hitachi", name: "日立" },
  { code: "hisense", name: "海信" },
  { code: "york_vrf", name: "约克VRF" },
] as const;

/** 主营业务编码（原文去首尾空白后精确比较，不转数字）→ 品牌编码 + 板块。 */
export const MAIN_BUSINESS: Readonly<Record<string, { brand: string; sector: SectorKey }>> = {
  "13": { brand: "hitachi", sector: "home" },
  "15": { brand: "hitachi", sector: "water" },
  "23": { brand: "hisense", sector: "home" },
  "25": { brand: "hisense", sector: "water" },
  "33": { brand: "york_vrf", sector: "home" },
};

export function mapMainBusiness(code: string): { brand: string; sector: SectorKey } | undefined {
  // Object.hasOwn：避免 "constructor" 等原型键被当成命中
  return Object.hasOwn(MAIN_BUSINESS, code) ? MAIN_BUSINESS[code] : undefined;
}

export const sectorCodeOf = (branchCode: string, key: SectorKey): string => `${branchCode}-${key}`;

/** sectorCodeOf 的反函数：从板块编码 `{分公司编码}-{water|home}` 取种类；不是这个形态返回 undefined（a-activity-plan 预检用）。 */
export const sectorKeyOf = (sectorCode: string): SectorKey | undefined => {
  const key = sectorCode.slice(sectorCode.lastIndexOf("-") + 1);
  return sectorCode.includes("-") && (key === "water" || key === "home") ? key : undefined;
};
