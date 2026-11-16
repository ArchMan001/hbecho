// 试跑报告（design §7.10）：连续 0.00–10.00 分的 11 档分布与固定每档至多 5 个样例。
export const BUCKETS = 11;
export const SAMPLES_PER_BUCKET = 5;
export interface Scored {
  id: bigint;
  /** 整数百分位 0–1000 */
  cents: number;
}
/** 档 k = [k, k+1)，k = 0..9；档 10 = [10.00]。 */
export const bucketOf = (cents: number): number => {
  if (!Number.isInteger(cents) || cents < 0 || cents > 1000) throw new Error(`分数超出 0.00–10.00：${cents}`);
  return cents === 1000 ? 10 : Math.floor(cents / 100);
};
export function bucketize(scores: readonly Scored[]): { counts: number[]; samples: bigint[][] } {
  const counts = Array<number>(BUCKETS).fill(0);
  const samples: bigint[][] = Array.from({ length: BUCKETS }, () => []);
  for (const s of [...scores].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = bucketOf(s.cents);
    counts[k]!++;
    if (samples[k]!.length < SAMPLES_PER_BUCKET) samples[k]!.push(s.id);
  }
  return { counts, samples };
}
/** 用当前阈值重算通过数（换阈值无需重新试跑）。 */
export const passCount = (scores: readonly Scored[], thresholdCents: number): number => scores.filter((s) => s.cents >= thresholdCents).length;
