// better-auth 拥有的四张表（ADR-0015、b-access-control design §6.2）。手工维护，形状以库 1.7.18 的实际要求为准。
//   - ID：自增 BIGINT。库在 `generateId: "serial"` 下把 ID 当 JS Number 处理（精确到 2^53−1），
//     所以认证表的 ID 只能由数据库自增：不设 AUTO_INCREMENT 起点，不写入指定 ID（ADR-0015 S1）。
//   - TS 属性名 = 库的字段名（camelCase），列名 = snake_case；不用库的 `fields` 映射（S2）。
//   - 外键 RESTRICT：本项目不物理删除用户；会话由我们显式 DELETE（撤销），不依赖级联。
//   - email 库要求必填且唯一：写入随机合成值 `<UUID>@hbecho.invalid`，不展示、不用于找回（S7）。
//   - phone_number：待激活 / 有效 = 真实号码；停用 = 墓碑值 `disabled:<用户ID>`（S6）。
import { boolean, foreignKey, index, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { id, utc } from "../columns";

export const authUsers = mysqlTable(
  "auth_users",
  {
    id: id("id").primaryKey().autoincrement(),
    name: varchar("name", { length: 100 }).notNull(),
    email: varchar("email", { length: 191 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    phoneNumber: varchar("phone_number", { length: 64 }),
    phoneNumberVerified: boolean("phone_number_verified"),
  },
  (t) => [uniqueIndex("uq_auth_users_email").on(t.email), uniqueIndex("uq_auth_users_phone").on(t.phoneNumber)],
);

export const authSessions = mysqlTable(
  "auth_sessions",
  {
    id: id("id").primaryKey().autoincrement(),
    expiresAt: utc("expires_at").notNull(),
    token: varchar("token", { length: 191 }).notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    userId: id("user_id").notNull(),
  },
  (t) => [
    uniqueIndex("uq_auth_sessions_token").on(t.token),
    index("idx_auth_sessions_user").on(t.userId),
    foreignKey({ name: "fk_auth_sessions_user", columns: [t.userId], foreignColumns: [authUsers.id] }),
  ],
);

export const authAccounts = mysqlTable(
  "auth_accounts",
  {
    id: id("id").primaryKey().autoincrement(),
    accountId: varchar("account_id", { length: 191 }).notNull(),
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    userId: id("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: utc("access_token_expires_at"),
    refreshTokenExpiresAt: utc("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    index("idx_auth_accounts_user").on(t.userId),
    foreignKey({ name: "fk_auth_accounts_user", columns: [t.userId], foreignColumns: [authUsers.id] }),
  ],
);

// 验证码以「<码>:<已输错次数>」明文存在 value 里（ADR-0015 选 A：接受），5 分钟有效；过期行由库在每次查找时顺带删除。
export const authVerifications = mysqlTable(
  "auth_verifications",
  {
    id: id("id").primaryKey().autoincrement(),
    identifier: varchar("identifier", { length: 191 }).notNull(),
    value: varchar("value", { length: 255 }).notNull(),
    expiresAt: utc("expires_at").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [index("idx_auth_verifications_identifier").on(t.identifier)],
);
