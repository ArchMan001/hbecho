// 审计读取（AX-10）：只有持有 audit.read（仅超管）的主体能读；`audit list` 命令与将来的页面共用。
import type { Db } from "../../db/client";
import { countAudit, listAudit, type AuditQuery, type AuditRow } from "./audit";
import type { AuthContext, Authorizer } from "./authorize";
import { AccessError } from "./errors";

export function createAuditReader(deps: { db: Db; authorizer: Authorizer }) {
  return {
    async read(ctx: AuthContext, q: AuditQuery = {}): Promise<AuditRow[]> {
      const d = await deps.authorizer.authorize(ctx, { capability: "audit.read" });
      if (!d.ok) throw new AccessError("authorization", "forbidden", "没有查看审计日志的权限");
      return listAudit(deps.db, { ...q, limit: Math.min(q.limit ?? 100, 1000) });
    },
    /** 同一筛选条件下的总数（页面分页与概要带）；同样要求 audit.read。 */
    async count(ctx: AuthContext, q: AuditQuery = {}): Promise<{ total: number; notSucceeded: number }> {
      const d = await deps.authorizer.authorize(ctx, { capability: "audit.read" });
      if (!d.ok) throw new AccessError("authorization", "forbidden", "没有查看审计日志的权限");
      return countAudit(deps.db, q);
    },
  };
}
export type AuditReader = ReturnType<typeof createAuditReader>;
