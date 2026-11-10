// authenticate（design §7.2、AX-1）：Route Handler 与将来的页面共用的唯一认证入口。
//   - 每个请求现建 AuthContext，**不跨请求缓存**（B-D33）：角色或范围变更不撤销现有会话，下一次请求即按新权限判断
//   - 认证库异常 → unavailable（503 样式，业务拒绝），**不当作「未登录」静默放行**
//   - 用户非 active（待激活 / 停用）→ unauthenticated；停用用户无法续期（会话在停用事务里已撤销，这里是第二道）
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accessUserBranches, accessUserBrands, accessUsers } from "../../db/schema";
import type { AccessAuth } from "./auth-instance";
import type { AuthContext, DenyReason } from "./authorize";
import { isRoleCode, ROLE_CAPABILITIES } from "./roles";
import { buildDataScope, ScopeUnresolvable, type OrgDirectory } from "./scope";

export type AuthenticateResult =
  | { ok: true; ctx: AuthContext }
  | { ok: false; kind: "unauthenticated" | "forbidden" | "unavailable"; reason: DenyReason | "no_session" | "media_staff_disabled" };

export interface AuthenticatorDeps {
  db: Db;
  auth: AccessAuth;
  dir: OrgDirectory;
  /** 范围无法解释时调用（写质量问题）；失败不影响拒绝。 */
  onUnresolvable?(info: { userId: bigint; reason: string }): Promise<void> | void;
}

export interface UserFacts {
  userId: bigint;
  role: string;
  status: string;
  mediaStaffId: bigint | null;
  brandIds: ReadonlySet<bigint>;
  branchIds: ReadonlySet<bigint>;
}

export async function loadUserFacts(db: Db, userId: bigint): Promise<UserFacts | null> {
  const [u] = await db
    .select({ userId: accessUsers.userId, role: accessUsers.roleCode, status: accessUsers.status, mediaStaffId: accessUsers.mediaStaffId })
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

export function createAuthenticator(deps: AuthenticatorDeps) {
  async function authenticate(headers: Headers): Promise<AuthenticateResult> {
    let session: Awaited<ReturnType<AccessAuth["api"]["getSession"]>>;
    try {
      session = await deps.auth.api.getSession({ headers });
    } catch {
      return { ok: false, kind: "unavailable", reason: "no_session" };
    }
    if (!session) return { ok: false, kind: "unauthenticated", reason: "no_session" };

    const userId = BigInt(session.user.id);
    let facts: UserFacts | null;
    try {
      facts = await loadUserFacts(deps.db, userId);
    } catch {
      return { ok: false, kind: "unavailable", reason: "no_session" };
    }
    if (!facts || facts.status !== "active" || !isRoleCode(facts.role)) return { ok: false, kind: "unauthenticated", reason: "user_not_active" };

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
          sessionId: String(session.session.id),
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
  return { authenticate };
}

export type Authenticator = ReturnType<typeof createAuthenticator>;
