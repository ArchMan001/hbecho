import Link from "next/link";
import { notFound } from "next/navigation";
import { ExecuteButton, NewDraftButton, RollbackButton } from "../../../_components/judgement/dialogs";
import { ArchiveButton } from "../../../_components/judgement/plan-buttons";
import { BackLink, Badge, Callout, DeniedState, EmptyState, ErrorState } from "../../../_components/ui";
import { judgement, parsePlanId } from "../../../_lib/judgement";
import { configChips, JP_STATUS, PLATFORM_LABEL, runErrorText, runStatus, timeText, wizardHref } from "../../../_lib/judgement-labels";
import { n } from "../../../_lib/plan-labels";
import { requireUser, web } from "../../../_lib/session";
import { JudgementError } from "../../../../modules/judgement/errors";

const VERSION_STATUS: Record<string, { label: string; tone: "green" | "amber" | "gray" }> = {
  published: { label: "已发布", tone: "green" },
  draft: { label: "草稿", tone: "amber" },
  publishing: { label: "发布中", tone: "amber" },
};

export default async function JudgementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("rule.definition.read")) return <DeniedState text="当前角色没有「判定计划」入口。" />;
  const { id } = await params;
  const planId = parsePlanId(id);
  if (planId === null) notFound();
  let d: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["detail"]>>;
  try {
    d = await judgement().views.detail(ctx, planId);
  } catch (e) {
    // 不存在与越范围对外不可区分；部署配置缺失显示稳定码
    if (e instanceof JudgementError) {
      if (e.category === "not_found" || e.category === "authorization") notFound();
      return <ErrorState code={e.code} />;
    }
    throw e;
  }
  const names = await web().actorNames([d.createdByActor]);
  const st = JP_STATUS[d.status] ?? { label: d.status, tone: "gray" as const };
  const archived = d.status === "archived";
  const draft = d.draft;
  const latestDone = d.executions.find((e) => e.status === "completed");
  const counts = latestDone?.outcomes;
  const publishedList = d.versions.filter((v) => v.status === "published");
  const latestPublished = publishedList[0] ?? null;
  const editable = d.canWrite && !archived && !draft?.publishing;

  return (
    <>
      <BackLink href="/judgement">返回判定计划</BackLink>
      <div className="page-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h1 className="page-title">{d.alias}</h1>
            <Badge tone={st.tone}>{st.label}</Badge>
            {draft ? <Badge tone="amber">{draft.publishing ? "发布中" : "草稿"} v{draft.version}</Badge> : null}
          </div>
          <p className="page-sub">{d.activityPlan.name} · {d.activityPlan.brandName} · {PLATFORM_LABEL[d.activityPlan.platform] ?? d.activityPlan.platform} · 创建人 {names.get(d.createdByActor) ?? "—"}</p>
        </div>
        <div className="page-actions">
          {editable && draft ? <Link className="btn btn-primary" href={wizardHref(d.planId, draft.wizardStep)}>继续配置</Link> : null}
          {editable && draft && draft.wizardStep !== "draft" ? <RollbackButton planId={d.planId} label="回退" /> : null}
          {editable && !draft && latestPublished ? <NewDraftButton planId={d.planId} versions={publishedList} nextVersion={(d.versions[0]?.version ?? 0) + 1} /> : null}
          {editable && !draft && latestPublished ? (
            <ExecuteButton className="btn" info={{ planId: d.planId, alias: d.alias, draftVersion: null, publishedVersion: latestPublished.version, contents: latestDone?.c1 ?? null, participants: latestDone?.participants ?? null, hasAsr: false }} />
          ) : null}
          {d.canWrite ? <ArchiveButton planId={d.planId} alias={d.alias} archived={archived} /> : null}
          <Link className="btn" href={`/judgement/executions?plan=${d.planId}`}>执行记录</Link>
        </div>
      </div>
      {!d.canWrite ? <Callout icon="lock" style={{ marginBottom: 14 }}>当前角色只读：可以查看配置、版本和执行记录，不能修改配置或执行。只有所属活动计划的创建者或超管可以修改。</Callout> : null}
      {archived ? <Callout icon="archive" tone="warn" style={{ marginBottom: 14 }}>已归档：不能新建草稿、不能执行；已有版本、执行记录与结果保持可读。</Callout> : null}
      {d.description ? <p className="hint" style={{ marginBottom: 14 }}>{d.description}</p> : null}

      <div className="stat-grid five" style={{ marginBottom: 18 }}>
        <div className="stat"><div className="stat-label">参与专员</div><div className="stat-value">{latestDone?.participants != null ? n(latestDone.participants) : "—"}</div><div className="stat-hint">执行时冻结</div></div>
        <div className="stat"><div className="stat-label">参与内容</div><div className="stat-value">{latestDone?.c1 != null ? n(latestDone.c1) : "—"}</div><div className="stat-hint">最近完成的执行</div></div>
        <div className="stat"><div className="stat-label">成功</div><div className="stat-value">{counts ? n(counts.success) : "—"}</div><div className="stat-hint">{counts ? "计划总结果" : "尚未完成执行"}</div></div>
        <div className="stat"><div className="stat-label">不达标</div><div className="stat-value">{counts ? n(counts.notMet) : "—"}</div></div>
        <div className="stat"><div className="stat-label">未获取成功</div><div className="stat-value">{counts ? n(counts.unobtained) : "—"}</div><div className="stat-hint">{counts ? "不计入不达标" : ""}</div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">{d.shown ? `${d.shown.status === "published" ? "已发布" : "草稿"} v${d.shown.version} 的配置` : "配置"}</div>
            <div className="card-sub">配置随版本冻结；改配置要新建草稿并发布。</div>
          </div>
        </div>
        <div className="card-pad">
          {d.shown ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {configChips(d.shown.config).map((t) => <span key={t} className="tag">{t}</span>)}
            </div>
          ) : (
            <p className="hint">还没有配置。</p>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div><div className="card-title">版本</div><div className="card-sub">已发布版本不可变；旧版本的结果保留可查。</div></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>版本</th><th>状态</th><th>发布时间</th><th>来源</th><th className="right"></th></tr></thead>
            <tbody>
              {d.versions.map((v) => {
                const vs = VERSION_STATUS[v.status] ?? { label: v.status, tone: "gray" as const };
                return (
                  <tr key={v.version}>
                    <td className="num"><strong>v{v.version}</strong></td>
                    <td><Badge tone={vs.tone}>{vs.label}</Badge></td>
                    <td className="nowrap hint">{timeText(v.publishedAt)}</td>
                    <td className="hint">{v.basedOnVersion ? `基于 v${v.basedOnVersion}` : "首次"}</td>
                    <td className="right nowrap">
                      {editable && !draft && v.status === "published" ? <NewDraftButton planId={d.planId} versions={publishedList} nextVersion={(d.versions[0]?.version ?? 0) + 1} defaultFrom={v.version} label={`从 v${v.version} 新建草稿`} className="btn btn-sm" /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div><div className="card-title">最近执行</div><div className="card-sub">同一计划最新的已完成执行即当前结果。</div></div><Link className="btn btn-sm" href={`/judgement/executions?plan=${d.planId}`}>全部记录</Link></div>
        {d.executions.length === 0 ? (
          <EmptyState title="还没有执行过" text="在向导第 3 页确认执行后，执行记录会显示在这里。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>版本</th><th>状态</th><th>开始</th><th>完成</th><th className="right">成功 / 不达标 / 未获取</th></tr></thead>
              <tbody>
                {d.executions.slice(0, 5).map((e) => {
                  const rs = runStatus(e);
                  const why = e.status === "failed" || e.status === "cancelled" ? runErrorText(e.lastErrorCode) : null;
                  return (
                    <tr key={e.runId}>
                      <td className="num"><Link className="cell-main" href={`/judgement/executions/${e.runId}`}>v{e.version} · 查看</Link></td>
                      <td><Badge tone={rs.tone}>{rs.label}</Badge>{why ? <div className="cell-sub">{why}{e.lastErrorCode ? `（${e.lastErrorCode}）` : ""}</div> : null}</td>
                      <td className="nowrap hint">{timeText(e.startedAt ?? e.createdAt)}</td>
                      <td className="nowrap hint">{timeText(e.completedAt)}</td>
                      <td className="right num">{e.outcomes ? `${n(e.outcomes.success)} / ${n(e.outcomes.notMet)} / ${n(e.outcomes.unobtained)}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card card-pad">
        <div className="card-title">所属活动计划</div>
        <div className="info-grid" style={{ marginTop: 12 }}>
          <div><div className="info-label">活动计划</div><div className="info-value">{d.activityPlan.name}</div></div>
          <div><div className="info-label">品牌 · 平台</div><div className="info-value">{d.activityPlan.brandName} · {PLATFORM_LABEL[d.activityPlan.platform] ?? d.activityPlan.platform}</div></div>
          <div><div className="info-label">活动周期</div><div className="info-value num">{d.activity.startsOn}{d.activity.endsOn ? ` 至 ${d.activity.endsOn}` : " 起"}</div></div>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>执行时冻结名单、当前归属、组织链与内容快照；之后的改绑或换店不影响本次结果。</p>
      </div>
    </>
  );
}
