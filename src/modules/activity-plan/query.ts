// 只读查询（requirements AP-13）。全部按操作者范围过滤，越范围对象表现为稳定的「未找到」（不返回空列表冒充成功）；
// 查询不触发任何业务写入（回流文件 / 预检报告的下载只写审计）。所有 BIGINT 以十进制字符串输出，手机号明文（D-42）。
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  activityPlanBranches,
  activityPlanChanges,
  activityPlanOwners,
  activityPlanRoster,
  activityPlans,
  branches,
  importBatches,
  importRowResults,
  mediaStaff,
  staffAccountAssignments as aa,
  stores,
} from "../../db/schema";
import type { MonitoringResolver } from "../monitoring";
import type { Clock } from "../raw-capture";
import type { PlanAuditSink } from "./audit";
import { assert, brandInScope, branchInScope, CAP_PLAN_CREATE, CAP_PLAN_JOIN, type PlanActor } from "./authz";
import { PlanError } from "./errors";
import { buildRosterReturnFile, type ReturnRow } from "./roster/return-file";
import { composeStatus, type CompositeStatus } from "./status";
import { getVisiblePlan, requiredJudgementPlans, sectorsOf, visiblePlans, type PlanRow } from "./visibility";

const MAX_PAGE = 500;
const page = (p: { offset?: number; limit?: number } = {}): { offset: number; limit: number } => ({ offset: Math.max(0, p.offset ?? 0), limit: Math.min(MAX_PAGE, Math.max(1, p.limit ?? 100)) });
const notFound = (): never => {
  throw new PlanError("not_found", "not_found", "未找到");
};
/** 任一计划 Capability 即可查询；范围由各查询自己过滤。 */
function assertCanQuery(actor: PlanActor): void {
  if (!actor.capabilities.has(CAP_PLAN_CREATE)) assert(actor, CAP_PLAN_JOIN);
}

export function createPlanQuery(deps: { db: Db; clock: Clock; resolver: MonitoringResolver; audit: PlanAuditSink }) {
  const { db, resolver, audit, clock } = deps;

  const planItem = (p: PlanRow) => ({
    planId: p.planId.toString(),
    name: p.planName,
    brand: p.brandCode,
    platform: p.platformCode,
    status: p.status,
    startsOn: p.startsOn,
    endsOn: p.endsOn,
    createdBy: p.createdByActor,
  });

  async function listPlans(actor: PlanActor, f: { status?: string; platform?: string; brand?: string } = {}): Promise<Array<ReturnType<typeof planItem>>> {
    assertCanQuery(actor);
    return (await visiblePlans(db, actor)).filter((p) => (!f.status || p.status === f.status) && (!f.platform || p.platformCode === f.platform) && (!f.brand || p.brandCode === f.brand)).map(planItem);
  }

  /** 计划详情：基本信息、规模计数（只计数、不做比率）、参与分公司与负责人槽位、需要的监控判定计划、变更记录。 */
  async function planDetail(actor: PlanActor, planId: bigint) {
    assertCanQuery(actor);
    const plan = (await getVisiblePlan(db, actor, planId)) ?? notFound();
    const sectors = await sectorsOf(db, planId);
    const cnt = async (state: "in_roster" | "removed") => Number((await db.select({ n: count() }).from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.entryState, state), ...scopeCond(actor))))[0]?.n ?? 0);
    const [pending] = await db
      .select({ n: count() })
      .from(importRowResults)
      .innerJoin(importBatches, eq(importBatches.importBatchId, importRowResults.importBatchId))
      .where(and(eq(importBatches.planId, planId), inArray(importRowResults.outcome, ["pending_account", "suspected_empty"]), ...(actor.branchScope === "all" ? [] : [actor.branchScope.size === 0 ? sql`1=0` : inArray(importBatches.submitterBranchId, [...actor.branchScope])])));
    const parts = await db
      .select({ branchId: activityPlanBranches.branchId, branchCode: branches.branchCode, branchName: branches.branchName, status: activityPlanBranches.status })
      .from(activityPlanBranches)
      .innerJoin(branches, eq(branches.branchId, activityPlanBranches.branchId))
      .where(eq(activityPlanBranches.planId, planId))
      .orderBy(asc(branches.branchCode));
    const visibleParts = parts.filter((p) => branchInScope(actor, p.branchId) || actor.branchScope === "all");
    const owners = await db.select().from(activityPlanOwners).where(eq(activityPlanOwners.planId, planId)).orderBy(asc(activityPlanOwners.branchId), asc(activityPlanOwners.slotNo));
    const changes = await db.select().from(activityPlanChanges).where(eq(activityPlanChanges.planId, planId)).orderBy(desc(activityPlanChanges.occurredAt), desc(activityPlanChanges.changeId)).limit(200);
    return {
      ...planItem(plan),
      description: plan.description,
      sectors,
      required: requiredJudgementPlans(sectors),
      counts: { accounts: await cnt("in_roster"), removed: await cnt("removed"), branches: visibleParts.filter((p) => p.status === "joined").length, sectors: sectors.length, pending: Number(pending?.n ?? 0) },
      branches: visibleParts.map((p) => ({
        branchId: p.branchId.toString(),
        code: p.branchCode,
        name: p.branchName,
        status: p.status,
        owners: owners.filter((o) => o.branchId === p.branchId).map((o) => ({ slotNo: o.slotNo, owner: o.ownerActor, displayName: o.ownerDisplayName })),
      })),
      // 分公司人员只看到与自己分公司相关的条目；计划级条目（branch_id 为空）只给总部 / 超管
      changes: changes
        .filter((c) => actor.branchScope === "all" || (c.branchId !== null && branchInScope(actor, c.branchId)))
        .map((c) => ({ at: c.occurredAt.toISOString(), event: c.eventType, actor: c.actor, branchId: c.branchId?.toString() ?? null, detail: c.detail })),
    };
  }
  const scopeCond = (actor: PlanActor) => (actor.branchScope === "all" ? [] : [actor.branchScope.size === 0 ? sql`1=0` : inArray(activityPlanRoster.branchId, [...actor.branchScope])]);

  /** 名单：按门店 · 专员 · 账号，含综合状态；分公司只看自己报的那部分（按加入时的分公司快照）。 */
  async function roster(actor: PlanActor, planId: bigint, o: { offset?: number; limit?: number; state?: "in_roster" | "removed" } = {}) {
    assertCanQuery(actor);
    (await getVisiblePlan(db, actor, planId)) ?? notFound();
    const { offset, limit } = page(o);
    const where = and(eq(activityPlanRoster.planId, planId), ...(o.state ? [eq(activityPlanRoster.entryState, o.state)] : []), ...scopeCond(actor));
    const [total] = await db.select({ n: count() }).from(activityPlanRoster).where(where);
    const rows = await db
      .select({
        accountId: activityPlanRoster.accountId,
        entryState: activityPlanRoster.entryState,
        branchId: activityPlanRoster.branchId,
        storeCode: stores.storeCode,
        storeName: stores.storeName,
        staffId: activityPlanRoster.staffId,
        staffName: mediaStaff.staffName,
        phone: mediaStaff.phone,
        intake: aa.intakeStatus,
        enabled: aa.monitoringEnabled,
        closedReason: aa.monitoringClosedReason,
        locator: aa.currentHomeLocator,
        addedAt: activityPlanRoster.addedAt,
        removedReason: activityPlanRoster.removedReason,
      })
      .from(activityPlanRoster)
      .innerJoin(stores, eq(stores.storeId, activityPlanRoster.storeId))
      .innerJoin(mediaStaff, eq(mediaStaff.staffId, activityPlanRoster.staffId))
      .leftJoin(aa, eq(aa.accountId, activityPlanRoster.accountId))
      .where(where)
      .orderBy(asc(stores.storeCode), asc(mediaStaff.staffId), asc(activityPlanRoster.accountId))
      .limit(limit)
      .offset(offset);
    const items = [];
    for (const r of rows) {
      const ex = await resolver.explain(r.accountId);
      const status: CompositeStatus = composeStatus({ intakeStatus: r.intake ?? "normal", exclusion: ex.reason, assignmentEnabled: r.enabled ?? false, closedReason: r.closedReason, entryState: r.entryState as "in_roster" | "removed" });
      items.push({
        accountId: r.accountId.toString(),
        entryState: r.entryState,
        store: { code: r.storeCode, name: r.storeName },
        staff: { id: r.staffId.toString(), name: r.staffName, phone: r.phone },
        branchId: r.branchId.toString(),
        homeLocator: r.locator,
        addedAt: r.addedAt.toISOString(),
        removedReason: r.removedReason,
        status,
      });
    }
    return { total: Number(total?.n ?? 0), offset, limit, items };
  }

  // ── 批次 ─────────────────────────────────────────────────────────
  type BatchRow = typeof importBatches.$inferSelect;
  function brandOf(b: BatchRow): string | null {
    return (b.summary as { brand_code?: string } | null)?.brand_code ?? null;
  }
  /** 批次可见：品牌在范围内（计划被清除后用 summary 里的品牌快照）∧（分公司范围 all ∨ 本分公司提交的）。 */
  function batchVisible(actor: PlanActor, b: BatchRow): boolean {
    if (b.importKind !== "roster") return false;
    const brand = brandOf(b);
    if (brand === null || !brandInScope(actor, brand)) return false;
    return actor.branchScope === "all" || (b.submitterBranchId !== null && branchInScope(actor, b.submitterBranchId));
  }
  /** 总部（分公司范围 all 且非超管）只给汇总，不给逐行明细（F §字段可见性）。 */
  const canSeeRows = (actor: PlanActor): boolean => actor.platformAdmin || actor.branchScope !== "all";
  const batchItem = (b: BatchRow) => {
    const s = (b.summary ?? {}) as Record<string, unknown>;
    return {
      batchId: b.importBatchId.toString(),
      planId: b.planId?.toString() ?? null,
      planName: (s.plan_name as string | undefined) ?? null,
      platform: (s.platform as string | undefined) ?? null,
      brand: brandOf(b),
      fileName: b.fileName,
      uploadedBy: b.uploadedByActor,
      uploadedAt: b.uploadedAt.toISOString(),
      submitterBranchId: b.submitterBranchId?.toString() ?? null,
      status: b.status,
      totalRows: b.totalRows,
      precheck: s.precheck ?? null,
      confirm: s.confirm ?? null,
      refresh: s.refresh ?? null,
    };
  };

  async function batches(actor: PlanActor, o: { planId?: bigint; offset?: number; limit?: number } = {}) {
    assertCanQuery(actor);
    const { offset, limit } = page(o);
    const all = await db
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.importKind, "roster"), ...(o.planId === undefined ? [] : [eq(importBatches.planId, o.planId)])))
      .orderBy(desc(importBatches.importBatchId));
    return all.filter((b) => batchVisible(actor, b)).slice(offset, offset + limit).map(batchItem);
  }
  async function loadBatch(actor: PlanActor, batchIdText: string): Promise<BatchRow> {
    assertCanQuery(actor);
    if (!/^[1-9]\d*$/.test(batchIdText)) throw new PlanError("input", "invalid_batch_id", "批次 ID 必须是十进制数字");
    const [b] = await db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(batchIdText)));
    return b && batchVisible(actor, b) ? b : notFound();
  }
  async function batch(actor: PlanActor, batchIdText: string) {
    return { ...batchItem(await loadBatch(actor, batchIdText)), rowsVisible: canSeeRows(actor) };
  }
  async function rows(actor: PlanActor, batchIdText: string, o: { offset?: number; limit?: number; precheckClass?: string; outcome?: string } = {}) {
    const b = await loadBatch(actor, batchIdText);
    if (!canSeeRows(actor)) throw new PlanError("authorization", "rows_not_visible", "总部只能查看批次汇总，不能查看逐行明细");
    const { offset, limit } = page(o);
    const where = and(eq(importRowResults.importBatchId, b.importBatchId), ...(o.precheckClass ? [eq(importRowResults.precheckClass, o.precheckClass)] : []), ...(o.outcome ? [eq(importRowResults.outcome, o.outcome)] : []));
    const [total] = await db.select({ n: count() }).from(importRowResults).where(where);
    const list = await db.select().from(importRowResults).where(where).orderBy(asc(importRowResults.rowNo)).limit(limit).offset(offset);
    return {
      total: Number(total?.n ?? 0),
      offset,
      limit,
      items: list.map((r) => ({
        rowNo: r.rowNo,
        raw: r.rawRow,
        precheckClass: r.precheckClass,
        outcome: r.outcome,
        reasonCode: r.reasonCode,
        reasonDetail: r.reasonDetail,
        storeId: r.storeId?.toString() ?? null,
        staffId: r.staffId?.toString() ?? null,
        accountId: r.accountId?.toString() ?? null,
        status: composeStatus({ rowOutcome: r.outcome, intakeStatus: r.outcome === "suspected_empty" ? "suspected_empty" : "normal", exclusion: null, assignmentEnabled: true, closedReason: null, entryState: null }),
      })),
    };
  }
  /** 回流文件：随 activity_plan.join，不额外要求 data.export，仍做范围复查并写审计（F-D16）。 */
  async function returnFile(actor: PlanActor, batchIdText: string): Promise<{ content: string; rows: number }> {
    const b = await loadBatch(actor, batchIdText);
    if (!canSeeRows(actor)) throw new PlanError("authorization", "rows_not_visible", "总部只能查看批次汇总，不能下载逐行回流文件");
    const list = await db.select().from(importRowResults).where(eq(importRowResults.importBatchId, b.importBatchId)).orderBy(asc(importRowResults.rowNo));
    const f = buildRosterReturnFile(list.map((r): ReturnRow => ({ raw: r.rawRow as Record<string, string>, precheckClass: r.precheckClass, outcome: r.outcome, reasonCode: r.reasonCode, reasonDetail: r.reasonDetail })));
    audit({ event_type: "roster_report_downloaded", actor: actor.actor, occurred_at: clock.now().toISOString(), target_type: "import_batch", target_id: b.importBatchId.toString(), batch_id: b.importBatchId.toString(), counts: { rows: f.rows } });
    return f;
  }
  return { listPlans, planDetail, roster, batches, batch, rows, returnFile };
}
export type PlanQuery = ReturnType<typeof createPlanQuery>;
