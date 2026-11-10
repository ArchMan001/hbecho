// 短信发送端口与假发送器（design §7.8、AX-4）。验证码明文只存在于 better-auth 的 verification 与发送器调用里，
// 审计、日志不记录。生产的阿里云发送器在任务 5 接入；在那之前 HBECHO_SMS_MODE=aliyun 启动失败，不缺省为假发送器。

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { Db } from "../../db/client";
import { accessSmsSends, accessUsers } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import type { AuditWriter } from "./audit";

export type SmsKind = "activate" | "login" | "reset";

export interface SmsMessage {
  phone: string;
  code: string;
  kind: SmsKind;
}

/** 发送器端口：成功返回供应商流水号（可空）；失败抛错。 */
export interface SmsSender {
  send(msg: SmsMessage): Promise<{ providerRef?: string }>;
}

// ---- SmsService：发送前资格校验、限频、全局上限、结果记录 --------------------------------------------------------

/** 60 秒后可重发；每个号码每天最多 10 条；验证码有效期等见 auth-instance。 */
export const SMS_MIN_INTERVAL_MS = 60_000;
export const SMS_PER_PHONE_DAILY_LIMIT = 10;
const COUNTED_OUTCOMES = ["sent", "suppressed", "failed"] as const; // 不含 rate_limited：否则连续重试会不断续期
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** 北京时间当天 00:00 对应的 UTC 时刻（「每天」按自然日，业务在中国）。 */
export function beijingDayStart(now: Date): Date {
  const shifted = now.getTime() + BEIJING_OFFSET_MS;
  return new Date(Math.floor(shifted / 86_400_000) * 86_400_000 - BEIJING_OFFSET_MS);
}

export type SmsIntent = "login" | "reset";

export type Admission =
  /** 通过；继续让认证库生成验证码并经 deliver 发送。 */
  | { kind: "proceed"; purpose: SmsKind }
  /** 号码不是「待激活或有效」用户（或用途不符）：返回与成功一致的响应，实际不发送。 */
  | { kind: "suppressed" }
  | { kind: "rate_limited"; reason: "min_interval" | "daily_limit" }
  /** 全局每日上限已达：短信类请求暂停，密码登录不受影响。 */
  | { kind: "unavailable" };

export type AccessAlert =
  | { type: "sms_daily_cap_reached"; cap: number; sentToday: number }
  /** 发送器报「运维类」错误（余额不足 / 签名被停 / 模板不可用 / 日限额）：整个平台都发不出短信，不是某个用户的问题。 */
  | { type: "sms_provider_operational_error"; providerCode: string };

export class SmsSendError extends Error {
  constructor(cause?: unknown) {
    super("短信发送失败", { cause });
    this.name = "SmsSendError";
  }
}

export interface SmsServiceDeps {
  db: Db;
  clock: Clock;
  sender: SmsSender;
  /** 每日全局 sent 上限（I 域配置落地前 = HBECHO_SMS_DAILY_CAP）。 */
  dailyCap: number;
  alert?: (a: AccessAlert) => void;
  audit?: AuditWriter;
}

export interface SmsService {
  /** 在认证库生成验证码**之前**调用。 */
  admit(phone: string, intent: SmsIntent): Promise<Admission>;
  /** 认证库的发送回调：发送并记录 sent / failed；失败抛 SmsSendError。验证码明文不落审计与日志。 */
  deliver(msg: { phone: string; code: string; kind: "otp" | "reset" }): Promise<void>;
}

export function createSmsService(deps: SmsServiceDeps): SmsService {
  const { db, clock } = deps;
  // admit 与 deliver 在同一次请求里先后发生；用号码关联用途（同一号码 60 秒内至多一次通过，不会串）
  const inFlight = new Map<string, { purpose: SmsKind; at: number }>();
  let alertedDay = -1;

  const record = async (phone: string, purpose: SmsKind, outcome: "sent" | "failed", providerRef?: string): Promise<void> => {
    await db.insert(accessSmsSends).values({ phoneNorm: phone, purpose, requestedAt: clock.now(), outcome, providerRef: providerRef ?? null });
  };

  /**
   * 同一号码的 admit 串行化：命名锁（GET_LOCK）、事务、提交、RELEASE_LOCK 全部发生在**同一条连接**上，
   * 所以后到的请求拿到锁时，前一个请求的预占行已经提交、可见。不能用 drizzle 事务 + 另一条连接来放锁：
   * 锁在提交之前就释放（竞争者看不到预占行），而「锁连接 + 事务连接」各占一条会在 8 连接的池里互相饿死。
   * 没有这把锁时 8 个并发请求有多个通过 60 秒检查、各发一条短信（实测）。
   * 预占行先记 sent，deliver 发送失败时再改写为 failed；这样窗口与每日计数立刻包含本次请求。
   */
  const pool = (db as unknown as { $client: Pool }).$client;
  const admitLocked = async (phone: string, fallbackPurpose: SmsKind, intent: SmsIntent): Promise<Admission> => {
    const conn = await pool.getConnection();
    const lockName = `hbecho:sms:${phone}`;
    let locked = false;
    try {
      const [lr] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 5) AS got", [lockName]);
      if (Number(lr[0]?.got) !== 1) throw new Error("sms admit lock timeout");
      locked = true;
      await conn.beginTransaction();
      try {
        const now = clock.now();
        const n = async (sqlText: string, params: unknown[]): Promise<number> => Number(((await conn.query<RowDataPacket[]>(sqlText, params))[0][0] as { n: number | string }).n);
        const put = async (purpose: SmsKind, outcome: "sent" | "suppressed" | "rate_limited"): Promise<void> => {
          await conn.query("INSERT INTO access_sms_sends (phone_norm, purpose, requested_at, outcome) VALUES (?, ?, ?, ?)", [phone, purpose, now, outcome]);
        };
        const windowSql = "SELECT COUNT(*) AS n FROM access_sms_sends WHERE phone_norm = ? AND requested_at > ? AND outcome IN ('sent','suppressed','failed')";
        let result: Admission;
        if ((await n(windowSql, [phone, new Date(now.getTime() - SMS_MIN_INTERVAL_MS)])) > 0) {
          await put(fallbackPurpose, "rate_limited");
          result = { kind: "rate_limited", reason: "min_interval" };
        } else if ((await n(windowSql, [phone, beijingDayStart(now)])) >= SMS_PER_PHONE_DAILY_LIMIT) {
          await put(fallbackPurpose, "rate_limited");
          result = { kind: "rate_limited", reason: "daily_limit" };
        } else {
          // 资格：只有「待激活或有效」用户；用途必须相符。不符 → 成功样式但不发送，计入窗口（使存在与不存在的号码表现一致）
          const [ur] = await conn.query<RowDataPacket[]>("SELECT status FROM access_users WHERE active_phone = ? LIMIT 1", [phone]);
          const status = ur[0]?.status as string | undefined;
          const purpose: SmsKind | null = intent === "login" ? (status === "active" ? "login" : null) : status === "pending_activation" ? "activate" : status === "active" ? "reset" : null;
          if (purpose === null) {
            await put(fallbackPurpose, "suppressed");
            result = { kind: "suppressed" };
          } else if ((await n("SELECT COUNT(*) AS n FROM access_sms_sends WHERE requested_at > ? AND outcome = 'sent'", [beijingDayStart(now)])) >= deps.dailyCap) {
            // 全局每日上限（只数 sent）：短信类请求暂停并告警；密码登录不受影响
            await put(purpose, "rate_limited");
            result = { kind: "unavailable" };
          } else {
            await put(purpose, "sent"); // 预占；发送失败时 deliver 改写为 failed
            inFlight.set(phone, { purpose, at: now.getTime() });
            result = { kind: "proceed", purpose };
          }
        }
        await conn.commit(); // 先提交，再在 finally 里放锁
        return result;
      } catch (e) {
        await conn.rollback();
        throw e;
      }
    } finally {
      if (locked) await conn.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
      conn.release();
    }
  };

  /** 全局上限告警：每个进程每天一次（避免洪水）；告警 + 一条审计。 */
  const alertCapOnce = async (): Promise<void> => {
    const now = clock.now();
    const day = Math.floor((now.getTime() + BEIJING_OFFSET_MS) / 86_400_000);
    if (alertedDay === day) return;
    alertedDay = day;
    deps.alert?.({ type: "sms_daily_cap_reached", cap: deps.dailyCap, sentToday: deps.dailyCap });
    await deps.audit?.write(
      { actor: "service:access-worker", eventType: "sms_daily_cap_reached", outcome: "denied", reasonCode: "sms_daily_cap_reached", detail: { cap: deps.dailyCap } },
      { risk: "low" },
    );
  };

  return {
    async admit(phone, intent) {
      const res = await admitLocked(phone, intent === "login" ? "login" : "reset", intent);
      if (res.kind === "unavailable") await alertCapOnce();
      return res;
    },

    async deliver({ phone, code, kind }) {
      const held = inFlight.get(phone);
      inFlight.delete(phone);
      const purpose: SmsKind = held?.purpose ?? (kind === "otp" ? "login" : "reset");
      // 最近一条该号码的预占行（admit 刚写的）
      const [row] = await db
        .select({ sendId: accessSmsSends.sendId })
        .from(accessSmsSends)
        .where(and(eq(accessSmsSends.phoneNorm, phone), eq(accessSmsSends.outcome, "sent"), isNull(accessSmsSends.providerRef)))
        .orderBy(desc(accessSmsSends.sendId))
        .limit(1);
      try {
        const r = await deps.sender.send({ phone, code, kind: purpose });
        if (row) await db.update(accessSmsSends).set({ providerRef: r.providerRef ?? "-" }).where(eq(accessSmsSends.sendId, row.sendId));
        else await record(phone, purpose, "sent", r.providerRef);
      } catch (e) {
        if (row) await db.update(accessSmsSends).set({ outcome: "failed" }).where(eq(accessSmsSends.sendId, row.sendId));
        else await record(phone, purpose, "failed");
        // 结构化判断（不 import 具体发送器）：发送器的错误带 operational=true 时发告警；告警失败不影响对用户的结果
        const x = e as { operational?: unknown; providerCode?: unknown };
        if (x?.operational === true) {
          try {
            deps.alert?.({ type: "sms_provider_operational_error", providerCode: String(x.providerCode ?? "unknown") });
          } catch {
            // 告警出口自己的故障不改变结果
          }
        }
        throw new SmsSendError(e);
      }
    },
  };
}

/** 测试与本地开发用：把「发出的短信」记在内存里。 */
export class FakeSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  private failures = 0;
  /** 让接下来的 n 次发送失败（用于验证 failed 结果与限频计数）。 */
  failNext(n = 1): void {
    this.failures = n;
  }
  async send(msg: SmsMessage): Promise<{ providerRef?: string }> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("fake sms sender failure");
    }
    this.sent.push(msg);
    return { providerRef: `fake-${this.sent.length}` };
  }
  last(phone?: string): SmsMessage | undefined {
    const list = phone ? this.sent.filter((m) => m.phone === phone) : this.sent;
    return list[list.length - 1];
  }
}
