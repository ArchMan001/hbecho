// 登录保护、短信规则、激活 / 重置 / 改密（任务 5；AX-1、AX-2、AX-4）。
// 真实 better-auth + 真实 MySQL；短信用假发送器；锁定与短信限频读 FakeClock。
// 注意：better-auth 自己用真实时钟（会话 / 验证码过期），所以这些时间点用直接改库的时间戳来模拟（与 __spike__ 同一做法）。
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, cookieHeader, insertAccessUser, loginAs, PASSWORD, type AccessEnv } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { createAuthRouteHandlers } from "./http";

const t = useTestDb();
let env: AccessEnv;
let h: ReturnType<typeof createAuthRouteHandlers>;
const ORIGIN = "http://localhost:3000";
const PHONE = "13800000001";
const MIN = 60_000;

beforeEach(() => {
  env = accessEnv(t);
  h = createAuthRouteHandlers(() => env.auth);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  h.POST(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const signIn = (phone: string, password: string) => post("/sign-in/phone-number", { phoneNumber: phone, password });
const sendOtp = (phone: string) => post("/phone-number/send-otp", { phoneNumber: phone });
const requestReset = (phone: string) => post("/phone-number/request-password-reset", { phoneNumber: phone });
const verify = (phone: string, code: string) => post("/phone-number/verify", { phoneNumber: phone, code });
const reset = (phone: string, otp: string, newPassword: string) => post("/phone-number/reset-password", { phoneNumber: phone, otp, newPassword });
const snap = async (r: Response) => `${r.status}:${await r.text()}`;
const codeOf = (phone: string): string => {
  const m = env.sender.last(phone);
  if (!m) throw new Error(`没有给 ${phone} 发过验证码`);
  return m.code;
};
const wrongCode = (c: string): string => (c === "000000" ? "111111" : "000000");
const count = async (table: string, where = "1=1"): Promise<number> => {
  const [rows] = await t.pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`);
  return Number((rows as Array<{ n: string }>)[0]!.n);
};

describe("登录锁定（AX-4）", () => {
  it("连续 5 次失败后第 6 次（含正确密码）被拒；推进 15 分钟后可登录，计数清零", async () => {
    await insertAccessUser(env, { phone: PHONE });
    for (let i = 0; i < 5; i++) expect((await signIn(PHONE, "WrongPassw0rd!")).status).toBe(401);
    expect((await signIn(PHONE, PASSWORD)).status).toBe(401); // 锁定：正确密码也不放行
    env.clock.advance(14 * MIN);
    expect((await signIn(PHONE, PASSWORD)).status).toBe(401); // 14 分钟：仍在锁定
    env.clock.advance(1 * MIN + 1);
    expect((await signIn(PHONE, PASSWORD)).status).toBe(200);
    expect(await count("access_login_failures")).toBe(0); // 成功清零
  });

  it("锁定期满后再失败，从 1 开始新一轮（不是立刻再锁）", async () => {
    await insertAccessUser(env, { phone: PHONE });
    for (let i = 0; i < 5; i++) await signIn(PHONE, "WrongPassw0rd!");
    env.clock.advance(15 * MIN + 1);
    await signIn(PHONE, "WrongPassw0rd!");
    const [rows] = await t.pool.query("SELECT fail_count AS c, locked_until AS l FROM access_login_failures");
    expect((rows as Array<{ c: number; l: Date | null }>)[0]).toMatchObject({ c: 1, l: null });
    expect((await signIn(PHONE, PASSWORD)).status).toBe(200);
  });

  it("锁定期间短信验证码登录不受影响（只限制密码登录）", async () => {
    await insertAccessUser(env, { phone: PHONE });
    for (let i = 0; i < 5; i++) await signIn(PHONE, "WrongPassw0rd!");
    expect((await signIn(PHONE, PASSWORD)).status).toBe(401);
    expect((await sendOtp(PHONE)).status).toBe(200);
    const v = await verify(PHONE, codeOf(PHONE));
    expect(v.status).toBe(200);
    expect(v.headers.getSetCookie().join()).toContain("session_token");
  });

  it("短信重置密码成功是唯一的提前解锁路径：重置后立即可用新密码登录，且其他会话被踢出", async () => {
    await insertAccessUser(env, { phone: PHONE });
    const old = await loginAs(env, PHONE);
    for (let i = 0; i < 5; i++) await signIn(PHONE, "WrongPassw0rd!");
    expect((await signIn(PHONE, PASSWORD)).status).toBe(401);
    expect((await requestReset(PHONE)).status).toBe(200);
    expect((await reset(PHONE, codeOf(PHONE), "NewPassw0rd!")).status).toBe(200);
    expect((await signIn(PHONE, "NewPassw0rd!")).status).toBe(200);
    expect(await env.auth.api.getSession({ headers: old })).toBeNull(); // 重置撤销全部旧会话
    expect(await count("access_login_failures")).toBe(0);
  });

  it("不论手机号是否存在用户：5 次失败后的响应与计数行为一致，不暴露账号存在性", async () => {
    await insertAccessUser(env, { phone: PHONE });
    const a = [];
    const b = [];
    for (let i = 0; i < 7; i++) {
      a.push(await snap(await signIn(PHONE, "WrongPassw0rd!")));
      b.push(await snap(await signIn("13999999999", "WrongPassw0rd!")));
    }
    expect(b).toEqual(a);
    const [rows] = await t.pool.query("SELECT phone_norm AS p, fail_count AS c, locked_until IS NOT NULL AS locked FROM access_login_failures ORDER BY phone_norm");
    expect((rows as Array<{ p: string; c: number; locked: number }>).map((r) => [r.p, r.c, Number(r.locked)])).toEqual([
      [PHONE, 5, 1],
      ["13999999999", 5, 1],
    ]);
  });

  it("待激活用户与停用用户的密码登录失败同样计数，响应与密码错误一致", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await insertAccessUser(env, { phone: "13800000002", status: "pending_activation" });
    await insertAccessUser(env, { phone: "13800000003", status: "disabled" });
    const wrong = await snap(await signIn(PHONE, "WrongPassw0rd!"));
    expect(await snap(await signIn("13800000002", PASSWORD))).toBe(wrong);
    expect(await snap(await signIn("13800000003", PASSWORD))).toBe(wrong);
  });

  it("验证码输错不计入密码锁定", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await sendOtp(PHONE);
    for (let i = 0; i < 3; i++) expect((await verify(PHONE, wrongCode(codeOf(PHONE)))).status).toBe(400);
    expect(await count("access_login_failures")).toBe(0);
  });

  it("密码最短 8 位：7 位被拒，8 位通过", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await requestReset(PHONE);
    expect((await reset(PHONE, codeOf(PHONE), "Abcde1!")).status).toBe(400);
    expect((await reset(PHONE, codeOf(PHONE), "Abcde1!x")).status).toBe(200);
  });
});

describe("短信规则（AX-4）", () => {
  it("有效用户请求登录验证码：发出一条，记录 sent，用途 login", async () => {
    await insertAccessUser(env, { phone: PHONE });
    expect((await sendOtp(PHONE)).status).toBe(200);
    expect(env.sender.sent).toHaveLength(1);
    expect(env.sender.sent[0]).toMatchObject({ phone: PHONE, kind: "login" });
    expect(env.sender.sent[0]!.code).toMatch(/^\d{6}$/);
    expect(await count("access_sms_sends", "outcome='sent' AND purpose='login'")).toBe(1);
  });

  it("60 秒内重发被拒；每 30 秒连续重试，被拒的重试不延长窗口，首次请求后 60 秒即可发送", async () => {
    await insertAccessUser(env, { phone: PHONE });
    expect((await sendOtp(PHONE)).status).toBe(200);
    env.clock.advance(30_000);
    const r = await sendOtp(PHONE);
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("SMS_RATE_LIMITED");
    env.clock.advance(30_000); // 距首次正好 60 秒
    expect((await sendOtp(PHONE)).status).toBe(200);
    expect(env.sender.sent).toHaveLength(2);
    expect(await count("access_sms_sends", "outcome='rate_limited'")).toBe(1);
  });

  it("每个号码每天最多 10 条，第 11 条被拒；次日（北京时间）恢复", async () => {
    await insertAccessUser(env, { phone: PHONE });
    for (let i = 0; i < 10; i++) {
      expect((await sendOtp(PHONE)).status).toBe(200);
      env.clock.advance(61_000);
    }
    const r = await sendOtp(PHONE);
    expect(r.status).toBe(429);
    env.clock.advance(24 * 3600_000);
    expect((await sendOtp(PHONE)).status).toBe(200);
  });

  it("并发请求同一号码：8 个同时到达只有 1 个通过，其余被 60 秒窗口拒绝（不会多发短信）", async () => {
    await insertAccessUser(env, { phone: PHONE });
    // 刻意并发：被测对象就是并发下的窗口判断（admit 内部按号码加库锁）。
    // 先全部启动（此时还没有任何一个 await 过），再逐个等待——不用 Promise.all（design §11 的并发用例写法）
    const started = Array.from({ length: 8 }, () => env.sms.admit(PHONE, "login"));
    const rs = [];
    for (const p of started) rs.push(await p);
    expect(rs.filter((r) => r.kind === "proceed")).toHaveLength(1);
    expect(rs.filter((r) => r.kind === "rate_limited")).toHaveLength(7);
    expect(await count("access_sms_sends", "outcome='sent'")).toBe(1);
  });

  it("重发使旧验证码立即失效", async () => {
    await insertAccessUser(env, { phone: PHONE });
    // 两次随机验证码相同的概率是 1e-6；相同就再发一次，保证断言一定被执行，不静默跳过
    let first = "";
    let second = "";
    for (let i = 0; i < 5 && first === second; i++) {
      await sendOtp(PHONE);
      first = codeOf(PHONE);
      env.clock.advance(61_000);
      await new Promise((r) => setTimeout(r, 15)); // 两行 verification 的 created_at 不同毫秒
      await sendOtp(PHONE);
      second = codeOf(PHONE);
      env.clock.advance(61_000);
    }
    expect(first).not.toBe(second);
    expect((await verify(PHONE, first)).status).toBe(400);
    expect((await verify(PHONE, second)).status).toBe(200);
  });

  it("验证码 5 分钟过期", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await sendOtp(PHONE);
    await t.pool.query("UPDATE auth_verifications SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)");
    expect((await verify(PHONE, codeOf(PHONE))).status).toBe(400);
  });

  it("连续输错 5 次作废：第 6 次用正确码也失败，需重新获取", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await sendOtp(PHONE);
    const good = codeOf(PHONE);
    for (let i = 0; i < 5; i++) expect((await verify(PHONE, wrongCode(good))).status).toBe(400);
    expect((await verify(PHONE, good)).status).not.toBe(200);
    env.clock.advance(61_000);
    await sendOtp(PHONE); // 重新获取
    expect((await verify(PHONE, codeOf(PHONE))).status).toBe(200);
  });

  it("对不存在 / 停用 / 待激活（登录用途）的号码请求发送：响应与成功一致，假发送器无记录，不写 verification", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await insertAccessUser(env, { phone: "13800000002", status: "disabled" });
    await insertAccessUser(env, { phone: "13800000003", status: "pending_activation" });
    const ok = await snap(await sendOtp(PHONE));
    for (const p of ["13999999999", "13800000002", "13800000003"]) expect(await snap(await sendOtp(p))).toBe(ok);
    expect(env.sender.sent.map((m) => m.phone)).toEqual([PHONE]);
    expect(await count("auth_verifications")).toBe(1);
    expect(await count("access_sms_sends", "outcome='suppressed'")).toBe(3);
    // 重置用途同理：不存在 / 停用号码成功样式但不发送（先推进时间，避开上面请求占用的 60 秒窗口）
    env.clock.advance(61_000);
    const okReset = await snap(await requestReset(PHONE));
    for (const p of ["13999999999", "13800000002"]) expect(await snap(await requestReset(p))).toBe(okReset);
    expect(env.sender.sent.map((m) => m.phone)).toEqual([PHONE, PHONE]);
  });

  it("被抑制的请求也计入 60 秒窗口，使存在与不存在的号码表现一致", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await sendOtp("13999999999");
    expect((await sendOtp("13999999999")).status).toBe(429);
    await sendOtp(PHONE);
    expect((await sendOtp(PHONE)).status).toBe(429);
  });

  it("全局每日上限：短信类请求暂停并出现一条告警，密码登录仍成功；已达上限后不再为不存在的号码泄露差别", async () => {
    const e = accessEnv(t, { config: { smsDailyCap: 2 } });
    for (const p of ["13800000001", "13800000002", "13800000003"]) await insertAccessUser(e, { phone: p });
    const hh = createAuthRouteHandlers(() => e.auth);
    const send = (p: string) => hh.POST(new Request(`${ORIGIN}/api/auth/phone-number/send-otp`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ phoneNumber: p }) }));
    expect((await send("13800000001")).status).toBe(200);
    expect((await send("13800000002")).status).toBe(200);
    const blocked = await send("13800000003");
    expect(blocked.status).toBe(503);
    expect(await blocked.text()).toContain("SMS_UNAVAILABLE");
    expect(e.alerts).toEqual([{ type: "sms_daily_cap_reached", cap: 2, sentToday: 2 }]);
    await send("13800000003"); // 再来一次：同一天只告警一次
    expect(e.alerts).toHaveLength(1);
    expect(await count("audit_events", "event_type='sms_daily_cap_reached'")).toBe(1);
    // 密码登录不受影响
    const login = await hh.POST(new Request(`${ORIGIN}/api/auth/sign-in/phone-number`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ phoneNumber: "13800000003", password: PASSWORD }) }));
    expect(login.status).toBe(200);
  });

  it("发送器报运维类错误（如余额不足）：发告警，用户仍只看到「暂时无法发送」，错误码不泄露给用户", async () => {
    await insertAccessUser(env, { phone: PHONE });
    const err = Object.assign(new Error("阿里云短信发送失败：isv.AMOUNT_NOT_ENOUGH"), { operational: true, providerCode: "isv.AMOUNT_NOT_ENOUGH" });
    env.sender.send = async () => {
      throw err;
    };
    const r = await sendOtp(PHONE);
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("AMOUNT_NOT_ENOUGH");
    expect(env.alerts).toEqual([{ type: "sms_provider_operational_error", providerCode: "isv.AMOUNT_NOT_ENOUGH" }]);
  });

  it("单用户类的发送失败不发运维告警", async () => {
    await insertAccessUser(env, { phone: PHONE });
    env.sender.failNext();
    await sendOtp(PHONE);
    expect(env.alerts).toEqual([]);
  });

  it("发送失败：用户得到「暂时无法发送」，记录 failed，计入 60 秒窗口但不计入全局 sent，不泄露内部错误", async () => {
    await insertAccessUser(env, { phone: PHONE });
    env.sender.failNext();
    const r = await sendOtp(PHONE);
    expect(r.status).toBe(503);
    const body = await r.text();
    expect(body).toContain("SMS_SEND_FAILED");
    expect(body).not.toContain("fake sms sender failure");
    expect(await count("access_sms_sends", "outcome='failed'")).toBe(1);
    expect(await count("access_sms_sends", "outcome='sent'")).toBe(0);
    expect((await sendOtp(PHONE)).status).toBe(429); // 失败也占窗口
  });
});

describe("激活（AX-2）", () => {
  it("待激活用户：请求验证码（用途 activate）→ 设置密码 → 变有效 → 可密码登录；有 user_activated 审计", async () => {
    const userId = await insertAccessUser(env, { phone: PHONE, status: "pending_activation", role: "branch_manager" });
    expect((await signIn(PHONE, PASSWORD)).status).toBe(401); // 激活前不能密码登录
    expect((await requestReset(PHONE)).status).toBe(200);
    expect(env.sender.last(PHONE)).toMatchObject({ kind: "activate" });
    expect((await reset(PHONE, codeOf(PHONE), "MyNewPassw0rd!")).status).toBe(200);
    const [rows] = await t.pool.query("SELECT status AS s, activated_at AS a FROM access_users WHERE user_id = ?", [userId]);
    expect((rows as Array<{ s: string; a: Date | null }>)[0]!.s).toBe("active");
    expect((rows as Array<{ s: string; a: Date | null }>)[0]!.a).not.toBeNull();
    expect((await signIn(PHONE, "MyNewPassw0rd!")).status).toBe(200);
    expect(await count("audit_events", `event_type='user_activated' AND target_id='${userId}'`)).toBe(1);
  });

  it("创建待激活用户本身不发短信", async () => {
    await insertAccessUser(env, { phone: PHONE, status: "pending_activation" });
    expect(env.sender.sent).toHaveLength(0);
    expect(await count("access_sms_sends")).toBe(0);
  });

  it("待激活用户不能用验证码登录：不发码、verify 也拒绝", async () => {
    await insertAccessUser(env, { phone: PHONE, status: "pending_activation" });
    expect((await sendOtp(PHONE)).status).toBe(200); // 成功样式
    expect(env.sender.sent).toHaveLength(0);
    expect((await verify(PHONE, "123456")).status).toBe(400);
    expect(await count("auth_sessions")).toBe(0);
  });

  it("待激活不会自动过期：推进 1 年后仍可激活", async () => {
    await insertAccessUser(env, { phone: PHONE, status: "pending_activation" });
    env.clock.advance(365 * 24 * 3600_000);
    await requestReset(PHONE);
    expect((await reset(PHONE, codeOf(PHONE), "MyNewPassw0rd!")).status).toBe(200);
    expect((await signIn(PHONE, "MyNewPassw0rd!")).status).toBe(200);
  });

  it("停用用户不能激活 / 重置：请求成功样式但不发码", async () => {
    await insertAccessUser(env, { phone: PHONE, status: "disabled" });
    expect((await requestReset(PHONE)).status).toBe(200);
    expect(env.sender.sent).toHaveLength(0);
    expect((await reset(PHONE, "123456", "MyNewPassw0rd!")).status).toBe(400);
  });
});

describe("改密与重置后的会话（AX-1）", () => {
  it("重置密码撤销该用户全部会话，写 password_reset 审计；旧密码失效", async () => {
    const userId = await insertAccessUser(env, { phone: PHONE });
    const a = await loginAs(env, PHONE);
    const b = await loginAs(env, PHONE);
    await requestReset(PHONE);
    await reset(PHONE, codeOf(PHONE), "NewPassw0rd!");
    expect(await env.auth.api.getSession({ headers: a })).toBeNull();
    expect(await env.auth.api.getSession({ headers: b })).toBeNull();
    expect((await signIn(PHONE, PASSWORD)).status).toBe(401);
    expect(await count("audit_events", `event_type='password_reset' AND target_id='${userId}'`)).toBe(1);
  });

  it("改密撤销其他会话，当前用户保持登录（库把当前会话轮换成新 cookie）；即使调用方传 revokeOtherSessions=false 也被强制为 true", async () => {
    const userId = await insertAccessUser(env, { phone: PHONE });
    const current = await loginAs(env, PHONE);
    const other = await loginAs(env, PHONE);
    const res = await post("/change-password", { currentPassword: PASSWORD, newPassword: "ChangedPassw0rd!", revokeOtherSessions: false }, { cookie: current.get("cookie")! });
    expect(res.status).toBe(200);
    expect(await env.auth.api.getSession({ headers: other })).toBeNull();
    // 旧 cookie 作废，响应里下发新 cookie：用户感知上仍然登录着
    expect(await env.auth.api.getSession({ headers: current })).toBeNull();
    const rotated = new Headers({ cookie: cookieHeader(res) });
    expect(await env.auth.api.getSession({ headers: rotated })).not.toBeNull();
    expect(await count("auth_sessions")).toBe(1);
    expect((await signIn(PHONE, PASSWORD)).status).toBe(401);
    expect((await signIn(PHONE, "ChangedPassw0rd!")).status).toBe(200);
    expect(await count("audit_events", `event_type='password_changed' AND target_id='${userId}'`)).toBe(1);
  });

  it("改密需要当前密码：错误的当前密码被拒，其他会话不受影响", async () => {
    await insertAccessUser(env, { phone: PHONE });
    const current = await loginAs(env, PHONE);
    const other = await loginAs(env, PHONE);
    const res = await post("/change-password", { currentPassword: "WrongPassw0rd!", newPassword: "ChangedPassw0rd!" }, { cookie: current.get("cookie")! });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await env.auth.api.getSession({ headers: other })).not.toBeNull();
  });
});

describe("审计与日志卫生（AX-10）", () => {
  it("登录 / 激活 / 重置 / 改密全流程后，审计里没有密码、验证码、令牌、Cookie", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await insertAccessUser(env, { phone: "13800000002", status: "pending_activation" });
    await signIn(PHONE, "WrongPassw0rd!");
    await signIn(PHONE, PASSWORD);
    await sendOtp(PHONE);
    const otp = codeOf(PHONE);
    await verify(PHONE, otp);
    await requestReset("13800000002");
    const activationCode = codeOf("13800000002");
    await reset("13800000002", activationCode, "SecretNewPassw0rd!");
    const [rows] = await t.pool.query("SELECT CAST(detail AS CHAR) AS d, event_type AS e, reason_code AS r, actor AS a FROM audit_events");
    const text = JSON.stringify(rows);
    for (const secret of [PASSWORD, "WrongPassw0rd!", "SecretNewPassw0rd!", otp, activationCode, "session_token", "better-auth"]) {
      expect(text, `审计里出现了 ${secret === otp || secret === activationCode ? "验证码" : secret}`).not.toContain(secret);
    }
    const events = (rows as Array<{ e: string; r: string }>).map((r) => `${r.e}:${r.r}`);
    expect(events).toEqual(expect.arrayContaining(["login_failed:invalid_password", "login_succeeded:login_succeeded", "user_activated:user_activated"]));
  });

  it("5 次失败产生一条 account_locked 审计（不是每次被拒的尝试都写）", async () => {
    await insertAccessUser(env, { phone: PHONE });
    for (let i = 0; i < 8; i++) await signIn(PHONE, "WrongPassw0rd!");
    expect(await count("audit_events", "reason_code='account_locked'")).toBe(1);
    expect(await count("audit_events", "reason_code='invalid_password'")).toBe(5);
  });

  it("不存在的号码登录失败：只进计数表，不写审计（防止随机号码灌审计表）；已存在用户照常写", async () => {
    await insertAccessUser(env, { phone: PHONE });
    for (let i = 0; i < 6; i++) await signIn("13999999999", "WrongPassw0rd!");
    expect(await count("audit_events")).toBe(0);
    expect(await count("access_login_failures", "phone_norm = '13999999999'")).toBe(1);
    await signIn(PHONE, "WrongPassw0rd!");
    expect(await count("audit_events", "reason_code = 'invalid_password'")).toBe(1);
  });

  it("access_sms_sends 不含验证码", async () => {
    await insertAccessUser(env, { phone: PHONE });
    await sendOtp(PHONE);
    const [rows] = await t.pool.query("SELECT * FROM access_sms_sends");
    expect(JSON.stringify(rows)).not.toContain(codeOf(PHONE));
  });
});

describe("不留 IP 维度", () => {
  it("换不同 IP 的失败仍按手机号累计锁定（锁定不依赖 IP）", async () => {
    await insertAccessUser(env, { phone: PHONE });
    for (let i = 0; i < 5; i++) await post("/sign-in/phone-number", { phoneNumber: PHONE, password: "WrongPassw0rd!" }, { "x-forwarded-for": `10.1.0.${i}` });
    const r = await post("/sign-in/phone-number", { phoneNumber: PHONE, password: PASSWORD }, { "x-forwarded-for": "10.9.9.9" });
    expect(r.status).toBe(401);
  });
});

describe("密码登录只对有效用户建会话（审查建议：结构性关闭「有密码但仍待激活」）", () => {
  it("有密码凭据但状态仍是待激活（激活事务失败的残留）：密码登录被拒，不建会话；响应与密码错误一致", async () => {
    await insertAccessUser(env, { phone: PHONE, status: "pending_activation", password: true });
    const wrong = await snap(await signIn("13999999999", "WrongPassw0rd!"));
    const r = await signIn(PHONE, PASSWORD); // 密码是对的
    expect(await snap(r)).toBe(wrong);
    expect(await count("auth_sessions")).toBe(0);
  });

  it("这种被拒的尝试同样计入失败次数（不因为状态不同而暴露差别）", async () => {
    await insertAccessUser(env, { phone: PHONE, status: "pending_activation", password: true });
    for (let i = 0; i < 5; i++) expect((await signIn(PHONE, PASSWORD)).status).toBe(401);
    const [rows] = await t.pool.query("SELECT phone_norm, fail_count, locked_until FROM access_login_failures");
    const r = (rows as Array<{ phone_norm: string; fail_count: number; locked_until: Date | null }>)[0]!;
    expect([r.phone_norm, Number(r.fail_count)]).toEqual([PHONE, 5]);
    expect(r.locked_until).not.toBeNull(); // 第 5 次开始锁定，与其他失败一致
  });
});
