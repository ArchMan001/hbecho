# B 访问控制（b-access-control）· 实施计划

> **状态**：`draft`
>
> **执行状态**：进行中（2026-11-06 初建；2026-11-10 任务 0–5 完成；2026-11-10 任务 0–12 全部完成并已合并 `main`；2026-11-11 页面任务 P1–P5 实施，已合并 `main`）。任务 0 的「待确认闸门」已通过（2026-11-06，刘学奎：全部按建议采纳）；任务 1 的库兼容性验证与 ADR-0015 已于 2026-11-10 完成并接受。**待你确认的取舍见本文末「实施记录」的「待决项」**
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
> **更新日期**：2026-11-10

## 进度

- [x] 任务 0 · 文档前置（归档旧设计、订正、INDEX、待确认闸门）— 全部完成（归档、登记、订正与闸门 2026-11-06；B PRD §7.2 对齐与总 PRD 核对 2026-11-09）
- [x] 任务 1 · better-auth 兼容性验证（S1–S9）与 ADR-0015 — 完成（2026-11-10，38 个用例；ADR-0015 accepted，验证码明文选 A）
- [x] 任务 2 · schema 与迁移、认证实例与配置、Next 无页面入口、测试挂具 — 完成（2026-11-10）；已推送并合并（`b-access-control` → `main`）
- [x] 任务 3 · Capability 注册表、角色矩阵、授权入口、谓词、服务身份与静态护栏 — 完成（2026-11-10）
- [x] 任务 4 · DataScope、`ScopeStrategy` 注册表与四个自带策略 — 完成（2026-11-10）
- [x] 任务 5 · 登录保护、短信、激活 / 重置 / 改密流程 — 完成（2026-11-10）
- [x] 任务 6 · 用户管理：邀请、边界、变更、停用 / 恢复、强制下线、首个超管 — 完成（2026-11-10）；`access token create` / `bootstrap-superadmin` 的**命令行入口**随任务 11 的 `access-cli` 一起做，函数与测试已在 `users/bootstrap.ts`
- [x] 任务 7 · `MediaStaff` 联动与 `access maintain` — 完成（2026-11-10）；`access maintain` **命令行入口**随任务 11 的 `access-cli` 一起做（`createAccessMaintenance().runNow` 已就绪）
- [x] 任务 8 · 用户批量导入 — 完成（2026-11-10）；`user import` **命令行入口**随任务 11 的 `access-cli` 一起做
- [x] 任务 9 · 审计：持久表、触发器、适配器、清理、读取 — 完成（2026-11-10）；适配器在各进程装配处的**替换**随任务 11
- [x] 任务 10 · 数据出口框架 — 完成（2026-11-10）；在各进程里把 `cancelUserJobs` 接到 `onRevoked` 随任务 11
- [x] 任务 11 · 到现有模块的适配、审计装配替换、CLI 收口 — 完成（2026-11-10）
- [x] 任务 12 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾 — 完成（2026-11-10）；第二次推送与合并见实施记录
- [x] 页面任务 P1–P5（界面设计已于 2026-11-10 确认，design §15.6；2026-11-11 排期并实施，范围不超出确认范围）— 见下方「页面任务」；部署到测试 ECS 的结果见实施记录

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
- [x] B PRD §7.2 清单中 `activity_plan.join` 的说明与 §7.3 矩阵对齐（R3），补版本记录 v1.21.2（标明「订正，非新规则」）（2026-11-09）；
- [x] `prd-platform.md` §4 / §12 核对（R4）：§4 已指向本 spec，§12 路线图无旧 design 引用，无需改动（2026-11-09）；
- [x] **待确认闸门（2026-11-06 通过，刘学奎：design §14 全部按建议采纳）**：由刘学奎对 design §14 第 3、5、6、7、9、10、11 项逐项回复（同意或改）；第 1、2、4、8 项（外部短信、库验证、页面、策略注册）需明确知悉。回复写进 design §14 对应行与 §13 状态列；**回复之前不开始任务 1**；
- [x] 若闸门回复改变了 requirements 的解释，先改 requirements / design 再继续（闸门全部按建议采纳，无改动）。

**验证**

- [x] `./scripts/verify.sh` 文档类步骤（1–8）通过（2026-11-09）；
- [x] 全仓库搜索 `specs/access-control`，仅剩本 spec 说明性文字，无残留链接；
- [x] design §14 上述各项都有结论与日期（2026-11-06）。

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

- [x] S1–S9 每条有结论，写进 design §6.5（2026-11-10）；
- [x] ADR-0015 `accepted`，决策人刘学奎，2026-11-10；
- [x] 没有迁移被生成（`__spike__` 用带 `COMMENT='hbecho-spike'` 标记的临时表，不进主 schema）；
- [x] `./scripts/verify.sh` 九步全部通过（2026-11-10：单元 603、数据库 611 含 spike 38、链接 118 个文件、文档登记 8 个 spec、Python 18）。

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

- [x] 空库 `migrate` 成功，再跑一次无变更（`access-schema.db.test.ts`）；
- [x] 同号两个待激活 / 有效用户被拒；停用用户的号码不占号（同上）；
- [x] 审计触发器三种情形：UPDATE 被拒、未满 365 天的 DELETE 被拒、满 365 天的 DELETE 放行（同上）；
- [x] Route Handler 登录往返；`health` 200（`http.db.test.ts`）；
- [x] master-data 既有测试全绿（一个断言都没改；仅两处表数断言把 v2 与 B 域的表分开计）；a-activity-plan 未实施；
- [x] `./scripts/verify.sh` 通过（2026-11-10）；
- [x] **推第一次**：已完成（分支 `b-access-control`，后续合并 `main`）。

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

- [x] 注册表对照 fixture：29 项逐行一致（fixture 由脚本从 PRD §7.3 机械转写）；
- [x] 四类角色 × 29 项的授予矩阵（`roles.test.ts`）；
- [x] 未知 Capability、未注册资源、谓词失败、范围无法解释各返回对应原因码（`authorize.test.ts`）；停用用户 / 无会话在 `authenticate`（`authenticate.db.test.ts`）；
- [x] 计划任务身份调用 `data.export`、`data.raw_payload.read`、`user.manage` 等被拒，白名单枚举断言；
- [x] 静态护栏对故意违规的临时文件报错（4 条失败，已撤掉）；注意「超管无旁路」那条静态检查只扫一种写法，**不是安全证明**，真正的证据是 `authorize.test.ts` 里「未注册资源超管同样被拒」；
- [x] `./scripts/verify.sh` 通过。

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

- [x] 「北京分公司有海信 A、日立 B，经理品牌=海信」只见 A（`scope.db.test.ts`）；
- [x] 空品牌集合不是全量；无法映射 403 且有质量问题（同一问题累加次数）；停用品牌仍可读；
- [ ] 三种本人绑定失败情形：**只覆盖两种**（无绑定、专员已停用）；「多条」在当前表结构下无法发生（`access_users.media_staff_id` 是单列，且非停用用户与专员一对一唯一），代码保留了该原因码但没有用例；
- [x] 未注册 / 删除注册后的拒绝；
- [x] 角色变更后同一会话下一次请求用新范围（`authenticate.db.test.ts`，同一个会话行）；
- [x] `./scripts/verify.sh` 通过。

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

- [x] AX-4 验收标准逐条（`auth-flows.db.test.ts`；真实发送器未验证、不属自动验收）；
- [x] 激活后可密码登录；待激活密码登录响应一致（含「有密码但仍待激活」的残留情形，已结构性拒绝）；
- [x] 重置密码解锁并踢出其他会话；改密踢出其他会话（库把当前会话轮换成新 cookie，用户保持登录）；
- [x] 对不存在 / 停用手机号请求发送：响应与成功一致（两个端点各自同形），假发送器无记录；
- [x] 全局上限：短信类拒绝、密码登录通过、出现告警事件（回调 + 审计各一条，每进程每天一次）；
- [x] 对全部事件夹具扫描无验证码 / 密码 / 令牌；
- [x] `./scripts/verify.sh` 通过。

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

- [x] AX-8 验收标准逐条（`users/admin.db.test.ts`）；
- [x] 总部不能建总部 / 超管；分公司不能建分公司；只有超管建超管；
- [x] 同级不可见且按 ID 访问 = 未找到；
- [x] 列表集合 = 可操作集合 ∪ 自己（等价测试）；
- [x] proposed 超界整个拒绝、零写入；
- [x] 批量 3 行含 1 行越权 → 2 成功 1 跳过（任务 8 的导入用例验证）；
- [x] 首个超管：令牌错误 / 过期 / 已用 / 已有超管四种拒绝且零写入；成功后令牌失效；
- [x] 两个超管互停，只有一个成功（并发实测 + 陈旧上下文两种）；
- [x] 停用后会话失效、登录手机号为墓碑值、同号可新建；恢复同号冲突被拒；
- [x] `./scripts/verify.sh` 通过（该任务边界未单独记录；任务 12 的全量 `verify.sh` 覆盖，2026-11-10）。

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

- [x] 专员停用后用户下一次请求被停用并撤销会话；
- [x] 从未登录的用户被补偿任务停用；
- [x] 专员恢复：自动停用的恢复、人工停用的不恢复、同号冲突保持停用 + 质量问题；
- [x] 专员不存在时恢复用户：有效但本人范围拒绝；
- [x] 无 OSS 配置的装配里 `accessMaintain` 仍被调度；
- [x] `./scripts/verify.sh` 通过（该任务边界未单独记录；任务 12 的全量 `verify.sh` 覆盖，2026-11-10）。

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

- [x] 文件级：1,001 行、10 MB + 1、表头不符、编码无法识别 → 无批次；
- [x] 总部导入含 `hq_manager` / `platform_admin` 行 → 跳过；分公司导入含他分公司门店 → 拒；
- [x] `phone_exists`、`duplicate_phone_in_file`、停用号可新建；
- [x] 预检后先建同号再确认 → `conflict`；
- [x] 回流文件列 / 原因 / 指引；他人下载被拒；
- [x] 重复提交同一文件无额外用户；
- [x] 默认测试无短信；
- [x] `./scripts/verify.sh` 通过（该任务边界未单独记录；任务 12 的全量 `verify.sh` 覆盖，2026-11-10）。

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

- [x] 事件覆盖清单每类至少一条；
- [x] 对全部事件夹具字符串扫描：无密码 / 令牌 / Cookie / 验证码；
- [x] 幂等键去重；UPDATE / 未到期 DELETE 被触发器拒；
- [x] 清理 366 天前 / 364 天前；产生 `audit_purged`；
- [x] 高风险审计失败 → 业务回滚；低风险失败 → 业务继续；
- [x] 三类现有事件经适配器可按 actor / 对象 / 批次查询；
- [x] `./scripts/verify.sh` 通过。

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

- [x] 十个出口各一条守卫用例；
- [x] 三个检查点任一处撤权都拒绝交付；
- [x] 提交后扩权有效范围不变；撤权收窄；空范围取消并审计；
- [x] 停用用户时其未完成任务被取消，计划任务不受影响；
- [x] 签名链接短期有效且撤权后不能续签（fake 签发器）；
- [x] `./scripts/verify.sh` 通过。

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

- [x] 适配器契约测试；
- [x] 现有模块（tracer、sync、master-data）既有测试全绿，**一个断言都不改**；
- [x] 现有审计事件落库后可查；
- [x] CLI：退出码、JSON、缺环境变量、`--apply` 语义；
- [x] `./scripts/verify.sh` 通过。

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

- [x] `acceptance.md` 所有 `[自动]` 项：逐条结果已回填；**18 项仍是「部分」、4 项依赖所属域，已逐项列出，不是全部通过**（见 acceptance「逐条结果」）；
- [x] 规模数字已写入 design §12；
- [x] 测试 ECS 运行记录写入 tasks 文末「实施记录」；
- [x] 没有 `[环境]` 项被写成已通过而实际未运行（ENV-1、ENV-2 已运行；ENV-3 / ENV-5 未运行，ENV-4 只部分验证，原因见 acceptance）；
- [x] production 短信发送器仍未启用（`config.test` 断言生产配置必须提供真实发送器配置；本机 `.env` 的 `HBECHO_SMS_MODE=aliyun` 只用于本机，未部署到任何服务器）。

**Requirements:** 全部；**Design:** §11、§12。

## 页面任务（P1–P5）

> **进入条件已满足**：design §15.6 已记录刘学奎 2026-11-10 对 [`ui-lab/hbecho-ui-v2/`](../../../ui-lab/hbecho-ui-v2/README.md) 的确认（登录、激活、忘记密码、修改密码、用户列表、新建用户、用户详情 / 编辑、批量导入用户、审计日志）。**确认范围之外一律不做**：活动计划、判定计划、报表、门店端「我的考核」等页面不在本 spec，导航里也不显示。
>
> **实现形态**：Next.js App Router 的服务端页面 + 服务端动作，只调用 Module（`src/modules/access-control/web.ts` 装配的 `UserAdmin` / `UserImport` / `AuditReader`，与 CLI 同一套授权与审计）；认证表单直接调用既有的 better-auth Route Handler（白名单与限流不变）；`src/app` 不写 SQL（B-AX-12 的扫描现在也覆盖 `.tsx`）。视觉用已确认原型的 CSS（`src/app/globals.css`），**没有引入 Tailwind / shadcn**：ui-foundation §6.4 写的是 shadcn，原型阶段用纯 CSS 确认的视觉，落地沿用，避免为同一套视觉再引入一整套组件依赖；这是对 ui-foundation 的一处偏离，见实施记录待确认项。

- [x] **P1 · 外壳与全局页**：根布局与样式、侧栏 / 顶栏 / 账号菜单（修改密码、退出）、`not-found` / `error` / `loading` / 无权访问页、ICP 备案号页脚（运维手册 §10.6 第 5 条）、Toast 与确认弹窗；导航按 Capability 显示，无入口不显示。
- [x] **P2 · 登录、激活、忘记密码、修改密码**：手机号 + 密码 / 短信验证码两种登录；激活与找回密码走同一条库内路径；60 秒重发倒计时；错误文案 + 稳定错误码；登录失败不暴露账号是否存在。
- [x] **P3 · 用户列表与新建用户**：角色 → 状态 → 品牌 → 分公司筛选（URL 即状态）、分页、整行下钻、停用 / 恢复弹窗、「状态 = 待激活」下的批量停用；新建时按角色显示字段，门店专员可先「核对」。
- [x] **P4 · 用户详情 / 编辑与批量导入**：详情只提交改动字段；强制下线 / 停用 / 恢复弹窗写明影响；导入向导四步，批次编号进 URL，刷新后回到同一步；预检含错误 / 跳过分类，回流文件由提交人本人下载。
- [x] **P5 · 审计日志与交付件**：事件 / 时间筛选（进 URL）、概要带、分页；非超管直接访问显示「无权访问」且不显示计数；`Dockerfile` / `.dockerignore`、CI 的 `image` job（推 ACR，标签 = git 短 sha）。

**验证**：`pnpm typecheck`；`web.db.test.ts`（名称补全、审计读取授权、导入原始行归属）；`acceptance-boundaries` 扫描 `.tsx`；本机一次性 MySQL + `next dev` 用 Chrome 走完整流程（激活 → 登录 → 新建总部 / 分公司 / 门店专员 → 筛选 → 编辑 → 分公司人员导入含越权行 → 回流 → 停用 / 恢复 → 审计 → 改密 → 忘记密码 → 退出）；镜像在本机构建并以 `NODE_ENV=development` 起容器冒烟（健康检查、备案号页脚、镜像内无测试文件、非 root、`access maintain` 预览）。

## 需要停下来并报告的情况

出现下列任一情况，停止实现，先改文档或找刘学奎：

1. S1 不通过（认证表 ID 不能是 BIGINT）；
2. better-auth 的手机号插件无法满足 §6.5 中 S3 / S4 且备选路线也会改变 PRD 行为（例如必须改变验证码有效期或失败次数）；
3. 需要新依赖（短信官方包之外），或需要真实网络 / 真实短信 / 生产数据的验证；
4. 现有模块的行为必须改动才能接入（适配器与审计装配之外）；
5. v2 / CONTEXT / PRD 与本 spec 冲突，或需要改动 Capability 的名字、范围语义；
6. 想让某个资源在没有注册策略的情况下「先放行」；想给超管加旁路；
7. 在界面设计确认范围（design §15.6）之外写页面任务或页面代码；超出已确认范围要先重新确认；
8. 墓碑手机号方案无法保证「登录只匹配非停用记录」；
9. 审计触发器与部署账号权限冲突（需要运维调整）；
10. 闸门回复的结论与 design 写法不同（回到任务 0）。

## 实施记录

**2026-11-10 · 任务 1（better-auth 兼容性验证）**

- 依赖：`better-auth@1.7.18` 精确锁定。1.7.19（2026-11-10 发布）被 pnpm `minimumReleaseAge` 拦下，未加入豁免，退回上一版；
- 验证：`src/modules/access-control/__spike__/` 4 个文件、38 个用例，本机一次性 MySQL 8.4 容器；`pnpm test:db` 全套 609 通过（含这 38 个），`pnpm test` 603 通过，`pnpm typecheck` 通过；
- 结论见 design §6.5 与 [ADR-0015](../../../HBECHO设计方案/architecture/adr/0015-auth-boundary-and-disabled-phone.md)：S1–S9 全部通过，其中 S1（天花板）、S3、S6、S8、S9 各有一处必须在库外补或显式配置；
- 实测发现并已记录的三处与设计原文不同：① 库在 ID 超过 2^53 时死循环（规则：认证表 ID 只能自增）；② 库自带手机号校验器只覆盖两个端点；③ 合成邮箱不能由手机号推导；
- ADR-0015 已于 2026-11-10 由刘学奎确认 accepted，验证码明文选 A（接受）。

**2026-11-10 · 任务 2–5**

- 依赖：`next@16.4.5`、`react@19.3.1`、`react-dom@19.3.1`（精确锁定；next 16.4.6 发布不足一天未用）、`@alicloud/dysmsapi20170525@4.6.0`；`@alicloud/openapi-core` 的 postinstall 在 `pnpm-workspace.yaml` 记为 `false` 并写明原因；ADR-0005 采用清单已登记（包名与版本待刘学奎确认）；
- 迁移：`0006_access_control_schema`（11 张表）、`0007_audit_events_immutable`（UPDATE 一律拒绝，DELETE 仅放行满 365 天的行）；`resetData` 对 `audit_events` 改用 TRUNCATE（触发器不拦它，只有测试挂具这样清）；
- 任务 2：`phone`（cn-mobile.v1 单一来源）、`csv-file`（从 master-data 抽取，master-data 既有测试一个断言没改）、`config`、`audit`（内存 + 持久，一并做完）、`auth-instance`、`http`（Route Handler + **默认拒绝的路径白名单**，只放行 8 条）、`runtime`、`src/app/api/{auth/[...all],health}`、`next.config.ts`、测试挂具；
- 任务 3：`roles`（29 项）+ 从 PRD §7.3 机械转写的 fixture、`authorize`、`service-principals`、`grants`（manages / canGrant）、`scope`；`acceptance-boundaries.test.ts` 增加 6 条静态护栏，用故意违规的临时文件验证过会失败；
- 任务 4：`DataScope`、`OrgDirectory` 端口、`createStoreStrategy`（门店级通用判断，供资源域组装）、四个自带策略、质量问题 `access_scope_not_resolvable`；
- 任务 5：`login-guard`、`SmsService`、`auth-flow`（锁定 / 短信 / 激活 / 重置 / 改密接到钩子）、`authenticate`（基础版，**专员懒停用留给任务 7**）、`AliyunSmsSender`（注入假客户端离线测试；真实发送未验证，也不属于自动验收）；
- 实测发现并处理：① 库改密会把**当前会话轮换成新 cookie**，不是原 cookie 保持有效；② 重置密码路径里 `set-password` 子串误伤静态护栏，已把正则收窄；③ 同一号码 60 秒内的被抑制请求也占窗口（设计要求，测试里踩到过）。

**2026-11-10 · 审查后订正（独立审查意见逐条动手核实后处理）**

核实方式：每条断言都回到代码 / 库源码 / 文档原文复核，能复现的写了复现用例。审查的 6 个「必须修」全部属实；建议项除「删除 `hbecho-fullsync-smoke-mysql` 容器」外都成立。审查在 IP 限流上比我更准：库取不到可信 IP 时不是「跳过限流」，而是所有请求落进同一个 `no-trusted-ip` 共享桶；限流 key 是 `IP|路径`，所以我先前说的「全局 120」也是错的，阈值都是「每个 IP 每条路径」。

已修（代码，均有用例）：

- **生产入口没接流程**（我自己的缺陷，审查前已发现）：`assemble.ts` 作为唯一装配点，运行时与测试挂具共用；`runtime.db.test.ts` 验证接线；
- spike 的 `emailAndPassword.enabled` 改为 `false`，并新增「注册 / 登录端点关闭」用例（改回 `true` 时该用例会红，已验证）；
- 短信 `admit` 并发竞态：实测 8 个并发有多个通过；先用 drizzle 事务 + `GET_LOCK` 失败（锁在提交前释放，竞争者看不到预占行），改为**同一条连接**上 加锁 → 事务 → 提交 → 放锁，并先写预占行；5/5 次稳定只通过 1 个；
- 登录前置钩子检查 `access_users.status`：「有密码但仍待激活」的用户此前**确实能拿到会话**（已复现），现在按凭据错误处理并计一次失败；同时发现我手写的错误响应体键顺序与库不同（库是 `message` 在前），已对齐；
- 限流：`HBECHO_TRUSTED_PROXIES`（生产必填）与 `HBECHO_AUTH_RATE_LIMIT_PER_MIN`（缺省 60）进配置；用例证明配置受信代理后伪造 `X-Forwarded-For` 前缀换不到新桶；
- `purgeOlderThan` 的 cutoff 多留 1 小时余量（触发器按库时钟判断）；
- `createAuthorizer()` 缺省用进程级 `defaultRegistry`；
- 角色码单一来源（`roles.ts` 引用 `schema/access.ts`）；`disableCore` 自己拦自停用；
- 去掉指向不存在文件的 `access` 脚本（任务 11 再加）；
- 两处静默跳过改为重试到验证码不同再断言；spike 用例标题「包装层」改「前置钩子」；
- runtime 接 pino 日志与告警出口。

已修（文档）：requirements / acceptance / PRD（v1.21.3）/ ADR-0015 S5 的「自然日」改为滚动 24 小时；ADR-0015 第 3 条响应形状；design §14 #1 的短信变量；design §6.2 与 §6.5 S2 的矛盾；design §2.2 过时示例；新增 `.env.example`；design §13 新增 AX-D26～D31。

未采纳 / 暂缓：

- 删除 `hbecho-fullsync-smoke-mysql` 容器：不是本轮产生的，已运行 4 天，可能是你的 smoke 环境，不动；
- 「带 `resource` 不带 `ref` 只检查已注册」：已知，未改。建议的列表级入口（返回语义约束）留到第一个资源域接入时一起做，避免空设计；
- 静态护栏「超管无旁路」保留，但测试与文档都注明它不是安全证明。

**待决项（2026-11-10 刘学奎逐项答复后的状态；对应 design §13 的 AX-D26～D31）**

1. **专员联动的「人工恢复豁免」标记列**（AX-D30）：**已确认**（刘学奎，2026-11-10，听完 User 与 MediaStaff 关系和冲突场景的解释后同意）。任务 7 前实现，迁移未推送，现在加列成本低；注意仓库里目前没有代码会把专员改为停用，这条联动的触发源要等主数据侧有「停用专员」功能；
2. **可信代理与 Nginx 覆盖 `X-Forwarded-For`**（AX-D27）：**已确认**（内部站点，实现简单所以做）。已做：`HBECHO_TRUSTED_PROXIES` 配置项（生产必填）、用例、design §10.1 部署要求、ADR-0006 的转发约定；不另写运行手册（`deploy/nginx/` 目录建立时照此写）；
3. **登录失败审计只为已存在用户写**（AX-D28）：**已确认**，已实现并加用例；PRD v1.21.4 澄清记录；
4. **阿里云短信**：**基本确认**。签名 `青岛海信博世`，三个模板编码与变量名 `${code}` 均已确认并记入 design §14 #1；授权方式已对照 hbdam（同一 SDK、专用显式 AccessKey、固定接入点、不自动重试、区分运维类错误），已吸收运维类错误告警。仍待：签名「可用·异常」/ 运营商报备「待验证」的含义（首次真实发送前在控制台详情页确认）、RAM 子账号与 AccessKey（刘学奎自行配置到服务器 `.env`，不发给我）、首次真实发送的批准（固定条数、显式开关）；包 `@alicloud/dysmsapi20170525@4.6.0` 与 hbdam 用的是同一个包，版本一致；
5. **hq / branch 创建时品牌集合非空**（AX-D29）：**已确认**，已写进 design §7.6；
6. **限流阈值**（AX-D26）：**已确认**，缺省生产 300、非生产 60；「每天」按北京时间自然日；
7. **PRD v1.21.3 措辞订正**：**已确认**；
8. **提交与推送**：未做，等刘学奎决定提交范围与分支（`ui-lab/hbecho-ui` 与 `v2` 必须同批提交；不要 `git add -A`）。

已知小缺口 / 偏差：`next build` 从未跑过（`ignoreBuildErrors` 暂开，任务 12 必须真跑并考虑移除）；激活后 `phoneNumberVerified` 未置 true（无功能影响）。

**2026-11-10 · 首次真实短信试发（刘学奎授权：全部授权，由我执行）**

- 命令：`HBECHO_SMS_SMOKE=1 pnpm sms-smoke --phone 17863267891 --kind login --confirm-real-send`（`src/worker/sms-smoke-cli.ts`，19 个离线测试覆盖全部拒绝路径）；
- 条数：1；用途：login（模板 `SMS_512115917`，签名 `青岛海信博世`）；目标：刘学奎本人的手机号；
- 结果：阿里云返回 OK，流水号（bizId）`222406294314654473^0`，时间 2026-11-10 12:44:13 UTC；
- 验证码：随机 6 位，只在内存里，**未打印、未保存**；
- 凭证来源：刘学奎放在仓库根目录临时文件里的 AccessKey（两行：ID、Secret），试发时只在子进程环境变量中使用；随后经刘学奎同意**写入本机 `.env`**（`HBECHO_SMS_*` 共 10 个键，权限 600，被 git 忽略），临时文件已覆盖后删除；仓库里所有会被 git 看到的文件均不含真实 ID 或 Secret（逐文件核对过）；
- 「手机是否真正收到」：**刘学奎确认已收到**（2026-11-10）；
- 尚未验证：reset、activate 两个模板的真实发送；经 Web 流程（`/phone-number/send-otp`）的端到端真实发送；这把 key 属于主账号还是 RAM 子账号（未判断）。

**2026-11-10 · 任务 6（用户管理）**
- 迁移 `0008_access_users_binding_ack`（新列 `binding_ack_staff_id`，AX-D30）：人工恢复时若绑定专员已停用，则记下这个专员 ID 表示「管理员知情」；任务 7 的懒停用 / 补偿遇到 `binding_ack_staff_id == media_staff_id` 必须跳过；改绑自然使其失效；**条件恢复（任务 7）在专员重新有效时必须清掉它**。0006 已推送，所以新开迁移而不是改它；
- `users/shared.ts`（读取 / 创建 / 停用 / 恢复内核，26 个用例）、`users/admin.ts`（invite / get / list / changeAccess / disable / restore / forceLogout，26 个用例）、`users/bootstrap.ts`（令牌与首个超管，6 个用例）；
- 与设计的偏差（已核实，待你知晓）：① 我最初按「同一门店编码跨品牌重复」写了一个专员定位歧义分支（`staff_ambiguous` + `storeBrandId` 选项），写测试时发现 `media_staff.active_phone` 全局唯一，**有效专员的手机号不可能重复**，该分支不可达，已删除；设计与验收里本来就没有这个错误码；② `bootstrap` 的拒绝细分为 `token_invalid / token_used / token_expired / superadmin_exists` 四个码，对操作者（有数据库凭证的运维）可见，对外无暴露；③ 变更授权的「最后一个超管」保护在正常路径上不可达（只有超管能管理超管，执行者自己就是一个可用超管），只会在执行者上下文已陈旧（刚被并发停用）时触发，用例用直接改库来模拟；
- 实现取舍：`bootstrapSuperadmin` 锁住令牌表全部行（表很小，增长型清理有界）来串行化「不同令牌的并发引导」，比引入 `GET_LOCK` 简单；
- 测试里有两处刻意的并发（`Promise.allSettled`，不是被 B-AX-13 禁止的 `Promise.all` 造数）：两个超管互停、两个令牌并发引导；锁顺序固定，结果确定。
**2026-11-10 · 任务 7（专员联动与每日维护）**
- `linkage.ts`（`disableIfStaffInactive`、`compensate`、`clearStaleAcks`、`conditionalRestore`、`cleanup`、`runNow`、`runDaily`）、`maintenance.ts`（给 worker 的装配，不需要 OSS）；`authenticate` 补懒停用；`runForever` 的 `extras.accessMaintain` 在 `sync-main` 里**无条件接入**（ODS 维护因缺 OSS 配置被关掉时它照常运行）；
- `authenticate` 的 `linkage` 依赖是**必填**：漏接线会让专员停用后的用户继续有效，不能做成可选；
- AX-D30 标记的完整生命周期：人工恢复时写入（任务 6）→ 懒停用 / 补偿跳过 → **专员重新有效时由维护的第一步清掉** → 之后再停用会被正常停用；用例覆盖这一整圈；
- 与设计的小偏差：① 条件恢复遇到「该专员已绑定了另一个非停用用户」（`UQ(active_staff)`）时，设计只写了同号冲突；我加了同样的处理（保持停用 + 质量问题 `user_auto_restore_blocked_staff_bound`），否则每天静默重试且无人知晓；② 步骤 3（审计到期清理）留空位 `purgeAudit`，任务 9 接入；③ `runDaily` 的起点按设计写的北京时间 04:30（现有 ODS 维护是整点 04:00，两者不同，是设计的原文）；
- 静态护栏：`acceptance-boundaries` 增加「access-control 里没有删除用户行的路径」「没有引用 `monitoring_enabled`」（D16、D17），用故意违规的临时文件验证过会失败；
- 注意（沿用之前的记录）：仓库里仍没有任何代码会把 `media_staff.status` 改成 `inactive`，所以这条联动的**触发源**要等主数据侧有「停用专员」功能；现在只有测试用直接改库来触发。
**2026-11-10 · 任务 8（用户批量导入）**
- `users/import.ts`（预检、确认、查询、回流）、`admin.prepareInvite`（把邀请拆成「只读校验」和「创建」，单个邀请 / 预检 / 确认三处用同一套规则）、夹具 `tests/fixtures/access/user-import/`（UTF-8 / BOM / GB18030 同内容 + 无法识别编码的字节）、23 个用例；
- 模板细节（设计与 PRD 没写死，**我定的，请业务确认**）：① 角色列填中文名（超级管理员 / 总部人员 / 分公司人员 / 经销商人员）或角色码都认；② 品牌、分公司列填**编码**（`brand_code`、`branch_code`），多个用 `;` `；` `、` `|` 分隔；③ 门店编码填门店编码；④ 每个原因码一句指引写在 `GUIDANCE` 里，措辞需要业务读一遍（acceptance M2）；
- 解释性决定：「确认时重新校验全部行」我实现为**重新校验每个将要写入的行**（授权、专员、手机号都重来一遍）；预检为 error 的行**不会**在确认时被升级成新增（否则「预检说错、确认却建了」会让业务意外，且等于绕过了预检的提示）。用例覆盖；
- `skippedRows` 记「越权跳过」（`role_not_grantable` / `scope_exceeds_boundary` / `store_not_in_scope`），`errorRows` 记其他错误；`conflictRows` 在确认后写入；
- 同一专员在文件内出现两次：预检第二行报 `staff_already_bound`（否则确认时第二行才冲突）；
- 回流文件只含没成功的行（预检 error、确认 conflict / invalid），与 master-data 一致；下载的审计是高风险（审计写失败则不给文件）；
- 租约：认领是一条原子语句（`awaiting_confirm` 直接认领，`writing` 仅在心跳超过 2 分钟时接手），每行一个事务并核对 token；用例模拟了「前一个进程死亡」→ `batch_busy` → 陈旧后接手；
- 没有做：行结果表没有「创建出的用户 ID」列，所以追溯某行建出的用户靠审计 `user_created`（`batchRef` + `source.rowNo`）。如果你想在行结果里直接看到用户 ID，需要给 `import_row_results` 加列，会动 A 域共用的表，所以我没自作主张。
**2026-11-10 · 任务 9（审计）**
- 持久写入器、幂等键、`purgeOlderThan`、`listAudit`、日志脱敏在任务 2 已经做完；这一步补了：`audit-adapters.ts`（`fromTracerAudit` / `fromSyncAudit` / `fromMasterDataAudit` / `fromPlanAudit`，结构类型，不 import 各模块，低风险、仍转发原 sink）、`audit-read.ts`（`audit.read` 授权的读取入口，只有超管能过）、`maintenance.ts` 把 `purgeOlderThan` 接成维护的步骤 3，以及 13 个数据库用例（`audit.db.test.ts`）；
- 用例证实了此前**没有测试**的东西：未到期 DELETE / 任何 UPDATE 被触发器拒、366 天前清掉且 364 天前保留且写一条 `audit_purged`（触发器按数据库时钟，所以这条用例用真实时间构造「N 天前」）、高风险写失败 → 业务事务回滚、低风险写失败 → 业务继续并计数、一次综合场景覆盖 10 类事件且全表扫描无令牌 / 凭据；
- 偏差 1：`PlanAuditEventShape` 是我**按 a-master-data-import 的风格假定的形状**（snake_case：`event_type`、`actor`、`occurred_at`、`plan_id`、`batch_id`……）。a-activity-plan 的设计里只列了事件名（`roster_batch_confirmed`、`staff_created`、`monitoring_*`），没有审计端口的形状；A 落地时对不上就改适配器，不改 A；
- 偏差 2：design §7.14 的 reason_code 目录是「节选」，实现里**没有出现**的有：`sms_rate_limited`（60 秒限频被拒不写审计，只记 `access_sms_sends`）、`otp_attempts_exceeded`、`session_revoked`；`delivery_scope_shrunk`、`job_cancelled_on_revoke` 属任务 10。我没有为了凑目录而造事件；如果你要这几类可追溯，需要明确说，我再补；
- 注意：适配器只是**能用**，还没有在任何进程里替换掉 `createLog*`（那是任务 11 的「审计装配替换」）。所以现在 `tracer` / `sync` / `master-data` 的 CLI 事件仍然只进日志；
- 同一秒内同一事件（同 actor、同对象、同细节）会被幂等键合并成一条，这是设计的取舍（防重试重复），代价是极短时间内的真实重复操作只留一条。
**2026-11-10 · 任务 10（数据出口框架）**
- `egress.ts`：`guardExit`（十个出口）、`snapshotForJob`、`effectiveScope`、`checkJobAtExecution`、`recheckDelivery`、`registerJobCanceller`、`cancelUserJobs`、`issueSignedLink`、`exportCapabilityFor`、`serializeScope` / `parseScope`；`authenticate` 拆出 `contextForUser(userId)`（后台任务执行时 / 交付前按提交者现建身份，已停用或专员失效立即反映）；`authorize` 增加三个拒绝原因（`exit_not_allowed`、`scope_required`、`row_limit_required`）；28 个用例（`egress.db.test.ts`，fake 出口）；
- 每个出口的通用规则（**我按 PRD §10.1 的表归纳的，各域接入时可能要微调**）：1 页面查询、9 通知只要范围；2 手工同步只收 `data.sync.trigger`；3 报表只收 `report.read`；4 导出只收 `data.export` / `report.export` 且只允许用户身份；5 媒资只收 `data.media.read`；6 原始载荷只收 `data.raw_payload.read`、只允许用户身份、必须审计；7 后台 Worker：服务身份**不能带角色**（防伪造超管），用户触发的任务继承提交者；8 AI 取数必须声明行数上限并审计；10 学习资料下载只收 `learning.read` 并审计；
- **新增了设计里没有的撤权触发点**：`changeAccess` 在『降级、或拿掉原有品牌 / 分公司』提交后也调 `onRevoked`（设计原文只写了停用；PRD B-D28 写的是「停用或撤权」）。晋升（如分公司→总部）不触发，用例覆盖；
- 需要你定的数值：① 签名链接最长有效期我取 **900 秒（15 分钟）**（`MAX_SIGNED_LINK_TTL_SECONDS`；PRD 只写「短期有效」）；② AI 取数的行数上限数值**没有写死**，由调用方在请求里声明，守卫只检查「必须声明且为正整数」并原样带回——如果你想要一个全局上限（例如 500 行），告诉我数；
- 审计：需要审计的出口（2、4、6、8、10）允许与拒绝都记，**低风险、不在业务事务里**（守卫没有事务可传）。所以出口 6 这类高敏动作的审计写失败时，**不会阻止访问**。设计 §7.14 把「高风险」定义为与业务写入同事务，出口守卫天然不满足这一条。如果你要求原始载荷访问必须「审计写失败即拒绝」，我需要改成守卫返回前同步写且失败即拒（一行改动，但会让审计库故障时原始载荷读取不可用）——请决定；
- `snapshotForJob` 对服务身份直接抛错（计划任务不走快照）；`cancelUserJobs` 对非 `user:` 开头的主体什么都不做（计划任务不被取消）；
- 还没做：各业务域的 canceller 注册（它们的任务类型都不存在）；没有真实的签名器；没有出口 5/9 的真实实现。这些是所属域的事，本任务只交付框架与契约测试。
**2026-11-10 · 任务 11（适配器、审计装配替换、CLI）**
- `adapters.ts`（`toPlanActor` / `toMasterDataActor` / `toTracerActor` / `userIdOf`，目标形状是结构类型；测试里把适配结果赋值给 master-data 与 tracer 的**真实类型**，字段改名会编译失败）、`index.ts`（模块唯一对外入口，静态护栏 B-AX-14 强制：模块外只能走入口，例外是 `src/app` 与 `worker/access-*`、`worker/sms-smoke-*`；用故意违规的临时文件验证过会失败）、`access-cli.ts` / `access-wiring.ts` / `access-main.ts`、`package.json` 的 `"access"` 脚本；
- **审计装配替换**：`sync-main`、`sync-wiring`（worker 进程）、`master-data-main`、`tracer-cli` 四处把 `createLog*` 换成「日志 + 持久」组合，业务模块代码一行未改，**既有测试没有改过一个断言**（全套仍绿）；`audit-wiring.db.test.ts` 用真实的 tracer 命令模块验证事件落库、可按 actor / 对象查询、locator 原文不入审计；
- **没有换的**：`a-activity-plan` 的装配（它还没有实现）；`sync` / `master-data` 两条链路我只测了适配器，没有各写一个端到端用例（tracer 那条是代表）；
- CLI：全部 design §9.3 的命令；退出码 0/2/3/4/5/1；没有 `--force` / `--skip-auth`（用例逐个验证未知选项退出码 2 且不改数据）；所有写命令不带 `--apply` 只预览；
- **偏差（AX-D32，待你确认）**：设计原文让 CLI 从 5 个环境变量里读身份（角色、能力、品牌 / 分公司范围）。我改成只认 `HBECHO_ACCESS_ACTOR=user:<id>`，其余**全部从数据库现算**。理由：环境变量自己声明的角色没有任何东西核对，等于「说自己是超管就是超管」；从库里现算后 CLI 的权限不可能超过那个真实用户，也和页面入口走同一个 `contextForUser`。代价：必须先有一个能激活登录的真实用户（首个超管走 `bootstrap-superadmin` + 短信激活之后才有）；紧急情况下没有任何用户时，只有 `token create` / `bootstrap-superadmin` / `maintain` 可用；
- 偏差 2：设计让「影响多个对象的命令」默认预览，我让**所有**写命令都默认预览（更简单，也更安全）；
- `access user import ...` 多了一个 `list`（`batches`，只列本人提交的）；`user invite --apply` 前的预览多返回 `phoneExists`；
- 没做：`a-activity-plan` 侧「引用 B 适配器的契约测试」（设计写明由 A 的任务补）。
**2026-11-10 · 任务 12（验收、规模、测试 ECS、文档）**
- **验收对照**：先让一个独立的只读审计逐行对照 195 行验收（182 个自动项）与测试：125 行已覆盖、43 行部分、11 行缺失、3 行不可离线判定。随后补了 `acceptance-gaps.db.test.ts`（22 个用例）等，**没有直接信审计的结论**：补的每一条都跑过。补完后见 acceptance「逐条结果」；仍有 18 项偏弱（C6 / C7 / C13 / C17 / C18 / D14 / E3 / E8 / E15 / E19 / F5 / F6 / G14 / J1 / J2 / J9 / K10 / K12）和 4 项依赖所属域（F14 / F15 / F16 / J12）；
- **审计发现并已修的真实问题**：① `toMasterDataActor` 对没有导入能力的角色返回了可用 Actor（K2 要求不可适配）；② `access maintain` 不带 `--apply` 就直接执行（会停用 / 恢复用户、清理表，K13）；③ 没有 `monitoring_level` 谓词的标准体（E9）；④ 验收条目与实现不一致的 5 处措辞已订正（B7、H9、K2、K8、L10），**订正的是验收文字而不是降低实现标准**，每处原因写在该行；
- **全量验证时撞到的真实缺陷**：引导令牌用 base64url 生成，约 1/64 的令牌以 `-` 开头，`parseArgs` 会把它当成选项，`bootstrap-superadmin --token <t>` 随机失败。已改为 64 位十六进制并加断言；
- 规模：1,000 行导入预检约 0.4 秒、确认约 3.2 秒（design §12）；
- **测试 ECS**（`./scripts/ecs-test.sh`，Workbench，一次性 MySQL + node 容器，`hbecho_test` 库，用完 `--rm` 清理，已确认测试机上只剩原有的 `hbecho-mysql`）：HEAD `21f6d94`，数据库测试 **67 个文件通过 / 1 个跳过，897 个用例通过 / 1 个跳过，测试耗时 152 秒**（含安装约 8 分钟），node 容器内存峰值约 989 MiB、MySQL 约 565 MiB。审计触发器（UPDATE / 未到期 DELETE 被拒）在该 MySQL 8.4 容器里生效，所以 ENV-4 的**触发器本身**得到验证，但「部署账号具备 TRIGGER 权限」要等有部署账号时才能验证，仍记未完成；
- `next build`（ENV-2）本机一次性通过，约 4 秒，路由只有 `/api/auth/[...all]` 与 `/api/health`；
- 文档同步：INDEX（状态与 `a-activity-plan` 的措辞）、`CLAUDE.md` 代码地图、`ui-foundation.md` §3 的排期措辞、`a-activity-plan` design §7.2 的手机号注记、design §12 规模数字；`ui-foundation.md` §3 表里页面的「状态」仍是「未建」（页面确实没建）。
**待你决定 / 确认的事项（汇总）**
1. **AX-D32**：CLI 身份只认 `HBECHO_ACCESS_ACTOR=user:<id>`，角色与范围从数据库现算（取代设计原文的 5 个环境变量）。代价：没有任何有效用户时，只有 `token create` / `bootstrap-superadmin` / `maintain` 可用；
2. **AX-D33**：① `changeAccess` 在降级 / 拿掉品牌或分公司后也取消该用户的未完成任务（设计只写了停用）；② 出口守卫的审计是低风险、不在业务事务里——**原始载荷访问（出口 6）审计写失败不会阻止访问**，要不要改成「审计写失败即拒绝」；
3. 数值：签名链接最长 900 秒；AI 取数的行数上限没有写死，由调用方声明；
4. 用户导入模板的细节（角色列填中文名或角色码、品牌 / 分公司列填**编码**、多值用 `;` 分隔）以及 `GUIDANCE` 里每个原因码的指引措辞——需要业务读一遍（acceptance M2）；
5. 导入 `import_row_results` 没有「建出的用户 ID」列，追溯靠审计 `user_created`；要不要给 A 域共用的表加列；
6. design §7.14 的 reason_code 目录里 `sms_rate_limited`、`otp_attempts_exceeded`、`session_revoked` 实现里没有对应审计事件，是否需要补；
7. 手工项 M1–M5 还没有人做；短信 reset / activate 两个模板、整条 Web 流程的真实发送未验证（只发过一条 login 模板）；`@alicloud/dysmsapi20170525` 包与版本待在 ADR-0005 里确认；
8. 仓库里仍没有任何代码把 `media_staff.status` 改成 `inactive`：专员联动的触发源要等主数据侧有「停用专员」功能。
**已知问题（非本 spec 引入，2026-11-10 记录）**

- `services/capability` 的 `tests/test_app.py::test_image_errors_are_structured_json` 在本机**间歇性失败**：单独连续跑 10 次，9 次通过、1 次失败（`urllib.error.HTTPError: 415` 在 `call()` 的 `except` 之外被抛出，疑似 Python 3.14 + 测试服务器的连接处理细节）；整个套件连跑 3 次全过。我没有改过该目录，也没有深挖，只记录证据。更早一次 verify 还出现过 HEIC 用例失败，当时下的「ffmpeg 版本」结论站不住，同样应视为间歇性；
- **CI 不验证 Python 侧**：`ci.yml` 没有安装 pytest / ffmpeg / 建 venv，`verify.sh` 第 9 步在 CI 上走 `SKIPPED（Python 侧未验证）`。所以 CI 绿不代表 Python 侧通过，这与 `dev-ci-cadence` 里「CI 绿 ≠ Python 侧验过」的措辞一致，但这条边界目前没有被任何文档明确写成现状。

**2026-11-11 · 页面任务 P1–P5**
- 代码：`src/app/`（页面、服务端动作、组件、样式）、`src/modules/access-control/web.ts`（装配与名称补全）、`audit.ts` / `audit-read.ts` 增加 `countAudit` / `count`（审计页的总数与失败数，与列表同一条谓词）；
- **本机点击走查发现并已修的一处真问题**：服务端动作里用 `instanceof AccessError` 判断业务拒绝，在 Next 的服务端打包下会误判为内部错误（邀请总部人员不选品牌，应得「角色与范围的组合不对」，实际显示「内部错误」）。改为按错误名识别（`isAccessError`），并按原因码给出更具体的人话（`shape_invalid` 等）；
- `tsconfig` 增加 `jsx` 与 DOM 库（页面需要）；DOM 的 `BodyInit` 不接受 `Uint8Array<ArrayBufferLike>`，`capability-client.ts` 与 `http-transport.ts` 各加一处只影响类型的转换，运行时不复制字节；
- **`pnpm access ...` 在 pnpm 11 里被内置命令 `pnpm access` 截获**（报 Unknown subcommand）。本机与镜像里一律用 `pnpm run access ...`；`package.json` 的脚本名没有改（改名会影响文档与测试里的所有引用，另行决定）；
- 偏离与取舍（待你确认）：① 视觉沿用原型 CSS 而非 shadcn（见上）；② 审计事件筛选用单个事件下拉，不做原型第一版的「事件分类」；③ 「批量停用待激活用户」只在状态筛选 = 待激活时出现；④ 列表每页固定 20 行（ui-foundation 写可选 20 / 50 / 100，未做切换）；⑤ 登录页默认「密码」页签（原型默认验证码），避免每次登录都产生短信费用；⑥ 门店专员登录后只看到「门店端页面还没有开放」说明页（「我的考核」「学习」不在本 spec）；
- 镜像约 1.5 GB（含 devDependencies，因为同一镜像要跑 `tsx` 迁移与 `access` CLI）；拆成运行镜像与工具镜像是后续优化，不阻塞。

**2026-11-11 · 独立审查（DeepSeek 报告）的核实与处理**
- 核实方法：每条结论回到代码 / 复现，不照单全收。**成立并已修**（均有回归用例，`review-fixes.db.test.ts`）：
  ① 登录失败表清理漏掉「第 5 次失败且锁定已过期」的行（匿名请求可使表无限增长）；② `monitoring_level` 谓词缺 `ref` / `level` 时放行（改为 fail-closed，超管也没有旁路）；
  ③ 两个超管同时互相降级**稳定死锁**（实测修复前 12/12 轮死锁，修复后 0）：`changeAccess` 与 `disableCore` 的锁顺序不一致，统一为「先按 ID 升序锁全部超管，再锁目标」；
  ④ `reasonCode` 可写自由文本（审计写入口增加稳定标识符校验，高低风险一样抛）；⑤ `onDenied` / `onUnresolvable` / `onRevoked` 在页面与 CLI 装配里是空的（授权拒绝不留痕、撤权不取消任务、自动停用也不经过撤权出口）——新增 `services.ts` 作为页面与 CLI 共用的唯一装配点；
  ⑥ 改名只改 `access_users`，不同步 `auth_users.name`；⑦ `ER_DUP_ENTRY` 字符串判断改用 `isDuplicateKey`；
  页面：门店专员的品牌 / 分公司（授权表里没有，来自所在门店）在详情为空、按品牌 / 分公司筛选时被排除；编辑里可选「门店专员」但服务端必拒；导入确认文案与真实行为不符（审计写入失败时批次停在「写入中」可续跑，不是「其余行继续」）；文件级错误丢了失败项与样本；弹窗 `id` 重复；`revokeObjectURL` 立即回收；冷却定时器不停；
  部署：镜像默认启动经 `pnpm exec`，运行时 corepack 会去外网下载 pnpm（改为直接调用 `node_modules/.bin`）；CI 推送前没有容器冒烟（已加，走生产配置路径）；`HBECHO_ICP_NUMBER` 不在 `.env.example`；`pnpm access` 文档写法在 pnpm 11 下不可用（全仓改为 `pnpm run access`）；本文件里过期的状态行与未勾选项；
  护栏：页面目录的角色字面量白名单收窄到 5 个展示文件。
- **核实后不采纳或有保留**：
  · 「`createStoreStrategy` 把本人实现成本门店」：行为属实，但它的设计就是门店粒度（注释写明由所属域组装），当前没有资源注册它；只补了注释，说明不能直接用于「专员名下」资源（验收 F6），由 A 域在 ref 里带 `mediaStaffId`；
  · 「测试 ECS 不能用生产配置跑假短信，必须新增 `HBECHO_DEPLOY_ENV`」：不采纳。测试 ECS 按刘学奎 2026-11-11 的决定使用真实阿里云短信（专用 RAM 子账号、仅 `dysms:SendSms`、每日上限 100），首个超管必须收到真实验证码才能激活，假发送器的码无处可读；`NODE_ENV=production` 仍然是唯一的运行态开关，没有第二套；
  · 「审计页缺操作者 / 对象筛选，属于确认范围内的缺失」：design §15.1 文字写了，但 2026-11-10 刘学奎确认的 v2 原型明确把筛选改成「事件 / 时间两个下拉」（ui-lab/hbecho-ui-v2/README 第二轮第 1 条）。**待刘学奎裁决**：是否补；
  · 「`ClickRow` 没有键盘入口」：行内姓名是链接，可 Tab 到；整行点击只是鼠标便利；
  · 「静态护栏被放宽」：已收窄，不再整目录放行；
  · 「部署拓扑 / 脚本 / 健康检查缺失」：审查时间点早于实际部署；compose 服务、web.env、迁移账号与只读 web 账号、`/api/health` 见 runbook P6 与本节后续记录；`deploy/` 脚本仍未建（runbook §7.3：先把第一次手工部署的命令跑通并记录，再固化为脚本）。
**2026-11-11 · 测试 ECS 部署**
- 镜像 `…/hbecho/app:cd8188516e13`（CI run `42954316236`：`verify` 绿、容器冒烟（生产配置路径）通过、推送成功）；服务器内网拉取约 40 秒；
- 服务器：`hbecho-mysql` 8.0.46 → 8.4.13（先做逻辑备份），迁移全部应用（**第一次迁移失败**：二进制日志开启且 `log_bin_trust_function_creators=OFF` 时非 SUPER 账号建不了触发器，即本文「需要停下来并报告」第 9 条的情形；加 `--log-bin-trust-function-creators=1` 后从空库重放成功，失败留下的半成品库已删除重建）；
- 应用容器只发布 `127.0.0.1:3000`，nginx 反代，`https://echo.hbmarketer.com/login` 200 且有备案号页脚，`/users` 未登录 307，错误密码登录 401 且写入失败计数（运行账号 DML 权限、`X-Forwarded-For` 链路正常）；
- 首个超管（刘学奎，`17863267891`）已创建为**待激活**。**激活由本人完成**（真实验证码发到本人手机，这条链路——阿里云签名 / 模板 / 每日上限 100——我没有替本人验证）；
- **还没有做的**：测试 ECS 上的页面点击走查（激活后才能登录）；用户走查后更新 acceptance 末表的「测试 ECS 上走查」。
- 测试 ECS 当前镜像 `…/hbecho/app:93bff48bf251`（含审计筛选；CI run `42959566514`）；首个超管已由本人激活并登录（刘学奎，2026-11-11）。
- **刘学奎 2026-11-11 裁决**：① 审计页补「操作者 / 对象」筛选（已实现：输入姓名或手机号，服务端解析成用户 ID，需要 `audit.read`；输入了但没有匹配则结果为空）；② 稳定错误码可以在界面显示（design §15.3 已订正）；③ 接受纯 CSS，同时不排斥 shadcn，复杂组件由用到它的 spec 引入（ui-foundation §0、§6.4 已订正）。
- **ACR 推送「慢」的复核（2026-11-11，对照 hbdam）**：先前判断「GitHub runner 到北京 ACR 约 1 MB/s」**不对，已订正**。在 `ci/acr-probe` 分支实测（已删）：300 MB 不可压缩大文件推送 32 秒，约 9.4 MB/s，与 hbdam 的 12 MB/s 同量级，链路没有问题；同样 100 MB 数据拆成 2 万个小文件，推送 54 秒，约 1.85 MB/s。慢的是 docker 对大量小文件的单层打包压缩，所以 `node_modules` 层首次推送要几分钟，而且单阶段 1.5 GB 镜像每次都带着它。两阶段后稳态：`verify` 约 5 分钟 + `image` 约 1.5 分钟（构建 1 分钟 + 推送 30 秒，CI run `42959566514`）；我之前感觉到的「很久」主要是首次推送与排队，再加上我轮询得太长。

**2026-11-11 · 合并**：`b-access-ui` 以 `--no-ff` 合并 `main`（合并提交 `50eaef9`）；CI run `42962236578` 全绿（`verify` + `image`），本机 `verify.sh` 通过（单元 733、数据库 909）；测试 ECS 运行镜像 `hbecho/app:93bff48bf251`，首个超管已激活并登录。仍待做：测试 ECS 上的页面点击走查（刘学奎，acceptance 末表对应行）。
