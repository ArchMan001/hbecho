import { describe, expect, it } from "vitest";
import { bjtDate, endStopAt, entryReferencing, entryStopAt, planReferencing } from "./rules";

const plan = (over: Partial<Parameters<typeof entryStopAt>[1]> = {}) => ({ status: "collecting", endsOn: null, statusChangedAt: new Date("2026-11-01T00:00:00Z"), deletedAt: null, ...over });
const T = (s: string) => new Date(s);

describe("北京时间日期", () => {
  it("UTC 日界与北京日界不同", () => {
    expect(bjtDate(T("2026-11-10T15:59:59Z"))).toBe("2026-11-10");
    expect(bjtDate(T("2026-11-10T16:00:00Z"))).toBe("2026-11-11");
  });
  it("结束日次日 00:00 北京 = 结束日 16:00 UTC", () => {
    expect(endStopAt("2026-11-10").toISOString()).toBe("2026-11-10T16:00:00.000Z");
    expect(endStopAt("2026-12-31").toISOString()).toBe("2026-12-31T16:00:00.000Z");
  });
});

describe("引用定义：结束日当天仍算引用", () => {
  it.each([
    ["结束日前一天", "2026-11-12", true],
    ["结束日当天", "2026-11-11", true],
    ["结束日后一天", "2026-11-10", false],
  ])("%s", (_n, endsOn, expected) => {
    expect(planReferencing({ status: "collecting", endsOn }, "2026-11-11")).toBe(expected);
  });
  it("无结束日持续引用", () => {
    expect(planReferencing({ status: "collecting", endsOn: null }, "2099-01-01")).toBe(true);
  });
  it.each(["paused", "archived", "deleted"])("%s 的计划不算引用", (status) => {
    expect(planReferencing({ status, endsOn: null }, "2026-11-11")).toBe(false);
  });
  it("已移出的名单项不算引用", () => {
    expect(entryReferencing({ entryState: "removed", removedAt: new Date() }, { status: "collecting", endsOn: null }, "2026-11-11")).toBe(false);
    expect(entryReferencing({ entryState: "in_roster", removedAt: null }, { status: "collecting", endsOn: null }, "2026-11-11")).toBe(true);
  });
});

describe("entryStopAt：不再被引用的时刻", () => {
  const now = T("2026-11-20T00:00:00Z");
  const inRoster = { entryState: "in_roster", removedAt: null };
  it("仍在引用 → null", () => {
    expect(entryStopAt(inRoster, plan({ endsOn: "2026-12-01" }), now)).toBeNull();
    expect(entryStopAt(inRoster, plan(), now)).toBeNull();
  });
  it("暂停 / 归档取状态变更时间；删除取删除时间；移出取移出时间", () => {
    expect(entryStopAt(inRoster, plan({ status: "paused", statusChangedAt: T("2026-11-05T00:00:00Z") }), now)?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(entryStopAt(inRoster, plan({ status: "deleted", deletedAt: T("2026-11-06T00:00:00Z") }), now)?.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(entryStopAt({ entryState: "removed", removedAt: T("2026-11-07T00:00:00Z") }, plan(), now)?.toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });
  it("自然过结束日取结束日次日北京 00:00；结束日还没到则不是原因", () => {
    expect(entryStopAt(inRoster, plan({ endsOn: "2026-11-10" }), now)?.toISOString()).toBe("2026-11-10T16:00:00.000Z");
    expect(entryStopAt(inRoster, plan({ status: "paused", statusChangedAt: T("2026-11-05T00:00:00Z"), endsOn: "2026-12-01" }), now)?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });
  it("多个原因取最早的", () => {
    const p = plan({ status: "deleted", deletedAt: T("2026-11-09T00:00:00Z") });
    expect(entryStopAt({ entryState: "removed", removedAt: T("2026-11-03T00:00:00Z") }, p, now)?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });
});
