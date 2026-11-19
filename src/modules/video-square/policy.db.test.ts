// f-video-square 任务 3（acceptance A2、A4）：观看品牌范围策略与改策略的授权 / 审计。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditEvents, squareBrandPolicies } from "../../db/schema";
import { squareEnv } from "../../../tests/harness/square";
import { useTestDb } from "../../../tests/harness/db";
import { listBrandPolicies, setBrandPolicy, visibleBrands } from "./policy";
import { isSquareError } from "./errors";
import type { AuthContext } from "../access-control";

const t = useTestDb();
const NOW = new Date("2026-11-19T02:00:00.000Z");
const setOwn = async (brandId: bigint, mode = "own") => void (await t.db.insert(squareBrandPolicies).values({ brandId, viewMode: mode, updatedByActor: "user:1", createdAt: NOW, updatedAt: NOW }));
const kind = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return isSquareError(e) ? `${e.kind}:${e.code}` : "other";
  }
  return "ok";
};

describe("visibleBrands（R2.1–R2.3）", () => {
  it("没有策略行 = 全部品牌", async () => {
    const w = await squareEnv(t);
    const hq = await w.actor("hq_manager", { brandIds: [w.org.hisense] });
    expect(await visibleBrands(t.db, hq.scope)).toBe("all");
  });
  it("单品牌 own = 只看本品牌；策略为 all 的行同样等于全部", async () => {
    const w = await squareEnv(t);
    const hq = await w.actor("hq_manager", { brandIds: [w.org.hisense] });
    await setOwn(w.org.hisense);
    expect([...(await visibleBrands(t.db, hq.scope) as Set<bigint>)]).toEqual([w.org.hisense]);
    await t.db.update(squareBrandPolicies).set({ viewMode: "all" }).where(eq(squareBrandPolicies.brandId, w.org.hisense));
    expect(await visibleBrands(t.db, hq.scope)).toBe("all");
  });
  it("多品牌：任一品牌不是 own（含没有行）就看全部；全部都是 own 才只看这些品牌", async () => {
    const w = await squareEnv(t);
    const hq = await w.actor("hq_manager", { brandIds: [w.org.hisense, w.org.hitachi] });
    await setOwn(w.org.hisense);
    expect(await visibleBrands(t.db, hq.scope)).toBe("all"); // 日立没有行
    await setOwn(w.org.hitachi, "all");
    expect(await visibleBrands(t.db, hq.scope)).toBe("all");
    await t.db.update(squareBrandPolicies).set({ viewMode: "own" }).where(eq(squareBrandPolicies.brandId, w.org.hitachi));
    expect([...(await visibleBrands(t.db, hq.scope) as Set<bigint>)].sort()).toEqual([w.org.hisense, w.org.hitachi].sort());
  });
  it("超管（品牌范围 all）不受策略影响；空范围得到空集合而不是全部", async () => {
    const w = await squareEnv(t);
    const admin = await w.actor("platform_admin");
    for (const b of [w.org.hisense, w.org.hitachi, w.org.york]) await setOwn(b);
    expect(await visibleBrands(t.db, admin.scope)).toBe("all");
    const none = await w.actor("hq_manager", { brandIds: [] });
    expect((await visibleBrands(t.db, none.scope) as Set<bigint>).size).toBe(0);
  });
});

describe("setBrandPolicy（R2.5）", () => {
  it("超管可改：策略落库，同事务写审计（前后值）", async () => {
    const w = await squareEnv(t);
    const admin = await w.actor("platform_admin");
    expect(await setBrandPolicy(w.deps, admin, w.org.hisense, "own")).toEqual({ brandId: String(w.org.hisense), before: "all", after: "own" });
    expect(await setBrandPolicy(w.deps, admin, w.org.hisense, "all")).toMatchObject({ before: "own", after: "all" });
    const [row] = await t.db.select().from(squareBrandPolicies);
    expect(row).toMatchObject({ brandId: w.org.hisense, viewMode: "all", updatedByActor: admin.actor });
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "square_policy_changed"));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ actor: admin.actor, outcome: "succeeded", targetType: "square_brand_policy", targetId: String(w.org.hisense) });
    expect(JSON.stringify(events.map((e) => e.detail))).toContain('"before":"all"');
  });
  it("总部 / 分公司 / 门店不能改；服务身份不能改；不写任何东西", async () => {
    const w = await squareEnv(t);
    for (const role of ["hq_manager", "branch_manager", "store_staff"] as const) {
      const ctx = await w.actor(role, { brandIds: [w.org.hisense], branchIds: [w.org.bj], ...(role === "store_staff" ? { staff: w.org.staffA } : {}) });
      expect(await kind(setBrandPolicy(w.deps, ctx, w.org.hisense, "own")), role).toBe("auth:capability_not_granted");
    }
    const svc: AuthContext = { kind: "service", actor: "service:sync-worker", userId: null, role: null, capabilities: new Set(["config.manage"]), scope: (await w.actor("platform_admin")).scope, sessionId: null };
    expect(await kind(setBrandPolicy(w.deps, svc, w.org.hisense, "own"))).toBe("auth:service_principal_forbidden");
    expect(await t.db.select().from(squareBrandPolicies)).toHaveLength(0);
    expect((await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "square_policy_changed"))).length).toBe(0);
  });
  it("非法值与不存在的品牌被拒绝", async () => {
    const w = await squareEnv(t);
    const admin = await w.actor("platform_admin");
    expect(await kind(setBrandPolicy(w.deps, admin, w.org.hisense, "some"))).toBe("input:invalid_mode");
    expect(await kind(setBrandPolicy(w.deps, admin, 999_999n, "own"))).toBe("not_found:brand_not_found");
  });
  it("listBrandPolicies：没有行的品牌显示为 all", async () => {
    const w = await squareEnv(t);
    await setOwn(w.org.hitachi);
    const rows = await listBrandPolicies(t.db);
    expect(rows.find((r) => r.brandCode === "HITACHI")?.viewMode).toBe("own");
    expect(rows.find((r) => r.brandCode === "HISENSE")).toMatchObject({ viewMode: "all", updatedByActor: null });
  });
});

describe("ScopeStrategy content_square（SQ-D08）", () => {
  it("constraint 如实反映 B 授予的范围，不恒返回 all；contains 走策略", async () => {
    const w = await squareEnv(t);
    const strategy = w.deps.authorizer.registry.scopeStrategy("content_square")!;
    const hq = await w.actor("hq_manager", { brandIds: [w.org.hisense] });
    expect(strategy.constraint(hq.scope)).toMatchObject({ empty: false, brands: [w.org.hisense] });
    expect(await strategy.contains(hq.scope, { brandId: w.org.hitachi } as never)).toBe(true); // 无策略行：看全部
    await setOwn(w.org.hisense);
    expect(await strategy.contains(hq.scope, { brandId: w.org.hitachi } as never)).toBe(false);
    expect(await strategy.contains(hq.scope, { brandId: w.org.hisense } as never)).toBe(true);
    const none = await w.actor("hq_manager", { brandIds: [] });
    expect(strategy.constraint(none.scope).empty).toBe(true);
    expect(await strategy.contains(none.scope, { brandId: w.org.hisense } as never)).toBe(false);
  });
});
