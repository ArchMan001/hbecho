// 2026-11-11 独立审查（DeepSeek 报告）里经核实成立的几项：每项一条回归用例。
//   登录失败表清理、reasonCode 不接受自由文本、授权拒绝落审计、停用 / 撤权后取消用户触发的任务（人工与自动两条路径）、
//   monitoring_level 谓词缺 level 时不放行、改名同步认证库。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { accessLoginFailures, accessUsers, auditEvents, authUsers, mediaStaff } from "../../db/schema";
import { AuditWriteError } from "./audit";
import { monitoringLevelPredicate, EMPTY_SCOPE } from "./scope";
import { createAccessServices } from "./services";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let svc: ReturnType<typeof createAccessServices>;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  svc = createAccessServices({ db: t.db, clock: env.clock, audit: env.audit });
});
const DAY = 86_400_000;
const ctxOf = async (id: bigint) => {
  const r = await svc.resolver.contextForUser(id, null);
  if (!r.ok) throw new Error(r.reason);
  return r.ctx;
};

describe("登录失败表清理", () => {
  it("第 5 次失败后锁定已过期、90 天没更新的行会被清掉；仍在锁定中的行、近期的行保留", async () => {
    const now = env.clock.now();
    const row = (phone: string, failCount: number, lockedUntil: Date | null, ageDays: number) =>
      t.db.insert(accessLoginFailures).values({ phoneNorm: phone, failCount, lockedUntil, updatedAt: new Date(now.getTime() - ageDays * DAY) });
    await row("13000000001", 5, new Date(now.getTime() - 80 * DAY), 91); // 锁定早已过期 + 91 天没更新 → 删
    await row("13000000002", 5, new Date(now.getTime() + 60_000), 91); // 仍在锁定中 → 留
    await row("13000000003", 5, new Date(now.getTime() - DAY), 10); // 近期 → 留
    await row("13000000004", 2, null, 91); // 旧的未锁定计数 → 删（原有行为）
    const r = await accessLinkageCleanup();
    expect(r.loginFailures).toBe(2);
    const left = (await t.db.select().from(accessLoginFailures)).map((x) => x.phoneNorm).sort();
    expect(left).toEqual(["13000000002", "13000000003"]);
  });
  const accessLinkageCleanup = () => svc.linkage.cleanup();
});

describe("reasonCode 不接受自由文本（B-D30）", () => {
  it("持久与内存写入器都拒绝，高低风险一样", async () => {
    const e = { actor: "user:1", eventType: "x_event", outcome: "succeeded" as const, reasonCode: "user typed free text!" };
    await expect(env.audit.write(e, { risk: "low" })).rejects.toBeInstanceOf(AuditWriteError);
    await expect(t.db.transaction((tx) => env.audit.write(e, { tx, risk: "high" }))).rejects.toBeInstanceOf(AuditWriteError);
    expect(await t.db.select().from(auditEvents)).toHaveLength(0);
    await env.audit.write({ ...e, reasonCode: "valid_code.v1-x" }, { risk: "low" }); // 稳定标识符照常写入
    expect(await t.db.select().from(auditEvents)).toHaveLength(1);
  });
});

describe("授权拒绝落审计", () => {
  it("真实装配下，缺 Capability 的拒绝写一条 authorization_denied（原因码是稳定枚举）", async () => {
    const id = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    const d = await svc.authorizer.authorize(await ctxOf(id), { capability: "audit.read" });
    expect(d.ok).toBe(false);
    const rows = await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "authorization_denied"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied", reasonCode: "capability_not_granted", actor: `user:${id}` });
  });
});

describe("撤权后取消用户触发的任务", () => {
  it("人工停用：提交之后调用已注册的 canceller，参数是 user:<id>", async () => {
    const admin = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const bm = await insertAccessUser(env, { role: "branch_manager", phone: "13000000002", brandIds: [org.hisense], branchIds: [org.bj] });
    const seen: string[] = [];
    svc.egress.registerJobCanceller("test-jobs", async (a) => (seen.push(a), 1));
    await svc.admin.disable(await ctxOf(admin), bm);
    expect(seen).toEqual([`user:${bm}`]);
  });
  it("专员停用触发的自动停用走同一出口", async () => {
    const u = await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    await t.db.update(mediaStaff).set({ status: "inactive" }).where(eq(mediaStaff.staffId, org.staffA));
    const seen: string[] = [];
    svc.egress.registerJobCanceller("test-jobs", async (a) => (seen.push(a), 1));
    expect(await svc.linkage.disableIfStaffInactive(u)).toBe("disabled");
    expect(seen).toEqual([`user:${u}`]);
  });
});

describe("monitoring_level 谓词 fail-closed", () => {
  const ctx = (platformAdmin: boolean) => ({ actor: "user:1", userId: 1n, scope: EMPTY_SCOPE, platformAdmin });
  it("缺 ref / 缺 level / 未知 level 一律不成立；经销商级只有超管；门店与账号级放行", () => {
    for (const ref of [undefined, null, {}, { level: "tenant" }, { level: 1 }]) expect(monitoringLevelPredicate(ctx(false), ref)).toBe(false);
    for (const ref of [undefined, {}, { level: "tenant" }]) expect(monitoringLevelPredicate(ctx(true), ref)).toBe(false); // 超管同样没有旁路
    expect(monitoringLevelPredicate(ctx(false), { level: "dealer" })).toBe(false);
    expect(monitoringLevelPredicate(ctx(true), { level: "dealer" })).toBe(true);
    expect(monitoringLevelPredicate(ctx(false), { level: "store" })).toBe(true);
    expect(monitoringLevelPredicate(ctx(false), { level: "account" })).toBe(true);
  });
});

describe("改名同步认证库", () => {
  it("changeAccess 改 displayName 时 auth_users.name 一起改", async () => {
    const admin = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const bm = await insertAccessUser(env, { role: "branch_manager", phone: "13000000002", name: "旧名", brandIds: [org.hisense], branchIds: [org.bj] });
    await svc.admin.changeAccess(await ctxOf(admin), bm, { displayName: "新名" });
    const [a] = await t.db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, bm));
    expect(a?.name).toBe("新名");
  });
});

describe("两个超管同时互相降级不死锁", () => {
  it("锁顺序统一（先锁全部超管，再锁目标）：12 轮并发互降都不出现死锁；每轮至少一方成功，且始终留有可用超管", async () => {
    const a = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const b = await insertAccessUser(env, { role: "platform_admin", phone: "13000000002" });
    let ok = 0;
    for (let i = 0; i < 12; i++) {
      for (const id of [a, b]) await t.db.update(accessUsers).set({ roleCode: "platform_admin", status: "active" }).where(eq(accessUsers.userId, id));
      const [ca, cb] = [await ctxOf(a), await ctxOf(b)];
      // 这里的并发是被测对象本身（不是造数）：修复前同一用例 12 轮全部死锁
      const res = await Promise.allSettled([
        svc.admin.changeAccess(ca, b, { role: "hq_manager", brandIds: [org.hisense] }),
        svc.admin.changeAccess(cb, a, { role: "hq_manager", brandIds: [org.hisense] }),
      ]);
      for (const r of res) {
        if (r.status === "fulfilled") ok++;
        else expect((r.reason as { code?: string }).code).toMatch(/last_superadmin|actor_not_active|forbidden|user_not_found/);
      }
      const admins = await t.db.select().from(accessUsers).where(eq(accessUsers.roleCode, "platform_admin"));
      expect(admins.length).toBeGreaterThanOrEqual(1);
    }
    expect(ok).toBeGreaterThanOrEqual(12);
  });
});
