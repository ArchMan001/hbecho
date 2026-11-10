// 管理范围与授权边界（design §7.6、AX-8）：纯函数，真值表可测。
//   manages  —— 读写同源：列表、详情、修改、停用、恢复、强制下线、批量操作**都只用它**，杜绝「看不到但能改」
//   canGrant —— GrantBoundary 的 proposed 校验：修改后的角色 / 品牌 / 分公司是否完全位于操作者边界内
// 变更流程：current 校验用 manages，proposed 校验用 canGrant，两个都过才在一个事务里写；任一不过整体拒绝、零写入。
import { ROLE_RANK, type RoleCode } from "./roles";

export interface Principal {
  userId: bigint;
  role: RoleCode;
  /** 超管为 'all'。 */
  brands: ReadonlySet<bigint> | "all";
  /** 总部及超管为 'all'。 */
  branches: ReadonlySet<bigint> | "all";
}

export interface TargetUser {
  userId: bigint;
  role: RoleCode;
  /** store_staff 由其门店推出（门店的品牌）。 */
  brands: ReadonlySet<bigint>;
  /** store_staff 由其门店推出（门店所属分公司）；hq / admin 为 'all'。 */
  branches: ReadonlySet<bigint> | "all";
}

const subset = (a: ReadonlySet<bigint>, b: ReadonlySet<bigint> | "all"): boolean => b === "all" || [...a].every((x) => b.has(x));

export function manages(actor: Principal, target: TargetUser): boolean {
  if (target.userId === actor.userId) return false; // 自己可见（只读），不可管理（B-D02）
  if (actor.role === "platform_admin") return true; // 含其他超管
  if (ROLE_RANK[target.role] >= ROLE_RANK[actor.role]) return false; // 严格下级
  if (!subset(target.brands, actor.brands)) return false;
  if (actor.role === "branch_manager") {
    if (target.branches === "all") return false;
    if (!subset(target.branches, actor.branches)) return false;
  }
  return true;
}

export interface ProposedGrant {
  role: RoleCode;
  brandIds: ReadonlySet<bigint>;
  branchIds: ReadonlySet<bigint>;
  /** store_staff：所绑定专员所在门店的品牌与分公司（由专员定位得到，不由调用方自填）。 */
  store?: { brandId: bigint; branchId: bigint };
}

export type GrantVerdict =
  | { ok: true }
  | { ok: false; reason: "role_not_grantable" | "scope_exceeds_boundary" | "shape_invalid" };

const no = (reason: Extract<GrantVerdict, { ok: false }>["reason"]): GrantVerdict => ({ ok: false, reason });

export function canGrant(actor: Principal, p: ProposedGrant): GrantVerdict {
  // 角色：超管可授任意角色；其余只能授予严格低于自己的
  if (actor.role !== "platform_admin" && ROLE_RANK[p.role] >= ROLE_RANK[actor.role]) return no("role_not_grantable");

  // 角色与集合形状（B-D01 单角色；hq 无分公司集合；admin / staff 两者皆空——staff 的范围由门店推出）
  switch (p.role) {
    case "platform_admin":
      if (p.brandIds.size > 0 || p.branchIds.size > 0) return no("shape_invalid");
      return { ok: true };
    case "hq_manager":
      if (p.brandIds.size === 0 || p.branchIds.size > 0) return no("shape_invalid");
      break;
    case "branch_manager":
      if (p.brandIds.size === 0 || p.branchIds.size === 0) return no("shape_invalid");
      break;
    case "store_staff":
      if (p.brandIds.size > 0 || p.branchIds.size > 0 || !p.store) return no("shape_invalid");
      break;
  }

  if (p.role === "store_staff") {
    const s = p.store!;
    if (actor.brands !== "all" && !actor.brands.has(s.brandId)) return no("scope_exceeds_boundary");
    if (actor.branches !== "all" && !actor.branches.has(s.branchId)) return no("scope_exceeds_boundary");
    return { ok: true };
  }
  if (!subset(p.brandIds, actor.brands)) return no("scope_exceeds_boundary");
  if (p.role === "branch_manager" && !subset(p.branchIds, actor.branches)) return no("scope_exceeds_boundary");
  return { ok: true };
}
