// 小红书主导作者策略 xhs-dominant-author.v1（R6.1/R6.2/R6.5/R6.6）：
// 唯一最高 + 候选至少 3 次 + 占非空作者条目 >= 80%。
// 只做决定与证据计数；evidence 的 JCS 摘要与持久化在任务 5。

export interface DominantAuthorPolicy {
  readonly version: string;
  /** 唯一最高者占非空作者条目的最低百分比（含边界）。调整阈值必须升 version。 */
  readonly thresholdPercent: number;
  /** 候选作者至少出现的次数，防止「1 条非空 + 大量空」这类样本过小的页面被通过。 */
  readonly minCandidateCount: number;
}

export const XHS_DOMINANT_AUTHOR_V1: DominantAuthorPolicy = Object.freeze({
  version: "xhs-dominant-author.v1",
  thresholdPercent: 80,
  minCandidateCount: 3,
});

export type DominantAuthorDecision = {
  policyVersion: string;
  decision: "accepted" | "rejected";
  reason:
    | "unique_highest_and_policy_passed"
    | "no_non_empty_author"
    | "tie_for_highest"
    | "insufficient_samples"
    | "below_threshold";
  /** 仅 accepted 时非空。 */
  candidate: { value: string; count: number } | null;
  totalEntryCount: number;
  nonEmptyAuthorEntryCount: number;
  emptyAuthorEntryCount: number;
  /** 覆盖该页全部非空作者，按 identifier 的 UTF-8 字节序排序（v2 §8.2）。 */
  authorCounts: Array<{ identifier: string; count: number }>;
};

const isEmpty = (a: string | null) => a === null || a.trim() === "";

/** authors：完整返回页里每条条目的作者 ID 原文（缺失、非法的传 null）。按 exact 文本计数，不归一。 */
export function decideDominantAuthor(
  authors: ReadonlyArray<string | null>,
  policy: DominantAuthorPolicy,
): DominantAuthorDecision {
  if (!Number.isInteger(policy.thresholdPercent) || policy.thresholdPercent < 1 || policy.thresholdPercent > 100) {
    throw new RangeError("thresholdPercent 必须是 1..100 的整数");
  }
  if (!Number.isInteger(policy.minCandidateCount) || policy.minCandidateCount < 1) {
    throw new RangeError("minCandidateCount 必须是 >= 1 的整数");
  }
  const counts = new Map<string, number>();
  let empty = 0;
  for (const a of authors) {
    if (a === null || isEmpty(a)) empty++;
    else counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const authorCounts = [...counts]
    .map(([identifier, count]) => ({ identifier, count }))
    .sort((x, y) => Buffer.compare(Buffer.from(x.identifier, "utf8"), Buffer.from(y.identifier, "utf8")));
  const nonEmpty = authors.length - empty;
  const base = {
    policyVersion: policy.version,
    totalEntryCount: authors.length,
    nonEmptyAuthorEntryCount: nonEmpty,
    emptyAuthorEntryCount: empty,
    authorCounts,
  };
  const rejected = (
    reason: "no_non_empty_author" | "tie_for_highest" | "insufficient_samples" | "below_threshold",
  ): DominantAuthorDecision => ({
    ...base,
    decision: "rejected",
    reason,
    candidate: null,
  });

  if (nonEmpty === 0) return rejected("no_non_empty_author");
  const max = Math.max(...authorCounts.map((c) => c.count));
  const tops = authorCounts.filter((c) => c.count === max);
  if (tops.length > 1) return rejected("tie_for_highest");
  if (max < policy.minCandidateCount) return rejected("insufficient_samples");
  // 整数运算，避免浮点比较：count / nonEmpty >= threshold / 100
  if (max * 100 < nonEmpty * policy.thresholdPercent) return rejected("below_threshold");
  return {
    ...base,
    decision: "accepted",
    reason: "unique_highest_and_policy_passed",
    candidate: { value: tops[0]!.identifier, count: max },
  };
}
