// 任务 8：任务表、requestScores、评分 runner、结果行、读取口补齐。真实 MySQL + FakeMatcher + FakeObjectStore。
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { signalResults, signalTasks } from "../../../db/schema";
import { FakeClock } from "../../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../../tests/harness/fake-oss";
import { resetData, useTestDb } from "../../../../tests/harness/db";
import { insertAccount } from "../../../../tests/harness/factories";
import { QueryCounter, FakeAiGateway, FakeMatcher, SIGNALS_T0 as T0, insertAvailableAsset, insertMediaReference, seedContent } from "../../../../tests/harness/signals";
import { createDb } from "../../../db/client";
import { ConverterError, type ImageConverter } from "../../media-archive";
import { createSignals } from "../assemble";
import type { SignalAuditEvent } from "../audit";
import { CAP_SCORE_REQUEST, CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, type SignalActor } from "../authz";
import { CAPABILITY_VERSIONS, DEFAULT_ENABLED_CAPABILITIES } from "../catalog";
import { parseSignalsConfig } from "../config";
import { claim } from "../tasks/queue";
import { MatcherError } from "./ports";

const t = useTestDb();
const actor: SignalActor = { actor: "service:d", capabilities: new Set([CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, CAP_SCORE_REQUEST]), brandScope: "all" };
const ENABLED = [...DEFAULT_ENABLED_CAPABILITIES, "image.template", "image.element", "speech.asr", "speech.judge"];
const config = (over: Record<string, string> = {}) =>
  parseSignalsConfig({
    HBECHO_SIGNALS_SCAN_INTERVAL_MS: "1000", HBECHO_SIGNALS_SCAN_BATCH: "100", HBECHO_SIGNALS_LOOKBACK_MS: "60000", HBECHO_SIGNALS_RECONCILE_INTERVAL_MS: "1000",
    HBECHO_SIGNALS_SCORE_CONCURRENCY: "4", HBECHO_SIGNALS_TASK_MAX_ATTEMPTS: "3", HBECHO_SIGNALS_RETRY_BACKOFF_MS: "1000", HBECHO_SIGNALS_LEASE_MS: "60000",
    HBECHO_SIGNALS_SIGNED_URL_TTL_S: "600", HBECHO_SIGNALS_MATCH_TIMEOUT_MS: "5000", HBECHO_SIGNALS_DEFER_INTERVAL_MS: "30000", HBECHO_SIGNALS_DEFER_MAX: "20",
    HBECHO_MEDIA_MAX_BYTES: "20971520", HBECHO_SIGNALS_ENABLED: ENABLED.join(","), ...over,
  });
const converter: ImageConverter = {
  async toNormalizedJpeg({ bytes }) {
    if (Buffer.from(bytes).includes("UNDECODABLE")) throw new ConverterError("unsupported", "x");
    return { bytes: new Uint8Array([1]), width: 540, height: 360 };
  },
};
const png = (seed: string): Uint8Array => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);

async function world(o: { gateway?: FakeAiGateway; matcher?: FakeMatcher; cfg?: Record<string, string> } = {}) {
  const clock = new FakeClock(new Date("2026-11-12T03:00:00.000Z"));
  const signalsStore = new FakeObjectStore(clock);
  const mediaStore = new FakeObjectStore(clock);
  const matcher = o.matcher ?? new FakeMatcher(8);
  const events: SignalAuditEvent[] = [];
  const signals = createSignals({ db: t.db, clock, audit: (e) => void events.push(e), config: config(o.cfg), mediaStore, signalsStore, signalsBucket: "hbecho-signals-test", converter, matcher, ...(o.gateway ? { gateway: o.gateway } : {}) });
  const plan = { planId: 1n, version: 1 };
  await signals.segments.create(actor, { planId: plan.planId, platform: "douyin" });
  await signals.segments.setItems(actor, plan, [{ signal: "content.cover_template_score" }]);
  await signals.segments.putImage(actor, { ...plan, kind: "template", target: "cover" }, png("standard"));
  return { clock, signals, signalsStore, mediaStore, matcher, events, plan };
}
type World = Awaited<ReturnType<typeof world>>;

let n = 0;
/** 一个内容主体；status 决定封面引用：none = 没有引用，其余 = 对应归档状态（archived 时有可用对象）。 */
async function subject(status: "none" | "pending" | "failed" | "carried_forward" | "archived", opts: { hex?: string; platform?: string } = {}) {
  const i = ++n;
  const acct = await insertAccount(t.db, opts.platform ?? "douyin", T0);
  const c = await seedContent(t.db, { accountId: acct, pcid: `s${i}`, platform: opts.platform ?? "douyin" });
  const asset = await insertAvailableAsset(t.db, { key: `media/c${i}`, hex: opts.hex ?? `cover-${i}` });
  if (status !== "none") await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "cover", status, mediaAssetId: asset });
  return { id: c.contentId, asset };
}
const kind = (id: bigint) => ({ kind: "content", id }) as const;
const taskCount = async () => (await t.db.select({ n: count() }).from(signalTasks))[0]!.n;
const resultCount = async () => (await t.db.select({ n: count() }).from(signalResults))[0]!.n;
async function drain(w: World, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) if ((await w.signals.scoreRunner.runBatch()) === 0) return;
}

describe("requestScores：补缺失、按映射返回、不重复建任务", () => {
  it("100 个内容主体：10 无引用 / 5 pending / 5 carried_forward / 80 已归档 → 80 个任务，其余 20 个按映射返回，carried_forward 没有任务且在 needMedia", async () => {
    const w = await world();
    const subs: Array<[string, Awaited<ReturnType<typeof subject>>]> = [];
    for (const [status, k] of [["none", 10], ["pending", 5], ["carried_forward", 5], ["archived", 80]] as const) for (let i = 0; i < k; i++) subs.push([status, await subject(status)]);
    const r = await w.signals.requestScores(actor, w.plan, subs.map(([, s]) => kind(s.id)));
    expect(r.tasks).toEqual({ created: 80, revived: 0, requeued: 0, reused: 0 });
    expect(await taskCount()).toBe(80);
    const by = new Map(r.items[0]!.subjects.map((s) => [s.id, s]));
    const tally: Record<string, number> = {};
    for (const [status, s] of subs) {
      const d = by.get(s.id)!;
      tally[`${status}:${d.disposition}:${d.reason ?? ""}`] = (tally[`${status}:${d.disposition}:${d.reason ?? ""}`] ?? 0) + 1;
    }
    expect(tally).toEqual({ "none:not_applicable:no_reference": 10, "pending:missing:media_pending": 5, "carried_forward:missing:media_carried_forward": 5, "archived:queued:": 80 });
    expect(r.needMedia.map((m) => m.reason).sort()).toEqual([...Array(5).fill("media_carried_forward"), ...Array(5).fill("media_pending")]);
    const carried = subs.filter(([s]) => s === "carried_forward").map(([, s]) => s.id);
    expect(r.needMedia.map((m) => m.id)).toEqual(expect.arrayContaining(carried));
  });
  it("第二次请求：不新增任务；任务全部完成后再请求：仍不新增任务（结果行命中）", async () => {
    const w = await world();
    const subs = [await subject("archived"), await subject("archived"), await subject("archived")];
    const ask = () => w.signals.requestScores(actor, w.plan, subs.map((s) => kind(s.id)));
    expect((await ask()).tasks.created).toBe(3);
    const again = await ask();
    expect(again.tasks).toEqual({ created: 0, revived: 0, requeued: 0, reused: 3 });
    expect(await taskCount()).toBe(3);
    await drain(w);
    expect(await resultCount()).toBe(3);
    const done = await ask();
    expect(done.tasks).toEqual({ created: 0, revived: 0, requeued: 0, reused: 0 });
    expect(done.items[0]!.subjects.map((s) => [s.disposition, s.reason])).toEqual([["reused", "valid"], ["reused", "valid"], ["reused", "valid"]]);
    expect(await taskCount()).toBe(3);
  });
  it("同一张封面被两个内容引用：只算一次；两个监控段引用同一张标准图字节：共享结果", async () => {
    const w = await world();
    const a = await subject("archived", { hex: "same-cover" });
    // 同字节在 A 里是同一行 media_asset（按 SHA 判同）：第二个内容引用同一个资产
    const acct = await insertAccount(t.db, "douyin", T0);
    const c2 = await seedContent(t.db, { accountId: acct, pcid: "twin" });
    await insertMediaReference(t.db, { contentSnapshotId: c2.snapshotId, role: "cover", status: "archived", mediaAssetId: a.asset });
    const r = await w.signals.requestScores(actor, w.plan, [kind(a.id), kind(c2.contentId)]);
    expect(r.tasks.created).toBe(1);
    expect(r.items[0]!.subjects.map((x) => x.disposition)).toEqual(["queued", "queued"]);
    // 第二个监控段：标准图字节相同 → 参数指纹相同 → 对同一封面直接命中
    const plan2 = { planId: 2n, version: 1 };
    await w.signals.segments.create(actor, { planId: 2n, platform: "douyin" });
    await w.signals.segments.setItems(actor, plan2, [{ signal: "content.cover_template_score" }]);
    await w.signals.segments.putImage(actor, { ...plan2, kind: "template", target: "cover" }, png("standard")); // 字节与 plan 1 相同
    await drain(w);
    const r2 = await w.signals.requestScores(actor, plan2, [kind(a.id), kind(c2.contentId)]);
    expect(r2.tasks).toEqual({ created: 0, revived: 0, requeued: 0, reused: 0 });
    expect(r2.items[0]!.subjects.map((x) => x.disposition)).toEqual(["reused", "reused"]);
    expect(await resultCount()).toBe(1);
    expect((await t.db.select().from(signalResults))[0]!.lineage).toMatchObject({ plan_id: "1", version: 1 }); // 血缘记第一次计算的计划，不进复用键
  });
  it("换标准图后再请求：对同一批主体新建任务，旧结果行保留", async () => {
    const w = await world();
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await drain(w);
    await w.signals.segments.publish(actor, w.plan);
    const v2 = await w.signals.segments.newDraft(actor, { planId: 1n, fromVersion: 1 });
    await w.signals.segments.putImage(actor, { ...v2, kind: "template", target: "cover" }, png("another-standard"));
    const r = await w.signals.requestScores(actor, v2, [kind(s.id)]);
    expect(r.tasks.created).toBe(1);
    await drain(w);
    expect(await resultCount()).toBe(2);
  });
  it("账号主体（抖音头像）与平台不符的主体", async () => {
    const w = await world();
    await w.signals.segments.setItems(actor, w.plan, [{ signal: "account.avatar_template_score" }]);
    await w.signals.segments.putImage(actor, { ...w.plan, kind: "template", target: "avatar" }, png("avatar-standard"));
    const noSnapshot = await insertAccount(t.db, "douyin", T0);
    const r = await w.signals.requestScores(actor, w.plan, [{ kind: "account", id: noSnapshot }, kind((await subject("archived", { platform: "kuaishou" })).id)]);
    // 内容主体不属于账号类信号，被这个条目忽略；账号尚无主页快照 → missing(no_profile_snapshot) 且列入 needMedia
    expect(r.items[0]!.subjects).toEqual([{ id: noSnapshot, disposition: "missing", reason: "no_profile_snapshot" }]);
    expect(r.needMedia).toEqual([{ kind: "account", id: noSnapshot, signal: "account.avatar_template_score", reason: "no_profile_snapshot" }]);
    expect(await taskCount()).toBe(0);
  });
  it("拒绝：缺 Capability（零查询）、超过 5,000、监控段不存在、不可执行（默认启用集不含图像类）", async () => {
    const w = await world();
    const counter = new QueryCounter();
    const other = createSignals({ db: createDb(t.pool, { logger: counter }), clock: w.clock, audit: () => {}, config: config(), mediaStore: w.mediaStore, signalsStore: w.signalsStore, signalsBucket: "b", converter, matcher: w.matcher });
    await expect(other.requestScores({ ...actor, capabilities: new Set() }, w.plan, [])).rejects.toMatchObject({ code: "forbidden" });
    await expect(other.requestScores(actor, w.plan, Array.from({ length: 5001 }, (_, i) => kind(BigInt(i + 1))))).rejects.toMatchObject({ code: "too_many_subjects" });
    expect(counter.count).toBe(0);
    await expect(w.signals.requestScores(actor, { planId: 99n, version: 1 }, [])).rejects.toMatchObject({ code: "segment_not_found" });
    const defaults = createSignals({ db: t.db, clock: w.clock, audit: () => {}, config: config({ HBECHO_SIGNALS_ENABLED: "" }), mediaStore: w.mediaStore, signalsStore: w.signalsStore, signalsBucket: "b", converter, matcher: w.matcher });
    await expect(defaults.requestScores(actor, w.plan, [kind((await subject("archived")).id)])).rejects.toMatchObject({ code: "not_executable", detail: [{ code: "capability_disabled" }] });
    expect(await taskCount()).toBe(0);
  });
});

describe("评分 runner：结果行、读取口、失败分类", () => {
  it("完成后读取口读到 valid：分数、证据（匹配点数）、能力版本、resultId；任务 succeeded 且指向结果行", async () => {
    const w = await world();
    const s = await subject("archived");
    const param = { segment: w.plan };
    const before = await w.signals.reader.read(actor, kind(s.id), "content.cover_template_score", { param });
    expect(before).toMatchObject({ state: "missing", reason: "not_computed" });
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    expect(await w.signals.reader.read(actor, kind(s.id), "content.cover_template_score", { param })).toMatchObject({ state: "missing", reason: "not_computed", pending: "queued" });
    await drain(w);
    const v = await w.signals.reader.read(actor, kind(s.id), "content.cover_template_score", { param });
    expect(v).toMatchObject({ state: "valid", usable: true, score: 8, capability: { id: "image.template", version: 1 }, evidence: { raw: { inliers: 8 }, engine: { id: "image.template", version: 1 } } });
    const [task] = await t.db.select().from(signalTasks);
    expect(task).toMatchObject({ status: "succeeded", resultId: v.resultId, attemptCount: 1 });
    const [row] = await t.db.select().from(signalResults);
    expect(row).toMatchObject({ signalKey: "content.cover_template_score", state: "valid", score: "8.00", capabilityVersion: 1, failureCode: null });
    expect(row!.expiresAt).toEqual(new Date(Date.UTC(2027, 10, 12, 3, 0, 0))); // 成功结果保留一年
    // 请求的是以 signed URL 调用：URL 来自两个桶，且不进证据
    expect(w.matcher.requests).toHaveLength(1);
    expect(w.matcher.requests[0]).toMatchObject({ mode: "template", maxBytes: 20971520 });
    expect(JSON.stringify(row!.evidence)).not.toContain("fake-oss.test");
    expect(w.mediaStore.signed[0]).toMatchObject({ key: "media/c" + n, ttlSeconds: 600 });
  });
  it("升级能力版本后旧结果读作 stale，不会被 requestScores 重算", async () => {
    const w = await world();
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await drain(w);
    const versions = CAPABILITY_VERSIONS as Record<string, number>;
    try {
      versions["image.template"] = 2;
      expect(await w.signals.reader.read(actor, kind(s.id), "content.cover_template_score", { param: { segment: w.plan } })).toMatchObject({ state: "stale", usable: true, score: 8, capability: { version: 1 } });
      const r = await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
      expect(r.tasks.created).toBe(0);
      expect(r.items[0]!.subjects[0]).toMatchObject({ disposition: "reused", reason: "stale" });
    } finally {
      versions["image.template"] = 1;
    }
  });
  it("能力服务回报的版本与目录不一致：瞬时失败重试，不写结果行；用尽后 dead，requestScores 把它置回 pending", async () => {
    const matcher = new FakeMatcher(8);
    matcher.capabilityVersion = 2;
    const w = await world({ matcher });
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await w.signals.scoreRunner.runBatch();
    let [task] = await t.db.select().from(signalTasks);
    expect(task).toMatchObject({ status: "retry_wait", attemptCount: 1, lastErrorCode: "capability_version_mismatch" });
    expect(task!.nextAttemptAt).toEqual(new Date(w.clock.now().getTime() + 1000)); // 退避 1000ms × 2^0
    expect(await w.signals.scoreRunner.runBatch()).toBe(0); // 还没到时间
    w.clock.advance(1000);
    await w.signals.scoreRunner.runBatch();
    [task] = await t.db.select().from(signalTasks);
    expect(task).toMatchObject({ status: "retry_wait", attemptCount: 2 });
    expect(task!.nextAttemptAt).toEqual(new Date(w.clock.now().getTime() + 2000)); // × 2^1
    w.clock.advance(2000);
    await w.signals.scoreRunner.runBatch();
    [task] = await t.db.select().from(signalTasks);
    expect(task).toMatchObject({ status: "dead", attemptCount: 3, lastErrorCode: "retries_exhausted" });
    expect(await resultCount()).toBe(0);
    expect(w.events.filter((e) => e.event_type === "task_dead")).toHaveLength(1);
    expect(await w.signals.reader.read(actor, kind(s.id), "content.cover_template_score", { param: { segment: w.plan } })).toMatchObject({ state: "missing", reason: "compute_dead", pending: "dead" });
    // 镜像修好后再请求：dead 任务被置回 pending，计数清零
    matcher.capabilityVersion = 1;
    const r = await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    expect(r.tasks).toMatchObject({ created: 0, revived: 1 });
    [task] = await t.db.select().from(signalTasks);
    expect(task).toMatchObject({ status: "pending", attemptCount: 0, lastErrorCode: null });
    await drain(w);
    expect(await resultCount()).toBe(1);
  });
  it("能力服务不可用 / 超时 / 来源 5xx 都是瞬时失败；没有指明出问题一侧的 4xx 也按瞬时处理，不固化成失败", async () => {
    for (const err of [new MatcherError("unavailable", "x"), new MatcherError("timeout", "x"), new MatcherError("source_unavailable", "x", "candidate"), new MatcherError("convert_failed", "x")]) {
      await resetData(t.pool);
      const matcher = new FakeMatcher(8).on(() => true, err);
      const w = await world({ matcher });
      const s = await subject("archived");
      await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
      await w.signals.scoreRunner.runBatch();
      expect((await t.db.select().from(signalTasks))[0], err.code).toMatchObject({ status: "retry_wait" });
      expect(await resultCount()).toBe(0);
    }
  });
  it("候选图的确定性失败写 failed(image_unreadable) 结果行（3 个月），任务 succeeded；不重试", async () => {
    for (const code of ["convert_failed", "unsupported_media_type", "source_missing", "input_too_large"] as const) {
      await resetData(t.pool);
      const matcher = new FakeMatcher(8).on(() => true, new MatcherError(code, "候选图坏了 https://x.test/a?Signature=S", "candidate"));
      const w = await world({ matcher });
      const s = await subject("archived");
      await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
      await w.signals.scoreRunner.runBatch();
      const [row] = await t.db.select().from(signalResults);
      expect(row, code).toMatchObject({ state: "failed", failureCode: "image_unreadable", score: null, value: null });
      expect(JSON.stringify(row!.evidence)).not.toContain("Signature");
      expect(row!.expiresAt).toEqual(new Date(Date.UTC(2027, 1, 12, 3, 0, 0))); // 3 个月
      expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "succeeded", attemptCount: 1 });
      expect(await w.signals.reader.read(actor, kind(s.id), "content.cover_template_score", { param: { segment: w.plan } })).toMatchObject({ state: "failed", usable: false, reason: "image_unreadable" });
      // 当前版本的确定性失败不重试：再次请求不建任务
      expect((await w.signals.requestScores(actor, w.plan, [kind(s.id)])).tasks).toEqual({ created: 0, revived: 0, requeued: 0, reused: 0 });
    }
  });
  it("标准图（reference）侧失败是配置错误：任务 dead，不写结果行；被清除的标准图同样", async () => {
    const matcher = new FakeMatcher(8).on(() => true, new MatcherError("source_missing", "标准图不在", "reference"));
    const w = await world({ matcher });
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await w.signals.scoreRunner.runBatch();
    expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "dead", lastErrorCode: "reference_unreadable", attemptCount: 1 });
    expect(await resultCount()).toBe(0);
    // 监控段被清除（标准图行没了）→ 新建的任务 dead(reference_unreadable)
    await resetData(t.pool);
    const w2 = await world();
    const s2 = await subject("archived");
    await w2.signals.requestScores(actor, w2.plan, [kind(s2.id)]);
    await w2.signals.segments.purge(actor, 1n);
    await w2.signals.scoreRunner.runBatch();
    expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "dead", lastErrorCode: "reference_unreadable" });
  });
  it("A 的媒资行说已归档、但对象不可用：写 failed(image_unreadable)", async () => {
    const w = await world();
    const s = await subject("archived");
    const { ossObjects } = await import("../../../db/schema");
    await t.db.update(ossObjects).set({ status: "deleted", deletedAt: T0 }).where(eq(ossObjects.objectKey, `media/c${n}`));
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await w.signals.scoreRunner.runBatch();
    expect((await t.db.select().from(signalResults))[0]).toMatchObject({ state: "failed", failureCode: "image_unreadable" });
    expect(w.matcher.requests).toHaveLength(0);
  });
  it("runner 调用能力服务期间，连接池里没有未提交的事务", async () => {
    let open = -1;
    const matcher = new FakeMatcher(8);
    const orig = matcher.match.bind(matcher);
    matcher.match = async (req) => {
      const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM information_schema.innodb_trx WHERE trx_mysql_thread_id <> CONNECTION_ID()");
      open = Number((rows as Array<{ n: number }>)[0]!.n);
      return orig(req);
    };
    const w = await world({ matcher });
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await w.signals.scoreRunner.runBatch();
    expect(open).toBe(0);
  });
});

describe("任务表：领取、租约、fencing、崩溃恢复", () => {
  const q = (w: World) => ({ db: t.db, clock: w.clock, audit: () => {} });
  it("两个 worker 抢同一个任务：只有一个拿到；租约过期后另一个接手，fencing token 递增，旧 worker 的写入被拒绝且零写入", async () => {
    const w = await world();
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    const a = await claim(q(w), { workerId: "A", leaseMs: 60_000, limit: 5 });
    const b = await claim(q(w), { workerId: "B", leaseMs: 60_000, limit: 5 });
    expect([a.length, b.length]).toEqual([1, 0]);
    w.clock.advance(61_000);
    const b2 = await claim(q(w), { workerId: "B", leaseMs: 60_000, limit: 5 });
    expect(b2).toHaveLength(1);
    expect(b2[0]!.token).toBe(a[0]!.token + 1n);
    expect(b2[0]!.task.attemptCount).toBe(2);
    // 旧 worker A 醒来，试图写结果
    const { succeed } = await import("../tasks/queue");
    const stale = await succeed(q(w), a[0]!, { signalKey: "content.cover_template_score", materialSha256: Buffer.alloc(32, 1), paramSha256: Buffer.alloc(32, 2), capabilityId: "image.template", capabilityVersion: 1, state: "valid", score: "9.00", evidence: {}, producedAt: w.clock.now(), expiresAt: w.clock.now(), createdAt: w.clock.now() });
    expect(stale).toEqual({ ok: false, reason: "stale" });
    expect(await resultCount()).toBe(0);
    expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "running", leaseOwner: "B" });
  });
  it("任务在调用返回之后、事务提交之前崩溃（持有者失联）：租约过期后被接手，结果行恰好一行", async () => {
    const w = await world();
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await claim(q(w), { workerId: "crashed", leaseMs: 60_000, limit: 1 }); // 领了，调用了，进程死了：什么都没写
    expect(await w.signals.scoreRunner.runBatch()).toBe(0); // 租约还没过期
    w.clock.advance(61_000);
    expect(await w.signals.scoreRunner.runBatch()).toBe(1);
    expect(await resultCount()).toBe(1);
    expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "succeeded", attemptCount: 2 });
  });
  it("反复崩溃的任务最终 dead，而不是永远重跑", async () => {
    const w = await world({ cfg: { HBECHO_SIGNALS_TASK_MAX_ATTEMPTS: "2" } });
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    for (let i = 0; i < 2; i++) {
      await claim(q(w), { workerId: `c${i}`, leaseMs: 1000, limit: 1 });
      w.clock.advance(2000);
    }
    expect(await claim(q(w), { workerId: "x", leaseMs: 1000, limit: 1 })).toHaveLength(0);
    expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "dead", lastErrorCode: "retries_exhausted", attemptCount: 2 });
  });
  it("同一结果行并发写入两次（唯一键）：第二次是命中而不是错误", async () => {
    const w = await world();
    const a = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(a.id)]);
    await drain(w);
    const [first] = await t.db.select().from(signalResults);
    // 把任务置回 pending 再跑一次：模拟「第二个 worker 算出同一复用键」
    await t.db.update(signalTasks).set({ status: "pending", resultId: null });
    await drain(w);
    expect(await resultCount()).toBe(1);
    expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "succeeded", resultId: first!.resultId });
  });
  it("任务 succeeded 但结果行已被保留期清理：requestScores 把它置回 pending 重新补算", async () => {
    const w = await world();
    const s = await subject("archived");
    await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    await drain(w);
    await t.db.delete(signalResults); // 保留期清理；任务的 result_id 经 ON DELETE SET NULL 置空
    expect((await t.db.select().from(signalTasks))[0]).toMatchObject({ status: "succeeded", resultId: null });
    expect(await w.signals.reader.read(actor, kind(s.id), "content.cover_template_score", { param: { segment: w.plan } })).toMatchObject({ state: "missing", reason: "not_computed" });
    const r = await w.signals.requestScores(actor, w.plan, [kind(s.id)]);
    expect(r.tasks).toMatchObject({ created: 0, requeued: 1 });
    await drain(w);
    expect(await resultCount()).toBe(1);
  });
});

describe("语音类的请求（运行在任务 9）", () => {
  it("content.asr_text：网关有 ASR 模型时建 ASR 任务（全局信号，参数指纹为零）；同一音频的第二次请求不新增", async () => {
    const gateway = new FakeAiGateway();
    const w = await world({ gateway });
    await w.signals.segments.setItems(actor, w.plan, [{ signal: "content.asr_text" }]);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "v" });
    const audio = await insertAvailableAsset(t.db, { key: "media/au1", hex: "audio-1" });
    await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "audio", status: "archived", mediaAssetId: audio });
    const r = await w.signals.requestScores(actor, w.plan, [kind(c.contentId)]);
    expect(r.tasks.created).toBe(1);
    const [task] = await t.db.select().from(signalTasks);
    expect(task).toMatchObject({ kind: "asr_text" });
    expect((task!.params as { param_sha256: string }).param_sha256).toBe("0".repeat(64));
    expect((await w.signals.requestScores(actor, w.plan, [kind(c.contentId)])).tasks).toMatchObject({ created: 0, reused: 1 });
    expect(gateway.calls).toEqual([]); // 请求本身不调用网关
  });
});
