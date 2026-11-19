// F 域「经销商视频广场」自有表（f-video-square design §4.1；不写入 v2）。
// 约定同 src/db/columns.ts：signed BIGINT、UTC DATETIME(6)、状态 VARCHAR + CHECK、无 ON DELETE CASCADE（全部 RESTRICT）。
import { check, foreignKey, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { id, inList, utc } from "../columns";
import { brands } from "./org";

/** all = 看全部品牌；own = 只看本品牌。没有行等同 all。 */
export const SQUARE_VIEW_MODES = ["all", "own"] as const;

/** 观看者品牌 → 观看范围策略（requirements R2）。 */
export const squareBrandPolicies = mysqlTable(
  "square_brand_policies",
  {
    brandId: id("brand_id").primaryKey(),
    viewMode: varchar("view_mode", { length: 8 }).notNull(),
    updatedByActor: varchar("updated_by_actor", { length: 128 }).notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_square_policies_brand", columns: [t.brandId], foreignColumns: [brands.brandId] }),
    check("ck_square_policies_mode", inList(t.viewMode, SQUARE_VIEW_MODES)),
  ],
);
