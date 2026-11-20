// 任务 8：同步 / 异步、租约、重试、取消与恢复（R2、R13、R14、R15、R18；acceptance G、J）。
// 全部离线：fixture transport（可注入 429 / 5xx / 传输故障 / 异步 pending→success）、fake clock（含 fake sleep）、fake OSS。
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { bytesOf } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { LIST_PATH, PROFILE_PATH, setupTracer, type TracerEnv } from "../../../tests/harness/tracer-env";
import {
  accountProfileSnapshots,
  contentDiscoveries,
  externalAccounts,
  odsProviderCalls,
  staffAccountAssignments,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import { createBudgetPolicy } from "../cost-guard";
import { TransportFailure } from "../raw-capture";
import type { TracerConfig } from "../tracer-command";
import { runTracerRoot, type RunResult, type TracerRunHooks } from "./index";

const t = useTestDb();
const TASK_ID = "6ae168cf2bcec600014629bf";
const POLL_PATH = `/openapi/v1/tasks/${TASK_ID}`;
const ASYNC: TracerConfig = { environment: "test", modes: { media_user_info: "asynchronous", user_video_list: "synchronous" } };
const sha = (s: string) => createHash("sha256").update(s).digest();

const taskBody = (status: string, extra = "") =>
  bytesOf(`{"code":0,"data":{"task_id":"${TASK_ID}","action":"media_user_info","status":"${status}","result":null,"error":${extra || "null"}},"request_id":"${TASK_ID}"}`);
const failedBody = (code: string) => taskBody("failed", `{"code":"${code}","message":"x"}`);

interface RunOpts {
  config?: TracerConfig;
  hooks?: TracerRunHooks;
  workerId?: string;
  leaseMs?: number;
  onSleep?: (ms: number) => Promise<void> | void;
}
function runner(env: TracerEnv) {
  const sleeps: number[] = [];
  const run = (rootId: bigint, o: RunOpts = {}): Promise<RunResult> =>
    runTracerRoot(
      {
        db: t.db,
        clock: env.clock,
        gateway: env.gateway,
        workerId: o.workerId ?? "w1",
        ...(o.leaseMs ? { leaseMs: o.leaseMs } : {}),
        ...(o.config ? { config: o.config } : {}),
        ...(o.hooks ? { hooks: o.hooks } : {}),
        sleep: async (ms) => {
          sleeps.push(ms);
          env.clock.advance(ms);
          await o.onSleep?.(ms);
        },
      },
      rootId,
    );
  return { run, sleeps };
}

const calls = () => t.db.select().from(odsProviderCalls).orderBy(odsProviderCalls.providerCallId);
const entities = async () => ({
  accounts: (await t.db.select().from(externalAccounts)).length,
  assignments: (await t.db.select().from(staffAccountAssignments)).length,
  profiles: (await t.db.select().from(accountProfileSnapshots)).length,
  discoveries: (await t.db.select().from(contentDiscoveries)).length,
  checkpoints: (await t.db.select().from(syncCheckpoints)).length,
});
const NONE = { accounts: 0, assignments: 0, profiles: 0, discoveries: 0, checkpoints: 0 };

/** 异步主页：submit 返回 202 running；poll 按序号返回。 */
function serveAsync(env: TracerEnv, polls: Array<Uint8Array | (() => Uint8Array)>, submit: Uint8Array = loadFixtureBytes("raw4.C09.submit")) {
  env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 202, body: submit });
  let n = 0;
  env.transport.register({ path: POLL_PATH, query: {} }, () => {
    const b = polls[Math.min(n++, polls.length - 1)]!;
    return { httpStatus: 200, body: typeof b === "function" ? b() : b };
  });
  env.serve.list("douyin");
}

describe("异步主页：提交 + 持久化任务 ID + 每次轮询一条 ProviderCall", () => {
  it("pending → pending → success：提交 1 次 + 轮询 3 次，任务 ID 落在提交调用上，每次轮询是独立调用；之后同步列表", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [taskBody("running"), taskBody("running"), loadFixtureBytes("raw4.C09.poll1")]);
    const rootId = await env.submit();
    const { run, sleeps } = runner(env);
    expect((await run(rootId, { config: ASYNC })).kind).toBe("succeeded");

    const cs = await calls();
    expect(cs.map((c) => [c.requestedAction, c.attemptNo, c.callSequence, c.callStatus, c.outcome, c.httpStatus])).toEqual([
      ["media_user_info", 1, 1, "terminal", "succeeded", 202],
      ["task_lookup", 1, 2, "terminal", "succeeded", 200],
      ["task_lookup", 1, 3, "terminal", "succeeded", 200],
      ["task_lookup", 1, 4, "terminal", "succeeded", 200],
      ["user_video_list", 1, 1, "terminal", "succeeded", 200],
    ]);
    expect(cs[0]).toMatchObject({ providerTaskId: TASK_ID, providerTaskStatus: "running", endpoint: `${PROFILE_PATH}?async=true` });
    expect(cs.slice(1, 4).every((c) => c.providerTaskId === TASK_ID && c.requestMethod === "GET" && c.endpoint === POLL_PATH && c.expectedResponseAction === "media_user_info")).toBe(true);
    expect(cs[3]!.providerTaskStatus).toBe("succeeded");
    expect(sleeps).toEqual([2000, 2000, 2000]); // 每次轮询之前等一个轮询间隔
    expect(env.transport.calls.map((c) => c.request.method)).toEqual(["POST", "GET", "GET", "GET", "POST"]);
    expect(await entities()).toMatchObject({ accounts: 1, assignments: 1, profiles: 1, discoveries: 20, checkpoints: 1 });
    // 账号来自轮询终态 payload，不是提交响应
    const [snap] = await t.db.select().from(accountProfileSnapshots);
    expect(snap!.sourceProviderCallId).toBe(cs[3]!.providerCallId);
  });

  it("pending → provider failure（RESULT_VALIDATION_FAILED）：重新提交的有界重试，三次耗尽后 invalid_link，无任何业务身份", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [taskBody("running"), failedBody("RESULT_VALIDATION_FAILED")]);
    const rootId = await env.submit();
    expect((await runner(env).run(rootId, { config: ASYNC })).kind).toBe("failed");
    const cs = await calls();
    expect(cs.filter((c) => c.requestedAction === "media_user_info")).toHaveLength(3); // 三次提交（attempt 1..3）
    expect(cs.filter((c) => c.requestedAction === "task_lookup")).toHaveLength(4); // 第 1 次提交：running、failed；第 2、3 次提交：各一次 failed
    expect(await entities()).toEqual(NONE);
    expect(await env.root(rootId)).toMatchObject({ status: "failed", stopReason: "invalid_link" });
  });

  it("轮询终态的任务 ID 与提交的不一致：不能把提交里的 locator 和别的任务的账号配对 → 稳定失败，无业务身份", async () => {
    const env = await setupTracer(t);
    const other = new TextDecoder().decode(loadFixtureBytes("raw4.C09.poll1")).replaceAll(TASK_ID, "6aaaaaaaaaaaaaaaaaaaaaaa");
    serveAsync(env, [bytesOf(other)]);
    const rootId = await env.submit();
    expect((await runner(env).run(rootId, { config: ASYNC })).kind).toBe("failed");
    expect((await env.root(rootId)).lastErrorCode).toBe("pairing_mismatch");
    expect(await entities()).toEqual(NONE);
  });

  it("供应商返回的任务 ID 含路径字符：不拼进轮询 URL，不发轮询", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [taskBody("running")], bytesOf(new TextDecoder().decode(loadFixtureBytes("raw4.C09.submit")).replaceAll(TASK_ID, "../../admin")));
    const rootId = await env.submit();
    expect((await runner(env).run(rootId, { config: ASYNC })).kind).toBe("failed");
    expect(env.transport.calls.filter((c) => c.request.method === "GET")).toHaveLength(0);
    expect((await env.root(rootId)).lastErrorCode).toBe("provider_task_id_unusable");
  });

  it("其他供应商任务失败（非校验类）：不重试，稳定分类，不是 invalid_link", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [failedBody("INTERNAL")]);
    const rootId = await env.submit();
    expect((await runner(env).run(rootId, { config: ASYNC })).kind).toBe("failed");
    expect((await calls()).filter((c) => c.requestedAction === "media_user_info")).toHaveLength(1);
    expect((await env.status(rootId)).failure).toMatchObject({ category: "provider_task_failed", retryable: false });
    expect((await env.status(rootId)).entryOutcome).toBeUndefined();
    expect(await entities()).toEqual(NONE);
  });

  it("单次轮询被限流（429）：不算失败，下一次轮询继续，最终成功", async () => {
    const env = await setupTracer(t);
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 202, body: loadFixtureBytes("raw4.C09.submit") });
    let n = 0;
    env.transport.register({ path: POLL_PATH, query: {} }, () =>
      n++ === 0 ? { httpStatus: 429, body: bytesOf('{"code":"RATE_LIMITED"}') } : { httpStatus: 200, body: loadFixtureBytes("raw4.C09.poll1") },
    );
    env.serve.list("douyin");
    const rootId = await env.submit();
    expect((await runner(env).run(rootId, { config: ASYNC })).kind).toBe("succeeded");
    expect((await calls()).filter((c) => c.requestedAction === "task_lookup").map((c) => c.httpStatus)).toEqual([429, 200]);
  });

  it("一直 pending → 超过轮询上限：poll_timeout，恰好 3 次轮询，之后不再请求；没有业务身份", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [taskBody("running")]);
    const rootId = await env.submit();
    const { run, sleeps } = runner(env);
    const cfg: TracerConfig = { ...ASYNC, async: { pollIntervalMs: 1000, maxPolls: 3, maxWaitMs: 60_000 } };
    expect((await run(rootId, { config: cfg })).kind).toBe("failed");
    expect((await calls()).filter((c) => c.requestedAction === "task_lookup")).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect((await env.status(rootId)).failure).toMatchObject({ category: "provider_timeout", code: "poll_timeout" });
    expect(await entities()).toEqual(NONE);
  });

  it("等待总时长超过上限也停止（maxWaitMs）", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [taskBody("running")]);
    const rootId = await env.submit();
    const { run } = runner(env);
    await run(rootId, { config: { ...ASYNC, async: { pollIntervalMs: 5000, maxPolls: 100, maxWaitMs: 12_000 } } });
    expect((await calls()).filter((c) => c.requestedAction === "task_lookup").length).toBeLessThanOrEqual(3);
    expect((await env.root(rootId)).lastErrorCode).toBe("poll_timeout");
  });

  it("轮询期间被取消：不再发起轮询，没有业务身份，返回 cancelled", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [taskBody("running")]);
    const rootId = await env.submit();
    const { run } = runner(env);
    const r = await run(rootId, { config: ASYNC, onSleep: async () => void (await env.commands.cancel(rootId.toString(), env.actor)) });
    expect(r.kind).toBe("cancelled");
    expect((await calls()).filter((c) => c.requestedAction === "task_lookup")).toHaveLength(0); // 取消发生在第一次轮询之前
    expect(await entities()).toEqual(NONE);
    expect((await env.root(rootId)).status).toBe("cancelled");
  });

  it("user_video_list 异步永远不被允许（供应商三平台均失败）：运行期同样 fail closed，不发任何调用", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    const rootId = await env.submit();
    const r = await runner(env).run(rootId, { config: { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "asynchronous" } } });
    expect(r.kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(0);
    expect((await env.root(rootId)).lastErrorCode).toBe("unsupported_capability");
  });

  it("运行期再次过 capability gate：未登记的环境（staging）不放行，不发任何调用", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    const r = await runner(env).run(rootId, { config: { environment: "staging", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } } });
    expect(r.kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(0);
    expect(await calls()).toHaveLength(0);
  });
});

describe("重试等待：限流 / 5xx / 已知未送达的传输失败", () => {
  const ok = () => loadFixtureBytes("raw3.douyin.media_user_info");
  const body429 = () => bytesOf('{"code":"RATE_LIMITED","message":"slow down"}');

  it("429 → retry_wait（不在同一次运行里立刻重试）；到点前再运行不产生新调用；到点后继续并成功", async () => {
    const env = await setupTracer(t);
    env.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, (_r, i) => (i === 0 ? { httpStatus: 429, body: body429() } : { httpStatus: 200, body: ok() }));
    env.serve.list("douyin");
    const rootId = await env.submit();
    const { run } = runner(env);

    const first = await run(rootId);
    expect(first.kind).toBe("retry_wait");
    const r1 = await env.root(rootId);
    expect(r1).toMatchObject({ status: "retry_wait", leaseOwner: null, lastErrorCode: "rate_limited" });
    expect(r1.nextAttemptAt!.getTime()).toBe(env.clock.now().getTime() + 5000);
    const s1 = await env.status(rootId);
    expect(s1.state).toBe("retry_wait");
    expect(s1.failure).toMatchObject({ category: "rate_limited", retryable: true });
    expect(env.transport.calls).toHaveLength(1);

    const tokenBefore = (await env.root(rootId)).fencingToken;
    expect((await run(rootId)).kind).toBe("retry_wait"); // 还没到点
    expect(env.transport.calls).toHaveLength(1);
    expect(await env.root(rootId)).toMatchObject({ status: "retry_wait", fencingToken: tokenBefore }); // 没有领取，没有换 fencing token

    env.clock.advance(5000);
    expect((await run(rootId)).kind).toBe("succeeded");
    const cs = await calls();
    expect(cs.filter((c) => c.requestedAction === "media_user_info").map((c) => [c.attemptNo, c.httpStatus])).toEqual([[1, 429], [2, 200]]);
    expect(await entities()).toMatchObject({ accounts: 1, discoveries: 20, checkpoints: 1 });
    expect((await env.root(rootId)).status).toBe("succeeded");
  });

  it("退避指数增长（5s、10s）；三次耗尽后失败，不再重试", async () => {
    const env = await setupTracer(t);
    env.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus: 429, body: body429() });
    const rootId = await env.submit();
    const { run } = runner(env);
    expect((await run(rootId)).kind).toBe("retry_wait");
    env.clock.advance(5000);
    expect((await run(rootId)).kind).toBe("retry_wait");
    expect((await env.root(rootId)).nextAttemptAt!.getTime()).toBe(env.clock.now().getTime() + 10_000);
    env.clock.advance(10_000);
    expect((await run(rootId)).kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(3);
    expect((await env.status(rootId)).failure).toMatchObject({ category: "rate_limited", retryable: false });
    expect(await entities()).toEqual(NONE);
    env.clock.advance(3600_000);
    expect((await run(rootId)).kind).toBe("already_terminal");
    expect(env.transport.calls).toHaveLength(3);
  });

  it("5xx 与「已知未送达」的传输失败同样进入 retry_wait；已知未送达的调用是 terminal/transport_error", async () => {
    for (const mk of [
      () => ({ httpStatus: 503, body: bytesOf('{"code":"UNAVAILABLE"}') }),
      () => {
        throw new TransportFailure("connect_refused", "no", "ECONNREFUSED");
      },
    ]) {
      const env = await setupTracer(t);
      env.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, (_r, i) => (i === 0 ? mk() : { httpStatus: 200, body: ok() }));
      env.serve.list("douyin");
      const rootId = await env.submit();
      const { run } = runner(env);
      expect((await run(rootId)).kind).toBe("retry_wait");
      env.clock.advance(5000);
      expect((await run(rootId)).kind).toBe("succeeded");
      expect(await entities()).toMatchObject({ accounts: 1 });
    }
  });

  it("列表阶段限流：主页事实保留，子任务与 root 进入 retry_wait；到点后只补列表，不重新调主页", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    let listCalls = 0; // callIndex 是 transport 全局序号，不是这条路由的序号
    env.transport.register({ path: LIST_PATH, query: { async: "false" } }, () => (listCalls++ === 0 ? { httpStatus: 429, body: bytesOf('{"code":"RATE_LIMITED"}') } : { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.user_video_list") }));
    const rootId = await env.submit();
    const { run } = runner(env);
    expect((await run(rootId)).kind).toBe("retry_wait");
    expect(await entities()).toMatchObject({ accounts: 1, profiles: 1, discoveries: 0, checkpoints: 0 });
    const kids = await t.db.select().from(syncTasks).where(eq(syncTasks.parentTaskId, rootId));
    expect(kids[0]).toMatchObject({ status: "retry_wait" });
    env.clock.advance(5000);
    expect((await run(rootId)).kind).toBe("succeeded");
    expect(env.transport.calls.map((c) => c.request.path)).toEqual([PROFILE_PATH, LIST_PATH, LIST_PATH]); // 主页只调了一次
    expect(await entities()).toMatchObject({ discoveries: 20, checkpoints: 1 });
  });
});

describe("崩溃与恢复", () => {
  class Crash extends Error {}

  it("crash-before-send（intent 已落地）：接手后只发送一次", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    env.hooks.afterPrepared = () => {
      throw new Crash("发送前崩溃");
    };
    const { run } = runner(env);
    await expect(run(rootId)).rejects.toThrow(Crash);
    expect(env.transport.calls).toHaveLength(0);
    delete env.hooks.afterPrepared;
    env.clock.advance(120_000);
    expect((await run(rootId, { workerId: "w2" })).kind).toBe("succeeded");
    expect(env.transport.calls).toHaveLength(2);
    expect(await calls()).toHaveLength(2);
  });

  it("crash-after-send-before-terminal-capture：原调用保持 ambiguous 且不被改写；最多再发一次新调用；业务事实只有一份", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.media_user_info") }); // 结果不明之后的重发改走异步
    env.serve.list("douyin");
    const rootId = await env.submit();
    env.hooks.afterNetwork = () => {
      if (env.transport.calls.length === 1) throw new Crash("响应返回后、终态落地前崩溃");
    };
    const { run } = runner(env);
    await expect(run(rootId)).rejects.toThrow(Crash);
    expect((await calls())[0]).toMatchObject({ callStatus: "in_flight" });

    env.clock.advance(120_000);
    expect((await run(rootId, { workerId: "w2" })).kind).toBe("succeeded");
    const cs = await calls();
    expect(cs.map((c) => [c.requestedAction, c.attemptNo, c.callStatus, c.outcome])).toEqual([
      ["media_user_info", 1, "ambiguous", "ambiguous"],
      ["media_user_info", 2, "terminal", "succeeded"],
      ["user_video_list", 1, "terminal", "succeeded"],
    ]);
    expect(env.transport.calls).toHaveLength(3); // 主页 2 次（含 1 次重发）+ 列表 1 次
    expect(env.transport.calls.map((c) => c.request.query.async)).toEqual(["false", "true", "false"]); // 重发是异步，列表仍是同步
    expect(await entities()).toMatchObject({ accounts: 1, assignments: 1, profiles: 1, discoveries: 20, checkpoints: 1 });
  });

  it("重发之后又 ambiguous：不再盲重发，失败为 provider_outcome_unknown，没有业务身份", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    const rootId = await env.submit();
    env.hooks.afterNetwork = () => {
      throw new Crash("每次都在响应后崩溃");
    };
    const { run } = runner(env);
    await expect(run(rootId)).rejects.toThrow(Crash);
    env.clock.advance(120_000);
    await expect(run(rootId, { workerId: "w2" })).rejects.toThrow(Crash); // 第二次发送（重发）也失联
    delete env.hooks.afterNetwork;
    env.clock.advance(120_000);
    const sent = env.transport.calls.length;
    expect((await run(rootId, { workerId: "w3" })).kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(sent); // 第三次没有再发
    expect((await calls()).filter((c) => c.callStatus === "ambiguous")).toHaveLength(2);
    expect((await env.status(rootId)).failure).toMatchObject({ category: "provider_outcome_unknown" });
    expect(await entities()).toEqual(NONE);
  });

  it("crash-after-project（整页提交后、返回前）：重新运行只得到 already_terminal，事实与调用数不变", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    const { run } = runner(env);
    await expect(
      run(rootId, {
        hooks: {
          afterPageProjection: () => {
            throw new Crash("投影提交后崩溃");
          },
        },
      }),
    ).rejects.toThrow(Crash);
    const before = await entities();
    expect((await run(rootId, { workerId: "w2" })).kind).toBe("already_terminal");
    expect(await entities()).toEqual(before);
    expect(env.transport.calls).toHaveLength(2);
  });

  it("租约接管：worker1 停滞、租约到期，worker2 完成全部；worker1 醒来后的投影被 fencing 拒绝，事实只有一份", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    const { run } = runner(env);
    let inner: RunResult | undefined;
    const r1 = await run(rootId, {
      workerId: "w1",
      leaseMs: 30_000,
      hooks: {
        beforeIntake: async () => {
          env.clock.advance(60_000); // w1 停滞，租约到期
          inner = await run(rootId, { workerId: "w2", leaseMs: 30_000 });
        },
      },
    });
    expect(inner!.kind).toBe("succeeded");
    expect(r1.kind).toBe("stale");
    expect(await entities()).toMatchObject({ accounts: 1, assignments: 1, profiles: 1, discoveries: 20, checkpoints: 1 });
    expect((await env.root(rootId)).fencingToken).toBe(2n); // 单调递增：w1=1，w2=2
    expect(env.transport.calls).toHaveLength(2); // w2 复用 w1 已捕获的主页证据，只补列表
  });

  it("心跳：轮询等待比租约还长时，租约被续期，另一个 worker 抢不到（busy）", async () => {
    const env = await setupTracer(t);
    serveAsync(env, [taskBody("running"), taskBody("running"), loadFixtureBytes("raw4.C09.poll1")]);
    const rootId = await env.submit();
    const { run } = runner(env);
    const intruders: string[] = [];
    const r = await run(rootId, {
      config: { ...ASYNC, async: { pollIntervalMs: 8000, maxPolls: 5, maxWaitMs: 600_000 } },
      leaseMs: 10_000,
      onSleep: async () => {
        intruders.push((await run(rootId, { workerId: "intruder", leaseMs: 10_000 })).kind);
      },
    });
    expect(r.kind).toBe("succeeded");
    expect(intruders.length).toBeGreaterThanOrEqual(3);
    expect(intruders.every((k) => k === "busy")).toBe(true);
  });

  it("总截止时间：root 已超过截止时间则不再发任何调用", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    const rootId = await env.submit();
    env.clock.advance(3 * 3600_000);
    const r = await runner(env).run(rootId, { config: { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "synchronous" }, rootDeadlineMs: 3600_000 } });
    expect(r.kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(0);
    expect((await env.status(rootId)).failure).toMatchObject({ category: "deadline", code: "deadline_exceeded" });
  });
});

describe("预算与成本：达到上限在下一次调用前停止", () => {
  it("maxCalls=1：主页发出后列表被封口（not_sent），没有发送；失败为 policy_blocked，主页事实保留", async () => {
    const env = await setupTracer(t, { policy: createBudgetPolicy(t.db, { maxCalls: 1 }) });
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    expect((await runner(env).run(rootId)).kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(1);
    const cs = await calls();
    expect(cs.map((c) => [c.requestedAction, c.callStatus, c.outcome])).toEqual([["media_user_info", "terminal", "succeeded"], ["user_video_list", "terminal", "not_sent"]]);
    expect((await env.status(rootId)).failure).toMatchObject({ category: "policy", code: "policy_blocked" });
    expect(await entities()).toMatchObject({ accounts: 1, profiles: 1, discoveries: 0, checkpoints: 0 });
  });

  it("maxPoints：抖音主页 10 点 + 列表 10 点；预算 10 点时列表在发送前被封口；预算 20 点刚好够", async () => {
    const tight = await setupTracer(t, { policy: createBudgetPolicy(t.db, { maxPoints: 10 }) });
    tight.serve.profile("douyin");
    tight.serve.list("douyin");
    const r1 = await tight.submit();
    expect((await runner(tight).run(r1)).kind).toBe("failed");
    expect(tight.transport.calls).toHaveLength(1);

    const enough = await setupTracer(t, { policy: createBudgetPolicy(t.db, { maxPoints: 20 }) });
    enough.serve.profile("douyin");
    enough.serve.list("douyin");
    const r2 = await enough.submit();
    expect((await runner(enough).run(r2)).kind).toBe("succeeded");
  });

  it("封口时租约恰好丢失（not_sent 的原因不是 policy）：重新运行从下一次尝试继续，不会永远 stale 并反复续租", async () => {
    // 测试机 2026-11-20 的实际现象：批次预算封口的同一瞬间根任务租约过期，网关把该调用记为 not_sent 但原因是租约，
    // 根任务停在 running；之后每个 tick 重放第 1 次尝试都得到 previously_not_sent → stale，租约被一再续上，永远不结束。
    let checks = 0;
    // eslint-disable-next-line prefer-const -- 策略需要在创建 env 之后才能引用 env.clock
    let env: TracerEnv;
    const policy = {
      async check() {
        if (checks++ > 0) return null;
        env.clock.advance(120_000); // 租约默认 60 秒：到网关最后一次校验时已过期，原因记为租约而不是 policy
        return "call_budget" as const;
      },
    };
    env = await setupTracer(t, { policy });
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    const { run } = runner(env);
    expect((await run(rootId)).kind).toBe("stale");
    expect(env.transport.calls).toHaveLength(0);
    const r = await run(rootId); // 预算已放宽：第 1 次尝试是 previously_not_sent，第 2 次尝试新建调用并发送
    expect(r.kind).toBe("succeeded");
    expect((await calls()).map((c) => [c.attemptNo, c.requestedAction, c.outcome])).toEqual([[1, "media_user_info", "not_sent"], [2, "media_user_info", "succeeded"], [1, "user_video_list", "succeeded"]]);
  });
  it("轮询不计点，但受 maxPolls 限制：maxPolls=2 时第 3 次轮询在发送前被封口", async () => {
    const env = await setupTracer(t, { policy: createBudgetPolicy(t.db, { maxPolls: 2 }) });
    serveAsync(env, [taskBody("running")]);
    const rootId = await env.submit();
    const r = await runner(env).run(rootId, { config: { ...ASYNC, async: { pollIntervalMs: 100, maxPolls: 10, maxWaitMs: 600_000 } } });
    expect(r.kind).toBe("failed");
    expect(env.transport.calls.filter((c) => c.request.method === "GET")).toHaveLength(2);
    expect((await env.root(rootId)).lastErrorCode).toBe("policy_blocked");
  });

  it("失败与限流的调用不计点", async () => {
    const env = await setupTracer(t, { policy: createBudgetPolicy(t.db, { maxPoints: 10 }) });
    env.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, (_r, i) => (i === 0 ? { httpStatus: 429, body: bytesOf('{"code":"RATE_LIMITED"}') } : { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.media_user_info") }));
    env.serve.list("douyin");
    const rootId = await env.submit();
    const { run } = runner(env);
    await run(rootId);
    env.clock.advance(5000);
    await run(rootId); // 主页成功后点数 = 10，列表被封口，但主页没有因为 429 被多算
    expect(env.transport.calls.map((c) => c.request.path)).toEqual([PROFILE_PATH, PROFILE_PATH]);
    expect((await env.root(rootId)).lastErrorCode).toBe("policy_blocked");
  });
});

void sha;
