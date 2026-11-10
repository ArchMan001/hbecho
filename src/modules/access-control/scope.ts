// DataScope 与 ScopeStrategy 注册表（design §7.4–§7.5、AX-7）。
//   - DataScope 是「组织 ∩ 显式品牌集合」的语义对象，**不是 SQL**；由资源所属域的策略翻译成自己的过滤条件。
//   - 每次请求由数据库当前状态构建，不跨请求缓存（B-D33）：角色或范围变更下一次请求即生效。
//   - 未注册策略的资源一律拒绝（P-R14），含超管；无法解释 / 无法映射一律拒绝，不回退空列表、不回退全量。
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { branches, brands, mediaStaff, sectors, stores } from "../../db/schema";
import { ROLE_LEVEL, type RoleCode } from "./roles";

// ---- DataScope ----------------------------------------------------------------------------------------

export type UnresolvedSelfReason = "no_binding" | "staff_inactive" | "ambiguous";

export type SelfScope =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly mediaStaffId: bigint; readonly storeId: bigint }
  /** store_staff 的本人绑定失败：拒绝本人范围，不回退成「本门店」「本品牌」（B-D08）。 */
  | { readonly kind: "unresolved"; readonly reason: UnresolvedSelfReason };

export interface DataScope {
  /** 品牌 ID 集合；'all' 只有平台级。空集合是合法的空范围（不是全量）。 */
  readonly brands: ReadonlySet<bigint> | "all";
  /** 分公司 ID 集合；'all' = 全部组织。 */
  readonly branches: ReadonlySet<bigint> | "all";
  readonly self: SelfScope;
  /** 人员级别（B-D23）：1 门店专员 / 2 分公司 / 3 总部及以上。 */
  readonly level: 1 | 2 | 3;
}

export const EMPTY_SCOPE: DataScope = { brands: new Set(), branches: new Set(), self: { kind: "none" }, level: 1 };

/** 平台级 = 全部品牌 × 全部组织。 */
export const isPlatformScope = (s: DataScope): boolean => s.brands === "all" && s.branches === "all" && s.self.kind === "none";

export const isEmptyScope = (s: DataScope): boolean =>
  s.self.kind === "unresolved" || (s.brands !== "all" && s.brands.size === 0) || (s.branches !== "all" && s.branches.size === 0);

/** 无法映射 / 无法解释：调用方得到 403 + 一条质量问题，不得回退（B-D26）。 */
export class ScopeUnresolvable extends Error {
  constructor(
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? `范围无法解释：${reason}`);
    this.name = "ScopeUnresolvable";
  }
}

export class ScopeUnregistered extends Error {
  constructor(readonly key: string) {
    super(`资源 ${key} 没有注册 ScopeStrategy（未注册即拒绝）`);
    this.name = "ScopeUnregistered";
  }
}

const meet = <T>(a: ReadonlySet<T> | "all", b: ReadonlySet<T> | "all"): ReadonlySet<T> | "all" => {
  if (a === "all") return b;
  if (b === "all") return a;
  return new Set([...a].filter((x) => b.has(x)));
};

/** 集合取交，'all' 吸收；self 相同保留，一方 none 取另一方，两个不同的本人 → 空。 */
export function intersect(a: DataScope, b: DataScope): DataScope {
  let self: SelfScope;
  let emptied = false;
  if (a.self.kind === "unresolved") self = a.self;
  else if (b.self.kind === "unresolved") self = b.self;
  else if (a.self.kind === "none") self = b.self;
  else if (b.self.kind === "none") self = a.self;
  else if (a.self.mediaStaffId === b.self.mediaStaffId) self = a.self;
  else {
    self = { kind: "none" };
    emptied = true;
  }
  return {
    brands: emptied ? new Set() : meet(a.brands, b.brands),
    branches: emptied ? new Set() : meet(a.branches, b.branches),
    self,
    level: (Math.min(a.level, b.level) as 1 | 2 | 3),
  };
}

/** a ⊆ b（用于交付前复查：产物范围是否仍被当前范围覆盖）。 */
export function isSubset(a: DataScope, b: DataScope): boolean {
  const sub = (x: ReadonlySet<bigint> | "all", y: ReadonlySet<bigint> | "all"): boolean => (y === "all" ? true : x === "all" ? false : [...x].every((v) => y.has(v)));
  if (isEmptyScope(a)) return true;
  if (b.self.kind === "unresolved") return false;
  if (b.self.kind === "resolved" && !(a.self.kind === "resolved" && a.self.mediaStaffId === b.self.mediaStaffId)) return false;
  return sub(a.brands, b.brands) && sub(a.branches, b.branches);
}

const ids = (s: ReadonlySet<bigint> | "all"): string[] | "all" => (s === "all" ? "all" : [...s].map((x) => x.toString()).sort());

/** 规范化 JSON 的 sha256，用于任务快照与交付复查的比较。 */
export function fingerprint(s: DataScope): string {
  const self = s.self.kind === "resolved" ? { kind: "resolved", staff: s.self.mediaStaffId.toString(), store: s.self.storeId.toString() } : s.self.kind === "unresolved" ? { kind: "unresolved", reason: s.self.reason } : { kind: "none" };
  return createHash("sha256").update(JSON.stringify({ brands: ids(s.brands), branches: ids(s.branches), self, level: s.level })).digest("hex");
}

// ---- 组织目录端口 --------------------------------------------------------------------------------------

export interface StaffBinding {
  staffId: bigint;
  status: string;
  storeId: bigint;
  brandId: bigint;
  /** 门店所属分公司（经板块）。 */
  branchId: bigint;
}

export interface StoreRef {
  storeId: bigint;
  status: string;
  brandId: bigint;
  branchId: bigint;
}

/**
 * 范围构建读取组织主档的端口（旧设计 MasterDataDirectory seam 的缩小版）。外键 RESTRICT 保证引用在数据层不会消失，
 * 所以「无法映射」在运行时表现为端口报告不可解析（主数据不可用等）——测试用端口的故障注入构造，不靠关外键（AX-D25）。
 * 返回 null = 找不到；抛错 = 不可用。
 */
export interface OrgDirectory {
  staffBinding(staffId: bigint): Promise<StaffBinding | null>;
  store(storeId: bigint): Promise<StoreRef | null>;
  /** 恢复用户时重新检查授权引用（design §AX-5）：null = 无法映射，直接去掉；停用（status≠active）不算失效（B-D25）。 */
  brand(brandId: bigint): Promise<{ brandId: bigint; status: string } | null>;
  branch(branchId: bigint): Promise<{ branchId: bigint; status: string } | null>;
}

export function createOrgDirectory(db: Db): OrgDirectory {
  return {
    async staffBinding(staffId) {
      const [r] = await db
        .select({ staffId: mediaStaff.staffId, status: mediaStaff.status, storeId: stores.storeId, brandId: stores.brandId, branchId: branches.branchId })
        .from(mediaStaff)
        .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
        .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
        .innerJoin(branches, eq(branches.branchId, sectors.branchId))
        .where(eq(mediaStaff.staffId, staffId))
        .limit(1);
      return r ?? null;
    },
    async store(storeId) {
      const [r] = await db
        .select({ storeId: stores.storeId, status: stores.status, brandId: stores.brandId, branchId: branches.branchId })
        .from(stores)
        .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
        .innerJoin(branches, eq(branches.branchId, sectors.branchId))
        .where(eq(stores.storeId, storeId))
        .limit(1);
      return r ?? null;
    },
    async brand(brandId) {
      const [r] = await db.select({ brandId: brands.brandId, status: brands.status }).from(brands).where(eq(brands.brandId, brandId)).limit(1);
      return r ?? null;
    },
    async branch(branchId) {
      const [r] = await db.select({ branchId: branches.branchId, status: branches.status }).from(branches).where(eq(branches.branchId, branchId)).limit(1);
      return r ?? null;
    },
  };
}

// ---- 构建 -------------------------------------------------------------------------------------------------

export interface ScopeFacts {
  role: RoleCode;
  mediaStaffId: bigint | null;
  brandIds: ReadonlySet<bigint>;
  branchIds: ReadonlySet<bigint>;
}

/** 按 design §7.4 的表构建。目录不可用时抛 ScopeUnresolvable('directory_unavailable')。 */
export async function buildDataScope(f: ScopeFacts, dir: OrgDirectory): Promise<DataScope> {
  const level = ROLE_LEVEL[f.role];
  switch (f.role) {
    case "platform_admin":
      return { brands: "all", branches: "all", self: { kind: "none" }, level };
    case "hq_manager":
      return { brands: new Set(f.brandIds), branches: "all", self: { kind: "none" }, level };
    case "branch_manager":
      return { brands: new Set(f.brandIds), branches: new Set(f.branchIds), self: { kind: "none" }, level };
    case "store_staff": {
      const unresolved = (reason: UnresolvedSelfReason): DataScope => ({ brands: new Set(), branches: new Set(), self: { kind: "unresolved", reason }, level });
      if (f.mediaStaffId === null) return unresolved("no_binding");
      let b: StaffBinding | null;
      try {
        b = await dir.staffBinding(f.mediaStaffId);
      } catch (e) {
        throw new ScopeUnresolvable("directory_unavailable", e instanceof Error ? e.message : String(e));
      }
      if (b === null) return unresolved("no_binding");
      if (b.status !== "active") return unresolved("staff_inactive");
      return { brands: new Set([b.brandId]), branches: new Set([b.branchId]), self: { kind: "resolved", mediaStaffId: b.staffId, storeId: b.storeId }, level };
    }
  }
}

// ---- ScopeStrategy 注册表 ------------------------------------------------------------------------------

/** PRD §8.2 的资源清单；注册表只接受这些键，避免拼写漂移。 */
export const RESOURCE_KEYS = [
  "account",
  "content",
  "media",
  "external_account",
  "report",
  "rule_config",
  "metric_config",
  "user",
  "raw_payload",
  "learning_course",
  "activity_plan",
  "judgement_plan",
  "audit_log",
  "notification",
] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** B 不拼 SQL：返回资源域自己能翻译成过滤条件的语义约束。 */
export interface ResourceConstraint {
  /** true = 什么都不可见（合法空范围，或平台级资源对非平台级主体）。 */
  readonly empty: boolean;
  readonly brands: readonly bigint[] | "all";
  readonly branches: readonly bigint[] | "all";
  readonly self: { readonly mediaStaffId: bigint; readonly storeId: bigint } | null;
}

export interface ScopeStrategy<Ref = unknown> {
  /** 该范围是否覆盖这个对象；解释失败抛 ScopeUnresolvable。 */
  contains(scope: DataScope, ref: Ref): Promise<boolean>;
  constraint(scope: DataScope): ResourceConstraint;
}

/** 默认的语义约束：scope 本身翻译成约束。 */
export function constraintOf(scope: DataScope): ResourceConstraint {
  return {
    empty: isEmptyScope(scope),
    brands: scope.brands === "all" ? "all" : [...scope.brands],
    branches: scope.branches === "all" ? "all" : [...scope.branches],
    self: scope.self.kind === "resolved" ? { mediaStaffId: scope.self.mediaStaffId, storeId: scope.self.storeId } : null,
  };
}

/** 仅平台级可见的资源（audit_log、external_account、raw_payload）。 */
export const platformOnlyStrategy: ScopeStrategy<unknown> = {
  contains: async (scope) => isPlatformScope(scope),
  constraint: (scope) => (isPlatformScope(scope) ? { empty: false, brands: "all", branches: "all", self: null } : { empty: true, brands: [], branches: [], self: null }),
};

export interface UserScopeRef {
  brandIds: ReadonlySet<bigint>;
  /** 目标用户的分公司集合；'all' 只有总部 / 超管。 */
  branchIds: ReadonlySet<bigint> | "all";
}

/**
 * `user` 资源：目标用户的品牌 / 分公司集合是否落在范围内。严格下级与「不能管理自己」属于 `manages`（grants.ts），
 * 读写同源的入口是 manages，这里只回答组织包含关系，供别的域通过 scopeFor 引用。
 */
export const userStrategy: ScopeStrategy<UserScopeRef> = {
  contains: async (scope, ref) => {
    if (isEmptyScope(scope)) return false;
    const brandsOk = scope.brands === "all" || [...ref.brandIds].every((b) => scope.brands !== "all" && scope.brands.has(b));
    const branchesOk = scope.branches === "all" ? true : ref.branchIds === "all" ? false : [...ref.branchIds].every((b) => scope.branches !== "all" && scope.branches.has(b));
    return brandsOk && branchesOk;
  },
  constraint: constraintOf,
};

/**
 * 门店级对象（账号、内容、媒资……凡是带门店的资源）的通用判断：品牌 ∈ brands 且 分公司 ∈ branches，
 * 本人范围还要求对象属于该门店。资源所属域用它组装自己的 ScopeStrategy（B 不替它们注册）。
 * 门店不存在 / 目录不可用 → ScopeUnresolvable（403 + 质量问题），不回退。品牌或门店**停用**不影响读范围（B-D25）。
 */
export function createStoreStrategy(dir: OrgDirectory): ScopeStrategy<{ storeId: bigint }> {
  return {
    async contains(scope, ref) {
      if (isEmptyScope(scope)) return false;
      let s: StoreRef | null;
      try {
        s = await dir.store(ref.storeId);
      } catch (e) {
        throw new ScopeUnresolvable("directory_unavailable", e instanceof Error ? e.message : String(e));
      }
      if (s === null) throw new ScopeUnresolvable("store_not_found", `门店 ${ref.storeId} 无法映射`);
      if (scope.self.kind === "resolved" && scope.self.storeId !== s.storeId) return false;
      const brandOk = scope.brands === "all" || scope.brands.has(s.brandId);
      const branchOk = scope.branches === "all" || scope.branches.has(s.branchId);
      return brandOk && branchOk;
    },
    constraint: constraintOf,
  };
}

export const BUILTIN_STRATEGIES: ReadonlyArray<readonly [ResourceKey, ScopeStrategy<never>]> = [
  ["user", userStrategy as ScopeStrategy<never>],
  ["audit_log", platformOnlyStrategy as ScopeStrategy<never>],
  ["external_account", platformOnlyStrategy as ScopeStrategy<never>],
  ["raw_payload", platformOnlyStrategy as ScopeStrategy<never>],
];

/** B 登记的资源谓词名字（design §7.3）；谓词体由资源所属域提供。 */
export const PREDICATE_NAMES = ["plan_creator", "plan_branch", "object_status", "monitoring_level"] as const;
export type PredicateName = (typeof PREDICATE_NAMES)[number];

export type ResourcePredicate = (ctx: PredicateContext, ref: unknown) => boolean | Promise<boolean>;

/** 谓词看到的最小主体信息（不含授权内部结构）。 */
export interface PredicateContext {
  readonly actor: string;
  readonly userId: bigint | null;
  readonly scope: DataScope;
  readonly platformAdmin: boolean;
}

export class AccessRegistry {
  private readonly strategies = new Map<ResourceKey, ScopeStrategy<never>>();
  private readonly predicates = new Map<PredicateName, ResourcePredicate>();

  registerScopeStrategy(key: ResourceKey, s: ScopeStrategy<never>): void {
    if (!(RESOURCE_KEYS as readonly string[]).includes(key)) throw new Error(`未知资源键：${key}`);
    if (this.strategies.has(key)) throw new Error(`资源 ${key} 的 ScopeStrategy 已注册，不允许重复注册`);
    this.strategies.set(key, s);
  }

  /** 仅用于测试与启动期装配：删除后同一请求必须失败。 */
  unregisterScopeStrategy(key: ResourceKey): void {
    this.strategies.delete(key);
  }

  scopeStrategy(key: string): ScopeStrategy<never> | undefined {
    return this.strategies.get(key as ResourceKey);
  }

  registeredKeys(): ResourceKey[] {
    return [...this.strategies.keys()].sort();
  }

  registerPredicate(name: PredicateName, fn: ResourcePredicate): void {
    if (!(PREDICATE_NAMES as readonly string[]).includes(name)) throw new Error(`未知谓词名：${name}`);
    if (this.predicates.has(name)) throw new Error(`谓词 ${name} 已注册，不允许重复注册`);
    this.predicates.set(name, fn);
  }

  predicate(name: string): ResourcePredicate | undefined {
    return this.predicates.get(name as PredicateName);
  }

  /** 资源域用：拿到该资源的语义约束；未注册抛 ScopeUnregistered。 */
  scopeFor(scope: DataScope, key: ResourceKey): ResourceConstraint {
    const s = this.strategies.get(key);
    if (!s) throw new ScopeUnregistered(key);
    return s.constraint(scope);
  }
}

/** 带 B 自带四个策略的新注册表（测试每个用例各建一个，互不污染）。 */
export function createRegistry(): AccessRegistry {
  const r = new AccessRegistry();
  for (const [k, s] of BUILTIN_STRATEGIES) r.registerScopeStrategy(k, s);
  return r;
}

/** 进程级默认注册表：各域在自己的装配里向它注册策略。 */
export const defaultRegistry: AccessRegistry = createRegistry();
