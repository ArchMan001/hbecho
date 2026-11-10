// S5 会话：15 天 / 每日至多刷新一次 / 无 cookie 缓存 / 删行即撤销；S6 墓碑手机号。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { createPool } from "../../../db/client";
import { cookieOf, createSpikeAuth, resetAuthTables, seedUser, type SentSms } from "./spike-auth";

let pool: Pool;
beforeAll(async () => {
  pool = createPool(process.env.HBECHO_TEST_DATABASE_URL!);
  await resetAuthTables(pool);
});
beforeEach(async () => {
  await resetAuthTables(pool);
});
afterAll(async () => {
  await resetAuthTables(pool);
  await pool.end();
});

const PHONE = "13800000001";
const DAY = 24 * 3600 * 1000;

async function sessionRow(): Promise<{ expires: number; updated: number } | undefined> {
  const [rows] = await pool.query(
    "SELECT UNIX_TIMESTAMP(expires_at) * 1000 AS expires, UNIX_TIMESTAMP(updated_at) * 1000 AS updated FROM auth_sessions ORDER BY id DESC LIMIT 1",
  );
  const r = (rows as Array<{ expires: string; updated: string }>)[0];
  return r ? { expires: Number(r.expires), updated: Number(r.updated) } : undefined;
}

async function login(auth: ReturnType<typeof createSpikeAuth>["auth"], phone = PHONE, password = "Passw0rd!x") {
  const res = await auth.api.signInPhoneNumber({ body: { phoneNumber: phone, password }, asResponse: true });
  return new Headers({ cookie: cookieOf(res) });
}

describe("S5：会话", () => {
  it("新会话有效期 15 天", async () => {
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await login(auth);
    const row = (await sessionRow())!;
    const left = row.expires - Date.now();
    expect(left).toBeGreaterThan(15 * DAY - 60_000);
    expect(left).toBeLessThanOrEqual(15 * DAY + 1000);
  });

  it("同一天内重复读会话不写库；超过 1 天后第一次读刷新到 15 天，随后再读不再写", async () => {
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const headers = await login(auth);
    const first = (await sessionRow())!;

    await auth.api.getSession({ headers });
    await auth.api.getSession({ headers });
    const sameDay = (await sessionRow())!;
    expect(sameDay).toEqual(first); // 没有写入

    // 把会话改成「2 天前最后刷新」：expires 少 2 天，updated 早 2 天
    await pool.query(
      "UPDATE auth_sessions SET expires_at = DATE_SUB(expires_at, INTERVAL 2 DAY), updated_at = DATE_SUB(updated_at, INTERVAL 2 DAY)",
    );
    const aged = (await sessionRow())!;
    expect(aged.expires).toBeLessThan(first.expires - DAY);

    const s = await auth.api.getSession({ headers });
    expect(s).not.toBeNull();
    const refreshed = (await sessionRow())!;
    expect(refreshed.expires - Date.now()).toBeGreaterThan(15 * DAY - 60_000); // 刷新回 15 天

    await auth.api.getSession({ headers });
    await auth.api.getSession({ headers });
    expect(await sessionRow()).toEqual(refreshed); // 当天不再写
  });

  it("过期会话读不到", async () => {
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const headers = await login(auth);
    await pool.query("UPDATE auth_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)");
    expect(await auth.api.getSession({ headers })).toBeNull();
  });

  it("cookieCache 关闭：删除会话行后，持有旧 cookie 的下一次请求立即失效", async () => {
    const { auth } = createSpikeAuth(pool, { session: { cookieCache: false } });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const headers = await login(auth);
    expect(await auth.api.getSession({ headers })).not.toBeNull();
    await pool.query("DELETE FROM auth_sessions");
    expect(await auth.api.getSession({ headers })).toBeNull();
  });

  it("api.getSession 在 Route Handler 之外用 headers 调用即可（授权入口的前提）", async () => {
    const { auth } = createSpikeAuth(pool);
    const u = await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const headers = await login(auth);
    const s = await auth.api.getSession({ headers });
    expect(s?.user.id).toBe(u.id);
    expect(s?.user.phoneNumber).toBe(PHONE);
  });
});

describe("S6：墓碑手机号", () => {
  async function tombstone(userId: string) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE auth_users SET phone_number = ?, phone_number_verified = 0 WHERE id = ?", [`disabled:${userId}`, userId]);
      await conn.query("DELETE FROM auth_sessions WHERE user_id = ?", [userId]);
      await conn.commit();
    } finally {
      conn.release();
    }
  }

  it("停用后：旧用户无法用原号登录；原号码的新用户可建、可登录且是另一个 ID", async () => {
    const { auth } = createSpikeAuth(pool);
    const old = await seedUser(auth, { phone: PHONE, password: "OldPassw0rd!" });
    const oldHeaders = await login(auth, PHONE, "OldPassw0rd!");
    await tombstone(old.id);

    // 旧会话已撤销
    expect(await auth.api.getSession({ headers: oldHeaders })).toBeNull();
    // 旧密码 + 原号：找不到用户
    await expect(auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "OldPassw0rd!" } })).rejects.toThrow();
    // 旧密码 + 墓碑值：被格式校验器在入口拒绝，不可能走到库的用户查找
    await expect(
      auth.api.signInPhoneNumber({ body: { phoneNumber: `disabled:${old.id}`, password: "OldPassw0rd!" } }),
    ).rejects.toMatchObject({ body: { code: "INVALID_PHONE_NUMBER" } });

    // 同一手机号新建用户（唯一键已让位）
    const fresh = await seedUser(auth, { phone: PHONE, password: "NewPassw0rd!" });
    expect(fresh.id).not.toBe(old.id);
    const res = await auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "NewPassw0rd!" } });
    expect(res.user.id).toBe(fresh.id);
    // 旧密码在新用户身上无效
    await expect(auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "OldPassw0rd!" } })).rejects.toThrow();
  });

  it("合成邮箱若由手机号推导，停用后同号新建用户会撞邮箱唯一键 —— 所以邮箱必须随机", async () => {
    const { auth } = createSpikeAuth(pool);
    const derived = `${PHONE}@hbecho.invalid`;
    const old = await seedUser(auth, { phone: PHONE, email: derived });
    await tombstone(old.id);
    await expect(seedUser(auth, { phone: PHONE, email: derived })).rejects.toThrow();
    await expect(seedUser(auth, { phone: PHONE })).resolves.toBeDefined(); // 随机邮箱不冲突
  });

  it("停用用户的验证码流程：原号码的验证码只会命中新用户，不会命中停用用户", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    const old = await seedUser(auth, { phone: PHONE, password: "OldPassw0rd!" });
    await tombstone(old.id);
    const fresh = await seedUser(auth, { phone: PHONE, password: "NewPassw0rd!" });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: PHONE } });
    const res = await auth.api.verifyPhoneNumber({ body: { phoneNumber: PHONE, code: sent[0]!.code } });
    expect(res?.user?.id).toBe(fresh.id);
  });

  it("库不对数据库列做格式校验：直接 SQL 与 internalAdapter.updateUser 都能写入墓碑值", async () => {
    const { auth } = createSpikeAuth(pool);
    const u = await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateUser(u.id, { phoneNumber: `disabled:${u.id}`, phoneNumberVerified: false } as never);
    const [rows] = await pool.query("SELECT phone_number AS p FROM auth_users WHERE id = ?", [u.id]);
    expect((rows as Array<{ p: string }>)[0]!.p).toBe(`disabled:${u.id}`);
  });

  it("恢复：原号码已被另一个有效用户占用时，写回被唯一键拒绝（1062）；未占用时可写回", async () => {
    const { auth } = createSpikeAuth(pool);
    const old = await seedUser(auth, { phone: PHONE, password: "OldPassw0rd!" });
    await tombstone(old.id);
    const fresh = await seedUser(auth, { phone: PHONE, password: "NewPassw0rd!" });
    await expect(pool.query("UPDATE auth_users SET phone_number = ? WHERE id = ?", [PHONE, old.id])).rejects.toMatchObject({ errno: 1062 });
    // 新用户也被停用后，旧用户可恢复
    await tombstone(fresh.id);
    await pool.query("UPDATE auth_users SET phone_number = ? WHERE id = ?", [PHONE, old.id]);
    const res = await auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "OldPassw0rd!" } });
    expect(res.user.id).toBe(old.id);
  });
});
