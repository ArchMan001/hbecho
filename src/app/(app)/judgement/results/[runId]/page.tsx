import { notFound, redirect } from "next/navigation";
import { DeniedState, ErrorState } from "../../../../_components/ui";
import { judgement, parsePlanId } from "../../../../_lib/judgement";
import { requireUser } from "../../../../_lib/session";
import { JudgementError } from "../../../../../modules/judgement/errors";

// 执行记录里的「结果」入口：跳转到「活动计划判定结果」（e-metrics-lite，刘学奎 2026-11-19；D 的页面不加按钮，只改这个占位页）。
// 先按 D 自己的权限与范围确认这次执行存在，再跳转并带上执行 ID；点检表 / 看板仍归 E 的 `e-metrics`。
export default async function ResultsRedirectPage({ params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("rule.definition.read")) return <DeniedState text="当前角色没有「判定计划」入口。" />;
  const { runId: idText } = await params;
  const runId = parsePlanId(idText);
  if (runId === null) notFound();
  let planId: string;
  try {
    planId = (await judgement().views.executionDetail(ctx, runId)).planId;
  } catch (e) {
    if (e instanceof JudgementError) {
      if (e.category === "not_found" || e.category === "authorization") notFound();
      return <ErrorState code={e.code} />;
    }
    throw e;
  }
  redirect(`/reports/${planId}?run=${idText}`);
}
