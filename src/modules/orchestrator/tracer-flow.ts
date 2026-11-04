// tracer 编排（同步路径）：领取 root → 入口检查 → 主页（≤3 次）→ 身份 + 归属 + 主页快照（一个短事务）
// → 首个完整返回页 → 整页投影 + 补充标识 + 初始检查点（一个短事务）→ 终态。
//
// 不变量：
//  - 网络等待发生在网关里，编排器自己的数据库事务都是短写入；
//  - 每个投影事务先按 fencing token 锁定并校验 root（列表阶段还有子任务），陈旧 / 已取消的 worker 什么都不写；
//  - 重放安全：网关对同一 (task, attempt, sequence) 返回已有调用，投影对同一批次幂等，所以崩溃后重新运行不会重复付费或重复事实；
//  - 业务阻塞（归属冲突、名额已满）在发出列表调用之前终止：默认不再继续付费。
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { odsProviderCalls, platforms, syncSettings, syncTasks } from "../../db/schema";
import { jcsSha256 } from "../canonical-json";
import { bindDominantListAuthor, bindSecondaryIdentifier, intakeAccount, loadOwnerSnapshot, type IdentifierRef, type IntakeResult } from "../identity";
import {
  MAX_RESOLVE_ATTEMPTS,
  afterProfileAttempt,
  buildRequest,
  checkLocatorPlatform,
  classifyLocator,
  decodeProfile,
  decodeVideoList,
  isSuspectedEmptyProfile,
  profileAttemptOutcomeOf,
  type ListData,
  type Platform,
  type ProfileData,
} from "../provider-adapter";
import { establishInitialCheckpoint, projectContentPage, projectProfile, recordIssue, validPublishedAtMs } from "../projection";
import {
  StaleFenceError,
  interpretCaptured,
  pairLocatorWithAccount,
  type CallSpec,
  type CapturedProviderResult,
  type Clock,
  type ExecuteOutcome,
  type FenceFailureReason,
  type Interpreted,
  type RawCaptureGateway,
} from "../raw-capture";
import { DEFAULT_CONFIG, type TracerConfig } from "../tracer-command";
import { claimTask } from "./claim";
import { isDuplicateKey, withFences, type Fenced, type TaskRow } from "./fenced";
import { finishChild, finishRoot, type RootTerminal } from "./finish";
import { DEFAULT_STRATEGIES, type PlatformStrategy } from "./strategies";

export interface TracerRunDeps {
  db: Db;
  clock: Clock;
  gateway: RawCaptureGateway;
  workerId: string;
  leaseMs?: number;
  config?: TracerConfig;
  strategies?: Readonly<Record<string, PlatformStrategy>>;
  hooks?: TracerRunHooks;
}

/** 测试用的崩溃 / 抢占点：钩子抛出的异常不会被吞掉。 */
export interface TracerRunHooks {
  /** 主页响应已落 ODS 并解码，身份 / 归属投影事务之前。 */
  beforeIntake?(): Promise<void> | void;
  /** 列表响应已落 ODS 并解码，整页投影事务之前。 */
  beforePageProjection?(): Promise<void> | void;
}

export type RunKind = "succeeded" | "blocked" | "failed" | "cancelled" | "stale" | "busy" | "already_terminal";
export interface RunResult {
  kind: RunKind;
  rootTaskId: string;
}

export const LIST_TASK_PARAMETERS_VERSION = "data-foundation-tracer-list-task.v1";
const DEFAULT_LEASE_MS = 60_000;

/** 把网关结果之外的「发送前封口」原因翻译成稳定码。 */
const policyCode = (reason: string) => (reason.startsWith("policy:") ? "policy_blocked" : "not_sent");

export async function runTracerRoot(deps: TracerRunDeps, rootTaskIdIn: bigint | string): Promise<RunResult> {
  const { db, clock, gateway } = deps;
  const rootId = BigInt(rootTaskIdIn);
  const config = deps.config ?? DEFAULT_CONFIG;
  const strategies = deps.strategies ?? DEFAULT_STRATEGIES;
  const result = (kind: RunKind): RunResult => ({ kind, rootTaskId: rootId.toString() });

  const claim = await claimTask(db, rootId, { workerId: deps.workerId, leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS, now: clock.now() });
  if (claim.kind === "not_found") throw new Error(`root ${rootId} 不存在`);
  if (claim.kind === "terminal") return result("already_terminal");
  if (claim.kind === "busy") return result("busy");
  const root = claim.task;
  const token = claim.token;

  const fenceOutcome = (reason: FenceFailureReason): RunResult => result(reason === "cancelled" ? "cancelled" : "stale");
  const staleResult = (f: Extract<Fenced<unknown>, { ok: false }>) => fenceOutcome(f.reason);

  /** 终态写入（带 fence）。成功返回对应的运行结果。 */
  const terminateRoot = async (t: RootTerminal, kind: RunKind): Promise<RunResult> => {
    const r = await withFences(db, clock, [{ taskId: rootId, token }], (tx, tasks) => finishRoot(tx, tasks.get(rootId)!, t, clock.now()));
    return r.ok ? result(kind) : staleResult(r);
  };
  const failRoot = (category: string, errorCode: string): Promise<RunResult> =>
    terminateRoot({ status: "failed", category, errorCode }, "failed");

  // ── 平台与执行模式 ──────────────────────────────────────────────
  const [plat] = await db.select().from(platforms).where(eq(platforms.platformId, root.platformId));
  const platform = plat?.platformCode as Platform | undefined;
  const strategy = platform ? strategies[platform] : undefined;
  if (!platform || !strategy) return failRoot("unsupported_capability", "platform_strategy_unavailable");
  // 异步编排属于任务 8；同步路径之外的配置在这里 fail closed，而不是悄悄走同步
  if (config.modes.media_user_info !== "synchronous" || config.modes.user_video_list !== "synchronous") {
    return failRoot("unsupported_capability", "execution_mode_unavailable");
  }

  // ── 入口检查：不发任何请求，不产生任何业务身份 ─────────────────
  const original = root.subjectKey;
  const staffId = root.subjectId;
  if (original === null || staffId === null) return failRoot("internal", "root_task_incomplete");
  const decision = classifyLocator(original);
  if (decision.action === "reject") {
    return terminateRoot({ status: "failed", stopReason: "invalid_link", errorCode: "non_home_locator", category: "input", entryOutcome: "invalid_link", summary: { locator_kind: decision.kind } }, "failed");
  }
  const platformCheck = checkLocatorPlatform(platform, original);
  if (!platformCheck.ok) {
    return terminateRoot(
      { status: "failed", stopReason: "invalid_link", errorCode: "platform_mismatch", category: "input", entryOutcome: "invalid_link", summary: { detected_platform: platformCheck.detected } },
      "failed",
    );
  }
  const cleaned = decision.cleaned;

  // ── 主页：清洗后直接调 media_user_info；最多 3 次，仅对 RESULT_VALIDATION_FAILED 有界重试 ──
  const specFor = (taskId: bigint, fencingToken: bigint, attemptNo: number, action: "media_user_info" | "user_video_list"): CallSpec => ({
    syncTaskId: taskId,
    fencingToken,
    platformId: root.platformId,
    providerId: root.providerId,
    attemptNo,
    callSequence: 1,
    requestedAction: action,
    expectedResponseAction: action,
    request: buildRequest({ action, mode: config.modes[action], locator: cleaned }),
  });

  /** 把非 captured 的网关结果翻译成终止结果；captured 返回 null 由调用方继续。 */
  const stopFor = async (exec: ExecuteOutcome, fail: (category: string, code: string) => Promise<RunResult>): Promise<RunResult | null> => {
    switch (exec.kind) {
      case "captured":
        return exec.fenceValid ? null : result(await currentRootCancelled(db, rootId) ? "cancelled" : "stale");
      case "not_sent":
        if (exec.reason === "cancelled") return result("cancelled");
        if (exec.reason.startsWith("policy:")) return fail("policy", policyCode(exec.reason));
        return result("stale");
      case "transport_failed":
        return fail("transport", exec.failure.kind);
      case "ambiguous":
      case "in_progress":
        return fail("provider_outcome_unknown", exec.kind);
      case "capture_failed":
        return fail("raw_capture", `${exec.stage}_capture_failed`);
    }
  };

  let profile: { captured: CapturedProviderResult; interpreted: Interpreted<ProfileData>; data: ProfileData; adapterVersion: string; attempt: number } | null = null;
  const maxResolve = Math.min(root.maxAttempts, MAX_RESOLVE_ATTEMPTS);
  for (let attempt = 1; attempt <= maxResolve; attempt++) {
    await db.update(syncTasks).set({ attemptCount: attempt, updatedAt: clock.now() }).where(eq(syncTasks.taskId, rootId));
    let exec: ExecuteOutcome;
    try {
      exec = await gateway.execute(specFor(rootId, token, attempt, "media_user_info"));
    } catch (e) {
      if (e instanceof StaleFenceError) return fenceOutcome(e.reason);
      throw e;
    }
    const stop = await stopFor(exec, failRoot);
    if (stop) return stop;
    if (exec.kind !== "captured") throw new Error("unreachable");

    const interpreted = await interpretCaptured(db, exec.captured, (bytes) => decodeProfile(platform, bytes));
    const cls = exec.captured.classification;
    const out = interpreted.outcome;
    if (cls.category === "none") {
      if (out.outcome === "decoded" && out.data.account.id.state === "value") {
        profile = { captured: exec.captured, interpreted: interpreted as Interpreted<ProfileData>, data: out.data, adapterVersion: out.adapterVersion, attempt };
        break;
      }
      // 业务成功的信封却解不出账号：合同漂移，不重试、不当作账号不存在
      return failRoot("schema_drift", out.outcome === "decoded" ? "account_id_unavailable" : out.outcome);
    }
    const next = afterProfileAttempt(attempt, profileAttemptOutcomeOf(cls));
    if (next.next === "retry") continue;
    if (next.next === "terminal") {
      // 校验失败耗尽（含间歇性 result:null）：这时才由业务层判 invalid_link，且不产生任何业务身份
      return terminateRoot(
        { status: "failed", stopReason: "invalid_link", errorCode: "result_validation_exhausted", category: cls.category, entryOutcome: "invalid_link", summary: { attempts: next.attempts } },
        "failed",
      );
    }
    return failRoot(cls.category, cls.category); // HTTP 400 / 认证 / 限流 / 其他：稳定分类，不当作输入错误
  }
  if (!profile) return failRoot("internal", "profile_attempts_exhausted");

  // ── 身份 + 归属 + 主页快照：一个短事务，locator 与账号 ID 来自同一条 captured payload ──
  await deps.hooks?.beforeIntake?.();
  const pair = pairLocatorWithAccount(profile.captured, profile.interpreted);
  const [profileCall] = await db.select().from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, profile.captured.providerCallId));
  const profileReceivedAt = profileCall!.responseReceivedAt ?? clock.now();
  const primary: IdentifierRef = { namespace: pair.account.namespace, value: pair.account.id };
  const looksEmpty = isSuspectedEmptyProfile(profile.data);

  const intakeTx = await retryDuplicate(() =>
    withFences(db, clock, [{ taskId: rootId, token }], async (tx, tasks) => {
      const now = clock.now();
      const r = await intakeAccount(tx, {
        platformId: root.platformId,
        staffId,
        primary,
        submittedLocator: original,
        cleanedLocator: pair.locator,
        intakeStatus: looksEmpty ? "suspected_empty" : "normal",
        now,
      });
      const rootRow = tasks.get(rootId)!;
      if (r.kind === "assignment_conflict") {
        await recordIssue(tx, {
          code: "assignment_conflict",
          severity: "warning",
          batchId: root.batchId,
          accountId: r.accountId,
          assignmentId: r.assignmentId,
          providerCallId: profile!.captured.providerCallId,
          discriminator: staffId.toString(),
          detail: { submitted_media_staff_id: staffId.toString(), current_owner_media_staff_id: r.ownerStaffId?.toString() ?? null, current_owner_watch_type: r.ownerWatchType },
          now,
        });
        await finishRoot(tx, rootRow, { status: "failed", stopReason: "assignment_conflict", accountId: r.accountId }, now);
        return r;
      }
      if (r.kind === "staff_platform_slot_taken") {
        await recordIssue(tx, {
          code: "staff_platform_slot_taken",
          severity: "warning",
          batchId: root.batchId,
          assignmentId: r.existingAssignmentId,
          providerCallId: profile!.captured.providerCallId,
          discriminator: staffId.toString(),
          detail: { submitted_media_staff_id: staffId.toString(), platform_id: root.platformId.toString(), occupied_by_account_id: r.existingAccountId.toString() },
          now,
        });
        await finishRoot(tx, rootRow, { status: "failed", stopReason: "staff_platform_slot_taken" }, now);
        return r;
      }

      await projectProfile(tx, {
        batchId: root.batchId,
        accountId: r.accountId,
        assignmentId: r.assignmentId,
        providerId: root.providerId,
        sourceProviderCallId: profile!.captured.providerCallId,
        adapterVersion: profile!.adapterVersion,
        responseReceivedAt: profileReceivedAt,
        data: profile!.data,
        now,
      });
      await tx.update(syncTasks).set({ accountId: r.accountId, assignmentId: r.assignmentId, updatedAt: now }).where(eq(syncTasks.taskId, rootId));
      if (r.intakeStatus === "suspected_empty") {
        // 疑似空账号：写问题，不关监控开关、不改账号状态；不进入常规采集，所以不发列表调用
        await recordIssue(tx, {
          code: "suspected_empty_account",
          severity: "warning",
          batchId: root.batchId,
          accountId: r.accountId,
          assignmentId: r.assignmentId,
          providerCallId: profile!.captured.providerCallId,
          detail: { follower_state: profile!.data.followerCount.state, post_state: profile!.data.postCount.state },
          now,
        });
        await finishRoot(tx, rootRow, { status: "succeeded", entryOutcome: "suspected_empty", stopReason: "suspected_empty", summary: { returned_entries: 0 }, accountId: r.accountId, assignmentId: r.assignmentId }, now);
      }
      return r;
    }),
  );
  if (!intakeTx.ok) return staleResult(intakeTx);
  const intake: IntakeResult = intakeTx.value;
  if (intake.kind !== "ready") return result("blocked");
  if (intake.intakeStatus === "suspected_empty") return result("succeeded");

  // ── 首个完整返回页（子任务 fetch_content_list） ───────────────────
  const child = await ensureListTask(db, clock, root, intake.accountId, intake.assignmentId);
  const cc = await claimTask(db, child.taskId, { workerId: deps.workerId, leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS, now: clock.now() });
  if (cc.kind === "busy") return result("busy");
  if (cc.kind === "not_found") throw new Error("子任务消失");
  if (cc.kind === "terminal") {
    // 上一次运行已经完成列表阶段；只补 root 的终态
    if (cc.task.status !== "succeeded") return failRoot("list", cc.task.lastErrorCode ?? "list_stage_failed");
    return terminateRoot({ status: "succeeded", entryOutcome: "normal", summary: (cc.task.resultSummary as Record<string, unknown> | null) ?? {}, accountId: intake.accountId, assignmentId: intake.assignmentId }, "succeeded");
  }
  const ctoken = cc.token;
  const failList = async (category: string, errorCode: string, attempts: number): Promise<RunResult> => {
    const r = await withFences(db, clock, [{ taskId: rootId, token }, { taskId: child.taskId, token: ctoken }], async (tx, tasks) => {
      const now = clock.now();
      await finishChild(tx, tasks.get(child.taskId)!, { status: "failed", attemptCount: attempts, errorCode, category }, now);
      await finishRoot(tx, tasks.get(rootId)!, { status: "failed", errorCode, category, accountId: intake.accountId, assignmentId: intake.assignmentId }, now);
    });
    return r.ok ? result("failed") : staleResult(r);
  };

  const maxList = Math.min(child.maxAttempts, MAX_RESOLVE_ATTEMPTS);
  let page: { captured: CapturedProviderResult; data: ListData; adapterVersion: string; attempt: number } | null = null;
  for (let attempt = 1; attempt <= maxList; attempt++) {
    let exec: ExecuteOutcome;
    try {
      exec = await gateway.execute(specFor(child.taskId, ctoken, attempt, "user_video_list"));
    } catch (e) {
      if (e instanceof StaleFenceError) return fenceOutcome(e.reason);
      throw e;
    }
    const stop = await stopFor(exec, (category, code) => failList(category, code, attempt));
    if (stop) return stop;
    if (exec.kind !== "captured") throw new Error("unreachable");

    const interpreted = await interpretCaptured(db, exec.captured, (bytes) => decodeVideoList(platform, bytes));
    const cls = exec.captured.classification;
    const out = interpreted.outcome;
    if (cls.category === "none") {
      if (out.outcome === "decoded") {
        page = { captured: exec.captured, data: out.data, adapterVersion: out.adapterVersion, attempt };
        break;
      }
      return failList("schema_drift", out.outcome === "schema_drift" ? out.issues.join(",").slice(0, 100) || "schema_drift" : out.outcome, attempt); // 技术失败不会变成空列表
    }
    if (cls.retry === "bounded" && attempt < maxList) continue;
    return failList(cls.category, cls.category, attempt);
  }
  if (!page) return failList("internal", "list_attempts_exhausted", maxList);

  // ── 整页投影 + 补充标识 + 初始检查点 + 终态：一个短事务（任一失败整页回滚，检查点不前进） ──
  await deps.hooks?.beforePageProjection?.();
  const [listCall] = await db.select().from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, page.captured.providerCallId));
  const listReceivedAt = listCall!.responseReceivedAt ?? clock.now();
  const projected = await retryDuplicate(() =>
    withFences(db, clock, [{ taskId: rootId, token }, { taskId: child.taskId, token: ctoken }], async (tx, tasks) => {
      const now = clock.now();
      const owner = await loadOwnerSnapshot(tx, intake.assignmentId);
      const res = await projectContentPage(tx, {
        batchId: root.batchId,
        platformId: root.platformId,
        accountId: intake.accountId,
        assignmentId: intake.assignmentId,
        owner,
        sourceProviderCallId: page!.captured.providerCallId,
        adapterVersion: page!.adapterVersion,
        receivedAt: listReceivedAt,
        pageNo: 0,
        page: page!.data,
        now,
      });

      const { bindings, issues } = strategy.listBindings({ primary, page: page!.data, batchId: root.batchId });
      const warnings: Array<{ code: string; stage: string }> = [];
      for (const b of bindings) {
        const bound =
          b.method === "same_payload"
            ? await bindSecondaryIdentifier(tx, { accountId: intake.accountId, ref: b.ref, now })
            : await bindDominantListAuthor(tx, { accountId: intake.accountId, evidence: b.evidence, batchId: root.batchId, now });
        if (bound.kind === "bound_to_other_account") {
          const namespace = b.method === "same_payload" ? b.ref.namespace : b.evidence.candidate_identifier!.namespace;
          await recordIssue(tx, {
            code: "identity_conflict",
            severity: "warning",
            batchId: root.batchId,
            accountId: intake.accountId,
            providerCallId: page!.captured.providerCallId,
            discriminator: `${namespace}.bound_elsewhere`,
            detail: { namespace, other_account_id: bound.otherAccountId.toString() },
            now,
          });
          warnings.push({ code: "identity_conflict", stage: "identity" });
        }
      }
      for (const i of issues) {
        await recordIssue(tx, { code: i.code, severity: i.severity, batchId: root.batchId, accountId: intake.accountId, providerCallId: page!.captured.providerCallId, discriminator: i.discriminator, detail: i.detail, now });
        warnings.push({ code: i.code, stage: "identity" });
      }
      if (res.unprojectable.length > 0) {
        await recordIssue(tx, {
          code: "field_contract_anomaly",
          severity: "warning",
          batchId: root.batchId,
          accountId: intake.accountId,
          providerCallId: page!.captured.providerCallId,
          discriminator: "list.entry.post_id_unusable",
          detail: { entries: res.unprojectable },
          now,
        });
      }

      const anchorEntries = page!.data.entries.flatMap((e) => (e.postId.state === "value" ? [{ platformContentId: e.postId.value, publishedAtMs: e.publishedAtMs }] : []));
      const cp = await establishInitialCheckpoint(tx, {
        accountId: intake.accountId,
        providerId: root.providerId,
        batchId: root.batchId,
        taskId: child.taskId,
        cursor: page!.data.maxCursor,
        entries: anchorEntries,
        now,
      });

      const times = page!.data.entries.map((e) => validPublishedAtMs(e.publishedAtMs)).filter((x): x is bigint => x !== null);
      const summary = {
        returned_entries: res.returnedEntries,
        projected_contents: res.projectedContents,
        unprojectable_entries: res.unprojectable,
        duplicate_entries: res.duplicates,
        checkpoint: cp.established ? "established" : cp.reason,
      };
      await finishChild(
        tx,
        tasks.get(child.taskId)!,
        {
          status: "succeeded",
          attemptCount: page!.attempt,
          stopReason: "first_page_baseline",
          summary,
          counters: {
            pageCount: 1,
            fetchedItemCount: res.returnedEntries,
            hasMoreAtStop: page!.data.hasMore.state === "value" ? page!.data.hasMore.value : null,
            oldestPublishedAt: times.length ? new Date(Number(times.reduce((a, b) => (a < b ? a : b)))) : null,
            newestPublishedAt: times.length ? new Date(Number(times.reduce((a, b) => (a > b ? a : b)))) : null,
          },
        },
        now,
      );
      await finishRoot(tx, tasks.get(rootId)!, { status: "succeeded", entryOutcome: "normal", summary, warnings, accountId: intake.accountId, assignmentId: intake.assignmentId }, now);
    }),
  );
  return projected.ok ? result("succeeded") : staleResult(projected);
}

// ───────────────────────── 内部 ─────────────────────────

async function currentRootCancelled(db: Db, rootId: bigint): Promise<boolean> {
  const [r] = await db.select({ status: syncTasks.status }).from(syncTasks).where(eq(syncTasks.taskId, rootId));
  return r?.status === "cancelled";
}

async function retryDuplicate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isDuplicateKey(e)) return fn(); // 并发的另一个 worker 先建立了同一个账号 / 标识：再来一次会命中已有行
    throw e;
  }
}

/** 列表阶段子任务：同一 root 只有一个（logical-effect key 唯一）；重放时返回已有行。 */
async function ensureListTask(db: Db, clock: Clock, root: TaskRow, accountId: bigint, assignmentId: bigint): Promise<TaskRow> {
  const key = jcsSha256({ kind: "tracer_first_page", root_task_id: root.taskId.toString() });
  const find = async () => (await db.select().from(syncTasks).where(eq(syncTasks.idempotencyKey, key)))[0];
  const existing = await find();
  if (existing) return existing;

  const [settings] = await db.select().from(syncSettings).where(eq(syncSettings.settingsId, 1));
  const now = clock.now();
  const limit = (root.taskParameters as { effective_initial_content_limit?: number } | null)?.effective_initial_content_limit ?? 20;
  try {
    await db.insert(syncTasks).values({
      batchId: root.batchId,
      parentTaskId: root.taskId,
      providerId: root.providerId,
      platformId: root.platformId,
      assignmentId,
      accountId,
      requestedAction: "fetch_content_list",
      subjectType: "external_account",
      subjectId: accountId,
      taskParameters: { schema_version: LIST_TASK_PARAMETERS_VERSION, page_no: 0, cursor: { kind: "integer", lexeme: "0" }, effective_initial_content_limit: limit },
      idempotencyKey: key,
      status: "pending",
      attemptCount: 0,
      maxAttempts: settings?.taskMaxAttempts ?? 3,
      expiresAt: root.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
  return (await find())!;
}
