// 第 1 层数量要求（D-D18）：对一位专员 l1 = pass 的内容按点赞量降序取前 N 条进入下一层。
export interface RankRow {
  contentId: bigint;
  /** A 的值状态：只有 "value" 才是有效点赞量；其余（missing / explicit_null / invalid / unsupported）一律排在有效值之后，不当作 0 */
  likeState: string;
  likeValue: bigint | null;
  publishedAt: Date;
}
export interface Ranked {
  contentId: bigint;
  selected: boolean;
  /** n 缺省时为 null；否则 1 起，未选中者继续排下去 */
  rank: number | null;
}
const cmpBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** 有效值在前按点赞降序；无效值在后；同组按发布时间降序、内容 ID 升序（确定性）。 */
export function compareRank(a: RankRow, b: RankRow): number {
  const av = a.likeState === "value" && a.likeValue !== null;
  const bv = b.likeState === "value" && b.likeValue !== null;
  if (av !== bv) return av ? -1 : 1;
  if (av && bv) {
    const c = cmpBig(b.likeValue!, a.likeValue!);
    if (c !== 0) return c;
  }
  const t = b.publishedAt.getTime() - a.publishedAt.getTime();
  if (t !== 0) return t < 0 ? -1 : 1;
  return cmpBig(a.contentId, b.contentId);
}

export function selectLayer1(rows: readonly RankRow[], n: number | undefined): { ranked: Ranked[]; likeNotValue: number } {
  const sorted = [...rows].sort(compareRank);
  const likeNotValue = rows.filter((r) => !(r.likeState === "value" && r.likeValue !== null)).length;
  const ranked = sorted.map((r, i): Ranked => (n === undefined ? { contentId: r.contentId, selected: true, rank: null } : { contentId: r.contentId, selected: i < n, rank: i + 1 }));
  return { ranked, likeNotValue };
}
