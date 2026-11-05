// MediaArchiveModule：把已投影的头像 / 背景 / 封面引用归档为正式媒资（R8.5、R12）。
//
//  - 与结构化阶段解耦：根任务先成功，媒资作为独立的 download_media 子任务（每轮一个）异步推进，失败只是警告；
//  - 网络下载、字节校验、转换都在数据库事务之外；每个引用一个短事务，先按子任务 fencing token 校验再写；
//  - 正式资产按「完整字节的 SHA-256」判同（内容寻址的对象 key），不按 URL；临时签名 URL 只留在 media_references.source_locator；
//  - 原始字节与标准化衍生图（JPEG q80、540 宽）是两份独立资产、各有 SHA-256，互不替代；
//  - 下载失败：上一快照有已验证资产 → carried_forward（保留本轮失败码，不算本轮成功）；否则 failed；
//  - 有界重试：同一次运行内对可重试错误最多 2 次；每轮之间再试；最多 3 轮。签名 URL 过期需要新地址，不用旧地址重试。
import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import type { Db, DbTx } from "../../db/client";
import { accountProfileSnapshots, contentSnapshots, contents, mediaAssets, mediaReferences, ossObjects, syncBatches, syncTasks } from "../../db/schema";
import { jcsSha256 } from "../canonical-json";
import { MediaFailure, classifyMediaFailure, type MediaFailureCode } from "../media-failure";
import { claimTask, isDuplicateKey, withFences, type Fenced, type TaskRow } from "../orchestrator";
import { recordIssue } from "../projection/quality";
import type { Clock, ObjectStore } from "../raw-capture";
import { downloadBounded } from "./download";
import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from "./guard";
import { ConverterError, type ImageConverter, type MediaTransport, type NormalizedImage } from "./ports";
import { sniffImage } from "./sniff";

export const MEDIA_TASK_PARAMETERS_VERSION = "data-foundation-tracer-media-task.v1";
const ORIGINAL_ROLES = ["avatar", "background", "cover"] as const;
type OriginalRole = (typeof ORIGINAL_ROLES)[number];
const NORMALIZED_OF: Record<OriginalRole, "avatar_normalized" | "background_normalized" | "cover_normalized"> = {
  avatar: "avatar_normalized",
  background: "background_normalized",
  cover: "cover_normalized",
};
const MAX_ROUNDS = 3;
const IN_RUN_ATTEMPTS = 2;
const DEFAULT_LEASE_MS = 120_000;

type RefRow = typeof mediaReferences.$inferSelect;

export interface MediaArchiveHooks {
  /** 一个引用的下载与转换完成、提交事务之前。 */
  beforeRefCommit?(): Promise<void> | void;
}

export interface MediaArchiveDeps {
  db: Db;
  clock: Clock;
  /** 正式媒资桶（与 ODS 桶分开，ADR-0001）。 */
  mediaStore: ObjectStore;
  location: { providerCode: string; region: string; bucket: string };
  transport: MediaTransport;
  converter: ImageConverter;
  workerId: string;
  leaseMs?: number;
  policy?: MediaPolicy;
  maxRounds?: number;
  hooks?: MediaArchiveHooks;
}

export type MediaRunKind = "done" | "nothing_to_do" | "not_ready" | "busy" | "stale" | "cancelled" | "rounds_exhausted";
export interface MediaRunResult {
  kind: MediaRunKind;
  round: number;
  /** 本次运行新归档成功的原始引用数。 */
  archived: number;
  /** 本次运行续用旧资产的引用数（原始 + 衍生）。 */
  carriedForward: number;
  /** 运行结束时处于各失败类别的引用数（任一角色）。 */
  failedRetryable: number;
  failedTerminal: number;
  needsFreshUrl: number;
}

interface Ctx {
  deps: MediaArchiveDeps;
  root: TaskRow;
  child: TaskRow;
  token: bigint;
  batchOrder: { logicalAt: Date; batchId: bigint };
  derivedMemo: Map<string, NormalizedImage & { sha: string }>;
  tally: { archived: number; carriedForward: number };
}

const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const mediaKey = (sha: string) => `media/${sha.slice(0, 2)}/${sha}`;

export async function runMediaArchive(deps: MediaArchiveDeps, rootTaskId: bigint): Promise<MediaRunResult> {
  const { db, clock } = deps;
  const empty = (kind: MediaRunKind, round = 0): MediaRunResult => ({ kind, round, archived: 0, carriedForward: 0, failedRetryable: 0, failedTerminal: 0, needsFreshUrl: 0 });

  const [root] = await db.select().from(syncTasks).where(eq(syncTasks.taskId, rootTaskId));
  if (!root || root.parentTaskId !== null || root.requestedAction !== "resolve_account") throw new Error(`root ${rootTaskId} 不存在`);
  // 媒资归档晚于结构化阶段：根任务必须已经成功终态
  if (root.status !== "succeeded" || root.accountId === null) return empty("not_ready");

  const refs = await loadRefs(db, root);
  const work = refs.filter((r) => needsWork(r, refs));
  if (work.length === 0) return empty("nothing_to_do", (await mediaTasks(db, rootTaskId)).length);

  const rounds = await mediaTasks(db, rootTaskId);
  const latest = rounds[rounds.length - 1];
  const maxRounds = deps.maxRounds ?? MAX_ROUNDS;
  let child: TaskRow;
  let round: number;
  if (latest && !["succeeded", "failed", "dead", "cancelled", "succeeded_with_gap"].includes(latest.status)) {
    child = latest; // 上一轮崩溃在中途：接手同一轮
    round = rounds.length;
  } else {
    if (rounds.length >= maxRounds) return empty("rounds_exhausted", rounds.length);
    round = rounds.length + 1;
    child = await createRound(db, clock, root, round);
  }

  const claim = await claimTask(db, child.taskId, { workerId: deps.workerId, leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS, now: clock.now() });
  if (claim.kind === "busy") return empty("busy", round);
  if (claim.kind !== "claimed") return empty("nothing_to_do", round);

  const [batch] = await db.select().from(syncBatches).where(eq(syncBatches.batchId, root.batchId));
  const ctx: Ctx = {
    deps,
    root,
    child: claim.task,
    token: claim.token,
    batchOrder: { logicalAt: batch!.logicalAt, batchId: batch!.batchId },
    derivedMemo: new Map(),
    tally: { archived: 0, carriedForward: 0 },
  };

  for (const original of work.filter((r) => (ORIGINAL_ROLES as readonly string[]).includes(r.role))) {
    const outcome = await processOriginal(ctx, original);
    if (outcome !== "ok") return empty(outcome, round);
  }

  const after = await loadRefs(db, root);
  const failed = after.filter((r) => r.archiveStatus === "failed");
  const count = (c: string) => failed.filter((r) => classifyMediaFailure(r.lastErrorCode) === c).length;
  const result: MediaRunResult = {
    kind: "done",
    round,
    archived: ctx.tally.archived,
    carriedForward: ctx.tally.carriedForward,
    failedRetryable: count("retryable"),
    failedTerminal: count("terminal") + count("unknown"),
    needsFreshUrl: count("needs_fresh_url"),
  };
  // 子任务本身成功：媒资失败是警告，不回滚结构化结果，也不让子任务失败
  const fin = await withFences(db, clock, [{ taskId: child.taskId, token: claim.token }], async (tx, tasks) => {
    await tx
      .update(syncTasks)
      .set({
        status: "succeeded",
        attemptCount: round,
        leaseOwner: null,
        leaseExpiresAt: null,
        stopReason: "media_round_done",
        resultSummary: { round, archived: result.archived, carried_forward: result.carriedForward, failed_retryable: result.failedRetryable, failed_terminal: result.failedTerminal, needs_fresh_url: result.needsFreshUrl },
        finishedAt: clock.now(),
        updatedAt: clock.now(),
      })
      .where(eq(syncTasks.taskId, tasks.get(child.taskId)!.taskId));
    await settleBatchOf(tx, root.batchId, clock.now());
  });
  return fin.ok ? result : empty(fin.reason === "cancelled" ? "cancelled" : "stale", round);
}

// ───────────────────────── 工作项判定 ─────────────────────────

const isOriginal = (r: RefRow) => (ORIGINAL_ROLES as readonly string[]).includes(r.role);
const normalizedOf = (r: RefRow, all: RefRow[]) =>
  all.find((n) => n.role === NORMALIZED_OF[r.role as OriginalRole] && n.slotIndex === r.slotIndex && n.profileSnapshotId === r.profileSnapshotId && n.contentSnapshotId === r.contentSnapshotId);

/** 只在原始引用上判断：待下载 / 可重试的失败 / 已归档但衍生图缺失或可重试地失败。 */
function needsWork(r: RefRow, all: RefRow[]): boolean {
  if (!isOriginal(r)) return false;
  if (r.archiveStatus === "pending") return true;
  if (r.archiveStatus === "failed") return classifyMediaFailure(r.lastErrorCode) === "retryable";
  if (r.archiveStatus === "archived") {
    const n = normalizedOf(r, all);
    return !n || (n.archiveStatus === "failed" && classifyMediaFailure(n.lastErrorCode) === "retryable");
  }
  return false; // carried_forward 已经是本轮的终态
}

async function loadRefs(db: Db, root: TaskRow): Promise<RefRow[]> {
  const p = await db
    .select({ r: mediaReferences })
    .from(mediaReferences)
    .innerJoin(accountProfileSnapshots, eq(accountProfileSnapshots.profileSnapshotId, mediaReferences.profileSnapshotId))
    .where(and(eq(accountProfileSnapshots.batchId, root.batchId), eq(accountProfileSnapshots.accountId, root.accountId!)));
  const c = await db
    .select({ r: mediaReferences })
    .from(mediaReferences)
    .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
    .innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId))
    .where(and(eq(contentSnapshots.batchId, root.batchId), eq(contents.accountId, root.accountId!)));
  return [...p, ...c].map((x) => x.r).sort((a, b) => (a.mediaReferenceId < b.mediaReferenceId ? -1 : 1));
}

async function mediaTasks(db: Db, rootId: bigint): Promise<TaskRow[]> {
  return db.select().from(syncTasks).where(and(eq(syncTasks.parentTaskId, rootId), eq(syncTasks.requestedAction, "download_media"))).orderBy(syncTasks.taskId);
}

async function createRound(db: Db, clock: Clock, root: TaskRow, round: number): Promise<TaskRow> {
  const key = jcsSha256({ kind: "tracer_media", root_task_id: root.taskId.toString(), round });
  const now = clock.now();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(syncTasks).values({
        batchId: root.batchId,
        parentTaskId: root.taskId,
        providerId: root.providerId,
        platformId: root.platformId,
        assignmentId: root.assignmentId,
        accountId: root.accountId,
        requestedAction: "download_media",
        subjectType: "external_account",
        subjectId: root.accountId,
        taskParameters: { schema_version: MEDIA_TASK_PARAMETERS_VERSION, round },
        idempotencyKey: key,
        status: "pending",
        attemptCount: 0,
        maxAttempts: MAX_ROUNDS,
        expiresAt: root.expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      await settleBatchOf(tx, root.batchId, now); // 有未终态任务时批次回到 running
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
  const [row] = await db.select().from(syncTasks).where(eq(syncTasks.idempotencyKey, key));
  return row!;
}

async function settleBatchOf(tx: DbTx, batchId: bigint, now: Date): Promise<void> {
  const tasks = await tx.select({ status: syncTasks.status }).from(syncTasks).where(eq(syncTasks.batchId, batchId));
  const done = new Set(["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"]);
  const allDone = tasks.every((t) => done.has(t.status));
  const bad = tasks.filter((t) => t.status === "failed" || t.status === "dead").length;
  const ok = tasks.filter((t) => t.status === "succeeded" || t.status === "succeeded_with_gap").length;
  const status = !allDone ? "running" : bad === 0 ? "succeeded" : ok === 0 ? "failed" : "partial_succeeded";
  await tx.update(syncBatches).set({ status, plannedTaskCount: tasks.length, succeededTaskCount: ok, failedTaskCount: bad, updatedAt: now }).where(eq(syncBatches.batchId, batchId));
}

// ───────────────────────── 单个引用 ─────────────────────────

type StepOutcome = "ok" | "stale" | "cancelled";

async function processOriginal(ctx: Ctx, ref: RefRow): Promise<StepOutcome> {
  const { deps } = ctx;
  const needsDownload = ref.archiveStatus === "pending" || ref.archiveStatus === "failed";
  const policy = deps.policy ?? DEFAULT_MEDIA_POLICY;

  let bytes: Uint8Array;
  let mime: string;
  let originalSha: string;
  let fresh = false; // 本次是否新下载
  if (needsDownload) {
    if (ref.sourceLocator === null) return commitFailure(ctx, ref, "no_source_locator");
    let dl;
    for (let attempt = 1; ; attempt++) {
      try {
        dl = await downloadBounded(deps.transport, ref.sourceLocator, policy);
        break;
      } catch (e) {
        const code = e instanceof MediaFailure ? e.code : "transport_error";
        if (classifyMediaFailure(code) === "retryable" && attempt < IN_RUN_ATTEMPTS) continue; // 同一 URL 仍有效：有界重试
        return commitFailure(ctx, ref, code);
      }
    }
    bytes = dl.bytes;
    mime = dl.mimeType;
    originalSha = hex(bytes);
    fresh = true;
  } else {
    // 已归档，只补衍生图：从正式媒资桶读回原图，不重新下载
    const [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.mediaAssetId, ref.mediaAssetId!));
    const [obj] = await deps.db.select().from(ossObjects).where(eq(ossObjects.ossObjectId, asset!.ossObjectId));
    const stored = await deps.mediaStore.get(obj!.objectKey);
    if (!stored || hex(stored) !== asset!.sha256.toString("hex")) return commitDerivativeFailure(ctx, ref, "transport_error");
    bytes = stored;
    mime = asset!.mimeType;
    originalSha = asset!.sha256.toString("hex");
  }

  // 原图：内容寻址，已有同字节资产就不再写对象
  if (fresh && !(await assetBySha(deps.db, originalSha))) {
    try {
      await putVerified(deps.mediaStore, mediaKey(originalSha), bytes);
    } catch (e) {
      return commitFailure(ctx, ref, e instanceof MediaFailure ? e.code : "transport_error");
    }
  }

  // 衍生图：优先复用已有的（同一份原图的衍生图与引用角色无关），否则转换一次（同一次运行内按 SHA 记忆）
  let derived: { sha: string; bytes: Uint8Array | null; width: number; height: number } | { failure: MediaFailureCode };
  const existing = await existingDerivative(deps.db, originalSha);
  if (existing) derived = existing;
  else {
    const memo = ctx.derivedMemo.get(originalSha);
    if (memo) derived = { sha: memo.sha, bytes: memo.bytes, width: memo.width, height: memo.height };
    else {
      try {
        const out = await deps.converter.toNormalizedJpeg({ bytes, mimeType: mime });
        if (sniffImage(out.bytes) !== "image/jpeg") throw new ConverterError("unsupported", "转换结果不是 JPEG");
        const sha = hex(out.bytes);
        if (!(await assetBySha(deps.db, sha))) await putVerified(deps.mediaStore, mediaKey(sha), out.bytes);
        ctx.derivedMemo.set(originalSha, { ...out, sha });
        derived = { sha, bytes: out.bytes, width: out.width, height: out.height };
      } catch (e) {
        derived = { failure: e instanceof ConverterError && e.kind === "unsupported" ? "convert_failed" : "converter_unavailable" };
      }
    }
  }

  await deps.hooks?.beforeRefCommit?.();

  const r = await withFences(deps.db, deps.clock, [{ taskId: ctx.child.taskId, token: ctx.token }], async (tx) => {
    const now = deps.clock.now();
    let originalAssetId = ref.mediaAssetId;
    if (fresh) {
      originalAssetId = await ensureAsset(tx, deps, { sha: originalSha, byteLength: bytes.byteLength, mime, width: null, height: null, now });
      await tx
        .update(mediaReferences)
        .set({ archiveStatus: "archived", mediaAssetId: originalAssetId, isCarriedForward: false, lastErrorCode: null, updatedAt: now })
        .where(eq(mediaReferences.mediaReferenceId, ref.mediaReferenceId));
    }
    if ("failure" in derived) {
      await upsertNormalized(tx, ref, { status: "failed", assetId: null, error: derived.failure, carried: false }, now);
      await recordMediaIssue(tx, ctx, ref, derived.failure, { derivative: true });
    } else {
      const assetId = await ensureAsset(tx, deps, { sha: derived.sha, byteLength: derived.bytes?.byteLength ?? 0, mime: "image/jpeg", width: derived.width, height: derived.height, now, knownOnly: derived.bytes === null });
      await upsertNormalized(tx, ref, { status: "archived", assetId, error: null, carried: false }, now);
    }
  });
  if (!r.ok) return fenceOutcome(r);
  if (fresh) ctx.tally.archived++;
  return "ok";
}

const fenceOutcome = (r: Extract<Fenced<unknown>, { ok: false }>): StepOutcome => (r.reason === "cancelled" ? "cancelled" : "stale");

/** R19.4：媒资失败（含续用旧资产的本轮失败）留一条可查询的质量问题；指纹含引用 ID 与错误码，同批次重放不重复。 */
async function recordMediaIssue(tx: DbTx, ctx: Ctx, ref: RefRow, code: string, extra: Record<string, unknown>): Promise<void> {
  await recordIssue(tx, {
    code: "media_archive_failed",
    severity: "warning",
    batchId: ctx.root.batchId,
    accountId: ctx.root.accountId,
    entityType: "media_reference",
    entityId: ref.mediaReferenceId,
    discriminator: `${ref.mediaReferenceId}:${ref.role}:${code}`,
    detail: { role: ref.role, slot_index: ref.slotIndex, error_code: code, ...extra },
    now: ctx.deps.clock.now(),
  });
}

/** 下载失败：有上一快照的已验证资产就续用，否则标记失败。 */
async function commitFailure(ctx: Ctx, ref: RefRow, code: MediaFailureCode): Promise<StepOutcome> {
  const { deps } = ctx;
  const prior = await priorVerified(ctx, ref, ref.role);
  const priorNorm = prior ? await priorVerified(ctx, ref, NORMALIZED_OF[ref.role as OriginalRole], prior) : null;
  const r = await withFences(deps.db, deps.clock, [{ taskId: ctx.child.taskId, token: ctx.token }], async (tx) => {
    const now = deps.clock.now();
    if (prior) {
      await tx
        .update(mediaReferences)
        .set({ archiveStatus: "carried_forward", mediaAssetId: prior.mediaAssetId, isCarriedForward: true, lastErrorCode: code, updatedAt: now })
        .where(eq(mediaReferences.mediaReferenceId, ref.mediaReferenceId));
      if (priorNorm) await upsertNormalized(tx, ref, { status: "carried_forward", assetId: priorNorm.mediaAssetId, error: code, carried: true }, now);
      await recordMediaIssue(tx, ctx, ref, code, { carried_forward: true });
    } else {
      await tx
        .update(mediaReferences)
        .set({ archiveStatus: "failed", mediaAssetId: null, isCarriedForward: false, lastErrorCode: code, updatedAt: now })
        .where(eq(mediaReferences.mediaReferenceId, ref.mediaReferenceId));
      await recordMediaIssue(tx, ctx, ref, code, { carried_forward: false });
    }
  });
  if (!r.ok) return fenceOutcome(r);
  if (prior) ctx.tally.carriedForward += priorNorm ? 2 : 1;
  return "ok";
}

async function commitDerivativeFailure(ctx: Ctx, ref: RefRow, code: MediaFailureCode): Promise<StepOutcome> {
  const { deps } = ctx;
  const r = await withFences(deps.db, deps.clock, [{ taskId: ctx.child.taskId, token: ctx.token }], async (tx) => {
    await upsertNormalized(tx, ref, { status: "failed", assetId: null, error: code, carried: false }, deps.clock.now());
    await recordMediaIssue(tx, ctx, ref, code, { derivative: true });
  });
  return r.ok ? "ok" : fenceOutcome(r);
}

// ───────────────────────── 资产与引用写入 ─────────────────────────

async function assetBySha(db: Db | DbTx, sha: string) {
  const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.sha256, Buffer.from(sha, "hex")));
  return row;
}

/** 内容寻址的正式资产：同字节只一份。已存在直接复用（不重复写对象行）。 */
async function ensureAsset(
  tx: DbTx,
  deps: MediaArchiveDeps,
  a: { sha: string; byteLength: number; mime: string; width: number | null; height: number | null; now: Date; knownOnly?: boolean },
): Promise<bigint> {
  const found = await assetBySha(tx, a.sha);
  if (found) return found.mediaAssetId;
  if (a.knownOnly) throw new Error("资产应已存在");
  const [obj] = await tx.insert(ossObjects).values({
    objectCategory: "media",
    providerCode: deps.location.providerCode,
    region: deps.location.region,
    bucket: deps.location.bucket,
    objectKey: mediaKey(a.sha),
    byteLength: BigInt(a.byteLength),
    sha256: Buffer.from(a.sha, "hex"),
    contentType: a.mime,
    storageClass: "Standard",
    encryptionMode: "SSE-OSS",
    status: "available",
    verifiedAt: a.now,
    createdAt: a.now,
    updatedAt: a.now,
  });
  const [asset] = await tx.insert(mediaAssets).values({
    sha256: Buffer.from(a.sha, "hex"),
    byteLength: BigInt(a.byteLength),
    mediaKind: "image",
    mimeType: a.mime,
    width: a.width,
    height: a.height,
    ossObjectId: BigInt(obj.insertId),
    verificationStatus: "verified",
    verifiedAt: a.now,
    createdAt: a.now,
  });
  return BigInt(asset.insertId);
}

async function upsertNormalized(
  tx: DbTx,
  original: RefRow,
  n: { status: "archived" | "failed" | "carried_forward"; assetId: bigint | null; error: string | null; carried: boolean },
  now: Date,
): Promise<void> {
  const role = NORMALIZED_OF[original.role as OriginalRole];
  const snapshotMatch = original.profileSnapshotId !== null ? eq(mediaReferences.profileSnapshotId, original.profileSnapshotId) : eq(mediaReferences.contentSnapshotId, original.contentSnapshotId!);
  const [existing] = await tx.select().from(mediaReferences).where(and(snapshotMatch, eq(mediaReferences.role, role), eq(mediaReferences.slotIndex, original.slotIndex)));
  const fields = { archiveStatus: n.status, mediaAssetId: n.assetId, isCarriedForward: n.carried, lastErrorCode: n.error, updatedAt: now };
  if (existing) {
    await tx.update(mediaReferences).set(fields).where(eq(mediaReferences.mediaReferenceId, existing.mediaReferenceId));
    return;
  }
  await tx.insert(mediaReferences).values({
    profileSnapshotId: original.profileSnapshotId,
    contentSnapshotId: original.contentSnapshotId,
    role,
    slotIndex: original.slotIndex,
    sourceLocator: null, // 衍生图没有源地址：它由原图生成
    sourceLocatorSha256: null,
    sourceJsonPath: original.sourceJsonPath,
    observedAt: original.observedAt,
    sourceProviderCallId: original.sourceProviderCallId,
    createdAt: now,
    ...fields,
  });
}

/** 同一份原图（按资产）已经生成过的衍生图：复用，不再转换。 */
async function existingDerivative(db: Db, originalSha: string) {
  const original = await assetBySha(db, originalSha);
  if (!original) return null;
  const o = alias(mediaReferences, "o");
  const n = alias(mediaReferences, "n");
  const [row] = await db
    .select({ assetId: n.mediaAssetId })
    .from(o)
    .innerJoin(
      n,
      and(
        sql`${n.profileSnapshotId} <=> ${o.profileSnapshotId}`,
        sql`${n.contentSnapshotId} <=> ${o.contentSnapshotId}`,
        eq(n.slotIndex, o.slotIndex),
        sql`${n.role} = CONCAT(${o.role}, '_normalized')`,
      ),
    )
    .where(and(eq(o.mediaAssetId, original.mediaAssetId), eq(n.archiveStatus, "archived"), eq(n.isCarriedForward, false)))
    .limit(1);
  if (!row?.assetId) return null;
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.mediaAssetId, row.assetId));
  return asset ? { sha: asset.sha256.toString("hex"), bytes: null, width: asset.width ?? 0, height: asset.height ?? 0 } : null;
}

/** 上一快照里同角色同槽位、已有已验证资产的引用（按批次逻辑时间向前找最近的一条）。 */
async function priorVerified(ctx: Ctx, ref: RefRow, role: string, requireSameBatchOf?: RefRow): Promise<RefRow | null> {
  const { db } = ctx.deps;
  const { logicalAt, batchId } = ctx.batchOrder;
  const older = (b: typeof syncBatches) => or(sql`${b.logicalAt} < ${logicalAt}`, and(sql`${b.logicalAt} = ${logicalAt}`, sql`${b.batchId} < ${batchId}`));
  if (ref.profileSnapshotId !== null) {
    const [snap] = await db.select().from(accountProfileSnapshots).where(eq(accountProfileSnapshots.profileSnapshotId, ref.profileSnapshotId));
    const rows = await db
      .select({ r: mediaReferences, logicalAt: syncBatches.logicalAt, batchId: syncBatches.batchId })
      .from(mediaReferences)
      .innerJoin(accountProfileSnapshots, eq(accountProfileSnapshots.profileSnapshotId, mediaReferences.profileSnapshotId))
      .innerJoin(syncBatches, eq(syncBatches.batchId, accountProfileSnapshots.batchId))
      .where(and(eq(accountProfileSnapshots.accountId, snap!.accountId), eq(mediaReferences.role, role), eq(mediaReferences.slotIndex, ref.slotIndex), sql`${mediaReferences.mediaAssetId} IS NOT NULL`, older(syncBatches)))
      .orderBy(sql`${syncBatches.logicalAt} DESC`, sql`${syncBatches.batchId} DESC`);
    return pick(rows, requireSameBatchOf);
  }
  const [snap] = await db.select().from(contentSnapshots).where(eq(contentSnapshots.contentSnapshotId, ref.contentSnapshotId!));
  const rows = await db
    .select({ r: mediaReferences, logicalAt: syncBatches.logicalAt, batchId: syncBatches.batchId })
    .from(mediaReferences)
    .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
    .innerJoin(syncBatches, eq(syncBatches.batchId, contentSnapshots.batchId))
    .where(and(eq(contentSnapshots.contentId, snap!.contentId), eq(mediaReferences.role, role), eq(mediaReferences.slotIndex, ref.slotIndex), sql`${mediaReferences.mediaAssetId} IS NOT NULL`, older(syncBatches)))
    .orderBy(sql`${syncBatches.logicalAt} DESC`, sql`${syncBatches.batchId} DESC`);
  return pick(rows, requireSameBatchOf);
}

/** 衍生图续用时要和被续用的原图来自同一个旧快照；否则取最近的。 */
function pick(rows: Array<{ r: RefRow }>, sameSnapshotAs?: RefRow): RefRow | null {
  if (sameSnapshotAs) {
    const same = rows.find((x) => x.r.profileSnapshotId === sameSnapshotAs.profileSnapshotId && x.r.contentSnapshotId === sameSnapshotAs.contentSnapshotId);
    return same?.r ?? null;
  }
  return rows[0]?.r ?? null;
}

/** 上传并读回校验（内容寻址，重复写同一个 key 是幂等的）。 */
async function putVerified(store: ObjectStore, key: string, bytes: Uint8Array): Promise<void> {
  const sha = hex(bytes);
  const stored = await store.put(key, bytes);
  if (stored.sha256 !== sha || stored.byteLength !== bytes.byteLength) {
    await store.delete(key).catch(() => undefined);
    throw new MediaFailure("transport_error", "媒资对象写入后的摘要或长度不一致");
  }
  const back = await store.get(key);
  if (!back || hex(back) !== sha) {
    await store.delete(key).catch(() => undefined);
    throw new MediaFailure("transport_error", "媒资对象读回校验失败");
  }
}
