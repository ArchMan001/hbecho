// 批次完成后的收尾（design §7.6）：对「已存在并引用」的账号一次 supplement（A §11.5：距上次采集满一周立即补采）。
// 新账号只采了主页，不触发；supplement 通过 a-full-sync 的入口走同一套网关与护栏，本模块不绕过、不新增详情 / 评论任务。
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { importBatches, importRowResults } from "../../../db/schema";
import type { Clock } from "../../raw-capture";

export interface SupplementRequest {
  accountIds: string[];
  only: "full";
  ifOlderThanHours: number;
  apply: true;
  idempotencyKey: string;
}
/** a-full-sync 的 createSupplement 的窄端口；装配处用服务身份 service:plan-worker 包一层。 */
export type SupplementPort = (input: SupplementRequest) => Promise<{ kind: string; dispositions?: Array<{ disposition: string }> }>;
export const REFRESH_IF_OLDER_THAN_HOURS = 168;

export function createRosterFinalizer(deps: { db: Db; clock: Clock; supplement: SupplementPort }) {
  return async function finalize(batchId: bigint): Promise<{ requested: number; queued: number; notDue: number }> {
    const rows = await deps.db
      .selectDistinct({ accountId: importRowResults.accountId })
      .from(importRowResults)
      .where(and(eq(importRowResults.importBatchId, batchId), eq(importRowResults.outcome, "unchanged"), isNotNull(importRowResults.accountId)));
    const ids = rows.map((r) => r.accountId!.toString());
    if (ids.length === 0) return { requested: 0, queued: 0, notDue: 0 };
    const res = await deps.supplement({ accountIds: ids, only: "full", ifOlderThanHours: REFRESH_IF_OLDER_THAN_HOURS, apply: true, idempotencyKey: `roster-refresh:${batchId}` });
    const d = res.dispositions ?? [];
    const out = { requested: ids.length, queued: d.filter((x) => x.disposition === "queued").length, notDue: d.filter((x) => x.disposition === "not_due").length };
    // 把结果记在批次汇总里，方便看「这批补抓了几个」
    await deps.db.transaction(async (tx) => {
      const [b] = await tx.select().from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
      if (b) await tx.update(importBatches).set({ summary: { ...(b.summary as Record<string, unknown>), refresh: out }, updatedAt: deps.clock.now() }).where(eq(importBatches.importBatchId, batchId));
    });
    return out;
  };
}
export type RosterFinalizer = ReturnType<typeof createRosterFinalizer>;
