import { describe, expect, it } from "vitest";
import { canGrant, manages, type Principal, type TargetUser } from "./grants";
import type { RoleCode } from "./roles";

const S = (...x: number[]) => new Set(x.map(BigInt));
const admin: Principal = { userId: 1n, role: "platform_admin", brands: "all", branches: "all" };
const hq: Principal = { userId: 2n, role: "hq_manager", brands: S(10, 11), branches: "all" };
const branch: Principal = { userId: 3n, role: "branch_manager", brands: S(10, 11), branches: S(100, 101) };
const target = (id: number, role: RoleCode, brands: number[], branches: number[] | "all"): TargetUser => ({
  userId: BigInt(id),
  role,
  brands: S(...brands),
  branches: branches === "all" ? "all" : S(...branches),
});

describe("manages：读写同源的管理范围", () => {
  it("自己不可管理（可见但只读）", () => {
    expect(manages(admin, target(1, "platform_admin", [], "all"))).toBe(false);
    expect(manages(hq, target(2, "hq_manager", [10], "all"))).toBe(false);
  });

  it("超管可管理其他所有人，含其他超管", () => {
    expect(manages(admin, target(9, "platform_admin", [], "all"))).toBe(true);
    expect(manages(admin, target(9, "hq_manager", [10], "all"))).toBe(true);
    expect(manages(admin, target(9, "store_staff", [10], [100]))).toBe(true);
  });

  it("严格下级：总部不能管总部或超管；分公司不能管分公司、总部", () => {
    expect(manages(hq, target(9, "hq_manager", [10], "all"))).toBe(false);
    expect(manages(hq, target(9, "platform_admin", [], "all"))).toBe(false);
    expect(manages(branch, target(9, "branch_manager", [10], [100]))).toBe(false);
    expect(manages(branch, target(9, "hq_manager", [10], "all"))).toBe(false);
  });

  it("总部：品牌必须被覆盖，分公司不限", () => {
    expect(manages(hq, target(9, "branch_manager", [10], [100]))).toBe(true);
    expect(manages(hq, target(9, "branch_manager", [10, 11], [100, 999]))).toBe(true);
    expect(manages(hq, target(9, "branch_manager", [10, 12], [100]))).toBe(false); // 12 不在总部的品牌里
    expect(manages(hq, target(9, "store_staff", [10], [999]))).toBe(true);
    expect(manages(hq, target(9, "store_staff", [12], [100]))).toBe(false);
  });

  it("分公司：品牌与分公司都必须被覆盖；目标分公司为 all 的不可管", () => {
    expect(manages(branch, target(9, "store_staff", [10], [100]))).toBe(true);
    expect(manages(branch, target(9, "store_staff", [10], [101]))).toBe(true);
    expect(manages(branch, target(9, "store_staff", [10], [102]))).toBe(false); // 他分公司门店
    expect(manages(branch, target(9, "store_staff", [12], [100]))).toBe(false); // 超出自己品牌
    expect(manages(branch, { ...target(9, "store_staff", [10], "all") })).toBe(false);
  });

  it("空品牌集合的下级：空集是任何集合的子集，仍受严格下级与分公司约束", () => {
    expect(manages(hq, target(9, "branch_manager", [], [100]))).toBe(true);
    expect(manages(branch, target(9, "branch_manager", [], [100]))).toBe(false);
  });
});

describe("canGrant：proposed 边界", () => {
  const set = (...x: number[]) => S(...x);
  const verdict = (a: Principal, p: Parameters<typeof canGrant>[1]) => canGrant(a, p);

  it("总部不能创建总部或超管；分公司不能创建分公司；只有超管能创建超管", () => {
    expect(verdict(hq, { role: "hq_manager", brandIds: set(10), branchIds: set() })).toEqual({ ok: false, reason: "role_not_grantable" });
    expect(verdict(hq, { role: "platform_admin", brandIds: set(), branchIds: set() })).toEqual({ ok: false, reason: "role_not_grantable" });
    expect(verdict(branch, { role: "branch_manager", brandIds: set(10), branchIds: set(100) })).toEqual({ ok: false, reason: "role_not_grantable" });
    expect(verdict(admin, { role: "platform_admin", brandIds: set(), branchIds: set() })).toEqual({ ok: true });
  });

  it("超管可授予任意角色，品牌 / 分公司不受限", () => {
    expect(verdict(admin, { role: "hq_manager", brandIds: set(10, 99), branchIds: set() })).toEqual({ ok: true });
    expect(verdict(admin, { role: "branch_manager", brandIds: set(99), branchIds: set(555) })).toEqual({ ok: true });
  });

  it("总部授予分公司人员：品牌 ⊆ 自己的品牌；分公司任意", () => {
    expect(verdict(hq, { role: "branch_manager", brandIds: set(10), branchIds: set(100, 555) })).toEqual({ ok: true });
    expect(verdict(hq, { role: "branch_manager", brandIds: set(10, 12), branchIds: set(100) })).toEqual({ ok: false, reason: "scope_exceeds_boundary" });
  });

  it("分公司授予门店专员：门店的品牌与分公司都必须在自己范围内", () => {
    const base = { role: "store_staff" as const, brandIds: set(), branchIds: set() };
    expect(verdict(branch, { ...base, store: { brandId: 10n, branchId: 100n } })).toEqual({ ok: true });
    expect(verdict(branch, { ...base, store: { brandId: 10n, branchId: 102n } })).toEqual({ ok: false, reason: "scope_exceeds_boundary" });
    expect(verdict(branch, { ...base, store: { brandId: 12n, branchId: 100n } })).toEqual({ ok: false, reason: "scope_exceeds_boundary" });
    expect(verdict(hq, { ...base, store: { brandId: 10n, branchId: 999n } })).toEqual({ ok: true }); // 总部分公司不限
  });

  it("形状非法：admin / staff 不带品牌分公司集合；hq 不带分公司集合；hq / branch 品牌非空；branch 分公司非空；staff 必须有门店", () => {
    const shape = { ok: false, reason: "shape_invalid" } as const;
    expect(verdict(admin, { role: "platform_admin", brandIds: set(10), branchIds: set() })).toEqual(shape);
    expect(verdict(admin, { role: "hq_manager", brandIds: set(), branchIds: set() })).toEqual(shape);
    expect(verdict(admin, { role: "hq_manager", brandIds: set(10), branchIds: set(100) })).toEqual(shape);
    expect(verdict(admin, { role: "branch_manager", brandIds: set(10), branchIds: set() })).toEqual(shape);
    expect(verdict(admin, { role: "branch_manager", brandIds: set(), branchIds: set(100) })).toEqual(shape);
    expect(verdict(admin, { role: "store_staff", brandIds: set(10), branchIds: set(), store: { brandId: 10n, branchId: 100n } })).toEqual(shape);
    expect(verdict(admin, { role: "store_staff", brandIds: set(), branchIds: set() })).toEqual(shape);
  });

  it("授权角色低于自己仍可能因形状 / 范围被拒：先判角色，再判形状，再判范围", () => {
    expect(verdict(branch, { role: "hq_manager", brandIds: set(), branchIds: set() })).toEqual({ ok: false, reason: "role_not_grantable" }); // 角色优先
  });
});
