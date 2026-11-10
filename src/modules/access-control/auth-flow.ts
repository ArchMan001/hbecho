// 把登录锁定、短信规则、激活 / 重置 / 改密的业务后果接到 better-auth 的钩子上（ADR-0015 库外要补的第 3、4、5 处，AX-1、AX-2、AX-4）。
// 钩子只做「在库的端点前后插入我们的逻辑」，不复制库的密码 / 验证码校验。
import { and, eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import type { Db } from "../../db/client";
import { accessUsers } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import type { AuditWriter } from "./audit";
import type { AuthFlow, CodeDelivery } from "./auth-instance";
import { MAX_FAILURES, type LoginGuard } from "./login-guard";
import { SmsSendError, type SmsService } from "./sms";

// 与库对「手机号或密码错误」「验证码错误」的响应逐字一致：锁定、待激活、不存在、停用都不暴露差别
// 键顺序也要与库一致（库是 message 在前、code 在后）：响应体按字节比较时不能有差别
const invalidCredentials = () => new APIError("UNAUTHORIZED", { message: "Invalid phone number or password", code: "INVALID_PHONE_NUMBER_OR_PASSWORD" });
const invalidOtp = () => new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" });

export interface AuthFlowDeps {
  db: Db;
  clock: Clock;
  guard: LoginGuard;
  sms: SmsService;
  audit: AuditWriter;
}

const phoneOf = (body: Record<string, unknown>): string => String(body.phoneNumber);

export function createAuthFlow(deps: AuthFlowDeps): AuthFlow {
  const { db, guard, sms, audit } = deps;

  const userByPhone = async (phone: string) => {
    const [u] = await db
      .select({ userId: accessUsers.userId, status: accessUsers.status })
      .from(accessUsers)
      .where(and(eq(accessUsers.activePhone, phone)))
      .limit(1);
    return u ?? null;
  };
  const lowAudit = (phone: string, eventType: string, outcome: "succeeded" | "denied" | "failed", reasonCode: string, userId?: bigint | null, detail?: Record<string, unknown>) =>
    audit.write(
      {
        actor: userId ? `user:${userId}` : "service:anonymous",
        actorUserId: userId ?? null,
        eventType,
        outcome,
        reasonCode,
        targetType: "user",
        ...(userId ? { targetId: userId.toString() } : {}),
        // 手机号按明文记录（D-42）；密码与验证码永不记录
        detail: { phone, ...detail },
      },
      { risk: "low" },
    );

  return {
    async before({ path, body }) {
      const phone = phoneOf(body);
      switch (path) {
        case "/sign-in/phone-number": {
          // 锁定期间正确密码也不放行；不校验密码，响应与密码错误同形
          if ((await guard.check(phone)).locked) throw invalidCredentials();
          // 只有有效用户能密码登录。库只认「有凭据」，不看我们的状态：激活事务失败会留下「有密码但仍待激活」的用户，
          // 这里在结构上关闭它。被拒的尝试同样计一次失败（after 钩子不会运行），使它与其他失败在外部不可区分
          const u = await userByPhone(phone);
          if (u && u.status !== "active") {
            await guard.fail(phone);
            throw invalidCredentials();
          }
          return;
        }
        case "/phone-number/send-otp":
        case "/phone-number/request-password-reset": {
          const a = await sms.admit(phone, path === "/phone-number/send-otp" ? "login" : "reset");
          if (a.kind === "proceed") return;
          if (a.kind === "suppressed") {
            // 号码不是「待激活或有效」用户：响应与成功一致，实际不发送，不写 verification
            return { respond: path === "/phone-number/send-otp" ? { message: "code sent" } : { status: true } };
          }
          if (a.kind === "rate_limited") throw new APIError("TOO_MANY_REQUESTS", { code: "SMS_RATE_LIMITED", message: "请稍后再试" });
          throw new APIError("SERVICE_UNAVAILABLE", { code: "SMS_UNAVAILABLE", message: "短信服务暂不可用" });
        }
        case "/phone-number/verify": {
          // 验证码登录只给有效用户；待激活用户只能走「验证码重置密码」路径激活（ADR-0015 第 4 处）。响应与验证码错误一致
          const u = await userByPhone(phone);
          if (!u || u.status !== "active") throw invalidOtp();
          return;
        }
        default:
          return;
      }
    },

    async after({ path, body, error, sessionUserId }) {
      const phone = body.phoneNumber === undefined ? "" : phoneOf(body);
      switch (path) {
        case "/sign-in/phone-number": {
          const u = await userByPhone(phone);
          if (!error) {
            await guard.clear(phone);
            await lowAudit(phone, "login_succeeded", "succeeded", "login_succeeded", u?.userId ?? null, { method: "password" });
            return;
          }
          if (error.statusCode !== 401) return; // 只有凭据失败才计数；服务端错误不算
          const r = await guard.fail(phone); // 不论号码是否对应用户都计，响应一致
          // 审计只为**已存在**的用户写（2026-11-10 刘学奎确认）：不存在的号码只进计数表（有清理），
          // 否则随机号码可以无限写审计表（保留一年、手机号明文）
          if (!u) return;
          await lowAudit(phone, "login_failed", "denied", "invalid_password", u.userId, { failCount: r.failCount });
          if (r.failCount === MAX_FAILURES && r.lockedUntil) {
            await lowAudit(phone, "login_failed", "denied", "account_locked", u.userId, { lockedUntil: r.lockedUntil.toISOString() });
          }
          return;
        }
        case "/phone-number/verify": {
          const u = await userByPhone(phone);
          if (error) await lowAudit(phone, "login_failed", "denied", "otp_invalid", u?.userId ?? null, { method: "otp" });
          else await lowAudit(phone, "login_succeeded", "succeeded", "login_succeeded", u?.userId ?? null, { method: "otp" });
          return;
        }
        case "/phone-number/reset-password": {
          if (error) return;
          const u = await userByPhone(phone);
          // 重置成功是唯一的提前解锁路径（B-D16）
          await guard.clear(phone);
          if (!u) return;
          if (u.status === "pending_activation") {
            // 激活与找回密码是库里的同一条路径（已知坑 4）；这里置 active，并与审计同事务（高风险）
            const now = deps.clock.now();
            await db.transaction(async (tx) => {
              await tx
                .update(accessUsers)
                .set({ status: "active", activatedAt: now, updatedAt: now })
                .where(and(eq(accessUsers.userId, u.userId), eq(accessUsers.status, "pending_activation")));
              await audit.write(
                { actor: `user:${u.userId}`, actorUserId: u.userId, eventType: "user_activated", outcome: "succeeded", reasonCode: "user_activated", targetType: "user", targetId: u.userId.toString(), detail: { phone } },
                { tx, risk: "high" },
              );
            });
          } else {
            await lowAudit(phone, "password_reset", "succeeded", "password_reset", u.userId);
          }
          return;
        }
        case "/change-password": {
          if (error || !sessionUserId) return;
          await audit.write(
            { actor: `user:${sessionUserId}`, actorUserId: BigInt(sessionUserId), eventType: "password_changed", outcome: "succeeded", reasonCode: "password_changed", targetType: "user", targetId: sessionUserId },
            { risk: "low" },
          );
          return;
        }
        default:
          return;
      }
    },
  };
}

/** 认证库的发送回调：经 SmsService 发送；失败时给用户统一的「暂时无法发送」，不泄露内部错误（design §8）。 */
export function createCodeDelivery(sms: SmsService): CodeDelivery {
  return {
    async deliver(msg) {
      try {
        await sms.deliver(msg);
      } catch (e) {
        if (e instanceof SmsSendError) throw new APIError("SERVICE_UNAVAILABLE", { code: "SMS_SEND_FAILED", message: "暂时无法发送，请稍后重试" });
        throw e;
      }
    },
  };
}
