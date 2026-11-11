// 用户管理的共享内核：读取、创建、停用、恢复（design §5.3、§7.6、§7.9、AX-5）。
// 所有写入都在调用方给的事务里完成；高风险审计与业务写入同一事务（AX-D06）。
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { accessUserBranches, accessUserBrands, accessUsers, authSessions, authUsers, authVerifications, branches, mediaStaff, sectors, stores } from "../../../db/schema";
import type { Clock } from "../../raw-capture/ports";
import type { AuditWriter } from "../audit";
import type { AuthContext } from "../authorize";
import { AccessError, isDuplicateKey } from "../errors";
import type { Principal, TargetUser } from "../grants";
import { isRoleCode, type RoleCode } from "../roles";
import type { OrgDirectory } from "../scope";

export type Runner = Db | DbTx;

export type UserStatus = "pending_activation" | "active" | "disabled";

export interface UserRecord {
  userId: bigint;
  role: RoleCode;
  displayName: string;
  phone: string;
  status: UserStatus;
  statusBeforeDisable: UserStatus | null;
  disabledReason: string | null;
  autoDisabledStaffId: bigint | null;
  mediaStaffId: bigint | null;
  /** 人工恢复豁免：管理员恢复时已知「这个专员」非 active（AX-D30）。 */
  bindingAckStaffId: bigint | null;
  activatedAt: Date | null;
  createdByActor: string;
  createdAt: Date;
  updatedAt: Date;
  brandIds: ReadonlySet<bigint>;
  branchIds: ReadonlySet<bigint>;
}

export interface UserDeps {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  dir: OrgDirectory;
}

export const tombstone = (userId: bigint): string => `disabled:${userId}`;

const rowToRecord = (r: typeof accessUsers.$inferSelect, brandIds: Set<bigint>, branchIds: Set<bigint>): UserRecord => {
  if (!isRoleCode(r.roleCode)) throw new Error(`数据库里有非法角色 ${r.roleCode}（user ${r.userId}）`);
  return {
    userId: r.userId,
    role: r.roleCode,
    displayName: r.displayName,
    phone: r.phone,
    status: r.status as UserStatus,
    statusBeforeDisable: (r.statusBeforeDisable as UserStatus | null) ?? null,
    disabledReason: r.disabledReason,
    autoDisabledStaffId: r.autoDisabledStaffId,
    mediaStaffId: r.mediaStaffId,
    bindingAckStaffId: r.bindingAckStaffId,
    activatedAt: r.activatedAt,
    createdByActor: r.createdByActor,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    brandIds,
    branchIds,
  };
};

/** 读一个用户及其集合；forUpdate 对授权行加排他锁（目标用户行 FOR UPDATE 串行化并发变更，design §8）。 */
export async function loadUserRecord(runner: Runner, userId: bigint, opts: { forUpdate?: boolean } = {}): Promise<UserRecord | null> {
  const q = runner.select().from(accessUsers).where(eq(accessUsers.userId, userId)).limit(1);
  const [r] = opts.forUpdate ? await q.for("update") : await q;
  if (!r) return null;
  const [b, br] = await Promise.all([
    runner.select({ id: accessUserBrands.brandId }).from(accessUserBrands).where(eq(accessUserBrands.userId, userId)),
    runner.select({ id: accessUserBranches.branchId }).from(accessUserBranches).where(eq(accessUserBranches.userId, userId)),
  ]);
  return rowToRecord(r, new Set(b.map((x) => x.id)), new Set(br.map((x) => x.id)));
}

export async function loadUserRecords(runner: Runner, where?: ReturnType<typeof and>): Promise<UserRecord[]> {
  const rows = await runner.select().from(accessUsers).where(where).orderBy(accessUsers.userId);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.userId);
  const [brandRows, branchRows] = await Promise.all([
    runner.select().from(accessUserBrands).where(inArray(accessUserBrands.userId, ids)),
    runner.select().from(accessUserBranches).where(inArray(accessUserBranches.userId, ids)),
  ]);
  const brandsBy = new Map<bigint, Set<bigint>>();
  const branchesBy = new Map<bigint, Set<bigint>>();
  for (const r of brandRows) (brandsBy.get(r.userId) ?? brandsBy.set(r.userId, new Set()).get(r.userId)!).add(r.brandId);
  for (const r of branchRows) (branchesBy.get(r.userId) ?? branchesBy.set(r.userId, new Set()).get(r.userId)!).add(r.branchId);
  return rows.map((r) => rowToRecord(r, brandsBy.get(r.userId) ?? new Set(), branchesBy.get(r.userId) ?? new Set()));
}

/** 门店专员所在门店的品牌与分公司（经板块）。 */
export interface StaffPlacement {
  staffId: bigint;
  status: string;
  phone: string;
  storeId: bigint;
  storeCode: string;
  brandId: bigint;
  branchId: bigint;
}

export async function loadStaffPlacements(runner: Runner, staffIds: readonly bigint[]): Promise<Map<bigint, StaffPlacement>> {
  const out = new Map<bigint, StaffPlacement>();
  if (staffIds.length === 0) return out;
  const rows = await runner
    .select({
      staffId: mediaStaff.staffId,
      status: mediaStaff.status,
      phone: mediaStaff.phone,
      storeId: stores.storeId,
      storeCode: stores.storeCode,
      brandId: stores.brandId,
      branchId: branches.branchId,
    })
    .from(mediaStaff)
    .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
    .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
    .innerJoin(branches, eq(branches.branchId, sectors.branchId))
    .where(inArray(mediaStaff.staffId, [...staffIds]));
  for (const r of rows) out.set(r.staffId, r);
  return out;
}

/** `manages` 需要的目标事实：store_staff 的品牌 / 分公司由其门店推出，hq / admin 的分公司为 'all'。 */
export async function targetsOf(runner: Runner, recs: readonly UserRecord[]): Promise<Map<bigint, TargetUser>> {
  const placements = await loadStaffPlacements(
    runner,
    recs.filter((r) => r.role === "store_staff" && r.mediaStaffId !== null).map((r) => r.mediaStaffId!),
  );
  const out = new Map<bigint, TargetUser>();
  for (const r of recs) {
    if (r.role === "store_staff") {
      const p = r.mediaStaffId === null ? undefined : placements.get(r.mediaStaffId);
      out.set(r.userId, { userId: r.userId, role: r.role, brands: new Set(p ? [p.brandId] : []), branches: new Set(p ? [p.branchId] : []) });
    } else {
      out.set(r.userId, { userId: r.userId, role: r.role, brands: r.brandIds, branches: r.role === "branch_manager" ? r.branchIds : "all" });
    }
  }
  return out;
}

/** 管理操作的主体：必须是真实用户（服务身份永不管理用户）。 */
export function principalOf(ctx: AuthContext): Principal {
  if (ctx.kind !== "user" || ctx.userId === null || ctx.role === null) {
    throw new AccessError("authorization", "forbidden", "只有用户可以执行用户管理操作");
  }
  return { userId: ctx.userId, role: ctx.role, brands: ctx.scope.brands, branches: ctx.scope.branches };
}

// ---- 创建 ------------------------------------------------------------------------------------------------

export interface NewUser {
  name: string;
  role: RoleCode;
  /** 规范化后的手机号。 */
  phone: string;
  brandIds: ReadonlySet<bigint>;
  branchIds: ReadonlySet<bigint>;
  mediaStaffId: bigint | null;
  createdByActor: string;
  createdByUserId: bigint | null;
  /** 写进审计 detail 的来源信息（例如导入批次、行号）；不含手机号以外的敏感值。 */
  source?: Record<string, unknown>;
  batchRef?: bigint;
}

/**
 * 创建一个待激活用户：认证行 + 授权行 + 集合 + 审计，同一事务。**不发短信**，**不设密码**（用户自己激活时设置）。
 * 邮箱是随机合成值（库要求必填且唯一，ADR-0015 S7），不展示、不用于找回。
 * 手机号已被「待激活 + 有效」用户占用 → AccessError conflict/phone_exists。
 */
export async function createUserRecord(tx: DbTx, deps: Pick<UserDeps, "clock" | "audit">, u: NewUser): Promise<bigint> {
  const now = deps.clock.now();
  let userId: bigint;
  try {
    const [r] = await tx.insert(authUsers).values({
      name: u.name,
      email: `${randomUUID()}@hbecho.invalid`,
      emailVerified: false,
      phoneNumber: u.phone,
      phoneNumberVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    userId = BigInt(r.insertId);
    await tx.insert(accessUsers).values({
      userId,
      roleCode: u.role,
      displayName: u.name,
      phone: u.phone,
      status: "pending_activation",
      mediaStaffId: u.mediaStaffId,
      createdByActor: u.createdByActor,
      createdByUserId: u.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (isDuplicateKey(e, "uq_auth_users_phone") || isDuplicateKey(e, "uq_access_users_active_phone")) {
      throw new AccessError("conflict", "phone_exists", "该手机号已被待激活或有效的用户占用");
    }
    if (isDuplicateKey(e, "uq_access_users_active_staff")) throw new AccessError("conflict", "staff_already_bound", "该门店专员已绑定了另一个用户");
    throw e;
  }
  if (u.brandIds.size) await tx.insert(accessUserBrands).values([...u.brandIds].map((brandId) => ({ userId, brandId })));
  if (u.branchIds.size) await tx.insert(accessUserBranches).values([...u.branchIds].map((branchId) => ({ userId, branchId })));
  await deps.audit.write(
    {
      actor: u.createdByActor,
      actorUserId: u.createdByUserId,
      eventType: "user_created",
      outcome: "succeeded",
      reasonCode: "user_created",
      targetType: "user",
      targetId: userId.toString(),
      ...(u.batchRef !== undefined ? { batchRef: u.batchRef } : {}),
      scopeSummary: { role: u.role, brandIds: [...u.brandIds], branchIds: [...u.branchIds] },
      detail: { phone: u.phone, role: u.role, mediaStaffId: u.mediaStaffId, ...u.source },
    },
    { tx, risk: "high" },
  );
  return userId;
}

// ---- 停用 ------------------------------------------------------------------------------------------------

export interface DisableOptions {
  userId: bigint;
  /** 执行者：`user:<id>` 或 `service:access-worker`。 */
  byActor: string;
  byUserId: bigint | null;
  reason: "manual" | "media_staff_disabled";
  autoStaffId?: bigint;
  eventType?: string;
  reasonCode?: string;
  /** 执行者自己的用户 ID（用户操作时）：在锁住超管集合之后复核其仍然有效。 */
  actorMustBeActive?: bigint;
}

/** 锁住全部「未停用」超管行（按 ID 升序，固定锁顺序避免两个超管互停时死锁），返回其 ID。 */
export async function lockActiveAdmins(tx: DbTx): Promise<bigint[]> {
  const rows = await tx
    .select({ id: accessUsers.userId })
    .from(accessUsers)
    .where(and(eq(accessUsers.roleCode, "platform_admin"), ne(accessUsers.status, "disabled")))
    .orderBy(accessUsers.userId)
    .for("update");
  return rows.map((r) => r.id);
}

/**
 * 停用核心（用户管理、专员联动共用）：授权状态、认证登录手机号改写为墓碑值、撤销全部会话、清掉该号码的待用验证码、审计，同一事务。
 * 墓碑改写失败整个事务回滚（用户仍有效），因为「停用后不可登录」是安全属性（design §8）。
 * 返回 false = 已经是停用状态（幂等，不重复写审计）。
 */
export async function disableCore(tx: DbTx, deps: Pick<UserDeps, "clock" | "audit">, o: DisableOptions): Promise<boolean> {
  const now = deps.clock.now();
  // 超管不能停用自己（B-D02）：调用方的 manages 已排除，核心里再拦一道，防止新的调用点绕过
  if (o.byUserId !== null && o.byUserId === o.userId) throw new AccessError("conflict", "cannot_disable_self", "不能停用自己");
  // 目标是超管：先按固定顺序锁全部超管行，再读目标，使「最后一个超管 / 互相停用」在锁内判断
  const [peek] = await tx.select({ role: accessUsers.roleCode }).from(accessUsers).where(eq(accessUsers.userId, o.userId)).limit(1);
  if (!peek) throw new AccessError("not_found", "user_not_found", "用户不存在");
  let admins: bigint[] = [];
  if (peek.role === "platform_admin") {
    admins = await lockActiveAdmins(tx);
    if (o.actorMustBeActive !== undefined && !admins.includes(o.actorMustBeActive)) {
      // 另一个超管刚把执行者停用了：不再有权限
      throw new AccessError("authorization", "actor_not_active", "执行者已不是有效用户");
    }
  }
  const u = await loadUserRecord(tx, o.userId, { forUpdate: true });
  if (!u) throw new AccessError("not_found", "user_not_found", "用户不存在");
  if (u.status === "disabled") return false;
  if (u.role === "platform_admin" && admins.filter((id) => id !== u.userId).length === 0) {
    throw new AccessError("conflict", "last_superadmin", "不能停用最后一个可用的超级管理员");
  }

  await tx
    .update(accessUsers)
    .set({
      status: "disabled",
      statusBeforeDisable: u.status,
      disabledAt: now,
      disabledByActor: o.byActor,
      disabledReason: o.reason,
      autoDisabledStaffId: o.autoStaffId ?? null,
      updatedAt: now,
    })
    .where(eq(accessUsers.userId, u.userId));
  // 墓碑值：让「登录只匹配非停用记录」由数据结构保证（ADR-0015 S6）
  await tx.update(authUsers).set({ phoneNumber: tombstone(u.userId), phoneNumberVerified: false, updatedAt: now }).where(eq(authUsers.id, u.userId));
  await tx.delete(authSessions).where(eq(authSessions.userId, u.userId));
  await tx.delete(authVerifications).where(inArray(authVerifications.identifier, [`phone-number-otp-${u.phone}`, `phone-number-reset-${u.phone}`]));
  await deps.audit.write(
    {
      actor: o.byActor,
      actorUserId: o.byUserId,
      eventType: o.eventType ?? "user_disabled",
      outcome: "succeeded",
      reasonCode: o.reasonCode ?? (o.reason === "manual" ? "user_disabled_manual" : "media_staff_disabled"),
      targetType: "user",
      targetId: u.userId.toString(),
      detail: { phone: u.phone, role: u.role, statusBefore: u.status, reason: o.reason, ...(o.autoStaffId !== undefined ? { mediaStaffId: o.autoStaffId } : {}) },
    },
    { tx, risk: "high" },
  );
  return true;
}

// ---- 恢复 ------------------------------------------------------------------------------------------------

export interface RestoreResult {
  status: UserStatus;
  removedBrandIds: bigint[];
  removedBranchIds: bigint[];
}

/**
 * 恢复核心：重新检查授权引用（经 OrgDirectory），**无法映射的项直接去掉**并在审计里记一条；品牌 / 分公司**停用**不算失效（B-D25）。
 * 状态回到停用前的状态；先改授权行（触发 UQ(active_phone)，同号冲突在此被数据库拒绝），再把原号写回认证表。
 * 专员绑定不在这里改：恢复时专员已停用，用户仍为有效，但本人范围由 buildDataScope 拒绝（B-D08）。
 */
export async function restoreCore(
  tx: DbTx,
  deps: UserDeps,
  o: { userId: bigint; byActor: string; byUserId: bigint | null; eventType?: string; reasonCode?: string },
): Promise<RestoreResult> {
  const now = deps.clock.now();
  const u = await loadUserRecord(tx, o.userId, { forUpdate: true });
  if (!u) throw new AccessError("not_found", "user_not_found", "用户不存在");
  if (u.status !== "disabled") throw new AccessError("conflict", "not_disabled", "用户不是停用状态");
  const restoredStatus: UserStatus = u.statusBeforeDisable ?? "active";

  // 引用复核。目录不可用时整体失败（不去掉任何项、不恢复）：宁可不恢复，也不基于未知事实改授权
  const removedBrandIds: bigint[] = [];
  for (const id of u.brandIds) if ((await deps.dir.brand(id)) === null) removedBrandIds.push(id);
  const removedBranchIds: bigint[] = [];
  for (const id of u.branchIds) if ((await deps.dir.branch(id)) === null) removedBranchIds.push(id);
  if (removedBrandIds.length) await tx.delete(accessUserBrands).where(and(eq(accessUserBrands.userId, u.userId), inArray(accessUserBrands.brandId, removedBrandIds)));
  if (removedBranchIds.length) await tx.delete(accessUserBranches).where(and(eq(accessUserBranches.userId, u.userId), inArray(accessUserBranches.branchId, removedBranchIds)));

  // 人工恢复豁免（AX-D30、B-D08）：绑定的专员当前不是 active → 记下这个专员，懒停用 / 补偿跳过；用户保持有效，本人范围被拒
  let ackStaffId: bigint | null = null;
  if (u.mediaStaffId !== null) {
    const placement = (await loadStaffPlacements(tx, [u.mediaStaffId])).get(u.mediaStaffId);
    if (!placement || placement.status !== "active") ackStaffId = u.mediaStaffId;
  }
  try {
    await tx
      .update(accessUsers)
      .set({
        status: restoredStatus,
        statusBeforeDisable: null,
        disabledAt: null,
        disabledByActor: null,
        disabledReason: null,
        autoDisabledStaffId: null,
        bindingAckStaffId: ackStaffId,
        updatedAt: now,
      })
      .where(eq(accessUsers.userId, u.userId));
  } catch (e) {
    if (isDuplicateKey(e, "uq_access_users_active_phone")) throw new AccessError("conflict", "phone_in_use", "该手机号已被另一个待激活或有效的用户占用，不能恢复");
    if (isDuplicateKey(e, "uq_access_users_active_staff")) throw new AccessError("conflict", "staff_already_bound", "该门店专员已绑定了另一个用户，不能恢复");
    throw e;
  }
  try {
    await tx.update(authUsers).set({ phoneNumber: u.phone, phoneNumberVerified: restoredStatus === "active", updatedAt: now }).where(eq(authUsers.id, u.userId));
  } catch (e) {
    if (isDuplicateKey(e, "uq_auth_users_phone")) throw new AccessError("conflict", "phone_in_use", "该手机号已被另一个待激活或有效的用户占用，不能恢复");
    throw e;
  }
  await deps.audit.write(
    {
      actor: o.byActor,
      actorUserId: o.byUserId,
      eventType: o.eventType ?? "user_restored",
      outcome: "succeeded",
      reasonCode: o.reasonCode ?? "user_restored",
      targetType: "user",
      targetId: u.userId.toString(),
      detail: { phone: u.phone, role: u.role, restoredStatus, removedBrandIds, removedBranchIds, bindingInvalid: ackStaffId !== null },
    },
    { tx, risk: "high" },
  );
  return { status: restoredStatus, removedBrandIds, removedBranchIds };
}

/** 当前未停用的超管数量（首个超管引导用）。 */
export async function countActiveAdmins(runner: Runner, lock = false): Promise<number> {
  const q = runner
    .select({ id: accessUsers.userId })
    .from(accessUsers)
    .where(and(eq(accessUsers.roleCode, "platform_admin"), ne(accessUsers.status, "disabled")));
  return (lock ? await q.for("update") : await q).length;
}
