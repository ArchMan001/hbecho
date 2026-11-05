// fetch_content_list（FS-5、FS-6、FS-7；design-task5 §4–§7）：多页列表 + 检查点 + 缺口 + 账号级封口。
//
// 事务边界：
//   请求第 N 页 = 网关（先落 ODS 再发再落终态），**不持有数据库事务**；
//   页事务（一个 withFences）= 整页 building 投影 + 绑定 + 问题 + 作者计数 + 判定 + 页进度，要么全在要么全无；
//   封口事务（一个 withFences）= 定稿 + current CAS + 检查点 + 任务终态（seal.ts）。
// 本地 limit 只决定是否请求下一页，绝不截断已返回的页（C8）；技术失败不会变成空列表。
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "../../db/client";
import { externalAccountIdentifiers, odsProviderCalls, staffAccountAssignments, syncTasks } from "../../db/schema";
import { bindDominantListAuthor, bindSecondaryIdentifier, loadOwnerSnapshot, type IdentifierRef } from "../identity";
import { DEFAULT_STRATEGIES, withFences } from "../orchestrator";
import { contentListProjector, recordIssue, validPublishedAtMs } from "../projection";
import { buildRequest, decodeVideoList, type ListData, type RequestCursor, type TypedCursor } from "../provider-adapter";
import { platformCodeOf, type AccountRunnerDeps } from "./account-deps";
import { callDecoded, capabilityFailure } from "./call";
import { decideAfterPage, pinnedIdMatchOf, type AnchorView, type Decision, type PageFacts } from "./decide-after-page";
import { AUTHOR_NAMESPACES, PROFILE_NAMESPACE, checkListAuthors, countListAuthors } from "./identity-check";
import { afterPage, initialProgress, parseProgress, type ListProgress, type NextCursor } from "./list-progress";
import { homeLocatorOf } from "./profile-runner";
import { sealFailed, sealSuccess } from "./seal";
import type { RunnerOutcome, TaskContext, TaskRunner, TerminalHook } from "./types";

export const LIST_TASK_SCHEMA = "sync-list-task.v1";
const paramsSchema = z.looseObject({
  schema_version: z.literal(LIST_TASK_SCHEMA),
  mode: z.enum(["synchronous", "asynchronous"]),
  initial_content_limit: z.number().int().positive(),
  safety_page_limit: z.number().int().positive(),
  anchor_snapshot: z
    .looseObject({
      anchor_mode: z.enum(["time", "id_window", "empty"]),
      hw_published_at: z.string().nullable(),
      hw_content_ids: z.array(z.string()).nullable(),
      continuity_status: z.string(),
      checkpoint_version: z.string().regex(/^\d+$/),
    })
    .nullable(),
});
type ListParams = z.infer<typeof paramsSchema>;

function anchorViewOf(a: ListParams["anchor_snapshot"]): AnchorView {
  if (a === null) return { mode: "none" };
  if (a.anchor_mode === "empty") return { mode: "empty" };
  const ids = new Set(a.hw_content_ids ?? []);
  if (a.anchor_mode === "id_window") return { mode: "id_window", contentIds: ids };
  if (a.hw_published_at === null) throw new Error("time 锚点缺高水位时间");
  return { mode: "time", highWatermarkMs: BigInt(Date.parse(a.hw_published_at)), contentIds: ids };
}

const FIRST_CURSOR: RequestCursor = { kind: "integer", lexeme: "0" };
const usable = (c: TypedCursor): NextCursor | null => (c.kind === "integer" || (c.kind === "string" && c.value !== "") ? c : null);

function factsOf(pageNo: number, data: ListData): PageFacts {
  return {
    pageNo,
    entries: data.entries.map((e) => ({ position: e.position, contentId: e.postId.state === "value" ? e.postId.value : null, publishedAtMs: validPublishedAtMs(e.publishedAtMs) })),
    hasMore: data.hasMore,
    cursor: data.maxCursor,
  };
}

const abandonedOf = (reason: string): RunnerOutcome => ({ kind: "abandoned", reason: reason === "cancelled" ? "cancelled" : "stale" });

export function createListWalker(deps: AccountRunnerDeps): TaskRunner {
  const { db, clock } = deps;
  const strategies = deps.strategies ?? DEFAULT_STRATEGIES;
  const projector = deps.projector ?? contentListProjector;

  return async (ctx: TaskContext): Promise<RunnerOutcome> => {
    const task = ctx.task;
    const parsed = paramsSchema.safeParse(task.taskParameters);
    if (!parsed.success || task.accountId === null || task.assignmentId === null) return { kind: "failure", code: "task_parameters_invalid" };
    const params = parsed.data;
    const accountId = task.accountId;
    const assignmentId = task.assignmentId;
    const scope = { batchId: task.batchId, accountId };

    const platform = await platformCodeOf(db, task.platformId);
    const strategy = platform ? strategies[platform] : undefined;
    if (!platform || !strategy) return { kind: "failure", code: "unsupported_platform" };
    // external 型只采主页（R7）：规划不会生成列表任务；防御
    const [assignment] = await db.select({ watchType: staffAccountAssignments.watchType }).from(staffAccountAssignments).where(eq(staffAccountAssignments.assignmentId, assignmentId));
    if (!assignment || assignment.watchType === "external") return { kind: "failure", code: "unsupported_action", detail: { reason: "external_has_no_list" } };
    // 周期列表只走同步（design §14.4）：异步轮询的 call_sequence 会与下一页冲突，也没有证据
    if (params.mode !== "synchronous") return { kind: "failure", code: "capability_disabled", detail: { reason: "list_async_not_supported" } };
    const gate = capabilityFailure(deps, platform, "user_video_list", params.mode);
    if (gate) return { kind: "failure", code: gate };
    const locator = await homeLocatorOf(db, assignmentId);
    if (locator === null) return { kind: "failure", code: "locator_unavailable" };

    const anchor = anchorViewOf(params.anchor_snapshot);
    const blocked = params.anchor_snapshot?.continuity_status === "blocked";
    const expectedVersion = params.anchor_snapshot ? BigInt(params.anchor_snapshot.checkpoint_version) : null;

    let progress: ListProgress | null = parseProgress(task.resultSummary);

    /** 终态钩子：失败 / 死信 / 取消时封口已投影的可靠条目（mismatch 则条件清除）。retry_wait 不执行。 */
    const closeOnTerminal = (extra?: TerminalHook): TerminalHook => async (tx, t) => {
      await sealFailed(tx, scope, { mismatch: progress?.identity_check.state === "mismatch", now: t.now });
      await extra?.(tx, t);
    };
    const fail = (code: Extract<RunnerOutcome, { kind: "failure" }>["code"], detail?: Record<string, unknown>, extra?: TerminalHook): RunnerOutcome => ({
      kind: "failure",
      code,
      ...(detail ? { detail } : {}),
      onTerminal: closeOnTerminal(extra),
    });

    const author = async (tx: DbTx) =>
      new Set(
        (
          await tx
            .select({ v: externalAccountIdentifiers.identifierValue })
            .from(externalAccountIdentifiers)
            .where(and(eq(externalAccountIdentifiers.accountId, accountId), inArray(externalAccountIdentifiers.namespaceCode, [...AUTHOR_NAMESPACES[platform]])))
        ).map((r) => r.v),
      );

    /** 页事务。要么整页 + 进度一起提交，要么什么都不留。 */
    const pageTx = (pageNo: number, data: ListData, callId: bigint, receivedAt: Date) =>
      withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx, tasks) => {
        const now = clock.now();
        const lockedTask = tasks.get(task.taskId)!;
        // 1) 本任务开始时登记的作者标识：第 1 页在任何绑定之前读（小红书首次主导作者绑定是本任务造的，不能拿来验证本任务）
        const registered = await author(tx);
        const prev = progress ?? initialProgress(registered.size > 0);

        // 2) 整页 building 投影
        const owner = await loadOwnerSnapshot(tx, assignmentId);
        const res = await projector.projectCompletePage(tx, {
          batchId: task.batchId,
          platformId: task.platformId,
          accountId,
          assignmentId,
          owner,
          sourceProviderCallId: callId,
          adapterVersion: "aimaster-adapter.v1",
          receivedAt,
          pageNo: pageNo - 1,
          page: data,
          now,
          mode: "building",
          positionOffset: prev.entries_done,
        });

        const issue = (code: string, severity: "info" | "warning" | "error", discriminator: string, detail: Record<string, unknown>) =>
          recordIssue(tx, { code, severity, batchId: task.batchId, accountId, assignmentId, providerCallId: callId, discriminator, detail, now });

        // 3) 第 1 页的第二标识 / 主导作者绑定（首页完整页上算一次）
        if (pageNo === 1) {
          const [primaryRow] = await tx
            .select({ v: externalAccountIdentifiers.identifierValue })
            .from(externalAccountIdentifiers)
            .where(and(eq(externalAccountIdentifiers.accountId, accountId), eq(externalAccountIdentifiers.namespaceCode, PROFILE_NAMESPACE[platform])))
            .limit(1);
          if (primaryRow) {
            const primary: IdentifierRef = { namespace: PROFILE_NAMESPACE[platform], value: primaryRow.v };
            const { bindings, issues } = strategy.listBindings({ primary, page: data, batchId: task.batchId });
            for (const b of bindings) {
              const bound =
                b.method === "same_payload"
                  ? await bindSecondaryIdentifier(tx, { accountId, ref: b.ref, now })
                  : await bindDominantListAuthor(tx, { accountId, evidence: b.evidence, batchId: task.batchId, now });
              if (bound.kind === "bound_to_other_account") {
                const namespace = b.method === "same_payload" ? b.ref.namespace : b.evidence.candidate_identifier!.namespace;
                await issue("identity_conflict", "warning", `${namespace}.bound_elsewhere`, { namespace, other_account_id: bound.otherAccountId.toString() });
              }
            }
            for (const i of issues) await issue(i.code, i.severity, i.discriminator, i.detail);
          }
        }

        // 4) 页必须全部到达终态，否则整页回滚、进度不前进
        if (res.processedEntries !== res.returnedEntries) throw new PageIncompleteError(res.processedEntries, res.returnedEntries);
        if (res.unprojectable.length > 0) await issue("field_contract_anomaly", "warning", "list.entry.post_id_unusable", { reason: "entry_unprojectable", page_no: pageNo, entries: res.unprojectable });
        if (res.duplicates.length > 0) {
          await issue("field_contract_anomaly", "warning", "list.duplicate_entries", {
            reason: "duplicate_list_entries",
            page_no: pageNo,
            entries: res.duplicates.map((d) => ({ platform_content_id: d.platformContentId, positions: d.positions })),
          });
        }

        // 5) 列表作者三态（累计）
        const counted = countListAuthors(data.entries, registered);
        const known = prev.identity_check.known_author_entries + counted.known;
        const matched = prev.identity_check.matched_entries + counted.matched;
        const identity = { baseline_has_registered: prev.identity_check.baseline_has_registered, known_author_entries: known, matched_entries: matched, state: checkListAuthors({ baselineHasRegistered: prev.identity_check.baseline_has_registered, knownAuthorEntries: known, matchedEntries: matched }) };

        // 6) 判定（纯函数）
        const facts = factsOf(pageNo, data);
        const cumulative = prev.entries_done + data.entries.length;
        const pinned = pinnedIdMatchOf(anchor, facts);
        const decision: Decision = decideAfterPage(anchor, facts, { cumulativeEntries: cumulative, pinnedIdMatch: prev.pinned_id_match || pinned }, { safetyPageLimit: params.safety_page_limit, initialContentLimit: params.initial_content_limit, blocked });
        if (decision.action === "stop") {
          for (const a of decision.anomalies) {
            await issue(a.code, "warning", `${a.code}:${pageNo}`, { ...a, page_no: pageNo, has_more: data.hasMore.state === "value" ? data.hasMore.value : data.hasMore.state, cursor_kind: data.maxCursor.kind });
          }
        }

        // 7) 进度 + 任务计数列，同一事务
        const next = afterPage(prev, { entriesInPage: data.entries.length, decision, pinnedIdMatch: pinned, identity, lastCursor: usable(data.maxCursor), callId, anomalies: decision.action === "stop" ? decision.anomalies : [] });
        const times = data.entries.map((e) => validPublishedAtMs(e.publishedAtMs)).filter((x): x is bigint => x !== null).map((x) => Number(x));
        const oldest = Math.min(...times, ...(lockedTask.oldestPublishedAt ? [lockedTask.oldestPublishedAt.getTime()] : []));
        const newest = Math.max(...times, ...(lockedTask.newestPublishedAt ? [lockedTask.newestPublishedAt.getTime()] : []));
        await tx
          .update(syncTasks)
          .set({
            resultSummary: next,
            pageCount: next.pages_done,
            fetchedItemCount: next.entries_done,
            hasMoreAtStop: data.hasMore.state === "value" ? data.hasMore.value : null,
            ...(Number.isFinite(oldest) ? { oldestPublishedAt: new Date(oldest) } : {}),
            ...(Number.isFinite(newest) ? { newestPublishedAt: new Date(newest) } : {}),
            updatedAt: now,
          })
          .where(eq(syncTasks.taskId, task.taskId));
        return next;
      });

    // ── 逐页：请求（无事务）→ 页事务 ───────────────────────────────
    for (;;) {
      if (progress?.identity_check.state === "mismatch") break;
      if (progress?.stop) break;
      if (ctx.shouldStop()) return { kind: "abandoned", reason: "shutdown" };

      const pageNo = (progress?.pages_done ?? 0) + 1;
      const cursor: RequestCursor = progress?.next_cursor ?? FIRST_CURSOR;
      const r = await callDecoded(deps, ctx, {
        platform,
        action: "user_video_list",
        mode: params.mode,
        seq: pageNo,
        request: buildRequest({ action: "user_video_list", mode: params.mode, locator, cursor }),
        decode: (bytes) => decodeVideoList(platform, bytes),
      });
      if (r.kind === "abandoned") return { kind: "abandoned", reason: r.reason };
      if (r.kind === "failed") return fail(r.code, r.detail);

      await deps.hooks?.beforePageProjection?.();
      const receivedAt = (await callReceivedAt(db, r.captured.providerCallId)) ?? clock.now();
      let committed;
      try {
        committed = await pageTx(pageNo, r.data, r.captured.providerCallId, receivedAt);
      } catch (e) {
        // 整页事务已回滚：技术失败不会变成空列表，进度不前进
        return fail("page_projection_failed", { reason: e instanceof PageIncompleteError ? "page_incomplete" : "page_projection_failed", page_no: pageNo });
      }
      if (!committed.ok) return abandonedOf(committed.reason);
      progress = committed.value;
      await deps.hooks?.afterPageProjection?.();
    }

    // ── 身份校验失败：这些条目不可靠，不定稿（清除由终态钩子在写终态的同一事务里做） ──
    if (progress?.identity_check.state === "mismatch") {
      const id = progress.identity_check;
      return fail("list_author_mismatch", { known_author_entries: id.known_author_entries }, (tx, t) =>
        recordIssue(tx, {
          code: "list_author_mismatch",
          severity: "error",
          batchId: task.batchId,
          accountId,
          assignmentId,
          discriminator: "no_registered_author",
          detail: { known_author_entries: id.known_author_entries, matched_entries: id.matched_entries, pages_done: progress?.pages_done ?? 0, terminal_status: t.status },
          now: t.now,
        }),
      );
    }

    // ── 封口 ──
    await deps.hooks?.beforeSeal?.();
    const sealed = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], (tx, tasks) =>
      sealSuccess(tx, { task: tasks.get(task.taskId)!, token: ctx.token, assignmentId, progress: progress!, oldAnchor: anchor, expectedCheckpointVersion: expectedVersion, now: clock.now() }),
    );
    return sealed.ok ? { kind: "done" } : abandonedOf(sealed.reason);
  };
}

class PageIncompleteError extends Error {
  constructor(processed: number, returned: number) {
    super(`页未处理完：已处理 ${processed} / 返回 ${returned}`);
    this.name = "PageIncompleteError";
  }
}

async function callReceivedAt(db: Db, providerCallId: bigint): Promise<Date | null> {
  const [c] = await db.select({ at: odsProviderCalls.responseReceivedAt }).from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, providerCallId));
  return c?.at ?? null;
}
