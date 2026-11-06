// 评论抓取的完整性口径（FS-10.4、FS-D08、D-50）与翻页判定。纯函数。
import type { RequestCursor, TypedCursor, ValueState } from "../provider-adapter";

/** 抖音：自然翻完（has_more=0）才算完整；小红书：永远不算完整（实测 has_more=0 但 total 远大于已抓条数）。 */
export const COMMENTS_POLICY = {
  douyin: { completeWhen: "natural_end" },
  xiaohongshu: { completeWhen: "never" },
} as const;
export type CommentsPlatform = keyof typeof COMMENTS_POLICY;
export const isCommentsPlatform = (p: string): p is CommentsPlatform => p === "douyin" || p === "xiaohongshu";

export type CommentsStop = "natural_end" | "page_limit" | "item_limit" | "cursor_anomaly" | "has_more_invalid";
export type CommentsStep = { action: "continue"; nextCursor: RequestCursor } | { action: "stop"; reason: CommentsStop };

const usable = (c: TypedCursor): c is RequestCursor => c.kind === "integer" || (c.kind === "string" && c.value !== "");

/**
 * 一页处理完之后：继续还是停。has_more 缺失 / 非法、游标不可用都按异常停止（不猜测、不回发 no_more）；
 * 触达页数 / 条数上限只在「还有更多」时算触达。limit 为 null 表示该维度不限。
 */
export function decideAfterCommentsPage(
  page: { hasMore: ValueState<boolean>; cursor: TypedCursor },
  totals: { pages: number; items: number },
  limits: { pageLimit: number | null; itemLimit: number | null },
): CommentsStep {
  if (page.hasMore.state !== "value") return { action: "stop", reason: "has_more_invalid" };
  if (!page.hasMore.value) return { action: "stop", reason: "natural_end" };
  if (!usable(page.cursor)) return { action: "stop", reason: "cursor_anomaly" };
  if (limits.pageLimit !== null && totals.pages >= limits.pageLimit) return { action: "stop", reason: "page_limit" };
  if (limits.itemLimit !== null && totals.items >= limits.itemLimit) return { action: "stop", reason: "item_limit" };
  return { action: "continue", nextCursor: page.cursor };
}

/** 完整抓取：平台口径允许 + 自然翻完 + 空结果不可信（total>0 却一条没抓到时不能当成「评论都被删了」）。 */
export function isCompleteFetch(platform: CommentsPlatform, stop: CommentsStop, fetched: number, reportedTotal: bigint | null): boolean {
  if (COMMENTS_POLICY[platform].completeWhen !== "natural_end") return false;
  if (stop !== "natural_end") return false;
  if (fetched === 0 && reportedTotal !== null && reportedTotal > 0n) return false;
  return true;
}

export type Coverage = "complete" | "partial" | "unknown";
export function coverageOf(complete: boolean, fetched: number, reportedTotal: bigint | null, stop: CommentsStop): Coverage {
  if (complete) return "complete";
  if (stop === "page_limit" || stop === "item_limit" || (reportedTotal !== null && reportedTotal > BigInt(fetched))) return "partial";
  return "unknown";
}
