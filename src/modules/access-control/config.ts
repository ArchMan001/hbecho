// 访问控制的运行时配置（design §7.8、AX-4）。全部来自环境变量，zod 解析，**没有缺省值**：缺项或不合法即启动失败。
// 错误信息只列键名，不回显值（密钥不进日志与回复）。
import { z } from "zod";

export class AccessConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`访问控制配置缺失或不合法：${keys.join(", ")}`);
    this.name = "AccessConfigError";
  }
}

export interface AccessConfig {
  /** better-auth 的签名密钥，≥ 32 字符。 */
  authSecret: string;
  /** 对外访问的 origin（含协议、不含路径）；生产必须是 https。 */
  publicOrigin: string;
  /** publicOrigin + HBECHO_TRUSTED_ORIGINS；Origin 不在其中的状态变更请求被拒。 */
  trustedOrigins: readonly string[];
  /** 'fake' 只允许在非生产使用；生产必须显式 'aliyun'，不缺省为假发送器。 */
  smsMode: "fake" | "aliyun";
  /** 每日全局短信上限（I 域配置落地前的环境变量）。 */
  smsDailyCap: number;
  /**
   * 受信反向代理的 IP / CIDR（Nginx 所在地址）。库只在这些代理之后取客户端 IP 做限流：
   * 取不到可信 IP 时所有请求落进同一个 per-path 共享桶（一个人刷满，所有人一起 429）。生产必填；
   * 运行手册要求 Nginx 用 `proxy_set_header X-Forwarded-For $remote_addr;` 覆盖客户端自带的头。
   */
  trustedProxies: readonly string[];
  /**
   * 每个 IP 每条认证路径每分钟的请求上限（登录 / 发码 / 校验 / 重置 / 改密）；全局默认规则为其 2 倍，同样是每 IP 每路径。
   * 缺省：生产 300、非生产 60（2026-11-10 刘学奎确认）。公司出口 NAT 后上班高峰多人同时登录，生产放宽；
   * 真正挡暴力破解的是「按手机号锁定 5 次 / 15 分钟」，不是这个限流。
   */
  authRateLimitPerMin: number;
  /** 仅 smsMode='aliyun' 时存在。 */
  aliyun?: {
    accessKeyId: string;
    accessKeySecret: string;
    signName: string;
    templates: { activate: string; login: string; reset: string };
  };
  production: boolean;
}

const origin = z
  .string()
  .url()
  .refine((s) => /^https?:\/\//.test(s) && new URL(s).pathname === "/" && !s.endsWith("//"), "必须是 origin（不含路径）")
  .transform((s) => new URL(s).origin);

const schema = z.object({
  HBECHO_AUTH_SECRET: z.string().min(32),
  HBECHO_PUBLIC_ORIGIN: origin,
  HBECHO_TRUSTED_ORIGINS: z.string().optional(),
  HBECHO_SMS_MODE: z.enum(["fake", "aliyun"]),
  HBECHO_SMS_DAILY_CAP: z.string().regex(/^[1-9]\d{0,6}$/),
  HBECHO_TRUSTED_PROXIES: z.string().optional(),
  HBECHO_AUTH_RATE_LIMIT_PER_MIN: z.string().regex(/^[1-9]\d{0,5}$/).optional(),
});

// 仅 HBECHO_SMS_MODE=aliyun 时必填：阿里云短信的凭证、签名与三个用途的模板编码
const aliyunSchema = z.object({
  HBECHO_SMS_ACCESS_KEY_ID: z.string().min(1),
  HBECHO_SMS_ACCESS_KEY_SECRET: z.string().min(1),
  HBECHO_SMS_SIGN_NAME: z.string().min(1),
  HBECHO_SMS_TEMPLATE_ACTIVATE: z.string().min(1),
  HBECHO_SMS_TEMPLATE_LOGIN: z.string().min(1),
  HBECHO_SMS_TEMPLATE_RESET: z.string().min(1),
});

/** IPv4 / IPv6 地址或 CIDR；细校验交给库（无效项它会忽略并告警），这里只挡明显的写错。 */
const isIpOrCidr = (v: string): boolean => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(v) && (v.includes(".") || v.includes(":"));

export function parseAccessConfig(env: Record<string, string | undefined>): AccessConfig {
  const production = env.NODE_ENV === "production";
  const parsed = schema.safeParse(env);
  const bad = new Set<string>();
  if (!parsed.success) for (const i of parsed.error.issues) bad.add(String(i.path[0]));
  if (parsed.success) {
    const c = parsed.data;
    if (production && c.HBECHO_SMS_MODE === "fake") bad.add("HBECHO_SMS_MODE");
    if (production && !c.HBECHO_PUBLIC_ORIGIN.startsWith("https://")) bad.add("HBECHO_PUBLIC_ORIGIN");
  }
  const extra: string[] = [];
  if (parsed.success && parsed.data.HBECHO_TRUSTED_ORIGINS) {
    for (const raw of parsed.data.HBECHO_TRUSTED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)) {
      const o = origin.safeParse(raw);
      if (o.success) extra.push(o.data);
      else bad.add("HBECHO_TRUSTED_ORIGINS");
    }
  }
  const proxies = (parsed.success ? (parsed.data.HBECHO_TRUSTED_PROXIES ?? "") : "").split(",").map((x) => x.trim()).filter(Boolean);
  if (parsed.success && production && proxies.length === 0) bad.add("HBECHO_TRUSTED_PROXIES");
  if (!proxies.every(isIpOrCidr)) bad.add("HBECHO_TRUSTED_PROXIES");
  let aliyun: AccessConfig["aliyun"];
  if (parsed.success && parsed.data.HBECHO_SMS_MODE === "aliyun") {
    const a = aliyunSchema.safeParse(env);
    if (!a.success) for (const i of a.error.issues) bad.add(String(i.path[0]));
    else {
      aliyun = {
        accessKeyId: a.data.HBECHO_SMS_ACCESS_KEY_ID,
        accessKeySecret: a.data.HBECHO_SMS_ACCESS_KEY_SECRET,
        signName: a.data.HBECHO_SMS_SIGN_NAME,
        templates: { activate: a.data.HBECHO_SMS_TEMPLATE_ACTIVATE, login: a.data.HBECHO_SMS_TEMPLATE_LOGIN, reset: a.data.HBECHO_SMS_TEMPLATE_RESET },
      };
    }
  }
  if (bad.size > 0 || !parsed.success) throw new AccessConfigError([...bad]);
  const c = parsed.data;
  return {
    authSecret: c.HBECHO_AUTH_SECRET,
    publicOrigin: c.HBECHO_PUBLIC_ORIGIN,
    trustedOrigins: [...new Set([c.HBECHO_PUBLIC_ORIGIN, ...extra])],
    smsMode: c.HBECHO_SMS_MODE,
    smsDailyCap: Number(c.HBECHO_SMS_DAILY_CAP),
    trustedProxies: proxies,
    authRateLimitPerMin: Number(c.HBECHO_AUTH_RATE_LIMIT_PER_MIN ?? (production ? "300" : "60")),
    ...(aliyun ? { aliyun } : {}),
    production,
  };
}
