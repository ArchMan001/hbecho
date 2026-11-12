// A 事实读取口（design §4）：C 读 A 的表的**唯一**入口，全部批量、只读。A 改表结构时只改这一个文件；
// 静态护栏（acceptance-boundaries）保证别的 signals 文件不 import A 的表，也不写 A 的表。
import { and, asc, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { comments, contentSnapshots, contents, externalAccounts, mediaAssets, mediaReferences, ossObjects, platforms, staffAccountAssignments, stores, syncBatches, mediaStaff } from "../../db/schema";
import { requireSignal } from "./catalog";
import { SignalError } from "./errors";

type Q = Db | DbTx;

export interface BatchOrder {
  logicalAt: Date;
  batchId: bigint;
}

/** 内容的 current（finalized）快照上的文本事实。title / body / tagText 保留 NULL 与空串的区别。 */
export interface ContentFact {
  contentId: bigint;
  platform: string;
  snapshotId: bigint;
  batchOrder: BatchOrder;
  title: string | null;
  body: string | null;
  tagText: string | null;
}

export interface CommentFact {
  commentId: bigint;
  contentId: bigint;
  platform: string;
  status: string;
  /** NULL 与空串都读作 valid 的空值，但指纹区分二者（design §7.5）。 */
  contentText: string | null;
}

/** 素材缺口的原因码（design §6.4 的 missing 子集）。 */
export type MaterialMissing = "no_profile_snapshot" | "media_pending" | "media_failed" | "media_carried_forward" | "audio_not_archived";

export type Material =
  | { state: "ready"; assetId: bigint; sha256: Buffer }
  | { state: "not_applicable"; reason: "no_reference" }
  | { state: "missing"; reason: MaterialMissing };

export interface RefState {
  archiveStatus: string;
  mediaAssetId: bigint | null;
  assetSha256: Buffer | null;
  assetVerification: string | null;
}

/**
 * 素材状态映射（requirements §1.4 第 7 项）：pending → missing；failed → missing；
 * carried_forward → missing（PRD C §5.5：本轮下载失败、续用旧资产，不能当作当前图）；archived 且资产已验证 → ready。
 * archived 但字节读不到或解码失败是评分任务才知道的事，由任务写 failed 结果行，不在这里。
 */
export function materialOf(ref: RefState): Material {
  switch (ref.archiveStatus) {
    case "archived":
      // 数据库的 CHECK 保证 archived 一定有资产；quarantined 资产不得用于匹配
      return ref.mediaAssetId !== null && ref.assetSha256 !== null && ref.assetVerification === "verified"
        ? { state: "ready", assetId: ref.mediaAssetId, sha256: ref.assetSha256 }
        : { state: "missing", reason: "media_failed" };
    case "pending":
      return { state: "missing", reason: "media_pending" };
    case "carried_forward":
      return { state: "missing", reason: "media_carried_forward" };
    default:
      return { state: "missing", reason: "media_failed" };
  }
}

/** 重算范围：各项取交集，至少一项（design §7.10）。brandId 是内部品牌 ID；编码到 ID 的转换与品牌范围校验由 ScopeResolver（任务 10）负责。 */
export interface SubjectScope {
  contentIds?: bigint[];
  accountIds?: bigint[];
  brandId?: bigint;
  /** 内容 current 快照的发布时间，[from, to)。只适用于内容 / 评论信号。 */
  publishedFrom?: Date;
  publishedTo?: Date;
}

const batchCols = { logicalAt: syncBatches.logicalAt, batchId: syncBatches.batchId };

export function createFacts(db: Q) {
  /** 批量取内容的 current 快照文本。没有 finalized current 快照的内容不在结果里。 */
  async function contentFacts(ids: readonly bigint[]): Promise<Map<bigint, ContentFact>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({
        contentId: contents.contentId,
        platform: platforms.platformCode,
        snapshotId: contentSnapshots.contentSnapshotId,
        title: contentSnapshots.title,
        body: contentSnapshots.body,
        tagText: contentSnapshots.tagText,
        ...batchCols,
      })
      .from(contents)
      .innerJoin(contentSnapshots, and(eq(contentSnapshots.contentId, contents.contentId), eq(contentSnapshots.contentSnapshotId, contents.currentSnapshotId)))
      .innerJoin(syncBatches, eq(syncBatches.batchId, contentSnapshots.batchId))
      .innerJoin(platforms, eq(platforms.platformId, contents.platformId))
      .where(and(inArray(contents.contentId, [...ids]), eq(contentSnapshots.snapshotStatus, "finalized")));
    return new Map(
      rows.map((r) => [r.contentId, { contentId: r.contentId, platform: r.platform, snapshotId: r.snapshotId, batchOrder: { logicalAt: r.logicalAt, batchId: r.batchId }, title: r.title, body: r.body, tagText: r.tagText }]),
    );
  }

  async function commentFacts(ids: readonly bigint[]): Promise<Map<bigint, CommentFact>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ commentId: comments.commentId, contentId: comments.contentId, platform: platforms.platformCode, status: comments.status, contentText: comments.contentText })
      .from(comments)
      .innerJoin(contents, eq(contents.contentId, comments.contentId))
      .innerJoin(platforms, eq(platforms.platformId, contents.platformId))
      .where(inArray(comments.commentId, [...ids]));
    return new Map(rows.map((r) => [r.commentId, r]));
  }

  /**
   * 账号的头像 / 背景素材，取其 current 主页快照上的引用（主页图每批次重建引用，所以 current 快照上有）。
   * 账号尚无 current 主页快照 → missing(no_profile_snapshot)，不是 not_applicable；有快照但没有引用行 → not_applicable。
   */
  async function profileMaterial(accountIds: readonly bigint[], role: "avatar" | "background"): Promise<Map<bigint, Material>> {
    if (accountIds.length === 0) return new Map();
    const rows = await db
      .select({
        accountId: externalAccounts.accountId,
        profileSnapshotId: externalAccounts.currentProfileSnapshotId,
        archiveStatus: mediaReferences.archiveStatus,
        mediaAssetId: mediaReferences.mediaAssetId,
        assetSha256: mediaAssets.sha256,
        assetVerification: mediaAssets.verificationStatus,
      })
      .from(externalAccounts)
      .leftJoin(mediaReferences, and(eq(mediaReferences.profileSnapshotId, externalAccounts.currentProfileSnapshotId), eq(mediaReferences.role, role), eq(mediaReferences.slotIndex, 0)))
      .leftJoin(mediaAssets, eq(mediaAssets.mediaAssetId, mediaReferences.mediaAssetId))
      .where(inArray(externalAccounts.accountId, [...accountIds]));
    return new Map(
      rows.map((r): [bigint, Material] => [
        r.accountId,
        r.profileSnapshotId === null ? { state: "missing", reason: "no_profile_snapshot" } : r.archiveStatus === null ? { state: "not_applicable", reason: "no_reference" } : materialOf({ archiveStatus: r.archiveStatus, mediaAssetId: r.mediaAssetId, assetSha256: r.assetSha256, assetVerification: r.assetVerification }),
      ]),
    );
  }

  /**
   * 内容的音频素材：该内容**任一快照**下已归档的 audio 引用（音频字节不随快照变化），多条取最新批次。
   * 没有 → missing(audio_not_archived)；C 不提采集需求（PRD C §8.2）。
   */
  async function audioMaterial(contentIds: readonly bigint[]): Promise<Map<bigint, Material>> {
    const out = new Map<bigint, Material>(contentIds.map((id) => [id, { state: "missing", reason: "audio_not_archived" }]));
    if (contentIds.length === 0) return out;
    const rows = await db
      .select({ contentId: contentSnapshots.contentId, assetId: mediaAssets.mediaAssetId, sha256: mediaAssets.sha256 })
      .from(mediaReferences)
      .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
      .innerJoin(syncBatches, eq(syncBatches.batchId, contentSnapshots.batchId))
      .innerJoin(mediaAssets, eq(mediaAssets.mediaAssetId, mediaReferences.mediaAssetId))
      .where(and(inArray(contentSnapshots.contentId, [...contentIds]), eq(mediaReferences.role, "audio"), eq(mediaReferences.archiveStatus, "archived"), eq(mediaAssets.verificationStatus, "verified")))
      .orderBy(desc(syncBatches.logicalAt), desc(syncBatches.batchId));
    const seen = new Set<bigint>();
    for (const r of rows) {
      if (seen.has(r.contentId)) continue;
      seen.add(r.contentId);
      out.set(r.contentId, { state: "ready", assetId: r.assetId, sha256: r.sha256 });
    }
    return out;
  }

  /** 媒资的对象位置（桶与 key）。只返回 available 的对象；读不到的资产不在结果里。 */
  async function mediaObjectOf(assetIds: readonly bigint[]): Promise<Map<bigint, { bucket: string; objectKey: string }>> {
    if (assetIds.length === 0) return new Map();
    const rows = await db
      .select({ assetId: mediaAssets.mediaAssetId, bucket: ossObjects.bucket, objectKey: ossObjects.objectKey })
      .from(mediaAssets)
      .innerJoin(ossObjects, eq(ossObjects.ossObjectId, mediaAssets.ossObjectId))
      .where(and(inArray(mediaAssets.mediaAssetId, [...assetIds]), eq(ossObjects.status, "available")));
    return new Map(rows.map((r) => [r.assetId, { bucket: r.bucket, objectKey: r.objectKey }]));
  }

  /**
   * 重算范围展开：按信号的对象类型返回主体 ID（升序，> after，至多 limit 个）。
   * 内容：有 finalized current 快照的内容；评论：上述内容下 active 的评论；账号：账号。
   * brandId 经账号的**当前**归属（staff_account_assignments → 专员 → 门店 → 品牌）展开。
   */
  async function scopeSubjects(scope: SubjectScope, signalKey: string, after: bigint, limit: number): Promise<bigint[]> {
    const object = requireSignal(signalKey).object;
    const filtered = scope.contentIds !== undefined || scope.accountIds !== undefined || scope.brandId !== undefined || scope.publishedFrom !== undefined || scope.publishedTo !== undefined;
    if (!filtered) throw new SignalError("input", "scope_required", "范围至少要给一项，不接受「全部」");
    const timed = scope.publishedFrom !== undefined || scope.publishedTo !== undefined;
    if (object === "account" && (timed || scope.contentIds !== undefined)) throw new SignalError("input", "scope_not_applicable", "账号类信号的范围只支持 accountIds 与 brandId");
    // 账号的当前归属：staff_account_assignments（一账号一行）→ 专员 → 门店 → 品牌
    const brandAccounts =
      scope.brandId === undefined
        ? undefined
        : db
            .select({ id: staffAccountAssignments.accountId })
            .from(staffAccountAssignments)
            .innerJoin(mediaStaff, eq(mediaStaff.staffId, staffAccountAssignments.staffId))
            .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
            .where(eq(stores.brandId, scope.brandId));

    if (object === "account") {
      const rows = await db
        .select({ id: externalAccounts.accountId })
        .from(externalAccounts)
        .where(and(gt(externalAccounts.accountId, after), scope.accountIds && inArray(externalAccounts.accountId, scope.accountIds), brandAccounts && inArray(externalAccounts.accountId, brandAccounts)))
        .orderBy(asc(externalAccounts.accountId))
        .limit(limit);
      return rows.map((r) => r.id);
    }

    const contentWhere = and(
      scope.contentIds && inArray(contents.contentId, scope.contentIds),
      scope.accountIds && inArray(contents.accountId, scope.accountIds),
      brandAccounts && inArray(contents.accountId, brandAccounts),
      scope.publishedFrom && gte(contentSnapshots.publishedAt, scope.publishedFrom),
      scope.publishedTo && lt(contentSnapshots.publishedAt, scope.publishedTo),
    );
    const currentSnapshot = and(eq(contentSnapshots.contentId, contents.contentId), eq(contentSnapshots.contentSnapshotId, contents.currentSnapshotId), eq(contentSnapshots.snapshotStatus, "finalized"))!;
    if (object === "content") {
      const rows = await db
        .select({ id: contents.contentId })
        .from(contents)
        .innerJoin(contentSnapshots, currentSnapshot)
        .where(and(gt(contents.contentId, after), contentWhere))
        .orderBy(asc(contents.contentId))
        .limit(limit);
      return rows.map((r) => r.id);
    }
    const rows = await db
      .select({ id: comments.commentId })
      .from(comments)
      .innerJoin(contents, eq(contents.contentId, comments.contentId))
      .innerJoin(contentSnapshots, currentSnapshot)
      .where(and(gt(comments.commentId, after), eq(comments.status, "active"), contentWhere))
      .orderBy(asc(comments.commentId))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  return { contentFacts, commentFacts, profileMaterial, audioMaterial, mediaObjectOf, scopeSubjects };
}
export type Facts = ReturnType<typeof createFacts>;
