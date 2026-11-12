// 结果行的读取：同（信号、素材、参数）下版本最高的一行就是「当前值」（结果行不更新，升级产生版本更高的新行）。
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { signalResults } from "../../../db/schema";
import type { CatalogEntry } from "../catalog";
import type { StoredSignal } from "../compose";

/** 素材指纹（十六进制）→ 最高版本的结果行。 */
export async function latestResults(db: Db, entry: CatalogEntry, materialShas: Buffer[], paramSha: Buffer): Promise<Map<string, StoredSignal>> {
  const out = new Map<string, StoredSignal>();
  if (materialShas.length === 0) return out;
  const rows = await db
    .select()
    .from(signalResults)
    .where(and(eq(signalResults.signalKey, entry.key), eq(signalResults.capabilityId, entry.capability), eq(signalResults.paramSha256, paramSha), inArray(signalResults.materialSha256, materialShas)));
  for (const r of rows) {
    const hex = r.materialSha256.toString("hex");
    const prev = out.get(hex);
    if (prev && prev.version >= r.capabilityVersion) continue;
    out.set(hex, {
      state: r.state as "valid" | "failed",
      capabilityId: r.capabilityId,
      version: r.capabilityVersion,
      producedAt: r.producedAt,
      value: r.value ?? undefined,
      score: r.score === null ? undefined : Number(r.score),
      evidence: r.evidence,
      failureCode: r.failureCode ?? undefined,
      resultId: r.resultId,
    });
  }
  return out;
}
