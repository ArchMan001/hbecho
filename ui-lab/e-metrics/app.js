// E 指标与看板原型 · 路由、页面与交互（2026-11-16）
// 视觉沿用 ui-foundation v2（2026-11-10 基线）；只用于 ui-lab，不进生产构建。
import {
  ROLES, ACTIVITY, SECTORS, PLANS, PLAN_BY_ID, PLANS_BY_SECTOR, PROJECTION,
  REGIONS, BRANCHES, BRANCH_BY_ID, REGION_BY_ID, BRANCH_FLAGS,
  countsFor,
  STAFF, STAFF_BY_ID, staffForPlan, HITS, unobtainedByReason,
  BUILTIN_METRICS, DERIVED_METRICS, CUSTOM_METRICS, EXPORT_JOBS, EXPORT_OBJECTS,
  FORMAT_HELPERS,
} from "./data.js?v=e-metrics-3";
import {
  esc, badge, resultBadge, resultText, jobStatusBadge, icon, navFor,
  canExport, canManageMetrics,
} from "./ui.js?v=e-metrics-3";

const { fmt, pct } = FORMAT_HELPERS;
const clone = (v) => JSON.parse(JSON.stringify(v));

const state = {
  role: "platform_admin",
  demo: "normal",
  route: { view: "reports", params: new URLSearchParams() },
  sector: "home",
  orgFilter: "all",
  sort: { key: "org", dir: 1 },
  expanded: new Set(["r-huabei"]),
  showCustom: false,
  staff: { plan: "jp-home", result: "all", org: "all", platform: "all", page: 1 },
  hits: { plan: "all", org: "all", staff: "all", platform: "all", page: 1 },
  board: { plan: "all", brand: "海信" },
  jobs: clone(EXPORT_JOBS),
  customMetrics: clone(CUSTOM_METRICS),
  exportFilter: "all",
  modal: null,
  drawer: null,
};

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [view, qs] = raw.split("?");
  return { view: view || "reports", params: new URLSearchParams(qs || "") };
}

function syncFromRoute() {
  const route = parseHash();
  state.route = route;
  const p = route.params;
  if (route.view === "reports") {
    if (p.has("sector")) state.sector = p.get("sector");
    state.orgFilter = p.get("org") || "all";
  }
  if (route.view === "staff") {
    state.staff.plan = p.get("plan") || state.staff.plan;
    state.staff.result = p.get("result") || "all";
    state.staff.org = p.get("org") || "all";
    state.staff.platform = p.get("platform") || "all";
    state.staff.page = Number(p.get("page")) || 1;
  }
  if (route.view === "hits") {
    state.hits.plan = p.get("plan") || "all";
    state.hits.org = p.get("org") || "all";
    state.hits.staff = p.get("staff") || "all";
    state.hits.platform = p.get("platform") || "all";
    state.hits.page = Number(p.get("page")) || 1;
  }
  if (route.view === "board") {
    state.board.plan = p.get("plan") || "all";
    state.board.brand = p.get("brand") || "海信";
  }
}

function go(view, params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "" && v !== "all") qs.set(k, v);
  });
  const next = `#/${view}${qs.toString() ? `?${qs}` : ""}`;
  if (location.hash === next) {
    syncFromRoute();
    render();
  } else {
    location.hash = next;
  }
}

// ---------------------------------------------------------------------------
// 范围与通用查询
// ---------------------------------------------------------------------------

function isRestricted() {
  return state.role === "branch_manager";
}

function scopeBranchIds() {
  return isRestricted() ? ["b-bj"] : BRANCHES.map((b) => b.id);
}

function inScope(branchId) {
  return scopeBranchIds().includes(branchId);
}

function myStaff() {
  return STAFF[0]; // 张伟 · 北京分公司 · 朝阳门店（本机演示账号）
}

function staffInSector(branchId, sector, store = null) {
  const planIds = PLANS_BY_SECTOR[sector] ?? [];
  return STAFF.filter(
    (s) =>
      s.branchId === branchId &&
      (!store || s.store === store) &&
      planIds.some((p) => s.plans[p]),
  );
}

function baseOfList(list) {
  if (!list.length) return null;
  return list.reduce(
    (acc, s) => ({
      accountCount: acc.accountCount + s.accountCount,
      followerTotal: acc.followerTotal + s.followerTotal,
      publishedCount: acc.publishedCount + s.publishedCount,
    }),
    { accountCount: 0, followerTotal: 0, publishedCount: 0 },
  );
}

function baseOfBranch(branchId, sector, store = null) {
  return baseOfList(staffInSector(branchId, sector, store));
}

function baseOfRegion(regionId, sector, visibleBranchIds) {
  const region = REGION_BY_ID[regionId];
  const rows = region.branches
    .filter((b) => visibleBranchIds.includes(b.id))
    .map((b) => baseOfBranch(b.id, sector))
    .filter(Boolean);
  if (!rows.length) return null;
  return rows.reduce(
    (acc, r) => ({
      accountCount: acc.accountCount + r.accountCount,
      followerTotal: acc.followerTotal + r.followerTotal,
      publishedCount: acc.publishedCount + r.publishedCount,
    }),
    { accountCount: 0, followerTotal: 0, publishedCount: 0 },
  );
}

function storeCounts(branchId, store, planId) {
  const rows = STAFF.filter((s) => s.branchId === branchId && s.store === store && s.plans[planId]);
  const achieved = rows.filter((s) => s.plans[planId].status === "success").length;
  const unobtained = rows.filter((s) => s.plans[planId].status === "unobtained").length;
  return [rows.length, achieved, unobtained];
}

function compact(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return fmt(n);
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

function shell(content, crumbs, activeKey) {
  const groups = navFor(state.role);
  const nav = groups
    .map(
      (g) => `
      <div class="nav-group">
        <div class="nav-label">${esc(g.label)}</div>
        ${g.items
          .map((i) => {
            const active = i.key === activeKey;
            if (i.disabled) {
              return `<a class="nav-item disabled" href="javascript:void(0)" data-action="toast-module" data-module="${esc(i.label)}" aria-disabled="true">${icon(i.icon, 16)}<span>${esc(i.label)}</span></a>`;
            }
            return `<a class="nav-item ${active ? "active" : ""}" href="#/${i.key}">${icon(i.icon, 16)}<span>${esc(i.label)}</span>${i.readonly ? ' <span class="tag">只读</span>' : ""}</a>`;
          })
          .join("")}
      </div>`,
    )
    .join("");

  return `
  <div class="shell">
    <aside class="sidebar" aria-label="主导航">
      <div class="brand-block">
        <div class="brand-mark">H</div>
        <div><div class="brand-name">hbecho</div><div class="brand-sub">新媒体运营平台</div></div>
      </div>
      ${nav}
      <div class="sidebar-foot">
        <div class="role-box">
          <div class="role-label">原型角色</div>
          <select data-change="set-role" aria-label="切换角色">
            ${Object.entries(ROLES)
              .map(([k, v]) => `<option value="${k}" ${state.role === k ? "selected" : ""}>${esc(v.label)}</option>`)
              .join("")}
          </select>
          <div class="demo-label" style="margin-top:4px">${esc(ROLES[state.role].scope)}</div>
        </div>
        <div class="demo-box">
          <div class="demo-label">演示状态</div>
          <select data-change="set-demo" aria-label="切换演示状态">
            ${[
              ["normal", "正常"],
              ["loading", "加载中"],
              ["empty", "空结果"],
              ["error", "查询失败"],
              ["noaccess", "无权访问"],
              ["processing", "正在重算（显示上一版）"],
              ["stale", "数据过期（stale）"],
            ]
              .map(([k, v]) => `<option value="${k}" ${state.demo === k ? "selected" : ""}>${esc(v)}</option>`)
              .join("")}
          </select>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="crumbs">${crumbTrail(crumbs)}</div>
        <div class="top-actions">
          <span class="brand-pill"><span class="dot"></span>${esc(ACTIVITY.brand)} · 618 家电焕新季</span>
          <span class="tag">${esc(ROLES[state.role].label)}</span>
        </div>
      </header>
      <main class="page">${content}</main>
    </div>
  </div>
  ${state.modal ? renderModal() : ""}
  ${state.drawer ? renderDrawer() : ""}`;
}

function crumbTrail(items) {
  return items
    .map((x, i) =>
      i === items.length - 1
        ? `<b>${esc(x)}</b>`
        : `<span>${esc(x)}</span>${icon("chevronRight", 12)}`,
    )
    .join("");
}

function pageHead(title, sub, actions = "") {
  return `
  <div class="page-head">
    <div>
      <h1 class="page-title">${esc(title)}</h1>
      ${sub ? `<div class="page-sub">${sub}</div>` : ""}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ""}
  </div>`;
}

function notice(kind, title, body = "") {
  const iconName = kind === "warn" ? "warn" : kind === "info" ? "info" : kind === "danger" ? "warn" : "info";
  return `<div class="notice ${kind} stack">${icon(iconName, 16)}<div class="notice-body"><div class="notice-title">${title}</div>${body ? `<div class="notice-sub">${body}</div>` : ""}</div></div>`;
}

function staleBadge() {
  if (state.demo === "stale" || state.demo === "processing") return badge("当前显示上一版", "amber");
  return "";
}

function projectionBanners() {
  if (state.demo === "processing") {
    return notice(
      "warn",
      "正在重算，当前显示上一版",
      `新投影构建中；页面继续提供 ${esc(PROJECTION.projectionId)}（数据截止 ${esc(PROJECTION.cutoffAt)}）。重算完成后刷新即见新数。`,
    );
  }
  if (state.demo === "stale") {
    return notice(
      "warn",
      "当前显示上一版",
      `最近一次重算失败；数据截止 ${esc(PROJECTION.cutoffAt)}，已按上一版继续服务。运营可在系统里查看失败原因。`,
    );
  }
  return "";
}

function demoGate({ loading, emptyTitle, emptyBody, emptyAction, denied = false }) {
  if (state.demo === "noaccess" || denied) return deniedPage();
  if (state.demo === "loading") return loadingState();
  if (state.demo === "empty") return emptyState(emptyTitle, emptyBody, emptyAction);
  if (state.demo === "error") {
    return `<div class="card"><div class="errorstate">
      <div class="empty-icon">${icon("warn", 18)}</div>
      <h3>查询失败</h3>
      <p>报表服务暂时无法返回数据，请稍后重试。如果持续失败，把错误码 <span class="mono">REPORT_QUERY_FAILED</span> 发给运营。</p>
      <button class="btn" data-action="retry">${icon("refresh", 14)}重试</button>
    </div></div>`;
  }
  return null;
}

function deniedPage() {
  return `<div class="card"><div class="empty">
    <div class="empty-icon">${icon("user", 18)}</div>
    <h3>无权访问</h3>
    <p>当前账号没有这个页面的权限。请联系平台管理员开通对应的报表权限。</p>
    <a class="btn" href="#/reports">回到组织点检表</a>
  </div></div>`;
}

function loadingState() {
  return `<div class="card"><div class="skeleton-table">
    ${Array.from({ length: 8 })
      .map(
        () => `<div class="skeleton-row">
        <div class="skeleton skel-line"></div>
        <div class="skeleton skel-line"></div>
        <div class="skeleton skel-line"></div>
        <div class="skeleton skel-line"></div>
      </div>`,
      )
      .join("")}
  </div></div>`;
}

function emptyState(title, body, action = "") {
  return `<div class="card"><div class="empty">
    <div class="empty-icon">${icon("chart", 18)}</div>
    <h3>${esc(title)}</h3>
    <p>${body}</p>
    ${action}
  </div></div>`;
}

// ---------------------------------------------------------------------------
// 组织点检表
// ---------------------------------------------------------------------------

function planGroupsForSector(sector) {
  return (PLANS_BY_SECTOR[sector] ?? []).map((id) => PLAN_BY_ID[id]).filter(Boolean);
}

function nodeBase(node, sector) {
  if (node.type === "region") return baseOfRegion(node.id, sector, node.branchIds);
  if (node.type === "branch") return baseOfBranch(node.id, sector);
  return baseOfBranch(node.branchId, sector, node.store);
}

function nodeCounts(node, planId) {
  if (node.type === "region" || node.branchIds) {
    return node.branchIds.reduce(
      (acc, id) => {
        const c = countsFor(id, planId);
        return [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
      },
      [0, 0, 0],
    );
  }
  if (node.type === "branch") return countsFor(node.id, planId);
  return storeCounts(node.branchId, node.store, planId);
}

function rateOf(counts) {
  return counts[0] ? counts[1] / counts[0] : null;
}

function scopeTotals(planId) {
  return scopeBranchIds().reduce(
    (acc, id) => {
      const c = countsFor(id, planId);
      return [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
    },
    [0, 0, 0],
  );
}

function sortByRate(nodes, planId) {
  const value = (n) => {
    const r = rateOf(nodeCounts(n, planId));
    return r === null ? -1 : r;
  };
  return nodes.sort((a, b) => (value(a) - value(b)) * state.sort.dir);
}

function baseCells(base) {
  if (!base) {
    return `<td class="num cell-muted">未参与</td><td class="num cell-muted">—</td><td class="num cell-muted">—</td>`;
  }
  return `<td class="num">${fmt(base.accountCount)}</td><td class="num">${fmt(base.followerTotal)}</td><td class="num">${fmt(base.publishedCount)}</td>`;
}

function planCells(node, planId) {
  const counts = nodeCounts(node, planId);
  const [p, a, u] = counts;
  if (!p) {
    return `<td class="num cell-muted group-start">未参与</td><td class="num cell-muted">—</td><td class="num cell-muted rate-cell">—</td><td class="num cell-muted">—</td>`;
  }
  const rate = a / p;
  const low = rate < 0.6;
  const drill = node.type === "region" ? "" : `data-action="go-staff" data-plan="${planId}" data-branch="${node.branchId ?? node.id}" ${node.store ? `data-store="${esc(node.store)}"` : ""}`;
  return `
    <td class="num group-start">${fmt(p)}</td>
    <td class="num">${fmt(a)}</td>
    <td class="num rate-cell"><span class="rate-wrap"><span class="rate-bar ${low ? "low" : ""}"><i style="width:${Math.round(rate * 100)}%"></i></span>${
      drill
        ? `<button class="cell-link" ${drill} title="查看专员明细">${pct(a, p)}</button>`
        : `<span class="num">${pct(a, p)}</span>`
    }</span></td>
    <td class="num ${u ? "cell-warn" : ""}">${fmt(u)}</td>`;
}

function customCell(node, sector) {
  const base = nodeBase(node, sector);
  const primary = planGroupsForSector(sector)[0];
  const counts = nodeCounts(node, primary.id);
  if (!base || !counts[0]) return `<td class="num cell-muted">—</td>`;
  return `<td class="num">${(base.publishedCount / counts[0]).toFixed(2)}</td>`;
}

function visibleRegions() {
  return REGIONS.filter((r) => r.branches.some((b) => inScope(b.id)))
    .map((r) => {
      const branches = r.branches.filter(
        (b) => inScope(b.id) && (state.orgFilter === "all" || state.orgFilter === r.id || state.orgFilter === b.id),
      );
      return { ...r, branches, branchIds: branches.map((b) => b.id) };
    })
    .filter((r) => r.branches.length);
}

function orgTable(sector) {
  const groups = planGroupsForSector(sector);
  const branchMode = isRestricted();
  const regions = visibleRegions();
  const primaryPlan = groups[0].id;

  const sortedRegions = branchMode
    ? regions
    : state.sort.key === "org"
      ? [...regions].sort((a, b) => a.name.localeCompare(b.name, "zh-CN") * state.sort.dir)
      : sortByRate([...regions], primaryPlan);

  const headGroups =
    groups
      .map((plan) => {
        const same = plan.samePeopleAs
          ? `<span class="tag" title="与「${esc(PLAN_BY_ID[plan.samePeopleAs].alias)}」共用分母">同一人群</span>`
          : "";
        return `<th colspan="4" class="group-head">
        <span class="group-title">${esc(plan.alias)} ${same}</span>
        <div class="group-sub">v${plan.version} · 已完成 ${esc(plan.completedAt.slice(5))}</div>
      </th>`;
      })
      .join("") +
    (state.showCustom
      ? `<th rowspan="2" class="group-head"><span class="group-title">自定义指标（可选）</span><div class="group-sub">人均发布内容数</div></th>`
      : "");

  const headSub = groups
    .map(
      (plan) => `
      <th class="num group-start">考核人数</th>
      <th class="num">完成人数</th>
      <th class="num"><button class="cell-link" data-action="sort-rate" data-plan="${plan.id}">完成率${state.sort.key === `rate:${plan.id}` ? (state.sort.dir > 0 ? " ↑" : " ↓") : ""}</button></th>
      <th class="num">未获取成功</th>`,
    )
    .join("");

  const body = sortedRegions
    .map((region) => {
      const expanded = state.expanded.has(region.id);
      const regionNode = { type: "region", id: region.id, name: branchMode ? "本范围合计" : region.name, branchIds: region.branchIds };
      const regionBase = nodeBase(regionNode, sector);
      const regionFlags = "";
      let rows = `
        <tr class="region-row" data-action="toggle-node" data-id="${region.id}">
          <td><span class="org-name">${icon(expanded ? "chevronDown" : "chevronRight", 13)}<b>${esc(branchMode ? "本范围合计" : region.name)}</b>${regionFlags}</span></td>
          ${baseCells(regionBase)}
          ${groups.map((p) => planCells(regionNode, p.id)).join("")}
          ${state.showCustom ? customCell(regionNode, sector) : ""}
        </tr>`;

      if (expanded) {
        const branches = branchMode
          ? region.branches
          : state.sort.key === "org"
            ? [...region.branches].sort((a, b) => a.name.localeCompare(b.name, "zh-CN") * state.sort.dir)
            : sortByRate(region.branches.map((b) => ({ ...b, type: "branch" })), primaryPlan);

        rows += branches
          .map((branch) => {
            const branchNode = { type: "branch", id: branch.id, name: branch.name, branchId: branch.id };
            const flags = BRANCH_FLAGS[branch.id] ?? {};
            const exited = flags.exited || (flags.exitedSectors ?? []).includes(sector);
            const partial = (flags.partialSectors ?? []).includes(sector);
            const branchExpanded = state.expanded.has(branch.id);
            const branchBase = nodeBase(branchNode, sector);
            let branchRows = `
              <tr class="branch-row ${partial ? "row-partial" : ""} ${exited ? "row-exited" : ""}" data-action="toggle-node" data-id="${branch.id}">
                <td><span class="org-name">${icon(branchExpanded ? "chevronDown" : "chevronRight", 13)}<span class="org-name">${esc(branch.name)}</span>
                  ${exited ? `<span class="tag">已退出活动</span>` : ""}
                  ${partial ? `<span class="tag" title="部分账号无数据">部分覆盖</span>` : ""}
                </span></td>
                ${baseCells(branchBase)}
                ${groups.map((p) => planCells(branchNode, p.id)).join("")}
                ${state.showCustom ? customCell(branchNode, sector) : ""}
              </tr>`;

            if (branchExpanded) {
              branchRows += branch.stores
                .map((store) => {
                  const storeNode = { type: "store", id: `${branch.id}:${store}`, name: store, branchId: branch.id, store };
                  const storeBase = nodeBase(storeNode, sector);
                  const empty = groups.every((p) => nodeCounts(storeNode, p.id)[0] === 0);
                  if (empty && !storeBase) return "";
                  return `
                    <tr class="store-row clickable" data-action="go-staff" data-plan="${primaryPlan}" data-branch="${branch.id}" data-store="${esc(store)}">
                      <td><span class="org-name">${icon("store", 13)}<span>${esc(store)}</span><span class="cell-muted small">查看专员</span></span></td>
                      ${baseCells(storeBase)}
                      ${groups.map((p) => planCells(storeNode, p.id)).join("")}
                      ${state.showCustom ? customCell(storeNode, sector) : ""}
                    </tr>`;
                })
                .join("");
            }
            return branchRows;
          })
          .join("");
      }
      return rows;
    })
    .join("");

  return { groups, regions: sortedRegions, body, headGroups, headSub };
}

function reportFooter(sector, groups) {
  const executions = groups
    .map((p) => `${p.alias} v${p.version} · 考核 ${fmt(scopeTotals(p.id)[0])} / 未获取 ${fmt(scopeTotals(p.id)[2])}`)
    .join("；");
  const sync = isRestricted()
    ? "—（受限范围不显示整活动的同步成功率）"
    : `${PROJECTION.descriptor.sync.successRate}%（最后同步 ${PROJECTION.descriptor.sync.lastSyncAt}）`;
  const attribution = isRestricted() ? "—" : `${PROJECTION.descriptor.attributionIssues}`;
  return `
    <div class="report-foot">
      <div class="foot-item"><b>数据截止</b>${esc(PROJECTION.cutoffAt)}（北京时间）</div>
      <div class="foot-item"><b>判定执行时间</b>${groups.map((p) => esc(p.completedAt.slice(5))).join(" / ")}</div>
      <div class="foot-item"><b>指标版本 · 观测策略</b>${esc(PROJECTION.descriptor.metricSet)} · ${esc(PROJECTION.descriptor.observationPolicy)}</div>
      <div class="foot-item"><b>判定计划版本</b>${groups.map((p) => `v${p.version}`).join(" / ")}</div>
      <div class="foot-item"><b>各计划考核人数 / 未获取成功</b>${esc(executions)}</div>
      <div class="foot-item"><b>同步成功率</b>${esc(sync)}</div>
      <div class="foot-item"><b>未归属</b>${esc(attribution)}</div>
      <div class="foot-item"><b>投影</b>${esc(PROJECTION.projectionId)}${staleBadge()}</div>
      <div class="foot-note">
        口径：参与 = 成功 + 不达标 + 未获取成功；完成率 = 完成人数 ÷ 考核人数；大区与合计按分公司分量求和，不平均下级百分比。
        空行来自冻结的参与名单，不从当前主数据补行；缺失数据显示「—」，真实 0 显示 0。
        ${isRestricted() ? "当前为受限范围，汇总为本范围合计，整活动指标不显示。" : ""}
      </div>
    </div>`;
}

function reportsPage() {
  if (state.role === "store_staff") return storeView();
  const denied = demoGate({
    emptyTitle: "这个活动还没有判定结果",
    emptyBody: "等判定计划执行完成后，点检表会自动出现。",
    emptyAction: `<a class="btn" href="#/reports">去判定计划</a>`,
  });
  if (denied) return shell(denied, ["报表与看板", "组织点检表"], "reports");

  const groups = planGroupsForSector(state.sector);
  const table = orgTable(state.sector);
  const pending = notice(
    "info",
    `${PROJECTION.descriptor.pendingPlans} 个判定计划尚未执行：618 直播切片`,
    "它已在指标字典里可见，但点检表按「已执行」出列；执行完成后自动出现，无需改配置。",
  );

  const filter = `
    <div class="filter-bar">
      <span class="filter-label">活动计划</span>
      <span class="filter-select"><select data-change="noop" aria-label="活动计划"><option>618 家电焕新季</option></select></span>
      <span class="filter-label">品牌</span>
      <span class="filter-select"><select data-change="noop" aria-label="品牌"><option>海信</option></select></span>
      <span class="filter-label">组织</span>
      <span class="filter-select"><select data-change="reports-org" aria-label="组织">
        <option value="all" ${state.orgFilter === "all" ? "selected" : ""}>全部组织</option>
        ${REGIONS.filter((r) => r.branches.some((b) => inScope(b.id)))
          .map((r) => `<optgroup label="${esc(r.name)}">
            <option value="${r.id}" ${state.orgFilter === r.id ? "selected" : ""}>${esc(r.name)}（大区）</option>
            ${r.branches
              .filter((b) => inScope(b.id))
              .map((b) => `<option value="${b.id}" ${state.orgFilter === b.id ? "selected" : ""}>　${esc(b.name)}</option>`)
              .join("")}
          </optgroup>`)
          .join("")}
      </select></span>
      <label class="checkline"><input type="checkbox" data-change="toggle-custom" ${state.showCustom ? "checked" : ""} />显示自定义指标列</label>
      <span class="filter-spacer"></span>
      <span class="filter-note">投影 ${esc(PROJECTION.projectionId)} · 只读</span>
      ${canExport(state.role) ? `<button class="btn primary" data-action="open-export" data-object="checklist">${icon("download", 14)}导出 Excel</button>` : ""}
      ${canManageMetrics(state.role) ? `<button class="btn" data-action="recompute">${icon("refresh", 14)}手工重算</button>` : ""}
    </div>`;

  const sectorTabs = `
    <div class="sector-tabs" role="tablist">
      ${Object.values(SECTORS)
        .map(
          (s) => `<button class="sector-tab ${state.sector === s.key ? "on" : ""}" data-action="set-sector" data-sector="${s.key}" role="tab" aria-selected="${state.sector === s.key}">
            ${esc(s.label)} <small>${planGroupsForSector(s.key).length} 个判定计划</small>
          </button>`,
        )
        .join("")}
    </div>`;

  const tableCard = `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(SECTORS[state.sector].label)} · 组织点检表
            ${branchModeTag()}
            ${staleBadge()}
          </div>
          <div class="card-sub">${esc(SECTORS[state.sector].note)}；共 ${table.regions.length} 个大区 · ${table.regions.reduce((n, r) => n + r.branches.length, 0)} 家分公司</div>
        </div>
        <div class="chips">
          <span class="chip">按板块分表</span>
          <span class="chip">完成率可按列排序</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table report">
          <thead>
            <tr>
              <th rowspan="2" class="org-col">组织</th>
              <th colspan="3" class="group-head base">基础指标</th>
              ${table.headGroups}
            </tr>
            <tr>
              <th class="num">账号数</th><th class="num">粉丝总数</th><th class="num">发布内容数</th>
              ${table.headSub}
            </tr>
          </thead>
          <tbody>${table.body}</tbody>
        </table>
      </div>
      ${state.showCustom ? customColumnNote() : ""}
      ${reportFooter(state.sector, groups)}
    </div>`;

  const content = `
    ${pageHead(
      "组织点检表",
      `618 家电焕新季 · 海信 · 2026-05-20 ~ 06-30 · 数据截止 ${esc(PROJECTION.cutoffAt)}`,
      `<a class="btn" href="#/board">${icon("layers", 14)}去计划看板</a>`,
    )}
    ${projectionBanners()}
    ${pending}
    ${filter}
    ${sectorTabs}
    <div style="height:12px"></div>
    ${tableCard}
  `;
  return shell(content, ["报表与看板", "组织点检表"], "reports");
}

function branchModeTag() {
  if (isRestricted()) return `<span class="tag">本范围合计</span>`;
  return "";
}

function customColumnNote() {
  return `<div class="notice info" style="margin:0;border:0;border-bottom:1px solid var(--line-2);border-radius:0">
    ${icon("info", 16)}
    <div class="notice-body"><div class="notice-title">自定义指标列：人均发布内容数</div>
    <div class="notice-sub">按「发布内容数 ÷ 考核人数」在该节点上求值，分母为 0 显示「—」。绑定规则（E-SD-11②）待确认；默认关闭，属于个人显示偏好，不影响他人。</div></div>
  </div>`;
}

// 门店专员：我的考核（单列、仅本人）
function storeView() {
  const me = myStaff();
  const plans = Object.entries(me.plans);
  const planCards = plans
    .map(([planId, d]) => {
      const plan = PLAN_BY_ID[planId];
      return `
      <div class="store-plan">
        <div class="sp-head">
          <div>
            <div class="sp-title">${esc(plan.alias)}</div>
            <div class="sp-sub">${esc(SECTORS[plan.sector].label)}板块 · 判定计划 v${plan.version}</div>
          </div>
          ${resultBadge(d.status)}
        </div>
        <div class="sp-layers">
          <div class="store-layer"><div class="sl-label">内容层</div><div class="sl-value">${resultBadge(d.content)}</div></div>
          <div class="store-layer"><div class="sl-label">评论层</div><div class="sl-value">${resultBadge(d.comment)}${d.reason ? `<div class="cell-sub">${esc(d.reason)}</div>` : ""}</div></div>
          <div class="store-layer"><div class="sl-label">账号层</div><div class="sl-value">${resultBadge(d.account)}</div></div>
        </div>
        <div class="store-base">
          <div class="sb-item"><div class="sb-label">通过第 1 / 2 / 3 层</div><div class="sb-value">${d.c1} / ${d.c2} / ${d.c3}</div></div>
          <div class="sb-item"><div class="sb-label">账号数</div><div class="sb-value">${fmt(me.accountCount)}</div></div>
          <div class="sb-item"><div class="sb-label">发布内容数</div><div class="sb-value">${fmt(me.publishedCount)}</div></div>
        </div>
        <div class="store-actions">
          <a class="btn" href="#/hits?plan=${planId}&staff=${me.id}">${icon("eye", 14)}查看我的命中内容</a>
        </div>
      </div>`;
    })
    .join("");

  const content = `
    <div class="store-view">
      <div class="store-hero">
        <div class="hero-name">${esc(me.name)}</div>
        <div class="hero-path">华北 / 北京分公司 / 朝阳门店</div>
        <div class="hero-note">我的考核 · 数据截止 ${esc(PROJECTION.cutoffAt)} · 最后观测 ${esc(me.lastObserved)}</div>
        <div class="hero-note cell-muted">页面只显示本人数据；内容正文与评论原文不展示。</div>
      </div>
      ${projectionBanners()}
      ${planCards}
      <div class="store-plan">
        <div class="sp-title">学习</div>
        <div class="sp-sub">学习中心在手机端底部 Tab；本原型只演示报表与看板。</div>
      </div>
    </div>`;
  return shell(content, ["我的考核"], "reports");
}

// ---------------------------------------------------------------------------
// 专员明细
// ---------------------------------------------------------------------------

function orgOptions(includeStores = false) {
  return `
    <option value="all">全部组织</option>
    ${REGIONS.filter((r) => r.branches.some((b) => inScope(b.id)))
      .map(
        (r) => `<optgroup label="${esc(r.name)}">
          <option value="${r.id}">${esc(r.name)}（大区）</option>
          ${r.branches
            .filter((b) => inScope(b.id))
            .map(
              (b) => `<option value="${b.id}">　${esc(b.name)}</option>
                ${includeStores ? b.stores.map((s) => `<option value="${b.id}:${esc(s)}">　　${esc(s)}</option>`).join("") : ""}`,
            )
            .join("")}
        </optgroup>`,
      )
      .join("")}`;
}

function orgMatches(staff, org) {
  if (org === "all") return true;
  if (org.includes(":")) {
    const [branchId, store] = org.split(":");
    return staff.branchId === branchId && staff.store === store;
  }
  if (org.startsWith("r-")) return staff.regionId === org;
  return staff.branchId === org;
}

function staffRows() {
  let rows = staffForPlan(state.staff.plan).filter((s) => inScope(s.branchId));
  if (state.role === "store_staff") rows = rows.filter((s) => s.id === myStaff().id);
  rows = rows.filter(
    (s) =>
      orgMatches(s, state.staff.org) &&
      (state.staff.platform === "all" || s.platform === state.staff.platform) &&
      (state.staff.result === "all" || s.plans[state.staff.plan].status === state.staff.result),
  );
  return rows;
}

function staffPage() {
  if (state.role === "store_staff") {
    return shell(storeView(), ["我的考核"], "reports");
  }
  const denied = demoGate({
    emptyTitle: "没有符合条件的专员",
    emptyBody: "换一个判定计划、结果或组织筛选试试。",
    emptyAction: `<button class="btn" data-action="clear-staff">清空筛选</button>`,
  });
  if (denied) return shell(denied, ["报表与看板", "专员明细"], "reports");

  const rows = staffRows();
  const total = rows.length;
  const page = Math.min(state.staff.page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  state.staff.page = page;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const counts = rows.reduce(
    (acc, s) => {
      const st = s.plans[state.staff.plan].status;
      acc[st] = (acc[st] ?? 0) + 1;
      return acc;
    },
    { success: 0, not_met: 0, unobtained: 0 },
  );
  const plan = PLAN_BY_ID[state.staff.plan];
  const currentOrg = state.staff.org === "all" ? "全部组织" : orgLabel(state.staff.org);
  const staffFilterChip =
    state.staff.org !== "all" ? `<span class="chip on">组织：${esc(currentOrg)}<button data-action="clear-org" aria-label="移除">×</button></span>` : "";
  const resultFilterChip =
    state.staff.result !== "all" ? `<span class="chip on">结果：${esc(resultText(state.staff.result))}<button data-action="clear-result" aria-label="移除">×</button></span>` : "";
  const platformFilterChip =
    state.staff.platform !== "all" ? `<span class="chip on">平台：${esc(state.staff.platform)}<button data-action="clear-platform" aria-label="移除">×</button></span>` : "";

  const body = slice
    .map((s) => {
      const d = s.plans[state.staff.plan];
      return `
      <tr class="clickable" data-action="go-hits" data-plan="${state.staff.plan}" data-staff="${s.id}">
        <td><div class="cell-stack"><span class="cell-sub">${esc(s.regionName)} / ${esc(s.branchName)}</span><span class="cell-main">${esc(s.store)}</span></div></td>
        <td><span class="cell-main">${esc(s.name)}</span></td>
        <td>${esc(s.platform)}</td>
        <td class="num">${fmt(s.accountCount)}</td>
        <td><div class="cell-stack">${resultBadge(d.status)}${d.reason ? `<span class="cell-sub">${esc(d.reason)}${d.partial ? " · 部分覆盖" : ""}</span>` : d.partial ? `<span class="cell-sub">部分覆盖</span>` : ""}</div></td>
        <td>${resultBadge(d.content)}</td>
        <td>${resultBadge(d.comment)}</td>
        <td>${resultBadge(d.account)}</td>
        <td class="num">${fmt(d.c1)}</td>
        <td class="num">${fmt(d.c2)}</td>
        <td class="num">${fmt(d.c3)}</td>
        <td class="num">${fmt(s.followerTotal)}</td>
        <td class="num">${fmt(s.publishedCount)}</td>
        <td class="cell-sub">${esc(s.lastObserved)}</td>
      </tr>`;
    })
    .join("");

  const pagination = `
    <div class="report-foot" style="grid-template-columns:1fr auto;align-items:center">
      <div class="foot-item">共 ${fmt(total)} 人 · 第 ${page} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页 · 每页 ${PAGE_SIZE} 人</div>
      <div class="inline-actions">
        <button class="btn sm" data-action="staff-prev" ${page <= 1 ? "disabled" : ""}>${icon("arrowLeft", 13)}上一页</button>
        <button class="btn sm" data-action="staff-next" ${page >= Math.ceil(total / PAGE_SIZE) ? "disabled" : ""}>下一页${icon("chevronRight", 13)}</button>
      </div>
    </div>`;

  const content = `
    ${pageHead(
      "专员明细",
      `618 家电焕新季 · ${esc(plan.alias)} v${plan.version} · 数据截止 ${esc(PROJECTION.cutoffAt)}`,
      `<a class="btn" href="#/reports?sector=${plan.sector}">${icon("arrowLeft", 14)}返回组织点检表</a>${canExport(state.role) ? `<button class="btn primary" data-action="open-export" data-object="staff">${icon("download", 14)}导出 Excel</button>` : ""}`,
    )}
    ${projectionBanners()}
    <div class="filter-bar">
      <span class="filter-label">判定计划</span>
      <span class="filter-select"><select data-change="staff-plan">
        ${PLANS.filter((p) => !p.pending).map((p) => `<option value="${p.id}" ${state.staff.plan === p.id ? "selected" : ""}>${esc(p.alias)}（${SECTORS[p.sector].label} · v${p.version}）</option>`).join("")}
      </select></span>
      <span class="filter-label">结果</span>
      <span class="filter-select"><select data-change="staff-result">
        ${[["all", "全部结果"], ["success", "成功"], ["not_met", "不达标"], ["unobtained", "未获取成功"]]
          .map(([k, v]) => `<option value="${k}" ${state.staff.result === k ? "selected" : ""}>${v}</option>`)
          .join("")}
      </select></span>
      <span class="filter-label">组织</span>
      <span class="filter-select"><select data-change="staff-org" class="org-select">${orgOptions(true)}</select></span>
      <span class="filter-label">平台</span>
      <span class="filter-select"><select data-change="staff-platform">
        <option value="all">全部平台</option>
        <option value="抖音" ${state.staff.platform === "抖音" ? "selected" : ""}>抖音</option>
        <option value="小红书" ${state.staff.platform === "小红书" ? "selected" : ""}>小红书</option>
      </select></span>
      <span class="filter-spacer"></span>
      <span class="filter-note">多账号合并为一行，不重复进入分母</span>
    </div>
    <div class="selected-row">
      <span class="chip on">判定计划：${esc(plan.alias)}</span>
      ${staffFilterChip}${resultFilterChip}${platformFilterChip}
      ${staffFilterChip || resultFilterChip || platformFilterChip ? `<button class="btn ghost sm" data-action="clear-staff">清空</button>` : ""}
    </div>
    <div class="summary-strip">
      <div class="strip-item"><div class="strip-label">考核人数</div><div class="strip-value">${fmt(total)}<small>人</small></div></div>
      <div class="strip-item"><div class="strip-label">成功</div><div class="strip-value green">${fmt(counts.success ?? 0)}</div></div>
      <div class="strip-item"><div class="strip-label">不达标</div><div class="strip-value red">${fmt(counts.not_met ?? 0)}</div></div>
      <div class="strip-item"><div class="strip-label">未获取成功</div><div class="strip-value gray">${fmt(counts.unobtained ?? 0)}</div></div>
      <div class="strip-item"><div class="strip-label">完成率</div><div class="strip-value">${pct(counts.success ?? 0, total)}</div></div>
    </div>
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">专员明细 ${staleBadge()}</div>
        <div class="card-sub">点击一行查看命中内容；C1 / C2 / C3 是通过第 1 / 2 / 3 层的内容条数，不是比率。</div></div>
      </div>
      <div class="table-wrap">
        <table class="table wide">
          <thead><tr>
            <th>组织链</th><th>专员</th><th>平台</th><th class="num">账号数</th>
            <th>计划总结果</th><th>内容层</th><th>评论层</th><th>账号层</th>
            <th class="num">C1</th><th class="num">C2</th><th class="num">C3</th>
            <th class="num">粉丝总数</th><th class="num">发布内容数</th><th>最后观测</th>
          </tr></thead>
          <tbody>${body || `<tr><td colspan="14"><div class="empty-mini"><b>没有符合条件的专员</b>换一个结果或组织筛选试试。</div></td></tr>`}</tbody>
        </table>
      </div>
      ${pagination}
    </div>`;

  return shell(content, ["报表与看板", "组织点检表", "专员明细"], "reports");
}

function orgLabel(org) {
  if (org === "all") return "全部组织";
  if (org.includes(":")) {
    const [branchId, store] = org.split(":");
    return `${BRANCH_BY_ID[branchId]?.name ?? branchId} / ${store}`;
  }
  if (org.startsWith("r-")) return `${REGION_BY_ID[org]?.name ?? org}（大区）`;
  return BRANCH_BY_ID[org]?.name ?? org;
}

// ---------------------------------------------------------------------------
// 命中内容
// ---------------------------------------------------------------------------

function hitRows() {
  let rows = HITS.filter((h) => inScope(h.branchId));
  if (state.role === "store_staff") rows = rows.filter((h) => h.staffId === myStaff().id);
  if (state.hits.plan !== "all") rows = rows.filter((h) => h.planId === state.hits.plan);
  if (state.hits.staff !== "all") rows = rows.filter((h) => h.staffId === state.hits.staff);
  if (state.hits.org !== "all") rows = rows.filter((h) => orgMatches(h, state.hits.org));
  if (state.hits.platform !== "all") rows = rows.filter((h) => h.platform === state.hits.platform);
  return rows;
}

function hitsPage() {
  const denied = demoGate({
    emptyTitle: "没有通过全部内容层的内容",
    emptyBody: "命中内容只包含通过全部内容层的内容；如果确实没有，先看专员明细里的各层结果。",
    emptyAction: `<a class="btn" href="#/staff">去看专员明细</a>`,
  });
  if (denied) return shell(denied, ["报表与看板", "命中内容"], "reports");

  const rows = hitRows();
  const total = rows.length;
  const page = Math.min(state.hits.page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  state.hits.page = page;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const staffSet = new Set(rows.map((h) => h.staffId));
  const staffChip =
    state.hits.staff !== "all"
      ? `<span class="chip on">专员：${esc(STAFF_BY_ID[state.hits.staff]?.name ?? "—")}<button data-action="clear-hit-staff" aria-label="移除">×</button></span>`
      : "";
  const planChip =
    state.hits.plan !== "all" ? `<span class="chip on">判定计划：${esc(PLAN_BY_ID[state.hits.plan].alias)}<button data-action="clear-hit-plan" aria-label="移除">×</button></span>` : "";
  const orgChip = state.hits.org !== "all" ? `<span class="chip on">组织：${esc(orgLabel(state.hits.org))}<button data-action="clear-hit-org" aria-label="移除">×</button></span>` : "";
  const platformChip = state.hits.platform !== "all" ? `<span class="chip on">平台：${esc(state.hits.platform)}<button data-action="clear-hit-platform" aria-label="移除">×</button></span>` : "";

  const body = slice
    .map((h) => {
      const evidence =
        state.role === "store_staff"
          ? `<span class="cell-muted small">本人无证据入口</span>`
          : h.evidence === "expired"
            ? `<span class="cell-muted small" title="判定结果行已被清理">证据已过期</span>`
            : `<button class="btn sm" data-action="open-evidence" data-hit="${h.id}">${icon("eye", 13)}查看证据</button>`;
      return `
      <tr>
        <td><div class="cell-stack"><span class="cell-sub">${esc(h.regionName)} / ${esc(h.branchName)}</span><span>${esc(h.store)}</span></div></td>
        <td>${esc(h.staffName)}</td>
        <td>${esc(h.platform)}</td>
        <td>${esc(h.nickname)}</td>
        <td><div class="cell-stack"><span class="cell-main">${esc(h.title)}</span><span class="cell-sub">${esc(PLAN_BY_ID[h.planId].alias)}</span></div></td>
        <td class="cell-sub">${esc(h.publishedAt)}</td>
        <td>${resultBadge(h.contentResult)}</td>
        <td>${resultBadge(h.commentResult)}</td>
        <td>${resultBadge(h.accountResult)}</td>
        <td class="num">${fmt(h.interactions)}</td>
        <td class="cell-sub">${esc(h.observedAt)}</td>
        <td>${evidence}</td>
      </tr>`;
    })
    .join("");

  const pagination = `
    <div class="report-foot" style="grid-template-columns:1fr auto;align-items:center">
      <div class="foot-item">共 ${fmt(total)} 条 · 覆盖 ${fmt(staffSet.size)} 名专员 · 第 ${page} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</div>
      <div class="inline-actions">
        <button class="btn sm" data-action="hits-prev" ${page <= 1 ? "disabled" : ""}>${icon("arrowLeft", 13)}上一页</button>
        <button class="btn sm" data-action="hits-next" ${page >= Math.ceil(total / PAGE_SIZE) ? "disabled" : ""}>下一页${icon("chevronRight", 13)}</button>
      </div>
    </div>`;

  const backStaff = `#/staff?plan=${state.hits.plan !== "all" ? state.hits.plan : "jp-home"}${state.hits.org !== "all" ? `&org=${encodeURIComponent(state.hits.org)}` : ""}`;
  const content = `
    ${pageHead(
      "命中内容",
      `通过全部内容层的内容（C3）· 数据截止 ${esc(PROJECTION.cutoffAt)}`,
      `<a class="btn" href="${backStaff}">${icon("arrowLeft", 14)}返回专员明细</a>${canExport(state.role) ? `<button class="btn primary" data-action="open-export" data-object="hits">${icon("download", 14)}导出 Excel</button>` : ""}`,
    )}
    ${projectionBanners()}
    <div class="notice info stack">${icon("info", 16)}<div class="notice-body">
      <div class="notice-title">同一作品在不同账号下各一行</div>
      <div class="notice-sub">这是按账号保存内容的已知代价；计划总结果是专员级的，不套到单条内容上。正文与评论原文任何页面都不出现。</div>
    </div></div>
    <div class="filter-bar">
      <span class="filter-label">判定计划</span>
      <span class="filter-select"><select data-change="hit-plan">
        <option value="all" ${state.hits.plan === "all" ? "selected" : ""}>全部判定计划</option>
        ${PLANS.filter((p) => !p.pending).map((p) => `<option value="${p.id}" ${state.hits.plan === p.id ? "selected" : ""}>${esc(p.alias)}（${SECTORS[p.sector].label}）</option>`).join("")}
      </select></span>
      <span class="filter-label">组织</span>
      <span class="filter-select"><select data-change="hit-org" class="org-select">${orgOptions(true)}</select></span>
      <span class="filter-label">平台</span>
      <span class="filter-select"><select data-change="hit-platform">
        <option value="all">全部平台</option>
        <option value="抖音" ${state.hits.platform === "抖音" ? "selected" : ""}>抖音</option>
        <option value="小红书" ${state.hits.platform === "小红书" ? "selected" : ""}>小红书</option>
      </select></span>
      <span class="filter-spacer"></span>
      <span class="filter-note">行集 = 内容级通过全部内容层；不含未命中</span>
    </div>
    <div class="selected-row">
      ${planChip}${orgChip}${staffChip}${platformChip}
      ${planChip || orgChip || staffChip || platformChip ? `<button class="btn ghost sm" data-action="clear-hits">清空</button>` : ""}
    </div>
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">命中内容 ${staleBadge()}</div>
        <div class="card-sub">共 ${fmt(total)} 条；证据入口以查看者自己的权限调用判定解释，不展示正文。</div></div>
      </div>
      <div class="table-wrap">
        <table class="table wide">
          <thead><tr>
            <th>组织链</th><th>专员</th><th>平台</th><th>账号昵称</th><th>内容标题</th><th>发布时间</th>
            <th>内容层</th><th>评论层</th><th>账号层</th><th class="num">互动数</th><th>观测时点</th><th>证据</th>
          </tr></thead>
          <tbody>${body || `<tr><td colspan="12"><div class="empty-mini"><b>没有命中内容</b>换一个筛选条件试试。</div></td></tr>`}</tbody>
        </table>
      </div>
      ${pagination}
    </div>`;
  return shell(content, ["报表与看板", "命中内容"], "reports");
}

// ---------------------------------------------------------------------------
// 计划看板
// ---------------------------------------------------------------------------

function boardRows(planId) {
  if (planId !== "all") {
    return BRANCHES.filter((b) => inScope(b.id)).map((b) => ({ name: b.name, counts: countsFor(b.id, planId) }));
  }
  return [];
}

function boardPage() {
  if (state.role === "store_staff") return shell(deniedPage(), ["计划看板"], "board");
  const denied = demoGate({
    emptyTitle: "这个活动还没有判定结果",
    emptyBody: "看板卡片在判定计划执行完成后自动出数。",
    emptyAction: `<a class="btn" href="#/reports">去组织点检表</a>`,
  });
  if (denied) return shell(denied, ["计划看板"], "board");

  const selected = state.board.plan === "all" ? null : PLAN_BY_ID[state.board.plan];
  const plans = PLANS.filter((p) => !p.pending);
  const scopeNote = isRestricted() ? "本分公司范围" : "全部授权组织";
  const globalScope = !isRestricted();

  // 卡片 1
  const totals = selected ? scopeTotals(selected.id) : null;
  const card1 = selected
    ? `<div class="board-card span-2">
        <div class="board-head"><div class="board-title">${icon("target", 16)}当前判定计划完成率</div><div class="board-sub">${esc(selected.alias)} · v${selected.version} · ${esc(scopeNote)}</div></div>
        <div class="board-body">
          <div class="board-kpi">
            <div class="kpi-value">${pct(totals[1], totals[0])}</div>
            <div class="kpi-unit">完成率</div>
            <div class="kpi-side"><b>${fmt(totals[0])}</b>考核人数</div>
            <div class="kpi-side"><b>${fmt(totals[1])}</b>完成人数</div>
            <div class="kpi-side"><b>${fmt(totals[0] - totals[1] - totals[2])}</b>不达标</div>
            <div class="kpi-side"><b>${fmt(totals[2])}</b>未获取成功</div>
          </div>
          <div class="count-list">
            <div class="count-row"><span class="count-name">参与 = 成功 + 不达标 + 未获取成功</span><span class="count-nums"><b>${fmt(totals[0])}</b> = ${fmt(totals[1])} + ${fmt(totals[0] - totals[1] - totals[2])} + ${fmt(totals[2])}</span></div>
            <div class="count-row"><span class="count-name">未获取成功计入分母、不计入分子</span><span class="count-nums">${pct(totals[2], totals[0])}</span></div>
          </div>
        </div>
      </div>`
    : `<div class="board-card span-2">
        <div class="board-head"><div class="board-title">${icon("target", 16)}当前判定计划完成率</div><div class="board-sub">未选择单个判定计划 · ${esc(scopeNote)}</div></div>
        <div class="board-body">
          <div class="empty-mini" style="padding:4px 0 12px;text-align:left"><b>未选择单个计划，不显示跨计划合并比率</b>下面的数字是各计划的人数，口径不同，不能相加成一个完成率。</div>
          <div class="count-list">
            ${plans.map((p) => { const t = scopeTotals(p.id); return `<div class="count-row"><span class="count-name">${esc(SECTORS[p.sector].label)} · ${esc(p.alias)}</span><span class="count-nums">考核 <b>${fmt(t[0])}</b> · 完成 <b>${fmt(t[1])}</b> · 未获取 <b>${fmt(t[2])}</b></span></div>`; }).join("")}
          </div>
        </div>
      </div>`;

  // 卡片 2
  const card2 = `<div class="board-card">
    <div class="board-head"><div class="board-title">${icon("chart", 16)}各判定计划完成率</div><div class="board-sub">按板块分开；不合并跨板块比率</div></div>
    <div class="board-body">
      ${["home", "water"]
        .map(
          (sector) => `
        <div class="bar-group-label">${esc(SECTORS[sector].label)}板块</div>
        <div class="bar-list">
          ${plans.filter((p) => p.sector === sector).map((p) => {
            const t = scopeTotals(p.id);
            return `<div class="bar-item"><div class="bar-label"><span>${esc(p.alias)}</span><b>${pct(t[1], t[0])}</b></div>
              <div class="bar-track"><div class="bar-fill" style="width:${t[0] ? Math.round((t[1] / t[0]) * 100) : 0}%"></div></div></div>`;
          }).join("")}
        </div>`,
        )
        .join("")}
    </div>
  </div>`;

  // 卡片 3
  const branches = selected ? boardRows(selected.id).filter((b) => b.counts[0]).sort((a, b) => b.counts[1] / b.counts[0] - a.counts[1] / a.counts[0]) : [];
  const card3 = `<div class="board-card">
    <div class="board-head"><div class="board-title">${icon("store", 16)}分公司完成率对比</div><div class="board-sub">${selected ? `${esc(selected.alias)} · 只含可见分公司` : "选择单个判定计划后按分公司对比"}</div></div>
    <div class="board-body">${
      selected
        ? `<div class="bar-list">${branches.map((b) => `<div class="bar-item"><div class="bar-label"><span>${esc(b.name)}</span><b>${pct(b.counts[1], b.counts[0])}</b></div><div class="bar-track"><div class="bar-fill" style="width:${Math.round((b.counts[1] / b.counts[0]) * 100)}%"></div></div></div>`).join("")}</div>`
        : `<div class="empty-mini"><b>还没有选择判定计划</b>选择后显示分公司完成率排序。</div>`
    }</div>
  </div>`;

  // 卡片 4
  const reasons = unobtainedByReason(isRestricted() ? "b-bj" : null);
  const reasonMax = reasons.length ? Math.max(...reasons.map((r) => r.value)) : 1;
  const card4 = `<div class="board-card">
    <div class="board-head"><div class="board-title">${icon("warn", 16)}未获取成功分布</div><div class="board-sub">${isRestricted() ? "本分公司范围" : "按原因汇总，查询时按范围过滤"}</div></div>
    <div class="board-body">${
      reasons.length
        ? `<div class="reason-list">${reasons.map((r) => `<div class="reason-row"><span class="reason-name">${esc(r.reason)}</span><span class="reason-track"><span class="reason-fill" style="width:${Math.round((r.value / reasonMax) * 100)}%"></span></span><span class="reason-value">${fmt(r.value)}</span></div>`).join("")}</div>`
        : `<div class="empty-mini"><b>没有未获取成功</b>当前范围内没有需要处理的数据。</div>`
    }</div>
  </div>`;

  // 卡片 5
  const sync = PROJECTION.descriptor.sync;
  const card5 = `<div class="board-card">
    <div class="board-head"><div class="board-title">${icon("activity", 16)}数据质量</div><div class="board-sub">${globalScope ? "整活动口径" : "受限范围只显示 stale"}</div></div>
    <div class="board-body">
      <div class="quality-list">
        ${globalScope
          ? `<div class="quality-row"><span class="q-label">同步成功率</span><span class="q-value">${sync.successRate}%</span></div>
             <div class="quality-row"><span class="q-label">最后同步时间</span><span class="q-value">${esc(sync.lastSyncAt)}</span></div>`
          : `<div class="quality-row"><span class="q-label">同步成功率</span><span class="q-value cell-muted">—</span></div>
             <div class="quality-row"><span class="q-label">最后同步时间</span><span class="q-value cell-muted">—</span></div>`}
        <div class="quality-row"><span class="q-label">投影状态</span><span class="q-value">${state.demo === "stale" || state.demo === "processing" ? badge("当前显示上一版", "amber") : badge("已激活", "green")}</span></div>
        <div class="quality-row"><span class="q-label">数据截止</span><span class="q-value">${esc(PROJECTION.cutoffAt)}</span></div>
      </div>
    </div>
  </div>`;

  // 卡片 6
  const latest = selected
    ? selected
    : plans.reduce((best, p) => (p.completedAt > best.completedAt ? p : best), plans[0]);
  const latestCounts = scopeTotals(latest.id);
  const card6 = `<div class="board-card span-2">
    <div class="board-head"><div class="board-title">${icon("clock", 16)}最近一次判定执行</div><div class="board-sub">${selected ? "所选判定计划" : "全部判定计划中完成时间最晚的一次"}</div></div>
    <div class="board-body">
      <div class="count-list" style="border-top:0;margin-top:0">
        <div class="count-row"><span class="count-name">${esc(latest.alias)} · v${latest.version}</span><span class="count-nums">完成时间 <b>${esc(latest.completedAt)}</b> · 状态 <b>${badge("成功", "green")}</b></span></div>
        <div class="count-row"><span class="count-name">参与 / 成功 / 未获取成功</span><span class="count-nums">${globalScope ? `<b>${fmt(latestCounts[0])}</b> / ${fmt(latestCounts[1])} / ${fmt(latestCounts[2])}` : "仅显示时间与状态"}</span></div>
      </div>
    </div>
  </div>`;

  const filter = `
    <div class="filter-bar">
      <span class="filter-label">活动计划</span>
      <span class="filter-select"><select data-change="noop"><option>618 家电焕新季</option></select></span>
      <span class="filter-label">判定计划</span>
      <span class="filter-select"><select data-change="board-plan">
        <option value="all" ${state.board.plan === "all" ? "selected" : ""}>全部判定计划</option>
        ${plans.map((p) => `<option value="${p.id}" ${state.board.plan === p.id ? "selected" : ""}>${esc(p.alias)}（${SECTORS[p.sector].label}）</option>`).join("")}
        <option value="jp-live" disabled>618 直播切片（尚未执行）</option>
      </select></span>
      <span class="filter-label">品牌</span>
      <span class="filter-select"><select data-change="board-brand"><option>海信</option></select></span>
      <span class="filter-spacer"></span>
      <span class="filter-note">所有卡片读同一投影 · ${esc(PROJECTION.projectionId)}</span>
    </div>`;

  const content = `
    ${pageHead("计划看板", `618 家电焕新季 · 海信 · 数据截止 ${esc(PROJECTION.cutoffAt)} · ${esc(scopeNote)}`, staleBadge())}
    ${projectionBanners()}
    ${filter}
    <div class="board-grid">${card1}${card2}${card3}${card4}${card5}${card6}</div>
    <div class="report-foot" style="margin-top:14px;border:1px solid var(--line);border-radius:12px">
      <div class="foot-item"><b>数据截止</b>${esc(PROJECTION.cutoffAt)}</div>
      <div class="foot-item"><b>指标版本</b>${esc(PROJECTION.descriptor.metricSet)}</div>
      <div class="foot-item"><b>观测策略</b>${esc(PROJECTION.descriptor.observationPolicy)}</div>
      <div class="foot-item"><b>最近激活</b>${esc(PROJECTION.activatedAt)}</div>
      <div class="foot-note">1.0 只有这一张固定看板：不加自由布局、排行榜、热力图、地图，也不导出为图片。卡片 1 / 2 / 3 / 6 的比率与计数不跨板块合并。</div>
    </div>`;
  return shell(content, ["计划看板"], "board");
}

// ---------------------------------------------------------------------------
// 指标字典
// ---------------------------------------------------------------------------

function metricsPage() {
  if (state.role === "store_staff") return shell(deniedPage(), ["指标字典"], "metrics");
  const denied = demoGate({
    emptyTitle: "还没有自定义指标",
    emptyBody: "自定义指标只能由一个运算符连接两个操作数；先确认口径再保存。",
    emptyAction: canManageMetrics(state.role) ? `<button class="btn primary" data-action="open-metric-create">新建自定义指标</button>` : "",
  });
  if (denied) return shell(denied, ["指标字典"], "metrics");

  const manage = canManageMetrics(state.role);
  const builtin = BUILTIN_METRICS.map(
    (m) => `<tr>
      <td><div class="cell-stack"><span class="cell-main">${esc(m.name)}</span><span class="metric-code">${esc(m.code)}</span></div></td>
      <td>${esc(m.calc)}</td>
      <td>${esc(m.unit)}</td>
      <td>${m.status === "disabled" ? badge("1.0 不上线", "amber") : badge("已发布", "green")}</td>
      <td class="cell-sub">${esc(m.note)}</td>
    </tr>`,
  ).join("");

  const derived = DERIVED_METRICS.map(
    (m) => `<tr>
      <td><div class="cell-stack"><span class="cell-main">${esc(m.name)}</span><span class="metric-code">judgement.${esc(m.planId)}.${esc(m.code)}</span></div></td>
      <td>${esc(m.planAlias)}</td>
      <td>${esc(m.calc)}</td>
      <td>${esc(m.unit)}</td>
      <td>${badge("已发布", "green")}</td>
    </tr>`,
  ).join("");

  const custom = state.customMetrics
    .map(
      (m) => `<tr>
        <td><div class="cell-stack"><span class="cell-main">${esc(m.name)}</span><span class="metric-code">${esc(m.code)}</span></div></td>
        <td><span class="formula">${m.operands.map((op, i) => `${i ? `<span class="operator">${esc(m.operator)}</span>` : ""}<span class="operand">${esc(operandLabel(op))}</span>`).join("")}</span></td>
        <td>${esc(m.scope)}</td>
        <td><span class="revision-line">v${m.revision} ${m.status === "active" ? badge("已发布", "green") : m.status === "draft" ? badge("草稿", "plain") : badge("已归档", "gray")}</span></td>
        <td class="cell-sub">${esc(m.owner)} · ${esc(m.updatedAt)}</td>
        <td class="row-actions">
          ${manage && m.status === "draft" ? `<button class="btn sm" data-action="publish-metric" data-code="${m.code}">发布</button>` : ""}
          ${manage && m.status === "active" ? `<button class="btn sm" data-action="archive-metric" data-code="${m.code}">归档</button>` : ""}
          <button class="btn sm" data-action="metric-impact" data-code="${m.code}">影响面</button>
        </td>
      </tr>`,
    )
    .join("");

  const content = `
    ${pageHead(
      "指标字典",
      "内置基础指标、判定计划派生指标与受限自定义指标；一个指标只有一个 revision，历史投影固定使用旧版本。",
      manage ? `<button class="btn primary" data-action="open-metric-create">${icon("plus", 14)}新建自定义指标</button>` : `<span class="tag">只读</span>`,
    )}
    ${!manage ? notice("info", "当前账号只读", "分支机构的指标字典只有查看权限，维护需要「指标维护」能力。") : ""}
    <div class="summary-strip">
      <div class="strip-item"><div class="strip-label">内置基础指标</div><div class="strip-value">4<small>个 · 1 个未上线</small></div></div>
      <div class="strip-item"><div class="strip-label">派生指标</div><div class="strip-value">${DERIVED_METRICS.length}<small>个 · 每计划 4 个</small></div></div>
      <div class="strip-item"><div class="strip-label">自定义指标</div><div class="strip-value">${state.customMetrics.length}<small>个 · ${state.customMetrics.filter((m) => m.status === "draft").length} 个草稿</small></div></div>
      <div class="strip-item"><div class="strip-label">已发布的自定义指标</div><div class="strip-value green">${state.customMetrics.filter((m) => m.status === "active").length}<small>个</small></div></div>
      <div class="strip-item"><div class="strip-label">观测策略</div><div class="strip-value" style="font-size:15px">last_observed · r2</div></div>
    </div>

    <div class="metric-block card">
      <div class="card-head"><div><div class="card-title">内置基础指标</div><div class="card-sub">1.0 只有四个；interactions_total 保持关闭，跨平台口径未定。</div></div></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>指标</th><th>口径</th><th>单位</th><th>状态</th><th>说明</th></tr></thead><tbody>${builtin}</tbody></table></div>
    </div>

    <div class="metric-block card">
      <div class="card-head"><div><div class="card-title">判定计划派生指标</div><div class="card-sub">每个判定计划固定 4 个；改别名只改显示名，编码不变。</div></div></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>指标</th><th>判定计划</th><th>口径</th><th>单位</th><th>状态</th></tr></thead><tbody>${derived}</tbody></table></div>
    </div>

    <div class="metric-block card">
      <div class="card-head"><div><div class="card-title">自定义指标</div><div class="card-sub">两个操作数 + 一个四则运算符；不嵌套，成环拒绝，除零显示「—」。</div></div>
        ${manage ? `<button class="btn sm" data-action="open-metric-create">${icon("plus", 13)}新建</button>` : ""}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>指标</th><th>表达式</th><th>适用品牌</th><th>版本 / 状态</th><th>维护人</th><th></th></tr></thead><tbody>${custom}</tbody></table></div>
      ${notice("info", "绑定规则待确认（E-SD-11②）", "每个自定义指标绑定 base 或一个判定计划；同时含两个计划的派生指标时保存拒绝，需要跨人群运算请等 2.0。原型按当前处理展示。")}
    </div>`;
  return shell(content, ["指标字典"], "metrics");
}

function operandLabel(code) {
  const builtin = BUILTIN_METRICS.find((m) => m.code === code);
  if (builtin) return builtin.name;
  const derived = DERIVED_METRICS.find((m) => m.code === code);
  if (derived) return derived.name;
  return code;
}

// ---------------------------------------------------------------------------
// 下载中心
// ---------------------------------------------------------------------------

function exportsPage() {
  if (!canExport(state.role)) return shell(deniedPage(), ["下载中心"], "exports");
  const denied = demoGate({
    emptyTitle: "还没有导出任务",
    emptyBody: "从组织点检表、专员明细或命中内容页点「导出 Excel」提交。",
    emptyAction: `<a class="btn" href="#/reports">去组织点检表</a>`,
  });
  if (denied) return shell(denied, ["下载中心"], "exports");

  const rows = state.jobs.filter((j) => state.exportFilter === "all" || j.status === state.exportFilter);
  const body = rows
    .map((j) => {
      const actions = [];
      if (j.status === "succeeded") actions.push(`<button class="btn sm" data-action="download-job" data-id="${j.id}">${icon("download", 13)}重新下载</button>`);
      if (j.status === "queued") actions.push(`<button class="btn sm" data-action="cancel-job" data-id="${j.id}">取消</button>`);
      if (j.status === "failed") {
        actions.push(`<button class="btn sm" data-action="job-error" data-id="${j.id}">失败原因</button>`);
        actions.push(`<button class="btn sm" data-action="retry-job" data-id="${j.id}">重试</button>`);
      }
      if (j.status === "expired") actions.push(`<button class="btn sm" disabled>已过期</button>`);
      return `<tr>
        <td><div class="cell-stack"><span class="cell-main">${esc(j.object)}</span><span class="cell-sub">${esc(EXPORT_OBJECTS.find((o) => o.label === j.object)?.note ?? "")}</span></div></td>
        <td class="job-scope"><div class="cell-sub">${esc(j.scope)}</div></td>
        <td>${jobStatusBadge(j.status)}${j.warning ? `<div class="job-warning">${esc(j.warning)}</div>` : ""}${j.error && state.exportFilter === "failed" ? `<div class="job-error">${esc(j.error)}</div>` : ""}</td>
        <td class="num">${fmt(j.rows)}</td>
        <td class="num">${esc(j.size)}</td>
        <td class="cell-sub">${esc(j.createdAt)}</td>
        <td class="cell-sub">${esc(j.expiresAt)}</td>
        <td><div class="row-actions">${actions.join("")}</div></td>
      </tr>`;
    })
    .join("");

  const content = `
    ${pageHead("下载中心", "本人导出任务 · 保留 7 天（配置化）· 下载为短期签名地址 · 撤权或停用后未过期文件也不可交付。", "")}
    <div class="filter-bar">
      <span class="filter-label">状态</span>
      <span class="filter-select"><select data-change="export-filter">
        ${[["all", "全部状态"], ["queued", "排队中"], ["running", "执行中"], ["succeeded", "成功"], ["failed", "失败"], ["expired", "已过期"]]
          .map(([k, v]) => `<option value="${k}" ${state.exportFilter === k ? "selected" : ""}>${v}</option>`)
          .join("")}
      </select></span>
      <span class="filter-spacer"></span>
      <span class="filter-note">共 ${state.jobs.length} 个任务 · 只有本人能看到自己的任务</span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="table wide">
          <thead><tr><th>对象</th><th>范围 / 筛选</th><th>状态</th><th class="num">行数</th><th class="num">大小</th><th>创建时间</th><th>过期时间</th><th></th></tr></thead>
          <tbody>${body || `<tr><td colspan="8"><div class="empty-mini"><b>没有这个状态的任务</b>换一个状态筛选试试。</div></td></tr>`}</tbody>
        </table>
      </div>
      <div class="report-foot">
        <div class="foot-item"><b>提交时冻结</b>模板版本、投影 token、筛选与排序、DataScope 快照</div>
        <div class="foot-item"><b>执行时收窄</b>提交范围 ∩ 执行时范围</div>
        <div class="foot-item"><b>交付前复查</b>范围收缩且产物含超范围数据 → 拒绝或按新范围重建</div>
        <div class="foot-item"><b>上限</b>行数 / 图片数 / 文件大小 / 时长均有硬上限（任务 12 实测后定）</div>
      </div>
    </div>`;
  return shell(content, ["下载中心"], "exports");
}

// ---------------------------------------------------------------------------
// 弹窗与抽屉
// ---------------------------------------------------------------------------

function renderModal() {
  const m = state.modal;
  if (m.type === "export") {
    const object = EXPORT_OBJECTS.find((o) => o.key === m.object) ?? EXPORT_OBJECTS[0];
    const rows = m.object === "checklist" ? 1284 : m.object === "staff" ? 186 : m.object === "hits" ? 2196 : 4128;
    return modalShell(
      `导出${esc(object.label)}`,
      "提交时冻结当前筛选、投影 token 与范围快照；执行完成后在下载中心取回。",
      `
      <div class="field"><label>导出对象</label><div class="input" readonly>${esc(object.label)}</div><div class="hint">${esc(object.note)}</div></div>
      <div class="row-2">
        <div class="field"><label>格式</label><select class="select"><option>Excel（.xlsx）</option></select><div class="hint">1.0 不做 CSV / 图片 / PDF。</div></div>
        <div class="field"><label>预计行数</label><div class="input" readonly>${fmt(rows)} 行</div><div class="hint">实际行数以执行为准；超过上限会拒绝。</div></div>
      </div>
      <div class="field"><label>范围与筛选（快照）</label><div class="input" readonly>${esc(m.scope ?? "618 家电焕新季 · 全部组织 · 当前筛选")}</div></div>
      ${m.object === "hits" || m.object === "judgement" ? `<label class="checkline"><input type="checkbox" checked />嵌入封面图（超过单文件图片上限时降级为链接）</label>` : ""}
      <div class="notice info" style="margin-top:12px">${icon("info", 16)}<div class="notice-body"><div class="notice-sub">导出复用页面同一份投影与同一个 token，页面与文件同值；执行时如果权限被收窄，按新范围重建或拒绝。</div></div></div>`,
      `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="submit-export" data-object="${m.object}" data-rows="${rows}">提交导出</button>`,
    );
  }
  if (m.type === "metric-create") return metricCreateModal();
  if (m.type === "metric-impact") {
    const metric = state.customMetrics.find((x) => x.code === m.code);
    return metricImpactModal(metric);
  }
  if (m.type === "confirm-publish") {
    const metric = state.customMetrics.find((x) => x.code === m.code);
    return modalShell(
      `发布「${esc(metric.name)}」`,
      "发布后产生新 revision，旧 revision 保留；历史投影不静默重写。",
      `<div class="summary-strip" style="margin-bottom:12px">
        <div class="strip-item"><div class="strip-label">当前 revision</div><div class="strip-value">v${metric.revision}</div></div>
        <div class="strip-item"><div class="strip-label">发布后</div><div class="strip-value">v${metric.revision + 1}</div></div>
        <div class="strip-item"><div class="strip-label">被配置引用</div><div class="strip-value">${metric.usage.configs}<small>份</small></div></div>
        <div class="strip-item"><div class="strip-label">覆盖历史活动</div><div class="strip-value">${metric.usage.activities}<small>个</small></div></div>
      </div>
      <div class="notice warn">${icon("warn", 16)}<div class="notice-body"><div class="notice-title">影响面已计算</div><div class="notice-sub">发布后新投影使用新 revision；已生成的投影不变。写审计事件「指标已发布」。</div></div></div>`,
      `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="confirm-publish" data-code="${metric.code}">发布 v${metric.revision + 1}</button>`,
    );
  }
  if (m.type === "confirm-archive") {
    const metric = state.customMetrics.find((x) => x.code === m.code);
    return modalShell(
      `归档「${esc(metric.name)}」`,
      "归档后历史投影仍可解释，新配置不能再选它。",
      `<div class="notice warn">${icon("warn", 16)}<div class="notice-body"><div class="notice-title">影响 ${metric.usage.configs} 份配置、${metric.usage.activities} 个历史活动</div><div class="notice-sub">已归档指标不会被删除，也不会被同名替换。</div></div></div>`,
      `<button class="btn" data-action="close-modal">取消</button><button class="btn danger" data-action="confirm-archive" data-code="${metric.code}">归档指标</button>`,
    );
  }
  if (m.type === "cancel-job") {
    const job = state.jobs.find((x) => x.id === m.id);
    return modalShell(
      "取消导出任务",
      "取消后不会生成文件；已经生成的对象不需要取消。",
      `<div class="notice warn">${icon("warn", 16)}<div class="notice-body"><div class="notice-title">将取消「${esc(job.object)}」</div><div class="notice-sub">${esc(job.scope)}；排队 ${esc(job.createdAt)}</div></div></div>`,
      `<button class="btn" data-action="close-modal">返回</button><button class="btn danger" data-action="confirm-cancel" data-id="${job.id}">取消任务</button>`,
    );
  }
  if (m.type === "job-error") {
    const job = state.jobs.find((x) => x.id === m.id);
    return modalShell(
      "导出失败原因",
      "失败不会暴露半成品文件。",
      `<div class="notice danger">${icon("warn", 16)}<div class="notice-body"><div class="notice-title">${esc(job.error ?? "导出执行失败")}</div><div class="notice-sub">稳定错误码：EXPORT_EXECUTION_TIMEOUT；可重试，重试会重新冻结提交时的范围。</div></div></div>`,
      `<button class="btn" data-action="close-modal">关闭</button>`,
    );
  }
  if (m.type === "download-link") {
    const job = state.jobs.find((x) => x.id === m.id);
    return modalShell(
      `下载「${esc(job.object)}」`,
      "短期签名地址，900 秒内有效；每次下载都会重新过出口检查。",
      `<div class="field"><label>签名地址</label><div class="input" readonly>https://hbecho-export.oss-cn-beijing.aliyuncs.com/${esc(job.id)}?Expires=…&Signature=…</div><div class="hint">演示地址，不指向真实对象。</div></div>`,
      `<button class="btn" data-action="close-modal">关闭</button>`,
    );
  }
  if (m.type === "recompute") {
    return modalShell(
      "手工重算投影",
      "重算会创建新投影，旧投影保留可查；重算完成后自动生效。",
      `<div class="notice warn">${icon("warn", 16)}<div class="notice-body"><div class="notice-title">将重算 618 家电焕新季</div><div class="notice-sub">使用当前已冻结的判定执行；不会重新执行判定计划。需要「指标维护」能力，并写审计。</div></div></div>`,
      `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="confirm-recompute">开始重算</button>`,
    );
  }
  return "";
}

function modalShell(title, sub, body, foot) {
  return `<div class="modal-backdrop" data-action="close-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-stop="1">
      <div class="modal-head"><div><div class="modal-title">${title}</div><div class="modal-sub">${sub}</div></div><button class="icon-btn" data-action="close-modal" aria-label="关闭">${icon("x", 16)}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${foot}</div>
    </div>
  </div>`;
}

function metricCreateModal() {
  const options = [
    ...BUILTIN_METRICS.filter((m) => m.status === "active").map((m) => ({ code: m.code, label: m.name })),
    { code: "participant_count", label: "考核人数" },
    { code: "achieved", label: "完成人数" },
  ];
  return modalShell(
    "新建自定义指标",
    "两个操作数 + 一个运算符；不嵌套、成环拒绝、除零返回 no_data。",
    `
    <div class="row-2">
      <div class="field"><label>显示名称</label><input class="input" value="人均发布内容数" /></div>
      <div class="field"><label>编码</label><input class="input" value="publish_per_participant" /></div>
    </div>
    <div class="field"><label>适用品牌</label><select class="select"><option>海信 · 全部品牌</option><option>海信 · 家装</option></select><div class="hint">配置范围不是授权：最终数据还要与当前 DataScope 求交。</div></div>
    <div class="field"><label>表达式</label>
      <div class="row-3">
        <select class="select">${options.map((o) => `<option ${o.code === "published_content_count" ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
        <select class="select"><option>÷</option><option>×</option><option>+</option><option>−</option></select>
        <select class="select">${options.map((o) => `<option ${o.code === "participant_count" ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
      </div>
      <div class="hint">预览：发布内容数 ÷ 考核人数。分母为 0 时显示「—」，不显示 0%。</div>
    </div>
    <div class="field"><label>说明</label><textarea class="textarea" placeholder="写清业务用途，例如：衡量人均产出。"></textarea></div>
    <div class="notice info">${icon("info", 16)}<div class="notice-body"><div class="notice-title">保存前会做强制校验</div><div class="notice-sub">分子 ⊆ 分母；观测基准必须显式；每个自定义指标绑定 base 或一个判定计划（E-SD-11②，待确认）。成环或跨两个计划会拒绝保存。</div></div></div>`,
    `<button class="btn" data-action="close-modal">取消</button><button class="btn" data-action="save-metric">保存草稿</button><button class="btn primary" data-action="save-metric-publish">保存并发布</button>`,
  );
}

function metricImpactModal(metric) {
  return modalShell(
    `影响面 · ${esc(metric.name)}`,
    "保存新 revision 前确认被多少配置引用、覆盖哪些历史活动。",
    `<div class="summary-strip" style="margin-bottom:12px">
      <div class="strip-item"><div class="strip-label">被配置引用</div><div class="strip-value">${metric.usage.configs}<small>份</small></div></div>
      <div class="strip-item"><div class="strip-label">覆盖历史活动</div><div class="strip-value">${metric.usage.activities}<small>个</small></div></div>
      <div class="strip-item"><div class="strip-label">当前 revision</div><div class="strip-value">v${metric.revision}</div></div>
      <div class="strip-item"><div class="strip-label">状态</div><div class="strip-value" style="font-size:15px">${metric.status === "active" ? "已发布" : metric.status === "draft" ? "草稿" : "已归档"}</div></div>
    </div>
    <div class="notice info">${icon("info", 16)}<div class="notice-body"><div class="notice-title">改口径会产生新版本，不覆盖旧版本</div><div class="notice-sub">历史投影固定使用旧 revision；改别名、说明、单位只改元数据，不产生新版本。</div></div></div>`,
    `<button class="btn" data-action="close-modal">关闭</button>`,
  );
}

function renderDrawer() {
  if (state.drawer.type !== "evidence") return "";
  const hit = HITS.find((h) => h.id === state.drawer.id);
  if (!hit) return "";
  const expired = hit.evidence === "expired";
  return `<div class="drawer-backdrop" data-action="close-drawer">
    <div class="drawer" role="dialog" aria-modal="true" aria-label="证据" data-stop="1">
      <div class="drawer-head">
        <div><div class="drawer-title">证据 · ${esc(hit.title)}</div><div class="modal-sub">${esc(hit.staffName)} · ${esc(hit.branchName)} / ${esc(hit.store)} · ${esc(hit.platform)} · ${esc(hit.publishedAt)}</div></div>
        <button class="icon-btn" data-action="close-drawer" aria-label="关闭">${icon("x", 16)}</button>
      </div>
      <div class="drawer-body">
        ${expired ? notice("warn", "证据已过期", "判定结果行已被清理；这条命中内容仍保留在报表里，但无法再展开逐条证据。") : ""}
        <div class="metric-block card">
          <div class="card-head"><div class="card-title">圈定</div><div class="card-sub">来自判定执行 ${esc(`ex-${hit.planId}`)} · v${PLAN_BY_ID[hit.planId].version}</div></div>
          <div class="card-body">
            <div class="kv"><span class="k">时间窗</span><span class="v">2026-05-20 ~ 2026-06-18</span></div>
            <div class="kv"><span class="k">内容形态</span><span class="v">视频 · 已发布</span></div>
            <div class="kv"><span class="k">归属</span><span class="v">${esc(hit.branchName)} / ${esc(hit.store)}</span></div>
          </div>
        </div>
        <div class="metric-block card">
          <div class="card-head"><div class="card-title">内容层</div><div class="card-sub">通过 · 证据摘要</div></div>
          <div class="card-body">
            <div class="kv"><span class="k">话题</span><span class="v">#618焕新 #海信好物</span></div>
            <div class="kv"><span class="k">视频时长</span><span class="v">32 秒 ≥ 15 秒</span></div>
            <div class="kv"><span class="k">封面模板</span><span class="v">相似度 0.87 ≥ 阈值 0.80</span></div>
          </div>
        </div>
        <div class="metric-block card">
          <div class="card-head"><div class="card-title">评论层</div><div class="card-sub">通过 · 命中关键词</div></div>
          <div class="card-body">
            <div class="kv"><span class="k">关键词</span><span class="v">安装 / 售后</span></div>
            <div class="kv"><span class="k">有效评论</span><span class="v">3 条 · 来自 2 个账号</span></div>
          </div>
        </div>
        <div class="metric-block card">
          <div class="card-head"><div class="card-title">账号层</div><div class="card-sub">通过</div></div>
          <div class="card-body">
            <div class="kv"><span class="k">平台账号</span><span class="v">${esc(hit.nickname)}</span></div>
            <div class="kv"><span class="k">账号状态</span><span class="v">正常采集</span></div>
            <div class="kv"><span class="k">观测时点</span><span class="v">${esc(hit.observedAt)}</span></div>
          </div>
        </div>
        <div class="notice info" style="margin-top:12px">${icon("info", 16)}<div class="notice-body"><div class="notice-title">正文与评论原文不在这里展示</div><div class="notice-sub">证据以 D 域为唯一解释源；E 只冻结显示字段。查看入口本身会按查看者的权限重新校验。</div></div></div>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function nextPage(stateKey, page) {
  const st = state[stateKey];
  st.page = Math.max(1, page);
  if (stateKey === "staff") {
    go("staff", { plan: st.plan, result: state.staff.result, org: state.staff.org, platform: st.platform, page: st.page });
  } else {
    go("hits", { plan: st.plan, org: st.org, staff: st.staff, platform: st.platform, page: st.page });
  }
}

function setRole(role) {
  state.role = role;
  state.demo = "normal";
  state.staff.page = 1;
  state.hits.page = 1;
  state.expanded = new Set(["r-huabei"]);
  if (role === "branch_manager") state.orgFilter = "all";
  if (role === "store_staff") go("reports", {});
  else if (state.route.view === "metrics" && role === "branch_manager") render();
  else render();
}

function submitExport(objectKey, rows) {
  const object = EXPORT_OBJECTS.find((o) => o.key === objectKey)?.label ?? "导出";
  state.jobs.unshift({
    id: `exp-${Date.now()}`,
    object,
    scope: `618 家电焕新季 · ${state.sector === "home" ? "家装" : "水机"} · ${isRestricted() ? "本分公司" : "全部组织"}`,
    status: "queued",
    rows,
    size: "—",
    createdAt: "2026-06-19 11:02",
    expiresAt: "—",
    warning: null,
  });
  state.modal = null;
  render();
  toast(`已提交「${object}」导出，可在下载中心查看`);
}

function handleAction(action, el) {
  switch (action) {
    case "toast-module":
      toast(`「${el.dataset.module}」不在本原型范围；这里只演示报表与看板。`);
      break;
    case "retry":
      state.demo = "normal";
      render();
      toast("已重新查询");
      break;
    case "set-sector":
      state.sector = el.dataset.sector;
      go("reports", { sector: state.sector, org: state.orgFilter });
      break;
    case "toggle-node": {
      const id = el.dataset.id;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      render();
      break;
    }
    case "sort-rate": {
      const planId = el.dataset.plan;
      if (state.sort.key === `rate:${planId}`) state.sort.dir *= -1;
      else {
        state.sort.key = `rate:${planId}`;
        state.sort.dir = -1;
      }
      render();
      break;
    }
    case "go-staff": {
      const org = el.dataset.store ? `${el.dataset.branch}:${el.dataset.store}` : el.dataset.branch;
      go("staff", { plan: el.dataset.plan, org });
      break;
    }
    case "go-hits":
      go("hits", { plan: el.dataset.plan, staff: el.dataset.staff });
      break;
    case "open-export":
      state.modal = { type: "export", object: el.dataset.object, scope: exportScope(el.dataset.object) };
      render();
      break;
    case "submit-export":
      submitExport(el.dataset.object, Number(el.dataset.rows));
      break;
    case "recompute":
      state.modal = { type: "recompute" };
      render();
      break;
    case "confirm-recompute":
      state.modal = null;
      state.demo = "processing";
      render();
      toast("已提交重算；重算期间继续提供上一版");
      break;
    case "open-evidence":
      state.drawer = { type: "evidence", id: el.dataset.hit };
      render();
      break;
    case "open-metric-create":
      state.modal = { type: "metric-create" };
      render();
      break;
    case "save-metric":
    case "save-metric-publish": {
      const publish = action === "save-metric-publish";
      state.customSeq = (state.customSeq ?? 0) + 1;
      state.customMetrics.push({
        code: `custom_draft_${state.customSeq}`,
        name: "人均发布内容数（副本）",
        expression: "发布内容数 ÷ 考核人数",
        operands: ["published_content_count", "participant_count"],
        operator: "÷",
        scope: "海信 · 全部品牌",
        revision: 1,
        status: publish ? "active" : "draft",
        owner: "刘学奎",
        updatedAt: "2026-06-19 11:05",
        usage: { configs: 0, activities: 0 },
      });
      state.modal = null;
      render();
      toast(publish ? "已保存并发布 v1" : "已保存草稿");
      break;
    }
    case "metric-impact":
      state.modal = { type: "metric-impact", code: el.dataset.code };
      render();
      break;
    case "publish-metric":
      state.modal = { type: "confirm-publish", code: el.dataset.code };
      render();
      break;
    case "confirm-publish": {
      const m = state.customMetrics.find((x) => x.code === el.dataset.code);
      if (m) {
        m.status = "active";
        m.revision += 1;
        m.updatedAt = "2026-06-19 11:07";
      }
      state.modal = null;
      render();
      toast("已发布新 revision；历史投影固定使用旧版本");
      break;
    }
    case "archive-metric":
      state.modal = { type: "confirm-archive", code: el.dataset.code };
      render();
      break;
    case "confirm-archive": {
      const m = state.customMetrics.find((x) => x.code === el.dataset.code);
      if (m) m.status = "archived";
      state.modal = null;
      render();
      toast("指标已归档");
      break;
    }
    case "cancel-job":
      state.modal = { type: "cancel-job", id: el.dataset.id };
      render();
      break;
    case "confirm-cancel": {
      const job = state.jobs.find((x) => x.id === el.dataset.id);
      if (job) job.status = "cancelled";
      state.modal = null;
      render();
      toast("任务已取消");
      break;
    }
    case "retry-job": {
      const job = state.jobs.find((x) => x.id === el.dataset.id);
      if (job) {
        job.status = "queued";
        job.error = null;
        job.createdAt = "2026-06-19 11:06";
      }
      render();
      toast("已重新排队；执行时按当前范围重算");
      break;
    }
    case "job-error":
      state.modal = { type: "job-error", id: el.dataset.id };
      render();
      break;
    case "download-job":
      state.modal = { type: "download-link", id: el.dataset.id };
      render();
      break;
    case "close-modal":
      state.modal = null;
      render();
      break;
    case "close-drawer":
      state.drawer = null;
      render();
      break;
    case "clear-staff":
      state.staff = { plan: state.staff.plan, result: "all", org: "all", platform: "all", page: 1 };
      go("staff", { plan: state.staff.plan });
      break;
    case "clear-org":
      state.staff.org = "all";
      state.staff.page = 1;
      go("staff", { plan: state.staff.plan, result: state.staff.result, platform: state.staff.platform });
      break;
    case "clear-result":
      state.staff.result = "all";
      state.staff.page = 1;
      go("staff", { plan: state.staff.plan, org: state.staff.org, platform: state.staff.platform });
      break;
    case "clear-platform":
      state.staff.platform = "all";
      state.staff.page = 1;
      go("staff", { plan: state.staff.plan, org: state.staff.org, result: state.staff.result });
      break;
    case "clear-hit-staff":
      state.hits.staff = "all";
      state.hits.page = 1;
      go("hits", { plan: state.hits.plan, org: state.hits.org, platform: state.hits.platform });
      break;
    case "clear-hit-plan":
      state.hits.plan = "all";
      state.hits.page = 1;
      go("hits", { org: state.hits.org, staff: state.hits.staff, platform: state.hits.platform });
      break;
    case "clear-hit-org":
      state.hits.org = "all";
      state.hits.page = 1;
      go("hits", { plan: state.hits.plan, staff: state.hits.staff, platform: state.hits.platform });
      break;
    case "clear-hit-platform":
      state.hits.platform = "all";
      state.hits.page = 1;
      go("hits", { plan: state.hits.plan, org: state.hits.org, staff: state.hits.staff });
      break;
    case "clear-hits":
      state.hits = { plan: "all", org: "all", staff: "all", platform: "all", page: 1 };
      go("hits", {});
      break;
    case "staff-prev":
      nextPage("staff", state.staff.page - 1);
      break;
    case "staff-next":
      nextPage("staff", state.staff.page + 1);
      break;
    case "hits-prev":
      nextPage("hits", state.hits.page - 1);
      break;
    case "hits-next":
      nextPage("hits", state.hits.page + 1);
      break;
    default:
      break;
  }
}

function exportScope(object) {
  if (state.route.view === "staff") return `618 家电焕新季 · ${PLAN_BY_ID[state.staff.plan].alias} · ${orgLabel(state.staff.org)}${state.staff.result !== "all" ? ` · ${resultText(state.staff.result)}` : ""}`;
  if (state.route.view === "hits") return `618 家电焕新季 · ${state.hits.plan === "all" ? "全部判定计划" : PLAN_BY_ID[state.hits.plan].alias} · ${orgLabel(state.hits.org)}`;
  return `618 家电焕新季 · ${SECTORS[state.sector].label} · ${isRestricted() ? "本分公司" : "全部组织"}`;
}

function handleChange(el) {
  const key = el.dataset.change;
  const value = el.value;
  switch (key) {
    case "set-role":
      setRole(value);
      break;
    case "set-demo":
      state.demo = value;
      render();
      break;
    case "reports-org":
      state.orgFilter = value;
      go("reports", { sector: state.sector, org: value });
      break;
    case "toggle-custom":
      state.showCustom = el.checked;
      render();
      break;
    case "staff-plan":
      state.staff.plan = value;
      state.staff.page = 1;
      go("staff", { plan: value, result: state.staff.result, org: state.staff.org, platform: state.staff.platform });
      break;
    case "staff-result":
      state.staff.result = value;
      state.staff.page = 1;
      go("staff", { plan: state.staff.plan, result: value, org: state.staff.org, platform: state.staff.platform });
      break;
    case "staff-org":
      state.staff.org = value;
      state.staff.page = 1;
      go("staff", { plan: state.staff.plan, result: state.staff.result, org: value, platform: state.staff.platform });
      break;
    case "staff-platform":
      state.staff.platform = value;
      state.staff.page = 1;
      go("staff", { plan: state.staff.plan, result: state.staff.result, org: state.staff.org, platform: value });
      break;
    case "hit-plan":
      state.hits.plan = value;
      state.hits.page = 1;
      go("hits", { plan: value, org: state.hits.org, staff: state.hits.staff, platform: state.hits.platform });
      break;
    case "hit-org":
      state.hits.org = value;
      state.hits.page = 1;
      go("hits", { plan: state.hits.plan, org: value, staff: state.hits.staff, platform: state.hits.platform });
      break;
    case "hit-platform":
      state.hits.platform = value;
      state.hits.page = 1;
      go("hits", { plan: state.hits.plan, org: state.hits.org, staff: state.hits.staff, platform: value });
      break;
    case "board-plan":
      state.board.plan = value;
      go("board", { plan: value, brand: state.board.brand });
      break;
    case "board-brand":
      state.board.brand = value;
      render();
      break;
    case "export-filter":
      state.exportFilter = value;
      render();
      break;
    case "noop":
      break;
    default:
      break;
  }
}

function render() {
  const view = state.route.view;
  let html = "";
  let page = "";
  if (view === "reports") page = reportsPage();
  else if (view === "staff") page = staffPage();
  else if (view === "hits") page = hitsPage();
  else if (view === "board") page = boardPage();
  else if (view === "metrics") page = metricsPage();
  else if (view === "exports") page = exportsPage();
  else page = reportsPage();

  document.getElementById("app").innerHTML = page;
  syncSelects();
}

function syncSelects() {
  document.querySelectorAll("[data-change='staff-org']").forEach((el) => {
    el.value = state.staff.org;
  });
  document.querySelectorAll("[data-change='hit-org']").forEach((el) => {
    el.value = state.hits.org;
  });
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;
  // 只有点在遮罩本身才关闭；点在弹窗 / 抽屉内容上不关闭
  if ((action === "close-modal" || action === "close-drawer") && event.target !== trigger) return;
  event.preventDefault();
  handleAction(action, trigger);
});

document.addEventListener("change", (event) => {
  const trigger = event.target.closest("[data-change]");
  if (!trigger) return;
  handleChange(trigger);
});

window.addEventListener("hashchange", () => {
  syncFromRoute();
  render();
});

syncFromRoute();
render();