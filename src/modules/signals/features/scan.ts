// 扫描驱动与对账（design §7.3）。触发点是 current 指针推进，不是 finalized 事件（SG-D03）；A 没有事件，也不改 A 的路径。
// 游标只在整批处理成功后推进；ingest 是幂等的，所以进程在任何位置退出，重启后重做同一批都不会产生重复行。
import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { signalCursors } from "../../../db/schema";
import type { Clock } from "../../raw-capture";
import type { SignalsConfig } from "../config";
import { createFacts } from "../facts";
import { ingestComment, ingestContent, type IngestDeps, type IngestOutcome } from "./ingest";

export type ScanDeps = IngestDeps & { config: Pick<SignalsConfig, "scanBatch" | "lookbackMs"> };
export type ScanReport = Record<IngestOutcome, number> & { scanned: number };

const EPOCH = new Date(0);
export const CURSORS = { content: "content_scan", comment: "comment_scan", reconcile: "content_reconcile" } as const;

async function readCursor(db: Db, name: string): Promise<{ at: Date; id: bigint }> {
  const [r] = await db.select().from(signalCursors).where(eq(signalCursors.cursorName, name));
  return r ? { at: r.watermarkAt, id: r.watermarkId } : { at: EPOCH, id: 0n };
}
async function writeCursor(db: Db, clock: Clock, name: string, at: Date, id: bigint): Promise<void> {
  const now = clock.now();
  await db
    .insert(signalCursors)
    .values({ cursorName: name, watermarkAt: at, watermarkId: id, updatedAt: now })
    .onDuplicateKeyUpdate({ set: { watermarkAt: at, watermarkId: id, updatedAt: now } });
}
const emptyReport = (): ScanReport => ({ scanned: 0, created: 0, updated: 0, advanced: 0, unchanged: 0, skipped_older: 0, unsupported_platform: 0, skipped_inactive: 0 });
const count = (r: ScanReport, o: IngestOutcome): void => {
  r.scanned++;
  r[o]++;
};

async function ingestContents(deps: ScanDeps, ids: bigint[], report: ScanReport): Promise<void> {
  const facts = await createFacts(deps.db).contentFacts(ids);
  for (const id of ids) {
    const f = facts.get(id);
    if (f) count(report, await ingestContent(deps, f)); // 没有 finalized current 快照的内容（指针被改走）不处理
  }
}

/** 内容扫描：游标之后推进过 current 指针的内容 ∪ 回看窗口内提交更晚的内容。每个 tick 调用一次。 */
export async function scanContents(deps: ScanDeps): Promise<ScanReport> {
  const facts = createFacts(deps.db);
  const report = emptyReport();
  const cur = await readCursor(deps.db, CURSORS.content);
  const rows = await facts.contentsAfter(cur, deps.config.scanBatch);
  const late = await facts.contentsLate(new Date(cur.at.getTime() - deps.config.lookbackMs), cur.at, deps.config.scanBatch);
  const ids = [...new Set([...rows.map((r) => r.contentId), ...late])];
  await ingestContents(deps, ids, report);
  const last = rows.at(-1);
  if (last) await writeCursor(deps.db, deps.clock, CURSORS.content, last.selectedAt, last.contentId); // rows 为空则不动游标
  return report;
}

/** 评论扫描：游标按 (last_seen_at, comment_id)；只处理 active 评论。 */
export async function scanComments(deps: ScanDeps): Promise<ScanReport> {
  const facts = createFacts(deps.db);
  const report = emptyReport();
  const cur = await readCursor(deps.db, CURSORS.comment);
  const rows = await facts.commentsAfter(cur, deps.config.scanBatch);
  const late = await facts.commentsInWindow(new Date(cur.at.getTime() - deps.config.lookbackMs), cur.at, deps.config.scanBatch);
  const ids = [...new Set([...rows.map((r) => r.commentId), ...late])];
  const got = await facts.commentFacts(ids);
  for (const id of ids) {
    const f = got.get(id);
    if (f) count(report, await ingestComment(deps, f));
  }
  const last = rows.at(-1);
  if (last) await writeCursor(deps.db, deps.clock, CURSORS.comment, last.lastSeenAt, last.commentId);
  return report;
}

/**
 * 对账：按 content_id 分页（游标 content_reconcile），补处理特征行缺失或所持快照不是 current 的内容。
 * 一圈跑完游标归零。回看窗口之外迟到的提交只有它能兜住；首次部署时也是存量内容的回填路径之一。
 */
export async function reconcileContents(deps: ScanDeps): Promise<ScanReport & { wrapped: boolean }> {
  const facts = createFacts(deps.db);
  const report = emptyReport();
  const cur = await readCursor(deps.db, CURSORS.reconcile);
  const rows = await facts.contentPage(cur.id, deps.config.scanBatch + 1); // 多读一行：刚好读满一页时才知道后面还有没有
  const page = rows.slice(0, deps.config.scanBatch);
  await ingestContents(deps, page.filter((p) => p.missing).map((p) => p.contentId), report);
  const wrapped = rows.length <= deps.config.scanBatch;
  await writeCursor(deps.db, deps.clock, CURSORS.reconcile, EPOCH, wrapped ? 0n : page.at(-1)!.contentId);
  return { ...report, wrapped };
}
