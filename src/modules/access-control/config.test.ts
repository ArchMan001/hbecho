import { describe, expect, it } from "vitest";
import { AccessConfigError, parseAccessConfig } from "./config";

const ok = {
  HBECHO_AUTH_SECRET: "x".repeat(32),
  HBECHO_PUBLIC_ORIGIN: "http://localhost:3000",
  HBECHO_SMS_MODE: "fake",
  HBECHO_SMS_DAILY_CAP: "500",
};

const keysOf = (env: Record<string, string | undefined>): string[] => {
  try {
    parseAccessConfig(env);
  } catch (e) {
    if (e instanceof AccessConfigError) return [...e.keys].sort();
    throw e;
  }
  return [];
};

describe("parseAccessConfig", () => {
  it("合法配置：trustedOrigins 含 publicOrigin 并去重，origin 去掉末尾斜杠", () => {
    const c = parseAccessConfig({ ...ok, HBECHO_PUBLIC_ORIGIN: "http://localhost:3000/", HBECHO_TRUSTED_ORIGINS: "http://localhost:3000, https://a.example.com" });
    expect(c.publicOrigin).toBe("http://localhost:3000");
    expect(c.trustedOrigins).toEqual(["http://localhost:3000", "https://a.example.com"]);
    expect(c.smsDailyCap).toBe(500);
    expect(c.production).toBe(false);
  });

  it.each(["HBECHO_AUTH_SECRET", "HBECHO_PUBLIC_ORIGIN", "HBECHO_SMS_MODE", "HBECHO_SMS_DAILY_CAP"])("缺少 %s 启动失败，只报键名", (key) => {
    const env: Record<string, string | undefined> = { ...ok };
    delete env[key];
    expect(keysOf(env)).toEqual([key]);
  });

  it("没有缺省值：全空时四项都报", () => {
    expect(keysOf({})).toEqual(["HBECHO_AUTH_SECRET", "HBECHO_PUBLIC_ORIGIN", "HBECHO_SMS_DAILY_CAP", "HBECHO_SMS_MODE"]);
  });

  it("密钥短于 32 字符、上限不是正整数、模式不是 fake / aliyun、origin 带路径都被拒", () => {
    expect(keysOf({ ...ok, HBECHO_AUTH_SECRET: "short" })).toEqual(["HBECHO_AUTH_SECRET"]);
    expect(keysOf({ ...ok, HBECHO_SMS_DAILY_CAP: "0" })).toEqual(["HBECHO_SMS_DAILY_CAP"]);
    expect(keysOf({ ...ok, HBECHO_SMS_DAILY_CAP: "-5" })).toEqual(["HBECHO_SMS_DAILY_CAP"]);
    expect(keysOf({ ...ok, HBECHO_SMS_MODE: "mock" })).toEqual(["HBECHO_SMS_MODE"]);
    expect(keysOf({ ...ok, HBECHO_PUBLIC_ORIGIN: "http://localhost:3000/app" })).toEqual(["HBECHO_PUBLIC_ORIGIN"]);
    expect(keysOf({ ...ok, HBECHO_TRUSTED_ORIGINS: "not a url" })).toEqual(["HBECHO_TRUSTED_ORIGINS"]);
  });

  it("生产：不允许假发送器，origin 必须是 https", () => {
    const prod = { ...ok, NODE_ENV: "production" };
    expect(keysOf(prod)).toEqual(["HBECHO_PUBLIC_ORIGIN", "HBECHO_SMS_MODE", "HBECHO_TRUSTED_PROXIES"]);
    const aliyunKeys = {
      HBECHO_SMS_ACCESS_KEY_ID: "id",
      HBECHO_SMS_ACCESS_KEY_SECRET: "secret",
      HBECHO_SMS_SIGN_NAME: "签名",
      HBECHO_SMS_TEMPLATE_ACTIVATE: "a",
      HBECHO_SMS_TEMPLATE_LOGIN: "l",
      HBECHO_SMS_TEMPLATE_RESET: "r",
    };
    const good = { ...prod, ...aliyunKeys, HBECHO_SMS_MODE: "aliyun", HBECHO_PUBLIC_ORIGIN: "https://hbecho.example.com", HBECHO_TRUSTED_PROXIES: "127.0.0.1" };
    expect(keysOf(good)).toEqual([]);
    // 生产必须配置受信代理：取不到可信 IP 时所有请求落进同一个共享限流桶
    const { HBECHO_TRUSTED_PROXIES: _omit, ...noProxy } = good;
    expect(keysOf(noProxy)).toEqual(["HBECHO_TRUSTED_PROXIES"]);
  });

  it("aliyun 模式要求凭证、签名与三个模板；fake 模式不要求也不读取这些键", () => {
    const aliyun = { ...ok, HBECHO_SMS_MODE: "aliyun" };
    expect(keysOf(aliyun)).toEqual([
      "HBECHO_SMS_ACCESS_KEY_ID",
      "HBECHO_SMS_ACCESS_KEY_SECRET",
      "HBECHO_SMS_SIGN_NAME",
      "HBECHO_SMS_TEMPLATE_ACTIVATE",
      "HBECHO_SMS_TEMPLATE_LOGIN",
      "HBECHO_SMS_TEMPLATE_RESET",
    ]);
    const full = {
      ...aliyun,
      HBECHO_SMS_ACCESS_KEY_ID: "id",
      HBECHO_SMS_ACCESS_KEY_SECRET: "secret",
      HBECHO_SMS_SIGN_NAME: "签名",
      HBECHO_SMS_TEMPLATE_ACTIVATE: "SMS_1",
      HBECHO_SMS_TEMPLATE_LOGIN: "SMS_2",
      HBECHO_SMS_TEMPLATE_RESET: "SMS_3",
    };
    expect(parseAccessConfig(full).aliyun).toEqual({ accessKeyId: "id", accessKeySecret: "secret", signName: "签名", templates: { activate: "SMS_1", login: "SMS_2", reset: "SMS_3" } });
    expect(parseAccessConfig(ok).aliyun).toBeUndefined();
    expect(keysOf({ ...ok, HBECHO_SMS_TEMPLATE_LOGIN: "SMS_2" })).toEqual([]);
  });

  it("受信代理接受 IP 与 CIDR，写错的项启动失败；非生产可不配；限流阈值默认 60、可配置、必须是正整数", () => {
    expect(parseAccessConfig({ ...ok, HBECHO_TRUSTED_PROXIES: "127.0.0.1, 10.0.0.0/8, ::1" }).trustedProxies).toEqual(["127.0.0.1", "10.0.0.0/8", "::1"]);
    expect(parseAccessConfig(ok).trustedProxies).toEqual([]);
    expect(keysOf({ ...ok, HBECHO_TRUSTED_PROXIES: "nginx" })).toEqual(["HBECHO_TRUSTED_PROXIES"]);
    expect(parseAccessConfig(ok).authRateLimitPerMin).toBe(60); // 非生产缺省 60
    const prodBase = { ...ok, NODE_ENV: "production", HBECHO_PUBLIC_ORIGIN: "https://a.example.com", HBECHO_SMS_MODE: "aliyun", HBECHO_TRUSTED_PROXIES: "127.0.0.1",
      HBECHO_SMS_ACCESS_KEY_ID: "i", HBECHO_SMS_ACCESS_KEY_SECRET: "s", HBECHO_SMS_SIGN_NAME: "n", HBECHO_SMS_TEMPLATE_ACTIVATE: "a", HBECHO_SMS_TEMPLATE_LOGIN: "l", HBECHO_SMS_TEMPLATE_RESET: "r" };
    expect(parseAccessConfig(prodBase).authRateLimitPerMin).toBe(300); // 生产缺省 300
    expect(parseAccessConfig({ ...prodBase, HBECHO_AUTH_RATE_LIMIT_PER_MIN: "100" }).authRateLimitPerMin).toBe(100); // 显式配置优先
    expect(parseAccessConfig({ ...ok, HBECHO_AUTH_RATE_LIMIT_PER_MIN: "300" }).authRateLimitPerMin).toBe(300);
    expect(keysOf({ ...ok, HBECHO_AUTH_RATE_LIMIT_PER_MIN: "0" })).toEqual(["HBECHO_AUTH_RATE_LIMIT_PER_MIN"]);
  });

  it("错误信息不含任何值（密钥不进日志）", () => {
    try {
      parseAccessConfig({ ...ok, HBECHO_AUTH_SECRET: "super-secret-but-short" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret");
      expect((e as Error).message).toContain("HBECHO_AUTH_SECRET");
    }
  });
});
