// 初始检查点（R10）：类型保真的游标 + time / id_window / empty 锚点，只在整页投影完成之后建立。
// tracer 只建立基线，不请求第二页；已存在检查点时不改写（后续推进属于 a-full-sync）。
import { and, eq } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { syncCheckpoints } from "../../db/schema";
import { jcsSha256 } from "../canonical-json";
import type { TypedCursor, ValueState } from "../provider-adapter";
import { computeInitialAnchor, type AnchorEntry } from "./anchor";

export const CHECKPOINT_ACTION = "fetch_content_list";
export const CHECKPOINT_SCOPE = "default";

export type CursorEnvelope = { kind: "integer"; lexeme: string } | { kind: "string"; value: string } | { kind: "null" };

/** absent / invalid 游标不能持久化为有类型的游标 → 不存（NULL）。integer 保持原文，string 保持字符串，二者不互转。 */
export function cursorEnvelopeOf(c: TypedCursor): CursorEnvelope | null {
  switch (c.kind) {
    case "integer":
      return { kind: "integer", lexeme: c.lexeme };
    case "string":
      return { kind: "string", value: c.value };
    case "null":
      return { kind: "null" };
    default:
      return null;
  }
}

export interface EstablishInput {
  accountId: bigint;
  providerId: bigint;
  batchId: bigint;
  /** 产生该页的列表任务。 */
  taskId: bigint;
  cursor: TypedCursor;
  entries: readonly AnchorEntry[];
  now: Date;
}

export type EstablishResult = { established: true; version: bigint } | { established: false; reason: "exists" };

export async function establishInitialCheckpoint(tx: DbTx, i: EstablishInput): Promise<EstablishResult> {
  const scope = and(
    eq(syncCheckpoints.accountId, i.accountId),
    eq(syncCheckpoints.providerId, i.providerId),
    eq(syncCheckpoints.action, CHECKPOINT_ACTION),
    eq(syncCheckpoints.checkpointScope, CHECKPOINT_SCOPE),
  );
  const [existing] = await tx.select().from(syncCheckpoints).where(scope).for("update");
  if (existing) return { established: false, reason: "exists" };

  const anchor = computeInitialAnchor(i.entries);
  const envelope = cursorEnvelopeOf(i.cursor);
  await tx.insert(syncCheckpoints).values({
    accountId: i.accountId,
    providerId: i.providerId,
    action: CHECKPOINT_ACTION,
    checkpointScope: CHECKPOINT_SCOPE,
    anchorMode: anchor.mode,
    highWatermarkPublishedAt: anchor.highWatermarkPublishedAt,
    highWatermarkContentIds: anchor.highWatermarkContentIds,
    cursorEnvelope: envelope,
    cursorSha256: envelope === null ? null : jcsSha256(envelope),
    cursorTaskId: i.taskId,
    lastSuccessfulBatchId: i.batchId,
    lastSuccessfulTaskId: i.taskId,
    continuityStatus: "ready",
    version: 1n,
    updatedAt: i.now,
  });
  return { established: true, version: 1n };
}

/** 检查点模块接口：长期检查点只保存 v2 字段；has_more / 页数 / 处理条数留在一年期 task / call lineage。 */
export interface CheckpointModule {
  establishInitial(tx: DbTx, input: EstablishInput): Promise<EstablishResult>;
}

export const checkpointModule: CheckpointModule = { establishInitial: establishInitialCheckpoint };

/**
 * has_more=true 但游标为空 / null / 缺失时无法继续翻页（D-53）：不请求下一页，按已处理页建立基线，并留一条质量问题。
 * has_more=false 时空或 null 游标是正常结束。
 */
export function cursorAnomaly(hasMore: ValueState<boolean>, cursor: TypedCursor): { reason: "cursor_missing_while_has_more"; cursorKind: string } | null {
  if (hasMore.state !== "value" || !hasMore.value) return null;
  const unusable = cursor.kind === "null" || cursor.kind === "absent" || cursor.kind === "invalid" || (cursor.kind === "string" && cursor.value === "");
  return unusable ? { reason: "cursor_missing_while_has_more", cursorKind: cursor.kind } : null;
}
