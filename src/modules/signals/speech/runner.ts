// 语音 runner（requirements SG-9，design §5.4）：ASR 转写与大模型判定。所有模型调用只经 AiGatewayPort；
// 每次调用带 callKey（= 任务幂等键的十六进制），网关对相同 callKey 不重复计费——任务在调用成功后、写结果前崩溃，
// 重启后用同一 callKey 重试，结果行仍只有一行。网络调用期间不持有数据库事务。
// 失败分类：模型拒绝 / 输出不符合 schema 是确定性失败（写 failed 行，**不写成 not_meets**）；其余异常是瞬时失败，重试后 dead，不写结果行。
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../../../db/client";
import type { Clock, MediaObjectStore } from "../../raw-capture";
import type { SignalAuditSink } from "../audit";
import { SERVICE_ACTOR } from "../authz";
import { requireSignal, versionOf } from "../catalog";
import type { SignalsConfig } from "../config";
import { createFacts } from "../facts";
import { redactUrls } from "../redact";
import { ZERO_PARAM, reuseKeyOf, taskKindOf } from "../scoring/params";
import { buildResultRow, type ResultBody, type TaskParamsBase } from "../scoring/result-row";
import { latestResults } from "../scoring/results";
import { claim, defer, enqueueMany, failDead, failTransient, idempotencyKeyOf, pendingHints, succeed, type Claimed, type QueueDeps } from "../tasks/queue";
import { GatewayRefusedError, type AiGatewayPort } from "./ports";
import { JUDGE_PROMPT_ID, judgeOutputSchema, renderJudgePrompt } from "./prompt";

export interface SpeechRunnerDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
  config: Pick<SignalsConfig, "scoreConcurrency" | "leaseMs" | "signedUrlTtlSeconds" | "retryBackoffMs" | "deferIntervalMs" | "deferMax" | "taskMaxAttempts">;
  mediaStore: Pick<MediaObjectStore, "signedGetUrl">;
  gateway: AiGatewayPort;
  workerId?: string;
}

type SpeechParams = TaskParamsBase & { standard_text?: string; prompt_version?: number; model_version?: string };
const transcriptSchema = z.object({ text: z.string(), language: z.string().min(1), durationMs: z.number().nonnegative().nullable(), model: z.string().min(1) });
const scrub = (s: string): string => redactUrls(s).slice(0, 500);
const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export function createSpeechRunner(deps: SpeechRunnerDeps) {
  const q: QueueDeps = { db: deps.db, clock: deps.clock, audit: deps.audit };
  const facts = createFacts(deps.db);
  const workerId = deps.workerId ?? SERVICE_ACTOR;
  const now = () => deps.clock.now();
  type Outcome = "succeeded" | "retry_wait" | "dead" | "stale";

  const write = async (c: Claimed, body: ResultBody): Promise<Outcome> => ((await succeed(q, c, buildResultRow(c.task.params as SpeechParams, now(), body))).ok ? "succeeded" : "stale");
  const transient = async (c: Claimed, code: string, detail: string): Promise<Outcome> => {
    const r = await failTransient(q, c, { code, detail: scrub(detail), backoffMs: deps.config.retryBackoffMs });
    return r.ok ? r.value : "stale";
  };
  const dead = async (c: Claimed, reason: Parameters<typeof failDead>[2]["reason"], detail: string): Promise<Outcome> => ((await failDead(q, c, { reason, detail })).ok ? "dead" : "stale");
  const callKeyOf = (c: Claimed): string => c.task.idempotencyKey.toString("hex");

  async function runAsr(c: Claimed): Promise<Outcome> {
    const p = c.task.params as SpeechParams;
    if ((await deps.gateway.activeModel("asr")) === null) return transient(c, "model_unavailable", "ASR 模型当前不可用");
    const assetId = BigInt(p.source.media_asset_id);
    const audio = (await facts.mediaObjectOf([assetId])).get(assetId);
    if (!audio) return write(c, { state: "failed", code: "audio_unreadable", evidence: { failure_code: "audio_unreadable", detail: "音频对象不可用" } });
    let raw: unknown;
    try {
      raw = await deps.gateway.transcribe({ callKey: callKeyOf(c), audioUrl: await deps.mediaStore.signedGetUrl(audio.objectKey, deps.config.signedUrlTtlSeconds) });
    } catch (e) {
      if (e instanceof GatewayRefusedError) return write(c, { state: "failed", code: "model_refused", evidence: { failure_code: "model_refused", detail: scrub(e.message) } });
      return transient(c, "gateway_error", e instanceof Error ? e.message : String(e));
    }
    const t = transcriptSchema.safeParse(raw);
    if (!t.success) return write(c, { state: "failed", code: "invalid_output", evidence: { failure_code: "invalid_output", detail: t.error.issues.map((i) => i.path.join(".") || i.code).join(",") } });
    return write(c, {
      state: "valid",
      value: { text: t.data.text, language: t.data.language },
      evidence: { model: t.data.model, duration_ms: t.data.durationMs, language: t.data.language, gateway_call_key: callKeyOf(c) },
    });
  }

  async function runJudgement(c: Claimed): Promise<Outcome> {
    const p = c.task.params as SpeechParams;
    const model = await deps.gateway.activeModel("judge");
    if (model === null) return transient(c, "model_unavailable", "判定模型当前不可用");
    // 参数指纹含请求时的模型版本；运行时模型已换，结果会写到错误的键下——放弃，新请求会用新模型版本建新任务
    if (model !== p.model_version) return dead(c, "model_changed", `请求时模型 ${p.model_version}，现在是 ${model}`);

    // 依赖：同一音频的 ASR 结果（全局，所有监控段共享）
    const asrEntry = requireSignal("content.asr_text");
    const material = Buffer.from(p.material_sha256, "hex");
    const asr = (await latestResults(deps.db, asrEntry, [material], ZERO_PARAM)).get(p.material_sha256);
    // 没有转写，或只有旧版本留下的失败（不是新代码的证据）→ 需要（重新）转写
    if (!asr || (asr.state === "failed" && asr.version < versionOf(asrEntry.capability))) {
      const asrTask = {
        kind: taskKindOf(asrEntry.key),
        key: idempotencyKeyOf(taskKindOf(asrEntry.key), reuseKeyOf(asrEntry, material, ZERO_PARAM)),
        maxAttempts: deps.config.taskMaxAttempts,
        params: { signal_key: asrEntry.key, material_sha256: p.material_sha256, param_sha256: ZERO_PARAM.toString("hex"), source: p.source, lineage: p.lineage, ...(p.caller ? { caller: p.caller } : {}), requested_at: now().toISOString() },
      } as const;
      // ASR 任务已 dead：判定不替它复活（否则每个延后周期都可能再付一轮 ASR 调用），自己 dead
      if ((await pendingHints(deps.db, [asrTask.key])).get(asrTask.key.toString("hex")) === "dead") return dead(c, "dependency_timeout", "ASR 任务已 dead");
      await enqueueMany(q, [asrTask]);
      const d = await defer(q, c, { intervalMs: deps.config.deferIntervalMs, maxDefer: deps.config.deferMax, detail: "等待 ASR 结果" });
      return d.ok ? d.value : "stale";
    }
    const transcriptResultId = asr.resultId;
    if (asr.state === "failed") {
      // 转写本身已确定性失败：判定无从做起，同样记 failed（保留原失败码），不是 not_meets
      return write(c, { state: "failed", code: asr.failureCode ?? "invalid_output", evidence: { failure_code: asr.failureCode, detail: "转写失败", transcript_result_id: String(transcriptResultId) } });
    }
    const prompt = renderJudgePrompt((asr.value as { text: string }).text, p.standard_text ?? "");
    let out;
    try {
      out = await deps.gateway.judge({ callKey: callKeyOf(c), promptId: JUDGE_PROMPT_ID, promptVersion: p.prompt_version ?? 0, system: prompt.system, user: prompt.user });
    } catch (e) {
      if (e instanceof GatewayRefusedError) return write(c, { state: "failed", code: "model_refused", evidence: { failure_code: "model_refused", detail: scrub(e.message), transcript_result_id: String(transcriptResultId) } });
      return transient(c, "gateway_error", e instanceof Error ? e.message : String(e));
    }
    const parsed = judgeOutputSchema.safeParse(out.output);
    if (!parsed.success) {
      return write(c, { state: "failed", code: "invalid_output", evidence: { failure_code: "invalid_output", detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}:${i.code}`).join(","), model: out.model, transcript_result_id: String(transcriptResultId) } });
    }
    return write(c, {
      state: "valid",
      value: { verdict: parsed.data.verdict, reason: parsed.data.reason },
      evidence: { model: out.model, prompt_id: JUDGE_PROMPT_ID, prompt_version: p.prompt_version, standard_sha256: sha256Hex(p.standard_text ?? ""), transcript_result_id: String(transcriptResultId), gateway_call_key: callKeyOf(c) },
    });
  }

  async function runOne(c: Claimed): Promise<Outcome> {
    return c.task.kind === "asr_text" ? runAsr(c) : runJudgement(c);
  }

  /** 只领网关有模型的那类任务：没有 ASR 模型就一个语音任务都不领（不消耗尝试次数，也不发任何调用）。 */
  async function runBatch(): Promise<number> {
    const kinds: Array<"asr_text" | "asr_judgement"> = [];
    if ((await deps.gateway.activeModel("asr")) !== null) {
      kinds.push("asr_text");
      if ((await deps.gateway.activeModel("judge")) !== null) kinds.push("asr_judgement");
    }
    if (kinds.length === 0) return 0;
    const claimed = await claim(q, { workerId, leaseMs: deps.config.leaseMs, limit: deps.config.scoreConcurrency, kinds });
    await Promise.all(claimed.map((c) => runOne(c)));
    return claimed.length;
  }
  return { runOne, runBatch };
}
export type SpeechRunner = ReturnType<typeof createSpeechRunner>;
