// 导入遇到上级关闭（requirements AP-11 第 5 条）：不改上级开关，只在行结果的 reason_detail 里提示关闭来自哪一级。
// 取 monitoring.explain 的最上级原因（和综合状态同一套文案）。幂等：已经带有提示的行不重复追加。
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { importRowResults } from "../../../db/schema";
import type { MonitoringResolver } from "../../monitoring";
import { EXCLUSION_LABELS } from "../status";

const MARK = "监控状态：";
/** 账号已被名单引用，但上级（品牌 / 大区 / 分公司 / 经销商 / 门店 / 专员）关闭或停用时的提示；其他情况返回 null。 */
export async function upstreamNote(resolver: MonitoringResolver, accountId: bigint): Promise<string | null> {
  const { reason } = await resolver.explain(accountId);
  if (reason === null || reason === "account_off" || reason === "suspected_empty" || reason === "no_assignment") return null;
  return `${MARK}${EXCLUSION_LABELS[reason]}（上级关闭，本次导入不改上级开关）`;
}

/** 给本批已有账号的行补提示；返回补了几行。 */
export async function annotateUpstream(db: Db, resolver: MonitoringResolver, batchId: bigint, accountIds?: readonly bigint[]): Promise<number> {
  const rows = await db
    .select({ id: importRowResults.importRowResultId, accountId: importRowResults.accountId, detail: importRowResults.reasonDetail })
    .from(importRowResults)
    .where(and(eq(importRowResults.importBatchId, batchId), inArray(importRowResults.outcome, ["imported", "unchanged", "suspected_empty"]), ...(accountIds ? [inArray(importRowResults.accountId, [...accountIds])] : [])));
  let n = 0;
  for (const r of rows) {
    if (r.accountId === null || r.detail?.includes(MARK)) continue;
    const note = await upstreamNote(resolver, r.accountId);
    if (!note) continue;
    await db.update(importRowResults).set({ reasonDetail: [r.detail, note].filter(Boolean).join("；").slice(0, 1024) }).where(eq(importRowResults.importRowResultId, r.id));
    n++;
  }
  return n;
}
