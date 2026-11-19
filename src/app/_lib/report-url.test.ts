import { describe, expect, it } from "vitest";
import { changedFilters, exportHref, pageOf, parseId, reportHref, reportQueryOf, tabOf, toFilter } from "./report-url";

describe("reportQueryOf：只认识的键，其余丢掉", () => {
  it("取第一个值；空串不要；未知键不往下带", () => {
    expect(reportQueryOf({ tab: "accounts", page: ["2", "3"], evil: "x", q: "" })).toEqual({ tab: "accounts", page: "2" });
  });
  it("tab 只有 accounts 才是账号维度；page 非法回到 1", () => {
    expect(tabOf({ tab: "accounts" })).toBe("accounts");
    expect(tabOf({ tab: "videos" })).toBe("videos");
    expect(tabOf({ tab: "evil" })).toBe("videos");
    expect([pageOf({ page: "3" }), pageOf({ page: "0" }), pageOf({ page: "x" }), pageOf({ page: "1.5" }), pageOf({})]).toEqual([3, 1, 1, 1, 1]);
  });
});
describe("reportHref", () => {
  it("默认值不写进 URL", () => {
    expect(reportHref("12", {}, {})).toBe("/reports/12");
    expect(reportHref("12", { tab: "accounts" }, { tab: "videos" })).toBe("/reports/12");
    expect(reportHref("12", {}, { page: "1" })).toBe("/reports/12");
    expect(reportHref("12", { branch: "5" }, { branch: "all" })).toBe("/reports/12");
  });
  it("改任何筛选回到第 1 页；只翻页保留筛选", () => {
    expect(reportHref("12", { branch: "5", page: "4" }, { sector: "2" })).toBe("/reports/12?branch=5&sector=2");
    expect(reportHref("12", { branch: "5", page: "4" }, { page: "5" })).toBe("/reports/12?branch=5&page=5");
  });
  it("换大区清掉分公司与门店；换分公司清掉门店；板块不受影响", () => {
    expect(reportHref("12", { region: "1", branch: "5", store: "9", sector: "2" }, { region: "3" })).toBe("/reports/12?region=3&sector=2");
    expect(reportHref("12", { region: "1", branch: "5", store: "9" }, { branch: "6" })).toBe("/reports/12?region=1&branch=6");
  });
  it("换执行：组织筛选与页码不带过去，标签保留", () => {
    expect(reportHref("12", { tab: "accounts", branch: "5", q: "老孙", page: "3" }, { run: "77" })).toBe("/reports/12?tab=accounts&run=77");
  });
  it("换标签回到第 1 页并保留筛选", () => {
    expect(reportHref("12", { branch: "5", page: "3" }, { tab: "accounts" })).toBe("/reports/12?tab=accounts&branch=5");
  });
});
describe("导出链接与筛选转换", () => {
  it("导出只带执行与筛选，不带标签与页码；预览加 preview=1", () => {
    expect(exportHref("12", { tab: "accounts", page: "3", run: "77", branch: "5", q: "老孙" })).toBe("/reports/12/export?run=77&branch=5&q=%E8%80%81%E5%AD%99");
    expect(exportHref("12", {}, true)).toBe("/reports/12/export?preview=1");
  });
  it("toFilter / changedFilters / parseId", () => {
    expect(toFilter({ region: "1", q: "x", tab: "accounts", page: "2" })).toEqual({ regionId: "1", staffQuery: "x" });
    expect(changedFilters({ region: "1", q: "x", tab: "accounts", page: "2", run: "5" })).toBe(2);
    expect([parseId("12"), parseId("0"), parseId("abc"), parseId("1".repeat(20))]).toEqual(["12", null, null, null]);
  });
});
