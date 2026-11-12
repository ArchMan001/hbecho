import Link from "next/link";
import { ClickRow } from "../../_components/click-row";
import { FilterCard } from "../../_components/filter-card";
import { Icon } from "../../_components/icon";
import { Pager } from "../../_components/plans/pager";
import { Badge, DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { n, PLAN_STATUS, PLATFORM_LABEL, sectorText } from "../../_lib/plan-labels";
import { bjtToday, brandNameByCode, hrefWith, pageOf, PAGE_SIZE } from "../../_lib/plan-page";
import { ap, planActorOf } from "../../_lib/plan";
import { requireUser, web } from "../../_lib/session";

type Q = { brand?: string; platform?: string; status?: string; page?: string };
const STATUS_CHIPS: Array<[string, string]> = [["all", "全部状态"], ["collecting", "采集中"], ["paused", "暂停"], ["archived", "归档"]];

export default async function PlansPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  const canCreate = ctx.capabilities.has("activity_plan.create");
  if (!canCreate && !ctx.capabilities.has("activity_plan.join")) return <DeniedState text="当前角色没有「活动计划」入口。" />;
  const q = await searchParams;
  const actor = await planActorOf(ctx);
  const [all, brandName] = await Promise.all([ap().query.overview(actor), brandNameByCode()]);

  const brand = q.brand && q.brand !== "all" ? q.brand : undefined;
  const platform = q.platform && q.platform !== "all" ? q.platform : undefined;
  const status = q.status && q.status !== "all" ? q.status : undefined;
  // 筛选条件、结果数与分页总数用同一条谓词（ui-foundation §4.1）
  const filtered = all.filter((p) => (!brand || p.brand === brand) && (!platform || p.platform === platform) && (!status || p.status === status));
  const { page, pages, offset } = pageOf(q.page, filtered.length);
  const rows = filtered.slice(offset, offset + PAGE_SIZE);
  const names = await web().actorNames(rows.map((p) => p.createdBy));
  const today = bjtToday();

  const sum = (pick: (p: (typeof all)[number]) => number) => all.reduce((s, p) => s + pick(p), 0);
  const href = (patch: Partial<Q>) => hrefWith("/plans", q, { page: undefined, ...patch });
  const chip = (group: keyof Q, value: string, label: string, current: string | undefined) => (
    <Link key={value} className={`chip ${(current ?? "all") === value ? "active" : ""}`} href={href({ [group]: value })} scroll={false}>
      {label}
    </Link>
  );
  // 品牌筛选只列出自己授权范围内的计划所在的品牌（范围外的不显示，也不显示计数）
  const brandsInScope = [...new Set(all.map((p) => p.brand))].sort();
  const platformsInScope = [...new Set(all.map((p) => p.platform))].sort();
  const collecting = all.filter((p) => p.status === "collecting").length;

  return (
    <>
      <PageHead
        title="活动计划"
        sub="按品牌、平台与状态筛选；计划创建即发布，品牌 / 平台 / 板块创建后不可修改。"
        actions={
          canCreate ? (
            <>
              <Link className="btn" href="/plans/trash"><Icon name="trash" /> 回收站</Link>
              <Link className="btn btn-primary" href="/plans/new"><Icon name="plus" /> 新建计划</Link>
            </>
          ) : undefined
        }
      />
      <section className="summary-band" aria-label="计划概览">
        <div>
          <div className="summary-title">{all.length} 个活动计划 · {collecting} 个采集中</div>
        </div>
        <div className="summary-metrics">
          <div className="summary-metric"><span>{n(sum((p) => p.counts.accounts))}</span><small>名单账号</small></div>
          <div className="summary-metric"><span>{n(sum((p) => p.counts.branches))}</span><small>参与分公司</small></div>
          <div className="summary-metric"><span>{n(sum((p) => p.counts.pending))}</span><small>待处理</small></div>
        </div>
      </section>
      <FilterCard activeCount={[brand, platform, status].filter(Boolean).length}>
        <div className="filter-line"><span className="filter-label">品牌</span>{chip("brand", "all", "全部品牌", brand)}{brandsInScope.map((b) => chip("brand", b, brandName.get(b) ?? b, brand))}</div>
        <div className="filter-line"><span className="filter-label">平台</span>{chip("platform", "all", "全部平台", platform)}{platformsInScope.map((p) => chip("platform", p, PLATFORM_LABEL[p] ?? p, platform))}</div>
        <div className="filter-line"><span className="filter-label">状态</span>{STATUS_CHIPS.map(([v, l]) => chip("status", v, l, status))}</div>
        <div className="selected-line">
          <span className="filter-label">已选条件</span>
          <span className="selected-chip">{brand ? (brandName.get(brand) ?? brand) : "全部品牌"}</span>
          <span className="selected-chip">{platform ? (PLATFORM_LABEL[platform] ?? platform) : "全部平台"}</span>
          <span className="selected-chip">{status ? PLAN_STATUS[status]?.label : "全部状态"}</span>
          {brand || platform || status ? <Link className="btn btn-sm btn-ghost" href="/plans">清空</Link> : null}
        </div>
      </FilterCard>
      <div className="result-bar">
        <span>共 <strong>{filtered.length}</strong> 个计划</span>
        <span className="hint">只显示你数据范围内的计划。</span>
      </div>
      {filtered.length === 0 ? (
        all.length === 0 ? (
          <EmptyState title="还没有活动计划" text={canCreate ? "创建第一个计划，分公司加入后即可提报名单。" : "总部创建计划后会显示在这里；采集中的计划才对分公司开放。"} action={canCreate ? <Link className="btn btn-primary" href="/plans/new">新建计划</Link> : undefined} />
        ) : (
          <EmptyState title="没有符合条件的计划" text="换一个品牌、平台或状态试试。" action={<Link className="btn" href="/plans">清空筛选</Link>} />
        )
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th style={{ minWidth: 250 }}>计划</th><th>品牌 · 平台</th><th>板块</th><th>起止</th><th className="right">规模</th><th className="right">负责人</th><th>状态</th><th className="right">操作</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const st = PLAN_STATUS[p.status] ?? { label: p.status, tone: "gray" as const };
                  const expired = p.endsOn !== null && p.endsOn < today;
                  return (
                    <ClickRow key={p.planId} href={`/plans/${p.planId}`}>
                      <td>
                        <Link className="cell-main" href={`/plans/${p.planId}`}>{p.name}</Link>
                        <div className="cell-sub">创建者 {names.get(p.createdBy) ?? p.createdBy}</div>
                      </td>
                      <td className="nowrap"><span className="tag">{brandName.get(p.brand) ?? p.brand}</span> <span className="cell-sub" style={{ display: "inline" }}>{PLATFORM_LABEL[p.platform] ?? p.platform}</span></td>
                      <td className="nowrap">{p.sectors.map((s) => <span key={s} className="tag">{sectorText([s])}</span>)}</td>
                      <td className="nowrap"><span className="num">{p.startsOn}</span><br /><span className="cell-sub">{p.endsOn ? `至 ${p.endsOn}` : "无结束日"}</span></td>
                      <td className="right nowrap"><span className="num">{n(p.counts.accounts)}</span><br /><span className="cell-sub">{p.counts.branches} 个分公司</span></td>
                      <td className="right nowrap"><span className="num">{p.counts.owners} 名</span><br /><span className="cell-sub">{p.counts.pending} 待处理</span></td>
                      <td className="nowrap"><Badge tone={st.tone}>{st.label}</Badge>{expired ? <div className="cell-sub">已到期</div> : null}</td>
                      <td className="right nowrap"><Link className="btn btn-sm" href={`/plans/${p.planId}`}>查看</Link></td>
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
