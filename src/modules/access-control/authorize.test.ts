import { describe, expect, it } from "vitest";
import { createAuthorizer, httpStatusOf, type AuthContext, type Decision } from "./authorize";
import { ROLE_CAPABILITIES, type RoleCode } from "./roles";
import { createRegistry, ScopeUnresolvable, platformOnlyStrategy, type DataScope, type ScopeStrategy } from "./scope";
import { SERVICE_NEVER, SERVICE_PRINCIPALS, serviceCapabilities, type ServicePrincipalName } from "./service-principals";

const ALL: DataScope = { brands: "all", branches: "all", self: { kind: "none" }, level: 3 };
const userCtx = (role: RoleCode, scope: DataScope = ALL): AuthContext => ({
  kind: "user",
  actor: "user:1",
  userId: 1n,
  role,
  capabilities: ROLE_CAPABILITIES[role],
  scope,
  sessionId: "s1",
});
const serviceCtx = (name: ServicePrincipalName): AuthContext => ({
  kind: "service",
  actor: name,
  userId: null,
  role: null,
  capabilities: serviceCapabilities(name),
  scope: ALL,
  sessionId: null,
});
const reason = (d: Decision) => (d.ok ? "ok" : `${d.kind}:${d.reason}`);

/** 一个按品牌判断的假资源策略。 */
const brandStrategy: ScopeStrategy<{ brandId: bigint }> = {
  contains: async (scope, ref) => scope.brands === "all" || scope.brands.has(ref.brandId),
  constraint: () => ({ empty: false, brands: "all", branches: "all", self: null }),
};

describe("authorize：决策顺序与原因码", () => {
  it("未知 Capability → forbidden:capability_unknown，即使是超管", async () => {
    const { authorize } = createAuthorizer();
    expect(reason(await authorize(userCtx("platform_admin"), { capability: "data.export.everything" }))).toBe("forbidden:capability_unknown");
  });

  it("角色未持有 → capability_not_granted（403）", async () => {
    const { authorize } = createAuthorizer();
    const d = await authorize(userCtx("branch_manager"), { capability: "data.master_data.import" });
    expect(reason(d)).toBe("forbidden:capability_not_granted");
    expect(httpStatusOf(d as Exclude<Decision, { ok: true }>)).toBe(403);
  });

  it("持有且没有资源 → 通过", async () => {
    const { authorize } = createAuthorizer();
    expect(reason(await authorize(userCtx("hq_manager"), { capability: "activity_plan.create" }))).toBe("ok");
  });

  it("超管没有旁路：未注册的资源，超管同样被拒（scope_unregistered）", async () => {
    const { authorize } = createAuthorizer();
    expect(reason(await authorize(userCtx("platform_admin"), { capability: "data.account.read", resource: { key: "account", ref: { brandId: 1n } } }))).toBe(
      "forbidden:scope_unregistered",
    );
  });

  it("删除已注册策略后，同一请求必须失败", async () => {
    const registry = createRegistry();
    registry.registerScopeStrategy("account", brandStrategy);
    const { authorize } = createAuthorizer({ registry });
    const req = { capability: "data.account.read", resource: { key: "account", ref: { brandId: 1n } } };
    expect(reason(await authorize(userCtx("platform_admin"), req))).toBe("ok");
    registry.unregisterScopeStrategy("account");
    expect(reason(await authorize(userCtx("platform_admin"), req))).toBe("forbidden:scope_unregistered");
  });

  it("对象不在范围 → not_found（对外表现为未找到，404）", async () => {
    const registry = createRegistry();
    registry.registerScopeStrategy("account", brandStrategy);
    const { authorize } = createAuthorizer({ registry });
    const ctx = userCtx("hq_manager", { brands: new Set([1n]), branches: "all", self: { kind: "none" }, level: 3 });
    expect(reason(await authorize(ctx, { capability: "data.account.read", resource: { key: "account", ref: { brandId: 1n } } }))).toBe("ok");
    const d = await authorize(ctx, { capability: "data.account.read", resource: { key: "account", ref: { brandId: 2n } } });
    expect(reason(d)).toBe("not_found:out_of_scope");
    expect(httpStatusOf(d as Exclude<Decision, { ok: true }>)).toBe(404);
  });

  it("Capability 缺失优先于范围：先 403 再谈对象", async () => {
    const registry = createRegistry();
    registry.registerScopeStrategy("account", brandStrategy);
    const { authorize } = createAuthorizer({ registry });
    expect(reason(await authorize(userCtx("store_staff"), { capability: "data.account.manage", resource: { key: "account", ref: { brandId: 99n } } }))).toBe(
      "forbidden:capability_not_granted",
    );
  });

  it("策略解释失败 → scope_not_resolvable（403），触发 onUnresolvable；不回退放行也不回退空列表", async () => {
    const registry = createRegistry();
    registry.registerScopeStrategy("account", {
      contains: async () => {
        throw new ScopeUnresolvable("directory_unavailable");
      },
      constraint: brandStrategy.constraint,
    });
    const seen: string[] = [];
    const { authorize } = createAuthorizer({ registry, onUnresolvable: ({ resourceKey, reason: r }) => void seen.push(`${resourceKey}:${r}`) });
    const d = await authorize(userCtx("hq_manager"), { capability: "data.account.read", resource: { key: "account", ref: { brandId: 1n } } });
    expect(reason(d)).toBe("forbidden:scope_not_resolvable");
    expect(seen).toEqual(["account:directory_unavailable"]);
  });

  it("策略里的非范围异常不被吞：向上抛，不当作放行也不当作拒绝", async () => {
    const registry = createRegistry();
    registry.registerScopeStrategy("account", {
      contains: async () => {
        throw new Error("boom");
      },
      constraint: brandStrategy.constraint,
    });
    const { authorize } = createAuthorizer({ registry });
    await expect(authorize(userCtx("hq_manager"), { capability: "data.account.read", resource: { key: "account", ref: {} } })).rejects.toThrow("boom");
  });

  it("onUnresolvable / onDenied 自己抛错不改变拒绝结果", async () => {
    const registry = createRegistry();
    registry.registerScopeStrategy("account", {
      contains: async () => {
        throw new ScopeUnresolvable("x");
      },
      constraint: brandStrategy.constraint,
    });
    const { authorize } = createAuthorizer({
      registry,
      onUnresolvable: () => {
        throw new Error("issue write failed");
      },
      onDenied: () => {
        throw new Error("audit write failed");
      },
    });
    expect(reason(await authorize(userCtx("hq_manager"), { capability: "data.account.read", resource: { key: "account", ref: {} } }))).toBe("forbidden:scope_not_resolvable");
  });

  it("每次拒绝都会调用 onDenied（供写 denied 审计）；通过不调用", async () => {
    const denied: string[] = [];
    const { authorize } = createAuthorizer({ onDenied: ({ decision }) => void denied.push(decision.reason) });
    await authorize(userCtx("store_staff"), { capability: "user.manage" });
    await authorize(userCtx("hq_manager"), { capability: "activity_plan.create" });
    await authorize(userCtx("hq_manager"), { capability: "nope.nope" });
    expect(denied).toEqual(["capability_not_granted", "capability_unknown"]);
  });

  describe("资源谓词", () => {
    it("已注册且成立 → 通过；不成立 → predicate_failed；未注册的谓词名一律不成立", async () => {
      const registry = createRegistry();
      registry.registerScopeStrategy("activity_plan", brandStrategy);
      registry.registerPredicate("plan_creator", (ctx, ref) => ctx.platformAdmin || (ref as { creator: string }).creator === ctx.actor);
      const { authorize } = createAuthorizer({ registry });
      const req = (creator: string, predicates: string[] = ["plan_creator"]) => ({
        capability: "activity_plan.create",
        resource: { key: "activity_plan", ref: Object.assign({ brandId: 1n }, { creator }), predicates },
      });
      const hq = userCtx("hq_manager");
      expect(reason(await authorize(hq, req("user:1")))).toBe("ok"); // 创建者本人
      expect(reason(await authorize(hq, req("user:2")))).toBe("forbidden:predicate_failed"); // 同品牌总部不能编辑他人创建的计划
      expect(reason(await authorize(userCtx("platform_admin"), req("user:2")))).toBe("ok"); // 超管经谓词放行，不是旁路
      expect(reason(await authorize(hq, req("user:1", ["no_such_predicate"])))).toBe("forbidden:predicate_failed");
    });

    it("重复注册谓词 / 策略失败；未知谓词名、未知资源键失败（防拼写漂移）", () => {
      const r = createRegistry();
      r.registerPredicate("plan_branch", () => true);
      expect(() => r.registerPredicate("plan_branch", () => true)).toThrow(/已注册/);
      expect(() => r.registerPredicate("made_up" as never, () => true)).toThrow(/未知谓词/);
      expect(() => r.registerScopeStrategy("user", brandStrategy as never)).toThrow(/已注册/); // 自带的 user
      expect(() => r.registerScopeStrategy("made_up" as never, brandStrategy as never)).toThrow(/未知资源键/);
    });
  });
});

describe("B 自带的四个资源策略", () => {
  const req = (key: string, capability = "data.raw_payload.read") => ({ capability, resource: { key, ref: {} } });

  it("audit_log / external_account / raw_payload 只对平台级主体放行", async () => {
    const { authorize } = createAuthorizer();
    const hq = userCtx("hq_manager", { brands: new Set([1n]), branches: "all", self: { kind: "none" }, level: 3 });
    // hq 没有 data.raw_payload.read，先用一个 hq 持有的 Capability 去碰这三个资源，证明是策略在挡
    for (const key of ["audit_log", "external_account", "raw_payload"]) {
      expect(reason(await authorize(hq, { capability: "data.account.read", resource: { key, ref: {} } }))).toBe("not_found:out_of_scope");
      expect(reason(await authorize(userCtx("platform_admin"), { capability: "data.account.read", resource: { key, ref: {} } }))).toBe("ok");
    }
    expect(reason(await authorize(userCtx("hq_manager"), req("raw_payload")))).toBe("forbidden:capability_not_granted");
  });

  it("platformOnlyStrategy 的语义约束：非平台级主体得到空约束", () => {
    expect(platformOnlyStrategy.constraint(ALL).empty).toBe(false);
    expect(platformOnlyStrategy.constraint({ brands: new Set([1n]), branches: "all", self: { kind: "none" }, level: 3 }).empty).toBe(true);
  });

  it("B 默认只注册这四个；其余资源由所属域注册", () => {
    expect(createRegistry().registeredKeys()).toEqual(["audit_log", "external_account", "raw_payload", "user"]);
  });
});

describe("服务身份", () => {
  it("白名单内放行：sync-worker 可触发同步；plan-worker 可 join 与触发同步", async () => {
    const { authorize } = createAuthorizer();
    expect(reason(await authorize(serviceCtx("service:sync-worker"), { capability: "data.sync.trigger" }))).toBe("ok");
    expect(reason(await authorize(serviceCtx("service:plan-worker"), { capability: "activity_plan.join" }))).toBe("ok");
    expect(reason(await authorize(serviceCtx("service:plan-worker"), { capability: "data.sync.trigger" }))).toBe("ok");
  });

  it("导出、原始载荷、授权接口、审计、配置一律被拒（service_principal_forbidden）", async () => {
    const { authorize } = createAuthorizer();
    for (const name of Object.keys(SERVICE_PRINCIPALS) as ServicePrincipalName[]) {
      for (const cap of ["data.export", "report.export", "data.raw_payload.read", "user.manage", "audit.read", "config.manage", "data.master_data.structure"]) {
        expect(reason(await authorize(serviceCtx(name), { capability: cap }))).toBe("forbidden:service_principal_forbidden");
      }
    }
  });

  it("伪造的服务身份名 / 把用户能力塞给服务身份，都不放行", async () => {
    const { authorize } = createAuthorizer();
    const forged: AuthContext = { ...serviceCtx("service:sync-worker"), actor: "service:superuser", capabilities: ROLE_CAPABILITIES.platform_admin };
    expect(reason(await authorize(forged, { capability: "data.sync.trigger" }))).toBe("forbidden:service_principal_forbidden");
    const widened: AuthContext = { ...serviceCtx("service:sync-worker"), capabilities: ROLE_CAPABILITIES.platform_admin };
    expect(reason(await authorize(widened, { capability: "data.export" }))).toBe("forbidden:service_principal_forbidden");
  });

  it("枚举断言：任何服务身份的白名单都不含「永不」清单；access-worker 白名单为空", () => {
    for (const [name, caps] of Object.entries(SERVICE_PRINCIPALS)) {
      for (const never of SERVICE_NEVER) expect((caps as readonly string[]).includes(never), `${name} 含 ${never}`).toBe(false);
    }
    expect(SERVICE_PRINCIPALS["service:access-worker"]).toEqual([]);
    expect(Object.keys(SERVICE_PRINCIPALS)).toEqual(["service:sync-worker", "service:plan-worker", "service:access-worker"]);
  });
});

describe("E6：HTTP 状态映射", () => {
  it("未认证 401、缺 Capability 403、对象越权 404、认证库不可用 503", () => {
    expect(httpStatusOf({ ok: false, kind: "unauthenticated", reason: "user_not_active" })).toBe(401);
    expect(httpStatusOf({ ok: false, kind: "forbidden", reason: "capability_not_granted" })).toBe(403);
    expect(httpStatusOf({ ok: false, kind: "not_found", reason: "out_of_scope" })).toBe(404);
    expect(httpStatusOf({ ok: false, kind: "unavailable", reason: "scope_not_resolvable" })).toBe(503);
  });
});
