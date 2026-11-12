// c-signals 的集成测试世界：真实 MySQL 上装配好的 createSignals（FakeMatcher / FakeObjectStore / FakeClock），
// 一个抖音监控段草稿（计划 1，模板封面标准图已上传），以及造主体（封面 / 音频）的工厂。
import { count } from "drizzle-orm";
import { signalResults, signalTasks } from "../../src/db/schema";
import { ConverterError, type ImageConverter } from "../../src/modules/media-archive";
import { createSignals } from "../../src/modules/signals/assemble";
import type { SignalAuditEvent } from "../../src/modules/signals/audit";
import { CAP_SCORE_REQUEST, CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, type SignalActor } from "../../src/modules/signals/authz";
import { DEFAULT_ENABLED_CAPABILITIES } from "../../src/modules/signals/catalog";
import { parseSignalsConfig } from "../../src/modules/signals/config";
import type { AiGatewayPort } from "../../src/modules/signals/speech/ports";
import type { TestDb } from "./db";
import { FakeClock } from "./fake-clock";
import { FakeObjectStore } from "./fake-oss";
import { insertAccount } from "./factories";
import { FakeMatcher, SIGNALS_T0 as T0, insertAvailableAsset, insertMediaReference, seedContent } from "./signals";

export const actor: SignalActor = { actor: "service:d", capabilities: new Set([CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, CAP_SCORE_REQUEST]), brandScope: "all" };
export const ENABLED = [...DEFAULT_ENABLED_CAPABILITIES, "image.template", "image.element", "speech.asr", "speech.judge"];
/** 测试用取值，不是推荐值。 */
export const config = (over: Record<string, string> = {}) =>
  parseSignalsConfig({
    HBECHO_SIGNALS_SCAN_INTERVAL_MS: "1000", HBECHO_SIGNALS_SCAN_BATCH: "100", HBECHO_SIGNALS_LOOKBACK_MS: "60000", HBECHO_SIGNALS_RECONCILE_INTERVAL_MS: "1000",
    HBECHO_SIGNALS_SCORE_CONCURRENCY: "4", HBECHO_SIGNALS_TASK_MAX_ATTEMPTS: "3", HBECHO_SIGNALS_RETRY_BACKOFF_MS: "1000", HBECHO_SIGNALS_LEASE_MS: "60000",
    HBECHO_SIGNALS_SIGNED_URL_TTL_S: "600", HBECHO_SIGNALS_MATCH_TIMEOUT_MS: "5000", HBECHO_SIGNALS_DEFER_INTERVAL_MS: "30000", HBECHO_SIGNALS_DEFER_MAX: "20",
    HBECHO_MEDIA_MAX_BYTES: "20971520", HBECHO_SIGNALS_ENABLED: ENABLED.join(","), ...over,
  });
export const converter: ImageConverter = {
  async toNormalizedJpeg({ bytes }) {
    if (Buffer.from(bytes).includes("UNDECODABLE")) throw new ConverterError("unsupported", "x");
    return { bytes: new Uint8Array([1]), width: 540, height: 360 };
  },
};
export const png = (seed: string): Uint8Array => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);

export async function createWorld(t: TestDb, o: { gateway?: AiGatewayPort; matcher?: FakeMatcher; cfg?: Record<string, string>; chunkSize?: number } = {}) {
  const clock = new FakeClock(new Date("2026-11-12T03:00:00.000Z"));
  const signalsStore = new FakeObjectStore(clock);
  const mediaStore = new FakeObjectStore(clock);
  const matcher = o.matcher ?? new FakeMatcher(8);
  const events: SignalAuditEvent[] = [];
  const signals = createSignals({ db: t.db, clock, audit: (e) => void events.push(e), config: config(o.cfg), mediaStore, signalsStore, signalsBucket: "hbecho-signals-test", converter, matcher, ...(o.gateway ? { gateway: o.gateway } : {}), ...(o.chunkSize ? { recomputeChunkSize: o.chunkSize } : {}) });
  const plan = { planId: 1n, version: 1 };
  await signals.segments.create(actor, { planId: plan.planId, platform: "douyin" });
  await signals.segments.setItems(actor, plan, [{ signal: "content.cover_template_score" }]);
  await signals.segments.putImage(actor, { ...plan, kind: "template", target: "cover" }, png("standard"));
  return { clock, signals, signalsStore, mediaStore, matcher, events, plan };
}
export type World = Awaited<ReturnType<typeof createWorld>>;

let n = 0;
export const subjectCount = (): number => n;
/** 一个内容主体；status 决定封面引用：none = 没有引用，其余 = 对应归档状态（archived 时有可用对象）。 */
export async function makeSubject(t: TestDb, status: "none" | "pending" | "failed" | "carried_forward" | "archived", opts: { hex?: string; platform?: string } = {}) {
  const i = ++n;
  const acct = await insertAccount(t.db, opts.platform ?? "douyin", T0);
  const c = await seedContent(t.db, { accountId: acct, pcid: `s${i}`, platform: opts.platform ?? "douyin" });
  const asset = await insertAvailableAsset(t.db, { key: `media/c${i}`, hex: opts.hex ?? `cover-${i}` });
  if (status !== "none") await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "cover", status, mediaAssetId: asset });
  return { id: c.contentId, asset, snapshotId: c.snapshotId };
}
/** 一个有已归档音频的内容主体。 */
export async function makeAudioSubject(t: TestDb, o: { hex?: string; status?: "archived" | "pending" | "none" } = {}) {
  const i = ++n;
  const acct = await insertAccount(t.db, "douyin", T0);
  const c = await seedContent(t.db, { accountId: acct, pcid: `v${i}` });
  const asset = await insertAvailableAsset(t.db, { key: `media/au${i}`, hex: o.hex ?? `audio-${i}` });
  const status = o.status ?? "archived";
  if (status !== "none") await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "audio", status, mediaAssetId: asset });
  return { id: c.contentId, asset };
}
export const content = (id: bigint) => ({ kind: "content", id }) as const;
export const taskCount = async (t: TestDb): Promise<number> => (await t.db.select({ n: count() }).from(signalTasks))[0]!.n;
export const resultCount = async (t: TestDb): Promise<number> => (await t.db.select({ n: count() }).from(signalResults))[0]!.n;
/** 评分 runner 与语音 runner 都跑到领不到任务为止。 */
export async function drain(w: World, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) if ((await w.signals.scoreRunner.runBatch()) + (await w.signals.speechRunner.runBatch()) === 0) return;
}
