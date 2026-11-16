import { describe, expect, it } from "vitest";
import { selectLayer1, type RankRow } from "./select";

const T = (day: number) => new Date(Date.UTC(2026, 10, day));
const row = (id: number, like: number | null, state = "value", day = 1): RankRow => ({ contentId: BigInt(id), likeState: state, likeValue: like === null ? null : BigInt(like), publishedAt: T(day) });
const ids = (r: ReturnType<typeof selectLayer1>) => r.ranked.filter((x) => x.selected).map((x) => Number(x.contentId));

describe("selectLayer1", () => {
  it("10 条满足、N=6：取点赞最高的 6 条，其余 4 条未选中且 rank 继续排下去", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, (i + 1) * 10));
    const r = selectLayer1(rows, 6);
    expect(ids(r)).toEqual([10, 9, 8, 7, 6, 5]);
    expect(r.ranked.filter((x) => !x.selected).map((x) => [Number(x.contentId), x.rank])).toEqual([[4, 7], [3, 8], [2, 9], [1, 10]]);
  });
  it("只有 4 条、N=6：全部进入；N 大于候选数（含 1000）同理", () => {
    const rows = [row(1, 5), row(2, 9), row(3, 1), row(4, 7)];
    expect(ids(selectLayer1(rows, 6))).toEqual([2, 4, 1, 3]);
    expect(ids(selectLayer1(rows, 1000))).toHaveLength(4);
  });
  it("N 缺省：不截断，全部选中，rank 为 null", () => {
    const r = selectLayer1([row(1, 5), row(2, 9)], undefined);
    expect(r.ranked.every((x) => x.selected && x.rank === null)).toBe(true);
  });
  it("真实 0 是有效值，排在所有非 value 状态之前；五种状态里非 value 的都排后且计数", () => {
    const rows = [row(1, null, "missing"), row(2, 0), row(3, null, "explicit_null"), row(4, null, "invalid"), row(5, null, "unsupported"), row(6, 3)];
    const r = selectLayer1(rows, 2);
    expect(ids(r)).toEqual([6, 2]);
    expect(r.likeNotValue).toBe(4);
  });
  it("平局：同点赞按发布时间降序，再按内容 ID 升序；结果与输入顺序无关", () => {
    const rows = [row(3, 10, "value", 5), row(1, 10, "value", 5), row(2, 10, "value", 9), row(4, 10, "value", 1)];
    expect(ids(selectLayer1(rows, 4))).toEqual([2, 1, 3, 4]);
    expect(ids(selectLayer1([...rows].reverse(), 4))).toEqual([2, 1, 3, 4]);
    // 无效值组内同样按时间、ID
    const bad = [row(7, null, "missing", 2), row(8, null, "missing", 3), row(9, null, "missing", 3)];
    expect(ids(selectLayer1(bad, 3))).toEqual([8, 9, 7]);
  });
  it("19 位以上的点赞量不丢精度（bigint 比较）", () => {
    const a: RankRow = { contentId: 1n, likeState: "value", likeValue: 9007199254740993n, publishedAt: T(1) };
    const b: RankRow = { contentId: 2n, likeState: "value", likeValue: 9007199254740992n, publishedAt: T(1) };
    expect(ids(selectLayer1([b, a], 1))).toEqual([1]);
  });
});
