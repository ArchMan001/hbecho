# 域 E · 用户与权限 详细设计

> **文档状态**：`archived`  
> **当前相关设计**：[`access-control/design.md`](../../../.kiro/specs/access-control/design.md)  
> **归档说明**：本文原属另一产品语境，仅作为会话安全、最小权限和最终出口复查等经验输入。  
> **禁止用途**：不得作为 hbecho 的实现合同，不得据此冻结框架、部署、角色、组织或 User↔MediaStaff 模型。

---

**版本 v1.1 · 2026年8月**

> 对应《推广平台+Agent-产品需求文档PRD-v3.md》域 E。
>
> 设计依据三者结合：① 成熟企业平台的身份、会话、RBAC、最小权限与纵深防御实践；② 本项目现状——5,000 注册用户、200 峰值在线、单台北京 8核32G、同源 Web、MySQL 8、无 Redis、现有 demo/治理系统仅有演示级口令；③ 当前产品构想——四角色 + 职位属性、纯品牌数据隔离、JWT 7 天会话、批量导入激活、Agent 与网页共用权限入口。
>
> **本域定位**：回答四个问题——“你是谁”“你能做什么”“你能看到哪些品牌的数据”“你的登录何时失效”。域 E 不决定素材生命周期、不解释业务标签，也不让 AI 参与任何授权判断。

---

## 一、结论先行

### 1.1 总体形态

```
浏览器（同源 HTTPS）
  ├─ __Host-dam_at     15 分钟 Access JWT，HttpOnly
  ├─ __Secure-dam_rt    7 天 Refresh Token，HttpOnly
  └─ dam_csrf           CSRF 双提交值，可由前端读取
          │
          ▼
AuthenticationGate
  1. 验 JWT 签名、iss/aud/exp/kid
  2. 按 sid 查 auth_session
  3. 查 app_user 状态和 auth_version
  4. 加载 role/capabilities/brand_codes/org
  5. 生成服务端 AuthCtx
          │
          ▼
AuthorizationGate
  ├─ requireCapability('material.write')       功能权限
  ├─ visibilityScope(ctx)                      品牌数据权限
  ├─ assertManageableUser(actor, current, proposed) 管人范围
  └─ assertResourceVisible(ctx, resourceId)    出口复查
          │
          ├─ 网页素材接口
          ├─ 预览/下载 URL
          ├─ 打包 estimate/submit/url
          ├─ Agent 工具
          └─ PostgreSQL 向量检索
```

### 1.2 十项核心决定

1. **角色、职位、组织、品牌是四个独立概念。** 角色决定功能，品牌决定数据，组织用于归属与区域看板，职位只用于展示/统计；绝不交叉推导。
2. **一个用户一期只有一个角色、一个主组织、多个品牌。** 不做多角色合并和多组织成员关系，避免权限组合爆炸。
3. **数据权限只看稳定 `brand_code`。** 不看中文品牌名、不看“品牌归属”标签、不看组织、不看职位。
4. **权限默认拒绝。** 非超级管理员没有品牌时得到 `1=0`，不能把空数组解释为“全部品牌”。
5. **Capability 固定、可审计，但一期不做自定义角色 UI。** 四角色矩阵由迁移脚本播种，变更需代码评审与发布。
6. **“JWT 7 天”解释为总会话 7 天，不是单个 Access JWT 有效 7 天。** Access JWT 15 分钟，Refresh/会话绝对期限 7 天。
7. **为支持立即强制下线，每个请求都校验 MySQL 会话。** 这不是纯无状态 JWT；在 200 峰值规模下，一次主键查询成本远低于安全收益，也无需 Redis。
8. **Token 不进 localStorage。** 同源页面使用 Secure + HttpOnly Cookie，并配 SameSite、Origin 检查与 CSRF 双提交。
9. **批量导入生成的是激活码，不是正式密码。** 激活码只展示/导出一次，库中只存摘要；用户首次激活时自行设置密码。
10. **模型永远不能声明身份或扩大权限。** Agent 工具不接收 userId/role/brands 参数，只使用服务端已有 `AuthCtx`。

### 1.3 采纳与拒绝的大厂实践

| 采纳 | 本项目落地 |
|---|---|
| 短 Access + 可撤销 Refresh | Access 15 分钟、会话 7 天、Refresh 轮换与重放检测 |
| 服务端会话权威 | `auth_session` 每请求校验，可立即禁用/强退 |
| RBAC + 数据范围分离 | capability 管“能做什么”，brand scope 管“能看哪些行” |
| 默认拒绝 | 无 capability 拒绝；空品牌 `1=0`；未知角色无权限 |
| 最小 JWT 声明 | JWT 只含 sub/sid/ver/jti，不把 role/brands 当真相 |
| 管理员不能越级授权 | 总部管理员只能管理自己品牌内的分公司/外部用户 |
| Refresh rotation | 每次刷新换新 Token，旧 Token 重放撤销整个会话 |
| 一次性激活/重置 Token | 高熵随机码，摘要存储、过期、次数限制、一次消费 |
| 安全与业务审计分表 | `auth_event_log` 记录登录安全；`audit_log` 记录业务变更 |
| 权限回归门禁 | 五出口品牌越权 100% 通过，否则阻断上线 |

| 明确不做 | 理由 |
|---|---|
| OPA / Casbin / Zanzibar | 四角色 + 一个数据维度，自建小而深的授权模块更可控 |
| 动态自定义角色 | 当前角色已定，开放自定义会显著增加测试矩阵与误配风险 |
| 组织继承品牌权限 | 同一分公司可能负责多品牌；隐式继承难排查、易串权 |
| 职位参与权限 | 已定设计纪律；设计师与经销商权限相同 |
| Redis Session / 黑名单 | 200 峰值，MySQL 主键查询足够；少一个基础设施 |
| 单个 7 天长效 Access JWT | 泄露窗口太长；若不查库也无法强制下线 |
| localStorage Token | XSS 可直接读取并外传，且难以可靠轮换 |
| 一期短信登录、企业 SSO、MFA | PRD 未要求；先把基础身份闭环做对，接口留缝 |
| 给 Python worker 复制用户鉴权 | worker 不接用户请求，只执行 TS 已授权写入的 job |

---

## 二、现状评估：哪些必须淘汰，哪些可以沿用

### 2.1 `sucai-demo` 只能作链路演示

现状：

- 所有人共享一个口令；
- Token 是 `HMAC(secret, 'demo-ok')` 的固定值；
- 无用户、角色、品牌、过期时间、会话或强制下线；
- 前端永久写 `localStorage.demo_token`；
- `/preview-url?key=` 接受任意 OSS key；
- 素材 SQL 没有品牌谓词。

正式版必须整体替换登录和授权，不在其上增加几个字段“渐进改造”。可沿用的只有同源请求、接口封装和业务链路。

### 2.2 治理工作台目前没有真实身份

现状：

- `auth.js` 默认密码 `admin123` 明文在浏览器；
- `sessionStorage.gov_auth=1` 只是前端遮罩；
- FastAPI 后端所有 API 可绕过页面直接调用；
- `gov_governor` 是名单，不是账号；
- 页面可任意切换 governor，写入无法证明真实操作者。

**这比“权限不够细”更严重：当前没有服务端认证。** 平台正式上线前，治理台至少必须接入本域的统一会话门禁，见第十六章。

### 2.3 可沿用的工程条件

- 页面和 API 由同一 HTTPS 域名、Nginx 按路径反代，天然适合 HttpOnly Cookie；
- 正式 API 可统一在 TypeScript 应用认证，Python worker 不暴露给浏览器；
- 域 G 已确定 `AuthCtx`、Repository 强制传上下文、权限 SQL 单一入口和 L0 越权测试；
- 域 B 已按 `capability` 与 `visibilityScope()` 分离管理视图和数据范围；
- 5,000 用户、200 峰值使 MySQL 会话校验、关系型 RBAC 和审计日志完全够用。

---

## 三、域边界与深模块

### 3.1 四个深模块

```ts
interface IdentityDirectory {
  getUser(userId: number): Promise<UserProfile | null>;
  createUser(command: CreateUser, actor: AuthCtx): Promise<UserProfile>;
  updateUser(userId: number, patch: UserPatch, actor: AuthCtx): Promise<UserProfile>;
  disableUser(userId: number, reason: string, actor: AuthCtx): Promise<void>;
  enableUser(userId: number, actor: AuthCtx): Promise<void>;
  softDeleteUser(userId: number, reason: string, actor: AuthCtx): Promise<void>;
  undeleteUser(userId: number, actor: AuthCtx): Promise<void>;
}

interface SessionManager {
  login(command: PasswordLogin, meta: ClientMeta): Promise<LoginResult>;
  refresh(refreshToken: string, meta: ClientMeta): Promise<TokenPair>;
  logout(sessionId: string): Promise<void>;
  revokeUser(userId: number, reason: string, actor: AuthCtx): Promise<void>;
}

interface AuthorizationGate {
  authenticate(request: Request): Promise<AuthCtx>;
  require(ctx: AuthCtx, capability: Capability): void;
  visibilityScope(ctx: AuthCtx, alias?: string): SqlFragment;
  assertCanManageUser(actor: AuthCtx, current: UserGrant | null, proposed: UserGrant): void;
}

interface UserProvisioning {
  previewImport(file: ImportFile, actor: AuthCtx): Promise<ImportPreview>;
  commitImport(batchId: string, actor: AuthCtx): Promise<ImportResult>;
  issueActivation(userId: number, actor: AuthCtx): Promise<OneTimeSecret>;
  activate(command: ActivateAccount): Promise<LoginResult>;
}
```

深度来源：

- `SessionManager` 隐藏密码验证、会话创建、JWT、Refresh 轮换、重放检测和 Cookie 属性；业务调用方不拼 Token。
- `AuthorizationGate` 隐藏角色能力、品牌 SQL、空品牌拒绝和用户管理上下级规则；页面、Agent 和 Repository 只学一个接口。
- `UserProvisioning` 隐藏 Excel 校验、幂等、激活码、冲突报告和批量审计。
- `IdentityDirectory` 是账号真相源；域 F、治理台和管理后台不直接写用户表。

### 3.2 不属于域 E

| 事项 | 所属域 | 域 E 的责任 |
|---|---|---|
| 素材是否发布/过期 | B | 只提供 actor 与品牌范围 |
| Agent 如何理解问题 | D | 提供服务端 AuthCtx，禁止模型改变它 |
| 区域看板指标 | F | 提供 org/region 属性，不决定指标 SQL |
| 日志存储与 trace | G | 写入统一审计接口，定义可信 actor |
| 治理业务流程 | A | 提供门禁和 actor 映射，不解释治理状态 |
| OSS STS 权限 | G/B | E 先校验上传 capability 与品牌，B 再限定对象前缀 |

---

## 四、E1 · 组织模型

### 4.1 为什么组织不等于权限

组织解决“人属于哪里”和“区域看板按哪里聚合”；品牌解决“能看哪些素材”。二者分开能处理这些真实情况：

- 同一分公司同时负责海信、日立；
- 总部管理员只负责一个品牌；
- 外部设计师服务多个品牌；
- 经销商组织归属某区域，但品牌授权后来调整。

如果从组织自动推品牌，任何组织调整都会隐式改变数据权限，难审计也容易泄露。

### 4.2 组织树

一期一个用户只有一个主组织。组织树最多三层，但允许外部合作方由总部直管：

```
Level 1  总部
  ├─ Level 2  分公司/区域
  │    └─ Level 3  经销商/门店/外部设计机构
  └─ Level 2  总部直管外部机构（可选）
```

```sql
CREATE TABLE org_unit (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  code           VARCHAR(64) NOT NULL,
  name           VARCHAR(120) NOT NULL,
  org_type       VARCHAR(32) NOT NULL COMMENT 'headquarters/branch/dealer/store/design_partner/other',
  parent_id      BIGINT NULL,
  level          TINYINT NOT NULL,
  path           VARCHAR(500) NOT NULL COMMENT '/1/23/108/，用于查询祖先与展示',
  region_code    VARCHAR(32) NULL,
  status         ENUM('active','disabled') NOT NULL DEFAULT 'active',
  sort           INT NOT NULL DEFAULT 0,
  created_by     BIGINT NULL,
  updated_by     BIGINT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     DATETIME NULL,
  UNIQUE KEY uq_code (code),
  KEY idx_parent (parent_id, status, sort),
  KEY idx_path (path(255)),
  KEY idx_region (region_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='组织树，仅用于归属和统计';
```

约束：

- `level` 必须等于父级 `level+1`，最大 3；由 `OrgDirectory` 在事务内校验；
- 禁止把组织移动到自己的后代；
- 禁用组织不自动禁用用户，但管理端必须先显示影响人数并二次确认；
- 组织删除为软删除，存在有效用户时拒绝物理清理；
- `path` 是读优化，不是另一份树真相；移动组织时事务性更新自身和后代 path；
- 区域看板取用户组织向上最近的 `org_type='branch'`，没有则记“总部/未分区”。

### 4.3 职位字典

```sql
CREATE TABLE position_dict (
  code       VARCHAR(32) PRIMARY KEY,
  name       VARCHAR(60) NOT NULL,
  category   VARCHAR(32) NULL COMMENT 'hq_group/external_type/other',
  sort       INT NOT NULL DEFAULT 0,
  active     TINYINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='职位/身份属性，不参与授权';
```

示例：终端组、设计组、设计师、门店人员、经销商。代码审查规则：`position_code` 不得出现在 `visibilityScope()`、`requireCapability()` 或角色计算中。

### 4.4 一期不做多组织

多组织会引入“主组织是什么”“区域看板算几次”“哪个管理员能管他”等问题。当前需求没有证明同一个账号必须属于多个组织，因此一期只设 `app_user.org_id`。确有跨区域职责时仍用品牌授权和看板专项范围解决，不提前引入 `user_org_membership`。

---

## 五、E1 · 用户与品牌数据模型

### 5.1 稳定品牌代码

权限和 OSS 路径均使用稳定 ASCII code：

```sql
CREATE TABLE platform_brand (
  code       VARCHAR(32) PRIMARY KEY,
  name       VARCHAR(32) NOT NULL,
  active     TINYINT NOT NULL DEFAULT 1,
  sort       INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO platform_brand(code,name,sort) VALUES
('hisense','海信',1),('hitachi','日立',2),('york','约克',3),('kelon','科龙',4);
```

**跨域契约**：`app_user_brand.brand_code`、`material.brand_code`、`file_chunk.brand_code`、OSS key 和日志都用 code；中文名仅展示。治理词表的“品牌归属/多品牌”是业务标签，不能放宽数据权限。

### 5.2 用户表

```sql
CREATE TABLE app_user (
  id                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  phone_normalized     VARCHAR(24) NOT NULL COMMENT '如 +8613812345678',
  display_name         VARCHAR(80) NOT NULL,
  role_code            VARCHAR(32) NOT NULL,
  position_code        VARCHAR(32) NULL,
  org_id               BIGINT NOT NULL,

  status               ENUM('pending_activation','active','disabled')
                       NOT NULL DEFAULT 'pending_activation',
  password_hash        VARCHAR(255) NULL,
  password_algo        VARCHAR(32) NULL COMMENT 'bcrypt_sha256_v1',
  password_changed_at  DATETIME NULL,
  must_set_password    TINYINT NOT NULL DEFAULT 1,

  auth_version         INT NOT NULL DEFAULT 1 COMMENT '密码/权限重大变化时递增',
  failed_login_count   INT NOT NULL DEFAULT 0,
  locked_until         DATETIME NULL,
  last_login_at        DATETIME NULL,

  created_by           BIGINT NULL,
  updated_by           BIGINT NULL,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  disabled_at          DATETIME NULL,
  disabled_reason      VARCHAR(255) NULL,
  deleted_at           DATETIME NULL,

  UNIQUE KEY uq_phone (phone_normalized),
  KEY idx_org (org_id, status),
  KEY idx_role (role_code, status),
  KEY idx_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台用户';

CREATE TABLE app_user_brand (
  user_id     BIGINT NOT NULL,
  brand_code  VARCHAR(32) NOT NULL,
  granted_by  BIGINT NOT NULL,
  granted_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, brand_code),
  KEY idx_brand_user (brand_code, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户品牌授权';
```

### 5.3 用户状态机

```
pending_activation ──激活并设置密码──→ active ──禁用──→ disabled
                                             ↑            │
                                             └── 恢复 ────┘

任一状态可软删除：只设置 deleted_at；恢复保留原状态
临时登录锁定：locked_until，不是生命周期状态
```

约束：

- 非超级管理员进入 `active` 前至少有一个品牌；
- 超级管理员不需要 `app_user_brand` 行，代码明确解释为全品牌；
- `pending_activation`、`disabled`、`deleted_at IS NOT NULL` 均不能建立/刷新会话；
- 禁用、软删除、角色变化、品牌变化、密码重置时：`auth_version+1` 并撤销该用户全部会话；
- `disable/enable` 只改变 status；`soft-delete/undelete` 只设置或清除 `deleted_at`，undelete 保留删除前 status，二者不得合并成一个“restore”动作；
- 手机号不因软删除而释放；同手机号返岗必须返回“恢复原账号”冲突，由有权限管理员显式 undelete，导入不得新建或静默恢复；
- `locked_until` 到期自动恢复，不需要人工改 status；
- 电话完整值仅用户管理授权者可见，其他界面显示掩码；禁止写入普通日志。

### 5.4 关系完整性与统一授权事务

上面的 DDL 按领域概念分段展示，正式 migration 必须按依赖顺序建表并添加以下外键：

- 组织与用户：`org_unit.parent_id→org_unit.id`；`app_user.role_code/position_code/org_id→auth_role/position_dict/org_unit`；
- 用户品牌：`app_user_brand.user_id/brand_code→app_user/platform_brand`；
- 权限种子：`auth_role_permission.role_code/permission_code→auth_role/auth_permission`；
- 导入：`user_import_row.batch_id/user_id→user_import_batch/app_user`；
- 账号与会话：`account_token.user_id→app_user`、`auth_session.user_id→app_user`、`auth_refresh_token.session_id→auth_session`，其 `parent_id/rotated_to_id→auth_refresh_token.id`；
- 治理映射：`gov_governor_user_map.user_id→app_user`。

身份主数据均用 `RESTRICT`，不做级联删除；软删除由领域服务控制。`created_by/updated_by/revoked_by` 等历史 actor 字段为保留离职审计不设级联，写入时由领域服务校验。

所有创建、导入、激活、启用、角色/品牌修改都复用 `UserGrantTransaction`：锁定 user，计算 proposed role/brand/status，校验“active 非超管品牌非空”等不变量，再原子写入品牌、`auth_version`、会话撤销和审计。禁止每个入口各写一套不变量。

### 5.5 角色、组织与品牌一致性

| 角色 | 组织建议 | 品牌要求 |
|---|---|---|
| `super_admin` | 总部 | 可无品牌行，解释为全部 |
| `hq_admin` | 总部 | 至少一个 |
| `branch` | 分公司/区域 | 至少一个 |
| `external` | 外部组织或分公司挂靠 | 至少一个 |

“组织建议”用于导入预警，不作为登录硬限制，避免真实人员调动时卡死；“品牌要求”是安全硬约束。

---

## 六、E1 · 批量导入、激活与重置

### 6.1 导入不是直接写库

采用“上传 → 预检 → 人工确认 → 分批提交 → 一次性导出激活码”：

```sql
CREATE TABLE user_import_batch (
  id             CHAR(32) PRIMARY KEY,
  file_name      VARCHAR(255) NOT NULL,
  file_sha256    CHAR(64) NOT NULL,
  mode           ENUM('create_only','explicit_update') NOT NULL DEFAULT 'create_only',
  status         ENUM('previewed','confirmed','running','done','partial_failed','canceled') NOT NULL,
  total_rows     INT NOT NULL DEFAULT 0,
  valid_rows     INT NOT NULL DEFAULT 0,
  error_rows     INT NOT NULL DEFAULT 0,
  created_by     BIGINT NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at   DATETIME NULL,
  finished_at    DATETIME NULL,
  UNIQUE KEY uq_actor_file (created_by, file_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_import_row (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id       CHAR(32) NOT NULL,
  row_no         INT NOT NULL,
  raw_data       JSON NOT NULL,
  action         ENUM('create','update','noop','conflict','invalid') NOT NULL,
  user_id        BIGINT NULL,
  errors         JSON NULL,
  status         ENUM('pending','done','failed') NOT NULL DEFAULT 'pending',
  UNIQUE KEY uq_batch_row (batch_id, row_no),
  KEY idx_batch_action (batch_id, action, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

预检内容：手机号格式/重复、角色合法、组织存在、职位存在、品牌 code 合法、操作者能否授予这些品牌和角色、库中是否已有账号。

默认 `create_only`：已有手机号标 conflict，不静默改角色/品牌。`explicit_update` 必须在预览中逐项展示 before/after，确认后才执行。每 500 行一个事务，依靠 batch+row 幂等重跑。

### 6.2 总部管理员的导入边界

- 超级管理员：可导入所有非超级管理员；创建/变更超级管理员必须走单独高风险流程；
- 总部管理员：只能创建或更新 `branch/external`；目标品牌必须是自己品牌集合的子集；不能授予 `hq_admin/super_admin`；
- 分公司/外部人员：无用户导入能力。

这样避免总部管理员给自己或同事提权为超级管理员。

### 6.3 一次性激活与重置 Token

```sql
CREATE TABLE account_token (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id        BIGINT NOT NULL,
  token_type     ENUM('activation','password_reset') NOT NULL,
  token_hash     CHAR(64) NOT NULL COMMENT 'HMAC-SHA256(token, pepper)',
  status         ENUM('active','consumed','revoked') NOT NULL DEFAULT 'active',
  attempts       INT NOT NULL DEFAULT 0,
  max_attempts   INT NOT NULL DEFAULT 5,
  expires_at     DATETIME NOT NULL,
  consumed_at    DATETIME NULL,
  revoked_at     DATETIME NULL,
  created_by     BIGINT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token_hash (token_hash),
  KEY idx_user_type (user_id, token_type, status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- 激活码：12 位 Crockford Base32 随机串，约 60 bit 熵，7 天有效；
- 重置码：同等熵，24 小时有效；
- 数据库只存带服务端 pepper 的 HMAC；明文只在创建响应/导出文件中出现一次；
- 新发 Token 必须在锁定 user 的同一事务中把同类型旧 Token 标为 `revoked`；
- 连续错误 5 次即标为 `revoked`，不泄露“手机号存在但码不对”；
- 消费时 `SELECT account_token, app_user ... FOR UPDATE`，在同一事务完成状态/次数检查、密码更新、`auth_version`、会话撤销、Token `consumed` 和用户状态迁移，避免两个并发请求同时成功；
- activation 只接受 `pending_activation`，成功后账号变 active 并创建首个会话；password_reset 只接受未删除的 active 用户，不改变生命周期状态，disabled/deleted 用户不得借重置恢复或创建会话；
- 激活页面要求同时输入手机号、激活码和新密码；
- 管理员不能查看或设置用户正式密码，忘记密码只能签发重置码；
- 导出的激活清单不得进入 Git、日志或长期对象存储，下载后由管理员通过线下安全渠道分发。

### 6.4 首登“强制改密”的准确实现

不把激活码当临时密码去普通 `/login`。首次激活时用户直接设置自己的正式密码，之后才能正常登录。这比“先用统一临时密码登录，再跳改密页面”少一个可被绕过的中间态，同时满足 PRD 的首登强制改密目标。

---

## 七、E2 · 功能权限模型

### 7.1 固定角色 + 固定 Capability

```sql
CREATE TABLE auth_role (
  code        VARCHAR(32) PRIMARY KEY,
  name        VARCHAR(60) NOT NULL,
  rank_level  TINYINT NOT NULL COMMENT '仅用于管理越级校验，不用于数据可见性',
  active      TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE auth_permission (
  code        VARCHAR(64) PRIMARY KEY,
  name        VARCHAR(80) NOT NULL,
  risk_level  ENUM('normal','sensitive','high') NOT NULL DEFAULT 'normal'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE auth_role_permission (
  role_code       VARCHAR(32) NOT NULL,
  permission_code VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_code, permission_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

角色/权限表由迁移脚本播种，生产后台只读。一期不允许超管点击勾选自定义权限——误配的安全风险高于灵活性收益。

### 7.2 Capability 清单

| code | 能力 |
|---|---|
| `material.read` | 浏览、检索、详情、预览 |
| `material.download` | 单文件下载、组包 |
| `material.write` | 上传、编辑授权品牌素材 |
| `material.delete` | 归档、软删除、恢复授权品牌素材 |
| `material.version.manage` | 发布、恢复、清理素材版本 |
| `agent.use` | 使用 Agent |
| `favorite.manage` | 收藏 |
| `feedback.create` | 质量反馈、求素材 |
| `vocab.manage` | 业务域、标签、物料类型配置 |
| `user.manage.scoped` | 在品牌范围内管理下级用户 |
| `user.manage.all` | 管理全部用户和高权限账号 |
| `org.manage` | 管理组织与职位字典 |
| `notification.send` | 给授权品牌发通知 |
| `dashboard.global` | 全平台看板 |
| `dashboard.brand` | 授权品牌看板 |
| `dashboard.region` | 自身区域看板 |
| `audit.read` | 全局审计查询 |
| `system.manage` | 系统配置、高风险操作 |
| `governance.use` | 进入治理工作台 |
| `governance.config` | 配置治理词表/抽查参数 |

### 7.3 落地矩阵

| Capability | 超管 | 总部管理员 | 分公司 | 外部 |
|---|:---:|:---:|:---:|:---:|
| `material.read` | ✅ 全品牌 | ✅ 授权品牌 | ✅ 授权品牌 | ✅ 授权品牌 |
| `material.download` | ✅ | ✅ | ✅ | ✅ |
| `material.write/delete/version.manage` | ✅ | ✅ 授权品牌 | ❌ | ❌ |
| `agent.use` | ✅ | ✅ | ✅ | ✅ |
| `favorite.manage/feedback.create` | ✅ | ✅ | ✅ | ✅ |
| `vocab.manage` | ✅ | ✅ | ❌ | ❌ |
| `user.manage.all` | ✅ | ❌ | ❌ | ❌ |
| `user.manage.scoped` | ✅ | ✅ | ❌ | ❌ |
| `org.manage` | ✅ | ❌ | ❌ | ❌ |
| `notification.send` | ✅ | ✅ 授权品牌 | ❌ | ❌ |
| `dashboard.global` | ✅ | ❌ | ❌ | ❌ |
| `dashboard.brand` | ✅ | ✅ 授权品牌 | ❌ | ❌ |
| `dashboard.region` | ✅ | ✅ | ✅ 本区域 | ❌ |
| `audit.read/system.manage` | ✅ | ❌ | ❌ | ❌ |
| `governance.use` | ✅ | ✅（映射治理人后） | ❌ | ❌ |
| `governance.config` | ✅ | ✅（可按配置再收紧） | ❌ | ❌ |

### 7.4 Capability 与页面路由不是一回事

前端可根据 capability 隐藏按钮，但后端每个动作必须再次 `require()`。禁止写：

```ts
if (request.path.startsWith('/admin')) allowHqAdmin();
```

应写：

```ts
await auth.require(ctx, 'material.delete');
await materialRepo.assertBrandAccessible(materialId, ctx);
```

同一个管理页面可能含不同风险操作，路由级角色判断太粗；Capability 应贴近业务动作。

### 7.5 高风险动作

以下动作需二次输入当前密码或 10 分钟内的 re-auth 证明，并写 reason。`POST /api/auth/reauth` 验证当前密码后只更新当前 `auth_session.reauthenticated_at=now()`，不签发可转移的证明 Token；高风险接口在同一服务端会话内要求该时间不早于 `now()-600s`。会话撤销、切换或过期后证明自然失效：

- 新增/禁用超级管理员；
- 强制下线全部用户；
- 紧急撤回 OSS 对象；
- 重置 JWT 签名密钥；
- 导出全量用户手机号；
- 修改系统级安全参数。

一期不做复杂审批流，但高风险动作至少不能依赖一个可能已打开数小时的会话。

---

## 八、E2 · 用户管理范围

### 8.1 `assertCanManageUser()`

```ts
function assertCanManageUser(
  actor: AuthCtx,
  current: UserGrant | null,
  proposed: UserGrant,
) {
  if (actor.role === 'super_admin') return;
  requireCapability(actor, 'user.manage.scoped');

  // 更新时既要原本有权管理，也要保证修改后的授权不越界。
  for (const grant of [current, proposed].filter(Boolean) as UserGrant[]) {
    if (!['branch', 'external'].includes(grant.role)) throw new ForbiddenError();
    if (!isSubset(grant.brandCodes, actor.brandCodes)) throw new ForbiddenError();
  }
}
```

创建传 `current=null`；更新必须传数据库锁定后读到的 current 和合并 PATCH 后的完整 proposed，禁止仅校验请求前状态。建议默认：总部管理员不能创建/修改其他总部管理员。20–50 名总部管理员由 1–3 名超管管理，工作量可接受，换来清晰的提权边界。

### 8.2 管理动作的双重校验

创建/编辑用户时同时校验：

1. **功能能力**：是否有 `user.manage.all/scoped`；
2. **目标角色**：是否允许管理该等级；
3. **品牌子集**：不能授予自己没有的品牌；
4. **组织有效性**：组织未禁用/删除；
5. **品牌非空**：非超管 active 用户至少一个；
6. **不能修改自己关键授权**：总部管理员不能改自己的 role/brands/status；
7. **最后一个超管保护**：系统至少保留一个 active 超管，建议至少两个。所有超管创建、禁用、软删除和角色变更事务先执行 `SELECT * FROM auth_role WHERE code='super_admin' FOR UPDATE` 锁定统一 guard 行，再计数与变更；禁止用无锁 `COUNT(*)`，否则两个并发禁用可能同时通过。

### 8.3 品牌授权变更

在一个事务中：

```sql
SELECT * FROM app_user WHERE id=? FOR UPDATE;
-- 校验 actor scope
DELETE/INSERT app_user_brand ...;
UPDATE app_user SET auth_version=auth_version+1, updated_by=? WHERE id=?;
UPDATE auth_session SET status='revoked', revoked_reason='grant_changed' WHERE user_id=? AND status='active';
INSERT audit_log (... before/after ...);
COMMIT;
```

角色、品牌和禁用变化立即撤销会话，要求用户重新登录，避免旧页面继续显示不再允许的操作。

---

## 九、E3 · 品牌数据权限

### 9.1 唯一规则

```ts
export interface AuthCtx {
  userId: number;
  sessionId: string;
  role: 'super_admin' | 'hq_admin' | 'branch' | 'external';
  orgId: number;
  regionOrgId: number | null;
  positionCode: string | null;
  brandCodes: string[];
  capabilities: ReadonlySet<Capability>;
  authVersion: number;
  traceId: string;
}

export function visibilityScope(ctx: AuthCtx, alias = 'm'): SqlFragment {
  if (ctx.role === 'super_admin') return sql`1=1`;
  if (ctx.brandCodes.length === 0) return sql`1=0`;
  return sql`${ref(alias + '.brand_code')} IN (${params(ctx.brandCodes)})`;
}
```

注意：不同 SQL 库对 `IN (?)` 数组展开处理不同，必须用查询构造器生成 N 个参数，不能把数组序列化成一个字符串参数。

### 9.2 权限主字段

| 字段 | 是否参与一期权限 | 说明 |
|---|:---:|---|
| `material.brand_code` | ✅ | 唯一数据权限主键 |
| `app_user_brand.brand_code` | ✅ | 用户授权集合 |
| `material_tag` 的品牌归属 | ❌ | 业务检索标签，可多值 |
| `org_id/region_code` | ❌ | 归属与看板 |
| `position_code` | ❌ | 展示与统计 |
| `material.visibility` | ❌（预留） | 当前恒 public |
| `material_file.visibility` | ❌（预留） | 当前恒 inherit |
| `l_tier` | ❌ | 内容分层，不是权限层级 |

### 9.3 预留 visibility 的一致性修正

域 G 示例中的文件可见性出现了 `designer`，这与“职位不参与权限”和“四角色”冲突。预留枚举统一为：

```sql
material.visibility      ENUM('public','branch','hq') DEFAULT 'public'
material_file.visibility ENUM('inherit','public','branch','hq') DEFAULT 'inherit'
```

一期不读取这些字段做权限判断。将来启用时只修改 `visibilityScope()` 及 PG 冗余同步，不允许各 Repository 自行解释。

### 9.4 五个出口必须共用同一上下文

| 出口 | 强制方式 |
|---|---|
| 素材列表/详情/文件树 | `MaterialCatalog` 查询必传 AuthCtx，SQL 注入 scope |
| 预览/单文件下载 URL | 按 `file_id JOIN material` 复查 scope，不接收任意 key |
| 打包 estimate/submit/url | 全量 node/file ID 归属校验；取 URL 时再次校验 |
| Agent 工具 | 工具闭包捕获 AuthCtx，schema 中没有 userId/role/brands |
| PostgreSQL 向量检索 | `WHERE brand_code = ANY($1)` 与向量排序同一 SQL |

权限不能只在检索入口做一次，因为用户可能保存旧 file_id/job_id，或者授权在任务完成前被撤销。最终字节出口必须复查。

### 9.5 PostgreSQL 冗余与品牌变更

PG 也必须区分超管空集合和普通用户空集合，不能把二者都绑定成 `ANY('{}')`：

```ts
function pgVisibilityScope(ctx: AuthCtx): PgFragment {
  if (ctx.role === 'super_admin') return pg`TRUE`;
  if (ctx.brandCodes.length === 0) return pg`FALSE`;
  return pg`brand_code = ANY(${ctx.brandCodes})`;
}
```

```sql
SELECT file_id, material_id, seq, text
  FROM file_chunk
 WHERE /* pgVisibilityScope(ctx) */
   AND l_tier = 'L1'
 ORDER BY embedding <=> $embedding
 LIMIT 50;
```

`file_chunk.brand_code` 只是检索冗余，不是最终授权真相。所有 PG 候选在文本交给模型前，必须按 `material_id` 回 MySQL 批量执行最新 `visibilityScope()`；PG 旧值因此最多造成暂时少召回，不能造成跨品牌泄露。

品牌变更是低频高风险动作：

1. 只有同时拥有原品牌和目标品牌权限的总部管理员，或超管可改；
2. 在更新 MySQL material 的同一事务写唯一 outbox 事件 `material.brand.changed`，不得“先提交、再尽力创建任务”；
3. Agent 先用 PG brand_code 缩小候选，再用 MySQL 最新品牌失败关闭复查；
4. worker 消费 outbox 更新 PG，成功后记录同步游标；G 域 job kind 必须正式支持 `brand_sync`，或改为可扩展 `VARCHAR(32)`；
5. 全程审计 before/after，并对积压/失败告警。

### 9.6 Repository 纪律

- `material/material_file/download/package` 相关表只能由领域 Repository 访问；
- Repository 公共方法必须传 AuthCtx；
- repo 层之外禁止裸 SQL 访问素材表；
- 维护脚本使用明确 service actor 和专用内部入口，不伪造 super_admin；
- CI 静态检查 + L0 越权测试共同门禁。

### 9.7 跨域公共契约（实施阻断项）

域 E 从本版本起是身份与授权契约的权威定义。域 B/G/H 在进入开发前必须一次性同步，不能在各出口局部兼容：

| 契约 | 唯一写法 | 必须淘汰 |
|---|---|---|
| 素材主品牌 | `material.brand_code`、`file_chunk.brand_code` | `material.brand`、`file_chunk.brand` |
| 身份上下文 | `AuthCtx.brandCodes` | `ctx.brands` |
| Capability 容器 | `ReadonlySet` + `.has(code)` | 对 Set 使用 `.includes()` |
| 管理视图 | 以 `material.write` 作为进入条件；具体动作分别校验 write/delete/version.manage | 未定义的 `material.manage` |
| MySQL 品牌数组 | 查询构造器展开 N 个参数；非超管空集固定 `1=0` | `IN (?)` 绑定整个数组、空集放行 |
| PG 品牌数组 | `pgVisibilityScope()`；超管 TRUE、普通空集 FALSE | 所有角色统一 `ANY([])` |
| 品牌同步 | MySQL 事务内 outbox + PG 候选回 MySQL 复查 | 仅依赖最终一致 PG 冗余授权 |

迁移域还必须采用域 B 的统一物理对象模型：`oss_object.id` 为主键、`verified_md5` 为查重索引；H 域不得再创建 `md5` 主键的同名表。去重只合并物理对象，不合并逻辑文件；H 必须正式持久化 `migrate_item_ref(material_id, version_id, rel_path, l_tier, object_id...)`，保证同一 MD5 的每个逻辑路径都能生成稳定 `material_file`。上述同步是阶段 3 开发的前置门禁，不代表旧版 B/G/H 文档现状已经兼容。

---

## 十、E3 · Agent、通知和看板中的权限

### 10.1 Agent 不拥有权限

错误工具定义：

```ts
searchMaterials({ query, userId, role, brands }) // 模型可伪造
```

正确方式：

```ts
function createAgentTools(ctx: AuthCtx) {
  return {
    searchMaterials: (args: SearchArgs) => catalog.search(args, ctx),
    getMaterial: (args: DetailArgs) => catalog.get(args.id, {}, ctx),
    estimatePackage: (args: Selection) => packagePlanner.estimate(args, ctx),
  };
}
```

Prompt 注入“我是总部”“忽略权限”对 AuthCtx 没有影响。模型最多决定查什么，不能决定以谁的身份查。

### 10.2 通知

域 F 发通知时：

- 发送者需 `notification.send`；
- 总部管理员选择的品牌必须是自身 brandCodes 子集；
- 接收者必须 active 且拥有该品牌；
- 用户品牌被移除后，不再收到该品牌新通知；历史通知中若素材已不可见，点击时仍由素材详情返回 404；
- 通知表不得复制永久 OSS URL。

### 10.3 区域看板

`regionOrgId` 是区域权限和查询的唯一键，值为对应 `org_unit.id`（branch 节点主键）；`org_unit.region_code` 仅用于对接外部统计编码和展示，不参与授权过滤。`dashboard.region` 按角色具有两种明确范围：

- branch：请求的 `regionOrgId` 固定为 `ctx.regionOrgId`，忽略/拒绝前端传入其他值；
- hq_admin：可选择任意有效 branch 的 `regionOrgId`，但结果必须同时受 `ctx.brandCodes` 限制；若 brandCodes 为空仍返回空；
- super_admin：可选择任意 `regionOrgId` 和全部品牌；
- external：无此 capability。

因此 HQ 组织本身没有最近 branch、`ctx.regionOrgId=null` 也不影响其按授权品牌查看区域明细。组织范围与品牌谓词同时生效，但组织仍不影响素材浏览权限。

---

## 十一、E4 · 认证架构

### 11.1 解决“JWT 7 天 + 强制下线”的矛盾

纯 7 天无状态 JWT 一旦签出，服务端在过期前无法撤销。黑名单又会重新引入服务端状态。因此采用：

| 层 | 有效期 | 是否存库 | 用途 |
|---|---:|:---:|---|
| Access JWT | 15 分钟 | JWT 本身不存；sid 对应 session 存库 | 每次业务请求认证 |
| Refresh Token | 单次使用，最长 7 天 | 只存摘要与轮换链 | 获取新 Access JWT |
| Auth Session | 绝对 7 天 | ✅ MySQL | 强退、设备、状态、会话真相 |

每次请求仍查询 session/user，因此即使 Access JWT 还有 14 分钟，管理员强退后下一次请求立即 401。

### 11.2 会话表

```sql
CREATE TABLE auth_session (
  id                CHAR(32) PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  auth_version      INT NOT NULL,
  status            ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  device_name       VARCHAR(120) NULL,
  user_agent_hash   CHAR(64) NULL,
  ip_created        VARCHAR(64) NULL,
  ip_last           VARCHAR(64) NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      DATETIME NOT NULL,
  reauthenticated_at DATETIME NULL COMMENT '当前会话最近一次密码再认证时间',
  expires_at        DATETIME NOT NULL,
  revoked_at        DATETIME NULL,
  revoked_by        BIGINT NULL,
  revoked_reason    VARCHAR(128) NULL,
  KEY idx_user_status (user_id, status, expires_at),
  KEY idx_expire (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='可撤销登录会话';

CREATE TABLE auth_refresh_token (
  id                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id           CHAR(32) NOT NULL,
  family_id            CHAR(32) NOT NULL,
  parent_id            BIGINT NULL,
  rotated_to_id        BIGINT NULL,
  token_hash           CHAR(64) NOT NULL,
  client_instance_hash CHAR(64) NOT NULL,
  status               ENUM('active','rotated','revoked','reused') NOT NULL DEFAULT 'active',
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at           DATETIME NOT NULL,
  rotated_at           DATETIME NULL,
  grace_expires_at     DATETIME NULL,
  used_ip              VARCHAR(64) NULL,
  UNIQUE KEY uq_hash (token_hash),
  KEY idx_session (session_id, status),
  KEY idx_family (family_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Refresh轮换与重放检测';
```

### 11.3 Access JWT 内容

```json
{
  "iss": "dam-platform",
  "aud": "dam-web",
  "sub": "1024",
  "sid": "01J...",
  "ver": 7,
  "jti": "01J...",
  "iat": 1786089600,
  "exp": 1786090500
}
```

不放 phone、displayName、role、brands、position、capabilities。即使为了前端显示而冗余，也不得作为后端授权依据。后端从数据库加载最新值。

### 11.4 每请求认证

```ts
async function authenticate(req: Request): Promise<AuthCtx> {
  const claims = verifyJwt(req.cookies['__Host-dam_at'], keyRing, {
    issuer: 'dam-platform', audience: 'dam-web', algorithms: ['HS256']
  });

  const row = await authRepo.loadActiveSessionAndUser(claims.sid, claims.sub);
  if (!row || row.sessionStatus !== 'active') throw unauthenticated();
  if (row.sessionExpiresAt <= now()) throw unauthenticated();
  if (row.userStatus !== 'active' || row.deletedAt) throw unauthenticated();
  if (row.authVersion !== claims.ver || row.authVersion !== row.sessionAuthVersion) {
    throw unauthenticated();
  }

  return buildAuthCtx(row, await authRepo.loadBrandCodes(row.userId), traceId(req));
}
```

`last_seen_at/ip_last` 最多每 5 分钟更新一次，不在每个请求写库，避免认证读变成写热点。

### 11.5 Refresh 轮换

浏览器另持一个服务端生成的非认证设备标识 Cookie `__Secure-dam_ci`；数据库只保存其 HMAC 摘要。它只用于区分同一浏览器的并发刷新，不能单独认证用户。

事务流程：

1. 对 Refresh 原文和 client instance 分别做 HMAC-SHA256 摘要；
2. `SELECT token, session, user ... FOR UPDATE`；
3. active token 必须未过期、session/user active、auth_version 一致且 client instance 摘要匹配；
4. 生成新 Token，插入同 family 子记录；旧 token 标 rotated，写 `rotated_to_id`、`rotated_at` 和 `grace_expires_at=now()+5s`；签新 Access 并原子设置新 Cookie；
5. rotated token 在 5 秒宽限内、且 client instance 相同：返回固定 `409 REFRESH_IN_PROGRESS` 与 `Retry-After`，不下发 Token、不清 Cookie、不改变状态；前端等待首个请求更新 Cookie 后再重试；
6. rotated token 来自不同 client instance，或超过宽限后再次出现：标 reused，撤销整个 family/session，记录高风险事件并要求重新登录；
7. 若首个响应在数据库提交后丢失，客户端可能需要重新登录；系统选择安全失败，不在库中可逆保存新 Refresh 明文，也不把 5 秒宽限放宽成第二次成功。

Refresh 原文至少 256 bit 随机，数据库只存带 pepper 的 HMAC。Refresh 不是 JWT，不需要客户端读取。该协议明确采用“宽限期重试”而非“返回同一结果”，避免只存摘要时无法重放新明文的矛盾。

### 11.6 会话数量

默认每用户最多 5 个 active session。第 6 个登录时撤销最旧会话并提示。用户可在“登录设备”页面查看设备名、创建时间、最近活动和大致 IP，单独下线；修改密码时默认撤销其他全部会话。

---

## 十二、E4 · Cookie、CSRF 与浏览器安全

### 12.1 Cookie

| Cookie | 属性 |
|---|---|
| `__Host-dam_at` | `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`；不设 Domain |
| `__Secure-dam_rt` | `Secure; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=604800`；不设 Domain，使 refresh 与 logout 都可接收 |
| `__Secure-dam_ci` | `Secure; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=31536000`；不设 Domain，仅作浏览器实例标识 |
| `dam_csrf` | `Secure; SameSite=Lax; Path=/`；非 HttpOnly，前端回传 header |

Access Token 不返回 JSON 给前端、不写 localStorage/sessionStorage。前端 fetch 使用同源 Cookie。

### 12.2 CSRF

CSRF 分两类，避免要求未登录请求匹配不存在的 session：

**已认证写请求及 Refresh**（POST/PUT/PATCH/DELETE）：

1. 校验 `Origin` 必须精确等于平台 origin；无 Origin 时校验 Referer；
2. 校验 `Sec-Fetch-Site` 为 `same-origin`；
3. 校验 `X-CSRF-Token` 与 `dam_csrf` Cookie，且与 session 派生值匹配。

**登录、激活、重置等 pre-auth 请求**：严格校验 Origin/Referer 与 Fetch Metadata，并执行账号/IP 限流；不要求 session 派生 Token。若后续出现跨站登录需求，再先签发独立的一次性 pre-auth CSRF nonce，不复用登录 session。

OSS 直传不携带平台 Cookie，使用 B 域限定前缀的 STS 与 Bucket CORS。SameSite 不是唯一 CSRF 防线，因为同站点子域被攻陷时仍可能发送 Cookie。

### 12.3 Nginx 与响应头

- 只接受 HTTPS，开启 HSTS；
- 正确传 `X-Forwarded-Proto https`，应用仅信任本机 Nginx；
- `/api/auth/**`、`/api/users/**` 统一 `Cache-Control: no-store`；
- CORS 默认不开放跨域；
- 设置 CSP，至少限制 `script-src 'self'`，逐步移除内联脚本；
- `frame-ancestors 'none'` 或同源，防点击劫持；
- Nginx 覆盖/清除外部传入的 `X-Actor-*` 内部身份头。

上线前必须读取真实 Nginx vhost 验证，而不能只根据 docker-compose 推断。

---

## 十三、E4 · 密码与登录防护

### 13.1 密码存储

PRD 已定 bcrypt。为解决 bcrypt 只处理前 72 字节的问题，采用版本化 `bcrypt_sha256_v1`：

```
prehash = base64url(SHA-256(UTF-8(password)))
hash    = bcrypt(prehash, cost=12, random_salt)
```

- 最小 10 个字符，最大 128 个字符；
- 不做 Unicode normalize、不 trim，用户输入什么就校验什么；
- 不强制“必须含大小写数字符号”的复杂组合；
- 拒绝手机号、姓名、品牌名和常见弱密码；
- 不定期强制过期，只有泄露/重置/管理员安全动作时改密；
- 初始 cost=12，上线压测目标单次 100–250ms；若服务器实测超标可调 11，必须记录；
- `password_algo` 使未来可登录时透明升级 Argon2id，不需要全量重置密码；
- 比较使用恒定时间库函数，日志绝不记录密码/prehash/hash。

### 13.2 登录响应防枚举

不存在手机号、未激活、已禁用、密码错误，对外统一：

```json
{"error":{"code":"INVALID_CREDENTIALS","message":"手机号或密码错误"}}
```

服务端执行近似相同成本的假 bcrypt 校验，避免通过响应时间判断账号是否存在。管理后台可在有权限的用户列表中查看真实状态。

### 13.3 失败限流

双维度：账号 + IP。

| 规则 | 默认值 |
|---|---:|
| 单账号 15 分钟失败 | 5 次后锁 15 分钟 |
| 再次触发 | 锁定时间指数增长，最长 24 小时 |
| 单 IP 10 分钟失败 | 20 次后延迟/拒绝 |
| 激活/重置码 | 每 Token 最多 5 次 |
| 登录失败固定延迟 | 300–800ms 随机抖动 |

```sql
CREATE TABLE auth_rate_bucket (
  bucket_key      CHAR(64) PRIMARY KEY COMMENT 'HMAC(account或IP)',
  bucket_type     ENUM('account','ip') NOT NULL,
  window_start    DATETIME NOT NULL,
  failure_count   INT NOT NULL,
  blocked_until   DATETIME NULL,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cleanup (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

不用 Redis；单机多进程都通过 MySQL 原子更新。不要永久锁账号，防止攻击者借此对目标用户拒绝服务。

### 13.4 密码修改/重置

- 用户改密：验证当前密码后，在一个事务锁定 user 与当前 session，更新 hash 和 user `auth_version+1`，撤销其他 session/family，把当前 `auth_session.auth_version` 同步为新值并轮换当前 Refresh；事务提交后再设置新 Access/Refresh Cookie。只重签 Access 而不更新 session 版本会立即 401，保留旧 Refresh 又会留下被盗凭证；
- 管理员重置：不能设置新密码，只签发 reset token，并立即撤销现有会话；
- 忘记密码一期通过管理员线下核验后发 reset token；二期短信通道接入时仍复用 `account_token`；
- 超管重置需另一个超管操作或离线 break-glass 流程，防单点夺权。

---

## 十四、E4 · 强制下线、密钥与故障策略

### 14.1 强制下线

| 场景 | 动作 |
|---|---|
| 管理员下线单设备 | revoke 指定 session |
| 管理员下线用户全部设备 | `auth_version+1` + revoke all sessions |
| 用户禁用/删除 | 同上，下一请求立即 401 |
| 用户角色/品牌变化 | 同上，要求重新登录获取新界面状态 |
| 密码修改/重置 | 撤销其他/全部会话 |
| 全局安全事件 | 批量 revoke session + JWT key rotation |

因每请求查 session，强退不依赖等待 Access Token 15 分钟过期，**但该立即失效语义只覆盖再次经过平台 API 的请求**。已经签发的 OSS 预签名 URL 是 Bearer URL，签发后不会回查 session，仍可使用到自身过期：按域 B 当前默认，单文件最长 15 分钟、打包最长 30 分钟。这一残余窗口必须在安全说明和验收中明确。

一期接受该窗口并坚持 URL 不持久化、TTL 尽量短、取 URL 前复查；若发生紧急泄露，可删除/改对象 key 或经 OSS/CDN 失效机制处置。若业务要求“已签 URL 也即时撤销”，必须把下载改为每次请求校验短票据的下载网关/CDN 鉴权，不能仅靠 session 表宣称做到。

### 14.2 JWT 密钥

- HS256 密钥至少 256 bit，来自 Secret/环境注入，不入库、不进 Git；
- JWT header 使用 `kid`；应用配置 current + previous key，可平滑轮换；
- 严格白名单算法，拒绝 `none` 和 token 自报算法切换；
- 单一 TypeScript 入口验证 JWT，Python worker 不持 JWT 密钥；
- 若未来多个独立服务需自行验签，再切换 EdDSA/RS256，不提前增加公私钥运维。

### 14.3 认证依赖故障

MySQL 不可用时，认证**失败关闭**：返回 503，不因“JWT 签名正确”跳过会话校验。权限系统降级放行会把可用性故障变成数据泄露。

登录/刷新接口故障不得回退到共享口令。可准备一个离线运维 CLI 在服务器本地恢复超管，不提供公网万能密码。

---

## 十五、审计、隐私与可信 Actor

### 15.1 Auth 安全事件

```sql
CREATE TABLE auth_event_log (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  trace_id        CHAR(32) NULL,
  event_type      VARCHAR(64) NOT NULL,
  user_id         BIGINT NULL,
  session_id      CHAR(32) NULL,
  account_hint    VARCHAR(32) NULL COMMENT '脱敏手机号或HMAC标识',
  result          ENUM('success','failure','blocked') NOT NULL,
  reason_code     VARCHAR(64) NULL,
  ip              VARCHAR(64) NULL,
  user_agent      VARCHAR(500) NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_time (user_id, created_at),
  KEY idx_type_time (event_type, created_at),
  KEY idx_ip_time (ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录与会话安全事件';
```

事件：login_success/failure/blocked、activate、refresh、refresh_reuse、logout、session_revoke、password_change/reset、account_disable/enable/soft_delete/undelete、grant_change、permission_denied、reauth_success/failure。

### 15.2 业务审计扩展

域 G `audit_log` 建议补：

```sql
ALTER TABLE audit_log
  ADD COLUMN actor_type ENUM('user','service','system') NOT NULL DEFAULT 'user',
  ADD COLUMN actor_key VARCHAR(64) NULL,
  ADD COLUMN session_id CHAR(32) NULL,
  ADD COLUMN reason VARCHAR(255) NULL;
```

- 人工操作：`actor_type=user, actor_id/app_user.id`；
- 迁移工具：`actor_type=service, actor_key='migration'`；
- 定时过期：`actor_type=system, actor_key='material_expirer'`；
- 不创建“假超管用户”给脚本使用；
- before/after 只保存变化字段，手机号脱敏，不存密码、Token、Cookie、STS。

### 15.3 保留周期

| 数据 | 建议保留 |
|---|---:|
| auth_event_log | 180 天 |
| active/revoked session | 过期后 90 天清理 |
| refresh token 摘要 | 会话过期后 30 天清理 |
| user/account 审计 | 至少 2 年 |
| 导入原始文件 | 任务完成 7 天后删除；只留结构化结果 |
| 一次性明文激活码 | 不在服务端持久化 |

IP、User-Agent 属于安全数据，仅超管审计能力可查，不在普通看板展示。

---

## 十六、治理工作台接入统一身份

### 16.1 不新增“治理人”平台角色

PRD 已定：治理人是历史工作台概念，平台角色仍是总部管理员。增加映射：

```sql
CREATE TABLE gov_governor_user_map (
  governor_name VARCHAR(32) PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  mapped_by     BIGINT NOT NULL,
  mapped_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='历史治理人到可信平台用户映射';
```

历史 `gov_material.governor` 字符串继续保留，避免破坏既有数据；新写入的 actor 从会话映射得到，不信任前端传 governor。

### 16.2 最小改造桥

如果治理工作台暂不重写，可通过 Nginx `auth_request` 接统一身份：

1. 浏览器访问治理路径时，Nginx 向仅内网可达的 TypeScript `/internal/auth/check` 发起子请求，并传入目标 method/path；客户端不能直接调用该端点；
2. Nginx 清除客户端传入的全部 `X-Actor-*`/`X-Auth-Assertion`，只注入 auth_request 返回的短时签名断言；
3. 断言规范化载荷必须包含 `sub/sid/aud='sucai-gov'/caps/method/path/iat/exp/kid`，有效期 5–10 秒，签名密钥独立于 JWT；
4. 治理 FastAPI 中间件验证签名、kid、audience、时间窗、method/path，并由 `gov_governor_user_map` 得 governor；映射缺失/重复、用户失效一律失败关闭；
5. 每个 FastAPI 路由声明所需 capability：普通治理操作要求 `governance.use`，配置接口要求 `governance.config`，不能只在 Nginx 路由层默认一个低权限；
6. 所有治理写接口忽略 body/query 的 governor 身份字段；筛选 governor 仍可作为查询条件；
7. 删除 `auth.js` 的 `admin123` 和 sessionStorage 门禁。

Nginx 与治理 FastAPI 仅通过 localhost/Docker 私网通信；内部断言绑定具体请求，不允许把一个普通治理页面的有效头重放到配置接口。

### 16.3 实施时机

统一治理账号在 PRD 中优先级低，但**移除硬编码前端密码和后端裸奔接口不是低优先级**。最低门禁应在正式平台公网开放前完成；是否把治理人的页面交互完整迁入 Next.js 可以后做。

---

## 十七、接口清单

### 17.1 认证与个人账户

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 手机号+密码，创建会话/Cookie |
| POST | `/api/auth/refresh` | 轮换 Refresh，签新 Access |
| POST | `/api/auth/logout` | 撤销当前会话，清 Cookie |
| POST | `/api/auth/activate` | 手机号+激活码+新密码 |
| POST | `/api/auth/reset-password` | 手机号+重置码+新密码 |
| POST | `/api/auth/change-password` | 当前密码+新密码 |
| POST | `/api/auth/reauth` | 高风险动作短时再认证 |
| GET | `/api/me` | 当前用户、role、brands、capabilities、org、position |
| GET | `/api/me/sessions` | 登录设备列表 |
| DELETE | `/api/me/sessions/{id}` | 下线自己的某设备 |

登录失败响应统一；`/api/me` 不返回 password/auth_version/完整手机给不需要的前端区域。

### 17.2 用户管理

| 方法 | 路径 | Capability |
|---|---|---|
| GET | `/api/admin/users` | `user.manage.*`，结果自动按管理范围过滤 |
| POST | `/api/admin/users` | `user.manage.*` + target scope |
| PATCH | `/api/admin/users/{id}` | 同上 |
| POST | `/api/admin/users/{id}/disable` | 同上，reason 必填 |
| POST | `/api/admin/users/{id}/enable` | 同上，仅 `disabled→active` |
| DELETE | `/api/admin/users/{id}` | 同上，软删除且 reason 必填 |
| POST | `/api/admin/users/{id}/undelete` | 同上，只清 deleted_at、保留原 status |
| POST | `/api/admin/users/{id}/activation` | 同上 |
| POST | `/api/admin/users/{id}/password-reset` | 同上 |
| POST | `/api/admin/users/{id}/revoke-sessions` | 同上 |
| POST | `/api/admin/user-imports/preview` | `user.manage.*` |
| POST | `/api/admin/user-imports/{id}/commit` | `user.manage.*` |
| GET | `/api/admin/user-imports/{id}` | `user.manage.*` |
| GET | `/api/admin/orgs` | 有用户管理能力可读 |
| POST/PATCH | `/api/admin/orgs/**` | `org.manage` |
| GET | `/api/admin/positions` | 有用户管理能力可读 |
| POST/PATCH | `/api/admin/positions/**` | `org.manage` |

### 17.3 错误契约

| HTTP | code | 说明 |
|---:|---|---|
| 400 | `INVALID_PHONE/PASSWORD/GRANT` | 输入不合法 |
| 401 | `UNAUTHENTICATED/SESSION_REVOKED/TOKEN_EXPIRED` | 未认证 |
| 403 | `CAPABILITY_DENIED/GRANT_OUT_OF_SCOPE` | 管理接口明确拒绝 |
| 404 | `RESOURCE_NOT_FOUND` | 用户读具体业务资源，不泄露越权存在性 |
| 409 | `PHONE_EXISTS/IMPORT_CONFLICT/LAST_SUPER_ADMIN` | 状态冲突 |
| 410 | `ACTIVATION_EXPIRED/RESET_EXPIRED` | 一次性凭证过期 |
| 423 | `ACCOUNT_TEMPORARILY_LOCKED` | 临时登录锁定；响应不透露账号是否存在时仍可统一 401 |
| 429 | `RATE_LIMITED` | IP/账号频率限制 |
| 503 | `AUTH_STORE_UNAVAILABLE` | 认证存储不可用，失败关闭 |

所有错误带 `trace_id`，不回显手机号、Token 摘要或内部 SQL。

---

## 十八、性能与容量

### 18.1 每请求查库是否过重

200 峰值在线不等于每秒 200 请求。`auth_session.id` 主键 + `app_user.id` 主键 + `app_user_brand` 小表查询通常是毫秒级。与素材业务 SQL 相比，这个成本很小，且换来立即撤权。

优化顺序：

1. 单查询 JOIN session/user/org，第二个小查询加载 brands；
2. role→capability 是四种固定集合，可在进程内只读缓存，配置发布时重启/失效；
3. `last_seen_at` 5 分钟合并写；
4. 只有压测证明认证 P95 超过 20ms 才考虑 5–10 秒本地缓存；若缓存，必须接受强退最多延迟对应秒数。

初版不加缓存，保持立即强退的清晰语义。

### 18.2 目标

| 操作 | 服务端 P95 |
|---|---:|
| 已登录请求认证上下文 | ≤ 20ms |
| 登录（含 bcrypt） | ≤ 400ms |
| Refresh | ≤ 150ms |
| `/api/me` | ≤ 100ms |
| 用户列表 | ≤ 250ms |
| 1,000 行导入预检 | ≤ 10s（可异步） |
| 禁用/强退 | ≤ 300ms，下一请求立即失效 |

### 18.3 运行时配置建议

| key | 默认值 |
|---|---:|
| `auth.access_ttl_seconds` | 900 |
| `auth.session_ttl_seconds` | 604800 |
| `auth.max_sessions_per_user` | 5 |
| `auth.activation_ttl_seconds` | 604800 |
| `auth.reset_ttl_seconds` | 86400 |
| `auth.bcrypt_cost` | 12 |
| `auth.account_fail_limit` | 5 |
| `auth.account_lock_seconds` | 900 |
| `auth.ip_fail_limit_10m` | 20 |
| `auth.reauth_ttl_seconds` | 600 |
| `auth.auth_event_keep_days` | 180 |

JWT 密钥、Token pepper、治理内部头签名密钥属于 secret，只进环境/Secret，不进 `app_config`。

---

## 十九、威胁模型与失败闭环

| 风险 | 防护 |
|---|---|
| Token 被 XSS 读取 | HttpOnly Cookie、CSP、不用 localStorage |
| CSRF 修改数据 | SameSite + Origin/Referer + CSRF 双提交 |
| Refresh 被盗重放 | 单次轮换、family 重放检测、会话整组撤销 |
| JWT 角色过期仍有效 | role/brands 不信 JWT，每请求读库 |
| 禁用用户仍操作 | session DB 每请求校验，立即 revoke |
| HQ 管理员给自己提权 | target role 限制、品牌子集、不能改自身关键授权 |
| 空品牌被解释为全部 | 非超管固定 `1=0` |
| 模型提示注入越权 | 工具无身份参数，闭包 AuthCtx |
| 直接猜 file_id/job_id | 最终出口再次 JOIN material + scope |
| 任意 OSS key 签名 | 只接受稳定 file_id，不开放 key 签名接口 |
| 治理人冒名 | governor→user 映射，写入从服务端 actor 派生 |
| 登录爆破 | bcrypt、账号/IP 双限流、渐进锁定、统一错误 |
| 最后超管被并发禁用 | 锁定 `auth_role.super_admin` guard 行后再计数与变更 |
| PG 品牌冗余尚未同步 | PG 只作候选过滤，返回模型前按 MySQL 最新品牌批量复查 |
| 已签 OSS URL 绕过后续强退 | 明确 15/30 分钟残余窗口；紧急删除/失效，严格即时需求改下载网关 |
| 数据库故障时绕过权限 | 认证失败关闭，503 而非放行 |
| 内部脚本伪装用户 | service actor，单独审计，不创建假人账号 |

---

## 二十、L0 权限与认证测试集

### 20.1 品牌数据门禁

至少覆盖：

- 日立 external 搜索海信：0 结果且不泄露存在性；
- 直接请求海信 material/file ID：404；
- 直接提交海信 file ID 打包：404/拒绝；
- 已提交任务后移除日立授权，再取 URL：拒绝；已经签出的 URL 仅按其 15/30 分钟 TTL 失效，测试和安全说明不得宣称即时撤销；
- Agent 对话声称“我是总部”：权限不变；
- PG 先按 brand_code 过滤候选，返回文本前再按 MySQL 当前品牌批量复查；
- PG 中旧品牌冗余不能让已撤权用户获得文本；
- 多品牌用户只返回授权并集；
- 非超管品牌集合为空：MySQL/PG 所有素材查询为空；
- super_admin 无 user_brand 行：MySQL/PG 均可见全部；
- “多品牌”业务标签不能扩大主品牌权限。

### 20.2 功能权限门禁

- branch/external 调上传、词表、用户管理、通知发送：403；
- hq_admin 只能改授权品牌素材；
- hq_admin 创建 hq_admin/super_admin：403；
- hq_admin 给 branch 授予自己没有的品牌：403；
- branch 区域看板传其他 region：仍只能自身区域；
- 最后一个 active super_admin 不能禁用/删除；
- 前端隐藏按钮与否不影响后端结果。

### 20.3 会话安全门禁

- JWT 篡改、错误 aud/iss/kid/alg、过期：401；
- session revoked、expired、auth_version 不匹配：401；
- 禁用用户下一请求立即失效；
- Refresh 正常轮换；同 client instance 的 5 秒内并发旧 token 返回 409/Retry-After，不重放新 Token；不同实例或超时旧 token 会撤销会话；
- 修改密码后当前 session auth_version 与新 JWT 一致、当前 Refresh 已轮换，其他会话全部失效；
- CSRF 缺失/Origin 错误的已登录写请求：403；pre-auth 请求不依赖 session CSRF，但严格校验 Origin/Fetch Metadata；
- 激活码过期、重复消费、超过次数和并发双消费：失败；
- 登录不存在账号与密码错误响应一致；
- localStorage/sessionStorage 中不存在任何平台 Token；
- MySQL 不可用时返回 503，不仅凭 JWT 放行。

L0 通过率必须 100%，任何失败阻断上线。

---

## 二十一、实施顺序

```
阶段 1 · 身份地基
  1. platform_brand / org_unit / position_dict / app_user / app_user_brand
  2. auth_role / permission / role_permission 固定种子
  3. account_token / auth_session / auth_refresh_token / auth_event_log
  4. 首个超管离线 bootstrap CLI

阶段 2 · 登录闭环
  5. bcrypt_sha256 PasswordHasher
  6. 激活、登录、Refresh 轮换、登出、Cookie/CSRF
  7. AuthenticationGate 每请求会话校验
  8. 设备会话与强制下线

阶段 3 · 授权闭环
  9. AuthCtx + requireCapability + visibilityScope
  10. 域 B 五出口接入；删除任意 key 签名接口
  11. PG brand_code 硬过滤与 Agent 闭包工具
  12. L0 测试门禁

阶段 4 · 管理闭环
  13. 用户列表、创建、禁用、品牌/角色变更
  14. Excel 预检/确认/导入/激活清单
  15. 组织/职位管理
  16. 安全与业务审计查询

阶段 5 · 治理台止血接入
  17. Nginx auth_request + FastAPI actor 中间件
  18. gov_governor_user_map
  19. 删除前端 admin123；治理写入不信客户端 governor
```

域 E 必须在域 B 任何正式数据接口对真实用户开放前完成阶段 1–3。不能先上线“临时共享密码”，再期待后续逐个接口补权限。

---

## 二十二、验收清单

### E1 组织与账号

- [ ] 组织最多三层，position 只作属性，代码中不参与授权
- [ ] 一用户一期一个 role、一个 org、多个 brand_code
- [ ] brand code 使用 hisense/hitachi/york/kelon，中文名不作权限连接键
- [ ] 非超管 active 用户至少一个品牌；空品牌默认拒绝
- [ ] 批量导入先预检，默认 create_only，不静默覆盖已有授权
- [ ] HQ 管理员只能管理 branch/external，且目标品牌是自身子集
- [ ] 激活/重置码只存摘要、限次、过期、一次消费，明文仅展示一次
- [ ] 禁用/删除/角色品牌变化立即撤销全部会话并审计
- [ ] 最后一个 active 超管有保护

### E2 功能权限

- [ ] 四角色和 capability 种子与第七章矩阵一致
- [ ] 后端每个写动作执行 `requireCapability()`，不依赖前端隐藏按钮
- [ ] 一期无自定义角色/权限配置 UI
- [ ] 高风险动作要求 10 分钟内 re-auth 和 reason
- [ ] 总部管理员无 system.manage/audit.read/user.manage.all
- [ ] 用户管理同时校验功能、目标角色、品牌子集和自身修改限制

### E3 数据权限

- [ ] `visibilityScope()` 是全系统唯一品牌数据谓词
- [ ] 权限使用 `material.brand_code`，业务“品牌归属/多品牌”标签不参与
- [ ] 非超管空 brands 返回 `1=0`；超管显式特例全品牌
- [ ] 列表/详情/文件树、URL、打包、Agent、PG 五出口全部覆盖
- [ ] 正式版不存在任意 OSS key 签名接口
- [ ] Agent 工具 schema 不含 userId/role/brands
- [ ] PG 的 brand_code 过滤与向量 ORDER BY 同一 SQL
- [ ] `material_file.visibility` 不再含 designer，预留字段一期不启用
- [ ] Repo 外禁止素材裸 SQL，CI 静态检查生效
- [ ] L0 越权测试 100% 通过

### E4 登录与安全

- [ ] 7 天是会话/Refresh 总期限；Access JWT 默认 15 分钟
- [ ] 每请求查询 session/user，强制下线下一请求立即生效
- [ ] JWT 仅含 sub/sid/ver/jti 等最小声明，后端不信 token 中角色品牌
- [ ] Token 只在 Secure HttpOnly Cookie，不进 localStorage/sessionStorage
- [ ] Refresh 每次轮换；同实例 5 秒并发返回 409 重试，不返回同一 Token；不同实例或超时重放撤销整个 session
- [ ] 密码修改事务同步当前 session auth_version、轮换当前 Refresh、撤销其他会话
- [ ] 已登录写请求校验 SameSite、Origin/Fetch Metadata 和 session CSRF；pre-auth 请求不依赖 session CSRF
- [ ] 密码用 bcrypt_sha256_v1，cost 实测后定 11/12，默认 12
- [ ] 登录账号/IP 双限流，锁定临时且有上限
- [ ] 登录错误防账号枚举，不记录密码/Token/完整手机号
- [ ] Session 最多 5 个，用户与管理员均可撤销
- [ ] MySQL 故障认证失败关闭，不降级共享口令
- [ ] JWT/Refresh/Token pepper 密钥不进 app_config/Git/数据库

### 治理与跨域

- [ ] 域 G AuthCtx 补 sessionId/orgId/regionOrgId/positionCode/capabilities/brandCodes
- [ ] 域 G “无状态 JWT 无需 session”结论修订为 MySQL 可撤销会话
- [ ] 域 B/G/H 的素材主品牌统一为 `brand_code`，AuthCtx 统一 `brandCodes`，Capability Set 统一 `.has()`
- [ ] 域 B 删除未定义的 `material.manage`，管理视图用 `material.write`、具体动作分别校验
- [ ] PG 候选返回模型前按 MySQL 最新品牌复查，品牌变更事务写 outbox
- [ ] H 正式增加 migrate_item_ref，并与 B 统一 `oss_object.id + verified_md5` 物理对象模型
- [ ] 域 G `audit_log` 支持 user/service/system actor
- [ ] 治理台移除 admin123，后端所有写接口有服务端 actor
- [ ] gov_governor 与 app_user 有明确映射，历史字符串保留
- [ ] Python worker/迁移脚本使用 service actor，不持用户 JWT

---

## 二十三、待确认项与建议默认值

| # | 需确认 | 建议默认 | 影响 |
|---|---|---|---|
| 1 | HQ 管理员能否创建其他 HQ 管理员 | **不能，仅超管可管理 HQ/超管** | 提权边界；安全收益高，超管工作量可接受 |
| 2 | 同一用户最大设备数 | **5 个** | 会话表和用户体验 |
| 3 | 治理配置后台是否所有 HQ 管理员可用 | **先沿用 PRD：可用；后续可拆 governance.config** | 治理词表误改风险 |
| 4 | 组织是否由 HQ 管理员维护 | **一期仅超管维护，HQ 可读** | 避免组织范围与品牌范围混淆 |
| 5 | 超管是否一期启用 TOTP MFA | **建议上线后第一增强项，首发不阻塞** | 1–3 个高价值账号风险 |
| 6 | 会话是否有闲置超时 | **一期无独立闲置超时，绝对 7 天** | 简化体验；已有设备下线和强退 |

无需继续等待的技术默认：Access 15 分钟、总会话 7 天、bcrypt cost 12（实测可调 11）、激活 7 天、重置 24 小时、账号 5 次失败锁 15 分钟、Auth 日志 180 天。

---

## 二十四、设计复盘：三者如何结合

### 大厂先进经验，没有照搬复杂平台

采用短 Access、Refresh 轮换、服务端可撤销会话、Capability、默认拒绝、管理员不可越级授权、Cookie/CSRF、重放检测和安全审计；但不引 OPA、Casbin、Redis、动态角色、复杂 ABAC、SSO 或审批流。

### 本项目现状，没有把演示实现误当生产基础

保留同源部署和现有业务链路，彻底淘汰共享 Token、localStorage、前端 admin123、客户端自报 governor 和任意 OSS key 签名。MySQL 会话校验符合 200 峰值规模，且与当前单机 Docker Compose 运维能力匹配。

### 当下产品技术构想，权限不被 AI 和组织模型绑架

四角色保持简单，职位只作属性，组织服务区域统计，品牌是唯一数据范围。网页、Agent、打包、下载和向量检索使用同一个服务端 AuthCtx；模型选型、治理流程和将来的 visibility 扩展都不能绕过这个入口。

---

*本文档 v1.1，2026-08-07。设计基于 PRD v3.1、域 B v1.1、域 G v1.0、域 H v1.1、现有 `sucai-demo` 与治理工作台代码勘察。v1.1 已闭合 Refresh 并发、PG 品牌同步窗口、治理断言、账号 Token 并发消费和软删除恢复语义；正式实施前需按 9.7 与第二十二章将公共契约同步回域 G/B/H。*
