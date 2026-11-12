// requestScores（requirements SG-8，design §5.3、§7.7）：对监控段与主体清单补算**缺失**的匹配分 / 转写 / 判定。
// 只补缺失：已有当前版本的结果（valid 或确定性 failed）与旧版本的有效值（stale）都不重算——重算是显式的另一件事（SG-D12）。
// 模板 / 元素匹配免费；ASR 与判定只在网关 activeModel() 非空时才建任务，计费由网关负责。读取口不会走到这里（SG-D11）。
import type { Db } from "../../../db/client";
import type { Clock } from "../../raw-capture";
import type { SignalAuditSink } from "../audit";
import { CAP_SCORE_REQUEST, SERVICE_ACTOR, assert, type SignalActor } from "../authz";
import { capabilityOf, requireSignal, versionOf, type CatalogEntry } from "../catalog";
import type { SignalsConfig } from "../config";
import { SignalError } from "../errors";
import { createFacts, type Material } from "../facts";
import { MAX_READ_SUBJECTS, type Subject } from "../reader";
import type { Executability, SegmentItem } from "../segments";
import { parseOnly } from "../segments/items";
import type { AiGatewayPort } from "../speech/ports";
import { enqueueMany, idempotencyKeyOf, type NewTask } from "../tasks/queue";
import { loadSegmentRow, reuseKeyOf, resolveParam, taskKindOf, type SegmentRef } from "./params";
import { JUDGE_PROMPT_VERSION } from "../speech/prompt";
import { latestResults } from "./results";

export type Disposition = "queued" | "reused" | "not_applicable" | "missing" | "disabled";
export interface SubjectDisposition {
  id: bigint;
  disposition: Disposition;
  /** reused：valid | stale | failed；not_applicable / missing：原因码。 */
  reason?: string;
}
export interface ItemResult {
  signal: string;
  elementKey?: string;
  subjects: SubjectDisposition[];
}
export interface RequestResult {
  items: ItemResult[];
  /** 本轮没有新的 verified 素材的主体：D 可据此向 A 提采集需求（C 自己不提，PRD C §8.2）。 */
  needMedia: Array<{ kind: Subject["kind"]; id: bigint; signal: string; reason: string }>;
  tasks: { created: number; revived: number; requeued: number; reused: number };
}
export interface RequestContext {
  caller?: string;
  scopeFingerprint?: string;
  /** 本次只补算这些信号键(缺省 = 监控段全部);`not_executable` 也只看这些信号。见 parseOnly。 */
  only?: readonly string[];
}

export interface RequestDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
  config: Pick<SignalsConfig, "taskMaxAttempts">;
  enabled: ReadonlySet<string>;
  gateway?: Pick<AiGatewayPort, "activeModel">;
  executability(k: SegmentRef, only?: ReadonlySet<string>): Promise<Executability>;
}

const GATED_BY_MODEL = new Set(["speech.asr", "speech.judge"]);

export function createRequestScores(deps: RequestDeps) {
  const facts = createFacts(deps.db);

  async function modelsOk(entry: CatalogEntry): Promise<boolean> {
    if (!GATED_BY_MODEL.has(entry.capability)) return true;
    if (!deps.gateway) return false;
    if ((await deps.gateway.activeModel("asr")) === null) return false;
    return entry.capability === "speech.asr" ? true : (await deps.gateway.activeModel("judge")) !== null;
  }
  async function requestScores(actor: SignalActor, segment: SegmentRef, subjects: readonly Subject[], ctx: RequestContext = {}): Promise<RequestResult> {
    assert(actor, CAP_SCORE_REQUEST); // 先于任何读库
    return plan(actor.actor, segment, subjects, ctx, { only: parseOnly(ctx.only) });
  }

  /**
   * 内部入口（显式重算的分块用，授权已在 recompute.apply 做过）：includeStale 把「旧版本的有效值」也当缺失（重算会覆盖 stale，补算不会）；
   * only 只处理监控段里的这个信号（重算按信号执行，不顺带算监控段里的其它信号;可执行性也只看它)。
   */
  async function requestAsService(segment: SegmentRef, subjects: readonly Subject[], opts: { includeStale?: boolean; only?: string } = {}): Promise<RequestResult> {
    return plan(SERVICE_ACTOR, segment, subjects, {}, { ...(opts.includeStale === undefined ? {} : { includeStale: opts.includeStale }), ...(opts.only === undefined ? {} : { only: new Set([opts.only]) }) });
  }

  async function plan(requestedBy: string, segment: SegmentRef, subjects: readonly Subject[], ctx: RequestContext, opts: { includeStale?: boolean; only?: ReadonlySet<string> | undefined }): Promise<RequestResult> {
    if (subjects.length > MAX_READ_SUBJECTS) throw new SignalError("limit", "too_many_subjects", `一次最多 ${MAX_READ_SUBJECTS} 个主体，超过请分批`);
    const seg = await loadSegmentRow(deps.db, segment);
    const ex = await deps.executability(segment, opts.only);
    if (!ex.executable) throw new SignalError("conflict", "not_executable", "监控段当前不可执行，不能补算", ex.blockers);

    const result: RequestResult = { items: [], needMedia: [], tasks: { created: 0, revived: 0, requeued: 0, reused: 0 } };
    const now = deps.clock.now();
    for (const item of seg.items as SegmentItem[]) {
      const entry = requireSignal(item.signal);
      if (entry.storage !== "result") continue; // 文本类随 current 指针自动就位，不走补算
      if (opts.only !== undefined && !opts.only.has(item.signal)) continue;
      const ids = [...new Set(subjects.filter((s) => s.kind === entry.object).map((s) => s.id))];
      const out: ItemResult = { signal: entry.key, ...(item.element_key ? { elementKey: item.element_key } : {}), subjects: [] };
      result.items.push(out);
      if (ids.length === 0) continue;

      const platforms = await facts.platformsOf(entry.object, ids);
      const material = await facts.materialForSignal(entry.key, ids);
      const modelOk = await modelsOk(entry);
      // 先取模型版本再算参数指纹（SG-D18）：不可用时 resolveParam 返回 unavailable，不建任务
      const param = await resolveParam(deps.db, deps.gateway, entry, { segment, ...(item.element_key ? { elementKey: item.element_key } : {}) });
      const shaToIds = new Map<string, { sha: Buffer; assetId: bigint; ids: bigint[] }>();

      for (const id of ids) {
        const platform = platforms.get(id);
        if (platform === undefined) throw new SignalError("not_found", "subject_not_found", `${entry.object} ${id} 不存在`);
        const m = material.get(id)!;
        if (!(entry.platforms as readonly string[]).includes(platform) || platform !== seg.platformCode) {
          out.subjects.push({ id, disposition: "not_applicable", reason: "platform_unsupported" });
        } else if (m.state === "not_applicable") {
          out.subjects.push({ id, disposition: "not_applicable", reason: m.reason });
        } else if (m.state === "missing") {
          out.subjects.push({ id, disposition: "missing", reason: m.reason });
          result.needMedia.push({ kind: entry.object, id, signal: entry.key, reason: m.reason });
        } else if (!modelOk || !param.available || !deps.enabled.has(capabilityOf(entry, platform))) {
          out.subjects.push({ id, disposition: "disabled", reason: "capability_disabled" });
        } else {
          const hex = m.sha256.toString("hex");
          const g = shaToIds.get(hex) ?? { sha: m.sha256, assetId: m.assetId, ids: [] };
          g.ids.push(id);
          shaToIds.set(hex, g);
        }
      }
      if (shaToIds.size === 0 || !param.available) continue;

      // 缺失 = 没有结果行，或最高版本的行是旧版本的失败；当前版本的 valid / failed 与旧版本的 valid（stale）都不补
      const have = await latestResults(deps.db, entry, [...shaToIds.values()].map((g) => g.sha), param.paramSha);
      const cur = versionOf(entry.capability);
      const tasks: NewTask[] = [];
      const taskOfSha = new Map<string, string>();
      for (const [hex, g] of shaToIds) {
        const r = have.get(hex);
        if (r && !(r.version < cur && (r.state === "failed" || opts.includeStale))) {
          for (const id of g.ids) out.subjects.push({ id, disposition: "reused", reason: r.version < cur ? "stale" : r.state });
          continue;
        }
        const key = idempotencyKeyOf(taskKindOf(entry.key), reuseKeyOf(entry, g.sha, param.paramSha));
        taskOfSha.set(hex, key.toString("hex"));
        tasks.push({
          kind: taskKindOf(entry.key),
          key,
          maxAttempts: deps.config.taskMaxAttempts,
          params: {
            signal_key: entry.key,
            material_sha256: hex,
            param_sha256: param.paramSha.toString("hex"),
            source: { media_asset_id: String(g.assetId) },
            ...(param.segmentImageId === undefined ? {} : { segment_image_id: String(param.segmentImageId) }),
            ...(param.standardText === undefined ? {} : { standard_text: param.standardText, prompt_version: JUDGE_PROMPT_VERSION, model_version: param.modelVersion }),
            lineage: { plan_id: String(segment.planId), version: segment.version, requested_by: requestedBy },
            caller: { actor: ctx.caller ?? requestedBy, ...(ctx.scopeFingerprint === undefined ? {} : { scope_fingerprint: ctx.scopeFingerprint }) },
            requested_at: now.toISOString(),
          },
        });
      }
      const outcomes = await enqueueMany(deps, tasks);
      for (const [hex, g] of shaToIds) {
        const o = outcomes.get(taskOfSha.get(hex) ?? "");
        if (o === undefined) continue; // 已有结果，上面处理过
        if (o === "created") result.tasks.created++;
        else if (o === "revived") result.tasks.revived++;
        else if (o === "requeued") result.tasks.requeued++;
        else result.tasks.reused++;
        for (const id of g.ids) out.subjects.push({ id, disposition: "queued", ...(o === "reused" ? { reason: "task_exists" } : {}) });
      }
    }
    return result;
  }
  return { requestScores, requestAsService };
}
export type RequestScores = ReturnType<typeof createRequestScores>["requestScores"];
export type RequestAsService = ReturnType<typeof createRequestScores>["requestAsService"];
