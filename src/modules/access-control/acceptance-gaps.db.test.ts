// 验收补缺（任务 12）：独立审计把 acceptance.md 逐行对照测试后发现的缺口，在这里补齐。
// 每个用例标注对应的验收行号；一行对应多个断言的，只补缺的那部分。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { accessUsers, authSessions, authUsers, authVerifications } from "../../db/schema";
import { createMemoryAuditWriter } from "./audit";
import { createAuditReader } from "./audit-read";
import { createContextResolver } from "./authenticate";
import { createAuthorizer, type AuthContext } from "./authorize";
import { OTP_EXPIRES_IN_SECONDS, SESSION_EXPIRES_IN_SECONDS, SESSION_UPDATE_AGE_SECONDS } from "./auth-instance";
import { AccessError } from "./errors";
import { createRegistry, createOrgDirectory, createStoreStrategy, monitoringLevelPredicate } from "./scope";
import { createUserAdmin, type UserAdmin } from "./users/admin";
import { createUserImport, USER_IMPORT_HEADER, type UserImport } from "./users/import";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let resolveCtx: (id: bigint) => Promise<AuthContext>;
let admin: UserAdmin;
let imp: UserImport;

beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  const dir = createOrgDirectory(t.db);
  const r = createContextResolver({ db: t.db, dir, linkage: accessLinkage(env, { dir }) });
  resolveCtx = async (id) => {
    const x = await r.contextForUser(id, null);
    if (!x.ok) throw new Error(x.reason);
    return x.ctx;
  };
  admin = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir, authorizer: createAuthorizer() });
  imp = createUserImport({ db: t.db, clock: env.clock, audit: env.audit, admin });
});

const DAY = 86_400_000;
const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(Error);
  return e instanceof AccessError ? e.code : (e as Error).name;
};
const csv = (rows: string[][]) => new TextEncoder().encode([USER_IMPORT_HEADER.join(","), ...rows.map((x) => x.join(","))].join("\r\n") + "\r\n");

describe("A1–A3、A12：生产配置下的会话有效期与滑动续期", () => {
  const session = async (userId: bigint) => (await t.db.select().from(authSessions).where(eq(authSessions.userId, userId)))[0]!;
  const near = (d: Date, target: number, tolMs = 60_000) => Math.abs(d.getTime() - target) < tolMs;

  it("常量就是 PRD 的 15 天 / 24 小时 / 5 分钟", () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(15 * 24 * 3600);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(24 * 3600);
    expect(OTP_EXPIRES_IN_SECONDS).toBe(300);
  });

  it("登录后到期日 = 登录时间 + 15 天；24 小时内再次认证不写库；满 24 小时后首次请求刷新到当时 + 15 天；15 天不登录则到期", async () => {
    const id = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    const headers = await loginAs(env, "13000000002");
    const s0 = await session(id);
    expect(near(s0.expiresAt, Date.now() + 15 * DAY)).toBe(true); // A1

    await env.auth.api.getSession({ headers }); // A2 前半：24 小时内
    expect((await session(id)).expiresAt.getTime()).toBe(s0.expiresAt.getTime());

    // 模拟「25 小时前签发 / 刷新」：到期日 = 现在 + 15 天 - 25 小时
    await t.db.update(authSessions).set({ expiresAt: new Date(Date.now() + 15 * DAY - 25 * 3600_000) }).where(eq(authSessions.userId, id));
    expect(await env.auth.api.getSession({ headers })).not.toBeNull();
    expect(near((await session(id)).expiresAt, Date.now() + 15 * DAY)).toBe(true); // A2 后半

    await t.db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.userId, id)); // A3
    expect(await env.auth.api.getSession({ headers })).toBeNull();
  });

  it("A12：同一用户 3 个并发会话都有效；持续活跃（每天一次）100 天仍可续期，没有绝对有效期", async () => {
    const id = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    const hs = [await loginAs(env, "13000000002"), await loginAs(env, "13000000002"), await loginAs(env, "13000000002")];
    for (const h of hs) expect(await env.auth.api.getSession({ headers: h })).not.toBeNull();
    expect(await t.db.select().from(authSessions).where(eq(authSessions.userId, id))).toHaveLength(3);
    for (let day = 0; day < 100; day++) {
      await t.db.update(authSessions).set({ expiresAt: new Date(Date.now() + 15 * DAY - 25 * 3600_000) }).where(eq(authSessions.userId, id));
      expect(await env.auth.api.getSession({ headers: hs[0]! })).not.toBeNull();
    }
    expect(near((await session(id)).expiresAt, Date.now() + 15 * DAY)).toBe(true);
  });
});

describe("C10：验证码有效期 = 300 秒", () => {
  it("请求验证码后，verification 的到期时间 = 创建时间 + 300 秒（4:59 有效、5:01 无效由库的过期判断保证，见 spike）", async () => {
    await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
    await env.auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13000000003" } });
    const [v] = await t.db.select().from(authVerifications);
    expect(v).toBeTruthy();
    expect(Math.abs(v!.expiresAt.getTime() - v!.createdAt.getTime() - OTP_EXPIRES_IN_SECONDS * 1000)).toBeLessThan(5000);
  });
});

describe("G10、J8：授权变更 / 恢复 / 导入确认的审计失败 → 业务整体回滚", () => {
  it("changeAccess：审计写入失败 → 姓名与授权都不变", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", name: "原名", brandIds: [org.hisense], branchIds: [org.bj] });
    const failing = createMemoryAuditWriter();
    const a2 = createUserAdmin({ db: t.db, clock: env.clock, audit: failing, dir: createOrgDirectory(t.db), authorizer: createAuthorizer() });
    failing.failNext();
    expect(await code(a2.changeAccess(await resolveCtx(actor), target, { displayName: "新名", role: "hq_manager", brandIds: [org.hisense] }))).toBe("AuditWriteError");
    const [u] = await t.db.select().from(accessUsers).where(eq(accessUsers.userId, target));
    expect(u).toMatchObject({ displayName: "原名", roleCode: "branch_manager" });
    expect((await admin.get(await resolveCtx(actor), target)).branchIds).toEqual([String(org.bj)]); // 分公司集合没被清掉
  });

  it("restore：审计写入失败 → 用户仍是停用，认证表仍是墓碑", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj], status: "disabled" });
    const failing = createMemoryAuditWriter();
    const a2 = createUserAdmin({ db: t.db, clock: env.clock, audit: failing, dir: createOrgDirectory(t.db), authorizer: createAuthorizer() });
    failing.failNext();
    expect(await code(a2.restore(await resolveCtx(actor), target))).toBe("AuditWriteError");
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, target)))[0]!.status).toBe("disabled");
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, target)))[0]!.phoneNumber).toBe(`disabled:${target}`);
  });

  it("导入确认：某一行的审计写入失败 → 该行不留用户（行事务回滚），批次停在 writing 可续跑", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const ctx = await resolveCtx(actor);
    const failing = createMemoryAuditWriter();
    const a2 = createUserAdmin({ db: t.db, clock: env.clock, audit: failing, dir: createOrgDirectory(t.db), authorizer: createAuthorizer() });
    const imp2 = createUserImport({ db: t.db, clock: env.clock, audit: failing, admin: a2 });
    const v = await imp2.precheck(ctx, { name: "x.csv", bytes: csv([["甲", "总部人员", "13911110001", "HISENSE", "", ""]]) });
    failing.failNext();
    expect(await code(imp2.confirm(ctx, BigInt(v.batchId)))).toBe("AuditWriteError");
    expect(await t.db.select().from(accessUsers).where(eq(accessUsers.phone, "13911110001"))).toHaveLength(0);
    expect(await t.db.select().from(authUsers).where(eq(authUsers.phoneNumber, "13911110001"))).toHaveLength(0);
  });
});

describe("D6：墓碑改写失败 → 整个停用事务回滚，用户仍有效", () => {
  it("在认证表上装一个拒绝墓碑值的触发器模拟失败", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
    await loginAs(env, "13000000003");
    await t.pool.query(
      "CREATE TRIGGER trg_test_block_tombstone BEFORE UPDATE ON auth_users FOR EACH ROW BEGIN IF NEW.phone_number LIKE 'disabled:%' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'blocked'; END IF; END",
    );
    try {
      await expect(admin.disable(await resolveCtx(actor), target)).rejects.toThrow();
    } finally {
      await t.pool.query("DROP TRIGGER IF EXISTS trg_test_block_tombstone");
    }
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, target)))[0]!.status).toBe("active");
    expect((await t.db.select().from(authUsers).where(eq(authUsers.id, target)))[0]!.phoneNumber).toBe("13000000003");
    expect(await t.db.select().from(authSessions).where(eq(authSessions.userId, target))).toHaveLength(1); // 会话也还在
  });
});

describe("D7：登录手机号不变式", () => {
  it("一轮状态流转之后：非停用用户的认证表手机号 = 授权表手机号；停用用户的 = 墓碑值", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const ctx = await resolveCtx(actor);
    const a = await admin.invite(ctx, { name: "甲", phone: "13911110001", role: "hq_manager", brandIds: [org.hisense] });
    const b = await admin.invite(ctx, { name: "乙", phone: "13911110002", role: "hq_manager", brandIds: [org.hisense] });
    const c = await admin.invite(ctx, { name: "丙", phone: "13911110003", role: "hq_manager", brandIds: [org.hisense] });
    await admin.disable(ctx, BigInt(a.userId));
    await admin.disable(ctx, BigInt(b.userId));
    await admin.restore(ctx, BigInt(b.userId));
    await admin.changeAccess(ctx, BigInt(c.userId), { phone: "13911110004" });
    await admin.invite(ctx, { name: "甲二", phone: "13911110001", role: "hq_manager", brandIds: [org.hisense] }); // 停用不占号
    const rows = await t.db.select({ id: accessUsers.userId, phone: accessUsers.phone, status: accessUsers.status, login: authUsers.phoneNumber }).from(accessUsers).innerJoin(authUsers, eq(authUsers.id, accessUsers.userId));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) expect(r.login, `用户 ${r.id} 状态 ${r.status}`).toBe(r.status === "disabled" ? `disabled:${r.id}` : r.phone);
  });
});

describe("E18：没有 user.manage 的人，所有管理 / 导入 / 审计函数都被拒", () => {
  it("门店专员逐个调用", async () => {
    const staff = await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
    const ctx = await resolveCtx(staff);
    const reader = createAuditReader({ db: t.db, authorizer: createAuthorizer() });
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["invite", () => admin.invite(ctx, { name: "x", phone: "13911110009", role: "store_staff", storeCode: "S-A" })],
      ["previewInvite", () => admin.previewInvite(ctx, { name: "x", phone: "13911110009", role: "store_staff", storeCode: "S-A" })],
      ["get", () => admin.get(ctx, target)],
      ["list", () => admin.list(ctx)],
      ["changeAccess", () => admin.changeAccess(ctx, target, { displayName: "x" })],
      ["disable", () => admin.disable(ctx, target)],
      ["restore", () => admin.restore(ctx, target)],
      ["forceLogout", () => admin.forceLogout(ctx, target)],
      ["import.precheck", () => imp.precheck(ctx, { name: "x.csv", bytes: csv([["甲", "总部人员", "13911110001", "HISENSE", "", ""]]) })],
      ["import.get", () => imp.get(ctx, 1n)],
      ["import.list", () => imp.list(ctx)],
      ["import.confirm", () => imp.confirm(ctx, 1n)],
      ["import.returnFile", () => imp.returnFile(ctx, 1n)],
      ["audit.read", () => reader.read(ctx)],
    ];
    for (const [name, call] of calls) expect(await code(call()), name).toBe("forbidden");
  });
});

describe("B1、L2、D15、L7、H5", () => {
  it("B1：迁移后没有任何默认账号（认证 / 授权 / 凭据表都是空的），迁移 SQL 里也没有对它们的 INSERT", async () => {
    // seedAccessOrg 之外没有造过用户；useTestDb 每个用例前清空
    for (const tbl of ["auth_users", "auth_accounts", "access_users"]) {
      const [rows] = (await t.pool.query(`SELECT COUNT(*) AS n FROM ${tbl}`)) as unknown as [Array<{ n: string }>];
      expect(Number(rows[0]!.n), tbl).toBe(0);
    }
    const dir = new URL("../../../drizzle/", import.meta.url);
    const bad = readdirSync(dir).filter((f) => f.endsWith(".sql") && /INSERT\s+INTO\s+`?(auth_users|auth_accounts|access_users)`?/i.test(readFileSync(new URL(f, dir), "utf8")));
    expect(bad).toEqual([]);
  });

  it("L2：同一份输入连续预检 3 次，分类结果一致", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const ctx = await resolveCtx(actor);
    const bytes = csv([["甲", "总部人员", "13911110001", "HISENSE", "", ""], ["乙", "老板", "13911110002", "HISENSE", "", ""], ["丙", "经销商人员", "13800000001", "", "", "S-A"]]);
    const shapes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const v = await imp.precheck(ctx, { name: "x.csv", bytes });
      shapes.push(JSON.stringify(v.rows.map((r) => [r.rowNo, r.precheckClass, r.reasonCode])));
    }
    expect(new Set(shapes).size).toBe(1);
  });

  it("D15：换门店 = 删旧建新：旧用户停用，新用户同号待激活、绑定新专员，两者没有关联字段", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const ctx = await resolveCtx(actor);
    const old = await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    await admin.disable(ctx, old);
    // 主数据侧：该专员在 A 店离职（停用），同一手机号在 B 店重新登记为新专员
    await t.pool.query("UPDATE media_staff SET status = 'inactive' WHERE staff_id = ?", [org.staffA]);
    await t.pool.query("INSERT INTO media_staff (store_id, staff_name, phone, status, created_at, updated_at) VALUES (?, '专员甲(B店)', '13800000001', 'active', NOW(6), NOW(6))", [org.storeB]);
    const created = await admin.invite(ctx, { name: "专员甲", phone: "13800000001", role: "store_staff", storeCode: "S-B" });
    const [o] = await t.db.select().from(accessUsers).where(eq(accessUsers.userId, old));
    const [n] = await t.db.select().from(accessUsers).where(eq(accessUsers.userId, BigInt(created.userId)));
    expect(o!.status).toBe("disabled");
    expect(n).toMatchObject({ status: "pending_activation", phone: "13800000001" });
    expect(n!.mediaStaffId).not.toBe(o!.mediaStaffId);
    expect(Object.keys(n!).filter((k) => /replac|previous|predecessor|old_/i.test(k))).toEqual([]); // 没有指向旧用户的字段
  });

  it("L7：两个并发创建同一手机号，恰好一个成功，另一个稳定得到 phone_exists（1062 被映射）", async () => {
    const actor = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const ctx = await resolveCtx(actor);
    const mk = () => admin.invite(ctx, { name: "甲", phone: "13911110001", role: "hq_manager", brandIds: [org.hisense] });
    const r = await Promise.allSettled([mk(), mk()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rej = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect((rej.reason as AccessError).code).toBe("phone_exists");
    expect(await t.db.select().from(accessUsers).where(eq(accessUsers.phone, "13911110001"))).toHaveLength(1);
  });

  it("H5：总部导入含超出自己品牌的分公司人员行 → scope_exceeds_boundary", async () => {
    const hq = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    const v = await imp.precheck(await resolveCtx(hq), { name: "x.csv", bytes: csv([["甲", "分公司人员", "13911110001", "HITACHI", "BR-BJ", ""], ["乙", "分公司人员", "13911110002", "HISENSE", "BR-BJ", ""]]) });
    expect(v.rows.map((r) => r.reasonCode)).toEqual(["scope_exceeds_boundary", null]);
    expect(v).toMatchObject({ skippedRows: 1, newRows: 1 });
  });
});

describe("E8、E9：资源谓词", () => {
  it("monitoring_level：经销商级只有超管通过；门店级 / 账号级总部也通过", async () => {
    const dir = createOrgDirectory(t.db);
    const registry = createRegistry();
    registry.registerScopeStrategy("account", createStoreStrategy(dir) as never);
    registry.registerPredicate("monitoring_level", monitoringLevelPredicate);
    const authz = createAuthorizer({ registry });
    const hq = await resolveCtx(await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] }));
    const admin1 = await resolveCtx(await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" }));
    const bm = await resolveCtx(await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] }));
    const dealer = { capability: "data.monitoring.manage", resource: { key: "account", ref: { storeId: org.storeA, level: "dealer" }, predicates: ["monitoring_level"] } };
    const store = { capability: "data.monitoring.manage", resource: { key: "account", ref: { storeId: org.storeA, level: "store" }, predicates: ["monitoring_level"] } };
    expect(await authz.authorize(admin1, dealer)).toEqual({ ok: true });
    expect(await authz.authorize(hq, dealer)).toMatchObject({ ok: false, reason: "predicate_failed" });
    expect(await authz.authorize(bm, dealer)).toMatchObject({ ok: false });
    expect(await authz.authorize(hq, store)).toEqual({ ok: true });
  });
});

describe("I14：看手机号 / 页面查询不产生逐条审计（负向断言以审计总数不变为准）", () => {
  it("连续 20 次出口 1 查询，audit_events 总数不增", async () => {
    const { createEgress } = await import("./egress");
    const dir = createOrgDirectory(t.db);
    const registry = createRegistry();
    registry.registerScopeStrategy("account", createStoreStrategy(dir) as never);
    const egress = createEgress({ authorizer: createAuthorizer({ registry }), audit: env.audit });
    const ctx = await resolveCtx(await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] }));
    const count = async () => Number((((await t.db.execute(sql`SELECT COUNT(*) AS n FROM audit_events`)) as unknown as [Array<{ n: string }>])[0][0]!).n);
    const before = await count();
    for (let i = 0; i < 20; i++) await egress.guardExit(1, ctx, { capability: "data.account.read", resource: { key: "account", ref: { storeId: org.storeA } } });
    expect(await count()).toBe(before);
  });
});

describe("静态护栏（J6、J11、K15、A11、H16、L10）", () => {
  const SRC = new URL("../../", import.meta.url).pathname;
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
  const all = walk(SRC).filter((f) => f.endsWith(".ts"));
  const isTest = (f: string) => /\.test\.ts$/.test(f) || f.includes("__spike__");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const prod = all.filter((f) => !isTest(f));

  it("J6：审计表只有「到期批量清理」一处删除，没有按 ID 删除的函数，CLI 没有删除命令", () => {
    const deleters = prod.filter((f) => /delete\(\s*auditEvents\s*\)|DELETE\s+FROM\s+audit_events/i.test(strip(readFileSync(f, "utf8")))).map((f) => f.slice(SRC.length));
    expect(deleters).toEqual(["modules/access-control/audit.ts"]);
    const cli = strip(readFileSync(join(SRC, "worker/access-cli.ts"), "utf8"));
    expect(cli).not.toMatch(/audit\s+(delete|purge|remove)|case\s+"(delete|purge)"/i);
  });

  it("J11：写进审计的 reasonCode 不来自自由文本：代码里没有用异常信息、字符串拼接或用户输入给它赋值", () => {
    const bad: string[] = [];
    for (const f of prod.filter((x) => x.includes("/access-control/") || x.includes("/worker/access-"))) {
      for (const m of strip(readFileSync(f, "utf8")).matchAll(/reasonCode:\s*([^,}\n]+)/g)) {
        const expr = m[1]!.trim();
        if (/^string\b/.test(expr)) continue; // 类型声明
        if (/\.message|String\(|\+\s*\w|\bnew Error|\berr\b|\bdetail\b|\binput\b\./.test(expr)) bad.push(`${f.slice(SRC.length)}: ${expr}`);
      }
    }
    expect(bad).toEqual([]);
    // 数据库里实际落的也都是稳定标识符
    // （运行期断言见 audit.db.test 的综合场景：reasonCode 都匹配 /^[a-z0-9_.]+$/）
  });

  it("K15：src/app 的路由只有 auth、health 与学习域的两个（进度上报、资料预览）", () => {
    const routes = all.filter((f) => f.startsWith(join(SRC, "app")) && /route\.ts$/.test(f)).map((f) => f.slice(join(SRC, "app").length + 1)).sort();
    // 学习域两个 Route Handler（g-learning-min 任务 6、7）：一个因 sendBeacon 不能走 server action，一个要流式内联返回文件；
    // 都是「认证 → 授权 → 转交 Module」的薄入口，授权与范围判断在 modules/learning
    expect(routes).toEqual(["api/auth/[...all]/route.ts", "api/health/route.ts", "api/learning/courses/[id]/preview/route.ts", "api/learning/progress/route.ts"]);
  });

  it("A11、H16：CLI 没有设置 / 返回密码的命令，也没有「一键改成新增」", () => {
    const cli = strip(readFileSync(join(SRC, "worker/access-cli.ts"), "utf8"));
    expect(cli).not.toMatch(/password|set-password|passwd/i);
    expect(cli).not.toMatch(/--(force|update|overwrite|upsert|as-new|convert)/i);
    const imp = strip(readFileSync(join(SRC, "modules/access-control/users/import.ts"), "utf8"));
    expect(imp).not.toMatch(/overwrite|upsert|convertToNew|asNew/i);
  });

  it("L10：测试从不构造真实的短信 SDK 客户端（不 import @alicloud/*；AliyunSmsSender 只用注入的假客户端）", () => {
    const offenders = all.filter((f) => isTest(f) && /from\s+["']@alicloud\//.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});
