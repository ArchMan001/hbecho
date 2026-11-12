"use server";
// 活动计划页面的服务端动作：只做「会话 → PlanActor → Module 调用」的转接。
// 授权（Capability、品牌与分公司范围、创建者谓词）全部由 Module 判定；这里不写 SQL，不写角色条件。
// 影响多个对象的动作（删除计划、分公司退出、移出名单、替换负责人）先给预览，再由确认弹窗调用 apply 版本。
import { buildTemplate } from "../../modules/activity-plan/roster";
import type { StatusAction } from "../../modules/activity-plan";
import { PlanError } from "../../modules/activity-plan";
import { idOf, idsOf, run } from "../_lib/action";
import { ap, planActorOf } from "../_lib/plan";
import type { ActionResult } from "../_lib/result";

const MAX_BYTES = 10 * 1024 * 1024;
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const sectorKeys = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

// ── 计划 ──────────────────────────────────────────────────────────────────
export interface CreatePlanForm {
  brand: string;
  platform: string;
  sectors: string[];
  name: string;
  description: string;
  startsOn: string;
  endsOn: string;
}
export async function createPlan(form: CreatePlanForm): Promise<ActionResult<{ planId: string; required: string }>> {
  return run(async (ctx) => {
    const r = await ap().plans.create(await planActorOf(ctx), {
      brand: text(form?.brand) ?? "",
      platform: text(form?.platform) ?? "",
      sectors: sectorKeys(form?.sectors) ?? [],
      name: text(form?.name) ?? "",
      description: text(form?.description) ?? null,
      startsOn: text(form?.startsOn) ?? "",
      endsOn: text(form?.endsOn) || null,
    });
    return { planId: r.plan.planId, required: r.required.text };
  });
}

export interface EditPlanForm {
  name: string;
  description: string;
  startsOn: string;
  endsOn: string;
}
export async function editPlan(planId: string, form: EditPlanForm): Promise<ActionResult<{ changed: string[] }>> {
  return run(async (ctx) => {
    const r = await ap().plans.edit(await planActorOf(ctx), idOf(planId, "计划"), {
      name: text(form?.name) ?? "",
      description: text(form?.description) ?? null,
      startsOn: text(form?.startsOn) ?? "",
      endsOn: text(form?.endsOn) || null,
    });
    return { changed: r.changed };
  });
}

export async function setPlanStatus(planId: string, action: StatusAction): Promise<ActionResult<{ to: string }>> {
  return run(async (ctx) => {
    if (action !== "pause" && action !== "archive" && action !== "resume") throw new PlanError("input", "invalid_action", "不认识的操作");
    const r = await ap().plans.setStatus(await planActorOf(ctx), idOf(planId, "计划"), action);
    return { to: r.to };
  });
}

export interface DeletePreview {
  judgementPlans: number;
  results: number;
  running: number;
  inRoster: number;
  accountsToClose: number;
}
export async function previewDeletePlan(planId: string): Promise<ActionResult<DeletePreview>> {
  return run(async (ctx) => {
    const r = await ap().plans.remove(await planActorOf(ctx), idOf(planId, "计划"), { apply: false });
    if (r.kind !== "preview") throw new PlanError("conflict", "unexpected_result", "预览没有返回预览结果");
    return { ...r.downstream, ...r.roster };
  });
}
export async function deletePlan(planId: string): Promise<ActionResult<{ accountsClosed: number }>> {
  return run(async (ctx) => {
    const r = await ap().plans.remove(await planActorOf(ctx), idOf(planId, "计划"), { apply: true });
    if (r.kind !== "applied") throw new PlanError("conflict", "unexpected_result", "删除没有执行");
    return { accountsClosed: r.accountsClosed };
  });
}
export async function restorePlan(planId: string): Promise<ActionResult<{ accountsReopened: number }>> {
  return run(async (ctx) => ap().plans.restore(await planActorOf(ctx), idOf(planId, "计划")).then((r) => ({ accountsReopened: r.accountsReopened })));
}

// ── 参与分公司与负责人 ────────────────────────────────────────────────────
export async function joinPlan(planId: string, branchId: string): Promise<ActionResult<{ kind: string }>> {
  return run(async (ctx) => ap().participation.join(await planActorOf(ctx), idOf(planId, "计划"), idOf(branchId, "分公司")).then((r) => ({ kind: r.kind })));
}
export interface ExitPreview {
  rosterEntries: number;
  owners: string[];
  accountsToClose: number;
}
export async function previewExitBranch(planId: string, branchId: string): Promise<ActionResult<ExitPreview>> {
  return run(async (ctx) => {
    const r = await ap().participation.exit(await planActorOf(ctx), idOf(planId, "计划"), idOf(branchId, "分公司"), { apply: false });
    if (r.kind !== "preview") throw new PlanError("conflict", "unexpected_result", "预览没有返回预览结果");
    return { rosterEntries: r.rosterEntries, owners: r.owners, accountsToClose: r.accountsToClose };
  });
}
export async function exitBranch(planId: string, branchId: string): Promise<ActionResult<{ accountsClosed: number }>> {
  return run(async (ctx) => {
    const r = await ap().participation.exit(await planActorOf(ctx), idOf(planId, "计划"), idOf(branchId, "分公司"), { apply: true });
    if (r.kind !== "applied") throw new PlanError("conflict", "unexpected_result", "退出没有执行");
    return { accountsClosed: r.accountsClosed };
  });
}

export async function assignOwner(a: { planId: string; branchId: string; owner: string; displayName: string; slotNo: number; apply: boolean }): Promise<ActionResult<{ kind: string; before: string | null; after: string }>> {
  return run(async (ctx) => {
    const owner = text(a?.owner) ?? "";
    // 负责人只能是有效用户（user:<id>）；服务身份与随手写的字符串不能占名额
    if (!/^user:[1-9]\d{0,18}$/.test(owner)) throw new PlanError("input", "owner_invalid", "负责人必须从用户列表里选择");
    const r = await ap().owners.assign(await planActorOf(ctx), {
      planId: idOf(a.planId, "计划"),
      branchId: idOf(a.branchId, "分公司"),
      owner,
      displayName: (text(a.displayName) ?? owner).slice(0, 100),
      slotNo: a.slotNo,
      apply: a.apply === true,
    });
    return r.kind === "noop" ? { kind: "noop", before: null, after: owner } : { kind: r.kind, before: r.before, after: r.after };
  });
}

// ── 名单 ──────────────────────────────────────────────────────────────────
export interface RemovePreview {
  entries: number;
  accountsToClose: number;
}
export async function previewRemoveFromRoster(planId: string, accountIds: string[]): Promise<ActionResult<RemovePreview>> {
  return run(async (ctx) => {
    const r = await ap().roster.maintenance.remove(await planActorOf(ctx), { planId: idOf(planId, "计划"), accountIds: idsOf(accountIds, "账号"), apply: false });
    return r.kind === "preview" ? { entries: r.entries, accountsToClose: r.accountsToClose } : { entries: 0, accountsToClose: 0 };
  });
}
export async function removeFromRoster(planId: string, accountIds: string[]): Promise<ActionResult<{ entries: number; accountsClosed: number }>> {
  return run(async (ctx) => {
    const r = await ap().roster.maintenance.remove(await planActorOf(ctx), { planId: idOf(planId, "计划"), accountIds: idsOf(accountIds, "账号"), apply: true });
    return r.kind === "applied" ? { entries: r.entries, accountsClosed: r.accountsClosed } : { entries: 0, accountsClosed: 0 };
  });
}

// ── 名单导入 ──────────────────────────────────────────────────────────────
/** 模板：带 BOM 的 UTF-8、CRLF，表头 + 一行示例（系统会自动跳过）。 */
export async function rosterTemplate(): Promise<ActionResult<{ fileName: string; csv: string }>> {
  return run(async () => ({ fileName: "名单导入模板.csv", csv: buildTemplate() }));
}
export async function precheckRoster(form: FormData): Promise<ActionResult<{ batchId: string }>> {
  return run(async (ctx) => {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new PlanError("input", "file_missing", "请先选择要上传的 CSV 文件");
    if (file.size > MAX_BYTES) throw new PlanError("limit", "file_too_large", "文件超过 10 MB，请拆分后再上传", { bytes: file.size });
    const branch = form.get("branchId");
    const r = await ap().roster.precheck(
      { planId: idOf(form.get("planId"), "计划"), fileName: file.name.slice(0, 200), bytes: new Uint8Array(await file.arrayBuffer()), ...(typeof branch === "string" && branch !== "" ? { branchId: idOf(branch, "分公司") } : {}) },
      await planActorOf(ctx),
    );
    return { batchId: r.batchId };
  });
}
export async function confirmRoster(batchId: string): Promise<ActionResult<{ status: string; pending: number }>> {
  return run(async (ctx) => {
    const r = await ap().roster.confirm(String(idOf(batchId, "批次")), await planActorOf(ctx));
    return { status: r.status, pending: r.confirm.pending_account };
  });
}
/** 回流文件：只含 error / conflict / invalid / resolve_failed 的行；由浏览器保存，不落服务器磁盘。写审计。 */
export async function rosterReturnFile(batchId: string): Promise<ActionResult<{ fileName: string; csv: string; rows: number }>> {
  return run(async (ctx) => {
    const id = String(idOf(batchId, "批次"));
    const f = await ap().query.returnFile(await planActorOf(ctx), id);
    return { fileName: `名单回流-批次${id}.csv`, csv: f.content, rows: f.rows };
  });
}
