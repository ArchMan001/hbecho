// B 域的可处理问题（data_quality_issues）。沿用同一张表与指纹做法，但 B 域的问题不属于任何同步批次，
// 所以不走 projection/quality.ts 的 recordIssue（它要求 batchId）。同一指纹重复出现只累加次数、刷新时间。
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { dataQualityIssues } from "../../db/schema";

export const ISSUE_SCOPE_NOT_RESOLVABLE = "access_scope_not_resolvable";
export const ISSUE_AUTO_RESTORE_BLOCKED = "user_auto_restore_blocked_phone_in_use";

export interface AccessIssue {
  code: string;
  severity: "info" | "warning" | "error" | "critical";
  entityType?: string;
  entityId?: bigint;
  /** 区分同一问题码下的不同对象（资源键、原因、用户 ID……），参与指纹。 */
  discriminator: string;
  detail: Record<string, unknown>;
  now: Date;
}

export async function recordAccessIssue(runner: Db | DbTx, i: AccessIssue): Promise<void> {
  const fingerprint = createHash("sha256").update(["access", i.code, i.entityType ?? "", i.entityId?.toString() ?? "", i.discriminator].join("|")).digest();
  await runner
    .insert(dataQualityIssues)
    .values({
      issueFingerprint: fingerprint,
      issueCode: i.code,
      severity: i.severity,
      status: "open",
      entityType: i.entityType ?? null,
      entityId: i.entityId ?? null,
      detail: i.detail,
      occurrenceCount: 1,
      firstSeenAt: i.now,
      lastSeenAt: i.now,
      createdAt: i.now,
      updatedAt: i.now,
    })
    .onDuplicateKeyUpdate({ set: { occurrenceCount: sql`occurrence_count + 1`, lastSeenAt: i.now, updatedAt: i.now } });
}
