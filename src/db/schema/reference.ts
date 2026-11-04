// v2 §6 平台参考。identifier_namespaces 不建表（D-25）：命名空间是代码枚举 + CHECK。
import { check, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { binText, id, inList, utc } from "../columns";

export const platforms = mysqlTable(
  "platforms",
  {
    platformId: id("platform_id").primaryKey().autoincrement(),
    platformCode: binText("platform_code", { length: 64 }).notNull(),
    platformName: varchar("platform_name", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_platforms_code").on(t.platformCode), check("ck_platforms_status", inList(t.status, ["active", "inactive"]))],
);

export const dataProviders = mysqlTable(
  "data_providers",
  {
    providerId: id("provider_id").primaryKey().autoincrement(),
    providerCode: binText("provider_code", { length: 64 }).notNull(),
    providerName: varchar("provider_name", { length: 128 }).notNull(),
    baseEndpoint: varchar("base_endpoint", { length: 512 }),
    status: varchar("status", { length: 32 }).notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_data_providers_code").on(t.providerCode),
    check("ck_data_providers_status", inList(t.status, ["active", "inactive"])),
  ],
);
