// RawCaptureGateway：每个供应商调用的 durable intent → 发送 → 终态 capture（v2 §9.5、§12.4）。
//
//   请求字节上传私有 ODS 并读回校验 → 短事务写 prepared + request payload → 短事务切 in_flight
//   → 网络 IO（不持有任何数据库事务）→ 响应/传输错误字节上传 ODS 并读回校验 → 短事务写终态与 response payload
//   → 才允许版本化 Adapter 解析（decoder 只接受 CapturedProviderResult）。
//
// 并发控制全部靠条件更新（WHERE call_status='prepared' / 'in_flight'）和唯一键 (task, attempt, sequence)，不靠事务内等待。
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { odsPayloads, odsProviderCalls, ossObjects, syncTasks } from "../../db/schema";
import { classifyResponse, peekResponseMeta } from "../provider-adapter";
import { isJsonObject, parseJson } from "../provider-adapter/lossless-json";
import { createCaptured, type CapturedProviderResult } from "./captured";
import { RawCaptureError, StaleFenceError } from "./errors";
import { fenceFailure } from "./fence";
import { odsKey, type PayloadRole } from "./keys";
import { TransportFailure, type Clock, type ObjectStore, type ProviderRequest, type ProviderResponse, type ProviderTransport } from "./ports";
import { sanitizeMessage } from "./sanitize";

type CallRow = typeof odsProviderCalls.$inferSelect;

export interface CallSpec {
  syncTaskId: bigint;
  /** 发起调用的 worker 持有的 fencing token。 */
  fencingToken: bigint;
  platformId: bigint;
  providerId: bigint;
  attemptNo: number;
  callSequence: number;
  requestedAction: string;
  /** 创建 intent 时由 Adapter/capability 合同写入，终生不可变。 */
  expectedResponseAction: string;
  request: ProviderRequest;
}

export interface PolicyContext {
  syncTaskId: bigint;
  requestedAction: string;
  attemptNo: number;
  callSequence: number;
}

/** 发送前的本地策略封口（预算、调用上限、截止时间）。返回非空字符串表示封口并给出原因。 */
export interface SendPolicy {
  check(ctx: PolicyContext): Promise<string | null>;
}

/** 测试用崩溃点。钩子抛出的异常不会被网关吞掉。 */
export interface GatewayHooks {
  afterPrepared?(): Promise<void> | void;
  afterInFlight?(): Promise<void> | void;
  afterNetwork?(): Promise<void> | void;
}

export interface GatewayDeps {
  db: Db;
  store: ObjectStore;
  transport: ProviderTransport;
  clock: Clock;
  location: { providerCode: string; region: string; bucket: string };
  retentionMs?: number;
  /** ODS 对象键前缀（例如 smoke 的 `smoke/`）。会原样写入 `oss_objects.object_key`。 */
  keyPrefix?: string;
  policy?: SendPolicy;
  hooks?: GatewayHooks;
}

export type ExecuteOutcome =
  | { kind: "captured"; captured: CapturedProviderResult; fenceValid: boolean }
  | { kind: "not_sent"; providerCallId: bigint; reason: string }
  | { kind: "transport_failed"; providerCallId: bigint; callStatus: "terminal" | "ambiguous"; failure: { kind: string; delivered: "no" | "unknown" } }
  | { kind: "capture_failed"; providerCallId: bigint; stage: "response" | "transport_error"; callStatus: "ambiguous" | "in_flight" }
  | { kind: "in_progress"; providerCallId: bigint }
  | { kind: "ambiguous"; providerCallId: bigint };

const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;
/** 这些 action 都是只读查询，重发不产生供应商侧副作用（requirements 2.7、v2 §9.5 只读查询例外）。 */
const READ_ONLY_ACTIONS = new Set(["media_user_info", "user_video_list", "media_stats_number", "post_comments_list", "task_lookup"]);
const COMPLETE_RESPONSE_OUTCOMES = new Set(["succeeded", "http_error", "provider_error", "invalid_response"]);
const MAX_PARTIAL_BODY = 64 * 1024;

const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const endpointOf = (r: ProviderRequest) => {
  const q = new URLSearchParams(Object.entries(r.query).sort(([a], [b]) => a.localeCompare(b))).toString();
  return q ? `${r.path}?${q}` : r.path;
};
const elapsed = (from: Date, to: Date) => (Math.max(0, to.getTime() - from.getTime()) / 1000).toFixed(6);

function isDuplicateKey(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_DUP_ENTRY") return true;
  }
  return false;
}

export class RawCaptureGateway {
  readonly db: Db;
  private readonly d: GatewayDeps;
  private readonly retentionMs: number;

  constructor(deps: GatewayDeps) {
    this.d = deps;
    this.db = deps.db;
    this.retentionMs = deps.retentionMs ?? ONE_YEAR_MS;
  }

  // ───────────────────────── 入口 ─────────────────────────

  /** 幂等：同一 (task, attempt, sequence) 已有调用时不重复发送，按其当前状态继续。 */
  async execute(spec: CallSpec): Promise<ExecuteOutcome> {
    const existing = await this.findCall(spec.syncTaskId, spec.attemptNo, spec.callSequence);
    if (existing) return this.continueExisting(existing, spec.fencingToken);
    try {
      return await this.prepareAndSend(spec);
    } catch (e) {
      // 另一个 worker 抢先创建了同一个 logical call：转为续接它
      if (isDuplicateKey(e)) {
        const winner = await this.findCall(spec.syncTaskId, spec.attemptNo, spec.callSequence);
        if (winner) return this.continueExisting(winner, spec.fencingToken);
      }
      throw e;
    }
  }

  /** 崩溃在 prepared 之后：请求字节取自已落地的 ODS（证明 intent 足以恢复），只会发送一次。 */
  async resumePrepared(providerCallId: bigint, fencingToken: bigint): Promise<ExecuteOutcome> {
    const call = await this.getCall(providerCallId);
    return this.continueExisting(call, fencingToken);
  }

  /**
   * ambiguous 之后的有界重发（requirements 2.7）：只读 action；原调用保持 ambiguous、不被改写；
   * 新尝试是独立 ProviderCall（attempt_no+1），计入预算（走同一个 SendPolicy）；同一逻辑效果最多因 ambiguous 重发 1 次。
   * 不实现对账。
   */
  async resendAfterAmbiguous(originalCallId: bigint, spec: CallSpec): Promise<ExecuteOutcome> {
    const orig = await this.getCall(originalCallId);
    if (orig.callStatus !== "ambiguous") throw new RawCaptureError("ambiguous_resend_not_allowed", "只有 ambiguous 状态的调用可以重发");
    if (!READ_ONLY_ACTIONS.has(orig.requestedAction)) {
      throw new RawCaptureError("ambiguous_resend_not_allowed", "有副作用的供应商调用不适用只读重发例外");
    }
    const sameEffect = await this.d.db
      .select()
      .from(odsProviderCalls)
      .where(and(eq(odsProviderCalls.syncTaskId, orig.syncTaskId), eq(odsProviderCalls.callSequence, orig.callSequence)));
    if (sameEffect.some((c) => c.attemptNo > orig.attemptNo)) {
      throw new RawCaptureError("ambiguous_resend_not_allowed", "该调用之后已有更新的尝试");
    }
    if (sameEffect.filter((c) => c.callStatus === "ambiguous").length >= 2) {
      throw new RawCaptureError("ambiguous_resend_exhausted", "同一逻辑效果因 ambiguous 最多重发 1 次，已用尽");
    }
    return this.execute({ ...spec, attemptNo: orig.attemptNo + 1, callSequence: orig.callSequence });
  }

  /** 从 DB + ODS 重新读出已捕获的结果并校验摘要。解析重放（新 Adapter 版本）也从这里取字节。 */
  async loadCaptured(providerCallId: bigint): Promise<CapturedProviderResult> {
    const call = await this.getCall(providerCallId);
    if (call.callStatus !== "terminal" || !call.outcome || !COMPLETE_RESPONSE_OUTCOMES.has(call.outcome) || call.httpStatus === null) {
      throw new RawCaptureError("call_not_found", `调用 ${providerCallId} 没有完整的响应`);
    }
    const payloads = await this.d.db.select().from(odsPayloads).where(eq(odsPayloads.providerCallId, providerCallId));
    const req = payloads.find((p) => p.payloadRole === "request_body");
    const resp = payloads.find((p) => p.payloadRole === "response_body");
    if (!req || !resp) throw new RawCaptureError("call_not_found", `调用 ${providerCallId} 缺少 payload`);
    const requestBody = await this.readVerified(req);
    const responseBody = await this.readVerified(resp);
    const meta = peekResponseMeta(responseBody);
    return createCaptured({
      providerCallId,
      payloadId: resp.payloadId,
      httpStatus: call.httpStatus,
      requestBody,
      responseBody,
      responseSha256: hex(responseBody),
      classification: classifyResponse({ httpStatus: call.httpStatus, expectedAction: call.expectedResponseAction, meta }),
      meta,
    });
  }

  // ───────────────────────── 准备 ─────────────────────────

  private async prepareAndSend(spec: CallSpec): Promise<ExecuteOutcome> {
    const body = spec.request.body ?? new Uint8Array();
    // 1) 请求字节先上传私有 ODS 并读回校验；失败 → 没有 intent，不发送
    let uploaded: { key: string; sha: string };
    try {
      uploaded = await this.putVerified("request_body", body);
    } catch (e) {
      throw new RawCaptureError("request_intent_failed", `请求字节未能可靠落 ODS：${(e as Error).message}`);
    }

    // 2) 短事务：校验 fence → 对象元数据 + prepared 调用 + request payload。提交前禁止发送
    const now = this.d.clock.now();
    const callId = await this.d.db.transaction(async (tx) => {
      const [task] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, spec.syncTaskId)).for("update");
      const failure = fenceFailure(task, spec.fencingToken, now);
      if (failure) throw new StaleFenceError(failure);
      const expiresAt = new Date(now.getTime() + this.retentionMs);
      const [res] = await tx.insert(odsProviderCalls).values({
        syncTaskId: spec.syncTaskId,
        providerId: spec.providerId,
        platformId: spec.platformId,
        attemptNo: spec.attemptNo,
        callSequence: spec.callSequence,
        requestedAction: spec.requestedAction,
        expectedResponseAction: spec.expectedResponseAction,
        endpoint: endpointOf(spec.request),
        requestMethod: spec.request.method,
        callStatus: "prepared",
        preparedAt: now,
        requestCapturedAt: now,
        expiresAt,
      });
      const id = BigInt(res.insertId);
      await this.insertPayload(tx, { callId: id, role: "request_body", key: uploaded.key, sha: uploaded.sha, bytes: body.byteLength, now, expiresAt });
      return id;
    });

    await this.d.hooks?.afterPrepared?.();
    const call = await this.getCall(callId);
    return this.sendPrepared(call, spec.request, spec.fencingToken);
  }

  private async continueExisting(call: CallRow, fencingToken: bigint): Promise<ExecuteOutcome> {
    switch (call.callStatus) {
      case "prepared": {
        // 请求字节取自已落地的 ODS
        const reqPayload = (await this.d.db.select().from(odsPayloads).where(and(eq(odsPayloads.providerCallId, call.providerCallId), eq(odsPayloads.payloadRole, "request_body"))))[0];
        if (!reqPayload) throw new RawCaptureError("call_not_found", "prepared 调用缺少 request payload");
        const bytes = await this.readVerified(reqPayload);
        const [path, query = ""] = call.endpoint.split("?");
        const request: ProviderRequest = {
          method: (call.requestMethod ?? "POST") as "GET" | "POST",
          path: path!,
          query: Object.fromEntries(new URLSearchParams(query)),
          body: call.requestMethod === "GET" ? null : bytes,
        };
        return this.sendPrepared(call, request, fencingToken);
      }
      case "in_flight":
        return { kind: "in_progress", providerCallId: call.providerCallId };
      case "ambiguous":
        return { kind: "ambiguous", providerCallId: call.providerCallId };
      case "terminal": {
        if (call.outcome === "not_sent") return { kind: "not_sent", providerCallId: call.providerCallId, reason: "previously_not_sent" };
        if (call.outcome === "transport_error") {
          const te = (call.transportError ?? {}) as { kind?: string; delivered?: "no" | "unknown" };
          return { kind: "transport_failed", providerCallId: call.providerCallId, callStatus: "terminal", failure: { kind: te.kind ?? "unknown", delivered: te.delivered ?? "no" } };
        }
        const captured = await this.loadCaptured(call.providerCallId);
        return { kind: "captured", captured, fenceValid: await this.fenceValid(call.syncTaskId, fencingToken) };
      }
      default:
        throw new RawCaptureError("call_not_found", `未知调用状态 ${call.callStatus}`);
    }
  }

  // ───────────────────────── 发送与终态 capture ─────────────────────────

  private async sendPrepared(call: CallRow, request: ProviderRequest, fencingToken: bigint): Promise<ExecuteOutcome> {
    const policyReason = await this.d.policy?.check({
      syncTaskId: call.syncTaskId,
      requestedAction: call.requestedAction,
      attemptNo: call.attemptNo,
      callSequence: call.callSequence,
    });

    // 短事务：发送前最后一次校验；封口或切 in_flight。网络 IO 在事务之外
    const gate = await this.d.db.transaction(async (tx) => {
      const now = this.d.clock.now();
      const [task] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, call.syncTaskId)).for("update");
      const failure = fenceFailure(task, fencingToken, now);
      const reason = failure ?? (policyReason ? `policy:${policyReason}` : null);
      if (reason) {
        const [r] = await tx
          .update(odsProviderCalls)
          .set({ callStatus: "terminal", outcome: "not_sent", finishedAt: now, terminalCapturedAt: now })
          .where(and(eq(odsProviderCalls.providerCallId, call.providerCallId), eq(odsProviderCalls.callStatus, "prepared")));
        return r.affectedRows === 1 ? ({ sent: false, reason } as const) : ({ lost: true } as const);
      }
      const [r] = await tx
        .update(odsProviderCalls)
        .set({ callStatus: "in_flight", sendStartedAt: now })
        .where(and(eq(odsProviderCalls.providerCallId, call.providerCallId), eq(odsProviderCalls.callStatus, "prepared")));
      return r.affectedRows === 1 ? ({ sent: true, sendStartedAt: now } as const) : ({ lost: true } as const);
    });
    if ("lost" in gate) return { kind: "in_progress", providerCallId: call.providerCallId };
    if (!gate.sent) return { kind: "not_sent", providerCallId: call.providerCallId, reason: gate.reason };

    await this.d.hooks?.afterInFlight?.();

    // 网络 IO：此刻没有任何打开的数据库事务
    let response: ProviderResponse | null = null;
    let failure: TransportFailure | null = null;
    try {
      response = await this.d.transport.send(request);
    } catch (e) {
      failure =
        e instanceof TransportFailure
          ? e
          : new TransportFailure("unexpected", "unknown", e instanceof Error ? e.message : String(e)); // 未知异常：安全侧，按送达未知处理
    }
    await this.d.hooks?.afterNetwork?.();
    const receivedAt = this.d.clock.now();

    return response
      ? this.captureResponse(call, response, gate.sendStartedAt, receivedAt, fencingToken)
      : this.captureTransportFailure(call, failure!, gate.sendStartedAt, receivedAt);
  }

  private async captureResponse(call: CallRow, response: ProviderResponse, sendStartedAt: Date, receivedAt: Date, fencingToken: bigint): Promise<ExecuteOutcome> {
    // 先落 ODS 并校验；失败则不分类、不解析，调用进入 ambiguous（远端已执行，但我们没有可靠证据）
    let uploaded: { key: string; sha: string };
    try {
      uploaded = await this.putVerified("response_body", response.body);
    } catch {
      await this.markAmbiguous(call.providerCallId);
      return { kind: "capture_failed", providerCallId: call.providerCallId, stage: "response", callStatus: "ambiguous" };
    }

    // 证据已落地之后，才做元数据提取（不是业务解析）与分类
    const meta = peekResponseMeta(response.body);
    const classification = classifyResponse({ httpStatus: response.httpStatus, expectedAction: call.expectedResponseAction, meta });
    const capturedAt = this.d.clock.now();

    const committed = await this.d.db.transaction(async (tx) => {
      const [task] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, call.syncTaskId)).for("update");
      const fenceValid = fenceFailure(task, fencingToken, capturedAt) === null;
      const [r] = await tx
        .update(odsProviderCalls)
        .set({
          callStatus: "terminal",
          outcome: classification.outcome,
          httpStatus: response.httpStatus,
          responseAction: meta.action,
          providerCode: meta.errorCode,
          providerTaskId: meta.providerTaskId,
          providerRequestId: meta.providerRequestId,
          providerTaskStatus: meta.taskStatus,
          responseReceivedAt: receivedAt,
          finishedAt: receivedAt,
          elapsedSeconds: elapsed(sendStartedAt, receivedAt),
          terminalCapturedAt: capturedAt,
        })
        .where(and(eq(odsProviderCalls.providerCallId, call.providerCallId), eq(odsProviderCalls.callStatus, "in_flight")));
      if (r.affectedRows !== 1) return null; // 期间被恢复流程标成了 ambiguous
      const payloadId = await this.insertPayload(tx, {
        callId: call.providerCallId,
        role: "response_body",
        key: uploaded.key,
        sha: uploaded.sha,
        bytes: response.body.byteLength,
        now: capturedAt,
        expiresAt: call.expiresAt,
      });
      return { fenceValid, payloadId };
    });
    if (!committed) return { kind: "capture_failed", providerCallId: call.providerCallId, stage: "response", callStatus: "ambiguous" };

    const requestPayload = (await this.d.db.select().from(odsPayloads).where(and(eq(odsPayloads.providerCallId, call.providerCallId), eq(odsPayloads.payloadRole, "request_body"))))[0]!;
    // 交给 Adapter 的字节是从 ODS 读回并校验过的，而不是内存里的 response.body
    const [respPayload] = await this.d.db.select().from(odsPayloads).where(eq(odsPayloads.payloadId, committed.payloadId));
    const captured = createCaptured({
      providerCallId: call.providerCallId,
      payloadId: committed.payloadId,
      httpStatus: response.httpStatus,
      requestBody: await this.readVerified(requestPayload),
      responseBody: await this.readVerified(respPayload!),
      responseSha256: uploaded.sha,
      classification,
      meta,
    });
    return { kind: "captured", captured, fenceValid: committed.fenceValid };
  }

  private async captureTransportFailure(call: CallRow, failure: TransportFailure, sendStartedAt: Date, receivedAt: Date): Promise<ExecuteOutcome> {
    const partial = failure.opts.partialBody ? Buffer.from(failure.opts.partialBody.slice(0, MAX_PARTIAL_BODY)).toString("base64") : undefined;
    const artifact = {
      kind: failure.kind,
      delivered: failure.delivered,
      message: sanitizeMessage(failure.message),
      ...(failure.opts.httpStatus === undefined ? {} : { http_status: failure.opts.httpStatus }),
      ...(partial === undefined ? {} : { partial_body_base64: partial }),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));

    // 先落结构化传输错误 artifact，再分类、再重试
    let uploaded: { key: string; sha: string };
    try {
      uploaded = await this.putVerified("transport_error", bytes);
    } catch {
      await this.markAmbiguous(call.providerCallId);
      return { kind: "capture_failed", providerCallId: call.providerCallId, stage: "transport_error", callStatus: "ambiguous" };
    }

    const summary = { kind: failure.kind, delivered: failure.delivered, ...(failure.opts.httpStatus === undefined ? {} : { http_status: failure.opts.httpStatus }) };
    const capturedAt = this.d.clock.now();
    const known = failure.delivered === "no";
    const done = await this.d.db.transaction(async (tx) => {
      const [r] = await tx
        .update(odsProviderCalls)
        .set(
          known
            ? {
                callStatus: "terminal",
                outcome: "transport_error",
                transportError: summary,
                ...(failure.opts.httpStatus === undefined ? {} : { httpStatus: failure.opts.httpStatus }),
                finishedAt: receivedAt,
                elapsedSeconds: elapsed(sendStartedAt, receivedAt),
                terminalCapturedAt: capturedAt,
              }
            : { callStatus: "ambiguous", outcome: "ambiguous", transportError: summary, ambiguousAt: receivedAt },
        )
        .where(and(eq(odsProviderCalls.providerCallId, call.providerCallId), eq(odsProviderCalls.callStatus, "in_flight")));
      if (r.affectedRows !== 1) return false;
      await this.insertPayload(tx, { callId: call.providerCallId, role: "transport_error", key: uploaded.key, sha: uploaded.sha, bytes: bytes.byteLength, now: capturedAt, expiresAt: call.expiresAt });
      return true;
    });
    if (!done) return { kind: "capture_failed", providerCallId: call.providerCallId, stage: "transport_error", callStatus: "ambiguous" };
    return {
      kind: "transport_failed",
      providerCallId: call.providerCallId,
      callStatus: known ? "terminal" : "ambiguous",
      failure: { kind: failure.kind, delivered: failure.delivered },
    };
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  /** 上传并校验：put 返回的摘要/长度必须等于预期，再读回比对一次；失败则尽力删除坏对象并抛错。 */
  private async putVerified(role: PayloadRole, bytes: Uint8Array): Promise<{ key: string; sha: string }> {
    const sha = hex(bytes);
    const key = odsKey(this.d.clock.now(), role, sha, randomUUID(), this.d.keyPrefix ?? "");
    try {
      const stored = await this.d.store.put(key, bytes);
      if (stored.sha256 !== sha || stored.byteLength !== bytes.byteLength) throw new Error("存储返回的摘要或长度与预期不一致");
      const back = await this.d.store.get(key);
      if (!back || hex(back) !== sha || back.byteLength !== bytes.byteLength) throw new Error("读回校验失败");
    } catch (e) {
      await this.d.store.delete(key).catch(() => undefined);
      throw e;
    }
    return { key, sha };
  }

  private async insertPayload(
    tx: DbTx,
    p: { callId: bigint; role: PayloadRole; key: string; sha: string; bytes: number; now: Date; expiresAt: Date },
  ): Promise<bigint> {
    const [obj] = await tx.insert(ossObjects).values({
      objectCategory: "ods",
      providerCode: this.d.location.providerCode,
      region: this.d.location.region,
      bucket: this.d.location.bucket,
      objectKey: p.key,
      byteLength: BigInt(p.bytes),
      sha256: Buffer.from(p.sha, "hex"),
      contentType: "application/octet-stream",
      storageClass: "Standard",
      encryptionMode: "SSE-OSS",
      status: "available",
      expiresAt: p.expiresAt,
      verifiedAt: p.now,
      createdAt: p.now,
      updatedAt: p.now,
    });
    const [pay] = await tx.insert(odsPayloads).values({
      providerCallId: p.callId,
      payloadRole: p.role,
      ossObjectId: BigInt(obj.insertId),
      objectCategory: "ods",
      byteLength: BigInt(p.bytes),
      sha256: Buffer.from(p.sha, "hex"),
      parseStatus: "not_attempted",
      capturedAt: p.now,
      expiresAt: p.expiresAt,
    });
    return BigInt(pay.insertId);
  }

  private async readVerified(payload: typeof odsPayloads.$inferSelect): Promise<Uint8Array> {
    const [obj] = await this.d.db.select().from(ossObjects).where(eq(ossObjects.ossObjectId, payload.ossObjectId));
    const bytes = obj ? await this.d.store.get(obj.objectKey) : null;
    if (!bytes || hex(bytes) !== payload.sha256.toString("hex") || BigInt(bytes.byteLength) !== payload.byteLength) {
      throw new RawCaptureError("integrity_mismatch", `payload ${payload.payloadId} 的 ODS 字节与登记的摘要不一致`);
    }
    return bytes;
  }

  private async markAmbiguous(providerCallId: bigint): Promise<void> {
    // 尽力而为：数据库也不可用时调用留在 in_flight，由 recoverInFlightCalls 兜底
    await this.d.db
      .update(odsProviderCalls)
      .set({ callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: this.d.clock.now() })
      .where(and(eq(odsProviderCalls.providerCallId, providerCallId), eq(odsProviderCalls.callStatus, "in_flight")))
      .catch(() => undefined);
  }

  private async fenceValid(taskId: bigint, token: bigint): Promise<boolean> {
    const [task] = await this.d.db.select().from(syncTasks).where(eq(syncTasks.taskId, taskId));
    return fenceFailure(task, token, this.d.clock.now()) === null;
  }

  private async findCall(taskId: bigint, attemptNo: number, seq: number): Promise<CallRow | undefined> {
    const [row] = await this.d.db
      .select()
      .from(odsProviderCalls)
      .where(and(eq(odsProviderCalls.syncTaskId, taskId), eq(odsProviderCalls.attemptNo, attemptNo), eq(odsProviderCalls.callSequence, seq)));
    return row;
  }

  private async getCall(id: bigint): Promise<CallRow> {
    const [row] = await this.d.db.select().from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, id));
    if (!row) throw new RawCaptureError("call_not_found", `调用 ${id} 不存在`);
    return row;
  }
}

/** 恢复流程：长时间停在 in_flight 的调用（进程失联）标为 ambiguous。幂等。 */
export async function recoverInFlightCalls(deps: { db: Db; clock: Clock; olderThanMs: number }): Promise<number> {
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - deps.olderThanMs);
  const [r] = await deps.db
    .update(odsProviderCalls)
    .set({ callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: now })
    .where(and(eq(odsProviderCalls.callStatus, "in_flight"), sql`${odsProviderCalls.sendStartedAt} <= ${cutoff}`));
  return r.affectedRows;
}

// 供 pairing 使用：从已落地的请求字节里取出发送的 url
export function locatorOfRequest(bytes: Uint8Array): string | null {
  try {
    const v = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isJsonObject(v) && typeof v.url === "string" ? v.url : null;
  } catch {
    return null;
  }
}

/**
 * 接手任务时恢复：持有该任务租约的 worker 可以确定，此前停在 in_flight 的调用属于已失联的旧 worker，
 * 标为 ambiguous（原调用不改写，也不盲重发；只读 action 允许有界地新发一次）。幂等。
 */
export async function recoverInFlightForTasks(deps: { db: Db; clock: Clock; taskIds: readonly bigint[] }): Promise<number> {
  if (deps.taskIds.length === 0) return 0;
  const [r] = await deps.db
    .update(odsProviderCalls)
    .set({ callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: deps.clock.now() })
    .where(and(eq(odsProviderCalls.callStatus, "in_flight"), inArray(odsProviderCalls.syncTaskId, [...deps.taskIds])));
  return r.affectedRows;
}
