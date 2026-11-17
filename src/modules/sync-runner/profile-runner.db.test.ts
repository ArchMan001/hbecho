// ProfileRunner（FS-4；acceptance D）：真实调度器规划 + 真实 worker 领取 + fixture transport，全程离线。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { envelope } from "../../../tests/harness/decode-helpers";
import { settleTasks } from "../../../tests/harness/sync-fixtures";
import { PROFILE_PATH, SLOT, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { accountProfileSnapshots, dataQualityIssues, externalAccountIdentifiers, externalAccounts, mediaReferences, odsPayloads, odsProviderCalls, staffAccountAssignments, syncTasks } from "../../db/schema";
import { TransportFailure } from "../raw-capture";
import { createProfileRunner } from "./profile-runner";

const t = useTestDb();
const WEEK = 7 * 24 * 3600 * 1000;

const profileBytes = (fields: string) => envelope("media_user_info", `{${fields}}`);
const run = async (env: SyncEnv) => env.worker({ fetch_profile: createProfileRunner(env.deps) }).run({ untilIdle: true });
const profileTask = async (env: SyncEnv, accountId: bigint) => (await env.tasks("fetch_profile")).find((x) => x.accountId === accountId)!;
const snapshots = () => t.db.select().from(accountProfileSnapshots);
const issues = (code?: string) => t.db.select().from(dataQualityIssues).then((r) => (code ? r.filter((i) => i.issueCode === code) : r));

describe("成功路径", () => {
  it("三平台各一个账号：每账号每批次一份主页快照，current 指向它，响应先于解码落 ODS（D1、D8）", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA);
    const x = await env.addAccount("xiaohongshu", env.org.staffB);
    const k = await env.addAccount("kuaishou", env.org.staffC);
    env.routeBy(PROFILE_PATH, {
      [env.locatorOf(d.accountId)]: "raw3.douyin.media_user_info",
      [env.locatorOf(x.accountId)]: "raw3.xiaohongshu.media_user_info",
      [env.locatorOf(k.accountId)]: "raw12.K1",
    });
    await env.scheduler.tick(SLOT);
    const stats = await run(env);
    expect(stats.done).toBe(3);

    const snaps = await snapshots();
    expect(snaps).toHaveLength(3);
    for (const a of [d, x, k]) {
      const [acct] = await t.db.select().from(externalAccounts).where(eq(externalAccounts.accountId, a.accountId));
      const mine = snaps.filter((s) => s.accountId === a.accountId);
      expect(mine).toHaveLength(1);
      expect(acct!.currentProfileSnapshotId).toBe(mine[0]!.profileSnapshotId);
      expect((await profileTask(env, a.accountId)).status).toBe("succeeded");
    }
    // 响应字节在 ODS，且被解释过（parse_status 只在捕获之后才写）
    const payloads = await t.db.select().from(odsPayloads);
    expect(payloads.filter((p) => p.payloadRole === "response_body").every((p) => p.parseStatus === "parsed")).toBe(true);
    expect(env.transport.calls).toHaveLength(3);

    // 抖音有头像 / 背景引用；小红书、快手没有
    const refs = await t.db.select().from(mediaReferences);
    const byProfile = (id: bigint) => refs.filter((r) => r.profileSnapshotId === snaps.find((s) => s.accountId === id)!.profileSnapshotId).map((r) => r.role).sort();
    expect(byProfile(d.accountId)).toEqual(["avatar", "background"]);
    expect(byProfile(x.accountId)).toEqual([]);
    expect(byProfile(k.accountId)).toEqual([]);
  });

  it("同一批次同一账号重复运行：仍只有一份快照，且不重新付费（D2）", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA);
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: "raw3.douyin.media_user_info" });
    await env.scheduler.tick(SLOT);
    await run(env);
    const task = await profileTask(env, d.accountId);
    await t.db.update(syncTasks).set({ status: "pending", finishedAt: null }).where(eq(syncTasks.taskId, task.taskId));
    await run(env);
    expect(await snapshots()).toHaveLength(1);
    expect(env.transport.calls).toHaveLength(1); // 同一 (task, attempt, seq) 复用已捕获的响应
  });

  it("五态：真实 0、显式 null、非法、缺失各自保留，不互转（D3）", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA, { identifier: "U1" });
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: profileBytes('"user_id":"U1","follower_number":0,"following_number":null,"like_number":"abc"') });
    await env.scheduler.tick(SLOT);
    await run(env);
    const [s] = await snapshots();
    expect(s).toMatchObject({ followerState: "value", followerValue: 0n, followingState: "explicit_null", followingValue: null, likeState: "invalid", postState: "missing" });
  });

  it("已有账号粉丝与作品数均为 0：照常写快照，intake_status 不变（D7）", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA, { identifier: "U1" });
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: profileBytes('"user_id":"U1","follower_number":0,"post_number":0') });
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await snapshots()).toHaveLength(1);
    const [a] = await t.db.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.assignmentId, d.assignmentId));
    expect(a!.intakeStatus).toBe("normal");
  });
});

describe("身份与残缺校验", () => {
  it("主页返回别的账号：不写快照、不下媒资、登记标识不被改写，质量问题带期望值 / 实际值 / 入口（D9）", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA, { identifier: "REGISTERED" });
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: "raw3.douyin.media_user_info" }); // 返回的 user_id 不是 REGISTERED
    await env.scheduler.tick(SLOT);
    await run(env);
    const task = await profileTask(env, d.accountId);
    expect(task).toMatchObject({ status: "failed", lastErrorCode: "profile_uid_mismatch" });
    expect(await snapshots()).toHaveLength(0);
    expect(await t.db.select().from(mediaReferences)).toHaveLength(0);
    const [issue] = await issues("profile_uid_mismatch");
    expect(issue!.detail).toMatchObject({ namespace: "douyin.user_id", expected: ["REGISTERED"], sent_locator: env.locatorOf(d.accountId) });
    expect((issue!.detail as { actual: string }).actual).not.toBe("REGISTERED");
    const ids = await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.accountId, d.accountId));
    expect(ids.map((i) => i.identifierValue)).toEqual(["REGISTERED"]);
    expect(issue!.providerCallId).not.toBeNull();
  });

  it("账号标识有效但四项指标全是 null / 缺失：不写快照，可重试的 profile_fields_missing（D10）", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA, { identifier: "U1" });
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: profileBytes('"user_id":"U1","follower_number":null,"like_number":null') });
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await snapshots()).toHaveLength(0);
    expect(await profileTask(env, d.accountId)).toMatchObject({ status: "retry_wait", lastErrorCode: "profile_fields_missing", attemptCount: 1 });
    expect(await issues("profile_fields_missing")).toHaveLength(1);
  });
});

describe("技术失败不改账号状态、不写空快照（D4）", () => {
  const cases: Array<[string, (e: SyncEnv) => import("../../../tests/harness/fixture-transport").FixtureResponse, string]> = [
    ["传输错误（已知未送达）", () => () => { throw new TransportFailure("econnrefused", "no", "refused"); }, "transport_failure"],
    ["传输超时（送达未知）", () => () => { throw new TransportFailure("timeout", "unknown", "timeout"); }, "ambiguous_unresolved"],
    ["429", () => ({ httpStatus: 429, body: new TextEncoder().encode('{"code":"RATE_LIMITED"}') }), "rate_limited"],
    ["500", () => ({ httpStatus: 503, body: new TextEncoder().encode('{"code":"UNAVAILABLE"}') }), "provider_server_error"],
    ["解析失败（200 但不是 JSON）", () => ({ httpStatus: 200, body: new TextEncoder().encode("<html>") }), "invalid_response"],
  ];
  for (const [name, resp, code] of cases) {
    it(`${name} → ${code}`, async () => {
      const env = await setupSync(t);
      const d = await env.addAccount("douyin", env.org.staffA);
      env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: resp(env) });
      await env.scheduler.tick(SLOT);
      await run(env);
      expect(await snapshots()).toHaveLength(0);
      expect((await profileTask(env, d.accountId)).lastErrorCode).toBe(code);
      const [a] = await t.db.select().from(externalAccounts).where(eq(externalAccounts.accountId, d.accountId));
      expect(a).toMatchObject({ status: "active", currentProfileSnapshotId: null });
    });
  }

  it("ODS 写失败：没有发出请求，也没有快照", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA);
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: "raw3.douyin.media_user_info" });
    env.store.inject((k) => k.includes("request"), "fail", 100);
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.transport.calls).toHaveLength(0);
    expect(await snapshots()).toHaveLength(0);
  });
});

describe("RESULT_VALIDATION_FAILED 耗尽（D5、D6）", () => {
  it("连续失败至额度耗尽：failed/provider_input_inaccessible + account_inaccessible_suspected，账号状态不变；下一批次成功后自动 resolved", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA);
    const bad = { [env.locatorOf(d.accountId)]: { httpStatus: 500, body: loadFixtureBytes("raw7.C20.http500") } };
    env.routeBy(PROFILE_PATH, bad);
    // 第 1 次同步失败后，第 2、3 次改走异步（mode-fallback.db.test.ts）；异步提交同样被供应商校验失败拒绝
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, bad[env.locatorOf(d.accountId)]!);
    await env.scheduler.tick(SLOT);
    // 3 次尝试：每次失败后退避，推进 fake clock 再领取
    for (let i = 0; i < 3; i++) {
      await run(env);
      env.clock.advance(10 * 60_000);
    }
    const task = await profileTask(env, d.accountId);
    expect(task).toMatchObject({ status: "failed", lastErrorCode: "provider_input_inaccessible", attemptCount: 3 });
    const [open] = await issues("account_inaccessible_suspected");
    expect(open).toMatchObject({ status: "open", accountId: d.accountId });
    const [a] = await t.db.select().from(externalAccounts).where(eq(externalAccounts.accountId, d.accountId));
    expect(a!.status).toBe("active");

    // 下一周：上一批次的列表任务（本测试没有列表 Runner）收尾后，同一账号主页成功
    await settleTasks(t.db, task.batchId, { status: "cancelled", where: (x) => x.requestedAction === "fetch_content_list" }, env.clock.now());
    const next = new Date(SLOT.getTime() + WEEK);
    env.clock.set(next);
    env.transport.clearRoutes();
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: "raw3.douyin.media_user_info" });
    await env.scheduler.tick(next);
    await run(env);
    const [resolved] = await issues("account_inaccessible_suspected");
    expect(resolved).toMatchObject({ status: "resolved", resolvedByActor: "system:recovered" });
    expect(await snapshots()).toHaveLength(1);
  });
});

describe("前置门禁（不发请求）", () => {
  it("未登记的环境（staging）不放行：任务 failed/capability_disabled，零调用，不消耗额度", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA);
    env.routeBy(PROFILE_PATH, { [env.locatorOf(d.accountId)]: "raw3.douyin.media_user_info" });
    await env.scheduler.tick(SLOT);
    await env.worker({ fetch_profile: createProfileRunner({ ...env.deps, environment: "staging" }) }).run({ untilIdle: true });
    expect(env.transport.calls).toHaveLength(0);
    expect(await profileTask(env, d.accountId)).toMatchObject({ status: "failed", lastErrorCode: "capability_disabled", attemptCount: 0 });
  });

  it("账号没有可用入口：locator_unavailable，零调用", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA);
    await t.db.update(staffAccountAssignments).set({ resolvedHomeUrl: "", resolvedHomeUrlSha256: Buffer.alloc(32), currentHomeLocator: "", currentHomeLocatorSha256: Buffer.alloc(32) }).where(eq(staffAccountAssignments.assignmentId, d.assignmentId));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.transport.calls).toHaveLength(0);
    expect((await profileTask(env, d.accountId)).lastErrorCode).toBe("locator_unavailable");
  });

  it("任务参数不合法：task_parameters_invalid", async () => {
    const env = await setupSync(t);
    const d = await env.addAccount("douyin", env.org.staffA);
    await env.scheduler.tick(SLOT);
    const task = await profileTask(env, d.accountId);
    await t.db.update(syncTasks).set({ taskParameters: { schema_version: "bogus" } }).where(eq(syncTasks.taskId, task.taskId));
    await run(env);
    expect((await profileTask(env, d.accountId)).lastErrorCode).toBe("task_parameters_invalid");
  });
});

describe("异步模式（mode 来自任务参数，不写死）", () => {
  it("提交 + 轮询各自是独立 ProviderCall；拿到终态后写快照（raw14 A1）", async () => {
    const env = await setupSync(t);
    const k = await env.addAccount("kuaishou", env.org.staffC, { profileFixture: "raw14.A1.poll2" }); // 登记值取自异步终态响应
    await env.scheduler.tick(SLOT);
    const task = await profileTask(env, k.accountId);
    await t.db.update(syncTasks).set({ taskParameters: { schema_version: "sync-profile-task.v1", mode: "asynchronous" } }).where(eq(syncTasks.taskId, task.taskId));
    const taskIdOf = (b: Uint8Array) => (JSON.parse(new TextDecoder().decode(b)) as { data: { task_id: string } }).data.task_id;
    const submit = loadFixtureBytes("raw14.A1.submit");
    const id = taskIdOf(submit);
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 202, body: submit });
    const polls = [loadFixtureBytes("raw14.A1.poll1"), loadFixtureBytes("raw14.A1.poll2")];
    let n = 0;
    env.transport.register({ path: `/openapi/v1/tasks/${id}`, query: {} }, () => ({ httpStatus: 200, body: polls[Math.min(n++, polls.length - 1)]! }));
    await run(env);
    expect(await snapshots()).toHaveLength(1);
    const calls = await t.db.select().from(odsProviderCalls);
    expect(calls.map((c) => [c.requestedAction, c.callSequence]).sort()).toEqual([["media_user_info", 1], ["task_lookup", 2], ["task_lookup", 3]].sort());
    expect(calls.every((c) => c.attemptNo === 1)).toBe(true);
    expect((await profileTask(env, k.accountId)).status).toBe("succeeded");
  });
});

