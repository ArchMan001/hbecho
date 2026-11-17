// 主数据导入（a-master-data-import，F5 路径 1）页面原型：导入向导 / 导入记录 / 批次详情。
// 2026-11-12 起草，供刘学奎评审（design §15）；未确认前不是实现依据。结构与组件沿用已确认的名单导入向导。
// 只渲染；动作由 app.js 统一接管。数字取自 8,327 行真实导出的量级，门店与商家名称为虚构。

import { state } from "./store.js";
import { icon, esc, badge, renderShell, stateAware, emptyState, deniedState, dataCell } from "./ui.js";

const num = (v) => Number(v).toLocaleString("en-US");

const CLASSES = {
  new: { label: "新增", tone: "green" },
  update: { label: "更新", tone: "blue" },
  unchanged: { label: "未变", tone: "plain" },
  error: { label: "错误", tone: "red" },
  needs_superadmin: { label: "需超管处理", tone: "amber" },
};
const REASON = {
  missing_required_field: "有必填列为空，请补全",
  row_withdrawn: "撤店情况不是「无撤销」，这一行不导入",
  row_digital_store: "数字门店不导入",
  dealer_code_missing: "商家渠道编码缺失（--或 #N/A）",
  main_business_code_unmapped: "主营业务编码没有对应的品牌，请联系管理员",
  brand_not_authorized: "这一行的品牌不在你的授权范围内",
  duplicate_store_code_in_file: "同一品牌下门店编码在文件里出现了多次",
  dealer_name_conflict_in_file: "同一商家渠道编码在文件里对应了不同的商家名称",
  dealer_not_found: "商家还不存在；普通导入不新建商家，需超管用结构导入",
  branch_not_found: "分公司编码不存在，请联系超管",
  store_restored: "该门店此前已撤店，本次恢复为在用",
};
const reasonCell = (code) => (code ? `<div class="reason-text">${esc(REASON[code] ?? code)}</div><div class="reason-code">${esc(code)}</div>` : "—");

const SAMPLE_ROWS = [
  { row: 2, code: "HB-BJ-0231", name: "日立北京朝阳旗舰店", dealer: "北京恒泰家电", cls: "update", reason: null, note: "门店名称：北京朝阳日立店 → 日立北京朝阳旗舰店" },
  { row: 3, code: "HB-BJ-0388", name: "日立北京通州店", dealer: "北京恒泰家电", cls: "new", reason: null },
  { row: 4, code: "HS-SH-1120", name: "海信上海徐汇店", dealer: "上海瑞丰电器", cls: "unchanged", reason: null },
  { row: 5, code: "HS-SH-1121", name: "海信上海浦东店", dealer: "上海新联电器", cls: "needs_superadmin", reason: "dealer_not_found" },
  { row: 6, code: "YK-GZ-0045", name: "约克广州天河店", dealer: "广州盛达空调", cls: "update", reason: "store_restored" },
  { row: 7, code: "HB-TJ-0099", name: "日立天津南开店", dealer: "--", cls: "error", reason: "dealer_code_missing" },
  { row: 8, code: "HS-CD-0310", name: "海信成都武侯店", dealer: "成都鑫旺电器", cls: "error", reason: "main_business_code_unmapped" },
  { row: 9, code: "HB-BJ-0231", name: "日立北京朝阳二店", dealer: "北京恒泰家电", cls: "error", reason: "duplicate_store_code_in_file" },
  { row: 10, code: "YK-SH-0072", name: "约克上海静安店", dealer: "上海瑞丰电器", cls: "error", reason: "row_withdrawn" },
  { row: 11, code: "HB-JN-0018", name: "日立济南历下店", dealer: "济南恒信家电", cls: "new", reason: null },
];
const PENDING_CLOSURE = [
  { id: "s1", code: "HB-BJ-0102", name: "日立北京海淀店", brand: "日立", branch: "北京分公司", dealer: "北京恒泰家电" },
  { id: "s2", code: "HB-BJ-0150", name: "日立北京丰台店", brand: "日立", branch: "北京分公司", dealer: "北京恒泰家电" },
  { id: "s3", code: "HS-SH-0881", name: "海信上海闵行店", brand: "海信", branch: "上海分公司", dealer: "上海瑞丰电器" },
  { id: "s4", code: "HS-SH-0902", name: "海信上海宝山店", brand: "海信", branch: "上海分公司", dealer: "上海新联电器" },
  { id: "s5", code: "YK-GZ-0033", name: "约克广州白云店", brand: "约克", branch: "广州分公司", dealer: "广州盛达空调" },
  { id: "s6", code: "HB-CD-0207", name: "日立成都锦江店", brand: "日立", branch: "成都分公司", dealer: "成都鑫旺电器" },
];
const BATCHES = {
  M1: { id: "MB-20261112-001", mode: "import", file: "门店信息数据_20261112.csv", by: "刘学奎", at: "2026-11-12 10:20", status: "completed", rows: 8327, imported: 158, unchanged: 8150, error: 12, needs: 7, closed: 2, pendingOpen: 4 },
  M2: { id: "MB-20261105-001", mode: "structure", file: "门店信息数据_20261105.csv", by: "刘学奎", at: "2026-11-05 15:02", status: "completed", rows: 8327, imported: 8315, unchanged: 0, error: 12, needs: 0, closed: 0, pendingOpen: 0 },
  M3: { id: "MB-20261112-002", mode: "import", file: "日立_增补.csv", by: "王敏", at: "2026-11-12 11:40", status: "awaiting_confirm", rows: 214, imported: 0, unchanged: 0, error: 3, needs: 0, closed: 0, pendingOpen: 0 },
};

function allowed() {
  return state.role === "platform_admin" || state.role === "hq_manager";
}
function denied(crumb) {
  return renderShell({ activeNav: "master", breadcrumb: ["工作区", "主数据", ...crumb], content: deniedState("主数据导入只对超管与总部人员开放。") });
}
function steps(current) {
  const defs = ["选择模式", "上传文件", "预检报告", "确认写入", "批次详情"];
  return `<div class="steps" aria-label="导入步骤">${defs.map((l, i) => `<div class="step ${i + 1 < current ? "done" : ""} ${i + 1 === current ? "active" : ""}"><span class="step-num">${i + 1}</span>${esc(l)}</div>`).join("")}</div>`;
}

/** 主数据区的两个页面之间的切换（2026-11-16 刘学奎要求）。active = "browse" | "import"。 */
export function masterTabs(active) {
  const tab = (key, label, href) => `<a class="chip ${active === key ? "active" : ""}" href="${href}">${esc(label)}</a>`;
  return `<div class="md-tabs" role="tablist" aria-label="主数据视图">
    ${tab("browse", "主数据浏览", "#/master")}
    ${tab("import", "主数据导入", "#/master/import")}
  </div>`;
}

/* ---------- 导入向导 ---------- */

export function renderMasterImport() {
  if (!allowed()) return denied(["导入"]);
  const step = state.mdStep;
  const body = step === 1 ? modeStep() : step === 2 ? uploadStep() : step === 3 ? reportStep() : confirmStep();
  const content = `
    ${masterTabs("import")}
    <div class="page-head">
      <div><h1 class="page-title">主数据导入</h1><p class="page-sub">导入权威主档导出（门店信息）；预检只读，确认后才写入业务表。</p></div>
      <div class="page-actions"><a class="btn" href="#/master/batches">${icon("file")} 导入记录</a></div>
    </div>
    <div class="wizard-layout">
      <div class="card wizard-main">
        ${steps(step)}
        <div class="card-pad">${stateAware(body)}</div>
      </div>
      <aside class="wizard-rail" aria-label="导入上下文">${rail()}</aside>
    </div>`;
  return renderShell({ activeNav: "master", breadcrumb: ["工作区", "主数据", "导入"], content });
}

function rail() {
  return `
    <div class="rail-card">
      <div class="rail-kicker">当前模式</div>
      <div class="rail-title">${state.mdMode === "structure" ? "结构导入（仅超管）" : "普通导入"}</div>
      <div class="rail-list">
        <div class="rail-row"><span>文件</span><strong>11 列固定表头</strong></div>
        <div class="rail-row"><span>数据行</span><strong>≤ 10,000</strong></div>
        <div class="rail-row"><span>文件大小</span><strong>≤ 10 MB</strong></div>
        <div class="rail-row"><span>单批时长</span><strong>≤ 10 分钟</strong></div>
      </div>
    </div>
    <div class="rail-card">
      <div class="rail-kicker">授权范围</div>
      <div class="rail-title">${state.role === "platform_admin" ? "全部品牌" : "日立、海信"}</div>
      <div class="rail-text">${state.role === "platform_admin" ? "可处理所有品牌的行。" : "授权品牌之外的行记为「品牌不在授权范围」，不会写入。"}</div>
    </div>
    <div class="rail-card">
      <div class="rail-kicker">消失的门店</div>
      <div class="rail-title">不会自动关店</div>
      <div class="rail-text">文件里没有、库里仍在用的门店只列为「待确认撤店」，由你逐个勾选才会关闭。</div>
    </div>
    <div class="callout" style="font-size:11px">${icon("shield")}<span>预检只读；确认前不写任何门店、商家或关系。</span></div>`;
}

function modeStep() {
  const isAdmin = state.role === "platform_admin";
  const card = (key, title, text, disabled) => `
    <button type="button" class="card card-pad" data-action="md-mode" data-mode="${key}" ${disabled ? "disabled" : ""} style="text-align:left;cursor:${disabled ? "not-allowed" : "pointer"};border:1px solid ${state.mdMode === key ? "rgba(15,163,168,.6)" : "var(--line,#E4E9F0)"};background:${state.mdMode === key ? "#E9F5F6" : "#fff"};opacity:${disabled ? ".6" : "1"}">
      <div class="card-title">${esc(title)}</div>
      <div class="cell-sub" style="margin-top:6px;white-space:normal">${esc(text)}</div>
      ${disabled ? `<div class="cell-sub" style="margin-top:8px">${icon("lock")} 仅超管可用</div>` : ""}
    </button>`;
  return `
    <div class="card-title" style="margin-bottom:4px">选择导入模式</div>
    <div class="card-sub" style="margin-bottom:12px">大多数情况用「普通导入」。商家或门店关系有变化、需要新建商家时才用结构导入。</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
      ${card("import", "普通导入", "新增 / 更新 / 恢复门店（名称、等级、所属商家不变）；商家还不存在的行标为「需超管处理」。", false)}
      ${card("structure", "结构导入", "在普通导入基础上，新建商家、更新商家名称、调整门店与商家的关系；不新建品牌、大区、分公司、板块。", !isAdmin)}
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px"><button class="btn btn-primary" data-action="md-next">${icon("arrowRight")} 下一步</button></div>`;
}

function uploadStep() {
  if (!state.mdUploaded) {
    return `
      <div class="dropzone">
        <div class="state-icon">${icon("upload")}</div>
        <strong>上传门店信息 CSV</strong>
        <p class="hint">固定 11 列，表头必须与权威导出一致（含「门店所属商家」「门店所属商家渠道编码」；不要带「负责人」列）。GB18030 与 UTF-8 都可以。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px">
          <button class="btn btn-primary" data-action="md-upload">${icon("upload")} 选择文件</button>
          <button class="btn" data-action="md-help">${icon("file")} 怎么从 Excel 导出</button>
        </div>
        <p class="hint">从 xlsx 的「门店信息数据」页签另存为 CSV；不要在 Excel 里重新排列列。单个文件 ≤ 10,000 行、≤ 10 MB。</p>
        <button class="btn btn-sm btn-ghost" data-action="md-prev">上一步</button>
      </div>`;
  }
  if (state.demoState === "error") {
    return `
      <div class="state">
        <div class="state-icon">${icon("alert")}</div>
        <div class="state-title">文件级校验失败，未创建批次</div>
        <p class="state-text">表头与权威导出不一致：多出「负责人」列。应为 11 列：门店编码、门店名称、……（共 11 列）。你的文件是 12 列。请删去「负责人」列后重新上传。</p>
        <div class="reason-code">header_mismatch</div>
        <div style="display:flex;gap:8px;justify-content:center"><button class="btn" data-action="md-reset">重新上传</button></div>
      </div>`;
  }
  return reportStep();
}

function reportStep() {
  const sel = state.mdClose.length;
  return `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <div><div class="card-title">预检报告</div><div class="card-sub">门店信息数据_20261112.csv · 8.2 MB · 数据行 8,327</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" data-action="md-download">${icon("download")} 下载回流文件</button>
        <button class="btn btn-sm" data-action="md-reset">重新上传</button>
        <button class="btn btn-sm btn-primary" data-action="md-next">确认写入 ${icon("arrowRight")}</button>
      </div>
    </div>
    <div class="stat-grid five" style="margin-bottom:14px">
      ${[["新增", 38, "将新建门店"], ["更新", 120, "名称 / 等级 / 恢复"], ["未变", 8150, "无需处理"], ["错误", 12, "需修改后重传"], ["需超管处理", 7, "商家或组织缺失"]].map(([l, v, h]) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${num(v)}</div><div class="stat-hint">${h}</div></div>`).join("")}
    </div>
    <div class="callout" style="margin-bottom:14px">${icon("shield")}<span>预检只读：门店、商家、品牌、分公司的行数与更新时间都没有变化。</span></div>

    <div class="section-note">待确认撤店 · ${PENDING_CLOSURE.length} 家</div>
    <div class="callout warn" style="margin-bottom:10px">${icon("alert")}<span>下面这些门店库里仍在用，但这份文件里没有。<strong>不会自动关店</strong>；勾选的才会在确认时关闭，默认一个都不勾。范围只取文件里出现的品牌（${state.role === "platform_admin" ? "日立、海信、约克" : "日立、海信"}）。</span></div>
    <div class="table-wrap" style="margin-bottom:14px">
      <table>
        <thead><tr><th style="width:42px"><input type="checkbox" aria-label="全选" data-action="md-close-all" ${sel === PENDING_CLOSURE.length ? "checked" : ""} /></th><th>门店</th><th>品牌 · 分公司</th><th>所属商家</th></tr></thead>
        <tbody>
          ${PENDING_CLOSURE.map((s) => `<tr><td><input type="checkbox" aria-label="关闭 ${esc(s.name)}" data-action="md-toggle-close" data-id="${s.id}" ${state.mdClose.includes(s.id) ? "checked" : ""} /></td><td>${dataCell(s.name, s.code)}</td><td>${esc(s.brand)} · ${esc(s.branch)}</td><td>${esc(s.dealer)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="cell-sub" style="margin:-6px 0 14px">已勾选 <strong class="num">${sel}</strong> / ${PENDING_CLOSURE.length} 家将在确认时关闭。</div>

    <div class="section-note">行明细（示例 10 行，实际可按分类筛选）</div>
    <div class="filter-line" style="margin-bottom:10px"><span class="filter-label">预检分类</span>${["全部", "新增", "更新", "未变", "错误", "需超管处理"].map((l, i) => `<span class="chip ${i === 0 ? "active" : ""}">${l}</span>`).join("")}</div>
    <div class="table-wrap precheck-table">
      <table>
        <thead><tr><th>行</th><th>门店</th><th>所属商家</th><th>预检</th><th>变化与原因</th></tr></thead>
        <tbody>
          ${SAMPLE_ROWS.map((r) => `<tr><td class="num">${r.row}</td><td>${dataCell(r.name, r.code)}</td><td>${esc(r.dealer)}</td><td>${badge(CLASSES[r.cls].label, CLASSES[r.cls].tone)}</td><td>${r.note ? `<div class="reason-text">${esc(r.note)}</div>` : reasonCell(r.reason)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function confirmStep() {
  const sel = state.mdClose.length;
  return `
    <div class="callout warn" style="margin-bottom:14px">${icon("alert")}<span>确认后是本批次唯一的写入点；分块写入，中断后可续跑，已写入的行不会重复写入。</span></div>
    <div class="info-grid">
      <div><div class="info-label">模式</div><div class="info-value">${state.mdMode === "structure" ? "结构导入" : "普通导入"}</div></div>
      <div><div class="info-label">文件</div><div class="info-value">门店信息数据_20261112.csv</div></div>
      <div><div class="info-label">数据行</div><div class="info-value num">8,327</div></div>
      <div><div class="info-label">将新增门店</div><div class="info-value num">38</div></div>
      <div><div class="info-label">将更新门店</div><div class="info-value num">120</div></div>
      <div><div class="info-label">将关闭门店</div><div class="info-value num">${sel}${sel ? "（你勾选的）" : "（未勾选，不关店）"}</div></div>
      <div><div class="info-label">不导入的行</div><div class="info-value num">19（错误 12 + 需超管处理 7）</div></div>
    </div>
    ${sel ? `<div class="callout danger" style="margin-top:14px">${icon("alert")}<span>将关闭 ${sel} 家门店；关闭后门店不再进入监控，可由后续导入恢复。</span></div>` : ""}
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
      <button class="btn" data-action="md-prev">上一步</button>
      <button class="btn btn-primary" data-action="md-confirm">${icon("check")} 确认写入</button>
    </div>`;
}

/* ---------- 导入记录 / 批次详情 ---------- */

const MODE = { import: "普通导入", structure: "结构导入" };
const STATUS = { completed: ["已完成", "green"], awaiting_confirm: ["待确认", "blue"], writing: ["写入中", "amber"], failed: ["失败", "red"] };

export function renderMasterBatches() {
  if (!allowed()) return denied(["导入记录"]);
  const rows = Object.entries(BATCHES).filter(([, b]) => state.role === "platform_admin" || b.by !== "刘学奎" || b.mode === "import");
  const content = `
    <a class="back-link" href="#/master/import">${icon("arrowLeft")} 返回主数据导入</a>
    <div class="page-head"><div><h1 class="page-title">导入记录</h1><p class="page-sub">批次与行结果是历史事实，长期保留；只显示你授权品牌内的批次。</p></div></div>
    ${stateAware(rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>批次</th><th>文件</th><th>模式</th><th>提交人 · 时间</th><th>状态</th><th class="right">结果计数</th><th class="right">操作</th></tr></thead>
        <tbody>${rows.map(([k, b]) => `<tr class="clickable" data-href="#/master/batches/${k}">
          <td>${dataCell(b.id)}</td><td>${esc(b.file)}</td><td>${MODE[b.mode]}</td>
          <td>${dataCell(b.by, b.at)}</td><td>${badge(STATUS[b.status][0], STATUS[b.status][1])}</td>
          <td class="right"><span class="num">${num(b.imported + b.unchanged)}</span><br /><span class="cell-sub">错误 ${b.error} / 需超管 ${b.needs}</span></td>
          <td class="right"><a class="btn btn-sm" href="#/master/batches/${k}">查看</a></td></tr>`).join("")}</tbody>
      </table></div>` : emptyState({ title: "还没有导入记录", text: "上传第一份门店信息后，记录会出现在这里。", action: '<a class="btn btn-primary" href="#/master/import">去导入</a>' }))}`;
  return renderShell({ activeNav: "master", breadcrumb: ["工作区", "主数据", "导入记录"], content });
}

export function renderMasterBatchDetail(key) {
  if (!allowed()) return denied(["导入记录"]);
  const b = BATCHES[key];
  if (!b) return renderShell({ activeNav: "master", breadcrumb: ["工作区", "主数据", "导入记录"], content: emptyState({ title: "批次不存在", text: "范围外批次按「未找到」处理。", action: '<a class="btn" href="#/master/batches">返回导入记录</a>' }) });
  const done = b.status === "completed";
  const content = `
    <a class="back-link" href="#/master/batches">${icon("arrowLeft")} 返回导入记录</a>
    <div class="page-head">
      <div><h1 class="page-title">批次 ${esc(b.id)}</h1><p class="page-sub">${MODE[b.mode]} · ${esc(b.file)} · ${esc(b.at)} · ${esc(b.by)}</p></div>
      <div class="page-actions">${badge(STATUS[b.status][0], STATUS[b.status][1])}<button class="btn" data-action="md-download">${icon("download")} 回流文件</button></div>
    </div>
    ${stateAware(`
      ${done ? "" : `<div class="callout warn" style="margin-bottom:14px">${icon("clock")}<span>这个批次预检完成但还没有确认写入。<a class="cell-main" href="#/master/import">回到预检报告</a></span></div>`}
      <div class="section-note">行结果 · 共 ${num(b.rows)} 行</div>
      <div class="stat-grid five" style="margin-bottom:14px">
        ${[["已写入", b.imported], ["未变", b.unchanged], ["错误", b.error], ["需超管处理", b.needs], ["已关闭门店", b.closed]].map(([l, v]) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${num(v)}</div></div>`).join("")}
      </div>
      ${b.pendingOpen ? `<div class="callout" style="margin-bottom:14px">${icon("alert")}<span>还有 ${b.pendingOpen} 家「待确认撤店」未处理（当时没有勾选）。它们在下一次导入时会重新出现，或被后续批次接续。</span></div>` : ""}
      <div class="table-wrap precheck-table"><table>
        <thead><tr><th>行</th><th>门店</th><th>所属商家</th><th>预检</th><th>变化与原因</th></tr></thead>
        <tbody>${SAMPLE_ROWS.slice(0, 8).map((r) => `<tr><td class="num">${r.row}</td><td>${dataCell(r.name, r.code)}</td><td>${esc(r.dealer)}</td><td>${badge(CLASSES[r.cls].label, CLASSES[r.cls].tone)}</td><td>${r.note ? `<div class="reason-text">${esc(r.note)}</div>` : reasonCell(r.reason)}</td></tr>`).join("")}</tbody>
      </table></div>`)}`;
  return renderShell({ activeNav: "master", breadcrumb: ["工作区", "主数据", "导入记录", b.id], content });
}
