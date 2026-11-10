// 到现有模块的身份适配（design §9.1、§9.2；AX-11）：把 `AuthContext` 翻译成各模块自己的 Actor 形状。
//   - 目标形状用结构类型声明，**不 import** 各模块（依赖方向：业务模块 → 访问控制）；
//   - 适配是**只收窄不放宽**：翻译不了就返回 Unadaptable，绝不降级成「差不多的」身份（例如 tracer 只认全范围）；
//   - `userIdOf` 是 `*_by_user_id` 回填入口：`user:<id>` → ID，`service:*` → null，从不对历史行或服务身份造假用户。
import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { brands } from "../../db/schema";
import type { AuthContext } from "./authorize";

export type Adapted<T> = { ok: true; actor: T } | { ok: false; reason: "partial_scope_not_supported" | "brand_unmappable" | "no_import_capability" };

// ---- a-activity-plan（A design §9 的 PlanActor）------------------------------------------------------------
export interface PlanActorShape {
  actor: string;
  capabilities: ReadonlySet<string>;
  /** 品牌编码集合或 "all"。 */
  brandScope: ReadonlySet<string> | "all";
  /** 分公司 ID 集合或 "all"；总部及超管为 "all"。 */
  branchScope: ReadonlySet<bigint> | "all";
  platformAdmin: boolean;
}
// ---- a-master-data-import（ActorContext）----------------------------------------------------------------
export interface MdActorShape {
  actor: string;
  capabilities: ReadonlySet<string>;
  brandScope: ReadonlySet<string> | "all";
}
// ---- tracer / sync（tracer-command 的 ActorContext）-----------------------------------------------------
export interface TracerActorShape {
  actorId: string;
  capabilities: ReadonlySet<string>;
  platformAdmin: boolean;
  scope: { platformCodes: "all"; mediaStaffIds: "all" };
}

export interface AdapterDeps {
  db: Db;
}

/** 品牌 ID → 品牌编码。任何一个 ID 找不到编码就整体报告无法映射，不静默丢掉。 */
async function brandCodes(db: Db, ids: ReadonlySet<bigint>): Promise<ReadonlySet<string> | null> {
  if (ids.size === 0) return new Set();
  const rows = await db.select({ code: brands.brandCode }).from(brands).where(inArray(brands.brandId, [...ids]));
  return rows.length === ids.size ? new Set(rows.map((r) => r.code)) : null;
}

async function brandScopeOf(deps: AdapterDeps, ctx: AuthContext): Promise<ReadonlySet<string> | "all" | null> {
  return ctx.scope.brands === "all" ? "all" : brandCodes(deps.db, ctx.scope.brands);
}

export async function toPlanActor(ctx: AuthContext, deps: AdapterDeps): Promise<Adapted<PlanActorShape>> {
  const brandScope = await brandScopeOf(deps, ctx);
  if (brandScope === null) return { ok: false, reason: "brand_unmappable" };
  return { ok: true, actor: { actor: ctx.actor, capabilities: ctx.capabilities, brandScope, branchScope: ctx.scope.branches, platformAdmin: ctx.role === "platform_admin" } };
}

/** 主数据导入只有持有 `data.master_data.import`（或 `structure`）的主体才有意义；其余角色（分公司、门店专员）不适配，不给一个注定被拒的 Actor。 */
export async function toMasterDataActor(ctx: AuthContext, deps: AdapterDeps): Promise<Adapted<MdActorShape>> {
  if (!ctx.capabilities.has("data.master_data.import") && !ctx.capabilities.has("data.master_data.structure")) return { ok: false, reason: "no_import_capability" };
  const brandScope = await brandScopeOf(deps, ctx);
  if (brandScope === null) return { ok: false, reason: "brand_unmappable" };
  return { ok: true, actor: { actor: ctx.actor, capabilities: ctx.capabilities, brandScope } };
}

/** tracer / sync 的范围只有「全部」一种：全品牌、全分公司、非本人范围才适配；其余一律不适配，不降级。 */
export function toTracerActor(ctx: AuthContext): Adapted<TracerActorShape> {
  if (ctx.scope.brands !== "all" || ctx.scope.branches !== "all" || ctx.scope.self.kind !== "none") return { ok: false, reason: "partial_scope_not_supported" };
  return { ok: true, actor: { actorId: ctx.actor, capabilities: ctx.capabilities, platformAdmin: ctx.role === "platform_admin", scope: { platformCodes: "all", mediaStaffIds: "all" } } };
}

/** `user:<id>` → ID；`service:*` 与其它一律 null（不造假）。 */
export function userIdOf(actor: string): bigint | null {
  const m = /^user:(\d{1,19})$/.exec(actor);
  return m ? BigInt(m[1]!) : null;
}
