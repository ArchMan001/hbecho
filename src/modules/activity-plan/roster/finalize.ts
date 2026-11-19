// 批次完成后的收尾（design §7.6；2026-11-19 修订，见 a-roster-first-collect）：对被引用的账号各一次 supplement，都按「距上次成功采集满 7 天或从未采过」判定：
//   · 已存在并引用的账号（unchanged）：主页 + 列表（only=full，新鲜度取两者中较早的）；
//   · 本批新建的账号（imported）：解析时刚采过主页，只补列表（only=list，从未采过列表即到期）。疑似空账号不补采（不是有效监控目标）。
// supplement 通过 a-full-sync 的入口走同一套网关、预算与护栏，由 sync worker 异步执行，本模块不绕过、不新增详情 / 评论任务。
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { importBatches, importRowResults } from "../../../db/schema";
import type { Clock } from "../../raw-capture";

export interface SupplementRequest {
  accountIds: string[];
  only: "full" | "list";
  ifOlderThanHours: number;
  apply: true;
  idempotencyKey: string;
}
/** a-full-sync 的 createSupplement 的窄端口；装配处用服务身份 service:plan-worker 包一层。 */
export type SupplementPort = (input: SupplementRequest) => Promise<{ kind: string; dispositions?: Array<{ disposition: string }> }>;
export const REFRESH_IF_OLDER_THAN_HOURS = 168;

export function createRosterFinalizer(deps: { db: Db; clock: Clock; supplement: SupplementPort }) {
  const accountsOf = async (batchId: bigint, outcome: "unchanged" | "imported"): Promise<string[]> =>
    (
      await deps.db
        .selectDistinct({ accountId: importRowResults.accountId })
        .from(importRowResults)
        .where(and(eq(importRowResults.importBatchId, batchId), eq(importRowResults.outcome, outcome), isNotNull(importRowResults.accountId)))
    ).map((r) => r.accountId!.toString());
  const request = async (ids: string[], only: "full" | "list", key: string) => {
    if (ids.length === 0) return { requested: 0, queued: 0, notDue: 0 };
    const res = await deps.supplement({ accountIds: ids, only, ifOlderThanHours: REFRESH_IF_OLDER_THAN_HOURS, apply: true, idempotencyKey: key });
    const d = res.dispositions ?? [];
    return { requested: ids.length, queued: d.filter((x) => x.disposition === "queued").length, notDue: d.filter((x) => x.disposition === "not_due").length };
  };
  return async function finalize(batchId: bigint): Promise<{ requested: number; queued: number; notDue: number; firstList: { requested: number; queued: number; notDue: number } }> {
    const existing = await request(await accountsOf(batchId, "unchanged"), "full", `roster-refresh:${batchId}`);
    const firstList = await request(await accountsOf(batchId, "imported"), "list", `roster-first-list:${batchId}`);
    const out = { ...existing, firstList };
    if (existing.requested === 0 && firstList.requested === 0) return out;
    // 把结果记在批次汇总里，方便看「这批补抓了几个」
    await deps.db.transaction(async (tx) => {
      const [b] = await tx.select().from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
      if (b) await tx.update(importBatches).set({ summary: { ...(b.summary as Record<string, unknown>), refresh: out }, updatedAt: deps.clock.now() }).where(eq(importBatches.importBatchId, batchId));
    });
    return out;
  };
}
/** 调用方只关心「做完没有」；返回值给 CLI / 测试看。 */
export type RosterFinalizer = (batchId: bigint) => Promise<unknown>;
