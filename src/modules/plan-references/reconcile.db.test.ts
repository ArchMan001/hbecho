// design §7.7 事件矩阵：每个联动事件各一个用例，加边界与幂等。顺序 await，不用并发。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { insertPlan, insertRosterEntry, insertStaff, T0 } from "../../../tests/harness/plan";
import { seedOrg, type OrgSeed } from "../../../tests/harness/seed";
import { createMonitoringSwitch } from "../monitoring/set-switch";
import { memorySyncAuditSink } from "../sync-schedule";
import { adminActor } from "../../../tests/harness/actors";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { activityPlanRoster, activityPlans, staffAccountAssignments as aa } from "../../db/schema";
import { computeStopAt, markGrace, MAX_RECONCILE_ACCOUNTS, reconcileAccounts, referenceCount } from "./reconcile";
import { EVENTS } from "./rules";

const t = useTestDb();
const DAY = 86_400_000;
const at = (days: number, base = T0) => new Date(base.getTime() + days * DAY);
let org: OrgSeed;
let phone = 13900000000;
let branchId: bigint;
async function world() {
  org = await seedOrg(t.db, T0);
  branchId = org.branchIds.get("101")!;
}
/** 一个自有型账号（带自己的专员，避开 D-69 的一专员一账号），可选预设关闭状态。 */
async function acct(over: { enabled?: boolean; reason?: "manual" | "unreferenced_15d"; external?: boolean } = {}) {
  const staffId = await insertStaff(t.db, { storeId: org.storeId, phone: String(++phone) });
  const accountId = await insertAccount(t.db, "douyin", T0);
  if (over.external) {
    const loc = `https://example.test/ext/${accountId}`;
    const { sha } = await import("../../../tests/harness/factories");
    await t.db.insert(aa).values({ watchType: "external", accountId, platformId: (await t.db.select({ p: activityPlans.platformId }).from(activityPlans).limit(1))[0]?.p ?? 1n, currentHomeLocator: loc, currentHomeLocatorSha256: sha(loc), resolvedHomeUrl: loc, resolvedHomeUrlSha256: sha(loc), intakeStatus: "normal", createdAt: T0, updatedAt: T0 });
    return { accountId, staffId };
  }
  await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0 });
  if (over.enabled === false) await t.db.update(aa).set({ monitoringEnabled: false, monitoringClosedReason: over.reason ?? "manual" }).where(eq(aa.accountId, accountId));
  return { accountId, staffId };
}
const entry = (planId: bigint, a: { accountId: bigint; staffId: bigint }, state: "in_roster" | "removed" = "in_roster", now = T0) =>
  insertRosterEntry(t.db, { planId, accountId: a.accountId, staffId: a.staffId, storeId: org.storeId, branchId, state, now });
const state = async (accountId: bigint) => (await t.db.select().from(aa).where(eq(aa.accountId, accountId)))[0]!;
const run = (ids: bigint[], ev: Parameters<typeof reconcileAccounts>[2]) => t.db.transaction((tx) => reconcileAccounts(tx, ids, ev));

describe("名单导入（import）", () => {
  it("新账号入名单：保持开启，不写起点", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct();
    await entry(p, a);
    const r = await run([a.accountId], { ...EVENTS.imported, now: T0 });
    const s = await state(a.accountId);
    expect([s.monitoringEnabled, s.unreferencedSince]).toEqual([true, null]);
    expect(r.events).toEqual([]);
  });
  it("导入重开人工关闭的账号并写 monitoring_reopened_by_import 审计", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct({ enabled: false, reason: "manual" });
    await entry(p, a);
    const r = await run([a.accountId], { ...EVENTS.imported, now: T0 });
    expect((await state(a.accountId)).monitoringEnabled).toBe(true);
    expect(r.reopenedByImport).toEqual([a.accountId]);
    expect(r.events.map((e) => e.event_type)).toEqual(["monitoring_reopened_by_import"]);
    expect(r.events[0]?.before).toMatchObject({ closed_reason: "manual" });
  });
  it("导入也会重开因无引用关闭的账号", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct({ enabled: false, reason: "unreferenced_15d" });
    await entry(p, a);
    const r = await run([a.accountId], { ...EVENTS.imported, now: T0 });
    expect(r.reopened).toEqual([a.accountId]);
    expect((await state(a.accountId)).monitoringClosedReason).toBeNull();
  });
});

describe("显式移出 / 分公司退出 / 计划删除：立即", () => {
  it("移出最后一个引用 → 立即关闭，原因 unreferenced_15d；重复调用不再变化", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct();
    await entry(p, a, "removed");
    const r = await run([a.accountId], { ...EVENTS.removed, now: T0 });
    const s = await state(a.accountId);
    expect([s.monitoringEnabled, s.monitoringClosedReason]).toEqual([false, "unreferenced_15d"]);
    expect(r.closed).toEqual([a.accountId]);
    expect(r.events.map((e) => e.event_type)).toEqual(["monitoring_closed_unreferenced"]);
    const before = await state(a.accountId);
    const again = await run([a.accountId], { ...EVENTS.removed, now: at(1) });
    expect(again.events).toEqual([]);
    expect(again.closed).toEqual([]);
    expect((await state(a.accountId)).updatedAt).toEqual(before.updatedAt);
  });
  it("另一个有效计划仍引用 → 保持开启；两个都移出才关闭", async () => {
    await world();
    const p1 = await insertPlan(t.db, org, { name: "A" });
    const p2 = await insertPlan(t.db, org, { name: "B" });
    const a = await acct();
    const e1 = await entry(p1, a, "removed");
    await entry(p2, a);
    await run([a.accountId], { ...EVENTS.removed, now: T0 });
    expect((await state(a.accountId)).monitoringEnabled).toBe(true);
    await t.db.update(activityPlanRoster).set({ entryState: "removed", removedAt: T0, removedReason: "manual_remove" }).where(eq(activityPlanRoster.planId, p2));
    await run([a.accountId], { ...EVENTS.removed, now: T0 });
    expect((await state(a.accountId)).monitoringEnabled).toBe(false);
    expect(e1).toBeTruthy();
  });
  it("计划删除：只被它引用的立即关闭，另一个有效计划引用的保持开启", async () => {
    await world();
    const doomed = await insertPlan(t.db, org, { name: "删除我" });
    const other = await insertPlan(t.db, org, { name: "保留" });
    const only = await acct();
    const both = await acct();
    await entry(doomed, only);
    await entry(doomed, both);
    await entry(other, both);
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: T0, purgeAfter: at(30), statusChangedAt: T0 }).where(eq(activityPlans.planId, doomed));
    await run([only.accountId, both.accountId], { ...EVENTS.planDeleted, now: T0 });
    expect((await state(only.accountId)).monitoringEnabled).toBe(false);
    expect((await state(both.accountId)).monitoringEnabled).toBe(true);
  });
});

describe("暂停 / 到期：计时 15 天", () => {
  it("暂停：保持开启，起点 = 暂停时刻；第 14 天扫描不关，第 15 天关", async () => {
    await world();
    const p = await insertPlan(t.db, org, { status: "paused", statusChangedAt: T0 });
    const a = await acct();
    await entry(p, a);
    const r = await run([a.accountId], { ...EVENTS.planPaused, now: T0 });
    let s = await state(a.accountId);
    expect([s.monitoringEnabled, s.unreferencedSince]).toEqual([true, T0]);
    expect(r.graceMarked).toEqual([a.accountId]);
    await run([a.accountId], { ...EVENTS.dailyScan, now: at(14) });
    expect((await state(a.accountId)).monitoringEnabled).toBe(true);
    await run([a.accountId], { ...EVENTS.dailyScan, now: at(15) });
    s = await state(a.accountId);
    expect([s.monitoringEnabled, s.monitoringClosedReason]).toEqual([false, "unreferenced_15d"]);
  });
  it("暂停中恢复：起点清空；因无引用关闭的重开，人工关闭的不动", async () => {
    await world();
    const p = await insertPlan(t.db, org, { status: "collecting" });
    const auto = await acct({ enabled: false, reason: "unreferenced_15d" });
    const manual = await acct({ enabled: false, reason: "manual" });
    await entry(p, auto);
    await entry(p, manual);
    await t.db.update(aa).set({ unreferencedSince: T0 });
    await run([auto.accountId, manual.accountId], { ...EVENTS.planResumed, now: at(3) });
    const sa = await state(auto.accountId);
    const sm = await state(manual.accountId);
    expect([sa.monitoringEnabled, sa.unreferencedSince]).toEqual([true, null]);
    expect([sm.monitoringEnabled, sm.monitoringClosedReason, sm.unreferencedSince]).toEqual([false, "manual", null]);
  });
  it("自然过结束日：起点 = 结束日次日北京 00:00，不是扫描那天；无结束日的计划不触发", async () => {
    await world();
    const ended = await insertPlan(t.db, org, { name: "已到期", endsOn: "2026-11-10" }); // 今日 11-11 → 已过
    const open = await insertPlan(t.db, org, { name: "无结束日" });
    const a = await acct();
    const b = await acct();
    await entry(ended, a);
    await entry(open, b);
    const stop = new Date("2026-11-10T16:00:00Z");
    await run([a.accountId, b.accountId], { ...EVENTS.dailyScan, now: T0 });
    expect((await state(a.accountId)).unreferencedSince).toEqual(stop);
    expect((await state(b.accountId)).unreferencedSince).toBeNull();
    await run([a.accountId, b.accountId], { ...EVENTS.dailyScan, now: new Date(stop.getTime() + 14 * DAY) });
    expect((await state(a.accountId)).monitoringEnabled).toBe(true);
    await run([a.accountId, b.accountId], { ...EVENTS.dailyScan, now: new Date(stop.getTime() + 15 * DAY) });
    expect((await state(a.accountId)).monitoringEnabled).toBe(false);
    expect((await state(b.accountId)).monitoringEnabled).toBe(true);
  });
  it("结束日当天仍算引用", async () => {
    await world();
    const p = await insertPlan(t.db, org, { endsOn: "2026-11-11" });
    const a = await acct();
    await entry(p, a);
    expect(await t.db.transaction((tx) => referenceCount(tx, a.accountId, T0))).toBe(1);
    expect(await t.db.transaction((tx) => referenceCount(tx, a.accountId, at(1)))).toBe(0);
  });
  it("延长结束日使引用恢复：因无引用关闭的重开", async () => {
    await world();
    const p = await insertPlan(t.db, org, { endsOn: "2026-11-01" });
    const a = await acct({ enabled: false, reason: "unreferenced_15d" });
    await entry(p, a);
    await t.db.update(activityPlans).set({ endsOn: "2026-12-31" }).where(eq(activityPlans.planId, p));
    const r = await run([a.accountId], { ...EVENTS.endDateChanged, now: T0 });
    expect(r.reopened).toEqual([a.accountId]);
  });
  it("缩短结束日到过去：不立即关闭，起点仍是结束日次日（不是编辑时刻）", async () => {
    await world();
    const p = await insertPlan(t.db, org, { endsOn: "2026-11-01" });
    const a = await acct();
    await entry(p, a);
    await run([a.accountId], { ...EVENTS.endDateChanged, now: T0 });
    const s = await state(a.accountId);
    expect(s.monitoringEnabled).toBe(true);
    expect(s.unreferencedSince).toEqual(new Date("2026-11-01T16:00:00Z"));
  });
  it("起点缺失的候选：扫描补记为 computeStopAt，已超 15 天则同时关闭", async () => {
    await world();
    const p = await insertPlan(t.db, org, { status: "paused", statusChangedAt: T0 });
    const a = await acct();
    await entry(p, a);
    const r = await run([a.accountId], { ...EVENTS.dailyScan, now: at(20) });
    expect(r.graceMarked).toEqual([a.accountId]);
    expect(r.closed).toEqual([a.accountId]);
    expect((await state(a.accountId)).unreferencedSince).toEqual(T0);
  });
});

describe("不动的账号", () => {
  it("外部监控账号、从未入过名单的账号、没有归属的账号", async () => {
    await world();
    await insertPlan(t.db, org);
    const ext = await acct({ external: true });
    const never = await acct();
    const r = await run([ext.accountId, never.accountId, 424242n], { ...EVENTS.removed, now: T0 });
    expect(r.skipped).toBe(3);
    expect(r.closed).toEqual([]);
    expect((await state(never.accountId)).monitoringEnabled).toBe(true);
    expect((await state(ext.accountId)).monitoringEnabled).toBe(true);
  });
  it("人工关闭的账号不被非导入事件重开", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct({ enabled: false, reason: "manual" });
    await entry(p, a);
    for (const ev of [EVENTS.planResumed, EVENTS.endDateChanged, EVENTS.dailyScan]) await run([a.accountId], { ...ev, now: T0 });
    expect((await state(a.accountId)).monitoringClosedReason).toBe("manual");
  });
  it("上级开关不读不写：账号引用 > 0 时即使专员级关闭也不改它", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct();
    await entry(p, a);
    await run([a.accountId], { ...EVENTS.imported, now: T0 });
    const { mediaStaff } = await import("../../db/schema");
    await t.db.update(mediaStaff).set({ monitoringEnabled: false }).where(eq(mediaStaff.staffId, a.staffId));
    await run([a.accountId], { ...EVENTS.imported, now: T0 });
    const [st] = await t.db.select().from(mediaStaff).where(eq(mediaStaff.staffId, a.staffId));
    expect(st?.monitoringEnabled).toBe(false);
    expect((await state(a.accountId)).monitoringEnabled).toBe(true);
  });
});

describe("手动开启与 computeStopAt", () => {
  it("手动开启无引用账号后：起点重置为当下，当天扫描不关，满 15 天后关闭", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct({ enabled: false, reason: "unreferenced_15d" });
    await entry(p, a, "removed", at(-40));
    await t.db.update(aa).set({ monitoringEnabled: true, monitoringClosedReason: null }).where(eq(aa.accountId, a.accountId));
    await t.db.transaction((tx) => markGrace(tx, a.accountId, T0));
    expect((await state(a.accountId)).unreferencedSince).toEqual(T0);
    await run([a.accountId], { ...EVENTS.dailyScan, now: T0 });
    expect((await state(a.accountId)).monitoringEnabled).toBe(true);
    await run([a.accountId], { ...EVENTS.dailyScan, now: at(15) });
    expect((await state(a.accountId)).monitoringEnabled).toBe(false);
  });
  it("markGrace 对从未入过名单的账号什么也不做", async () => {
    await world();
    const a = await acct();
    const r = await t.db.transaction((tx) => markGrace(tx, a.accountId, T0));
    expect(r.graceMarked).toEqual([]);
    expect((await state(a.accountId)).unreferencedSince).toBeNull();
  });
  it("computeStopAt 取全部名单项不再被引用时刻的最大值；无项取 now", async () => {
    await world();
    const p1 = await insertPlan(t.db, org, { name: "一" });
    const p2 = await insertPlan(t.db, org, { name: "二", status: "paused", statusChangedAt: at(-5) });
    const a = await acct();
    await entry(p1, a, "removed", at(-9)); // removedAt = -9
    await entry(p2, a, "in_roster", at(-20)); // 计划暂停于 -5
    expect(await t.db.transaction((tx) => computeStopAt(tx, a.accountId, T0))).toEqual(at(-5));
    expect(await t.db.transaction((tx) => computeStopAt(tx, 999n, T0))).toEqual(T0);
  });
});

describe("上限与幂等", () => {
  it("同一事件重复调用：第二次不写、不审计", async () => {
    await world();
    const p = await insertPlan(t.db, org, { status: "paused", statusChangedAt: T0 });
    const a = await acct();
    await entry(p, a);
    await run([a.accountId], { ...EVENTS.planPaused, now: T0 });
    const first = await state(a.accountId);
    const again = await run([a.accountId], { ...EVENTS.planPaused, now: at(1) });
    expect(again.graceMarked).toEqual([]);
    expect(again.events).toEqual([]);
    expect((await state(a.accountId)).updatedAt).toEqual(first.updatedAt);
  });
  it("超过 10,000 个账号拒绝", async () => {
    const ids = Array.from({ length: MAX_RECONCILE_ACCOUNTS + 1 }, (_, i) => BigInt(i + 1));
    await expect(reconcileAccounts({} as never, ids, { ...EVENTS.dailyScan, now: T0 })).rejects.toMatchObject({ category: "limit", code: "reconcile_too_large" });
  });
});

describe("monitoring set 手动开启（经真实入口）", () => {
  it("开启一个无引用账号 → 同一事务里重置起点；关闭不碰起点", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    const a = await acct({ enabled: false, reason: "manual" });
    await entry(p, a, "removed", at(-40));
    const clock = new FakeClock(at(2));
    const sw = createMonitoringSwitch({ db: t.db, clock, audit: memorySyncAuditSink() });
    await sw.set({ level: "account", id: a.accountId.toString(), enabled: true }, adminActor());
    const s = await state(a.accountId);
    expect([s.monitoringEnabled, s.monitoringClosedReason, s.unreferencedSince]).toEqual([true, null, at(2)]);
    await sw.set({ level: "account", id: a.accountId.toString(), enabled: false }, adminActor());
    const closed = await state(a.accountId);
    expect([closed.monitoringClosedReason, closed.unreferencedSince]).toEqual(["manual", at(2)]);
  });
});
