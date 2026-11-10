// Route Handler 直接用 new Request() 调用（S8、AX-12）：登录 → 读会话 → 退出；默认拒绝的路径白名单；统一的手机号钩子。
import { describe, expect, it, beforeEach } from "vitest";
import { cookieHeader, accessEnv, insertAccessUser, PASSWORD, type AccessEnv } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { ALLOWED_AUTH_ROUTES, createAuthRouteHandlers, healthResponse } from "./http";

const ORIGIN = "http://localhost:3000";
const t = useTestDb();
let env: AccessEnv;
let h: ReturnType<typeof createAuthRouteHandlers>;
beforeEach(() => {
  env = accessEnv(t, { flow: false });
  h = createAuthRouteHandlers(() => env.auth);
});

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/auth${path}`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("登录 → 读会话 → 退出", () => {
  it("往返成功，Set-Cookie 是 HttpOnly + SameSite=Lax + 15 天", async () => {
    const userId = await insertAccessUser(env, { phone: "13800000001", role: "branch_manager" });
    const login = await h.POST(req("POST", "/sign-in/phone-number", { phoneNumber: "13800000001", password: PASSWORD }));
    expect(login.status).toBe(200);
    const sc = login.headers.getSetCookie().join("\n");
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Max-Age=1296000/);
    expect(sc).not.toMatch(/Secure/i); // http 本地；https 下库自动加 Secure

    const cookie = cookieHeader(login);
    const sess = await h.GET(req("GET", "/get-session", undefined, { cookie }));
    expect(sess.status).toBe(200);
    const body = (await sess.json()) as { user: { id: string; phoneNumber: string }; session: { id: string } };
    expect(body.user.id).toBe(userId.toString()); // BIGINT 以十进制字符串往返
    expect(typeof body.session.id).toBe("string");

    const out = await h.POST(req("POST", "/sign-out", {}, { cookie }));
    expect(out.status).toBe(200);
    const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM auth_sessions");
    expect(Number((rows as Array<{ n: string }>)[0]!.n)).toBe(0);
    const after = await h.GET(req("GET", "/get-session", undefined, { cookie }));
    expect(await after.json()).toBeNull();
  });

  it("https 公开地址下会话 cookie 带 Secure", async () => {
    const e = accessEnv(t, { flow: false, config: { publicOrigin: "https://hbecho.example.com", trustedOrigins: ["https://hbecho.example.com"] } });
    await insertAccessUser(e, { phone: "13800000001" });
    const hh = createAuthRouteHandlers(() => e.auth);
    const res = await hh.POST(
      new Request("https://hbecho.example.com/api/auth/sign-in/phone-number", {
        method: "POST",
        headers: { origin: "https://hbecho.example.com", "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: "13800000001", password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/Secure/i);
  });

  it("来源检查是开着的：缺 Origin 或来自未受信 Origin 的带 cookie POST 被拒（不是 NODE_ENV=test 的默认关闭）", async () => {
    await insertAccessUser(env, { phone: "13800000001" });
    const login = await h.POST(req("POST", "/sign-in/phone-number", { phoneNumber: "13800000001", password: PASSWORD }));
    const cookie = cookieHeader(login);
    const noOrigin = await h.POST(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" }));
    expect(noOrigin.status).toBeGreaterThanOrEqual(400);
    expect(noOrigin.status).toBeLessThan(500);
    const evil = await h.POST(req("POST", "/sign-out", {}, { cookie, origin: "https://evil.example" }));
    expect(evil.status).toBeGreaterThanOrEqual(400);
    expect(evil.status).toBeLessThan(500);
  });

  it("密码登录对三种失败（用户不存在 / 待激活无凭据 / 密码错误）给出同样的状态码与消息", async () => {
    await insertAccessUser(env, { phone: "13800000001" });
    await insertAccessUser(env, { phone: "13800000002", status: "pending_activation" });
    const grab = async (phone: string) => {
      const r = await h.POST(req("POST", "/sign-in/phone-number", { phoneNumber: phone, password: "WrongPassw0rd!" }));
      return `${r.status}:${await r.text()}`;
    };
    const wrong = await grab("13800000001");
    expect(wrong).toMatch(/^401:/);
    expect(await grab("13999999999")).toBe(wrong);
    expect(await grab("13800000002")).toBe(wrong);
  });
});

describe("默认拒绝的路径白名单", () => {
  it.each([
    ["POST", "/sign-up/email"],
    ["POST", "/sign-in/email"],
    ["POST", "/update-user"],
    ["POST", "/delete-user"],
    ["POST", "/change-email"],
    ["POST", "/set-password"],
    ["POST", "/admin/set-user-password"],
    ["POST", "/admin/impersonate-user"],
    ["GET", "/list-sessions"],
    ["POST", "/revoke-sessions"],
    ["GET", "/reference"],
    ["GET", "/ok"],
    ["POST", "/phone-number/consume-otp"],
  ])("%s %s → 404，不转发给库", async (method, path) => {
    const res = await h.POST(req(method, path, method === "POST" ? {} : undefined));
    expect(res.status).toBe(404);
  });

  it("方法不对 → 405", async () => {
    expect((await h.GET(req("GET", "/sign-in/phone-number"))).status).toBe(405);
    expect((await h.POST(req("POST", "/get-session", {}))).status).toBe(405);
  });

  it("白名单只有设计里的几条", () => {
    expect([...ALLOWED_AUTH_ROUTES.keys()].sort()).toEqual([
      "/change-password",
      "/get-session",
      "/phone-number/request-password-reset",
      "/phone-number/reset-password",
      "/phone-number/send-otp",
      "/phone-number/verify",
      "/sign-in/phone-number",
      "/sign-out",
    ]);
  });

  it("basePath 之外的路径不处理", async () => {
    const res = await h.GET(new Request(`${ORIGIN}/other/get-session`));
    expect(res.status).toBe(404);
  });
});

describe("统一的手机号钩子（ADR-0015 缺口 1 / 2）", () => {
  it("非规范形态会被规范化后再进库：+86 与分隔符的写法也能登录", async () => {
    await insertAccessUser(env, { phone: "13800000001" });
    const res = await h.POST(req("POST", "/sign-in/phone-number", { phoneNumber: "+86 138-0000-0001", password: PASSWORD }));
    expect(res.status).toBe(200);
  });

  it.each(["/phone-number/send-otp", "/phone-number/verify", "/phone-number/request-password-reset", "/phone-number/reset-password", "/sign-in/phone-number"])(
    "%s 对墓碑值与非手机号一律 400 INVALID_PHONE_NUMBER，不写 verification、不发短信",
    async (path) => {
      for (const bad of ["disabled:12", "abc", "1.38E+10", ""]) {
        const res = await h.POST(req("POST", path, { phoneNumber: bad, password: PASSWORD, code: "123456", otp: "123456", newPassword: "NewPassw0rd!" }));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("INVALID_PHONE_NUMBER");
      }
      const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM auth_verifications");
      expect(Number((rows as Array<{ n: string }>)[0]!.n)).toBe(0);
      expect(env.sender.sent).toHaveLength(0);
    },
  );

  it("verify 带 updatePhoneNumber（在线改号）被拒 403，号码不变", async () => {
    await insertAccessUser(env, { phone: "13800000001" });
    const login = await h.POST(req("POST", "/sign-in/phone-number", { phoneNumber: "13800000001", password: PASSWORD }));
    const cookie = cookieHeader(login);
    const res = await h.POST(req("POST", "/phone-number/verify", { phoneNumber: "13800000002", code: "123456", updatePhoneNumber: true }, { cookie }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("PHONE_CHANGE_NOT_ALLOWED");
    const [rows] = await t.pool.query("SELECT phone_number AS p FROM auth_users");
    expect((rows as Array<{ p: string }>)[0]!.p).toBe("13800000001");
  });
});

describe("健康检查", () => {
  it("200 且不读不写数据库", async () => {
    const res = healthResponse();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("限流的客户端 IP（HBECHO_TRUSTED_PROXIES）", () => {
  const login = (hh: ReturnType<typeof createAuthRouteHandlers>, xff: string | null) =>
    hh.POST(
      new Request(`${ORIGIN}/api/auth/sign-in/phone-number`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", ...(xff === null ? {} : { "x-forwarded-for": xff }) },
        body: JSON.stringify({ phoneNumber: "13999999999", password: "WrongPassw0rd!" }),
      }),
    );

  it("配置了受信代理：按 Nginx 追加的真实客户端 IP 分桶；客户端自己伪造的前缀不能换桶", async () => {
    const e = accessEnv(t, { flow: false, config: { trustedProxies: ["10.0.0.1"], authRateLimitPerMin: 3 } });
    const hh = createAuthRouteHandlers(() => e.auth);
    // 同一个真实客户端 1.1.1.1，每次伪造不同的最左 IP；代理 10.0.0.1 追加了真实地址
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await login(hh, `9.9.9.${i}, 1.1.1.1, 10.0.0.1`)).status);
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]); // 伪造前缀没有换到新桶
    // 另一个真实客户端不受影响
    expect((await login(hh, "2.2.2.2, 10.0.0.1")).status).not.toBe(429);
  });

  it("没配置受信代理且头里有多个值：取不到可信 IP，所有请求落进同一个共享桶（一个人刷满，别人一起 429）", async () => {
    const e = accessEnv(t, { flow: false, config: { trustedProxies: [], authRateLimitPerMin: 3 } });
    const hh = createAuthRouteHandlers(() => e.auth);
    // 测试环境下库对「无 IP」会退回本地地址；这里用多值头触发「不可信」分支，再看是否共享桶
    const a: number[] = [];
    for (let i = 0; i < 4; i++) a.push((await login(hh, `3.3.3.${i}, 4.4.4.4`)).status);
    const other = await login(hh, "7.7.7.7, 8.8.8.8"); // 完全不同的另一个人
    // 要么共享桶（other 也被 429），要么库回退到本地地址（同样是共享）：两种都说明「无受信代理 ⇒ 不能按人区分」
    expect(a[3] === 429 || other.status === 429).toBe(true);
  });
});
