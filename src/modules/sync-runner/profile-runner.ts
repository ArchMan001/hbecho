// fetch_profile（FS-4、design-task5 §3）：已存在账号的主页快照。
//
// 事务边界：读（无事务）→ 调用（网关，网络 IO，无事务）→ 校验（内存）→ 一个终态 fenced 事务
// （主页快照 + current CAS + 自动解决旧问题 + 任务 succeeded）。技术失败不写快照、不改账号状态、不把指标写成 0。
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "../../db/client";
import { dataQualityIssues, externalAccountIdentifiers, odsProviderCalls, staffAccountAssignments, syncTasks } from "../../db/schema";
import { withFences } from "../orchestrator";
import { projectProfile, recordIssue } from "../projection";
import { buildRequest, classifyLocator, decodeProfile, effectiveMode, profileAttemptOutcomeOf } from "../provider-adapter";
import { platformCodeOf, type AccountRunnerDeps } from "./account-deps";
import { callDecoded, capabilityFailure } from "./call";
import { checkProfileFields, checkProfileIdentity } from "./identity-check";
import { lockAccount, runSelfCheck } from "./self-check";
import type { RunnerOutcome, TaskContext, TaskRunner, TerminalHook } from "./types";

export const PROFILE_TASK_SCHEMA = "sync-profile-task.v1";
const paramsSchema = z.looseObject({ schema_version: z.literal(PROFILE_TASK_SCHEMA), mode: z.enum(["synchronous", "asynchronous"]) });

export const ACCOUNT_INACCESSIBLE = "account_inaccessible_suspected";

/** 该账号入口：优先已解析的主页地址；没有则对当前入口做清洗。只用来**发请求**，不是身份基准（D11）。 */
export async function homeLocatorOf(db: Db, assignmentId: bigint): Promise<string | null> {
  const [a] = await db
    .select({ resolved: staffAccountAssignments.resolvedHomeUrl, current: staffAccountAssignments.currentHomeLocator })
    .from(staffAccountAssignments)
    .where(eq(staffAccountAssignments.assignmentId, assignmentId));
  if (!a) return null;
  if (a.resolved.trim() !== "") return a.resolved;
  const d = classifyLocator(a.current);
  return d.action === "reject" || d.cleaned.trim() === "" ? null : d.cleaned;
}

const abandonedOf = (reason: string): RunnerOutcome => ({ kind: "abandoned", reason: reason === "cancelled" ? "cancelled" : "stale" });

export function createProfileRunner(deps: AccountRunnerDeps): TaskRunner {
  const { db, clock } = deps;

  return async (ctx: TaskContext): Promise<RunnerOutcome> => {
    const task = ctx.task;
    const params = paramsSchema.safeParse(task.taskParameters);
    if (!params.success || task.accountId === null || task.assignmentId === null) return { kind: "failure", code: "task_parameters_invalid" };
    const accountId = task.accountId;
    const assignmentId = task.assignmentId;

    const platform = await platformCodeOf(db, task.platformId);
    if (!platform) return { kind: "failure", code: "unsupported_platform" };
    const locator = await homeLocatorOf(db, assignmentId);
    if (locator === null) return { kind: "failure", code: "locator_unavailable" };
    // 同步失败（超时 / 结果不明 / RESULT_VALIDATION_FAILED）之后的重试改走异步（刘学奎 2026-11-06 确认）
    const mode = effectiveMode({ configured: params.data.mode, platform, action: "media_user_info", environment: deps.environment, attemptCount: task.attemptCount, lastErrorCode: task.lastErrorCode, lastErrorDetail: task.lastErrorDetail });
    const gate = capabilityFailure(deps, platform, "media_user_info", mode);
    if (gate) return { kind: "failure", code: gate };

    const r = await callDecoded(deps, ctx, {
      platform,
      action: "media_user_info",
      mode,
      seq: 1,
      request: buildRequest({ action: "media_user_info", mode, locator }),
      decode: (bytes) => decodeProfile(platform, bytes),
    });
    if (r.kind === "abandoned") return { kind: "abandoned", reason: r.reason };
    if (r.kind === "failed") {
      // RESULT_VALIDATION_FAILED 一类：可能是私密 / 已删除 / 无效主页，也可能是供应商间歇失败。重试耗尽才下结论，且**不改账号状态**（FS-4.5）
      if (r.cls && profileAttemptOutcomeOf(r.cls) === "result_validation_failed" && task.attemptCount + 1 >= task.maxAttempts) {
        const onTerminal: TerminalHook = (tx, t) =>
          recordIssue(tx, {
            code: ACCOUNT_INACCESSIBLE,
            severity: "warning",
            batchId: task.batchId,
            accountId,
            assignmentId,
            providerCallId: r.providerCallId ?? null,
            detail: { category: r.cls!.category, attempts: task.maxAttempts, terminal_status: t.status },
            now: t.now,
          });
        return { kind: "failure", code: "provider_input_inaccessible", detail: { category: r.cls.category, mode_used: mode }, onTerminal };
      }
      return { kind: "failure", code: r.code, detail: { ...r.detail, mode_used: mode } };
    }

    const data = r.data;
    if (data.account.id.state !== "value") return { kind: "failure", code: "schema_drift", detail: { reason: "account_id_unavailable" } };
    const callId = r.captured.providerCallId;

    // ── 身份：基准只有「本次响应」与「已登记标识」（D11）──
    const registered = (
      await db
        .select({ v: externalAccountIdentifiers.identifierValue })
        .from(externalAccountIdentifiers)
        .where(and(eq(externalAccountIdentifiers.accountId, accountId), eq(externalAccountIdentifiers.namespaceCode, data.account.namespace)))
    ).map((x) => x.v);
    const identity = checkProfileIdentity({ registered, actual: data.account.id });
    if (identity.state === "mismatch") {
      // 不写快照、不下载媒资、不改写登记值；证据留在质量问题里（稳定失败，必然终态，所以与终态同一事务）
      const onTerminal: TerminalHook = (tx, t) =>
        recordIssue(tx, {
          code: "profile_uid_mismatch",
          severity: "error",
          batchId: task.batchId,
          accountId,
          assignmentId,
          providerCallId: callId,
          detail: { namespace: data.account.namespace, expected: identity.expected, actual: identity.actual, sent_locator: locator },
          now: t.now,
        });
      return { kind: "failure", code: "profile_uid_mismatch", onTerminal };
    }

    // ── 残缺：四项指标全无效 → 不写「全部缺失」的快照冒充成功（FS-4.8），可重试 ──
    if (checkProfileFields(data) === "all_invalid") {
      const noted = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], (tx) =>
        recordIssue(tx, {
          code: "profile_fields_missing",
          severity: "warning",
          batchId: task.batchId,
          accountId,
          assignmentId,
          providerCallId: callId,
          detail: { follower: data.followerCount.state, following: data.followingCount.state, like: data.likeCount.state, post: data.postCount.state },
          now: clock.now(),
        }),
      );
      if (!noted.ok) return abandonedOf(noted.reason);
      return { kind: "failure", code: "profile_fields_missing", detail: { mode_used: mode } };
    }

    // ── 终态事务 ──
    const [call] = await db.select({ at: odsProviderCalls.responseReceivedAt }).from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, callId));
    const receivedAt = call?.at ?? clock.now();
    const done = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx: DbTx) => {
      const now = clock.now();
      await lockAccount(tx, accountId); // 与列表封口事务串行化（自比对），先于任何写入
      const snap = await projectProfile(tx, {
        batchId: task.batchId,
        accountId,
        assignmentId,
        providerId: task.providerId,
        sourceProviderCallId: callId,
        adapterVersion: r.adapterVersion,
        responseReceivedAt: receivedAt,
        data,
        now,
      });
      // 之后某次主页成功：账号可访问，自动解决「疑似不可访问」（人工 ignored 的不动）
      await tx
        .update(dataQualityIssues)
        .set({ status: "resolved", resolvedAt: now, resolvedByActor: "system:recovered", updatedAt: now })
        .where(and(eq(dataQualityIssues.accountId, accountId), eq(dataQualityIssues.issueCode, ACCOUNT_INACCESSIBLE), inArray(dataQualityIssues.status, ["open", "acknowledged"])));
      await tx
        .update(syncTasks)
        .set({
          status: "succeeded",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorDetail: null,
          stopReason: null,
          resultSummary: {
            schema: "profile-result.v1",
            profile_snapshot_id: snap.profileSnapshotId.toString(),
            snapshot_created: snap.created,
            identity_check: { state: "verified", namespace: data.account.namespace },
            adapter_version: r.adapterVersion,
          },
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(syncTasks.taskId, task.taskId));
      // 自比对：列表任务已成功才会比较；只告警
      await runSelfCheck(tx, { batchId: task.batchId, accountId, assignmentId, now });
    });
    return done.ok ? { kind: "done" } : abandonedOf(done.reason);
  };
}
