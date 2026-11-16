import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { WizardStep1 } from "../../../../../_components/judgement/wizard-step1";
import { WizardStep2 } from "../../../../../_components/judgement/wizard-step2";
import { WizardStep3 } from "../../../../../_components/judgement/wizard-step3";
import { Stepbar } from "../../../../../_components/judgement/wizard-common";
import { BackLink, Callout, DeniedState, ErrorState } from "../../../../../_components/ui";
import { Icon } from "../../../../../_components/icon";
import { judgement, parsePlanId } from "../../../../../_lib/judgement";
import { PLATFORM_LABEL } from "../../../../../_lib/judgement-labels";
import { requireUser } from "../../../../../_lib/session";
import { JudgementError } from "../../../../../../modules/judgement/errors";

const GATE: Record<2 | 3, { text: string; go: 1 | 2 }> = {
  2: { text: "先完成第 1 页圈定", go: 1 },
  3: { text: "先完成第 2 页试跑", go: 2 },
};

export default async function WizardPage({ params }: { params: Promise<{ id: string; step: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("rule.definition.read")) return <DeniedState text="当前角色没有「判定计划」入口。" />;
  const { id, step: stepText } = await params;
  const planId = parsePlanId(id);
  const step = stepText === "1" ? 1 : stepText === "2" ? 2 : stepText === "3" ? 3 : null;
  if (planId === null || step === null) notFound();
  let w: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["wizard"]>>;
  try {
    w = await judgement().views.wizard(ctx, planId);
  } catch (e) {
    if (e instanceof JudgementError) {
      if (e.category === "not_found" || e.category === "authorization") notFound();
      return <ErrorState code={e.code} />;
    }
    throw e;
  }
  if (!w) redirect(`/judgement/${id}`); // 没有草稿：回详情（新建草稿在那里）
  const d = w.detail;
  const draft = d.draft!;
  const cfg = d.shown!.config;
  const archived = d.status !== "active";
  const canWrite = d.canWrite && !archived && !draft.publishing;
  const sub = `${d.activityPlan.name} · ${d.activityPlan.brandName} · ${PLATFORM_LABEL[d.activityPlan.platform] ?? d.activityPlan.platform} · 时间窗 ${cfg.window.from} ~ ${cfg.window.to ?? "执行时"}`;
  const rollbackLabel = draft.wizardStep === "draft" || step === 1 ? null : draft.wizardStep === "circled" ? "回退到第 1 页" : step === 3 ? "回退到第 2 页" : "清除试跑结果（回退）";

  const body =
    step > w.current ? (
      <div className="card">
        <div className="state">
          <div className="state-icon"><Icon name="layers" /></div>
          <div className="state-title">{GATE[step as 2 | 3].text}</div>
          <p className="state-text">向导是阻塞式的：前一步确认后才能进入下一步。</p>
          <Link className="btn btn-primary" href={`/judgement/${id}/wizard/${GATE[step as 2 | 3].go}`}>去第 {GATE[step as 2 | 3].go} 页</Link>
        </div>
      </div>
    ) : step === 1 ? (
      <WizardStep1 key={`${id}-${draft.version}`} planId={id} alias={d.alias} sub={sub} version={draft.version} initial={cfg} canWrite={canWrite} circle={w.circle} rosterNote={`${d.activityPlan.name} · ${PLATFORM_LABEL[d.activityPlan.platform] ?? d.activityPlan.platform}`} />
    ) : step === 2 ? (
      <WizardStep2 key={`${id}-${draft.version}`} planId={id} alias={d.alias} sub={sub} version={draft.version} initial={cfg} canWrite={canWrite} platform={d.activityPlan.platform} uploaded={w.uploaded} trial={w.trial} trialRun={w.trialRun} rollbackLabel={rollbackLabel} />
    ) : (
      <WizardStep3 key={`${id}-${draft.version}`} planId={id} alias={d.alias} sub={sub} version={draft.version} initial={cfg} canWrite={canWrite} circle={w.circle} publish={w.publish} rollbackLabel={rollbackLabel} />
    );

  return (
    <>
      <BackLink href={`/judgement/${id}`}>返回判定计划</BackLink>
      {!canWrite ? (
        <Callout icon="lock" style={{ marginBottom: 14 }}>
          {archived ? "判定计划已归档：只能查看，不能修改配置或执行。" : draft.publishing ? "这个草稿正在发布，暂时不能修改。" : "当前角色只读：可以查看向导，不能修改配置或执行。只有所属活动计划的创建者或超管可以修改。"}
        </Callout>
      ) : null}
      <Stepbar planId={id} current={w.current} viewing={step} />
      {body}
    </>
  );
}
