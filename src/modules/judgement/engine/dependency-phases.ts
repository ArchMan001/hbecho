// 依赖 A / C 的阶段（JP-10、JP-12、JP-13）：demand（向 A 提音频 / 评论需求并轮询）、layer3（ASR 判定）、comments（评论要求）。
// 候选内容 = C2：通过第 1、2 层（且被第 1 层数量要求选中）的内容；评论不依赖第 3 层，评论结果也不反过来过滤内容。
// 对 C、A 的调用都在数据库事务之外；等待有上限，超时记 dependency_timeout，运行继续。
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { runContents } from "../../../db/schema";
import { SignalError } from "../../signals/errors";
import { commentRequirementEnabled } from "../config";
import { toDemandActor } from "../authz";
import { evalAsr, evalKeywords } from "./pure/conditions";
import type { CondResult, SignalLike } from "./pure/types";
import type { Env, Out, RunnerDeps } from "./types";
import { chunk, hex, mergeDetail, retainUntilOf } from "./util";
import { sha256Utf8 } from "../../canonical-json";

const KNOWN_REJECT = new Set(["unsupported_platform", "capability_disabled", "content_not_found", "out_of_scope"]);
type Dep = "ready" | "timeout" | `failed:${string}` | `unsupported:${string}`;
interface DepEvidence {
  audio?: Dep;
  comments?: Dep;
  commentsCoverage?: { coverage: string; fetchedCount: number; reportedTotal: string | null };
}

export function createDependencyPhases(deps: RunnerDeps) {
  const { db, clock, claim, facts, signals, demand, config } = deps;

  // C2 的筛选条件（不要求 l3，评论只依赖第 1、2 层）
  const c2 = (runId: bigint) =>
    and(eq(runContents.runId, runId), eq(runContents.l0, "pass"), sql`${runContents.l1} IN ('pass','not_configured')`, sql`(${runContents.layer1Selected} IS NULL OR ${runContents.layer1Selected} = TRUE)`, sql`${runContents.l2} IN ('pass','not_configured')`);

  const depReason = (d: Dep | undefined): string => (d === undefined ? "demand_failed" : d === "timeout" ? "dependency_timeout" : d.startsWith("unsupported:") ? d.slice(12) : "demand_failed");
  const waitInfo = (env: Env) => {
    const d = (env.run.phaseDetail as { waitDeadline?: string } | null)?.waitDeadline;
    return { expired: d !== undefined && clock.now() >= new Date(d) };
  };
  /** 合并写内容行的证据 JSON（读—改—写在同一事务里）。 */
  async function patchEvidence(env: Env, patches: Array<{ contentId: bigint; set?: Record<string, unknown>; cols?: Partial<typeof runContents.$inferInsert> }>): Promise<void> {
    await claim.withFence(env.run, async (tx) => {
      for (const p of patches) {
        const [cur] = await tx.select({ ev: runContents.evidence }).from(runContents).where(and(eq(runContents.runId, env.run.runId), eq(runContents.contentId, p.contentId)));
        await tx
          .update(runContents)
          .set({ ...(p.cols ?? {}), evidence: { ...((cur?.ev as object | null) ?? {}), ...(p.set ?? {}) } as never })
          .where(and(eq(runContents.runId, env.run.runId), eq(runContents.contentId, p.contentId)));
      }
    });
  }
  const depOf = async (env: Env, ids: bigint[]): Promise<Map<bigint, DepEvidence>> => {
    const rows = await db.select({ id: runContents.contentId, ev: runContents.evidence }).from(runContents).where(and(eq(runContents.runId, env.run.runId), sql`${runContents.contentId} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
    return new Map(rows.map((r) => [r.id, ((r.ev as { dep?: DepEvidence } | null)?.dep ?? {}) as DepEvidence]));
  };

  // ---- demand ---------------------------------------------------------------------------------------------------
  async function demandPhase(env: Env): Promise<Out> {
    const { run, cfg } = env;
    const needAudio = cfg.contentRequirement?.layer3 !== undefined;
    const needComments = commentRequirementEnabled(cfg);
    if (!needAudio && !needComments) return { kind: "advance", phase: "layer3" };
    const actor = toDemandActor(env.ctx);
    const detail = (run.phaseDetail ?? {}) as { batches?: Array<{ batchId: string; kind: "audio" | "comments"; done?: boolean }>; submitted?: boolean };
    let batches = detail.batches ?? [];
    if (!detail.submitted) {
      const ids = (await db.select({ id: runContents.contentId }).from(runContents).where(c2(run.runId)).orderBy(asc(runContents.contentId))).map((r) => r.id);
      batches = [];
      for (const kind of [...(needAudio ? (["audio"] as const) : []), ...(needComments ? (["comments"] as const) : [])]) {
        for (const [n, part] of chunk(ids, config.demandBatch).entries()) {
          // demandKey 在同一提交人下幂等：崩溃后重提得到同一批次，不重复采集
          const r = await demand.submit(actor, {
            demandKey: `exec:${run.runId}:${kind === "audio" ? "l3" : "cm"}:${n}`,
            requester: { kind: "judgement-plan", ref: String(run.planId), version: String(run.version) },
            ruleDecisionId: `run:${run.runId}`,
            ruleVersion: `${run.planId}@${run.version}`,
            items: part.map((id) => ({ contentId: String(id), wants: [kind] })),
          });
          batches.push({ batchId: r.batchId, kind });
        }
      }
      await mergeDetail(deps, env, { submitted: true, batches });
    }
    const { expired } = waitInfo(env);
    let open = 0;
    for (const b of batches.filter((x) => !x.done)) {
      const view = await demand.get(actor, b.batchId);
      const patches: Parameters<typeof patchEvidence>[1] = [];
      let batchOpen = 0;
      const existing = await depOf(env, [...new Set(view.items.map((i) => BigInt(i.contentId)))]);
      for (const it of view.items) {
        const terminal = ["ready", "reused_ready", "failed", "unsupported"].includes(it.state);
        const contentId = BigInt(it.contentId);
        if (!terminal && !expired) {
          batchOpen++;
          continue;
        }
        const dep: Dep = !terminal ? "timeout" : it.state === "failed" ? `failed:${it.reason ?? "unknown"}` : it.state === "unsupported" ? `unsupported:${KNOWN_REJECT.has(it.disposition) ? it.disposition : KNOWN_REJECT.has(it.reason ?? "") ? it.reason! : "unsupported_platform"}` : "ready";
        const cov = it.pointers?.comments;
        patches.push({ contentId, set: { dep: { ...(existing.get(contentId) ?? {}), [b.kind]: dep, ...(b.kind === "comments" && cov ? { commentsCoverage: { coverage: cov.coverage, fetchedCount: cov.fetchedCount, reportedTotal: cov.reportedTotal } } : {}) } } });
      }
      if (patches.length) await patchEvidence(env, patches);
      if (batchOpen === 0) b.done = true;
      open += batchOpen;
    }
    await mergeDetail(deps, env, { batches });
    if (open > 0) return { kind: "wait", on: "demand" };
    return { kind: "advance", phase: "layer3" };
  }

  // ---- layer3：ASR + 大模型判定（D 不调模型，只经 C）------------------------------------------------------------------
  async function layer3Phase(env: Env): Promise<Out> {
    const { run, cfg, actor } = env;
    if (!cfg.contentRequirement?.layer3) return { kind: "advance", phase: "comments" };
    const ref = { planId: run.planId, version: run.version };
    const SIG = "content.asr_judgement";
    const pending = and(c2(run.runId), isNull(runContents.l3), isNull(runContents.final));
    const stopRows = async (rows: bigint[], reason: string) =>
      claim.withFence(run, async (tx) => {
        for (const id of rows) await tx.update(runContents).set({ l3: "unobtained", final: "unobtained", stopLayer: "3", reasonCode: reason }).where(and(eq(runContents.runId, run.runId), eq(runContents.contentId, id), isNull(runContents.l3)));
      });
    const all = (await db.select({ id: runContents.contentId }).from(runContents).where(pending).orderBy(asc(runContents.contentId))).map((r) => r.id);
    if (all.length === 0) return { kind: "advance", phase: "comments" };
    // 需求没拿到音频的内容：终态未获取成功，不发任何付费调用
    const deps_ = await depOf(env, all);
    const notReady = all.filter((id) => deps_.get(id)?.audio !== "ready");
    for (const [reason, ids] of Object.entries(Object.groupBy(notReady, (id) => depReason(deps_.get(id)?.audio)))) await stopRows(ids as bigint[], reason);
    const ready = all.filter((id) => deps_.get(id)?.audio === "ready");
    if (ready.length === 0) return { kind: "advance", phase: "comments" };
    // 进入第 3 层前重查可执行性（只看第 3 层）：中途丢失则剩余内容 capability_disabled，不发调用
    const ex = await signals.executability(actor, ref, { only: [SIG] });
    if (!ex.executable) {
      await stopRows(ready, "capability_disabled");
      return { kind: "advance", phase: "comments" };
    }
    const detail = (run.phaseDetail ?? {}) as { requestedL3?: boolean };
    if (!detail.requestedL3) {
      const fingerprint = hex(sha256Utf8(JSON.stringify({ run: String(run.runId), plan: String(run.planId), version: run.version, cfg: env.frozen.configSha256 })));
      try {
        for (const part of chunk(ready, config.signalBatch)) await signals.requestScores(actor, ref, part.map((id) => ({ kind: "content" as const, id })), { caller: run.submittedByActor, scopeFingerprint: fingerprint, only: [SIG] });
      } catch (e) {
        if (e instanceof SignalError && e.code === "not_executable") {
          await stopRows(ready, "capability_disabled");
          return { kind: "advance", phase: "comments" };
        }
        throw e;
      }
      await mergeDetail(deps, env, { requestedL3: true });
    }
    const { expired } = waitInfo(env);
    const left = (await db.select({ id: runContents.contentId }).from(runContents).where(pending).orderBy(asc(runContents.contentId))).map((r) => r.id).filter((id) => ready.includes(id));
    let waiting = 0;
    for (const part of chunk(left, config.signalBatch)) {
      const read = await signals.readMany(actor, part.map((id) => ({ kind: "content" as const, id })), SIG, { param: { segment: ref } });
      const verdicts = part.map((id) => {
        const sig: SignalLike = read.get(id) ?? { state: "missing", usable: false, reason: "not_computed" };
        let r: CondResult = evalAsr(sig);
        const v = sig.value as { reason?: unknown } | undefined;
        const ev = sig.evidence as { model?: unknown; prompt_version?: unknown } | undefined;
        // 判定缺结论 / 理由 / 模型版本 / 提示词版本任何一样，都不能当作通过（PRD §2.5）
        if (r.state !== "unobtained" && !(typeof v?.reason === "string" && v.reason !== "" && typeof ev?.model === "string" && ev.prompt_version !== undefined)) r = { state: "unobtained", reason: "incomplete_judgement_evidence" };
        return { id, sig, r };
      });
      for (const x of verdicts) if (x.r.state === "unobtained" && x.r.awaiting && !expired) waiting++;
      const settled = verdicts.filter((x) => !(x.r.state === "unobtained" && x.r.awaiting && !expired));
      // 先延长它们读到的结果行的保留期，再写证据：retain 失败则整块重试，不会出现「证据已写、保留没延长」
      await retainUntilOf(deps, env, settled.map((x) => x.sig.resultId));
      await claim.withFence(run, async (tx) => {
        for (const x of settled) {
          const st = x.r.state;
          const timedOut = x.r.state === "unobtained" && x.r.awaiting === true;
          const v = x.sig.value as { verdict?: string; reason?: string } | undefined;
          const ev = x.sig.evidence as { model?: string; prompt_version?: unknown } | undefined;
          const [cur] = await tx.select({ ev: runContents.evidence, stale: runContents.stale }).from(runContents).where(and(eq(runContents.runId, run.runId), eq(runContents.contentId, x.id)));
          await tx
            .update(runContents)
            .set({
              l3: timedOut ? "unobtained" : st,
              final: timedOut ? "unobtained" : st,
              ...(st === "pass" ? {} : { stopLayer: "3", reasonCode: timedOut ? "dependency_timeout" : (x.r.reason ?? null) }),
              stale: Boolean(cur?.stale) || x.r.stale === true,
              evidence: { ...((cur?.ev as object | null) ?? {}), l3: { state: st, verdict: v?.verdict, reason: v?.reason, model: ev?.model, promptVersion: ev?.prompt_version, ...(x.sig.resultId === undefined ? {} : { resultId: String(x.sig.resultId) }) } } as never,
            })
            .where(and(eq(runContents.runId, run.runId), eq(runContents.contentId, x.id), isNull(runContents.l3)));
        }
      });
    }
    if (waiting > 0) return { kind: "wait", on: "signals" };
    return { kind: "advance", phase: "comments" };
  }

  // ---- comments：评论要求（候选 = C2；评论条件作用在单条一级评论上）----------------------------------------------------
  async function commentsPhase(env: Env): Promise<Out> {
    const { run, cfg, actor } = env;
    const req = cfg.commentRequirement;
    if (!req) return { kind: "advance", phase: "aggregate" };
    const pending = and(c2(run.runId), isNull(runContents.cmTotal));
    const { expired } = waitInfo(env);
    const SIG = "comment.text_normalized";
    const skip = new Set<bigint>();
    let waiting = 0;
    for (;;) {
      if (Date.now() - env.startedMs > config.tickBudgetMs) return { kind: "more" };
      const batch = (await db.select({ id: runContents.contentId }).from(runContents).where(pending).orderBy(asc(runContents.contentId)).limit(config.signalBatch + skip.size)).map((r) => r.id).filter((id) => !skip.has(id)).slice(0, config.signalBatch);
      if (batch.length === 0) break;
      const deps_ = await depOf(env, batch);
      const readyIds = batch.filter((id) => deps_.get(id)?.comments === "ready");
      const commentsByContent = await facts.commentIdsOf(readyIds);
      const allIds = [...commentsByContent.values()].flat();
      const results = new Map<bigint, CondResult>();
      for (const part of chunk(allIds, config.signalBatch)) {
        const read = await signals.readMany(actor, part.map((id) => ({ kind: "comment" as const, id })), SIG);
        for (const id of part) {
          const sig: SignalLike = read.get(id) ?? { state: "missing", usable: false, reason: "not_computed" };
          const bySignal: Partial<Record<"title" | "body", SignalLike>> = {};
          bySignal["title"] = sig; // 评论只有一个文本信号；字段选择器的取值不是原文字段
          results.set(id, evalKeywords({ fields: ["title"], mode: req.mode, keywords: req.keywords }, bySignal, (r, v) => signals.normalizeKeyword(r, v)));
        }
      }
      const patches: Parameters<typeof patchEvidence>[1] = [];
      for (const id of batch) {
        const dep = deps_.get(id) ?? {};
        let total = 0;
        let pass = 0;
        let unobtained = 0;
        const reasons: Record<string, number> = {};
        const samples: string[] = [];
        const bump = (reason: string, n: number) => (reasons[reason] = (reasons[reason] ?? 0) + n);
        if (dep.comments !== "ready") {
          total = 1;
          unobtained = 1;
          bump(depReason(dep.comments), 1);
        } else {
          let stillWaiting = false;
          for (const cid of commentsByContent.get(id) ?? []) {
            const r = results.get(cid)!;
            if (r.state === "unobtained" && r.awaiting && !expired) stillWaiting = true;
            total++;
            if (r.state === "pass") {
              pass++;
              if (samples.length < 3) samples.push(String(cid));
            } else if (r.state === "unobtained") {
              unobtained++;
              bump(r.awaiting ? "dependency_timeout" : (r.reason ?? "unknown"), 1);
            }
          }
          if (stillWaiting) {
            skip.add(id);
            waiting++;
            continue;
          }
          // 覆盖不全（partial / unknown）：缺口计入未获取成功，使「至少 N 条」不会把「没抓全」判成不达标
          const cov = dep.commentsCoverage;
          if (cov && cov.coverage !== "complete") {
            const reported = cov.reportedTotal === null ? null : Number(cov.reportedTotal);
            const gap = cov.coverage === "partial" && reported !== null && Number.isFinite(reported) ? Math.max(1, reported - cov.fetchedCount) : 1;
            total += gap;
            unobtained += gap;
            bump("comments_incomplete", gap);
          }
        }
        patches.push({ contentId: id, cols: { cmTotal: total, cmPass: pass, cmUnobtained: unobtained, cmSamples: samples as never }, set: { cm: { reasons, depFailed: dep.comments !== "ready" } } });
      }
      if (patches.length) await patchEvidence(env, patches);
    }
    if (waiting > 0) return { kind: "wait", on: "signals" };
    return { kind: "advance", phase: "aggregate" };
  }
  return { demand: demandPhase, layer3: layer3Phase, comments: commentsPhase };
}
