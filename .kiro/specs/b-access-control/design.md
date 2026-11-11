# B 访问控制（b-access-control）· 设计

> **状态**：`draft`
>
> **模式**：Design-First
>
> **需求**：[`requirements.md`](requirements.md)
>
> **实施计划**：[`tasks.md`](tasks.md)（仅规划，尚未执行）
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：B 访问控制 · **目录命名**：`b-access-control`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21（`current`）
>
> **替代**：[旧 `access-control/design.md`](../../../HBECHO设计方案/archive/access-control-design-2026-11-04.md)（已归档）；继承与舍弃见 §2.3
>
> **最近核对**：2026-11-06
>
> **更新日期**：2026-11-06

## 1. Overview

本 spec 的最小纵向结果是：

```text
运维一次性令牌 → 首个超管（待激活）→ 短信验证码激活并自设密码
→ 超管邀请 / 批量导入总部、分公司、门店专员（每个创建都过 GrantBoundary）
→ 手机号 + 密码（或短信验证码）登录 → 15 天滑动会话
→ 每个请求：authenticate → AuthContext（角色、Capability、DataScope）
→ 每个动作：authorize(Capability, 资源策略, 资源谓词)；未注册一律拒绝
→ 停用 / 撤权：会话失效、用户任务取消、交付前复查拦住过期产物
→ 全程写持久审计（仅超管可读，保留一年）
```

**三个深模块**（沿用旧设计的划分，接口收窄）：

| 模块 | 对外 | 隐藏 |
|---|---|---|
| `SessionAuthenticator` | `authenticate(request) → AuthContext \| Unauthenticated`；`revokeSessions(userId, except?)` | better-auth 调用、会话读取、`MediaStaff` 懒停用、cookie 细节 |
| `AuthorizationModule` | `authorize(ctx, request) → Decision`；`scopeFor(ctx, resourceKey)`；`registerScopeStrategy` / `registerPredicate` | 角色矩阵、策略注册表、原因码、范围求交 |
| `UserAdministration` | `invite` / `import` / `changeAccess` / `changeStatus` / `forceLogout` / `list`（均带 `actor`） | `GrantBoundary` 双校验、墓碑手机号、会话与审计的同事务写入 |

其余：登录保护与短信（`LoginGuard`、`SmsService`）、审计（`AuditWriter`）、出口框架（`EgressGuard`）、适配器（`toPlanActor` 等）、CLI。

## 2. Authority and Evidence Levels

### 2.1 Decision order

1. [`CONTEXT.md`](../../../CONTEXT.md)；
2. B 域 PRD v1.21（含 B-D01～B-D38）；
3. v2 的组织与专员主档；
4. ADR-0005、ADR-0010、ADR-0013；
5. 已合并 spec 与 `a-activity-plan` 草案的授权接缝；
6. 本 spec。

### 2.2 Evidence labels

| 等级 | 含义 | 本设计中的例子 |
|---|---|---|
| `prd` | B PRD 或已编号决定 | 角色矩阵、5 次 / 15 分钟、15 天滑动、1,000 行、严格下级 |
| `code` | 已合并代码里读到的事实 | 三个 `ActorContext` 的字段；`media_staff` 的 `active_phone`；审计回调只写 pino；`package.json` 没有 Next / better-auth |
| `library` | 来自 better-auth 官方文档的描述，**尚未在本仓库验证** | 任务 1 之后只剩尚未被用例覆盖的描述（例如 `next build` 下 Route Handler 的行为，留任务 12） |
| `proposal` | 本 spec 的建议，**待评审** | 墓碑手机号、`access_users` 扩展表、审计表触发器 |

标 `library` 的行为在任务 1 用真实库版本、真实 MySQL 8.4 测试库验证后才转为事实（§6.5）。**2026-11-10 任务 1 已验证 S1–S9**，版本精确锁定为 better-auth **1.7.18**；已验证的行为转为 `code`，结论与库外要补的五处见 [ADR-0015](../../../HBECHO设计方案/architecture/adr/0015-auth-boundary-and-disabled-phone.md)（accepted，2026-11-10）。**没有被测试覆盖的 `library` 描述保持原标签**：例如 `drizzle-kit generate` 生成结果与手写 `auth.ts` 的逐列一致性，留到任务 2 用真实 schema 核对。

### 2.3 对旧 `access-control/design.md` 的继承与舍弃

旧设计是 2026-11-04 的技术草案，PRD 随后又定了 B-D01～B-D38。取舍如下：

| 旧设计内容 | 处理 | 理由 |
|---|---|---|
| 三个深模块（认证、授权、用户管理）与 `MasterDataDirectory` seam | **继承**（接口收窄，§1、§4） | 划分合理，调用方不接触 Token、角色、组织 JOIN |
| `fail closed`、「未注册 ScopeStrategy 拒绝」 | **继承** | 与 P-R14 一致 |
| 语义 `DataScope`，由资源 Adapter 解释，不返回 SQL | **继承**（§7.4） | 授权模块不该拼 SQL；所有者模块各自翻译 |
| current / proposed 双校验、`GrantBoundary` | **继承并缩减**（§7.6） | PRD 只有三维（角色 ∩ 组织 ∩ 品牌）；去掉「Capability 集」「有效期上限」维度 |
| 异步任务 `EffectiveTaskScope = Submitted ∩ Current`、交付前复查 | **继承**（§7.13） | 与 B §10.2 一致 |
| 追加写审计、事件字段 | **继承并落成持久表**（§6.1、§7.14） | PRD 要求持久、一年、仅超管可读 |
| `Grant` / `RoleProfile` 表与「授权版本」缓存键 | **舍弃** | PRD 是单角色、固定矩阵、无个人覆盖、无缓存；角色到 Capability 是代码常量 |
| Access / Refresh token family、重用检测、Cookie + CSRF 自建 | **舍弃** | PRD 要的是 15 天滑动会话，认证交给 better-auth（ADR-0005）；撤销靠会话表 |
| 外部 / 试点用户的 Grant 有效期 | **舍弃** | PRD 无此需求（待激活不设有效期，B-D04） |
| 手机号等敏感字段的独立 Capability 与脱敏 | **舍弃** | B v1.4：手机号随行可见，不单设字段级许可；D-42 明文 |
| `AttributionSnapshot` 由哪个域拥有 | **舍弃** | D-18 / ADR-0008 已定：历史归属在 `content_discoveries` 的快照列，B 不拥有它 |
| 「User ↔ MediaStaff 是否一对一」等 8 项 P0 未决 | **已全部由 PRD 关闭** | 见旧设计附录 |
| `dealer_staff` 角色名 | **舍弃** | D-22：`store_staff` |
| 观测清单（登录成功率、授权拒绝原因等） | **缩减**：只保留审计里已有的 `reason_code` 与告警事件；指标看板归 I 域 | 避免 B 自建监控 |

## 3. Goals and Non-goals

### 3.1 Goals

1. 真实用户能用手机号登录；停用、改密、强制下线后会话立即失效；
2. 29 项 Capability 与四类角色矩阵和 PRD 逐行一致，并有唯一注册表与唯一授权入口；
3. DataScope 是「组织 ∩ 品牌」的语义对象，每个资源显式注册策略，未注册、无法解释一律拒绝；
4. 用户管理不能把权限授出超过自己，读写同源；
5. 现有两套 actor 接口（sync 共用 tracer 的）与三个进程内审计回调能接到同一个身份与同一张审计表，且不改它们的行为；
6. 出口的守卫、复查和有效范围有可复用的框架与契约测试；
7. 默认测试全离线，真实库、真实 MySQL、假短信。

### 3.2 Non-goals

页面与管理类 HTTP 接口、SSO / MFA / 动态角色 / 个人覆盖、真实短信发送与签名模板申请、各业务资源的 `ScopeStrategy`（除四个）、各出口的业务实现、配置中心、手机号改绑。详见 requirements §1.5.2。

## 4. Ownership and Deep Modules

目录（ADR-0013）：

```text
src/modules/access-control/
  index.ts                 对外导出（唯一入口）
  config.ts                环境变量解析（zod；缺项启动失败）
  roles.ts                 RoleCode、等级、Capability 注册表、角色矩阵（常量）
  authorize.ts             authorize / 决策与原因码 / 谓词注册
  scope.ts                 DataScope 构建、交集、ScopeStrategy 注册表
  authenticate.ts          authenticate、MediaStaff 懒停用
  auth-instance.ts         better-auth 实例装配（钩子、SMS 接入、会话参数）
  login-guard.ts           账号锁定
  sms.ts                   SmsService 与 SmsSender 端口、假发送器
  users/                   invite / change / status / list / import / bootstrap / restore
  linkage.ts               MediaStaff 联动的定时补偿
  egress.ts                出口守卫、交付前复查、有效范围、JobCanceller
  audit.ts                 AuditWriter、适配器、清理
  adapters.ts              toPlanActor / toMasterDataActor / toTracerActor
  service-principals.ts    服务身份常量与白名单
src/modules/phone/         手机号规范化（单一来源；见 AX-D18）
src/app/api/auth/[...all]/route.ts   better-auth 处理器
src/app/api/health/route.ts
src/db/schema/auth.ts      better-auth 表（手工维护，形状以库为准）
src/db/schema/access.ts    本项目授权表
src/worker/access-cli.ts / access-main.ts
```

模块边界：`src/app` 只调用 `src/modules/access-control` 的导出；`access-control` 之外的模块**只**通过 `index.ts` 引用它，且只引用 `authorize`、`scopeFor`、类型与注册函数——不引用角色常量。

## 5. End-to-end flows

### 5.1 请求

```text
Request ──▶ authenticate(request)
              ├ better-auth.getSession(headers)            无会话 → Unauthenticated(401)
              ├ 读 access_users + 品牌/分公司集合（+ store_staff 的 media_staff 状态）
              ├ status ≠ active                           → Unauthenticated(401)
              ├ store_staff 且 media_staff 已停用          → 懒停用(同事务：状态、撤销会话、墓碑、审计) → 401
              └ AuthContext{actor, role, capabilities, scope}
        ──▶ authorize(ctx, {capability, resource?: {key, ref?}})
              ├ capability 未注册                          → deny(capability_unknown)
              ├ 角色未持有                                  → deny(capability_not_granted)   403
              ├ resource 无策略                             → deny(scope_unregistered)       403
              ├ 策略解释失败 / ID 无法映射                    → deny(scope_not_resolvable)  403 + 质量问题
              ├ 资源谓词不成立                               → deny(predicate_failed)
              └ 对象不在范围                                 → notFound
```

### 5.2 激活与登录

```text
管理者 invite → access_users(pending_activation) + auth_users(登录手机号=真实号, 未验证) ；不发短信
用户 请求验证码 → SmsService.request(phone, purpose)
      校验：规范化 → 用户存在且 pending/active？否 → 返回成功样式但 suppressed
            60 秒 / 每日 10 条 / 全局上限 → 拒绝(限频) 或 暂停
      通过 → better-auth 生成 OTP → sendOTP 回调 → SmsSender.send
用户 提交验证码+新密码 → better-auth 「验证码重置密码」路径 → 建 credential
      钩子：若 access_users.status=pending → 置 active、activated_at、审计 user_activated；
            撤销该用户其他会话；LoginGuard.clear(phone)
登录(密码) → LoginGuard.check(phone) → better-auth 密码登录 → 失败则 LoginGuard.fail(phone)
登录(验证码) → 不过 LoginGuard
```

### 5.3 停用与联动

```text
disable(user) 事务：
   access_users.status=disabled(+status_before_disable, reason)
   auth_users.登录手机号 ← 墓碑值
   DELETE auth_sessions WHERE user_id
   audit(user_disabled …)   ← 同事务
   提交后：JobCanceller.cancelAll(userActor)    ← 失败写告警，不回滚（各域任务自带过期）
restore(user)  事务：重校验 → 手机号唯一（status 回到 pending/active 触发 UQ(active_phone)）→ 写回登录手机号 → 审计
```

## 6. Data model

约定沿用 `src/db/columns.ts`：signed BIGINT、API 十进制字符串；时间 UTC `DATETIME(6)`；状态 `VARCHAR + CHECK`；业务表无 `ON DELETE CASCADE`；约束命名 `uq_/idx_/ck_/fk_<表缩写>_<含义>`。**B 域的表以本节为准，不写入 v2。**

### 6.1 自有表

**`access_users`**（`User` 的授权扩展，1:1 对应 better-auth 的 user 行）

| 列 | 说明 |
|---|---|
| `user_id BIGINT PK` | = 认证表的用户 ID（FK → `auth_users.id`，RESTRICT） |
| `role_code VARCHAR(32) NOT NULL` | `platform_admin` / `hq_manager` / `branch_manager` / `store_staff`（CHECK）；一个用户恰好一个 |
| `display_name VARCHAR(100) NOT NULL` | |
| `phone VARCHAR(32) NOT NULL` | 规范化后的**原号**，明文（D-42），永久保存，包括停用后 |
| `status VARCHAR(24) NOT NULL` | `pending_activation` / `active` / `disabled`（CHECK） |
| `active_phone VARCHAR(32) GENERATED STORED` | `CASE WHEN status IN ('pending_activation','active') THEN phone END`；`UQ(active_phone)` 保证手机号唯一只约束「待激活 + 有效」（B-D05），与 `media_staff.active_phone` 同一做法 |
| `status_before_disable VARCHAR(24) NULL` | 停用时记录，恢复时回到该状态 |
| `disabled_at`、`disabled_by_actor`、`disabled_reason VARCHAR(48)`、`auto_disabled_staff_id BIGINT NULL` | `disabled_reason ∈ manual / media_staff_disabled`；后者记录触发它的专员，供条件恢复使用（B-D11） |
| `media_staff_id BIGINT NULL` | FK → `media_staff`（RESTRICT）；仅 `store_staff` 可填（CHECK）。`active_media_staff` 生成列（状态非 disabled 时等于它）+ `UQ`，保证「一对一」 |
| `activated_at`、`created_by_actor VARCHAR(128) NOT NULL`、`created_by_user_id BIGINT NULL` | 创建者规范主体；用户 ID 在创建者是真实用户时回填 |
| `created_at`、`updated_at` | |

`CHECK ((status='disabled') = (disabled_at IS NOT NULL))`；`IDX(role_code, status)`。

**`access_user_brands(user_id, brand_id)`**、**`access_user_branches(user_id, branch_id)`**：主键即两列；FK 均 RESTRICT。`platform_admin` 与 `hq_manager` 的分公司集合为空表示「全部」（语义由角色决定，不靠空集）；`store_staff` 的品牌 / 分公司**不存**，范围由专员所在门店推出（避免与门店的品牌 / 板块变更产生第二份真相）。

**`access_login_failures`**：`phone_norm VARCHAR(32) PK`、`fail_count INT NOT NULL`、`locked_until DATETIME(6) NULL`、`updated_at`。不论手机号是否对应用户都记（§1.4 第 6 项）。

**`access_sms_sends`**：`send_id BIGINT PK`、`phone_norm`、`purpose IN ('activate','login','reset')`、`requested_at`、`outcome IN ('sent','suppressed','failed','rate_limited')`、`provider_ref VARCHAR(64) NULL`；`IDX(phone_norm, requested_at)`、`IDX(requested_at, outcome)`。每日全局上限只数 `sent`；每手机号的 60 秒 / 10 条按 `sent`、`suppressed`、`failed` 三种结果计数（`suppressed` 计入，使存在与不存在的号码表现一致），**不计 `rate_limited`**——否则用户每 30 秒重试一次会不断续期，60 秒窗口永远不会过期。验证码本身不入此表。保留 35 天后由 `access maintain` 清理。

**`access_bootstrap_tokens`**：`token_id PK`、`token_sha256 BINARY(32) UQ`、`created_by_actor`、`created_at`、`expires_at`（默认 24 小时）、`consumed_at NULL`、`consumed_user_id BIGINT NULL`。

**`audit_events`**（追加写）

| 列 | 说明 |
|---|---|
| `audit_id BIGINT PK`、`occurred_at DATETIME(6)` | |
| `actor VARCHAR(128)`、`actor_user_id BIGINT NULL` | 规范主体字符串 |
| `event_type VARCHAR(64)`、`outcome IN ('succeeded','denied','failed')`、`reason_code VARCHAR(64) NOT NULL` | `reason_code` 由系统生成的稳定枚举 |
| `target_type VARCHAR(32) NULL`、`target_id VARCHAR(64) NULL`、`batch_ref BIGINT NULL` | |
| `scope_summary JSON NULL`、`detail JSON NULL` | 关键字段的前后值；**不含**整行原文、文件内容、密码、令牌、验证码 |
| `request_id VARCHAR(64) NULL`、`idempotency_key BINARY(32) NULL` | `UQ(idempotency_key)` 去重 |

无外键（审计是证据，不应被主档约束牵连）。索引：`(occurred_at)`、`(actor, occurred_at)`、`(target_type, target_id)`、`(event_type, occurred_at)`。**不可变**由手写迁移里的触发器强制：`BEFORE UPDATE` 一律 `SIGNAL`；`BEFORE DELETE` 仅当 `OLD.occurred_at < UTC_TIMESTAMP(6) - INTERVAL 365 DAY` 才放行（到期清理），否则 `SIGNAL`。drizzle-kit 不支持触发器，用 `generate --custom`（ADR-0005 已知坑 7 的验证结论）。

### 6.2 better-auth 的表

四张认证表（`user`、`session`、`account`、`verification`）用 `modelName` / 字段映射命名为 `auth_users`、`auth_sessions`、`auth_accounts`、`auth_verifications`；手机号插件在用户表上增加 `phone_number`、`phone_number_verified`。形状以库的实际要求为准，**手工维护** `src/db/schema/auth.ts`。任务 1 已验证：不用库的 `fields` 映射，TS 属性名取库的字段名、列名用 snake_case，`modelName` 改为 `auth_*` 后适配器的 `schema` 以新模型名为键（§6.5 S2）；库自带的 schema 一致性检查在缺表时会告警，任务 2 的迁移与手写 schema 一致由 `drizzle-kit generate` 无新文件保证。

- 认证表 ID 要求 BIGINT 自增（R7）；做不到则停下；
- 库要求用户表有必填的 `email`：本项目不使用邮箱登录，写入不可路由的**随机**合成值（`<UUID>@hbecho.invalid`，不能由手机号或 ID 推导，见 §6.5 S7），**不对外展示、不用于找回**；库不允许为空（任务 1 实测）；
- 登录手机号列：待激活 / 有效时 = 真实号码；停用时 = 墓碑值（§7.9）；
- 不使用库的 admin、organization、api-key 等插件。

### 6.3 对既有表的修改

| 表 | 修改 |
|---|---|
| `import_batches` | `IMPORT_KINDS` 增加 `user_import`（CHECK 放宽）；其余列不变。`brand_scope` 存操作者范围快照 |
| `import_row_results` | 不变；用户导入的 `raw_row` 保存 6 列原文，`reason_code` 沿用 snake_case |
| `data_quality_issues` | 不变；用户相关问题 `entity_type='user'`、`entity_id`=用户 ID（要求 BIGINT，见 R7） |

### 6.4 状态

```text
用户：pending_activation → active ⇄ disabled ；pending_activation ⇄ disabled
      （停用前是什么，恢复回到什么；待激活不会自动过期）
会话：由 better-auth 管理；删除行即撤销
批次（user_import）：prechecking → awaiting_confirm → writing → completed ；precheck_failed
```

### 6.5 库兼容性验证清单（任务 1 的出口条件）

验证于 2026-11-10，better-auth 1.7.18 + MySQL 8.4 + Node 24，`src/modules/access-control/__spike__/` 38 个用例全部通过（随 `pnpm test:db` 运行，作为库升级回归）。「结论」列的证据等级为 `code`；详细行为与理由见 [ADR-0015](../../../HBECHO设计方案/architecture/adr/0015-auth-boundary-and-disabled-phone.md)。

| # | 要验证的事 | 结论 | 采用的做法 / 备选的代价 |
|---|---|---|---|
| S1 | Drizzle 适配器 + MySQL 8.4 下用户 / 会话 ID 为自增 BIGINT，并在 JS 里以字符串往返 | **通过，有天花板** | `advanced.database.generateId: "serial"`；库对外给出十进制字符串。库内部按 JS `Number` 处理，精确到 2^53−1；自增起点抬到 2^53 以上时 `createUser` 陷入内存耗尽死循环（实测）。**认证表 ID 只能由数据库自增，不设起点、不写指定 ID** |
| S2 | 表名 / 列名映射能落到 `auth_*` 与 snake_case，且 `drizzle-kit generate` 与手工 schema 一致 | **通过**（前半）；一致性核对留任务 2 | 不用库的 `fields`：TS 属性名取库字段名，列名用 snake_case；`modelName` 改为 `auth_*` 后 `schema` 对象须以新模型名为键 |
| S3 | 手机号插件的端点与可配置项 | **通过，有 5 处要补** | 密码登录、发送 / 验证 OTP、验证码重置密码（无凭据自动建凭据）、`allowedAttempts` / `expiresIn` / `otpLength` 均可用；`sendOTP` 拿明文码；`revokeSessionsOnPasswordReset` 同事务撤销会话。库外要补的见 ADR-0015「五处」。**验证码在 `verification` 里是明文**（`<码>:<次数>`，5 分钟，过期行由库在每次查找时顺带删除），刘学奎选 A：接受（2026-11-10） |
| S4 | 在钩子上插入锁定检查、发送前资格校验、激活后置 active | **通过** | 全局 `hooks.before / after` 足够：before 可抛错或用 `ctx.json` 直接返回成功样式而不执行端点；after 用 `ctx.context.returned instanceof APIError` 区分成败。**不需要 Route Handler 包装层** |
| S5 | 会话 15 天 / 每日至多刷新一次 / 无 cookie 缓存 / 删行即撤销 / `api.getSession` 可在 Route Handler 外调用 | **通过** | `expiresIn = 15 天`、`updateAge = 1 天`、`cookieCache` 关闭。24 小时内不写库，距上次刷新满 24 小时后首次读刷新回 15 天（滚动 24 小时，不是自然日零点） |
| S6 | 墓碑值 | **通过，有 1 处缺口** | 改写后旧用户无法登录 / 收码，原号可新建，恢复冲突报 1062。缺口：库的 `phoneNumberValidator` 只覆盖 `sign-in` 与 `send-otp`，墓碑值可到达 `request-password-reset` / `verify` / `reset-password`。用全局 `hooks.before` 统一校验 `cn-mobile.v1`（实测关闭缺口） |
| S7 | 必填 `email` | **通过** | 合成值，**必须随机**（`<UUID>@hbecho.invalid`）。不能由手机号或 ID 推导：手机号推导会让停用后同号新建用户撞邮箱唯一键（实测）。§6.2 原写的 `u<ID>@hbecho.invalid` 因 ID 在插入前未知而改为随机值 |
| S8 | Route Handler 可在 vitest 里直接调用 | **通过，有 1 处必须显式配置** | `auth.handler(new Request())` 与 `toNextJsHandler(auth)` 都不需要 `next`。库在 `NODE_ENV=test` 时默认关闭来源 / CSRF 检查，**认证实例必须显式 `advanced.disableOriginCheck: false` 并配 `trustedOrigins`**，测试也用同一配置 |
| S9 | 库请求级限流可启用且不影响账号锁定 | **通过，有 1 处要调** | 按「IP + 路径」计数，同一手机号换 IP 不被限，所以账号锁定仍自建。插件自带 `/phone-number*` 每 60 秒 10 次，公司 NAT 出口会被误伤，用 `rateLimit.customRules` 调高（实测生效）。洪水兜底仍交给 Nginx |

## 7. Algorithms

### 7.1 Capability 注册表与角色矩阵

注册表是一份常量 `CAPABILITIES`（29 项）加 `ROLE_CAPABILITIES`。单元测试对照一份由 PRD §7.3 转写的 fixture，增删改任一项即失败。下表是权威转写（`A`=全部品牌 × 全部组织；`B`=授权品牌 × 全部组织；`R`=授权品牌 × 授权分公司；`S`=本人；`H`=授权品牌（总部），`—`=无）。

| Capability | `platform_admin` | `hq_manager` | `branch_manager` | `store_staff` | 备注 |
|---|---|---|---|---|---|
| `data.account.read` | A | B | R | S | 外部监控账号只给超管（B-D22） |
| `data.account.manage` | A | B | R | — | 含质量问题处置、疑似空账号确认 |
| `data.monitoring.manage` | A | B | R | — | 经销商级仅超管（资源谓词 `monitoring_level`） |
| `data.content.read` | A | B | R | S | |
| `data.media.read` | A | B | R | S | 继承源对象范围 |
| `data.sync.trigger` | A | B | R | — | |
| `data.raw_payload.read` | A | — | — | — | |
| `data.master_data.import` | A | B | — | — | 越品牌行被拒 |
| `data.master_data.correct` | A | B | — | — | 含专员停用 / 恢复 |
| `data.master_data.structure` | A | — | — | — | |
| `monitor.external.manage` | A | — | — | — | |
| `activity_plan.create` | A | B | — | — | 创建者谓词 |
| `activity_plan.join` | A | B | R | — | 总部为授权品牌（B-D20） |
| `data.export` | A | B | R | — | 三次范围校验 |
| `report.read` | A | B | R | S | |
| `report.export` | A | B | R | — | |
| `rule.definition.read` | A | H | H | — | 范围 = 所属活动计划 ∩ 规则适用品牌（B-D21）；分公司只读 |
| `rule.definition.manage` | A | H | — | — | |
| `rule.run.execute` | A | H | — | — | |
| `metric.catalog.read` | A | ✓ | ✓ | — | 无范围维度 |
| `metric.catalog.manage` | A | ✓ | — | — | |
| `learning.read` | A | ✓ | ✓ | ✓ | 品牌（含全部品牌课程）× 人员级别（B-D23、B-D35） |
| `learning.manage` | A | ✓ | — | — | 含「全部品牌」课程 |
| `learning.report.read` | A | B | — | — | |
| `learning.tag.manage` | A | — | — | — | |
| `ai.content.assist` | A | ✓ | — | — | 1.0 不开放分公司 / 门店（B-D36） |
| `user.manage` | A | B | R | — | 角色 ∩ 组织 ∩ 品牌；严格下级（B-D02） |
| `audit.read` | A | — | — | — | |
| `config.manage` | A | — | — | — | |

「✓」表示持有该 Capability、无品牌 / 组织范围维度（或范围由资源自己的策略表达）。本表只决定**能不能做这类动作**；对象能不能碰由 §7.5 的策略与 §7.3 的谓词决定。

### 7.2 `authenticate`

```text
authenticate(request):
  sess = auth.api.getSession({headers})           # S5：不读 cookie 缓存
  if !sess → Unauthenticated('no_session')
  u = SELECT access_users + brands + branches WHERE user_id = sess.user.id
  if !u or u.status != 'active' → Unauthenticated('user_not_active')
  if u.role_code = 'store_staff':
       s = SELECT media_staff WHERE staff_id = u.media_staff_id
       if !s or s.status != 'active' → lazyDisable(u, s)   # 同事务：禁用、撤销会话、墓碑、审计 media_staff_disabled
                                       → Unauthenticated('media_staff_disabled')
  scope = buildDataScope(u, s)                     # §7.4
  return { actor:'user:'+id, userId, role, capabilities: ROLE_CAPABILITIES[role], scope, sessionId }
```

- 一次请求至多 2 次读库（授权行 + 专员行），**不跨请求缓存**（B-D33）；
- 「角色或范围变更不撤销现有会话」：因为每次都重新读，变更立即对下一次请求生效；
- 懒停用与定时补偿（§7.10）幂等，二者竞争时后到者发现已停用即返回。

### 7.3 `authorize`

```ts
type Decision =
  | { ok: true }
  | { ok: false; kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'unavailable';
      reason: 'user_not_active' | 'capability_unknown' | 'capability_not_granted'
            | 'scope_unregistered' | 'scope_not_resolvable' | 'predicate_failed' | 'out_of_scope'
            | 'service_principal_forbidden' };
authorize(ctx, { capability, resource?: { key: string; ref?: unknown } }): Promise<Decision>
```

顺序：`capability` 在注册表 → `ctx.capabilities` 含它 → 若有 `resource`：取已注册策略（无则 `scope_unregistered`）→ `strategy.contains(ctx.scope, ref)`（解释失败 / 无法映射 → `scope_not_resolvable` 并写质量问题）→ 已注册谓词（`predicate_failed`）。`out_of_scope` 对外表现为 `not_found`。

- 谓词注册：`registerPredicate(name, fn(ctx, ref) → boolean)`；B 登记名字清单：`plan_creator`、`plan_branch`、`object_status`、`monitoring_level`（经销商级仅超管）。谓词体由资源所属域提供（`a-activity-plan` 的创建者判断迁到 `plan_creator`）；
- 超管没有旁路：`authorize` 对超管一样先查注册表与矩阵，只是矩阵里所有格子都是 `A`；
- 服务身份：`authorize` 识别 `service:*` 主体并只认 `SERVICE_CAPABILITIES` 白名单（§7.11 之外的 Capability → `service_principal_forbidden`）。

### 7.4 DataScope

```ts
interface DataScope {
  brands: ReadonlySet<bigint> | 'all';       // 品牌 ID
  branches: ReadonlySet<bigint> | 'all';     // 分公司 ID
  self: { mediaStaffId: bigint; storeId: bigint } | null;   // store_staff
  level: 1 | 2 | 3;                          // 人员级别（B-D23）
}
```

| 角色 | brands | branches | self | level |
|---|---|---|---|---|
| `platform_admin` | all | all | null | 3 |
| `hq_manager` | `access_user_brands` | all | null | 3 |
| `branch_manager` | `access_user_brands` | `access_user_branches` | null | 2 |
| `store_staff` | {专员所在门店的品牌} | {门店所属分公司（经板块）} | 绑定的专员 | 1 |

- 品牌与组织**求交**：`contains` 同时要求品牌 ∈ `brands` 且（门店及以下）分公司 ∈ `branches`；大区、分公司、板块、经销商是全品牌对象，只做组织判断，不做品牌判断（ADR-0010、B-D24）；
- 空集合法：`brands` 为空集 → 任何带品牌的对象都不在范围，返回空结果；
- `store_staff` 的 `self` 解析失败（无绑定、专员已停用、多条）→ 构建 `Unresolved`，所有 `S` 类请求拒绝，不回退（§AX-7）；
- 范围构建经 `OrgDirectory` 读取端口（旧设计 `MasterDataDirectory` seam 的缩小版，默认实现读组织表）。授权明细表对品牌 / 分公司 / 专员有 RESTRICT 外键，所以「引用的行不存在」在数据层不会发生；PRD 的「无法映射」在运行时表现为端口报告 unresolvable（主数据不可用、引用被判为不可解析等），**测试用端口的故障注入构造**，不靠关外键；
- 引用无法映射 → `scope_not_resolvable`（403 + 质量问题 `access_scope_not_resolvable`）；**停用**不算（B-D25）；
- 交集运算 `intersect(a, b)`：集合取交，`all` 吸收，`self` 相同保留否则空（§7.13）；
- `fingerprint(scope)`：规范化 JSON 的 sha256，用于任务快照与交付复查的比较。

### 7.5 `ScopeStrategy` 注册表

```ts
interface ScopeStrategy<Ref> {
  /** 该范围是否覆盖这个对象；解释失败抛 ScopeUnresolvable */
  contains(scope: DataScope, ref: Ref): Promise<boolean>;
  /** 返回资源域自己能翻译成过滤条件的语义约束（B 不拼 SQL） */
  constraint(scope: DataScope): ResourceConstraint;
}
registerScopeStrategy(key: ResourceKey, s: ScopeStrategy<unknown>): void   // 重复注册失败
scopeFor(ctx, key): ResourceConstraint                                      // 未注册 → ScopeUnregistered
```

- 资源键按 PRD §8.2：`account`、`content`、`media`、`external_account`、`report`、`rule_config`、`metric_config`、`user`、`raw_payload`、`learning_course`、`activity_plan`、`judgement_plan`、`audit_log`、`notification`；
- **B 自带四个**：`user`（§7.6）、`audit_log`（仅 `platform_admin`）、`external_account`（仅 `platform_admin`）、`raw_payload`（仅 `platform_admin`）；
- 其余由所属域在自己的 spec 里注册。**注册前这些资源对非超管请求被拒**——这是有意的 fail closed，不是缺陷；超管同样要有已注册的策略才能读取（无旁路），所以未注册时超管也被拒；
- 删除一个已注册策略后同一请求必须失败（测试）。

### 7.6 管理范围与 `GrantBoundary`

等级：`platform_admin`=4 > `hq_manager`=3 > `branch_manager`=2 > `store_staff`=1。

```text
manages(actor, target):             # 读写同源：列表、详情、修改、停用、恢复、强制下线都只用它
  if target.id = actor.id → false   # 自己可见(只读)，不可管理
  if actor.role = platform_admin → true            # 含其他超管
  if rank(target.role) >= rank(actor.role) → false # 严格下级
  if !(brandsOf(target) ⊆ actor.brands) → false
  if actor.role = branch_manager and !(branchesOf(target) ⊆ actor.branches) → false
  true
# brandsOf/branchesOf(store_staff) 由其门店推出；hq 的分公司为 all，只可能被超管管理

canGrant(actor, proposed{role, brandIds, branchIds, staff?}):
  rank(proposed.role) < rank(actor.role) 或 actor 是超管且 proposed 可为任意角色
  且 proposed.brandIds ⊆ actor.brands
  且 (proposed.role = branch_manager → proposed.branchIds ⊆ actor.branches 且 非空)
  且 (proposed.role = store_staff → 门店 ∈ actor 的品牌与分公司范围)
  且 角色与集合形状合法（hq 无分公司集合；admin 两者皆空；staff 两者皆空）
```

变更流程：`current`：`manages(actor, target)`；`proposed`：`canGrant(actor, proposed)`；两个都通过才在一个事务里写用户行、集合与审计，否则整个拒绝、零写入。批量逐行判断，越权进跳过清单。列表查询 = `list.filter(manages ∨ self)`，实现为一条 SQL（集合运算在数据库里做），并有「列表集合 = 可操作集合 ∪ 自己」的等价测试。

**创建与变更时的集合形状**（AX-D29，2026-11-10 刘学奎确认）：`hq_manager` 的品牌集合**必须非空**且不带分公司集合；`branch_manager` 的品牌集合与分公司集合都**必须非空**；`platform_admin` 与 `store_staff` 的两个集合都为空（`store_staff` 的范围由其门店推出）。这只约束**创建与变更**；已有用户被收窄到空集合（例如恢复时去掉了无法映射的项）仍是合法空范围，读取得到空结果而不是全量（AX-7）。

**最后一个超管**：停用 / 降级超管的事务先 `SELECT … FOR UPDATE` 锁住所有未停用超管行，再判断剩余数量 ≥ 1；超管不能停用自己（`manages` 已排除自己）。

### 7.7 登录锁定 `LoginGuard`

```text
check(phone):  row = access_login_failures[phone]
               if row.locked_until > now → 拒绝（响应与密码错误同形）
fail(phone):   事务内 upsert：若 locked_until 已过 → 先清零；fail_count+1；
               若 fail_count >= 5 → locked_until = now + 15min
success(phone) / resetPassword(phone): fail_count=0, locked_until=NULL
```

- 计数键是规范化手机号，不论是否存在用户；
- **「连续」按字面实现**：成功或重置才清零，锁定期满也清零；没有滑动时间窗口（PRD 无，§14 第 9 项）；
- 仅密码登录端点经过它；短信验证码登录不经过；
- 并发：upsert 用 `INSERT … ON DUPLICATE KEY UPDATE`，计数在单语句内递增。

### 7.8 短信规则 `SmsService`

```text
request(phone, purpose):
  p = normalizePhone(phone)                 # 无效 → 与成功同样的响应（不暴露）
  # 窗口只数 outcome ∈ {sent, suppressed, failed}；rate_limited 本身不续期
  if 该号码 60 秒内已有上述结果的请求 → 记 rate_limited，返回「请稍后再试」
  if 该号码今日上述结果的请求数 ≥ 10 → 记 rate_limited
  （通过限频后才写入本次请求，outcome 由后续步骤确定）
  eligible = access_users WHERE phone=p AND status IN (pending_activation, active) AND (purpose=activate → pending；reset/login → active 或 pending 视 purpose)
  if !eligible → outcome=suppressed；返回成功样式
  if 今日全局 sent ≥ HBECHO_SMS_DAILY_CAP → 告警事件 sms_daily_cap_reached；outcome=rate_limited；返回「暂不可用」
  否则交给 better-auth 生成 OTP 并经 sendOTP 回调 → SmsSender.send；outcome=sent|failed
```

- OTP 有效期 5 分钟、6 位、连续输错 5 次作废由 better-auth 的 `expiresIn` / `allowedAttempts` / `otpLength` 配置（S3）；
- `purpose`：待激活用户只能 `activate`；有效用户可 `login`、`reset`；
- 全局上限读 I 域的配置（本阶段 = 环境变量 `HBECHO_SMS_DAILY_CAP`，无缺省）；
- 生产必须显式设置 `HBECHO_SMS_MODE=aliyun`；缺失启动失败；`fake` 仅在测试环境允许；
- 阿里云发送器使用官方短信 SDK（ADR-0005 的 `@alicloud/*` 范围）；具体包与版本在任务 5 登记到 ADR-0005 的采用清单；
- 验证码明文只存在于 better-auth 的 `verification` 与发送器调用里；审计、日志不记录。

### 7.9 手机号唯一与墓碑值

- 授权表 `access_users.phone` 永久保存原号；`UQ(active_phone)` 保证「待激活 + 有效」内唯一；
- 认证表登录手机号：创建时 = 原号；`disable` 事务内改写为 `~disabled~<user_id>`（以不可能是合法手机号的前缀开头；若库对该列有格式校验则按 S6 的备选）；`restore` 事务内先把 `access_users.status` 改回非停用（触发 `UQ(active_phone)`，同号冲突在此被数据库拒绝），再写回原号；
- 验证码发送 / 登录按手机号查找的永远是认证表这一列，所以**停用用户既不能登录，也不会收到验证码**（`SmsService` 的资格校验同样用 `access_users.status`）；
- 一致性不变式（测试 + `access maintain` 检查）：每个非停用用户的认证表登录手机号 = `access_users.phone`；停用用户的 = 墓碑值。

### 7.10 `MediaStaff` 联动

- **懒执行**（§7.2）：`authenticate` 发现专员停用 → 禁用用户、撤销会话、墓碑、审计 `media_staff_disabled`（actor = `service:access-worker`）、`disabled_reason='media_staff_disabled'`、`auto_disabled_staff_id`；
- **定时补偿**（`access maintain` 的步骤 1）：对所有非停用的 `store_staff` 用户，专员已停用 → 同样停用。覆盖「从未登录」的用户；
- **条件恢复**（步骤 2）：`disabled_reason='media_staff_disabled'` 且 `auto_disabled_staff_id` 对应专员已恢复有效 → 复核手机号唯一后恢复；同号已有「待激活 + 有效」用户 → 保持停用，写质量问题 `user_auto_restore_blocked_phone_in_use`；**人工停用的不恢复**；
- **增长型表的清理（步骤 4）**：`access_sms_sends` 保留 35 天（足够数日统计与争议）；`access_login_failures` 删除 `fail_count=0` 且 7 天未更新的行，以及 `fail_count<5`、未锁定且 90 天未更新的陈旧计数（这是对「连续」的唯一时间边界，用来约束随机手机号造成的无限增长；§14 第 13 项）；`access_bootstrap_tokens` 删除已用或过期超过 30 天的行。随机手机号请求写入的行因此有上界。
- **绑定失效**：恢复用户（人工）时若专员已停用（`media_staff_id` 有外键，专员行不会消失），用户为有效但 `self` 解析失败 → 本人范围请求被拒（B-D08）；
- 步骤 3 为审计到期清理（§7.14）。步骤 4 清理增长型表（见下）。四步各自 try/catch，幂等，北京时间 04:30 后每天一次（沿用 `maintenance.ts` 的 `runDaily` 写法，但**独立实现，不依赖 OSS**）。

### 7.11 服务身份

```ts
SERVICE_PRINCIPALS = {
  'service:sync-worker':   ['data.sync.trigger'],                 // 周期同步、按需采集、媒资归档
  'service:plan-worker':   ['activity_plan.join', 'data.sync.trigger'],  // 名单解析驱动、每日维护；批次完成时对已存在账号发起 supplement（a-full-sync 的 `requireCap` 需要 data.sync.trigger），范围限于名单内账号
  'service:access-worker': [],                                     // 补偿与审计清理：只调内部函数，不经 authorize
}
```

- 白名单是常量；**永不包含**：`data.raw_payload.read`、`data.export`、`report.export`、`user.manage`、`audit.read`、`config.manage`、`data.master_data.structure`（测试枚举断言）；
- 用户触发任务继承提交者的 `AuthContext.actor`，不用服务身份；
- 现有环境变量声明的 CLI 身份（`HBECHO_MD_*`、`HBECHO_AP_*`、`HBECHO_ACTOR_*`）仍是 `service:<声明名>`，范围不超过其声明。

### 7.12 首个超管与用户批量导入

**首个超管**：

```text
access token create        # 需要 DB 凭证；生成 32 字节随机令牌，仅打印一次，存 sha256 + 24h 过期
access bootstrap-superadmin --token <t> --phone <p> --name <n>
   事务：令牌存在、未过期、未用 → 当前不存在未停用超管 → 建 auth_users + access_users(platform_admin, pending_activation)
         → 令牌 consumed → 审计 bootstrap_superadmin
```

两条路径任一失败零写入。超管随后自己走短信激活。

**用户批量导入**（`import_kind='user_import'`，沿用 `a-master-data-import` 的批次、行结果、租约、回流写法与 `csv-file` 模块）：

| 步骤 | 内容 |
|---|---|
| 文件级 | 大小 ≤ 10 MB；数据行 ≤ 1,000；编码；CSV 严格；表头逐列等于 `姓名,角色,手机号,品牌,分公司,门店编码`；任一失败不建批次 |
| 预检逐行 | 必填；角色名 → `RoleCode`；手机号规范化；`canGrant`（严格下级、品牌 ⊆、分公司 ⊆）；`store_staff` 经「手机号 + 门店编码」定位唯一有效专员（`staff_not_found` / `staff_inactive` / `store_not_in_scope`）；非 `branch_manager` 不得填分公司、`store_staff` / `platform_admin` / `hq_manager` 不得填品牌分公司之外的无关列（`scope_fields_not_allowed`）；手机号已被「待激活 + 有效」占用（`phone_exists`）；文件内手机号重复整组报错 |
| 分类 | `new` / `error`；越权行 `error` + `role_not_grantable` / `scope_exceeds_boundary`，进跳过清单，**不让整批失败** |
| 确认 | 同步；**重新校验全部行**；每行走与单个邀请相同的创建函数（含审计）；`outcome` 与创建同一事务；遇唯一键冲突（并发先建了同号）记 `conflict` |
| 回流 | 同格式 + 结果 / 原因 / 指引；提交人本人下载；记审计 `user_import_returnfile_downloaded` |

### 7.13 出口框架

```ts
guardExit(exit: 1..10, ctx, req): Promise<Decision>             // 动作权限 + 范围
snapshotForJob(ctx, capability): { submittedScopeFingerprint, submittedScope }
effectiveScope(submitted: DataScope, ctx): DataScope            // = intersect(submitted, 当前 ctx.scope)
recheckDelivery(artifact, ctx): Promise<'deliver'|'deny'|'rebuild'>   // artifact.scopeFingerprint 对比当前范围
registerJobCanceller(name, fn: (userActor) => Promise<number>)
cancelUserJobs(userActor): Promise<{byName: Record<string, number>}>
```

- 守卫只做通用部分；出口特有规则（导出格式、签名 URL）在所属域；
- `recheckDelivery`：产物范围 ⊆ 当前范围 → `deliver`；不⊆但可重建 → `rebuild`；否则 `deny`；
- 提交与交付两头都查，执行时用 `effectiveScope`；范围为空 → 取消并写审计 `delivery_scope_shrunk`；
- `cancelUserJobs` 在停用与撤权事务**提交之后**调用；任一 canceller 失败写告警，不回滚（各域任务自带过期与交付复查兜底，二者缺一不可）；
- 契约测试用 fake 出口跑 10 个出口 × 三个检查点。

### 7.14 审计

```ts
interface AuditWriter {
  write(e: AuditEvent, opts: { tx?: DbTx; risk: 'high' | 'low' }): Promise<void>;
}
```

- `risk='high'`：必须传 `tx`，与业务写入同一事务，失败则整体失败；`risk='low'`：尽力写入，失败记 pino 与计数；
- `reason_code` 目录（稳定枚举，节选）：`invalid_password`、`account_locked`、`sms_rate_limited`、`sms_daily_cap_reached`、`otp_invalid`、`otp_attempts_exceeded`、`user_activated`、`user_created`、`user_import_confirmed`、`user_disabled_manual`、`media_staff_disabled`、`user_restored`、`access_changed`、`role_not_grantable`、`scope_exceeds_boundary`、`capability_not_granted`、`scope_unregistered`、`scope_not_resolvable`、`session_revoked`、`force_logout`、`password_changed`、`password_reset`、`delivery_scope_shrunk`、`job_cancelled_on_revoke`、`bootstrap_superadmin`、`audit_purged`；
- **适配器**：`fromTracerAudit`、`fromSyncAudit`、`fromMasterDataAudit`、`fromPlanAudit` 把各自事件映射到 `audit_events`（`actor` 取规范主体；`reason_code` 取事件里已有的稳定码，缺失时用 `<event_type>.<outcome>`）；它们作为各模块 `AuditSink` 的**新实现**在装配处替换 `createLogAudit`，同时仍写 pino；低风险，尽力写入；
- 幂等键：`sha256(event_type | actor | target | occurred_at 到秒 | detail 摘要)`；
- 到期清理：`audit.purgeOlderThan(365 天)` 分批 `DELETE`（触发器放行），结束后以 `service:access-worker` 写 `audit_purged`（含删除条数与截止时间）；
- 读取：`audit.read` 限超管；`audit list` 命令与将来的页面共用；
- **日志卫生**：序列化前过滤键名 `password`、`token`、`cookie`、`otp`、`code`、`secret`；测试对全部事件夹具做字符串扫描。

## 8. Failure semantics

| 场景 | 行为 |
|---|---|
| 无会话 / 会话已撤销 | 401；不进入业务模块 |
| 用户非 `active` | 401（`user_not_active`）；不续期 |
| 专员已停用 | 懒停用 + 401；事务内完成 |
| Capability 未注册 / 未持有 | 403，原因码稳定；审计 `denied`（低风险，尽力） |
| 资源策略未注册 | 403（`scope_unregistered`）；启动与测试均可枚举 |
| ID 无法映射 / 主数据不可用 | 403 + 质量问题；**不回退空列表、不回退全量** |
| 合法空范围 | 空结果，不是错误 |
| 对象不在范围 | 对外「未找到」 |
| proposed 超出边界 | 整个变更拒绝，零写入 |
| 并发变更同一用户 | 以目标用户行 `FOR UPDATE` 串行化；后者基于新状态重新校验 |
| 高风险审计写入失败 | 整体回滚 |
| 低风险审计写入失败 | 业务继续，pino + 计数 |
| 短信发送失败 | `access_sms_sends.outcome=failed`；向用户返回「暂时无法发送，请稍后重试」；不泄露内部错误；计入 60 秒限频，不计入全局 `sent` |
| 全局短信上限达到 | 短信类请求「暂不可用」+ 告警；密码登录不受影响 |
| `cancelUserJobs` 部分失败 | 告警 + 审计；会话已失效，任务靠交付前复查兜底 |
| 墓碑改写失败 | 整个停用事务回滚（用户仍有效），因为「停用后不可登录」是安全属性 |
| 令牌过期 / 已用 | 首个超管创建拒绝，零写入 |
| better-auth 库升级改变行为 | 任务 1 的兼容性测试保留为回归测试（`__spike__` 转为常规测试） |

**不吞错**：任何路径不把「认证库异常」当成「未登录」静默放行；认证库不可用时 `authenticate` 返回 503 样式的 `unavailable`，业务拒绝而不是放行。

## 9. Authorization seam to other modules

### 9.1 适配器

```ts
toPlanActor(ctx): PlanActor | Unadaptable            // a-activity-plan
toMasterDataActor(ctx): MdActor | Unadaptable        // a-master-data-import
toTracerActor(ctx): TracerActor | Unadaptable        // tracer / sync：仅全范围
```

| 适配 | 映射 |
|---|---|
| `PlanActor` | `actor`=`user:<id>`；`capabilities`；`brandScope`=品牌编码集合或 `all`；`branchScope`=分公司 ID 集合或 `all`；`platformAdmin`=角色是超管 |
| `MdActor` | `actor`；`capabilities`；`brandScope` |
| `TracerActor` | 仅当 `scope.brands='all'` 且 `scope.branches='all'` 且非 `self`：`scope:{platformCodes:'all', mediaStaffIds:'all'}`；否则 `Unadaptable('partial_scope_not_supported')` |

契约测试把四类角色的输出对照各模块已有的断言期望（fixture）。`a-activity-plan` 在 B 之后才实现，所以 `toPlanActor` / `fromPlanAudit` 在 B 里面向**结构类型**（`PlanActorShape`、`PlanAuditEvent` 的字段清单，取自 A design §9 与 AP-14）编写并用 fixture 验证，**不 import A 的模块**；A 落地后由 A 的任务补一条引用 B 适配器的契约测试。

### 9.2 回填

`created_by_user_id` / `uploaded_by_user_id` / `confirmed_by_user_id` / `resolved_by_user_id` 的回填入口：`userIdOf(actor: string): bigint | null`（`user:<id>` → ID，`service:*` → null）。各模块写入时调用，**从不对历史行造假用户**。

### 9.3 CLI

```text
access token create | bootstrap-superadmin
access user invite | list | show | change | disable | restore | force-logout   [--apply]
access user import precheck | confirm | batches | batch | rows | report
access audit list
access maintain
```

输出 JSON；BIGINT 十进制字符串；退出码 0 / 2 / 3 / 4 / 5 / 1（对齐 master-data）；`parseArgs` strict；**所有写命令**（invite / change / disable / restore / force-logout / 导入确认）不带 `--apply` 只预览，库里无变化。~~身份来自环境变量：`HBECHO_ACCESS_ACTOR`、`HBECHO_ACCESS_CAPABILITIES`、`HBECHO_ACCESS_BRAND_SCOPE`、`HBECHO_ACCESS_BRANCH_SCOPE`、`HBECHO_ACCESS_ROLE`，缺任一启动失败。~~（由 AX-D32 于 2026-11-10 修订）身份只有一个环境变量 `HBECHO_ACCESS_ACTOR=user:<id>`（必须是有效用户），角色、能力与范围一律从数据库现算；需要身份的命令缺它启动失败；`token create` / `bootstrap-superadmin` / `maintain` 只需要数据库凭证。CLI 内部同样构造 `AuthContext`，经 `authorize` / `manages` / `canGrant`，**没有旁路**。

## 10. 对既有代码与依赖的改动

| 位置 | 改动 |
|---|---|
| `package.json` | 增加 `better-auth`、`next`、`react`、`react-dom`（ADR-0005 已登记）；短信官方 SDK（ADR-0005 `@alicloud/*` 范围，具体包任务 5 登记）；`"access": "tsx src/worker/access-main.ts"` |
| `src/db/schema/` | 新增 `auth.ts`、`access.ts`；`import.ts` 的 `IMPORT_KINDS` 增加 `user_import`；迁移 `drizzle/NNNN_access_control_*.sql`（含手写触发器迁移） |
| `src/modules/phone/` | 新增手机号规范化的单一来源；`a-activity-plan` 的 `roster/phone.ts` 改为引用它（该 spec 同步修订，见 AX-D18） |
| 三个已有审计装配处 | 在 `sync-main`、`master-data-main`、`tracer-cli` 的装配里，把 `createLogAudit` 换成「日志 + 持久」的组合实现；业务模块代码不变 |
| `src/worker/sync-wiring.ts` | `extras` 增加 `accessMaintain`（与 `a-activity-plan` 的 `planMaintain` 并列） |
| 静态护栏 | `acceptance-boundaries.test.ts`：① 业务模块出现 `platform_admin` 等四个角色字面量比较失败（`access-control` 内除外）；② Capability 字符串必须属于注册表；③ `access-control` 的 `*.db.test.ts` 纳入 `Promise.all` 扫描；④ `src/app` 内无 SQL / `db.insert`；⑤ 全仓库无 `adminAc` / `set-password` / `impersonate` |
| ADR-0005 | 已知坑 5 订正为 B-D14 口径（R2）；任务 5 把短信官方包登记到采用清单；任务 1 之后新增 ADR-0015 |
| `tsconfig.json` | 如 `src/app` 引入 JSX / Next 类型需要调整，只放宽 `include` 到 `src/app` 且不改变其他目录的选项；任务 2 评估，必要时只把无页面的 Route Handler 保持为 `.ts`（不引入 JSX） |

### 10.1 部署要求（Web 进程）

内部站点，要求很少，但下面三条缺一就有明确后果：

1. `HBECHO_TRUSTED_PROXIES` 设为 Nginx 所在地址（生产必填，缺则启动失败）；
2. Nginx 的 `/api/auth/` 反代配置里写 `proxy_set_header X-Forwarded-For $remote_addr;`（**覆盖**，不用 `proxy_add_x_forwarded_for`）。配置的唯一来源是仓库 `deploy/nginx/`（ADR-0006），该目录建立时照此写；
3. 后果：不配 1，库取不到可信 IP，所有请求落进同一个共享限流桶（一个人刷满，所有人一起 429）；配了 1 但 2 用了追加，客户端可伪造 IP 绕开限流。限流只是洪水兜底，账号锁定按手机号计数，不依赖 IP。

## 11. Testing strategy

| 层 | 内容 |
|---|---|
| `unit` | 手机号规范化；角色矩阵对照 PRD fixture；`manages` / `canGrant` 真值表；`intersect`；锁定窗口；用户导入模板解析与行分类；`composeDecision`；日志脱敏过滤 |
| `db`（真实 MySQL + 真实 better-auth） | 登录 / 激活 / 重置 / 锁定 / 撤销全流程；会话滑动（`FakeClock`）；短信规则；用户创建 / 停用 / 恢复 / 墓碑 / 最后一个超管；专员联动（懒 + 补偿 + 条件恢复）；`authorize` 全部原因码；策略注册表；用户导入两阶段；审计（含触发器：UPDATE 被拒、未到期 DELETE 被拒、到期 DELETE 放行）；出口契约；适配器契约 |
| Route Handler | 用 `new Request()` 直接调用 `POST`/`GET`，断言 `Set-Cookie`、状态码与响应体（S8） |
| 静态 | §10 的五条护栏；`drizzle-kit generate` 无新文件 |
| 离线 | `network-deny` 沿用；`FakeSms`；`FakeClock` |

- **并发**不用 `Promise.all`：持锁者停在 hook，竞争者随后启动并必须阻塞，再放行（超管互停、同号并发创建、抢锁定计数）；
- 任务 1 的 `__spike__` 测试保留为回归，防止库升级悄悄改行为；
- 测试造数需要 `insertUser`（授权 + 认证两行）、`loginAs`（直接用库创建会话 cookie）、`fakeSms`；补进 `tests/harness/`；
- 规模：1,000 行用户导入预检 / 确认的耗时进入 §12。

## 12. Explicit non-goals and known limits

- 页面与管理 HTTP 接口不在本轮；
- 登录锁定按字面「连续失败」，没有时间窗口，长期零星失败会累计到 5 次（PRD 如此，§14 第 9 项）；
- 懒停用只在该用户发起请求时触发，补偿每天一次，所以专员停用到 `User` 停用最长约一天（B-D10 的设计，会话在懒停用后立即失效）；
- 非全范围主体调用 tracer / sync 的按范围命令不被适配器放行（§AX-11）；
- 各资源的策略未注册前，非超管（实际上包括超管）请求这些资源被拒；
- `owner` 类的责任标记不是权限（B-D18），与本 spec 无关；
- 审计触发器依赖 MySQL 触发器权限；部署账号需要 `TRIGGER`，由运维手册登记；
- better-auth 的 `verification` 表保存验证码，**任务 1 实测为明文**（`<码>:<次数>`，5 分钟，过期行由库在每次验证码查找时顺带删除）；刘学奎已选 A：接受（2026-11-10，ADR-0015）；
- 短信签名与模板已申请（2026-11-06），名称与编码待提供、CLI 无权限复核；真实发送仍需批准，生产启用时间不由本 spec 决定；
- 规模（2026-11-10，本机一次性 MySQL 8.4 容器，`import.perf.db.test.ts`）：1,000 行用户导入（700 行总部人员 + 300 行经销商人员，每行都要定位专员 / 校验）预检 **约 0.4 秒**，确认写入 **约 3.2 秒**（每行一个事务），测试进程 RSS 约 250 MB；预检把 1,000 行一次载入内存，没有分块（上限 1,000 行，所以不需要）；
- 用户列表一次载入全部「严格下级 ∪ 自己」再在内存里用 `manages` 精筛，只适合几千用户的量级（门店专员 3,500+ 在此量级内）；超过约 2 万用户要改成 SQL 里直接做集合包含判断（`admin.ts` 里有 `ponytail:` 注释，等价性有测试）。

## 13. Decision records

状态列：`proposed` = 本 spec 建议；`prd` = 上游已定。**2026-11-06 刘学奎已确认全部 `proposed` 与「待确认」项按建议采纳**。

| 编号 | 决定 | 理由 | 状态 |
|---|---|---|---|
| AX-D01 | B 域的表放在本 spec，不写入 v2 | v2 是数据底座基线；B 的表不属于它 | proposed |
| AX-D02 | better-auth 的 user 就是 `User`；授权数据放 1:1 扩展表；不建 Grant / RoleProfile | ADR-0005「两者不得各建一套 User」；PRD 单角色、固定矩阵、无个人覆盖 | proposed |
| AX-D03 | 停用用户的认证表登录手机号改写为墓碑值，原号存授权表 | 让「登录只匹配非停用记录」由数据结构保证；对库的唯一列最小侵入 | 任务 1 已验证（2026-11-10，§6.5 S6）；ADR-0015 accepted |
| AX-D04 | 认证表 ID 必须是 BIGINT；做不到则停下 | 技术基线；`data_quality_issues.entity_id` 等处是 BIGINT | 任务 1 已验证通过（2026-11-10，§6.5 S1）；天花板与「ID 只能自增」规则见 ADR-0015 |
| AX-D05 | 登录失败按规范化手机号计数，不论用户是否存在；按字面「连续」 | 不暴露账号存在；PRD 无窗口 | proposed |
| AX-D06 | 高风险审计同事务、低风险尽力 | 旧设计把它留作「可配置」；这里给默认 | proposed |
| AX-D07 | 服务身份是常量白名单，永不含高敏 Capability | B §10.3；防止 Worker 成为旁路 | prd + proposed |
| AX-D08 | `AuthContext` 每请求构建，不跨请求缓存 | B-D33：变更下次请求即生效；撤销即时 | prd |
| AX-D09 | `ScopeStrategy` 由资源所属域注册；B 只带四个；未注册即拒绝（含超管） | P-R14；超管无旁路 | prd + proposed |
| AX-D10 | Capability 单一注册表 + 静态护栏 | P-R12；防止字符串漂移 | proposed |
| AX-D11 | Web 入口只建无页面骨架；管理能力走 Module + CLI | `ui-foundation` §3；页面须确认 | proposed |
| AX-D12 | 用户批量导入复用 `import_batches` / `import_row_results`，`import_kind='user_import'` | tech 基线：不建平行批次表 | proposed |
| AX-D13 | 到 tracer / sync 的适配只放行全范围主体 | `requireFullScope` 的既有「宁可拒绝」 | proposed |
| AX-D14 | 现有三类审计经适配器落库，不改调用方 | 不重写已合并代码 | proposed |
| AX-D15 | 审计不可变用触发器强制，到期 DELETE 放行 | 数据库层守护「不可覆盖」；到期清理仍可执行 | proposed |
| AX-D16 | 激活走「验证码重置密码」同一路径 | ADR-0005 已知坑 4 | prd（ADR） |
| AX-D17 | 用户列表可见自己但不可管理自己 | B-D02 | prd |
| AX-D18 | 手机号规范化单一来源 `src/modules/phone/`；`a-activity-plan` 引用它 | 两个 spec 各自定义了同一规则；一份实现、一处修订 | proposed |
| AX-D19 | 补偿、增长型表清理与审计清理放进 `access maintain`，独立于 OSS，由 worker `extras` 调度 | 与 `a-activity-plan` 的 AP-D15 同一理由 | proposed |
| AX-D22 | 短信 60 秒 / 每日计数不计 `rate_limited`；增长型表有保留期 | 防止限频自我续期；防止随机手机号无限写表 | proposed |
| AX-D23 | 审计 `reason_code` 与事件名跟 PRD 示例对齐：`media_staff_disabled`、`scope_not_resolvable`、`invalid_password` | PRD 已给示例，不另起一套 | prd |
| AX-D24 | `service:plan-worker` 白名单含 `data.sync.trigger` | `a-activity-plan` 批次完成时发起 supplement，`requireCap` 需要它 | proposed |
| AX-D25 | 范围构建经 `OrgDirectory` 端口，保留 RESTRICT 外键；「无法映射」用端口故障注入测试 | 数据完整性优先；不靠关外键构造用例 | proposed |
| AX-D20 | 关闭会话 cookie 缓存 | 撤销必须即时 | proposed（待 S5 验证） |
| AX-D21 | 激活不发短信（创建时），由用户自己请求验证码 | PRD §4.2 | prd |
| AX-D26 | 限流阈值来自配置 `HBECHO_AUTH_RATE_LIMIT_PER_MIN`：**缺省生产 300、非生产 60** 次 / 分钟 / IP / 认证路径；库的全局默认规则为其 2 倍。**都是「每个 IP 每条路径」，不是全局**。「每天」的短信上限按北京时间自然日 | 阈值不在代码里静默冻结；公司 NAT 出口上班高峰多人同时登录，生产放宽；挡暴力破解靠按手机号锁定，不靠它 | 已确认（刘学奎，2026-11-10） |
| AX-D27 | 生产必须配置 `HBECHO_TRUSTED_PROXIES`（Nginx 地址 / CIDR），且 Nginx 用 `proxy_set_header X-Forwarded-For $remote_addr;` **覆盖**客户端自带的头 | 库取不到可信 IP 时所有请求落进同一个 per-path 共享桶（一个人刷满，所有人一起 429）；实测配置受信代理后伪造前缀换不到新桶。限流存储保留库默认的进程内存储（单 Web 进程，重启清零，只作洪水兜底） | 已确认（刘学奎，2026-11-10：内部站点，实现简单所以做；配置项 + 部署要求，不另写运行手册） |
| AX-D28 | 登录失败审计只为**已存在**的用户写；不存在的号码只进 `access_login_failures`（有清理），不写审计 | 否则随机号码可无限写审计表（保留一年、手机号明文） | 已确认（刘学奎，2026-11-10）；PRD v1.21.4 澄清记录 |
| AX-D29 | 创建与变更 `hq_manager` / `branch_manager` 时品牌集合必须非空，`branch_manager` 的分公司集合必须非空；已有的空范围用户（授权被收窄到空）仍是合法空范围 | 空集合授权没有业务意义且是误操作；与 AX-7 的「合法空范围」不冲突（那是读取侧） | 已确认（刘学奎，2026-11-10） |
| AX-D30 | 专员联动的「人工恢复豁免」用**标记列**，不用 `updated_at` 比较 | 监控开关会刷新 `media_staff.updated_at`（`monitoring/set-switch.ts`），不能当作停用信号；懒停用跳过有标记的用户，恢复时写、改绑时清 | 已确认（刘学奎，2026-11-10）；任务 7 前实现，迁移尚未推送所以现在加列成本低 |
| AX-D31 | 短信 `admit` 按号码加库锁（`GET_LOCK`，与事务同一连接，提交后放锁）并先写预占行，deliver 失败再改 failed | 不加锁时 8 个并发请求有多个通过 60 秒窗口、各发一条短信（实测）；加锁后 5/5 次稳定只通过 1 个 | 已实现 |
| AX-D32 | CLI 身份：只认 `HBECHO_ACCESS_ACTOR=user:<id>`，角色 / 能力 / 范围从数据库现算（取代设计原文的 5 个环境变量） | 原设计让操作者在环境变量里自己声明角色与范围，等于「说自己是超管就是超管」；从库里现算后，CLI 的权限不可能超过该真实用户，且与页面入口同一条路径（`contextForUser`） | **待刘学奎确认**（实现已按此做；改回去只需让 `context()` 读环境变量，但会引入「自称超管」的风险） |
| AX-D33 | 撤权取消：`changeAccess` 在「降级、或拿掉原有品牌 / 分公司」提交后也触发 `onRevoked`（晋升不触发）；出口守卫的审计是低风险、不在业务事务里 | PRD B-D28 写的是「停用或撤权」，设计原文只写了停用；守卫没有事务可传，所以出口 6 的审计写失败不会阻止访问 | **待刘学奎确认**后一半（是否要求原始载荷访问「审计写失败即拒绝」） |

### B-D 对照

| B-D | 落点 | B-D | 落点 |
|---|---|---|---|
| B-D01 单角色 | AX-6、§6.1 CHECK | B-D20 hq 范围 | §7.1 |
| B-D02 严格下级 | §7.6 | B-D21 判定计划读取 | §7.1 备注 |
| B-D03 无大区级 | §7.4 | B-D22 外部账号仅超管 | §7.5 |
| B-D04 待激活无有效期 | AX-2 | B-D23 人员级别 | §7.4 |
| B-D05 手机号唯一 | §6.1、§7.9 | B-D24 求交 | §7.4 |
| B-D06 激活前改号 | AX-2 | B-D25 停用不影响读范围 | §7.4 |
| B-D07 手机号 + 门店编码 | AX-2、§7.12 | B-D26 无法映射 403 | §7.4、§8 |
| B-D08 绑定失效 | §7.10 | B-D27 通知出口 | §7.13 |
| B-D09 删旧建新 | AX-5 | B-D28 撤权取消任务 | §7.13 |
| B-D10 / B-D11 专员联动 | §7.10 | B-D29 手机号不逐条审计 | §7.14 |
| B-D12 导入 1,000 行 | §7.12 | B-D30 reason_code | §7.14 |
| B-D13 每天至多刷新 | S5 | B-D31 首个超管 | §7.12 |
| B-D14 自建限流 | §7.7、S9 | B-D32 密码 8 位 | AX-1 |
| B-D15 / B-D16 锁定与重置 | §7.7 | B-D33 变更不撤销会话 | §7.2 |
| B-D17 资源谓词 | §7.3 | B-D34 批量导入与 structure | 不在本 spec（A） |
| B-D18 / B-D19 负责人与 join | `a-activity-plan` | B-D35 学习 | §7.1 |
| B-D36 AI 范围 | §7.1 | B-D37 / B-D38 短信 | §7.8 |

## 14. Open items

**2026-11-06 刘学奎：待裁决项全部按本 spec 的建议采纳**（含标「待确认」的各项）。下表保留原问题与采纳的写法，作为记录；之后要改某项，走修订并保留原行。

| # | 问题 | 本 spec 当前写法 | 影响 |
|---:|---|---|---|
| 1 | 短信签名与模板；真实发送的批准 | **签名与模板已由刘学奎在阿里云申请完成（2026-11-06 告知）**；本机 `hbecho-setup` profile 没有 `dysms:QuerySmsSignList` / `QuerySmsTemplateList` 权限，无法由 CLI 复核，签名名称与模板编码待刘学奎提供后写入部署配置（任务 5 实现为 6 个变量：`HBECHO_SMS_ACCESS_KEY_ID`、`HBECHO_SMS_ACCESS_KEY_SECRET`、`HBECHO_SMS_SIGN_NAME`、`HBECHO_SMS_TEMPLATE_ACTIVATE`、`HBECHO_SMS_TEMPLATE_LOGIN`、`HBECHO_SMS_TEMPLATE_RESET`；前两个是密钥，其余非密钥；仅 `HBECHO_SMS_MODE=aliyun` 时必填；键名清单见仓库 `.env.example`）。**2026-11-10 刘学奎提供阿里云控制台截图，读到的三个已审核通过的验证码模板**：`hbecho登陆` = `SMS_512115917` → `HBECHO_SMS_TEMPLATE_LOGIN`；`hbecho修改密码` = `SMS_512090911` → `HBECHO_SMS_TEMPLATE_RESET`；`hbecho应用注册` = `SMS_512035897` → `HBECHO_SMS_TEMPLATE_ACTIVATE`（模板编码不是密钥）。**2026-11-10 刘学奎又提供了签名与模板详情截图，已确认**：① 签名名称是 **`青岛海信博世`**（签名来源「企事业单位名」，关联资质「青岛海信博世空调营销股份有限公司」，场景为企业内部用户在自建应用中接收验证码）；② 三个模板正文的验证码变量名**都是 `${code}`**，与代码一致；③ 三个模板的变量类型：登录、注册为「仅数字」，修改密码为「数字+字母组合或仅字母」，我们发的是 6 位纯数字，三者都满足；模板限制「仅限发送 4–6 位数字验证码」，我们正好 6 位；④ 登录模板正文写「该验证码 5 分钟内有效」，与我们的有效期 300 秒一致。**仍待确认**：签名状态显示「可用·异常」、运营商报备结果为「已报备待验证」，截图没有说明含义，首次真实发送前请在控制台点开「详情」确认不影响送达。**授权方式参照 hbdam**（`/Users/liuxuekui/Documents/hbdam`，只读）：同一个官方 SDK `@alicloud/dysmsapi20170525`，短信用**专用的显式 AccessKey**（`ALIYUN_SMS_ACCESS_KEY_ID/SECRET`），不走 ECS 的实例 RAM 角色，也不复用 OSS 的密钥；接入点固定 `dysmsapi.aliyuncs.com`；生产不允许 mock；发送不自动重试（避免已发出却超时的情况重复发、重复计费）；区分运维类错误码（余额、签名、模板、日限额）并告警。本设计已采用后三点。应用的 AccessKey 请你自己配到服务器 `.env`（**不要发给我**）；自动验收仍全用假发送器；真实 smoke 另行批准（固定条数、显式开关）；应用运行用的 RAM 账号需授予 `dysms:SendSms` | 生产启用 |
| 2 | 任务 1 库兼容性验证结果（尤其 S1 BIGINT ID、S3/S4 钩子、S6 墓碑） | 通过前不写迁移；S1 不通过则停下报告 | 全部实现 |
| 3 | Next.js 骨架做到什么程度、`next build` 是否进 `verify.sh` | 只建无页面的 Route Handler；`next build` 作为一次性环境项，不进 `verify.sh` | 工程 |
| 4 | 页面何时开工 | 本轮无页面；进入条件：UI 基线定稿 ∧ ui-lab 原型走查 ∧ §15.6 填写确认 | 页面任务 |
| 5 | 用户导入模板 `user-import.v1` 的列与取值 | 6 列；角色用中文名，品牌用名称，分公司用编码（requirements §1.4 第 10 项） | AX-3 |
| 6 | 审计写入失败的 fail-closed 分级 | 高风险同事务、低风险尽力（AX-D06） | AX-10 |
| 7 | tracer / sync 适配只放行全范围 | AX-D13；非全范围的按范围命令留给各自的 UI spec | AX-11 |
| 8 | 各业务资源的 `ScopeStrategy` 谁、何时注册 | 各域 spec 在落地时注册；此前非超管（及超管）被拒 | 其他 spec 的验收 |
| 9 | 登录失败「连续」是否加时间窗口 | 按字面不加（AX-D05）；仅对陈旧计数设 90 天清理边界（第 13 项） | AX-4 |
| 10 | 手机号规范化规则与 B 的用户手机号规则是否同一条 | 同一条 `cn-mobile.v1`，单一来源（AX-D18）；`a-activity-plan` 同步引用 | 两个 spec |
| 11 | `access_users` 不存 `store_staff` 的品牌 / 分公司，而是从专员所在门店推出 | 避免第二份真相；代价是门店换板块会立即改变该用户的范围 | AX-7 |
| 12 | 超管数量上限与最后超管保护的运维流程 | 只保证不能停到 0；超管增删由超管自己做 | AX-5 |
| 13 | 陈旧失败计数的清理边界 | `fail_count<5` 且 90 天未更新的行被清理（等价于 90 天的隐含时间窗口），用来约束增长；不改 5 次 / 15 分钟的锁定语义 | AX-4 |
| 14 | 用户导入文件大小上限 10 MB | 实现默认值，**参照 F-D12**，不是 B-D12（B-D12 只规定 1,000 行） | AX-3 |
| 15 | A 的适配器如何在 A 未实现时交付 | B 内定义结构类型 `PlanActorShape` 与审计事件形状并用 fixture 契约测试；A 落地后由 A 的任务补一条引用 B 适配器的契约测试 | AX-11 |

## 15. 界面

> **已确认（2026-11-10，刘学奎）。** 页面清单、流程、状态与可见性经 v2 原型确认；页面任务 P1–P5 已于 2026-11-11 在分支 `b-access-ui` 实施（见 tasks「页面任务」）。确认记录见 §15.6；视觉以 `ui-foundation.md`（2026-11-10 版）为准。本节与 `ui-foundation.md` §3 的页面地图一致。

### 15.1 页面清单

| 页面 | 角色 | 入口 | 主要操作 | 对应 Capability |
|---|---|---|---|---|
| 登录 | 所有人（未登录） | 站点首页 | 手机号 + 密码，或手机号 + 短信验证码 | — |
| 激活 | 待激活用户 | 登录页「首次登录」 | 输入手机号 → 收验证码 → 设置密码（至少 8 位） | — |
| 忘记密码 | 有效用户 | 登录页 | 手机号 → 验证码 → 新密码（成功即解锁） | — |
| 修改密码 | 已登录用户 | 账户菜单 | 旧密码 → 新密码；其他会话失效 | — |
| 用户列表 | 超管、总部、分公司 | 一级导航「用户与权限」 | 筛选（角色 → 状态 → 品牌 → 分公司）、新建、批量导入、批量停用待激活用户、进入详情 | `user.manage` |
| 新建用户 | 同上 | 列表主按钮 | 姓名、角色（仅可选严格低于自己的）、手机号、品牌、分公司；`store_staff` 另填门店编码并预览定位到的专员 | `user.manage` |
| 批量导入用户 | 同上 | 列表 | 下载模板 → 上传 → 预检报告（新增 / 错误 / 跳过）→ 确认 → 批次详情 → 下载回流文件 | `user.manage` |
| 用户详情 / 编辑 | 同上 | 列表行 | 改姓名、角色、品牌、分公司（`store_staff` 的门店不可改）；停用 / 恢复（弹窗写明影响）；强制下线；待激活期内改手机号 | `user.manage` |
| 审计日志 | 超管 | 导航「系统」 | 按操作者 / 对象 / 事件 / 时间筛选；只读 | `audit.read` |

### 15.2 用户流程

```text
超管（运维引导）→ 激活 → 登录 → 新建总部 / 分公司人员 → 对方激活 → 登录
分公司人员 → 批量导入门店专员（200 行）→ 预检：越权行进跳过清单 → 确认 → 下载回流 → 修改后作为新文件重传
任意用户 → 忘记密码 → 验证码 → 新密码 → 立即可登录
```

### 15.3 线框

**2026-11-08 第一版原型**：[`ui-lab/hbecho-ui/`](../../../ui-lab/hbecho-ui/README.md)。覆盖登录、激活、忘记密码、修改密码、用户列表 / 新建 / 详情 / 停用恢复 / 强制下线、用户批量导入、审计日志。只抄 hbdam 当前 UI 的结构与组件，业务按本 spec。保留作对照。

**2026-11-10 第二版原型（已确认）**：[`ui-lab/hbecho-ui-v2/`](../../../ui-lab/hbecho-ui-v2/README.md)。视觉层重做，审计筛选改为表格上方一行，界面文案去掉内部权限码与 `reason_code`。建议业务按「分公司导入 200 行含 5 个越权行、3 个手机号已存在」走一遍。

### 15.4 状态矩阵

| 页面 | 加载 | 空 | 无权限 | 错误 | 部分成功 | 处理中 | 过期 |
|---|---|---|---|---|---|---|---|
| 登录 | — | — | — | 手机号或密码错误 / 账号已锁定请 15 分钟后再试或用短信登录 / 暂时无法发送验证码 | — | 发送中 60 秒倒计时 | 验证码已过期，重新获取 |
| 激活 | — | — | — | 验证码错误（剩余次数）/ 已作废 | — | — | 验证码 5 分钟过期 |
| 用户列表 | 骨架屏 | 「还没有下级用户」+ 新建 | 「无权访问」页 | 一句人话 + 错误码 + 重试 | — | 批量停用提交后「处理中」 | — |
| 批量导入用户 | — | — | 无 `user.manage` 不显示入口 | 文件级错误展示失败项与样本 | 预检含错误行：仍可确认其余行 | 确认写入同步完成 | 预检结果不过期；确认时重校验 |
| 用户详情 | 骨架屏 | — | 同级 / 上级用户 = 「未找到」 | 同上 | — | — | — |
| 审计日志 | 骨架屏 | 「该时间段无记录」 | 非超管 = 「无权访问」页 | 同上 | — | — | 保留一年，更早的不可查 |

### 15.5 字段可见性

| 字段 | platform_admin | hq_manager | branch_manager | store_staff |
|---|---|---|---|---|
| 用户列表 | 全部 | 严格下级 + 自己 | 严格下级 + 自己 | —（无入口） |
| 手机号（明文） | ✅ | ✅ 列表内的用户 | ✅ 列表内的用户 | 仅本人 |
| 可选角色 | 全部 | 分公司人员、门店专员 | 门店专员 | — |
| 可选品牌 / 分公司 | 全部 | 自己的品牌 | 自己的品牌与分公司 | — |
| 审计日志 | ✅ | ❌ | ❌ | ❌ |
| 验证码、密码、会话令牌 | ❌ 任何页面都不显示 | ❌ | ❌ | ❌ |
| 内部字段名、表名、`reason_code` | ❌ 界面显示人话 + 稳定错误码 | ❌ | ❌ | ❌ |

### 15.6 界面设计确认

| 确认人 | 日期 | 确认的页面范围 | 原型 / 线框链接 | 备注 |
|---|---|---|---|---|
| 刘学奎 | 2026-11-10 | 登录、激活、忘记密码、修改密码、用户列表、新建用户、用户详情 / 编辑、批量导入用户、审计日志 | [`ui-lab/hbecho-ui-v2/`](../../../ui-lab/hbecho-ui-v2/README.md) | 视觉按 `ui-foundation.md` 2026-11-10 版；v1 原型保留为对照。页面任务另行排期 |
