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
/** 按需批次的终态由它自己的详情 / 评论 / 媒资任务决定。 */
export const DEMAND_ACTIONS = ["fetch_content_detail", "fetch_comments", "download_media"] as const;
/** 补抓任务的优先级高于周期任务（0）；按需批次为 50（任务 6）。 */
export const SUPPLEMENT_PRIORITY = 100;
/** 按需批次的任务优先级：高于周期任务（0），低于补抓（100）；FS-D17。 */
export const DEMAND_PRIORITY = 50;

/** 按需任务幂等键：批次 + 账号 + 内容 + 动作；重放同一提交不会重复建任务。 */
export const demandTaskKey = (p: { batchId: bigint; accountId: bigint; contentId: bigint; action: string }): Buffer =>
  jcsSha256({ v: "sync-demand-task.v1", batch_id: p.batchId.toString(), account_id: p.accountId.toString(), content_id: p.contentId.toString(), action: p.action });
