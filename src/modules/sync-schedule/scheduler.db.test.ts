import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertBatch, insertTask } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { seedOrg, seedSyncSettings, type OrgSeed } from "../../../tests/harness/seed";
import { addExternalAccount, addStaffAccount, settleTasks } from "../../../tests/harness/sync-fixtures";
import { staffAccountAssignments, syncBatches, syncSettings, syncTasks } from "../../db/schema";
import { createMonitoringResolver, type MonitoringResolver } from "../monitoring";
import { SyncError } from "./errors";
import { createSyncScheduler } from "./scheduler";
import type { SyncRuntime } from "./settings";
import { fullBatchKey } from "./task-keys";

const t = useTestDb();
// 北京时间 2026-11-09（周一）02:00 = UTC 2026-11-08T18:00；seedSyncSettings 的时点是每周一 02:00
const S1 = new Date("2026-11-08T18:00:00Z");
const WEEK = 7 * 24 * 3600_000;
const S2 = new Date(S1.getTime() + WEEK);
const S3 = new Date(S1.getTime() + 2 * WEEK);
const runtime: SyncRuntime = { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } };

async function world(opts: { chunkSize?: number; resolver?: (r: MonitoringResolver) => MonitoringResolver } = {}) {
  const org = await seedOrg(t.db, S1);
  await seedSyncSettings(t.db, S1);
  const clock = new FakeClock(S1);
  const real = createMonitoringResolver(t.db);
  const scheduler = createSyncScheduler({
    db: t.db,
    clock,
    resolver: opts.resolver ? opts.resolver(real) : real,
    runtime,
    ...(opts.chunkSize === undefined ? {} : { chunkSize: opts.chunkSize }),
  });
  return { org, clock, scheduler, resolver: real };
}
/** 三个 staff 账号 + 一个 external 账号：周期批次应有 3×2 + 1 = 7 个任务。 */
async function accounts(org: OrgSeed) {
  const a = await addStaffAccount(t.db, { platform: "douyin", staffId: org.staffA, now: S1 });
  const b = await addStaffAccount(t.db, { platform: "xiaohongshu", staffId: org.staffB, now: S1 });
  const c = await addStaffAccount(t.db, { platform: "kuaishou", staffId: org.staffC, now: S1 });
  const e = await addExternalAccount(t.db, { platform: "kuaishou", now: S1 });
  return { a, b, c, e };
}
const batches = () => t.db.select().from(syncBatches).orderBy(syncBatches.batchId);
const tasksOf = (batchId: bigint) => t.db.select().from(syncTasks).where(eq(syncTasks.batchId, batchId));

describe("tick：创建、幂等、规划（FS-1.1/1.2/1.3/1.10）", () => {
  it("同一时点连续 tick 三次只有一个 full 批次；批次键由时点 UTC 值确定；任务按目标集规划", async () => {
    const { org, scheduler } = await world();
    const acc = await accounts(org);
    const r1 = await scheduler.tick(S1);
    await scheduler.tick(S1);
    await scheduler.tick(new Date(S1.getTime() + 60_000));
    const all = await batches();
    expect(all).toHaveLength(1);
    const b = all[0]!;
    expect(b.batchKey.equals(fullBatchKey(S1))).toBe(true);
    expect(b).toMatchObject({ purpose: "full", triggerType: "scheduled", status: "running", plannedTaskCount: 7 });
    expect(b.logicalAt.getTime()).toBe(S1.getTime());
    expect(b.startedAt).not.toBeNull();
    expect(r1.created).toEqual([{ batchId: b.batchId.toString(), status: "planned", slot: S1.toISOString(), skipReason: null }]);

    const tasks = await tasksOf(b.batchId);
    expect(tasks).toHaveLength(7);
    const byAccount = (id: bigint) => tasks.filter((x) => x.accountId === id).map((x) => x.requestedAction).sort();
    expect(byAccount(acc.a.accountId)).toEqual(["fetch_content_list", "fetch_profile"]);
    expect(byAccount(acc.c.accountId)).toEqual(["fetch_content_list", "fetch_profile"]);
    // external 型只有主页任务（R7）
    expect(byAccount(acc.e.accountId)).toEqual(["fetch_profile"]);
    expect(new Set(tasks.map((x) => x.idempotencyKey.toString("hex"))).size).toBe(7);
    expect(tasks.every((x) => x.status === "pending" && x.priority === 0 && x.maxAttempts === 3 && x.attemptCount === 0)).toBe(true);
  });

  it("任务参数在规划时固化：模式取自运行时配置；列表任务带安全页数、首次上限和旧检查点快照（此处无检查点）", async () => {
    const { org, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    const tasks = await t.db.select().from(syncTasks);
    const profile = tasks.find((x) => x.requestedAction === "fetch_profile")!;
    const list = tasks.find((x) => x.requestedAction === "fetch_content_list")!;
    expect(profile.taskParameters).toEqual({ schema_version: "sync-profile-task.v1", mode: "synchronous" });
    expect(list.taskParameters).toEqual({
      schema_version: "sync-list-task.v1",
      mode: "synchronous",
      initial_content_limit: 20,
      safety_page_limit: 5,
      anchor_snapshot: null,
    });
  });

  it("时点已过 30 分钟（超出容忍窗口）才首次 tick：不创建批次，不补跑（FS-1.3）", async () => {
    const { org, scheduler } = await world();
    await accounts(org);
    const r = await scheduler.tick(new Date(S1.getTime() + 30 * 60_000));
    expect(r.created).toEqual([]);
    expect(await batches()).toEqual([]);
  });

  it("批次创建时冻结设置：之后改 sync_settings 不影响该批次的任务；新批次读到新值（FS-1.2）", async () => {
    const { org, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    await t.db.update(syncSettings).set({ listSafetyPageLimit: 9 }).where(eq(syncSettings.settingsId, 1));
    const [a] = await batches();
    expect((a!.settingsSnapshot as Record<string, unknown>).list_safety_page_limit).toBe(5);
    expect((await tasksOf(a!.batchId)).filter((x) => x.requestedAction === "fetch_content_list").every((x) => (x.taskParameters as { safety_page_limit: number }).safety_page_limit === 5)).toBe(true);

    await settleTasks(t.db, a!.batchId, { status: "succeeded" }, S2);
    await scheduler.tick(S2);
    const second = (await batches())[1]!;
    expect(second.status).toBe("running");
    expect((second.settingsSnapshot as Record<string, unknown>).list_safety_page_limit).toBe(9);
    expect((await tasksOf(second.batchId)).find((x) => x.requestedAction === "fetch_content_list")!.taskParameters).toMatchObject({ safety_page_limit: 9 });
  });

  it("运行时配置也被冻结进快照，供审计", async () => {
    const { org, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    expect(((await batches())[0]!.settingsSnapshot as { runtime: unknown }).runtime).toEqual(runtime);
  });
});

describe("排队 / 跳过 / 过期 / 晋升（FS-1.4–1.6，A5–A8）", () => {
  it("批次 1 运行中，下一个时点到来：批次 2 排队，无任务；任何时刻 running 的 full ≤ 1", async () => {
    const { org, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    await scheduler.tick(S2);
    const [a, b] = await batches();
    expect([a!.status, b!.status]).toEqual(["running", "queued"]);
    expect(await tasksOf(b!.batchId)).toEqual([]);
    const running = (await batches()).filter((x) => x.purpose === "full" && ["planned", "running"].includes(x.status));
    expect(running).toHaveLength(1);
  });

  it("上一批次终态后，同一次 tick 就把排队批次晋升并规划；规划用的是此刻的目标集（排队期间关闭的门店不在其中）", async () => {
    const { org, scheduler } = await world();
    const acc = await accounts(org);
    await scheduler.tick(S1);
    await scheduler.tick(S2); // B 排队
    // 排队期间下线一个账号
    await t.db.update(staffAccountAssignments).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(staffAccountAssignments.accountId, acc.b.accountId));
    const [a, queued] = await batches();
    await settleTasks(t.db, a!.batchId, { status: "succeeded" }, S2);
    const r = await scheduler.tick(S2);
    expect(r.finalized.map((x) => x.batchId)).toEqual([a!.batchId.toString()]);
    expect(r.promoted).toEqual([queued!.batchId.toString()]);
    const [, b] = await batches();
    expect(b!.status).toBe("running");
    expect(b!.plannedTaskCount).toBe(5); // 7 个目标任务去掉被关闭账号的 2 个
    expect((await tasksOf(b!.batchId)).some((x) => x.accountId === acc.b.accountId)).toBe(false);
  });

  it("队列已满时新触发 → skipped / queue_full，无任务（防御路径：见下方说明）", async () => {
    // 按固定的「先过期、再创建」顺序，正常时点序列里队列不会在新触发到来时仍满（排队批次到下一个时点必先过期）。
    // 这里手工放一个尚未过期的排队批次来验证该防御路径：它的 logical_at 与当前时点相同但批次键不同。
    const { org, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    const decoy = await insertBatch(t.db, S3, "decoy-queued");
    await t.db.update(syncBatches).set({ purpose: "full", status: "queued", logicalAt: S3 }).where(eq(syncBatches.batchId, decoy));
    const r = await scheduler.tick(S3);
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toMatchObject({ status: "skipped", skipReason: "queue_full" });
    const skipped = (await batches()).find((x) => x.batchKey.equals(fullBatchKey(S3)))!;
    expect(skipped).toMatchObject({ status: "skipped", skipReason: "queue_full", plannedTaskCount: 0 });
    expect(skipped.finishedAt).not.toBeNull();
    expect(await tasksOf(skipped.batchId)).toEqual([]);
  });

  it("排队到下一个计划时点仍未开始 → expired；新触发接替（排队）", async () => {
    const { org, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    await scheduler.tick(S2);
    const r = await scheduler.tick(S3);
    const all = await batches();
    expect(all.map((x) => x.status)).toEqual(["running", "expired", "queued"]);
    expect(r.expired).toEqual([all[1]!.batchId.toString()]);
    expect(all[1]!.finishedAt).not.toBeNull();
  });

  it("配置两个时点（周一、周四）：各时点各一个批次", async () => {
    const { org, scheduler } = await world();
    await accounts(org);
    await t.db.update(syncSettings).set({ scheduleSlots: [{ weekday: 1, time: "02:00" }, { weekday: 4, time: "02:00" }] }).where(eq(syncSettings.settingsId, 1));
    const thu = new Date(S1.getTime() + 3 * 24 * 3600_000);
    await scheduler.tick(S1);
    await scheduler.tick(thu);
    await scheduler.tick(thu);
    const all = await batches();
    expect(all.map((x) => x.logicalAt.toISOString())).toEqual([S1.toISOString(), thu.toISOString()]);
  });
});

describe("规划的崩溃恢复（FS-1.9，A12）", () => {
  it("在第 2 块之前终止，再 tick：planned 批次被恢复，任务总数正确且无重复", async () => {
    let calls = 0;
    const { org, scheduler: broken } = await world({
      chunkSize: 2,
      resolver: (real) => ({
        ...real,
        targets: async (q) => {
          calls++;
          if (calls === 2) throw new Error("模拟进程在第 1 块之后终止");
          return real.targets(q);
        },
      }),
    });
    await accounts(org);
    await expect(broken.tick(S1)).rejects.toThrow("模拟进程");
    const [mid] = await batches();
    expect(mid!.status).toBe("planned");
    const partial = (await tasksOf(mid!.batchId)).length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(7);

    const healthy = createSyncScheduler({ db: t.db, clock: new FakeClock(S1), resolver: createMonitoringResolver(t.db), runtime, chunkSize: 2 });
    const r = await healthy.tick(S1);
    expect(r.created).toEqual([]); // 不重复创建批次
    expect(r.planned).toHaveLength(1);
    const [done] = await batches();
    expect(done).toMatchObject({ status: "running", plannedTaskCount: 7 });
    const tasks = await tasksOf(done!.batchId);
    expect(tasks).toHaveLength(7);
    expect(new Set(tasks.map((x) => x.idempotencyKey.toString("hex"))).size).toBe(7);
  });

  it("规划到一半的批次仍占着运行名额：此时下一个时点到来，新批次只能排队，而不是第二个运行中的 full", async () => {
    let calls = 0;
    const { org, scheduler: broken } = await world({
      chunkSize: 2,
      resolver: (real) => ({ ...real, targets: async (q) => (++calls === 2 ? Promise.reject(new Error("crash")) : real.targets(q)) }),
    });
    await accounts(org);
    await expect(broken.tick(S1)).rejects.toThrow("crash");
    const healthy = createSyncScheduler({ db: t.db, clock: new FakeClock(S2), resolver: createMonitoringResolver(t.db), runtime });
    const r = await healthy.tick(S2);
    expect(r.created).toMatchObject([{ status: "queued" }]);
    expect((await batches()).map((x) => x.status)).toEqual(["running", "queued"]);
  });
});

describe("设置校验（FS-D15）", () => {
  it("timezone 不是 Asia/Shanghai → 拒绝启动，不静默纠正（A14）", async () => {
    const { scheduler } = await world();
    await t.db.update(syncSettings).set({ timezone: "UTC" }).where(eq(syncSettings.settingsId, 1));
    await expect(scheduler.tick(S1)).rejects.toMatchObject({ code: "invalid_settings" });
    await expect(scheduler.tick(S1)).rejects.toBeInstanceOf(SyncError);
    expect(await batches()).toEqual([]);
  });
  it("时点配置非法 / sync_settings 缺失 → 稳定的配置错误", async () => {
    const { scheduler } = await world();
    await t.db.update(syncSettings).set({ scheduleSlots: [{ weekday: 9, time: "02:00" }] }).where(eq(syncSettings.settingsId, 1));
    await expect(scheduler.tick(S1)).rejects.toMatchObject({ code: "invalid_settings" });
    await t.db.delete(syncSettings);
    await expect(scheduler.tick(S1)).rejects.toMatchObject({ code: "sync_settings_missing" });
  });
});

describe("批次终态与汇总（FS-1.7/1.8，A9–A11、A15）", () => {
  async function runWith(settle: (batchId: bigint, tasks: Array<typeof syncTasks.$inferSelect>) => Promise<void>, seedAccounts = true) {
    const w = await world();
    if (seedAccounts) await accounts(w.org);
    await w.scheduler.tick(S1);
    const [b] = await batches();
    await settle(b!.batchId, await tasksOf(b!.batchId));
    const r = await w.scheduler.tick(new Date(S1.getTime() + 3600_000));
    const [after] = await batches();
    return { w, b: after!, r };
  }

  it("全部成功 → succeeded，计数写入汇总", async () => {
    const { b } = await runWith((id) => settleTasks(t.db, id, { status: "succeeded" }, S1).then(() => undefined));
    expect(b).toMatchObject({ status: "succeeded", plannedTaskCount: 7, succeededTaskCount: 7, failedTaskCount: 0, skippedTaskCount: 0, gapTaskCount: 0 });
    expect(b.finishedAt).not.toBeNull();
  });
  it("有失败且有成功 → partial_succeeded", async () => {
    const { b } = await runWith(async (id, tasks) => {
      await settleTasks(t.db, id, { status: "succeeded" }, S1);
      await t.db.update(syncTasks).set({ status: "failed", lastErrorCode: "provider_input_inaccessible" }).where(eq(syncTasks.taskId, tasks[0]!.taskId));
    });
    expect(b).toMatchObject({ status: "partial_succeeded", succeededTaskCount: 6, failedTaskCount: 1 });
  });
  it("没有成功且有失败 → failed", async () => {
    const { b } = await runWith((id) => settleTasks(t.db, id, { status: "failed", lastErrorCode: "x" }, S1).then(() => undefined));
    expect(b).toMatchObject({ status: "failed", succeededTaskCount: 0, failedTaskCount: 7 });
  });
  it("死信 dead 计入失败", async () => {
    const { b } = await runWith(async (id, tasks) => {
      await settleTasks(t.db, id, { status: "succeeded" }, S1);
      await t.db.update(syncTasks).set({ status: "dead", lastErrorCode: "rate_limited" }).where(eq(syncTasks.taskId, tasks[1]!.taskId));
    });
    expect(b).toMatchObject({ status: "partial_succeeded", failedTaskCount: 1 });
  });
  it("三个任务因监控资格失效取消：计入 skipped_task_count，批次终态不受影响（A10）", async () => {
    const { b } = await runWith(async (id, tasks) => {
      await settleTasks(t.db, id, { status: "succeeded" }, S1);
      for (const x of tasks.slice(0, 3)) {
        await t.db.update(syncTasks).set({ status: "cancelled", lastErrorCode: "monitoring_closed" }).where(eq(syncTasks.taskId, x.taskId));
      }
    });
    expect(b).toMatchObject({ status: "succeeded", skippedTaskCount: 3, succeededTaskCount: 4 });
  });
  it("规划了任务而全部因监控资格失效取消 → skipped / all_targets_closed（存在已取消的任务行），不是 succeeded（A15）", async () => {
    const { b } = await runWith((id) => settleTasks(t.db, id, { status: "cancelled", lastErrorCode: "monitoring_closed" }, S1).then(() => undefined));
    expect(b).toMatchObject({ status: "skipped", skipReason: "all_targets_closed", plannedTaskCount: 7, skippedTaskCount: 7 });
    expect(await tasksOf(b.batchId)).toHaveLength(7);
  });
  it("没有有效监控目标 → skipped / no_targets，零任务行（A15）", async () => {
    const w = await world();
    const r = await w.scheduler.tick(S1);
    expect(r.planned[0]).toMatchObject({ outcome: "skipped", taskCount: 0 });
    const [b] = await batches();
    expect(b).toMatchObject({ status: "skipped", skipReason: "no_targets", plannedTaskCount: 0 });
    expect(await t.db.select().from(syncTasks)).toEqual([]);
  });
  it("仍有结构化任务未终态 → 批次保持 running", async () => {
    const { b } = await runWith(async (id, tasks) => {
      await settleTasks(t.db, id, { status: "succeeded", where: (x) => x.taskId !== tasks[0]!.taskId }, S1);
    });
    expect(b.status).toBe("running");
  });
  it("名单导入（intake）批次终态后，为成功解析的账号补建账号级媒资任务：头像 / 主页背景不再等到周一全量（测试机 573 个停在 pending）", async () => {
    const w = await world();
    const intake = await insertBatch(t.db, S1);
    const ok = await insertAccount(t.db, "douyin", S1);
    const bad = await insertAccount(t.db, "douyin", S1);
    const okTask = await insertTask(t.db, { batchId: intake, platform: "douyin", now: S1, status: "succeeded", action: "resolve_account", key: "intake-ok" });
    const badTask = await insertTask(t.db, { batchId: intake, platform: "douyin", now: S1, status: "failed", action: "resolve_account", key: "intake-bad" });
    await t.db.update(syncTasks).set({ accountId: ok }).where(eq(syncTasks.taskId, okTask));
    await t.db.update(syncTasks).set({ accountId: bad }).where(eq(syncTasks.taskId, badTask));
    await t.db.update(syncBatches).set({ status: "partial_succeeded", finishedAt: S1 }).where(eq(syncBatches.batchId, intake));
    w.clock.set(new Date(S1.getTime() + 60_000));
    await w.scheduler.tick();
    const media = (await t.db.select().from(syncTasks)).filter((x) => x.batchId === intake && x.requestedAction === "download_media");
    expect(media.map((x) => x.accountId)).toEqual([ok]); // 只给解析成功的账号建；失败的不建
    expect(media[0]).toMatchObject({ status: "pending", subjectType: "external_account" });
    await w.scheduler.tick(new Date(S1.getTime() + 120_000)); // 幂等：再对账不重复建
    expect((await t.db.select().from(syncTasks)).filter((x) => x.batchId === intake && x.requestedAction === "download_media")).toHaveLength(1);
  });
  it("媒资不决定批次终态：批次已终态后媒资任务仍在跑，media_finished_at 为空；全部终态后写入（A11）", async () => {
    const w = await world();
    await accounts(w.org);
    await w.scheduler.tick(S1);
    const [b0] = await batches();
    const mediaTask = await insertTask(t.db, { batchId: b0!.batchId, platform: "douyin", now: S1, status: "pending", action: "download_media", key: "media-1" });
    await settleTasks(t.db, b0!.batchId, { status: "succeeded", where: (x) => x.requestedAction !== "download_media" }, S1);
    w.clock.set(new Date(S1.getTime() + 60_000));
    await w.scheduler.tick();
    const [b1] = await batches();
    expect(b1!.status).toBe("succeeded");
    expect(b1!.mediaFinishedAt).toBeNull();
    await t.db.update(syncTasks).set({ status: "succeeded" }).where(eq(syncTasks.taskId, mediaTask));
    w.clock.set(new Date(S1.getTime() + 120_000));
    const r = await w.scheduler.tick();
    expect(r.mediaFinished).toEqual([b0!.batchId.toString()]);
    const [b2] = await batches();
    expect(b2!.mediaFinishedAt).not.toBeNull();
    expect(b2!.finishedAt!.getTime()).toBeLessThan(b2!.mediaFinishedAt!.getTime());
    // 之后的 tick 不再改写
    const again = await w.scheduler.tick(new Date(S1.getTime() + 180_000));
    expect(again.mediaFinished).toEqual([]);
  });
});
