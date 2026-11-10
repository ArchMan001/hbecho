// 服务身份（design §7.11、AX-6、B §10.3）：Worker 与计划任务使用的固定非用户主体，没有 Grant，权限是常量白名单。
// Worker 永远不使用也不伪造超级管理员。用户触发的任务继承提交者的 AuthContext.actor，不用服务身份。
import type { Capability } from "./roles";

export const SERVICE_PRINCIPALS = {
  /** 周期同步、按需采集、媒资归档。 */
  "service:sync-worker": ["data.sync.trigger"],
  /** 名单解析驱动、每日维护；批次完成时对已存在账号发起 supplement（a-full-sync 的 requireCap 需要 data.sync.trigger），范围限于名单内账号。 */
  "service:plan-worker": ["activity_plan.join", "data.sync.trigger"],
  /** 补偿与审计清理：只调内部函数，不经 authorize。 */
  "service:access-worker": [],
} as const satisfies Record<string, readonly Capability[]>;

export type ServicePrincipalName = keyof typeof SERVICE_PRINCIPALS;

/** 任何服务身份**永不**持有的 Capability（测试枚举断言）。 */
export const SERVICE_NEVER: readonly Capability[] = [
  "data.raw_payload.read",
  "data.export",
  "report.export",
  "user.manage",
  "audit.read",
  "config.manage",
  "data.master_data.structure",
];

export const isServicePrincipal = (actor: string): actor is ServicePrincipalName => Object.hasOwn(SERVICE_PRINCIPALS, actor);

export const serviceCapabilities = (name: ServicePrincipalName): ReadonlySet<string> => new Set(SERVICE_PRINCIPALS[name]);
