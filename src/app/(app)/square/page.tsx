import Link from "next/link";
import { isSquareError, list, options, parseSquareFilter } from "../../../modules/video-square";
import { FilterCard } from "../../_components/filter-card";
import { Icon } from "../../_components/icon";
import { OffTab, SquareSelect } from "../../_components/square";
import { DeniedState, EmptyState } from "../../_components/ui";
import { requireUser } from "../../_lib/session";
import { square } from "../../_lib/square";
import { changedCount, KIND_OPTIONS, LIKE_OPTIONS, squareHref, squareQueryOf, WITHIN_OPTIONS, type SquareQuery } from "../../_lib/square-url";
import { Card } from "./_card";

const PAGE_SIZE = 20;

export default async function SquarePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("square.read")) return <DeniedState text="当前账号没有视频广场入口。" />;
  const q: SquareQuery = squareQueryOf(await searchParams);
  const href = (patch: Parameters<typeof squareHref>[1]) => squareHref(q, patch);
  let result;
  let opts;
  try {
    const deps = square();
    const filter = parseSquareFilter(q);
    [result, opts] = await Promise.all([list(deps, ctx, filter), options(deps, ctx)]);
  } catch (e) {
    if (isSquareError(e) && e.kind === "auth") return <DeniedState text="当前账号没有视频广场入口，或没有可见的品牌范围。请联系平台管理员确认你的品牌与人员范围。" />;
    if (isSquareError(e) && e.kind === "input") {
      // 非法筛选：固定人话，不展示内部 message；不执行宽查询
      return (
        <EmptyState title="筛选条件无效" text="链接里的筛选条件不能识别。点「重置」回到默认条件。" action={<Link className="btn" href="/square">重置</Link>} />
      );
    }
    throw e;
  }
  const kind = q.kind ?? "video";
  const changed = changedCount(q);
  const planHint = "暂未开放";
  const grid = result.items.length ? (
    <div className="sq-grid">
      {result.items.map((c) => (
        <Card key={c.contentId} card={c} />
      ))}
    </div>
  ) : changed ? (
    <EmptyState title="没有符合条件的视频" text="换个关键词，或点「重置」回到默认条件。" action={<Link className="btn" href="/square">重置</Link>} />
  ) : (
    <EmptyState title="还没有符合条件的视频" text="采集到作品后会出现在这里。" />
  );
  const chip = (active: boolean, label: string, to: string) => (
    <Link key={label} className={`chip ${active ? "active" : ""}`} href={to} scroll={false} aria-current={active ? "true" : undefined}>
      {label}
    </Link>
  );
  return (
    <>
      <h1 className="sq-sr">经销商视频广场</h1>
      <div className="sq-bigtabs" role="tablist" aria-label="广场类型">
        <span className="sq-bigtab active" role="tab" aria-selected="true">
          <span className="sq-bigtab-title">经销商视频广场</span>
          <span className="sq-bigtab-sub">各品牌经销商的公开作品</span>
        </span>
        <OffTab title="官媒阵地" sub="暂未开放" />
      </div>
      <p className="page-sub sq-lead">各品牌经销商的公开作品，用来互相借鉴。只显示点赞超过 50 的作品，按点赞数从高到低排列。</p>
      <FilterCard activeCount={changed}>
        <div className="filter-line">
          <span className="filter-label">品牌</span>
          {chip(!q.brand || q.brand === "all", "全部品牌", href({ brand: undefined }))}
          {opts.brands.map((b) => chip(q.brand === b.id, b.name, href({ brand: b.id })))}
        </div>
        <div className="filter-line">
          <span className="filter-label">平台</span>
          {chip(!q.platform || q.platform === "all", "全部平台", href({ platform: undefined }))}
          {opts.platforms.map((p) => chip(q.platform === p.code, p.name, href({ platform: p.code })))}
        </div>
        <div className="filter-line">
          <span className="filter-label">类型</span>
          {KIND_OPTIONS.map(([v, l]) => chip(kind === v, l, href({ kind: v })))}
        </div>
        <div className="filter-line sq-selects">
          <SquareSelect label="参与活动计划" value="all" disabled hint={planHint} options={[{ value: "all", label: "全部活动计划", href: href({}) }]} />
          <SquareSelect label="分公司" value={q.branch ?? "all"} options={[{ value: "all", label: "全部分公司", href: href({ branch: undefined }) }, ...opts.branches.map((b) => ({ value: b.id, label: b.name, href: href({ branch: b.id }) }))]} />
          <SquareSelect label="发布时间" value={q.within ?? "all"} options={WITHIN_OPTIONS.map(([v, l]) => ({ value: v, label: l, href: href({ within: v }) }))} />
          <SquareSelect label="点赞数" value={q.like ?? "all"} options={LIKE_OPTIONS.map(([v, l]) => ({ value: v, label: l, href: href({ like: v }) }))} />
          <form className="sq-search" method="get" action="/square" role="search">
            {(["brand", "platform", "kind", "branch", "within", "like"] as const).map((k) => (q[k] ? <input key={k} type="hidden" name={k} value={q[k]} /> : null))}
            <label className="course-search">
              <Icon name="search" />
              <input type="search" name="q" defaultValue={q.q ?? ""} placeholder="搜索视频标题" aria-label="搜索视频标题" maxLength={100} />
            </label>
            <button type="submit" className="btn btn-sm btn-dark">搜索</button>
            <Link className="btn btn-sm" href="/square">重置</Link>
          </form>
        </div>
      </FilterCard>
      <div className="result-bar">
        <span>共 <strong className="num">{result.total.toLocaleString("en-US")}</strong> 条 · 第 {result.page} / {result.pageCount} 页</span>
        <span className="hint">按点赞数从高到低 · 活动计划下拉目前置灰</span>
      </div>
      {grid}
      <div className="pagination">
        <span>每页 {PAGE_SIZE} 条</span>
        <div className="pagination-actions">
          {result.page > 1 ? <Link className="btn btn-sm" href={href({ page: String(result.page - 1) })}>上一页</Link> : <button type="button" className="btn btn-sm" disabled>上一页</button>}
          {result.page < result.pageCount ? <Link className="btn btn-sm" href={href({ page: String(result.page + 1) })}>下一页</Link> : <button type="button" className="btn btn-sm" disabled>下一页</button>}
        </div>
      </div>
    </>
  );
}
