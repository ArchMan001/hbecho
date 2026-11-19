// f-video-square 任务 4：筛选校验与小工具的边界（requirements R4、R5.3；acceptance A7–A10、A12、A14）。
import { describe, expect, it } from "vitest";
import { escapeLike, kindsOf, LIKE_BANDS, parseSquareFilter, watchUrlOf } from "./filter";
import { isSquareError } from "./errors";

const codeOf = (raw: Record<string, string | undefined>): string | undefined => {
  try {
    parseSquareFilter(raw);
  } catch (e) {
    return isSquareError(e) ? e.code : "other";
  }
  return undefined;
};

describe("parseSquareFilter", () => {
  it("缺省：视频、第 1 页，其余不筛；'all' 与空串等于不筛", () => {
    expect(parseSquareFilter({})).toEqual({ kind: "video", page: 1 });
    expect(parseSquareFilter({ brand: "all", platform: "", kind: "", within: "all", like: "all", branch: "all", plan: "all" })).toEqual({ kind: "video", page: 1 });
  });
  it("合法取值逐项解析", () => {
    const f = parseSquareFilter({ brand: "12", platform: "xiaohongshu", kind: "all", branch: "3", within: "30", like: "301-500", q: "  日立 ", page: "4" });
    expect(f).toEqual({ kind: "all", page: 4, brandId: 12n, platformCode: "xiaohongshu", branchId: 3n, withinDays: 30, likeBand: "301-500", q: "日立" });
  });
  it("非法取值一律 invalid_filter，不当作全部", () => {
    for (const bad of [{ kind: "audio" }, { platform: "weishi" }, { platform: "视频号" }, { brand: "abc" }, { brand: "0" }, { brand: "01" }, { brand: "9223372036854775808" }, { branch: "-1" }, { within: "14" }, { within: "7.0" }, { like: "0-50" }, { like: "constructor" }, { page: "0" }, { page: "x" }, { page: "1000000" }]) {
      expect(codeOf(bad), JSON.stringify(bad)).toBe("invalid_filter");
    }
  });
  it("搜索词：100 字可以、101 字报错（按字计，不截断）；全空白等于没有", () => {
    expect(parseSquareFilter({ q: "一".repeat(100) }).q).toHaveLength(100);
    expect(codeOf({ q: "一".repeat(101) })).toBe("invalid_filter");
    expect(codeOf({ q: "😀".repeat(101) })).toBe("invalid_filter");
    expect(parseSquareFilter({ q: "   " }).q).toBeUndefined();
  });
  it("活动计划参数：本切片内拒绝，不忽略", () => {
    expect(codeOf({ plan: "7" })).toBe("plan_filter_unavailable");
  });
});

describe("点赞区间与类型", () => {
  it("区间含两端，相邻区间不重叠；500 以上从 501 起", () => {
    expect(LIKE_BANDS["51-100"]).toEqual([51n, 100n]);
    expect(LIKE_BANDS["101-300"]).toEqual([101n, 300n]);
    expect(LIKE_BANDS["301-500"]).toEqual([301n, 500n]);
    expect(LIKE_BANDS["501+"]).toEqual([501n, null]);
  });
  it("视频 = video；图文 = image + text；全部不含 unknown", () => {
    expect(kindsOf("video")).toEqual(["video"]);
    expect(kindsOf("image")).toEqual(["image", "text"]);
    expect(kindsOf("all")).not.toContain("unknown");
  });
});

describe("escapeLike", () => {
  it("% _ \\ 按字面处理", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });
});

describe("watchUrlOf", () => {
  it("只放行 http / https", () => {
    expect(watchUrlOf("https://www.douyin.com/video/1")).toBe("https://www.douyin.com/video/1");
    expect(watchUrlOf(" http://a.test/x ")).toBe("http://a.test/x");
  });
  it("javascript: / data: / 无协议 / 空值 → null", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//a.test/x", "a.test/x", "", "   ", null, undefined, "ftp://a.test/x"]) {
      expect(watchUrlOf(bad as never), String(bad)).toBeNull();
    }
  });
});
