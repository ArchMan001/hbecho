// 审计事件（requirements AP-14）。B 域持久化审计上线前写结构化日志；调用方只依赖 PlanAuditSink 函数。
// 不写文件内容、不写 secret、不写整行原文；手机号按 D-42 明文，不额外脱敏。
import type { Logger } from "pino";

export type PlanAuditEventType =
  | "plan_created"
  | "plan_edited"
  | "plan_status_changed"
  | "plan_deleted"
  | "plan_restored"
  | "plan_purged"
  | "branch_joined"
  | "branch_exited"
  | "owner_claimed"
  | "owner_replaced"
  | "owner_released"
  | "roster_precheck_completed"
  | "roster_batch_confirmed"
  | "roster_confirmation_rejected"
  | "roster_report_downloaded"
  | "staff_created"
  | "roster_entry_removed"
  | "suspected_empty_confirmed"
  | "monitoring_closed_unreferenced"
  | "monitoring_reopened_on_reference"
  | "monitoring_reopened_by_import"
  | "plan_maintenance_completed";

export interface PlanAuditEvent {
  event_type: PlanAuditEventType;
  actor: string;
  occurred_at: string;
  reason_code?: string;
  target_type?: string;
  target_id?: string;
  /** 对象的业务名称或编码，让事件自身可读，不必回库关联。 */
  target_code?: string;
  plan_id?: string;
  batch_id?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  counts?: Record<string, unknown>;
}
export type PlanAuditSink = (event: PlanAuditEvent) => void;

export function createLogAudit(logger: Logger): PlanAuditSink {
  return (event) => logger.info(event, "activity_plan.audit");
}
