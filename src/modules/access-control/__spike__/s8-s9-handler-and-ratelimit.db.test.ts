// S8 Route Handler 可在 vitest（Node，无 Next 运行时）里用 new Request() 直接调用；S9 库的请求级限流。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { createPool } from "../../../db/client";
import { cookieOf, createSpikeAuth, resetAuthTables, seedUser } from "./spike-auth";

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
const ORIGIN = "http://localhost:3000";

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

describe("S8：Route Handler 直接调用", () => {
  it("auth.handler(new Request()) 完成登录 → 读会话 → 退出，返回 Set-Cookie", async () => {
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });

    const login = await auth.handler(post("/sign-in/phone-number", { phoneNumber: PHONE, password: "Passw0rd!x" }));
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/better-auth\.session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=1296000/); // 15 天
    const cookie = cookieOf(login);

    const sess = await auth.handler(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } }));
    expect(sess.status).toBe(200);
    const body = (await sess.json()) as { user: { id: string; phoneNumber: string } };
    expect(typeof body.user.id).toBe("string");
    expect(body.user.phoneNumber).toBe(PHONE);

    const out = await auth.handler(post("/sign-out", {}, { cookie }));
    expect(out.status).toBe(200);
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM auth_sessions");
    expect(Number((rows as Array<{ n: number }>)[0]!.n)).toBe(0); // 退出即删行
  });

  it("带 cookie 的 POST 缺 Origin 头：被库的 CSRF 检查拒绝（Route Handler 层的默认保护）", async () => {
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const login = await auth.handler(post("/sign-in/phone-number", { phoneNumber: PHONE, password: "Passw0rd!x" }));
    const cookie = cookieOf(login);
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("来自未受信 Origin 的带 cookie 请求被拒", async () => {
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const login = await auth.handler(post("/sign-in/phone-number", { phoneNumber: PHONE, password: "Passw0rd!x" }));
    const cookie = cookieOf(login);
    const res = await auth.handler(post("/sign-out", {}, { cookie, origin: "https://evil.example" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("邮箱注册 / 登录端点在 spike 配置下同样关闭（与生产一致，防止照 spike 复制配置时重新打开公开注册）", async () => {
    const { auth } = createSpikeAuth(pool);
    for (const path of ["/sign-up/email", "/sign-in/email"]) {
      const res = await auth.handler(post(path, { email: "x@hbecho.invalid", password: "Passw0rd!xx", name: "x" }));
      expect(res.status, path).toBeGreaterThanOrEqual(400);
    }
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM auth_users");
    expect(Number((rows as Array<{ n: string }>)[0]!.n)).toBe(0); // 没有任何人被注册进来
  });

  it("better-auth/next-js 的 toNextJsHandler 不需要 Next 运行时即可导入并调用", async () => {
    const { toNextJsHandler } = await import("better-auth/next-js");
    const { auth } = createSpikeAuth(pool);
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const { POST } = toNextJsHandler(auth);
    const res = await POST(post("/sign-in/phone-number", { phoneNumber: PHONE, password: "Passw0rd!x" }));
    expect(res.status).toBe(200);
  });
});

describe("S9：请求级限流", () => {
  const ip = (n: number) => ({ "x-forwarded-for": `10.0.0.${n}` });

  it("启用后同一 IP 同一路径超过 max 返回 429；不同 IP 互不影响", async () => {
    const { auth } = createSpikeAuth(pool, { rateLimit: { enabled: true, window: 60, max: 3 } });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await auth.handler(post("/sign-in/phone-number", { phoneNumber: PHONE, password: "bad-password" }, ip(1)));
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
    const other = await auth.handler(post("/sign-in/phone-number", { phoneNumber: PHONE, password: "Passw0rd!x" }, ip(2)));
    expect(other.status).toBe(200);
  });

  it("手机号插件自带 /phone-number 路径每 60 秒 10 次的规则（同一出口 IP 的公司内网会被它误伤），可用 customRules 调高", async () => {
    const strict = createSpikeAuth(pool, { rateLimit: { enabled: true, window: 60, max: 1000 } });
    const s: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await strict.auth.handler(post("/phone-number/send-otp", { phoneNumber: "13999999999" }, ip(3)));
      s.push(r.status);
    }
    expect(s.filter((x) => x === 429).length).toBeGreaterThan(0); // 插件规则生效

    const relaxed = createSpikeAuth(pool, {
      rateLimit: { enabled: true, window: 60, max: 1000, customRules: { "/phone-number/send-otp": { window: 60, max: 100 } } },
    });
    const r2: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await relaxed.auth.handler(post("/phone-number/send-otp", { phoneNumber: "13999999999" }, ip(4)));
      r2.push(r.status);
    }
    expect(r2.filter((x) => x === 429)).toHaveLength(0);
  });

  it("限流只按 IP + 路径计数，不按手机号：同一手机号换 IP 的错误尝试不被库限流（账号锁定仍须由我们自建）", async () => {
    const { auth } = createSpikeAuth(pool, { rateLimit: { enabled: true, window: 60, max: 3 } });
    await seedUser(auth, { phone: PHONE, password: "Passw0rd!x" });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await auth.handler(post("/sign-in/phone-number", { phoneNumber: PHONE, password: "bad-password" }, ip(10 + i)));
      statuses.push(r.status);
    }
    expect(statuses.every((x) => x !== 429)).toBe(true);
  });
});
