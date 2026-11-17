// E 指标与看板原型 · 视图小工具
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function badge(label, tone = "plain") {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

const RESULT_MAP = {
  success: ["成功", "green"],
  not_met: ["不达标", "red"],
  unobtained: ["未获取成功", "gray"],
  pass: ["通过", "green"],
  fail: ["不通过", "red"],
  partial: ["部分覆盖", "amber"],
  no_data: ["—", "plain"],
};

export function resultBadge(result) {
  const [label, tone] = RESULT_MAP[result] ?? [result || "—", "plain"];
  return badge(label, tone);
}

export function resultText(result) {
  return (RESULT_MAP[result] ?? [result || "—"])[0];
}

export function jobStatusBadge(status) {
  const map = {
    queued: ["排队中", "plain"],
    running: ["执行中", "blue"],
    succeeded: ["成功", "green"],
    partial: ["部分成功", "amber"],
    failed: ["失败", "red"],
    expired: ["已过期", "gray"],
    cancelled: ["已取消", "gray"],
  };
  const [label, tone] = map[status] ?? [status, "plain"];
  return badge(label, tone);
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
  download: "M12 4v12m0 0 4-4m-4 4-4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1",
  plus: "M12 5v14M5 12h14",
  chevronRight: "m9 6 6 6-6 6",
  chevronDown: "m6 9 6 6 6-6",
  arrowLeft: "M19 12H5m0 0 6-6m-6 6 6 6",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
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
  file: "M6 3h8l4 4v14H6V3Zm8 0v5h4M9 13h6M9 17h6",
  user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  store: "M4 9h16v11H4V9Zm-1-4h18l-2 4H5L3 5Zm6 8h6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
};

export function icon(name, size = 16) {
  const d = PATHS[name] ?? PATHS.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// E 域主线的导航；其余入口保留为禁用占位，说明模块不在本原型范围
export function navFor(role) {
  if (role === "store_staff") {
    return [
      {
        label: "门店端",
        items: [
          { key: "reports", label: "我的考核", icon: "clipboard" },
          { key: "learning", label: "学习", icon: "book", disabled: true },
        ],
      },
    ];
  }
  const items = [
    { key: "plans", label: "活动计划", icon: "calendar", disabled: true },
    { key: "judgement", label: "判定计划", icon: "target", disabled: true },
    { key: "reports", label: "报表与看板", icon: "chart" },
    { key: "board", label: "计划看板", icon: "layers" },
  ];
  if (role === "platform_admin" || role === "hq_manager" || role === "branch_manager") {
    items.push({ key: "metrics", label: "指标字典", icon: "database", readonly: role === "branch_manager" });
  }
  items.push({ key: "exports", label: "下载中心", icon: "download" });

  return [
    { label: "工作台", items: items.slice(0, 4) },
    { label: "数据与管理", items: items.slice(4) },
  ];
}

export function canExport(role) {
  return role !== "store_staff";
}

export function canManageMetrics(role) {
  return role === "platform_admin" || role === "hq_manager";
}