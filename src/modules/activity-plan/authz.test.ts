import { describe, expect, it } from "vitest";
import { planActor } from "../../../tests/harness/plan";
import { assert, actorFromEnv, CAP_PLAN_CREATE, CAP_PLAN_JOIN } from "./authz";
import { PlanError } from "./errors";

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof PlanError ? `${e.category}/${e.code}` : String(e);
  }
  return undefined;
};

describe("assert：四种拒绝各有稳定错误", () => {
  it("无 Capability", () => {
    expect(code(() => assert(planActor("none"), CAP_PLAN_CREATE))).toBe("authorization/forbidden");
    // 只有 join 没有 create 的分公司人员不能创建
    expect(code(() => assert(planActor("branch", { branches: [1n] }), CAP_PLAN_CREATE))).toBe("authorization/forbidden");
  });
  it("越品牌：新建类报拒绝，已有对象表现为未找到", () => {
    const hq = planActor("hq");
    expect(code(() => assert(hq, CAP_PLAN_CREATE, { brandCode: "HISENSE" }))).toBe("authorization/brand_out_of_scope");
    expect(code(() => assert(hq, CAP_PLAN_CREATE, { brandCode: "HISENSE", outOfScope: "hide" }))).toBe("not_found/not_found");
    expect(code(() => assert(hq, CAP_PLAN_CREATE, { brandCode: "HITACHI" }))).toBeUndefined();
  });
  it("越分公司", () => {
    const b = planActor("branch", { branches: [1n] });
    expect(code(() => assert(b, CAP_PLAN_JOIN, { branchId: 2n }))).toBe("authorization/branch_out_of_scope");
    expect(code(() => assert(b, CAP_PLAN_JOIN, { branchId: 2n, outOfScope: "hide" }))).toBe("not_found/not_found");
    expect(code(() => assert(b, CAP_PLAN_JOIN, { branchId: 1n }))).toBeUndefined();
    expect(code(() => assert(planActor("hq"), CAP_PLAN_JOIN, { branchId: 99n }))).toBeUndefined(); // 总部 all
  });
  it("非创建者；创建者与超管通过", () => {
    expect(code(() => assert(planActor("hq"), CAP_PLAN_CREATE, { creator: "user:someone-else" }))).toBe("authorization/not_plan_creator");
    expect(code(() => assert(planActor("hq"), CAP_PLAN_CREATE, { creator: "user:hq" }))).toBeUndefined();
    expect(code(() => assert(planActor("admin"), CAP_PLAN_CREATE, { creator: "user:someone-else" }))).toBeUndefined();
  });
  it("Capability 先于范围：无 Capability 时不会因为范围信息泄露", () => {
    expect(code(() => assert(planActor("none"), CAP_PLAN_CREATE, { brandCode: "HISENSE", outOfScope: "hide" }))).toBe("authorization/forbidden");
  });
});

describe("actorFromEnv", () => {
  const full = {
    HBECHO_AP_ACTOR: "service:plan-cli",
    HBECHO_AP_CAPABILITIES: "activity_plan.create, activity_plan.join",
    HBECHO_AP_BRAND_SCOPE: "HITACHI,HISENSE",
    HBECHO_AP_BRANCH_SCOPE: "101,102",
  };
  const resolve = async (codes: string[]) => new Set(codes.map((c) => BigInt(c)));
  it("完整声明：解析分公司，platformAdmin 缺省 false", async () => {
    const a = await actorFromEnv(full, resolve);
    expect(a.actor).toBe("service:plan-cli");
    expect([...a.capabilities]).toEqual(["activity_plan.create", "activity_plan.join"]);
    expect(a.brandScope).toEqual(new Set(["HITACHI", "HISENSE"]));
    expect(a.branchScope).toEqual(new Set([101n, 102n]));
    expect(a.platformAdmin).toBe(false);
  });
  it("all 与显式 platform_admin", async () => {
    const a = await actorFromEnv({ ...full, HBECHO_AP_BRAND_SCOPE: "all", HBECHO_AP_BRANCH_SCOPE: "all", HBECHO_AP_PLATFORM_ADMIN: "true" }, resolve);
    expect([a.brandScope, a.branchScope, a.platformAdmin]).toEqual(["all", "all", true]);
  });
  for (const [key, expected] of [
    ["HBECHO_AP_ACTOR", "actor_missing"],
    ["HBECHO_AP_CAPABILITIES", "capabilities_missing"],
    ["HBECHO_AP_BRAND_SCOPE", "brand_scope_missing"],
    ["HBECHO_AP_BRANCH_SCOPE", "branch_scope_missing"],
  ] as const) {
    it(`缺 ${key} 启动失败，不退化成全部`, async () => {
      const env: Record<string, string | undefined> = { ...full };
      delete env[key];
      await expect(actorFromEnv(env, resolve)).rejects.toMatchObject({ category: "configuration", code: expected });
    });
  }
  it("platform_admin 取值非法也失败", async () => {
    await expect(actorFromEnv({ ...full, HBECHO_AP_PLATFORM_ADMIN: "yes" }, resolve)).rejects.toMatchObject({ code: "platform_admin_invalid" });
  });
});
