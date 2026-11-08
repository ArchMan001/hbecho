# B 访问控制（b-access-control）· 实施计划

> **状态**：`draft`
>
> **执行状态**：未开始（2026-11-06 初建）。任务 0 的「待确认闸门」已通过（2026-11-06，刘学奎：全部按建议采纳）；任务 0 其余文档动作完成且任务 1 的库兼容性验证通过之前，不写迁移，不写实现代码
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：B 访问控制 · **目录命名**：`b-access-control`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21
>
> **最近核对**：2026-11-06
>
> **更新日期**：2026-11-06

## 进度

- [ ] 任务 0 · 文档前置（归档旧设计、订正、INDEX、待确认闸门）— 归档、登记、订正与待确认闸门已完成（2026-11-06）；仍待 B PRD §7.2 措辞对齐与总 PRD §4 核对
- [ ] 任务 1 · better-auth 兼容性验证（S1–S9）与 ADR-0015
- [ ] 任务 2 · schema 与迁移、认证实例与配置、Next 无页面入口、测试挂具（**完成后推第一次**）
- [ ] 任务 3 · Capability 注册表、角色矩阵、授权入口、谓词、服务身份与静态护栏
- [ ] 任务 4 · DataScope、`ScopeStrategy` 注册表与四个自带策略
- [ ] 任务 5 · 登录保护、短信、激活 / 重置 / 改密流程
- [ ] 任务 6 · 用户管理：邀请、边界、变更、停用 / 恢复、强制下线、首个超管
- [ ] 任务 7 · `MediaStaff` 联动与 `access maintain`
- [ ] 任务 8 · 用户批量导入
- [ ] 任务 9 · 审计：持久表、触发器、适配器、清理、读取
- [ ] 任务 10 · 数据出口框架、有效范围、交付复查、撤权取消
- [ ] 任务 11 · 到现有模块的适配、审计装配替换、CLI 收口
- [ ] 任务 12 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾（**完成后推第二次**）
- [ ] 页面任务：**不写**。进入条件见 design §14 第 4 项与 §15.6；N.6 填写确认后再追加

## Planning rules

- 每个任务是一个纵向切片：完成后能运行一条命令或一个测试、看到可验证的结果，而不是只建空表或空 interface。
- 任务边界跑 `./scripts/verify.sh`（typecheck、单元测试、迁移一致、数据库测试、密钥、链接、文档登记）。**不 push**；一个 spec 一条分支 `b-access-control`，只推两次：任务 2 完成后与任务 12 收尾（`dev-ci-cadence`）。
- 默认验收离线：不发真实短信、不连 AI Master / OSS、不发起任何外网请求；MySQL 只用 `scripts/with-test-mysql.sh` 的一次性容器或 `_test` 库。
- 目录按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)：领域代码在 `src/modules/access-control/`、`src/modules/phone/`，`src/app` 只做入口与参数校验，测试与源码同目录，迁移在 `drizzle/`，CLI 在 `src/worker/`，测试设施在 `tests/harness/`。
- **新增依赖**：`better-auth`、`next`、`react`、`react-dom` 已由 ADR-0005 登记；短信官方 SDK 属其 `@alicloud/*` 范围，具体包在任务 5 登记到 ADR-0005 采用清单。不引入任何其他依赖；`csv-parse` 沿用 ADR-0014。
- 所有内部 BIGINT 在 CLI / JSON 输出为十进制字符串；手机号明文（D-42）；**验证码、密码、令牌、Cookie 永不写入日志、审计、回复或仓库**。
- 数据库测试里对争抢同一行锁的操作顺序 `await`，不用 `Promise.all`；并发用例用显式闸门（design §11）。
- `.env` 只列键名，不读值进回复（`server-access.md`）；本地与测试 ECS 的密钥不入库。
- 任务 0 未完成前不写迁移；任务 1 未通过前不写依赖代码。

## 依赖图

```text
任务 0（文档前置 + 待确认闸门）
   ↓
任务 1（better-auth 兼容性验证 + ADR-0015）          ← S1 不通过则停下报告
   ↓
任务 2（schema / 迁移 / 认证实例 / Next 入口 / 挂具）  ──→ 推第一次
   ├──→ 任务 3（Capability + authorize）
   │        ↓
   │     任务 4（DataScope + 策略注册表）
   │        ├──→ 任务 6（用户管理；依赖 3、4、5）
   │        └──→ 任务 10（出口框架；依赖 3、4）
   ├──→ 任务 5（登录保护 + 短信 + 激活流程）
   │        ↓
   │     任务 6 ──→ 任务 7（专员联动）
   │        └────→ 任务 8（用户导入）
   └──→ 任务 9（审计；依赖 2；6、7、8 接入它）
                ↓
任务 11（适配器 + 审计装配替换 + CLI 收口；依赖 3、4、6、7、8、9、10）
                ↓
任务 12（全量验收 + 规模 + ECS + 文档收尾）
```

容易画错的边：

- 任务 9（审计）**不依赖**任务 6，但任务 6 的高风险写入要用它的 `AuditWriter`，所以**接口先于任务 6 定好**：任务 2 里先放 `AuditWriter` 的类型与内存实现，任务 9 换成持久实现；
- 任务 5 **不依赖**任务 6：激活流程用测试工厂直接造待激活用户；
- 任务 7、8 依赖任务 6 的创建 / 停用 / 恢复函数，**不重写**它们；
- 任务 10 不依赖任务 6：用 fake 用户与 fake 出口；
- 任务 11 之前，现有模块（tracer、sync、master-data、a-activity-plan）一行都不改；
- `a-activity-plan` 在路线图上排在 B 之后，B 的任务 9、11 **不依赖它的代码**：`fromPlanAudit` / `toPlanActor` 面向结构类型（design §9.1、§14 第 15 项）并用 fixture 验证；A 落地后由 A 的任务补一条引用 B 适配器的契约测试。

## 任务 0 · 文档前置：归档、订正、INDEX、待确认闸门

**目标**：让后面的代码有合法的基线，旧设计有明确的去向，不让实现偷偷选口径。

**动作**

- [x] 旧 `access-control/design.md` 归档为 `HBECHO设计方案/archive/access-control-design-2026-11-04.md`，文首写 `superseded`、替代文档与禁止用途，并修复其内部相对链接（2026-11-06，随本次初建）；
- [x] `INDEX.md`：登记本 spec、更新旧条目与 §7.1 目录说明；`scripts/check-doc-registry.py` 的 `DESIGN_ONLY_SPECS` 去掉 `access-control`；`prd-platform.md` §4 的「详见」、`prd-drafts-子PRD草案` 两处权威关系链接改指本 spec（2026-11-06，随本次初建）；
- [x] `a-activity-plan` 的 requirements §1.2、design §9 补指向本 spec；手机号规范化改为引用 `src/modules/phone/`（AX-D18）（2026-11-06）；
- [x] [`ADR-0005`](../../../HBECHO设计方案/architecture/adr/0005-application-stack-and-auth.md) 已知坑 5 订正：「IP + 账号双维度」→ 依据 B-D14 只保留账号维度（R2），订正处写明日期与依据（2026-11-06）；
- [x] B PRD 内对旧 `access-control/design.md` 的引用改指归档文件与新 spec，补版本记录 v1.21.1「订正引用，非新规则」；`rule-engine` / `metrics-and-dashboard` 的链接文字、INDEX 的 B PRD 版本号与待裁决项数同步订正（2026-11-06）；
- [ ] B PRD §7.2 清单中 `activity_plan.join` 的说明与 §7.3 矩阵对齐（R3），补版本记录（标明「订正，非新规则」）；
- [ ] `prd-platform.md` §4 / §12 若仍写「旧 access-control design」处核对（R4）；
- [x] **待确认闸门（2026-11-06 通过，刘学奎：design §14 全部按建议采纳）**：由刘学奎对 design §14 第 3、5、6、7、9、10、11 项逐项回复（同意或改）；第 1、2、4、8 项（外部短信、库验证、页面、策略注册）需明确知悉。回复写进 design §14 对应行与 §13 状态列；**回复之前不开始任务 1**；
- [ ] 若闸门回复改变了 requirements 的解释，先改 requirements / design 再继续。

**验证**

- [ ] `./scripts/verify.sh` 通过；
- [ ] 全仓库搜索 `specs/access-control`，除归档说明外无残留链接；
- [ ] design §14 上述各项都有结论与日期。

**Requirements:** 全部；**Design:** §2.3、§13、§14。

## 任务 1 · better-auth 兼容性验证与 ADR-0015

**目标**：把设计里所有标 `library` 的行为，用真实库、真实 MySQL 8.4 测试库验证成事实；验证不过的有明确的备选路线。**这是整个 spec 最大的未知，必须最先做。**

**新增 / 修改**

- `package.json`：只增加 `better-auth`（锁定一个具体版本）；
- `src/modules/access-control/__spike__/*.db.test.ts`：S1–S9 各一个或多个用例，使用 `tests/harness` 的一次性库；
- 临时手工 schema（不进主 schema，不生成迁移）：仅用于验证；
- `HBECHO设计方案/architecture/adr/0015-auth-boundary-and-disabled-phone.md`：状态、日期、决策人、背景、决定、备选、后果、现在谁在守；
- design §6.5 的表回填「通过 / 不通过 + 采用的备选」，§2.2 把 `library` 改为 `code`。

**行为**

- S1：自增 BIGINT 用户 / 会话 ID 全链路；**不通过则停止并报告**（不静默改字符串）；
- S3 / S4：确认哪些规则能直接用库的端点与钩子，哪些要用 Route Handler 包装层或自建端点；
- S5：每日至多刷新一次的实际行为，cookie 缓存关闭；
- S6：墓碑值改写后原号新用户可建、旧用户无法登录；
- 验证码在 `verification` 里是否哈希存储；
- 库升级回归：这些测试保留，转为常规 db 测试。

**验证**

- [ ] S1–S9 每条有结论；不通过的有备选与其代价写进 design §6.5；
- [ ] ADR-0015 `accepted`，有决策人与日期（刘学奎）；
- [ ] `./scripts/verify.sh` 通过；没有迁移被生成（`__spike__` 不产出迁移）。

**Requirements:** AX-1、AX-2、AX-4、AX-5、AX-13；**Design:** §6.2、§6.5。

## 任务 2 · schema 与迁移、认证实例、Next 无页面入口、测试挂具

**目标**：空库一次迁移成功；真实 better-auth 实例能在测试库上完成一次「建用户 → 登录 → 读会话 → 退出」；Route Handler 能被直接调用。

**新增 / 修改**

- `src/db/schema/auth.ts`（四张 `auth_*` 表）、`src/db/schema/access.ts`（`access_users`、`access_user_brands`、`access_user_branches`、`access_login_failures`、`access_sms_sends`、`access_bootstrap_tokens`、`audit_events`）；`import.ts` 的 `IMPORT_KINDS` 增加 `user_import`；
- `drizzle/NNNN_access_control_schema.sql`（`drizzle-kit generate`）与 `drizzle/NNNN_audit_events_immutable.sql`（`generate --custom` 手写触发器：UPDATE 一律拒绝，DELETE 仅放行超过 365 天的行）；
- `src/modules/access-control/config.ts`：zod 解析 `HBECHO_AUTH_SECRET`、`HBECHO_PUBLIC_ORIGIN`、`HBECHO_SMS_MODE`、`HBECHO_SMS_DAILY_CAP` 等；缺项启动失败，无缺省；错误信息只列键名；
- `src/modules/access-control/auth-instance.ts`：按任务 1 结论装配 better-auth（会话 15 天 / 1 天、关闭 cookie 缓存、手机号插件、`trustedOrigins`、请求限流）；
- `src/modules/access-control/audit.ts`：`AuditWriter` 类型与**内存实现**（任务 9 换持久）；
- `src/modules/phone/`：`normalizePhone`（`cn-mobile.v1`）与单测；
- `src/modules/csv-file/`：若 `a-activity-plan` 任务 2 尚未抽取，则按其 design §10.1 抽取（行为不变，master-data 既有测试保持绿）；
- `src/app/api/auth/[...all]/route.ts`、`src/app/api/health/route.ts`；`package.json` 增加 `next`、`react`、`react-dom` 与 `"access"` 脚本占位；`next.config.ts` 最小配置；
- `tests/harness/`：`insertUser`（授权 + 认证两行）、`loginAs`、`FakeSms`、`planActor` 等；
- `src/db/schema.db.test.ts` 同层补 `access-schema.db.test.ts`。

**行为**

- 迁移可重复执行；`drizzle-kit generate` 不产生新文件；
- 状态 / 角色 / 渠道枚举 CHECK 生效；`UQ(active_phone)`（待激活 + 有效内唯一）与 `media_staff_id` 一对一约束生效；`role_code <> 'store_staff'` 时 `media_staff_id` 必须为空；
- 审计触发器：UPDATE 被拒、未到期 DELETE 被拒、到期 DELETE 放行；
- 认证实例 + Route Handler：对 `new Request()` 的登录、读会话、退出可用；
- 没有任何页面、没有 JSX。

**验证**

- [ ] 空库 `migrate` 成功，再跑一次无变更；
- [ ] 同号两个待激活 / 有效用户被拒；停用用户的号码不占号；
- [ ] 审计触发器三种情形；
- [ ] Route Handler 登录往返；`health` 200；
- [ ] master-data 与 a-activity-plan（若已实施）的既有测试全绿；
- [ ] `./scripts/verify.sh` 通过；
- [ ] **推第一次**（分支 `b-access-control`），`gh run watch <run-id> --exit-status`（合并前才必须等）。

**Requirements:** AX-1、AX-10、AX-12、AX-13；**Design:** §4、§6.1–§6.3。

## 任务 3 · Capability、授权入口、谓词、服务身份、静态护栏

**目标**：只有一个注册表和一个授权入口；角色矩阵与 PRD 逐行一致；业务代码里写角色条件会让测试失败。

**新增 / 修改**

- `roles.ts`：`RoleCode`、等级、`CAPABILITIES`（29 项）、`ROLE_CAPABILITIES`；
- `tests/fixtures/access/capability-matrix.v1.json`：由 PRD §7.3 转写的权威 fixture；
- `authorize.ts`：`authorize`、`Decision` 与原因码、`registerPredicate` 与四个登记名；
- `service-principals.ts`：白名单常量与「永不包含」断言；
- `src/acceptance-boundaries.test.ts`：design §10 的五条静态护栏。

**行为**（AX-6）

- 决策顺序与原因码见 design §7.3；对象越权对外表现为 `not_found`；
- 超管同样走矩阵，无旁路；
- 服务身份只认白名单。

**验证**

- [ ] 注册表对照 fixture：29 项逐行一致；增删改任一项测试失败；
- [ ] 四类角色 × 29 项的授予矩阵；
- [ ] 未知 Capability、停用用户、无会话、未注册资源、谓词失败各返回对应原因码；
- [ ] 计划任务身份调用 `data.export`、`data.raw_payload.read`、`user.manage` 被拒；
- [ ] 静态护栏对一个故意违规的临时文件报错（提交前撤掉）；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-6；**Design:** §7.1、§7.3、§7.11。

## 任务 4 · DataScope 与资源策略注册表

**目标**：范围是「品牌 ∩ 组织」的语义对象；未注册、无法映射都拒绝；四个自带策略可用。

**新增 / 修改**

- `scope.ts`：`DataScope`、`buildDataScope`、`intersect`、`fingerprint`、`registerScopeStrategy`、`scopeFor`；
- 自带策略 `user`、`audit_log`、`external_account`、`raw_payload`；
- 质量问题 `access_scope_not_resolvable` 的写入（沿用 `recordIssue` 的做法，不新增表）；
- 单测与 db 测试。

**行为**（AX-7）

- 四类角色的范围按 design §7.4；
- `store_staff` 的 `self` 解析：无绑定 / 已停用 / 多条 → 拒绝本人范围；
- 品牌停用不影响读范围；引用不存在 / 不可读 → 403 + 质量问题；
- 空品牌集合 → 空结果；
- 重复注册失败；删除注册后同一请求失败；
- 外部监控账号只对超管可见；
- 不跨请求缓存。

**验证**

- [ ] 「北京分公司有海信 A、日立 B，经理品牌=海信」只见 A；
- [ ] 空品牌集合不是全量；无法映射 403 且有质量问题；停用品牌仍可读；
- [ ] 三种本人绑定失败情形；
- [ ] 未注册 / 删除注册后的拒绝；
- [ ] 角色变更后同一会话下一次请求用新范围（用任务 2 的 `loginAs`）；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-7；**Design:** §7.4、§7.5。

## 任务 5 · 登录保护、短信、激活 / 重置 / 改密流程

**目标**：真实 better-auth 对测试库完成激活、密码登录、短信登录、重置、改密、锁定；短信规则全部可验证。

**新增 / 修改**

- `login-guard.ts`、`sms.ts`（`SmsService`、`SmsSender` 端口、`FakeSms`、`AliyunSmsSender`）；
- 短信官方 SDK：核对 ADR-0005 的 `@alicloud/*` 范围，在采用清单登记具体包与「不用它做什么」；
- 把锁定、发送前资格校验、限频、全局上限、激活后置 `active`、重置 / 改密后撤销其他会话接到 better-auth（钩子或包装层，按任务 1 结论）；
- `authenticate.ts` 的基础版（不含专员懒停用，任务 7 补）；
- 对应测试（`FakeClock` + `FakeSms`）。

**行为**（AX-1、AX-2、AX-4）

- 锁定：5 次 / 15 分钟、仅密码、短信重置是唯一提前解锁、计数键为手机号、不暴露存在；
- 短信：5 分钟 / 60 秒 / 每日 10 条 / 输错 5 次作废 / 发送前资格校验 / 全局上限暂停；
- 激活：待激活用户用验证码设置密码 → `active`；密码登录对待激活响应与密码错误一致；
- 生产缺发送器配置启动失败；
- 验证码不写日志与审计。

**验证**

- [ ] AX-4 验收标准逐条；
- [ ] 激活后可密码登录；待激活密码登录响应一致；
- [ ] 重置密码解锁并踢出其他会话；改密踢出其他会话保留当前；
- [ ] 对不存在 / 停用手机号请求发送：响应与成功一致，`FakeSms` 无记录；
- [ ] 全局上限：短信类拒绝、密码登录通过、出现告警事件；
- [ ] 对全部事件夹具扫描无验证码 / 密码 / 令牌；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-1、AX-2、AX-4；**Design:** §5.2、§7.7、§7.8。

## 任务 6 · 用户管理：邀请、边界、变更、停用 / 恢复、强制下线、首个超管

**目标**：管理者能创建、变更、停用、恢复、强制下线，且永远不能超出自己的边界；读写同源。

**新增 / 修改**

- `users/`：`invite`、`changeAccess`、`changeStatus`、`restore`、`forceLogout`、`list`；`manages`、`canGrant`；
- 墓碑手机号的写入与恢复；停用事务内撤销会话与审计（高风险同事务）；
- `access token create`、`access bootstrap-superadmin`；
- 最后一个超管保护（对超管行加锁）；
- 对应测试。

**行为**（AX-2、AX-5、AX-8）

- 严格下级、`GrantBoundary` 双校验、列表可见性与可操作集合一致；
- 创建 `store_staff` 用「手机号 + 门店编码」定位唯一有效专员；
- 恢复：重校验、去掉不存在 / 无法映射项并审计、手机号唯一复核；
- 超管不能停用自己、最后一个超管不能停用；
- 变更授权不撤销会话；强制下线撤销全部会话；
- `store_staff` 的门店 / 品牌不能原地修改。

**验证**

- [ ] AX-8 验收标准逐条；
- [ ] 总部不能建总部 / 超管；分公司不能建分公司；只有超管建超管；
- [ ] 同级不可见且按 ID 访问 = 未找到；
- [ ] 列表集合 = 可操作集合 ∪ 自己（等价测试）；
- [ ] proposed 超界整个拒绝、零写入；批量 3 行含 1 行越权 → 2 成功 1 跳过；
- [ ] 首个超管：令牌错误 / 过期 / 已用 / 已有超管四种拒绝且零写入；成功后令牌失效；
- [ ] 两个超管顺序交错互停，只有一个成功；
- [ ] 停用后会话失效、登录手机号为墓碑值、同号可新建；恢复同号冲突被拒；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-2、AX-5、AX-8；**Design:** §7.6、§7.9、§7.12（首个超管）。

## 任务 7 · `MediaStaff` 联动与 `access maintain`

**目标**：专员停用 → 用户自动停用；专员恢复 → 条件恢复；覆盖从未登录的用户。

**新增 / 修改**

- `authenticate.ts` 补懒停用；
- `linkage.ts`：补偿（步骤 1）、条件恢复（步骤 2）、增长型表清理（步骤 4：`access_sms_sends` 35 天、`access_login_failures`、`access_bootstrap_tokens`）、`runDaily` 与 `runNow`；
- `src/worker/sync-wiring.ts` / `sync-main.ts`：`extras.accessMaintain`；`access maintain` 命令；
- 对应测试（`FakeClock`）。

**行为**（AX-5）

- 懒停用与补偿幂等；系统身份记审计 `media_staff_disabled`；增长型表清理按 design §7.10；
- 条件恢复只恢复因该专员停用的用户；同号冲突保持停用并写质量问题；
- 绑定失效的用户有效但本人范围拒绝；
- 不依赖 OSS。

**验证**

- [ ] 专员停用后用户下一次请求被停用并撤销会话；
- [ ] 从未登录的用户被补偿任务停用；
- [ ] 专员恢复：自动停用的恢复、人工停用的不恢复、同号冲突保持停用 + 质量问题；
- [ ] 专员不存在时恢复用户：有效但本人范围拒绝；
- [ ] 无 OSS 配置的装配里 `accessMaintain` 仍被调度；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-5；**Design:** §7.10。

## 任务 8 · 用户批量导入

**目标**：1,000 行内的 CSV 能预检、确认、回流；越权行跳过不拖垮整批。

**新增 / 修改**

- `users/import/`：模板 `user-import.v1`、文件级校验（经 `csv-file`）、行分类、确认写入、回流文件、查询；
- CLI 子命令 `user import ...`；
- `tests/fixtures/access/user-import/*.csv`（脱敏造数）。

**行为**（AX-3）

- 全部同步；预检不过期、确认重校验；
- 越权行 `role_not_grantable` / `scope_exceeds_boundary` 进跳过清单；
- 手机号冲突、文件内重复、专员定位失败各有原因码与指引；
- 确认时每行走任务 6 的创建函数；并发先建同号 → `conflict`；
- 回流文件仅提交人可下载，记审计。

**验证**

- [ ] 文件级：1,001 行、10 MB + 1、表头不符、编码无法识别 → 无批次；
- [ ] 总部导入含 `hq_manager` / `platform_admin` 行 → 跳过；分公司导入含他分公司门店 → 拒；
- [ ] `phone_exists`、`duplicate_phone_in_file`、停用号可新建；
- [ ] 预检后先建同号再确认 → `conflict`；
- [ ] 回流文件列 / 原因 / 指引；他人下载被拒；
- [ ] 重复提交同一文件无额外用户；
- [ ] 默认测试无短信；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-3；**Design:** §7.12。

## 任务 9 · 审计：持久表、适配器、清理、读取

**目标**：所有高风险动作与审计同事务；现有三类审计能落库；一年到期清理可执行。

**新增 / 修改**

- `audit.ts`：持久 `AuditWriter`、`risk` 分级、幂等键、读取（`audit.read`）、`purgeOlderThan`；
- 适配器：`fromTracerAudit`、`fromSyncAudit`、`fromMasterDataAudit`、`fromPlanAudit`（后者面向 `a-activity-plan` design AP-14 列出的事件字段的结构类型，不 import A 的模块）；
- 日志脱敏过滤；
- 任务 6、7、8 的审计调用从内存实现切到持久实现；
- 对应测试。

**行为**（AX-10）

- 高风险写入失败整体回滚，低风险尽力；
- 适配后的事件含规范主体与稳定 `reason_code`；
- 到期清理分批、写系统审计、触发器放行；
- 非超管读取被拒。

**验证**

- [ ] 事件覆盖清单每类至少一条；
- [ ] 对全部事件夹具字符串扫描：无密码 / 令牌 / Cookie / 验证码；
- [ ] 幂等键去重；UPDATE / 未到期 DELETE 被触发器拒；
- [ ] 清理 366 天前 / 364 天前；产生 `audit_purged`；
- [ ] 高风险审计失败 → 业务回滚；低风险失败 → 业务继续；
- [ ] 三类现有事件经适配器可按 actor / 对象 / 批次查询；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-10；**Design:** §6.1、§7.14。

## 任务 10 · 数据出口框架

**目标**：十个出口有同一套守卫；异步任务范围只会收窄；撤权取消用户任务；交付前复查可拦住过期产物。

**新增 / 修改**

- `egress.ts`：`guardExit`、`snapshotForJob`、`effectiveScope`、`recheckDelivery`、`registerJobCanceller`、`cancelUserJobs`；
- 停用 / 撤权事务提交后调用 `cancelUserJobs`（任务 6 接入）；
- 契约测试（fake 出口 + fake 任务注册表）。

**行为**（AX-9）

- 提交时 / 执行时 / 交付前三个检查点；
- 扩权不扩大旧任务、撤权收窄、为空则取消；
- 计划任务不被取消；
- canceller 失败告警不回滚；
- 回流文件不算 `data.export`；`data.export` 与 `report.export` 分开。

**验证**

- [ ] 十个出口各一条守卫用例；
- [ ] 三个检查点任一处撤权都拒绝交付；
- [ ] 提交后扩权有效范围不变；撤权收窄；空范围取消并审计；
- [ ] 停用用户时其未完成任务被取消，计划任务不受影响；
- [ ] 签名链接短期有效且撤权后不能续签（fake 签发器）；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-9；**Design:** §7.13。

## 任务 11 · 适配器、审计装配替换、CLI 收口

**目标**：现有模块在不改业务逻辑的前提下接上真实身份与持久审计。

**新增 / 修改**

- `adapters.ts`：`toPlanActor`（面向 `PlanActorShape` 结构类型，A 未实现时用 fixture 验证）、`toMasterDataActor`、`toTracerActor`（仅全范围）、`userIdOf`；
- 三处装配（`sync-main`、`master-data-main`、`tracer-cli`）与 `a-activity-plan` 的装配：`createLogAudit` → 日志 + 持久的组合；业务模块代码不变；
- `access-cli.ts` / `access-main.ts` 全命令收口（design §9.3）；
- 契约 fixture：四类角色到各 actor 的期望输出；
- 静态测试：全仓库 Capability 字符串属于注册表。

**行为**（AX-11、AX-12）

- `toTracerActor` 对分公司人员返回不可适配，不降级；
- 回填入口对 `service:*` 返回 null，不造假；
- CLI 缺环境变量启动失败；写命令不带 `--apply` 无变化；没有 `--force` / `--skip-auth`。

**验证**

- [ ] 适配器契约测试；
- [ ] 现有模块（tracer、sync、master-data）既有测试全绿，**一个断言都不改**；
- [ ] 现有审计事件落库后可查；
- [ ] CLI：退出码、JSON、缺环境变量、`--apply` 语义；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AX-10、AX-11、AX-12；**Design:** §9、§10。

## 任务 12 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾

**目标**：[`acceptance.md`](acceptance.md) 的全部 `[自动]` 项逐条通过；规模数字记录在案；文档状态与索引一致。

**动作**

- 逐条核对 `acceptance.md` 的 `[自动]` 项与测试映射，缺的补测试；
- 规模演练：1,000 行用户导入预检 / 确认；记录耗时与内存到 design §12；
- 测试 ECS 上跑 `pnpm test:db`（`server-access.md`：仅 Workbench；一次性库容器、`_test` 库、用完 `down -v`）；
- `[环境]` 一次性：本地 `next build` 能通过（不进 `verify.sh`）；
- `[手工]` 项：CLI 走查、导入回流文件在 Excel 中打开、审计样例评审；
- 文档收尾：INDEX（§5 矩阵、§7.1）、`CLAUDE.md` 代码地图、`ui-foundation.md` §3 的「状态」、`a-activity-plan` 中「B 未开始」的措辞；
- `./scripts/verify.sh` 全绿；**推第二次**；`gh run watch <run-id> --exit-status`；CI 绿后以 `--no-ff` 合并 `main`，合并说明写 run id 与本机 verify 结果。

**验证**

- [ ] `acceptance.md` 所有 `[自动]` 项通过；
- [ ] 规模数字已写入 design §12；
- [ ] 测试 ECS 运行记录写入 tasks 文末「实施记录」；
- [ ] 没有 `[环境]` 项被写成已通过而实际未运行；
- [ ] production 短信发送器仍未启用。

**Requirements:** 全部；**Design:** §11、§12。

## 需要停下来并报告的情况

出现下列任一情况，停止实现，先改文档或找刘学奎：

1. S1 不通过（认证表 ID 不能是 BIGINT）；
2. better-auth 的手机号插件无法满足 §6.5 中 S3 / S4 且备选路线也会改变 PRD 行为（例如必须改变验证码有效期或失败次数）；
3. 需要新依赖（短信官方包之外），或需要真实网络 / 真实短信 / 生产数据的验证；
4. 现有模块的行为必须改动才能接入（适配器与审计装配之外）；
5. v2 / CONTEXT / PRD 与本 spec 冲突，或需要改动 Capability 的名字、范围语义；
6. 想让某个资源在没有注册策略的情况下「先放行」；想给超管加旁路；
7. 想在页面确认（design §15.6）之前写页面任务或页面代码；
8. 墓碑手机号方案无法保证「登录只匹配非停用记录」；
9. 审计触发器与部署账号权限冲突（需要运维调整）；
10. 闸门回复的结论与 design 写法不同（回到任务 0）。

## 实施记录

（未开始）
