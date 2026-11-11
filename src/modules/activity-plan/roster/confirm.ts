// 名单确认写入（requirements AP-7、AP-8；design §7.5）：同步、有界、分块、可续跑；不在事务内做网络 IO 或文件解析。
//   前置检查（任一失败整条命令零写入）：批次可确认 → 计划仍采集中 → 平台 media_user_info capability 放行 → 名额检查与占用。
//   租约：writing_token 是 fencing token，每个块的事务开头 FOR UPDATE 核对；心跳陈旧（> 2 分钟）才允许接手。名额占用与取租约在同一事务里，
//     所以名额已满时批次状态不变、零写入。
//   续跑：只处理 outcome IS NULL 的行；行的 outcome 与它引起的专员 / 名单 / 根任务写入同一事务提交，所以已有 outcome 的行不会被改写。
//   每块：重分类（与预检不一致 → conflict/precheck_stale）→ 新建专员 → 入口本地命中的行直接归并（不调供应商）→ 其余行挂 resolve_account 根任务（pending_account）。
//   收尾：批次 resolving（仍有 pending_account）或 completed。
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { activityPlanOwners, activityPlanRoster, importBatches, importRowResults } from "../../../db/schema";
import type { MonitoringResolver } from "../../monitoring";
import { EVENTS, reconcileAccounts } from "../../plan-references";
import { annotateUpstream } from "./upstream";
import { UnsupportedCapabilityError, capabilityGate, classifyLocator, type Platform } from "../../provider-adapter";
import { normalizePhone } from "../../phone";
import { DEFAULT_CONFIG, type RosterSubmit, type TracerConfig } from "../../tracer-command";
import type { PlanAuditEvent } from "../audit";
import { CAP_PLAN_JOIN, branchInScope, type PlanActor } from "../authz";
import { recordChange } from "../changes";
import { CONFIRM_CHUNK, CONFIRM_TIME_LIMIT_MS, LEASE_STALE_MS, ROSTER_HEADER } from "../constants";
import { PlanError } from "../errors";
import { claimIfNeeded } from "../owners";
import { assertCollecting } from "../plans";
import { loadPlanFor, sectorsOf, type PlanRow } from "../visibility";
import { classifyRows, isPossiblyNew, type Classified, type RosterRow } from "./classify";
import type { RosterDeps } from "./precheck";
import { loadRosterRefs } from "./refs";
import { createStaff } from "./staff";

export interface ConfirmDeps extends RosterDeps {
  tracer: { submitRoster(tx: DbTx, input: RosterSubmit): Promise<{ tasks: Array<{ rowNo: number; rootTaskId: bigint; deduplicated: boolean }> }> };
  /** 用于 capability 门控（environment + 每个 action 的模式）；缺省与 tracer 一致。 */
  tracerConfig?: TracerConfig;
  chunkSize?: number;
  maxMs?: number;
  staleMs?: number;
  newToken?: () => string;
  /** 提示上级关闭（不改上级）；缺省不提示 */
  monitoring?: MonitoringResolver;
  /** 批次确认完成（status=completed）之后调用，任务 8 用它触发补抓。失败不影响已提交的结果。 */
  onCompleted?: (batchId: bigint) => Promise<unknown>;
  /** 仅测试：抛错即模拟进程在该点被杀。 */
  hooks?: {
    afterChunk?: (chunkNo: number) => void | Promise<void>;
    /** 分类之后、写入该行之前（用另一个连接制造唯一键竞争）。 */
    beforeApply?: (rowNo: number) => void | Promise<void>;
  };
}
export interface ConfirmCounts {
  imported: number;
  unchanged: number;
  conflict: number;
  invalid: number;
  suspected_empty: number;
  resolve_failed: number;
  pending_account: number;
  staff_created: number;
  owner_claimed: boolean;
}
export interface ConfirmResult {
  batchId: string;
  status: "resolving" | "completed";
  confirm: ConfirmCounts;
  /** 批次此前已经确认过（重复确认返回原结果，不重复写入）。 */
  alreadyConfirmed: boolean;
}
const WRITABLE = ["new", "new_staff", "update", "unchanged"] as const;

export async function confirm(deps: ConfirmDeps, batchIdText: string, actor: PlanActor): Promise<ConfirmResult> {
  if (!/^[1-9]\d*$/.test(batchIdText)) throw new PlanError("input", "invalid_batch_id", "批次 ID 必须是十进制数字");
  const batchId = BigInt(batchIdText);
  const { db, clock } = deps;
  const chunkSize = deps.chunkSize ?? CONFIRM_CHUNK;
  const maxMs = deps.maxMs ?? CONFIRM_TIME_LIMIT_MS;
  const staleMs = deps.staleMs ?? LEASE_STALE_MS;
  const tracerConfig = deps.tracerConfig ?? DEFAULT_CONFIG;
  const reject = (e: PlanError): never => {
    deps.audit({ event_type: "roster_confirmation_rejected", actor: actor.actor, occurred_at: clock.now().toISOString(), reason_code: e.code, batch_id: batchIdText });
    throw e;
  };

  // ── 前置检查（零写入）──
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.importBatchId, batchId));
  if (!batch || batch.importKind !== "roster" || batch.planId === null) throw new PlanError("not_found", "not_found", "未找到");
  // 范围外的批次表现为未找到；分公司人员只能处理本分公司的批次（不限上传人）
  if (actor.branchScope !== "all" && (batch.submitterBranchId === null || !branchInScope(actor, batch.submitterBranchId))) throw new PlanError("not_found", "not_found", "未找到");
  if (!actor.capabilities.has(CAP_PLAN_JOIN)) return reject(new PlanError("authorization", "forbidden", `缺少 Capability ${CAP_PLAN_JOIN}`));
  if (batch.status === "resolving" || batch.status === "completed") return existing(deps, batch);
  if (batch.status !== "awaiting_confirm" && batch.status !== "writing") return reject(new PlanError("conflict", "batch_not_confirmable", `批次状态 ${batch.status} 不能确认`));
  let plan: PlanRow;
  try {
    plan = await loadPlanFor(db, actor, CAP_PLAN_JOIN, batch.planId);
    assertCollecting(plan);
    if (batch.submitterBranchId !== null) await requireJoined(db, plan.planId, batch.submitterBranchId);
    try {
      capabilityGate.require({ platform: plan.platformCode as Platform, action: "media_user_info", mode: tracerConfig.modes.media_user_info, environment: tracerConfig.environment });
    } catch (e) {
      if (e instanceof UnsupportedCapabilityError) throw new PlanError("conflict", "unsupported_capability", e.message);
      throw e;
    }
  } catch (e) {
    return reject(e as PlanError);
  }

  // ── 取租约 + 名额（同一事务：名额已满时批次状态不变）──
  const token = (deps.newToken ?? randomUUID)();
  const t0 = clock.now();
  const claimEvents: PlanAuditEvent[] = [];
  let outcome: "acquired" | "confirmed";
  try {
    outcome = await db.transaction(async (tx) => {
      const [b] = await tx.select().from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
      if (!b) throw new PlanError("not_found", "not_found", "未找到");
      if (b.status === "resolving" || b.status === "completed") return "confirmed" as const;
      if (b.status === "writing" && b.heartbeatAt && t0.getTime() - b.heartbeatAt.getTime() < staleMs) {
        throw new PlanError("conflict", "batch_in_progress", "批次正在被另一个确认写入处理");
      }
      if (b.status !== "awaiting_confirm" && b.status !== "writing") throw new PlanError("conflict", "batch_not_confirmable", `批次状态 ${b.status} 不能确认`);
      if (b.submitterBranchId !== null) {
        const possiblyNew = (await tx.select({ cls: importRowResults.precheckClass, reason: importRowResults.reasonCode }).from(importRowResults).where(and(eq(importRowResults.importBatchId, batchId), inArray(importRowResults.precheckClass, ["new", "new_staff"])))).some((r) =>
          isPossiblyNew({ cls: r.cls as "new" | "new_staff", ...(r.reason ? { reason: r.reason } : {}) }),
        );
        const claim = await claimIfNeeded(tx, { planId: plan.planId, branchId: b.submitterBranchId, actor, possiblyNew, batchId, now: t0 });
        claimEvents.push(...claim.events);
      }
      await tx.update(importBatches).set({ status: "writing", writingToken: token, heartbeatAt: t0, updatedAt: t0 }).where(eq(importBatches.importBatchId, batchId));
      return "acquired" as const;
    });
  } catch (e) {
    return reject(e as PlanError);
  }
  claimEvents.forEach((e) => deps.audit(e));
  if (outcome === "confirmed") {
    const [b] = await db.select().from(importBatches).where(eq(importBatches.importBatchId, batchId));
    return existing(deps, b!);
  }

  // ── 分块写入 ──
  const started = clock.now().getTime();
  for (let chunkNo = 1; ; chunkNo++) {
    if (clock.now().getTime() - started > maxMs) {
      await db.update(importBatches).set({ heartbeatAt: null, updatedAt: clock.now() }).where(and(eq(importBatches.importBatchId, batchId), eq(importBatches.writingToken, token)));
      throw new PlanError("limit", "time_limit_exceeded", "确认写入超过时间上限，已在块边界停下；重新执行 confirm 即可续跑");
    }
    const events: PlanAuditEvent[] = [];
    const n = await processChunk(deps, batchId, token, plan.planId, actor, chunkSize, events);
    events.forEach((e) => deps.audit(e));
    if (n === 0) break;
    await deps.hooks?.afterChunk?.(chunkNo);
  }

  // ── 收尾：汇总、状态、完成——同一事务，租约失效则整体回滚 ──
  let result!: ConfirmResult;
  const finalEvent: PlanAuditEvent[] = [];
  await db.transaction(async (tx) => {
    const [b] = await tx.select().from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
    if (!b || b.writingToken !== token) throw new PlanError("conflict", "lease_lost", "写入租约已被其他进程接手");
    const now = clock.now();
    const confirmCounts = await countOutcomes(tx, batchId);
    const status = confirmCounts.pending_account > 0 ? "resolving" : "completed";
    const [errors] = await tx.select({ n: sql<string>`COUNT(*)` }).from(importRowResults).where(and(eq(importRowResults.importBatchId, batchId), eq(importRowResults.precheckClass, "error")));
    const prev = b.summary as Record<string, unknown>;
    await tx
      .update(importBatches)
      .set({
        status,
        summary: { ...prev, confirm: confirmCounts },
        newRows: confirmCounts.imported,
        skippedRows: confirmCounts.unchanged,
        errorRows: Number(errors?.n ?? 0),
        conflictRows: confirmCounts.conflict,
        writingToken: null,
        heartbeatAt: null,
        confirmedByActor: actor.actor,
        confirmedAt: now,
        updatedAt: now,
      })
      .where(eq(importBatches.importBatchId, batchId));
    await recordChange(tx, { planId: plan.planId, branchId: b.submitterBranchId, eventType: "roster_batch_confirmed", actor: actor.actor, now, detail: { batch_id: batchIdText, ...confirmCounts } });
    finalEvent.push({ event_type: "roster_batch_confirmed", actor: actor.actor, occurred_at: now.toISOString(), plan_id: plan.planId.toString(), target_type: "import_batch", target_id: batchIdText, batch_id: batchIdText, counts: { ...confirmCounts } });
    result = { batchId: batchIdText, status, confirm: confirmCounts, alreadyConfirmed: false };
  });
  finalEvent.forEach((e) => deps.audit(e));
  if (deps.monitoring) await annotateUpstream(db, deps.monitoring, batchId).catch(() => undefined);
  if (result.status === "completed") await deps.onCompleted?.(batchId).catch(() => undefined);
  return result;
}

async function requireJoined(db: Db, planId: bigint, branchId: bigint): Promise<void> {
  const rows = await db.execute(sql`SELECT status FROM activity_plan_branches WHERE plan_id = ${planId} AND branch_id = ${branchId}`);
  const status = (rows[0] as unknown as Array<{ status: string }>)[0]?.status;
  if (status !== "joined") throw new PlanError("conflict", "branch_not_joined", "你所在的分公司已不在这个计划里");
}

function existing(_deps: ConfirmDeps, batch: typeof importBatches.$inferSelect): ConfirmResult {
  const confirm = ((batch.summary as { confirm?: ConfirmCounts } | null)?.confirm ?? emptyCounts()) as ConfirmCounts;
  return { batchId: batch.importBatchId.toString(), status: batch.status as "resolving" | "completed", confirm, alreadyConfirmed: true };
}
const emptyCounts = (): ConfirmCounts => ({ imported: 0, unchanged: 0, conflict: 0, invalid: 0, suspected_empty: 0, resolve_failed: 0, pending_account: 0, staff_created: 0, owner_claimed: false });

/** 行结果聚合：汇总永远从行结果算出，不靠增量计数（崩溃续跑也一致）。 */
export async function countOutcomes(tx: Db | DbTx, batchId: bigint): Promise<ConfirmCounts> {
  const by = await tx.select({ outcome: importRowResults.outcome, n: sql<string>`COUNT(*)` }).from(importRowResults).where(eq(importRowResults.importBatchId, batchId)).groupBy(importRowResults.outcome);
  const c = (k: string): number => Number(by.find((x) => x.outcome === k)?.n ?? 0);
  const [staff] = await tx
    .select({ n: sql<string>`COUNT(*)` })
    .from(importRowResults)
    .where(and(eq(importRowResults.importBatchId, batchId), eq(importRowResults.precheckClass, "new_staff"), sql`${importRowResults.staffId} IS NOT NULL`));
  const [owner] = await tx.select({ n: sql<string>`COUNT(*)` }).from(activityPlanOwners).where(eq(activityPlanOwners.claimedBatchId, batchId));
  return {
    imported: c("imported"),
    unchanged: c("unchanged"),
    conflict: c("conflict"),
    invalid: c("invalid"),
    suspected_empty: c("suspected_empty"),
    resolve_failed: c("resolve_failed"),
    pending_account: c("pending_account"),
    staff_created: Number(staff?.n ?? 0),
    owner_claimed: Number(owner?.n ?? 0) > 0,
  };
}

async function processChunk(deps: ConfirmDeps, batchId: bigint, token: string, planId: bigint, actor: PlanActor, limit: number, events: PlanAuditEvent[]): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const [b] = await tx.select({ token: importBatches.writingToken }).from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
    if (!b || b.token !== token) throw new PlanError("conflict", "lease_lost", "写入租约已被其他进程接手");
    // 暂停 / 删除会等本块提交；下一块即看到并中止（批次停在 writing，恢复计划后可续跑）
    const plan = await loadPlanFor(tx, actor, CAP_PLAN_JOIN, planId, { lock: "share" });
    assertCollecting(plan);
    const rows = await tx
      .select()
      .from(importRowResults)
      .where(and(eq(importRowResults.importBatchId, batchId), isNull(importRowResults.outcome), inArray(importRowResults.precheckClass, [...WRITABLE])))
      .orderBy(asc(importRowResults.rowNo))
      .limit(limit);
    if (rows.length === 0) return 0;
    const now = deps.clock.now();
    const cellsOf = (raw: unknown): string[] => ROSTER_HEADER.map((h) => String((raw as Record<string, string>)[h] ?? ""));
    const rosterRows: RosterRow[] = rows.map((r) => ({ rowNo: r.rowNo, cells: cellsOf(r.rawRow) }));
    const keys = {
      storeCodes: rosterRows.map((r) => (r.cells[0] ?? "").trim()).filter(Boolean),
      phones: rosterRows.map((r) => normalizePhone(r.cells[2] ?? "")).filter((p): p is string => p !== null),
      locators: rosterRows.map((r) => (r.cells[3] ?? "").trim()).filter(Boolean).map((original) => ({ original, cleaned: classifyLocator(original).cleaned })),
    };
    const refs = await loadRosterRefs(tx, plan, keys);
    const fresh = classifyRows(rosterRows, { plan: { platform: plan.platformCode as Platform, sectors: new Set(await sectorsOf(tx, planId)) }, actor, refs });

    const touched = new Set<bigint>();
    const pending: Array<{ rowNo: number; staffId: bigint; locator: string; rowId: bigint; storeId: bigint | null; accountId: bigint | null; note: Classified }> = [];
    for (const [i, row] of rows.entries()) {
      const f = fresh[i]!;
      const rec = row.precheckClass!;
      const cells = rosterRows[i]!.cells;
      const done = (outcome: "imported" | "unchanged" | "conflict", x: { reason?: string; detail?: string; staffId?: bigint | null; accountId?: bigint | null } = {}) =>
        tx
          .update(importRowResults)
          .set({
            outcome,
            resolvedAt: now,
            resolvedByActor: actor.actor,
            ...(x.reason ? { reasonCode: x.reason } : {}),
            ...(x.detail ? { reasonDetail: x.detail.slice(0, 1024) } : {}),
            ...(x.staffId ? { staffId: x.staffId } : {}),
            ...(x.accountId ? { accountId: x.accountId } : {}),
          })
          .where(eq(importRowResults.importRowResultId, row.importRowResultId));
      const stale = (why: string) => done("conflict", { reason: "precheck_stale", detail: `预检为 ${rec}，确认时为 ${why}` });
      const nameNote = f.detail?.includes("staff_name_differs") ? { reason: "staff_name_differs", detail: f.detail } : {};

      if (f.cls === "error") {
        await stale(`error/${f.reason}`);
      } else if (rec === "unchanged") {
        if (f.cls === "unchanged") await done("unchanged", { reason: "already_in_roster", accountId: f.accountId ?? null });
        else await stale(`${f.cls}/${f.reason ?? ""}`);
      } else if (rec === "update" && f.cls === "unchanged") {
        await done("unchanged", { reason: "already_in_roster", accountId: f.accountId ?? null }); // 已收敛：别人先恢复了它
      } else if (rec === "new_staff" && f.cls === "new") {
        // 预检时专员不存在，确认时已被他人新建：不再新建第二名专员
        await done("conflict", { reason: "staff_phone_conflict", detail: "预检时专员不存在，确认时已被他人新建，请重新上传预检" });
      } else if (f.cls !== rec) {
        await stale(`${f.cls}/${f.reason ?? ""}`);
      } else if (rec === "update") {
        await deps.hooks?.beforeApply?.(row.rowNo);
        await tx
          .update(activityPlanRoster)
          .set({ entryState: "in_roster", removedAt: null, removedByActor: null, removedReason: null, branchId: f.branchId!, storeId: f.storeId!, staffId: f.staffId!, updatedAt: now })
          .where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.accountId, f.accountId!)));
        touched.add(f.accountId!);
        await done("unchanged", { reason: "restored_roster_entry", accountId: f.accountId!, staffId: f.staffId!, detail: f.detail ?? "" });
      } else if (f.reason === "known_account_other_owner") {
        // 入口命中的账号归属他人：直接记归属冲突，不调供应商，也不为这一行新建专员
        await done("conflict", { reason: "assignment_conflict", detail: f.detail ?? "" });
      } else {
        await deps.hooks?.beforeApply?.(row.rowNo);
        let staffId = f.staffId ?? null;
        if (rec === "new_staff") {
          const made = await createStaff(tx, { storeId: f.storeId!, name: cells[1]!.trim(), phone: normalizePhone(cells[2]!)!, now, actor: actor.actor, batchId });
          if (!made.ok) {
            await done("conflict", { reason: made.reason, detail: "新建专员时手机号已被另一位有效专员占用" });
            continue;
          }
          staffId = made.staffId;
          events.push(made.event);
          await tx.update(importRowResults).set({ staffId }).where(eq(importRowResults.importRowResultId, row.importRowResultId));
        }
        if (f.reason === "known_account_same_owner") {
          await upsertEntry(tx, { planId, platformId: plan.platformId, accountId: f.accountId!, branchId: f.branchId!, storeId: f.storeId!, staffId: staffId!, actor: actor.actor, batchId, now });
          touched.add(f.accountId!);
          await done("unchanged", { reason: "existing_account_referenced", accountId: f.accountId!, staffId });
        } else {
          pending.push({ rowNo: row.rowNo, staffId: staffId!, locator: cells[3]!.trim(), rowId: row.importRowResultId, storeId: f.storeId ?? null, accountId: null, note: f });
        }
      }
    }
    if (pending.length > 0) {
      const sub = await deps.tracer.submitRoster(tx, { importBatchId: batchId, actorId: actor.actor, platform: plan.platformCode, items: pending.map((p) => ({ rowNo: p.rowNo, staffId: p.staffId, locator: p.locator })) });
      const taskOf = new Map(sub.tasks.map((t) => [t.rowNo, t.rootTaskId]));
      for (const p of pending) {
        await tx
          .update(importRowResults)
          .set({ outcome: "pending_account", resolveTaskId: taskOf.get(p.rowNo)!, staffId: p.staffId, ...(p.note.detail?.includes("staff_name_differs") ? { reasonCode: "staff_name_differs", reasonDetail: p.note.detail.slice(0, 1024) } : {}) })
          .where(eq(importRowResults.importRowResultId, p.rowId));
      }
    }
    if (touched.size > 0) {
      const report = await reconcileAccounts(tx, [...touched], { ...EVENTS.imported, now, actor: actor.actor });
      events.push(...report.events);
    }
    await tx.update(importBatches).set({ heartbeatAt: now, updatedAt: now }).where(eq(importBatches.importBatchId, batchId));
    return rows.length;
  });
}

/** 名单项：已有则恢复（UQ(plan_id, account_id)，不新增第二行），没有则新建。 */
export async function upsertEntry(
  tx: DbTx,
  e: { planId: bigint; platformId: bigint; accountId: bigint; branchId: bigint; storeId: bigint; staffId: bigint; actor: string; batchId: bigint | null; now: Date },
): Promise<"inserted" | "restored" | "unchanged"> {
  const [cur] = await tx.select().from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, e.planId), eq(activityPlanRoster.accountId, e.accountId))).for("update");
  if (!cur) {
    await tx.insert(activityPlanRoster).values({
      planId: e.planId,
      platformId: e.platformId,
      accountId: e.accountId,
      branchId: e.branchId,
      storeId: e.storeId,
      staffId: e.staffId,
      entryState: "in_roster",
      addedAt: e.now,
      addedByActor: e.actor,
      addedBatchId: e.batchId,
      updatedAt: e.now,
    });
    return "inserted";
  }
  if (cur.entryState === "in_roster") return "unchanged";
  await tx
    .update(activityPlanRoster)
    .set({ entryState: "in_roster", removedAt: null, removedByActor: null, removedReason: null, branchId: e.branchId, storeId: e.storeId, staffId: e.staffId, updatedAt: e.now })
    .where(eq(activityPlanRoster.rosterEntryId, cur.rosterEntryId));
  return "restored";
}

