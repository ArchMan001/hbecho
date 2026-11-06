// a-full-sync 真实 smoke（FS-19）。刘学奎 2026-11-06 授权：不限调用数 / 点数 / 金额，按规则跑，过程不需要再确认。
// 分阶段运行，状态都在数据库里（可重跑、可只跑某一阶段）：
//   tsx --env-file=.env scripts/smoke/fullsync-smoke.ts setup | intake | round | demand | probe | report
// 输入：/tmp/fullsync-smoke/links.json（用户给的脏分享文案，原样交给 AI Master，由它清洗）。
// 凭证只从环境变量读（.env），不打印、不落盘；输出只含计数、稳定码、ID 与时间。
// 不在默认套件和 CI 里；独立数据库 hbecho_fullsync_smoke（与旧 tracer smoke 库分开）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import mysql from "mysql2/promise";
import { createDb, createPool, runMigrations, type Db } from "../../src/db/client";
import { contentSnapshots, contents, dataQualityIssues, mediaAssets, mediaReferences, mediaStaff, odsProviderCalls, platforms, staffAccountAssignments, syncBatches, syncCheckpoints, syncSettings, syncTasks } from "../../src/db/schema";
import { createDemandModule } from "../../src/modules/demand";
import { HttpCapabilityClient, HttpMediaTransport } from "../../src/modules/media-archive";
import { createMonitoringResolver } from "../../src/modules/monitoring";
import { claimTask, runTracerRoot } from "../../src/modules/orchestrator";
import { decodeDetail, type DetailData, type Platform } from "../../src/modules/provider-adapter";
import { HttpProviderTransport, OssObjectStore, RawCaptureGateway, type MediaObjectStore, type StoredObject } from "../../src/modules/raw-capture";
import { createAccountRunners, createBatchBudgetPolicy, createDemandRunners, createMediaRunners, callDecoded, type TaskContext } from "../../src/modules/sync-runner";
import { createSyncStatus } from "../../src/modules/sync-status";
import { createSyncCommands, createSyncScheduler, memorySyncAuditSink } from "../../src/modules/sync-schedule";
import { CAP_SYNC_TRIGGER, DEFAULT_ASYNC, DEFAULT_RETRY, createTracerCommands, createTracerStatusQuery, type ActorContext } from "../../src/modules/tracer-command";
import { buildRequest } from "../../src/modules/provider-adapter";
import { createBreakerSet } from "../../src/worker/provider-breaker";
import { createSyncWorker } from "../../src/worker/sync-worker";
import { createTokenBucket, rateLimitedTransport } from "../../src/worker/token-bucket";
import { seedOrg } from "../../tests/harness/seed";

const OUT = "/tmp/fullsync-smoke";
const CAPABILITY_URL = process.env.HBECHO_CAPABILITY_URL ?? "http://127.0.0.1:8081";
const QPS = 3;
const MODES = { media_user_info: "synchronous", user_video_list: "synchronous" } as const;
const DEMAND_MODES = { media_stats_number: "synchronous", post_comments_list: "synchronous" } as const;
const actor: ActorContext = { actorId: "service:fullsync-smoke", capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all", mediaStaffIds: "all" } };
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`缺少环境变量 ${k}`);
  return v;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const js = (v: unknown, space?: number) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), space);
const save = (name: string, v: unknown) => writeFileSync(`${OUT}/${name}.json`, js(v, 1));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8")) as T;
interface Link {
  idx: number;
  platform: Platform;
  kind: "profile" | "work";
  text: string;
}
const links = (): Link[] => JSON.parse(readFileSync(`${OUT}/links.json`, "utf8")) as Link[];

/** 所有对象放进 ODS 桶的 smoke/ 前缀下（媒资桶永不过期，smoke 数据不进去）。 */
class PrefixedStore implements MediaObjectStore {
  constructor(
    private readonly inner: OssObjectStore,
    private readonly prefix: string,
  ) {}
  put(key: string, bytes: Uint8Array): Promise<StoredObject> {
    return this.inner.put(this.prefix + key, bytes);
  }
  putFile(key: string, path: string): Promise<StoredObject> {
    return this.inner.putFile(this.prefix + key, path);
  }
  signedGetUrl(key: string, ttl: number): Promise<string> {
    return this.inner.signedGetUrl(this.prefix + key, ttl);
  }
  get(key: string) {
    return this.inner.get(this.prefix + key);
  }
  delete(key: string) {
    return this.inner.delete(this.prefix + key);
  }
  list(prefix: string) {
    return this.inner.list(this.prefix + prefix);
  }
}

/** 专用的一次性 MySQL 容器（hbecho-fullsync-smoke-mysql，端口 3310）；旧 tracer smoke 库不动。 */
async function dbUrl(): Promise<string> {
  return need("FULLSYNC_DATABASE_URL");
}

async function boot() {
  const pool = createPool(await dbUrl());
  const db = createDb(pool);
  const clock = { now: () => new Date() };
  const oss = {
    accessKeyId: need("OSS_ACCESS_KEY_ID"),
    accessKeySecret: need("OSS_ACCESS_KEY_SECRET"),
    region: need("OSS_REGION"),
    bucket: need("OSS_BUCKET_ODS"),
    endpoint: process.env.OSS_ENDPOINT,
  };
  const odsStore = new OssObjectStore(oss as never);
  const mediaStore = new PrefixedStore(new OssObjectStore(oss as never), "smoke/fullsync-media/");
  const bucket = createTokenBucket({ ratePerSec: QPS, nowMs: () => Date.now(), sleep });
  const transport = rateLimitedTransport(new HttpProviderTransport({ baseUrl: need("AIMASTER_BASE_URL"), apiKey: need("AIMASTER_API_KEY"), timeoutMs: Number(process.env.SMOKE_PROVIDER_TIMEOUT_MS ?? 90_000) }), bucket);
  const gateway = new RawCaptureGateway({
    db,
    store: odsStore,
    transport,
    clock,
    location: { providerCode: "aliyun-oss", region: oss.region, bucket: oss.bucket },
    keyPrefix: "smoke/fullsync-",
    // 用户：不限调用数 / 点数 / 金额。这里放一个远高于需要的数，只防死循环
    policy: createBatchBudgetPolicy(db, { maxCalls: 100_000, maxPoints: 10_000_000 }),
  });
  const deps = { db, clock, gateway, environment: "test" as const, sleep, async: DEFAULT_ASYNC };
  const resolver = createMonitoringResolver(db);
  const runtime = { environment: "test" as const, modes: MODES };
  const scheduler = createSyncScheduler({ db, clock, resolver, runtime });
  const commands = createSyncCommands({ db, clock, resolver, planner: scheduler.planner, runtime, audit: memorySyncAuditSink() });
  const demand = createDemandModule({ db, clock, runtime: { environment: "test", modes: DEMAND_MODES }, audit: memorySyncAuditSink() });
  const media = new HttpMediaTransport();
  const capability = new HttpCapabilityClient({ baseUrl: CAPABILITY_URL });
  mkdirSync("/tmp/fullsync-media", { recursive: true });
  const registry = {
    ...createAccountRunners(deps),
    ...createDemandRunners(deps),
    ...createMediaRunners({
      ...deps,
      mediaStore,
      location: { providerCode: "aliyun-oss", region: oss.region, bucket: oss.bucket },
      imageTransport: media,
      videoTransport: media,
      converter: capability,
      capability,
      tmpDir: "/tmp/fullsync-media",
      mediaMaxBytes: 300 * 1024 * 1024,
      batchMaxBytes: 3 * 1024 * 1024 * 1024,
    }),
  };
  const worker = createSyncWorker({
    db,
    clock,
    resolver,
    runners: registry,
    breakers: createBreakerSet({ failures: 8, cooldownMs: 30_000, nowMs: () => Date.now() }),
    workerId: "fullsync-smoke",
    concurrency: 2,
    mediaConcurrency: 1,
    leaseMs: 10 * 60_000,
    retry: DEFAULT_RETRY,
    idlePollMs: 1000,
    sleep,
    log: (e, m) => console.error(m, e instanceof Error ? e.name : e),
  });
  const status = createSyncStatus({ db, clock, resolver });
  return { pool, db, clock, gateway, deps, resolver, scheduler, commands, demand, worker, status };
}
type Ctx = Awaited<ReturnType<typeof boot>>;

/** 跑到没有可领任务；退避中的重试任务等到点再跑，最多 6 轮（任务自己的重试额度才是上限，这里只防死循环）。 */
async function drain(c: Ctx, label: string) {
  for (let i = 0; i < 6; i++) {
    const stats = await c.worker.run({ untilIdle: true });
    await c.scheduler.tick();
    const waiting = await c.db.select({ at: syncTasks.nextAttemptAt }).from(syncTasks).where(eq(syncTasks.status, "retry_wait"));
    console.log(`[${label}] run#${i + 1}`, JSON.stringify(stats), `retry_wait=${waiting.length}`);
    if (waiting.length === 0) return;
    const next = Math.min(...waiting.map((w) => w.at?.getTime() ?? Date.now()));
    await sleep(Math.max(1000, Math.min(next - Date.now() + 500, 120_000)));
  }
}

async function setup() {
  for (let i = 0; i < 90; i++) {
    try {
      const probe = await mysql.createConnection({ uri: await dbUrl() });
      await probe.end();
      break;
    } catch {
      await sleep(1000);
    }
  }
  const pool = createPool(await dbUrl());
  const db = createDb(pool);
  await runMigrations(db);
  const now = new Date();
  const [has] = await db.select().from(syncSettings);
  if (!has) {
    await db.insert(syncSettings).values({
      settingsId: 1,
      scheduleSlots: [{ weekday: 1, time: "02:00" }],
      initialContentLimit: 20,
      listSafetyPageLimit: 3, // 重试 / 翻页次数写死：列表至多 3 页、任务至多 3 次尝试、评论至多 3 页
      commentPageLimit: 3,
      taskMaxAttempts: 3,
      configVersion: 1n,
      createdAt: now,
      updatedAt: now,
    });
  }
  const org = await seedOrg(db, now).catch(async () => null); // 已有组织则跳过
  const profiles = links().filter((l) => l.kind === "profile");
  const existing = await db.select({ id: mediaStaff.staffId }).from(mediaStaff).where(sql`${mediaStaff.staffName} LIKE '冒烟专员%'`);
  if (existing.length === 0) {
    const [store] = await db.execute(sql`SELECT store_id FROM stores ORDER BY store_id LIMIT 1`).then((r) => (r as unknown as [Array<{ store_id: string }>])[0]);
    const storeId = org?.storeId ?? BigInt(store!.store_id);
    await db.insert(mediaStaff).values(profiles.map((p) => ({ storeId, staffName: `冒烟专员${p.idx}`, phone: `137${String(p.idx).padStart(8, "0")}`, status: "active", createdAt: now, updatedAt: now })));
  }
  const staff = await db.select({ id: mediaStaff.staffId, name: mediaStaff.staffName }).from(mediaStaff).where(sql`${mediaStaff.staffName} LIKE '冒烟专员%'`);
  save("setup", { db: "hbecho_fullsync_smoke", staff: Object.fromEntries(staff.map((s) => [s.name.replace("冒烟专员", ""), s.id.toString()])) });
  console.log("setup ok; profiles:", profiles.length, "staff:", staff.length);
  await pool.end();
}

async function intake() {
  const c = await boot();
  const staff = load<{ staff: Record<string, string> }>("setup").staff;
  const tracer = createTracerCommands({ db: c.db, clock: c.clock, audit: { record: () => {} }, config: { environment: "test", modes: MODES } });
  const statusQuery = createTracerStatusQuery({ db: c.db, clock: c.clock });
  const results: unknown[] = [];
  const only = process.argv[3]; // 可选：只跑某个平台
  const tag = process.argv[4] ?? "r1"; // 可选：幂等键后缀（换后缀 = 对失败的入口重新来一遍）
  for (const l of links().filter((x) => x.kind === "profile" && (!only || x.platform === only))) {
    const t0 = Date.now();
    const sub = await tracer.submit({ platform: l.platform, mediaStaffId: staff[String(l.idx)], homeLocator: l.text, idempotencyKey: `fs-smoke-intake-${l.idx}-${tag}` }, actor).catch((e) => ({ error: (e as { code?: string }).code ?? String(e) }));
    if ("error" in sub) {
      results.push({ idx: l.idx, platform: l.platform, submitError: sub.error });
      continue;
    }
    let run = await runTracerRoot({ db: c.db, clock: c.clock, gateway: c.gateway, workerId: "fullsync-smoke", config: { environment: "test", modes: MODES } }, sub.rootTaskId);
    for (let n = 0; run.kind === "retry_wait" && n < 3; n++) {
      await sleep(15_000);
      run = await runTracerRoot({ db: c.db, clock: c.clock, gateway: c.gateway, workerId: "fullsync-smoke", config: { environment: "test", modes: MODES } }, sub.rootTaskId);
    }
    const st = await statusQuery.get(sub.rootTaskId, actor);
    const s = st.kind === "found" ? st : null;
    results.push({ idx: l.idx, platform: l.platform, rootTaskId: sub.rootTaskId, run: run.kind, state: s?.state ?? null, entryOutcome: s?.entryOutcome ?? null, failure: s?.failure ?? null, structured: s?.structured ?? null, media: s?.media ?? null, warnings: s?.warnings ?? [], ms: Date.now() - t0 });
    console.log("intake", l.idx, l.platform, run.kind, s?.state, s?.failure?.code ?? "", "entries", s?.structured.returnedEntries ?? "");
  }
  save(`intake-${only ?? "all"}-${tag}`, results);
  await c.pool.end();
}

async function round() {
  const c = await boot();
  // 多页游标：每个平台挑 2 个账号，把检查点锚点换成一个不存在的 ID → 必须翻到安全页数上限，验证真实游标翻页
  const accs = await c.db
    .select({ accountId: syncCheckpoints.accountId, platformCode: platforms.platformCode })
    .from(syncCheckpoints)
    .innerJoin(staffAccountAssignments, eq(staffAccountAssignments.accountId, syncCheckpoints.accountId))
    .innerJoin(platforms, eq(platforms.platformId, staffAccountAssignments.platformId));
  const tampered: string[] = [];
  const plain = process.argv[3] === "plain"; // plain：不改检查点，验证稳态（全部命中旧边界）
  for (const p of plain ? [] : ["douyin", "xiaohongshu", "kuaishou"]) {
    for (const a of accs.filter((x) => x.platformCode === p).slice(0, 2)) {
      await c.db.update(syncCheckpoints).set({ anchorMode: "id_window", highWatermarkContentIds: ["NOT-ON-ANY-PAGE"], highWatermarkPublishedAt: null, continuityStatus: "ready", version: sql`${syncCheckpoints.version} + 1` }).where(eq(syncCheckpoints.accountId, a.accountId));
      tampered.push(a.accountId.toString());
    }
  }
  const all = await c.db.select({ id: staffAccountAssignments.accountId }).from(staffAccountAssignments);
  const r = await c.commands.createSupplement({ accountIds: all.map((a) => a.id.toString()), only: "full", onBusy: "run_now", idempotencyKey: `fs-smoke-round-${Date.now()}`, apply: true }, actor);
  console.log("supplement", r.kind, "batch" in r ? (r as { batchId?: string }).batchId : "");
  await drain(c, "round");
  save("round", { supplement: r, tamperedAccounts: tampered });
  await c.pool.end();
}

async function demand() {
  const c = await boot();
  const rows = (await c.db.execute(sql`
    SELECT c.content_id, c.platform_content_id, p.platform_code, c.content_kind, cs.duration_value, cs.published_at
    FROM contents c JOIN platforms p ON p.platform_id = c.platform_id
    JOIN content_snapshots cs ON cs.content_snapshot_id = c.current_snapshot_id
    WHERE c.current_snapshot_id IS NOT NULL ORDER BY cs.published_at DESC`)) as unknown as [Array<{ content_id: string; platform_code: string; content_kind: string; duration_value: string | null }>];
  const by = (p: string) => rows[0].filter((r) => r.platform_code === p);
  const items: Array<{ contentId: string; wants: string[] }> = [];
  const note: Record<string, unknown> = {};
  for (const p of ["douyin", "xiaohongshu", "kuaishou"]) {
    const list = by(p);
    note[p] = { contents: list.length };
    const videos = list.filter((r) => r.content_kind === "video" && r.duration_value && Number(r.duration_value) > 0).sort((a, b) => Number(a.duration_value) - Number(b.duration_value));
    const pick = new Set<string>(list.slice(0, 3).map((r) => r.content_id));
    for (const id of pick) items.push({ contentId: id, wants: p === "kuaishou" ? ["detail", "comments"] : ["detail", "comments"] });
    if (videos[0]) {
      const v = items.find((i) => i.contentId === videos[0]!.content_id);
      if (v) v.wants.push("video", "audio");
      else items.push({ contentId: videos[0].content_id, wants: ["detail", "video", "audio"] });
      note[p] = { ...(note[p] as object), videoPicked: videos[0].content_id, durationSeconds: videos[0].duration_value };
    }
  }
  const res = await c.demand.submit({ demandKey: `fs-smoke-demand-${Date.now()}`, requester: { kind: "smoke", ref: "fullsync", version: "v1" }, ruleDecisionId: "smoke", ruleVersion: "smoke-1", items }, actor);
  console.log("demand", res.kind, "tasks", res.taskCount);
  await drain(c, "demand");
  const view = await c.demand.get(res.batchId, actor);
  save("demand", { note, submit: res, view });
  await c.pool.end();
}

/** 视频 + 音频：每个平台挑时长最短的一条视频内容（已经下载成功的内容会 reused）。 */
async function video() {
  const c = await boot();
  const rows = (await c.db.execute(sql`
    SELECT c.content_id, p.platform_code, cs.duration_value FROM contents c JOIN platforms p ON p.platform_id = c.platform_id
    JOIN content_snapshots cs ON cs.content_snapshot_id = c.current_snapshot_id
    WHERE c.content_kind = 'video' AND cs.duration_value > 0`)) as unknown as [Array<{ content_id: string; platform_code: string; duration_value: string }>];
  const items = ["douyin", "xiaohongshu", "kuaishou"].flatMap((p) => {
    const v = rows[0].filter((r) => r.platform_code === p).sort((a, b) => Number(a.duration_value) - Number(b.duration_value))[0];
    return v ? [{ contentId: v.content_id, wants: ["video", "audio"], platform: p, duration: v.duration_value }] : [];
  });
  console.log("video picks", JSON.stringify(items));
  const res = await c.demand.submit({ demandKey: `fs-smoke-video-${Date.now()}`, requester: { kind: "smoke", ref: "fullsync", version: "v1" }, ruleDecisionId: "smoke", ruleVersion: "smoke-1", items: items.map((i) => ({ contentId: i.contentId, wants: i.wants })) }, actor);
  console.log("video demand", res.kind, "tasks", res.taskCount);
  await drain(c, "video");
  save("video", { picks: items, submit: res, view: await c.demand.get(res.batchId, actor) });
  await c.pool.end();
}

/** 只跑 worker 直到没有可领任务（媒资任务很慢，demand 阶段超时后用它续跑），再保存最近一个按需批次的视图。 */
async function drainOnly() {
  const c = await boot();
  await drain(c, "drain");
  const [b] = await c.db.select({ id: syncBatches.batchId }).from(syncBatches).where(eq(syncBatches.purpose, "demand")).orderBy(desc(syncBatches.batchId)).limit(1);
  if (b) save("demand-view", await c.demand.get(b.id.toString(), actor));
  await c.pool.end();
}

/** 作品链接：用户给的原样脏文案直接作为 url 发给 media_stats_number（不经过我们的内容 URL 构造），记录供应商行为。 */
async function probe() {
  const c = await boot();
  const [prov] = await c.db.execute(sql`SELECT provider_id FROM data_providers WHERE provider_code='aimaster'`).then((r) => (r as unknown as [Array<{ provider_id: string }>])[0]);
  const providerId = BigInt(prov!.provider_id);
  const now = new Date();
  const [b] = await c.db.insert(syncBatches).values({ batchKey: Buffer.from(`probe-${Date.now()}`.padEnd(32, "0")).subarray(0, 32), triggerType: "manual", purpose: "intake", logicalAt: now, status: "running", settingsVersion: 1n, settingsSnapshot: { probe: true }, createdAt: now, updatedAt: now, startedAt: now });
  const results: unknown[] = [];
  for (const l of links().filter((x) => x.kind === "work")) {
    const [pl] = await c.db.select({ id: platforms.platformId }).from(platforms).where(eq(platforms.platformCode, l.platform));
    const [t] = await c.db.insert(syncTasks).values({
      batchId: BigInt(b.insertId),
      providerId,
      platformId: pl!.id,
      requestedAction: "fetch_content_detail",
      subjectType: "probe",
      subjectKey: `probe-${l.idx}`,
      subjectKeySha256: Buffer.alloc(32, l.idx),
      taskParameters: { probe: true },
      idempotencyKey: Buffer.from(`probe-key-${l.idx}-${Date.now()}`.padEnd(32, "0")).subarray(0, 32),
      status: "pending",
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(now.getTime() + 30 * 86400_000),
      createdAt: now,
      updatedAt: now,
    });
    const claim = await claimTask(c.db, BigInt(t.insertId), { workerId: "probe", leaseMs: 600_000, now: new Date() });
    if (claim.kind !== "claimed") throw new Error("probe claim failed");
    const ctx: TaskContext = { task: claim.task, token: claim.token, db: c.db, clock: c.clock, heartbeat: async () => "ok", shouldStop: () => false };
    const r = await callDecoded<DetailData>(c.deps, ctx, {
      platform: l.platform,
      action: "media_stats_number",
      expectedResponse: "media_stats",
      mode: "synchronous",
      seq: 1,
      request: buildRequest({ action: "media_stats_number", mode: "synchronous", locator: l.text }),
      decode: (bytes) => decodeDetail(l.platform, bytes),
    });
    const row =
      r.kind === "decoded"
        ? { idx: l.idx, platform: l.platform, outcome: "decoded", postId: r.data.postId.state === "value" ? r.data.postId.value : r.data.postId.state, play: r.data.metrics.play, authorId: r.data.author.id.state === "value" ? r.data.author.id.value : r.data.author.id.state, durationSeconds: r.data.durationSeconds, downloadCandidates: r.data.downloadCandidates.length, coverCandidates: r.data.coverCandidates.length }
        : { idx: l.idx, platform: l.platform, outcome: r.kind, code: r.kind === "failed" ? r.code : r.reason };
    results.push(row);
    console.log("probe", l.idx, l.platform, js(row).slice(0, 220));
    await c.db.update(syncTasks).set({ status: "succeeded", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null }).where(eq(syncTasks.taskId, BigInt(t.insertId)));
  }
  save("probe", results);
  await c.pool.end();
}

async function report() {
  const c = await boot();
  const batches = await c.db.select().from(syncBatches).orderBy(syncBatches.batchId);
  const perBatch = [];
  for (const b of batches) if (b.purpose !== "intake" || (b.settingsSnapshot as { probe?: boolean }).probe !== true) perBatch.push(await c.status.batch(b.batchId.toString()));
  const calls = await c.db
    .select({ platform: platforms.platformCode, action: odsProviderCalls.requestedAction, outcome: odsProviderCalls.outcome, n: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(odsProviderCalls)
    .leftJoin(platforms, eq(platforms.platformId, odsProviderCalls.platformId))
    .groupBy(platforms.platformCode, odsProviderCalls.requestedAction, odsProviderCalls.outcome);
  const tasks = await c.db.select({ action: syncTasks.requestedAction, status: syncTasks.status, code: syncTasks.lastErrorCode, n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks).groupBy(syncTasks.requestedAction, syncTasks.status, syncTasks.lastErrorCode);
  const issues = await c.db.select({ code: dataQualityIssues.issueCode, severity: dataQualityIssues.severity, n: sql<number>`COUNT(*)`.mapWith(Number) }).from(dataQualityIssues).groupBy(dataQualityIssues.issueCode, dataQualityIssues.severity);
  const media = await c.db.select({ role: mediaReferences.role, status: mediaReferences.archiveStatus, code: mediaReferences.lastErrorCode, n: sql<number>`COUNT(*)`.mapWith(Number) }).from(mediaReferences).groupBy(mediaReferences.role, mediaReferences.archiveStatus, mediaReferences.lastErrorCode);
  const assets = await c.db.select({ kind: mediaAssets.mediaKind, n: sql<number>`COUNT(*)`.mapWith(Number), bytes: sql<number>`SUM(${mediaAssets.byteLength})`.mapWith(Number) }).from(mediaAssets).groupBy(mediaAssets.mediaKind);
  const cps = await c.db.select({ mode: syncCheckpoints.anchorMode, cont: syncCheckpoints.continuityStatus, n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncCheckpoints).groupBy(syncCheckpoints.anchorMode, syncCheckpoints.continuityStatus);
  const pages = await c.db.select({ pages: syncTasks.pageCount, status: syncTasks.status, stop: syncTasks.stopReason, n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks).where(eq(syncTasks.requestedAction, "fetch_content_list")).groupBy(syncTasks.pageCount, syncTasks.status, syncTasks.stopReason);
  const rowsTotal = {
    contents: (await c.db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(contents))[0]!.n,
    contentSnapshots: (await c.db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(contentSnapshots))[0]!.n,
    providerCalls: (await c.db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(odsProviderCalls))[0]!.n,
  };
  const out = { generatedAt: new Date().toISOString(), calls, tasks, issues, media, assets, checkpoints: cps, listPages: pages, rowsTotal, perBatch };
  save("report", out);
  console.log(js(out).slice(0, 3000));
  void desc;
  void and;
  void inArray;
  void (null as unknown as Db);
  await c.pool.end();
}

const phase = process.argv[2];
const phases: Record<string, () => Promise<void>> = { setup, intake, round, demand, video, drain: drainOnly, probe, report };
if (!phases[phase ?? ""]) {
  console.error("用法：fullsync-smoke.ts setup | intake | round | demand | probe | report");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
await phases[phase!]!();
process.exit(0);
