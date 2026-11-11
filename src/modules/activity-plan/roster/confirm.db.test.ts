// 确认写入（任务 7）：前置检查零写入、租约 / fencing / 续跑、专员新建与唯一键冲突、根任务共用一个同步批次。
// 并发用例用显式闸门，不用 Promise.all。
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../../tests/harness/factories";
import { FakeClock } from "../../../../tests/harness/fake-clock";
import { insertPlan, insertStaff, planActor, T0 } from "../../../../tests/harness/plan";
import { businessCounts, rosterWorld, type RosterWorld } from "../../../../tests/harness/roster";
import { seedSyncSettings } from "../../../../tests/harness/seed";
import { MemoryAuditSink } from "../../../../tests/harness/audit";
import { activityPlanOwners, activityPlanRoster, activityPlans, authUsers, accessUsers, importBatches, importRowResults, mediaStaff, staffAccountAssignments as aa, syncBatches, syncTasks } from "../../../db/schema";
import { createTracerCommands, DEFAULT_CONFIG } from "../../tracer-command";
import { ROSTER_HEADER } from "../constants";
import { confirm, type ConfirmDeps } from "./confirm";
import { precheck } from "./precheck";

const t = useTestDb();
const fx = (n: string): Uint8Array => readFileSync(new URL(`../../../../tests/fixtures/roster/${n}`, import.meta.url));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const HEADER = ROSTER_HEADER.join(",");
const csv = (...lines: string[]): Uint8Array => enc([HEADER, ...lines].join("\r\n") + "\r\n");
let w: RosterWorld;
let clock: FakeClock;

async function setup(opts: { planOver?: Parameters<typeof rosterWorld>[1]; deps?: Partial<ConfirmDeps> } = {}) {
  w = await rosterWorld(t, opts.planOver);
  clock = new FakeClock(T0);
  await seedSyncSettings(t.db, T0);
  const tracer = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
  const deps: ConfirmDeps = { db: t.db, clock, audit: w.audit.sink, tracer, ...opts.deps };
  return { deps, hq: planActor("hq"), branch: planActor("branch", { branches: [w.bj] }) };
}
const pre = async (deps: ConfirmDeps, bytes: Uint8Array, actor = planActor("hq")) => (await precheck(deps, { planId: w.planId, fileName: "x.csv", bytes }, actor)).batchId;
const rowsOf = async (batchId: string) => (await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId))).orderBy(importRowResults.rowNo));
const batchOf = async (batchId: string) => (await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(batchId))))[0]!;
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const x = e as { category?: string; code?: string };
    return `${x.category}/${x.code}`;
  }
  return "ok";
};
const rosterTasks = () => t.db.select().from(syncTasks).where(eq(syncTasks.requestedAction, "resolve_account"));

describe("混合样例", () => {
  it("专员新建、本地归并、根任务挂起；错误行不动；一个同步批次", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, fx("mixed.utf8.csv"));
    const before = await businessCounts(t);
    const r = await confirm(deps, batchId, hq);
    expect(r).toMatchObject({ status: "resolving", alreadyConfirmed: false, confirm: { pending_account: 2, unchanged: 2, staff_created: 1, conflict: 0, owner_claimed: false } });
    const rows = await rowsOf(batchId);
    expect(rows.map((x) => [x.rowNo, x.precheckClass, x.outcome, x.reasonCode])).toEqual([
      [2, "new_staff", "pending_account", null],
      [3, "new", "pending_account", null],
      [4, "unchanged", "unchanged", "already_in_roster"],
      [5, "update", "unchanged", "restored_roster_entry"],
      [6, "error", null, "store_not_found"],
      [7, "error", null, "phone_invalid"],
      [8, "error", null, "non_home_locator"],
      [9, "error", null, "platform_mismatch"],
      [10, "error", null, "branch_not_joined"],
    ]);
    // 新专员：门店 S-W1，姓名取文件原文，没有创建任何登录账号
    const [made] = await t.db.select().from(mediaStaff).where(eq(mediaStaff.phone, "13800020001"));
    expect(made).toMatchObject({ staffName: "新人甲", storeId: w.stores.sW1, status: "active" });
    expect(rows[0]?.staffId).toBe(made?.staffId);
    expect((await t.db.select().from(authUsers)).length + (await t.db.select().from(accessUsers)).length).toBe(0);
    expect((await businessCounts(t)).media_staff).toBe(before.media_staff! + 1);
    // 根任务数 = 需要解析的行数，全部挂在一个 intake 同步批次下，profile_only，幂等键 roster:<批次>:<行号>
    const tasks = await rosterTasks();
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((x) => x.batchId)).size).toBe(1);
    const [sb] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, tasks[0]!.batchId));
    expect(sb).toMatchObject({ purpose: "intake", plannedTaskCount: 2 });
    expect(tasks.map((x) => (x.taskParameters as { profile_only: boolean }).profile_only)).toEqual([true, true]);
    expect(tasks.map((x) => x.taskId).sort()).toEqual(rows.filter((x) => x.outcome === "pending_account").map((x) => x.resolveTaskId!).sort());
    expect(tasks.every((x) => x.status === "pending" && x.subjectType === "media_staff" && x.submittedByActor === "user:hq")).toBe(true);
    // 恢复的名单项回到 in_roster，没有新增第二行
    const entries = await t.db.select().from(activityPlanRoster).where(eq(activityPlanRoster.accountId, w.accQian));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entryState: "in_roster", removedAt: null, removedReason: null });
    // 批次
    const b = await batchOf(batchId);
    expect(b).toMatchObject({ status: "resolving", writingToken: null, heartbeatAt: null, confirmedByActor: "user:hq", newRows: 0, skippedRows: 2, errorRows: 5 });
    expect(w.audit.of("staff_created")).toHaveLength(1);
    expect(w.audit.of("staff_created")[0]).toMatchObject({ batch_id: batchId, after: { phone: "13800020001" } });
    expect(w.audit.of("roster_batch_confirmed")).toHaveLength(1);
  });
  it("重复确认返回原结果，不重复写入", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, fx("mixed.utf8.csv"));
    const first = await confirm(deps, batchId, hq);
    const counts = await businessCounts(t);
    const again = await confirm(deps, batchId, hq);
    expect(again).toMatchObject({ alreadyConfirmed: true, status: "resolving", confirm: first.confirm });
    expect(await businessCounts(t)).toEqual(counts);
    expect(w.audit.of("staff_created")).toHaveLength(1);
  });
  it("没有任何需要解析的行 → 批次直接 completed，并触发 onCompleted", async () => {
    const done: bigint[] = [];
    const { deps, hq } = await setup({ deps: { onCompleted: async (id) => void done.push(id) } });
    const batchId = await pre(deps, csv("S-W1,老赵,13800010004,https://www.douyin.com/user/CCC"));
    const r = await confirm(deps, batchId, hq);
    expect(r).toMatchObject({ status: "completed", confirm: { unchanged: 1, pending_account: 0 } });
    expect(done).toEqual([BigInt(batchId)]);
    expect(await rosterTasks()).toHaveLength(0);
  });
  it("已存在专员姓名与文件不同：不覆盖，行结果记 staff_name_differs", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, csv("S-W1,张三,13800010001,https://www.douyin.com/user/ZZZ"));
    await confirm(deps, batchId, hq);
    const [row] = await rowsOf(batchId);
    expect(row).toMatchObject({ outcome: "pending_account", reasonCode: "staff_name_differs" });
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.phone, "13800010001")))[0]?.staffName).toBe("老张");
  });
});

describe("入口本地命中：不调供应商", () => {
  it("命中同专员已有账号 → unchanged/existing_account_referenced 并建名单项；命中他人账号 → conflict/assignment_conflict；都不建根任务", async () => {
    const { deps, hq } = await setup();
    const same = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId: same, platform: "douyin", staffId: w.staff.zhang, now: T0, locator: "https://www.douyin.com/user/SAME" });
    const other = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId: other, platform: "douyin", staffId: w.staff.li, now: T0, locator: "https://www.douyin.com/user/OTHER" });
    await t.db.update(aa).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(aa.accountId, same));
    const batchId = await pre(deps, csv("S-W1,老张,13800010001,https://www.douyin.com/user/SAME", "S-W1,新人乙,13800020009,https://www.douyin.com/user/OTHER"));
    const r = await confirm(deps, batchId, hq);
    expect(r).toMatchObject({ status: "completed", confirm: { unchanged: 1, conflict: 1, pending_account: 0, staff_created: 0 } });
    const rows = await rowsOf(batchId);
    expect(rows.map((x) => [x.outcome, x.reasonCode])).toEqual([["unchanged", "existing_account_referenced"], ["conflict", "assignment_conflict"]]);
    expect(await rosterTasks()).toHaveLength(0);
    expect((await t.db.select().from(activityPlanRoster).where(and(eq(activityPlanRoster.planId, w.planId), eq(activityPlanRoster.accountId, same)))).length).toBe(1);
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.phone, "13800020009"))).length).toBe(0); // 冲突行不新建专员
    // 导入重开了被人工关闭的账号，并留审计
    expect((await t.db.select().from(aa).where(eq(aa.accountId, same)))[0]?.monitoringEnabled).toBe(true);
    expect(w.audit.of("monitoring_reopened_by_import")).toHaveLength(1);
  });
});

describe("前置检查：任一失败整条命令零写入", () => {
  it("capability 未放行（生产环境全部 disabled）", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, fx("mixed.utf8.csv"));
    const prod = { ...deps, tracerConfig: { ...DEFAULT_CONFIG, environment: "production" as const } };
    const before = await businessCounts(t);
    expect(await code(confirm(prod, batchId, hq))).toBe("conflict/unsupported_capability");
    expect(await businessCounts(t)).toEqual(before);
    expect((await batchOf(batchId)).status).toBe("awaiting_confirm");
    expect((await rowsOf(batchId)).every((x) => x.outcome === null)).toBe(true);
    expect(w.audit.of("roster_confirmation_rejected")).toHaveLength(1);
  });
  it("预检后计划被暂停 → plan_not_collecting", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, fx("mixed.utf8.csv"));
    await t.db.update(activityPlans).set({ status: "paused" }).where(eq(activityPlans.planId, w.planId));
    const before = await businessCounts(t);
    expect(await code(confirm(deps, batchId, hq))).toBe("conflict/plan_not_collecting");
    expect(await businessCounts(t)).toEqual(before);
  });
  it("预检后计划被删除 / 分公司已退出", async () => {
    const { deps, hq, branch } = await setup();
    const batchId = await pre(deps, fx("mixed.utf8.csv"), branch);
    await t.db.update(activityPlans).set({ status: "deleted", statusBeforeDelete: "collecting", deletedAt: T0, purgeAfter: T0 }).where(eq(activityPlans.planId, w.planId));
    expect(await code(confirm(deps, batchId, hq))).toBe("not_found/not_found");
    await t.db.update(activityPlans).set({ status: "collecting", statusBeforeDelete: null, deletedAt: null, purgeAfter: null }).where(eq(activityPlans.planId, w.planId));
    await t.db.execute(`UPDATE activity_plan_branches SET status='exited', exited_at=NOW(6) WHERE plan_id=${w.planId}` as never);
    expect(await code(confirm(deps, batchId, branch))).toBe("conflict/branch_not_joined");
  });
  it("非 roster 批次、不存在的批次、范围外批次 → 未找到", async () => {
    const { deps, hq } = await setup();
    const [md] = await t.db.insert(importBatches).values({ importKind: "master_data", uploadedByActor: "a", uploadedAt: T0, totalRows: 1, status: "awaiting_confirm", createdAt: T0, updatedAt: T0 });
    expect(await code(confirm(deps, String(md.insertId), hq))).toBe("not_found/not_found");
    expect(await code(confirm(deps, "987654", hq))).toBe("not_found/not_found");
    const batchId = await pre(deps, fx("basic.utf8.csv"), planActor("branch", { branches: [w.bj] }));
    expect(await code(confirm(deps, batchId, planActor("branch", { branches: [w.sh] })))).toBe("not_found/not_found");
    expect(await code(confirm(deps, "abc", hq))).toBe("input/invalid_batch_id");
    expect(await code(confirm(deps, batchId, planActor("none")))).toBe("authorization/forbidden"); // Capability 先于读批次
  });
  it("无 Capability（有分公司范围但没有 join）", async () => {
    const { deps } = await setup();
    const batchId = await pre(deps, fx("basic.utf8.csv"));
    const noCap = planActor("none", { branchScope: "all", brandScope: "all" });
    expect(await code(confirm(deps, batchId, noCap))).toBe("authorization/forbidden");
  });
  it("precheck_failed 的批次不能确认", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, fx("basic.utf8.csv"));
    await t.db.update(importBatches).set({ status: "precheck_failed" }).where(eq(importBatches.importBatchId, BigInt(batchId)));
    expect(await code(confirm(deps, batchId, hq))).toBe("conflict/batch_not_confirmable");
  });
});

describe("负责人名额（确认时占用）", () => {
  it("分公司人员提交含新增行的批次 → 占一个槽；总部不占；已满时整批失败且零写入", async () => {
    const { deps, hq } = await setup();
    const a = planActor("branch", { actor: "user:a", branches: [w.bj] });
    const b = planActor("branch", { actor: "user:b", branches: [w.bj] });
    const c = planActor("branch", { actor: "user:c", branches: [w.bj] });
    const file = (n: number) => csv(`S-W1,新${n},13700000${100 + n},https://www.douyin.com/user/Q${n}`);
    const r1 = await confirm(deps, await pre(deps, file(1), a), a);
    expect(r1.confirm.owner_claimed).toBe(true);
    await confirm(deps, await pre(deps, file(2), b), b);
    expect((await confirm(deps, await pre(deps, file(3), hq), hq)).confirm.owner_claimed).toBe(false);
    const batchC = await pre(deps, file(4), c);
    const before = await businessCounts(t);
    let err: { code?: string; message?: string } = {};
    try {
      await confirm(deps, batchC, c);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe("owner_slots_full");
    expect(err.message).toContain("user:a");
    expect(err.message).toContain("user:b");
    expect(await businessCounts(t)).toEqual(before);
    expect((await batchOf(batchC)).status).toBe("awaiting_confirm");
    expect((await rowsOf(batchC)).every((x) => x.outcome === null)).toBe(true);
    // 已是负责人的人再次提交不重复占用
    const again = await confirm(deps, await pre(deps, file(5), a), a);
    expect(again.confirm.owner_claimed).toBe(false); // 本批没占（已是负责人）
    expect((await t.db.select().from(activityPlanOwners)).map((o) => o.ownerActor).sort()).toEqual(["user:a", "user:b"]);
  });
  it("全部是本地可确认的已存在行 → 不占用", async () => {
    const { deps } = await setup();
    const a = planActor("branch", { actor: "user:a", branches: [w.bj] });
    const batchId = await pre(deps, csv("S-W1,老赵,13800010004,https://www.douyin.com/user/CCC"), a);
    const r = await confirm(deps, batchId, a);
    expect(r.confirm.owner_claimed).toBe(false);
    expect(await t.db.select().from(activityPlanOwners)).toEqual([]);
  });
});

describe("重分类（precheck_stale / 专员竞争）", () => {
  it("预检之后门店被撤 → 该行 conflict/precheck_stale，不写", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, csv("S-W1,甲,13800020011,https://www.douyin.com/user/P1", "S-H1,乙,13800020012,https://www.douyin.com/user/P2"));
    await t.db.execute(`UPDATE stores SET status='closed' WHERE store_id=${w.stores.sW1}` as never);
    const r = await confirm(deps, batchId, hq);
    const rows = await rowsOf(batchId);
    expect(rows[0]).toMatchObject({ outcome: "conflict", reasonCode: "precheck_stale" });
    expect(rows[0]?.reasonDetail).toContain("store_closed");
    expect(rows[1]?.outcome).toBe("pending_account");
    expect(r.confirm).toMatchObject({ conflict: 1, pending_account: 1, staff_created: 1 });
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.phone, "13800020011"))).length).toBe(0);
  });
  it("预检与确认之间有人先建了同号专员 → conflict/staff_phone_conflict，不产生第二名专员，其余行继续", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, csv("S-W1,甲,13800020021,https://www.douyin.com/user/R1", "S-W1,乙,13800020022,https://www.douyin.com/user/R2"));
    await insertStaff(t.db, { storeId: w.stores.sW1, name: "抢先者", phone: "13800020021" });
    await confirm(deps, batchId, hq);
    const rows = await rowsOf(batchId);
    expect(rows.map((x) => [x.outcome, x.reasonCode])).toEqual([["conflict", "staff_phone_conflict"], ["pending_account", null]]);
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.phone, "13800020021"))).length).toBe(1);
  });
  it("分类之后、写入之前被另一个连接抢先建号 → 唯一键冲突在保存点内回滚，该行 staff_phone_conflict，同块其他行继续", async () => {
    let raced = false;
    const { deps, hq } = await setup({
      deps: {
        hooks: {
          beforeApply: async (rowNo) => {
            if (rowNo === 1 && !raced) {
              raced = true;
              await insertStaff(t.db, { storeId: w.stores.sW1, name: "抢先者", phone: "13800020031" });
            }
          },
        },
      },
    });
    const batchId = await pre(deps, csv("S-W1,甲,13800020031,https://www.douyin.com/user/T1", "S-W1,乙,13800020032,https://www.douyin.com/user/T2"));
    await confirm(deps, batchId, hq);
    const rows = await rowsOf(batchId);
    expect(rows.map((x) => [x.outcome, x.reasonCode])).toEqual([["conflict", "staff_phone_conflict"], ["pending_account", null]]);
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.phone, "13800020031"))).length).toBe(1);
    expect((await t.db.select().from(mediaStaff).where(eq(mediaStaff.phone, "13800020032"))).length).toBe(1);
    expect(await rosterTasks()).toHaveLength(1);
  });
  it("预检与确认之间同号专员被建到另一门店 → conflict/precheck_stale", async () => {
    const { deps, hq } = await setup();
    const batchId = await pre(deps, csv("S-W1,甲,13800020041,https://www.douyin.com/user/U1"));
    await insertStaff(t.db, { storeId: w.stores.sH2, name: "别店的", phone: "13800020041" });
    await confirm(deps, batchId, hq);
    expect((await rowsOf(batchId))[0]).toMatchObject({ outcome: "conflict", reasonCode: "precheck_stale" });
  });
});

describe("分块、续跑、租约", () => {
  const many = (n: number, prefix = "V") => csv(...Array.from({ length: n }, (_, i) => `S-W1,新${i},136${String(10000 + i).padStart(8, "0")},https://www.douyin.com/user/${prefix}${i}`));
  const outcomes = async (batchId: string) => (await rowsOf(batchId)).map((x) => [x.rowNo, x.outcome, x.resolveTaskId?.toString() ?? null, x.staffId?.toString() ?? null]);

  it("第 3 块后杀进程，再确认：专员数、根任务数、行结果数不重复，前 3 块行的 outcome 不被改写", async () => {
    const { deps, hq } = await setup({
      deps: {
        chunkSize: 5,
        hooks: {
          afterChunk: (n) => {
            if (n === 3) throw new Error("模拟进程被杀");
          },
        },
      },
    });
    const batchId = await pre(deps, many(23));
    await expect(confirm(deps, batchId, hq)).rejects.toThrow("模拟进程被杀");
    expect((await batchOf(batchId)).status).toBe("writing");
    const snapshot = (await outcomes(batchId)).filter((r) => r[1] !== null);
    expect(snapshot).toHaveLength(15);
    // 心跳还新鲜：另一个确认拿不到租约
    expect(await code(confirm({ ...deps, hooks: {} }, batchId, hq))).toBe("conflict/batch_in_progress");
    clock.advance(3 * 60_000);
    const r = await confirm({ ...deps, hooks: {} }, batchId, hq);
    expect(r).toMatchObject({ status: "resolving", confirm: { pending_account: 23, staff_created: 23 } });
    const after = await outcomes(batchId);
    expect(after.filter((x) => x[1] !== null)).toHaveLength(23);
    expect(after.slice(0, 15)).toEqual(snapshot); // 前 3 块不被改写
    expect(await rosterTasks()).toHaveLength(23);
    expect((await t.db.select().from(mediaStaff)).filter((s) => s.phone.startsWith("136")).length).toBe(23);
    expect((await t.db.select().from(syncBatches)).filter((b) => b.purpose === "intake").length).toBe(1);
  });
  it("两个确认并发：持租约者在块间暂停时，另一个得到 batch_in_progress；心跳陈旧被接手后，旧进程下一块 lease_lost 且零写入", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atHook = new Promise<void>((r) => (reached = r));
    const { deps, hq } = await setup({
      deps: {
        chunkSize: 5,
        hooks: {
          afterChunk: async (n) => {
            if (n === 1) {
              reached();
              await gate;
            }
          },
        },
      },
    });
    const batchId = await pre(deps, many(12));
    const a = confirm(deps, batchId, hq).then(
      (v) => ({ ok: v }),
      (e: unknown) => ({ err: e as { code?: string } }),
    );
    await atHook;
    expect(await code(confirm({ ...deps, hooks: {} }, batchId, hq))).toBe("conflict/batch_in_progress");
    clock.advance(3 * 60_000); // 旧租约陈旧
    const b = await confirm({ ...deps, hooks: {}, newToken: () => "token-b" }, batchId, hq);
    expect(b.status).toBe("resolving");
    const done = await outcomes(batchId);
    release();
    expect(await a).toMatchObject({ err: { code: "lease_lost" } });
    expect(await outcomes(batchId)).toEqual(done); // 旧进程零写入
    expect((await rosterTasks()).length).toBe(12);
  });
  it("超过时间上限在块边界停下并清空心跳，立即可续跑", async () => {
    const { deps, hq } = await setup({
      deps: {
        chunkSize: 5,
        maxMs: 60_000,
        hooks: { afterChunk: () => clock.advance(40_000) },
      },
    });
    const batchId = await pre(deps, many(14));
    expect(await code(confirm(deps, batchId, hq))).toBe("limit/time_limit_exceeded");
    const b = await batchOf(batchId);
    expect([b.status, b.heartbeatAt]).toEqual(["writing", null]);
    const done = (await outcomes(batchId)).filter((x) => x[1] !== null).length;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(14);
    const r = await confirm({ ...deps, maxMs: 10 * 60_000, hooks: {} }, batchId, hq); // 无需等心跳变陈旧
    expect(r.status).toBe("resolving");
    expect(r.confirm.pending_account).toBe(14);
  });
  it("写入期间暂停计划：下一块中止，已写行保留，批次停在 writing；恢复后可续跑", async () => {
    const { deps, hq } = await setup({
      deps: {
        chunkSize: 5,
        hooks: {
          afterChunk: async (n) => {
            if (n === 1) await t.db.update(activityPlans).set({ status: "paused" }).where(eq(activityPlans.planId, w.planId));
          },
        },
      },
    });
    const batchId = await pre(deps, many(12));
    expect(await code(confirm(deps, batchId, hq))).toBe("conflict/plan_not_collecting");
    expect((await batchOf(batchId)).status).toBe("writing");
    expect((await outcomes(batchId)).filter((x) => x[1] !== null)).toHaveLength(5);
    await t.db.update(activityPlans).set({ status: "collecting" }).where(eq(activityPlans.planId, w.planId));
    clock.advance(3 * 60_000);
    expect((await confirm({ ...deps, hooks: {} }, batchId, hq)).confirm.pending_account).toBe(12);
  });
  it("2,000 行（1,000 新专员 + 1,000 已存在专员）确认完成，汇总与行结果聚合一致", async () => {
    const { deps, hq } = await setup();
    const rows: string[] = [];
    for (let i = 0; i < 1000; i++) rows.push(`S-W1,新${i},136${String(10000 + i).padStart(8, "0")},https://www.douyin.com/user/N${i}`);
    const vals = Array.from({ length: 1000 }, (_, i) => `(${w.stores.sW1}, '老${i}', '135${String(10000 + i).padStart(8, "0")}', 'active', NOW(6), NOW(6))`);
    await t.db.execute(`INSERT INTO media_staff (store_id, staff_name, phone, status, created_at, updated_at) VALUES ${vals.join(",")}` as never);
    for (let i = 0; i < 1000; i++) rows.push(`S-W1,老${i},135${String(10000 + i).padStart(8, "0")},https://www.douyin.com/user/E${i}`);
    const batchId = await pre(deps, csv(...rows));
    const r = await confirm(deps, batchId, hq);
    expect(r).toMatchObject({ status: "resolving", confirm: { pending_account: 2000, staff_created: 1000, conflict: 0 } });
    const all = await rowsOf(batchId);
    expect(all).toHaveLength(2000);
    expect(all.every((x) => x.outcome === "pending_account" && x.resolveTaskId !== null)).toBe(true);
    expect(await rosterTasks()).toHaveLength(2000);
    expect((await batchOf(batchId)).summary).toMatchObject({ confirm: r.confirm });
  });
});
