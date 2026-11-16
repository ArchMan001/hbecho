"use server";
// 判定计划页面的服务端动作：只做「会话 → AuthContext → Module 调用」的转接。
// 授权（Capability、品牌与分公司范围、「活动计划创建者」谓词）全部由 Module 判定；这里不写 SQL，不写角色条件。
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
