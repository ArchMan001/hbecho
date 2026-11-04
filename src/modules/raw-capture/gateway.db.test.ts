// 任务 3：raw-before-parse ProviderCall 纵向链路（R2、R13.9、R14、R18；acceptance H1–H5、J2–J4、A6）。
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../../tests/harness/actors";
import { MemoryAuditSink } from "../../../tests/harness/audit";
import { bytesOf, envelope } from "../../../tests/harness/decode-helpers";
import { resetData, useTestDb } from "../../../tests/harness/db";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../tests/harness/fake-oss";
import { FixtureTransport } from "../../../tests/harness/fixture-transport";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { seedOrg, seedSyncSettings } from "../../../tests/harness/seed";
import { odsPayloads, odsProviderCalls, ossObjects, syncTasks } from "../../db/schema";
import type { Db } from "../../db/client";
import { buildRequest, decodeProfile } from "../provider-adapter";
import { createTracerCommands } from "../tracer-command";
import {
  RawCaptureError,
  RawCaptureGateway,
  StaleFenceError,
  TransportFailure,
  callAndInterpret,
  interpretCaptured,
  pairLocatorWithAccount,
  recoverInFlightCalls,
  type CallSpec,
  type ExecuteOutcome,
} from "./index";

const START = new Date("2026-11-04T08:00:00.000Z");
const YEAR_MS = 365 * 24 * 3600 * 1000;
const LOCATOR = "https://v.douyin.com/MPOAlEqWpec/";
const PROFILE_PATH = "/openapi/v1/media_user_info";
const t = useTestDb();

class SimulatedCrash extends Error {}

async function setup(opts: { hooks?: ConstructorParameters<typeof RawCaptureGateway>[0]["hooks"]; policy?: ConstructorParameters<typeof RawCaptureGateway>[0]["policy"]; db?: Db } = {}) {
  await resetData(t.pool); // 同一用例里可以多次 setup（循环场景）
  const clock = new FakeClock(START);
  const store = new FakeObjectStore(clock);
  const transport = new FixtureTransport();
  const org = await seedOrg(t.db, clock.now());
  await seedSyncSettings(t.db, clock.now());
  const commands = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
  const { rootTaskId } = await commands.submit(
    { platform: "douyin", mediaStaffId: org.staffA.toString(), homeLocator: LOCATOR, idempotencyKey: "k" },
    serviceActor(),
  );
  const taskId = BigInt(rootTaskId);
  await t.db
    .update(syncTasks)
    .set({ status: "running", leaseOwner: "w1", leaseExpiresAt: new Date(START.getTime() + 60_000), fencingToken: 1n })
    .where(eq(syncTasks.taskId, taskId));
  const [task] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, taskId));
  const gateway = new RawCaptureGateway({
    db: opts.db ?? t.db,
    store,
    transport,
    clock,
    location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-test" },
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  const spec = (over: Partial<CallSpec> = {}): CallSpec => ({
    syncTaskId: taskId,
    fencingToken: 1n,
    platformId: task!.platformId,
    providerId: task!.providerId,
    attemptNo: 1,
    callSequence: 1,
    requestedAction: "media_user_info",
    expectedResponseAction: "media_user_info",
    request: buildRequest({ action: "media_user_info", mode: "synchronous", locator: LOCATOR }),
    ...over,
  });
  const serveProfile = (body = loadFixtureBytes("raw3.douyin.media_user_info"), httpStatus = 200) =>
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus, body });
  const callRows = () => t.db.select().from(odsProviderCalls).orderBy(odsProviderCalls.providerCallId);
  const payloadsOf = (callId: bigint) => t.db.select().from(odsPayloads).where(eq(odsPayloads.providerCallId, callId));
  return { clock, store, transport, gateway, spec, serveProfile, taskId, org, commands, callRows, payloadsOf };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const captured = (o: ExecuteOutcome) => {
  if (o.kind !== "captured") throw new Error(`期望 captured，实际 ${o.kind}`);
  return o;
};

describe("H1 / H2：先落 ODS 再发送，先落响应再解析", () => {
  it("发送前：请求 body 的准确字节已在私有 ODS，prepared→in_flight 已提交；响应后：完整字节落 ODS、校验、终态提交", async () => {
    const { gateway, spec, store, transport, callRows, payloadsOf, clock } = await setup();
    const body = loadFixtureBytes("raw3.douyin.media_user_info");
    let observedBeforeSend: { status: string; sendStarted: boolean; requestObjectOk: boolean } | null = null;
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, async (req) => {
      const [call] = await callRows();
      const [payload] = await payloadsOf(call!.providerCallId);
      const [obj] = await t.db.select().from(ossObjects);
      const stored = await store.get(obj!.objectKey);
      observedBeforeSend = {
        status: call!.callStatus,
        sendStarted: call!.sendStartedAt !== null,
        requestObjectOk: payload!.payloadRole === "request_body" && sha(stored!) === sha(req.body!) && Buffer.from(stored!).equals(Buffer.from(req.body!)),
      };
      clock.advance(1500); // 模拟 1.5 秒网络耗时
      return { httpStatus: 200, body };
    });

    const out = captured(await gateway.execute(spec()));
    expect(observedBeforeSend).toEqual({ status: "in_flight", sendStarted: true, requestObjectOk: true });
    expect(out.fenceValid).toBe(true);

    const [call] = await callRows();
    expect(call).toMatchObject({
      callStatus: "terminal",
      outcome: "succeeded",
      httpStatus: 200,
      requestedAction: "media_user_info",
      expectedResponseAction: "media_user_info",
      responseAction: "media_user_info",
      providerTaskId: "6a954bef25f71e00016485f6",
      providerTaskStatus: "succeeded",
      endpoint: "/openapi/v1/media_user_info?async=false",
      requestMethod: "POST",
      attemptNo: 1,
      callSequence: 1,
    });
    expect(Number(call!.elapsedSeconds)).toBe(1.5);
    expect(call!.expiresAt.getTime()).toBe(START.getTime() + YEAR_MS);

    const payloads = await payloadsOf(call!.providerCallId);
    expect(payloads.map((p) => p.payloadRole).sort()).toEqual(["request_body", "response_body"]);
    const resp = payloads.find((p) => p.payloadRole === "response_body")!;
    expect(resp.sha256.toString("hex")).toBe(sha(body));
    expect(resp.byteLength).toBe(BigInt(body.byteLength));
    expect(resp.parseStatus).toBe("not_attempted"); // 还没解析
    expect(resp.adapterVersion).toBeNull();
    expect(resp.expiresAt.getTime()).toBe(call!.expiresAt.getTime());
    expect(out.captured.responseSha256).toBe(sha(body));
  });

  it("请求意图写 ODS 失败 → 没有任何发送，也没有调用行或对象元数据（R2.5）", async () => {
    const { gateway, spec, store, transport, serveProfile, callRows } = await setup();
    serveProfile();
    store.inject((k) => k.includes("/request_body/"), "fail");
    await expect(gateway.execute(spec())).rejects.toMatchObject({ code: "request_intent_failed" });
    expect(transport.calls).toHaveLength(0);
    expect(await callRows()).toHaveLength(0);
    expect(await t.db.select().from(ossObjects)).toHaveLength(0);
  });

  it("请求被存储损坏/截断（读回校验不一致）同样视为意图未落地，不发送", async () => {
    for (const fault of ["corrupt", "truncate"] as const) {
      const { gateway, spec, store, transport, serveProfile } = await setup();
      serveProfile();
      store.inject((k) => k.includes("/request_body/"), fault);
      await expect(gateway.execute(spec())).rejects.toBeInstanceOf(RawCaptureError);
      expect(transport.calls).toHaveLength(0);
    }
  });

  it("响应写 ODS 失败 / 哈希不一致 / 截断 → decoder 与 projector 调用数为 0，调用进入 ambiguous 且无响应 payload（R2.5）", async () => {
    for (const fault of ["fail", "corrupt", "truncate"] as const) {
      const { gateway, spec, store, serveProfile, callRows, payloadsOf } = await setup();
      serveProfile();
      store.inject((k) => k.includes("/response_body/"), fault);
      let decoded = 0;
      let projected = 0;
      const r = await callAndInterpret(
        gateway,
        spec(),
        (bytes) => {
          decoded++;
          return decodeProfile("douyin", bytes);
        },
        async () => void projected++,
      );
      expect(r.exec.kind, fault).toBe("capture_failed");
      expect(r.interpreted).toBeUndefined();
      expect(decoded).toBe(0);
      expect(projected).toBe(0);
      const [call] = await callRows();
      expect(call).toMatchObject({ callStatus: "ambiguous", outcome: "ambiguous" });
      expect((await payloadsOf(call!.providerCallId)).map((p) => p.payloadRole)).toEqual(["request_body"]);
    }
  });

  it("正常路径 decode 与 project 各执行一次，project 只在 decoded 且 fence 有效时执行", async () => {
    const { gateway, spec, serveProfile } = await setup();
    serveProfile();
    let projected = 0;
    const r = await callAndInterpret(gateway, spec(), (b) => decodeProfile("douyin", b), async () => void projected++);
    expect(r.interpreted?.outcome.outcome).toBe("decoded");
    expect(projected).toBe(1);
  });
});

describe("H5 / R2.2：requested / expected / actual action 分列", () => {
  it("返回 action 与期望不一致：两值都保留，调用终态为 invalid_response，分类为 invalid_response", async () => {
    const { gateway, spec, serveProfile, callRows } = await setup();
    serveProfile(envelope("media_stats", "{}"));
    const out = captured(await gateway.execute(spec()));
    expect(out.captured.classification).toMatchObject({ category: "invalid_response", outcome: "invalid_response", retry: "none" });
    const [call] = await callRows();
    expect(call).toMatchObject({ outcome: "invalid_response", requestedAction: "media_user_info", expectedResponseAction: "media_user_info", responseAction: "media_stats" });
  });
});

describe("失败响应：HTTP 400 / 500 / result:null 走不同的重试策略（R13.9）", () => {
  it("每一类都被完整捕获为 terminal/http_error|succeeded，并给出各自的分类", async () => {
    const cases: Array<[string, number, Uint8Array, string, string]> = [
      ["400", 400, loadFixtureBytes("raw7.C19.http400"), "provider_request_rejected", "http_error"],
      ["500", 500, loadFixtureBytes("raw7.C20.http500"), "provider_validation_failed", "http_error"],
      ["result:null", 200, bytesOf('{"code":0,"data":{"task_id":"t","action":"media_user_info","status":"succeeded","result":null}}'), "provider_null_result", "succeeded"],
    ];
    for (const [name, status, body, category, outcome] of cases) {
      const { gateway, spec, serveProfile, callRows } = await setup();
      serveProfile(body, status);
      const out = captured(await gateway.execute(spec()));
      expect(out.captured.classification.category, name).toBe(category);
      const [call] = await callRows();
      expect(call, name).toMatchObject({ callStatus: "terminal", outcome, httpStatus: status });
    }
  });

  it("RESULT_VALIDATION_FAILED 重试：每次都是新的 ProviderCall（attempt_no 递增），原调用不被改写", async () => {
    const { gateway, spec, serveProfile, callRows, transport } = await setup();
    serveProfile(loadFixtureBytes("raw7.C20.http500"), 500);
    for (const attemptNo of [1, 2, 3]) captured(await gateway.execute(spec({ attemptNo })));
    const rows = await callRows();
    expect(rows.map((r) => [r.attemptNo, r.callSequence, r.outcome])).toEqual([[1, 1, "http_error"], [2, 1, "http_error"], [3, 1, "http_error"]]);
    expect(transport.calls).toHaveLength(3);
  });
});

describe("H4：传输失败（R2.4）", () => {
  it("已知未送达 → terminal/transport_error，错误证据先落 ODS（结构化 artifact）", async () => {
    const { gateway, spec, transport, callRows, payloadsOf, store } = await setup();
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new TransportFailure("connect_refused", "no", "connect ECONNREFUSED 10.0.0.1:443");
    });
    const out = await gateway.execute(spec());
    expect(out).toMatchObject({ kind: "transport_failed", callStatus: "terminal", failure: { kind: "connect_refused", delivered: "no" } });
    const [call] = await callRows();
    expect(call).toMatchObject({ callStatus: "terminal", outcome: "transport_error", transportError: { kind: "connect_refused", delivered: "no" } });
    expect(call!.responseReceivedAt).toBeNull();
    const err = (await payloadsOf(call!.providerCallId)).find((p) => p.payloadRole === "transport_error")!;
    expect(err).toBeDefined();
    const [obj] = await t.db.select().from(ossObjects).where(eq(ossObjects.ossObjectId, err.ossObjectId));
    const artifact = JSON.parse(Buffer.from((await store.get(obj!.objectKey))!).toString("utf8"));
    expect(artifact).toMatchObject({ kind: "connect_refused", delivered: "no" });
  });

  it("超时 / 连接重置（送达与否未知）→ ambiguous，transport_error 列与同 role payload 都在；响应中断的部分字节进入 artifact，不冒充完整响应", async () => {
    const { gateway, spec, transport, callRows, payloadsOf, store } = await setup();
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new TransportFailure("reset", "unknown", "socket hang up", { httpStatus: 200, partialBody: bytesOf('{"code":0,"da') });
    });
    const out = await gateway.execute(spec());
    expect(out).toMatchObject({ kind: "transport_failed", callStatus: "ambiguous" });
    const [call] = await callRows();
    expect(call).toMatchObject({ callStatus: "ambiguous", outcome: "ambiguous", transportError: { kind: "reset", delivered: "unknown" } });
    expect(call!.finishedAt).toBeNull();
    expect(call!.responseReceivedAt).toBeNull();
    const payloads = await payloadsOf(call!.providerCallId);
    expect(payloads.map((p) => p.payloadRole).sort()).toEqual(["request_body", "transport_error"]);
    const [obj] = await t.db.select().from(ossObjects).where(eq(ossObjects.ossObjectId, payloads.find((p) => p.payloadRole === "transport_error")!.ossObjectId));
    const artifact = JSON.parse(Buffer.from((await store.get(obj!.objectKey))!).toString("utf8"));
    expect(artifact.http_status).toBe(200);
    expect(Buffer.from(artifact.partial_body_base64, "base64").toString("utf8")).toBe('{"code":0,"da');
  });

  it("不是 TransportFailure 的意外异常按『送达未知』处理（安全侧），不会被当作未送达", async () => {
    const { gateway, spec, transport, callRows } = await setup();
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new Error("kaboom");
    });
    expect(await gateway.execute(spec())).toMatchObject({ kind: "transport_failed", callStatus: "ambiguous" });
    expect((await callRows())[0]).toMatchObject({ outcome: "ambiguous" });
  });

  it("传输错误 artifact 写 ODS 失败 → 调用进入 ambiguous，不分类、不重试（R2.4：先落证据再分类）", async () => {
    const { gateway, spec, transport, store, callRows } = await setup();
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new TransportFailure("connect_refused", "no", "refused");
    });
    store.inject((k) => k.includes("/transport_error/"), "fail");
    expect(await gateway.execute(spec())).toMatchObject({ kind: "capture_failed", stage: "transport_error" });
    expect((await callRows())[0]).toMatchObject({ callStatus: "ambiguous" });
  });

  it("H8 安全：认证头 / Cookie 不会出现在 ODS、调用元数据或错误 artifact 中", async () => {
    const { gateway, spec, transport, store, callRows } = await setup();
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new TransportFailure("tls", "no", "handshake failed; request headers: X-Api-Key: sk-SECRETVALUE, Authorization: Bearer TOPSECRET, Cookie: sid=abc");
    });
    await gateway.execute(spec());
    const everything = JSON.stringify(await callRows(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + store.keys().join(",");
    const blobs = await Promise.all(store.keys().map(async (k) => Buffer.from((await store.get(k))!).toString("utf8")));
    for (const text of [everything, ...blobs]) {
      expect(text).not.toMatch(/SECRETVALUE|TOPSECRET|sid=abc/i);
    }
  });
});

describe("A6 / R14.6：发送前封口 → terminal/not_sent，发送次数为 0", () => {
  it("prepared 提交后、发送前取消 → not_sent；只有 request payload", async () => {
    const { gateway, spec, serveProfile, transport, callRows, payloadsOf } = await setup({
      hooks: {
        afterPrepared: async () => {
          await t.db
            .update(syncTasks)
            .set({ status: "cancelled", fencingToken: 2n, leaseOwner: null, leaseExpiresAt: null, stopReason: "cancelled_by_actor", finishedAt: START })
            .where(eq(syncTasks.requestedAction, "resolve_account"));
        },
      },
    });
    serveProfile();
    expect(await gateway.execute(spec())).toMatchObject({ kind: "not_sent", reason: "cancelled" });
    expect(transport.calls).toHaveLength(0);
    const [call] = await callRows();
    expect(call).toMatchObject({ callStatus: "terminal", outcome: "not_sent" });
    expect(call!.sendStartedAt).toBeNull();
    expect((await payloadsOf(call!.providerCallId)).map((p) => p.payloadRole)).toEqual(["request_body"]);
  });

  it("fencing token 被更高的 token 取代（租约被接管）→ not_sent，原因 stale_fence", async () => {
    const { gateway, spec, serveProfile, transport, callRows } = await setup({
      hooks: { afterPrepared: async () => void (await t.db.update(syncTasks).set({ fencingToken: 5n }).where(eq(syncTasks.requestedAction, "resolve_account"))) },
    });
    serveProfile();
    expect(await gateway.execute(spec())).toMatchObject({ kind: "not_sent", reason: "stale_fence" });
    expect(transport.calls).toHaveLength(0);
    expect((await callRows())[0]).toMatchObject({ outcome: "not_sent" });
  });

  it("本地策略（预算 / 调用上限）封口 → not_sent，原因带 policy 前缀；不发送", async () => {
    const { gateway, spec, serveProfile, transport, callRows } = await setup({ policy: { check: async () => "budget_exhausted" } });
    serveProfile();
    expect(await gateway.execute(spec())).toMatchObject({ kind: "not_sent", reason: "policy:budget_exhausted" });
    expect(transport.calls).toHaveLength(0);
    expect((await callRows())[0]).toMatchObject({ outcome: "not_sent" });
  });

  it("准备阶段就已经陈旧：拒绝创建意图（StaleFenceError），不留调用行", async () => {
    const { gateway, spec, serveProfile, transport, callRows } = await setup();
    serveProfile();
    await expect(gateway.execute(spec({ fencingToken: 0n }))).rejects.toBeInstanceOf(StaleFenceError);
    expect(transport.calls).toHaveLength(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("租约已过期同样视为陈旧", async () => {
    const { gateway, spec, serveProfile, clock, callRows } = await setup();
    serveProfile();
    clock.advance(61_000);
    await expect(gateway.execute(spec())).rejects.toMatchObject({ reason: "lease_expired" });
    expect(await callRows()).toHaveLength(0);
  });
});

describe("H5 / H6 / R2.7：崩溃恢复、prepared 续发、ambiguous 与有界重发", () => {
  it("发送前崩溃：prepared 可安全续发，请求字节取自已落地的 ODS，且只发送一次", async () => {
    let crash = true;
    const { gateway, spec, serveProfile, transport, callRows } = await setup({
      hooks: { afterPrepared: async () => { if (crash) throw new SimulatedCrash("崩溃于 prepared 之后"); } },
    });
    serveProfile();
    await expect(gateway.execute(spec())).rejects.toBeInstanceOf(SimulatedCrash);
    expect(transport.calls).toHaveLength(0);
    const [call] = await callRows();
    expect(call).toMatchObject({ callStatus: "prepared" });

    crash = false;
    const out = captured(await gateway.resumePrepared(call!.providerCallId, 1n));
    expect(out.captured.httpStatus).toBe(200);
    expect(transport.calls).toHaveLength(1);
    expect(Buffer.from(transport.calls[0]!.request.body!).toString("utf8")).toBe(JSON.stringify({ url: LOCATOR }));
  });

  it("同一 (task, attempt, sequence) 再次 execute：已完成的付费效果不重复，直接从 ODS 取回已捕获结果", async () => {
    const { gateway, spec, serveProfile, transport, callRows } = await setup();
    serveProfile();
    const first = captured(await gateway.execute(spec()));
    const second = captured(await gateway.execute(spec()));
    expect(transport.calls).toHaveLength(1);
    expect(second.captured.providerCallId).toBe(first.captured.providerCallId);
    expect(Buffer.from(second.captured.responseBody).equals(Buffer.from(first.captured.responseBody))).toBe(true);
    expect(await callRows()).toHaveLength(1);
  });

  it("发送后、终态捕获前崩溃：调用停在 in_flight；恢复扫描把它标为 ambiguous；之后最多再发一次新调用", async () => {
    let crash = true;
    const { gateway, spec, serveProfile, transport, callRows, clock } = await setup({
      hooks: { afterNetwork: async () => { if (crash) throw new SimulatedCrash("崩溃于收到响应之后、落 ODS 之前"); } },
    });
    serveProfile();
    await expect(gateway.execute(spec())).rejects.toBeInstanceOf(SimulatedCrash);
    expect(transport.calls).toHaveLength(1);
    expect((await callRows())[0]).toMatchObject({ callStatus: "in_flight" });

    // 恢复前：同一调用被再次执行不会盲目重发
    expect(await gateway.execute(spec())).toMatchObject({ kind: "in_progress" });
    expect(transport.calls).toHaveLength(1);

    clock.advance(5 * 60_000);
    expect(await recoverInFlightCalls({ db: t.db, clock, olderThanMs: 60_000 })).toBe(1);
    const [original] = await callRows();
    expect(original).toMatchObject({ callStatus: "ambiguous", outcome: "ambiguous" });
    expect(original!.ambiguousAt).not.toBeNull();
    expect(await recoverInFlightCalls({ db: t.db, clock, olderThanMs: 60_000 })).toBe(0); // 幂等

    // 只读查询：允许一次新的 ProviderCall，原调用保持 ambiguous、不被改写
    crash = false;
    // 时钟已推进 5 分钟，原租约过期（陈旧 worker 不能发新调用）；接手的 worker 续租后继续
    await t.db.update(syncTasks).set({ leaseExpiresAt: new Date(clock.now().getTime() + 60_000) }).where(eq(syncTasks.requestedAction, "resolve_account"));
    const resent = captured(await gateway.resendAfterAmbiguous(original!.providerCallId, spec()));
    expect(resent.captured.providerCallId).not.toBe(original!.providerCallId);
    expect(transport.calls).toHaveLength(2);
    const rows = await callRows();
    expect(rows.map((r) => [r.attemptNo, r.callSequence, r.callStatus])).toEqual([[1, 1, "ambiguous"], [2, 1, "terminal"]]);
    expect(rows[0]).toEqual(original);
  });

  it("第二次又 ambiguous 后不再重发（同一逻辑效果因 ambiguous 最多重发 1 次）；有副作用的 action 不适用这条例外", async () => {
    const { gateway, spec, transport, callRows } = await setup();
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new TransportFailure("timeout", "unknown", "timed out");
    });
    const first = await gateway.execute(spec());
    if (first.kind !== "transport_failed") throw new Error("应为 ambiguous");
    const second = await gateway.resendAfterAmbiguous(first.providerCallId, spec());
    if (second.kind !== "transport_failed") throw new Error("应为 ambiguous");
    expect(transport.calls).toHaveLength(2);
    await expect(gateway.resendAfterAmbiguous(second.providerCallId, spec())).rejects.toMatchObject({ code: "ambiguous_resend_exhausted" });
    expect(transport.calls).toHaveLength(2);

    // 非只读 action：拒绝
    const { gateway: g2, spec: s2, transport: t2 } = await setup();
    t2.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      throw new TransportFailure("timeout", "unknown", "timed out");
    });
    const sideEffect = s2({ requestedAction: "create_something" });
    const r = await g2.execute(sideEffect);
    if (r.kind !== "transport_failed") throw new Error("应为 ambiguous");
    await expect(g2.resendAfterAmbiguous(r.providerCallId, sideEffect)).rejects.toMatchObject({ code: "ambiguous_resend_not_allowed" });
    void callRows;
  });

  it("只有 ambiguous 状态的调用才能触发重发", async () => {
    const { gateway, spec, serveProfile } = await setup();
    serveProfile();
    const ok = captured(await gateway.execute(spec()));
    await expect(gateway.resendAfterAmbiguous(ok.captured.providerCallId, spec())).rejects.toMatchObject({ code: "ambiguous_resend_not_allowed" });
    await expect(gateway.resendAfterAmbiguous(999999n, spec())).rejects.toMatchObject({ code: "call_not_found" });
  });
});

describe("R18：fencing、并发与事务边界", () => {
  it("发送后 fence 被取代：终态证据仍然落地（不可变观察），但结果标记 fenceValid=false，project 不会执行", async () => {
    const { gateway, spec, transport, callRows } = await setup();
    const body = loadFixtureBytes("raw3.douyin.media_user_info");
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, async () => {
      await t.db.update(syncTasks).set({ fencingToken: 9n }).where(eq(syncTasks.requestedAction, "resolve_account"));
      return { httpStatus: 200, body };
    });
    let projected = 0;
    const r = await callAndInterpret(gateway, spec(), (b) => decodeProfile("douyin", b), async () => void projected++);
    expect(r.exec).toMatchObject({ kind: "captured", fenceValid: false });
    expect(r.interpreted?.outcome.outcome).toBe("decoded"); // 证据可解释
    expect(projected).toBe(0); // 但陈旧 worker 不能发布
    expect((await callRows())[0]).toMatchObject({ callStatus: "terminal", outcome: "succeeded" });
  });

  it("J4 两个 worker 重放同一 logical effect：只有一个发送，两次尝试都可见（另一个得到 in_progress）", async () => {
    const { gateway, spec, serveProfile, transport, callRows } = await setup();
    serveProfile();
    const [a, b] = await Promise.all([gateway.execute(spec()), gateway.execute(spec())]);
    expect(transport.calls).toHaveLength(1);
    expect(await callRows()).toHaveLength(1);
    for (const k of [a.kind, b.kind]) expect(["captured", "in_progress"]).toContain(k);
    expect([a.kind, b.kind]).toContain("captured");
  });

  it("J2 网络 IO 期间没有打开的数据库事务", async () => {
    let active = 0;
    const spyDb = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: never, cfg: never) => {
            active++;
            try {
              return await (target.transaction as (f: unknown, c: unknown) => Promise<unknown>)(fn, cfg);
            } finally {
              active--;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    const { gateway, spec, transport } = await setup({ db: spyDb });
    const seen: number[] = [];
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, () => {
      seen.push(active);
      return { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.media_user_info") };
    });
    captured(await gateway.execute(spec()));
    expect(seen).toEqual([0]);
  });
});

describe("解释：先捕获、后解析，可重放且不覆盖旧 lineage（R2.6）", () => {
  it("解析后记录 ODS 引用、字节 SHA-256 与 Adapter 版本；用新版本重放得到新的 lineage，旧记录与 ODS 对象不变", async () => {
    const { gateway, spec, serveProfile, payloadsOf, store } = await setup();
    serveProfile();
    const out = captured(await gateway.execute(spec()));
    const objectsBefore = store.keys("ods/");

    const v1 = await interpretCaptured(t.db, out.captured, (b) => decodeProfile("douyin", b));
    expect(v1.lineage).toMatchObject({ providerCallId: out.captured.providerCallId, responseSha256: out.captured.responseSha256, adapterVersion: "aimaster-adapter.v1" });
    const resp = (await payloadsOf(out.captured.providerCallId)).find((p) => p.payloadRole === "response_body")!;
    expect(resp).toMatchObject({ parseStatus: "parsed", adapterVersion: "aimaster-adapter.v1" });

    const reloaded = await gateway.loadCaptured(out.captured.providerCallId);
    const v2 = await interpretCaptured(t.db, reloaded, (b) => {
      const r = decodeProfile("douyin", b);
      return { ...r, adapterVersion: "aimaster-adapter.v2" } as typeof r;
    });
    expect(v2.lineage.adapterVersion).toBe("aimaster-adapter.v2");
    expect(v2.lineage.responseSha256).toBe(v1.lineage.responseSha256);
    const resp2 = (await payloadsOf(out.captured.providerCallId)).find((p) => p.payloadRole === "response_body")!;
    expect(resp2.adapterVersion).toBe("aimaster-adapter.v1"); // 首次解释的 lineage 不被覆盖
    expect(store.keys("ods/")).toEqual(objectsBefore); // ODS 没有新增或改写
  });

  it("无法解析的响应：payload 标 invalid，保留原始字节与错误原因（不含载荷内容）", async () => {
    const { gateway, spec, serveProfile, payloadsOf } = await setup();
    serveProfile(bytesOf("<html>oops</html>"));
    const out = captured(await gateway.execute(spec()));
    const r = await interpretCaptured(t.db, out.captured, (b) => decodeProfile("douyin", b));
    expect(r.outcome.outcome).toBe("schema_drift");
    const resp = (await payloadsOf(out.captured.providerCallId)).find((p) => p.payloadRole === "response_body")!;
    expect(resp.parseStatus).toBe("invalid");
    expect(resp.parseError).toBe("schema_drift:invalid_json");
    expect(resp.parseError).not.toContain("html");
  });

  it("loadCaptured 重新读 ODS 并校验哈希：对象被篡改 → integrity_mismatch，decoder 不会被调用", async () => {
    const { gateway, spec, serveProfile, store, callRows } = await setup();
    serveProfile();
    const out = captured(await gateway.execute(spec()));
    const [obj] = await t.db
      .select()
      .from(ossObjects)
      .innerJoin(odsPayloads, eq(odsPayloads.ossObjectId, ossObjects.ossObjectId))
      .where(and(eq(odsPayloads.providerCallId, out.captured.providerCallId), eq(odsPayloads.payloadRole, "response_body")));
    store.tamper(obj!.oss_objects.objectKey, bytesOf("{}"));
    await expect(gateway.loadCaptured(out.captured.providerCallId)).rejects.toMatchObject({ code: "integrity_mismatch" });
    void callRows;
  });
});

describe("R3.7 / B9：locator 与账号 ID 必须来自同一条 captured terminal payload", () => {
  it("同一次调用：配对成功，locator 取自该调用已落地的请求字节", async () => {
    const { gateway, spec, serveProfile } = await setup();
    serveProfile();
    const out = captured(await gateway.execute(spec()));
    const interpreted = await interpretCaptured(t.db, out.captured, (b) => decodeProfile("douyin", b));
    const pair = pairLocatorWithAccount(out.captured, interpreted);
    expect(pair).toMatchObject({ providerCallId: out.captured.providerCallId, locator: LOCATOR, account: { namespace: "douyin.user_id", id: "HITACHI1" } });
  });

  it("跨调用拼接（A 的 locator + B 的账号 ID）被拒绝", async () => {
    const { gateway, spec, transport } = await setup();
    transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus: 200, body: loadFixtureBytes("raw3.douyin.media_user_info") });
    const a = captured(await gateway.execute(spec({ attemptNo: 1 })));
    const b = captured(await gateway.execute(spec({ attemptNo: 2 })));
    const interpretedB = await interpretCaptured(t.db, b.captured, (x) => decodeProfile("douyin", x));
    expect(() => pairLocatorWithAccount(a.captured, interpretedB)).toThrow(RawCaptureError);
  });

  it("账号 ID 不是有效值（缺失 / null / 非法）时不配对，也不产生任何半成品", async () => {
    const { gateway, spec, serveProfile } = await setup();
    serveProfile(envelope("media_user_info", '{"nickname":"n"}'));
    const out = captured(await gateway.execute(spec()));
    const interpreted = await interpretCaptured(t.db, out.captured, (b) => decodeProfile("douyin", b));
    expect(() => pairLocatorWithAccount(out.captured, interpreted)).toThrow(RawCaptureError);
  });
});
