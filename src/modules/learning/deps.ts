// 本模块所有服务函数共用的依赖与授权入口。授权只检查 Capability 与 B 的范围策略，不读角色名（G-12）。
import type { Db } from "../../db/client";
import type { AuditWriter, AuthContext, Authorizer, Egress } from "../access-control";
import type { Clock } from "../raw-capture/ports";
import type { LearningConfig } from "./config";
import { LearningError } from "./errors";
import type { CourseObjectStore } from "./store";
import type { VodClient } from "./vod";

/** 需要人知道的事。只带类型、标识与计数，不带内容 / 凭证。 */
export type LearningAlert =
  | { code: "media_deletion_stuck"; targetKind: string; targetId: string; attempts: number }
  | { code: "audit_write_failed"; eventType: string }
  | { code: "maintenance_step_failed"; step: string; error: string }
  | { code: "video_status_check_failed"; failed: number }
  /** 业务路径上 VOD 调用失败（对用户只说「暂时不可用」，原因在这里）；error 只含适配器包装过的错误码。 */
  | { code: "vod_call_failed"; op: string; error: string };

export interface LearningDeps {
  db: Db;
  clock: Clock;
  authorizer: Authorizer;
  egress: Egress;
  audit: AuditWriter;
  store: CourseObjectStore;
  vod: VodClient;
  config: LearningConfig;
  /** 需要人知道的事（删除卡住等）；缺省不告警。只传类型与标识，不传内容。 */
  alert?: (e: LearningAlert) => void;
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

export type PendingAudit = Parameters<AuditWriter["write"]>[0];

/**
 * 审计尽力而为（G-D24、acceptance I3）：业务事务**提交之后**再写，低风险——失败只记日志与计数并告警，不阻断业务。
 * 代价（PRD §6.7 已接受）：进程在提交与写审计之间崩溃会出现「有变更、无审计」。
 */
export async function writeAudit(deps: Pick<LearningDeps, "audit" | "alert">, events: readonly PendingAudit[]): Promise<void> {
  for (const e of events) {
    try {
      await deps.audit.write(e, { risk: "low" });
    } catch {
      deps.alert?.({ code: "audit_write_failed", eventType: e.eventType });
    }
  }
}

/** 业务路径上吞掉 VOD 异常之前先留痕：只记操作名与适配器包装过的信息（不含凭证）。 */
export function alertVod(deps: Pick<LearningDeps, "alert">, op: string, e: unknown): void {
  const error = e instanceof Error && /^VOD /.test(e.message) ? e.message.slice(0, 120) : e instanceof Error ? e.name : typeof e;
  deps.alert?.({ code: "vod_call_failed", op, error });
}
