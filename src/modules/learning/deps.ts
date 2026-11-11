// 本模块所有服务函数共用的依赖与授权入口。授权只检查 Capability 与 B 的范围策略，不读角色名（G-12）。
import type { Db } from "../../db/client";
import type { AuditWriter, AuthContext, Authorizer, Egress } from "../access-control";
import type { Clock } from "../raw-capture/ports";
import type { LearningConfig } from "./config";
import { LearningError } from "./errors";
import type { CourseObjectStore } from "./store";

export interface LearningDeps {
  db: Db;
  clock: Clock;
  authorizer: Authorizer;
  egress: Egress;
  audit: AuditWriter;
  store: CourseObjectStore;
  config: LearningConfig;
}

/** 学习功能只给用户身份：服务身份不能把课程内容交给某个人。返回用户 ID。 */
export function requireUser(ctx: AuthContext): bigint {
  if (ctx.kind !== "user" || ctx.userId === null) throw new LearningError("authorization", "service_principal_forbidden", "该操作只允许用户身份");
  return ctx.userId;
}

/** Capability（可带资源范围）不满足一律 403，包括「对象不在你的范围内」（B 对外是 404，本域按 requirements §5.5 统一为 403）。 */
export async function authorizeOrThrow(
  deps: Pick<LearningDeps, "authorizer">,
  ctx: AuthContext,
  capability: string,
  resource?: { key: string; ref?: unknown },
): Promise<void> {
  const d = await deps.authorizer.authorize(ctx, { capability, ...(resource ? { resource } : {}) });
  if (!d.ok) throw new LearningError("authorization", d.reason, "没有权限执行这个操作");
}
