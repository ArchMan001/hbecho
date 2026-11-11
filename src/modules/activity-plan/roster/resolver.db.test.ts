// 名单解析驱动与结果归并（任务 8）。映射表用「手工造根任务终态」逐行验证，端到端用 fixture transport 跑真实的 runTracerRoot。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../../tests/harness/db";
import { insertAccount, insertAssignment, sha } from "../../../../tests/harness/factories";
import { FakeClock } from "../../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../../tests/harness/fake-oss";
import { FixtureTransport } from "../../../../tests/harness/fixture-transport";
import { loadFixtureBytes } from "../../../../tests/harness/fixtures";
import { bytesOf } from "../../../../tests/harness/decode-helpers";
import { MemoryAuditSink } from "../../../../tests/harness/audit";
import { planActor, T0 } from "../../../../tests/harness/plan";
import { rosterWorld, type RosterWorld } from "../../../../tests/harness/roster";
import { seedSyncSettings } from "../../../../tests/harness/seed";
import { activityPlanBranches, activityPlanRoster, activityPlans, externalAccountIdentifiers, importBatches, importRowResults, odsProviderCalls, staffAccountAssignments as aa, syncTasks } from "../../../db/schema";
import { runTracerRoot } from "../../orchestrator";
import { RawCaptureGateway } from "../../raw-capture";
import { createTracerCommands, DEFAULT_CONFIG } from "../../tracer-command";
import { ROSTER_HEADER } from "../constants";
import { confirm, type ConfirmDeps } from "./confirm";
import { createRosterFinalizer, type SupplementRequest } from "./finalize";
import { precheck } from "./precheck";
import { createRosterResolver, type RunRoot } from "./resolver";

const t = useTestDb();
const HEADER = ROSTER_HEADER.join(",");
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode([HEADER, ...lines].join("\r\n") + "\r\n");
const hq = planActor("hq");
let w: RosterWorld;
let clock: FakeClock;

async function env(opts: { runRoot?: RunRoot; supplement?: (r: SupplementRequest) => void } = {}) {
  w = await rosterWorld(t);
  clock = new FakeClock(T0);
  await seedSyncSettings(t.db, T0);
  const store = new FakeObjectStore(clock);
  const transport = new FixtureTransport();
  const gateway = new RawCaptureGateway({ db: t.db, store, transport, clock, location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-test" } });
  const tracer = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
  const supplements: SupplementRequest[] = [];
  const supplement = async (r: SupplementRequest) => {
    supplements.push(r);
    opts.supplement?.(r);
    return { kind: "created", dispositions: r.accountIds.map(() => ({ disposition: "queued" })) };
  };
  const finalize = createRosterFinalizer({ db: t.db, clock, supplement });
  const confirmDeps: ConfirmDeps = { db: t.db, clock, audit: w.audit.sink, tracer, onCompleted: finalize };
  const runRoot: RunRoot = opts.runRoot ?? ((id) => runTracerRoot({ db: t.db, clock, gateway, workerId: "w1" }, id));
  const resolver = createRosterResolver({ db: t.db, clock, audit: w.audit.sink, runRoot, finalize, concurrency: 1 });
  const submit = async (bytes: Uint8Array): Promise<string> => {
    const batchId = (await precheck(confirmDeps, { planId: w.planId, fileName: "x.csv", bytes }, hq)).batchId;
    await confirm(confirmDeps, batchId, hq);
    return batchId;
  };
  return { store, transport, gateway, supplements, resolver, submit, confirmDeps };
}
type Env = Awaited<ReturnType<typeof env>>;
const rowsOf = async (batchId: string) => (await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId))).orderBy(importRowResults.rowNo));
const batchOf = async (batchId: string) => (await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(batchId))))[0]!;
const entries = () => t.db.select().from(activityPlanRoster).where(eq(activityPlanRoster.planId, w.planId));
const setRoot = (taskId: bigint, set: Partial<typeof syncTasks.$inferInsert>) => t.db.update(syncTasks).set({ finishedAt: T0, ...set }).where(eq(syncTasks.taskId, taskId));
const noopRun: RunRoot = async () => ({ kind: "already_terminal" });

/** 新账号 + 归属（给「根任务成功」的行造账号）。 */
async function accountFor(staffId: bigint, locator: string, userId: string): Promise<bigint> {
  const accountId = await insertAccount(t.db, "douyin", T0);
  await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0, locator });
  await t.db.insert(externalAccountIdentifiers).values({ accountId, namespaceCode: "douyin.user_id", identifierValue: userId, identifierSha256: sha(userId), bindingMethod: "same_payload", confidence: "observed", firstSeenAt: T0, lastSeenAt: T0, createdAt: T0 });
  return accountId;
}
const URL = (n: string) => `https://www.douyin.com/user/${n}`;
const staffLine = (i: number, url: string) => `S-W1,新人${i},137000000${String(i).padStart(2, "0")},${url}`;

describe("映射表：每一种根任务终态各一行", () => {
  it("八行：imported / unchanged / 两种 conflict / invalid / suspected_empty / 两种 resolve_failed", async () => {
    const e = await env({ runRoot: noopRun });
    const urls = Array.from({ length: 8 }, (_, i) => URL(`M${i}`));
    const batchId = await e.submit(csv(...urls.map((u, i) => staffLine(i + 1, u))));
    const rows = await rowsOf(batchId);
    expect(rows.every((r) => r.outcome === "pending_account")).toBe(true);
    const root = (i: number) => rows[i]!.resolveTaskId!;
    // 1 imported：新建账号
    const a1 = await accountFor(rows[0]!.staffId!, urls[0]!, "U1");
    await setRoot(root(0), { status: "succeeded", accountId: a1, resultSummary: { entry_outcome: "normal", account_created: true } });
    // 2 unchanged：账号已存在（另一个计划曾引用）
    const a2 = await accountFor(rows[1]!.staffId!, urls[1]!, "U2");
    await setRoot(root(1), { status: "succeeded", accountId: a2, resultSummary: { entry_outcome: "normal", account_created: false } });
    // 3、4 conflict
    await setRoot(root(2), { status: "failed", stopReason: "assignment_conflict", resultSummary: {} });
    await setRoot(root(3), { status: "failed", stopReason: "staff_platform_slot_taken", resultSummary: {} });
    // 5 invalid
    await setRoot(root(4), { status: "failed", stopReason: "invalid_link", lastErrorCode: "result_validation_exhausted", resultSummary: { entry_outcome: "invalid_link" } });
    // 6 suspected_empty
    const a6 = await accountFor(rows[5]!.staffId!, urls[5]!, "U6");
    await t.db.update(aa).set({ intakeStatus: "suspected_empty" }).where(eq(aa.accountId, a6));
    await setRoot(root(5), { status: "succeeded", accountId: a6, stopReason: "suspected_empty", resultSummary: { entry_outcome: "suspected_empty", account_created: true } });
    // 7 技术失败；8 取消
    await setRoot(root(6), { status: "failed", lastErrorCode: "provider_auth", lastErrorDetail: { category: "provider_auth" }, resultSummary: {} });
    await setRoot(root(7), { status: "cancelled", resultSummary: {} });

    const report = await e.resolver.runOnce();
    expect(report).toMatchObject({ examined: 8, settled: 8, deferred: 0, failed: [] });
    const after = await rowsOf(batchId);
    expect(after.map((r) => [r.outcome, r.reasonCode])).toEqual([
      ["imported", null],
      ["unchanged", "existing_account_referenced"],
      ["conflict", "assignment_conflict"],
      ["conflict", "staff_platform_slot_taken"],
      ["invalid", "result_validation_exhausted"],
      ["suspected_empty", "suspected_empty"],
      ["resolve_failed", "root_failed"],
      ["resolve_failed", "root_cancelled"],
    ]);
    // 名单项：成功类三行建立（in_roster），失败类没有；疑似空账号有名单项
    const mine = (await entries()).filter((x) => [a1, a2, a6].includes(x.accountId));
    expect(mine.map((x) => x.entryState)).toEqual(["in_roster", "in_roster", "in_roster"]);
    expect((await entries()).length).toBe(2 + 3); // 种子 2 个 + 新增 3 个
    expect(after[0]).toMatchObject({ accountId: a1, resolvedByActor: "service:plan-worker" });
    // 批次完成，汇总与行结果一致，pending 为 0
    const b = await batchOf(batchId);
    expect(b.status).toBe("completed");
    expect((b.summary as { confirm: Record<string, number> }).confirm).toMatchObject({ imported: 1, unchanged: 1, conflict: 2, invalid: 1, suspected_empty: 1, resolve_failed: 2, pending_account: 0 });
    expect(report.completedBatches).toEqual([batchId]);
    // 收尾：只对 unchanged 的账号补抓一次，幂等键含批次 ID，且满一周才补（168 小时）
    expect(e.supplements).toEqual([{ accountIds: [a2.toString()], only: "full", ifOlderThanHours: 168, apply: true, idempotencyKey: `roster-refresh:${batchId}` }]);
    expect((b.summary as { refresh: unknown }).refresh).toMatchObject({ requested: 1, queued: 1 });
  });
  it("疑似空账号：名单项存在，监控开关开着，但 intake_status 门控使它不进入常规采集", async () => {
    const e = await env({ runRoot: noopRun });
    const batchId = await e.submit(csv(staffLine(1, URL("EMPTY1"))));
    const [row] = await rowsOf(batchId);
    const a = await accountFor(row!.staffId!, URL("EMPTY1"), "UE");
    await t.db.update(aa).set({ intakeStatus: "suspected_empty" }).where(eq(aa.accountId, a));
    await setRoot(row!.resolveTaskId!, { status: "succeeded", accountId: a, stopReason: "suspected_empty", resultSummary: { entry_outcome: "suspected_empty" } });
    await e.resolver.runOnce();
    const { createMonitoringResolver } = await import("../../monitoring");
    const targets = await createMonitoringResolver(t.db).explain(a);
    expect(JSON.stringify(targets)).toMatch(/suspected_empty/);
    expect((await entries()).some((x) => x.accountId === a && x.entryState === "in_roster")).toBe(true);
    expect((await t.db.select().from(aa).where(eq(aa.accountId, a)))[0]?.monitoringEnabled).toBe(true);
  });
});

describe("归并的保护与幂等", () => {
  it("settle 重复运行：无重复名单项、无重复审计；归并后行不再被处理", async () => {
    const e = await env({ runRoot: noopRun });
    const batchId = await e.submit(csv(staffLine(1, URL("D1"))));
    const [row] = await rowsOf(batchId);
    const a = await accountFor(row!.staffId!, URL("D1"), "UD");
    await setRoot(row!.resolveTaskId!, { status: "succeeded", accountId: a, resultSummary: { entry_outcome: "normal", account_created: true } });
    const first = await e.resolver.runOnce();
    const second = await e.resolver.runOnce();
    expect([first.settled, second.examined, second.settled]).toEqual([1, 0, 0]);
    expect((await entries()).filter((x) => x.accountId === a)).toHaveLength(1);
    expect(e.supplements).toHaveLength(0); // 新账号不触发补抓
  });
  it("归并时计划已暂停 / 删除：行落为 conflict/plan_state_changed，不建名单项；账号与归属保留", async () => {
    const e = await env({ runRoot: noopRun });
    const batchId = await e.submit(csv(staffLine(1, URL("P1")), staffLine(2, URL("P2"))));
    const rows = await rowsOf(batchId);
    const accounts: bigint[] = [];
    for (const [i, r] of rows.entries()) {
      const a = await accountFor(r.staffId!, URL(`P${i + 1}`), `UP${i}`);
      accounts.push(a);
      await setRoot(r.resolveTaskId!, { status: "succeeded", accountId: a, resultSummary: { entry_outcome: "normal", account_created: true } });
    }
    await t.db.update(activityPlans).set({ status: "paused" }).where(eq(activityPlans.planId, w.planId));
    await e.resolver.runOnce();
    expect((await rowsOf(batchId)).map((r) => [r.outcome, r.reasonCode])).toEqual([["conflict", "plan_state_changed"], ["conflict", "plan_state_changed"]]);
    expect((await entries()).some((x) => accounts.includes(x.accountId))).toBe(false);
    expect((await t.db.select().from(aa).where(eq(aa.accountId, accounts[0]!))).length).toBe(1);
    expect((await batchOf(batchId)).status).toBe("completed");
  });
  it("分公司已退出：同样 plan_state_changed", async () => {
    const e = await env({ runRoot: noopRun });
    const batchId = await e.submit(csv(staffLine(1, URL("X1"))));
    const [row] = await rowsOf(batchId);
    const a = await accountFor(row!.staffId!, URL("X1"), "UX");
    await setRoot(row!.resolveTaskId!, { status: "succeeded", accountId: a, resultSummary: { entry_outcome: "normal", account_created: true } });
    await t.db.update(activityPlanBranches).set({ status: "exited", exitedAt: T0 }).where(and(eq(activityPlanBranches.planId, w.planId), eq(activityPlanBranches.branchId, w.bj)));
    await e.resolver.runOnce();
    expect((await rowsOf(batchId))[0]).toMatchObject({ outcome: "conflict", reasonCode: "plan_state_changed" });
  });
  it("分公司退出（持有参与关系行锁）与归并并发：归并等它提交，之后看到已退出，不留在名单的项", async () => {
    const e = await env({ runRoot: noopRun });
    const batchId = await e.submit(csv(staffLine(1, URL("RACE1"))));
    const [row] = await rowsOf(batchId);
    const a = await accountFor(row!.staffId!, URL("RACE1"), "URACE");
    await setRoot(row!.resolveTaskId!, { status: "succeeded", accountId: a, resultSummary: { entry_outcome: "normal", account_created: true } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    const exiting = t.db.transaction(async (tx) => {
      await tx.update(activityPlanBranches).set({ status: "exited", exitedAt: T0 }).where(and(eq(activityPlanBranches.planId, w.planId), eq(activityPlanBranches.branchId, w.bj)));
      locked();
      await gate; // 退出事务持锁不提交
    });
    await hasLock;
    let settled = false;
    const run = e.resolver.runOnce().then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false); // 归并阻塞在参与关系行上
    release();
    await exiting;
    await run;
    expect((await rowsOf(batchId))[0]).toMatchObject({ outcome: "conflict", reasonCode: "plan_state_changed" });
    expect((await entries()).some((x) => x.accountId === a)).toBe(false);
  });
  it("根任务未到终态留待下个 tick；写入中（writing）的批次不归并", async () => {
    const e = await env({ runRoot: async () => ({ kind: "retry_wait" }) });
    const batchId = await e.submit(csv(staffLine(1, URL("W1"))));
    const r1 = await e.resolver.runOnce();
    expect(r1).toMatchObject({ examined: 1, settled: 0, deferred: 1 });
    expect((await rowsOf(batchId))[0]?.outcome).toBe("pending_account");
    await t.db.update(importBatches).set({ status: "writing" }).where(eq(importBatches.importBatchId, BigInt(batchId)));
    expect((await e.resolver.runOnce()).examined).toBe(0);
  });
  it("resolve_task_id 为空（根任务已被清理）而行仍挂起 → resolve_failed/root_expired", async () => {
    const e = await env({ runRoot: noopRun });
    const batchId = await e.submit(csv(staffLine(1, URL("O1"))));
    await t.db.update(importRowResults).set({ resolveTaskId: null }).where(eq(importRowResults.importBatchId, BigInt(batchId)));
    const r = await e.resolver.runOnce();
    expect(r.expired).toBe(1);
    expect((await rowsOf(batchId))[0]).toMatchObject({ outcome: "resolve_failed", reasonCode: "root_expired" });
    expect((await batchOf(batchId)).status).toBe("completed");
  });
  it("驱动中途抛错再跑：已归并的行不重复处理，出错的行下个 tick 重来", async () => {
    let calls = 0;
    const e = await env({
      runRoot: async () => {
        if (++calls === 2) throw new Error("驱动崩溃");
        return { kind: "already_terminal" };
      },
    });
    const batchId = await e.submit(csv(staffLine(1, URL("C1")), staffLine(2, URL("C2")), staffLine(3, URL("C3"))));
    const rows = await rowsOf(batchId);
    for (const [i, r] of rows.entries()) {
      const a = await accountFor(r.staffId!, URL(`C${i + 1}`), `UC${i}`);
      await setRoot(r.resolveTaskId!, { status: "succeeded", accountId: a, resultSummary: { entry_outcome: "normal", account_created: true } });
    }
    const first = await e.resolver.runOnce();
    expect(first).toMatchObject({ settled: 2 });
    expect(first.failed).toHaveLength(1);
    expect((await batchOf(batchId)).status).toBe("resolving");
    const second = await e.resolver.runOnce();
    expect(second).toMatchObject({ examined: 1, settled: 1 });
    expect((await batchOf(batchId)).status).toBe("completed");
    expect((await entries()).length).toBe(2 + 3);
  });
  it("capability 未放行：根任务不运行，行保持 pending_account，不报错", async () => {
    let ran = false;
    const e = await env({ runRoot: async () => ((ran = true), { kind: "succeeded" }) });
    const batchId = await e.submit(csv(staffLine(1, URL("G1"))));
    const prod = createRosterResolver({ db: t.db, clock, audit: w.audit.sink, runRoot: async () => ((ran = true), { kind: "succeeded" }), finalize: async () => ({ requested: 0, queued: 0, notDue: 0 }), tracerConfig: { ...DEFAULT_CONFIG, environment: "production" } });
    const r = await prod.runOnce();
    expect(r).toMatchObject({ examined: 1, gated: 1, settled: 0, failed: [] });
    expect(ran).toBe(false);
    expect((await rowsOf(batchId))[0]?.outcome).toBe("pending_account");
    void e;
  });
});

describe("端到端：fixture transport 跑真实的 resolve_account 根任务（profile_only）", () => {
  const DY = () => new TextDecoder().decode(loadFixtureBytes("raw3.douyin.media_user_info"));
  const profileFor = (userId: string, empty = false): Uint8Array => {
    let text = DY().replaceAll("HITACHI1", userId);
    if (empty) text = text.replace(/"(follower_number|follower_count|post_number|post_count)":\s*"?\d+"?/g, '"$1": 0');
    return bytesOf(text);
  };
  function serve(e: Env, byUrlTail: Record<string, Uint8Array>) {
    e.transport.register({ path: "/openapi/v1/media_user_info", query: { async: "false" } }, (req) => {
      const body = JSON.parse(new TextDecoder().decode(req.body!)) as { url: string };
      const key = Object.keys(byUrlTail).find((k) => body.url.includes(k));
      return { httpStatus: 200, body: key ? byUrlTail[key]! : bytesOf("{}") };
    });
  }
  it("新账号只产生主页调用（没有列表任务）；已存在账号被引用；疑似空账号建名单项；批次完成时对已存在账号补抓一次", async () => {
    const e = await env();
    // 种一个已存在的账号：同一个人，入口文本不同（本地命中不了，所以要调一次主页）
    await t.db.delete(activityPlanRoster).where(eq(activityPlanRoster.accountId, w.accZhao)); // 老赵种子里的账号让位（一专员一平台一账号）
    await t.db.delete(aa).where(eq(aa.accountId, w.accZhao));
    const existing = await accountFor(w.staff.zhao, URL("OLDTEXT"), "UEXIST");
    serve(e, { NEWACC: profileFor("UNEW"), EMPTYACC: profileFor("UEMPTY", true), EXISTTEXT: profileFor("UEXIST") });
    const batchId = await e.submit(
      csv(`S-W1,新人甲,13700000001,${URL("NEWACC")}`, `S-W1,新人乙,13700000002,${URL("EMPTYACC")}`, `S-W1,老赵,13800010004,${URL("EXISTTEXT")}`),
    );
    const report = await e.resolver.runOnce();
    expect(report).toMatchObject({ examined: 3, settled: 3, failed: [] });
    const rows = await rowsOf(batchId);
    expect(rows.map((r) => r.outcome)).toEqual(["imported", "suspected_empty", "unchanged"]);
    expect(rows[2]).toMatchObject({ reasonCode: "existing_account_referenced", accountId: existing });
    // 只有主页调用，没有列表调用 / 列表任务 / 检查点
    const calls = await t.db.select().from(odsProviderCalls);
    expect(new Set(calls.map((c) => c.requestedAction))).toEqual(new Set(["media_user_info"]));
    expect(calls).toHaveLength(3);
    expect((await t.db.select().from(syncTasks)).filter((x) => x.requestedAction !== "resolve_account")).toHaveLength(0);
    // 疑似空账号：归属 intake_status 门控
    const emptyAcct = await t.db.select().from(aa).where(eq(aa.accountId, rows[1]!.accountId!));
    expect(emptyAcct[0]).toMatchObject({ intakeStatus: "suspected_empty", monitoringEnabled: true });
    expect((await batchOf(batchId)).status).toBe("completed");
    expect(e.supplements.map((s) => s.accountIds)).toEqual([[existing.toString()]]);
    // 没有真实供应商调用：全部来自 fixture transport
    expect(e.transport.rejected).toEqual([]);
  });
  it("归属冲突：入口解析出的账号已归属他人 → conflict，原归属不变；专员名额冲突", async () => {
    const e = await env();
    await accountFor(w.staff.li, URL("THEIRS"), "UOWNED"); // 账号 UOWNED 归老李
    serve(e, { CONFLICT: profileFor("UOWNED"), SLOT: profileFor("USLOT") });
    // 老赵已在该平台有账号 CCC（种子）；再给他一个新账号 → 名额冲突
    const batchId = await e.submit(csv(`S-W1,新人甲,13700000001,${URL("CONFLICT")}`, `S-W1,老赵,13800010004,${URL("SLOT")}`));
    await e.resolver.runOnce();
    expect((await rowsOf(batchId)).map((r) => [r.outcome, r.reasonCode])).toEqual([["conflict", "assignment_conflict"], ["conflict", "staff_platform_slot_taken"]]);
    const owned = await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.identifierValue, "UOWNED"));
    expect((await t.db.select().from(aa).where(eq(aa.accountId, owned[0]!.accountId)))[0]?.staffId).toBe(w.staff.li);
    expect(w.audit.events.some((x) => x.event_type === "staff_created")).toBe(true);
  });
});
