import { describe, expect, it } from "vitest";
import { brandTone, changedCount, daysAgo, fmtCount, squareHref, squareQueryOf } from "./square-url";

describe("squareHref", () => {
  it("默认值不进 URL：全部、视频、第 1 页", () => {
    expect(squareHref({}, {})).toBe("/square");
    expect(squareHref({ brand: "3" }, { brand: "all" })).toBe("/square");
    expect(squareHref({}, { kind: "video" })).toBe("/square");
    expect(squareHref({ page: "2" }, { page: "1" })).toBe("/square");
  });
  it("「全部类型」(kind=all) 必须保留，否则回落成默认的视频", () => {
    expect(squareHref({}, { kind: "all" })).toBe("/square?kind=all");
    expect(squareHref({ kind: "all", brand: "3" }, { platform: "douyin" })).toBe("/square?brand=3&platform=douyin&kind=all");
  });
  it("改任何筛选都回到第 1 页；只改页码则保留其他条件", () => {
    expect(squareHref({ brand: "3", page: "4" }, { platform: "douyin" })).toBe("/square?brand=3&platform=douyin");
    expect(squareHref({ brand: "3", page: "4" }, { page: "5" })).toBe("/square?brand=3&page=5");
  });
  it("搜索词编码；去掉某项用 undefined", () => {
    expect(squareHref({}, { q: "100% 好评" })).toBe("/square?q=100%25+%E5%A5%BD%E8%AF%84");
    expect(squareHref({ q: "x", like: "51-100" }, { q: undefined })).toBe("/square?like=51-100");
  });
});

describe("squareQueryOf / changedCount", () => {
  it("只取认识的键，取数组首项，丢掉空值", () => {
    expect(squareQueryOf({ brand: ["3", "4"], evil: "x", q: "", like: "51-100" })).toEqual({ brand: "3", like: "51-100" });
  });
  it("角标：与默认不同的项数，页码不算", () => {
    expect(changedCount({})).toBe(0);
    expect(changedCount({ kind: "video", brand: "all", page: "3" })).toBe(0);
    expect(changedCount({ kind: "all", brand: "3", q: "a", within: "7" })).toBe(4);
  });
});

describe("显示小工具", () => {
  it("fmtCount", () => {
    expect(fmtCount("999")).toBe("999");
    expect(fmtCount("1234")).toBe("1,234");
    expect(fmtCount("20400")).toBe("2.0万");
  });
  it("brandTone", () => {
    expect([brandTone("日立"), brandTone("海信"), brandTone("约克VRF"), brandTone("科龙"), brandTone("美的")]).toEqual(["hitachi", "hisense", "york", "kelon", "plain"]);
  });
  it("daysAgo 按北京时间自然日", () => {
    const now = Date.parse("2026-11-19T02:00:00Z"); // 北京 10:00
    expect(daysAgo("2026-11-19T00:30:00Z", now)).toBe("今天");
    expect(daysAgo("2026-11-18T16:01:00Z", now)).toBe("今天"); // 北京 11-19 00:01
    expect(daysAgo("2026-11-18T15:59:00Z", now)).toBe("1 天前"); // 北京 11-18 23:59
    expect(daysAgo("2026-11-16T02:00:00Z", now)).toBe("3 天前");
    expect(daysAgo(null, now)).toBe("—");
  });
});
