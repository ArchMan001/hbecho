// 原型入口：路由、事件、弹窗、表单与原型控制。
// 只用于 ui-lab，不进生产构建。

import { state } from "./store.js";
import { getPlan, getBatch, getUser, getAccount, DEMO_ACCOUNT } from "./data.js";
import { icon, esc } from "./ui.js";
import {
  renderPlans, renderNewPlan, renderPlanDetail, renderTrash, renderImportWizard,
  renderBatchList, renderBatchDetail, renderAccounts, accountModalHtml,
} from "./pages-a.js";
import { renderMasterImport, renderMasterBatches, renderMasterBatchDetail } from "./pages-m.js";
import { renderMasterBrowse } from "./pages-m-browse.js";
import {
  renderAuth, renderUsers, renderUserNew, renderUserDetail, renderUserImport,
  renderAudit, renderPlaceholder, renderStoreHome,
} from "./pages-b.js";

const app = document.getElementById("app");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalFoot = document.getElementById("modal-foot");
const toastEl = document.getElementById("toast");

let cooldownUntil = 0;
let cooldownTimer = null;
let lastAuthRoute = null;

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) return { name: "login" };
  const [head, second, third] = parts;
  if (head === "plans") {
    if (!second) return { name: "plans" };
    if (second === "new") return { name: "plan-new" };
    if (third === "import") return { name: "plan-import", id: second };
    return { name: "plan-detail", id: second };
  }
  if (head === "users") {
    if (!second) return { name: "users" };
    if (second === "new") return { name: "user-new" };
    if (second === "import") return { name: "user-import" };
    return { name: "user-detail", id: second };
  }
  if (head === "master") {
    if (second === "import") return { name: "master-import" };
    if (second === "batches") return third ? { name: "master-batch", id: third } : { name: "master-batches" };
    return { name: "master" };
  }
  if (head === "batches") return second ? { name: "batch-detail", id: second } : { name: "batches" };
  return { name: head, id: second, sub: third };
}

function render() {
  const route = parseRoute();
  const authRoutes = ["login", "activate", "forgot", "change-password"];
  if (authRoutes.includes(route.name)) {
    if (lastAuthRoute !== route.name) {
      state.authError = null;
      state.authNotice = null;
      lastAuthRoute = route.name;
    }
    app.innerHTML = renderAuth(route.name);
    syncCooldown();
    return;
  }
  lastAuthRoute = null;

  if (state.role === "store_staff" && !["store", "learning"].includes(route.name)) {
    app.innerHTML = renderStoreHome();
    syncCooldown();
    return;
  }

  let html = "";
  switch (route.name) {
    case "plans": html = renderPlans(); break;
    case "plan-new": html = renderNewPlan(); break;
    case "plan-detail": html = renderPlanDetail(route.id); break;
    case "plan-import": html = renderImportWizard(route.id); break;
    case "trash": html = renderTrash(); break;
    case "batches": html = renderBatchList(); break;
    case "batch-detail": html = renderBatchDetail(route.id); break;
    case "accounts": html = renderAccounts(); break;
    case "users": html = renderUsers(); break;
    case "user-new": html = renderUserNew(); break;
    case "user-detail": html = renderUserDetail(route.id); break;
    case "user-import": html = renderUserImport(); break;
    case "audit": html = renderAudit(); break;
    case "store": html = renderStoreHome(); break;
    case "master": html = renderMasterBrowse(); break;
    case "master-import": html = renderMasterImport(); break;
    case "master-batches": html = renderMasterBatches(); break;
    case "master-batch": html = renderMasterBatchDetail(route.id); break;
    case "judgement":
    case "reports":
    case "learning":
    case "system":
      html = renderPlaceholder(route.name);
      break;
    default:
      html = renderPlaceholder("reports");
  }
  app.innerHTML = html;
  syncCooldown();
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function openModal({ title, body, foot = "" }) {
  modalTitle.textContent = title;
  modalBody.innerHTML = body;
  modalFoot.innerHTML = foot || `<button class="btn" data-action="close-modal">关闭</button>`;
  if (!modal.open) modal.showModal();
}

function closeModal() {
  if (modal.open) modal.close();
}

function startCooldown(seconds = 60) {
  cooldownUntil = Date.now() + seconds * 1000;
  syncCooldown();
}

function syncCooldown() {
  const btn = document.getElementById("code-btn");
  if (!btn) return;
  const remain = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  if (remain > 0) {
    btn.disabled = true;
    btn.textContent = `${remain}s 后重发`;
    if (!cooldownTimer) cooldownTimer = setInterval(syncCooldown, 1000);
  } else {
    btn.disabled = false;
    btn.textContent = "获取验证码";
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/* ---------- 事件 ---------- */

document.addEventListener("click", (event) => {
  const actionEl = event.target.closest("[data-action]");
  if (actionEl) {
    event.preventDefault();
    handleAction(actionEl);
    return;
  }
  const planFilter = event.target.closest("[data-plan-filter]");
  if (planFilter) {
    state.planFilter[planFilter.dataset.planFilter] = planFilter.dataset.value;
    render();
    return;
  }
  const accountFilter = event.target.closest("[data-account-filter]");
  if (accountFilter) {
    state.accountFilter[accountFilter.dataset.accountFilter] = accountFilter.dataset.value;
    render();
    return;
  }
  const userFilter = event.target.closest("[data-user-filter]");
  if (userFilter) {
    state.userFilter[userFilter.dataset.userFilter] = userFilter.dataset.value;
    render();
    return;
  }
  const mdFilter = event.target.closest("[data-md-filter]");
  if (mdFilter) {
    state.mdBrowse[mdFilter.dataset.mdFilter] = mdFilter.dataset.value;
    state.mdBrowse.page = 1;
    render();
    return;
  }
  const planTab = event.target.closest("[data-plan-tab]");
  if (planTab) {
    state.planTab = planTab.dataset.planTab;
    render();
    return;
  }
  const authTab = event.target.closest("[data-auth-tab]");
  if (authTab) {
    state.loginMode = authTab.dataset.authTab;
    state.authError = null;
    render();
    return;
  }
  const hrefEl = event.target.closest("[data-href]");
  if (hrefEl) {
    go(hrefEl.dataset.href);
  }
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.matches("[data-demo-role]")) {
    state.role = el.value;
    if (state.role === "store_staff") go("#/store");
    else if (location.hash === "#/store" || location.hash === "#/login") go("#/plans");
    else render();
    return;
  }
  if (el.matches("[data-demo-state]")) {
    state.demoState = el.value;
    render();
    return;
  }
  if (el.matches("[data-audit-filter]")) {
    state.auditFilter[el.dataset.auditFilter] = el.value;
    render();
    return;
  }
  if (el.matches("[data-md-size]")) {
    state.mdBrowse.size = Number(el.value) || 20;
    state.mdBrowse.page = 1;
    render();
    return;
  }
  if (el.matches("[data-md-branch]")) {
    state.mdBrowse.branch = el.value;
    state.mdBrowse.page = 1;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.matches("[data-md-kw]")) return;
  event.preventDefault();
  state.mdBrowse.kw = event.target.value.trim();
  state.mdBrowse.page = 1;
  render();
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  handleForm(form.dataset.form, form);
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

/* ---------- 动作 ---------- */

function handleAction(el) {
  const action = el.dataset.action;
  const id = el.dataset.id;
  switch (action) {
    case "toggle-demo":
      state.demoOpen = !state.demoOpen;
      render();
      break;
    case "toggle-filters":
      state.filtersOpen = !state.filtersOpen;
      render();
      break;
    case "notify":
      toast("通知：3 条待处理（原型）");
      break;
    case "account-menu":
      openModal({
        title: "账号菜单",
        body: `
          <div class="list-row"><div style="flex:1"><div class="cell-main">修改密码</div><div class="cell-sub">其他会话将失效，当前会话保留。</div></div><button class="btn btn-sm" data-action="go-change-password">打开</button></div>
          <div class="list-row"><div style="flex:1"><div class="cell-main">退出登录</div><div class="cell-sub">只结束当前会话。</div></div><button class="btn btn-sm" data-action="logout">退出</button></div>
        `,
        foot: `<button class="btn" data-action="close-modal">关闭</button>`,
      });
      break;
    case "logout":
      closeModal();
      go("#/login");
      break;
    case "go-change-password":
      closeModal();
      go("#/change-password");
      break;
    case "retry":
      render();
      toast("已重新加载（原型）");
      break;
    case "clear-plan-filter":
      state.planFilter = { brand: "all", platform: "all", status: "all" };
      render();
      break;
    case "edit-plan":
      toast("原型：编辑名称 / 说明 / 起止日期；品牌、平台、板块没有更新路径");
      break;
    case "plan-status": {
      const plan = getPlan(id);
      const next = el.dataset.status;
      const verb = next === "collecting" ? "恢复" : next === "archived" ? "归档" : "暂停";
      openModal({
        title: `${verb}计划`,
        body: `
          <p class="hint">计划：<strong>${esc(plan?.name ?? id)}</strong></p>
          <div class="callout ${next === "collecting" ? "" : "warn"}" style="margin-top:12px">${icon(next === "collecting" ? "play" : "pause")}<span>${next === "collecting" ? "恢复后名单、参与关系与负责人解冻；因无引用关闭的账号按引用规则重开。" : "暂停 / 归档后名单、参与关系与负责人冻结；计划不再计入引用，账号保留 15 天宽限后才关闭。"}</span></div>
        `,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-plan-status" data-id="${id}" data-status="${next}">${verb}</button>`,
      });
      break;
    }
    case "confirm-plan-status": {
      const plan = getPlan(el.dataset.id);
      if (plan) plan.status = el.dataset.status;
      closeModal();
      render();
      toast(`计划已${el.dataset.status === "collecting" ? "恢复" : el.dataset.status === "archived" ? "归档" : "暂停"}（原型）`);
      break;
    }
    case "delete-plan": {
      const plan = getPlan(id);
      openModal({
        title: "删除活动计划",
        body: `
          <p class="hint">计划：<strong>${esc(plan?.name ?? id)}</strong></p>
          <div class="callout danger" style="margin-top:12px">${icon("alert")}<span>下面有 <strong>1 个</strong>监控判定计划、共 <strong>1,284 条</strong>结果；名单内账号 <strong>842 个</strong>。删除后立即按引用计数检查监控；计划进入回收站 30 天，期满物理清除计划层对象。</span></div>
          <p class="hint" style="margin-top:12px">删除不删账号、不删底层采集数据，也不删导入批次与行结果。</p>
        `,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="confirm-delete-plan" data-id="${id}">删除计划</button>`,
      });
      break;
    }
    case "confirm-delete-plan":
      closeModal();
      go("#/plans");
      toast("计划已进入回收站（原型）");
      break;
    case "assign-owner": {
      const plan = getPlan(id);
      openModal({
        title: "指派 / 替换负责人",
        body: `
          <p class="hint">计划：<strong>${esc(plan?.name ?? id)}</strong> · 北京分公司</p>
          <div class="form-grid" style="margin-top:12px">
            <div class="field"><label>槽位 1</label><select class="select"><option>刘学奎（当前）</option><option>王敏</option><option>李强</option></select></div>
            <div class="field"><label>槽位 2</label><select class="select"><option>王敏（当前）</option><option>赵倩</option><option>陈晨</option></select></div>
          </div>
          <div class="callout" style="margin-top:12px">${icon("users")}<span>负责人不是权限，只作责任标记；只有计划创建者与超管可以替换，分公司不能自己换。</span></div>
        `,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-owner" data-id="${id}">保存</button>`,
      });
      break;
    }
    case "confirm-owner":
      closeModal();
      toast("负责人已更新并记变更（原型）");
      break;
    case "branch-exit":
      openModal({
        title: "分公司退出计划",
        body: `<p class="hint">退出 <strong>${esc(el.dataset.branch)}</strong> 后：该分公司在本计划下全部「在名单」项置为「已移出活动计划」，释放负责人名额，并立即按引用计数检查账号监控；已采数据与判定结果保留。</p>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="confirm-branch-exit">退出</button>`,
      });
      break;
    case "confirm-branch-exit":
      closeModal();
      toast("分公司已退出；名单项已移出（原型）");
      break;
    case "branch-join":
      toast("分公司已重新加入；名单项仍为已移出，等待重新提交（原型）");
      break;
    case "remove-roster":
      openModal({
        title: "移出名单",
        body: `<p class="hint">移出后名单项置为「已移出活动计划」，永不物理删除；账号仅被本计划引用时立即关闭监控，仍被其他有效计划引用时保持开启。</p>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="confirm-remove-roster">移出</button>`,
      });
      break;
    case "confirm-remove-roster":
      closeModal();
      toast("名单项已移出（原型）");
      break;
    case "restore-plan":
      openModal({
        title: "恢复计划",
        body: `<p class="hint">恢复后回到删除前状态；因无引用关闭的账号会按引用规则重开，人工关闭与上级关闭的不动。</p>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-restore-plan">恢复</button>`,
      });
      break;
    case "confirm-restore-plan":
      closeModal();
      toast("计划已恢复（原型）");
      break;
    case "mock-upload":
      state.importUploaded = true;
      render();
      toast("已读取文件；预检只读，不写业务表（原型）");
      break;
    case "mock-reset-upload":
      state.importUploaded = false;
      render();
      break;
    case "download-template":
      toast("原型：下载 roster-import.v1 模板");
      break;
    case "download-return":
      toast("原型：下载回流文件（只含本次提交的失败 / 冲突行）");
      break;
    case "import-next":
      if (state.importStep < 5) state.importStep += 1;
      render();
      break;
    case "import-prev":
      if (state.importStep > 3) state.importStep -= 1;
      render();
      break;
    case "confirm-import":
      state.importStep = 5;
      render();
      toast("已确认写入；批次进入解析中（原型）");
      break;
    case "md-mode":
      state.mdMode = el.dataset.mode;
      render();
      break;
    case "md-view":
      state.mdBrowse.view = el.dataset.view;
      state.mdBrowse.page = 1;
      render();
      break;
    case "md-search": {
      const input = document.querySelector("[data-md-kw]");
      state.mdBrowse.kw = (input?.value ?? "").trim();
      state.mdBrowse.page = 1;
      render();
      break;
    }
    case "md-clear":
      state.mdBrowse = { ...state.mdBrowse, brand: "all", branch: "all", sector: "all", tier: "all", status: "all", kw: "", page: 1 };
      render();
      break;
    case "md-page":
      state.mdBrowse.page = Math.max(1, Number(el.dataset.page) || 1);
      render();
      break;
    case "md-open-branch":
      state.mdBrowse.view = "stores";
      state.mdBrowse.branch = el.dataset.id;
      state.mdBrowse.page = 1;
      render();
      break;
    case "md-next":
      if (state.mdStep < 4) state.mdStep += 1;
      render();
      break;
    case "md-prev":
      if (state.mdStep > 1) state.mdStep -= 1;
      render();
      break;
    case "md-upload":
      state.mdUploaded = true;
      state.mdStep = 3;
      render();
      toast("已读取文件并完成预检；预检只读，没有写入任何数据（原型）");
      break;
    case "md-reset":
      state.mdUploaded = false;
      state.mdClose = [];
      state.mdStep = 2;
      render();
      break;
    case "md-help":
      openModal({ title: "怎么从 Excel 导出", body: `<ol class="hint" style="padding-left:18px;line-height:1.9"><li>打开权威信息 xlsx 的「门店信息数据」页签。</li><li>如果有「负责人」列，先整列删除。</li><li>文件 → 另存为 → CSV（UTF-8 或 GB18030 都可以）。</li><li>不要在 Excel 里重新排列列；门店编码列先设为文本格式。</li></ol>` });
      break;
    case "md-toggle-close": {
      const i = state.mdClose.indexOf(id);
      if (i >= 0) state.mdClose.splice(i, 1);
      else state.mdClose.push(id);
      render();
      break;
    }
    case "md-close-all":
      state.mdClose = state.mdClose.length === 6 ? [] : ["s1", "s2", "s3", "s4", "s5", "s6"];
      render();
      break;
    case "md-download":
      toast("原型：下载回流文件（错误行 + 原因，带 BOM 的 UTF-8）");
      break;
    case "md-confirm":
      state.mdStep = 1;
      state.mdUploaded = false;
      state.mdClose = [];
      go("#/master/batches/M1");
      toast("已确认写入；批次详情显示分块进度（原型）");
      break;
    case "refresh-batch":
      toast("已刷新批次进度（原型）");
      break;
    case "batch-monitor": {
      openModal({
        title: "批量监控开关",
        body: `
          <div class="field"><label>层级</label><select class="select"><option>分公司</option><option>经销商（仅超管）</option><option>门店</option><option>专员</option><option>账号</option></select></div>
          <div class="callout" style="margin-top:12px">${icon("alert")}<span>预览：将影响 <strong>168</strong> 个账号。上级关闭优先；下级打开不能覆盖上级关闭。写操作前先预览，显式确认才写入。</span></div>
        `,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-monitor">确认</button>`,
      });
      break;
    }
    case "confirm-monitor":
      closeModal();
      toast("监控开关已写入（原型）");
      break;
    case "select-account": {
      const account = getAccount(id);
      if (!account) break;
      if (window.innerWidth >= 1280) {
        state.selectedAccountId = id;
        render();
      } else {
        openModal({
          title: "账号详情",
          body: accountModalHtml(account),
          foot: `<button class="btn" data-action="close-modal">关闭</button>`,
        });
      }
      break;
    }
    case "account-detail": {
      const account = getAccount(id);
      if (account) {
        openModal({
          title: "账号详情",
          body: accountModalHtml(account),
          foot: `<button class="btn" data-action="close-modal">关闭</button>`,
        });
      }
      break;
    }
    case "toggle-switch":
      toast("原型：开关变更需要预览与确认；当前未写入");
      break;
    case "confirm-empty":
      openModal({
        title: "确认疑似空账号",
        body: `<p class="hint">确认后录入状态由「疑似空账号」改为「正常录入」，下一次监控目标解析会包含它。需要「账号管理」权限，且账号所属分公司在你的范围内；此操作记审计。</p>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-empty-yes">确认</button>`,
      });
      break;
    case "confirm-empty-yes":
      closeModal();
      toast("疑似空账号已确认；下一次监控目标解析包含它（原型）");
      break;
    case "manual-sync":
      toast("已提交手工补抓（原型）");
      break;
    case "remove-account":
      openModal({
        title: "移出名单",
        body: `<p class="hint">只影响本计划名单；账号仍被其他计划引用时保持开启。名单项永不物理删除。</p>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="confirm-remove-account">移出</button>`,
      });
      break;
    case "confirm-remove-account":
      closeModal();
      toast("名单项已移出（原型）");
      break;
    case "disable-user":
      openModal({
        title: "停用用户",
        body: `<div class="callout danger">${icon("lock")}<span>停用后：现有会话全部失效；认证表登录手机号改写为墓碑值；取消该用户触发的未完成异步任务；记审计。原号保留在授权表，不占号。</span></div><p class="hint" style="margin-top:12px">高风险操作与审计同一事务；审计写入失败会整体回滚。</p>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="confirm-disable-user">停用用户</button>`,
      });
      break;
    case "confirm-disable-user":
      closeModal();
      toast("用户已停用；会话已失效（原型）");
      break;
    case "restore-user":
      openModal({
        title: "恢复用户",
        body: `<div class="callout">${icon("check")}<span>恢复前重新检查角色、品牌、分公司与关联业务身份；对象不存在或无法映射的项直接去掉并记审计。品牌 / 组织停用不算失效。恢复前复核手机号唯一。</span></div>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-restore-user">恢复用户</button>`,
      });
      break;
    case "confirm-restore-user":
      closeModal();
      toast("用户已恢复为有效（原型）");
      break;
    case "force-logout":
      openModal({
        title: "强制下线",
        body: `<p class="hint">撤销目标用户的全部会话，记审计；不改变用户角色与状态。</p>`,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-danger" data-action="confirm-force-logout">强制下线</button>`,
      });
      break;
    case "confirm-force-logout":
      closeModal();
      toast("目标用户全部会话已失效（原型）");
      break;
    case "user-import-upload":
      state.userImportStep = 2;
      render();
      toast("已读取文件；同步预检（原型）");
      break;
    case "user-import-next":
      state.userImportStep = 3;
      render();
      break;
    case "user-import-prev":
      state.userImportStep = 2;
      render();
      break;
    case "user-import-confirm":
      state.userImportStep = 4;
      render();
      toast("已确认写入 18 个待激活用户（原型）");
      break;
    case "send-code":
      if (cooldownUntil > Date.now()) {
        toast("请稍后再试");
        break;
      }
      startCooldown(60);
      state.authError = null;
      state.authNotice = "验证码已发送（原型）；5 分钟内有效";
      render();
      toast("验证码已发送（原型）");
      break;
    case "fill-demo": {
      const phone = document.getElementById("login-phone");
      const code = document.getElementById("login-code");
      const password = document.getElementById("login-password");
      if (phone) phone.value = DEMO_ACCOUNT.phoneDisplay;
      if (code) code.value = DEMO_ACCOUNT.code;
      if (password) password.value = DEMO_ACCOUNT.password;
      toast("已填入原型演示账号");
      break;
    }
    case "audit-filter":
      toast("原型：审计筛选条件（事件 / 时间）");
      break;
    case "close-modal":
      closeModal();
      break;
    default:
      toast("原型：该动作在实现时接入 Module / CLI");
  }
}

function handleForm(name, form) {
  switch (name) {
    case "login": {
      const data = new FormData(form);
      const phone = String(data.get("phone") ?? "").replace(/\D/g, "");
      const code = String(data.get("code") ?? "");
      const password = String(data.get("password") ?? "");
      const credentialOk = state.loginMode === "code"
        ? code === DEMO_ACCOUNT.code
        : password === DEMO_ACCOUNT.password;
      if (state.demoState === "processing") {
        toast("登录中…（原型状态）");
        return;
      }
      if (state.demoState === "error" || phone !== DEMO_ACCOUNT.phone || !credentialOk) {
        state.authError = "手机号或密码错误。连续 5 次失败将锁定 15 分钟。";
        state.authNotice = null;
        render();
        return;
      }
      state.authError = null;
      state.authNotice = null;
      go("#/plans");
      toast(`已登录：${DEMO_ACCOUNT.name}（平台超管，原型）`);
      break;
    }
    case "activate":
      go("#/plans");
      toast("账号已激活；状态转为有效（原型）");
      break;
    case "forgot":
      state.authNotice = "密码已重置；其他会话已失效，登录失败锁定已解除。";
      go("#/login");
      toast("密码已重置（原型）");
      break;
    case "change-password":
      go("#/plans");
      toast("密码已修改；其他会话已失效（原型）");
      break;
    case "create-plan":
      go("#/plans/p1");
      toast("计划已创建并发布（原型）");
      break;
    case "create-user":
      go("#/users");
      toast("用户已创建并邀请；没有发出短信（原型）");
      break;
    case "save-user":
      toast("已保存；角色 / 范围变更不撤销现有会话（原型）");
      break;
    default:
      toast("原型：表单已提交");
  }
}

window.addEventListener("hashchange", render);
render();