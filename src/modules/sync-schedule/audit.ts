// 同步运营命令的审计事件（FS-14.7）。B 域审计流水尚不存在，所以是端口；默认实现写结构化日志。
import type { Logger } from "pino";

export interface SyncAuditEvent {
  at: string;
  event: "sync.command";
  action:
    | "supplement"
    | "batch_cancel"
    | "demand_submit"
    | "batch_retry_failed"
    | "account_rebind"
    | "account_confirm_deleted"
    | "issue_set_status"
    | "monitoring_set"
    | "external_add"
    | "external_enable"
    | "external_disable"
    | "maintain";
  outcome: "accepted" | "previewed" | "rejected" | "cancelled" | "noop" | "applied";
  actorId: string;
  code?: string;
  batchId?: string;
  /** 小而稳定的补充信息（计数、模式），不放账号入口原文或凭证。 */
  detail?: Record<string, string | number | boolean | null>;
}
export interface SyncAuditSink {
  record(event: SyncAuditEvent): void;
}
export const createLogSyncAuditSink = (logger: Logger): SyncAuditSink => ({ record: (e) => logger.info(e, "sync.command") });
export const memorySyncAuditSink = (): SyncAuditSink & { events: SyncAuditEvent[] } => {
  const events: SyncAuditEvent[] = [];
  return { events, record: (e) => void events.push(e) };
};
