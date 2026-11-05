// 运营命令：手工补抓、批次取消、批次列表（FS-13、FS-14.6、design §5.3）。
// 影响面超过一个对象的命令（取消批次、cancel_current）默认只预览，显式 apply 才写（旧系统教训：批量写库默认 dry-run）。
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "../../db/client";
import { accountProfileSnapshots, platforms, staffAccountAssignments as aa, syncBatches, syncTasks } from "../../db/schema";
import { jcsSha256, jcsSha256Hex } from "../canonical-json";
import type { MonitoringResolver } from "../monitoring";
import type { Clock } from "../raw-capture";
import type { ActorContext } from "../tracer-command";
import { inPlatformScope, inStaffScope, requireCap, requireFullScope as requireFullScopeOf } from "./authz";
import type { SyncAuditEvent, SyncAuditSink } from "./audit";
import { SyncError } from "./errors";
import type { PlanReport, BatchPlanner } from "./planner";
import { loadSettings, settingsSnapshot, type SyncRuntime } from "./settings";
import { ACTIVE_TASK_STATUSES } from "./task-keys";

const decimalId = z.string().regex(/^[1-9]\d*$/, "必须是不带前导零的正十进制整数 string");
const supplementInput = z.strictObject({
  accountIds: z.array(decimalId).min(1).max(5000),
  only: z.enum(["profile", "full"]).default("full"),
  ifOlderThanHours: z.number().positive().finite().optional(),
  onBusy: z.enum(["run_now", "queue", "cancel_current"]).default("run_now"),
  apply: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(200),
});
export type SupplementInput = z.input<typeof supplementInput>;

export type SupplementDisposition =
  | { accountId: string; disposition: "queued" }
  | { accountId: string; disposition: "not_due"; lastSuccessAt: string }
  | { accountId: string; disposition: "not_eligible"; reason: string }
  | { accountId: string; disposition: "out_of_scope" }
  | { accountId: string; disposition: "not_found" }
  | { accountId: string; disposition: "reused_active_task"; taskIds: string[] };

export type SupplementResult =
  | { kind: "created"; batchId: string; status: string; deduplicated: boolean; dispositions: SupplementDisposition[]; plan: PlanReport | null }
  | { kind: "no_accounts"; dispositions: SupplementDisposition[] }
  | { kind: "preview"; wouldCancelBatchId: string; openTasks: number; dispositions: SupplementDisposition[]; hint: string };

const batchIdSchema = decimalId;
export interface BatchPreview {
  batchId: string;
  purpose: string;
  status: string;
  openTasksByStatus: Record<string, number>;
}
export type CancelResult = { kind: "preview"; batch: BatchPreview; hint: string } | { kind: "cancelled"; batch: BatchPreview; cancelledTasks: number } | { kind: "noop"; batch: BatchPreview };

const OPEN_BATCH_STATUSES = ["planned", "queued", "running"] as const;

export function createSyncCommands(deps: { db: Db; clock: Clock; resolver: MonitoringResolver; planner: BatchPlanner; runtime: SyncRuntime; audit: SyncAuditSink }) {
  const { db, clock, resolver, planner, runtime, audit } = deps;
  const emit = (e: Omit<SyncAuditEvent, "at" | "event">) => audit.record({ at: clock.now().toISOString(), event: "sync.command", ...e });

  /** 批次级命令（取消批次、cancel_current）的影响面是整个批次：1.0 只允许全范围服务身份（B 域接入后再按批次内账号集合细化）。 */
  const requireFullScope = (actor: ActorContext) => requireFullScopeOf(actor, "取消批次");

  async function lastSuccess(accountId: bigint, only: "profile" | "full"): Promise<Date | null> {
    const [p] = await db.select({ at: max(accountProfileSnapshots.responseReceivedAt) }).from(accountProfileSnapshots).where(eq(accountProfileSnapshots.accountId, accountId));
    if (only === "profile") return p?.at ?? null;
    const [l] = await db
      .select({ at: max(syncTasks.finishedAt) })
      .from(syncTasks)
      .where(and(eq(syncTasks.accountId, accountId), eq(syncTasks.requestedAction, "fetch_content_list"), inArray(syncTasks.status, ["succeeded", "succeeded_with_gap"])));
    // 主页与列表两者中较早的那个：任一过期就视为过期；从未成功过视为无限久（FS-13.4）
    if (!p?.at || !l?.at) return null;
    return p.at.getTime() <= l.at.getTime() ? p.at : l.at;
  }

  /** 锁内：批次置 cancelled，未终态任务置 cancelled 并使旧 fencing token 失效（set-based，不逐行）。 */
  async function cancelInTx(tx: DbTx, batchId: bigint, now: Date): Promise<number> {
    await tx.update(syncBatches).set({ status: "cancelled", finishedAt: now, updatedAt: now }).where(eq(syncBatches.batchId, batchId));
    const res = await tx
      .update(syncTasks)
      .set({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        stopReason: "cancelled_by_actor",
        fencingToken: sql`${syncTasks.fencingToken} + 1`,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(syncTasks.batchId, batchId), inArray(syncTasks.status, [...ACTIVE_TASK_STATUSES])));
    return res[0].affectedRows;
  }

  async function previewOf(batchId: bigint, tx: Db | DbTx = db): Promise<BatchPreview | null> {
    const [b] = await tx.select().from(syncBatches).where(eq(syncBatches.batchId, batchId));
    if (!b) return null;
    const rows = await tx
      .select({ status: syncTasks.status, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(syncTasks)
      .where(and(eq(syncTasks.batchId, batchId), inArray(syncTasks.status, [...ACTIVE_TASK_STATUSES])))
      .groupBy(syncTasks.status);
    return { batchId: batchId.toString(), purpose: b.purpose, status: b.status, openTasksByStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])) };
  }

  async function cancelBatch(rawId: string, actor: ActorContext, opts: { apply?: boolean } = {}): Promise<CancelResult> {
    try {
      requireCap(actor);
      const parsed = batchIdSchema.safeParse(rawId);
      if (!parsed.success) throw new SyncError("invalid_input", "batch_id 必须是十进制整数");
      requireFullScope(actor);
      const batchId = BigInt(parsed.data);
      const before = await previewOf(batchId);
      if (!before) throw new SyncError("not_found", "批次不存在");
      if (!(OPEN_BATCH_STATUSES as readonly string[]).includes(before.status)) {
        emit({ action: "batch_cancel", outcome: "noop", actorId: actor.actorId, batchId: before.batchId });
        return { kind: "noop", batch: before };
      }
      if (!opts.apply) {
        emit({ action: "batch_cancel", outcome: "previewed", actorId: actor.actorId, batchId: before.batchId });
        return { kind: "preview", batch: before, hint: "加 --apply 才会取消；未开始的任务取消，在途任务因租约失效而停止，已落 ODS 的证据保留" };
      }
      const cancelled = await db.transaction(async (tx) => {
        await loadSettings(tx, { lock: true });
        const [b] = await tx.select({ status: syncBatches.status }).from(syncBatches).where(eq(syncBatches.batchId, batchId)).for("update");
        if (!b || !(OPEN_BATCH_STATUSES as readonly string[]).includes(b.status)) return null;
        return cancelInTx(tx, batchId, clock.now());
      });
      const after = (await previewOf(batchId))!;
      if (cancelled === null) {
        emit({ action: "batch_cancel", outcome: "noop", actorId: actor.actorId, batchId: after.batchId });
        return { kind: "noop", batch: after };
      }
      emit({ action: "batch_cancel", outcome: "cancelled", actorId: actor.actorId, batchId: after.batchId, detail: { cancelled_tasks: cancelled } });
      return { kind: "cancelled", batch: after, cancelledTasks: cancelled };
    } catch (e) {
      if (e instanceof SyncError) emit({ action: "batch_cancel", outcome: "rejected", code: e.code, actorId: actor.actorId });
      throw e;
    }
  }

  async function createSupplement(raw: unknown, actor: ActorContext): Promise<SupplementResult> {
    try {
      requireCap(actor);
      const parsed = supplementInput.safeParse(raw);
      if (!parsed.success) throw new SyncError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
      const input = parsed.data;
      if (input.onBusy === "cancel_current") requireFullScope(actor); // 它会取消正在运行的全量批次，即使只是预览也先拒绝
      const ids = [...new Set(input.accountIds)].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      // 1) 逐账号处置：存在性 → 范围 → 有效监控资格（FS-2.4 原因码）→ 新鲜度
      const info = await db
        .select({ accountId: aa.accountId, staffId: aa.staffId, platformCode: platforms.platformCode })
        .from(aa)
        .innerJoin(platforms, eq(platforms.platformId, aa.platformId))
        .where(inArray(aa.accountId, ids));
      const infoBy = new Map(info.map((r) => [r.accountId, r]));
      const dispositions: SupplementDisposition[] = [];
      const eligible: bigint[] = [];
      for (const id of ids) {
        const accountId = id.toString();
        const r = infoBy.get(id);
        if (!r) {
          dispositions.push({ accountId, disposition: "not_found" });
          continue;
        }
        if (!inPlatformScope(actor, r.platformCode) || !inStaffScope(actor, r.staffId)) {
          dispositions.push({ accountId, disposition: "out_of_scope" });
          continue;
        }
        const ex = await resolver.explain(id);
        if (!ex.effective) {
          dispositions.push({ accountId, disposition: "not_eligible", reason: ex.reason ?? "unknown" });
          continue;
        }
        if (input.ifOlderThanHours !== undefined) {
          const last = await lastSuccess(id, input.only);
          if (last && clock.now().getTime() - last.getTime() < input.ifOlderThanHours * 3600_000) {
            dispositions.push({ accountId, disposition: "not_due", lastSuccessAt: last.toISOString() });
            continue;
          }
        }
        eligible.push(id);
        dispositions.push({ accountId, disposition: "queued" });
      }
      if (eligible.length === 0) {
        emit({ action: "supplement", outcome: "rejected", code: "no_eligible_accounts", actorId: actor.actorId });
        return { kind: "no_accounts", dispositions };
      }

      // 2) 在 sync_settings 行锁内：幂等、当前是否有运行中的 full、三种处置
      const commandSha = jcsSha256Hex({ v: "sync-supplement.v1", account_ids: eligible.map(String), only: input.only, on_busy: input.onBusy });
      const batchKey = jcsSha256({ v: "sync-batch.v1", purpose: "supplement", actor: actor.actorId, key: input.idempotencyKey });
      const out = await db.transaction(async (tx) => {
        const { row } = await loadSettings(tx, { lock: true });
        const [dup] = await tx.select().from(syncBatches).where(eq(syncBatches.batchKey, batchKey));
        if (dup) {
          const prev = (dup.settingsSnapshot as { supplement?: { command_sha256?: string } }).supplement?.command_sha256;
          if (prev !== commandSha) throw new SyncError("idempotency_conflict", "同一幂等 key 对应了不同的补抓内容");
          return { kind: "dup" as const, batchId: dup.batchId, status: dup.status };
        }
        const [busy] = await tx.select({ id: syncBatches.batchId }).from(syncBatches).where(and(eq(syncBatches.purpose, "full"), inArray(syncBatches.status, ["planned", "running"]))).limit(1);
        let status: "planned" | "queued" = "planned";
        if (busy && input.onBusy === "queue") status = "queued";
        if (busy && input.onBusy === "cancel_current") {
          const open = await previewOf(busy.id, tx);
          if (!input.apply) {
            return { kind: "preview" as const, busyId: busy.id, openTasks: Object.values(open?.openTasksByStatus ?? {}).reduce((a, b) => a + b, 0) };
          }
          await cancelInTx(tx, busy.id, clock.now());
        }
        const now = clock.now();
        const [ins] = await tx.insert(syncBatches).values({
          batchKey,
          triggerType: "manual",
          purpose: "supplement",
          logicalAt: now,
          status,
          settingsVersion: row.configVersion,
          settingsSnapshot: {
            ...settingsSnapshot(row, runtime),
            supplement: { account_ids: eligible.map(String), only: input.only, on_busy: input.onBusy, command_sha256: commandSha, requested_by: actor.actorId },
          },
          createdAt: now,
          updatedAt: now,
        });
        return { kind: "new" as const, batchId: BigInt(ins.insertId), status, cancelledBusy: busy && input.onBusy === "cancel_current" ? busy.id : null };
      });

      if (out.kind === "preview") {
        emit({ action: "supplement", outcome: "previewed", actorId: actor.actorId, batchId: out.busyId.toString(), detail: { open_tasks: out.openTasks } });
        return {
          kind: "preview",
          wouldCancelBatchId: out.busyId.toString(),
          openTasks: out.openTasks,
          dispositions,
          hint: "cancel_current 会取消正在运行的全量批次；加 apply 才执行",
        };
      }

      // 3) 立即运行的批次在这里规划（排队的由 tick 晋升后规划）；账号的活动任务被复用时，处置改为 reused_active_task
      let plan: PlanReport | null = null;
      if (out.status === "planned") {
        plan = await planner.planBatch(out.batchId);
        const reusedBy = new Map<string, string[]>();
        for (const r of plan.reused) reusedBy.set(r.accountId, [...(reusedBy.get(r.accountId) ?? []), r.taskId]);
        const wantedPerAccount = input.only === "profile" ? 1 : 2;
        for (let i = 0; i < dispositions.length; i++) {
          const d = dispositions[i]!;
          const t = reusedBy.get(d.accountId);
          if (d.disposition === "queued" && t && t.length >= wantedPerAccount) dispositions[i] = { accountId: d.accountId, disposition: "reused_active_task", taskIds: t };
        }
      }
      emit({
        action: "supplement",
        outcome: out.kind === "dup" ? "noop" : "accepted",
        actorId: actor.actorId,
        batchId: out.batchId.toString(),
        detail: { accounts: eligible.length, on_busy: input.onBusy, only: input.only },
      });
      return { kind: "created", batchId: out.batchId.toString(), status: plan ? (plan.outcome === "aborted" ? out.status : plan.outcome) : out.status, deduplicated: out.kind === "dup", dispositions, plan };
    } catch (e) {
      if (e instanceof SyncError) emit({ action: "supplement", outcome: "rejected", code: e.code, actorId: actor.actorId });
      throw e;
    }
  }

  async function listBatches(opts: { limit?: number; purpose?: string; status?: string } = {}) {
    const rows = await db
      .select()
      .from(syncBatches)
      .where(and(opts.purpose ? eq(syncBatches.purpose, opts.purpose) : undefined, opts.status ? eq(syncBatches.status, opts.status) : undefined))
      .orderBy(desc(syncBatches.batchId))
      .limit(Math.min(Math.max(opts.limit ?? 20, 1), 200));
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return rows.map((b) => ({
      batchId: b.batchId.toString(),
      purpose: b.purpose,
      status: b.status,
      skipReason: b.skipReason,
      logicalAt: b.logicalAt.toISOString(),
      startedAt: iso(b.startedAt),
      finishedAt: iso(b.finishedAt),
      mediaFinishedAt: iso(b.mediaFinishedAt),
      planned: b.plannedTaskCount,
      succeeded: b.succeededTaskCount,
      failed: b.failedTaskCount,
      skipped: b.skippedTaskCount,
      gap: b.gapTaskCount,
    }));
  }

  return { createSupplement, cancelBatch, listBatches };
}
export type SyncCommands = ReturnType<typeof createSyncCommands>;
