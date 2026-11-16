import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink, DeniedState, ErrorState } from "../../../../_components/ui";
import { Icon } from "../../../../_components/icon";
import { judgement, parsePlanId } from "../../../../_lib/judgement";
import { n } from "../../../../_lib/plan-labels";
import { requireUser } from "../../../../_lib/session";
import { JudgementError } from "../../../../../modules/judgement/errors";

// E 域（指标与看板）的点检表入口：本版只是占位页，不出 500、不暴露内部字段。
// D 只提供只读的判定结果；点检表、专员明细、计划看板与导出文件由 E 设计，D 不实现全量明细表。
export default async function ResultsPlaceholderPage({ params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("rule.definition.read")) return <DeniedState text="当前角色没有「判定计划」入口。" />;
  const { runId: idText } = await params;
  const runId = parsePlanId(idText);
  if (runId === null) notFound();
  let d: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["executionDetail"]>>;
  try {
    d = await judgement().views.executionDetail(ctx, runId);
  } catch (e) {
    if (e instanceof JudgementError) {
      if (e.category === "not_found" || e.category === "authorization") notFound();
      return <ErrorState code={e.code} />;
    }
    throw e;
  }
  const o = d.run.outcomes;
  return (
    <>
      <BackLink href={`/judgement/executions/${idText}`}>返回执行记录</BackLink>
      <div className="card">
        <div className="state">
          <div className="state-icon"><Icon name="activity" /></div>
          <div className="state-title">组织点检表与专员明细在「指标与看板」里</div>
          <p className="state-text">这个入口属于 E 域，还没有上线。判定结果已经就绪，上线后可以从这里进入点检表、专员明细与导出。</p>
          {o ? (
            <div className="stat-grid" style={{ margin: "16px auto 0", maxWidth: 640 }}>
              <div className="stat"><div className="stat-label">判定计划</div><div className="stat-value" style={{ fontSize: 15 }}>{d.alias}</div><div className="stat-hint">v{d.run.version}</div></div>
              <div className="stat"><div className="stat-label">参与专员</div><div className="stat-value">{n(d.run.participants ?? 0)}</div></div>
              <div className="stat"><div className="stat-label">成功</div><div className="stat-value">{n(o.success)}</div></div>
              <div className="stat"><div className="stat-label">未获取成功</div><div className="stat-value">{n(o.unobtained)}</div></div>
            </div>
          ) : null}
          <div style={{ marginTop: 18 }}>
            <Link className="btn" href={`/judgement/executions/${idText}`}>回到执行记录</Link>
          </div>
        </div>
      </div>
    </>
  );
}
