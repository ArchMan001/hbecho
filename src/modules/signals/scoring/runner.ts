// 评分 runner（design §7.8）：读输入 → **事务外**调用能力服务 → 短事务带 fencing 写结果行。
// 失败分类（SG-D15）：瞬时失败（能力服务不可用 / 超时 / 来源 5xx / 版本不一致）重试，用尽 dead，**不写结果行**；
// 候选图的确定性失败（读不到 / 无法解码 / 太大）写 failed(image_unreadable) 结果行（3 个月）；
// 标准图（reference）侧的失败是配置错误，任务 dead，不污染候选对象的结果。
import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { segmentImages } from "../../../db/schema";
import type { Clock, MediaObjectStore } from "../../raw-capture";
import type { SignalAuditSink } from "../audit";
import { SERVICE_ACTOR } from "../authz";
import { requireSignal, versionOf } from "../catalog";
import type { SignalsConfig } from "../config";
import { createFacts } from "../facts";
import { redactUrls } from "../redact";
import { failDead, failTransient, claim, succeed, type Claimed, type QueueDeps } from "../tasks/queue";
import { failureExpiry, successExpiry } from "../ttl";
import { MatcherError, type ImageMatcher, type MatchResult } from "./ports";

export interface ScoreRunnerDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
  config: Pick<SignalsConfig, "scoreConcurrency" | "leaseMs" | "signedUrlTtlSeconds" | "retryBackoffMs" | "mediaMaxBytes">;
  /** A 的 media 桶（只读，签名 GET URL）。 */
  mediaStore: Pick<MediaObjectStore, "signedGetUrl">;
  /** signals 桶（标准图）。 */
  signalsStore: Pick<MediaObjectStore, "signedGetUrl">;
  matcher: ImageMatcher;
  workerId?: string;
}

/** 递归脱敏：证据里任何字符串都不得含签名 URL。 */
const scrub = <T>(v: T): T => JSON.parse(redactUrls(JSON.stringify(v))) as T;

type TaskParams = {
  signal_key: string;
  material_sha256: string;
  param_sha256: string;
  source: { media_asset_id: string };
  segment_image_id?: string;
  lineage: { plan_id: string; version: number; requested_by: string };
};

export function createScoreRunner(deps: ScoreRunnerDeps) {
  const q: QueueDeps = { db: deps.db, clock: deps.clock, audit: deps.audit };
  const facts = createFacts(deps.db);
  const workerId = deps.workerId ?? SERVICE_ACTOR;

  function resultRow(p: TaskParams, extra: { state: "valid"; score: number; evidence: unknown } | { state: "failed"; code: string; evidence: unknown }) {
    const entry = requireSignal(p.signal_key);
    const now = deps.clock.now();
    return {
      signalKey: p.signal_key,
      materialSha256: Buffer.from(p.material_sha256, "hex"),
      paramSha256: Buffer.from(p.param_sha256, "hex"),
      capabilityId: entry.capability,
      capabilityVersion: versionOf(entry.capability),
      state: extra.state,
      score: extra.state === "valid" ? extra.score.toFixed(2) : null,
      value: null,
      evidence: extra.evidence,
      failureCode: extra.state === "failed" ? extra.code : null,
      lineage: { plan_id: p.lineage.plan_id, version: p.lineage.version, requested_by: p.lineage.requested_by },
      producedAt: now,
      expiresAt: extra.state === "valid" ? successExpiry(now) : failureExpiry(now),
      createdAt: now,
    };
  }

  async function runOne(c: Claimed): Promise<"succeeded" | "retry_wait" | "dead" | "stale"> {
    const p = c.task.params as TaskParams;
    const mode = c.task.kind === "score_template" ? "template" : "element";
    const unreadable = async (detail: string) => {
      const r = await succeed(q, c, resultRow(p, { state: "failed", code: "image_unreadable", evidence: { failure_code: "image_unreadable", detail: scrub(detail) } }));
      return r.ok ? ("succeeded" as const) : ("stale" as const);
    };
    const transient = async (code: string, detail: string) => {
      const r = await failTransient(q, c, { code, detail: scrub(detail), backoffMs: deps.config.retryBackoffMs });
      return r.ok ? r.value : ("stale" as const);
    };
    const dead = async (reason: Parameters<typeof failDead>[2]["reason"], detail: string) => {
      const r = await failDead(q, c, { reason, detail: scrub(detail) });
      return r.ok ? ("dead" as const) : ("stale" as const);
    };

    // 1. 读输入（事务外）
    const assetId = BigInt(p.source.media_asset_id);
    const [img] = p.segment_image_id === undefined ? [] : await deps.db.select().from(segmentImages).where(eq(segmentImages.imageId, BigInt(p.segment_image_id)));
    if (!img) return dead("reference_unreadable", "标准图行不存在（监控段可能已清除）");
    const candidate = (await facts.mediaObjectOf([assetId])).get(assetId);
    if (!candidate) return unreadable("候选图对象不可用（A 的媒资行没有 available 的对象）");

    // 2. 事务外调用能力服务
    let res: MatchResult;
    try {
      const ttl = deps.config.signedUrlTtlSeconds;
      const [referenceUrl, candidateUrl] = [await deps.signalsStore.signedGetUrl(img.objectKey, ttl), await deps.mediaStore.signedGetUrl(candidate.objectKey, ttl)];
      res = await deps.matcher.match({ referenceUrl, candidateUrl, mode, maxBytes: deps.config.mediaMaxBytes });
    } catch (e) {
      if (!(e instanceof MatcherError)) return transient("runner_error", e instanceof Error ? e.message : String(e));
      switch (e.code) {
        case "invalid_request":
          return dead("invalid_request", e.message);
        case "input_too_large":
        case "unsupported_media_type":
        case "convert_failed":
        case "source_missing":
          if (e.side === "candidate") return unreadable(`${e.code}: ${e.message}`);
          if (e.side === "reference") return dead("reference_unreadable", `${e.code}: ${e.message}`);
          return transient(e.code, `${e.message}（响应没有指明出问题的一侧）`);
        default:
          return transient(e.code, e.message); // source_unavailable / unavailable / timeout
      }
    }

    // 3. 回报的能力必须与目录一致（防止「目录升了、Python 还是旧镜像」）：瞬时失败，不写结果
    const entry = requireSignal(p.signal_key);
    if (res.capability.id !== entry.capability || res.capability.version !== versionOf(entry.capability)) {
      return transient("capability_version_mismatch", `能力服务回报 ${res.capability.id}@${res.capability.version}，目录是 ${entry.capability}@${versionOf(entry.capability)}`);
    }

    // 4. 短事务 + fencing 写结果行
    const raw = scrub(res.evidence);
    const evidence = {
      raw,
      preprocess: (raw as { preprocess?: unknown }).preprocess ?? null,
      elapsed_ms: (raw as { elapsed_ms?: unknown }).elapsed_ms ?? null,
      engine: res.capability,
      source: { media_asset_id: p.source.media_asset_id, segment_image_id: p.segment_image_id ?? null },
    };
    const w = await succeed(q, c, resultRow(p, { state: "valid", score: res.score, evidence }));
    return w.ok ? "succeeded" : "stale";
  }

  /** 领取至多 scoreConcurrency 个评分任务并并发执行；返回处理的任务数。 */
  async function runBatch(): Promise<number> {
    const claimed = await claim(q, { workerId, leaseMs: deps.config.leaseMs, limit: deps.config.scoreConcurrency, kinds: ["score_template", "score_element"] });
    await Promise.all(claimed.map((c) => runOne(c)));
    return claimed.length;
  }
  return { runOne, runBatch };
}
export type ScoreRunner = ReturnType<typeof createScoreRunner>;
