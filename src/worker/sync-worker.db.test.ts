import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../tests/harness/db";
import { FakeClock } from "../../tests/harness/fake-clock";
import { seedOrg, seedSyncSettings, type OrgSeed } from "../../tests/harness/seed";
import { addExternalAccount, addStaffAccount } from "../../tests/harness/sync-fixtures";
import { createDb, createPool } from "../db/client";
import { odsProviderCalls, staffAccountAssignments, syncBatches, syncTasks } from "../db/schema";
import { createMonitoringResolver } from "../modules/monitoring";
import { claimNext, heartbeat, withFences } from "../modules/orchestrator";
import { insertPreparedCall } from "../../tests/harness/factories";
import type { RunnerOutcome, RunnerRegistry, TaskContext, TaskRunner } from "../modules/sync-runner";
import { createSyncScheduler, type SyncRuntime } from "../modules/sync-schedule";
import { createBreakerSet } from "./provider-breaker";
import { createSyncWorker } from "./sync-worker";

const t = useTestDb();
const S1 = new Date("2026-11-08T18:00:00Z");
const runtime: SyncRuntime = { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } };
const RETRY = { baseBackoffMs: 1000, maxBackoffMs: 8000 };
const LEASE = 60_000;

interface Opts {
  concurrency?: number;
  breaker?: { failures: number; cooldownMs: number };
}
async function world(runners: RunnerRegistry, opts: Opts = {}) {
  const org = await seedOrg(t.db, S1);
  await seedSyncSettings(t.db, S1);
  const clock = new FakeClock(S1);
  const resolver = createMonitoringResolver(t.db);
  const scheduler = createSyncScheduler({ db: t.db, clock, resolver, runtime });
  const breakers = createBreakerSet({ failures: opts.breaker?.failures ?? 1000, cooldownMs: opts.breaker?.cooldownMs ?? 1000, nowMs: () => clock.now().getTime() });
  const worker = createSyncWorker({
    db: t.db,
    clock,
    resolver,
    runners,
    breakers,
    workerId: "w1",
    concurrency: opts.concurrency ?? 1,
    mediaConcurrency: 1,
    leaseMs: LEASE,
    retry: RETRY,
    idlePollMs: 10,
    sleep: async () => {},
  });
  return { org, clock, resolver, scheduler, breakers, worker };
}
/** 三个 staff 账号 + 一个 external：周期批次 7 个任务（6 个 staff + 1 个 external 主页）。 */
async function accounts(org: OrgSeed) {
  const a = await addStaffAccount(t.db, { platform: "douyin", staffId: org.staffA, now: S1 });
  const b = await addStaffAccount(t.db, { platform: "xiaohongshu", staffId: org.staffB, now: S1 });
  const c = await addStaffAccount(t.db, { platform: "kuaishou", staffId: org.staffC, now: S1 });
  const e = await addExternalAccount(t.db, { platform: "kuaishou", now: S1 });
  return { a, b, c, e };
}
const done: TaskRunner = async () => ({ kind: "done" });
const allTasks = () => t.db.select().from(syncTasks).orderBy(syncTasks.taskId);
const byId = async (id: bigint) => (await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, id)))[0]!;
/** 让 Runner 也真的把任务写成终态（框架只负责失败路径，成功终态由 Runner 写）。 */
const finishing =
  (inner: (ctx: TaskContext) => Promise<RunnerOutcome> | RunnerOutcome = () => ({ kind: "done" })): TaskRunner =>
  async (ctx) => {
    const out = await inner(ctx);
    if (out.kind === "done") {
      await withFences(ctx.db, ctx.clock, [{ taskId: ctx.task.taskId, token: ctx.token }], async (tx) => {
        await tx.update(syncTasks).set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null, finishedAt: ctx.clock.now(), updatedAt: ctx.clock.now() }).where(eq(syncTasks.taskId, ctx.task.taskId));
      });
    }
    return out;
  };

describe("claimNext：SKIP LOCKED、排序、范围", () => {
  it("两个独立连接顺序领取同一批任务：没有任务被领取两次，合起来恰好是全部", async () => {
    const w = await world({ fetch_profile: done, fetch_content_list: done });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const other = createPool(process.env.HBECHO_TEST_DATABASE_URL!);
    try {
      const db2 = createDb(other);
      const mine = [];
      const theirs = [];
      for (let i = 0; i < 4; i++) {
        mine.push(...(await claimNext(t.db, { workerId: "w1", leaseMs: LEASE, now: S1, limit: 1, actions: ["fetch_profile", "fetch_content_list"] })));
        theirs.push(...(await claimNext(db2, { workerId: "w2", leaseMs: LEASE, now: S1, limit: 1, actions: ["fetch_profile", "fetch_content_list"] })));
      }
      const ids = [...mine, ...theirs].map((c) => c.task.taskId);
      expect(ids).toHaveLength(7);
      expect(new Set(ids).size).toBe(7);
      expect((await allTasks()).every((x) => x.status === "running" && x.fencingToken === 1n)).toBe(true);
    } finally {
      await other.end();
    }
  });

  it("排序：priority 降序，然后 attempt_count 升序（重试任务回到队尾），然后 task_id", async () => {
    const w = await world({});
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const tasks = await allTasks();
    await t.db.update(syncTasks).set({ priority: 100 }).where(eq(syncTasks.taskId, tasks[5]!.taskId));
    await t.db.update(syncTasks).set({ attemptCount: 1, status: "retry_wait", nextAttemptAt: S1 }).where(eq(syncTasks.taskId, tasks[0]!.taskId));
    const order = [];
    for (let i = 0; i < 7; i++) order.push(...(await claimNext(t.db, { workerId: "w", leaseMs: LEASE, now: S1, limit: 1, actions: ["fetch_profile", "fetch_content_list"] })).map((c) => c.task.taskId));
    expect(order).toEqual([tasks[5]!.taskId, ...tasks.slice(1).filter((x) => x.taskId !== tasks[5]!.taskId).map((x) => x.taskId), tasks[0]!.taskId]);
  });

  it("只领已注册的动作；未到下一次尝试时间的 retry_wait 不领；排除的动作不领", async () => {
    const w = await world({});
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const claim = (o: Partial<Parameters<typeof claimNext>[1]>) => claimNext(t.db, { workerId: "w", leaseMs: LEASE, now: S1, limit: 100, actions: ["fetch_profile"], ...o });
    expect(await claim({ actions: ["download_media"] })).toEqual([]);
    expect(await claim({ actions: ["fetch_profile"], excludeActions: ["fetch_profile"] })).toEqual([]);
    const [first] = await allTasks();
    await t.db.update(syncTasks).set({ status: "retry_wait", attemptCount: 1, nextAttemptAt: new Date(S1.getTime() + 5000) }).where(eq(syncTasks.taskId, first!.taskId));
    const got = (await claim({ actions: ["fetch_profile", "fetch_content_list"] })).map((c) => c.task.taskId);
    expect(got).not.toContain(first!.taskId);
    expect(got).toHaveLength(6);
  });

  it("只领 running 的周期 / 补抓 / 按需批次；tracer 的 intake 批次和已取消 / 排队中的批次不归本 worker", async () => {
    const w = await world({});
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const [batch] = await t.db.select().from(syncBatches);
    const claim = () => claimNext(t.db, { workerId: "w", leaseMs: LEASE, now: S1, limit: 100, actions: ["fetch_profile", "fetch_content_list"] });
    for (const status of ["queued", "cancelled", "succeeded", "skipped"]) {
      await t.db.update(syncBatches).set({ status }).where(eq(syncBatches.batchId, batch!.batchId));
      expect(await claim(), status).toEqual([]);
    }
    await t.db.update(syncBatches).set({ status: "running", purpose: "intake" }).where(eq(syncBatches.batchId, batch!.batchId));
    expect(await claim()).toEqual([]);
    await t.db.update(syncBatches).set({ purpose: "full" }).where(eq(syncBatches.batchId, batch!.batchId));
    expect(await claim()).toHaveLength(7);
  });

  it("媒资任务可以领已终态（未取消）批次里的任务；其他动作不行", async () => {
    const w = await world({});
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const [batch] = await t.db.select().from(syncBatches);
    const [one] = await allTasks();
    await t.db.update(syncTasks).set({ requestedAction: "download_media" }).where(eq(syncTasks.taskId, one!.taskId));
    await t.db.update(syncBatches).set({ status: "partial_succeeded" }).where(eq(syncBatches.batchId, batch!.batchId));
    const got = await claimNext(t.db, { workerId: "w", leaseMs: LEASE, now: S1, limit: 100, actions: ["download_media", "fetch_profile"] });
    expect(got.map((c) => c.task.taskId)).toEqual([one!.taskId]);
    await t.db.update(syncBatches).set({ status: "cancelled" }).where(eq(syncBatches.batchId, batch!.batchId));
    await t.db.update(syncTasks).set({ status: "pending", leaseOwner: null, leaseExpiresAt: null }).where(eq(syncTasks.taskId, one!.taskId));
    expect(await claimNext(t.db, { workerId: "w", leaseMs: LEASE, now: S1, limit: 100, actions: ["download_media"] })).toEqual([]);
  });

  it("熔断排除 provider：调用供应商的任务不领，媒资下载不受影响", async () => {
    const w = await world({});
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const [batch] = await t.db.select().from(syncBatches);
    const [one] = await allTasks();
    await t.db.update(syncTasks).set({ requestedAction: "download_media" }).where(eq(syncTasks.taskId, one!.taskId));
    await t.db.update(syncBatches).set({ status: "running" }).where(eq(syncBatches.batchId, batch!.batchId));
    const got = await claimNext(t.db, { workerId: "w", leaseMs: LEASE, now: S1, limit: 100, actions: ["download_media", "fetch_profile"], excludeProviderIds: [one!.providerId] });
    expect(got.map((c) => c.task.taskId)).toEqual([one!.taskId]);
  });
});

describe("租约、fencing、陈旧 worker（FS-3.3/3.4）", () => {
  it("租约过期后被另一个 worker 接手：token 递增；原 worker 的心跳、fenced 写入全部被拒", async () => {
    const w = await world({});
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const [first] = await claimNext(t.db, { workerId: "old", leaseMs: LEASE, now: S1, limit: 1, actions: ["fetch_profile"] });
    expect(first!.token).toBe(1n);
    const later = new Date(S1.getTime() + LEASE + 1);
    const taken = (await claimNext(t.db, { workerId: "new", leaseMs: LEASE, now: later, limit: 100, actions: ["fetch_profile"] })).find((c) => c.task.taskId === first!.task.taskId);
    expect(taken).toMatchObject({ token: 2n, tookOver: true });
    expect(await heartbeat(t.db, first!.task.taskId, 1n, { now: later, leaseMs: LEASE })).toBe("stale");
    const clock = new FakeClock(later);
    const stale = await withFences(t.db, clock, [{ taskId: first!.task.taskId, token: 1n }], async (tx) => {
      await tx.update(syncTasks).set({ status: "succeeded" }).where(eq(syncTasks.taskId, first!.task.taskId));
    });
    expect(stale.ok).toBe(false);
    expect((await byId(first!.task.taskId)).status).toBe("running"); // 陈旧写入整笔没有生效
    expect((await withFences(t.db, clock, [{ taskId: first!.task.taskId, token: 2n }], async () => "ok")).ok).toBe(true);
  });

  it("批次取消后，在途任务的下一次心跳得到 cancelled，不应再发调用", async () => {
    let seen: string | null = null;
    const w = await world({
      fetch_profile: async (ctx) => {
        expect(await ctx.heartbeat()).toBe("ok");
        await t.db.update(syncTasks).set({ status: "cancelled", fencingToken: ctx.token + 1n, leaseOwner: null, leaseExpiresAt: null }).where(eq(syncTasks.taskId, ctx.task.taskId));
        seen = await ctx.heartbeat();
        return { kind: "abandoned", reason: "cancelled" };
      },
    });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const stats = await w.worker.run({ untilIdle: true });
    expect(seen).toBe("cancelled");
    expect(stats.abandoned).toBeGreaterThan(0);
  });
});

describe("worker：失败映射、重试回队尾、死信（FS-12）", () => {
  it("可重试失败 → retry_wait，attempt+1，退避；第 3 个任务首次失败，其余任务都先完成首次尝试，它的第二次排在最后", async () => {
    const order: Array<[bigint, number]> = [];
    let failedOnce = false;
    let victim: bigint | null = null;
    const w = await world({
      fetch_profile: finishing((ctx) => {
        order.push([ctx.task.taskId, ctx.task.attemptCount]);
        if (!failedOnce && order.length === 3) {
          failedOnce = true;
          victim = ctx.task.taskId;
          return { kind: "failure", code: "rate_limited" };
        }
        return { kind: "done" };
      }),
      fetch_content_list: finishing(),
    });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const first = await w.worker.run({ untilIdle: true });
    expect(first).toMatchObject({ done: 6, retry_wait: 1 });
    const row = await byId(victim!);
    expect(row).toMatchObject({ status: "retry_wait", attemptCount: 1, lastErrorCode: "rate_limited", leaseOwner: null });
    expect(row.nextAttemptAt!.getTime()).toBe(S1.getTime() + RETRY.baseBackoffMs);
    // 退避期内不再被领取
    expect((await w.worker.run({ untilIdle: true })).claimed).toBe(0);
    w.clock.advance(RETRY.baseBackoffMs);
    const second = await w.worker.run({ untilIdle: true });
    expect(second.done).toBe(1);
    // 除了 victim，每个任务只有一次尝试；victim 的两次尝试分别是第一次（第 3 个）和最后
    expect(order.map(([id]) => id).filter((id) => id === victim)).toHaveLength(2);
    expect(order.at(-1)).toEqual([victim, 1]);
    expect(order.findIndex(([id]) => id === victim)).toBe(2);
    expect(new Set(order.slice(0, -1).map(([id]) => id)).size).toBe(order.length - 1);
  });

  it("额度用尽 → dead；不可重试 → failed；两者都记 last_error_code，且 attempt_count 不超过 max_attempts", async () => {
    const w = await world({
      fetch_profile: async (ctx) => ({ kind: "failure", code: ctx.task.accountId === null ? "rate_limited" : "provider_server_error" }),
      fetch_content_list: async () => ({ kind: "failure", code: "provider_input_inaccessible" }),
    });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    for (let i = 0; i < 4; i++) {
      await w.worker.run({ untilIdle: true });
      w.clock.advance(RETRY.maxBackoffMs);
    }
    const tasks = await allTasks();
    const profiles = tasks.filter((x) => x.requestedAction === "fetch_profile");
    const lists = tasks.filter((x) => x.requestedAction === "fetch_content_list");
    expect(profiles.every((x) => x.status === "dead" && x.attemptCount === 3 && x.lastErrorCode === "provider_server_error" && x.finishedAt !== null)).toBe(true);
    expect(lists.every((x) => x.status === "failed" && x.attemptCount === 1 && x.lastErrorCode === "provider_input_inaccessible")).toBe(true);
  });

  it("没有发出调用的失败不消耗额度：budget_exhausted → failed，attempt_count 保持 0", async () => {
    const w = await world({ fetch_profile: async () => ({ kind: "failure", code: "budget_exhausted" }), fetch_content_list: done });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    await w.worker.run({ untilIdle: true });
    const profiles = (await allTasks()).filter((x) => x.requestedAction === "fetch_profile");
    expect(profiles.every((x) => x.status === "failed" && x.attemptCount === 0 && x.lastErrorCode === "budget_exhausted")).toBe(true);
  });

  it("Runner 抛出未预期异常：按 runner_error 有界重试，不会无限重跑，也不会拖垮 worker", async () => {
    let calls = 0;
    const w = await world({
      fetch_profile: async () => {
        calls++;
        throw new Error("boom password=secret");
      },
    });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    for (let i = 0; i < 5; i++) {
      await w.worker.run({ untilIdle: true });
      w.clock.advance(RETRY.maxBackoffMs);
    }
    const profiles = (await allTasks()).filter((x) => x.requestedAction === "fetch_profile");
    expect(profiles.every((x) => x.status === "dead" && x.attemptCount === 3)).toBe(true);
    expect(calls).toBe(profiles.length * 3);
    expect(JSON.stringify(profiles.map((x) => x.lastErrorDetail))).not.toContain("secret"); // 只记错误类型，不记消息
  });

  it("资格复核：领取前账号被关闭监控 → cancelled / monitoring_closed，Runner 一次都不调用", async () => {
    let ran = 0;
    const w = await world({ fetch_profile: async () => (ran++, { kind: "done" }), fetch_content_list: async () => (ran++, { kind: "done" }) });
    const acc = await accounts(w.org);
    await w.scheduler.tick(S1);
    await t.db.update(staffAccountAssignments).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(staffAccountAssignments.accountId, acc.b.accountId));
    const stats = await w.worker.run({ untilIdle: true });
    const closed = (await allTasks()).filter((x) => x.accountId === acc.b.accountId);
    expect(closed).toHaveLength(2);
    expect(closed.every((x) => x.status === "cancelled" && x.lastErrorCode === "monitoring_closed" && x.attemptCount === 0)).toBe(true);
    expect(stats.cancelled).toBe(2);
    expect(ran).toBe(5); // 另外 5 个任务正常交给 Runner
  });
});

describe("熔断（FS-3.7，design §7.5.1）", () => {
  it("连续 K 次供应商级失败 → 停止领取；其余任务保持 pending 且 attempt_count 不变；冷却后只放行一个探测，成功后恢复", async () => {
    let mode: "fail" | "ok" = "fail";
    const calls: bigint[] = [];
    const w = await world(
      { fetch_profile: finishing((ctx) => (calls.push(ctx.task.taskId), mode === "fail" ? { kind: "failure", code: "provider_server_error" } : { kind: "done" })), fetch_content_list: finishing(() => ({ kind: "done" })) },
      { breaker: { failures: 3, cooldownMs: 10_000 } },
    );
    await accounts(w.org);
    await w.scheduler.tick(S1);
    // 只有 profile 的 Runner 会失败；让 list 任务先不参与：把它们从本次运行里去掉
    await t.db.update(syncTasks).set({ priority: -1 }).where(eq(syncTasks.requestedAction, "fetch_content_list"));
    const s1 = await w.worker.run({ untilIdle: true });
    expect(calls).toHaveLength(3); // 前 3 次失败后熔断打开，不再领取
    expect(s1.retry_wait).toBe(3);
    const rest = (await allTasks()).filter((x) => x.status === "pending");
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((x) => x.attemptCount === 0)).toBe(true); // 熔断期间不消耗额度
    expect(w.breakers.get((await allTasks())[0]!.providerId.toString()).state).toBe("open");

    // 冷却期内什么都不领
    w.clock.advance(5000);
    expect((await w.worker.run({ untilIdle: true })).claimed).toBe(0);
    // 冷却后：只放行一个探测（仍失败 → 重新打开）
    w.clock.advance(5000);
    const probe = await w.worker.run({ untilIdle: true });
    expect(probe.claimed).toBe(1);
    expect(calls).toHaveLength(4);
    expect(w.breakers.get((await allTasks())[0]!.providerId.toString()).state).toBe("open");
    // 恢复：下一个冷却期后探测成功 → 关闭熔断 → 其余任务正常跑完
    mode = "ok";
    w.clock.advance(10_000);
    const recovered = await w.worker.run({ untilIdle: true });
    expect(recovered.done).toBeGreaterThanOrEqual(2);
    expect(w.breakers.get((await allTasks())[0]!.providerId.toString()).state).toBe("closed");
  });

  it("账号级失败（RESULT_VALIDATION_FAILED 一类）连续出现不触发熔断", async () => {
    const calls: number[] = [];
    const w = await world({ fetch_profile: async () => (calls.push(1), { kind: "failure", code: "provider_validation_failed" }), fetch_content_list: done }, { breaker: { failures: 2, cooldownMs: 10_000 } });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    await w.worker.run({ untilIdle: true });
    expect(calls).toHaveLength(4); // 4 个主页任务每个跑了一次，没有被熔断拦下
    expect(w.breakers.get((await allTasks())[0]!.providerId.toString()).state).toBe("closed");
  });
});

describe("并发、优雅停机、崩溃恢复", () => {
  it("并发上限：同时在途的任务不超过 concurrency", async () => {
    let live = 0;
    let peak = 0;
    const runner = finishing(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return { kind: "done" };
    });
    const w = await world({ fetch_profile: runner, fetch_content_list: runner }, { concurrency: 3 });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const stats = await w.worker.run({ untilIdle: true });
    expect(stats.done).toBe(7);
    expect(peak).toBe(3);
  });

  it("优雅停机：停止领取，等待在途至多宽限期；放弃的任务不改状态（仍 running，租约到期后可被重新领取）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sawStop = false;
    const w = await world({
      fetch_profile: async (ctx) => {
        await gate;
        sawStop = ctx.shouldStop();
        return { kind: "abandoned", reason: "shutdown" };
      },
      fetch_content_list: done,
    });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const running = w.worker.run({ untilIdle: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.worker.inflightCount).toBe(1);
    const claimedBefore = (await allTasks()).filter((x) => x.status === "running").length;
    const result = await w.worker.stop(0);
    expect(result.abandoned).toBe(1);
    release();
    await running;
    expect(sawStop).toBe(true);
    const after = await allTasks();
    expect(after.filter((x) => x.status === "running")).toHaveLength(claimedBefore); // 状态没有被改写
    expect(after.filter((x) => x.status === "running")[0]!.leaseExpiresAt!.getTime()).toBe(S1.getTime() + LEASE);
    // 租约过期后，另一个 worker 可以领走
    const taken = await claimNext(t.db, { workerId: "w2", leaseMs: LEASE, now: new Date(S1.getTime() + LEASE + 1), limit: 100, actions: ["fetch_profile"] });
    expect(taken.some((c) => c.tookOver)).toBe(true);
  });

  it("接手自失联 worker 的任务：先把停在 in_flight 的调用标为 ambiguous，再交给 Runner", async () => {
    const seen: string[] = [];
    const w = await world({
      fetch_profile: finishing(async (ctx) => {
        const calls = await t.db.select().from(odsProviderCalls).where(eq(odsProviderCalls.syncTaskId, ctx.task.taskId));
        seen.push(...calls.map((c) => c.callStatus));
        return { kind: "done" };
      }),
      fetch_content_list: finishing(),
    });
    await accounts(w.org);
    await w.scheduler.tick(S1);
    // 旧 worker 领取并发出了调用，然后失联
    const [old] = await claimNext(t.db, { workerId: "dead", leaseMs: LEASE, now: S1, limit: 1, actions: ["fetch_profile"] });
    const callId = await insertPreparedCall(t.db, old!.task.taskId, "douyin", S1);
    await t.db.update(odsProviderCalls).set({ callStatus: "in_flight", sendStartedAt: S1 }).where(eq(odsProviderCalls.providerCallId, callId));
    w.clock.advance(LEASE + 1);
    await w.worker.run({ untilIdle: true });
    expect(seen).toContain("ambiguous");
    expect(seen).not.toContain("in_flight");
    const [call] = await t.db.select().from(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, callId));
    expect(call).toMatchObject({ callStatus: "ambiguous", outcome: "ambiguous" }); // 原调用保留，不被改写成成功或失败
  });

  it("空注册表：worker 什么都不领，任务保持 pending", async () => {
    const w = await world({});
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const stats = await w.worker.run({ untilIdle: true });
    expect(stats.claimed).toBe(0);
    expect((await allTasks()).every((x) => x.status === "pending")).toBe(true);
  });
});
