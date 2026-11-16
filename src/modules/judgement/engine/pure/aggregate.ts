// 专员级聚合：内容要求的 P / U / F 取每条参与内容的最终结果（design §7.6、JP-9）。
import { evaluateMethod, type Counts, type Method } from "./tri";
import type { Outcome, Tri } from "./types";

export interface ContentRowLite {
  final: Tri | "skipped" | null;
  reasonCode?: string | null;
}
export interface ContentCounts extends Counts {
  /** 第 1 层数量要求没选中的内容：不计 P / U / F */
  skipped: number;
  /** 参与内容行数 = P + U + F + skipped；零内容只看它 */
  rows: number;
}
export function contentCounts(rows: readonly ContentRowLite[]): ContentCounts {
  const c: ContentCounts = { p: 0, u: 0, f: 0, skipped: 0, rows: rows.length };
  for (const r of rows) {
    if (r.final === "pass") c.p++;
    else if (r.final === "unobtained") c.u++;
    else if (r.final === "fail") c.f++;
    else if (r.final === "skipped") c.skipped++;
    else throw new Error("聚合时仍有未评估的内容行");
  }
  return c;
}

export type ZeroReason = "sync_failed" | "sync_gap" | "no_sync_in_window";
export interface ZeroContext {
  syncComplete: boolean;
  syncReason: ZeroReason | null;
}
export interface Judged {
  result: Outcome;
  /** 零内容且未获取成功时的原因 */
  reason?: string;
}
/** 零内容（D-D14）：同步完整 → 不达标；否则 → 未获取成功，原因 = 同步原因。 */
export function zeroContent(z: ZeroContext): Judged {
  if (z.syncComplete) return { result: "not_met" };
  return { result: "unobtained", reason: z.syncReason ?? "sync_failed" };
}

/** 内容要求：达标方式固定 at_least_n N（N = quantity ?? 1）。零内容 = 参与内容行数为 0，不是「没有内容通过第 1 层」。 */
export function contentOutcome(counts: ContentCounts, n: number | undefined, z: ZeroContext): Judged {
  if (counts.rows === 0) return zeroContent(z);
  const r = evaluateMethod({ type: "at_least_n", n: n ?? 1 }, counts);
  return { result: r === "zero" ? "not_met" : r };
}

/**
 * 评论要求：候选 = C2。T = 0 的分支（design §7.7）：有候选在第 1、2 层未获取 → 未获取；根本没有参与内容 → 零内容规则；其余 → 不达标。
 */
export function commentOutcome(
  method: Method,
  counts: Counts,
  ctx: { candidateUnobtained: boolean; participantContentRows: number; zero: ZeroContext },
): Judged {
  if (counts.p + counts.u + counts.f === 0) {
    if (ctx.candidateUnobtained) return { result: "unobtained", reason: "candidate_unobtained" };
    if (ctx.participantContentRows === 0) return zeroContent(ctx.zero);
    return { result: "not_met" };
  }
  const r = evaluateMethod(method, counts);
  return { result: r === "zero" ? "not_met" : r };
}

/** 主要原因：条数最多的原因，并列取字典序最小。 */
export function topReason(counts: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  for (const [k, v] of Object.entries(counts)) {
    if (v <= 0) continue;
    if (best === null || v > counts[best]! || (v === counts[best] && k < best)) best = k;
  }
  return best;
}
