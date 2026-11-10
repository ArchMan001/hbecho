import { describe, expect, it } from "vitest";
import { isCanonicalPhone, normalizePhone } from "./index";

describe("normalizePhone（cn-mobile.v1）", () => {
  it.each([
    ["13800000001", "13800000001"],
    [" 138 0000 0001 ", "13800000001"],
    ["138-0000-0001", "13800000001"],
    ["138\u00a00000\u00a00001", "13800000001"],
    ["+8613800000001", "13800000001"],
    ["+86 138 0000 0001", "13800000001"],
    ["008613800000001", "13800000001"],
    ["8613800000001", "13800000001"],
  ])("合法：%j → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ["科学计数法", "1.38E+10"],
    ["10 位", "1380000000"],
    ["12 位", "138000000011"],
    ["非 1[3-9] 开头", "12800000001"],
    ["以 0 开头", "03800000001"],
    ["含字母", "1380000000a"],
    ["空串", ""],
    ["只有空白", "   "],
    ["墓碑值", "disabled:12"],
    ["86 开头但长度不对", "861380000001"],
    ["+86 后仍不合法", "+8612800000001"],
  ])("无效：%s", (_name, input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("规范化是幂等的", () => {
    const once = normalizePhone("+86 138-0000-0001")!;
    expect(normalizePhone(once)).toBe(once);
  });

  it("isCanonicalPhone 只认规范形态", () => {
    expect(isCanonicalPhone("13800000001")).toBe(true);
    expect(isCanonicalPhone("+8613800000001")).toBe(false);
    expect(isCanonicalPhone("138 0000 0001")).toBe(false);
  });
});
