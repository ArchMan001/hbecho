// 一次供应商调用的共用步骤（design-task5 §11）：能力门控 → 心跳 → 网关（先落 ODS 再发再落终态）→ 先捕获后解码 → 失败码映射。
// 网络 IO 在网关里，此处不持有任何数据库事务。
//
// attempt 规则：attempt_no = task.attemptCount + 1（框架每次失败 +1），call_sequence 由调用方给（列表 = 页号）。
// 所以重试永远是新调用；同一 (task, attempt, seq) 已存在 = 同一次尝试里崩溃后重放：已捕获的结果直接复用（不再付费），
// ambiguous 的按失败处理（下一次尝试就是只读重发）。同一 (task, seq) 已有 ≥ 2 个 ambiguous 调用时不再发起，
// 所以「因 ambiguous 最多重发一次」成立，不需要 resendAfterAmbiguous（它的 attempt_no+1 会与任务级 attempt 号冲突）。
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { odsProviderCalls } from "../../db/schema";
import {
  UnsupportedCapabilityError,
  capabilityGate,
  type AiMasterAction,
  type DecodeOutcome,
  type Environment,
  type ExecutionMode,
  type FailureCategory,
  type FailureClassification,
  type Platform,
} from "../provider-adapter";
import {
  StaleFenceError,
  interpretCaptured,
  type CallSpec,
  type CapturedProviderResult,
  type Clock,
  type ExecuteOutcome,
  type Interpreted,
  type ProviderRequest,
  type RawCaptureGateway,
} from "../raw-capture";
import { isBudgetReason } from "./budget";
import type { FailureCode } from "./failure-map";
import type { TaskContext } from "./types";

export interface AsyncPollConfig {
  pollIntervalMs: number;
  maxPolls: number;
  maxWaitMs: number;
}
export interface CallEnv {
  db: Db;
  clock: Clock;
  gateway: RawCaptureGateway;
  environment: Environment;
  /** 轮询间隔的等待；测试注入推进 fake clock 的实现。 */
  sleep(ms: number): Promise<void>;
  async: AsyncPollConfig;
}

export interface CallParams<T> {
  platform: Platform;
  action: AiMasterAction;
  mode: ExecutionMode;
  /** 同步：本次调用的序号；异步：提交的序号，第 k 次轮询是 seq + k（各自是独立 ProviderCall）。 */
  seq: number;
  request: ProviderRequest;
  decode(bytes: Uint8Array): DecodeOutcome<T>;
  /** 响应里的 action 与请求 action 不同时给出（详情：请求 media_stats_number，响应 media_stats）。默认等于 action。 */
  expectedResponse?: string;
}

export type CallResult<T> =
  | { kind: "decoded"; captured: CapturedProviderResult; submit: CapturedProviderResult | null; interpreted: Interpreted<T>; data: T; adapterVersion: string }
  | { kind: "failed"; code: FailureCode; cls: FailureClassification | null; detail?: Record<string, unknown>; providerCallId?: bigint }
  | { kind: "abandoned"; reason: "cancelled" | "stale" };

const PENDING_TASK_STATUSES = new Set(["running", "pending", "queued", "processing"]);
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 能力门控：调用前过一次；不通过的 tuple 不发请求（C4）。 */
export function capabilityFailure(env: Pick<CallEnv, "environment">, platform: Platform, action: AiMasterAction, mode: ExecutionMode): FailureCode | null {
  try {
    capabilityGate.require({ platform, action, mode, environment: env.environment });
    return null;
  } catch (e) {
    if (e instanceof UnsupportedCapabilityError) return "capability_disabled";
    throw e;
  }
}

const CATEGORY_CODE: Record<Exclude<FailureCategory, "none">, FailureCode> = {
  provider_request_rejected: "provider_request_rejected",
  provider_auth: "provider_auth",
  provider_validation_failed: "provider_validation_failed",
  provider_null_result: "provider_null_result",
  provider_task_failed: "provider_task_failed",
  rate_limited: "rate_limited",
  provider_server_error: "provider_server_error",
  invalid_response: "invalid_response",
};
export const codeOfCategory = (c: Exclude<FailureCategory, "none">): FailureCode => CATEGORY_CODE[c];

export async function ambiguousCount(db: Db, taskId: bigint, seq: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(odsProviderCalls)
    .where(and(eq(odsProviderCalls.syncTaskId, taskId), eq(odsProviderCalls.callSequence, seq), eq(odsProviderCalls.callStatus, "ambiguous")));
  return r?.n ?? 0;
}

type Gate = { stop: "cancelled" | "stale" } | null;
async function beat(ctx: TaskContext): Promise<Gate> {
  const h = await ctx.heartbeat();
  return h === "ok" ? null : { stop: h };
}

/** 网关返回的不是 captured：翻译成失败码或放弃。 */
function nonCaptured(ex: Exclude<ExecuteOutcome, { kind: "captured" }>): CallResult<never> {
  switch (ex.kind) {
    case "not_sent":
      if (ex.reason === "cancelled") return { kind: "abandoned", reason: "cancelled" };
      if (isBudgetReason(ex.reason) || ex.reason === "previously_not_sent") return { kind: "failed", code: "budget_exhausted", cls: null, detail: { reason: ex.reason } };
      return { kind: "abandoned", reason: "stale" }; // fence 失效（被取代 / 租约过期）
    case "transport_failed":
      if (ex.callStatus === "terminal") return { kind: "failed", code: ex.failure.kind === "timeout" ? "transport_timeout" : "transport_failure", cls: null };
      return { kind: "failed", code: "ambiguous_unresolved", cls: null };
    default:
      // ambiguous / in_progress / capture_failed：结果不明，不盲重发；下一次尝试是独立的只读重发
      return { kind: "failed", code: "ambiguous_unresolved", cls: null };
  }
}

type Exec = { ex: ExecuteOutcome } | { end: Extract<CallResult<never>, { kind: "abandoned" }> };
async function exec(env: CallEnv, ctx: TaskContext, spec: CallSpec): Promise<Exec> {
  try {
    return { ex: await env.gateway.execute(spec) };
  } catch (e) {
    if (e instanceof StaleFenceError) return { end: { kind: "abandoned", reason: e.reason === "cancelled" ? "cancelled" : "stale" } };
    throw e;
  }
}

function specOf(ctx: TaskContext, p: { action: AiMasterAction; expectedResponse?: string | undefined; seq: number; request: ProviderRequest; requestedAction?: string }): CallSpec {
  return {
    syncTaskId: ctx.task.taskId,
    fencingToken: ctx.token,
    platformId: ctx.task.platformId,
    providerId: ctx.task.providerId,
    attemptNo: ctx.task.attemptCount + 1,
    callSequence: p.seq,
    requestedAction: p.requestedAction ?? p.action,
    expectedResponseAction: p.expectedResponse ?? p.action,
    request: p.request,
  };
}

/** captured 之后：fence 校验 → 解码 → 分类。pending 异步任务返回 "pending"。 */
async function settle<T>(env: CallEnv, ctx: TaskContext, ex: Extract<ExecuteOutcome, { kind: "captured" }>, decode: CallParams<T>["decode"]): Promise<CallResult<T> | { kind: "pending"; captured: CapturedProviderResult }> {
  if (!ex.fenceValid) {
    const h = await ctx.heartbeat();
    return { kind: "abandoned", reason: h === "cancelled" ? "cancelled" : "stale" }; // 陈旧 worker 不投影
  }
  const captured = ex.captured;
  const interpreted = await interpretCaptured(env.db, captured, decode);
  const cls = captured.classification;
  if (cls.category !== "none") return { kind: "failed", code: codeOfCategory(cls.category), cls, providerCallId: captured.providerCallId };
  const out = interpreted.outcome;
  if (out.outcome === "decoded") return { kind: "decoded", captured, submit: null, interpreted, data: out.data, adapterVersion: out.adapterVersion };
  if (out.outcome === "not_succeeded" && PENDING_TASK_STATUSES.has(out.taskStatus)) return { kind: "pending", captured };
  // 业务成功的信封却解不出数据：合同漂移，不重试，更不能当成「空」
  return { kind: "failed", code: "schema_drift", cls, detail: { decode_outcome: out.outcome } };
}

/** 一次调用并解码（同步一次；异步 = 提交 + 轮询）。 */
export async function callDecoded<T>(env: CallEnv, ctx: TaskContext, p: CallParams<T>): Promise<CallResult<T>> {
  if ((await ambiguousCount(env.db, ctx.task.taskId, p.seq)) >= 2) return { kind: "failed", code: "ambiguous_unresolved", cls: null, detail: { reason: "resend_exhausted" } };
  const g = await beat(ctx);
  if (g) return { kind: "abandoned", reason: g.stop };

  const r = await exec(env, ctx, specOf(ctx, p));
  if ("end" in r) return r.end;
  if (r.ex.kind !== "captured") return nonCaptured(r.ex);
  const first = await settle(env, ctx, r.ex, p.decode);
  if (first.kind !== "pending") return first;
  if (p.mode !== "asynchronous") return { kind: "failed", code: "schema_drift", cls: null, detail: { reason: "pending_in_sync_mode" } };
  return poll(env, ctx, p, first.captured);
}

async function poll<T>(env: CallEnv, ctx: TaskContext, p: CallParams<T>, submit: CapturedProviderResult): Promise<CallResult<T>> {
  const providerTaskId = submit.meta.providerTaskId;
  if (providerTaskId === null || !SAFE_TASK_ID.test(providerTaskId)) return { kind: "failed", code: "schema_drift", cls: null, detail: { reason: "provider_task_id_unusable" } };
  for (let k = 1; k <= env.async.maxPolls; k++) {
    // ponytail: 总等待用「间隔 × 次数」估算，不读时钟；供应商任务 TTL 未实测（任务 11 smoke），升级路径是读真实耗时
    if (k * env.async.pollIntervalMs > env.async.maxWaitMs) break;
    const seq = p.seq + k;
    const exists = (await env.db.select({ id: odsProviderCalls.providerCallId }).from(odsProviderCalls).where(and(eq(odsProviderCalls.syncTaskId, ctx.task.taskId), eq(odsProviderCalls.attemptNo, ctx.task.attemptCount + 1), eq(odsProviderCalls.callSequence, seq)))).length > 0;
    if (!exists) {
      await env.sleep(env.async.pollIntervalMs);
      const g = await beat(ctx);
      if (g) return { kind: "abandoned", reason: g.stop };
    }
    const spec = specOf(ctx, { action: p.action, expectedResponse: p.expectedResponse, seq, requestedAction: "task_lookup", request: { method: "GET", path: `/openapi/v1/tasks/${providerTaskId}`, query: {}, body: null } });
    const r = await exec(env, ctx, spec);
    if ("end" in r) return r.end;
    if (r.ex.kind !== "captured") {
      // 单次轮询失联不是整件事失败：下一次轮询就是新调用（GET 幂等）；取消 / 封口 / 预算照常终止
      if (r.ex.kind === "not_sent") return nonCaptured(r.ex);
      continue;
    }
    const s = await settle(env, ctx, r.ex, p.decode);
    if (s.kind === "pending") continue;
    if (s.kind === "failed" && (s.code === "rate_limited" || s.code === "provider_server_error")) continue; // 轮询被限流：下一次再问
    if (s.kind === "decoded") return { ...s, submit };
    return s;
  }
  return { kind: "failed", code: "transport_timeout", cls: null, detail: { reason: "poll_timeout" } };
}
