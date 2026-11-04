// 任务 3：一年期保留的清理闭包与 ODS orphan sweeper（R2.8、R2.10；acceptance H6、H7）。
// 清理顺序 payload → call → task；不得级联删除长期快照、归属、发现、检查点或正式媒资；可幂等重跑。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../../tests/harness/actors";
import { MemoryAuditSink } from "../../../tests/harness/audit";
import { useTestDb } from "../../../tests/harness/db";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../tests/harness/fake-oss";
import { FixtureTransport } from "../../../tests/harness/fixture-transport";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import {
  insertAccount,
  insertAssignment,
  insertContent,
  insertContentSnapshot,
  insertMediaAsset,
  insertPreparedCall,
  insertProfileSnapshot,
  insertTask,
  sha,
} from "../../../tests/harness/factories";
import { providerIdOf, seedOrg, seedSyncSettings } from "../../../tests/harness/seed";
import {
  accountProfileSnapshots,
  contentDiscoveries,
  contentSnapshots,
  dataQualityIssues,
  externalAccounts,
  mediaAssets,
  mediaReferences,
  odsPayloads,
  odsProviderCalls,
  ossObjects,
  staffAccountAssignments,
  syncBatches,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import { buildRequest } from "../provider-adapter";
import { createTracerCommands } from "../tracer-command";
import { RawCaptureGateway, cleanupExpired, sweepOrphans, type CallSpec, type CleanupEvent } from "./index";

const START = new Date("2026-11-04T08:00:00.000Z");
const YEAR_MS = 365 * 24 * 3600 * 1000;
const t = useTestDb();

async function setup() {
  const clock = new FakeClock(START);
  const store = new FakeObjectStore(clock);
  const transport = new FixtureTransport();
  transport.register({ path: "/openapi/v1/media_user_info", query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.media_user_info") });
  const org = await seedOrg(t.db, clock.now());
  await seedSyncSettings(t.db, clock.now());
  const commands = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
  const { rootTaskId } = await commands.submit({ platform: "douyin", mediaStaffId: org.staffA.toString(), homeLocator: "https://v.douyin.com/x/", idempotencyKey: "k" }, serviceActor());
  const taskId = BigInt(rootTaskId);
  await t.db.update(syncTasks).set({ status: "running", leaseOwner: "w", leaseExpiresAt: new Date(START.getTime() + 60_000), fencingToken: 1n }).where(eq(syncTasks.taskId, taskId));
  const [task] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, taskId));
  const gateway = new RawCaptureGateway({
    db: t.db,
    store,
    transport,
    clock,
    location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-test" },
  });
  const spec = (attemptNo = 1): CallSpec => ({
    syncTaskId: taskId,
    fencingToken: 1n,
    platformId: task!.platformId,
    providerId: task!.providerId,
    attemptNo,
    callSequence: 1,
    requestedAction: "media_user_info",
    expectedResponseAction: "media_user_info",
    request: buildRequest({ action: "media_user_info", mode: "synchronous", locator: "https://v.douyin.com/x/" }),
  });
  const finishRoot = () =>
    t.db.update(syncTasks).set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null, finishedAt: START }).where(eq(syncTasks.taskId, taskId));
  const clean = (events?: CleanupEvent[]) => cleanupExpired({ db: t.db, store, clock, ...(events ? { onEvent: (e: CleanupEvent) => void events.push(e) } : {}) });
  return { clock, store, transport, gateway, spec, taskId, task: task!, org, finishRoot, clean };
}

describe("一年清理：payload → call → task，长期业务事实全部保留", () => {
  it("到期后清掉 ODS 载荷、调用、任务与远端字节；快照 / 归属 / 检查点 / 质量问题 / 正式媒资都还在，来源引用被置空", async () => {
    const { clock, store, gateway, spec, taskId, task, org, finishRoot, clean } = await setup();
    const out = await gateway.execute(spec());
    if (out.kind !== "captured") throw new Error("应 captured");
    const callId = out.captured.providerCallId;
    await finishRoot();

    // 长期事实，全部引用这次调用 / 任务
    const accountId = await insertAccount(t.db, "douyin", START);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: START });
    const profileSnap = await insertProfileSnapshot(t.db, { batchId: task.batchId, accountId, assignmentId, now: START, callId });
    const contentId = await insertContent(t.db, { platform: "douyin", accountId, platformContentId: "p1", now: START });
    const contentSnap = await insertContentSnapshot(t.db, { batchId: task.batchId, contentId, now: START, status: "finalized" });
    await t.db.update(contentSnapshots).set({ lastListProviderCallId: callId }).where(eq(contentSnapshots.contentSnapshotId, contentSnap));
    await t.db.insert(contentDiscoveries).values({ batchId: task.batchId, assignmentId, contentId, pageNo: 0, positionInPage: 0, absolutePosition: 0, isPotentiallyPinned: false, discoveredAt: START, sourceProviderCallId: callId, createdAt: START });
    await t.db.insert(syncCheckpoints).values({ accountId, providerId: await providerIdOf(t.db), anchorMode: "empty", cursorEnvelope: { kind: "null" }, cursorSha256: sha("c"), cursorTaskId: taskId, lastSuccessfulBatchId: task.batchId, lastSuccessfulTaskId: taskId, continuityStatus: "ready", updatedAt: START });
    await t.db.insert(dataQualityIssues).values({ issueFingerprint: sha("i"), issueCode: "field_contract_anomaly", severity: "warning", status: "open", batchId: task.batchId, accountId, providerCallId: callId, detail: { x: 1 }, firstSeenAt: START, lastSeenAt: START, createdAt: START, updatedAt: START });
    const asset = await insertMediaAsset(t.db, { key: "media/keep/a", now: START });
    await store.put("media/keep/a", Buffer.from("image-bytes"));
    await t.db.insert(mediaReferences).values({ profileSnapshotId: profileSnap, role: "avatar", observedAt: START, archiveStatus: "archived", mediaAssetId: asset, sourceProviderCallId: callId, createdAt: START, updatedAt: START });

    expect(store.keys("ods/").length).toBe(2); // request + response
    clock.advance(YEAR_MS + 1000);
    const events: CleanupEvent[] = [];
    const report = await clean(events);

    expect(report).toMatchObject({ payloadsDeleted: 2, callsDeleted: 1, tasksDeleted: 1, objectsDeleted: 2, objectsPendingRetry: 0, skippedNonTerminalTasks: 0 });
    // 一年期事实没了
    expect(await t.db.select().from(odsPayloads)).toHaveLength(0);
    expect(await t.db.select().from(odsProviderCalls)).toHaveLength(0);
    expect(await t.db.select().from(syncTasks)).toHaveLength(0);
    expect(store.keys("ods/")).toEqual([]);
    expect((await t.db.select().from(ossObjects)).filter((o) => o.objectCategory === "ods")).toHaveLength(0);
    // 长期事实还在，引用被置空
    expect(await t.db.select().from(syncBatches)).toHaveLength(1);
    expect(await t.db.select().from(externalAccounts)).toHaveLength(1);
    expect(await t.db.select().from(staffAccountAssignments)).toHaveLength(1);
    expect((await t.db.select().from(accountProfileSnapshots))[0]).toMatchObject({ sourceProviderCallId: null });
    expect((await t.db.select().from(contentSnapshots))[0]).toMatchObject({ lastListProviderCallId: null });
    expect((await t.db.select().from(contentDiscoveries))[0]).toMatchObject({ sourceProviderCallId: null });
    expect((await t.db.select().from(syncCheckpoints))[0]).toMatchObject({ cursorTaskId: null, lastSuccessfulTaskId: null, anchorMode: "empty" });
    expect((await t.db.select().from(dataQualityIssues))[0]).toMatchObject({ providerCallId: null, issueCode: "field_contract_anomaly" });
    expect((await t.db.select().from(mediaReferences))[0]).toMatchObject({ sourceProviderCallId: null, archiveStatus: "archived" });
    expect(await t.db.select().from(mediaAssets)).toHaveLength(1);
    expect((await t.db.select().from(ossObjects)).filter((o) => o.objectCategory === "media")).toHaveLength(1);
    expect(store.keys("media/")).toEqual(["media/keep/a"]); // 正式媒资对象绝不进入 ODS 清理

    // 可审计：每个阶段一条事件，事件里只有计数
    expect(events.map((e) => e.phase)).toEqual(["payloads", "calls", "tasks", "objects"]);
    expect(JSON.stringify(events)).not.toMatch(/HITACHI|v\.douyin/);

    // 幂等重跑
    expect(await clean()).toMatchObject({ payloadsDeleted: 0, callsDeleted: 0, tasksDeleted: 0, objectsDeleted: 0, objectsPendingRetry: 0 });
  });

  it("未到期什么都不删（恰好到期的前一毫秒）；恰好到期即清理", async () => {
    const { clock, gateway, spec, finishRoot, clean } = await setup();
    await gateway.execute(spec());
    await finishRoot();
    clock.advance(YEAR_MS - 1);
    expect(await clean()).toMatchObject({ payloadsDeleted: 0, callsDeleted: 0, tasksDeleted: 0 });
    clock.advance(1);
    expect(await clean()).toMatchObject({ payloadsDeleted: 2, callsDeleted: 1, tasksDeleted: 1 });
  });

  it("多 payload 的调用按整体判断：任一 payload 未到期，调用与其全部载荷都保留", async () => {
    const { clock, gateway, spec, finishRoot, clean, store } = await setup();
    await gateway.execute(spec());
    await finishRoot();
    await t.db.update(odsPayloads).set({ expiresAt: new Date(START.getTime() + YEAR_MS + 86_400_000) }).where(eq(odsPayloads.payloadRole, "response_body"));
    clock.advance(YEAR_MS + 1000);
    expect(await clean()).toMatchObject({ payloadsDeleted: 0, callsDeleted: 0, tasksDeleted: 0 });
    expect(await t.db.select().from(odsPayloads)).toHaveLength(2);
    expect(store.keys("ods/")).toHaveLength(2);
    clock.advance(86_400_000);
    expect(await clean()).toMatchObject({ payloadsDeleted: 2, callsDeleted: 1 });
  });

  it("只有 request payload、没有终态 payload 的调用（prepared / in_flight / ambiguous）按自身截止时间清理", async () => {
    const { clock, gateway, spec, clean, taskId, finishRoot } = await setup();
    await gateway.execute(spec(1));
    const prepared = await insertPreparedCall(t.db, taskId, "douyin", START, 5);
    const ambiguous = await insertPreparedCall(t.db, taskId, "douyin", START, 6);
    await t.db.update(odsProviderCalls).set({ callStatus: "in_flight", sendStartedAt: START }).where(eq(odsProviderCalls.providerCallId, ambiguous));
    await t.db.update(odsProviderCalls).set({ callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: START }).where(eq(odsProviderCalls.providerCallId, ambiguous));
    void prepared;
    await finishRoot();
    clock.advance(YEAR_MS + 1);
    expect(await clean()).toMatchObject({ callsDeleted: 3, tasksDeleted: 1 });
    expect(await t.db.select().from(odsProviderCalls)).toHaveLength(0);
  });

  it("非终态的到期任务不删除并计入 skippedNonTerminalTasks；它的到期调用仍然清理", async () => {
    const { clock, gateway, spec, clean } = await setup();
    await gateway.execute(spec());
    clock.advance(YEAR_MS + 1);
    const r = await clean();
    expect(r).toMatchObject({ tasksDeleted: 0, skippedNonTerminalTasks: 1, callsDeleted: 1 });
    expect(await t.db.select().from(syncTasks)).toHaveLength(1);
  });

  it("子任务与 reconcile 引用：引用方先删、被引用方后删，不触发 FK；被未到期调用引用的调用保留", async () => {
    const { clock, taskId, finishRoot, clean, task } = await setup();
    const a = await insertPreparedCall(t.db, taskId, "douyin", START, 1);
    const b = await insertPreparedCall(t.db, taskId, "douyin", START, 2);
    await t.db.update(odsProviderCalls).set({ callStatus: "in_flight", sendStartedAt: START }).where(eq(odsProviderCalls.providerCallId, a));
    await t.db.update(odsProviderCalls).set({ callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: START }).where(eq(odsProviderCalls.providerCallId, a));
    await t.db.update(odsProviderCalls).set({ callStatus: "terminal", outcome: "reconciled_failed", finishedAt: START, terminalCapturedAt: START, reconciledAt: START, reconciliationMethod: "m", reconciledByProviderCallId: b }).where(eq(odsProviderCalls.providerCallId, a));
    const child = await insertTask(t.db, { batchId: task.batchId, platform: "douyin", now: START, action: "fetch_profile", status: "succeeded" });
    await t.db.update(syncTasks).set({ parentTaskId: taskId }).where(eq(syncTasks.taskId, child));
    await finishRoot();

    // b 比 a 晚到期：a 先清；b 此时未到期，保留
    await t.db.update(odsProviderCalls).set({ expiresAt: new Date(START.getTime() + YEAR_MS + 86_400_000) }).where(eq(odsProviderCalls.providerCallId, b));
    clock.advance(YEAR_MS + 1000);
    expect(await clean()).toMatchObject({ callsDeleted: 1, tasksDeleted: 1 }); // 子任务没有调用，随之清理
    expect((await t.db.select().from(odsProviderCalls)).map((r) => r.providerCallId)).toEqual([b]);
    // root 仍有未清理的调用 → 保留
    expect((await t.db.select().from(syncTasks)).map((r) => r.taskId)).toEqual([taskId]);
    clock.advance(86_400_000);
    expect(await clean()).toMatchObject({ callsDeleted: 1, tasksDeleted: 1 });
    expect(await t.db.select().from(syncTasks)).toHaveLength(0);
  });

  it("引用方未到期而被引用方先到期：被引用方保留，不报错", async () => {
    const { clock, taskId, finishRoot, clean } = await setup();
    const a = await insertPreparedCall(t.db, taskId, "douyin", START, 1);
    const b = await insertPreparedCall(t.db, taskId, "douyin", START, 2);
    await t.db.update(odsProviderCalls).set({ callStatus: "in_flight", sendStartedAt: START }).where(eq(odsProviderCalls.providerCallId, a));
    await t.db.update(odsProviderCalls).set({ callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: START }).where(eq(odsProviderCalls.providerCallId, a));
    await t.db.update(odsProviderCalls).set({ callStatus: "terminal", outcome: "reconciled_succeeded", finishedAt: START, terminalCapturedAt: START, reconciledAt: START, reconciliationMethod: "m", reconciledByProviderCallId: b, expiresAt: new Date(START.getTime() + 2 * YEAR_MS) }).where(eq(odsProviderCalls.providerCallId, a));
    await finishRoot();
    clock.advance(YEAR_MS + 1000);
    const r = await clean();
    expect(r).toMatchObject({ callsDeleted: 0, blockedByReference: 1 }); // b 已到期，但被未到期的 a 引用 → 保留
    expect((await t.db.select().from(odsProviderCalls)).map((x) => x.providerCallId).sort()).toEqual([a, b].sort());
  });
});

describe("远端删除失败：保留记录、下次重试", () => {
  it("远端 delete 失败 → 对象保持 deleting、数据库行不删；故障恢复后重跑完成", async () => {
    const { clock, gateway, spec, finishRoot, clean, store } = await setup();
    await gateway.execute(spec());
    await finishRoot();
    clock.advance(YEAR_MS + 1);
    store.failDelete = () => true;
    const first = await clean();
    expect(first).toMatchObject({ payloadsDeleted: 0, callsDeleted: 0, tasksDeleted: 0, objectsDeleted: 0 });
    expect(first.objectsPendingRetry).toBeGreaterThan(0);
    expect((await t.db.select().from(ossObjects)).every((o) => o.status === "deleting")).toBe(true);
    expect(await t.db.select().from(odsPayloads)).toHaveLength(2);

    store.failDelete = null;
    expect(await clean()).toMatchObject({ payloadsDeleted: 2, callsDeleted: 1, tasksDeleted: 1, objectsDeleted: 2, objectsPendingRetry: 0 });
    expect(store.keys("ods/")).toEqual([]);
  });
});

describe("ODS orphan sweeper（上传成功但数据库短事务失败留下的对象）", () => {
  it("回收超过宽限期、且没有 oss_objects 记录的 ods/ 对象；宽限期内的、已被引用的、非 ods/ 前缀的都不动", async () => {
    const { clock, gateway, spec, store } = await setup();
    await gateway.execute(spec()); // 两个已被引用的对象
    await store.put("ods/orphan-old", Buffer.from("x"));
    clock.advance(2 * 3600 * 1000);
    await store.put("ods/orphan-young", Buffer.from("y"));
    await store.put("media/not-ods", Buffer.from("z"));
    const referenced = store.keys("ods/").filter((k) => !k.startsWith("ods/orphan"));

    const r = await sweepOrphans({ db: t.db, store, clock, graceMs: 3600 * 1000 });
    expect(r).toEqual({ deleted: 1, kept: referenced.length + 1 });
    expect(store.keys("ods/").sort()).toEqual([...referenced, "ods/orphan-young"].sort());
    expect(store.keys("media/")).toEqual(["media/not-ods"]);
    expect(await sweepOrphans({ db: t.db, store, clock, graceMs: 3600 * 1000 })).toMatchObject({ deleted: 0 });
  });
});
