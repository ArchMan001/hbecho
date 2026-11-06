// 运营处置命令（FS-12.5、FS-13.7、FS-14；design §9）：改绑、确认删除、质量问题状态、批次放回重试、外部账号启停与列表。
// 全部先校验 Capability 与范围，再读写；不调用供应商，不物理删除任何数据；每个命令写审计事件。
// 监控开关在 monitoring/set-switch.ts；外部账号创建在 external.ts（它要走身份录入流程）。
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client";
import { dataQualityIssues, externalAccounts, mediaStaff, platforms, staffAccountAssignments as aa, syncBatches, syncTasks } from "../../db/schema";
import type { Clock } from "../raw-capture";
import { CAP_ACCOUNT_MANAGE, CAP_EXTERNAL_MANAGE, CAP_SYNC_TRIGGER, TracerError, type ActorContext, type TracerCommands } from "../tracer-command";
import { SyncError, inPlatformScope, inStaffScope, loadSettings, requireCap, requireFullScope, requirePlatformAdmin, type SyncAuditEvent, type SyncAuditSink } from "../sync-schedule";

const decimalId = z.string().regex(/^[1-9]\d*$/, "必须是不带前导零的正十进制整数 string");
const parse = <T extends z.ZodType>(schema: T, raw: unknown): z.output<T> => {
  const r = schema.safeParse(raw);
  if (!r.success) throw new SyncError("invalid_input", r.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
  return r.data;
};
const isDuplicateKey = (e: unknown): boolean => {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) if (cur.code === "ER_DUP_ENTRY") return true;
  return false;
};
const EXAMPLES = 20;

export function createSyncOps(deps: { db: Db; clock: Clock; audit: SyncAuditSink; /** external add 需要；其余命令不用。 */ tracer?: Pick<TracerCommands, "submitExternal"> }) {
  const { db, clock, audit } = deps;
  const emit = (action: SyncAuditEvent["action"], e: Omit<SyncAuditEvent, "at" | "event" | "action">) => audit.record({ at: clock.now().toISOString(), event: "sync.command", action, ...e });
  /** 统一的拒绝审计：只有 SyncError 才记（内部错误不是处置结果）。 */
  async function guarded<T>(action: SyncAuditEvent["action"], actor: ActorContext, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof SyncError) emit(action, { outcome: "rejected", code: e.code, actorId: actor.actorId });
      throw e;
    }
  }

  async function loadAssignment(accountId: bigint) {
    const [r] = await db
      .select({ assignmentId: aa.assignmentId, watchType: aa.watchType, staffId: aa.staffId, platformCode: platforms.platformCode, platformId: aa.platformId, slotReleasedAt: aa.slotReleasedAt, enabled: aa.monitoringEnabled, accountStatus: externalAccounts.status })
      .from(aa)
      .innerJoin(platforms, eq(platforms.platformId, aa.platformId))
      .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
      .where(eq(aa.accountId, accountId));
    return r;
  }

  // ── account rebind ──
  const rebindInput = z.strictObject({ accountId: decimalId, staffId: decimalId });
  async function rebind(raw: unknown, actor: ActorContext) {
    return guarded("account_rebind", actor, async () => {
      const i = parse(rebindInput, raw);
      requireCap(actor, CAP_ACCOUNT_MANAGE);
      const accountId = BigInt(i.accountId);
      const toStaff = BigInt(i.staffId);
      const a = await loadAssignment(accountId);
      if (!a) throw new SyncError("not_found", "账号不存在或没有归属");
      if (a.watchType !== "staff") throw new SyncError("invalid_input", "外部监控账号没有专员归属，不能改绑");
      if (!inPlatformScope(actor, a.platformCode) || !inStaffScope(actor, a.staffId) || !inStaffScope(actor, toStaff)) throw new SyncError("out_of_scope", "账号或目标专员超出调用方范围");
      if (a.staffId === toStaff) {
        emit("account_rebind", { outcome: "noop", actorId: actor.actorId, detail: { account_id: i.accountId, staff_id: i.staffId } });
        return { kind: "noop" as const, accountId: i.accountId, staffId: i.staffId };
      }
      const [staff] = await db.select({ status: mediaStaff.status }).from(mediaStaff).where(eq(mediaStaff.staffId, toStaff));
      if (!staff) throw new SyncError("not_found", "目标专员不存在");
      if (staff.status !== "active") throw new SyncError("invalid_input", "目标专员已停用");
      try {
        await db.transaction(async (tx) => {
          // 名额检查与改写在同一事务：生成列上的唯一索引是最终裁判，这里先查出稳定的拒绝原因
          const [holder] = await tx
            .select({ accountId: aa.accountId })
            .from(aa)
            .where(and(eq(aa.staffId, toStaff), eq(aa.platformId, a.platformId), eq(aa.watchType, "staff"), isNull(aa.slotReleasedAt)))
            .for("update");
          if (holder) throw new SyncError("slot_taken", "目标专员在该平台已有占用名额的账号");
          await tx.update(aa).set({ staffId: toStaff, updatedAt: clock.now() }).where(eq(aa.accountId, accountId));
        });
      } catch (e) {
        if (isDuplicateKey(e)) throw new SyncError("slot_taken", "目标专员在该平台已有占用名额的账号");
        throw e;
      }
      // 不改写已发生的 discovery / 快照里的归属（采集当时的事实）
      emit("account_rebind", { outcome: "applied", actorId: actor.actorId, detail: { account_id: i.accountId, from_staff_id: a.staffId?.toString() ?? null, to_staff_id: i.staffId } });
      return { kind: "rebound" as const, accountId: i.accountId, fromStaffId: a.staffId?.toString() ?? null, toStaffId: i.staffId };
    });
  }

  // ── account confirm-deleted ──
  const confirmInput = z.strictObject({ accountId: decimalId });
  async function confirmDeleted(raw: unknown, actor: ActorContext) {
    return guarded("account_confirm_deleted", actor, async () => {
      const i = parse(confirmInput, raw);
      requireCap(actor, CAP_ACCOUNT_MANAGE);
      const accountId = BigInt(i.accountId);
      const a = await loadAssignment(accountId);
      if (!a) throw new SyncError("not_found", "账号不存在或没有归属");
      if (!inPlatformScope(actor, a.platformCode) || !inStaffScope(actor, a.staffId)) throw new SyncError("out_of_scope", "账号超出调用方范围");
      if (a.accountStatus === "deleted") {
        emit("account_confirm_deleted", { outcome: "noop", actorId: actor.actorId, detail: { account_id: i.accountId } });
        return { kind: "noop" as const, accountId: i.accountId };
      }
      const now = clock.now();
      await db.transaction(async (tx) => {
        await tx.update(externalAccounts).set({ status: "deleted", statusReason: "confirmed_deleted", statusChangedAt: now, updatedAt: now }).where(eq(externalAccounts.accountId, accountId));
        // 释放名额，归属记录保留（该专员可再录同平台账号）
        await tx.update(aa).set({ slotReleasedAt: now, updatedAt: now }).where(and(eq(aa.accountId, accountId), isNull(aa.slotReleasedAt)));
      });
      emit("account_confirm_deleted", { outcome: "applied", actorId: actor.actorId, detail: { account_id: i.accountId, previous_status: a.accountStatus } });
      return { kind: "deleted" as const, accountId: i.accountId, slotReleasedAt: now.toISOString() };
    });
  }

  // ── issue ──
  const issueStatusInput = z.strictObject({ issueId: decimalId, status: z.enum(["acknowledged", "ignored", "resolved"]), note: z.string().max(1000).optional() });
  async function setIssueStatus(raw: unknown, actor: ActorContext) {
    return guarded("issue_set_status", actor, async () => {
      const i = parse(issueStatusInput, raw);
      requireCap(actor, CAP_ACCOUNT_MANAGE);
      const issueId = BigInt(i.issueId);
      const [issue] = await db.select({ status: dataQualityIssues.status }).from(dataQualityIssues).where(eq(dataQualityIssues.issueId, issueId));
      if (!issue) throw new SyncError("not_found", "质量问题不存在");
      const now = clock.now();
      // 只改状态与处置记录；业务数据不动。acknowledged 只是「已看到」，不写处置时间
      await db
        .update(dataQualityIssues)
        .set({ status: i.status, resolvedByActor: actor.actorId.slice(0, 128), resolvedAt: i.status === "acknowledged" ? null : now, resolutionNote: i.note ?? null, updatedAt: now })
        .where(eq(dataQualityIssues.issueId, issueId));
      emit("issue_set_status", { outcome: "applied", actorId: actor.actorId, detail: { issue_id: i.issueId, from: issue.status, to: i.status } });
      return { issueId: i.issueId, from: issue.status, to: i.status };
    });
  }
  const issueListInput = z.strictObject({ status: z.enum(["open", "acknowledged", "ignored", "resolved"]).optional(), limit: z.number().int().min(1).max(200).default(50) });
  async function listIssues(raw: unknown = {}) {
    const i = parse(issueListInput, raw);
    const rows = await db
      .select({ issueId: dataQualityIssues.issueId, code: dataQualityIssues.issueCode, severity: dataQualityIssues.severity, status: dataQualityIssues.status, accountId: dataQualityIssues.accountId, batchId: dataQualityIssues.batchId, occurrences: dataQualityIssues.occurrenceCount, lastSeenAt: dataQualityIssues.lastSeenAt })
      .from(dataQualityIssues)
      .where(i.status ? eq(dataQualityIssues.status, i.status) : undefined)
      .orderBy(desc(dataQualityIssues.lastSeenAt), desc(dataQualityIssues.issueId))
      .limit(i.limit);
    return rows.map((r) => ({ ...r, issueId: r.issueId.toString(), accountId: r.accountId?.toString() ?? null, batchId: r.batchId?.toString() ?? null, lastSeenAt: r.lastSeenAt.toISOString() }));
  }

  // ── batch retry-failed ──
  const retryInput = z.strictObject({ batchId: decimalId, apply: z.boolean().default(false) });
  const RETRYABLE_BATCH = ["running", "succeeded", "partial_succeeded", "failed"] as const;
  async function retryFailed(raw: unknown, actor: ActorContext) {
    return guarded("batch_retry_failed", actor, async () => {
      const i = parse(retryInput, raw);
      requireCap(actor, CAP_SYNC_TRIGGER);
      requireFullScope(actor, "批次放回重试");
      const batchId = BigInt(i.batchId);
      /** 条件（FS-12.5）：全量批次、未取消 / 过期、是最新的 full 批次，且下一个 full 批次尚未开始。 */
      const check = async (q: Pick<typeof db, "select">) => {
        const [b] = await q.select().from(syncBatches).where(eq(syncBatches.batchId, batchId));
        if (!b) throw new SyncError("not_found", "批次不存在");
        if (b.purpose !== "full") throw new SyncError("not_retryable", "只有全量批次可以放回重试");
        if (!(RETRYABLE_BATCH as readonly string[]).includes(b.status)) throw new SyncError("not_retryable", `批次状态 ${b.status} 不可放回重试`);
        const [newer] = await q
          .select({ id: syncBatches.batchId })
          .from(syncBatches)
          .where(and(eq(syncBatches.purpose, "full"), gt(syncBatches.logicalAt, b.logicalAt), isNotNull(syncBatches.startedAt), ne(syncBatches.batchId, batchId)))
          .limit(1);
        if (newer) throw new SyncError("not_retryable", "下一个全量批次已经开始，本批次不再放回重试");
        return b;
      };
      const failedWhere = and(eq(syncTasks.batchId, batchId), inArray(syncTasks.status, ["failed", "dead"]));
      const b = await check(db);
      const rows = await db.select({ taskId: syncTasks.taskId, accountId: syncTasks.accountId, action: syncTasks.requestedAction, code: syncTasks.lastErrorCode }).from(syncTasks).where(failedWhere).orderBy(syncTasks.taskId);
      if (!i.apply) {
        emit("batch_retry_failed", { outcome: "previewed", actorId: actor.actorId, batchId: i.batchId, detail: { affected_tasks: rows.length } });
        return {
          kind: "preview" as const,
          batchId: i.batchId,
          status: b.status,
          affectedTasks: rows.length,
          examples: rows.slice(0, EXAMPLES).map((r) => ({ taskId: r.taskId.toString(), accountId: r.accountId?.toString() ?? null, action: r.action, lastErrorCode: r.code })),
          hint: "加 --apply 才会放回；成功的任务不会重做，尝试额度重置",
        };
      }
      const requeued = await db.transaction(async (tx) => {
        await loadSettings(tx, { lock: true }); // 与 tick 互斥
        await tx.select({ s: syncBatches.status }).from(syncBatches).where(eq(syncBatches.batchId, batchId)).for("update");
        const again = await check(tx as unknown as Db);
        const now = clock.now();
        const res = await tx
          .update(syncTasks)
          .set({
            status: "pending",
            attemptCount: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            stopReason: null,
            finishedAt: null,
            fencingToken: sql`${syncTasks.fencingToken} + 1`,
            updatedAt: now,
          })
          .where(failedWhere);
        // 批次已终态：回到 running，worker 才会领取；汇总在下一次 tick 重新计数
        if (res[0].affectedRows > 0 && again.status !== "running") {
          await tx.update(syncBatches).set({ status: "running", skipReason: null, finishedAt: null, mediaFinishedAt: null, updatedAt: now }).where(eq(syncBatches.batchId, batchId));
        }
        return res[0].affectedRows;
      });
      emit("batch_retry_failed", { outcome: requeued > 0 ? "applied" : "noop", actorId: actor.actorId, batchId: i.batchId, detail: { requeued_tasks: requeued } });
      return { kind: requeued > 0 ? ("requeued" as const) : ("noop" as const), batchId: i.batchId, requeuedTasks: requeued };
    });
  }

  // ── external add ──
  const externalAddInput = z.strictObject({ platform: z.string().min(1).max(64), locator: z.string().min(1).max(2048), key: z.string().min(1).max(200) });
  /**
   * 创建外部监控账号的入口根任务（复用 tracer 的解析流程：≤3 次、非主页入口拒绝、成对写入；无专员、无名额检查）。
   * 根任务由 tracer 流程执行（worker 不领取 resolve_account）；执行后账号才出现，之后只生成 fetch_profile。
   */
  async function externalAdd(raw: unknown, actor: ActorContext) {
    return guarded("external_add", actor, async () => {
      const i = parse(externalAddInput, raw);
      requireCap(actor, CAP_EXTERNAL_MANAGE);
      requirePlatformAdmin(actor, "外部监控账号");
      if (!inPlatformScope(actor, i.platform)) throw new SyncError("out_of_scope", "平台超出调用方范围");
      if (!deps.tracer) throw new SyncError("invalid_input", "外部账号入口未装配");
      try {
        const r = await deps.tracer.submitExternal({ platform: i.platform, homeLocator: i.locator, idempotencyKey: i.key, actorId: actor.actorId });
        emit("external_add", { outcome: "accepted", actorId: actor.actorId, detail: { root_task_id: r.rootTaskId, platform: i.platform, deduplicated: r.deduplicated, reused_active_task: r.reusedActiveTask } });
        return r;
      } catch (e) {
        if (!(e instanceof TracerError)) throw e;
        const code = e.code === "idempotency_conflict" ? "idempotency_conflict" : e.code === "unsupported_capability" ? "unsupported_capability" : e.code === "sync_settings_missing" ? "sync_settings_missing" : "invalid_input";
        throw new SyncError(code, e.message);
      }
    });
  }

  // ── external enable / disable / list ──
  const externalToggleInput = z.strictObject({ accountId: decimalId });
  async function setExternalEnabled(raw: unknown, actor: ActorContext, enabled: boolean) {
    const action = enabled ? "external_enable" : "external_disable";
    return guarded(action, actor, async () => {
      const i = parse(externalToggleInput, raw);
      requireCap(actor, CAP_EXTERNAL_MANAGE);
      requirePlatformAdmin(actor, "外部监控账号");
      const accountId = BigInt(i.accountId);
      const a = await loadAssignment(accountId);
      if (!a || a.watchType !== "external") throw new SyncError("not_found", "外部监控账号不存在");
      if (a.enabled === enabled) {
        emit(action, { outcome: "noop", actorId: actor.actorId, detail: { account_id: i.accountId } });
        return { kind: "noop" as const, accountId: i.accountId, enabled };
      }
      // 只改自身开关（FS-13.7）；关闭写 manual
      await db.update(aa).set({ monitoringEnabled: enabled, monitoringClosedReason: enabled ? null : "manual", updatedAt: clock.now() }).where(eq(aa.accountId, accountId));
      emit(action, { outcome: "applied", actorId: actor.actorId, detail: { account_id: i.accountId } });
      return { kind: "applied" as const, accountId: i.accountId, enabled };
    });
  }
  async function listExternal(actor: ActorContext) {
    requireCap(actor, CAP_EXTERNAL_MANAGE);
    requirePlatformAdmin(actor, "外部监控账号"); // 分公司 / 总部不可见（B-D22）
    const rows = await db
      .select({ accountId: aa.accountId, platform: platforms.platformCode, enabled: aa.monitoringEnabled, reason: aa.monitoringClosedReason, status: externalAccounts.status, locator: aa.currentHomeLocator })
      .from(aa)
      .innerJoin(platforms, eq(platforms.platformId, aa.platformId))
      .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
      .where(eq(aa.watchType, "external"))
      .orderBy(aa.accountId);
    return rows.map((r) => ({ ...r, accountId: r.accountId.toString() }));
  }

  return {
    rebind,
    confirmDeleted,
    setIssueStatus,
    listIssues,
    retryFailed,
    externalAdd,
    externalEnable: (raw: unknown, actor: ActorContext) => setExternalEnabled(raw, actor, true),
    externalDisable: (raw: unknown, actor: ActorContext) => setExternalEnabled(raw, actor, false),
    externalList: listExternal,
  };
}
export type SyncOps = ReturnType<typeof createSyncOps>;
