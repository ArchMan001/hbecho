// 测试用的调用方身份（B 域未实现前，调用方只有用途受限的服务身份）。
import type { ActorContext } from "../../src/modules/tracer-command";

export const CAP_SYNC_TRIGGER = "data.sync.trigger";

export function serviceActor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    actorId: "service:test",
    capabilities: new Set([CAP_SYNC_TRIGGER]),
    scope: { platformCodes: "all", mediaStaffIds: "all" },
    ...over,
  };
}

export const CAP_ACCOUNT_MANAGE = "data.account.manage";
export const CAP_MONITORING_MANAGE = "data.monitoring.manage";
export const CAP_EXTERNAL_MANAGE = "monitor.external.manage";

/** 运营身份：同步触发 + 账号处置 + 监控开关，全范围，非超管。 */
export const opsActor = (over: Partial<ActorContext> = {}): ActorContext =>
  serviceActor({ actorId: "service:ops", capabilities: new Set([CAP_SYNC_TRIGGER, CAP_ACCOUNT_MANAGE, CAP_MONITORING_MANAGE]), ...over });

/** 超管：在运营身份之上多了外部账号管理，并带 platformAdmin 标记。 */
export const adminActor = (over: Partial<ActorContext> = {}): ActorContext =>
  opsActor({ actorId: "service:admin", capabilities: new Set([CAP_SYNC_TRIGGER, CAP_ACCOUNT_MANAGE, CAP_MONITORING_MANAGE, CAP_EXTERNAL_MANAGE]), platformAdmin: true, ...over });
