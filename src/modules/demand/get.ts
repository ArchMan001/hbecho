// 查询按需批次（FS-8.7）：只读本地事实，不调用供应商。每个 {contentId, want} 一个状态、稳定原因和可读取结果的指针。
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { contentSnapshots, mediaReferences, syncBatches, syncTasks } from "../../db/schema";
import { SyncError } from "../sync-schedule";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../tracer-command";
import type { Disposition, DispositionRow, DemandView, Want, WantState, WantView } from "./types";

const REJECTED: ReadonlySet<Disposition> = new Set(["unsupported_platform", "capability_disabled", "content_not_found", "out_of_scope"]);
const ACTION: Record<Want, string> = { detail: "fetch_content_detail", comments: "fetch_comments", video: "download_media", audio: "download_media" };

const stateOf = (status: string): WantState => (status === "succeeded" || status === "succeeded_with_gap" ? "ready" : status === "failed" || status === "dead" || status === "cancelled" ? "failed" : status === "running" || status === "leased" ? "running" : "pending");

export function createDemandReader(deps: { db: Db }) {
  const { db } = deps;

  async function get(rawBatchId: string, actor: ActorContext): Promise<DemandView> {
    if (!actor.capabilities.has(CAP_SYNC_TRIGGER)) throw new SyncError("forbidden", `缺少 Capability ${CAP_SYNC_TRIGGER}`);
    if (!/^[1-9]\d*$/.test(rawBatchId)) throw new SyncError("invalid_input", "demand batch id 必须是十进制整数");
    const [batch] = await db.select().from(syncBatches).where(and(eq(syncBatches.batchId, BigInt(rawBatchId)), eq(syncBatches.purpose, "demand")));
    if (!batch) throw new SyncError("not_found", "按需批次不存在");
    const snap = batch.settingsSnapshot as { demand?: { actor?: string; dispositions?: DispositionRow[] } };
    const full = actor.scope.platformCodes === "all" && actor.scope.mediaStaffIds === "all";
    if (snap.demand?.actor !== actor.actorId && !full) throw new SyncError("out_of_scope", "只能查询自己提交的按需批次");
    const rows = snap.demand?.dispositions ?? [];
    const contentIds = [...new Set(rows.map((r) => BigInt(r.contentId)))];

    const tasks = contentIds.length
      ? await db.select().from(syncTasks).where(and(eq(syncTasks.batchId, batch.batchId), inArray(syncTasks.contentId, contentIds)))
      : [];
    const taskOf = (cid: string, action: string) => tasks.find((t) => t.contentId?.toString() === cid && t.requestedAction === action);
    const byId = new Map<bigint, (typeof tasks)[number]>();
    const pendingIds = rows.filter((r) => r.taskId).map((r) => BigInt(r.taskId!));
    if (pendingIds.length) for (const t of await db.select().from(syncTasks).where(inArray(syncTasks.taskId, pendingIds))) byId.set(t.taskId, t);

    // 读取指针
    const detailSnap = new Map<string, string>();
    const assets = new Map<string, string>();
    if (contentIds.length) {
      for (const s of await db
        .select({ contentId: contentSnapshots.contentId, id: contentSnapshots.contentSnapshotId })
        .from(contentSnapshots)
        .where(and(inArray(contentSnapshots.contentId, contentIds), eq(contentSnapshots.snapshotStatus, "finalized"), eq(contentSnapshots.detailObserved, true)))
        .orderBy(contentSnapshots.contentSnapshotId)) detailSnap.set(s.contentId.toString(), s.id.toString());
      for (const a of await db
        .select({ contentId: contentSnapshots.contentId, role: mediaReferences.role, asset: mediaReferences.mediaAssetId })
        .from(mediaReferences)
        .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
        .where(and(inArray(contentSnapshots.contentId, contentIds), inArray(mediaReferences.role, ["video", "audio"]), inArray(mediaReferences.archiveStatus, ["archived", "carried_forward"])))
        .orderBy(desc(mediaReferences.mediaReferenceId))) if (a.asset !== null) assets.set(`${a.contentId}/${a.role}`, a.asset.toString());
    }
    // 媒资任务成功但没有资产（例如无音轨）：如实展示引用上的稳定原因，而不是 ready
    const mediaErr = new Map<string, string>();
    if (contentIds.length) {
      for (const a of await db
        .select({ contentId: contentSnapshots.contentId, role: mediaReferences.role, err: mediaReferences.lastErrorCode })
        .from(mediaReferences)
        .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
        .where(and(inArray(contentSnapshots.contentId, contentIds), inArray(mediaReferences.role, ["video", "audio"]), eq(mediaReferences.archiveStatus, "failed")))
        .orderBy(mediaReferences.mediaReferenceId)) if (a.err) mediaErr.set(`${a.contentId}/${a.role}`, a.err);
    }
    const commentsPointer = async (cid: string, taskRow?: (typeof tasks)[number]) => {
      let t = taskRow;
      if (!t || t.status !== "succeeded") [t] = await db.select().from(syncTasks).where(and(eq(syncTasks.contentId, BigInt(cid)), eq(syncTasks.requestedAction, "fetch_comments"), eq(syncTasks.status, "succeeded"))).orderBy(desc(syncTasks.finishedAt)).limit(1);
      const f = (t?.resultSummary as { final?: { fetched_at: string; coverage: "complete" | "partial" | "unknown"; fetched: number; reported_total: string | null } } | null)?.final;
      return f ? { fetchedAt: f.fetched_at, coverage: f.coverage, fetchedCount: f.fetched, reportedTotal: f.reported_total } : undefined;
    };

    const items: WantView[] = [];
    for (const r of rows) {
      const base = { contentId: r.contentId, want: r.want, disposition: r.disposition };
      if (REJECTED.has(r.disposition)) {
        items.push({ ...base, state: "unsupported", reason: r.disposition });
        continue;
      }
      const taskRow = r.taskId ? byId.get(BigInt(r.taskId)) : taskOf(r.contentId, ACTION[r.want]);
      const pointers: NonNullable<WantView["pointers"]> = {};
      if (r.want === "detail" && detailSnap.has(r.contentId)) pointers.contentSnapshotId = detailSnap.get(r.contentId)!;
      if (r.want === "comments") {
        const c = await commentsPointer(r.contentId, taskRow);
        if (c) pointers.comments = c;
      }
      if ((r.want === "video" || r.want === "audio") && assets.has(`${r.contentId}/${r.want}`)) pointers.mediaAssetId = assets.get(`${r.contentId}/${r.want}`)!;
      const hasPointer = Object.keys(pointers).length > 0;

      if (r.disposition === "reused") {
        items.push({ ...base, state: "reused_ready", ...(hasPointer ? { pointers } : {}) });
        continue;
      }
      // video / audio：资产已在 = ready；否则看媒资任务，没有媒资任务就看详情任务（后续任务由详情成功时创建）
      if (r.want === "video" || r.want === "audio") {
        if (pointers.mediaAssetId) {
          items.push({ ...base, state: "ready", pointers });
          continue;
        }
        const media = r.taskId ? byId.get(BigInt(r.taskId)) : taskOf(r.contentId, "download_media");
        if (media) {
          const st = stateOf(media.status);
          const refErr = st === "ready" ? mediaErr.get(`${r.contentId}/${r.want}`) : undefined;
          if (refErr) items.push({ ...base, state: "failed", reason: refErr });
          else items.push({ ...base, state: st, ...(st === "failed" ? { reason: media.lastErrorCode ?? media.status } : {}) });
          continue;
        }
        const detail = taskOf(r.contentId, "fetch_content_detail");
        const dst = detail ? stateOf(detail.status) : "pending";
        const noSource = (detail?.resultSummary as { media_followup?: string } | null)?.media_followup === "no_source";
        if (detail && dst === "failed") items.push({ ...base, state: "failed", reason: detail.lastErrorCode ?? detail.status });
        else if (noSource) items.push({ ...base, state: "failed", reason: "no_download_source" });
        else items.push({ ...base, state: dst === "ready" ? "pending" : dst });
        continue;
      }
      if (!taskRow) {
        items.push({ ...base, state: "pending" });
        continue;
      }
      const st = stateOf(taskRow.status);
      items.push({ ...base, state: st, ...(st === "failed" ? { reason: taskRow.lastErrorCode ?? taskRow.status } : {}), ...(st === "ready" && hasPointer ? { pointers } : {}) });
    }
    return { batchId: batch.batchId.toString(), status: batch.status, items };
  }
  return { get };
}
export type DemandReader = ReturnType<typeof createDemandReader>;
