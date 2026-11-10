import { describe, expect, it } from "vitest";
import {
  buildDataScope,
  constraintOf,
  createRegistry,
  fingerprint,
  intersect,
  isEmptyScope,
  isPlatformScope,
  isSubset,
  ScopeUnregistered,
  ScopeUnresolvable,
  userStrategy,
  type DataScope,
  type OrgDirectory,
  type StaffBinding,
} from "./scope";

const S = (...x: number[]) => new Set(x.map(BigInt));
const none = { kind: "none" } as const;
const sc = (brands: DataScope["brands"], branches: DataScope["branches"], self: DataScope["self"] = none, level: DataScope["level"] = 3): DataScope => ({ brands, branches, self, level });
const ALL = sc("all", "all");

describe("intersect / isSubset / fingerprint", () => {
  it("集合取交，all 吸收，空集合是合法空范围（不是全量）", () => {
    const r = intersect(sc(S(1, 2, 3), "all"), sc(S(2, 3, 4), S(100)));
    expect([...(r.brands as Set<bigint>)].sort()).toEqual([2n, 3n]);
    expect([...(r.branches as Set<bigint>)]).toEqual([100n]);
    expect(intersect(ALL, ALL)).toMatchObject({ brands: "all", branches: "all" });
    const empty = intersect(sc(S(1), "all"), sc(S(2), "all"));
    expect((empty.brands as Set<bigint>).size).toBe(0);
    expect(isEmptyScope(empty)).toBe(true);
    expect(isEmptyScope(ALL)).toBe(false);
  });

  it("self：相同保留；一方 none 取另一方；不同的本人 → 空；unresolved 传染", () => {
    const a = sc(S(1), S(100), { kind: "resolved", mediaStaffId: 7n, storeId: 70n }, 1);
    const b = sc(S(1), S(100), { kind: "resolved", mediaStaffId: 8n, storeId: 80n }, 1);
    expect(intersect(a, a).self).toEqual(a.self);
    expect(intersect(a, ALL).self).toEqual(a.self);
    expect(intersect(ALL, a).self).toEqual(a.self);
    expect(isEmptyScope(intersect(a, b))).toBe(true);
    const un = sc(S(), S(), { kind: "unresolved", reason: "no_binding" }, 1);
    expect(intersect(a, un).self.kind).toBe("unresolved");
    expect(isEmptyScope(un)).toBe(true);
  });

  it("level 取小", () => {
    expect(intersect(sc("all", "all", none, 3), sc("all", "all", none, 2)).level).toBe(2);
  });

  it("isSubset：产物范围 ⊆ 当前范围才可交付", () => {
    expect(isSubset(sc(S(1), S(100)), sc(S(1, 2), "all"))).toBe(true);
    expect(isSubset(sc(S(1, 3), S(100)), sc(S(1, 2), "all"))).toBe(false);
    expect(isSubset(ALL, sc(S(1), "all"))).toBe(false);
    expect(isSubset(sc(S(1), "all"), ALL)).toBe(true);
    expect(isSubset(sc(S(1), S(100)), sc(S(1), S(101)))).toBe(false);
    expect(isSubset(sc(S(), S()), sc(S(1), S(1)))).toBe(true); // 空范围被任何范围覆盖
    const self7 = sc(S(1), S(100), { kind: "resolved", mediaStaffId: 7n, storeId: 70n }, 1);
    expect(isSubset(sc(S(1), S(100)), self7)).toBe(false); // 当前只剩「本人」，旧的组织级产物不再被覆盖
    expect(isSubset(self7, self7)).toBe(true);
  });

  it("fingerprint：与集合顺序无关，任一维度变化都改变", () => {
    expect(fingerprint(sc(S(3, 1, 2), S(5, 4)))).toBe(fingerprint(sc(S(1, 2, 3), S(4, 5))));
    const base = fingerprint(sc(S(1, 2), S(4)));
    expect(fingerprint(sc(S(1, 2, 3), S(4)))).not.toBe(base);
    expect(fingerprint(sc(S(1, 2), "all"))).not.toBe(base);
    expect(fingerprint(sc(S(1, 2), S(4), none, 2))).not.toBe(base);
    expect(fingerprint(sc(S(1, 2), S(4), { kind: "resolved", mediaStaffId: 1n, storeId: 1n }))).not.toBe(base);
    expect(fingerprint(ALL)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("isPlatformScope：只有全品牌 × 全组织", () => {
    expect(isPlatformScope(ALL)).toBe(true);
    expect(isPlatformScope(sc(S(1), "all"))).toBe(false);
    expect(isPlatformScope(sc("all", S(1)))).toBe(false);
  });
});

describe("buildDataScope", () => {
  const binding = (over: Partial<StaffBinding> = {}): StaffBinding => ({ staffId: 7n, status: "active", storeId: 70n, brandId: 10n, branchId: 100n, ...over });
  const dir = (b: StaffBinding | null | Error): OrgDirectory => ({
    staffBinding: async () => {
      if (b instanceof Error) throw b;
      return b;
    },
    store: async () => null,
    brand: async (brandId) => ({ brandId, status: "active" }),
    branch: async (branchId) => ({ branchId, status: "active" }),
  });
  const facts = (role: Parameters<typeof buildDataScope>[0]["role"], over: Partial<Parameters<typeof buildDataScope>[0]> = {}) => ({
    role,
    mediaStaffId: null,
    brandIds: S(10),
    branchIds: S(100),
    ...over,
  });

  it("四类角色的范围按 design §7.4 的表", async () => {
    expect(await buildDataScope(facts("platform_admin"), dir(null))).toMatchObject({ brands: "all", branches: "all", level: 3 });
    const h = await buildDataScope(facts("hq_manager"), dir(null));
    expect(h).toMatchObject({ branches: "all", level: 3 });
    expect([...(h.brands as Set<bigint>)]).toEqual([10n]);
    const b = await buildDataScope(facts("branch_manager"), dir(null));
    expect(b.level).toBe(2);
    expect([...(b.branches as Set<bigint>)]).toEqual([100n]);
    const s = await buildDataScope(facts("store_staff", { mediaStaffId: 7n, brandIds: S(), branchIds: S() }), dir(binding()));
    expect(s).toMatchObject({ level: 1, self: { kind: "resolved", mediaStaffId: 7n, storeId: 70n } });
    expect([...(s.brands as Set<bigint>)]).toEqual([10n]); // 品牌来自专员所在门店，不存授权表
    expect([...(s.branches as Set<bigint>)]).toEqual([100n]);
  });

  it("授权集合是副本：之后改授权表读到的集合不会反向污染已构建的范围", async () => {
    const src = S(10);
    const h = await buildDataScope(facts("hq_manager", { brandIds: src }), dir(null));
    src.add(99n);
    expect((h.brands as Set<bigint>).has(99n)).toBe(false);
  });

  it("store_staff 本人绑定：无绑定 / 专员不存在 / 专员已停用 → 拒绝本人范围，不回退成本门店或本品牌", async () => {
    for (const [d, f, reason] of [
      [dir(binding()), { mediaStaffId: null }, "no_binding"],
      [dir(null), { mediaStaffId: 7n }, "no_binding"],
      [dir(binding({ status: "inactive" })), { mediaStaffId: 7n }, "staff_inactive"],
    ] as const) {
      const s = await buildDataScope(facts("store_staff", f), d);
      expect(s.self).toEqual({ kind: "unresolved", reason });
      expect(isEmptyScope(s)).toBe(true);
      expect((s.brands as Set<bigint>).size).toBe(0);
      expect((s.branches as Set<bigint>).size).toBe(0);
    }
  });

  it("组织目录不可用 → 抛 ScopeUnresolvable，不回退", async () => {
    await expect(buildDataScope(facts("store_staff", { mediaStaffId: 7n }), dir(new Error("db down")))).rejects.toBeInstanceOf(ScopeUnresolvable);
  });
});

describe("注册表与 user 策略", () => {
  it("scopeFor 未注册 → ScopeUnregistered；已注册返回约束", () => {
    const r = createRegistry();
    expect(() => r.scopeFor(ALL, "account")).toThrow(ScopeUnregistered);
    expect(r.scopeFor(ALL, "user")).toMatchObject({ empty: false, brands: "all", branches: "all" });
  });

  it("constraintOf：空品牌集合 → empty；本人 → self", () => {
    expect(constraintOf(sc(S(), "all")).empty).toBe(true);
    expect(constraintOf(sc(S(1), S(2), { kind: "resolved", mediaStaffId: 7n, storeId: 70n }, 1)).self).toEqual({ mediaStaffId: 7n, storeId: 70n });
  });

  it("user 策略：品牌与分公司都被覆盖才包含；空范围什么都不含", async () => {
    const hqScope = sc(S(10), "all");
    expect(await userStrategy.contains(hqScope, { brandIds: S(10), branchIds: S(100) })).toBe(true);
    expect(await userStrategy.contains(hqScope, { brandIds: S(10, 11), branchIds: S(100) })).toBe(false);
    const bm = sc(S(10), S(100), none, 2);
    expect(await userStrategy.contains(bm, { brandIds: S(10), branchIds: S(100) })).toBe(true);
    expect(await userStrategy.contains(bm, { brandIds: S(10), branchIds: S(101) })).toBe(false);
    expect(await userStrategy.contains(bm, { brandIds: S(10), branchIds: "all" })).toBe(false);
    expect(await userStrategy.contains(sc(S(), S()), { brandIds: S(), branchIds: S() })).toBe(false);
  });
});
