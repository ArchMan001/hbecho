// 用户管理的共享内核：创建、停用、恢复、最后一个超管（任务 6；AX-2、AX-5、AX-8）。
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../../tests/harness/access";
import { useTestDb } from "../../../../tests/harness/db";
import { accessUserBranches, accessUserBrands, accessUsers, auditEvents, authSessions, authUsers, authVerifications } from "../../../db/schema";
import { AccessError } from "../errors";
import { createMemoryAuditWriter } from "../audit";
import { createOrgDirectory, type OrgDirectory } from "../scope";
import { countActiveAdmins, createUserRecord, disableCore, loadUserRecord, restoreCore, tombstone, type UserDeps } from "./shared";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let deps: UserDeps;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  deps = { db: t.db, clock: env.clock, audit: env.audit, dir: createOrgDirectory(t.db) };
});

const tx = <T>(f: Parameters<typeof t.db.transaction<T>>[0]) => t.db.transaction(f);
const expectAccessError = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, `期望 AccessError(${code})`).toBeInstanceOf(AccessError);
  expect((e as AccessError).code).toBe(code);
};
const authRow = async (userId: bigint) => (await t.db.select().from(authUsers).where(eq(authUsers.id, userId)))[0]!;
const audits = async (eventType: string) => t.db.select().from(auditEvents).where(eq(auditEvents.eventType, eventType));

const newUser = (over: Partial<Parameters<typeof createUserRecord>[2]> = {}): Parameters<typeof createUserRecord>[2] => ({
  name: "新用户",
  role: "branch_manager",
  phone: "13900000001",
  brandIds: new Set([org.hisense]),
  branchIds: new Set([org.bj]),
  mediaStaffId: null,
  createdByActor: "user:1",
  createdByUserId: null,
  ...over,
});

describe("createUserRecord", () => {
  it("建出待激活用户：认证行（随机合成邮箱、无密码凭据）、授权行、集合、审计，同一事务；不发短信", async () => {
    const id = await tx((x) => createUserRecord(x, deps, newUser()));
    const a = await authRow(id);
    expect(a.phoneNumber).toBe("13900000001");
    expect(a.email).toMatch(/^[0-9a-f-]{36}@hbecho\.invalid$/);
    expect(a.email).not.toContain("13900000001"); // 邮箱不能由手机号推导（ADR-0015 S7）
    const u = (await loadUserRecord(t.db, id))!;
    expect(u).toMatchObject({ role: "branch_manager", status: "pending_activation", phone: "13900000001", displayName: "新用户" });
    expect([...u.brandIds]).toEqual([org.hisense]);
    expect([...u.branchIds]).toEqual([org.bj]);
    const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM auth_accounts");
    expect(Number((rows as Array<{ n: string }>)[0]!.n)).toBe(0); // 没有密码凭据：管理员永远设不了密码
    expect(env.sender.sent).toHaveLength(0);
    const ev = await audits("user_created");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ targetId: id.toString(), outcome: "succeeded", reasonCode: "user_created" });
  });

  it("手机号已被待激活 / 有效用户占用 → phone_exists，零写入（认证行也回滚）", async () => {
    await insertAccessUser(env, { phone: "13900000001" });
    const before = (await t.db.select().from(authUsers)).length;
    await expectAccessError(tx((x) => createUserRecord(x, deps, newUser())), "phone_exists");
    expect((await t.db.select().from(authUsers)).length).toBe(before);
    expect(await audits("user_created")).toHaveLength(0);
  });

  it("停用用户的号码不占号，可以新建", async () => {
    await insertAccessUser(env, { phone: "13900000001", status: "disabled" });
    const id = await tx((x) => createUserRecord(x, deps, newUser()));
    expect((await loadUserRecord(t.db, id))!.status).toBe("pending_activation");
  });

  it("专员已绑定了另一个非停用用户 → staff_already_bound", async () => {
    await insertAccessUser(env, { phone: "13900000002", role: "store_staff", mediaStaffId: org.staffA });
    await expectAccessError(
      tx((x) => createUserRecord(x, deps, newUser({ role: "store_staff", mediaStaffId: org.staffA, brandIds: new Set(), branchIds: new Set() }))),
      "staff_already_bound",
    );
  });

  it("高风险审计写入失败 → 整个创建回滚，不留认证行 / 授权行", async () => {
    const failing = createMemoryAuditWriter();
    failing.failNext();
    const before = (await t.db.select().from(authUsers)).length;
    await expect(tx((x) => createUserRecord(x, { clock: env.clock, audit: failing }, newUser()))).rejects.toThrow();
    expect((await t.db.select().from(authUsers)).length).toBe(before);
    expect(await t.db.select().from(accessUsers)).toHaveLength(0);
  });
});

describe("disableCore", () => {
  it("停用：状态、墓碑值、撤销全部会话、清待用验证码、审计——同一事务；原号保留在授权表", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "hq_manager", brandIds: [org.hisense] });
    const headers = await loginAs(env, "13900000001");
    await loginAs(env, "13900000001");
    await t.db.insert(authVerifications).values({ identifier: "phone-number-otp-13900000001", value: "123456:0", expiresAt: new Date(Date.now() + 300_000), createdAt: new Date(), updatedAt: new Date() });

    const changed = await tx((x) => disableCore(x, deps, { userId: id, byActor: "user:99", byUserId: 99n, reason: "manual" }));
    expect(changed).toBe(true);

    const u = (await loadUserRecord(t.db, id))!;
    expect(u).toMatchObject({ status: "disabled", statusBeforeDisable: "active", disabledReason: "manual", phone: "13900000001" });
    expect((await authRow(id)).phoneNumber).toBe(tombstone(id));
    expect(await t.db.select().from(authSessions).where(eq(authSessions.userId, id))).toHaveLength(0);
    expect(await env.auth.api.getSession({ headers })).toBeNull();
    expect(await t.db.select().from(authVerifications)).toHaveLength(0);
    const ev = await audits("user_disabled");
    expect(ev[0]).toMatchObject({ actor: "user:99", reasonCode: "user_disabled_manual", targetId: id.toString() });
  });

  it("停用后：旧号码不能登录、也不会收到验证码；同号可以新建用户", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001" });
    await tx((x) => disableCore(x, deps, { userId: id, byActor: "user:99", byUserId: 99n, reason: "manual" }));
    await expect(env.auth.api.signInPhoneNumber({ body: { phoneNumber: "13900000001", password: "Passw0rd!x" } })).rejects.toThrow();
    await env.auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13900000001" } });
    expect(env.sender.sent).toHaveLength(0);
    const fresh = await tx((x) => createUserRecord(x, deps, newUser()));
    expect(fresh).not.toBe(id);
  });

  it("记停用前的状态：待激活用户停用后，恢复回到待激活", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", status: "pending_activation" });
    await tx((x) => disableCore(x, deps, { userId: id, byActor: "user:99", byUserId: 99n, reason: "manual" }));
    expect((await loadUserRecord(t.db, id))!.statusBeforeDisable).toBe("pending_activation");
    await tx((x) => restoreCore(x, deps, { userId: id, byActor: "user:99", byUserId: 99n }));
    expect((await loadUserRecord(t.db, id))!.status).toBe("pending_activation");
  });

  it("幂等：已停用再停用返回 false，不重复写审计", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001" });
    expect(await tx((x) => disableCore(x, deps, { userId: id, byActor: "user:99", byUserId: 99n, reason: "manual" }))).toBe(true);
    expect(await tx((x) => disableCore(x, deps, { userId: id, byActor: "user:99", byUserId: 99n, reason: "manual" }))).toBe(false);
    expect(await audits("user_disabled")).toHaveLength(1);
  });

  it("用户不存在 → not_found；不能停用自己（核心里再拦一道）", async () => {
    await expectAccessError(tx((x) => disableCore(x, deps, { userId: 424242n, byActor: "user:99", byUserId: 99n, reason: "manual" })), "user_not_found");
    const id = await insertAccessUser(env, { phone: "13900000001" });
    await expectAccessError(tx((x) => disableCore(x, deps, { userId: id, byActor: `user:${id}`, byUserId: id, reason: "manual" })), "cannot_disable_self");
    expect((await loadUserRecord(t.db, id))!.status).toBe("active");
  });

  it("审计写入失败 → 整个停用回滚：用户仍有效，墓碑值没写，会话还在（停用是安全属性，不能做一半）", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001" });
    await loginAs(env, "13900000001");
    const failing = createMemoryAuditWriter();
    failing.failNext();
    await expect(tx((x) => disableCore(x, { clock: env.clock, audit: failing }, { userId: id, byActor: "user:99", byUserId: 99n, reason: "manual" }))).rejects.toThrow();
    expect((await loadUserRecord(t.db, id))!.status).toBe("active");
    expect((await authRow(id)).phoneNumber).toBe("13900000001");
    expect(await t.db.select().from(authSessions).where(eq(authSessions.userId, id))).toHaveLength(1);
  });

  it("专员联动：记 media_staff_disabled、系统身份、触发它的专员 ID", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "store_staff", mediaStaffId: org.staffA });
    await tx((x) => disableCore(x, deps, { userId: id, byActor: "service:access-worker", byUserId: null, reason: "media_staff_disabled", autoStaffId: org.staffA }));
    const u = (await loadUserRecord(t.db, id))!;
    expect(u).toMatchObject({ status: "disabled", disabledReason: "media_staff_disabled", autoDisabledStaffId: org.staffA });
    const ev = await audits("user_disabled");
    expect(ev[0]).toMatchObject({ actor: "service:access-worker", reasonCode: "media_staff_disabled" });
  });
});

describe("最后一个超管 / 超管互停", () => {
  it("最后一个可用超管不能被停用", async () => {
    const admin = await insertAccessUser(env, { phone: "13900000001", role: "platform_admin" });
    await expectAccessError(tx((x) => disableCore(x, deps, { userId: admin, byActor: "user:99", byUserId: 99n, reason: "manual" })), "last_superadmin");
    expect((await loadUserRecord(t.db, admin))!.status).toBe("active");
  });

  it("已停用的超管不算「可用」：另一个超管是唯一可用的时，同样不能停用", async () => {
    await insertAccessUser(env, { phone: "13900000001", role: "platform_admin", status: "disabled" });
    const only = await insertAccessUser(env, { phone: "13900000002", role: "platform_admin" });
    await expectAccessError(tx((x) => disableCore(x, deps, { userId: only, byActor: "user:99", byUserId: 99n, reason: "manual" })), "last_superadmin");
  });

  it("有两个可用超管时可以停用其中一个，剩下的就成了最后一个", async () => {
    const a = await insertAccessUser(env, { phone: "13900000001", role: "platform_admin" });
    const b = await insertAccessUser(env, { phone: "13900000002", role: "platform_admin" });
    expect(await tx((x) => disableCore(x, deps, { userId: a, byActor: `user:${b}`, byUserId: b, reason: "manual" }))).toBe(true);
    expect(await countActiveAdmins(t.db)).toBe(1);
    await expectAccessError(tx((x) => disableCore(x, deps, { userId: b, byActor: "user:99", byUserId: 99n, reason: "manual" })), "last_superadmin");
  });

  it("并发：两个超管同时停用对方，恰好一个成功（锁住全部超管行后判断）", async () => {
    const a = await insertAccessUser(env, { phone: "13900000001", role: "platform_admin" });
    const b = await insertAccessUser(env, { phone: "13900000002", role: "platform_admin" });
    // 刻意并发：被测对象就是锁。先全部启动再逐个等待，不用 Promise.all（design §11）
    const pa = tx((x) => disableCore(x, deps, { userId: b, byActor: `user:${a}`, byUserId: a, reason: "manual", actorMustBeActive: a }));
    const pb = tx((x) => disableCore(x, deps, { userId: a, byActor: `user:${b}`, byUserId: b, reason: "manual", actorMustBeActive: b }));
    const results = [await pa.then(() => "ok", (e: AccessError) => e.code), await pb.then(() => "ok", (e: AccessError) => e.code)];
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok")).toHaveLength(1);
    expect(await countActiveAdmins(t.db)).toBe(1); // 永远至少剩一个
  });
});

describe("restoreCore", () => {
  const disable = (id: bigint) => tx((x) => disableCore(x, deps, { userId: id, byActor: "user:99", byUserId: 99n, reason: "manual" }));
  const restore = (id: bigint, d: UserDeps = deps) => tx((x) => restoreCore(x, d, { userId: id, byActor: "user:99", byUserId: 99n }));

  it("恢复：状态回到停用前，原号写回认证表，审计", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "hq_manager", brandIds: [org.hisense] });
    await disable(id);
    const r = await restore(id);
    expect(r).toMatchObject({ status: "active", removedBrandIds: [], removedBranchIds: [] });
    expect((await loadUserRecord(t.db, id))!).toMatchObject({ status: "active", statusBeforeDisable: null, disabledReason: null, autoDisabledStaffId: null });
    const [row] = await t.db.select({ at: accessUsers.disabledAt, by: accessUsers.disabledByActor }).from(accessUsers).where(eq(accessUsers.userId, id));
    expect(row).toEqual({ at: null, by: null }); // 停用痕迹全部清掉（CHECK 也要求 status≠disabled 时 disabled_at 为空）
    expect((await authRow(id)).phoneNumber).toBe("13900000001");
    expect((await audits("user_restored"))[0]).toMatchObject({ targetId: id.toString(), reasonCode: "user_restored" });
  });

  it("恢复后可以用原密码登录（凭据没有被动过）", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001" });
    await disable(id);
    await restore(id);
    await loginAs(env, "13900000001");
  });

  it("引用复核：不存在 / 无法映射的品牌、分公司被去掉并记审计；停用的品牌保留（B-D25）", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "branch_manager", brandIds: [org.hisense, org.hitachi], branchIds: [org.bj, org.sh] });
    await t.pool.query("UPDATE brands SET status='inactive' WHERE brand_id = ?", [org.hitachi]); // 存在但停用：保留
    await disable(id);
    // 目录端口报告 hisense 品牌与上海分公司无法映射（外键 RESTRICT 使真实删除在数据层不可能，用端口故障注入构造）
    const dir: OrgDirectory = {
      ...createOrgDirectory(t.db),
      brand: async (bid) => (bid === org.hisense ? null : { brandId: bid, status: "active" }),
      branch: async (bid) => (bid === org.sh ? null : { branchId: bid, status: "active" }),
    };
    const r = await restore(id, { ...deps, dir });
    expect(r.removedBrandIds).toEqual([org.hisense]);
    expect(r.removedBranchIds).toEqual([org.sh]);
    const u = (await loadUserRecord(t.db, id))!;
    expect([...u.brandIds]).toEqual([org.hitachi]); // 停用的品牌仍在
    expect([...u.branchIds]).toEqual([org.bj]);
    const ev = (await audits("user_restored"))[0]!;
    expect(ev.detail).toMatchObject({ removedBrandIds: [org.hisense.toString()], removedBranchIds: [org.sh.toString()] });
  });

  it("目录不可用 → 整个恢复失败，不去掉任何项、不恢复（宁可不恢复，也不基于未知事实改授权）", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "hq_manager", brandIds: [org.hisense] });
    await disable(id);
    const dir: OrgDirectory = {
      ...createOrgDirectory(t.db),
      brand: async () => {
        throw new Error("master data down");
      },
    };
    await expect(restore(id, { ...deps, dir })).rejects.toThrow("master data down");
    const u = (await loadUserRecord(t.db, id))!;
    expect(u.status).toBe("disabled");
    expect([...u.brandIds]).toEqual([org.hisense]);
  });

  it("同号已被另一个待激活 / 有效用户占用 → phone_in_use，不恢复，授权引用也不被改（事务回滚）", async () => {
    const old = await insertAccessUser(env, { phone: "13900000001", role: "hq_manager", brandIds: [org.hisense] });
    await disable(old);
    await tx((x) => createUserRecord(x, deps, newUser({ role: "hq_manager", brandIds: new Set([org.hisense]), branchIds: new Set() }))); // 同号新建
    await expectAccessError(restore(old), "phone_in_use");
    const u = (await loadUserRecord(t.db, old))!;
    expect(u.status).toBe("disabled");
    expect((await authRow(old)).phoneNumber).toBe(tombstone(old)); // 墓碑值仍在
  });

  it("未停用的用户不能恢复 → not_disabled", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001" });
    await expectAccessError(restore(id), "not_disabled");
  });

  it("专员绑定失效（人工恢复豁免，B-D08）：专员已停用时恢复，用户仍有效、记豁免标记；本人范围由 buildDataScope 拒绝", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "store_staff", mediaStaffId: org.staffA });
    await disable(id);
    await t.pool.query("UPDATE media_staff SET status='inactive' WHERE staff_id = ?", [org.staffA]);
    await restore(id);
    const u = (await loadUserRecord(t.db, id))!;
    expect(u).toMatchObject({ status: "active", mediaStaffId: org.staffA, bindingAckStaffId: org.staffA });
    expect((await audits("user_restored"))[0]!.detail).toMatchObject({ bindingInvalid: true });
  });

  it("专员有效时恢复：不写豁免标记", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "store_staff", mediaStaffId: org.staffA });
    await disable(id);
    await restore(id);
    expect((await loadUserRecord(t.db, id))!.bindingAckStaffId).toBeNull();
  });

  it("恢复成待激活的用户：认证表 phone_number_verified 为 false；恢复成有效的为 true", async () => {
    const p = await insertAccessUser(env, { phone: "13900000001", status: "pending_activation" });
    const a = await insertAccessUser(env, { phone: "13900000002" });
    for (const id of [p, a]) {
      await disable(id);
      await restore(id);
    }
    expect(Boolean((await authRow(p)).phoneNumberVerified)).toBe(false);
    expect(Boolean((await authRow(a)).phoneNumberVerified)).toBe(true);
  });
});

describe("读取", () => {
  it("loadUserRecord 带出品牌 / 分公司集合；不存在返回 null", async () => {
    const id = await insertAccessUser(env, { phone: "13900000001", role: "branch_manager", brandIds: [org.hisense], branchIds: [org.bj] });
    const u = (await loadUserRecord(t.db, id))!;
    expect([...u.brandIds]).toEqual([org.hisense]);
    expect([...u.branchIds]).toEqual([org.bj]);
    expect(await loadUserRecord(t.db, 999999n)).toBeNull();
    expect(await t.db.select().from(accessUserBrands).where(and(eq(accessUserBrands.userId, id)))).toHaveLength(1);
    expect(await t.db.select().from(accessUserBranches).where(eq(accessUserBranches.userId, id))).toHaveLength(1);
  });
});
