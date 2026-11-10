// 现有审计端口 → 持久审计表（design §7.14、AX-10）。
// 各模块的 AuditSink 只写 pino 日志；这里提供它们的**新实现**，装配处替换 `createLog*`，调用方一行不改。
//   - 全部低风险、尽力写入：持久审计失败不影响业务（writer 内部已吞并计数）；
//   - 同时仍转发给原来的 sink（`inner`，通常是 pino 日志），不丢现有日志；
//   - 事件类型在各自命名空间下（`tracer.command.*`、`sync.command.*`、`master_data.*`、`activity_plan.*`）；
//   - actor 取规范主体（`user:<id>` / `service:<名>`）；原事件里是自由文本的 actorId 补 `service:` 前缀；
//   - reason_code 取事件里已有的稳定码，缺失时用 `<event_type>.<outcome>`。
// 事件形状用本文件的结构类型声明，**不 import** 各模块（依赖方向：业务模块 → 访问控制的端口，不反过来）。
import type { AuditOutcome, AuditWriter } from "./audit";

const canonicalActor = (a: string): string => (/^(user|service):/.test(a) ? a : `service:${a}`);
const bigintOrUndefined = (s: string | undefined): bigint | undefined => (s !== undefined && /^\d{1,19}$/.test(s) ? BigInt(s) : undefined);
const compact = <T extends Record<string, unknown>>(o: T): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function sink(writer: AuditWriter, e: Parameters<AuditWriter["write"]>[0]): void {
  // 端口是同步的 void；低风险 write 自己吞错，这里再兜一层，避免同步异常变成未处理的 rejection
  void writer.write(e, { risk: "low" }).catch(() => {});
}

// ---- tracer-command ----------------------------------------------------------------------------------------
export interface TracerAuditEventShape {
  at: string;
  event: string;
  action: string;
  outcome: string;
  code?: string;
  actorId: string;
  platform?: string;
  mediaStaffId?: string;
  rootTaskId?: string;
  locatorSha256?: string;
  locatorLength?: number;
}
export function fromTracerAudit(writer: AuditWriter, inner?: { record(e: TracerAuditEventShape): void }) {
  return {
    record(e: TracerAuditEventShape): void {
      inner?.record(e);
      const eventType = `tracer.command.${e.action}`;
      const rejected = e.outcome === "rejected";
      sink(writer, {
        occurredAt: new Date(e.at),
        actor: canonicalActor(e.actorId),
        eventType,
        outcome: rejected ? "denied" : "succeeded",
        reasonCode: e.code ?? `${eventType}.${e.outcome}`,
        ...(e.rootTaskId ? { targetType: "root_task", targetId: e.rootTaskId } : e.mediaStaffId ? { targetType: "media_staff", targetId: e.mediaStaffId } : {}),
        detail: compact({ outcome: e.outcome, platform: e.platform, mediaStaffId: e.mediaStaffId, locatorSha256: e.locatorSha256, locatorLength: e.locatorLength }),
      });
    },
  };
}

// ---- sync-schedule -----------------------------------------------------------------------------------------
export interface SyncAuditEventShape {
  at: string;
  event: string;
  action: string;
  outcome: string;
  actorId: string;
  code?: string;
  batchId?: string;
  detail?: Record<string, string | number | boolean | null>;
}
export function fromSyncAudit(writer: AuditWriter, inner?: { record(e: SyncAuditEventShape): void }) {
  return {
    record(e: SyncAuditEventShape): void {
      inner?.record(e);
      const eventType = `sync.command.${e.action}`;
      const batchRef = bigintOrUndefined(e.batchId);
      sink(writer, {
        occurredAt: new Date(e.at),
        actor: canonicalActor(e.actorId),
        eventType,
        outcome: e.outcome === "rejected" ? "denied" : "succeeded",
        reasonCode: e.code ?? `${eventType}.${e.outcome}`,
        ...(batchRef !== undefined ? { batchRef, targetType: "sync_batch", targetId: e.batchId! } : {}),
        detail: compact({ outcome: e.outcome, ...(e.detail ?? {}) }),
      });
    },
  };
}

// ---- master-data-import ------------------------------------------------------------------------------------
export interface MasterDataAuditEventShape {
  event_type: string;
  actor: string;
  occurred_at: string;
  reason_code?: string;
  target_type?: string;
  target_id?: string;
  target_code?: string;
  batch_id?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  counts?: Record<string, unknown>;
}
export function fromMasterDataAudit(writer: AuditWriter, inner?: (e: MasterDataAuditEventShape) => void) {
  return (e: MasterDataAuditEventShape): void => {
    inner?.(e);
    const eventType = `master_data.${e.event_type}`;
    const batchRef = bigintOrUndefined(e.batch_id);
    sink(writer, {
      occurredAt: new Date(e.occurred_at),
      actor: canonicalActor(e.actor),
      eventType,
      outcome: e.event_type.endsWith("_rejected") ? "denied" : "succeeded",
      reasonCode: e.reason_code ?? `${eventType}.${e.event_type.endsWith("_rejected") ? "denied" : "succeeded"}`,
      ...(e.target_type ? { targetType: e.target_type } : {}),
      ...(e.target_id ? { targetId: e.target_id } : {}),
      ...(batchRef !== undefined ? { batchRef } : {}),
      detail: compact({ targetCode: e.target_code, before: e.before, after: e.after, counts: e.counts }),
    });
  };
}

// ---- a-activity-plan（AP-14）-----------------------------------------------------------------------------
/**
 * A 域的审计端口尚未落地，这里按其 design 里出现的事件命名（`roster_batch_confirmed`、`staff_created`、`monitoring_*`……）
 * 与 master-data 同风格假定一个结构类型；A 落地时以契约测试对齐，对不上就调整适配器，不改 A。
 */
export interface PlanAuditEventShape {
  event_type: string;
  actor: string;
  occurred_at: string;
  outcome?: AuditOutcome;
  reason_code?: string;
  plan_id?: string;
  target_type?: string;
  target_id?: string;
  batch_id?: string;
  detail?: Record<string, unknown>;
}
export function fromPlanAudit(writer: AuditWriter, inner?: (e: PlanAuditEventShape) => void) {
  return (e: PlanAuditEventShape): void => {
    inner?.(e);
    const eventType = `activity_plan.${e.event_type}`;
    const outcome = e.outcome ?? "succeeded";
    const batchRef = bigintOrUndefined(e.batch_id);
    sink(writer, {
      occurredAt: new Date(e.occurred_at),
      actor: canonicalActor(e.actor),
      eventType,
      outcome,
      reasonCode: e.reason_code ?? `${eventType}.${outcome}`,
      ...(e.target_type ? { targetType: e.target_type } : e.plan_id ? { targetType: "activity_plan" } : {}),
      ...(e.target_id ? { targetId: e.target_id } : e.plan_id ? { targetId: e.plan_id } : {}),
      ...(batchRef !== undefined ? { batchRef } : {}),
      detail: compact({ planId: e.plan_id, ...(e.detail ?? {}) }),
    });
  };
}
