import Link from "next/link";
import { notFound } from "next/navigation";
import { MdClassBadge, MdOutcomeBadge, MdReason } from "../../../../_components/master/cells";
import { ReturnFileButton } from "../../../../_components/master/report";
import { Pager } from "../../../../_components/plans/pager";
import { BackLink, Badge, Callout, DeniedState } from "../../../../_components/ui";
import { HEADER } from "../../../../../modules/master-data-import";
import { MD_CLASS, MD_CLASS_ORDER, MD_MODE } from "../../../../_lib/master-labels";
import { masterData, mdActorOf } from "../../../../_lib/master-data";
import { bjt, BATCH_STATUS, n } from "../../../../_lib/plan-labels";
import { hrefWith, orNotFound, pageOf } from "../../../../_lib/plan-page";
import { requireUser, web } from "../../../../_lib/session";

type Q = { cls?: string | undefined; page?: string | undefined };
const ROWS_PER_PAGE = 50;
interface Summary {
  mode?: string;
  new: number;
  update: number;
  unchanged: number;
  error: number;
  needs_superadmin: number;
  imported?: number;
  unchanged_written?: number;
  conflict?: number;
}

export default async function MasterBatchDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("data.master_data.import") && !ctx.capabilities.has("data.master_data.structure")) return <DeniedState text="主数据导入只对超管与总部人员开放。" />;
  const { id } = await params;
  if (!/^[1-9]\d{0,18}$/.test(id)) notFound();
  const q = await searchParams;
  const actor = await mdActorOf(ctx);
  const md = masterData();
  // 范围外的批次表现为「未找到」
  const b = await orNotFound(md.query.get(id, actor));
  const s = b.summary as Summary;
  const st = BATCH_STATUS[b.status] ?? { label: b.status, tone: "gray" as const };
  const names = await web().actorNames([b.uploadedByActor]);
  const completed = b.status === "completed";
  const cls = MD_CLASS_ORDER.find((c) => c === q.cls);
  const total = cls ? (s[cls] ?? 0) : b.totalRows;
  const pg = pageOf(q.page, total, ROWS_PER_PAGE);
  const rows = await md.query.rows(id, { offset: (pg.page - 1) * ROWS_PER_PAGE, limit: ROWS_PER_PAGE, ...(cls ? { precheckClass: cls } : {}) }, actor);
  const href = (patch: Partial<Q>) => hrefWith(`/master-data/batches/${id}`, q, patch);
  const closed = b.pendingClosures.filter((c) => c.status === "resolved" && c.resolutionNote === "confirmed_by_import").length;
  const stillOpen = b.pendingClosures.filter((c) => c.status === "open").length;

  return (
    <>
      <BackLink href="/master-data/batches">返回导入记录</BackLink>
      <div className="page-head">
        <div>
          <h1 className="page-title">批次 <span className="num">{b.batchId}</span></h1>
          <p className="page-sub">{MD_MODE[s.mode ?? ""] ?? s.mode} · {b.fileName ?? "—"} · {bjt(b.uploadedAt)} · {names.get(b.uploadedByActor) ?? b.uploadedByActor}</p>
        </div>
        <div className="page-actions">
          <Badge tone={st.tone}>{st.label}</Badge>
          {b.returnFile.available ? <ReturnFileButton batchId={b.batchId} /> : null}
        </div>
      </div>
      {b.status === "awaiting_confirm" ? (
        <Callout icon="clock" tone="warn" style={{ marginBottom: 14 }}>这个批次预检完成但还没有确认写入。<Link className="cell-main" href={`/master-data/import?batch=${b.batchId}`}>回到预检报告</Link></Callout>
      ) : null}
      {b.status === "writing" ? <Callout icon="clock" tone="warn" style={{ marginBottom: 14 }}>批次正在分块写入，或上一次写入被中断。重新点「确认写入」可以续跑，已写入的行不会重复写入。</Callout> : null}
      {b.status === "precheck_failed" || b.status === "failed" ? <Callout icon="alert" tone="danger" style={{ marginBottom: 14 }}>这个批次没有成功，没有写入任何数据。请修改文件后作为新文件重新上传。</Callout> : null}
      <div className="section-note">行结果 · 共 {n(b.totalRows)} 行</div>
      <div className="stat-grid five" style={{ marginBottom: 14 }}>
        {(
          [
            ["已写入", completed ? (s.imported ?? 0) : 0],
            ["未变", completed ? (s.unchanged_written ?? s.unchanged) : s.unchanged],
            ["错误", s.error],
            ["需超管处理", s.needs_superadmin],
            ["已关闭门店", closed],
          ] as const
        ).map(([label, value]) => (
          <div className="stat" key={label}><div className="stat-label">{label}</div><div className="stat-value">{n(value)}</div></div>
        ))}
      </div>
      {(s.conflict ?? 0) > 0 ? <Callout icon="alert" tone="warn" style={{ marginBottom: 14 }}>有 {s.conflict} 行在确认时发现数据已变化，记为冲突、没有写入；下载回流文件，重新上传预检即可。</Callout> : null}
      {completed && stillOpen > 0 ? <Callout icon="alert" style={{ marginBottom: 14 }}>还有 {stillOpen} 家「待确认撤店」未处理（当时没有勾选）。它们在下一次导入时会重新出现，或被后续批次接续。</Callout> : null}
      <div className="filter-line" style={{ marginBottom: 10 }}>
        <span className="filter-label">预检分类</span>
        <Link className={`chip ${cls ? "" : "active"}`} href={href({ cls: undefined, page: undefined })} scroll={false}>全部</Link>
        {MD_CLASS_ORDER.map((c) => <Link key={c} className={`chip ${cls === c ? "active" : ""}`} href={href({ cls: c, page: undefined })} scroll={false}>{MD_CLASS[c]!.label}</Link>)}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>行</th><th>门店</th><th>所属商家</th><th>预检</th><th>结果</th><th>原因</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const raw = (r.rawRow ?? {}) as Record<string, string>;
              return (
                <tr key={r.rowNo}>
                  <td className="num">{r.rowNo}</td>
                  <td><div className="cell-main">{raw[HEADER[0]] ?? "—"}</div><div className="cell-sub">{raw[HEADER[3]] ?? ""}</div></td>
                  <td>{raw[HEADER[4]] ?? "—"}</td>
                  <td><MdClassBadge cls={r.precheckClass} /></td>
                  <td><MdOutcomeBadge outcome={r.outcome} /></td>
                  <td><MdReason code={r.reasonCode} detail={r.reasonDetail} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager page={pg.page} pages={pg.pages} href={(p) => href({ page: String(p) })} />
    </>
  );
}
