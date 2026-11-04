// current 指针只接受 finalized 快照，并按 (batch.logical_at, batch_id) 严格更新（v2 §5.4、§12.6）。
// 旧批次迟到只留下历史，不让 current 倒退。
import { and, eq } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { accountProfileSnapshots, contentSnapshots, contents, externalAccounts, syncBatches } from "../../db/schema";

interface BatchOrder {
  logicalAt: Date;
  batchId: bigint;
}

export function isNewer(candidate: BatchOrder, current: BatchOrder | undefined): boolean {
  if (!current) return true;
  const c = candidate.logicalAt.getTime();
  const k = current.logicalAt.getTime();
  return c > k || (c === k && candidate.batchId > current.batchId);
}

async function orderOf(tx: DbTx, batchId: bigint): Promise<BatchOrder> {
  const [b] = await tx.select({ logicalAt: syncBatches.logicalAt, batchId: syncBatches.batchId }).from(syncBatches).where(eq(syncBatches.batchId, batchId));
  if (!b) throw new Error(`批次 ${batchId} 不存在`);
  return b;
}

/** 候选主页快照必须是已终态化的快照（创建成功即终态）；返回是否切换了 current。 */
export async function selectCurrentProfile(tx: DbTx, accountId: bigint, candidateSnapshotId: bigint, now: Date): Promise<boolean> {
  const [acct] = await tx.select().from(externalAccounts).where(eq(externalAccounts.accountId, accountId)).for("update");
  const [cand] = await tx
    .select()
    .from(accountProfileSnapshots)
    .where(and(eq(accountProfileSnapshots.profileSnapshotId, candidateSnapshotId), eq(accountProfileSnapshots.accountId, accountId)));
  if (!acct || !cand) throw new Error("候选主页快照不属于该账号");
  let currentOrder: BatchOrder | undefined;
  if (acct.currentProfileSnapshotId !== null) {
    const [cur] = await tx.select().from(accountProfileSnapshots).where(eq(accountProfileSnapshots.profileSnapshotId, acct.currentProfileSnapshotId));
    if (cur) currentOrder = await orderOf(tx, cur.batchId);
  }
  if (!isNewer(await orderOf(tx, cand.batchId), currentOrder)) return false;
  await tx
    .update(externalAccounts)
    .set({ currentProfileSnapshotId: candidateSnapshotId, currentProfileSelectedAt: now, updatedAt: now })
    .where(eq(externalAccounts.accountId, accountId));
  return true;
}

/** 只接受 finalized 内容快照。 */
export async function selectCurrentContentSnapshot(tx: DbTx, contentId: bigint, candidateSnapshotId: bigint, now: Date): Promise<boolean> {
  const [content] = await tx.select().from(contents).where(eq(contents.contentId, contentId)).for("update");
  const [cand] = await tx
    .select()
    .from(contentSnapshots)
    .where(and(eq(contentSnapshots.contentSnapshotId, candidateSnapshotId), eq(contentSnapshots.contentId, contentId)));
  if (!content || !cand) throw new Error("候选内容快照不属于该内容");
  if (cand.snapshotStatus !== "finalized") return false;
  let currentOrder: BatchOrder | undefined;
  if (content.currentSnapshotId !== null) {
    const [cur] = await tx.select().from(contentSnapshots).where(eq(contentSnapshots.contentSnapshotId, content.currentSnapshotId));
    if (cur) currentOrder = await orderOf(tx, cur.batchId);
  }
  if (!isNewer(await orderOf(tx, cand.batchId), currentOrder)) return false;
  await tx
    .update(contents)
    .set({ currentSnapshotId: candidateSnapshotId, currentSnapshotSelectedAt: now, updatedAt: now })
    .where(eq(contents.contentId, contentId));
  return true;
}
