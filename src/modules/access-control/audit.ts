// 审计（design §7.14、AX-10）：持久、追加写、保留一年、仅超管可读。
//   - risk='high'：必须传 tx，与业务写入同一事务；失败则整体失败（用户管理、授权变更、停用、导入确认……）
//   - risk='low' ：尽力写入；失败只记 pino 与计数，业务继续（登录成功、授权拒绝……）
//   - 不写密码、令牌、Cookie、验证码、整行原文、文件内容：序列化前按键名过滤（sanitize）
//   - 幂等键去重：sha256(event_type | actor | target | occurred_at 到秒 | detail 摘要)
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db, DbTx } from "../../db/client";
import { auditEvents } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";

export type AuditOutcome = "succeeded" | "denied" | "failed";
export type AuditRisk = "high" | "low";

export interface AuditEvent {
  /** 缺省时由 writer 用时钟填。 */
  occurredAt?: Date;
  /** 规范主体：`user:<id>` / `service:<name>`。 */
  actor: string;
  actorUserId?: bigint | null;
  eventType: string;
  outcome: AuditOutcome;
  /** 系统生成的稳定枚举（B-D30）。 */
  reasonCode: string;
  targetType?: string;
  targetId?: string;
  batchRef?: bigint;
  scopeSummary?: unknown;
  detail?: unknown;
  requestId?: string;
}

export interface AuditWriteOptions {
  tx?: DbTx;
  risk: AuditRisk;
}

export interface AuditWriter {
  write(e: AuditEvent, opts: AuditWriteOptions): Promise<void>;
}

export class AuditWriteError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AuditWriteError";
  }
}

// ---- 脱敏 ----------------------------------------------------------------------------------------------

const SENSITIVE_EXACT = new Set(["password", "passwd", "pwd", "token", "cookie", "otp", "code", "secret", "authorization", "set-cookie"]);
const SENSITIVE_PART = /(password|passwd|secret|cookie|otp|session_token|access_token|refresh_token|id_token|bearer)/i;

const isSensitiveKey = (k: string): boolean => SENSITIVE_EXACT.has(k.toLowerCase()) || SENSITIVE_PART.test(k) || /_token$/i.test(k);

/** 过滤敏感键并把 bigint / Date 变成 JSON 可存的值。返回新对象，不改入参。 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value instanceof Set) return [...value].map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) continue;
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function idempotencyKey(e: AuditEvent, occurredAt: Date, cleanDetail: unknown): Buffer {
  const sec = occurredAt.toISOString().slice(0, 19);
  const target = `${e.targetType ?? ""}:${e.targetId ?? ""}`;
  const detailDigest = createHash("sha256").update(canonical(cleanDetail ?? null)).digest("hex").slice(0, 16);
  return createHash("sha256").update([e.eventType, e.actor, target, sec, e.outcome, e.reasonCode, detailDigest].join("|")).digest();
}

const isDuplicateKey = (e: unknown): boolean => {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) if (cur.code === "ER_DUP_ENTRY") return true;
  return false;
};

// ---- 内存实现（单元测试用） -------------------------------------------------------------------------------

export interface MemoryAuditWriter extends AuditWriter {
  readonly events: Array<AuditEvent & { occurredAt: Date; risk: AuditRisk; detail: unknown }>;
  /** 让下一次（或所有）写入失败，用于验证「高风险失败整体回滚 / 低风险不影响业务」。 */
  failNext(times?: number): void;
}

export function createMemoryAuditWriter(clock: Clock = { now: () => new Date() }): MemoryAuditWriter {
  const events: MemoryAuditWriter["events"] = [];
  let failures = 0;
  return {
    events,
    failNext: (n = 1) => void (failures = n),
    async write(e, opts) {
      if (opts.risk === "high" && !opts.tx) throw new AuditWriteError("高风险审计必须传 tx（与业务写入同一事务）");
      if (failures > 0) {
        failures -= 1;
        if (opts.risk === "high") throw new AuditWriteError("注入的审计写入失败");
        return;
      }
      const occurredAt = e.occurredAt ?? clock.now();
      events.push({ ...e, occurredAt, risk: opts.risk, detail: sanitize(e.detail) });
    },
  };
}

// ---- 持久实现 --------------------------------------------------------------------------------------------

export interface AuditWriterDeps {
  db: Db;
  clock: Clock;
  logger?: Logger;
}

export interface PersistentAuditWriter extends AuditWriter {
  /** 低风险写入失败的累计次数（进程内计数，供告警使用）。 */
  readonly lowRiskFailures: () => number;
}

export function createAuditWriter(deps: AuditWriterDeps): PersistentAuditWriter {
  let lowFailures = 0;
  const insert = async (runner: Pick<Db, "insert">, e: AuditEvent): Promise<void> => {
    const occurredAt = e.occurredAt ?? deps.clock.now();
    const detail = sanitize(e.detail);
    try {
      await runner.insert(auditEvents).values({
        occurredAt,
        actor: e.actor,
        actorUserId: e.actorUserId ?? null,
        eventType: e.eventType,
        outcome: e.outcome,
        reasonCode: e.reasonCode,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        batchRef: e.batchRef ?? null,
        scopeSummary: e.scopeSummary === undefined ? null : sanitize(e.scopeSummary),
        detail: detail ?? null,
        requestId: e.requestId ?? null,
        idempotencyKey: idempotencyKey(e, occurredAt, detail),
      });
    } catch (err) {
      if (isDuplicateKey(err)) return; // 同一幂等键重复写入只落一条
      throw err;
    }
  };
  return {
    lowRiskFailures: () => lowFailures,
    async write(e, opts) {
      if (opts.risk === "high") {
        if (!opts.tx) throw new AuditWriteError("高风险审计必须传 tx（与业务写入同一事务）");
        try {
          await insert(opts.tx, e);
        } catch (err) {
          throw new AuditWriteError(`高风险审计写入失败：${e.eventType}`, err);
        }
        return;
      }
      try {
        await insert(opts.tx ?? deps.db, e);
      } catch (err) {
        lowFailures += 1;
        deps.logger?.error({ err, eventType: e.eventType }, "audit.low_risk_write_failed");
      }
    },
  };
}

// ---- 到期清理与读取 ---------------------------------------------------------------------------------------

export const AUDIT_RETENTION_DAYS = 365;
const CLOCK_SKEW_MARGIN_MS = 3600_000;
export const SYSTEM_ACTOR_ACCESS_WORKER = "service:access-worker";

/**
 * 分批删除超过保留期的记录（触发器只放行 occurred_at 早于 365 天的行）。结束后以系统身份写一条 audit_purged。
 * 返回删除条数。cutoff 由调用方的时钟算出，数据库触发器按数据库时钟再核一次，两者取更严格的。
 */
export async function purgeOlderThan(
  db: Db,
  writer: AuditWriter,
  clock: Clock,
  opts: { batchSize?: number; days?: number } = {},
): Promise<{ deleted: number; cutoff: Date }> {
  const batchSize = opts.batchSize ?? 1000;
  // 触发器按**数据库时钟**判断「满 365 天」。应用时钟略快于库时，裁在边缘的行会被触发器拒绝，整条 DELETE 失败；
  // 所以 cutoff 多留 1 小时余量（晚一小时清理无妨，清理失败才有妨）
  const cutoff = new Date(clock.now().getTime() - (opts.days ?? AUDIT_RETENTION_DAYS) * 86_400_000 - CLOCK_SKEW_MARGIN_MS);
  let deleted = 0;
  for (;;) {
    const [res] = await db.execute(sql`DELETE FROM audit_events WHERE occurred_at < ${cutoff} ORDER BY audit_id LIMIT ${batchSize}`);
    const n = Number((res as unknown as { affectedRows?: number }).affectedRows ?? 0);
    deleted += n;
    if (n < batchSize) break;
  }
  if (deleted > 0) {
    await db.transaction((tx) =>
      writer.write(
        {
          actor: SYSTEM_ACTOR_ACCESS_WORKER,
          eventType: "audit_purged",
          outcome: "succeeded",
          reasonCode: "audit_purged",
          targetType: "audit_log",
          detail: { deleted, cutoff: cutoff.toISOString() },
        },
        { tx, risk: "high" },
      ),
    );
  }
  return { deleted, cutoff };
}

export interface AuditQuery {
  actor?: string;
  targetType?: string;
  targetId?: string;
  batchRef?: bigint;
  eventType?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface AuditRow {
  auditId: string;
  occurredAt: string;
  actor: string;
  actorUserId: string | null;
  eventType: string;
  outcome: string;
  reasonCode: string;
  targetType: string | null;
  targetId: string | null;
  batchRef: string | null;
  scopeSummary: unknown;
  detail: unknown;
}

const auditConds = (q: AuditQuery): SQL[] => {
  const conds: SQL[] = [];
  if (q.actor !== undefined) conds.push(eq(auditEvents.actor, q.actor));
  if (q.targetType !== undefined) conds.push(eq(auditEvents.targetType, q.targetType));
  if (q.targetId !== undefined) conds.push(eq(auditEvents.targetId, q.targetId));
  if (q.batchRef !== undefined) conds.push(eq(auditEvents.batchRef, q.batchRef));
  if (q.eventType !== undefined) conds.push(eq(auditEvents.eventType, q.eventType));
  if (q.from) conds.push(gte(auditEvents.occurredAt, q.from));
  if (q.to) conds.push(lte(auditEvents.occurredAt, q.to));
  return conds;
};

/** 同一筛选条件下的总数与失败 / 拒绝数（审计页的概要带与分页用；与 listAudit 用同一条谓词）。 */
export async function countAudit(db: Db, q: AuditQuery = {}): Promise<{ total: number; notSucceeded: number }> {
  const conds = auditConds(q);
  const [r] = await db
    .select({ total: count(), notSucceeded: sql<string>`COALESCE(SUM(${auditEvents.outcome} <> 'succeeded'), 0)` })
    .from(auditEvents)
    .where(conds.length ? and(...conds) : undefined);
  return { total: Number(r?.total ?? 0), notSucceeded: Number(r?.notSucceeded ?? 0) };
}

/** 读取审计：调用方（`audit.read` 的授权）负责鉴权；这里只做查询。BIGINT 一律十进制字符串。 */
export async function listAudit(db: Db, q: AuditQuery = {}): Promise<AuditRow[]> {
  const conds = auditConds(q);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy((q.order ?? "desc") === "asc" ? asc(auditEvents.auditId) : desc(auditEvents.auditId))
    .limit(Math.min(q.limit ?? 100, 1000))
    .offset(q.offset ?? 0);
  return rows.map((r) => ({
    auditId: r.auditId.toString(),
    occurredAt: r.occurredAt.toISOString(),
    actor: r.actor,
    actorUserId: r.actorUserId?.toString() ?? null,
    eventType: r.eventType,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
    targetType: r.targetType,
    targetId: r.targetId,
    batchRef: r.batchRef?.toString() ?? null,
    scopeSummary: r.scopeSummary,
    detail: r.detail,
  }));
}
