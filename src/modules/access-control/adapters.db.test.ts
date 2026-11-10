// 身份适配器的契约（任务 11；AX-11）：四类角色 → 各模块 Actor 的期望输出。
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { toMasterDataActor, toPlanActor, toTracerActor, userIdOf } from "./adapters";
import { createContextResolver } from "./authenticate";
import type { AuthContext } from "./authorize";
import { ROLE_CAPABILITIES } from "./roles";
import { createOrgDirectory } from "./scope";
import { serviceCapabilities } from "./service-principals";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let ctxOf: (userId: bigint) => Promise<AuthContext>;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  const dir = createOrgDirectory(t.db);
  const r = createContextResolver({ db: t.db, dir, linkage: accessLinkage(env, { dir }) });
  ctxOf = async (id) => {
    const x = await r.contextForUser(id, null);
    if (!x.ok) throw new Error(x.reason);
    return x.ctx;
  };
});

describe("四类角色 × 三个适配器", () => {
  it("超管：品牌 / 分公司全部；platformAdmin=true；tracer 可适配", async () => {
    const ctx = await ctxOf(await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" }));
    expect(await toPlanActor(ctx, { db: t.db })).toEqual({ ok: true, actor: { actor: ctx.actor, capabilities: ROLE_CAPABILITIES.platform_admin, brandScope: "all", branchScope: "all", platformAdmin: true } });
    expect(await toMasterDataActor(ctx, { db: t.db })).toEqual({ ok: true, actor: { actor: ctx.actor, capabilities: ROLE_CAPABILITIES.platform_admin, brandScope: "all" } });
    expect(toTracerActor(ctx)).toEqual({ ok: true, actor: { actorId: ctx.actor, capabilities: ROLE_CAPABILITIES.platform_admin, platformAdmin: true, scope: { platformCodes: "all", mediaStaffIds: "all" } } });
  });

  it("总部：品牌编码集合；分公司 all；不是超管；tracer 不适配（品牌不是全部）", async () => {
    const ctx = await ctxOf(await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense, org.hitachi] }));
    expect(await toPlanActor(ctx, { db: t.db })).toMatchObject({ ok: true, actor: { brandScope: new Set(["HISENSE", "HITACHI"]), branchScope: "all", platformAdmin: false } });
    expect(await toMasterDataActor(ctx, { db: t.db })).toMatchObject({ ok: true, actor: { brandScope: new Set(["HISENSE", "HITACHI"]) } });
    expect(toTracerActor(ctx)).toEqual({ ok: false, reason: "partial_scope_not_supported" });
  });

  it("分公司：品牌编码 + 分公司 ID 集合；tracer 不适配，不降级", async () => {
    const ctx = await ctxOf(await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] }));
    expect(await toPlanActor(ctx, { db: t.db })).toMatchObject({ ok: true, actor: { brandScope: new Set(["HISENSE"]), branchScope: new Set([org.bj]), platformAdmin: false } });
    expect(toTracerActor(ctx)).toEqual({ ok: false, reason: "partial_scope_not_supported" });
  });

  it("门店专员：范围由门店推出；tracer 不适配（本人范围）", async () => {
    const ctx = await ctxOf(await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA }));
    expect(await toPlanActor(ctx, { db: t.db })).toMatchObject({ ok: true, actor: { brandScope: new Set(["HISENSE"]), branchScope: new Set([org.bj]), platformAdmin: false } });
    expect(toTracerActor(ctx)).toEqual({ ok: false, reason: "partial_scope_not_supported" });
  });

  it("服务身份：plan-worker / sync-worker 适配为全范围，不是超管", async () => {
    const svc = (name: "service:plan-worker" | "service:sync-worker"): AuthContext => ({
      kind: "service",
      actor: name,
      userId: null,
      role: null,
      capabilities: serviceCapabilities(name),
      scope: { brands: "all", branches: "all", self: { kind: "none" }, level: 3 },
      sessionId: null,
    });
    expect(await toPlanActor(svc("service:plan-worker"), { db: t.db })).toMatchObject({ ok: true, actor: { actor: "service:plan-worker", brandScope: "all", platformAdmin: false } });
    expect(toTracerActor(svc("service:sync-worker"))).toMatchObject({ ok: true, actor: { actorId: "service:sync-worker", platformAdmin: false } });
  });

  it("主数据适配：没有导入 Capability 的角色（分公司、门店专员）不可适配（K2）", async () => {
    const bm = await ctxOf(await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] }));
    const staff = await ctxOf(await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA }));
    expect(await toMasterDataActor(bm, { db: t.db })).toEqual({ ok: false, reason: "no_import_capability" });
    expect(await toMasterDataActor(staff, { db: t.db })).toEqual({ ok: false, reason: "no_import_capability" });
  });

  it("适配出的 Actor 形状与各模块既有测试里用的字段一致（编译期结构兼容）", async () => {
    const ctx = await ctxOf(await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" }));
    const md = await toMasterDataActor(ctx, { db: t.db });
    const tr = toTracerActor(ctx);
    if (!md.ok || !tr.ok) throw new Error("应可适配");
    // 结构赋值给各模块真实类型；字段改名时这里编译失败
    const mdActor: import("../master-data-import").ActorContext = md.actor;
    const trActor: import("../tracer-command").ActorContext = tr.actor;
    expect(mdActor.actor).toBe(ctx.actor);
    expect(trActor.actorId).toBe(ctx.actor);
  });
});

describe("userIdOf（回填入口）", () => {
  it("user:<id> → ID；service:* 与其它 → null，不造假", () => {
    expect(userIdOf("user:42")).toBe(42n);
    expect(userIdOf("user:9007199254740993")).toBe(9007199254740993n); // 超过 2^53 也不丢精度
    for (const a of ["service:plan-worker", "service:access-worker", "cli:bootstrap", "user:", "user:abc", "user:1:2", "", "user: 1"]) expect(userIdOf(a)).toBeNull();
  });
});
