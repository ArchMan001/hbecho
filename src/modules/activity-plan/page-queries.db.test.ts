// 页面任务 P1/P5 新增的读取：计划列表概览（规模计数）与跨计划的账号列表 / 详情。越范围 = 稳定的未找到；查询不写业务表。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { planActor, T0 } from "../../../tests/harness/plan";
import { businessCounts, rosterWorld, type RosterWorld } from "../../../tests/harness/roster";
import { activityPlanOwners, branches, mediaStaff, staffAccountAssignments as aa } from "../../db/schema";
import { createMonitoringResolver } from "../monitoring";
import { createAccountQuery } from "./accounts";
import { createPlanQuery } from "./query";

const t = useTestDb();
let w: RosterWorld;
async function setup() {
  w = await rosterWorld(t);
  const resolver = createMonitoringResolver(t.db);
  return { query: createPlanQuery({ db: t.db, clock: { now: () => T0 }, resolver, audit: w.audit.sink }), accounts: createAccountQuery({ db: t.db }) };
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

describe("overview：列表页的规模计数", () => {
  it("账号 / 参与分公司 / 负责人 / 待处理分别计数，已移出的不算账号；板块按固定顺序", async () => {
    const { query } = await setup();
    await t.db.insert(activityPlanOwners).values({ planId: w.planId, branchId: w.bj, slotNo: 1, ownerActor: "user:bj", ownerDisplayName: "李强", claimedAt: T0, claimedVia: "import" });
    const [p] = await query.overview(planActor("admin"));
    expect(p).toMatchObject({ planId: w.planId.toString(), sectors: ["home", "water"], counts: { accounts: 1, branches: 1, owners: 1, pending: 0 } });
  });

  it("分公司人员只数自己分公司的部分；没参加的分公司全是 0；没有 Capability 看不到任何计划", async () => {
    const { query } = await setup();
    expect((await query.overview(planActor("branch", { branches: [w.bj] })))[0]?.counts).toMatchObject({ accounts: 1, branches: 1 });
    expect((await query.overview(planActor("branch", { branches: [w.sh] })))[0]?.counts).toMatchObject({ accounts: 0, branches: 0, owners: 0 });
    expect(await code(query.overview(planActor("none")))).toBe("authorization/forbidden");
  });

  it("没有计划时返回空数组（不是错误）", async () => {
    const { query } = await setup();
    await t.db.execute("DELETE FROM activity_plan_roster" as never);
    await t.db.execute("DELETE FROM activity_plan_branches" as never);
    await t.db.execute("DELETE FROM activity_plan_sectors" as never);
    await t.db.execute("DELETE FROM activity_plans" as never);
    expect(await query.overview(planActor("admin"))).toEqual([]);
  });
});

describe("账号列表与详情", () => {
  it("范围内的自有型账号带综合状态：在名单的正常采集，已移出的显示「已移出活动计划」；查询不写业务表", async () => {
    const { accounts } = await setup();
    const before = await businessCounts(t);
    const r = await accounts.list(planActor("admin"));
    expect(r.total).toBe(2);
    expect(r.counts).toEqual({ normal: 1, removed_from_plan: 1 });
    const byId = new Map(r.items.map((a) => [a.accountId, a]));
    expect(byId.get(w.accZhao.toString())).toMatchObject({ status: { code: "normal" }, staff: { name: "老赵", phone: "13800010004" }, store: { code: "S-W1" }, platform: "douyin", followers: null, posts: null });
    expect(byId.get(w.accQian.toString())?.status.code).toBe("removed_from_plan");
    expect(await businessCounts(t)).toEqual(before);
  });

  it("按综合状态与平台筛选，计数与分页总数来自同一个集合", async () => {
    const { accounts } = await setup();
    const admin = planActor("admin");
    expect((await accounts.list(admin, { status: "normal" })).items.map((a) => a.accountId)).toEqual([w.accZhao.toString()]);
    expect((await accounts.list(admin, { status: "removed_from_plan" })).total).toBe(1);
    expect((await accounts.list(admin, { platform: "xiaohongshu" })).total).toBe(0);
    expect((await accounts.list(admin, { limit: 1, offset: 1 })).items).toHaveLength(1);
    expect(await code(accounts.list(admin, { status: "bogus" }))).toBe("input/status_invalid");
  });

  it("疑似空账号、被停止监控、上级关闭各自落到对应状态；上级关闭取最上级", async () => {
    const { accounts } = await setup();
    const admin = planActor("admin");
    await t.db.update(aa).set({ intakeStatus: "suspected_empty" }).where(eq(aa.accountId, w.accZhao));
    expect((await accounts.detail(admin, w.accZhao)).status.code).toBe("suspected_empty");
    await t.db.update(aa).set({ intakeStatus: "normal", monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(aa.accountId, w.accZhao));
    expect((await accounts.detail(admin, w.accZhao)).status).toMatchObject({ code: "monitoring_stopped", detail: "人工停止" });
    await t.db.update(mediaStaff).set({ monitoringEnabled: false }).where(eq(mediaStaff.staffId, w.staff.zhao));
    expect((await accounts.detail(admin, w.accZhao)).status).toMatchObject({ code: "upstream_closed", label: "专员被关闭" });
    await t.db.update(branches).set({ monitoringEnabled: false }).where(eq(branches.branchId, w.bj));
    expect((await accounts.detail(admin, w.accZhao)).status).toMatchObject({ code: "upstream_closed", label: "分公司被关闭" });
  });

  it("详情给出五级开关链与所在的采集中计划；已移出的账号没有所在计划", async () => {
    const { accounts } = await setup();
    const d = await accounts.detail(planActor("admin"), w.accZhao);
    expect(d.chain.map((n) => n.level)).toEqual(["branch", "dealer", "store", "staff", "account"]);
    expect(d.chain.every((n) => n.enabled && n.active)).toBe(true);
    expect(d.chain[4]).toMatchObject({ id: w.accZhao.toString() });
    expect(d.plans).toEqual([{ planId: w.planId.toString(), name: "测试活动", status: "collecting" }]);
    expect(d.homeLocator).toBe("https://www.douyin.com/user/CCC");
    expect((await accounts.detail(planActor("admin"), w.accQian)).plans).toEqual([]);
  });

  it("范围：分公司人员只看自己分公司，品牌范围外一律未找到；没有 data.account.manage 被拒", async () => {
    const { accounts } = await setup();
    const sh = planActor("branch", { branches: [w.sh] });
    expect((await accounts.list(sh)).total).toBe(0);
    expect(await code(accounts.detail(sh, w.accZhao))).toBe("not_found/not_found");
    const bj = planActor("branch", { branches: [w.bj] });
    expect((await accounts.list(bj)).total).toBe(2);
    expect(await code(accounts.detail(planActor("hq", { brandScope: new Set(["HISENSE"]) }), w.accZhao))).toBe("not_found/not_found");
    expect(await code(accounts.detail(planActor("admin"), 999999n))).toBe("not_found/not_found");
    expect(await code(accounts.list(planActor("hq", { capabilities: new Set(["activity_plan.join"]) })))).toBe("authorization/forbidden");
  });
});
