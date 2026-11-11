// 计划生命周期（任务 4）：创建、编辑、状态机、删除 / 恢复、回收站、可见性。顺序 await。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { insertPlan, insertRosterEntry, insertStaff, MemoryPlanAudit, planActor, T0 } from "../../../tests/harness/plan";
import { seedOrg, type OrgSeed } from "../../../tests/harness/seed";
import { activityPlanChanges, activityPlanSectors, activityPlans, externalAccounts, mediaStaff, staffAccountAssignments as aa } from "../../db/schema";
import type { PlanDownstream } from "./downstream";
import { noDownstream } from "./downstream";
import { createPlans, assertCollecting } from "./plans";
import { getVisiblePlan, visiblePlans } from "./visibility";
import { insertBatch } from "../../../tests/harness/factories";

const t = useTestDb();
const DAY = 86_400_000;
let org: OrgSeed;
let phone = 13700000000;

class RecordingDownstream implements PlanDownstream {
  calls: string[] = [];
  running = 0;
  failNotify = false;
  statusAtNotify: string[] = [];
  summarize = async () => ({ judgementPlans: 2, results: 5, running: this.running });
  onDeleted = async (id: bigint) => this.notify("onDeleted", id);
  onRestored = async (id: bigint) => this.notify("onRestored", id);
  purge = async () => {};
  private async notify(name: string, id: bigint) {
    this.calls.push(name);
    // 从另一个连接读：事务没提交就看不到新状态
    const [p] = await t.db.select({ s: activityPlans.status }).from(activityPlans).where(eq(activityPlans.planId, id));
    this.statusAtNotify.push(p!.s);
    if (this.failNotify) throw new Error("下游不可用");
  }
}
async function world(downstream: PlanDownstream = noDownstream) {
  org = await seedOrg(t.db, T0);
  const clock = new FakeClock(T0);
  const audit = new MemoryPlanAudit();
  const plans = createPlans({ db: t.db, clock, audit: audit.sink, downstream });
  return { clock, audit, plans };
}
const admin = planActor("admin");
const hq = (over = {}) => planActor("hq", { actor: "user:creator", ...over });
const input = (over: Record<string, unknown> = {}) => ({ brand: "HITACHI", platform: "douyin", name: "618 活动", startsOn: "2026-11-01", ...over }) as Parameters<ReturnType<typeof createPlans>["create"]>[1];
const planCount = async () => (await t.db.select().from(activityPlans)).length;
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const x = e as { category?: string; code?: string };
    return `${x.category}/${x.code}`;
  }
  return "ok";
};
async function acct() {
  const staffId = await insertStaff(t.db, { storeId: org.storeId, phone: String(++phone) });
  const accountId = await insertAccount(t.db, "douyin", T0);
  await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0 });
  return { accountId, staffId };
}
const inRoster = (planId: bigint, a: { accountId: bigint; staffId: bigint }) =>
  insertRosterEntry(t.db, { planId, accountId: a.accountId, staffId: a.staffId, storeId: org.storeId, branchId: org.branchIds.get("101")! });
const enabled = async (accountId: bigint) => (await t.db.select().from(aa).where(eq(aa.accountId, accountId)))[0]!.monitoringEnabled;

describe("创建", () => {
  it("每一种非法输入各被拒绝且零写入", async () => {
    const { plans } = await world();
    const cases: Array<[string, Parameters<typeof input>[0], string, ReturnType<typeof planActor>?]> = [
      ["缺品牌", { brand: "NOPE" }, "input/brand_not_found", admin],
      ["品牌越范围", { brand: "HISENSE" }, "authorization/brand_out_of_scope"],
      ["视频号", { platform: "wechat_channels" }, "input/platform_unsupported"],
      ["板块空集", { sectors: [] }, "input/sectors_invalid"],
      ["板块非法", { sectors: ["kitchen"] }, "input/sectors_invalid"],
      ["名称空白", { name: "   " }, "input/name_invalid"],
      ["名称 201 字", { name: "名".repeat(201) }, "input/name_invalid"],
      ["说明 2001 字", { description: "说".repeat(2001) }, "input/description_invalid"],
      ["结束日早于开始日", { startsOn: "2026-11-10", endsOn: "2026-11-09" }, "input/dates_invalid"],
      ["日期格式错", { startsOn: "2026/11/01" }, "input/dates_invalid"],
      ["不存在的日期", { startsOn: "2026-02-30" }, "input/dates_invalid"],
    ];
    for (const [label, over, expected, actor] of cases) expect(await code(plans.create(actor ?? hq(), input(over))), label).toBe(expected);
    expect(await code(plans.create(planActor("none"), input())), "无 Capability").toBe("authorization/forbidden");
    expect(await planCount()).toBe(0);
  });
  it("合法创建：采集中，默认两个板块，文案按家装、水机；只选水机一份", async () => {
    const { plans, audit } = await world();
    const a = await plans.create(hq(), input());
    expect(a.plan).toMatchObject({ status: "collecting", brand: "HITACHI", platform: "douyin", createdBy: "user:creator" });
    expect(a.plan.sectors).toEqual(["home", "water"]);
    expect(a.required.text).toBe("本计划需要 2 份监控判定计划：家装、水机");
    const b = await plans.create(hq(), input({ sectors: ["water"], name: "只水机" }));
    expect(b.required.text).toBe("本计划需要 1 份监控判定计划：水机");
    expect(await t.db.select().from(activityPlanSectors)).toHaveLength(3);
    expect(audit.of("plan_created")).toHaveLength(2);
    expect((await t.db.select().from(activityPlanChanges)).map((c) => c.eventType)).toEqual(["plan_created", "plan_created"]);
  });
  it("开始日期早于今天允许；名称去首尾空白；说明空白存为空", async () => {
    const { plans } = await world();
    const r = await plans.create(hq(), input({ startsOn: "2020-01-01", name: "  带空格  ", description: "   " }));
    expect(r.plan).toMatchObject({ name: "带空格", description: null, startsOn: "2020-01-01" });
  });
});

describe("编辑与字段不可变", () => {
  it("品牌 / 平台 / 板块没有更新路径：带这些参数 immutable_field，库中无变化", async () => {
    const { plans } = await world();
    const { plan } = await plans.create(hq(), input());
    for (const k of ["brand", "platform", "sectors", "brandId", "platformId"]) {
      expect(await code(plans.edit(hq(), BigInt(plan.planId), { [k]: "x" } as never)), k).toBe("input/immutable_field");
    }
    const [row] = await t.db.select().from(activityPlans);
    expect(row?.planName).toBe("618 活动");
    expect(await code(plans.edit(hq(), BigInt(plan.planId), { nonsense: 1 } as never))).toBe("input/unknown_field");
  });
  it("创建者改名称 / 说明 / 日期：变更记录一条，含操作者；说明正文不进变更记录", async () => {
    const { plans, audit } = await world();
    const { plan } = await plans.create(hq(), input());
    const r = await plans.edit(hq(), BigInt(plan.planId), { name: "双十一", description: "机密说明", endsOn: "2026-12-31" });
    expect(r.changed.sort()).toEqual(["description", "ends_on", "name"]);
    const ch = (await t.db.select().from(activityPlanChanges)).filter((c) => c.eventType === "plan_edited");
    expect(ch).toHaveLength(1);
    expect(ch[0]?.actor).toBe("user:creator");
    expect(JSON.stringify(ch[0]?.detail)).not.toContain("机密说明");
    expect(audit.of("plan_edited")).toHaveLength(1);
    expect((await plans.edit(hq(), BigInt(plan.planId), { name: "双十一" })).changed).toEqual([]); // 无变化不写
    expect((await t.db.select().from(activityPlanChanges)).filter((c) => c.eventType === "plan_edited")).toHaveLength(1);
  });
  it("结束日早于（合并后的）开始日被拒；任何非删除状态下都可改", async () => {
    const { plans } = await world();
    const { plan } = await plans.create(hq(), input({ startsOn: "2026-11-10" }));
    expect(await code(plans.edit(hq(), BigInt(plan.planId), { endsOn: "2026-11-01" }))).toBe("input/dates_invalid");
    await plans.setStatus(hq(), BigInt(plan.planId), "pause");
    expect(await code(plans.edit(hq(), BigInt(plan.planId), { name: "暂停中改名" }))).toBe("ok");
  });
  it("非创建者、非超管不能改；总部在授权品牌内能看到；超管可改", async () => {
    const { plans } = await world();
    const { plan } = await plans.create(hq(), input());
    const other = planActor("hq", { actor: "user:other-hq" });
    expect(await code(plans.edit(other, BigInt(plan.planId), { name: "x" }))).toBe("authorization/not_plan_creator");
    expect(await getVisiblePlan(t.db, other, BigInt(plan.planId))).not.toBeNull();
    expect(await code(plans.edit(admin, BigInt(plan.planId), { name: "超管改" }))).toBe("ok");
    expect(await code(plans.edit(planActor("hq", { actor: "user:x", brandScope: new Set(["HISENSE"]) }), BigInt(plan.planId), { name: "x" }))).toBe("not_found/not_found");
  });
  it("改结束日立即重算名单账号的引用：缩短到过去 → 记起点不立即关闭；延长 → 恢复", async () => {
    const { plans } = await world();
    const { plan } = await plans.create(hq(), input({ startsOn: "2026-10-01" }));
    const id = BigInt(plan.planId);
    const a = await acct();
    await inRoster(id, a);
    await plans.edit(hq(), id, { endsOn: "2026-11-01" });
    const [s] = await t.db.select().from(aa).where(eq(aa.accountId, a.accountId));
    expect([s?.monitoringEnabled, s?.unreferencedSince]).toEqual([true, new Date("2026-11-01T16:00:00Z")]);
    await plans.edit(hq(), id, { endsOn: null });
    const [s2] = await t.db.select().from(aa).where(eq(aa.accountId, a.accountId));
    expect(s2?.unreferencedSince).toBeNull();
  });
});

describe("状态机", () => {
  it("合法边：采集中 ⇄ 暂停 / 归档；状态变更时间更新", async () => {
    const { plans, clock, audit } = await world();
    const { plan } = await plans.create(hq(), input());
    const id = BigInt(plan.planId);
    clock.advance(DAY);
    expect((await plans.setStatus(hq(), id, "pause")).to).toBe("paused");
    expect((await plans.setStatus(hq(), id, "resume")).to).toBe("collecting");
    expect((await plans.setStatus(hq(), id, "archive")).to).toBe("archived");
    expect((await plans.setStatus(hq(), id, "resume")).to).toBe("collecting");
    const [row] = await t.db.select().from(activityPlans);
    expect(row?.statusChangedAt).toEqual(new Date(T0.getTime() + DAY));
    expect(audit.of("plan_status_changed")).toHaveLength(4);
  });
  it("非法边：暂停→归档、暂停→暂停、采集中→恢复、已删除→暂停", async () => {
    const { plans } = await world();
    const { plan } = await plans.create(hq(), input());
    const id = BigInt(plan.planId);
    expect(await code(plans.setStatus(hq(), id, "resume"))).toBe("conflict/invalid_transition");
    await plans.setStatus(hq(), id, "pause");
    expect(await code(plans.setStatus(hq(), id, "archive"))).toBe("conflict/invalid_transition");
    expect(await code(plans.setStatus(hq(), id, "pause"))).toBe("conflict/invalid_transition");
    await plans.setStatus(hq(), id, "resume");
    await plans.delete(hq(), id, { apply: true });
    expect(await code(plans.setStatus(hq(), id, "pause"))).toBe("conflict/invalid_transition");
    expect(await code(plans.setStatus(planActor("hq", { actor: "user:other-hq" }), id, "pause"))).toBe("not_found/not_found"); // 回收站对他人不可见
  });
  it("assertCollecting：非 collecting 一律 plan_not_collecting", () => {
    expect(() => assertCollecting({ status: "collecting" })).not.toThrow();
    for (const status of ["paused", "archived", "deleted"]) expect(() => assertCollecting({ status })).toThrow(/只有采集中/);
  });
  it("暂停保持账号开启并记起点；恢复清起点", async () => {
    const { plans, clock } = await world();
    const { plan } = await plans.create(hq(), input());
    const id = BigInt(plan.planId);
    const a = await acct();
    await inRoster(id, a);
    clock.advance(DAY);
    await plans.setStatus(hq(), id, "pause");
    const [s] = await t.db.select().from(aa).where(eq(aa.accountId, a.accountId));
    expect([s?.monitoringEnabled, s?.unreferencedSince]).toEqual([true, new Date(T0.getTime() + DAY)]);
    await plans.setStatus(hq(), id, "resume");
    expect((await t.db.select().from(aa).where(eq(aa.accountId, a.accountId)))[0]?.unreferencedSince).toBeNull();
  });
});

describe("删除、回收站与恢复", () => {
  it("预览零写入：返回下游数、名单数与将关闭的账号数", async () => {
    const down = new RecordingDownstream();
    const { plans } = await world(down);
    const { plan } = await plans.create(hq(), input());
    const id = BigInt(plan.planId);
    const only = await acct();
    const shared = await acct();
    const other = await insertPlan(t.db, org, { name: "另一个" });
    await inRoster(id, only);
    await inRoster(id, shared);
    await insertRosterEntry(t.db, { planId: other, accountId: shared.accountId, staffId: shared.staffId, storeId: org.storeId, branchId: org.branchIds.get("101")! });
    const before = await t.db.select().from(activityPlans);
    const pv = await plans.delete(hq(), id);
    expect(pv).toMatchObject({ kind: "preview", apply: false, downstream: { judgementPlans: 2, results: 5, running: 0 }, roster: { inRoster: 2, accountsToClose: 1 } });
    expect(await t.db.select().from(activityPlans)).toEqual(before);
    expect(down.calls).toEqual([]);
    expect(await enabled(only.accountId)).toBe(true);
  });
  it("下游有在途执行 → 拒绝，状态不变", async () => {
    const down = new RecordingDownstream();
    down.running = 1;
    const { plans } = await world(down);
    const { plan } = await plans.create(hq(), input());
    expect(await code(plans.delete(hq(), BigInt(plan.planId), { apply: true }))).toBe("conflict/downstream_running");
    expect((await t.db.select().from(activityPlans))[0]?.status).toBe("collecting");
  });
  it("apply：计划消失于业务查询、立即关闭只被它引用的账号、另一个有效计划引用的保持开启、通知在提交之后", async () => {
    const down = new RecordingDownstream();
    const { plans, audit } = await world(down);
    const { plan } = await plans.create(hq(), input());
    const id = BigInt(plan.planId);
    const only = await acct();
    const shared = await acct();
    const other = await insertPlan(t.db, org, { name: "另一个" });
    await inRoster(id, only);
    await inRoster(id, shared);
    await insertRosterEntry(t.db, { planId: other, accountId: shared.accountId, staffId: shared.staffId, storeId: org.storeId, branchId: org.branchIds.get("101")! });
    const r = await plans.delete(hq(), id, { apply: true });
    expect(r).toMatchObject({ kind: "applied", accountsClosed: 1 });
    expect(await enabled(only.accountId)).toBe(false);
    expect(await enabled(shared.accountId)).toBe(true);
    expect((await visiblePlans(t.db, admin)).map((p) => p.planId)).not.toContain(id);
    expect(await getVisiblePlan(t.db, admin, id)).toBeNull();
    expect(down.calls).toEqual(["onDeleted"]);
    expect(down.statusAtNotify).toEqual(["deleted"]); // 通知发出时，另一连接已能读到提交后的状态
    expect(audit.of("plan_deleted")).toHaveLength(1);
    expect(audit.of("monitoring_closed_unreferenced")).toHaveLength(1);
    const [row] = await t.db.select().from(activityPlans).where(eq(activityPlans.planId, id));
    expect(row).toMatchObject({ status: "deleted", statusBeforeDelete: "collecting" });
    expect(row?.purgeAfter).toEqual(new Date(T0.getTime() + 30 * DAY));
  });
  it("删除不动账号 / 归属 / 专员 / 名单项 / 批次", async () => {
    const { plans } = await world();
    const { plan } = await plans.create(hq(), input());
    const a = await acct();
    await inRoster(BigInt(plan.planId), a);
    await insertBatch(t.db, T0);
    const count = async () => [(await t.db.select().from(externalAccounts)).length, (await t.db.select().from(aa)).length, (await t.db.select().from(mediaStaff)).length];
    const before = await count();
    await plans.delete(hq(), BigInt(plan.planId), { apply: true });
    expect(await count()).toEqual(before);
  });
  it("29 天可恢复且回到删除前的状态；账号因无引用被关的重开；31 天不可", async () => {
    const down = new RecordingDownstream();
    const { plans, clock, audit } = await world(down);
    const p1 = (await plans.create(hq(), input({ name: "一" }))).plan;
    const p2 = (await plans.create(hq(), input({ name: "二" }))).plan;
    await plans.setStatus(hq(), BigInt(p1.planId), "pause");
    const a = await acct();
    await inRoster(BigInt(p2.planId), a);
    await plans.delete(hq(), BigInt(p2.planId), { apply: true });
    await plans.delete(hq(), BigInt(p1.planId), { apply: true });
    expect(await enabled(a.accountId)).toBe(false);
    clock.advance(29 * DAY);
    const r = await plans.restore(hq(), BigInt(p2.planId));
    expect(r.plan.status).toBe("collecting");
    expect(r.accountsReopened).toBe(1);
    expect(await enabled(a.accountId)).toBe(true);
    expect(down.statusAtNotify).toEqual(["deleted", "deleted", "collecting"]);
    expect(audit.of("plan_restored")).toHaveLength(1);
    expect((await plans.restore(hq(), BigInt(p1.planId))).plan.status).toBe("paused"); // 删除前是暂停
    await plans.delete(hq(), BigInt(p2.planId), { apply: true });
    clock.advance(31 * DAY);
    expect(await code(plans.restore(hq(), BigInt(p2.planId)))).toBe("not_found/not_in_trash");
  });
  it("回收站只给创建者与超管；恢复也是", async () => {
    const { plans } = await world();
    const { plan } = await plans.create(hq(), input());
    await plans.delete(hq(), BigInt(plan.planId), { apply: true });
    expect((await plans.trash(hq())).map((p) => p.planId)).toEqual([plan.planId]);
    expect((await plans.trash(admin)).map((p) => p.planId)).toEqual([plan.planId]);
    const other = planActor("hq", { actor: "user:other-hq" });
    expect(await plans.trash(other)).toEqual([]);
    expect(await code(plans.restore(other, BigInt(plan.planId)))).toBe("not_found/not_found");
    expect(await code(plans.restore(planActor("branch", { branches: [1n] }), BigInt(plan.planId)))).toBe("authorization/forbidden");
  });
  it("下游通知失败不回滚事务，只写审计", async () => {
    const down = new RecordingDownstream();
    down.failNotify = true;
    const { plans, audit } = await world(down);
    const { plan } = await plans.create(hq(), input());
    await plans.delete(hq(), BigInt(plan.planId), { apply: true });
    expect((await t.db.select().from(activityPlans))[0]?.status).toBe("deleted");
    expect(audit.of("downstream_notify_failed")).toHaveLength(1);
  });
});

describe("可见性", () => {
  it("总部看授权品牌内未删除的全部；分公司只看采集中的；他品牌与回收站都看不到", async () => {
    const { plans } = await world();
    await plans.create(hq(), input({ name: "采集中" }));
    const paused = (await plans.create(hq(), input({ name: "暂停" }))).plan;
    await plans.setStatus(hq(), BigInt(paused.planId), "pause");
    const gone = (await plans.create(hq(), input({ name: "已删" }))).plan;
    await plans.delete(hq(), BigInt(gone.planId), { apply: true });
    await insertPlan(t.db, org, { name: "他品牌", brandId: org.hisenseBrandId });
    const names = async (a: ReturnType<typeof planActor>) => (await visiblePlans(t.db, a)).map((p) => p.planName).sort();
    expect(await names(hq())).toEqual(["暂停", "采集中"]);
    expect(await names(planActor("branch", { branches: [1n] }))).toEqual(["采集中"]);
    expect(await names(admin)).toEqual(["他品牌", "暂停", "采集中"]);
    expect(await names(planActor("none"))).toEqual([]);
  });
});
