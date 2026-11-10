// better-auth 实例装配（design §6、ADR-0015）。这里只装配「库」和「必须在库外补的几处」，不含业务规则：
//   - 登录锁定、短信资格 / 限频、激活后置 active 由 AuthFlow（login-guard / sms / activation）注入，见任务 5；
//   - 每一项配置都对应 ADR-0015 的一条实测结论，改动前先看 __spike__ 的回归用例。
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { phoneNumber } from "better-auth/plugins";
import type { Db } from "../../db/client";
import { authAccounts, authSessions, authUsers, authVerifications } from "../../db/schema/auth";
import { isCanonicalPhone, normalizePhone } from "../phone";
import type { AccessConfig } from "./config";

/** 15 天滑动，每个自然日至多刷新一次（B-D13、S5）。 */
export const SESSION_EXPIRES_IN_SECONDS = 15 * 24 * 3600;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 3600;
/** 验证码有效期 5 分钟、6 位、连续输错 5 次作废（B-D15，S3）。 */
export const OTP_EXPIRES_IN_SECONDS = 300;
export const OTP_LENGTH = 6;
export const OTP_ALLOWED_ATTEMPTS = 5;
export const BASE_PATH = "/api/auth";

/** 库的端点里带 `phoneNumber` 的几条；统一在 before 钩子里校验格式（ADR-0015 缺口 1）。 */
export const PHONE_PATHS = new Set([
  "/sign-in/phone-number",
  "/phone-number/send-otp",
  "/phone-number/verify",
  "/phone-number/request-password-reset",
  "/phone-number/reset-password",
]);

/** 短信验证码的发送回调（明文码只在这里出现一次，不进日志与审计）。 */
export interface CodeDelivery {
  deliver(msg: { phone: string; code: string; kind: "otp" | "reset" }): Promise<void>;
}

export interface FlowBeforeInput {
  path: string;
  /** 已规范化手机号的请求体（PHONE_PATHS 内的端点）。 */
  body: Record<string, unknown>;
  headers: Headers | undefined;
}

/** 返回 `{ respond }` 则不执行库的端点，直接把该值作为 200 JSON 响应（成功样式的「已抑制」）；抛 APIError 则拒绝。 */
export type FlowBeforeResult = void | { respond: Record<string, unknown> };

export interface AuthFlow {
  before?(input: FlowBeforeInput): Promise<FlowBeforeResult>;
  after?(input: FlowBeforeInput & { error: APIError | null; sessionUserId?: string }): Promise<void>;
}

export interface AuthInstanceDeps {
  db: Db;
  config: AccessConfig;
  delivery: CodeDelivery;
  flow?: AuthFlow;
}

const invalidPhone = () => new APIError("BAD_REQUEST", { message: "invalid phone number", code: "INVALID_PHONE_NUMBER" });

export function createAuth(deps: AuthInstanceDeps) {
  const { config, flow } = deps;
  return betterAuth({
    baseURL: config.publicOrigin,
    basePath: BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [...config.trustedOrigins],
    telemetry: { enabled: false },
    database: drizzleAdapter(deps.db, {
      provider: "mysql",
      // 改了 modelName 之后，适配器按「新模型名」在 schema 对象里找表（S2）
      schema: {
        auth_users: authUsers,
        auth_sessions: authSessions,
        auth_accounts: authAccounts,
        auth_verifications: authVerifications,
      },
    }),
    user: { modelName: "auth_users" },
    account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    session: {
      modelName: "auth_sessions",
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // 不启用 cookie 缓存：每次请求读会话与用户状态，「停用后现有会话全部失效」即时生效（AX-1、AX-D20）
      cookieCache: { enabled: false },
    },
    advanced: {
      // 库在 NODE_ENV=test 时默认关闭来源 / CSRF 检查（S8）：必须显式 false，测试与生产同一份配置
      disableOriginCheck: false,
      // 认证表 ID 只能由数据库自增：不设 AUTO_INCREMENT 起点，不写指定 ID（S1 天花板 2^53−1）
      database: { generateId: "serial" },
      // 只信任这些代理转发的客户端 IP；否则所有人落进同一个共享限流桶（见 config.ts）
      ...(config.trustedProxies.length ? { ipAddress: { trustedProxies: [...config.trustedProxies] } } : {}),
    },
    // 不启用邮箱注册 / 登录（没有公开注册，PRD §12）。min/max 与 revoke 仍被手机号重置密码路径读取（S3）
    emailAndPassword: { enabled: false, minPasswordLength: 8, revokeSessionsOnPasswordReset: true },
    rateLimit: {
      enabled: true,
      window: 60,
      // 阈值来自配置（HBECHO_AUTH_RATE_LIMIT_PER_MIN），不在代码里静默冻结；都是「每个 IP 每条路径」，不是全局
      max: config.authRateLimitPerMin * 2,
      // 手机号插件自带 /phone-number* 每 60 秒 10 次，公司出口 NAT 后多人同时激活会被误伤（S9）
      customRules: Object.fromEntries(
        ["/sign-in/phone-number", "/phone-number/send-otp", "/phone-number/verify", "/phone-number/request-password-reset", "/phone-number/reset-password"].map((p) => [
          p,
          { window: 60, max: config.authRateLimitPerMin },
        ]),
      ),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const path = ctx.path;
        // 改密必须撤销其他会话、保留当前（AX-1，已知坑 3）：不让调用方选择不撤销
        if (path === "/change-password") {
          return { context: { ...ctx, body: { ...((ctx.body ?? {}) as Record<string, unknown>), revokeOtherSessions: true } } };
        }
        if (!PHONE_PATHS.has(path)) return;
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        // 缺口 1：库自带校验器只覆盖 sign-in 与 send-otp，墓碑值能走到其余三条路径；这里统一校验并规范化
        const raw = body.phoneNumber;
        const phone = typeof raw === "string" ? normalizePhone(raw) : null;
        if (phone === null) throw invalidPhone();
        // 缺口 2：库默认允许已登录用户凭新号码的验证码改号；手机号变更只做删旧建新
        if (path === "/phone-number/verify" && body.updatePhoneNumber) {
          throw new APIError("FORBIDDEN", { message: "phone number change is not allowed", code: "PHONE_CHANGE_NOT_ALLOWED" });
        }
        const normalized = { ...body, phoneNumber: phone };
        if (flow?.before) {
          const r = await flow.before({ path, body: normalized, headers: ctx.headers });
          if (r && "respond" in r) return ctx.json(r.respond);
        }
        return { context: { ...ctx, body: normalized } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!flow?.after || !(PHONE_PATHS.has(ctx.path) || ctx.path === "/change-password")) return;
        const returned = ctx.context.returned;
        const sessionUserId = (ctx.context.session as { user?: { id?: string } } | null | undefined)?.user?.id;
        await flow.after({
          path: ctx.path,
          body: (ctx.body ?? {}) as Record<string, unknown>,
          headers: ctx.headers,
          error: returned instanceof APIError ? returned : null,
          ...(sessionUserId ? { sessionUserId } : {}),
        });
      }),
    },
    plugins: [
      phoneNumber({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_EXPIRES_IN_SECONDS,
        allowedAttempts: OTP_ALLOWED_ATTEMPTS,
        // 与上面的统一校验同义；留着作为第二道（库自己的两个端点会再调用一次）
        phoneNumberValidator: (p: string) => isCanonicalPhone(p),
        sendOTP: ({ phoneNumber: phone, code }) => deps.delivery.deliver({ phone, code, kind: "otp" }),
        sendPasswordResetOTP: ({ phoneNumber: phone, code }) => deps.delivery.deliver({ phone, code, kind: "reset" }),
      }),
    ],
  });
}

export type AccessAuth = ReturnType<typeof createAuth>;
