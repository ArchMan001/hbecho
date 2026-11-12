// C 自己的任务表（requirements SG-13、SG-D06）：幂等入队、租约领取、fencing 写入、退避重试与 dead。不复用 sync_tasks / orchestrator。
// 网络 IO 期间不持有数据库事务：领取是一个短事务，之后在事务外调用，最后用 fenced() 开一个短事务写结果。
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { signalResults, signalTasks } from "../../../db/schema";
import { jcsSha256, type JcsValue } from "../../canonical-json";
import type { Clock } from "../../raw-capture";
import type { SignalAuditSink } from "../audit";
import { SERVICE_ACTOR } from "../authz";
import { successExpiry } from "../ttl";

export type TaskKind = (typeof signalTasks.$inferSelect)["kind"];
export type TaskRow = typeof signalTasks.$inferSelect;
export type DeadReason = "retries_exhausted" | "reference_unreadable" | "dependency_timeout" | "invalid_request" | "run_cancelled" | "run_not_running" | "model_changed";

export interface QueueDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
}

/** 任务幂等键 = jcsSha256({v, kind, ...复用键或分块键})。 */
export const idempotencyKeyOf = (kind: string, key: JcsValue): Buffer => jcsSha256({ v: "signal-task.v1", kind, key });

export interface NewTask {
  kind: TaskKind;
  key: Buffer;
  params: unknown;
  maxAttempts: number;
  priority?: number;
  runId?: bigint;
}
export type EnqueueOutcome = "created" | "reused" | "revived" | "requeued";

/**
 * 批量幂等入队（一个短事务）。已有任务：活动的（pending / running / retry_wait）→ reused；dead → revived（计数清零）；
 * succeeded 但结果行已被保留期清理（result_id 为空）→ requeued：任务比结果活得久，不能让旧任务挡住重新补算。
 * 并发的同键入队靠唯一键 + no-op 的 ON DUPLICATE KEY UPDATE 收敛。
 */
export async function enqueueMany(deps: QueueDeps, tasks: NewTask[]): Promise<Map<string, EnqueueOutcome>> {
  const out = new Map<string, EnqueueOutcome>();
  if (tasks.length === 0) return out;
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    const keys = tasks.map((t) => t.key);
    const existing = await tx.select().from(signalTasks).where(inArray(signalTasks.idempotencyKey, keys));
    const byKey = new Map(existing.map((e) => [e.idempotencyKey.toString("hex"), e]));
    const fresh: NewTask[] = [];
    for (const t of tasks) {
      const hex = t.key.toString("hex");
      const old = byKey.get(hex);
      if (!old) {
        fresh.push(t);
        out.set(hex, "created");
      } else if (old.status === "dead" || (old.status === "succeeded" && old.resultId === null)) {
        await tx
          .update(signalTasks)
          .set({ status: "pending", attemptCount: 0, deferCount: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, resultId: null, lastErrorCode: null, lastErrorDetail: null, finishedAt: null, expiresAt: successExpiry(now), updatedAt: now })
          .where(eq(signalTasks.taskId, old.taskId));
        out.set(hex, old.status === "dead" ? "revived" : "requeued");
      } else out.set(hex, "reused");
    }
    if (fresh.length > 0) {
      await tx
        .insert(signalTasks)
        .values(
          fresh.map((t) => ({
            kind: t.kind,
            idempotencyKey: t.key,
            params: t.params,
            status: "pending",
            priority: t.priority ?? 0,
            maxAttempts: t.maxAttempts,
            runId: t.runId ?? null,
            createdAt: now,
            updatedAt: now,
            expiresAt: successExpiry(now), // 任务保留一年（与 ODS 同寿命）
          })),
        )
        .onDuplicateKeyUpdate({ set: { taskId: sql`task_id` } });
    }
  });
  return out;
}

export interface Claimed {
  task: TaskRow;
  token: bigint;
}

/**
 * 领取到期的任务：pending、到期的 retry_wait、租约已过期的 running（上一个持有者失联）。
 * FOR UPDATE SKIP LOCKED 保证两个 worker 不会拿到同一行；fencing token 每次领取 +1，使旧持有者的写入失效。
 * 每次领取算一次尝试；崩溃后被接手同样计数，所以反复崩溃的任务最终 dead，而不是永远重跑。
 */
export async function claim(deps: QueueDeps, o: { workerId: string; leaseMs: number; limit: number; kinds?: readonly TaskKind[] }): Promise<Claimed[]> {
  const now = deps.clock.now();
  const claimed: Claimed[] = [];
  const dead: TaskRow[] = [];
  await deps.db.transaction(async (tx) => {
    const due = and(
      or(eq(signalTasks.status, "pending"), and(eq(signalTasks.status, "retry_wait"), lte(signalTasks.nextAttemptAt, now)), and(eq(signalTasks.status, "running"), lt(signalTasks.leaseExpiresAt, now))),
      o.kinds ? inArray(signalTasks.kind, [...o.kinds]) : undefined,
    );
    const rows = await tx.select().from(signalTasks).where(due).orderBy(sql`${signalTasks.priority} DESC`, signalTasks.taskId).limit(o.limit).for("update", { skipLocked: true });
    for (const row of rows) {
      if (row.attemptCount >= row.maxAttempts) {
        // 接手一个已经用完尝试次数的失联任务：不再运行
        await tx.update(signalTasks).set({ status: "dead", lastErrorCode: "retries_exhausted", leaseOwner: null, leaseExpiresAt: null, finishedAt: now, updatedAt: now }).where(eq(signalTasks.taskId, row.taskId));
        dead.push(row);
        continue;
      }
      const token = row.fencingToken + 1n;
      await tx
        .update(signalTasks)
        .set({ status: "running", attemptCount: row.attemptCount + 1, leaseOwner: o.workerId, leaseExpiresAt: new Date(now.getTime() + o.leaseMs), fencingToken: token, nextAttemptAt: null, updatedAt: now })
        .where(eq(signalTasks.taskId, row.taskId));
      claimed.push({ task: { ...row, status: "running", attemptCount: row.attemptCount + 1, fencingToken: token }, token });
    }
  });
  for (const d of dead) emitDead(deps, d, "retries_exhausted");
  return claimed;
}

function emitDead(deps: QueueDeps, t: TaskRow, reason: DeadReason): void {
  deps.audit({ event_type: "task_dead", actor: SERVICE_ACTOR, occurred_at: deps.clock.now().toISOString(), reason_code: reason, target_type: "signal_task", target_id: String(t.taskId), signal_key: (t.params as { signal_key?: string })?.signal_key ?? t.kind });
}

export type Fenced<T> = { ok: true; value: T } | { ok: false; reason: "stale" };

/** 短事务 + fencing：任务仍由这个 token 持有且处于 running 才执行 fn；陈旧的 worker 零写入。 */
export async function fenced<T>(deps: QueueDeps, c: Claimed, fn: (tx: DbTx, now: Date) => Promise<T>): Promise<Fenced<T>> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(signalTasks).where(eq(signalTasks.taskId, c.task.taskId)).for("update");
    if (!row || row.fencingToken !== c.token || row.status !== "running") return { ok: false as const, reason: "stale" as const };
    return { ok: true as const, value: await fn(tx, deps.clock.now()) };
  });
}

/** 写结果行（唯一键冲突 = 命中，取已有那一行）并把任务置 succeeded。 */
export async function succeed(deps: QueueDeps, c: Claimed, result: typeof signalResults.$inferInsert): Promise<Fenced<bigint>> {
  return fenced(deps, c, async (tx, now) => {
    await tx.insert(signalResults).values(result).onDuplicateKeyUpdate({ set: { resultId: sql`result_id` } });
    const [row] = await tx
      .select({ id: signalResults.resultId })
      .from(signalResults)
      .where(and(eq(signalResults.signalKey, result.signalKey), eq(signalResults.capabilityId, result.capabilityId), eq(signalResults.materialSha256, result.materialSha256), eq(signalResults.paramSha256, result.paramSha256), eq(signalResults.capabilityVersion, result.capabilityVersion)));
    await tx.update(signalTasks).set({ status: "succeeded", resultId: row!.id, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorDetail: null, finishedAt: now, updatedAt: now }).where(eq(signalTasks.taskId, c.task.taskId));
    return row!.id;
  });
}

/** 瞬时失败：次数没用完 → retry_wait（指数退避）；用完 → dead(retries_exhausted)。**不写结果行**（一次宕机不该固化成 3 个月的失败）。 */
export async function failTransient(deps: QueueDeps, c: Claimed, o: { code: string; detail: string; backoffMs: number }): Promise<Fenced<"retry_wait" | "dead">> {
  const r = await fenced(deps, c, async (tx, now) => {
    const exhausted = c.task.attemptCount >= c.task.maxAttempts;
    await tx
      .update(signalTasks)
      .set({
        status: exhausted ? "dead" : "retry_wait",
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + o.backoffMs * 2 ** (c.task.attemptCount - 1)),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: exhausted ? "retries_exhausted" : o.code,
        lastErrorDetail: { code: o.code, detail: o.detail },
        finishedAt: exhausted ? now : null,
        updatedAt: now,
      })
      .where(eq(signalTasks.taskId, c.task.taskId));
    return exhausted ? ("dead" as const) : ("retry_wait" as const);
  });
  if (r.ok && r.value === "dead") emitDead(deps, c.task, "retries_exhausted");
  return r;
}

/** 配置错误等不可重试的失败：直接 dead，保留原因码与（已脱敏的）详情。 */
export async function failDead(deps: QueueDeps, c: Claimed, o: { reason: DeadReason; detail: string }): Promise<Fenced<"dead">> {
  const r = await fenced(deps, c, async (tx, now) => {
    await tx
      .update(signalTasks)
      .set({ status: "dead", leaseOwner: null, leaseExpiresAt: null, lastErrorCode: o.reason, lastErrorDetail: { code: o.reason, detail: o.detail }, finishedAt: now, updatedAt: now })
      .where(eq(signalTasks.taskId, c.task.taskId));
    return "dead" as const;
  });
  if (r.ok) emitDead(deps, c.task, o.reason);
  return r;
}

/**
 * 依赖未就绪（判定在等 ASR 结果）：不计重试次数——撤销这次领取的尝试计数，defer_count + 1，过 intervalMs 再试；
 * 累计超过 maxDefer 次仍无结果 → dead(dependency_timeout)。
 */
export async function defer(deps: QueueDeps, c: Claimed, o: { intervalMs: number; maxDefer: number; detail: string }): Promise<Fenced<"retry_wait" | "dead">> {
  const r = await fenced(deps, c, async (tx, now) => {
    const timedOut = c.task.deferCount + 1 > o.maxDefer;
    await tx
      .update(signalTasks)
      .set({
        status: timedOut ? "dead" : "retry_wait",
        attemptCount: c.task.attemptCount - 1,
        deferCount: c.task.deferCount + 1,
        nextAttemptAt: timedOut ? null : new Date(now.getTime() + o.intervalMs),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: timedOut ? "dependency_timeout" : "deferred",
        lastErrorDetail: { code: timedOut ? "dependency_timeout" : "deferred", detail: o.detail },
        finishedAt: timedOut ? now : null,
        updatedAt: now,
      })
      .where(eq(signalTasks.taskId, c.task.taskId));
    return timedOut ? ("dead" as const) : ("retry_wait" as const);
  });
  if (r.ok && r.value === "dead") emitDead(deps, c.task, "dependency_timeout");
  return r;
}

/** 活动任务的状态提示：键 → queued | running | dead（succeeded 与不存在不返回）。读取口用它给 missing 加 pending 提示。 */
export async function pendingHints(db: Db, keys: Buffer[]): Promise<Map<string, "queued" | "running" | "dead">> {
  const out = new Map<string, "queued" | "running" | "dead">();
  if (keys.length === 0) return out;
  const rows = await db.select({ key: signalTasks.idempotencyKey, status: signalTasks.status }).from(signalTasks).where(inArray(signalTasks.idempotencyKey, keys));
  for (const r of rows) {
    if (r.status === "pending" || r.status === "retry_wait") out.set(r.key.toString("hex"), "queued");
    else if (r.status === "running") out.set(r.key.toString("hex"), "running");
    else if (r.status === "dead") out.set(r.key.toString("hex"), "dead");
  }
  return out;
}
