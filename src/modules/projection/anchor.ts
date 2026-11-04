// 初始检查点锚点（R10.7；v2 §9.4 第 10 条）：time / id_window / empty，由首个完整页确定。
// 内容 ID 用平台内容 ID 原文（外部 ID 始终按文本），不是内部 content_id。
import type { CountState } from "../provider-adapter";

export interface AnchorEntry {
  platformContentId: string;
  publishedAtMs: CountState;
}

export type InitialAnchor =
  | { mode: "time"; highWatermarkPublishedAt: Date; highWatermarkContentIds: string[] }
  | { mode: "id_window"; highWatermarkPublishedAt: null; highWatermarkContentIds: string[] }
  | { mode: "empty"; highWatermarkPublishedAt: null; highWatermarkContentIds: [] };

/** MySQL DATETIME 的上限是 9999-12-31；1970-01-01（0 毫秒）不是真实发布时间。 */
const MAX_VALID_MS = 253402300799999n;

export function validPublishedAtMs(s: CountState): bigint | null {
  return s.state === "value" && s.value > 0n && s.value <= MAX_VALID_MS ? s.value : null;
}

export function computeInitialAnchor(entries: readonly AnchorEntry[]): InitialAnchor {
  if (entries.length === 0) return { mode: "empty", highWatermarkPublishedAt: null, highWatermarkContentIds: [] };
  let max: bigint | null = null;
  for (const e of entries) {
    const ms = validPublishedAtMs(e.publishedAtMs);
    if (ms !== null && (max === null || ms > max)) max = ms;
  }
  if (max === null) return { mode: "id_window", highWatermarkPublishedAt: null, highWatermarkContentIds: dedupe(entries.map((e) => e.platformContentId)) };
  const ids = entries.filter((e) => validPublishedAtMs(e.publishedAtMs) === max).map((e) => e.platformContentId);
  return { mode: "time", highWatermarkPublishedAt: new Date(Number(max)), highWatermarkContentIds: dedupe(ids) };
}

const dedupe = (xs: string[]) => [...new Set(xs)];
