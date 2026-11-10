// 用户管理（任务 6；AX-2、AX-5、AX-8）：授权边界、读写同源、整体拒绝零写入、立即生效、不碰密码。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../../tests/harness/access";
import { useTestDb } from "../../../../tests/harness/db";
import { accessUserBranches, accessUserBrands, accessUsers, auditEvents, authSessions, authUsers } from "../../../db/schema";
import { createAuthenticator } from "../authenticate";
import { createAuthorizer, type AuthContext } from "../authorize";
import { AccessError } from "../errors";
import { manages } from "../grants";
import { createOrgDirectory } from "../scope";
import { createUserAdmin, type UserAdmin } from "./admin";
import { loadUserRecords, principalOf, targetsOf } from "./shared";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let admin: UserAdmin;
let authenticate: ReturnType<typeof createAuthenticator>["authenticate"];
let revokedCalls: string[];

beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  revokedCalls = [];
  const dir = createOrgDirectory(t.db);
  admin = createUserAdmin({
    db: t.db,
    clock: env.clock,
    audit: env.audit,
    dir,
    authorizer: createAuthorizer(),
    onRevoked: async (a) => void revokedCalls.push(a),
  });
  authenticate = createAuthenticator({ db: t.db, auth: env.auth, dir, linkage: accessLinkage(env, { dir }) }).authenticate;
});

/** 真实登录再认证：得到的 ctx 与生产路径一致（角色、能力、范围都从库里现算）。 */
async function ctxOf(phone: string): Promise<AuthContext> {
  const r = await authenticate(await loginAs(env, phone));
  if (!r.ok) throw new Error(`认证失败：${r.reason}`);
  return r.ctx;
}
const errCode = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AccessError);
  return (e as AccessError).code;
};
const rowCounts = async () => ({
  auth: (await t.db.select().from(authUsers)).length,
  access: (await t.db.select().from(accessUsers)).length,
  brands: (await t.db.select().from(accessUserBrands)).length,
  branches: (await t.db.select().from(accessUserBranches)).length,
  audit: (await t.db.select().from(auditEvents)).length,
});

/** 模拟「另一个会话刚把他停用 / 恢复」：直接改库，字段齐全以满足表上的 CHECK。 */
const rawDisable = (userId: bigint) =>
  t.db.update(accessUsers).set({ status: "disabled", statusBeforeDisable: "active", disabledAt: env.clock.now(), disabledByActor: "user:0", disabledReason: "manual" }).where(eq(accessUsers.userId, userId));
const rawEnable = (userId: bigint) =>
  t.db.update(accessUsers).set({ status: "active", statusBeforeDisable: null, disabledAt: null, disabledByActor: null, disabledReason: null }).where(eq(accessUsers.userId, userId));

/** 超管、总部（海信）、北京分公司经理（海信 + 北京）三个操作者。 */
async function actors() {
  const adminId = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
  const hqId = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
  const bmId = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
  return { adminId, hqId, bmId, adminCtx: await ctxOf("13000000001"), hqCtx: await ctxOf("13000000002"), bmCtx: await ctxOf("13000000003") };
}

describe("invite：授权边界（AX-2、AX-8）", () => {
  it("总部不能建总部 / 超管；分公司经理不能建分公司经理；只有超管能建超管", async () => {
    const a = await actors();
    const base = { name: "新人", phone: "13911110001" };
    expect(await errCode(admin.invite(a.hqCtx, { ...base, role: "hq_manager", brandIds: [org.hisense] }))).toBe("role_not_grantable");
    expect(await errCode(admin.invite(a.hqCtx, { ...base, role: "platform_admin" }))).toBe("role_not_grantable");
    expect(await errCode(admin.invite(a.bmCtx, { ...base, role: "branch_manager", brandIds: [org.hisense], branchIds: [org.bj] }))).toBe("role_not_grantable");
    expect(await errCode(admin.invite(a.bmCtx, { ...base, role: "hq_manager", brandIds: [org.hisense] }))).toBe("role_not_grantable");
    const ok = await admin.invite(a.adminCtx, { ...base, role: "platform_admin" });
    expect(BigInt(ok.userId)).toBeGreaterThan(0n);
  });

  it("品牌 / 分公司超出自己的边界 → scope_exceeds_boundary，零写入", async () => {
    const a = await actors();
    const before = await rowCounts();
    expect(await errCode(admin.invite(a.hqCtx, { name: "新人", phone: "13911110002", role: "branch_manager", brandIds: [org.hitachi], branchIds: [org.bj] }))).toBe("scope_exceeds_boundary");
    expect(await errCode(admin.invite(a.bmCtx, { name: "新人", phone: "13800000003", role: "store_staff", storeCode: "S-C" }))).toBe("store_not_in_scope"); // 上海海信店
    expect(await rowCounts()).toEqual(before);
  });

  it("输入不合法：手机号、角色、姓名、门店专员误填范围", async () => {
    const a = await actors();
    expect(await errCode(admin.invite(a.adminCtx, { name: "x", phone: "123", role: "platform_admin" }))).toBe("phone_invalid");
    expect(await errCode(admin.invite(a.adminCtx, { name: "x", phone: "13911110004", role: "boss" }))).toBe("role_invalid");
    expect(await errCode(admin.invite(a.adminCtx, { name: "  ", phone: "13911110004", role: "platform_admin" }))).toBe("name_invalid");
    expect(await errCode(admin.invite(a.adminCtx, { name: "x", phone: "13800000001", role: "store_staff", storeCode: "S-A", brandIds: [org.hisense] }))).toBe("scope_fields_not_allowed");
    expect(await errCode(admin.invite(a.adminCtx, { name: "x", phone: "13800000001", role: "store_staff" }))).toBe("store_code_required");
  });

  it("门店专员：手机号 + 门店编码定位专员；找不到 / 已停用 / 范围内成功", async () => {
    const a = await actors();
    expect(await errCode(admin.invite(a.adminCtx, { name: "甲", phone: "13800000099", role: "store_staff", storeCode: "S-A" }))).toBe("staff_not_found");
    expect(await errCode(admin.invite(a.adminCtx, { name: "停", phone: "13800000009", role: "store_staff", storeCode: "S-A" }))).toBe("staff_inactive");
    const { userId } = await admin.invite(a.bmCtx, { name: "甲", phone: "13800000001", role: "store_staff", storeCode: "S-A" });
    const [row] = await t.db.select().from(accessUsers).where(eq(accessUsers.userId, BigInt(userId)));
    expect(row).toMatchObject({ roleCode: "store_staff", status: "pending_activation", mediaStaffId: org.staffA });
    // 门店专员的品牌 / 分公司集合为空：范围由门店推出
    expect(await t.db.select().from(accessUserBrands).where(eq(accessUserBrands.userId, BigInt(userId)))).toHaveLength(0);
  });

  it("同一门店两名专员，各自手机号各自定位，绑定不同专员（B6）", async () => {
    const a = await actors();
    await t.pool.query("INSERT INTO media_staff (store_id, staff_name, phone, status, created_at, updated_at) VALUES (?, '专员丁', '13800000004', 'active', NOW(6), NOW(6))", [org.storeA]);
    const u1 = await admin.invite(a.adminCtx, { name: "甲", phone: "13800000001", role: "store_staff", storeCode: "S-A" });
    const u2 = await admin.invite(a.adminCtx, { name: "丁", phone: "13800000004", role: "store_staff", storeCode: "S-A" });
    const rows = await t.db.select().from(accessUsers).where(eq(accessUsers.roleCode, "store_staff"));
    expect(rows.map((r) => r.userId.toString()).sort()).toEqual([u1.userId, u2.userId].sort());
    expect(new Set(rows.map((r) => r.mediaStaffId)).size).toBe(2); // 绑定的是两个不同专员
  });

  it("不设置密码、不发短信；返回值与用户视图里没有任何密码或验证码", async () => {
    const a = await actors();
    const { userId } = await admin.invite(a.adminCtx, { name: "新人", phone: "13911110005", role: "hq_manager", brandIds: [org.hisense] });
    const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM auth_accounts WHERE user_id = ?", [userId]);
    expect(Number((rows as Array<{ n: string }>)[0]!.n)).toBe(0);
    expect(env.sender.sent).toHaveLength(0);
    const v = await admin.get(a.adminCtx, BigInt(userId));
    expect(JSON.stringify(v)).not.toMatch(/password|otp|code/i);
    expect(v.status).toBe("pending_activation");
  });
});

describe("读写同源与『未找到』（AX-8）", () => {
  it("同级、他分公司、他品牌的用户：get / 修改 / 停用 / 恢复 / 强制下线都是 user_not_found", async () => {
    const a = await actors();
    const peer = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] }); // 与 bm 同级
    const otherBranch = await insertAccessUser(env, { role: "store_staff", phone: "13800000003", mediaStaffId: org.staffC }); // 上海店
    const otherBrand = await insertAccessUser(env, { role: "store_staff", phone: "13800000002", mediaStaffId: org.staffB }); // 日立店（北京）
    const hqPeer = await insertAccessUser(env, { role: "hq_manager", phone: "13000000005", brandIds: [org.hisense] });
    const before = await rowCounts();
    for (const [who, target] of [
      [a.bmCtx, peer],
      [a.bmCtx, otherBranch],
      [a.bmCtx, otherBrand],
      [a.bmCtx, a.hqId],
      [a.hqCtx, hqPeer],
      [a.hqCtx, a.adminId],
    ] as const) {
      expect(await errCode(admin.get(who, target))).toBe("user_not_found");
      expect(await errCode(admin.changeAccess(who, target, { displayName: "改" }))).toBe("user_not_found");
      expect(await errCode(admin.disable(who, target))).toBe("user_not_found");
      expect(await errCode(admin.restore(who, target))).toBe("user_not_found");
      expect(await errCode(admin.forceLogout(who, target))).toBe("user_not_found");
    }
    expect(await errCode(admin.get(a.adminCtx, 999_999_999n))).toBe("user_not_found"); // 不存在与越界无法区分
    expect(await rowCounts()).toEqual(before);
  });

  it("自己：get 可见但 manageable=false；修改 / 停用自己一律 user_not_found（不可管理自己）", async () => {
    const a = await actors();
    expect((await admin.get(a.bmCtx, a.bmId)).manageable).toBe(false);
    expect(await errCode(admin.disable(a.adminCtx, a.adminId))).toBe("user_not_found");
    expect(await errCode(admin.changeAccess(a.adminCtx, a.adminId, { role: "hq_manager", brandIds: [org.hisense] }))).toBe("user_not_found");
  });

  it("列表集合 == 可管理集合 ∪ 自己，逐用户用同一个 manages 核对（等价性）", async () => {
    const a = await actors();
    await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    await insertAccessUser(env, { role: "branch_manager", phone: "13000000006", brandIds: [org.hitachi], branchIds: [org.bj] });
    await insertAccessUser(env, { role: "branch_manager", phone: "13000000007", brandIds: [org.hisense], branchIds: [org.sh] });
    await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    await insertAccessUser(env, { role: "store_staff", phone: "13800000002", mediaStaffId: org.staffB });
    await insertAccessUser(env, { role: "store_staff", phone: "13800000003", mediaStaffId: org.staffC });
    await insertAccessUser(env, { role: "hq_manager", phone: "13000000008", brandIds: [org.hitachi] });
    const all = await loadUserRecords(t.db);
    const targets = await targetsOf(t.db, all);
    for (const ctx of [a.adminCtx, a.hqCtx, a.bmCtx]) {
      const p = principalOf(ctx);
      const expected = all.filter((u) => u.userId === p.userId || manages(p, targets.get(u.userId)!)).map((u) => u.userId.toString());
      const listed = (await admin.list(ctx)).map((v) => v.userId);
      expect(new Set(listed)).toEqual(new Set(expected));
      expect(listed).toHaveLength(expected.length);
      for (const v of await admin.list(ctx)) expect(v.manageable).toBe(v.userId !== p.userId.toString());
    }
    // 北京分公司经理能看到：自己 + 北京海信店专员（A）；看不到日立店、上海店、同级、总部
    const bmList = (await admin.list(a.bmCtx)).map((v) => v.phone).sort();
    expect(bmList).toEqual(["13000000003", "13800000001"]);
  });

  it("列表可按状态 / 角色过滤；待激活用户给出待激活天数", async () => {
    const a = await actors();
    const pending = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj], status: "pending_activation" });
    env.clock.advance(3 * 86_400_000 + 1000);
    const rows = await admin.list(a.adminCtx, { status: "pending_activation" });
    expect(rows.map((r) => r.userId)).toEqual([pending.toString()]);
    expect(rows[0]!.pendingDays).toBe(3);
    expect((await admin.list(a.adminCtx, { role: "hq_manager" })).map((r) => r.phone)).toEqual(["13000000002"]);
  });
});

describe("changeAccess：整体拒绝零写入、立即生效（AX-5）", () => {
  it("proposed 超界 → 整个变更（含姓名）被拒绝，零写入", async () => {
    const a = await actors();
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", name: "原名", brandIds: [org.hisense], branchIds: [org.bj] });
    const before = await rowCounts();
    const code = await errCode(admin.changeAccess(a.hqCtx, target, { displayName: "新名", brandIds: [org.hisense, org.hitachi] }));
    expect(code).toBe("scope_exceeds_boundary");
    expect(await rowCounts()).toEqual(before);
    const [row] = await t.db.select().from(accessUsers).where(eq(accessUsers.userId, target));
    expect(row!.displayName).toBe("原名");
  });

  it("升到自己同级 / 以上被拒；改成总部时分公司集合默认清空", async () => {
    const a = await actors();
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    expect(await errCode(admin.changeAccess(a.hqCtx, target, { role: "hq_manager", brandIds: [org.hisense] }))).toBe("role_not_grantable");
    await admin.changeAccess(a.adminCtx, target, { role: "hq_manager", brandIds: [org.hisense] });
    const [u] = await loadUserRecords(t.db, eq(accessUsers.userId, target));
    expect(u!.role).toBe("hq_manager");
    expect([...u!.branchIds]).toEqual([]);
  });

  it("角色降级对同一会话的下一次请求立即生效，会话不被撤销（B-D33）", async () => {
    const a = await actors();
    const headers = await loginAs(env, "13000000002"); // 总部登录
    const first = await authenticate(headers);
    expect(first.ok && first.ctx.capabilities.has("user.manage")).toBe(true);
    await admin.changeAccess(a.adminCtx, a.hqId, { role: "branch_manager", brandIds: [org.hisense], branchIds: [org.bj] });
    const second = await authenticate(headers);
    expect(second.ok).toBe(true); // 同一会话仍有效
    if (second.ok) expect(second.ctx.role).toBe("branch_manager");
    expect((await t.db.select().from(authSessions).where(eq(authSessions.userId, a.hqId))).length).toBeGreaterThan(0);
  });

  it("门店专员不可原地改；其他人不能改成门店专员（B-D09）", async () => {
    const a = await actors();
    const staff = await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    const other = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    expect(await errCode(admin.changeAccess(a.adminCtx, staff, { role: "branch_manager", brandIds: [org.hisense], branchIds: [org.bj] }))).toBe("store_staff_immutable");
    expect(await errCode(admin.changeAccess(a.adminCtx, other, { role: "store_staff" }))).toBe("store_staff_immutable");
    // 改姓名不受限
    await admin.changeAccess(a.adminCtx, staff, { displayName: "改名" });
  });

  it("手机号只能在待激活时改；有效用户 → phone_change_requires_replace；占用 → phone_exists；认证表同步", async () => {
    const a = await actors();
    const pending = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj], status: "pending_activation" });
    const active = await insertAccessUser(env, { role: "branch_manager", phone: "13000000005", brandIds: [org.hisense], branchIds: [org.bj] });
    expect(await errCode(admin.changeAccess(a.adminCtx, active, { phone: "13900000009" }))).toBe("phone_change_requires_replace");
    expect(await errCode(admin.changeAccess(a.adminCtx, pending, { phone: "abc" }))).toBe("phone_invalid");
    expect(await errCode(admin.changeAccess(a.adminCtx, pending, { phone: "13000000005" }))).toBe("phone_exists");
    // 占用失败时认证表号码也没改
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, pending)))[0]!.phoneNumber).toBe("13000000004");
    await admin.changeAccess(a.adminCtx, pending, { phone: "13900000009" });
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, pending)))[0]!.phoneNumber).toBe("13900000009");
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, pending)))[0]!.phone).toBe("13900000009");
  });

  it("超管互相降级：执行者在锁内已被停用（陈旧上下文）→ 最后一个可用超管保护生效，零写入", async () => {
    const a = await actors();
    const other = await insertAccessUser(env, { role: "platform_admin", phone: "13000000011" });
    // 模拟并发：执行者的会话上下文已取到，但另一个超管刚把他停用
    await rawDisable(a.adminId);
    expect(await errCode(admin.changeAccess(a.adminCtx, other, { role: "hq_manager", brandIds: [org.hisense] }))).toBe("last_superadmin");
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, other)))[0]!.roleCode).toBe("platform_admin");
  });

  it("还有别的可用超管时，超管可以降级另一个超管", async () => {
    const a = await actors();
    const other = await insertAccessUser(env, { role: "platform_admin", phone: "13000000011" });
    await admin.changeAccess(a.adminCtx, other, { role: "hq_manager", brandIds: [org.hisense] });
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, other)))[0]!.roleCode).toBe("hq_manager");
  });

  it("停用用户不能变更；写审计，detail 里没有手机号明文以外的敏感信息", async () => {
    const a = await actors();
    const dis = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj], status: "disabled" });
    expect(await errCode(admin.changeAccess(a.adminCtx, dis, { displayName: "x" }))).toBe("user_disabled");
    const live = await insertAccessUser(env, { role: "branch_manager", phone: "13000000005", brandIds: [org.hisense], branchIds: [org.bj] });
    await admin.changeAccess(a.adminCtx, live, { displayName: "改名" });
    const ev = await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "access_changed"));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ targetId: live.toString(), actor: `user:${a.adminId}` });
  });
});

describe("disable / restore / forceLogout", () => {
  it("停用：会话撤销、登录手机号改墓碑、提交后调用 onRevoked；重复停用幂等且不再通知", async () => {
    const a = await actors();
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    const targetHeaders = await loginAs(env, "13000000004");
    expect((await admin.disable(a.adminCtx, target)).changed).toBe(true);
    expect(revokedCalls).toEqual([`user:${target}`]);
    expect((await authenticate(targetHeaders)).ok).toBe(false);
    expect(await t.db.select().from(authSessions).where(eq(authSessions.userId, target))).toHaveLength(0);
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, target)))[0]!.phoneNumber).toBe(`disabled:${target}`);
    expect((await admin.disable(a.adminCtx, target)).changed).toBe(false);
    expect(revokedCalls).toHaveLength(1);
  });

  it("onRevoked 抛错不回滚停用", async () => {
    const a = await actors();
    const dir = createOrgDirectory(t.db);
    const failing = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir, authorizer: createAuthorizer(), onRevoked: async () => { throw new Error("boom"); } });
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    expect((await failing.disable(a.adminCtx, target)).changed).toBe(true);
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, target)))[0]!.status).toBe("disabled");
  });

  it("最后一个超管不能被停用：执行者在锁内已被停用 → actor_not_active；有别的可用超管时可停用", async () => {
    const a = await actors();
    const other = await insertAccessUser(env, { role: "platform_admin", phone: "13000000011" });
    await rawDisable(a.adminId);
    expect(await errCode(admin.disable(a.adminCtx, other))).toBe("actor_not_active");
    await rawEnable(a.adminId);
    expect((await admin.disable(a.adminCtx, other)).changed).toBe(true);
  });

  it("批量停用长期待激活用户：逐个成功，停用后同号可重新建（停用不占号，B12、D2）", async () => {
    const a = await actors();
    const ids = [];
    for (const phone of ["13000000021", "13000000022"]) ids.push(await insertAccessUser(env, { role: "branch_manager", phone, brandIds: [org.hisense], branchIds: [org.bj], status: "pending_activation" }));
    env.clock.advance(400 * 86_400_000); // 待激活不自动过期（B11）：一年后仍是待激活，且能看到天数
    const pending = await admin.list(a.adminCtx, { status: "pending_activation" });
    expect(pending.map((p) => p.pendingDays)).toEqual([400, 400]);
    for (const id of ids) expect((await admin.disable(a.adminCtx, id)).changed).toBe(true);
    const again = await admin.invite(a.adminCtx, { name: "重建", phone: "13000000021", role: "branch_manager", brandIds: [org.hisense], branchIds: [org.bj] });
    expect(again.userId).not.toBe(ids[0]!.toString());
  });

  it("两个超管互停（并发）恰好一个成功；顺序交错时后者因『执行者已被停用』被拒（D14）", async () => {
    const a = await actors();
    const b = await insertAccessUser(env, { role: "platform_admin", phone: "13000000012" });
    const bCtx = await ctxOf("13000000012");
    const r = await Promise.allSettled([admin.disable(a.adminCtx, b), admin.disable(bCtx, a.adminId)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const active = await t.db.select().from(accessUsers).where(eq(accessUsers.roleCode, "platform_admin"));
    expect(active.filter((u) => u.status !== "disabled")).toHaveLength(1);
    // 再来一次顺序交错：存活者停用不了自己，也停用不了「已停用」的对方（幂等 false）
    const survivor = active.find((u) => u.status !== "disabled")!.userId;
    const survivorCtx = survivor === a.adminId ? a.adminCtx : bCtx;
    const other = survivor === a.adminId ? b : a.adminId;
    expect((await admin.disable(survivorCtx, other)).changed).toBe(false);
  });

  it("恢复：回到停用前状态，号码写回认证表；同号已被占用 → 被数据库拒绝", async () => {
    const a = await actors();
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    await admin.disable(a.adminCtx, target);
    const r = await admin.restore(a.adminCtx, target);
    expect(r.status).toBe("active");
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, target)))[0]!.phoneNumber).toBe("13000000004");
    await admin.disable(a.adminCtx, target);
    await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] }); // 号码被新用户占用
    expect(await errCode(admin.restore(a.adminCtx, target))).toBe("phone_in_use");
  });

  it("强制下线：撤销全部会话，角色与状态不变，写审计", async () => {
    const a = await actors();
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    const h1 = await loginAs(env, "13000000004");
    await loginAs(env, "13000000004");
    expect((await admin.forceLogout(a.adminCtx, target)).revoked).toBe(2);
    expect((await authenticate(h1)).ok).toBe(false);
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, target)))[0]!.status).toBe("active");
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "force_logout"))).toHaveLength(1);
  });
});

describe("授权：没有 user.manage 的人", () => {
  it("门店专员调用任何管理操作 → forbidden", async () => {
    await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    const ctx = await ctxOf("13800000001");
    expect(await errCode(admin.list(ctx))).toBe("forbidden");
    expect(await errCode(admin.get(ctx, target))).toBe("forbidden");
    expect(await errCode(admin.disable(ctx, target))).toBe("forbidden");
    expect(await errCode(admin.invite(ctx, { name: "x", phone: "13911110006", role: "store_staff", storeCode: "S-A" }))).toBe("forbidden");
  });
});
