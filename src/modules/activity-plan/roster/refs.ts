// 名单行分类用的引用读取器（design §7.3）：按本批行里出现的键整批预加载，再给 classify 同步查表。
// 预检传 db（只读快照），确认写入的每个块传事务（实时读取）。入口文本命中：哈希是索引，命中后复核原文。
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { activityPlanBranches, activityPlanRoster, brands, mediaStaff, sectors, staffAccountAssignments as aa, stores } from "../../../db/schema";
import { sha256Utf8 } from "../../canonical-json";
import { sectorKeyOf } from "../../master-data-import/mappings.v1";
import type { LocalAccountRef, RosterRefs, StaffRef, StoreRef } from "./classify";

const CHUNK = 500;
const chunks = <T>(xs: readonly T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

export interface RefKeys {
  storeCodes: readonly string[];
  phones: readonly string[];
  /** 入口原文与清洗后文本（成对） */
  locators: ReadonlyArray<{ original: string; cleaned: string }>;
}
export async function loadRosterRefs(db: Db | DbTx, plan: { planId: bigint; brandId: bigint; platformId: bigint }, keys: RefKeys): Promise<RosterRefs> {
  const storeCodes = [...new Set(keys.storeCodes)];
  const phones = [...new Set(keys.phones)];
  const storeMap = new Map<string, StoreRef>();
  const otherBrands = new Map<string, string[]>();
  for (const part of chunks(storeCodes)) {
    const rows = await db
      .select({ code: stores.storeCode, storeId: stores.storeId, status: stores.status, sectorCode: sectors.sectorCode, branchId: sectors.branchId })
      .from(stores)
      .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
      .where(and(eq(stores.brandId, plan.brandId), inArray(stores.storeCode, part)));
    for (const r of rows) storeMap.set(r.code, { storeId: r.storeId, status: r.status, sectorKey: sectorKeyOf(r.sectorCode), branchId: r.branchId });
    const others = await db
      .select({ code: stores.storeCode, brandCode: brands.brandCode })
      .from(stores)
      .innerJoin(brands, eq(brands.brandId, stores.brandId))
      .where(and(inArray(stores.storeCode, part), ne(stores.brandId, plan.brandId), eq(stores.status, "active")));
    for (const r of others) otherBrands.set(r.code, [...(otherBrands.get(r.code) ?? []), r.brandCode]);
  }
  const participation = new Map<bigint, "joined" | "exited">();
  for (const r of await db.select().from(activityPlanBranches).where(eq(activityPlanBranches.planId, plan.planId))) participation.set(r.branchId, r.status as "joined" | "exited");

  const staffMap = new Map<string, StaffRef[]>();
  for (const part of chunks(phones)) {
    for (const r of await db.select({ staffId: mediaStaff.staffId, storeId: mediaStaff.storeId, name: mediaStaff.staffName, status: mediaStaff.status, phone: mediaStaff.phone }).from(mediaStaff).where(inArray(mediaStaff.phone, part))) {
      staffMap.set(r.phone, [...(staffMap.get(r.phone) ?? []), { staffId: r.staffId, storeId: r.storeId, name: r.name, status: r.status }]);
    }
  }

  // 入口命中：先按哈希取候选，再复核原文（current_home_locator 等于提交原文，或 resolved_home_url 等于清洗后文本）
  const byOriginal = new Map<string, LocalAccountRef>();
  const byCleaned = new Map<string, LocalAccountRef>();
  const hashes = [...new Set(keys.locators.flatMap((l) => [l.original, l.cleaned]))].map((t) => sha256Utf8(t));
  const wantOriginal = new Set(keys.locators.map((l) => l.original));
  const wantCleaned = new Set(keys.locators.map((l) => l.cleaned));
  for (const part of chunks(hashes)) {
    const rows = await db
      .select({ accountId: aa.accountId, staffId: aa.staffId, current: aa.currentHomeLocator, resolved: aa.resolvedHomeUrl })
      .from(aa)
      .where(and(eq(aa.platformId, plan.platformId), inArray(aa.currentHomeLocatorSha256, part)));
    for (const r of rows) {
      if (wantOriginal.has(r.current)) byOriginal.set(r.current, { accountId: r.accountId, ownerStaffId: r.staffId });
    }
    const rows2 = await db
      .select({ accountId: aa.accountId, staffId: aa.staffId, resolved: aa.resolvedHomeUrl })
      .from(aa)
      .where(and(eq(aa.platformId, plan.platformId), inArray(aa.resolvedHomeUrlSha256, part)));
    for (const r of rows2) {
      if (wantCleaned.has(r.resolved)) byCleaned.set(r.resolved, { accountId: r.accountId, ownerStaffId: r.staffId });
    }
  }
  const matched = [...new Set([...byOriginal.values(), ...byCleaned.values()].map((m) => m.accountId))];
  const entryMap = new Map<bigint, { state: "in_roster" | "removed"; staffId: bigint }>();
  for (const part of chunks(matched)) {
    for (const r of await db.select().from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, plan.planId), inArray(activityPlanRoster.accountId, part)))) {
      entryMap.set(r.accountId, { state: r.entryState as "in_roster" | "removed", staffId: r.staffId });
    }
  }
  return {
    store: (code) => storeMap.get(code),
    otherBrandCodes: (code) => otherBrands.get(code) ?? [],
    participation: (branchId) => participation.get(branchId),
    staffByPhone: (phone) => staffMap.get(phone) ?? [],
    matchAccount: (original, cleaned) => byOriginal.get(original) ?? byCleaned.get(cleaned),
    rosterEntry: (accountId) => entryMap.get(accountId),
  };
}
