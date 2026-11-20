// 任务领取：限时租约 + 单调递增的 fencing token（R18.1）。任务 8 在此之上补心跳、重试等待与死信。
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { syncTasks } from "../../db/schema";
import type { TaskRow } from "./fenced";

const TERMINAL = new Set(["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"]);
export const isTerminalStatus = (s: string) => TERMINAL.has(s);

export type ClaimResult =
  | { kind: "claimed"; task: TaskRow; token: bigint }
  | { kind: "terminal"; task: TaskRow }
  | { kind: "busy"; task: TaskRow }
  /** retry_wait 且还没到下一次尝试的时间。 */
  | { kind: "not_due"; task: TaskRow }
  | { kind: "not_found" };

export async function claimTask(db: Db, taskId: bigint, o: { workerId: string; leaseMs: number; now: Date }): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, taskId)).for("update");
    if (!task) return { kind: "not_found" as const };
    if (isTerminalStatus(task.status)) return { kind: "terminal" as const, task };
    if (task.status === "retry_wait" && task.nextAttemptAt && task.nextAttemptAt.getTime() > o.now.getTime()) return { kind: "not_due" as const, task };
    const leased = task.status === "leased" || task.status === "running";
    if (leased && task.leaseExpiresAt && task.leaseExpiresAt.getTime() > o.now.getTime()) return { kind: "busy" as const, task };

    const token = task.fencingToken + 1n; // 每次领取都使旧 worker 的 token 失效
    await tx
      .update(syncTasks)
      .set({
        status: "running",
        leaseOwner: o.workerId,
        leaseExpiresAt: new Date(o.now.getTime() + o.leaseMs),
        fencingToken: token,
        nextAttemptAt: null,
        startedAt: task.startedAt ?? o.now,
        updatedAt: o.now,
      })
      .where(eq(syncTasks.taskId, taskId));
    return { kind: "claimed" as const, task: { ...task, status: "running", fencingToken: token }, token };
  });
}

/**
 * 心跳：续期租约。只有 fencing token 一致、仍处于租约状态且租约未过期时才续期；
 * 否则说明已被取消 / 取代，调用方必须立即停止（不再发起新调用）。
 */
export async function heartbeat(db: Db, taskId: bigint, token: bigint, o: { now: Date; leaseMs: number }): Promise<"ok" | "cancelled" | "stale"> {
  const [r] = await db
    .update(syncTasks)
    .set({ leaseExpiresAt: new Date(o.now.getTime() + o.leaseMs), updatedAt: o.now })
    .where(and(eq(syncTasks.taskId, taskId), eq(syncTasks.fencingToken, token), inArray(syncTasks.status, ["leased", "running"]), gt(syncTasks.leaseExpiresAt, o.now)));
  if (r.affectedRows === 1) return "ok";
  const [row] = await db.select({ status: syncTasks.status }).from(syncTasks).where(eq(syncTasks.taskId, taskId));
  return row?.status === "cancelled" ? "cancelled" : "stale";
}

export interface ClaimNextOptions {
  workerId: string;
  leaseMs: number;
  now: Date;
  /** 最多领取几个（空闲槽位数）。 */
  limit: number;
  /** 只领这些动作（worker 只领已注册 Runner 的动作，未实现的动作绝不被领走后失败）。 */
  actions: readonly string[];
  /** 熔断打开的 provider：不为它们领取调用供应商的任务（媒资下载不调供应商，不受影响），任务保持原状，不消耗尝试额度（FS-3.7）。 */
  excludeProviderIds?: readonly bigint[];
  /** 本进程某类槽位已满时排除（例如媒资并发已满就不再领 download_media）。 */
  excludeActions?: readonly string[];
}
export interface ClaimedTask {
  task: TaskRow;
  token: bigint;
  /** 是从过期租约接手的（上一个持有者失联）：需要先恢复 in_flight 调用。 */
  tookOver: boolean;
  /** 领取前的状态与退避时间，unclaim 用。 */
  previous: { status: string; nextAttemptAt: Date | null };
}

/**
 * 领取（design §7.5）：`FOR UPDATE SKIP LOCKED`，排序键 `priority DESC, attempt_count ASC, task_id`——
 * 重试过的任务排在同优先级所有未重试任务之后（回到队尾，不立即重试）。
 *
 * 只领周期 / 补抓 / 按需批次（`purpose IN full/supplement/demand`）里 `running` 批次的任务；媒资任务另可领已终态
 * （未取消）批次里的任务。tracer 的 `intake` 批次不归本 worker：它们由 tracer 自己的入口驱动，领走会被误判为未实现。
 */
export async function claimNext(db: Db, o: ClaimNextOptions): Promise<ClaimedTask[]> {
  if (o.limit < 1 || o.actions.length === 0) return [];
  return db.transaction(async (tx) => {
    const list = (xs: readonly (string | bigint)[]) => sql.join(xs.map((x) => sql`${typeof x === "bigint" ? x.toString() : x}`), sql`, `);
    const [rows] = (await tx.execute(sql`
      SELECT t.task_id AS task_id FROM sync_tasks t
      WHERE ((t.status IN ('pending','retry_wait') AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ${o.now}))
          OR (t.status IN ('leased','running') AND t.lease_expires_at <= ${o.now}))
        AND t.expires_at > ${o.now}
        AND t.requested_action IN (${list(o.actions)})
        ${o.excludeActions?.length ? sql`AND t.requested_action NOT IN (${list(o.excludeActions)})` : sql``}
        ${o.excludeProviderIds?.length ? sql`AND (t.requested_action = 'download_media' OR t.provider_id NOT IN (${list(o.excludeProviderIds)}))` : sql``}
        AND EXISTS (
          SELECT 1 FROM sync_batches b
          WHERE b.batch_id = t.batch_id
            AND ((b.purpose IN ('full','supplement','demand') AND (b.status = 'running' OR (t.requested_action = 'download_media' AND b.status IN ('succeeded','partial_succeeded','failed'))))
              -- 名单导入（intake）批次终态后补建的账号级媒资任务（头像 / 主页背景）：只放行 download_media；intake 的解析根任务仍不归本 worker（2026-11-20：此前这些任务建出来没人领，573 个账号的头像停在 pending）
              OR (b.purpose = 'intake' AND t.requested_action = 'download_media' AND b.status IN ('succeeded','partial_succeeded','failed'))))
      ORDER BY t.priority DESC, t.attempt_count ASC, t.task_id ASC
      LIMIT ${o.limit}
      FOR UPDATE SKIP LOCKED`)) as unknown as [Array<{ task_id: string }>];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => BigInt(r.task_id));
    const tasks = await tx.select().from(syncTasks).where(inArray(syncTasks.taskId, ids));
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    const out: ClaimedTask[] = [];
    for (const id of ids) {
      const task = byId.get(id)!;
      const tookOver = task.status === "leased" || task.status === "running";
      const token = task.fencingToken + 1n; // 每次领取都使旧 worker 的 token 失效
      await tx
        .update(syncTasks)
        .set({
          status: "running",
          leaseOwner: o.workerId,
          leaseExpiresAt: new Date(o.now.getTime() + o.leaseMs),
          fencingToken: token,
          nextAttemptAt: null,
          startedAt: task.startedAt ?? o.now,
          updatedAt: o.now,
        })
        .where(eq(syncTasks.taskId, id));
      out.push({ task: { ...task, status: "running", fencingToken: token, leaseOwner: o.workerId }, token, tookOver, previous: { status: task.status, nextAttemptAt: task.nextAttemptAt } });
    }
    return out;
  });
}

/**
 * 领取后发现不该跑（例如领取的间隙里熔断器打开了）：把任务放回原状，不消耗尝试额度。
 * 只在 fencing token 仍是自己的时候生效；接手自过期租约的任务放回 pending（租约已作废，语义相同）。
 */
export async function unclaim(db: Db, c: ClaimedTask, now: Date): Promise<boolean> {
  const status = c.tookOver ? "pending" : c.previous.status;
  const [r] = await db
    .update(syncTasks)
    .set({ status, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: c.previous.nextAttemptAt, updatedAt: now })
    .where(and(eq(syncTasks.taskId, c.task.taskId), eq(syncTasks.fencingToken, c.token), eq(syncTasks.status, "running")));
  return r.affectedRows === 1;
}
