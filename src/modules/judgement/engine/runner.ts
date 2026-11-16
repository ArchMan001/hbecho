// 阶段机（design §7.2）：圈定 freeze → scope → layer1 → select → finalize；后续任务在这条链上加 scores / demand / layer3 / comments / aggregate。
// 每个阶段只做「还没做的部分」，重进幂等：行上的 NULL 是待办标记，游标写在运行行里；所有写入走 withFence。
// 对 C 的调用（readMany）在事务之外；阶段内的事务只做数据库读写。
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { judgementPlanVersions, judgementPlans, judgementRuns, runContents, runParticipants } from "../../../db/schema";
import type { AuthContext } from "../../access-control";
import { sha256Utf8 } from "../../canonical-json";
import type { Clock } from "../../raw-capture/ports";
import type { JudgementAudit } from "../audit";
import type { JudgementAuthz } from "../authz";
import { accountAbilities, accountRequirementEnabled, commentRequirementEnabled, configSha256, contentAbilities, contentRequirementEnabled, parseConfig, scoreSignalOf, type Ability, type Config } from "../config";
import type { JudgementConfig } from "../env";
import { JudgementError } from "../errors";
import type { ActivityPlanFact, Facts } from "../facts";
import type { SignalLike } from "./pure/types";
import type { SignalsPort, SignalActor } from "../ports";
import { SignalError } from "../../signals/errors";
import { createDependencyPhases } from "./dependency-phases";
import { chunk, hex, mergeDetail, retainUntilOf } from "./util";
import { type Claim, type RunRow, StaleLeaseError } from "./claim";
import { evalDuration, evalHashtags, evalKeywords, evalScore, thresholdToCents } from "./pure/conditions";
import { combineLayer, type LayerResult } from "./pure/layer";
import { selectLayer1 } from "./pure/select";
import { commentOutcome, contentCounts, contentOutcome, topReason, type ContentRowLite } from "./pure/aggregate";
import { andOutcome } from "./pure/tri";
import type { Outcome } from "./pure/types";
import { bjtDaysToUtc } from "./pure/window";
import type { RunnerDeps, Env, Frozen, Out } from "./types";

export type { RunnerDeps, Frozen } from "./types";
export type TickResult = "continue" | "waiting" | "terminal" | "stale";
const PHASES_BY_KIND: Record<string, readonly string[]> = { circle: ["freeze", "scope", "layer1", "select", "finalize"], compare: ["freeze", "scope", "layer1", "select", "scores", "finalize"], execution: ["freeze", "scope", "layer1", "select", "scores", "demand", "layer3", "comments", "aggregate", "finalize"] };


export function createRunner(deps: RunnerDeps) {
  const { db, clock, facts, authz, audit, signals, claim, config } = deps;

  const setPhase = (tx: DbTx, run: RunRow, phase: string, cursor: bigint | null, detail: unknown = null) =>
    tx.update(judgementRuns).set({ phase, phaseCursor: cursor, phaseDetail: detail as never, updatedAt: clock.now() }).where(eq(judgementRuns.runId, run.runId));

  // ---- freeze -------------------------------------------------------------------------------------------------
  async function freeze(env: Env): Promise<Out> {
    const { run, cfg, activity } = env;
    if (env.frozen.freezeDone) return { kind: "advance", phase: "scope" };
    // 崩溃在中途、frozen 尚未写完：此时还没有任何下游行，删掉已写的参与专员后整段重做（名单可能已变，以重做时读到的为准）
    await claim.withFence(run, async (tx) => void (await tx.delete(runParticipants).where(eq(runParticipants.runId, run.runId))));
    const roster = await facts.rosterOf(activity.planId);
    if (!roster) return { kind: "fail", code: "plan_not_found", detail: { activityPlanId: String(activity.planId) } };
    const accountIds = roster.entries.map((e) => BigInt(e.accountId)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const assignments = await facts.assignmentsOf(accountIds);
    const staffOf = new Map<bigint, bigint>();
    for (const a of accountIds) {
      const asg = assignments.get(a);
      if (!asg || asg.watchType !== "staff" || asg.staffId === null || asg.platformId !== activity.platformId) return { kind: "fail", code: "no_staff_assignment", detail: { accountId: String(a) } };
      const dup = [...staffOf.entries()].find(([, s]) => s === asg.staffId);
      if (dup) return { kind: "fail", code: "participant_conflict", detail: { staffId: String(asg.staffId), accountIds: [String(dup[0]), String(a)] } };
      staffOf.set(a, asg.staffId);
    }
    const chains = await facts.orgChainOf([...staffOf.values()]);
    for (const [a, s] of staffOf) if (!chains.has(s)) return { kind: "fail", code: "no_staff_assignment", detail: { accountId: String(a), staffId: String(s) } };
    const frozenAt = clock.now();
    const w = bjtDaysToUtc(cfg.window, frozenAt);
    const frozen: Frozen = {
      frozenAt: frozenAt.toISOString(),
      window: { from: cfg.window.from, ...(cfg.window.to ? { to: cfg.window.to } : {}), fromUtc: w.fromUtc.toISOString(), toUtc: w.toUtc.toISOString() },
      platform: activity.platformCode,
      startsOn: activity.startsOn,
      endsOn: activity.endsOn,
      configSha256: hex(configSha256(cfg)),
      segment: { planId: String(run.planId), version: run.version },
      rosterSha256: hex(sha256Utf8(accountIds.join(","))),
      freezeDone: false,
    };
    for (let i = 0; i < accountIds.length; i += config.blockSize) {
      const chunk = accountIds.slice(i, i + config.blockSize);
      await claim.withFence(run, async (tx) => {
        await tx.insert(runParticipants).values(
          chunk.map((accountId) => {
            const c = chains.get(staffOf.get(accountId)!)!;
            return { runId: run.runId, accountId, staffId: c.staffId, storeId: c.storeId, dealerId: c.dealerId, brandId: c.brandId, sectorId: c.sectorId, branchId: c.branchId, regionId: c.regionId };
          }),
        );
      });
    }
    // 最后一个事务：frozen 一次写全并标记完成，之后各阶段只读它，不再读名单
    await claim.withFence(run, async (tx) => {
      await tx.update(judgementRuns).set({ frozen: { ...frozen, freezeDone: true } as never, participantCount: accountIds.length, updatedAt: clock.now() }).where(eq(judgementRuns.runId, run.runId));
      await setPhase(tx, run, "scope", null);
    });
    env.frozen = { ...frozen, freezeDone: true };
    return { kind: "advance", phase: "scope" };
  }

  // ---- scope：参与内容的范围构建与冻结（含同步完整谓词）----------------------------------------------------------
  async function scope(env: Env): Promise<Out> {
    const { run, cfg, frozen } = env;
    const fromUtc = new Date(frozen.window.fromUtc);
    const toUtc = new Date(frozen.window.toUtc);
    const cursor = run.phaseCursor ?? 0n;
    const chunk = await db.select({ accountId: runParticipants.accountId }).from(runParticipants).where(and(eq(runParticipants.runId, run.runId), gt(runParticipants.accountId, cursor))).orderBy(asc(runParticipants.accountId)).limit(config.blockSize);
    if (chunk.length === 0) return { kind: "advance", phase: "layer1" };
    const accountIds = chunk.map((c) => c.accountId);
    const read = await facts.contentsOf(accountIds);
    const sync = await facts.syncCompletenessOf(accountIds, fromUtc);
    const wantAll = cfg.kinds.length === 2;
    const kindOk = (k: string): "yes" | "no" | "unknown" => {
      const mapped = k === "video" ? "video" : k === "image" || k === "text" ? "image" : null;
      if (mapped === null) return wantAll ? "yes" : "unknown";
      return (cfg.kinds as string[]).includes(mapped) ? "yes" : "no";
    };
    const rows: Array<typeof runContents.$inferInsert> = [];
    for (const c of read.rows) {
      const k = kindOk(c.contentKind);
      if (k === "no") continue;
      const common = { runId: run.runId, contentId: c.contentId, accountId: c.accountId, contentSnapshotId: c.snapshotId, publishedAt: c.publishedAt, likeValue: c.likeValue, likeState: c.likeState };
      if (c.publishedAt === null) rows.push({ ...common, l0: "unobtained", l1: "skipped", l2: "skipped", l3: "skipped", final: "unobtained", reasonCode: "published_at_missing", stopLayer: "0" });
      else if (c.publishedAt < fromUtc || c.publishedAt >= toUtc) continue; // 窗口外：不参与，不落行
      else if (k === "unknown") rows.push({ ...common, l0: "unobtained", l1: "skipped", l2: "skipped", l3: "skipped", final: "unobtained", reasonCode: "content_kind_unknown", stopLayer: "0" });
      else rows.push({ ...common, l0: "pass" });
    }
    await claim.withFence(run, async (tx) => {
      for (let i = 0; i < rows.length; i += 500) await tx.insert(runContents).values(rows.slice(i, i + 500)).onDuplicateKeyUpdate({ set: { runId: sql`run_id` } }); // 重进幂等
      for (const a of accountIds) {
        const s = sync.get(a)!;
        const ex = read.excluded.get(a);
        await tx.update(runParticipants).set({ syncComplete: s.complete, syncReason: s.reason, reasonDetail: { excluded_status: ex?.status ?? 0, excluded_no_snapshot: ex?.noSnapshot ?? 0 } as never }).where(and(eq(runParticipants.runId, run.runId), eq(runParticipants.accountId, a)));
      }
      await tx.update(judgementRuns).set({ phaseCursor: accountIds[accountIds.length - 1]!, updatedAt: clock.now() }).where(eq(judgementRuns.runId, run.runId));
    });
    env.run = { ...env.run, phaseCursor: accountIds[accountIds.length - 1]! };
    return { kind: "more" };
  }

  // ---- layer1：文本 / 话题 / 时长（只读 C 的文本信号与 A 的快照；不触发任何外部调用）----------------------------
  const l1Configured = (cfg: Config): boolean => cfg.layer1.text.length > 0 || cfg.layer1.hashtags.length > 0 || cfg.layer1.duration !== undefined;
  const waitDeadlineOf = (run: RunRow): Date | null => {
    const d = (run.phaseDetail as { waitDeadline?: string } | null)?.waitDeadline;
    return d ? new Date(d) : null;
  };

  async function layer1(env: Env): Promise<Out> {
    const { run, cfg, actor } = env;
    if (!l1Configured(cfg)) {
      await claim.withFence(run, async (tx) => void (await tx.update(runContents).set({ l1: "not_configured" }).where(and(eq(runContents.runId, run.runId), eq(runContents.l0, "pass"), isNull(runContents.l1)))));
      return { kind: "advance", phase: "select" };
    }
    const deadline = waitDeadlineOf(run);
    const expired = deadline !== null && clock.now() >= deadline;
    const skip = new Set<bigint>();
    let waiting = 0;
    for (;;) {
      if (Date.now() - env.startedMs > config.tickBudgetMs) return { kind: "more" };
      const batch = (
        await db
          .select({ contentId: runContents.contentId, snapshotId: runContents.contentSnapshotId })
          .from(runContents)
          .where(and(eq(runContents.runId, run.runId), eq(runContents.l0, "pass"), isNull(runContents.l1)))
          .orderBy(asc(runContents.contentId))
          .limit(config.signalBatch + skip.size)
      ).filter((r) => !skip.has(r.contentId)).slice(0, config.signalBatch);
      if (batch.length === 0) break;
      const subjects = batch.map((b) => ({ kind: "content" as const, id: b.contentId }));
      const need = (key: string) => signals.readMany(actor, subjects, key);
      const usesTitle = cfg.layer1.text.some((t) => t.fields.includes("title"));
      const usesBody = cfg.layer1.text.some((t) => t.fields.includes("body"));
      const [title, body, tags] = [usesTitle ? await need("text.title_normalized") : null, usesBody ? await need("text.body_normalized") : null, cfg.layer1.hashtags.length ? await need("text.hashtags") : null];
      const durations = cfg.layer1.duration ? await facts.durationsOf(batch.map((b) => b.snapshotId)) : null;
      const results: Array<{ contentId: bigint; layer: LayerResult; evidence: unknown }> = [];
      for (const b of batch) {
        const missing: SignalLike = { state: "missing", usable: false, reason: "not_computed" };
        const textSignalsOf = (id: bigint, ti: Map<bigint, SignalLike> | null, bo: Map<bigint, SignalLike> | null) => {
          const bySignal: Partial<Record<"title" | "body", SignalLike>> = {}; // 键是信号字段选择器，不是正文字段
          if (ti) bySignal["title"] = ti.get(id) ?? missing;
          if (bo) bySignal["body"] = bo.get(id) ?? missing;
          return bySignal;
        };
        const conds = [
          ...cfg.layer1.text.map((t) => evalKeywords(t, textSignalsOf(b.contentId, title, body), (r, v) => signals.normalizeKeyword(r, v))),
          ...cfg.layer1.hashtags.map((h) => evalHashtags(h, tags!.get(b.contentId) ?? missing, (r, v) => signals.normalizeKeyword(r, v))),
          ...(cfg.layer1.duration ? [evalDuration(cfg.layer1.duration, durations!.get(b.snapshotId) ?? { state: "missing", value: null, unit: "unknown" })] : []),
        ];
        const layer = combineLayer(conds);
        results.push({ contentId: b.contentId, layer, evidence: { l1: conds.map((c, idx) => ({ idx, state: c.state, ...(c.detail ?? {}), ...(c.reason ? { reason: c.reason } : {}) })) } });
      }
      const settled = results.filter((r) => r.layer.state !== "waiting" || expired);
      for (const r of results) if (r.layer.state === "waiting" && !expired) (skip.add(r.contentId), waiting++);
      await claim.withFence(run, async (tx) => {
        for (const r of settled) {
          const layerState = r.layer.state === "waiting" ? "unobtained" : r.layer.state;
          const reason = r.layer.state === "waiting" ? "dependency_timeout" : r.layer.reason;
          const stop = layerState === "fail" || layerState === "unobtained";
          await tx
            .update(runContents)
            .set({
              l1: layerState,
              ...(stop ? { l2: "skipped", l3: "skipped", final: layerState, stopLayer: "1", reasonCode: reason ?? null } : {}),
              stale: r.layer.stale,
              evidence: r.evidence as never,
            })
            .where(and(eq(runContents.runId, run.runId), eq(runContents.contentId, r.contentId), isNull(runContents.l1)));
        }
      });
    }
    if (waiting > 0) return { kind: "wait" };
    return { kind: "advance", phase: "select" };
  }

  // ---- select：第 1 层数量要求（按专员各自按点赞取前 N；N 缺省不截断）----------------------------------------------
  async function select(env: Env): Promise<Out> {
    const { run, cfg } = env;
    const n = cfg.layer1.quantity?.n;
    const people = await db.select({ accountId: runParticipants.accountId }).from(runParticipants).where(eq(runParticipants.runId, run.runId)).orderBy(asc(runParticipants.accountId));
    for (const p of people) {
      const rows = await db
        .select({ contentId: runContents.contentId, likeState: runContents.likeState, likeValue: runContents.likeValue, publishedAt: runContents.publishedAt })
        .from(runContents)
        .where(and(eq(runContents.runId, run.runId), eq(runContents.accountId, p.accountId), eq(runContents.l1, "pass")));
      if (rows.length === 0) continue;
      const { ranked, likeNotValue } = selectLayer1(rows.map((r) => ({ contentId: r.contentId, likeState: r.likeState, likeValue: r.likeValue, publishedAt: r.publishedAt! })), n);
      await claim.withFence(run, async (tx) => {
        // ponytail: 逐行更新，单专员 l1 通过的内容通常只有几十条；若出现上千条再改成 CASE 批量更新
        for (const r of ranked) {
          await tx
            .update(runContents)
            .set(r.selected ? { layer1Selected: true, layer1Rank: r.rank } : { layer1Selected: false, layer1Rank: r.rank, l2: "skipped", l3: "skipped", final: "skipped", reasonCode: "layer1_not_selected", stopLayer: "1" })
            .where(and(eq(runContents.runId, run.runId), eq(runContents.contentId, r.contentId)));
        }
        const [cur] = await tx.select({ d: runParticipants.reasonDetail }).from(runParticipants).where(and(eq(runParticipants.runId, run.runId), eq(runParticipants.accountId, p.accountId)));
        await tx.update(runParticipants).set({ reasonDetail: { ...((cur?.d as object | null) ?? {}), like_not_value: likeNotValue } as never }).where(and(eq(runParticipants.runId, run.runId), eq(runParticipants.accountId, p.accountId)));
      });
    }
    return { kind: "advance", phase: run.runKind === "circle" ? "finalize" : "scores" };
  }

  // ---- scores（第 2 层素材比对；试跑与执行共用，只对第 1 层选中的内容与账号能力的账号请求）-------------------------
    const signalsOf = (abs: readonly Ability[]): string[] => [...new Set(abs.map(scoreSignalOf))];
  const paramOf = (ref: { planId: bigint; version: number }, a: Ability) => ({ segment: ref, ...(a.kind === "image_element" ? { elementKey: a.elementKey! } : {}) });
  const evidenceOf = (a: Ability, r: { state: string; detail?: Record<string, unknown> | undefined; reason?: string | undefined }) => ({ id: a.abilityId, kind: a.kind, target: a.target, state: r.state, ...(r.detail ?? {}), ...(r.reason ? { reason: r.reason } : {}) });

  async function scores(env: Env): Promise<Out> {
    const { run, cfg, actor } = env;
    const ref = { planId: run.planId, version: run.version };
    const cAbs = contentAbilities(cfg);
    const aAbs = accountAbilities(cfg);
    const detail = (run.phaseDetail ?? {}) as { requestedContent?: boolean; requestedAccount?: boolean; waitDeadline?: string };
    const deadline = detail.waitDeadline ? new Date(detail.waitDeadline) : null;
    const expired = deadline !== null && clock.now() >= deadline;
    const fingerprint = hex(sha256Utf8(JSON.stringify({ run: String(run.runId), plan: String(run.planId), version: run.version, cfg: env.frozen.configSha256 })));
    const request = async (subjects: Array<{ kind: "content" | "account"; id: bigint }>, only: string[]): Promise<Out | null> => {
      for (const part of chunk(subjects, config.signalBatch)) {
        try {
          await signals.requestScores(actor, ref, part, { caller: run.submittedByActor, scopeFingerprint: fingerprint, only });
        } catch (e) {
          if (e instanceof SignalError && e.code === "not_executable") return { kind: "fail", code: "not_executable", detail: { blockers: e.detail } };
          throw e;
        }
      }
      return null;
    };
    // 待比对的内容：被第 1 层选中（或没有数量要求）、没有停在前层、l2 还没评估
    const pendingFilter = and(eq(runContents.runId, run.runId), eq(runContents.l0, "pass"), sql`${runContents.l1} IN ('pass','not_configured')`, sql`(${runContents.layer1Selected} IS NULL OR ${runContents.layer1Selected} = TRUE)`, isNull(runContents.l2));
    if (cAbs.length === 0) {
      await claim.withFence(run, async (tx) => void (await tx.update(runContents).set({ l2: "not_configured" }).where(pendingFilter)));
    } else {
      if (!detail.requestedContent) {
        const ids = await db.select({ id: runContents.contentId }).from(runContents).where(pendingFilter).orderBy(asc(runContents.contentId));
        const bad = await request(ids.map((r) => ({ kind: "content" as const, id: r.id })), signalsOf(cAbs));
        if (bad) return bad;
        await mergeDetail(deps, env, { requestedContent: true });
      }
      const skip = new Set<bigint>();
      let waiting = 0;
      for (;;) {
        if (Date.now() - env.startedMs > config.tickBudgetMs) return { kind: "more" };
        const batch = (await db.select({ contentId: runContents.contentId }).from(runContents).where(pendingFilter).orderBy(asc(runContents.contentId)).limit(config.signalBatch + skip.size)).filter((r) => !skip.has(r.contentId)).slice(0, config.signalBatch);
        if (batch.length === 0) break;
        const subjects = batch.map((b) => ({ kind: "content" as const, id: b.contentId }));
        const read = new Map<string, Map<bigint, SignalLike>>();
        for (const a of cAbs) read.set(a.abilityId, await signals.readMany(actor, subjects, scoreSignalOf(a), { param: paramOf(ref, a) }));
        await retainUntilOf(deps, env, [...read.values()].flatMap((m) => [...m.values()].map((v) => v.resultId))); // 先延长保留期，再写证据
        const missing: SignalLike = { state: "missing", usable: false, reason: "not_computed" };
        const results = batch.map((b) => {
          const conds = cAbs.map((a) => evalScore(thresholdToCents(a.threshold), read.get(a.abilityId)!.get(b.contentId) ?? missing));
          return { contentId: b.contentId, layer: combineLayer(conds), evidence: { l2: { abilities: cAbs.map((a, i) => evidenceOf(a, conds[i]!)) } } };
        });
        for (const r of results) if (r.layer.state === "waiting" && !expired) (skip.add(r.contentId), waiting++);
        await claim.withFence(run, async (tx) => {
          for (const r of results.filter((x) => x.layer.state !== "waiting" || expired)) {
            const st = r.layer.state === "waiting" ? "unobtained" : r.layer.state;
            const stop = st === "fail" || st === "unobtained";
            const [cur] = await tx.select({ ev: runContents.evidence, stale: runContents.stale }).from(runContents).where(and(eq(runContents.runId, run.runId), eq(runContents.contentId, r.contentId)));
            await tx
              .update(runContents)
              .set({ l2: st, ...(stop ? { l3: "skipped", final: st, stopLayer: "2", reasonCode: (r.layer.state === "waiting" ? "dependency_timeout" : r.layer.reason) ?? null } : {}), stale: Boolean(cur?.stale) || r.layer.stale, evidence: { ...((cur?.ev as object | null) ?? {}), ...r.evidence } as never })
              .where(and(eq(runContents.runId, run.runId), eq(runContents.contentId, r.contentId), isNull(runContents.l2)));
          }
        });
      }
      if (waiting > 0) return { kind: "wait" };
    }
    // 账号能力（头像 / 主页背景）：对名单账号比对，不依赖内容层
    if (aAbs.length > 0) {
      const people = await db.select({ accountId: runParticipants.accountId, detail: runParticipants.accountDetail }).from(runParticipants).where(eq(runParticipants.runId, run.runId)).orderBy(asc(runParticipants.accountId));
      if (!detail.requestedAccount) {
        const ids = people.map((p) => p.accountId);
        const asg = await facts.assignmentsOf(ids);
        const prof = await facts.profileOf(ids);
        const ready: bigint[] = [];
        await claim.withFence(run, async (tx) => {
          for (const id of ids) {
            const reason = asg.get(id)?.slotReleasedAt ? "account_unavailable" : prof.get(id) ? null : "no_profile_snapshot";
            if (reason) await tx.update(runParticipants).set({ accountDetail: { result: "unobtained", reason, abilities: [] } as never }).where(and(eq(runParticipants.runId, run.runId), eq(runParticipants.accountId, id)));
            else ready.push(id);
          }
        });
        const bad = await request(ready.map((id) => ({ kind: "account" as const, id })), signalsOf(aAbs));
        if (bad) return bad;
        await mergeDetail(deps, env, { requestedAccount: true });
      }
      const open = (await db.select({ accountId: runParticipants.accountId }).from(runParticipants).where(and(eq(runParticipants.runId, run.runId), isNull(runParticipants.accountDetail))).orderBy(asc(runParticipants.accountId))).map((r) => r.accountId);
      let waiting = 0;
      for (const part of chunk(open, config.signalBatch)) {
        const subjects = part.map((id) => ({ kind: "account" as const, id }));
        const read = new Map<string, Map<bigint, SignalLike>>();
        for (const a of aAbs) read.set(a.abilityId, await signals.readMany(actor, subjects, scoreSignalOf(a), { param: paramOf(ref, a) }));
        await retainUntilOf(deps, env, [...read.values()].flatMap((m) => [...m.values()].map((v) => v.resultId)));
        const missing: SignalLike = { state: "missing", usable: false, reason: "not_computed" };
        const writes: Array<{ id: bigint; value: unknown }> = [];
        for (const id of part) {
          const conds = aAbs.map((a) => evalScore(thresholdToCents(a.threshold), read.get(a.abilityId)!.get(id) ?? missing));
          const layer = combineLayer(conds);
          if (layer.state === "waiting" && !expired) {
            waiting++;
            continue;
          }
          const result = layer.state === "waiting" ? "unobtained" : layer.state;
          writes.push({ id, value: { result, ...(layer.state === "waiting" ? { reason: "dependency_timeout" } : layer.reason ? { reason: layer.reason } : {}), abilities: aAbs.map((a, i) => evidenceOf(a, conds[i]!)), stale: layer.stale } });
        }
        await claim.withFence(run, async (tx) => {
          for (const w of writes) await tx.update(runParticipants).set({ accountDetail: w.value as never }).where(and(eq(runParticipants.runId, run.runId), eq(runParticipants.accountId, w.id), isNull(runParticipants.accountDetail)));
        });
      }
      if (waiting > 0) return { kind: "wait" };
    }
    return { kind: "advance", phase: run.runKind === "execution" ? "demand" : "finalize" };
  }

  // ---- aggregate：行的最终结果 → 专员级结果（内容 / 账号 / 计划总结果），design §7.6 ----------------------------------------
  async function aggregate(env: Env): Promise<Out> {
    const { run, cfg } = env;
    const commentOn = commentRequirementEnabled(cfg);
    const contentOn = contentRequirementEnabled(cfg);
    const accountOn = accountRequirementEnabled(cfg);
    // 走完全部层的行：没配第 3 层 → l3 = not_configured，最终通过
    if (!cfg.contentRequirement?.layer3) await claim.withFence(run, async (tx) => void (await tx.update(runContents).set({ l3: "not_configured", final: "pass" }).where(and(eq(runContents.runId, run.runId), isNull(runContents.final), eq(runContents.l0, "pass")))));
    const people = await db.select().from(runParticipants).where(and(eq(runParticipants.runId, run.runId), eq(runParticipants.state, "pending"))).orderBy(asc(runParticipants.accountId));
    for (const p of people) {
      const rows = await db.select({ final: runContents.final, reasonCode: runContents.reasonCode, l1: runContents.l1, l2: runContents.l2, l0: runContents.l0, selected: runContents.layer1Selected, stale: runContents.stale, stopLayer: runContents.stopLayer, cmTotal: runContents.cmTotal, cmPass: runContents.cmPass, cmUnobtained: runContents.cmUnobtained, ev: runContents.evidence }).from(runContents).where(and(eq(runContents.runId, run.runId), eq(runContents.accountId, p.accountId)));
      const counts = contentCounts(rows.map((r) => ({ final: r.final as ContentRowLite["final"] })));
      const reasons: Record<string, number> = {};
      for (const r of rows) if (r.final === "unobtained") reasons[r.reasonCode ?? "unknown"] = (reasons[r.reasonCode ?? "unknown"] ?? 0) + 1;
      const zero = { syncComplete: p.syncComplete ?? false, syncReason: (p.syncReason as "sync_failed" | "sync_gap" | "no_sync_in_window" | null) ?? null };
      const content = contentOn ? contentOutcome(counts, cfg.layer1.quantity?.n ?? undefined, zero) : null;
      const acc = accountOn ? (p.accountDetail as { result?: string; reason?: string; stale?: boolean } | null) : null;
      const account: Outcome | null = !accountOn ? null : acc?.result === "pass" ? "success" : acc?.result === "fail" ? "not_met" : "unobtained";
      // 评论要求：候选 = C2；P / U / T 逐内容累加，F = T − P − U（design §7.7）
      const cm = rows.reduce((a, r) => ({ t: a.t + (r.cmTotal ?? 0), p: a.p + (r.cmPass ?? 0), u: a.u + (r.cmUnobtained ?? 0) }), { t: 0, p: 0, u: 0 });
      const cmReasons: Record<string, number> = {};
      for (const r of rows) for (const [k, n] of Object.entries(((r.ev as { cm?: { reasons?: Record<string, number> } } | null)?.cm?.reasons) ?? {})) cmReasons[k] = (cmReasons[k] ?? 0) + n;
      const candidateUnobtained = rows.some((r) => r.final === "unobtained" && ["0", "1", "2"].includes(r.stopLayer ?? ""));
      const comment = commentOn ? commentOutcome(cfg.commentRequirement!.method, { p: cm.p, u: cm.u, f: cm.t - cm.p - cm.u }, { candidateUnobtained, participantContentRows: counts.p + counts.u + counts.f + counts.skipped, zero }) : null;
      // 某内容的评论根本没拿到（采集失败 / 不支持 / 超时）：未知评论数没有上界，「不达标」不成立——只可能成功或未获取成功
      const depFailed = rows.some((r) => (r.ev as { cm?: { depFailed?: boolean } } | null)?.cm?.depFailed === true);
      const commentResult: Outcome | null = comment === null ? null : comment.result === "not_met" && depFailed ? "unobtained" : comment.result;
      const plan = andOutcome([content?.result ?? null, commentResult, account]);
      const primary = content?.result === "unobtained" ? (content.reason ?? topReason(reasons)) : commentResult === "unobtained" ? (comment!.reason ?? topReason(cmReasons)) : account === "unobtained" ? (acc?.reason ?? "unknown") : null;
      const c2 = rows.filter((r) => r.l0 === "pass" && ["pass", "not_configured"].includes(r.l1 ?? "") && r.selected !== false && ["pass", "not_configured"].includes(r.l2 ?? "")).length;
      const prev = (p.reasonDetail as Record<string, unknown> | null) ?? {};
      await claim.withFence(run, async (tx) => {
        await tx
          .update(runParticipants)
          .set({
            ...(contentOn ? { contentTotal: counts.p + counts.u + counts.f, contentPass: counts.p, contentFail: counts.f, contentUnobtained: counts.u, contentResult: content!.result } : {}),
            ...(commentOn ? { commentTotal: cm.t, commentPass: cm.p, commentUnobtained: cm.u, commentResult: commentResult! } : {}),
            contentSkipped: counts.skipped,
            c2Count: c2,
            c3Count: counts.p,
            accountResult: account,
            planResult: plan,
            primaryReason: primary,
            reasonDetail: { ...prev, unobtained_reasons: reasons, ...(commentOn ? { comment_unobtained_reasons: cmReasons } : {}) } as never,
            staleUsed: rows.some((r) => r.stale) || Boolean(acc?.stale),
            state: "done",
          })
          .where(and(eq(runParticipants.runId, run.runId), eq(runParticipants.accountId, p.accountId), eq(runParticipants.state, "pending")));
      });
    }
    return { kind: "advance", phase: "finalize" };
  }
  // ---- finalize ------------------------------------------------------------------------------------------------
  async function finalize(env: Env): Promise<Out> {
    const { run } = env;
    const id = run.runId;
    await claim.settle(
      run,
      { status: "completed", counters: {} },
      async (tx) => {
        // 每位参与专员的 C1 与未选中数：c1 = 通过（或没配）第 1 层且没被数量要求截掉的内容
        await tx.execute(sql`
          UPDATE run_participants p SET
            c1_count = (SELECT COUNT(*) FROM run_contents c WHERE c.run_id = p.run_id AND c.account_id = p.account_id AND c.l0 = 'pass' AND c.l1 IN ('pass','not_configured') AND (c.layer1_selected IS NULL OR c.layer1_selected = TRUE)),
            content_skipped = (SELECT COUNT(*) FROM run_contents c WHERE c.run_id = p.run_id AND c.account_id = p.account_id AND c.final = 'skipped')
          WHERE p.run_id = ${id}`);
        await tx.execute(sql`
          UPDATE judgement_runs r SET
            content_total = (SELECT COUNT(*) FROM run_contents c WHERE c.run_id = r.run_id),
            c1_count = (SELECT COALESCE(SUM(p.c1_count), 0) FROM run_participants p WHERE p.run_id = r.run_id),
            c2_count = (SELECT COALESCE(SUM(p.c2_count), 0) FROM run_participants p WHERE p.run_id = r.run_id),
            c3_count = (SELECT COALESCE(SUM(p.c3_count), 0) FROM run_participants p WHERE p.run_id = r.run_id),
            stale_used = EXISTS (SELECT 1 FROM run_participants p WHERE p.run_id = r.run_id AND p.stale_used = TRUE)
          WHERE r.run_id = ${id}`);
        // 圈定成功 → 向导进度 circled（只从 draft 起步，不回退已到 compared 的进度）
        if (run.runKind === "circle") await tx.update(judgementPlanVersions).set({ wizardStep: "circled", updatedAt: clock.now() }).where(and(eq(judgementPlanVersions.planId, run.planId), eq(judgementPlanVersions.version, run.version), eq(judgementPlanVersions.status, "draft"), eq(judgementPlanVersions.wizardStep, "draft")));
        // 试跑成功 → compared（只从 circled 起步）
        if (run.runKind === "compare") await tx.update(judgementPlanVersions).set({ wizardStep: "compared", updatedAt: clock.now() }).where(and(eq(judgementPlanVersions.planId, run.planId), eq(judgementPlanVersions.version, run.version), eq(judgementPlanVersions.status, "draft"), eq(judgementPlanVersions.wizardStep, "circled")));
      },
    );
    return { kind: "done" };
  }

  const dep = createDependencyPhases(deps);
  const PHASE_FN: Record<string, (env: Env) => Promise<Out>> = { freeze, scope, layer1, select, scores, demand: dep.demand, layer3: dep.layer3, comments: dep.comments, aggregate, finalize };

  // ---- tick ----------------------------------------------------------------------------------------------------
  /** 提交人复核（JP-15）：每个 tick 开头用 contextForUser 现建身份并确认仍持有该类运行所需的 Capability；失败则取消运行。 */
  async function submitterContext(run: RunRow): Promise<AuthContext | null> {
    try {
      const ctx = await authz.contextForSubmitter(run.submittedByActor);
      await authz.require(ctx, run.runKind === "execution" ? "execute" : "manage");
      return ctx;
    } catch (e) {
      if (!(e instanceof JudgementError)) throw e;
      // 取消与高风险审计在同一事务里：审计写失败则整笔回滚，下个 tick 再试
      await db.transaction(async (tx) => {
        if (await claim.cancel(run.runId, tx)) await audit.record({ event: "submitter_revoked", actor: run.submittedByActor, planId: run.planId, runId: run.runId, reasonCode: "submitter_revoked" }, tx);
      });
      return null;
    }
  }

  async function tick(run: RunRow): Promise<TickResult> {
    const startedMs = Date.now();
    const ctx = await submitterContext(run);
    if (!ctx) return "terminal";
    try {
      const [v] = await db.select().from(judgementPlanVersions).where(and(eq(judgementPlanVersions.planId, run.planId), eq(judgementPlanVersions.version, run.version)));
      const planRow = await facts.activityPlansOf([await activityPlanIdOf(run.planId)]);
      const activity = [...planRow.values()][0];
      if (!v || !activity || activity.status === "deleted") {
        await claim.settle(run, { status: "failed", code: "plan_not_found" });
        return "terminal";
      }
      const env: Env = { run, cfg: parseConfig(v.config), ctx, actor: await authz.toSignalActor(ctx), activity, frozen: (run.frozen as Frozen) ?? ({} as Frozen), startedMs };
      let phase = run.phase ?? "freeze";
      const order = PHASES_BY_KIND[run.runKind]!;
      for (;;) {
        const fn = PHASE_FN[phase];
        if (!fn || !order.includes(phase)) {
          await claim.settle(run, { status: "failed", code: "internal_error", detail: { phase } });
          return "terminal";
        }
        const out = await fn(env);
        if (out.kind === "done") return "terminal";
        if (out.kind === "fail") {
          await claim.settle(run, { status: "failed", code: out.code, detail: out.detail });
          return "terminal";
        }
        if (out.kind === "advance") {
          phase = out.phase;
          await claim.withFence(run, async (tx) => void (await setPhase(tx, run, phase, null)));
          env.run = { ...env.run, phase, phaseCursor: null, phaseDetail: null };
          continue;
        }
        const now = clock.now();
        if (out.kind === "wait") {
          const detail = (env.run.phaseDetail as { waitDeadline?: string } | null) ?? {};
          const on = out.on ?? "signals";
          const waitDeadline = detail.waitDeadline ?? new Date(now.getTime() + (on === "demand" ? config.waitDemandSeconds : config.waitSignalSeconds) * 1000).toISOString();
          await claim.settle(run, { status: "waiting", nextTickAt: new Date(now.getTime() + config.pollSeconds * 1000), phase, phaseDetail: { ...detail, waitDeadline, waitingOn: on }, attemptCount: 0 });
          return "waiting";
        }
        await claim.settle(run, { status: "waiting", nextTickAt: now, phase, phaseCursor: env.run.phaseCursor ?? null, attemptCount: 0 });
        return "continue";
      }
    } catch (e) {
      if (e instanceof StaleLeaseError) return "stale";
      // 阶段内的瞬时异常：退避重试；超过次数置 failed（已定的行保留，可 resume）
      const attempts = run.attemptCount + 1;
      try {
        if (attempts > config.phaseMaxAttempts) await claim.settle(run, { status: "failed", code: "internal_error", detail: { message: String((e as Error).message).slice(0, 200) } });
        else await claim.settle(run, { status: "waiting", nextTickAt: new Date(clock.now().getTime() + config.pollSeconds * 1000), attemptCount: attempts });
      } catch (inner) {
        if (!(inner instanceof StaleLeaseError)) throw inner;
        return "stale";
      }
      return attempts > config.phaseMaxAttempts ? "terminal" : "waiting";
    }
  }
  async function activityPlanIdOf(planId: bigint): Promise<bigint> {
    const [p] = await db.select({ a: judgementPlans.activityPlanId }).from(judgementPlans).where(eq(judgementPlans.planId, planId));
    return p!.a;
  }
  return { tick };
}
export type Runner = ReturnType<typeof createRunner>;
