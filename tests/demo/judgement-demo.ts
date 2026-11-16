// 判定计划页面的本机演示环境（仅本机，不进 CI、不进生产镜像）。
//
//   1. 起一个一次性本机 MySQL 容器并迁移：scripts/demo-judgement.sh 做了这两步，然后运行本文件
//   2. 本文件（Next 用 dev 模式：生产模式要求 https 与真实短信）：清库 → 造数（用户 / 组织 / 名单 / 内容 / 多个处于不同阶段的判定计划与执行）→ 在同一进程里启动 Next
//
// 与生产的差别（演示用，不要当成验收）：
//   - 对 C 的端口用测试用的 FakeSignals（程序化的分数），没有任何真实采集、识别、付费调用；
//   - 「judgement serve」由本进程里的一个小循环代替，推进排队中的试跑与执行；
//   - 页面进程拿到的 judgement 单例是预先放进 globalThis 的（与 src/app/_lib/judgement.ts 同一把钥匙）。
// 登录：手机号见下方 USERS，密码 PASSWORD。
import { createServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { createDb, createPool } from "../../src/db/client";
import { activityPlans, judgementPlanVersions, judgementRuns } from "../../src/db/schema";
import { accessEnv, insertAccessUser, PASSWORD } from "../harness/access";
import { resetData } from "../harness/db";
import { addContent, addListTask, addParticipant, judgementEnv, judgementWorld, type JudgementEnv, type JudgementWorld } from "../harness/judgement";

const url = process.env.HBECHO_DEMO_DATABASE_URL;
if (!url) throw new Error("缺少 HBECHO_DEMO_DATABASE_URL（见 scripts/demo-judgement.sh）");
const port = Number(process.env.PORT ?? 3411);
Object.assign(process.env, {
  HBECHO_DATABASE_URL: url,
  HBECHO_AUTH_SECRET: "demo-secret-demo-secret-demo-secret-0123456789",
  HBECHO_PUBLIC_ORIGIN: `http://localhost:${port}`,
  HBECHO_SMS_MODE: "fake",
  HBECHO_SMS_DAILY_CAP: "1000",
  HBECHO_AUTH_RATE_LIMIT_PER_MIN: "100000",
  NODE_ENV: "development", // 演示用假短信 + http；生产配置会拒绝这两者
});

const pool = createPool(url);
const db = createDb(pool);
const t = { db, pool };
await resetData(pool);

// ---- 组织、名单、用户 ----------------------------------------------------------------------------------------
const w = await judgementWorld(t); // 活动计划由 user:7 创建（rosterWorld 的约定）
const aenv = accessEnv(t);
const USERS = {
  admin: { phone: "13900000001", name: "管理员（超管）" },
  creator: { phone: "13900000007", name: "刘总部（总部·创建者）" },
  other: { phone: "13900000008", name: "周总部（总部·非创建者）" },
  branch: { phone: "13900000009", name: "孙分公司（分公司）" },
} as const;
await insertAccessUser(aenv, { role: "platform_admin", ...USERS.admin });
await pool.query("ALTER TABLE auth_users AUTO_INCREMENT = 7"); // 创建者的 ID = 7，与 judgementEnv 的 user:7 一致
await insertAccessUser(aenv, { role: "hq_manager", ...USERS.creator, brandIds: [w.org.hitachiBrandId] });
await insertAccessUser(aenv, { role: "hq_manager", ...USERS.other, brandIds: [w.org.hitachiBrandId] });
await insertAccessUser(aenv, { role: "branch_manager", ...USERS.branch, brandIds: [w.org.hitachiBrandId], branchIds: [w.bj] });
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
void judgementPlanVersions;
void and;

// ---- 页面进程用的 judgement 单例 + 代替 `judgement serve` 的试跑循环 ----------------------------------------------
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("hbecho.judgement.web")] = { views: e.views, versions: e.versions, runs: e.runs, outcomes: e.outcomes, plans: e.plans, facts: e.facts, authz: e.authz };
// 演示用 FakeClock：页面上的圈定 / 试跑用真实休眠等下一个 tick，所以时钟要随真实时间前进（生产用真实时钟）
setInterval(() => e.clock.advance(1000), 1000).unref();
setInterval(async () => {
  try {
    const rows = await db.select().from(judgementRuns).where(eq(judgementRuns.status, "planned"));
    for (const r of rows) await e.runs.drive(r.runId, "demo-worker", e.sleep);
  } catch (err) {
    console.error("demo worker", err);
  }
}, 2000).unref();

const { default: next } = await import("next");
const app = next({ dev: true, dir: process.cwd(), port, hostname: "localhost" });
await app.prepare();
createServer(app.getRequestHandler()).listen(port, () => {
  process.stdout.write(`\n演示环境已就绪：http://localhost:${port}/login\n密码（所有账号）：${PASSWORD}\n${Object.values(USERS).map((u) => `  ${u.phone}  ${u.name}`).join("\n")}\n`);
});
