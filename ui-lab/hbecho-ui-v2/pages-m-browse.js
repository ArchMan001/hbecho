// 主数据浏览（a-master-data-browse）页面原型：门店 / 分公司两个视图，只读。
// 2026-11-16 起草，供刘学奎评审（design §16）；确认前不是实现依据。
// 数据为虚构，量级取真实库（8,327 家门店、42 个分公司）；只渲染，动作由 app.js 统一接管。

import { state } from "./store.js";
import { icon, esc, badge, renderShell, stateAware, emptyState, deniedState, dataCell } from "./ui.js";
import { masterTabs } from "./pages-m.js";

const num = (v) => Number(v).toLocaleString("en-US");

const BRANDS = [
  { code: "hitachi", name: "日立" },
  { code: "hiscense", name: "海信" },
  { code: "york_vrf", name: "约克VRF" },
];
// 修正品牌编码：只用于演示数据的稳定映射
BRANDS[1].code = "hisense";

const CITIES = ["北京", "上海", "广州", "深圳", "天津", "重庆", "成都", "杭州", "南京", "武汉", "西安", "济南", "青岛", "郑州", "长沙", "合肥", "福州", "厦门", "苏州", "无锡", "宁波", "东莞", "佛山", "沈阳", "大连", "哈尔滨", "长春", "石家庄", "太原", "南昌", "南宁", "昆明", "贵阳", "兰州", "乌鲁木齐", "呼和浩特", "银川", "西宁", "海口", "温州", "常州", "徐州"];
const REGIONS = ["华北", "华东", "华南", "华中", "西南", "西北", "东北"];
const REGION_OF = {
  北京: "华北", 天津: "华北", 石家庄: "华北", 太原: "华北", 呼和浩特: "华北",
  上海: "华东", 南京: "华东", 杭州: "华东", 苏州: "华东", 无锡: "华东", 宁波: "华东", 温州: "华东", 常州: "华东", 徐州: "华东", 合肥: "华东", 福州: "华东", 厦门: "华东", 南昌: "华东", 济南: "华东", 青岛: "华东",
  广州: "华南", 深圳: "华南", 东莞: "华南", 佛山: "华南", 南宁: "华南", 海口: "华南",
  武汉: "华中", 长沙: "华中", 郑州: "华中",
  重庆: "西南", 成都: "西南", 昆明: "西南", 贵阳: "西南",
  西安: "西北", 兰州: "西北", 乌鲁木齐: "西北", 银川: "西北", 西宁: "西北",
  沈阳: "东北", 大连: "东北", 长春: "东北", 哈尔滨: "东北",
};
const SECTORS = ["水机", "家装"];
const TIERS = ["旗舰店", "标准店", "社区店"];
const ORDINALS = ["一", "二", "三", "四", "五", "六", "七", "八"];
const DEALER_SUFFIX = ["恒泰家电", "瑞丰电器", "盛达空调", "新联电器", "鑫旺电器", "恒信家电"];

const BRANCHES = CITIES.map((city, i) => ({
  branchId: `b${i + 1}`,
  code: `BR${String(i + 1).padStart(2, "0")}`,
  name: `${city}分公司`,
  region: REGION_OF[city] ?? REGIONS[i % REGIONS.length],
  city,
  updatedAt: `2026-11-${String(3 + (i % 12)).padStart(2, "0")} 09:${String(10 + (i % 40)).padStart(2, "0")}`,
}));

// 确定性伪随机：同一份演示数据每次刷新一致，便于走查。
let seed = 20261116;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/** 8,327 家门店；第 i 家店的分公司、品牌、状态由序号决定，闭店号每 59 家一个（与品牌周期互质，三个品牌都有撤店）。 */
const STORES = Array.from({ length: 8327 }, (_, i) => {
  const branch = BRANCHES[i % BRANCHES.length];
  const brand = BRANDS[i % BRANDS.length];
  const tier = i % 23 === 0 ? null : TIERS[i % TIERS.length];
  return {
    storeId: String(100000 + i),
    code: `${brand.code === "york_vrf" ? "YK" : brand.code === "hisense" ? "HS" : "HB"}-${branch.code}-${String(i + 1).padStart(4, "0")}`,
    name: `${brand.name}${branch.city}${tier ? tier.replace("店", "") : ""}${ORDINALS[i % ORDINALS.length]}店`,
    brand: brand.name,
    branchId: branch.branchId,
    branchName: branch.name,
    sector: SECTORS[i % SECTORS.length],
    dealerCode: `D${String((i % 180) + 1).padStart(4, "0")}`,
    dealerName: `${branch.city}${DEALER_SUFFIX[i % DEALER_SUFFIX.length]}`,
    tier,
    status: (i + 1) % 59 === 0 ? "closed" : "active",
    updatedAt: `2026-11-${String(1 + (i % 16)).padStart(2, "0")} ${String(8 + (i % 10)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}`,
  };
});
void rand;

const STATUS = { active: { label: "在用", tone: "green" }, closed: { label: "已撤店", tone: "plain" } };

function allowed() {
  return state.role === "platform_admin" || state.role === "hq_manager";
}

/** 总部人员只看授权品牌（日立、海信）；超管看全部。 */
function inScope(store) {
  if (state.role === "platform_admin") return true;
  return store.brand === "日立" || store.brand === "海信";
}

function scopedStores() {
  return STORES.filter(inScope);
}

function filterOf() {
  return state.mdBrowse;
}

function applyStoreFilter(rows, f) {
  const kw = f.kw.trim().toLowerCase();
  return rows.filter((s) =>
    (f.brand === "all" || s.brand === f.brand) &&
    (f.branch === "all" || s.branchId === f.branch) &&
    (f.sector === "all" || s.sector === f.sector) &&
    (f.tier === "all" || (f.tier === "none" ? s.tier === null : s.tier === f.tier)) &&
    (f.status === "all" || s.status === f.status) &&
    (!kw || s.code.toLowerCase().includes(kw) || s.name.toLowerCase().includes(kw)),
  );
}

function branchesWithCounts() {
  const rows = scopedStores();
  return BRANCHES.map((b) => {
    const mine = rows.filter((s) => s.branchId === b.branchId);
    return {
      ...b,
      active: mine.filter((s) => s.status === "active").length,
      closed: mine.filter((s) => s.status === "closed").length,
    };
  }).filter((b) => {
    const kw = filterOf().kw.trim().toLowerCase();
    return !kw || b.code.toLowerCase().includes(kw) || b.name.toLowerCase().includes(kw);
  });
}

function chip(group, value, label, current, action = "data-md-filter") {
  return `<button type="button" class="chip ${current === value ? "active" : ""}" ${action}="${group}" data-value="${esc(value)}">${esc(label)}</button>`;
}

function storeFilters(f) {
  const brands = state.role === "platform_admin" ? BRANDS.map((b) => b.name) : ["日立", "海信"];
  return `
    <section class="filter-card open" aria-label="门店筛选">
      <div class="filter-line"><span class="filter-label">品牌</span>
        ${chip("brand", "all", "全部品牌", f.brand)}${brands.map((b) => chip("brand", b, b, f.brand)).join("")}
      </div>
      <div class="filter-line"><span class="filter-label">分公司</span>
        <label class="filter-select"><select data-md-branch>
          <option value="all" ${f.branch === "all" ? "selected" : ""}>全部分公司</option>
          ${BRANCHES.map((b) => `<option value="${b.branchId}" ${f.branch === b.branchId ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
        </select></label>
        <span class="filter-note">分公司跨品牌共享；门店计数只含授权品牌内的门店</span>
      </div>
      <div class="filter-line"><span class="filter-label">板块</span>
        ${chip("sector", "all", "全部板块", f.sector)}${SECTORS.map((x) => chip("sector", x, x, f.sector)).join("")}
      </div>
      <div class="filter-line"><span class="filter-label">店面标准</span>
        ${chip("tier", "all", "全部", f.tier)}${TIERS.map((x) => chip("tier", x, x, f.tier)).join("")}${chip("tier", "none", "未设置", f.tier)}
      </div>
      <div class="filter-line"><span class="filter-label">状态</span>
        ${chip("status", "all", "全部", f.status)}${chip("status", "active", "在用", f.status)}${chip("status", "closed", "已撤店", f.status)}
      </div>
      <div class="filter-line"><span class="filter-label">搜索</span>
        <input class="input" data-md-kw value="${esc(f.kw)}" placeholder="门店编码或名称" style="max-width:260px" />
        <button type="button" class="btn btn-sm" data-action="md-search">搜索</button>
        <button type="button" class="btn btn-sm" data-action="md-clear">清空</button>
      </div>
    </section>`;
}

function branchFilters(f) {
  return `
    <section class="filter-card open" aria-label="分公司筛选">
      <div class="filter-line"><span class="filter-label">搜索</span>
        <input class="input" data-md-kw value="${esc(f.kw)}" placeholder="分公司编码或名称" style="max-width:260px" />
        <button type="button" class="btn btn-sm" data-action="md-search">搜索</button>
        <button type="button" class="btn btn-sm" data-action="md-clear">清空</button>
      </div>
    </section>`;
}

function pager(f, total) {
  const pages = Math.max(1, Math.ceil(total / f.size));
  const page = Math.min(pages, Math.max(1, f.page));
  const nums = [...new Set([1, page - 1, page, page + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const btn = (label, target, disabled) => `<button type="button" class="btn btn-sm" data-action="md-page" data-page="${target}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`;
  return `
    <div class="pager" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px">
      <span class="filter-note">共 ${num(total)} 条 · 第 ${page} / ${pages} 页</span>
      ${btn("‹ 上一页", page - 1, page <= 1)}
      ${nums.map((p) => (p === page ? `<span class="chip active">${p}</span>` : `<a class="chip" href="javascript:void(0)" data-action="md-page" data-page="${p}">${p}</a>`)).join("")}
      ${btn("下一页 ›", page + 1, page >= pages)}
      <label class="filter-select"><span>每页</span>
        <select data-md-size>${[20, 50, 100].map((s) => `<option value="${s}" ${f.size === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      </label>
    </div>`;
}

function storesTable() {
  const f = filterOf();
  const rows = applyStoreFilter(scopedStores(), f);
  const page = Math.min(Math.max(1, f.page), Math.max(1, Math.ceil(rows.length / f.size)));
  const slice = rows.slice((page - 1) * f.size, page * f.size);
  if (!slice.length) {
    return `${storeFilters(f)}${emptyState({ title: "没有符合条件的门店", text: "换一个品牌、分公司或状态，或清空关键字。", action: '<button type="button" class="btn" data-action="md-clear">清空筛选</button>' })}`;
  }
  const table = `
    <div class="table-wrap"><table>
      <thead><tr><th>门店编码</th><th>门店名称</th><th>品牌</th><th>分公司</th><th>板块</th><th>经销商</th><th>店面标准</th><th>状态</th><th>更新时间</th></tr></thead>
      <tbody>${slice.map((s) => `<tr>
        <td class="num">${esc(s.code)}</td>
        <td>${dataCell(s.name, s.storeId)}</td>
        <td>${esc(s.brand)}</td>
        <td>${esc(s.branchName)}</td>
        <td>${esc(s.sector)}</td>
        <td>${dataCell(s.dealerName, s.dealerCode)}</td>
        <td>${s.tier ? esc(s.tier) : "—"}</td>
        <td>${badge(STATUS[s.status].label, STATUS[s.status].tone)}</td>
        <td class="num">${esc(s.updatedAt)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    ${pager(f, rows.length)}`;
  return `${storeFilters(f)}${table}`;
}

function branchesTable() {
  const f = filterOf();
  const rows = branchesWithCounts();
  const page = Math.min(Math.max(1, f.page), Math.max(1, Math.ceil(rows.length / f.size)));
  const slice = rows.slice((page - 1) * f.size, page * f.size);
  if (!slice.length) {
    return `${branchFilters(f)}${emptyState({ title: "没有符合条件的分公司", text: "换一个关键字，或清空筛选。", action: '<button type="button" class="btn" data-action="md-clear">清空筛选</button>' })}`;
  }
  const table = `
    <div class="table-wrap"><table>
      <thead><tr><th>分公司编码</th><th>分公司名称</th><th>大区</th><th class="right">在用门店</th><th class="right">已撤门店</th><th>更新时间</th></tr></thead>
      <tbody>${slice.map((b) => `<tr class="clickable" data-action="md-open-branch" data-id="${b.branchId}">
        <td class="num">${esc(b.code)}</td>
        <td>${dataCell(b.name, "点击查看这个分公司的门店")}</td>
        <td>${esc(b.region)}</td>
        <td class="right num">${num(b.active)}</td>
        <td class="right num">${num(b.closed)}</td>
        <td class="num">${esc(b.updatedAt)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    ${pager(f, rows.length)}`;
  return `${branchFilters(f)}${table}`;
}

export function renderMasterBrowse() {
  if (!allowed()) return renderShell({ activeNav: "master", breadcrumb: ["工作区", "主数据", "浏览"], content: deniedState("主数据浏览只对超管与总部人员开放。") });
  const f = filterOf();
  const scoped = scopedStores();
  const active = scoped.filter((s) => s.status === "active").length;
  const closed = scoped.length - active;
  const viewChip = (key, label, count) => `<button type="button" class="chip ${f.view === key ? "active" : ""}" data-action="md-view" data-view="${key}">${esc(label)} · ${num(count)}</button>`;
  const scopeText = state.role === "platform_admin" ? "全部品牌" : "日立、海信（授权品牌）";
  const summary = f.view === "stores"
    ? `范围内 ${num(scoped.length)} 家门店 · 在用 ${num(active)} · 已撤店 ${num(closed)} · ${esc(scopeText)}`
    : `共 ${BRANCHES.length} 个分公司 · ${esc(scopeText)}；门店计数只含范围内的门店`;
  const content = `
    ${masterTabs("browse")}
    <div class="page-head">
      <div><h1 class="page-title">主数据浏览</h1><p class="page-sub">库里的分公司与门店当前值；只读，导入请走「主数据导入」。</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/master/import">${icon("upload")} 导入主数据</a></div>
    </div>
    <section class="summary-band" aria-label="主数据概览">
      <div><div class="summary-title">${f.view === "stores" ? "门店" : "分公司"}</div><div class="summary-sub">${summary}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${viewChip("stores", "门店", scoped.length)}
        ${viewChip("branches", "分公司", BRANCHES.length)}
      </div>
    </section>
    ${stateAware(f.view === "stores" ? storesTable() : branchesTable(), {
      empty: emptyState({ title: f.view === "stores" ? "没有符合条件的门店" : "没有符合条件的分公司", text: "切换视图或清空筛选后再看。", action: '<button type="button" class="btn" data-action="md-clear">清空筛选</button>' }),
    })}`;
  return renderShell({ activeNav: "master", breadcrumb: ["工作区", "主数据", "浏览"], content });
}