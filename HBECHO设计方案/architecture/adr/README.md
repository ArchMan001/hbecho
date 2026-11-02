# 架构决策记录（ADR）

> **状态**：`current`
> **适用**：记录难以逆转、存在真实取舍、且会约束后续多个模块的决定。
> **不适用**：普通实现细节、可随时改回的技术偏好、未决项本身。

## 怎么用

1. **每项决定一个文件**，文件名 `NNNN-短横线标题.md`，编号不复用。
2. 写清：状态、日期、决策人、背景、决定、备选方案与不选原因、后果、它推翻或替代了什么、现在谁在守。
3. **选型必须写「不用它做什么」**。省掉这一栏，半年后没人分得清哪部分是库的责任、哪部分是自己的。
4. 新增或修改决定时，同步更新本文件的索引表与 `HBECHO设计方案/INDEX.md` 的权威矩阵。
5. 与 `HBECHO设计方案/governance/constitution.md` 冲突时，先停下，在同一变更里修正两处。

## 决策索引

| 编号 | 决定 | 状态 | 日期 | 决策人 |
|---|---|---|---|---|
| [0001](0001-oss-bucket-topology.md) | OSS 按保留期分四桶（ods / media / temp / backup） | accepted | 2026-09-03 | 刘学奎 |
| [0002](0002-self-hosted-mysql-first-version.md) | 首版自建 MySQL 8.0，不用 RDS | accepted | 2026-09-04 | 刘学奎 |
| [0003](0003-github-authoritative-remote.md) | GitHub 作为权威远端，Codeup 降级为可选镜像 | accepted | 2026-09-03 | 刘学奎 |
| [0004](0004-defer-application-stack.md) | 暂不冻结应用框架、ORM/迁移工具与队列 | accepted（延迟决定，已被 0005 部分关闭） | 2026-09-02 | 刘学奎 |
| [0005](0005-application-stack-and-auth.md) | 应用技术栈与认证库：Node/TypeScript + Next.js + Drizzle + better-auth；队列自建；导入用 CSV | accepted | 2026-10-27 | 刘学奎 |
| [0006](0006-host-nginx-reverse-proxy.md) | 反向代理部署形态：Docker Compose + 宿主 Nginx，应用容器只绑 127.0.0.1 | accepted | 2026-10-28 | 刘学奎 |
| [0007](0007-course-video-vod.md) | 课程视频用阿里云 VOD 承载：媒资存华北2、OpenAPI 走 cn-shanghai、720p+480p 模板组、备案后播放 | accepted | 2026-10-29 | 刘学奎 |
| [0008](0008-store-identity-and-code.md) | 门店身份与编码分离：内部 `store_id` 为身份，唯一键 `(brand_id, store_code)`，消失不自动停用 | accepted | 2026-11-02 | 刘学奎 |
| [0009](0009-account-watch-and-external-monitoring.md) | 账号监控对象分两型：`staff` 归属与 `external` 外部监控；外部账号复用采集链路 | accepted | 2026-11-02 | 刘学奎 |

## 未决选型登记

以下项目**没有决定**，任何文档、脚手架或示例都不得把它们写成已选型。每项必须由独立决定关闭，并在此追加一行 ADR。

| # | 未决项 | 关闭时机 | 出处 |
|---|---|---|---|
| 1 | ~~应用框架~~ —— 已由 ADR-0005 关闭 | — | ADR-0005 |
| 2 | ~~ORM / 迁移工具~~ —— 已由 ADR-0005 关闭 | — | ADR-0005 |
| 3 | ~~队列实现~~ —— 已由 ADR-0005 关闭（MySQL 任务表，不引入 Redis） | — | ADR-0005 |
| 4 | ~~反代形态（宿主 Nginx or 容器）~~ —— 已由 ADR-0006 关闭：宿主 Nginx | — | ADR-0006 |
| 5 | ~~最终 `RoleCode`~~ —— 已由 D-22 关闭：`platform_admin` / `hq_manager` / `branch_manager` / `store_staff` | — | prd-platform §5.1 |
| 6 | ~~`User ↔ MediaStaff` 首版是否严格一对一~~ —— 已由 B 域 PRD §8.3 关闭：一对一，绑不上拒绝本人范围 | — | prd-domain-b §8.3 |
| 7 | Branch 范围是否与显式品牌 grant 求交 | 同上 | `HBECHO设计方案/INDEX.md` §10 |
| 8 | ~~登录手机号：明文 or `ciphertext + lookup HMAC`~~ —— 已由 D-42 关闭：明文保存 | — | prd-platform §5.1 |
| 9 | ~~AI Master 正式 QPS / 并发 / 计费 / SLA / 轮询失败合同~~ —— 已关闭：认证、同步/异步、计费口径已实测；SLA 由业务接受为风险 | — | prd-platform §11.1 |
| 10 | ~~视频/音频归档范围~~ —— 已由 D-29 关闭：按规则圈定范围归档 | — | prd-platform §5.1 |

> 2026-10-28 同步：关闭 4、5、6、8、9、10 六项，均只标来源、不新增判断。仅 #7（Branch 范围与品牌 grant 求交）仍未决。

## 与其他文档的关系

- 领域语义：`CONTEXT.md`，ADR 不得改写。
- 物理实施基线：`HBECHO设计方案/domains/data-foundation/database-design-v2.md`。
- 不可协商条款：`HBECHO设计方案/governance/constitution.md`。
- 运维步骤：`HBECHO设计方案/runbooks/server-operations-runbook.md` 与 `HBECHO设计方案/runbooks/dev-test-deploy-workflow.md`。