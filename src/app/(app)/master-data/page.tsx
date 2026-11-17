// 主数据浏览（a-master-data-browse design §16）：只读展示分公司与门店，六项筛选、服务端分页。
// 权限与品牌范围复用主数据导入：页面判断 import || structure，Module 再按品牌范围收窄。
import Link from "next/link";
import { ClickRow } from "../../_components/click-row";
import { FilterCard } from "../../_components/filter-card";
import { HoverFilter } from "../../_components/hover-filter";
import { Icon } from "../../_components/icon";
import { MasterTabs } from "../../_components/master/tabs";
import { Pager } from "../../_components/plans/pager";
import { Badge, Callout, DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { MasterDataError, type BranchListItem, type BrowseFilter, type PageResult, type StoreListItem, type StoreStatus } from "../../../modules/master-data-import";
import { STORE_STATUS } from "../../_lib/master-labels";
import { masterData, mdActorOf } from "../../_lib/master-data";
import { bjt, n } from "../../_lib/plan-labels";
import { hrefMulti, toggled, valuesOf, type Params } from "../../_lib/multi-url";
import { pageOf } from "../../_lib/plan-page";
import { requireUser, web } from "../../_lib/session";

type Q = Params;
const SIZES = [20, 50, 100] as const;
const NO_TIER = "__none__";

export default async function MasterBrowsePage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("data.master_data.import") && !ctx.capabilities.has("data.master_data.structure")) {
    return <DeniedState text="主数据浏览只对超管与总部人员开放。" />;
  }
  const q = await searchParams;
  const view = valuesOf(q.view)[0] === "branches" ? "branches" : "stores";
  const size = SIZES.find((s) => String(s) === valuesOf(q.size)[0]) ?? 20;
  const wantPage = Math.max(1, Number(valuesOf(q.page)[0]) || 1);
  const kw = valuesOf(q.kw)[0] ?? "";
  const href = (patch: Params) => hrefMulti("/master-data", q, patch);
  const FILTER_KEYS = ["brand", "region", "branch", "sector", "tier", "status", "kw", "page"] as const;
  const clearHref = href(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const actor = await mdActorOf(ctx);
  const md = masterData();
  const [directory, options] = await Promise.all([web().directory(), md.browse.filterOptions(actor)]);
  const visibleBrands = directory.brands.filter((b) => ctx.scope.brands === "all" || ctx.scope.brands.has(BigInt(b.id)));

  const picked = {
    brand: valuesOf(q.brand),
    region: valuesOf(q.region),
    sector: valuesOf(q.sector),
    tier: valuesOf(q.tier),
    status: valuesOf(q.status),
  };
  // 选了大区，分公司只列这些大区下的；不在其中的已选分公司丢弃
  const branchOptions = options.branches.filter((b) => picked.region.length === 0 || picked.region.includes(b.regionId));
  const pickedBranch = valuesOf(q.branch).filter((id) => branchOptions.some((b) => b.id === id));

  const filter: BrowseFilter = { page: wantPage, pageSize: size };
  if (picked.brand.length) filter.brandIds = picked.brand;
  if (picked.region.length) filter.regionIds = picked.region;
  if (pickedBranch.length) filter.branchIds = pickedBranch;
  if (picked.sector.length) filter.sectorNames = picked.sector;
  const tierValues = picked.tier.filter((t) => t !== NO_TIER);
  if (tierValues.length) filter.tiers = tierValues;
  if (picked.tier.includes(NO_TIER)) filter.tierMissing = true;
  if (picked.status.length) filter.statuses = picked.status as StoreStatus[];
  if (kw) filter.keyword = kw;

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
  const activeFilters = picked.brand.length + picked.region.length + pickedBranch.length + picked.sector.length + picked.tier.length + picked.status.length + (kw ? 1 : 0);
  /** 一个多选下拉：选项链接 = 在当前已选里加入 / 去掉该值；额外的 patch 用来联动其他参数。 */
  const dropdown = (label: string, key: "brand" | "region" | "branch" | "sector" | "tier" | "status", opts: Array<{ value: string; label: string }>, current: string[], extra?: (next: string[]) => Params) => (
    <HoverFilter
      label={label}
      options={opts.map((o) => {
        const next = toggled(current, o.value);
        return { value: o.value, label: o.label, selected: current.includes(o.value), href: href({ [key]: next, ...extra?.(next), page: undefined }) };
      })}
      clearHref={href({ [key]: undefined, ...extra?.([]), page: undefined })}
    />
  );
  const names = (list: string[]) => list.map((v) => ({ value: v, label: v }));

  const filters = (
    <FilterCard activeCount={activeFilters}>
      <div className="filter-line"><span className="filter-label">视图</span>
        <Link className={`chip${view === "stores" ? " active" : ""}`} href={href({ view: "stores", page: undefined })} scroll={false}>门店 · {n(options.storeCount)}</Link>
        <Link className={`chip${view === "branches" ? " active" : ""}`} href={href({ view: "branches", page: undefined })} scroll={false}>分公司 · {n(options.branchCount)}</Link>
      </div>
      {view === "stores" ? (
        <div className="hf-row">
          {dropdown("品牌", "brand", visibleBrands.map((b) => ({ value: b.id, label: b.name })), picked.brand)}
          {dropdown("板块", "sector", names(options.sectorNames), picked.sector)}
          {dropdown("门店标准", "tier", [...names(options.storeTiers), ...(options.hasMissingTier ? [{ value: NO_TIER, label: "未设置" }] : [])], picked.tier)}
          {dropdown("状态", "status", [{ value: "active", label: "在用" }, { value: "closed", label: "已撤店" }], picked.status)}
          {dropdown(
            "大区",
            "region",
            options.regions.map((r) => ({ value: r.id, label: r.name })),
            picked.region,
            // 大区收窄后，不在这些大区里的已选分公司一并去掉
            (nextRegions) => ({ branch: pickedBranch.filter((id) => nextRegions.length === 0 || nextRegions.includes(options.branches.find((b) => b.id === id)?.regionId ?? "")) }),
          )}
          {dropdown("分公司", "branch", branchOptions.map((b) => ({ value: b.id, label: b.name })), pickedBranch)}
        </div>
      ) : null}
      <form method="get" action="/master-data" className="filter-line">
        <input type="hidden" name="view" value={view} />
        {(["brand", "region", "sector", "tier", "status"] as const).flatMap((k) => picked[k].map((v) => <input key={`${k}-${v}`} type="hidden" name={k} value={v} />))}
        {pickedBranch.map((v) => <input key={`branch-${v}`} type="hidden" name="branch" value={v} />)}
        <label className="course-search" style={{ maxWidth: 340 }}>
          <Icon name="search" />
          <input type="search" name="kw" defaultValue={kw} placeholder={view === "stores" ? "门店编码或名称、经销商编码或名称" : "分公司编码或名称"} aria-label="搜索关键字" />
        </label>
        <button className="btn btn-primary btn-sm" type="submit">检索</button>
        {activeFilters ? <Link className="btn btn-sm btn-ghost" href={clearHref}>清空全部</Link> : null}
        {view === "stores" ? <span className="filter-note">分公司跨品牌共享，选了大区后只列该大区的分公司；门店计数只含授权品牌内的门店</span> : null}
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
                  <ClickRow key={b.branchId} href={href({ view: "stores", brand: undefined, region: undefined, branch: b.branchId, sector: undefined, tier: undefined, status: undefined, kw: undefined, page: undefined })}>
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