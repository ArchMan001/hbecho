// D 的授权接入（design §9、JP-18）：走 B 的 authorize（先于任何读库）；后台运行继承提交人身份（不新增服务身份）。
import { constraintOf, isEmptyScope, type AccessRegistry, type AuthContext, type Authorizer, type ContextResolver, type DataScope, type ScopeStrategy } from "../access-control";
import { JudgementError } from "./errors";
import type { ActorContext, SignalActor } from "./ports";

/** 判定计划的授权引用：品牌、所属活动计划已加入的分公司、活动计划创建者。 */
export interface JudgementPlanRef {
  brandId: bigint;
  branchIds: readonly bigint[];
  planCreatorActor: string;
}

/** 品牌 ∈ 范围品牌，且（范围分公司为 all，或活动计划的某个已加入分公司 ∈ 范围分公司）；空范围一律不含。 */
export const judgementPlanStrategy: ScopeStrategy<JudgementPlanRef> = {
  contains: async (scope: DataScope, ref) => {
    if (isEmptyScope(scope)) return false;
    const brandOk = scope.brands === "all" || scope.brands.has(ref.brandId);
    const branchOk = scope.branches === "all" || ref.branchIds.some((b) => (scope.branches as ReadonlySet<bigint>).has(b));
    return brandOk && branchOk;
  },
  constraint: constraintOf,
};

/** 装配处调用：先查再注册，重复调用不抛（沿用 learning 的写法）。 */
export function registerJudgementAuthz(registry: AccessRegistry): void {
  if (!registry.scopeStrategy("judgement_plan")) registry.registerScopeStrategy("judgement_plan", judgementPlanStrategy as ScopeStrategy<never>);
  if (!registry.predicate("plan_creator")) registry.registerPredicate("plan_creator", (ctx, ref) => ctx.platformAdmin || ctx.actor === (ref as JudgementPlanRef).planCreatorActor);
}

export type JudgementAction = "read" | "manage" | "execute";
const CAPABILITY: Record<JudgementAction, string> = { read: "rule.definition.read", manage: "rule.definition.manage", execute: "rule.run.execute" };

export function createJudgementAuthz(deps: { authorizer: Authorizer; resolver: Pick<ContextResolver, "contextForUser">; facts: { brandCodesOf(ids: readonly bigint[]): Promise<string[]> } }) {
  /**
   * 授权入口：读 = Capability + 范围；写与执行再要求谓词 plan_creator（操作者是所属活动计划创建者或超管）。
   * 越范围的对象表现为 not_found（不泄露存在性）；缺 Capability / 谓词失败 = authorization。
   */
  async function require(ctx: AuthContext, action: JudgementAction, ref?: JudgementPlanRef): Promise<void> {
    const write = action !== "read";
    const d = await deps.authorizer.authorize(ctx, {
      capability: CAPABILITY[action],
      resource: { key: "judgement_plan", ...(ref ? { ref } : {}), ...(write && ref ? { predicates: ["plan_creator"] } : {}) },
    });
    if (d.ok) return;
    if (d.kind === "not_found") throw new JudgementError("not_found", "judgement_plan_not_found", "判定计划不存在");
    throw new JudgementError("authorization", `denied_${d.reason}`, "没有权限执行这个操作", { reason: d.reason });
  }

  /** 提交人身份：每个 tick 现建（用户停用、专员失效、范围无法解析都失败），运行随之取消（submitter_revoked）。 */
  async function contextForSubmitter(actor: string): Promise<AuthContext> {
    const m = /^user:(\d{1,19})$/.exec(actor);
    if (!m) throw new JudgementError("authorization", "submitter_revoked", "提交人身份不是有效用户");
    const r = await deps.resolver.contextForUser(BigInt(m[1]!), null);
    if (!r.ok) throw new JudgementError("authorization", "submitter_revoked", "提交人已不可用", { reason: r.reason });
    return r.ctx;
  }

  /** 把 AuthContext 译成 C 的 SignalActor；品牌译不成编码就拒绝，不降级。 */
  async function toSignalActor(ctx: AuthContext): Promise<SignalActor> {
    if (ctx.scope.brands === "all") return { actor: ctx.actor, capabilities: ctx.capabilities, brandScope: "all" };
    const ids = [...ctx.scope.brands];
    if (ids.length === 0) return { actor: ctx.actor, capabilities: ctx.capabilities, brandScope: new Set() };
    const codes = await deps.facts.brandCodesOf(ids);
    if (codes.length !== ids.length) throw new JudgementError("authorization", "brand_unmappable", "无法把授权品牌映射成品牌编码");
    return { actor: ctx.actor, capabilities: ctx.capabilities, brandScope: new Set(codes) };
  }

  return { require, contextForSubmitter, toSignalActor, toDemandActor };
}
export type JudgementAuthz = ReturnType<typeof createJudgementAuthz>;

/**
 * 把提交人译成 A 的 ActorContext（design §9）。A 的 ActorContext 没有品牌维度，B 的 toTracerActor 只给全范围用户适配，
 * 品牌受限的 hq_manager 会被拒；D 的窄适配：actorId 与 capabilities 取提交人的，范围放宽为全平台；`platformAdmin` 恒为 false（demand 不用它，业务代码也不写角色条件，B-AX-6）——
 * 放宽只发生在这一处，且 D 提交的主体只来自已冻结的、提交人已授权范围内的名单（design §14 第 31 项）。
 */
export function toDemandActor(ctx: AuthContext): ActorContext {
  if (!ctx.capabilities.has("data.sync.trigger")) throw new JudgementError("authorization", "denied_capability_not_granted", "提交人没有触发采集的权限");
  return { actorId: ctx.actor, capabilities: ctx.capabilities, platformAdmin: false, scope: { platformCodes: "all", mediaStaffIds: "all" } };
}
