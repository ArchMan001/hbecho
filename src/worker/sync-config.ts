// worker 的运行时配置（design §10）：环境变量 + zod，缺失即启动失败并**一次列出所有缺项**。
// 花钱的上限（并发、QPS、熔断阈值、批次点数 / 调用数）没有默认值（C18：未决项不得被默认值静默冻结）。
// 租约、宽限期、空闲轮询间隔只影响恢复速度，不影响花费，所以有默认值。
import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();
const positive = z.coerce.number().positive().finite();
const mode = z.enum(["synchronous", "asynchronous"]);

const schema = z.object({
  HBECHO_DATABASE_URL: z.string().min(1),
  // staging 没有任何 capability 行（tracer 起只有 test + production），启动后所有任务都会被拒绝；这里直接不允许。
  HBECHO_ENV: z.enum(["test", "production"]).default("production"),
  HBECHO_SYNC_PROFILE_MODE: mode,
  HBECHO_SYNC_LIST_MODE: mode,
  // 按需采集的详情 / 评论模式：同样不写死（按已验证 capability 配置）
  HBECHO_SYNC_DETAIL_MODE: mode,
  HBECHO_SYNC_COMMENTS_MODE: mode,
  HBECHO_SYNC_CONCURRENCY: positiveInt,
  HBECHO_SYNC_PROVIDER_QPS: positive,
  HBECHO_SYNC_MEDIA_CONCURRENCY: positiveInt,
  HBECHO_SYNC_BREAKER_FAILURES: positiveInt,
  HBECHO_SYNC_BREAKER_COOLDOWN_MS: z.coerce.number().int().nonnegative(),
  HBECHO_SYNC_BATCH_MAX_CALLS: positiveInt,
  HBECHO_SYNC_BATCH_MAX_POINTS: positiveInt,
  HBECHO_ACTOR_ID: z.string().min(1).default("service:sync-worker"),
  HBECHO_SYNC_LEASE_MS: positiveInt.default(120_000),
  HBECHO_SYNC_GRACE_MS: z.coerce.number().int().nonnegative().default(30_000),
  HBECHO_SYNC_IDLE_POLL_MS: positiveInt.default(5_000),
});

export interface SyncWorkerConfig {
  databaseUrl: string;
  environment: "test" | "production";
  modes: { media_user_info: "synchronous" | "asynchronous"; user_video_list: "synchronous" | "asynchronous" };
  /** 按需采集：详情（media_stats_number）与评论（post_comments_list）的执行模式。 */
  demandModes: { media_stats_number: "synchronous" | "asynchronous"; post_comments_list: "synchronous" | "asynchronous" };
  concurrency: number;
  providerQps: number;
  mediaConcurrency: number;
  breaker: { failures: number; cooldownMs: number };
  batchBudget: { maxCalls: number; maxPoints: number };
  actorId: string;
  leaseMs: number;
  graceMs: number;
  idlePollMs: number;
}

export class SyncConfigError extends Error {
  constructor(readonly problems: Array<{ name: string; problem: "missing" | "invalid"; message: string }>) {
    super(`启动失败，配置不合法：${problems.map((p) => `${p.name}（${p.problem === "missing" ? "缺失" : "非法"}）`).join("、")}`);
    this.name = "SyncConfigError";
  }
}

export function parseSyncWorkerConfig(env: Record<string, string | undefined>): SyncWorkerConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new SyncConfigError(
      r.error.issues.map((i) => {
        const name = String(i.path[0] ?? "");
        const absent = env[name] === undefined || env[name] === "";
        return { name, problem: absent ? ("missing" as const) : ("invalid" as const), message: i.message };
      }),
    );
  }
  const e = r.data;
  return {
    databaseUrl: e.HBECHO_DATABASE_URL,
    environment: e.HBECHO_ENV,
    modes: { media_user_info: e.HBECHO_SYNC_PROFILE_MODE, user_video_list: e.HBECHO_SYNC_LIST_MODE },
    demandModes: { media_stats_number: e.HBECHO_SYNC_DETAIL_MODE, post_comments_list: e.HBECHO_SYNC_COMMENTS_MODE },
    concurrency: e.HBECHO_SYNC_CONCURRENCY,
    providerQps: e.HBECHO_SYNC_PROVIDER_QPS,
    mediaConcurrency: e.HBECHO_SYNC_MEDIA_CONCURRENCY,
    breaker: { failures: e.HBECHO_SYNC_BREAKER_FAILURES, cooldownMs: e.HBECHO_SYNC_BREAKER_COOLDOWN_MS },
    batchBudget: { maxCalls: e.HBECHO_SYNC_BATCH_MAX_CALLS, maxPoints: e.HBECHO_SYNC_BATCH_MAX_POINTS },
    actorId: e.HBECHO_ACTOR_ID,
    leaseMs: e.HBECHO_SYNC_LEASE_MS,
    graceMs: e.HBECHO_SYNC_GRACE_MS,
    idlePollMs: e.HBECHO_SYNC_IDLE_POLL_MS,
  };
}
