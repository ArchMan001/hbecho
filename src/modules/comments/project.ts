// 一级评论最新态的写入（v2 §10.4、FS-10）。全部在调用方给定的 fenced 事务里完成。
// 只保存一级评论；不建作者账号、作者历史、头像媒资或回复树。
import { and, eq, lt } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { comments } from "../../db/schema";
import { sha256Utf8 } from "../canonical-json";
import type { CommentEntry } from "../provider-adapter";
import { countColumns, fit, msToDate, textOrNull } from "../projection/columns";

const MAX_COMMENT_ID_LENGTH = 2048;
export interface UpsertResult {
  upserted: number;
  inserted: number;
  restored: number;
  /** 评论 ID 缺失 / 非法 / 过长：无法确定身份，计数并留问题，不阻塞其余条目。 */
  invalid: Array<{ position: number; state: string }>;
}

/** 按 (content_id, platform_comment_id) 幂等 upsert；再次出现的评论恢复 active 并清除疑似删除时间。命中哈希后复核原文。 */
export async function upsertComments(tx: DbTx, p: { contentId: bigint; entries: readonly CommentEntry[]; providerCallId: bigint; now: Date }): Promise<UpsertResult> {
  const out: UpsertResult = { upserted: 0, inserted: 0, restored: 0, invalid: [] };
  for (const e of p.entries) {
    if (e.id.state !== "value" || e.id.value.length > MAX_COMMENT_ID_LENGTH) {
      out.invalid.push({ position: e.position, state: e.id.state === "value" ? "too_long" : e.id.state });
      continue;
    }
    const id = e.id.value;
    const sha = sha256Utf8(id);
    const like = countColumns(e.likeCount);
    const reply = countColumns(e.replyCount);
    const fields = {
      authorIdentifier: e.authorId.state === "value" && e.authorId.value.length <= 2048 ? e.authorId.value : null,
      authorName: fit(textOrNull(e.authorName), 512),
      contentText: textOrNull(e.content),
      likeValue: like.value,
      likeState: like.state,
      replyValue: reply.value,
      replyState: reply.state,
      platformCreatedAt: msToDate(e.createdAtMs),
      providerUpdatedAt: msToDate(e.updatedAtMs),
      lastProviderCallId: p.providerCallId,
    };
    const [row] = await tx.select().from(comments).where(and(eq(comments.contentId, p.contentId), eq(comments.platformCommentIdSha256, sha))).for("update");
    if (row) {
      if (row.platformCommentId !== id) throw new Error("comment_hash_collision: 哈希命中但原文不同");
      if (row.status !== "active") out.restored++;
      await tx
        .update(comments)
        .set({ ...fields, status: "active", suspectedDeletedAt: null, lastSeenAt: p.now, updatedAt: p.now })
        .where(eq(comments.commentId, row.commentId));
    } else {
      await tx.insert(comments).values({ contentId: p.contentId, platformCommentId: id, platformCommentIdSha256: sha, status: "active", ...fields, firstSeenAt: p.now, lastSeenAt: p.now, createdAt: p.now, updatedAt: p.now });
      out.inserted++;
    }
    out.upserted++;
  }
  return out;
}

/** 只在完整抓取之后调用：本次抓取开始之前最后一次见到、此后没再出现的 active 评论 → suspected_deleted。已删除（deleted）的不动。 */
export async function markSuspectedDeleted(tx: DbTx, p: { contentId: bigint; fetchStartedAt: Date; now: Date }): Promise<number> {
  const [r] = await tx
    .update(comments)
    .set({ status: "suspected_deleted", suspectedDeletedAt: p.now, updatedAt: p.now })
    .where(and(eq(comments.contentId, p.contentId), eq(comments.status, "active"), lt(comments.lastSeenAt, p.fetchStartedAt)));
  return r.affectedRows;
}
