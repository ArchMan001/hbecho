// 监控段与标准图（requirements SG-7，design §5.2、§7.9）：由 D 驱动、C 执行。
// 标准图 / 元素图放专用桶 hbecho-signals（可物理删除；media 桶刻意没有 DeleteObject，ADR-0001 增补）。
// 事务边界：OSS 上传 / 删除都在数据库事务之外；事务只做「锁段行 → 校验草稿 → 先删后插」。
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { monitoringSegments, segmentImages, SEGMENT_PLATFORMS } from "../../../db/schema";
import { isDuplicateKey } from "../../activity-plan/errors";
import { ConverterError, sniffImage, type ImageConverter } from "../../media-archive";
import type { Clock, ObjectStore } from "../../raw-capture";
import type { SignalAuditSink } from "../audit";
import { CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, assert, type SignalActor } from "../authz";
import { capabilityOf, requireSignal, type Platform } from "../catalog";
import { SignalError } from "../errors";
import type { AiGatewayPort } from "../speech/ports";
import { ELEMENT_KEY, imageSlotOf, validateItems, type ImageSlot, type SegmentItem } from "./items";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export type SegmentKey = { planId: bigint; version: number };
export type ImageKey = SegmentKey & ImageSlot & { elementKey?: string };
export interface Blocker {
  code: "signal_unregistered" | "signal_not_available_on_platform" | "capability_disabled" | "model_unavailable" | "image_missing" | "too_many_judgements";
  signal?: string;
  detail?: string;
}
export interface Executability {
  executable: boolean;
  blockers: Blocker[];
}

export interface SegmentsDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
  /** 标准图桶（独立于 media 桶的 ObjectStore 实例，桶名在 bucket）。 */
  store: ObjectStore;
  bucket: string;
  converter: ImageConverter;
  /** 启用的能力标识；executability 按它即时计算，不存储。 */
  enabled: ReadonlySet<string>;
  gateway?: Pick<AiGatewayPort, "activeModel">;
  /** 测试注入点：在事务提交前抛错，验证上传后的清理。 */
  hooks?: { beforeImageCommit?: () => Promise<void> };
}

const hexOf = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const objectKey = (k: SegmentKey, slot: ImageSlot, elementKey: string, sha: string): string =>
  `segments/${k.planId}/${k.version}/${slot.target}/${slot.kind === "element" ? `element-${elementKey}` : "template"}/${sha}`;
const planPrefix = (planId: bigint): string => `segments/${planId}/`;
const fail = (category: SignalError["category"], code: string, message: string): never => {
  throw new SignalError(category, code, message);
};

export function createSegments(deps: SegmentsDeps) {
  const { db, clock, audit, store } = deps;
  const emit = (actor: SignalActor, event_type: Parameters<SignalAuditSink>[0]["event_type"], k: { planId: bigint; version?: number }, counts?: Record<string, number>) =>
    audit({ event_type, actor: actor.actor, occurred_at: clock.now().toISOString(), plan_id: String(k.planId), ...(k.version === undefined ? {} : { version: k.version }), ...(counts ? { counts } : {}) });

  async function loadSegment(q: Db | DbTx, k: SegmentKey, lock = false) {
    const base = q.select().from(monitoringSegments).where(and(eq(monitoringSegments.planId, k.planId), eq(monitoringSegments.version, k.version)));
    const [row] = await (lock ? base.for("update") : base);
    return row ?? fail("not_found", "segment_not_found", "监控段不存在");
  }
  const requireDraft = (seg: { status: string }): void => {
    if (seg.status !== "draft") fail("conflict", "segment_immutable", "已发布的监控段不可修改；改配置请 newDraft 发新版本");
  };
  const referenced = async (q: Db | DbTx, key: string): Promise<boolean> => (await q.select({ id: segmentImages.imageId }).from(segmentImages).where(eq(segmentImages.objectKey, key)).limit(1)).length > 0;
  /** 事务外尽力删除；失败不影响已提交的结果，孤儿由 purge 的前缀清扫兜底。 */
  const bestEffortDelete = async (key: string): Promise<void> => {
    try {
      await store.delete(key);
    } catch {
      /* ponytail: 删除失败只留下至多 10 MiB 的孤儿对象，purge 按前缀列举删除时一并清掉 */
    }
  };

  async function create(actor: SignalActor, input: { planId: bigint; platform: string }): Promise<SegmentKey> {
    assert(actor, CAP_SEGMENT_MANAGE);
    if (!(SEGMENT_PLATFORMS as readonly string[]).includes(input.platform)) fail("input", "platform_invalid", `平台必须是 ${SEGMENT_PLATFORMS.join("、")}`);
    const now = clock.now();
    try {
      await db.insert(monitoringSegments).values({ planId: input.planId, version: 1, platformCode: input.platform, status: "draft", items: [], createdByActor: actor.actor, createdAt: now, updatedAt: now });
    } catch (e) {
      if (isDuplicateKey(e)) fail("conflict", "segment_exists", "该计划已有监控段；改配置请 newDraft");
      throw e;
    }
    emit(actor, "segment_created", { planId: input.planId, version: 1 });
    return { planId: input.planId, version: 1 };
  }

  async function setItems(actor: SignalActor, k: SegmentKey, rawItems: unknown): Promise<SegmentItem[]> {
    assert(actor, CAP_SEGMENT_MANAGE);
    return db.transaction(async (tx) => {
      const seg = await loadSegment(tx, k, true);
      requireDraft(seg);
      const items = validateItems(rawItems, seg.platformCode as Platform);
      await tx.update(monitoringSegments).set({ items, updatedAt: clock.now() }).where(and(eq(monitoringSegments.planId, k.planId), eq(monitoringSegments.version, k.version)));
      return items;
    });
  }

  function slotOf(key: ImageKey, platform: string): { slot: ImageSlot; elementKey: string } {
    const slot: ImageSlot = { kind: key.kind, target: key.target };
    if (!["template", "element"].includes(slot.kind) || !["cover", "background", "avatar"].includes(slot.target)) fail("input", "image_slot_invalid", "kind 必须是 template / element，target 必须是 cover / background / avatar");
    if (slot.target !== "cover" && platform !== "douyin") fail("input", "signal_not_available_on_platform", `${slot.target} 只对抖音计划可用`);
    if (slot.kind === "template") {
      if (key.elementKey !== undefined) fail("input", "element_key_unexpected", "模板图不带 element_key");
      return { slot, elementKey: "" };
    }
    if (key.elementKey === undefined || !ELEMENT_KEY.safeParse(key.elementKey).success) fail("input", "element_key_invalid", "元素图需要合法的 element_key（[A-Za-z0-9_.-]，1–64 位，不能是 . 或 ..）");
    return { slot, elementKey: key.elementKey! };
  }

  async function putImage(actor: SignalActor, key: ImageKey, bytes: Uint8Array): Promise<{ sha256: string; objectKey: string }> {
    assert(actor, CAP_SEGMENT_MANAGE);
    const seg0 = await loadSegment(db, key);
    requireDraft(seg0);
    const { slot, elementKey } = slotOf(key, seg0.platformCode);
    // 上传校验：大小、按字节嗅探类型、必须能被 ImageConverter 解码（尺寸取解码后的标准化图）
    if (bytes.byteLength === 0) fail("input", "image_empty", "图片为空");
    if (bytes.byteLength > MAX_IMAGE_BYTES) fail("limit", "image_too_large", `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MiB`);
    const mime = sniffImage(bytes);
    if (!mime) fail("input", "image_unsupported", "不是支持的图片格式");
    let dims: { width: number; height: number };
    try {
      const n = await deps.converter.toNormalizedJpeg({ bytes, mimeType: mime! });
      dims = { width: n.width, height: n.height };
    } catch (e) {
      if (e instanceof ConverterError && e.kind === "unsupported") fail("input", "image_undecodable", "图片无法解码");
      throw e;
    }
    const sha = hexOf(bytes);
    const objKey = objectKey(key, slot, elementKey, sha);
    const stored = await store.put(objKey, bytes); // 失败则抛出，数据库没有任何写入
    if (stored.sha256 !== sha || stored.byteLength !== bytes.byteLength) {
      await bestEffortDelete(objKey);
      fail("conflict", "store_verify_failed", "标准图写入后校验不一致，已放弃");
    }
    let oldKey: string | undefined;
    try {
      await deps.hooks?.beforeImageCommit?.();
      await db.transaction(async (tx) => {
        const seg = await loadSegment(tx, key, true);
        requireDraft(seg); // 与 publish 竞争：发布先拿到锁则这里拒绝
        const where = and(eq(segmentImages.planId, key.planId), eq(segmentImages.version, key.version), eq(segmentImages.kind, slot.kind), eq(segmentImages.target, slot.target), eq(segmentImages.elementKey, elementKey));
        const [old] = await tx.select().from(segmentImages).where(where);
        if (old) {
          oldKey = old.objectKey;
          await tx.delete(segmentImages).where(where); // 同一对象的旧图先删后插，在同一事务里
        }
        await tx.insert(segmentImages).values({
          planId: key.planId,
          version: key.version,
          kind: slot.kind,
          target: slot.target,
          elementKey,
          sha256: Buffer.from(sha, "hex"),
          byteLength: BigInt(bytes.byteLength),
          width: dims.width,
          height: dims.height,
          mime: mime!,
          bucket: deps.bucket,
          objectKey: objKey,
          createdByActor: actor.actor,
          createdAt: clock.now(),
        });
      });
    } catch (e) {
      if (!(await referenced(db, objKey))) await bestEffortDelete(objKey); // 同字节替换时键相同，仍被旧行引用则不能删
      throw e;
    }
    if (oldKey !== undefined && oldKey !== objKey) await bestEffortDelete(oldKey);
    emit(actor, "image_uploaded", key, { bytes: bytes.byteLength });
    return { sha256: sha, objectKey: objKey };
  }

  async function removeImage(actor: SignalActor, key: ImageKey): Promise<void> {
    assert(actor, CAP_SEGMENT_MANAGE);
    const seg0 = await loadSegment(db, key);
    requireDraft(seg0);
    const { slot, elementKey } = slotOf(key, seg0.platformCode);
    const oldKey = await db.transaction(async (tx) => {
      requireDraft(await loadSegment(tx, key, true));
      const where = and(eq(segmentImages.planId, key.planId), eq(segmentImages.version, key.version), eq(segmentImages.kind, slot.kind), eq(segmentImages.target, slot.target), eq(segmentImages.elementKey, elementKey));
      const [old] = await tx.select().from(segmentImages).where(where);
      if (!old) fail("not_found", "image_not_found", "没有这张图");
      await tx.delete(segmentImages).where(where);
      return old!.objectKey;
    });
    await bestEffortDelete(oldKey);
    emit(actor, "image_removed", key);
  }

  async function show(actor: SignalActor, k: SegmentKey) {
    assert(actor, CAP_SEGMENT_READ);
    const seg = await loadSegment(db, k);
    const images = await db.select().from(segmentImages).where(and(eq(segmentImages.planId, k.planId), eq(segmentImages.version, k.version)));
    return {
      planId: seg.planId,
      version: seg.version,
      platform: seg.platformCode,
      status: seg.status,
      items: seg.items as SegmentItem[],
      createdByActor: seg.createdByActor,
      publishedAt: seg.publishedAt,
      images: images
        .map((i) => ({ kind: i.kind, target: i.target, elementKey: i.elementKey, sha256: i.sha256.toString("hex"), byteLength: i.byteLength, width: i.width, height: i.height, mime: i.mime, objectKey: i.objectKey }))
        .sort((a, b) => `${a.target}${a.kind}${a.elementKey}`.localeCompare(`${b.target}${b.kind}${b.elementKey}`)),
    };
  }

  /** 按**当前目录与当前启用配置**即时计算；不存储，也不改监控段（C-D10）。 */
  async function computeExecutability(k: SegmentKey): Promise<Executability> {
    const seg = await loadSegment(db, k);
    const images = await db.select({ kind: segmentImages.kind, target: segmentImages.target, elementKey: segmentImages.elementKey }).from(segmentImages).where(and(eq(segmentImages.planId, k.planId), eq(segmentImages.version, k.version)));
    const have = new Set(images.map((i) => `${i.kind}/${i.target}/${i.elementKey}`));
    const blockers: Blocker[] = [];
    const models = { asr: deps.gateway ? await deps.gateway.activeModel("asr") : null, judge: deps.gateway ? await deps.gateway.activeModel("judge") : null };
    const items = seg.items as SegmentItem[];
    if (items.filter((i) => i.signal === "content.asr_judgement").length > 1) blockers.push({ code: "too_many_judgements", signal: "content.asr_judgement" });
    for (const it of items) {
      let entry;
      try {
        entry = requireSignal(it.signal);
      } catch {
        blockers.push({ code: "signal_unregistered", signal: it.signal });
        continue;
      }
      if (!(entry.platforms as readonly string[]).includes(seg.platformCode)) {
        blockers.push({ code: "signal_not_available_on_platform", signal: it.signal, detail: seg.platformCode });
        continue;
      }
      const cap = capabilityOf(entry, seg.platformCode);
      if (!deps.enabled.has(cap)) blockers.push({ code: "capability_disabled", signal: it.signal, detail: cap });
      if (it.signal === "content.asr_text" && models.asr === null) blockers.push({ code: "model_unavailable", signal: it.signal, detail: "asr" });
      if (it.signal === "content.asr_judgement" && (models.asr === null || models.judge === null)) blockers.push({ code: "model_unavailable", signal: it.signal, detail: models.asr === null ? "asr" : "judge" });
      const slot = imageSlotOf(it.signal);
      if (slot && !have.has(`${slot.kind}/${slot.target}/${slot.kind === "element" ? it.element_key : ""}`)) blockers.push({ code: "image_missing", signal: it.signal, ...(it.element_key ? { detail: it.element_key } : {}) });
    }
    return { executable: blockers.length === 0, blockers };
  }
  async function executability(actor: SignalActor, k: SegmentKey): Promise<Executability> {
    assert(actor, CAP_SEGMENT_READ);
    return computeExecutability(k);
  }

  async function publish(actor: SignalActor, k: SegmentKey): Promise<void> {
    assert(actor, CAP_SEGMENT_MANAGE);
    const now = clock.now();
    await db.transaction(async (tx) => {
      const seg = await loadSegment(tx, k, true);
      if (seg.status === "published") return; // 幂等
      validateItems(seg.items, seg.platformCode as Platform); // 目录可能在保存之后变过
      const ex = await computeExecutability(k);
      if (!ex.executable) throw new SignalError("conflict", "not_executable", "监控段当前不可执行，不能发布", ex.blockers);
      await tx.update(monitoringSegments).set({ status: "published", publishedAt: now, updatedAt: now }).where(and(eq(monitoringSegments.planId, k.planId), eq(monitoringSegments.version, k.version)));
    });
    emit(actor, "segment_published", k);
  }

  /** 复制出新草稿：新版本号 = 现有最高版本 + 1；信号集合照抄，图片字节复制到新版本的键下（每行独占自己的对象）。 */
  async function newDraft(actor: SignalActor, input: { planId: bigint; fromVersion: number }): Promise<SegmentKey> {
    assert(actor, CAP_SEGMENT_MANAGE);
    const from = await loadSegment(db, { planId: input.planId, version: input.fromVersion });
    const [latest] = await db.select({ v: monitoringSegments.version }).from(monitoringSegments).where(eq(monitoringSegments.planId, input.planId)).orderBy(desc(monitoringSegments.version)).limit(1);
    const next: SegmentKey = { planId: input.planId, version: latest!.v + 1 };
    const rows = await db.select().from(segmentImages).where(and(eq(segmentImages.planId, input.planId), eq(segmentImages.version, input.fromVersion)));
    const copied: Array<{ row: typeof segmentImages.$inferSelect; key: string }> = [];
    try {
      for (const row of rows) {
        const bytes = await store.get(row.objectKey);
        if (!bytes) fail("conflict", "image_object_missing", "源版本的图片对象不存在，无法复制");
        const key = objectKey(next, { kind: row.kind as ImageSlot["kind"], target: row.target as ImageSlot["target"] }, row.elementKey, row.sha256.toString("hex"));
        const stored = await store.put(key, bytes!);
        copied.push({ row, key });
        if (stored.sha256 !== row.sha256.toString("hex")) fail("conflict", "store_verify_failed", "复制后的图片校验不一致，已放弃");
      }
      const now = clock.now();
      await db.transaction(async (tx) => {
        await tx.insert(monitoringSegments).values({ planId: next.planId, version: next.version, platformCode: from.platformCode, status: "draft", items: from.items, createdByActor: actor.actor, createdAt: now, updatedAt: now });
        for (const { row, key } of copied) {
          const { imageId: _ignored, ...rest } = row;
          await tx.insert(segmentImages).values({ ...rest, version: next.version, objectKey: key, createdByActor: actor.actor, createdAt: now });
        }
      });
    } catch (e) {
      for (const c of copied) await bestEffortDelete(c.key);
      if (isDuplicateKey(e)) fail("conflict", "segment_exists", "新版本号已被占用，请重试");
      throw e;
    }
    emit(actor, "segment_created", next, { copied_images: copied.length });
    return next;
  }

  /** 物理删除该计划全部版本的监控段、图片行与对象。幂等；任一步失败都保留数据库行，下次重试。不级联删结果行（由保留期清理）。 */
  async function purge(actor: SignalActor, planId: bigint): Promise<{ objectsDeleted: number }> {
    assert(actor, CAP_SEGMENT_MANAGE);
    const objects = await store.list(planPrefix(planId)); // 按前缀，连孤儿对象一并清掉
    for (const o of objects) await store.delete(o.key); // 失败则抛出：数据库行保留，重试即可（已不存在视为成功）
    await db.transaction(async (tx) => {
      await tx.delete(segmentImages).where(eq(segmentImages.planId, planId));
      await tx.delete(monitoringSegments).where(eq(monitoringSegments.planId, planId));
    });
    emit(actor, "segment_purged", { planId }, { objects: objects.length });
    return { objectsDeleted: objects.length };
  }

  return { create, setItems, putImage, removeImage, show, executability, publish, newDraft, purge, computeExecutability };
}
export type Segments = ReturnType<typeof createSegments>;
export type { SegmentItem, ImageSlot } from "./items";
