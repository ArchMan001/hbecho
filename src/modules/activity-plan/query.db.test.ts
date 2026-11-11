// 查询、综合状态、名单读取契约、回流文件（任务 11）。越范围 = 稳定的「未找到」；查询不写业务表。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../../tests/harness/audit";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { insertPlan, insertRosterEntry, insertStaff, planActor, T0 } from "../../../tests/harness/plan";
import { businessCounts, rosterWorld, type RosterWorld } from "../../../tests/harness/roster";
import { seedSyncSettings } from "../../../tests/harness/seed";
import { activityPlanOwners, activityPlans, importBatches, mediaStaff, staffAccountAssignments as aa, stores } from "../../db/schema";
import { createMonitoringResolver } from "../monitoring";
import { createTracerCommands } from "../tracer-command";
import { ROSTER_HEADER } from "./constants";
import { createPlans } from "./plans";
import { createPlanQuery } from "./query";
import { createPlanReader } from "./reader";
import { confirm } from "./roster/confirm";
import { precheck } from "./roster/precheck";
import { noDownstream } from "./downstream";

const t = useTestDb();
let w: RosterWorld;
let clock: FakeClock;
let audit: MemoryAuditSink;
const hq = planActor("hq");
const admin = planActor("admin");
const csv = (...lines: string[]) => new TextEncoder().encode([ROSTER_HEADER.join(","), ...lines].join("\r\n") + "\r\n");
async function setup() {
  w = await rosterWorld(t);
  clock = new FakeClock(T0);
  audit = new MemoryAuditSink();
  await seedSyncSettings(t.db, T0);
  const resolver = createMonitoringResolver(t.db);
  const query = createPlanQuery({ db: t.db, clock, resolver, audit: w.audit.sink });
  const reader = createPlanReader({ db: t.db, resolver });
  const tracer = createTracerCommands({ db: t.db, clock, audit });
  const deps = { db: t.db, clock, audit: w.audit.sink, tracer };
  // 分公司 102 也加入，并各自提交一个批次
  await t.db.execute(`INSERT INTO activity_plan_branches (plan_id, branch_id, status, joined_at, joined_by_actor, updated_at) VALUES (${w.planId}, ${w.sh}, 'joined', NOW(6), 'x', NOW(6))` as never);
  return { query, reader, deps, plans: createPlans({ db: t.db, clock, audit: w.audit.sink, downstream: noDownstream }) };
}
const bjActor = (name = "user:bj") => planActor("branch", { actor: name, branches: [w.bj] });
const shActor = () => planActor("branch", { actor: "user:sh", branches: [w.sh] });
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const x = e as { category?: string; code?: string };
    return `${x.category}/${x.code}`;
  }
  return "ok";
};
async function submit(deps: Awaited<ReturnType<typeof setup>>["deps"], actor: ReturnType<typeof planActor>, ...lines: string[]) {
  const id = (await precheck(deps, { planId: w.planId, fileName: "f.csv", bytes: csv(...lines) }, actor)).batchId;
  return id;
}

describe("名单与批次的范围", () => {
  it("分公司 A 看不到分公司 B 的名单与批次；越范围 = 稳定的未找到", async () => {
    const { query, deps } = await setup();
    const bjBatch = await submit(deps, bjActor(), "S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA");
    const shBatch = await submit(deps, shActor(), "S-H2,新人乙,13800020002,https://www.douyin.com/user/BBB");
    expect((await query.batches(bjActor(), { planId: w.planId })).map((b) => b.batchId)).toEqual([bjBatch]);
    expect((await query.batches(shActor(), { planId: w.planId })).map((b) => b.batchId)).toEqual([shBatch]);
    expect(await code(query.batch(bjActor(), shBatch))).toBe("not_found/not_found");
    expect(await code(query.rows(bjActor(), shBatch))).toBe("not_found/not_found");
    expect(await code(query.returnFile(bjActor(), shBatch))).toBe("not_found/not_found");
    // 名单：只看自己报的那部分（按加入时的分公司快照）
    const r = await query.roster(shActor(), w.planId);
    expect(r.items).toEqual([]);
    expect((await query.roster(bjActor(), w.planId)).total).toBe(2); // 种子里 101 的两个名单项（一个已移出）
    expect((await query.roster(hq, w.planId)).total).toBe(2);
  });
  it("本分公司的人都能看本分公司批次（不限上传人）；总部只给汇总、拿不到逐行；超管全部", async () => {
    const { query, deps } = await setup();
    const batch = await submit(deps, bjActor("user:uploader"), "S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA");
    expect((await query.batch(bjActor("user:colleague"), batch)).batchId).toBe(batch);
    expect((await query.rows(bjActor("user:colleague"), batch)).total).toBe(1);
    const sum = await query.batch(hq, batch);
    expect(sum).toMatchObject({ batchId: batch, rowsVisible: false, precheck: { new_staff: 1 } });
    expect(await code(query.rows(hq, batch))).toBe("authorization/rows_not_visible");
    expect(await code(query.returnFile(hq, batch))).toBe("authorization/rows_not_visible");
    expect((await query.rows(admin, batch)).total).toBe(1);
  });
  it("越品牌的批次 = 未找到；非 roster 批次不出现", async () => {
    const { query, deps } = await setup();
    const batch = await submit(deps, bjActor(), "S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA");
    expect(await code(query.batch(planActor("hq", { brandScope: new Set(["HISENSE"]) }), batch))).toBe("not_found/not_found");
    await t.db.insert(importBatches).values({ importKind: "master_data", uploadedByActor: "a", uploadedAt: T0, totalRows: 1, status: "completed", createdAt: T0, updatedAt: T0 });
    expect(await query.batches(admin)).toHaveLength(1);
    expect(await code(query.batch(admin, "987654"))).toBe("not_found/not_found");
    expect(await code(query.batch(admin, "abc"))).toBe("input/invalid_batch_id");
    expect(await code(query.batches(planActor("none")))).toBe("authorization/forbidden");
  });
  it("计划被清除后：批次与行结果仍在；分公司按提交分公司、总部按快照品牌、超管全部可见；不再出现在以计划为入口的查询里", async () => {
    const { query, deps } = await setup();
    const batch = await submit(deps, bjActor(), "S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA");
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: T0, purgeAfter: T0 }).where(eq(activityPlans.planId, w.planId));
    await t.db.execute("SET FOREIGN_KEY_CHECKS=0" as never);
    await t.db.execute(`DELETE FROM activity_plan_roster WHERE plan_id=${w.planId}` as never);
    await t.db.execute(`DELETE FROM activity_plan_branches WHERE plan_id=${w.planId}` as never);
    await t.db.execute(`DELETE FROM activity_plan_sectors WHERE plan_id=${w.planId}` as never);
    await t.db.execute(`DELETE FROM activity_plans WHERE plan_id=${w.planId}` as never);
    await t.db.execute("SET FOREIGN_KEY_CHECKS=1" as never);
    const b = await query.batch(bjActor(), batch);
    expect(b).toMatchObject({ planName: "测试活动", platform: "douyin", brand: "HITACHI" }); // summary 快照自描述
    expect((await query.rows(bjActor(), batch)).total).toBe(1);
    expect((await query.batch(hq, batch)).batchId).toBe(batch);
    expect((await query.batch(admin, batch)).batchId).toBe(batch);
    expect(await code(query.batch(shActor(), batch))).toBe("not_found/not_found");
    expect(await code(query.planDetail(admin, w.planId))).toBe("not_found/not_found");
    expect(await code(query.roster(admin, w.planId))).toBe("not_found/not_found");
  });
});

describe("计划列表与详情", () => {
  it("详情：规模计数（只计数、没有比率）、参与分公司与负责人槽位、需要的监控判定计划、变更记录", async () => {
    const { query, plans, deps } = await setup();
    const { plan } = await plans.create(hq, { brand: "HITACHI", platform: "douyin", name: "详情测试", startsOn: "2026-11-01", sectors: ["water"] });
    const pid = BigInt(plan.planId);
    await t.db.execute(`INSERT INTO activity_plan_branches (plan_id, branch_id, status, joined_at, joined_by_actor, updated_at) VALUES (${pid}, ${w.bj}, 'joined', NOW(6), 'x', NOW(6))` as never);
    await t.db.insert(activityPlanOwners).values({ planId: pid, branchId: w.bj, slotNo: 1, ownerActor: "user:bj", ownerDisplayName: "北京负责人", claimedAt: T0, claimedVia: "import" });
    const d = await query.planDetail(hq, pid);
    expect(d).toMatchObject({ name: "详情测试", status: "collecting", sectors: ["water"], counts: { accounts: 0, removed: 0, branches: 1, sectors: 1, pending: 0 } });
    expect(d.required.text).toBe("本计划需要 1 份监控判定计划：水机");
    expect(d.branches).toEqual([expect.objectContaining({ code: "101", status: "joined", owners: [{ slotNo: 1, owner: "user:bj", displayName: "北京负责人" }] })]);
    expect(d.changes.map((c) => c.event)).toContain("plan_created");
    expect(JSON.stringify(d)).not.toMatch(/ratio|rate|percent|占比|率/);
    void deps;
  });
  it("详情的变更记录对分公司人员只给与本分公司相关的条目；负责人只给本分公司的槽位", async () => {
    const { query } = await setup();
    await t.db.insert(activityPlanOwners).values([
      { planId: w.planId, branchId: w.bj, slotNo: 1, ownerActor: "user:bj", claimedAt: T0, claimedVia: "import" },
      { planId: w.planId, branchId: w.sh, slotNo: 1, ownerActor: "user:sh", claimedAt: T0, claimedVia: "import" },
    ]);
    const d = await query.planDetail(bjActor(), w.planId);
    expect(d.branches.map((b) => b.code)).toEqual(["101"]);
    expect(d.branches[0]?.owners.map((o) => o.owner)).toEqual(["user:bj"]);
    expect((await query.planDetail(hq, w.planId)).branches.map((b) => b.code)).toEqual(["101", "102"]);
  });
  it("列表：总部看授权品牌内未删除的；分公司只看采集中的；他品牌与回收站看不到", async () => {
    const { query } = await setup();
    await insertPlan(t.db, w.org, { name: "暂停的", status: "paused" });
    await insertPlan(t.db, w.org, { name: "他品牌", brandId: w.org.hisenseBrandId });
    await insertPlan(t.db, w.org, { name: "回收站", status: "deleted" });
    expect((await query.listPlans(hq)).map((p) => p.name).sort()).toEqual(["暂停的", "测试活动"]);
    expect((await query.listPlans(bjActor())).map((p) => p.name)).toEqual(["测试活动"]);
    expect(await query.listPlans(admin, { status: "paused" })).toHaveLength(1);
  });
  it("查询不写任何业务表", async () => {
    const { query, deps } = await setup();
    const batch = await submit(deps, bjActor(), "S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA");
    const before = await businessCounts(t);
    const auditBefore = (await t.db.select().from(importBatches)).length;
    await query.listPlans(hq);
    await query.planDetail(hq, w.planId);
    await query.roster(hq, w.planId);
    await query.batches(admin);
    await query.batch(admin, batch);
    await query.rows(admin, batch);
    expect(await businessCounts(t)).toEqual(before);
    expect((await t.db.select().from(importBatches)).length).toBe(auditBefore);
  });
});

describe("名单的综合状态（六种取值，由真实数据算出）", () => {
  it("正常 / 疑似空 / 上级被关闭 / 人工停止 / 已移出", async () => {
    const { query } = await setup();
    const make = async (phone: string, locator: string) => {
      const staffId = await insertStaff(t.db, { storeId: w.stores.sW1, phone });
      const accountId = await insertAccount(t.db, "douyin", T0);
      await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0, locator });
      await insertRosterEntry(t.db, { planId: w.planId, accountId, staffId, storeId: w.stores.sW1, branchId: w.bj });
      return { accountId, staffId };
    };
    const normal = await make("13933330001", "https://a/1");
    const empty = await make("13933330002", "https://a/2");
    await t.db.update(aa).set({ intakeStatus: "suspected_empty" }).where(eq(aa.accountId, empty.accountId));
    const upstream = await make("13933330003", "https://a/3");
    await t.db.update(mediaStaff).set({ monitoringEnabled: false }).where(eq(mediaStaff.staffId, upstream.staffId));
    const manual = await make("13933330004", "https://a/4");
    await t.db.update(aa).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(aa.accountId, manual.accountId));
    const byAccount = Object.fromEntries((await query.roster(admin, w.planId)).items.map((i) => [i.accountId, i]));
    expect(byAccount[normal.accountId.toString()]?.status.code).toBe("normal");
    expect(byAccount[empty.accountId.toString()]?.status.code).toBe("suspected_empty");
    expect(byAccount[upstream.accountId.toString()]?.status).toMatchObject({ code: "upstream_closed", label: "专员被关闭" });
    expect(byAccount[manual.accountId.toString()]?.status).toMatchObject({ code: "monitoring_stopped", detail: "人工停止" });
    expect(byAccount[w.accQian.toString()]?.status.code).toBe("removed_from_plan");
    expect(byAccount[w.accQian.toString()]?.staff.phone).toBe("13800010005"); // 手机号明文（D-42）
  });
  it("行级：链接无效的行显示「链接无效」", async () => {
    const { query } = await setup();
    const [b] = await t.db.insert(importBatches).values({ importKind: "roster", planId: w.planId, submitterBranchId: w.bj, uploadedByActor: "a", uploadedAt: T0, totalRows: 1, status: "completed", summary: { brand_code: "HITACHI" }, createdAt: T0, updatedAt: T0 });
    await t.db.execute(`INSERT INTO import_row_results (import_batch_id, row_no, raw_row, precheck_class, outcome, created_at) VALUES (${b.insertId}, 1, '{}', 'new', 'invalid', NOW(6))` as never);
    expect((await query.rows(admin, String(b.insertId))).items[0]?.status.code).toBe("invalid_link");
  });
});

describe("rosterSnapshot：给 D / E 的只读契约", () => {
  it("只含在名单项，含专员 / 门店 / 分公司 / 账号 / 实际监控状态；移出后立即消失；暂停时仍可读；回收站不可读", async () => {
    const { reader, plans } = await setup();
    const snap = await reader.rosterSnapshot(w.planId);
    expect(snap).toMatchObject({ planId: w.planId.toString(), status: "collecting" });
    expect(snap!.entries).toEqual([{ staffId: w.staff.zhao.toString(), storeId: w.stores.sW1.toString(), branchId: w.bj.toString(), accountId: w.accZhao.toString(), effectiveMonitoring: true }]);
    await t.db.update(aa).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(aa.accountId, w.accZhao));
    expect((await reader.rosterSnapshot(w.planId))!.entries[0]?.effectiveMonitoring).toBe(false);
    await t.db.update(aa).set({ monitoringEnabled: true, monitoringClosedReason: null }).where(eq(aa.accountId, w.accZhao));
    await t.db.update(activityPlans).set({ status: "paused" }).where(eq(activityPlans.planId, w.planId));
    expect((await reader.rosterSnapshot(w.planId))!.status).toBe("paused");
    expect((await reader.rosterSnapshot(w.planId))!.entries).toHaveLength(1);
    await t.db.update(activityPlans).set({ status: "collecting" }).where(eq(activityPlans.planId, w.planId));
    const { createRosterMaintenance } = await import("./roster/maintain");
    await createRosterMaintenance({ db: t.db, clock, audit: w.audit.sink }).remove(hq, { planId: w.planId, accountIds: [w.accZhao], apply: true });
    expect((await reader.rosterSnapshot(w.planId))!.entries).toEqual([]);
    expect(await reader.statusOf(w.planId)).toBe("collecting");
    await plans.delete(admin, w.planId, { apply: true });
    expect(await reader.rosterSnapshot(w.planId)).toBeNull();
    expect(await reader.statusOf(w.planId)).toBe("deleted");
    expect(await reader.rosterSnapshot(987654n)).toBeNull();
    void stores;
  });
});

describe("回流文件", () => {
  it("只含需要改的行，追加三列；写下载审计；改好后作为新文件重传得到新批次，旧批次不变", async () => {
    const { query, deps } = await setup();
    const batch = await submit(deps, bjActor(), "S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA", "NOPE,乙,13800020002,https://www.douyin.com/user/BBB", "S-W1,丙,=bad,https://www.douyin.com/user/CCC");
    const f = await query.returnFile(bjActor(), batch);
    expect(f.rows).toBe(2);
    const lines = f.content.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^NOPE,乙,13800020002,https:\/\/www\.douyin\.com\/user\/BBB,错误,未写入,门店编码在系统中不存在/);
    expect(lines[2]).toContain("'=bad");
    expect(w.audit.of("roster_report_downloaded")).toHaveLength(1);
    // 改好重传
    const fixed = await submit(deps, bjActor(), "S-W1,乙,13800020002,https://www.douyin.com/user/BBB");
    expect(fixed).not.toBe(batch);
    expect((await query.batch(bjActor(), batch)).precheck).toMatchObject({ error: 2, new_staff: 1 });
  });
  it("确认之后的回流：冲突 / 无效 / 解析失败的行在内，成功的不在", async () => {
    const { query, deps } = await setup();
    const batch = await submit(deps, hq, "S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA", "S-W1,新人乙,13800020002,https://www.douyin.com/user/BBB");
    await confirm(deps, batch, hq);
    await t.db.execute(`UPDATE import_row_results SET outcome='conflict', reason_code='assignment_conflict' WHERE import_batch_id=${batch} AND row_no=1` as never);
    const f = await query.returnFile(admin, batch);
    expect(f.rows).toBe(1);
    expect(f.content).toContain("已记为冲突待处理");
  });
});
