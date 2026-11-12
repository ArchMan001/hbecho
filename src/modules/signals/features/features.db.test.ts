// 任务 4：特征行写入（CAS + 历史）、扫描驱动、对账。FakeClock，真实 MySQL。
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { commentFeatures, contentFeatures, signalCursors, signalHistory } from "../../../db/schema";
import { FakeClock } from "../../../../tests/harness/fake-clock";
import { useTestDb } from "../../../../tests/harness/db";
import { insertAccount } from "../../../../tests/harness/factories";
import { SIGNALS_T0 as T0, addSnapshot, insertComment, seedContent, setCurrent } from "../../../../tests/harness/signals";
import { CAPABILITY_VERSIONS } from "../catalog";
import { createFacts } from "../facts";
import { NORMALIZERS } from "../text/normalize";
import type { HashtagParser } from "../text/hashtags";
import { ingestComment, ingestContent } from "./ingest";
import { reconcileContents, scanComments, scanContents, type ScanDeps } from "./scan";

const t = useTestDb();
const clock = new FakeClock(new Date("2026-11-12T03:00:00.000Z"));
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const deps = (over: Partial<ScanDeps> = {}): ScanDeps => ({ db: t.db, clock, config: { scanBatch: 2, lookbackMs: 10 * 60_000 }, ...over });
const feature = async (contentId: bigint) => (await t.db.select().from(contentFeatures).where(eq(contentFeatures.contentId, contentId)))[0];
// 信封是 MySQL JSON，键序按长度排；历史按信号键排序后断言，不依赖写入顺序
const history = (subjectId: bigint) => t.db.select().from(signalHistory).where(eq(signalHistory.subjectId, subjectId)).orderBy(asc(signalHistory.signalKey));
const factOf = async (contentId: bigint) => (await createFacts(t.db).contentFacts([contentId])).get(contentId)!;

describe("ingestContent：特征行写入", () => {
  it("新内容：三个信号 valid，值与信封一致，信封带 cap / ver / nv / at", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "ＨＩＴＡＣＨＩ　空调 #618", body: "", tagText: "#日立 #全效Ⅱ" });
    expect(await ingestContent(deps(), await factOf(c.contentId))).toBe("created");
    const row = (await feature(c.contentId))!;
    expect([row.titleNormalized, row.bodyNormalized, row.hashtags]).toEqual(["hitachi 空调 #618", "", ["618", "日立", "全效ii"]]);
    expect(row.contentSnapshotId).toBe(c.snapshotId);
    expect(row.signals).toEqual({
      "text.title_normalized": { state: "valid", cap: "text.normalize", ver: 1, nv: 1, at: clock.now().toISOString() },
      "text.body_normalized": { state: "valid", cap: "text.normalize", ver: 1, nv: 1, at: clock.now().toISOString() },
      "text.hashtags": { state: "valid", cap: "text.hashtags.douyin", ver: 1, nv: 1, at: clock.now().toISOString() },
    });
  });
  it("NULL 标题 / 正文在有字段的平台读作 valid 的空串；原文 NULL 与空串的素材指纹不同", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const a = await seedContent(t.db, { accountId: acct, pcid: "null", title: null, body: null });
    const b = await seedContent(t.db, { accountId: acct, pcid: "empty", title: "", body: "" });
    await ingestContent(deps(), await factOf(a.contentId));
    await ingestContent(deps(), await factOf(b.contentId));
    const [ra, rb] = [(await feature(a.contentId))!, (await feature(b.contentId))!];
    expect([ra.titleNormalized, ra.bodyNormalized, rb.titleNormalized, rb.bodyNormalized]).toEqual(["", "", "", ""]);
    expect(ra.hashtags).toEqual([]);
    expect(ra.textMaterialSha256.equals(rb.textMaterialSha256)).toBe(false);
  });
  it("快手没有正文字段：正文列为空、信封没有条目（读取时推出 not_applicable）", async () => {
    const acct = await insertAccount(t.db, "kuaishou", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "k", platform: "kuaishou", title: "快手标题", body: null });
    await ingestContent(deps(), await factOf(c.contentId));
    const row = (await feature(c.contentId))!;
    expect(row.bodyNormalized).toBeNull();
    expect(Object.keys(row.signals as object).sort()).toEqual(["text.hashtags", "text.title_normalized"]);
    expect((row.signals as Record<string, { cap: string }>)["text.hashtags"]!.cap).toBe("text.hashtags.kuaishou");
  });
  it("同一快照重复处理：无写入（updated_at 不变）、无历史", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "标题" });
    await ingestContent(deps(), await factOf(c.contentId));
    const before = (await feature(c.contentId))!;
    clock.advance(60_000);
    expect(await ingestContent(deps(), await factOf(c.contentId))).toBe("unchanged");
    expect(await feature(c.contentId)).toEqual(before);
    expect(await history(c.contentId)).toEqual([]);
  });
  it("新批次、素材未变：只前移所持快照，值与信封不动，历史不增", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", logicalAt: at(0), title: "标题" });
    await ingestContent(deps(), await factOf(c.contentId));
    const before = (await feature(c.contentId))!;
    const s2 = await addSnapshot(t.db, { contentId: c.contentId, logicalAt: at(5), title: "标题" });
    await setCurrent(t.db, c.contentId, s2, at(5));
    clock.advance(60_000);
    expect(await ingestContent(deps(), await factOf(c.contentId))).toBe("advanced");
    const after = (await feature(c.contentId))!;
    expect(after.contentSnapshotId).toBe(s2);
    expect({ ...after, contentSnapshotId: 0n, updatedAt: before.updatedAt }).toEqual({ ...before, contentSnapshotId: 0n });
    expect(await history(c.contentId)).toEqual([]);
  });
  it("标题改了：特征行更新，历史新增三行（旧值、旧快照、旧版本、material_changed、一年保留）", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", logicalAt: at(0), title: "旧标题 #a" });
    await ingestContent(deps(), await factOf(c.contentId));
    const s2 = await addSnapshot(t.db, { contentId: c.contentId, logicalAt: at(5), title: "新标题 #b" });
    await setCurrent(t.db, c.contentId, s2, at(5));
    clock.advance(60_000);
    expect(await ingestContent(deps(), await factOf(c.contentId))).toBe("updated");
    const row = (await feature(c.contentId))!;
    expect([row.titleNormalized, row.hashtags, row.contentSnapshotId]).toEqual(["新标题 #b", ["b"], s2]);
    const h = await history(c.contentId);
    expect(h.map((x) => [x.signalKey, x.value])).toEqual([
      ["text.body_normalized", ""],
      ["text.hashtags", ["a"]],
      ["text.title_normalized", "旧标题 #a"],
    ]);
    expect(h.every((x) => x.supersededReason === "material_changed" && x.normalizerVersion === 1 && x.capabilityVersion === 1 && x.subjectKind === "content" && x.subjectSnapshotId === c.snapshotId)).toBe(true);
    expect(h[0]!.supersededAt).toEqual(clock.now());
    expect(h[0]!.expiresAt).toEqual(new Date(Date.UTC(clock.now().getUTCFullYear() + 1, clock.now().getUTCMonth(), clock.now().getUTCDate(), clock.now().getUTCHours(), clock.now().getUTCMinutes(), clock.now().getUTCSeconds())));
  });
  it("批次 5 之后迟到批次 3：skipped_older，特征行不变", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", logicalAt: at(5), title: "批次 5" });
    await ingestContent(deps(), await factOf(c.contentId));
    const before = (await feature(c.contentId))!;
    // 旧批次迟到：直接构造一个批次 3 的事实交给 ingest（current 指针本身不会倒退，但 ingest 自己也要守住）
    const s3 = await addSnapshot(t.db, { contentId: c.contentId, logicalAt: at(3), title: "批次 3" });
    await setCurrent(t.db, c.contentId, s3, at(6));
    expect(await ingestContent(deps(), await factOf(c.contentId))).toBe("skipped_older");
    expect(await feature(c.contentId)).toEqual(before);
    expect(await history(c.contentId)).toEqual([]);
  });
  it("话题解析器抛错：hashtags 为 failed（列为空，信封带失败码与摘要），标题与正文照常写入", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "内部活动 #机密话题" });
    const boom: HashtagParser = () => {
      throw new Error("炸了");
    };
    expect(await ingestContent(deps({ parsers: { douyin: boom } }), await factOf(c.contentId))).toBe("created");
    const row = (await feature(c.contentId))!;
    expect([row.titleNormalized, row.hashtags]).toEqual(["内部活动 #机密话题", null]);
    const env = row.signals as Record<string, { state: string; code?: string; detail?: string }>;
    expect([env["text.title_normalized"]!.state, env["text.hashtags"]!.state, env["text.hashtags"]!.code]).toEqual(["valid", "failed", "text_parse_error"]);
    expect(env["text.hashtags"]!.detail).toMatch(/^sha256:[0-9a-f]{16};len=\d+$/);
    expect(JSON.stringify(row.signals)).not.toContain("机密话题");
  });
});

describe("ingestContent mode=recompute", () => {
  it("素材未变、信封落后（缺 nv）的行：批次相同也重算，历史记 capability_upgraded，nv 更新", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "标题 #a" });
    await ingestContent(deps(), await factOf(c.contentId));
    // 模拟旧代码写入的行：信封里没有 nv（nv 缺失按落后处理）
    const old = (await feature(c.contentId))!;
    const stale = Object.fromEntries(Object.entries(old.signals as Record<string, object>).map(([k, v]) => [k, { ...v, nv: undefined }]));
    await t.db.update(contentFeatures).set({ signals: stale }).where(eq(contentFeatures.contentId, c.contentId));
    clock.advance(1000);
    expect(await ingestContent(deps(), await factOf(c.contentId), "normal")).toBe("unchanged"); // 正常扫描不主动重算历史
    expect(await ingestContent(deps(), await factOf(c.contentId), "recompute")).toBe("updated");
    const row = (await feature(c.contentId))!;
    expect(Object.values(row.signals as Record<string, { nv: number }>).map((e) => e.nv)).toEqual([1, 1, 1]);
    const h = await history(c.contentId);
    expect(h).toHaveLength(3);
    expect(h.every((x) => x.supersededReason === "capability_upgraded" && x.normalizerVersion === null)).toBe(true);
    expect(await ingestContent(deps(), await factOf(c.contentId), "recompute")).toBe("unchanged"); // 已是目标版本：不再写
    expect(await history(c.contentId)).toHaveLength(3);
  });
  it("真正的版本升级：text.normalize 1 → 2 后，旧值读作落后，重算写入 nv=2，历史保留 nv=1", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "ＡＢＣ" });
    await ingestContent(deps(), await factOf(c.contentId));
    const versions = CAPABILITY_VERSIONS as Record<string, number>;
    const normalizers = NORMALIZERS as Record<number, (s: string) => string>;
    try {
      versions["text.normalize"] = 2;
      normalizers[2] = (s) => `v2:${NORMALIZERS[1]!(s)}`;
      expect(await ingestContent(deps(), await factOf(c.contentId), "normal")).toBe("unchanged"); // 不主动重算
      expect(await ingestContent(deps(), await factOf(c.contentId), "recompute")).toBe("updated");
      const row = (await feature(c.contentId))!;
      expect(row.titleNormalized).toBe("v2:abc");
      expect((row.signals as Record<string, { nv: number; ver: number }>)["text.title_normalized"]).toMatchObject({ nv: 2, ver: 2 });
      expect((await history(c.contentId)).map((h) => h.normalizerVersion)).toEqual([1, 1, 1]);
    } finally {
      versions["text.normalize"] = 1;
      delete normalizers[2];
    }
  });
  it("recompute 也不让特征行倒退到严格更旧的批次", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", logicalAt: at(5), title: "批次 5" });
    await ingestContent(deps(), await factOf(c.contentId));
    const s3 = await addSnapshot(t.db, { contentId: c.contentId, logicalAt: at(3), title: "批次 3" });
    await setCurrent(t.db, c.contentId, s3, at(6));
    expect(await ingestContent(deps(), await factOf(c.contentId), "recompute")).toBe("skipped_older");
  });
});

describe("ingestComment", () => {
  it("正文 NULL 与空串都读 valid 的空值但指纹不同；正文改了更新并写历史；表里没有作者 / 点赞列", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a" });
    const [nul, empty, text] = [await insertComment(t.db, { contentId: c.contentId, pcid: "n", text: null }), await insertComment(t.db, { contentId: c.contentId, pcid: "e", text: "" }), await insertComment(t.db, { contentId: c.contentId, pcid: "t", text: "Ａ好" })];
    const got = await createFacts(t.db).commentFacts([nul, empty, text]);
    for (const id of [nul, empty, text]) expect(await ingestComment(deps(), got.get(id)!)).toBe("created");
    const rows = await t.db.select().from(commentFeatures);
    const by = new Map(rows.map((r) => [r.commentId, r]));
    expect([by.get(nul)!.textNormalized, by.get(empty)!.textNormalized, by.get(text)!.textNormalized]).toEqual(["", "", "a好"]);
    expect(by.get(nul)!.textMaterialSha256.equals(by.get(empty)!.textMaterialSha256)).toBe(false);
    expect(await ingestComment(deps(), got.get(text)!)).toBe("unchanged");
    // 平台改了评论
    const changed = { ...got.get(text)!, contentText: "改过的评论" };
    clock.advance(1000);
    expect(await ingestComment(deps(), changed)).toBe("updated");
    const h = await history(text);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ subjectKind: "comment", signalKey: "comment.text_normalized", value: "a好", supersededReason: "material_changed", subjectSnapshotId: null });
    // C 的表不含评论作者 / 点赞
    const [cols] = await t.pool.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN ('comment_features','signal_history')");
    expect((cols as Array<{ c: string }>).map((r) => r.c).filter((c) => /author|nickname|like|reply/i.test(c))).toEqual([]);
  });
  it("suspected_deleted / deleted 的评论不新抽取；快手没有评论", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a" });
    const sus = await insertComment(t.db, { contentId: c.contentId, pcid: "s", text: "x", status: "suspected_deleted" });
    const got = await createFacts(t.db).commentFacts([sus]);
    expect(await ingestComment(deps(), got.get(sus)!)).toBe("skipped_inactive");
    expect(await t.db.select().from(commentFeatures)).toEqual([]);
    expect(await ingestComment(deps(), { ...got.get(sus)!, status: "active", platform: "kuaishou" })).toBe("unsupported_platform");
  });
});

describe("扫描驱动", () => {
  it("游标之后的内容被处理，游标前移；空转的下一 tick 无写入、游标不动", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const [a, b, c] = [await seedContent(t.db, { accountId: acct, pcid: "a", selectedAt: at(1) }), await seedContent(t.db, { accountId: acct, pcid: "b", selectedAt: at(2) }), await seedContent(t.db, { accountId: acct, pcid: "c", selectedAt: at(3) })];
    const r1 = await scanContents(deps()); // 批量 2：只拿前两个
    expect(r1).toMatchObject({ scanned: 2, created: 2 });
    expect((await t.db.select().from(contentFeatures)).map((r) => r.contentId)).toEqual([a.contentId, b.contentId]);
    const r2 = await scanContents(deps());
    expect(r2).toMatchObject({ scanned: 1, created: 1 });
    const [cur] = await t.db.select().from(signalCursors).where(eq(signalCursors.cursorName, "content_scan"));
    expect([cur!.watermarkAt, cur!.watermarkId]).toEqual([at(3), c.contentId]);
    const r3 = await scanContents(deps());
    expect(r3.created + r3.updated + r3.advanced).toBe(0);
    const [again] = await t.db.select().from(signalCursors).where(eq(signalCursors.cursorName, "content_scan"));
    expect(again).toEqual(cur);
  });
  it("没有 current 指针的内容不扫", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    await seedContent(t.db, { accountId: acct, pcid: "x", current: false });
    expect(await scanContents(deps())).toMatchObject({ scanned: 0 });
  });
  it("回看窗口：游标已越过、但提交更晚的内容，下一 tick 的「迟到」查询补上", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    await seedContent(t.db, { accountId: acct, pcid: "a", selectedAt: at(20) });
    await scanContents(deps()); // 游标 = at(20)
    const lateOne = await seedContent(t.db, { accountId: acct, pcid: "late", selectedAt: at(15) }); // 窗口 (at(10), at(20)] 内，但 (selected_at, id) 小于游标
    const r = await scanContents(deps());
    expect(r).toMatchObject({ scanned: 1, created: 1 });
    expect(await feature(lateOne.contentId)).toBeDefined();
  });
  it("窗口之外的迟到由对账补上；一圈跑完游标归零", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    await seedContent(t.db, { accountId: acct, pcid: "a", selectedAt: at(60) });
    await scanContents(deps());
    const old = await seedContent(t.db, { accountId: acct, pcid: "old", selectedAt: at(5) }); // 窗口 (at(50), at(60)] 之外
    expect((await scanContents(deps())).scanned).toBe(0);
    expect(await feature(old.contentId)).toBeUndefined();
    const r = await reconcileContents(deps()); // 批量 2，共 2 个内容：一页读完 → 归零
    expect(r).toMatchObject({ created: 1, wrapped: true });
    expect(await feature(old.contentId)).toBeDefined();
    const [cur] = await t.db.select().from(signalCursors).where(eq(signalCursors.cursorName, "content_reconcile"));
    expect(cur!.watermarkId).toBe(0n);
  });
  it("对账分页：批量满页时游标停在页尾，下一次从那里继续", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const ids: bigint[] = [];
    for (const p of ["a", "b", "c"]) ids.push((await seedContent(t.db, { accountId: acct, pcid: p })).contentId);
    const r1 = await reconcileContents(deps());
    expect([r1.created, r1.wrapped]).toEqual([2, false]);
    const r2 = await reconcileContents(deps());
    expect([r2.created, r2.wrapped]).toEqual([1, true]);
    expect((await t.db.select().from(contentFeatures)).map((r) => r.contentId)).toEqual(ids);
  });
  it("扫描中途杀进程后重做（游标没推进）：特征行恰好一行，第二遍全是 unchanged", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    await seedContent(t.db, { accountId: acct, pcid: "a", selectedAt: at(1) });
    await seedContent(t.db, { accountId: acct, pcid: "b", selectedAt: at(2) });
    await scanContents(deps());
    await t.db.delete(signalCursors); // 模拟「特征行已写、游标还没推进」时进程退出
    const r = await scanContents(deps());
    expect(r).toMatchObject({ scanned: 2, unchanged: 2 });
    expect(await t.db.select().from(contentFeatures)).toHaveLength(2);
    expect(await t.db.select().from(signalHistory)).toEqual([]);
  });
  it("评论扫描：新评论产生特征行；suspected_deleted 不抽；正文变了更新", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a" });
    const k1 = await insertComment(t.db, { contentId: c.contentId, pcid: "k1", text: "好评", lastSeenAt: at(1) });
    await insertComment(t.db, { contentId: c.contentId, pcid: "k2", text: "疑似删除", status: "suspected_deleted", lastSeenAt: at(2) });
    expect(await scanComments(deps())).toMatchObject({ scanned: 1, created: 1 });
    expect(await t.db.select().from(commentFeatures)).toHaveLength(1);
    // 同一评论再次出现（last_seen_at 前移）、正文不变：不写入
    const { comments } = await import("../../../db/schema");
    clock.advance(1000);
    await t.db.update(comments).set({ lastSeenAt: at(3) }).where(eq(comments.commentId, k1));
    expect(await scanComments(deps())).toMatchObject({ scanned: 1, unchanged: 1 });
    // 平台改了正文
    await t.db.update(comments).set({ contentText: "改过", lastSeenAt: at(4), updatedAt: at(4) }).where(eq(comments.commentId, k1));
    expect(await scanComments(deps())).toMatchObject({ scanned: 1, updated: 1 });
    expect((await history(k1)).map((h) => h.value)).toEqual(["好评"]);
  });
});
