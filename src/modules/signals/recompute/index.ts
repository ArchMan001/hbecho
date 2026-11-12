// 显式受控重算（requirements SG-11，design §7.10）：带范围、带记录、可预览、可取消、可续跑。**没有「重算全部」。**
// 能力升级本身不触发任何重算；旧值读作 stale，直到有权限的人对一个范围显式执行。
// 分块：recompute_chunk 任务（每块 500 个主体）；推进游标、建下一块、任务 succeeded 在同一个事务里，崩溃后租约过期被接手，
// ingest 是幂等的，所以每个对象恰好被处理一次（历史表无重复）。
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { signalRecomputeRuns, signalTasks } from "../../../db/schema";
import { jcsSha256, type JcsValue } from "../../canonical-json";
import { isDuplicateKey } from "../../activity-plan/errors";
import type { Clock } from "../../raw-capture";
import type { SignalAuditSink } from "../audit";
import { CAP_SEGMENT_MANAGE, SERVICE_ACTOR, assert, type SignalActor } from "../authz";
import { capabilityOf, requireSignal, versionOf, type CatalogEntry } from "../catalog";
import type { SignalsConfig } from "../config";
import { SignalError } from "../errors";
import { createFacts } from "../facts";
import { ingestComment, ingestContent } from "../features/ingest";
import type { Envelope } from "../features/compute";
import type { RequestAsService } from "../scoring/request";
import { latestResultVersions } from "../scoring/results";
import { claim, enqueueIn, enqueueMany, failDead, failTransient, fenced, idempotencyKeyOf, type Claimed, type NewTask, type QueueDeps } from "../tasks/queue";
import { commentFeatures, contentFeatures } from "../../../db/schema";
import { canonicalizeScope, scopeSha, toSubjectScope, type CanonicalScope, type RecomputeScopeInput } from "./scope";

export const RECOMPUTE_CHUNK_SIZE = 500;
const PAGE = 5000;

export interface RecomputeDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
  config: Pick<SignalsConfig, "taskMaxAttempts" | "leaseMs" | "retryBackoffMs">;
  requestAsService: RequestAsService;
  /** 每块处理的主体数；缺省 500。 */
  chunkSize?: number;
}
export interface RecomputeInput {
  signal: string;
  scope: RecomputeScopeInput;
}
export interface RecomputePreview {
  signal: string;
  /** 将处理的对象条数。1.0 只展示条数；档 1 免费，不展示费用。 */
  count: number;
  /** 范围内对象所持该信号的最低能力版本；范围内全无旧值时为 null。 */
  fromVersion: number | null;
  toVersion: number;
}

/** 目标版本 = 目录里该信号当前版本（能力标识含平台的取各平台的最大值）。 */
export const targetVersion = (e: CatalogEntry): number => Math.max(...e.platforms.map((p) => versionOf(capabilityOf(e, p))));

export function createRecompute(deps: RecomputeDeps) {
  const { db, clock } = deps;
  const facts = createFacts(db);
  const q: QueueDeps = { db, clock, audit: deps.audit };
  const emit = (actor: string, event_type: Parameters<SignalAuditSink>[0]["event_type"], e: { runId?: bigint; signal: string; counts?: Record<string, number> }) =>
    deps.audit({ event_type, actor, occurred_at: clock.now().toISOString(), signal_key: e.signal, ...(e.runId === undefined ? {} : { run_id: String(e.runId) }), ...(e.counts ? { counts: e.counts } : {}) });

  /** 分页展开整个范围：条数与最低版本。preview 与 apply 共用，只读。 */
  async function survey(scope: CanonicalScope, entry: CatalogEntry): Promise<{ count: number; lowest: number | null }> {
    let count = 0;
    let lowest: number | null = null;
    for (let after = 0n; ; ) {
      const ids = await facts.scopeSubjects(toSubjectScope(scope), entry.key, after, PAGE);
      if (ids.length === 0) break;
      count += ids.length;
      for (const v of await versionsHeld(entry, ids)) lowest = lowest === null ? v : Math.min(lowest, v);
      after = ids[ids.length - 1]!;
      if (ids.length < PAGE) break;
    }
    return { count, lowest };
  }

  /** 这批主体当前所持该信号的能力版本（没有旧值的不在结果里）。 */
  async function versionsHeld(entry: CatalogEntry, ids: bigint[]): Promise<number[]> {
    if (entry.storage === "feature_row") {
      const rows = entry.object === "comment" ? await db.select({ s: commentFeatures.signals }).from(commentFeatures).where(inArray(commentFeatures.commentId, ids)) : await db.select({ s: contentFeatures.signals }).from(contentFeatures).where(inArray(contentFeatures.contentId, ids));
      return rows.flatMap((r) => ((r.s as Envelope)[entry.key]?.ver === undefined ? [] : [(r.s as Envelope)[entry.key]!.ver]));
    }
    const material = await facts.materialForSignal(entry.key, ids);
    const shas = [...material.values()].flatMap((m) => (m.state === "ready" ? [m.sha256] : []));
    return latestResultVersions(db, entry, shas);
  }

  async function prepare(actor: SignalActor, input: RecomputeInput) {
    assert(actor, CAP_SEGMENT_MANAGE); // 先于任何读库
    const entry = requireSignal(input.signal);
    const scope = await canonicalizeScope(db, actor, input.scope);
    if (entry.storage === "result" && !scope.segment_ref) {
      // 结果类信号的重算需要知道「对哪张标准图 / 哪个判定项」：由监控段给出（judgement 的标准文本无法从旧结果行还原）
      throw new SignalError("input", "segment_ref_required", `${entry.key} 是派生信号，重算必须带 segmentRef`);
    }
    return { entry, scope };
  }

  async function preview(actor: SignalActor, input: RecomputeInput): Promise<RecomputePreview> {
    const { entry, scope } = await prepare(actor, input);
    const s = await survey(scope, entry);
    emit(actor.actor, "recompute_previewed", { signal: entry.key, counts: { count: s.count } });
    return { signal: entry.key, count: s.count, fromVersion: s.lowest, toVersion: targetVersion(entry) };
  }

  const chunkTask = (runId: bigint, after: bigint): NewTask => ({
    kind: "recompute_chunk",
    key: idempotencyKeyOf("recompute_chunk", { run_id: String(runId), after_id: String(after) } as JcsValue),
    params: { run_id: String(runId), after_id: String(after), limit: deps.chunkSize ?? RECOMPUTE_CHUNK_SIZE },
    maxAttempts: deps.config.taskMaxAttempts,
    runId,
  });

  async function apply(actor: SignalActor, input: RecomputeInput): Promise<{ runId: bigint; resumed: boolean; count: number }> {
    const { entry, scope } = await prepare(actor, input);
    const { count, lowest } = await survey(scope, entry);
    if (count === 0) throw new SignalError("input", "scope_empty", "范围展开后没有对象");
    const to = targetVersion(entry);
    const activeKey = jcsSha256({ signal_key: entry.key, to_version: to, scope } as unknown as JcsValue);
    const now = clock.now();
    let resumed = false;
    const load = () => db.select().from(signalRecomputeRuns).where(eq(signalRecomputeRuns.activeKey, activeKey));
    let [run] = await load();
    if (run) {
      resumed = true;
      if (run.status === "failed") {
        await db.update(signalRecomputeRuns).set({ status: "running", finishedAt: null }).where(eq(signalRecomputeRuns.runId, run.runId));
      }
    } else {
      try {
        const [r] = await db.insert(signalRecomputeRuns).values({
          requestedByActor: actor.actor,
          signalKey: entry.key,
          scope,
          scopeSha256: scopeSha(scope),
          scopeCount: count,
          fromVersion: lowest,
          toVersion: to,
          status: "running",
          activeKey,
          cursorId: 0n,
          processedCount: 0,
          startedAt: now,
          createdAt: now,
        });
        [run] = await db.select().from(signalRecomputeRuns).where(eq(signalRecomputeRuns.runId, BigInt(r.insertId)));
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
        [run] = await load(); // 并发的同范围 apply：续跑对方建的 run
        resumed = true;
      }
    }
    // 在 cursor 处入队（幂等；崩溃在「建 run」与「建 chunk」之间、或 chunk 已 dead，都由这里补上 / 复活）
    await enqueueMany(q, [chunkTask(run!.runId, run!.cursorId)]);
    emit(actor.actor, "recompute_applied", { runId: run!.runId, signal: entry.key, counts: { count, resumed: resumed ? 1 : 0 } });
    return { runId: run!.runId, resumed, count };
  }

  async function cancel(actor: SignalActor, input: { runId: bigint }): Promise<void> {
    assert(actor, CAP_SEGMENT_MANAGE);
    const now = clock.now();
    const signal = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(signalRecomputeRuns).where(eq(signalRecomputeRuns.runId, input.runId)).for("update");
      if (!run) throw new SignalError("not_found", "run_not_found", "重算记录不存在");
      if (run.status !== "running" && run.status !== "failed") throw new SignalError("conflict", "run_not_cancellable", `状态为 ${run.status} 的重算不能取消`);
      await tx.update(signalRecomputeRuns).set({ status: "cancelled", activeKey: null, finishedAt: now }).where(eq(signalRecomputeRuns.runId, run.runId));
      // 尚未执行的 chunk 置终态；正在执行的在提交前重读 run 状态，看到 cancelled 就不再建下一块
      await tx
        .update(signalTasks)
        .set({ status: "dead", lastErrorCode: "run_cancelled", leaseOwner: null, leaseExpiresAt: null, finishedAt: now, updatedAt: now })
        .where(and(eq(signalTasks.runId, run.runId), inArray(signalTasks.status, ["pending", "retry_wait"])));
      return run.signalKey;
    });
    emit(actor.actor, "recompute_cancelled", { runId: input.runId, signal });
  }

  // ───────────── chunk 执行 ─────────────
  async function runChunk(c: Claimed): Promise<"succeeded" | "retry_wait" | "dead" | "stale"> {
    const p = c.task.params as { run_id: string; after_id: string; limit: number };
    const [run] = await db.select().from(signalRecomputeRuns).where(eq(signalRecomputeRuns.runId, BigInt(p.run_id)));
    const dead = async (reason: "run_cancelled" | "run_not_running" | "invalid_request", detail: string) => ((await failDead(q, c, { reason, detail })).ok ? ("dead" as const) : ("stale" as const));
    if (!run) return dead("invalid_request", "重算记录不存在");
    if (run.status === "cancelled") return dead("run_cancelled", "重算已取消");
    if (run.status !== "running") return dead("run_not_running", `重算状态是 ${run.status}`);
    const entry = requireSignal(run.signalKey);
    const scope = run.scope as CanonicalScope;
    let ids: bigint[];
    try {
      ids = await facts.scopeSubjects(toSubjectScope(scope), entry.key, BigInt(p.after_id), p.limit);
      await processSubjects(entry, scope, ids);
    } catch (e) {
      const r = await failTransient(q, c, { code: "chunk_error", detail: e instanceof Error ? e.message.slice(0, 300) : String(e), backoffMs: deps.config.retryBackoffMs });
      if (r.ok && r.value === "dead") {
        await db.update(signalRecomputeRuns).set({ status: "failed", finishedAt: clock.now() }).where(and(eq(signalRecomputeRuns.runId, run.runId), eq(signalRecomputeRuns.status, "running")));
      }
      return r.ok ? r.value : "stale";
    }
    // 推进游标 / 建下一块 / 任务 succeeded：同一个事务；提交前重读 run，已 cancelled / failed 则不建下一块
    const r = await fenced(q, c, async (tx, now) => {
      const [cur] = await tx.select().from(signalRecomputeRuns).where(eq(signalRecomputeRuns.runId, run.runId)).for("update");
      if (cur!.status === "running") {
        const last = ids.at(-1) ?? cur!.cursorId;
        const finished = ids.length < p.limit;
        await tx
          .update(signalRecomputeRuns)
          .set({ processedCount: cur!.processedCount + ids.length, cursorId: last, ...(finished ? { status: "completed", activeKey: null, finishedAt: now } : {}) })
          .where(eq(signalRecomputeRuns.runId, run.runId));
        if (!finished) await enqueueIn(tx, now, [chunkTask(run.runId, last)]);
      }
      await tx.update(signalTasks).set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorDetail: null, finishedAt: now, updatedAt: now }).where(eq(signalTasks.taskId, c.task.taskId));
    });
    return r.ok ? "succeeded" : "stale";
  }

  async function processSubjects(entry: CatalogEntry, scope: CanonicalScope, ids: bigint[]): Promise<void> {
    if (ids.length === 0) return;
    const ingestDeps = { db, clock };
    if (entry.storage === "feature_row") {
      if (entry.object === "comment") {
        const got = await facts.commentFacts(ids);
        for (const id of ids) if (got.has(id)) await ingestComment(ingestDeps, got.get(id)!, "recompute");
      } else {
        const got = await facts.contentFacts(ids);
        for (const id of ids) if (got.has(id)) await ingestContent(ingestDeps, got.get(id)!, "recompute"); // 同一行的三个文本信号一并升到当前版本
      }
      return;
    }
    // 派生信号：按监控段给出的标准图 / 判定项，为「缺失或 stale」的（素材 × 参数）建当前版本的任务
    const seg = scope.segment_ref!;
    await deps.requestAsService({ planId: BigInt(seg.plan_id), version: seg.version }, ids.map((id) => ({ kind: entry.object, id })), { includeStale: true, only: entry.key });
  }

  /** 领取并执行一个 recompute_chunk（每个 worker 一次一块，避免堆积）；返回处理的块数。 */
  async function runBatch(): Promise<number> {
    const claimed = await claim(q, { workerId: SERVICE_ACTOR, leaseMs: deps.config.leaseMs, limit: 1, kinds: ["recompute_chunk"] });
    for (const c of claimed) await runChunk(c);
    return claimed.length;
  }
  return { preview, apply, cancel, runBatch, runChunk };
}
export type Recompute = ReturnType<typeof createRecompute>;
