import { describe, expect, it } from "vitest";
import { parseAccessConfig } from "./config";
import { createSender } from "./runtime";
import { FakeSmsSender } from "./sms";
import { AliyunSmsError, AliyunSmsSender, OPERATIONAL_ERROR_CODES, type AliyunSmsClient } from "./sms-aliyun";

const templates = { activate: "SMS_A", login: "SMS_L", reset: "SMS_R" } as const;

function fakeClient(code = "OK", bizId = "biz-1"): AliyunSmsClient & { calls: Array<Parameters<AliyunSmsClient["sendSms"]>[0]> } {
  const calls: Array<Parameters<AliyunSmsClient["sendSms"]>[0]> = [];
  return { calls, sendSms: async (r) => (calls.push(r), { body: { code, message: "msg", bizId } }) };
}

describe("AliyunSmsSender（注入假客户端，离线）", () => {
  it.each([
    ["activate", "SMS_A"],
    ["login", "SMS_L"],
    ["reset", "SMS_R"],
  ] as const)("用途 %s 使用对应模板 %s；变量名固定为 code；返回 bizId 作流水号", async (kind, tpl) => {
    const c = fakeClient();
    const r = await new AliyunSmsSender(c, { signName: "海贝", templates }).send({ phone: "13800000001", code: "123456", kind });
    expect(r).toEqual({ providerRef: "biz-1" });
    expect(c.calls).toEqual([{ phoneNumbers: "13800000001", signName: "海贝", templateCode: tpl, templateParam: '{"code":"123456"}' }]);
  });

  it("供应商返回非 OK → 抛 AliyunSmsError，错误信息只含供应商错误码，不含手机号与验证码", async () => {
    const s = new AliyunSmsSender(fakeClient("isv.BUSINESS_LIMIT_CONTROL"), { signName: "海贝", templates });
    const err = await s.send({ phone: "13800000001", code: "123456", kind: "login" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliyunSmsError);
    expect((err as Error).message).toContain("isv.BUSINESS_LIMIT_CONTROL");
    expect((err as Error).message).not.toContain("13800000001");
    expect((err as Error).message).not.toContain("123456");
  });

  it.each(["isv.AMOUNT_NOT_ENOUGH", "isv.OUT_OF_SERVICE", "isv.SMS_SIGNATURE_ILLEGAL", "isv.SMS_TEMPLATE_ILLEGAL", "isv.DAY_LIMIT_CONTROL", "isv.BUSINESS_LIMIT_CONTROL"])(
    "运维类错误 %s 标为 operational（余额 / 签名 / 模板 / 限额：整个平台发不出短信，应该告警）",
    async (code) => {
      const err = await new AliyunSmsSender(fakeClient(code), { signName: "海贝", templates }).send({ phone: "13800000001", code: "123456", kind: "login" }).catch((e: unknown) => e);
      expect((err as AliyunSmsError).operational).toBe(true);
      expect(OPERATIONAL_ERROR_CODES.has(code)).toBe(true);
    },
  );

  it("号码非法等单用户问题不是运维类错误", async () => {
    const err = await new AliyunSmsSender(fakeClient("isv.MOBILE_NUMBER_ILLEGAL"), { signName: "海贝", templates }).send({ phone: "13800000001", code: "123456", kind: "login" }).catch((e: unknown) => e);
    expect((err as AliyunSmsError).operational).toBe(false);
  });

  it("没有响应体也算失败", async () => {
    const s = new AliyunSmsSender({ sendSms: async () => ({}) }, { signName: "海贝", templates });
    await expect(s.send({ phone: "13800000001", code: "123456", kind: "login" })).rejects.toThrow("NO_RESPONSE");
  });
});

describe("createSender：按模式选择，不缺省为假发送器", () => {
  const base = { HBECHO_AUTH_SECRET: "x".repeat(32), HBECHO_PUBLIC_ORIGIN: "http://localhost:3000", HBECHO_SMS_DAILY_CAP: "10", HBECHO_TRUSTED_PROXIES: "127.0.0.1" };

  it("fake → 假发送器", () => {
    expect(createSender(parseAccessConfig({ ...base, HBECHO_SMS_MODE: "fake" }))).toBeInstanceOf(FakeSmsSender);
  });

  it("aliyun → 阿里云发送器（构造时不加载 SDK、不联网）", () => {
    const cfg = parseAccessConfig({
      ...base,
      HBECHO_SMS_MODE: "aliyun",
      HBECHO_SMS_ACCESS_KEY_ID: "id",
      HBECHO_SMS_ACCESS_KEY_SECRET: "secret",
      HBECHO_SMS_SIGN_NAME: "海贝",
      HBECHO_SMS_TEMPLATE_ACTIVATE: "a",
      HBECHO_SMS_TEMPLATE_LOGIN: "l",
      HBECHO_SMS_TEMPLATE_RESET: "r",
    });
    expect(createSender(cfg)).toBeInstanceOf(AliyunSmsSender);
  });

  it("生产缺发送器配置：parseAccessConfig 就启动失败（不会走到 createSender）", () => {
    expect(() => parseAccessConfig({ ...base, NODE_ENV: "production", HBECHO_PUBLIC_ORIGIN: "https://a.example.com", HBECHO_SMS_MODE: "aliyun" })).toThrow(/HBECHO_SMS_ACCESS_KEY_ID/);
    expect(() => parseAccessConfig({ ...base, NODE_ENV: "production", HBECHO_PUBLIC_ORIGIN: "https://a.example.com" })).toThrow(/HBECHO_SMS_MODE/);
    expect(() => parseAccessConfig({ ...base, NODE_ENV: "production", HBECHO_PUBLIC_ORIGIN: "https://a.example.com", HBECHO_SMS_MODE: "fake" })).toThrow(/HBECHO_SMS_MODE/);
  });
});
