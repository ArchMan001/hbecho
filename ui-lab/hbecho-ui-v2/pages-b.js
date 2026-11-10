// B 访问控制页面：登录 / 激活 / 忘记密码 / 改密 / 用户管理 / 用户导入 / 审计 / 占位页 / 门店端。
// 只渲染；动作由 app.js 统一接管。

import { state } from "./store.js";
import { ROLES, USERS, AUDIT, USER_STATUS, PLACEHOLDERS, getPlan, getUser, num, AUDIT_REASON_LABEL, USER_IMPORT_REASON_LABEL } from "./data.js";
import {
  icon, esc, badge, renderShell, stateAware, emptyState, deniedState, errorState,
  expiredState, processingBanner, dataCell, avatarFor, userStatusBadge, roleBadge,
  planStatusBadge, filterToggle,
} from "./ui.js";

const currentUser = () => ({ platform_admin: "刘学奎", hq_manager: "王敏", branch_manager: "李强", store_staff: "张三" }[state.role]);

// 稳定码保留在次行，主行显示人话（ui-foundation §6.6）。
function userReasonCell(code) {
  return `<div class="reason-text">${esc(USER_IMPORT_REASON_LABEL[code] ?? code)}</div><div class="reason-code">${esc(code)}</div>`;
}

/* ---------- 认证页面 ---------- */

const AUTH_META = {
  login: {
    eyebrow: "登录",
    title: "欢迎回来",
    sub: "使用公司登记的手机号",
    h1: ["一个入口，", "管好账号、内容", "与活动计划。"],
    lead: "账号采集、活动计划、名单与监控在同一条链路上。账号由管理员开通；绑定哪些品牌，就只能看到哪些品牌的数据。",
    facts: [["4", "类", "角色"], ["15", "天", "滑动会话"], ["2", "种", "登录方式"]],
  },
  activate: {
    eyebrow: "激活",
    title: "激活账号",
    sub: "待激活用户设置密码后即可登录",
    h1: ["先激活，", "再进入", "你的工作台。"],
    lead: "激活使用短信验证码，与找回密码共用同一条安全路径。待激活不设有效期；账号由管理员开通。",
    facts: [["邀请", "", "开通方式"], ["5", "分钟", "验证码有效"], ["8", "位", "密码下限"]],
  },
  forgot: {
    eyebrow: "找回密码",
    title: "重置密码",
    sub: "验证手机号后设置新密码",
    h1: ["找回密码，", "继续", "未完成的工作。"],
    lead: "重置成功后解除登录失败锁定，并让该用户的其他会话全部失效。连续 5 次密码失败会锁定 15 分钟。",
    facts: [["5", "分钟", "验证码有效"], ["60", "秒", "重发间隔"], ["1", "次", "重置即解锁"]],
  },
  "change-password": {
    eyebrow: "账户",
    title: "修改密码",
    sub: "改密后其他会话立即失效",
    h1: ["换一个密码，", "其他会话", "立即失效。"],
    lead: "密码由用户自己设置，管理员不能查看或代设。最短 8 位；不强制字符组合、不强制定期改密。",
    facts: [["8", "位", "密码下限"], ["其他", "", "会话失效"], ["不强制", "", "定期改密"]],
  },
};

export function renderAuth(kind) {
  const meta = AUTH_META[kind] ?? AUTH_META.login;
  const card = authCard(kind, meta);
  return `
    <main class="auth">
      <div class="auth-grid">
        <section class="auth-hero">
          <div class="auth-logo">
            <div class="auth-logo-mark">H</div>
            <div>
              <div class="auth-logo-name">hbecho 新媒体运营平台</div>
              <div class="auth-logo-sub">HISENSE · HITACHI · YORK</div>
            </div>
          </div>
          <h1 class="auth-h1">${meta.h1[0]}<br /><span>${meta.h1[1]}</span><br />${meta.h1[2]}</h1>
          <p class="auth-lead">${esc(meta.lead)}</p>
          <ul class="auth-facts">
            ${meta.facts.map(([v, unit, k]) => `<li class="auth-fact"><strong>${esc(v)}</strong><span>${esc(unit)}</span><p>${esc(k)}</p></li>`).join("")}
          </ul>
        </section>
        <section>
          ${card}
        </section>
      </div>
      <p class="auth-footer-note">hbecho 界面原型 · 非生产 · ${kind === "login" ? '<a href="#/plans" style="color:rgba(255,255,255,.8)">原型：直接进入应用</a>' : '<a href="#/login" style="color:rgba(255,255,255,.8)">返回登录</a>'}</p>
    </main>
  `;
}

function authCard(kind, meta) {
  const demoError = state.demoState === "error" ? "手机号或密码错误。连续 5 次失败将锁定 15 分钟。" : "";
  const demoNotice = state.demoState === "expired" ? "验证码已过期，请重新获取。" : "";
  const errorText = state.authError || demoError;
  const noticeText = state.authNotice || demoNotice;
  const error = errorText ? `<div class="auth-error" role="alert">${icon("alert")}<span>${esc(errorText)}</span></div>` : "";
  const notice = noticeText ? `<div class="auth-notice" role="status">${icon("check")}<span>${esc(noticeText)}</span></div>` : "";
  if (kind === "login") {
    return `
      <div class="auth-card">
        <div class="auth-eyebrow">${esc(meta.eyebrow)}</div>
        <h2 class="auth-title">${esc(meta.title)}</h2>
        <p class="auth-sub">${esc(meta.sub)}</p>
        <div class="auth-tabs" role="tablist" aria-label="登录方式">
          <button class="auth-tab ${state.loginMode === "code" ? "active" : ""}" data-auth-tab="code" role="tab" aria-selected="${state.loginMode === "code"}">验证码</button>
          <button class="auth-tab ${state.loginMode === "password" ? "active" : ""}" data-auth-tab="password" role="tab" aria-selected="${state.loginMode === "password"}">密码</button>
        </div>
        <form class="auth-form" data-form="login">
          ${error}${notice}
          <div class="field">
            <label for="login-phone">手机号</label>
            <div class="phone-field"><span class="phone-prefix">+86</span><input id="login-phone" name="phone" inputmode="numeric" autocomplete="tel" placeholder="138 0000 0000" value="138 0000 2041" /></div>
          </div>
          ${state.loginMode === "code" ? `
            <div class="field">
              <label for="login-code">短信验证码</label>
              <div class="code-row">
                <input class="input" id="login-code" name="code" inputmode="numeric" maxlength="6" placeholder="6 位数字" />
                <button type="button" class="btn" id="code-btn" data-action="send-code">获取验证码</button>
              </div>
              <span class="hint">验证码 5 分钟内有效</span>
            </div>
          ` : `
            <div class="field">
              <label for="login-password">密码</label>
              <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
            </div>
          `}
          <button class="btn btn-primary" type="submit" style="margin-top:2px">${state.demoState === "processing" ? "登录中…" : `登录 ${icon("arrowRight")}`}</button>
        </form>
        <div class="auth-link-row"><a href="#/activate">首次登录 / 激活账号</a><a href="#/forgot">忘记密码</a></div>
        <p class="auth-foot">${icon("shield")}<span>账号由管理员开通；没有注册入口，也没有微信登录。登录后按角色与品牌范围展示数据。</span></p>
      </div>
    `;
  }
  if (kind === "activate") {
    return `
      <div class="auth-card">
        <div class="auth-eyebrow">${esc(meta.eyebrow)}</div>
        <h2 class="auth-title">${esc(meta.title)}</h2>
        <p class="auth-sub">${esc(meta.sub)}</p>
        <form class="auth-form" data-form="activate">
          ${error}${notice}
          <div class="field"><label for="activate-phone">手机号</label><div class="phone-field"><span class="phone-prefix">+86</span><input id="activate-phone" name="phone" inputmode="numeric" placeholder="138 0000 0000" /></div></div>
          <div class="field"><label for="activate-code">短信验证码</label><div class="code-row"><input class="input" id="activate-code" name="code" inputmode="numeric" maxlength="6" placeholder="6 位数字" /><button type="button" class="btn" id="code-btn" data-action="send-code">获取验证码</button></div><span class="hint">验证码 5 分钟内有效；连续输错 5 次作废。</span></div>
          <div class="field"><label for="activate-password">设置密码</label><input class="input" id="activate-password" name="password" type="password" placeholder="至少 8 位" /><span class="hint">用户自己设置；管理员不能查看或代设。</span></div>
          <button class="btn btn-primary" type="submit">设置密码并激活</button>
        </form>
        <p class="auth-foot">待激活用户不设有效期；激活后状态转为「有效」。首次登录前，密码登录的提示与「手机号或密码错误」一致，不暴露账号是否存在。</p>
      </div>
    `;
  }
  if (kind === "forgot") {
    return `
      <div class="auth-card">
        <div class="auth-eyebrow">${esc(meta.eyebrow)}</div>
        <h2 class="auth-title">${esc(meta.title)}</h2>
        <p class="auth-sub">${esc(meta.sub)}</p>
        <form class="auth-form" data-form="forgot">
          ${error}${notice}
          <div class="field"><label for="forgot-phone">手机号</label><div class="phone-field"><span class="phone-prefix">+86</span><input id="forgot-phone" name="phone" inputmode="numeric" placeholder="138 0000 0000" /></div></div>
          <div class="field"><label for="forgot-code">短信验证码</label><div class="code-row"><input class="input" id="forgot-code" name="code" inputmode="numeric" maxlength="6" placeholder="6 位数字" /><button type="button" class="btn" id="code-btn" data-action="send-code">获取验证码</button></div></div>
          <div class="field"><label for="forgot-password">新密码</label><input class="input" id="forgot-password" name="password" type="password" placeholder="至少 8 位" /></div>
          <button class="btn btn-primary" type="submit">重置密码</button>
        </form>
        <p class="auth-foot">重置成功后解除登录失败锁定，并让该用户的其他会话全部失效。管理员不能替用户设置密码。</p>
      </div>
    `;
  }
  return `
    <div class="auth-card">
      <div class="auth-eyebrow">${esc(meta.eyebrow)}</div>
      <h2 class="auth-title">${esc(meta.title)}</h2>
      <p class="auth-sub">${esc(meta.sub)}</p>
      <form class="auth-form" data-form="change-password">
        ${error}${notice}
        <div class="field"><label for="change-old">旧密码</label><input class="input" id="change-old" type="password" placeholder="当前密码" /></div>
        <div class="field"><label for="change-new">新密码</label><input class="input" id="change-new" type="password" placeholder="至少 8 位" /><span class="hint">修改成功后，该用户的其他会话全部失效；当前会话保留。</span></div>
        <button class="btn btn-primary" type="submit">保存新密码</button>
      </form>
      <div class="auth-link-row"><a href="#/plans">返回工作台</a><a href="#/login">退出登录</a></div>
    </div>
  `;
}

/* ---------- 用户管理 ---------- */

function visibleUsers() {
  if (state.role === "platform_admin") return USERS;
  if (state.role === "hq_manager") return USERS.filter((u) => ["branch_manager", "store_staff"].includes(u.role) || u.id === "u2");
  if (state.role === "branch_manager") return USERS.filter((u) => (u.role === "store_staff" && u.branches === "北京分公司") || u.id === "u3");
  return [];
}

function canSeeUser(u) {
  return visibleUsers().some((x) => x.id === u.id);
}

function userFilterChips(group, values, current) {
  return values.map(([v, l]) => `<button class="chip ${current === v ? "active" : ""}" data-user-filter="${group}" data-value="${v}">${esc(l)}</button>`).join("");
}

export function renderUsers() {
  if (state.role === "store_staff") {
    return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限"], content: deniedState("门店专员没有管理端「用户与权限」入口。") });
  }
  const rows = visibleUsers().filter((u) =>
    (state.userFilter.role === "all" || u.role === state.userFilter.role) &&
    (state.userFilter.status === "all" || u.status === state.userFilter.status)
  );
  const allVisible = visibleUsers();
  const activeCount = allVisible.filter((u) => u.status === "active").length;
  const pendingCount = allVisible.filter((u) => u.status === "pending_activation").length;
  const disabledCount = allVisible.filter((u) => u.status === "disabled").length;
  const content = `
    <div class="page-head">
      <div><h1 class="page-title">用户与权限</h1><p class="page-sub">只能授予严格低于自己的角色；用户列表只显示严格下级与自己，同级互不可见、不可操作。</p></div>
      <div class="page-actions"><a class="btn" href="#/users/import">${icon("upload")} 批量导入</a><a class="btn btn-primary" href="#/users/new">${icon("plus")} 新建用户</a></div>
    </div>
    <section class="summary-band" aria-label="用户概览">
      <div>
        <div class="summary-title">${allVisible.length} 个可见用户 · ${activeCount} 个有效</div>
        <div class="summary-sub">当前角色：${esc(ROLES[state.role]?.label ?? "")} · ${esc(ROLES[state.role]?.scope ?? "")}</div>
      </div>
      <div class="summary-metrics">
        <div class="summary-metric"><span>${activeCount}</span><small>有效</small></div>
        <div class="summary-metric"><span>${pendingCount}</span><small>待激活</small></div>
        <div class="summary-metric"><span>${disabledCount}</span><small>停用</small></div>
      </div>
    </section>
    ${filterToggle([state.userFilter.role, state.userFilter.status].filter((v) => v !== "all").length)}
    <section class="filter-card ${state.filtersOpen ? "open" : ""}">
      <div class="filter-line"><span class="filter-label">角色</span>${userFilterChips("role", [["all", "全部角色"], ["hq_manager", "总部人员"], ["branch_manager", "分公司人员"], ["store_staff", "门店专员"]], state.userFilter.role)}</div>
      <div class="filter-line"><span class="filter-label">状态</span>${userFilterChips("status", [["all", "全部状态"], ["pending_activation", "待激活"], ["active", "有效"], ["disabled", "停用"]], state.userFilter.status)}</div>
    </section>
    <div class="result-bar"><span>共 <strong>${rows.length}</strong> 个用户</span><span class="hint">当前角色：${esc(ROLES[state.role]?.label ?? "")} · ${esc(ROLES[state.role]?.scope ?? "")}</span></div>
    ${stateAware(rows.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>用户</th><th>品牌 / 分公司</th><th>状态</th><th class="right">待激活</th><th>最后登录</th><th class="right">操作</th></tr></thead>
          <tbody>
            ${rows.map((u) => `
              <tr class="clickable" data-href="#/users/${u.id}">
                <td><div style="display:flex;align-items:center;gap:9px">${avatarFor(u.name)}<div><div style="display:flex;align-items:center;gap:7px"><span class="cell-main">${esc(u.name)}</span>${roleBadge(u.role)}</div><div class="cell-sub">${esc(u.phone)}</div></div></div></td>
                <td class="nowrap"><div style="display:flex;gap:5px;flex-wrap:wrap">${u.brands.map((b) => `<span class="tag">${esc(b)}</span>`).join(" ") || "—"}</div><div class="cell-sub">${esc(u.branches)}${u.store ? ` · ${esc(u.store)}` : ""}</div></td>
                <td class="nowrap">${userStatusBadge(u.status)}${u.disabledReason === "manual" ? '<div class="cell-sub">人工停用</div>' : ""}</td>
                <td class="right num">${u.status === "pending_activation" ? `${u.pendingDays} 天` : "—"}</td>
                <td class="num nowrap">${esc(u.lastLogin)}</td>
                <td class="right nowrap">
                  <a class="btn btn-sm" href="#/users/${u.id}">查看</a>
                  ${u.status === "disabled" ? `<button class="btn btn-sm" data-action="restore-user" data-id="${u.id}">恢复</button>` : `<button class="btn btn-sm" data-action="disable-user" data-id="${u.id}">停用</button>`}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : emptyState({ title: "没有符合条件的用户", text: "切换角色或状态筛选；同级用户不会出现在列表里。" }))}
  `;
  return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限"], content });
}

function roleOptionsForCurrent() {
  if (state.role === "platform_admin") return ["platform_admin", "hq_manager", "branch_manager", "store_staff"];
  if (state.role === "hq_manager") return ["branch_manager", "store_staff"];
  if (state.role === "branch_manager") return ["store_staff"];
  return [];
}

export function renderUserNew() {
  if (state.role === "store_staff") {
    return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限", "新建用户"], content: deniedState("门店专员没有「用户管理」权限。") });
  }
  const roles = roleOptionsForCurrent();
  const content = `
    <a class="back-link" href="#/users">${icon("arrowLeft")} 返回用户列表</a>
    <div class="page-head"><div><h1 class="page-title">新建用户</h1><p class="page-sub">邀请制：创建后用户自己用短信验证码激活并设置密码；创建时不发短信。</p></div></div>
    <div class="wizard-layout">
      <form class="card card-pad wizard-main" data-form="create-user">
      <div class="form-grid">
        <div class="field"><label for="nu-name">姓名 *</label><input class="input" id="nu-name" maxlength="100" placeholder="例如：张三" required /></div>
        <div class="field"><label for="nu-role">角色 *</label><select class="select" id="nu-role" required><option value="">请选择角色</option>${roles.map((r) => `<option value="${r}">${esc(ROLES[r].label)}</option>`).join("")}</select><span class="hint">只能授予严格低于自己的角色；超管可授予超管。</span></div>
        <div class="field"><label for="nu-phone">手机号 *</label><input class="input" id="nu-phone" inputmode="numeric" placeholder="11 位大陆手机号" required /><span class="hint">登录手机号；停用记录保留原号但不占号。</span></div>
        <div class="field"><label>品牌 *</label><div style="display:flex;gap:8px;flex-wrap:wrap"><label class="chip"><input type="checkbox" checked value="日立" style="accent-color:#0FA3A8" /> 日立</label><label class="chip"><input type="checkbox" value="海信" style="accent-color:#0FA3A8" /> 海信</label><label class="chip"><input type="checkbox" value="约克VRF" style="accent-color:#0FA3A8" /> 约克VRF</label></div></div>
        <div class="field"><label>分公司</label><select class="select"><option>北京分公司</option><option>上海分公司</option><option>广州分公司</option></select><span class="hint">总部与超管的分公司为「全部」；门店专员不单独存分公司。</span></div>
        <div class="field"><label for="nu-store">门店编码（仅门店专员）</label><input class="input" id="nu-store" placeholder="例如：BJ-HIT-001" /><span class="hint">用「手机号 + 门店编码」定位唯一有效专员；不存在或不在该门店则创建失败。</span></div>
        <div class="field span-2"><div class="callout">${icon("shield")}<span>创建前会做授权边界双校验：当前用户能否管理目标；拟授予的角色、品牌与分公司是否完全在自己的边界内。任一不过，整个创建拒绝。</span></div></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px"><a class="btn" href="#/users">取消</a><button class="btn btn-primary" type="submit">${icon("check")} 创建并邀请</button></div>
      </form>
      <aside class="wizard-rail" aria-label="授权说明">
        <div class="rail-card">
          <div class="rail-kicker">授权边界</div>
          <div class="rail-title">不能授出超过自己</div>
          <div class="rail-text">只能授予严格低于自己的角色；只有超管可授予超管。品牌与分公司必须完全位于自己的边界内；current + proposed 双校验，任一不过整个创建拒绝。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">邀请</div>
          <div class="rail-title">创建时不发短信</div>
          <div class="rail-text">新用户为「待激活」；用户自己到激活入口请求验证码、设置密码。待激活不设有效期。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">身份绑定</div>
          <div class="rail-title">门店专员绑定专员主档</div>
          <div class="rail-text">用「手机号 + 门店编码」定位唯一有效专员；不存在、不在该门店或已停用则创建失败。</div>
        </div>
      </aside>
    </div>
  `;
  return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限", "新建用户"], content });
}

export function renderUserDetail(id) {
  const u = getUser(id);
  if (!u || !canSeeUser(u)) {
    return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限"], content: deniedState("用户不存在，或不在你的管理范围内。同级与上级用户对外表现为「未找到」。") });
  }
  const editable = state.role !== "store_staff" && !(u.id === "u1" || (state.role === "hq_manager" && u.id === "u2") || (state.role === "branch_manager" && u.id === "u3")) && !(u.role === "platform_admin" && state.role !== "platform_admin");
  const roleOptions = [...new Set([u.role, ...roleOptionsForCurrent()])];
  const content = `
    <a class="back-link" href="#/users">${icon("arrowLeft")} 返回用户列表</a>
    <div class="page-head">
      <div><div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap"><h1 class="page-title">${esc(u.name)}</h1>${roleBadge(u.role)}${userStatusBadge(u.status)}</div><p class="page-sub">${esc(u.phone)} · 创建者 ${esc(u.createdBy)} · 最后登录 ${esc(u.lastLogin)}</p></div>
      <div class="page-actions">
        ${editable ? `<button class="btn" data-action="force-logout" data-id="${u.id}">${icon("logout")} 强制下线</button>` : ""}
        ${editable && u.status === "disabled" ? `<button class="btn" data-action="restore-user" data-id="${u.id}">${icon("play")} 恢复用户</button>` : ""}
        ${editable && u.status !== "disabled" ? `<button class="btn btn-danger" data-action="disable-user" data-id="${u.id}">${icon("lock")} 停用</button>` : ""}
      </div>
    </div>
    ${!editable ? `<div class="callout" style="margin-bottom:14px">${icon("shield")}<span>自己可见、只读；同级与上级用户不可见、不可操作。超管不能停用自己。</span></div>` : ""}
    ${u.status === "disabled" ? `<div class="callout warn" style="margin-bottom:14px">${icon("lock")}<span>已停用（${u.disabledReason === "media_staff_disabled" ? "专员停用联动" : "人工停用"}）。现有会话已失效，认证表登录手机号为墓碑值；原号保留在授权表，不占号。</span></div>` : ""}
    ${u.status === "pending_activation" ? `<div class="callout warn" style="margin-bottom:14px">${icon("clock")}<span>待激活 ${u.pendingDays} 天。待激活不设有效期；管理员可以直接修改手机号，激活后改号只能删旧建新。</span></div>` : ""}
    <div class="wizard-layout">
      <form class="card card-pad wizard-main" data-form="save-user">
      <div class="form-grid">
        <div class="field"><label for="ud-name">姓名</label><input class="input" id="ud-name" value="${esc(u.name)}" ${editable ? "" : "disabled"} /></div>
        <div class="field"><label for="ud-role">角色</label><select class="select" id="ud-role" ${editable ? "" : "disabled"}>${roleOptions.map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${esc(ROLES[r].label)}</option>`).join("")}</select><span class="hint">角色变更不撤销现有会话；下一次请求按新权限判断。</span></div>
        <div class="field"><label for="ud-phone">手机号</label><input class="input" id="ud-phone" value="${esc(u.phone)}" ${u.status === "pending_activation" ? "" : "disabled"} /><span class="hint">${u.status === "pending_activation" ? "待激活期内可直接修改。" : "已激活用户不能直接改号；换号走删旧建新。"}</span></div>
        <div class="field"><label>品牌</label><div style="display:flex;gap:8px;flex-wrap:wrap">${["日立", "海信", "约克VRF"].map((b) => `<label class="chip"><input type="checkbox" ${u.brands.includes(b) ? "checked" : ""} ${editable ? "" : "disabled"} style="accent-color:#0FA3A8" /> ${esc(b)}</label>`).join("")}</div></div>
        <div class="field"><label>分公司</label><select class="select" ${editable ? "" : "disabled"}><option>${esc(u.branches)}</option><option>全部</option></select></div>
        <div class="field"><label>门店（门店专员）</label><input class="input" value="${esc(u.store ?? "—")}" disabled /><span class="hint">门店与品牌不能原地修改；换店走删旧建新。</span></div>
      </div>
      <div class="callout" style="margin-top:16px">${icon("shield")}<span>列表、详情、修改、停用、恢复、强制下线使用同一条范围判断（读写同源）；看不到的用户也不能改。</span></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px"><a class="btn" href="#/users">取消</a><button class="btn btn-primary" type="submit" ${editable ? "" : "disabled"}>保存</button></div>
      </form>
      <aside class="wizard-rail" aria-label="权限与会话">
        <div class="rail-card">
          <div class="rail-kicker">权限边界</div>
          <div class="rail-title">严格下级 / 读写同源</div>
          <div class="rail-text">列表、详情、修改、停用、恢复、强制下线使用同一条范围判断；看不到的用户也不能改。同级与上级用户对外表现为「未找到」。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">会话</div>
          <div class="rail-title">角色变更不撤销会话</div>
          <div class="rail-text">下一次请求按新权限判断；强制下线撤销全部会话；重置密码让其他会话全部失效。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">关联</div>
          <div class="rail-title">门店专员绑定专员主档</div>
          <div class="rail-text">专员停用后，关联用户自动停用；专员恢复时只恢复因该专员停用的用户，人工停用的不恢复。</div>
        </div>
      </aside>
    </div>
  `;
  return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限", u.name], content });
}

/* ---------- 用户导入 ---------- */

export function renderUserImport() {
  if (state.role === "store_staff") {
    return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限", "批量导入"], content: deniedState("门店专员没有「用户管理」权限。") });
  }
  const step = state.userImportStep;
  const body = step === 1 ? userImportUpload() : step === 2 ? userImportPrecheck() : step === 3 ? userImportConfirm() : userImportDone();
  const content = `
    <a class="back-link" href="#/users">${icon("arrowLeft")} 返回用户列表</a>
    <div class="page-head"><div><h1 class="page-title">批量导入用户</h1><p class="page-sub">固定 6 列；全部同步执行；预检结果不过期，确认时重新校验全部行。</p></div></div>
    <div class="wizard-layout">
      <div class="card wizard-main">
        <div class="steps">${[["1", "上传"], ["2", "预检"], ["3", "确认"], ["4", "完成"]].map(([n, l]) => `<div class="step ${Number(n) < step ? "done" : ""} ${Number(n) === step ? "active" : ""}"><span class="step-num">${n}</span>${l}</div>`).join("")}</div>
        <div class="card-pad">${stateAware(body)}</div>
      </div>
      <aside class="wizard-rail" aria-label="导入说明">
        <div class="rail-card">
          <div class="rail-kicker">模板</div>
          <div class="rail-title">user-import.v1</div>
          <div class="rail-text">固定 6 列：姓名、角色、手机号、品牌、分公司、门店编码。角色写中文名；品牌写名称；分公司写编码；门店编码仅门店专员填。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">限额</div>
          <div class="rail-list">
            <div class="rail-row"><span>数据行</span><strong>≤ 1,000</strong></div>
            <div class="rail-row"><span>文件大小</span><strong>≤ 10 MB</strong></div>
            <div class="rail-row"><span>执行</span><strong>全部同步</strong></div>
          </div>
          <div class="rail-text">单批上限 1,000 行；文件大小上限 10 MB。原型按此展示演示数据。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">越权处理</div>
          <div class="rail-title">越权行不拖垮整批</div>
          <div class="rail-text">越权行进入跳过清单；手机号已存在会标记为「手机号已存在」；不提供「一键改成新增」，不静默改角色或范围。</div>
        </div>
      </aside>
    </div>
  `;
  return renderShell({ activeNav: "users", breadcrumb: ["工作区", "用户与权限", "批量导入"], content });
}

function userImportUpload() {
  return `
    <div class="dropzone">
      <div class="state-icon">${icon("upload")}</div>
      <strong>上传用户 CSV</strong>
      <p class="hint">固定 6 列：姓名、角色、手机号、品牌、分公司、门店编码。角色写中文名；品牌写名称；分公司写编码；门店编码仅门店专员填。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px"><button class="btn btn-primary" data-action="user-import-upload">${icon("upload")} 选择文件</button><button class="btn" data-action="download-template">${icon("download")} 下载模板</button></div>
      <p class="hint">单批 ≤ 1,000 行；文件大小上限 10 MB。</p>
    </div>
  `;
}

function userImportPrecheck() {
  const rows = [
    ["1", "王小明", "门店专员", "138****1001", "日立", "北京分公司 / BJ-HIT-001", "new", "可写入"],
    ["2", "李华", "总部人员", "139****1002", "海信", "全部", "error", "role_not_grantable"],
    ["3", "赵强", "分公司人员", "137****1003", "约克VRF", "广州分公司", "error", "scope_exceeds_boundary"],
    ["4", "陈静", "门店专员", "136****1004", "日立", "北京分公司 / BJ-HIT-002", "new", "可写入"],
    ["5", "周涛", "门店专员", "135****1005", "海信", "上海分公司 / SH-HIS-003", "error", "store_not_in_scope"],
    ["6", "孙悦", "门店专员", "133****1006", "日立", "北京分公司 / BJ-HIT-003", "error", "phone_exists"],
    ["7", "何静", "分公司人员", "132****1007", "日立", "北京分公司", "new", "可写入"],
    ["8", "马超", "门店专员", "131****1008", "日立", "北京分公司 / BJ-HIT-004", "error", "staff_not_found"],
  ];
  return `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
      <div><div class="card-title">预检报告</div><div class="card-sub">用户导入_20261108.csv · 1.1 MB · 数据行 23</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-action="download-return">${icon("download")} 回流文件</button><button class="btn btn-sm btn-primary" data-action="user-import-next">确认写入 ${icon("arrowRight")}</button></div>
    </div>
    <div class="stat-grid" style="margin-bottom:14px">
      <div class="stat"><div class="stat-label">新增</div><div class="stat-value">18</div><div class="stat-hint">确认后创建</div></div>
      <div class="stat"><div class="stat-label">错误</div><div class="stat-value">2</div><div class="stat-hint">回流修改</div></div>
      <div class="stat"><div class="stat-label">跳过</div><div class="stat-value">3</div><div class="stat-hint">越权行，不让整批失败</div></div>
      <div class="stat"><div class="stat-label">总行数</div><div class="stat-value">23</div><div class="stat-hint">≤ 1,000</div></div>
    </div>
    <div class="callout" style="margin-bottom:14px">${icon("shield")}<span>越权行进「跳过」清单，不让整批失败；手机号已存在（待激活 / 有效）的行标记为「手机号已存在」，不静默改角色或范围。</span></div>
    <div class="table-wrap user-import-table">
      <table><thead><tr><th>行</th><th>用户</th><th>手机号</th><th>品牌</th><th>分公司 · 门店</th><th>结果</th><th>原因</th></tr></thead><tbody>
        ${rows.map(([r, n, role, phone, brand, scope, cls, reason]) => `<tr><td class="num">${r}</td><td>${dataCell(n, role)}</td><td class="num">${esc(phone)}</td><td><span class="tag">${esc(brand)}</span></td><td>${esc(scope)}</td><td>${cls === "new" ? badge("可写入", "green") : badge("错误 / 跳过", "red")}</td><td>${cls === "new" ? "—" : userReasonCell(reason)}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="callout" style="margin-top:14px">${icon("alert")}<span>回流文件由提交人本人下载，只含本次提交的行，手机号按权限显示；不占用「导出」权限。确认时会重新校验全部行；若有人先建了同号用户，该行标记为「手机号已存在」。</span></div>
  `;
}

function userImportConfirm() {
  return `
    <div class="callout warn" style="margin-bottom:14px">${icon("alert")}<span>确认后同步写入 18 个用户；每行走与单个邀请相同的创建逻辑，逐条记审计。任一高风险审计写入失败，整个事务回滚。</span></div>
    <div class="info-grid">
      <div><div class="info-label">将创建</div><div class="info-value num">18</div></div>
      <div><div class="info-label">跳过</div><div class="info-value num">3</div></div>
      <div><div class="info-label">错误回流</div><div class="info-value num">2</div></div>
      <div><div class="info-label">短信</div><div class="info-value">不发；用户自己到激活入口请求验证码</div></div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px"><button class="btn" data-action="user-import-prev">上一步</button><button class="btn btn-primary" data-action="user-import-confirm">${icon("check")} 确认写入</button></div>
  `;
}

function userImportDone() {
  return `
    <div class="state">
      <div class="state-icon">${icon("check")}</div>
      <div class="state-title">批次已完成</div>
      <p class="state-text">已创建 18 个待激活用户；3 行越权跳过，2 行回流。用户会自己到激活入口请求验证码。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><a class="btn" href="#/users">查看用户列表</a><button class="btn btn-primary" data-action="download-return">${icon("download")} 下载回流文件</button></div>
    </div>
  `;
}

/* ---------- 审计 ---------- */

const DEMO_NOW = new Date("2026-11-08T23:59:59");
const AUDIT_EVENTS = [["all", "全部事件"], ["login", "登录"], ["authz", "授权变更"], ["users", "用户管理"], ["export", "导出与敏感读取"], ["system", "系统任务"]];
const AUDIT_RANGES = [["all", "全部时间"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["1y", "近 1 年"]];

function withinRange(time, range) {
  if (range === "all") return true;
  const days = { "7d": 7, "30d": 30, "1y": 365 }[range] ?? 365;
  return (DEMO_NOW - new Date(time.replace(" ", "T"))) / 86400000 <= days;
}

export function renderAudit() {
  if (state.role !== "platform_admin") {
    return renderShell({ activeNav: "system", breadcrumb: ["工作区", "系统", "审计日志"], content: deniedState("审计日志仅平台超管可读；其他角色一律不可见。") });
  }
  const denied = AUDIT.filter((a) => a.outcome !== "succeeded").length;
  const actors = new Set(AUDIT.map((a) => a.actor)).size;
  const rows = AUDIT.filter((a) =>
    (state.auditFilter.event === "all" || a.event === state.auditFilter.event) &&
    withinRange(a.time, state.auditFilter.range)
  );
  const content = `
    <div class="page-head"><div><h1 class="page-title">审计日志</h1><p class="page-sub">持久、追加写、保留一年；仅平台超管可读。手机号按权限可见；密码、令牌与验证码永不记录。</p></div></div>
    <section class="summary-band" aria-label="审计概览">
      <div>
        <div class="summary-title">${AUDIT.length} 条事件 · ${actors} 个操作者</div>
        <div class="summary-sub">只读、追加写；到期按 365 天窗口清理。</div>
      </div>
      <div class="summary-metrics">
        <div class="summary-metric"><span>${AUDIT.length}</span><small>事件</small></div>
        <div class="summary-metric"><span>${denied}</span><small>失败 / 拒绝</small></div>
        <div class="summary-metric"><span>${actors}</span><small>操作者</small></div>
      </div>
    </section>
    <div class="filter-bar" aria-label="审计筛选">
      <label class="filter-select"><span>事件</span>
        <select data-audit-filter="event">
          ${AUDIT_EVENTS.map(([v, l]) => `<option value="${v}" ${state.auditFilter.event === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="filter-select"><span>时间</span>
        <select data-audit-filter="range">
          ${AUDIT_RANGES.map(([v, l]) => `<option value="${v}" ${state.auditFilter.range === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <span class="filter-note">按时间倒序；只显示你有权读取的事件。</span>
    </div>
    <div class="result-bar"><span>共 <strong>${rows.length}</strong> 条</span><span class="hint">手机号按权限可见；密码、令牌与验证码不记录。</span></div>
    <div class="table-wrap audit-table">
      <table>
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>原因</th><th>范围摘要</th></tr></thead>
        <tbody>
          ${rows.map((a) => `
            <tr>
              <td class="num nowrap">${esc(a.time)}</td>
              <td class="nowrap"><div class="cell-main">${esc(a.actor)}</div>${a.actorKind === "service" ? '<div class="cell-sub">系统任务</div>' : ""}</td>
              <td class="nowrap">${esc(a.action)}</td>
              <td>${esc(a.target)}</td>
              <td class="nowrap">${a.outcome === "succeeded" ? badge("成功", "green") : badge("失败", "red")}</td>
              <td><div class="reason-text">${esc(AUDIT_REASON_LABEL[a.reason] ?? a.reason)}</div><div class="reason-code">${esc(a.reason)}</div></td>
              <td>${esc(a.scope)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  return renderShell({ activeNav: "system", breadcrumb: ["工作区", "系统", "审计日志"], content });
}

/* ---------- 占位页 / 门店端 ---------- */

export function renderPlaceholder(key) {
  const p = PLACEHOLDERS[key] ?? PLACEHOLDERS.reports;
  const content = `
    <div class="page-head"><div><h1 class="page-title">${esc(p.title)}</h1><p class="page-sub">${esc(p.sub)}</p></div></div>
    <div class="card"><div class="state"><div class="state-icon">${icon("layers")}</div><div class="state-title">不在本次原型范围</div><p class="state-text">${esc(p.text)}</p><a class="btn" href="#/plans">回到活动计划</a></div></div>
  `;
  return renderShell({ activeNav: key, breadcrumb: ["工作区", p.title], content });
}

export function renderStoreHome() {
  const content = `
    <div class="page-head">
      <div><h1 class="page-title">我的考核</h1><p class="page-sub">门店端 · 只显示本人；没有管理类入口。</p></div>
      <div class="page-actions"><span class="tag">北京日立 001 店</span></div>
    </div>
    <div class="stat-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="stat"><div class="stat-label">我的账号</div><div class="stat-value">3</div><div class="stat-hint">正常采集 2 / 疑似空账号 1</div></div>
      <div class="stat"><div class="stat-label">本月已发布</div><div class="stat-value">8</div><div class="stat-hint">含短视频 5 / 图文 3</div></div>
      <div class="stat"><div class="stat-label">待处理</div><div class="stat-value">1</div><div class="stat-hint">疑似空账号待确认</div></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-head"><div><div class="card-title">2026 双十一家装专项</div><div class="card-sub">日立 · 抖音 · 采集中</div></div>${planStatusBadge("collecting")}</div>
      <div class="card-pad">
        <div class="list-row"><div style="flex:1"><div class="cell-main">日立北京·小日</div><div class="cell-sub">抖音 · 12.8 万粉丝 · 正常采集</div></div>${badge("正常采集", "green")}</div>
        <div class="list-row"><div style="flex:1"><div class="cell-main">北京日立暖通</div><div class="cell-sub">抖音 · 8.4 万粉丝 · 正常采集</div></div>${badge("正常采集", "green")}</div>
        <div class="list-row"><div style="flex:1"><div class="cell-main">上海日立小助手</div><div class="cell-sub">抖音 · 0 粉丝 0 作品 · 疑似空账号</div></div>${badge("疑似空账号", "amber")}</div>
      </div>
    </div>
    <div class="callout" style="margin-top:14px">${icon("book")}<span>门店端只有「我的考核」与「学习」两个入口；底部 Tab 切换。管理类页面不在此角色出现。</span></div>
  `;
  return renderShell({ activeNav: "store", breadcrumb: ["门店端", "我的考核"], content });
}