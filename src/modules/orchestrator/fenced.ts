// 带 fencing 的短事务：先按 task_id 升序锁定相关任务行并校验租约，再执行写入。
// 校验失败时整笔不写（陈旧 worker 不能发布 current / 检查点 / 归属 / 终态）。
import { inArray } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { retryOnDeadlock } from "../../db/deadlock";
import { syncTasks } from "../../db/schema";
import { fenceFailure, type Clock, type FenceFailureReason } from "../raw-capture";

export type TaskRow = typeof syncTasks.$inferSelect;

export type Fenced<T> = { ok: true; value: T } | { ok: false; reason: FenceFailureReason; taskId: bigint };

export function isDuplicateKey(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_DUP_ENTRY") return true;
  }
  return false;
}

export async function withFences<T>(
  db: Db,
  clock: Clock,
  locks: ReadonlyArray<{ taskId: bigint; token: bigint }>,
  fn: (tx: DbTx, tasks: Map<bigint, TaskRow>) => Promise<T>,
): Promise<Fenced<T>> {
  const ordered = [...locks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  // 死锁时整笔事务已回滚，原样重跑即可（先锁任务行、再写，fn 只在事务内写库）。
  // 实测：名单解析并发运行多个根任务时，两个根任务同时收尾，各自更新同一个 sync_batches 行，InnoDB 会选一个当死锁受害者
  return retryOnDeadlock(() => db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(syncTasks)
      .where(inArray(syncTasks.taskId, ordered.map((l) => l.taskId)))
      .orderBy(syncTasks.taskId)
      .for("update");
    const byId = new Map(rows.map((r) => [r.taskId, r]));
    const now = clock.now();
    for (const l of ordered) {
      const failure = fenceFailure(byId.get(l.taskId), l.token, now);
      if (failure) return { ok: false as const, reason: failure, taskId: l.taskId };
    }
    return { ok: true as const, value: await fn(tx, byId) };
  }));
}

/** 并发的另一个 worker 抢先建立了同一个账号 / 标识：重试一次，此时会命中已有行。 */
export async function retryOnDuplicate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isDuplicateKey(e)) return fn();
    throw e;
  }
}
