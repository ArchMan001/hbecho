import Link from "next/link";
import { notFound } from "next/navigation";
import { OutcomeBadge, PrecheckBadge, ReasonCell } from "../../../_components/plans/cells";
import { Pager } from "../../../_components/plans/pager";
import { BatchActions } from "../../../_components/plans/roster-wizard";
import { BackLink, Badge, Callout, DeniedState, EmptyState } from "../../../_components/ui";
import { ROSTER_HEADER } from "../../../../modules/activity-plan/constants";
import { bjt, BATCH_STATUS, n, OUTCOME_LABEL } from "../../../_lib/plan-labels";
import { directory, hrefWith, orNotFound, pageOf } from "../../../_lib/plan-page";
import { ap, planActorOf } from "../../../_lib/plan";
import { requireUser, web } from "../../../_lib/session";

type Q = { outcome?: string | undefined; page?: string | undefined };
const ROWS_PER_PAGE = 50;
interface Confirm {
  imported?: number;
  unchanged?: number;
  conflict?: number;
  invalid?: number;
  suspected_empty?: number;
  resolve_failed?: number;
  pending_account?: number;
  staff_created?: number;
}

export default async function BatchDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("activity_plan.create") && !ctx.capabilities.has("activity_plan.join")) return <DeniedState text="当前角色没有「活动计划」入口。" />;
  const { id } = await params;
  if (!/^[1-9]\d{0,18}$/.test(id)) notFound();
  const q = await searchParams;
  const actor = await planActorOf(ctx);
  // 范围外的批次表现为「未找到」
  const b = await orNotFound(ap().query.batch(actor, id));
  const [names, dir] = await Promise.all([web().actorNames([b.uploadedBy]), directory()]);
  const st = BATCH_STATUS[b.status] ?? { label: b.status, tone: "gray" as const };
  const c = (b.confirm ?? {}) as Confirm;
  const confirmed = b.confirm !== null && Object.keys(b.confirm as object).length > 0;
  const pending = c.pending_account ?? 0;
  const total = Math.max(b.totalRows, 1);
  const done = Math.max(0, total - pending);
  const percent = Math.min(100, Math.round((done / total) * 100));
  const outcome = q.outcome && q.outcome in OUTCOME_LABEL ? q.outcome : undefined;
  const href = (patch: Partial<Q>) => hrefWith(`/batches/${id}`, q, patch);

  let rows: Awaited<ReturnType<ReturnType<typeof ap>["query"]["rows"]>> | null = null;
  let page = 1;
  let pages = 1;
  if (b.rowsVisible && confirmed) {
    const wanted = Math.max(1, Number(q.page) || 1);
    const fetchRows = (pg: number) => ap().query.rows(actor, id, { offset: (pg - 1) * ROWS_PER_PAGE, limit: ROWS_PER_PAGE, ...(outcome ? { outcome } : {}) });
    rows = await fetchRows(wanted);
    const pg = pageOf(q.page, rows.total, ROWS_PER_PAGE);
    if (pg.page !== wanted) rows = await fetchRows(pg.page);
    page = pg.page;
    pages = pg.pages;
  }
  const precheck = b.precheck as { error?: number } | null;
  const hasReturnRows = b.rowsVisible && ((c.conflict ?? 0) + (c.invalid ?? 0) + (c.resolve_failed ?? 0) + (precheck?.error ?? 0) > 0);

  return (
    <>
      <BackLink href="/batches">返回批次列表</BackLink>
      <div className="page-head">
        <div>
          <h1 className="page-title">批次 <span className="num">{b.batchId}</span></h1>
          <p className="page-sub">
            {b.planName ?? "（计划已清除）"} · {b.fileName} · {bjt(b.uploadedAt)} · {names.get(b.uploadedBy) ?? b.uploadedBy}
            {b.submitterBranchId ? ` · ${dir.branches.find((x) => x.id === b.submitterBranchId)?.name ?? ""}` : ""}
          </p>
        </div>
        <div className="page-actions">
          <Badge tone={st.tone}>{st.label}</Badge>
          {b.planId && b.planName ? <Link className="btn" href={`/plans/${b.planId}`}>查看计划</Link> : null}
          <BatchActions batchId={b.batchId} hasReturnRows={hasReturnRows} live={b.status === "resolving"} />
        </div>
      </div>

      {b.status === "awaiting_confirm" ? (
        <Callout icon="clock" tone="warn" style={{ marginBottom: 14 }}>
          这个批次预检完成但还没有确认写入。<Link className="cell-main" href={`/plans/${b.planId}/import?batch=${b.batchId}`}>回到预检报告</Link>
        </Callout>
      ) : null}
      {b.status === "precheck_failed" || b.status === "failed" ? <Callout icon="alert" tone="danger" style={{ marginBottom: 14 }}>这个批次没有成功，没有写入任何数据。请修改文件后作为新文件重新上传。</Callout> : null}

      {confirmed ? (
        <>
          <div className="rail-card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div><div className="rail-kicker">解析进度</div><div className="rail-title">{pending > 0 ? `解析中 ${n(pending)} 行` : "全部行已有结果"}</div></div>
              <strong className="num" style={{ fontSize: 20, color: "var(--brand-deep)" }}>{percent}%</strong>
            </div>
            <div className="progress-track" style={{ marginTop: 10 }}><div className="progress-bar" style={{ width: `${percent}%` }} /></div>
            <div className="rail-text">{n(done)} / {n(total)} 行已有结果；解析只读取主页信息，不触发列表采集。</div>
          </div>
          <div className="section-note">行结果 · 共 {n(b.totalRows)} 行</div>
          <div className="stat-grid" style={{ marginBottom: 14 }}>
            {(
              [
                ["已导入", c.imported],
                ["已存在并引用", c.unchanged],
                ["归属冲突", c.conflict],
                ["链接无效", c.invalid],
                ["疑似空账号", c.suspected_empty],
                ["解析失败", c.resolve_failed],
                ["新建专员", c.staff_created],
              ] as const
            ).map(([label, value]) => (
              <div className="stat" key={label}><div className="stat-label">{label}</div><div className="stat-value">{n(value ?? 0)}</div></div>
            ))}
          </div>
          {pending > 0 ? <Callout icon="clock" tone="warn" style={{ marginBottom: 14 }}>仍在解析的行由系统逐条处理；只读取主页信息，不触发列表采集。本页每 8 秒自动刷新。批次完成后，会对「已存在并引用」的账号补抓一次（距上次采集满 7 天）。</Callout> : null}
          {b.rowsVisible && rows ? (
            rows.total === 0 && !outcome ? (
              <EmptyState title="这个批次没有逐行明细" text="批次已完成；行结果与批次同寿命保留。" action={<Link className="btn" href="/batches">返回批次列表</Link>} />
            ) : (
              <>
                <div className="filter-line" style={{ marginBottom: 12 }}>
                  <span className="filter-label">结果</span>
                  <Link className={`chip ${outcome ? "" : "active"}`} href={href({ outcome: undefined, page: undefined })} scroll={false}>全部</Link>
                  {Object.entries(OUTCOME_LABEL).map(([v, o]) => <Link key={v} className={`chip ${outcome === v ? "active" : ""}`} href={href({ outcome: v, page: undefined })} scroll={false}>{o.label}</Link>)}
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>行</th><th>门店 · 专员</th><th>手机号</th><th>预检</th><th>结果</th><th>原因</th></tr></thead>
                    <tbody>
                      {rows.items.map((r) => {
                        const raw = (r.raw ?? {}) as Record<string, string>;
                        return (
                          <tr key={r.rowNo}>
                            <td className="num">{r.rowNo}</td>
                            <td><div className="cell-main">{raw[ROSTER_HEADER[0]] ?? "—"}</div><div className="cell-sub">{raw[ROSTER_HEADER[1]] ?? ""}</div></td>
                            <td className="num">{raw[ROSTER_HEADER[2]] ?? "—"}</td>
                            <td><PrecheckBadge cls={r.precheckClass} /></td>
                            <td><OutcomeBadge outcome={r.outcome} /></td>
                            <td><ReasonCell code={r.reasonCode} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager page={page} pages={pages} href={(pg) => href({ page: String(pg) })} />
              </>
            )
          ) : (
            <Callout icon="lock">总部只能查看批次汇总，逐行明细由提交的分公司查看。</Callout>
          )}
        </>
      ) : null}
    </>
  );
}
