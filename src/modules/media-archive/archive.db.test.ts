// 任务 7：正式媒资归档与独立进度（R8.5、R12、R15、R16、R18；acceptance F1–F10）。
// 全部离线：fake 媒资 transport / fake 转换器 / fake OSS（媒资桶）/ fake clock；真实 MySQL 8.4。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { FakeImageConverter, FakeMediaTransport, heicBytes, jpegBytes, webpBytes } from "../../../tests/harness/fake-media";
import { FakeObjectStore } from "../../../tests/harness/fake-oss";
import { XHS_LOCATOR, setupTracer, type TracerEnv } from "../../../tests/harness/tracer-env";
import { accountProfileSnapshots, contentSnapshots, contents, dataQualityIssues, mediaAssets, mediaReferences, ossObjects, syncCheckpoints, syncTasks } from "../../db/schema";
import { runTracerRoot } from "../orchestrator";
import { renormalizeUnavailable, runMediaArchive, type MediaArchiveHooks } from "./index";
import type { MediaPolicy } from "./index";

const t = useTestDb();
const REAL_HEIC = new Uint8Array(readFileSync(new URL("../../../tests/fixtures/media/douyin-cover-540.heic", import.meta.url)));
const REAL_HEIC_SHA = "7d109e54b2023f5240a1ff97d26f28ce0083f4882735e98eb563371a5eba44c2";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function structured(platform: "douyin" | "xiaohongshu" = "douyin") {
  const env = await setupTracer(t);
  env.serve.profile(platform);
  env.serve.list(platform);
  const rootId = await env.submit(platform === "douyin" ? {} : { platform, locator: XHS_LOCATOR });
  const r = await runTracerRoot({ db: t.db, clock: env.clock, gateway: env.gateway, workerId: "w1" }, rootId);
  expect(r.kind).toBe("succeeded");
  return mediaEnvFor(env, rootId);
}

function mediaEnvFor(env: TracerEnv, rootId: bigint) {
  const mediaStore = new FakeObjectStore(env.clock);
  const transport = new FakeMediaTransport();
  const converter = new FakeImageConverter();
  const hooks: MediaArchiveHooks = {};
  let policy: MediaPolicy | undefined;
  const run = (root = rootId) =>
    runMediaArchive(
      { db: t.db, clock: env.clock, mediaStore, location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-media-test" }, transport, converter, workerId: "m1", hooks, ...(policy ? { policy } : {}) },
      root,
    );
  const refs = () => t.db.select().from(mediaReferences).orderBy(mediaReferences.mediaReferenceId);
  const originals = async () => (await refs()).filter((r) => ["avatar", "background", "cover"].includes(r.role));
  /** 默认：头像 / 背景各自不同的 JPEG，所有封面都是真实 HEIC 样本（URL 各不相同、字节相同）。 */
  const serveAll = async (over: { cover?: Uint8Array; avatar?: Uint8Array; background?: Uint8Array } = {}) => {
    for (const r of await originals()) {
      const body = r.role === "avatar" ? (over.avatar ?? jpegBytes("avatar")) : r.role === "background" ? (over.background ?? jpegBytes("background")) : (over.cover ?? REAL_HEIC);
      transport.route(r.sourceLocator!, { status: 200, contentType: "image/jpeg", body });
    }
  };
  return { env, rootId, mediaStore, transport, converter, hooks, run, refs, originals, serveAll, setPolicy: (p: MediaPolicy) => (policy = p) };
}
type M = Awaited<ReturnType<typeof structured>>;

const assets = () => t.db.select().from(mediaAssets);

describe("抖音：原始字节与标准化衍生图都形成独立的正式资产", () => {
  it("22 个引用（头像 + 背景 + 20 封面）→ 全部 archived；相同字节只一份资产；衍生图有独立 SHA-256，原图仍在；封面是真实 HEIC", async () => {
    const m = await structured();
    await m.serveAll();
    const profileBefore = await t.db.select().from(accountProfileSnapshots);
    const snapsBefore = await t.db.select().from(contentSnapshots);

    const r = await m.run();
    expect(r).toMatchObject({ kind: "done", archived: 22, failedRetryable: 0, failedTerminal: 0 });
    expect(m.transport.requested).toHaveLength(22);

    const refs = await m.refs();
    expect(refs).toHaveLength(44); // 22 原始 + 22 衍生
    expect(refs.every((x) => x.archiveStatus === "archived" && x.mediaAssetId !== null && !x.isCarriedForward && x.lastErrorCode === null)).toBe(true);
    expect(refs.filter((x) => x.role === "cover_normalized")).toHaveLength(20);
    expect(refs.filter((x) => x.role === "avatar_normalized" || x.role === "background_normalized")).toHaveLength(2);

    const as = await assets();
    expect(as).toHaveLength(6); // 封面原图 1 + 头像 1 + 背景 1，各自一张衍生图
    const cover = as.find((a) => a.sha256.toString("hex") === REAL_HEIC_SHA)!;
    expect(cover).toMatchObject({ mediaKind: "image", mimeType: "image/heic", verificationStatus: "verified", byteLength: BigInt(REAL_HEIC.byteLength) });
    const derivatives = as.filter((a) => a.width !== null); // 只有转换产物带尺寸
    expect(derivatives).toHaveLength(3);
    expect(derivatives.every((a) => a.width === 540 && a.height === 960)).toBe(true);
    expect(new Set(as.map((a) => a.sha256.toString("hex"))).size).toBe(6); // 每份资产有独立 SHA-256，原图与衍生图互不替代

    // 20 个封面引用共享同一份原图；它们的衍生图引用共享同一份衍生资产
    const coverRefs = refs.filter((x) => x.role === "cover");
    expect(new Set(coverRefs.map((x) => x.mediaAssetId))).toEqual(new Set([cover.mediaAssetId]));
    expect(new Set(refs.filter((x) => x.role === "cover_normalized").map((x) => x.mediaAssetId)).size).toBe(1);
    expect(refs.filter((x) => x.role === "cover_normalized")[0]!.mediaAssetId).not.toBe(cover.mediaAssetId);

    // 转换按唯一原图做一次，不是每个引用一次
    expect(m.converter.inputs).toHaveLength(3);
    expect(m.converter.inputs.find((i) => i.mimeType === "image/heic")).toBeDefined();

    // 对象：内容寻址、ASCII、不含任何 URL / 主机 / 查询串
    const objs = await t.db.select().from(ossObjects).where(eq(ossObjects.objectCategory, "media"));
    expect(objs).toHaveLength(6);
    expect(objs.every((o) => /^media\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(o.objectKey) && o.status === "available" && o.sha256 !== null)).toBe(true);
    expect(m.mediaStore.keys("media/")).toHaveLength(6);
    expect(sha((await m.mediaStore.get(objs.find((o) => o.sha256!.toString("hex") === REAL_HEIC_SHA)!.objectKey))!)).toBe(REAL_HEIC_SHA);

    // 结构化事实不被媒资归档改写
    expect(await t.db.select().from(accountProfileSnapshots)).toEqual(profileBefore);
    expect(await t.db.select().from(contentSnapshots)).toEqual(snapsBefore);

    // 状态：媒资进度独立；全部归档后根状态是 succeeded
    const s = await m.env.status(m.rootId);
    expect(s.media).toMatchObject({ total: 44, archived: 44, pending: 0, failed: 0, carriedForward: 0 });
    expect(s.state).toBe("succeeded");
    const kids = await t.db.select().from(syncTasks).where(eq(syncTasks.parentTaskId, m.rootId));
    expect(kids.find((k) => k.requestedAction === "download_media")).toMatchObject({ status: "succeeded" });
  });

  it("结构化先完成、媒资仍 pending 时，根状态是 structured_succeeded_media_pending；归档前不下载任何东西", async () => {
    const m = await structured();
    expect((await m.env.status(m.rootId)).state).toBe("structured_succeeded_media_pending");
    expect(m.transport.requested).toHaveLength(0);
  });

  it("再次运行：不重复下载、不新增任何行（幂等）", async () => {
    const m = await structured();
    await m.serveAll();
    await m.run();
    const before = { refs: (await m.refs()).length, assets: (await assets()).length, calls: m.transport.requested.length, conv: m.converter.inputs.length };
    const again = await m.run();
    expect(again.kind).toBe("nothing_to_do");
    expect({ refs: (await m.refs()).length, assets: (await assets()).length, calls: m.transport.requested.length, conv: m.converter.inputs.length }).toEqual(before);
  });

  it("字节相同、URL 不同（新批次的签名 URL 变了）→ 不产生新资产；字节不同 → 不按 URL 合并", async () => {
    const m = await structured();
    await m.serveAll();
    await m.run();
    const second = await m.env.submit({ key: "again" });
    await runTracerRoot({ db: t.db, clock: m.env.clock, gateway: m.env.gateway, workerId: "w1" }, second);
    // 新批次的引用：URL 全部换成新的签名地址，字节不变
    const m2 = mediaEnvFor(m.env, second);
    m2.mediaStore = m.mediaStore;
    const fresh = (await m2.originals()).filter((r) => r.archiveStatus === "pending");
    expect(fresh).toHaveLength(22);
    for (const r of fresh) {
      const url = `${r.sourceLocator}&sig=new`;
      await t.db.update(mediaReferences).set({ sourceLocator: url, sourceLocatorSha256: createHash("sha256").update(url).digest() }).where(eq(mediaReferences.mediaReferenceId, r.mediaReferenceId));
    }
    for (const r of await m2.originals()) {
      if (r.archiveStatus !== "pending") continue;
      m2.transport.route(r.sourceLocator!, { status: 200, contentType: "image/jpeg", body: r.role === "avatar" ? jpegBytes("avatar") : r.role === "background" ? jpegBytes("background") : REAL_HEIC });
    }
    const runWith = () =>
      runMediaArchive({ db: t.db, clock: m.env.clock, mediaStore: m.mediaStore, location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-media-test" }, transport: m2.transport, converter: m2.converter, workerId: "m1" }, second);
    expect((await runWith()).kind).toBe("done");
    expect(await assets()).toHaveLength(6); // 没有新资产
    expect(m2.converter.inputs).toHaveLength(0); // 已有衍生图可复用，不需要再转换
  });

  it("不同字节的两张封面（即使 URL 相近）是两份资产", async () => {
    const m = await structured();
    const covers = (await m.originals()).filter((r) => r.role === "cover");
    await m.serveAll();
    m.transport.route(covers[1]!.sourceLocator!, { status: 200, contentType: "image/heic", body: heicBytes("another") });
    await m.run();
    expect((await assets()).filter((a) => a.mimeType === "image/heic")).toHaveLength(2);
  });
});

describe("小红书：没有头像 / 背景引用，封面是 WebP", () => {
  it("21 个封面 → 21 个原始 + 21 个衍生引用；没有 avatar / background", async () => {
    const m = await structured("xiaohongshu");
    for (const r of await m.originals()) m.transport.route(r.sourceLocator!, { status: 200, contentType: "image/webp", body: webpBytes("cover") });
    const r = await m.run();
    expect(r).toMatchObject({ kind: "done", archived: 21 });
    const refs = await m.refs();
    expect(refs.filter((x) => ["avatar", "background", "avatar_normalized", "background_normalized"].includes(x.role))).toHaveLength(0);
    expect(refs.filter((x) => x.role === "cover")).toHaveLength(21);
    expect(refs.filter((x) => x.role === "cover_normalized")).toHaveLength(21);
    expect((await assets()).map((a) => a.mimeType).sort()).toEqual(["image/jpeg", "image/webp"]);
    expect(m.converter.inputs.map((i) => i.mimeType)).toEqual(["image/webp"]);
  });
});

describe("失败：保留结构化快照，单独分类，有界重试", () => {
  const find = async (m: M, role: string) => (await m.originals()).find((r) => r.role === role)!;

  it("签名 URL 过期（403）：该引用 failed/source_expired，其余照常归档；不用同一个 URL 重试，下一轮也不重试它", async () => {
    const m = await structured();
    await m.serveAll();
    const avatar = await find(m, "avatar");
    m.transport.route(avatar.sourceLocator!, { status: 403, contentType: "text/html", body: new TextEncoder().encode("expired") });
    const profileBefore = await t.db.select().from(accountProfileSnapshots);
    const r = await m.run();
    expect(r).toMatchObject({ kind: "done", archived: 21, needsFreshUrl: 1, failedRetryable: 0, failedTerminal: 0 });
    expect(m.transport.callsTo(avatar.sourceLocator!)).toBe(1);

    const [row] = await t.db.select().from(mediaReferences).where(eq(mediaReferences.mediaReferenceId, avatar.mediaReferenceId));
    expect(row).toMatchObject({ archiveStatus: "failed", lastErrorCode: "source_expired", mediaAssetId: null, isCarriedForward: false });
    expect(await t.db.select().from(accountProfileSnapshots)).toEqual(profileBefore); // 结构化快照不回滚
    expect(await t.db.select().from(syncCheckpoints)).toHaveLength(1);

    const s = await m.env.status(m.rootId);
    expect(s.state).toBe("succeeded_with_warnings");
    expect(s.media).toMatchObject({ failed: 1, needsFreshUrl: 1, retryable: 0, terminal: 0, archived: 42 });

    expect((await m.run()).kind).toBe("nothing_to_do");
    expect(m.transport.callsTo(avatar.sourceLocator!)).toBe(1);
    // R19.4 / I3：媒资失败留一条可按账号与批次查询的质量问题，不改账号状态；重放不重复
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ issueCode: "media_archive_failed", severity: "warning", status: "open", entityType: "media_reference", entityId: avatar.mediaReferenceId });
    expect(issues[0]!.accountId).not.toBeNull();
    expect(issues[0]!.batchId).not.toBeNull();
    expect(issues[0]!.detail).toMatchObject({ role: "avatar", error_code: "source_expired", carried_forward: false });
  });

  it("下载被截断（Content-Length 不符）：同一次运行内重试一次，第二次成功", async () => {
    const m = await structured();
    await m.serveAll();
    const bg = await find(m, "background");
    m.transport.route(bg.sourceLocator!, (_u, n) =>
      n === 1 ? { status: 200, contentType: "image/jpeg", contentLength: 9999, location: null, body: jpegBytes("background") } : { status: 200, contentType: "image/jpeg", contentLength: null, location: null, body: jpegBytes("background") },
    );
    const r = await m.run();
    expect(r).toMatchObject({ archived: 22, failedRetryable: 0 });
    expect(m.transport.callsTo(bg.sourceLocator!)).toBe(2);
  });

  it("持续超时：同一次运行最多 2 次；下一轮再试；最多 3 轮，之后停止（rounds_exhausted），不再请求", async () => {
    const m = await structured();
    await m.serveAll();
    const bg = await find(m, "background");
    m.transport.route(bg.sourceLocator!, () => {
      throw new Error("ETIMEDOUT");
    });
    const first = await m.run();
    expect(first).toMatchObject({ kind: "done", round: 1, failedRetryable: 1 });
    expect(m.transport.callsTo(bg.sourceLocator!)).toBe(2);
    expect((await m.env.status(m.rootId)).media).toMatchObject({ failed: 1, retryable: 1 });
    await m.run();
    await m.run();
    expect(m.transport.callsTo(bg.sourceLocator!)).toBe(6);
    const exhausted = await m.run();
    expect(exhausted.kind).toBe("rounds_exhausted");
    expect(m.transport.callsTo(bg.sourceLocator!)).toBe(6);
  });

  it("可重试失败在下一轮恢复：成功归档，只请求失败的那一个", async () => {
    const m = await structured();
    await m.serveAll();
    const bg = await find(m, "background");
    m.transport.route(bg.sourceLocator!, () => {
      throw new Error("ECONNRESET");
    });
    await m.run();
    const before = m.transport.requested.length;
    m.transport.route(bg.sourceLocator!, { status: 200, contentType: "image/jpeg", body: jpegBytes("background") });
    const r = await m.run();
    expect(r).toMatchObject({ kind: "done", round: 2, archived: 1 });
    expect(m.transport.requested.length - before).toBe(1);
    expect((await m.env.status(m.rootId)).state).toBe("succeeded");
  });

  it("超过大小上限 / 不是图片 / 被守卫拒绝的地址：终态失败，不重试；被拒绝的地址根本不发请求", async () => {
    const m = await structured();
    await m.serveAll();
    const [avatar, bg, cover] = [await find(m, "avatar"), await find(m, "background"), await find(m, "cover")];
    m.setPolicy({ allowedHostSuffixes: ["douyinpic.com", "rednotecdn.com"], maxBytes: 20_000, maxRedirects: 3, timeoutMs: 1000 });
    m.transport.route(avatar.sourceLocator!, { status: 200, contentType: "image/jpeg", body: jpegBytes("x".repeat(30_000)) });
    m.transport.route(bg.sourceLocator!, { status: 200, contentType: "text/html", body: new TextEncoder().encode("<html>") });
    await t.db.update(mediaReferences).set({ sourceLocator: "http://127.0.0.1/secret", sourceLocatorSha256: createHash("sha256").update("http://127.0.0.1/secret").digest() }).where(eq(mediaReferences.mediaReferenceId, cover.mediaReferenceId));
    const r = await m.run();
    expect(r.failedTerminal).toBe(3);
    const codes = Object.fromEntries((await t.db.select().from(mediaReferences).where(inArray(mediaReferences.mediaReferenceId, [avatar.mediaReferenceId, bg.mediaReferenceId, cover.mediaReferenceId]))).map((x) => [x.role, x.lastErrorCode]));
    expect(codes).toEqual({ avatar: "too_large", background: "content_type_not_allowed", cover: "url_rejected" });
    expect(m.transport.callsTo(avatar.sourceLocator!)).toBe(1);
    expect(m.transport.requested).not.toContain("http://127.0.0.1/secret");
    expect((await m.env.status(m.rootId)).media.terminal).toBe(3);
  });

  it("下载失败且上一快照有已验证资产：carried_forward，复用旧资产并保留本轮失败，不算本轮归档成功", async () => {
    const m = await structured();
    await m.serveAll();
    await m.run();
    const firstBg = await find(m, "background");

    const second = await m.env.submit({ key: "again" });
    await runTracerRoot({ db: t.db, clock: m.env.clock, gateway: m.env.gateway, workerId: "w1" }, second);
    const m2 = mediaEnvFor(m.env, second);
    const refs2 = await m2.originals();
    for (const r of refs2.filter((x) => x.archiveStatus === "pending")) {
      m2.transport.route(r.sourceLocator!, r.role === "background" ? { status: 404, contentType: "text/html", body: new TextEncoder().encode("gone") } : { status: 200, contentType: "image/jpeg", body: r.role === "avatar" ? jpegBytes("avatar") : REAL_HEIC });
    }
    const out = await runMediaArchive({ db: t.db, clock: m.env.clock, mediaStore: m.mediaStore, location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-media-test" }, transport: m2.transport, converter: m2.converter, workerId: "m1" }, second);
    expect(out).toMatchObject({ kind: "done", archived: 21, carriedForward: 2 }); // 背景原图 + 背景衍生图

    const bg2 = (await t.db.select().from(mediaReferences).where(eq(mediaReferences.role, "background"))).find((r) => r.mediaReferenceId !== firstBg.mediaReferenceId)!;
    expect(bg2).toMatchObject({ archiveStatus: "carried_forward", isCarriedForward: true, lastErrorCode: "source_expired", mediaAssetId: firstBg.mediaAssetId });
    const bgNorm = (await t.db.select().from(mediaReferences).where(eq(mediaReferences.role, "background_normalized"))).filter((r) => r.archiveStatus === "carried_forward");
    expect(bgNorm).toHaveLength(1);
    const s = await m.env.status(second);
    expect(s.media).toMatchObject({ carriedForward: 2, failed: 0 });
    // 续用旧资产的本轮失败同样留一条质量问题（本轮失败必须可见，不能表示为归档成功）
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toMatchObject({ role: "background", error_code: "source_expired", carried_forward: true });
    expect(s.media.archived).toBe(42);
    expect(s.state).toBe("succeeded_with_warnings");
    expect(await assets()).toHaveLength(6);
  });
});

describe("衍生图转换", () => {
  it("无法转换（终态）：原图仍归档，衍生引用 failed/convert_failed；再次运行不重复转换", async () => {
    const m = await structured();
    await m.serveAll();
    m.converter.fail = "unsupported";
    const r = await m.run();
    expect(r).toMatchObject({ archived: 22, failedTerminal: 22 });
    expect((await assets()).every((a) => a.width === null)).toBe(true); // 只有原图，没有带尺寸的衍生图
    const norm = (await m.refs()).filter((x) => x.role.endsWith("_normalized"));
    expect(norm.every((x) => x.archiveStatus === "failed" && x.lastErrorCode === "convert_failed")).toBe(true);
    const calls = m.converter.inputs.length;
    await m.run();
    expect(m.converter.inputs.length).toBe(calls);
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues).toHaveLength(22); // 每个衍生引用一条；第二次运行没有新增
    expect(issues.every((i) => i.issueCode === "media_archive_failed" && (i.detail as { derivative?: boolean }).derivative === true)).toBe(true);
  });

  it("转换服务返回的不是 JPEG：不当作衍生图，记 convert_failed，不产生衍生资产", async () => {
    const m = await structured();
    await m.serveAll();
    m.converter.returnNonJpeg = true;
    await m.run();
    expect((await assets()).every((a) => a.width === null)).toBe(true);
    expect((await m.refs()).filter((x) => x.role.endsWith("_normalized")).every((x) => x.lastErrorCode === "convert_failed")).toBe(true);
  });

  it("转换服务暂不可用（可重试）：原图已归档；下一轮只补衍生图，不重新下载", async () => {
    const m = await structured();
    await m.serveAll();
    m.converter.fail = "unavailable";
    const r1 = await m.run();
    expect(r1).toMatchObject({ archived: 22, failedRetryable: 22 });
    const downloads = m.transport.requested.length;
    m.converter.fail = null;
    const r2 = await m.run();
    expect(r2).toMatchObject({ kind: "done", round: 2, failedRetryable: 0 });
    expect(m.transport.requested.length).toBe(downloads); // 没有重新下载
    expect((await m.refs()).filter((x) => x.role.endsWith("_normalized") && x.archiveStatus === "archived")).toHaveLength(22);
    expect((await m.env.status(m.rootId)).state).toBe("succeeded");
  });
});

describe("事务与 fencing", () => {
  it("下载网络等待期间没有打开的数据库事务", async () => {
    const m = await structured();
    await m.serveAll();
    const open: number[] = [];
    m.transport.onRequest = async () => {
      const [rows] = await t.pool.query("SELECT COUNT(*) AS n FROM information_schema.innodb_trx WHERE trx_mysql_thread_id <> CONNECTION_ID()");
      open.push(Number((rows as Array<{ n: number }>)[0]!.n));
    };
    await m.run();
    expect(open).toHaveLength(22);
    expect(open.every((n) => n === 0)).toBe(true);
  });

  it("提交前被更高 worker 取代：不创建资产、不改引用（引用仍是 pending）", async () => {
    const m = await structured();
    await m.serveAll();
    m.hooks.beforeRefCommit = async () => {
      await t.db.update(syncTasks).set({ fencingToken: 99n }).where(eq(syncTasks.requestedAction, "download_media"));
    };
    const r = await m.run();
    expect(r.kind).toBe("stale");
    expect(await assets()).toHaveLength(0);
    expect((await m.originals()).every((x) => x.archiveStatus === "pending")).toBe(true);
  });

  it("结构化阶段还没完成（根任务未终态）：不归档", async () => {
    const env = await setupTracer(t);
    const rootId = await env.submit();
    const m = mediaEnvFor(env, rootId);
    expect((await m.run()).kind).toBe("not_ready");
    expect(m.transport.requested).toHaveLength(0);
  });

  it("没有 media_references 之外的长期事实包含临时 URL：oss_objects / media_assets 行里没有源地址", async () => {
    const m = await structured();
    await m.serveAll();
    await m.run();
    const urls = (await m.originals()).map((r) => new URL(r.sourceLocator!).hostname);
    const dump = JSON.stringify([...(await t.db.select().from(ossObjects)), ...(await assets())], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(urls.some((h) => dump.includes(h))).toBe(false);
    expect(contents).toBeDefined();
  });
});

describe("回填：转换服务不可用期间留下的失败衍生图（线上 2026-11-19 的现状）", () => {
  const derivatives = async (m: M) => (await m.refs()).filter((r) => r.role.endsWith("_normalized"));
  const deps = (m: M) => ({ db: t.db, clock: m.env.clock, mediaStore: m.mediaStore, location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-media-test" }, converter: m.converter });
  it("原图都已归档、衍生图全是 failed/converter_unavailable；服务恢复后回填：同一份原图只转换一次，衍生图变 archived；再跑一次没有候选", async () => {
    const m = await structured();
    await m.serveAll();
    m.converter.fail = "unavailable";
    await m.run();
    const before = await derivatives(m);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.archiveStatus === "failed" && r.lastErrorCode === "converter_unavailable")).toBe(true);
    expect((await m.originals()).every((r) => r.archiveStatus === "archived")).toBe(true); // 原图没有受影响
    m.converter.fail = null;
    m.converter.inputs.length = 0;
    const dry = await renormalizeUnavailable(deps(m), { dryRun: true });
    expect(dry).toMatchObject({ examined: before.length, converted: 0 });
    expect((await derivatives(m)).every((r) => r.archiveStatus === "failed")).toBe(true); // 预览不写
    const rep = await renormalizeUnavailable(deps(m));
    expect(rep).toMatchObject({ examined: before.length, failed: 0, skipped: 0, stoppedEarly: false });
    expect(rep.converted + rep.reused).toBe(before.length);
    // 不同的原图字节才转换：头像、背景、封面（20 个封面是同一份 HEIC 字节）= 3 次
    expect(m.converter.inputs).toHaveLength(3);
    const after = await derivatives(m);
    expect(after.every((r) => r.archiveStatus === "archived" && r.lastErrorCode === null && r.mediaAssetId !== null)).toBe(true);
    for (const r of after) expect((await t.db.select().from(mediaAssets).where(eq(mediaAssets.mediaAssetId, r.mediaAssetId!)))[0]!.mimeType).toBe("image/jpeg");
    expect(await renormalizeUnavailable(deps(m))).toMatchObject({ examined: 0 });
  });
  it("服务仍不可用：第一次失败就停止（不冲击剩余引用），状态保持不变，修好后再跑", async () => {
    const m = await structured();
    await m.serveAll();
    m.converter.fail = "unavailable";
    await m.run();
    m.converter.inputs.length = 0;
    const rep = await renormalizeUnavailable(deps(m));
    expect(rep).toMatchObject({ converted: 0, stoppedEarly: true });
    expect(m.converter.inputs).toHaveLength(1);
    expect((await derivatives(m)).every((r) => r.archiveStatus === "failed" && r.lastErrorCode === "converter_unavailable")).toBe(true);
  });
  it("原图读不回（对象缺失）：跳过，不改状态", async () => {
    const m = await structured();
    await m.serveAll();
    m.converter.fail = "unavailable";
    await m.run();
    m.converter.fail = null;
    for (const key of ((m.mediaStore as unknown as { objects: Map<string, unknown> }).objects.keys() as Iterable<string>)) await m.mediaStore.delete(key);
    const rep = await renormalizeUnavailable(deps(m));
    expect(rep.skipped).toBe(rep.examined);
    expect(rep.converted).toBe(0);
  });
});
