// f-video-square 任务 1（acceptance A17）：square_brand_policies 的 CHECK 与外键在真实 MySQL 8.4 上被强制。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessEnv, seedAccessOrg } from "../../tests/harness/access";
import { expectRejected, useTestDb } from "../../tests/harness/db";
import { runMigrations } from "./client";
import { brands, squareBrandPolicies } from "./schema";

const NOW = new Date("2026-11-19T02:00:00.000000Z");
const t = useTestDb();
const row = (brandId: bigint, viewMode: string) => ({ brandId, viewMode, updatedByActor: "user:1", createdAt: NOW, updatedAt: NOW });

describe("square_brand_policies 约束", () => {
  it("迁移连跑两次无变更；合法值可写", async () => {
    await runMigrations(t.db);
    await runMigrations(t.db);
    const org = await seedAccessOrg(accessEnv(t, { flow: false }));
    await t.db.insert(squareBrandPolicies).values([row(org.hisense, "own"), row(org.hitachi, "all")]);
    expect(await t.db.select().from(squareBrandPolicies)).toHaveLength(2);
  });
  it("view_mode 只能是 all / own", async () => {
    const org = await seedAccessOrg(accessEnv(t, { flow: false }));
    await expectRejected(t.db.insert(squareBrandPolicies).values(row(org.hisense, "some")), "ck_square_policies_mode");
  });
  it("品牌必须存在；每个品牌一行；有策略的品牌不能删除（RESTRICT）", async () => {
    const org = await seedAccessOrg(accessEnv(t, { flow: false }));
    await expectRejected(t.db.insert(squareBrandPolicies).values(row(999_999n, "own")), "fk_square_policies_brand");
    await t.db.insert(squareBrandPolicies).values(row(org.york, "own"));
    await expectRejected(t.db.insert(squareBrandPolicies).values(row(org.york, "all")), "PRIMARY");
    await expectRejected(t.db.delete(brands).where(eq(brands.brandId, org.york)), "fk_square_policies_brand");
  });
});
