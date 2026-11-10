// A 活动计划页面：计划列表 / 新建 / 详情 / 名单导入 / 批次 / 回收站 / 账号与监控。
// 只渲染；动作由 app.js 统一接管。

import { state } from "./store.js";
import {
  PLANS, TRASH, PARTICIPANTS, ROSTER, DOWNSTREAM, CHANGES, BATCHES, ACCOUNTS,
  SECTORS, PLATFORMS, BRANDS, PLAN_STATUS, ACCOUNT_STATUS, PRECHECK, OUTCOME,
  BATCH_REASON_LABEL,
  getPlan, getTrash, getBatch, getAccount, num,
} from "./data.js";
import {
  icon, esc, badge, planStatusBadge, accountStatusBadge, renderShell, stateAware,
  skeletonList, emptyState, deniedState, errorState, expiredState, processingBanner,
  dataCell, avatarFor, timeCell, roleBadge, filterToggle,
} from "./ui.js";

const currentUser = () => ({ platform_admin: "刘学奎", hq_manager: "王敏", branch_manager: "李强", store_staff: "张三" }[state.role]);

// 稳定码照原样保留，另外给一行人话（ui-foundation §6.6）。
function reasonCell(code) {
  if (!code || code === "—") return "—";
  const label = BATCH_REASON_LABEL[code] ?? code;
  return `<div class="reason-text">${esc(label)}</div><div class="reason-code">${esc(code)}</div>`;
}

function visiblePlans() {
  if (state.role === "platform_admin") return PLANS;
  if (state.role === "hq_manager") return PLANS.filter((p) => ["日立", "海信"].includes(p.brand));
  if (state.role === "branch_manager") return PLANS.filter((p) => p.id === "p1");
  return [];
}

function canOpenPlan(plan) {
  return visiblePlans().some((p) => p.id === plan.id);
}

function canEditPlan(plan) {
  return state.role === "platform_admin" || (state.role === "hq_manager" && plan.creator === currentUser());
}

function planFilterChips(group, values, current) {
  return values.map(([value, label]) => `
    <button type="button" class="chip ${current === value ? "active" : ""}" data-plan-filter="${group}" data-value="${esc(value)}">${esc(label)}</button>
  `).join("");
}

function planTable(rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="min-width:250px">计划</th>
            <th>品牌 · 平台</th>
            <th>板块</th>
            <th>起止</th>
            <th class="right">规模</th>
            <th class="right">负责人</th>
            <th>状态</th>
            <th class="right">操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((p) => `
            <tr class="clickable" data-href="#/plans/${p.id}">
              <td>${dataCell(p.name, `创建者 ${p.creator}`)}</td>
              <td class="nowrap"><span class="tag">${esc(p.brand)}</span> <span class="cell-sub" style="display:inline">${esc(p.platform)}</span></td>
              <td class="nowrap">${p.sectors.map((s) => `<span class="tag">${esc(s)}</span>`).join(" ")}</td>
              <td class="nowrap"><span class="num">${esc(p.start)}</span><br /><span class="cell-sub">${p.end ? `至 ${esc(p.end)}` : "无结束日"}</span></td>
              <td class="right nowrap"><span class="num">${num(p.accounts)}</span><br /><span class="cell-sub">${p.branches} 个分公司</span></td>
              <td class="right nowrap"><span class="num">${p.owners}/2</span><br /><span class="cell-sub">${p.pending} 待处理</span></td>
              <td>${planStatusBadge(p.status)}</td>
              <td class="right nowrap"><a class="btn btn-sm" href="#/plans/${p.id}">查看</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

export function renderPlans() {
  const plans = visiblePlans();
  const filtered = plans.filter((p) =>
    (state.planFilter.brand === "all" || p.brand === state.planFilter.brand) &&
    (state.planFilter.platform === "all" || p.platform === state.planFilter.platform) &&
    (state.planFilter.status === "all" || p.status === state.planFilter.status)
  );
  const totalAccounts = plans.reduce((sum, p) => sum + p.accounts, 0);
  const collecting = plans.filter((p) => p.status === "collecting").length;
  const branchCount = plans.reduce((sum, p) => sum + p.branches, 0);
  const pendingCount = plans.reduce((sum, p) => sum + p.pending, 0);
  const content = `
    <div class="page-head">
      <div>
        <h1 class="page-title">活动计划</h1>
        <p class="page-sub">按品牌、平台与状态筛选；计划创建即发布，品牌 / 平台 / 板块创建后不可修改。</p>
      </div>
      <div class="page-actions">
        ${["platform_admin", "hq_manager"].includes(state.role) ? `<a class="btn" href="#/trash">${icon("trash")} 回收站</a>` : ""}
        ${["platform_admin", "hq_manager"].includes(state.role) ? `<a class="btn btn-primary" href="#/plans/new">${icon("plus")} 新建计划</a>` : ""}
      </div>
    </div>

    <section class="summary-band" aria-label="计划概览">
      <div>
        <div class="summary-title">${plans.length} 个活动计划 · ${collecting} 个采集中</div>
      </div>
      <div class="summary-metrics">
        <div class="summary-metric"><span>${num(totalAccounts)}</span><small>名单账号</small></div>
        <div class="summary-metric"><span>${branchCount}</span><small>参与分公司</small></div>
        <div class="summary-metric"><span>${pendingCount}</span><small>待处理</small></div>
      </div>
    </section>

    ${filterToggle([state.planFilter.brand, state.planFilter.platform, state.planFilter.status].filter((v) => v !== "all").length)}
    <section class="filter-card ${state.filtersOpen ? "open" : ""}" aria-label="筛选">
      <div class="filter-line"><span class="filter-label">品牌</span>${planFilterChips("brand", [["all", "全部品牌"], ...BRANDS.map((b) => [b.name, b.name])], state.planFilter.brand)}</div>
      <div class="filter-line"><span class="filter-label">平台</span>${planFilterChips("platform", [["all", "全部平台"], ...PLATFORMS.map((p) => [p, p])], state.planFilter.platform)}</div>
      <div class="filter-line"><span class="filter-label">状态</span>${planFilterChips("status", [["all", "全部状态"], ["collecting", "采集中"], ["paused", "暂停"], ["archived", "归档"]], state.planFilter.status)}</div>
      <div class="selected-line">
        <span class="filter-label">已选条件</span>
        <span class="selected-chip">${state.planFilter.brand === "all" ? "全部品牌" : state.planFilter.brand}</span>
        <span class="selected-chip">${state.planFilter.platform === "all" ? "全部平台" : state.planFilter.platform}</span>
        <span class="selected-chip">${state.planFilter.status === "all" ? "全部状态" : PLAN_STATUS[state.planFilter.status]?.label}</span>
        <button type="button" class="btn btn-sm btn-ghost" data-action="clear-plan-filter">清空</button>
      </div>
    </section>

    <div class="result-bar">
      <span>共 <strong>${filtered.length}</strong> 个计划</span>
      <span class="hint">列表按创建时间倒序；只显示你数据范围内的计划。</span>
    </div>

    ${stateAware(filtered.length ? planTable(filtered) : emptyState({
      title: "还没有活动计划",
      text: "创建第一个计划，或切换品牌 / 状态筛选。",
      action: '<a class="btn btn-primary" href="#/plans/new">新建计划</a>',
    }), {
      empty: emptyState({ title: "还没有活动计划", text: "创建第一个计划，或切换品牌 / 状态筛选。", action: '<a class="btn btn-primary" href="#/plans/new">新建计划</a>' }),
    })}
  `;
  return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划"], content });
}

export function renderNewPlan() {
  if (state.role === "branch_manager" || state.role === "store_staff") {
    return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "新建计划"], content: deniedState("创建活动计划需要「创建计划」权限；分公司与门店没有该权限。") });
  }
  const content = `
    <a class="back-link" href="#/plans">${icon("arrowLeft")} 返回活动计划</a>
    <div class="page-head">
      <div>
        <h1 class="page-title">新建活动计划</h1>
        <p class="page-sub">创建即发布，没有草稿。品牌、平台、板块创建后不可修改。</p>
      </div>
    </div>
    <div class="wizard-layout">
      <form class="card card-pad wizard-main" data-form="create-plan">
      <div class="form-grid">
        <div class="field">
          <label for="np-brand">品牌 *</label>
          <select class="select" id="np-brand" required>
            <option value="">请选择品牌</option>
            ${BRANDS.map((b) => `<option>${esc(b.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="np-platform">平台 *</label>
          <select class="select" id="np-platform" required>
            <option value="">请选择平台</option>
            ${PLATFORMS.map((p) => `<option>${esc(p)}</option>`).join("")}
          </select>
        </div>
        <div class="field span-2">
          <label>板块 *（默认全选）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${SECTORS.map((s) => `<label class="chip" style="cursor:pointer"><input type="checkbox" checked value="${esc(s)}" style="accent-color:#0FA3A8" /> ${esc(s)}</label>`).join("")}
          </div>
          <span class="hint">板块是计划的范围属性；要停某个板块，暂停 / 归档或删除重建。</span>
        </div>
        <div class="field span-2">
          <label for="np-name">计划名称 *</label>
          <input class="input" id="np-name" maxlength="200" placeholder="例如：2026 双十一家装专项" required />
        </div>
        <div class="field span-2">
          <label for="np-desc">说明</label>
          <textarea class="textarea" id="np-desc" maxlength="2000" placeholder="仅作说明，不参与判定。"></textarea>
        </div>
        <div class="field">
          <label for="np-start">开始日期 *（北京时间自然日）</label>
          <input class="input" id="np-start" type="date" value="2026-11-08" required />
        </div>
        <div class="field">
          <label for="np-end">结束日期</label>
          <input class="input" id="np-end" type="date" />
          <span class="hint">留空表示无结束日，视为持续引用。</span>
        </div>
      </div>
      <div class="callout" style="margin-top:16px">${icon("sparkles")}<span>创建后返回「本计划需要 N 份监控判定计划：&lt;板块列表&gt;」；判定计划在「判定计划」页创建。</span></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <a class="btn" href="#/plans">取消</a>
        <button class="btn btn-primary" type="submit">${icon("check")} 创建并发布</button>
      </div>
      </form>
      <aside class="wizard-rail" aria-label="创建说明">
        <div class="rail-card">
          <div class="rail-kicker">创建之后</div>
          <div class="rail-title">创建即发布</div>
          <div class="rail-list">
            <div class="rail-row"><span>初始状态</span><strong>采集中</strong></div>
            <div class="rail-row"><span>名单</span><strong>从 0 开始</strong></div>
            <div class="rail-row"><span>判定计划</span><strong>按板块声明</strong></div>
          </div>
          <div class="rail-text">创建计划后只列出本计划需要的监控判定计划数量；判定计划在「判定计划」页创建。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">不可修改</div>
          <div class="rail-title">创建后不可修改</div>
          <div class="rail-text">品牌、平台、板块决定账号归属与判定口径。要调整范围，暂停 / 归档或删除重建，不在原计划上改。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">日期规则</div>
          <div class="rail-title">北京时间自然日</div>
          <div class="rail-text">结束日留空表示无结束日，视为持续引用；到期后名单保留，但不再计入引用。</div>
        </div>
      </aside>
    </div>
  `;
  return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "新建计划"], content });
}

export function renderPlanDetail(id) {
  const plan = getPlan(id);
  if (!plan || !canOpenPlan(plan)) {
    return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划"], content: deniedState("计划不存在，或不在你的数据范围内。对外一律表现为「未找到」。") });
  }
  const editable = canEditPlan(plan);
  const canUpload = plan.status === "collecting" && ["platform_admin", "hq_manager", "branch_manager"].includes(state.role);
  const tabs = [
    ["basic", "基本信息"], ["participants", "参与分公司"], ["roster", "名单"],
    ["downstream", "下游判定计划"], ["changes", "变更记录"],
  ];
  const tabContent = {
    basic: basicTab(plan),
    participants: participantsTab(plan, editable),
    roster: rosterTab(plan, canUpload),
    downstream: downstreamTab(plan),
    changes: changesTab(plan),
  }[state.planTab] ?? basicTab(plan);

  const content = `
    <a class="back-link" href="#/plans">${icon("arrowLeft")} 返回活动计划</a>
    <div class="page-head">
      <div>
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
          <h1 class="page-title">${esc(plan.name)}</h1>
          ${planStatusBadge(plan.status)}
        </div>
        <p class="page-sub">${esc(plan.brand)} · ${esc(plan.platform)} · ${esc(plan.sectors.join("、"))} · ${esc(plan.start)}${plan.end ? ` 至 ${esc(plan.end)}` : " 起（无结束日）"}</p>
      </div>
      <div class="page-actions">
        ${editable ? `<button class="btn" data-action="edit-plan" data-id="${plan.id}">${icon("edit")} 编辑</button>` : ""}
        ${editable && plan.status === "collecting" ? `<button class="btn" data-action="plan-status" data-status="paused" data-id="${plan.id}">${icon("pause")} 暂停</button>` : ""}
        ${editable && plan.status === "collecting" ? `<button class="btn" data-action="plan-status" data-status="archived" data-id="${plan.id}">${icon("archive")} 归档</button>` : ""}
        ${editable && plan.status !== "collecting" ? `<button class="btn" data-action="plan-status" data-status="collecting" data-id="${plan.id}">${icon("play")} 恢复</button>` : ""}
        ${editable ? `<button class="btn btn-danger" data-action="delete-plan" data-id="${plan.id}">${icon("trash")} 删除</button>` : ""}
        ${canUpload ? `<a class="btn btn-primary" href="#/plans/${plan.id}/import">${icon("upload")} 上传名单</a>` : ""}
      </div>
    </div>
    ${!editable ? `<div class="callout" style="margin-bottom:14px">${icon("lock")}<span>你可以在授权品牌内看到这个计划，但只有计划创建者或超管可以编辑、暂停 / 归档 / 删除、替换负责人。</span></div>` : ""}
    ${plan.status !== "collecting" ? `<div class="callout warn" style="margin-bottom:14px">${icon("lock")}<span>计划当前为「${PLAN_STATUS[plan.status].label}」：名单、参与关系与负责人已冻结；恢复为采集中后才能继续维护。</span></div>` : ""}

    <div class="detail-grid">
      <div class="card detail-main">
        <div class="tabs" role="tablist" aria-label="计划详情">
          ${tabs.map(([key, label]) => `<button type="button" role="tab" aria-selected="${state.planTab === key}" class="tab ${state.planTab === key ? "active" : ""}" data-plan-tab="${key}">${esc(label)}</button>`).join("")}
        </div>
        <div class="card-pad">${stateAware(tabContent)}</div>
      </div>
      <aside class="detail-rail" aria-label="计划上下文">
        ${planRail(plan)}
      </aside>
    </div>
  `;
  return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", plan.name], content });
}

function planRail(plan) {
  const first = (PARTICIPANTS[plan.id] ?? [])[0];
  const owners = (first?.owners ?? []).filter((x) => x !== "—");
  return `
    <div class="rail-card">
      <div class="rail-kicker">计划概览</div>
      <div class="rail-title">${esc(PLAN_STATUS[plan.status]?.label ?? plan.status)} · ${esc(plan.sectors.join("、"))}</div>
      <div class="rail-list">
        <div class="rail-row"><span>名单账号</span><strong class="num">${num(plan.accounts)}</strong></div>
        <div class="rail-row"><span>参与分公司</span><strong class="num">${plan.branches}</strong></div>
        <div class="rail-row"><span>待处理</span><strong class="num">${plan.pending}</strong></div>
        <div class="rail-row"><span>判定计划</span><strong class="num">${plan.needJudgement}</strong></div>
      </div>
      <div class="rail-text">${plan.end ? `结束日 ${esc(plan.end)}；暂停 / 归档 / 删除会冻结名单。` : "无结束日，视为持续引用。"}</div>
    </div>
    <div class="rail-card">
      <div class="rail-kicker">负责人</div>
      <div class="rail-title">${esc(first?.branch ?? "参与分公司")}</div>
      <div class="owner-stack">
        ${owners.length ? owners.map((n) => `<span class="owner-chip"><span class="mini-avatar">${esc(n.slice(0, 1))}</span>${esc(n)}</span>`).join("") : '<span class="rail-text">空槽，提交新增行时自动占用</span>'}
      </div>
      <div class="rail-text">每个（计划 × 分公司）最多 2 名负责人；负责人不是权限。</div>
      <button type="button" class="btn btn-sm" style="margin-top:10px" data-plan-tab="participants">查看参与分公司</button>
    </div>
    <div class="rail-card">
      <div class="rail-kicker">下游判定</div>
      <div class="rail-title">${plan.needJudgement} 份监控判定计划</div>
      <div class="rail-text">${esc(plan.sectors.join("、"))}；创建计划只声明需求，判定计划在「判定计划」页创建。</div>
      <button type="button" class="btn btn-sm" style="margin-top:10px" data-plan-tab="downstream">查看下游</button>
    </div>
  `;
}

function basicTab(plan) {
  return `
    <div class="stat-grid" style="margin-bottom:18px">
      <div class="stat"><div class="stat-label">名单账号</div><div class="stat-value">${num(plan.accounts)}</div><div class="stat-hint">只计数，不做比率</div></div>
      <div class="stat"><div class="stat-label">参与分公司</div><div class="stat-value">${plan.branches}</div><div class="stat-hint">同品牌、同平台均可参加</div></div>
      <div class="stat"><div class="stat-label">板块</div><div class="stat-value">${plan.sectors.length}</div><div class="stat-hint">${esc(plan.sectors.join("、"))}</div></div>
      <div class="stat"><div class="stat-label">待处理</div><div class="stat-value">${plan.pending}</div><div class="stat-hint">解析中 / 冲突 / 无效</div></div>
    </div>
    <div class="info-grid">
      <div><div class="info-label">品牌</div><div class="info-value">${esc(plan.brand)}</div></div>
      <div><div class="info-label">平台</div><div class="info-value">${esc(plan.platform)}</div></div>
      <div><div class="info-label">板块</div><div class="info-value">${esc(plan.sectors.join("、"))}</div></div>
      <div><div class="info-label">开始日期</div><div class="info-value num">${esc(plan.start)}</div></div>
      <div><div class="info-label">结束日期</div><div class="info-value num">${plan.end ? esc(plan.end) : "无结束日"}</div></div>
      <div><div class="info-label">创建者</div><div class="info-value">${esc(plan.creator)}</div></div>
      <div style="grid-column:1/-1"><div class="info-label">说明（仅作说明，不参与判定）</div><div class="info-value">${esc(plan.description || "—")}</div></div>
    </div>
    <div class="callout" style="margin-top:18px">${icon("clipboard")}<span>本计划需要 <strong>${plan.needJudgement}</strong> 份监控判定计划：${esc(plan.sectors.join("、"))}。创建计划只声明需求，判定计划在「判定计划」页创建。</span></div>
  `;
}

function participantsTab(plan, editable) {
  const rows = (PARTICIPANTS[plan.id] ?? []).filter((r) => state.role !== "branch_manager" || r.branch === "北京分公司");
  if (!rows.length) return emptyState({ title: "还没有分公司加入", text: "同品牌、同平台的所有分公司都可以加入；加入后由分公司提报名单。" });
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
      <div><div class="card-title">参与分公司与负责人</div><div class="card-sub">每个（计划 × 分公司）最多 2 名负责人；负责人不是权限。</div></div>
      ${editable ? `<button class="btn btn-sm" data-action="assign-owner" data-id="${plan.id}">${icon("users")} 指派 / 替换负责人</button>` : ""}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>分公司</th><th>状态</th><th>负责人槽位</th><th class="right">名单账号</th><th>加入时间</th><th class="right">操作</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${dataCell(r.branch)}</td>
              <td>${r.status === "joined" ? badge("已参加", "green") : badge("已退出", "gray")}</td>
              <td>
                <span class="tag">${esc(r.owners[0])}</span>
                <span class="tag">${esc(r.owners[1])}</span>
                ${r.owners.every((x) => x === "—") ? '<span class="cell-sub">空槽，提交新增行时自动占用</span>' : ""}
              </td>
              <td class="right num">${num(r.roster)}</td>
              <td class="num">${esc(r.joinedAt)}</td>
              <td class="right nowrap">
                ${r.status === "joined" ? `<button class="btn btn-sm" data-action="branch-exit" data-branch="${esc(r.branch)}">退出</button>` : `<button class="btn btn-sm" data-action="branch-join" data-branch="${esc(r.branch)}">重新加入</button>`}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="callout" style="margin-top:14px">${icon("alert")}<span>退出会把该分公司在本计划下全部「在名单」项置为「已移出活动计划」，释放负责人名额，并立即按引用计数检查账号监控；已采数据不删除。</span></div>
  `;
}

function rosterTab(plan, canUpload) {
  let rows = ROSTER[plan.id] ?? [];
  if (state.role === "branch_manager") rows = rows.filter((r) => r.store.startsWith("北京"));
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
      <div><div class="card-title">名单</div><div class="card-sub">按门店 · 专员 · 账号；分公司只看自己报的那部分。</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn btn-sm" href="#/batches">${icon("file")} 批次</a>
        ${canUpload ? `<a class="btn btn-sm btn-primary" href="#/plans/${plan.id}/import">${icon("upload")} 上传名单</a>` : ""}
      </div>
    </div>
    ${rows.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>门店 · 专员</th><th>手机号</th><th>账号</th><th>平台</th><th>综合状态</th><th>来源</th><th class="right">操作</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${dataCell(r.store, r.staff)}</td>
                <td class="num">${esc(r.phone)}</td>
                <td>${dataCell(r.account || "—", r.account ? "" : "尚未解析出账号")}</td>
                <td>${badge(r.platform, "plain")}</td>
                <td>${accountStatusBadge(r.status)}</td>
                <td>${dataCell(r.source, r.batch)}</td>
                <td class="right nowrap">
                  ${r.status === "removed" ? `<span class="cell-sub">已移出</span>` : `<button class="btn btn-sm" data-action="remove-roster" data-id="${r.id}">移出</button>`}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="callout" style="margin-top:14px">${icon("alert")}<span>名单项永不物理删除；移出后账号仅被本计划引用时立即关闭监控，仍被其他有效计划引用时保持开启。</span></div>
    ` : emptyState({ title: "名单为空", text: "上传名单后，预检只读、确认写入才会产生名单项。", action: canUpload ? `<a class="btn btn-primary" href="#/plans/${plan.id}/import">上传名单</a>` : "" })}
  `;
}

function downstreamTab(plan) {
  const rows = DOWNSTREAM[plan.id] ?? [];
  if (!rows.length) return emptyState({ title: "还没有判定计划", text: "按板块创建监控判定计划；创建计划只声明需求，判定计划在「判定计划」页创建。" });
  return `
    <div class="card-sub" style="margin-bottom:12px">每板块一份；这里只列出「已创建 / 待创建」，判定字段在判定计划页维护。</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
      ${rows.map((d) => `
        <div class="card card-pad">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div class="card-title">${esc(d.sector)}</div>
            ${d.status === "created" ? badge("已创建", "green") : badge("待创建", "amber")}
          </div>
          <div class="cell-sub" style="margin-top:6px">${esc(d.name)}</div>
          <div class="info-grid" style="grid-template-columns:1fr 1fr;margin-top:12px">
            <div><div class="info-label">结果数</div><div class="info-value num">${num(d.results)}</div></div>
            <div><div class="info-label">在途执行</div><div class="info-value num">${d.running}</div></div>
          </div>
          <div style="margin-top:12px"><a class="btn btn-sm" href="#/judgement">去判定计划查看</a></div>
        </div>
      `).join("")}
    </div>
  `;
}

function changesTab(plan) {
  const rows = CHANGES[plan.id] ?? [];
  if (!rows.length) return emptyState({ title: "还没有变更", text: "创建、编辑、状态变化、参与关系、负责人和名单变更会记录在这里；计划清除时一并清除。" });
  return `
    <div class="timeline">
      ${rows.map((c) => `
        <div class="timeline-item">
          <div class="timeline-time">${esc(c.time)}</div>
          <div><div class="timeline-title">${esc(c.title)} · ${esc(c.actor)}</div><div class="timeline-text">${esc(c.text)}</div></div>
        </div>
      `).join("")}
    </div>
  `;
}

export function renderTrash() {
  if (state.role === "store_staff" || state.role === "branch_manager") {
    return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "回收站"], content: deniedState("回收站只对计划创建者与超管开放。") });
  }
  const content = `
    <a class="back-link" href="#/plans">${icon("arrowLeft")} 返回活动计划</a>
    <div class="page-head">
      <div><h1 class="page-title">回收站</h1><p class="page-sub">已删除计划保留 30 天；期间不出现在列表、详情、名单读取与批次查询中。</p></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>计划</th><th>品牌 · 平台</th><th>删除前状态</th><th>删除时间</th><th>清除时间</th><th class="right">规模</th><th class="right">操作</th></tr></thead>
        <tbody>
          ${TRASH.filter((p) => state.role === "platform_admin" || p.creator === currentUser()).map((p) => `
            <tr>
              <td>${dataCell(p.name, `创建者 ${p.creator}`)}</td>
              <td><span class="tag">${esc(p.brand)}</span> <span class="cell-sub" style="display:inline">${esc(p.platform)}</span></td>
              <td>${planStatusBadge(p.statusBefore)}</td>
              <td class="num">${esc(p.deletedAt)}</td>
              <td class="num">${esc(p.purgeAt)}</td>
              <td class="right num">${num(p.accounts)}</td>
              <td class="right"><button class="btn btn-sm" data-action="restore-plan" data-id="${p.id}">恢复</button></td>
            </tr>
          `).join("") || `<tr><td colspan="7">${emptyState({ title: "回收站为空", text: "删除的计划会在这里保留 30 天。" })}</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="callout" style="margin-top:14px">${icon("alert")}<span>恢复后回到删除前状态；因无引用关闭的账号会按引用规则重开，人工关闭与上级关闭的不动。</span></div>
  `;
  return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "回收站"], content });
}

/* ---------- 名单导入向导 ---------- */

export function renderImportWizard(planId) {
  const plan = getPlan(planId);
  if (!plan || !canOpenPlan(plan)) {
    return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "名单导入"], content: deniedState("计划不存在，或不在你的数据范围内。") });
  }
  if (plan.status !== "collecting") {
    return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", plan.name, "名单导入"], content: stateAware(`<div class="callout warn">${icon("lock")}<span>计划当前为「${PLAN_STATUS[plan.status].label}」，名单与负责人已冻结；恢复为采集中后才能导入。</span></div>`) });
  }
  const step = state.importStep;
  const stepDefs = [["1", "选择计划"], ["2", "下载模板"], ["3", "上传与预检"], ["4", "确认写入"], ["5", "批次详情"]];
  const body = step === 3 ? importUploadStep() : step === 4 ? importConfirmStep(plan) : step === 5 ? batchContent(BATCHES.b1) : importPlanStep(plan);
  const content = `
    <a class="back-link" href="#/plans/${plan.id}">${icon("arrowLeft")} 返回计划详情</a>
    <div class="page-head">
      <div><h1 class="page-title">名单导入</h1><p class="page-sub">${esc(plan.name)} · 名单导入：预检只读，确认后才写入业务表。</p></div>
      <div class="page-actions"><span class="tag">${esc(plan.platform)}</span><span class="tag">${esc(plan.sectors.join("、"))}</span></div>
    </div>
    <div class="wizard-layout">
      <div class="card wizard-main">
        <div class="steps" aria-label="导入步骤">
          ${stepDefs.map(([n, label], i) => `<div class="step ${Number(n) < step ? "done" : ""} ${Number(n) === step ? "active" : ""}"><span class="step-num">${n}</span>${esc(label)}</div>`).join("")}
        </div>
        <div class="card-pad">${stateAware(body, { empty: importEmptyState(plan) })}</div>
      </div>
      <aside class="wizard-rail" aria-label="导入上下文">
        ${importRail(plan)}
      </aside>
    </div>
  `;
  return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", plan.name, "名单导入"], content });
}

function importRail(plan) {
  return `
    <div class="rail-card">
      <div class="rail-kicker">目标计划</div>
      <div class="rail-title">${esc(plan.name)}</div>
      <div class="rail-list">
        <div class="rail-row"><span>品牌</span><strong>${esc(plan.brand)}</strong></div>
        <div class="rail-row"><span>平台</span><strong>${esc(plan.platform)}</strong></div>
        <div class="rail-row"><span>板块</span><strong>${esc(plan.sectors.join("、"))}</strong></div>
        <div class="rail-row"><span>当前名单</span><strong class="num">${num(plan.accounts)}</strong></div>
      </div>
    </div>
    <div class="rail-card">
      <div class="rail-kicker">限额</div>
      <div class="rail-list">
        <div class="rail-row"><span>数据行</span><strong>≤ 2,000</strong></div>
        <div class="rail-row"><span>文件大小</span><strong>≤ 10 MB</strong></div>
        <div class="rail-row"><span>单批时长</span><strong>≤ 10 分钟</strong></div>
        <div class="rail-row"><span>将新建专员</span><strong>≤ 1,000</strong></div>
      </div>
    </div>
    <div class="rail-card">
      <div class="rail-kicker">负责人名额</div>
      <div class="rail-title">提交新增行时占用</div>
      <div class="rail-text">持有「加入活动计划」权限且分公司范围不是「全部」的提交人，在确认写入时若批次包含可能新增的行，占用一个负责人槽；已满则整批失败。</div>
    </div>
    <div class="callout" style="font-size:11px">${icon("shield")}<span>预检只读；确认后才写专员、名单与解析任务。</span></div>
  `;
}

function importPlanStep(plan) {
  return `
    <div class="callout" style="margin-bottom:14px">${icon("file")}<span>当前计划：<strong>${esc(plan.name)}</strong> · ${esc(plan.brand)} · ${esc(plan.platform)}。名单模板没有平台列，平台由计划带出。</span></div>
    <div class="info-grid">
      <div><div class="info-label">模板版本</div><div class="info-value">roster-import.v1</div></div>
      <div><div class="info-label">列</div><div class="info-value">门店编码 / 专员姓名 / 手机号 / 主页链接</div></div>
      <div><div class="info-label">上限</div><div class="info-value">2,000 行 / 10 MB / 单批 ≤ 10 分钟</div></div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px"><button class="btn btn-primary" data-action="import-next">${icon("arrowRight")} 下一步</button></div>
  `;
}

function importEmptyState(plan) {
  return emptyState({ title: "还没有可导入的计划", text: "计划不存在、已暂停或不在你的范围内。", action: `<a class="btn" href="#/plans">返回活动计划</a>` });
}

function importUploadStep() {
  if (!state.importUploaded) {
    return `
      <div class="dropzone">
        <div class="state-icon">${icon("upload")}</div>
        <strong>上传名单 CSV</strong>
        <p class="hint">固定 4 列：门店编码、专员姓名、手机号、主页链接。表头会自动跳过；与模板示例行完全相同的数据行会标为「示例行」，不进入数据。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px">
          <button class="btn btn-primary" data-action="mock-upload">${icon("upload")} 选择文件</button>
          <a class="btn" href="#/plans/p1/import" data-action="download-template">${icon("download")} 下载模板</a>
        </div>
        <p class="hint">Excel 编辑后请另存为 CSV；门店编码、手机号先设为文本格式，避免前导零丢失。</p>
      </div>
    `;
  }
  if (state.demoState === "error") {
    return `
      <div class="card" style="box-shadow:none">
        <div class="state">
          <div class="state-icon">${icon("alert")}</div>
          <div class="state-title">文件级校验失败，未创建批次</div>
          <p class="state-text">表头与模板不一致：缺少「主页链接」，多出「平台」。请下载当前模板（roster-import.v1）后重新上传。</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
            <button class="btn" data-action="mock-reset-upload">重新上传</button>
            <button class="btn" data-action="download-template">${icon("download")} 下载模板</button>
          </div>
        </div>
      </div>
    `;
  }
  const b = BATCHES.b1;
  return `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
      <div>
        <div class="card-title">预检报告</div>
        <div class="card-sub">${esc(b.file)} · 1.8 MB · 数据行 200</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" data-action="download-return">${icon("download")} 下载回流文件</button>
        <button class="btn btn-sm btn-primary" data-action="import-next">确认写入 ${icon("arrowRight")}</button>
      </div>
    </div>
    <div class="stat-grid five" style="margin-bottom:14px">
      ${[
        ["可写入", b.precheck.new, "green"], ["将新建专员", b.precheck.new_staff, "blue"],
        ["恢复", b.precheck.update, "amber"], ["未变", b.precheck.unchanged, "plain"], ["错误", b.precheck.error, "red"],
      ].map(([label, value, tone]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${num(value)}</div><div class="stat-hint">${tone === "red" ? "需修改后重传" : tone === "blue" ? "确认后新建" : "预检分类"}</div></div>`).join("")}
    </div>
    <div class="callout" style="margin-bottom:14px">${icon("shield")}<span>预检只读：专员、账号、归属、名单、负责人的行数都没有变化；没有调用供应商接口。示例行和表头不产生行结果。</span></div>
    <div class="table-wrap precheck-table">
      <table>
        <thead><tr><th>行</th><th>门店 · 专员</th><th>手机号</th><th>主页入口</th><th>预检</th><th>结果与原因</th></tr></thead>
        <tbody>
          ${b.results.map((r) => `
            <tr>
              <td class="num">${r.row}</td>
              <td>${dataCell(r.store, r.staff)}</td>
              <td class="num">${esc(r.phone)}</td>
              <td class="locator">${esc(r.locator)}</td>
              <td>${badge(PRECHECK[r.cls]?.label ?? r.cls, PRECHECK[r.cls]?.tone ?? "plain")}</td>
              <td>${reasonCell(r.reason)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="callout" style="margin-top:14px">${icon("alert")}<span>确认写入后会：自动新建 6 名专员；本地能命中的账号直接引用；其余 66 行进入「解析中」，等待解析出账号。名额按本地可知事实占用。</span></div>
  `;
}

function importConfirmStep(plan) {
  const b = BATCHES.b1;
  return `
    <div class="card-pad" style="padding:0">
      <div class="callout warn" style="margin-bottom:14px">${icon("alert")}<span>确认后是本批次唯一的写入点；写入分块执行，中断后可续跑。确认前请核对负责人名额与计划状态。</span></div>
      <div class="info-grid">
        <div><div class="info-label">计划</div><div class="info-value">${esc(plan.name)}</div></div>
        <div><div class="info-label">批次</div><div class="info-value">${esc(b.id)}</div></div>
        <div><div class="info-label">提交分公司</div><div class="info-value">${esc(b.branch)}</div></div>
        <div><div class="info-label">将新建专员</div><div class="info-value num">${b.precheck.new_staff}</div></div>
        <div><div class="info-label">名单写入 / 恢复</div><div class="info-value num">${b.precheck.new + b.precheck.update}</div></div>
        <div><div class="info-label">账号解析任务</div><div class="info-value num">${b.precheck.possible_new_accounts}</div></div>
        <div><div class="info-label">负责人名额</div><div class="info-value">${b.confirm.owner_claimed ? "将占用 1 个槽位" : "不占用"}</div></div>
        <div><div class="info-label">错误行</div><div class="info-value num">${b.precheck.error}</div></div>
        <div><div class="info-label">预检时名单数 → 预计</div><div class="info-value num">842 → ${842 + b.precheck.new + b.precheck.update}</div></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button class="btn" data-action="import-prev">上一步</button>
        <button class="btn btn-primary" data-action="confirm-import">${icon("check")} 确认写入</button>
      </div>
    </div>
  `;
}

/* ---------- 批次 ---------- */

export function renderBatchList() {
  const rows = Object.values(BATCHES).filter((b) => state.role !== "branch_manager" || b.branch === "北京分公司");
  const content = `
    <a class="back-link" href="#/plans">${icon("arrowLeft")} 返回活动计划</a>
    <div class="page-head">
      <div><h1 class="page-title">导入批次</h1><p class="page-sub">预检只读、确认写入、解析归并；批次与行结果是历史事实，计划清除后仍保留。</p></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>批次</th><th>计划 / 文件</th><th>提交人</th><th>时间</th><th>状态</th><th class="right">结果计数</th><th class="right">操作</th></tr></thead>
        <tbody>
          ${rows.map((b) => `
            <tr>
              <td>${dataCell(b.id, b.branch)}</td>
              <td>${dataCell(b.planName, b.file)}</td>
              <td>${esc(b.submitter)}</td>
              <td class="num">${esc(b.uploadedAt)}</td>
              <td>${b.status === "resolving" ? badge("解析中", "amber") : b.status === "completed" ? badge("已完成", "green") : badge(b.status, "plain")}</td>
              <td class="right"><span class="num">${b.confirm.imported + b.confirm.unchanged}</span><br /><span class="cell-sub">成功 / 冲突 ${b.confirm.conflict} / 解析中 ${b.confirm.pending_account}</span></td>
              <td class="right"><a class="btn btn-sm" href="#/batches/${b.id}">查看</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "导入批次"], content });
}

export function renderBatchDetail(id) {
  const b = getBatch(id);
  if (!b) {
    return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "批次"], content: emptyState({ title: "批次不存在", text: "范围外批次按「未找到」处理。" }) });
  }
  const content = `
    <a class="back-link" href="#/plans/${b.planId}">${icon("arrowLeft")} 返回计划详情</a>
    <div class="page-head">
      <div><h1 class="page-title">批次 ${esc(b.id)}</h1><p class="page-sub">${esc(b.planName)} · ${esc(b.file)} · ${esc(b.uploadedAt)} · ${esc(b.submitter)}</p></div>
      <div class="page-actions">
        ${b.status === "resolving" ? badge("解析中", "amber") : badge("已完成", "green")}
        <button class="btn" data-action="refresh-batch">${icon("refresh")} 刷新</button>
        <button class="btn" data-action="download-return">${icon("download")} 回流文件</button>
      </div>
    </div>
    ${stateAware(batchContent(b))}
  `;
  return renderShell({ activeNav: "plans", breadcrumb: ["工作区", "活动计划", "批次", b.id], content });
}

function batchContent(b) {
  const total = Math.max(b.rows, 1);
  const processed = Math.max(0, total - b.confirm.pending_account);
  const percent = Math.min(100, Math.round((processed / total) * 100));
  return `
    <div class="rail-card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div><div class="rail-kicker">解析进度</div><div class="rail-title">${b.confirm.pending_account > 0 ? `解析中 ${b.confirm.pending_account} 行` : "全部行已终态"}</div></div>
        <strong class="num" style="font-size:20px;color:var(--brand-deep)">${percent}%</strong>
      </div>
      <div class="progress-track" style="margin-top:10px"><div class="progress-bar" style="width:${percent}%"></div></div>
      <div class="rail-text">${processed} / ${total} 行已有终态；解析驱动只调用主页信息接口，不触发列表。</div>
    </div>
    <div class="section-note">行结果 · 共 ${num(b.rows)} 行</div>
    <div class="stat-grid" style="margin-bottom:14px">
      ${[
        ["已导入", b.confirm.imported], ["已存在并引用", b.confirm.unchanged],
        ["归属冲突", b.confirm.conflict], ["链接无效", b.confirm.invalid],
        ["疑似空账号", b.confirm.suspected_empty], ["解析失败", b.confirm.resolve_failed],
        ["新建专员", b.confirm.staff_created],
      ].map(([label, value]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${num(value)}</div></div>`).join("")}
    </div>
    ${b.confirm.pending_account > 0 ? `<div class="callout warn" style="margin-bottom:14px">${icon("clock")}<span>仍在解析的行由系统逐条处理；只读取主页信息，不触发列表采集。批次完成后，会对「已存在并引用」的账号补抓一次（距上次采集满 7 天）。</span></div>` : ""}
    ${b.results.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>行</th><th>门店 · 专员</th><th>手机号</th><th>预检</th><th>结果</th><th>原因</th></tr></thead>
          <tbody>
            ${b.results.map((r) => `
              <tr>
                <td class="num">${r.row}</td>
                <td>${dataCell(r.store, r.staff)}</td>
                <td class="num">${esc(r.phone)}</td>
                <td>${badge(PRECHECK[r.cls]?.label ?? r.cls, PRECHECK[r.cls]?.tone ?? "plain")}</td>
                <td>${r.outcome === "—" ? "—" : badge(OUTCOME[r.outcome]?.label ?? r.outcome, OUTCOME[r.outcome]?.tone ?? "plain")}</td>
                <td>${reasonCell(r.reason)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : emptyState({ title: "这个批次没有逐行明细", text: "批次已完成；行结果与批次同寿命保留。", action: '<a class="btn" href="#/batches">返回批次列表</a>' })}
  `;
}

/* ---------- 账号与监控 ---------- */

const ACCOUNT_TONE = {
  normal: "green", suspected_empty: "amber", invalid: "red", store_closed: "gray", staff_inactive: "gray",
  account_manual: "gray", account_unreferenced: "gray", removed: "gray",
};

function visibleAccounts() {
  let rows = ACCOUNTS;
  if (state.role === "hq_manager") rows = rows.filter((a) => ["日立", "海信"].includes(a.brand));
  if (state.role === "branch_manager") rows = rows.filter((a) => a.branch === "北京分公司");
  if (state.accountFilter.status !== "all") rows = rows.filter((a) => a.status === state.accountFilter.status);
  if (state.accountFilter.platform !== "all") rows = rows.filter((a) => a.platform === state.accountFilter.platform);
  return rows;
}

export function renderAccounts() {
  if (state.role === "store_staff") {
    return renderShell({ activeNav: "accounts", breadcrumb: ["工作区", "账号与监控"], content: deniedState("门店专员没有管理端「账号与监控」入口。") });
  }
  const rows = visibleAccounts();
  const selected = rows.find((a) => a.id === state.selectedAccountId) ?? rows[0] ?? null;
  if (selected) state.selectedAccountId = selected.id;
  const content = `
    <div class="page-head">
      <div><h1 class="page-title">账号与监控</h1><p class="page-sub">账号的监控状态是全局的；名单是分计划的。综合状态按优先级取第一条命中。</p></div>
      <div class="page-actions"><button class="btn" data-action="batch-monitor">${icon("sliders")} 批量监控开关</button></div>
    </div>
    <section class="summary-band" aria-label="账号概览">
      <div>
        <div class="summary-title">${rows.length} 个账号 · ${rows.filter((a) => a.status === "normal").length} 个正常采集</div>
        <div class="summary-sub">综合状态取第一条命中；实际监控 = 账号开关 ∧ 上级链有效 ∧ 录入状态正常。</div>
      </div>
      <div class="summary-metrics">
        <div class="summary-metric"><span>${rows.filter((a) => a.status === "normal").length}</span><small>正常采集</small></div>
        <div class="summary-metric"><span>${rows.filter((a) => a.status === "suspected_empty").length}</span><small>疑似空账号</small></div>
        <div class="summary-metric"><span>${rows.filter((a) => !a.monitoring).length}</span><small>被停止监控</small></div>
      </div>
    </section>
    ${filterToggle([state.accountFilter.status, state.accountFilter.platform].filter((v) => v !== "all").length)}
    <section class="filter-card ${state.filtersOpen ? "open" : ""}">
      <div class="filter-line"><span class="filter-label">状态</span>
        ${[["all", "全部"], ["normal", "正常采集"], ["suspected_empty", "疑似空账号"], ["account_unreferenced", "被停止监控"], ["store_closed", "门店已撤"], ["staff_inactive", "专员已停用"], ["invalid", "链接无效"]].map(([v, l]) => `<button class="chip ${state.accountFilter.status === v ? "active" : ""}" data-account-filter="status" data-value="${v}">${l}</button>`).join("")}
      </div>
      <div class="filter-line"><span class="filter-label">平台</span>
        ${[["all", "全部平台"], ...PLATFORMS.map((p) => [p, p])].map(([v, l]) => `<button class="chip ${state.accountFilter.platform === v ? "active" : ""}" data-account-filter="platform" data-value="${v}">${l}</button>`).join("")}
      </div>
    </section>
    <div class="result-bar"><span>共 <strong>${rows.length}</strong> 个账号</span><span class="hint">综合状态：链接无效 → 疑似空账号 → 品牌被关闭 → 被停止监控 → 已移出活动计划 → 正常采集。</span></div>
    ${stateAware(rows.length ? `
      <div class="split-view">
        <div class="split-main">
          <div class="table-wrap">
            <table>
              <thead><tr><th>账号</th><th>专员 · 门店</th><th>综合状态</th><th>监控</th><th>最近同步</th></tr></thead>
              <tbody>
                ${rows.map((a) => `
                  <tr class="clickable ${selected?.id === a.id ? "selected-row" : ""}" data-action="select-account" data-id="${a.id}">
                    <td><div style="display:flex;align-items:center;gap:9px">${avatarFor(a.nickname)}<div>${dataCell(a.nickname, `${a.platform} · ${a.fans} 粉丝 · ${a.works} 作品`)}</div></div></td>
                    <td>${dataCell(a.staff, `${a.store} · ${a.branch}`)}</td>
                    <td>${badge(ACCOUNT_STATUS[a.status]?.label ?? a.status, ACCOUNT_TONE[a.status] ?? "gray")}${ACCOUNT_STATUS[a.status]?.note ? `<div class="cell-sub">${ACCOUNT_STATUS[a.status].note}</div>` : ""}</td>
                    <td>${a.monitoring ? badge("开启", "green") : badge("关闭", "gray")}</td>
                    <td class="num">${esc(a.lastSync)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
        <aside class="split-side" aria-label="账号详情">
          <div class="split-side-head">
            <div class="split-side-title">账号详情</div>
          </div>
          ${accountModalHtml(selected)}
        </aside>
      </div>
    ` : emptyState({ title: "没有符合条件的账号", text: "切换状态或平台筛选，或检查数据范围。" }))}
  `;
  return renderShell({ activeNav: "accounts", breadcrumb: ["工作区", "账号与监控"], content });
}

export function accountModalHtml(account) {
  const role = state.role;
  const canManage = role === "platform_admin" || role === "hq_manager" || role === "branch_manager";
  const canDealer = role === "platform_admin";
  const canAccount = account.branch === "北京分公司" || role !== "branch_manager";
  const switchHtml = (label, on, disabled, note = "") => `
    <div class="list-row">
      <div style="flex:1"><div class="cell-main">${esc(label)}</div>${note ? `<div class="cell-sub">${esc(note)}</div>` : ""}</div>
      <button type="button" class="switch ${on ? "on" : ""}" ${disabled ? "disabled" : ""} data-action="toggle-switch" aria-pressed="${on}" aria-label="${esc(label)}"><span></span></button>
    </div>
  `;
  return `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      ${avatarFor(account.nickname)}
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><strong style="font-size:15px">${esc(account.nickname)}</strong>${accountStatusBadge(account.status)}</div>
        <div class="cell-sub" style="margin-top:3px">${esc(account.platform)} · ${esc(account.brand)} · ${esc(account.branch)}</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${account.status === "suspected_empty" ? `<button class="btn btn-primary" data-action="confirm-empty" data-id="${account.id}">${icon("check")} 确认疑似空账号</button>` : ""}
      <button class="btn" data-action="manual-sync" data-id="${account.id}">${icon("refresh")} 手工补抓</button>
      <button class="btn" data-action="remove-account" data-id="${account.id}">${icon("x")} 移出名单</button>
    </div>
    <div class="info-grid" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
      <div><div class="info-label">专员 / 门店</div><div class="info-value">${esc(account.staff)} · ${esc(account.store)}</div></div>
      <div><div class="info-label">最近同步</div><div class="info-value num">${esc(account.lastSync)}</div></div>
      <div><div class="info-label">录入状态</div><div class="info-value">${account.intake === "normal" ? "正常录入" : "疑似空账号"}</div></div>
      <div><div class="info-label">账号粉丝 / 作品</div><div class="info-value num">${esc(account.fans)} / ${account.works}</div></div>
    </div>
    <div class="callout ${account.status === "suspected_empty" ? "warn" : ""}" style="margin-bottom:14px">${icon(account.status === "suspected_empty" ? "alert" : "activity")}<span>${account.status === "suspected_empty" ? "疑似空账号不关闭监控开关，但不进入常规采集；人工确认后改为正常录入。" : account.status === "invalid" ? "链接无效不建账号；需要业务修改回流文件后重新提交。" : "实际监控 = 账号开关打开 ∧ 上级链有效 ∧ 录入状态为正常录入。"}</span></div>
    <div class="card" style="box-shadow:none">
      <div class="card-head"><div><div class="card-title">监控开关链</div><div class="card-sub">上级关闭优先；下级打开不能覆盖上级关闭。</div></div></div>
      <div class="card-pad" style="padding-top:4px;padding-bottom:4px">
        ${switchHtml("分公司", true, !canManage || !account.branch, account.branch)}
        ${switchHtml("经销商", true, !canDealer, canDealer ? "经销商级仅超管可改" : "仅超管可改")}
        ${switchHtml("门店", account.status !== "store_closed", !canManage, account.store)}
        ${switchHtml("专员", account.status !== "staff_inactive", !canManage, account.staff)}
        ${switchHtml("账号", account.monitoring, !canAccount, account.reason === "manual" ? "人工关闭" : account.reason === "unreferenced_15d" ? "15 天无引用自动关闭" : "账号级开关")}
      </div>
    </div>
  `;
}