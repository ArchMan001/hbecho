import { describe, expect, it } from "vitest";
import type { TypedCursor, ValueState } from "../provider-adapter";
import { coverageOf, decideAfterCommentsPage, isCompleteFetch } from "./policy";

const yes: ValueState<boolean> = { state: "value", value: true };
const no: ValueState<boolean> = { state: "value", value: false };
const str = (value: string): TypedCursor => ({ kind: "string", value });
const none = { pageLimit: null, itemLimit: null };

describe("评论翻页判定", () => {
  it.each([
    ["has_more=false → 自然结束（游标是否可用无关）", { hasMore: no, cursor: { kind: "string", value: "" } as TypedCursor }, { pages: 1, items: 5 }, none, { action: "stop", reason: "natural_end" }],
    ["has_more 缺失 / null / 非法 → 异常停止，不猜测", { hasMore: { state: "missing" } as ValueState<boolean>, cursor: str("20") }, { pages: 1, items: 5 }, none, { action: "stop", reason: "has_more_invalid" }],
    ["has_more=true 但游标是 no_more / null / 空串 → 游标异常", { hasMore: yes, cursor: { kind: "no_more" } as TypedCursor }, { pages: 1, items: 5 }, none, { action: "stop", reason: "cursor_anomaly" }],
    ["还有更多、未触达上限 → 继续，游标类型保真", { hasMore: yes, cursor: str("20") }, { pages: 1, items: 20 }, { pageLimit: 5, itemLimit: 100 }, { action: "continue", nextCursor: { kind: "string", value: "20" } }],
    ["整数游标不转字符串", { hasMore: yes, cursor: { kind: "integer", lexeme: "9007199254740993" } as TypedCursor }, { pages: 1, items: 1 }, none, { action: "continue", nextCursor: { kind: "integer", lexeme: "9007199254740993" } }],
    ["触达页数上限（还有更多）→ page_limit", { hasMore: yes, cursor: str("20") }, { pages: 2, items: 40 }, { pageLimit: 2, itemLimit: null }, { action: "stop", reason: "page_limit" }],
    ["触达条数上限（还有更多）→ item_limit", { hasMore: yes, cursor: str("20") }, { pages: 1, items: 20 }, { pageLimit: null, itemLimit: 20 }, { action: "stop", reason: "item_limit" }],
    ["恰好在上限页自然结束 → 仍是自然结束（读完了）", { hasMore: no, cursor: str("") }, { pages: 2, items: 40 }, { pageLimit: 2, itemLimit: 40 }, { action: "stop", reason: "natural_end" }],
  ] as const)("%s", (_n, page, totals, limits, expected) => {
    expect(decideAfterCommentsPage(page as never, totals, limits)).toEqual(expected);
  });
});

describe("完整性口径（FS-D08、D-50）", () => {
  it("抖音自然翻完 = 完整；小红书永远不完整；触达上限 / 异常 = 不完整", () => {
    expect(isCompleteFetch("douyin", "natural_end", 22, 125n)).toBe(true);
    expect(isCompleteFetch("xiaohongshu", "natural_end", 8, 8n)).toBe(false);
    for (const stop of ["page_limit", "item_limit", "cursor_anomaly", "has_more_invalid"] as const) expect(isCompleteFetch("douyin", stop, 20, 125n)).toBe(false);
  });
  it("total>0 却一条没抓到不可信，不算完整（不能据此把已有评论标成删除）", () => {
    expect(isCompleteFetch("douyin", "natural_end", 0, 5n)).toBe(false);
    expect(isCompleteFetch("douyin", "natural_end", 0, 0n)).toBe(true);
    expect(isCompleteFetch("douyin", "natural_end", 0, null)).toBe(true);
  });
  it("覆盖口径：完整 / 已知缺（触达上限或 total 更大）→ partial / 其余 unknown", () => {
    expect(coverageOf(true, 22, 125n, "natural_end")).toBe("complete");
    expect(coverageOf(false, 2, 28n, "natural_end")).toBe("partial");
    expect(coverageOf(false, 20, null, "page_limit")).toBe("partial");
    expect(coverageOf(false, 8, 8n, "natural_end")).toBe("unknown");
  });
});
