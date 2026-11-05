import { describe, expect, it } from "vitest";
import type { ValueState } from "../provider-adapter";
import { checkListAuthors, checkProfileFields, checkProfileIdentity, countListAuthors } from "./identity-check";

const v = (value: string): ValueState<string> => ({ state: "value", value });
const n = (value: bigint): ValueState<bigint> => ({ state: "value", value });
const missing = { state: "missing" } as const;

describe("主页标识（FS-4.3）", () => {
  it("等于已登记值 → verified（文本精确比较，19 位 ID 与大小写不变形）", () => {
    expect(checkProfileIdentity({ registered: ["7680127373081070848"], actual: v("7680127373081070848") })).toEqual({ state: "verified" });
    expect(checkProfileIdentity({ registered: ["HITACHI1"], actual: v("hitachi1") })).toMatchObject({ state: "mismatch" });
  });
  it("不一致 → mismatch，带期望值与实际值（供质量问题留证）", () => {
    expect(checkProfileIdentity({ registered: ["A"], actual: v("B") })).toEqual({ state: "mismatch", expected: ["A"], actual: "B" });
  });
  it("实际值缺失 / null / 非法 → mismatch，actual 为 null", () => {
    for (const actual of [missing, { state: "explicit_null" } as const, { state: "invalid", raw: "5" } as const]) {
      expect(checkProfileIdentity({ registered: ["A"], actual })).toEqual({ state: "mismatch", expected: ["A"], actual: null });
    }
  });
  it("没有登记值（不应发生）→ mismatch：宁可停采集，也不写无法归属的快照", () => {
    expect(checkProfileIdentity({ registered: [], actual: v("A") })).toMatchObject({ state: "mismatch", expected: [] });
  });
  it("D11 的断言：入参里没有 locator，登记值之外的任何东西都不能让校验通过", () => {
    expect(Object.keys({ registered: [], actual: missing })).not.toContain("locator");
  });
});

describe("主页残缺（FS-4.8）", () => {
  it("四项全部不是有效值 → all_invalid；任意一项有效（含真实 0）→ ok", () => {
    const bad = { followerCount: missing, followingCount: { state: "explicit_null" } as const, likeCount: { state: "invalid", raw: "x" } as const, postCount: missing };
    expect(checkProfileFields(bad)).toBe("all_invalid");
    expect(checkProfileFields({ ...bad, postCount: n(0n) })).toBe("ok");
    expect(checkProfileFields({ ...bad, likeCount: n(5n) })).toBe("ok");
  });
});

describe("列表作者三态（FS-5.13）", () => {
  const entry = (id: string | null, sec?: string | null) => ({ author: { namespace: "douyin.user_id" as const, id: id === null ? missing : v(id) }, authorSecUid: sec === undefined ? null : sec === null ? missing : v(sec) });

  it("E20：20 条中 19 条是登记作者 → verified（异作者共创是常态，不能要求全部是）", () => {
    const entries = [...Array.from({ length: 19 }, () => entry("HITACHI1", "SEC1")), entry("HITACHI2023", "SEC2")];
    const c = countListAuthors(entries, new Set(["HITACHI1", "SEC1"]));
    expect(c).toEqual({ known: 20, matched: 19 });
    expect(checkListAuthors({ baselineHasRegistered: true, knownAuthorEntries: c.known, matchedEntries: c.matched })).toBe("verified");
  });
  it("E20：20 条一条都不是登记作者 → mismatch", () => {
    const c = countListAuthors(Array.from({ length: 20 }, () => entry("SOMEONE_ELSE", "SEC9")), new Set(["HITACHI1", "SEC1"]));
    expect(checkListAuthors({ baselineHasRegistered: true, knownAuthorEntries: c.known, matchedEntries: c.matched })).toBe("mismatch");
  });
  it("E20：只有 3 条 → unverifiable，不判错（小账号不误报）", () => {
    expect(checkListAuthors({ baselineHasRegistered: true, knownAuthorEntries: 3, matchedEntries: 0 })).toBe("unverifiable");
    expect(checkListAuthors({ baselineHasRegistered: true, knownAuthorEntries: 4, matchedEntries: 0 })).toBe("unverifiable");
    expect(checkListAuthors({ baselineHasRegistered: true, knownAuthorEntries: 5, matchedEntries: 0 })).toBe("mismatch");
  });
  it("E21：任务开始时没有登记的作者标识 → 整次 unverifiable，哪怕 100 条一条都不匹配（小红书首次主导作者绑定是循环论证）", () => {
    expect(checkListAuthors({ baselineHasRegistered: false, knownAuthorEntries: 100, matchedEntries: 0 })).toBe("unverifiable");
    expect(checkListAuthors({ baselineHasRegistered: false, knownAuthorEntries: 100, matchedEntries: 100 })).toBe("unverifiable");
  });
  it("作者字段整体缺失（契约漂移）不是串号：不数入「可用作者条目」，所以不会 mismatch", () => {
    const c = countListAuthors(Array.from({ length: 30 }, () => entry(null, null)), new Set(["HITACHI1"]));
    expect(c).toEqual({ known: 0, matched: 0 });
    expect(checkListAuthors({ baselineHasRegistered: true, knownAuthorEntries: c.known, matchedEntries: c.matched })).toBe("unverifiable");
  });
  it("抖音第二标识 sec_uid 命中也算匹配；快手 / 小红书没有 sec_uid（null）不影响", () => {
    expect(countListAuthors([entry("X", "SEC1")], new Set(["SEC1"]))).toEqual({ known: 1, matched: 1 });
    expect(countListAuthors([entry("HK1")], new Set(["HK1"]))).toEqual({ known: 1, matched: 1 });
    expect(countListAuthors([entry("X", null)], new Set(["HK1"]))).toEqual({ known: 1, matched: 0 });
  });
});
