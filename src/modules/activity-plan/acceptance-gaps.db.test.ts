// 任务 12：逐条核对 acceptance.md 时发现尚未被其他测试覆盖的条目（编号对应 acceptance.md）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, seedAccessOrg } from "../../../tests/harness/access";
import { MemoryAuditSink } from "../../../tests/harness/audit";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { insertPlan, insertRosterEntry, insertStaff, MemoryPlanAudit, planActor, T0 } from "../../../tests/harness/plan";
import { rosterWorld, type RosterWorld } from "../../../tests/harness/roster";
import { seedSyncSettings } from "../../../tests/harness/seed";
import { createDb, type QueryLogger } from "../../db/client";
import { activityPlanRoster, activityPlans, branches, importBatches, importRowResults, mediaStaff, sectors, staffAccountAssignments as aa, stores } from "../../db/schema";
import { createAuthorizer, createContextResolver, createOrgDirectory, toPlanActor } from "../access-control";
import { createMonitoringResolver } from "../monitoring";
import { createTracerCommands } from "../tracer-command";
import { assert, CAP_PLAN_CREATE, CAP_PLAN_JOIN } from "./authz";
import { noDownstream } from "./downstream";
import { createPlanMaintenance } from "./maintenance";
import { createParticipation } from "./participation";
import { createPlans } from "./plans";
import { createPlanQuery } from "./query";
import { ROSTER_HEADER } from "./constants";
import { confirm } from "./roster/confirm";
import { precheck } from "./roster/precheck";
import { createRosterResolver } from "./roster/resolver";
import { createRosterFinalizer } from "./roster/finalize";

const t = useTestDb();
const csv = (...lines: string[]) => new TextEncoder().encode([ROSTER_HEADER.join(","), ...lines].join("\r\n") + "\r\n");
const hq = planActor("hq");
const admin = planActor("admin");
let w: RosterWorld;
async function setup() {
  w = await rosterWorld(t);
  const clock = new FakeClock(T0);
  await seedSyncSettings(t.db, T0);
  const resolver = createMonitoringResolver(t.db);
  const tracer = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
  const deps = { db: t.db, clock, audit: w.audit.sink, tracer, monitoring: resolver };
  return { clock, resolver, deps, query: createPlanQuery({ db: t.db, clock, resolver, audit: w.audit.sink }) };
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

describe("D24 / D25：本地命中的边界", () => {
  it("D24 哈希命中但原文不同不视为命中（复核原文）", async () => {
    const { deps } = await setup();
    const acc = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: w.staff.zhang, now: T0, locator: "https://www.douyin.com/user/KNOWN" });
    // 篡改库中原文但保留哈希：模拟哈希碰撞（哈希相同、原文不同）
    await t.db.update(aa).set({ currentHomeLocator: "https://www.douyin.com/user/DIFFERENT", resolvedHomeUrl: "https://www.douyin.com/user/DIFFERENT" }).where(eq(aa.accountId, acc));
    const r = await precheck(deps, { planId: w.planId, fileName: "x", bytes: csv("S-W1,老张,13800010001,https://www.douyin.com/user/KNOWN") }, hq);
    const [row] = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(r.batchId)));
    expect(row).toMatchObject({ precheckClass: "new", reasonCode: null, accountId: null });
  });
  it("D25 同一专员已有另一个账号（入口文本不同）：预检不拒绝，留给解析后的 intakeAccount", async () => {
    const { deps } = await setup();
    const r = await precheck(deps, { planId: w.planId, fileName: "x", bytes: csv("S-W1,老赵,13800010004,https://www.douyin.com/user/ANOTHER") }, hq); // 老赵已有账号 CCC
    const [row] = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(r.batchId)));
    expect(row?.precheckClass).toBe("new");
  });
});

describe("F17 / F18：驱动", () => {
  async function pendingBatch(n: number) {
    const e = await setup();
    const lines = Array.from({ length: n }, (_, i) => `S-W1,新${i},136${String(10000 + i).padStart(8, "0")},https://www.douyin.com/user/Z${i}`);
    const batchId = (await precheck(e.deps, { planId: w.planId, fileName: "x", bytes: csv(...lines) }, hq)).batchId;
    await confirm(e.deps, batchId, hq);
    return { ...e, batchId };
  }
  it("F17 同时处理的根任务数不超过配置的并发", async () => {
    const e = await pendingBatch(9);
    let inFlight = 0;
    let max = 0;
    const resolver = createRosterResolver({
      db: t.db,
      clock: e.clock,
      audit: w.audit.sink,
      finalize: createRosterFinalizer({ db: t.db, clock: e.clock, supplement: async () => ({ kind: "created" }) }),
      concurrency: 3,
      runRoot: async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return { kind: "retry_wait" }; // 不归并，只观察并发
      },
    });
    const r = await resolver.runOnce();
    expect(r.deferred).toBe(9);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(3);
  });
  it("F18 根任务 summary 没有 account_created（旧根任务）：按 first_seen_at >= 根任务创建时间兜底", async () => {
    const e = await pendingBatch(2);
    const rows = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(e.batchId))).orderBy(importRowResults.rowNo);
    const { syncTasks } = await import("../../db/schema");
    const mk = async (i: number, firstSeen: Date) => {
      const accountId = await insertAccount(t.db, "douyin", firstSeen);
      await insertAssignment(t.db, { accountId, platform: "douyin", staffId: rows[i]!.staffId!, now: firstSeen });
      await t.db.update(syncTasks).set({ status: "succeeded", accountId, finishedAt: T0, resultSummary: { entry_outcome: "normal" } }).where(eq(syncTasks.taskId, rows[i]!.resolveTaskId!));
    };
    await mk(0, new Date(T0.getTime() + 60_000)); // 账号在根任务之后首次出现 → 这次建的
    await mk(1, new Date(T0.getTime() - 86_400_000)); // 早就存在
    const resolver = createRosterResolver({ db: t.db, clock: e.clock, audit: w.audit.sink, finalize: async () => ({ requested: 0, queued: 0, notDue: 0 }), runRoot: async () => ({ kind: "already_terminal" }) });
    await resolver.runOnce();
    const after = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(e.batchId))).orderBy(importRowResults.rowNo);
    expect(after.map((r) => r.outcome)).toEqual(["imported", "unchanged"]);
  });
});

describe("H13：导入遇到上级关闭，不改上级，只提示关闭层级", () => {
  it("专员级被关闭：行结果的 reason_detail 提示；专员开关不被打开", async () => {
    const { deps } = await setup();
    const acc = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: w.staff.zhang, now: T0, locator: "https://www.douyin.com/user/UP" });
    await t.db.update(mediaStaff).set({ monitoringEnabled: false }).where(eq(mediaStaff.staffId, w.staff.zhang));
    const batchId = (await precheck(deps, { planId: w.planId, fileName: "x", bytes: csv("S-W1,老张,13800010001,https://www.douyin.com/user/UP") }, hq)).batchId;
    await confirm(deps, batchId, hq);
    const [row] = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId)));
    expect(row).toMatchObject({ outcome: "unchanged", reasonCode: "existing_account_referenced" });
    expect(row?.reasonDetail).toContain("专员被关闭");
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.staffId, w.staff.zhang)))[0]?.monitoringEnabled).toBe(false); // 上级不改
    expect((await t.db.select().from(aa).where(eq(aa.accountId, acc)))[0]?.monitoringEnabled).toBe(true); // 账号自身开关开启
  });
});

describe("J5：回收站内的计划及其批次不出现在业务查询里", () => {
  it("删除后批次从列表与详情消失；恢复后重新可见", async () => {
    const { deps, query, clock } = await setup();
    const plans = createPlans({ db: t.db, clock, audit: w.audit.sink, downstream: noDownstream });
    const batchId = (await precheck(deps, { planId: w.planId, fileName: "x", bytes: csv("S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA") }, hq)).batchId;
    expect(await query.batches(admin)).toHaveLength(1);
    await plans.delete(admin, w.planId, { apply: true });
    expect(await query.batches(admin)).toHaveLength(0);
    expect(await code(query.batches(admin, { planId: w.planId }))).toBe("not_found/not_found");
    expect(await code(query.batch(admin, batchId))).toBe("not_found/not_found");
    await plans.restore(admin, w.planId);
    expect((await query.batch(admin, batchId)).batchId).toBe(batchId);
  });
});

describe("J7：三个维度各自存储，不存合成列", () => {
  it("录入状态 / 名单状态 / 监控状态是三列，没有综合状态列", async () => {
    await setup();
    const [cols] = await t.pool.query("SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN ('staff_account_assignments','activity_plan_roster','external_accounts')");
    const names = (cols as Array<{ t: string; c: string }>).map((x) => `${x.t}.${x.c}`);
    expect(names).toEqual(expect.arrayContaining(["staff_account_assignments.intake_status", "staff_account_assignments.monitoring_enabled", "activity_plan_roster.entry_state"]));
    expect(names.filter((n) => /composite|overall|display_status|combined/.test(n))).toEqual([]);
  });
});

describe("J18：名单可见范围按加入时的分公司快照", () => {
  it("门店后来换了分公司，名单项仍只对原分公司可见", async () => {
    const { query } = await setup();
    // 把 S-W1 的板块换到分公司 102 的家装板块（门店「换分公司」）
    const [h102] = await t.db.select({ id: sectors.sectorId }).from(sectors).where(eq(sectors.branchId, w.sh));
    await t.db.update(stores).set({ sectorId: h102!.id }).where(eq(stores.storeId, w.stores.sW1));
    const bj = planActor("branch", { actor: "user:bj", branches: [w.bj] });
    const sh = planActor("branch", { actor: "user:sh", branches: [w.sh] });
    expect((await query.roster(bj, w.planId)).items.some((i) => i.accountId === w.accZhao.toString())).toBe(true);
    expect((await query.roster(sh, w.planId)).items).toEqual([]);
  });
});

describe("K2：缺 Capability / 范围不符的调用不产生任何数据库读", () => {
  it("用查询计数器断言", async () => {
    const { clock } = await setup();
    let queries = 0;
    const logger: QueryLogger = { logQuery: () => void queries++ };
    const counted = createDb(t.pool, { logger });
    const deps = { db: counted, clock, audit: w.audit.sink };
    const plans = createPlans({ ...deps, downstream: noDownstream });
    const part = createParticipation(deps);
    const branchActor = planActor("branch", { actor: "user:a", branches: [w.bj] });
    await code(plans.create(planActor("none"), { brand: "HITACHI", platform: "douyin", name: "x", startsOn: "2026-11-01" }));
    await code(plans.create(hq, { brand: "HISENSE", platform: "douyin", name: "x", startsOn: "2026-11-01" })); // 越品牌
    await code(plans.edit(planActor("none"), w.planId, { name: "x" }));
    await code(plans.trash(planActor("none")));
    await code(part.join(planActor("none"), w.planId, w.bj));
    await code(part.join(branchActor, w.planId, w.sh)); // 越分公司
    await code(part.exit(branchActor, w.planId, w.sh));
    expect(queries).toBe(0);
    // 需要读计划行的谓词（创建者）读发生在任何业务写入之前
    const before = (await t.db.select().from(activityPlans).where(eq(activityPlans.planId, w.planId)))[0]!;
    expect(await code(plans.edit(hq, w.planId, { name: "改名" }))).toBe("authorization/not_plan_creator");
    expect((await t.db.select().from(activityPlans).where(eq(activityPlans.planId, w.planId)))[0]).toEqual(before);
    expect(queries).toBeGreaterThan(0);
  });
});

describe("K2a：assert 与 b-access-control 的 authorize 结论一致（契约）", () => {
  it("四类角色 × activity_plan.create / join", async () => {
    const env = accessEnv(t);
    const org = await seedAccessOrg(env);
    const dir = createOrgDirectory(t.db);
    const resolver = createContextResolver({ db: t.db, dir, linkage: accessLinkage(env, { dir }) });
    const authorizer = createAuthorizer();
    const users = [
      await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" }),
      await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] }),
      await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] }),
      await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA }),
    ];
    let compared = 0;
    for (const id of users) {
      const r = await resolver.contextForUser(id, null);
      if (!r.ok) throw new Error(r.reason);
      const adapted = await toPlanActor(r.ctx, { db: t.db });
      if (!adapted.ok) throw new Error(adapted.reason);
      for (const capability of [CAP_PLAN_CREATE, CAP_PLAN_JOIN]) {
        const b = (await authorizer.authorize(r.ctx, { capability })).ok;
        let a = true;
        try {
          assert(adapted.actor, capability);
        } catch {
          a = false;
        }
        expect(a, `${r.ctx.role} ${capability}`).toBe(b);
        compared++;
      }
    }
    expect(compared).toBe(8);
  });
});

describe("K8 / K10：审计内容与服务身份", () => {
  it("审计事件不含文件内容 / 整行原文；手机号明文；维护与解析驱动的身份是 service:plan-worker", async () => {
    const { deps, clock } = await setup();
    const batchId = (await precheck(deps, { planId: w.planId, fileName: "secret-name.csv", bytes: csv("S-W1,新人甲,13800020001,https://www.douyin.com/user/AAA") }, hq)).batchId;
    await confirm(deps, batchId, hq);
    const json = JSON.stringify(w.audit.events);
    expect(json).not.toContain("douyin.com/user/AAA"); // 入口原文不进审计
    expect(json).not.toContain("secret-name.csv");
    expect(json).toContain("13800020001"); // 手机号明文（D-42）
    expect(w.audit.of("staff_created")).toHaveLength(1);
    // 维护
    const plan = await insertPlan(t.db, w.org, { status: "paused", statusChangedAt: T0 });
    const acc = await insertAccount(t.db, "douyin", T0);
    const st = await insertStaff(t.db, { storeId: w.stores.sW1, phone: "13977770001" });
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: st, now: T0 });
    await insertRosterEntry(t.db, { planId: plan, accountId: acc, staffId: st, storeId: w.stores.sW1, branchId: w.bj });
    clock.set(new Date(T0.getTime() + 20 * 86_400_000));
    const audit = new MemoryPlanAudit();
    await createPlanMaintenance({ db: t.db, clock, downstream: noDownstream, audit: audit.sink }).runNow();
    expect(audit.events.length).toBeGreaterThan(0);
    expect(new Set(audit.events.map((e) => e.actor))).toEqual(new Set(["service:plan-worker"]));
  });
});

describe("I6：进程重启当天再跑一次，两步幂等", () => {
  it("新实例同一天再运行不重复关闭、不重复清除", async () => {
    const { clock } = await setup();
    const plan = await insertPlan(t.db, w.org, { status: "paused", statusChangedAt: T0 });
    const acc = await insertAccount(t.db, "douyin", T0);
    const st = await insertStaff(t.db, { storeId: w.stores.sW1, phone: "13977770002" });
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: st, now: T0 });
    await insertRosterEntry(t.db, { planId: plan, accountId: acc, staffId: st, storeId: w.stores.sW1, branchId: w.bj });
    clock.set(new Date(T0.getTime() + 20 * 86_400_000));
    const mk = () => createPlanMaintenance({ db: t.db, clock, downstream: noDownstream, audit: () => {} });
    const first = await mk().runDaily();
    expect(first.closed).toBeGreaterThanOrEqual(1); // 含 rosterWorld 里已移出名单项的老钱账号
    const second = await mk().runDaily(); // 「重启」：新实例没有当日已完成的记忆
    expect(second).toMatchObject({ ran: true, closed: 0, purged: 0, failedSteps: [] });
  });
});

describe("F14：批次完成时对「已存在并引用」的账号发起一次真实的 supplement（a-full-sync 入口）", () => {
  it("上次采集满一周 → queued；未满 7 天 → not_due；新账号（imported）不触发", async () => {
    const { createSyncCommands, createSyncScheduler } = await import("../sync-schedule");
    const { insertProfileSnapshot, insertTask } = await import("../../../tests/harness/factories");
    const { syncBatches } = await import("../../db/schema");
    const { CAP_SYNC_TRIGGER } = await import("../tracer-command");
    const { memorySyncAuditSink } = await import("../sync-schedule");
    const e = await setup();
    const runtime = { environment: "test" as const, modes: { media_user_info: "synchronous" as const, user_video_list: "synchronous" as const } };
    const commands = createSyncCommands({ db: t.db, clock: e.clock, resolver: e.resolver, planner: createSyncScheduler({ db: t.db, clock: e.clock, resolver: e.resolver, runtime }).planner, runtime, audit: memorySyncAuditSink() });
    const worker = { actorId: "service:plan-worker", capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all" as const, mediaStaffIds: "all" as const } };
    const finalize = createRosterFinalizer({ db: t.db, clock: e.clock, supplement: (input) => commands.createSupplement(input, worker) });
    // 两个「已存在并引用」的账号：stale 的上次采集在 8 天前，fresh 的在 1 天前（主页与列表都成功过）
    const now = new Date(T0.getTime() + 10 * 86_400_000);
    e.clock.set(now);
    const [bi] = await t.db.insert(syncBatches).values({ batchKey: Buffer.alloc(32, 9), triggerType: "manual", purpose: "full", logicalAt: T0, status: "succeeded", settingsVersion: 1n, settingsSnapshot: {}, createdAt: T0, updatedAt: T0 });
    const batchKeyId = BigInt(bi.insertId);
    async function existing(phone: string, ago: number) {
      const staffId = await insertStaff(t.db, { storeId: w.stores.sW1, phone });
      const accountId = await insertAccount(t.db, "douyin", T0);
      const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0 });
      const at = new Date(now.getTime() - ago * 86_400_000);
      await insertProfileSnapshot(t.db, { batchId: batchKeyId, accountId, assignmentId, now: at });
      const task = await insertTask(t.db, { batchId: batchKeyId, platform: "douyin", now: at, status: "succeeded", action: "fetch_content_list" });
      await t.db.update((await import("../../db/schema")).syncTasks).set({ accountId, finishedAt: at }).where(eq((await import("../../db/schema")).syncTasks.taskId, task));
      return accountId;
    }
    const stale = await existing("13988880001", 8);
    const fresh = await existing("13988880002", 1);
    const created = await insertAccount(t.db, "douyin", now);
    // 一个导入批次：三行结果，两行 unchanged（已存在并引用），一行 imported（新账号）
    const [b] = await t.db.insert(importBatches).values({ importKind: "roster", planId: w.planId, uploadedByActor: "a", uploadedAt: now, totalRows: 3, status: "completed", createdAt: now, updatedAt: now });
    const bid = BigInt(b.insertId);
    for (const [i, [accountId, outcome]] of ([[stale, "unchanged"], [fresh, "unchanged"], [created, "imported"]] as const).entries()) {
      await t.db.insert(importRowResults).values({ importBatchId: bid, rowNo: i + 1, rawRow: {}, precheckClass: "new", outcome, accountId, createdAt: now });
    }
    const out = await finalize(bid);
    expect(out).toMatchObject({ requested: 2, queued: 1, notDue: 1 });
    const { syncBatches: sb } = await import("../../db/schema");
    const supplements = (await t.db.select().from(sb)).filter((x) => x.purpose === "supplement");
    expect(supplements).toHaveLength(1);
    const { syncTasks: st } = await import("../../db/schema");
    const tasks = (await t.db.select().from(st)).filter((x) => x.batchId === supplements[0]!.batchId);
    expect(new Set(tasks.map((x) => x.accountId))).toEqual(new Set([stale])); // 只有 stale 被补抓；新账号不触发
    // 幂等：同一批次再来一次不新增
    await finalize(bid);
    expect((await t.db.select().from(sb)).filter((x) => x.purpose === "supplement")).toHaveLength(1);
    expect(fresh).toBeTruthy();
    // 摘要记录
    expect(((await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, bid)))[0]!.summary as { refresh: unknown }).refresh).toMatchObject({ requested: 2, queued: 1, notDue: 1 });
  });
});
