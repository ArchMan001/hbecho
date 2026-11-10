// 授权入口（design §7.3、AX-6）：有且只有这一个。业务代码只检查 Capability，不写角色条件（P-R12）。
// 顺序：Capability 在注册表 → 主体持有（服务身份只认白名单）→ 资源 ScopeStrategy 已注册并解释 → 资源谓词。
// 超管没有旁路：同样先查注册表与矩阵，同样要有已注册的策略；未注册时超管也被拒。
import { defaultRegistry, ScopeUnresolvable, type AccessRegistry, type DataScope, type PredicateContext } from "./scope";
import { isCapability, type RoleCode } from "./roles";
import { isServicePrincipal, SERVICE_PRINCIPALS } from "./service-principals";

/** 一次请求里已认证主体的最小上下文。每个请求现建，不跨请求缓存（B-D33）。 */
export interface AuthContext {
  readonly kind: "user" | "service";
  /** 规范主体字符串：`user:<id>` / `service:<name>`。 */
  readonly actor: string;
  readonly userId: bigint | null;
  /** 服务身份没有角色。 */
  readonly role: RoleCode | null;
  readonly capabilities: ReadonlySet<string>;
  readonly scope: DataScope;
  readonly sessionId: string | null;
}

export type DenyReason =
  | "user_not_active"
  | "capability_unknown"
  | "capability_not_granted"
  | "scope_unregistered"
  | "scope_not_resolvable"
  | "predicate_failed"
  | "out_of_scope"
  | "service_principal_forbidden";

export type Decision =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "unauthenticated" | "forbidden" | "not_found" | "unavailable"; readonly reason: DenyReason };

export interface AuthorizeRequest {
  capability: string;
  resource?: {
    /** PRD §8.2 的资源键。 */
    key: string;
    ref?: unknown;
    /** 要求成立的资源谓词名（B 登记的四个之一）；未注册的谓词一律不成立。 */
    predicates?: readonly string[];
  };
}

export const deny = (kind: Exclude<Decision, { ok: true }>["kind"], reason: DenyReason): Decision => ({ ok: false, kind, reason });

/** HTTP 状态映射：未认证 401、缺 Capability 403、对象越权对外「未找到」404、认证库不可用 503。 */
export const httpStatusOf = (d: Exclude<Decision, { ok: true }>): 401 | 403 | 404 | 503 =>
  d.kind === "unauthenticated" ? 401 : d.kind === "forbidden" ? 403 : d.kind === "not_found" ? 404 : 503;

export interface AuthorizerDeps {
  registry?: AccessRegistry;
  /** 范围无法解释时调用（写质量问题）；失败不影响拒绝结果。 */
  onUnresolvable?(info: { ctx: AuthContext; resourceKey: string; reason: string }): Promise<void> | void;
  /** 每次拒绝调用（审计 denied，低风险尽力写入）；失败不影响拒绝结果。 */
  onDenied?(info: { ctx: AuthContext; request: AuthorizeRequest; decision: Exclude<Decision, { ok: true }> }): Promise<void> | void;
}

export function createAuthorizer(deps: AuthorizerDeps = {}) {
  // 缺省用进程级 defaultRegistry：资源域注册到它之后，没显式传参的调用也看得见（测试自己传独立注册表）
  const registry = deps.registry ?? defaultRegistry;

  const finish = async (ctx: AuthContext, request: AuthorizeRequest, d: Decision): Promise<Decision> => {
    if (!d.ok) {
      try {
        await deps.onDenied?.({ ctx, request, decision: d });
      } catch {
        // 审计失败不改变拒绝
      }
    }
    return d;
  };

  async function authorize(ctx: AuthContext, request: AuthorizeRequest): Promise<Decision> {
    if (!isCapability(request.capability)) return finish(ctx, request, deny("forbidden", "capability_unknown"));
    if (ctx.kind === "service") {
      const allowed = isServicePrincipal(ctx.actor) ? (SERVICE_PRINCIPALS[ctx.actor] as readonly string[]) : [];
      if (!allowed.includes(request.capability) || !ctx.capabilities.has(request.capability)) {
        return finish(ctx, request, deny("forbidden", "service_principal_forbidden"));
      }
    } else if (!ctx.capabilities.has(request.capability)) {
      return finish(ctx, request, deny("forbidden", "capability_not_granted"));
    }
    const res = request.resource;
    if (!res) return { ok: true };

    const strategy = registry.scopeStrategy(res.key);
    if (!strategy) return finish(ctx, request, deny("forbidden", "scope_unregistered"));
    try {
      if (res.ref !== undefined && !(await strategy.contains(ctx.scope, res.ref as never))) {
        return finish(ctx, request, deny("not_found", "out_of_scope"));
      }
      // 没有 ref 时只确认「该主体对这类资源有可解释的范围」：空范围是合法的，由调用方得到空结果
    } catch (e) {
      if (!(e instanceof ScopeUnresolvable)) throw e; // 非范围解释失败的异常不吞，向上抛（不当作放行或拒绝）
      try {
        await deps.onUnresolvable?.({ ctx, resourceKey: res.key, reason: e.reason });
      } catch {
        // 质量问题写入失败不改变拒绝
      }
      return finish(ctx, request, deny("forbidden", "scope_not_resolvable"));
    }

    if (res.predicates?.length) {
      const pctx: PredicateContext = { actor: ctx.actor, userId: ctx.userId, scope: ctx.scope, platformAdmin: ctx.role === "platform_admin" };
      for (const name of res.predicates) {
        const fn = registry.predicate(name);
        if (!fn || !(await fn(pctx, res.ref))) return finish(ctx, request, deny("forbidden", "predicate_failed"));
      }
    }
    return { ok: true };
  }

  return { authorize, registry };
}

export type Authorizer = ReturnType<typeof createAuthorizer>;
