// 初始检查点（R10）：类型保真的游标 + time / id_window / empty 锚点，只在整页投影完成之后建立。
// tracer 只建立基线，不请求第二页；已存在检查点时不改写（后续推进属于 a-full-sync）。
import { and, eq, sql } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { syncCheckpoints, syncTasks } from "../../db/schema";
import { jcsSha256 } from "../canonical-json";
import type { TypedCursor, ValueState } from "../provider-adapter";
import { fenceFailure } from "../raw-capture";
import { computeInitialAnchor, type AnchorEntry, type InitialAnchor } from "./anchor";

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

export type CheckpointNext = {
  /** 重建 / 建立的锚点；"keep" = 不动旧锚点（blocked：空窗口不能覆盖非空锚点）。 */
  anchor: InitialAnchor | "keep";
  continuity: "ready" | "rebased_after_gap" | "blocked";
  /** 末页返回的游标；不可用（null / no_more / 缺失）→ 不存。blocked 时忽略。 */
  cursor: TypedCursor | null;
  /** 缺口时间；非 null 才写 last_gap_at。 */
  gapAt: Date | null;
};
export interface AdvanceInput {
  accountId: bigint;
  providerId: bigint;
  /** 本批次**规划时**看到的检查点版本；规划时没有检查点 = null。不读活的检查点。 */
  expectedVersion: bigint | null;
  batchId: bigint;
  /** 产生本次推进的列表任务，及其 fencing token。 */
  fence: { taskId: bigint; token: bigint };
  next: CheckpointNext;
  now: Date;
}
export type AdvanceResult =
  | { kind: "advanced"; version: bigint }
  | { kind: "created"; version: bigint }
  /** version 不符：别的批次已经推进过，这一次不能让它倒退（不是失败）。 */
  | { kind: "stale_rejected" }
  /** 任务 fencing 失效（被取消 / 被取代）：什么都没写。 */
  | { kind: "fence_lost"; reason: string };

/**
 * 检查点推进（FS-5.10）：**任务 fencing 与 version 乐观比较缺一不可**。
 * fencing 在函数内部再校验一次（锁任务行），所以即使调用方忘了套 withFences，陈旧 worker 也推进不了。
 * 必须在调用方的事务里执行（与定稿、任务终态同一个事务）。
 */
export async function advanceCheckpoint(tx: DbTx, i: AdvanceInput): Promise<AdvanceResult> {
  const [task] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, i.fence.taskId)).for("update");
  const lost = fenceFailure(task, i.fence.token, i.now);
  if (lost) return { kind: "fence_lost", reason: lost };

  const scope = and(
    eq(syncCheckpoints.accountId, i.accountId),
    eq(syncCheckpoints.providerId, i.providerId),
    eq(syncCheckpoints.action, CHECKPOINT_ACTION),
    eq(syncCheckpoints.checkpointScope, CHECKPOINT_SCOPE),
  );
  const [existing] = await tx.select().from(syncCheckpoints).where(scope).for("update");
  const n = i.next;
  const envelope = n.cursor === null ? null : cursorEnvelopeOf(n.cursor);

  if (i.expectedVersion === null) {
    if (existing) return { kind: "stale_rejected" }; // 规划时还没有，现在有了：别的批次先建了
    if (n.anchor === "keep") return { kind: "stale_rejected" }; // blocked 必然有旧锚点；没有就是不一致，不凭空建
    await tx.insert(syncCheckpoints).values({
      accountId: i.accountId,
      providerId: i.providerId,
      action: CHECKPOINT_ACTION,
      checkpointScope: CHECKPOINT_SCOPE,
      anchorMode: n.anchor.mode,
      highWatermarkPublishedAt: n.anchor.highWatermarkPublishedAt,
      highWatermarkContentIds: n.anchor.highWatermarkContentIds,
      cursorEnvelope: envelope,
      cursorSha256: envelope === null ? null : jcsSha256(envelope),
      cursorTaskId: i.fence.taskId,
      lastSuccessfulBatchId: i.batchId,
      lastSuccessfulTaskId: i.fence.taskId,
      continuityStatus: n.continuity,
      lastGapAt: n.gapAt,
      version: 1n,
      updatedAt: i.now,
    });
    return { kind: "created", version: 1n };
  }

  if (!existing || existing.version !== i.expectedVersion) return { kind: "stale_rejected" };
  const set =
    n.anchor === "keep"
      ? { continuityStatus: n.continuity, version: sql`${syncCheckpoints.version} + 1`, updatedAt: i.now }
      : {
          anchorMode: n.anchor.mode,
          highWatermarkPublishedAt: n.anchor.highWatermarkPublishedAt,
          highWatermarkContentIds: n.anchor.highWatermarkContentIds,
          cursorEnvelope: envelope,
          cursorSha256: envelope === null ? null : jcsSha256(envelope),
          cursorTaskId: i.fence.taskId,
          lastSuccessfulBatchId: i.batchId,
          lastSuccessfulTaskId: i.fence.taskId,
          continuityStatus: n.continuity,
          ...(n.gapAt === null ? {} : { lastGapAt: n.gapAt }),
          version: sql`${syncCheckpoints.version} + 1`,
          updatedAt: i.now,
        };
  // version 比较写进 WHERE：即使行锁被绕过，也不会写出两次推进
  const [r] = await tx.update(syncCheckpoints).set(set).where(and(scope, eq(syncCheckpoints.version, i.expectedVersion)));
  return r.affectedRows === 1 ? { kind: "advanced", version: i.expectedVersion + 1n } : { kind: "stale_rejected" };
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
