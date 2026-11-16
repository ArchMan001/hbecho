// 运行的租约、fencing、幂等与终态（JP-15、宪法 C14）。运行表即队列：运行数量很少，阶段进度本来就要持久化在运行上。
// 陈旧 worker 的写入被拒绝并零写入：所有写运行内容的事务都先锁运行行并核对 fencing_token 与 status。
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { judgementRuns } from "../../../db/schema";
import { jcsSha256 } from "../../canonical-json";
import type { Clock } from "../../raw-capture/ports";
import { JudgementError, isDuplicateKey } from "../errors";
import type { RunKind } from "../run-ops";

export type RunRow = typeof judgementRuns.$inferSelect;
export class StaleLeaseError extends Error {
  constructor() {
    super("租约已失效（被别的 worker 接手、取消或已终态）");
    this.name = "StaleLeaseError";
  }
}
export const ACTIVE_STATUSES = ["planned", "running", "waiting"] as const;

export function createClaim(deps: { db: Db; clock: Clock; leaseSeconds: number }) {
  const { db, clock } = deps;
  const activeKeyOf = (planId: bigint, version: number): Buffer => jcsSha256({ plan_id: String(planId), version });

  /** 新建运行；同版本已有未终态运行 → run_active；同幂等键重复提交返回已有运行。 */
  async function createRun(
    runner: Pick<Db, "insert" | "select">,
    a: { planId: bigint; version: number; kind: RunKind; actor: string; userId: bigint | null; scopeSummary?: unknown; expiresAt?: Date; idempotencyKey?: string },
  ): Promise<{ runId: bigint; created: boolean }> {
    const now = clock.now();
    const idem = a.idempotencyKey === undefined ? null : jcsSha256({ plan_id: String(a.planId), version: a.version, actor: a.actor, key: a.idempotencyKey });
    if (idem) {
      const [have] = await runner.select({ id: judgementRuns.runId }).from(judgementRuns).where(eq(judgementRuns.idempotencyKey, idem));
      if (have) return { runId: have.id, created: false };
    }
    try {
      const [r] = await runner.insert(judgementRuns).values({
        planId: a.planId,
        version: a.version,
        runKind: a.kind,
        status: "planned",
        phase: "freeze",
        frozen: {},
        idempotencyKey: idem,
        activeKey: activeKeyOf(a.planId, a.version),
        submittedByActor: a.actor,
        submittedByUserId: a.userId,
        scopeSummary: a.scopeSummary ?? null,
        nextTickAt: now,
        expiresAt: a.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { runId: BigInt(r.insertId), created: true };
    } catch (e) {
      if (isDuplicateKey(e)) throw new JudgementError("conflict", "run_active", "这个版本已有未结束的运行");
      throw e;
    }
  }

  const eligible = (now: Date) =>
    or(
      and(inArray(judgementRuns.status, ["planned", "waiting"]), or(isNull(judgementRuns.nextTickAt), lte(judgementRuns.nextTickAt, now))),
      // running 的只有租约过期（持有者失联）才可接手
      and(eq(judgementRuns.status, "running"), lte(judgementRuns.leaseExpiresAt, now)),
    );
  async function takeLease(tx: DbTx, runId: bigint, owner: string): Promise<RunRow> {
    const now = clock.now();
    await tx
      .update(judgementRuns)
      .set({ status: "running", leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + deps.leaseSeconds * 1000), fencingToken: sql`${judgementRuns.fencingToken} + 1`, startedAt: sql`COALESCE(${judgementRuns.startedAt}, ${now})`, updatedAt: now })
      .where(eq(judgementRuns.runId, runId));
    const [row] = await tx.select().from(judgementRuns).where(eq(judgementRuns.runId, runId));
    return row!;
  }
  /** 领取指定运行；不可领取（别人持有租约、已终态、没到下次 tick 时间）返回 null。 */
  async function claim(runId: bigint, owner: string): Promise<RunRow | null> {
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ id: judgementRuns.runId }).from(judgementRuns).where(and(eq(judgementRuns.runId, runId), eligible(clock.now()))).for("update");
      return row ? takeLease(tx, runId, owner) : null;
    });
  }
  /** 领取下一个可领取的运行（SKIP LOCKED，多 worker 互不阻塞）。 */
  async function claimNext(owner: string): Promise<RunRow | null> {
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ id: judgementRuns.runId }).from(judgementRuns).where(eligible(clock.now())).orderBy(asc(judgementRuns.runId)).limit(1).for("update", { skipLocked: true });
      return row ? takeLease(tx, row.id, owner) : null;
    });
  }

  /** 写运行内容的事务入口：锁运行行并核对 fencing；陈旧则整笔放弃（零写入）。 */
  async function withFence<T>(run: Pick<RunRow, "runId" | "fencingToken">, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const [cur] = await tx.select({ token: judgementRuns.fencingToken, status: judgementRuns.status }).from(judgementRuns).where(eq(judgementRuns.runId, run.runId)).for("update");
      if (!cur || cur.token !== run.fencingToken || cur.status !== "running") throw new StaleLeaseError();
      return fn(tx);
    });
  }
  const released = { leaseOwner: null, leaseExpiresAt: null } as const;
  /** tick 结束：释放租约，进入 waiting（还有活或在等依赖）或终态。fencing 不回退。 */
  async function settle(
    run: Pick<RunRow, "runId" | "fencingToken">,
    to:
      | { status: "waiting"; nextTickAt: Date; phase?: string; phaseCursor?: bigint | null; phaseDetail?: unknown; attemptCount?: number }
      | { status: "completed"; counters: Partial<Pick<RunRow, "participantCount" | "contentTotal" | "c1Count" | "c2Count" | "c3Count" | "staleUsed">> }
      | { status: "failed"; code: string; detail?: unknown }
      | { status: "cancelled" },
    extra?: (tx: DbTx) => Promise<void>,
  ): Promise<void> {
    const now = clock.now();
    await withFence(run, async (tx) => {
      const base = { ...released, updatedAt: now };
      if (to.status === "waiting") {
        await tx.update(judgementRuns).set({ ...base, status: "waiting", nextTickAt: to.nextTickAt, ...(to.phase === undefined ? {} : { phase: to.phase }), ...(to.phaseCursor === undefined ? {} : { phaseCursor: to.phaseCursor }), ...(to.phaseDetail === undefined ? {} : { phaseDetail: to.phaseDetail }), ...(to.attemptCount === undefined ? {} : { attemptCount: to.attemptCount }) }).where(eq(judgementRuns.runId, run.runId));
      } else if (to.status === "completed") {
        await tx.update(judgementRuns).set({ ...base, status: "completed", activeKey: null, nextTickAt: null, completedAt: now, phase: "done", ...to.counters }).where(eq(judgementRuns.runId, run.runId));
      } else if (to.status === "failed") {
        await tx.update(judgementRuns).set({ ...base, status: "failed", activeKey: null, nextTickAt: null, lastErrorCode: to.code, lastErrorDetail: (to.detail ?? null) as never }).where(eq(judgementRuns.runId, run.runId));
      } else {
        await tx.update(judgementRuns).set({ ...base, status: "cancelled", activeKey: null, nextTickAt: null }).where(eq(judgementRuns.runId, run.runId));
      }
      await extra?.(tx);
    });
  }

  /** 取消：把未终态运行置 cancelled、清活动键；在途阶段在下一个块边界发现并停止（withFence 失败）。 */
  async function cancel(runId: bigint, runner: Pick<Db, "update"> = db): Promise<boolean> {
    const now = clock.now();
    const [r] = await runner
      .update(judgementRuns)
      .set({ status: "cancelled", activeKey: null, nextTickAt: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(judgementRuns.runId, runId), inArray(judgementRuns.status, [...ACTIVE_STATUSES])));
    return r.affectedRows > 0;
  }
  /** 续跑 failed 的运行：在原行上从持久化的阶段继续（已定的内容不重算）。同版本已有未终态运行则冲突。 */
  async function resume(runId: bigint): Promise<boolean> {
    const [run] = await db.select().from(judgementRuns).where(eq(judgementRuns.runId, runId));
    if (!run || run.status !== "failed") return false;
    try {
      const [r] = await db
        .update(judgementRuns)
        .set({ status: "planned", activeKey: activeKeyOf(run.planId, run.version), nextTickAt: clock.now(), attemptCount: 0, lastErrorCode: null, lastErrorDetail: null, updatedAt: clock.now() })
        .where(and(eq(judgementRuns.runId, runId), eq(judgementRuns.status, "failed")));
      return r.affectedRows > 0;
    } catch (e) {
      if (isDuplicateKey(e)) throw new JudgementError("conflict", "run_active", "这个版本已有未结束的运行，不能续跑");
      throw e;
    }
  }
  async function get(runId: bigint): Promise<RunRow | null> {
    const [r] = await db.select().from(judgementRuns).where(eq(judgementRuns.runId, runId));
    return r ?? null;
  }
  return { createRun, claim, claimNext, withFence, settle, cancel, resume, get, activeKeyOf };
}
export type Claim = ReturnType<typeof createClaim>;
