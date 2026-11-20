// 名单解析驱动（requirements AP-9；design §7.6）：把确认后挂起的行逐个交给 resolve_account 根任务，并在终态后归并。
// 生产里原来没有任何东西驱动根任务（runTracerRoot 只被测试和 smoke 调用），本驱动跑在 sync worker 进程内，
// 共用同一个供应商网关 / 限流 / 熔断 / 成本护栏（runRoot 由装配处注入，本模块不创建网关）。
// 不绕过 capability gate：未放行的平台的行保持 pending_account，不报错退出。
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { importBatches, importRowResults, platforms, syncTasks } from "../../../db/schema";
import { UnsupportedCapabilityError, capabilityGate, type Platform } from "../../provider-adapter";
import type { MonitoringResolver } from "../../monitoring";
import type { Clock } from "../../raw-capture";
import { DEFAULT_CONFIG, type TracerConfig } from "../../tracer-command";
import type { PlanAuditSink } from "../audit";
import { RESOLVE_CONCURRENCY } from "../constants";
import type { RosterFinalizer } from "./finalize";
import { countOutcomes } from "./confirm";
import { settleExpired, settleRow, WORKER_ACTOR } from "./settle";
import { annotateUpstream } from "./upstream";

/** runTracerRoot 的窄端口（kind 与 orchestrator.RunKind 一致）。 */
export type RunRoot = (rootTaskId: bigint) => Promise<{ kind: string }>;
export interface ResolverDeps {
  db: Db;
  clock: Clock;
  audit: PlanAuditSink;
  runRoot: RunRoot;
  finalize: RosterFinalizer;
  /** 提示上级关闭（不改上级）；缺省不提示 */
  monitoring?: MonitoringResolver;
  tracerConfig?: TracerConfig;
  concurrency?: number;
}
export interface ResolverReport {
  examined: number;
  settled: number;
  /** 根任务未到终态（busy / retry_wait / stale），留待下个 tick */
  deferred: number;
  /** capability 未放行，行保持 pending_account */
  gated: number;
  expired: number;
  completedBatches: string[];
  failed: Array<{ rowId: string; error: string }>;
}
const SETTLE_KINDS = new Set(["succeeded", "blocked", "failed", "cancelled", "already_terminal"]);

export function createRosterResolver(deps: ResolverDeps) {
  const { db, clock } = deps;
  const config = deps.tracerConfig ?? DEFAULT_CONFIG;

  async function runOnce(o: { limit?: number; concurrency?: number } = {}): Promise<ResolverReport> {
    const report: ResolverReport = { examined: 0, settled: 0, deferred: 0, gated: 0, expired: 0, completedBatches: [], failed: [] };
    const rows = await db
      .select({ rowId: importRowResults.importRowResultId, rowNo: importRowResults.rowNo, batchId: importRowResults.importBatchId, rootId: importRowResults.resolveTaskId, platform: platforms.platformCode })
      .from(importRowResults)
      .innerJoin(importBatches, eq(importBatches.importBatchId, importRowResults.importBatchId))
      .leftJoin(syncTasks, eq(syncTasks.taskId, importRowResults.resolveTaskId))
      .leftJoin(platforms, eq(platforms.platformId, syncTasks.platformId))
      .where(and(eq(importRowResults.outcome, "pending_account"), eq(importBatches.status, "resolving"), eq(importBatches.importKind, "roster")))
      .orderBy(asc(importRowResults.importBatchId), asc(importRowResults.rowNo))
      .limit(o.limit ?? 300); // 每轮之间有 30 秒间隔，一轮太小间隔占比就高（2026-11-20 由 50 调到 300）
    const completed = new Set<bigint>();
    const touchedBatches = new Set<bigint>();
    report.examined = rows.length;
    const queue = rows.filter((r) => r.batchId !== undefined);
    const afterSettle = (s: Awaited<ReturnType<typeof settleRow>>) => {
      if (!s.settled) return;
      report.settled++;
      if (s.batchId !== null) touchedBatches.add(s.batchId);
      s.events.forEach((e) => deps.audit(e));
      if (s.completedBatchId !== null) completed.add(s.completedBatchId);
    };
    const handle = async (r: (typeof rows)[number]): Promise<void> => {
      try {
        if (r.rootId === null) {
          report.expired++;
          afterSettle(await settleExpired(db, r.rowId, clock.now()));
          return;
        }
        if (r.platform) {
          try {
            capabilityGate.require({ platform: r.platform as Platform, action: "media_user_info", mode: config.modes.media_user_info, environment: config.environment });
          } catch (e) {
            if (e instanceof UnsupportedCapabilityError) {
              report.gated++;
              return;
            }
            throw e;
          }
        }
        const run = await deps.runRoot(r.rootId);
        if (!SETTLE_KINDS.has(run.kind)) {
          report.deferred++;
          return;
        }
        afterSettle(await settleRow(db, r.rowId, clock.now()));
      } catch (e) {
        // 一行出错不影响其他行；行保持 pending_account，下个 tick 再来（根任务由租约接手）
        report.failed.push({ rowId: r.rowId.toString(), error: e instanceof Error ? e.message : String(e) });
      }
    };
    // 有界并发：固定数量的 worker 从队列里取行（不用 Promise.all 一次性铺开所有行）
    const workers = Math.max(1, Math.min(o.concurrency ?? deps.concurrency ?? RESOLVE_CONCURRENCY, queue.length || 1));
    let next = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < queue.length) {
          const r = queue[next++]!;
          await handle(r);
        }
      }),
    );
    // 崩溃安全：resolving 的批次若已没有挂起行（上一次在完成状态写入前被杀），补一次完成
    for (const b of await db.select().from(importBatches).where(eq(importBatches.status, "resolving"))) {
      if (b.importKind !== "roster") continue;
      const counts = await countOutcomes(db, b.importBatchId);
      if (counts.pending_account === 0) {
        await db.update(importBatches).set({ status: "completed", summary: { ...(b.summary as Record<string, unknown>), confirm: counts }, updatedAt: clock.now() }).where(eq(importBatches.importBatchId, b.importBatchId));
        completed.add(b.importBatchId);
      }
    }
    // 本 tick 归并过的批次：给「账号已被引用但上级关闭」的行补提示（不改上级开关）
    if (deps.monitoring) for (const b of touchedBatches) await annotateUpstream(db, deps.monitoring, b).catch(() => undefined);
    for (const id of completed) {
      report.completedBatches.push(id.toString());
      deps.audit({ event_type: "roster_batch_confirmed", actor: WORKER_ACTOR, occurred_at: clock.now().toISOString(), reason_code: "resolving_completed", target_type: "import_batch", target_id: id.toString(), batch_id: id.toString() });
      await deps.finalize(id).catch((e: unknown) => report.failed.push({ rowId: `batch:${id}`, error: e instanceof Error ? e.message : String(e) }));
    }
    return report;
  }
  return { runOnce };
}
export type RosterResolver = ReturnType<typeof createRosterResolver>;
