// 保留期（design §7.11、SG-10）：`retainUntil` 延长结果行；清理器分块删除过期的结果行、历史行与终态任务。
// 写入时的 expires_at 在 ttl.ts / result-row.ts / ingest.ts / queue.ts；特征行不清理（随对象存在）。
// 清理不入队、不重算：清理后读取读作 missing(not_computed)；被清结果行对应的 succeeded 任务 result_id 由 ON DELETE SET NULL 置空，
// 下一次 requestScores 会把它置回 pending（任务 8）。
import { and, asc, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { signalHistory, signalResults, signalTasks } from "../../db/schema";
import type { Clock } from "../raw-capture";
import { CAP_SCORE_REQUEST, assert, type SignalActor } from "./authz";
import { SignalError } from "./errors";

/** design §7.11：每块 1000 行。 */
export const PURGE_CHUNK = 1000;

/**
 * D 保存判定证据时调用：把结果行的 expires_at 延后到 until（取较大值，只增不减）。只接受结果行 ID，不碰历史行。
 * 返回命中的行数 matched（ID 存在的行，含原本就更晚而未变的；已被清理的 ID 不计、不报错）。授权：rule.run.execute（与 requestScores 一致，D 以服务身份调用）。
 */
export async function retainUntil(deps: { db: Db }, actor: SignalActor, resultIds: readonly bigint[], until: Date): Promise<{ matched: number }> {
  assert(actor, CAP_SCORE_REQUEST);
  if (Number.isNaN(until.getTime())) throw new SignalError("input", "invalid_until", "until 不是有效时间");
  const ids = [...new Set(resultIds)];
  let matched = 0;
  for (let i = 0; i < ids.length; i += PURGE_CHUNK) {
    const [r] = await deps.db
      .update(signalResults)
      .set({ expiresAt: sql`GREATEST(${signalResults.expiresAt}, ${until})` })
      .where(inArray(signalResults.resultId, ids.slice(i, i + PURGE_CHUNK)));
    matched += r.affectedRows; // 连接按“命中行”计数（CLIENT_FOUND_ROWS），值没变的行也算
  }
  return { matched };
}

export interface PurgeReport {
  results: number;
  history: number;
  tasks: number;
  /** false = 被 shouldStop 中断，剩余部分下次再清（幂等，可重跑）。 */
  completed: boolean;
}

/**
 * 清理器（每日，固定服务身份，不经用户范围）。分块删除，循环到某张表无过期行；任务只删终态（succeeded / dead），不删仍在跑的。
 * shouldStop 在每块之后检查（优雅退出）；已删的块不回滚，重跑从剩下的继续。
 */
export async function purgeExpired(deps: { db: Db; clock: Clock }, opts: { chunkSize?: number; shouldStop?: () => boolean } = {}): Promise<PurgeReport> {
  const { db } = deps;
  const size = opts.chunkSize ?? PURGE_CHUNK;
  const now = deps.clock.now();
  const report: PurgeReport = { results: 0, history: 0, tasks: 0, completed: true };
  const sweeps: Array<[keyof Omit<PurgeReport, "completed">, () => Promise<number>]> = [
    ["results", async () => (await db.delete(signalResults).where(lt(signalResults.expiresAt, now)).orderBy(asc(signalResults.expiresAt)).limit(size))[0].affectedRows],
    ["history", async () => (await db.delete(signalHistory).where(lt(signalHistory.expiresAt, now)).orderBy(asc(signalHistory.expiresAt)).limit(size))[0].affectedRows],
    [
      "tasks",
      async () => (await db.delete(signalTasks).where(and(lt(signalTasks.expiresAt, now), inArray(signalTasks.status, ["succeeded", "dead"]))).orderBy(asc(signalTasks.expiresAt)).limit(size))[0].affectedRows,
    ],
  ];
  for (const [key, deleteChunk] of sweeps) {
    for (;;) {
      const n = await deleteChunk();
      report[key] += n;
      if (n < size) break;
      if (opts.shouldStop?.()) {
        report.completed = false;
        return report;
      }
    }
  }
  return report;
}
