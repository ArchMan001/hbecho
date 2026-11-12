import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MdClassBadge, MdReason } from "../../../_components/master/cells";
import { ClosureProvider, ClosureTable, ReportBar, type ClosureItem } from "../../../_components/master/report";
import { MasterUpload, MdSteps } from "../../../_components/master/upload";
import { Pager } from "../../../_components/plans/pager";
import { Callout, DeniedState, PageHead } from "../../../_components/ui";
import { HEADER } from "../../../../modules/master-data-import";
import { MD_CLASS, MD_CLASS_ORDER, MD_MODE } from "../../../_lib/master-labels";
import { masterData, mdActorOf } from "../../../_lib/master-data";
import { n } from "../../../_lib/plan-labels";
import { brandNameByCode, directory, hrefWith, orNotFound, pageOf } from "../../../_lib/plan-page";
import { requireUser, web } from "../../../_lib/session";

type Q = { batch?: string | undefined; cls?: string | undefined; page?: string | undefined };
const ROWS_PER_PAGE = 50;
interface Summary {
  mode: "import" | "structure";
  new: number;
  update: number;
  unchanged: number;
  error: number;
  needs_superadmin: number;
  pending_closure_stores: number;
  suspect_incomplete_export: boolean;
}

export default async function MasterImportPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("data.master_data.import") && !ctx.capabilities.has("data.master_data.structure")) return <DeniedState text="主数据导入只对超管与总部人员开放。" />;
  const q = await searchParams;
  const canStructure = ctx.capabilities.has("data.master_data.structure");
  const [profile, brandName, dir] = await Promise.all([web().profile(ctx), brandNameByCode(), directory()]);
  const scopeText = profile.brandNames === "all" ? "全部品牌" : profile.brandNames.join("、");
  // 空目录时导入必然整批失败（品牌 / 分公司 / 板块都查不到），先说明原因，不让用户白上传一遍
  const orgEmpty = dir.brands.length === 0 || dir.branches.length === 0;

  const rail = (mode: string) => (
    <aside className="wizard-rail" aria-label="导入上下文">
      <div className="rail-card">
        <div className="rail-kicker">当前模式</div>
        <div className="rail-title">{mode === "structure" ? "结构导入（仅超管）" : "普通导入"}</div>
        <div className="rail-list">
          <div className="rail-row"><span>文件</span><strong>11 列固定表头</strong></div>
          <div className="rail-row"><span>数据行</span><strong>≤ 10,000</strong></div>
          <div className="rail-row"><span>文件大小</span><strong>≤ 10 MB</strong></div>
          <div className="rail-row"><span>单批时长</span><strong>≤ 10 分钟</strong></div>
        </div>
      </div>
      <div className="rail-card">
        <div className="rail-kicker">授权范围</div>
        <div className="rail-title">{scopeText}</div>
        <div className="rail-text">{profile.brandNames === "all" ? "可处理所有品牌的行。" : "授权品牌之外的行记为「品牌不在授权范围」，不会写入。"}</div>
      </div>
      <div className="rail-card">
        <div className="rail-kicker">消失的门店</div>
        <div className="rail-title">不会自动关店</div>
        <div className="rail-text">文件里没有、库里仍在用的门店只列为「待确认撤店」，由你逐个勾选才会关闭。</div>
      </div>
      <Callout icon="shield">预检只读；确认前不写任何门店、商家或关系。</Callout>
    </aside>
  );
  const head = (
    <>
      <PageHead
        title="主数据导入"
        sub="导入权威主档导出（门店信息）；预检只读，确认后才写入业务表。"
        actions={<Link className="btn" href="/master-data/batches">导入记录</Link>}
      />
      {orgEmpty ? (
        <Callout icon="alert" tone="warn">
          组织主档为空（品牌 {dir.brands.length} 个、分公司 {dir.branches.length} 个）：现在上传的门店行都会被判为「品牌不存在」或「不在授权范围」，无法写入。请超管先完成组织主档引导（运维手册 §10.3），再回来导入。
        </Callout>
      ) : null}
    </>
  );

  if (!q.batch) {
    return (
      <>
        {head}
        <div className="wizard-layout">
          <div className="card wizard-main"><MasterUpload canStructure={canStructure} /></div>
          {rail("import")}
        </div>
      </>
    );
  }

  if (!/^[1-9]\d{0,18}$/.test(q.batch)) notFound();
  const actor = await mdActorOf(ctx);
  const md = masterData();
  const batch = await orNotFound(md.query.get(q.batch, actor));
  if (batch.status !== "awaiting_confirm") redirect(`/master-data/batches/${batch.batchId}`); // 已确认过 / 预检失败：去批次详情
  const s = batch.summary as Summary;
  const cls = MD_CLASS_ORDER.find((c) => c === q.cls);
  const total = cls ? (s[cls] ?? 0) : batch.totalRows;
  const fetchRows = (pg: number) => md.query.rows(batch.batchId, { offset: (pg - 1) * ROWS_PER_PAGE, limit: ROWS_PER_PAGE, ...(cls ? { precheckClass: cls } : {}) }, actor);
  const pg = pageOf(q.page, total, ROWS_PER_PAGE);
  const rows = await fetchRows(pg.page);
  const href = (patch: Partial<Q>) => hrefWith("/master-data/import", q, patch);
  const closures: ClosureItem[] = batch.pendingClosures
    .filter((c) => c.status === "open")
    .map((c) => {
      const d = (c.detail ?? {}) as Record<string, string | null>;
      return { storeId: c.storeId, code: d.store_code ?? "—", name: d.store_name ?? "—", brand: brandName.get(d.brand_code ?? "") ?? d.brand_code ?? "—", dealerCode: d.dealer_code ?? "—", sectorCode: d.sector_code ?? "—" };
    });

  return (
    <>
      {head}
      <div className="wizard-layout">
        <div className="card wizard-main">
          <MdSteps current={3} />
          <div className="card-pad">
            <ClosureProvider items={closures}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                <div>
                  <div className="card-title">预检报告</div>
                  <div className="card-sub">{batch.fileName} · {MD_MODE[s.mode] ?? s.mode} · 数据行 {n(batch.totalRows)}</div>
                </div>
                <ReportBar
                  hasReturnRows={s.error + s.needs_superadmin > 0}
                  facts={{
                    batchId: batch.batchId,
                    modeLabel: MD_MODE[s.mode] ?? s.mode,
                    fileName: batch.fileName ?? "—",
                    totalRows: batch.totalRows,
                    newCount: s.new,
                    updateCount: s.update,
                    notImported: s.error + s.needs_superadmin,
                    errorCount: s.error,
                    needsCount: s.needs_superadmin,
                  }}
                />
              </div>
              <div className="stat-grid five" style={{ marginBottom: 14 }}>
                {(
                  [
                    ["新增", s.new, "将新建门店"],
                    ["更新", s.update, "名称 / 等级 / 恢复"],
                    ["未变", s.unchanged, "无需处理"],
                    ["错误", s.error, "需修改后重传"],
                    ["需超管处理", s.needs_superadmin, "商家或组织缺失"],
                  ] as const
                ).map(([label, value, hint]) => (
                  <div className="stat" key={label}><div className="stat-label">{label}</div><div className="stat-value">{n(value)}</div><div className="stat-hint">{hint}</div></div>
                ))}
              </div>
              <Callout icon="shield" style={{ marginBottom: 14 }}>预检只读：门店、商家、品牌、分公司的行数与更新时间都没有变化。</Callout>
              {s.suspect_incomplete_export ? <Callout icon="alert" tone="warn" style={{ marginBottom: 14 }}>疑似导出不完整：待确认撤店的门店超过库里在用门店的 20%。请先核对导出文件是不是少了品牌或分公司，再决定要不要勾选。</Callout> : null}
              <ClosureTable items={closures} />
              <div className="section-note">行明细</div>
              <div className="filter-line" style={{ marginBottom: 10 }}>
                <span className="filter-label">预检分类</span>
                <Link className={`chip ${cls ? "" : "active"}`} href={href({ cls: undefined, page: undefined })} scroll={false}>全部</Link>
                {MD_CLASS_ORDER.map((c) => <Link key={c} className={`chip ${cls === c ? "active" : ""}`} href={href({ cls: c, page: undefined })} scroll={false}>{MD_CLASS[c]!.label}</Link>)}
              </div>
              <div className="table-wrap precheck-table">
                <table>
                  <thead><tr><th>行</th><th>门店</th><th>所属商家</th><th>预检</th><th>原因</th></tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const raw = (r.rawRow ?? {}) as Record<string, string>;
                      return (
                        <tr key={r.rowNo}>
                          <td className="num">{r.rowNo}</td>
                          <td><div className="cell-main">{raw[HEADER[0]] ?? "—"}</div><div className="cell-sub">{raw[HEADER[3]] ?? ""}</div></td>
                          <td>{raw[HEADER[4]] ?? "—"}</td>
                          <td><MdClassBadge cls={r.precheckClass} /></td>
                          <td><MdReason code={r.reasonCode} detail={r.reasonDetail} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={pg.page} pages={pg.pages} href={(p) => href({ page: String(p) })} />
            </ClosureProvider>
          </div>
        </div>
        {rail(s.mode)}
      </div>
    </>
  );
}
