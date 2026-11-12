// 审计事件（requirements SG-14）。B 域持久化审计上线前写结构化日志；调用方只依赖 SignalAuditSink 函数。
// 事件不含图片字节、文本原文、签名 URL、模型 Key：只放稳定码、ID 与计数。
import type { Logger } from "pino";

export type SignalAuditEventType =
  | "segment_created"
  | "segment_published"
  | "segment_purged"
  | "image_uploaded"
  | "image_removed"
  | "recompute_previewed"
  | "recompute_applied"
  | "recompute_cancelled"
  | "task_dead";

export interface SignalAuditEvent {
  event_type: SignalAuditEventType;
  actor: string;
  occurred_at: string;
  reason_code?: string;
  target_type?: string;
  target_id?: string;
  plan_id?: string;
  version?: number;
  signal_key?: string;
  run_id?: string;
  counts?: Record<string, number>;
}
export type SignalAuditSink = (event: SignalAuditEvent) => void;

export function createLogAudit(logger: Logger): SignalAuditSink {
  return (event) => logger.info(event, "signals.audit");
}
