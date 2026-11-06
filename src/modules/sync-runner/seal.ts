// 账号级封口（FS-6、design §7.7、design-task5 §7）。全部函数在调用方给定的 fenced 事务里执行，不做 IO。
//
// 三条事务边界在这里落地：
//  1. 封口与任务终态在同一个事务（sealSuccess 自己写终态；失败路径由框架的 onTerminal 钩子调用 sealFailed）；
//  2. 检查点推进走 advanceCheckpoint（fencing + version 缺一不可）；
//  3. building 快照的清除只在条件 snapshot_status='building' AND batch_id=B（且内容属于该账号）下执行。
import { and, eq, inArray } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { contentDiscoveries, contentSnapshots, contents, mediaReferences, syncTasks } from "../../db/schema";
import { advanceCheckpoint, computeInitialAnchor, recordIssue, selectCurrentContentSnapshot, type AnchorEntry, type CheckpointNext, type InitialAnchor } from "../projection";
import type { Clock } from "../raw-capture";
import type { AnchorView } from "./decide-after-page";
import type { ListProgress, NextCursor } from "./list-progress";
import { lockAccount, runSelfCheck, type SelfCheckResult } from "./self-check";
import type { TypedCursor } from "../provider-adapter";

export interface SealScope {
  batchId: bigint;
  accountId: bigint;
}
interface BuildingRow {
  snapshotId: bigint;
  contentId: bigint;
  publishedAt: Date | null;
  platformContentId: string;
}

/** 该账号本批次所有 building 快照（锁行）。条件三要素：snapshot_status='building'、batch_id=B、内容属于该账号。 */
export async function loadBuilding(tx: DbTx, s: SealScope): Promise<BuildingRow[]> {
  return tx
    .select({ snapshotId: contentSnapshots.contentSnapshotId, contentId: contentSnapshots.contentId, publishedAt: contentSnapshots.publishedAt, platformContentId: contents.platformContentId })
    .from(contentSnapshots)
    .innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId))
    .where(and(eq(contentSnapshots.batchId, s.batchId), eq(contents.accountId, s.accountId), eq(contentSnapshots.snapshotStatus, "building")))
    .orderBy(contentSnapshots.contentId)
    .for("update");
}

/** 定稿并切换 current（按 (logical_at, batch_id) 严格更新，旧批次迟到不回退）。 */
export async function finalizeBuilding(tx: DbTx, s: SealScope, rows: readonly BuildingRow[], now: Date): Promise<{ finalized: number; currentChanged: number }> {
  if (rows.length === 0) return { finalized: 0, currentChanged: 0 };
  const [r] = await tx
    .update(contentSnapshots)
    .set({ snapshotStatus: "finalized", finalizedAt: now, updatedAt: now })
    .where(and(inArray(contentSnapshots.contentSnapshotId, rows.map((x) => x.snapshotId)), eq(contentSnapshots.snapshotStatus, "building"), eq(contentSnapshots.batchId, s.batchId)));
  let currentChanged = 0;
  for (const row of rows) if (await selectCurrentContentSnapshot(tx, row.contentId, row.snapshotId, now)) currentChanged++;
  return { finalized: r.affectedRows, currentChanged };
}

/**
 * 条件清除 building 快照（列表作者 mismatch：这些条目不可靠）。外键无级联，所以先删这些快照的 pending 媒资引用。
 * 已定稿的快照、其他批次的快照、其他账号的内容都不会匹配。contents / content_discoveries 保留（只追加的历史）。
 */
export async function purgeBuilding(tx: DbTx, s: SealScope): Promise<number> {
  const rows = await loadBuilding(tx, s);
  if (rows.length === 0) return 0;
  const ids = rows.map((x) => x.snapshotId);
  await tx.delete(mediaReferences).where(and(inArray(mediaReferences.contentSnapshotId, ids), eq(mediaReferences.archiveStatus, "pending")));
  const [r] = await tx.delete(contentSnapshots).where(and(inArray(contentSnapshots.contentSnapshotId, ids), eq(contentSnapshots.snapshotStatus, "building"), eq(contentSnapshots.batchId, s.batchId)));
  return r.affectedRows;
}

/** 失败 / 取消的封口：mismatch 的条目不可靠，清除；其余已投影的整页条目是供应商已返回的事实，定稿。检查点不动。 */
export async function sealFailed(tx: DbTx, s: SealScope, o: { mismatch: boolean; now: Date }): Promise<{ finalized: number; purged: number }> {
  if (o.mismatch) return { finalized: 0, purged: await purgeBuilding(tx, s) };
  const rows = await loadBuilding(tx, s);
  return { finalized: (await finalizeBuilding(tx, s, rows, o.now)).finalized, purged: 0 };
}

const toTyped = (c: NextCursor | null): TypedCursor | null => c;

/** 用本轮已获取的全部内容重建锚点：有有效发布时间 → time；否则首页（page_no=0）内容 ID → id_window；全空 → empty。 */
async function rebuildAnchor(tx: DbTx, batchId: bigint, assignmentId: bigint, rows: readonly BuildingRow[]): Promise<InitialAnchor> {
  const entries: AnchorEntry[] = rows.map((r) => ({
    platformContentId: r.platformContentId,
    publishedAtMs: r.publishedAt ? { state: "value", value: BigInt(r.publishedAt.getTime()) } : { state: "missing" },
  }));
  if (entries.some((e) => e.publishedAtMs.state === "value") || entries.length === 0) return computeInitialAnchor(entries);
  const first = await tx
    .select({ id: contents.platformContentId })
    .from(contentDiscoveries)
    .innerJoin(contents, eq(contents.contentId, contentDiscoveries.contentId))
    .where(and(eq(contentDiscoveries.batchId, batchId), eq(contentDiscoveries.assignmentId, assignmentId), eq(contentDiscoveries.pageNo, 0)))
    .orderBy(contentDiscoveries.absolutePosition);
  return computeInitialAnchor(first.map((f) => ({ platformContentId: f.id, publishedAtMs: { state: "missing" } })));
}

export interface SealSuccessInput {
  /** withFences 锁定的列表任务行。 */
  task: typeof syncTasks.$inferSelect;
  token: bigint;
  assignmentId: bigint;
  progress: ListProgress;
  /** 规划时冻结的旧检查点。 */
  oldAnchor: AnchorView;
  expectedCheckpointVersion: bigint | null;
  now: Date;
}
export interface SealSuccessResult {
  taskStatus: "succeeded" | "succeeded_with_gap";
  outcome: "success" | "gap" | "blocked";
  stopReason: string;
  checkpoint: "created" | "advanced" | "stale_rejected";
  finalized: number;
  currentChanged: number;
  newAnchorMode: string | null;
  selfCheck: SelfCheckResult;
}

/**
 * 成功 / 带缺口 / 空窗口的封口：定稿 + current CAS + 检查点 + 质量问题 + 任务终态，调用方把它放在同一个 withFences 里。
 * 不调用 tracer 的 settleBatch：批次汇总由 tick 的 finalizeAll 负责。
 */
export async function sealSuccess(tx: DbTx, i: SealSuccessInput): Promise<SealSuccessResult> {
  const detail = i.progress.stop_detail;
  if (!detail) throw new Error("封口需要已作出的判定（progress.stop_detail）");
  const { task, now } = i;
  if (task.accountId === null) throw new Error("列表任务缺 account_id");
  const scope: SealScope = { batchId: task.batchId, accountId: task.accountId };

  // 与 ProfileRunner 的终态事务串行化（自比对需要看到对方的结果）：先于任何写入
  await lockAccount(tx, scope.accountId);
  const rows = await loadBuilding(tx, scope);
  // 在定稿之前、同一事务里重建锚点（读的就是将要定稿的那批行）
  let outcome = detail.outcome;
  let stopReason = detail.stop_reason;
  let anchor: InitialAnchor | "keep" = "keep";
  if (detail.anchor === "empty") anchor = { mode: "empty", highWatermarkPublishedAt: null, highWatermarkContentIds: [] };
  else if (detail.anchor === "rebuild") {
    const rebuilt = await rebuildAnchor(tx, task.batchId, i.assignmentId, rows);
    if (rebuilt.mode === "empty" && (i.oldAnchor.mode === "time" || i.oldAnchor.mode === "id_window")) {
      // 返回了条目但没有一条可投影出内容 ID：不能用「空」覆盖已有的非空锚点（CONTEXT HighWatermark）
      outcome = "blocked";
      stopReason = "empty_window_not_rebased";
    } else anchor = rebuilt;
  }

  const fin = await finalizeBuilding(tx, scope, rows, now);

  const next: CheckpointNext =
    outcome === "blocked"
      ? { anchor: "keep", continuity: "blocked", cursor: null, gapAt: null }
      : { anchor, continuity: outcome === "gap" ? "rebased_after_gap" : "ready", cursor: toTyped(i.progress.last_cursor), gapAt: outcome === "gap" ? now : null };
  const adv = await advanceCheckpoint(tx, {
    accountId: scope.accountId,
    providerId: task.providerId,
    expectedVersion: i.expectedCheckpointVersion,
    batchId: task.batchId,
    fence: { taskId: task.taskId, token: i.token },
    next,
    now,
  });
  if (adv.kind === "fence_lost") throw new Error(`封口事务内 fencing 失效：${adv.reason}`); // withFences 已校验，不应发生；抛出使整笔回滚
  const checkpoint = adv.kind === "advanced" ? "advanced" : adv.kind === "created" ? "created" : "stale_rejected";

  const base = { batchId: task.batchId, accountId: scope.accountId, assignmentId: i.assignmentId, now };
  if (outcome === "gap") {
    await recordIssue(tx, { ...base, code: "continuity_gap", severity: "warning", discriminator: stopReason, detail: { stop_reason: stopReason, pages_done: i.progress.pages_done, entries_done: i.progress.entries_done, old_anchor_mode: i.oldAnchor.mode } });
    if (detail.window_overflow) await recordIssue(tx, { ...base, code: "window_overflow", severity: "warning", discriminator: stopReason, detail: { safety_page_limit_reached_at_page: i.progress.pages_done } });
  } else if (outcome === "blocked") {
    await recordIssue(tx, { ...base, code: "empty_window_not_rebased", severity: "warning", discriminator: stopReason, detail: { old_anchor_mode: i.oldAnchor.mode, pages_done: i.progress.pages_done } });
  }

  const taskStatus = outcome === "success" ? "succeeded" : "succeeded_with_gap";
  const final = { outcome, stop_reason: stopReason, checkpoint, finalized_snapshots: fin.finalized, current_changed: fin.currentChanged, anchor_mode: anchor === "keep" ? null : anchor.mode };
  await tx
    .update(syncTasks)
    .set({
      status: taskStatus,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      stopReason,
      continuityGapDetected: outcome !== "success",
      windowOverflowDetected: outcome === "gap" && detail.window_overflow,
      resultSummary: { ...i.progress, final },
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(syncTasks.taskId, task.taskId));
  // 自比对：只告警，不影响上面写下的任何结果
  const selfCheck = await runSelfCheck(tx, { batchId: task.batchId, accountId: scope.accountId, assignmentId: i.assignmentId, now });
  return { taskStatus, outcome, stopReason, checkpoint, finalized: fin.finalized, currentChanged: fin.currentChanged, newAnchorMode: final.anchor_mode, selfCheck };
}

const TERMINAL_FAILED = ["failed", "dead", "cancelled"] as const;

/**
 * 孤儿清扫：列表任务已是 failed / dead / cancelled，却还留着本批次本账号的 building 快照。
 * 唯一来源是外部取消（cancelBatch 把任务置 cancelled，没有 fence）；失败路径的封口与终态同事务，不会留孤儿。
 * 没有 fence 但安全：终态任务不可能再有 fenced 写入，且这里先锁任务行再确认仍是终态。
 */
export async function sweepOrphanBuilding(db: Db, clock: Clock, o: { limit?: number; scope?: SealScope } = {}): Promise<{ tasks: number; finalized: number; purged: number }> {
  const pairs = await db
    .selectDistinct({ batchId: contentSnapshots.batchId, accountId: contents.accountId })
    .from(contentSnapshots)
    .innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId))
    .where(and(eq(contentSnapshots.snapshotStatus, "building"), ...(o.scope ? [eq(contentSnapshots.batchId, o.scope.batchId), eq(contents.accountId, o.scope.accountId)] : [])))
    .limit(o.limit ?? 500);
  const out = { tasks: 0, finalized: 0, purged: 0 };
  for (const p of pairs) {
    await db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(syncTasks)
        .where(and(eq(syncTasks.batchId, p.batchId), eq(syncTasks.accountId, p.accountId), eq(syncTasks.requestedAction, "fetch_content_list")))
        .for("update")
        .limit(1);
      if (!task || !(TERMINAL_FAILED as readonly string[]).includes(task.status)) return;
      const summary = task.resultSummary as { identity_check?: { state?: string } } | null;
      const r = await sealFailed(tx, { batchId: p.batchId, accountId: p.accountId }, { mismatch: summary?.identity_check?.state === "mismatch", now: clock.now() });
      out.tasks++;
      out.finalized += r.finalized;
      out.purged += r.purged;
    });
  }
  return out;
}
