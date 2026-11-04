import {
  ADAPTER_VERSION,
  type ContentKind,
  type CoverCandidates,
  type DecodeOutcome,
  type IdentifierNamespace,
  type ListData,
  type ListEntry,
  type Platform,
  type TypedCursor,
} from "./contract";
import { openEnvelope } from "./envelope";
import { JsonNumber, isIntegerLiteral, isJsonObject, type JsonObject, type JsonValue } from "./lossless-json";
import { UNSUPPORTED, rawOf, readCount, readExternalId, readText, type ValueState } from "./value-state";

const AUTHOR_NAMESPACE: Record<Platform, IdentifierNamespace> = {
  douyin: "douyin.user_id",
  xiaohongshu: "xiaohongshu.content.user_id",
};

const has = (o: JsonObject, k: string) => Object.hasOwn(o, k);

function readHasMore(r: JsonObject): ValueState<boolean> {
  if (!has(r, "has_more")) return { state: "missing" };
  const v = r.has_more as JsonValue;
  if (v === null) return { state: "explicit_null" };
  if (typeof v === "boolean") return { state: "value", value: v };
  if (v instanceof JsonNumber && v.source === "1") return { state: "value", value: true };
  if (v instanceof JsonNumber && v.source === "0") return { state: "value", value: false };
  return { state: "invalid", raw: rawOf(v) };
}

function readCursor(r: JsonObject): TypedCursor {
  if (!has(r, "max_cursor")) return { kind: "absent" };
  const v = r.max_cursor as JsonValue;
  if (v === null) return { kind: "null" };
  if (typeof v === "string") return { kind: "string", value: v };
  if (v instanceof JsonNumber && isIntegerLiteral(v)) return { kind: "integer", lexeme: v.source };
  return { kind: "invalid", raw: rawOf(v) };
}

function readCover(e: JsonObject, position: number): CoverCandidates {
  const path = `$.data.result.result[${position}].cover`;
  const none: CoverCandidates = { candidates: [], selected: null, selectedJsonPath: null, selection: "unavailable" };
  const v = e.cover;
  if (typeof v === "string") {
    return v === "" ? none : { candidates: [v], selected: v, selectedJsonPath: path, selection: "single_string" };
  }
  if (Array.isArray(v)) {
    // 保留全部候选；归档引用固定取数组第 2 条（540 宽，A v1.10 §9.2）
    const indexed = v.map((x, i) => ({ x, i })).filter((p): p is { x: string; i: number } => typeof p.x === "string" && p.x !== "");
    const candidates = indexed.map((p) => p.x);
    return indexed.length >= 2
      ? { candidates, selected: indexed[1]!.x, selectedJsonPath: `${path}[${indexed[1]!.i}]`, selection: "second_of_array" }
      : { candidates, selected: null, selectedJsonPath: null, selection: "unavailable" };
  }
  return none;
}

/**
 * content_kind 推断（A v1.10 §9.2）：有视频 → video；无视频有图片 → image；只有文本 → text；缺失或矛盾 → unknown。
 * 「缺失或矛盾」= 无法排除视频（video 信号缺失/类型异常），或无法确认图片（images 信号缺失/类型异常），
 * 或所有素材与文本都为空。视频+图片并存是 video，不输出 mixed。
 */
function inferKind(e: JsonObject, hasText: boolean): ContentKind {
  const video = e.video;
  if (!isJsonObject(video)) return "unknown";
  const url = video.url;
  if (typeof url === "string" && url !== "") return "video";
  if (has(video, "url") && url !== null && typeof url !== "string") return "unknown"; // url 类型矛盾
  if (!Array.isArray(e.images)) return "unknown";
  if (e.images.length > 0) return "image";
  return hasText ? "text" : "unknown";
}

const DURATION_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

/** 只在有视频素材时读取 video.duration；十进制小数原文，负数 / 指数 / 非数字类型为 invalid。 */
function readDuration(e: JsonObject, kind: ContentKind): ValueState<string> {
  if (kind !== "video") return { state: "missing" };
  const video = e.video;
  if (!isJsonObject(video) || !has(video, "duration")) return { state: "missing" };
  const v = video.duration as JsonValue;
  if (v === null) return { state: "explicit_null" };
  if (v instanceof JsonNumber && DURATION_RE.test(v.source)) return { state: "value", value: v.source };
  return { state: "invalid", raw: rawOf(v) };
}

function readStringArray(e: JsonObject, key: string): ValueState<string[]> {
  if (!has(e, key)) return { state: "missing" };
  const v = e[key] as JsonValue;
  if (v === null) return { state: "explicit_null" };
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return { state: "value", value: v as string[] };
  return { state: "invalid", raw: rawOf(v) };
}

function invalidEntry(position: number, platform: Platform, v: JsonValue): ListEntry {
  const bad = { state: "invalid", raw: rawOf(v) } as const;
  return {
    position,
    postId: bad,
    author: { namespace: AUTHOR_NAMESPACE[platform], id: bad },
    authorSecUid: platform === "douyin" ? bad : null,
    authorName: bad,
    title: bad,
    text: bad,
    publishLocation: bad,
    tagText: bad,
    shareUrl: bad,
    relatedSearchTerms: bad,
    durationSeconds: bad,
    publishedAtMs: bad,
    metrics: { like: bad, comment: bad, collect: bad, share: bad, play: UNSUPPORTED },
    contentKind: "unknown",
    cover: { candidates: [], selected: null, selectedJsonPath: null, selection: "unavailable" },
  };
}

function readEntryText(e: JsonObject): ValueState<string> {
  if (!has(e, "text")) return { state: "missing" };
  const t = e.text as JsonValue;
  if (t === null) return { state: "explicit_null" };
  if (!isJsonObject(t)) return { state: "invalid", raw: rawOf(t) };
  return readText(t, "content");
}

function decodeEntry(position: number, platform: Platform, v: JsonValue): ListEntry {
  if (!isJsonObject(v)) return invalidEntry(position, platform, v);
  const stats = isJsonObject(v.stats) ? v.stats : {};
  const title = readText(v, "title");
  const text = readEntryText(v);
  const nonEmpty = (s: ValueState<string>) => s.state === "value" && s.value !== "";
  const contentKind = inferKind(v, nonEmpty(title) || nonEmpty(text));
  return {
    position,
    postId: readExternalId(v, "post_id"),
    author: { namespace: AUTHOR_NAMESPACE[platform], id: readExternalId(v, "user_id") },
    authorSecUid: platform === "douyin" ? readExternalId(v, "sec_uid") : null,
    authorName: readText(v, "author_name"),
    title,
    text,
    publishLocation: readText(v, "publish_location"),
    tagText: readText(v, "tag_text"),
    shareUrl: readText(v, "share_url"),
    relatedSearchTerms: readStringArray(v, "related_search_terms"),
    durationSeconds: readDuration(v, contentKind),
    publishedAtMs: readCount(v, "created"),
    // 列表接口不提供播放数：抖音返回的 0、小红书缺字段，都记 unsupported（R5.6）
    metrics: {
      like: readCount(stats, "like_count"),
      comment: readCount(stats, "comment_count"),
      collect: readCount(stats, "collect_count"),
      share: readCount(stats, "share_count"),
      play: UNSUPPORTED,
    },
    contentKind,
    cover: readCover(v, position),
  };
}

export function decodeVideoList(platform: Platform, bytes: Uint8Array): DecodeOutcome<ListData> {
  const opened = openEnvelope(platform, "user_video_list", bytes);
  if (!opened.ok) return opened.outcome;
  const r = opened.result;

  // result 不是数组是 schema 漂移，不能当成空列表（技术失败不伪装成业务数据缺失）
  const items = r.result;
  if (!Array.isArray(items)) {
    return { outcome: "schema_drift", adapterVersion: ADAPTER_VERSION, platform, issues: ["result_not_array"] };
  }

  return {
    outcome: "decoded",
    adapterVersion: ADAPTER_VERSION,
    platform,
    exchange: opened.exchange,
    taskId: opened.taskId,
    data: {
      entries: items.map((item, i) => decodeEntry(i, platform, item)),
      hasMore: readHasMore(r),
      maxCursor: readCursor(r),
    },
  };
}
