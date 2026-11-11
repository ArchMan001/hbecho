// 每日维护（任务 10）：15 天扫描与回收站清除。FakeClock 推进；顺序 await。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment, insertBatch } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { insertPlan, insertRosterEntry, insertStaff, MemoryPlanAudit, T0 } from "../../../tests/harness/plan";
import { seedOrg, type OrgSeed } from "../../../tests/harness/seed";
import { activityPlanBranches, activityPlanChanges, activityPlanOwners, activityPlanRoster, activityPlanSectors, activityPlans, externalAccounts, importBatches, mediaStaff, staffAccountAssignments as aa } from "../../db/schema";
import { recordChange } from "./changes";
import type { PlanDownstream } from "./downstream";
import { noDownstream } from "./downstream";
import { createPlanMaintenance } from "./maintenance";

const t = useTestDb();
const DAY = 86_400_000;
let org: OrgSeed;
let clock: FakeClock;
let audit: MemoryPlanAudit;
let phone = 13500000000;
let bj: bigint;
async function world(downstream: PlanDownstream = noDownstream, hooks = {}) {
  org = await seedOrg(t.db, T0);
  bj = org.branchIds.get("101")!;
  clock = new FakeClock(T0);
  audit = new MemoryPlanAudit();
  return createPlanMaintenance({ db: t.db, clock, downstream, audit: audit.sink, hooks });
}
async function acct() {
  const staffId = await insertStaff(t.db, { storeId: org.storeId, phone: String(++phone) });
  const accountId = await insertAccount(t.db, "douyin", T0);
  await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0 });
  return { accountId, staffId };
}
const entry = (planId: bigint, a: { accountId: bigint; staffId: bigint }, state: "in_roster" | "removed" = "in_roster") =>
  insertRosterEntry(t.db, { planId, accountId: a.accountId, staffId: a.staffId, storeId: org.storeId, branchId: bj, state });
const st = async (accountId: bigint) => (await t.db.select().from(aa).where(eq(aa.accountId, accountId)))[0]!;
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe("15 天扫描", () => {
  it("暂停中的计划：补记起点；第 14 天不关，第 15 天关闭，原因 unreferenced_15d", async () => {
    const m = await world();
    const p = await insertPlan(t.db, org, { status: "paused", statusChangedAt: T0 });
    const a = await acct();
    await entry(p, a);
    clock.set(at(3));
    const r1 = await m.runNow();
    expect(r1).toMatchObject({ graceMarked: 1, closed: 0 });
    expect((await st(a.accountId)).unreferencedSince).toEqual(T0); // 补记的是 computeStopAt，不是扫描那天
    clock.set(at(14));
    expect((await m.runNow()).closed).toBe(0);
    clock.set(at(15));
    const r2 = await m.runNow();
    expect(r2.closed).toBe(1);
    expect(await st(a.accountId)).toMatchObject({ monitoringEnabled: false, monitoringClosedReason: "unreferenced_15d" });
    expect(audit.of("monitoring_closed_unreferenced")).toHaveLength(1);
  });
  it("计划过结束日 15 天后关闭；无结束日的计划不触发；仍有有效引用的账号不动", async () => {
    const m = await world();
    const ended = await insertPlan(t.db, org, { name: "到期", endsOn: "2026-11-10" });
    const open = await insertPlan(t.db, org, { name: "无结束日" });
    const a = await acct();
    const b = await acct();
    const c = await acct();
    await entry(ended, a);
    await entry(open, b);
    await entry(ended, c);
    await entry(open, c); // c 同时被一个有效计划引用
    const stop = new Date("2026-11-10T16:00:00Z"); // 结束日次日北京 00:00
    clock.set(new Date(stop.getTime() + 14 * DAY));
    expect((await m.runNow()).closed).toBe(0);
    clock.set(new Date(stop.getTime() + 15 * DAY));
    await m.runNow();
    expect((await st(a.accountId)).monitoringEnabled).toBe(false);
    expect((await st(b.accountId)).monitoringEnabled).toBe(true);
    expect((await st(c.accountId)).monitoringEnabled).toBe(true);
  });
  it("外部监控账号与从未入过名单的账号不受影响", async () => {
    const m = await world();
    await insertPlan(t.db, org, { status: "paused" });
    const never = await acct();
    clock.set(at(40));
    const r = await m.runNow();
    expect(r).toMatchObject({ graceMarked: 0, closed: 0 });
    expect((await st(never.accountId)).monitoringEnabled).toBe(true);
  });
  it("同一天重复运行不重复关闭、不重复审计", async () => {
    const m = await world();
    const p = await insertPlan(t.db, org, { status: "paused", statusChangedAt: T0 });
    const a = await acct();
    await entry(p, a);
    clock.set(at(20));
    expect((await m.runNow()).closed).toBe(1);
    expect((await m.runNow()).closed).toBe(0);
    expect(audit.of("monitoring_closed_unreferenced")).toHaveLength(1);
  });
  it("分块：候选多于块大小时全部处理", async () => {
    org = await seedOrg(t.db, T0);
    bj = org.branchIds.get("101")!;
    clock = new FakeClock(T0);
    audit = new MemoryPlanAudit();
    const m = createPlanMaintenance({ db: t.db, clock, downstream: noDownstream, audit: audit.sink, chunkSize: 3 });
    const p = await insertPlan(t.db, org, { status: "paused", statusChangedAt: T0 });
    for (let i = 0; i < 8; i++) await entry(p, await acct());
    clock.set(at(20));
    expect((await m.runNow()).closed).toBe(8);
  });
});

describe("回收站清除", () => {
  async function trashed(m: ReturnType<typeof createPlanMaintenance>) {
    void m;
    const p = await insertPlan(t.db, org, { status: "deleted", deletedAt: T0, joined: [bj] });
    const a = await acct();
    await entry(p, a);
    await t.db.insert(activityPlanOwners).values({ planId: p, branchId: bj, slotNo: 1, ownerActor: "user:x", claimedAt: T0, claimedVia: "import" });
    await recordChange(t.db, { planId: p, eventType: "plan_deleted", actor: "user:creator", now: T0 });
    await insertBatch(t.db, T0);
    await t.db.insert(importBatches).values({ importKind: "roster", planId: p, uploadedByActor: "a", uploadedAt: T0, totalRows: 1, status: "completed", createdAt: T0, updatedAt: T0 });
    return { p, a };
  }
  const businessCounts = async () => [(await t.db.select().from(externalAccounts)).length, (await t.db.select().from(aa)).length, (await t.db.select().from(mediaStaff)).length, (await t.db.select().from(importBatches)).length];
  const planRows = async (p: bigint) => [
    (await t.db.select().from(activityPlans).where(eq(activityPlans.planId, p))).length,
    (await t.db.select().from(activityPlanSectors).where(eq(activityPlanSectors.planId, p))).length,
    (await t.db.select().from(activityPlanBranches).where(eq(activityPlanBranches.planId, p))).length,
    (await t.db.select().from(activityPlanOwners).where(eq(activityPlanOwners.planId, p))).length,
    (await t.db.select().from(activityPlanRoster).where(eq(activityPlanRoster.planId, p))).length,
    (await t.db.select().from(activityPlanChanges).where(eq(activityPlanChanges.planId, p))).length,
  ];
  it("删除后 29 天不清除，31 天清除；账号 / 归属 / 专员 / 批次行数不变；计划层对象全部没了", async () => {
    const m = await world();
    const { p } = await trashed(m);
    const before = await businessCounts();
    clock.set(at(29));
    expect((await m.runNow()).purged).toBe(0);
    expect((await planRows(p))[0]).toBe(1);
    clock.set(at(31));
    expect((await m.runNow()).purged).toBe(1);
    expect(await planRows(p)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await businessCounts()).toEqual(before);
    expect(audit.of("plan_purged")).toHaveLength(1);
    expect((await m.runNow()).purged).toBe(0); // 重复运行不再清除
  });
  it("先调下游 purge，且调用发生时没有任何打开的数据库事务", async () => {
    const calls: Array<{ plan: bigint; openTx: number }> = [];
    const down: PlanDownstream = {
      ...noDownstream,
      purge: async (plan) => {
        const [rows] = await t.pool.query("SELECT COUNT(*) n FROM information_schema.innodb_trx WHERE trx_mysql_thread_id <> CONNECTION_ID()");
        calls.push({ plan, openTx: Number((rows as Array<{ n: string }>)[0]!.n) });
      },
    };
    const m = await world(down);
    const { p } = await trashed(m);
    clock.set(at(31));
    await m.runNow();
    expect(calls).toEqual([{ plan: p, openTx: 0 }]);
  });
  it("下游 purge 失败：计划保留，报告列出失败步骤；下次重试成功", async () => {
    let fail = true;
    const down: PlanDownstream = { ...noDownstream, purge: async () => void (fail && (() => { throw new Error("下游不可用"); })()) };
    const m = await world(down);
    const { p } = await trashed(m);
    clock.set(at(31));
    const r1 = await m.runNow();
    expect(r1).toMatchObject({ purged: 0, failedSteps: ["purge_trash"], purgeFailed: [p.toString()] });
    expect((await planRows(p))[0]).toBe(1);
    fail = false;
    expect((await m.runNow()).purged).toBe(1);
    expect((await planRows(p))[0]).toBe(0);
  });
  it("崩溃在下游 purge 与数据库清除之间：计划行仍在，重跑幂等完成", async () => {
    let n = 0;
    const purged: bigint[] = [];
    const m = await world({ ...noDownstream, purge: async (id) => void purged.push(id) }, {
      afterDownstreamPurge: () => {
        if (n++ === 0) throw new Error("模拟进程被杀");
      },
    });
    const { p } = await trashed(m);
    clock.set(at(31));
    const r1 = await m.runNow();
    expect(r1.failedSteps).toEqual(["purge_trash"]);
    expect((await planRows(p))[0]).toBe(1);
    expect((await m.runNow()).purged).toBe(1);
    expect(purged).toEqual([p, p]); // purge 被调了两次，必须幂等
  });
  it("期间被恢复的计划不会被清除", async () => {
    const m = await world();
    const { p } = await trashed(m);
    clock.set(at(31));
    await t.db.update(activityPlans).set({ status: "collecting", statusBeforeDelete: null, deletedAt: null, deletedByActor: null, purgeAfter: null }).where(eq(activityPlans.planId, p));
    expect((await m.runNow()).purged).toBe(0);
    expect((await planRows(p))[0]).toBe(1);
  });
});

describe("调度", () => {
  it("北京时间 04:00 前不运行；之后每天一次；当日已成功则 already_done；次日再跑", async () => {
    const m = await world();
    clock.set(new Date("2026-11-11T19:30:00Z")); // 北京 03:30
    expect(await m.runDaily()).toMatchObject({ ran: false, skipped: "not_due" });
    clock.set(new Date("2026-11-11T20:30:00Z")); // 北京 04:30（11-12）
    expect((await m.runDaily()).ran).toBe(true);
    expect(await m.runDaily()).toMatchObject({ ran: false, skipped: "already_done" });
    clock.set(new Date("2026-11-12T20:30:00Z"));
    expect((await m.runDaily()).ran).toBe(true);
  });
  it("一步失败不影响另一步；失败退避 10 分钟后重试", async () => {
    let boom = true;
    const m = await world(noDownstream, {
      beforeScan: () => {
        if (boom) throw new Error("扫描失败");
      },
    });
    const p = await insertPlan(t.db, org, { status: "deleted", deletedAt: T0 });
    clock.set(at(31));
    const r1 = await m.runDaily();
    expect(r1).toMatchObject({ ran: true, failedSteps: ["scan_unreferenced"], purged: 1 }); // 清除照常
    expect((await t.db.select().from(activityPlans).where(eq(activityPlans.planId, p))).length).toBe(0);
    clock.advance(5 * 60_000);
    expect(await m.runDaily()).toMatchObject({ ran: false, skipped: "backoff" });
    boom = false;
    clock.advance(6 * 60_000);
    expect((await m.runDaily())).toMatchObject({ ran: true, failedSteps: [] });
  });
  it("不依赖 OSS：构造只需要 db / clock / downstream / audit", async () => {
    const m = createPlanMaintenance({ db: t.db, clock: new FakeClock(T0), downstream: noDownstream, audit: () => {} });
    expect(typeof m.runDaily).toBe("function");
  });
});
