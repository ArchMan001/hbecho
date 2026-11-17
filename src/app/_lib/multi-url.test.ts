import { describe, expect, it } from "vitest";
import { hrefMulti, toggled, valuesOf } from "./multi-url";

describe("multi-url", () => {
  it("valuesOf 把单值、重复值、缺省归一成数组，并丢掉空串", () => {
    expect(valuesOf(undefined)).toEqual([]);
    expect(valuesOf("1")).toEqual(["1"]);
    expect(valuesOf(["1", "2"])).toEqual(["1", "2"]);
    expect(valuesOf(["", "2"])).toEqual(["2"]);
  });
  it("toggled 加入或去掉一个值，不改原数组", () => {
    const a = ["1", "2"];
    expect(toggled(a, "3")).toEqual(["1", "2", "3"]);
    expect(toggled(a, "1")).toEqual(["2"]);
    expect(a).toEqual(["1", "2"]);
  });
  it("hrefMulti：重复参数、覆盖、清空；空值与 all 不进 URL", () => {
    expect(hrefMulti("/x", { brand: ["1", "2"], kw: "a" }, { page: "2" })).toBe("/x?brand=1&brand=2&kw=a&page=2");
    expect(hrefMulti("/x", { brand: ["1", "2"] }, { brand: ["2"] })).toBe("/x?brand=2");
    expect(hrefMulti("/x", { brand: ["1"], status: "all" }, { brand: [] })).toBe("/x");
    expect(hrefMulti("/x", { kw: "a b" }, {})).toBe("/x?kw=a+b");
  });
});
