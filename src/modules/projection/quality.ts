// data_quality_issues 的写入：指纹 = 问题码 + 批次 + 实体 + 区分符的 JCS 摘要，同一批次重放不产生重复行。
import { sql } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { dataQualityIssues } from "../../db/schema";
import { jcsSha256 } from "../canonical-json";

export interface IssueInput {
  code: string;
  severity: "info" | "warning" | "error" | "critical";
  batchId: bigint;
  accountId?: bigint | null;
  contentId?: bigint | null;
  assignmentId?: bigint | null;
  providerCallId?: bigint | null;
  entityType?: string;
  entityId?: bigint;
  jsonPath?: string;
  /** 区分同一批次同一实体上的不同问题（例如不同的 policy 拒绝原因）。 */
  discriminator?: string;
  detail: Record<string, unknown>;
  now: Date;
}

export async function recordIssue(tx: DbTx, i: IssueInput): Promise<void> {
  const fingerprint = jcsSha256({
    issue_code: i.code,
    batch_id: i.batchId.toString(),
    account_id: i.accountId?.toString() ?? null,
    content_id: i.contentId?.toString() ?? null,
    assignment_id: i.assignmentId?.toString() ?? null,
    discriminator: i.discriminator ?? "",
  });
  await tx
    .insert(dataQualityIssues)
    .values({
      issueFingerprint: fingerprint,
      issueCode: i.code,
      severity: i.severity,
      status: "open",
      entityType: i.entityType ?? null,
      entityId: i.entityId ?? null,
      batchId: i.batchId,
      accountId: i.accountId ?? null,
      contentId: i.contentId ?? null,
      assignmentId: i.assignmentId ?? null,
      providerCallId: i.providerCallId ?? null,
      jsonPath: i.jsonPath ?? null,
      detail: i.detail,
      occurrenceCount: 1,
      firstSeenAt: i.now,
      lastSeenAt: i.now,
      createdAt: i.now,
      updatedAt: i.now,
    })
    // 同一批次重放：保持原行不变（不递增计数，不改时间）
    .onDuplicateKeyUpdate({ set: { issueId: sql`issue_id` } });
}
