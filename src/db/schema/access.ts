// B 域（访问控制）自有表（b-access-control design §6.1；不写入 v2，AX-D01）。
// 约定同 src/db/columns.ts：signed BIGINT、UTC DATETIME(6)、状态 VARCHAR + CHECK、业务表无 ON DELETE CASCADE。
// 认证表（auth_*）见 ./auth.ts；access_users 与 auth_users 1:1。
import { sql } from "drizzle-orm";
import { check, foreignKey, index, int, json, mysqlTable, primaryKey, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { id, inList, sha256, utc } from "../columns";
import { authUsers } from "./auth";
import { brands, branches, mediaStaff } from "./org";

export const ROLE_CODES = ["platform_admin", "hq_manager", "branch_manager", "store_staff"] as const;
export const USER_STATUSES = ["pending_activation", "active", "disabled"] as const;
export const DISABLED_REASONS = ["manual", "media_staff_disabled"] as const;
export const SMS_PURPOSES = ["activate", "login", "reset"] as const;
export const SMS_OUTCOMES = ["sent", "suppressed", "failed", "rate_limited"] as const;
export const AUDIT_OUTCOMES = ["succeeded", "denied", "failed"] as const;

export const accessUsers = mysqlTable(
  "access_users",
  {
    userId: id("user_id").primaryKey(),
    roleCode: varchar("role_code", { length: 32 }).notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    // 规范化后的原号，明文（D-42），永久保存，包括停用后
    phone: varchar("phone", { length: 32 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    // B-D05：手机号唯一只约束「待激活 + 有效」；与 media_staff.active_phone 同一做法
    activePhone: varchar("active_phone", { length: 32 }).generatedAlwaysAs(
      sql`(CASE WHEN status IN ('pending_activation','active') THEN phone END)`,
      { mode: "stored" },
    ),
    statusBeforeDisable: varchar("status_before_disable", { length: 24 }),
    disabledAt: utc("disabled_at"),
    disabledByActor: varchar("disabled_by_actor", { length: 128 }),
    disabledReason: varchar("disabled_reason", { length: 48 }),
    // disabled_reason = media_staff_disabled 时记录触发它的专员，供条件恢复使用（B-D11）
    autoDisabledStaffId: id("auto_disabled_staff_id"),
    mediaStaffId: id("media_staff_id"),
    // 非停用用户的专员绑定一对一
    activeMediaStaff: id("active_media_staff").generatedAlwaysAs(sql`(CASE WHEN status <> 'disabled' THEN media_staff_id END)`, {
      mode: "stored",
    }),
    activatedAt: utc("activated_at"),
    createdByActor: varchar("created_by_actor", { length: 128 }).notNull(),
    createdByUserId: id("created_by_user_id"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_access_users_auth", columns: [t.userId], foreignColumns: [authUsers.id] }),
    foreignKey({ name: "fk_access_users_staff", columns: [t.mediaStaffId], foreignColumns: [mediaStaff.staffId] }),
    foreignKey({ name: "fk_access_users_auto_staff", columns: [t.autoDisabledStaffId], foreignColumns: [mediaStaff.staffId] }),
    uniqueIndex("uq_access_users_active_phone").on(t.activePhone),
    uniqueIndex("uq_access_users_active_staff").on(t.activeMediaStaff),
    index("idx_access_users_role_status").on(t.roleCode, t.status),
    index("idx_access_users_phone").on(t.phone),
    check("ck_access_users_role", inList(t.roleCode, ROLE_CODES)),
    check("ck_access_users_status", inList(t.status, USER_STATUSES)),
    check("ck_access_users_disabled_at", sql`(${t.status} = 'disabled') = (${t.disabledAt} IS NOT NULL)`),
    check("ck_access_users_before_disable", sql`(${t.status} = 'disabled') = (${t.statusBeforeDisable} IS NOT NULL)`),
    check("ck_access_users_before_values", sql`${t.statusBeforeDisable} IS NULL OR ${t.statusBeforeDisable} IN ('pending_activation','active')`),
    check("ck_access_users_reason", sql`${t.disabledReason} IS NULL OR ${inList(t.disabledReason, DISABLED_REASONS)}`),
    check("ck_access_users_staff_role", sql`${t.roleCode} = 'store_staff' OR ${t.mediaStaffId} IS NULL`),
  ],
);

export const accessUserBrands = mysqlTable(
  "access_user_brands",
  {
    userId: id("user_id").notNull(),
    brandId: id("brand_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_access_user_brands", columns: [t.userId, t.brandId] }),
    foreignKey({ name: "fk_access_user_brands_user", columns: [t.userId], foreignColumns: [accessUsers.userId] }),
    foreignKey({ name: "fk_access_user_brands_brand", columns: [t.brandId], foreignColumns: [brands.brandId] }),
    index("idx_access_user_brands_brand").on(t.brandId),
  ],
);

export const accessUserBranches = mysqlTable(
  "access_user_branches",
  {
    userId: id("user_id").notNull(),
    branchId: id("branch_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_access_user_branches", columns: [t.userId, t.branchId] }),
    foreignKey({ name: "fk_access_user_branches_user", columns: [t.userId], foreignColumns: [accessUsers.userId] }),
    foreignKey({ name: "fk_access_user_branches_branch", columns: [t.branchId], foreignColumns: [branches.branchId] }),
    index("idx_access_user_branches_branch").on(t.branchId),
  ],
);

// 不论手机号是否对应用户都记（design §1.4 第 6 项），响应与计数对存在 / 不存在一致
export const accessLoginFailures = mysqlTable(
  "access_login_failures",
  {
    phoneNorm: varchar("phone_norm", { length: 32 }).primaryKey(),
    failCount: int("fail_count").notNull(),
    lockedUntil: utc("locked_until"),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [check("ck_access_login_failures_count", sql`${t.failCount} >= 0`), index("idx_access_login_failures_updated").on(t.updatedAt)],
);

// 验证码本身不入此表。60 秒 / 每日 10 条按 sent、suppressed、failed 计，不计 rate_limited（否则重试会不断续期）
export const accessSmsSends = mysqlTable(
  "access_sms_sends",
  {
    sendId: id("send_id").primaryKey().autoincrement(),
    phoneNorm: varchar("phone_norm", { length: 32 }).notNull(),
    purpose: varchar("purpose", { length: 16 }).notNull(),
    requestedAt: utc("requested_at").notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    providerRef: varchar("provider_ref", { length: 64 }),
  },
  (t) => [
    index("idx_access_sms_phone_time").on(t.phoneNorm, t.requestedAt),
    index("idx_access_sms_time_outcome").on(t.requestedAt, t.outcome),
    check("ck_access_sms_purpose", inList(t.purpose, SMS_PURPOSES)),
    check("ck_access_sms_outcome", inList(t.outcome, SMS_OUTCOMES)),
  ],
);

export const accessBootstrapTokens = mysqlTable(
  "access_bootstrap_tokens",
  {
    tokenId: id("token_id").primaryKey().autoincrement(),
    tokenSha256: sha256("token_sha256").notNull(),
    createdByActor: varchar("created_by_actor", { length: 128 }).notNull(),
    createdAt: utc("created_at").notNull(),
    expiresAt: utc("expires_at").notNull(),
    consumedAt: utc("consumed_at"),
    consumedUserId: id("consumed_user_id"),
  },
  (t) => [
    uniqueIndex("uq_access_bootstrap_token").on(t.tokenSha256),
    check("ck_access_bootstrap_consumed", sql`(${t.consumedAt} IS NULL) = (${t.consumedUserId} IS NULL)`),
  ],
);

// 追加写；不可变由手写迁移里的触发器强制（UPDATE 一律拒绝，DELETE 仅放行超过 365 天的行）。
// 无外键：审计是证据，不应被主档约束牵连。
export const auditEvents = mysqlTable(
  "audit_events",
  {
    auditId: id("audit_id").primaryKey().autoincrement(),
    occurredAt: utc("occurred_at").notNull(),
    actor: varchar("actor", { length: 128 }).notNull(),
    actorUserId: id("actor_user_id"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    // 系统生成的稳定枚举（B-D30），不要求手填说明
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }),
    targetId: varchar("target_id", { length: 64 }),
    batchRef: id("batch_ref"),
    scopeSummary: json("scope_summary"),
    // 关键字段的前后值；不含整行原文、文件内容、密码、令牌、验证码
    detail: json("detail"),
    requestId: varchar("request_id", { length: 64 }),
    idempotencyKey: sha256("idempotency_key"),
  },
  (t) => [
    uniqueIndex("uq_audit_events_idem").on(t.idempotencyKey),
    index("idx_audit_events_time").on(t.occurredAt),
    index("idx_audit_events_actor").on(t.actor, t.occurredAt),
    index("idx_audit_events_target").on(t.targetType, t.targetId),
    index("idx_audit_events_type").on(t.eventType, t.occurredAt),
    check("ck_audit_events_outcome", inList(t.outcome, AUDIT_OUTCOMES)),
  ],
);
