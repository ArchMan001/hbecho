// 持久审计（任务 9；AX-10）：幂等、不可变触发器、到期清理、高低风险语义、适配器、读取授权、脱敏。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { auditEvents, authUsers } from "../../db/schema";
import { listAudit, purgeOlderThan, SYSTEM_ACTOR_ACCESS_WORKER, AuditWriteError } from "./audit";
import { fromMasterDataAudit, fromPlanAudit, fromSyncAudit, fromTracerAudit } from "./audit-adapters";
import { createAuditReader } from "./audit-read";
import { createAuthenticator } from "./authenticate";
import { createAuthorizer, type AuthContext } from "./authorize";
import { AccessError } from "./errors";
import { createOrgDirectory } from "./scope";
import { createBootstrap } from "./users/bootstrap";
import { createUserAdmin } from "./users/admin";
import { createUserImport, USER_IMPORT_HEADER } from "./users/import";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
});

const DAY = 86_400_000;
const ev = (over: Partial<Parameters<typeof env.audit.write>[0]> = {}): Parameters<typeof env.audit.write>[0] => ({
  actor: "user:1",
  eventType: "x_event",
  outcome: "succeeded",
  reasonCode: "x_reason",
  ...over,
});
const rows = () => t.db.select().from(auditEvents);

describe("写入语义", () => {
  it("幂等键去重：同一事件（到秒、同细节）重复写入只落一条；细节不同则是两条", async () => {
    await env.audit.write(ev({ targetId: "7", detail: { a: 1 } }), { risk: "low" });
    await env.audit.write(ev({ targetId: "7", detail: { a: 1 } }), { risk: "low" });
    expect(await rows()).toHaveLength(1);
    await env.audit.write(ev({ targetId: "7", detail: { a: 2 } }), { risk: "low" });
    expect(await rows()).toHaveLength(2);
  });

  it("高风险审计写入失败 → 业务写入整体回滚；没有 tx 直接拒绝", async () => {
    const before = (await t.db.select().from(authUsers)).length;
    const bad = ev({ actor: "u".repeat(200) }); // 超过 actor 列长度，插入必然失败
    await expect(
      t.db.transaction(async (tx) => {
        await tx.insert(authUsers).values({ name: "x", email: "x@hbecho.invalid", emailVerified: false, phoneNumber: "13900000000", phoneNumberVerified: false, createdAt: env.clock.now(), updatedAt: env.clock.now() });
        await env.audit.write(bad, { tx, risk: "high" });
      }),
    ).rejects.toBeInstanceOf(AuditWriteError);
    expect((await t.db.select().from(authUsers)).length).toBe(before);
    await expect(env.audit.write(ev(), { risk: "high" })).rejects.toBeInstanceOf(AuditWriteError);
  });

  it("低风险审计写入失败 → 业务继续，计数加一", async () => {
    expect(env.audit.lowRiskFailures()).toBe(0);
    await env.audit.write(ev({ actor: "u".repeat(200) }), { risk: "low" }); // 不抛
    expect(env.audit.lowRiskFailures()).toBe(1);
    expect(await rows()).toHaveLength(0);
  });
});

describe("不可变与到期清理", () => {
  it("UPDATE 被触发器拒绝；未到期的 DELETE 被拒绝", async () => {
    await env.audit.write(ev(), { risk: "low" });
    await expect(t.pool.query("UPDATE audit_events SET reason_code = 'tampered'")).rejects.toThrow();
    await expect(t.pool.query("DELETE FROM audit_events")).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });

  it("清理 366 天前的、保留 364 天前的；写一条 audit_purged（系统身份）；分批", async () => {
    // 触发器按数据库时钟判断，所以这里用真实时间构造「N 天前」
    const realNow = new Date();
    const realClock = { now: () => new Date() };
    const at = (days: number) => new Date(realNow.getTime() - days * DAY);
    for (let i = 0; i < 5; i++) await env.audit.write(ev({ occurredAt: at(366), targetId: `old${i}` }), { risk: "low" });
    await env.audit.write(ev({ occurredAt: at(364), targetId: "keep" }), { risk: "low" });
    const r = await purgeOlderThan(t.db, env.audit, realClock, { batchSize: 2 });
    expect(r.deleted).toBe(5);
    const left = await rows();
    expect(left.map((x) => x.targetId).sort()).toEqual(["keep", null].sort());
    const purged = left.find((x) => x.eventType === "audit_purged")!;
    expect(purged).toMatchObject({ actor: SYSTEM_ACTOR_ACCESS_WORKER, reasonCode: "audit_purged" });
    expect(purged.detail).toMatchObject({ deleted: 5 });
    // 没有可清理的行时不写 audit_purged
    const again = await purgeOlderThan(t.db, env.audit, realClock);
    expect(again.deleted).toBe(0);
    expect((await rows()).filter((x) => x.eventType === "audit_purged")).toHaveLength(1);
  });
});

describe("脱敏（日志卫生）", () => {
  it("敏感键被过滤，嵌套也一样；值里的普通字段保留", async () => {
    await env.audit.write(
      ev({ detail: { phone: "13900000000", password: "P@ss-SECRET-1", nested: { token: "TOK-SECRET-2", otp: "123456", keep: "ok" }, list: [{ cookie: "COOKIE-SECRET-3" }], set_cookie: "x", access_token: "AT-SECRET-4" } }),
      { risk: "low" },
    );
    const text = JSON.stringify((await rows())[0]!.detail);
    for (const secret of ["P@ss-SECRET-1", "TOK-SECRET-2", "123456", "COOKIE-SECRET-3", "AT-SECRET-4"]) expect(text).not.toContain(secret);
    expect(text).toContain("13900000000");
    expect(text).toContain("keep");
  });
});

describe("适配器：现有三类事件 + 活动计划（AX-10）", () => {
  const settle = async (n: number) => vi.waitFor(async () => expect(await rows()).toHaveLength(n));

  it("tracer：规范主体、稳定 reason_code、可按 actor / 对象查询；仍转发原 sink", async () => {
    const inner = vi.fn();
    const sink = fromTracerAudit(env.audit, { record: inner });
    const at = env.clock.now().toISOString();
    sink.record({ at, event: "tracer.command", action: "submit", outcome: "accepted", actorId: "tracer-cli", rootTaskId: "42", platform: "douyin", locatorSha256: "abcd", locatorLength: 20 });
    sink.record({ at, event: "tracer.command", action: "submit", outcome: "rejected", code: "capability_not_granted", actorId: "user:9", mediaStaffId: "7" });
    await settle(2);
    expect(inner).toHaveBeenCalledTimes(2);
    const a = await listAudit(t.db, { actor: "service:tracer-cli" });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ eventType: "tracer.command.submit", outcome: "succeeded", reasonCode: "tracer.command.submit.accepted", targetType: "root_task", targetId: "42" });
    const b = await listAudit(t.db, { actor: "user:9" });
    expect(b[0]).toMatchObject({ outcome: "denied", reasonCode: "capability_not_granted", targetType: "media_staff", targetId: "7" });
  });

  it("sync：批次可按 batchRef 查询", async () => {
    const sink = fromSyncAudit(env.audit);
    const at = env.clock.now().toISOString();
    sink.record({ at, event: "sync.command", action: "batch_cancel", outcome: "cancelled", actorId: "ops", batchId: "123", detail: { tasks: 4, dryRun: false } });
    sink.record({ at, event: "sync.command", action: "supplement", outcome: "rejected", code: "not_authorized", actorId: "ops" });
    await settle(2);
    const byBatch = await listAudit(t.db, { batchRef: 123n });
    expect(byBatch).toHaveLength(1);
    expect(byBatch[0]).toMatchObject({ eventType: "sync.command.batch_cancel", actor: "service:ops", reasonCode: "sync.command.batch_cancel.cancelled" });
    expect(byBatch[0]!.detail).toMatchObject({ tasks: 4, dryRun: false });
    expect((await listAudit(t.db, { eventType: "sync.command.supplement" }))[0]).toMatchObject({ outcome: "denied", reasonCode: "not_authorized" });
  });

  it("master-data：事件在 master_data.* 下，批次与对象可查；*_rejected 记 denied", async () => {
    const sink = fromMasterDataAudit(env.audit);
    const at = env.clock.now().toISOString();
    sink({ event_type: "import_confirmed", actor: "user:5", occurred_at: at, batch_id: "88", target_type: "import_batch", target_id: "88", counts: { imported: 10 } });
    sink({ event_type: "import_confirmation_rejected", actor: "md-cli", occurred_at: at, reason_code: "brand_not_authorized", batch_id: "89" });
    await settle(2);
    expect((await listAudit(t.db, { batchRef: 88n }))[0]).toMatchObject({ eventType: "master_data.import_confirmed", outcome: "succeeded", targetId: "88" });
    expect((await listAudit(t.db, { batchRef: 89n }))[0]).toMatchObject({ outcome: "denied", reasonCode: "brand_not_authorized", actor: "service:md-cli" });
  });

  it("activity_plan：结构类型输入，对象 / 批次可查", async () => {
    const sink = fromPlanAudit(env.audit);
    sink({ event_type: "roster_batch_confirmed", actor: "service:plan-worker", occurred_at: env.clock.now().toISOString(), plan_id: "31", batch_id: "7", detail: { rows: 20 } });
    await settle(1);
    expect((await listAudit(t.db, { targetType: "activity_plan", targetId: "31" }))[0]).toMatchObject({
      eventType: "activity_plan.roster_batch_confirmed",
      reasonCode: "activity_plan.roster_batch_confirmed.succeeded",
      batchRef: "7",
    });
  });

  it("持久层不可用时适配器不抛、不影响调用方（端口是同步 void）", () => {
    const failing = { write: async () => { throw new Error("db down"); } };
    const sink = fromTracerAudit(failing as never);
    expect(() => sink.record({ at: "2026-11-10T00:00:00Z", event: "tracer.command", action: "submit", outcome: "accepted", actorId: "x" })).not.toThrow();
  });
});

describe("读取授权", () => {
  it("只有持有 audit.read（仅超管）的人能读；其他角色被拒", async () => {
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    const dir = createOrgDirectory(t.db);
    const auth = createAuthenticator({ db: t.db, auth: env.auth, dir, linkage: accessLinkage(env, { dir }) });
    const ctxOf = async (phone: string): Promise<AuthContext> => {
      const r = await auth.authenticate(await loginAs(env, phone));
      if (!r.ok) throw new Error(r.reason);
      return r.ctx;
    };
    await env.audit.write(ev({ targetId: "1" }), { risk: "low" });
    const reader = createAuditReader({ db: t.db, authorizer: createAuthorizer() });
    expect((await reader.read(await ctxOf("13000000001"))).length).toBeGreaterThan(0);
    await expect(reader.read(await ctxOf("13000000002"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(reader.read(await ctxOf("13000000002"))).rejects.toBeInstanceOf(AccessError);
  });
});

describe("事件覆盖与脱敏扫描（一次综合场景）", () => {
  it("用户管理 / 引导 / 导入 / 联动 / 清理各至少一条，actor 都是规范主体，全表无密码 / 令牌 / 验证码", async () => {
    const dir = createOrgDirectory(t.db);
    const link = accessLinkage(env, { dir });
    const authn = createAuthenticator({ db: t.db, auth: env.auth, dir, linkage: link });
    const boot = createBootstrap({ db: t.db, clock: env.clock, audit: env.audit });
    const { token } = await boot.createToken();
    await boot.bootstrapSuperadmin({ token, phone: "13000000001", name: "首个超管" });
    // 引导出的是待激活超管（要走短信激活）；这里另造一个能直接登录的超管来操作
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000009" });
    const r = await authn.authenticate(await loginAs(env, "13000000009"));
    if (!r.ok) throw new Error(r.reason);
    const ctx = r.ctx;
    const admin = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir, authorizer: createAuthorizer() });
    const imp = createUserImport({ db: t.db, clock: env.clock, audit: env.audit, admin });

    const u1 = await admin.invite(ctx, { name: "甲", phone: "13911110001", role: "hq_manager", brandIds: [org.hisense] });
    await admin.changeAccess(ctx, BigInt(u1.userId), { displayName: "甲改" });
    await admin.disable(ctx, BigInt(u1.userId));
    await admin.restore(ctx, BigInt(u1.userId));
    await admin.forceLogout(ctx, BigInt(u1.userId));
    const csv = new TextEncoder().encode([USER_IMPORT_HEADER.join(","), "乙,总部人员,13911110002,HISENSE,,", "丙,总部人员,13911110003,NOPE,,"].join("\r\n") + "\r\n");
    const b = await imp.precheck(ctx, { name: "a.csv", bytes: csv });
    await imp.confirm(ctx, BigInt(b.batchId));
    await imp.returnFile(ctx, BigInt(b.batchId));
    await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    await t.pool.query("UPDATE media_staff SET status = 'inactive' WHERE staff_id = ?", [org.staffA]);
    await link.compensate();
    await env.audit.write(ev({ occurredAt: new Date(Date.now() - 400 * DAY) }), { risk: "low" });
    await purgeOlderThan(t.db, env.audit, { now: () => new Date() });

    const all = await rows();
    const types = new Set(all.map((x) => x.eventType));
    for (const needed of [
      "bootstrap_token_created",
      "bootstrap_superadmin",
      "user_created",
      "access_changed",
      "user_disabled",
      "user_restored",
      "force_logout",
      "user_import_confirmed",
      "user_import_returnfile_downloaded",
      "audit_purged",
    ]) expect(types, `缺事件 ${needed}`).toContain(needed);
    expect(all.some((x) => x.reasonCode === "media_staff_disabled" && x.actor === SYSTEM_ACTOR_ACCESS_WORKER)).toBe(true);
    // 每条事件的 actor 都是规范主体（user:/service:/cli:）
    for (const x of all) expect(x.actor, `${x.eventType} 的 actor`).toMatch(/^(user|service|cli):/);
    // 全表扫描：令牌明文、手机号以外的凭据不出现
    const dump = JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Buffer ? "" : v));
    expect(dump).not.toContain(token);
    expect(dump).not.toMatch(/scrypt|\$argon|"(password|otp|token|cookie)":|set-cookie|better-auth\.session/i);
  });
});
