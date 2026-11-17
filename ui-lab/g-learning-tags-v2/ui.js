// 学习平台原型共享 UI：图标、徽标、外壳、状态块。只用于 ui-lab。

import { state } from "./store.js";
import { ROLES } from "./data.js";

const ICON_PATHS = {
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 9h18"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0M8 11h8M8 15h5"/>',
  chart: '<path d="M4 19V5M4 19h16"/><path d="M7 15l3-4 3 2 4-6"/>',
  activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 0-2 2V5z"/><path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 1 2 2V5z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.38.36.72.66 1 .3.28.67.42 1.05.4H21a2 2 0 1 1 0 4h-.09c-.38-.02-.75.12-1.05.4-.3.28-.52.62-.66 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M8 5l12 7-12 7V5z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
  filter: '<path d="M4 5h16l-6 7v5l-4 2v-7L4 5z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sparkles: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  external: '<path d="M15 3h6v6M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v11h14V10"/><path d="M9 21v-7h6v7"/>',
  package: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.7l6.8-4.4M8.6 13.3l6.8 4.4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  layers: '<path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M9 12h6"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-6 6"/>',
};

export function icon(name, cls = "") {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ICON_PATHS.dot}</svg>`;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function badge(label, tone = "plain") {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

export function roleBadge(role) {
  return `<span class="tag role-tag">${esc(ROLES[role]?.label ?? role)}</span>`;
}

const NAV_GROUPS = [
  {
    label: "工作台",
    items: [
      { key: "plans", label: "活动计划", icon: "calendar", roles: ["platform_admin", "hq_manager", "branch_manager"] },
      { key: "judgement", label: "判定计划", icon: "clipboard", roles: ["platform_admin", "hq_manager", "branch_manager"] },
      { key: "reports", label: "报表与看板", icon: "chart", roles: ["platform_admin", "hq_manager", "branch_manager"] },
    ],
  },
  {
    label: "数据",
    items: [
      { key: "accounts", label: "账号与监控", icon: "activity", roles: ["platform_admin", "hq_manager", "branch_manager"] },
      { key: "master", label: "主数据", icon: "database", roles: ["platform_admin", "hq_manager"] },
      { key: "learning", label: "学习", icon: "book", roles: ["platform_admin", "hq_manager", "branch_manager", "store_staff"] },
    ],
  },
  {
    label: "管理",
    items: [
      { key: "users", label: "用户与权限", icon: "users", roles: ["platform_admin", "hq_manager", "branch_manager"] },
      { key: "system", label: "系统", icon: "settings", roles: ["platform_admin"] },
    ],
  },
];

function navGroupsFor(role) {
  if (role === "store_staff") {
    return [{
      label: "门店端",
      items: [
        { key: "learning", label: "学习", icon: "book", roles: ["store_staff"] },
        { key: "store", label: "我的考核", icon: "clipboard", roles: ["store_staff"] },
      ],
    }];
  }
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(role)) })).filter((g) => g.items.length);
}

function scopeLabel(role) {
  if (role === "platform_admin") return "全部品牌";
  if (role === "hq_manager") return "日立、海信";
  if (role === "branch_manager") return "日立 · 北京分公司";
  return "本人";
}

function userName(role) {
  if (role === "platform_admin") return "刘学奎";
  if (role === "hq_manager") return "王敏";
  if (role === "branch_manager") return "李强";
  return "张三";
}

// Echo 标记：一个声源点 + 三条向右上扩散的弧。只在原型里用。
export function echoMark(size = 22) {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="13" y="16" width="28" height="6.6" rx="3.3" fill="currentColor"/><rect x="13" y="28.7" width="20" height="6.6" rx="3.3" fill="currentColor"/><rect x="13" y="41.4" width="28" height="6.6" rx="3.3" fill="currentColor"/><circle cx="49" cy="32" r="4.6" fill="currentColor"/></svg>`;
}

export function renderShell({ activeNav, breadcrumb, content }) {
  return `
    <div class="shell" data-role="${esc(state.role)}">
      ${renderSidebar(activeNav)}
      <div class="main">
        ${renderTopbar(breadcrumb)}
        <main class="page">${content}</main>
      </div>
    </div>
    ${renderMobileTabs(activeNav)}
    ${renderDemoPanel()}
  `;
}

function renderSidebar(activeNav) {
  return `
    <aside class="sidebar" aria-label="主导航">
      <div class="brand-block">
        <div class="brand-mark">${echoMark(18)}</div>
        <div>
          <div class="brand-name">Echo</div>
          <div class="brand-sub">新媒体营销平台</div>
        </div>
      </div>
      ${navGroupsFor(state.role).map((group) => `
        <nav class="nav-group" aria-label="${esc(group.label)}">
          <div class="nav-label">${esc(group.label)}</div>
          ${group.items.map((item) => `
            <a class="nav-item ${activeNav === item.key ? "active" : ""}" href="#/${item.key}">
              ${icon(item.icon)}
              <span>${esc(item.label)}</span>
            </a>
          `).join("")}
        </nav>
      `).join("")}
      <div class="sidebar-foot">
        <div class="scope-box">
          <div class="scope-label">可检索品牌</div>
          <div class="scope-value"><span class="dot"></span>${esc(scopeLabel(state.role))}</div>
        </div>
        <div class="user-card">
          <div class="avatar">${esc(userName(state.role).slice(0, 1))}</div>
          <div>
            <div class="user-name">${esc(userName(state.role))}</div>
            <div class="user-role">${esc(ROLES[state.role]?.label ?? "")} · ${esc(scopeLabel(state.role))}</div>
          </div>
        </div>
      </div>
    </aside>
  `;
}

function renderTopbar(breadcrumb) {
  return `
    <header class="topbar">
      <div class="crumbs">
        <span>工作区</span><span>/</span><span class="crumb-current">${esc(breadcrumb.at(-1) ?? "学习")}</span>
      </div>
      <label class="top-search">
        ${icon("search")}
        <input type="search" placeholder="搜索课程、计划、账号" aria-label="全局搜索" />
        <span class="kbd">⌘K</span>
      </label>
      <div class="top-actions">
        <span class="brand-pill"><span class="dot"></span>${state.role === "platform_admin" ? "全部品牌" : state.role === "hq_manager" ? "日立、海信" : "日立"}</span>
        <button type="button" class="icon-btn" data-action="notify" aria-label="通知">${icon("bell")}<span class="red-dot"></span></button>
        <button type="button" class="avatar" data-action="account-menu" aria-label="账号菜单">${esc(userName(state.role).slice(0, 1))}</button>
      </div>
    </header>
  `;
}

function renderMobileTabs(activeNav) {
  const tabs = state.role === "store_staff"
    ? [["learning", "学习", "book"], ["store", "我的考核", "clipboard"]]
    : [["learning", "学习", "book"], ["plans", "计划", "calendar"], ["accounts", "账号", "activity"], ["more", "更多", "more"]];
  return `
    <nav class="mobile-tabs" aria-label="手机导航">
      ${tabs.map(([key, label, ico]) => `
        <a class="mobile-tab ${activeNav === key ? "active" : ""}" href="#/${key}">
          ${icon(ico)}<span>${esc(label)}</span>
        </a>
      `).join("")}
    </nav>
  `;
}

export function renderDemoPanel() {
  return `
    <button type="button" class="demo-fab" data-action="toggle-demo">${icon("sliders")} 原型控制</button>
    ${state.demoOpen ? `
      <div class="demo-panel" role="dialog" aria-label="原型控制">
        <div class="demo-title"><span>原型控制</span><button type="button" class="icon-btn" data-action="toggle-demo" aria-label="关闭">×</button></div>
        <p class="demo-sub">切换角色与页面状态，检查可见范围、权限与状态矩阵。不是产品界面。</p>
        <div class="demo-grid">
          <label class="demo-field">当前角色
            <select data-demo-role>
              <option value="platform_admin" ${state.role === "platform_admin" ? "selected" : ""}>平台超管</option>
              <option value="hq_manager" ${state.role === "hq_manager" ? "selected" : ""}>总部人员</option>
              <option value="branch_manager" ${state.role === "branch_manager" ? "selected" : ""}>分公司人员</option>
              <option value="store_staff" ${state.role === "store_staff" ? "selected" : ""}>门店专员</option>
            </select>
          </label>
          <label class="demo-field">页面状态
            <select data-demo-state>
              <option value="normal" ${state.demoState === "normal" ? "selected" : ""}>正常</option>
              <option value="empty" ${state.demoState === "empty" ? "selected" : ""}>空</option>
              <option value="loading" ${state.demoState === "loading" ? "selected" : ""}>加载中</option>
              <option value="denied" ${state.demoState === "denied" ? "selected" : ""}>无权限</option>
              <option value="error" ${state.demoState === "error" ? "selected" : ""}>错误</option>
              <option value="processing" ${state.demoState === "processing" ? "selected" : ""}>处理中</option>
              <option value="expired" ${state.demoState === "expired" ? "selected" : ""}>已过期</option>
            </select>
          </label>
        </div>
        <div class="demo-links">
          <a class="demo-link" href="#/learning">学习中心</a>
          <a class="demo-link" href="#/learning/course/c1">视频课程</a>
          <a class="demo-link" href="#/learning/course/c3">资料课程</a>
          <a class="demo-link" href="#/learning/manage">课程管理</a>
          <a class="demo-link" href="#/learning/new">新建课程</a>
          <a class="demo-link" href="#/learning/summary">学习汇总</a>
          <a class="demo-link" href="#/learning/tags">标签管理</a>
        </div>
        <div class="demo-note">业务规则来自 g-learning-min spec；视觉沿用 2026-11-10 确认的 v2 基线。页面代码尚未开始。</div>
      </div>
    ` : ""}
  `;
}

// 手机端把筛选折叠到按钮后面；桌面端该按钮不显示。
export function filterToggle(count) {
  return `
    <button type="button" class="btn btn-sm filter-toggle" data-action="toggle-filters" aria-expanded="${state.filtersOpen}">
      ${icon("filter")} 筛选${count ? ` · ${count}` : ""}
    </button>
  `;
}

export function skeletonList(rows = 5) {
  return `
    <div class="card card-pad" aria-busy="true" aria-label="加载中">
      ${Array.from({ length: rows }).map(() => `
        <div class="skeleton skeleton-line" style="width:${60 + Math.random() * 30}%"></div>
      `).join("")}
      <div class="skeleton skeleton-block" style="margin-top:14px"></div>
    </div>
  `;
}

export function emptyState({ title = "暂无数据", text = "当前条件下没有结果。", action = "" } = {}) {
  return `
    <div class="card">
      <div class="state">
        <div class="state-icon">${icon("file")}</div>
        <div class="state-title">${esc(title)}</div>
        <p class="state-text">${esc(text)}</p>
        ${action}
      </div>
    </div>
  `;
}

export function deniedState(text = "当前角色没有这个页面的访问权限，或对象不在你的数据范围内。请联系平台管理员开通。") {
  return `
    <div class="card">
      <div class="state">
        <div class="state-icon">${icon("shield")}</div>
        <div class="state-title">无权访问</div>
        <p class="state-text">${esc(text)}</p>
        <a class="btn" href="#/learning">回到学习中心</a>
      </div>
    </div>
  `;
}

export function errorState() {
  return `
    <div class="card">
      <div class="state">
        <div class="state-icon">${icon("alert")}</div>
        <div class="state-title">加载失败</div>
        <p class="state-text">请求没有完成。请重试；如果持续失败，把错误码和 request_id 交给管理员。</p>
        <button type="button" class="btn" data-action="retry">${icon("refresh")} 重试</button>
      </div>
    </div>
  `;
}

export function expiredState() {
  return `
    <div class="card">
      <div class="state">
        <div class="state-icon">${icon("clock")}</div>
        <div class="state-title">页面已过期</div>
        <p class="state-text">数据已超过当前会话的有效窗口，或课程已被下架。刷新后再试。</p>
        <button type="button" class="btn" data-action="retry">${icon("refresh")} 刷新</button>
      </div>
    </div>
  `;
}

export function processingBanner(text = "正在处理，请稍候；离开页面不会中断后台任务。") {
  return `<div class="callout warn" style="margin-bottom:14px">${icon("clock")}<span>${esc(text)}</span></div>`;
}

export function stateAware(content, { empty, loading, denied, error, expired, processing } = {}) {
  if (state.demoState === "loading") return loading ?? skeletonList();
  if (state.demoState === "empty") return empty ?? emptyState();
  if (state.demoState === "denied") return denied ?? deniedState();
  if (state.demoState === "error") return error ?? errorState();
  if (state.demoState === "expired") return expired ?? expiredState();
  return `${state.demoState === "processing" ? (processing ?? processingBanner()) : ""}${content}`;
}

export function dataCell(main, sub = "") {
  return `<div class="cell-main">${esc(main)}</div>${sub ? `<div class="cell-sub">${sub}</div>` : ""}`;
}

export function avatarFor(name) {
  return `<span class="avatar" style="width:30px;height:30px;flex-basis:30px;font-size:11px">${esc(String(name ?? "?").slice(0, 1))}</span>`;
}

export function timeCell(value) {
  return `<span class="num" style="font-size:11px;color:var(--ink-3)">${esc(value)}</span>`;
}
/* ---------- 悬停下拉筛选（借鉴 hbdam 素材库）：悬停/聚焦展开，移开收起；触屏点击固定展开 ---------- */

function hfBox(on) {
  return `<span class="hf-box">${on ? icon("check") : ""}</span>`;
}

/** options: [{value,label}]；mode: multi 复选 / single 单选（再点一次取消）；set 用于单选时限定同组取值。 */
export function hoverFilter({ id, label, options, selected, key, mode = "multi", align = "", set = null }) {
  const picked = options.filter((o) => selected.includes(o.value));
  const n = picked.length;
  const btnText = mode === "single" && n ? `${label} · ${picked[0].label}` : label;
  const groupAttr = set ? ` data-set="${esc(set.join("|"))}"` : "";
  return `
    <div class="hf ${align} ${state.openPanel === id ? "pinned" : ""}" data-hf-id="${esc(id)}">
      <button type="button" class="hf-btn ${n ? "on" : ""}" data-action="hf-pin" data-id="${esc(id)}" aria-haspopup="true" aria-expanded="${state.openPanel === id}">
        <span>${esc(btnText)}</span>${mode === "multi" && n ? `<span class="hf-count">${n}</span>` : ""}${icon("chevron")}
      </button>
      <div class="hf-pop"><div class="hf-panel" role="group" aria-label="${esc(label)}">
        <div class="hf-list">
          ${options.map((o) => {
            const on = selected.includes(o.value);
            return `<button type="button" class="hf-opt ${mode === "single" ? "radio" : ""} ${on ? "on" : ""}" role="${mode === "single" ? "radio" : "checkbox"}" aria-checked="${on}" data-action="hf-toggle" data-key="${esc(key)}" data-mode="${mode}" data-value="${esc(o.value)}"${groupAttr}>${hfBox(on)}<span>${esc(o.label)}</span></button>`;
          }).join("")}
        </div>
        <div class="hf-foot"><span>移开鼠标收起</span>${n ? `<button type="button" class="hf-clear" data-action="hf-clear" data-key="${esc(key)}" data-set="${esc(options.map((o) => o.value).join("|"))}">清空</button>` : ""}</div>
      </div></div>
    </div>`;
}

/** 两栏标签选择：左一级、右二级复选。选中项由 data-action="toggle-tag" 接管。 */
export function tagPicker({ id, categories, selected }) {
  const activeId = state.tagPane?.[id] ?? categories[0]?.id;
  const count = (cat) => cat.tags.filter((t) => selected.includes(t)).length;
  const total = selected.length;
  return `
    <div class="hf ${state.openPanel === id ? "pinned" : ""}" data-hf-id="${esc(id)}">
      <button type="button" class="hf-btn ${total ? "on" : ""}" data-action="hf-pin" data-id="${esc(id)}" aria-haspopup="true" aria-expanded="${state.openPanel === id}">
        ${icon("tag")}<span>选择标签</span>${total ? `<span class="hf-count">${total}</span>` : ""}${icon("chevron")}
      </button>
      <div class="hf-pop"><div class="hf-panel tp-panel" role="group" aria-label="选择标签">
        <div class="tp-levels">
          ${categories.map((c) => `<button type="button" class="tp-level ${c.id === activeId ? "on" : ""}" data-pane-picker="${esc(id)}" data-pane-level="${esc(c.id)}"><span>${esc(c.name)}</span>${count(c) ? `<span class="hf-count">${count(c)}</span>` : ""}</button>`).join("")}
        </div>
        ${categories.map((c) => `
          <div class="tp-pane ${c.id === activeId ? "on" : ""}" data-pane-picker="${esc(id)}" data-pane-of="${esc(c.id)}">
            ${c.tags.length ? `<div class="hf-list">${c.tags.map((t) => {
              const on = selected.includes(t);
              return `<button type="button" class="hf-opt ${on ? "on" : ""}" role="checkbox" aria-checked="${on}" data-action="toggle-tag" data-tag="${esc(t)}">${hfBox(on)}<span>${esc(t)}</span></button>`;
            }).join("")}</div>` : `<p class="hint" style="padding:8px">这个一级标签下还没有二级标签。</p>`}
          </div>`).join("")}
        <div class="tp-foot"><span>移开鼠标收起</span><span>已选 ${total}</span></div>
      </div></div>
    </div>`;
}
