// 任务 1 的验证挂具（design §6.5 S1–S9，ADR-0015），任务 2 起改用真实 schema（src/db/schema/auth.ts）。
// 这些验证用例保留为回归测试：better-auth 升级时重跑，防止库悄悄改行为。
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { authAccounts, authSessions, authUsers, authVerifications } from "../../../db/schema/auth";

/** 清空认证相关表并重置自增（TRUNCATE 需要同一连接上关闭外键检查）。 */
export async function resetAuthTables(pool: Pool): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of ["access_user_brands", "access_user_branches", "access_users", "auth_sessions", "auth_accounts", "auth_verifications", "auth_users"]) {
      await conn.query(`TRUNCATE TABLE \`${t}\``);
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
}

export interface SentSms {
  kind: "otp" | "reset";
  phone: string;
  code: string;
}

export interface SpikeOptions {
  sent?: SentSms[];
  /** 覆盖 session 配置（S5）。 */
  session?: { expiresIn?: number; updateAge?: number; cookieCache?: boolean };
  rateLimit?: BetterAuthOptions["rateLimit"];
  hooks?: BetterAuthOptions["hooks"];
  advanced?: BetterAuthOptions["advanced"];
  allowedAttempts?: number;
  /** 合成邮箱（S7）。 */
  signUpOnVerification?: boolean;
}

/** 建一个用户（授权表不在本验证范围）。withPassword=false 模拟「待激活：无凭据」。 */
export async function seedUser(
  auth: ReturnType<typeof createSpikeAuth>["auth"],
  p: { phone: string; password?: string; email?: string; name?: string; phoneVerified?: boolean },
) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({
    name: p.name ?? "测试用户",
    email: p.email ?? `${randomUUID()}@hbecho.invalid`,
    emailVerified: false,
    phoneNumber: p.phone,
    phoneNumberVerified: p.phoneVerified ?? true,
  } as never, { method: "phone-number" });
  if (p.password) {
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await ctx.password.hash(p.password),
    });
  }
  return user;
}

export function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export function createSpikeAuth(pool: Pool, opts: SpikeOptions = {}) {
  const sent = opts.sent ?? [];
  const db = drizzle(pool, { mode: "default" });
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "spike-secret-spike-secret-spike-secret-0123456789",
    database: drizzleAdapter(db, {
      provider: "mysql",
      // 改了 modelName 之后，适配器按「新模型名」在 schema 对象里找表
      schema: {
        auth_users: authUsers,
        auth_sessions: authSessions,
        auth_accounts: authAccounts,
        auth_verifications: authVerifications,
      },
    }),
    user: { modelName: "auth_users" },
    session: {
      modelName: "auth_sessions",
      expiresIn: opts.session?.expiresIn ?? 15 * 24 * 3600,
      updateAge: opts.session?.updateAge ?? 24 * 3600,
      cookieCache: { enabled: opts.session?.cookieCache ?? false },
    },
    account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    // better-auth 在 NODE_ENV=test 时默认关闭来源 / CSRF 检查（create-context.mjs: isTest() ? true）。
    // 测试里必须显式 false，才是生产行为；任务 2 的认证实例也要显式写 false，不能依赖默认值。
    advanced: { disableOriginCheck: false, ...opts.advanced, database: { generateId: "serial" } },
    trustedOrigins: ["http://localhost:3000"],
    // 与生产一致：不开邮箱注册 / 登录（没有公开注册）。min/max 与 revoke 仍被手机号重置密码路径读取
    emailAndPassword: { enabled: false, minPasswordLength: 8, revokeSessionsOnPasswordReset: true },
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    rateLimit: opts.rateLimit ?? { enabled: false },
    plugins: [
      phoneNumber({
        otpLength: 6,
        expiresIn: 300,
        // 与产品的 cn-mobile.v1 同义：墓碑值与任何非手机号格式在登录 / 发码端点就被拒绝（S6）
        phoneNumberValidator: (p: string) => /^1[3-9]\d{9}$/.test(p),
        allowedAttempts: opts.allowedAttempts ?? 5,
        sendOTP: ({ phoneNumber: p, code }) => {
          sent.push({ kind: "otp", phone: p, code });
        },
        sendPasswordResetOTP: ({ phoneNumber: p, code }) => {
          sent.push({ kind: "reset", phone: p, code });
        },
        ...(opts.signUpOnVerification
          ? { signUpOnVerification: { getTempEmail: (p: string) => `${p}@hbecho.invalid` } }
          : {}),
      }),
    ],
  });
  return { auth, db, sent };
}
