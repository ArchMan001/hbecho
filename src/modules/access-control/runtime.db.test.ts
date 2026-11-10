// 生产运行时（runtime.ts，Web 进程用的那个装配）确实带着登录锁定、短信规则、激活流程。
// 这条测试存在的原因：任务 5 交付时测试挂具接了流程而运行时没接，登录锁定在生产入口上是不生效的。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAccessUser, PASSWORD } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { createAuthRouteHandlers } from "./http";
import { createRuntime, type AccessRuntime } from "./runtime";

const t = useTestDb();
let rt: AccessRuntime;
beforeEach(() => {
  rt = createRuntime({
    HBECHO_DATABASE_URL: process.env.HBECHO_TEST_DATABASE_URL,
    HBECHO_AUTH_SECRET: "x".repeat(40),
    HBECHO_PUBLIC_ORIGIN: "http://localhost:3000",
    HBECHO_SMS_MODE: "fake",
    HBECHO_SMS_DAILY_CAP: "100",
  });
});
afterEach(async () => {
  await rt.pool.end();
});

const post = (h: ReturnType<typeof createAuthRouteHandlers>, path: string, body: unknown) =>
  h.POST(new Request(`http://localhost:3000/api/auth${path}`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("createRuntime 的接线", () => {
  it("5 次密码失败后正确密码也被拒（登录锁定在运行时装配里生效）", async () => {
    // insertAccessUser 只用到 db / auth / clock 三样；运行时的 auth 就是被测对象
    await insertAccessUser({ t, auth: rt.auth, clock: { now: () => new Date() } } as never, { phone: "13800000001" });
    const h = createAuthRouteHandlers(() => rt.auth);
    for (let i = 0; i < 5; i++) expect((await post(h, "/sign-in/phone-number", { phoneNumber: "13800000001", password: "WrongPassw0rd!" })).status).toBe(401);
    expect((await post(h, "/sign-in/phone-number", { phoneNumber: "13800000001", password: PASSWORD })).status).toBe(401);
  });

  it("对不存在的号码请求验证码：成功样式但不发送、不写 verification（短信资格校验在运行时装配里生效）", async () => {
    const h = createAuthRouteHandlers(() => rt.auth);
    const r = await post(h, "/phone-number/send-otp", { phoneNumber: "13999999999" });
    expect(r.status).toBe(200);
    const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM auth_verifications");
    expect(Number((rows as Array<{ n: string }>)[0]!.n)).toBe(0);
    const [sms] = await t.pool.query("SELECT outcome FROM access_sms_sends");
    expect((sms as Array<{ outcome: string }>).map((x) => x.outcome)).toEqual(["suppressed"]);
  });
});
