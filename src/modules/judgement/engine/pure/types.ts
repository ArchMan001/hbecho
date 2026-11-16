// d-rule-engine 纯函数层的共用类型。这里没有 IO，也不依赖 C 的类型细节：只要求信号值满足 SignalLike 这个最小接口。
/** 内容在某一层（或最终）的三值结果。 */
export type Tri = "pass" | "fail" | "unobtained";
/** 专员级结果（PRD D §1.4）。 */
export type Outcome = "success" | "not_met" | "unobtained";
/** C 的 SignalValue 的最小子集（compose.ts）。 */
export interface SignalLike {
  state: "valid" | "stale" | "failed" | "missing" | "not_applicable";
  /** valid 为真；stale 由 stalePolicy 决定（D 一律 use_stale，所以 stale 可用）。 */
  usable: boolean;
  normalizerVersion?: number;
  value?: unknown;
  score?: number;
  reason?: string;
  pending?: "queued" | "running" | "dead";
  resultId?: bigint;
  evidence?: unknown;
}
/** 单个条件的求值结果。`awaiting` = 还在等依赖（下个 tick 重读），不是终态。 */
export interface CondResult {
  state: Tri;
  reason?: string;
  awaiting?: boolean;
  stale?: boolean;
  /** 证据摘要（命中的词 / 话题、分数、结论）；不含正文原文。 */
  detail?: Record<string, unknown>;
}
export type NormalizeFn = (raw: string, version?: number) => string;
