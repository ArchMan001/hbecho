// c-signals 的测试挂具：特征行 / 监控段工厂、媒资引用工厂、FakeAiGateway、FakeMatcher、查询计数器。
// 只填 NOT NULL 字段，其余由各测试按需覆盖。FakeObjectStore / FakeClock 沿用 fake-oss.ts / fake-clock.ts。
import type { Db, QueryLogger } from "../../src/db/client";
import { contentFeatures, mediaReferences, monitoringSegments } from "../../src/db/schema";
import { sha } from "./factories";
import type { ImageMatcher, MatchRequest, MatchResult } from "../../src/modules/signals/scoring/ports";
import { MatcherError } from "../../src/modules/signals/scoring/ports";
import type { AiGatewayPort, JudgeRequest, JudgeResult, ModelPurpose, TranscribeRequest, TranscribeResult } from "../../src/modules/signals/speech/ports";

export const SIGNALS_T0 = new Date("2026-11-12T02:00:00.000000Z");

type FeatureInsert = typeof contentFeatures.$inferInsert;
/** 一个三信号都 valid 的内容特征行；over 覆盖任意列（改了值状态时要同时改 signals 信封，数据库 CHECK 会检查一致）。 */
export async function insertFeature(db: Db, f: { contentId: bigint; snapshotId: bigint; now?: Date; over?: Partial<FeatureInsert> }): Promise<void> {
  const now = f.now ?? SIGNALS_T0;
  const at = now.toISOString();
  const env = (state: "valid" | "failed", cap = "text.normalize") => ({ state, cap, ver: 1, nv: 1, at });
  await db.insert(contentFeatures).values({
    contentId: f.contentId,
    contentSnapshotId: f.snapshotId,
    textMaterialSha256: sha("material"),
    titleNormalized: "标题",
    bodyNormalized: "",
    hashtags: [],
    signals: { "text.title_normalized": env("valid"), "text.body_normalized": env("valid"), "text.hashtags": env("valid", "text.hashtags.douyin") },
    createdAt: now,
    updatedAt: now,
    ...f.over,
  });
}

type SegmentInsert = typeof monitoringSegments.$inferInsert;
export async function insertSegment(db: Db, s: { planId: bigint; version?: number; platform?: "douyin" | "xiaohongshu" | "kuaishou"; status?: "draft" | "published"; now?: Date; over?: Partial<SegmentInsert> }): Promise<void> {
  const now = s.now ?? SIGNALS_T0;
  const status = s.status ?? "draft";
  await db.insert(monitoringSegments).values({
    planId: s.planId,
    version: s.version ?? 1,
    platformCode: s.platform ?? "douyin",
    status,
    items: [],
    createdByActor: "user:test",
    publishedAt: status === "published" ? now : null,
    createdAt: now,
    updatedAt: now,
    ...s.over,
  });
}

/** A 域媒资引用（内容快照或主页快照上）。archived 需要给 mediaAssetId；carried_forward 同样（并带错误码）。 */
export async function insertMediaReference(
  db: Db,
  r: { contentSnapshotId?: bigint; profileSnapshotId?: bigint; role: "cover" | "avatar" | "background" | "audio"; status: "pending" | "archived" | "carried_forward" | "failed"; mediaAssetId?: bigint; slotIndex?: number; now?: Date },
): Promise<bigint> {
  const now = r.now ?? SIGNALS_T0;
  const [res] = await db.insert(mediaReferences).values({
    contentSnapshotId: r.contentSnapshotId ?? null,
    profileSnapshotId: r.profileSnapshotId ?? null,
    role: r.role,
    slotIndex: r.slotIndex ?? 0,
    observedAt: now,
    archiveStatus: r.status,
    mediaAssetId: r.status === "pending" || r.status === "failed" ? null : (r.mediaAssetId ?? null),
    isCarriedForward: r.status === "carried_forward",
    lastErrorCode: r.status === "carried_forward" || r.status === "failed" ? "download_failed" : null,
    createdAt: now,
    updatedAt: now,
  });
  return BigInt(res.insertId);
}

/** 查询计数器：传给 createDb 的 logger，断言「查询次数与主体数无关」「缺 Capability 时一次查询都没有」。 */
export class QueryCounter implements QueryLogger {
  count = 0;
  logQuery(): void {
    this.count++;
  }
}

/**
 * 可编程的 AI 网关：计费计数器、callKey 去重、可切换 activeModel。
 * 同一 callKey 第二次调用返回第一次的结果且 billed 不增加；calls 记录全部调用（含命中去重的）。
 */
export class FakeAiGateway implements AiGatewayPort {
  models: Record<ModelPurpose, string | null> = { asr: "asr-m1", judge: "judge-m1" };
  transcript: Omit<TranscribeResult, "model"> = { text: "转写文本", language: "zh", durationMs: 1000 };
  judgement: Omit<JudgeResult, "model"> = { verdict: "meets", reason: "符合" };
  /** 下一次调用抛出（调用后清空）；用来模拟瞬时错误。 */
  failNext: Error | null = null;
  billed = 0;
  readonly calls: Array<{ kind: "transcribe" | "judge"; callKey: string }> = [];
  private readonly done = new Map<string, TranscribeResult | JudgeResult>();

  async activeModel(purpose: ModelPurpose): Promise<string | null> {
    return this.models[purpose];
  }
  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    this.calls.push({ kind: "transcribe", callKey: req.callKey });
    return this.once(req.callKey, () => ({ ...this.transcript, model: this.models.asr ?? "asr-unset" }));
  }
  async judge(req: JudgeRequest): Promise<JudgeResult> {
    this.calls.push({ kind: "judge", callKey: req.callKey });
    return this.once(req.callKey, () => ({ ...this.judgement, model: this.models.judge ?? "judge-unset" }));
  }
  private once<T extends TranscribeResult | JudgeResult>(callKey: string, make: () => T): T {
    const hit = this.done.get(callKey);
    if (hit) return hit as T;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.billed++;
    const r = make();
    this.done.set(callKey, r);
    return r;
  }
}

/** 可编程的图片匹配器：默认返回固定分数；on() 为满足条件的请求指定分数或错误（先注册先匹配）。 */
export class FakeMatcher implements ImageMatcher {
  readonly requests: MatchRequest[] = [];
  private readonly rules: Array<{ when: (r: MatchRequest) => boolean; out: number | MatcherError }> = [];
  /** 回报的能力版本；改成与目录不同的值可模拟「Node 升了目录、Python 还是旧镜像」。 */
  capabilityVersion = 1;
  constructor(private readonly defaultScore = 8) {}

  on(when: (r: MatchRequest) => boolean, out: number | MatcherError): this {
    this.rules.push({ when, out });
    return this;
  }
  async match(req: MatchRequest): Promise<MatchResult> {
    this.requests.push(req);
    const out = this.rules.find((x) => x.when(req))?.out ?? this.defaultScore;
    if (out instanceof MatcherError) throw out;
    return { score: out, capability: { id: req.mode === "template" ? "image.template" : "image.element", version: this.capabilityVersion }, evidence: { good_matches: 10, inliers: 8 } };
  }
}
