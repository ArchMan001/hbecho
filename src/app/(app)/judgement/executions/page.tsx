import Link from "next/link";
import { ClickRow } from "../../../_components/click-row";
import { AutoRefresh } from "../../../_components/judgement/auto-refresh";
import { Pager } from "../../../_components/plans/pager";
import { Badge, DeniedState, EmptyState, ErrorState, PageHead } from "../../../_components/ui";
import { judgement } from "../../../_lib/judgement";
import { runStatus, timeText } from "../../../_lib/judgement-labels";
import { n } from "../../../_lib/plan-labels";
import { hrefWith, pageOf, PAGE_SIZE } from "../../../_lib/plan-page";
import { requireUser } from "../../../_lib/session";
import { JudgementError } from "../../../../modules/judgement/errors";

type Q = { plan?: string; status?: string; page?: string };
const GROUPS: Array<[string, string, (s: string) => boolean]> = [
  ["all", "全部", () => true],
  ["active", "在途", (s) => ["planned", "running", "waiting"].includes(s)],
  ["done", "已完成", (s) => s === "completed"],
  ["bad", "失败 / 取消", (s) => s === "failed" || s === "cancelled"],
];

export default async function ExecutionsPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("rule.definition.read")) return <DeniedState text="当前角色没有「判定计划」入口。" />;
  const q = await searchParams;
  let all: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["executions"]>>;
  try {
    all = await judgement().views.executions(ctx);
  } catch (e) {
    if (e instanceof JudgementError) return <ErrorState code={e.code} />;
    throw e;
  }
  const plan = q.plan && /^\d{1,19}$/.test(q.plan) ? q.plan : undefined;
  const scoped = plan ? all.filter((r) => r.planId === plan) : all;
  const group = GROUPS.find(([k]) => k === q.status) ?? GROUPS[0]!;
  const rows = scoped.filter((r) => group[2](r.status));
  const { page, pages, offset } = pageOf(q.page, rows.length);
  const shown = rows.slice(offset, offset + PAGE_SIZE);
  const count = (f: (s: string) => boolean) => scoped.filter((r) => f(r.status)).length;
  const href = (patch: Partial<Q>) => hrefWith("/judgement/executions", q, { page: undefined, ...patch });
  const planAlias = plan ? scoped[0]?.alias : undefined;
  const hasActive = count(GROUPS[1]![2]) > 0;

  return (
    <>
      <AutoRefresh active={hasActive} />
      <PageHead
        title="执行记录"
        sub={`排队、执行中、等待采集、等待识别、完成、失败与取消；同一计划最新的已完成执行即当前结果。${planAlias ? ` 当前只看「${planAlias}」。` : ""}`}
        actions={<Link className="btn" href={plan ? `/judgement/${plan}` : "/judgement"}>返回判定计划</Link>}
      />
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="stat-label">全部执行</div><div className="stat-value">{n(scoped.length)}</div><div className="stat-hint">最近在前</div></div>
        <div className="stat"><div className="stat-label">在途</div><div className="stat-value">{n(count(GROUPS[1]![2]))}</div><div className="stat-hint">排队 / 执行 / 等待</div></div>
        <div className="stat"><div className="stat-label">已完成</div><div className="stat-value">{n(count(GROUPS[2]![2]))}</div><div className="stat-hint">可查看点检表</div></div>
        <div className="stat"><div className="stat-label">失败 / 取消</div><div className="stat-value">{n(count(GROUPS[3]![2]))}</div><div className="stat-hint">保留原因</div></div>
      </div>
      <section className="filter-card open" style={{ display: "block" }}>
        <div className="filter-line">
          <span className="filter-label">状态</span>
          {GROUPS.map(([k, label]) => (
            <Link key={k} className={`chip ${group[0] === k ? "active" : ""}`} href={href({ status: k })} scroll={false}>{label}</Link>
          ))}
          {plan ? <Link className="btn btn-sm btn-ghost" href="/judgement/executions">看全部计划</Link> : null}
        </div>
      </section>
      <div className="result-bar">
        <span>共 <strong>{rows.length}</strong> 次执行</span>
        <span className="hint">成功 / 不达标 / 未获取成功按参与专员计数。</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="还没有执行记录" text={scoped.length === 0 ? "在向导第 3 页确认执行后，记录会出现在这里。" : "换一个状态试试。"} />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th style={{ minWidth: 220 }}>判定计划</th><th>版本</th><th>状态</th><th>开始 / 完成</th><th className="right">参与专员</th><th className="right">成功 / 不达标 / 未获取</th><th className="right">操作</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const st = runStatus(r);
                  return (
                    <ClickRow key={r.runId} href={`/judgement/executions/${r.runId}`}>
                      <td><Link className="cell-main" href={`/judgement/executions/${r.runId}`}>{r.alias}</Link></td>
                      <td className="num nowrap">v{r.version}</td>
                      <td className="nowrap"><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="nowrap"><span className="num">{timeText(r.startedAt ?? r.createdAt)}</span><div className="cell-sub">{r.completedAt ? `完成 ${timeText(r.completedAt)}` : "尚未结束"}</div></td>
                      <td className="right num">{r.participants === null ? "—" : n(r.participants)}</td>
                      <td className="right num nowrap">{r.outcomes ? `${n(r.outcomes.success)} / ${n(r.outcomes.notMet)} / ${n(r.outcomes.unobtained)}` : "—"}</td>
                      <td className="right nowrap"><Link className="btn btn-sm" href={`/judgement/executions/${r.runId}`}>查看</Link></td>
                    </ClickRow>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} href={(pg) => href({ page: String(pg) })} />
        </>
      )}
    </>
  );
}
