// 页面进程与 CLI 进程共用的 Module 装配（一处接线，测试证明的就是生产接线）：
//   - 授权拒绝落审计（onDenied）、范围无法解释落质量问题（onUnresolvable）、停用 / 撤权后取消用户触发的任务（onRevoked）；
//   - 之前这三个钩子在页面与 CLI 的装配里都是空的，拒绝不留痕、范围问题不入库、撤权不取消。
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import type { Clock } from "../raw-capture/ports";
import { createAuditReader } from "./audit-read";
import { denialAuditor, purgeOlderThan, type AuditWriter } from "./audit";
import { createContextResolver } from "./authenticate";
import { createAuthorizer } from "./authorize";
import { createEgress } from "./egress";
import { createStaffLinkage } from "./linkage";
import { ISSUE_SCOPE_NOT_RESOLVABLE, recordAccessIssue } from "./quality";
import { createOrgDirectory } from "./scope";
import { createBootstrap, createUserAdmin, createUserImport } from "./users";

export function createAccessServices(d: { db: Db; clock: Clock; audit: AuditWriter; logger?: Logger }) {
  const { db, clock, audit } = d;
  const dir = createOrgDirectory(db);
  const issue = (userId: bigint | null, discriminator: string, reason: string) =>
    recordAccessIssue(db, {
      code: ISSUE_SCOPE_NOT_RESOLVABLE,
      severity: "warning",
      entityType: "user",
      ...(userId !== null ? { entityId: userId } : {}),
      discriminator,
      detail: { reason },
      now: clock.now(),
    });
  // 任一 canceller 失败 → 告警 + 审计，由 egress 自己处理；这里只把告警写进结构化日志
  const egress = createEgress({ authorizer: createAuthorizer(), audit, alert: (a) => d.logger?.warn({ alert: a }, "access.alert") });
  const onRevoked = async (userActor: string): Promise<void> => void (await egress.cancelUserJobs(userActor));
  const authorizer = createAuthorizer({
    onDenied: denialAuditor(audit),
    onUnresolvable: ({ ctx, resourceKey, reason }) => issue(ctx.userId, resourceKey, reason),
  });
  const linkage = createStaffLinkage({
    db,
    clock,
    audit,
    dir,
    purgeAudit: () => purgeOlderThan(db, audit, clock),
    onRevoked,
    ...(d.logger ? { log: (e, m) => d.logger!.info(e, m) } : {}),
  });
  const admin = createUserAdmin({ db, clock, audit, dir, authorizer, onRevoked });
  return {
    dir,
    egress,
    authorizer,
    linkage,
    admin,
    imp: createUserImport({ db, clock, audit, admin }),
    boot: createBootstrap({ db, clock, audit }),
    auditReader: createAuditReader({ db, authorizer }),
    resolver: createContextResolver({ db, dir, linkage, onUnresolvable: ({ userId, reason }) => issue(userId, reason, reason) }),
    onUnresolvable: ({ userId, reason }: { userId: bigint; reason: string }) => issue(userId, reason, reason),
  };
}
export type AccessServices = ReturnType<typeof createAccessServices>;
