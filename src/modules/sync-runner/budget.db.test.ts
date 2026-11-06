// 批次预算（FS-16.4）：真实网关 + fixture transport 验证「达到上限在下一次调用前停止」——断言 transport 的调用数，不是任务状态。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../tests/harness/fake-oss";
import { FixtureTransport } from "../../../tests/harness/fixture-transport";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { seedOrg, seedSyncSettings } from "../../../tests/harness/seed";
import { addExternalAccount, addStaffAccount } from "../../../tests/harness/sync-fixtures";
import { createDb, createPool } from "../../db/client";
import { syncBatches, syncTasks } from "../../db/schema";
import { createBreakerSet } from "../../worker/provider-breaker";
import { createSyncWorker } from "../../worker/sync-worker";
import { createMonitoringResolver } from "../monitoring";
import { buildRequest } from "../provider-adapter";
import { RawCaptureGateway } from "../raw-capture";
import { createSyncScheduler } from "../sync-schedule";
import { withFences } from "../orchestrator";
import { createBatchBudgetPolicy, isBudgetReason, spentForBatch } from "./budget";
import type { TaskRunner } from "./types";

const t = useTestDb();
const S1 = new Date("2026-11-08T18:00:00Z");
const PROFILE_PATH = "/openapi/v1/media_user_info";

async function world(limits: { maxCalls: number; maxPoints: number }, respond?: (callIndex: number) => { httpStatus: number; body: Uint8Array }) {
  const org = await seedOrg(t.db, S1);
  await seedSyncSettings(t.db, S1);
  const clock = new FakeClock(S1);
  const transport = new FixtureTransport();
  const ok = loadFixtureBytes("raw3.douyin.media_user_info");
  transport.register({ path: PROFILE_PATH, query: { async: "false" } }, (_r, i) => respond?.(i) ?? { httpStatus: 200, body: ok });
  const gateway = new RawCaptureGateway({
    db: t.db,
    store: new FakeObjectStore(clock),
    transport,
    clock,
    location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-test" },
    policy: createBatchBudgetPolicy(t.db, limits),
  });
  // 一个只做「发一次主页调用」的 Runner：预算封口 → budget_exhausted；其余按 HTTP 状态映射
  const runner: TaskRunner = async (ctx) => {
    const out = await gateway.execute({
      syncTaskId: ctx.task.taskId,
      fencingToken: ctx.token,
      platformId: ctx.task.platformId,
      providerId: ctx.task.providerId,
      attemptNo: ctx.task.attemptCount + 1,
      callSequence: 1,
      requestedAction: "media_user_info",
      expectedResponseAction: "media_user_info",
      request: buildRequest({ action: "media_user_info", mode: "synchronous", locator: "https://v.douyin.com/x/" }),
    });
    if (out.kind === "not_sent") return { kind: "failure", code: isBudgetReason(out.reason) ? "budget_exhausted" : "runner_error" };
    if (out.kind !== "captured") return { kind: "failure", code: "runner_error" };
    if (out.captured.httpStatus === 429) return { kind: "failure", code: "rate_limited" };
    await withFences(ctx.db, ctx.clock, [{ taskId: ctx.task.taskId, token: ctx.token }], async (tx) => {
      await tx.update(syncTasks).set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null, finishedAt: clock.now(), updatedAt: clock.now() }).where(eq(syncTasks.taskId, ctx.task.taskId));
    });
    return { kind: "done" };
  };
  const resolver = createMonitoringResolver(t.db);
  const scheduler = createSyncScheduler({ db: t.db, clock, resolver, runtime: { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } } });
  const worker = createSyncWorker({
    db: t.db,
    clock,
    resolver,
    runners: { fetch_profile: runner },
    breakers: createBreakerSet({ failures: 1000, cooldownMs: 1000, nowMs: () => clock.now().getTime() }),
    workerId: "w1",
    concurrency: 1,
    mediaConcurrency: 1,
    leaseMs: 60_000,
    retry: { baseBackoffMs: 1000, maxBackoffMs: 8000 },
    idlePollMs: 10,
    sleep: async () => {},
  });
  // 三个 staff 账号（抖音 10 点、小红书 15 点、快手 10 点）+ 一个 external：4 个主页任务，只让主页 Runner 跑
  const a = await addStaffAccount(t.db, { platform: "douyin", staffId: org.staffA, now: S1 });
  const b = await addStaffAccount(t.db, { platform: "xiaohongshu", staffId: org.staffB, now: S1 });
  const c = await addStaffAccount(t.db, { platform: "kuaishou", staffId: org.staffC, now: S1 });
  await addExternalAccount(t.db, { platform: "kuaishou", now: S1 });
  await scheduler.tick(S1);
  return { clock, transport, worker, accounts: { a, b, c } };
}
const profiles = async () => (await t.db.select().from(syncTasks).orderBy(syncTasks.taskId)).filter((x) => x.requestedAction === "fetch_profile");

describe("批次调用数上限", () => {
  it("maxCalls=2：第 3 次调用在发出之前被封口（transport 只收到 2 次），后续任务 failed / budget_exhausted 且不消耗额度", async () => {
    const w = await world({ maxCalls: 2, maxPoints: 1_000_000 });
    const stats = await w.worker.run({ untilIdle: true });
    expect(w.transport.calls).toHaveLength(2);
    expect(stats).toMatchObject({ done: 2, failed: 2 });
    const p = await profiles();
    expect(p.filter((x) => x.status === "succeeded")).toHaveLength(2);
    const blocked = p.filter((x) => x.status === "failed");
    expect(blocked.every((x) => x.lastErrorCode === "budget_exhausted" && x.attemptCount === 0)).toBe(true);
  });
});

describe("批次点数上限", () => {
  it("抖音 10 + 小红书 15 = 25：预算 25 点刚好够；下一次（快手 10 点）会超出，发送前被封口", async () => {
    const w = await world({ maxCalls: 1000, maxPoints: 25 });
    await w.worker.run({ untilIdle: true });
    expect(w.transport.calls).toHaveLength(2);
    const p = await profiles();
    expect(p.map((x) => x.status)).toEqual(["succeeded", "succeeded", "failed", "failed"]);
  });
  it("预算 24 点：小红书（15 点）放不下，在发送前被封口；仍放得下的快手（10 点）继续——总花费永远不超过上限", async () => {
    const w = await world({ maxCalls: 1000, maxPoints: 24 });
    await w.worker.run({ untilIdle: true });
    expect(w.transport.calls).toHaveLength(2); // 抖音 10 + 快手 10 = 20 ≤ 24
    const p = await profiles();
    expect(p.map((x) => [x.status, x.lastErrorCode])).toEqual([["succeeded", null], ["failed", "budget_exhausted"], ["succeeded", null], ["failed", "budget_exhausted"]]);
  });
  it("失败（429）的调用不计点：第一次 429、之后成功，10 点预算内仍能完成一次成功调用", async () => {
    const ok = loadFixtureBytes("raw3.douyin.media_user_info");
    const w = await world({ maxCalls: 1000, maxPoints: 10 }, (i) => (i === 0 ? { httpStatus: 429, body: new TextEncoder().encode('{"code":"RATE_LIMITED"}') } : { httpStatus: 200, body: ok }));
    const stats = await w.worker.run({ untilIdle: true });
    expect(stats.retry_wait).toBe(1); // 第 1 个任务 429 → 重试
    expect(w.transport.calls).toHaveLength(2); // 429 一次 + 成功一次（10 点）；其后的调用被点数封口
    const p = await profiles();
    expect(p.filter((x) => x.status === "succeeded")).toHaveLength(1);
  });
});

describe("spentForBatch", () => {
  it("只统计本批次；被封口（not_sent）的调用不算；正在发送的调用要算（保守）", async () => {
    const w = await world({ maxCalls: 1, maxPoints: 1_000_000 });
    await w.worker.run({ untilIdle: true });
    const [batch] = await t.db.select().from(syncBatches);
    expect(await spentForBatch(t.db, batch!.batchId)).toEqual({ calls: 1, polls: 0, points: 10 });
    const other = createPool(process.env.HBECHO_TEST_DATABASE_URL!);
    try {
      expect(await spentForBatch(createDb(other), 999_999n)).toEqual({ calls: 0, polls: 0, points: 0 });
    } finally {
      await other.end();
    }
  });
});
