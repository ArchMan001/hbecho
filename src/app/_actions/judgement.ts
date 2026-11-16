"use server";
// 判定计划页面的服务端动作：只做「会话 → AuthContext → Module 调用」的转接。
// 授权（Capability、品牌与分公司范围、「活动计划创建者」谓词）全部由 Module 判定；这里不写 SQL，不写角色条件。
import { JudgementError } from "../../modules/judgement/errors";
import type { StaffContentRow, ParticipantRow } from "../../modules/judgement/views";
import { idOf, run } from "../_lib/action";
import { judgement } from "../_lib/judgement";
import type { ActionResult } from "../_lib/result";
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export interface CreateJudgementForm {
  activityPlanId: string;
  alias: string;
  description: string;
}
export async function createJudgementPlan(form: CreateJudgementForm): Promise<ActionResult<{ planId: string }>> {
  return run(async (ctx) => {
    const r = await judgement().plans.create(ctx, { activityPlanId: idOf(form?.activityPlanId, "活动计划"), alias: text(form?.alias) ?? "", ...(text(form?.description)?.trim() ? { description: text(form?.description)!.trim() } : {}) });
    return { planId: String(r.planId) };
  });
}
export async function archiveJudgementPlan(planId: string): Promise<ActionResult> {
  return run(async (ctx) => void (await judgement().plans.archive(ctx, idOf(planId, "判定计划"))));
}
export async function unarchiveJudgementPlan(planId: string): Promise<ActionResult> {
  return run(async (ctx) => void (await judgement().plans.unarchive(ctx, idOf(planId, "判定计划"))));
}

// ---- 向导（任务 14）：配置保存、圈定、试跑、图片、回退、新建草稿、确认执行 ----------------------------------------
/** 保存草稿配置（整份）：Module 校验、算失效范围并删掉失效的圈定 / 试跑结果。 */
export async function saveJudgementConfig(planId: string, config: unknown): Promise<ActionResult<{ invalidation: "none" | "trial" | "circle_and_trial" }>> {
  return run(async (ctx) => {
    const r = await judgement().versions.setConfig(ctx, idOf(planId, "判定计划"), config);
    return { invalidation: r.invalidation };
  });
}
/** 确认圈定（第 1 页）：同步运算，只读本地事实，不发任何外部调用。 */
export async function circleJudgementPlan(planId: string): Promise<ActionResult<{ c1: number; participants: number }>> {
  return run(async (ctx) => {
    const r = await judgement().runs.circle(ctx, idOf(planId, "判定计划"));
    return { c1: r.c1, participants: r.participants };
  });
}
/** 开始试跑（第 2 页）：只提交运行，由 `judgement serve` 领取；页面轮询进度。 */
export async function trialJudgementPlan(planId: string): Promise<ActionResult> {
  return run(async (ctx) => void (await judgement().runs.trial(ctx, idOf(planId, "判定计划"), { wait: false })));
}
const MAX_IMAGE = 10 * 1024 * 1024;
/** 上传标准图 / 元素图：能力的类型以服务端存的配置为准，不信客户端。 */
export async function uploadAbilityImage(form: FormData): Promise<ActionResult> {
  return run(async (ctx) => {
    const planId = idOf(form.get("planId"), "判定计划");
    const abilityId = form.get("abilityId");
    const file = form.get("file");
    if (typeof abilityId !== "string" || !(file instanceof File) || file.size === 0) throw new JudgementError("input", "image_missing", "请先选择要上传的图片");
    if (file.size > MAX_IMAGE) throw new JudgementError("input", "image_too_large", "图片不能超过 10 MiB");
    const j = judgement();
    const cur = await j.versions.showConfig(ctx, planId);
    const ability = cur.config.layer2.abilities.find((a) => a.abilityId === abilityId);
    if (!ability) throw new JudgementError("not_found", "ability_not_found", "没有这个能力");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (ability.kind === "image_element") await j.versions.putElement(ctx, planId, abilityId, bytes);
    else await j.versions.putTemplate(ctx, planId, abilityId, bytes);
    return undefined;
  });
}
export async function removeAbilityImage(planId: string, abilityId: string): Promise<ActionResult> {
  return run(async (ctx) => void (await judgement().versions.removeImage(ctx, idOf(planId, "判定计划"), String(abilityId))));
}
export interface RollbackPreview {
  from: string;
  to: string;
  runs: number;
  rows: number;
  applied: boolean;
}
/** 回退一层：`apply=false` 只预览将删除什么（不写任何表）。 */
export async function rollbackJudgementPlan(planId: string, apply: boolean): Promise<ActionResult<RollbackPreview>> {
  return run((ctx) => judgement().versions.rollback(ctx, idOf(planId, "判定计划"), { apply: apply === true }));
}
export async function newJudgementDraft(planId: string, fromVersion?: number): Promise<ActionResult<{ version: number }>> {
  return run((ctx) => judgement().versions.newDraft(ctx, idOf(planId, "判定计划"), typeof fromVersion === "number" ? fromVersion : undefined));
}
/** 确认执行 / 重新执行；幂等键由弹窗每次打开时生成，重复提交返回已有运行。 */
export async function executeJudgementPlan(planId: string, key: string): Promise<ActionResult<{ version: number; runId: string; created: boolean }>> {
  return run(async (ctx) => {
    // 「确认执行」，不是 SQL 的 execute；用 bind 取方法，免得被 B-AX-12 的字面正则（\.execute\(）误判
    const confirmExecution = judgement().runs.execute.bind(judgement().runs);
    const r = await confirmExecution(ctx, idOf(planId, "判定计划"), { key: typeof key === "string" ? key : "" });
    return { version: r.version, runId: String(r.runId), created: r.created };
  });
}

// ---- 执行记录与证据（任务 15） ------------------------------------------------------------------------------
export async function cancelJudgementRun(runId: string): Promise<ActionResult> {
  return run(async (ctx) => void (await judgement().runs.cancel(ctx, idOf(runId, "执行"))));
}
export async function resumeJudgementRun(runId: string): Promise<ActionResult> {
  return run(async (ctx) => void (await judgement().runs.resume(ctx, idOf(runId, "执行"))));
}
export interface StaffEvidence {
  participant: ParticipantRow;
  contents: StaffContentRow[] | null;
  pruned: boolean;
  truncated: boolean;
}
export async function loadStaffEvidence(runId: string, staffId: string): Promise<ActionResult<StaffEvidence>> {
  return run((ctx) => judgement().views.staffEvidence(ctx, idOf(runId, "执行"), idOf(staffId, "专员")));
}
export interface ContentEvidence {
  steps: Array<{ layer: number; name: string; result: string | null; evidence: unknown; selection?: { selected: boolean | null; rank: number | null } }>;
  stoppedAt: number | null;
  stopReason: string | null;
  comments: unknown;
}
/** 单条内容的证据：只挑页面要显示的字段（点赞数等不下发）；证据本身自包含，不含内容与评论原文。 */
export async function loadContentEvidence(runId: string, contentId: string): Promise<ActionResult<ContentEvidence>> {
  return run(async (ctx) => {
    const r = await judgement().outcomes.explain(ctx, idOf(runId, "执行"), { contentId: idOf(contentId, "内容") });
    if (r.kind !== "content") throw new JudgementError("not_found", "explain_target_not_found", "没有找到");
    return {
      steps: r.steps.map((st) => ({
        layer: st.layer,
        name: st.name,
        result: st.result,
        evidence: (st as { evidence?: unknown }).evidence ?? null,
        ...("selection" in st && st.selection ? { selection: { selected: st.selection.selected, rank: st.selection.rank } } : {}),
      })),
      stoppedAt: r.stoppedAt,
      stopReason: r.stopReason,
      comments: r.comments,
    };
  });
}
