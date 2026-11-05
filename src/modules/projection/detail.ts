// 按需详情的快照落点（FS-9、design §7.8、v2 §10.2 第 12 条）：以内容当前 finalized 快照为种子拷贝一行 building 快照，
// 再把详情的有效值按 LaterValidValueWins 合并。列表独有的字段（小红书正文、抖音分享页地址）不丢；详情缺失 / null / 非法不擦除种子里的有效值。
import { and, eq } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { contentSnapshots, contents } from "../../db/schema";
import { sha256Utf8 } from "../canonical-json";
import type { DetailData } from "../provider-adapter";
import { countColumns, decimalColumns, fit, msToDate, textOrNull } from "./columns";
import { MERGE_POLICY_VERSION } from "./content-list";
import { selectCurrentContentSnapshot } from "./current";

export type SnapshotRow = typeof contentSnapshots.$inferSelect;
type Pair = { value: bigint | null; state: string };
/** 后到的有效值（含真实 0）覆盖；后到的非有效值不擦除先到的有效值（与列表合并同一规则）。 */
const later = (prev: Pair, next: Pair): Pair => (next.state === "value" || prev.state !== "value" ? next : prev);

export interface DetailMergeContext {
  providerCallId: bigint;
  adapterVersion: string;
  receivedAt: Date;
}

/** 纯函数：种子行 + 详情 → 合并后的列值（不含 id / 批次 / 状态）。 */
export function mergeDetail(seed: SnapshotRow, d: DetailData): Partial<SnapshotRow> {
  const pair = (value: bigint | null, state: string, next: ReturnType<typeof countColumns>): Pair => later({ value, state }, next);
  const play = pair(seed.playValue, seed.playState, countColumns(d.metrics.play));
  const like = pair(seed.likeValue, seed.likeState, countColumns(d.metrics.like));
  const comment = pair(seed.commentValue, seed.commentState, countColumns(d.metrics.comment));
  const collect = pair(seed.collectValue, seed.collectState, countColumns(d.metrics.collect));
  const share = pair(seed.shareValue, seed.shareState, countColumns(d.metrics.share));
  const dur = decimalColumns(d.durationSeconds);
  const takeDuration = dur.state === "value" || seed.durationState !== "value";
  const authorId = d.author.id.state === "value" ? d.author.id.value : null;
  return {
    returnedAuthorNamespaceCode: authorId === null ? seed.returnedAuthorNamespaceCode : d.author.namespace,
    returnedAuthorIdentifier: authorId === null ? seed.returnedAuthorIdentifier : authorId,
    returnedAuthorName: fit(textOrNull(d.authorName), 512) ?? seed.returnedAuthorName,
    publishedAt: msToDate(d.publishedAtMs) ?? seed.publishedAt,
    title: textOrNull(d.title) ?? seed.title,
    tagText: textOrNull(d.tagText) ?? seed.tagText,
    publishLocation: fit(textOrNull(d.publishLocation), 512) ?? seed.publishLocation,
    relatedSearchTerms: d.relatedSearchTerms.state === "value" ? d.relatedSearchTerms.value : seed.relatedSearchTerms,
    durationValue: takeDuration ? dur.value : seed.durationValue,
    durationState: takeDuration ? dur.state : seed.durationState,
    playValue: play.value,
    playState: play.state,
    likeValue: like.value,
    likeState: like.state,
    commentValue: comment.value,
    commentState: comment.state,
    collectValue: collect.value,
    collectState: collect.state,
    shareValue: share.value,
    shareState: share.state,
  };
}

export interface DetailSnapshotInput {
  batchId: bigint;
  contentId: bigint;
  data: DetailData;
  call: DetailMergeContext;
  now: Date;
}
export type DetailSnapshotResult =
  | { kind: "created"; contentSnapshotId: bigint; seededFromSnapshotId: bigint; currentChanged: boolean }
  | { kind: "exists"; contentSnapshotId: bigint }
  | { kind: "no_seed" };

/**
 * 种子 → 合并 → 定稿 → current 比较，调用方放在同一个 fenced 事务里。
 * 种子 = 内容当前的 finalized 快照（没有 current 则取最近一份 finalized）；一个都没有 → no_seed（提交时已按「没有 finalized 快照」拒绝，这里是防御）。
 * 同一批次同一内容已有快照（重放）→ exists，不改写。
 */
export async function insertDetailSnapshot(tx: DbTx, i: DetailSnapshotInput): Promise<DetailSnapshotResult> {
  const [existing] = await tx.select().from(contentSnapshots).where(and(eq(contentSnapshots.batchId, i.batchId), eq(contentSnapshots.contentId, i.contentId)));
  if (existing) return { kind: "exists", contentSnapshotId: existing.contentSnapshotId };

  const [content] = await tx.select().from(contents).where(eq(contents.contentId, i.contentId)).for("update");
  if (!content) return { kind: "no_seed" };
  const candidates = await tx
    .select()
    .from(contentSnapshots)
    .where(and(eq(contentSnapshots.contentId, i.contentId), eq(contentSnapshots.snapshotStatus, "finalized")));
  const seed = candidates.find((s) => s.contentSnapshotId === content.currentSnapshotId) ?? candidates.sort((a, b) => (a.contentSnapshotId < b.contentSnapshotId ? 1 : -1))[0];
  if (!seed) return { kind: "no_seed" };

  const { contentSnapshotId: _seedId, ...copy } = seed;
  void _seedId;
  const merged = mergeDetail(seed, i.data);
  const shareUrl = copy.shareUrl;
  const [res] = await tx.insert(contentSnapshots).values({
    ...copy,
    ...merged,
    batchId: i.batchId,
    snapshotStatus: "finalized",
    finalizedAt: i.now,
    // 按需快照没有列表观察：list_* 列留空，detail_* 取本次详情调用（ck_content_snapshots_seeded）
    listObserved: false,
    detailObserved: true,
    seededFromSnapshotId: seed.contentSnapshotId,
    lastListProviderCallId: null,
    listResponseReceivedAt: null,
    listAdapterVersion: null,
    lastDetailProviderCallId: i.call.providerCallId,
    detailResponseReceivedAt: i.call.receivedAt,
    detailAdapterVersion: i.call.adapterVersion,
    snapshotAt: i.call.receivedAt,
    mergePolicyVersion: MERGE_POLICY_VERSION,
    shareUrl,
    shareUrlSha256: shareUrl === null || shareUrl === undefined ? null : sha256Utf8(shareUrl),
    createdAt: i.now,
    updatedAt: i.now,
  });
  const contentSnapshotId = BigInt(res.insertId);
  const currentChanged = await selectCurrentContentSnapshot(tx, i.contentId, contentSnapshotId, i.now);
  return { kind: "created", contentSnapshotId, seededFromSnapshotId: seed.contentSnapshotId, currentChanged };
}
