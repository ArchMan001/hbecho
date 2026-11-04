// 同一页里指向同一内容身份的多个条目：全部处理，只形成一个内容快照与一个 discovery（R9.4、R9.5）。
// 合并规则：后到的有效值（含真实 0）覆盖；后到的 missing / explicit_null / invalid / unsupported 不擦除已有有效值。
import type { ListEntry } from "../provider-adapter";
import type { ValueState } from "../provider-adapter";

export interface MergedContent {
  platformContentId: string;
  entry: ListEntry;
  /** 第一次出现的位置（discovery 记录这个位置）。 */
  firstPosition: number;
  positions: number[];
}

const later = <T>(prev: ValueState<T>, next: ValueState<T>): ValueState<T> => (next.state === "value" || prev.state !== "value" ? next : prev);

function mergeTwo(a: ListEntry, b: ListEntry): ListEntry {
  return {
    ...b,
    position: a.position,
    postId: a.postId,
    author: { namespace: b.author.namespace, id: later(a.author.id, b.author.id) },
    authorSecUid: b.authorSecUid === null || a.authorSecUid === null ? b.authorSecUid : later(a.authorSecUid, b.authorSecUid),
    authorName: later(a.authorName, b.authorName),
    title: later(a.title, b.title),
    text: later(a.text, b.text),
    publishLocation: later(a.publishLocation, b.publishLocation),
    tagText: later(a.tagText, b.tagText),
    shareUrl: later(a.shareUrl, b.shareUrl),
    relatedSearchTerms: later(a.relatedSearchTerms, b.relatedSearchTerms),
    durationSeconds: later(a.durationSeconds, b.durationSeconds),
    publishedAtMs: later(a.publishedAtMs, b.publishedAtMs),
    metrics: {
      like: later(a.metrics.like, b.metrics.like),
      comment: later(a.metrics.comment, b.metrics.comment),
      collect: later(a.metrics.collect, b.metrics.collect),
      share: later(a.metrics.share, b.metrics.share),
      play: later(a.metrics.play, b.metrics.play),
    },
    // unknown 不覆盖已经推断出的形态
    contentKind: b.contentKind === "unknown" ? a.contentKind : b.contentKind,
    cover: b.cover.selected !== null ? b.cover : a.cover,
  };
}

export function mergeEntries(entries: readonly ListEntry[]): {
  merged: MergedContent[];
  unprojectable: Array<{ position: number; reason: string }>;
  duplicates: Array<{ platformContentId: string; positions: number[] }>;
} {
  const byId = new Map<string, MergedContent>();
  const unprojectable: Array<{ position: number; reason: string }> = [];
  for (const e of entries) {
    if (e.postId.state !== "value") {
      unprojectable.push({ position: e.position, reason: `post_id_${e.postId.state}` });
      continue;
    }
    const id = e.postId.value;
    const cur = byId.get(id);
    if (!cur) byId.set(id, { platformContentId: id, entry: e, firstPosition: e.position, positions: [e.position] });
    else {
      cur.entry = mergeTwo(cur.entry, e);
      cur.positions.push(e.position);
    }
  }
  const merged = [...byId.values()];
  const duplicates = merged.filter((m) => m.positions.length > 1).map((m) => ({ platformContentId: m.platformContentId, positions: m.positions }));
  return { merged, unprojectable, duplicates };
}
