// 提交按需采集需求（FS-8、design §7.8）：规范化 → 幂等 → 逐项处置 → 建批次 → 事务外分块建任务。
// A 只执行不决定：不解释圈定条件、阈值或规则语义；rule_decision_id / rule_version 只是写进每个任务并随之保留。
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { contentSnapshots, contents, dataProviders, mediaReferences, platforms, staffAccountAssignments as aa, syncBatches, syncTasks } from "../../db/schema";
import { jcsSha256, jcsSha256Hex } from "../canonical-json";
import { isDuplicateKey } from "../orchestrator";
import { buildContentUrl, capabilityGate, UnsupportedCapabilityError, type AiMasterAction, type ExecutionMode, type Platform } from "../provider-adapter";
import type { Clock } from "../raw-capture";
import { SyncError, type SyncAuditSink } from "../sync-schedule";
import { ACTIVE_TASK_STATUSES } from "../sync-schedule/task-keys";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../tracer-command";
import { isFreshForRound, roundStart } from "./reuse";
import { COMMENTS_TASK_SCHEMA, DETAIL_TASK_SCHEMA, MEDIA_VIDEO_TASK_SCHEMA, insertDemandTask, type MediaRole } from "./tasks";
import { submitSchema, type DemandRuntime, type DispositionRow, type PlannedTask, type SubmitResult, type Want } from "./types";
import { isCommentsPlatform } from "../comments/policy";
import { loadSettings } from "../sync-schedule/settings";

const CHUNK = 500;
const FACT_CHUNK = 1000;
const ORDER: Want[] = ["detail", "comments", "video", "audio"];
const big = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

interface Facts {
  contentId: bigint;
  accountId: bigint;
  platformId: bigint;
  platformCode: Platform;
  assignmentId: bigint;
  staffId: bigint | null;
  currentSnapshotId: bigint | null;
  hasFinalized: boolean;
}
interface DoneDetail {
  taskId: bigint;
  snapshotId: string | null;
  sources: string[];
}

export function createDemandSubmitter(deps: { db: Db; clock: Clock; runtime: DemandRuntime; audit: SyncAuditSink }) {
  const { db, clock, runtime, audit } = deps;
  const emit = (outcome: "accepted" | "rejected", actor: ActorContext, extra: { code?: string; batchId?: string; detail?: Record<string, string | number | boolean | null> } = {}) =>
    audit.record({ at: clock.now().toISOString(), event: "sync.command", action: "demand_submit", outcome, actorId: actor.actorId, ...extra });

  const capOk = (platform: Platform, action: AiMasterAction, mode: ExecutionMode): boolean => {
    try {
      capabilityGate.require({ platform, action, mode, environment: runtime.environment });
      return true;
    } catch (e) {
      if (e instanceof UnsupportedCapabilityError) return false;
      throw e;
    }
  };
  const inPlatformScope = (a: ActorContext, code: string) => a.scope.platformCodes === "all" || a.scope.platformCodes.has(code);
  const inStaffScope = (a: ActorContext, staffId: bigint | null) => (staffId === null ? a.scope.mediaStaffIds === "all" : a.scope.mediaStaffIds === "all" || a.scope.mediaStaffIds.has(staffId));

  async function loadFacts(ids: bigint[]): Promise<Map<bigint, Facts>> {
    const out = new Map<bigint, Facts>();
    for (let i = 0; i < ids.length; i += FACT_CHUNK) {
      const chunk = ids.slice(i, i + FACT_CHUNK);
      const rows = await db
        .select({ contentId: contents.contentId, accountId: contents.accountId, platformId: contents.platformId, platformCode: platforms.platformCode, assignmentId: aa.assignmentId, staffId: aa.staffId, currentSnapshotId: contents.currentSnapshotId })
        .from(contents)
        .innerJoin(platforms, eq(platforms.platformId, contents.platformId))
        .innerJoin(aa, eq(aa.accountId, contents.accountId))
        .where(inArray(contents.contentId, chunk));
      const fin = new Set((await db.selectDistinct({ id: contentSnapshots.contentId }).from(contentSnapshots).where(and(inArray(contentSnapshots.contentId, chunk), eq(contentSnapshots.snapshotStatus, "finalized")))).map((r) => r.id));
      for (const r of rows) out.set(r.contentId, { ...r, platformCode: r.platformCode as Platform, hasFinalized: fin.has(r.contentId) });
    }
    return out;
  }

  /** 逐项处置 + 要建的任务（只读；不写库）。 */
  async function plan(items: Array<{ contentId: bigint; wants: Want[] }>, actor: ActorContext, settings: { commentPageLimit: number | null; commentItemLimit: number | null }) {
    const start = await roundStart(db);
    const dispositions: DispositionRow[] = [];
    const tasks: PlannedTask[] = [];
    for (let i = 0; i < items.length; i += FACT_CHUNK) {
      const chunk = items.slice(i, i + FACT_CHUNK);
      const ids = chunk.map((c) => c.contentId);
      const facts = await loadFacts(ids);

      // 本轮已有的详情 / 评论（任何批次用途）
      const done = await db
        .select({ taskId: syncTasks.taskId, contentId: syncTasks.contentId, action: syncTasks.requestedAction, finishedAt: syncTasks.finishedAt, summary: syncTasks.resultSummary })
        .from(syncTasks)
        .where(and(inArray(syncTasks.contentId, ids), inArray(syncTasks.requestedAction, ["fetch_content_detail", "fetch_comments"]), eq(syncTasks.status, "succeeded")));
      const doneBy = new Map<string, DoneDetail>();
      for (const d of done.sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0))) {
        if (!isFreshForRound(d.finishedAt, start)) continue;
        const s = d.summary as { content_snapshot_id?: string; download_candidates?: string[] } | null;
        doneBy.set(`${d.contentId}/${d.action}`, { taskId: d.taskId, snapshotId: s?.content_snapshot_id ?? null, sources: s?.download_candidates ?? [] });
      }
      // 活动任务（跨批次复用）
      const active = await db
        .select({ taskId: syncTasks.taskId, contentId: syncTasks.contentId, action: syncTasks.requestedAction, params: syncTasks.taskParameters })
        .from(syncTasks)
        .where(and(inArray(syncTasks.contentId, ids), inArray(syncTasks.requestedAction, ["fetch_content_detail", "fetch_comments", "download_media"]), inArray(syncTasks.status, [...ACTIVE_TASK_STATUSES])));
      const activeBy = new Map<string, { taskId: bigint; roles: string[] }>();
      for (const a of active) activeBy.set(`${a.contentId}/${a.action}`, { taskId: a.taskId, roles: ((a.params as { roles?: string[] } | null)?.roles ?? []) });
      // 已有正式资产（视频字节不随时间变：有就复用，不看轮次）
      const assets = await db
        .selectDistinct({ contentId: contentSnapshots.contentId, role: mediaReferences.role })
        .from(mediaReferences)
        .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
        .where(and(inArray(contentSnapshots.contentId, ids), inArray(mediaReferences.role, ["video", "audio"]), inArray(mediaReferences.archiveStatus, ["archived", "carried_forward"])));
      const assetSet = new Set(assets.map((a) => `${a.contentId}/${a.role}`));

      for (const item of chunk) {
        const cid = item.contentId.toString();
        const f = facts.get(item.contentId);
        const wants = ORDER.filter((w) => item.wants.includes(w));
        const reject = (disposition: DispositionRow["disposition"]) => wants.forEach((w) => dispositions.push({ contentId: cid, want: w, disposition }));
        // 没有 finalized 快照 = 周期批次还没给它封口：如实拒绝，规则域稍后再提
        if (!f || !f.hasFinalized) {
          reject("content_not_found");
          continue;
        }
        if (!inPlatformScope(actor, f.platformCode) || !inStaffScope(actor, f.staffId)) {
          reject("out_of_scope");
          continue;
        }
        const d = (w: Want, disposition: DispositionRow["disposition"], taskId?: bigint) => dispositions.push({ contentId: cid, want: w, disposition, ...(taskId === undefined ? {} : { taskId: taskId.toString() }) });
        const detailOk = capOk(f.platformCode, "media_stats_number", runtime.modes.media_stats_number) && buildContentUrl(f.platformCode, { postId: "x" }).ok;
        const base = { contentId: cid, accountId: f.accountId.toString(), assignmentId: f.assignmentId.toString(), platformId: f.platformId.toString(), sourceSnapshotId: f.currentSnapshotId?.toString() ?? null };

        let detailDisp: DispositionRow["disposition"] | null = null;
        const doneDetail = doneBy.get(`${item.contentId}/fetch_content_detail`);
        const activeDetail = activeBy.get(`${item.contentId}/fetch_content_detail`);
        const wantsMedia = wants.includes("video") || wants.includes("audio");

        if (wants.includes("detail")) {
          if (!detailOk) d("detail", "capability_disabled");
          else if (doneDetail) d("detail", "reused");
          else if (activeDetail) d("detail", "already_pending", activeDetail.taskId);
          else {
            detailDisp = "queued";
            d("detail", "queued");
          }
        }
        if (wants.includes("comments")) {
          if (!isCommentsPlatform(f.platformCode)) d("comments", "unsupported_platform");
          else if (!capOk(f.platformCode, "post_comments_list", runtime.modes.post_comments_list)) d("comments", "capability_disabled");
          else if (doneBy.has(`${item.contentId}/fetch_comments`)) d("comments", "reused");
          else if (activeBy.has(`${item.contentId}/fetch_comments`)) d("comments", "already_pending", activeBy.get(`${item.contentId}/fetch_comments`)!.taskId);
          else {
            d("comments", "queued");
            tasks.push({ ...base, action: "fetch_comments", params: { schema_version: COMMENTS_TASK_SCHEMA, mode: runtime.modes.post_comments_list, content_id: cid, page_limit: settings.commentPageLimit, item_limit: settings.commentItemLimit }, sourceSnapshotId: base.sourceSnapshotId });
          }
        }

        // 视频 / 音频：audio ⇒ video ⇒ detail（需要新鲜下载地址）
        const roles = new Set<MediaRole>();
        const videoAsset = assetSet.has(`${item.contentId}/video`);
        const activeMedia = activeBy.get(`${item.contentId}/download_media`);
        if (wantsMedia) {
          if (!detailOk) {
            if (wants.includes("video")) d("video", "capability_disabled");
            if (wants.includes("audio")) d("audio", "capability_disabled");
          } else {
            if (wants.includes("video")) {
              if (videoAsset) d("video", "reused");
              else if (activeMedia?.roles.includes("video")) d("video", "already_pending", activeMedia.taskId);
              else (d("video", "queued"), roles.add("video"));
            }
            if (wants.includes("audio")) {
              if (assetSet.has(`${item.contentId}/audio`)) d("audio", "reused");
              else if (activeMedia?.roles.includes("audio")) d("audio", "already_pending", activeMedia.taskId);
              else {
                d("audio", "queued");
                roles.add("audio");
                if (!videoAsset && !activeMedia?.roles.includes("video")) roles.add("video");
              }
            }
          }
        }

        const reusableDetail = doneDetail && doneDetail.snapshotId !== null && doneDetail.sources.length > 0 ? doneDetail : undefined;
        const mediaRoles = ORDER.filter((w): w is MediaRole => (w === "video" || w === "audio") && roles.has(w));
        // 详情任务：显式要且需要新建，或媒资需要而本轮没有带下载地址的详情（自己建一个，ponytail: 别的计划的活动详情不借用）
        if (detailDisp === "queued" || (mediaRoles.length > 0 && !reusableDetail)) {
          tasks.push({ ...base, action: "fetch_content_detail", params: { schema_version: DETAIL_TASK_SCHEMA, mode: runtime.modes.media_stats_number, content_id: cid, followups: { roles: reusableDetail ? [] : mediaRoles } }, sourceSnapshotId: base.sourceSnapshotId });
        }
        if (mediaRoles.length > 0 && reusableDetail) {
          tasks.push({ ...base, action: "download_media", params: { schema_version: MEDIA_VIDEO_TASK_SCHEMA, content_id: cid, content_snapshot_id: reusableDetail.snapshotId, roles: mediaRoles, sources: reusableDetail.sources, detail_mode: runtime.modes.media_stats_number }, sourceSnapshotId: reusableDetail.snapshotId });
        }
      }
    }
    return { dispositions, tasks };
  }

  async function ensureTasks(batchId: bigint, tasks: PlannedTask[], p: { providerId: bigint; ruleDecisionId: string; ruleVersion: string; maxAttempts: number }): Promise<void> {
    for (let i = 0; i < tasks.length; i += CHUNK) {
      await db.transaction(async (tx) => {
        for (const t of tasks.slice(i, i + CHUNK)) {
          await insertDemandTask(tx, {
            batchId,
            providerId: p.providerId,
            platformId: BigInt(t.platformId),
            assignmentId: BigInt(t.assignmentId),
            accountId: BigInt(t.accountId),
            contentId: BigInt(t.contentId),
            action: t.action,
            params: t.params,
            sourceContentSnapshotId: t.sourceSnapshotId === null ? null : BigInt(t.sourceSnapshotId),
            ruleDecisionId: p.ruleDecisionId,
            ruleVersion: p.ruleVersion,
            maxAttempts: p.maxAttempts,
            now: clock.now(),
          });
        }
      });
    }
  }

  async function submit(raw: unknown, actor: ActorContext): Promise<SubmitResult> {
    try {
      if (!actor.capabilities.has(CAP_SYNC_TRIGGER)) throw new SyncError("forbidden", `缺少 Capability ${CAP_SYNC_TRIGGER}`);
      const parsed = submitSchema.safeParse(raw);
      if (!parsed.success) throw new SyncError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
      const input = parsed.data;

      // 规范化：按 contentId 排序，同一内容的 wants 取并集并按固定顺序排序
      const merged = new Map<string, Set<Want>>();
      for (const it of input.items) {
        const s = merged.get(it.contentId) ?? new Set<Want>();
        it.wants.forEach((w) => s.add(w));
        merged.set(it.contentId, s);
      }
      const items = [...merged].map(([contentId, w]) => ({ contentId: BigInt(contentId), wants: ORDER.filter((x) => w.has(x)) })).sort((a, b) => big(a.contentId, b.contentId));
      const commandSha = jcsSha256Hex({ v: "sync-demand.v1", requester: input.requester, ruleDecisionId: input.ruleDecisionId, ruleVersion: input.ruleVersion, items: items.map((i) => ({ contentId: i.contentId.toString(), wants: i.wants })) });
      const batchKey = jcsSha256({ v: "sync-demand.v1", actor: actor.actorId, key: input.demandKey });
      const [provider] = await db.select({ id: dataProviders.providerId }).from(dataProviders).where(eq(dataProviders.providerCode, "aimaster"));
      if (!provider) throw new Error("数据供应商 aimaster 未登记");
      const { row: settings } = await loadSettings(db);

      const replay = async (): Promise<SubmitResult | null> => {
        const [dup] = await db.select().from(syncBatches).where(eq(syncBatches.batchKey, batchKey));
        if (!dup) return null;
        const snap = dup.settingsSnapshot as { demand?: { command_sha256?: string; dispositions?: DispositionRow[]; tasks?: PlannedTask[]; rule_decision_id?: string; rule_version?: string } };
        if (snap.demand?.command_sha256 !== commandSha) throw new SyncError("idempotency_conflict", "同一 demandKey 对应了不同的需求载荷");
        // 崩溃后重放：按已存的计划补齐缺失任务（幂等键保证不重复）
        await ensureTasks(dup.batchId, snap.demand.tasks ?? [], { providerId: provider.id, ruleDecisionId: snap.demand.rule_decision_id ?? input.ruleDecisionId, ruleVersion: snap.demand.rule_version ?? input.ruleVersion, maxAttempts: settings.taskMaxAttempts });
        return { kind: "deduplicated", batchId: dup.batchId.toString(), status: dup.status, dispositions: snap.demand.dispositions ?? [], taskCount: snap.demand.tasks?.length ?? 0 };
      };
      const again = await replay();
      if (again) return again;

      const planned = await plan(items, actor, { commentPageLimit: settings.commentPageLimit, commentItemLimit: settings.commentItemLimit });
      const now = clock.now();
      const status = planned.tasks.length === 0 ? "succeeded" : "running";
      let batchId: bigint;
      try {
        const [ins] = await db.insert(syncBatches).values({
          batchKey,
          triggerType: "manual",
          purpose: "demand",
          logicalAt: now,
          status,
          settingsVersion: settings.configVersion,
          settingsSnapshot: {
            timezone: settings.timezone,
            comment_page_limit: settings.commentPageLimit,
            comment_item_limit: settings.commentItemLimit,
            task_max_attempts: settings.taskMaxAttempts,
            config_version: settings.configVersion.toString(),
            runtime: { environment: runtime.environment, modes: runtime.modes },
            demand: {
              command_sha256: commandSha,
              actor: actor.actorId,
              requester: input.requester,
              rule_decision_id: input.ruleDecisionId,
              rule_version: input.ruleVersion,
              dispositions: planned.dispositions,
              tasks: planned.tasks,
            },
          },
          plannedTaskCount: planned.tasks.length,
          startedAt: now,
          ...(status === "succeeded" ? { finishedAt: now } : {}),
          createdAt: now,
          updatedAt: now,
        });
        batchId = BigInt(ins.insertId);
      } catch (e) {
        // 另一个并发提交抢先建了同一个批次：当作重放
        if (isDuplicateKey(e)) {
          const r = await replay();
          if (r) return r;
        }
        throw e;
      }
      await ensureTasks(batchId, planned.tasks, { providerId: provider.id, ruleDecisionId: input.ruleDecisionId, ruleVersion: input.ruleVersion, maxAttempts: settings.taskMaxAttempts });
      emit("accepted", actor, { batchId: batchId.toString(), detail: { items: items.length, tasks: planned.tasks.length } });
      return { kind: "created", batchId: batchId.toString(), status, dispositions: planned.dispositions, taskCount: planned.tasks.length };
    } catch (e) {
      if (e instanceof SyncError) emit("rejected", actor, { code: e.code });
      throw e;
    }
  }

  return { submit };
}
export type DemandSubmitter = ReturnType<typeof createDemandSubmitter>;
