// 特征行写入（design §7.4）：计算在事务之外，事务只做「锁特征行 → 排序检查 → 写历史 → 更新」，不做任何 IO。
import { eq } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { commentFeatures, contentFeatures, signalHistory } from "../../../db/schema";
import { isNewer } from "../../projection";
import { retryOnDeadlock } from "../../../db/deadlock";
import type { Clock } from "../../raw-capture";
import { platformSignals } from "../catalog";
import { createFacts, type CommentFact, type ContentFact } from "../facts";
import type { HashtagParser } from "../text/hashtags";
import { historyExpiry } from "../ttl";
import { commentMaterialSha, computeCommentFeature, computeContentFeatures, contentMaterialSha, envelopeIsCurrent, type Envelope } from "./compute";

export type IngestMode = "normal" | "recompute";
export type IngestOutcome = "created" | "updated" | "advanced" | "unchanged" | "skipped_older" | "unsupported_platform" | "skipped_inactive";

export interface IngestDeps {
  db: Db;
  clock: Clock;
  /** 测试注入：让某平台的话题解析器抛错。 */
  parsers?: Readonly<Record<string, HashtagParser>>;
}

type HistoryRow = typeof signalHistory.$inferInsert;
const reasonOf = (mode: IngestMode) => (mode === "recompute" ? "capability_upgraded" : "material_changed");

function historyRows(
  base: { subjectKind: "content" | "comment"; subjectId: bigint; snapshotId: bigint | null },
  old: Envelope,
  values: Record<string, unknown>,
  now: Date,
  mode: IngestMode,
): HistoryRow[] {
  return Object.entries(old).map(([signalKey, e]) => ({
    subjectKind: base.subjectKind,
    subjectId: base.subjectId,
    subjectSnapshotId: base.snapshotId,
    signalKey,
    state: e.state,
    value: e.state === "valid" ? (values[signalKey] ?? null) : null,
    capabilityId: e.cap,
    capabilityVersion: e.ver,
    normalizerVersion: e.nv ?? null,
    producedAt: new Date(e.at),
    supersededAt: now,
    supersededReason: reasonOf(mode),
    expiresAt: historyExpiry(now),
  }));
}

export async function ingestContent(deps: IngestDeps, f: ContentFact, mode: IngestMode = "normal"): Promise<IngestOutcome> {
  if (!platformSignals(f.platform).includes("text.hashtags")) return "unsupported_platform";
  const now = deps.clock.now();
  const material = contentMaterialSha(f);
  const fresh = computeContentFeatures(f, now, deps.parsers); // 纯函数，事务之外
  return retryOnDeadlock(() =>
    deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(contentFeatures).where(eq(contentFeatures.contentId, f.contentId)).for("update");
      if (row) {
        const [rowOrder] = [...(await createFacts(tx).batchOrders([row.contentSnapshotId])).values()];
        // normal：只接受严格更新的批次（相同批次也跳过，重复扫描无写入）；recompute：只拒绝严格更旧的批次，允许当前批次重算
        if (rowOrder && (mode === "normal" ? !isNewer(f.batchOrder, rowOrder) && row.contentSnapshotId !== f.snapshotId : isNewer(rowOrder, f.batchOrder))) return "skipped_older";
        const same = row.textMaterialSha256.equals(material);
        if (mode === "normal" && same) {
          if (row.contentSnapshotId === f.snapshotId) return "unchanged";
          // 素材未变：只前移所持快照，不写值、不写历史
          await tx.update(contentFeatures).set({ contentSnapshotId: f.snapshotId, updatedAt: now }).where(eq(contentFeatures.contentId, f.contentId));
          return "advanced";
        }
        if (mode === "recompute" && same && envelopeIsCurrent(row.signals as Envelope, fresh.signals)) return "unchanged";
        await tx.insert(signalHistory).values(
          historyRows({ subjectKind: "content", subjectId: f.contentId, snapshotId: row.contentSnapshotId }, row.signals as Envelope, {
            "text.title_normalized": row.titleNormalized,
            "text.body_normalized": row.bodyNormalized,
            "text.hashtags": row.hashtags,
          }, now, mode),
        );
        await tx
          .update(contentFeatures)
          .set({ contentSnapshotId: f.snapshotId, textMaterialSha256: material, titleNormalized: fresh.titleNormalized, bodyNormalized: fresh.bodyNormalized, hashtags: fresh.hashtags, signals: fresh.signals, updatedAt: now })
          .where(eq(contentFeatures.contentId, f.contentId));
        return "updated";
      }
      await tx.insert(contentFeatures).values({
        contentId: f.contentId,
        contentSnapshotId: f.snapshotId,
        textMaterialSha256: material,
        titleNormalized: fresh.titleNormalized,
        bodyNormalized: fresh.bodyNormalized,
        hashtags: fresh.hashtags,
        signals: fresh.signals,
        createdAt: now,
        updatedAt: now,
      });
      return "created";
    }),
  );
}

/** 评论没有快照 / 批次，只有素材指纹与 nv；suspected_deleted 与 deleted 的评论不新抽取。 */
export async function ingestComment(deps: IngestDeps, f: CommentFact, mode: IngestMode = "normal"): Promise<IngestOutcome> {
  if (!platformSignals(f.platform).includes("comment.text_normalized")) return "unsupported_platform";
  if (f.status !== "active") return "skipped_inactive";
  const now = deps.clock.now();
  const material = commentMaterialSha(f.contentText);
  const fresh = computeCommentFeature(f.contentText, f.platform, now);
  return retryOnDeadlock(() =>
    deps.db.transaction(async (tx: DbTx) => {
      const [row] = await tx.select().from(commentFeatures).where(eq(commentFeatures.commentId, f.commentId)).for("update");
      if (!row) {
        await tx.insert(commentFeatures).values({ commentId: f.commentId, textMaterialSha256: material, textNormalized: fresh.textNormalized, signals: fresh.signals, createdAt: now, updatedAt: now });
        return "created";
      }
      const same = row.textMaterialSha256.equals(material);
      if (same && (mode === "normal" || envelopeIsCurrent(row.signals as Envelope, fresh.signals))) return "unchanged";
      await tx.insert(signalHistory).values(historyRows({ subjectKind: "comment", subjectId: f.commentId, snapshotId: null }, row.signals as Envelope, { "comment.text_normalized": row.textNormalized }, now, mode));
      await tx.update(commentFeatures).set({ textMaterialSha256: material, textNormalized: fresh.textNormalized, signals: fresh.signals, updatedAt: now }).where(eq(commentFeatures.commentId, f.commentId));
      return "updated";
    }),
  );
}
