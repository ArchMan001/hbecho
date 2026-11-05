// 评论列表解码（post_comments_list）。只产出一级评论；回复与一级评论在同一数组里用 parent_id 区分（扁平，非嵌套），
// 带非空 parent_id 的条目被分流计数、不进入 entries。total 包含回复，不等于可获取条数（D-50）。
import { ADAPTER_VERSION, type CommentEntry, type CommentsData, type DecodeOutcome, type Platform } from "./contract";
import { readCursor, readHasMore } from "./decode-video-list";
import { openEnvelope } from "./envelope";
import { isJsonObject, type JsonObject, type JsonValue } from "./lossless-json";
import { rawOf, readCount, readExternalId, readText, type ValueState } from "./value-state";

/** 回复 = parent_id 存在且不是 null / 空串。缺失、null、空串都是一级评论（不猜测其他占位值）。 */
function isReply(e: JsonObject): boolean {
  if (!Object.hasOwn(e, "parent_id")) return false;
  const v = e.parent_id as JsonValue;
  return v !== null && v !== "";
}

function invalid(raw: JsonValue): ValueState<never> {
  return { state: "invalid", raw: rawOf(raw) };
}

function decodeComment(position: number, e: JsonObject): CommentEntry {
  const author = isJsonObject(e.author) ? e.author : null;
  const stats = isJsonObject(e.stats) ? e.stats : null;
  const missing = { state: "missing" } as const;
  return {
    position,
    id: readExternalId(e, "id"),
    postId: readExternalId(e, "post_id"),
    content: readText(e, "content"),
    authorId: author ? readExternalId(author, "id") : Object.hasOwn(e, "author") && e.author !== null ? invalid(e.author as JsonValue) : missing,
    authorName: author ? readText(author, "name") : missing,
    likeCount: stats ? readCount(stats, "like_count") : missing,
    replyCount: stats ? readCount(stats, "reply_count") : missing,
    createdAtMs: readCount(e, "created"),
    updatedAtMs: readCount(e, "updated"),
  };
}

export function decodeComments(platform: Platform, bytes: Uint8Array): DecodeOutcome<CommentsData> {
  const opened = openEnvelope(platform, "post_comments_list", bytes);
  if (!opened.ok) return opened.outcome;
  const r = opened.result;
  // result 不是数组是 schema 漂移，不能当成「没有评论」
  const items = r.result;
  if (!Array.isArray(items)) {
    return { outcome: "schema_drift", adapterVersion: ADAPTER_VERSION, platform, issues: ["result_not_array"] };
  }
  const entries: CommentEntry[] = [];
  let ignoredReplyCount = 0;
  items.forEach((item, i) => {
    if (!isJsonObject(item)) {
      // 非对象条目无法判断是不是回复；保守当作一级评论的「非法条目」保留，让下游看到异常而不是悄悄丢弃
      entries.push({
        position: i,
        id: invalid(item),
        postId: invalid(item),
        content: invalid(item),
        authorId: invalid(item),
        authorName: invalid(item),
        likeCount: invalid(item),
        replyCount: invalid(item),
        createdAtMs: invalid(item),
        updatedAtMs: invalid(item),
      });
      return;
    }
    if (isReply(item)) ignoredReplyCount++;
    else entries.push(decodeComment(i, item));
  });
  return {
    outcome: "decoded",
    adapterVersion: ADAPTER_VERSION,
    platform,
    exchange: opened.exchange,
    taskId: opened.taskId,
    data: {
      entries,
      ignoredReplyCount,
      returnedCount: items.length,
      hasMore: readHasMore(r),
      maxCursor: readCursor(r),
      total: readCount(r, "total"),
      postId: readExternalId(r, "post_id"),
    },
  };
}
