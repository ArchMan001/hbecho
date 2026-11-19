// 授权（requirements EL-9）：复用 B 的 `report.read` / `report.export`，不新增 Capability；本模块只注册 `report` 的范围策略。
// 先查再注册：e-metrics 开工时直接复用，不重复注册（与 registerJudgementAuthz 同一写法）。
import { constraintOf, isEmptyScope, type AccessRegistry, type AuthContext, type Authorizer, type DataScope, type ResourceConstraint, type ScopeStrategy } from "../access-control";
import { ReportError } from "./types";

/** `report` 资源的引用：品牌、活动计划已加入的分公司。JudgementPlanRef 结构上满足它。 */
export interface ReportRef {
  brandId: bigint;
  branchIds: readonly bigint[];
  activityPlanId?: bigint;
}
/** 品牌 ∈ 范围品牌，且（范围分公司为 all，或已加入的某个分公司 ∈ 范围分公司）；空范围一律不含。 */
export const reportStrategy: ScopeStrategy<ReportRef> = {
  contains: async (scope: DataScope, ref) => {
    if (isEmptyScope(scope)) return false;
    const brandOk = scope.brands === "all" || scope.brands.has(ref.brandId);
    const branchOk = scope.branches === "all" || ref.branchIds.some((b) => (scope.branches as ReadonlySet<bigint>).has(b));
    return brandOk && branchOk;
  },
  constraint: constraintOf,
};
export function registerReportAuthz(registry: AccessRegistry): void {
  if (!registry.scopeStrategy("report")) registry.registerScopeStrategy("report", reportStrategy as ScopeStrategy<never>);
}
export const CAP_READ = "report.read";
export const CAP_EXPORT = "report.export";
/** 空范围 → auth（不回退为全部）；无 Capability / 对象越权 → 无权限；越范围表现为 not_found，不泄露存在性。 */
export async function authorizeReport(authorizer: Pick<Authorizer, "authorize">, ctx: AuthContext, capability: string, ref: ReportRef): Promise<ResourceConstraint> {
  if (isEmptyScope(ctx.scope)) throw new ReportError("auth", "scope_empty", "当前账号没有可见的数据范围");
  const d = await authorizer.authorize(ctx, { capability, resource: { key: "report", ref } });
  if (!d.ok) {
    if (d.kind === "not_found") throw new ReportError("not_found", "plan_not_found", "找不到这个判定计划");
    throw new ReportError("auth", d.reason, "没有权限执行这个操作");
  }
  return constraintOf(ctx.scope);
}
