// 条件求值（design §7.4）：每个函数返回 pass / fail / unobtained。关键词与话题按 C 的归一化版本比较，保存的是原文。
import { fromSignal, type SignalInput } from "./signal";
import type { CondResult, NormalizeFn, SignalLike } from "./types";

export type CombineMode = "all" | "any";

const unobtainedOf = (inputs: Array<Extract<SignalInput, { kind: "unobtained" }>>): Pick<CondResult, "reason" | "awaiting"> => ({
  reason: inputs[0]!.reason,
  awaiting: inputs.every((i) => i.awaiting),
});

/**
 * 关键词：所选字段中任一字段含该词即命中该词。all = 每个词都命中；any = 至少一个词命中。
 * 单调：不可用字段不会把本该 pass 的变成 unobtained；只有「现有证据下不 pass，但可用字段补齐后可能 pass」才是 unobtained。
 */
export function evalKeywords(
  cfg: { fields: ReadonlyArray<"title" | "body">; mode: CombineMode; keywords: readonly string[] },
  signals: Partial<Record<"title" | "body", SignalLike>>,
  normalize: NormalizeFn,
): CondResult {
  const usable: Array<{ text: string; version?: number }> = [];
  const lost: Array<Extract<SignalInput, { kind: "unobtained" }>> = [];
  let stale = false;
  for (const f of cfg.fields) {
    const sig = signals[f];
    const input: SignalInput = sig ? fromSignal(sig) : { kind: "unobtained", reason: "not_computed", awaiting: true };
    if (input.kind === "value" && typeof input.value === "string") {
      stale ||= input.stale;
      usable.push({ text: input.value, ...(input.normalizerVersion === undefined ? {} : { version: input.normalizerVersion }) });
    } else if (input.kind === "unobtained") lost.push(input);
    else lost.push({ kind: "unobtained", reason: "invalid_signal_value", awaiting: false });
  }
  const hit = cfg.keywords.filter((kw) => usable.some((u) => u.text.includes(normalize(kw, u.version))));
  const pass = cfg.mode === "all" ? hit.length === cfg.keywords.length : hit.length > 0;
  const base = { ...(stale ? { stale: true } : {}), detail: { hit } };
  if (pass) return { state: "pass", ...base };
  if (lost.length > 0) return { state: "unobtained", ...unobtainedOf(lost), ...base };
  return { state: "fail", ...base };
}

/** 话题：与配置话题（去首尾 # 与空白、归一化）做整体相等比较，不做子串。 */
export function stripHash(raw: string): string {
  return raw.trim().replace(/^#+/, "").replace(/#+$/, "").trim();
}
export function evalHashtags(cfg: { mode: CombineMode; values: readonly string[] }, sig: SignalLike, normalize: NormalizeFn): CondResult {
  const input = fromSignal(sig);
  if (input.kind === "unobtained") return { state: "unobtained", reason: input.reason, awaiting: input.awaiting };
  if (!Array.isArray(input.value) || input.value.some((x) => typeof x !== "string")) return { state: "unobtained", reason: "invalid_signal_value" };
  const have = new Set((input.value as string[]).map((t) => normalize(stripHash(t), input.normalizerVersion)));
  const hit = cfg.values.filter((v) => have.has(normalize(stripHash(v), input.normalizerVersion)));
  const pass = cfg.mode === "all" ? hit.length === cfg.values.length : hit.length > 0;
  return { state: pass ? "pass" : "fail", ...(input.stale ? { stale: true } : {}), detail: { hit } };
}

/** 时长取冻结快照：必须 state=value 且单位已知（秒）才可比较；真实 0 秒是有效值；含边界。 */
export function evalDuration(
  cfg: { minSeconds?: number | undefined; maxSeconds?: number | undefined },
  snap: { state: string; value: string | number | null; unit: string },
): CondResult {
  if (snap.state !== "value" || snap.value === null) return { state: "unobtained", reason: "duration_missing" };
  if (snap.unit !== "seconds") return { state: "unobtained", reason: "duration_unit_unknown" };
  const seconds = Number(snap.value);
  if (!Number.isFinite(seconds)) return { state: "unobtained", reason: "duration_missing" };
  const ok = (cfg.minSeconds === undefined || seconds >= cfg.minSeconds) && (cfg.maxSeconds === undefined || seconds <= cfg.maxSeconds);
  return { state: ok ? "pass" : "fail", detail: { seconds: String(snap.value) } };
}

/** 分数字符串（"8" / "8.5" / "8.00"）→ 整数百分位；格式不合法或超出 0–10 抛错（配置校验期就该挡住）。 */
export function thresholdToCents(text: string): number {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) throw new Error(`阈值格式不合法：${text}`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (cents > 1000) throw new Error(`阈值超出 0.00–10.00：${text}`);
  return cents;
}
/** C 给的 score 是 number（来自 DECIMAL(4,2)，恰为两位小数）；这是读取边界唯一的浮点→整数转换，之后全部整数比较。 */
export const scoreToCents = (score: number): number => Math.round(score * 100);
export const centsToText = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function evalScore(thresholdCents: number, sig: SignalLike): CondResult {
  const input = fromSignal(sig);
  if (input.kind === "unobtained") return { state: "unobtained", reason: input.reason, awaiting: input.awaiting };
  if (typeof sig.score !== "number") return { state: "unobtained", reason: "invalid_signal_value" };
  const cents = scoreToCents(sig.score);
  return { state: cents >= thresholdCents ? "pass" : "fail", ...(input.stale ? { stale: true } : {}), detail: { score: centsToText(cents) } };
}

/** ASR 判定：meets → 通过；not_meets → 不通过；C 的 failed → 未获取成功（不是不通过）。 */
export function evalAsr(sig: SignalLike): CondResult {
  const input = fromSignal(sig);
  if (input.kind === "unobtained") return { state: "unobtained", reason: input.reason, awaiting: input.awaiting };
  const v = input.value as { verdict?: unknown; reason?: unknown } | null | undefined;
  if (v?.verdict === "meets") return { state: "pass", ...(input.stale ? { stale: true } : {}), detail: { verdict: "meets" } };
  if (v?.verdict === "not_meets") return { state: "fail", ...(input.stale ? { stale: true } : {}), detail: { verdict: "not_meets" } };
  return { state: "unobtained", reason: "invalid_output" };
}
