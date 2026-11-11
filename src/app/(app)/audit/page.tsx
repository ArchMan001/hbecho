import Link from "next/link";
import { AuditFilters } from "../../_components/audit-filters";
import { Badge, DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { AUDIT_EVENT_LABEL, AUDIT_RANGES, AUDIT_EVENT_OPTIONS, AUDIT_REASON_LABEL, fmtTime, ROLE_LABEL } from "../../_lib/labels";
import { requireUser, web } from "../../_lib/session";

const PAGE_SIZE = 50;
const DAYS: Record<string, number> = { "7d": 7, "30d": 30, "1y": 365 };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ event?: string; range?: string; page?: string; actor?: string; target?: string }> }) {
  const ctx = await requireUser();
  // 审计只对超管开放；其他角色直接访问也只看到「无权访问」，不显示任何条数
  if (!ctx.capabilities.has("audit.read")) return <DeniedState text="审计日志仅平台超管可读。" />;
  const q = await searchParams;
  const event = q.event && AUDIT_EVENT_OPTIONS.includes(q.event) ? q.event : "all";
  const range = q.range && q.range in DAYS ? q.range : "all";
  const days = DAYS[range];
  const actor = (q.actor ?? "").trim().slice(0, 50);
  const target = (q.target ?? "").trim().slice(0, 50);
  const w = web();
  // 姓名 / 手机号 → 用户 ID；输入了但没有匹配时结果为空（不是「忽略这个条件」）
  const filter = {
    ...(event !== "all" ? { eventType: event } : {}),
    ...(days ? { from: new Date(Date.now() - days * 86_400_000) } : {}),
    ...(actor ? { actorUserIds: await w.resolveAuditUsers(ctx, actor) } : {}),
    ...(target ? { targetUserIds: await w.resolveAuditUsers(ctx, target) } : {}),
  };
  const count = await w.auditReader.count(ctx, filter);
  const pages = Math.max(1, Math.ceil(count.total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  const [raw, org] = await Promise.all([w.auditReader.read(ctx, { ...filter, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }), w.directory()]);
  const rows = await w.decorateAudit(raw);
  const names = (ids: string[], list: Array<{ id: string; name: string }>) => ids.map((i) => list.find((x) => x.id === i)?.name ?? "").filter(Boolean).join("、");
  const scopeText = (s: unknown): string => {
    if (!s || typeof s !== "object") return "—";
    const o = s as { role?: string; brandIds?: string[]; branchIds?: string[] };
    const parts = [o.role ? (ROLE_LABEL[o.role] ?? "") : "", names((o.brandIds ?? []).map(String), org.brands), names((o.branchIds ?? []).map(String), org.branches)].filter(Boolean);
    return parts.length ? parts.join(" · ") : "—";
  };
  const href = (p: number) => {
    const sp = new URLSearchParams();
    if (event !== "all") sp.set("event", event);
    if (range !== "all") sp.set("range", range);
    if (actor) sp.set("actor", actor);
    if (target) sp.set("target", target);
    if (p > 1) sp.set("page", String(p));
    const s = sp.toString();
    return s ? `/audit?${s}` : "/audit";
  };
  return (
    <>
      <PageHead title="审计日志" sub="持久、追加写、保留一年；仅平台超管可读。密码、令牌与验证码永不记录。" />
      <section className="summary-band" aria-label="审计概览">
        <div>
          <div className="summary-title">{count.total} 条事件</div>
          <div className="summary-sub">只读、追加写；到期按 365 天窗口清理。当前条件：{event === "all" ? "全部事件" : AUDIT_EVENT_LABEL[event]} · {AUDIT_RANGES.find(([v]) => v === range)?.[1]}{actor ? ` · 操作者「${actor}」` : ""}{target ? ` · 对象「${target}」` : ""}</div>
        </div>
        <div className="summary-metrics">
          <div className="summary-metric"><span>{count.total}</span><small>事件</small></div>
          <div className="summary-metric"><span>{count.notSucceeded}</span><small>失败 / 拒绝</small></div>
        </div>
      </section>
      <AuditFilters event={event} range={range} actor={actor} target={target} events={AUDIT_EVENT_OPTIONS.map((e) => [e, AUDIT_EVENT_LABEL[e] ?? e])} />
      <div className="result-bar"><span>共 <strong>{count.total}</strong> 条</span><span className="hint">密码、令牌与验证码不记录。</span></div>
      {rows.length === 0 ? (
        <EmptyState title="该时间段无记录" text="换一个事件或时间范围试试。审计保留一年，更早的记录不可查。" />
      ) : (
        <>
          <div className="table-wrap audit-table">
            <table>
              <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>原因</th><th>范围摘要</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.auditId}>
                    <td className="num nowrap">{fmtTime(a.occurredAt)}</td>
                    <td className="nowrap"><div className="cell-main">{a.actorName}</div>{a.actorKind === "service" ? <div className="cell-sub">系统任务</div> : null}</td>
                    <td className="nowrap">{AUDIT_EVENT_LABEL[a.eventType] ?? a.eventType}</td>
                    <td>{a.targetName ?? "—"}</td>
                    <td className="nowrap">{a.outcome === "succeeded" ? <Badge tone="green">成功</Badge> : <Badge tone="red">{a.outcome === "denied" ? "拒绝" : "失败"}</Badge>}</td>
                    <td><div className="reason-text">{AUDIT_REASON_LABEL[a.reasonCode] ?? a.reasonCode}</div><div className="reason-code">{a.reasonCode}</div></td>
                    <td>{scopeText(a.scopeSummary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <div className="result-bar" style={{ marginTop: 12 }}>
              <span>第 <strong>{page}</strong> / {pages} 页</span>
              <span style={{ display: "flex", gap: 8 }}>
                {page > 1 ? <Link className="btn btn-sm" href={href(page - 1)}>上一页</Link> : <button type="button" className="btn btn-sm" disabled>上一页</button>}
                {page < pages ? <Link className="btn btn-sm" href={href(page + 1)}>下一页</Link> : <button type="button" className="btn btn-sm" disabled>下一页</button>}
              </span>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
