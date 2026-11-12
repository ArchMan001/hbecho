// 文本特征的纯计算（design §7.4）：事务之外运行，不做任何 IO。每个信号独立 try/catch 的语义由 extractHashtags 保证
// （话题失败不影响标题与正文）。
import { jcsSha256 } from "../../canonical-json";
import { capabilityOf, requireSignal, versionOf } from "../catalog";
import { PLATFORM_TEXT_FIELDS } from "../text/fields";
import { extractHashtags, type HashtagParser } from "../text/hashtags";
import { currentNormalizerVersion, normalizeText } from "../text/normalize";

export interface EnvelopeEntry {
  state: "valid" | "failed";
  cap: string;
  ver: number;
  /** 文本类信号写入时的 text.normalize 版本。 */
  nv?: number;
  at: string;
  code?: string;
  /** 失败时的片段摘要（SHA-256 前缀与长度），不含原文。 */
  detail?: string;
}
export type Envelope = Record<string, EnvelopeEntry>;

/** NULL 与空串要能区分：「平台没返回」与「真的空」不共享指纹（SG-D04）。 */
const textState = (v: string | null) => (v === null ? { s: "null" } : { s: "text", v });

export const contentMaterialSha = (f: { platform: string; title: string | null; body: string | null; tagText: string | null }): Buffer =>
  jcsSha256({ platform: f.platform, title: textState(f.title), body: textState(f.body), tag_text: textState(f.tagText) });
export const commentMaterialSha = (contentText: string | null): Buffer => jcsSha256({ text: textState(contentText) });

export interface ContentFeatureValues {
  titleNormalized: string | null;
  bodyNormalized: string | null;
  hashtags: string[] | null;
  signals: Envelope;
}

/** 平台没有 title / body 字段 → 不写条目、列为空，读取时由字段表推出 not_applicable。NULL 的标题在有字段的平台读作 valid 的空串。 */
export function computeContentFeatures(
  f: { platform: string; title: string | null; body: string | null; tagText: string | null },
  now: Date,
  parsers?: Readonly<Record<string, HashtagParser>>,
): ContentFeatureValues {
  const at = now.toISOString();
  const nv = currentNormalizerVersion();
  const fields = PLATFORM_TEXT_FIELDS[f.platform] ?? { title: false, body: false };
  const signals: Envelope = {};
  const text = (key: string, raw: string | null): string => {
    signals[key] = { state: "valid", cap: capabilityOf(requireSignal(key), f.platform), ver: versionOf("text.normalize"), nv, at };
    return normalizeText(raw ?? "");
  };
  const titleNormalized = fields.title ? text("text.title_normalized", f.title) : null;
  const bodyNormalized = fields.body ? text("text.body_normalized", f.body) : null;
  const cap = capabilityOf(requireSignal("text.hashtags"), f.platform);
  const r = extractHashtags(f.platform, f, parsers);
  if (r.ok) signals["text.hashtags"] = { state: "valid", cap, ver: versionOf(cap), nv, at };
  else signals["text.hashtags"] = { state: "failed", cap, ver: versionOf(cap), nv, at, code: r.code, detail: `sha256:${r.detail.sha256Prefix};len=${r.detail.length}` };
  return { titleNormalized, bodyNormalized, hashtags: r.ok ? r.tags : null, signals };
}

export function computeCommentFeature(contentText: string | null, platform: string, now: Date): { textNormalized: string; signals: Envelope } {
  const key = "comment.text_normalized";
  return {
    textNormalized: normalizeText(contentText ?? ""),
    signals: { [key]: { state: "valid", cap: capabilityOf(requireSignal(key), platform), ver: versionOf("text.normalize"), nv: currentNormalizerVersion(), at: now.toISOString() } },
  };
}

/** 新算出的信封里每个信号，旧信封都已是同一能力、同一版本、同一归一化版本（recompute 时用来跳过无事可做的行）。 */
export function envelopeIsCurrent(old: Envelope, fresh: Envelope): boolean {
  const keys = Object.keys(fresh);
  return keys.every((k) => old[k] !== undefined && old[k].cap === fresh[k]!.cap && old[k].ver === fresh[k]!.ver && old[k].nv === fresh[k]!.nv) && Object.keys(old).length === keys.length;
}
