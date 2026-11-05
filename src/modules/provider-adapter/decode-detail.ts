// 内容详情解码（请求 media_stats_number，响应 media_stats）。
// 指标：`*_number` 优先，`*_count` 回退（readCount 的顺序语义）；真实 0 / 缺失 / null / 非法 / 不支持互不转换。
// cover / download_urls 在详情里是字符串（可能换行分隔），展开成候选集全部保留；临时地址不是媒资身份。
import {
  ADAPTER_VERSION,
  type DecodeOutcome,
  type DetailData,
  type IdentifierNamespace,
  type Platform,
} from "./contract";
import { openEnvelope } from "./envelope";
import { JsonNumber, type JsonObject, type JsonValue } from "./lossless-json";
import { rawOf, readCount, readExternalId, readText, type CountState, type ValueState } from "./value-state";

const AUTHOR_NAMESPACE: Record<Platform, IdentifierNamespace> = {
  douyin: "douyin.user_id",
  xiaohongshu: "xiaohongshu.content.user_id",
  kuaishou: "kuaishou.user_id",
};

const DURATION_RE = /^(0|[1-9]\d*)(\.\d+)?$/;
const has = (o: JsonObject, k: string) => Object.hasOwn(o, k);

/** 字符串（可换行分隔）或字符串数组 → 非空候选，保序去重；其他类型一律不产生候选。 */
export function expandCandidates(v: JsonValue | undefined): string[] {
  const parts =
    typeof v === "string"
      ? v.split(/\r?\n/)
      : Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
  const seen = new Set<string>();
  for (const p of parts) {
    const t = p.trim();
    if (t !== "") seen.add(t);
  }
  return [...seen];
}

/** 时长：十进制小数原文，按键顺序取第一个有效值；负数 / 指数 / 其他类型为 invalid。 */
function readDuration(r: JsonObject, ...keys: string[]): ValueState<string> {
  const results = keys.map((k): ValueState<string> => {
    if (!has(r, k)) return { state: "missing" };
    const v = r[k] as JsonValue;
    if (v === null) return { state: "explicit_null" };
    if (v instanceof JsonNumber && DURATION_RE.test(v.source)) return { state: "value", value: v.source };
    return { state: "invalid", raw: rawOf(v) };
  });
  return (
    results.find((x) => x.state === "value") ??
    results.find((x) => x.state === "invalid") ??
    results.find((x) => x.state === "explicit_null") ??
    ({ state: "missing" } as const)
  );
}

/** related_search_str 是换行分隔的多行搜索词；整个字符串缺失 / null 保持原状态。 */
function readSearchTerms(r: JsonObject): ValueState<string[]> {
  const s = readText(r, "related_search_str");
  if (s.state !== "value") return s;
  return { state: "value", value: s.value.split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== "") };
}

/**
 * `*_number` 优先、`*_count` 回退：只有优先字段**缺失或非法**时才回退。优先字段是显式 null 就是 null——
 * 旧的 `*_count` 字段可能是占位 0（列表接口的抖音 play_count 就是占位 0），不能把 explicit_null 变成真实 0。
 */
function readPreferred(r: JsonObject, preferred: string, fallback: string): CountState {
  const p = readCount(r, preferred);
  if (p.state === "value" || p.state === "explicit_null") return p;
  const f = readCount(r, fallback);
  return f.state === "value" ? f : p.state === "invalid" ? p : f;
}

export function decodeDetail(platform: Platform, bytes: Uint8Array): DecodeOutcome<DetailData> {
  const opened = openEnvelope(platform, "media_stats_number", bytes);
  if (!opened.ok) return opened.outcome;
  const r = opened.result;
  return {
    outcome: "decoded",
    adapterVersion: ADAPTER_VERSION,
    platform,
    exchange: opened.exchange,
    taskId: opened.taskId,
    data: {
      postId: readExternalId(r, "post_id"),
      platformEcho: readText(r, "platform"),
      author: { namespace: AUTHOR_NAMESPACE[platform], id: readExternalId(r, "user_id") },
      authorName: readText(r, "author_name"),
      authorHomepage: readText(r, "author_homepage"),
      title: readText(r, "title"),
      tagText: readText(r, "tag_text"),
      publishLocation: readText(r, "publish_location"),
      relatedSearchTerms: readSearchTerms(r),
      publishedAtMs: readCount(r, "created"),
      metrics: {
        play: readPreferred(r, "play_number", "play_count"),
        like: readPreferred(r, "like_number", "like_count"),
        comment: readPreferred(r, "comment_number", "comment_count"),
        collect: readPreferred(r, "collect_number", "collect_count"),
        share: readPreferred(r, "share_number", "share_count"),
      },
      durationSeconds: readDuration(r, "duration_number", "duration"),
      coverCandidates: expandCandidates(r.cover),
      downloadCandidates: expandCandidates(r.download_urls),
      providerUpdatedAtMs: readCount(r, "updated"),
    },
  };
}
