import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { seedOrg, type OrgSeed } from "../../../tests/harness/seed";
import { addExternalAccount, addStaffAccount } from "../../../tests/harness/sync-fixtures";
import { branches, brands, dealers, externalAccounts, mediaStaff, regions, staffAccountAssignments, stores } from "../../db/schema";
import { createMonitoringResolver } from "./resolver";

const NOW = new Date("2026-11-05T08:00:00Z");
const t = useTestDb();

async function setup() {
  const org = await seedOrg(t.db, NOW);
  const { accountId } = await addStaffAccount(t.db, { platform: "douyin", staffId: org.staffA, now: NOW });
  return { org, accountId, resolver: createMonitoringResolver(t.db) };
}
const targetIds = async (r: ReturnType<typeof createMonitoringResolver>) => (await r.targets({ afterAccountId: null, limit: 100 })).rows.map((x) => x.accountId);

describe("有效监控目标集：targets 与 explain 用同一套条件（FS-2）", () => {
  it("全部有效 → 在目标集中，explain 有效", async () => {
    const { accountId, resolver } = await setup();
    expect(await targetIds(resolver)).toEqual([accountId]);
    expect(await resolver.explain(accountId)).toEqual({ effective: true, reason: null });
  });

  // 对组织树做一处修改 → 账号必须不在目标集里，且 explain 给出预期原因
  const cases: Array<[string, (o: OrgSeed, a: bigint) => Promise<unknown>, string]> = [
    ["品牌停用", (o) => t.db.update(brands).set({ status: "inactive" }).where(eq(brands.brandId, o.hitachiBrandId)), "brand_inactive"],
    [
      "大区停用",
      async (o) => {
        const [b] = await t.db.select().from(branches).where(eq(branches.branchId, o.branchIds.get("101")!));
        return t.db.update(regions).set({ status: "inactive" }).where(eq(regions.regionId, b!.regionId));
      },
      "region_inactive",
    ],
    ["分公司停用", (o) => t.db.update(branches).set({ status: "inactive" }).where(eq(branches.branchId, o.branchIds.get("101")!)), "branch_inactive"],
    ["分公司关闭监控", (o) => t.db.update(branches).set({ monitoringEnabled: false }).where(eq(branches.branchId, o.branchIds.get("101")!)), "branch_off"],
    ["经销商停用", (o) => t.db.update(dealers).set({ status: "inactive" }).where(eq(dealers.dealerId, o.dealerId)), "dealer_inactive"],
    ["经销商关闭监控", (o) => t.db.update(dealers).set({ monitoringEnabled: false }).where(eq(dealers.dealerId, o.dealerId)), "dealer_off"],
    ["门店撤店", (o) => t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeId, o.storeId)), "store_closed"],
    ["门店关闭监控", (o) => t.db.update(stores).set({ monitoringEnabled: false }).where(eq(stores.storeId, o.storeId)), "store_off"],
    ["专员停用", (o) => t.db.update(mediaStaff).set({ status: "inactive" }).where(eq(mediaStaff.staffId, o.staffA)), "staff_inactive"],
    ["专员关闭监控", (o) => t.db.update(mediaStaff).set({ monitoringEnabled: false }).where(eq(mediaStaff.staffId, o.staffA)), "staff_off"],
    [
      "账号归属关闭监控",
      (_o, a) => t.db.update(staffAccountAssignments).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(staffAccountAssignments.accountId, a)),
      "account_off",
    ],
    ["账号 deleted", (_o, a) => t.db.update(externalAccounts).set({ status: "deleted" }).where(eq(externalAccounts.accountId, a)), "deleted"],
    [
      "疑似空账号",
      (_o, a) => t.db.update(staffAccountAssignments).set({ intakeStatus: "suspected_empty" }).where(eq(staffAccountAssignments.accountId, a)),
      "suspected_empty",
    ],
  ];
  it.each(cases)("%s → %s", async (_name, mutate, reason) => {
    const { org, accountId, resolver } = await setup();
    await mutate(org, accountId);
    expect(await targetIds(resolver)).toEqual([]);
    expect(await resolver.explain(accountId)).toEqual({ effective: false, reason });
  });

  it("账号 unavailable 仍在目标集（技术 / 业务不可访问不改变采集资格）", async () => {
    const { accountId, resolver } = await setup();
    await t.db.update(externalAccounts).set({ status: "unavailable" }).where(eq(externalAccounts.accountId, accountId));
    expect(await targetIds(resolver)).toEqual([accountId]);
    expect((await resolver.explain(accountId)).effective).toBe(true);
  });

  it("上级关闭后下级自身开关不被改写；上级恢复后继续采集", async () => {
    const { org, accountId, resolver } = await setup();
    await t.db.update(dealers).set({ monitoringEnabled: false }).where(eq(dealers.dealerId, org.dealerId));
    expect(await targetIds(resolver)).toEqual([]);
    const [store] = await t.db.select().from(stores).where(eq(stores.storeId, org.storeId));
    const [staff] = await t.db.select().from(mediaStaff).where(eq(mediaStaff.staffId, org.staffA));
    const [assign] = await t.db.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.accountId, accountId));
    expect([store!.monitoringEnabled, staff!.monitoringEnabled, assign!.monitoringEnabled]).toEqual([true, true, true]);
    await t.db.update(dealers).set({ monitoringEnabled: true }).where(eq(dealers.dealerId, org.dealerId));
    expect(await targetIds(resolver)).toEqual([accountId]);
  });

  it("多处同时不满足：原因取最上级；targets 与 explain 一致", async () => {
    const { org, accountId, resolver } = await setup();
    await t.db.update(stores).set({ monitoringEnabled: false }).where(eq(stores.storeId, org.storeId));
    await t.db.update(mediaStaff).set({ status: "inactive" }).where(eq(mediaStaff.staffId, org.staffA));
    await t.db.update(dealers).set({ monitoringEnabled: false }).where(eq(dealers.dealerId, org.dealerId));
    expect((await resolver.explain(accountId)).reason).toBe("dealer_off");
    expect(await targetIds(resolver)).toEqual([]);
  });

  it("external 型不受五级与品牌 / 大区影响，只受账号状态与自身开关约束", async () => {
    const { org, resolver } = await setup();
    const on = await addExternalAccount(t.db, { platform: "kuaishou", now: NOW });
    const off = await addExternalAccount(t.db, { platform: "kuaishou", now: NOW, enabled: false });
    // 把整棵组织树关掉：staff 型全部失效，external 不变
    await t.db.update(brands).set({ status: "inactive" }).where(eq(brands.brandId, org.hitachiBrandId));
    await t.db.update(dealers).set({ monitoringEnabled: false }).where(eq(dealers.dealerId, org.dealerId));
    expect(await targetIds(resolver)).toEqual([on.accountId]);
    expect(await resolver.explain(on.accountId)).toEqual({ effective: true, reason: null });
    expect(await resolver.explain(off.accountId)).toEqual({ effective: false, reason: "account_off" });
  });

  it("没有归属行的账号：explain 说明 no_assignment，不抛错", async () => {
    const { resolver } = await setup();
    expect(await resolver.explain(999999n)).toEqual({ effective: false, reason: "no_assignment" });
  });

  it("分块：每块 ≤ limit，按 account_id 游标不重不漏；accountIds 过滤只取指定账号", async () => {
    const { resolver } = await setup();
    // 再补 6 个外部账号凑够多块
    for (let i = 0; i < 6; i++) await addExternalAccount(t.db, { platform: "douyin", now: NOW });
    const all = await targetIds(resolver);
    expect(all.length).toBeGreaterThanOrEqual(7);
    const seen: bigint[] = [];
    let after: bigint | null = null;
    let chunks = 0;
    for (;;) {
      const c = await resolver.targets({ afterAccountId: after, limit: 3 });
      expect(c.rows.length).toBeLessThanOrEqual(3);
      seen.push(...c.rows.map((r) => r.accountId));
      chunks++;
      if (c.next === null) break;
      after = c.next;
    }
    expect(seen).toEqual(all);
    expect(chunks).toBeGreaterThan(1);
    const picked = [all[0]!, all[2]!];
    expect((await resolver.targets({ afterAccountId: null, limit: 100, accountIds: picked })).rows.map((r) => r.accountId)).toEqual(picked);
  });
});
