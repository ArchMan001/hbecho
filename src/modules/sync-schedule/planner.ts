// 批次规划（design §7.4）：只创建任务，不发任何调用。
// 分块（默认 500）读取有效监控目标，每块一个短事务；幂等键保证崩溃后从头再规划一遍也不会重复。
// 周期批次不创建详情 / 评论 / 视频 / 音频任务（A §7.3）；external 型只有 fetch_profile（R7）。
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "../../db/client";
import { dataProviders, externalAccounts, syncBatches, syncCheckpoints, syncTasks } from "../../db/schema";
import type { MonitoringResolver, TargetRow } from "../monitoring";
import type { Clock } from "../raw-capture";
import { loadSettings } from "./settings";
import { ACTIVE_TASK_STATUSES, ONE_YEAR_MS, SUPPLEMENT_PRIORITY, taskIdempotencyKey } from "./task-keys";

export const PROFILE_TASK_SCHEMA = "sync-profile-task.v1";
export const LIST_TASK_SCHEMA = "sync-list-task.v1";

const modeSchema = z.enum(["synchronous", "asynchronous"]);
/** 批次快照里规划需要的部分（settings.ts 的 settingsSnapshot 写入）。 */
const planSnapshot = z.looseObject({
  initial_content_limit: z.number().int(),
  list_safety_page_limit: z.number().int(),
  task_max_attempts: z.number().int(),
  runtime: z.looseObject({ modes: z.strictObject({ media_user_info: modeSchema, user_video_list: modeSchema }) }),
  supplement: z.looseObject({ account_ids: z.array(z.string()), only: z.enum(["profile", "list", "full"]) }).optional(),
});

export interface ReusedTask {
  accountId: string;
  action: string;
  taskId: string;
}
export interface PlanReport {
  batchId: string;
  /** planned：已写完任务并转 running；skipped：没有任务；aborted：规划中被取消或已被别处接手。 */
  outcome: "running" | "skipped" | "aborted";
  taskCount: number;
  reused: ReusedTask[];
}

export interface PlannerDeps {
  db: Db;
  clock: Clock;
  resolver: MonitoringResolver;
  /** 每块账号数，≤500（FS-2.7）。 */
  chunkSize?: number;
}

export function createBatchPlanner(deps: PlannerDeps) {
  const { db, clock, resolver } = deps;
  const chunkSize = deps.chunkSize ?? 500;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) throw new RangeError("规划块大小必须在 1..500");

  async function providerId(): Promise<bigint> {
    const [p] = await db.select({ id: dataProviders.providerId }).from(dataProviders).where(eq(dataProviders.providerCode, "aimaster"));
    if (!p) throw new Error("数据供应商 aimaster 未登记");
    return p.id;
  }

  async function planChunk(
    tx: DbTx,
    p: { batchId: bigint; snapshot: z.infer<typeof planSnapshot>; providerId: bigint; rows: TargetRow[]; only: "profile" | "list" | "full"; priority: number; bump: boolean; now: Date },
  ): Promise<ReusedTask[]> {
    const ids = p.rows.map((r) => r.accountId);
    // 账号行锁下判断复用（FS-3.5）；按 ID 排序加锁避免互相死锁
    await tx.select({ id: externalAccounts.accountId }).from(externalAccounts).where(inArray(externalAccounts.accountId, ids)).orderBy(asc(externalAccounts.accountId)).for("update");

    const wanted = p.rows.flatMap((r) => {
      const actions = r.watchType === "external" || p.only === "profile" ? ["fetch_profile"] : p.only === "list" ? ["fetch_content_list"] : ["fetch_profile", "fetch_content_list"];
      return actions.map((action) => ({ row: r, action }));
    });
    const actions = [...new Set(wanted.map((w) => w.action))];
    const active = await tx
      .select({ taskId: syncTasks.taskId, accountId: syncTasks.accountId, action: syncTasks.requestedAction, priority: syncTasks.priority })
      .from(syncTasks)
      .where(and(inArray(syncTasks.accountId, ids), inArray(syncTasks.requestedAction, actions), inArray(syncTasks.status, [...ACTIVE_TASK_STATUSES]), ne(syncTasks.batchId, p.batchId)));
    const activeBy = new Map(active.map((t) => [`${t.accountId}/${t.action}`, t]));
    const reused: ReusedTask[] = [];
    const fresh = wanted.filter((w) => {
      const hit = activeBy.get(`${w.row.accountId}/${w.action}`);
      if (!hit) return true;
      reused.push({ accountId: w.row.accountId.toString(), action: w.action, taskId: hit.taskId.toString() });
      return false;
    });
    if (p.bump) {
      const toBump = active.filter((t) => t.priority < p.priority).map((t) => t.taskId);
      if (toBump.length) await tx.update(syncTasks).set({ priority: p.priority, updatedAt: p.now }).where(inArray(syncTasks.taskId, toBump));
    }

    // 旧检查点快照进任务参数：重试与续跑看到同一旧边界（design §6.2）
    const listAccounts = fresh.filter((w) => w.action === "fetch_content_list").map((w) => w.row.accountId);
    const checkpoints = listAccounts.length
      ? await tx
          .select()
          .from(syncCheckpoints)
          .where(and(inArray(syncCheckpoints.accountId, listAccounts), eq(syncCheckpoints.providerId, p.providerId), eq(syncCheckpoints.action, "fetch_content_list"), eq(syncCheckpoints.checkpointScope, "default")))
      : [];
    const cpBy = new Map(checkpoints.map((c) => [c.accountId, c]));
    const modes = p.snapshot.runtime.modes;

    if (fresh.length) {
      await tx
        .insert(syncTasks)
        .values(
          fresh.map(({ row, action }) => {
            const cp = cpBy.get(row.accountId);
            const params =
              action === "fetch_profile"
                ? { schema_version: PROFILE_TASK_SCHEMA, mode: modes.media_user_info }
                : {
                    schema_version: LIST_TASK_SCHEMA,
                    mode: modes.user_video_list,
                    initial_content_limit: p.snapshot.initial_content_limit,
                    safety_page_limit: p.snapshot.list_safety_page_limit,
                    anchor_snapshot: cp
                      ? {
                          anchor_mode: cp.anchorMode,
                          hw_published_at: cp.highWatermarkPublishedAt?.toISOString() ?? null,
                          hw_content_ids: cp.highWatermarkContentIds ?? null,
                          continuity_status: cp.continuityStatus,
                          checkpoint_version: cp.version.toString(),
                        }
                      : null,
                  };
            return {
              batchId: p.batchId,
              providerId: p.providerId,
              platformId: row.platformId,
              assignmentId: row.assignmentId,
              accountId: row.accountId,
              requestedAction: action,
              subjectType: "external_account",
              subjectId: row.accountId,
              taskParameters: params,
              idempotencyKey: taskIdempotencyKey({ batchId: p.batchId, accountId: row.accountId, action }),
              status: "pending",
              priority: p.priority,
              attemptCount: 0,
              maxAttempts: p.snapshot.task_max_attempts,
              expiresAt: new Date(p.now.getTime() + ONE_YEAR_MS),
              createdAt: p.now,
              updatedAt: p.now,
            };
          }),
        )
        // 幂等键冲突即跳过：崩溃后整批重新规划不会重复
        .onDuplicateKeyUpdate({ set: { taskId: sql`task_id` } });
    }
    return reused;
  }

  /** 规划一个 planned 批次；幂等，可在崩溃后从头再来。 */
  async function planBatch(batchId: bigint): Promise<PlanReport> {
    const id = batchId.toString();
    const [batch] = await db.select().from(syncBatches).where(eq(syncBatches.batchId, batchId));
    if (!batch || batch.status !== "planned") return { batchId: id, outcome: "aborted", taskCount: 0, reused: [] };
    const snapshot = planSnapshot.parse(batch.settingsSnapshot);
    const supp = batch.purpose === "supplement" ? snapshot.supplement : undefined;
    const pid = await providerId();
    const reused: ReusedTask[] = [];
    let after: bigint | null = null;
    for (;;) {
      const chunk = await resolver.targets({ afterAccountId: after, limit: chunkSize, accountIds: supp?.account_ids.map(BigInt) });
      if (chunk.rows.length === 0) break;
      const ok = await db.transaction(async (tx) => {
        // 与取消互斥：取消在同一行上更新，已取消则停止规划
        const [b] = await tx.select({ status: syncBatches.status }).from(syncBatches).where(eq(syncBatches.batchId, batchId)).for("update");
        if (b?.status !== "planned") return false;
        reused.push(
          ...(await planChunk(tx, {
            batchId,
            snapshot,
            providerId: pid,
            rows: chunk.rows,
            only: supp?.only ?? "full",
            priority: supp ? SUPPLEMENT_PRIORITY : 0,
            bump: supp !== undefined,
            now: clock.now(),
          })),
        );
        return true;
      });
      if (!ok) return { batchId: id, outcome: "aborted", taskCount: 0, reused };
      if (chunk.next === null) break;
      after = chunk.next;
    }
    // 收尾：与所有批次状态迁移一样，在 sync_settings 行锁的短事务内（事务里无 IO）
    return db.transaction(async (tx) => {
      await loadSettings(tx, { lock: true });
      const [b] = await tx.select({ status: syncBatches.status }).from(syncBatches).where(eq(syncBatches.batchId, batchId)).for("update");
      if (b?.status !== "planned") return { batchId: id, outcome: "aborted" as const, taskCount: 0, reused };
      const [{ n }] = (await tx.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks).where(eq(syncTasks.batchId, batchId))) as [{ n: number }];
      const now = clock.now();
      if (n === 0) {
        await tx.update(syncBatches).set({ status: "skipped", skipReason: "no_targets", finishedAt: now, updatedAt: now }).where(eq(syncBatches.batchId, batchId));
        return { batchId: id, outcome: "skipped" as const, taskCount: 0, reused };
      }
      await tx.update(syncBatches).set({ status: "running", plannedTaskCount: n, startedAt: now, updatedAt: now }).where(eq(syncBatches.batchId, batchId));
      return { batchId: id, outcome: "running" as const, taskCount: n, reused };
    });
  }

  return { planBatch };
}
export type BatchPlanner = ReturnType<typeof createBatchPlanner>;
