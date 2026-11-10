// authenticate：每请求现建 AuthContext（AX-1、AX-7）。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { accessUserBrands, accessUsers, authSessions, dataQualityIssues } from "../../db/schema";
import { createAuthenticator } from "./authenticate";
import { ISSUE_SCOPE_NOT_RESOLVABLE, recordAccessIssue } from "./quality";
import { ROLE_CAPABILITIES } from "./roles";
import { createOrgDirectory, type OrgDirectory } from "./scope";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
});

const make = (dir: OrgDirectory = createOrgDirectory(t.db), over: Partial<Parameters<typeof createAuthenticator>[0]> = {}) =>
  createAuthenticator({ db: t.db, auth: env.auth, dir, ...over });

describe("authenticate", () => {
  it("有效会话 → AuthContext：规范主体、角色、Capability、范围", async () => {
    const userId = await insertAccessUser(env, { phone: "13800000001", role: "hq_manager", brandIds: [org.hisense] });
    const r = await make().authenticate(await loginAs(env, "13800000001"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ctx).toMatchObject({ kind: "user", actor: `user:${userId}`, userId, role: "hq_manager" });
    expect(r.ctx.capabilities).toBe(ROLE_CAPABILITIES.hq_manager);
    expect([...(r.ctx.scope.brands as Set<bigint>)]).toEqual([org.hisense]);
    expect(r.ctx.scope.branches).toBe("all");
    expect(r.ctx.scope.level).toBe(3);
    expect(typeof r.ctx.sessionId).toBe("string");
  });

  it("没有会话 → unauthenticated:no_session", async () => {
    expect(await make().authenticate(new Headers())).toEqual({ ok: false, kind: "unauthenticated", reason: "no_session" });
    expect(await make().authenticate(new Headers({ cookie: "better-auth.session_token=bogus.bogus" }))).toEqual({ ok: false, kind: "unauthenticated", reason: "no_session" });
  });

  it("用户被停用后，持有旧 cookie 的下一次请求被拒，无论会话行是否还在", async () => {
    const userId = await insertAccessUser(env, { phone: "13800000001", role: "hq_manager", brandIds: [org.hisense] });
    const headers = await loginAs(env, "13800000001");
    expect((await make().authenticate(headers)).ok).toBe(true);
    await t.db
      .update(accessUsers)
      .set({ status: "disabled", disabledAt: env.clock.now(), statusBeforeDisable: "active", disabledReason: "manual", disabledByActor: "user:0" })
      .where(eq(accessUsers.userId, userId));
    // 会话行仍然存在（这里故意不删），第二道检查也要拦住
    expect(await t.db.select().from(authSessions)).toHaveLength(1);
    expect(await make().authenticate(headers)).toEqual({ ok: false, kind: "unauthenticated", reason: "user_not_active" });
  });

  it("待激活用户即使有会话也不通过", async () => {
    const userId = await insertAccessUser(env, { phone: "13800000001", role: "hq_manager", brandIds: [org.hisense] });
    const headers = await loginAs(env, "13800000001");
    await t.pool.query("UPDATE access_users SET status='pending_activation', activated_at=NULL WHERE user_id = ?", [userId]);
    expect(await make().authenticate(headers)).toEqual({ ok: false, kind: "unauthenticated", reason: "user_not_active" });
  });

  it("没有授权行的认证用户（库里有、授权表没有）→ 拒绝，不放行", async () => {
    const userId = await insertAccessUser(env, { phone: "13800000001", role: "hq_manager", brandIds: [org.hisense] });
    const headers = await loginAs(env, "13800000001");
    await t.pool.query("SET FOREIGN_KEY_CHECKS = 0");
    await t.pool.query("DELETE FROM access_user_brands WHERE user_id = ?", [userId]);
    await t.pool.query("DELETE FROM access_users WHERE user_id = ?", [userId]);
    await t.pool.query("SET FOREIGN_KEY_CHECKS = 1");
    expect(await make().authenticate(headers)).toEqual({ ok: false, kind: "unauthenticated", reason: "user_not_active" });
  });

  it("角色或范围变更后，同一会话的下一次请求使用新能力 / 新范围（无需重新登录，B-D33）", async () => {
    const userId = await insertAccessUser(env, { phone: "13800000001", role: "branch_manager", brandIds: [org.hisense], branchIds: [org.bj] });
    const headers = await loginAs(env, "13800000001");
    const a = make();
    const before = await a.authenticate(headers);
    expect(before.ok && before.ctx.capabilities.has("activity_plan.create")).toBe(false);

    await t.db.update(accessUsers).set({ roleCode: "hq_manager" }).where(eq(accessUsers.userId, userId));
    await t.db.insert(accessUserBrands).values({ userId, brandId: org.hitachi });
    const after = await a.authenticate(headers);
    expect(after.ok && after.ctx.capabilities.has("activity_plan.create")).toBe(true);
    expect(after.ok && after.ctx.scope.branches).toBe("all");
    expect(after.ok && [...(after.ctx.scope.brands as Set<bigint>)].sort()).toEqual([org.hisense, org.hitachi].sort());
    expect(await t.db.select().from(authSessions)).toHaveLength(1); // 同一个会话
  });

  it("store_staff：范围来自专员所在门店；绑定到已停用专员 → 仍通过认证但本人范围拒绝", async () => {
    await insertAccessUser(env, { phone: "13800000001", role: "store_staff", mediaStaffId: org.staffA });
    const ok = await make().authenticate(await loginAs(env, "13800000001"));
    expect(ok.ok && ok.ctx.scope.self).toEqual({ kind: "resolved", mediaStaffId: org.staffA, storeId: org.storeA });

    // 停用专员后 user 是被「恢复」成有效的（人工）：认证通过，但本人范围是 unresolved
    await t.pool.query("UPDATE media_staff SET status='inactive' WHERE staff_id = ?", [org.staffA]);
    const r = await make().authenticate(await loginAs(env, "13800000001"));
    expect(r.ok && r.ctx.scope.self).toEqual({ kind: "unresolved", reason: "staff_inactive" });
  });

  it("认证库异常 → unavailable（业务拒绝），不当作未登录放行", async () => {
    const broken = { api: { getSession: async () => { throw new Error("auth db down"); } } } as unknown as typeof env.auth;
    const r = await createAuthenticator({ db: t.db, auth: broken, dir: createOrgDirectory(t.db) }).authenticate(new Headers());
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("组织目录不可用 → forbidden:scope_not_resolvable 并写一条质量问题，不回退", async () => {
    await insertAccessUser(env, { phone: "13800000001", role: "store_staff", mediaStaffId: org.staffA });
    const headers = await loginAs(env, "13800000001");
    const down: OrgDirectory = {
      ...createOrgDirectory(t.db),
      staffBinding: async () => {
        throw new Error("master data unavailable");
      },
    };
    const a = make(down, {
      onUnresolvable: ({ userId, reason }) =>
        recordAccessIssue(t.db, { code: ISSUE_SCOPE_NOT_RESOLVABLE, severity: "warning", entityType: "user", entityId: userId, discriminator: reason, detail: { reason }, now: env.clock.now() }),
    });
    expect(await a.authenticate(headers)).toEqual({ ok: false, kind: "forbidden", reason: "scope_not_resolvable" });
    const rows = await t.db.select().from(dataQualityIssues).where(eq(dataQualityIssues.issueCode, ISSUE_SCOPE_NOT_RESOLVABLE));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "user", severity: "warning" });
  });
});
