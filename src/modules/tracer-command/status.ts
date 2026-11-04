// 本地、脱敏的状态查询（R15）。只读本地事实：依赖里只有 db 与 clock，没有 ProviderTransport，也没有媒资源站。
// 脱敏靠构造：输出只从白名单字段拼出（稳定码、计数、ID 字符串、时间），不透传 JSON 详情、URL、对象 key、载荷。
import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  accountProfileSnapshots,
  contentDiscoveries,
  contentSnapshots,
  contents,
  dataQualityIssues,
  mediaReferences,
  platforms,
  staffAccountAssignments,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import { classifyMediaFailure } from "../media-failure";
import type { Clock } from "../raw-capture";
import { inScope, requireCapability, type ActorContext } from "./actor";
import { decimalId } from "./canonical";
import { TracerError } from "./errors";

export type TracerState =
  | "accepted"
  | "in_progress"
  | "retry_wait"
  | "structured_succeeded_media_pending"
  | "succeeded"
  | "succeeded_with_warnings"
  | "blocked_assignment_conflict"
  | "blocked_staff_platform_slot_taken"
  | "failed"
  | "cancelled";

export type EntryOutcome = "normal" | "invalid_link" | "suspected_empty";

export interface TracerStatusFound {
  kind: "found";
  rootTaskId: string;
  state: TracerState;
  /** 仅 in_progress 时有。 */
  stage?: string;
  stages: Array<{ name: string; state: string; attempts: number }>;
  target?: { accountId: string; ownerMediaStaffId?: string; submittedMediaStaffIsOwner: boolean };
  structured: {
    profileFinalized: boolean;
    returnedEntries: number;
    projectedEntries: number;
    discoveries: number;
    checkpointEstablished: boolean;
    cursorType?: "string" | "integer" | "null";
  };
  media: {
    total: number;
    pending: number;
    archived: number;
    /** failed = retryable + needsFreshUrl + terminal。 */
    failed: number;
    carriedForward: number;
    /** 同一个 URL 还可能成功（网络、CDN 抖动、转换服务暂不可用），会有界地重试。 */
    retryable: number;
    /** 签名 URL 过期，必须等下一次采集拿到新地址。 */
    needsFreshUrl: number;
    terminal: number;
  };
  entryOutcome?: EntryOutcome;
  warnings: Array<{ code: string; stage: string }>;
  qualityIssues: Array<{ code: string; status: string }>;
  failure?: { category: string; code: string; retryable: boolean };
  timestamps: { acceptedAt: string; updatedAt: string; completedAt?: string };
}

/** 未知、越权、非 root 都是 not_found（外部无法探测哪些 root 存在）；过期只对有权范围内的调用方可见。 */
export type TracerStatus = TracerStatusFound | { kind: "not_found" } | { kind: "expired" };

export interface TracerStatusQuery {
  get(rootTaskId: string, actor: ActorContext): Promise<TracerStatus>;
}

const TERMINAL = new Set(["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"]);
const ACTIVE = ["pending", "leased", "running", "retry_wait"] as const;

const STAGE_OF_ACTION: Record<string, string> = {
  resolve_account: "resolving_locator",
  fetch_profile: "fetching_profile",
  fetch_content_list: "fetching_first_page",
  download_media: "media_archiving",
};

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;
const safeCode = (v: unknown, fallback: string): string => (typeof v === "string" && SAFE_CODE.test(v) ? v : fallback);
const ENTRY_OUTCOMES = new Set<string>(["normal", "invalid_link", "suspected_empty"]);

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseRootId(raw: string): bigint {
  const r = decimalId.safeParse(raw);
  if (!r.success) throw new TracerError("invalid_input", "root_task_id 必须是十进制数字");
  return BigInt(r.data);
}

export function createTracerStatusQuery(deps: { db: Db; clock: Clock }): TracerStatusQuery {
  const { db, clock } = deps;

  return {
    async get(rootTaskIdRaw, actor) {
      requireCapability(actor);
      const rootId = parseRootId(rootTaskIdRaw);

      const [row] = await db
        .select({ task: syncTasks, platformCode: platforms.platformCode })
        .from(syncTasks)
        .innerJoin(platforms, eq(platforms.platformId, syncTasks.platformId))
        .where(and(eq(syncTasks.taskId, rootId), eq(syncTasks.requestedAction, "resolve_account"), isNull(syncTasks.parentTaskId)));
      if (!row || row.task.subjectId === null || !inScope(actor, row.platformCode, row.task.subjectId)) return { kind: "not_found" };
      const root = row.task;
      if (root.expiresAt.getTime() <= clock.now().getTime()) return { kind: "expired" };

      const children = await db.select().from(syncTasks).where(eq(syncTasks.parentTaskId, rootId)).orderBy(syncTasks.taskId);

      // 目标账号与归属
      let assignment: typeof staffAccountAssignments.$inferSelect | undefined;
      if (root.accountId !== null) {
        [assignment] = await db.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.accountId, root.accountId));
      }

      const structured: TracerStatusFound["structured"] = {
        profileFinalized: false,
        returnedEntries: children.filter((c) => c.requestedAction === "fetch_content_list").reduce((n, c) => n + c.fetchedItemCount, 0),
        projectedEntries: 0,
        discoveries: 0,
        checkpointEstablished: false,
      };
      const media = { total: 0, pending: 0, archived: 0, failed: 0, carriedForward: 0, retryable: 0, needsFreshUrl: 0, terminal: 0 };

      if (root.accountId !== null) {
        const [snap] = await db
          .select({ n: count() })
          .from(accountProfileSnapshots)
          .where(and(eq(accountProfileSnapshots.batchId, root.batchId), eq(accountProfileSnapshots.accountId, root.accountId)));
        structured.profileFinalized = Number(snap?.n ?? 0) > 0; // 主页快照创建成功即为终态

        if (assignment) {
          const [d] = await db
            .select({ n: count() })
            .from(contentDiscoveries)
            .where(and(eq(contentDiscoveries.batchId, root.batchId), eq(contentDiscoveries.assignmentId, assignment.assignmentId)));
          structured.discoveries = Number(d?.n ?? 0);
          structured.projectedEntries = structured.discoveries;
        }

        const [cp] = await db
          .select({ cursor: syncCheckpoints.cursorEnvelope })
          .from(syncCheckpoints)
          .where(and(eq(syncCheckpoints.accountId, root.accountId), eq(syncCheckpoints.lastSuccessfulBatchId, root.batchId)))
          .limit(1);
        if (cp) {
          structured.checkpointEstablished = true;
          const kind = asObject(cp.cursor)?.kind;
          if (kind === "string" || kind === "integer" || kind === "null") structured.cursorType = kind;
        }

        const profileRefs = await db
          .select({ status: mediaReferences.archiveStatus, code: mediaReferences.lastErrorCode, n: count() })
          .from(mediaReferences)
          .innerJoin(accountProfileSnapshots, eq(accountProfileSnapshots.profileSnapshotId, mediaReferences.profileSnapshotId))
          .where(and(eq(accountProfileSnapshots.batchId, root.batchId), eq(accountProfileSnapshots.accountId, root.accountId)))
          .groupBy(mediaReferences.archiveStatus, mediaReferences.lastErrorCode);
        const contentRefs = await db
          .select({ status: mediaReferences.archiveStatus, code: mediaReferences.lastErrorCode, n: count() })
          .from(mediaReferences)
          .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
          .innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId))
          .where(and(eq(contentSnapshots.batchId, root.batchId), eq(contents.accountId, root.accountId)))
          .groupBy(mediaReferences.archiveStatus, mediaReferences.lastErrorCode);
        for (const r of [...profileRefs, ...contentRefs]) {
          const n = Number(r.n);
          media.total += n;
          if (r.status === "pending") media.pending += n;
          else if (r.status === "archived") media.archived += n;
          else if (r.status === "failed") {
            media.failed += n;
            const cls = classifyMediaFailure(r.code);
            if (cls === "retryable") media.retryable += n;
            else if (cls === "needs_fresh_url") media.needsFreshUrl += n;
            else media.terminal += n;
          }
          else if (r.status === "carried_forward") media.carriedForward += n;
        }
      }

      const issues = await db
        .select({ code: dataQualityIssues.issueCode, status: dataQualityIssues.status })
        .from(dataQualityIssues)
        .where(eq(dataQualityIssues.batchId, root.batchId))
        .orderBy(dataQualityIssues.issueId);

      const summary = asObject(root.resultSummary);
      const warnings: TracerStatusFound["warnings"] = [];
      if (Array.isArray(summary?.warnings)) {
        for (const w of summary.warnings) {
          const o = asObject(w);
          if (o) warnings.push({ code: safeCode(o.code, "unspecified"), stage: safeCode(o.stage, "unspecified") });
        }
      }

      const submittedIsOwner = assignment !== undefined && assignment.staffId === root.subjectId;
      const target: TracerStatusFound["target"] | undefined =
        root.accountId === null
          ? undefined
          : {
              accountId: root.accountId.toString(),
              ...(assignment?.staffId != null && (actor.scope.mediaStaffIds === "all" || actor.scope.mediaStaffIds.has(assignment.staffId))
                ? { ownerMediaStaffId: assignment.staffId.toString() }
                : {}),
              submittedMediaStaffIsOwner: submittedIsOwner,
            };

      const activeChild = [...children].reverse().find((c) => (ACTIVE as readonly string[]).includes(c.status));
      const state = deriveState(root, media);
      const stageAction = activeChild?.requestedAction ?? "resolve_account";

      let entryOutcome: EntryOutcome | undefined;
      if (typeof summary?.entry_outcome === "string" && ENTRY_OUTCOMES.has(summary.entry_outcome)) {
        entryOutcome = summary.entry_outcome as EntryOutcome;
      } else if (submittedIsOwner && assignment && root.status === "succeeded") {
        entryOutcome = assignment.intakeStatus as EntryOutcome;
      }

      const failure = deriveFailure(root);
      const completed = TERMINAL.has(root.status) ? (root.finishedAt ?? root.updatedAt) : undefined;

      const found: TracerStatusFound = {
        kind: "found",
        rootTaskId: root.taskId.toString(),
        state,
        ...(state === "in_progress" ? { stage: STAGE_OF_ACTION[stageAction] ?? "in_progress" } : {}),
        stages: [root, ...children].map((c) => ({ name: c.requestedAction, state: c.status, attempts: c.attemptCount })),
        ...(target ? { target } : {}),
        structured,
        media,
        ...(entryOutcome ? { entryOutcome } : {}),
        warnings,
        qualityIssues: issues.map((i) => ({ code: i.code, status: i.status })),
        ...(failure ? { failure } : {}),
        timestamps: {
          acceptedAt: root.createdAt.toISOString(),
          updatedAt: root.updatedAt.toISOString(),
          ...(completed ? { completedAt: completed.toISOString() } : {}),
        },
      };
      return found;
    },
  };
}

function deriveState(root: typeof syncTasks.$inferSelect, media: TracerStatusFound["media"]): TracerState {
  switch (root.status) {
    case "pending":
      return "accepted";
    case "leased":
    case "running":
      return "in_progress";
    case "retry_wait":
      return "retry_wait";
    case "cancelled":
      return "cancelled";
    case "dead":
      return "failed";
    case "failed":
      if (root.stopReason === "assignment_conflict") return "blocked_assignment_conflict";
      if (root.stopReason === "staff_platform_slot_taken") return "blocked_staff_platform_slot_taken";
      return "failed";
    case "succeeded_with_gap":
      return "succeeded_with_warnings";
    case "succeeded":
      if (media.pending > 0) return "structured_succeeded_media_pending";
      if (media.failed > 0 || media.carriedForward > 0) return "succeeded_with_warnings";
      return "succeeded";
    default:
      return "failed";
  }
}

function deriveFailure(root: typeof syncTasks.$inferSelect): TracerStatusFound["failure"] | undefined {
  const retryable = root.status === "retry_wait";
  if (!retryable && root.status !== "failed" && root.status !== "dead") return undefined;
  if (root.status === "failed" && (root.stopReason === "assignment_conflict" || root.stopReason === "staff_platform_slot_taken") && !root.lastErrorCode) {
    return { category: "assignment", code: root.stopReason, retryable: false };
  }
  const detail = asObject(root.lastErrorDetail);
  return {
    category: safeCode(detail?.category, "unclassified"),
    code: safeCode(root.lastErrorCode ?? root.stopReason, "unspecified"),
    retryable,
  };
}

// 供 submit 复用，避免两处各写一份「活动状态」
export const ACTIVE_STATUSES = ACTIVE;
