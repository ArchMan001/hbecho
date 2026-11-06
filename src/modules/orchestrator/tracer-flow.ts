// tracer 编排：领取 root → 恢复失联调用 → 入口检查 → 主页（同步，或异步提交 + 轮询）→ 身份 + 归属 + 主页快照
// → 首个完整返回页 → 整页投影 + 补充标识 + 初始检查点 → 终态。
//
// 不变量：
//  - 网络等待发生在网关里，编排器自己的数据库事务都是短写入；
//  - 每个投影事务先按 fencing token 锁定并校验 root（列表阶段还有子任务），陈旧 / 已取消的 worker 什么都不写；
//  - 每次发起调用之前先心跳续租（失败 = 已被取消 / 取代 = 立刻停止，不再付费）；
//  - 重放安全：网关对同一 (task, attempt, sequence) 返回已有调用，投影对同一批次幂等，所以崩溃后重新运行不会重复付费或重复事实；
//  - 失败按类别处理：校验类（含异步任务的校验失败）有界重试，耗尽后才判 invalid_link；限流 / 5xx / 已知未送达的传输失败
//    退避后重试（retry_wait）；结果不明（ambiguous）的只读调用最多再发一次；其余稳定失败，不盲重发；
//  - 业务阻塞（归属冲突、名额已满）在发出列表调用之前终止：默认不再继续付费。
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { odsProviderCalls, platforms, syncSettings, syncTasks } from "../../db/schema";
import { jcsSha256 } from "../canonical-json";
import { bindDominantListAuthor, bindSecondaryIdentifier, intakeAccount, loadOwnerSnapshot, type IdentifierRef, type IntakeResult } from "../identity";
import { checkpointModule, contentListProjector, cursorAnomaly, projectProfile, recordIssue, validPublishedAtMs, type ContentListProjector } from "../projection";
import {
  MAX_RESOLVE_ATTEMPTS,
  UnsupportedCapabilityError,
  afterProfileAttempt,
  buildRequest,
  capabilityGate,
  checkLocatorPlatform,
  classifyLocator,
  decodeProfile,
  decodeVideoList,
  isSuspectedEmptyProfile,
  type AiMasterAction,
  type ExecutionMode,
  type FailureClassification,
  type ListData,
  type Platform,
  type ProfileData,
} from "../provider-adapter";
import {
  RawCaptureError,
  StaleFenceError,
  interpretCaptured,
  pairLocatorWithAccount,
  pairLocatorWithAsyncAccount,
  recoverInFlightForTasks,
  type CallSpec,
  type CapturedProviderResult,
  type Clock,
  type ExecuteOutcome,
  type FenceFailureReason,
  type Interpreted,
  type RawCaptureGateway,
} from "../raw-capture";
import { DEFAULT_ASYNC, DEFAULT_CONFIG, DEFAULT_RETRY, DEFAULT_ROOT_DEADLINE_MS, type TracerConfig } from "../tracer-command";
import { attemptLoop, backoffMs, type Step } from "./attempts";
import { claimTask, heartbeat } from "./claim";
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
  /** 默认是真实的整页投影；测试用来注入「第 N 条失败」「已处理数不足」。 */
  projector?: ContentListProjector;
  /** 轮询间隔的等待；默认真实 setTimeout，测试注入推进 fake clock 的实现。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 测试用的崩溃 / 抢占点：钩子抛出的异常不会被吞掉。 */
export interface TracerRunHooks {
  /** 主页响应已落 ODS 并解码，身份 / 归属投影事务之前。 */
  beforeIntake?(): Promise<void> | void;
  /** 列表响应已落 ODS 并解码，整页投影事务之前。 */
  beforePageProjection?(): Promise<void> | void;
  /** 整页投影事务已提交之后（进程可能在此处丢失）。 */
  afterPageProjection?(): Promise<void> | void;
}

export type RunKind = "succeeded" | "blocked" | "failed" | "cancelled" | "stale" | "busy" | "already_terminal" | "retry_wait";
export interface RunResult {
  kind: RunKind;
  rootTaskId: string;
}

export const LIST_TASK_PARAMETERS_VERSION = "data-foundation-tracer-list-task.v1";
const DEFAULT_LEASE_MS = 60_000;
const PENDING_TASK_STATUSES = new Set(["running", "pending", "queued", "processing"]);
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type ProfileOk = { captured: CapturedProviderResult; submit: CapturedProviderResult | null; interpreted: Interpreted<ProfileData>; data: ProfileData; adapterVersion: string; attempt: number };
type PageOk = { captured: CapturedProviderResult; data: ListData; adapterVersion: string; attempt: number };

export async function runTracerRoot(deps: TracerRunDeps, rootTaskIdIn: bigint | string): Promise<RunResult> {
  const { db, clock, gateway } = deps;
  const rootId = BigInt(rootTaskIdIn);
  const config = deps.config ?? DEFAULT_CONFIG;
  const strategies = deps.strategies ?? DEFAULT_STRATEGIES;
  const projector = deps.projector ?? contentListProjector;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const sleep = deps.sleep ?? realSleep;
  const retryCfg = config.retry ?? DEFAULT_RETRY;
  const asyncCfg = config.async ?? DEFAULT_ASYNC;
  const result = (kind: RunKind): RunResult => ({ kind, rootTaskId: rootId.toString() });

  const claim = await claimTask(db, rootId, { workerId: deps.workerId, leaseMs, now: clock.now() });
  if (claim.kind === "not_found") throw new Error(`root ${rootId} 不存在`);
  if (claim.kind === "terminal") return result("already_terminal");
  if (claim.kind === "busy") return result("busy");
  if (claim.kind === "not_due") return result("retry_wait");
  const root = claim.task;
  const token = claim.token;

  const fenceOutcome = (reason: FenceFailureReason): RunResult => result(reason === "cancelled" ? "cancelled" : "stale");
  const staleResult = (f: Extract<Fenced<unknown>, { ok: false }>) => fenceOutcome(f.reason);

  const terminateRoot = async (t: RootTerminal, kind: RunKind): Promise<RunResult> => {
    const r = await withFences(db, clock, [{ taskId: rootId, token }], (tx, tasks) => finishRoot(tx, tasks.get(rootId)!, t, clock.now()));
    return r.ok ? result(kind) : staleResult(r);
  };
  const failRoot = (category: string, errorCode: string): Promise<RunResult> => terminateRoot({ status: "failed", category, errorCode }, "failed");

  // 心跳：续租；失败说明已被取消 / 取代，调用方立刻停止，不再发起新调用
  const beat = async (...locks: Array<{ taskId: bigint; token: bigint }>): Promise<RunResult | null> => {
    for (const l of locks) {
      const h = await heartbeat(db, l.taskId, l.token, { now: clock.now(), leaseMs });
      if (h !== "ok") return result(h === "cancelled" ? "cancelled" : "stale");
    }
    return null;
  };
  /** 分段等待并在每段之后续租，所以轮询间隔可以比租约长。 */
  const sleepBeat = async (ms: number, ...locks: Array<{ taskId: bigint; token: bigint }>): Promise<RunResult | null> => {
    const chunk = Math.max(1, Math.floor(leaseMs / 3));
    for (let left = ms; left > 0; left -= chunk) {
      await sleep(Math.min(chunk, left));
      const stop = await beat(...locks);
      if (stop) return stop;
    }
    return null;
  };

  // ── 总截止时间 ───────────────────────────────────────────────────
  const deadlineMs = config.rootDeadlineMs ?? DEFAULT_ROOT_DEADLINE_MS;
  if (clock.now().getTime() - root.createdAt.getTime() > deadlineMs) return failRoot("deadline", "deadline_exceeded");

  // ── 平台、策略与 capability（运行期再过一次门：配置可能与提交时不同） ──
  const [plat] = await db.select().from(platforms).where(eq(platforms.platformId, root.platformId));
  const platform = plat?.platformCode as Platform | undefined;
  const strategy = platform ? strategies[platform] : undefined;
  if (!platform || !strategy) return failRoot("unsupported_capability", "platform_strategy_unavailable");
  // 外部监控账号（FS-13.5）只采主页：不要求列表 capability
  const isExternal = root.subjectType === "external";
  for (const action of isExternal ? (["media_user_info"] as const) : (["media_user_info", "user_video_list"] as const)) {
    try {
      capabilityGate.require({ platform, action, mode: config.modes[action], environment: config.environment });
    } catch (e) {
      if (e instanceof UnsupportedCapabilityError) return failRoot("unsupported_capability", "unsupported_capability");
      throw e;
    }
  }

  // ── 恢复：持有租约的 worker 可以确定，停在 in_flight 的调用属于失联的旧 worker → ambiguous ──
  const family = [rootId, ...(await db.select({ id: syncTasks.taskId }).from(syncTasks).where(eq(syncTasks.parentTaskId, rootId))).map((r) => r.id)];
  await recoverInFlightForTasks({ db, clock, taskIds: family });

  // ── 入口检查：不发任何请求，不产生任何业务身份 ─────────────────
  const original = root.subjectKey;
  const staffId = root.subjectId;
  if (original === null || (staffId === null && !isExternal)) return failRoot("internal", "root_task_incomplete");
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

  // ── 调用与结果翻译（同步 / 异步共用） ─────────────────────────────
  const specFor = (taskId: bigint, fencingToken: bigint, attemptNo: number, seq: number, action: AiMasterAction, mode: ExecutionMode): CallSpec => ({
    syncTaskId: taskId,
    fencingToken,
    platformId: root.platformId,
    providerId: root.providerId,
    attemptNo,
    callSequence: seq,
    requestedAction: action,
    expectedResponseAction: action,
    request: buildRequest({ action, mode, locator: cleaned }),
  });
  const pollSpec = (attemptNo: number, seq: number, providerTaskId: string): CallSpec => ({
    syncTaskId: rootId,
    fencingToken: token,
    platformId: root.platformId,
    providerId: root.providerId,
    attemptNo,
    callSequence: seq,
    requestedAction: "task_lookup",
    expectedResponseAction: "media_user_info",
    request: { method: "GET", path: `/openapi/v1/tasks/${providerTaskId}`, query: {}, body: null },
  });
  const callExists = async (taskId: bigint, attemptNo: number, seq: number) =>
    (await db.select({ id: odsProviderCalls.providerCallId }).from(odsProviderCalls).where(and(eq(odsProviderCalls.syncTaskId, taskId), eq(odsProviderCalls.attemptNo, attemptNo), eq(odsProviderCalls.callSequence, seq)))).length > 0;
  const finishedAtOf = async (providerCallId: bigint): Promise<Date> => {
    const [c] = await db.select({ f: odsProviderCalls.finishedAt }).from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, providerCallId));
    return c?.f ?? clock.now();
  };
  const ambiguousCount = async (taskId: bigint, action: string) =>
    (await db.select({ id: odsProviderCalls.providerCallId }).from(odsProviderCalls).where(and(eq(odsProviderCalls.syncTaskId, taskId), eq(odsProviderCalls.requestedAction, action), eq(odsProviderCalls.callStatus, "ambiguous")))).length;

  const exec = async (spec: CallSpec): Promise<{ ex: ExecuteOutcome } | { end: RunResult }> => {
    try {
      return { ex: await gateway.execute(spec) };
    } catch (e) {
      if (e instanceof StaleFenceError) return { end: fenceOutcome(e.reason) };
      throw e;
    }
  };

  /** 不是 captured 的网关结果 → 下一步。ambiguous 的只读调用最多重发一次（计入预算），再次 ambiguous 不盲重发。 */
  const nonCaptured = async (ex: Exclude<ExecuteOutcome, { kind: "captured" }>, taskId: bigint, action: string, attempt: number): Promise<Step<never>> => {
    if (ex.kind === "not_sent") {
      if (ex.reason === "cancelled") return { kind: "end", result: result("cancelled") };
      if (ex.reason.startsWith("policy:")) return { kind: "fail", category: "policy", code: "policy_blocked" };
      return { kind: "end", result: result("stale") };
    }
    if (ex.kind === "in_progress") return { kind: "fail", category: "provider_outcome_unknown", code: "in_progress" };
    if (ex.kind === "transport_failed" && ex.callStatus === "terminal") {
      // 有证据确认未送达：可以安全地按新 attempt 重试，退避之后
      return { kind: "again", category: "transport", waitUntil: new Date((await finishedAtOf(ex.providerCallId)).getTime() + backoffMs(retryCfg, attempt)) };
    }
    // ambiguous / 送达未知的传输失败 / 终态证据没能落地：结果不明
    return (await ambiguousCount(taskId, action)) >= 2 ? { kind: "fail", category: "provider_outcome_unknown", code: "provider_outcome_unknown" } : { kind: "again", category: "provider_outcome_unknown" };
  };
  /** captured 但业务上失败 → 下一步。 */
  const failureStep = async (cls: FailureClassification, providerCallId: bigint, attempt: number): Promise<Step<never>> => {
    if (cls.retry === "bounded") {
      if (cls.category === "rate_limited" || cls.category === "provider_server_error") {
        return { kind: "again", category: cls.category, waitUntil: new Date((await finishedAtOf(providerCallId)).getTime() + backoffMs(retryCfg, attempt)) };
      }
      return { kind: "validation", category: cls.category }; // validation_failed / null_result / 异步任务的校验失败
    }
    return { kind: "fail", category: cls.category, code: cls.category };
  };
  const fenceEnd = async (): Promise<Step<never>> => ({ kind: "end", result: result((await currentRootCancelled(db, rootId)) ? "cancelled" : "stale") });

  // ── 主页 ─────────────────────────────────────────────────────────
  const profileMode = config.modes.media_user_info;
  const profileOnce = async (attempt: number): Promise<Step<ProfileOk>> => {
    const stop = await beat({ taskId: rootId, token });
    if (stop) return { kind: "end", result: stop };
    await db.update(syncTasks).set({ attemptCount: attempt, updatedAt: clock.now() }).where(eq(syncTasks.taskId, rootId));

    const r = await exec(specFor(rootId, token, attempt, 1, "media_user_info", profileMode));
    if ("end" in r) return { kind: "end", result: r.end };
    if (r.ex.kind !== "captured") return nonCaptured(r.ex, rootId, "media_user_info", attempt);
    if (!r.ex.fenceValid) return fenceEnd();

    const captured = r.ex.captured;
    const interpreted = await interpretCaptured(db, captured, (bytes) => decodeProfile(platform, bytes));
    const cls = captured.classification;
    const out = interpreted.outcome;
    if (cls.category !== "none") return failureStep(cls, captured.providerCallId, attempt);
    if (out.outcome === "decoded") {
      if (out.data.account.id.state !== "value") return { kind: "fail", category: "schema_drift", code: "account_id_unavailable" };
      return { kind: "ok", value: { captured, submit: null, interpreted, data: out.data, adapterVersion: out.adapterVersion, attempt } };
    }
    if (profileMode === "asynchronous" && out.outcome === "not_succeeded" && PENDING_TASK_STATUSES.has(out.taskStatus)) return pollProfile(attempt, captured);
    // 业务成功的信封却解不出账号：合同漂移，不重试、不当作账号不存在
    return { kind: "fail", category: "schema_drift", code: out.outcome };
  };

  /** 异步：提交已捕获并持久化了供应商任务 ID；每次轮询是独立的 ProviderCall（call_sequence 递增）。 */
  const pollProfile = async (attempt: number, submit: CapturedProviderResult): Promise<Step<ProfileOk>> => {
    const providerTaskId = submit.meta.providerTaskId;
    if (providerTaskId === null || !SAFE_TASK_ID.test(providerTaskId)) return { kind: "fail", category: "schema_drift", code: "provider_task_id_unusable" };
    for (let k = 1; k <= asyncCfg.maxPolls; k++) {
      const seq = 1 + k;
      // ponytail: 总等待用「间隔 × 次数」估算，不读时钟；供应商任务 TTL 与合适间隔未实测（任务 9 smoke），升级路径是读真实耗时
      if (k * asyncCfg.pollIntervalMs > asyncCfg.maxWaitMs) break;
      if (!(await callExists(rootId, attempt, seq))) {
        const stop = await sleepBeat(asyncCfg.pollIntervalMs, { taskId: rootId, token });
        if (stop) return { kind: "end", result: stop };
      }
      const r = await exec(pollSpec(attempt, seq, providerTaskId));
      if ("end" in r) return { kind: "end", result: r.end };
      if (r.ex.kind !== "captured") {
        // 单次轮询失联不是整件事失败：下一次轮询就是新调用（GET 幂等）；取消 / 封口照常终止
        if (r.ex.kind === "not_sent") return nonCaptured(r.ex, rootId, "task_lookup", attempt);
        continue;
      }
      if (!r.ex.fenceValid) return fenceEnd();
      const terminal = r.ex.captured;
      const interpreted = await interpretCaptured(db, terminal, (bytes) => decodeProfile(platform, bytes));
      const cls = terminal.classification;
      const out = interpreted.outcome;
      if (cls.category === "rate_limited" || cls.category === "provider_server_error") continue; // 轮询被限流：下一次再问
      if (cls.category !== "none") return failureStep(cls, terminal.providerCallId, attempt);
      if (out.outcome === "decoded") {
        if (out.data.account.id.state !== "value") return { kind: "fail", category: "schema_drift", code: "account_id_unavailable" };
        return { kind: "ok", value: { captured: terminal, submit, interpreted, data: out.data, adapterVersion: out.adapterVersion, attempt } };
      }
      if (out.outcome === "not_succeeded" && PENDING_TASK_STATUSES.has(out.taskStatus)) continue;
      return { kind: "fail", category: "schema_drift", code: out.outcome };
    }
    return { kind: "fail", category: "provider_timeout", code: "poll_timeout" };
  };

  const maxResolve = Math.min(root.maxAttempts, MAX_RESOLVE_ATTEMPTS);
  const profileLoop = await attemptLoop<ProfileOk>({
    max: maxResolve,
    now: () => clock.now(),
    exists: (n) => callExists(rootId, n, 1),
    once: profileOnce,
  });

  /** 进入 retry_wait：释放租约，记录下一次尝试时间。 */
  const toRetryWait = async (until: Date, category: string, childLock?: { taskId: bigint; token: bigint }): Promise<RunResult> => {
    const r = await withFences(db, clock, [{ taskId: rootId, token }, ...(childLock ? [childLock] : [])], async (tx) => {
      const now = clock.now();
      const wait = { status: "retry_wait", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: until, lastErrorCode: category, lastErrorDetail: { category }, updatedAt: now } as const;
      await tx.update(syncTasks).set(wait).where(eq(syncTasks.taskId, rootId));
      if (childLock) await tx.update(syncTasks).set(wait).where(eq(syncTasks.taskId, childLock.taskId));
    });
    return r.ok ? result("retry_wait") : staleResult(r);
  };

  if (profileLoop.kind === "end") return profileLoop.result;
  if (profileLoop.kind === "wait") return toRetryWait(profileLoop.until, profileLoop.category);
  if (profileLoop.kind === "fail") return failRoot(profileLoop.category, profileLoop.code);
  if (profileLoop.kind === "exhausted") {
    if (!profileLoop.validation) return failRoot(profileLoop.category, profileLoop.category);
    // 校验失败耗尽（含间歇性 result:null、异步任务校验失败）：这时才由业务层判 invalid_link，且不产生任何业务身份
    const next = afterProfileAttempt(maxResolve, "result_validation_failed");
    const attempts = next.next === "terminal" ? next.attempts : maxResolve;
    return terminateRoot(
      { status: "failed", stopReason: "invalid_link", errorCode: "result_validation_exhausted", category: profileLoop.category, entryOutcome: "invalid_link", summary: { attempts } },
      "failed",
    );
  }
  const profile = profileLoop.value;

  // ── 身份 + 归属 + 主页快照：一个短事务，locator 与账号 ID 来自同一条 captured payload（异步：同一个供应商任务） ──
  await deps.hooks?.beforeIntake?.();
  let pair;
  try {
    pair = profile.submit ? pairLocatorWithAsyncAccount(profile.submit, profile.captured, profile.interpreted) : pairLocatorWithAccount(profile.captured, profile.interpreted);
  } catch (e) {
    // locator 与账号 ID 不能证明来自同一条 payload：不建任何业务身份
    if (e instanceof RawCaptureError) return failRoot("identity", e.code);
    throw e;
  }
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
          providerCallId: profile.captured.providerCallId,
          discriminator: staffId?.toString() ?? "external",
          detail: { submitted_media_staff_id: staffId?.toString() ?? null, current_owner_media_staff_id: r.ownerStaffId?.toString() ?? null, current_owner_watch_type: r.ownerWatchType },
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
          providerCallId: profile.captured.providerCallId,
          discriminator: staffId?.toString() ?? "external",
          detail: { submitted_media_staff_id: staffId?.toString() ?? null, platform_id: root.platformId.toString(), occupied_by_account_id: r.existingAccountId.toString() },
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
        sourceProviderCallId: profile.captured.providerCallId,
        adapterVersion: profile.adapterVersion,
        responseReceivedAt: profileReceivedAt,
        data: profile.data,
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
          providerCallId: profile.captured.providerCallId,
          detail: { follower_state: profile.data.followerCount.state, post_state: profile.data.postCount.state },
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
  // 外部监控账号只有主页快照：不建列表子任务、不请求列表
  if (isExternal) {
    return terminateRoot({ status: "succeeded", entryOutcome: "normal", stopReason: "external_profile_only", summary: { profile_only: true }, accountId: intake.accountId, assignmentId: intake.assignmentId }, "succeeded");
  }

  // ── 首个完整返回页（子任务 fetch_content_list，同步） ───────────────
  const child = await ensureListTask(db, clock, root, intake.accountId, intake.assignmentId);
  const cc = await claimTask(db, child.taskId, { workerId: deps.workerId, leaseMs, now: clock.now() });
  if (cc.kind === "busy") return result("busy");
  if (cc.kind === "not_due") return result("retry_wait");
  if (cc.kind === "not_found") throw new Error("子任务消失");
  if (cc.kind === "terminal") {
    // 上一次运行已经完成列表阶段；只补 root 的终态
    if (cc.task.status !== "succeeded") return failRoot("list", cc.task.lastErrorCode ?? "list_stage_failed");
    return terminateRoot({ status: "succeeded", entryOutcome: "normal", summary: (cc.task.resultSummary as Record<string, unknown> | null) ?? {}, accountId: intake.accountId, assignmentId: intake.assignmentId }, "succeeded");
  }
  const ctoken = cc.token;
  const childLock = { taskId: child.taskId, token: ctoken };
  const failList = async (category: string, errorCode: string, attempts: number): Promise<RunResult> => {
    const r = await withFences(db, clock, [{ taskId: rootId, token }, childLock], async (tx, tasks) => {
      const now = clock.now();
      await finishChild(tx, tasks.get(child.taskId)!, { status: "failed", attemptCount: attempts, errorCode, category }, now);
      await finishRoot(tx, tasks.get(rootId)!, { status: "failed", errorCode, category, accountId: intake.accountId, assignmentId: intake.assignmentId }, now);
    });
    return r.ok ? result("failed") : staleResult(r);
  };

  const listOnce = async (attempt: number): Promise<Step<PageOk>> => {
    const stop = await beat({ taskId: rootId, token }, childLock);
    if (stop) return { kind: "end", result: stop };
    const r = await exec(specFor(child.taskId, ctoken, attempt, 1, "user_video_list", config.modes.user_video_list));
    if ("end" in r) return { kind: "end", result: r.end };
    if (r.ex.kind !== "captured") return nonCaptured(r.ex, child.taskId, "user_video_list", attempt);
    if (!r.ex.fenceValid) return fenceEnd();
    const captured = r.ex.captured;
    const interpreted = await interpretCaptured(db, captured, (bytes) => decodeVideoList(platform, bytes));
    const cls = captured.classification;
    const out = interpreted.outcome;
    if (cls.category !== "none") return failureStep(cls, captured.providerCallId, attempt);
    // 技术失败不会变成空列表
    if (out.outcome !== "decoded") return { kind: "fail", category: "schema_drift", code: out.outcome === "schema_drift" ? out.issues.join(",").slice(0, 100) || "schema_drift" : out.outcome };
    return { kind: "ok", value: { captured, data: out.data, adapterVersion: out.adapterVersion, attempt } };
  };

  const maxList = Math.min(child.maxAttempts, MAX_RESOLVE_ATTEMPTS);
  const listLoop = await attemptLoop<PageOk>({ max: maxList, now: () => clock.now(), exists: (n) => callExists(child.taskId, n, 1), once: listOnce });
  if (listLoop.kind === "end") return listLoop.result;
  if (listLoop.kind === "wait") return toRetryWait(listLoop.until, listLoop.category, childLock);
  if (listLoop.kind === "fail") return failList(listLoop.category, listLoop.code, maxList);
  if (listLoop.kind === "exhausted") return failList(listLoop.category, listLoop.category, maxList);
  const page = listLoop.value;

  // ── 整页投影 + 补充标识 + 初始检查点 + 终态：一个短事务（任一失败整页回滚，检查点不前进） ──
  await deps.hooks?.beforePageProjection?.();
  const [listCall] = await db.select().from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, page.captured.providerCallId));
  const listReceivedAt = listCall!.responseReceivedAt ?? clock.now();
  const projectAndFinish = (): Promise<Fenced<void>> =>
    retryDuplicate(() =>
      withFences(db, clock, [{ taskId: rootId, token }, childLock], async (tx, tasks) => {
        const now = clock.now();
        const owner = await loadOwnerSnapshot(tx, intake.assignmentId);
        const res = await projector.projectCompletePage(tx, {
          batchId: root.batchId,
          platformId: root.platformId,
          accountId: intake.accountId,
          assignmentId: intake.assignmentId,
          owner,
          sourceProviderCallId: page.captured.providerCallId,
          adapterVersion: page.adapterVersion,
          receivedAt: listReceivedAt,
          pageNo: 0,
          page: page.data,
          now,
        });

        const { bindings, issues } = strategy.listBindings({ primary, page: page.data, batchId: root.batchId });
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
              providerCallId: page.captured.providerCallId,
              discriminator: `${namespace}.bound_elsewhere`,
              detail: { namespace, other_account_id: bound.otherAccountId.toString() },
              now,
            });
            warnings.push({ code: "identity_conflict", stage: "identity" });
          }
        }
        for (const i of issues) {
          await recordIssue(tx, { code: i.code, severity: i.severity, batchId: root.batchId, accountId: intake.accountId, providerCallId: page.captured.providerCallId, discriminator: i.discriminator, detail: i.detail, now });
          warnings.push({ code: i.code, stage: "identity" });
        }
        // 页必须全部到达终态才能建立检查点（任一条没有处理 → 整页回滚）
        if (res.processedEntries !== res.returnedEntries) throw new PageIncompleteError(res.processedEntries, res.returnedEntries);
        const listIssue = async (discriminator: string, detail: Record<string, unknown>) => {
          await recordIssue(tx, { code: "field_contract_anomaly", severity: "warning", batchId: root.batchId, accountId: intake.accountId, providerCallId: page.captured.providerCallId, discriminator, detail, now });
          warnings.push({ code: "field_contract_anomaly", stage: "list" });
        };
        if (res.unprojectable.length > 0) await listIssue("list.entry.post_id_unusable", { reason: "entry_unprojectable", entries: res.unprojectable });
        if (res.duplicates.length > 0) {
          // 重复条目全部处理过，只保留一个 discovery；重复位置进入质量摘要
          await listIssue("list.duplicate_entries", {
            reason: "duplicate_list_entries",
            entries: res.duplicates.map((d) => ({ platform_content_id: d.platformContentId, positions: d.positions })),
          });
        }
        const anomaly = cursorAnomaly(page.data.hasMore, page.data.maxCursor);
        if (anomaly) await listIssue("list.cursor_missing_while_has_more", { reason: anomaly.reason, has_more: true, cursor_kind: anomaly.cursorKind });

        const anchorEntries = page.data.entries.flatMap((e) => (e.postId.state === "value" ? [{ platformContentId: e.postId.value, publishedAtMs: e.publishedAtMs }] : []));
        const cp = await checkpointModule.establishInitial(tx, {
          accountId: intake.accountId,
          providerId: root.providerId,
          batchId: root.batchId,
          taskId: child.taskId,
          cursor: page.data.maxCursor,
          entries: anchorEntries,
          now,
        });

        const times = page.data.entries.map((e) => validPublishedAtMs(e.publishedAtMs)).filter((x): x is bigint => x !== null);
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
            attemptCount: page.attempt,
            stopReason: "first_page_baseline",
            summary,
            counters: {
              pageCount: 1,
              fetchedItemCount: res.returnedEntries,
              hasMoreAtStop: page.data.hasMore.state === "value" ? page.data.hasMore.value : null,
              oldestPublishedAt: times.length ? new Date(Number(times.reduce((a, b) => (a < b ? a : b)))) : null,
              newestPublishedAt: times.length ? new Date(Number(times.reduce((a, b) => (a > b ? a : b)))) : null,
            },
          },
          now,
        );
        await finishRoot(tx, tasks.get(rootId)!, { status: "succeeded", entryOutcome: "normal", summary, warnings, accountId: intake.accountId, assignmentId: intake.assignmentId }, now);
      }),
    );

  let projected: Fenced<void>;
  try {
    projected = await projectAndFinish();
  } catch (e) {
    // 整页事务已回滚（无内容 / 发现 / 检查点）；技术失败不会变成空列表
    return failList("projection", e instanceof PageIncompleteError ? "page_incomplete" : "page_projection_failed", page.attempt);
  }
  if (!projected.ok) return staleResult(projected);
  await deps.hooks?.afterPageProjection?.();
  return result("succeeded");
}

class PageIncompleteError extends Error {
  constructor(processed: number, returned: number) {
    super(`页未处理完：已处理 ${processed} / 返回 ${returned}`);
    this.name = "PageIncompleteError";
  }
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
