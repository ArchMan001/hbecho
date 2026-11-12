// signals 的运行时配置（requirements SG-15、design §14 第 14 项）：环境变量 + zod，缺失即启动失败并一次列出所有缺项。
// 成本与并发类数值（并发、重试次数、租约、签名 URL 有效期、超时、扫描批量……）没有代码默认值：
// 起始值写在 design §14 的建议里，不当作合同，由运维按测试机实测填入 .env（C18：未决项不得被默认值静默冻结）。
import { z } from "zod";
import { parseEnabledCapabilities } from "./catalog";
import { SignalError } from "./errors";

const positiveInt = z.coerce.number().int().positive();

const schema = z.object({
  HBECHO_SIGNALS_SCAN_INTERVAL_MS: positiveInt,
  HBECHO_SIGNALS_SCAN_BATCH: positiveInt,
  HBECHO_SIGNALS_LOOKBACK_MS: positiveInt,
  HBECHO_SIGNALS_RECONCILE_INTERVAL_MS: positiveInt,
  HBECHO_SIGNALS_SCORE_CONCURRENCY: positiveInt,
  HBECHO_SIGNALS_TASK_MAX_ATTEMPTS: positiveInt,
  HBECHO_SIGNALS_RETRY_BACKOFF_MS: positiveInt,
  HBECHO_SIGNALS_LEASE_MS: positiveInt,
  HBECHO_SIGNALS_SIGNED_URL_TTL_S: positiveInt,
  HBECHO_SIGNALS_MATCH_TIMEOUT_MS: positiveInt,
  HBECHO_SIGNALS_DEFER_INTERVAL_MS: positiveInt,
  HBECHO_SIGNALS_DEFER_MAX: positiveInt,
  // 候选图大小上限沿用 A 的媒资上限（design §14 第 13 项）；与 sync worker 读同一个变量
  HBECHO_MEDIA_MAX_BYTES: positiveInt,
});

export interface SignalsConfig {
  scanIntervalMs: number;
  scanBatch: number;
  lookbackMs: number;
  reconcileIntervalMs: number;
  scoreConcurrency: number;
  taskMaxAttempts: number;
  /** 第 n 次失败后等待 retryBackoffMs × 2^(n-1) 再重试。 */
  retryBackoffMs: number;
  leaseMs: number;
  signedUrlTtlSeconds: number;
  matchTimeoutMs: number;
  deferIntervalMs: number;
  deferMax: number;
  mediaMaxBytes: number;
  /** 启用的能力标识（目录里的标识）；缺省只含文本类。 */
  enabled: ReadonlySet<string>;
}

export function parseSignalsConfig(env: Record<string, string | undefined>): SignalsConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    const problems = r.error.issues.map((i) => {
      const name = String(i.path[0] ?? "");
      return { name, problem: env[name] === undefined || env[name] === "" ? ("missing" as const) : ("invalid" as const), message: i.message };
    });
    throw new SignalError("configuration", "config_invalid", `启动失败，配置不合法：${problems.map((p) => `${p.name}（${p.problem === "missing" ? "缺失" : "非法"}）`).join("、")}`, problems);
  }
  const e = r.data;
  if (e.HBECHO_SIGNALS_LEASE_MS <= e.HBECHO_SIGNALS_MATCH_TIMEOUT_MS) {
    // 任务 runner 在一次能力服务调用期间不续租约；租约不比调用超时长，调用还没返回租约就过期，会被别的 worker 接手而重复计算
    throw new SignalError("configuration", "lease_shorter_than_match_timeout", "HBECHO_SIGNALS_LEASE_MS 必须大于 HBECHO_SIGNALS_MATCH_TIMEOUT_MS");
  }
  return {
    scanIntervalMs: e.HBECHO_SIGNALS_SCAN_INTERVAL_MS,
    scanBatch: e.HBECHO_SIGNALS_SCAN_BATCH,
    lookbackMs: e.HBECHO_SIGNALS_LOOKBACK_MS,
    reconcileIntervalMs: e.HBECHO_SIGNALS_RECONCILE_INTERVAL_MS,
    scoreConcurrency: e.HBECHO_SIGNALS_SCORE_CONCURRENCY,
    taskMaxAttempts: e.HBECHO_SIGNALS_TASK_MAX_ATTEMPTS,
    retryBackoffMs: e.HBECHO_SIGNALS_RETRY_BACKOFF_MS,
    leaseMs: e.HBECHO_SIGNALS_LEASE_MS,
    signedUrlTtlSeconds: e.HBECHO_SIGNALS_SIGNED_URL_TTL_S,
    matchTimeoutMs: e.HBECHO_SIGNALS_MATCH_TIMEOUT_MS,
    deferIntervalMs: e.HBECHO_SIGNALS_DEFER_INTERVAL_MS,
    deferMax: e.HBECHO_SIGNALS_DEFER_MAX,
    mediaMaxBytes: e.HBECHO_MEDIA_MAX_BYTES,
    enabled: parseEnabledCapabilities(env.HBECHO_SIGNALS_ENABLED),
  };
}
