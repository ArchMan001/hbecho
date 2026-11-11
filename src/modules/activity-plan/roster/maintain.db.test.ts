// 名单维护（任务 9）：移出、疑似空账号确认、恢复。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../../../tests/harness/audit";
import { useTestDb } from "../../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../../tests/harness/factories";
import { FakeClock } from "../../../../tests/harness/fake-clock";
import { insertPlan, insertRosterEntry, insertStaff, planActor, T0 } from "../../../../tests/harness/plan";
import { rosterWorld, type RosterWorld } from "../../../../tests/harness/roster";
import { seedSyncSettings } from "../../../../tests/harness/seed";
import { activityPlanChanges, activityPlanRoster, activityPlans, importRowResults, staffAccountAssignments as aa } from "../../../db/schema";
import { createMonitoringResolver } from "../../monitoring";
import { createTracerCommands } from "../../tracer-command";
import { ROSTER_HEADER } from "../constants";
import { confirm } from "./confirm";
import { createRosterMaintenance } from "./maintain";
import { precheck } from "./precheck";

const t = useTestDb();
const hq = planActor("hq");
let w: RosterWorld;
async function setup(planOver: Parameters<typeof rosterWorld>[1] = {}) {
  w = await rosterWorld(t, planOver);
  const clock = new FakeClock(T0);
  await seedSyncSettings(t.db, T0);
  const m = createRosterMaintenance({ db: t.db, clock, audit: w.audit.sink });
  const tracer = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
  return { m, clock, deps: { db: t.db, clock, audit: w.audit.sink, tracer } };
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const x = e as { category?: string; code?: string };
    return `${x.category}/${x.code}`;
  }
  return "ok";
};
const on = async (accountId: bigint) => (await t.db.select().from(aa).where(eq(aa.accountId, accountId)))[0]!;
const entryOf = async (planId: bigint, accountId: bigint) => (await t.db.select().from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, planId), eq(activityPlanRoster.accountId, accountId))))[0];

describe("移出", () => {
  it("默认只预览：零写入，报告将被关闭的账号数", async () => {
    const { m } = await setup();
    const pv = await m.remove(hq, { planId: w.planId, accountIds: [w.accZhao] });
    expect(pv).toEqual({ kind: "preview", entries: 1, accountsToClose: 1, apply: false });
    expect((await entryOf(w.planId, w.accZhao))?.entryState).toBe("in_roster");
    expect((await on(w.accZhao)).monitoringEnabled).toBe(true);
  });
  it("apply：名单项 removed(manual_remove)，带时间与操作者；仅被本计划引用的账号立即关闭；变更记录与审计各一条", async () => {
    const { m } = await setup();
    const r = await m.remove(hq, { planId: w.planId, accountIds: [w.accZhao], apply: true });
    expect(r).toEqual({ kind: "applied", entries: 1, accountsClosed: 1 });
    expect(await entryOf(w.planId, w.accZhao)).toMatchObject({ entryState: "removed", removedReason: "manual_remove", removedByActor: "user:hq", removedAt: T0 });
    expect(await on(w.accZhao)).toMatchObject({ monitoringEnabled: false, monitoringClosedReason: "unreferenced_15d" });
    expect(w.audit.of("roster_entry_removed")).toHaveLength(1);
    expect((await t.db.select().from(activityPlanChanges)).filter((c) => c.eventType === "roster_entries_removed")).toHaveLength(1);
    expect((await t.db.select().from(activityPlanRoster)).length).toBe(2); // 名单项永不物理删除
  });
  it("同账号在两个计划：先后移出，第一次保持开启，第二次立即关闭", async () => {
    const { m } = await setup();
    const p2 = await insertPlan(t.db, w.org, { name: "另一个", joined: [w.bj] });
    await insertRosterEntry(t.db, { planId: p2, accountId: w.accZhao, staffId: w.staff.zhao, storeId: w.stores.sW1, branchId: w.bj });
    await m.remove(hq, { planId: w.planId, accountIds: [w.accZhao], apply: true });
    expect((await on(w.accZhao)).monitoringEnabled).toBe(true);
    await m.remove(hq, { planId: p2, accountIds: [w.accZhao], apply: true });
    expect((await on(w.accZhao)).monitoringEnabled).toBe(false);
  });
  it("按专员批量移出：该专员在本计划的名单项全部移出", async () => {
    const { m } = await setup();
    const r = await m.remove(hq, { planId: w.planId, staffIds: [w.staff.zhao, w.staff.qian], apply: true });
    expect(r).toMatchObject({ kind: "applied", entries: 1 }); // 老钱的项本来就是 removed
  });
  it("已经是 removed 的项：noop；什么都没选：拒绝", async () => {
    const { m } = await setup();
    expect(await m.remove(hq, { planId: w.planId, accountIds: [w.accQian], apply: true })).toEqual({ kind: "noop", entries: 0 });
    expect(await code(m.remove(hq, { planId: w.planId, apply: true }))).toBe("input/nothing_selected");
  });
  it("非采集中被拒：暂停 / 归档", async () => {
    const { m } = await setup();
    for (const status of ["paused", "archived"] as const) {
      await t.db.update(activityPlans).set({ status }).where(eq(activityPlans.planId, w.planId));
      expect(await code(m.remove(hq, { planId: w.planId, accountIds: [w.accZhao], apply: true })), status).toBe("conflict/plan_not_collecting");
    }
    expect((await entryOf(w.planId, w.accZhao))?.entryState).toBe("in_roster");
  });
  it("分公司只能移出自己分公司的项；越范围任何一项都使整条命令被拒，零写入；总部可以", async () => {
    const { m } = await setup();
    const shAcct = await insertAccount(t.db, "douyin", T0);
    const shStaff = await insertStaff(t.db, { storeId: w.stores.sH2, phone: "13955550001" });
    await insertAssignment(t.db, { accountId: shAcct, platform: "douyin", staffId: shStaff, now: T0 });
    await insertRosterEntry(t.db, { planId: w.planId, accountId: shAcct, staffId: shStaff, storeId: w.stores.sH2, branchId: w.sh });
    const bj = planActor("branch", { actor: "user:bj", branches: [w.bj] });
    expect(await code(m.remove(bj, { planId: w.planId, accountIds: [w.accZhao, shAcct], apply: true }))).toBe("authorization/branch_out_of_scope");
    expect((await entryOf(w.planId, w.accZhao))?.entryState).toBe("in_roster");
    expect((await entryOf(w.planId, shAcct))?.entryState).toBe("in_roster");
    expect(await code(m.remove(bj, { planId: w.planId, accountIds: [w.accZhao], apply: true }))).toBe("ok");
    expect(await code(m.remove(hq, { planId: w.planId, accountIds: [shAcct], apply: true }))).toBe("ok");
  });
  it("无 Capability / 越品牌", async () => {
    const { m } = await setup();
    expect(await code(m.remove(planActor("none"), { planId: w.planId, accountIds: [w.accZhao], apply: true }))).toBe("authorization/forbidden");
    expect(await code(m.remove(planActor("hq", { brandScope: new Set(["HISENSE"]) }), { planId: w.planId, accountIds: [w.accZhao], apply: true }))).toBe("not_found/not_found");
  });
  it("恢复：移出后重新提交该行，名单项回到 in_roster，不新增第二行", async () => {
    const { m, deps } = await setup();
    await m.remove(hq, { planId: w.planId, accountIds: [w.accZhao], apply: true });
    expect((await on(w.accZhao)).monitoringEnabled).toBe(false);
    const bytes = new TextEncoder().encode(`${ROSTER_HEADER.join(",")}\r\nS-W1,老赵,13800010004,https://www.douyin.com/user/CCC\r\n`);
    const batchId = (await precheck(deps, { planId: w.planId, fileName: "x.csv", bytes }, hq)).batchId;
    const [row] = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId)));
    expect(row).toMatchObject({ precheckClass: "update", reasonCode: "restore_roster_entry" });
    await confirm(deps, batchId, hq);
    expect(await entryOf(w.planId, w.accZhao)).toMatchObject({ entryState: "in_roster", removedAt: null });
    expect((await t.db.select().from(activityPlanRoster).where(eq(activityPlanRoster.accountId, w.accZhao))).length).toBe(1);
    // 导入重开了因无引用关闭的账号
    expect(await on(w.accZhao)).toMatchObject({ monitoringEnabled: true, monitoringClosedReason: null });
  });
});

describe("疑似空账号确认", () => {
  async function emptyAccount(branchStore = "sW1" as "sW1" | "sH2") {
    const storeId = w.stores[branchStore];
    const staffId = await insertStaff(t.db, { storeId, phone: `1396666${String(Math.floor(Math.random() * 9000) + 1000)}` });
    const accountId = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0 });
    await t.db.update(aa).set({ intakeStatus: "suspected_empty" }).where(eq(aa.accountId, accountId));
    return accountId;
  }
  const targetsOf = async (accountId: bigint) => (await createMonitoringResolver(t.db).targets({ afterAccountId: null, limit: 50, accountIds: [accountId] })).rows.map((r) => r.accountId);
  it("确认前监控目标解析不含它，确认后含；写审计", async () => {
    const { m } = await setup();
    const a = await emptyAccount();
    expect(await targetsOf(a)).toEqual([]);
    const bj = planActor("branch", { actor: "user:bj", branches: [w.bj] });
    expect(await m.confirmEmpty(bj, a)).toEqual({ accountId: a.toString(), intakeStatus: "normal" });
    expect((await on(a)).intakeStatus).toBe("normal");
    expect(await targetsOf(a)).toEqual([a]);
    expect(w.audit.of("suspected_empty_confirmed")).toHaveLength(1);
  });
  it("跨分公司确认被拒，零写入；账号不是疑似空 / 不存在 / 外部监控账号", async () => {
    const { m } = await setup();
    const shEmpty = await emptyAccount("sH2");
    const bj = planActor("branch", { actor: "user:bj", branches: [w.bj] });
    expect(await code(m.confirmEmpty(bj, shEmpty))).toBe("not_found/not_found");
    expect((await on(shEmpty)).intakeStatus).toBe("suspected_empty");
    expect(await code(m.confirmEmpty(planActor("hq"), w.accZhao))).toBe("conflict/not_suspected_empty");
    expect(await code(m.confirmEmpty(planActor("hq"), 987654n))).toBe("not_found/not_found");
    expect(await code(m.confirmEmpty(planActor("hq", { capabilities: new Set(["activity_plan.join"]) }), shEmpty))).toBe("authorization/forbidden");
    expect(await code(m.confirmEmpty(planActor("hq", { brandScope: new Set(["HISENSE"]) }), shEmpty))).toBe("not_found/not_found");
  });
  it("重复确认第二次被拒（不静默成功）", async () => {
    const { m } = await setup();
    const a = await emptyAccount();
    await m.confirmEmpty(planActor("admin"), a);
    expect(await code(m.confirmEmpty(planActor("admin"), a))).toBe("conflict/not_suspected_empty");
  });
});
