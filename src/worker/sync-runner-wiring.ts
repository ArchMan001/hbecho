// worker 命令的 Runner 装配（任务 5）：把真实的 AI Master transport、OSS 和批次预算接到 fetch_profile / fetch_content_list。
//
// 启动守卫（assertWorkerCanRun）先于读任何 secret：
//  - `test` 环境的 capability 只对应 fixture transport，不代表可以访问真实供应商，所以真实装配拒绝 HBECHO_ENV=test；
//  - `production` 环境里至少要有一个已批准（activation=approved）的 tuple，否则整个周期批次的任务都会被写成
//    failed/capability_disabled，批次终态变成 failed——看起来像一次真实故障。当前 production 全部 disabled，
//    启用需要任务 11 的批准式 smoke 与单独的人工批准，所以现在真实 worker 不会启动。
// 只有 `worker` / `run-once` 命令装配它；tick、status 等运营命令不读 secret。
import type { Db } from "../db/client";
import { DEFAULT_ASYNC } from "../modules/tracer-command";
import { UnsupportedCapabilityError, capabilityGate, type AiMasterAction, type ExecutionMode, type Platform } from "../modules/provider-adapter";
import { HttpProviderTransport, OssObjectStore, RawCaptureGateway, type Clock, type ObjectStore, type ProviderTransport } from "../modules/raw-capture";
import { readSmokeSecrets, type SmokeSecrets } from "../modules/smoke";
import { createAccountRunners, createBatchBudgetPolicy, createDemandRunners, type RunnerRegistry } from "../modules/sync-runner";
import type { SyncWorkerConfig } from "./sync-config";
import { createTokenBucket, rateLimitedTransport } from "./token-bucket";

export class WorkerNotRunnableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerNotRunnableError";
  }
}

const PLATFORMS: readonly Platform[] = ["douyin", "xiaohongshu", "kuaishou"];
interface Gate {
  require(key: { platform: Platform; action: AiMasterAction; mode: ExecutionMode; environment: SyncWorkerConfig["environment"] }): unknown;
}

export function assertWorkerCanRun(cfg: Pick<SyncWorkerConfig, "environment" | "modes">, gate: Gate = capabilityGate): void {
  if (cfg.environment !== "production") {
    throw new WorkerNotRunnableError("HBECHO_ENV=test 的 capability 只对应 fixture transport，真实 worker（真实 transport / OSS）只在 production 运行；离线验证请用测试挂具");
  }
  const approved = PLATFORMS.flatMap((platform) =>
    (["media_user_info", "user_video_list"] as const).filter((action) => {
      try {
        gate.require({ platform, action, mode: cfg.modes[action], environment: cfg.environment });
        return true;
      } catch (e) {
        if (e instanceof UnsupportedCapabilityError) return false;
        throw e;
      }
    }),
  );
  if (approved.length === 0) {
    throw new WorkerNotRunnableError(
      `${cfg.environment} 环境没有任何已批准的 capability（主页 ${cfg.modes.media_user_info} / 列表 ${cfg.modes.user_video_list}）：启动后整个批次的任务都会 failed/capability_disabled。启用需要任务 11 的批准式 smoke 与单独的人工批准`,
    );
  }
}

export interface RunnerWiringFactories {
  createStore(oss: SmokeSecrets["oss"]): ObjectStore;
  createTransport(input: { apiKey: string; baseUrl: string }): ProviderTransport;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
}
export const defaultRunnerFactories = (): RunnerWiringFactories => ({
  createStore: (oss) => new OssObjectStore(oss),
  createTransport: ({ apiKey, baseUrl }) => new HttpProviderTransport({ baseUrl, apiKey }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  nowMs: () => Date.now(),
});

export function buildAccountRunners(o: {
  db: Db;
  clock: Clock;
  cfg: SyncWorkerConfig;
  env: Record<string, string | undefined>;
  gate?: Gate;
  factories?: RunnerWiringFactories;
}): RunnerRegistry {
  assertWorkerCanRun(o.cfg, o.gate); // 先于读 secret
  const f = o.factories ?? defaultRunnerFactories();
  const secrets = readSmokeSecrets(o.env); // 缺失即失败，错误只报变量名
  const bucket = createTokenBucket({ ratePerSec: o.cfg.providerQps, nowMs: f.nowMs, sleep: f.sleep });
  const gateway = new RawCaptureGateway({
    db: o.db,
    store: f.createStore(secrets.oss),
    transport: rateLimitedTransport(f.createTransport({ apiKey: secrets.apiKey, baseUrl: secrets.baseUrl }), bucket),
    clock: o.clock,
    location: { providerCode: "aliyun-oss", region: secrets.oss.region, bucket: secrets.oss.bucket },
    policy: createBatchBudgetPolicy(o.db, { maxCalls: o.cfg.batchBudget.maxCalls, maxPoints: o.cfg.batchBudget.maxPoints }),
  });
  const deps = { db: o.db, clock: o.clock, gateway, environment: o.cfg.environment, sleep: f.sleep, async: DEFAULT_ASYNC };
  return Object.freeze({ ...createAccountRunners(deps), ...createDemandRunners(deps) });
}
