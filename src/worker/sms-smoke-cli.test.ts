import { describe, expect, it } from "vitest";
import { MAX_SMOKE_COUNT, planSmoke, runSmsSmoke } from "./sms-smoke-cli";
import type { SmsMessage, SmsSender } from "../modules/access-control/sms";

const aliyunEnv: Record<string, string> = {
  HBECHO_SMS_SMOKE: "1",
  HBECHO_AUTH_SECRET: "x".repeat(40),
  HBECHO_PUBLIC_ORIGIN: "http://localhost:3000",
  HBECHO_SMS_MODE: "aliyun",
  HBECHO_SMS_DAILY_CAP: "10",
  HBECHO_SMS_ACCESS_KEY_ID: "id",
  HBECHO_SMS_ACCESS_KEY_SECRET: "secret",
  HBECHO_SMS_SIGN_NAME: "青岛海信博世",
  HBECHO_SMS_TEMPLATE_ACTIVATE: "SMS_512035897",
  HBECHO_SMS_TEMPLATE_LOGIN: "SMS_512115917",
  HBECHO_SMS_TEMPLATE_RESET: "SMS_512090911",
};
const good = ["--phone", "13800000001", "--kind", "login", "--confirm-real-send"];

class RecordingSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  fail: ((n: number) => Error | null) | null = null;
  private calls = 0; // 第几次调用（失败的调用不会进 sent，所以不能用 sent.length 推算）
  async send(m: SmsMessage): Promise<{ providerRef?: string }> {
    this.calls += 1;
    const err = this.fail?.(this.calls);
    if (err) throw err;
    this.sent.push(m);
    return { providerRef: `biz-${this.sent.length}` };
  }
}
const run = async (argv: string[], env: Record<string, string | undefined> = aliyunEnv, sender = new RecordingSender()) => {
  const out: string[] = [];
  const err: string[] = [];
  let built = 0;
  const code = await runSmsSmoke(argv, env, {
    makeSender: () => {
      built += 1;
      return sender;
    },
    now: () => new Date("2026-11-10T03:00:00.000Z"),
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    sleep: async () => {},
  });
  return { code, out: out.join(""), err: err.join(""), sender, built };
};

describe("sms-smoke：每条拒绝路径都不发送、不构造发送器（退出码 2）", () => {
  it.each([
    ["缺 --confirm-real-send", ["--phone", "13800000001", "--kind", "login"], aliyunEnv, "not_confirmed"],
    ["缺环境变量开关 HBECHO_SMS_SMOKE=1", good, { ...aliyunEnv, HBECHO_SMS_SMOKE: undefined }, "switch_off"],
    ["开关不是 1", good, { ...aliyunEnv, HBECHO_SMS_SMOKE: "true" }, "switch_off"],
    ["手机号非法", ["--phone", "12345", "--kind", "login", "--confirm-real-send"], aliyunEnv, "bad_phone"],
    ["缺手机号", ["--kind", "login", "--confirm-real-send"], aliyunEnv, "bad_phone"],
    ["用途非法", ["--phone", "13800000001", "--kind", "spam", "--confirm-real-send"], aliyunEnv, "bad_kind"],
    ["条数 0", [...good, "--count", "0"], aliyunEnv, "bad_count"],
    [`条数超过上限 ${MAX_SMOKE_COUNT}`, [...good, "--count", String(MAX_SMOKE_COUNT + 1)], aliyunEnv, "bad_count"],
    ["条数不是数字", [...good, "--count", "abc"], aliyunEnv, "bad_count"],
    ["不是 aliyun 模式（假发送器）", good, { ...aliyunEnv, HBECHO_SMS_MODE: "fake" }, "not_aliyun"],
    ["阿里云配置缺项", good, { ...aliyunEnv, HBECHO_SMS_SIGN_NAME: undefined }, "config"],
    ["未知参数", [...good, "--bcc", "13900000000"], aliyunEnv, "usage"],
  ] as const)("%s", async (_name, argv, env, reason) => {
    const r = await run([...argv], env as Record<string, string | undefined>);
    expect(r.code).toBe(2);
    expect(r.sender.sent).toHaveLength(0);
    expect(r.built).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: false, sent: 0, reason });
  });

  it("不能一次发给多个号码", () => {
    const p = planSmoke(["--phone", "13800000001,13900000002", "--kind", "login", "--confirm-real-send"], aliyunEnv);
    expect(p).toMatchObject({ ok: false, code: "bad_phone" });
  });

  it("配置缺项的提示只报键名，不含任何值", async () => {
    const r = await run(good, { ...aliyunEnv, HBECHO_SMS_SIGN_NAME: undefined });
    expect(r.err).toContain("HBECHO_SMS_SIGN_NAME");
    expect(r.err).not.toContain("secret");
  });
});

describe("sms-smoke：门槛都通过时才发送", () => {
  it("默认发 1 条；+86 与分隔符写法的手机号被规范化后再发；验证码是 6 位数字", async () => {
    const r = await run(["--phone", "+86 138-0000-0001", "--kind", "reset", "--confirm-real-send"]);
    expect(r.code).toBe(0);
    expect(r.sender.sent).toHaveLength(1);
    expect(r.sender.sent[0]).toMatchObject({ phone: "13800000001", kind: "reset" });
    expect(r.sender.sent[0]!.code).toMatch(/^\d{6}$/);
  });

  it("输出只有审计摘要：不含验证码，不含任何密钥或签名之外的配置值", async () => {
    const r = await run([...good, "--count", "2"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { ok: boolean; sent: number; summary: { phone: string; kind: string; requested: number; results: Array<{ providerRef?: string }> } };
    expect(j).toMatchObject({ ok: true, sent: 2, summary: { phone: "13800000001", kind: "login", requested: 2 } });
    expect(j.summary.results.map((x) => x.providerRef)).toEqual(["biz-1", "biz-2"]);
    for (const m of r.sender.sent) expect(r.out).not.toContain(m.code);
    for (const secret of ["secret", "SMS_512115917", "x".repeat(40)]) expect(r.out).not.toContain(secret);
    expect(r.err).toBe("");
  });

  it("每条验证码各不相同地随机生成（不是固定值）", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await run(good)).sender.sent[0]!.code);
    expect(codes.size).toBeGreaterThan(10);
  });

  it("发送失败：退出码 3，只报供应商错误码与 operational 标记，不报原文", async () => {
    const sender = new RecordingSender();
    sender.fail = () => Object.assign(new Error("请求细节 13800000001"), { providerCode: "isv.AMOUNT_NOT_ENOUGH", operational: true });
    const r = await run(good, aliyunEnv, sender);
    expect(r.code).toBe(3);
    const j = JSON.parse(r.out) as { ok: boolean; sent: number; summary: { results: unknown[] } };
    expect(j).toMatchObject({ ok: false, sent: 0 });
    expect(j.summary.results).toEqual([{ n: 1, ok: false, error: "isv.AMOUNT_NOT_ENOUGH", operational: true }]);
    expect(r.out).not.toContain("请求细节");
  });

  it("多条里部分失败：成功的照记，退出码 3", async () => {
    const sender = new RecordingSender();
    sender.fail = (n) => (n === 2 ? new Error("boom") : null);
    const r = await run([...good, "--count", "3"], aliyunEnv, sender);
    expect(r.code).toBe(3);
    expect((JSON.parse(r.out) as { sent: number }).sent).toBe(2);
  });
});
