import { jcsSha256 } from "../canonical-json";

/** 任务幂等键：batch_id + account_id + action 确定性生成（FS-3.1）；重复规划不产生重复任务。 */
export const taskIdempotencyKey = (p: { batchId: bigint; accountId: bigint; action: string }): Buffer =>
  jcsSha256({ v: "sync-task.v1", batch_id: p.batchId.toString(), account_id: p.accountId.toString(), action: p.action });

/** 全量批次键：由时点 UTC 值确定（FS-1.1）。 */
export const fullBatchKey = (slotUtc: Date): Buffer => jcsSha256({ v: "sync-batch.v1", purpose: "full", slot_utc: slotUtc.toISOString() });

export const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;
/** 未终态的任务状态（含租约中）。 */
export const ACTIVE_TASK_STATUSES = ["pending", "leased", "running", "retry_wait"] as const;
export const TERMINAL_TASK_STATUSES = ["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"] as const;
/** 决定批次终态的结构化动作；媒资不决定终态（FS-1.8）。 */
export const STRUCTURED_ACTIONS = ["fetch_profile", "fetch_content_list"] as const;
/** 补抓任务的优先级高于周期任务（0）；按需批次为 50（任务 6）。 */
export const SUPPLEMENT_PRIORITY = 100;
