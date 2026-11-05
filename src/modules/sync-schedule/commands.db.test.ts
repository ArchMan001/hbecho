import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertProfileSnapshot } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { seedOrg, seedSyncSettings, type OrgSeed } from "../../../tests/harness/seed";
import { addExternalAccount, addStaffAccount, settleTasks } from "../../../tests/harness/sync-fixtures";
import { stores, syncBatches, syncTasks } from "../../db/schema";
import { createMonitoringResolver } from "../monitoring";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../tracer-command";
import { memorySyncAuditSink } from "./audit";
import { createSyncCommands } from "./commands";
import { createSyncScheduler } from "./scheduler";
import type { SyncRuntime } from "./settings";

const t = useTestDb();
const S1 = new Date("2026-11-08T18:00:00Z");
const S2 = new Date(S1.getTime() + 7 * 24 * 3600_000);
const runtime: SyncRuntime = { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } };
const actor = (over: Partial<ActorContext> = {}): ActorContext => ({
  actorId: "service:test",
  capabilities: new Set([CAP_SYNC_TRIGGER]),
  scope: { platformCodes: "all", mediaStaffIds: "all" },
  ...over,
});

async function world() {
  const org = await seedOrg(t.db, S1);
  await seedSyncSettings(t.db, S1);
  const clock = new FakeClock(S1);
  const resolver = createMonitoringResolver(t.db);
  const scheduler = createSyncScheduler({ db: t.db, clock, resolver, runtime });
  const audit = memorySyncAuditSink();
  const commands = createSyncCommands({ db: t.db, clock, resolver, planner: scheduler.planner, runtime, audit });
  return { org, clock, scheduler, commands, audit };
}
async function accounts(org: OrgSeed) {
  const a = await addStaffAccount(t.db, { platform: "douyin", staffId: org.staffA, now: S1 });
  const b = await addStaffAccount(t.db, { platform: "xiaohongshu", staffId: org.staffB, now: S1 });
  const c = await addStaffAccount(t.db, { platform: "kuaishou", staffId: org.staffC, now: S1 });
  const e = await addExternalAccount(t.db, { platform: "kuaishou", now: S1 });
  return { a, b, c, e };
}
const batches = () => t.db.select().from(syncBatches).orderBy(syncBatches.batchId);
const tasksOf = (batchId: bigint) => t.db.select().from(syncTasks).where(eq(syncTasks.batchId, batchId));
const ids = (...x: bigint[]) => x.map(String);
const dump = async () => JSON.stringify([await batches(), await t.db.select().from(syncTasks)], (_k, v) => (typeof v === "bigint" ? v.toString() : v));

describe("supplement：空闲时立即运行（FS-13.1）", () => {
  it("创建 supplement 批次，主页 + 列表任务，优先级 100；处置 queued", async () => {
    const { org, commands } = await world();
    const acc = await accounts(org);
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "k1" }, actor());
    if (r.kind !== "created") throw new Error(JSON.stringify(r));
    expect(r.status).toBe("running");
    expect(r.dispositions).toEqual([{ accountId: acc.a.accountId.toString(), disposition: "queued" }]);
    const [b] = await batches();
    expect(b).toMatchObject({ purpose: "supplement", triggerType: "manual", status: "running", plannedTaskCount: 2 });
    const tasks = await tasksOf(b!.batchId);
    expect(tasks.map((x) => x.requestedAction).sort()).toEqual(["fetch_content_list", "fetch_profile"]);
    expect(tasks.every((x) => x.priority === 100)).toBe(true);
  });
  it("--only profile 只建 fetch_profile", async () => {
    const { org, commands } = await world();
    const acc = await accounts(org);
    await commands.createSupplement({ accountIds: ids(acc.a.accountId), only: "profile", idempotencyKey: "k1" }, actor());
    const [b] = await batches();
    expect((await tasksOf(b!.batchId)).map((x) => x.requestedAction)).toEqual(["fetch_profile"]);
  });
  it("external 账号的补抓只有主页任务", async () => {
    const { org, commands } = await world();
    const acc = await accounts(org);
    await commands.createSupplement({ accountIds: ids(acc.e.accountId), idempotencyKey: "k1" }, actor());
    const [b] = await batches();
    expect((await tasksOf(b!.batchId)).map((x) => x.requestedAction)).toEqual(["fetch_profile"]);
  });
  it("补抓批次终态由 tick 汇总（与全量批次同样的规则）", async () => {
    const { org, commands, scheduler } = await world();
    const acc = await accounts(org);
    await commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "k1" }, actor());
    const [b] = await batches();
    await settleTasks(t.db, b!.batchId, { status: "succeeded" }, S1);
    await scheduler.tick(new Date(S1.getTime() + 600_000 + 3600_000 * 24 * 3));
    expect((await batches())[0]).toMatchObject({ status: "succeeded", succeededTaskCount: 2 });
  });
});

describe("supplement：遇到运行中的全量批次（FS-13.2，FS-D02）", () => {
  async function busy() {
    const w = await world();
    const acc = await accounts(w.org);
    await w.scheduler.tick(S1);
    const [full] = await batches();
    return { ...w, acc, full: full! };
  }

  it("run_now（默认）：与全量批次并行；全量批次仍 running，补抓批次不计入「一个全量批次」约束", async () => {
    const { acc, full, commands } = await busy();
    // 该账号在全量批次里的任务已经终态，所以补抓会创建新任务
    await settleTasks(t.db, full.batchId, { status: "succeeded", where: (x) => x.accountId === acc.a.accountId }, S1);
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "k1" }, actor());
    if (r.kind !== "created") throw new Error(JSON.stringify(r));
    expect(r.status).toBe("running");
    const all = await batches();
    expect(all.map((x) => [x.purpose, x.status])).toEqual([["full", "running"], ["supplement", "running"]]);
    expect((await tasksOf(all[1]!.batchId)).every((x) => x.priority === 100)).toBe(true);
  });

  it("同账号同动作已有活动任务：复用并提升优先级，返回已有任务引用，不并发再建（FS-13.3、FS-3.5）", async () => {
    const { acc, full, commands } = await busy();
    const before = (await tasksOf(full.batchId)).filter((x) => x.accountId === acc.a.accountId);
    expect(before.every((x) => x.priority === 0)).toBe(true);
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "k1" }, actor());
    if (r.kind !== "created") throw new Error(JSON.stringify(r));
    expect(r.dispositions[0]).toMatchObject({ disposition: "reused_active_task" });
    expect((r.dispositions[0] as { taskIds: string[] }).taskIds.sort()).toEqual(before.map((x) => x.taskId.toString()).sort());
    const after = (await tasksOf(full.batchId)).filter((x) => x.accountId === acc.a.accountId);
    expect(after.every((x) => x.priority === 100)).toBe(true);
    // 补抓批次没有自己的任务（全部复用）→ 没有执行任何任务 → skipped
    const supp = (await batches())[1]!;
    expect(await tasksOf(supp.batchId)).toEqual([]);
    expect(supp.status).toBe("skipped");
  });

  it("queue：排到全量批次结束后；全量批次终态的那次 tick 立即晋升并规划", async () => {
    const { acc, full, commands, scheduler } = await busy();
    await settleTasks(t.db, full.batchId, { status: "succeeded", where: (x) => x.accountId === acc.a.accountId }, S1);
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId), onBusy: "queue", idempotencyKey: "k1" }, actor());
    if (r.kind !== "created") throw new Error(JSON.stringify(r));
    expect(r.status).toBe("queued");
    const supp = (await batches())[1]!;
    expect(await tasksOf(supp.batchId)).toEqual([]);
    await scheduler.tick(S1); // 全量批次还在跑 → 仍排队
    expect((await batches())[1]!.status).toBe("queued");
    await settleTasks(t.db, full.batchId, { status: "succeeded" }, S1);
    await scheduler.tick(S1);
    const after = await batches();
    expect(after[0]!.status).toBe("succeeded");
    expect(after[1]).toMatchObject({ status: "running", plannedTaskCount: 2 });
  });

  it("cancel_current 不带 apply：只预览，数据库零写入（FS-14.6）", async () => {
    const { acc, full, commands } = await busy();
    const snapshot = await dump();
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId), onBusy: "cancel_current", idempotencyKey: "k1" }, actor());
    expect(r).toMatchObject({ kind: "preview", wouldCancelBatchId: full.batchId.toString(), openTasks: 7 });
    expect(await dump()).toBe(snapshot);
  });

  it("cancel_current + apply：取消当前全量批次与它的未终态任务，补抓批次立即运行，并记审计", async () => {
    const { acc, full, commands, audit } = await busy();
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId), onBusy: "cancel_current", apply: true, idempotencyKey: "k1" }, actor());
    if (r.kind !== "created") throw new Error(JSON.stringify(r));
    const all = await batches();
    expect(all.map((x) => [x.purpose, x.status])).toEqual([["full", "cancelled"], ["supplement", "running"]]);
    const old = await tasksOf(full.batchId);
    expect(old.every((x) => x.status === "cancelled" && x.fencingToken === 1n && x.leaseOwner === null)).toBe(true);
    expect(audit.events.map((e) => [e.action, e.outcome])).toContainEqual(["supplement", "accepted"]);
  });
});

describe("supplement：处置、范围与幂等（FS-13.4）", () => {
  it("逐账号处置：不存在 → not_found；不在目标集 → not_eligible 并给出原因码；超出调用方范围 → out_of_scope", async () => {
    const { org, commands } = await world();
    const acc = await accounts(org);
    await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeId, org.otherStoreId)); // staffC / 快手账号所在门店撤店
    const r = await commands.createSupplement(
      { accountIds: ids(acc.a.accountId, acc.c.accountId, acc.e.accountId, 987654321n), idempotencyKey: "k1" },
      actor({ scope: { platformCodes: new Set(["douyin", "kuaishou"]), mediaStaffIds: "all" } }),
    );
    if (r.kind !== "created") throw new Error(JSON.stringify(r));
    const by = Object.fromEntries(r.dispositions.map((d) => [d.accountId, d]));
    expect(by[acc.a.accountId.toString()]).toMatchObject({ disposition: "queued" });
    expect(by[acc.c.accountId.toString()]).toEqual({ accountId: acc.c.accountId.toString(), disposition: "not_eligible", reason: "store_closed" });
    expect(by[acc.e.accountId.toString()]).toMatchObject({ disposition: "queued" });
    expect(by["987654321"]).toEqual({ accountId: "987654321", disposition: "not_found" });

    const narrow = await commands.createSupplement({ accountIds: ids(acc.b.accountId), idempotencyKey: "k2" }, actor({ scope: { platformCodes: new Set(["douyin"]), mediaStaffIds: "all" } }));
    expect(narrow).toEqual({ kind: "no_accounts", dispositions: [{ accountId: acc.b.accountId.toString(), disposition: "out_of_scope" }] });
  });

  it("external 账号只对 mediaStaffIds=all 的调用方可见", async () => {
    const { org, commands } = await world();
    const acc = await accounts(org);
    const r = await commands.createSupplement({ accountIds: ids(acc.e.accountId), idempotencyKey: "k1" }, actor({ scope: { platformCodes: "all", mediaStaffIds: new Set([org.staffA]) } }));
    expect(r).toMatchObject({ kind: "no_accounts", dispositions: [{ disposition: "out_of_scope" }] });
  });

  it("--if-older-than：近期同步过 → not_due；更久 → queued；从未成功过 → queued", async () => {
    const { org, commands, clock } = await world();
    const acc = await accounts(org);
    const { syncBatches: sb } = await import("../../db/schema");
    const [batch] = await t.db.insert(sb).values({ batchKey: Buffer.alloc(32, 7), triggerType: "manual", purpose: "intake", logicalAt: S1, status: "succeeded", settingsVersion: 1n, settingsSnapshot: {}, createdAt: S1, updatedAt: S1 });
    const recent = new Date(S1.getTime() + 3600_000);
    clock.set(new Date(S1.getTime() + 2 * 3600_000));
    await insertProfileSnapshot(t.db, { batchId: BigInt(batch.insertId), accountId: acc.a.accountId, assignmentId: acc.a.assignmentId, now: recent });
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId, acc.b.accountId), only: "profile", ifOlderThanHours: 24, idempotencyKey: "k1" }, actor());
    if (r.kind !== "created") throw new Error(JSON.stringify(r));
    const by = Object.fromEntries(r.dispositions.map((d) => [d.accountId, d.disposition]));
    expect(by[acc.a.accountId.toString()]).toBe("not_due");
    expect(by[acc.b.accountId.toString()]).toBe("queued");
    const old = await commands.createSupplement({ accountIds: ids(acc.a.accountId), only: "profile", ifOlderThanHours: 1, idempotencyKey: "k2" }, actor());
    expect(old).toMatchObject({ kind: "created", dispositions: [{ disposition: "queued" }] });
  });

  it("--if-older-than 对 full 取主页与列表两者中较早的那个：只有主页新鲜不算新鲜", async () => {
    const { org, commands, clock } = await world();
    const acc = await accounts(org);
    const { syncBatches: sb } = await import("../../db/schema");
    const [batch] = await t.db.insert(sb).values({ batchKey: Buffer.alloc(32, 8), triggerType: "manual", purpose: "intake", logicalAt: S1, status: "succeeded", settingsVersion: 1n, settingsSnapshot: {}, createdAt: S1, updatedAt: S1 });
    clock.set(new Date(S1.getTime() + 2 * 3600_000));
    await insertProfileSnapshot(t.db, { batchId: BigInt(batch.insertId), accountId: acc.a.accountId, assignmentId: acc.a.assignmentId, now: new Date(S1.getTime() + 3600_000) });
    const r = await commands.createSupplement({ accountIds: ids(acc.a.accountId), ifOlderThanHours: 24, idempotencyKey: "k1" }, actor());
    expect(r).toMatchObject({ kind: "created", dispositions: [{ disposition: "queued" }] }); // 从未有过成功的列表任务 → 视为无限久
  });

  it("幂等：同 actor + key + 相同内容 → 返回原批次；内容不同 → idempotency_conflict", async () => {
    const { org, commands } = await world();
    const acc = await accounts(org);
    const first = await commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "same" }, actor());
    const again = await commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "same" }, actor());
    if (first.kind !== "created" || again.kind !== "created") throw new Error("expected created");
    expect(again.deduplicated).toBe(true);
    expect(again.batchId).toBe(first.batchId);
    expect(await batches()).toHaveLength(1);
    await expect(commands.createSupplement({ accountIds: ids(acc.b.accountId), idempotencyKey: "same" }, actor())).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("缺 Capability → forbidden；输入非法 → invalid_input；都不写库，并记 rejected 审计", async () => {
    const { org, commands, audit } = await world();
    const acc = await accounts(org);
    await expect(commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "k" }, actor({ capabilities: new Set() }))).rejects.toMatchObject({ code: "forbidden" });
    await expect(commands.createSupplement({ accountIds: ["abc"], idempotencyKey: "k" }, actor())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(commands.createSupplement({ accountIds: [], idempotencyKey: "k" }, actor())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(commands.createSupplement({ accountIds: ids(acc.a.accountId), idempotencyKey: "k", extra: 1 }, actor())).rejects.toMatchObject({ code: "invalid_input" });
    expect(await batches()).toEqual([]);
    expect(audit.events.filter((e) => e.outcome === "rejected").map((e) => e.code)).toEqual(["forbidden", "invalid_input", "invalid_input", "invalid_input"]);
  });
});

describe("batch cancel（FS-12.6、FS-14.6）", () => {
  it("默认只预览：数据库零写入，输出各状态的未终态任务数", async () => {
    const { org, commands, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    const [b] = await batches();
    const snapshot = await dump();
    const r = await commands.cancelBatch(b!.batchId.toString(), actor());
    expect(r).toMatchObject({ kind: "preview", batch: { status: "running", openTasksByStatus: { pending: 7 } } });
    expect(await dump()).toBe(snapshot);
  });
  it("apply：批次 cancelled，未开始任务 cancelled 且旧 fencing token 失效；已终态任务不动；再取消是 noop", async () => {
    const { org, commands, scheduler, audit } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    const [b] = await batches();
    const first = (await tasksOf(b!.batchId))[0]!;
    await t.db.update(syncTasks).set({ status: "succeeded" }).where(eq(syncTasks.taskId, first.taskId));
    const r = await commands.cancelBatch(b!.batchId.toString(), actor(), { apply: true });
    expect(r).toMatchObject({ kind: "cancelled", cancelledTasks: 6 });
    const after = await tasksOf(b!.batchId);
    expect(after.filter((x) => x.status === "cancelled")).toHaveLength(6);
    expect(after.find((x) => x.taskId === first.taskId)!.status).toBe("succeeded");
    expect(after.filter((x) => x.status === "cancelled").every((x) => x.fencingToken === 1n)).toBe(true);
    expect((await batches())[0]).toMatchObject({ status: "cancelled" });
    const again = await commands.cancelBatch(b!.batchId.toString(), actor(), { apply: true });
    expect(again.kind).toBe("noop");
    expect(audit.events.map((e) => e.outcome)).toEqual(["cancelled", "noop"]);
  });
  it("排队中的批次可取消；取消后不会被晋升；终态批次是 noop；不存在 → not_found；缺 Capability → forbidden", async () => {
    const { org, commands, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    await scheduler.tick(S2);
    const [a, q] = await batches();
    expect(q!.status).toBe("queued");
    expect((await commands.cancelBatch(q!.batchId.toString(), actor(), { apply: true })).kind).toBe("cancelled");
    await settleTasks(t.db, a!.batchId, { status: "succeeded" }, S2);
    await scheduler.tick(S2);
    expect((await batches()).map((x) => x.status)).toEqual(["succeeded", "cancelled"]);
    expect((await commands.cancelBatch(a!.batchId.toString(), actor(), { apply: true })).kind).toBe("noop");
    await expect(commands.cancelBatch("999999", actor())).rejects.toMatchObject({ code: "not_found" });
    await expect(commands.cancelBatch("abc", actor())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(commands.cancelBatch(a!.batchId.toString(), actor({ capabilities: new Set() }))).rejects.toMatchObject({ code: "forbidden" });
  });
  it("规划中的批次被取消后，规划停止，不再往已取消批次里写任务", async () => {
    const { org, commands, scheduler } = await world();
    await accounts(org);
    // 手工造一个 planned 批次并先取消，再让规划器去规划它
    await scheduler.tick(new Date(S1.getTime() + 3600_000 * 24)); // 超出窗口，不创建
    const { syncBatches: sb } = await import("../../db/schema");
    const settings = (await import("./settings")).settingsSnapshot;
    const { syncSettings } = await import("../../db/schema");
    const [row] = await t.db.select().from(syncSettings);
    const [ins] = await t.db.insert(sb).values({ batchKey: Buffer.alloc(32, 9), triggerType: "scheduled", purpose: "full", logicalAt: S1, status: "planned", settingsVersion: 1n, settingsSnapshot: settings(row!, runtime), createdAt: S1, updatedAt: S1 });
    const id = BigInt(ins.insertId);
    await commands.cancelBatch(id.toString(), actor(), { apply: true });
    const report = await scheduler.planner.planBatch(id);
    expect(report.outcome).toBe("aborted");
    expect(await tasksOf(id)).toEqual([]);
  });
});

describe("batches 列表", () => {
  it("按批次号倒序，ID 为十进制字符串，时间 ISO", async () => {
    const { org, commands, scheduler } = await world();
    await accounts(org);
    await scheduler.tick(S1);
    const list = await commands.listBatches();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ purpose: "full", status: "running", planned: 7, logicalAt: S1.toISOString() });
    expect(typeof list[0]!.batchId).toBe("string");
    expect(await commands.listBatches({ purpose: "supplement" })).toEqual([]);
  });
});
