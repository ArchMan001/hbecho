"use client";
// 审计筛选：表格上方一行。事件 / 时间两个下拉选择即生效；操作者 / 对象输入姓名或 11 位手机号，回车或点「查询」生效。
// 条件都进 URL，可分享、可后退（ui-foundation §4.1）。
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AUDIT_RANGES } from "../_lib/labels";

export function AuditFilters({ event, range, actor, target, events }: { event: string; range: string; actor: string; target: string; events: Array<[string, string]> }) {
  const router = useRouter();
  const [actorText, setActorText] = useState(actor);
  const [targetText, setTargetText] = useState(target);
  const go = (patch: { event?: string; range?: string; actor?: string; target?: string }) => {
    const next = { event, range, actor: actorText, target: targetText, ...patch };
    const sp = new URLSearchParams();
    if (next.event !== "all") sp.set("event", next.event);
    if (next.range !== "all") sp.set("range", next.range);
    if (next.actor.trim()) sp.set("actor", next.actor.trim());
    if (next.target.trim()) sp.set("target", next.target.trim());
    const s = sp.toString();
    router.push(s ? `/audit?${s}` : "/audit");
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go({});
  };
  return (
    <form className="filter-bar" aria-label="审计筛选" onSubmit={submit}>
      <label className="filter-select">
        <span>事件</span>
        <select value={event} onChange={(e) => go({ event: e.target.value })}>
          <option value="all">全部事件</option>
          {events.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="filter-select">
        <span>时间</span>
        <select value={range} onChange={(e) => go({ range: e.target.value })}>
          {AUDIT_RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="filter-select">
        <span>操作者</span>
        <input className="input" style={{ minHeight: 34, width: 150 }} placeholder="姓名或手机号" value={actorText} maxLength={50} onChange={(e) => setActorText(e.target.value)} />
      </label>
      <label className="filter-select">
        <span>对象</span>
        <input className="input" style={{ minHeight: 34, width: 150 }} placeholder="姓名或手机号" value={targetText} maxLength={50} onChange={(e) => setTargetText(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-sm">查询</button>
      {actor || target ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setActorText(""); setTargetText(""); go({ actor: "", target: "" }); }}>清除操作者 / 对象</button> : null}
      <span className="filter-note">按时间倒序；只显示你有权读取的事件。</span>
    </form>
  );
}
