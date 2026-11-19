// 经销商视频广场（f-video-square）页面原型：广场列表 + AI分析界面示意。
// 2026-11-18 起草，供刘学奎评审（design §界面）；未确认前不是实现依据。
// 演示数据全部虚构：标题取自业务样本的风格，账号名、数字不对应真实账号。

import { state, SQ_DEFAULT } from "./store.js";
import { icon, esc, renderShell, stateAware, emptyState, filterToggle } from "./ui.js";

const num = (v) => Number(v).toLocaleString("en-US");
const fmtLike = (v) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : num(v));
const PAGE_SIZE = 20;

const BRAND_TONE = { 日立: "hitachi", 海信: "hisense", 约克: "york", 科龙: "kelon" };
const COVERS = [
  "linear-gradient(135deg,#c9485b,#7a2a4a)", "linear-gradient(135deg,#5b86a8,#2c4a63)", "linear-gradient(135deg,#d09a4a,#7a5224)",
  "linear-gradient(135deg,#4f9a8a,#244f48)", "linear-gradient(135deg,#8a6fb5,#443068)", "linear-gradient(135deg,#6e7f95,#2f3b4b)",
  "linear-gradient(135deg,#c76f5a,#6e3427)", "linear-gradient(135deg,#5aa56b,#2a5a36)",
];
const PLANS = [
  { id: "p315", name: "315 品质服务月" },
  { id: "pspring", name: "春季焕新装修活动" },
  { id: "p1111", name: "双11 种草挑战" },
];
const BRANCHES = ["北京分公司", "上海分公司", "广州分公司", "成都分公司", "杭州分公司", "郑州分公司"];
const TIME_OPTIONS = [["all", "全部时间"], ["7", "7天内"], ["30", "30天内"], ["90", "90天内"], ["180", "180天内"]];
const LIKE_OPTIONS = [["all", "全部（>50）"], ["51-100", "51-100"], ["101-300", "101-300"], ["301-500", "301-500"], ["501+", "500以上"]];
const LIKE_RANGE = { "51-100": [51, 100], "101-300": [101, 300], "301-500": [301, 500], "501+": [501, Infinity] };

const SEEDS = [
  ["金泽舒适家又获奖啦，心存感激 一份荣誉，一份责任，感谢日立中央空调", "日立", "抖音", "video", 20400, 14, "日立变频中央空调金泽机电凤凰城北城店"],
  ["#日立中央空调郑州分公司#家用中央空调 #全心全意为您服务", "日立", "抖音", "video", 15300, 12, "日立林州龙鑫兰安路专业店"],
  ["成都设计师的家 | 中央空调品牌怎么选 不知道怎么选中央空调？来听听", "日立", "小红书", "image", 14100, 12, "日立变频中央空调安亿家暖通"],
  ["选择这一款智慧空气定制系统，你会回来感谢我。#每一感都超有感", "日立", "抖音", "video", 13200, 108, "日立变频中央空调专业店"],
  ["天冷了，明装暖气避坑#明装暖气 #新力舒适家 #扬州明装暖气片", "海信", "抖音", "video", 13000, 652, "新力舒适家扬州店"],
  ["邻居拆除中间墙，各借了一个冰箱位", "海信", "快手", "video", 10700, 3, "海信福州云众力榄城江上图专业店"],
  ["那就祝刷到的都旺～", "科龙", "抖音", "video", 7342, 2134, "科龙舟山弘实第六空间旗舰店"],
  ["年会不能停 不愧是义乌最强日立中央空调旗舰店！年年登顶。老板怎么会", "日立", "抖音", "video", 6893, 624, "日立义乌瑜琦舟溪路旗舰店"],
  ["日立智享～天氟地水两联供～～省钱省到怀疑自己🤪#共建理想家 #地暖", "日立", "小红书", "video", 5863, 12, "常德诚鑫旗舰店"],
  ["销售日记第二十五天。#真实生活分享计划 #销售日常 不需要怎么办", "约克", "快手", "video", 5786, 34, "日立滨州信恒达黄河路专业店"],
  ["三口之家 120 平，约克 VRF 一拖多的实际使用感受", "约克", "小红书", "image", 4210, 96, "约克VRF上海徐汇体验店"],
  ["科龙新风空调开箱：安装师傅教你三步检查出风口", "科龙", "快手", "video", 3120, 45, "科龙杭州滨江旗舰店"],
  ["海信日立中央空调联动演示｜一键切换睡眠模式", "海信", "抖音", "video", 2650, 71, "海信广州天河中央空调店"],
  ["春季换季保养，这三个滤网动作别省", "日立", "抖音", "video", 1780, 23, "日立北京朝阳旗舰店"],
  ["客户回访日常：装完一年后的真实反馈", "约克", "抖音", "video", 960, 18, "约克成都武侯专业店"],
  ["店面新装修完成，欢迎来店体验", "海信", "小红书", "image", 410, 9, "海信郑州金水体验店"],
  ["冬季取暖方案对比：地暖 vs 暖气片 vs 空气能", "科龙", "抖音", "video", 188, 7, "科龙北京朝阳店"],
  ["门店晨会二十分钟，今天讲怎么接待咨询客户", "日立", "快手", "video", 76, 2, "日立济南历下店"],
];

// 每条种子展开成三条（点赞与发布日不同），共 54 条；全部点赞 > 50
export const SQ_ITEMS = SEEDS.flatMap(([title, brand, platform, kind, likes, comments, account], i) =>
  [1, 0.55, 0.2].map((f, k) => {
    const like = Math.max(51, Math.round(likes * f));
    return {
      id: `v${i * 3 + k + 1}`,
      title: k === 0 ? title : `${title}${k === 1 ? "（二）" : "（三）"}`,
      brand, platform, kind, like,
      comments: Math.max(0, Math.round(comments * f)),
      account,
      branch: BRANCHES[(i + k) % BRANCHES.length],
      daysAgo: [3, 12, 26, 48, 75, 120, 160, 200][(i * 3 + k) % 8] + (k === 2 ? 5 : 0),
      plans: i % 3 === 0 ? ["p315"] : i % 5 === 0 ? ["pspring", "p1111"] : i % 4 === 0 ? ["p1111"] : [],
      cover: COVERS[(i + k) % COVERS.length],
    };
  }),
);

const uniq = (key) => [...new Set(SQ_ITEMS.map((x) => x[key]))];

function matches(it, f) {
  if (f.brand !== "all" && it.brand !== f.brand) return false;
  if (f.platform !== "all" && it.platform !== f.platform) return false;
  if (f.kind !== "all" && it.kind !== f.kind) return false;
  if (f.plan !== "all" && !it.plans.includes(f.plan)) return false;
  if (f.branch !== "all" && it.branch !== f.branch) return false;
  if (f.time !== "all" && it.daysAgo > Number(f.time)) return false;
  if (f.like !== "all") {
    const [lo, hi] = LIKE_RANGE[f.like];
    if (it.like < lo || it.like > hi) return false;
  }
  if (f.q && !it.title.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

const chips = (key, options, current) =>
  options.map(([v, l]) => `<button type="button" class="chip ${current === v ? "active" : ""}" data-sq-filter="${key}" data-value="${esc(v)}">${esc(l)}</button>`).join("");

const select = (key, label, options, current, { disabled = false, hint = "" } = {}) => `
  <label class="filter-select ${disabled ? "is-disabled" : ""}" ${hint ? `title="${esc(hint)}"` : ""}>
    <span>${esc(label)}</span>
    <select data-sq-select="${key}" ${disabled ? "disabled" : ""} aria-label="${esc(label)}">
      ${options.map(([v, l]) => `<option value="${esc(v)}" ${current === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>
  </label>`;

function card(it) {
  return `
    <article class="sq-card">
      <div class="sq-cover" style="background:${it.cover}">
        <span class="sq-kind">${it.kind === "video" ? icon("play") : icon("layers")}${it.kind === "video" ? "视频" : "图文"}</span>
        <span class="sq-platform">${esc(it.platform)}</span>
        <div class="sq-hover">
          <button type="button" class="btn btn-sm" data-action="sq-watch" data-id="${it.id}">${icon("external")} 观看</button>
          <button type="button" class="btn btn-sm btn-primary" data-action="sq-ai" data-id="${it.id}">${icon("sparkles")} AI分析</button>
        </div>
      </div>
      <div class="sq-body">
        <h3 class="sq-title" title="${esc(it.title)}">${esc(it.title)}</h3>
        <div class="sq-meta">
          <span class="sq-stat" title="点赞">${icon("thumb")}<span class="num">${fmtLike(it.like)}</span></span>
          <span class="sq-stat" title="评论">${icon("comment")}<span class="num">${num(it.comments)}</span></span>
          <span class="sq-brand sq-brand-${BRAND_TONE[it.brand] ?? "plain"}">${esc(it.brand)}</span>
        </div>
        <div class="sq-account" title="${esc(it.account)}">${esc(it.account)}</div>
      </div>
      <div class="sq-actions-touch">
        <button type="button" class="btn btn-sm" data-action="sq-watch" data-id="${it.id}">观看</button>
        <button type="button" class="btn btn-sm" data-action="sq-ai" data-id="${it.id}">AI分析</button>
      </div>
    </article>`;
}

export function renderSquare() {
  const f = state.sq;
  const list = SQ_ITEMS.filter((it) => matches(it, f)).sort((a, b) => b.like - a.like || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const changed = Object.keys(SQ_DEFAULT).filter((k) => k !== "page" && f[k] !== SQ_DEFAULT[k]).length;

  const grid = slice.length
    ? `<div class="sq-grid">${slice.map(card).join("")}</div>`
    : emptyState({ title: "没有符合条件的视频", text: "换个关键词，或点「重置」回到默认条件。", action: `<button type="button" class="btn" data-action="sq-reset">重置</button>` });

  const content = `
    <h1 class="sq-sr">经销商视频广场</h1>
    <div class="sq-bigtabs" role="tablist" aria-label="广场类型">
      <button type="button" class="sq-bigtab active" role="tab" aria-selected="true"><span class="sq-bigtab-title">经销商视频广场</span><span class="sq-bigtab-sub">各品牌经销商的公开作品</span></button>
      <button type="button" class="sq-bigtab is-off" role="tab" aria-selected="false" aria-disabled="true" data-action="sq-noop-off"><span class="sq-bigtab-title">官媒阵地</span><span class="sq-bigtab-sub">暂未开放</span></button>
    </div>
    <p class="page-sub sq-lead">各品牌经销商的公开作品，用来互相借鉴。只显示点赞超过 50 的作品，按点赞数从高到低排列。</p>
    ${filterToggle(changed)}
    <section class="filter-card ${state.filtersOpen ? "open" : ""}" aria-label="筛选">
      <div class="filter-line"><span class="filter-label">品牌</span>${chips("brand", [["all", "全部品牌"], ...uniq("brand").map((b) => [b, b])], f.brand)}</div>
      <div class="filter-line"><span class="filter-label">平台</span>${chips("platform", [["all", "全部平台"], ...uniq("platform").map((p) => [p, p])], f.platform)}</div>
      <div class="filter-line"><span class="filter-label">类型</span>${chips("kind", [["all", "全部类型"], ["video", "视频"], ["image", "图文"]], f.kind)}</div>
      <div class="filter-line sq-selects">
        ${select("plan", "参与活动计划", [["all", "全部活动计划"], ...(state.sq.planLive ? PLANS.map((p) => [p.id, p.name]) : [])], f.plan, { disabled: !state.sq.planLive, hint: "暂未开放" })}
        ${select("branch", "分公司", [["all", "全部分公司"], ...BRANCHES.map((b) => [b, b])], f.branch)}
        ${select("time", "发布时间", TIME_OPTIONS, f.time)}
        ${select("like", "点赞数", LIKE_OPTIONS, f.like)}
        <form class="sq-search" data-form="sq-search" role="search">
          <label class="course-search">${icon("search")}<input type="search" name="q" value="${esc(f.q)}" placeholder="搜索视频标题" aria-label="搜索视频标题" /></label>
          <button type="submit" class="btn btn-sm btn-dark">搜索</button>
          <button type="button" class="btn btn-sm" data-action="sq-reset">重置</button>
        </form>
      </div>
    </section>
    <div class="result-bar">
      <span>共 <strong class="num">${num(list.length)}</strong> 条 · 第 ${page} / ${pages} 页</span>
      <span class="hint">按点赞数从高到低 · 活动计划下拉${state.sq.planLive ? "（预览：判定计划已上线）" : "目前置灰"}
        <button type="button" class="btn btn-sm btn-ghost" data-action="sq-plan-live">${state.sq.planLive ? "还原为置灰" : "原型：预览上线后的效果"}</button></span>
    </div>
    ${stateAware(grid, { empty: emptyState({ title: "还没有符合条件的视频", text: "采集到作品后会出现在这里。" }) })}
    <div class="pagination">
      <span>每页 ${PAGE_SIZE} 条</span>
      <div class="pagination-actions">
        <button type="button" class="btn btn-sm" data-action="sq-page" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
        <button type="button" class="btn btn-sm" data-action="sq-page" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button>
      </div>
    </div>`;
  return renderShell({ activeNav: "square", breadcrumb: ["工作区", "经销商视频广场"], content });
}

/* ---------- AI分析界面示意（静态；正式页面点击只弹「功能正在开发中」） ---------- */

export function renderSquareAi(id) {
  const it = SQ_ITEMS.find((x) => x.id === id) ?? SQ_ITEMS[0];
  const rewrite = state.sq.aiTab === "rewrite";
  const content = `
    <div class="page-head">
      <div><h1 class="page-title">AI分析</h1><p class="page-sub">界面示意：AI分析与仿写功能正在开发中，下面的内容是占位示例，不是真实分析结果。</p></div>
      <div class="page-actions"><a class="btn" href="#/square">${icon("arrowLeft")} 返回广场</a></div>
    </div>
    <div class="callout warn" style="margin-bottom:14px">${icon("clock")}<span>功能正在开发中：按钮与输入框暂不可用。</span></div>
    <div class="sq-ai">
      <aside class="card sq-ai-info" aria-label="作品信息">
        <div class="sq-cover sq-cover-lg" style="background:${it.cover}"><span class="sq-kind">${it.kind === "video" ? icon("play") : icon("layers")}${it.kind === "video" ? "视频" : "图文"}</span></div>
        <div class="card-pad">
          <h2 class="sq-ai-title">${esc(it.title)}</h2>
          <dl class="sq-ai-dl">
            <div><dt>品牌</dt><dd><span class="sq-brand sq-brand-${BRAND_TONE[it.brand] ?? "plain"}">${esc(it.brand)}</span></dd></div>
            <div><dt>平台</dt><dd>${esc(it.platform)}</dd></div>
            <div><dt>账号</dt><dd>${esc(it.account)}</dd></div>
            <div><dt>分公司</dt><dd>${esc(it.branch)}</dd></div>
            <div><dt>点赞</dt><dd class="num">${num(it.like)}</dd></div>
            <div><dt>评论</dt><dd class="num">${num(it.comments)}</dd></div>
            <div><dt>发布</dt><dd>${it.daysAgo} 天前</dd></div>
          </dl>
          <button type="button" class="btn" data-action="sq-watch" data-id="${it.id}">${icon("external")} 观看原作品</button>
        </div>
      </aside>
      <section class="card sq-ai-main" aria-label="AI分析">
        <div class="sq-bigtabs sq-bigtabs-inner" role="tablist" aria-label="AI功能">
          <button type="button" class="sq-bigtab ${rewrite ? "" : "active"}" role="tab" aria-selected="${!rewrite}" data-action="sq-ai-tab" data-id="analyze"><span class="sq-bigtab-title">AI分析作品内容</span></button>
          <button type="button" class="sq-bigtab ${rewrite ? "active" : ""}" role="tab" aria-selected="${rewrite}" data-action="sq-ai-tab" data-id="rewrite"><span class="sq-bigtab-title">AI仿写</span></button>
        </div>
        <div class="sq-ai-out">
          ${rewrite ? `
          <div class="sq-ai-block"><h3>仿写标题（示例）</h3><ul><li>换成本店案例的标题写法</li><li>保留原作品的提问式开头</li></ul></div>
          <div class="sq-ai-block"><h3>仿写脚本（示例）</h3><ol><li>开场：门店场景 + 一个问题</li><li>主体：本店主推产品的三个卖点</li><li>结尾：引导咨询或到店</li></ol></div>
          <div class="sq-ai-block"><h3>拍摄建议（示例）</h3><ul><li>时长控制在 30 秒内</li><li>字幕与话题聚焦一个主题</li></ul></div>
          <div class="sq-ai-block"><h3>话题与文案（示例）</h3><ul><li>3 个相关话题标签</li><li>一段可直接发布的文案</li></ul></div>` : `
          <div class="sq-ai-block"><h3>内容亮点</h3><ul><li>开头 3 秒点出利益点（示例）</li><li>门店场景真实，口语化表达（示例）</li></ul></div>
          <div class="sq-ai-block"><h3>结构拆解</h3><ol><li>钩子：抛出问题</li><li>主体：产品卖点与场景演示</li><li>结尾：引导咨询或到店</li></ol></div>
          <div class="sq-ai-block"><h3>可改进之处</h3><ul><li>字幕与话题可更聚焦（示例）</li></ul></div>
          <div class="sq-ai-block"><h3>给你的建议</h3><ul><li>可参考其开场方式，换成本店真实案例（示例）</li></ul></div>`}
        </div>
        <form class="sq-ai-input" onsubmit="return false">
          <input class="input" type="text" placeholder="向 AI 提问，例如：这条视频的开头为什么有效？" disabled aria-label="向 AI 提问" />
          <button type="button" class="btn btn-primary" disabled>${icon("send")} 发送</button>
        </form>
      </section>
    </div>`;
  return renderShell({ activeNav: "square", breadcrumb: ["工作区", "经销商视频广场", "AI分析"], content });
}
