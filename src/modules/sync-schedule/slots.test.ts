import { describe, expect, it } from "vitest";
import { latestSlotAtOrBefore, nextSlotAfter, slotsSchema, weekStart, type Slot } from "./slots";

// 北京时间 = UTC + 8。2026-11-02 是周一。
const bj = (s: string) => new Date(`${s}+08:00`);
const iso = (d: Date) => d.toISOString();
const monday2: Slot[] = [{ weekday: 1, time: "02:00" }];
const twice: Slot[] = [
  { weekday: 1, time: "02:00" },
  { weekday: 4, time: "02:00" },
];

describe("weekStart：北京时间周一 00:00", () => {
  it.each([
    ["周一 00:00 恰好", "2026-11-02T00:00:00", "2026-11-02T00:00:00"],
    ["周一 00:00 前 1 毫秒属于上一周", "2026-11-01T23:59:59.999", "2026-10-26T00:00:00"],
    ["周日 23:59 仍在本周", "2026-11-08T23:59:00", "2026-11-02T00:00:00"],
    ["周三中午", "2026-11-04T12:00:00", "2026-11-02T00:00:00"],
  ])("%s", (_n, input, expected) => {
    expect(iso(weekStart(bj(input)))).toBe(iso(bj(expected)));
  });
  it("UTC 与北京时间的日界不同：UTC 周日 17:00 已经是北京周一 01:00", () => {
    expect(iso(weekStart(new Date("2026-11-01T17:00:00Z")))).toBe(iso(bj("2026-11-02T00:00:00")));
  });
});

describe("latestSlotAtOrBefore / nextSlotAfter", () => {
  it("单时点：周一 02:00 当天各时刻", () => {
    expect(iso(latestSlotAtOrBefore(bj("2026-11-02T02:00:00"), monday2))).toBe(iso(bj("2026-11-02T02:00:00")));
    expect(iso(latestSlotAtOrBefore(bj("2026-11-02T01:59:59"), monday2))).toBe(iso(bj("2026-10-26T02:00:00")));
    expect(iso(latestSlotAtOrBefore(bj("2026-11-05T09:00:00"), monday2))).toBe(iso(bj("2026-11-02T02:00:00")));
  });
  it("周日 23:59 与周一 00:00 边界：最近时点都是本周一 02:00 之前的那一个", () => {
    expect(iso(latestSlotAtOrBefore(bj("2026-11-08T23:59:00"), monday2))).toBe(iso(bj("2026-11-02T02:00:00")));
    expect(iso(latestSlotAtOrBefore(bj("2026-11-09T00:00:00"), monday2))).toBe(iso(bj("2026-11-02T02:00:00")));
    expect(iso(latestSlotAtOrBefore(bj("2026-11-09T02:00:00"), monday2))).toBe(iso(bj("2026-11-09T02:00:00")));
  });
  it("两个时点（周一、周四 02:00）：跨周也正确，且每个时点各一个", () => {
    expect(iso(latestSlotAtOrBefore(bj("2026-11-04T01:00:00"), twice))).toBe(iso(bj("2026-11-02T02:00:00")));
    expect(iso(latestSlotAtOrBefore(bj("2026-11-05T02:00:00"), twice))).toBe(iso(bj("2026-11-05T02:00:00")));
    expect(iso(latestSlotAtOrBefore(bj("2026-11-09T01:00:00"), twice))).toBe(iso(bj("2026-11-05T02:00:00")));
    expect(iso(nextSlotAfter(bj("2026-11-02T02:00:00"), twice))).toBe(iso(bj("2026-11-05T02:00:00")));
    expect(iso(nextSlotAfter(bj("2026-11-05T02:00:00"), twice))).toBe(iso(bj("2026-11-09T02:00:00")));
  });
  it("nextSlotAfter 严格晚于输入；周日 23:59 的下一个时点是下周一 02:00", () => {
    expect(iso(nextSlotAfter(bj("2026-11-02T02:00:00"), monday2))).toBe(iso(bj("2026-11-09T02:00:00")));
    expect(iso(nextSlotAfter(bj("2026-11-08T23:59:00"), monday2))).toBe(iso(bj("2026-11-09T02:00:00")));
  });
  it("周日 23:30 的时点（weekday=7）", () => {
    const sun: Slot[] = [{ weekday: 7, time: "23:30" }];
    expect(iso(latestSlotAtOrBefore(bj("2026-11-08T23:30:00"), sun))).toBe(iso(bj("2026-11-08T23:30:00")));
    expect(iso(latestSlotAtOrBefore(bj("2026-11-08T23:29:59"), sun))).toBe(iso(bj("2026-11-01T23:30:00")));
  });
});

describe("slotsSchema：每周 1–2 个时点", () => {
  it("接受 1 或 2 个合法时点", () => {
    expect(slotsSchema.safeParse(monday2).success).toBe(true);
    expect(slotsSchema.safeParse(twice).success).toBe(true);
  });
  it.each([
    ["空", []],
    ["三个", [...twice, { weekday: 6, time: "02:00" }]],
    ["重复", [monday2[0], monday2[0]]],
    ["weekday 越界", [{ weekday: 0, time: "02:00" }]],
    ["时间格式", [{ weekday: 1, time: "2:00" }]],
    ["24:00", [{ weekday: 1, time: "24:00" }]],
    ["多余字段", [{ weekday: 1, time: "02:00", tz: "UTC" }]],
  ])("拒绝：%s", (_n, v) => {
    expect(slotsSchema.safeParse(v).success).toBe(false);
  });
});
