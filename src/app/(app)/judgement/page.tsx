import Link from "next/link";
import { ClickRow } from "../../_components/click-row";
import { FilterCard } from "../../_components/filter-card";
import { CreateJudgementPlan } from "../../_components/judgement/create-plan";
import { Pager } from "../../_components/plans/pager";
import { Badge, DeniedState, EmptyState, ErrorState, PageHead } from "../../_components/ui";
import { judgement } from "../../_lib/judgement";
import { JP_STATUS, PLATFORM_LABEL, runStatus, timeText, wizardHref } from "../../_lib/judgement-labels";
import { hrefWith, pageOf, PAGE_SIZE } from "../../_lib/plan-page";
import { n } from "../../_lib/plan-labels";
import { requireUser } from "../../_lib/session";
import { JudgementError } from "../../../modules/judgement/errors";

type Q = { activity?: string; status?: string; page?: string };
const STATUS_CHIPS: Array<[string, string]> = [["all", "全部状态"], ["active", "进行中"], ["archived", "已归档"]];

export default async function JudgementListPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("rule.definition.read")) return <DeniedState text="当前角色没有「判定计划」入口。" />;
  const canWrite = ctx.capabilities.has("rule.definition.manage");
  const q = await searchParams;
  let all: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["list"]>>;
  let options: Awaited<ReturnType<ReturnType<typeof judgement>["views"]["creatableActivityPlans"]>> = [];
  try {
    const { views } = judgement();
    all = await views.list(ctx);
    if (canWrite) options = await views.creatableActivityPlans(ctx);
  } catch (e) {
    // 部署配置缺失 / 依赖不可用：显示稳定码，不当作「没有数据」
    if (e instanceof JudgementError) return <ErrorState code={e.code} />;
    throw e;
  }

  const activity = q.activity && q.activity !== "all" ? q.activity : undefined;
  const status = q.status === "active" || q.status === "archived" ? q.status : undefined;
  // ponytail: 范围内的判定计划数量级为几十，筛选与分页在内存里做；上千后改成查询层分页
  const filtered = all.filter((p) => (!activity || p.activityPlan.id === activity) && (!status || p.status === status));
  const { page, pages, offset } = pageOf(q.page, filtered.length);
  const rows = filtered.slice(offset, offset + PAGE_SIZE);
  const activities = [...new Map(all.map((p) => [p.activityPlan.id, p.activityPlan])).values()];
  const href = (patch: Partial<Q>) => hrefWith("/judgement", q, { page: undefined, ...patch });
  const chip = (group: keyof Q, value: string, label: string, current: string | undefined) => (
    <Link key={value} className={`chip ${(current ?? "all") === value ? "active" : ""}`} href={href({ [group]: value })} scroll={false}>
      {label}
    </Link>
  );
  const count = (pick: (p: (typeof all)[number]) => boolean) => all.filter(pick).length;

  return (
    <>
      <PageHead
        title="判定计划"
        sub="给活动计划建一条从监控到出结果的判定链路；圈定、试跑、执行共用一份冻结输入。"
        actions={canWrite ? <CreateJudgementPlan options={options} /> : <Badge tone="gray">只读</Badge>}
      />
      <section className="summary-band" aria-label="判定计划概览">
        <div>
          <div className="summary-title">{n(all.length)} 个判定计划 · {n(count((p) => p.status === "active"))} 个进行中</div>
        </div>
        <div className="summary-metrics">
          <div className="summary-metric"><span>{n(count((p) => p.draft !== null))}</span><small>草稿</small></div>
          <div className="summary-metric"><span>{n(count((p) => p.latestExecution !== null && ["planned", "running", "waiting"].includes(p.latestExecution.status)))}</span><small>执行中</small></div>
          <div className="summary-metric"><span>{n(count((p) => p.status === "archived"))}</span><small>已归档</small></div>
        </div>
      </section>
      <FilterCard activeCount={[activity, status].filter(Boolean).length}>
        <div className="filter-line">
          <span className="filter-label">活动计划</span>
          {chip("activity", "all", "全部活动计划", activity)}
          {activities.map((a) => chip("activity", a.id, a.name, activity))}
        </div>
        <div className="filter-line">
          <span className="filter-label">状态</span>
          {STATUS_CHIPS.map(([v, l]) => chip("status", v, l, status))}
        </div>
        <div className="selected-line">
          <span className="filter-label">已选条件</span>
          <span className="selected-chip">{activity ? (activities.find((a) => a.id === activity)?.name ?? "活动计划") : "全部活动计划"}</span>
          <span className="selected-chip">{status ? JP_STATUS[status]?.label : "全部状态"}</span>
          {activity || status ? <Link className="btn btn-sm btn-ghost" href="/judgement">清空</Link> : null}
        </div>
      </FilterCard>
      <div className="result-bar">
        <span>共 <strong>{filtered.length}</strong> 个判定计划</span>
        <span className="hint">只显示你数据范围内的判定计划，按创建时间倒序。</span>
      </div>
      {filtered.length === 0 ? (
        all.length === 0 ? (
          <EmptyState title="还没有判定计划" text={canWrite ? "判定计划属于一个活动计划；创建后从第 1 页开始圈定。" : "总部创建判定计划后会显示在这里。"} action={canWrite ? <CreateJudgementPlan options={options} buttonClass="btn btn-primary" /> : undefined} />
        ) : (
          <EmptyState title="没有符合条件的判定计划" text="换一个活动计划或状态试试。" action={<Link className="btn" href="/judgement">清空筛选</Link>} />
        )
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th style={{ minWidth: 240 }}>别名</th><th>所属活动计划</th><th>状态</th><th>版本</th><th>最近执行</th><th>更新时间</th><th className="right">操作</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const st = JP_STATUS[p.status] ?? { label: p.status, tone: "gray" as const };
                  const run = p.latestExecution;
                  const rs = run ? runStatus(run) : null;
                  return (
                    <ClickRow key={p.planId} href={`/judgement/${p.planId}`}>
                      <td>
                        <Link className="cell-main" href={`/judgement/${p.planId}`}>{p.alias}</Link>
                        {p.description ? <div className="cell-sub">{p.description}</div> : null}
                      </td>
                      <td>
                        <div className="cell-main">{p.activityPlan.name}</div>
                        <div className="cell-sub">{p.activityPlan.brandName} · {PLATFORM_LABEL[p.activityPlan.platform] ?? p.activityPlan.platform}</div>
                      </td>
                      <td className="nowrap"><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="nowrap">
                        {p.draft ? <Badge tone="amber">{p.draft.publishing ? "发布中" : "草稿"} v{p.draft.version}</Badge> : null}
                        {p.publishedVersion !== null ? <Badge tone="gray">已发布 v{p.publishedVersion}</Badge> : null}
                      </td>
                      <td className="nowrap">
                        {run && rs ? (
                          <>
                            {run.status === "completed" && run.outcomes ? (
                              <span className="num">成功 {n(run.outcomes.success)} / {n(run.participants ?? 0)}</span>
                            ) : (
                              <Badge tone={rs.tone}>{rs.label}</Badge>
                            )}
                            <div className="cell-sub">{timeText(run.startedAt ?? run.createdAt)}</div>
                          </>
                        ) : (
                          <span className="hint">尚未执行</span>
                        )}
                      </td>
                      <td className="nowrap hint">{timeText(p.updatedAt)}</td>
                      <td className="right nowrap">
                        {p.draft && canWrite && p.status === "active" ? (
                          <Link className="btn btn-sm" href={wizardHref(p.planId, p.draft.wizardStep)}>继续配置</Link>
                        ) : (
                          <Link className="btn btn-sm" href={`/judgement/${p.planId}`}>查看</Link>
                        )}
                      </td>
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
