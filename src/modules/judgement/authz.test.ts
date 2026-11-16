import { describe, expect, it } from "vitest";
import { createAuthorizer, createRegistry, ROLE_CAPABILITIES, type AuthContext, type DataScope, type RoleCode } from "../access-control";
import { createJudgementAuthz, registerJudgementAuthz, toDemandActor, type JudgementPlanRef } from "./authz";
import { JudgementError } from "./errors";

const ALL: DataScope = { brands: "all", branches: "all", self: { kind: "none" }, level: 3 };
const scoped = (brands: bigint[], branches: bigint[] | "all"): DataScope => ({ brands: new Set(brands), branches: branches === "all" ? "all" : new Set(branches), self: { kind: "none" }, level: 2 });
const ctxOf = (role: RoleCode, actor = "user:1", scope: DataScope = ALL): AuthContext => ({ kind: "user", actor, userId: BigInt(actor.slice(5)), role, capabilities: ROLE_CAPABILITIES[role], scope, sessionId: null });
const ref = (over: Partial<JudgementPlanRef> = {}): JudgementPlanRef => ({ brandId: 10n, branchIds: [100n, 101n], planCreatorActor: "user:7", ...over });

function setup(brandRows: Array<{ code: string }> = [{ code: "HITACHI" }]) {
  const registry = createRegistry();
  registerJudgementAuthz(registry);
  const queries: number[] = [];
  const facts = { brandCodesOf: async () => { queries.push(1); return brandRows.map((r) => r.code); } };
  const resolverCalls: bigint[] = [];
  let resolverResult: { ok: true; ctx: AuthContext } | { ok: false; kind: "unauthenticated"; reason: "user_not_active" } = { ok: true, ctx: ctxOf("hq_manager", "user:7") };
  const authz = createJudgementAuthz({
    authorizer: createAuthorizer({ registry }),
    resolver: { contextForUser: async (id: bigint) => { resolverCalls.push(id); return resolverResult as never; } },
    facts,
  });
  return { authz, registry, queries, resolverCalls, setResolver: (r: typeof resolverResult) => (resolverResult = r) };
}
const denied = async (p: Promise<unknown>): Promise<JudgementError> => {
  try {
    await p;
  } catch (e) {
    return e as JudgementError;
  }
  throw new Error("期望被拒");
};

describe("registerJudgementAuthz", () => {
  it("重复注册不抛（先查再注册）", () => {
    const r = createRegistry();
    registerJudgementAuthz(r);
    expect(() => registerJudgementAuthz(r)).not.toThrow();
    expect(r.scopeStrategy("judgement_plan")).toBeDefined();
    expect(r.predicate("plan_creator")).toBeDefined();
  });
});

describe("require", () => {
  it("创建者与超管可写；非创建者的 hq_manager 能读不能写、不能执行（plan_creator 谓词）", async () => {
    const { authz } = setup();
    const creator = ctxOf("hq_manager", "user:7");
    await authz.require(creator, "manage", ref());
    await authz.require(creator, "execute", ref());
    await authz.require(ctxOf("platform_admin", "user:99"), "manage", ref());
    const other = ctxOf("hq_manager", "user:8");
    await authz.require(other, "read", ref());
    expect((await denied(authz.require(other, "manage", ref()))).code).toBe("denied_predicate_failed");
    expect((await denied(authz.require(other, "execute", ref()))).category).toBe("authorization");
  });
  it("branch_manager 只读其所在分公司参与的活动计划下的判定计划；无写；他处表现为未找到", async () => {
    const { authz } = setup();
    const bm = ctxOf("branch_manager", "user:5", scoped([10n], [100n]));
    await authz.require(bm, "read", ref());
    expect((await denied(authz.require(bm, "manage", ref()))).code).toBe("denied_capability_not_granted");
    const elsewhere = ctxOf("branch_manager", "user:5", scoped([10n], [999n]));
    const e = await denied(authz.require(elsewhere, "read", ref()));
    expect(e.category).toBe("not_found");
  });
  it("品牌越范围 / 空范围 → 未找到，不泄露存在性", async () => {
    const { authz } = setup();
    expect((await denied(authz.require(ctxOf("hq_manager", "user:7", scoped([11n], "all")), "read", ref()))).category).toBe("not_found");
    expect((await denied(authz.require(ctxOf("hq_manager", "user:7", scoped([], "all")), "read", ref()))).category).toBe("not_found");
  });
  it("store_staff 一律被拒（没有 rule.* Capability）", async () => {
    const { authz } = setup();
    const staff = ctxOf("store_staff", "user:3", { brands: new Set([10n]), branches: new Set([100n]), self: { kind: "resolved", mediaStaffId: 1n, storeId: 1n }, level: 1 });
    expect((await denied(authz.require(staff, "read", ref()))).code).toBe("denied_capability_not_granted");
  });
  it("缺 Capability 的调用在任何读库之前被拒（brands 查询计数为 0）", async () => {
    const { authz, queries } = setup();
    await denied(authz.require(ctxOf("store_staff", "user:3", scoped([10n], [100n])), "manage", ref()));
    expect(queries).toHaveLength(0);
  });
});

describe("提交人身份（继承，不新增服务身份）", () => {
  it("contextForSubmitter：user:<id> 经 contextForUser 现建；失败 → submitter_revoked", async () => {
    const s = setup();
    expect((await s.authz.contextForSubmitter("user:7")).actor).toBe("user:7");
    expect(s.resolverCalls).toEqual([7n]);
    s.setResolver({ ok: false, kind: "unauthenticated", reason: "user_not_active" });
    expect((await denied(s.authz.contextForSubmitter("user:7"))).code).toBe("submitter_revoked");
  });
  it("提交人不是 user:<id>（含 service:*）→ 拒绝，不调用解析器", async () => {
    const s = setup();
    for (const actor of ["service:sync-worker", "user:", "user:abc", "x"]) expect((await denied(s.authz.contextForSubmitter(actor))).code, actor).toBe("submitter_revoked");
    expect(s.resolverCalls).toEqual([]);
  });
  it("toSignalActor：全品牌 → all；受限品牌译成品牌编码；译不全 → 拒绝而不降级", async () => {
    expect((await setup().authz.toSignalActor(ctxOf("platform_admin"))).brandScope).toBe("all");
    const a = await setup([{ code: "HITACHI" }]).authz.toSignalActor(ctxOf("hq_manager", "user:7", scoped([10n], "all")));
    expect([...(a.brandScope as Set<string>)]).toEqual(["HITACHI"]);
    expect(a.actor).toBe("user:7");
    expect((await denied(setup([]).authz.toSignalActor(ctxOf("hq_manager", "user:7", scoped([10n], "all"))))).code).toBe("brand_unmappable");
  });
  it("toDemandActor：actorId 等于提交人；缺 data.sync.trigger 被拒；范围放宽到全平台是有意的窄适配", () => {
    const a = toDemandActor(ctxOf("hq_manager", "user:7", scoped([10n], "all")));
    expect(a).toMatchObject({ actorId: "user:7", platformAdmin: false, scope: { platformCodes: "all", mediaStaffIds: "all" } });
    expect(toDemandActor(ctxOf("platform_admin", "user:1")).platformAdmin).toBe(false); // demand 不用它；业务代码不写角色条件
    expect(() => toDemandActor(ctxOf("store_staff", "user:3"))).toThrow(JudgementError);
  });
});
