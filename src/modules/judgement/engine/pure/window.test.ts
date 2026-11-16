import { describe, expect, it } from "vitest";
import { bjtDayStartUtc, bjtDaysToUtc } from "./window";

describe("窗口换算", () => {
  it("北京日 00:00+08 = 前一日 16:00Z", () => expect(bjtDayStartUtc("2026-11-01").toISOString()).toBe("2026-10-31T16:00:00.000Z"));
  it("to = 2026-11-10 的闭区间 → 上界是 11 日 00:00+08（= 10 日 16:00Z）", () => {
    const { fromUtc, toUtc } = bjtDaysToUtc({ from: "2026-11-01", to: "2026-11-10" }, new Date("2026-12-01T00:00:00Z"));
    expect(fromUtc.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(toUtc.toISOString()).toBe("2026-11-10T16:00:00.000Z");
  });
  it("to 缺省 → 上界 = 冻结时刻；to 还没到 → 取冻结时刻（min）", () => {
    const frozen = new Date("2026-11-05T03:04:05.000Z");
    expect(bjtDaysToUtc({ from: "2026-11-01" }, frozen).toUtc).toEqual(frozen);
    expect(bjtDaysToUtc({ from: "2026-11-01", to: "2026-11-30" }, frozen).toUtc).toEqual(frozen);
  });
  it("跨月、跨年、闰日", () => {
    expect(bjtDaysToUtc({ from: "2026-12-31", to: "2026-12-31" }, new Date("2027-06-01Z")).toUtc.toISOString()).toBe("2026-12-31T16:00:00.000Z");
    expect(bjtDayStartUtc("2028-02-29").toISOString()).toBe("2028-02-28T16:00:00.000Z");
  });
  it("非法日期抛错", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "abc", "2026-11-31"]) expect(() => bjtDayStartUtc(bad), bad).toThrow();
  });
});
