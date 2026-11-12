// 读取口：真实 MySQL 上的五态合成（第一条纵向：推进 current → 扫描 → 读到）。
import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { signalTasks } from "../../db/schema";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertMediaAsset } from "../../../tests/harness/factories";
import { QueryCounter, SIGNALS_T0 as T0, addSnapshot, insertComment, insertMediaReference, seedContent, setCurrent } from "../../../tests/harness/signals";
import { CAP_SEGMENT_READ, type SignalActor } from "./authz";
import { CAPABILITY_VERSIONS, DEFAULT_ENABLED_CAPABILITIES } from "./catalog";
import { scanContents } from "./features/scan";
import { ingestComment } from "./features/ingest";
import { createFacts } from "./facts";
import { createReader, MAX_READ_SUBJECTS } from "./reader";
import type { HashtagParser } from "./text/hashtags";
import { NORMALIZERS } from "./text/normalize";

const t = useTestDb();
const clock = new FakeClock(new Date("2026-11-12T03:00:00.000Z"));
const actor: SignalActor = { actor: "service:test", capabilities: new Set([CAP_SEGMENT_READ]), brandScope: "all" };
const enabled = new Set(DEFAULT_ENABLED_CAPABILITIES);
const reader = (over: Partial<Parameters<typeof createReader>[0]> = {}) => createReader({ db: t.db, enabled, ...over });
const cfg = { scanBatch: 100, lookbackMs: 600_000 };
const scan = (parsers?: Record<string, HashtagParser>) => scanContents({ db: t.db, clock, config: cfg, ...(parsers ? { parsers } : {}) });
const content = (id: bigint) => ({ kind: "content", id }) as const;
const rejects = async (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe("文本信号：推进 current → 扫描 → 读到（纵向演示）", () => {
  it("一个内容走完整条链路：话题与归一化标题齐全，带版本与时间", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "ＨＩＴＡＣＨＩ　空调 #618", body: "", tagText: "#日立 #全效Ⅱ" });
    expect((await reader().read(actor, content(c.contentId), "text.title_normalized")).state).toBe("missing"); // 还没扫描：missing(not_computed)
    await scan();
    const r = reader();
    expect(await r.read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "valid", usable: true, value: "hitachi 空调 #618", normalizerVersion: 1, capability: { id: "text.normalize", version: 1 }, producedAt: clock.now() });
    expect(await r.read(actor, content(c.contentId), "text.hashtags")).toMatchObject({ state: "valid", value: ["618", "日立", "全效ii"], capability: { id: "text.hashtags.douyin", version: 1 } });
    expect(await r.read(actor, content(c.contentId), "text.body_normalized")).toMatchObject({ state: "valid", value: "" });
    // 推进到新批次的新标题，再扫一轮：读到新值
    const s2 = await addSnapshot(t.db, { contentId: c.contentId, logicalAt: new Date(T0.getTime() + 60_000), title: "新标题" });
    await setCurrent(t.db, c.contentId, s2, new Date(T0.getTime() + 60_000));
    await scan();
    expect(await r.read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "valid", value: "新标题" });
  });
  it("没有扫描过 → not_computed；能力未启用 → capability_disabled；已存储的值不受开关影响", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "标题" });
    expect(await reader({ enabled: new Set() }).read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "missing", reason: "capability_disabled" });
    expect(await reader().read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "missing", reason: "not_computed" });
    await scan();
    expect(await reader({ enabled: new Set() }).read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "valid", value: "标题" });
  });
  it("快手：正文 not_applicable(field_absent_on_platform)，标题 valid；评论信号对快手 platform_unsupported", async () => {
    const acct = await insertAccount(t.db, "kuaishou", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "k", platform: "kuaishou", title: "快手标题" });
    await scan();
    expect(await reader().read(actor, content(c.contentId), "text.body_normalized")).toMatchObject({ state: "not_applicable", reason: "field_absent_on_platform" });
    expect(await reader().read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "valid", value: "快手标题" });
    const k = await insertComment(t.db, { contentId: c.contentId, pcid: "k1", text: "快手评论" });
    expect(await reader().read(actor, { kind: "comment", id: k }, "comment.text_normalized")).toMatchObject({ state: "not_applicable", reason: "platform_unsupported" });
  });
  it("话题解析器抛错 → failed（带失败码），标题照常 valid", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "标题 #x" });
    await scan({
      douyin: () => {
        throw new Error("boom");
      },
    });
    expect(await reader().read(actor, content(c.contentId), "text.hashtags")).toMatchObject({ state: "failed", usable: false, reason: "text_parse_error", evidence: { detail: expect.stringMatching(/^sha256:/) } });
    expect((await reader().read(actor, content(c.contentId), "text.title_normalized")).state).toBe("valid");
  });
  it("评论文本：valid；NULL 正文读作 valid 的空串", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a" });
    const [k1, k2] = [await insertComment(t.db, { contentId: c.contentId, pcid: "k1", text: "Ａ好评" }), await insertComment(t.db, { contentId: c.contentId, pcid: "k2", text: null })];
    const facts = await createFacts(t.db).commentFacts([k1, k2]);
    for (const f of facts.values()) await ingestComment({ db: t.db, clock }, f);
    const got = await reader().readMany(actor, [k1, k2].map((id) => ({ kind: "comment" as const, id })), "comment.text_normalized");
    expect(got.get(k1)).toMatchObject({ state: "valid", value: "a好评" });
    expect(got.get(k2)).toMatchObject({ state: "valid", value: "" });
  });
});

describe("版本与 stale", () => {
  const versions = CAPABILITY_VERSIONS as Record<string, number>;
  const normalizers = NORMALIZERS as Record<number, (s: string) => string>;
  async function seeded() {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "标题 #618" });
    await scan();
    return c.contentId;
  }
  it("只升话题解析器版本：标题、正文仍 valid，话题读作 stale；as_unknown 时不可用且不带值", async () => {
    const id = await seeded();
    try {
      versions["text.hashtags.douyin"] = 2;
      const r = reader();
      expect((await r.read(actor, content(id), "text.title_normalized")).state).toBe("valid");
      expect((await r.read(actor, content(id), "text.body_normalized")).state).toBe("valid");
      expect(await r.read(actor, content(id), "text.hashtags")).toMatchObject({ state: "stale", usable: true, value: ["618"], capability: { version: 1 } });
      const hidden = await r.read(actor, content(id), "text.hashtags", { stalePolicy: "as_unknown" });
      expect(hidden).toMatchObject({ state: "stale", usable: false });
      expect("value" in hidden).toBe(false);
    } finally {
      versions["text.hashtags.douyin"] = 1;
    }
  });
  it("只升 text.normalize、话题解析器版本不变：标题、正文、话题、评论都读作 stale，normalizerVersion 为 1", async () => {
    const id = await seeded();
    const acct = await insertAccount(t.db, "douyin", T0);
    const other = await seedContent(t.db, { accountId: acct, pcid: "c", title: "x" });
    const k = await insertComment(t.db, { contentId: other.contentId, pcid: "k", text: "评论" });
    await ingestComment({ db: t.db, clock }, (await createFacts(t.db).commentFacts([k])).get(k)!);
    try {
      versions["text.normalize"] = 2;
      normalizers[2] = (s) => NORMALIZERS[1]!(s);
      const r = reader();
      for (const key of ["text.title_normalized", "text.body_normalized", "text.hashtags"]) expect(await r.read(actor, content(id), key), key).toMatchObject({ state: "stale", normalizerVersion: 1 });
      expect(await r.read(actor, { kind: "comment", id: k }, "comment.text_normalized")).toMatchObject({ state: "stale", normalizerVersion: 1 });
    } finally {
      versions["text.normalize"] = 1;
      delete normalizers[2];
    }
  });
  it("旧版本留下的 failed 读作 missing(failed_under_old_version)", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "x #y" });
    await scan({
      douyin: () => {
        throw new Error("boom");
      },
    });
    try {
      versions["text.hashtags.douyin"] = 2;
      expect(await reader().read(actor, content(c.contentId), "text.hashtags")).toMatchObject({ state: "missing", reason: "failed_under_old_version" });
    } finally {
      versions["text.hashtags.douyin"] = 1;
    }
  });
});

describe("结果行类信号的素材分流（取数留给任务 8）", () => {
  const param = { segment: { planId: 1n, version: 1 } };
  it("封面：无引用 / pending / failed / carried_forward / 已归档（没有结果行）→ not_applicable / missing×3 / missing(not_computed)，原因码各不相同", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const asset = await insertMediaAsset(t.db, { key: "media/c", now: T0, hex: "c" });
    const cases = [] as Array<{ id: bigint; expect: object }>;
    const add = async (pcid: string, status: "pending" | "failed" | "carried_forward" | "archived" | null, exp: object) => {
      const c = await seedContent(t.db, { accountId: acct, pcid });
      if (status) await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "cover", status, mediaAssetId: asset });
      cases.push({ id: c.contentId, expect: exp });
    };
    await add("none", null, { state: "not_applicable", reason: "no_reference" });
    await add("pend", "pending", { state: "missing", reason: "media_pending" });
    await add("fail", "failed", { state: "missing", reason: "media_failed" });
    await add("carry", "carried_forward", { state: "missing", reason: "media_carried_forward" });
    await add("ok", "archived", { state: "missing", reason: "not_computed" });
    const got = await reader({ enabled: new Set(["image.template"]) }).readMany(actor, cases.map((c) => content(c.id)), "content.cover_template_score", { param });
    expect(cases.map((c) => got.get(c.id))).toMatchObject(cases.map((c) => c.expect));
    expect(new Set(cases.map((c) => (got.get(c.id) as { reason: string }).reason)).size).toBe(5);
  });
  it("默认配置下图像类读作 capability_disabled；音频未归档优先于开关", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const asset = await insertMediaAsset(t.db, { key: "media/c2", now: T0, hex: "c2" });
    const c = await seedContent(t.db, { accountId: acct, pcid: "x" });
    await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "cover", status: "archived", mediaAssetId: asset });
    expect(await reader().read(actor, content(c.contentId), "content.cover_template_score", { param })).toMatchObject({ state: "missing", reason: "capability_disabled" });
    expect(await reader().read(actor, content(c.contentId), "content.asr_text")).toMatchObject({ state: "missing", reason: "audio_not_archived" });
  });
  it("语音类：已归档音频 + 没有网关 → capability_disabled；网关 activeModel 为空同样", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const asset = await insertMediaAsset(t.db, { key: "media/au", now: T0, hex: "au" });
    const c = await seedContent(t.db, { accountId: acct, pcid: "x" });
    await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "audio", status: "archived", mediaAssetId: asset });
    const on = new Set(["speech.asr", "speech.judge"]);
    expect(await reader({ enabled: on }).read(actor, content(c.contentId), "content.asr_text")).toMatchObject({ reason: "capability_disabled" });
    const gw = (asr: string | null, judge: string | null) => ({ activeModel: async (p: "asr" | "judge") => (p === "asr" ? asr : judge) });
    expect(await reader({ enabled: on, gateway: gw(null, "j") }).read(actor, content(c.contentId), "content.asr_text")).toMatchObject({ reason: "capability_disabled" });
    expect(await reader({ enabled: on, gateway: gw("a", "j") }).read(actor, content(c.contentId), "content.asr_text")).toMatchObject({ reason: "not_computed" });
    // 只有 ASR 模型：转写可用，判定不可用（I15）
    expect(await reader({ enabled: on, gateway: gw("a", null) }).read(actor, content(c.contentId), "content.asr_text")).toMatchObject({ reason: "not_computed" });
    expect(await reader({ enabled: on, gateway: gw("a", null) }).read(actor, content(c.contentId), "content.asr_judgement", { param })).toMatchObject({ reason: "capability_disabled" });
  });
});

describe("读取口的约束", () => {
  it("缺 Capability：先于任何读库被拒绝（零查询）", async () => {
    const counter = new QueryCounter();
    const r = createReader({ db: createDb(t.pool, { logger: counter }), enabled });
    await rejects(r.read({ ...actor, capabilities: new Set() }, content(1n), "text.hashtags"), "forbidden");
    expect(counter.count).toBe(0);
  });
  it("目录外信号、缺 param、主体种类不符、超过 5,000、主体不存在", async () => {
    const counter = new QueryCounter();
    const r = createReader({ db: createDb(t.pool, { logger: counter }), enabled });
    await rejects(r.read(actor, content(1n), "content.cover_ocr_text"), "signal_unregistered");
    await rejects(r.read(actor, content(1n), "content.cover_template_score"), "param_required");
    await rejects(r.read(actor, { kind: "account", id: 1n }, "text.hashtags"), "subject_kind_mismatch");
    await rejects(r.readMany(actor, Array.from({ length: MAX_READ_SUBJECTS + 1 }, (_, i) => content(BigInt(i + 1))), "text.hashtags"), "too_many_subjects");
    expect(counter.count).toBe(0); // 以上都在读库之前被拒绝
    await rejects(r.read(actor, content(999999n), "text.hashtags"), "subject_not_found");
  });
  it("read / readMany 不创建任务：任务表行数不变", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a" });
    const asset = await insertMediaAsset(t.db, { key: "media/z", now: T0, hex: "z" });
    await insertMediaReference(t.db, { contentSnapshotId: c.snapshotId, role: "cover", status: "archived", mediaAssetId: asset });
    const before = await t.db.select({ n: count() }).from(signalTasks);
    const r = reader({ enabled: new Set(["image.template", ...DEFAULT_ENABLED_CAPABILITIES]) });
    for (const key of ["text.title_normalized", "content.asr_text"]) await r.read(actor, content(c.contentId), key);
    await r.read(actor, content(c.contentId), "content.cover_template_score", { param: { segment: { planId: 1n, version: 1 } } });
    expect(await t.db.select({ n: count() }).from(signalTasks)).toEqual(before);
  });
  it("readMany 的查询次数与主体数无关", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const ids: bigint[] = [];
    for (let i = 0; i < 40; i++) ids.push((await seedContent(t.db, { accountId: acct, pcid: `n${i}` })).contentId);
    await scan();
    const counter = new QueryCounter();
    const r = createReader({ db: createDb(t.pool, { logger: counter }), enabled });
    for (const key of ["text.hashtags", "content.asr_text"]) {
      counter.count = 0;
      await r.readMany(actor, ids.slice(0, 2).map(content), key);
      const few = counter.count;
      counter.count = 0;
      expect((await r.readMany(actor, ids.map(content), key)).size).toBe(40);
      expect(counter.count, key).toBe(few);
    }
  });
});
