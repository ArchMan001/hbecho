// 环境变量（JP-19）：数值类配置**没有代码默认值**，缺任一项启动失败并指出缺哪一项。起始建议值写在 .env.example 与 design §14 第 22 项，不是合同。
import { JudgementError } from "./errors";

const KEYS = {
  blockSize: "HBECHO_JP_BLOCK_SIZE",
  signalBatch: "HBECHO_JP_SIGNAL_BATCH",
  demandBatch: "HBECHO_JP_DEMAND_BATCH",
  pollSeconds: "HBECHO_JP_POLL_SECONDS",
  waitSignalSeconds: "HBECHO_JP_WAIT_SIGNAL_SECONDS",
  waitDemandSeconds: "HBECHO_JP_WAIT_DEMAND_SECONDS",
  waitCollectSeconds: "HBECHO_JP_WAIT_COLLECT_SECONDS", // 执行前等待参与账号的列表采集完成的上限（d-wait-collection，建议 3600）
  leaseSeconds: "HBECHO_JP_LEASE_SECONDS",
  tickBudgetMs: "HBECHO_JP_TICK_BUDGET_MS",
  phaseMaxAttempts: "HBECHO_JP_PHASE_MAX_ATTEMPTS",
  maxItems: "HBECHO_JP_MAX_ITEMS",
  maxKeywordLength: "HBECHO_JP_MAX_KEYWORD_LENGTH",
  trialRetentionDays: "HBECHO_JP_TRIAL_RETENTION_DAYS",
  keepContentRuns: "HBECHO_JP_KEEP_CONTENT_RUNS",
  failedRetentionDays: "HBECHO_JP_FAILED_RETENTION_DAYS",
} as const;
export type JudgementConfig = { [K in keyof typeof KEYS]: number };
export const JUDGEMENT_ENV_KEYS: readonly string[] = Object.values(KEYS);
/** 等待上限允许为 0（所有「在等」的依赖立即记 dependency_timeout）；其余必须是正整数。 */
const ALLOW_ZERO: ReadonlySet<keyof typeof KEYS> = new Set(["waitSignalSeconds", "waitDemandSeconds", "waitCollectSeconds"]);
/** C 与 A 的单次上限。 */
const BATCH_CEILING = 5000;

export function parseJudgementEnv(env: Record<string, string | undefined>): JudgementConfig {
  const missing: string[] = [];
  const invalid: string[] = [];
  const out = {} as Record<string, number>;
  for (const [k, name] of Object.entries(KEYS)) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") {
      missing.push(name);
      continue;
    }
    const n = Number(raw);
    const min = ALLOW_ZERO.has(k as keyof typeof KEYS) ? 0 : 1;
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min) invalid.push(name);
    else out[k] = n;
  }
  for (const k of ["signalBatch", "demandBatch"] as const) if (out[k] !== undefined && out[k]! > BATCH_CEILING) invalid.push(`${KEYS[k]}（不得超过 ${BATCH_CEILING}）`);
  if (missing.length) throw new JudgementError("configuration", "config_missing", `缺少配置：${missing.join("、")}`, { missing });
  if (invalid.length) throw new JudgementError("configuration", "config_invalid", `配置取值不合法：${invalid.join("、")}`, { invalid });
  return out as JudgementConfig;
}
