// v2 §7 组织主档。业务主档不使用 ON DELETE CASCADE（全部 RESTRICT）。
import { sql } from "drizzle-orm";
import { type AnyMySqlColumn, boolean, check, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { binText, id, inList, utc } from "../columns";

const status = () => varchar("status", { length: 32 }).notNull();
const stamps = () => ({ createdAt: utc("created_at").notNull(), updatedAt: utc("updated_at").notNull() });
const ACTIVE = ["active", "inactive"] as const;

export const brands = mysqlTable(
  "brands",
  {
    brandId: id("brand_id").primaryKey().autoincrement(),
    brandCode: binText("brand_code", { length: 64 }).notNull(),
    brandName: varchar("brand_name", { length: 128 }).notNull(),
    status: status(),
    ...stamps(),
  },
  (t) => [
    uniqueIndex("uq_brands_code").on(t.brandCode),
    uniqueIndex("uq_brands_name").on(t.brandName),
    check("ck_brands_status", inList(t.status, ACTIVE)),
  ],
);

export const regions = mysqlTable(
  "regions",
  {
    regionId: id("region_id").primaryKey().autoincrement(),
    regionCode: binText("region_code", { length: 64 }).notNull(),
    regionName: varchar("region_name", { length: 128 }).notNull(),
    status: status(),
    ...stamps(),
  },
  (t) => [uniqueIndex("uq_regions_code").on(t.regionCode), check("ck_regions_status", inList(t.status, ACTIVE))],
);

export const branches = mysqlTable(
  "branches",
  {
    branchId: id("branch_id").primaryKey().autoincrement(),
    regionId: id("region_id")
      .notNull()
      .references((): AnyMySqlColumn => regions.regionId),
    branchCode: binText("branch_code", { length: 64 }).notNull(),
    branchName: varchar("branch_name", { length: 128 }).notNull(),
    status: status(),
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    ...stamps(),
  },
  (t) => [
    uniqueIndex("uq_branches_code").on(t.branchCode),
    uniqueIndex("uq_branches_region_name").on(t.regionId, t.branchName),
    index("idx_branches_region_status").on(t.regionId, t.status),
    check("ck_branches_status", inList(t.status, ACTIVE)),
  ],
);

export const sectors = mysqlTable(
  "sectors",
  {
    sectorId: id("sector_id").primaryKey().autoincrement(),
    branchId: id("branch_id")
      .notNull()
      .references((): AnyMySqlColumn => branches.branchId),
    sectorCode: binText("sector_code", { length: 64 }).notNull(),
    sectorName: varchar("sector_name", { length: 128 }).notNull(),
    status: status(),
    ...stamps(),
  },
  (t) => [
    uniqueIndex("uq_sectors_code").on(t.sectorCode),
    uniqueIndex("uq_sectors_branch_name").on(t.branchId, t.sectorName),
    index("idx_sectors_branch_status").on(t.branchId, t.status),
    check("ck_sectors_status", inList(t.status, ACTIVE)),
  ],
);

export const dealers = mysqlTable(
  "dealers",
  {
    dealerId: id("dealer_id").primaryKey().autoincrement(),
    dealerCode: binText("dealer_code", { length: 64 }),
    dealerName: varchar("dealer_name", { length: 200 }).notNull(),
    status: status(),
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    ...stamps(),
  },
  (t) => [
    uniqueIndex("uq_dealers_code").on(t.dealerCode),
    index("idx_dealers_name").on(t.dealerName),
    index("idx_dealers_status_monitoring").on(t.status, t.monitoringEnabled),
    check("ck_dealers_status", inList(t.status, ACTIVE)),
  ],
);

export const stores = mysqlTable(
  "stores",
  {
    storeId: id("store_id").primaryKey().autoincrement(),
    storeCode: binText("store_code", { length: 64 }).notNull(),
    storeName: varchar("store_name", { length: 200 }).notNull(),
    dealerId: id("dealer_id")
      .notNull()
      .references((): AnyMySqlColumn => dealers.dealerId),
    brandId: id("brand_id")
      .notNull()
      .references((): AnyMySqlColumn => brands.brandId),
    sectorId: id("sector_id")
      .notNull()
      .references((): AnyMySqlColumn => sectors.sectorId),
    storeTier: varchar("store_tier", { length: 64 }),
    status: status(),
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    // v2 §7.6：最近一次写入该行的 import_batches。import_batches 属于 a-master-data-import（其 v2 修订尚未合入），
    // 本 spec 不建该表，所以这里先不挂外键；该 spec 建表时再补 FK。
    sourceBatchId: id("source_batch_id"),
    ...stamps(),
  },
  (t) => [
    uniqueIndex("uq_stores_brand_code").on(t.brandId, t.storeCode),
    index("idx_stores_dealer_status").on(t.dealerId, t.status),
    index("idx_stores_brand_status").on(t.brandId, t.status),
    index("idx_stores_sector_status").on(t.sectorId, t.status),
    index("idx_stores_source_batch").on(t.sourceBatchId),
    check("ck_stores_status", inList(t.status, ["active", "closed"])),
  ],
);

export const mediaStaff = mysqlTable(
  "media_staff",
  {
    staffId: id("staff_id").primaryKey().autoincrement(),
    storeId: id("store_id")
      .notNull()
      .references((): AnyMySqlColumn => stores.storeId),
    staffName: varchar("staff_name", { length: 100 }).notNull(),
    phone: varchar("phone", { length: 32 }).notNull(),
    status: status(),
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    // D-70：手机号只在有效专员中唯一，停用专员保留原号但不占号
    activePhone: varchar("active_phone", { length: 32 }).generatedAlwaysAs(sql`(CASE WHEN status = 'active' THEN phone END)`, {
      mode: "stored",
    }),
    ...stamps(),
  },
  (t) => [
    uniqueIndex("uq_media_staff_active_phone").on(t.activePhone),
    index("idx_media_staff_phone").on(t.phone),
    index("idx_media_staff_store").on(t.storeId, t.status, t.monitoringEnabled),
    check("ck_media_staff_status", inList(t.status, ACTIVE)),
  ],
);
