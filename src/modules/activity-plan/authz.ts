// 授权入口（design §9、AP-14）。业务模块只调 assert，不读角色名，不自行放行。
// 顺序：Capability → 来自 actor 的品牌 / 分公司范围（二者都先于任何数据库读取）→ 资源谓词（创建者）。
// B 落地后 assert 的判定委托给 b-access-control 的 authorize，这里退化为薄封装；调用方不变（toPlanActor 已提供适配）。
import { PlanError } from "./errors";

export const CAP_PLAN_CREATE = "activity_plan.create";
export const CAP_PLAN_JOIN = "activity_plan.join";
export const CAP_ACCOUNT_MANAGE = "data.account.manage";

export interface PlanActor {
  /** 审计主体，如 service:plan-cli / user:12 */
  readonly actor: string;
  readonly capabilities: ReadonlySet<string>;
  /** 品牌编码集合，或 "all"。 */
  readonly brandScope: ReadonlySet<string> | "all";
  /** 分公司 ID 集合，或 "all"（总部与超管）。 */
  readonly branchScope: ReadonlySet<bigint> | "all";
  /** 创建者谓词的超管旁路；显式声明，缺省 false。 */
  readonly platformAdmin: boolean;
}

export interface PlanResource {
  brandCode?: string;
  branchId?: bigint;
  /** 计划创建者（created_by_actor）；给出时要求操作者就是创建者或超管。 */
  creator?: string;
  /** 越范围时的表现：reject（默认，新建 / 提交类命令）；hide（已有对象的读写，表现为未找到，不泄露存在性）。 */
  outOfScope?: "reject" | "hide";
}

export const brandInScope = (a: PlanActor, brandCode: string): boolean => a.brandScope === "all" || a.brandScope.has(brandCode);
export const branchInScope = (a: PlanActor, branchId: bigint): boolean => a.branchScope === "all" || a.branchScope.has(branchId);

export function assert(actor: PlanActor, capability: string, resource: PlanResource = {}): void {
  if (!actor.capabilities.has(capability)) throw new PlanError("authorization", "forbidden", `缺少 Capability ${capability}`);
  const hide = resource.outOfScope === "hide";
  if (resource.brandCode !== undefined && !brandInScope(actor, resource.brandCode)) {
    if (hide) throw new PlanError("not_found", "not_found", "未找到");
    throw new PlanError("authorization", "brand_out_of_scope", "品牌不在你的授权范围内");
  }
  if (resource.branchId !== undefined && !branchInScope(actor, resource.branchId)) {
    if (hide) throw new PlanError("not_found", "not_found", "未找到");
    throw new PlanError("authorization", "branch_out_of_scope", "分公司不在你的授权范围内");
  }
  if (resource.creator !== undefined && resource.creator !== actor.actor && !actor.platformAdmin) {
    throw new PlanError("authorization", "not_plan_creator", "只有计划创建者或超管可以执行这个操作");
  }
}

const list = (v: string): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * 从环境变量构造服务身份。缺 actor / capabilities / brand_scope / branch_scope 任一项启动失败，
 * 不退化成「全部」；HBECHO_AP_PLATFORM_ADMIN 缺省为 false。
 * 分公司编码在启动时经 resolveBranches 解析成 ID（编码不存在则失败）。
 */
export async function actorFromEnv(
  env: Record<string, string | undefined>,
  resolveBranches: (codes: string[]) => Promise<ReadonlySet<bigint>>,
): Promise<PlanActor> {
  const actor = env.HBECHO_AP_ACTOR?.trim();
  const caps = env.HBECHO_AP_CAPABILITIES?.trim();
  const brands = env.HBECHO_AP_BRAND_SCOPE?.trim();
  const branches = env.HBECHO_AP_BRANCH_SCOPE?.trim();
  if (!actor) throw new PlanError("configuration", "actor_missing", "缺少 HBECHO_AP_ACTOR");
  if (!caps) throw new PlanError("configuration", "capabilities_missing", "缺少 HBECHO_AP_CAPABILITIES（逗号分隔）");
  if (!brands) throw new PlanError("configuration", "brand_scope_missing", "缺少 HBECHO_AP_BRAND_SCOPE（all 或品牌编码逗号分隔）；不缺省为全部品牌");
  if (!branches) throw new PlanError("configuration", "branch_scope_missing", "缺少 HBECHO_AP_BRANCH_SCOPE（all 或分公司编码逗号分隔）；不缺省为全部分公司");
  const admin = env.HBECHO_AP_PLATFORM_ADMIN?.trim() ?? "false";
  if (admin !== "true" && admin !== "false") throw new PlanError("configuration", "platform_admin_invalid", "HBECHO_AP_PLATFORM_ADMIN 只能是 true 或 false");
  return {
    actor,
    capabilities: new Set(list(caps)),
    brandScope: brands === "all" ? "all" : new Set(list(brands)),
    branchScope: branches === "all" ? "all" : await resolveBranches(list(branches)),
    platformAdmin: admin === "true",
  };
}
