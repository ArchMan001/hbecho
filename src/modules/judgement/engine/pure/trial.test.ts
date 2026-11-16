import { describe, expect, it } from "vitest";
import { bucketize, bucketOf, passCount } from "./trial";

describe("试跑报告", () => {
  it("分档：0.00 → 档 0；9.99 → 档 9；10.00 → 档 10；1.00 → 档 1", () => {
    expect([0, 99, 100, 999, 1000].map(bucketOf)).toEqual([0, 0, 1, 9, 10]);
    expect(() => bucketOf(1001)).toThrow();
    expect(() => bucketOf(-1)).toThrow();
  });
  it("每档至多 5 个样例，按内容 ID 升序，确定；不足时只返回实际数量", () => {
    const scores = Array.from({ length: 8 }, (_, i) => ({ id: BigInt(8 - i), cents: 650 }));
    scores.push({ id: 100n, cents: 1000 }, { id: 101n, cents: 0 });
    const r = bucketize(scores);
    expect(r.counts[6]).toBe(8);
    expect(r.samples[6]).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(r.samples[10]).toEqual([100n]);
    expect(r.samples[0]).toEqual([101n]);
    expect(r.samples[3]).toEqual([]);
    expect(r.counts.reduce((a, b) => a + b, 0)).toBe(10);
  });
  it("换阈值只重算通过数（等于阈值通过）", () => {
    const s = [{ id: 1n, cents: 650 }, { id: 2n, cents: 649 }, { id: 3n, cents: 900 }];
    expect(passCount(s, 650)).toBe(2);
    expect(passCount(s, 700)).toBe(1);
    expect(passCount(s, 0)).toBe(3);
  });
});
