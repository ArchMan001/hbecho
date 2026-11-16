// D 的真实装配件（进程入口共用）。现在只有 A 的下游端口：`pnpm plan` 的 maintain / delete 用它。
// 清除要调 C 的 segments.purge，所以要 C 的数值配置与 signals 桶；这些**用到才读**——`plan` 的其它命令与预览不需要它们，
// 缺项时 purge 抛出，A 不清除活动计划、留在回收站等下一次维护（失败即保守）。
// 其余 C 的依赖（media 桶、能力服务、图像匹配）purge 用不到，给「未配置」占位。
import type { Db } from "../db/client";
import type { PlanDownstream } from "../modules/activity-plan/downstream";
import { createJudgementDownstream } from "../modules/judgement/downstream";
import { OssObjectStore } from "../modules/raw-capture";
import { readOssSecrets } from "../modules/smoke";
import { CAP_SEGMENT_MANAGE, createLogAudit, createSignals, parseSignalsConfig, SERVICE_ACTOR, SignalError, type SignalActor } from "../modules/signals";

const unconfigured = <T extends object>(what: string): T =>
  new Proxy({}, { get: () => () => { throw new SignalError("configuration", "not_configured", `${what} 未配置`); } }) as T;

/** 清除监控段用的身份：C 自己的服务身份 + 只带「监控段管理」；不经用户范围（清除由每日维护触发，没有提交人）。 */
export const PURGE_ACTOR: SignalActor = { actor: SERVICE_ACTOR, capabilities: new Set([CAP_SEGMENT_MANAGE]), brandScope: "all" };

export function buildJudgementDownstream(deps: { db: Db; env: Record<string, string | undefined>; logger: { info(o: object, m?: string): void } }): PlanDownstream {
  const { db, env } = deps;
  let segments: ReturnType<typeof createSignals>["segments"] | null = null;
  const build = () => {
    const config = parseSignalsConfig(env);
    const signalsBucket = env.OSS_BUCKET_SIGNALS?.trim();
    if (!signalsBucket) throw new SignalError("configuration", "not_configured", "OSS_BUCKET_SIGNALS 未配置");
    const oss = readOssSecrets({ ...env, OSS_BUCKET_ODS: signalsBucket }); // 复用凭证与区域校验；桶名换成 signals 桶
    return createSignals({
      db,
      clock: { now: () => new Date() },
      audit: createLogAudit(deps.logger as never),
      config,
      mediaStore: unconfigured("media 桶"),
      signalsStore: new OssObjectStore(oss),
      signalsBucket,
      converter: unconfigured("能力服务"),
      matcher: unconfigured("能力服务"),
    }).segments;
  };
  return createJudgementDownstream({ db, purgeActor: PURGE_ACTOR, signals: { purge: (a, id) => (segments ??= build()).purge(a, id) } });
}
