// 每日维护（FS-17、design §7.13）：ODS 保留期清理、孤儿对象清扫、外部取消留下的 building 快照清扫。
// 不建新表：进程内记住「今天是否已成功跑过」（ponytail: 进程重启当天可能再跑一次，各步骤都幂等，无害）。
// 不碰结构化快照、归属、评论、检查点、正式媒资；media 桶不参与（这里拿到的 store 只是 ODS 桶）。
// 失败不抛到调度循环：保留现场，退避后再试，不级联删除业务数据。
import type { Db } from "../../db/client";
import { cleanupExpired, sweepOrphans, type CleanupReport, type Clock, type ObjectStore } from "../raw-capture";
import { sweepOrphanBuilding } from "../sync-runner";

const BJT_OFFSET_MS = 8 * 3600_000;
/** 孤儿清扫要覆盖的前缀：正常 ODS 与 smoke 的 ODS（tracer acceptance 登记过的缺口）。 */
export const ORPHAN_PREFIXES = ["ods/", "smoke/ods/"] as const;

export interface MaintenanceConfig {
  /** 北京时间几点之后运行（默认 4）。 */
  hourBjt?: number;
  /** 每次最多清理的 payload / 任务数（默认 2,000），剩余留给下一次。 */
  maxPerRun?: number;
  /** 孤儿对象的宽限期：保护正在上传、事务尚未提交的对象（默认 1 小时）。 */
  orphanGraceMs?: number;
  /** 失败后至少隔多久再试（默认 10 分钟）。 */
  retryAfterMs?: number;
}
export interface MaintenanceReport {
  cleanup: CleanupReport | null;
  orphans: Record<string, { deleted: number; kept: number }>;
  buildingSwept: { tasks: number; finalized: number; purged: number } | null;
  /** 失败的步骤名（只有名字，不带异常内容）。 */
  failedSteps: string[];
}
export type RunDailyResult = { ran: false; reason: "not_due" | "already_done" | "backoff" } | { ran: true; ok: boolean; report: MaintenanceReport };

export const bjtDay = (d: Date): string => new Date(d.getTime() + BJT_OFFSET_MS).toISOString().slice(0, 10);
const bjtHour = (d: Date): number => new Date(d.getTime() + BJT_OFFSET_MS).getUTCHours();

export function createMaintenance(deps: { db: Db; store: ObjectStore; clock: Clock; config?: MaintenanceConfig; log?: (event: Record<string, unknown>, msg: string) => void }) {
  const { db, store, clock } = deps;
  const hour = deps.config?.hourBjt ?? 4;
  const maxPerRun = deps.config?.maxPerRun ?? 2000;
  const graceMs = deps.config?.orphanGraceMs ?? 3600_000;
  const retryAfterMs = deps.config?.retryAfterMs ?? 600_000;
  const log = deps.log ?? (() => {});
  let lastDoneDay: string | null = null;
  let retryAt = 0;

  /** 立刻运行一轮（`maintain` 命令用；定时入口是 runDaily）。每一步独立 try/catch，一步失败不影响其它步骤。 */
  async function runNow(): Promise<{ ok: boolean; report: MaintenanceReport }> {
    const report: MaintenanceReport = { cleanup: null, orphans: {}, buildingSwept: null, failedSteps: [] };
    const step = async <T>(name: string, f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch (e) {
        report.failedSteps.push(name);
        log({ step: name, err: e instanceof Error ? e.name : typeof e }, "maintenance step failed");
        return null;
      }
    };
    report.cleanup = await step("cleanup_expired", () => cleanupExpired({ db, store, clock, maxPerRun }));
    for (const prefix of ORPHAN_PREFIXES) {
      const r = await step(`sweep_orphans:${prefix}`, () => sweepOrphans({ db, store, clock, graceMs, prefix, maxDelete: maxPerRun }));
      if (r) report.orphans[prefix] = r;
    }
    report.buildingSwept = await step("sweep_orphan_building", () => sweepOrphanBuilding(db, clock, { limit: maxPerRun }));
    const ok = report.failedSteps.length === 0;
    log({ ok, cleanup: report.cleanup, orphans: report.orphans, buildingSwept: report.buildingSwept, failedSteps: report.failedSteps }, "maintenance finished");
    return { ok, report };
  }

  /** 北京时间 hour 点之后每个自然日成功运行一次；失败退避后重试。每次 tick 都可以调用，不到点 / 已完成就立即返回。 */
  async function runDaily(now: Date = clock.now()): Promise<RunDailyResult> {
    if (bjtHour(now) < hour) return { ran: false, reason: "not_due" };
    if (lastDoneDay === bjtDay(now)) return { ran: false, reason: "already_done" };
    if (now.getTime() < retryAt) return { ran: false, reason: "backoff" };
    const { ok, report } = await runNow();
    if (ok) lastDoneDay = bjtDay(now);
    else retryAt = now.getTime() + retryAfterMs;
    return { ran: true, ok, report };
  }
  return { runDaily, runNow };
}
export type Maintenance = ReturnType<typeof createMaintenance>;
