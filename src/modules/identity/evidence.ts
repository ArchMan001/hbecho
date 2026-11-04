// dominant-list-author-evidence.v1（v2 §8.2）：closed schema + RFC 8785 JCS 摘要。
// 成功绑定把它与 identifier 一起长期保存；拒绝决定保存在 data_quality_issues.detail。两者共用这一份 schema。
import { z } from "zod";
import { jcsSha256, jcsSha256Hex } from "../canonical-json";
import type { DominantAuthorDecision } from "./dominant-author";

export const EVIDENCE_SCHEMA_VERSION = "dominant-list-author-evidence.v1";
const MAX_BIGINT = 9223372036854775807n;

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

const count = z.number().int().min(0);
const decimalBigint = z
  .string()
  .regex(/^[1-9]\d*$/, "必须是不带前导零的正十进制整数 string")
  // zod 不会因为 regex 失败而跳过后面的 refine，所以这里先确认是纯数字再转 BigInt
  .refine((s) => !/^\d+$/.test(s) || BigInt(s) <= MAX_BIGINT, "超出 BIGINT 范围");

const REJECT_REASONS = ["no_non_empty_author", "tie_for_highest", "insufficient_samples", "below_threshold"] as const;

const schema = z
  .strictObject({
    schema_version: z.literal(EVIDENCE_SCHEMA_VERSION),
    decision: z.enum(["accepted", "rejected"]),
    reason: z.enum(["unique_highest_and_policy_passed", ...REJECT_REASONS]),
    policy_version: z.string().min(1).max(64),
    evidence_batch_id: decimalBigint,
    // 只有 rejected 的 candidate 可以显式为 null（schema 其余字段都不允许 null）
    candidate_identifier: z
      .strictObject({ namespace: z.literal("xiaohongshu.content.user_id"), value: z.string().min(1), count })
      .nullable(),
    total_entry_count: count,
    non_empty_author_entry_count: count,
    empty_author_entry_count: count,
    author_counts: z.array(z.strictObject({ identifier: z.string().min(1), count: count.min(1) })),
  })
  .superRefine((e, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (e.decision === "accepted") {
      if (e.reason !== "unique_highest_and_policy_passed") bad("accepted 的 reason 必须是 unique_highest_and_policy_passed");
      if (e.candidate_identifier === null) bad("accepted 必须有 candidate_identifier");
    } else if (e.reason === "unique_highest_and_policy_passed") {
      bad("rejected 不能使用 accepted 的 reason");
    }
    if (e.total_entry_count !== e.non_empty_author_entry_count + e.empty_author_entry_count) {
      bad("total_entry_count 必须等于非空条目数 + 空条目数");
    }
    const sum = e.author_counts.reduce((n, c) => n + c.count, 0);
    if (sum !== e.non_empty_author_entry_count) bad("author_counts 之和必须等于 non_empty_author_entry_count");
    for (let i = 1; i < e.author_counts.length; i++) {
      const prev = Buffer.from(e.author_counts[i - 1]!.identifier, "utf8");
      const cur = Buffer.from(e.author_counts[i]!.identifier, "utf8");
      if (Buffer.compare(prev, cur) >= 0) bad("author_counts 必须按 identifier 的 UTF-8 字节序严格递增（且不重复）");
    }
    const cand = e.candidate_identifier;
    if (cand) {
      const row = e.author_counts.find((c) => c.identifier === cand.value);
      if (!row || row.count !== cand.count) bad("candidate_identifier 必须出现在 author_counts 且计数一致");
    }
  });

export type DominantListAuthorEvidence = z.infer<typeof schema>;

export function parseEvidence(input: unknown): DominantListAuthorEvidence {
  const r = schema.safeParse(input);
  if (!r.success) throw new EvidenceError(r.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
  return r.data;
}

/** 由主导作者决定生成 evidence。batchId 必须指向长期保留的 SyncBatch。 */
export function buildEvidence(
  decision: DominantAuthorDecision,
  ctx: { batchId: bigint; namespace: "xiaohongshu.content.user_id" },
): DominantListAuthorEvidence {
  return parseEvidence({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    decision: decision.decision,
    reason: decision.reason,
    policy_version: decision.policyVersion,
    evidence_batch_id: ctx.batchId.toString(),
    candidate_identifier: decision.candidate
      ? { namespace: ctx.namespace, value: decision.candidate.value, count: decision.candidate.count }
      : null,
    total_entry_count: decision.totalEntryCount,
    non_empty_author_entry_count: decision.nonEmptyAuthorEntryCount,
    empty_author_entry_count: decision.emptyAuthorEntryCount,
    author_counts: decision.authorCounts.map((c) => ({ identifier: c.identifier, count: c.count })),
  });
}

export function evidenceDigest(e: DominantListAuthorEvidence): Buffer {
  return jcsSha256(parseEvidence(e));
}

export function evidenceDigestHex(e: DominantListAuthorEvidence): string {
  return jcsSha256Hex(parseEvidence(e));
}
