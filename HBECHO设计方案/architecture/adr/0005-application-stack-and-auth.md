# ADR-0005 · 应用技术栈与认证库

- **状态**：accepted
- **日期**：2026-10-27
- **决策人**：刘学奎
- **关闭**：ADR-0004 中的「应用框架」「ORM / 迁移工具」「队列实现」三项
- **替代**：旧项目沉淀中的 NestJS / Prisma / BullMQ / Redis 选型

## 背景

ADR-0004 把框架、ORM 与队列列为延迟决定，理由是这些选择会被脚手架悄悄固化。到 2026-10-27，1.0 的九个 spec 无法在没有语言生态的情况下开工：认证库、迁移工具、Excel/CSV 解析、图像处理进程都依赖它。

hbdam 已在生产前验证了一套 Node / TypeScript 栈，其中认证、ORM、校验、日志、OSS、短信均有实测记录与已知坑。复用同一栈可以把"选型风险"换成"已知风险"。

## 决定

### 1. 主语言

- **TypeScript（Node 20 LTS 或更高）** 为应用主语言，承载 Web、API、任务 Worker 与数据访问。
- **Python 仅作能力辅助进程**：图像处理（SIFT/ORB、OCR 编排）、音视频（ffmpeg）、文档解析（2.0 的 Docling）。不承载业务状态、不直连业务库、不实现权限。

### 2. 框架与数据访问

| 层 | 选择 | 与 hbdam 一致 |
|---|---|---|
| Web / API | Next.js 16 App Router + React 19 | 是 |
| UI | Tailwind 4 + shadcn/ui + Radix | 是 |
| ORM / 迁移 | Drizzle ORM + drizzle-kit（MySQL 8） | 是 |
| 校验 | zod | 是 |
| 日志 | pino | 是 |
| 对象存储 | ali-oss 官方 SDK | 是 |
| 短信 / 云资源 | `@alicloud/*` 官方 SDK | 是 |
| 测试 | vitest | 是 |

### 2.1 采用清单与「不用它做什么」

| 组件 | 用途 | 不用它做什么 |
|---|---|---|
| better-auth | 登录、密码、会话、滑动过期、强制下线、设备列表、忘记密码 | 组织与品牌隔离、角色矩阵、管理范围、组织归属、导入流程 |
| Drizzle ORM + drizzle-kit | 类型安全查询、迁移、查询层身份上下文的编译期强制 | 权限谓词、审计字段黑名单 |
| Next.js 16 App Router | 页面与管理后台、接口层 | 图像处理、批量任务、文档解析 |
| React 19 + Tailwind 4 + shadcn/ui + Radix | 组件与样式 | 业务组件逻辑、权限判断 |
| zod | 接口入参、配置值、导入行、AI 输出结构校验 | 校验规则本身（业务定义） |
| pino | 结构化 JSON 日志、追踪编号、脱敏、轮转 | 哪些字段算敏感（业务约定） |
| ali-oss | 签发链接、服务端核对对象、分片上传配合 | CDN 鉴权签名 |
| `@alicloud/*` | 短信、STS 等云资源 | 业务模板与限流 |
| vitest | 单元与集成测试 | — |
| sharp | 缩略图、尺寸与格式校验 | 图像识别（SIFT/ORB 在 Python 侧） |
| Recharts（待 E 域确认） | 看板图表 | 指标口径与聚合 |

### 2.2 明确自建的部分

| 自建项 | 理由 |
|---|---|
| 异步任务队列 | 任务与业务事实必须同事务；BullMQ 需要 Redis |
| 业务授权（Capability / DataScope / GrantBoundary） | 通用 RBAC 不认识组织路径与账号归属 |
| 数据出口的强制注入 | 每个出口的业务规则不同，库无法代劳 |
| 监控告警 | 几条 SQL + 阈值即够 |
| AI 调用记录与配额联动 | 必须与平台审计和成本中心同一套 |

### 3. 认证

- **better-auth** 负责：手机号 + 密码、短信验证码登录、密码存储与校验、会话与滑动过期、强制下线、设备列表、忘记密码。
- **授权自建**：Capability 注册表、DataScope、ScopeStrategy、GrantBoundary、管理范围谓词、七个以上数据出口的强制注入。

### 4. 队列

- **自建基于 MySQL 的任务表**：`FOR UPDATE SKIP LOCKED` + 租约 + fencing token + 指数退避 + 死信。
- **不引入 Redis / BullMQ**。与 v2 §9.3 的任务语义一致；任务与业务事实可在同一事务提交。

### 5. 导入格式

- **CSV，不用 xlsx**。理由见「备选与不选原因」。

## 备选与不选原因

| 候选 | 不选原因 |
|---|---|
| Prisma | 对 `FOR UPDATE SKIP LOCKED`、受限写入过程要退回裸 SQL；迁移需跑代码生成器。1.0 的租约与受限写入是核心，不能退回裸字符串 |
| NestJS | 与 hbdam 不一致；Next.js 的 Route Handler 已能承载 API，1.0 规模不需要第二套分层框架 |
| BullMQ / Redis | 为一个队列新增一整套基础设施；任务状态与业务数据分处两库，破坏"同一事务提交" |
| exceljs | 上游最后发布 2024-12，停滞 21 个月，四个 CVE 未修，漏洞上报通道关闭（hbdam 2026-09-15 实测） |
| exceljs-hardened | 活跃安全 fork，但只修了已知四类，仍不在主流维护路径 |
| read-excel-file | 活跃但星数不到判据线 |
| npm `xlsx` | 落后于 SheetJS 官方分发 |

**为什么 CSV 够用**：1.0 的导入只有名单与主数据，全是纯文本列，不需要多 sheet、格式、公式或合并单元格。换成 CSV 后 zip 解析层整体消失，压缩炸弹与原型污染两类风险随之消失。

**CSV 的唯一新风险已解决**：Windows 版 Excel 另存 CSV 默认 GBK。用 Node 内置 `TextDecoder('gb18030', { fatal: true })` 解码，失败再回退；`fatal: true` 必须开，否则非法字节被静默替换成 U+FFFD，GBK 文件会"成功"解成乱码而不报错。该能力依赖 full-icu，需一条独立测试锁住。

## 后果

- 仓库为单一 Node 应用 + 一个 Python 能力进程；不引入第二套运行时框架。
- 迁移单一来源（drizzle-kit）；`db:push` 禁用，只走 `db:migrate`。
- 类型系统可在编译期拦住"查询层缺少身份上下文"的调用。
- 认证表由 better-auth 拥有，授权表由本项目拥有；两者不得各建一套 `User`。
- 部署拓扑与反代形态已由 ADR-0006 关闭（Docker Compose + 宿主 Nginx）。
- **进程形态**（2026-11-04 补）：同一仓库、同一镜像、两个启动命令——Web（Next.js）与 Worker（独立 Node 进程，领取 MySQL 任务表）。Worker 不在 Next.js 进程内运行；同步、媒资下载、判定执行、投影构建、报表导出都在 Worker 里跑。两者共用 Drizzle schema 与迁移。Python 能力服务见 ADR-0012。
- **报表导出**用 exceljs 仅写入，见 ADR-0011；本 ADR「备选与不选原因」对 exceljs 的否决只针对**导入**（解析外部 xlsx）。

## 已知坑（来自 hbdam 的实测，实施时必须处理）

| # | 事项 | 处理 |
|---|---|---|
| 1 | better-auth 的 `adminAc` 默认给 `set-password` 与 `impersonate` | 不得直接当超管角色用；冒充会让审计记录说谎 |
| 2 | `defaultRole` 默认 `user`、`adminRoles` 默认 `["admin"]` | 必须显式改成项目四类角色；不改则静默得到无效角色 |
| 3 | 管理员改密码不会自动撤销该用户会话 | 改密流程必须单独调撤销 |
| 4 | `/phone-number/reset-password` 在无 credential account 时会自动建行 | 激活与忘记密码是同一条库路径，激活无需额外端点 |
| 5 | 登录失败限流不由 better-auth 承担 | 自建限流（IP + 账号双维度） |
| 6 | 多租户组织插件不适用于本项目 | 组织归属用业务表，不用租户模型 |
| 7 | drizzle-kit 能否生成 v2 需要的 CHECK、复合外键、生成列与受限写入过程（未核实） | tracer 第一个建表任务里验证；不支持的部分写手写 SQL 迁移，并回来补本行 |

## 现在谁在守

- `package.json` / `drizzle.config.ts` / CI 的依赖审计；
- B 域 spec 的认证测试（会话撤销、角色默认值、改密踢出）；
- `.kiro/steering/no-reinventing-wheels.md` 的"不用它做什么"栏。

## 原文

`HBECHO设计方案/prd-platform.md` §9；`HBECHO设计方案/architecture/adr/0004-defer-application-stack.md`；hbdam `DAM设计方案/adr-选型决策记录.md` §1.1–§1.8、§3.1。