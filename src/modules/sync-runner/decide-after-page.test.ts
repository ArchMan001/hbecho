import { describe, expect, it } from "vitest";
import type { TypedCursor, ValueState } from "../provider-adapter";
import { decideAfterPage, pinnedIdMatchOf, type AnchorView, type Decision, type DecideConfig, type PageEntryFacts, type PageFacts, type WalkTotals } from "./decide-after-page";

// 时间轴：旧高水位 = 1000，更早的内容发布时间 < 1000
const HW = 1000n;
const timeAnchor = (...ids: string[]): AnchorView => ({ mode: "time", highWatermarkMs: HW, contentIds: new Set(ids) });
const idAnchor = (...ids: string[]): AnchorView => ({ mode: "id_window", contentIds: new Set(ids) });
const NONE: AnchorView = { mode: "none" };
const EMPTY: AnchorView = { mode: "empty" };

const e = (position: number, contentId: string | null, publishedAtMs: bigint | null = null): PageEntryFacts => ({ position, contentId, publishedAtMs });
/** n 条新内容（发布时间都晚于高水位，ID 不在任何集合里），位置从 start 起。 */
const fresh = (n: number, start = 0, tag = "n"): PageEntryFacts[] => Array.from({ length: n }, (_, i) => e(start + i, `${tag}${start + i}`, HW + 100n + BigInt(i)));
const yes = (v: boolean): ValueState<boolean> => ({ state: "value", value: v });
const INT: TypedCursor = { kind: "integer", lexeme: "1782701295000" };
const STR: TypedCursor = { kind: "string", value: "6a5098aa000000001603fb07" };

const page = (over: Partial<PageFacts> & { entries: PageEntryFacts[] }): PageFacts => ({ pageNo: 1, hasMore: yes(true), cursor: STR, ...over });
const cfg = (over: Partial<DecideConfig> = {}): DecideConfig => ({ safetyPageLimit: 5, initialContentLimit: 20, blocked: false, ...over });
const totals = (cumulativeEntries: number, pinnedIdMatch = false): WalkTotals => ({ cumulativeEntries, pinnedIdMatch });

type Expect = { action: "continue" } | { action: "stop"; outcome: "success" | "gap" | "blocked"; stopReason: string; anchor: "rebuild" | "keep_old" | "empty"; windowOverflow?: boolean; anomalies?: string[] };
const check = (d: Decision, x: Expect) => {
  expect(d.action).toBe(x.action);
  if (d.action === "stop" && x.action === "stop") {
    expect({ outcome: d.outcome, stopReason: d.stopReason, anchor: d.anchor, windowOverflow: d.windowOverflow, anomalies: d.anomalies.map((a) => a.code) }).toEqual({
      outcome: x.outcome,
      stopReason: x.stopReason,
      anchor: x.anchor,
      windowOverflow: x.windowOverflow ?? false,
      anomalies: x.anomalies ?? [],
    });
  }
};

interface Case {
  name: string;
  row: string; // design §7.6 原 9 行的编号；B 用 "empty"
  anchor: AnchorView;
  page: PageFacts;
  cumulative: number;
  pinned?: boolean;
  cfg?: Partial<DecideConfig>;
  expect: Expect;
}
const stopOk = (stopReason: string, anchor: "rebuild" | "empty" = "rebuild", anomalies?: string[]): Expect => ({ action: "stop", outcome: "success", stopReason, anchor, ...(anomalies ? { anomalies } : {}) });
const gap = (stopReason: string, extra: { windowOverflow?: boolean; anomalies?: string[] } = {}): Expect => ({ action: "stop", outcome: "gap", stopReason, anchor: "rebuild", ...extra });

const CASES: Case[] = [
  // ── 行 1：游标 / has_more 异常 ──
  { name: "快手 K3：has_more=true + no_more，无旧锚点 → 按自然结束（成功），记异常", row: "1", anchor: NONE, page: page({ entries: fresh(10), cursor: { kind: "no_more" } }), cumulative: 10, expect: stopOk("end_of_list", "rebuild", ["cursor_no_more_with_has_more"]) },
  { name: "has_more=true + no_more，旧 time 锚点命中 → 先命中（成功），异常仍记录", row: "1", anchor: timeAnchor("old"), page: page({ entries: [...fresh(3), e(3, "old", HW)], cursor: { kind: "no_more" } }), cumulative: 4, expect: stopOk("boundary_hit", "rebuild", ["cursor_no_more_with_has_more"]) },
  { name: "has_more=true + no_more，旧 time 锚点未命中 → cursor_anomaly_rebased 缺口", row: "1", anchor: timeAnchor("old"), page: page({ entries: fresh(10), cursor: { kind: "no_more" } }), cumulative: 10, expect: gap("cursor_anomaly_rebased", { anomalies: ["cursor_no_more_with_has_more"] }) },
  { name: "has_more=true + 空串游标 / null / 缺失 / 非法游标，都是游标异常", row: "1", anchor: NONE, page: page({ entries: fresh(5), cursor: { kind: "string", value: "" } }), cumulative: 5, expect: stopOk("end_of_list", "rebuild", ["cursor_no_more_with_has_more"]) },
  { name: "has_more 缺失 → has_more_invalid，当作 false", row: "1", anchor: idAnchor("old"), page: page({ entries: fresh(5), hasMore: { state: "missing" } }), cumulative: 5, expect: gap("cursor_anomaly_rebased", { anomalies: ["has_more_invalid"] }) },
  { name: "has_more=null / 非法同样当作 false", row: "1", anchor: NONE, page: page({ entries: fresh(5), hasMore: { state: "explicit_null" } }), cumulative: 5, expect: stopOk("end_of_list", "rebuild", ["has_more_invalid"]) },
  { name: "has_more=false + no_more 不是异常（正常结束）", row: "1", anchor: NONE, page: page({ entries: fresh(5), hasMore: yes(false), cursor: { kind: "no_more" } }), cumulative: 5, expect: stopOk("end_of_list") },
  // ── 行 2：命中旧边界 ──
  { name: "time：发布时间严格早于旧高水位 → 命中", row: "2", anchor: timeAnchor("x"), page: page({ entries: [...fresh(5), e(5, "older", HW - 1n)] }), cumulative: 6, expect: stopOk("boundary_hit") },
  { name: "time：以内容 ID 命中（时间等于高水位）", row: "2", anchor: timeAnchor("hw1"), page: page({ entries: [...fresh(5), e(5, "hw1", HW)] }), cumulative: 6, expect: stopOk("boundary_hit") },
  { name: "id_window：以内容 ID 命中", row: "2", anchor: idAnchor("w1", "w2"), page: page({ entries: [...fresh(5), e(5, "w2")] }), cumulative: 6, expect: stopOk("boundary_hit") },
  { name: "等于高水位时间但 ID 不在集合内 → 不命中，继续翻页", row: "2", anchor: timeAnchor("hw1"), page: page({ entries: [...fresh(5), e(5, "otherAtHw", HW)] }), cumulative: 6, expect: { action: "continue" } },
  { name: "第 1 页置顶位置（0–2）的命中被忽略 → 继续翻页", row: "2", anchor: timeAnchor("old"), page: page({ entries: [e(0, "old", HW - 5n), e(1, "p2", HW - 6n), e(2, "p3", HW - 7n), ...fresh(7, 3)] }), cumulative: 10, expect: { action: "continue" } },
  { name: "第 1 页位置 3 起的命中生效", row: "2", anchor: timeAnchor("old"), page: page({ entries: [...fresh(3), e(3, "old", HW)] }), cumulative: 4, expect: stopOk("boundary_hit") },
  { name: "第 2 页位置 0 不是置顶：命中生效", row: "2", anchor: timeAnchor("old"), page: page({ pageNo: 2, entries: [e(0, "old", HW), ...fresh(5, 1)] }), cumulative: 16, expect: stopOk("boundary_hit") },
  { name: "条目没有有效发布时间时只看 ID：时间缺失不会被当作「更早」", row: "2", anchor: timeAnchor("old"), page: page({ entries: fresh(8).map((x) => ({ ...x, publishedAtMs: null })) }), cumulative: 8, expect: { action: "continue" } },
  { name: "id_window 不看时间：早于高水位但 ID 不在窗口 → 继续", row: "2", anchor: idAnchor("w1"), page: page({ entries: [...fresh(5), e(5, "older", 1n)] }), cumulative: 6, expect: { action: "continue" } },
  // ── 行 3：首次基线 ──
  { name: "无旧检查点：累计 = initial_content_limit → 成功，供应商仍有更多不算缺口", row: "3", anchor: NONE, page: page({ entries: fresh(20) }), cumulative: 20, expect: stopOk("initial_limit") },
  { name: "累计 = limit − 1 且 has_more=true → 继续", row: "3", anchor: NONE, page: page({ entries: fresh(19) }), cumulative: 19, expect: { action: "continue" } },
  { name: "单页返回 21 条（超过 limit）：整页已处理，仍然成功停止", row: "3", anchor: NONE, page: page({ entries: fresh(21) }), cumulative: 21, expect: stopOk("initial_limit") },
  { name: "limit=1 时第 1 页就够", row: "3", anchor: NONE, page: page({ entries: fresh(3) }), cumulative: 3, cfg: { initialContentLimit: 1 }, expect: stopOk("initial_limit") },
  // ── 行 4 / 5：继续与安全页数 ──
  { name: "pageNo = cap − 1 且 has_more → 继续", row: "4", anchor: timeAnchor("old"), page: page({ pageNo: 4, entries: fresh(10) }), cumulative: 40, expect: { action: "continue" } },
  { name: "pageNo = cap 且 has_more → safety_limit_rebased + window_overflow", row: "5", anchor: timeAnchor("old"), page: page({ pageNo: 5, entries: fresh(10) }), cumulative: 50, expect: gap("safety_limit_rebased", { windowOverflow: true }) },
  { name: "cap=1：第 1 页未命中就是缺口", row: "5", anchor: idAnchor("old"), page: page({ entries: fresh(10) }), cumulative: 10, cfg: { safetyPageLimit: 1 }, expect: gap("safety_limit_rebased", { windowOverflow: true }) },
  { name: "cap=2：第 2 页未命中且还有更多 → 缺口（E7 三页场景）", row: "5", anchor: timeAnchor("old"), page: page({ pageNo: 2, entries: fresh(10, 0, "p2") }), cumulative: 20, cfg: { safetyPageLimit: 2 }, expect: gap("safety_limit_rebased", { windowOverflow: true }) },
  // ── 行 6：自然结束仍未命中 ──
  { name: "time 锚点未命中且没有更多 → end_of_list_rebased（不是 overflow）", row: "6", anchor: timeAnchor("old"), page: page({ entries: fresh(10), hasMore: yes(false) }), cumulative: 10, expect: gap("end_of_list_rebased") },
  { name: "id_window 锚点未命中且没有更多 → end_of_list_rebased", row: "6", anchor: idAnchor("old"), page: page({ entries: fresh(10), hasMore: yes(false) }), cumulative: 10, expect: gap("end_of_list_rebased") },
  { name: "E19：第 1 页只有 3 条，旧高水位 ID 就在置顶位置 → 成功，不误报缺口", row: "6", anchor: timeAnchor("old"), page: page({ entries: [e(0, "old", HW), e(1, "a", HW - 1n), e(2, "b", HW - 2n)], hasMore: yes(false) }), cumulative: 3, expect: stopOk("boundary_hit") },
  { name: "E19 反例：置顶位置的 ID 不在旧集合（只是时间更早）→ 缺口", row: "6", anchor: timeAnchor("old"), page: page({ entries: [e(0, "x", HW - 1n), e(1, "a", HW - 2n), e(2, "b", HW - 3n)], hasMore: yes(false) }), cumulative: 3, expect: gap("end_of_list_rebased") },
  { name: "此前页（第 1 页）记下的 pinnedIdMatch 在后续页自然结束时仍然有效", row: "6", anchor: timeAnchor("old"), page: page({ pageNo: 2, entries: fresh(3, 0, "q"), hasMore: yes(false) }), cumulative: 13, pinned: true, expect: stopOk("boundary_hit") },
  { name: "不足 4 条但旧 ID 在位置 3 以后 → 常规命中", row: "6", anchor: timeAnchor("old"), page: page({ entries: [...fresh(3), e(3, "old", HW)], hasMore: yes(false) }), cumulative: 4, expect: stopOk("boundary_hit") },
  // ── 行 7：首次 / 上次为空这次有内容 ──
  { name: "无旧锚点 + 没有更多 + 有条目 → 成功并建立锚点（不是缺口）", row: "7", anchor: NONE, page: page({ entries: fresh(5), hasMore: yes(false) }), cumulative: 5, expect: stopOk("end_of_list") },
  // ── 行 8：空窗口 ──
  { name: "time 锚点 + 空页 + 没有更多 → blocked，保持旧锚点", row: "8", anchor: timeAnchor("old"), page: page({ entries: [], hasMore: yes(false) }), cumulative: 0, expect: { action: "stop", outcome: "blocked", stopReason: "empty_window_not_rebased", anchor: "keep_old" } },
  { name: "id_window 锚点 + 空页 + 没有更多 → blocked", row: "8", anchor: idAnchor("old"), page: page({ entries: [], hasMore: yes(false) }), cumulative: 0, expect: { action: "stop", outcome: "blocked", stopReason: "empty_window_not_rebased", anchor: "keep_old" } },
  { name: "旧锚点 + 空页 + has_more=true（未到上限）→ 继续翻页，不急着判空窗口", row: "8", anchor: timeAnchor("old"), page: page({ entries: [], hasMore: yes(true) }), cumulative: 0, expect: { action: "continue" } },
  { name: "旧锚点 + 空页 + has_more=true 且已到上限 → blocked（不用空窗口重建锚点）", row: "8", anchor: timeAnchor("old"), page: page({ pageNo: 5, entries: [], hasMore: yes(true) }), cumulative: 0, expect: { action: "stop", outcome: "blocked", stopReason: "empty_window_not_rebased", anchor: "keep_old" } },
  { name: "快手 K6：旧锚点 + 空页 + no_more + has_more=true → 游标异常当作结束，blocked", row: "8", anchor: timeAnchor("old"), page: page({ entries: [], cursor: { kind: "no_more" } }), cumulative: 0, expect: { action: "stop", outcome: "blocked", stopReason: "empty_window_not_rebased", anchor: "keep_old", anomalies: ["cursor_no_more_with_has_more"] } },
  // ── 行 9：首次且为空 ──
  { name: "无旧锚点 + 空页 + 没有更多 → 成功，建立 empty 锚点", row: "9", anchor: NONE, page: page({ entries: [], hasMore: yes(false) }), cumulative: 0, expect: stopOk("empty_list", "empty") },
  { name: "快手 K6 首次：空 + no_more → 成功，empty 锚点", row: "9", anchor: NONE, page: page({ entries: [], cursor: { kind: "no_more" } }), cumulative: 0, expect: stopOk("empty_list", "empty", ["cursor_no_more_with_has_more"]) },
  // ── empty 锚点（E24、E25）──
  { name: "E24：empty 锚点 + 本轮有 5 条 + 没有更多 → 成功并重建锚点，不是缺口", row: "empty", anchor: EMPTY, page: page({ entries: fresh(5), hasMore: yes(false) }), cumulative: 5, expect: stopOk("baseline") },
  { name: "E24：empty 锚点 + 本轮有条目 + has_more=true → 无视 has_more，首页处理完即停", row: "empty", anchor: EMPTY, page: page({ entries: fresh(5), hasMore: yes(true) }), cumulative: 5, expect: stopOk("baseline") },
  { name: "E25：empty 锚点 + 本轮仍为空 → 保持 empty，成功", row: "empty", anchor: EMPTY, page: page({ entries: [], hasMore: yes(false) }), cumulative: 0, expect: stopOk("empty_list", "empty") },
  { name: "E25：empty 锚点 + 空页 + has_more=true → 同样保持 empty，不翻页", row: "empty", anchor: EMPTY, page: page({ entries: [], hasMore: yes(true) }), cumulative: 0, expect: stopOk("empty_list", "empty") },
  // ── blocked（只抓首页，cap=1）──
  { name: "blocked：首页命中 → 成功", row: "blocked", anchor: timeAnchor("old"), page: page({ entries: [...fresh(3), e(3, "old", HW)] }), cumulative: 4, cfg: { blocked: true }, expect: stopOk("boundary_hit") },
  { name: "blocked：未命中 + has_more=true → safety_limit_rebased（不翻第 2 页）", row: "blocked", anchor: timeAnchor("old"), page: page({ entries: fresh(10) }), cumulative: 10, cfg: { blocked: true }, expect: gap("safety_limit_rebased", { windowOverflow: true }) },
  { name: "blocked：未命中 + has_more=false → end_of_list_rebased", row: "blocked", anchor: timeAnchor("old"), page: page({ entries: fresh(10), hasMore: yes(false) }), cumulative: 10, cfg: { blocked: true }, expect: gap("end_of_list_rebased") },
  { name: "blocked：仍是空页 → 继续 blocked，旧锚点不变", row: "blocked", anchor: timeAnchor("old"), page: page({ entries: [], hasMore: yes(true) }), cumulative: 0, cfg: { blocked: true }, expect: { action: "stop", outcome: "blocked", stopReason: "empty_window_not_rebased", anchor: "keep_old" } },
];

describe("decideAfterPage：表驱动", () => {
  it.each(CASES.map((c) => [`[${c.row}] ${c.name}`, c] as const))("%s", (_n, c) => {
    check(decideAfterPage(c.anchor, c.page, totals(c.cumulative, c.pinned ?? false), cfg(c.cfg)), c.expect);
  });

  it("覆盖原 9 行的每一行，以及 empty 与 blocked", () => {
    const rows = new Set(CASES.map((c) => c.row));
    for (const r of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "empty", "blocked"]) expect(rows.has(r), r).toBe(true);
  });
});

describe("decideAfterPage：性质", () => {
  const anchors: AnchorView[] = [NONE, EMPTY, timeAnchor("old"), idAnchor("old")];
  const cursors: TypedCursor[] = [INT, STR, { kind: "no_more" }, { kind: "null" }, { kind: "absent" }, { kind: "invalid", raw: "x" }, { kind: "string", value: "" }];
  const hasMores: ValueState<boolean>[] = [yes(true), yes(false), { state: "missing" }, { state: "explicit_null" }, { state: "invalid", raw: "2" }];
  const sizes = [0, 1, 3, 4, 20, 21];
  const all: Array<{ d: Decision; cursor: TypedCursor }> = [];
  for (const anchor of anchors)
    for (const cursor of cursors)
      for (const hasMore of hasMores)
        for (const n of sizes)
          for (const pageNo of [1, 2, 5])
            for (const blocked of [false, true])
              all.push({ d: decideAfterPage(anchor, { pageNo, entries: fresh(n), hasMore, cursor }, totals(n * pageNo), cfg({ blocked })), cursor });

  it("continue 的 nextCursor 永远是整数或非空字符串，绝不是 no_more / null / 缺失 / 非法 / 空串", () => {
    const conts = all.filter((x) => x.d.action === "continue");
    expect(conts.length).toBeGreaterThan(0);
    for (const { d } of conts) {
      if (d.action !== "continue") continue;
      expect(d.nextCursor.kind === "integer" || (d.nextCursor.kind === "string" && d.nextCursor.value !== "")).toBe(true);
    }
  });
  it("window_overflow 蕴含 gap（对应 ck_sync_tasks_overflow / ck_sync_tasks_gap）；blocked 只会保留旧锚点", () => {
    for (const { d } of all) {
      if (d.action !== "stop") continue;
      if (d.windowOverflow) expect(d.outcome).toBe("gap");
      if (d.outcome === "blocked") expect(d.anchor).toBe("keep_old");
      if (d.anchor === "keep_old") expect(d.outcome).toBe("blocked");
      if (d.outcome === "gap") expect(d.anchor).toBe("rebuild"); // 缺口之后一律用本轮窗口重建锚点
    }
  });
  it("has_more=true 配任何不可用游标（no_more / null / 缺失 / 非法 / 空串）：都记 cursor_no_more_with_has_more 并停止，绝不 continue", () => {
    const bad: TypedCursor[] = [{ kind: "no_more" }, { kind: "null" }, { kind: "absent" }, { kind: "invalid", raw: "x" }, { kind: "string", value: "" }];
    for (const cursor of bad)
      for (const anchor of anchors) {
        const d = decideAfterPage(anchor, { pageNo: 1, entries: fresh(5), hasMore: yes(true), cursor }, totals(5), cfg());
        expect(d.action, `${cursor.kind}/${anchor.mode}`).toBe("stop");
        if (d.action === "stop") expect(d.anomalies.map((a) => a.code)).toContain("cursor_no_more_with_has_more");
      }
  });
  it("has_more 缺失 / 非法永远不会 continue（不猜测）", () => {
    for (const hasMore of hasMores.filter((h) => h.state !== "value"))
      for (const anchor of anchors) {
        const d = decideAfterPage(anchor, { pageNo: 1, entries: fresh(5), hasMore, cursor: STR }, totals(5), cfg());
        expect(d.action).toBe("stop");
      }
  });
  it("blocked 时永远不会 continue（只抓首页）", () => {
    for (const hasMore of hasMores)
      for (const anchor of [timeAnchor("old"), idAnchor("old")]) {
        expect(decideAfterPage(anchor, { pageNo: 1, entries: fresh(5), hasMore, cursor: STR }, totals(5), cfg({ blocked: true })).action).toBe("stop");
      }
  });
});

describe("pinnedIdMatchOf", () => {
  it("只看第 1 页置顶位置的内容 ID，不看时间；time / id_window 之外恒为 false", () => {
    const p = page({ entries: [e(0, "old", 1n), e(1, "a"), e(5, "old2")] });
    expect(pinnedIdMatchOf(timeAnchor("old"), p)).toBe(true);
    expect(pinnedIdMatchOf(timeAnchor("old2"), p)).toBe(false); // 位置 5 不是置顶位置
    expect(pinnedIdMatchOf(timeAnchor("zzz"), page({ entries: [e(0, "q", 1n)] }))).toBe(false);
    expect(pinnedIdMatchOf(NONE, p)).toBe(false);
    expect(pinnedIdMatchOf(EMPTY, p)).toBe(false);
    expect(pinnedIdMatchOf(timeAnchor("old"), { ...p, pageNo: 2 })).toBe(false);
  });
});
