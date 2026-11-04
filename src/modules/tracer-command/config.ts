import type { Environment, ExecutionMode } from "../provider-adapter";

/** 生产不写死同步或异步（R13.4）：每个 action 的模式由配置选择，再由 capability 门控放行。 */
export interface TracerConfig {
  environment: Environment;
  modes: { media_user_info: ExecutionMode; user_video_list: ExecutionMode };
  /** 根任务与幂等窗口的保留期；默认一年（R1.7、R2.8）。 */
  retentionMs?: number;
}

export const DEFAULT_CONFIG: TracerConfig = {
  environment: "test",
  modes: { media_user_info: "synchronous", user_video_list: "synchronous" },
};

export const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;
