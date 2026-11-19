import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, ROLE_CAPABILITIES, ROLE_CODES, ROLE_LEVEL, ROLE_RANK, capabilitiesOf, isCapability, isRoleCode, type Capability, type RoleCode } from "./roles";

interface Row {
  capability: string;
  platform_admin: string;
  hq_manager: string;
  branch_manager: string;
  store_staff: string;
}
const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/access/capability-matrix.v1.json", import.meta.url), "utf8")) as { rows: Row[] };

describe("Capability 注册表对照 PRD §7.3 的转写 fixture", () => {
  it("恰好 30 项，名字和顺序与 PRD 一致，没有重复", () => {
    expect(fixture.rows).toHaveLength(30);
    expect([...CAPABILITIES]).toEqual(fixture.rows.map((r) => r.capability));
    expect(new Set(CAPABILITIES).size).toBe(30);
  });

  it("四类角色 × 30 项：授予与否逐格一致（❌ = 不授予，其余 = 授予）", () => {
    const mismatches: string[] = [];
    for (const row of fixture.rows) {
      for (const role of ROLE_CODES) {
        const expected = row[role] !== "❌";
        const actual = ROLE_CAPABILITIES[role].has(row.capability as Capability);
        if (expected !== actual) mismatches.push(`${row.capability} × ${role}: PRD=${row[role]} 代码=${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("每个角色的授予总数（防止同时错两格互相抵消）", () => {
    const count = (r: RoleCode) => ROLE_CAPABILITIES[r].size;
    expect(count("platform_admin")).toBe(30); // PRD：超管全部 ✅
    expect(count("hq_manager")).toBe(fixture.rows.filter((r) => r.hq_manager !== "❌").length);
    expect(count("branch_manager")).toBe(fixture.rows.filter((r) => r.branch_manager !== "❌").length);
    expect(count("store_staff")).toBe(fixture.rows.filter((r) => r.store_staff !== "❌").length);
  });

  it("几个关键格子（PRD 写得最显眼的限制）", () => {
    expect(ROLE_CAPABILITIES.hq_manager.has("data.raw_payload.read")).toBe(false);
    expect(ROLE_CAPABILITIES.hq_manager.has("data.master_data.structure")).toBe(false);
    expect(ROLE_CAPABILITIES.hq_manager.has("audit.read")).toBe(false);
    expect(ROLE_CAPABILITIES.branch_manager.has("data.master_data.import")).toBe(false);
    expect(ROLE_CAPABILITIES.branch_manager.has("activity_plan.create")).toBe(false);
    expect(ROLE_CAPABILITIES.branch_manager.has("activity_plan.join")).toBe(true);
    expect(ROLE_CAPABILITIES.store_staff.has("data.export")).toBe(false);
    expect(ROLE_CAPABILITIES.store_staff.has("user.manage")).toBe(false);
    expect(ROLE_CAPABILITIES.store_staff.has("learning.read")).toBe(true);
    expect([...ROLE_CAPABILITIES.store_staff].sort()).toEqual(["data.account.read", "data.content.read", "data.media.read", "learning.read", "report.read", "square.read"]);
  });

  it("一个用户恰好一个角色：只有四个合法角色；等级严格递增；人员级别按 B-D23", () => {
    expect([...ROLE_CODES]).toEqual(["platform_admin", "hq_manager", "branch_manager", "store_staff"]);
    expect(ROLE_RANK.platform_admin).toBeGreaterThan(ROLE_RANK.hq_manager);
    expect(ROLE_RANK.hq_manager).toBeGreaterThan(ROLE_RANK.branch_manager);
    expect(ROLE_RANK.branch_manager).toBeGreaterThan(ROLE_RANK.store_staff);
    expect(ROLE_LEVEL).toEqual({ platform_admin: 3, hq_manager: 3, branch_manager: 2, store_staff: 1 });
    expect(isRoleCode("dealer_staff")).toBe(false); // 旧设计的角色名已舍弃
    expect(isRoleCode("store_staff")).toBe(true);
  });

  it("isCapability 只认注册表；capabilitiesOf 与矩阵一致", () => {
    expect(isCapability("data.export")).toBe(true);
    expect(isCapability("data.export.all")).toBe(false);
    expect(isCapability(undefined)).toBe(false);
    expect(capabilitiesOf("hq_manager")).toBe(ROLE_CAPABILITIES.hq_manager);
  });
});
