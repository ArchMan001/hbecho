// DataScope 在真实组织主档上的行为（AX-7 验收）：跨品牌分公司、本人绑定、停用不影响读范围、无法映射 → 403 + 质量问题。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { brands, dataQualityIssues, mediaStaff, stores } from "../../db/schema";
import { createAuthorizer, type AuthContext } from "./authorize";
import { ISSUE_SCOPE_NOT_RESOLVABLE, recordAccessIssue } from "./quality";
import { ROLE_CAPABILITIES } from "./roles";
import { buildDataScope, createOrgDirectory, createRegistry, createStoreStrategy, type DataScope, type OrgDirectory } from "./scope";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let dir: OrgDirectory;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  dir = createOrgDirectory(t.db);
});

const S = (...x: bigint[]) => new Set(x);
const ctxOf = (scope: DataScope, role: AuthContext["role"] = "branch_manager"): AuthContext => ({
  kind: "user",
  actor: "user:1",
  userId: 1n,
  role,
  capabilities: ROLE_CAPABILITIES[role!],
  scope,
  sessionId: "s",
});
const storeAuthorizer = (d: OrgDirectory = dir) => {
  const registry = createRegistry();
  registry.registerScopeStrategy("account", createStoreStrategy(d));
  return createAuthorizer({ registry });
};
const canRead = async (a: ReturnType<typeof storeAuthorizer>, ctx: AuthContext, storeId: bigint) =>
  (await a.authorize(ctx, { capability: "data.account.read", resource: { key: "account", ref: { storeId } } })).ok;

describe("品牌 ∩ 组织：跨品牌分公司不泄露", () => {
  it("北京分公司有海信门店 A 与日立门店 B：分公司经理品牌授权=海信 → 只看到 A", async () => {
    const scope = await buildDataScope({ role: "branch_manager", mediaStaffId: null, brandIds: S(org.hisense), branchIds: S(org.bj) }, dir);
    const a = storeAuthorizer();
    const ctx = ctxOf(scope);
    expect(await canRead(a, ctx, org.storeA)).toBe(true);
    expect(await canRead(a, ctx, org.storeB)).toBe(false); // 同分公司、品牌未授予
    expect(await canRead(a, ctx, org.storeC)).toBe(false); // 品牌授予、分公司不在
  });

  it("总部：授权品牌 × 全部组织；北京日立店与上海海信店分别按品牌判断", async () => {
    const scope = await buildDataScope({ role: "hq_manager", mediaStaffId: null, brandIds: S(org.hisense), branchIds: S() }, dir);
    const a = storeAuthorizer();
    const ctx = ctxOf(scope, "hq_manager");
    expect(await canRead(a, ctx, org.storeA)).toBe(true);
    expect(await canRead(a, ctx, org.storeC)).toBe(true);
    expect(await canRead(a, ctx, org.storeB)).toBe(false);
  });

  it("超管：全部品牌 × 全部组织", async () => {
    const scope = await buildDataScope({ role: "platform_admin", mediaStaffId: null, brandIds: S(), branchIds: S() }, dir);
    const a = storeAuthorizer();
    for (const s of [org.storeA, org.storeB, org.storeC]) expect(await canRead(a, ctxOf(scope, "platform_admin"), s)).toBe(true);
  });

  it("空品牌集合：合法空范围，什么都看不到（不是全量），也不是错误", async () => {
    const scope = await buildDataScope({ role: "hq_manager", mediaStaffId: null, brandIds: S(), branchIds: S() }, dir);
    const a = storeAuthorizer();
    const d = await a.authorize(ctxOf(scope, "hq_manager"), { capability: "data.account.read", resource: { key: "account", ref: { storeId: org.storeA } } });
    expect(d).toMatchObject({ ok: false, kind: "not_found", reason: "out_of_scope" });
  });

  it("品牌被停用后，已授予用户仍能读到该品牌范围（B-D25）；门店停用同理", async () => {
    await t.db.update(brands).set({ status: "inactive" }).where(eq(brands.brandId, org.hisense));
    await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeId, org.storeA));
    const scope = await buildDataScope({ role: "branch_manager", mediaStaffId: null, brandIds: S(org.hisense), branchIds: S(org.bj) }, dir);
    expect(await canRead(storeAuthorizer(), ctxOf(scope), org.storeA)).toBe(true);
  });
});

describe("store_staff 的本人绑定", () => {
  const staffScope = (mediaStaffId: bigint | null) => buildDataScope({ role: "store_staff", mediaStaffId, brandIds: S(), branchIds: S() }, dir);

  it("绑定有效：范围 = 专员所在门店的品牌与分公司，且只能看本人的门店（同品牌同分公司的别的店也看不到）", async () => {
    const scope = await staffScope(org.staffA);
    expect(scope.self).toEqual({ kind: "resolved", mediaStaffId: org.staffA, storeId: org.storeA });
    expect([...(scope.brands as Set<bigint>)]).toEqual([org.hisense]);
    const a = storeAuthorizer();
    const ctx = ctxOf(scope, "store_staff");
    expect(await canRead(a, ctx, org.storeA)).toBe(true);
    expect(await canRead(a, ctx, org.storeB)).toBe(false);
    expect(await canRead(a, ctx, org.storeC)).toBe(false);
  });

  it("没有绑定 / 绑定到已停用专员 → 拒绝本人范围，不回退成本门店或本品牌", async () => {
    const none = await staffScope(null);
    const inactive = await staffScope(org.staffInactive);
    expect(none.self).toEqual({ kind: "unresolved", reason: "no_binding" });
    expect(inactive.self).toEqual({ kind: "unresolved", reason: "staff_inactive" });
    const a = storeAuthorizer();
    for (const s of [none, inactive]) {
      expect(await canRead(a, ctxOf(s, "store_staff"), org.storeA)).toBe(false);
    }
  });

  it("专员停用后下一次构建立即收窄（范围每次现建，不跨请求缓存）", async () => {
    expect((await staffScope(org.staffA)).self.kind).toBe("resolved");
    await t.db.update(mediaStaff).set({ status: "inactive" }).where(eq(mediaStaff.staffId, org.staffA));
    expect((await staffScope(org.staffA)).self).toEqual({ kind: "unresolved", reason: "staff_inactive" });
  });
});

describe("无法映射 → 403 + 质量问题，不回退", () => {
  const faulty = (kind: "missing" | "down"): OrgDirectory => ({
    ...dir0(),
    store: async () => {
      if (kind === "down") throw new Error("master data unavailable");
      return null;
    },
  });
  function dir0(): OrgDirectory {
    return createOrgDirectory(t.db);
  }

  it.each(["missing", "down"] as const)("门店 %s：决策为 forbidden:scope_not_resolvable，并留下一条 access_scope_not_resolvable 问题", async (kind) => {
    const registry = createRegistry();
    registry.registerScopeStrategy("account", createStoreStrategy(faulty(kind)));
    const a = createAuthorizer({
      registry,
      onUnresolvable: ({ resourceKey, reason, ctx }) =>
        recordAccessIssue(t.db, { code: ISSUE_SCOPE_NOT_RESOLVABLE, severity: "warning", discriminator: `${resourceKey}:${reason}`, detail: { resource: resourceKey, reason, actor: ctx.actor }, now: env.clock.now() }),
    });
    const scope = await buildDataScope({ role: "hq_manager", mediaStaffId: null, brandIds: S(org.hisense), branchIds: S() }, dir);
    const ctx = ctxOf(scope, "hq_manager");
    const req = { capability: "data.account.read", resource: { key: "account", ref: { storeId: org.storeA } } };
    expect(await a.authorize(ctx, req)).toMatchObject({ ok: false, kind: "forbidden", reason: "scope_not_resolvable" });
    await a.authorize(ctx, req); // 再来一次：同一问题累加次数而不是新增行
    const rows = await t.db.select().from(dataQualityIssues).where(eq(dataQualityIssues.issueCode, ISSUE_SCOPE_NOT_RESOLVABLE));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warning", status: "open", occurrenceCount: 2 });
    expect(rows[0]!.detail).toMatchObject({ resource: "account", actor: "user:1" });
  });
});
