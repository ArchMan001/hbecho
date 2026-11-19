import { describe, expect, it } from "vitest";
import { SmokeConfigError } from "../modules/smoke";
import { UnsupportedCapabilityError } from "../modules/provider-adapter";
import type { SyncWorkerConfig } from "./sync-config";
import { WorkerNotRunnableError, assertWorkerCanRun, buildAccountRunners, type RunnerWiringFactories } from "./sync-runner-wiring";

const cfg = (over: Partial<SyncWorkerConfig> = {}): SyncWorkerConfig => ({
  databaseUrl: "mysql://x",
  environment: "production",
  modes: { media_user_info: "synchronous", user_video_list: "synchronous" },
  demandModes: { media_stats_number: "synchronous", post_comments_list: "synchronous" },
  concurrency: 1,
  providerQps: 2,
  mediaConcurrency: 1,
  breaker: { failures: 10, cooldownMs: 1000 },
  batchBudget: { maxCalls: 100, maxPoints: 1000, yearMaxPoints: 3000000 },
  media: { tmpDir: "/tmp/m", maxBytes: 1000, batchMaxBytes: 10_000, capabilityUrl: "http://capability:8080" },
  actorId: "service:sync-worker",
  leaseMs: 60_000,
  graceMs: 1000,
  idlePollMs: 10,
  ...over,
});
const approveAll = { require: () => ({}) };
const approveNone = {
  require: (k: { platform: never; action: never; mode: never; environment: never }) => {
    throw new UnsupportedCapabilityError("disabled", k as never);
  },
};
const ENV = { AIMASTER_API_KEY: "k", AIMASTER_BASE_URL: "https://api.example.test", OSS_ACCESS_KEY_ID: "i", OSS_ACCESS_KEY_SECRET: "s", OSS_REGION: "cn-beijing", OSS_BUCKET_ODS: "hbecho-ods", OSS_BUCKET_MEDIA: "hbecho-media" };
const counting = () => {
  const calls = { store: 0, transport: 0 };
  const f: RunnerWiringFactories = {
    createStore: () => (calls.store++, {} as never),
    createMediaStore: () => (calls.store++, {} as never),
    createTransport: () => (calls.transport++, { send: async () => { throw new Error("不应发送") } }),
    sleep: async () => {},
    nowMs: () => 0,
  };
  return { calls, f };
};

describe("worker 启动守卫", () => {
  it("当前真实登记表：抖音 / 小红书 已批准（2026-11-12）→ 允许启动", () => {
    expect(() => assertWorkerCanRun(cfg())).not.toThrow();
  });

  it("没有任何已批准的 capability → 拒绝启动，说明原因（不是静默起一个只会写 failed 的 worker）", () => {
    expect(() => assertWorkerCanRun(cfg(), approveNone)).toThrow(WorkerNotRunnableError);
    expect(() => assertWorkerCanRun(cfg(), approveNone)).toThrow(/没有任何已批准的 capability/);
  });

  it("HBECHO_ENV=test：capability 只对应 fixture transport，真实装配拒绝（避免未经批准的付费调用）", () => {
    expect(() => assertWorkerCanRun(cfg({ environment: "test" }), approveAll)).toThrow(/fixture transport/);
  });

  it("production 且至少一个 tuple 已批准：通过", () => {
    expect(() => assertWorkerCanRun(cfg(), approveAll)).not.toThrow();
  });
});

describe("buildAccountRunners", () => {
  it("守卫先于 secret：被拒绝时不读环境变量、不构造 transport / OSS", () => {
    const { calls, f } = counting();
    expect(() => buildAccountRunners({ db: {} as never, clock: { now: () => new Date() }, cfg: cfg(), env: {}, gate: approveNone, factories: f })).toThrow(WorkerNotRunnableError);
    expect(calls).toEqual({ store: 0, transport: 0 });
  });

  it("secret 缺失：失败并只报变量名，不构造 transport / OSS", () => {
    const { calls, f } = counting();
    const run = () => buildAccountRunners({ db: {} as never, clock: { now: () => new Date() }, cfg: cfg(), env: { ...ENV, AIMASTER_API_KEY: "" }, gate: approveAll, factories: f });
    expect(run).toThrow(SmokeConfigError);
    expect(run).toThrow(/AIMASTER_API_KEY/);
    expect(calls).toEqual({ store: 0, transport: 0 });
  });

  it("媒资桶变量缺失：失败并只报变量名", () => {
    const { f } = counting();
    const run = () => buildAccountRunners({ db: {} as never, clock: { now: () => new Date() }, cfg: cfg(), env: { ...ENV, OSS_BUCKET_MEDIA: "" }, gate: approveAll, factories: f });
    expect(run).toThrow(/OSS_BUCKET_MEDIA/);
  });
  it("配置齐全且已批准：注册 fetch_profile、fetch_content_list 与按需的 fetch_content_detail、fetch_comments；构造阶段不发任何请求", () => {
    const { calls, f } = counting();
    const runners = buildAccountRunners({ db: {} as never, clock: { now: () => new Date() }, cfg: cfg(), env: ENV, gate: approveAll, factories: f });
    expect(Object.keys(runners).sort()).toEqual(["download_media", "fetch_comments", "fetch_content_detail", "fetch_content_list", "fetch_profile"]);
    expect(calls).toEqual({ store: 2, transport: 1 }); // ODS 桶与媒资桶各一个 store
  });
});
