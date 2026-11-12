// 监控段与标准图：真实 MySQL + FakeObjectStore 故障注入。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { monitoringSegments, segmentImages } from "../../../db/schema";
import { FakeClock } from "../../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../../tests/harness/fake-oss";
import { useTestDb } from "../../../../tests/harness/db";
import { FakeAiGateway } from "../../../../tests/harness/signals";
import { ConverterError, type ImageConverter } from "../../media-archive";
import { CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, type SignalActor } from "../authz";
import { DEFAULT_ENABLED_CAPABILITIES } from "../catalog";
import type { SignalAuditEvent } from "../audit";
import { MAX_IMAGE_BYTES, createSegments, type SegmentsDeps } from "./index";

const t = useTestDb();
const actor: SignalActor = { actor: "user:7", capabilities: new Set([CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ]), brandScope: "all" };
const ALL_ENABLED = new Set([...DEFAULT_ENABLED_CAPABILITIES, "image.template", "image.element", "speech.asr", "speech.judge"]);
const PLAN = 12n;

/** PNG 魔数 + 种子；含 UNDECODABLE 的字节让转换器抛 unsupported。 */
const png = (seed: string, extra = ""): Uint8Array => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${seed}${extra}`)]);
const converter: ImageConverter = {
  async toNormalizedJpeg({ bytes }) {
    if (Buffer.from(bytes).includes("UNDECODABLE")) throw new ConverterError("unsupported", "解不开");
    return { bytes: new Uint8Array([1]), width: 540, height: 360 };
  },
};

function setup(over: Partial<SegmentsDeps> = {}) {
  const clock = new FakeClock(new Date("2026-11-12T03:00:00.000Z"));
  const store = new FakeObjectStore(clock);
  const events: SignalAuditEvent[] = [];
  const seg = createSegments({ db: t.db, clock, audit: (e) => void events.push(e), store, bucket: "hbecho-signals-test", converter, enabled: ALL_ENABLED, ...over });
  return { seg, store, events, clock };
}
const rows = () => t.db.select().from(segmentImages);
const key = (version = 1) => ({ planId: PLAN, version });
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

describe("创建与信号集合", () => {
  it("create 建草稿 v1；重复创建 segment_exists；平台非法被拒", async () => {
    const { seg, events } = setup();
    expect(await seg.create(actor, { planId: PLAN, platform: "douyin" })).toEqual(key(1));
    expect(await code(seg.create(actor, { planId: PLAN, platform: "douyin" }))).toBe("segment_exists");
    expect(await code(seg.create(actor, { planId: 13n, platform: "weibo" }))).toBe("platform_invalid");
    expect(events.map((e) => [e.event_type, e.plan_id, e.version])).toEqual([["segment_created", "12", 1]]);
  });
  it("setItems 校验：目录外、快手含账号背景、两个判定项、元素键非法、重复项、判定文本为空", async () => {
    const { seg } = setup();
    await seg.create(actor, { planId: PLAN, platform: "kuaishou" });
    const set = (items: unknown) => code(seg.setItems(actor, key(), items));
    expect(await set([{ signal: "content.cover_ocr_text" }])).toBe("signal_unregistered");
    expect(await set([{ signal: "account.bg_template_score" }])).toBe("signal_not_available_on_platform");
    expect(await set([{ signal: "comment.text_normalized" }])).toBe("signal_not_available_on_platform");
    expect(await set([{ signal: "content.asr_judgement", standard_text: "a" }, { signal: "content.asr_judgement", standard_text: "b" }])).toBe("too_many_judgements");
    expect(await set([{ signal: "content.cover_element_score" }])).toBe("element_key_invalid");
    for (const k of ["a/b", "..", ".", "", "x".repeat(65)]) expect(await set([{ signal: "content.cover_element_score", element_key: k }]), k).toBe("element_key_invalid");
    expect(await set([{ signal: "content.cover_template_score", element_key: "x" }])).toBe("element_key_unexpected");
    expect(await set([{ signal: "content.cover_element_score", element_key: "logo" }, { signal: "content.cover_element_score", element_key: "logo" }])).toBe("duplicate_item");
    expect(await set([{ signal: "content.asr_judgement", standard_text: "  " }])).toBe("standard_text_invalid");
    expect(await set([{ signal: "text.hashtags", standard_text: "x" }])).toBe("standard_text_unexpected");
    expect(await set([{ signal: "text.hashtags", bogus: 1 }])).toBe("item_invalid");
    expect(await set("nope")).toBe("items_invalid");
    expect(await set([{ signal: "content.cover_template_score" }, { signal: "content.cover_element_score", element_key: "logo" }, { signal: "content.asr_judgement", standard_text: "介绍保修政策" }])).toBe("ok");
  });
  it("没有 Capability 被拒绝", async () => {
    const { seg } = setup();
    expect(await code(seg.create({ ...actor, capabilities: new Set([CAP_SEGMENT_READ]) }, { planId: PLAN, platform: "douyin" }))).toBe("forbidden");
  });
});

describe("标准图上传", () => {
  it("同一对象第二张模板图替换前一张：数据库只有一张，旧对象在事务外被删", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const a = await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("a"));
    const b = await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("b"));
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.objectKey).toBe(b.objectKey);
    expect(r[0]).toMatchObject({ kind: "template", target: "cover", elementKey: "", bucket: "hbecho-signals-test", mime: "image/png", width: 540, height: 360 });
    expect(r[0]!.sha256.toString("hex")).toBe(b.sha256);
    expect(store.keys()).toEqual([b.objectKey]);
    expect(store.deleted).toContain(a.objectKey);
    expect(b.objectKey).toBe(`segments/12/1/cover/template/${b.sha256}`);
  });
  it("元素图按 element_key 可有多张；背景 / 头像对象各自独立", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    for (const [kind, target, el] of [["element", "cover", "logo"], ["element", "cover", "slogan"], ["template", "background", undefined], ["template", "avatar", undefined]] as const) {
      await seg.putImage(actor, { ...key(), kind, target, ...(el ? { elementKey: el } : {}) }, png(`${kind}${target}${el}`));
    }
    expect(await rows()).toHaveLength(4);
    expect(store.keys()).toHaveLength(4);
    expect(store.keys().some((k) => k.includes("/cover/element-logo/"))).toBe(true);
  });
  it("同字节替换：键相同，对象不被误删", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const a = await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("same"));
    const b = await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("same"));
    expect(b.objectKey).toBe(a.objectKey);
    expect(store.keys()).toEqual([a.objectKey]);
    expect(await rows()).toHaveLength(1);
  });
  it("快手 / 小红书的背景与头像被拒；模板图不带 element_key；元素图需要合法键", async () => {
    const { seg } = setup();
    await seg.create(actor, { planId: PLAN, platform: "xiaohongshu" });
    expect(await code(seg.putImage(actor, { ...key(), kind: "template", target: "background" }, png("a")))).toBe("signal_not_available_on_platform");
    expect(await code(seg.putImage(actor, { ...key(), kind: "template", target: "cover", elementKey: "x" }, png("a")))).toBe("element_key_unexpected");
    expect(await code(seg.putImage(actor, { ...key(), kind: "element", target: "cover", elementKey: "a/b" }, png("a")))).toBe("element_key_invalid");
  });
  it("超过 10 MiB、无法解码、不是图片：被拒绝，数据库与 OSS 都没有残留", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const slot = { ...key(), kind: "template", target: "cover" } as const;
    expect(await code(seg.putImage(actor, slot, Buffer.concat([png("big"), Buffer.alloc(MAX_IMAGE_BYTES)])))).toBe("image_too_large");
    expect(await code(seg.putImage(actor, slot, png("x", "UNDECODABLE")))).toBe("image_undecodable");
    expect(await code(seg.putImage(actor, slot, Buffer.from("<html>过期</html>")))).toBe("image_unsupported");
    expect(await code(seg.putImage(actor, slot, new Uint8Array()))).toBe("image_empty");
    expect([(await rows()).length, store.keys().length]).toEqual([0, 0]);
    // 恰好 10 MiB 可以
    expect(await code(seg.putImage(actor, slot, Buffer.concat([png("ok"), Buffer.alloc(MAX_IMAGE_BYTES - png("ok").byteLength)])))).toBe("ok");
  });
  it("put 失败：不留行；写后校验不一致（corrupt）：对象被清理、不留行", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const slot = { ...key(), kind: "template", target: "cover" } as const;
    store.inject(() => true, "fail");
    await expect(seg.putImage(actor, slot, png("a"))).rejects.toThrow(/put 失败/);
    store.inject(() => true, "corrupt");
    expect(await code(seg.putImage(actor, slot, png("b")))).toBe("store_verify_failed");
    expect([(await rows()).length, store.keys().length]).toEqual([0, 0]);
  });
  it("事务失败：刚上传的对象被清理；替换时事务失败不伤旧图（含同字节）", async () => {
    let boom = false;
    const { seg, store } = setup({
      hooks: {
        beforeImageCommit: async () => {
          if (boom) throw new Error("事务前失败");
        },
      },
    });
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const slot = { ...key(), kind: "template", target: "cover" } as const;
    const first = await seg.putImage(actor, slot, png("first"));
    boom = true;
    await expect(seg.putImage(actor, slot, png("second"))).rejects.toThrow("事务前失败");
    await expect(seg.putImage(actor, slot, png("first"))).rejects.toThrow("事务前失败"); // 同字节：键与旧行相同，不能被清理删掉
    expect(store.keys()).toEqual([first.objectKey]);
    expect((await rows())[0]!.objectKey).toBe(first.objectKey);
  });
  it("旧对象删除失败不影响提交", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const slot = { ...key(), kind: "template", target: "cover" } as const;
    const a = await seg.putImage(actor, slot, png("a"));
    store.failDelete = (k) => k === a.objectKey;
    const b = await seg.putImage(actor, slot, png("b"));
    expect((await rows())[0]!.objectKey).toBe(b.objectKey);
    expect(store.keys()).toContain(a.objectKey); // 孤儿，留给 purge 清扫
  });
  it("removeImage：删行并删对象；不存在 → image_not_found", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const slot = { ...key(), kind: "template", target: "cover" } as const;
    await seg.putImage(actor, slot, png("a"));
    await seg.removeImage(actor, slot);
    expect([(await rows()).length, store.keys().length]).toEqual([0, 0]);
    expect(await code(seg.removeImage(actor, slot))).toBe("image_not_found");
  });
});

describe("发布、不可变与可执行性", () => {
  async function ready(over: Partial<SegmentsDeps> = {}) {
    const s = setup(over);
    await s.seg.create(actor, { planId: PLAN, platform: "douyin" });
    await s.seg.setItems(actor, key(), [{ signal: "content.cover_template_score" }, { signal: "content.cover_element_score", element_key: "logo" }, { signal: "text.hashtags" }]);
    return s;
  }
  it("缺图时不可发布（not_executable 带阻塞项）；补齐后发布成功，幂等", async () => {
    const { seg } = await ready();
    const err = await seg.publish(actor, key()).catch((e: { code: string; detail: unknown }) => e);
    expect(err).toMatchObject({ code: "not_executable", detail: [{ code: "image_missing", signal: "content.cover_template_score" }, { code: "image_missing", signal: "content.cover_element_score", detail: "logo" }] });
    await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("t"));
    await seg.putImage(actor, { ...key(), kind: "element", target: "cover", elementKey: "logo" }, png("e"));
    await seg.publish(actor, key());
    await seg.publish(actor, key());
    const [row] = await t.db.select().from(monitoringSegments).where(eq(monitoringSegments.planId, PLAN));
    expect(row).toMatchObject({ status: "published" });
    expect(row!.publishedAt).not.toBeNull();
  });
  it("已发布后 putImage / setItems / removeImage 一律 segment_immutable", async () => {
    const { seg } = await ready();
    await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("t"));
    await seg.putImage(actor, { ...key(), kind: "element", target: "cover", elementKey: "logo" }, png("e"));
    await seg.publish(actor, key());
    expect(await code(seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("x")))).toBe("segment_immutable");
    expect(await code(seg.setItems(actor, key(), []))).toBe("segment_immutable");
    expect(await code(seg.removeImage(actor, { ...key(), kind: "template", target: "cover" }))).toBe("segment_immutable");
  });
  it("关掉某能力的启用开关：已发布计划 executability 列出阻塞项，监控段数据不变", async () => {
    const full = await ready();
    await full.seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("t"));
    await full.seg.putImage(actor, { ...key(), kind: "element", target: "cover", elementKey: "logo" }, png("e"));
    await full.seg.publish(actor, key());
    expect(await full.seg.executability(actor, key())).toEqual({ executable: true, blockers: [] });
    const before = await t.db.select().from(monitoringSegments);
    const off = createSegments({ db: t.db, clock: full.clock, audit: () => {}, store: full.store, bucket: "b", converter, enabled: new Set(DEFAULT_ENABLED_CAPABILITIES) });
    const ex = await off.executability(actor, key());
    expect(ex.executable).toBe(false);
    expect(ex.blockers.map((b) => [b.code, b.signal, b.detail])).toEqual([
      ["capability_disabled", "content.cover_template_score", "image.template"],
      ["capability_disabled", "content.cover_element_score", "image.element"],
    ]);
    expect(await t.db.select().from(monitoringSegments)).toEqual(before);
  });
  it("语音类：网关禁用（无模型）时阻塞；只有 ASR 模型时判定仍阻塞；两者都有才可执行", async () => {
    const s = setup();
    await s.seg.create(actor, { planId: PLAN, platform: "douyin" });
    await s.seg.setItems(actor, key(), [{ signal: "content.asr_text" }, { signal: "content.asr_judgement", standard_text: "介绍保修" }]);
    const at = (gateway?: FakeAiGateway) => createSegments({ db: t.db, clock: s.clock, audit: () => {}, store: s.store, bucket: "b", converter, enabled: ALL_ENABLED, ...(gateway ? { gateway } : {}) });
    expect((await at().executability(actor, key())).blockers.map((b) => [b.code, b.signal, b.detail])).toEqual([["model_unavailable", "content.asr_text", "asr"], ["model_unavailable", "content.asr_judgement", "asr"]]);
    const g = new FakeAiGateway();
    g.models.judge = null;
    expect((await at(g).executability(actor, key())).blockers.map((b) => [b.code, b.signal, b.detail])).toEqual([["model_unavailable", "content.asr_judgement", "judge"]]);
    expect((await at(new FakeAiGateway()).executability(actor, key())).executable).toBe(true);
  });
  it("目录里删掉的信号：已存的草稿读作 signal_unregistered 阻塞，发布被拒绝", async () => {
    const { seg } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    await t.db.update(monitoringSegments).set({ items: [{ signal: "content.cover_ocr_text" }] }).where(eq(monitoringSegments.planId, PLAN));
    expect((await seg.executability(actor, key())).blockers).toEqual([{ code: "signal_unregistered", signal: "content.cover_ocr_text" }]);
    expect(await code(seg.publish(actor, key()))).toBe("signal_unregistered");
  });
});

describe("newDraft 与 purge", () => {
  it("新草稿：版本 +1，信号集合照抄，图片对象键不同、字节相同，旧版本的图仍可读", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    await seg.setItems(actor, key(), [{ signal: "content.cover_template_score" }]);
    const a = await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("tpl"));
    await seg.publish(actor, key());
    const next = await seg.newDraft(actor, { planId: PLAN, fromVersion: 1 });
    expect(next).toEqual(key(2));
    const v2 = await seg.show(actor, next);
    expect(v2).toMatchObject({ status: "draft", items: [{ signal: "content.cover_template_score" }] });
    expect(v2.images).toHaveLength(1);
    expect(v2.images[0]!.objectKey).not.toBe(a.objectKey);
    expect(v2.images[0]!.sha256).toBe(a.sha256);
    expect(Buffer.from((await store.get(v2.images[0]!.objectKey))!).equals(Buffer.from(png("tpl")))).toBe(true);
    expect(await store.get(a.objectKey)).not.toBeNull();
    expect((await seg.show(actor, key(1))).status).toBe("published"); // 旧版本不动
    expect((await seg.newDraft(actor, { planId: PLAN, fromVersion: 1 })).version).toBe(3);
  });
  it("newDraft 复制失败（源对象缺失）→ 不留新版本，已复制的对象被清理", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("a"));
    await seg.putImage(actor, { ...key(), kind: "template", target: "avatar" }, png("b"));
    const [x] = await t.db.select().from(segmentImages).where(eq(segmentImages.target, "avatar"));
    await store.delete(x!.objectKey);
    const before = store.keys();
    expect(await code(seg.newDraft(actor, { planId: PLAN, fromVersion: 1 }))).toBe("image_object_missing");
    expect(store.keys()).toEqual(before.filter((k) => k !== x!.objectKey));
    expect(await t.db.select().from(monitoringSegments)).toHaveLength(1);
  });
  it("purge：删除全部版本的行与对象（含孤儿），幂等；不影响别的计划", async () => {
    const { seg, store } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("a"));
    await seg.newDraft(actor, { planId: PLAN, fromVersion: 1 });
    await seg.create(actor, { planId: 123n, platform: "douyin" }); // 计划 123 与前缀 segments/12/ 不应混淆
    await seg.putImage(actor, { planId: 123n, version: 1, kind: "template", target: "cover" }, png("other"));
    await store.put("segments/12/1/cover/template/orphan", new Uint8Array([1])); // 崩溃留下的孤儿
    const r = await seg.purge(actor, PLAN);
    expect(r.objectsDeleted).toBe(3);
    expect(store.keys().every((k) => k.startsWith("segments/123/"))).toBe(true);
    expect((await t.db.select().from(monitoringSegments)).map((s) => s.planId)).toEqual([123n]);
    expect((await rows()).map((i) => i.planId)).toEqual([123n]);
    expect((await seg.purge(actor, PLAN)).objectsDeleted).toBe(0); // 幂等
  });
  it("purge 删除对象失败：数据库行保留，重试后清除", async () => {
    const { seg, store, events } = setup();
    await seg.create(actor, { planId: PLAN, platform: "douyin" });
    const a = await seg.putImage(actor, { ...key(), kind: "template", target: "cover" }, png("a"));
    store.failDelete = (k) => k === a.objectKey;
    await expect(seg.purge(actor, PLAN)).rejects.toThrow(/delete 失败/);
    expect([(await t.db.select().from(monitoringSegments)).length, (await rows()).length]).toEqual([1, 1]);
    expect(events.some((e) => e.event_type === "segment_purged")).toBe(false);
    store.failDelete = null;
    await seg.purge(actor, PLAN);
    expect([(await t.db.select().from(monitoringSegments)).length, (await rows()).length, store.keys().length]).toEqual([0, 0, 0]);
    expect(events.at(-1)).toMatchObject({ event_type: "segment_purged", plan_id: "12" });
  });
});
