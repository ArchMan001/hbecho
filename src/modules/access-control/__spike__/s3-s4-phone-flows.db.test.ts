// S3 手机号插件的端点与可配置项；S4 在钩子上插入我们的逻辑（锁定、发送资格、激活后置 active）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { APIError, createAuthMiddleware } from "better-auth/api";
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

async function verificationRows(): Promise<Array<{ identifier: string; value: string }>> {
  const [rows] = await pool.query("SELECT identifier, value FROM auth_verifications ORDER BY id");
  return rows as Array<{ identifier: string; value: string }>;
}

describe("S3：手机号插件", () => {
  it("send-otp：sendOTP 回调拿到明文码；库不查用户是否存在（对任何号码都写一行并回调）", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13999999999" } }); // 库里没有这个用户
    expect(sent).toHaveLength(1);
    expect(sent[0]!.code).toMatch(/^\d{6}$/);
    const rows = await verificationRows();
    expect(rows).toHaveLength(1);
    // 验证码以「明文:已输错次数」存进 verification，没有哈希选项（ADR-0015 记录）
    expect(rows[0]!.value).toBe(`${sent[0]!.code}:0`);
  });

  it("verify：已存在用户用验证码直接得到会话；不存在的用户 verify 失败", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: PHONE } });
    const res = await auth.api.verifyPhoneNumber({ body: { phoneNumber: PHONE, code: sent[0]!.code }, asResponse: true });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toContain("session_token"); // 验证码登录

    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13999999999" } });
    await expect(
      auth.api.verifyPhoneNumber({ body: { phoneNumber: "13999999999", code: sent[1]!.code } }),
    ).rejects.toThrow();
  });

  it("verify 带 updatePhoneNumber：已登录用户可凭新号码的验证码改号 —— 必须由前置钩子拒绝（删旧建新）", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const login = await auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "Passw0rd!x" }, asResponse: true });
    const headers = new Headers({ cookie: cookieOf(login) });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13800000002" } });
    const res = await auth.api.verifyPhoneNumber({
      body: { phoneNumber: "13800000002", code: sent[0]!.code, updatePhoneNumber: true },
      headers,
      asResponse: true,
    });
    expect(res.status).toBe(200); // 库默认放行
    const [rows] = await pool.query("SELECT phone_number AS p FROM auth_users");
    expect((rows as Array<{ p: string }>)[0]!.p).toBe("13800000002"); // 号码真的被改了
  });

  it("验证码重置密码：无凭据的用户（待激活）自动建凭据，随后可密码登录", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await seedUser(auth, { phone: PHONE }); // 没有 credential account
    await expect(
      auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "Passw0rd!x" } }),
    ).rejects.toThrow();
    await auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber: PHONE } });
    expect(sent[0]!.kind).toBe("reset");
    await auth.api.resetPasswordPhoneNumber({ body: { phoneNumber: PHONE, otp: sent[0]!.code, newPassword: "NewPassw0rd!" } });
    const res = await auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "NewPassw0rd!" }, asResponse: true });
    expect(res.status).toBe(200);
  });

  it("重置密码撤销该用户全部会话（revokeSessionsOnPasswordReset），在同一事务里", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "Passw0rd!x" } });
    await auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "Passw0rd!x" } });
    const [before] = await pool.query("SELECT COUNT(*) AS n FROM auth_sessions");
    expect(Number((before as Array<{ n: number }>)[0]!.n)).toBe(2);
    await auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber: PHONE } });
    await auth.api.resetPasswordPhoneNumber({ body: { phoneNumber: PHONE, otp: sent[0]!.code, newPassword: "NewPassw0rd!" } });
    const [after] = await pool.query("SELECT COUNT(*) AS n FROM auth_sessions");
    expect(Number((after as Array<{ n: number }>)[0]!.n)).toBe(0);
  });

  it("request-password-reset 对不存在的号码也写一行 verification，但不回调发送（响应不暴露存在性）", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    const r = await auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber: "13999999999" } });
    expect(r.status).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await verificationRows()).toHaveLength(1);
  });

  it("allowedAttempts=5：输错 5 次后，正确的码也作废（PRD：输错 5 次作废）", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent, allowedAttempts: 5 });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: PHONE } });
    const good = sent[0]!.code;
    const bad = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(auth.api.verifyPhoneNumber({ body: { phoneNumber: PHONE, code: bad } })).rejects.toThrow();
    }
    await expect(auth.api.verifyPhoneNumber({ body: { phoneNumber: PHONE, code: good } })).rejects.toThrow();
    expect(await verificationRows()).toHaveLength(0); // 已删除
  });

  it("otpLength 与 expiresIn 可配置；过期的码被拒", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: PHONE } });
    expect(sent[0]!.code).toHaveLength(6);
    await pool.query("UPDATE auth_verifications SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)");
    await expect(auth.api.verifyPhoneNumber({ body: { phoneNumber: PHONE, code: sent[0]!.code } })).rejects.toThrow();
    // 过期的码在被校验时一并删除
    expect(await verificationRows()).toHaveLength(0);
  });

  it("过期的验证码行不靠定时任务：任何一次验证码查找都会顺带删除全部过期行（verification.disableCleanup 未开）", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13999999999" } }); // 不存在的号码也写一行明文码
    await pool.query("UPDATE auth_verifications SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE)");
    expect(await verificationRows()).toHaveLength(1);
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: PHONE } });
    await expect(auth.api.verifyPhoneNumber({ body: { phoneNumber: PHONE, code: "000000" } })).rejects.toThrow();
    const left = await verificationRows();
    expect(left.map((r) => r.identifier)).not.toContain("phone-number-otp-13999999999");
  });

  it("同一手机号连发两次：以最新一条为准，旧码不能用", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, { sent });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    // 两次随机验证码相同的概率是 1e-6；相同就再发一次，保证断言一定被执行，不静默跳过
    let first = "";
    let second = "";
    for (let i = 0; i < 5 && first === second; i++) {
      await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: PHONE } });
      await new Promise((r) => setTimeout(r, 15)); // 两行 verification 的 created_at 不同毫秒
      await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: PHONE } });
      first = sent[sent.length - 2]!.code;
      second = sent[sent.length - 1]!.code;
    }
    expect(first).not.toBe(second);
    await expect(auth.api.verifyPhoneNumber({ body: { phoneNumber: PHONE, code: first } })).rejects.toThrow();
  });

  it("登录响应：不存在 / 无凭据 / 密码错误，错误码与消息一致", async () => {
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await seedUser(auth, { phone: "13800000003" }); // 待激活：无凭据
    const grab = async (phone: string, password: string) => {
      try {
        await auth.api.signInPhoneNumber({ body: { phoneNumber: phone, password } });
        return "ok";
      } catch (e) {
        const err = e as APIError;
        return `${err.status}:${(err.body as { code?: string; message?: string })?.code}:${(err.body as { message?: string })?.message}`;
      }
    };
    const wrong = await grab(PHONE, "WrongPassw0rd!");
    const missing = await grab("13999999999", "WrongPassw0rd!");
    const pending = await grab("13800000003", "WrongPassw0rd!");
    expect(missing).toBe(wrong);
    expect(pending).toBe(wrong);
  });
});

describe("S4：在钩子上插入我们的逻辑", () => {
  it("before 钩子可以拒绝登录（锁定检查）；after 钩子能看到失败并计数", async () => {
    const failures: string[] = [];
    const locked = new Set<string>();
    const { auth } = createSpikeAuth(pool, {
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/sign-in/phone-number" && locked.has(ctx.body.phoneNumber)) {
            throw new APIError("TOO_MANY_REQUESTS", { message: "locked", code: "ACCOUNT_LOCKED" });
          }
        }),
        after: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== "/sign-in/phone-number") return;
          const returned = ctx.context.returned;
          if (returned instanceof APIError) failures.push(ctx.body.phoneNumber);
        }),
      },
    });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    await expect(auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "bad-password" } })).rejects.toThrow();
    expect(failures).toEqual([PHONE]);
    locked.add(PHONE);
    // 锁定后连正确密码也被拒，且不会走到库的密码校验
    await expect(auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "Passw0rd!x" } })).rejects.toMatchObject({
      status: "TOO_MANY_REQUESTS",
    });
    const [s] = await pool.query("SELECT COUNT(*) AS n FROM auth_sessions");
    expect(Number((s as Array<{ n: number }>)[0]!.n)).toBe(0);
  });

  it("before 钩子能在发送前做资格校验：不存在的号码不写 verification、不回调发送，响应与成功一致", async () => {
    const sent: SentSms[] = [];
    const known = new Set([PHONE]);
    const { auth } = createSpikeAuth(pool, {
      sent,
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/phone-number/send-otp" && !known.has(ctx.body.phoneNumber)) {
            // 返回与成功相同的响应体，库的端点不再执行
            return ctx.json({ message: "code sent" });
          }
        }),
      },
    });
    const r = await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13999999999" } });
    expect(r).toEqual({ message: "code sent" });
    expect(sent).toHaveLength(0);
    expect(await verificationRows()).toHaveLength(0);
  });

  it("before 钩子能拒绝 verify 的 updatePhoneNumber（防止在线改号）", async () => {
    const sent: SentSms[] = [];
    const { auth } = createSpikeAuth(pool, {
      sent,
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/phone-number/verify" && ctx.body.updatePhoneNumber) {
            throw new APIError("FORBIDDEN", { message: "phone change not allowed", code: "PHONE_CHANGE_NOT_ALLOWED" });
          }
        }),
      },
    });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const login = await auth.api.signInPhoneNumber({ body: { phoneNumber: PHONE, password: "Passw0rd!x" }, asResponse: true });
    await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: "13800000002" } });
    await expect(
      auth.api.verifyPhoneNumber({
        body: { phoneNumber: "13800000002", code: sent[0]!.code, updatePhoneNumber: true },
        headers: new Headers({ cookie: cookieOf(login) }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    const [rows] = await pool.query("SELECT phone_number AS p FROM auth_users");
    expect((rows as Array<{ p: string }>)[0]!.p).toBe(PHONE);
  });

  // 发现（2026-11-10 实测）：phoneNumberValidator 只在 sign-in 与 send-otp 里调用；
  // request-password-reset / verify / reset-password 不调用。墓碑值因此能命中停用用户。
  describe("墓碑值与手机号格式校验的覆盖面", () => {
    const tombstoneOf = async (auth: ReturnType<typeof createSpikeAuth>["auth"]) => {
      const u = await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
      const t = `disabled:${u.id}`;
      await pool.query("UPDATE auth_users SET phone_number = ? WHERE id = ?", [t, u.id]);
      return t;
    };

    it("库自带的校验器没有覆盖 request-password-reset：墓碑值会让停用用户走到发送回调", async () => {
      const sent: SentSms[] = [];
      const { auth } = createSpikeAuth(pool, { sent });
      const t = await tombstoneOf(auth);
      await auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber: t } });
      expect(sent.map((s) => s.phone)).toEqual([t]); // 回调被调用 —— 这是缺口
    });

    it("send-otp 与 sign-in 被校验器挡住（对照）", async () => {
      const { auth } = createSpikeAuth(pool);
      const t = await tombstoneOf(auth);
      await expect(auth.api.sendPhoneNumberOTP({ body: { phoneNumber: t } })).rejects.toMatchObject({ body: { code: "INVALID_PHONE_NUMBER" } });
      await expect(auth.api.signInPhoneNumber({ body: { phoneNumber: t, password: "Passw0rd!x" } })).rejects.toMatchObject({
        body: { code: "INVALID_PHONE_NUMBER" },
      });
    });

    it("在全局 before 钩子里对所有 /phone-number* 与 /sign-in/phone-number 统一校验格式，缺口关闭", async () => {
      const sent: SentSms[] = [];
      const { auth } = createSpikeAuth(pool, {
        sent,
        hooks: {
          before: createAuthMiddleware(async (ctx) => {
            const isPhonePath = ctx.path.startsWith("/phone-number") || ctx.path === "/sign-in/phone-number";
            if (!isPhonePath) return;
            const p = (ctx.body as { phoneNumber?: unknown } | undefined)?.phoneNumber;
            if (typeof p !== "string" || !/^1[3-9]\d{9}$/.test(p)) {
              throw new APIError("BAD_REQUEST", { message: "invalid phone", code: "INVALID_PHONE_NUMBER" });
            }
          }),
        },
      });
      const t = await tombstoneOf(auth);
      for (const call of [
        () => auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber: t } }),
        () => auth.api.verifyPhoneNumber({ body: { phoneNumber: t, code: "123456" } }),
        () => auth.api.resetPasswordPhoneNumber({ body: { phoneNumber: t, otp: "123456", newPassword: "NewPassw0rd!" } }),
        () => auth.api.sendPhoneNumberOTP({ body: { phoneNumber: t } }),
      ]) {
        await expect(call()).rejects.toMatchObject({ body: { code: "INVALID_PHONE_NUMBER" } });
      }
      expect(sent).toHaveLength(0);
      expect(await verificationRows()).toHaveLength(0);
    });
  });

  it("after 钩子在重置密码成功后触发（激活置 active 的挂点），失败时 returned 是错误", async () => {
    const sent: SentSms[] = [];
    const activated: string[] = [];
    const { auth } = createSpikeAuth(pool, {
      sent,
      hooks: {
        after: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== "/phone-number/reset-password") return;
          if (!(ctx.context.returned instanceof APIError)) activated.push(ctx.body.phoneNumber);
        }),
      },
    });
    await seedUser(auth, { phone: PHONE });
    await auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber: PHONE } });
    await expect(
      auth.api.resetPasswordPhoneNumber({ body: { phoneNumber: PHONE, otp: "000000" === sent[0]!.code ? "111111" : "000000", newPassword: "NewPassw0rd!" } }),
    ).rejects.toThrow();
    expect(activated).toEqual([]);
    await auth.api.resetPasswordPhoneNumber({ body: { phoneNumber: PHONE, otp: sent[0]!.code, newPassword: "NewPassw0rd!" } });
    expect(activated).toEqual([PHONE]);
  });
});
