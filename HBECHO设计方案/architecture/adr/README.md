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
| [0001](0001-oss-bucket-topology.md) | OSS 按保留期分四桶（ods / media / temp / backup）；2026-10-29 增 `course`，2026-11-12 增 `signals`（待创建） | accepted | 2026-09-03 | 刘学奎 |
| [0002](0002-self-hosted-mysql-first-version.md) | 首版自建 MySQL，不用 RDS；版本基线 8.4 LTS（2026-11-04 修订） | accepted | 2026-09-04 | 刘学奎 |
| [0003](0003-github-authoritative-remote.md) | GitHub 作为权威远端，Codeup 降级为可选镜像 | accepted | 2026-09-03 | 刘学奎 |
| [0004](0004-defer-application-stack.md) | 暂不冻结应用框架、ORM/迁移工具与队列 | superseded（被 0005、0013 全部关闭） | 2026-09-02 | 刘学奎 |
| [0005](0005-application-stack-and-auth.md) | 应用技术栈与认证库：Node/TypeScript + Next.js + Drizzle + better-auth；队列自建；导入用 CSV | accepted | 2026-10-27 | 刘学奎 |
| [0006](0006-host-nginx-reverse-proxy.md) | 反向代理部署形态：Docker Compose + 宿主 Nginx，应用容器只绑 127.0.0.1 | accepted | 2026-10-28 | 刘学奎 |
| [0007](0007-course-video-vod.md) | 课程视频用阿里云 VOD 承载：媒资存华北2、OpenAPI 走 cn-shanghai、720p+480p 模板组、备案后播放 | accepted | 2026-10-29 | 刘学奎 |
| [0008](0008-store-identity-and-code.md) | 门店身份与编码分离：内部 `store_id` 为身份，唯一键 `(brand_id, store_code)`，消失不自动停用 | accepted | 2026-11-02 | 刘学奎 |
| [0009](0009-account-watch-and-external-monitoring.md) | 账号监控对象分两型：`staff` 归属与 `external` 外部监控；外部账号复用采集链路 | accepted | 2026-11-02 | 刘学奎 |
| [0010](0010-scope-brand-intersection.md) | 组织范围与品牌集合求交：品牌必须显式授予，不从组织推导 | accepted | 2026-11-02 | 刘学奎 |
| [0011](0011-report-export-exceljs-write-only.md) | 报表导出用 exceljs 4.4.0，仅写入；导入仍只用 CSV | accepted | 2026-11-04 | 刘学奎 |
| [0012](0012-python-capability-service.md) | Python 能力服务：FastAPI + OpenCV + ffmpeg，compose 内网、无数据库凭证 | accepted | 2026-11-04 | 刘学奎 |
| [0013](0013-repository-layout.md) | 仓库目录：单应用，TypeScript 全在 `src/`，Python 服务在 `services/capability/` | accepted | 2026-11-04 | 刘学奎 |
| [0014](0014-csv-parser-dependency.md) | CSV 解析用 csv-parse（严格模式）；编码判定仍用 `TextDecoder`；星标线下调为 3,000 | accepted | 2026-11-05 | 刘学奎 |
| [0015](0015-auth-boundary-and-disabled-phone.md) | 认证边界：better-auth 1.7.18 拥有 user / session，授权表自有；停用用户的登录手机号改写为墓碑值；库外必须补的五处 | accepted | 2026-11-10 | 刘学奎 |
| [0016](0016-container-registry.md) | 容器镜像仓库：hbecho 自建 ACR 经济版，不复用 hbdam 的实例；ghcr 不作为分发目标 | accepted | 2026-11-10 | 刘学奎 |
| [0017](0017-learning-vod-sdk-and-player.md) | 学习域云 SDK 与播放器：VOD 官方 SDK 3.12.1、浏览器端用已有 ali-oss、Aliplayer 走 CDN；资料预览由本服务转发（OSS 默认域名强制下载） | accepted | 2026-11-11 | 刘学奎 |

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
| 7 | ~~Branch 范围是否需与显式品牌 grant 求交~~ —— 已由 ADR-0010 关闭：求交，品牌必须显式授予 | — | ADR-0010 |
| 8 | ~~登录手机号：明文 or `ciphertext + lookup HMAC`~~ —— 已由 D-42 关闭：明文保存 | — | prd-platform §5.1 |
| 9 | ~~AI Master 正式 QPS / 并发 / 计费 / SLA / 轮询失败合同~~ —— 已关闭：认证、同步/异步、计费口径已实测；单价 0.01 元/点（1 元 = 100 点；2026-11-04 提供时写作 0.01 元/点、1 元 = 100 点，2026-11-19 刘学奎订正）；SLA 由业务接受为风险 | — | prd-platform §11.1 |
| 10 | ~~视频/音频归档范围~~ —— 已由 D-29 关闭：按规则圈定范围归档 | — | prd-platform §5.1 |

> 2026-10-28 同步：关闭 4、5、6、8、9、10 六项，均只标来源、不新增判断。
> 2026-11-02 同步：#7 由 [ADR-0010](0010-scope-brand-intersection.md) 关闭。**未决选型登记已清零。**

## 与其他文档的关系

- 领域语义：`CONTEXT.md`，ADR 不得改写。
- 物理实施基线：`HBECHO设计方案/domains/data-foundation/database-design-v2.md`。
- 不可协商条款：`HBECHO设计方案/governance/constitution.md`。
- 运维步骤：`HBECHO设计方案/runbooks/server-operations-runbook.md` 与 `HBECHO设计方案/runbooks/dev-test-deploy-workflow.md`。