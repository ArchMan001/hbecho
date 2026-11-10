// authenticate（design §7.2、AX-1）：Route Handler 与将来的页面共用的唯一认证入口。
//   - 每个请求现建 AuthContext，**不跨请求缓存**（B-D33）：角色或范围变更不撤销现有会话，下一次请求即按新权限判断
//   - 认证库异常 → unavailable（503 样式，业务拒绝），**不当作「未登录」静默放行**
//   - 用户非 active（待激活 / 停用）→ unauthenticated；停用用户无法续期（会话在停用事务里已撤销，这里是第二道）
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accessUserBranches, accessUserBrands, accessUsers } from "../../db/schema";
import type { AccessAuth } from "./auth-instance";
import type { AuthContext, DenyReason } from "./authorize";
import type { StaffLinkage } from "./linkage";
import { isRoleCode, ROLE_CAPABILITIES } from "./roles";
import { buildDataScope, ScopeUnresolvable, type OrgDirectory } from "./scope";

export type AuthenticateResult =
  | { ok: true; ctx: AuthContext }
  | { ok: false; kind: "unauthenticated" | "forbidden" | "unavailable"; reason: DenyReason | "no_session" | "media_staff_disabled" };

export interface ContextResolverDeps {
  db: Db;
  dir: OrgDirectory;
  /** 专员停用的懒执行（design §7.10）。必填：漏接线会让专员停用后的用户继续有效，不能是可选。 */
  linkage: Pick<StaffLinkage, "disableIfStaffInactive">;
  /** 范围无法解释时调用（写质量问题）；失败不影响拒绝。 */
  onUnresolvable?(info: { userId: bigint; reason: string }): Promise<void> | void;
}
export interface AuthenticatorDeps extends ContextResolverDeps {
  auth: AccessAuth;
}

export interface UserFacts {
  userId: bigint;
  role: string;
  status: string;
  mediaStaffId: bigint | null;
  /** 管理员人工恢复时已知情的失效绑定（AX-D30）。 */
  bindingAckStaffId: bigint | null;
  brandIds: ReadonlySet<bigint>;
  branchIds: ReadonlySet<bigint>;
}

export async function loadUserFacts(db: Db, userId: bigint): Promise<UserFacts | null> {
  const [u] = await db
    .select({ userId: accessUsers.userId, role: accessUsers.roleCode, status: accessUsers.status, mediaStaffId: accessUsers.mediaStaffId, bindingAckStaffId: accessUsers.bindingAckStaffId })
    .from(accessUsers)
    .where(eq(accessUsers.userId, userId))
    .limit(1);
  if (!u) return null;
  const [brandRows, branchRows] = await Promise.all([
    db.select({ id: accessUserBrands.brandId }).from(accessUserBrands).where(eq(accessUserBrands.userId, userId)),
    db.select({ id: accessUserBranches.branchId }).from(accessUserBranches).where(eq(accessUserBranches.userId, userId)),
  ]);
  return { ...u, brandIds: new Set(brandRows.map((r) => r.id)), branchIds: new Set(branchRows.map((r) => r.id)) };
}

/**
 * 按用户现建 AuthContext，不依赖认证库（请求路径、后台任务、CLI 共用）。
 */
export function createContextResolver(deps: ContextResolverDeps) {
  /**
   * 按用户现建 AuthContext（请求路径与后台任务共用）。
   * 后台任务（用户触发的导出等）在**执行时、交付前**用它重新取提交者的当前身份与范围：已停用 / 专员失效 / 范围变化都立即反映。
   * 此时没有会话，sessionId 为 null。
   */
  async function contextForUser(userId: bigint, sessionId: string | null): Promise<AuthenticateResult> {
    let facts: UserFacts | null;
    try {
      facts = await loadUserFacts(deps.db, userId);
    } catch {
      return { ok: false, kind: "unavailable", reason: "no_session" };
    }
    if (!facts || facts.status !== "active" || !isRoleCode(facts.role)) return { ok: false, kind: "unauthenticated", reason: "user_not_active" };

    // 懒执行：绑定的专员已不是有效 → 停用用户并撤销会话，本次请求即被拒。人工恢复时已知情的失效绑定（ack）不触发；
    // 此时用户有效，但本人范围解析失败，由 buildDataScope 拒绝（B-D08）。停用写失败 → unavailable，不静默放行
    if (facts.role === "store_staff" && facts.mediaStaffId !== null && facts.bindingAckStaffId !== facts.mediaStaffId) {
      let inactive = false;
      try {
        const b = await deps.dir.staffBinding(facts.mediaStaffId);
        inactive = b !== null && b.status !== "active";
      } catch {
        // 目录不可用：不在这里判断，交给下面的 buildDataScope 按「范围无法解释」处理（拒绝 + 质量问题）
      }
      if (inactive) {
        try {
          if ((await deps.linkage.disableIfStaffInactive(userId)) === "disabled") return { ok: false, kind: "unauthenticated", reason: "media_staff_disabled" };
        } catch {
          return { ok: false, kind: "unavailable", reason: "no_session" };
        }
      }
    }
    try {
      const scope = await buildDataScope({ role: facts.role, mediaStaffId: facts.mediaStaffId, brandIds: facts.brandIds, branchIds: facts.branchIds }, deps.dir);
      return {
        ok: true,
        ctx: {
          kind: "user",
          actor: `user:${userId}`,
          userId,
          role: facts.role,
          capabilities: ROLE_CAPABILITIES[facts.role],
          scope,
          sessionId,
        },
      };
    } catch (e) {
      if (!(e instanceof ScopeUnresolvable)) throw e;
      try {
        await deps.onUnresolvable?.({ userId, reason: e.reason });
      } catch {
        // 质量问题写入失败不改变拒绝
      }
      return { ok: false, kind: "forbidden", reason: "scope_not_resolvable" };
    }
  }
  return { contextForUser };
}
export type ContextResolver = ReturnType<typeof createContextResolver>;
export function createAuthenticator(deps: AuthenticatorDeps) {
  const { contextForUser } = createContextResolver(deps);
  async function authenticate(headers: Headers): Promise<AuthenticateResult> {
    let session: Awaited<ReturnType<AccessAuth["api"]["getSession"]>>;
    try {
      session = await deps.auth.api.getSession({ headers });
    } catch {
      return { ok: false, kind: "unavailable", reason: "no_session" };
    }
    if (!session) return { ok: false, kind: "unauthenticated", reason: "no_session" };
    return contextForUser(BigInt(session.user.id), String(session.session.id));
  }
  return { authenticate, contextForUser };
}

export type Authenticator = ReturnType<typeof createAuthenticator>;
