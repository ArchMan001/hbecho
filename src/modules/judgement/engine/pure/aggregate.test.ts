import { describe, expect, it } from "vitest";
import { commentOutcome, contentCounts, contentOutcome, topReason, type ContentRowLite, type ZeroContext } from "./aggregate";

const rows = (spec: Record<string, number>): ContentRowLite[] => Object.entries(spec).flatMap(([final, n]) => Array.from({ length: n }, () => ({ final: final as ContentRowLite["final"] })));
const ZERO_OK: ZeroContext = { syncComplete: true, syncReason: null };
const ZERO_GAP: ZeroContext = { syncComplete: false, syncReason: "sync_gap" };

describe("contentCounts", () => {
  it("P / U / F 取最终结果；skipped 单独计数不入 T；rows 是参与内容行数", () => {
    const c = contentCounts(rows({ pass: 3, unobtained: 2, fail: 4, skipped: 5 }));
    expect(c).toEqual({ p: 3, u: 2, f: 4, skipped: 5, rows: 14 });
  });
  it("仍有未评估的行 → 抛错（聚合只在全部层评估完之后）", () => expect(() => contentCounts([{ final: null }])).toThrow());
});

describe("contentOutcome（内容要求：at_least_n N，N 缺省 1）", () => {
  it("N=5：5 条全通过 → 成功；其中 1 条不通过 → 不达标（第 6 名不替补）", () => {
    expect(contentOutcome(contentCounts(rows({ pass: 5, skipped: 5 })), 5, ZERO_OK).result).toBe("success");
    expect(contentOutcome(contentCounts(rows({ pass: 4, fail: 1, skipped: 5 })), 5, ZERO_OK).result).toBe("not_met");
  });
  it("N=3：2 条通过 + 1 条第 1 层未获取 → 未获取成功，不是不达标", () => {
    expect(contentOutcome(contentCounts(rows({ pass: 2, unobtained: 1 })), 3, ZERO_OK).result).toBe("unobtained");
  });
  it("N=3：参与内容 10 条都没命中话题 → 不达标，即使同步有缺口（T>0 不走零内容）", () => {
    const r = contentOutcome(contentCounts(rows({ fail: 10 })), 3, ZERO_GAP);
    expect(r).toEqual({ result: "not_met" });
  });
  it("N 不足：候选只有 4 条且全通过、N=6 → 不达标", () => {
    expect(contentOutcome(contentCounts(rows({ pass: 4 })), 6, ZERO_OK).result).toBe("not_met");
  });
  it("N 缺省 → 至少 1 条", () => {
    expect(contentOutcome(contentCounts(rows({ pass: 1, fail: 9 })), undefined, ZERO_OK).result).toBe("success");
    expect(contentOutcome(contentCounts(rows({ fail: 3 })), undefined, ZERO_OK).result).toBe("not_met");
  });
  it("零内容 = 参与内容 0 行：同步完整 → 不达标；有缺口 / 失败 → 未获取成功并带原因", () => {
    expect(contentOutcome(contentCounts([]), 3, ZERO_OK)).toEqual({ result: "not_met" });
    expect(contentOutcome(contentCounts([]), 3, ZERO_GAP)).toEqual({ result: "unobtained", reason: "sync_gap" });
    expect(contentOutcome(contentCounts([]), 3, { syncComplete: false, syncReason: "sync_failed" })).toEqual({ result: "unobtained", reason: "sync_failed" });
    expect(contentOutcome(contentCounts([]), 3, { syncComplete: false, syncReason: "no_sync_in_window" }).reason).toBe("no_sync_in_window");
  });
});

describe("commentOutcome", () => {
  const zero = { p: 0, u: 0, f: 0 };
  const m = { type: "at_least_n" as const, n: 3 };
  it("至少 3 条评论含关键词：命中 2 + 缺口 1 → 未获取；命中 2 + 覆盖完整 → 不达标", () => {
    const ctx = { candidateUnobtained: false, participantContentRows: 5, zero: ZERO_OK };
    expect(commentOutcome(m, { p: 2, u: 1, f: 0 }, ctx).result).toBe("unobtained");
    expect(commentOutcome(m, { p: 2, u: 0, f: 4 }, ctx).result).toBe("not_met");
  });
  it("评论候选为空：有候选在第 1、2 层未获取 → 未获取；没有参与内容 → 零内容规则；其余 → 不达标", () => {
    expect(commentOutcome(m, zero, { candidateUnobtained: true, participantContentRows: 5, zero: ZERO_OK })).toEqual({ result: "unobtained", reason: "candidate_unobtained" });
    expect(commentOutcome(m, zero, { candidateUnobtained: false, participantContentRows: 0, zero: ZERO_GAP })).toEqual({ result: "unobtained", reason: "sync_gap" });
    expect(commentOutcome(m, zero, { candidateUnobtained: false, participantContentRows: 0, zero: ZERO_OK }).result).toBe("not_met");
    expect(commentOutcome(m, zero, { candidateUnobtained: false, participantContentRows: 5, zero: ZERO_GAP }).result).toBe("not_met");
  });
});

describe("topReason", () => {
  it("条数最多；并列取字典序；全 0 → null", () => {
    expect(topReason({ media_failed: 3, not_computed: 5 })).toBe("not_computed");
    expect(topReason({ b: 2, a: 2, c: 1 })).toBe("a");
    expect(topReason({ x: 0 })).toBeNull();
    expect(topReason({})).toBeNull();
  });
});
