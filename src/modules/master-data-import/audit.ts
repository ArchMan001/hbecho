// 审计事件（design §7.8）。B 域持久化审计上线前写结构化日志；调用方只依赖 AuditSink 函数。
// 不写文件内容、不写 secret、不写整行原文。
import type { Logger } from "pino";

export type AuditEventType =
  | "import_precheck_completed"
  | "import_confirmed"
  | "store_closed"
  | "store_reactivated"
  | "structure_changed"
  | "bootstrap_completed"
  | "import_confirmation_rejected";

export interface AuditEvent {
  event_type: AuditEventType;
  actor: string;
  occurred_at: string;
  reason_code?: string;
  target_type?: string;
  target_id?: string;
  /** 对象的业务编码（例如门店编码），让事件自身可读，不必回库关联。 */
  target_code?: string;
  batch_id?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  counts?: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;

export function createLogAudit(logger: Logger): AuditSink {
  return (event) => logger.info(event, "master_data.audit");
}
