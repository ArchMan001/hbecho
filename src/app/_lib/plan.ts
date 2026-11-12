// 页面进程里的活动计划装配：进程内只建一次，复用访问控制运行时的数据库连接（与 _lib/learning.ts 同一做法）。
// 页面进程不装配付费网关：确认写入只落任务，名单解析与补抓都由 sync worker 执行（付费调用只有一套限流与预算）。
// 授权：页面把 AuthContext 适配成 PlanActor / ActorContext 后交给 Module，Module 自己再做 Capability 与范围检查。
import { cache } from "react";
import pino from "pino";
import { createAuditWriter, fromPlanAudit, fromSyncAudit, toPlanActor, toTracerActor, type AuthContext } from "../../modules/access-control";
import { getAccessRuntime } from "../../modules/access-control/runtime";
import { createActivityPlan, createLogAudit, PlanError, type ActivityPlan, type PlanActor } from "../../modules/activity-plan";
import { createMonitoringSwitch } from "../../modules/monitoring/set-switch";
import { createMonitoringResolver } from "../../modules/monitoring";
import { createLogSyncAuditSink, createSyncCommands, createSyncScheduler } from "../../modules/sync-schedule";
import { createLogAuditSink, createTracerCommands, type ActorContext } from "../../modules/tracer-command";

interface PlanWeb {
  ap: ActivityPlan;
  switches: ReturnType<typeof createMonitoringSwitch>;
  sync: ReturnType<typeof createSyncCommands>;
}
const KEY = Symbol.for("hbecho.activity-plan.web");

function build(): PlanWeb {
  const rt = getAccessRuntime();
  const { db } = rt;
  const clock = { now: () => new Date() };
  const logger = pino({ name: "activity-plan-web" }, pino.destination(2));
  const env = (process.env.HBECHO_ENV ?? "production") as "test" | "production";
  const modes = {
    media_user_info: (process.env.HBECHO_SYNC_PROFILE_MODE ?? "synchronous") as "synchronous" | "asynchronous",
    user_video_list: (process.env.HBECHO_SYNC_LIST_MODE ?? "synchronous") as "synchronous" | "asynchronous",
  };
  const tracerConfig = { environment: env, modes };
  const writer = createAuditWriter({ db, clock, logger });
  const audit = fromPlanAudit(writer, createLogAudit(logger));
  const syncAudit = fromSyncAudit(writer, createLogSyncAuditSink(logger));
  const tracer = createTracerCommands({ db, clock, audit: createLogAuditSink(logger), config: tracerConfig });
  const monitoring = createMonitoringResolver(db);
  const scheduler = createSyncScheduler({ db, clock, resolver: monitoring, runtime: tracerConfig });
  return {
    ap: createActivityPlan({ db, clock, audit, monitoring, tracer, tracerConfig }),
    switches: createMonitoringSwitch({ db, clock, audit: syncAudit }),
    sync: createSyncCommands({ db, clock, resolver: monitoring, planner: scheduler.planner, runtime: tracerConfig, audit: syncAudit }),
  };
}
export function planWeb(): PlanWeb {
  const g = globalThis as unknown as Record<symbol, PlanWeb | undefined>;
  return (g[KEY] ??= build());
}
export const ap = (): ActivityPlan => planWeb().ap;

/** AuthContext → PlanActor。品牌 ID 映射不到编码时整体拒绝（不静默丢掉一个品牌）。同一请求内只算一次。 */
export const planActorOf = cache(async (ctx: AuthContext): Promise<PlanActor> => {
  const r = await toPlanActor(ctx, { db: getAccessRuntime().db });
  if (!r.ok) throw new PlanError("configuration", "scope_unmappable", "你的品牌范围无法解释，请联系管理员");
  return r.actor;
});

/**
 * 监控开关 / 手工补抓用的 ActorContext。
 * - 全品牌、全分公司的主体（超管）：全范围，可改任意一级开关；
 * - 其余：范围收窄到这一个账号的专员，只能改账号级开关、补抓这一个账号。调用前必须已经用 Module 的 accounts.detail 确认账号在其范围内。
 */
export function monitoringActor(ctx: AuthContext, staffId: bigint): ActorContext {
  const full = toTracerActor(ctx);
  if (full.ok) return { actorId: full.actor.actorId, capabilities: full.actor.capabilities, platformAdmin: full.actor.platformAdmin, scope: full.actor.scope };
  return { actorId: ctx.actor, capabilities: ctx.capabilities, platformAdmin: false, scope: { platformCodes: "all", mediaStaffIds: new Set([staffId]) } };
}
/** 组织级（分公司 / 经销商 / 门店 / 专员）开关只给全范围主体（1.0 没有品牌集合范围，见 set-switch.ts）。 */
export const canSetOrgSwitches = (ctx: AuthContext): boolean => toTracerActor(ctx).ok;
