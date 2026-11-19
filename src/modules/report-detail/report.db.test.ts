// 活动计划判定结果（e-metrics-lite）：与 D 的真实实现、真实 MySQL 一起走一遍。
import { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityPlans, auditEvents, contentSnapshots, contents, judgementPlanVersions, judgementRuns, mediaReferences, runParticipants, staffAccountAssignments, syncBatches, syncTasks, ossObjects } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertBatch, insertMediaAsset, insertProfileSnapshot, insertTask } from "../../../tests/harness/factories";
import { addContent, addListTask, addParticipant, judgementEnv, judgementWorld, moveCurrentSnapshot, userCtx, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { createRegistry, type AuthContext } from "../access-control";
import { assembleReport } from "./assemble";
import { isReportError, ReportError, type ReportFilterInput } from "./types";

const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const CFG = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ alias: "品牌词", fields: ["title"], mode: "any", keywords: ["海信"] }], duration: { minSeconds: 10 }, quantity: { n: 2 } } };
const signer = { signedGetUrl: async (key: string, ttl: number) => `https://signed.test/${encodeURIComponent(key)}?ttl=${ttl}` };
const ID19 = "7703376750574989926";
const NOFILTER: ReportFilterInput = {};
const err = async (p: Promise<unknown>): Promise<ReportError | null> => {
  try { await p; } catch (e) { if (isReportError(e)) return e; throw e; }
  return null;
};
async function content(w: JudgementWorld, e: JudgementEnv, id: string, o: { account?: bigint; like?: number } = {}) {
  const c = await addContent(t.db, { accountId: o.account ?? w.accZhao, platformContentId: id, kind: "video", like: o.like ?? 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: "海信新品", normalizerVersion: 1 });
  return c;
}
async function executeOnce(e: JudgementEnv, planId: bigint, key: string) {
  await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
  const r = await e.runs.execute(e.creator, planId, { key });
  await e.runs.drive(r.runId, "w", e.sleep);
  return r.runId;
}
async function build(over: { limits?: { videoRows: number; accountRows: number } } = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "种草判定" });
  await e.versions.setConfig(e.creator, planId, CFG);
  const p2 = await addParticipant(t, w, "老孙", "13800010031");
  for (const a of [w.accZhao, p2.accountId]) await addListTask(t.db, { accountId: a, status: "succeeded", at: day(6) });
  const ca = await content(w, e, ID19, { like: 2 });
  await content(w, e, "b", { like: 1 });
  await content(w, e, "c", { account: p2.accountId });
  const execId = await executeOnce(e, planId, "k1");
  const registry = createRegistry();
  const report = assembleReport({ db: t.db, env: {}, outcomes: e.outcomes, registry, media: signer, clock: e.clock, ...(over.limits ? { limits: over.limits } : {}) });
  const brand = new Set([w.org.hitachiBrandId]);
  const hq = e.creator;
  const bj = userCtx("branch_manager", 31, { brands: brand, branches: new Set([w.bj]), self: { kind: "none" }, level: 2 });
  const sh = userCtx("branch_manager", 32, { brands: brand, branches: new Set([w.sh]), self: { kind: "none" }, level: 2 });
  const zhao = userCtx("store_staff", 41, { brands: brand, branches: new Set([w.bj]), self: { kind: "resolved", mediaStaffId: w.staff.zhao, storeId: w.stores.sW1 }, level: 1 });
  return { w, e, planId, p2, execId, ca, report, hq, bj, sh, zhao, admin: e.admin, registry };
}
async function collectBytes(run: (sink: Writable) => Promise<unknown>) {
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(c, _enc, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const done = new Promise<void>((res, rej) => { sink.on("finish", res); sink.on("error", rej); });
  const r = await run(sink);
  await done;
  return { r, bytes: Buffer.concat(chunks) };
}
const cellText = (v: unknown) => (typeof v === "object" && v !== null && "text" in (v as object) ? (v as { text: string }).text : v);

describe("导航落地页：范围内可见的判定计划", () => {
  it("总部与本分公司的分公司人员看得到；别的分公司看不到；门店专员看得到（只看本人由行范围保证）", async () => {
    const s = await build();
    for (const ctx of [s.hq, s.bj, s.zhao, s.admin]) expect((await s.report.overview(ctx)).map((p) => p.alias)).toEqual(["种草判定"]);
    expect(await s.report.overview(s.sh)).toEqual([]);
  });
  it("带最近一次完成的执行；没有已完成执行的计划也列出（latest = null）", async () => {
    const s = await build();
    const second = await s.e.plans.create(s.e.creator, { activityPlanId: s.w.planId, alias: "另一个计划" });
    const rows = await s.report.overview(s.hq);
    expect(rows.find((r) => r.alias === "种草判定")!.latest).toMatchObject({ executionId: s.execId.toString(), version: 1 });
    expect(rows.find((r) => r.planId === second.planId.toString())!.latest).toBeNull();
  });
  it("回收站里的活动计划不出现；空范围 / 没有 report.read 报 auth", async () => {
    const s = await build();
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000), deletedByActor: "user:7" }).where(eq(activityPlans.planId, s.w.planId));
    expect(await s.report.overview(s.hq)).toEqual([]);
    const empty = userCtx("hq_manager", 50, { brands: new Set(), branches: new Set(), self: { kind: "none" }, level: 2 });
    expect((await err(s.report.overview(empty)))?.kind).toBe("auth");
  });
});

describe("视频明细", () => {
  it("21 个固定列 + 条件列；行数 = D 读口的行数；列头与表头逐字一致；条件列按层序", async () => {
    const s = await build();
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    expect(v.table.columns.map((c) => c.header)).toEqual([
      "品牌", "大区", "分公司", "板块", "经销商名称", "门店名称", "门店编码", "专员姓名", "平台", "抖音昵称", "主页链接", "类型(视频/图文)", "视频/图文标题", "发布时间", "视频/图文链接", "视频/图文唯一ID",
      "点赞", "评论", "分享", "收藏", "采集时间", "品牌词", "时长",
    ]);
    expect(v.table.total).toBe(3);
    expect(v.table.rows).toHaveLength(3);
    expect(v.totals).toEqual({ videos: 3, accounts: 2 });
    expect(v.header).toMatchObject({ planAlias: "种草判定", version: 1, videosAvailable: true, platformName: "抖音" });
    expect(v.executions).toEqual([expect.objectContaining({ executionId: s.execId.toString(), isLatest: true })]);
  });
  it("一行的内容：组织名称、专员、19 位 ID 原文、互动值四态、北京时间、能力列", async () => {
    const s = await build();
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    const row = v.table.rows.find((r) => r.cells.contentId!.text === ID19)!;
    expect(row.cells.brand!.text).toBeTruthy();
    expect(row.cells.store!.text).toBeTruthy();
    expect(row.cells.platform!.text).toBe("抖音");
    expect(row.cells.kind!.text).toBe("视频");
    expect(row.cells.like).toMatchObject({ text: "2", num: 2 });
    expect(row.cells.comment!.text).toBe(""); // 评论值缺失 → 空，不是 0
    expect(row.cells.snapshotAt!.text).toMatch(/^2026-11-\d\d \d\d:\d\d$/);
    expect(row.cells["l1.0"]).toEqual({ text: "海信", tone: "pass" });
    expect(row.cells["l1.1"]).toEqual({ text: "30 秒", tone: "pass" });
  });
  it("取冻结的内容快照：执行之后又有更新的快照（点赞变了），展示仍是执行冻结时的值", async () => {
    const s = await build();
    const row = async () => (await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 })).table.rows.find((r) => r.cells.contentId!.text === ID19)!;
    expect((await row()).cells.like!.text).toBe("2");
    await moveCurrentSnapshot(t.db, s.ca.contentId, { like: 999 }); // 执行之后又同步了一次：current 指向新快照
    expect((await row()).cells.like!.text).toBe("2");
  });
  it("封面：已归档且已验证的引用才签名；缺失 / 未归档 → 没有图（占位），整行照常", async () => {
    const s = await build();
    const [c] = await t.db.select().from(contents).where(eq(contents.platformContentId, ID19 as never));
    const asset = await insertMediaAsset(t.db, { key: "covers/a.jpg", now: day(6) });
    await t.db.update(ossObjects).set({ status: "available", byteLength: 10n, sha256: Buffer.alloc(32, 1), verifiedAt: day(6) });
    await t.db.insert(mediaReferences).values({ contentSnapshotId: (await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, c!.contentId)))[0]!.contentSnapshotId, role: "cover_normalized", slotIndex: 0, observedAt: day(6), mediaAssetId: asset, archiveStatus: "archived", isCarriedForward: false, createdAt: day(6), updatedAt: day(6) });
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    const withCover = v.table.rows.filter((r) => r.images.cover);
    expect(withCover).toHaveLength(1);
    expect(withCover[0]!.images.cover).toContain("https://signed.test/covers%2Fa.jpg");
    expect(v.table.rows).toHaveLength(3);
  });
  it("图片签名器失败：只让该图占位，页面不报错", async () => {
    const s = await build();
    const [c] = await t.db.select().from(contents).where(eq(contents.platformContentId, ID19 as never));
    const asset = await insertMediaAsset(t.db, { key: "covers/b.jpg", now: day(6) });
    await t.db.update(ossObjects).set({ status: "available", byteLength: 10n, sha256: Buffer.alloc(32, 1), verifiedAt: day(6) });
    await t.db.insert(mediaReferences).values({ contentSnapshotId: (await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, c!.contentId)))[0]!.contentSnapshotId, role: "cover_normalized", slotIndex: 0, observedAt: day(6), mediaAssetId: asset, archiveStatus: "archived", isCarriedForward: false, createdAt: day(6), updatedAt: day(6) });
    const bad = assembleReport({ db: t.db, env: {}, outcomes: s.e.outcomes, registry: createRegistry(), media: { signedGetUrl: async () => { throw new Error("sign_down"); } }, clock: s.e.clock });
    const v = await bad.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    expect(v.table.rows).toHaveLength(3);
    expect(v.table.rows.every((r) => !r.images.cover)).toBe(true);
  });
});

describe("账号维度", () => {
  it("固定列 + 条件列 + 判定结果；老赵的内容各 1 条 → 品牌词与时长各自不达标；账号能力结果可用", async () => {
    const s = await build();
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: NOFILTER, page: 1 });
    expect(v.table.columns.at(-1)!.header).toBe("判定结果");
    expect(v.table.columns.map((c) => c.header).slice(11, 19)).toEqual(["粉丝数", "总获赞", "平台作品数", "已采集视频数", "主页是否采集成功", "主页采集时间", "视频列表是否采集成功", "视频列表采集时间"]);
    expect(v.header.abilityResultsAvailable).toBe(true);
    expect(v.table.total).toBe(2);
    const zhao = v.table.rows.find((r) => r.cells.staff!.text.length > 0 && r.cells.result!.text === "通过")!;
    expect(zhao.cells["l1.0"]).toEqual({ text: "通过", tone: "pass" });
    expect(zhao.cells["l1.1"]).toEqual({ text: "通过", tone: "pass" });
    const sun = v.table.rows.find((r) => r.cells.result!.text === "不通过")!;
    expect(sun.cells["l1.0"]).toEqual({ text: "不通过", tone: "fail" });
  });
  it("主页快照取数据截止时点前最新：之后到达的批次不被选中；主页 / 列表采集状态四态与「无记录」", async () => {
    const s = await build();
    const [asg] = await t.db.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.accountId, s.w.accZhao));
    // 截止时点前终态的批次 → 被选中；之后才完成的批次 → 不被选中
    const b1 = await insertBatch(t.db, day(7));
    await t.db.update(syncBatches).set({ finishedAt: day(7), status: "succeeded" }).where(eq(syncBatches.batchId, b1));
    const p1 = await insertProfileSnapshot(t.db, { batchId: b1, accountId: s.w.accZhao, assignmentId: asg!.assignmentId, now: day(7) });
    const b2 = await insertBatch(t.db, new Date("2026-12-01T00:00:00Z"));
    await t.db.update(syncBatches).set({ finishedAt: new Date("2026-12-01T00:10:00Z"), status: "succeeded" }).where(eq(syncBatches.batchId, b2));
    const p2 = await insertProfileSnapshot(t.db, { batchId: b2, accountId: s.w.accZhao, assignmentId: asg!.assignmentId, now: new Date("2026-12-01T00:00:00Z") });
    await t.db.execute(`UPDATE account_profile_snapshots SET nickname = '截止前昵称' WHERE profile_snapshot_id = ${p1}` as never);
    await t.db.execute(`UPDATE account_profile_snapshots SET nickname = '截止后昵称' WHERE profile_snapshot_id = ${p2}` as never);
    // 主页任务：截止前成功一次
    const tk = await insertTask(t.db, { batchId: b1, platform: "douyin", now: day(7), status: "succeeded", action: "fetch_profile" });
    await t.db.update(syncTasks).set({ accountId: s.w.accZhao, finishedAt: day(7) }).where(eq(syncTasks.taskId, tk));
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: NOFILTER, page: 1 });
    const zhao = v.table.rows.find((r) => r.cells.nickname!.text === "截止前昵称")!;
    expect(zhao).toBeDefined();
    expect(v.table.rows.some((r) => r.cells.nickname!.text === "截止后昵称")).toBe(false);
    expect(zhao.cells.profileOk!.text).toBe("是");
    expect(zhao.cells.profileAt!.text).toBe("2026-11-07 12:00");
    expect(zhao.cells.listOk!.text).toBe("是"); // build() 里 addListTask 成功
    // 粉丝数 0 是真实 0；总获赞是 explicit_null → 空；作品数 invalid → 无效
    expect(zhao.cells.followers).toMatchObject({ text: "0", num: 0 });
    expect(zhao.cells.likesTotal!.text).toBe("");
    expect(zhao.cells.posts!.text).toBe("无效");
    const sun = v.table.rows.find((r) => r !== zhao)!;
    expect(sun.cells.profileOk!.text).toBe("无记录");
    expect(sun.cells.profileAt!.text).toBe("");
    expect(v.table.missingRows).toBeGreaterThan(0);
  });
  it("采集失败 / 部分 / 无记录：失败 → 否；succeeded_with_gap → 部分（有缺口）", async () => {
    const s = await build();
    await addListTask(t.db, { accountId: s.p2.accountId, status: "failed", at: day(8) });
    let v = await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: NOFILTER, page: 1 });
    expect(v.table.rows.find((r) => r.cells.result!.text === "不通过")!.cells.listOk!.text).toBe("否");
    await addListTask(t.db, { accountId: s.p2.accountId, status: "succeeded_with_gap", at: day(9) });
    v = await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: NOFILTER, page: 1 });
    expect(v.table.rows.find((r) => r.cells.result!.text === "不通过")!.cells.listOk!.text).toBe("部分（有缺口）");
  });
  it("旧执行（ability_results 为 NULL）：账号能力列整列空，判定结果与固定列照常", async () => {
    const s = await build();
    await t.db.update(runParticipants).set({ abilityResults: null }).where(eq(runParticipants.runId, s.execId));
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: NOFILTER, page: 1 });
    expect(v.header.abilityResultsAvailable).toBe(false);
    expect(v.table.rows.every((r) => r.cells["l1.0"]!.text === "" && r.cells.result!.text !== "")).toBe(true);
  });
});

describe("范围、筛选与选择执行", () => {
  it("总部全部；本分公司的分公司人员全部；别的分公司 → 找不到；门店专员只看本人（行数与总数都只算范围内）", async () => {
    const s = await build();
    expect((await s.report.view(s.bj, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 })).table.total).toBe(3);
    expect((await err(s.report.view(s.sh, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 })))?.kind).toBe("not_found");
    const own = await s.report.view(s.zhao, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    expect(own.table.total).toBe(2);
    expect(own.totals).toEqual({ videos: 2, accounts: 1 });
    expect((await s.report.view(s.zhao, s.planId.toString(), { tab: "accounts", filter: NOFILTER, page: 1 })).table.rows).toHaveLength(1);
  });
  it("筛选：门店 / 专员姓名搜索 / 非法 ID；搜索结果超过上限提示缩小", async () => {
    const s = await build();
    const byStore = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: { storeId: s.w.stores.sW1.toString() }, page: 1 });
    expect(byStore.table.total).toBe(3);
    const none = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: { storeId: s.w.stores.sH1.toString() }, page: 1 });
    expect(none.table.total).toBe(0);
    const byName = await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: { staffQuery: "老孙" }, page: 1 });
    expect(byName.table.total).toBe(1);
    expect((await err(s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: { branchId: "abc" }, page: 1 })))?.code).toBe("invalid_filter");
    // 搜索里的 % 与 _ 是普通字符，不是通配
    expect((await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: { staffQuery: "%" }, page: 1 })).table.total).toBe(0);
  });
  it("选项只列该执行的参与者实际出现的组织（范围内）", async () => {
    const s = await build();
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    expect(v.options.stores.map((x) => x.id)).toEqual([s.w.stores.sW1.toString()]);
    expect(v.options.branches).toHaveLength(1);
  });
  it("多次执行：默认最近一次，可切换历史；不存在的执行 → not_found；没有已完成执行 → no_completed_execution", async () => {
    const s = await build();
    const second = await executeOnce(s.e, s.planId, "k2");
    await t.db.update(judgementRuns).set({ completedAt: new Date("2026-11-20T00:00:00Z") }).where(eq(judgementRuns.runId, second));
    const latest = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    expect(latest.header.executionId).toBe(second.toString());
    expect(latest.executions.map((e) => e.isLatest)).toEqual([true, false]);
    const old = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", executionId: s.execId.toString(), filter: NOFILTER, page: 1 });
    expect(old.header.executionId).toBe(s.execId.toString());
    expect((await err(s.report.view(s.hq, s.planId.toString(), { tab: "videos", executionId: "999999", filter: NOFILTER, page: 1 })))?.kind).toBe("not_found");
    const empty = await s.e.plans.create(s.e.creator, { activityPlanId: s.w.planId, alias: "空计划" });
    expect((await err(s.report.view(s.hq, empty.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 })))?.code).toBe("no_completed_execution");
  });
  it("内容级行已被保留期清理：视频明细空表 + videosAvailable=false，账号维度仍可用", async () => {
    const s = await build();
    await t.db.update(judgementRuns).set({ phaseDetail: { contentsPruned: true } as never }).where(eq(judgementRuns.runId, s.execId));
    const v = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    expect(v.header.videosAvailable).toBe(false);
    expect(v.table.rows).toEqual([]);
    expect(v.totals.videos).toBe(0);
    expect((await s.report.view(s.hq, s.planId.toString(), { tab: "accounts", filter: NOFILTER, page: 1 })).table.total).toBe(2);
  });
});

describe("导出", () => {
  it("两个 sheet、表头与行数和页面一致；19 位 ID 是文本；没有图片；出口 4 记审计", async () => {
    const s = await build();
    const { r, bytes } = await collectBytes((sink) => s.report.exportWorkbook(s.hq, s.planId.toString(), { filter: NOFILTER }, sink));
    expect(r).toMatchObject({ videoRows: 3, accountRows: 2, warnings: [] });
    expect((r as { fileName: string }).fileName).toMatch(/-种草判定-2026-11-\d\d-全量明细\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["视频明细", "账号维度"]);
    const vs = wb.getWorksheet("视频明细")!;
    const page = await s.report.view(s.hq, s.planId.toString(), { tab: "videos", filter: NOFILTER, page: 1 });
    expect(vs.getRow(1).values).toEqual([undefined, ...page.table.columns.map((c) => c.header)]);
    expect(vs.rowCount).toBe(1 + 3);
    const idCol = page.table.columns.findIndex((c) => c.key === "contentId") + 1;
    const ids = [2, 3, 4].map((i) => cellText(vs.getRow(i).getCell(idCol).value));
    expect(ids).toContain(ID19);
    expect(typeof vs.getRow(2).getCell(idCol).value).toBe("string");
    expect(wb.getWorksheet("账号维度")!.rowCount).toBe(1 + 2);
    expect(bytes.includes(Buffer.from("xl/media/"))).toBe(false);
    const ev = await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "egress.export_file"));
    expect(ev.some((x) => x.outcome === "succeeded" && x.targetId === s.planId.toString())).toBe(true);
  });
  it("按当前筛选导出：只导出筛选后的行", async () => {
    const s = await build();
    const { r, bytes } = await collectBytes((sink) => s.report.exportWorkbook(s.hq, s.planId.toString(), { filter: { staffQuery: "老孙" } }, sink));
    expect(r).toMatchObject({ videoRows: 1, accountRows: 1 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    expect(wb.getWorksheet("视频明细")!.rowCount).toBe(2);
  });
  it("门店专员没有 report.export：被拒，不产生任何字节", async () => {
    const s = await build();
    let bytes = 0;
    const sink = new Writable({ write(c, _e, cb) { bytes += c.length; cb(); } });
    const e = await err(s.report.exportWorkbook(s.zhao, s.planId.toString(), { filter: NOFILTER }, sink));
    expect(e?.kind).toBe("auth");
    expect(bytes).toBe(0);
  });
  it("别的分公司导出 → 找不到；撤权后（范围为空）→ auth", async () => {
    const s = await build();
    expect((await err(s.report.prepareExport(s.sh, s.planId.toString(), { filter: NOFILTER })))?.kind).toBe("not_found");
    const empty = userCtx("hq_manager", 50, { brands: new Set(), branches: new Set(), self: { kind: "none" }, level: 2 });
    expect((await err(s.report.prepareExport(empty, s.planId.toString(), { filter: NOFILTER })))?.kind).toBe("auth");
  });
  it("超过行数上限：export_row_limit，写出前就拒绝（没有一个字节）", async () => {
    const s = await build({ limits: { videoRows: 2, accountRows: 5000 } });
    let bytes = 0;
    const sink = new Writable({ write(c, _e, cb) { bytes += c.length; cb(); } });
    const e = await err(s.report.exportWorkbook(s.hq, s.planId.toString(), { filter: NOFILTER }, sink));
    expect(e).toMatchObject({ kind: "conflict", code: "export_row_limit" });
    expect(bytes).toBe(0);
    // 用筛选缩小范围后可以导出
    const ok = await collectBytes((k) => s.report.exportWorkbook(s.hq, s.planId.toString(), { filter: { staffQuery: "老孙" } }, k));
    expect(ok.r).toMatchObject({ videoRows: 1 });
  });
  it("内容级行已清理：不生成视频明细 sheet，带 videos_pruned 警告；旧执行带 abilities_unavailable", async () => {
    const s = await build();
    await t.db.update(judgementRuns).set({ phaseDetail: { contentsPruned: true } as never }).where(eq(judgementRuns.runId, s.execId));
    await t.db.update(runParticipants).set({ abilityResults: null }).where(eq(runParticipants.runId, s.execId));
    const { r, bytes } = await collectBytes((sink) => s.report.exportWorkbook(s.hq, s.planId.toString(), { filter: NOFILTER }, sink));
    expect((r as { warnings: string[] }).warnings.sort()).toEqual(["abilities_unavailable", "videos_pruned"]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["账号维度"]);
  });
  it("并发上限 2：第三个同时进行的导出被拒 export_busy，前两个照常完成", async () => {
    const s = await build();
    const mk = () => new Writable({ write(_c, _e, cb) { setTimeout(cb, 20); } });
    const preps = await Promise.all([1, 2, 3].map(() => s.report.prepareExport(s.hq, s.planId.toString(), { filter: NOFILTER })));
    const results = await Promise.allSettled(preps.map((p) => s.report.writeExport(p, mk())));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    const rej = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect((rej.reason as ReportError).code).toBe("export_busy");
    // 占位已释放：之后可以再导出
    await collectBytes((k) => s.report.exportWorkbook(s.hq, s.planId.toString(), { filter: NOFILTER }, k));
  });
  it("导出预览：文件名、行数、警告、两张表的表头；超限标记", async () => {
    const s = await build({ limits: { videoRows: 2, accountRows: 5000 } });
    const p = await s.report.exportPreview(s.hq, s.planId.toString(), { filter: NOFILTER });
    expect(p).toMatchObject({ videoRows: 3, accountRows: 2, tooMany: true, warnings: [] });
    expect(p.videoColumns.at(-1)!.header).toBe("时长");
    expect(p.accountColumns.at(-1)!.header).toBe("判定结果");
  });
});
