// B 域 11 张表的约束与审计触发器（b-access-control 任务 2）。
// 和 schema.db.test.ts 一样：逐条构造违反约束的写入，断言被点名的约束 / 触发器拒绝。
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { expectRejected, useTestDb } from "../../tests/harness/db";
import { runMigrations } from "./client";
import { accessBootstrapTokens, accessLoginFailures, accessSmsSends, accessUserBranches, accessUserBrands, accessUsers, auditEvents, authSessions, authUsers } from "./schema";
import { branches, brands, mediaStaff, regions, stores, dealers, sectors } from "./schema";

const NOW = new Date("2026-11-10T02:00:00.000Z");
const t = useTestDb();

let seq = 0;
async function authUser(phone?: string): Promise<bigint> {
  seq += 1;
  const [r] = await t.db.insert(authUsers).values({ name: "u", email: `u${seq}@hbecho.invalid`, phoneNumber: phone ?? null, createdAt: NOW, updatedAt: NOW });
  return BigInt(r.insertId);
}

async function access(over: Partial<typeof accessUsers.$inferInsert> & { phone: string }): Promise<bigint> {
  const userId = over.userId ?? (await authUser());
  await t.db.insert(accessUsers).values({
    userId,
    roleCode: "branch_manager",
    displayName: "x",
    status: "active",
    createdByActor: "service:test",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  return userId;
}

async function staffRow(phone: string): Promise<bigint> {
  const st = { createdAt: NOW, updatedAt: NOW };
  const [r] = await t.db.insert(regions).values({ regionCode: `R${seq++}`, regionName: "r", status: "active", ...st });
  const [b] = await t.db.insert(branches).values({ regionId: BigInt(r.insertId), branchCode: `B${seq}`, branchName: "b", status: "active", ...st });
  const [s] = await t.db.insert(sectors).values({ branchId: BigInt(b.insertId), sectorCode: `SC${seq}`, sectorName: "s", status: "active", ...st });
  const [br] = await t.db.insert(brands).values({ brandCode: `BR${seq}`, brandName: `品牌${seq}`, status: "active", ...st });
  const [d] = await t.db.insert(dealers).values({ dealerCode: `D${seq}`, dealerName: "d", status: "active", ...st });
  const [store] = await t.db
    .insert(stores)
    .values({ storeCode: `ST${seq}`, storeName: "st", dealerId: BigInt(d.insertId), brandId: BigInt(br.insertId), sectorId: BigInt(s.insertId), status: "active", ...st });
  const [m] = await t.db.insert(mediaStaff).values({ storeId: BigInt(store.insertId), staffName: "m", phone, status: "active", ...st });
  return BigInt(m.insertId);
}

describe("迁移", () => {
  it("可重复执行：再跑一次迁移是空操作", async () => {
    await runMigrations(t.db);
    await runMigrations(t.db);
    const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'access_users'");
    expect(Number((rows as Array<{ n: string }>)[0]!.n)).toBe(1);
  });

  it("认证表 ID 是自增 BIGINT；业务表外键全是 RESTRICT，没有 CASCADE", async () => {
    const [cols] = await t.pool.query(
      "SELECT table_name AS t, column_type AS ty, extra AS ex FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name LIKE 'auth\\_%' AND column_name = 'id'",
    );
    for (const c of cols as Array<{ t: string; ty: string; ex: string }>) {
      expect(c.ty).toBe("bigint");
      expect(c.ex).toContain("auto_increment");
    }
    const [rules] = await t.pool.query(
      "SELECT table_name AS t, delete_rule AS r FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND (table_name LIKE 'access\\_%' OR table_name LIKE 'auth\\_%')",
    );
    expect((rules as Array<{ r: string }>).length).toBeGreaterThan(5);
    expect((rules as Array<{ r: string }>).every((x) => x.r === "RESTRICT" || x.r === "NO ACTION")).toBe(true);
  });
});

describe("access_users", () => {
  it("角色 / 状态只接受设计里的值", async () => {
    await expectRejected(access({ phone: "13800000001", roleCode: "root" }), "ck_access_users_role");
    await expectRejected(access({ phone: "13800000002", status: "frozen" }), "ck_access_users_status");
  });

  it("手机号唯一只约束「待激活 + 有效」：同号第二个有效用户被拒；停用用户不占号，同号可新建", async () => {
    await access({ phone: "13800000001" });
    await expectRejected(access({ phone: "13800000001", status: "pending_activation" }), "uq_access_users_active_phone");
    await access({ phone: "13800000002", status: "disabled", disabledAt: NOW, statusBeforeDisable: "active", disabledReason: "manual", disabledByActor: "user:1" });
    await access({ phone: "13800000002" }); // 停用记录保留原号但不占号
    await access({ phone: "13800000002", status: "disabled", disabledAt: NOW, statusBeforeDisable: "active", disabledReason: "manual", disabledByActor: "user:1" }); // 多个停用也行
  });

  it("停用字段齐备性：status=disabled 当且仅当 disabled_at 与 status_before_disable 都有值（每条只违反一个约束）", async () => {
    await expectRejected(access({ phone: "13800000003", status: "disabled", statusBeforeDisable: "active" }), "ck_access_users_disabled_at");
    await expectRejected(access({ phone: "13800000004", status: "disabled", disabledAt: NOW }), "ck_access_users_before_disable");
    await expectRejected(access({ phone: "13800000005", status: "active", disabledAt: NOW }), "ck_access_users_disabled_at");
    await expectRejected(access({ phone: "13800000006", status: "disabled", disabledAt: NOW, statusBeforeDisable: "disabled" }), "ck_access_users_before_values");
    await expectRejected(
      access({ phone: "13800000007", status: "disabled", disabledAt: NOW, statusBeforeDisable: "active", disabledReason: "whatever" }),
      "ck_access_users_reason",
    );
  });

  it("只有 store_staff 可以绑定专员；非停用用户与专员一对一", async () => {
    const m = await staffRow("13900000001");
    await expectRejected(access({ phone: "13800000008", roleCode: "branch_manager", mediaStaffId: m }), "ck_access_users_staff_role");
    await access({ phone: "13800000009", roleCode: "store_staff", mediaStaffId: m });
    await expectRejected(access({ phone: "13800000010", roleCode: "store_staff", mediaStaffId: m }), "uq_access_users_active_staff");
    // 绑定该专员的用户被停用后，专员可以再绑给新用户（换店 / 重新开户）
    await t.db.execute(sql`UPDATE access_users SET status='disabled', disabled_at=${NOW}, status_before_disable='active', disabled_reason='manual', disabled_by_actor='user:1' WHERE phone='13800000009'`);
    await access({ phone: "13800000010", roleCode: "store_staff", mediaStaffId: m });
  });

  it("授权行必须有对应的认证行；品牌 / 分公司集合的外键是 RESTRICT", async () => {
    await expectRejected(access({ phone: "13800000011", userId: 987654321n }), "fk_access_users_auth");
    const u = await access({ phone: "13800000012" });
    await expectRejected(t.db.insert(accessUserBrands).values({ userId: u, brandId: 424242n }), "fk_access_user_brands_brand");
    await expectRejected(t.db.insert(accessUserBranches).values({ userId: u, branchId: 424242n }), "fk_access_user_branches_branch");
  });
});

describe("认证表", () => {
  it("手机号与邮箱各自唯一；会话必须属于存在的用户", async () => {
    await authUser("13800000001");
    await expectRejected(authUser("13800000001"), "uq_auth_users_phone");
    await authUser(); // phone 为空不冲突
    await authUser();
    await expectRejected(
      t.db.insert(authSessions).values({ expiresAt: NOW, token: "tok", createdAt: NOW, updatedAt: NOW, userId: 555n }),
      "fk_auth_sessions_user",
    );
  });
});

describe("其余表", () => {
  it("短信记录的 purpose / outcome 受 CHECK 约束", async () => {
    await expectRejected(t.db.insert(accessSmsSends).values({ phoneNorm: "13800000001", purpose: "spam", requestedAt: NOW, outcome: "sent" }), "ck_access_sms_purpose");
    await expectRejected(t.db.insert(accessSmsSends).values({ phoneNorm: "13800000001", purpose: "login", requestedAt: NOW, outcome: "ok" }), "ck_access_sms_outcome");
  });

  it("登录失败计数不能为负；令牌 sha 唯一；consumed_at 与 consumed_user_id 同有同无", async () => {
    await expectRejected(t.db.insert(accessLoginFailures).values({ phoneNorm: "13800000001", failCount: -1, updatedAt: NOW }), "ck_access_login_failures_count");
    const row = { tokenSha256: Buffer.alloc(32, 7), createdByActor: "service:ops", createdAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000) };
    await t.db.insert(accessBootstrapTokens).values(row);
    await expectRejected(t.db.insert(accessBootstrapTokens).values(row), "uq_access_bootstrap_token");
    await expectRejected(
      t.db.insert(accessBootstrapTokens).values({ ...row, tokenSha256: Buffer.alloc(32, 8), consumedAt: NOW }),
      "ck_access_bootstrap_consumed",
    );
  });
});

describe("audit_events 追加写（触发器）", () => {
  const ev = (over: Partial<typeof auditEvents.$inferInsert> = {}) => ({
    occurredAt: new Date(),
    actor: "user:1",
    eventType: "x",
    outcome: "succeeded",
    reasonCode: "x",
    ...over,
  });

  it("UPDATE 一律被拒", async () => {
    await t.db.insert(auditEvents).values(ev());
    await expectRejected(t.db.execute(sql`UPDATE audit_events SET reason_code = 'tampered'`), "append-only");
  });

  it("未满 365 天的行不能 DELETE；满 365 天的可以（到期清理）", async () => {
    const day = 86_400_000;
    await t.db.insert(auditEvents).values(ev({ occurredAt: new Date(Date.now() - 364 * day), reasonCode: "young" }));
    await t.db.insert(auditEvents).values(ev({ occurredAt: new Date(Date.now() - 366 * day), reasonCode: "old" }));
    await expectRejected(t.db.execute(sql`DELETE FROM audit_events WHERE reason_code = 'young'`), "append-only");
    await expectRejected(t.db.execute(sql`DELETE FROM audit_events`), "append-only"); // 混合：只要含有年轻的行，整条语句失败
    await t.db.execute(sql`DELETE FROM audit_events WHERE reason_code = 'old'`);
    const [rows] = await t.pool.query("SELECT reason_code AS r FROM audit_events");
    expect((rows as Array<{ r: string }>).map((x) => x.r)).toEqual(["young"]);
  });

  it("outcome 受 CHECK 约束；幂等键唯一", async () => {
    await expectRejected(t.db.insert(auditEvents).values(ev({ outcome: "maybe" })), "ck_audit_events_outcome");
    const key = Buffer.alloc(32, 1);
    await t.db.insert(auditEvents).values(ev({ idempotencyKey: key }));
    await expectRejected(t.db.insert(auditEvents).values(ev({ idempotencyKey: key })), "uq_audit_events_idem");
  });
});
