// fetch_content_detail（FS-9、design §7.8）：URL 构造 → media_stats_number → 种子快照 → 合并 → 定稿 → current 比较。
// 事务边界：读（无事务）→ 网关调用（无事务）→ 一个终态 fenced 事务（种子快照 + 合并 + 定稿 + current + 后续媒资任务 + 任务终态）。
// 失败不建种子快照（种子只在成功的终态事务里才存在）、不改内容 status、不把失败写成播放数 0。
import { eq } from "drizzle-orm";
import { z } from "zod";
import { contents, contentSnapshots, mediaReferences, odsProviderCalls, syncTasks } from "../../db/schema";
import { sha256Utf8 } from "../canonical-json";
import { MEDIA_VIDEO_TASK_SCHEMA, insertDemandTask } from "../demand/tasks";
import { withFences } from "../orchestrator";
import { insertDetailSnapshot, recordIssue } from "../projection";
import { buildContentUrl, buildRequest, decodeDetail, profileAttemptOutcomeOf, rankVideoSources, type DetailData, type ExecutionMode, type Platform } from "../provider-adapter";
import { platformCodeOf, type AccountRunnerDeps } from "./account-deps";
import { callDecoded, capabilityFailure, type CallResult } from "./call";
import type { RunnerOutcome, TaskContext, TaskRunner, TerminalHook } from "./types";

export const DETAIL_SCHEMA = "sync-detail-task.v1";
const paramsSchema = z.looseObject({
  schema_version: z.literal(DETAIL_SCHEMA),
  mode: z.enum(["synchronous", "asynchronous"]),
  content_id: z.string().regex(/^[1-9]\d*$/),
  followups: z.looseObject({ roles: z.array(z.enum(["video", "audio"])) }),
});

const abandonedOf = (reason: string): RunnerOutcome => ({ kind: "abandoned", reason: reason === "cancelled" ? "cancelled" : "stale" });

export function createDetailRunner(deps: AccountRunnerDeps): TaskRunner {
  const { db, clock } = deps;
  return async (ctx: TaskContext): Promise<RunnerOutcome> => {
    const task = ctx.task;
    const parsed = paramsSchema.safeParse(task.taskParameters);
    if (!parsed.success || task.contentId === null || task.accountId === null || task.assignmentId === null || BigInt(parsed.data.content_id) !== task.contentId) {
      return { kind: "failure", code: "task_parameters_invalid" };
    }
    const { mode, followups } = parsed.data;
    const contentId = task.contentId;
    const accountId = task.accountId;
    const platform = await platformCodeOf(db, task.platformId);
    if (!platform) return { kind: "failure", code: "unsupported_platform" };
    const [content] = await db.select().from(contents).where(eq(contents.contentId, contentId));
    if (!content || content.accountId !== accountId) return { kind: "failure", code: "task_parameters_invalid", detail: { reason: "content_account_mismatch" } };

    const r = await requestDetail(deps, ctx, { platform, mode, content });
    if (r.kind === "abandoned") return { kind: "abandoned", reason: r.reason };
    if (r.kind === "failed") {
      // RESULT_VALIDATION_FAILED 一类耗尽：详情不可访问。只记问题，不改内容 status（D-54）
      if (r.cls && profileAttemptOutcomeOf(r.cls) === "result_validation_failed" && task.attemptCount + 1 >= task.maxAttempts) {
        const onTerminal: TerminalHook = (tx, t) =>
          recordIssue(tx, { code: "detail_inaccessible", severity: "warning", batchId: task.batchId, accountId, contentId, providerCallId: r.providerCallId ?? null, detail: { category: r.cls!.category, attempts: task.maxAttempts, terminal_status: t.status }, now: t.now });
        return { kind: "failure", code: "detail_inaccessible", detail: { category: r.cls.category }, onTerminal };
      }
      return { kind: "failure", code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
    }

    // 响应是不是这条内容的：post_id 必须是有效值且与内容身份文本一致，否则不合并（旧系统教训：成功不等于对）
    const d = r.data;
    if (d.postId.state !== "value" || d.postId.value !== content.platformContentId) {
      return { kind: "failure", code: "invalid_response", detail: { reason: "detail_post_id_mismatch", state: d.postId.state } };
    }
    const callId = r.captured.providerCallId;
    const [call] = await db.select({ at: odsProviderCalls.responseReceivedAt }).from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, callId));
    const receivedAt = call?.at ?? clock.now();
    const sources = rankVideoSources(platform, d.downloadCandidates);

    const done = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
      const now = clock.now();
      const snap = await insertDetailSnapshot(tx, { batchId: task.batchId, contentId, data: d, call: { providerCallId: callId, adapterVersion: r.adapterVersion, receivedAt }, now });
      if (snap.kind === "no_seed") throw new Error("按需详情没有可作种子的 finalized 快照");

      let mediaFollowup: "none" | "created" | "no_source" = "none";
      if (followups.roles.length > 0) {
        if (sources.length === 0) {
          mediaFollowup = "no_source";
          await recordIssue(tx, { code: "media_archive_failed", severity: "warning", batchId: task.batchId, accountId, contentId, providerCallId: callId, discriminator: "no_download_source", detail: { reason: "no_download_source", roles: followups.roles }, now });
        } else {
          // 视频引用：首选来源；完整的有序候选集放进下载任务（逐个尝试，一个失败换下一个）
          await tx.insert(mediaReferences).values({
            contentSnapshotId: snap.contentSnapshotId,
            role: "video",
            slotIndex: 0,
            sourceLocator: sources[0]!,
            sourceLocatorSha256: sha256Utf8(sources[0]!),
            sourceJsonPath: "$.data.result.download_urls",
            observedAt: receivedAt,
            archiveStatus: "pending",
            sourceProviderCallId: callId,
            createdAt: now,
            updatedAt: now,
          });
          await insertDemandTask(tx, {
            batchId: task.batchId,
            providerId: task.providerId,
            platformId: task.platformId,
            assignmentId: task.assignmentId!,
            accountId,
            contentId,
            action: "download_media",
            params: { schema_version: MEDIA_VIDEO_TASK_SCHEMA, content_id: contentId.toString(), content_snapshot_id: snap.contentSnapshotId.toString(), roles: followups.roles, sources, detail_mode: mode },
            sourceContentSnapshotId: snap.contentSnapshotId,
            ruleDecisionId: task.ruleDecisionId,
            ruleVersion: task.ruleVersion,
            maxAttempts: task.maxAttempts,
            now,
          });
          mediaFollowup = "created";
        }
      }
      await tx
        .update(syncTasks)
        .set({
          status: "succeeded",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorDetail: null,
          resultSummary: {
            schema: "detail-result.v1",
            content_snapshot_id: snap.contentSnapshotId.toString(),
            seeded_from_snapshot_id: snap.kind === "created" ? snap.seededFromSnapshotId.toString() : null,
            current_changed: snap.kind === "created" ? snap.currentChanged : false,
            download_candidates: sources,
            cover_candidate_count: d.coverCandidates.length,
            media_followup: mediaFollowup,
            adapter_version: r.adapterVersion,
          },
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(syncTasks.taskId, task.taskId));
    });
    return done.ok ? { kind: "done" } : abandonedOf(done.reason);
  };
}

/**
 * 一次详情调用：URL 构造（抖音取最近快照的分享页地址，否则规范形式；快手没有样本 → content_url_unavailable，不猜测）
 * → capability 门控 → media_stats_number（响应动作 media_stats）→ 先捕获后解码。
 * DetailRunner 与视频下载任务的「地址过期后重新取详情」共用。
 */
export async function requestDetail(
  deps: AccountRunnerDeps,
  ctx: TaskContext,
  p: { platform: Platform; mode: ExecutionMode; content: { platformContentId: string; currentSnapshotId: bigint | null } },
): Promise<CallResult<DetailData>> {
  const { db } = deps;
  const [src] = p.content.currentSnapshotId === null ? [] : await db.select({ shareUrl: contentSnapshots.shareUrl }).from(contentSnapshots).where(eq(contentSnapshots.contentSnapshotId, p.content.currentSnapshotId));
  const url = buildContentUrl(p.platform, { postId: p.content.platformContentId, shareUrl: src?.shareUrl ?? null });
  if (!url.ok) return { kind: "failed", code: "content_url_unavailable", cls: null };
  const gate = capabilityFailure(deps, p.platform, "media_stats_number", p.mode);
  if (gate) return { kind: "failed", code: gate, cls: null };
  return callDecoded(deps, ctx, {
    platform: p.platform,
    action: "media_stats_number",
    expectedResponse: "media_stats",
    mode: p.mode,
    seq: 1,
    request: buildRequest({ action: "media_stats_number", mode: p.mode, locator: url.url }),
    decode: (bytes) => decodeDetail(p.platform, bytes),
  });
}
