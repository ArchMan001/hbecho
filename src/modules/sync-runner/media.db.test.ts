// 任务 7：周期媒资（账号级）与按需视频 / 音频（FS-11；acceptance K）。全程离线：假图片 / 视频 transport、假转换器 / 能力服务、假媒资桶。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../../tests/harness/actors";
import { useTestDb } from "../../../tests/harness/db";
import { FakeRuleSource, dispositionOf } from "../../../tests/harness/fake-rule-source";
import { jpegBytes } from "../../../tests/harness/fake-media";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { setupMedia, type MediaEnv } from "../../../tests/harness/media-env";
import { nextRound, runPeriodic } from "../../../tests/harness/periodic";
import { DETAIL_PATH, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { dataQualityIssues, mediaAssets, mediaReferences, syncBatches, syncTasks } from "../../db/schema";
import { decodeDetail, rankVideoSources } from "../provider-adapter";
import { mediaKey } from "../media-archive";

const t = useTestDb();
const DY_POST = "7676403385372904742";
const KS_POST = "3xx33ggte9tessy";
const VIDEO_ROLES = ["video", "audio"] as const;

const sourcesOfFixture = (): string[] => {
  const d = decodeDetail("douyin", loadFixtureBytes("raw4.C05"));
  if (d.outcome !== "decoded") throw new Error("raw4.C05 解不出");
  return rankVideoSources("douyin", d.data.downloadCandidates);
};
const detailCalls = (env: SyncEnv) => env.transport.calls.filter((c) => c.request.path === DETAIL_PATH).length;
const refsOf = (roles: readonly string[]) => t.db.select().from(mediaReferences).where(inArray(mediaReferences.role, [...roles])).orderBy(mediaReferences.mediaReferenceId);
const issues = async (code: string) => (await t.db.select().from(dataQualityIssues)).filter((i) => i.issueCode === code);
const retryRun = async (env: SyncEnv, me: MediaEnv) => {
  env.clock.advance(10 * 60_000);
  await me.run();
};

async function videoWorld(opts: Parameters<typeof setupMedia>[1] = {}) {
  const env = await setupSync(t);
  const me = setupMedia(env, opts);
  const [dy] = await runPeriodic(t, env, [{ platform: "douyin", staffId: env.org.staffA, postIds: [DY_POST] }]);
  env.routeDetail(() => loadFixtureBytes("raw4.C05"));
  const cid = dy!.contentIds.get(DY_POST)!;
  const sources = sourcesOfFixture();
  expect(sources.length).toBeGreaterThanOrEqual(2);
  const source = new FakeRuleSource(env.demand, serviceActor());
  const get = (batchId: string) => env.demand.get(batchId, serviceActor());
  return { env, me, cid, sources, source, get };
}

describe("按需视频 / 音频：依赖链、流式下载、签名 URL（FS-11.5–11.9）", () => {
  it("只要音频：audio ⇒ video ⇒ detail 依赖链；视频流式落盘并分片上传，音频经 10 分钟签名 URL 抽取；get 给出资产指针；本轮内再要则复用", async () => {
    const { env, me, cid, sources, source, get } = await videoWorld();
    me.videoTransport.route(sources[0]!, { total: 300_000, tag: "v1" });
    const r = await source.request([{ contentId: cid, wants: ["audio"] }]);
    expect(dispositionOf(r, cid, "audio")).toBe("queued");
    expect(await env.tasks("download_media")).toHaveLength(0); // 媒资任务由详情成功时创建
    await me.run();

    expect(detailCalls(env)).toBe(1);
    expect(me.videoTransport.requested).toEqual([sources[0]]); // 第一个来源成功，不再尝试其余
    const media = (await env.tasks("download_media")).filter((x) => x.batchId === BigInt(r.batchId));
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ status: "succeeded", contentId: cid, priority: 50 });
    expect(media[0]!.taskParameters).toMatchObject({ schema_version: "sync-media-video-task.v1", roles: ["video", "audio"], detail_mode: "synchronous" });
    const assets = await t.db.select().from(mediaAssets).where(inArray(mediaAssets.mediaKind, [...VIDEO_ROLES]));
    const video = assets.find((a) => a.mediaKind === "video")!;
    const audio = assets.find((a) => a.mediaKind === "audio")!;
    expect(video).toMatchObject({ byteLength: 300_000n, mimeType: "video/mp4", verificationStatus: "verified" });
    expect(audio).toMatchObject({ mimeType: "audio/mp4", durationMs: 12_345n });
    const refs = await refsOf(VIDEO_ROLES);
    expect(refs.map((x) => [x.role, x.archiveStatus, x.mediaAssetId])).toEqual([["video", "archived", video.mediaAssetId], ["audio", "archived", audio.mediaAssetId]]);
    // 视频从文件上传（不是内存缓冲），按内容寻址；音频用短期签名 URL 读取已入库视频
    const key = mediaKey(video.sha256.toString("hex"));
    expect(me.mediaStore.uploadedFiles).toEqual([{ key, path: expect.stringContaining(me.tmpDir), byteLength: 300_000 }]);
    expect(me.mediaStore.signed).toEqual([{ key, ttlSeconds: 600 }]);
    expect(me.capability.calls).toHaveLength(1);
    expect(me.capability.calls[0]).toMatchObject({ maxBytes: 300_000 }); // min(源视频字节数, HBECHO_MEDIA_MAX_BYTES)
    expect(me.tmpFiles()).toEqual([]); // 临时文件不残留
    expect(await issues("media_archive_failed")).toHaveLength(0);

    const view = await get(r.batchId);
    expect(view.items.find((i) => i.want === "audio")).toMatchObject({ state: "ready", pointers: { mediaAssetId: audio.mediaAssetId.toString() } });
    await env.scheduler.tick(env.clock.now());
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, BigInt(r.batchId))))[0]!.status).toBe("succeeded");

    // 再要视频 + 音频：都已有资产 → reused，不建任务、不发详情
    const again = await source.request([{ contentId: cid, wants: ["video", "audio"] }]);
    expect(dispositionOf(again, cid, "video")).toBe("reused");
    expect(dispositionOf(again, cid, "audio")).toBe("reused");
    expect(again.taskCount).toBe(0);
    expect((await get(again.batchId)).items.map((i) => i.state)).toEqual(["reused_ready", "reused_ready"]);
    expect(detailCalls(env)).toBe(1);
  });

  it("只要视频：不调用能力服务，没有音频引用", async () => {
    const { env, me, cid, sources, source } = await videoWorld();
    me.videoTransport.route(sources[0]!, { total: 5_000 });
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    expect(me.capability.calls).toHaveLength(0);
    expect((await refsOf(["audio"])).length).toBe(0);
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "archived" });
    expect((await env.tasks("download_media"))[0]).toMatchObject({ status: "succeeded" });
  });

  it("200 MB 视频：内存只占一块（采样 RSS 增量远小于文件），上传的是临时文件，结束后临时文件被删除", async () => {
    const { me, cid, sources, source } = await videoWorld();
    const base = process.memoryUsage().rss;
    let peak = 0;
    let produced = 0;
    me.videoTransport.route(sources[0]!, {
      total: 200 * 1024 * 1024,
      chunk: 1024 * 1024,
      onChunk: (n) => {
        produced = n;
        peak = Math.max(peak, process.memoryUsage().rss - base);
      },
    });
    // 假桶不保存 200 MB：只流式算摘要并记录路径
    me.mediaStore.putFile = async (key, path) => {
      const h = createHash("sha256");
      let n = 0;
      for await (const c of createReadStream(path)) (h.update(c), (n += c.length));
      me.mediaStore.uploadedFiles.push({ key, path, byteLength: n });
      return { sha256: h.digest("hex"), byteLength: n };
    };
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    expect(produced).toBe(200 * 1024 * 1024);
    expect(peak).toBeLessThan(120 * 1024 * 1024);
    expect(me.mediaStore.uploadedFiles[0]).toMatchObject({ byteLength: 200 * 1024 * 1024 });
    expect(me.tmpFiles()).toEqual([]);
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "archived" });
  }, 120_000);

  it("多来源：第一个来源过期（403）→ 换下一个来源成功；任务成功，不留失败问题", async () => {
    const { me, cid, sources, source } = await videoWorld();
    me.videoTransport.route(sources[0]!, { status: 403 });
    me.videoTransport.route(sources[1]!, { total: 4_000, tag: "second" });
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    expect(me.videoTransport.requested).toEqual([sources[0], sources[1]]);
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "archived", lastErrorCode: null });
    expect(await issues("media_archive_failed")).toHaveLength(0);
  });

  it("全部来源过期：media_source_expired（可重试）→ 下一次尝试先重新取详情，用新地址成功，不复用过期地址；失败只留一条问题", async () => {
    const { env, me, cid, sources, source, get } = await videoWorld();
    for (const s of sources) me.videoTransport.route(s, { status: 403 });
    const r = await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    const [first] = (await env.tasks("download_media")).filter((x) => x.batchId === BigInt(r.batchId));
    expect(first).toMatchObject({ status: "retry_wait", lastErrorCode: "media_source_expired", attemptCount: 1 });
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "failed", lastErrorCode: "source_expired" });
    expect(detailCalls(env)).toBe(1);
    expect((await get(r.batchId)).items[0]).toMatchObject({ state: "pending" });
    // 供应商换了新地址：详情第二次返回的来源可下载
    for (const s of sources) me.videoTransport.route(s, { total: 6_000, tag: "fresh" });
    await retryRun(env, me);
    expect(detailCalls(env)).toBe(2); // 重试前先重新取详情
    const [second] = (await env.tasks("download_media")).filter((x) => x.batchId === BigInt(r.batchId));
    expect(second).toMatchObject({ status: "succeeded", attemptCount: 1, lastErrorCode: null }) // 计数是失败次数;
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "archived", lastErrorCode: null });
    expect(await issues("media_archive_failed")).toHaveLength(1);
  });

  it("超限：声明长度超限 / 流式超限都以 media_too_large 终态失败（不重试）；超限时中止读取，不把超限字节写下去；临时文件不残留", async () => {
    const { env, me, cid, sources, source } = await videoWorld({ mediaMaxBytes: 1_000 });
    // 来源 0：声明长度超限；来源 1：不声明长度，流式读到超限就中止
    me.videoTransport.route(sources[0]!, { total: 5_000, chunk: 500 });
    let produced = 0;
    me.videoTransport.route(sources[1]!, { total: 100_000, chunk: 500, contentLength: null, onChunk: (n) => (produced = n) });
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    const [task] = await env.tasks("download_media");
    expect(task).toMatchObject({ status: "failed", lastErrorCode: "media_too_large", attemptCount: 1 });
    expect(produced).toBeLessThanOrEqual(1_500); // 读到超限的下一块就停，远小于 100 KB
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "failed", lastErrorCode: "too_large" });
    expect(me.tmpFiles()).toEqual([]);
    expect(me.mediaStore.uploadedFiles).toHaveLength(0);
  });

  it("单批次总字节上限：剩余额度不足以容纳视频 → too_large，不下载超出额度的字节", async () => {
    const { env, me, cid, sources, source } = await videoWorld({ batchMaxBytes: 1_000 });
    for (const s of sources) me.videoTransport.route(s, { total: 5_000, chunk: 500, contentLength: null });
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    expect((await env.tasks("download_media"))[0]).toMatchObject({ status: "failed", lastErrorCode: "media_too_large" });
    expect(me.mediaStore.uploadedFiles).toHaveLength(0);
  });

  it("截断（声明长度与实际不符）可重试；200 的错误页（不是视频）是终态", async () => {
    const trunc = await videoWorld();
    for (const s of trunc.sources) trunc.me.videoTransport.route(s, (n) => (n === 1 ? { total: 1_000, contentLength: 2_000 } : { total: 1_000, tag: "ok" }));
    await trunc.source.request([{ contentId: trunc.cid, wants: ["video"] }]);
    await trunc.me.run();
    expect((await trunc.env.tasks("download_media"))[0]).toMatchObject({ status: "retry_wait", lastErrorCode: "media_download_failed" });
    await retryRun(trunc.env, trunc.me);
    expect((await trunc.env.tasks("download_media"))[0]).toMatchObject({ status: "succeeded" });
    expect(trunc.me.tmpFiles()).toEqual([]);
  });

  it("200 的错误页不是视频：content_type_not_allowed 终态，不重试", async () => {
    const { env, me, cid, sources, source } = await videoWorld();
    const page = new TextEncoder().encode("<html><body>signature expired</body></html>");
    for (const s of sources) me.videoTransport.route(s, { chunks: [page], contentType: "text/html" });
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    expect((await env.tasks("download_media"))[0]).toMatchObject({ status: "failed", lastErrorCode: "media_content_type_not_allowed", attemptCount: 1 });
    expect(me.tmpFiles()).toEqual([]);
  });

  it("相同字节只有一份资产：引用丢失后重新下载同样的字节 → 复用已有资产，不重复上传", async () => {
    const { env, me, cid, sources, source } = await videoWorld();
    me.videoTransport.route(sources[0]!, { total: 8_000, tag: "same" });
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    const before = await t.db.select().from(mediaAssets).where(eq(mediaAssets.mediaKind, "video"));
    expect(before).toHaveLength(1);
    await t.db.delete(mediaReferences).where(eq(mediaReferences.role, "video")); // 模拟引用没了、资产还在
    await nextRound(t, env);
    await source.request([{ contentId: cid, wants: ["video"] }]);
    await me.run();
    expect(await t.db.select().from(mediaAssets).where(eq(mediaAssets.mediaKind, "video"))).toHaveLength(1);
    expect(me.mediaStore.uploadedFiles).toHaveLength(1); // 第二次没有再上传
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "archived", mediaAssetId: before[0]!.mediaAssetId });
  });

  it("无音轨：no_audio_track 终态——任务成功、不重试、不计失败、不留质量问题；get 如实报告 failed/no_audio_track", async () => {
    const { env, me, cid, sources, source, get } = await videoWorld();
    me.videoTransport.route(sources[0]!, { total: 3_000 });
    me.capability.noAudio = true;
    const r = await source.request([{ contentId: cid, wants: ["audio"] }]);
    await me.run();
    await retryRun(env, me);
    await env.scheduler.tick(env.clock.now());
    expect((await env.tasks("download_media"))[0]).toMatchObject({ status: "succeeded", attemptCount: 0 });
    expect(me.capability.calls).toHaveLength(1); // 没有重试
    expect((await refsOf(["audio"]))[0]).toMatchObject({ archiveStatus: "failed", lastErrorCode: "no_audio_track", mediaAssetId: null });
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "archived" });
    expect(await issues("media_archive_failed")).toHaveLength(0);
    expect((await get(r.batchId)).items[0]).toMatchObject({ state: "failed", reason: "no_audio_track" });
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, BigInt(r.batchId))))[0]!).toMatchObject({ status: "succeeded", failedTaskCount: 0 });
  });

  it("能力服务不可用：可重试（converter_unavailable）；视频已入库，重试只重做音频", async () => {
    const { env, me, cid, sources, source } = await videoWorld();
    me.videoTransport.route(sources[0]!, { total: 3_000 });
    me.capability.fail = "unavailable";
    await source.request([{ contentId: cid, wants: ["audio"] }]);
    await me.run();
    expect((await env.tasks("download_media"))[0]).toMatchObject({ status: "retry_wait", lastErrorCode: "converter_unavailable" });
    expect((await refsOf(["video"]))[0]).toMatchObject({ archiveStatus: "archived" });
    expect((await refsOf(["audio"]))[0]).toMatchObject({ archiveStatus: "failed", lastErrorCode: "converter_unavailable" });
    me.capability.fail = null;
    await retryRun(env, me);
    expect((await env.tasks("download_media"))[0]).toMatchObject({ status: "succeeded" });
    expect(me.videoTransport.requested).toHaveLength(1); // 视频没有重新下载
    expect((await refsOf(["audio"]))[0]).toMatchObject({ archiveStatus: "archived" });
  });
});

// ── 周期媒资（账号级）──
const serveRefs = async (me: MediaEnv, o: { cover?: number } = {}) => {
  const rows = await t.db.select().from(mediaReferences).orderBy(mediaReferences.mediaReferenceId);
  for (const r of rows) {
    if (r.archiveStatus !== "pending" || r.sourceLocator === null) continue;
    if (r.role === "cover" && o.cover && o.cover !== 200) me.imageTransport.route(r.sourceLocator, { status: o.cover });
    else me.imageTransport.route(r.sourceLocator, { status: 200, contentType: "image/jpeg", body: jpegBytes(`${r.role}:${r.sourceLocator}`) });
  }
};
// 列表封面取数组第 2 条（540 宽）
const dyCover = (postId: string) => [`https://p3.douyinpic.com/cover-${postId}-1080.jpeg`, `https://p3.douyinpic.com/cover-${postId}.jpeg`];
async function periodicWorld(platform: "douyin" | "kuaishou" = "douyin") {
  const env = await setupSync(t);
  const me = setupMedia(env);
  const post = platform === "douyin" ? DY_POST : KS_POST;
  const cover = platform === "douyin" ? dyCover : (p: string) => [`https://js.kwimgs.com/upic/${p}-big.kvif`, `https://js.kwimgs.com/upic/${p}.kvif`];
  const [acc] = await runPeriodic(t, env, [{ platform, staffId: platform === "douyin" ? env.org.staffA : env.org.staffC, postIds: [post], cover }]);
  const coverRefs = () => t.db.select().from(mediaReferences).where(eq(mediaReferences.role, "cover")).orderBy(mediaReferences.mediaReferenceId);
  /** 一轮收尾：汇总（建账号级媒资任务）→ 跑媒资 → 再汇总（写 media_finished_at）。 */
  const settle = async () => {
    await env.scheduler.tick(env.clock.now());
    await serveRefs(me, {});
    await me.run();
    await env.scheduler.tick(env.clock.now());
  };
  return { env, me, acc: acc!, coverRefs, settle, post };
}

describe("周期媒资：账号级 download_media（FS-11.1–11.4）", () => {
  it("批次终态后对账建任务 → 头像 / 背景 / 封面 + 标准化衍生图全部归档；media_finished_at 在媒资全部终态后才写；任务幂等", async () => {
    const { env, me, settle } = await periodicWorld();
    await env.scheduler.tick(env.clock.now()); // 汇总：结构化阶段终态 → 批次 succeeded，媒资任务建好
    const [batch] = await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "full"));
    expect(batch).toMatchObject({ status: "succeeded", mediaFinishedAt: null });
    const media = await env.tasks("download_media");
    expect(media).toHaveLength(1);
    expect(media[0]!.taskParameters).toEqual({ schema_version: "sync-media-task.v1", scope: "account_batch" });
    await env.scheduler.tick(env.clock.now()); // 再汇总一次不会重复建任务
    expect(await env.tasks("download_media")).toHaveLength(1);
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "full")))[0]!.mediaFinishedAt).toBeNull(); // 媒资任务还没跑

    await settle();
    expect((await env.tasks("download_media"))[0]).toMatchObject({ status: "succeeded" });
    const refs = await t.db.select().from(mediaReferences);
    expect(refs.filter((r) => ["avatar", "background", "cover"].includes(r.role)).every((r) => r.archiveStatus === "archived")).toBe(true);
    expect(refs.filter((r) => r.role.endsWith("_normalized")).length).toBeGreaterThanOrEqual(3);
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "full")))[0]!.mediaFinishedAt).not.toBeNull();
    expect(me.converter.inputs.length).toBeGreaterThanOrEqual(3);
  });

  it("没有成功结构化任务的账号不建媒资任务；批次失败时直接写 media_finished_at", async () => {
    const env = await setupSync(t);
    setupMedia(env);
    const [dy] = await runPeriodic(t, env, [{ platform: "douyin", staffId: env.org.staffA, postIds: [DY_POST] }]);
    await t.db.update(syncTasks).set({ status: "failed", lastErrorCode: "provider_request_rejected" }).where(eq(syncTasks.accountId, dy!.accountId));
    await env.scheduler.tick(env.clock.now());
    await env.scheduler.tick(env.clock.now());
    expect(await env.tasks("download_media")).toHaveLength(0);
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "full")))[0]).toMatchObject({ status: "failed" });
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "full")))[0]!.mediaFinishedAt).not.toBeNull();
  });

  it("封面首次规则：成功（S）后下一轮不再为新快照建封面引用", async () => {
    // S,S
    const s = await periodicWorld();
    await s.settle();
    expect(await s.coverRefs()).toHaveLength(1);
    expect((await s.coverRefs())[0]).toMatchObject({ archiveStatus: "archived" });
    await nextRound(t, s.env);
    await s.me.run(); // 第二轮的主页 / 列表
    await s.settle();
    expect(await s.coverRefs()).toHaveLength(1); // 没有新引用，封面不重复下载
    expect(s.me.imageTransport.callsTo(dyCover(s.post)[1]!)).toBe(1);
  });

  it("封面首次规则：第一轮失败（F）→ 第二轮重建引用并成功", async () => {
    const f = await periodicWorld();
    await f.env.scheduler.tick(f.env.clock.now());
    await serveRefs(f.me, { cover: 404 });
    await f.me.run();
    await f.env.scheduler.tick(f.env.clock.now());
    const first = await f.coverRefs();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ archiveStatus: "failed", lastErrorCode: "source_expired" });
    expect((await f.env.tasks("download_media"))[0]).toMatchObject({ status: "succeeded" }); // 引用失败不让任务失败（警告，不回滚快照）
    expect((await issues("media_archive_failed")).length).toBeGreaterThanOrEqual(1);
    await nextRound(t, f.env);
    await f.me.run();
    await f.settle();
    const second = await f.coverRefs();
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({ archiveStatus: "failed" });
    expect(second[1]).toMatchObject({ archiveStatus: "archived" });
  });
});

describe("快手封面（D-62）：原始 KVIF 作为不透明字节入库，标准化图来自 CDN 转换来源", () => {
  it("原图保留为资产；CDN 转换后的 JPEG 再标准化为衍生图", async () => {
    const k = await periodicWorld("kuaishou");
    const cover = await k.coverRefs();
    expect(cover).toHaveLength(1);
    const url = cover[0]!.sourceLocator!;
    const kvif = Uint8Array.from([0x4b, 0x56, 0x49, 0x46, 1, 2, 3, 4, 5, 6, 7, 8]);
    await k.env.scheduler.tick(k.env.clock.now());
    await serveRefs(k.me, {});
    k.me.imageTransport.route(url, { status: 200, contentType: "application/octet-stream", body: kvif });
    const transform = `${url}?x-oss-process=image/format,jpg/resize,w_540`;
    k.me.imageTransport.route(transform, { status: 200, contentType: "image/jpeg", body: jpegBytes("cdn-540") });
    await k.me.run();
    const refs = await k.coverRefs();
    expect(refs[0]).toMatchObject({ archiveStatus: "archived" });
    expect(k.me.imageTransport.requested).toContain(transform);
    const norm = (await t.db.select().from(mediaReferences).where(eq(mediaReferences.role, "cover_normalized")))[0]!;
    expect(norm).toMatchObject({ archiveStatus: "archived" });
    expect(norm.mediaAssetId).not.toBe(refs[0]!.mediaAssetId);
    const sha = createHash("sha256").update(kvif).digest("hex");
    const original = (await t.db.select().from(mediaAssets).where(eq(mediaAssets.mediaAssetId, refs[0]!.mediaAssetId!)))[0]!;
    expect(original.sha256.toString("hex")).toBe(sha); // 原始字节原样保存
  });

  it("CDN 转换来源取不到：衍生图 failed/cover_unavailable + media_cover_unavailable 问题；原图仍在，内容不受影响", async () => {
    const k = await periodicWorld("kuaishou");
    const url = (await k.coverRefs())[0]!.sourceLocator!;
    await k.env.scheduler.tick(k.env.clock.now());
    await serveRefs(k.me, {});
    k.me.imageTransport.route(url, { status: 200, contentType: "application/octet-stream", body: Uint8Array.from([0x4b, 0x56, 0x49, 0x46, 9, 9, 9, 9, 9, 9, 9, 9]) });
    k.me.imageTransport.route(`${url}?x-oss-process=image/format,jpg/resize,w_540`, { status: 404 });
    await k.me.run();
    expect((await k.coverRefs())[0]).toMatchObject({ archiveStatus: "archived" });
    const norm = (await t.db.select().from(mediaReferences).where(eq(mediaReferences.role, "cover_normalized")))[0]!;
    expect(norm).toMatchObject({ archiveStatus: "failed", lastErrorCode: "cover_unavailable" });
    expect(await issues("media_cover_unavailable")).toHaveLength(1);
    expect((await k.env.tasks("download_media"))[0]).toMatchObject({ status: "succeeded" });
  });
});
void and;
