// facts.ts 对真实 MySQL 的读取：current 快照文本、素材状态、音频、对象位置、重算范围展开。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { comments, contentSnapshots, contents, externalAccounts, ossObjects, staffAccountAssignments } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment, insertBatch, insertContent, insertContentSnapshot, insertMediaAsset, insertProfileSnapshot, sha } from "../../../tests/harness/factories";
import { insertStaff } from "../../../tests/harness/plan";
import { seedOrg } from "../../../tests/harness/seed";
import { QueryCounter, SIGNALS_T0 as T0, insertMediaReference } from "../../../tests/harness/signals";
import { createFacts } from "./facts";

const t = useTestDb();
const facts = () => createFacts(t.db);
const BIG = 9007199254740993n; // 2^53 + 1：任何经过 Number 的路径都会读成 2^53

/** 内容 + 一个快照；current 为真时把它设成 current（status 决定 finalized / building）。 */
async function mkContent(accountId: bigint, pcid: string, o: { batchId?: bigint; current?: boolean; status?: "building" | "finalized"; title?: string | null; body?: string | null; tagText?: string | null; publishedAt?: Date } = {}) {
  const batchId = o.batchId ?? (await insertBatch(t.db, T0));
  const contentId = await insertContent(t.db, { platform: "douyin", accountId, platformContentId: pcid, now: T0 });
  const snapshotId = await insertContentSnapshot(t.db, { batchId, contentId, now: T0, status: o.status ?? "finalized" });
  await t.db
    .update(contentSnapshots)
    .set({ title: o.title === undefined ? null : o.title, body: o.body === undefined ? null : o.body, tagText: o.tagText === undefined ? null : o.tagText, publishedAt: o.publishedAt ?? null })
    .where(eq(contentSnapshots.contentSnapshotId, snapshotId));
  if (o.current ?? true) await t.db.update(contents).set({ currentSnapshotId: snapshotId, currentSnapshotSelectedAt: T0 }).where(eq(contents.contentId, contentId));
  return { batchId, contentId, snapshotId };
}

/** 外部型账号的 assignment（不占专员名额），用于只需要账号与主页快照的用例。 */
async function mkExternalAccount(accountId?: bigint): Promise<{ accountId: bigint; assignmentId: bigint }> {
  const id = await insertAccount(t.db, "douyin", T0, accountId);
  const loc = `https://example.test/ext/${id}`;
  const [r] = await t.db.insert(staffAccountAssignments).values({
    watchType: "external",
    accountId: id,
    platformId: (await t.db.select({ p: externalAccounts.platformId }).from(externalAccounts).where(eq(externalAccounts.accountId, id)))[0]!.p,
    currentHomeLocator: loc,
    currentHomeLocatorSha256: sha(loc),
    resolvedHomeUrl: loc,
    resolvedHomeUrlSha256: sha(loc),
    intakeStatus: "normal",
    createdAt: T0,
    updatedAt: T0,
  });
  return { accountId: id, assignmentId: BigInt(r.insertId) };
}

describe("contentFacts", () => {
  it("返回 finalized current 快照的文本；NULL 与空串保持区别；没有 current 或 current 不是 finalized 的内容不在结果里", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const a = await mkContent(acct, "a", { title: "标题", body: "", tagText: null });
    const noCurrent = await mkContent(acct, "b", { current: false });
    const building = await mkContent(acct, "c", { status: "building" });
    const got = await facts().contentFacts([a.contentId, noCurrent.contentId, building.contentId, 999999n]);
    expect([...got.keys()]).toEqual([a.contentId]);
    expect(got.get(a.contentId)).toMatchObject({ platform: "douyin", snapshotId: a.snapshotId, title: "标题", body: "", tagText: null });
    expect(got.get(a.contentId)!.batchOrder).toEqual({ logicalAt: T0, batchId: a.batchId });
  });
  it("查询次数与内容数无关", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const batchId = await insertBatch(t.db, T0);
    const ids: bigint[] = [];
    for (let i = 0; i < 30; i++) ids.push((await mkContent(acct, `n${i}`, { batchId })).contentId);
    const counter = new QueryCounter();
    const f = createFacts(createDb(t.pool, { logger: counter }));
    await f.contentFacts(ids.slice(0, 1));
    const one = counter.count;
    counter.count = 0;
    expect((await f.contentFacts(ids)).size).toBe(30);
    expect(counter.count).toBe(one);
    expect(await f.contentFacts([])).toEqual(new Map()); // 空输入不发查询
    expect(counter.count).toBe(one);
  });
});

describe("commentFacts", () => {
  it("评论正文 NULL 与空串保持区别，带平台与状态", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await mkContent(acct, "a");
    const ins = async (pcid: string, text: string | null, status = "active") => {
      const [r] = await t.db.insert(comments).values({
        contentId: c.contentId,
        platformCommentId: pcid,
        platformCommentIdSha256: sha(pcid),
        status,
        contentText: text,
        likeState: "missing",
        replyState: "missing",
        firstSeenAt: T0,
        lastSeenAt: T0,
        createdAt: T0,
        updatedAt: T0,
      });
      return BigInt(r.insertId);
    };
    const nul = await ins("n", null);
    const empty = await ins("e", "");
    const sus = await ins("s", "疑似删除", "suspected_deleted");
    const got = await facts().commentFacts([nul, empty, sus]);
    expect(got.get(nul)).toMatchObject({ contentId: c.contentId, platform: "douyin", status: "active", contentText: null });
    expect(got.get(empty)!.contentText).toBe("");
    expect(got.get(sus)).toMatchObject({ status: "suspected_deleted", contentText: "疑似删除" });
  });
});

describe("coverMaterial：封面素材（requirements R12）", () => {
  /** 同一内容在第 0、1、2… 个批次各一个 finalized 快照（批次时间递增）。 */
  async function snapshots(pcid: string, n: number): Promise<{ contentId: bigint; snaps: bigint[] }> {
    const acct = await insertAccount(t.db, "douyin", T0);
    const first = await mkContent(acct, pcid, { current: false });
    const snaps = [first.snapshotId];
    for (let i = 1; i < n; i++) {
      const batchId = await insertBatch(t.db, new Date(T0.getTime() + i * 1000));
      snaps.push(await insertContentSnapshot(t.db, { batchId, contentId: first.contentId, now: T0, status: "finalized" }));
    }
    await t.db.update(contents).set({ currentSnapshotId: snaps[n - 1]!, currentSnapshotSelectedAt: T0 }).where(eq(contents.contentId, first.contentId));
    return { contentId: first.contentId, snaps };
  }
  const cover = async (contentId: bigint) => (await facts().coverMaterial([contentId])).get(contentId);

  it("内容从没有过 cover 引用 → not_applicable", async () => {
    const { contentId } = await snapshots("none", 2);
    expect(await cover(contentId)).toEqual({ state: "not_applicable", reason: "no_reference" });
  });
  it("A 的封面首次规则：封面在第一个批次归档，current 是第三个批次且没有 cover 引用 → 仍是 ready", async () => {
    const { contentId, snaps } = await snapshots("first-rule", 3);
    const asset = await insertMediaAsset(t.db, { key: "media/cover1", now: T0, hex: "cover-bytes" });
    await insertMediaReference(t.db, { contentSnapshotId: snaps[0]!, role: "cover", status: "archived", mediaAssetId: asset });
    expect(await cover(contentId)).toEqual({ state: "ready", assetId: asset, sha256: sha("cover-bytes") });
  });
  it("更新批次的 pending 引用不盖住更早批次已归档的封面（同步进行中的瞬态）", async () => {
    const { contentId, snaps } = await snapshots("pending-newer", 2);
    const asset = await insertMediaAsset(t.db, { key: "media/cover2", now: T0, hex: "cover2" });
    await insertMediaReference(t.db, { contentSnapshotId: snaps[0]!, role: "cover", status: "archived", mediaAssetId: asset });
    await insertMediaReference(t.db, { contentSnapshotId: snaps[1]!, role: "cover", status: "pending" });
    expect(await cover(contentId)).toMatchObject({ state: "ready", assetId: asset });
  });
  it("没有可用封面时取批次最新的一条按状态映射", async () => {
    const asset = await insertMediaAsset(t.db, { key: "media/cover3", now: T0, hex: "cover3" });
    const cases: Array<[Array<"pending" | "failed" | "carried_forward">, string]> = [
      [["failed", "pending"], "media_pending"], // 最新的是 pending
      [["pending", "failed"], "media_failed"], // 最新的是 failed
      [["failed", "carried_forward"], "media_carried_forward"],
    ];
    for (const [i, [statuses, reason]] of cases.entries()) {
      const { contentId, snaps } = await snapshots(`latest-${i}`, 2);
      for (const [j, status] of statuses.entries()) await insertMediaReference(t.db, { contentSnapshotId: snaps[j]!, role: "cover", status, ...(status === "carried_forward" ? { mediaAssetId: asset } : {}) });
      expect(await cover(contentId), statuses.join(">")).toEqual({ state: "missing", reason });
    }
  });
  it("只看 role=cover：同内容的音频引用不会被当成封面", async () => {
    const { contentId, snaps } = await snapshots("audio-only", 1);
    const asset = await insertMediaAsset(t.db, { key: "media/au", now: T0, hex: "au" });
    await insertMediaReference(t.db, { contentSnapshotId: snaps[0]!, role: "audio", status: "archived", mediaAssetId: asset });
    expect(await cover(contentId)).toEqual({ state: "not_applicable", reason: "no_reference" });
  });
});

describe("profileMaterial：账号头像 / 背景素材", () => {
  it("没有 current 主页快照 → missing(no_profile_snapshot)；有快照没引用 → not_applicable；四种归档状态各自映射；头像与背景互不串", async () => {
    const mk = async (withSnapshot: boolean) => {
      const a = await mkExternalAccount();
      if (!withSnapshot) return { ...a, snap: null as bigint | null };
      const snap = await insertProfileSnapshot(t.db, { batchId: await insertBatch(t.db, T0), accountId: a.accountId, assignmentId: a.assignmentId, now: T0 });
      await t.db.update(externalAccounts).set({ currentProfileSnapshotId: snap }).where(eq(externalAccounts.accountId, a.accountId));
      return { ...a, snap };
    };
    const none = await mk(false);
    const noRef = await mk(true);
    const pending = await mk(true);
    const failed = await mk(true);
    const carried = await mk(true);
    const archived = await mk(true);
    const asset = await insertMediaAsset(t.db, { key: "media/avatar", now: T0, hex: "avatar-bytes" });
    await insertMediaReference(t.db, { profileSnapshotId: pending.snap!, role: "avatar", status: "pending" });
    await insertMediaReference(t.db, { profileSnapshotId: failed.snap!, role: "avatar", status: "failed" });
    await insertMediaReference(t.db, { profileSnapshotId: carried.snap!, role: "avatar", status: "carried_forward", mediaAssetId: asset });
    await insertMediaReference(t.db, { profileSnapshotId: archived.snap!, role: "avatar", status: "archived", mediaAssetId: asset });
    await insertMediaReference(t.db, { profileSnapshotId: noRef.snap!, role: "background", status: "archived", mediaAssetId: asset }); // 只有背景，没有头像

    const ids = [none, noRef, pending, failed, carried, archived].map((x) => x.accountId);
    const avatar = await facts().profileMaterial(ids, "avatar");
    expect(ids.map((i) => avatar.get(i))).toEqual([
      { state: "missing", reason: "no_profile_snapshot" },
      { state: "not_applicable", reason: "no_reference" },
      { state: "missing", reason: "media_pending" },
      { state: "missing", reason: "media_failed" },
      { state: "missing", reason: "media_carried_forward" },
      { state: "ready", assetId: asset, sha256: sha("avatar-bytes") },
    ]);
    const background = await facts().profileMaterial([noRef.accountId, archived.accountId], "background");
    expect(background.get(noRef.accountId)).toMatchObject({ state: "ready", assetId: asset });
    expect(background.get(archived.accountId)).toEqual({ state: "not_applicable", reason: "no_reference" });
  });
  it("账号 ID 超过 2^53 时精确往返", async () => {
    const a = await mkExternalAccount(BIG);
    const got = await facts().profileMaterial([BIG], "avatar");
    expect([...got.keys()]).toEqual([BIG]);
    expect(a.accountId).toBe(BIG);
  });
});

describe("audioMaterial", () => {
  it("取该内容任一快照下已归档的音频（音频字节不随快照变化）；pending / 没有 → missing(audio_not_archived)", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const older = await mkContent(acct, "older-has-audio", { current: false });
    // 同一内容的更新批次：current 快照上没有音频引用
    const newerBatch = await insertBatch(t.db, new Date(T0.getTime() + 1000));
    const newerSnap = await insertContentSnapshot(t.db, { batchId: newerBatch, contentId: older.contentId, now: T0, status: "finalized" });
    await t.db.update(contents).set({ currentSnapshotId: newerSnap, currentSnapshotSelectedAt: T0 }).where(eq(contents.contentId, older.contentId));
    const asset = await insertMediaAsset(t.db, { key: "media/audio", now: T0, hex: "audio-bytes" });
    await insertMediaReference(t.db, { contentSnapshotId: older.snapshotId, role: "audio", status: "archived", mediaAssetId: asset });
    const pending = await mkContent(acct, "pending");
    await insertMediaReference(t.db, { contentSnapshotId: pending.snapshotId, role: "audio", status: "pending" });
    const none = await mkContent(acct, "none");

    const got = await facts().audioMaterial([older.contentId, pending.contentId, none.contentId]);
    expect(got.get(older.contentId)).toEqual({ state: "ready", assetId: asset, sha256: sha("audio-bytes") });
    expect(got.get(pending.contentId)).toEqual({ state: "missing", reason: "audio_not_archived" });
    expect(got.get(none.contentId)).toEqual({ state: "missing", reason: "audio_not_archived" });
  });
  it("多个已归档音频时取最新批次的那条", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const first = await mkContent(acct, "two-audio", { current: false });
    const laterBatch = await insertBatch(t.db, new Date(T0.getTime() + 5000));
    const laterSnap = await insertContentSnapshot(t.db, { batchId: laterBatch, contentId: first.contentId, now: T0, status: "finalized" });
    const oldAsset = await insertMediaAsset(t.db, { key: "media/old", now: T0, hex: "old" });
    const newAsset = await insertMediaAsset(t.db, { key: "media/new", now: T0, hex: "new" });
    await insertMediaReference(t.db, { contentSnapshotId: first.snapshotId, role: "audio", status: "archived", mediaAssetId: oldAsset });
    await insertMediaReference(t.db, { contentSnapshotId: laterSnap, role: "audio", status: "archived", mediaAssetId: newAsset });
    expect((await facts().audioMaterial([first.contentId])).get(first.contentId)).toMatchObject({ state: "ready", assetId: newAsset });
  });
});

describe("mediaObjectOf", () => {
  it("返回桶与对象 key；对象不是 available 的资产不在结果里", async () => {
    const ok = await insertMediaAsset(t.db, { key: "media/ab/ok", now: T0 });
    const pending = await insertMediaAsset(t.db, { key: "media/ab/pending", now: T0 });
    await t.db.update(ossObjects).set({ status: "available", byteLength: 10n, sha256: sha("x"), verifiedAt: T0 }).where(eq(ossObjects.objectKey, "media/ab/ok"));
    const got = await facts().mediaObjectOf([ok, pending]);
    expect(got).toEqual(new Map([[ok, { bucket: "hbecho-test", objectKey: "media/ab/ok" }]]));
  });
});

describe("scopeSubjects：重算范围展开", () => {
  /** HITACHI 门店下两个专员（账号 a1、a2），HISENSE 门店下一个专员（账号 a3，ID 超过 2^53）。 */
  async function world() {
    const org = await seedOrg(t.db, T0);
    const a1 = await insertAccount(t.db, "douyin", T0);
    const a2 = await insertAccount(t.db, "douyin", T0);
    const a3 = await insertAccount(t.db, "douyin", T0, BIG);
    await insertAssignment(t.db, { accountId: a1, platform: "douyin", staffId: org.staffA, now: T0 });
    await insertAssignment(t.db, { accountId: a2, platform: "douyin", staffId: org.staffB, now: T0 });
    await insertAssignment(t.db, { accountId: a3, platform: "douyin", staffId: org.staffC, now: T0 });
    const batchId = await insertBatch(t.db, T0);
    const d = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`);
    const c1 = await mkContent(a1, "c1", { batchId, publishedAt: d(1) });
    const c2 = await mkContent(a1, "c2", { batchId, publishedAt: d(10) });
    const c3 = await mkContent(a2, "c3", { batchId, publishedAt: d(20) });
    const c4 = await mkContent(a3, "c4", { batchId, publishedAt: d(10) });
    const noCurrent = await mkContent(a1, "c5", { batchId, current: false });
    return { org, a1, a2, a3, c1: c1.contentId, c2: c2.contentId, c3: c3.contentId, c4: c4.contentId, noCurrent: noCurrent.contentId, d };
  }
  const run = (scope: Parameters<ReturnType<typeof facts>["scopeSubjects"]>[0], signal: string, after = 0n, limit = 100) => facts().scopeSubjects(scope, signal, after, limit);

  it("没有任何范围项：scope_required；空数组是「匹配不到任何对象」，不是「没有限制」", async () => {
    await world();
    await expect(run({}, "text.title_normalized")).rejects.toMatchObject({ category: "input", code: "scope_required" });
    expect(await run({ contentIds: [] }, "text.title_normalized")).toEqual([]);
    expect(await run({ accountIds: [] }, "account.bg_template_score")).toEqual([]);
  });
  it("内容信号：contentIds / accountIds / brandId 取交集；没有 current 快照的内容不展开", async () => {
    const w = await world();
    expect(await run({ contentIds: [w.c1, w.c3, w.noCurrent] }, "text.hashtags")).toEqual([w.c1, w.c3]);
    expect(await run({ accountIds: [w.a1] }, "text.hashtags")).toEqual([w.c1, w.c2]);
    expect(await run({ brandId: w.org.hitachiBrandId }, "text.hashtags")).toEqual([w.c1, w.c2, w.c3]);
    expect(await run({ brandId: w.org.hisenseBrandId }, "text.hashtags")).toEqual([w.c4]);
    expect(await run({ brandId: w.org.hitachiBrandId, accountIds: [w.a2, w.a3] }, "text.hashtags")).toEqual([w.c3]);
  });
  it("品牌经账号的当前归属展开：账号换店后跟着走", async () => {
    const w = await world();
    const hisenseStaff = await insertStaff(t.db, { storeId: w.org.otherStoreId, phone: "13900000009" });
    await t.db.update(staffAccountAssignments).set({ staffId: hisenseStaff }).where(eq(staffAccountAssignments.accountId, w.a1));
    expect(await run({ brandId: w.org.hitachiBrandId }, "text.hashtags")).toEqual([w.c3]);
    expect(await run({ brandId: w.org.hisenseBrandId }, "text.hashtags")).toEqual([w.c1, w.c2, w.c4]);
  });
  it("发布时间范围是 [from, to)", async () => {
    const w = await world();
    expect(await run({ publishedFrom: w.d(10), publishedTo: w.d(20) }, "text.hashtags")).toEqual([w.c2, w.c4]); // 10 日含，20 日不含
    expect(await run({ publishedFrom: w.d(20) }, "text.hashtags")).toEqual([w.c3]);
    expect(await run({ publishedTo: w.d(2) }, "text.hashtags")).toEqual([w.c1]);
  });
  it("按 ID 升序分页：after 之后，至多 limit 个", async () => {
    const w = await world();
    const all = await run({ brandId: w.org.hitachiBrandId }, "text.hashtags");
    expect(await run({ brandId: w.org.hitachiBrandId }, "text.hashtags", 0n, 2)).toEqual(all.slice(0, 2));
    expect(await run({ brandId: w.org.hitachiBrandId }, "text.hashtags", all[1]!, 2)).toEqual(all.slice(2));
  });
  it("账号信号：accountIds / brandId；ID 超过 2^53 精确往返；时间范围与 contentIds 不适用", async () => {
    const w = await world();
    expect(await run({ brandId: w.org.hitachiBrandId }, "account.bg_template_score")).toEqual([w.a1, w.a2]);
    expect(await run({ accountIds: [BIG] }, "account.avatar_element_score")).toEqual([BIG]);
    expect(await run({ brandId: w.org.hisenseBrandId }, "account.avatar_element_score")).toEqual([BIG]);
    for (const scope of [{ publishedFrom: w.d(1) }, { contentIds: [w.c1] }]) {
      await expect(run(scope, "account.bg_template_score")).rejects.toMatchObject({ code: "scope_not_applicable" });
    }
  });
  it("评论信号：按内容范围展开出内容下 active 的评论", async () => {
    const w = await world();
    const ins = async (contentId: bigint, pcid: string, status: string) => {
      const [r] = await t.db.insert(comments).values({ contentId, platformCommentId: pcid, platformCommentIdSha256: sha(pcid), status, likeState: "missing", replyState: "missing", firstSeenAt: T0, lastSeenAt: T0, createdAt: T0, updatedAt: T0 });
      return BigInt(r.insertId);
    };
    const k1 = await ins(w.c1, "k1", "active");
    await ins(w.c1, "k2", "suspected_deleted");
    const k3 = await ins(w.c3, "k3", "active");
    const k4 = await ins(w.c4, "k4", "active");
    await ins(w.noCurrent, "k5", "active");
    expect(await run({ brandId: w.org.hitachiBrandId }, "comment.text_normalized")).toEqual([k1, k3]);
    expect(await run({ contentIds: [w.c4] }, "comment.text_normalized")).toEqual([k4]);
  });
  it("目录外的信号键 signal_unregistered", async () => {
    await expect(run({ contentIds: [1n] }, "content.cover_ocr_text")).rejects.toMatchObject({ code: "signal_unregistered" });
  });
});
