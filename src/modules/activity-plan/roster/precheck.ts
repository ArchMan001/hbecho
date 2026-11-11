// 名单预检（requirements AP-6；design §5.2）：计划与分公司前置检查 → 文件级校验 → 内存里分类全部行 → 将新建专员 ≤ 1,000 →
// 单次写入批次与行结果。只写 import_batches / import_row_results：不写专员、账号、归属、名单项、负责人，不调供应商。
// 文件级 / 前置检查 / 超限任一失败都不建批次。
import { and, count, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { activityPlanBranches, activityPlanRoster, importBatches, importRowResults } from "../../../db/schema";
import { classifyLocator, type Platform } from "../../provider-adapter";
import { normalizePhone } from "../../phone";
import type { Clock } from "../../raw-capture";
import type { PlanAuditSink } from "../audit";
import { assert, branchInScope, CAP_PLAN_JOIN, type PlanActor } from "../authz";
import { MAX_NEW_STAFF, ROSTER_HEADER, SOFT_CAP_ACCOUNTS, TEMPLATE_VERSION } from "../constants";
import { PlanError } from "../errors";
import { assertCollecting } from "../plans";
import { loadPlanFor, sectorsOf } from "../visibility";
import { classifyRows, isPossiblyNew, type Classified, type RosterRow } from "./classify";
import { loadRosterRefs } from "./refs";
import { parseRosterFile } from "./template";

export interface RosterDeps {
  db: Db;
  clock: Clock;
  audit: PlanAuditSink;
}
export interface PrecheckInput {
  planId: bigint;
  fileName: string;
  bytes: Uint8Array;
  /** 操作者属于多个分公司（或想显式指定）时给出本次提交的分公司。 */
  branchId?: bigint;
}
export interface PrecheckSummary {
  mode: "roster";
  plan_id: string;
  plan_name: string;
  platform: string;
  brand_code: string;
  template_version: string;
  precheck: {
    new: number;
    new_staff: number;
    update: number;
    unchanged: number;
    error: number;
    possible_new_accounts: number;
    plan_entries_now: number;
    plan_entries_after: number;
    soft_cap_exceeded: boolean;
    example_rows: number[];
  };
  confirm: Record<string, never>;
}
export interface PrecheckAccepted {
  batchId: string;
  status: "awaiting_confirm";
  totalRows: number;
  summary: PrecheckSummary;
}

/** 本次提交的分公司：单一分公司范围即该分公司；范围 all 可不指定；多个必须指定。 */
export function resolveSubmitterBranch(actor: PlanActor, requested?: bigint): bigint | null {
  if (requested !== undefined) {
    if (!branchInScope(actor, requested)) throw new PlanError("authorization", "branch_out_of_scope", "分公司不在你的授权范围内");
    return requested;
  }
  if (actor.branchScope === "all") return null;
  const only = [...actor.branchScope];
  if (only.length === 1) return only[0]!;
  if (only.length === 0) throw new PlanError("authorization", "branch_out_of_scope", "你没有任何分公司范围");
  throw new PlanError("input", "branch_required", "你属于多个分公司，请指定本次提交的分公司");
}

export async function precheck(deps: RosterDeps, input: PrecheckInput, actor: PlanActor): Promise<PrecheckAccepted> {
  const { db, clock, audit } = deps;
  const now = clock.now();
  assert(actor, CAP_PLAN_JOIN); // Capability 与来自 actor 的分公司范围先于任何数据库读取
  const submitterBranchId = resolveSubmitterBranch(actor, input.branchId);
  const plan = await loadPlanFor(db, actor, CAP_PLAN_JOIN, input.planId);
  assertCollecting(plan);
  if (submitterBranchId !== null) {
    const [p] = await db.select().from(activityPlanBranches).where(and(eq(activityPlanBranches.planId, plan.planId), eq(activityPlanBranches.branchId, submitterBranchId)));
    if (p?.status !== "joined") throw new PlanError("conflict", "branch_not_joined", "你所在的分公司还没有加入这个计划，请先加入");
  }
  const parsed = parseRosterFile(input.bytes); // 文件级失败：不建批次
  const sectors = new Set(await sectorsOf(db, plan.planId));
  const rows: RosterRow[] = parsed.rows.map((r) => ({ rowNo: r.rowNo, cells: r.cells }));
  const keys = {
    storeCodes: rows.map((r) => (r.cells[0] ?? "").trim()).filter(Boolean),
    phones: rows.map((r) => normalizePhone(r.cells[2] ?? "")).filter((p): p is string => p !== null),
    locators: rows.map((r) => (r.cells[3] ?? "").trim()).filter(Boolean).map((original) => ({ original, cleaned: classifyLocator(original).cleaned })),
  };
  const refs = await loadRosterRefs(db, plan, keys);
  const results: Classified[] = classifyRows(rows, { plan: { platform: plan.platformCode as Platform, sectors }, actor, refs });
  const count_ = (k: Classified["cls"]) => results.filter((c) => c.cls === k).length;
  const newStaff = count_("new_staff");
  if (newStaff > MAX_NEW_STAFF) {
    throw new PlanError("limit", "too_many_new_staff", `一次最多新建 ${MAX_NEW_STAFF} 位专员，本文件需要新建 ${newStaff} 位，请拆分文件`, { new_staff: newStaff, limit: MAX_NEW_STAFF });
  }
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, plan.planId), eq(activityPlanRoster.entryState, "in_roster")));
  const entriesNow = Number(n);
  const entriesAfter = entriesNow + count_("new") + newStaff + count_("update");
  const summary: PrecheckSummary = {
    mode: "roster",
    plan_id: plan.planId.toString(),
    plan_name: plan.planName,
    platform: plan.platformCode,
    brand_code: plan.brandCode,
    template_version: TEMPLATE_VERSION,
    precheck: {
      new: count_("new"),
      new_staff: newStaff,
      update: count_("update"),
      unchanged: count_("unchanged"),
      error: count_("error"),
      possible_new_accounts: results.filter(isPossiblyNew).length,
      plan_entries_now: entriesNow,
      plan_entries_after: entriesAfter,
      soft_cap_exceeded: entriesAfter > SOFT_CAP_ACCOUNTS,
      example_rows: parsed.exampleRowNos,
    },
    confirm: {},
  };
  const [ins] = await db.insert(importBatches).values({
    importKind: "roster",
    planId: plan.planId,
    submitterBranchId,
    uploadedByActor: actor.actor,
    uploadedAt: now,
    fileName: input.fileName.slice(0, 512),
    fileSha256: parsed.sha256,
    templateVersion: TEMPLATE_VERSION,
    brandScope: [plan.brandCode],
    totalRows: rows.length,
    summary,
    status: "prechecking",
    createdAt: now,
    updatedAt: now,
  });
  const batchId = BigInt(ins.insertId);
  try {
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(importRowResults).values(
        rows.slice(i, i + 500).map((r, j) => {
          const c = results[i + j]!;
          return {
            importBatchId: batchId,
            rowNo: r.rowNo,
            rawRow: Object.fromEntries(ROSTER_HEADER.map((h, k) => [h, r.cells[k] ?? ""])),
            precheckClass: c.cls,
            reasonCode: c.reason ?? null,
            reasonDetail: c.detail?.slice(0, 1024) ?? null,
            storeId: c.storeId ?? null,
            staffId: c.staffId ?? null,
            accountId: c.accountId ?? null,
            createdAt: now,
          };
        }),
      );
    }
    await db.update(importBatches).set({ status: "awaiting_confirm", updatedAt: clock.now() }).where(eq(importBatches.importBatchId, batchId));
  } catch (e) {
    // 已写的行结果保留；批次标记 precheck_failed，重传同一文件得到新批次
    await db.update(importBatches).set({ status: "precheck_failed", updatedAt: clock.now() }).where(eq(importBatches.importBatchId, batchId)).catch(() => undefined);
    throw e;
  }
  audit({
    event_type: "roster_precheck_completed",
    actor: actor.actor,
    occurred_at: now.toISOString(),
    plan_id: plan.planId.toString(),
    target_type: "import_batch",
    target_id: batchId.toString(),
    batch_id: batchId.toString(),
    counts: { total: rows.length, ...summary.precheck, example_rows: summary.precheck.example_rows.length },
  });
  return { batchId: batchId.toString(), status: "awaiting_confirm", totalRows: rows.length, summary };
}
