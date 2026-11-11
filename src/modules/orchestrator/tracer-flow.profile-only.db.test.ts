// a-activity-plan 任务 7：resolve_account 根任务的 profile_only 模式（名单导入）。
// 纯新增分支：外部分支与完整分支的行为由既有测试守护；这里只证明 profile_only 只调主页、仍经 intakeAccount 裁判、summary 带 account_created。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { PROFILE_PATH, LIST_PATH, setupTracer, DOUYIN_LOCATOR } from "../../../tests/harness/tracer-env";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { odsProviderCalls, staffAccountAssignments, syncTasks } from "../../db/schema";
import { runTracerRoot } from "./index";

const t = useTestDb();
const run = (env: Awaited<ReturnType<typeof setupTracer>>, rootId: bigint) => runTracerRoot({ db: t.db, clock: env.clock, gateway: env.gateway, workerId: "w1" }, rootId);
async function submitRoster(env: Awaited<ReturnType<typeof setupTracer>>, staffId: bigint, locator = DOUYIN_LOCATOR, rowNo = 1) {
  return t.db.transaction((tx) => env.commands.submitRoster(tx, { importBatchId: 7n, actorId: "user:hq", platform: "douyin", items: [{ rowNo, staffId, locator }] }));
}
const rootOf = async (id: bigint) => (await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, id)))[0]!;

describe("profile_only 根任务", () => {
  it("新账号：只发主页调用，没有列表任务；成功终态 summary 带 account_created / assignment_created", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    const sub = await submitRoster(env, env.org.staffA);
    const rootId = sub.tasks[0]!.rootTaskId;
    expect((await run(env, rootId)).kind).toBe("succeeded");
    const calls = await t.db.select().from(odsProviderCalls);
    expect(calls.map((c) => c.requestedAction)).toEqual(["media_user_info"]);
    expect((await t.db.select().from(syncTasks)).filter((x) => x.requestedAction === "fetch_content_list")).toHaveLength(0);
    const root = await rootOf(rootId);
    expect(root).toMatchObject({ status: "succeeded", stopReason: "profile_only" });
    expect(root.resultSummary).toMatchObject({ entry_outcome: "normal", profile_only: true, account_created: true, assignment_created: true });
    expect(root.accountId).not.toBeNull();
    expect((await t.db.select().from(staffAccountAssignments))[0]).toMatchObject({ staffId: env.org.staffA, intakeStatus: "normal" });
    expect(LIST_PATH).toBeTruthy();
  });
  it("账号已存在且归属同一专员：account_created=false，不重复建归属", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    const first = await submitRoster(env, env.org.staffA, DOUYIN_LOCATOR, 1);
    await run(env, first.tasks[0]!.rootTaskId);
    const again = await submitRoster(env, env.org.staffA, DOUYIN_LOCATOR, 2);
    await run(env, again.tasks[0]!.rootTaskId);
    expect((await rootOf(again.tasks[0]!.rootTaskId)).resultSummary).toMatchObject({ account_created: false, assignment_created: false });
    expect(await t.db.select().from(staffAccountAssignments)).toHaveLength(1);
  });
  it("账号已归属他人：仍由 intakeAccount 裁判 → failed/assignment_conflict，不抢占", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    await run(env, (await submitRoster(env, env.org.staffB, DOUYIN_LOCATOR, 1)).tasks[0]!.rootTaskId);
    const other = await submitRoster(env, env.org.staffA, DOUYIN_LOCATOR, 2);
    expect((await run(env, other.tasks[0]!.rootTaskId)).kind).toBe("blocked");
    expect(await rootOf(other.tasks[0]!.rootTaskId)).toMatchObject({ status: "failed", stopReason: "assignment_conflict" });
    expect((await t.db.select().from(staffAccountAssignments))[0]?.staffId).toBe(env.org.staffB);
  });
  it("专员在该平台已有另一账号 → failed/staff_platform_slot_taken，不留孤儿账号", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    const acc = await insertAccount(t.db, "douyin", env.clock.now());
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: env.org.staffA, now: env.clock.now() });
    const sub = await submitRoster(env, env.org.staffA);
    await run(env, sub.tasks[0]!.rootTaskId);
    expect(await rootOf(sub.tasks[0]!.rootTaskId)).toMatchObject({ status: "failed", stopReason: "staff_platform_slot_taken" });
    expect(await t.db.select().from(staffAccountAssignments)).toHaveLength(1);
  });
  it("只要求主页 capability：submitRoster 重复调用命中同一行（幂等），同一导入批次共用一个同步批次", async () => {
    const env = await setupTracer(t);
    const a = await submitRoster(env, env.org.staffA, DOUYIN_LOCATOR, 1);
    const b = await submitRoster(env, env.org.staffA, DOUYIN_LOCATOR, 1);
    expect(b.tasks[0]).toMatchObject({ rootTaskId: a.tasks[0]!.rootTaskId, deduplicated: true });
    const c = await submitRoster(env, env.org.staffB, "https://www.douyin.com/user/X2", 2);
    expect(c.syncBatchId).toBe(a.syncBatchId);
    expect(PROFILE_PATH).toBeTruthy();
  });
});
