// MediaStaff 联动与每日维护（任务 7；AX-5，acceptance D8–D12、C19）。全程不碰 OSS。
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { accessBootstrapTokens, accessLoginFailures, accessSmsSends, accessUsers, auditEvents, authSessions, authUsers, dataQualityIssues } from "../../db/schema";
import { createAuthenticator } from "./authenticate";
import { createUserAdmin } from "./users/admin";
import { createAuthorizer } from "./authorize";
import { createOrgDirectory } from "./scope";
import { ISSUE_AUTO_RESTORE_BLOCKED, ISSUE_AUTO_RESTORE_STAFF_BOUND } from "./quality";
import { RETENTION } from "./linkage";
import { createAccessMaintenance } from "./maintenance";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
});

const DAY = 86_400_000;
const setStaff = (staffId: bigint, status: "active" | "inactive") => t.pool.query("UPDATE media_staff SET status = ? WHERE staff_id = ?", [status, staffId]);
const userRow = async (id: bigint) => (await t.db.select().from(accessUsers).where(eq(accessUsers.userId, id)))[0]!;
const staffUser = (phone: string, staffId: bigint, over: Parameters<typeof insertAccessUser>[1] = { phone }) =>
  insertAccessUser(env, { role: "store_staff", mediaStaffId: staffId, ...over, phone });
const issues = (code: string) => t.db.select().from(dataQualityIssues).where(eq(dataQualityIssues.issueCode, code));

describe("补偿（步骤 1）", () => {
  it("从未登录的 store_staff：专员停用后被补偿任务停用（D9），幂等，只动绑定停用专员的人", async () => {
    const hit = await staffUser("13800000001", org.staffA);
    const pending = await staffUser("13800000002", org.staffB, { phone: "13800000002", status: "pending_activation" });
    const other = await staffUser("13800000003", org.staffC);
    await setStaff(org.staffA, "inactive");
    await setStaff(org.staffB, "inactive");
    const link = accessLinkage(env);
    expect(await link.compensate()).toBe(2);
    expect(await userRow(hit)).toMatchObject({ status: "disabled", disabledReason: "media_staff_disabled", autoDisabledStaffId: org.staffA, statusBeforeDisable: "active" });
    expect(await userRow(pending)).toMatchObject({ status: "disabled", statusBeforeDisable: "pending_activation" });
    expect((await userRow(other)).status).toBe("active");
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, hit)))[0]!.phoneNumber).toBe(`disabled:${hit}`);
    // 审计：系统身份，reason media_staff_disabled
    const ev = await t.db.select().from(auditEvents).where(and(eq(auditEvents.reasonCode, "media_staff_disabled"), eq(auditEvents.actor, "service:access-worker")));
    expect(ev).toHaveLength(2);
    expect(await link.compensate()).toBe(0); // 幂等
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.reasonCode, "media_staff_disabled"))).toHaveLength(2);
  });

  it("人工停用的用户不受影响；非 store_staff 不受影响", async () => {
    const manual = await staffUser("13800000001", org.staffA, { phone: "13800000001", status: "disabled", disabledReason: "manual" });
    await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    await setStaff(org.staffA, "inactive");
    expect(await accessLinkage(env).compensate()).toBe(0);
    expect((await userRow(manual)).disabledReason).toBe("manual");
  });

  it("人工恢复时已知情的失效绑定（binding_ack）不被补偿停用（D12）", async () => {
    const u = await staffUser("13800000001", org.staffA);
    await setStaff(org.staffA, "inactive");
    await t.pool.query("UPDATE access_users SET binding_ack_staff_id = ? WHERE user_id = ?", [org.staffA, u]);
    expect(await accessLinkage(env).compensate()).toBe(0);
    expect((await userRow(u)).status).toBe("active");
  });
});

describe("条件恢复（步骤 2）", () => {
  it("自动停用的用户在专员恢复后被恢复；人工停用的不恢复（D10）", async () => {
    const auto = await staffUser("13800000001", org.staffA);
    const manual = await staffUser("13800000002", org.staffB, { phone: "13800000002", status: "disabled", disabledReason: "manual" });
    await setStaff(org.staffA, "inactive");
    const link = accessLinkage(env);
    await link.compensate();
    expect((await userRow(auto)).status).toBe("disabled");
    await setStaff(org.staffA, "active");
    await setStaff(org.staffB, "active");
    const r = await link.conditionalRestore();
    expect(r).toEqual({ restored: 1, blocked: 0 });
    expect(await userRow(auto)).toMatchObject({ status: "active", disabledReason: null, autoDisabledStaffId: null });
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, auto)))[0]!.phoneNumber).toBe("13800000001");
    expect((await userRow(manual)).status).toBe("disabled");
    expect((await link.conditionalRestore()).restored).toBe(0); // 幂等
  });

  it("停用前是待激活的，恢复后回到待激活", async () => {
    const u = await staffUser("13800000002", org.staffB, { phone: "13800000002", status: "pending_activation" });
    await setStaff(org.staffB, "inactive");
    const link = accessLinkage(env);
    await link.compensate();
    await setStaff(org.staffB, "active");
    await link.conditionalRestore();
    expect((await userRow(u)).status).toBe("pending_activation");
  });

  it("同号已有待激活 / 有效用户 → 保持停用 + 一条质量问题 user_auto_restore_blocked_phone_in_use（D11），重复运行只累加次数", async () => {
    const auto = await staffUser("13800000001", org.staffA);
    await setStaff(org.staffA, "inactive");
    const link = accessLinkage(env);
    await link.compensate();
    await insertAccessUser(env, { role: "hq_manager", phone: "13800000001", brandIds: [org.hisense] }); // 原号被别人占用
    await setStaff(org.staffA, "active");
    expect(await link.conditionalRestore()).toEqual({ restored: 0, blocked: 1 });
    expect((await userRow(auto)).status).toBe("disabled");
    await link.conditionalRestore();
    const rows = await issues(ISSUE_AUTO_RESTORE_BLOCKED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "access_user", occurrenceCount: 2 });
  });

  it("该专员已绑定了另一个非停用用户 → 保持停用 + 质量问题 user_auto_restore_blocked_staff_bound", async () => {
    const auto = await staffUser("13800000001", org.staffA);
    await setStaff(org.staffA, "inactive");
    const link = accessLinkage(env);
    await link.compensate();
    await staffUser("13800000009", org.staffA); // 同一专员又建了新账号
    await setStaff(org.staffA, "active");
    expect(await link.conditionalRestore()).toEqual({ restored: 0, blocked: 1 });
    expect((await userRow(auto)).status).toBe("disabled");
    expect(await issues(ISSUE_AUTO_RESTORE_STAFF_BOUND)).toHaveLength(1);
  });
});

describe("人工恢复 + 绑定失效 + 标记生命周期（D12、AX-D30）", () => {
  it("专员已停用时人工恢复：用户有效、认证通过、本人范围被拒；maintain 不停用；专员恢复后标记被清，之后再停用仍会被补偿", async () => {
    const dir = createOrgDirectory(t.db);
    const link = accessLinkage(env, { dir });
    const authenticate = createAuthenticator({ db: t.db, auth: env.auth, dir, linkage: link }).authenticate;
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const adminCtx = await authenticate(await loginAs(env, "13000000001"));
    if (!adminCtx.ok) throw new Error("admin 认证失败");
    const admin = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir, authorizer: createAuthorizer(), onRevoked: async () => {} });

    const u = await staffUser("13800000001", org.staffA, { phone: "13800000001", status: "disabled", disabledReason: "manual", password: true });
    await setStaff(org.staffA, "inactive");
    await admin.restore(adminCtx.ctx, u);
    expect(await userRow(u)).toMatchObject({ status: "active", bindingAckStaffId: org.staffA });

    const headers = await loginAs(env, "13800000001");
    const r = await authenticate(headers);
    expect(r.ok && r.ctx.scope.self).toEqual({ kind: "unresolved", reason: "staff_inactive" });
    expect((await link.runNow()).report.compensated).toBe(0);
    expect((await userRow(u)).status).toBe("active");

    await setStaff(org.staffA, "active");
    expect((await link.runNow()).report.acksCleared).toBe(1);
    expect((await userRow(u)).bindingAckStaffId).toBeNull();
    await setStaff(org.staffA, "inactive"); // 再次停用：标记已清，必须被停用
    expect((await link.runNow()).report.compensated).toBe(1);
    expect((await userRow(u)).status).toBe("disabled");
  });
});

describe("增长型表清理（步骤 4，C19）", () => {
  it("超期的清掉，未到期 / 锁定中的保留", async () => {
    const now = env.clock.now();
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    const sms = (phone: string, at: Date) => t.db.insert(accessSmsSends).values({ phoneNorm: phone, purpose: "login", requestedAt: at, outcome: "sent" });
    await sms("13900000001", ago(RETENTION.smsSendsDays + 1));
    await sms("13900000002", ago(RETENTION.smsSendsDays - 1));
    const lf = (phone: string, failCount: number, updated: Date, locked: Date | null = null) => t.db.insert(accessLoginFailures).values({ phoneNorm: phone, failCount, updatedAt: updated, lockedUntil: locked });
    await lf("p-zero-old", 0, ago(8));
    await lf("p-zero-new", 0, ago(3));
    await lf("p-stale", 3, ago(91));
    await lf("p-fresh", 3, ago(50));
    await lf("p-locked", 5, ago(100), new Date(now.getTime() + 600_000)); // 仍锁定：不清
    const tk = (n: number, consumed: Date | null, expires: Date) =>
      t.db.insert(accessBootstrapTokens).values({ tokenSha256: Buffer.alloc(32, n), createdByActor: "cli:bootstrap", createdAt: ago(40), expiresAt: expires, consumedAt: consumed, consumedUserId: consumed ? 1n : null });
    await tk(1, ago(31), ago(39)); // 已用超过 30 天 → 清
    await tk(2, null, ago(31)); // 过期超过 30 天 → 清
    await tk(3, ago(10), ago(29)); // 已用 10 天 → 留
    await tk(4, null, new Date(now.getTime() + DAY)); // 未过期 → 留

    const r = await accessLinkage(env).cleanup();
    expect(r).toEqual({ smsSends: 1, loginFailures: 2, bootstrapTokens: 2 });
    expect((await t.db.select().from(accessSmsSends)).map((x) => x.phoneNorm)).toEqual(["13900000002"]);
    expect((await t.db.select().from(accessLoginFailures)).map((x) => x.phoneNorm).sort()).toEqual(["p-fresh", "p-locked", "p-zero-new"]);
    expect((await t.db.select().from(accessBootstrapTokens)).map((x) => x.tokenSha256[0]).sort()).toEqual([3, 4]);
  });
});

describe("装配（给 worker 用，不需要 OSS）", () => {
  it("createAccessMaintenance：持久审计、真实目录；一轮维护能停用绑定失效专员的用户", async () => {
    const u = await staffUser("13800000001", org.staffA);
    await setStaff(org.staffA, "inactive");
    const m = createAccessMaintenance({ db: t.db, clock: env.clock });
    const { ok, report } = await m.runNow();
    expect(ok).toBe(true);
    expect(report.compensated).toBe(1);
    expect((await userRow(u)).status).toBe("disabled");
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.targetId, u.toString()))).not.toHaveLength(0);
  });
});

describe("runNow / runDaily", () => {
  it("每步独立：某一步失败不影响其它步骤，失败只报步骤名", async () => {
    const u = await staffUser("13800000001", org.staffA);
    await setStaff(org.staffA, "inactive");
    const logs: Array<Record<string, unknown>> = [];
    const link = accessLinkage(env, {
      purgeAudit: async () => {
        throw new Error("boom: secret detail");
      },
      log: (e) => void logs.push(e),
    });
    const { ok, report } = await link.runNow();
    expect(ok).toBe(false);
    expect(report.failedSteps).toEqual(["purge_audit"]);
    expect(report.compensated).toBe(1);
    expect(report.cleaned).not.toBeNull();
    expect((await userRow(u)).status).toBe("disabled");
    expect(JSON.stringify(logs)).not.toContain("secret detail"); // 日志不带异常内容
  });

  it("北京时间 04:30 之后每个自然日一次；失败退避后重试", async () => {
    // T0 = 北京时间 10:00。先拨到北京时间 04:29
    env.clock.set(new Date("2026-11-10T20:29:00.000Z")); // = 11-11 04:29 BJT
    let fail = true;
    const link = accessLinkage(env, {
      purgeAudit: async () => {
        if (fail) throw new Error("x");
      },
      config: { retryAfterMs: 600_000 },
    });
    expect(await link.runDaily()).toEqual({ ran: false, reason: "not_due" });
    env.clock.set(new Date("2026-11-10T20:30:00.000Z")); // 04:30
    const first = await link.runDaily();
    expect(first).toMatchObject({ ran: true, ok: false });
    expect(await link.runDaily()).toEqual({ ran: false, reason: "backoff" });
    fail = false;
    env.clock.advance(600_000);
    expect(await link.runDaily()).toMatchObject({ ran: true, ok: true });
    expect(await link.runDaily()).toEqual({ ran: false, reason: "already_done" });
    env.clock.advance(DAY); // 次日
    expect(await link.runDaily()).toMatchObject({ ran: true, ok: true });
  });
});
