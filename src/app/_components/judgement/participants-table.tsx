"use client";
// 参与专员表 + 证据抽屉（执行记录详情）。点一位专员看逐层结果；点一条内容看证据。
// 证据自包含：只有条件、分数、模型版本与稳定原因码，不含内容正文与评论原文（design §15.5）。
import { useEffect, useState } from "react";
import type { ParticipantRow, StaffContentRow } from "../../../modules/judgement/views";
import { loadContentEvidence, loadStaffEvidence, type ContentEvidence, type StaffEvidence } from "../../_actions/judgement";
import { ABILITY_LABEL, TARGET_LABEL, reasonLabel, resultOf, timeText } from "../../_lib/judgement-labels";
import { n } from "../../_lib/plan-labels";
import { Icon } from "../icon";
import { Badge } from "../ui";

export function Result({ v }: { v: string | null | undefined }) {
  if (!v) return <span className="hint">—</span>; // 没有这类要求：不画灰色徽标
  const r = resultOf(v);
  return <Badge tone={r.tone}>{r.label}</Badge>;
}

export function ParticipantsTable({ runId, rows, canReadContent }: { runId: string; rows: ParticipantRow[]; canReadContent: boolean }) {
  const [staffId, setStaffId] = useState<string | null>(null);
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th style={{ minWidth: 170 }}>专员</th><th className="right">内容</th><th className="right">C1 / C2 / C3</th><th className="right">通过 / 未获取 / 不通过</th><th>内容</th><th>评论</th><th>账号</th><th>总结果</th><th>主要原因</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.staffId} className="clickable" onClick={() => setStaffId(r.staffId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setStaffId(r.staffId)} aria-label={`查看 ${r.name} 的逐层结果`}>
                <td>
                  <div className="cell-main">
                    {r.name} {r.stale ? <span className="tag" title="使用了旧值">旧值</span> : null} {r.syncComplete === false ? <Badge tone="amber">同步缺口</Badge> : null}
                  </div>
                  <div className="cell-sub">{r.store} · {r.branch}</div>
                </td>
                <td className="right num">{r.total === null ? "—" : n(r.total)}{r.total === 0 ? <> <span className="tag">零内容</span></> : null}</td>
                <td className="right num nowrap">{pair(r.c1)} / {pair(r.c2)} / {pair(r.c3)}</td>
                <td className="right num nowrap">{pair(r.p)} / {pair(r.u)} / {pair(r.f)}</td>
                <td className="result-cell"><Result v={r.contentResult} /></td>
                <td className="result-cell"><Result v={r.commentResult} /></td>
                <td className="result-cell"><Result v={r.accountResult} /></td>
                <td className="result-cell"><Result v={r.planResult} /></td>
                <td className="hint">{reasonLabel(r.primaryReason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {staffId ? <EvidenceDrawer runId={runId} staffId={staffId} canReadContent={canReadContent} onClose={() => setStaffId(null)} /> : null}
    </>
  );
}
const pair = (v: number | null): string => (v === null ? "—" : n(v));

function EvidenceDrawer({ runId, staffId, canReadContent, onClose }: { runId: string; staffId: string; canReadContent: boolean; onClose: () => void }) {
  const [data, setData] = useState<StaffEvidence | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    loadStaffEvidence(runId, staffId)
      .then((r) => live && (r.ok ? setData(r.data) : setError(r)))
      .catch(() => live && setError({ code: "network_error", message: "请求没有完成，请检查网络后重试" }));
    return () => {
      live = false;
    };
  }, [runId, staffId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const p = data?.participant;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="专员逐层结果" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <div className="drawer-title">{p?.name ?? "专员逐层结果"}</div>
            {p ? <div className="card-sub">{p.store} · {p.branch}</div> : null}
            {p ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                <span className="tag">内容</span><Result v={p.contentResult} />
                <span className="tag">评论</span><Result v={p.commentResult} />
                <span className="tag">账号</span><Result v={p.accountResult} />
                <span className="tag">总结果</span><Result v={p.planResult} />
              </div>
            ) : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>
        </div>
        <div className="drawer-body">
          {error ? <div className="callout danger" role="alert"><Icon name="alert" /><span>{error.message}（错误码 {error.code}）</span></div> : null}
          {!data && !error ? <p className="hint" role="status">加载中…</p> : null}
          {p ? (
            <>
              {p.syncComplete === false ? <div className="callout warn" style={{ marginBottom: 12 }}><Icon name="alert" /><span>窗口内同步不完整，可能有内容没被采到：这位专员的「不达标」可能是误判，缺失的内容本来可能让他达标。</span></div> : null}
              <div className="stat-grid" style={{ marginBottom: 14 }}>
                <div className="stat"><div className="stat-label">参与内容</div><div className="stat-value">{pair(p.total)}</div><div className="stat-hint">{p.total === 0 ? "零内容" : "窗口内、形态符合"}</div></div>
                <div className="stat"><div className="stat-label">通过 / 未获取 / 不通过</div><div className="stat-value">{pair(p.p)} / {pair(p.u)} / {pair(p.f)}</div></div>
                <div className="stat"><div className="stat-label">C1 / C2 / C3</div><div className="stat-value">{pair(p.c1)} / {pair(p.c2)} / {pair(p.c3)}</div><div className="stat-hint">各层通过条数</div></div>
                <div className="stat"><div className="stat-label">主要原因</div><div className="stat-value" style={{ fontSize: 15 }}>{reasonLabel(p.primaryReason)}</div></div>
              </div>
              {p.total === 0 ? (
                <div className="empty-card">
                  <h3>零内容</h3>
                  <p>{p.syncComplete === false ? "窗口内同步失败或有缺口：判未获取成功，不能把采集失败当成没发。" : "窗口内同步完整且无缺口：判不达标（确实没发）。"}</p>
                </div>
              ) : !canReadContent ? (
                <p className="hint">你没有查看内容级证据的权限（需要「内容读取」），只能看到专员级结果。</p>
              ) : data.pruned ? (
                <p className="hint">这次执行的内容级结果已按保留期清理；参与专员与汇总仍长期保留。</p>
              ) : data.contents ? (
                <div className="card">
                  <div className="card-head"><div><div className="card-title">内容逐层结果</div><div className="card-sub">点一行看证据；不显示内容正文与评论原文{data.truncated ? " · 只显示前 200 条" : ""}</div></div></div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>内容</th><th>L1</th><th>L2</th><th>L3</th><th>最终</th><th>原因</th></tr></thead>
                      <tbody>
                        {data.contents.map((c) => (
                          <ContentLines key={c.contentId} runId={runId} c={c} open={open === c.contentId} onToggle={() => setOpen(open === c.contentId ? null : c.contentId)} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ContentLines({ runId, c, open, onToggle }: { runId: string; c: StaffContentRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="clickable" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onToggle()} aria-expanded={open}>
        <td><div className="cell-main mono">#{c.contentId}</div><div className="cell-sub">{timeText(c.publishedAt)}{c.stale ? " · 旧值" : ""}</div></td>
        <td><Result v={c.l1} /></td>
        <td><Result v={c.l2} /></td>
        <td><Result v={c.l3} /></td>
        <td><Result v={c.final} /></td>
        <td className="hint">{reasonLabel(c.reason)}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6} style={{ background: "var(--surface-sunken)" }}>
            <Evidence runId={runId} contentId={c.contentId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Evidence({ runId, contentId }: { runId: string; contentId: string }) {
  const [data, setData] = useState<ContentEvidence | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    loadContentEvidence(runId, contentId)
      .then((r) => live && (r.ok ? setData(r.data) : setError(r)))
      .catch(() => live && setError({ code: "network_error", message: "请求没有完成，请检查网络后重试" }));
    return () => {
      live = false;
    };
  }, [runId, contentId]);
  if (error) return <div className="callout danger" role="alert"><Icon name="alert" /><span>{error.message}（错误码 {error.code}）</span></div>;
  if (!data) return <p className="hint" role="status">加载证据…</p>;
  return (
    <div style={{ padding: "8px 4px" }}>
      {data.steps
        .filter((s) => s.layer >= 1)
        .map((s) => (
          <div key={s.layer} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong>{s.name}</strong>
              <Result v={s.result} />
              {s.selection ? <span className="hint">{s.selection.selected ? `按点赞排第 ${s.selection.rank ?? "—"}，进入下一层` : `按点赞排第 ${s.selection.rank ?? "—"}，未进入前 N 条`}</span> : null}
            </div>
            <StepEvidence layer={s.layer} evidence={s.evidence} />
          </div>
        ))}
      <p className="hint">
        {data.stoppedAt === null ? "走完了全部已配置的层。" : `在第 ${data.stoppedAt} 层停止：${reasonLabel(data.stopReason)}。`} 证据自包含，原始结果被清理后仍可解释。
      </p>
    </div>
  );
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
function StepEvidence({ layer, evidence }: { layer: number; evidence: unknown }) {
  if (evidence === null || evidence === undefined) return <p className="hint">这一层没有证据（未进入或未配置）。</p>;
  if (layer === 1 && Array.isArray(evidence)) {
    return (
      <div className="kw-list" style={{ marginTop: 6 }}>
        {evidence.filter(isRec).map((e, i) => {
          const hit = e.hit;
          const detail = Array.isArray(hit) ? `命中：${hit.map(String).join("、")}` : typeof hit === "boolean" ? (hit ? "命中" : "未命中") : e.seconds !== undefined ? `时长 ${String(e.seconds)} 秒` : "";
          return <span key={i} className="kw" style={{ paddingRight: 9 }}>条件 {Number(e.idx ?? i) + 1}：{resultOf(String(e.state)).label}{detail ? ` · ${detail}` : ""}{e.reason ? ` · ${reasonLabel(String(e.reason))}` : ""}</span>;
        })}
      </div>
    );
  }
  if (layer === 2 && isRec(evidence) && Array.isArray(evidence.abilities)) {
    return (
      <div className="evidence-grid" style={{ marginTop: 6 }}>
        {evidence.abilities.filter(isRec).map((a, i) => (
          <div key={i} className="evidence-box">
            <div className="t">{TARGET_LABEL[String(a.target)] ?? String(a.target)} · {ABILITY_LABEL[String(a.kind)] ?? String(a.kind)}</div>
            <div className="n">{a.score !== undefined ? String(a.score) : resultOf(String(a.state)).label}</div>
            <div className="hint">{resultOf(String(a.state)).label}{a.reason ? ` · ${reasonLabel(String(a.reason))}` : ""}</div>
          </div>
        ))}
      </div>
    );
  }
  if (layer === 3 && isRec(evidence)) {
    return (
      <div className="hint" style={{ marginTop: 6 }}>
        判定：{evidence.verdict === "meets" ? "符合" : evidence.verdict === "not_meets" ? "不符合" : resultOf(String(evidence.state)).label}
        {evidence.model ? ` · 模型 ${String(evidence.model)}` : ""}
        {evidence.promptVersion !== undefined ? ` · 提示词版本 ${String(evidence.promptVersion)}` : ""}
      </div>
    );
  }
  return <p className="hint">这一层的证据格式暂不支持显示（已保留原始证据）。</p>;
}
