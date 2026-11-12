// 读取口 SignalReader（requirements SG-12）：只读。**不创建任务、不调用能力服务或网关、不触发任何计算**——
// 补算只经 requestScores（SG-D11）。readMany 按种类分组，每组一次集合查询，查询次数与主体数无关。
import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { commentFeatures, contentFeatures } from "../../db/schema";
import { CAP_SEGMENT_READ, assert, type SignalActor } from "./authz";
import { capabilityOf, requireSignal, versionOf, type CatalogEntry, type SignalObject } from "./catalog";
import { composeState, type PendingHint, type SignalValue, type StalePolicy, type StoredSignal } from "./compose";
import type { Envelope } from "./features/compute";
import { SignalError } from "./errors";
import { createFacts, type Material } from "./facts";
import type { Param, SegmentRef } from "./scoring/params";
import type { AiGatewayPort } from "./speech/ports";
import { PLATFORM_TEXT_FIELDS } from "./text/fields";
import { currentNormalizerVersion } from "./text/normalize";

export const MAX_READ_SUBJECTS = 5000;

export type Subject = { kind: SignalObject; id: bigint };
export type { Param, SegmentRef };
export interface ReadOptions {
  param?: Param;
  /** 缺省 use_stale（PRD C-D05：默认使用旧值并标 stale）。 */
  stalePolicy?: StalePolicy;
  /** 调用方需要持有的 Capability；缺省 rule.definition.read（D 以服务身份读取）。CLI show 按对象类型用 data.content.read / data.account.read。 */
  requires?: string;
}

/** 结果行类信号的取数（任务 8 实现）：为素材已就绪的主体取最高版本结果行与任务状态。 */
export interface ResultLookup {
  lookup(
    entry: CatalogEntry,
    subjects: Array<{ id: bigint; platform: string; material: Extract<Material, { state: "ready" }> }>,
    param: Param | undefined,
  ): Promise<Map<bigint, { stored?: StoredSignal | undefined; pending?: PendingHint | undefined }>>;
}

export interface ReaderDeps {
  db: Db;
  /** 启用的能力标识。已存储的值不受它影响，它只决定「没有值时是否读作 capability_disabled」。 */
  enabled: ReadonlySet<string>;
  /** 语音类能力另需网关 activeModel 非空；没有网关则视为未启用。 */
  gateway?: Pick<AiGatewayPort, "activeModel">;
  results?: ResultLookup;
}

const TEXT_COLUMN: Record<string, "titleNormalized" | "bodyNormalized" | "hashtags"> = {
  "text.title_normalized": "titleNormalized",
  "text.body_normalized": "bodyNormalized",
  "text.hashtags": "hashtags",
};

export function createReader(deps: ReaderDeps) {
  const facts = createFacts(deps.db);

  async function modelsActive(entry: CatalogEntry): Promise<boolean> {
    if (entry.capability !== "speech.asr" && entry.capability !== "speech.judge") return true;
    if (!deps.gateway) return false;
    if ((await deps.gateway.activeModel("asr")) === null) return false;
    return entry.capability === "speech.asr" ? true : (await deps.gateway.activeModel("judge")) !== null;
  }

  async function readMany(actor: SignalActor, subjects: readonly Subject[], signalKey: string, opts: ReadOptions = {}): Promise<Map<bigint, SignalValue>> {
    assert(actor, opts.requires ?? CAP_SEGMENT_READ); // 先于任何读库
    const entry = requireSignal(signalKey);
    if (subjects.length > MAX_READ_SUBJECTS) throw new SignalError("limit", "too_many_subjects", `一次最多读取 ${MAX_READ_SUBJECTS} 个主体`);
    if (subjects.some((s) => s.kind !== entry.object)) throw new SignalError("input", "subject_kind_mismatch", `信号 ${signalKey} 的主体是 ${entry.object}`);
    if (entry.scope === "parameterized" && !opts.param) throw new SignalError("input", "param_required", `信号 ${signalKey} 是参数化信号，必须给 param`);
    const out = new Map<bigint, SignalValue>();
    if (subjects.length === 0) return out;
    const ids = [...new Set(subjects.map((s) => s.id))];
    const stalePolicy = opts.stalePolicy ?? "use_stale";

    const platformOf = await facts.platformsOf(entry.object, ids);
    const absent = ids.find((id) => !platformOf.has(id));
    if (absent !== undefined) throw new SignalError("not_found", "subject_not_found", `${entry.object} ${absent} 不存在`);
    const modelOk = await modelsActive(entry);

    const currentOf = (platform: string) => {
      const supported = (entry.platforms as readonly string[]).includes(platform);
      const capabilityId = supported ? capabilityOf(entry, platform) : entry.capability;
      return { capabilityId, version: supported ? versionOf(capabilityId) : 0, ...(entry.storage === "feature_row" ? { nv: currentNormalizerVersion() } : {}) };
    };
    const enabledFor = (platform: string): boolean => modelOk && deps.enabled.has(currentOf(platform).capabilityId);

    if (entry.storage === "feature_row") {
      const stored = await featureRows(deps.db, entry, ids);
      for (const id of ids) {
        const platform = platformOf.get(id)!;
        const field = entry.key === "text.title_normalized" ? "title" : entry.key === "text.body_normalized" ? "body" : null;
        out.set(id, composeState({ entry, platform, fieldAbsent: field !== null && PLATFORM_TEXT_FIELDS[platform]?.[field] === false, stored: stored.get(id), current: currentOf(platform), enabled: enabledFor(platform), stalePolicy }));
      }
      return out;
    }

    // 结果行类：先按素材状态分流，素材就绪的再去取结果行
    const material = await materialFor(facts, entry, ids);
    const ready = ids.flatMap((id) => {
      const m = material.get(id);
      return m?.state === "ready" ? [{ id, platform: platformOf.get(id)!, material: m }] : [];
    });
    const looked = deps.results && ready.length > 0 ? await deps.results.lookup(entry, ready, opts.param) : new Map();
    for (const id of ids) {
      const platform = platformOf.get(id)!;
      const l = looked.get(id);
      out.set(id, composeState({ entry, platform, ...(material.get(id) ? { material: material.get(id)! } : {}), stored: l?.stored, pending: l?.pending, current: currentOf(platform), enabled: enabledFor(platform), stalePolicy }));
    }
    return out;
  }

  async function read(actor: SignalActor, subject: Subject, signalKey: string, opts: ReadOptions = {}): Promise<SignalValue> {
    const r = await readMany(actor, [subject], signalKey, opts);
    return r.get(subject.id)!;
  }
  return { read, readMany };
}
export type SignalReader = ReturnType<typeof createReader>;

async function featureRows(db: Db, entry: CatalogEntry, ids: bigint[]): Promise<Map<bigint, StoredSignal>> {
  const out = new Map<bigint, StoredSignal>();
  if (entry.object === "comment") {
    for (const r of await db.select().from(commentFeatures).where(inArray(commentFeatures.commentId, ids))) {
      const e = (r.signals as Envelope)[entry.key];
      if (e) out.set(r.commentId, storedOf(e, r.textNormalized));
    }
    return out;
  }
  const column = TEXT_COLUMN[entry.key]!;
  for (const r of await db.select().from(contentFeatures).where(inArray(contentFeatures.contentId, ids))) {
    const e = (r.signals as Envelope)[entry.key];
    if (e) out.set(r.contentId, storedOf(e, r[column]));
  }
  return out;
}

function storedOf(e: Envelope[string], value: unknown): StoredSignal {
  return {
    state: e.state,
    capabilityId: e.cap,
    version: e.ver,
    nv: e.nv,
    producedAt: new Date(e.at),
    value: e.state === "valid" ? value : undefined,
    failureCode: e.code,
    evidence: e.detail === undefined ? undefined : { detail: e.detail },
  };
}

function materialFor(facts: ReturnType<typeof createFacts>, entry: CatalogEntry, ids: bigint[]): Promise<Map<bigint, Material>> {
  if (entry.key.startsWith("content.cover_")) return facts.coverMaterial(ids);
  if (entry.key.startsWith("account.bg_")) return facts.profileMaterial(ids, "background");
  if (entry.key.startsWith("account.avatar_")) return facts.profileMaterial(ids, "avatar");
  return facts.audioMaterial(ids); // content.asr_text / content.asr_judgement
}
