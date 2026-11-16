// 主数据浏览（a-master-data-browse design §5）：只读查询门店与分公司，不写任何表、不产生审计。
// 授权与品牌范围复用主数据导入的 ActorContext；错误类型复用 MasterDataError。
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { branches, brands, dealers, regions, sectors, stores } from "../../db/schema";
import { assertImport, type ActorContext } from "./authorization";
import { MasterDataError } from "./errors";

export type StoreStatus = "active" | "closed";
export type PageSize = 20 | 50 | 100;
export const PAGE_SIZES: readonly PageSize[] = [20, 50, 100];

export interface BrowseFilter {
  /** 十进制字符串。 */
  brandId?: string;
  /** 十进制字符串。 */
  branchId?: string;
  /** 板块名称，精确匹配（sectors.sector_name）。 */
  sectorName?: string;
  /** 店面标准，精确匹配（stores.store_tier）。 */
  tier?: string;
  /** true = 只看 store_tier IS NULL；与 tier 互斥。 */
  tierMissing?: boolean;
  /** 未指定 = 全部。 */
  status?: StoreStatus;
  /** 门店编码或名称（分公司视图：分公司编码或名称）。 */
  keyword?: string;
  /** 1 起。 */
  page: number;
  pageSize: PageSize;
}

export interface StoreListItem {
  storeId: string;
  storeCode: string;
  storeName: string;
  brandCode: string;
  brandName: string;
  branchCode: string;
  branchName: string;
  sectorCode: string;
  sectorName: string;
  dealerCode: string | null;
  dealerName: string;
  storeTier: string | null;
  status: StoreStatus;
  /** ISO-8601 UTC。 */
  updatedAt: string;
}

export interface BranchListItem {
  branchId: string;
  branchCode: string;
  branchName: string;
  regionName: string;
  activeStoreCount: number;
  closedStoreCount: number;
  /** ISO-8601 UTC。 */
  updatedAt: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: PageSize;
}

export interface BrowseFilterOptions {
  sectorNames: string[];
  storeTiers: string[];
  hasMissingTier: boolean;
  /** 授权品牌范围内的门店数（页面视图上的「门店 · N」）。 */
  storeCount: number;
  /** 分公司总数（跨品牌共享对象，不按品牌收窄）。 */
  branchCount: number;
}

const invalid = (message: string): MasterDataError => new MasterDataError("input", "invalid_filter", message);

/** LIKE 的通配符与转义符本身按字面处理；与 SQL 里的 ESCAPE '\\' 配套。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const DECIMAL_ID = /^\d{1,19}$/;
const MAX_SIGNED_BIGINT = 9223372036854775807n;

function decimalId(value: string, field: string): bigint {
  if (!DECIMAL_ID.test(value)) throw invalid(`${field} 必须是十进制数字`);
  const n = BigInt(value);
  if (n <= 0n || n > MAX_SIGNED_BIGINT) throw invalid(`${field} 超出范围`);
  return n;
}

/** 校验并归一化：空白关键字 / 板块视为未指定；非法值一律报错，不静默退化为「全部」。 */
export function normalizeFilter(input: BrowseFilter): BrowseFilter {
  if (!Number.isInteger(input.page) || input.page < 1) throw invalid("page 必须是正整数");
  if (!PAGE_SIZES.includes(input.pageSize)) throw invalid("pageSize 只能是 20 / 50 / 100");
  const status = input.status as string | undefined;
  if (status !== undefined && status !== "active" && status !== "closed") throw invalid("status 只能是 active 或 closed");
  const keyword = input.keyword?.trim();
  if (keyword && keyword.length > 64) throw invalid("关键字最多 64 个字符");
  const sectorName = input.sectorName?.trim();
  if (sectorName && sectorName.length > 128) throw invalid("板块名称最多 128 个字符");
  const tier = input.tier?.trim();
  if (tier && tier.length > 64) throw invalid("店面标准最多 64 个字符");
  if (tier && input.tierMissing) throw invalid("店面标准与「未设置」不能同时筛选");
  if (input.brandId !== undefined) decimalId(input.brandId, "brandId");
  if (input.branchId !== undefined) decimalId(input.branchId, "branchId");
  const out: BrowseFilter = { page: input.page, pageSize: input.pageSize };
  if (input.brandId !== undefined) out.brandId = input.brandId;
  if (input.branchId !== undefined) out.branchId = input.branchId;
  if (keyword) out.keyword = keyword;
  if (sectorName) out.sectorName = sectorName;
  if (tier) out.tier = tier;
  if (input.tierMissing === true) out.tierMissing = true;
  if (input.status !== undefined) out.status = input.status;
  return out;
}

/** 品牌范围：`brand_id IN (SELECT brand_id FROM brands WHERE brand_code IN (:codes))`。空集合 = FALSE，不是「不加谓词」。 */
function brandScopePredicate(actor: ActorContext): SQL | undefined {
  if (actor.brandScope === "all") return undefined;
  const codes = [...actor.brandScope];
  if (codes.length === 0) return sql`FALSE`;
  const sub = sql`(SELECT ${brands.brandId} FROM ${brands} WHERE ${inArray(brands.brandCode, codes)})`;
  return sql`${stores.brandId} IN ${sub}`;
}

const defined = (parts: ReadonlyArray<SQL | undefined>): SQL | undefined => {
  const kept = parts.filter((p): p is SQL => p !== undefined);
  return kept.length ? and(...kept) : undefined;
};

function storeWhere(actor: ActorContext, f: BrowseFilter): SQL | undefined {
  const kw = f.keyword ? `%${escapeLike(f.keyword)}%` : undefined;
  const tierPredicate = f.tierMissing ? isNull(stores.storeTier) : f.tier ? eq(stores.storeTier, f.tier) : undefined;
  return defined([
    brandScopePredicate(actor),
    f.brandId ? eq(stores.brandId, BigInt(f.brandId)) : undefined,
    f.branchId ? eq(branches.branchId, BigInt(f.branchId)) : undefined,
    f.sectorName ? eq(sectors.sectorName, f.sectorName) : undefined,
    tierPredicate,
    f.status ? eq(stores.status, f.status) : undefined,
    kw ? sql`(${stores.storeCode} LIKE ${kw} ESCAPE '\\\\' OR ${stores.storeName} LIKE ${kw} ESCAPE '\\\\')` : undefined,
  ]);
}

function branchWhere(f: BrowseFilter): SQL | undefined {
  const kw = f.keyword ? `%${escapeLike(f.keyword)}%` : undefined;
  return kw ? sql`(${branches.branchCode} LIKE ${kw} ESCAPE '\\\\' OR ${branches.branchName} LIKE ${kw} ESCAPE '\\\\')` : undefined;
}

export function createBrowse(db: Db) {
  return {
    async stores(filter: BrowseFilter, actor: ActorContext): Promise<PageResult<StoreListItem>> {
      assertImport(actor);
      const f = normalizeFilter(filter);
      const where = storeWhere(actor, f);
      const rows = await db
        .select({
          storeId: stores.storeId,
          storeCode: stores.storeCode,
          storeName: stores.storeName,
          brandCode: brands.brandCode,
          brandName: brands.brandName,
          branchCode: branches.branchCode,
          branchName: branches.branchName,
          sectorCode: sectors.sectorCode,
          sectorName: sectors.sectorName,
          dealerCode: dealers.dealerCode,
          dealerName: dealers.dealerName,
          storeTier: stores.storeTier,
          status: stores.status,
          updatedAt: stores.updatedAt,
        })
        .from(stores)
        .innerJoin(brands, eq(brands.brandId, stores.brandId))
        .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
        .innerJoin(branches, eq(branches.branchId, sectors.branchId))
        .innerJoin(dealers, eq(dealers.dealerId, stores.dealerId))
        .where(where)
        .orderBy(asc(brands.brandCode), asc(branches.branchCode), asc(stores.storeCode), asc(stores.storeId))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize);
      // 总数与列表用同一条谓词（ui-foundation §4.1）
      const [counted] = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(stores)
        .innerJoin(brands, eq(brands.brandId, stores.brandId))
        .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
        .innerJoin(branches, eq(branches.branchId, sectors.branchId))
        .innerJoin(dealers, eq(dealers.dealerId, stores.dealerId))
        .where(where);
      return {
        items: rows.map((r) => ({
          ...r,
          storeId: String(r.storeId),
          status: r.status as StoreStatus,
          updatedAt: r.updatedAt.toISOString(),
        })),
        total: Number(counted?.n ?? 0),
        page: f.page,
        pageSize: f.pageSize,
      };
    },

    async branches(filter: BrowseFilter, actor: ActorContext): Promise<PageResult<BranchListItem>> {
      assertImport(actor);
      const f = normalizeFilter(filter);
      const where = branchWhere(f);
      const scope = brandScopePredicate(actor);
      const storesOn = scope ? and(eq(stores.sectorId, sectors.sectorId), scope) : eq(stores.sectorId, sectors.sectorId);
      const rows = await db
        .select({
          branchId: branches.branchId,
          branchCode: branches.branchCode,
          branchName: branches.branchName,
          regionName: regions.regionName,
          updatedAt: branches.updatedAt,
          activeStoreCount: sql<number>`COALESCE(SUM(CASE WHEN ${stores.status} = 'active' THEN 1 ELSE 0 END), 0)`,
          closedStoreCount: sql<number>`COALESCE(SUM(CASE WHEN ${stores.status} = 'closed' THEN 1 ELSE 0 END), 0)`,
        })
        .from(branches)
        .innerJoin(regions, eq(regions.regionId, branches.regionId))
        .leftJoin(sectors, eq(sectors.branchId, branches.branchId))
        .leftJoin(stores, storesOn)
        .where(where)
        .groupBy(branches.branchId, branches.branchCode, branches.branchName, regions.regionName, branches.updatedAt)
        .orderBy(asc(branches.branchCode), asc(branches.branchId))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize);
      const [counted] = await db
        .select({ n: sql<number>`COUNT(DISTINCT ${branches.branchId})` })
        .from(branches)
        .where(where);
      return {
        items: rows.map((r) => ({
          ...r,
          branchId: String(r.branchId),
          activeStoreCount: Number(r.activeStoreCount),
          closedStoreCount: Number(r.closedStoreCount),
          updatedAt: r.updatedAt.toISOString(),
        })),
        total: Number(counted?.n ?? 0),
        page: f.page,
        pageSize: f.pageSize,
      };
    },

    /** 板块 / 店面标准筛选选项：只统计读取者授权品牌内的门店。 */
    async filterOptions(actor: ActorContext): Promise<BrowseFilterOptions> {
      assertImport(actor);
      const scope = brandScopePredicate(actor);
      const [sectorRows, tierRows, missing, storeTotal, branchTotal] = await Promise.all([
        db
          .selectDistinct({ sectorName: sectors.sectorName })
          .from(stores)
          .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
          .where(scope)
          .orderBy(asc(sectors.sectorName)),
        db
          .selectDistinct({ tier: stores.storeTier })
          .from(stores)
          .where(scope ? and(scope, isNotNull(stores.storeTier)) : isNotNull(stores.storeTier))
          .orderBy(asc(stores.storeTier)),
        db
          .select({ n: sql<number>`COUNT(*)` })
          .from(stores)
          .where(scope ? and(scope, isNull(stores.storeTier)) : isNull(stores.storeTier)),
        db.select({ n: sql<number>`COUNT(*)` }).from(stores).where(scope),
        db.select({ n: sql<number>`COUNT(*)` }).from(branches),
      ]);
      return {
        sectorNames: sectorRows.map((r) => r.sectorName),
        storeTiers: tierRows.map((r) => r.tier).filter((t): t is string => t !== null),
        hasMissingTier: Number(missing[0]?.n ?? 0) > 0,
        storeCount: Number(storeTotal[0]?.n ?? 0),
        branchCount: Number(branchTotal[0]?.n ?? 0),
      };
    },
  };
}

export type Browse = ReturnType<typeof createBrowse>;