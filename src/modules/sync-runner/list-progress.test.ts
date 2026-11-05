import { describe, expect, it } from "vitest";
import type { Decision } from "./decide-after-page";
import { afterPage, initialProgress, parseProgress, ProgressCorruptError, progressSchema } from "./list-progress";

const identity = { baseline_has_registered: true, known_author_entries: 20, matched_entries: 19, state: "verified" as const };
const cont: Decision = { action: "continue", nextCursor: { kind: "string", value: "1.785394950371E12" }, anomalies: [] };
const stopped: Decision = { action: "stop", outcome: "gap", stopReason: "safety_limit_rebased", anchor: "rebuild", windowOverflow: true, anomalies: [] };

describe("list-walk-progress.v1", () => {
  it("初始值通过自己的 schema；没有进度 → null；null / undefined 都算没有", () => {
    expect(progressSchema.safeParse(initialProgress(true)).success).toBe(true);
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress(undefined)).toBeNull();
  });
  it("一页之后：页数、条数累加；continue 存下游标，stop 存下判定且清空游标", () => {
    const p1 = afterPage(initialProgress(true), { entriesInPage: 23, decision: cont, pinnedIdMatch: false, identity, callId: 9n, anomalies: [] });
    expect(p1).toMatchObject({ pages_done: 1, entries_done: 23, next_cursor: { kind: "string", value: "1.785394950371E12" }, stop: null, stop_detail: null, last_page_call_id: "9" });
    const p2 = afterPage(p1, { entriesInPage: 20, decision: stopped, pinnedIdMatch: false, identity, callId: 10n, anomalies: [{ code: "has_more_invalid", state: "missing" }] });
    expect(p2).toMatchObject({
      pages_done: 2,
      entries_done: 43,
      next_cursor: null,
      stop: "safety_limit_rebased",
      stop_detail: { outcome: "gap", stop_reason: "safety_limit_rebased", anchor: "rebuild", window_overflow: true },
    });
    expect(p2.anomalies).toEqual([{ code: "has_more_invalid", state: "missing" }]);
  });
  it("pinned_id_match 一旦为真就保持（第 1 页记下，后续页沿用）", () => {
    const p1 = afterPage(initialProgress(true), { entriesInPage: 3, decision: cont, pinnedIdMatch: true, identity, callId: 1n, anomalies: [] });
    const p2 = afterPage(p1, { entriesInPage: 3, decision: cont, pinnedIdMatch: false, identity, callId: 2n, anomalies: [] });
    expect(p2.pinned_id_match).toBe(true);
  });
  it("序列化往返：写进 JSON 列再读出来，进度不变（页事务提交、崩溃后恢复读到同一份）", () => {
    const p = afterPage(initialProgress(true), { entriesInPage: 20, decision: cont, pinnedIdMatch: false, identity, callId: 7n, anomalies: [] });
    expect(parseProgress(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it("游标只能是整数原文或非空字符串：no_more / 空串 / null 不可能被存下", () => {
    for (const bad of [{ kind: "no_more" }, { kind: "string", value: "" }, { kind: "null" }, { kind: "integer", lexeme: "1.5" }, { kind: "integer", lexeme: 12 }]) {
      expect(progressSchema.safeParse({ ...initialProgress(true), next_cursor: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(progressSchema.safeParse({ ...initialProgress(true), next_cursor: { kind: "integer", lexeme: "9007199254740993" } }).success).toBe(true);
  });
  it("损坏的进度（未知字段、缺字段、错误版本）→ ProgressCorruptError，不静默当作从头开始", () => {
    for (const bad of [{}, { ...initialProgress(true), schema: "list-walk-progress.v0" }, { ...initialProgress(true), extra: 1 }, "x", 5]) {
      expect(() => parseProgress(bad), JSON.stringify(bad)).toThrow(ProgressCorruptError);
    }
  });
});
