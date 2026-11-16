// 运行的查询与删除（圈定 / 试跑 / 执行共用）：分块、显式 DELETE，没有级联（业务表无 ON DELETE CASCADE）。
import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { judgementRuns, runContents, runParticipants } from "../../db/schema";

export type RunKind = "circle" | "compare" | "execution";
const DELETE_CHUNK = 1000;

export function createRunOps(db: Db) {
  async function runIdsOf(planId: bigint, version: number, kinds: RunKind[]): Promise<bigint[]> {
    const rows = await db.select({ id: judgementRuns.runId }).from(judgementRuns).where(and(eq(judgementRuns.planId, planId), eq(judgementRuns.version, version), inArray(judgementRuns.runKind, kinds)));
    return rows.map((r) => r.id);
  }
  async function activeRunExists(planId: bigint, version: number, kinds: RunKind[]): Promise<boolean> {
    const rows = await db
      .select({ id: judgementRuns.runId })
      .from(judgementRuns)
      .where(and(eq(judgementRuns.planId, planId), eq(judgementRuns.version, version), inArray(judgementRuns.runKind, kinds), inArray(judgementRuns.status, ["planned", "running", "waiting"])))
      .limit(1);
    return rows.length > 0;
  }
  /** 先删内容行、再删参与专员行、最后删运行（外键 RESTRICT 要求的顺序）；返回删了几个运行与多少行。 */
  async function deleteRunsById(ids: readonly bigint[]): Promise<{ runs: number; rows: number }> {
    let rows = 0;
    if (ids.length === 0) return { runs: 0, rows };
    for (const table of [runContents, runParticipants] as const) {
      for (;;) {
        const [r] = await db.delete(table).where(inArray(table.runId, [...ids])).limit(DELETE_CHUNK);
        rows += r.affectedRows;
        if (r.affectedRows < DELETE_CHUNK) break;
      }
    }
    await db.delete(judgementRuns).where(inArray(judgementRuns.runId, [...ids]));
    return { runs: ids.length, rows };
  }
  const deleteRuns = async (planId: bigint, version: number, kinds: RunKind[]) => deleteRunsById(await runIdsOf(planId, version, kinds));
  async function countRuns(planId: bigint, version: number, kinds: RunKind[]): Promise<{ runs: number; rows: number }> {
    const ids = await runIdsOf(planId, version, kinds);
    if (ids.length === 0) return { runs: 0, rows: 0 };
    const [c] = await db.select({ n: count() }).from(runContents).where(inArray(runContents.runId, ids));
    const [p] = await db.select({ n: count() }).from(runParticipants).where(inArray(runParticipants.runId, ids));
    return { runs: ids.length, rows: Number(c!.n) + Number(p!.n) };
  }
  return { runIdsOf, activeRunExists, deleteRuns, deleteRunsById, countRuns };
}
export type RunOps = ReturnType<typeof createRunOps>;
