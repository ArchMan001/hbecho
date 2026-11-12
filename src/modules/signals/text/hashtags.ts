// 话题解析 text.hashtags（design §7.2）。三个平台各一个变体，1.0 初始实现相同；分开是为了让将来的平台差异
// 不必升全平台版本（C-D12）。输入先按 text.normalize 归一化（全角＃ → #）。
import { createHash } from "node:crypto";
import { normalizeText } from "./normalize";

export const MAX_TAG_CHARS = 64;
export const MAX_TAGS = 50;

// '#' + 到空白 / '#' / 方括号为止；"[话题]" 后面的收尾 '#' 一并吃掉，但裸 '#a#b' 里的第二个 '#' 要留给下一个话题
const TOKEN = /#([^#\s[\]]+)(?:\[话题\]#?)?/g;
const EDGE_PUNCT = /^\p{P}+|\p{P}+$/gu;

/** 对一段**已归一化**文本抽话题令牌：去首尾标点，空串与超长令牌丢弃，保持出现顺序，不去重。 */
export function parseTopics(normalized: string): string[] {
  return [...normalized.matchAll(TOKEN)]
    .map((m) => m[1]!.replace(EDGE_PUNCT, ""))
    .filter((t) => t !== "" && [...t].length <= MAX_TAG_CHARS);
}

export type HashtagParser = (normalized: string) => string[];
export const HASHTAG_PARSERS: Readonly<Record<string, HashtagParser>> = { douyin: parseTopics, xiaohongshu: parseTopics, kuaishou: parseTopics };

export type HashtagResult =
  | { ok: true; tags: string[] }
  | { ok: false; code: "text_parse_error"; detail: { sha256Prefix: string; length: number } };

/**
 * 从标题、正文、tag_text 抽话题：三段分别解析，合并后按首次出现顺序去重，至多 50 个（50 / 64 是建议值，design §14 第 17 项已确认）。
 * 解析器抛错 → 结构化失败，只带出错片段前 200 字符的 SHA-256 前缀与整段长度，不含原文（PRD C §4.4）。
 */
export function extractHashtags(
  platform: string,
  parts: { title: string | null; body: string | null; tagText: string | null },
  parsers: Readonly<Record<string, HashtagParser>> = HASHTAG_PARSERS,
): HashtagResult {
  const parse = Object.hasOwn(parsers, platform) ? parsers[platform] : undefined;
  const seen = new Set<string>();
  for (const raw of [parts.title, parts.body, parts.tagText]) {
    if (raw === null || raw === "") continue;
    try {
      if (!parse) throw new Error(`没有 ${platform} 的话题解析器`);
      for (const t of parse(normalizeText(raw))) seen.add(t);
    } catch {
      return { ok: false, code: "text_parse_error", detail: { sha256Prefix: createHash("sha256").update(raw.slice(0, 200), "utf8").digest("hex").slice(0, 16), length: raw.length } };
    }
  }
  return { ok: true, tags: [...seen].slice(0, MAX_TAGS) };
}
