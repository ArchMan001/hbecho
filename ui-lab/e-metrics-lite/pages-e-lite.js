// 全量明细与导出（e-metrics-lite）页面原型：视频明细 + 账号维度 + 判定计划入口示意。
// 2026-11-19 起草，供刘学奎评审（design §10）；未确认前不是实现依据。
// 演示数据全部虚构。结果不是写死的：按 requirements EL-4 / EL-6 的规则，用一个小的确定性生成器
// 现算三层结果与账号能力四态，所以「各能力都通过但判定结果不通过」这类现象是规则本身产生的。

import { state } from "./store.js";
import { icon, esc, renderShell, stateAware, emptyState, deniedState, filterToggle, badge } from "./ui.js";

export const SKIPPED = "前置条件未满足，不进行计算";
const PAGE_SIZE = 50;
const num = (v) => Number(v).toLocaleString("en-US");

/* ---------- 确定性随机 ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/* ---------- 组织与专员（虚构） ---------- */
const BRANCHES = [
  ["北区", "北京分公司"], ["北区", "天津分公司"], ["北区", "济南分公司"],
  ["南区", "上海分公司"], ["南区", "杭州分公司"], ["南区", "广州分公司"],
];
const SECTORS = ["家装", "工装"];
const STAFF = ["张三", "李娜", "王强", "赵敏", "刘洋", "陈静", "杨帆", "黄磊", "周婷", "吴刚", "徐丽", "孙浩",
  "马超", "朱琳", "胡军", "郭敏", "何伟", "高远", "林芳", "罗斌", "梁艳", "宋涛", "郑洁", "谢鹏",
  "韩雪", "唐明", "冯凯", "于佳", "董宇", "萧红", "程亮", "曹颖", "袁野", "邓丽", "许诺", "傅强",
  "沈月", "曾辉", "彭程", "吕蒙", "苏婉", "卢山", "蒋涛", "蔡琴", "贾宁", "丁一", "魏然", "薛峰"];
const STREETS = ["朝阳路", "建设大道", "万达广场", "红星美凯龙", "月星家居", "金域蓝湾", "世贸中心", "科技园", "东风路", "滨江道", "解放路", "太平街"];
const SUFFIX = ["旗舰店", "专业店", "体验店", "中央空调店"];
const DEALERS = ["恒瑞暖通设备有限公司", "佰昱信息科技有限公司", "翔瑞制冷设备有限公司", "寻木暖通设备有限公司", "荣大电器有限公司", "美冠电器有限公司"];

function buildAccounts(count, seed) {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const [region, branch] = BRANCHES[i % BRANCHES.length];
    const street = STREETS[(i * 5) % STREETS.length];
    const store = `日立${branch.replace("分公司", "")}${street}${SUFFIX[i % SUFFIX.length]}`;
    return {
      accountId: `a${i + 1}`, brand: "日立", region, branch, sector: SECTORS[i % 3 === 2 ? 1 : 0],
      dealer: `${branch.replace("分公司", "")}${DEALERS[i % DEALERS.length]}`,
      store, storeKey: `s${i + 1}`, storeCode: `NO.${String(3600 + i * 37).padStart(7, "0")}`,
      staff: STAFF[i % STAFF.length],
      nickname: `日立中央空调(${branch.replace("分公司", "")}${street}店)`,
      homeUrl: `https://www.douyin.com/user/MS4wLjABAAAA${String(900000 + i * 7919)}`,
      followers: i === 11 ? { state: "missing" } : { state: "value", v: between(r, 40, 5200) },
      likesTotal: { state: "value", v: between(r, 300, 96000) },
      posts: between(r, 30, 520),
      collected: between(r, 12, 60),
      profileSync: i === 5 ? { ok: "无记录", at: "" } : i === 17 ? { ok: "否", at: "2026-11-18 03:12" } : { ok: "是", at: `2026-11-1${7 + (i % 2)} ${String(2 + (i % 5)).padStart(2, "0")}:${String(10 + i).padStart(2, "0")}` },
      listSync: i === 9 ? { ok: "部分（有缺口）", at: "2026-11-18 03:40" } : i === 17 ? { ok: "否", at: "2026-11-18 03:15" } : i === 5 ? { ok: "无记录", at: "" } : { ok: "是", at: `2026-11-1${7 + (i % 2)} ${String(2 + (i % 5)).padStart(2, "0")}:${String(30 + (i % 20)).padStart(2, "0")}` },
      avatar: r() < 0.08 ? null : i, background: r() < 0.14 ? null : i + 3,
      zero: i === 20 || i === 33 ? (i === 20 ? "complete" : "gap") : null,
      syncGapReason: i === 33 ? "sync_gap" : null,
    };
  });
}

/* ---------- 判定计划与执行（虚构） ---------- */
const C = (key, layer, kind, subject, alias = null, target = null, extra = {}) => ({ key, layer, kind, target, subject, alias, ...extra });
const CONDS_V3 = [
  C("l1.0", 1, "text", "content", "品牌词", null, { words: ["日立", "中央空调", "智慧空气"], mode: "any" }),
  C("l1.1", 1, "text", "content", null, null, { words: ["安装", "质保", "十年"], mode: "any" }),
  C("l1.2", 1, "hashtags", "content", null, null, { words: ["#双11种草", "#日立中央空调"], mode: "any" }),
  C("l1.3", 1, "hashtags", "content", null, null, { words: ["#家装", "#舒适家"], mode: "any" }),
  C("l1.4", 1, "duration", "content", null, null, { min: 10, max: 100 }),
  C("l2.a1", 2, "whole_image", "content", "封面模板", "cover", { threshold: 6 }),
  C("l2.a2", 2, "image_element", "content", null, "cover", { threshold: 5.5 }),
  C("l2.a3", 2, "whole_image", "account", "头像比对", "avatar"),
  C("l2.a4", 2, "image_element", "account", null, "background"),
  C("l3", 3, "asr", "content"),
  C("comment", "comment", "comment", "content"),
];
const CONDS_V2 = [
  C("l1.0", 1, "text", "content", null, null, { words: ["日立", "中央空调"], mode: "any" }),
  C("l1.1", 1, "hashtags", "content", null, null, { words: ["#双11种草"], mode: "any" }),
  C("l2.a1", 2, "whole_image", "content", null, "cover", { threshold: 6.5 }),
  C("l3", 3, "asr", "content"),
  C("comment", "comment", "comment", "content"),
];
const CONDS_V1 = CONDS_V2.slice(0, 4);

const EXECS = [
  { id: "e3", version: 3, completedAt: "2026-11-18 18:20", cutoffAt: "2026-11-18 12:00", from: "2026-11-01", to: "2026-11-17", n: 2, conditions: CONDS_V3, abilityResultsAvailable: true, contentsPruned: false, seed: 11, accounts: 48, kinds: ["video"] },
  { id: "e2", version: 2, completedAt: "2026-11-11 17:05", cutoffAt: "2026-11-11 12:00", from: "2026-10-25", to: "2026-11-10", n: 1, conditions: CONDS_V2, abilityResultsAvailable: false, contentsPruned: false, seed: 23, accounts: 46, kinds: ["video", "image"] },
  { id: "e1", version: 1, completedAt: "2026-11-04 16:40", cutoffAt: "2026-11-04 12:00", from: "2026-10-18", to: "2026-11-03", n: 1, conditions: CONDS_V1, abilityResultsAvailable: true, contentsPruned: true, seed: 37, accounts: 44, kinds: ["video"] },
];
export const PLANS = {
  jp1: { id: "jp1", alias: "种草视频判定 · 抖音", activity: "双11 种草挑战", platform: "抖音", executions: EXECS },
  jp2: { id: "jp2", alias: "焕新装修判定 · 小红书", activity: "春季焕新装修活动", platform: "小红书", executions: [] },
};

/* ---------- 判定结果现算（对应 D 的纯函数；EL-4、EL-6） ---------- */
const TITLES = [
  "日立中央空调智慧空气馆，销量爆款，宠粉特惠，一拖六双风扇复式别墅，随时退、过期自动退", "装中央空调，想判断安装靠不靠谱，记住问这3个问题：保温棉接口怎么连接、抽真空时长",
  "中央空调属于隐蔽工程，故障大多出在几年之后，后期维修成本很高，十年质保更省心", "客户回访日常：装完一年后的真实反馈 #日立中央空调 #家装", "冬季取暖方案对比：地暖 vs 暖气片 vs 空气能",
  "双11 种草｜这套舒适家方案为什么一直爆单 #双11种草 #舒适家", "安装师傅教你三步检查出风口，别再被忽悠", "三口之家 120 平，一拖多的实际使用感受 #家装", "门店晨会二十分钟，今天讲怎么接待咨询客户",
  "日立智享～天氟地水两联供～省钱省到怀疑自己 #日立中央空调", "春季换季保养，这三个滤网动作别省", "店面新装修完成，欢迎来店体验 #双11种草",
];

function genContentId(r) {
  return `77${String(Math.floor(r() * 1e8)).padStart(8, "0")}${String(Math.floor(r() * 1e9)).padStart(9, "0")}`; // 19 位，保持字符串
}
const dayStr = (r, from, to) => {
  const a = new Date(`${from}T00:00:00+08:00`).getTime();
  const b = new Date(`${to}T23:59:00+08:00`).getTime();
  const d = new Date(a + r() * (b - a) + 8 * 3600e3);
  return d.toISOString().slice(0, 16).replace("T", " ");
};

function evalL1(c, r) {
  const x = r();
  if (c.kind === "duration") {
    const seconds = between(r, 6, 120);
    if (x < 0.03) return { state: "unobtained", reason: "duration_missing" };
    return { state: seconds >= c.min && seconds <= c.max ? "pass" : "fail", seconds: String(seconds) };
  }
  if (x < 0.03) return { state: "unobtained", reason: "not_computed" };
  const hitAll = c.words.filter(() => r() < 0.78);
  const pass = c.mode === "any" ? hitAll.length > 0 : hitAll.length === c.words.length;
  return { state: pass ? "pass" : "fail", hit: hitAll };
}
const and3 = (arr) => (arr.includes("fail") ? "fail" : arr.includes("unobtained") ? "unobtained" : "pass");

function genRows(exec, accounts) {
  const r = rng(exec.seed * 101);
  const conds = exec.conditions;
  const l1c = conds.filter((c) => c.layer === 1);
  const l2c = conds.filter((c) => c.layer === 2 && c.subject === "content");
  const l3c = conds.find((c) => c.layer === 3);
  const cmc = conds.find((c) => c.layer === "comment");
  const rows = [];
  accounts.forEach((acc, ai) => {
    const count = acc.zero ? 0 : ai % 9 === 4 ? 1 : between(r, 3, 12);
    const mine = [];
    for (let k = 0; k < count; k++) {
      const kind = exec.kinds.includes("image") && r() < 0.2 ? "image" : "video";
      const row = {
        contentId: genContentId(r), accountId: acc.accountId, kind, kindLabel: kind === "video" ? "视频" : "图文",
        title: pick(r, TITLES), publishedAt: dayStr(r, exec.from, exec.to),
        like: { state: "value", v: Math.floor(Math.pow(r(), 3) * 900) },
        comment: { state: "value", v: Math.floor(Math.pow(r(), 3) * 120) }, share: { state: "value", v: Math.floor(Math.pow(r(), 4) * 60) }, collect: { state: "value", v: Math.floor(Math.pow(r(), 4) * 80) },
        snapshotAt: exec.cutoffAt.replace("12:00", `0${between(r, 3, 9)}:${String(between(r, 10, 55))}`),
        cover: r() < 0.1 ? null : ai * 7 + k,
        l0: "pass", l1: null, l2: null, l3: null, final: null, stop: null, reason: null, selected: null,
        ev: { l1: [], l2: [], l3: null }, cm: null,
      };
      row.url = `https://www.douyin.com/video/${row.contentId}`;
      if (r() < 0.04) row.comment = { state: "missing" };
      if (r() < 0.03) row.collect = { state: "invalid" };
      row.id = row.contentId;
      mine.push(row);
    }
    // 个别行：发布时间缺失 / 形态未知（D：l0 = unobtained，照常列出）
    if (ai === 3 && mine[0]) Object.assign(mine[0], { publishedAt: "", l0: "unobtained", reason: "published_at_missing" });
    if (ai === 8 && mine[1]) Object.assign(mine[1], { kindLabel: "未知", l0: "unobtained", reason: "content_kind_unknown" });
    mine.forEach((row) => {
      if (row.l0 !== "pass") { row.final = "unobtained"; row.stop = 0; return; }
      row.ev.l1 = l1c.map((c, idx) => ({ idx, ...evalL1(c, r) }));
      row.l1 = and3(row.ev.l1.map((e) => e.state));
    });
    // 演示用的确定例子（N=1 的执行）：这位专员的文本条件由第 1 条内容通过、话题条件由第 2 条内容通过，
    // 没有一条内容同时通过 → 第 1 层各列都是「通过」，但第 2、3 层没有内容走到（前置条件未满足），判定结果不通过。
    if (ai === 12 && exec.n === 1 && mine.length >= 2) {
      const mk = (fail) => l1c.map((c, idx) => (fail.has(idx) ? { idx, state: "fail", ...(c.kind === "duration" ? { seconds: "5" } : { hit: [] }) } : { idx, state: "pass", ...(c.kind === "duration" ? { seconds: "45" } : { hit: [c.words[0]] }) }));
      mine.forEach((row, i) => { row.ev.l1 = mk(new Set(i === 0 ? [1] : i === 1 ? [0] : l1c.map((_, k) => k))); row.l1 = and3(row.ev.l1.map((e) => e.state)); });
    }
    // 第 1 层：按点赞取前 N（每位专员各自）
    const passL1 = mine.filter((x) => x.l0 === "pass" && x.l1 === "pass").sort((a, b) => b.like.v - a.like.v);
    passL1.forEach((x, i) => { x.selected = exec.n === null || i < exec.n; });
    mine.forEach((row) => {
      if (row.l0 !== "pass") return;
      if (row.l1 === "fail") { row.final = "fail"; row.stop = 1; return; }
      if (row.l1 === "unobtained") { row.final = "unobtained"; row.stop = 1; row.reason = "not_computed"; return; }
      if (!row.selected) { row.final = "skipped"; row.reason = "layer1_not_selected"; return; }
      // 第 2 层（内容类）
      row.ev.l2 = l2c.map((c) => {
        const x = r();
        if (x < 0.03) return { id: c.key, state: "unobtained", reason: "dependency_timeout" };
        const score = Math.round((5 + r() * 5) * 100) / 100;
        return { id: c.key, state: score >= c.threshold ? "pass" : "fail", score: score.toFixed(2) };
      });
      row.l2 = l2c.length ? and3(row.ev.l2.map((e) => e.state)) : "not_configured";
      if (row.l2 === "fail") { row.final = "fail"; row.stop = 2; return; }
      if (row.l2 === "unobtained") { row.final = "unobtained"; row.stop = 2; row.reason = "dependency_timeout"; return; }
      // 评论：候选 = 走完第 2 层
      if (cmc) { const total = between(r, 0, 30); row.cm = { total, pass: Math.min(total, between(r, 1, 14)) }; }
      if (l3c) {
        const x = r();
        row.ev.l3 = x < 0.06 ? { state: "unobtained", reason: "invalid_output" } : x < 0.2 ? { state: "fail", verdict: "not_meets" } : { state: "pass", verdict: "meets" };
        row.l3 = row.ev.l3.state;
        if (row.l3 === "fail") { row.final = "fail"; row.stop = 3; return; }
        if (row.l3 === "unobtained") { row.final = "unobtained"; row.stop = 3; row.reason = "invalid_output"; return; }
      }
      row.final = "pass";
    });
    rows.push(...mine);
  });
  return rows;
}

/* D 的 evaluateMethod(at_least_n)：P ≥ N 成功；P + U < N 不达标；其余未获取成功 */
function atLeastN({ p, u }, n) {
  if (p >= n) return "success";
  if (p + u < n) return "not_met";
  return "unobtained";
}
function zeroContent(acc) { return acc.zero === "complete" ? { result: "not_met" } : { result: "unobtained", reason: acc.syncGapReason ?? "sync_gap" }; }

function abilityOutcomes(exec, acc, rows, accRand) {
  const conds = exec.conditions;
  const N = exec.n ?? 1;
  const out = {};
  const count = (c) => {
    let p = 0, u = 0, f = 0;
    rows.forEach((row) => {
      const e = c.layer === 1 ? row.ev.l1.find((x) => x.idx === Number(c.key.split(".")[1])) : c.layer === 2 ? row.ev.l2.find((x) => x.id === c.key) : c.layer === 3 ? row.ev.l3 : null;
      const s = e?.state;
      if (s === "pass") p++; else if (s === "fail") f++; else if (s === "unobtained") u++;
      else if (s === undefined && row.final === "unobtained") u++; // 没评估到、但最终未获取成功：计 U（EL-6 第 2 条）
    });
    return { p, u, f };
  };
  conds.forEach((c) => {
    if (c.subject === "account") {
      const x = accRand();
      out[c.key] = x < 0.84 ? { result: "success" } : x < 0.94 ? { result: "not_met" } : { result: "unobtained", reason: "no_profile_snapshot" };
      return;
    }
    if (c.layer === "comment") return; // 稍后用评论结果
    const k = count(c);
    if (c.layer === 1) {
      out[c.key] = rows.length === 0 ? zeroContent(acc) : { result: atLeastN(k, N) };
    } else {
      out[c.key] = k.p + k.u + k.f === 0 ? { result: "skipped" } : { result: atLeastN(k, N) };
    }
  });
  return out;
}

function build(exec) {
  const accounts = buildAccounts(exec.accounts, exec.seed);
  const rows = genRows(exec, accounts);
  const hasContent = exec.conditions.some((c) => c.layer !== "comment" && c.subject === "content");
  const hasComment = exec.conditions.some((c) => c.layer === "comment");
  const hasAccount = exec.conditions.some((c) => c.subject === "account");
  const accRand = rng(exec.seed * 7);
  const accs = accounts.map((acc) => {
    const mine = rows.filter((x) => x.accountId === acc.accountId);
    const abil = abilityOutcomes(exec, acc, mine, accRand);
    const counts = { p: mine.filter((x) => x.final === "pass").length, u: mine.filter((x) => x.final === "unobtained").length, f: mine.filter((x) => x.final === "fail").length };
    const content = hasContent ? (mine.length === 0 ? zeroContent(acc).result : atLeastN(counts, exec.n ?? 1)) : null;
    let comment = null;
    if (hasComment) {
      const cands = mine.filter((x) => x.cm);
      const candUnob = mine.some((x) => x.final === "unobtained" && x.stop <= 2);
      if (!cands.length) comment = candUnob ? "unobtained" : mine.length === 0 ? zeroContent(acc).result : "not_met";
      else comment = atLeastN({ p: cands.reduce((s, x) => s + x.cm.pass, 0), u: 0 }, 2); // 评论要求：命中评论数合计 ≥ 2（原型取 at_least_n 2）
      abil.comment = { result: comment };
    }
    let account = null;
    if (hasAccount) {
      const rs = exec.conditions.filter((c) => c.subject === "account").map((c) => abil[c.key].result);
      account = rs.includes("not_met") ? "not_met" : rs.includes("unobtained") ? "unobtained" : "success";
    }
    const parts = [content, comment, account].filter(Boolean);
    const plan = parts.includes("not_met") ? "not_met" : parts.includes("unobtained") ? "unobtained" : "success";
    return { ...acc, abil, plan, content, rowsCount: mine.length };
  });
  return { accounts: accs, rows };
}
const CACHE = new Map();
function dataOf(exec) {
  if (!CACHE.has(exec.id)) CACHE.set(exec.id, build(exec));
  return CACHE.get(exec.id);
}

/* ---------- 列头（EL-4：别名 → 默认名 → 重名加序号 → 撞固定列加「（能力）」；在全集上算） ---------- */
const TARGET = { cover: "封面", avatar: "头像", background: "主页背景" };
function baseName(c) {
  if (c.alias) return c.alias;
  switch (c.kind) {
    case "text": return "文本关键词";
    case "hashtags": return "话题";
    case "duration": return "时长";
    case "whole_image": return `整图对比·${TARGET[c.target]}`;
    case "image_element": return `元素对比·${TARGET[c.target]}`;
    case "asr": return "语音判定";
    default: return "评论要求";
  }
}
const videoFixed = (p) => ["品牌", "大区", "分公司", "板块", "经销商名称", "门店名称", "门店编码", "专员姓名", "平台", `${p}昵称`, "主页链接", "类型(视频/图文)", "视频/图文标题", "发布时间", "视频/图文链接", "视频/图文唯一ID", "点赞", "评论", "分享", "收藏", "采集时间"];
const accountFixed = (p) => ["品牌", "大区", "分公司", "板块", "经销商名称", "门店名称", "门店编码", "专员姓名", "平台", `${p}昵称`, "主页链接", "粉丝数", "总获赞", "平台作品数", "已采集视频数", "主页是否采集成功", "主页采集时间", "视频列表是否采集成功", "视频列表采集时间"];
export function conditionHeaders(conds, platform) {
  const fixed = [...new Set([...videoFixed(platform), ...accountFixed(platform), "判定结果"])];
  const names = conds.map(baseName);
  const total = {};
  names.forEach((n) => { total[n] = (total[n] ?? 0) + 1; });
  const seen = {};
  return Object.fromEntries(conds.map((c, i) => {
    let n = names[i];
    if (total[n] > 1) { seen[n] = (seen[n] ?? 0) + 1; n = `${n} #${seen[n]}`; }
    if (fixed.includes(n)) n = `${n}（能力）`;
    return [c.key, n];
  }));
}

/* ---------- 单元格（EL-4 / EL-5） ---------- */
const t = (text, tone = "plain") => ({ text, tone });
function contentCell(c, row, exec) {
  if (c.layer === "comment") {
    if (row.cm) return t(`命中 ${row.cm.pass} / 共 ${row.cm.total} 条`);
    return reasonOrSkipped(row, "comment");
  }
  let e = null;
  if (c.layer === 1) e = row.ev.l1.find((x) => x.idx === Number(c.key.split(".")[1]));
  else if (c.layer === 2) e = row.ev.l2.find((x) => x.id === c.key);
  else if (c.layer === 3) e = row.ev.l3;
  if (!e) return reasonOrSkipped(row, c.layer);
  if (e.state === "unobtained") return t(e.reason ?? row.reason ?? "unknown", "unob");
  const tone = e.state === "pass" ? "pass" : "fail";
  if (c.kind === "text" || c.kind === "hashtags") return t(e.hit?.length ? e.hit.join("、") : "未命中", tone);
  if (c.kind === "duration") return t(`${e.seconds} 秒`, tone);
  if (c.kind === "asr") return t(e.verdict === "meets" ? "达标" : "不达标", tone);
  return t(e.score, tone);
}
// 没评估到：更早的层是「获取失败」→ 原因码；否则 → 前置条件未满足
function reasonOrSkipped(row, layer) {
  const L = layer === "comment" ? 2.5 : layer;
  if (row.final === "unobtained" && row.stop !== null && row.stop < L) return t(row.reason ?? "unknown", "unob");
  return t(SKIPPED, "skip");
}
const OUT = { success: ["通过", "pass"], not_met: ["不通过", "fail"], unobtained: ["获取失败", "unob"], skipped: [SKIPPED, "skip"] };
function accountCell(c, acc, available) {
  if (!available) return t("", "plain");
  const r = acc.abil[c.key];
  if (!r) return t("", "plain");
  const [text, tone] = OUT[r.result];
  return t(r.result === "unobtained" && r.reason ? `${text}：${r.reason}` : text, tone);
}
const valueCell = (v, digits) => (v.state === "value" ? t(digits ? num(v.v) : String(v.v)) : v.state === "invalid" ? t("无效", "unob") : t(""));

/* ---------- 范围与筛选 ---------- */
function inScope(x) {
  if (state.role === "branch_manager") return x.branch === "北京分公司";
  if (state.role === "store_staff") return x.staff === "张三";
  return true;
}
const f = () => state.el;
function matches(x) {
  const e = f();
  if (e.region !== "all" && x.region !== e.region) return false;
  if (e.branch !== "all" && x.branch !== e.branch) return false;
  if (e.sector !== "all" && x.sector !== e.sector) return false;
  if (e.store !== "all" && x.storeKey !== e.store) return false;
  if (e.q && !(x.staff.includes(e.q) || x.storeCode.toLowerCase().includes(e.q.toLowerCase()))) return false;
  return true;
}

/* ---------- 缩略图 ---------- */
const GRAD = ["#c9485b,#7a2a4a", "#5b86a8,#2c4a63", "#d09a4a,#7a5224", "#4f9a8a,#244f48", "#8a6fb5,#443068", "#6e7f95,#2f3b4b", "#c76f5a,#6e3427", "#5aa56b,#2a5a36"];
function thumb(kind, seed, label) {
  if (seed === null || seed === undefined) return `<span class="el-thumb el-thumb-${kind} is-empty" title="${esc(label)}：暂无图片">${icon("file")}</span>`;
  return `<button type="button" class="el-thumb el-thumb-${kind}" style="background:linear-gradient(135deg,${GRAD[seed % GRAD.length]})" data-action="el-zoom" data-kind="${kind}" data-seed="${seed}" aria-label="放大查看${esc(label)}"></button>`;
}
export function zoomHtml(kind, seed) {
  const name = { cover: "封面", avatar: "头像", background: "主页背景" }[kind];
  const shape = kind === "avatar" ? "width:240px;height:240px;border-radius:50%" : kind === "background" ? "width:100%;height:200px;border-radius:12px" : "width:240px;height:360px;border-radius:12px";
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:10px"><div style="${shape};background:linear-gradient(135deg,${GRAD[Number(seed) % GRAD.length]})"></div><p class="page-sub">${esc(name)}（原型：占位色块；正式页面是签名链接的缩略图放大，不暴露桶名与对象路径）</p></div>`;
}

/* ---------- 页面 ---------- */
const planOf = (id) => PLANS[id];
const latestOf = (plan) => plan.executions[0] ?? null;

function select(key, label, options, current, disabled = false) {
  return `<label class="filter-select ${disabled ? "is-disabled" : ""}"><span>${esc(label)}</span>
    <select data-el-select="${key}" ${disabled ? "disabled" : ""} aria-label="${esc(label)}">${options.map(([v, l]) => `<option value="${esc(v)}" ${current === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
}

function filterBar(exec) {
  const e = f();
  const { accounts } = dataOf(exec);
  const scoped = accounts.filter(inScope);
  const regions = [...new Set(scoped.map((a) => a.region))];
  const branches = [...new Set(scoped.filter((a) => e.region === "all" || a.region === e.region).map((a) => a.branch))];
  const sectors = [...new Set(scoped.map((a) => a.sector))];
  const stores = scoped.filter((a) => (e.region === "all" || a.region === e.region) && (e.branch === "all" || a.branch === e.branch) && (e.sector === "all" || a.sector === e.sector));
  const own = state.role === "store_staff";
  return `
    <section class="filter-card ${state.filtersOpen ? "open" : ""}" aria-label="筛选">
      <div class="filter-line el-selects">
        ${select("region", "大区", [["all", "全部大区"], ...regions.map((x) => [x, x])], e.region, own)}
        ${select("branch", "分公司", [["all", "全部分公司"], ...branches.map((x) => [x, x])], e.branch, own || branches.length <= 1 && state.role === "branch_manager")}
        ${select("sector", "板块", [["all", "全部板块"], ...sectors.map((x) => [x, x])], e.sector, own)}
        ${select("store", "门店", [["all", "全部门店"], ...stores.map((x) => [x.storeKey, x.store])], e.store, own)}
        <form class="el-search" data-form="el-search" role="search">
          <label class="top-search" style="min-width:220px">${icon("search")}<input type="search" name="q" value="${esc(e.q)}" placeholder="专员姓名 / 门店编码" aria-label="搜索专员" ${own ? "disabled" : ""}/></label>
          <button class="btn btn-sm" type="submit" ${own ? "disabled" : ""}>搜索</button>
        </form>
        <button type="button" class="btn btn-sm" data-action="el-reset">重置</button>
      </div>
      ${own ? `<p class="filter-note" style="margin:8px 0 0">门店专员只能看到本人名下的账号与内容，筛选不可用。</p>` : ""}
    </section>`;
}

function metaBand(plan, exec, shown, total) {
  const runs = plan.executions;
  const tabIsVideos = f().tab === "videos";
  return `
    <section class="summary-band el-meta" aria-label="执行信息">
      <div>
        <div class="summary-title">${esc(plan.alias)} · v${exec.version}</div>
        <div class="summary-sub">窗口 ${esc(exec.from)} ～ ${esc(exec.to)}（北京日期）· 数据截止 ${esc(exec.cutoffAt)} · 平台 ${esc(plan.platform)} · ${exec.contentsPruned && tabIsVideos ? "视频明细已过保留期" : `范围内 ${num(shown)}${shown !== total ? ` / 全部 ${num(total)}` : ""} 行`}</div>
      </div>
      <label class="filter-select"><span>执行</span>
        <select data-el-run aria-label="选择执行">${runs.map((x, i) => `<option value="${x.id}" ${x.id === exec.id ? "selected" : ""}>${esc(x.completedAt)} 完成 · v${x.version}${i === 0 ? "（最近）" : ""}</option>`).join("")}</select>
      </label>
    </section>`;
}

function banners(exec, tab, missing) {
  const out = [];
  if (tab === "accounts" && !exec.abilityResultsAvailable) out.push(`<div class="callout warn">${icon("alert")}<span>该执行早于「账号能力结果」功能，能力列不可用；重新执行后可见。判定结果与其余列照常显示。</span></div>`);
  if (tab === "videos" && exec.contentsPruned) out.push(`<div class="callout">${icon("clock")}<span>这次执行的内容明细已过保留期，视频明细不再提供；账号维度仍完整可用。</span></div>`);
  if (missing > 0) out.push(`<div class="callout">${icon("alert")}<span>${missing} 行有缺失数据（如互动值或粉丝数读不到），已留空，没有当作 0。</span></div>`);
  return out.length ? `<div class="el-banners">${out.join("")}</div>` : "";
}

const scrollHint = (abilityCount) => `<p class="filter-note el-hint">表格可左右滚动；青色表头的 ${abilityCount} 列是按判定计划设定生成的能力列。 <button type="button" class="btn btn-sm" data-action="el-scroll-ability">跳到能力列 ›</button></p>`;
function pager(total, page) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(page, pages);
  const btn = (label, target, disabled) => `<button type="button" class="btn btn-sm" data-action="el-page" data-page="${target}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`;
  return `<div class="pager" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px"><span class="filter-note">共 ${num(total)} 行 · 第 ${p} / ${pages} 页 · 每页 ${PAGE_SIZE} 行</span>${btn("‹ 上一页", p - 1, p <= 1)}${btn("下一页 ›", p + 1, p >= pages)}</div>`;
}

function td(cell, extra = "") {
  const cls = { pass: "t-pass", fail: "t-fail", unob: "t-unob", skip: "t-skip", plain: "" }[cell.tone];
  return `<td class="${cls} ${extra}" title="${esc(cell.text)}">${esc(cell.text) || '<span class="t-skip">—</span>'}</td>`;
}
const plainTd = (text, extra = "") => `<td class="${extra}" title="${esc(text)}">${esc(text)}</td>`;
const link = (url) => (url ? `<a class="el-link" href="${esc(url)}" target="_blank" rel="noreferrer" data-action="el-ext">${icon("external")}</a>` : "");

function videosTable(plan, exec) {
  const data = dataOf(exec);
  const accById = Object.fromEntries(data.accounts.map((a) => [a.accountId, a]));
  const all = data.rows.filter((r) => inScope(accById[r.accountId]));
  const rows = all.filter((r) => matches(accById[r.accountId]));
  if (!rows.length) return emptyState({ title: "没有符合条件的行", text: "换个筛选条件，或点「重置」。", action: '<button type="button" class="btn" data-action="el-reset">重置</button>' });
  const page = Math.min(f().page, Math.ceil(rows.length / PAGE_SIZE));
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const heads = conditionHeaders(exec.conditions, plan.platform);
  const conds = exec.conditions.filter((c) => c.subject === "content");
  const fixed = videoFixed(plan.platform);
  const body = slice.map((row) => {
    const a = accById[row.accountId];
    const cells = conds.map((c) => td(contentCell(c, row, exec), "el-ability"));
    return `<tr>
      <td class="el-fixed-l">${thumb("cover", row.cover, "封面")}</td>
      ${plainTd(a.brand)}${plainTd(a.region)}${plainTd(a.branch)}${plainTd(a.sector)}${plainTd(a.dealer)}${plainTd(a.store)}${plainTd(a.storeCode, "num")}${plainTd(a.staff)}${plainTd(plan.platform)}
      ${plainTd(a.nickname)}<td>${link(a.homeUrl)}</td>${plainTd(row.kindLabel)}${plainTd(row.title, "el-title")}${plainTd(row.publishedAt, "num")}<td>${link(row.url)}</td>
      <td class="num el-id" title="${esc(row.contentId)}">${esc(row.contentId)}</td>
      ${td(valueCell(row.like, true), "num")}${td(valueCell(row.comment, true), "num")}${td(valueCell(row.share, true), "num")}${td(valueCell(row.collect, true), "num")}${plainTd(row.snapshotAt, "num")}
      ${cells.join("")}
    </tr>`;
  }).join("");
  return `
    ${scrollHint(conds.length)}
    <div class="el-scroll"><table class="el-table">
      <thead><tr><th class="el-fixed-l">封面</th>${fixed.map((h) => `<th>${esc(h)}</th>`).join("")}${conds.map((c) => `<th class="is-ability" title="${esc(abilityTip(c))}">${esc(heads[c.key])}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(rows.length, page)}`;
}
const abilityTip = (c) => `${{ 1: "第 1 层", 2: "第 2 层", 3: "第 3 层", comment: "评论要求" }[c.layer]}${c.alias ? "（别名）" : "（默认名）"}`;

function accountsTable(plan, exec) {
  const data = dataOf(exec);
  const all = data.accounts.filter(inScope);
  const rows = all.filter(matches);
  if (!rows.length) return emptyState({ title: "没有符合条件的行", text: "换个筛选条件，或点「重置」。", action: '<button type="button" class="btn" data-action="el-reset">重置</button>' });
  const page = Math.min(f().page, Math.ceil(rows.length / PAGE_SIZE));
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const heads = conditionHeaders(exec.conditions, plan.platform);
  const conds = exec.conditions;
  const fixed = accountFixed(plan.platform);
  const body = slice.map((a) => `<tr>
      <td class="el-fixed-l">${thumb("avatar", a.avatar, "头像")}</td><td>${thumb("background", a.background, "主页背景")}</td>
      ${plainTd(a.brand)}${plainTd(a.region)}${plainTd(a.branch)}${plainTd(a.sector)}${plainTd(a.dealer)}${plainTd(a.store)}${plainTd(a.storeCode, "num")}${plainTd(a.staff)}${plainTd(plan.platform)}
      ${plainTd(a.nickname)}<td>${link(a.homeUrl)}</td>
      ${td(valueCell(a.followers, true), "num")}${td(valueCell(a.likesTotal, true), "num")}${plainTd(num(a.posts), "num")}${plainTd(num(a.collected), "num")}
      ${plainTd(a.profileSync.ok, a.profileSync.ok === "否" ? "t-fail" : a.profileSync.ok === "无记录" ? "t-unob" : "")}${plainTd(a.profileSync.at, "num")}
      ${plainTd(a.listSync.ok, a.listSync.ok === "否" ? "t-fail" : a.listSync.ok === "无记录" ? "t-unob" : "")}${plainTd(a.listSync.at, "num")}
      ${conds.map((c) => td(accountCell(c, a, exec.abilityResultsAvailable), "el-ability")).join("")}
      ${(() => { const [text, tone] = { success: ["通过", "pass"], not_met: ["不通过", "fail"], unobtained: ["获取失败", "unob"] }[a.plan]; return td(t(text, tone), "el-result"); })()}
    </tr>`).join("");
  return `
    ${scrollHint(conds.length)}
    <div class="el-scroll"><table class="el-table">
      <thead><tr><th class="el-fixed-l">头像</th><th>主页背景</th>${fixed.map((h) => `<th>${esc(h)}</th>`).join("")}${conds.map((c) => `<th class="is-ability" title="${esc(abilityTip(c))}">${esc(heads[c.key])}</th>`).join("")}<th class="is-result">判定结果</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(rows.length, page)}`;
}

export function exportInfo(plan, exec) {
  const data = dataOf(exec);
  const accById = Object.fromEntries(data.accounts.map((a) => [a.accountId, a]));
  const vids = data.rows.filter((r) => inScope(accById[r.accountId]) && matches(accById[r.accountId])).length;
  const accs = data.accounts.filter((a) => inScope(a) && matches(a)).length;
  const bigVideos = state.el.big ? 62000 : vids;
  const date = exec.completedAt.slice(0, 10);
  return { vids: exec.contentsPruned ? 0 : bigVideos, accs, file: `${plan.activity}-${plan.alias}-${date}-全量明细.xlsx`, tooBig: !exec.contentsPruned && bigVideos > 50000 };
}

export function exportModalHtml(planId, execId) {
  const plan = planOf(planId);
  const exec = plan.executions.find((x) => x.id === execId);
  const info = exportInfo(plan, exec);
  const heads = conditionHeaders(exec.conditions, plan.platform);
  const vh = [...videoFixed(plan.platform), ...exec.conditions.filter((c) => c.subject === "content").map((c) => heads[c.key])];
  const ah = [...accountFixed(plan.platform), ...exec.conditions.map((c) => heads[c.key]), "判定结果"];
  const chips = (list, fixedCount) => `<div class="el-headlist">${list.map((h, i) => `<span class="chip ${i >= fixedCount ? "active" : ""}">${esc(h)}</span>`).join("")}</div>`;
  const notes = [];
  if (exec.contentsPruned) notes.push("视频明细 sheet 不生成：这次执行的内容明细已过保留期。");
  if (!exec.abilityResultsAvailable) notes.push("账号能力列为空：该执行早于「账号能力结果」功能。");
  const err = info.tooBig ? `<div class="callout danger">${icon("alert")}<span>视频明细 ${num(info.vids)} 行，超过 50,000 行上限（export_row_limit）。请先用筛选缩小范围，不会生成任何文件。</span></div>` : "";
  return `
    ${err}
    <p class="page-sub">导出当前执行与<b>当前筛选</b>下的全部行；一个文件、两个 sheet；<b>不含图片</b>。文件名：<code>${esc(info.file)}</code></p>
    ${notes.map((n) => `<div class="callout warn" style="margin-top:8px">${icon("alert")}<span>${esc(n)}</span></div>`).join("")}
    <h4 class="el-h">sheet 1 · 视频明细 · ${exec.contentsPruned ? "不生成" : `${num(info.vids)} 行`}</h4>
    ${exec.contentsPruned ? "" : chips(vh, videoFixed(plan.platform).length)}
    <h4 class="el-h">sheet 2 · 账号维度 · ${num(info.accs)} 行</h4>
    ${chips(ah, accountFixed(plan.platform).length)}
    <p class="filter-note" style="margin-top:10px">高亮的是按判定计划设定生成的能力列。内容 ID、门店编码写成文本；时间为北京时间；以 = + - @ 开头的文本自动加前缀。</p>`;
}

export function renderLite(planId, runId) {
  const plan = planOf(planId);
  const e = f();
  const wantTab = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab"); // 深链接：#/reports/jp1?tab=accounts
  if (wantTab === "videos" || wantTab === "accounts") e.tab = wantTab;
  if (!plan) return renderShell({ activeNav: activeNav(), breadcrumb: ["工作区", "全量明细"], content: deniedState("找不到这个判定计划，或它不在你的数据范围内。") });
  if (e.planKey !== `${planId}/${runId ?? ""}`) { e.planKey = `${planId}/${runId ?? ""}`; Object.assign(e, { page: 1, region: "all", branch: "all", sector: "all", store: "all", q: "" }); }
  const exec = plan.executions.find((x) => x.id === (runId ?? latestOf(plan)?.id)) ?? latestOf(plan);
  const canExport = state.role !== "store_staff";
  const head = (disabledReason) => `
    <div class="page-head">
      <div><h1 class="page-title">全量明细</h1><p class="page-sub">${esc(plan.alias)}：一次已完成执行里的全部视频与账号，判定计划里设了什么条件就多什么列。</p></div>
      <div class="page-actions">
        ${canExport ? `<a class="btn" href="#/judgement">${icon("arrowLeft")} 返回判定计划</a>` : ""}
        ${canExport ? `<button type="button" class="btn btn-primary" data-action="el-export" ${disabledReason ? `disabled title="${esc(disabledReason)}"` : ""}>${icon("download")} 导出 Excel</button>` : ""}
      </div>
    </div>`;
  if (!exec) {
    return renderShell({
      activeNav: activeNav(), breadcrumb: ["工作区", "全量明细"],
      content: `${head("还没有完成的执行")}${stateAware(emptyState({ title: "还没有完成的执行", text: "这个判定计划还没有一次已完成的执行，所以没有可展示的明细，也不能导出。", action: '<a class="btn" href="#/judgement">去判定计划</a>' }))}`,
    });
  }
  const data = dataOf(exec);
  const accById = Object.fromEntries(data.accounts.map((a) => [a.accountId, a]));
  const scopedRows = data.rows.filter((r) => inScope(accById[r.accountId]));
  const scopedAccs = data.accounts.filter(inScope);
  const tab = e.tab;
  const shown = tab === "videos" ? scopedRows.filter((r) => matches(accById[r.accountId])).length : scopedAccs.filter(matches).length;
  const total = tab === "videos" ? scopedRows.length : scopedAccs.length;
  const missing = tab === "videos" && exec.contentsPruned ? 0 : tab === "videos" ? scopedRows.filter((r) => r.comment.state !== "value" || r.collect.state !== "value").length : scopedAccs.filter((a) => a.followers.state !== "value").length;
  const tabBtn = (key, label, n) => `<button type="button" class="chip ${tab === key ? "active" : ""}" data-action="el-tab" data-tab="${key}">${esc(label)} · ${num(n)}</button>`;
  const inner = `
    ${metaBand(plan, exec, shown, total)}
    ${banners(exec, tab, missing)}
    <div class="md-tabs el-tabs" role="tablist">${tabBtn("videos", "视频明细", exec.contentsPruned ? 0 : scopedRows.length)}${tabBtn("accounts", "账号维度", scopedAccs.length)}</div>
    ${tab === "videos" && exec.contentsPruned ? "" : filterToggle(0)}
    ${tab === "videos" && exec.contentsPruned ? emptyState({ title: "内容明细已过保留期", text: "视频明细只保留最近几次执行；账号维度仍可查看。", action: '<button type="button" class="btn" data-action="el-tab" data-tab="accounts">看账号维度</button>' }) : `${filterBar(exec)}${tab === "videos" ? videosTable(plan, exec) : accountsTable(plan, exec)}`}`;
  return renderShell({ activeNav: activeNav(), breadcrumb: ["工作区", "全量明细"], content: `${head("")}${stateAware(inner)}` });
}
const activeNav = () => (state.role === "store_staff" ? "elreports" : "judgement");

/* ---------- 判定计划入口示意（D 已实现的页面，这里只示意新增的「全量明细」按钮） ---------- */
export function renderJudgementEntry() {
  const plans = Object.values(PLANS);
  const rows = plans.map((p) => {
    const l = latestOf(p);
    return `<tr>
      <td>${esc(p.alias)}</td><td>${esc(p.platform)}</td><td>${l ? `${esc(l.completedAt)} · v${l.version}` : "—"}</td>
      <td>${l ? badge("已完成", "green") : badge("没有已完成的执行", "gray")}</td>
      <td class="right"><a class="btn btn-sm" href="#/reports/${p.id}">${icon("chart")} 全量明细</a></td></tr>`;
  }).join("");
  const execRows = PLANS.jp1.executions.map((x, i) => `<tr><td class="num">${esc(x.completedAt)}</td><td>v${x.version}${i === 0 ? "（最近）" : ""}</td><td>${num(dataOf(x).accounts.length)} 位专员</td>
    <td class="right"><a class="btn btn-sm" href="#/reports/jp1/${x.id}">${icon("chart")} 全量明细</a></td></tr>`).join("");
  const content = `
    <div class="page-head"><div><h1 class="page-title">判定计划</h1><p class="page-sub">这是 d-rule-engine 已实现页面的入口示意：只新增「全量明细」按钮，其余不动。</p></div></div>
    <div class="callout">${icon("alert")}<span>原型说明：本页不是 e-metrics-lite 的页面。D 现有的 <code>/judgement/results/[runId]</code> 占位页会改为跳转到全量明细。</span></div>
    <div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>判定计划</th><th>平台</th><th>最近一次完成</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3 class="card-title" style="margin:22px 0 10px">执行记录 · ${esc(PLANS.jp1.alias)}</h3>
    <div class="table-wrap"><table><thead><tr><th>完成时间</th><th>版本</th><th>参与</th><th></th></tr></thead><tbody>${execRows}</tbody></table></div>`;
  return renderShell({ activeNav: "judgement", breadcrumb: ["工作区", "判定计划"], content });
}
