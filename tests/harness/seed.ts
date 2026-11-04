// 离线测试与测试机一次性库用的种子：品牌、大区、分公司、板块、经销商、门店、MediaStaff。
// 大区与分公司取自 HBECHO设计方案/domains/data-foundation/seed/分公司-大区对照.csv（42 个分公司 → 4 个大区）。
// 只用于测试库，不是主数据导入（那是 a-master-data-import）。
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { branches, brands, dataProviders, dealers, mediaStaff, platforms, regions, sectors, stores, syncSettings } from "../../src/db/schema";

const CSV = new URL("../../HBECHO设计方案/domains/data-foundation/seed/分公司-大区对照.csv", import.meta.url);

export interface OrgSeed {
  regionIds: Map<string, bigint>;
  branchIds: Map<string, bigint>;
  hitachiBrandId: bigint;
  hisenseBrandId: bigint;
  sectorId: bigint;
  dealerId: bigint;
  storeId: bigint;
  otherStoreId: bigint;
  /** 三位有效专员 + 一位停用专员；staffC 的 ID 超过 JS 安全整数。 */
  staffA: bigint;
  staffB: bigint;
  staffC: bigint;
  staffInactive: bigint;
}

export const BIG_STAFF_ID = 9007199254740993n;

export function parseRegionBranchCsv(): Array<{ regionCode: string; region: string; branchCode: string; branch: string }> {
  const text = readFileSync(CSV, "utf8").replace(/^\uFEFF/, "");
  return text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [regionCode, region, branchCode, branch] = line.split(",");
      return { regionCode: regionCode!, region: region!, branchCode: branchCode!, branch: branch! };
    });
}

export async function seedOrg(db: Db, now: Date): Promise<OrgSeed> {
  const stamps = { createdAt: now, updatedAt: now };
  const rows = parseRegionBranchCsv();

  const regionIds = new Map<string, bigint>();
  for (const r of rows) {
    if (regionIds.has(r.regionCode)) continue;
    const [res] = await db.insert(regions).values({ regionCode: r.regionCode, regionName: r.region, status: "active", ...stamps });
    regionIds.set(r.regionCode, BigInt(res.insertId));
  }
  const branchIds = new Map<string, bigint>();
  for (const r of rows) {
    const [res] = await db
      .insert(branches)
      .values({ regionId: regionIds.get(r.regionCode)!, branchCode: r.branchCode, branchName: r.branch, status: "active", ...stamps });
    branchIds.set(r.branchCode, BigInt(res.insertId));
  }

  const [h] = await db.insert(brands).values({ brandCode: "HITACHI", brandName: "日立", status: "active", ...stamps });
  const [s] = await db.insert(brands).values({ brandCode: "HISENSE", brandName: "海信", status: "active", ...stamps });
  const [sec] = await db
    .insert(sectors)
    .values({ branchId: branchIds.get("101")!, sectorCode: "SEC-HOME", sectorName: "家装", status: "active", ...stamps });
  const [d] = await db.insert(dealers).values({ dealerCode: "D-001", dealerName: "测试经销商", status: "active", ...stamps });

  const hitachiBrandId = BigInt(h.insertId);
  const hisenseBrandId = BigInt(s.insertId);
  const sectorId = BigInt(sec.insertId);
  const dealerId = BigInt(d.insertId);
  const storeBase = { dealerId, sectorId, status: "active", ...stamps };
  const [st1] = await db.insert(stores).values({ storeCode: "S-001", storeName: "测试门店一", brandId: hitachiBrandId, ...storeBase });
  const [st2] = await db.insert(stores).values({ storeCode: "S-002", storeName: "测试门店二", brandId: hisenseBrandId, ...storeBase });
  const storeId = BigInt(st1.insertId);
  const otherStoreId = BigInt(st2.insertId);

  const staff = (storeIdValue: bigint, name: string, phone: string, status = "active", staffId?: bigint) => ({
    ...(staffId === undefined ? {} : { staffId }),
    storeId: storeIdValue,
    staffName: name,
    phone,
    status,
    ...stamps,
  });
  const [a] = await db.insert(mediaStaff).values(staff(storeId, "专员甲", "13800000001"));
  const [b] = await db.insert(mediaStaff).values(staff(storeId, "专员乙", "13800000002"));
  await db.insert(mediaStaff).values(staff(otherStoreId, "专员丙", "13800000003", "active", BIG_STAFF_ID));
  const [i] = await db.insert(mediaStaff).values(staff(storeId, "专员丁", "13800000004", "inactive"));

  return {
    regionIds,
    branchIds,
    hitachiBrandId,
    hisenseBrandId,
    sectorId,
    dealerId,
    storeId,
    otherStoreId,
    staffA: BigInt(a.insertId),
    staffB: BigInt(b.insertId),
    staffC: BIG_STAFF_ID,
    staffInactive: BigInt(i.insertId),
  };
}

/** 测试用同步设置。取值仅用于测试：生产的 list_safety_page_limit 等 v2 未定，由运维显式配置。 */
export async function seedSyncSettings(db: Db, now: Date, overrides: Partial<{ initialContentLimit: number }> = {}): Promise<void> {
  await db.insert(syncSettings).values({
    settingsId: 1,
    scheduleSlots: [{ weekday: 1, time: "02:00" }],
    initialContentLimit: overrides.initialContentLimit ?? 20,
    listSafetyPageLimit: 5,
    commentPageLimit: 5,
    taskMaxAttempts: 3,
    configVersion: 1n,
    createdAt: now,
    updatedAt: now,
  });
}

export async function platformIdOf(db: Db, code: string): Promise<bigint> {
  const [row] = await db.select({ id: platforms.platformId }).from(platforms).where(eq(platforms.platformCode, code));
  if (!row) throw new Error(`没有平台 ${code}`);
  return row.id;
}

export async function providerIdOf(db: Db, code = "aimaster"): Promise<bigint> {
  const [row] = await db.select({ id: dataProviders.providerId }).from(dataProviders).where(eq(dataProviders.providerCode, code));
  if (!row) throw new Error(`没有供应商 ${code}`);
  return row.id;
}
