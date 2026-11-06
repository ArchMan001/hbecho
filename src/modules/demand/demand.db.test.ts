// 按需采集（FS-8、FS-9；acceptance H、I）：提交处置、幂等、复用、种子快照、失败、批次终态。全程离线。
// 列表页是合成的，内容 ID 取自详情 / 评论 fixture 的 post_id，所以可以直接喂真实的详情 / 评论响应。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resetData, useTestDb } from "../../../tests/harness/db";
import { serviceActor } from "../../../tests/harness/actors";
import { FakeRuleSource, dispositionOf } from "../../../tests/harness/fake-rule-source";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { nextRound, runPeriodic } from "../../../tests/harness/periodic";
import { DETAIL_PATH, SLOT, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { contentSnapshots, contents, dataQualityIssues, syncBatches, syncTasks } from "../../db/schema";
import { createAccountRunners, createDemandRunners } from "../sync-runner";
import { createDemandModule } from "./index";
import { memorySyncAuditSink } from "../sync-schedule";
import { SyncError } from "../sync-schedule";

const t = useTestDb();
const DY_POST = "7676403385372904742"; // raw4.C05 / C07 的抖音作品
const XHS_POST = "6a869a5c0000000014028682"; // raw4.C06 / C08 的小红书笔记
const KS_POST = "3xx33ggte9tessy";
const runAll = (env: SyncEnv) => env.worker({ ...createAccountRunners(env.deps), ...createDemandRunners(env.deps) }).run({ untilIdle: true });
const tasksOf = async (action?: string) => (await t.db.select().from(syncTasks).orderBy(syncTasks.taskId)).filter((x) => !action || x.requestedAction === action);
const detailCalls = (env: SyncEnv) => env.transport.calls.filter((c) => c.request.path === DETAIL_PATH).length;

async function world() {
  const env = await setupSync(t);
  const [dy, xhs, ks] = await runPeriodic(t, env, [
    { platform: "douyin", staffId: env.org.staffA, postIds: [DY_POST, "7000000000000000001"] },
    { platform: "xiaohongshu", staffId: env.org.staffB, postIds: [XHS_POST] },
    { platform: "kuaishou", staffId: env.org.staffC, postIds: [KS_POST] },
  ]);
  const cid = { dy: dy!.contentIds.get(DY_POST)!, xhs: xhs!.contentIds.get(XHS_POST)!, ks: ks!.contentIds.get(KS_POST)! };
  env.routeDetail(({ url }) => loadFixtureBytes(url.includes("xiaohongshu") ? "raw4.C06" : "raw4.C05"));
  const source = new FakeRuleSource(env.demand, serviceActor());
  return { env, cid, source, accounts: { dy: dy!, xhs: xhs!, ks: ks! } };
}

describe("提交处置矩阵（FS-8.3）：七类全部可达", () => {
  it("queued / reused / already_pending / unsupported_platform / capability_disabled / content_not_found / out_of_scope", async () => {
    const { env, cid, source, accounts } = await world();

    // queued：新建任务；批次 demand/manual，优先级 50，任务写 account_id 与 content_id（领取时资格复核靠它）
    const first = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    expect(dispositionOf(first, cid.dy, "detail")).toBe("queued");
    const [batch] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, BigInt(first.batchId)));
    expect(batch).toMatchObject({ purpose: "demand", triggerType: "manual", status: "running" });
    const [task] = await tasksOf("fetch_content_detail");
    expect(task).toMatchObject({ priority: 50, accountId: accounts.dy.accountId, contentId: cid.dy, ruleDecisionId: "decision-1", ruleVersion: "rv-1", status: "pending" });

    // already_pending：另一个计划同时要同一内容同一动作 → 复用活动任务，不新建
    const second = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    expect(dispositionOf(second, cid.dy, "detail")).toBe("already_pending");
    expect(second.dispositions[0]!.taskId).toBe(task!.taskId.toString());
    expect(second.taskCount).toBe(0);
    expect(await tasksOf("fetch_content_detail")).toHaveLength(1);

    // reused：本轮已有
    await runAll(env);
    const third = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    expect(dispositionOf(third, cid.dy, "detail")).toBe("reused");

    // unsupported_platform：快手评论；快手详情同步已由 2026-11-06 真实 smoke 验证内容 URL 构造 → 正常排队
    const ks = await source.request([{ contentId: cid.ks, wants: ["comments", "detail"] }]);
    expect(dispositionOf(ks, cid.ks, "comments")).toBe("unsupported_platform");
    expect(dispositionOf(ks, cid.ks, "detail")).toBe("queued");
    expect(ks.taskCount).toBe(1);
    // capability_disabled：抖音评论异步稳定失败（provider-failed），不放行（能力门控先于复用 / 排队判断）
    const asyncDemand = createDemandModule({ db: t.db, clock: env.clock, runtime: { environment: "test", modes: { media_stats_number: "synchronous", post_comments_list: "asynchronous" } }, audit: memorySyncAuditSink() });
    const dyAsync = await new FakeRuleSource(asyncDemand, serviceActor(), "fake-async").request([{ contentId: cid.dy, wants: ["comments"] }]);
    expect(dispositionOf(dyAsync, cid.dy, "comments")).toBe("capability_disabled");
    expect(dyAsync.taskCount).toBe(0);

    // content_not_found：不存在的内容
    const nf = await source.request([{ contentId: 999999999n, wants: ["detail"] }]);
    expect(dispositionOf(nf, 999999999n, "detail")).toBe("content_not_found");

    // out_of_scope：调用方只能操作 staffB，内容属于 staffA 的账号
    const narrow = new FakeRuleSource(env.demand, serviceActor({ actorId: "service:narrow", scope: { platformCodes: "all", mediaStaffIds: new Set([env.org.staffB]) } }));
    const oos = await narrow.request([{ contentId: cid.dy, wants: ["detail", "comments"] }]);
    expect(oos.dispositions.map((d) => d.disposition)).toEqual(["out_of_scope", "out_of_scope"]);
    expect(oos.taskCount).toBe(0);
    // 范围外 + 范围内混合：范围内照常处理
    const mixed = await narrow.request([{ contentId: cid.dy, wants: ["detail"] }, { contentId: cid.xhs, wants: ["detail"] }]);
    expect(dispositionOf(mixed, cid.dy, "detail")).toBe("out_of_scope");
    expect(dispositionOf(mixed, cid.xhs, "detail")).toBe("queued");
  });

  it("没有任务可建（全部 reused / 被拒）：批次直接 succeeded，逐项处置可由 get 回答", async () => {
    const { cid, source, env } = await world();
    const r = await source.request([{ contentId: cid.ks, wants: ["comments"] }]);
    expect(r).toMatchObject({ kind: "created", status: "succeeded", taskCount: 0 });
    const view = await env.demand.get(r.batchId, serviceActor());
    expect(view.items).toEqual([{ contentId: cid.ks.toString(), want: "comments", disposition: "unsupported_platform", state: "unsupported", reason: "unsupported_platform" }]);
  });

  it("越权与非法输入：缺 Capability → forbidden；5001 项 / 空 wants / 未知 want → invalid_input", async () => {
    const { env, cid } = await world();
    const noCap = serviceActor({ capabilities: new Set() });
    await expect(new FakeRuleSource(env.demand, noCap).request([{ contentId: cid.dy, wants: ["detail"] }])).rejects.toMatchObject({ code: "forbidden" });
    const rs = new FakeRuleSource(env.demand, serviceActor());
    await expect(rs.request(Array.from({ length: 5001 }, (_, i) => ({ contentId: BigInt(i + 1), wants: ["detail"] as const })))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(rs.request([{ contentId: cid.dy, wants: [] }])).rejects.toBeInstanceOf(SyncError);
    await expect(env.demand.submit({ demandKey: "k", requester: { kind: "a", ref: "b", version: "c" }, ruleDecisionId: "d", ruleVersion: "v", items: [{ contentId: "1", wants: ["bogus"] }] }, serviceActor())).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("幂等（FS-8.1、8.6）", () => {
  it("同键同载荷（含顺序不同的 items / wants）返回原批次；同键异载荷冲突", async () => {
    const { cid, source } = await world();
    // ruleDecisionId / ruleVersion 是载荷的一部分：同一个提交重放时它们必须相同
    const a = await source.request([{ contentId: cid.dy, wants: ["detail", "comments"] }, { contentId: cid.xhs, wants: ["detail"] }], { key: "K1", ruleDecisionId: "d1" });
    const b = await source.request([{ contentId: cid.xhs, wants: ["detail"] }, { contentId: cid.dy, wants: ["comments", "detail"] }], { key: "K1", ruleDecisionId: "d1" });
    expect(b).toMatchObject({ kind: "deduplicated", batchId: a.batchId });
    expect(b.dispositions).toEqual(a.dispositions);
    await expect(source.request([{ contentId: cid.dy, wants: ["detail"] }], { key: "K1", ruleDecisionId: "d1" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "demand"))).toHaveLength(1);
  });

  it("崩溃重放：批次已建、任务缺了一个 → 同键重放补齐缺失任务，不重复", async () => {
    const { cid, source } = await world();
    const items = [{ contentId: cid.dy, wants: ["detail", "comments"] as const }];
    const a = await source.request(items, { key: "K2", ruleDecisionId: "d" });
    expect(await tasksOf()).toHaveLength(a.taskCount + (await tasksOf()).filter((x) => x.requestedAction.startsWith("fetch_content_list") || x.requestedAction === "fetch_profile").length);
    const victim = (await tasksOf("fetch_comments"))[0]!;
    await t.db.delete(syncTasks).where(eq(syncTasks.taskId, victim.taskId));
    const b = await source.request(items, { key: "K2", ruleDecisionId: "d" });
    expect(b.kind).toBe("deduplicated");
    expect(await tasksOf("fetch_comments")).toHaveLength(1);
    expect(await tasksOf("fetch_content_detail")).toHaveLength(1);
    await source.request(items, { key: "K2", ruleDecisionId: "d" });
    expect(await tasksOf("fetch_content_detail")).toHaveLength(1); // 再重放仍不重复
  });
});

describe("复用与「本轮」（FS-8.4、FS-D06）", () => {
  it("同一轮内两个计划先后提交同一内容：只有一次详情 ProviderCall；下一个 full 批次开始后再提交，重新抓取（包括上一轮由按需批次产生的详情）", async () => {
    const { env, cid, source } = await world();
    await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    await runAll(env);
    expect(detailCalls(env)).toBe(1);
    const same = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    expect(dispositionOf(same, cid.dy, "detail")).toBe("reused");
    await runAll(env);
    expect(detailCalls(env)).toBe(1); // 第二个计划没有付费

    await nextRound(t, env);
    const fresh = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    expect(dispositionOf(fresh, cid.dy, "detail")).toBe("queued"); // 上一轮的详情是按需批次产生的，也不得永久复用（H14）
    await env.worker(createDemandRunners(env.deps)).run({ untilIdle: true });
    expect(detailCalls(env)).toBe(2);
  });

  it("按需批次不受全量串行约束，任务优先级高于周期任务：领取顺序里详情排在待处理的周期任务之前", async () => {
    const { env, cid, source } = await world();
    await nextRound(t, env); // 新的 full 批次 running，主页 / 列表任务 pending（优先级 0）
    await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    const before = env.transport.calls.length;
    await env.worker({ ...createAccountRunners(env.deps), ...createDemandRunners(env.deps) }).run({ untilIdle: true });
    expect(env.transport.calls[before]!.request.path).toBe(DETAIL_PATH); // 第一个新调用就是详情
    const demand = (await t.db.select().from(syncBatches)).filter((b) => b.purpose === "demand");
    expect(demand).toHaveLength(1);
    await env.scheduler.tick(env.clock.now()); // 汇总
    expect((await t.db.select().from(syncBatches)).filter((b) => b.purpose === "full" && b.status === "running")).toHaveLength(0); // 周期批次也跑完了
  });
});

describe("详情执行（FS-9）", () => {
  it("抖音：种子快照拷贝列表字段，详情有效值覆盖；list_observed=FALSE、detail_observed=TRUE、seeded_from 非空；current 切到详情快照，列表字段仍可读", async () => {
    const { env, cid, source } = await world();
    await t.db.update(contentSnapshots).set({ body: "列表里的正文", shareUrl: "https://v.douyin.com/abc/", shareUrlSha256: Buffer.alloc(32, 1) }).where(eq(contentSnapshots.contentId, cid.dy));
    const [listSnap] = await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, cid.dy));
    expect(listSnap).toMatchObject({ listObserved: true, detailObserved: false, playState: "unsupported" });
    const r = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    await runAll(env);

    const snaps = await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, cid.dy));
    expect(snaps).toHaveLength(2);
    const detail = snaps.find((s) => s.detailObserved)!;
    expect(detail).toMatchObject({
      batchId: BigInt(r.batchId),
      snapshotStatus: "finalized",
      listObserved: false,
      detailObserved: true,
      seededFromSnapshotId: listSnap!.contentSnapshotId,
      mergePolicyVersion: "list-merge.v1",
      playState: "value",
      playValue: 73897n, // 详情的 play_number
      title: expect.stringContaining("日立"), // 详情的有效标题覆盖列表的
      body: "列表里的正文", // 列表独有的字段不丢
      shareUrl: "https://v.douyin.com/abc/",
      lastListProviderCallId: null,
      listAdapterVersion: null,
    });
    expect(detail.lastDetailProviderCallId).not.toBeNull();
    expect(detail.snapshotAt.getTime()).toBe(detail.detailResponseReceivedAt!.getTime()); // snapshot_at = 详情响应接收时间
    const [task] = await tasksOf("fetch_content_detail");
    expect(task).toMatchObject({ status: "succeeded", sourceContentSnapshotId: listSnap!.contentSnapshotId });
    const [c] = await t.db.select().from(contents).where(eq(contents.contentId, cid.dy));
    expect(c!.currentSnapshotId).toBe(detail.contentSnapshotId);
    expect(c!.status).toBe("active");
    // 列表独有的发布时间 / 作者仍可读
    expect(detail.publishedAt).not.toBeNull();
  });

  it("小红书：图文笔记 play_number=null 保持 explicit_null（不是 0）；列表正文不丢", async () => {
    const { env, cid, source } = await world();
    await t.db.update(contentSnapshots).set({ body: "列表里的正文" }).where(eq(contentSnapshots.contentId, cid.xhs));
    await source.request([{ contentId: cid.xhs, wants: ["detail"] }]);
    await runAll(env);
    const detail = (await t.db.select().from(contentSnapshots).where(and(eq(contentSnapshots.contentId, cid.xhs), eq(contentSnapshots.detailObserved, true))))[0]!;
    expect(detail).toMatchObject({ playState: "explicit_null", playValue: null, body: "列表里的正文" });
  });

  it("详情失败：RESULT_VALIDATION_FAILED 耗尽 → failed/detail_inaccessible + 质量问题；没有种子快照残留，内容状态未变，播放数不是 0", async () => {
    const { env, cid, source } = await world();
    env.transport.clearRoutes();
    env.routeDetail(() => ({ httpStatus: 500, body: loadFixtureBytes("raw7.C20.http500") }));
    const r = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    for (let i = 0; i < 3; i++) {
      await runAll(env);
      env.clock.advance(10 * 60_000);
    }
    const [task] = await tasksOf("fetch_content_detail");
    expect(task).toMatchObject({ status: "failed", lastErrorCode: "detail_inaccessible", attemptCount: 3 });
    expect(await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, cid.dy))).toHaveLength(1); // 只有列表快照
    expect((await t.db.select().from(contents).where(eq(contents.contentId, cid.dy)))[0]).toMatchObject({ status: "active" });
    expect((await t.db.select().from(dataQualityIssues)).filter((i) => i.issueCode === "detail_inaccessible")).toHaveLength(1);
    const view = await env.demand.get(r.batchId, serviceActor());
    expect(view.items[0]).toMatchObject({ state: "failed", reason: "detail_inaccessible" });
  });

  it("响应不是这条内容（post_id 不符）：不合并，invalid_response，没有种子快照", async () => {
    const { env, cid, source } = await world();
    env.transport.clearRoutes();
    env.routeDetail(() => loadFixtureBytes("raw9.A5.poll1")); // 另一条抖音作品的详情
    await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    await runAll(env);
    expect((await tasksOf("fetch_content_detail"))[0]).toMatchObject({ lastErrorCode: "invalid_response" });
    expect(await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, cid.dy))).toHaveLength(1);
  });

  it("预算封口：未创建调用的任务以 budget_exhausted 终态，get 如实展示（FS-8.8）", async () => {
    const env = await setupSync(t, { policy: { check: async (c) => (c.requestedAction === "media_stats_number" ? "call_budget" : null) } });
    const [dy] = await runPeriodic(t, env, [{ platform: "douyin", staffId: env.org.staffA, postIds: [DY_POST] }]);
    env.routeDetail(() => loadFixtureBytes("raw4.C05"));
    const cid = dy!.contentIds.get(DY_POST)!;
    const r = await new FakeRuleSource(env.demand, serviceActor()).request([{ contentId: cid, wants: ["detail"] }]);
    await runAll(env);
    expect(env.transport.calls.filter((c) => c.request.path === DETAIL_PATH)).toHaveLength(0);
    const view = await env.demand.get(r.batchId, serviceActor());
    expect(view.items[0]).toMatchObject({ state: "failed", reason: "budget_exhausted" });
  });
});

describe("批次终态与查询（FS-8.7）", () => {
  it("tick 汇总按需批次：全部成功 → succeeded；部分失败 → partial_succeeded；get 返回读取指针", async () => {
    const { env, cid, source } = await world();
    const r = await source.request([{ contentId: cid.dy, wants: ["detail"] }, { contentId: cid.xhs, wants: ["detail"] }]);
    // 小红书详情失败（不可重试的 400）
    env.transport.clearRoutes();
    env.routeDetail(({ url }) => (!url.includes("xiaohongshu") ? loadFixtureBytes("raw4.C05") : { httpStatus: 400, body: new TextEncoder().encode('{"code":"INVALID_REQUEST"}') }));
    await runAll(env);
    await env.scheduler.tick(env.clock.now());
    const [b] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, BigInt(r.batchId)));
    expect(b).toMatchObject({ status: "partial_succeeded", succeededTaskCount: 1, failedTaskCount: 1 });
    const view = await env.demand.get(r.batchId, serviceActor());
    const dy = view.items.find((i) => i.contentId === cid.dy.toString())!;
    const xhs = view.items.find((i) => i.contentId === cid.xhs.toString())!;
    expect(dy).toMatchObject({ state: "ready", pointers: { contentSnapshotId: expect.any(String) } });
    expect(xhs).toMatchObject({ state: "failed", reason: "provider_request_rejected" });
    expect(view.status).toBe("partial_succeeded");
  });

  it("get 只读本地：不发起任何供应商调用；别人的批次读不到（受限身份）", async () => {
    const { env, cid, source } = await world();
    const r = await source.request([{ contentId: cid.dy, wants: ["detail"] }]);
    const calls = env.transport.calls.length;
    const view = await env.demand.get(r.batchId, serviceActor());
    expect(view.items[0]).toMatchObject({ state: "pending", disposition: "queued" });
    expect(env.transport.calls.length).toBe(calls);
    await expect(env.demand.get(r.batchId, serviceActor({ actorId: "service:other", scope: { platformCodes: new Set(["douyin"]), mediaStaffIds: "all" } }))).rejects.toMatchObject({ code: "out_of_scope" });
    await expect(env.demand.get("424242", serviceActor())).rejects.toMatchObject({ code: "not_found" });
  });
});

void resetData;
