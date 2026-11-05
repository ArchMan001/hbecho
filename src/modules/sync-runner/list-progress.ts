// 列表任务的页进度（design §6.2、design-task5 §6）：写在 sync_tasks.result_summary，**在每个页事务里与投影一起提交**。
// 崩溃后只读它：从 pages_done+1 页和 next_cursor 继续，已提交的页不重复请求；stop≠null 表示判定已作出，直接封口。
import { z } from "zod";
import type { Anomaly, Decision } from "./decide-after-page";

export const PROGRESS_SCHEMA = "list-walk-progress.v1";

/** 可以回发的游标：整数保持原文，字符串保持字符串，二者不互转；no_more / 空串 / null 永远不会出现在这里。 */
export const nextCursorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("integer"), lexeme: z.string().regex(/^-?\d+$/) }),
  z.strictObject({ kind: z.literal("string"), value: z.string().min(1) }),
]);
export type NextCursor = z.infer<typeof nextCursorSchema>;

const stopDetailSchema = z.strictObject({
  outcome: z.enum(["success", "gap", "blocked"]),
  stop_reason: z.string().min(1),
  anchor: z.enum(["rebuild", "keep_old", "empty"]),
  window_overflow: z.boolean(),
});
const identityCheckSchema = z.strictObject({
  /** 任务开始时（第 1 页事务里、绑定之前）该账号在列表作者命名空间下是否已有登记标识。 */
  baseline_has_registered: z.boolean(),
  known_author_entries: z.number().int().nonnegative(),
  matched_entries: z.number().int().nonnegative(),
  state: z.enum(["pending", "verified", "unverifiable", "mismatch"]),
});
const anomalySchema = z.looseObject({ code: z.string().min(1) });

export const progressSchema = z.strictObject({
  schema: z.literal(PROGRESS_SCHEMA),
  pages_done: z.number().int().nonnegative(),
  entries_done: z.number().int().nonnegative(),
  pinned_id_match: z.boolean(),
  next_cursor: nextCursorSchema.nullable(),
  stop: z.string().min(1).nullable(),
  stop_detail: stopDetailSchema.nullable(),
  anomalies: z.array(anomalySchema),
  /** 列表作者三态（FS-5.13）：acceptance 要求的 result_summary.identity_check。 */
  identity_check: identityCheckSchema,
  /** 末页返回的、可回发的游标（检查点 cursor 列用）；不可用则 null。 */
  last_cursor: nextCursorSchema.nullable(),
  /** 封口事务写入的终态摘要（检查点结局、定稿数等）；页进度阶段没有。 */
  final: z.looseObject({}).optional(),
  last_page_call_id: z.string().nullable(),
});
export type ListProgress = z.infer<typeof progressSchema>;

export class ProgressCorruptError extends Error {
  constructor(detail: string) {
    super(`list-walk-progress 不合法：${detail}`);
    this.name = "ProgressCorruptError";
  }
}

export const initialProgress = (baselineHasRegistered: boolean): ListProgress => ({
  schema: PROGRESS_SCHEMA,
  pages_done: 0,
  entries_done: 0,
  pinned_id_match: false,
  next_cursor: null,
  stop: null,
  stop_detail: null,
  anomalies: [],
  identity_check: { baseline_has_registered: baselineHasRegistered, known_author_entries: 0, matched_entries: 0, state: "pending" },
  last_cursor: null,
  last_page_call_id: null,
});

/** 没有进度（任务还没提交过任何页）→ null；存在但不合法 → 抛 ProgressCorruptError（内部错误，框架按 runner_error 有界重试）。 */
export function parseProgress(raw: unknown): ListProgress | null {
  if (raw === null || raw === undefined) return null;
  const r = progressSchema.safeParse(raw);
  if (!r.success) throw new ProgressCorruptError(r.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
  return r.data;
}

/** 一页事务提交后的新进度（纯函数）。 */
export function afterPage(
  prev: ListProgress,
  p: { entriesInPage: number; decision: Decision; pinnedIdMatch: boolean; identity: ListProgress["identity_check"]; lastCursor?: NextCursor | null; callId: bigint; anomalies: readonly Anomaly[] },
): ListProgress {
  const stopped = p.decision.action === "stop" ? p.decision : null;
  return {
    ...prev,
    pages_done: prev.pages_done + 1,
    entries_done: prev.entries_done + p.entriesInPage,
    pinned_id_match: prev.pinned_id_match || p.pinnedIdMatch,
    next_cursor: p.decision.action === "continue" ? p.decision.nextCursor : null,
    stop: stopped ? stopped.stopReason : null,
    stop_detail: stopped ? { outcome: stopped.outcome, stop_reason: stopped.stopReason, anchor: stopped.anchor, window_overflow: stopped.windowOverflow } : null,
    anomalies: [...prev.anomalies, ...p.anomalies],
    identity_check: p.identity,
    last_cursor: p.lastCursor ?? null,
    last_page_call_id: p.callId.toString(),
  };
}
