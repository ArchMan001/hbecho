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
