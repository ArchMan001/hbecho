// 任务 9：真实 smoke 的执行器（R17）。**不发任何真实调用**：transport 是 fixture transport，secret 是假的，
// 网络拒绝挂具仍然生效。证明的是：门槛先于一切副作用；执行时仍走 raw-before-parse / ProviderCall / 成本守卫；
// 预算与 deadline 在下一次调用前停止；审计摘要不含 secret 与完整载荷。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDb, resetData } from "../../../tests/harness/db";
import { bytesOf } from "../../../tests/harness/decode-helpers";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../tests/harness/fake-oss";
import { FixtureTransport } from "../../../tests/harness/fixture-transport";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { LIST_PATH, PROFILE_PATH } from "../../../tests/harness/tracer-env";
import {
  accountProfileSnapshots,
  contentSnapshots,
  contents,
  externalAccounts,
  odsPayloads,
  odsProviderCalls,
  staffAccountAssignments,
  syncBatches,
  syncCheckpoints,
} from "../../db/schema";
import { jcsSha256Hex } from "../canonical-json";
import { TransportFailure, type ProviderRequest } from "../raw-capture";
import { AllowlistTransport, SMOKE_SWITCH_ENV, SMOKE_SWITCH_VALUE, SmokeRefused, authorizeAndRun, type SmokeDeps } from "./index";

const t = useTestDb();
const START = new Date("2026-11-04T12:00:00.000Z");
const LOCATOR = "https://v.douyin.com/MPOAlEqWpec/";
const SECRET = "sk-FAKE-SMOKE-TEST-SECRET-0123456789";
const TASK_ID = "6ae168cf2bcec600014629bf";
const POLL_PATH = `/openapi/v1/tasks/${TASK_ID}`;
const ENV_ON = { [SMOKE_SWITCH_ENV]: SMOKE_SWITCH_VALUE };

const entry = (action: "media_user_info" | "user_video_list", mode: "synchronous" | "asynchronous" = "synchronous") => ({ platform: "douyin", action, mode, locator: LOCATOR });
const plan = (over: Record<string, unknown> = {}) => ({
  schema_version: "data-foundation-smoke-plan.v1",
  environment: "production",
  allowlist: [entry("media_user_info"), entry("user_video_list")],
  budget: { max_calls: 2, max_polls: 0, max_points: 20 },
  deadline_ms: 120_000,
  ...over,
});
const approval = (p: unknown) => ({
  schema_version: "data-foundation-smoke-approval.v1",
  approved_by: "liuxuekui",
  approved_at: "2026-11-04T11:30:00.000Z",
  expires_at: "2026-11-04T18:00:00.000Z",
  plan_sha256: jcsSha256Hex(p as never),
  reason: "离线测试用的审批记录",
});

async function setup() {
  await resetData(t.pool);
  const clock = new FakeClock(START);
  const store = new FakeObjectStore(clock);
  const transport = new FixtureTransport();
  const secretReads: number[] = [];
  const madeWith: string[] = [];
  const logs: string[] = [];
  const deps: SmokeDeps = {
    db: t.db,
    clock,
    store,
    location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-test" },
    secrets: {
      apiKey: async () => {
        secretReads.push(1);
        return SECRET;
      },
    },
    makeTransport: (apiKey) => {
      madeWith.push(apiKey);
      return transport;
    },
    sleep: async (ms) => clock.advance(ms),
    log: (line) => logs.push(line),
  };
  const run = (p: unknown, a: unknown | null = approval(p), env: Record<string, string | undefined> = ENV_ON) => authorizeAndRun(deps, { plan: p, approval: a, env });
  const serveSync = () => {
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.media_user_info") });
    transport.register({ path: LIST_PATH, query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.user_video_list") });
  };
  return { clock, store, transport, secretReads, madeWith, logs, deps, run, serveSync };
}

const businessRows = async () => ({
  accounts: (await t.db.select().from(externalAccounts)).length,
  assignments: (await t.db.select().from(staffAccountAssignments)).length,
  profiles: (await t.db.select().from(accountProfileSnapshots)).length,
  contents: (await t.db.select().from(contents)).length,
  snapshots: (await t.db.select().from(contentSnapshots)).length,
  checkpoints: (await t.db.select().from(syncCheckpoints)).length,
});

describe("未获批准：在任何网络调用、secret 读取、数据库写入之前失败", () => {
  const cases: Array<[string, (p: ReturnType<typeof plan>) => { approval?: unknown | null; env?: Record<string, string | undefined>; plan?: unknown }, string]> = [
    ["开关未设置", () => ({ env: {} }), "switch_off"],
    ["没有审批记录", () => ({ approval: null }), "approval_missing"],
    ["审批过期", (p) => ({ approval: { ...approval(p), expires_at: "2026-11-04T11:59:00.000Z" } }), "approval_expired"],
    ["审批对应的是另一份计划", (p) => ({ plan: plan({ deadline_ms: 60_000 }), approval: approval(p) }), "approval_plan_mismatch"],
    ["异步列表（供应商侧已知失败）", () => ({ plan: plan({ allowlist: [entry("user_video_list", "asynchronous")] }), approval: undefined }), "allowlist_tuple_unavailable"],
    ["预算放不下", () => ({ plan: plan({ budget: { max_calls: 2, max_polls: 0, max_points: 10 } }), approval: undefined }), "budget_too_small"],
  ];
  for (const [name, mk, code] of cases) {
    it(`${name} → ${code}；transport 0 次、secret 0 次、批次 / 调用 / ODS 对象 0 行`, async () => {
      const s = await setup();
      s.serveSync();
      const p = plan();
      const o = mk(p);
      const usedPlan = o.plan ?? p;
      const usedApproval = o.approval === undefined ? approval(usedPlan) : o.approval;
      await expect(s.run(usedPlan, usedApproval, o.env ?? ENV_ON)).rejects.toMatchObject({ code });
      await expect(s.run(usedPlan, usedApproval, o.env ?? ENV_ON)).rejects.toBeInstanceOf(SmokeRefused);
      expect(s.transport.calls).toHaveLength(0);
      expect(s.transport.rejected).toHaveLength(0);
      expect(s.secretReads).toHaveLength(0);
      expect(s.madeWith).toHaveLength(0);
      expect(await t.db.select().from(syncBatches)).toHaveLength(0);
      expect(await t.db.select().from(odsProviderCalls)).toHaveLength(0);
      expect(s.store.keys()).toHaveLength(0);
      expect(s.logs).toHaveLength(0);
    });
  }
});

describe("获批后的执行：仍走 raw-before-parse / ProviderCall / 成本守卫，只留证据不写业务事实", () => {
  it("抖音主页 + 列表各 1 次：2 条 ProviderCall、点数 20 = 0.4 元、ODS 有请求与响应字节、业务表一行都没有", async () => {
    const s = await setup();
    s.serveSync();
    const sum = await s.run(plan());
    expect(s.secretReads).toHaveLength(1);
    expect(s.madeWith).toEqual([SECRET]); // 只交给 transport 工厂，不落任何地方
    expect(s.transport.calls.map((c) => c.request.path)).toEqual([PROFILE_PATH, LIST_PATH]);

    expect(sum).toMatchObject({ stoppedBy: null, approvedBy: "liuxuekui", environment: "production" });
    expect(sum.totals).toMatchObject({ calls: 2, polls: 0, estimatedPoints: 20, estimatedYuan: 0.4 });
    expect(sum.totals.bytesReceived).toBeGreaterThan(10_000);
    expect(sum.tuples.map((x) => [x.action, x.mode, x.calls, x.polls, x.category, x.decoded, x.adapterVersion])).toEqual([
      ["media_user_info", "synchronous", 1, 0, "none", true, "aimaster-adapter.v1"],
      ["user_video_list", "synchronous", 1, 0, "none", true, "aimaster-adapter.v1"],
    ]);
    expect(sum.evidence).toHaveLength(2);

    const calls = await t.db.select().from(odsProviderCalls).orderBy(odsProviderCalls.providerCallId);
    expect(calls.map((c) => [c.callStatus, c.outcome])).toEqual([["terminal", "succeeded"], ["terminal", "succeeded"]]);
    const payloads = await t.db.select().from(odsPayloads);
    expect(payloads.map((p) => p.payloadRole).sort()).toEqual(["request_body", "request_body", "response_body", "response_body"]);
    expect(payloads.filter((p) => p.payloadRole === "response_body").every((p) => p.parseStatus === "parsed")).toBe(true);
    expect(await businessRows()).toEqual({ accounts: 0, assignments: 0, profiles: 0, contents: 0, snapshots: 0, checkpoints: 0 });
  });

  it("审计摘要与日志不含 secret、完整载荷或 locator 原文；locator 只以摘要前缀出现", async () => {
    const s = await setup();
    s.serveSync();
    const sum = await s.run(plan());
    const text = JSON.stringify(sum) + s.logs.join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("MPOAlEqWpec");
    expect(text).not.toContain("日立中央空调"); // 响应里的昵称
    expect(text).not.toContain("HITACHI1");
    expect(sum.tuples[0]!.locatorSha256Prefix).toBe(createHash("sha256").update(LOCATOR).digest("hex").slice(0, 16));
    // 保留的 ODS 证据里也没有 secret
    for (const k of s.store.keys()) expect(Buffer.from((await s.store.get(k))!).toString("utf8")).not.toContain(SECRET);
  });

  it("不重试：校验失败的主页只调 1 次，如实报告，列表仍按计划执行", async () => {
    const s = await setup();
    s.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus: 500, body: loadFixtureBytes("raw7.C20.http500") });
    s.transport.register({ path: LIST_PATH, query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.user_video_list") });
    const sum = await s.run(plan());
    expect(s.transport.calls).toHaveLength(2);
    expect(sum.tuples[0]).toMatchObject({ calls: 1, category: "provider_validation_failed", decoded: false });
    expect(sum.totals.estimatedPoints).toBe(10); // 失败的调用不计点
  });

  it("响应不是合法信封：先落 ODS，再报告 decoded=false（schema_drift），不抛异常", async () => {
    const s = await setup();
    s.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus: 200, body: bytesOf("not json") });
    s.transport.register({ path: LIST_PATH, query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.user_video_list") });
    const sum = await s.run(plan());
    expect(sum.tuples[0]).toMatchObject({ decoded: false });
    expect((await t.db.select().from(odsPayloads)).filter((p) => p.payloadRole === "response_body")).toHaveLength(2);
  });

  it("传输失败如实报告并继续下一条；没有自动重试", async () => {
    const s = await setup();
    s.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new TransportFailure("connect_refused", "no", "ECONNREFUSED");
    });
    s.transport.register({ path: LIST_PATH, query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.user_video_list") });
    const sum = await s.run(plan());
    expect(sum.tuples[0]).toMatchObject({ category: "transport_failed", decoded: false });
    expect(s.transport.calls).toHaveLength(2);
  });
});

describe("停止逻辑：达到上限在下一次调用前停止", () => {
  it("deadline：第一次调用耗时超过截止时间 → 第二条在发送前被封口（not_sent），transport 只有 1 次", async () => {
    const s = await setup();
    s.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      s.clock.advance(200_000); // 比 deadline_ms=120000 还长
      return { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.media_user_info") };
    });
    s.transport.register({ path: LIST_PATH, query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.user_video_list") });
    const sum = await s.run(plan());
    expect(sum.stoppedBy).toBe("deadline");
    expect(s.transport.calls).toHaveLength(1);
    expect(sum.tuples[1]).toMatchObject({ calls: 0, category: "stopped:deadline" });
    const calls = await t.db.select().from(odsProviderCalls).orderBy(odsProviderCalls.providerCallId);
    expect(calls[1]).toMatchObject({ callStatus: "terminal", outcome: "not_sent" });
  });

  it("异步主页：提交 1 次 + 轮询（pending → pending → success）；轮询计数、不计点；终态可解码", async () => {
    const s = await setup();
    const p = plan({ allowlist: [entry("media_user_info", "asynchronous")], budget: { max_calls: 1, max_polls: 5, max_points: 10 }, poll_interval_ms: 500 });
    s.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 202, body: loadFixtureBytes("raw4.C09.submit") });
    let n = 0;
    const running = bytesOf(`{"code":0,"data":{"task_id":"${TASK_ID}","action":"media_user_info","status":"running","result":null,"error":null},"request_id":"${TASK_ID}"}`);
    s.transport.register({ path: POLL_PATH, query: {} }, () => ({ httpStatus: 200, body: n++ < 2 ? running : loadFixtureBytes("raw4.C09.poll1") }));
    const sum = await s.run(p);
    expect(sum.totals).toMatchObject({ calls: 1, polls: 3, estimatedPoints: 10 });
    expect(sum.tuples[0]).toMatchObject({ mode: "asynchronous", calls: 1, polls: 3, decoded: true, category: "none" });
    expect(s.transport.calls.map((c) => c.request.method)).toEqual(["POST", "GET", "GET", "GET"]);
  });

  it("异步主页一直 pending：max_polls=2 时第 3 次轮询在发送前被封口，stoppedBy=poll_budget", async () => {
    const s = await setup();
    const p = plan({ allowlist: [entry("media_user_info", "asynchronous")], budget: { max_calls: 1, max_polls: 2, max_points: 10 }, poll_interval_ms: 500 });
    s.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 202, body: loadFixtureBytes("raw4.C09.submit") });
    const running = bytesOf(`{"code":0,"data":{"task_id":"${TASK_ID}","action":"media_user_info","status":"running","result":null,"error":null},"request_id":"${TASK_ID}"}`);
    s.transport.register({ path: POLL_PATH, query: {} }, { httpStatus: 200, body: running });
    const sum = await s.run(p);
    expect(sum.stoppedBy).toBe("poll_budget");
    expect(s.transport.calls.filter((c) => c.request.method === "GET")).toHaveLength(2);
    expect(sum.tuples[0]).toMatchObject({ polls: 2, decoded: false });
  });
});

describe("AllowlistTransport：即使执行器有缺陷，也不会向 allowlist 之外发请求", () => {
  const p = plan();
  const inner = () => {
    const sent: ProviderRequest[] = [];
    return { sent, transport: { send: async (r: ProviderRequest) => (sent.push(r), { httpStatus: 200, body: new Uint8Array() }) } };
  };
  const body = (url: string) => new TextEncoder().encode(JSON.stringify({ url }));

  it("allowlist 内的请求放行（路径、async、url 都吻合）", async () => {
    const i = inner();
    const guard = new AllowlistTransport(i.transport, p.allowlist as never);
    await guard.send({ method: "POST", path: PROFILE_PATH, query: { async: "false" }, body: body(LOCATOR) });
    await guard.send({ method: "POST", path: LIST_PATH, query: { async: "false" }, body: bytesOf(`{"url":${JSON.stringify(LOCATOR)},"max_cursor":0}`) });
    expect(i.sent).toHaveLength(2);
  });

  it("其他 locator、其他 action、其他模式、其他路径、异步轮询（没有异步条目时）一律拒绝，且不会到达内层 transport", async () => {
    const i = inner();
    const guard = new AllowlistTransport(i.transport, p.allowlist as never);
    const bad: ProviderRequest[] = [
      { method: "POST", path: PROFILE_PATH, query: { async: "false" }, body: body("https://v.douyin.com/OTHER/") },
      { method: "POST", path: "/openapi/v1/media_stats_number", query: { async: "false" }, body: body(LOCATOR) },
      { method: "POST", path: PROFILE_PATH, query: { async: "true" }, body: body(LOCATOR) },
      { method: "POST", path: "/openapi/v1/anything", query: {}, body: body(LOCATOR) },
      { method: "GET", path: POLL_PATH, query: {}, body: null },
      { method: "POST", path: PROFILE_PATH, query: { async: "false" }, body: null },
      { method: "POST", path: PROFILE_PATH, query: { async: "false" }, body: bytesOf("not json") },
    ];
    for (const r of bad) await expect(guard.send(r)).rejects.toThrow("allowlist");
    expect(i.sent).toHaveLength(0);
  });
});
