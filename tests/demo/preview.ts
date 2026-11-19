// 本机预览环境（4400 完整应用）。仅本机，不进 CI、不进生产镜像。协作规则见 .kiro/steering/ui-workflow.md 与 ui-lab/LOCAL-UI.md。
//
//   scripts/preview.sh 做的事：起一次性本机 MySQL 容器并迁移 → 运行本文件 → 同时提供 4100 的静态原型
//   本文件做的事：清库 → 造数（用户 / 组织 / 门店 / 活动计划与名单 / 内容 / 学习课程 / 多个阶段的判定计划与执行）→ 在同一进程里启动 Next（dev + webpack）
//
// 与 ECS 的差别（预览用，不要当成验收）：
//   - 数据是造出来的，每次启动都重置成同一份（想保留的东西不要放在这里）；
//   - 对 C 的端口用测试用的 FakeSignals（程序化的分数），没有任何真实采集、识别、付费调用；
//   - 短信是假的、http；ECS 是真短信、https 与 capability 门控；
//   - 「judgement serve」由本进程里的一个小循环代替，推进排队中的试跑与执行。
// 页面进程拿到的 judgement 单例是预先放进 globalThis 的（与 src/app/_lib/judgement.ts 同一把钥匙）。
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { createDb, createPool } from "../../src/db/client";
import { activityPlans, authAccounts, brands, courses, courseTags, dealers, judgementRuns, sectors, stores, tagCategories, tags } from "../../src/db/schema";
import { assembleSquare } from "../../src/modules/video-square";
import { accessEnv, insertAccessUser } from "../harness/access";
import { resetData } from "../harness/db";
import { addContent, addListTask, addParticipant, judgementEnv, judgementWorld, type JudgementEnv } from "../harness/judgement";
import { insertAccount, insertAssignment } from "../harness/factories";
import { insertPlan, insertRosterEntry, insertStaff, insertStore, T0 } from "../harness/plan";
import { insertSector } from "../harness/roster";
import { seedSquareAccount, seedSquareWork, type WorkSpec } from "../harness/square";

const url = process.env.HBECHO_PREVIEW_DATABASE_URL;
if (!url) throw new Error("缺少 HBECHO_PREVIEW_DATABASE_URL（请用 scripts/preview.sh 启动）");
const port = Number(process.env.PORT ?? 4400);
const buildSha = (() => {
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() ? "+未提交改动" : "";
    return `${sha}${dirty}`;
  } catch {
    return "unknown";
  }
})();
Object.assign(process.env, {
  HBECHO_DATABASE_URL: url,
  HBECHO_AUTH_SECRET: "preview-secret-preview-secret-preview-secret-0123456789",
  HBECHO_PUBLIC_ORIGIN: `http://localhost:${port}`,
  HBECHO_SMS_MODE: "fake",
  HBECHO_SMS_DAILY_CAP: "1000",
  HBECHO_AUTH_RATE_LIMIT_PER_MIN: "100000",
  HBECHO_BUILD_SHA: buildSha,
  // 学习模块要求配置齐全才能装配；这些是占位值：封面 / 文件链接是本地签名出来的、指向一个不存在的桶，浏览器打不开（列表、标签、筛选可用），服务端不会发起任何 OSS / VOD 请求
  HBECHO_LEARNING_CREDENTIALS: "access_key",
  HBECHO_LEARNING_ACCESS_KEY_ID: "preview-not-real",
  HBECHO_LEARNING_ACCESS_KEY_SECRET: "preview-not-real",
  HBECHO_COURSE_OSS_BUCKET: "preview-no-such-bucket",
  HBECHO_COURSE_OSS_REGION: "cn-beijing",
  NODE_ENV: "development", // 预览用假短信 + http；生产配置会拒绝这两者
});

const pool = createPool(url);
const db = createDb(pool);
const t = { db, pool };
await resetData(pool);

// ---- 组织、名单、用户 ----------------------------------------------------------------------------------------
const w = await judgementWorld(t); // 活动计划由 user:7 创建（rosterWorld 的约定）
const aenv = accessEnv(t);
/** 与旧 3202 的预设账号一致（手机号 / 密码不变），另加一位非创建者的总部人员用来看只读。 */
const PREVIEW_PASSWORD = "Hbecho@2026";
const USERS = {
  admin: { phone: "13800002041", name: "刘学奎" },
  creator: { phone: "13800002042", name: "王敏" },
  branch: { phone: "13800002043", name: "李静" },
  store: { phone: "13800002044", name: "张伟" },
  other: { phone: "13800002045", name: "周总部" },
} as const;
await insertAccessUser(aenv, { role: "platform_admin", ...USERS.admin });
await pool.query("ALTER TABLE auth_users AUTO_INCREMENT = 7"); // 创建者的 ID = 7，与 judgementEnv 的 user:7 一致
await insertAccessUser(aenv, { role: "hq_manager", ...USERS.creator, brandIds: [w.org.hitachiBrandId] });
await insertAccessUser(aenv, { role: "branch_manager", ...USERS.branch, brandIds: [w.org.hitachiBrandId], branchIds: [w.bj] });
await insertAccessUser(aenv, { role: "store_staff", ...USERS.store, mediaStaffId: w.staff.zhang });
await insertAccessUser(aenv, { role: "hq_manager", ...USERS.other, brandIds: [w.org.hitachiBrandId] });
// 统一密码：insertAccessUser 用测试挂具的固定口令，这里换成预览口令
const hash = await (await aenv.auth.$context).password.hash(PREVIEW_PASSWORD);
await db.update(authAccounts).set({ password: hash }).where(eq(authAccounts.providerId, "credential"));
await db.update(activityPlans).set({ planName: "2026 618 品牌焕新活动" }).where(eq(activityPlans.planId, w.planId));

const e: JudgementEnv = judgementEnv(t, w, { config: { blockSize: 200, pollSeconds: 2 } });
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const names = ["老孙", "老周", "老吴", "老郑", "老冯", "老陈", "老褚"];
const people = [{ staffId: w.staff.zhao, accountId: w.accZhao }];
for (const [i, n] of names.entries()) people.push(await addParticipant(t, w, n, `1380002${String(i).padStart(4, "0")}`));
type P = { staffId: bigint; accountId: bigint };
const [zhao, p2, p3, p4, p5, p6, p7, p8] = people as [P, P, P, P, P, P, P, P];

let seq = 0;
async function post(accountId: bigint, o: { like: number; title: string; tags?: string[]; cover?: number; at?: number }): Promise<bigint> {
  const c = await addContent(db, { accountId, platformContentId: `demo-${++seq}`, kind: "video", like: o.like, publishedAt: day(o.at ?? 5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: o.title, normalizerVersion: 1 });
  e.fake.setValue("text.body_normalized", c.contentId, { state: "valid", usable: true, value: o.title, normalizerVersion: 1 });
  e.fake.setValue("text.hashtags", c.contentId, { state: "valid", usable: true, value: o.tags ?? [], normalizerVersion: 1 });
  if (o.cover !== undefined) e.fake.setValue("content.cover_template_score", c.contentId, { state: "valid", usable: true, score: o.cover });
  return c.contentId;
}
const hit = (accountId: bigint, like: number, cover?: number) => post(accountId, { like, title: "海信新品首发，618 大促来了", tags: ["618"], ...(cover === undefined ? {} : { cover }) });
const miss = (accountId: bigint, like: number, cover?: number) => post(accountId, { like, title: "周末探店日常", ...(cover === undefined ? {} : { cover }) });

// 同步：老孙…老褚 都有成功的列表同步；老郑（p5）同步失败；老冯（p6）有缺口
for (const p of [zhao, p2, p3, p4, p7, p8]) await addListTask(db, { accountId: p.accountId, status: "succeeded", at: day(14) });
await addListTask(db, { accountId: p5.accountId, status: "failed", at: day(14) });
await addListTask(db, { accountId: p6.accountId, status: "succeeded_with_gap", at: day(14), gap: true });

// 内容：赵 3 条命中（成功）；孙 1 命中 + 1 未命中（只有 1 条 → 不达标）；周 2 条都没命中；吴没发（同步完整 → 不达标）；
// 郑没发且同步失败（未获取成功）；冯 1 条命中但同步有缺口（不达标，带同步缺口提示）；陈、褚各 2 条命中（成功）
const coverScore = [9.2, 8.4, 7.9, 7.1, 6.8, 6.3, 5.5, 4.2, 3.1, 8.8, 7.6, 6.9, 2.4, 9.6, 5.1, 8.0];
let cs = 0;
const cv = () => coverScore[cs++ % coverScore.length]!;
await hit(zhao.accountId, 120, cv()); await hit(zhao.accountId, 90, cv()); await hit(zhao.accountId, 60, cv()); await miss(zhao.accountId, 10, cv());
await hit(p2.accountId, 80, cv()); await miss(p2.accountId, 30, cv());
await miss(p3.accountId, 50, cv()); await miss(p3.accountId, 20, cv());
await hit(p6.accountId, 70, cv());
await hit(p7.accountId, 66, cv()); await hit(p7.accountId, 40, cv());
await hit(p8.accountId, 58, cv()); await hit(p8.accountId, 33, cv()); await miss(p8.accountId, 12, cv());
void p4; void p5;

const create = async (alias: string, description: string, cfg: unknown) => {
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias, description });
  await e.versions.setConfig(e.creator, planId, cfg);
  return planId;
};
const WINDOW = { from: "2026-11-01", to: "2026-11-30" };
const TEXT_618 = { fields: ["title", "body"], mode: "any", keywords: ["海信", "618"], alias: "主推卖点文本" };

// 1) 已发布并执行完成：成功 / 不达标 / 未获取成功 / 同步缺口 都有
const p1 = await create("618 主推视频考核", "618 主推视频需带活动话题，至少 2 条命中。", {
  window: WINDOW,
  kinds: ["video"],
  layer1: { text: [TEXT_618], hashtags: [{ mode: "any", values: ["618"], alias: "活动话题" }], quantity: { n: 2 } },
});
await e.runs.circle(e.creator, p1, { sleep: e.sleep });
const x1 = await e.runs.execute(e.creator, p1, { key: "demo-1" });
await e.runs.drive(x1.runId, "demo", e.sleep);
// 再重新执行一次，并把它标成失败（展示「失败 + 续跑」）
const x1b = await e.runs.execute(e.creator, p1, { key: "demo-1b" });
await db.update(judgementRuns).set({ status: "failed", activeKey: null, lastErrorCode: "internal_error", phase: "scores", startedAt: e.clock.now() }).where(eq(judgementRuns.runId, x1b.runId));

// 2) 已发布，执行正在等待采集
const p2plan = await create("夏季活动话题考核", "只看话题，等评论采集。", { window: WINDOW, kinds: ["video"], layer1: { text: [], hashtags: [{ mode: "any", values: ["618"] }] } });
await e.runs.circle(e.creator, p2plan, { sleep: e.sleep });
const x2 = await e.runs.execute(e.creator, p2plan, { key: "demo-2" });
await db.update(judgementRuns).set({ status: "waiting", phase: "demand", phaseDetail: { waiting_on: "demand" }, startedAt: e.clock.now(), participantCount: 8, nextTickAt: new Date(e.clock.now().getTime() + 86_400_000) } as never).where(eq(judgementRuns.runId, x2.runId));

// 3) 草稿，第 2 页：已有试跑结果（分布、样例、阈值）
const p3plan = await create("封面与头像规范", "封面与头像要符合品牌视觉规范。", {
  window: WINDOW,
  kinds: ["video"],
  layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] },
  layer2: { abilities: [{ abilityId: "cover1", alias: "封面视觉规范", kind: "whole_image", target: "cover", threshold: "6.50" }] },
});
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
await e.versions.putTemplate(e.creator, p3plan, "cover1", PNG);
await e.runs.circle(e.creator, p3plan, { sleep: e.sleep });
await e.runs.trial(e.creator, p3plan, { wait: true, sleep: e.sleep });

// 4) 草稿，第 3 页：带评论要求，已圈定
const p4plan = await create("评论关键词试点", "评论里要提到安装或售后。", {
  window: WINDOW,
  kinds: ["video"],
  layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 1 } },
  commentRequirement: { mode: "any", keywords: ["安装", "售后"], alias: "安装与售后评论", method: { type: "at_least_n", n: 2 } },
});
await e.runs.circle(e.creator, p4plan, { sleep: e.sleep });

// 5) 草稿，第 1 页：刚创建
await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "新品话题（草稿）", description: "刚创建，还没圈定。" });

// 6) 已归档
const old = await create("去年双十一考核", "已归档，历史可读。", { window: { from: "2025-11-01", to: "2025-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["双十一"] }] } });
await e.plans.archive(e.creator, old);

// ---- 主数据：更多分公司的板块、经销商与门店（让「主数据浏览」有分页、筛选可用）--------------------------------------------
const TIERS = ["一级店中店", "一级直营KA专业A级店", "一级经销商S级店", "二级经销商A级店", null];
const dealerIds: bigint[] = [w.org.dealerId];
for (const [i, name] of ["华北家电经销", "华东智造经销", "华南优品经销", "西南联营经销", "东北恒信经销", "华中盛达经销"].entries()) {
  const [r] = await db.insert(dealers).values({ dealerCode: `D-10${i + 2}`, dealerName: name, status: "active", createdAt: T0, updatedAt: T0 });
  dealerIds.push(BigInt(r.insertId));
}
let storeNo = 0;
for (const code of ["103", "104", "105", "106", "107", "108"]) {
  const branchId = w.org.branchIds.get(code);
  if (branchId === undefined) continue;
  for (const key of ["water", "home"] as const) {
    const sectorId = await insertSector(t, branchId, code, key);
    for (let k = 0; k < 4; k++) {
      storeNo++;
      const brandId = storeNo % 3 === 0 ? w.org.hisenseBrandId : w.org.hitachiBrandId;
      const id = await insertStore(db, { ...w.org, dealerId: dealerIds[storeNo % dealerIds.length]! }, { code: `P-${String(storeNo).padStart(3, "0")}`, name: `${key === "water" ? "水机" : "家装"}体验店 ${storeNo}`, sectorId, brandId });
      await db.update(stores).set({ dealerId: dealerIds[storeNo % dealerIds.length]!, storeTier: TIERS[storeNo % TIERS.length] ?? null }).where(eq(stores.storeId, id));
    }
  }
}

// ---- 活动计划：再来三个不同状态的计划（列表筛选、状态标签、回收站之外的各种形态）----------------------------------------
const plan2 = await insertPlan(db, w.org, { name: "夏季家装内容扶持", status: "collecting", startsOn: "2026-11-01", endsOn: "2026-12-31", sectors: ["home"], createdBy: "user:7", joined: [w.bj, w.sh], now: T0 });
await insertPlan(db, w.org, { name: "春季焕新（已暂停）", status: "paused", startsOn: "2026-03-01", endsOn: "2026-05-31", createdBy: "user:7", joined: [w.bj], now: T0 });
await insertPlan(db, w.org, { name: "去年双十一（已归档）", status: "archived", startsOn: "2025-11-01", endsOn: "2025-11-30", createdBy: "user:7", joined: [w.bj], now: T0 });
for (const [i, who] of ["老蒋", "老沈", "老韩", "老杨"].entries()) {
  const staffId = await insertStaff(db, { storeId: w.stores.sH1, name: who, phone: `1380003${String(i).padStart(4, "0")}` });
  const accountId = await insertAccount(db, "douyin", T0);
  await insertAssignment(db, { accountId, platform: "douyin", staffId, now: T0, locator: `https://www.douyin.com/user/PV${i}` });
  await insertRosterEntry(db, { planId: plan2, accountId, staffId, storeId: w.stores.sH1, branchId: w.bj });
  await addListTask(db, { accountId, status: "succeeded", at: day(14) });
}

// ---- 学习平台：标签与课程（列表、筛选、已下架）-------------------------------------------------------------------------
const tagIds: Record<string, bigint> = {};
const TAG_TREE: Record<string, string[]> = { 平台: ["抖音", "小红书"], 板块: ["水机", "家装"], 阶段: ["入门", "进阶"], 类型: ["话术", "案例"] };
for (const [category, names] of Object.entries(TAG_TREE)) {
  const [c] = await db.insert(tagCategories).values({ name: category, createdAt: T0 });
  for (const name of names) {
    const [r] = await db.insert(tags).values({ categoryId: BigInt(c.insertId), name, createdAt: T0 });
    tagIds[`${category}-${name}`] = BigInt(r.insertId);
  }
}
const COURSES: Array<{ title: string; tags: string[]; status?: string; noDownload?: boolean }> = [
  { title: "抖音短视频开场 3 秒法则", tags: ["平台-抖音", "阶段-入门", "类型-话术"] },
  { title: "水机卖点的 5 种讲法", tags: ["板块-水机", "阶段-入门", "类型-话术"] },
  { title: "小红书种草笔记结构拆解", tags: ["平台-小红书", "阶段-进阶", "类型-案例"] },
  { title: "家装场景短视频拍摄清单", tags: ["板块-家装", "平台-抖音", "阶段-进阶"] },
  { title: "门店直播间话术与节奏", tags: ["平台-抖音", "类型-话术"], noDownload: true },
  { title: "2025 双十一优秀内容复盘", tags: ["类型-案例", "阶段-进阶"], status: "unpublished" },
];
for (const [i, c] of COURSES.entries()) {
  const n = String(i + 1).padStart(12, "0");
  const unpublished = c.status === "unpublished";
  const [r] = await db.insert(courses).values({
    title: c.title,
    kind: "document",
    status: unpublished ? "unpublished" : "published",
    brandScope: "all",
    coverKey: `cover/00000000-0000-0000-0000-${n}.png`,
    fileKey: `doc/00000000-0000-0000-0000-${n}.pdf`,
    fileMime: "application/pdf",
    fileSize: 2048 * (i + 1),
    allowDownload: !c.noDownload,
    createdBy: 1n,
    createdAt: T0,
    updatedAt: T0,
    ...(unpublished ? { unpublishedAt: T0 } : {}),
  });
  await db.insert(courseTags).values(c.tags.map((name) => ({ courseId: BigInt(r.insertId), tagId: tagIds[name]! })));
}
// ---- 视频广场（f-video-square）：四个品牌 × 三个平台的作品，点赞边界与缺链接 / 缺封面各一条 -------------------------------------
// 品牌只有日立、海信时再补约克、科龙；每个品牌在三个分公司各一家店，每家店一位专员、三个平台各一个账号。
const squareBrands: Array<{ id: bigint; name: string }> = [{ id: w.org.hitachiBrandId, name: "日立" }, { id: w.org.hisenseBrandId, name: "海信" }];
for (const [code, name] of [["YORK", "约克VRF"], ["KELON", "科龙"]] as const) {
  const [r] = await db.insert(brands).values({ brandCode: code, brandName: name, status: "active", createdAt: T0, updatedAt: T0 });
  squareBrands.push({ id: BigInt(r.insertId), name });
}
const squareSectors = (await db.select({ id: sectors.sectorId }).from(sectors).orderBy(sectors.sectorId)).slice(0, 3).map((x) => x.id);
const SQ_PLATFORMS = ["douyin", "xiaohongshu", "kuaishou"] as const;
const SQ_SEEDS: Array<[string, number, "video" | "image", number, number, (typeof SQ_PLATFORMS)[number]]> = [
  ["金泽舒适家又获奖啦，心存感激 一份荣誉，一份责任，感谢日立中央空调", 0, "video", 20400, 14, "douyin"],
  ["#日立中央空调郑州分公司#家用中央空调 #全心全意为您服务", 0, "video", 15300, 12, "douyin"],
  ["成都设计师的家 | 中央空调品牌怎么选 不知道怎么选中央空调？来听听", 0, "image", 14100, 12, "xiaohongshu"],
  ["选择这一款智慧空气定制系统，你会回来感谢我。#每一感都超有感", 0, "video", 13200, 108, "douyin"],
  ["天冷了，明装暖气避坑#明装暖气 #新力舒适家 #扬州明装暖气片", 1, "video", 13000, 652, "douyin"],
  ["邻居拆除中间墙，各借了一个冰箱位", 1, "video", 10700, 3, "kuaishou"],
  ["那就祝刷到的都旺～", 3, "video", 7342, 2134, "douyin"],
  ["年会不能停 不愧是义乌最强日立中央空调旗舰店！年年登顶。老板怎么会", 0, "video", 6893, 624, "douyin"],
  ["日立智享～天氟地水两联供～～省钱省到怀疑自己🤪#共建理想家 #地暖", 0, "video", 5863, 12, "xiaohongshu"],
  ["销售日记第二十五天。#真实生活分享计划 #销售日常 不需要怎么办", 2, "video", 5786, 34, "kuaishou"],
  ["三口之家 120 平，约克 VRF 一拖多的实际使用感受", 2, "image", 4210, 96, "xiaohongshu"],
  ["科龙新风空调开箱：安装师傅教你三步检查出风口", 3, "video", 3120, 45, "kuaishou"],
  ["海信日立中央空调联动演示｜一键切换睡眠模式", 1, "video", 2650, 71, "douyin"],
  ["春季换季保养，这三个滤网动作别省", 0, "video", 1780, 23, "douyin"],
  ["客户回访日常：装完一年后的真实反馈", 2, "video", 960, 18, "douyin"],
  ["店面新装修完成，欢迎来店体验", 1, "image", 410, 9, "xiaohongshu"],
  ["冬季取暖方案对比：地暖 vs 暖气片 vs 空气能", 3, "video", 188, 7, "douyin"],
  ["门店晨会二十分钟，今天讲怎么接待咨询客户", 0, "video", 76, 2, "kuaishou"],
];
const sqAccounts = new Map<string, bigint>();
let sqPhone = 0;
for (const [bi, b] of squareBrands.entries()) {
  for (const [si, sectorId] of squareSectors.entries()) {
    const storeId = await insertStore(db, w.org, { code: `SQ-${bi}-${si}`, name: `${b.name}广场样例店 ${si + 1}`, sectorId, brandId: b.id });
    const staffId = await insertStaff(db, { storeId, name: `广场专员${bi}${si}`, phone: `1380004${String(sqPhone++).padStart(4, "0")}` });
    for (const platform of SQ_PLATFORMS) sqAccounts.set(`${bi}-${si}-${platform}`, await seedSquareAccount(db, staffId, { platform, nickname: `${b.name}${["北京", "上海", "广州"][si]}${platform === "douyin" ? "抖音" : platform === "xiaohongshu" ? "小红书" : "快手"}号` }, T0));
  }
}
const sqNow = new Date(Date.UTC(2026, 10, 18, 4));
let sqSeq = 0;
for (const [i, [title, bi, kind, likes, comments, platform]] of SQ_SEEDS.entries()) {
  for (const [k, f] of [1, 0.55, 0.2].entries()) {
    const sqIndex = i * 3 + k;
    const account = sqAccounts.get(`${bi}-${(i + k) % squareSectors.length}-${platform}`)!;
    const spec: WorkSpec = {
      kind,
      title: k === 0 ? title : `${title}${k === 1 ? "（二）" : "（三）"}`,
      like: Math.max(51, Math.round(likes * f)),
      comment: Math.round(comments * f),
      publishedAt: new Date(sqNow.getTime() - [3, 12, 26, 48, 75, 120, 160, 200][sqIndex % 8]! * 86_400_000),
      shareUrl: `https://www.${platform}.example/work/${sqIndex + 1}`,
      cover: sqIndex % 7 !== 6, // 每 7 条有 1 条没有封面（占位图）
    };
    if (sqIndex === 5) spec.shareUrl = null; // 没有原链接：「观看」置灰
    if (sqIndex === 8) spec.comment = null; // 评论缺失：显示 —
    await seedSquareWork(db, account, spec, sqNow, ++sqSeq);
  }
}
// 点赞边界各一条：50（不出现）、51（出现）；已释放名额、外部账号的作品（不出现）
const sqEdge = sqAccounts.get("0-0-douyin")!;
await seedSquareWork(db, sqEdge, { title: "【边界】点赞 50，不应出现", like: 50 }, sqNow, ++sqSeq);
await seedSquareWork(db, sqEdge, { title: "【边界】点赞 51，应出现在最后", like: 51 }, sqNow, ++sqSeq);
await seedSquareWork(db, await seedSquareAccount(db, null, { platform: "kuaishou", nickname: "竞品号" }, sqNow), { title: "【外部账号】不应出现", like: 9999 }, sqNow, ++sqSeq);
// 封面：预览没有 OSS，用一个只在本进程里生成渐变图的签名器代替；页面进程拿到的单例与 src/app/_lib/square.ts 同一把钥匙
const GRADIENTS = [["#c9485b", "#7a2a4a"], ["#5b86a8", "#2c4a63"], ["#d09a4a", "#7a5224"], ["#4f9a8a", "#244f48"], ["#8a6fb5", "#443068"], ["#6e7f95", "#2f3b4b"]] as const;
const fakeCovers = {
  async signedGetUrl(key: string): Promise<string> {
    const [a, b] = GRADIENTS[Number(key.replace(/\D/g, "")) % GRADIENTS.length]!;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  },
};
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("hbecho.square.deps")] = assembleSquare({ db, clock: { now: () => new Date() }, env: process.env, covers: fakeCovers });
void plan2;
// ---- 页面进程用的 judgement 单例 + 代替 `judgement serve` 的试跑循环 ----------------------------------------------
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("hbecho.judgement.web")] = { views: e.views, versions: e.versions, runs: e.runs, outcomes: e.outcomes, plans: e.plans, facts: e.facts, authz: e.authz };
// 预览用 FakeClock：页面上的圈定 / 试跑用真实休眠等下一个 tick，所以时钟要随真实时间前进（生产用真实时钟）
setInterval(() => e.clock.advance(1000), 1000).unref();
setInterval(async () => {
  try {
    const rows = await db.select().from(judgementRuns).where(eq(judgementRuns.status, "planned"));
    for (const r of rows) await e.runs.drive(r.runId, "preview-worker", e.sleep);
  } catch (err) {
    console.error("preview worker", err);
  }
}, 2000).unref();

const { default: next } = await import("next");
// webpack：Turbopack 的 dev 在登录页会反复整页重载（见 ui-lab/LOCAL-UI.md「已知坑」）
const app = next({ dev: true, webpack: true, dir: process.cwd(), port, hostname: "localhost" });
await app.prepare();
createServer(app.getRequestHandler()).listen(port, () => {
  process.stdout.write(
    `\n预览环境已就绪（版本 ${buildSha}）：http://localhost:${port}/login\n密码（所有账号）：${PREVIEW_PASSWORD}\n${Object.values(USERS).map((u) => `  ${u.phone}  ${u.name}`).join("\n")}\n`,
  );
});
