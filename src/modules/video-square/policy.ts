// 观看品牌范围策略（requirements R2、design §5.3）。可见品牌的**唯一来源**：列表、选项、详情、ScopeStrategy.contains 都从 visibleBrands 取。
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { brands, squareBrandPolicies, SQUARE_VIEW_MODES } from "../../db/schema";
import { constraintOf, isEmptyScope, type AuthContext, type DataScope, type ScopeStrategy } from "../access-control";
import { assertNonEmptyScope, authorizeOrThrow, CAP_POLICY, CAP_READ, RESOURCE, type SquareDeps } from "./deps";
import { SquareError } from "./errors";

export type ViewMode = (typeof SQUARE_VIEW_MODES)[number];
/** "all" = 不按品牌过滤；集合 = 只看这些品牌。空范围由调用方先拒绝，不会走到这里。 */
export type VisibleBrands = "all" | ReadonlySet<bigint>;

/**
 * - 范围是全部品牌 → 全部
 * - 空集合 → 空集合（调用方当作授权错误）
 * - 授权品牌里只要有**任一**品牌策略不是 own（含没有行）→ 全部（多品牌取并集，R2.3）
 * - 否则（全部授权品牌都是 own）→ 这些品牌自己
 */
export async function visibleBrands(db: Pick<Db, "select">, scope: DataScope): Promise<VisibleBrands> {
  if (scope.brands === "all") return "all";
  const mine = scope.brands;
  if (mine.size === 0) return mine;
  const rows = await db.select({ brandId: squareBrandPolicies.brandId, viewMode: squareBrandPolicies.viewMode }).from(squareBrandPolicies).where(inArray(squareBrandPolicies.brandId, [...mine]));
  const allOwn = rows.length === mine.size && rows.every((r) => r.viewMode === "own");
  return allOwn ? mine : "all";
}

/**
 * 注册为资源 `content_square` 的 ScopeStrategy（design §5.2、SQ-D08）。
 * constraint 如实反映 B 授予的范围；广场的可见范围可以**宽于**它（策略为 all 时），所以下游不要拿 scopeFor 当可见范围用，
 * 要判断某个品牌的作品能否被看到，调 contains。
 */
export function createSquareStrategy(db: Pick<Db, "select">): ScopeStrategy<{ brandId: bigint }> {
  return {
    async contains(scope, ref) {
      if (isEmptyScope(scope)) return false;
      const v = await visibleBrands(db, scope);
      return v === "all" || v.has(ref.brandId);
    },
    constraint: constraintOf,
  };
}

/** 页面与读口的入口：授权 + 非空范围 + 可见品牌，一次取齐。 */
export async function resolveVisible(deps: SquareDeps, ctx: AuthContext): Promise<VisibleBrands> {
  await authorizeOrThrow(deps, ctx, CAP_READ, { key: RESOURCE });
  assertNonEmptyScope(ctx);
  return visibleBrands(deps.db, ctx.scope);
}

export interface BrandPolicyRow {
  brandId: string;
  brandCode: string;
  brandName: string;
  viewMode: ViewMode;
  updatedByActor: string | null;
  updatedAt: string | null;
}

/** 全部品牌的当前策略；没有行的品牌显示为 all。 */
export async function listBrandPolicies(db: Pick<Db, "select">): Promise<BrandPolicyRow[]> {
  const rows = await db
    .select({ id: brands.brandId, code: brands.brandCode, name: brands.brandName, mode: squareBrandPolicies.viewMode, by: squareBrandPolicies.updatedByActor, at: squareBrandPolicies.updatedAt })
    .from(brands)
    .leftJoin(squareBrandPolicies, eq(squareBrandPolicies.brandId, brands.brandId))
    .orderBy(brands.brandId);
  return rows.map((r) => ({ brandId: r.id.toString(), brandCode: r.code, brandName: r.name, viewMode: (r.mode ?? "all") as ViewMode, updatedByActor: r.by, updatedAt: r.at?.toISOString() ?? null }));
}

/**
 * 设置品牌观看策略（R2.5）：只有持有 config.manage 的用户（超管）；同事务写策略与审计（高风险审计，失败整体回滚）；事务内不做网络 IO。
 * 值没变也记一条（幂等的 upsert，审计里 changed=false），便于核对「谁在什么时候确认过」。
 */
export async function setBrandPolicy(deps: SquareDeps, ctx: AuthContext, brandId: bigint, mode: string): Promise<{ brandId: string; before: ViewMode; after: ViewMode }> {
  await authorizeOrThrow(deps, ctx, CAP_POLICY);
  if (ctx.kind !== "user") throw new SquareError("auth", "service_principal_forbidden", "该操作只允许用户身份");
  if (!(SQUARE_VIEW_MODES as readonly string[]).includes(mode)) throw new SquareError("input", "invalid_mode", "view_mode 只能是 all 或 own");
  const after = mode as ViewMode;
  const now = deps.clock.now();
  const before = await deps.db.transaction(async (tx) => {
    const [b] = await tx.select({ id: brands.brandId }).from(brands).where(eq(brands.brandId, brandId));
    if (!b) throw new SquareError("not_found", "brand_not_found", "品牌不存在");
    const [cur] = await tx.select({ mode: squareBrandPolicies.viewMode }).from(squareBrandPolicies).where(eq(squareBrandPolicies.brandId, brandId)).for("update");
    const prev = (cur?.mode ?? "all") as ViewMode;
    await tx
      .insert(squareBrandPolicies)
      .values({ brandId, viewMode: after, updatedByActor: ctx.actor, createdAt: now, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { viewMode: after, updatedByActor: ctx.actor, updatedAt: now } });
    await deps.audit.write(
      {
        occurredAt: now,
        actor: ctx.actor,
        actorUserId: ctx.userId,
        eventType: "square_policy_changed",
        outcome: "succeeded",
        reasonCode: "policy_set",
        targetType: "square_brand_policy",
        targetId: brandId.toString(),
        detail: { before: prev, after, changed: prev !== after },
      },
      { tx, risk: "high" },
    );
    return prev;
  });
  return { brandId: brandId.toString(), before, after };
}
