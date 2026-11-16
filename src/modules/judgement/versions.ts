// 草稿、版本与发布（JP-3、JP-4）：草稿可改，已发布不可变（D-D08）；第 3 页「确认执行」即发布（design §14 第 2 项）；
// 回退只作用于草稿（design §14 第 3 项）。对 C 的调用一律在事务之外；C 的调用失败不回滚已提交的 D 配置，
// 发布前会再把 deriveItems 同步给 C，所以 C 侧落后只会被补齐，不会被带上线。
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { judgementPlanVersions, judgementPlans } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { SignalError } from "../signals/errors";
import {
  ConfigError, configSha256, CONFIG_SCHEMA_VERSION, deriveItems, incompleteAbilities, invalidationOf, parseConfig, validateConfig, contentRequirementEnabled,
  type Ability, type Config, type Invalidation,
} from "./config";
import { JudgementError } from "./errors";
import { loadPlan, type JudgementDeps, type PlanRow, type VersionRow } from "./plans";
import { createRunOps, type RunKind } from "./run-ops";

const STEP_ORDER = ["draft", "circled", "compared"] as const;
type Step = (typeof STEP_ORDER)[number];
const minStep = (a: Step, b: Step): Step => (STEP_ORDER.indexOf(a) <= STEP_ORDER.indexOf(b) ? a : b);
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 把 SignalError 译成 JudgementError：C 的输入类错误是操作者可修的，其余当依赖故障。 */
function fromSignal(e: unknown): never {
  if (e instanceof SignalError) {
    if (e.category === "input" || e.category === "limit") throw new JudgementError("input", e.code, e.message, e.detail);
    if (e.category === "conflict") throw new JudgementError("conflict", e.code, e.message, e.detail);
    throw new JudgementError("dependency", e.code, e.message, e.detail);
  }
  throw e;
}

export function createVersions(deps: JudgementDeps) {
  const { db, clock, authz, audit, signals, limits } = deps;

  async function versionOf(planId: bigint, version: number): Promise<VersionRow | null> {
    const [v] = await db.select().from(judgementPlanVersions).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, version)));
    return v ?? null;
  }
  async function draftOf(planId: bigint): Promise<VersionRow | null> {
    const [v] = await db.select().from(judgementPlanVersions).where(and(eq(judgementPlanVersions.planId, planId), inArray(judgementPlanVersions.status, ["draft", "publishing"])));
    return v ?? null;
  }
  async function needDraft(planId: bigint): Promise<VersionRow> {
    const d = await draftOf(planId);
    if (!d) throw new JudgementError("conflict", "version_immutable", "已发布的版本不可修改；请先新建草稿（new-draft）");
    if (d.status !== "draft") throw new JudgementError("conflict", "version_publishing", "正在发布，请稍后或先对账（reconcile）");
    return d;
  }
  const editablePlan = (plan: PlanRow): void => {
    if (plan.status === "archived") throw new JudgementError("conflict", "plan_archived", "判定计划已归档");
    if (plan.status === "provisioning") throw new JudgementError("conflict", "plan_provisioning", "判定计划尚未建好，请先对账");
  };
  /** 授权 + 取计划 + 取草稿（写类操作的统一入口）。 */
  async function openDraft(ctx: AuthContext, planId: bigint, action: "manage" | "execute" = "manage") {
    await authz.require(ctx, action); // 缺 Capability 先于任何读库被拒
    const loaded = await loadPlan(deps, planId);
    await authz.require(ctx, action, loaded.ref);
    editablePlan(loaded.plan);
    return { ...loaded, draft: await needDraft(planId), actor: await authz.toSignalActor(ctx) };
  }
  const { activeRunExists, deleteRuns, countRuns } = createRunOps(db);
  const kindsOf = (inv: Invalidation): RunKind[] => (inv === "circle_and_trial" ? ["circle", "compare"] : inv === "trial" ? ["compare"] : []);
  const stepAfter = (inv: Invalidation, cur: Step): Step => (inv === "circle_and_trial" ? "draft" : inv === "trial" ? minStep(cur, "circled") : cur);

  /** 草稿上改配置会使哪些结果失效：先检查没有在途的圈定 / 试跑，再在事务里改配置与进度，然后分块删结果。 */
  async function applyDraftChange(planId: bigint, draft: VersionRow, next: Config | null, inv: Invalidation): Promise<void> {
    const kinds = kindsOf(inv);
    if (kinds.length && (await activeRunExists(planId, draft.version, kinds))) throw new JudgementError("conflict", "run_active", "有圈定或试跑正在进行，请等它结束或先取消");
    await db.transaction(async (tx: DbTx) => {
      await tx
        .update(judgementPlanVersions)
        .set({ ...(next ? { config: next, configSha256: configSha256(next), configSchemaVersion: CONFIG_SCHEMA_VERSION } : {}), wizardStep: stepAfter(inv, draft.wizardStep as Step), updatedAt: clock.now() })
        .where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, draft.version), eq(judgementPlanVersions.status, "draft")));
    });
    if (kinds.length) await deleteRuns(planId, draft.version, kinds);
  }

  const ensureIds = (raw: unknown): unknown => {
    if (typeof raw !== "object" || raw === null) return raw;
    const o = raw as { layer2?: { abilities?: Array<Record<string, unknown>> } };
    const abilities = o.layer2?.abilities;
    if (!Array.isArray(abilities)) return raw;
    return { ...o, layer2: { ...o.layer2, abilities: abilities.map((a) => (a && typeof a === "object" && a.abilityId === undefined ? { ...a, abilityId: `a-${randomUUID()}` } : a)) } };
  };
  /** elementKey 由 D 在上传时写入，不接受调用方直接设置：沿用同 abilityId 且 kind / target 未变的旧值，其余一律清掉。 */
  const keepServerManaged = (prev: Config, next: Config): Config => ({
    ...next,
    layer2: {
      abilities: next.layer2.abilities.map((a) => {
        const p = prev.layer2.abilities.find((x) => x.abilityId === a.abilityId && x.kind === a.kind && x.target === a.target);
        const { elementKey: _drop, ...rest } = a;
        return p?.elementKey !== undefined && a.kind === "image_element" ? { ...rest, elementKey: p.elementKey } : rest;
      }),
    },
  });

  const imageKeyOf = (planId: bigint, version: number, a: Ability) =>
    a.kind === "image_element" ? ({ planId, version, kind: "element", target: a.target, elementKey: a.elementKey! } as const) : ({ planId, version, kind: "template", target: a.target } as const);

  /** 能力被删 / 改 kind / 改 target 后，把它在 C 的图片清掉（尽力而为；失败留给 reconcileDraft）。 */
  async function dropOrphanImages(planId: bigint, version: number, prev: Config, next: Config, actor: Awaited<ReturnType<typeof authz.toSignalActor>>): Promise<string[]> {
    const failed: string[] = [];
    for (const a of prev.layer2.abilities) {
      const still = next.layer2.abilities.find((x) => x.abilityId === a.abilityId && x.kind === a.kind && x.target === a.target);
      if (still || (a.kind === "image_element" && a.elementKey === undefined)) continue;
      try {
        await signals.segments.removeImage(actor, imageKeyOf(planId, version, a));
      } catch {
        failed.push(a.abilityId);
      }
    }
    return failed;
  }
  async function syncItems(planId: bigint, version: number, cfg: Config, actor: Awaited<ReturnType<typeof authz.toSignalActor>>): Promise<void> {
    try {
      await signals.segments.setItems(actor, { planId, version }, deriveItems(cfg));
    } catch (e) {
      fromSignal(e);
    }
  }

  async function setConfig(ctx: AuthContext, planId: bigint, raw: unknown): Promise<{ configSha256: string; invalidation: Invalidation }> {
    const { draft, activity, actor } = await openDraft(ctx, planId);
    const prev = parseConfig(draft.config);
    let next: Config;
    try {
      next = keepServerManaged(prev, parseConfig(ensureIds(raw)));
    } catch (e) {
      if (e instanceof ConfigError) throw new JudgementError("input", "config_invalid", e.message, { issues: e.issues });
      throw e;
    }
    const issues = validateConfig(next, activity.platformCode, signals.platformSignals(activity.platformCode), limits, { complete: false });
    if (issues.length) throw new JudgementError("input", "config_invalid", issues.map((i) => i.message).join("；"), { issues });
    const inv = invalidationOf(prev, next);
    await applyDraftChange(planId, draft, next, inv);
    await audit.record({ event: "config_changed", actor: ctx.actor, actorUserId: ctx.userId, planId, detail: { version: draft.version, invalidation: inv } });
    await dropOrphanImages(planId, draft.version, prev, next, actor);
    await syncItems(planId, draft.version, next, actor);
    return { configSha256: configSha256(next).toString("hex"), invalidation: inv };
  }

  // ---- 标准图 / 元素图 -----------------------------------------------------------------------------------------
  async function abilityOf(draft: VersionRow, abilityId: string, kind: Ability["kind"]): Promise<{ cfg: Config; ability: Ability }> {
    const cfg = parseConfig(draft.config);
    const ability = cfg.layer2.abilities.find((a) => a.abilityId === abilityId);
    if (!ability) throw new JudgementError("not_found", "ability_not_found", "没有这个能力");
    if (ability.kind !== kind) throw new JudgementError("input", "ability_kind_mismatch", kind === "image_element" ? "只有图片元素对比需要上传元素图" : "只有整张图片对比需要上传标准图");
    return { cfg, ability };
  }
  const replaceAbility = (cfg: Config, id: string, patch: (a: Ability) => Ability): Config => ({ ...cfg, layer2: { abilities: cfg.layer2.abilities.map((a) => (a.abilityId === id ? patch(a) : a)) } });

  /** 整张图片对比的标准图：按 target 覆盖，一个对比元素一张。图片字节变了，试跑结果作废。 */
  async function putTemplate(ctx: AuthContext, planId: bigint, abilityId: string, bytes: Uint8Array): Promise<{ sha256: string }> {
    const { draft, actor } = await openDraft(ctx, planId);
    const { ability } = await abilityOf(draft, abilityId, "whole_image");
    if (bytes.length === 0) throw new JudgementError("input", "image_empty", "图片不能为空");
    let r: { sha256: string };
    try {
      r = await signals.segments.putImage(actor, { planId, version: draft.version, kind: "template", target: ability.target }, bytes);
    } catch (e) {
      fromSignal(e);
    }
    await applyDraftChange(planId, draft, null, "trial");
    return { sha256: r.sha256 };
  }

  /** 图片元素对比的元素图：字节 SHA-256 作 elementKey，由 D 写入配置；换图换 key、旧图行删除；同 target 相同字节被拒。 */
  async function putElement(ctx: AuthContext, planId: bigint, abilityId: string, bytes: Uint8Array): Promise<{ elementKey: string }> {
    const { draft, actor } = await openDraft(ctx, planId);
    const { cfg, ability } = await abilityOf(draft, abilityId, "image_element");
    if (bytes.length === 0) throw new JudgementError("input", "image_empty", "图片不能为空");
    const key = sha256Hex(bytes);
    if (cfg.layer2.abilities.some((a) => a.abilityId !== abilityId && a.kind === "image_element" && a.target === ability.target && a.elementKey === key)) {
      throw new JudgementError("conflict", "element_duplicate", "这张图已经作为元素上传");
    }
    const old = ability.elementKey;
    if (old === key) return { elementKey: key };
    try {
      await signals.segments.putImage(actor, { planId, version: draft.version, kind: "element", target: ability.target, elementKey: key }, bytes);
    } catch (e) {
      fromSignal(e);
    }
    const next = replaceAbility(cfg, abilityId, (a) => ({ ...a, elementKey: key }));
    await applyDraftChange(planId, draft, next, "trial");
    if (old !== undefined) await signals.segments.removeImage(actor, { planId, version: draft.version, kind: "element", target: ability.target, elementKey: old }).catch(() => undefined);
    await syncItems(planId, draft.version, next, actor);
    return { elementKey: key };
  }

  async function removeImage(ctx: AuthContext, planId: bigint, abilityId: string): Promise<void> {
    const { draft, actor } = await openDraft(ctx, planId);
    const cfg = parseConfig(draft.config);
    const ability = cfg.layer2.abilities.find((a) => a.abilityId === abilityId);
    if (!ability) throw new JudgementError("not_found", "ability_not_found", "没有这个能力");
    if (ability.kind === "image_element") {
      if (ability.elementKey === undefined) return;
      await signals.segments.removeImage(actor, imageKeyOf(planId, draft.version, ability)).catch((e) => fromSignal(e));
      const next = replaceAbility(cfg, abilityId, (a) => {
        const { elementKey: _gone, ...rest } = a;
        return rest;
      });
      await applyDraftChange(planId, draft, next, "trial");
      await syncItems(planId, draft.version, next, actor);
    } else {
      await signals.segments.removeImage(actor, imageKeyOf(planId, draft.version, ability)).catch((e) => fromSignal(e));
      await applyDraftChange(planId, draft, null, "trial");
    }
  }

  /** 对账草稿的图片：C 有而配置无的元素图删掉；配置有而 C 无的 elementKey 清掉（上传两步之间崩溃的善后）。 */
  async function reconcileDraft(ctx: AuthContext, planId: bigint): Promise<{ removedOrphans: number; clearedKeys: number }> {
    const { draft, actor } = await openDraft(ctx, planId);
    const cfg = parseConfig(draft.config);
    const shown = (await signals.segments.show(actor, { planId, version: draft.version })) as unknown as { images: Array<{ kind: string; target: string; elementKey?: string }> };
    const inC = new Set(shown.images.filter((i) => i.kind === "element").map((i) => `${i.target}|${i.elementKey ?? ""}`));
    const inD = new Set(cfg.layer2.abilities.filter((a) => a.kind === "image_element" && a.elementKey !== undefined).map((a) => `${a.target}|${a.elementKey}`));
    let removedOrphans = 0;
    for (const i of shown.images.filter((x) => x.kind === "element" && !inD.has(`${x.target}|${x.elementKey ?? ""}`))) {
      await signals.segments.removeImage(actor, { planId, version: draft.version, kind: "element", target: i.target as Ability["target"], elementKey: i.elementKey! });
      removedOrphans++;
    }
    const missing = cfg.layer2.abilities.filter((a) => a.kind === "image_element" && a.elementKey !== undefined && !inC.has(`${a.target}|${a.elementKey}`));
    if (missing.length) {
      const next: Config = { ...cfg, layer2: { abilities: cfg.layer2.abilities.map((a) => (missing.includes(a) ? (({ elementKey: _k, ...rest }) => rest)(a) : a)) } };
      await applyDraftChange(planId, draft, next, "trial");
    }
    return { removedOrphans, clearedKeys: missing.length };
  }

  // ---- 回退 ----------------------------------------------------------------------------------------------------
  /** 回退只作用于草稿，每次只退一层；预览不写任何表，--apply 才删（回退直接删除后续步骤的结果，不留历史）。 */
  async function rollback(ctx: AuthContext, planId: bigint, o: { apply: boolean }): Promise<{ from: Step; to: Step; runs: number; rows: number; applied: boolean }> {
    await authz.require(ctx, "manage");
    const loaded = await loadPlan(deps, planId);
    await authz.require(ctx, "manage", loaded.ref);
    editablePlan(loaded.plan);
    const draft = await draftOf(planId);
    if (!draft) throw new JudgementError("conflict", "version_immutable", "已发布的版本不能回退；请新建草稿（new-draft）后再改");
    const from = draft.wizardStep as Step;
    if (from === "draft") throw new JudgementError("conflict", "nothing_to_rollback", "第 1 页没有可回退的步骤");
    const to: Step = from === "compared" ? "circled" : "draft";
    const kinds: RunKind[] = to === "circled" ? ["compare"] : ["circle", "compare"];
    const preview = await countRuns(planId, draft.version, kinds);
    if (!o.apply) return { from, to, ...preview, applied: false };
    if (await activeRunExists(planId, draft.version, kinds)) throw new JudgementError("conflict", "run_active", "有圈定或试跑正在进行，请等它结束或先取消");
    await db.transaction(async (tx: DbTx) => {
      await tx.update(judgementPlanVersions).set({ wizardStep: to, updatedAt: clock.now() }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, draft.version), eq(judgementPlanVersions.status, "draft")));
      await audit.record({ event: "rollback_applied", actor: ctx.actor, actorUserId: ctx.userId, planId, detail: { version: draft.version, from, to, ...preview } }, tx);
    });
    const done = await deleteRuns(planId, draft.version, kinds);
    return { from, to, ...done, applied: true };
  }

  // ---- 新建草稿 ------------------------------------------------------------------------------------------------
  /** 新建草稿：来源默认最近已发布版本，也可以是任意已发布版本；版本号必须与 C 一致，不一致停止，不静默对齐。 */
  async function newDraft(ctx: AuthContext, planId: bigint, fromVersion?: number): Promise<{ version: number }> {
    await authz.require(ctx, "manage");
    const { plan, ref } = await loadPlan(deps, planId);
    await authz.require(ctx, "manage", ref);
    editablePlan(plan);
    if (await draftOf(planId)) throw new JudgementError("conflict", "draft_exists", "已有草稿，不能再新建");
    const published = await db.select().from(judgementPlanVersions).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "published"))).orderBy(desc(judgementPlanVersions.version));
    const source = fromVersion === undefined ? published[0] : published.find((v) => v.version === fromVersion);
    if (!source) throw new JudgementError("not_found", "version_not_found", fromVersion === undefined ? "还没有已发布的版本" : `版本 ${fromVersion} 不是已发布版本`);
    const want = plan.latestVersion + 1;
    const actor = await authz.toSignalActor(ctx);
    // 上一次在 C 已建、D 未落行就崩溃时，C 里已有 want：采用它，不再建 want+1
    let cVersion: number;
    const existing = await signals.segments.show(actor, { planId, version: want }).then(() => true, () => false);
    if (existing) cVersion = want;
    else {
      try {
        cVersion = (await signals.segments.newDraft(actor, { planId, fromVersion: source.version })).version;
      } catch (e) {
        fromSignal(e);
      }
    }
    if (cVersion !== want) throw new JudgementError("conflict", "version_mismatch", `D 期望版本 ${want}，C 返回 ${cVersion}；已停止，不静默对齐`);
    const now = clock.now();
    await db.transaction(async (tx: DbTx) => {
      await tx.insert(judgementPlanVersions).values({
        planId, version: want, status: "draft", wizardStep: "draft", config: source.config, configSchemaVersion: source.configSchemaVersion, configSha256: source.configSha256, basedOnVersion: source.version, createdByActor: ctx.actor, createdAt: now, updatedAt: now,
      });
      await tx.update(judgementPlans).set({ latestVersion: want, updatedAt: now }).where(eq(judgementPlans.planId, planId));
      await audit.record({ event: "config_changed", actor: ctx.actor, actorUserId: ctx.userId, planId, detail: { newDraft: want, basedOn: source.version } }, tx);
    });
    return { version: want };
  }

  // ---- 发布 ----------------------------------------------------------------------------------------------------
  /** 草稿发布所需的向导进度：第 2 页没有能力时圈定后即可，否则要试跑过。 */
  const requiredStep = (cfg: Config): Step => (cfg.layer2.abilities.length === 0 ? "circled" : "compared");

  /**
   * 发布草稿（第 3 页确认执行的前半段）：先拒绝不可执行的（不改任何状态）→ 草稿置 publishing → 事务外同步 items 并调 C.publish
   * → 置 published（并在同一事务里调 onPublished，任务 7 在那里建执行运行）。C 拒绝时草稿回到 draft 并带阻塞项。
   */
  async function publish(ctx: AuthContext, planId: bigint, hooks: { onPublished?: (tx: DbTx, v: { version: number }) => Promise<void> } = {}): Promise<{ version: number }> {
    const { draft, activity, actor, plan } = await openDraft(ctx, planId, "execute");
    const cfg = parseConfig(draft.config);
    const issues = validateConfig(cfg, activity.platformCode, signals.platformSignals(activity.platformCode), limits, { complete: true });
    if (issues.length) throw new JudgementError("input", "config_invalid", issues.map((i) => i.message).join("；"), { issues });
    if (incompleteAbilities(cfg).length) throw new JudgementError("input", "image_missing", "还有图片元素对比没有上传元素图", { abilities: incompleteAbilities(cfg).map((a) => a.abilityId) });
    if (STEP_ORDER.indexOf(draft.wizardStep as Step) < STEP_ORDER.indexOf(requiredStep(cfg))) throw new JudgementError("conflict", "wizard_step_required", "请先完成上一步（圈定 / 试跑）");
    const ref = { planId, version: draft.version };
    await syncItems(planId, draft.version, cfg, actor); // C 侧可能落后（setConfig 之后的 setItems 失败过）
    const ex = await signals.executability(actor, ref);
    if (!ex.executable) throw new JudgementError("conflict", "not_executable", "监控段当前不可执行，不能发布", { blockers: ex.blockers });
    await db.update(judgementPlanVersions).set({ status: "publishing", updatedAt: clock.now() }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, draft.version), eq(judgementPlanVersions.status, "draft")));
    try {
      await signals.segments.publish(actor, ref);
    } catch (e) {
      await db.update(judgementPlanVersions).set({ status: "draft", updatedAt: clock.now() }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, draft.version), eq(judgementPlanVersions.status, "publishing")));
      fromSignal(e);
    }
    await markPublished(ctx, plan.planId, draft.version, hooks);
    return { version: draft.version };
  }
  async function markPublished(ctx: AuthContext, planId: bigint, version: number, hooks: { onPublished?: (tx: DbTx, v: { version: number }) => Promise<void> }): Promise<void> {
    const now = clock.now();
    await db.transaction(async (tx: DbTx) => {
      await tx.update(judgementPlanVersions).set({ status: "published", publishedAt: now, publishedByActor: ctx.actor, updatedAt: now }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, version), eq(judgementPlanVersions.status, "publishing")));
      await audit.record({ event: "version_published", actor: ctx.actor, actorUserId: ctx.userId, planId, detail: { version } }, tx);
      await hooks.onPublished?.(tx, { version });
    });
  }

  /** 对账 publishing：以 C 的状态为准——C 已发布则补完 D；C 仍是草稿则回到 draft。 */
  async function reconcilePublishing(ctx: AuthContext, planId: bigint, hooks: { onPublished?: (tx: DbTx, v: { version: number }) => Promise<void> } = {}): Promise<{ state: "published" | "reverted" | "none" }> {
    await authz.require(ctx, "execute");
    const { ref } = await loadPlan(deps, planId);
    await authz.require(ctx, "execute", ref);
    const d = await draftOf(planId);
    if (!d || d.status !== "publishing") return { state: "none" };
    const shown = await signals.segments.show(await authz.toSignalActor(ctx), { planId, version: d.version });
    if (shown.status === "published") {
      await markPublished(ctx, planId, d.version, hooks);
      return { state: "published" };
    }
    await db.update(judgementPlanVersions).set({ status: "draft", updatedAt: clock.now() }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, d.version), eq(judgementPlanVersions.status, "publishing")));
    return { state: "reverted" };
  }

  async function showConfig(ctx: AuthContext, planId: bigint, version?: number): Promise<{ version: number; status: string; wizardStep: string; config: Config; configSha256: string }> {
    await authz.require(ctx, "read");
    const { ref } = await loadPlan(deps, planId);
    await authz.require(ctx, "read", ref);
    const v = version === undefined ? ((await draftOf(planId)) ?? (await db.select().from(judgementPlanVersions).where(eq(judgementPlanVersions.planId, planId)).orderBy(desc(judgementPlanVersions.version)).limit(1))[0]) : await versionOf(planId, version);
    if (!v) throw new JudgementError("not_found", "version_not_found", "版本不存在");
    return { version: v.version, status: v.status, wizardStep: v.wizardStep, config: parseConfig(v.config), configSha256: Buffer.from(v.configSha256).toString("hex") };
  }

  return { setConfig, putTemplate, putElement, removeImage, reconcileDraft, rollback, newDraft, publish, reconcilePublishing, showConfig, draftOf, versionOf, requiredStep, contentEnabled: contentRequirementEnabled };
}
export type Versions = ReturnType<typeof createVersions>;
