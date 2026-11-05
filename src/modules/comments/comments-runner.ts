// fetch_comments（FS-10、design §7.9）：一级评论最新态。事务边界与列表走法一致：
//   请求第 N 页 = 网关（无事务）→ 页事务（整页 upsert + 进度，一个 withFences）→ 收尾事务（疑似删除 + 质量问题 + 任务终态）。
// 评论抓取不写内容快照结构化字段，不阻塞快照定稿（FS-10.7）。
import { eq } from "drizzle-orm";
import { z } from "zod";
import { contents, contentSnapshots, odsProviderCalls, syncTasks } from "../../db/schema";
import { withFences } from "../orchestrator";
import { recordIssue } from "../projection";
import { buildContentUrl, buildRequest, decodeComments, type RequestCursor } from "../provider-adapter";
import { platformCodeOf, type AccountRunnerDeps } from "../sync-runner/account-deps";
import { callDecoded, capabilityFailure } from "../sync-runner/call";
import type { RunnerOutcome, TaskContext, TaskRunner } from "../sync-runner/types";
import { COMMENTS_POLICY, coverageOf, decideAfterCommentsPage, isCommentsPlatform, isCompleteFetch, type CommentsStop } from "./policy";
import { markSuspectedDeleted, upsertComments } from "./project";

export const COMMENTS_SCHEMA = "sync-comments-task.v1";
const paramsSchema = z.looseObject({
  schema_version: z.literal(COMMENTS_SCHEMA),
  mode: z.enum(["synchronous", "asynchronous"]),
  content_id: z.string().regex(/^[1-9]\d*$/),
  page_limit: z.number().int().positive().nullable(),
  item_limit: z.number().int().positive().nullable(),
});

const cursorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("integer"), lexeme: z.string().regex(/^-?\d+$/) }),
  z.strictObject({ kind: z.literal("string"), value: z.string().min(1) }),
]);
export const COMMENTS_PROGRESS = "comments-progress.v1";
const progressSchema = z.strictObject({
  schema: z.literal(COMMENTS_PROGRESS),
  pages_done: z.number().int().nonnegative(),
  items_done: z.number().int().nonnegative(),
  ignored_replies: z.number().int().nonnegative(),
  invalid_entries: z.number().int().nonnegative(),
  /** 平台报告的总评论数（含回复），十进制字符串；缺失 / 非法为 null。 */
  reported_total: z.string().nullable(),
  fetch_started_at: z.string(),
  next_cursor: cursorSchema.nullable(),
  stop: z.enum(["natural_end", "page_limit", "item_limit", "cursor_anomaly", "has_more_invalid"]).nullable(),
  final: z.looseObject({}).optional(),
});
export type CommentsProgress = z.infer<typeof progressSchema>;

const FIRST: RequestCursor = { kind: "integer", lexeme: "0" };
const abandonedOf = (reason: string): RunnerOutcome => ({ kind: "abandoned", reason: reason === "cancelled" ? "cancelled" : "stale" });

export function createCommentsRunner(deps: AccountRunnerDeps): TaskRunner {
  const { db, clock } = deps;
  return async (ctx: TaskContext): Promise<RunnerOutcome> => {
    const task = ctx.task;
    const parsed = paramsSchema.safeParse(task.taskParameters);
    if (!parsed.success || task.contentId === null || task.accountId === null || BigInt(parsed.data.content_id) !== task.contentId) return { kind: "failure", code: "task_parameters_invalid" };
    const params = parsed.data;
    const contentId = task.contentId;
    const accountId = task.accountId;
    const platform = await platformCodeOf(db, task.platformId);
    // 快手没有评论 capability（D-51）：提交时已拒绝，这里是防御
    if (!platform || !isCommentsPlatform(platform)) return { kind: "failure", code: "unsupported_platform" };
    // 翻页的 call_sequence 是页号；异步轮询会与下一页冲突，评论只走同步
    if (params.mode !== "synchronous") return { kind: "failure", code: "capability_disabled", detail: { reason: "comments_async_not_supported" } };
    const gate = capabilityFailure(deps, platform, "post_comments_list", params.mode);
    if (gate) return { kind: "failure", code: gate };
    const [content] = await db.select().from(contents).where(eq(contents.contentId, contentId));
    if (!content || content.accountId !== accountId) return { kind: "failure", code: "task_parameters_invalid", detail: { reason: "content_account_mismatch" } };
    const [src] = content.currentSnapshotId === null ? [] : await db.select({ shareUrl: contentSnapshots.shareUrl }).from(contentSnapshots).where(eq(contentSnapshots.contentSnapshotId, content.currentSnapshotId));
    const url = buildContentUrl(platform, { postId: content.platformContentId, shareUrl: src?.shareUrl ?? null });
    if (!url.ok) return { kind: "failure", code: "content_url_unavailable" };

    const loaded = task.resultSummary == null ? null : progressSchema.parse(task.resultSummary);
    let progress: CommentsProgress | null = loaded;
    const startedAt = progress ? new Date(progress.fetch_started_at) : clock.now();

    while (!progress?.stop) {
      if (ctx.shouldStop()) return { kind: "abandoned", reason: "shutdown" };
      const pageNo = (progress?.pages_done ?? 0) + 1;
      const r = await callDecoded(deps, ctx, {
        platform,
        action: "post_comments_list",
        mode: params.mode,
        seq: pageNo,
        request: buildRequest({ action: "post_comments_list", mode: params.mode, locator: url.url, cursor: progress?.next_cursor ?? FIRST }),
        decode: (bytes) => decodeComments(platform, bytes),
      });
      if (r.kind === "abandoned") return { kind: "abandoned", reason: r.reason };
      if (r.kind === "failed") return { kind: "failure", code: r.code, ...(r.detail ? { detail: r.detail } : {}) };

      await deps.hooks?.beforePageProjection?.();
      const callId = r.captured.providerCallId;
      const [call] = await db.select({ at: odsProviderCalls.responseReceivedAt }).from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, callId));
      const data = r.data;
      let committed;
      try {
        committed = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
          const now = clock.now();
          const prev: CommentsProgress = progress ?? { schema: COMMENTS_PROGRESS, pages_done: 0, items_done: 0, ignored_replies: 0, invalid_entries: 0, reported_total: null, fetch_started_at: startedAt.toISOString(), next_cursor: null, stop: null };
          const up = await upsertComments(tx, { contentId, entries: data.entries, providerCallId: callId, now: call?.at ?? now });
          if (up.invalid.length > 0) {
            await recordIssue(tx, { code: "field_contract_anomaly", severity: "warning", batchId: task.batchId, accountId, contentId, providerCallId: callId, discriminator: `comments.invalid_id:${pageNo}`, detail: { reason: "comment_id_unusable", page_no: pageNo, entries: up.invalid }, now });
          }
          const pages = prev.pages_done + 1;
          const items = prev.items_done + up.upserted;
          const step = decideAfterCommentsPage({ hasMore: data.hasMore, cursor: data.maxCursor }, { pages, items }, { pageLimit: params.page_limit, itemLimit: params.item_limit });
          const next: CommentsProgress = {
            ...prev,
            pages_done: pages,
            items_done: items,
            ignored_replies: prev.ignored_replies + data.ignoredReplyCount,
            invalid_entries: prev.invalid_entries + up.invalid.length,
            reported_total: data.total.state === "value" ? data.total.value.toString() : prev.reported_total,
            next_cursor: step.action === "continue" ? step.nextCursor : null,
            stop: step.action === "stop" ? step.reason : null,
          };
          await tx.update(syncTasks).set({ resultSummary: next, pageCount: pages, fetchedItemCount: items, hasMoreAtStop: data.hasMore.state === "value" ? data.hasMore.value : null, updatedAt: now }).where(eq(syncTasks.taskId, task.taskId));
          return next;
        });
      } catch {
        return { kind: "failure", code: "page_projection_failed", detail: { page_no: pageNo } };
      }
      if (!committed.ok) return abandonedOf(committed.reason);
      progress = committed.value;
      await deps.hooks?.afterPageProjection?.();
    }

    // ── 收尾 ──
    const final = progress;
    const stop: CommentsStop = final.stop!;
    const total = final.reported_total === null ? null : BigInt(final.reported_total);
    const complete = isCompleteFetch(platform, stop, final.items_done, total);
    const done = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
      const now = clock.now();
      const marked = complete ? await markSuspectedDeleted(tx, { contentId, fetchStartedAt: new Date(final.fetch_started_at), now }) : 0;
      const issue = (code: string, detail: Record<string, unknown>) => recordIssue(tx, { code, severity: "warning", batchId: task.batchId, accountId, contentId, discriminator: code, detail, now });
      // total>0 而一条都没抓到：不是「0 条评论」，是需要人看的异常（D-50）
      if (total !== null && total > 0n && final.items_done === 0) await issue("comments_total_mismatch", { reported_total: total.toString(), fetched: 0 });
      // 没有完整抓取且总数大于已抓条数：下游不得把它当完整（小红书永远如此）
      else if (!complete && total !== null && total > BigInt(final.items_done)) {
        await issue("comment_coverage_incomplete", { reported_total: total.toString(), fetched: final.items_done, reason: stop === "page_limit" ? "page_limit" : stop === "item_limit" ? "item_limit" : "platform_partial" });
      }
      const summary = { ...final, final: { complete, coverage: coverageOf(complete, final.items_done, total, stop), fetched: final.items_done, reported_total: final.reported_total, suspected_deleted_marked: marked, platform_policy: COMMENTS_POLICY[platform].completeWhen, fetched_at: now.toISOString() } };
      await tx
        .update(syncTasks)
        .set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, lastErrorCode: null, lastErrorDetail: null, stopReason: stop, resultSummary: summary, finishedAt: now, updatedAt: now })
        .where(eq(syncTasks.taskId, task.taskId));
    });
    return done.ok ? { kind: "done" } : abandonedOf(done.reason);
  };
}
