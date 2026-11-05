// RefReader 的两种实现：预检用一次性内存快照（8k 行文件不逐行查库）；确认用事务内实时查询。
// ponytail: 快照加载全部门店与经销商，量级是万级；到十万级再改成按文件内出现的键分批取。
import { and, eq } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { branches, brands, dealers, sectors, stores } from "../../db/schema";
import type { BranchRef, BrandRef, DealerRef, RefReader, StoreRef } from "./classify";

const toStore = (r: typeof stores.$inferSelect): StoreRef => ({
  id: r.storeId,
  brandId: r.brandId,
  code: r.storeCode,
  name: r.storeName,
  tier: r.storeTier,
  dealerId: r.dealerId,
  sectorId: r.sectorId,
  status: r.status,
  sourceBatchId: r.sourceBatchId,
});

export interface Snapshot extends RefReader {
  /** 全部门店，供待确认撤店计算。 */
  allStores: StoreRef[];
  brandIdByCode: Map<string, bigint>;
  dealerCodeById: Map<bigint, string>;
  sectorCodeById: Map<bigint, string>;
}

export async function loadSnapshot(db: Db | DbTx): Promise<Snapshot> {
  const [bs, brs, ss, ds, sts] = await Promise.all([
    db.select().from(brands),
    db.select().from(branches),
    db.select().from(sectors),
    db.select().from(dealers),
    db.select().from(stores),
  ]);
  const brandMap = new Map(bs.map((b) => [b.brandCode, { id: b.brandId, status: b.status } satisfies BrandRef]));
  const branchMap = new Map(brs.map((b) => [b.branchCode, { id: b.branchId, status: b.status, name: b.branchName } satisfies BranchRef]));
  const sectorMap = new Map(ss.map((s) => [`${s.branchId}|${s.sectorName}`, { id: s.sectorId, status: s.status } satisfies BrandRef]));
  const dealerMap = new Map<string, DealerRef>();
  for (const d of ds) if (d.dealerCode !== null) dealerMap.set(d.dealerCode, { id: d.dealerId, status: d.status, name: d.dealerName });
  const allStores = sts.map(toStore);
  const storeMap = new Map(allStores.map((s) => [`${s.brandId}|${s.code}`, s]));
  return {
    allStores,
    brandIdByCode: new Map(bs.map((b) => [b.brandCode, b.brandId])),
    dealerCodeById: new Map(ds.filter((d) => d.dealerCode !== null).map((d) => [d.dealerId, d.dealerCode!])),
    sectorCodeById: new Map(ss.map((x) => [x.sectorId, x.sectorCode])),
    brand: async (c) => brandMap.get(c),
    branch: async (c) => branchMap.get(c),
    sector: async (branchId, name) => sectorMap.get(`${branchId}|${name}`),
    dealer: async (c) => dealerMap.get(c),
    store: async (brandId, c) => storeMap.get(`${brandId}|${c}`),
  };
}

/** 确认阶段：每次都读最新值（并发的人工结构变更要能被看见）。 */
export function liveRefs(tx: DbTx): RefReader {
  return {
    brand: async (c) => {
      const [r] = await tx.select({ id: brands.brandId, status: brands.status }).from(brands).where(eq(brands.brandCode, c));
      return r;
    },
    branch: async (c) => {
      const [r] = await tx.select({ id: branches.branchId, status: branches.status, name: branches.branchName }).from(branches).where(eq(branches.branchCode, c));
      return r;
    },
    sector: async (branchId, name) => {
      const [r] = await tx
        .select({ id: sectors.sectorId, status: sectors.status })
        .from(sectors)
        .where(and(eq(sectors.branchId, branchId), eq(sectors.sectorName, name)));
      return r;
    },
    dealer: async (c) => {
      const [r] = await tx.select({ id: dealers.dealerId, status: dealers.status, name: dealers.dealerName }).from(dealers).where(eq(dealers.dealerCode, c));
      return r;
    },
    store: async (brandId, c) => {
      const [r] = await tx.select().from(stores).where(and(eq(stores.brandId, brandId), eq(stores.storeCode, c)));
      return r ? toStore(r) : undefined;
    },
  };
}
