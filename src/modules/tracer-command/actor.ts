// 调用方身份。B 域（访问控制）尚未实现，本 spec 的调用方只有用途受限的服务身份（design §14、§18 P0-12）。
// Capability 名称沿用 B 域 PRD 的 `data.sync.trigger`（手工同步，范围=目标账号）；不另造名称。
import { TracerError } from "./errors";

export const CAP_SYNC_TRIGGER = "data.sync.trigger";

export interface ActorContext {
  /** 审计与幂等 key 的归属主体，例如 service:tracer-cli。 */
  readonly actorId: string;
  readonly capabilities: ReadonlySet<string>;
  readonly scope: {
    /** 平台编码集合，或 "all"。 */
    readonly platformCodes: ReadonlySet<string> | "all";
    /** 可操作的 MediaStaff 集合，或 "all"。 */
    readonly mediaStaffIds: ReadonlySet<bigint> | "all";
  };
}

export function requireCapability(actor: ActorContext): void {
  if (!actor.capabilities.has(CAP_SYNC_TRIGGER)) throw new TracerError("forbidden", `缺少 Capability ${CAP_SYNC_TRIGGER}`);
}

export function inScope(actor: ActorContext, platformCode: string, mediaStaffId: bigint): boolean {
  const { platformCodes, mediaStaffIds } = actor.scope;
  return (platformCodes === "all" || platformCodes.has(platformCode)) && (mediaStaffIds === "all" || mediaStaffIds.has(mediaStaffId));
}
