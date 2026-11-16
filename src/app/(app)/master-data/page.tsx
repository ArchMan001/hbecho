// 主数据浏览（a-master-data-browse design §16）：只读展示分公司与门店，六项筛选、服务端分页。
// 权限与品牌范围复用主数据导入：页面判断 import || structure，Module 再按品牌范围收窄。
import Link from "next/link";
import { ClickRow } from "../../_components/click-row";
import { FilterCard } from "../../_components/filter-card";
import { MasterTabs } from "../../_components/master/tabs";
import { Pager } from "../../_components/plans/pager";
import { Badge, Callout, DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { MasterDataError, type BranchListItem, type BrowseFilter, type PageResult, type StoreListItem, type StoreStatus } from "../../../modules/master-data-import";
import { STORE_STATUS } from "../../_lib/master-labels";
import { masterData, mdActorOf } from "../../_lib/master-data";
import { bjt, n } from "../../_lib/plan-labels";
import { hrefWith, pageOf } from "../../_lib/plan-page";
import { requireUser, web } from "../../_lib/session";

type Q = { view?: string | undefined; brand?: string | undefined; branch?: string | undefined; sector?: string | undefined; tier?: string | undefined; status?: string | undefined; kw?: string | undefined; page?: string | undefined; size?: string | undefined };
const SIZES = [20, 50, 100] as const;

export default async function MasterBrowsePage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("data.master_data.import") && !ctx.capabilities.has("data.master_data.structure")) {
    return <DeniedState text="主数据浏览只对超管与总部人员开放。" />;
  }
  const q = await searchParams;
  const view = q.view === "branches" ? "branches" : "stores";
  const size = SIZES.find((s) => String(s) === q.size) ?? 20;
  const wantPage = Math.max(1, Number(q.page) || 1);
  const tierMissing = q.tier === "__none__";
  const href = (patch: Record<string, string | undefined>) => hrefWith("/master-data", q as Record<string, string | undefined>, patch);
  const clearHref = href({ brand: undefined, branch: undefined, sector: undefined, tier: undefined, status: undefined, kw: undefined, page: undefined });

  const actor = await mdActorOf(ctx);
  const md = masterData();
  const [directory, options] = await Promise.all([web().directory(), md.browse.filterOptions(actor)]);
  const visibleBrands = directory.brands.filter((b) => ctx.scope.brands === "all" || ctx.scope.brands.has(BigInt(b.id)));

  const filter: BrowseFilter = { page: wantPage, pageSize: size };
  if (q.brand) filter.brandId = q.brand;
  if (q.branch) filter.branchId = q.branch;
  if (q.sector) filter.sectorName = q.sector;
  if (!tierMissing && q.tier) filter.tier = q.tier;
  if (tierMissing) filter.tierMissing = true;
  if (q.status) filter.status = q.status as StoreStatus;
  if (q.kw) filter.keyword = q.kw;

  let storesResult: PageResult<StoreListItem> | null = null;
  let branchesResult: PageResult<BranchListItem> | null = null;
  let pages = 1;
  let filterError: string | null = null;
  try {
    if (view === "stores") {
      const first = await md.browse.stores(filter, actor);
      pages = Math.max(1, Math.ceil(first.total / size));
      storesResult = wantPage > pages ? await md.browse.stores({ ...filter, page: pages }, actor) : first;
    } else {
      const first = await md.browse.branches(filter, actor);
      pages = Math.max(1, Math.ceil(first.total / size));
      branchesResult = wantPage > pages ? await md.browse.branches({ ...filter, page: pages }, actor) : first;
    }
  } catch (e) {
    if (e instanceof MasterDataError && e.code === "invalid_filter") filterError = e.message;
    else throw e;
  }

  const total = storesResult?.total ?? branchesResult?.total ?? 0;
  const page = storesResult?.page ?? branchesResult?.page ?? 1;
  const pg = pageOf(String(page), total, size);
  const activeFilters = [q.brand, q.branch, q.sector, q.tier, q.status, q.kw].filter(Boolean).length;
  const chip = (label: string, target: string, current: string | undefined, patch: Record<string, string | undefined>, key?: string) => (
    <Link key={key} className={`chip${current === target ? " active" : ""}`} href={href({ ...patch, page: undefined })} scroll={false}>
      {label}
    </Link>
  );

  const filters = (
    <FilterCard activeCount={activeFilters}>
      <div className="filter-line"><span className="filter-label">视图</span>
        <Link className={`chip${view === "stores" ? " active" : ""}`} href={href({ view: "stores", page: undefined })} scroll={false}>门店 · {n(options.storeCount)}</Link>
        <Link className={`chip${view === "branches" ? " active" : ""}`} href={href({ view: "branches", page: undefined })} scroll={false}>分公司 · {n(options.branchCount)}</Link>
      </div>
      {view === "stores" ? (
        <>
          <div className="filter-line"><span className="filter-label">品牌</span>
            {chip("全部品牌", "all", q.brand ?? "all", { brand: undefined })}
            {visibleBrands.map((b) => chip(b.name, b.id, q.brand, { brand: b.id }, b.id))}
          </div>
          <div className="filter-line"><span className="filter-label">板块</span>
            {chip("全部板块", "all", q.sector ?? "all", { sector: undefined })}
            {options.sectorNames.map((s) => chip(s, s, q.sector, { sector: s }, s))}
          </div>
          <div className="filter-line"><span className="filter-label">店面标准</span>
            {chip("全部", "all", q.tier ?? "all", { tier: undefined })}
            {options.storeTiers.map((t) => chip(t, t, q.tier, { tier: t }, t))}
            {options.hasMissingTier ? chip("未设置", "__none__", q.tier, { tier: "__none__" }) : null}
          </div>
          <div className="filter-line"><span className="filter-label">状态</span>
            {chip("全部", "all", q.status ?? "all", { status: undefined })}
            {chip("在用", "active", q.status, { status: "active" })}
            {chip("已撤店", "closed", q.status, { status: "closed" })}
          </div>
        </>
      ) : null}
      <form method="get" action="/master-data" className="filter-line">
        <input type="hidden" name="view" value={view} />
        {q.brand ? <input type="hidden" name="brand" value={q.brand} /> : null}
        {q.sector ? <input type="hidden" name="sector" value={q.sector} /> : null}
        {q.tier ? <input type="hidden" name="tier" value={q.tier} /> : null}
        {q.status ? <input type="hidden" name="status" value={q.status} /> : null}
        {view === "stores" ? (
          <label className="filter-select"><span>分公司</span>
            <select name="branch" defaultValue={q.branch ?? ""}>
              <option value="">全部分公司</option>
              {directory.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        ) : null}
        <input className="input" name="kw" defaultValue={q.kw ?? ""} placeholder={view === "stores" ? "门店编码或名称" : "分公司编码或名称"} aria-label="搜索关键字" />
        <button className="btn btn-sm" type="submit">搜索</button>
        <Link className="btn btn-sm" href={clearHref}>清空</Link>
      </form>
    </FilterCard>
  );

  const empty = (title: string) => (
    <EmptyState title={title} text="换一个筛选条件，或清空筛选。" action={<Link className="btn" href={clearHref}>清空筛选</Link>} />
  );

  return (
    <>
      <MasterTabs active="browse" />
      <PageHead
        title="主数据浏览"
        sub="库里的分公司与门店当前值；只读，导入请走「主数据导入」。"
        actions={<Link className="btn btn-primary" href="/master-data/import">导入主数据</Link>}
      />
      <section className="summary-band" aria-label="主数据概览">
        <div>
          <div className="summary-title">{view === "stores" ? "门店" : "分公司"}</div>
          <div className="summary-sub">
            {view === "stores"
              ? `范围内 ${n(options.storeCount)} 家门店；只显示你授权品牌内的门店。`
              : `共 ${n(options.branchCount)} 个分公司；门店计数只含授权品牌内的门店。`}
          </div>
        </div>
        <div className="summary-metrics">
          <div className="summary-metric"><span>{n(total)}</span><small>{view === "stores" ? "条门店" : "个分公司"}</small></div>
        </div>
      </section>
      {filters}
      {filterError ? <Callout icon="alert" tone="warn">筛选条件无效：{filterError}</Callout> : null}
      {!filterError && view === "stores" ? (
        storesResult && storesResult.items.length > 0 ? (
          <>
            <div className="table-wrap"><table>
              <thead><tr><th>门店编码</th><th>门店名称</th><th>品牌</th><th>分公司</th><th>板块</th><th>经销商</th><th>店面标准</th><th>状态</th><th>更新时间</th></tr></thead>
              <tbody>
                {storesResult.items.map((s) => (
                  <tr key={s.storeId}>
                    <td className="num">{s.storeCode}</td>
                    <td><div className="cell-main">{s.storeName}</div><div className="cell-sub num">{s.storeId}</div></td>
                    <td>{s.brandName}</td>
                    <td>{s.branchName}</td>
                    <td>{s.sectorName}</td>
                    <td><div className="cell-main">{s.dealerName}</div><div className="cell-sub num">{s.dealerCode ?? "—"}</div></td>
                    <td>{s.storeTier ?? "—"}</td>
                    <td><Badge tone={STORE_STATUS[s.status]?.tone ?? "plain"}>{STORE_STATUS[s.status]?.label ?? s.status}</Badge></td>
                    <td className="num">{bjt(s.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <Pager page={pg.page} pages={pages} href={(p) => href({ page: String(p) })} />
          </>
        ) : empty("没有符合条件的门店")
      ) : null}
      {!filterError && view === "branches" ? (
        branchesResult && branchesResult.items.length > 0 ? (
          <>
            <div className="table-wrap"><table>
              <thead><tr><th>分公司编码</th><th>分公司名称</th><th>大区</th><th className="right">在用门店</th><th className="right">已撤门店</th><th>更新时间</th></tr></thead>
              <tbody>
                {branchesResult.items.map((b) => (
                  <ClickRow key={b.branchId} href={href({ view: "stores", branch: b.branchId, page: undefined })}>
                    <td className="num">{b.branchCode}</td>
                    <td><div className="cell-main">{b.branchName}</div><div className="cell-sub">点击查看这个分公司的门店</div></td>
                    <td>{b.regionName}</td>
                    <td className="right num">{n(b.activeStoreCount)}</td>
                    <td className="right num">{n(b.closedStoreCount)}</td>
                    <td className="num">{bjt(b.updatedAt)}</td>
                  </ClickRow>
                ))}
              </tbody>
            </table></div>
            <Pager page={pg.page} pages={pages} href={(p) => href({ page: String(p) })} />
          </>
        ) : empty("没有符合条件的分公司")
      ) : null}
    </>
  );
}