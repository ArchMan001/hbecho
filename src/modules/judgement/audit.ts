// 审计（JP-18）：经 B 的 AuditWriter。创建 / 发布 / 开始执行 / 取消 / 回退（删除结果）/ 归档 / 期满清除 是 high（与业务写入同事务，写失败使整笔失败）；
// 试跑、圈定是 low（尽力写入）。reasonCode 是稳定枚举；detail 里可有配置里的关键词，不含评论原文、签名 URL、模型 Key。
import type { DbTx } from "../../db/client";
import type { AuditWriter } from "../access-control";

export const JUDGEMENT_AUDIT_EVENTS = {
  plan_created: "high",
  plan_archived: "high",
  plan_unarchived: "high",
  version_published: "high",
  execution_started: "high",
  run_cancelled: "high",
  rollback_applied: "high",
  plan_purged: "high",
  config_changed: "low",
  circle_run: "low",
  trial_run: "low",
  submitter_revoked: "high",
} as const;
export type JudgementAuditEvent = keyof typeof JUDGEMENT_AUDIT_EVENTS;

export interface JudgementAuditInput {
  event: JudgementAuditEvent;
  actor: string;
  actorUserId?: bigint | null;
  planId?: bigint;
  runId?: bigint;
  outcome?: "succeeded" | "denied" | "failed";
  /** 稳定标识符（小写字母、数字、下划线、点、连字符）；缺省 `judgement.<event>.<outcome>` */
  reasonCode?: string;
  detail?: Record<string, unknown>;
}
export function createJudgementAudit(writer: AuditWriter) {
  /** high 事件必须传 tx（与业务写入同事务）；low 事件可不传。 */
  async function record(e: JudgementAuditInput, tx?: DbTx): Promise<void> {
    const risk = JUDGEMENT_AUDIT_EVENTS[e.event];
    if (risk === "high" && !tx) throw new Error(`高风险审计 ${e.event} 必须与业务写入同事务（传 tx）`);
    const outcome = e.outcome ?? "succeeded";
    await writer.write(
      {
        actor: e.actor,
        ...(e.actorUserId === undefined ? {} : { actorUserId: e.actorUserId }),
        eventType: `judgement.${e.event}`,
        outcome,
        reasonCode: e.reasonCode ?? `judgement.${e.event}.${outcome}`,
        ...(e.planId === undefined ? {} : { targetType: "judgement_plan", targetId: String(e.planId) }),
        detail: { ...(e.runId === undefined ? {} : { runId: String(e.runId) }), ...(e.detail ?? {}) },
      },
      { risk, ...(tx ? { tx } : {}) },
    );
  }
  return { record };
}
export type JudgementAudit = ReturnType<typeof createJudgementAudit>;
