// 审计安全的结果事件（R1.6）：只记主体、结果、稳定原因和摘要前缀，不记 locator 原文、幂等 key 原文、凭证或载荷。
// B 域的审计流水尚未存在，所以这里是一个端口；默认实现写结构化日志（pino）。
import type { Logger } from "pino";

export interface AuditEvent {
  at: string;
  event: "tracer.command";
  action: "submit" | "cancel";
  outcome: "accepted" | "deduplicated" | "reused_active_task" | "rejected" | "cancelled" | "cancel_noop";
  /** 仅 rejected 时有：稳定原因码。 */
  code?: string;
  actorId: string;
  platform?: string;
  mediaStaffId?: string;
  rootTaskId?: string;
  /** locator 的 SHA-256 前 16 个十六进制字符与长度，用于关联，不能还原原文。 */
  locatorSha256?: string;
  locatorLength?: number;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

export function createLogAuditSink(logger: Logger): AuditSink {
  return { record: (event) => logger.info(event, "tracer.command") };
}
