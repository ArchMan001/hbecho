// 周期调度（FS-1、design §5.1、§7.2）：tick 幂等，一次调用完成「过期 → 晋升 → 到点创建 → 规划 → 汇总」。
// 所有批次状态迁移都在 sync_settings 行锁的短事务内完成（单行互斥锁：同一时刻至多一个运行中的 full，队列至多一个）；
// 事务里不做任何 IO。规划与汇总在锁外分块进行，崩溃后下一次 tick 接着做。
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { syncBatches } from "../../db/schema";
import type { Clock } from "../raw-capture";
import type { MonitoringResolver } from "../monitoring";
import { createBatchPlanner, type PlanReport } from "./planner";
import { loadSettings, settingsSnapshot, type SyncRuntime } from "./settings";
import { latestSlotAtOrBefore, nextSlotAfter } from "./slots";
import { createBatchSummarizer, type FinalizeReport } from "./summary";
import { fullBatchKey } from "./task-keys";

/** 错过的时点不补跑：超出容忍窗口不创建（FS-1.3）。tick 间隔 30 秒，容忍 10 分钟。 */
export const DEFAULT_TOLERANCE_MS = 10 * 60_000;

export interface TickReport {
  now: string;
  created: Array<{ batchId: string; status: string; slot: string; skipReason: string | null }>;
  expired: string[];
  promoted: string[];
  planned: PlanReport[];
  finalized: FinalizeReport["finalized"];
  mediaFinished: string[];
}

export interface SchedulerDeps {
  db: Db;
  clock: Clock;
  resolver: MonitoringResolver;
  runtime: SyncRuntime;
  toleranceMs?: number;
  chunkSize?: number;
}

/** 占着「运行中全量批次」名额的状态：planned 也算，规划到一半不能再放进第二个。 */
const OCCUPYING = ["planned", "running"] as const;

export function createSyncScheduler(deps: SchedulerDeps) {
  const { db, clock, runtime } = deps;
  const toleranceMs = deps.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const planner = createBatchPlanner({ db, clock, resolver: deps.resolver, ...(deps.chunkSize === undefined ? {} : { chunkSize: deps.chunkSize }) });
  const summarizer = createBatchSummarizer({ db, clock });

  const hasOccupant = async (tx: DbTx) =>
    (await tx.select({ id: syncBatches.batchId }).from(syncBatches).where(and(eq(syncBatches.purpose, "full"), inArray(syncBatches.status, [...OCCUPYING]))).limit(1)).length > 0;

  /** 锁内：过期 → 晋升 → 到点创建。返回本次需要规划的批次由 planned 状态查询得出，不在这里返回。 */
  async function transitions(now: Date): Promise<Pick<TickReport, "created" | "expired" | "promoted">> {
    return db.transaction(async (tx) => {
      const { row, slots } = await loadSettings(tx, { lock: true });
      const out: Pick<TickReport, "created" | "expired" | "promoted"> = { created: [], expired: [], promoted: [] };

      // 1) 过期：排队到下一个计划时点仍未开始（FS-1.6）
      const queuedFull = await tx.select().from(syncBatches).where(and(eq(syncBatches.purpose, "full"), eq(syncBatches.status, "queued"))).orderBy(asc(syncBatches.logicalAt));
      for (const b of queuedFull) {
        if (nextSlotAfter(b.logicalAt, slots).getTime() <= now.getTime()) {
          await tx.update(syncBatches).set({ status: "expired", finishedAt: now, updatedAt: now }).where(eq(syncBatches.batchId, b.batchId));
          out.expired.push(b.batchId.toString());
        }
      }

      // 2) 晋升：无运行中的 full 时，排队的 full 先于补抓（FS-1.5、design §7.2）；规划时才取目标集，不用排队期间过期的
      if (!(await hasOccupant(tx))) {
        const [next] = await tx
          .select()
          .from(syncBatches)
          .where(and(eq(syncBatches.purpose, "full"), eq(syncBatches.status, "queued")))
          .orderBy(asc(syncBatches.logicalAt))
          .limit(1);
        if (next) {
          await tx.update(syncBatches).set({ status: "planned", updatedAt: now }).where(eq(syncBatches.batchId, next.batchId));
          out.promoted.push(next.batchId.toString());
        } else {
          const supplements = await tx.select().from(syncBatches).where(and(eq(syncBatches.purpose, "supplement"), eq(syncBatches.status, "queued"))).orderBy(asc(syncBatches.createdAt));
          for (const s of supplements) {
            await tx.update(syncBatches).set({ status: "planned", updatedAt: now }).where(eq(syncBatches.batchId, s.batchId));
            out.promoted.push(s.batchId.toString());
          }
        }
      }

      // 3) 到点创建：同一时点只有一个批次（批次键由时点确定）；错过超出容忍窗口不补跑
      const slot = latestSlotAtOrBefore(now, slots);
      if (now.getTime() - slot.getTime() <= toleranceMs) {
        const key = fullBatchKey(slot);
        const [existing] = await tx.select({ id: syncBatches.batchId }).from(syncBatches).where(eq(syncBatches.batchKey, key));
        if (!existing) {
          const occupied = await hasOccupant(tx);
          const [queued] = await tx.select({ id: syncBatches.batchId }).from(syncBatches).where(and(eq(syncBatches.purpose, "full"), eq(syncBatches.status, "queued"))).limit(1);
          const status = !occupied ? "planned" : !queued ? "queued" : "skipped";
          const skipReason = status === "skipped" ? "queue_full" : null;
          const [ins] = await tx.insert(syncBatches).values({
            batchKey: key,
            triggerType: "scheduled",
            purpose: "full",
            logicalAt: slot,
            status,
            settingsVersion: row.configVersion,
            settingsSnapshot: settingsSnapshot(row, runtime),
            skipReason,
            ...(status === "skipped" ? { finishedAt: now } : {}),
            createdAt: now,
            updatedAt: now,
          });
          out.created.push({ batchId: BigInt(ins.insertId).toString(), status, slot: slot.toISOString(), skipReason });
        }
      }
      return out;
    });
  }

  /**
   * 幂等：同一 now 重复调用不产生重复批次。
   * 顺序：汇总 → 过期 / 晋升 / 到点创建 → 规划。先汇总，上一个全量批次进入终态的同一次 tick 就能晋升排队批次（FS-1.5「立即」）。
   */
  async function tick(at?: Date): Promise<TickReport> {
    const now = at ?? clock.now();
    const f = await summarizer.finalizeAll();
    const t = await transitions(now);
    // 规划：包括上次崩溃时停在 planned 的批次（任务幂等，不会重复）
    const planned: PlanReport[] = [];
    const todo = await db.select({ id: syncBatches.batchId }).from(syncBatches).where(eq(syncBatches.status, "planned")).orderBy(asc(syncBatches.batchId));
    for (const { id } of todo) planned.push(await planner.planBatch(id));
    // 规划后立刻为「没有任务」的批次收尾由 planBatch 自己完成；这里不再汇总第二遍
    return { now: now.toISOString(), ...t, planned, finalized: f.finalized, mediaFinished: f.mediaFinished };
  }

  return { tick, planner, summarizer };
}
export type SyncScheduler = ReturnType<typeof createSyncScheduler>;
