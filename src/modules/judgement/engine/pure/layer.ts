// 层求值与逐层推进（design §7.4）。
import { and3 } from "./tri";
import type { CondResult, Tri } from "./types";

export type LayerState = Tri | "not_configured" | "waiting";
export interface LayerResult {
  state: LayerState;
  reason?: string;
  stale: boolean;
}

/**
 * 同层多个条件作用在同一条内容上：任一 fail → 层 fail（即使其余还在等，提前终止）；
 * 否则任一条件还在等 → waiting（本层仍待办，下个 tick 重读）；否则 AND3。空层 = not_configured。
 */
export function combineLayer(results: readonly CondResult[]): LayerResult {
  if (results.length === 0) return { state: "not_configured", stale: false };
  const stale = results.some((r) => r.stale === true);
  if (results.some((r) => r.state === "fail")) return { state: "fail", stale, ...firstReason(results, "fail") };
  if (results.some((r) => r.state === "unobtained" && r.awaiting === true)) return { state: "waiting", stale };
  const state = and3(results.map((r) => r.state));
  return { state, stale, ...(state === "unobtained" ? firstReason(results, "unobtained") : {}) };
}
const firstReason = (rs: readonly CondResult[], s: Tri): { reason?: string } => {
  const r = rs.find((x) => x.state === s)?.reason;
  return r === undefined ? {} : { reason: r };
};

export interface Progress {
  /** null = 还有层没评估完（待办）；否则内容的最终结果 */
  final: Tri | null;
  /** 停在第几层（0–3）；走完全部层为 null */
  stopLayer: 0 | 1 | 2 | 3 | null;
  reason?: string;
}
/**
 * 按 L0 → L1 → L2 → L3 顺序推进：pass / not_configured 继续；fail / unobtained 停住（后续层由调用方置 skipped）；
 * 遇到 waiting 或尚未评估（undefined）则内容仍待办。
 */
export function progressOf(layers: readonly [LayerResult | undefined, LayerResult | undefined, LayerResult | undefined, LayerResult | undefined]): Progress {
  for (let i = 0; i < 4; i++) {
    const l = layers[i];
    if (l === undefined || l.state === "waiting") return { final: null, stopLayer: null };
    if (l.state === "pass" || l.state === "not_configured") continue;
    return { final: l.state, stopLayer: i as 0 | 1 | 2 | 3, ...(l.reason === undefined ? {} : { reason: l.reason }) };
  }
  return { final: "pass", stopLayer: null };
}
