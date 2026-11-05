// 预检（design §5、§7.3、§7.5）：文件级校验 → 建批次 → 逐行分类 → 行结果 → 待确认撤店 → awaiting_confirm。
// 只写 import_batches / import_row_results / data_quality_issues，不写任何业务主档。
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { importBatches, importRowResults } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import { assertMode, type ActorContext } from "./authorization";
import type { AuditSink } from "./audit";
import { classifyRow, findGroupErrors, toFileRow, type Classified, type ImportMode } from "./classify";
import { computePending, writePendingIssues } from "./closure";
import { HEADER, parseFile, type ParseLimits } from "./file-parser";
import { TEMPLATE_VERSION } from "./mappings.v1";
import { loadSnapshot } from "./ref";

export interface Deps {
  db: Db;
  clock: Clock;
  audit: AuditSink;
}

export interface PrecheckInput {
  fileName: string;
  bytes: Uint8Array;
  mode: ImportMode;
  limits?: ParseLimits;
}

export interface BatchSummary {
  mode: ImportMode;
  new: number;
  update: number;
  unchanged: number;
  error: number;
  needs_superadmin: number;
  pending_closure_stores: number;
  suspect_incomplete_export: boolean;
  /** 本批文件出现的品牌（十进制字符串），确认收敛旧 issue 时使用。 */
  brands_in_file: string[];
}

export interface PrecheckAccepted {
  batchId: string;
  status: "awaiting_confirm";
  totalRows: number;
  summary: BatchSummary;
}

const CHUNK = 500;

export async function precheck(deps: Deps, input: PrecheckInput, actor: ActorContext): Promise<PrecheckAccepted> {
  assertMode(actor, input.mode);
  const parsed = input.limits ? parseFile(input.bytes, input.limits) : parseFile(input.bytes); // 文件级失败：不建批次
  const now = deps.clock.now();
  const scope = input.mode === "structure" ? ("all" as const) : actor.brandScope;

  const [ins] = await deps.db.insert(importBatches).values({
    importKind: "master_data",
    uploadedByActor: actor.actor,
    uploadedAt: now,
    fileName: input.fileName,
    fileSha256: parsed.sha256,
    templateVersion: TEMPLATE_VERSION,
    brandScope: scope === "all" ? "all" : [...scope].sort(),
    totalRows: parsed.rows.length,
    summary: { mode: input.mode },
    status: "prechecking",
    createdAt: now,
    updatedAt: now,
  });
  const batchId = BigInt(ins.insertId);

  try {
    const snap = await loadSnapshot(deps.db);
    const rows = parsed.rows.map((r) => toFileRow(r.rowNo, r.cells));
    const groupErrors = findGroupErrors(rows, input.mode, scope);
    const results: Classified[] = [];
    for (const r of rows) results.push(await classifyRow(r, { mode: input.mode, scope, refs: snap, groupErrors }));

    const pend = computePending(rows, snap, input.mode, scope);
    for (let i = 0; i < rows.length; i += CHUNK) {
      await deps.db.insert(importRowResults).values(
        rows.slice(i, i + CHUNK).map((r, j) => {
          const c = results[i + j]!;
          return {
            importBatchId: batchId,
            rowNo: r.rowNo,
            rawRow: Object.fromEntries(HEADER.map((h, k) => [h, r.raw[k] ?? ""])),
            precheckClass: c.cls,
            reasonCode: c.reason,
            reasonDetail: c.detail,
            storeId: c.storeId ?? pend.matched.get(r.rowNo) ?? null,
            createdAt: now,
          };
        }),
      );
    }
    await writePendingIssues(deps.db, batchId, pend.pending, snap, now);

    const count = (k: Classified["cls"]) => results.filter((c) => c.cls === k).length;
    const summary: BatchSummary = {
      mode: input.mode,
      new: count("new"),
      update: count("update"),
      unchanged: count("unchanged"),
      error: count("error"),
      needs_superadmin: count("needs_superadmin"),
      pending_closure_stores: pend.pending.length,
      suspect_incomplete_export: pend.suspectIncompleteExport,
      brands_in_file: pend.brandsInFile.map(String),
    };
    await deps.db.update(importBatches).set({ status: "awaiting_confirm", summary, updatedAt: deps.clock.now() }).where(eq(importBatches.importBatchId, batchId));
    deps.audit({
      event_type: "import_precheck_completed",
      actor: actor.actor,
      occurred_at: now.toISOString(),
      target_type: "import_batch",
      target_id: String(batchId),
      batch_id: String(batchId),
      counts: { ...summary, brands_in_file: undefined },
    });
    return { batchId: String(batchId), status: "awaiting_confirm", totalRows: rows.length, summary };
  } catch (e) {
    // 已写的行结果保留；批次标记 precheck_failed，重试同一文件会得到新批次
    await deps.db.update(importBatches).set({ status: "precheck_failed", updatedAt: deps.clock.now() }).where(eq(importBatches.importBatchId, batchId)).catch(() => undefined);
    throw e;
  }
}
