import type { Environment, ExecutionMode } from "../provider-adapter";

/** 生产不写死同步或异步（R13.4）：每个 action 的模式由配置选择，再由 capability 门控放行。 */
export interface TracerConfig {
  environment: Environment;
  modes: { media_user_info: ExecutionMode; user_video_list: ExecutionMode };
  /** 根任务与幂等窗口的保留期；默认一年（R1.7、R2.8）。 */
  retentionMs?: number;
  /** 退避：第 n 次失败后等待 min(max, base × 2^(n-1))。限流 / 5xx / 已知未送达的传输失败才退避。 */
  retry?: { baseBackoffMs: number; maxBackoffMs: number };
  /** 异步任务轮询：间隔、最多轮询次数、最长等待（间隔 × 次数）。供应商任务 TTL 与合适间隔未实测（任务 9 smoke），所以是配置，不是合同。 */
  async?: { pollIntervalMs: number; maxPolls: number; maxWaitMs: number };
  /** 根任务的总截止时间（从接受命令起算）。 */
  rootDeadlineMs?: number;
}

export const DEFAULT_CONFIG: TracerConfig = {
  environment: "test",
  modes: { media_user_info: "synchronous", user_video_list: "synchronous" },
};

export const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

export const DEFAULT_RETRY = { baseBackoffMs: 5_000, maxBackoffMs: 300_000 } as const;
export const DEFAULT_ASYNC = { pollIntervalMs: 2_000, maxPolls: 30, maxWaitMs: 120_000 } as const;
export const DEFAULT_ROOT_DEADLINE_MS = 24 * 3600 * 1000;
