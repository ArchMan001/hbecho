// download_media（scope=account_batch，FS-11.1–11.4、FS-11.8）：处理某账号某批次所有 pending 的头像 / 背景 / 封面引用，
// 以及已归档但缺标准化衍生图的引用。独立于结构化阶段：失败只是该引用的 failed / carried_forward，任务本身仍成功（警告，不回滚快照）。
// 每个引用的下载、转换、校验在数据库事务之外；每个引用一个短 fenced 事务（processOriginal）。
import { eq } from "drizzle-orm";
import { z } from "zod";
import { syncBatches, syncTasks } from "../../db/schema";
import { loadRefs, needsWork, processOriginal, type ArchiveCtx } from "../media-archive";
import { classifyMediaFailure } from "../media-failure";
import { withFences } from "../orchestrator";
import { platformCodeOf } from "./account-deps";
import type { MediaRunnerDeps } from "./media-deps";
import type { RunnerOutcome, TaskContext, TaskRunner } from "./types";

export const ACCOUNT_MEDIA_SCHEMA = "sync-media-task.v1";
const paramsSchema = z.looseObject({ schema_version: z.literal(ACCOUNT_MEDIA_SCHEMA), scope: z.literal("account_batch") });

export function createAccountMediaRunner(deps: MediaRunnerDeps): TaskRunner {
  const { db, clock } = deps;
  return async (ctx: TaskContext): Promise<RunnerOutcome> => {
    const task = ctx.task;
    if (!paramsSchema.safeParse(task.taskParameters).success || task.accountId === null) return { kind: "failure", code: "task_parameters_invalid" };
    const accountId = task.accountId;
    const platform = await platformCodeOf(db, task.platformId);
    const [batch] = await db.select().from(syncBatches).where(eq(syncBatches.batchId, task.batchId));
    if (!batch) return { kind: "failure", code: "task_parameters_invalid", detail: { reason: "batch_missing" } };

    const refs = await loadRefs(db, { batchId: task.batchId, accountId });
    const work = refs.filter((r) => needsWork(r, refs));
    const actx: ArchiveCtx = {
      deps: {
        db,
        clock,
        mediaStore: deps.mediaStore,
        location: deps.location,
        transport: deps.imageTransport,
        converter: deps.converter,
        workerId: "sync-worker",
        ...(deps.imagePolicy ? { policy: deps.imagePolicy } : {}),
        ...(deps.archiveHooks ? { hooks: deps.archiveHooks } : {}),
      },
      scope: { batchId: task.batchId, accountId, platform },
      fence: { taskId: task.taskId, token: ctx.token },
      batchOrder: { logicalAt: batch.logicalAt, batchId: batch.batchId },
      derivedMemo: new Map(),
      tally: { archived: 0, carriedForward: 0 },
    };
    for (const original of work) {
      if (ctx.shouldStop()) return { kind: "abandoned", reason: "shutdown" };
      const hb = await ctx.heartbeat();
      if (hb !== "ok") return { kind: "abandoned", reason: hb };
      const outcome = await processOriginal(actx, original);
      if (outcome !== "ok") return { kind: "abandoned", reason: outcome };
    }

    const after = await loadRefs(db, { batchId: task.batchId, accountId });
    const failed = after.filter((r) => r.archiveStatus === "failed");
    const count = (c: string) => failed.filter((r) => classifyMediaFailure(r.lastErrorCode) === c).length;
    const summary = {
      schema: "account-media-result.v1",
      references: work.length,
      archived: actx.tally.archived,
      carried_forward: actx.tally.carriedForward,
      failed_retryable: count("retryable"),
      failed_terminal: count("terminal") + count("unknown"),
      needs_fresh_url: count("needs_fresh_url"),
    };
    const done = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
      const now = clock.now();
      await tx
        .update(syncTasks)
        .set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, lastErrorCode: null, lastErrorDetail: null, stopReason: "media_done", resultSummary: summary, finishedAt: now, updatedAt: now })
        .where(eq(syncTasks.taskId, task.taskId));
    });
    return done.ok ? { kind: "done" } : { kind: "abandoned", reason: done.reason === "cancelled" ? "cancelled" : "stale" };
  };
}
