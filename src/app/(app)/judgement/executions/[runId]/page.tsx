import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "../../../../_components/judgement/auto-refresh";
import { NewDraftButton } from "../../../../_components/judgement/dialogs";
import { ParticipantsTable } from "../../../../_components/judgement/participants-table";
import { ConfirmAction } from "../../../../_components/dialog";
import { Icon } from "../../../../_components/icon";
import { Pager } from "../../../../_components/plans/pager";
import { cancelJudgementRun, resumeJudgementRun } from "../../../../_actions/judgement";
import { BackLink, Badge, Callout, DeniedState, EmptyState, ErrorState, PageHead } from "../../../../_components/ui";
import { judgement, parsePlanId } from "../../../../_lib/judgement";
import { phaseInfo, runErrorText, runStatus, timeText } from "../../../../_lib/judgement-labels";
import { n } from "../../../../_lib/plan-labels";
import { hrefWith } from "../../../../_lib/plan-url";
import { requireUser, web } from "../../../../_lib/session";
import { JudgementError } from "../../../../../modules/judgement/errors";
import type { ParticipantFilter } from "../../../../../modules/judgement/views";

type Q = { result?: string; page?: string };
const FILTERS: Array<[ParticipantFilter, string]> = [["all", "全部"], ["success", "成功"], ["not_met", "不达标"], ["unobtained", "未获取成功"], ["sync", "同步不完整"]];
const PER_PAGE = 50;

export default async function ExecutionDetailPage({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("rule.definition.read")) return <DeniedState text="当前角色没有「判定计划」入口。" />;
  const { runId: idText } = await params;
  const runId = parsePlanId(idText);
  if (runId === null) notFound();
  const q = await searchParams;
  const filter = FILTERS.find(([k]) => k === q.result)?.[0] ?? "all";
  const wanted = Math.max(1, Math.floor(Number(q.page)) || 1);
  let d: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["executionDetail"]>>;
  let list: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["participants"]>>;
  try {
    const { views } = judgement();
    d = await views.executionDetail(ctx, runId);
    list = await views.participants(ctx, runId, { filter, offset: (wanted - 1) * PER_PAGE, limit: PER_PAGE });
  } catch (e) {
    if (e instanceof JudgementError) {
      if (e.category === "not_found" || e.category === "authorization") notFound();
      return <ErrorState code={e.code} />;
    }
    throw e;
  }
  const run = d.run;
  const st = runStatus(run);
  const active = ["planned", "running", "waiting"].includes(run.status);
  const done = run.status === "completed";
  const o = run.outcomes;
  const total = run.participants ?? 0;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  const pages = Math.max(1, Math.ceil(list.total / PER_PAGE));
  const page = Math.min(wanted, pages);
  const href = (patch: Partial<Q>) => hrefWith(`/judgement/executions/${idText}`, q, { page: undefined, ...patch });
  const phase = phaseInfo(run.phase);
  const names = await web().actorNames([d.submittedBy]);

  return (
    <>
      <AutoRefresh active={active} />
      <BackLink href={`/judgement/executions?plan=${d.planId}`}>执行记录</BackLink>
      <PageHead
        title={<>{d.alias} · v{run.version} <Badge tone={st.tone}>{st.label}</Badge></>}
        sub={`提交人 ${names.get(d.submittedBy) ?? "—"} · 开始 ${timeText(run.startedAt ?? run.createdAt)}${d.window ? ` · 时间窗 ${d.window.from} ~ ${d.window.to ?? "冻结时刻"}` : ""}`}
        actions={
          <>
            <Link className="btn" href={`/judgement/${d.planId}`}>判定计划</Link>
            {done ? <Link className="btn btn-primary" href={`/judgement/results/${idText}`}><Icon name="arrowRight" /> 查看点检表（E）</Link> : null}
            {done && d.canAct ? <NewDraftButton planId={d.planId} versions={[{ version: run.version, publishedAt: run.completedAt }]} nextVersion={run.version + 1} label="从此版本新建草稿" className="btn" /> : null}
            {active && d.canAct ? (
              <ConfirmAction label="取消执行" buttonClass="btn" danger title="取消执行" confirmLabel="取消执行" doneMessage="已取消" action={cancelJudgementRun.bind(null, idText)}>
                <Callout icon="alert" tone="warn">取消后不再提交新依赖；已提交的采集由采集系统自己跑完。取消的执行不对 E 可见。</Callout>
              </ConfirmAction>
            ) : null}
            {run.status === "failed" && d.canAct ? (
              <ConfirmAction label="续跑" icon="refresh" buttonClass="btn btn-primary" title="续跑" confirmLabel="续跑" doneMessage="已提交续跑" action={resumeJudgementRun.bind(null, idText)}>
                <Callout icon="refresh">从上次停下的阶段继续，已完成的部分不会重算。</Callout>
              </ConfirmAction>
            ) : null}
          </>
        }
      />
      {active ? (
        <div className="callout" role="status" style={{ marginBottom: 14 }}>
          <Icon name="clock" />
          <span style={{ flex: 1 }}>
            <b>{st.label}</b>：{run.status === "waiting" && run.waitingOn === "demand" ? "等待采集系统返回评论 / 音频等数据；有等待上限，超时的内容记未获取成功。" : run.status === "waiting" && run.waitingOn === "signals" ? "等待识别结果补算完成；有等待上限，超时的内容记未获取成功。" : run.status === "waiting" && run.waitingOn === "collection" ? `等待参与账号的视频列表采集完成（还有 ${n(run.collectWait?.pendingAccounts ?? 0)} 个账号在采集${run.collectWait?.deadline ? `，最多等到 ${new Date(run.collectWait.deadline).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}` : ""}）；超时后按现有数据继续判定。` : run.status === "planned" ? "已提交，等待后台领取。" : `正在${phase.label}。`} 页面会自动更新。
            <div className="progress-bar" style={{ marginTop: 8 }}><i style={{ width: `${phase.percent}%` }} /></div>
          </span>
        </div>
      ) : null}
      {run.status === "failed" ? <div className="callout danger" role="alert" style={{ marginBottom: 14 }}><Icon name="alert" /><span><b>执行失败</b>：{runErrorText(run.lastErrorCode)}{run.lastErrorCode ? `（错误码 ${run.lastErrorCode}）` : ""}。已定的内容保留，可以续跑。</span></div> : null}
      {run.status === "cancelled" ? <Callout icon="alert" style={{ marginBottom: 14 }}>已取消：取消的执行不对 E 可见；已提交的采集由采集系统自己跑完。</Callout> : null}
      {done && d.syncPending > 0 ? <Callout icon="alert" tone="warn" style={{ marginBottom: 14 }}>执行时仍有 <b>{n(d.syncPending)}</b> 个账号在采集，这些账号记为「采集中」，结果可能不完整；采完后重新执行即可。</Callout> : null}
      {done && d.syncIncomplete > 0 ? <Callout icon="alert" tone="warn" style={{ marginBottom: 14 }}>有 <b>{n(d.syncIncomplete)}</b> 名专员窗口内的同步不完整。他们的「不达标」可能是误判：缺失的内容本来可能让他们达标。结果不改，只在明细与导出里提示。</Callout> : null}
      {done && d.contentsPruned ? <Callout icon="file" style={{ marginBottom: 14 }}>这次执行的内容级结果已按保留期清理；参与专员与汇总仍长期保留。</Callout> : null}

      <div className="stat-grid five" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="stat-label">参与专员</div><div className="stat-value">{run.participants === null ? "—" : n(run.participants)}</div><div className="stat-hint">执行冻结的名单</div></div>
        <div className="stat"><div className="stat-label">成功</div><div className="stat-value" style={{ color: "var(--success)" }}>{o ? n(o.success) : "—"}</div><div className="stat-hint">{o ? "计划总结果" : "尚未完成"}</div></div>
        <div className="stat"><div className="stat-label">不达标</div><div className="stat-value" style={{ color: "var(--danger)" }}>{o ? n(o.notMet) : "—"}</div><div className="stat-hint">{o ? "不达标优先" : ""}</div></div>
        <div className="stat"><div className="stat-label">未获取成功</div><div className="stat-value">{o ? n(o.unobtained) : "—"}</div><div className="stat-hint">{o ? "单独统计" : ""}</div></div>
        <div className="stat"><div className="stat-label">C1 / C2 / C3</div><div className="stat-value">{run.c1 ?? "—"} / {run.c2 ?? "—"} / {run.c3 ?? "—"}</div><div className="stat-hint">{run.staleUsed ? "含使用旧值的内容" : "各层通过条数"}</div></div>
      </div>
      {o && total > 0 ? (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div className="result-split" role="img" aria-label={`成功 ${o.success}，不达标 ${o.notMet}，未获取成功 ${o.unobtained}`}>
            <div className="seg green" style={{ width: `${pct(o.success)}%` }} />
            <div className="seg red" style={{ width: `${pct(o.notMet)}%` }} />
            <div className="seg gray" style={{ width: `${pct(o.unobtained)}%` }} />
          </div>
          <div className="legend">
            <span><i style={{ background: "#2fa36b" }} />成功 {n(o.success)}</span>
            <span><i style={{ background: "#e5484d" }} />不达标 {n(o.notMet)}</span>
            <span><i style={{ background: "#9aa5b1" }} />未获取成功 {n(o.unobtained)}</span>
            <span className="hint">完成率 {Math.round(pct(o.success))}% · 分母 = 参与专员数</span>
          </div>
        </div>
      ) : null}

      {done ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">参与专员</div>
              <div className="card-sub">成功 + 不达标 + 未获取成功 = 参与专员数；点一位专员看逐层结果与证据</div>
            </div>
            <span className="badge gray">{n(list.total)} 人</span>
          </div>
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="filter-line">
              {FILTERS.map(([k, label]) => (
                <Link key={k} className={`chip ${filter === k ? "active" : ""}`} href={href({ result: k })} scroll={false}>{label}</Link>
              ))}
            </div>
          </div>
          {list.rows.length === 0 ? (
            <EmptyState title="没有符合条件的专员" text={filter === "all" ? "这次执行没有参与专员，或不在你的数据范围内。" : "换一个筛选试试。"} />
          ) : (
            <ParticipantsTable runId={idText} rows={list.rows} canReadContent={d.canReadContent} />
          )}
        </div>
      ) : null}
      {done && list.rows.length > 0 ? <Pager page={page} pages={pages} href={(pg) => href({ page: String(pg) })} /> : null}
    </>
  );
}
