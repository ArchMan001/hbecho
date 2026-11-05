// download_media（按需的视频 / 音频，FS-11.5–11.9；design §7.10）。
//
// 视频：有序候选来源逐个尝试（一个失败——含过期——换下一个，全部失败才算失败）→ 流式写临时文件并边写边算 SHA-256 →
//       分片上传正式媒资桶 → 一个短 fenced 事务写资产（UQ(sha256) 命中则复用）与引用。内存只占一块，临时文件在 finally 里删除。
// 音频：只在视频入库之后；短期签名 URL → Python 能力服务抽取 → 独立正式资产。无音轨 = no_audio_track 终态（informational）。
// 地址过期：下一次尝试先重新取详情拿新地址（有界，受任务额度约束），绝不复用过期地址。
// 网络 IO（下载、上传、能力服务）期间不持有数据库事务。
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "../../db/client";
import { contents, contentSnapshots, mediaAssets, mediaReferences, ossObjects, syncBatches, syncTasks } from "../../db/schema";
import { sha256Utf8 } from "../canonical-json";
import {
  ConverterError,
  DEFAULT_VIDEO_POLICY,
  assetBySha,
  downloadVideoToFile,
  ensureAsset,
  sha256Hex as hex,
  mediaKey,
  priorVerified,
  putVerified,
  type ArchiveCtx,
  type MediaPolicy,
  type RefRow,
} from "../media-archive";
import { MediaFailure, classifyMediaFailure, type MediaFailureCode } from "../media-failure";
import { withFences } from "../orchestrator";
import { recordIssue } from "../projection";
import { rankVideoSources } from "../provider-adapter";
import { platformCodeOf } from "./account-deps";
import { requestDetail } from "./detail-runner";
import { failureCodeOfMedia } from "./media-map";
import type { MediaRunnerDeps } from "./media-deps";
import type { RunnerOutcome, TaskContext, TaskRunner } from "./types";

export const MEDIA_VIDEO_SCHEMA = "sync-media-video-task.v1";
const paramsSchema = z.looseObject({
  schema_version: z.literal(MEDIA_VIDEO_SCHEMA),
  content_id: z.string().regex(/^[1-9]\d*$/),
  content_snapshot_id: z.string().regex(/^[1-9]\d*$/),
  roles: z.array(z.enum(["video", "audio"])).min(1),
  sources: z.array(z.string()),
  detail_mode: z.enum(["synchronous", "asynchronous"]),
});
const SIGNED_URL_TTL_SECONDS = 600;

type Role = "video" | "audio";
interface StoredVideo {
  assetId: bigint;
  objectKey: string;
  byteLength: number;
}

/** 失败码的取舍：同一任务里有多个来源各自失败时，最值得下一步行动的优先——可重试的 > 需要新地址的 > 终态的（取最后一个）。 */
export function pickFailure(codes: readonly MediaFailureCode[]): MediaFailureCode {
  return codes.find((c) => classifyMediaFailure(c) === "retryable") ?? codes.find((c) => classifyMediaFailure(c) === "needs_fresh_url") ?? codes[codes.length - 1] ?? "no_source_locator";
}

async function existingVideo(db: Db | DbTx, contentId: bigint): Promise<StoredVideo | null> {
  const [row] = await db
    .select({ assetId: mediaAssets.mediaAssetId, byteLength: mediaAssets.byteLength, objectKey: ossObjects.objectKey })
    .from(mediaReferences)
    .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
    .innerJoin(mediaAssets, eq(mediaAssets.mediaAssetId, mediaReferences.mediaAssetId))
    .innerJoin(ossObjects, eq(ossObjects.ossObjectId, mediaAssets.ossObjectId))
    .where(and(eq(contentSnapshots.contentId, contentId), eq(mediaReferences.role, "video"), eq(mediaAssets.mediaKind, "video")))
    .orderBy(mediaReferences.mediaReferenceId)
    .limit(1);
  return row ? { assetId: row.assetId, objectKey: row.objectKey, byteLength: Number(row.byteLength) } : null;
}

/** 本批次已入库的视频 / 音频总字节（单批次总字节上限用）。 */
async function batchBytes(db: Db, batchId: bigint): Promise<number> {
  const rows = await db
    .select({ n: mediaAssets.byteLength })
    .from(mediaReferences)
    .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
    .innerJoin(mediaAssets, eq(mediaAssets.mediaAssetId, mediaReferences.mediaAssetId))
    .where(and(eq(contentSnapshots.batchId, batchId), eq(mediaReferences.archiveStatus, "archived")));
  return rows.reduce((a, r) => a + Number(r.n), 0);
}

export function createVideoRunner(deps: MediaRunnerDeps): TaskRunner {
  const { db, clock } = deps;
  return async (ctx: TaskContext): Promise<RunnerOutcome> => {
    const task = ctx.task;
    const parsed = paramsSchema.safeParse(task.taskParameters);
    if (!parsed.success || task.contentId === null || task.accountId === null || BigInt(parsed.data.content_id) !== task.contentId) return { kind: "failure", code: "task_parameters_invalid" };
    const params = parsed.data;
    const contentId = task.contentId;
    const accountId = task.accountId;
    const snapshotId = BigInt(params.content_snapshot_id);
    const platform = await platformCodeOf(db, task.platformId);
    if (!platform) return { kind: "failure", code: "unsupported_platform" };
    const [content] = await db.select().from(contents).where(eq(contents.contentId, contentId));
    const [batch] = await db.select().from(syncBatches).where(eq(syncBatches.batchId, task.batchId));
    if (!content || content.accountId !== accountId || !batch) return { kind: "failure", code: "task_parameters_invalid", detail: { reason: "content_or_batch_missing" } };

    const policy: MediaPolicy = { ...(deps.videoPolicy ?? DEFAULT_VIDEO_POLICY), maxBytes: Math.min(deps.mediaMaxBytes, (deps.videoPolicy ?? DEFAULT_VIDEO_POLICY).maxBytes) };
    const actx: ArchiveCtx = {
      deps: { db, clock, mediaStore: deps.mediaStore, location: deps.location, transport: deps.imageTransport, converter: deps.converter, workerId: "sync-worker" },
      scope: { batchId: task.batchId, accountId, platform },
      fence: { taskId: task.taskId, token: ctx.token },
      batchOrder: { logicalAt: batch.logicalAt, batchId: batch.batchId },
      derivedMemo: new Map(),
      tally: { archived: 0, carriedForward: 0 },
    };
    const abandon = (r: string): RunnerOutcome => ({ kind: "abandoned", reason: r === "cancelled" ? "cancelled" : "stale" });

    /** 写（或补）某角色的引用；返回引用行。video 引用在详情成功时已建好，音频引用在这里建。 */
    const upsertRef = async (tx: DbTx, role: Role, v: { status: "archived" | "failed" | "carried_forward"; assetId: bigint | null; error: string | null; carried: boolean; source?: string | null }, now: Date): Promise<RefRow> => {
      const [existing] = await tx.select().from(mediaReferences).where(and(eq(mediaReferences.contentSnapshotId, snapshotId), eq(mediaReferences.role, role), eq(mediaReferences.slotIndex, 0))).for("update");
      const fields = { archiveStatus: v.status, mediaAssetId: v.assetId, isCarriedForward: v.carried, lastErrorCode: v.error, updatedAt: now };
      if (existing) {
        await tx.update(mediaReferences).set(fields).where(eq(mediaReferences.mediaReferenceId, existing.mediaReferenceId));
        return { ...existing, ...fields };
      }
      const src = v.source ?? null;
      const [ins] = await tx.insert(mediaReferences).values({
        contentSnapshotId: snapshotId,
        role,
        slotIndex: 0,
        sourceLocator: role === "video" ? src : null,
        sourceLocatorSha256: role === "video" && src !== null ? sha256Utf8(src) : null,
        observedAt: now,
        createdAt: now,
        ...fields,
      });
      const [row] = await tx.select().from(mediaReferences).where(eq(mediaReferences.mediaReferenceId, BigInt(ins.insertId)));
      return row!;
    };

    /** 失败的落点：有上一份已验证资产就续用（carried_forward），否则 failed；留一条质量问题。informational（无音轨）不留问题。 */
    const recordFailure = async (role: Role, code: MediaFailureCode, extra: Record<string, unknown> = {}): Promise<RunnerOutcome | null> => {
      const informational = classifyMediaFailure(code) === "informational";
      const stub = { mediaReferenceId: 0n, role, slotIndex: 0, contentSnapshotId: snapshotId, profileSnapshotId: null } as unknown as RefRow;
      const prior = informational ? null : await priorVerified(actx, stub, role);
      const r = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
        const now = clock.now();
        const ref = prior
          ? await upsertRef(tx, role, { status: "carried_forward", assetId: prior.mediaAssetId, error: code, carried: true }, now)
          : await upsertRef(tx, role, { status: "failed", assetId: null, error: code, carried: false }, now);
        if (!informational) {
          await recordIssue(tx, { code: "media_archive_failed", severity: "warning", batchId: task.batchId, accountId, contentId, entityType: "media_reference", entityId: ref.mediaReferenceId, discriminator: `${ref.mediaReferenceId}:${role}:${code}`, detail: { role, error_code: code, carried_forward: prior !== null, ...extra }, now });
        }
      });
      return r.ok ? null : abandon(r.reason);
    };
    const fail = async (role: Role, codes: readonly MediaFailureCode[], extra: Record<string, unknown> = {}): Promise<RunnerOutcome> => {
      const code = pickFailure(codes);
      const stop = await recordFailure(role, code, { ...extra, tried: codes.length });
      return stop ?? { kind: "failure", code: failureCodeOfMedia(code), detail: { media_code: code, ...extra } };
    };

    await mkdir(deps.tmpDir, { recursive: true });
    const tmp = join(deps.tmpDir, `${task.taskId}.part`);
    try {
      // ── 视频 ──
      let video = await existingVideo(db, contentId);
      let videoOutcome: "reused" | "archived" = "reused";
      if (!video) {
        // 过期之后的重试：先重新取详情拿新地址（有界：受任务额度约束），不复用过期地址
        let sources = params.sources;
        if (task.lastErrorCode === "media_source_expired") {
          const d = await requestDetail(deps, ctx, { platform, mode: params.detail_mode, content: content });
          if (d.kind === "abandoned") return { kind: "abandoned", reason: d.reason };
          if (d.kind === "failed") return { kind: "failure", code: d.code, ...(d.detail ? { detail: d.detail } : {}) };
          sources = rankVideoSources(platform, d.data.downloadCandidates);
        }
        if (sources.length === 0) return fail("video", ["no_source_locator"]);

        let cap = policy.maxBytes;
        if (deps.batchMaxBytes !== null) {
          cap = Math.min(cap, deps.batchMaxBytes - (await batchBytes(db, task.batchId)));
          if (cap <= 0) return fail("video", ["too_large"], { reason: "batch_bytes_exhausted" });
        }
        const failures: MediaFailureCode[] = [];
        let got: Awaited<ReturnType<typeof downloadVideoToFile>> | null = null;
        for (const src of sources) {
          const hb = await ctx.heartbeat();
          if (hb !== "ok") return abandon(hb);
          if (ctx.shouldStop()) return { kind: "abandoned", reason: "shutdown" };
          try {
            got = await downloadVideoToFile(deps.videoTransport, src, { ...policy, maxBytes: cap }, tmp);
            break;
          } catch (e) {
            failures.push(e instanceof MediaFailure ? e.code : "transport_error");
          }
        }
        if (!got) return fail("video", failures);

        // 上传（内容寻址：同字节同 key；已有同字节资产就不再上传，UQ(sha256) 复用）
        const dl = got;
        if (!(await assetBySha(db, dl.sha256))) {
          try {
            const stored = await deps.mediaStore.putFile(mediaKey(dl.sha256), tmp);
            if (stored.sha256 !== dl.sha256 || stored.byteLength !== dl.byteLength) throw new MediaFailure("transport_error", "上传后的摘要或长度与下载时不一致");
          } catch (e) {
            return fail("video", [e instanceof MediaFailure ? e.code : "transport_error"]);
          }
        }
        const saved = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
          const now = clock.now();
          const assetId = await ensureAsset(tx, deps, { sha: dl.sha256, byteLength: dl.byteLength, mime: dl.mimeType, width: null, height: null, now, kind: "video" });
          await upsertRef(tx, "video", { status: "archived", assetId, error: null, carried: false, source: sources[0] ?? null }, now);
          return assetId;
        });
        if (!saved.ok) return abandon(saved.reason);
        video = await existingVideo(db, contentId);
        videoOutcome = "archived";
      }
      if (!video) throw new Error("视频入库后读不回资产");

      // ── 音频：只在视频入库之后 ──
      let audioOutcome: "archived" | "no_audio_track" | "reused" | null = null;
      if (params.roles.includes("audio")) {
        const [have] = await db
          .select({ id: mediaReferences.mediaReferenceId })
          .from(mediaReferences)
          .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
          .where(and(eq(contentSnapshots.contentId, contentId), eq(mediaReferences.role, "audio"), eq(mediaReferences.archiveStatus, "archived")))
          .limit(1);
        if (have) audioOutcome = "reused";
        else {
          const hb = await ctx.heartbeat();
          if (hb !== "ok") return abandon(hb);
          // 音频字节上限 = 源视频字节数（-c:a copy 不会比源更大）与 HBECHO_MEDIA_MAX_BYTES 的较小者
          const maxBytes = Math.min(video.byteLength, deps.mediaMaxBytes);
          let out;
          try {
            out = await deps.capability.extractAudio({ sourceUrl: await deps.mediaStore.signedGetUrl(video.objectKey, SIGNED_URL_TTL_SECONDS), maxBytes });
          } catch (e) {
            // 能力服务不可用是可重试的（视频已入库，下一次尝试只重做音频）
            return fail("audio", [e instanceof ConverterError && e.kind === "unsupported" ? "convert_failed" : "converter_unavailable"]);
          }
          if (out.kind === "no_audio_track") {
            const stop = await recordFailure("audio", "no_audio_track");
            if (stop) return stop;
            audioOutcome = "no_audio_track";
          } else {
            if (out.bytes.byteLength > maxBytes) return fail("audio", ["too_large"]);
            const sha = hex(out.bytes);
            try {
              if (!(await assetBySha(db, sha))) await putVerified(deps.mediaStore, mediaKey(sha), out.bytes);
            } catch (e) {
              return fail("audio", [e instanceof MediaFailure ? e.code : "transport_error"]);
            }
            const saved = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
              const now = clock.now();
              const assetId = await ensureAsset(tx, deps, { sha, byteLength: out.bytes.byteLength, mime: "audio/mp4", width: null, height: null, now, kind: "audio", durationMs: out.durationMs });
              await upsertRef(tx, "audio", { status: "archived", assetId, error: null, carried: false }, now);
            });
            if (!saved.ok) return abandon(saved.reason);
            audioOutcome = "archived";
          }
        }
      }

      const done = await withFences(db, clock, [{ taskId: task.taskId, token: ctx.token }], async (tx) => {
        const now = clock.now();
        await tx
          .update(syncTasks)
          .set({
            status: "succeeded",
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            resultSummary: { schema: "video-media-result.v1", video: videoOutcome, audio: audioOutcome, video_media_asset_id: video!.assetId.toString(), video_bytes: video!.byteLength },
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(syncTasks.taskId, task.taskId));
      });
      return done.ok ? { kind: "done" } : abandon(done.reason);
    } finally {
      await rm(tmp, { force: true }); // 无论成功、失败还是中止都删除临时文件
    }
  };
}
