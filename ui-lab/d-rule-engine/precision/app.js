// 判定计划原型 · 路由、视图与交互（2026-11-12）
import {
  ACTIVITY_PLANS, JUDGEMENT_PLANS, VERSIONS, EXECUTIONS, DEFAULT_CONFIG, EMPTY_CONFIG,
  CIRCLE_RESULT, TRIAL, participantsFor, contentsFor, methodLabel,
} from "./data.js?v=precision-15";
import { esc, badge, resultBadge, statusBadge, waitingLabel, icon, navFor, methodLabel as mLabel } from "./ui.js?v=precision-15";

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowText = () => "2026-06-13 10:24";

const state = {
  role: "platform_admin",
  demo: "normal",
  asrEnabled: false,
  plans: clone(JUDGEMENT_PLANS).map((p) => p.wizardStep === "circled" && !p.circle ? { ...p, circle: clone(CIRCLE_RESULT) } : p),
  executions: clone(EXECUTIONS),
  versions: clone(VERSIONS),
  created: [],
  route: parseHash(),
  busy: null,
  modal: null,
  drawer: null,
  expandedContent: null,
  capabilityMenu: null,
  layer2Menu: null,
  layer3Menu: null,
  filterActivity: "all",
  filterStatus: "all",
  filterRun: "all",
  participantFilter: "all",
  showAllParticipants: false,
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "executions") return { view: "executions", id: parts[1] ? Number(parts[1]) : null };
  if (parts[0] === "results") return { view: "results", executionId: Number(parts[1]) };
  if (parts[0] === "judgement") {
    if (!parts[1]) return { view: "judgement-list" };
    if (parts[2] === "wizard") return { view: "wizard", id: parts[1], step: Number(parts[3]) || 1 };
    return { view: "judgement-detail", id: parts[1] };
  }
  return { view: "judgement-list" };
}

function navigate(hash) {
  if (location.hash === hash) {
    state.route = parseHash();
    render();
  } else {
    location.hash = hash;
  }
}

function findPlan(id) { return state.plans.find((p) => p.id === id); }
function findExecution(id) { return state.executions.find((e) => e.id === Number(id)); }
function activityOf(plan) { return ACTIVITY_PLANS.find((a) => a.id === plan.activityPlanId); }
function versionsOf(id) { return state.versions[id] ?? []; }
function executionsOf(id) { return state.executions.filter((e) => e.planId === id).sort((a, b) => b.id - a.id); }
function canWrite(plan) {
  if (state.role === "platform_admin") return true;
  if (state.role === "hq_manager") return true; // 原型里的刘学奎是活动计划创建者
  return false;
}
function canEnter() { return state.role !== "store_staff"; }

function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function costChip(label, tone = "plain") { return `<span class="chip ${tone}">${esc(label)}</span>`; }
function currentDraft(plan) { return plan.draftVersion ? versionsOf(plan.id).find((v) => v.version === plan.draftVersion) : null; }
function latestPublished(plan) { return plan.publishedVersion ?? null; }
function latestCompleted(plan) {
  return executionsOf(plan.id).find((e) => e.status === "completed") ?? null;
}
function planActivityName(plan) { return activityOf(plan)?.name ?? "—"; }
function isArchived(plan) { return plan.status === "archived"; }
function isDraft(plan) { return Boolean(plan.draftVersion); }

/* ---------------- shell ---------------- */

function shell(content, crumbs, activeKey = "judgement") {
  const role = state.role;
  const groups = navFor(role);
  const topPlan = findPlan(state.route.id) ?? state.plans[0];
  const topAct = topPlan ? activityOf(topPlan) : null;
  const nav = groups.map((g) => `
    <div class="nav-group">
      <div class="nav-label">${esc(g.label)}</div>
      ${g.items.map((i) => {
        const active = i.key === activeKey;
        const disabled = i.key !== "judgement" && i.key !== "store";
        return `<a class="nav-item ${active ? "active" : ""} ${disabled ? "disabled" : ""}" href="${disabled ? "javascript:void(0)" : `#/${i.key === "judgement" ? "judgement" : i.key}`}" data-action="${disabled ? "toast-module" : "nav"}" data-module="${esc(i.label)}" ${disabled ? 'aria-disabled="true"' : ""}>${icon(i.icon, 16)}<span>${esc(i.label)}</span></a>`;
      }).join("")}
    </div>`).join("");

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
          <select data-action="set-role" aria-label="切换角色">
            ${Object.entries({ platform_admin: "平台超管", hq_manager: "总部人员", branch_manager: "分公司人员（只读）", store_staff: "门店专员（无入口）" })
              .map(([k, v]) => `<option value="${k}" ${role === k ? "selected" : ""}>${v}</option>`).join("")}
          </select>
        </div>
        <div class="demo-box">
          <div class="demo-label">演示状态</div>
          <select data-action="set-demo" aria-label="切换演示状态">
            ${[["normal", "正常"], ["loading", "加载中"], ["empty", "空结果"], ["error", "加载失败"], ["noaccess", "无权限"]]
              .map(([k, v]) => `<option value="${k}" ${state.demo === k ? "selected" : ""}>${v}</option>`).join("")}
          </select>
          <label class="checkline" style="margin-top:8px;font-size:11.5px">
            <input type="checkbox" data-action="toggle-asr" ${state.asrEnabled ? "checked" : ""} />
            音频理解已启用（演示）
          </label>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="crumbs">${crumbs}</div>
        <div class="top-actions">
          <span class="brand-pill"><span class="dot"></span>${esc(topAct?.brand ?? "海信")} · ${esc(topAct?.platform ?? "抖音")}</span>
          <span class="tag">${esc({ platform_admin: "平台超管", hq_manager: "总部人员", branch_manager: "分公司（只读）", store_staff: "门店专员" }[role])}</span>
        </div>
      </header>
      <main class="page">${content}</main>
    </div>
  </div>
  ${state.modal ? renderModal() : ""}
  ${state.drawer ? renderDrawer() : ""}`;
}

function crumbs(items) {
  return items.map((x, i) => i === items.length - 1 ? `<b>${esc(x)}</b>` : `<span>${esc(x)}</span>${icon("chevronRight", 12)}`).join("");
}

function pageHead(title, sub, actions = "") {
  return `<div class="page-head"><div><div class="page-title">${title}</div>${sub ? `<div class="page-sub">${sub}</div>` : ""}</div><div class="page-actions">${actions}</div></div>`;
}

function stat(label, value, note = "", tone = "") {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value ${tone}">${value}</div>${note ? `<div class="stat-note">${esc(note)}</div>` : ""}</div>`;
}

/* ---------------- 列表 ---------------- */

function listView() {
  if (!canEnter()) return shell(noAccessPage("门店专员没有判定计划入口", "判定计划只对总部与分公司开放。门店专员可以在「我的考核」查看自己的结果。", false), crumbs(["门店端", "我的考核"]), "store");
  const plans = state.plans
    .filter((p) => state.filterActivity === "all" || p.activityPlanId === state.filterActivity)
    .filter((p) => state.filterStatus === "all" || (state.filterStatus === "active" ? p.status === "active" : p.status === "archived"));
  const draftCount = state.plans.filter(isDraft).length;
  const head = pageHead(
    "判定计划",
    "给活动计划建一条从监控到出结果的判定链路；圈定、试跑、执行共用一份冻结输入。",
    canWrite() ? `<button class="btn primary" data-action="open-new">${icon("plus", 15)}新建判定计划</button>` : `<span class="badge gray">只读</span>`,
  );

  if (state.demo === "noaccess") return shell(pageHead("判定计划", "当前账号没有判定计划的读取权限。") + notice("danger", "warn", "缺少 Capability rule.definition.read；直链访问也按无权限处理。"), crumbs(["工作台", "判定计划"]));

  const overview = `<div class="overview">
    ${stat("判定计划", state.plans.length, "本页全部")}
    ${stat("进行中", state.plans.filter((p) => p.status === "active").length, "可继续配置或执行")}
    ${stat("草稿", draftCount, "待圈定 / 试跑 / 确认")}
    ${stat("已归档", state.plans.filter(isArchived).length, "历史可读")}
    ${stat("本周执行", "3", "含 1 个等待采集")}
    ${stat("最近完成", "06-12 18:40", "618 主推视频考核 v3")}
  </div>`;

  const filters = `<div class="card pad" style="margin-bottom:14px">
    <div class="inline-actions">
      <span class="muted small">筛选</span>
      <select class="select" style="width:200px" data-action="filter-activity">
        <option value="all">全部活动计划</option>
        ${ACTIVITY_PLANS.map((a) => `<option value="${a.id}" ${state.filterActivity === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
      </select>
      <select class="select" style="width:150px" data-action="filter-status">
        <option value="all" ${state.filterStatus === "all" ? "selected" : ""}>全部状态</option>
        <option value="active" ${state.filterStatus === "active" ? "selected" : ""}>进行中</option>
        <option value="archived" ${state.filterStatus === "archived" ? "selected" : ""}>已归档</option>
      </select>
      <span class="muted small" style="margin-left:auto">按更新时间倒序</span>
    </div>
  </div>`;

  let body;
  if (state.demo === "loading") {
    body = `<div class="card pad"><div class="skeleton skel-line w40"></div><div class="skeleton skel-line w80"></div><div class="skeleton skel-line w60"></div><div class="skeleton skel-line w80"></div><div class="skeleton skel-line w40"></div></div>`;
  } else if (state.demo === "error") {
    body = `<div class="card"><div class="errorstate"><div class="empty-icon">${icon("warn", 20)}</div><h3>列表加载失败</h3><p>无法读取判定计划。请检查请求地址或稍后重试；错误码 <span class="mono">judgement_list_unavailable</span>。</p><button class="btn" data-action="retry">${icon("refresh", 15)}重试</button></div></div>`;
  } else if (state.demo === "empty" || plans.length === 0) {
    body = `<div class="card"><div class="empty"><div class="empty-icon">${icon("clipboard", 20)}</div><h3>${state.filterActivity === "all" ? "还没有判定计划" : "这个活动计划还没有判定计划"}</h3><p>判定计划属于一个活动计划；创建后从第 1 页开始圈定。</p>${canWrite() ? `<button class="btn primary" data-action="open-new">${icon("plus", 15)}新建判定计划</button>` : ""}</div></div>`;
  } else {
    body = `<div class="card"><div class="table-wrap"><table class="table wide">
      <thead><tr><th>别名</th><th>所属活动计划</th><th>平台 / 形态</th><th>状态</th><th>版本</th><th>最近执行</th><th>更新时间</th><th class="right">操作</th></tr></thead>
      <tbody>${plans.map((p) => {
        const latest = executionsOf(p.id)[0];
        const draft = isDraft(p);
        const version = draft ? `<span class="badge amber">草稿 v${p.draftVersion}</span>` : `<span class="badge gray">已发布 v${p.publishedVersion}</span>`;
        const status = p.status === "archived" ? badge("已归档", "gray") : badge("进行中", "green");
        const latestText = latest
          ? `<span class="cell-stack"><span>${latest.status === "completed" ? `成功 ${latest.counts?.success ?? 0} / ${latest.participants}` : esc(waitingLabel(latest) ?? latest.statusLabel)}</span><span class="cell-sub">${esc(latest.startedAt)}</span></span>`
          : `<span class="muted">尚未执行</span>`;
        return `<tr class="clickable" data-action="open-plan" data-id="${p.id}">
          <td><div class="cell-main">${esc(p.alias)}</div><div class="cell-sub">${esc(p.description)}</div></td>
          <td><div class="cell-main">${esc(planActivityName(p))}</div><div class="cell-sub">${esc(activityOf(p)?.brand ?? "")} · ${esc(p.platform)}</div></td>
          <td><span class="cell-stack"><span>${esc(p.platform)}</span><span class="cell-sub">${esc(p.kinds)}</span></span></td>
          <td>${status} ${draft ? badge("草稿", "amber") : ""}</td>
          <td>${version}</td>
          <td>${latestText}</td>
          <td class="muted small">${esc(p.updatedAt)}</td>
          <td class="right"><div class="row-actions">${draft ? `<button class="btn sm" data-action="continue-draft" data-id="${p.id}">继续配置</button>` : `<button class="btn sm" data-action="open-plan" data-id="${p.id}">查看</button>`}</div></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div></div>`;
  }
  return shell(`${head}${overview}${filters}${body}`, crumbs(["工作台", "判定计划"]));
}

function noAccessPage(title, text, showBack = true) {
  return `<div class="card"><div class="empty"><div class="empty-icon">${icon("info", 20)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${showBack ? `<button class="btn" data-action="back-home">返回</button>` : ""}</div></div>`;
}

function notice(tone, iconName, text, extra = "") {
  return `<div class="notice ${tone}">${icon(iconName, 16)}<div>${text}${extra ? `<div style="margin-top:4px">${extra}</div>` : ""}</div></div>`;
}

/* ---------------- 详情 / 步骤条 ---------------- */

function stepbar(plan, viewStep, progressStep = viewStep) {
  const draft = isDraft(plan);
  const stepState = (n) => {
    if (!draft) return n < 4 ? "done" : "next";
    if (n < progressStep) return "done";
    if (n === progressStep) return "next";
    return "todo";
  };
  const steps = [
    { n: 1, label: "第 1 页 · 圈定", desc: "条数与未获取原因" },
    { n: 2, label: "第 2 页 · 比对", desc: "分布、样例与阈值" },
    { n: 3, label: "第 3 页 · 理解与执行", desc: "ASR、评论与确认" },
    { n: 4, label: "执行与结果", desc: "记录、证据与 E" },
  ];
  return `<div class="stepbar">${steps.map((s) => {
    const st = stepState(s.n);
    const viewing = s.n === viewStep ? " viewing" : "";
    const clickable = draft ? s.n <= progressStep && s.n <= 3 : s.n === 4;
    const action = clickable ? (draft ? `data-action="goto-step" data-id="${plan.id}" data-step="${s.n}"` : `data-action="open-executions" data-id="${plan.id}"`) : "";
    return `<div class="step ${st}${viewing}" ${action} style="${clickable ? "cursor:pointer" : ""}">
      <div class="step-dot">${st === "done" ? icon("check", 13) : s.n}</div>
      <div><div class="step-label">${s.label}</div><div class="step-desc">${s.desc}</div></div>
    </div>`;
  }).join("")}</div>`;
}

function ensureConfig(plan) {
  if (!plan.config) plan.config = clone(DEFAULT_CONFIG);
  return plan.config;
}

/** 配置变更的失效矩阵（design §7.9）：第 1 页/窗口/形态 → 圈定与试跑失效；第 2 层结构/图 → 试跑失效。 */
function invalidateFrom(plan, scope) {
  if (scope === "circle") {
    if (!plan.circle && !plan.trial) return;
    plan.circle = null;
    plan.trial = null;
    plan.trialData = null;
    plan.wizardStep = "draft";
    plan.dirty = "circle";
  } else {
    if (!plan.trial) return;
    plan.trial = null;
    plan.trialData = null;
    plan.wizardStep = "circled";
    plan.dirty = "trial";
  }
}

function configSummary(plan) {
  const c = ensureConfig(plan);
  const text = c.layer1.text[0];
  const tag = c.layer1.hashtags[0];
  return `<div class="chips" style="gap:8px">
    ${costChip(`时间窗 ${c.window.from} ~ ${c.window.to ?? "执行时"}`, "on")}
    ${costChip(`形态 ${c.kinds.map((k) => k === "video" ? "视频" : "图文").join(" / ")}`)}
    ${text ? costChip(`关键词 ${text.mode === "all" ? "全含" : "任一"} ${text.keywords.join(" / ")}${text.minCount ? ` · 至少 ${text.minCount} 条` : ""}`) : ""}
    ${tag ? costChip(`话题 ${tag.mode === "all" ? "全含" : "任一"} #${tag.values.join(" #")}${tag.minCount ? ` · 至少 ${tag.minCount} 条` : ""}`) : ""}
    ${c.layer1.duration ? costChip(`时长 ${c.layer1.duration.minSeconds}–${c.layer1.duration.maxSeconds} 秒`) : ""}
    ${(c.layer2.abilities ?? []).map((a) => costChip(`${L2_KIND_LABEL[a.kind] ?? "比对能力"} · ${L2_TARGET_LABEL[a.target] ?? "未选元素"}${a.threshold ? ` ≥ ${a.threshold}` : ""}`)).join("")}
    ${c.commentRequirement ? costChip(`评论 ${c.commentRequirement.mode === "all" ? "全含" : "任一"} ${c.commentRequirement.keywords.join(" / ")} · ${mLabel(c.commentRequirement.method)}`) : ""}
    ${c.contentRequirement?.layer3 ? costChip("音频 ASR 判定", "amber") : ""}
  </div>`;
}

function detailView(plan) {
  if (!canEnter()) return shell(noAccessPage("门店专员没有判定计划入口", "判定计划只对总部与分公司开放。"), crumbs(["工作台", "判定计划"]));
  const act = activityOf(plan);
  const draft = isDraft(plan);
  const readOnly = !canWrite(plan);
  const latest = latestCompleted(plan);
  const currentStep = draft ? ({ draft: 1, circled: 2, compared: 3 }[plan.wizardStep] ?? 1) : 4;
  const actions = [];
  if (!readOnly) {
    if (draft) {
      actions.push(`<button class="btn primary" data-action="continue-draft" data-id="${plan.id}">${icon("chevronRight", 15)}继续配置</button>`);
      if (plan.wizardStep !== "draft") actions.push(`<button class="btn" data-action="rollback-open" data-id="${plan.id}">${icon("refresh", 15)}回退</button>`);
    } else if (!isArchived(plan)) {
      actions.push(`<button class="btn primary" data-action="new-draft-open" data-id="${plan.id}">${icon("plus", 15)}新建草稿</button>`);
      actions.push(`<button class="btn" data-action="rerun" data-id="${plan.id}">${icon("play", 15)}重新执行</button>`);
      actions.push(`<button class="btn" data-action="archive-open" data-id="${plan.id}">${icon("archive", 15)}归档</button>`);
    } else {
      actions.push(`<button class="btn" data-action="unarchive" data-id="${plan.id}">取消归档</button>`);
    }
  }
  actions.push(`<button class="btn ghost" data-action="open-executions" data-id="${plan.id}">${icon("clock", 15)}执行记录</button>`);

  const counts = latest?.counts;
  const overview = `<div class="overview">
    ${stat("参与专员", draft ? (plan.circle?.participants ?? act?.roster ?? "—") : (latest?.participants ?? "—"), "执行冻结时确定")}
    ${stat("参与内容", draft ? (plan.circle?.contents ?? "—") : (latest?.c1 ?? "—"), draft ? "圈定后的 C1" : "C1 条数")}
    ${stat("成功", counts ? counts.success : "—", counts ? "计划总结果" : "尚未执行", "green")}
    ${stat("不达标", counts ? counts.notMet : "—", counts ? "含同步不完整提示" : "", "red")}
    ${stat("未获取成功", counts ? counts.unobtained : "—", counts ? "不计入不达标" : "", "gray")}
    ${stat("版本", draft ? `草稿 v${plan.draftVersion}` : `v${plan.publishedVersion}`, draft ? "未发布" : "已发布不可变")}
  </div>`;

  const versionRows = versionsOf(plan.id).slice().reverse().map((v) => `<tr>
    <td><b>v${v.version}</b></td>
    <td>${v.status === "published" ? badge("已发布", "green") : badge("草稿", "amber")}</td>
    <td class="muted small">${esc(v.publishedAt ?? "—")}</td>
    <td class="muted small">${v.basedOn ? `基于 v${v.basedOn}` : "首次"}</td>
    <td class="small">${esc(v.note)}</td>
    <td class="right">${v.status === "published" && !draft && canWrite(plan) ? `<button class="btn sm" data-action="new-draft-from" data-id="${plan.id}" data-version="${v.version}">从 v${v.version} 新建草稿</button>` : ""}</td>
  </tr>`).join("");

  const runRows = executionsOf(plan.id).slice(0, 4).map((e) => `<tr class="clickable" data-action="open-execution" data-id="${e.id}">
    <td class="mono">#${e.id}</td>
    <td>${statusBadge(e)} ${e.status === "waiting" ? `<span class="small muted">${esc(waitingLabel(e))}</span>` : ""}</td>
    <td class="muted small">${esc(e.startedAt)}</td>
    <td class="muted small">${esc(e.completedAt ?? "—")}</td>
    <td class="num">${e.counts ? `${e.counts.success} / ${e.counts.notMet} / ${e.counts.unobtained}` : "—"}</td>
    <td class="right"><button class="btn sm" data-action="open-execution" data-id="${e.id}">查看</button></td>
  </tr>`).join("");

  return shell(`
    <a class="back-link" href="#/judgement">${icon("arrowLeft", 14)}判定计划</a>
    ${pageHead(`${esc(plan.alias)} ${isArchived(plan) ? badge("已归档", "gray") : draft ? badge("草稿", "amber") : badge("进行中", "green")}`,
      `${esc(act?.name ?? "—")} · ${esc(plan.platform)} · ${esc(plan.window)} · 创建人 ${esc(plan.creator)}`,
      actions.join(""))}
    ${readOnly ? notice("info", "info", "当前角色只读：可以查看配置、执行记录和证据，不能修改配置或执行。") : ""}
    ${overview}
    ${stepbar(plan, currentStep, currentStep)}
    <div class="grid-side">
      <div>
        <div class="card">
          <div class="card-head"><div><div class="card-title">${draft ? `草稿 v${plan.draftVersion}` : `已发布 v${plan.publishedVersion}`} 的配置</div><div class="card-sub">配置随版本冻结；改配置要新建草稿并发布</div></div>${draft && !readOnly ? `<button class="btn sm" data-action="continue-draft" data-id="${plan.id}">继续配置</button>` : ""}</div>
          <div class="card-body">${configSummary(plan)}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="card-title">版本</div><div class="card-sub">${draft ? "草稿未发布；发布后不可变" : "已发布版本不可变；旧版本结果保留可查"}</div></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>版本</th><th>状态</th><th>发布时间</th><th>来源</th><th>说明</th><th class="right"></th></tr></thead><tbody>${versionRows}</tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="card-title">最近执行</div><div class="card-sub">完成通知由 E 轮询；同一计划最新 completed 即当前结果</div></div><button class="btn sm" data-action="open-executions" data-id="${plan.id}">全部记录</button></div>
          ${runRows ? `<div class="table-wrap"><table class="table"><thead><tr><th>执行</th><th>状态</th><th>开始</th><th>完成</th><th>成功 / 不达标 / 未获取</th><th class="right"></th></tr></thead><tbody>${runRows}</tbody></table></div>` : `<div class="empty" style="padding:26px"><p>还没有执行过。</p></div>`}
        </div>
      </div>
      <div class="wizard-side">
        <div class="side-card">
          <div class="side-title">所属活动计划</div>
          <div class="kv"><span class="k">活动计划</span><span class="v">${esc(act?.name ?? "—")}</span></div>
          <div class="kv"><span class="k">品牌 / 平台</span><span class="v">${esc(act?.brand ?? "—")} · ${esc(plan.platform)}</span></div>
          <div class="kv"><span class="k">活动周期</span><span class="v">${esc(act?.period ?? "—")}</span></div>
          <div class="kv"><span class="k">参与分公司</span><span class="v">${esc((act?.branches ?? []).join("、"))}</span></div>
          <div class="kv"><span class="k">名单</span><span class="v">${act?.roster ?? "—"} 名专员</span></div>
        </div>
        <div class="side-card">
          <div class="side-title">说明</div>
          <p class="small muted">判定计划与 C 的监控段同 ID、同版本；D 只读 A 的名册与内容，不写 A / C 的表。</p>
          <p class="small muted" style="margin-top:8px">执行时冻结名单、当前归属、组织链与内容快照；之后的改绑或换店不影响本次结果。</p>
        </div>
      </div>
    </div>`, crumbs(["工作台", "判定计划", plan.alias]));
}

/* ---------------- 向导 ---------------- */

function currentWizardStep(plan) {
  // 第 2 页没有能力时，圈定后直接视为已比对（design §7.9）
  if (plan.wizardStep === "circled" && !hasLayer2Caps(plan)) return 3;
  return ({ draft: 1, circled: 2, compared: 3 }[plan.wizardStep] ?? 1);
}

function gateCard(plan, step, text, goStep) {
  return `<div class="card"><div class="empty"><div class="empty-icon">${icon("layers", 20)}</div><h3>${esc(text)}</h3><p>向导是阻塞式的：前一步确认后才能进入下一步。</p><button class="btn primary" data-action="goto-step" data-id="${plan.id}" data-step="${goStep}">去第 ${goStep} 页</button></div></div>`;
}

function wizardView(plan, step) {
  if (!isDraft(plan)) return detailView(plan);
  if (!canEnter()) return shell(noAccessPage("门店专员没有判定计划入口", "判定计划只对总部与分公司开放。"), crumbs(["工作台", "判定计划"]));
  const readOnly = !canWrite(plan);
  const current = currentWizardStep(plan);
  const act = activityOf(plan);
  const asrBlocked = Boolean(plan.config?.contentRequirement?.layer3) && !state.asrEnabled;
  const busyType = state.busy?.planId === plan.id ? state.busy.type : null;
  const primaryAction = step === 1
    ? (plan.circle
      ? `<button class="btn primary" data-action="goto-step" data-id="${plan.id}" data-step="2">${icon("chevronRight", 15)}进入第 2 页</button>`
      : `<button class="btn primary" data-action="circle" data-id="${plan.id}" ${readOnly || busyType === "circle" ? "disabled" : ""} aria-busy="${busyType === "circle"}">${icon("target", 15)}${busyType === "circle" ? "圈定中…" : "确认圈定"}</button>`)
    : step === 2
      ? (!hasLayer2Caps(plan) || plan.trial
        ? `<button class="btn primary" data-action="goto-step" data-id="${plan.id}" data-step="3">${icon("chevronRight", 15)}进入第 3 页</button>`
        : `<button class="btn primary" data-action="trial" data-id="${plan.id}" ${readOnly || !allLayer2Uploaded(plan) || busyType === "trial" ? "disabled" : ""} aria-busy="${busyType === "trial"}">${icon("play", 15)}${busyType === "trial" ? "试跑中…" : "开始试跑"}</button>`)
      : `<button class="btn primary" data-action="confirm-open" data-id="${plan.id}" ${readOnly || current < 3 || asrBlocked ? "disabled" : ""}>${icon("check", 15)}确认执行</button>`;

  let body;
  if (step === 2 && current < 2) body = gateCard(plan, 2, "先完成第 1 页圈定", 1);
  else if (step === 3 && current < 3) body = gateCard(plan, 3, "先完成第 2 页试跑", 2);
  else if (step === 1) body = wizard1(plan, readOnly);
  else if (step === 2) body = wizard2(plan, readOnly);
  else body = wizard3(plan, readOnly);

  return shell(`
    <a class="back-link" href="#/judgement/${plan.id}">${icon("arrowLeft", 14)}返回判定计划</a>
    ${pageHead(`${esc(plan.alias)} ${badge(`草稿 v${plan.draftVersion}`, "amber")}`,
      `${esc(act?.name ?? "—")} · ${esc(plan.platform)} · ${esc(plan.window)}`,
      `${readOnly ? `<span class="badge gray">只读</span>` : ""}${primaryAction}${step > 1 && !readOnly ? `<button class="btn" data-action="rollback-open" data-id="${plan.id}" data-target="${step - 1}">${icon("refresh", 15)}回退到第 ${step - 1} 页</button>` : ""}`)}
    ${readOnly ? notice("info", "info", "当前角色只读：可以查看向导，不能修改配置或执行。") : ""}
    ${stepbar(plan, step, current)}
    ${plan.dirty === "circle" && step === 1 ? notice("info", "info", "配置已修改：请重新圈定。旧的圈定与试跑结果已失效。") : ""}
    ${plan.dirty === "trial" && step === 2 ? notice("info", "info", "配置已修改：请重新试跑。旧的试跑结果已失效，圈定结果保留。") : ""}
    ${body}`, crumbs(["工作台", "判定计划", plan.alias, `第 ${step} 页`]));
}

function wizard1(plan, readOnly) {
  const c = ensureConfig(plan);
  const busy = state.busy?.type === "circle" && state.busy.planId === plan.id;
  const circled = Boolean(plan.circle);
  const disabled = readOnly || busy ? "disabled" : "";
  const kindVideo = c.kinds.includes("video");
  const kindImage = c.kinds.includes("image");
  const menuOpen = state.capabilityMenu === plan.id;
  const items = [
    ...c.layer1.text.map((x, i) => ({ kind: "text", i, x })),
    ...c.layer1.hashtags.map((x, i) => ({ kind: "tag", i, x })),
    ...(c.layer1.duration ? [{ kind: "duration", i: 0, x: c.layer1.duration }] : []),
  ];

  const result = circled && !busy ? `
    <div class="card" style="margin-top:14px">
      <div class="card-head"><div><div class="card-title">圈定结果</div><div class="card-sub">${esc(plan.circle.generatedAt)} · 同步运算，没有外部调用</div></div><span class="badge green">已圈定</span></div>
      <div class="card-body">
        <div class="overview" style="margin-bottom:12px">
          ${stat("C1 内容", plan.circle.c1, "第 1 层通过")}
          ${stat("参与专员", plan.circle.participants, "执行时冻结名单")}
          ${stat("参与内容", plan.circle.contents, "窗口内、形态符合")}
          ${stat("未获取成功", plan.circle.unobtained, "不计入不达标", "gray")}
        </div>
        <div class="small muted" style="margin-bottom:6px">未获取成功的原因</div>
        <div class="chips">${plan.circle.reasons.map((r) => `<span class="chip">${esc(r.label)} <b class="num">${r.count}</b></span>`).join("")}</div>
        <div class="inline-actions" style="margin-top:14px">
          <button class="btn" data-action="download-circle" data-id="${plan.id}">${icon("download", 15)}下载圈定结果（E6）</button>
          <button class="btn" data-action="circle" data-id="${plan.id}" ${readOnly ? "disabled" : ""}>${icon("refresh", 15)}重新圈定</button>
          <button class="btn" data-action="goto-step" data-id="${plan.id}" data-step="2">进入第 2 页 ${icon("chevronRight", 15)}</button>
        </div>
      </div>
    </div>` : "";

  const menu = menuOpen ? `<div class="capability-menu" role="menu" aria-label="添加能力">
    <button type="button" data-action="add-capability" data-type="text" role="menuitem"><b>文本识别</b><span>标题 / 正文里的关键词，全部或任一命中</span></button>
    <button type="button" data-action="add-capability" data-type="tag" role="menuitem"><b>话题识别</b><span>话题标签，按归一化后整体相等比较</span></button>
    <button type="button" data-action="add-capability" data-type="duration" role="menuitem" ${c.layer1.duration ? "disabled" : ""}><b>视频时长</b><span>${c.layer1.duration ? "已添加" : "最短 / 最长秒数，含边界"}</span></button>
  </div>` : "";

  const capCard = (item, n) => {
    const idx = String(n + 1).padStart(2, "0");
    if (item.kind === "text") {
      const x = item.x;
      return `<div class="condition capability">
        <div class="insp-head">
          <span class="idx">${idx}</span>
          <div class="insp-id">
            <span class="capability-icon">${icon("file", 15)}</span>
            <span class="name-pill">文本识别</span>
            <label class="alias-pill"><span>能力别名（可选）</span><input class="input alias-input" value="${esc(x.alias ?? "")}" data-action="set-alias" data-kind="text" data-index="${item.i}" ${disabled} aria-label="能力别名" placeholder="例如：主推卖点文本" title="能力别名，显示在配置页、证据与导出明细中" /></label>
          </div>
          <button class="icon-btn cap-remove" data-action="remove-capability" data-kind="text" data-index="${item.i}" ${disabled} title="删除能力" aria-label="删除能力">${icon("x", 15)}</button>
        </div>
        <div class="insp-body single">
          <div class="settings">
            <div class="cap-grid ability-row">
              <div class="field"><label>文本位置</label><div class="toggle-group"><label class="toggle"><input type="checkbox" data-action="toggle-field" data-index="${item.i}" data-field="title" ${x.fields.includes("title") ? "checked" : ""} ${disabled} /><span>标题</span></label><label class="toggle"><input type="checkbox" data-action="toggle-field" data-index="${item.i}" data-field="body" ${x.fields.includes("body") ? "checked" : ""} ${disabled} /><span>正文</span></label></div></div>
              <div class="field"><label>组合方式</label><select class="select" data-action="set-text-mode" data-index="${item.i}" ${disabled}><option value="any" ${x.mode === "any" ? "selected" : ""}>任一词命中</option><option value="all" ${x.mode === "all" ? "selected" : ""}>全部词命中</option></select></div>
              <div class="req-field inline">
                <label>数量要求</label>
                <div class="req-line"><span>至少</span><input class="input" type="number" min="1" value="${x.minCount ?? ""}" placeholder="—" data-action="set-capability-quantity" data-kind="text" data-index="${item.i}" ${disabled} /><span class="unit">条内容命中</span><span class="req-note">（留空 = 不限条数）</span></div>
              </div>
            </div>
            <div class="field">
              <label>关键词</label>
              <div class="chips">${x.keywords.map((k) => `<span class="chip on">${esc(k)}<button data-action="remove-keyword" data-index="${item.i}" data-value="${esc(k)}" aria-label="移除 ${esc(k)}">${icon("x", 11)}</button></span>`).join("")}</div>
              <div class="inline-field" style="margin-top:8px;max-width:420px"><input class="input" style="flex:1" placeholder="输入关键词" data-keyword-input="${item.i}" ${disabled} /><button class="btn sm" data-action="add-keyword" data-index="${item.i}" ${disabled}>添加</button></div>
            </div>
          </div>
        </div>
      </div>`;
    }
    if (item.kind === "tag") {
      const x = item.x;
      return `<div class="condition capability">
        <div class="insp-head">
          <span class="idx">${idx}</span>
          <div class="insp-id">
            <span class="capability-icon">${icon("activity", 15)}</span>
            <span class="name-pill">话题识别</span>
            <label class="alias-pill"><span>能力别名（可选）</span><input class="input alias-input" value="${esc(x.alias ?? "")}" data-action="set-alias" data-kind="tag" data-index="${item.i}" ${disabled} aria-label="能力别名" placeholder="例如：活动话题" title="能力别名，显示在配置页、证据与导出明细中" /></label>
          </div>
          <button class="icon-btn cap-remove" data-action="remove-capability" data-kind="tag" data-index="${item.i}" ${disabled} title="删除能力" aria-label="删除能力">${icon("x", 15)}</button>
        </div>
        <div class="insp-body single">
          <div class="settings">
            <div class="cap-grid ability-row two">
              <div class="field"><label>组合方式</label><select class="select" data-action="set-tag-mode" data-index="${item.i}" ${disabled}><option value="any" ${x.mode === "any" ? "selected" : ""}>任一话题</option><option value="all" ${x.mode === "all" ? "selected" : ""}>全部话题</option></select></div>
              <div class="req-field inline">
                <label>数量要求</label>
                <div class="req-line"><span>至少</span><input class="input" type="number" min="1" value="${x.minCount ?? ""}" placeholder="—" data-action="set-capability-quantity" data-kind="tag" data-index="${item.i}" ${disabled} /><span class="unit">条内容命中</span><span class="req-note">（留空 = 不限条数）</span></div>
              </div>
            </div>
            <div class="field">
              <label>话题</label>
              <div class="chips">${x.values.map((v) => `<span class="chip on">#${esc(v)}<button data-action="remove-tag" data-index="${item.i}" data-value="${esc(v)}" aria-label="移除 ${esc(v)}">${icon("x", 11)}</button></span>`).join("")}</div>
              <div class="inline-field" style="margin-top:8px;max-width:420px"><input class="input" style="flex:1" placeholder="输入话题，不用带 #" data-tag-input="${item.i}" ${disabled} /><button class="btn sm" data-action="add-tag" data-index="${item.i}" ${disabled}>添加</button></div>
              <div class="hint">话题按归一化后整体相等比较，不做子串：「618」不匹配「618大促」。</div>
            </div>
          </div>
        </div>
      </div>`;
    }
    const x = item.x;
    return `<div class="condition capability">
      <div class="insp-head">
        <span class="idx">${idx}</span>
        <div class="insp-id">
          <span class="capability-icon">${icon("clock", 15)}</span>
          <span class="name-pill">视频时长</span>
          <label class="alias-pill"><span>能力别名（可选）</span><input class="input alias-input" value="${esc(x.alias ?? "")}" data-action="set-alias" data-kind="duration" ${disabled} aria-label="能力别名" placeholder="例如：主推视频时长" title="能力别名，显示在配置页、证据与导出明细中" /></label>
          <span class="hint" style="margin:0">${x.minSeconds ?? 0}–${x.maxSeconds ?? "不限"} 秒</span>
        </div>
        <button class="icon-btn cap-remove" data-action="remove-capability" data-kind="duration" ${disabled} title="删除能力" aria-label="删除能力">${icon("x", 15)}</button>
      </div>
      <div class="insp-body single">
        <div class="settings">
          <div class="cap-grid two">
            <div class="field"><label>最短（秒）</label><input class="input" type="number" min="0" value="${x.minSeconds ?? ""}" data-action="set-duration" data-bound="minSeconds" ${disabled || kindImage ? "disabled" : ""} /></div>
            <div class="field"><label>最长（秒）</label><input class="input" type="number" min="0" value="${x.maxSeconds ?? ""}" data-action="set-duration" data-bound="maxSeconds" ${disabled || kindImage ? "disabled" : ""} /></div>
          </div>
          <div class="hint">含边界；单位未知或状态缺失按未获取成功计，真实 0 秒有效。</div>
          ${kindImage ? notice("warn", "warn", "含图文时不能配置视频时长（JP-2 校验）。") : ""}
        </div>
      </div>
    </div>`;
  };

  return `<div class="wizard-grid">
    <div>
      ${result}
      <div class="card">
        <div class="card-head"><div><div class="card-title">第 1 页 · 圈定</div><div class="card-sub">只使用名单、当前归属与列表 / 主页字段；不调详情、评论、图片或模型</div></div>${circled ? badge("已圈定", "green") : badge("草稿", "amber")}</div>
        <div class="card-body">
          <div class="condition plan-conditions" style="background:var(--surface-sunken)">
            <div class="condition-head"><div class="condition-title">计划级条件（必选）</div><span class="hint">时间窗与内容形态始终生效</span></div>
            <div class="date-range">
              <label class="date-part"><span class="date-cap">起</span><input class="date-input" type="date" value="${c.window.from}" data-action="set-window" data-bound="from" ${disabled} aria-label="时间窗开始" /></label>
              <span class="date-sep">→</span>
              <label class="date-part"><span class="date-cap">止</span><input class="date-input" type="date" value="${c.window.to ?? ""}" data-action="set-window" data-bound="to" ${disabled} aria-label="时间窗结束" /></label>
            </div>
            <div class="date-note">北京时间自然日，闭区间；默认沿用活动计划起止日；止留空 = 到执行冻结时刻。</div>
            <div class="field" style="margin-top:14px;margin-bottom:0">
              <label>内容形态</label>
              <div class="kind-options">
                <label class="kind-option"><input type="checkbox" data-action="toggle-kind" data-kind="video" ${kindVideo ? "checked" : ""} ${disabled} /><span class="kind-icon">${icon("play", 15)}</span><span><b>视频</b><small>抖音 / 小红书视频内容</small></span></label>
                <label class="kind-option"><input type="checkbox" data-action="toggle-kind" data-kind="image" ${kindImage ? "checked" : ""} ${disabled} /><span class="kind-icon">${icon("image", 15)}</span><span><b>图文</b><small>image + text；形态未知按未获取成功计</small></span></label>
              </div>
            </div>
          </div>

          <div class="section-head" style="margin:20px 0 12px">
            <div><div class="card-title">第 1 层能力</div><div class="card-sub">按需添加；同一条内容必须满足全部已添加能力</div></div>
            <div class="capability-add">
              <button class="btn" data-action="toggle-capability-menu" data-id="${plan.id}" ${disabled}>${icon("plus", 15)}添加能力</button>
              ${menu}
            </div>
          </div>
          ${items.length ? items.map((item, n) => capCard(item, n)).join("") : `<div class="empty" style="padding:24px"><div class="empty-icon">${icon("layers", 20)}</div><h3>还没有添加筛选能力</h3><p>只按时间窗与内容形态圈定；需要时点「添加能力」。</p></div>`}

          <div class="wizard-actions">
            ${circled
              ? `<button class="btn" data-action="circle" data-id="${plan.id}" ${readOnly || busy ? "disabled" : ""}>${icon("refresh", 15)}重新圈定</button><button class="btn primary" data-action="goto-step" data-id="${plan.id}" data-step="2">进入第 2 页 ${icon("chevronRight", 15)}</button>`
              : `<button class="btn primary" data-action="circle" data-id="${plan.id}" ${disabled}>${icon("target", 15)}${busy ? "圈定中…" : "确认圈定"}</button>`}
          </div>
          ${busy ? `<div class="progress" style="margin-top:12px"><i style="width:60%"></i></div>` : ""}
        </div>
      </div>
    </div>
    <div class="wizard-side">
      <div class="side-card">
        <div class="side-title">名单与范围</div>
        <div class="kv"><span class="k">活动计划</span><span class="v">${esc(activityOf(plan)?.name ?? "—")}</span></div>
        <div class="kv"><span class="k">平台</span><span class="v">${esc(plan.platform)}</span></div>
        <div class="kv"><span class="k">名单</span><span class="v">${activityOf(plan)?.roster ?? "—"} 名参与专员</span></div>
        <div class="kv"><span class="k">分公司</span><span class="v">${esc((activityOf(plan)?.branches ?? []).join("、"))}</span></div>
        <p class="hint" style="margin-top:8px">名单项里的组织字段只是加入当时的快照，仅用于可见范围；执行时按账号当前归属算。</p>
      </div>
      <div class="side-card">
        <div class="side-title">圈定说明</div>
        <p class="small muted">圈定不触发任何外部调用：不调 A 的按需采集、不调 C 的补算、不读图、不调模型。它只读 A 的快照与 C 的文本信号。</p>
        <p class="small muted" style="margin-top:8px">重新圈定会替换上一次的圈定运行；圈定结果按保留期清理。</p>
      </div>
    </div>
  </div>`;
}

const L2_KIND_LABEL = { whole_image: "整张图片对比", image_element: "图片元素对比", image_text: "图片文字对比" };
const L2_TARGET_LABEL = { avatar: "头像", cover: "封面", background: "主页背景" };
const L2_KIND_ICON = { whole_image: "image", image_element: "target", image_text: "file" };
function l2Label(cap) {
  const target = L2_TARGET_LABEL[cap.target] ?? "未选对比元素";
  return `${L2_KIND_LABEL[cap.kind] ?? "比对能力"} · ${target}`;
}

function layer2Caps(plan) {
  const c = ensureConfig(plan);
  return (c.layer2.abilities ?? []).map((a, i) => ({ ...a, i, uploadKey: `ability_${i}` }));
}

function hasLayer2Caps(plan) { return layer2Caps(plan).length > 0; }
function allLayer2Uploaded(plan) {
  return layer2Caps(plan).every((cap) => {
    if (!cap.target) return false;
    if (cap.kind === "image_text") return Boolean((cap.text ?? "").trim());
    return Boolean(plan.uploads?.[cap.uploadKey]);
  });
}

function ensureTrial(plan) {
  if (!plan.trialData) {
    plan.trialData = clone(TRIAL);
    const caps = layer2Caps(plan);
    plan.trialThresholds = Object.fromEntries(caps.map((cap, i) => [`ability_${i}`, cap.threshold ?? "6.50"]));
    plan.sampleBucket = Object.fromEntries(caps.map((cap, i) => [`ability_${i}`, 8]));
    plan.uploads = plan.uploads ?? {};
  }
  return plan.trialData;
}

function distCard(plan, cond) {
  const threshold = plan.trialThresholds?.[cond.key] ?? cond.threshold;
  const cut = Math.ceil(Number(threshold));
  const max = Math.max(...cond.distribution);
  const pass = cond.distribution.slice(cut).reduce((a, b) => a + b, 0);
  const total = cond.distribution.reduce((a, b) => a + b, 0);
  const bucket = plan.sampleBucket?.[cond.key] ?? 8;
  const samples = (cond.samples?.[bucket] ?? []).slice(0, 5);
  return `<div class="card" style="margin-top:12px">
    <div class="card-head">
      <div><div class="card-title">${esc(cond.label)}</div><div class="card-sub">连续 0.00–10.00；11 档只用于选阈值与看样例，不改变存储精度</div></div>
      <div class="inline-field"><label class="small muted">阈值</label><input class="input" style="width:82px" type="number" min="0" max="10" step="0.01" value="${threshold}" data-action="set-threshold" data-cond="${cond.key}" ${canWrite(plan) ? "" : "disabled"} /></div>
    </div>
    <div class="card-body">
      <div class="dist">${cond.distribution.map((v, i) => `<div class="dist-col"><div class="dist-count">${v}</div><div class="dist-bar ${i >= cut ? "above" : ""}" style="height:${Math.max(4, Math.round((v / max) * 82))}%"></div><div class="dist-label">${i}</div></div>`).join("")}</div>
      <div class="inline-actions" style="margin-top:10px">
        <span class="badge green">高于阈值 ${pass} 条</span>
        <span class="badge gray">未获取成功 ${cond.unobtained} 条</span>
        <span class="small muted">共 ${total + cond.unobtained} 条参与比对</span>
        <span style="margin-left:auto" class="inline-field"><label class="small muted">样例档位</label><select class="select" style="width:88px" data-action="set-sample-bucket" data-cond="${cond.key}">${Array.from({ length: 11 }, (_, i) => `<option value="${i}" ${bucket === i ? "selected" : ""}>${i}</option>`).join("")}</select></span>
      </div>
      <div class="samples fixed">${samples.length ? samples.map((id, i) => `<div class="sample"><div class="thumb small"><div class="thumb-mark">${icon("image", 18)}</div></div><div class="sample-row"><span class="sample-id">${esc(id)}</span><span class="sample-score">${bucket}.${String(10 + i * 7).slice(0, 2)}</span></div></div>`).join("") : `<div class="muted small" style="padding:10px 0">该档暂无样例。</div>`}</div>
    </div>
  </div>`;
}

function wizard2(plan, readOnly) {
  const c = ensureConfig(plan);
  const trial = ensureTrial(plan);
  const caps = layer2Caps(plan);
  const busy = state.busy?.type === "trial" && state.busy.planId === plan.id;
  const disabled = readOnly || busy ? "disabled" : "";
  const hasTrial = Boolean(plan.trial);
  const menuOpen = state.layer2Menu === plan.id;
  const platformOk = plan.platform === "抖音";
  const allReady = allLayer2Uploaded(plan);
  const method = c.contentRequirement?.method;

  const menu = menuOpen ? `<div class="capability-menu" role="menu" aria-label="添加比对能力">
    <button type="button" data-action="add-layer2-capability" data-kind="whole_image" role="menuitem"><b>${icon("image", 13)} 整张图片对比</b><span>目标图片与标准图整体比对，按相似度判定是否一致</span></button>
    <button type="button" data-action="add-layer2-capability" data-kind="image_element" role="menuitem"><b>${icon("target", 13)} 图片元素对比</b><span>检查目标图片中是否出现指定元素，按元素匹配度判定</span></button>
    <button type="button" data-action="add-layer2-capability" data-kind="image_text" role="menuitem"><b>${icon("file", 13)} 图片文字对比</b><span>识别目标图片中的文字，检查是否包含指定内容</span></button>
  </div>` : "";

  const targetPicker = (cap) => `<div class="target-picker"><span class="target-label">对比元素</span>${["avatar", "cover", "background"].map((t) => {
    const off = !platformOk && (t === "avatar" || t === "background");
    return `<label class="target-chip" title="${off ? "仅抖音可用" : L2_TARGET_LABEL[t]}"><input type="radio" name="target-${cap.i}" value="${t}" data-action="set-layer2-target" data-index="${cap.i}" ${cap.target === t ? "checked" : ""} ${disabled || off ? "disabled" : ""} /><span>${L2_TARGET_LABEL[t]}</span></label>`;
  }).join("")}</div>`;

  const thresholdBlock = (cap) => {
    const isAccount = cap.target === "avatar" || cap.target === "background";
    const raw = Number(cap.threshold ?? 0);
    const pct = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw * 10 : 0));
    return `<div class="threshold">
      <div class="th-head"><label>匹配阈值</label><span>SCORE 0–10</span></div>
      <div class="th-row">
        <button class="step-btn" data-action="bump-threshold" data-index="${cap.i}" data-dir="-1" ${disabled} aria-label="阈值减 0.10">−</button>
        <input class="score" value="${esc(cap.threshold)}" data-action="set-layer2-threshold" data-index="${cap.i}" ${disabled} aria-label="匹配阈值" />
        <button class="step-btn" data-action="bump-threshold" data-index="${cap.i}" data-dir="1" ${disabled} aria-label="阈值加 0.10">+</button>
        <div class="gauge-wrap">
          <div class="gauge"><i style="width:${pct}%"></i><b style="left:${pct}%"></b></div>
          <input type="range" class="threshold-range" min="0" max="10" step="0.01" value="${raw}" data-action="threshold-slider" data-index="${cap.i}" ${disabled} aria-label="拖动调整匹配阈值" />
        </div>
      </div>
      <div class="th-scale"><span>0</span><span>5</span><span>10</span></div>
      <p class="th-hint">${isAccount ? "账号要求与内容层并行，不依赖内容层。" : "等于阈值判通过；调整阈值不重算分数。"}</p>
    </div>`;
  };

  const uploadBox = (cap) => {
    const isElement = cap.kind === "image_element";
    const title = isElement ? "上传元素图" : "上传标准图";
    const label = isElement ? "元素图" : "标准图";
    const has = plan.uploads?.[cap.uploadKey];
    return `<div class="upload ${has ? "has" : ""}" data-action="upload-demo" data-kind="${cap.uploadKey}">
      ${has ? `<div class="thumb" data-label="${label}"><div class="thumb-mark">${icon("image", 30)}</div></div>` : `${icon("upload", 18)}<div class="upload-title">${title}</div><div class="upload-hint">≤ 10 MiB · 可解码</div>`}
    </div>`;
  };

  const capCard = (cap, n) => {
    const idx = String(n + 1).padStart(2, "0");
    const aliasInput = `<label class="alias-pill"><span>能力别名（可选）</span><input class="input alias-input" value="${esc(cap.alias)}" data-action="set-layer2-alias" data-index="${cap.i}" ${disabled} aria-label="能力别名" placeholder="例如：封面视觉规范" title="能力别名，显示在配置页、证据与导出明细中" /></label>`;
    const remove = `<button class="icon-btn cap-remove" data-action="remove-layer2-capability" data-index="${cap.i}" ${disabled} title="删除能力" aria-label="删除能力">${icon("x", 15)}</button>`;
    const head = `<div class="insp-head"><span class="idx">${idx}</span><div class="insp-id"><span class="capability-icon">${icon(L2_KIND_ICON[cap.kind] ?? "image", 15)}</span><span class="name-pill">${L2_KIND_LABEL[cap.kind] ?? "比对能力"}</span>${aliasInput}${targetPicker(cap)}</div>${remove}</div>`;
    if (cap.kind === "image_text") {
      return `<div class="condition capability">
        ${head}
        <div class="insp-body single">
          <div class="settings two">
            <div class="field" style="margin-bottom:0"><label>包含文字</label><input class="input" value="${esc(cap.text ?? "")}" data-action="set-layer2-text" data-index="${cap.i}" ${disabled} placeholder="例如：海信 618" /><div class="hint">识别目标图片中的文字，包含该内容即算命中。</div></div>
            ${thresholdBlock(cap)}
          </div>
        </div>
      </div>`;
    }
    return `<div class="condition capability">
      ${head}
      <div class="insp-body">
        ${uploadBox(cap)}
        <div class="settings">${thresholdBlock(cap)}</div>
      </div>
    </div>`;
  };

  const dists = trial.conditions ?? [];
  const accountCaps = caps.filter((cap) => cap.target === "avatar" || cap.target === "background");
  const trialResult = hasTrial && !busy ? `
    ${dists.map((cond) => distCard(plan, cond)).join("")}
    ${accountCaps.length ? `<div class="card" style="margin-top:12px">
      <div class="card-head"><div><div class="card-title">账号图片要求 · ${accountCaps.map((c) => L2_TARGET_LABEL[c.target]).join(" / ")}</div><div class="card-sub">账号要求与内容层并行，不依赖内容层</div></div><span class="badge green">高于阈值 ${trial.accounts.avatar.pass} / ${trial.accounts.avatar.total}</span></div>
      <div class="card-body"><div class="kv"><span class="k">未获取成功</span><span class="v">${trial.accounts.avatar.unobtained} 个账号（无主页快照 / 素材未归档）</span></div><p class="hint" style="margin-top:8px">头像 / 主页背景只对抖音可用；小红书与快手不可配。</p></div>
    </div>` : ""}
    <div class="inline-actions" style="margin-top:12px"><button class="btn" data-action="trial" data-id="${plan.id}" ${disabled}>${icon("refresh", 15)}重新试跑</button><span class="hint">下一步：右上角「进入第 3 页」。</span></div>` : "";

  const bottomPrimary = caps.length === 0 || hasTrial
    ? `<button class="btn primary" data-action="goto-step" data-id="${plan.id}" data-step="3">进入第 3 页 ${icon("chevronRight", 15)}</button>`
    : `<button class="btn primary" data-action="trial" data-id="${plan.id}" ${disabled || !allReady ? "disabled" : ""}>${icon("play", 15)}${busy ? "试跑中…" : "开始试跑"}</button>`;

  return `<div class="wizard-grid">
    <div>
      ${trialResult}
      <div class="card">
        <div class="card-head"><div><div class="card-title">第 2 页 · 比对</div><div class="card-sub">只对第 1 层留下的 C1 做比对；试跑不触发第 3 层，不产生付费调用</div></div>${hasTrial ? badge("已比对", "green") : badge("待试跑", "amber")}</div>
        <div class="card-body">
          <div class="section-head">
            <div><div class="card-title">比对能力</div><div class="card-sub">按需添加；每个能力先选对比元素，再上传素材或填写文字</div></div>
            <div class="capability-add"><button class="btn" data-action="toggle-layer2-menu" data-id="${plan.id}" ${disabled}>${icon("plus", 15)}添加能力</button>${menu}</div>
          </div>
          <div style="margin-top:12px">
            ${caps.length ? caps.map((cap, n) => capCard(cap, n)).join("") : `<div class="empty" style="padding:24px"><div class="empty-icon">${icon("image", 20)}</div><h3>第 2 页没有比对能力</h3><p>可以只按第 1 层条件判定，直接进入第 3 页。</p></div>`}
          </div>
          <div class="wizard-actions">${bottomPrimary}<button class="btn" data-action="rollback-open" data-id="${plan.id}" data-target="1" ${disabled || !hasTrial ? "disabled" : ""}>${icon("refresh", 15)}回退到第 1 页</button></div>
          ${busy ? `<div class="progress" style="margin-top:12px"><i style="width:45%"></i></div>` : ""}
        </div>
      </div>
    </div>
    <div class="wizard-side">
      <div class="side-card"><div class="side-title">试跑说明</div><div class="kv"><span class="k">输入</span><span class="v">圈定留下的 C1</span></div><div class="kv"><span class="k">外部调用</span><span class="v">只经 C 的评分</span></div><div class="kv"><span class="k">第 3 层</span><span class="v">不触发</span></div><div class="kv"><span class="k">费用</span><span class="v">图片 / 元素 / 文字匹配免费</span></div><p class="hint" style="margin-top:8px">试跑是 rule.definition.manage 能力，不是 rule.run.execute。试跑运行与圈定运行一样按保留期清理。</p></div>
      <div class="side-card"><div class="side-title">素材缺失</div><p class="small muted">封面 / 头像 / 主页背景未归档、下载失败或只有 carried_forward 时，该对象记未获取成功，并带 C 的原因码。D 不提图片采集需求。</p></div>
    </div>
  </div>`;
}

function wizard3(plan, readOnly) {
  const c = ensureConfig(plan);
  const asr = c.contentRequirement?.layer3;
  const comment = c.commentRequirement;
  const ready = currentWizardStep(plan) >= 3;
  const busy = state.busy?.type === "confirm" && state.busy.planId === plan.id;
  const disabled = readOnly || busy ? "disabled" : "";
  const menuOpen = state.layer3Menu === plan.id;
  const asrBlocked = Boolean(asr) && !state.asrEnabled;
  const method = c.contentRequirement?.method;

  const menu = menuOpen ? `<div class="capability-menu" role="menu" aria-label="添加第 3 层能力">
    <button type="button" data-action="add-layer3-capability" data-kind="asr" role="menuitem" ${asr || !state.asrEnabled ? "disabled" : ""}><b>${icon("spark", 13)} 音频 ASR 判定</b><span>${asr ? "已添加" : state.asrEnabled ? "口播转写 + 大模型判定" : "能力未启用，暂不可添加"}</span></button>
    <button type="button" data-action="add-layer3-capability" data-kind="comment" role="menuitem" ${comment ? "disabled" : ""}><b>${icon("file", 13)} 评论要求</b><span>${comment ? "已添加" : "对 C2 内容的一级评论做关键词判定"}</span></button>
  </div>` : "";

  const asrCard = asr ? `<div class="condition capability">
    <div class="insp-head">
      <span class="idx">01</span>
      <div class="insp-id">
        <span class="capability-icon">${icon("spark", 15)}</span>
        <span class="name-pill">音频 ASR</span>
        <label class="alias-pill"><span>能力别名（可选）</span><input class="input alias-input" value="${esc(asr.alias ?? "")}" data-action="set-layer3-alias" data-kind="asr" ${disabled} aria-label="能力别名" placeholder="例如：口播卖点判定" title="能力别名，显示在配置页、证据与导出明细中" /></label>
        <span class="badge ${state.asrEnabled ? "green" : "gray"}">${state.asrEnabled ? "能力已启用" : "当前不可用"}</span>
      </div>
      <button class="icon-btn cap-remove" data-action="remove-layer3-capability" data-kind="asr" ${disabled} title="删除能力" aria-label="删除能力">${icon("x", 15)}</button>
    </div>
    <div class="insp-body single">
      <div class="settings">
        <div class="field" style="margin-bottom:0"><label>判定标准</label><textarea class="textarea" data-action="set-asr-text" ${disabled}>${esc(asr.standardText ?? "口播要提到海信，并说明 618 活动优惠。")}</textarea><div class="hint">1–2000 字；每计划最多一个 ASR 判定项；C 用固定提示词 + 该标准 + 模型版本判定，不做多轮对话。</div></div>
        ${asrBlocked ? notice("warn", "warn", "音频理解暂不可用：H1 网关未落地 / 能力未验证。含第 3 层的计划不能发布，也不会发起付费调用。") : ""}
      </div>
    </div>
  </div>` : "";

  const commentCard = comment ? `<div class="condition capability">
    <div class="insp-head">
      <span class="idx">${asr ? "02" : "01"}</span>
      <div class="insp-id">
        <span class="capability-icon">${icon("file", 15)}</span>
        <span class="name-pill">评论要求</span>
        <label class="alias-pill"><span>能力别名（可选）</span><input class="input alias-input" value="${esc(comment.alias ?? "")}" data-action="set-layer3-alias" data-kind="comment" ${disabled} aria-label="能力别名" placeholder="例如：安装与售后评论" title="能力别名，显示在配置页、证据与导出明细中" /></label>
      </div>
      <button class="icon-btn cap-remove" data-action="remove-layer3-capability" data-kind="comment" ${disabled} title="删除能力" aria-label="删除能力">${icon("x", 15)}</button>
    </div>
    <div class="insp-body single">
      <div class="settings">
        <div class="cap-grid three">
          <div class="field"><label>组合方式</label><select class="select" data-action="set-comment-mode" ${disabled}><option value="any" ${comment.mode === "any" ? "selected" : ""}>任一词命中</option><option value="all" ${comment.mode === "all" ? "selected" : ""}>全部词命中</option></select></div>
          <div class="field"><label>评论达标方式</label><select class="select" data-action="set-comment-method" ${disabled}><option value="at_least_n" ${comment.method?.type === "at_least_n" ? "selected" : ""}>至少 N 条</option><option value="all" ${comment.method?.type === "all" ? "selected" : ""}>全部通过</option><option value="any" ${comment.method?.type === "any" ? "selected" : ""}>任一条通过</option><option value="ratio" ${comment.method?.type === "ratio" ? "selected" : ""}>比例阈值</option></select></div>
          <div class="field"><label>N / 比例</label><input class="input" type="number" min="1" value="${comment.method?.n ?? 2}" data-action="set-comment-n" ${disabled} /></div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label>评论关键词</label>
          <div class="chips">${(comment.keywords ?? []).map((k) => `<span class="chip on">${esc(k)}<button data-action="remove-comment-keyword" data-value="${esc(k)}" aria-label="移除 ${esc(k)}">${icon("x", 11)}</button></span>`).join("")}</div>
          <div class="inline-field" style="margin-top:8px;max-width:420px"><input class="input" style="flex:1" placeholder="输入关键词" data-comment-keyword-input ${disabled} /><button class="btn sm" data-action="add-comment-keyword" ${disabled}>添加</button></div>
        </div>
        <div class="hint">评论只对 C2（通过第 1、2 层）的内容采集；不保存评论原文与作者；覆盖不全的缺口计入未获取成功。</div>
      </div>
    </div>
  </div>` : "";

  return `<div class="wizard-grid">
    <div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">第 3 页 · 理解与执行</div><div class="card-sub">确认执行即发布新版本；评论只对通过前两层的内容采集</div></div>${ready ? badge("可执行", "green") : badge("待比对", "amber")}</div>
        <div class="card-body">
          <div class="section-head">
            <div><div class="card-title">第 3 层能力</div><div class="card-sub">按需添加；没有能力时第 3 页视为空配置</div></div>
            <div class="capability-add"><button class="btn" data-action="toggle-layer3-menu" data-id="${plan.id}" ${disabled}>${icon("plus", 15)}添加能力</button>${menu}</div>
          </div>
          <div style="margin-top:12px">
            ${asrCard}${commentCard}
            ${!asr && !comment ? `<div class="empty" style="padding:24px"><div class="empty-icon">${icon("layers", 20)}</div><h3>第 3 页没有额外能力</h3><p>数量要求已在第 1 层能力中配置，可以直接确认执行。</p></div>` : ""}
          </div>
          <div class="card pad" style="background:var(--surface-sunken);border-style:dashed;margin-top:14px">
            <div class="inline-actions" style="justify-content:space-between"><span class="small muted">将执行</span><b class="num">${plan.circle?.contents ?? 128} 条内容 · ${plan.circle?.participants ?? 42} 名参与专员 · 评论候选 C2 ${plan.trial?.c2 ?? 94} 条</b></div>
            <div class="small muted" style="margin-top:4px">执行期间名单冻结；等待采集上限 2 小时；1.0 不展示费用预估，费用由 I 域硬上限兜底。</div>
          </div>
          <div class="wizard-actions">
            <button class="btn primary" data-action="confirm-open" data-id="${plan.id}" ${readOnly || !ready || asrBlocked ? "disabled" : ""}>${icon("check", 15)}确认执行</button>
            <button class="btn" data-action="rollback-open" data-id="${plan.id}" data-target="2" ${disabled || !ready ? "disabled" : ""}>${icon("refresh", 15)}回退到第 2 页</button>
          </div>
        </div>
      </div>
    </div>
    <div class="wizard-side">
      <div class="side-card"><div class="side-title">确认执行 = 发布</div><p class="small muted">存在草稿时，确认执行把草稿发布为新版本并开始执行；没有草稿时，「重新执行」对最近已发布版本再跑一次，不升版。</p><div class="kv" style="margin-top:8px"><span class="k">当前草稿</span><span class="v">v${plan.draftVersion}</span></div><div class="kv"><span class="k">发布后</span><span class="v">v${plan.draftVersion}（不可变）</span></div><div class="kv"><span class="k">旧版本结果</span><span class="v">保留可查</span></div></div>
      <div class="side-card"><div class="side-title">第 3 页的门槛</div><p class="small muted">含 ASR 判定项且能力不可执行时，发布与开始执行都会被拒，并列出阻塞项；执行中途丢失能力才记未获取成功。</p></div>
    </div>
  </div>`;
}

function executionRows(execution) {
  if (!execution._rows) execution._rows = participantsFor(execution);
  return execution._rows;
}

const REASON_LABELS = {
  media_pending: "素材未归档",
  audio_not_archived: "音频未归档",
  comments_incomplete: "评论覆盖不全",
  account_unavailable: "账号不可用",
  no_profile_snapshot: "无主页快照",
  sync_gap: "同步有缺口",
  sync_failed: "同步失败",
  not_computed: "识别尚未补算",
  published_at_missing: "发布时间缺失",
  content_kind_unknown: "内容形态无法归类",
  layer1_text_miss: "第 1 层文本未命中",
  layer2_below_threshold: "第 2 层低于阈值",
  dependency_timeout: "依赖超时",
  not_executable: "能力不可执行",
};

function reasonLabel(code) {
  return REASON_LABELS[code] ?? code ?? "—";
}

function executionsView() {
  if (!canEnter()) return shell(noAccessPage("门店专员没有执行记录入口", "执行记录只对总部与分公司开放。"), crumbs(["工作台", "判定计划", "执行记录"]));
  const plans = new Map(state.plans.map((p) => [p.id, p]));
  const rows = [...state.executions].sort((a, b) => b.id - a.id);
  const counts = {
    all: rows.length,
    active: rows.filter((e) => ["planned", "running", "waiting"].includes(e.status)).length,
    done: rows.filter((e) => e.status === "completed").length,
    bad: rows.filter((e) => ["failed", "cancelled"].includes(e.status)).length,
  };
  const body = rows.map((e) => {
    const p = plans.get(e.planId);
    const waiting = waitingLabel(e);
    const countsText = e.counts ? `${e.counts.success} / ${e.counts.notMet} / ${e.counts.unobtained}` : "—";
    return `<tr class="clickable" data-action="open-execution" data-id="${e.id}">
      <td><div class="mono">#${e.id}</div><div class="small muted">${esc(p?.alias ?? e.planId)}</div></td>
      <td class="mono">v${e.version}</td>
      <td>${statusBadge(e)}${waiting ? `<div class="hint">${esc(waiting)}</div>` : ""}</td>
      <td class="small">${esc(e.startedAt)}<div class="hint">${e.completedAt ? `完成 ${esc(e.completedAt)}` : "尚未结束"}</div></td>
      <td class="num">${e.participants}</td>
      <td class="num">${countsText}</td>
      <td class="right"><button class="btn sm" data-action="open-execution" data-id="${e.id}">查看</button></td>
    </tr>`;
  }).join("");
  return shell(`
    <div class="page-head">
      <div><div class="page-title">执行记录</div><div class="page-sub">排队、执行中、等待采集、等待识别、完成、失败与取消；同一计划的最新 completed 即当前结果。</div></div>
      <div class="page-actions"><a class="btn" href="#/judgement">${icon("arrowLeft", 15)}返回判定计划</a></div>
    </div>
    <div class="overview four">
      <div class="stat"><div class="stat-label">全部执行</div><div class="stat-value">${counts.all}</div><div class="stat-note">最近在前</div></div>
      <div class="stat"><div class="stat-label">在途</div><div class="stat-value">${counts.active}</div><div class="stat-note">排队 / 执行 / 等待</div></div>
      <div class="stat"><div class="stat-label">已完成</div><div class="stat-value green">${counts.done}</div><div class="stat-note">可查看点检表</div></div>
      <div class="stat"><div class="stat-label">失败 / 取消</div><div class="stat-value red">${counts.bad}</div><div class="stat-note">保留原因与证据</div></div>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="card-title">全部执行</div><div class="card-sub">成功 / 不达标 / 未获取成功按参与专员计数</div></div><span class="badge plain">${rows.length} 条</span></div>
      <div class="table-wrap">
        <table class="table wide">
          <thead><tr><th>执行 / 计划</th><th>版本</th><th>状态</th><th>开始 / 完成</th><th class="right">参与专员</th><th class="right">成功 / 不达标 / 未获取</th><th></th></tr></thead>
          <tbody>${body || `<tr><td colspan="7"><div class="empty" style="padding:24px"><h3>还没有执行记录</h3><p>发布并执行后，记录会出现在这里。</p></div></td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `, crumbs(["工作台", "判定计划", "执行记录"]));
}

function executionView(id) {
  const e = findExecution(id);
  if (!e) return shell(`<div class="card"><div class="empty"><div class="empty-icon">${icon("info", 20)}</div><h3>执行不存在</h3><p>它可能已被清理，或不在当前范围内。</p><a class="btn" href="#/judgement">返回判定计划</a></div></div>`, crumbs(["工作台", "判定计划", "执行记录"]));
  if (!canEnter()) return shell(noAccessPage("门店专员没有执行记录入口", "执行记录只对总部与分公司开放。"), crumbs(["工作台", "判定计划", "执行记录"]));
  const plan = findPlan(e.planId);
  const readOnly = !canWrite(plan);
  const rows = e.status === "completed" ? executionRows(e) : [];
  const syncBad = rows.filter((r) => !r.syncComplete).length;
  const counts = e.counts;
  const actions = [
    `<a class="btn" href="#/executions">${icon("arrowLeft", 15)}全部记录</a>`,
  ];
  if (e.status === "completed") {
    actions.push(`<button class="btn primary" data-action="open-results" data-id="${e.id}">${icon("external", 15)}查看点检表（E）</button>`);
    actions.push(`<button class="btn" data-action="download-result" data-id="${e.id}">${icon("download", 15)}下载判定结果（E6）</button>`);
    if (!readOnly && plan && !isArchived(plan)) actions.push(`<button class="btn" data-action="new-draft-from" data-id="${plan.id}" data-version="${e.version}">${icon("plus", 15)}从此版本新建草稿</button>`);
  } else if (["planned", "running", "waiting"].includes(e.status)) {
    if (!readOnly) {
      actions.push(`<button class="btn" data-action="skip-wait" data-id="${e.id}">跳过等待（演示）</button>`);
      actions.push(`<button class="btn danger" data-action="cancel-open" data-id="${e.id}">取消执行</button>`);
    }
  } else if (e.status === "failed") {
    if (!readOnly) actions.push(`<button class="btn primary" data-action="resume-run" data-id="${e.id}">${icon("refresh", 15)}续跑</button>`);
  }

  const overview = `<div class="overview">
    ${stat("参与专员", e.participants, "执行冻结的名单")}
    ${stat("成功", counts ? counts.success : "—", counts ? "计划总结果" : "尚未完成", "green")}
    ${stat("不达标", counts ? counts.notMet : "—", counts ? "不达标优先" : "", "red")}
    ${stat("未获取成功", counts ? counts.unobtained : "—", counts ? "单独统计" : "", "gray")}
    ${stat("C1 / C2 / C3", `${e.c1 ?? "—"} / ${e.c2 ?? "—"} / ${e.c3 ?? "—"}`, "各层通过条数")}
    ${stat("stale", e.staleUsed, "使用了旧值的内容", "gray")}
  </div>`;

  let stateBlock = "";
  if (e.status === "waiting") {
    stateBlock = notice("info", "clock", `<b>${esc(waitingLabel(e))}</b>：${e.progress} / ${e.participants} 名专员已处理。`, `等待中的依赖类型写在 <span class="mono">phase_detail.waiting_on</span> = <b>${esc(e.waitingOn)}</b>；界面「等待采集 / 等待识别」只看它，不看 status。` + `<div class="progress" style="margin-top:8px"><i style="width:${Math.round((e.progress / e.participants) * 100)}%"></i></div>` + `<div class="inline-actions" style="margin-top:8px"><a class="btn sm" href="#/results/${e.id}">完成后查看点检表（E）</a><span class="hint">等待采集完成后本页会自动更新；也可以稍后从执行记录进入。</span></div>`);
  } else if (e.status === "running") {
    stateBlock = notice("info", "refresh", `<b>执行中</b>：${e.progress} / ${e.participants} 名专员已处理。`, `<div class="progress" style="margin-top:8px"><i style="width:${Math.round((e.progress / e.participants) * 100)}%"></i></div>`);
  } else if (e.status === "failed") {
    stateBlock = notice("danger", "warn", `<b>执行失败</b>：${esc(reasonLabel(e.failure?.code))}（<span class="mono">${esc(e.failure?.code)}</span>）。`, "已定的内容保留，可以续跑；发布与开始执行时被拒的阻塞项不会跑完再记未获取成功。");
  } else if (e.status === "cancelled") {
    stateBlock = notice("info", "info", "<b>已取消</b>：取消的运行不对 E 可见；已提交的采集由 A / C 自己跑完。", "取消后不再提交新依赖。");
  } else if (e.status === "completed" && syncBad) {
    stateBlock = notice("warn", "warn", `有 <b>${syncBad}</b> 名专员的窗口内同步不完整。`, "他们的「不达标」可能是误判：缺失的内容本来可能让他们达标。D 先按 PRD 不改三值，只在明细与导出里提示。");
  } else if (e.status === "completed" && e.id === 123) {
    stateBlock = notice("info", "layers", "这次执行的内容级结果已按保留期清理。", "参与专员与汇总仍长期保留；E 读取内容明细会得到 content_rows_pruned。");
  }

  const filtered = rows.filter((r) => {
    if (state.participantFilter === "sync") return !r.syncComplete;
    return state.participantFilter === "all" || r.planResult === state.participantFilter;
  });
  const shown = state.showAllParticipants ? filtered : filtered.slice(0, 12);
  const participantTable = e.status === "completed" ? `
    <div class="card">
      <div class="card-head"><div><div class="card-title">参与专员</div><div class="card-sub">成功 + 不达标 + 未获取成功 = 参与专员数；点击行看逐层与证据</div></div><div class="inline-actions"><span class="badge gray">${rows.length} 人</span>${syncBad ? `<span class="badge amber">${syncBad} 人同步不完整</span>` : ""}</div></div>
      <div class="card-body" style="padding-bottom:8px"><div class="chips">
        ${[["all", "全部"], ["success", "成功"], ["not_met", "不达标"], ["unobtained", "未获取成功"], ["sync", "同步不完整"]].map(([k, label]) => `<button class="chip ${state.participantFilter === k ? "on" : ""}" data-action="filter-participant" data-value="${k}">${label}</button>`).join("")}
      </div></div>
      <div class="table-wrap"><table class="table wide">
        <thead><tr><th>专员</th><th>账号</th><th class="right">内容</th><th class="right">C1 / C2 / C3</th><th class="right">P / U / F</th><th>内容</th><th>评论</th><th>账号</th><th>总结果</th><th>主要原因</th></tr></thead>
        <tbody>${shown.map((r) => `<tr class="clickable" data-action="open-participant" data-execution="${e.id}" data-staff="${r.staffId}">
          <td><div class="cell-main">${esc(r.name)} ${r.staleUsed ? `<span class="tag" title="使用了 stale 旧值">stale</span>` : ""} ${!r.syncComplete ? `<span class="badge amber">同步缺口</span>` : ""}</div><div class="cell-sub">${esc(r.store)} · ${esc(r.branch)}</div></td>
          <td class="mono small">${esc(r.account)}</td>
          <td class="right num">${r.total}${r.zeroContent ? ` <span class="tag">零内容</span>` : ""}</td>
          <td class="right num">${r.c1} / ${r.c2} / ${r.c3}</td>
          <td class="right num">${r.p} / ${r.u} / ${r.f}</td>
          <td>${resultBadge(r.contentResult)}</td>
          <td>${resultBadge(r.commentResult)}</td>
          <td>${resultBadge(r.accountResult)}</td>
          <td>${resultBadge(r.planResult)}</td>
          <td class="small muted">${esc(reasonLabel(r.primaryReason))}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      ${filtered.length > 12 ? `<div class="card-body" style="border-top:1px solid var(--line-2);padding:10px 18px"><button class="btn sm" data-action="toggle-all-participants">${state.showAllParticipants ? "收起" : `显示全部 ${filtered.length} 人`}</button></div>` : ""}
    </div>` : "";

  return shell(`
    <a class="back-link" href="#/executions">${icon("arrowLeft", 14)}执行记录</a>
    ${pageHead(`执行 #${e.id} ${statusBadge(e)}`, `${esc(plan?.alias ?? "—")} · v${e.version} · 提交人 ${esc(e.submittedBy)} · 窗口 ${esc(e.window)}`, actions.join(""))}
    ${stateBlock ? `<div style="margin-bottom:14px">${stateBlock}</div>` : ""}
    ${overview}
    ${counts ? `<div class="card pad" style="margin-bottom:14px"><div class="result-split"><div class="seg green" style="width:${(counts.success / e.participants) * 100}%"></div><div class="seg red" style="width:${(counts.notMet / e.participants) * 100}%"></div><div class="seg gray" style="width:${(counts.unobtained / e.participants) * 100}%"></div></div><div class="legend"><span><i style="background:#2fa36b"></i>成功 ${counts.success}</span><span><i style="background:#e5484d"></i>不达标 ${counts.notMet}</span><span><i style="background:#9aa5b1"></i>未获取成功 ${counts.unobtained}</span><span class="muted">完成率 ${Math.round((counts.success / e.participants) * 100)}% · 分母 = 参与专员数</span></div></div>` : ""}
    ${participantTable}
  `, crumbs(["工作台", "判定计划", plan?.alias ?? "执行", `执行 #${e.id}`]));
}

function resultsPlaceholder(executionId) {
  const e = findExecution(executionId);
  return shell(`
    <a class="back-link" href="#/executions/${executionId}">${icon("arrowLeft", 14)}返回执行 #${executionId}</a>
    ${pageHead("组织点检表与专员明细", "E 域（指标与看板）的页面，不在本次 D 原型范围内。")}
    <div class="card"><div class="empty">
      <div class="empty-icon">${icon("chart", 20)}</div>
      <h3>这里是 E 的点检表入口</h3>
      <p>D 只提供只读的判定结果：参与专员、内容证据、执行描述。点检表、专员明细、计划看板与导出文件由 E 域设计；D 不出文件。</p>
      ${e ? `<div class="overview" style="margin:20px auto 0;max-width:720px">${stat("执行", `#${e.id}`, `v${e.version}`)}${stat("参与专员", e.participants, "冻结名单")}${stat("成功", e.counts?.success ?? "—", "点检表分子", "green")}${stat("未获取成功", e.counts?.unobtained ?? "—", "单独统计", "gray")}</div>` : ""}
      <div class="inline-actions" style="justify-content:center;margin-top:18px">
        <a class="btn" href="#/executions/${executionId}">${icon("arrowLeft", 15)}回到 D 的执行记录</a>
        <a class="btn primary" href="http://localhost:4400" target="_blank" rel="noreferrer">${icon("external", 15)}打开完整应用</a>
      </div>
    </div></div>`, crumbs(["工作台", "判定计划", "报表与看板", "点检表（E）"]), "reports");
}

/* ---------------- 弹窗 ---------------- */

function modalShell(title, sub, body, foot, wide = false) {
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><div><div class="modal-title">${esc(title)}</div>${sub ? `<div class="modal-sub">${esc(sub)}</div>` : ""}</div><button class="icon-btn" data-action="close-modal" aria-label="关闭">${icon("x", 16)}</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${foot}</div>
  </div></div>`;
}

function renderModal() {
  const m = state.modal;
  if (m.type === "new") {
    const options = ACTIVITY_PLANS.filter((a) => a.status === "collecting" && (state.role === "platform_admin" || a.createdByMe));
    return modalShell("新建判定计划", "只列本人创建的活动计划；超管可选全部", `
      <form data-form="new-plan">
        ${m.error ? notice("danger", "warn", m.error) : ""}
        <div class="field"><label>所属活动计划</label><select class="select" name="activityPlanId" required>${options.map((a) => `<option value="${a.id}">${esc(a.name)} · ${esc(a.platform)} · ${a.roster} 名专员</option>`).join("")}</select><div class="hint">活动计划须处于「采集中」；暂停 / 归档期间不能新建。</div></div>
        <div class="field"><label>别名</label><input class="input" name="alias" maxlength="200" required value="${esc(m.alias ?? "618 焕新视频考核")}" placeholder="例如：618 主推视频考核" /><div class="hint">同一活动计划内唯一；E 用它作列头。</div></div>
        <div class="field"><label>说明（可选）</label><textarea class="textarea" name="description" maxlength="2000" placeholder="这次考核看什么、为什么这么配">618 主推视频需带活动话题、封面合规，至少 3 条；评论需提到安装或售后。</textarea></div>
      </form>`, `
      <span class="left">创建后进入第 1 页；D 与 C 各有一份草稿 v1。</span>
      <button class="btn" data-action="close-modal">取消</button>
      <button class="btn primary" data-action="submit-new-plan">创建并进入第 1 页</button>`);
  }

  if (m.type === "confirm-execute") {
    const plan = findPlan(m.planId);
    const c = ensureConfig(plan);
    return modalShell("发布并执行", `${plan.alias} · 草稿 v${plan.draftVersion}`, `
      <div class="notice info" style="margin-bottom:12px">${icon("info", 16)}<div>确认执行会把草稿 <b>v${plan.draftVersion}</b> 发布为新版本并开始执行；已发布版本不可改。</div></div>
      <div class="kv"><span class="k">将发布</span><span class="v">v${plan.draftVersion}（不可变）</span></div>
      <div class="kv"><span class="k">将执行</span><span class="v">${plan.circle?.contents ?? 128} 条内容 · ${plan.circle?.participants ?? 42} 名参与专员</span></div>
      <div class="kv"><span class="k">评论候选</span><span class="v">C2 ${plan.trial?.c2 ?? 94} 条内容</span></div>
      <div class="kv"><span class="k">第 3 层</span><span class="v">${state.asrEnabled && c.contentRequirement?.layer3 ? "包含 ASR 判定（付费，1.0 不展示费用）" : "不含（音频理解当前不可用）"}</span></div>
      <div class="kv"><span class="k">执行期间</span><span class="v">名单、归属、组织链与内容快照冻结</span></div>
      <div class="notice warn" style="margin-top:12px">${icon("warn", 16)}<div>1.0 不展示费用预估；费用由 I 域硬上限兜底。执行可能因采集等待较久，可随时取消。</div></div>`,
      `<span class="left">确认后开始执行，不能撤回这次提交。</span><button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="confirm-execute" data-id="${plan.id}">发布 v${plan.draftVersion} 并执行</button>`, true);
  }

  if (m.type === "rollback") {
    const plan = findPlan(m.planId);
    const target = m.target ?? Math.max(1, currentWizardStep(plan) - 1);
    const trialLines = target === 2 ? "1 次试跑运行（94 行）" : "1 次圈定运行（128 行）";
    return modalShell("回退一层？", `${plan.alias} · 草稿 v${plan.draftVersion}`, `
      <div class="notice warn" style="margin-bottom:12px">${icon("warn", 16)}<div>回退只作用于草稿；已发布版本的执行结果不受影响，也不会删除历史。</div></div>
      <div class="kv"><span class="k">回退到</span><span class="v">第 ${target} 页</span></div>
      <div class="kv"><span class="k">将删除</span><span class="v">${trialLines}</span></div>
      <div class="kv"><span class="k">保留</span><span class="v">${target === 2 ? "圈定结果" : "无后续结果"}</span></div>
      <p class="hint" style="margin-top:10px">回退不保留被删除的草稿结果；要改配置可继续编辑当前草稿。</p>`,
      `<span class="left">删除不可恢复。</span><button class="btn" data-action="close-modal">取消</button><button class="btn danger" data-action="rollback-apply" data-id="${plan.id}" data-target="${target}">确认回退</button>`);
  }

  if (m.type === "new-draft") {
    const plan = findPlan(m.planId);
    const published = versionsOf(plan.id).filter((v) => v.status === "published");
    return modalShell("新建草稿", `${plan.alias} · 从已发布版本复制`, `
      <div class="notice info" style="margin-bottom:12px">${icon("info", 16)}<div>草稿的向导进度归零：圈定与试跑结果不带过去。旧版本的执行结果保留可查。</div></div>
      <div class="field"><label>从哪个已发布版本复制</label><select class="select" data-role="draft-from">${published.map((v) => `<option value="${v.version}" ${String(m.fromVersion ?? published[0]?.version) === String(v.version) ? "selected" : ""}>v${v.version} · ${esc(v.publishedAt ?? "")} · ${esc(v.note)}</option>`).join("")}</select><div class="hint">可指定任意已发布版本，对应 PRD §2.3「回退到某一版」。</div></div>
      <div class="field"><label>创建后落到第几页</label><select class="select" data-role="draft-target"><option value="1">第 1 页 · 圈定</option><option value="2">第 2 页 · 比对</option><option value="3">第 3 页 · 理解与执行</option></select><div class="hint">只影响进入的页面；进度仍从「草稿」开始，前一步完成前不能试跑。</div></div>
      <div class="kv"><span class="k">新草稿</span><span class="v">v${plan.latestVersion + 1}</span></div>`,
      `<span class="left">配置与图片从所选版本复制。</span><button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="new-draft-apply" data-id="${plan.id}">创建草稿</button>`);
  }

  if (m.type === "archive") {
    const plan = findPlan(m.planId);
    return modalShell("归档判定计划", plan.alias, `
      <div class="notice warn" style="margin-bottom:12px">${icon("warn", 16)}<div>归档后不能新建草稿或执行；历史执行与结果照常可读。取消归档可恢复。</div></div>
      <div class="kv"><span class="k">进行中的执行</span><span class="v">${executionsOf(plan.id).filter((e) => ["planned", "running", "waiting"].includes(e.status)).length} 个</span></div>`,
      `<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="archive-apply" data-id="${plan.id}">归档</button>`);
  }

  if (m.type === "cancel-run") {
    const e = findExecution(m.executionId);
    return modalShell("取消执行", `执行 #${e.id}`, `
      <div class="notice warn" style="margin-bottom:12px">${icon("warn", 16)}<div>取消后不再提交新依赖；已提交的采集由 A / C 自己跑完。取消的执行不对 E 可见。</div></div>
      <div class="kv"><span class="k">当前进度</span><span class="v">${e.progress} / ${e.participants}</span></div>`,
      `<button class="btn" data-action="close-modal">保留</button><button class="btn danger" data-action="cancel-apply" data-id="${e.id}">取消执行</button>`);
  }

  return "";
}

/* ---------------- 抽屉 ---------------- */

function renderDrawer() {
  const { executionId, staffId } = state.drawer;
  const e = findExecution(executionId);
  const row = e ? executionRows(e).find((r) => r.staffId === staffId) : null;
  if (!e || !row) return "";
  const contents = contentsFor(row);
  const rowsHtml = contents.map((c) => {
    const open = state.expandedContent === c.contentId;
    return `<tr class="clickable" data-action="expand-content" data-cid="${c.contentId}">
      <td><div class="cell-main mono">${esc(c.contentId)}</div><div class="cell-sub">${esc(c.publishedAt)} · ${esc(c.kind)} · ${esc(c.duration)}</div></td>
      <td>${resultBadge(c.l1)}</td><td>${resultBadge(c.l2)}</td><td>${resultBadge(c.l3)}</td><td>${resultBadge(c.final)}</td>
      <td class="small muted">${esc(reasonLabel(c.reason))}</td>
    </tr>${open ? `<tr><td colspan="6" style="background:var(--surface-sunken)">${evidencePanel(c)}</td></tr>` : ""}`;
  }).join("");

  return `<div class="drawer-backdrop" data-action="close-drawer"><div class="drawer" role="dialog" aria-modal="true">
    <div class="drawer-head">
      <div><div class="drawer-title">${esc(row.name)} ${row.staleUsed ? `<span class="tag">stale</span>` : ""}</div><div class="card-sub">${esc(row.store)} · ${esc(row.branch)} · <span class="mono">${esc(row.account)}</span></div>
      <div class="chips" style="margin-top:8px">
        <span class="tag">内容</span>${resultBadge(row.contentResult)}
        <span class="tag">评论</span>${resultBadge(row.commentResult)}
        <span class="tag">账号</span>${resultBadge(row.accountResult)}
        <span class="tag">总结果</span>${resultBadge(row.planResult)}
      </div></div>
      <button class="icon-btn" data-action="close-drawer" aria-label="关闭">${icon("x", 16)}</button>
    </div>
    <div class="drawer-body">
      ${!row.syncComplete ? notice("warn", "warn", "窗口内同步不完整：可能有内容没被采到。这个专员的不达标可能是误判；D 不改三值，只在明细与导出里提示。") : ""}
      <div class="overview" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
        ${stat("参与内容", row.total, row.zeroContent ? "零内容" : "窗口内、形态符合")}
        ${stat("P / U / F", `${row.p} / ${row.u} / ${row.f}`, "通过 / 未获取 / 不通过")}
        ${stat("C1 / C2 / C3", `${row.c1} / ${row.c2} / ${row.c3}`, "各层通过条数")}
        ${stat("主要原因", esc(reasonLabel(row.primaryReason)), row.syncComplete ? "同步完整" : "同步有缺口")}
      </div>
      ${row.zeroContent ? `<div class="card"><div class="empty" style="padding:28px"><div class="empty-icon">${icon("info", 20)}</div><h3>零内容</h3><p>${row.syncComplete ? "窗口内同步完整且无缺口 → 判不达标（确实没发）。" : "同步失败或有缺口 → 判未获取成功（不能把采集失败当成没发）。"}</p></div></div>` : `
      <div class="card">
        <div class="card-head"><div><div class="card-title">内容逐层结果</div><div class="card-sub">点击一行看证据；不出现内容正文与评论原文</div></div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>内容</th><th>L1</th><th>L2</th><th>L3</th><th>最终</th><th>原因</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      </div>`}
      <div class="inline-actions" style="margin-top:14px">
        <button class="btn" data-action="close-drawer">关闭</button>
        <button class="btn" data-action="open-results" data-id="${e.id}">${icon("external", 15)}打开点检表（E）</button>
      </div>
    </div>
  </div></div>`;
}

function evidencePanel(c) {
  const ev = c.evidence;
  return `<div style="padding:10px 12px 12px">
    <div class="chips" style="margin-bottom:8px">
      ${ev.text.map((k) => `<span class="chip on">命中「${esc(k)}」</span>`).join("")}
      ${ev.hashtag.map((k) => `<span class="chip on">话题 #${esc(k)}</span>`).join("")}
      ${ev.duration ? `<span class="chip">时长 ${esc(ev.duration)}</span>` : ""}
      ${c.stale ? `<span class="badge amber">stale 旧值</span>` : ""}
    </div>
    <div class="grid-3">
      <div class="card pad" style="background:#fff"><div class="small muted">封面 · 模板匹配</div><div class="num" style="font-size:20px;font-weight:650">${esc(ev.cover)}</div><div class="hint">阈值 6.50；整数百分位比较</div></div>
      <div class="card pad" style="background:#fff"><div class="small muted">封面 · 元素「logo」</div><div class="num" style="font-size:20px;font-weight:650">${esc(ev.element)}</div><div class="hint">阈值 7.00</div></div>
      <div class="card pad" style="background:#fff"><div class="small muted">评论</div><div class="num" style="font-size:20px;font-weight:650">${ev.comment.pass} / ${ev.comment.total}</div><div class="hint">命中 / 总条数；缺口计入未获取成功</div></div>
    </div>
    <div class="hint" style="margin-top:8px">L3：${c.l3 === "skipped" ? "未进入（前层未通过）" : c.l3 === "not_configured" ? "第 3 层未配置（本计划不含 ASR）" : c.l3 === "pass" ? "ASR 判定 meets" : c.l3 === "fail" ? "ASR 判定 not_meets" : "未获取成功"} · 证据自包含，C 清理结果行后仍可解释。</div>
  </div>`;
}

/* ---------------- 状态与动作 ---------------- */

function maxExecutionId() { return Math.max(0, ...state.executions.map((e) => e.id)); }

function createExecution(plan, version, auto = true) {
  const exec = {
    id: maxExecutionId() + 1,
    planId: plan.id,
    version,
    status: "waiting",
    statusLabel: "等待采集",
    startedAt: nowText(),
    completedAt: null,
    submittedBy: "刘学奎",
    participants: 42,
    counts: null,
    c1: plan.circle?.c1 ?? 112,
    c2: plan.trial?.c2 ?? 94,
    c3: null,
    staleUsed: 0,
    window: plan.window,
    waitingOn: "demand",
    progress: 0,
    _timers: [],
  };
  state.executions.unshift(exec);
  if (auto) {
    exec._timers.push(setTimeout(() => {
      if (exec.status !== "waiting") return;
      exec.status = "running"; exec.statusLabel = "执行中"; exec.waitingOn = "signals"; exec.progress = 24;
      if (state.route.view === "executions" && state.route.id === exec.id) render();
    }, 1800));
    exec._timers.push(setTimeout(() => {
      if (["waiting", "running"].includes(exec.status)) completeExecution(exec.id);
    }, 4200));
  }
  return exec;
}

function completeExecution(id) {
  const e = findExecution(id);
  if (!e || e.status === "completed") return;
  (e._timers ?? []).forEach(clearTimeout);
  e._timers = [];
  e.status = "completed"; e.statusLabel = "已完成"; e.waitingOn = null;
  e.completedAt = "2026-06-13 10:31"; e.progress = e.participants;
  e.counts = { success: 25, notMet: 12, unobtained: 5 };
  e.c3 = 58; e.staleUsed = 1;
  if (state.route.view === "executions" && state.route.id === e.id) render();
  toast("执行完成：成功 25 / 不达标 12 / 未获取成功 5");
}

function startCircle(planId) {
  const plan = findPlan(planId);
  if (!plan || !canWrite(plan)) return;
  state.busy = { type: "circle", planId };
  render();
  setTimeout(() => {
    plan.circle = clone(CIRCLE_RESULT);
    plan.wizardStep = "circled";
    plan.dirty = null;
    plan.updatedAt = nowText();
    state.busy = null;
    if (state.route.view === "wizard") render();
    toast("圈定完成：C1 112 条，14 条未获取成功");
  }, 1100);
}

function startTrial(planId) {
  const plan = findPlan(planId);
  if (!plan || !canWrite(plan)) return;
  if (!hasLayer2Caps(plan)) { toast("第 2 页没有比对能力，直接进入第 3 页即可"); return; }
  if (!allLayer2Uploaded(plan)) { toast("先为每个能力选择对比元素，并上传素材或填写要包含的文字"); return; }
  const caps = layer2Caps(plan);
  state.busy = { type: "trial", planId };
  render();
  setTimeout(() => {
    const base = clone(TRIAL);
    const pool = base.conditions.map((c) => c.distribution);
    const conditions = caps.map((cap, i) => {
      const distribution = pool[i % pool.length];
      const samples = Object.fromEntries(distribution.map((n, bucket) => [
        bucket,
        Array.from({ length: Math.min(5, Math.max(0, n)) }, (_, j) => `c-${1000 + i * 60 + bucket * 7 + j}`),
      ]));
      return {
        key: `ability_${i}`,
        label: `${L2_KIND_LABEL[cap.kind]} · ${L2_TARGET_LABEL[cap.target]}${cap.alias ? `（${cap.alias}）` : ""}`,
        threshold: cap.threshold,
        distribution,
        unobtained: base.conditions[i % base.conditions.length].unobtained,
        samples,
      };
    });
    plan.trialData = { ...base, conditions };
    plan.trial = plan.trialData;
    plan.trialThresholds = Object.fromEntries(conditions.map((c) => [c.key, c.threshold]));
    plan.sampleBucket = Object.fromEntries(conditions.map((c) => [c.key, 8]));
    plan.wizardStep = "compared";
    plan.dirty = null;
    plan.updatedAt = nowText();
    state.busy = null;
    if (state.route.view === "wizard") render();
    toast("试跑完成：每个比对能力已生成分布；换阈值不需要重算");
  }, 1400);
}

function createDraft(plan, fromVersion, target) {
  const version = plan.latestVersion + 1;
  plan.latestVersion = version;
  plan.draftVersion = version;
  plan.wizardStep = "draft";
  plan.dirty = null;
  plan.circle = null; plan.trial = null; plan.trialData = null; plan.uploads = {};
  plan.config = clone(plan.config ?? EMPTY_CONFIG);
  plan.updatedAt = nowText();
  state.versions[plan.id] = [{ version, status: "draft", publishedAt: null, basedOn: Number(fromVersion), note: `从 v${fromVersion} 复制` }, ...(state.versions[plan.id] ?? [])];
  state.modal = null;
  navigate(`#/judgement/${plan.id}/wizard/${target}`);
  toast(`已创建草稿 v${version}`);
}

function applyRollback(plan, target) {
  if (target === 1) {
    plan.wizardStep = "draft"; plan.circle = null; plan.trial = null; plan.trialData = null;
  } else if (target === 2) {
    plan.wizardStep = "circled"; plan.trial = null; plan.trialData = null;
  }
  plan.dirty = null;
  plan.updatedAt = nowText();
  state.modal = null;
  navigate(`#/judgement/${plan.id}/wizard/${target}`);
  toast("已回退；被删除的草稿结果不保留");
}

function createPlanFromForm(form) {
  const fd = new FormData(form);
  const activityPlanId = String(fd.get("activityPlanId"));
  const alias = String(fd.get("alias") ?? "").trim();
  const description = String(fd.get("description") ?? "").trim();
  const act = ACTIVITY_PLANS.find((a) => a.id === activityPlanId);
  if (!act || act.status !== "collecting") return { error: "活动计划不存在或不在「采集中」，不能新建判定计划。" };
  if (alias.length < 1 || alias.length > 200) return { error: "别名需为 1–200 字。" };
  if (state.plans.some((p) => p.activityPlanId === activityPlanId && p.alias === alias)) return { error: "同一活动计划内已存在同名判定计划。" };
  const id = `jp-new-${Date.now()}`;
  const plan = {
    id, activityPlanId, alias, description: description || "新建的判定计划",
    status: "active", statusLabel: "进行中", latestVersion: 1, publishedVersion: null, draftVersion: 1,
    wizardStep: "draft", platform: act.platform, window: `${EMPTY_CONFIG.window.from} ~ ${EMPTY_CONFIG.window.to}`,
    kinds: "视频", createdAt: nowText(), updatedAt: nowText(), creator: "刘学奎", archivedAt: null,
    config: clone(EMPTY_CONFIG), uploads: {},
  };
  state.plans.unshift(plan);
  state.versions[id] = [{ version: 1, status: "draft", publishedAt: null, basedOn: null, note: "首次创建" }];
  state.modal = null;
  navigate(`#/judgement/${id}/wizard/1`);
  toast("已创建判定计划与草稿 v1");
  return { ok: true };
}

/* ---------------- 事件 ---------------- */

const CLICK_ACTIONS = new Set([
  "open-new", "open-plan", "continue-draft", "goto-step", "circle", "trial", "upload-demo",
  "confirm-open", "confirm-execute", "rollback-open", "rollback-apply", "new-draft-open",
  "new-draft-from", "new-draft-apply", "archive-open", "archive-apply", "unarchive", "rerun",
  "cancel-open", "cancel-apply", "skip-wait", "resume-run", "open-participant", "expand-content",
  "close-modal", "close-drawer", "back-home", "toast-module", "download-circle", "download-result",
  "retry", "open-executions", "open-results", "open-execution", "toggle-all-participants",
  "filter-participant", "add-keyword", "add-tag", "remove-keyword", "remove-tag",
  "remove-comment-keyword", "add-text-condition", "add-hashtag-condition", "set-object",
  "toggle-capability-menu", "add-capability", "remove-capability",
  "toggle-layer2-menu", "add-layer2-capability", "remove-layer2-capability", "bump-threshold",
  "toggle-layer3-menu", "add-layer3-capability", "remove-layer3-capability", "add-comment-keyword",
  "submit-new-plan", "nav",
]);

function onClick(event) {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (!CLICK_ACTIONS.has(action)) return;
  if (action === "close-modal" && el.classList.contains("modal-backdrop") && event.target.closest(".modal")) return;
  if (action === "close-drawer" && el.classList.contains("drawer-backdrop") && event.target.closest(".drawer")) return;
  if (action === "nav") return;
  if (action === "toast-module") {
    event.preventDefault();
    toast("本原型只覆盖判定计划；其他模块见完整应用 http://localhost:4400");
    return;
  }
  if (action === "open-participant") {
    state.drawer = { executionId: Number(el.dataset.execution), staffId: el.dataset.staff };
    state.expandedContent = null;
    render();
    return;
  }
  if (action === "expand-content") {
    state.expandedContent = state.expandedContent === el.dataset.cid ? null : el.dataset.cid;
    render();
    return;
  }
  event.preventDefault();
  const planId = el.dataset.id;
  const plan = planId ? findPlan(planId) : findPlan(state.route.id);
  switch (action) {
    case "open-new": state.modal = { type: "new" }; render(); break;
    case "open-plan": navigate(`#/judgement/${el.dataset.id}`); break;
    case "continue-draft": {
      const p = findPlan(el.dataset.id);
      navigate(`#/judgement/${p.id}/wizard/${currentWizardStep(p)}`);
      break;
    }
    case "goto-step": navigate(`#/judgement/${el.dataset.id}/wizard/${el.dataset.step}`); break;
    case "circle": startCircle(el.dataset.id); break;
    case "trial": startTrial(el.dataset.id); break;
    case "upload-demo": {
      if (!plan || !canWrite(plan)) return;
      plan.uploads = plan.uploads ?? {};
      plan.uploads[el.dataset.kind] = true;
      if (plan.trial) invalidateFrom(plan, "trial");
      render(); toast("已放入演示标准图");
      break;
    }
    case "set-object": {
      if (!plan || !canWrite(plan)) return;
      plan.objectTab = el.dataset.object; render(); break;
    }
    case "confirm-open": state.modal = { type: "confirm-execute", planId: el.dataset.id }; render(); break;
    case "confirm-execute": {
      const p = findPlan(el.dataset.id);
      const version = p.draftVersion;
      p.publishedVersion = version;
      p.draftVersion = null;
      p.wizardStep = "published";
      p.updatedAt = nowText();
      state.versions[p.id] = (state.versions[p.id] ?? []).map((v) => v.version === version ? { ...v, status: "published", publishedAt: nowText() } : v);
      const exec = createExecution(p, version, true);
      state.modal = null;
      navigate(`#/executions/${exec.id}`);
      toast(`已发布 v${version} 并开始执行`);
      break;
    }
    case "rollback-open": {
      const p = findPlan(el.dataset.id);
      const target = Number(el.dataset.target ?? Math.max(1, currentWizardStep(p) - 1));
      state.modal = { type: "rollback", planId: p.id, target }; render(); break;
    }
    case "rollback-apply": applyRollback(findPlan(el.dataset.id), Number(el.dataset.target)); break;
    case "new-draft-open": {
      const p = findPlan(el.dataset.id);
      if (p.draftVersion) { toast("已有草稿；先发布或回退它"); return; }
      state.modal = { type: "new-draft", planId: p.id, fromVersion: p.publishedVersion }; render(); break;
    }
    case "new-draft-from": {
      const p = findPlan(el.dataset.id);
      if (p.draftVersion) { toast("已有草稿；先发布或回退它"); return; }
      state.modal = { type: "new-draft", planId: p.id, fromVersion: el.dataset.version }; render(); break;
    }
    case "new-draft-apply": {
      const p = findPlan(el.dataset.id);
      const from = document.querySelector("[data-role=draft-from]")?.value ?? p.publishedVersion;
      const target = document.querySelector("[data-role=draft-target]")?.value ?? "1";
      createDraft(p, from, target); break;
    }
    case "archive-open": state.modal = { type: "archive", planId: el.dataset.id }; render(); break;
    case "archive-apply": {
      const p = findPlan(el.dataset.id);
      p.status = "archived"; p.statusLabel = "已归档"; p.archivedAt = nowText(); p.updatedAt = nowText();
      state.modal = null; render(); toast("已归档；历史执行仍可读"); break;
    }
    case "unarchive": {
      const p = findPlan(el.dataset.id);
      p.status = "active"; p.statusLabel = "进行中"; p.archivedAt = null; p.updatedAt = nowText();
      render(); toast("已取消归档"); break;
    }
    case "rerun": {
      const p = findPlan(el.dataset.id);
      const exec = createExecution(p, p.publishedVersion, true);
      navigate(`#/executions/${exec.id}`); toast(`已对 v${p.publishedVersion} 重新执行，不升版`); break;
    }
    case "cancel-open": state.modal = { type: "cancel-run", executionId: Number(el.dataset.id) }; render(); break;
    case "cancel-apply": {
      const e = findExecution(el.dataset.id);
      e.status = "cancelled"; e.statusLabel = "已取消"; e.completedAt = nowText(); e.waitingOn = null; (e._timers ?? []).forEach(clearTimeout);
      state.modal = null; render(); toast("已取消；不对 E 可见"); break;
    }
    case "skip-wait": completeExecution(Number(el.dataset.id)); break;
    case "resume-run": {
      const e = findExecution(el.dataset.id);
      e.status = "waiting"; e.statusLabel = "等待识别"; e.waitingOn = "signals"; e.progress = 12;
      render(); toast("已从持久化阶段续跑");
      setTimeout(() => completeExecution(e.id), 2600);
      break;
    }
    case "download-circle": toast("下载由 E 域的导出中心（E6）生成；D 只提供数据口"); break;
    case "download-result": toast("下载由 E 域的导出中心（E6）生成；D 只提供数据口"); break;
    case "open-executions": navigate("#/executions"); break;
    case "open-execution": navigate(`#/executions/${el.dataset.id}`); break;
    case "open-results": navigate(`#/results/${el.dataset.id}`); break;
    case "toggle-all-participants": state.showAllParticipants = !state.showAllParticipants; render(); break;
    case "filter-participant": state.participantFilter = el.dataset.value; render(); break;
    case "add-keyword": {
      if (!plan) return;
      const idx = Number(el.dataset.index ?? 0);
      const input = document.querySelector(`[data-keyword-input="${idx}"]`);
      const value = input?.value?.trim();
      if (value) { plan.config.layer1.text[idx].keywords.push(value); invalidateFrom(plan, "circle"); render(); }
      break;
    }
    case "add-tag": {
      if (!plan) return;
      const idx = Number(el.dataset.index ?? 0);
      const input = document.querySelector(`[data-tag-input="${idx}"]`);
      const value = input?.value?.trim().replace(/^#/, "");
      if (value) { plan.config.layer1.hashtags[idx].values.push(value); invalidateFrom(plan, "circle"); render(); }
      break;
    }
    case "remove-keyword": {
      if (!plan) return;
      const idx = Number(el.dataset.index ?? 0);
      plan.config.layer1.text[idx].keywords = plan.config.layer1.text[idx].keywords.filter((k) => k !== el.dataset.value); invalidateFrom(plan, "circle"); render(); break;
    }
    case "remove-tag": {
      if (!plan) return;
      const idx = Number(el.dataset.index ?? 0);
      plan.config.layer1.hashtags[idx].values = plan.config.layer1.hashtags[idx].values.filter((k) => k !== el.dataset.value); invalidateFrom(plan, "circle"); render(); break;
    }
    case "remove-comment-keyword": {
      if (!plan) return;
      plan.config.commentRequirement.keywords = plan.config.commentRequirement.keywords.filter((k) => k !== el.dataset.value); render(); break;
    }
    case "toggle-capability-menu": {
      if (!plan || !canWrite(plan)) return;
      state.capabilityMenu = state.capabilityMenu === plan.id ? null : plan.id;
      render(); break;
    }
    case "add-capability": {
      if (!plan || !canWrite(plan)) return;
      const type = el.dataset.type;
      if (type === "text") plan.config.layer1.text.push({ fields: ["title", "body"], mode: "any", keywords: [] });
      else if (type === "tag") plan.config.layer1.hashtags.push({ mode: "any", values: [] });
      else if (type === "duration" && !plan.config.layer1.duration) plan.config.layer1.duration = { minSeconds: 15, maxSeconds: 180 };
      state.capabilityMenu = null;
      invalidateFrom(plan, "circle");
      render(); break;
    }
    case "remove-capability": {
      if (!plan || !canWrite(plan)) return;
      const kind = el.dataset.kind;
      const idx = Number(el.dataset.index ?? 0);
      if (kind === "text") plan.config.layer1.text.splice(idx, 1);
      else if (kind === "tag") plan.config.layer1.hashtags.splice(idx, 1);
      else if (kind === "duration") plan.config.layer1.duration = null;
      state.capabilityMenu = null;
      invalidateFrom(plan, "circle");
      render(); break;
    }
    case "add-text-condition": {
      if (!plan) return;
      plan.config.layer1.text.push({ fields: ["title"], mode: "any", keywords: ["新品"] }); invalidateFrom(plan, "circle"); render(); break;
    }
    case "add-hashtag-condition": {
      if (!plan) return;
      plan.config.layer1.hashtags.push({ mode: "any", values: ["新品"] }); invalidateFrom(plan, "circle"); render(); break;
    }
    case "toggle-layer2-menu": {
      if (!plan || !canWrite(plan)) return;
      state.layer2Menu = state.layer2Menu === plan.id ? null : plan.id;
      state.layer3Menu = null; state.capabilityMenu = null;
      render(); break;
    }
    case "add-layer2-capability": {
      if (!plan || !canWrite(plan)) return;
      const c = ensureConfig(plan);
      const kind = el.dataset.kind;
      const ability = { kind, target: null, alias: "", threshold: kind === "image_text" ? "6.80" : "6.50" };
      if (kind === "image_text") ability.text = "";
      c.layer2.abilities = c.layer2.abilities ?? [];
      c.layer2.abilities.push(ability);
      state.layer2Menu = null;
      invalidateFrom(plan, "trial");
      render(); break;
    }
    case "bump-threshold": {
      if (!plan || !canWrite(plan)) return;
      const c = ensureConfig(plan);
      const idx = Number(el.dataset.index ?? 0);
      const target = c.layer2.abilities?.[idx];
      if (!target) return;
      const next = Math.max(0, Math.min(10, Number(target.threshold ?? 0) + Number(el.dataset.dir) * 0.1));
      target.threshold = next.toFixed(2);
      if (plan.trialThresholds) plan.trialThresholds[`ability_${idx}`] = target.threshold;
      render(); break;
    }
    case "remove-layer2-capability": {
      if (!plan || !canWrite(plan)) return;
      const c = ensureConfig(plan);
      const idx = Number(el.dataset.index ?? 0);
      c.layer2.abilities?.splice(idx, 1);
      plan.uploads = {};
      state.layer2Menu = null;
      invalidateFrom(plan, "trial");
      render(); break;
    }
    case "toggle-layer3-menu": {
      if (!plan || !canWrite(plan)) return;
      state.layer3Menu = state.layer3Menu === plan.id ? null : plan.id;
      state.layer2Menu = null; state.capabilityMenu = null;
      render(); break;
    }
    case "add-layer3-capability": {
      if (!plan || !canWrite(plan)) return;
      const c = ensureConfig(plan);
      const kind = el.dataset.kind;
      if (kind === "asr" && state.asrEnabled) {
        c.contentRequirement = c.contentRequirement ?? { method: { type: "at_least_n", n: 3 } };
        c.contentRequirement.layer3 = { standardText: "口播要提到海信，并说明 618 活动优惠。" };
      } else if (kind === "comment") {
        c.commentRequirement = { mode: "any", keywords: ["安装", "赠品", "售后"], method: { type: "at_least_n", n: 2 } };
      }
      state.layer3Menu = null;
      render(); break;
    }
    case "remove-layer3-capability": {
      if (!plan || !canWrite(plan)) return;
      const c = ensureConfig(plan);
      const kind = el.dataset.kind;
      if (kind === "asr" && c.contentRequirement) delete c.contentRequirement.layer3;
      else if (kind === "comment") c.commentRequirement = null;
      state.layer3Menu = null;
      render(); break;
    }
    case "add-comment-keyword": {
      if (!plan) return;
      const input = document.querySelector("[data-comment-keyword-input]");
      const value = input?.value?.trim();
      if (value && plan.config.commentRequirement) { plan.config.commentRequirement.keywords.push(value); render(); }
      break;
    }
    case "close-modal": state.modal = null; render(); break;
    case "close-drawer": state.drawer = null; state.expandedContent = null; render(); break;
    case "back-home": navigate("#/judgement"); break;
    case "retry": state.demo = "normal"; render(); break;
    case "submit-new-plan": {
      const form = document.querySelector('[data-form="new-plan"]');
      const result = createPlanFromForm(form);
      if (result?.error) { state.modal = { ...state.modal, error: result.error }; render(); }
      break;
    }
    default: break;
  }
}

function onChange(event) {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const plan = findPlan(state.route.id) ?? state.plans.find((p) => p.id === el.dataset.id);
  switch (action) {
    case "set-role": state.role = el.value; if (state.role === "store_staff") navigate("#/judgement"); else render(); break;
    case "set-demo": state.demo = el.value; render(); break;
    case "toggle-asr":
      state.asrEnabled = el.checked;
      if (el.checked && plan) {
        plan.config.contentRequirement = plan.config.contentRequirement ?? { method: { type: "at_least_n", n: 3 } };
        plan.config.contentRequirement.layer3 = plan.config.contentRequirement.layer3 ?? { standardText: "口播要提到海信，并说明 618 活动优惠。" };
      }
      render(); break;
    case "filter-activity": state.filterActivity = el.value; render(); break;
    case "filter-status": state.filterStatus = el.value; render(); break;
    case "filter-run": state.filterRun = el.value; render(); break;
    default: break;
  }
  if (!plan) return;
  switch (action) {
    case "set-window": plan.config.window[el.dataset.bound] = el.value; invalidateFrom(plan, "circle"); render(); break;
    case "toggle-kind": {
      const kinds = new Set(plan.config.kinds);
      if (el.checked) kinds.add(el.dataset.kind); else kinds.delete(el.dataset.kind);
      plan.config.kinds = [...kinds];
      invalidateFrom(plan, "circle");
      render(); break;
    }
    case "toggle-field": {
      const item = plan.config.layer1.text[Number(el.dataset.index)];
      const fields = new Set(item.fields);
      if (el.checked) fields.add(el.dataset.field); else fields.delete(el.dataset.field);
      item.fields = [...fields]; invalidateFrom(plan, "circle"); render(); break;
    }
    case "set-text-mode": plan.config.layer1.text[Number(el.dataset.index)].mode = el.value; invalidateFrom(plan, "circle"); render(); break;
    case "set-tag-mode": plan.config.layer1.hashtags[Number(el.dataset.index)].mode = el.value; invalidateFrom(plan, "circle"); render(); break;
    case "set-capability-quantity": {
      const item = el.dataset.kind === "text" ? plan.config.layer1.text[Number(el.dataset.index)] : plan.config.layer1.hashtags[Number(el.dataset.index)];
      if (!item) break;
      const raw = el.value.trim();
      item.minCount = raw === "" ? null : Math.max(1, Number(raw) || 1);
      invalidateFrom(plan, "circle");
      render(); break;
    }
    case "set-alias": {
      const target = el.dataset.kind === "text"
        ? plan.config.layer1.text[Number(el.dataset.index)]
        : el.dataset.kind === "tag"
          ? plan.config.layer1.hashtags[Number(el.dataset.index)]
          : el.dataset.kind === "duration" ? plan.config.layer1.duration : null;
      if (target) target.alias = el.value;
      break;
    }
    case "set-layer2-alias": {
      const idx = Number(el.dataset.index ?? 0);
      const target = ensureConfig(plan).layer2.abilities?.[idx];
      if (target) target.alias = el.value;
      break;
    }
    case "set-layer2-threshold": {
      const idx = Number(el.dataset.index ?? 0);
      const target = ensureConfig(plan).layer2.abilities?.[idx];
      if (!target) break;
      target.threshold = el.value;
      if (plan.trialThresholds) plan.trialThresholds[`ability_${idx}`] = el.value;
      render(); break;
    }
    case "set-layer2-target": {
      const idx = Number(el.dataset.index ?? 0);
      const target = ensureConfig(plan).layer2.abilities?.[idx];
      if (!target) break;
      target.target = el.value;
      invalidateFrom(plan, "trial");
      render(); break;
    }
    case "set-layer2-text": {
      const idx = Number(el.dataset.index ?? 0);
      const target = ensureConfig(plan).layer2.abilities?.[idx];
      if (!target) break;
      target.text = el.value;
      invalidateFrom(plan, "trial");
      render(); break;
    }
    case "set-layer3-alias": {
      const target = el.dataset.kind === "asr" ? plan.config.contentRequirement?.layer3 : plan.config.commentRequirement;
      if (target) target.alias = el.value;
      break;
    }
    case "set-comment-method": {
      const comment = plan.config.commentRequirement;
      if (comment) comment.method = { type: el.value, ...(el.value === "ratio" ? { bp: 5000 } : el.value === "at_least_n" ? { n: 2 } : {}) };
      render(); break;
    }
    case "set-comment-n": {
      const method = plan.config.commentRequirement?.method;
      if (!method) break;
      if (method.type === "ratio") method.bp = Math.max(1, Math.min(10000, Math.round(Number(el.value))));
      else if (method.type === "at_least_n") method.n = Math.max(1, Math.round(Number(el.value)));
      break;
    }
    case "set-duration": plan.config.layer1.duration[el.dataset.bound] = Number(el.value); invalidateFrom(plan, "circle"); render(); break;
    case "set-threshold": {
      if (!plan.trialThresholds) plan.trialThresholds = {};
      plan.trialThresholds[el.dataset.cond] = el.value;
      const idx = Number(String(el.dataset.cond).replace("ability_", ""));
      const ability = ensureConfig(plan).layer2.abilities?.[idx];
      if (ability) ability.threshold = el.value;
      render(); break;
    }
    case "set-sample-bucket": {
      plan.sampleBucket = plan.sampleBucket ?? {};
      plan.sampleBucket[el.dataset.cond] = Number(el.value); render(); break;
    }
    case "set-content-method": {
      plan.config.contentRequirement = plan.config.contentRequirement ?? { method: { type: "at_least_n", n: 3 } };
      plan.config.contentRequirement.method = { type: el.value, ...(el.value === "ratio" ? { bp: 5000 } : el.value === "at_least_n" ? { n: 3 } : {}) };
      render(); break;
    }
    case "set-content-n": {
      const method = plan.config.contentRequirement.method;
      if (method.type === "ratio") method.bp = Math.max(1, Math.min(10000, Math.round(Number(el.value))));
      else if (method.type === "at_least_n") method.n = Math.max(1, Math.round(Number(el.value)));
      break;
    }
    case "set-comment-mode": plan.config.commentRequirement.mode = el.value; render(); break;
    default: break;
  }
}

function onInput(event) {
  const slider = event.target.closest('[data-action="threshold-slider"]');
  if (slider) {
    const plan = findPlan(state.route.id);
    if (!plan) return;
    const idx = Number(slider.dataset.index ?? 0);
    const ability = ensureConfig(plan).layer2.abilities?.[idx];
    if (!ability) return;
    const value = Math.max(0, Math.min(10, Number(slider.value)));
    ability.threshold = value.toFixed(2);
    if (plan.trialThresholds) plan.trialThresholds[`ability_${idx}`] = ability.threshold;
    const box = slider.closest(".threshold");
    const score = box?.querySelector(".score");
    const fill = box?.querySelector(".gauge i");
    const mark = box?.querySelector(".gauge b");
    if (score) score.value = ability.threshold;
    if (fill) fill.style.width = `${value * 10}%`;
    if (mark) mark.style.left = `${value * 10}%`;
    return;
  }
  const el = event.target.closest('[data-action="set-asr-text"]');
  if (!el) return;
  const plan = findPlan(state.route.id);
  if (!plan) return;
  plan.config.contentRequirement = plan.config.contentRequirement ?? { method: { type: "at_least_n", n: 3 } };
  plan.config.contentRequirement.layer3 = { standardText: el.value };
}

function onSubmit(event) {
  const form = event.target.closest('[data-form="new-plan"]');
  if (!form) return;
  event.preventDefault();
  const result = createPlanFromForm(form);
  if (result?.error) { state.modal = { ...state.modal, error: result.error }; render(); }
}

/* ---------------- 渲染与启动 ---------------- */

function render() {
  const r = state.route;
  let content;
  if (r.view === "judgement-list") content = listView();
  else if (r.view === "judgement-detail") { const p = findPlan(r.id); content = p ? (p.draftVersion ? detailView(p) : detailView(p)) : listView(); }
  else if (r.view === "wizard") { const p = findPlan(r.id); content = p ? wizardView(p, r.step) : listView(); }
  else if (r.view === "executions") content = r.id ? executionView(r.id) : executionsView();
  else if (r.view === "results") content = resultsPlaceholder(r.executionId);
  else content = listView();
  const app = document.getElementById("app");
  if (app) app.innerHTML = content;
}

window.addEventListener("hashchange", () => {
  state.route = parseHash();
  state.modal = null;
  state.drawer = null;
  state.expandedContent = null;
  render();
  window.scrollTo(0, 0);
});
document.addEventListener("click", onClick);
document.addEventListener("change", onChange);
document.addEventListener("input", onInput);
document.addEventListener("submit", onSubmit);

render();