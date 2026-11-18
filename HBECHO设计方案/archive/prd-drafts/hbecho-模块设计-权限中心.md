# 模块设计 · 权限中心

> **archived**（2026-11-18 文档瘦身，刘学奎决定）：2026-08 的子 PRD 素材，其中仍成立的内容已被各 `prd-domain-*.md` 与 spec 吸收。
> **替代**：[`prd-domain-b-access-control.md`](../../prd-domain-b-access-control.md) 与 `b-access-control` spec。
> **禁止用途**：不得作为实现依据，不得照抄旧表名、旧角色矩阵、旧技术选型；只作追溯。

> **文档状态**：`draft`（2026-10-26 由 liuxuekui 从归档恢复为子 PRD 草案，待复核）  
> **复核状态**：未复核。此前 2026-09-02 的 `superseded` 标记作废。  
> **权威关系**：与 [`b-access-control`](../../../.kiro/specs/b-access-control/design.md) 和 [`prd-platform.md`](../../prd-platform.md) 冲突时，以它们为准。  
> **用途**：作为访问控制子 PRD 重写的素材；角色矩阵与范围规则需逐条确认后才可升为 `current`。  
> **禁止用途**：不得作为当前实现合同，不得据此重建旧角色矩阵、旧组织关系或平行账号主档。

---

> 上级文档：《新媒体运营赋能平台 3.0 — 产品与技术设计大纲》§5 角色与权限模型 / §6.A3 权限中心
>
> 关联文档：《模块设计 · 规则引擎》《模块设计 · 指标与看板》
>
> 撰写日期：2026-08-20｜状态：待评审

---

## 1. 范围与结论

### 1.1 本文覆盖

| 领域 | 设计内容 |
|---|---|
| 身份主体 | 用户、业务人员、平台账号三者分离；邀请、激活、禁用、离职与调岗 |
| 角色 | 超级管理员、总部人员、分公司人员、经销商人员四类固定业务角色 |
| 功能权限 | 页面、资源、动作三级权限点；角色模板与个人例外 |
| 数据权限 | 品牌、组织子树、本人/本店等范围；按资源类型声明 `ScopeStrategy` |
| 人员管理 | 逐级收缩的增删改查边界、可授予角色边界、批量导入和调岗 |
| 授权执行 | 前端能力清单、后端权限守卫、Repository 数据范围强制注入、异步任务范围快照 |
| 审计与风控 | 关键操作审计、双人复核、越权告警、缓存失效、紧急封禁 |

### 1.2 核心结论

本项目不应采用“只有四个角色、接口里到处写 `if role === ...`”的简单 RBAC，而应采用：

> **固定角色 RBAC + 组织关系 ReBAC + 条件约束 ABAC + 按资源声明的数据范围策略**

四类角色负责回答“默认能做什么”；用户与组织的关系负责回答“能管哪一棵组织子树”；品牌、本人、对象状态、敏感级别等条件负责回答“这次操作是否允许”。对调用方只暴露两个深接口：

```ts
interface AuthorizationModule {
  authorize(input: AuthorizationRequest): Promise<AuthorizationDecision>;
  buildDataScope(input: DataScopeRequest): Promise<ScopedQuery>;
}
```

复杂性全部收口在权限模块内部。前端、业务模块、Worker 和 AI 工具不得自行解释角色。

### 1.3 设计目标（可验收）

1. 四个角色登录后，只能看到允许的菜单、页面、按钮和数据。
2. 超级管理员可管理全部人员；总部人员只能管理授权品牌下的分公司和经销商人员；分公司人员只能管理本分公司下的经销商人员；经销商人员不能管理他人。
3. 用户即使绕过前端直接调用接口，也无法越权；权限判断失败返回明确的 403 与审计编号。
4. 新增一种业务资源时，如果没有声明 `ScopeStrategy`，系统默认拒绝访问。
5. 同一张总部配置的看板，分公司人员只看到本区，经销商人员只看到本人。
6. 权限变更后，旧会话和权限缓存最迟 60 秒失效；禁用、离职、密码重置等高风险事件立即失效。
7. 任何批量导出、重算、AI 取数等异步任务都固化下单时的权限范围，Worker 不以系统全权身份裸跑。

---

## 2. 领域模型与术语

### 2.1 三类对象必须分开

| 对象 | 含义 | 示例 |
|---|---|---|
| `User` | 能登录系统的身份主体 | 总部运营经理张三的登录账号 |
| `Staff` | 业务中的自然人档案 | 经销商新媒体专员李四 |
| `PlatformAccount` | 抖音、视频号、小红书、快手账号 | 某门店的抖音主页账号 |

三者不能合表：一个 `Staff` 可能暂未开通 `User`；一个 `Staff` 可绑定多个平台账号；总部人员有 `User` 但通常没有社媒 `PlatformAccount`；人员离职时需要禁用登录，但历史内容、活动和判定仍引用原人员档案。

### 2.2 组织模型

在总纲既有主档基础上，明确区分“组织授权树”和“业务分类维度”：

```text
组织授权树：
品牌 Brand
  └─ 大区 Region
      └─ 分公司 Branch
          └─ 经销商/门店 Dealer
              └─ 业务人员 Staff
                  └─ 平台账号 PlatformAccount

业务分类维度：
板块 Sector（氟机/水机） ──关联──> Dealer
```

这是对总纲“A2 七层主档”表述的细化：`Sector` 仍可保留独立主数据表，并继续用于活动参与范围、标准图选择、报表筛选和 ADS 聚合，但它与 `Dealer` 是分类关系，**不进入 `org_nodes / org_closure` 的授权父子链**。不能把板块当作组织父节点，否则同一分公司的板块变化会破坏组织范围继承。本文后续所称“组织层级”均不包含 `Sector`。

为高效判断祖先/后代关系，在保持 `brands / regions / branches / sectors / dealers` 主表不变的前提下，增加统一组织投影与闭包：

- `org_nodes`：把品牌、大区、分公司、经销商投影为统一节点；只保存授权所需的稳定标识，不替代业务主表。
- `org_closure`：`ancestor_id / descendant_id / depth`，用于查询某范围根下的全部后代。
- 组织关系变更通过主数据模块写入，并同步更新闭包；禁止业务模块直接维护闭包。
- 历史报表继续使用判定时点的 `org_snapshot`，权限判断使用当前组织归属。两者不能混用。

### 2.3 四类业务角色

| 角色编码 | 中文名 | 归属要求 | 默认范围 |
|---|---|---|---|
| `super_admin` | 超级管理员 | 平台级，不挂组织 | 全品牌、全组织、全功能 |
| `hq_staff` | 总部人员 | 至少授权一个品牌，可多品牌 | 授权品牌的全部大区、分公司、经销商与人员 |
| `branch_staff` | 分公司人员 | 必须挂一个分公司 | 该分公司及全部下属经销商与人员 |
| `dealer_staff` | 经销商人员 | 必须挂一个经销商，并关联业务人员 | 默认仅本人、本人平台账号与本人任务 |

“经销商人员”是正式角色名；既有文档中的“经销商个人”统一视为同一角色。四个角色的技术编码以共享领域包 `packages/domain` 中唯一的 `RoleCode` 为准：

```ts
type RoleCode = 'super_admin' | 'hq_staff' | 'branch_staff' | 'dealer_staff';
```

指标看板旧示例中的 `hq_admin / hq_user / branch_user` 属于设计期旧枚举，落地前分别迁移为 `hq_staff / hq_staff / branch_staff`；`hq_admin` 不形成第五个角色，其额外能力通过权限点表达。数据库、Dashboard JSON、前端路由和审计日志不得各自维护角色字符串。

角色表达权限等级，门店/分公司/品牌表达数据范围，两者不得混成几十个诸如“华北海信总部管理员”的角色。

### 2.4 V1 的角色约束

- 一个用户只有一个业务角色级别，避免多个角色求并集后产生隐蔽提权。
- `hq_staff` 必须授权至少一个品牌，可负责一个或多个品牌；品牌范围由超级管理员授予。
- `branch_staff` 同一时刻只属于一个分公司；需要跨分公司管理时应使用 `hq_staff`，不通过追加分公司范围制造例外。
- `dealer_staff` 同一时刻严格一人一店，只绑定一个有效经销商；调店必须关闭旧归属区间后再建立新关系。
- 未来若确有“一人多岗位”需求，再开放多 `RoleAssignment`，但禁止不同管理级别直接求并集。

---

## 3. 授权模型

### 3.1 一次授权决策的五个输入

```text
Subject   谁：userId、role、品牌授权、组织范围、账号状态
Action    做什么：user.create、campaign.publish、report.export
Resource  对什么：用户、活动、内容、课程、报表模板
Context   什么条件：对象状态、请求时间、IP、是否本人、任务费用
Policy    适用策略：角色权限、个人覆盖、ScopeStrategy、风控规则
```

授权结果不是简单布尔值：

```ts
type AuthorizationDecision =
  | { allowed: true; decisionId: string; obligations: Obligation[] }
  | {
      allowed: false;
      decisionId: string;
      reasonCode:
        | 'MISSING_PERMISSION'
        | 'OUT_OF_SCOPE'
        | 'TARGET_ROLE_TOO_HIGH'
        | 'RESOURCE_STATE_FORBIDDEN'
        | 'STEP_UP_REQUIRED'
        | 'APPROVAL_REQUIRED'
        | 'ACCOUNT_DISABLED';
    };
```

`obligations` 可要求字段脱敏、二次认证、审批、限制导出行数、写审计日志等。这样高风险条件不必散落在业务代码。

### 3.2 功能权限点命名

统一采用 `resource.action`，动作使用固定词表：

- `view`：查看详情
- `list`：查看列表
- `create`：新建
- `update`：修改
- `disable`：停用/离职，不使用物理删除
- `restore`：恢复
- `publish`：发布、生效
- `approve`：审批
- `assign`：分配/下发
- `export`：导出
- `configure`：配置模板或规则
- `execute`：触发同步、重算等任务
- `audit`：查看审计信息

权限点示例：`user.create`、`user.disable`、`rule.publish`、`report.configure`、`report.export`、`task.assign`。

不得使用 `user.manage` 这类大权限包；它无法区分查看、改组织、禁用、重置密码等风险不同的动作。

### 3.3 角色模板与个人覆盖

有效权限计算顺序：

```text
角色模板权限
  + 用户临时 ALLOW（必须有原因、授予人、起止时间）
  - 用户显式 DENY
  - 账号状态/对象状态/风控约束
  = 本次有效功能权限
```

规则：

1. `DENY` 优先于 `ALLOW`。
2. 个人 `ALLOW` 不得超出授予人的“可授予权限集合”和管理范围。
3. 临时提权默认最长 30 天，到期由系统自动回收并写审计记录。
4. 超级管理员权限不可通过普通个人覆盖剥离；超级管理员的新增/移除走专门流程。
5. 角色模板由系统预置，V1 不开放业务自建第五种角色；允许超级管理员调整权限矩阵，但需要影响预览、审批和审计。

### 3.4 可授予权限不等于本人拥有权限

借鉴云 IAM 的权限边界概念，为每种角色定义 `GrantBoundary`：

| 操作者 | 可创建/授予的目标角色 | 最大可授予范围 |
|---|---|---|
| 超级管理员 | 四种角色 | 全平台；但不得删除最后一名有效超级管理员 |
| 总部人员 | `branch_staff`、`dealer_staff` | 自己获授权的品牌及其后代组织 |
| 分公司人员 | `dealer_staff` | 自己所属分公司下的经销商 |
| 经销商人员 | 无 | 无 |

即使总部人员通过个人例外获得了 `user.create`，也不能创建总部人员或超级管理员。此限制由 `GrantBoundary` 强制，不依赖前端选项隐藏。

---

## 4. 人员管理：逐级收缩的增删改查

### 4.1 总体矩阵

| 操作者 | 查看超级管理员 | 管理总部人员 | 管理分公司人员 | 管理经销商人员 | 管理自己 |
|---|---:|---:|---:|---:|---:|
| 超级管理员 | 查看；增减需高风险流程 | 增删改查全部 | 增删改查全部 | 增删改查全部 | 可改资料，安全项需二次认证 |
| 总部人员 | 不可查看名单 | 只看本人；不可管理同级 | 可管理授权品牌内 | 可管理授权品牌内 | 可改本人资料，不可自提权/改范围 |
| 分公司人员 | 不可见 | 不可见 | 可查看同分公司全部工作人员；不可管理同级 | 可管理本分公司内 | 可改本人资料，不可自提权/改范围 |
| 经销商人员 | 不可见 | 不可见 | 不可见 | 只看本人，不可管理他人 | 可改有限资料 |

“删”统一实现为禁用/离职，不物理删除。用户、人员、账号、历史任务、判定证据和审计记录必须可追溯。

“同一分公司人员互相可见”定义为：分公司人员可查看同分公司其他工作人员的人员列表、姓名、岗位、角色和账号状态，用于内部协作；这不包含修改、禁用、调岗、重置密码、查看权限配置或为同级授权。完整手机号仍由独立的 `user.pii.view` 控制，本文仅确认总部人员默认拥有该权限。

### 4.2 各动作的精确定义

#### 创建

- 超级管理员可创建任意角色，创建总部人员时必须指定品牌范围。
- 总部人员可创建分公司人员和经销商人员；目标组织必须落在其授权品牌内。
- 分公司人员只能创建本分公司下经销商人员。
- 创建采用邀请制：先建人员/用户草稿并生成一次性激活凭证，由管理员复制给本人，本人设置密码后激活。
- 手机号或邮箱冲突时不静默复用账号，进入“关联既有人员/申请合并”流程。

#### 查看

- 人员列表按“可见范围”返回：超级管理员看全部；总部人员看授权品牌下的分公司/经销商人员；分公司人员可看同分公司工作人员和本区经销商人员；经销商人员仅本人。
- “可见”与“可管理”分离：同级人员可见不代表可修改；所有写操作仍校验目标角色低于操作者和 `GrantBoundary`。
- 超级管理员和总部人员默认拥有 `user.pii.view`，可查看其范围内完整手机号，每次查看留审计；分公司人员默认看到同级手机号掩码，是否开放可后续通过权限点调整。
- 批量导出手机号需独立的 `user.pii.export`；默认超级管理员拥有，总部人员可由超级管理员按品牌授予。

#### 修改

普通资料与权限敏感字段分开：

| 字段类别 | 示例 | 规则 |
|---|---|---|
| 个人资料 | 姓名、头像、联系邮箱 | 本人可改；手机号变更需验证码 |
| 业务资料 | 职位、经销商联系人信息 | 上级管理员可改 |
| 组织归属 | 品牌、分公司、经销商 | 走调岗/转店流程，记录生效时间，不直接覆盖 |
| 权限资料 | 角色、范围、个人权限 | 仅有授权能力的上级可改；本人绝不可改 |
| 安全资料 | 重置密码、解除 MFA、解锁 | 独立权限点 + 强审计；高风险时二次认证 |

#### 禁用/离职

- 禁用后立即撤销全部会话、刷新令牌、未使用邀请和个人临时权限。
- 不删除历史 `Staff` 和平台账号归属记录；写入 `effective_to`。
- 对未完成任务执行可配置策略：转交上级、转交指定人员或保留待处理。
- 禁用最后一名有效超级管理员必须拒绝。
- 批量禁用超过阈值（建议 20 人）需要审批。

#### 恢复

恢复前重新校验手机号唯一性、组织是否仍有效、原角色是否允许；临时权限不自动恢复。

### 4.3 调岗和转店不是普通 UPDATE

调岗采用命令：

```ts
transferStaff({
  staffId,
  fromOrgId,
  toOrgId,
  effectiveAt,
  taskHandoverToUserId?,
  reason
})
```

执行时：

1. 校验操作者同时有权管理来源与目标组织；否则上提到共同上级审批。
2. 关闭旧 `staff_org_relations` 生效区间，新增关系，禁止重叠。
3. 历史内容和已结算活动保留原 `org_snapshot`。
4. 生效时重新计算用户范围、撤销会话，并为本人及双方管理员生成可查询的调岗记录。
5. 未完成任务按交接策略处理。

跨品牌调岗仅超级管理员可执行；总部人员不能把人员移出自己的品牌范围。

### 4.4 批量导入

沿用项目复盘提出的三阶段模式：

```text
上传并解析 → 冲突报告与人工确认 → 事务化应用
```

权限规则：模板只允许填操作者可授予的角色与组织；解析阶段就报告越权行；应用阶段重新鉴权，防止等待确认期间操作者权限已变化。批量操作每行独立给出结果，但同一个人员相关表在单行内必须事务一致。

---

## 5. 四角色功能、页面与动作矩阵

符号：`●` 全功能，`◐` 受限功能，`○` 只读，`—` 不可见。

| 模块/页面 | 超级管理员 | 总部人员 | 分公司人员 | 经销商人员 |
|---|---:|---:|---:|---:|
| 四品牌系统总览 | ● | — | — | — |
| 本品牌运营大盘 | ● | ● 授权品牌 | ○ 本区汇总 | ○ 本人卡片 |
| 组织主数据 | ● | ● 维护授权品牌内分公司/经销商 | ○ 本分公司组织 | — |
| 人员与用户 | ● | ◐ 管理下级 | ◐ 查看同分公司同级、管理经销商人员 | ○ 本人 |
| 角色权限矩阵 | ● | ○ 仅看与本人相关说明 | — | — |
| 审计中心 | ● | ◐ 本品牌业务审计 | ◐ 本分公司人员操作 | ○ 本人登录与安全日志 |
| 数据同步与稽核 | ● | ● 授权品牌 | ○ 本区 | ○ 本人账号状态 |
| 账号台账 | ● | ● 授权品牌 | ● 本区 | ○ 本人账号 |
| 内容库 | ● | ● 授权品牌 | ● 本区 | ○ 本人内容与授权案例 |
| 活动管理 | ● | ● 授权品牌 | ◐ 查看、执行、区内催办 | ◐ 查看参与活动与回报 |
| 规则/考核项配置 | ● | ● 授权品牌 | ○ 查看生效口径与证据 | ○ 查看本人相关口径与证据 |
| 指标定义 | ● 内置+自定义 | ◐ 品牌自定义 | — | — |
| 看板/报表模板配置 | ● | ● 授权品牌 | — | — |
| 明细表个人视图 | ● 保存本人视图 | ● 保存本人视图/共享品牌视图 | ◐ 保存本人列显示/列序 | ◐ 保存本人列显示/列序 |
| 点检表/明细表 | ● | ● 授权品牌 | ○ 本区，可导出本区 | ○ 本人明细 |
| 运营任务 | ● | ● 全授权范围下发 | ● 本区下发 | ◐ 接收、回报 |
| 学习内容管理 | ● | ● 授权品牌 | — | — |
| 学习任务 | ● | ● 授权品牌下发 | ● 本区下发 | ◐ 学习与考试 |
| 知识库 | ● | ● 上传/审核授权品牌 | ○ 使用 | ○ 使用 |
| AI 内容工具 | ● | ● | ● | ●，数据仅本人 |
| 配额与成本 | ● 全平台配置 | ○ 本品牌用量 | ○ 本区用量 | ○ 本人用量（可选） |
| 系统配置与算子注册 | ● | — | — | — |

### 5.1 页面权限不是安全边界

后端登录后返回 `CapabilityManifest`：

```json
{
  "role": "branch_staff",
  "permissions": ["user.list", "user.create", "task.assign", "report.view", "report.export"],
  "brands": ["hisense"],
  "scopeRoots": [{"type": "branch", "id": 21}],
  "routes": ["/workspace", "/people/dealers", "/tasks", "/reports"],
  "version": 108
}
```

前端据此生成菜单与按钮，改善体验；后端仍逐请求鉴权。禁止只在前端隐藏按钮、后端默认放行。

### 5.2 同一页面可以有不同工作形态

不为四角色复制四套页面。优先复用同一页面配置，通过能力与范围改变：

- 总部打开人员页：有分公司/经销商筛选、创建两类下级人员。
- 分公司打开人员页：范围锁定本分公司，只能创建经销商人员。
- 经销商打开个人中心：只显示本人，不暴露组织人员列表。
- 同一看板配置由查看者的 DataScope 过滤数据。

只有首页工作台这种信息架构明显不同的场景，才维护四类默认看板。

---

## 6. 数据范围 DataScope

### 6.1 标准范围结构

```ts
type BrandCode = 'hisense' | 'hitachi' | 'york' | 'kelon';
type OrgNodeId = number;

type DataScope = {
  brandCodes: BrandCode[] | '*';
  orgRootIds: OrgNodeId[] | '*';
  subjectMode: 'ALL_IN_ORG' | 'SELF_ONLY';
  staffId?: number;
  constraints: {
    validFrom?: string;
    validTo?: string;
    allowedPlatforms?: string[];
  };
  version: number;
};
```

品牌跨环境使用稳定业务编码 `BrandCode`，组织节点和人员使用数据库数值 ID；在线鉴权、缓存键、审计和异步范围快照必须复用同一份版本化 Zod schema，禁止把 `brandCodes` 混写为数据库 ID。

角色到默认范围：

- 超级管理员：`* / * / ALL_IN_ORG`
- 总部人员：授权品牌 + 对应品牌组织根 / `ALL_IN_ORG`
- 分公司人员：所属分公司节点 / `ALL_IN_ORG`
- 经销商人员：所属经销商节点 + `SELF_ONLY / staffId`

### 6.2 DataScope 是按资源解释的

| 资源类型 | ScopeStrategy | 规则 |
|---|---|---|
| 业务数据（账号、内容、判定、指标） | `BusinessDataScope` | 品牌 AND 组织后代 AND 经销商本人 |
| 用户与人员 | `UserManagementScope` | 读：按角色可见矩阵；写：数据范围 + 目标角色低于操作者 + GrantBoundary |
| 活动 | `CampaignScope` | 查看要求活动范围与用户范围有交集；创建/修改要求参与范围被用户范围完全覆盖 |
| 运营任务 | `OperationalTaskScope` | 管理者可向范围内人员下发和催办；经销商只能接收、回报本人任务 |
| 学习任务 | `LearningAssignmentScope` | 总部/分公司可向授权范围下发；经销商只能查看和完成本人任务 |
| 学习内容 | `LearningContentScope` | 只按品牌、不按分公司下钻：超管全部品牌，总部授权品牌，分公司/经销商所属品牌 |
| 学习进度 | `LearningProgressScope` | 管理者看下属，经销商仅本人 |
| 看板/报表配置 | `ConfigurationScope` | 模板按品牌授权；查看数据另走业务数据策略；所有角色可保存不扩权的个人列视图 |
| 导出任务 | `ExportScope` | 按下单时范围快照执行 |
| 知识库 | `KnowledgeScope` | 品牌 + 知识库可见性；通用库可跨品牌 |
| 系统配置/算子 | `SystemScope` | 仅超级管理员 |
| 审计日志 | `AuditScope` | 超管全量；总部/分公司仅其管辖业务事件；敏感字段再脱敏 |

新增资源必须注册策略：

```ts
scopeRegistry.register('content', businessDataScope);
scopeRegistry.register('course', learningContentScope);
scopeRegistry.register('audit_log', auditScope);
// 未注册 => deny，启动时和 CI 中均检查
```

### 6.3 查询与对象操作的行为

- 列表查询：Repository 自动追加范围过滤，只返回允许行。
- 按 ID 查看/修改：先加载最小授权投影，再判断范围；存在但越权时返回 403，并记录 `decisionId`。
- 批量操作：每个目标都鉴权，默认“全有权才执行”；需要部分成功的导入任务必须逐行返回结果，不能静默跳过。
- 聚合查询：先做范围过滤，再聚合；禁止先算全国结果再在响应层删行。
- 缓存键必须包含 `scopeVersion + brandCodes + orgRootIds + subjectMode`，避免不同范围共用缓存导致泄露。

### 6.4 历史归属与当前权限

必须区分：

- **数据统计归属**：按内容发布/判定时点的 `org_snapshot`，保证历史报表不因调岗改写。
- **当前查看权限**：按当前用户的 DataScope。

例：某门店从 A 分公司转到 B 分公司。历史活动仍计入 A；当前 B 分公司人员能否查看转入前明细，默认不能。若业务需要交接查阅，可创建有期限的历史范围授权，而不是篡改归属。

### 6.5 异步任务与 AI 的权限继承

任务创建时保存：

```json
{
  "requestedBy": 1024,
  "permission": "report.export",
  "scopeSnapshot": {"brandCodes":["hisense"],"orgRootIds":[21],"subjectMode":"ALL_IN_ORG","version":108},
  "requestedAt": "2026-08-20T10:00:00+08:00"
}
```

Worker 只按快照读取，不升级为全局权限。若用户在执行前已被禁用，涉及导出、AI 取数等数据外发任务应取消；纯内部聚合任务可按策略继续。AI 工具调用必须传递用户身份和 DataScope，禁止模型生成自由 SQL。

---

## 7. 高风险操作与审批

### 7.1 风险分级

| 等级 | 示例 | 控制 |
|---|---|---|
| L0 普通 | 查看本人数据、保存个人视图 | 常规鉴权 |
| L1 业务写 | 创建任务、修改人员普通资料 | 鉴权 + 审计 |
| L2 敏感 | 导出明细、重置他人密码、修改组织归属、发布规则 | 二次认证或审批 + 审计 |
| L3 高危 | 新增超管、批量禁用、跨品牌调岗、修改角色模板、全量历史重算 | 双人复核 + 二次认证 + 高级别安全事件 |

### 7.2 双人复核规则

- 申请人与审批人不得是同一人。
- 审批人必须拥有相应 `*.approve` 且范围覆盖目标。
- 审批基于操作快照；目标、范围或参数变化后原审批作废。
- 批准有有效期，超时需重新申请。
- 紧急封禁账号允许先执行后补审，但仅超级管理员可用，且立即告警。

### 7.3 超级管理员保护

1. 建议至少保留 2 名、最多 5 名日常超级管理员。
2. 不允许禁用或降级最后一名有效超级管理员。
3. 新增/移除超级管理员必须由另一名超级管理员审批。
4. 强制 MFA、短会话、敏感操作二次认证。
5. 超管账号不用于日常运营；普通业务应使用总部人员账号。
6. 建议保留一个离线保管的应急账号，使用即产生最高级别告警。

---

## 8. 权限模块接口与执行链路

### 8.1 请求链路

```text
认证中间件
  → 读取 UserSession（userId / sessionVersion）
  → AuthorizationGuard 校验 resource.action
  → ScopeResolver 计算 DataScope
  → Repository 注入范围谓词
  → Service 执行业务不变量
  → AuditRecorder 记录决策与结果
```

业务模块不得接收客户端传来的 `brandId/branchId` 就直接信任；这些值只能作为查询条件，再与 DataScope 求交集。

### 8.2 推荐接口

```ts
interface AuthorizationModule {
  authorize(request: {
    subjectId: string;
    permission: PermissionCode;
    resource?: ResourceRef;
    context?: Record<string, unknown>;
  }): Promise<AuthorizationDecision>;

  buildDataScope(request: {
    subjectId: string;
    resourceType: ResourceType;
    action: Action;
  }): Promise<DataScope>;

  getCapabilityManifest(subjectId: string): Promise<CapabilityManifest>;

  invalidateSubject(subjectId: string, reason: string): Promise<void>;
}
```

这是一个深模块：调用方只需要说明主体、动作和资源，模块内部负责角色、个人覆盖、组织后代、状态、审批、风控和审计义务。

### 8.3 缓存与一致性

- Redis 缓存 `CapabilityManifest` 与 DataScope，键包含 `authorization_version`。
- 每次角色、范围、状态、个人权限变化时，事务内递增用户版本，并通过事件删除缓存。
- Access Token 只保存 `userId/sessionId` 等稳定信息，不内嵌长期权限全集。
- 普通权限变更最迟 60 秒生效；禁用、离职、锁定、重置密码通过 `session_version` 立即使所有会话失效。
- 若 Redis 不可用，权限读取回源数据库；不得失败后默认放行。

---

## 9. 数据模型方向

以下为方向性模型，字段细节在 Prisma schema 阶段落定。

### 9.1 身份、角色和权限

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | `id, staff_id?, mobile, email, status, session_version, authorization_version` | 登录主体；手机号/邮箱规范化后唯一 |
| `roles` | `id, code, name, level, system_locked` | 四个固定角色模板 |
| `permissions` | `id, code, resource, action, risk_level` | 权限点注册表 |
| `role_permissions` | `role_id, permission_id` | 角色默认权限 |
| `user_permission_overrides` | `user_id, permission_id, effect, valid_from, valid_to, reason, granted_by` | 个人允许/拒绝 |
| `user_scope_grants` | `user_id, brand_id, org_node_id, valid_from, valid_to, source, granted_by` | 用户当前范围根 |
| `user_invitations` | `user_id, token_hash, expires_at, used_at` | 邀请激活，不存明文 token |
| `sessions` | `id, user_id, refresh_hash, device, ip, expires_at, revoked_at` | Redis 为在线会话，数据库保留安全审计投影 |

### 9.2 组织与人员

| 表 | 关键字段 | 说明 |
|---|---|---|
| `org_nodes` | `id, node_type, business_id, brand_id, parent_id, status` | 授权用统一组织投影 |
| `org_closure` | `ancestor_id, descendant_id, depth` | 组织子树判断 |
| `staffs` | `id, name, mobile, status` | 自然人档案 |
| `staff_org_relations` | `staff_id, org_node_id, relation_type, effective_from, effective_to` | 人员归属历史，区间不得重叠 |
| `platform_accounts` | `id, platform, platform_uid, canonical_url, raw_input, resolve_state, status` | 平台账号一等实体；身份锚点是平台内稳定 UID，不是 URL |
| `staff_accounts` | `staff_id, platform_account_id, is_primary, effective_from, effective_to` | 人与平台账号历史绑定；同一账号同一时刻只能有效绑定一人 |
| `account_dealer_bindings` | `platform_account_id, dealer_id, effective_from, effective_to, source` | 账号到门店的唯一有效归属，历史冲突进入 B7 稽核 |
| `account_binding_events` | `platform_account_id, event_type, old_staff_id, new_staff_id, evidence, operator_id` | 换号、换绑、纠错与争议事件，不原地抹除证据 |
| `staff_transfer_events` | `staff_id, from_org, to_org, effective_at, reason, operator_id` | 调岗事件 |

### 9.3 审批与审计

| 表 | 关键字段 | 说明 |
|---|---|---|
| `approval_requests` | `type, applicant, payload_hash, payload, status, expires_at` | 高风险操作申请 |
| `approval_actions` | `request_id, approver, action, comment, created_at` | 审批轨迹 |
| `audit_logs` | `actor, action, resource, decision_id, scope_snapshot, before, after, result, request_id` | 追加写，不允许业务修改 |
| `security_events` | `type, severity, subject, ip, details, status` | 越权、异常登录、批量敏感操作 |

### 9.4 关键数据库约束

- `roles.code`、`permissions.code` 唯一；`RoleCode` 只来自共享领域包。
- 同一用户的有效角色级别 V1 只能有一个。
- `platform_accounts` 使用受控平台枚举，并建立 `UNIQUE(platform, platform_uid)`；URL 只作展示和证据，不作身份唯一键。
- 同一 `platform_account_id` 的有效 `staff_accounts` 和 `account_dealer_bindings` 区间均不得重叠；重叠不是“共享”，而是数据异常并进入 B7 稽核。
- 同一 `staff_id + platform` 同一时刻最多一个 `is_primary = true` 主账号，供规则引擎账号类考核使用。
- `staff_org_relations` 同类关系的有效期不得重叠。
- 经销商用户必须存在唯一有效的 `staff_id`，且同一 `staff_id` 同一时刻只能有一个有效经销商归属；数据库约束与写入事务共同阻止一人多店。
- 平台账号导入报告必须显式列出：无法解析身份、`(platform, platform_uid)` 跨人员/跨门店冲突、主账号重复、有效期重叠；确认后才能事务化应用。
- 个人权限覆盖必须有 `granted_by/reason`，临时允许必须有 `valid_to`。
- 审计日志采用追加写；数据库账号不授予 UPDATE/DELETE。
- 物理删除用户、人员和组织的接口不存在。

---

## 10. 安全、隐私与合规

1. 手机号、邮箱加密存储；查询使用规范化哈希列，展示按权限点决定完整值或脱敏值。
2. 密码使用强哈希；一次性激活凭证和验证码只存哈希、短有效期、单次使用。
3. 超级管理员和总部人员建议强制 MFA；高风险操作要求最近 10 分钟内二次认证。
4. 登录限速同时按账号、IP、设备指纹；异常登录写入 `security_events`。
5. 权限拒绝、批量导出、查看完整手机号和批量敏感操作均写审计。
6. 数据下载链接短时有效、一次签名，并在下载时再次检查账号状态与 DataScope。
7. 禁止通过导出任务、Worker 或 AI 工具绕过 DataScope。
8. 审计日志中的手机号默认脱敏，原值仅在受控调查流程中解密。

---

## 11. 关键场景推演

### 场景 A：总部创建分公司人员

总部用户有 `user.create`，目标角色为 `branch_staff`，目标分公司属于其授权品牌。功能权限、GrantBoundary、DataScope 均通过，创建用户草稿与一次性激活凭证。若目标分公司在另一未授权品牌，拒绝 `OUT_OF_SCOPE`。

### 场景 B：总部试图创建另一个总部人员

即便页面参数被篡改，GrantBoundary 不允许 `hq_staff → hq_staff`，返回 `TARGET_ROLE_TOO_HIGH`。不能依赖下拉框不显示总部角色。

### 场景 C：分公司管理员把经销商人员调到另一分公司

其有权管理来源，但无权管理目标，命令拒绝。应由总部发起，或由双方共同上级审批。

### 场景 D：经销商直接请求他人的内容 ID

`content.view` 功能可能存在，但 `BusinessDataScope` 的 `SELF_ONLY` 不包含目标 `staffId`，返回 403 并记越权事件。连续发生可触发安全告警。

### 场景 E：总部配置看板，分公司打开

看板配置按品牌可见；卡片查询按查看者当前 DataScope 执行。分公司只看到自己及下属经销商，不会看到同级分公司。

### 场景 F：人员调岗后查看历史活动

历史指标仍按原 `org_snapshot` 归集。新分公司无权查看调岗前明细；旧分公司保留对原活动数据的统计可见性，但敏感人员资料按当前策略脱敏。

### 场景 G：导出排队期间用户被禁用

任务已保存范围快照，但导出属于数据外发。Worker 开始前检查账号状态，发现禁用后取消任务、不生成文件，并写入任务失败原因和审计日志。

### 场景 H：同分公司人员查看同级

分公司人员可以在人员列表查看同分公司其他工作人员的基本资料，但尝试修改同级角色、禁用账号或重置密码时，写操作因目标角色不低于操作者而被 `GrantBoundary` 拒绝。

### 场景 I：经销商专员调店

经销商专员同一时刻严格一人一店。调店必须先关闭旧 `staff_org_relations` 和账号门店绑定的有效区间，再建立新归属；事务中检测到时间区间重叠时整笔拒绝，历史活动继续使用原 `org_snapshot`。

---

## 12. 验收清单

### 12.1 权限正确性

1. 四角色的菜单、路由、按钮符合矩阵。
2. 直接调用前端隐藏的接口仍被后端拒绝。
3. 超管能管理所有人；总部只能管理授权品牌下分公司/经销商人员；分公司只能管理本区经销商人员；经销商只能管理本人有限资料。
4. 总部不能创建或管理总部同级人员，分公司不能修改、禁用或授权分公司同级人员。
5. 总部人员可维护授权品牌内的分公司和经销商主档，不能越权维护未授权品牌。
6. 总部账号分别配置单品牌和多品牌范围时，菜单能力相同、数据范围分别正确。
7. 分公司人员可查看同分公司其他工作人员基本资料，但同级写操作被拒绝。
8. 超级管理员和总部人员可查看权限范围内完整手机号，查看行为进入审计；分公司同级默认展示掩码。
9. 任意角色都不能修改自己的角色、范围和个人权限。
10. 最后一名超级管理员不能被禁用或降级。
11. 新增未注册 `ScopeStrategy` 的资源默认拒绝；所有 `ResourceType` 与 registry 做双向完整性检查，覆盖任务、学习、审计、导出、Worker 和 AI 工具入口。
12. 列表、详情、聚合、导出、Worker、AI 工具六条路径的数据范围一致；看板、报表、导出、AI 问数在同一身份下范围一致。
13. 权限变更后缓存按要求失效；禁用立即踢出全部会话。

### 12.2 人员与组织

14. 调岗生成历史关系而非覆盖；有效期不重叠，调岗前活动口径不被改写。
15. 经销商专员同一时刻一人一店，不能配置多个有效经销商归属。
16. 批量导入中的越权组织/角色，以及平台账号跨人员/跨门店、主账号重复、有效期重叠等冲突，在解析阶段可见，在应用阶段再次校验。
17. `platform_accounts` 的 `(platform, platform_uid)` 唯一；同一账号同一时刻只归属一人和一家门店；旧数据重叠进入 B7 稽核而不是求并集。
18. 禁用人员不删除历史数据，未完成任务按策略交接。
19. 完整手机号查看、批量导出和重置密码分别使用独立权限点并写审计。

### 12.3 性能与可靠性

20. 权限缓存命中时单次决策 P95 < 10ms；回源数据库 P95 < 50ms（不含业务查询）。
21. 组织范围查询使用闭包表，不对每次请求递归扫描全树。

---

## 13. 建设顺序

### 阶段 1：身份与最小权限闭环

- `users / staffs / roles / permissions / user_scope_grants`
- 四个角色模板
- 登录会话与 `CapabilityManifest`
- `authorize / buildDataScope` 两个核心接口
- 人员 CRUD、邀请、禁用和审计
- 选“人员、内容、报表”三种不同资源打通策略

### 阶段 2：组织历史与高风险治理

- `org_nodes / org_closure`
- 调岗/转店命令与历史关系
- 个人权限覆盖、临时授权
- 审批与二次认证
- 导出、Worker、AI 的范围快照

### 阶段 3：治理与优化

- 越权和异常登录检测
- 权限影响分析、季度权限复核
- 权限缓存、组织闭包和批量鉴权性能优化
- 权限矩阵自动化回归测试

---

## 14. 与既有设计的对齐结论

| 既有决策 | 本文落地 |
|---|---|
| 功能权限与数据范围正交 | `Permission` 与 `DataScope/ScopeStrategy` 分离 |
| 四角色统一 | 唯一 `RoleCode` 为 `super_admin / hq_staff / branch_staff / dealer_staff`，旧枚举迁移 |
| 总部多品牌 | 同一总部用户可授权一个或多个品牌，权限不变、范围取授权品牌集合 |
| 总部维护组织 | 总部可创建、修改授权品牌内分公司和经销商主档 |
| 分公司同级可见 | 同分公司工作人员可互看基本资料，但不能管理同级 |
| 经销商一人一店 | `dealer_staff` 同一时刻只有一个有效经销商归属 |
| 板块不污染授权树 | `Sector` 保留为主数据分类/筛选维度，但不进入组织闭包 |
| 平台账号独占 | `(platform, platform_uid)` 唯一，有效人员/门店绑定区间不得重叠 |
| 数据范围在访问层强制注入 | `buildDataScope` + Repository 注入，不由路由手写 |
| 新资源缺省拒绝 | 未注册 `ScopeStrategy` 直接 deny |
| 分公司点检表只读、限本区 | 矩阵中 `report.view/export` 有、`report.configure` 无 |
| 看板配置与看板数据分离 | 总部可配；所有卡片按查看者范围查询 |
| 经销商仅本人 | `SELF_ONLY + staffId`，不仅是经销商组织范围 |
| 学习内容只按品牌隔离 | `LearningContentScope` 不按分公司下钻 |
| AI 不能成为越权旁路 | 工具继承用户范围，不开放自由 SQL |
| 异步导出范围快照 | 任务固化 DataScope，并在数据外发前复查账号状态 |
| 全链路可审计 | 授权 `decisionId`、范围快照、变更前后与安全事件 |

---

## 15. 业务决策记录

### 15.1 已确认

| # | 事项 | 结论 |
|---|---|---|
| 1 | 总部维护组织主数据 | 总部人员可创建、修改授权品牌内的分公司和经销商主档；跨品牌操作、组织合并和停用仍由超级管理员控制 |
| 2 | 总部查看手机号 | 总部人员默认拥有 `user.pii.view`，可查看授权品牌范围内完整手机号；批量导出仍使用独立权限点 |
| 3 | 分公司同级可见 | 同一分公司工作人员可互相查看基本人员资料，但不能修改、禁用、调岗、重置密码或授权同级人员 |
| 4 | 总部多品牌 | 总部用户可负责一个或多个品牌，DataScope 取其授权品牌集合 |
| 5 | 经销商人员归属 | 同一时刻严格一人一店，不支持一人管理多家门店；调店通过带生效区间的变更流程处理 |
| 6 | 等保建设目标 | 当前是内部小型项目，不以等保 2.0 三级测评为建设或验收目标；继续落实最小权限、敏感字段保护、会话撤销、审计、备份和漏洞修复等基础安全措施，未来若公司或监管提出要求再单独评估 |

当前没有阻塞权限模块一期落地的业务待决项。

---

## 16. 低复杂度安全与工程实践补充

### 16.1 吸收原则

本节吸收同类内部系统中已经证明有效、且不会显著增加建设和运维负担的实践。只吸收认证安全、授权事务和出口复查等通用方法，不共享其他产品的用户库、角色表、组织结构或业务权限矩阵，也不把“品牌是唯一数据范围”等产品特定假设带入本项目。

### 16.2 一期采纳项

| # | 实践 | 本项目落地方式 |
|---|---|---|
| 1 | 短 Access Token + 可撤销 Session | Access Token 默认 15 分钟，只携带 `userId/sessionId/version/jti` 等稳定声明；服务端 Session 为有效性真相，绝不信任 Token 内自报的角色、品牌或权限。Session 总期限默认 7 天，可按环境配置 |
| 2 | Refresh Token 轮换 | Refresh Token 每次使用后换新，只保存带服务端密钥的摘要；检测已轮换 Token 重放时撤销对应会话族。禁用、离职、密码重置和高风险授权变化立即撤销全部会话 |
| 3 | HttpOnly Cookie 与基础 CSRF 防护 | 浏览器端凭证使用 `Secure + HttpOnly + SameSite` Cookie，不进入 `localStorage/sessionStorage`；已登录写请求校验 Origin/Referer 与 CSRF Token。若未来改为原生客户端，再为客户端定义独立凭证流程 |
| 4 | 一次性激活与重置凭证 | 管理员只签发一次性激活/重置凭证，不设置或查看用户正式密码；凭证仅展示一次，数据库只存摘要、有效期、尝试次数和消费状态，并发消费只能成功一次 |
| 5 | 授权变更统一事务 | 创建、恢复、调岗、角色/品牌/组织范围修改统一计算完整目标状态，在一个事务内完成 `GrantBoundary`、组织与角色不变量校验、数据写入、版本递增、会话撤销和审计；普通资料 PATCH 不得修改敏感授权字段 |
| 6 | 默认拒绝 | 未知角色、缺少权限点、空范围、未注册 `ScopeStrategy`、无效组织或认证/权限依赖故障一律拒绝；不得因 Redis、数据库或策略加载失败而降级放行 |
| 7 | 最终数据出口复查 | 列表入口鉴权不能替代最终出口鉴权。下载、导出、Worker、AI 工具在读取或交付数据前再次检查账号状态与有效 DataScope；短时签名 URL 只在复查后签发，不持久化为长期访问凭证 |
| 8 | AI/Agent 不接受身份参数 | AI 工具通过服务端上下文继承 `subjectId` 和 DataScope，工具参数中不提供可由模型填写的 `userId/role/brands/orgRoots`；提示词注入不能改变调用身份或扩大范围 |
| 9 | 基础登录防护 | 登录按账号与 IP 限速；不存在账号、密码错误、未激活和已禁用对外使用统一错误，避免枚举；密码使用成熟强哈希，修改密码后撤销其他会话；安全异常进入 `security_events` |
| 10 | 安全事件与业务审计分流 | 登录、刷新、重放、锁定和会话撤销进入安全事件；人员、组织、角色、范围和敏感数据访问进入业务审计。两类记录通过 `requestId/traceId/decisionId` 关联，默认脱敏且追加写 |

### 16.3 明确不做

一期不因上述实践引入 OPA/Casbin/Zanzibar、动态自定义角色、跨产品统一用户库、微服务化权限中心、全员强制 MFA 或未经容量验证的额外安全基础设施。Redis 已用于本项目队列和缓存，但权限实现仍必须支持回源数据库并失败关闭，不能把 Redis 可用性变成放宽授权的理由。

默认时长和限流阈值属于 A5 配置项，实施时可依据真实压测调整；调整不得改变“凭证可撤销、身份由服务端构造、授权默认拒绝、最终出口复查”四条不变量。
