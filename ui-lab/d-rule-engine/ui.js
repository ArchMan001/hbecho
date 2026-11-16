// 判定计划原型 · 视图小工具
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function badge(label, tone = "plain") {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

export function resultBadge(result) {
  const map = { success: ["成功", "green"], not_met: ["不达标", "red"], unobtained: ["未获取成功", "gray"], pass: ["通过", "green"], fail: ["不通过", "red"], skipped: ["跳过", "plain"], not_configured: ["未配置", "plain"] };
  const [label, tone] = map[result] ?? [result || "—", "plain"];
  return badge(label, tone);
}

export function statusBadge(execution) {
  const tone = { completed: "green", waiting: "amber", running: "blue", planned: "plain", failed: "red", cancelled: "gray" }[execution.status] ?? "plain";
  return badge(execution.statusLabel, tone);
}

export function waitingLabel(execution) {
  if (execution.status !== "waiting") return null;
  return execution.waitingOn === "demand" ? "等待采集" : execution.waitingOn === "signals" ? "等待识别" : "处理中";
}

const PATHS = {
  calendar: "M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  clipboard: "M9 4h6v3H9zM7 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M8 12h8M8 16h5",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  activity: "M3 12h4l2-6 4 12 2-6h6",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  book: "M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5Zm2 0v14M8 7h8M8 11h6",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z",
  plus: "M12 5v14M5 12h14",
  chevronRight: "m9 6 6 6-6 6",
  chevronLeft: "m15 6-6 6 6 6",
  chevronDown: "m6 9 6 6 6-6",
  upload: "M12 16V4m0 0 4 4m-4-4L8 8M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  download: "M12 4v12m0 0 4-4m-4 4-4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1",
  play: "M8 5v14l11-7-11-7Z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  archive: "M4 7h16v13H4V7Zm-1-3h18v3H3V4Zm6 7h6",
  arrowLeft: "M19 12H5m0 0 6-6m-6 6 6 6",
  info: "M12 11v5M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  warn: "M12 9v4M12 17h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  x: "M18 6 6 18M6 6l12 12",
  check: "m5 12 4 4L19 6",
  clock: "M12 7v5l3 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  search: "m21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  filter: "M4 5h16M7 12h10M10 19h4",
  external: "M14 4h6v6M20 4l-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 17l9 5 9-5",
  target: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  image: "M4 5h16v14H4V5Zm3 3h.01M4 16l5-5 4 4 2-2 5 5",
  file: "M6 3h8l4 4v14H6V3Zm8 0v5h4M9 13h6M9 17h6",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  store: "M4 9h16v11H4V9Zm-1-4h18l-2 4H5L3 5Zm6 8h6",
};

export function icon(name, size = 16) {
  const d = PATHS[name] ?? PATHS.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

export const NAV_GROUPS = [
  { label: "工作台", items: [
    { key: "plans", label: "活动计划", icon: "calendar" },
    { key: "judgement", label: "判定计划", icon: "clipboard" },
    { key: "reports", label: "报表与看板", icon: "chart" },
  ] },
  { label: "数据", items: [
    { key: "accounts", label: "账号与监控", icon: "activity" },
    { key: "master", label: "主数据", icon: "database" },
    { key: "learning", label: "学习", icon: "book" },
  ] },
  { label: "管理", items: [
    { key: "users", label: "用户与权限", icon: "users" },
    { key: "system", label: "系统", icon: "settings" },
  ] },
];

export function navFor(role) {
  if (role === "store_staff") return [{ label: "门店端", items: [{ key: "store", label: "我的考核", icon: "clipboard" }] }];
  return NAV_GROUPS;
}

export function methodLabel(method) {
  if (!method) return "—";
  if (method.type === "at_least_n") return `至少 ${method.n} 条`;
  if (method.type === "all") return "全部通过";
  if (method.type === "any") return "任一条通过";
  if (method.type === "ratio") return `比例 ≥ ${(method.bp / 100).toFixed(0)}%`;
  return "—";
}

export function pct(a, b) {
  if (!b) return "0%";
  return `${Math.round((a / b) * 100)}%`;
}