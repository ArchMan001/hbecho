// 完整返回页投影（R9）：已返回的每条条目都处理，不按本地 limit 截断；内容按被观察账号保存；
// 整页在调用方给定的同一个事务里完成，所以「全部终态之后才推进检查点」天然成立。
import { and, eq, sql } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { contentDiscoveries, contentSnapshots, contents, mediaReferences } from "../../db/schema";
import type { ListData, ListEntry } from "../provider-adapter";
import { countColumns, decimalColumns, fit, msToDate, textOrNull } from "./columns";
import { sha256Utf8 } from "../canonical-json";
import { selectCurrentContentSnapshot } from "./current";
import { mergeEntries, type MergedContent } from "./merge";

export const MERGE_POLICY_VERSION = "list-merge.v1";

export interface OwnerSnapshot {
  staffId: bigint;
  storeId: bigint;
  brandId: bigint;
}

export interface ProjectPageInput {
  batchId: bigint;
  platformId: bigint;
  accountId: bigint;
  assignmentId: bigint;
  /** 采集当时的归属快照；external 型账号为 null（三列同为空）。 */
  owner: OwnerSnapshot | null;
  sourceProviderCallId: bigint;
  adapterVersion: string;
  receivedAt: Date;
  pageNo: number;
  page: ListData;
  now: Date;
  /**
   * final（默认，tracer 单页路径）：写 finalized 并立刻选 current。
   * building（a-full-sync 多页）：写 building、不选 current；同一批次同一内容跨页重复时合并，discovery 保留首次出现。
   * 定稿与 current 由账号级封口负责（sync-runner/seal.ts）。
   */
  mode?: "final" | "building";
  /** building 模式：此前各页已返回的条目数，absolute_position = positionOffset + 页内位置。默认 0。 */
  positionOffset?: number;
  /** building 模式的封面钩子（任务 7 的「封面首次入库」规则）：返回 true 则不为该内容建 cover 引用。默认不跳过。 */
  skipCover?: (tx: DbTx, contentId: bigint) => Promise<boolean>;
}

export interface ProjectPageResult {
  returnedEntries: number;
  /**
   * 已到达终态的条目数 = 形成内容的条目（含重复出现的）+ 不可投影的条目。
   * 检查点只在 processedEntries === returnedEntries 时才能建立（R10.1、R10.5）。
   */
  processedEntries: number;
  /** 形成了内容快照与发现的内容数（同一内容重复出现只算一个）。 */
  projectedContents: number;
  /** 无法投影的条目（缺少可用的 post_id）：已计入终态，留下质量问题，不阻塞检查点。 */
  unprojectable: Array<{ position: number; reason: string }>;
  /** 重复出现的内容：全部条目都处理过，只保留一个 discovery。 */
  duplicates: Array<{ platformContentId: string; positions: number[] }>;
  contentIds: bigint[];
}

const PINNED_POSITIONS = 3; // 第一页前三位可能置顶（v2 §9.4 第 3 条，0 基）

export async function projectContentPage(tx: DbTx, p: ProjectPageInput): Promise<ProjectPageResult> {
  const { merged, unprojectable, duplicates } = mergeEntries(p.page.entries);
  const processedEntries = merged.reduce((n, m) => n + m.positions.length, 0) + unprojectable.length;
  const base = { returnedEntries: p.page.entries.length, processedEntries, unprojectable, duplicates };

  const building = p.mode === "building";
  const offset = p.positionOffset ?? 0;
  const contentIds: bigint[] = [];
  for (const m of merged) {
    const contentId = await upsertContent(tx, p, m);
    contentIds.push(contentId);
    const snapshotId = building ? await upsertBuildingSnapshot(tx, p, contentId, m) : await insertSnapshot(tx, p, contentId, m, "finalized");
    if (!building) await insertCover(tx, p, snapshotId, m);
    else if (!(await p.skipCover?.(tx, contentId)) && !(await hasCover(tx, snapshotId))) await insertCover(tx, p, snapshotId, m);
    const discovery = {
      batchId: p.batchId,
      assignmentId: p.assignmentId,
      contentId,
      pageNo: p.pageNo,
      positionInPage: m.firstPosition,
      absolutePosition: offset + m.firstPosition,
      isPotentiallyPinned: p.pageNo === 0 && m.firstPosition < PINNED_POSITIONS,
      discoveredAt: p.receivedAt,
      sourceProviderCallId: p.sourceProviderCallId,
      ownerStaffId: p.owner?.staffId ?? null,
      ownerStoreId: p.owner?.storeId ?? null,
      ownerBrandId: p.owner?.brandId ?? null,
      createdAt: p.now,
    };
    // building：跨页重复保留首次出现的发现（FS-5.11）
    if (building) await tx.insert(contentDiscoveries).values(discovery).onDuplicateKeyUpdate({ set: { discoveryId: sql`discovery_id` } });
    else await tx.insert(contentDiscoveries).values(discovery);
    if (!building) await selectCurrentContentSnapshot(tx, contentId, snapshotId, p.now);
  }
  return { ...base, projectedContents: merged.length, contentIds };
}

async function upsertContent(tx: DbTx, p: ProjectPageInput, m: MergedContent): Promise<bigint> {
  const sha = sha256Utf8(m.platformContentId);
  const [row] = await tx
    .select()
    .from(contents)
    .where(and(eq(contents.platformId, p.platformId), eq(contents.accountId, p.accountId), eq(contents.platformContentIdSha256, sha)))
    .for("update");
  if (row) {
    if (row.platformContentId !== m.platformContentId) throw new Error("content_hash_collision: 哈希命中但原文不同");
    await tx
      .update(contents)
      .set({
        // unknown 不覆盖已经推断出的形态
        contentKind: m.entry.contentKind === "unknown" ? row.contentKind : m.entry.contentKind,
        lastSeenAt: p.receivedAt,
        updatedAt: p.now,
      })
      .where(eq(contents.contentId, row.contentId));
    return row.contentId;
  }
  const [res] = await tx.insert(contents).values({
    platformId: p.platformId,
    accountId: p.accountId,
    platformContentId: m.platformContentId,
    platformContentIdSha256: sha,
    contentKind: m.entry.contentKind,
    firstSeenAt: p.receivedAt,
    lastSeenAt: p.receivedAt,
    createdAt: p.now,
    updatedAt: p.now,
  });
  return BigInt(res.insertId);
}

type SnapshotValues = typeof contentSnapshots.$inferInsert;

function snapshotValues(p: ProjectPageInput, contentId: bigint, m: MergedContent, status: "building" | "finalized"): SnapshotValues {
  const e: ListEntry = m.entry;
  const like = countColumns(e.metrics.like);
  const comment = countColumns(e.metrics.comment);
  const collect = countColumns(e.metrics.collect);
  const share = countColumns(e.metrics.share);
  const play = countColumns(e.metrics.play); // unsupported
  const duration = decimalColumns(e.durationSeconds);
  const authorId = e.author.id.state === "value" ? e.author.id.value : null;
  const shareUrl = textOrNull(e.shareUrl);
  return {
    batchId: p.batchId,
    contentId,
    snapshotStatus: status,
    returnedAuthorNamespaceCode: authorId === null ? null : e.author.namespace,
    returnedAuthorIdentifier: authorId,
    returnedAuthorName: fit(textOrNull(e.authorName), 512),
    publishedAt: msToDate(e.publishedAtMs),
    title: textOrNull(e.title),
    body: textOrNull(e.text),
    tagText: textOrNull(e.tagText),
    publishLocation: fit(textOrNull(e.publishLocation), 512),
    relatedSearchTerms: e.relatedSearchTerms.state === "value" ? e.relatedSearchTerms.value : null,
    shareUrl,
    shareUrlSha256: shareUrl === null ? null : sha256Utf8(shareUrl),
    durationValue: duration.value,
    durationState: duration.state,
    durationUnit: "seconds",
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
    // 列表接口不提供转发数
    forwardValue: null,
    forwardState: "unsupported",
    listObserved: true,
    detailObserved: false,
    lastListProviderCallId: p.sourceProviderCallId,
    listResponseReceivedAt: p.receivedAt,
    snapshotAt: p.receivedAt,
    mergePolicyVersion: MERGE_POLICY_VERSION,
    listAdapterVersion: p.adapterVersion,
    finalizedAt: status === "finalized" ? p.now : null,
    createdAt: p.now,
    updatedAt: p.now,
  };
}

async function insertSnapshot(tx: DbTx, p: ProjectPageInput, contentId: bigint, m: MergedContent, status: "building" | "finalized"): Promise<bigint> {
  const [res] = await tx.insert(contentSnapshots).values(snapshotValues(p, contentId, m, status));
  return BigInt(res.insertId);
}

type CountPair = { value: bigint | null; state: string };
/** 后到的有效值（含真实 0）覆盖；后到的非有效值不擦除先到的有效值（与 merge.ts 的 later 同一规则）。 */
const laterPair = (prev: CountPair, next: CountPair): CountPair => (next.state === "value" || prev.state !== "value" ? next : prev);

/** building 模式：同一批次同一内容的快照只有一行，跨页重复时按 FS-6.6 合并；已定稿的行不改写。 */
async function upsertBuildingSnapshot(tx: DbTx, p: ProjectPageInput, contentId: bigint, m: MergedContent): Promise<bigint> {
  const [prev] = await tx
    .select()
    .from(contentSnapshots)
    .where(and(eq(contentSnapshots.batchId, p.batchId), eq(contentSnapshots.contentId, contentId)))
    .for("update");
  if (!prev) return insertSnapshot(tx, p, contentId, m, "building");
  if (prev.snapshotStatus !== "building") return prev.contentSnapshotId;

  const next = snapshotValues(p, contentId, m, "building");
  const pair = (v: keyof SnapshotValues, s: keyof SnapshotValues, pv: bigint | null, ps: string) =>
    laterPair({ value: pv, state: ps }, { value: next[v] as bigint | null, state: next[s] as string });
  const play = pair("playValue", "playState", prev.playValue, prev.playState);
  const like = pair("likeValue", "likeState", prev.likeValue, prev.likeState);
  const comment = pair("commentValue", "commentState", prev.commentValue, prev.commentState);
  const collect = pair("collectValue", "collectState", prev.collectValue, prev.collectState);
  const share = pair("shareValue", "shareState", prev.shareValue, prev.shareState);
  const durationNext = next.durationState === "value" || prev.durationState !== "value";
  const author = next.returnedAuthorIdentifier != null ? next : prev; // 标识成对更新
  const shareUrl = next.shareUrl != null ? next : prev;
  await tx
    .update(contentSnapshots)
    .set({
      returnedAuthorNamespaceCode: author.returnedAuthorNamespaceCode ?? null,
      returnedAuthorIdentifier: author.returnedAuthorIdentifier ?? null,
      returnedAuthorName: next.returnedAuthorName ?? prev.returnedAuthorName,
      publishedAt: next.publishedAt ?? prev.publishedAt,
      title: next.title ?? prev.title,
      body: next.body ?? prev.body,
      tagText: next.tagText ?? prev.tagText,
      publishLocation: next.publishLocation ?? prev.publishLocation,
      relatedSearchTerms: next.relatedSearchTerms ?? prev.relatedSearchTerms,
      shareUrl: shareUrl.shareUrl ?? null,
      shareUrlSha256: shareUrl.shareUrlSha256 ?? null,
      durationValue: durationNext ? (next.durationValue ?? null) : prev.durationValue,
      durationState: durationNext ? next.durationState : prev.durationState,
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
      lastListProviderCallId: p.sourceProviderCallId,
      listResponseReceivedAt: p.receivedAt,
      listAdapterVersion: p.adapterVersion,
      updatedAt: p.now,
    })
    .where(and(eq(contentSnapshots.contentSnapshotId, prev.contentSnapshotId), eq(contentSnapshots.snapshotStatus, "building")));
  return prev.contentSnapshotId;
}

async function hasCover(tx: DbTx, contentSnapshotId: bigint): Promise<boolean> {
  const rows = await tx
    .select({ id: mediaReferences.mediaReferenceId })
    .from(mediaReferences)
    .where(and(eq(mediaReferences.contentSnapshotId, contentSnapshotId), eq(mediaReferences.role, "cover")))
    .limit(1);
  return rows.length > 0;
}

async function insertCover(tx: DbTx, p: ProjectPageInput, contentSnapshotId: bigint, m: MergedContent): Promise<void> {
  const c = m.entry.cover;
  if (c.selected === null) return;
  await tx.insert(mediaReferences).values({
    contentSnapshotId,
    role: "cover",
    slotIndex: 0,
    sourceLocator: c.selected,
    sourceLocatorSha256: sha256Utf8(c.selected),
    sourceJsonPath: c.selectedJsonPath,
    observedAt: p.receivedAt,
    archiveStatus: "pending",
    sourceProviderCallId: p.sourceProviderCallId,
    createdAt: p.now,
    updatedAt: p.now,
  });
}


/** 平台无关的完整页投影接口：只在一个调用方给定的事务里完成整页；停止 / 续页判断只能发生在它提交之后。 */
export interface ContentListProjector {
  projectCompletePage(tx: DbTx, input: ProjectPageInput): Promise<ProjectPageResult>;
}

export const contentListProjector: ContentListProjector = { projectCompletePage: projectContentPage };
