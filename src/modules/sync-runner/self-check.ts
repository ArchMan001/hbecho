// 自比对（FS-5.14、design §7.6.2、design-task5 §8.3）：主页「作品数」增量 vs 本批次新发现的内容数。只告警：
// 不改任务状态、不改检查点、不进批次终态——删作品、平台统计延迟都是正常原因。用来发现「检查点以为接上了其实漏了」。
//
// 它依赖「本批次主页」和「本批次列表」两个任务都已完成，而两个任务谁先结束不确定。所以在两个终态事务里各触发一次，
// 幂等（问题指纹 = code + batch + account）。为了不出现「两边都看不到对方」，两个终态事务在最开始（任何写之前）
// 先锁同一个账号行（lockAccount）：后到的那个在先到的提交之后才继续，它的第一次一致性读就能看到对方的结果。
import { and, count, desc, eq, gt, lt, or } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { accountProfileSnapshots, contents, externalAccounts, syncBatches, syncTasks } from "../../db/schema";
import { recordIssue } from "../projection";

/** 两个终态事务的第一条语句。必须在任何写入与一致性读之前调用。 */
export async function lockAccount(tx: DbTx, accountId: bigint): Promise<void> {
  await tx.select({ id: externalAccounts.accountId }).from(externalAccounts).where(eq(externalAccounts.accountId, accountId)).for("update");
}

export type SelfCheckResult =
  | { kind: "skipped"; reason: "list_not_done" | "first_baseline" | "no_profile" | "no_previous_profile" | "not_comparable" | "no_increase" }
  | { kind: "ok"; k: bigint; discovered: number }
  | { kind: "reported"; k: bigint; discovered: number };

export async function runSelfCheck(tx: DbTx, p: { batchId: bigint; accountId: bigint; assignmentId: bigint | null; now: Date }): Promise<SelfCheckResult> {
  const [list] = await tx
    .select({ status: syncTasks.status, params: syncTasks.taskParameters })
    .from(syncTasks)
    .where(and(eq(syncTasks.batchId, p.batchId), eq(syncTasks.accountId, p.accountId), eq(syncTasks.requestedAction, "fetch_content_list")))
    .limit(1);
  if (!list || (list.status !== "succeeded" && list.status !== "succeeded_with_gap")) return { kind: "skipped", reason: "list_not_done" };
  // 首次基线受 initial_content_limit 限制：发现数少于作品数增量是设计内的结果，不是漏采
  if ((list.params as { anchor_snapshot?: unknown } | null)?.anchor_snapshot == null) return { kind: "skipped", reason: "first_baseline" };

  const [cur] = await tx
    .select({ snap: accountProfileSnapshots, logicalAt: syncBatches.logicalAt })
    .from(accountProfileSnapshots)
    .innerJoin(syncBatches, eq(syncBatches.batchId, accountProfileSnapshots.batchId))
    .where(and(eq(accountProfileSnapshots.batchId, p.batchId), eq(accountProfileSnapshots.accountId, p.accountId)));
  if (!cur) return { kind: "skipped", reason: "no_profile" };

  // 上一份更早的主页快照：(logical_at, batch_id) 严格更早的最近一份，补抓批次也算，不要求它有效
  const [prev] = await tx
    .select({ snap: accountProfileSnapshots })
    .from(accountProfileSnapshots)
    .innerJoin(syncBatches, eq(syncBatches.batchId, accountProfileSnapshots.batchId))
    .where(
      and(
        eq(accountProfileSnapshots.accountId, p.accountId),
        or(lt(syncBatches.logicalAt, cur.logicalAt), and(eq(syncBatches.logicalAt, cur.logicalAt), lt(accountProfileSnapshots.batchId, p.batchId))),
      ),
    )
    .orderBy(desc(syncBatches.logicalAt), desc(accountProfileSnapshots.batchId))
    .limit(1);
  if (!prev) return { kind: "skipped", reason: "no_previous_profile" };

  const a = cur.snap;
  const b = prev.snap;
  if (a.postState !== "value" || b.postState !== "value" || a.postValue === null || b.postValue === null) return { kind: "skipped", reason: "not_comparable" };
  const k = a.postValue - b.postValue;
  if (k <= 0n) return { kind: "skipped", reason: "no_increase" }; // 持平与负增长不报

  const [{ n }] = (await tx
    .select({ n: count() })
    .from(contents)
    .where(and(eq(contents.accountId, p.accountId), gt(contents.firstSeenAt, b.responseReceivedAt)))) as [{ n: number }];
  if (BigInt(n) >= k) return { kind: "ok", k, discovered: n };
  await recordIssue(tx, {
    code: "suspected_missing_content",
    severity: "warning",
    batchId: p.batchId,
    accountId: p.accountId,
    assignmentId: p.assignmentId,
    discriminator: "post_delta",
    detail: { k: k.toString(), discovered: n, current_profile_snapshot_id: a.profileSnapshotId.toString(), previous_profile_snapshot_id: b.profileSnapshotId.toString() },
    now: p.now,
  });
  return { kind: "reported", k, discovered: n };
}
