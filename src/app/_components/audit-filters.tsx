"use client";
// 审计筛选：表格上方一行（事件 / 时间两个下拉 + 说明），选择即生效，条件进 URL 可分享（ui-foundation §4.1）。
import { useRouter } from "next/navigation";
import { AUDIT_RANGES } from "../_lib/labels";

export function AuditFilters({ event, range, events }: { event: string; range: string; events: Array<[string, string]> }) {
  const router = useRouter();
  const go = (patch: { event?: string; range?: string }) => {
    const sp = new URLSearchParams();
    const next = { event, range, ...patch };
    if (next.event !== "all") sp.set("event", next.event);
    if (next.range !== "all") sp.set("range", next.range);
    const s = sp.toString();
    router.push(s ? `/audit?${s}` : "/audit");
  };
  return (
    <div className="filter-bar" aria-label="审计筛选">
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
      <span className="filter-note">按时间倒序；只显示你有权读取的事件。</span>
    </div>
  );
}
