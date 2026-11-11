// 表单可选项：只列出操作者自己范围内的（范围外的不显示）。最终以 Module 的授权边界校验为准。
import { ROLE_CODES, ROLE_RANK, type RoleCode } from "../../../modules/access-control/roles";
import type { OrgRef } from "../../../modules/access-control/web";

/** 超管可授予任意角色；其余只能授予严格低于自己的。 */
export function allowedRoles(role: RoleCode | null): readonly RoleCode[] {
  if (role === null) return [];
  return role === "platform_admin" ? ROLE_CODES : ROLE_CODES.filter((r) => ROLE_RANK[r] < ROLE_RANK[role]);
}

export function optionsWithin(all: OrgRef[], scope: ReadonlySet<bigint> | "all"): Array<{ id: string; name: string }> {
  return all.filter((o) => o.active && (scope === "all" || scope.has(BigInt(o.id)))).map((o) => ({ id: o.id, name: o.name }));
}
