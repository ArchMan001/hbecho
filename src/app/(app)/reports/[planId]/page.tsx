import Link from "next/link";
import { notFound } from "next/navigation";
import { isReportError, PAGE_SIZE, type Cell, type ReportView } from "../../../../modules/report-detail";
import { ExportButton, JumpToAbility, ReportSearch, Thumb } from "../../../_components/report";
import { Icon } from "../../../_components/icon";
import { FilterCard } from "../../../_components/filter-card";
import { SquareSelect } from "../../../_components/square";
import { Callout, DeniedState, EmptyState, PageHead } from "../../../_components/ui";
import { fmtTime } from "../../../_lib/labels";
import { changedFilters, exportHref, pageOf, parseId, reportHref, reportQueryOf, tabOf, toFilter, type ReportQuery } from "../../../_lib/report-url";
import { reports } from "../../../_lib/reports";
import { requireUser } from "../../../_lib/session";
// 活动计划判定结果（e-metrics-lite）：一个判定计划的一次已完成执行，两个标签（视频明细 / 账号维度）。
// 界面已由刘学奎于 2026-11-19 确认（design §10.6）；状态矩阵见 design §10.4。所有数据与列规则在 report-detail 模块里，页面只渲染。
const TONE: Record<Cell["tone"], string> = { pass: "t-pass", fail: "t-fail", unobtained: "t-unob", skipped: "t-skip", plain: "" };
const WIDE: Record<string, string> = { title: "el-title", contentId: "el-id num", storeCode: "num" };

function CellView({ cell, colKey, ability }: { cell: Cell; colKey: string; ability: boolean }) {
  const cls = [TONE[cell.tone], ability ? "el-ability" : "", WIDE[colKey] ?? ""].filter(Boolean).join(" ");
  const body = cell.link ? (
    <a className="el-link" href={cell.link} target="_blank" rel="noreferrer" title={cell.text} aria-label="打开链接">
      <Icon name="external" />
    </a>
  ) : cell.text ? (
    cell.num !== undefined ? cell.num.toLocaleString("en-US") : cell.text
  ) : (
    <span className="t-skip">—</span>
  );
  return (
    <td className={cls} title={cell.text || undefined}>
      {body}
    </td>
  );
}

function Table({ v }: { v: ReportView }) {
  const t = v.table;
  const accounts = v.tab === "accounts";
  const abilityCount = t.columns.filter((c) => c.kind === "condition").length;
  return (
    <>
      <JumpToAbility count={abilityCount} />
      <div className="el-scroll" tabIndex={0} aria-label={accounts ? "账号维度" : "视频明细"}>
        <table className="el-table">
          <thead>
            <tr>
              <th className="el-fixed-l">{accounts ? "头像" : "封面"}</th>
              {accounts ? <th>主页背景</th> : null}
              {t.columns.map((c) => (
                <th key={c.key} className={c.kind === "condition" ? "is-ability" : c.kind === "result" ? "is-result" : undefined}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i}>
                <td className="el-fixed-l">{accounts ? <Thumb kind="avatar" src={r.images.avatar} label="头像" /> : <Thumb kind="cover" src={r.images.cover} label="封面" />}</td>
                {accounts ? (
                  <td>
                    <Thumb kind="background" src={r.images.background} label="主页背景" />
                  </td>
                ) : null}
                {t.columns.map((c) => (
                  <CellView key={c.key} cell={r.cells[c.key] ?? { text: "", tone: "plain" }} colKey={c.key} ability={c.kind === "condition"} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Pager({ planId, q, v }: { planId: string; q: ReportQuery; v: ReportView }) {
  const { page, pageCount, total } = v.table;
  return (
    <div className="pager el-pager">
      <span className="filter-note">
        共 {total.toLocaleString("en-US")} 行 · 第 {page} / {pageCount} 页 · 每页 {PAGE_SIZE} 行
      </span>
      {page > 1 ? (
        <Link className="btn btn-sm" href={reportHref(planId, q, { page: String(page - 1) })} scroll={false}>
          ‹ 上一页
        </Link>
      ) : (
        <span className="btn btn-sm" aria-disabled="true" style={{ opacity: 0.5 }}>‹ 上一页</span>
      )}
      {page < pageCount ? (
        <Link className="btn btn-sm" href={reportHref(planId, q, { page: String(page + 1) })} scroll={false}>
          下一页 ›
        </Link>
      ) : (
        <span className="btn btn-sm" aria-disabled="true" style={{ opacity: 0.5 }}>下一页 ›</span>
      )}
    </div>
  );
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ planId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("report.read")) return <DeniedState text="当前账号没有「活动计划判定结果」入口。" />;
  const { planId } = await params;
  if (!parseId(planId)) notFound();
  const q = reportQueryOf(await searchParams);
  const tab = tabOf(q);
  const head = (actions?: React.ReactNode) => <PageHead title="活动计划判定结果" sub="一次已完成执行里的全部视频与账号，判定计划里设了什么条件就多什么列。" actions={<>{<Link className="btn" href="/results"><Icon name="arrowLeft" /> 返回活动计划判定结果</Link>}{actions}</>} />;
  let v: ReportView;
  try {
    v = await reports().view(ctx, planId, { tab, ...(q.run ? { executionId: q.run } : {}), filter: toFilter(q), page: pageOf(q) });
  } catch (e) {
    if (isReportError(e)) {
      if (e.kind === "not_found") {
        if (e.code === "execution_not_found") return <>{head()}<EmptyState title="找不到这次执行" text="这次执行不存在，或不属于这个判定计划。回到最近一次执行。" action={<Link className="btn" href={`/reports/${planId}`}>看最近一次执行</Link>} /></>;
        notFound();
      }
      if (e.kind === "auth") return <DeniedState text="当前账号没有查看权限，或没有可见的数据范围。请联系上级管理员确认你的品牌与人员范围。" />;
      if (e.code === "no_completed_execution") return <>{head()}<EmptyState title="还没有完成的执行" text="这个判定计划还没有一次已完成的执行，所以没有可展示的明细，也不能导出。" action={<Link className="btn" href="/results">返回活动计划判定结果</Link>} /></>;
      if (e.kind === "input") return <>{head()}<EmptyState title="筛选条件无效" text="链接里的筛选条件不能识别（或搜索的专员太多）。点「重置」回到默认条件。" action={<Link className="btn" href={`/reports/${planId}`}>重置</Link>} /></>;
    }
    throw e;
  }
  const h = v.header;
  const canExport = ctx.capabilities.has("report.export");
  const pruned = tab === "videos" && !h.videosAvailable;
  const o = v.options;
  const regionOpts = [{ value: "all", label: "全部大区", href: reportHref(planId, q, { region: undefined }) }, ...o.regions.map((x) => ({ value: x.id, label: x.name, href: reportHref(planId, q, { region: x.id }) }))];
  const branchOpts = [{ value: "all", label: "全部分公司", href: reportHref(planId, q, { branch: undefined }) }, ...o.branches.filter((x) => !q.region || x.regionId === q.region).map((x) => ({ value: x.id, label: x.name, href: reportHref(planId, q, { branch: x.id }) }))];
  const sectorOpts = [{ value: "all", label: "全部板块", href: reportHref(planId, q, { sector: undefined }) }, ...o.sectors.map((x) => ({ value: x.id, label: x.name, href: reportHref(planId, q, { sector: x.id }) }))];
  const storeOpts = [{ value: "all", label: "全部门店", href: reportHref(planId, q, { store: undefined }) }, ...o.stores.filter((x) => (!q.branch || x.branchId === q.branch) && (!q.sector || x.sectorId === q.sector)).map((x) => ({ value: x.id, label: x.name, href: reportHref(planId, q, { store: x.id }) }))];
  const runOpts = v.executions.map((x) => ({ value: x.executionId, label: `${fmtTime(x.completedAt)} 完成 · v${x.version}${x.isLatest ? "（最近）" : ""}`, href: reportHref(planId, q, { run: x.isLatest && x.executionId === h.executionId ? undefined : x.executionId }) }));
  const own = ctx.role === "store_staff";
  const chip = (key: "videos" | "accounts", label: string, n: number) => (
    <Link key={key} className={`chip ${tab === key ? "active" : ""}`} href={reportHref(planId, q, { tab: key })} scroll={false} aria-current={tab === key ? "true" : undefined}>
      {label} · {n.toLocaleString("en-US")}
    </Link>
  );
  return (
    <>
      {head(canExport ? <ExportButton previewHref={exportHref(planId, { ...q, run: q.run ?? h.executionId }, true)} downloadHref={exportHref(planId, { ...q, run: q.run ?? h.executionId })} /> : null)}
      <section className="summary-band el-meta" aria-label="执行信息">
        <div>
          <div className="summary-title">
            {h.planAlias} · v{h.version}
          </div>
          <div className="summary-sub">
            {h.activityPlanName} · 窗口 {h.window.fromBjt} ～ {h.window.toBjt || "至今"}（北京日期）· 数据截止 {fmtTime(h.cutoffAt)} · 平台 {h.platformName} ·{" "}
            {pruned ? "视频明细已过保留期" : `范围内 ${v.table.total.toLocaleString("en-US")} 行`}
          </div>
        </div>
        <SquareSelect label="执行" value={h.executionId} options={runOpts} />
      </section>
      <div className="el-banners">
        {tab === "accounts" && !h.abilityResultsAvailable ? <Callout icon="alert" tone="warn">该执行早于「账号能力结果」功能，能力列不可用；重新执行后可见。判定结果与其余列照常显示。</Callout> : null}
        {pruned ? <Callout icon="clock">这次执行的内容明细已过保留期，视频明细不再提供；账号维度仍完整可用。</Callout> : null}
        {!pruned && v.table.missingRows > 0 ? <Callout icon="alert">{v.table.missingRows} 行没有读到{tab === "videos" ? "内容快照" : "主页快照"}数据（如昵称、粉丝数、互动值），相应列已留空，没有当作 0。</Callout> : null}
      </div>
      <div className="md-tabs el-tabs" role="tablist">
        {chip("videos", "视频明细", v.totals.videos)}
        {chip("accounts", "账号维度", v.totals.accounts)}
      </div>
      {pruned ? (
        <EmptyState title="内容明细已过保留期" text="视频明细只保留最近几次执行；账号维度仍可查看。" action={<Link className="btn" href={reportHref(planId, q, { tab: "accounts" })}>看账号维度</Link>} />
      ) : (
        <>
          <FilterCard activeCount={changedFilters(q)}>
            <div className="filter-line el-selects">
              <SquareSelect label="大区" value={q.region ?? "all"} options={regionOpts} disabled={own} />
              <SquareSelect label="分公司" value={q.branch ?? "all"} options={branchOpts} disabled={own || o.branches.length <= 1} />
              <SquareSelect label="板块" value={q.sector ?? "all"} options={sectorOpts} disabled={own} />
              <SquareSelect label="门店" value={q.store ?? "all"} options={storeOpts} disabled={own} />
              <ReportSearch value={q.q ?? ""} hrefBase={reportHref(planId, q, { q: undefined })} disabled={own} />
              <Link className="btn btn-sm" href={reportHref(planId, { ...(q.run ? { run: q.run } : {}), ...(tab === "accounts" ? { tab: "accounts" } : {}) }, {})}>
                重置
              </Link>
            </div>
            {own ? <p className="filter-note" style={{ margin: "8px 0 0" }}>门店专员只能看到本人名下的账号与内容，筛选不可用。</p> : null}
          </FilterCard>
          {v.table.rows.length === 0 && own && changedFilters(q) === 0 ? (
            <EmptyState title="这次执行里没有你名下的内容" text="这个判定计划的这次执行里，你名下没有参与的账号或内容。换一次执行看看，或回到活动计划判定结果。" action={<Link className="btn" href="/results">返回活动计划判定结果</Link>} />
          ) : v.table.rows.length === 0 ? (
            <EmptyState title="没有符合条件的行" text="换个筛选条件，或点「重置」。" action={<Link className="btn" href={reportHref(planId, { ...(q.run ? { run: q.run } : {}), ...(tab === "accounts" ? { tab: "accounts" } : {}) }, {})}>重置</Link>} />
          ) : (
            <>
              <Table v={v} />
              <Pager planId={planId} q={q} v={v} />
            </>
          )}
        </>
      )}
    </>
  );
}
