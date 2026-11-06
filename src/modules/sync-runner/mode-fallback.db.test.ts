// 同步 → 异步兜底（刘学奎 2026-11-06 确认）：主页同步超时 / 结果不明 / RESULT_VALIDATION_FAILED 之后，第 2、3 次尝试改走异步；其它失败保持同步。
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { PROFILE_PATH, SLOT, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { accountProfileSnapshots, odsProviderCalls, syncTasks } from "../../db/schema";
import { eq } from "drizzle-orm";
import { TransportFailure } from "../raw-capture";
import { createProfileRunner } from "./profile-runner";

const t = useTestDb();
const run = async (env: SyncEnv) => env.worker({ fetch_profile: createProfileRunner(env.deps) }).run({ untilIdle: true });
const modesSent = (env: SyncEnv) => env.transport.calls.map((c) => (c.request.path === PROFILE_PATH ? `profile:${c.request.query.async}` : "poll"));

/** 快手账号 + 异步终态响应对应的标识；异步路由按 raw14 A1（提交 + 2 次轮询）。 */
async function world() {
  const env = await setupSync(t);
  const k = await env.addAccount("kuaishou", env.org.staffC, { profileFixture: "raw14.A1.poll2" });
  await env.scheduler.tick(SLOT);
  const submit = loadFixtureBytes("raw14.A1.submit");
  const id = (JSON.parse(new TextDecoder().decode(submit)) as { data: { task_id: string } }).data.task_id;
  const registerAsync = () => {
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 202, body: submit });
    const polls = [loadFixtureBytes("raw14.A1.poll1"), loadFixtureBytes("raw14.A1.poll2")];
    let n = 0;
    env.transport.register({ path: `/openapi/v1/tasks/${id}`, query: {} }, () => ({ httpStatus: 200, body: polls[Math.min(n++, polls.length - 1)]! }));
  };
  const task = async () => (await env.tasks("fetch_profile")).find((x) => x.accountId === k.accountId)!;
  /** 一次领取 + 推进到退避之后。 */
  const attempt = async () => {
    await run(env);
    env.clock.advance(10 * 60_000);
  };
  return { env, k, registerAsync, task, attempt };
}

describe("主页：同步失败后改走异步", () => {
  it("同步超时（结果不明）→ 第 2 次尝试异步提交 + 轮询并成功；第 1 次的 ambiguous 记录保留", async () => {
    const { env, k, registerAsync, task, attempt } = await world();
    env.routeBy(PROFILE_PATH, { [env.locatorOf(k.accountId)]: () => { throw new TransportFailure("timeout", "unknown", "timeout"); } });
    registerAsync();
    await attempt();
    expect(await task()).toMatchObject({ status: "retry_wait", lastErrorCode: "ambiguous_unresolved", attemptCount: 1 });
    await attempt();
    expect(await task()).toMatchObject({ status: "succeeded", attemptCount: 1 }); // 成功不增加 attempt_count；调用的 attempt_no 才是 2
    expect(modesSent(env)).toEqual(["profile:false", "profile:true", "poll", "poll"]);
    expect(await t.db.select().from(accountProfileSnapshots)).toHaveLength(1);
    const calls = await t.db.select().from(odsProviderCalls).orderBy(odsProviderCalls.providerCallId);
    expect(calls.map((c) => [c.attemptNo, c.requestedAction, c.outcome])).toEqual([
      [1, "media_user_info", "ambiguous"],
      [2, "media_user_info", "succeeded"],
      [2, "task_lookup", "succeeded"],
      [2, "task_lookup", "succeeded"],
    ]);
  });

  it("同步 RESULT_VALIDATION_FAILED → 第 2 次尝试异步；异步仍失败时第 3 次继续异步（不回到同步）", async () => {
    const { env, k, task, attempt } = await world();
    const bad = { httpStatus: 500, body: loadFixtureBytes("raw7.C20.http500") };
    env.routeBy(PROFILE_PATH, { [env.locatorOf(k.accountId)]: bad });
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, bad);
    await attempt();
    await attempt();
    await attempt();
    expect(modesSent(env)).toEqual(["profile:false", "profile:true", "profile:true"]);
    expect(await task()).toMatchObject({ status: "failed", lastErrorCode: "provider_input_inaccessible", attemptCount: 3 });
  });

  it("不属于触发条件的失败（429）：重试仍然同步，不碰异步", async () => {
    const { env, k, task, attempt } = await world();
    env.routeBy(PROFILE_PATH, { [env.locatorOf(k.accountId)]: { httpStatus: 429, body: new TextEncoder().encode('{"code":"RATE_LIMITED"}') } });
    await attempt();
    await attempt();
    expect(modesSent(env)).toEqual(["profile:false", "profile:false"]);
    expect(env.transport.rejected).toHaveLength(0);
    expect((await task()).lastErrorCode).toBe("rate_limited");
  });

  it("配置本来就是异步的任务：重试仍是异步，兜底不介入", async () => {
    const { env, task, attempt } = await world();
    // 把配置的模式改成异步：任务参数的 mode 是权威，兜底只在配置为同步时生效
    const row = await task();
    await t.db.update(syncTasks).set({ taskParameters: { schema_version: "sync-profile-task.v1", mode: "asynchronous" } }).where(eq(syncTasks.taskId, row.taskId));
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, () => { throw new TransportFailure("timeout", "unknown", "timeout"); });
    await attempt();
    await attempt();
    expect(modesSent(env)).toEqual(["profile:true", "profile:true"]);
  });
});
