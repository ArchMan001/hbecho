// D 的真实装配件（进程入口共用）：`pnpm judgement`（judgement-main）与 `pnpm plan`（plan-main 的下游端口）都用它。
// 环境变量只在这里读；D 自己不读任何 secret（JP-19）。C 的数值配置与 OSS / 能力服务按「用到才读」处理：
// 缺 OSS 桶或能力服务时，用到它们的命令报「未配置」，不用它们的命令照常；C 的数值配置缺项则装配失败并点名。
import type { Logger } from "pino";
import type { Db } from "../db/client";
import { createAuditWriter, createAccessServices, defaultRegistry, fromSyncAudit, type AuthContext } from "../modules/access-control";
import type { PlanDownstream } from "../modules/activity-plan/downstream";
import { createPlanReader } from "../modules/activity-plan/reader";
import { createDemandModule } from "../modules/demand";
import { HttpCapabilityClient } from "../modules/media-archive";
import { createMonitoringResolver } from "../modules/monitoring";
import { createJudgement } from "../modules/judgement/assemble";
import { createJudgementAudit } from "../modules/judgement/audit";
import { createJudgementDownstream } from "../modules/judgement/downstream";
import { parseJudgementEnv } from "../modules/judgement/env";
import { JudgementError } from "../modules/judgement/errors";
import { realDemandPort, realSignalsPort } from "../modules/judgement/real-ports";
import { OssObjectStore } from "../modules/raw-capture";
import { readOssSecrets } from "../modules/smoke";
import { createLogSyncAuditSink } from "../modules/sync-schedule";
import { CAP_SEGMENT_MANAGE, createLogAudit, createSignals, HttpImageMatcher, parseSignalsConfig, SERVICE_ACTOR, SignalError, type SignalActor, type SignalsDeps } from "../modules/signals";

type Env = Record<string, string | undefined>;
const clock = { now: () => new Date() };

/** 用到才报「未配置」的占位：不依赖它的命令不该因为它没配而无法使用。 */
const unconfigured = <T extends object>(what: string): T =>
  new Proxy({}, { get: () => () => { throw new SignalError("configuration", "not_configured", `${what} 未配置`); } }) as T;
const attempt = <T extends object>(what: string, build: () => T): T => {
  try {
    return build();
  } catch {
    return unconfigured<T>(what);
  }
};
const bucket = (env: Env, name: string): string => {
  const v = env[name]?.trim();
  if (!v || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v)) throw new Error(`环境变量 ${name} 缺失或不合法`);
  return v;
};

/** C 的真实装配：数值配置必须齐（缺项抛出并点名），OSS 与能力服务各自缺则各自「未配置」。 */
export function buildSignals(deps: { db: Db; env: Env; logger: Logger }) {
  const { db, env } = deps;
  const config = parseSignalsConfig(env);
  const signalsBucket = (() => {
    try {
      return bucket(env, "OSS_BUCKET_SIGNALS");
    } catch {
      return "unconfigured";
    }
  })();
  const baseUrl = (): string => env.HBECHO_CAPABILITY_URL?.trim() || (() => { throw new Error("HBECHO_CAPABILITY_URL 缺失"); })();
  return createSignals({
    db,
    clock,
    audit: createLogAudit(deps.logger),
    config,
    mediaStore: attempt("media 桶", () => new OssObjectStore({ ...readOssSecrets({ ...env, OSS_BUCKET_ODS: bucket(env, "OSS_BUCKET_MEDIA") }) })),
    signalsStore: attempt("hbecho-signals 桶", () => new OssObjectStore(readOssSecrets({ ...env, OSS_BUCKET_ODS: bucket(env, "OSS_BUCKET_SIGNALS") }))),
    signalsBucket,
    converter: attempt<SignalsDeps["converter"]>("能力服务", () => new HttpCapabilityClient({ baseUrl: baseUrl() })),
    matcher: attempt<SignalsDeps["matcher"]>("能力服务", () => new HttpImageMatcher({ baseUrl: baseUrl(), timeoutMs: config.matchTimeoutMs })),
  });
}

/** 清除监控段用的身份：C 自己的服务身份 + 只带「监控段管理」；不经用户范围（清除由每日维护触发，没有提交人）。 */
export const PURGE_ACTOR: SignalActor = { actor: SERVICE_ACTOR, capabilities: new Set([CAP_SEGMENT_MANAGE]), brandScope: "all" };

/** A 的下游端口（`pnpm plan` 用）：C 的配置在 purge 真正被调用时才装配，缺项则 purge 抛出，A 保守不清除、计划留在回收站。 */
export function buildJudgementDownstream(deps: { db: Db; env: Env; logger: Logger }): PlanDownstream {
  const { db } = deps;
  let segments: ReturnType<typeof buildSignals>["segments"] | null = null;
  return createJudgementDownstream({
    db,
    purgeActor: PURGE_ACTOR,
    audit: createJudgementAudit(createAuditWriter({ db, clock, logger: deps.logger })),
    signals: { purge: (a, id) => (segments ??= buildSignals(deps).segments).purge(a, id) },
  });
}

/** `HBECHO_JP_ACTOR=user:<id>`：CLI 以真实用户的身份操作，服务身份不行。 */
export function actorUserId(env: Env): bigint {
  const raw = env.HBECHO_JP_ACTOR?.trim();
  if (!raw) throw new JudgementError("configuration", "actor_missing", "缺少 HBECHO_JP_ACTOR（user:<数字 ID>）");
  const m = /^user:([1-9]\d{0,18})$/.exec(raw);
  if (!m) throw new JudgementError("configuration", "actor_invalid", "HBECHO_JP_ACTOR 必须是 user:<数字 ID>（CLI 以真实用户的身份操作，没有服务身份和自带权限的环境变量）");
  return BigInt(m[1]!);
}

/** D 的完整真实装配。`strict` = serve：A 的需求运行模式缺失即失败；其它命令缺它时，用到需求的路径才报「未配置」。 */
export function buildJudgementRuntime(deps: { db: Db; env: Env; logger: Logger; strict: boolean }) {
  const { db, env, logger } = deps;
  const config = parseJudgementEnv(env);
  const auditWriter = createAuditWriter({ db, clock, logger });
  const access = createAccessServices({ db, clock, audit: auditWriter, logger });
  const signals = buildSignals(deps);
  const modes = { media_stats_number: env.HBECHO_SYNC_DETAIL_MODE, post_comments_list: env.HBECHO_SYNC_COMMENTS_MODE };
  const isMode = (v: string | undefined): v is "synchronous" | "asynchronous" => v === "synchronous" || v === "asynchronous";
  const environment = env.HBECHO_ENV === "test" ? "test" : "production"; // 缺省 production（fail closed）
  let demand;
  if (isMode(modes.media_stats_number) && isMode(modes.post_comments_list)) {
    demand = realDemandPort(createDemandModule({ db, clock, runtime: { environment, modes: { media_stats_number: modes.media_stats_number, post_comments_list: modes.post_comments_list } }, audit: fromSyncAudit(auditWriter, createLogSyncAuditSink(logger)) }));
  } else if (deps.strict) {
    throw new JudgementError("configuration", "config_missing", "serve 需要 HBECHO_SYNC_DETAIL_MODE 与 HBECHO_SYNC_COMMENTS_MODE（synchronous | asynchronous）");
  } else {
    demand = unconfigured<ReturnType<typeof realDemandPort>>("A 的需求运行模式（HBECHO_SYNC_DETAIL_MODE / HBECHO_SYNC_COMMENTS_MODE）");
  }
  const judgement = createJudgement({
    db,
    clock,
    reader: createPlanReader({ db, resolver: createMonitoringResolver(db) }),
    signals: realSignalsPort(signals),
    demand,
    resolver: access.resolver,
    authorizer: access.authorizer,
    registry: defaultRegistry,
    auditWriter,
    config,
  });
  /** CLI 身份：用该用户**当前**的 AuthContext，走与页面相同的 authorize；用户不是有效用户就拒绝。 */
  async function contextOfActor(): Promise<AuthContext> {
    const r = await access.resolver.contextForUser(actorUserId(env), null);
    if (!r.ok) throw new JudgementError("authorization", "actor_not_active", `HBECHO_JP_ACTOR 对应的用户不是有效用户（${r.reason}）`);
    return r.ctx;
  }
  return { judgement, config, contextOfActor };
}
