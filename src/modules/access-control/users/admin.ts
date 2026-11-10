// UserAdministration（design §1、§7.6、AX-2、AX-5、AX-8）：对外的用户管理。
//   - 每个操作先过 `authorize(user.manage)`（Capability），再用 `manages` / `canGrant`（管理范围与授权边界）；
//   - **读写同源**：列表、详情、修改、停用、恢复、强制下线、批量，全部用同一个 `manages`，杜绝「看不到但能改」；
//   - 越界的对象对外表现为「未找到」（不暴露同级 / 他分公司用户的存在）；
//   - 变更授权 / 停用 / 恢复：以目标用户行 FOR UPDATE 串行化，proposed 超界整体拒绝、零写入。
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { DbTx } from "../../../db/client";
import { accessUserBranches, accessUserBrands, accessUsers, authSessions, authUsers, brands, mediaStaff, stores } from "../../../db/schema";
import { normalizePhone } from "../../phone";
import type { AuthContext, Authorizer } from "../authorize";
import { AccessError } from "../errors";
import { canGrant, manages, type Principal, type ProposedGrant } from "../grants";
import { isRoleCode, ROLE_RANK, type RoleCode } from "../roles";
import {
  createUserRecord,
  disableCore,
  loadStaffPlacements,
  loadUserRecord,
  loadUserRecords,
  principalOf,
  restoreCore,
  targetsOf,
  type RestoreResult,
  type UserDeps,
  type UserRecord,
  type UserStatus,
} from "./shared";

export interface InviteInput {
  name: string;
  role: string;
  phone: string;
  brandIds?: readonly bigint[];
  branchIds?: readonly bigint[];
  /** store_staff：门店编码。手机号 + 门店编码定位唯一有效专员（B-D07）。 */
  storeCode?: string;
  /** 批量导入时写进审计 detail 的来源信息。 */
  source?: Record<string, unknown>;
  batchRef?: bigint;
}

export interface ChangeInput {
  displayName?: string;
  role?: string;
  brandIds?: readonly bigint[];
  branchIds?: readonly bigint[];
  /** 仅待激活用户可改（B-D06）；有效用户改号只能删旧建新。 */
  phone?: string;
}

export interface UserView {
  userId: string;
  name: string;
  role: RoleCode;
  phone: string;
  status: UserStatus;
  brandIds: string[];
  branchIds: string[];
  mediaStaffId: string | null;
  /** 待激活的天数（B-D04：管理员据此批量停用）；其他状态为 null。 */
  pendingDays: number | null;
  createdAt: string;
  /** 当前登录者是否可以管理这个用户（自己 = false，只读）。 */
  manageable: boolean;
}

const notFound = () => new AccessError("not_found", "user_not_found", "用户不存在或不在你的管理范围内");

export interface UserAdminDeps extends UserDeps {
  authorizer: Authorizer;
  /** 停用 / 撤权事务提交**之后**调用（取消该用户触发的未完成异步任务，任务 10 接入）；失败不回滚。 */
  onRevoked?(userActor: string): Promise<void>;
}

export function createUserAdmin(deps: UserAdminDeps) {
  const { db } = deps;

  /** Capability → 主体。服务身份永不管理用户（authorize 会先因白名单拒绝）。 */
  async function requireManager(ctx: AuthContext): Promise<Principal> {
    const d = await deps.authorizer.authorize(ctx, { capability: "user.manage" });
    if (!d.ok) throw new AccessError("authorization", "forbidden", "没有用户管理权限");
    return principalOf(ctx);
  }

  /** 读写同源的唯一入口：锁住目标行（可选）并判断可管理；不可管理一律「未找到」。 */
  async function loadManaged(tx: DbTx, p: Principal, userId: bigint, opts: { forUpdate?: boolean } = {}): Promise<UserRecord> {
    const u = await loadUserRecord(tx, userId, opts);
    if (!u) throw notFound();
    const t = (await targetsOf(tx, [u])).get(u.userId)!;
    if (!manages(p, t)) throw notFound();
    return u;
  }

  const revoked = async (userActor: string): Promise<void> => {
    try {
      await deps.onRevoked?.(userActor);
    } catch {
      // 取消任务失败不回滚（各域任务自带过期与交付复查兜底），design §7.13
    }
  };

  const view = (u: UserRecord, manageable: boolean): UserView => ({
    userId: u.userId.toString(),
    name: u.displayName,
    role: u.role,
    phone: u.phone,
    status: u.status,
    brandIds: [...u.brandIds].map(String).sort(),
    branchIds: [...u.branchIds].map(String).sort(),
    mediaStaffId: u.mediaStaffId?.toString() ?? null,
    pendingDays: u.status === "pending_activation" ? Math.floor((deps.clock.now().getTime() - u.createdAt.getTime()) / 86_400_000) : null,
    createdAt: u.createdAt.toISOString(),
    manageable,
  });

  /** store_staff 的专员定位（B-D07）：手机号 + 门店编码 → 唯一有效专员。 */
  async function locateStaff(tx: DbTx, phone: string, storeCode: string) {
    const rows = await tx
      .select({ staffId: mediaStaff.staffId, status: mediaStaff.status, storeId: stores.storeId, storeCode: stores.storeCode, brandId: stores.brandId })
      .from(mediaStaff)
      .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
      .where(and(eq(mediaStaff.phone, phone), eq(stores.storeCode, storeCode)));
    // 有效专员的手机号全局唯一（UQ active_phone），所以「手机号 + 门店编码」命中的有效专员至多一个，不存在歧义
    const active = rows.find((r) => r.status === "active");
    if (active) return active;
    if (rows.length > 0) throw new AccessError("input", "staff_inactive", "该专员已停用，不能建立登录账号");
    throw new AccessError("input", "staff_not_found", "找不到该手机号在该门店下的有效专员");
  }

  /** 邀请的验证与写入，在调用方给的事务内（批量导入的确认也走这里，保证与单个邀请同一套逻辑）。 */
  async function inviteIn(tx: DbTx, ctx: AuthContext, p: Principal, input: InviteInput): Promise<bigint> {
    const phone = normalizePhone(input.phone);
    if (phone === null) throw new AccessError("input", "phone_invalid", "手机号不合法");
    if (!isRoleCode(input.role)) throw new AccessError("input", "role_invalid", "角色不合法");
    const name = input.name.trim();
    if (name === "" || name.length > 100) throw new AccessError("input", "name_invalid", "姓名为空或超过 100 个字符");

    let proposed: ProposedGrant;
    let mediaStaffId: bigint | null = null;
    if (input.role === "store_staff") {
      if (!input.storeCode?.trim()) throw new AccessError("input", "store_code_required", "门店专员必须填写门店编码");
      if (input.brandIds?.length || input.branchIds?.length) throw new AccessError("input", "scope_fields_not_allowed", "门店专员的品牌与分公司由其门店推出，不能填写");
      const staff = await locateStaff(tx, phone, input.storeCode.trim());
      const placement = (await loadStaffPlacements(tx, [staff.staffId])).get(staff.staffId)!;
      mediaStaffId = staff.staffId;
      proposed = { role: input.role, brandIds: new Set(), branchIds: new Set(), store: { brandId: placement.brandId, branchId: placement.branchId } };
    } else {
      proposed = { role: input.role, brandIds: new Set(input.brandIds ?? []), branchIds: new Set(input.branchIds ?? []) };
    }

    const verdict = canGrant(p, proposed);
    if (!verdict.ok) {
      // 门店不在操作者范围内：对导入的行给出更具体的原因码
      const code = proposed.store && verdict.reason === "scope_exceeds_boundary" ? "store_not_in_scope" : verdict.reason;
      throw new AccessError("authorization", code, "超出你的授权边界");
    }
    return createUserRecord(tx, deps, {
      name,
      role: input.role,
      phone,
      brandIds: proposed.brandIds,
      branchIds: proposed.branchIds,
      mediaStaffId,
      createdByActor: ctx.actor,
      createdByUserId: ctx.userId,
      ...(input.source ? { source: input.source } : {}),
      ...(input.batchRef !== undefined ? { batchRef: input.batchRef } : {}),
    });
  }

  return {
    /** 邀请：创建待激活用户，**不发短信**（用户自己到激活入口请求验证码）。 */
    async invite(ctx: AuthContext, input: InviteInput): Promise<{ userId: string }> {
      const p = await requireManager(ctx);
      const id = await db.transaction((tx) => inviteIn(tx, ctx, p, input));
      return { userId: id.toString() };
    },

    /** 供批量导入的确认写入使用：同一套逻辑，调用方提供事务。 */
    inviteIn,

    async get(ctx: AuthContext, userId: bigint): Promise<UserView> {
      const p = await requireManager(ctx);
      const u = await loadUserRecord(db, userId);
      if (!u) throw notFound();
      if (u.userId === p.userId) return view(u, false); // 自己：可见，只读
      const t = (await targetsOf(db, [u])).get(u.userId)!;
      if (!manages(p, t)) throw notFound();
      return view(u, true);
    },

    /**
     * 用户列表 = 「可管理的用户」∪「自己」，用的就是 `manages`（读写同源，等价性有测试）。
     * ponytail: 先按角色等级在 SQL 里预筛，再在内存里用 manages 精筛；用户总量在几千量级（PRD：门店专员 3,500+），
     * 一次载入可以接受。超过约 2 万用户时改成 SQL 里直接做品牌 / 分公司的集合包含判断，并保持与 manages 的等价测试。
     */
    async list(ctx: AuthContext, filter: { status?: UserStatus; role?: RoleCode } = {}): Promise<UserView[]> {
      const p = await requireManager(ctx);
      const lower = (Object.keys(ROLE_RANK) as RoleCode[]).filter((r) => p.role === "platform_admin" || ROLE_RANK[r] < ROLE_RANK[p.role]);
      const recs = await loadUserRecords(
        db,
        and(
          or(inArray(accessUsers.roleCode, lower), eq(accessUsers.userId, p.userId)),
          filter.status ? eq(accessUsers.status, filter.status) : undefined,
          filter.role ? eq(accessUsers.roleCode, filter.role) : undefined,
        ),
      );
      const targets = await targetsOf(db, recs);
      return recs.flatMap((u) => {
        if (u.userId === p.userId) return [view(u, false)];
        return manages(p, targets.get(u.userId)!) ? [view(u, true)] : [];
      });
    },

    /** 变更授权：current 校验（manages）+ proposed 校验（canGrant），任一不过整体拒绝、零写入；不撤销现有会话（B-D33）。 */
    async changeAccess(ctx: AuthContext, userId: bigint, change: ChangeInput): Promise<{ userId: string }> {
      const p = await requireManager(ctx);
      await db.transaction(async (tx) => {
        const u = await loadManaged(tx, p, userId, { forUpdate: true });
        if (u.status === "disabled") throw new AccessError("conflict", "user_disabled", "停用的用户不能变更，请先恢复");

        const now = deps.clock.now();
        const set: Partial<typeof accessUsers.$inferInsert> = {};
        const before: Record<string, unknown> = { role: u.role, brandIds: [...u.brandIds].map(String), branchIds: [...u.branchIds].map(String), name: u.displayName };

        if (change.displayName !== undefined) {
          const n = change.displayName.trim();
          if (n === "" || n.length > 100) throw new AccessError("input", "name_invalid", "姓名为空或超过 100 个字符");
          set.displayName = n;
        }

        const accessChanging = change.role !== undefined || change.brandIds !== undefined || change.branchIds !== undefined;
        if (accessChanging) {
          // 门店专员的门店 / 品牌不能原地修改，只能删旧建新（B-D09）
          if (u.role === "store_staff") throw new AccessError("conflict", "store_staff_immutable", "门店专员的门店与品牌不能原地修改，请停用后用同一手机号重新建号");
          const role = change.role ?? u.role;
          if (!isRoleCode(role)) throw new AccessError("input", "role_invalid", "角色不合法");
          if (role === "store_staff") throw new AccessError("conflict", "store_staff_immutable", "不能把已有用户改成门店专员，请新建并绑定专员");
          const proposed: ProposedGrant = {
            role,
            brandIds: new Set(change.brandIds ?? u.brandIds),
            // 角色变化时默认不继承原有分公司集合（hq 不带分公司）；调用方显式给才用
            branchIds: new Set(change.branchIds ?? (role === "branch_manager" ? u.branchIds : [])),
          };
          const verdict = canGrant(p, proposed);
          if (!verdict.ok) throw new AccessError("authorization", verdict.reason, "变更后的授权超出你的边界，整个变更被拒绝");

          // 降级 / 改走超管：最后一个可用超管保护（锁全部超管行后判断）
          if (u.role === "platform_admin" && role !== "platform_admin") {
            const admins = await tx.select({ id: accessUsers.userId }).from(accessUsers).where(and(eq(accessUsers.roleCode, "platform_admin"), ne(accessUsers.status, "disabled"))).orderBy(accessUsers.userId).for("update");
            if (admins.filter((a) => a.id !== u.userId).length === 0) throw new AccessError("conflict", "last_superadmin", "不能降级最后一个可用的超级管理员");
          }

          set.roleCode = role;
          await tx.delete(accessUserBrands).where(eq(accessUserBrands.userId, u.userId));
          await tx.delete(accessUserBranches).where(eq(accessUserBranches.userId, u.userId));
          if (proposed.brandIds.size) await tx.insert(accessUserBrands).values([...proposed.brandIds].map((brandId) => ({ userId: u.userId, brandId })));
          if (proposed.branchIds.size) await tx.insert(accessUserBranches).values([...proposed.branchIds].map((branchId) => ({ userId: u.userId, branchId })));
          before.after = { role, brandIds: [...proposed.brandIds].map(String), branchIds: [...proposed.branchIds].map(String) };
        }

        if (change.phone !== undefined) {
          // 待激活期内尚无登录与会话，可以直接改号；有效用户改号只能删旧建新（B-D06、D-43）
          if (u.status !== "pending_activation") throw new AccessError("conflict", "phone_change_requires_replace", "有效用户不能直接改手机号，请停用后用新手机号重新建号");
          const phone = normalizePhone(change.phone);
          if (phone === null) throw new AccessError("input", "phone_invalid", "手机号不合法");
          set.phone = phone;
          try {
            await tx.update(authUsers).set({ phoneNumber: phone, updatedAt: now }).where(eq(authUsers.id, u.userId));
          } catch (e) {
            if (String((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === "ER_DUP_ENTRY") throw new AccessError("conflict", "phone_exists", "该手机号已被待激活或有效的用户占用");
            throw e;
          }
        }

        if (Object.keys(set).length === 0 && !accessChanging) return;
        try {
          await tx.update(accessUsers).set({ ...set, updatedAt: now }).where(eq(accessUsers.userId, u.userId));
        } catch (e) {
          if (String((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === "ER_DUP_ENTRY") throw new AccessError("conflict", "phone_exists", "该手机号已被待激活或有效的用户占用");
          throw e;
        }
        await deps.audit.write(
          {
            actor: ctx.actor,
            actorUserId: ctx.userId,
            eventType: "access_changed",
            outcome: "succeeded",
            reasonCode: "access_changed",
            targetType: "user",
            targetId: u.userId.toString(),
            detail: { before, change: { ...(change.displayName !== undefined ? { displayName: change.displayName } : {}), ...(change.role !== undefined ? { role: change.role } : {}), ...(change.phone !== undefined ? { phoneChanged: true } : {}) } },
          },
          { tx, risk: "high" },
        );
      });
      return { userId: userId.toString() };
    },

    async disable(ctx: AuthContext, userId: bigint): Promise<{ changed: boolean }> {
      const p = await requireManager(ctx);
      const changed = await db.transaction(async (tx) => {
        await loadManaged(tx, p, userId); // 先判断可管理（越界 = 未找到）；核心里会再加锁
        return disableCore(tx, deps, { userId, byActor: ctx.actor, byUserId: ctx.userId, reason: "manual", actorMustBeActive: p.userId });
      });
      if (changed) await revoked(`user:${userId}`); // 提交之后取消该用户触发的未完成异步任务
      return { changed };
    },

    async restore(ctx: AuthContext, userId: bigint): Promise<RestoreResult> {
      const p = await requireManager(ctx);
      return db.transaction(async (tx) => {
        await loadManaged(tx, p, userId);
        return restoreCore(tx, deps, { userId, byActor: ctx.actor, byUserId: ctx.userId });
      });
    },

    /** 强制下线：撤销目标用户的全部会话，不改变角色与状态；记审计。 */
    async forceLogout(ctx: AuthContext, userId: bigint): Promise<{ revoked: number }> {
      const p = await requireManager(ctx);
      const n = await db.transaction(async (tx) => {
        const u = await loadManaged(tx, p, userId, { forUpdate: true });
        const rows = await tx.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, u.userId));
        await tx.delete(authSessions).where(eq(authSessions.userId, u.userId));
        await deps.audit.write(
          { actor: ctx.actor, actorUserId: ctx.userId, eventType: "force_logout", outcome: "succeeded", reasonCode: "force_logout", targetType: "user", targetId: u.userId.toString(), detail: { sessions: rows.length } },
          { tx, risk: "high" },
        );
        return rows.length;
      });
      return { revoked: n };
    },

    /** 品牌是否存在（邀请 / 变更前给调用方做友好校验；外键 RESTRICT 才是最终保证）。 */
    async brandsExist(ids: readonly bigint[]): Promise<boolean> {
      if (ids.length === 0) return true;
      const rows = await db.select({ id: brands.brandId }).from(brands).where(inArray(brands.brandId, [...ids]));
      return rows.length === new Set(ids).size;
    },
  };
}

export type UserAdmin = ReturnType<typeof createUserAdmin>;
