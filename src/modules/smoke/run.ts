// 真实 smoke 的执行器。只接受 preflight 签发的 SmokeAuthorized；secret 在获批之后才读取，只交给 transport 工厂。
//
// 每个真实调用仍然走 RawCaptureGateway（请求字节先落 ODS → prepared → in_flight → 响应字节落 ODS → 才解码）、
// ProviderCall、成本守卫（调用 / 轮询 / 点数）与 deadline；达到上限在**下一次调用前**封口。
// smoke 只留证据（批次、任务、ProviderCall、ODS 字节），**不写任何业务事实**（账号、归属、快照、内容、检查点）。
// 不自动重试：失败如实报告，由操作人决定。
import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../../db/client";
import { dataProviders, odsPayloads, odsProviderCalls, platforms, syncBatches, syncTasks } from "../../db/schema";
import { jcsSha256, type JcsValue } from "../canonical-json";
import { YUAN_PER_POINT, createBudgetPolicy, spentFor } from "../cost-guard";
import { buildRequest, decodeProfile, decodeVideoList, type ExecutionMode, type Platform } from "../provider-adapter";
import {
  RawCaptureGateway,
  interpretCaptured,
  type CallSpec,
  type Clock,
  type ExecuteOutcome,
  type ObjectStore,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTransport,
  type SendPolicy,
} from "../raw-capture";
import { preflight, type SmokeAuthorized, type SmokePlan } from "./preflight";

type Entry = SmokePlan["allowlist"][number];
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING = new Set(["running", "pending", "queued", "processing"]);

export type StoppedBy = "deadline" | "call_budget" | "poll_budget" | "points_budget" | null;

export interface SmokeDeps {
  db: Db;
  clock: Clock;
  /** 私有 ODS 存储（smoke 的 raw-before-parse 证据也进这里）。 */
  store: ObjectStore;
  location: { providerCode: string; region: string; bucket: string };
  /** secret provider：只在 preflight 通过之后才被调用。 */
  secrets: { apiKey(): Promise<string> };
  /** 用 secret 构造真实 transport（认证头在这里注入，不进入任何落库内容）。 */
  makeTransport(apiKey: string): ProviderTransport;
  sleep?: (ms: number) => Promise<void>;
  /** 审计日志（单行 JSON）。不含 secret、locator、载荷。 */
  log?: (line: string) => void;
}

export interface SmokeSummary {
  planSha256: string;
  approvedBy: string;
  environment: "staging" | "production";
  startedAt: string;
  finishedAt: string;
  stoppedBy: StoppedBy;
  tuples: Array<{
    platform: string;
    action: string;
    mode: string;
    locatorSha256Prefix: string;
    calls: number;
    polls: number;
    /** 响应分类（none = 业务成功）；被封口为 stopped:<原因>；传输失败等为 transport_failed / ambiguous / capture_failed。 */
    category: string;
    decoded: boolean;
    adapterVersion: string | null;
  }>;
  totals: { calls: number; polls: number; bytesSent: number; bytesReceived: number; latencyMsTotal: number; estimatedPoints: number; estimatedYuan: number };
  /** 证据引用：ProviderCall ID 与响应字节 SHA-256 前缀，不含载荷。 */
  evidence: Array<{ providerCallId: string; requestedAction: string; httpStatus: number | null; responseSha256Prefix: string | null; providerTaskIdPresent: boolean }>;
}

/** 门槛 + 执行。门槛失败抛 SmokeRefused，此时没有读 secret、没有 transport、没有数据库写入。 */
export async function authorizeAndRun(deps: SmokeDeps, input: { plan: unknown; approval: unknown | null; env: Record<string, string | undefined> }): Promise<SmokeSummary> {
  const auth = preflight({ plan: input.plan, approval: input.approval, env: input.env, now: deps.clock.now() });
  return runSmoke(deps, auth);
}

/** 即使执行器有缺陷，也不向 allowlist 之外发请求：每个出站请求都在这里再核对一次。 */
export class AllowlistTransport implements ProviderTransport {
  constructor(
    private readonly inner: ProviderTransport,
    private readonly allowlist: ReadonlyArray<Pick<Entry, "action" | "mode" | "locator">>,
  ) {}

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.check(req);
    return this.inner.send(req);
  }

  private check(req: ProviderRequest): void {
    const deny = (why: string): never => {
      throw new Error(`allowlist：拒绝出站请求（${why}）`);
    };
    if (req.method === "GET") {
      const m = /^\/openapi\/v1\/tasks\/([^/]+)$/.exec(req.path);
      if (!m || !SAFE_TASK_ID.test(m[1]!) || Object.keys(req.query).length > 0 || req.body !== null) deny("轮询请求形态不对");
      if (!this.allowlist.some((e) => e.mode === "asynchronous")) deny("计划里没有异步条目");
      return;
    }
    const action = /^\/openapi\/v1\/(media_user_info|user_video_list)$/.exec(req.path)?.[1];
    if (!action) return deny("路径不在 allowlist");
    const keys = Object.keys(req.query);
    if (keys.length !== 1 || keys[0] !== "async") deny("query 不是仅 async");
    const mode = req.query.async === "true" ? "asynchronous" : req.query.async === "false" ? "synchronous" : null;
    if (mode === null || req.body === null) return deny("模式或 body 缺失");
    let url: unknown;
    try {
      url = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body)) as { url?: unknown }).url;
    } catch {
      return deny("body 不是合法 JSON");
    }
    if (typeof url !== "string" || !this.allowlist.some((e) => e.action === action && e.mode === mode && e.locator === url)) deny("action / 模式 / locator 不在 allowlist");
  }
}

export async function runSmoke(deps: SmokeDeps, auth: SmokeAuthorized): Promise<SmokeSummary> {
  const { db, clock } = deps;
  const { plan } = auth;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = clock.now();
  deps.log?.(JSON.stringify({ event: "smoke.start", at: startedAt.toISOString(), plan_sha256: auth.planSha256, approved_by: auth.approvedBy, environment: plan.environment, entries: plan.allowlist.length, budget: auth.preview.budget }));

  // secret 只在获批之后读取，只交给 transport 工厂
  const apiKey = await deps.secrets.apiKey();
  const transport = new AllowlistTransport(deps.makeTransport(apiKey), plan.allowlist);

  const deadlineAt = startedAt.getTime() + plan.deadline_ms;
  const budget = createBudgetPolicy(db, { maxCalls: plan.budget.max_calls, maxPolls: plan.budget.max_polls, maxPoints: plan.budget.max_points });
  const policy: SendPolicy = { check: async (ctx) => (clock.now().getTime() >= deadlineAt ? "deadline" : budget.check(ctx)) };
  const gateway = new RawCaptureGateway({ db, store: deps.store, transport, clock, location: deps.location, policy, keyPrefix: "smoke/" });

  // 批次 + 一个 smoke 根任务；每个 allowlist 条目一个子任务（成本守卫按根任务家族累计，所以预算是全局的）
  const [provider] = await db.select().from(dataProviders).where(eq(dataProviders.providerCode, "aimaster"));
  const platformIds = new Map((await db.select().from(platforms)).map((p) => [p.platformCode, p.platformId]));
  const leaseUntil = new Date(startedAt.getTime() + plan.deadline_ms + 3600_000);
  const expiresAt = new Date(startedAt.getTime() + 365 * 24 * 3600 * 1000);
  const [batch] = await db.insert(syncBatches).values({
    batchKey: jcsSha256({ kind: "smoke", plan_sha256: auth.planSha256, started_at: startedAt.toISOString() } as JcsValue),
    triggerType: "manual",
    purpose: "intake",
    logicalAt: startedAt,
    status: "running",
    settingsVersion: 0n,
    settingsSnapshot: { smoke: true },
    plannedTaskCount: plan.allowlist.length + 1,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  const batchId = BigInt(batch.insertId);
  const mkTask = async (action: "fetch_profile" | "fetch_content_list", platform: string, parent: bigint | null, key: string) => {
    const [r] = await db.insert(syncTasks).values({
      batchId,
      parentTaskId: parent,
      providerId: provider!.providerId,
      platformId: platformIds.get(platform)!,
      requestedAction: action,
      subjectType: "smoke",
      taskParameters: { schema_version: "data-foundation-smoke-task.v1" },
      idempotencyKey: jcsSha256({ kind: "smoke_task", plan_sha256: auth.planSha256, started_at: startedAt.toISOString(), key } as JcsValue),
      status: "running",
      attemptCount: 1,
      maxAttempts: 1,
      leaseOwner: "smoke",
      leaseExpiresAt: leaseUntil,
      fencingToken: 1n,
      startedAt,
      expiresAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    return BigInt(r.insertId);
  };
  const rootId = await mkTask("fetch_profile", plan.allowlist[0]!.platform, null, "root");

  let stoppedBy: StoppedBy = null;
  const stopFrom = (reason: string): void => {
    const r = reason.replace(/^policy:/, "");
    if (r === "deadline" || r === "call_budget" || r === "poll_budget" || r === "points_budget") stoppedBy ??= r;
  };
  const tuples: SmokeSummary["tuples"] = [];
  const taskIds: bigint[] = [];
  const notOk = new Map<bigint, { status: "failed" | "cancelled"; code: string }>(); // 没成功的条目：失败（传输 / ambiguous / 业务 / 未解码 / 轮询未到终态）或被上限封口

  for (const [i, e] of plan.allowlist.entries()) {
    const base = { platform: e.platform, action: e.action, mode: e.mode, locatorSha256Prefix: createHash("sha256").update(e.locator).digest("hex").slice(0, 16) };
    if (stoppedBy !== null) {
      tuples.push({ ...base, calls: 0, polls: 0, category: `stopped:${stoppedBy}`, decoded: false, adapterVersion: null });
      continue;
    }
    const taskId = await mkTask(e.action === "media_user_info" ? "fetch_profile" : "fetch_content_list", e.platform, rootId, `entry-${i}`);
    taskIds.push(taskId);
    const spec = (seq: number, action: string, request: ProviderRequest, expected: string): CallSpec => ({
      syncTaskId: taskId,
      fencingToken: 1n,
      platformId: platformIds.get(e.platform)!,
      providerId: provider!.providerId,
      attemptNo: 1,
      callSequence: seq,
      requestedAction: action,
      expectedResponseAction: expected,
      request,
    });
    const platform = e.platform as Platform;
    const interpret = async (c: Extract<ExecuteOutcome, { kind: "captured" }>["captured"]) => {
      const i = e.action === "media_user_info" ? await interpretCaptured(db, c, (b) => decodeProfile(platform, b)) : await interpretCaptured(db, c, (b) => decodeVideoList(platform, b));
      return { outcome: i.outcome, adapterVersion: i.lineage.adapterVersion };
    };
    const report = async (ex: ExecuteOutcome): Promise<{ category: string; decoded: boolean; adapterVersion: string | null; pending: boolean; providerTaskId: string | null }> => {
      if (ex.kind === "captured") {
        // 先落 ODS（网关已保证），再解码；解码只为判断形态，不投影任何业务事实
        const interpreted = await interpret(ex.captured);
        const out = interpreted.outcome;
        const pending = out.outcome === "not_succeeded" && PENDING.has(out.taskStatus);
        return { category: ex.captured.classification.category, decoded: out.outcome === "decoded", adapterVersion: interpreted.adapterVersion, pending, providerTaskId: ex.captured.meta.providerTaskId };
      }
      if (ex.kind === "not_sent") stopFrom(ex.reason);
      const category = ex.kind === "not_sent" ? `stopped:${ex.reason.replace(/^policy:/, "")}` : ex.kind === "transport_failed" ? "transport_failed" : ex.kind;
      return { category, decoded: false, adapterVersion: null, pending: false, providerTaskId: null };
    };

    const submitMode: ExecutionMode = e.mode;
    let r = await report(await gateway.execute(spec(1, e.action, buildRequest({ action: e.action, mode: submitMode, locator: e.locator }), e.action)));
    if (e.mode === "asynchronous" && r.pending && r.providerTaskId !== null && SAFE_TASK_ID.test(r.providerTaskId)) {
      // 异步：每次轮询是独立的 ProviderCall；达到 max_polls / deadline 时在发送前被封口
      for (let k = 1; stoppedBy === null; k++) {
        await sleep(plan.poll_interval_ms ?? 2000);
        r = await report(await gateway.execute(spec(1 + k, "task_lookup", { method: "GET", path: `/openapi/v1/tasks/${r.providerTaskId ?? ""}`, query: {}, body: null }, e.action)));
        if (!r.pending) break;
        if (r.providerTaskId === null) break;
      }
    }
    if (!(r.category === "none" && r.decoded)) notOk.set(taskId, r.category.startsWith("stopped:") ? { status: "cancelled", code: r.category } : { status: "failed", code: r.category === "none" ? "not_decoded" : r.category });
    const rows = await db.select().from(odsProviderCalls).where(and(eq(odsProviderCalls.syncTaskId, taskId), ne(odsProviderCalls.callStatus, "prepared")));
    const sent = rows.filter((c) => c.outcome !== "not_sent");
    tuples.push({
      ...base,
      calls: sent.filter((c) => c.requestedAction !== "task_lookup").length,
      polls: sent.filter((c) => c.requestedAction === "task_lookup").length,
      category: r.category,
      decoded: r.decoded,
      adapterVersion: r.adapterVersion,
    });
  }

  // 收尾：任务终态如实反映每个条目的结果（让一年清理可以回收）；批次反映「全成功 / 部分成功 / 全失败」，被上限截断也算部分
  const finishedAt = clock.now();
  const done = { leaseOwner: null, leaseExpiresAt: null, finishedAt, updatedAt: finishedAt };
  const okIds = taskIds.filter((id) => !notOk.has(id));
  const failedCount = [...notOk.values()].filter((v) => v.status === "failed").length;
  if (okIds.length) await db.update(syncTasks).set({ status: "succeeded", ...done }).where(inArray(syncTasks.taskId, okIds));
  for (const [id, v] of notOk) await db.update(syncTasks).set({ status: v.status, lastErrorCode: v.code.slice(0, 128), ...done }).where(eq(syncTasks.taskId, id));
  const rootFailed = failedCount > 0;
  await db.update(syncTasks).set(rootFailed ? { status: "failed", lastErrorCode: "child_failed", ...done } : { status: "succeeded", ...done }).where(eq(syncTasks.taskId, rootId));
  await db
    .update(syncBatches)
    .set({
      status: notOk.size === 0 && stoppedBy === null ? "succeeded" : okIds.length > 0 ? "partial_succeeded" : "failed",
      succeededTaskCount: okIds.length + (rootFailed ? 0 : 1),
      failedTaskCount: failedCount + (rootFailed ? 1 : 0),
      skippedTaskCount: plan.allowlist.length - taskIds.length + (notOk.size - failedCount),
      finishedAt,
      updatedAt: finishedAt,
    })
    .where(eq(syncBatches.batchId, batchId));

  // 汇总：全部来自落库的 ProviderCall / payload，而不是内存里的响应
  const spent = await spentFor(db, rootId);
  const family = [rootId, ...taskIds];
  const calls = await db.select().from(odsProviderCalls).where(inArray(odsProviderCalls.syncTaskId, family)).orderBy(odsProviderCalls.providerCallId);
  const sentCalls = calls.filter((c) => c.callStatus !== "prepared" && c.outcome !== "not_sent");
  const payloads = sentCalls.length ? await db.select().from(odsPayloads).where(inArray(odsPayloads.providerCallId, sentCalls.map((c) => c.providerCallId))) : [];
  const sumBytes = (role: string) => payloads.filter((p) => p.payloadRole === role).reduce((n, p) => n + Number(p.byteLength), 0);
  const summary: SmokeSummary = {
    planSha256: auth.planSha256,
    approvedBy: auth.approvedBy,
    environment: plan.environment,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stoppedBy,
    tuples,
    totals: {
      calls: spent.calls,
      polls: spent.polls,
      bytesSent: sumBytes("request_body"),
      bytesReceived: sumBytes("response_body"),
      latencyMsTotal: Math.round(sentCalls.reduce((n, c) => n + Number(c.elapsedSeconds ?? 0) * 1000, 0)),
      estimatedPoints: spent.points,
      estimatedYuan: Math.round(spent.points * YUAN_PER_POINT * 1e6) / 1e6,
    },
    evidence: sentCalls.map((c) => ({
      providerCallId: c.providerCallId.toString(),
      requestedAction: c.requestedAction,
      httpStatus: c.httpStatus,
      responseSha256Prefix: payloads.find((p) => p.providerCallId === c.providerCallId && p.payloadRole === "response_body")?.sha256.toString("hex").slice(0, 16) ?? null,
      providerTaskIdPresent: c.providerTaskId !== null,
    })),
  };
  deps.log?.(JSON.stringify({ event: "smoke.finish", at: summary.finishedAt, plan_sha256: summary.planSha256, stopped_by: stoppedBy, calls: summary.totals.calls, polls: summary.totals.polls, estimated_points: summary.totals.estimatedPoints }));
  return summary;
}
