# hbecho 服务器与部署运维手册

> **状态**：`current`
> **文档类型**：Runbook（可执行运维步骤）
> **适用范围**：hbecho 项目的云资源资产、系统配置、MySQL、OSS、密钥、Git 与部署流程
> **不承载**：领域语义（见 [`CONTEXT.md`](../../CONTEXT.md)）、表结构（见 [`database-design-v2.md`](../domains/data-foundation/database-design-v2.md)）、产品阶段（见 [`prd-platform.md`](../prd-platform.md)）
> **首次编写**：2026-09-03
> **历史输入**：[`hbdam项目服务器运维手册.md`](../archive/legacy/项目历史文档/hbdam项目服务器运维手册.md)、[`旧项目沉淀文档/`](../archive/legacy/项目历史文档/旧项目沉淀文档/)（两者均为历史输入，取舍见 §2）

---

## 待办清单

> **这里是唯一的待办入口。** 每完成一项把 `[ ]` 改成 `[x]` 并注明日期，同时在 §17 追加一行。
> **「我」**= 需要你在控制台或本机操作；**「Kiro」**= 拿到凭证后我可以执行；**「共同」**= 我准备命令，你确认后执行。
> 涉及花钱或难以逆转的操作，一律先提案后执行，不会替你决定。

### P0 · 安全（优先，当前有真实暴露面）

| # | 谁 | 事项 | 详见 |
|---|---|---|---|
| 1 | ✅ 我 | 建 RAM 用户 `hbecho-ops` + 策略 + 授权（2026-09-03 完成） | §3.5 |
| 2 | ✅ Kiro | 写 `~/.workbench/config.json`，`workbench exec` 实测连通（2026-09-03） | §3.5 |
| 3 | ✅ Kiro | SSH 密钥已生成并装入 `authorized_keys`，密钥登录实测通过（2026-09-03） | §3.1 |
| 4 | 我 | 控制台重置 root 密码为**真随机**串。当前密码已存入系统钥匙串但仍是可猜模式（§3.2.1） | §3.2.1 |
| 5 | ✅ 我 | 工作区 `服务器密码` 文件已删除，钥匙串副本保留（2026-09-03） | §3.2.1 |
| 6 | ✅ Kiro | SSH 密码认证已关闭并三向验证（密钥通 / 密码被拒 / Workbench 不受影响，2026-09-03） | §4 |
| 7 | ✅ 共同 | 安全组 22 已收紧到 `223.78.0.0/16`，`0.0.0.0/0` 已删除，四向验证通过（2026-09-03） | §4.1 |
| 7b | ✅ Kiro | 移除默认安全组里的 `3389/0.0.0.0/0`（Linux 无 RDP，实测无监听，2026-09-03） | §4.1 |

> 第 7 项可以**现在就单独做**，作为最低成本止损：只缩小可达范围，不改登录方式，立即生效、不用重启、不需要先有兜底通道。

### P1 · 打通自动化通道（做完这步，后面大部分事我能代做）

| # | 谁 | 事项 | 详见 |
|---|---|---|---|
| 8 | ✅ Kiro | 装阿里云统一 CLI（`aliyun 3.4.11`，2026-09-03 完成，`ossutil` 内置） | §3.6 |
| 9 | ✅ 我 | 建 RAM 用户 `hbecho-setup` + `hbecho-setup-buildout` 策略 + 授权（2026-09-03） | §3.6 |
| 10 | ✅ Kiro | 配置 `aliyun` 凭证，ECS 与 OSS 调用均实测通过（2026-09-03） | §3.6 |
| 11 | 我 | 开启会话管理（浏览器兜底通道，与 Workbench CLI 互补） | §4.2 |

### P2 · 基础设施配置

| # | 谁 | 事项 | 详见 |
|---|---|---|---|
| 12 | ✅ — | 数据盘无需采购：`/dev/nvme1n1` 100 GiB 已存在，只是未初始化（2026-09-03 实测更正） | §1.2 |
| 13 | ✅ Kiro | 数据盘已初始化：GPT + ext4 + fstab(UUID/nofail/noatime)，`/data` 98G 可用，顺序写 218 MB/s（2026-09-03） | §5.1 |
| 14 | ✅ Kiro | limits 两处 + sysctl 已配并验证生效；修正了两处照抄会出错的值（§5.2、§5.3） | §5.2–5.4 |
| 15 | ✅ Kiro | Docker 28.3.3 + Compose 2.26.1，data-root=/data/docker、日志轮转、live-restore、镜像加速全部实测生效（2026-09-03） | §5.5 |
| 16 | ✅ 我 | 确认三桶分离方案（2026-09-03） | §7.2 |
| 17 | ✅ Kiro | OSS 现状实测：账号下 0 个 Bucket（2026-09-03） | §1.6 |
| 18 | ✅ Kiro | 4 个桶已建（`hbecho-ods/media/temp/backup`，cn-beijing，私有）+ 生命周期规则，验收全通过（2026-09-03） | §7.3、§7.5 |
| 19 | ✅ Kiro | `hbecho-oss-rw` + `hbecho-ecs-role` 已建并绑定；临时凭证与四桶权限边界实测通过，机器上零 AccessKey（2026-09-03） | §7.7 |
| 20 | ✅ 我 | 云监控 Agent 4.0.0.2 已装、`running`，磁盘/内存/CPU 指标上线。根因是缺服务关联角色，见 §12.6 | §12.6 |
| 21 | ✅ Kiro | 快照策略 `hbecho-daily`（北京 03:00，保留 7 天）已建并应用到**两块盘**（2026-09-03） | §11.1 |
| 22 | ✅ Kiro | 四条告警规则已配（磁盘 80% / 内存 85% / 公网流出 24Mbps / CPU 90%），全部绑定 `hbecho-ops` 组 | §12.1 |
| 23 | 🟡 搁置 | 联系人 `liuxuekui` 与组 `hbecho-ops` 已建。短信 `OK` 可用；邮箱 `PENDING`，人工确认为阿里云侧问题，等工单处理，不阻塞其他工作 | §12.5 |

### P3 · 数据库与代码仓库

| # | 谁 | 事项 | 详见 |
|---|---|---|---|
| 24 | ✅ Kiro | 部署 MySQL 8.0.46（Docker），按 §6.2 配参数，密码全程未落地明文/未进命令行 | §6 |
| 25 | ✅ Kiro | CHECK 约束（`ERROR 3819`）与严格模式（`ERROR 1264`）破坏性验收精确匹配预期报错 | §13 |
| 26 | ✅ 共同 | GitHub `origin` 已建并推送（Private，匿名 404 确认）。Codeup 组织创建受阻，暂降级为可选镜像，见 §9.7 | §9.7 |
| 27 | ✅ Kiro | `git init` + 首次提交 `66caf30`（86 文件 / 0.2 MB），提交前密钥扫描通过 | §9.1 |
| 28 | ✅ Kiro | `.githooks/pre-commit` 已装并启用，四种拦截实测有效 | §9.5 |
| 29 | ✅ 共同 | 服务器只读部署密钥已配、clone 到 `/data/app/hbecho`，写权限实测被 GitHub 拒绝确认只读生效 | §9.7 |

### P4 · 对外开放前（当前不阻塞开发）

| # | 谁 | 事项 | 详见 |
|---|---|---|---|
| 30 | ✅ 我 | 确认域名：`echo.hbmarketer.com`（`hbmarketer.com` 与 hbdam 同域） | §4.3、§1.5 |
| 31 | ✅ 我 | ICP 备案**已通过**（2026-11-09 liuxuekui 告知，备案号 `鲁ICP备18020147号-6`） | §4.3、§1.5 |
| 32 | 我 | 开自动续费，或设 2027-08 到期提醒（当前是手动续费） | §1.1 |
| 33 | — | 满足最小访问控制闭环后才开放 80/443 | §10.6 |
| 34 | ✅ 我 | VOD 已开通（2026-10-29，华北2 北京）：`hbecho-vod-manage` 策略已加，点播系统存储已启用，`hbecho-course` 模板组已建（`3ca24a90956dbbfa16f1f6cf2fe6ad3a`）。**剩余**：播放域名（等备案）、自动截图模板（`InternalError`，暂缓） | §1.7、§3.6 |
| 35 | ✅ 我 | `hbecho-course` 桶已建（2026-10-30，cn-beijing、私有、无过期规则 + 碎片 7 天）；「阻止公共访问」已开启；`hbecho-oss-rw` 已更新为 v2，新增 `CourseDocReadWriteDelete`；上传/列举/删除实测通过 | §1.6、§7 |
| 36 | ✅ Kiro | `hbecho-signals` 桶已建（2026-11-12，cn-beijing、私有、Standard、LRS、无过期规则 + 碎片 7 天、「阻止公共访问」已开启）；`hbecho-oss-rw` 更新为 v3，新增 `SignalsStdImageReadWriteDelete`（仅该桶，v2 保留可回退）；测试 ECS 用实例角色实测放行：写 / 列 / 读 / 删通过，`hbecho-media` 删除仍被拒 | §1.6、§7 |

### P5 · 容器镜像服务（ACR）

| # | 谁 | 事项 | 详见 |
|---|---|---|---|
| 36 | ✅ 共同 | ACR 经济版开通并完成端到端验证（2026-11-10）：实例、VPC 绑定、命名空间 `hbecho`、RAM 子账号 push/pull、固定密码、探测镜像推拉 | §1.7、§3.7 |
| 37 | 我 | 关闭 `hbecho-acr-push` / `hbecho-acr-pull` 的**控制台访问**（固定密码已设，子账号不再需要登录控制台） | §3.7 |
| 38 | 我 | 接 CI 前删除 ACR 公网白名单里的 `127.0.0.1/32`，否则 GitHub Actions 无法推送 | §1.7 |
| 39 | ✅ 我 | 费用中心确认 ACR 自动续费已生效（2026-11-10，刘学奎） | §1.7 |

### P6 · 应用上线到测试 ECS（2026-11-11）

| # | 谁 | 事项 | 详见 |
|---|---|---|---|
| 40 | ✅ 我 | ACR 公网白名单已删除 `127.0.0.1/32`（P5 #38），CI 可推送 | §1.7 |
| 41 | ✅ Kiro | `hbecho-mysql` 由 8.0.46 换为 **8.4.13**（ADR-0002 基线；数据目录为空库，换前做了逻辑备份 `/data/backup/pre-mysql84-*.sql.gz`）；compose 增加 `--log-bin-trust-function-creators=1`（二进制日志开启时，非 SUPER 的迁移账号创建触发器需要它；本项目触发器是确定性的） | §10.3 |
| 42 | ✅ Kiro | 应用容器 `hbecho-web`（compose 服务 `web`，镜像 `…/hbecho/app:<git 短 sha>`，只发布 `127.0.0.1:3000`，与 MySQL 同一 compose 网络，库地址用服务名 `mysql`） | §10.3 |
| 43 | ✅ Kiro | 两个库账号：迁移账号 = `mysql.env` 里的 `MYSQL_USER`（`hbecho` 库全部权限，只在迁移时用，`/data/app/migrate.env`）；运行账号 `hbecho_web`（只有 `SELECT/INSERT/UPDATE/DELETE`，`/data/app/web.env`） | §10.2 |
| 44 | ✅ Kiro | `echo.hbmarketer.com` 的 nginx 由静态占位页改为反代到 `127.0.0.1:3000`（`X-Forwarded-For` 用 `$remote_addr` 覆盖，`client_max_body_size 12m`，HSTS 一天）；旧配置备份 `/data/backup/echo.hbmarketer.com.conf.bak-20261111`，回滚 = 还原该文件并 `systemctl reload nginx` | §10.7 |
| 45 | ✅ 刘学奎 | 首个超管已用真实短信验证码激活并登录（2026-11-11）；当前镜像标签 `93bff48bf251` | tasks 实施记录 |
| 46 | ✅ Kiro | 2026-11-12 经刘学奎同意上线：镜像标签 `69595423c6d3`（main 合并提交，CI run 43160976258 verify + image 全绿；含活动计划页面 P1–P5 与主数据导入页面）。`pull` → 迁移（无新迁移，`migrations applied`）→ `WEB_TAG` 切换并 `docker compose up -d web learning-worker`；`/api/health` 正常，`/plans`、`/accounts`、`/master-data/import`、`/batches` 未登录 307 到 `/login`，公网 `/login` 200 且页脚有备案号，除 22/80/443 外无公网监听。回滚 = `WEB_TAG` 改回 `718a8a4bfef3`。页面进程默认 `HBECHO_ENV=production`，名单确认的 `media_user_info` capability 未放行，所以真实环境里「确认写入」会被拒绝并说明原因，直到 capability 获批 | §10.3 |
| 47 | ✅ Claude（刘学奎 2026-11-16 同意） | 部署主数据浏览 `…/hbecho/app:8c6b2ff9e9a6`（main 合并提交 `8c6b2ff`；CI run 43803345217 的 image job 已推 ACR）：内网拉取 → 迁移无新增（`__drizzle_migrations` 仍 12）→ 只重启 `web`。健康 `{"ok":true}`、公网 `/login` 200、`/users` 307，`.next/server/app/(app)/master-data` 在新镜像中。`learning-worker` / `sync-worker` 仍为 `6368b94798ef`。**发现**：`/data/app/docker-compose.yml` 的镜像标签写死、不读 `.env` 的 `WEB_TAG`，与 §10.3 不一致；本次备份 `/data/backup/docker-compose.yml.bak-20261116` 后只改 web 行，待后续统一改成 `${WEB_TAG}` | §10.3 / §10.4 |
| 48 | ✅ Claude（刘学奎 2026-11-16 同意） | 部署判定计划 `…/hbecho/app:9bb35b580bc5`（main 合并提交 `9bb35b5`；CI run 43839201580 的 image job 已推 ACR）：内网拉取 → 逻辑备份 `/data/backup/pre-d-judgement-20261116.sql.gz`（62 张表，`gzip -t` 通过）→ 迁移账号应用 `0012_d_judgement_schema`（`__drizzle_migrations` 12 → 13，新增 5 张判定表；运行账号对 `hbecho.*` 已有 SELECT/INSERT/UPDATE/DELETE，无需另授权）→ 新增 `/data/app/judgement.env`（root 600：`HBECHO_JP_*` 14 项 + `HBECHO_SIGNALS_*` 12 项的起始值，`HBECHO_JP_ACTOR=user:1`；同步 / 评论模式与 `HBECHO_MEDIA_MAX_BYTES` 从 `sync.env` 复制，值不回显）→ compose 备份 `/data/backup/docker-compose.yml.bak-20261116b`，`web` 升到新标签并加载 `judgement.env`，新增 `judgement-worker`（`judgement-main.ts serve`）→ 只重起这两个容器。健康 `{"ok":true}`、`/login` 200、`/judgement` 307（未登录跳登录）；`learning-worker` / `sync-worker` 仍为 `6368b94798ef`。**C 的文本信号**：`signals scan --once` 一次性容器算完 798 条（`signals run` 常驻需要 `hbecho-signals` 桶与能力服务，都还没有，所以没有起常驻 worker；新同步的内容要再扫一次，命令见 `man-walkthrough.md` §5）。**真实栈冒烟**（计划「部署冒烟（验证后归档）」，已归档）：建计划 → 配置 → 圈定（70 人 / 247 条 / C1 90，1.2 秒）→ 确认执行 → worker 约 15 秒完成（成功 21 / 不达标 14 / 未获取成功 35，全部 `sync_failed`）；没有任何付费调用 | `.kiro/specs/d-rule-engine/man-walkthrough.md` |
| 49 | ✅ Claude（刘学奎 2026-11-16 同意） | 新增 `signals-scan` 容器（过渡方案，只改 `/data/app/docker-compose.yml`，镜像仍是 `9bb35b580bc5`，没有代码与镜像变更）：循环执行 `signals-main.ts scan --once`，间隔 30 秒；游标增量，单次约 1.3 秒，空闲时 CPU 0%；只在有新内容或失败时写日志。ECS 为 8 核 / 31 GB。compose 备份 `/data/backup/docker-compose.yml.bak-20261116c`。**删除条件**：`signals run` 能起来（有 `hbecho-signals` 桶与能力服务），或 D 的运行入口自己触发扫描 | `man-walkthrough.md` §0、§5 |
| 50 | ✅ Claude（刘学奎 2026-11-17 同意） | 部署两级标签、主数据大区筛选与 5 个 a-activity-plan 提交（自动加入分公司、production 放行）：镜像 `…/hbecho/app:3db239fc52c8`（main 合并提交 `3db239f`；分支 CI run 44058631061 与 main CI run 44060657858 的 verify + image 全绿）。内网拉取 → 逻辑备份 `/data/backup/pre-g-tags-20261117.sql.gz`（`gzip -t` 通过，含 `tags` 表数据）→ 迁移账号应用 `0013_learning_tag_categories`（`__drizzle_migrations` 13 → 14；部署前只读核对：13 个旧标签、0 门课程引用、拆分后无重名；结果：4 个一级标签 平台 / 板块 / 阶段 / 课程类型，13 个二级标签，`tag_id` 2–14 不变，无「未分类」）→ compose 备份 `/data/backup/docker-compose.yml.bak-20261117`，web、learning-worker、sync-worker、judgement-worker、signals-scan 五个服务统一到新标签（sync-worker 因此带上 capability 放行 504ba76）。健康 `{"ok":true,"build":"3db239fc52c8"}`（版本戳与镜像一致）、公网 `/login` 200、`/learning`、`/learning/tags`、`/master-data`、`/judgement`、`/plans` 未登录 307，除 22 / 80 / 443 外无公网监听，五个容器启动后日志无错误。回滚 = 五个服务的标签改回 `9bb35b580bc5`（learning / sync-worker 为 `6368b94798ef`）；迁移只扩展，旧代码可继续读写（只有「新建标签」会因缺 `category_id` 失败）。**待办**：圆角小改（分支 `fix/hf-radius`）下一批发布；一级标签「课程类型」与学习中心固定的「课程类型」下拉重名，可在标签管理里改名或删除（无课程引用） | §10.3 / §10.4 |

### 待触发（有前置条件，暂不做）

| 谁 | 事项 | 触发条件 |
|---|---|---|
| 我 | **删除 `hbecho-setup` 的 AccessKey** | P2、P3 全部完成后。它的有效权限等级是账号管理员（§3.6） |
| 我 | AI Master key 轮换 | 正式接入生产前 |
| 我 | 向供应商确认 QPS / 并发 / SLA / 计费合同 | 规则引擎阶段前（总纲 P0） |
| Kiro | 备份恢复演练并记录耗时 | MySQL 部署且有数据后 |
| Kiro | 逻辑备份脚本 + binlog 保留期 | 同上 |
| 我 | 视频归档范围评估（OSS 成本主要杠杆） | 规则引擎阶段 |

---

## 0. 文档维护约定

**凡涉及服务器、云资源、密钥或部署流程的任何变更，都必须更新本文档。**

| 变更类型 | 要更新的章节 |
|---|---|
| 完成一项待办 | §待办清单（打勾 + 日期）**和** §17 变更记录 |
| 新增/删除云资源（ECS、OSS、RDS、CDN…） | §1 资产清单 |
| 改动系统配置、内核参数、装卸软件 | §5 系统层配置 |
| 改动 MySQL 参数或部署形态 | §6 MySQL |
| 新增 Bucket、改生命周期或 RAM 策略 | §7 OSS |
| 新增/轮换任何密钥 | §8 密钥与配置管理 |
| 改动分支模型、远端或忽略规则 | §9 Git |
| 改动部署方式、端口、容器编排 | §10 部署 |
| 新增端口或改安全组 | §1.4 端口与安全组 |
| 完成一项待办 | 把对应 `[ ]` 改成 `[x]` 并注明日期 |
| 任何一次运维动作 | §17 变更记录（追加一行） |

约定的原因和 hbdam 一致：配置分散在阿里云控制台和机器内部两处，任何一处的隐式改动都无法从代码仓库看出来。**如果一项配置只存在于某人的记忆里，等于不存在。**

hbecho 还多一条理由：v2 基线的正确性依赖若干**看不见的前置条件**（MySQL 版本是否真的强制 CHECK、OSS endpoint 是否走内网、ODS 生命周期规则是否会抢在应用清理之前删字节）。这些条件出问题时不会报错，只会静默产出错误事实或错误账单，所以必须写下来并定期复验（§13）。

---

## 1. 资产清单

> 2026-09-03 已通过控制台 + `workbench exec` 实测采集完毕。剩余 `<待填写>` 只在尚未创建的资源上（OSS、域名）。

### 1.1 ECS 实例

| 项 | 值 |
|---|---|
| 实例名 | `hbecho` |
| 环境定位 | **测试环境（当前唯一实例）**；生产 ECS 未购买（2026-10-25 用户确认） |
| 实例 ID | `i-2zef8qpi1d2mldntjgrv` |
| 地域 / 可用区 | 华北2（北京）· 可用区 F · `cn-beijing` |
| 规格 | `ecs.g9i.2xlarge`，8 vCPU / 32 GiB |
| 操作系统 | Alibaba Cloud Linux 4 LTS 64 位，内核 `6.6.102-7.alnx4.x86_64` |
| 实测内存 | 30 GiB 可见（32 GiB 规格），空载已用约 665 MiB |
| 云助手 Agent | `active`，v2.2.4.1097 |
| 云监控 Agent | **未安装**（`argusagent` inactive）→ 待办 20 |
| 公网 IP | `182.92.223.200`（普通公网 IP，非弹性公网 IP） |
| 私网 IP | `172.25.70.146` |
| 公网带宽 | 30 Mbps 峰值，**按使用流量计费** |
| 付费方式 | 包年包月，2027-08-31 23:59:59 到期，**手动续费** |
| 创建时间 | 2026-08-31 11:14:00 |
| 健康状态 | 正常 |

两条要注意的：

- **手动续费**：到期不自动扣费，忘续会停机。建议开自动续费，或在日历上设 2027-08 的提醒。
- **公网 IP 不是弹性公网 IP**：释放实例或某些变配操作会丢掉这个 IP。SSH 别名、安全组白名单、DNS 记录都绑在它上面，需要保号时先转成 EIP。

`hbecho` 与 `hbdam` 规格完全一致（同规格、同可用区、同带宽策略），但**是两台独立机器**，配置不共享、凭证不共享。

### 1.2 磁盘

| 盘 | 磁盘 ID | 容量 / 类型 | 设备（OS 视角） | 设备（API 视角） | 文件系统 | 挂载点 |
|---|---|---|---|---|---|---|
| 系统盘 | `d-2zef8qpi1d2mldnqkifm` | 100 GiB ESSD AutoPL | `/dev/nvme0n1p3` | `/dev/xvda` | ext4 | `/` |
| 数据盘 | `d-2zef8qpi1d2mldnqkifn` | 100 GiB | `/dev/nvme1n1p1` | `/dev/xvdb` | ext4 | `/data` |

数据盘 UUID：`60c9acba-de0f-4d81-af2f-3668e6a82b72`
fstab 行：`UUID=60c9acba-de0f-4d81-af2f-3668e6a82b72 /data ext4 defaults,noatime,nofail 0 2`

实测：`/` 已用 3.7 G / 99 G（4%）；`/data` 已用 6.9 M / 98 G（1%），顺序写 **218 MB/s**（1 GiB `oflag=direct`）。

> ⚠️ **同一块盘有两个设备名。** `lsblk` 在系统内看到的是 NVMe 命名（`/dev/nvme1n1`），而 `DescribeDisks` API 返回的 `Device` 是 `/dev/xvdb`。两者指的是同一块盘。写 fstab 用系统内的 UUID，查 API 用磁盘 ID，**不要拿 API 返回的 `/dev/xvdb` 去 `mkfs`**——那个路径在系统里不存在。

✅ **更正一条早期判断：数据盘是买了的。** 实例详情页的「实例信息」面板只列了系统盘，我据此判断"没有数据盘"，是错的。`lsblk` 显示 `nvme1n1 100G disk` 确实存在，只是**从未初始化**——没分区、没文件系统、没挂载。所以不需要额外花钱，只要按 §5.1 走一遍格式化和挂载（待办 13）。

> 教训：实例详情页的磁盘信息不完整，判断磁盘必须用 `lsblk` 或「块存储」页面，不能只看实例概览。
>
> 设备名确认为 NVMe 命名：g9i 是 NVMe 规格族，是 `/dev/nvme*` 而不是 `/dev/vd*`。照抄网上 `/dev/vdb` 的教程会找不到盘。数据盘格式化后把 UUID 补进上表。

### 1.3 `/data` 目录规划

无论 §1.2 选 A 还是 B，目录结构一致，只是 `/data` 是独立挂载点还是系统盘上的普通目录。hbecho 的目录比 hbdam 少：没有 PostgreSQL，没有打包临时区，也不做本地媒资缓存（原因见 §2）。

```
/data
├── mysql/    MySQL 数据目录（700）
├── docker/   容器运行时 data-root（镜像、容器层、卷）
├── app/      应用代码与编排文件（部署工作目录）
├── logs/     应用日志
├── backup/   MySQL 逻辑备份与 binlog 归档（700）
└── tmp/      媒资下载中转区（可随时清空，必须有容量上限）
```

`/data/tmp` 的定位要说清楚：ODS 原始字节**不落本地磁盘**，按 v2 §12.4 直接流式上传私有 ODS OSS；`/data/tmp` 只服务媒资下载这类必须先拿到完整字节才能算 SHA-256 的场景，且用完即删。任何把 ODS body 写到本地再上传的实现都是对 raw-before-parse 语义的削弱，不要为它规划持久目录。

### 1.4 端口与安全组

2026-09-03 从外部实测的结果：

| 端口 | 用途 | 实测状态 | 目标状态 |
|---|---|---|---|
| 22 | SSH | ✅ 仅 `223.78.0.0/16`（2026-09-03 收紧） | 保持 |
| 80 | Web | **2026-11-09 开放**（`0.0.0.0/0`），只放占位静态页 | 业务上线前保持只服务静态页，见 §10.7 |
| 443 | Web | **2026-11-09 开放**（`0.0.0.0/0`），Let's Encrypt 证书 | 同上 |
| 3306 | MySQL | 未部署 | **永不开放**，走隧道 |
| 其他业务端口 | 应用 / 队列 / 管理面 | 未部署 | **永不开放**，一律绑 `127.0.0.1` + 反代 |

机器内部监听清单（2026-09-03 实测，`ss -tlnp`）：

```
LISTEN 0.0.0.0:22   sshd (pid 5438)
LISTEN [::]:22      sshd
```

**除 sshd 外没有任何监听**，符合预期（Docker、MySQL 都还没装）。

sshd 当前配置实测：

```
PermitRootLogin yes
PasswordAuthentication yes
```

并且 `/root/.ssh/authorized_keys` **是空的（0 行）**。合起来意味着：

| 事实 | 后果 |
|---|---|
| 22 端口对公网开放 | 会被持续扫描 |
| 密码认证开启 | 可被撞库 |
| root 密码是字典高频模式 | 撞库大概率成功（§3.2.1） |
| **没有任何公钥** | **SSH 目前只有密码这一条路** |

最后一条决定了操作顺序：**不能先关密码认证**，否则 SSH 会彻底进不去。必须先装公钥并验证，再关密码认证。Workbench CLI 已经打通（§3.5），即使 SSH 全断也有路进去，所以这个顺序是安全的。

80/443 不可达是好事，说明不会被未备案巡检命中。

### 1.5 域名与备案

| 项 | 值 |
|---|---|
| 正式域名 | **`echo.hbmarketer.com`**（2026-11-09 起；与 hbdam 的 `dam.hbmarketer.com` 同属 `hbmarketer.com`） |
| 备案状态 | **已备案**（2026-11-09 liuxuekui 告知 ICP 备案通过；备案号 `鲁ICP备18020147号-6`，已挂在占位页页脚） |
| DNS | `echo` A → `182.92.223.200`（生产 ECS，2026-11-09） |
| 证书 | Let's Encrypt（`CN=echo.hbmarketer.com`，到 2027-02-07），venv `/opt/certbot`，crontab 每日 03:17 续期 |
| 当前站点 | nginx 1.30.4 静态占位页 `/var/www/echo/index.html`（见 §10.7）；**没有应用进程** |
| 备案阻塞的事 | 已解除 |
| 备案**不**阻塞的事 | OSS 使用（走默认域名）、全部后端开发、数据底座 tracer 的离线验收 |

hbecho 与 hbdam 的差别：hbecho 首版是内部渐进开放的平台，媒资通过签名 URL 交付即可，**首版没有 CDN 需求**。备案因此只阻塞"域名对外访问"这一件事，不阻塞任何数据链路。

### 1.6 OSS

Bucket 拓扑是一个难以逆转的决定（改桶等于搬对象 + 改 `oss_objects.bucket/object_key`），**写入第一个对象之前必须先定**。规划、取舍和生命周期规则见 §7；这里只登记结果。

**2026-09-03 已按三桶分离方案创建完成**，四个桶均在 `cn-beijing`、私有 ACL、Standard、LRS、「阻止公共访问」为 `true`。**2026-10-30 新增第五个桶 `hbecho-course`**（课程资料，私有 ACL，实例角色可删），详见 ADR-0001 修订。**2026-11-12 新增第六个桶 `hbecho-signals`**（识别能力的标准图 / 元素图，私有 ACL、无过期规则、实例角色可删），**同日已创建**，见下表与 ADR-0001 修订。

桶名以 `hbecho-` 开头是硬约束——`hbecho-setup-buildout` 策略把 OSS 权限限定在 `acs:oss:*:1241086349153033:hbecho-*`（§3.6）。要用别的命名必须同步改策略。

| 用途 | Bucket | 创建时间 | 生命周期规则 |
|---|---|---|---|
| ODS 原始字节（`object_category='ods'`） | `hbecho-ods` | 2026-09-03 15:45:50 | 过期 **400 天**（兜底）+ 碎片 7 天 |
| 正式媒资（`object_category='media'`） | `hbecho-media` | 2026-09-03 15:45:51 | **无过期规则** + 碎片 7 天 |
| 临时对象（`object_category='temp'`） | `hbecho-temp` | 2026-09-03 15:45:52 | 过期 3 天 + 碎片 1 天 |
| 数据库备份 | `hbecho-backup` | 2026-09-03 15:45:53 | `mysql/` 前缀 30 天 + 碎片 7 天 |
| 课程资料（PDF / JPG / PNG） | `hbecho-course` | 2026-10-30 09:34:23 | **无过期规则** + 碎片 7 天；实例角色可删（ADR-0001 修订） |
| 识别能力的标准图 / 元素图（`c-signals`） | `hbecho-signals` | 2026-11-12 17:25:17（北京时间） | **无过期规则** + 碎片 7 天；实例角色可删（ADR-0001 修订）；「阻止公共访问」为 `true` |

Endpoint：

| 用途 | 地址 |
|---|---|
| 服务器代码**只准用** | `oss-cn-beijing-internal.aliyuncs.com` |
| 本机调试 / 浏览器直传 | `oss-cn-beijing.aliyuncs.com` |

验收实测结果（§13.3–13.5）：

| 验证项 | 结果 |
|---|---|
| 四桶匿名访问 | 全部 `403` ✅ 私有 |
| `BlockPublicAccess` | `true` ✅ |
| 服务器侧内网 endpoint | 全部 `403`，44–48 ms ✅ |
| `hbecho-media` 是否有过期规则 | **无** ✅（这是需要验证的否定条件） |

> ⚠️ 配生命周期时踩到一个坑：**同一前缀不能有两条规则**，OSS 返回 400。`ods` 和 `temp` 最初把「过期删除」和「碎片清理」写成两条 `<Prefix></Prefix>` 的规则，被拒；合并进同一条 `<Rule>` 后通过。`backup` 桶因为两条规则前缀不同（`` 和 `mysql/`）所以一开始就成功。

| 项 | 值 |
|---|---|
| 内网 endpoint | `oss-<region>-internal.aliyuncs.com`（**代码只准用这个**，见 §7.5） |
| 公网 endpoint | `oss-<region>.aliyuncs.com`（仅本机调试/浏览器直传用） |
| 实例 RAM 角色 | `<待填写>` |

### 1.7 外部服务

| 服务 | 用途 | 认证方式 | 凭证位置 |
|---|---|---|---|
| AI Master（FieldShortcut） | 数据底座内部 Provider Adapter | HTTP 头 `X-Api-Key` | 见 §8.1 |
| Base URL | `https://openapi.fieldshortcut.com` | | |
| 阿里云视频点播 VOD | 域 G 课程视频托管、转码与播放 | RAM 角色（待定，见 ADR-0007） | 未开通 |
| 阿里云容器镜像服务 ACR（经济版） | 应用镜像仓库：CI 推送、测试 ECS 内网拉取 | RAM 子账号 + registry 固定密码 | 见 §3.7 |

**VOD 状态（2026-10-29 实测完毕）**：域 G 已决定用 VOD 承载课程视频（`prd-domain-g-learning.md` 的 G-D09），接入细节见 ADR-0007。已确认：

- 已开通，媒资地域**华北2（北京）**；
- 点播系统存储已启用：`outin-9d24271dd35c11f1844c4a1eea8f07d7.oss-cn-beijing.aliyuncs.com`，私有，正常；
- 转码模板组已建：`hbecho-course` = `3ca24a90956dbbfa16f1f6cf2fe6ad3a`（720p + 480p，HLS 10 秒切片）；
- **endpoint 按操作分地域**：模板组与媒资用 `cn-beijing`，域名管理用 `cn-shanghai`；用错会分别报 `InvalidStorage.NotFound` 与 `InvalidOperation.NotSupportedEndpoint`；
- 播放域名仍为空（等备案）；自动截图模板 `AddVodTemplate` 返回 `InternalError`，已暂缓。

计费口径：存储按容量、转码按输出时长、加速按流量、智能审核按审核时长（1.0 不开）。

**备案与联调（2026-10-29 实测）**：自有域名备案进行中，预计约一周。实测结论：`DescribeVodUserDomains` 返回 `TotalCount: 0`，域名相关 API 只有 `AddVodDomain`（要求填自有域名与回源地址），**VOD 没有系统分配的默认播放域名**。因此备案未通过前无法通过域名播放，只能测上传、转码与取播放凭证。播放联调用 OSS 签名 URL 做脚手架（只验证播放器集成、进度与续播），备案后切 VOD 并**重新跑一遍播放相关验收**，不能因为 OSS 下测过就认为 VOD 也过。

AI Master 的正式 QPS、并发、SLA、计费与轮询失败合同仍是 P0 未决项（总纲 §12.1）。运维侧的含义：**不能按"配额充足"假设配置并发**，必须有硬上限和人工止损开关（§12.4）。

**ACR 状态（2026-11-10 开通并端到端验证）**：

- 实例 `hbecho-registry`，ID `cri-e07ol87axh61gu6d`，**华北2（北京）**，经济版，包月，到期 **2026-12-11**（自动续费已于 2026-11-10 确认生效）；
- 容量：仓库 200、命名空间 5、并发拉取 30 QPS；**公开匿名拉取关闭**；
- 域名规则是 `<实例名>-registry[-vpc].<地域>.cr.aliyuncs.com`。实例名本身以 `registry` 结尾，所以域名里出现两个 `registry`——以控制台为准，不要按"实例名 + -vpc"推断：
  - 公网 `hbecho-registry-registry.cn-beijing.cr.aliyuncs.com`（访问入口已开启；**白名单当前只有 `127.0.0.1/32`**，接 CI 前必须删掉，否则 GitHub runner 连不上）
  - 内网 `hbecho-registry-registry-vpc.cn-beijing.cr.aliyuncs.com` → `172.25.70.147`（2026-11-10 在测试 ECS 实测，`/v2/` 返回 401、connect 7 ms）
- VPC 访问控制：绑定 `vpc-2zevfnkvxxw6ae8gpj2f3` / `vsw-2ze1ymn3rrx0i2bivbufv`，额度 **1/1**——经济版只有 1 个配额，换绑必须先删；
- 命名空间 `hbecho`（私有）；验证用的探测仓库 `hbecho/probe:probe-1`（523 B，控制台可删）；
- **偏离记录**：`dev-test-deploy-workflow.md` 原要求"开通前单独决定并记 ADR"，实际先开通（2026-11-10）、当日补记 [ADR-0016](../architecture/adr/0016-container-registry.md)。顺序颠倒，决定内容无变化。

**为什么不用 hbdam 的 ACR**：实例属于另一个阿里云账号（`1967785122003299`），内网域名绑在 hbdam 自己的 VPC（`vpc-2zeyhxf9ftlyeq1gr3vgx`，解析到 `172.24.60.202`）。两个账号的 VPC 默认隔离，hbecho 的 ECS（`vpc-2zevfnkvxxw6ae8gpj2f3`）访问不到；跨账号复用只能靠 RAM 授权 + 跨账号 VPC 对等/CEN，或改走公网拉取，耦合与代价都高于自建一个经济版实例（约 ¥117/月，下单页报价，未经账单核对）。

### 1.8 如何重新采集本章的值

不需要 SSH，走 Workbench CLI 即可（§3.5）：

```bash
workbench exec -i i-2zef8qpi1d2mldntjgrv --timeout 60 -c '
echo "===OS==="; head -2 /etc/os-release; uname -r
echo "===CPU/MEM==="; nproc; free -h | head -2
echo "===DISK==="; lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT; df -hT | grep -vE "tmpfs|devtmpfs"; blkid
echo "===PORTS==="; ss -tlnp
echo "===TIME==="; timedatectl | head -4; chronyc tracking | grep -E "Reference ID|System time"
echo "===AGENT==="; systemctl is-active aliyun.service; systemctl is-active argusagent
echo "===SSHD==="; grep -rhE "^(PasswordAuthentication|PermitRootLogin)" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
echo "===AUTHKEYS==="; wc -l < /root/.ssh/authorized_keys 2>/dev/null || echo 0
'
```

控制台侧的值用 `aliyun` CLI 取：

```bash
aliyun ecs DescribeInstances --RegionId cn-beijing \
  --InstanceIds '["i-2zef8qpi1d2mldntjgrv"]' --profile hbecho-setup
aliyun ecs DescribeDisks --RegionId cn-beijing \
  --InstanceId i-2zef8qpi1d2mldntjgrv --profile hbecho-setup
aliyun ecs DescribeSecurityGroups --RegionId cn-beijing --profile hbecho-setup
aliyun ossutil ls --profile hbecho-setup
```

⚠️ 判断磁盘不要只看实例详情页的「实例信息」面板——它可能漏掉未初始化的数据盘（本项目就踩了这个，见 §1.2）。用 `lsblk` 或 `DescribeDisks`。

---

## 2. 与旧项目沉淀的取舍

旧沉淀文档跨了三个项目（lxk-BigSpard 香港小机器、hbdam 北京大机器、以及给 media-platform 写的 steering 稿），时间线不同、假设不同，其中一部分与 hbecho 当前基线直接冲突。这一节把取舍写死，避免后续有人从旧手册里照抄出错误配置。

### 2.1 继承：仍然成立的做法

| 做法 | 为什么对 hbecho 仍然成立 |
|---|---|
| **兜底通道先行**：先开会话管理，再改 SSH、再收紧安全组 | 关密码认证和收窄安全组都是"可能把自己锁在门外"的操作，顺序错了只能靠 VNC 救 |
| fstab 用 UUID + `nofail` + `noatime` | 设备名可能重启漂移；`nofail` 保住 SSH 救援通道 |
| limits 要写两处（`limits.d` + `systemd/system.conf.d`） | 前者只作用于登录会话，systemd 拉起的服务读后者；只改前者会发现数据库 fd 上限没变 |
| 容器 `data-root` 指向数据盘 + 日志轮转 | 镜像和容器日志都会持续长大，不轮转能把磁盘写满 |
| 镜像加速源 | Docker Hub 在国内 ECS 上不可达 |
| OSS endpoint 漏写 `-internal` 的账单陷阱 | 同地域下公网 endpoint 物理上也走内部骨干，**无报错、无变慢、只在账单上体现**（hbecho 的强化做法见 §7.5） |
| 生命周期规则必须清理未完成分片 | 碎片在控制台文件列表里看不到但照常计费 |
| 安全组规则是**并集**语义 | 只要 `0.0.0.0/0` 那条还在，新加的窄规则毫无作用 |
| 业务端口只绑 `127.0.0.1`，统一反代 | 减少暴露面，且备案期间也能开发 |
| 密钥绝不入 git；已泄露的密钥只能靠**轮换**失效 | 删文件、改历史都撤不回别人已 clone 的副本 |
| 快照 ≠ 逻辑备份 | 快照恢复粒度是整盘，误删一张表时不会想回滚整盘 |
| 磁盘水位是最需要盯的单一指标 | 数据盘满 = 数据库和容器一起挂 |

### 2.2 不继承：对 hbecho 不成立或已过时

| 旧内容 | 不继承的原因 |
|---|---|
| PostgreSQL / `/data/pg` 目录 | hbecho 基线只有 MySQL 8.0.16+ 与私有 OSS。旧稿的 PG 是为 Dify 向量库准备的，hbecho 首版没有向量检索需求 |
| 宝塔面板管理 Nginx 与证书 | 面板会引入公网 8888 入口和一整套额外攻击面。hbecho 只有单站点，用原生 Nginx 或容器反代即可，不装面板 |
| `.env` 里放 `OSS_ACCESS_KEY_ID/SECRET` | hbecho 用实例 RAM 角色取临时凭证，机器上不存长期 OSS 密钥（§7.6） |
| Cookie 文件同步、Puppeteer/Chromium、反检测、账号间随机延迟 | 总纲 §3 明确非目标：**不自研社媒爬虫**，数据走供应商适配层。这类运维动作在 hbecho 完全不存在 |
| `tar + scp` 覆盖部署，外加 `head -1` 验证文件没被解包损坏 | 治的是错误方案的症状。hbecho 用 git pull + 固定 commit SHA（§10） |
| `/data/pack-tmp`、`/data/oss-cache` | hbecho 没有 zip 打包分发场景；v2 §11.1 明确数据库不保存长期可访问 URL，也不规划本地媒资缓存层 |
| 单 bucket + `packages/` 前缀 7 天删除 | hbecho 的 ODS（一年）与正式媒资（长期）保留期相反，且媒资**必须**长期存在。按前缀在同一桶里设过期规则，一个手误就删掉长期资产（§7.2） |
| 具体版本号与实测值：Alinux 4.0.5、Docker 28.3.3、Compose 2.26.1、`/dev/nvme1n1`、顺序写 469 MB/s、OSS 内网 2.5ms、公网 1.9ms | 全部是 hbdam 那台机器的实测结果。方法可以继承，**数字必须在 hbecho 本机复验后再写进 §1**，否则手册第一章就是假的 |
| "地域统一为北京" | "ECS 与 OSS 必须同地域"这条约束继承；具体是哪个地域由 hbecho 自己的实例决定，见 §1.1 |
| 三级角色 `hq_admin / branch_manager / dealer_staff`、`getDataScope` 中间件、`dealers.branch` 字符串改外键、旧库 15 表改造清单 | 与 [`CONTEXT.md`](../../CONTEXT.md) 冲突。当前模型是 `MediaStaff` / `ExternalAccount` / `AccountAssignment`，且"旧库存量迁移"不在数据底座范围内（v2 §1.2）。最终 `RoleCode` 本身仍是未决项 |
| BullMQ + Redis、NestJS、Prisma、Dify、RAGFlow 等选型 | 总纲明确应用框架、ORM/迁移工具、队列**未冻结**。运维手册不得用"预装了什么"代替技术决策，所以 §1.3 目录里没有 redis 目录，§5 也不装队列 |
| "8G 内存够用，峰值约 5GB" 的容量结论 | 那是含 Dify + Chromium 的旧项目估算，与 hbecho 的负载结构（大量出方向 HTTP + MySQL）无关 |
| `WEB_AUTH_USER/WEB_AUTH_PASS` 这种单账号 Basic 登录、内存态登录限速 | hbecho 的认证归访问控制域，走独立 Session + Capability + DataScope。不要在运维层搭一个平行的登录 |
| 香港节点、`ai.liuxuekui.click`、`liuxuekui.click` 子域和 `/opt/<项目名>` 多项目共存约定 | 那是旧共享机器的约定。hbecho 用 `/data/app` 单项目布局，端口不与旧机器排期表挂钩 |

### 2.3 需要修正后才继承

| 旧做法 | hbecho 的修正 |
|---|---|
| `.env` 明文放所有密钥，靠 `.gitignore` 兜底 | `.gitignore` **必须在 `git init` 之前就位**；OSS 改 RAM 角色；剩下确实只能用长期密钥的（AI Master）集中一处、600 权限、记录轮换时间（§8） |
| "endpoint 集中管理，code review 必查 `-internal`" | 升级为**启动期自检**：检测到运行在 ECS 上而 endpoint 不含 `-internal` 时直接启动失败（§7.5）。人工 review 会漏，断言不会 |
| `docker compose up -d --build` 直接在服务器上构建 | 保留（首版可接受），但必须记录本次部署的 commit SHA，且构建产物与 `.env` 分离（§10.3） |
| 每日 `mysqldump` 到 `/data/backup` 再同步 OSS | 保留，但要补一条 hbecho 特有的注意事项：MySQL 与 OSS 是两个存储，单独回滚 MySQL 会与 OSS 的实际对象状态错位（§11.4） |
| 监控三条规则（磁盘 / CPU / 公网带宽） | CPU 那条对 hbecho 意义不大（hbecho 不做打包和转码）。换成"长事务"和"时钟偏移"两条，理由见 §12 |

---

## 3. 连接方式与凭证

### 3.1 SSH 别名

写入本机 `~/.ssh/config`。端口转发的作用是：**数据库端口和 Web 端口永远不在安全组开放**，本地客户端一律连 `127.0.0.1`。

```ssh-config
# ── hbecho 测试环境（当前唯一实例）（华北2 北京 F · ecs.g9i.2xlarge）──
# 实例 i-2zef8qpi1d2mldntjgrv / 私网 172.25.70.146
# 用法：ssh hbecho
Host hbecho
    HostName 182.92.223.200
    User root
    IdentityFile ~/.ssh/hbecho_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 6
    # 对外开放前访问 Web：本地 http://127.0.0.1:8081 -> 服务器 80
    LocalForward 8081 127.0.0.1:80
    # MySQL 调试隧道（安全组永不放开 3306）
    LocalForward 13307 127.0.0.1:3306
```

`~/.ssh/hbecho_ed25519` 还不存在，需要先生成并装到服务器（§4 第 2 步）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/hbecho_ed25519 -C "hbecho-$(date +%Y%m%d)"
# 当前服务端还接受密码认证，所以可以用密码把公钥装上去
ssh-copy-id -i ~/.ssh/hbecho_ed25519.pub root@182.92.223.200
# 验证密钥登录成功后，才能做 §4 第 3 步关闭密码认证
ssh -o BatchMode=yes hbecho 'echo 密钥登录正常'
```

> 本地端口故意与 hbdam 的 `8080 / 13306 / 15432` 错开。两台机器的隧道同时开着时，端口撞车会让你连到另一个项目的数据库上，而且不会报错。

### 3.2 凭证

| 凭证 | 位置 | 状态 |
|---|---|---|
| SSH 私钥 | `~/.ssh/hbecho_ed25519` | `<待创建>` ed25519，独立生成，**不与 hbdam 复用**。不进 git、不外传 |
| SSH 公钥 | `~/.ssh/hbecho_ed25519.pub` | `<待装到服务器>` `~/.ssh/authorized_keys` |
| root 密码 | 工作区 `服务器密码` 文件 | 🔴 **需要立即处理**，见 §3.2.1 |
| 阿里云 RAM AccessKey（Workbench CLI 用） | `~/.workbench/config.json` | `<待创建>`，见 §3.5 |

不复用 hbdam 密钥的理由：一把私钥泄露时，影响范围应该只有一台机器。共用密钥会让两个项目的爆炸半径合并。

#### 3.2.1 root 密码处置进度

**风险已大幅下降，但未清零。**

原始状态是三个条件同时成立：22 端口对公网开放、SSH 接受密码认证、root 密码是字典高频模式（`品牌名+年份.`）。三者叠加就是一台可被暴力破解的公网机器。

2026-09-03 的处置：

| 步骤 | 状态 |
|---|---|
| 1. Workbench CLI 兜底通道打通并实测 | ✅ §3.5 |
| 2. SSH 密钥生成、装公钥、验证密钥登录 | ✅ 指纹 `SHA256:jrKm1Y9nbJIcMvfug5UGHigN4TlRcfyF42iluIm9trw` |
| 3. **关闭 SSH 密码认证** | ✅ 三向验证：密钥通 / 密码被拒 / Workbench 不受影响 |
| 4. 密码存入 macOS 登录钥匙串 | ✅ `security find-generic-password -s hbecho-ecs-root -w` |
| 5. 换成真随机串 | ⬜ **仍待做** |
| 6. 删掉工作区 `服务器密码` 明文文件 | ⬜ **仍待做**（钥匙串已有副本，可安全删除） |
| 7. 收紧安全组 22 | ✅ 仅放行 `223.78.0.0/16`（§4.1） |

第 3 步完成后，**弱密码不再是远程攻击面**——SSH 已经不接受密码，唯一还能用它的地方是控制台 VNC，那需要先登进阿里云账号。所以第 5 步的紧迫性从"高"降到"该做但不急"。

关于第 5 步：当前密码 `项目名+姓名缩写+年份..` 仍是可猜结构，只是比原来长了两位。真随机串的生成与存放：

```bash
PW=$(LC_ALL=C tr -dc 'A-Za-z0-9!@#%^*_+=-' < /dev/urandom | head -c 24)
security add-generic-password -a "root@hbecho" -s "hbecho-ecs-root" -w "$PW" -U
security find-generic-password -s hbecho-ecs-root -w    # 取出粘贴到控制台
unset PW
```

控制台「重置实例密码」需重启实例生效——**趁还没部署任何东西，现在做成本为零**。

> 密码不要存回工作区文本文件。工作区文件会被编辑器、云备份和 AI 工具读到，而且 `git init` 时一旦忽略规则没覆盖就进仓库。macOS 登录钥匙串是现成的密码管理器，已经放好了。

### 3.3 兜底通道（SSH 连不上时）

按优先级：

1. **Workbench CLI**：本地命令行免密，不占用 22 端口（§3.4、§3.5）。
2. **会话管理 / Workbench 网页连接**：浏览器里操作，走阿里云内部链路，不依赖安全组 22 端口。
3. **VNC**：系统起不来时（例如 fstab 写错）唯一可用的通道，用 §3.2 的 root 密码。

`nofail` 挂载选项存在的意义就是尽量不让你走到第 3 条。

### 3.4 Workbench CLI（推荐作为主通道）

阿里云在实例「远程连接 → 本地连接」里提供的本地命令行工具，走阿里云内部链路，不需要公网 IP、不需要开放任何入方向端口。

**为什么它比 SSH 更适合当前阶段**：SSH 的三个麻烦——管私钥、维护安全组白名单（家庭宽带 IP 会变）、密码认证要额外加固——它一次绕过。而且它设计上就面向命令行工具和 AI 编程工具调用：命令执行返回结构化 JSON，并**透传退出码**，所以自动化流程能自己判断成功失败再决定下一步。

**安装状态**：2026-09-03 已装 `workbench v1.0.1`（commit `86c0aff`，构建于 2026-08-24），路径 `/opt/homebrew/bin/workbench`。阿里云官方 Skill 已装到 `~/.kiro/skills/alibabacloud-workbench-cli/`。凭证 `<待配置>`，见 §3.5。

安装命令（控制台给的官方命令）：

```bash
curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
# 默认装到 /usr/local/bin（需 sudo）。指定目录可免 sudo：
# curl -fsSL .../install.sh -o /tmp/wb.sh && bash /tmp/wb.sh -d /opt/homebrew/bin
```

脚本会自动识别 CPU 架构、下载二进制、**校验 SHA256**，校验失败时拒绝安装（实测确认有这段逻辑）。想谨慎可以先下载再 `less` 看一眼。

#### 实测确认的命令面（v1.0.1）

```
workbench
├── connect     交互式登录（/detach 可保留会话，/exit 关闭）
├── exec        执行远程命令（非交互，透传退出码）
├── upload      上传文件（上限 1 GB，经 OSS 中转，无需自己配 OSS）
├── download    下载文件（同上）
├── list ecs    列实例（--region 必填，可按 status/tag/vpc/zone/type 过滤）
├── session     会话管理（list / close）
├── daemon      本地守护进程（start / status / stop）
├── config      凭证与 profile 管理
├── upgrade     自更新
└── version
```

⚠️ **更正一条：v1.0.1 没有端口转发子命令。** 官方 Skill 描述和技能市场页面都写了"TCP 端口转发"，但实测 `workbench --help` 的命令表里没有 `forward` / `proxy` / `tunnel`。由此：

- **MySQL 图形客户端仍然需要 SSH 隧道**（§3.1 的 `LocalForward 13307`），这条不能靠 Workbench CLI 替代；
- 只要执行 SQL 的话，用 `workbench exec` 调服务器上的 `mysql` 客户端就够了；
- 后续版本若补上端口转发，回来更新本节并重新评估 SSH 隧道是否还需要。

#### 关键行为特征

| 特征 | 含义 |
|---|---|
| `exec` 每次调用是**独立 shell**，`cd` / `export` 不跨调用保留 | 需要共享上下文的命令必须用 `&&` 或 `;` 串在一次调用里 |
| 透传远程命令退出码 | 自动化流程能自己判断成败，不用解析文本 |
| `--output json` 返回 `{output, stderr, exit_code}` | 结构化，适合工具链消费 |
| `--auth-type` 默认 `none` | 走 Workbench 自己的鉴权通道，不需要服务器密码 |
| 同一实例的多次操作复用一个 session | 透明多路复用；空闲 30 分钟自动关闭 |
| 本地 daemon 首次调用自动拉起，最后一个 session 关闭后 60 秒自动退出 | 通常不用手动管 |
| region 从实例 ID 前缀自动推断 | `list` 例外，`--region` 必填 |
| `upload` 目标文件已存在时会交互式确认，默认不覆盖 | 自动化场景要先用 `exec ls` 检查，否则可能卡在等待输入 |

常用命令（`i-2zef8qpi1d2mldntjgrv` 就是 hbecho）：

```bash
workbench list ecs --region cn-beijing --output json
workbench exec -i i-2zef8qpi1d2mldntjgrv -c "df -hT /data /"
workbench exec -i i-2zef8qpi1d2mldntjgrv -c "cd /data/app/hbecho && git rev-parse --short HEAD"
workbench upload ./local.file /data/app/x --instance-id i-2zef8qpi1d2mldntjgrv
workbench download /var/log/xxx.log ./ --instance-id i-2zef8qpi1d2mldntjgrv
workbench session list
```

#### 需要注意的三件事

1. **本机凭证的权限等于服务器 root。** 这个通道免密执行远程命令，本机那份阿里云凭证一旦泄露，攻击者就能在实例上执行任意命令。所以用专用 RAM 用户 + 最小权限（§3.5），不要用主账号 AK。
2. **它依赖云助手 Agent。** Agent 挂掉或实例网络异常时这条路也不通，所以 SSH 密钥登录要留着当备份，两条通道并存。
3. **它不替代安全加固。** 装了它之后，22 端口该收紧还是要收紧、密码认证该关还是要关（§4）。多一条通道的意义正是让这些加固动作变得安全，而不是让它们变得不必要。

### 3.5 Workbench CLI 凭证配置

凭证存在 `~/.workbench/config.json`，权限必须 `600`——不是 600 时 CLI 会报 `insecure permissions` 并拒绝运行。

阿里云账号 ID：`1241086349153033`（RAM 用户登录名后缀 `@1241086349153033.onaliyun.com` 即由它构成，策略 ARN 里也要用它）。

**第一步：建专用 RAM 用户。** RAM 控制台 → 身份管理 → 用户 → 创建用户，逐字段：

| 字段 | 填什么 | 说明 |
|---|---|---|
| 登录名称 | `hbecho-ops` | 完整登录名会变成 `hbecho-ops@1241086349153033.onaliyun.com` |
| 显示名称 | `hbecho 运维通道` | 只影响控制台显示 |
| 标签 | 留空 | 单人项目用不上 |
| 安全手机 / 安全邮箱（MFA 信息） | **留空** | 这两项服务于控制台登录的二次验证。这个用户不登录控制台，填了没有意义 |
| ☐ 使用控制台密码访问 | **不勾** | 这是给人用的登录方式。不勾就等于这个身份永远无法登录控制台，即使 AK 泄露也拿不到控制台会话 |
| ☑ 使用永久 AccessKey 访问 | **勾上** | 这才是 CLI 需要的 |

页面底部那句「建议启用仅一种访问方式以提高安全性」正是这个意思：两个都勾会让同一个身份既能登录控制台又能调 API，暴露面翻倍。我们只需要后者。

创建完成后页面会**一次性**显示 AccessKey Secret，之后再也查不到。当场复制保存，丢了只能删掉重建一把。

**第二步：附加最小权限策略。** RAM 控制台 → 权限管理 → 权限策略 → 创建权限策略 → 切到「脚本编辑」，贴入下面内容（来自官方 Skill 的 `references/ram-policies.md`，账号 ID 与实例 ID 已填好）。名称填 `hbecho-workbench-ops`：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs-workbench:LoginECSInstance", "ecs-workbench:ChatMessages"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeInstances", "ecs:DescribeCloudAssistantStatus"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ecs:StartTerminalSession",
      "Resource": "acs:ecs:cn-beijing:1241086349153033:instance/i-2zef8qpi1d2mldntjgrv"
    },
    {
      "Effect": "Allow",
      "Action": "ram:CreateServiceLinkedRole",
      "Resource": "*",
      "Condition": { "StringEquals": { "ram:ServiceName": "workbench.ecs.aliyuncs.com" } }
    }
  ]
}
```

四条各自的作用：第一条建立 Workbench 会话并收发命令 I/O；第二条只读查询实例元数据与云助手状态；第三条发起终端会话，**收紧到 hbecho 单实例**；第四条是首次使用时创建服务关联角色，一次性动作，带条件限定只能给 Workbench 用。

#### ⚠️ 实测发现：`ecs-workbench` 不支持资源级授权

第一版策略把 `ecs-workbench:LoginECSInstance` 的 `Resource` 写成了 `acs:ecs:cn-beijing:<账号>:ecs/i-xxx`（官方 Skill 文档给的格式）。**实测不生效**，两处证据一致：

- RAM 控制台在策略详情里把 `ecs-workbench` 一行标为「无效授权 / 无-未定义有效资源」；
- `workbench exec` 返回 403 `Forbidden.Unauthorized`，`AccessDeniedDetail` 里 `AuthAction: ecs-workbench:LoginECSInstance`、`NoPermissionType: ImplicitDeny`。

原因大概是 `ecs-workbench` 是独立的 RamCode，而那个 ARN 写的是 `acs:ecs:`（产品 `ecs`）；控制台提示"未定义有效资源"则说明这个产品很可能根本不支持资源级授权。官方 Skill 自己的最小策略用的也是 `Resource: "*"`，ARN 收紧只是它在备注里"建议"的做法。

所以 `ecs-workbench:*` 必须放开到 `*`。**收紧点转移到 `ecs:StartTerminalSession`**——ECS 产品确实支持资源级授权，而终端会话是实际执行命令的入口。效果是：Workbench 会话可以在账号范围内建立，但真正能开出终端的只有 hbecho。

残余风险要说清楚：这不等于第一版设想的"完全碰不到其他实例"。如果 `ecs:StartTerminalSession` 的资源级限制在某个链路上被绕过，这把 AK 理论上能触达账号下其他实例（当前只有 hbdam）。缓解手段是 §3.6 那条原则——**AK 生命周期短、用完即删**，而不是指望单一层策略。

> 教训：策略里的 ARN 不能只按文档抄，必须在控制台看有没有「无效授权」标记，并用一次真实调用验证。RAM 的默认拒绝是隐式的——权限写错时不会有人告诉你，只会在你用的时候失败。

**第三步：把策略授给用户。** RAM 控制台 → 用户 → `hbecho-ops` → 权限管理 → 新增授权 → 在「自定义策略」里选 `hbecho-workbench-ops`。授权范围选「整个云账号」即可——策略内部已用 ARN 收紧到单实例，这里的范围只是策略的生效边界。

**第四步：写配置文件。**（这一步我可以代做，你只要把 AccessKey 给我）

```bash
mkdir -p ~/.workbench
cat > ~/.workbench/config.json << 'EOF'
{
  "current": "hbecho",
  "profiles": {
    "hbecho": {
      "mode": "AK",
      "access_key_id": "LTAI...",
      "access_key_secret": "..."
    }
  }
}
EOF
chmod 600 ~/.workbench/config.json
```

**第五步：验证。**

```bash
workbench config list
workbench exec -i i-2zef8qpi1d2mldntjgrv -c 'hostname; uptime'
```

失败时按退出码定位：`4` 认证或授权失败（查 AK 和策略）；`1` 实例找不到（查实例 ID 与 region）；`5` 网络问题（查到 `*.aliyuncs.com` 的连通性）；`2` 参数错误或配置文件权限不对；`6` 本地 daemon 起不来。

**AK 是长期密钥**，纳入 §8.4 的密钥分级并在 §8.6 记录轮换。生产环境更推荐 `RamRoleArn` 模式（自动刷新 STS 临时凭证）；开发阶段用 AK 可以接受。

### 3.6 阿里云统一 CLI（`aliyun`）：建议装，但要限时限权

Workbench CLI 只能操作**实例内部**（执行命令、传文件）。它碰不到控制台层面的东西：建 OSS 桶、配生命周期、建 RAM 角色、改安全组、配快照策略、装监控插件——这些是 OpenAPI 层面的操作，需要阿里云统一 CLI。

#### 为什么值得装

看 §待办清单 的 P2：13 项里有 9 项是控制台操作。装了 `aliyun` 之后，这 9 项从"你按截图点一遍"变成"一条命令 + 记进手册"。

这不只是省事，它直接服务于 §0 的原则：**配置只存在于点击路径里，等于不存在。** 命令能复制、能复核、能在重建环境时重放；控制台点击路径会随界面改版失效，而且没人能验证当初到底点了什么。

#### 为什么要限时限权

要做完 P2 那些事，需要的权限相当宽：ECS 安全组写、RAM 策略与角色创建并授权、OSS 桶创建与配置、云监控写、快照策略写。**一个具备这些权限的 AK，等于能重新配置整套基础设施。**

所以按两个身份分开，生命周期也分开：

| 身份 | 权限 | 生命周期 | 用途 |
|---|---|---|---|
| `hbecho-setup` | 建设期需要的写权限 | **建设完成即删除 AK** | 一次性搭建 |
| `hbecho-ops` | 仅 Workbench（§3.5）+ 只读查询 | 长期 | 日常运维 |

建设期结束后删掉 `hbecho-setup` 的 AccessKey（或禁用该用户）。稳态运维需要的权限比搭建期窄得多，没有理由让一把宽权限 AK 长期躺在笔记本上。下次要做基础设施变更时重新签发一把，用完再删——这比"留着以防万一"安全得多。

#### 安装状态

2026-09-03 已装 **`aliyun 3.4.11`**，路径 `/opt/homebrew/bin/aliyun`。凭证 `<待配置>`。

安装方式（用的是直接下载官方二进制，比 brew 快且版本可控）：

```bash
curl -fsSL -o /tmp/aliyun-cli.tgz \
  https://aliyuncli.alicdn.com/aliyun-cli-macosx-latest-arm64.tgz
tar xzf /tmp/aliyun-cli.tgz -C /tmp
install -m 755 /tmp/aliyun /opt/homebrew/bin/aliyun
xattr -d com.apple.quarantine /opt/homebrew/bin/aliyun 2>/dev/null || true
aliyun version
```

Intel Mac 把 `arm64` 换成 `amd64`；也可以用 `brew install aliyun-cli` 或官方 PKG。

**`ossutil` 不用单独装——它是 `aliyun` 的内置子命令。** 3.4.11 的顶层命令里 `aliyun oss` 已标为废弃，官方指向 `aliyun ossutil`。本手册 §7、§13、§14 的 OSS 命令统一写作 `aliyun ossutil ...`。

同时内置了另外两个后面会用到的工具层：`cms2`（云监控，配告警规则用）、`kmscli`（密钥管理，暂不需要）。

#### 可选：不存长期 AK 的认证方式

`aliyun configure --mode` 支持 `AK / StsToken / RamRoleArn / EcsRamRole / RsaKeyPair / RamRoleArnWithRoleName / CloudSSO / OAuth / BearerToken / Anonymous` 十种。其中 `OAuth` 走浏览器登录，本机不落长期 AK，看起来很吸引人。

但它解决的是"密钥落盘"，**不解决"权限过宽"**：OAuth 登录后拿到的是登录者本人的权限，用主账号登录就等于全账号管理员。而我们真正想要的是最小权限 + 可随时吊销，这需要一个受限的 RAM 身份。

所以首版仍走「受限 RAM 用户 + AK，用完即删」。`OAuth` 和 `RamRoleArn` 留作后续优化项，那时再实测流程。

#### 配置

```bash
aliyun configure set \
  --profile hbecho-setup \
  --mode AK \
  --access-key-id "<AccessKey ID>" \
  --access-key-secret "<AccessKey Secret>" \
  --region cn-beijing

chmod 600 ~/.aliyun/config.json     # 默认权限不一定够严
# 验证
aliyun ecs DescribeInstances --RegionId cn-beijing --InstanceIds '["i-2zef8qpi1d2mldntjgrv"]'
```

#### 建设期策略

有两条路：直接用系统策略组合（`AliyunECSFullAccess` + `AliyunOSSFullAccess` + `AliyunCloudMonitorFullAccess`），或者用下面这份自定义策略。**推荐后者**——它去掉了删实例、停机、删盘、删快照这些本项目建设期完全不需要、但一旦误用就不可逆的动作。

策略名 `hbecho-setup-buildout`：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Sid": "EcsReadOnly",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeRegions",
        "ecs:DescribeZones",
        "ecs:DescribeInstances",
        "ecs:DescribeInstanceAttribute",
        "ecs:DescribeDisks",
        "ecs:DescribeAvailableResource",
        "ecs:DescribeSecurityGroups",
        "ecs:DescribeSecurityGroupAttribute",
        "ecs:DescribeSnapshots",
        "ecs:DescribeAutoSnapshotPolicyEx",
        "ecs:DescribeInstanceRamRole",
        "ecs:DescribeCloudAssistantStatus",
        "ecs:DescribeInvocations",
        "ecs:DescribeInvocationResults"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SecurityGroupRules",
      "Effect": "Allow",
      "Action": [
        "ecs:AuthorizeSecurityGroup",
        "ecs:RevokeSecurityGroup",
        "ecs:ModifySecurityGroupRule"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DiskAndSnapshot",
      "Effect": "Allow",
      "Action": [
        "ecs:CreateDisk",
        "ecs:AttachDisk",
        "ecs:ResizeDisk",
        "ecs:CreateSnapshot",
        "ecs:CreateAutoSnapshotPolicy",
        "ecs:ApplyAutoSnapshotPolicy",
        "ecs:ModifyAutoSnapshotPolicyEx"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudAssistantOnHbecho",
      "Effect": "Allow",
      "Action": [
        "ecs:InstallCloudAssistant",
        "ecs:RunCommand"
      ],
      "Resource": "acs:ecs:cn-beijing:1241086349153033:instance/i-2zef8qpi1d2mldntjgrv"
    },
    {
      "Sid": "AttachRamRoleToHbecho",
      "Effect": "Allow",
      "Action": [
        "ecs:AttachInstanceRamRole"
      ],
      "Resource": "acs:ecs:cn-beijing:1241086349153033:instance/i-2zef8qpi1d2mldntjgrv"
    },
    {
      "Sid": "OssListAll",
      "Effect": "Allow",
      "Action": [
        "oss:ListBuckets"
      ],
      "Resource": "acs:oss:*:1241086349153033:*"
    },
    {
      "Sid": "OssManageHbechoBuckets",
      "Effect": "Allow",
      "Action": [
        "oss:PutBucket",
        "oss:GetBucketInfo",
        "oss:GetBucketLocation",
        "oss:GetBucketAcl",
        "oss:PutBucketAcl",
        "oss:PutBucketLifecycle",
        "oss:GetBucketLifecycle",
        "oss:DeleteBucketLifecycle",
        "oss:PutBucketCors",
        "oss:GetBucketCors",
        "oss:PutBucketEncryption",
        "oss:GetBucketEncryption",
        "oss:GetBucketPublicAccessBlock",
        "oss:PutBucketPublicAccessBlock",
        "oss:PutBucketVersioning",
        "oss:GetBucketVersioning",
        "oss:ListObjects",
        "oss:GetObject",
        "oss:PutObject",
        "oss:GetObjectMeta",
        "oss:DeleteObject",
        "oss:AbortMultipartUpload",
        "oss:ListParts"
      ],
      "Resource": [
        "acs:oss:*:1241086349153033:hbecho-*",
        "acs:oss:*:1241086349153033:hbecho-*/*"
      ]
    },
    {
      "Sid": "CloudMonitor",
      "Effect": "Allow",
      "Action": "cms:*",
      "Resource": "*"
    },
    {
      "Sid": "RamForInstanceRole",
      "Effect": "Allow",
      "Action": [
        "ram:CreatePolicy",
        "ram:GetPolicy",
        "ram:ListPolicies",
        "ram:CreatePolicyVersion",
        "ram:ListPolicyVersions",
        "ram:CreateRole",
        "ram:GetRole",
        "ram:ListRoles",
        "ram:AttachPolicyToRole",
        "ram:ListPoliciesForRole"
      ],
      "Resource": "*"
    }
  ]
}
```

几处刻意的取舍：

| 决定 | 原因 |
|---|---|
| **没有** `ecs:DeleteInstance` / `StopInstance` / `RebootInstance` / `DeleteDisk` / `DetachDisk` / `DeleteSnapshot` | 建设期不需要，误用不可逆 |
| **没有** `ecs:ModifyInstanceAttribute` | 它能改实例密码。重置密码你在控制台做，不需要给 CLI 这个能力 |
| OSS 资源限定 `hbecho-*` 前缀 | 碰不到账号下其他 bucket。⚠️ **如果你已经建的桶不叫 `hbecho-` 开头，告我实际桶名，这里要改** |
| `oss:DeleteObject` 给了，`oss:DeleteBucket` 没给 | 验证时需要清理测试对象；删桶不该由脚本完成 |
| `RunCommand` / `AttachInstanceRamRole` 限定到 hbecho 单实例 | 这两个动作影响面最大，用 ARN 锁死 |
| `cms:*` 用了通配 | 云监控的 action 命名我没有逐个实测，写错会导致配告警时失败且难定位；它的破坏面也小（最坏是删掉告警规则）。等价于 `AliyunCloudMonitorFullAccess`。偏保守可以先不给这一段，等做待办 22 时再加 |
| **没有任何 `ram:` 动作** | 见下 |

#### `RamForInstanceRole` 这一段的性质（已确认接受）

2026-09-03 决定包含 `ram:` 动作，让待办 19（建 OSS 权限策略 + 实例 RAM 角色）可以由 CLI 完成。

需要如实记录它的实际权限等级：`ram:CreateRole` + `ram:CreatePolicy` + `ram:AttachPolicyToRole`，配上同一策略里的 `ecs:AttachInstanceRamRole` 和 `ecs:RunCommand`，构成一条完整提权链——可以造一个高权限角色、绑到实例、在实例里用它做任何事。**因此 `hbecho-setup` 的有效权限等级是账号管理员，而不是它的 action 列表看起来的那样。**

这不是反对意见，只是让手册不至于误导后来的人：看到策略里没有 `AdministratorAccess` 就以为这个身份是受限的。真正的控制手段是生命周期，不是 action 列表：

| 控制手段 | 具体做法 |
|---|---|
| 时间 | 建设期结束**立即删除 AccessKey**（待办清单最后一项） |
| 可审计 | 所有用它执行的动作记进 §17；ActionTrail 里可以按这个 UserPrincipalName 回溯 |
| 可吊销 | 怀疑泄露时 RAM 控制台禁用用户，立即生效 |
| 隔离 | 它与长期使用的 `hbecho-ops` 是两个身份，删掉它不影响日常运维通道 |

删除 AK 后若还需要做基础设施变更，重新签发一把，用完再删。

#### 我会做和不会做的事

| 类别 | 处理方式 |
|---|---|
| 只读查询（列实例、看磁盘、查配置、核对生命周期规则） | 直接执行 |
| 幂等的配置写入（生命周期规则、告警规则、监控插件、CORS） | 直接执行，完成后记进 §17 |
| **花钱的操作**（买数据盘、扩容、改带宽、续费） | **先提案，你确认后执行** |
| **难以逆转的操作**（删桶、删快照、重置密码、可能导致断连的安全组变更） | **先提案，你确认后执行** |
| RAM 提权类操作（建角色并授权） | 先给出策略 JSON 让你过一遍，再执行 |
| ICP 备案、实名认证、支付 | 只能你做，CLI 不覆盖 |

#### VOD 权限（2026-10-29 追加）

域 G 决定课程视频走 VOD（`prd-domain-g-learning.md` G-D09），VOD 已开通，地域**华北2（北京）**，与 ECS 同地域。`hbecho-setup` 当前没有任何 VOD 权限：2026-10-29 实测 `vod:DescribeVodUserDomains` 返回 `NoPermission / ImplicitDeny`。

新增**独立**策略 `hbecho-vod-manage`，不并入 `hbecho-setup-buildout`——VOD 是长期功能，将来要把运行期权限移交给应用实例角色，分开一条便于单独撤销与审计：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Sid": "VodAll",
      "Effect": "Allow",
      "Action": "vod:*",
      "Resource": "*"
    }
  ]
}
```

**为什么用 `vod:*` 而不逐条列 action**：VOD 的 action 命名没有逐个实测；本手册已记录过策略写错会在控制台标「无效授权」、且 RAM 默认拒绝不报错，只在调用时失败。逐条写错会让上传或播放凭证失败且难定位。代价是包含 `DeleteVideo` / `DeleteStream` 等不可逆动作，因此按上文「我会做和不会做的事」执行：只读与幂等配置直接做，删除类先提案再动。

**操作步骤**：

1. RAM 控制台 → 权限管理 → 权限策略 → 创建权限策略 → 切到「脚本编辑」→ 粘贴上面的 JSON → 名称填 `hbecho-vod-manage` → 确定；
2. 身份管理 → 用户 → `hbecho-setup` → 权限管理 → 新增授权 → 「自定义策略」里勾 `hbecho-vod-manage` → 授权范围选「整个云账号」→ 确定；
3. 本机验证：

```bash
aliyun vod DescribeVodUserDomains --PageSize 50 --profile hbecho-setup
```

返回域名列表（可能为空列表，表示尚未添加加速域名）即授权成功；仍报 `NoPermission` 说明策略未生效或授权范围选错。

**运行期权限另算**：将来 `hbecho-ecs-role` 需要一份只含「上传 + 播放凭证 + 替换时删旧视频」的 VOD 策略，在 ADR-0007 中定稿后单独创建，**不要把这份 `vod:*` 挂到实例角色上**。

#### 凭证管理

`~/.aliyun/config.json` 与 `~/.workbench/config.json` 都是本机长期密钥，纳入 §8.4 密钥分级：权限 600、不进任何仓库、轮换记 §8.6。本机应开启全盘加密（macOS 的 FileVault）。

`<待填写：实际安装版本、所用 RAM 用户名、AK 签发与删除日期>`

---

### 3.7 ACR 登录凭证（2026-11-10）

两个专用 RAM 子账号，权限各自限定在实例 `cri-e07ol87axh61gu6d` 的 `hbecho` 命名空间：

| 用途 | RAM 用户 | docker login 用户名 | 策略名 | 密码存放 |
|---|---|---|---|---|
| CI 推送 | `hbecho-acr-push` | `hbecho-acr-push@1241086349153033` | `hbecho-acr-push-policy` | GitHub Actions secret `ACR_PUSH_PASSWORD` |
| 服务器拉取 | `hbecho-acr-pull` | `hbecho-acr-pull@1241086349153033` | `hbecho-acr-pull-policy` | 服务器 `/root/.docker/config.json`（600），交互输入 |

**push 策略**（pull 策略删掉 `cr:PushRepository`、`cr:CreateRepository`、`cr:UpdateRepository`，其余相同；**`cr:PullRepository` 不能少**）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cr:ListInstance*", "cr:GetInstance*", "cr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cr:PullRepository", "cr:PushRepository", "cr:GetRepository", "cr:ListRepository",
        "cr:ListRepositoryTag", "cr:GetRepositoryManifest", "cr:GetRepositoryLayers",
        "cr:CreateRepository", "cr:UpdateRepository"
      ],
      "Resource": [
        "acs:cr:*:*:repository/cri-e07ol87axh61gu6d/hbecho/*",
        "acs:cr:*:*:repository/cri-e07ol87axh61gu6d/hbecho"
      ]
    }
  ]
}
```

**登录与拉取**（服务器侧只用内网域名；CI 推送用公网域名）：

```bash
docker login --username=hbecho-acr-pull@1241086349153033 hbecho-registry-registry-vpc.cn-beijing.cr.aliyuncs.com
docker pull hbecho-registry-registry-vpc.cn-beijing.cr.aliyuncs.com/hbecho/<repo>:<git短sha>
```

**已知坑**：

- 缺 `cr:PullRepository` 时 `docker login` 仍然成功，pull 才报 `pull access denied`，令牌里 `granted` 为空——先查策略，不要先怀疑密码（hbdam 2026-10-15 踩过）。
- RAM 控制台把 `cr:PullRepository` 显示在「未识别操作」下，是可视化目录没收录数据面动作，策略实际生效。
- **固定密码只能由账号本人设置**：ACR 的 `ResetLoginPassword` 只有 `InstanceId` + `Password` 两个参数，没有用户名，主账号无法代设；控制台同理。
- 子账号设完固定密码后应关闭其「控制台访问」——设定密码时沿用了控制台密码的话，不关就等于同一串密码同时开两个门。

**验证记录（2026-11-10）**：探测镜像 `hbecho/probe:probe-1` 用 push 账号推送成功（523 B）；pull 账号拉取成功、**推送被拒**（`unauthorized: authentication required`）；服务器 `/root/.docker/config.json` 权限 600、只含内网域名。

**轮换**：固定密码在 ACR 控制台「访问凭证」重设；push 侧重设后同步更新 GitHub secret，pull 侧重设后在服务器重新 `docker login`。

---

## 4. 首次搭建顺序

> 顺序经过 hbdam 一次实践验证。**按序做能避开几个会互相锁死的坑**；乱序做最坏情况是重装系统。

```
 1. 打通不依赖 22 端口的通道并实测  ← Workbench CLI（§3.4）或会话管理（§4.2）。必须最先做
 2. 装公钥、验证密钥登录
 3. 关闭 SSH 密码认证            ← 第 2 步验证成功后才能做（当前密码认证是开着的）
 4. 收紧安全组 22                ← 有兜底通道才敢做（当前 22 对公网开放）
 5. 挂数据盘（UUID + nofail + noatime），建 §1.3 目录
 6. 系统参数（limits 两处 + sysctl + 时间同步）
 7. 装容器运行时（data-root、日志轮转、镜像加速）
 8. 配自动快照 + 监控告警
 9. 定 OSS 桶拓扑并创建（同地域 + 私有 + 加密 + 生命周期）   ← 写入第一个对象前必须定
10. 绑实例 RAM 角色，验证临时凭证
11. 部署 MySQL 并跑 §13 的验收清单
12. 建 git 仓库（.gitignore 先行）
13. 提交 ICP 备案（可与 5–12 并行）
```

第 1 步必须最先的原因：第 3、4 步任何一步出错（sshd 配置写错、出口 IP 变动、安全组填错），唯一的救援方式就是控制台通道；如果那时才发现会话管理没开，只剩 VNC + root 密码。

第 9 步必须早于任何真实写入的原因：`oss_objects` 用 `UQ(provider_code, region, bucket, object_key, object_version)` 定位对象，桶名进了数据库就成了历史事实。改桶拓扑要同时搬对象和改历史行，代价远高于开工前想清楚。

### 4.1 收紧安全组 22

安全组 ID：`sg-2zeank1y5h8hsyzpqank`。2026-09-03 实测的入方向规则：

| 协议 | 端口 | 来源 | 处置 |
|---|---|---|---|
| TCP | 22/22 | `0.0.0.0/0` | ✅ **已删除**（2026-09-03） |
| TCP | 22/22 | `223.78.0.0/16` | ✅ **已添加**，优先级 1，描述 `SSH-liuxuekui-cmcc-sd-20260903` |
| ICMP | -1/-1 | `0.0.0.0/0` | 保留（便于连通性诊断，风险低） |
| TCP | 3389/3389 | `0.0.0.0/0` | ✅ **已移除**（2026-09-03） |

3389 是 Windows 远程桌面端口。这是 Linux 机器，`ss -tlnp` 实测没有任何进程监听它——纯暴露面、零收益，且一旦将来有东西绑到 3389 就直接暴露。这条是阿里云默认安全组自带的（`System created rule`），新机器都要检查一遍。

#### 出口 IP 有两个，这改变了做法

2026-09-03 实测：

| 场景 | 出口 IP | 归属 |
|---|---|---|
| VPN 关 | `223.78.94.133` | 中国移动 · 山东青岛 |
| VPN 开 | `50.7.158.251` | FDCservers.net · 东京机房，网段 `50.7.152.0/21` |

⚠️ **绝对不要把 VPN 出口 IP 或其网段加进白名单。** `50.7.152.0/21` 是主机商的共享地址段，白名单放行它等于**允许该主机商所有其他租户访问你的 22 端口**——比放行一个中国移动网段危险得多。VPN 出口的 `/32` 也是同一个 VPN 节点所有用户共享的。

移动宽带 IP 也是动态的，重启光猫就变，所以 `/32` 锁死同样不稳。

#### 三个方案

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（推荐）** | 22 只放行 `223.78.0.0/16` | 暴露面从全网缩到一个运营商网段。**挂 VPN 时 SSH 连不上**，那时用 Workbench 通道（§3.4） |
| B | 完全关闭 22，只用 Workbench | 暴露面最小。代价是失去 SSH 隧道，MySQL 图形客户端没法用（Workbench v1.0.1 无端口转发） |
| C | 22 默认关闭，需要时用脚本临时开当前 IP，用完关 | 安全与便利兼顾，但多一个"忘记关"的失败模式 |

推荐 A 的理由：MySQL 还没部署，但迟早要用图形客户端看数据，B 会在那时变成障碍；C 的自动化不复杂但增加了一个需要记得收尾的动作。A 在暴露面和日常便利之间取了可接受的点，而且**真正的兜底是 Workbench 通道已经打通**，不依赖 SSH 可达性。

#### 操作（先加后验再删，顺序不能颠倒）

```bash
SG=sg-2zeank1y5h8hsyzpqank

# 1) 先加窄规则
aliyun ecs AuthorizeSecurityGroup --RegionId cn-beijing --SecurityGroupId $SG \
  --IpProtocol tcp --PortRange 22/22 --SourceCidrIp 223.78.0.0/16 \
  --Priority 1 --Description "SSH-liuxuekui-cmcc-sd-20260903" --profile hbecho-setup

# 2) 验证（VPN 关闭状态下）
ssh -o BatchMode=yes hbecho 'echo OK'

# 3) 验证通过后才删宽规则
aliyun ecs RevokeSecurityGroup --RegionId cn-beijing --SecurityGroupId $SG \
  --IpProtocol tcp --PortRange 22/22 --SourceCidrIp 0.0.0.0/0 --profile hbecho-setup

# 4) 再验证一次
ssh -o BatchMode=yes hbecho 'echo OK'
```

> 安全组规则是**并集**生效。只要 `0.0.0.0/0` 那条还在，新加的窄规则毫无作用——这是很多人以为收紧了但其实没有的原因。

IP 变动后连不上时：用 Workbench CLI 进机器（不受安全组影响），或用 `aliyun` CLI 直接改规则，不需要先能 SSH。

#### 执行记录

2026-09-03 按上面四步执行完成。**收紧后的入方向规则不是三条，而是四条**：

| 协议 | 端口 | 来源 | 优先级 | 描述 | 创建时间 |
|---|---|---|---|---|---|
| TCP | 22/22 | `223.78.0.0/16` | 1 | `SSH-liuxuekui-cmcc-sd-20260903` | 08:38:33Z |
| TCP | 22/22 | `100.104.192.128/26` | 1 | **`createdByEcsWorkbench`** | 08:39:41Z |
| TCP | 22/22 | `100.104.93.0/26` | 1 | **`createdByEcsWorkbench`** | 08:39:41Z |
| ICMP | -1/-1 | `0.0.0.0/0` | 100 | System created rule | — |

#### ⚠️ 更正：Workbench 确实使用入方向 22，只是它自己管规则

我先前写的"Workbench 不需要开放任何入方向端口"**不准确**，这次执行暴露了真实机制。

时间线还原：

```
08:38:33Z  添加 223.78.0.0/16 规则
   ↓       删除 22 ← 0.0.0.0/0
   ↓       第一次 workbench exec → 报 "unknown error"      ← Workbench 路径被切断
08:39:41Z  阿里云自动创建两条 100.104.x.x/26 规则（createdByEcsWorkbench）
   ↓       重试 workbench exec → OK                        ← 自愈完成
```

我当时判断是"陈旧 session"并执行了 `session close --all`，**这个判断是错的**。真实原因是删掉 `0.0.0.0/0` 切断了 Workbench 的入方向路径，而 Workbench 服务在下一次尝试时**自动向安全组写入了它自己源网段的规则**。重试成功是因为规则已经建好，不是因为关了 session。

准确的说法是：**「免开端口」指的是不需要你手动开，不是不使用入方向端口。** Workbench 走的是从阿里云内部网段（`100.64.0.0/10` 运营商级 NAT 空间，非公网可路由）发起的 SSH 连接，并且自己维护对应的安全组规则。

三个实践后果：

| 后果 | 说明 |
|---|---|
| **不要删除 `createdByEcsWorkbench` 规则** | 删掉就切断带外通道。看到陌生的 `100.104.x.x/26` 规则不要以为是入侵痕迹 |
| 收紧 22 后第一次 Workbench 调用可能失败 | 约 1 分钟内自愈，重试即可。不要因此回滚安全组变更 |
| 如果有"22 端口完全不能有任何入方向规则"的硬要求 | Workbench 不满足。那种场景只能靠控制台 VNC |

安全性并未打折：那两个网段是阿里云内部地址，不在公网可达范围内。

#### 排查 Workbench 报错的顺序

它的错误信息不区分原因，所以按这个顺序试：

```bash
# ① 安全组是否还有 createdByEcsWorkbench 规则
aliyun ecs DescribeSecurityGroupAttribute --RegionId cn-beijing \
  --SecurityGroupId sg-2zeank1y5h8hsyzpqank --Direction ingress --profile hbecho-setup \
  | grep -i workbench
# ② 等 1 分钟重试（等它自愈）
# ③ 关掉陈旧 session
workbench session list; workbench session close --all
# ④ 查云助手 Agent
aliyun ecs DescribeCloudAssistantStatus --RegionId cn-beijing \
  --InstanceId.1 i-2zef8qpi1d2mldntjgrv --profile hbecho-setup
# ⑤ 最后才怀疑权限（退出码 4）与网络（退出码 5）
```

### 4.2 `[ ]` 开启会话管理

ECS 控制台 → 运维与监控 → 会话管理 → 开启，然后在实例上用"通过会话管理远程连接"实测一次免密登录。前提是云助手 Agent 在运行。

按钮是灰的时：先确认功能已开启，再确认用的是有权限的账号（RAM 用户需要相应 ECS 权限），最后刷新控制台缓存。

### 4.3 `[ ]` ICP 备案

hbecho 与 hbdam 的流程一致，不重复抄写细节，直接参考 [hbdam 手册 §4.3](../archive/legacy/项目历史文档/hbdam项目服务器运维手册.md)。只强调三件对 hbecho 仍然成立的事：

- **域名 whois 实名信息必须与备案主体一致**，这是最高频驳回原因；过户有几天延迟，越早查越好。
- 短信核验链接**收到后 24 小时内必须点**，过期作废重来。
- 备案期间**不要把域名解析到 ECS 公网 IP**。开发访问走 §3.1 的 SSH 隧道。

hbecho 独有的一条：备案通过 ≠ 可以对外开放。还要满足 §10.6 的开放前置条件（最小访问控制闭环），否则等于把一个无认证的内部系统挂到公网。

---

## 5. 系统层配置

### 5.1 数据盘

```bash
# 设备名先实测（lsblk），不要照抄
parted -s /dev/<设备> mklabel gpt
parted -s -a optimal /dev/<设备> mkpart primary ext4 0% 100%
mkfs.ext4 -F -L hbecho-data /dev/<设备>p1
blkid /dev/<设备>p1          # 取 UUID 写进 fstab
```

`/etc/fstab` 追加（**用 UUID，不用设备名**）：

```
UUID=<待填写> /data ext4 defaults,noatime,nofail 0 2
```

改完先 `mount -a` 验证，再 `df -hT /data` 确认挂上，然后建 §1.3 的目录并把 `mysql/`、`backup/` 设成 `700`。

### 5.2 文件句柄上限

两个文件都要写，否则 systemd 拉起的 MySQL 和容器的 fd 上限不会变：

`/etc/security/limits.d/90-hbecho.conf`
```
* soft nofile 65535
* hard nofile 65535
* soft nproc  65535
* hard nproc  65535
root soft nofile 65535
root hard nofile 65535
```

`/etc/systemd/system.conf.d/90-hbecho-limits.conf`
```
[Manager]
DefaultLimitNOFILE=65535:524288
```

改完 `systemctl daemon-reexec`。

#### ⚠️ 不要写成 `65535:65535`

hbdam 手册和大量教程都写 `DefaultLimitNOFILE=65535:65535`。**在这台机器上那是降级。**

实测本机原始值是 `soft=1024 / hard=524288`（systemd 默认）。写 `65535:65535` 会把软限从 1024 抬到 65535（对），但同时把**硬限从 524288 压到 65535**（错）。硬限是程序调 `setrlimit` 时能自行抬到的上限，压低它没有任何收益。

正确写法是 `65535:524288`——抬软限、保硬限。实测生效值：

```
DefaultLimitNOFILE=524288      ← 硬限
DefaultLimitNOFILESoft=65535   ← 软限
```

#### 验证必须看进程，不能看配置文件

`DefaultLimitNOFILE` 只影响**改动之后启动的服务**。改完立刻查已运行的服务会看到旧值，容易误判成没生效：

```bash
# 改动前就在运行的服务：仍是旧值（预期）
awk '/open files/ {print $4, $5}' /proc/$(systemctl show -p MainPID --value sshd)/limits
#   → 1024 524288

# 重启一个无害服务验证新值
systemctl restart chronyd
awk '/open files/ {print $4, $5}' /proc/$(systemctl show -p MainPID --value chronyd)/limits
#   → 65535 524288  ✓
```

实测确认新启动的服务拿到 `65535 / 524288`。已运行的 sshd 仍是 `1024 / 524288`，下次重启后统一——这不影响当前使用，因为 sshd 不是高 fd 消耗方。

### 5.3 内核参数

hbecho 的负载结构和 hbdam 不同，**是出方向密集型**：定时全量同步会对 AI Master 发大量 HTTPS 请求，媒资归档会对多个内容平台源站发下载请求，同时还要往 OSS 写对象。入方向并发很低（内部用户）。所以调参重点是**本地端口与连接回收**，不是 accept 队列。

`/etc/sysctl.d/90-hbecho.conf`（2026-09-03 已应用）：

```
# hbecho：出方向密集型负载（供应商 API + 媒资下载 + OSS 写入）
# 本地端口耗尽是首个瓶颈，不是 accept 队列
net.ipv4.ip_local_port_range = 10240 65000
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
# 入方向很轻（内部用户），给合理值即可
net.core.somaxconn = 1024
net.ipv4.tcp_max_syn_backlog = 1024
fs.file-max = 1000000
# 不设 vm.swappiness：本机无 swap 分区，该值无作用；
# 且 /etc/sysctl.d/99-apsara-sysctl.conf 已设为 0 并因文件名顺序覆盖本文件。
```

`sysctl --system` 生效。实测六项全部生效。

#### ⚠️ `vm.swappiness` 这条不要抄

hbdam 手册写了 `vm.swappiness = 1`。在这台机器上它**两重无效**：

1. **本机没有 swap 分区**（`free -h` 的 Swap 行是 `0B`）。没有 swap 时 swappiness 不起任何作用。
2. **被阿里云自己的配置覆盖**。实测有三个文件设它：

```
/etc/sysctl.d/50-aliyun.conf          → 0
/etc/sysctl.d/90-hbecho.conf          → 1     ← 我们的
/etc/sysctl.d/99-apsara-sysctl.conf   → 0     ← 生效的
```

`sysctl.d` 按文件名字典序加载，**后者胜**。`99-` > `90-`，所以最终值是 `0`。写了 1 但读出来是 0，看起来像"配了没生效"，实际是被覆盖。

结论：这条从配置里删掉，并在注释里写明原因。留着只会让下一个人以为设置失败了去排查。

> 一般性教训：`sysctl.d` 里加配置前先 `grep -rn <参数名> /etc/sysctl.conf /etc/sysctl.d/`，确认没有更高序号的文件在覆盖你。云厂商镜像通常带 `99-` 开头的自有配置。

不抄 hbdam 的另两项：`vm.overcommit_memory = 1` 是为特定内存分配行为设的，hbecho 没有同类负载，保持默认更安全；`fs.inotify.max_user_watches` 是为大量小文件监听调的，hbecho 没有本地文件抽取管道。

> 如果机器上启用了 firewalld / conntrack，出方向连接数大时还要看 `net.netfilter.nf_conntrack_max`。表满的表现是**偶发连接失败但没有明确报错**，很容易被误判成供应商限流。排查时先 `conntrack -C` 看用量。

### 5.4 时间同步（不是可选项）

v2 的同步任务用**租约 + fencing token** 保证幂等（v2 §9.3）。租约到期判断依赖时间；时钟漂移会让两个 worker 同时认为自己持有租约，或让有效租约被误判过期。**时钟准确性是正确性依赖，不是运维洁癖。**

```bash
timedatectl set-timezone Asia/Shanghai   # 日志可读性
systemctl enable --now chronyd
chronyc sources -v
chronyc tracking | grep -E 'System time|Last offset'
```

时区选 `Asia/Shanghai` 只影响系统日志和 `SyncSchedule` 的人工核对；**业务时间一律 UTC 存库**（§6.2），应用不得依赖系统时区解释业务时间。

§12 有一条时钟偏移告警，就是为了让租约语义不静默失效。

### 5.5 容器运行时

**2026-09-03 已安装**：Docker `28.3.3`（`moby` 3:28.3.3-4.alnx4）+ Compose `2.26.1`（`docker-compose-plugin`），均来自 Alinux4 官方源 `alinux4-updates`，`runc 1.2.8`。

```bash
dnf install -y moby docker-compose-plugin
systemctl enable --now docker
```

> Alibaba Cloud Linux 上阿里云推荐 `moby`（命令、服务名 `docker`、API 与标准 Docker 一致），**但它不含 compose 插件**，要另装 `docker-compose-plugin`。源里有 2.26.1，比手动下载二进制好维护。

`/etc/docker/daemon.json`：

```json
{
  "data-root": "/data/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "100m", "max-file": "3" },
  "live-restore": true,
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Hard": 65535, "Soft": 65535 }
  },
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.net",
    "https://docker.1ms.run"
  ]
}
```

镜像加速源是 2026-09-03 **从服务器侧实测**筛出来的（本机能连不代表服务器能连）：

| 地址 | 服务器侧 `/v2/` 响应 |
|---|---|
| `docker.m.daocloud.io` | 401 ✅ |
| `dockerproxy.net` | 200 ✅ |
| `docker.1ms.run` | 401 ✅ |
| `docker.xuanyuan.me` | 401 ✅（备用，未写入） |
| **`registry-1.docker.io`** | **`000` 不可达** ← 官方 Hub 在国内 ECS 上确实连不上 |

> `401` 是 Docker Registry 对未带 token 的 `/v2/` 的正确响应，代表**服务活着**。只有 `000`/timeout 才是不可用。

生效验证（实测通过）：

```
Docker Root Dir:      /data/docker      ← 落数据盘
Logging Driver:       json-file
Live Restore Enabled: true
Registry Mirrors:     https://docker.m.daocloud.io/
```

端到端验证也做了：`docker pull hello-world` 成功走加速源、`docker run` 正常、容器内 `ulimit -n` = 65535（继承 `default-ulimits`）、镜像层确认写入 `/data/docker`。测试镜像已清理，`docker system df` 全零。

四项的理由与 hbdam 一致：`data-root` 防止镜像和容器层占满系统盘；`log-opts` 轮转防止容器日志写满磁盘（自建 Compose 部署最常见的事故）；`live-restore` 让守护进程重启时容器不停；镜像加速是因为 Docker Hub 在国内 ECS 上不可达。

镜像加速地址填写前先实测能拉通。第三方加速源经常失效，写进文档的必须是当天验证过的。

**不装的东西**：队列（Redis/RabbitMQ）、ORM 工具链、应用框架脚手架。这些是未冻结的技术决策（总纲 §12.2），预装等于替决策者做了选择。

---

## 6. MySQL

### 6.1 部署形态

当前资产只有 ECS + OSS，因此首版**自建 MySQL**，数据目录在 `/data/mysql`，端口只绑 `127.0.0.1:3306`。

若后续改用 RDS，§6 的参数配置方式、§11 的备份策略和 §13 的验收方式都要整体重写，不是改几行的事。做这个切换时记一条 §17 变更记录并复查全章。

#### 2026-09-04 已部署（Docker）

| 项 | 值 |
|---|---|
| 镜像 | `mysql:8.0`，实测 `mysqld Ver 8.0.46` |
| 容器名 | `hbecho-mysql` |
| 编排文件 | `/data/app/docker-compose.yml`，配置见 `/data/app/mysql.env`（600，不进仓库） |
| 数据目录 | `/data/mysql`（挂载卷，700） |
| 端口 | `127.0.0.1:3306:3306`，容器另暴露 `33060`（X Protocol，未映射到宿主） |
| root / 应用密码 | 24 位随机串，存本机 Keychain：`hbecho-mysql-root`、`hbecho-mysql-app` |
| 应用账号 | `hbecho_app`，仅 `hbecho.*` 全权限，不是 `*.*` |
| 健康检查 | `healthy`（`mysqladmin ping`，10s 间隔） |

部署时**没有把密码经过 `workbench exec` 的命令行参数传递**——那样会留在本机 shell 历史和执行日志里。做法是 `workbench upload` 一个 600 权限的 env 文件到服务器，`docker compose` 用 `env_file` 引用它，密码从未出现在任何命令行里。

```bash
# 生成与存放（本机执行，不落地明文文件）
ROOT_PW=$(LC_ALL=C tr -dc 'A-Za-z0-9!@#%^*_+=-' < /dev/urandom | head -c 24)
security add-generic-password -a "mysql-root@hbecho" -s "hbecho-mysql-root" -w "$ROOT_PW" -U
# ... 写临时 env 文件，chmod 600，workbench upload，再删本机临时文件
```

`docker-compose.yml` 里 `command` 段直接把 §6.2 的关键参数（字符集、时区、`sql_mode`、`local_infile`）作为启动参数传给 `mysqld`，不依赖额外的 `my.cnf` 挂载——单实例场景下更简单，参数变更只需改 compose 文件重启容器。

### 6.2 必须确认的参数

v2 基线要求 MySQL **8.0.16+**，原因是 CHECK 约束从 8.0.16 起才真正强制执行。整个 v2 设计把大量语义不变量放在 CHECK 里（归档状态与 asset/error 的组合、`window_overflow` 必须伴随 `continuity_gap`、`object_category` 隔离等）。**在 8.0.16 之前的版本上，这些 CHECK 会被解析后忽略，建表成功、约束失效、无任何警告。**§13.1 有一条专门的破坏性验证。

| 参数 | 值 | 为什么 |
|---|---|---|
| `character_set_server` | `utf8mb4` | 昵称、正文含 emoji 与生僻字 |
| `collation_server` | `utf8mb4_0900_ai_ci` | 8.0 默认，不改 |
| `time_zone` | `+00:00` | 业务时间统一 UTC。用偏移量而非命名时区，避免依赖 tz 表 |
| `sql_mode` | 保留 8.0 默认，**尤其不得移除 `STRICT_TRANS_TABLES`** | 非严格模式会把超范围/非法值静默截断成合法值，直接违反"真实 0、缺失、显式 null、非法值必须保留不同语义"这条不变量 |
| `innodb_flush_log_at_trx_commit` | `1`（默认，不要改） | v2 §12.4 要求**先持久化 `prepared` 调用意图再发网络请求**。改成 0/2 时崩溃会丢掉已付费调用的意图记录 |
| `sync_binlog` | `1`（默认，不要改） | 同上 |
| `log_bin` | 开启 | PITR 需要 |
| `binlog_expire_logs_seconds` | `<待填写>`（默认 30 天） | 与备份周期和磁盘容量一起定；binlog 撑满数据盘是常见事故 |
| `innodb_buffer_pool_size` | `<待填写>`：数据库独占机器时取内存 50–60% | 与应用同机时要留出应用与页缓存空间 |
| `max_connections` | `<待填写>` | 按连接池上限 × 进程数 + 运维余量估，不要照抄默认 151 也不要随手给 1000 |
| `innodb_lock_wait_timeout` | 默认 50 | worker 用 `FOR UPDATE SKIP LOCKED` 领任务，正常不该等锁；这个值调大反而会掩盖长事务问题 |
| `local_infile` | `OFF` | 减少一个文件读取面 |

`transaction_isolation` 保持默认 `REPEATABLE-READ`。v2 的受限写入过程依赖"锁定任务行 → 校验 status/fencing_token → 带条件更新并检查受影响行数"这一套模式，隔离级别属于设计决策，**不是运维可以随手调的性能旋钮**。要改就走设计评审。

### 6.3 版本验证

```bash
# 版本必须 >= 8.0.16
mysql -h 127.0.0.1 -P 13307 -u <user> -p -e 'SELECT VERSION();'
# 时区必须是 +00:00
mysql ... -e "SELECT @@global.time_zone, @@session.time_zone, NOW(), UTC_TIMESTAMP();"
# SKIP LOCKED 可用性（8.0+ 都支持，确认语法不被中间件改写）
mysql ... -e "SELECT 1 FROM mysql.user LIMIT 1 FOR UPDATE SKIP LOCKED;" 2>&1 | tail -2
```

#### 2026-09-04 实测结果

```
version              8.0.46
time_zone (global)   +00:00
time_zone (session)  +00:00
sql_mode             STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
character_set_server utf8mb4
collation_server     utf8mb4_0900_ai_ci
local_infile         OFF
```

**§13.1、§13.2 的破坏性验收已跑，两条都精确匹配预期报错**（不是"没报错"，是"报了预期的那个错"）：

```sql
CREATE TABLE _check_probe (v INT, CONSTRAINT ck_probe CHECK (v > 0));
INSERT INTO _check_probe (v) VALUES (-1);
-- → ERROR 3819 (HY000): Check constraint 'ck_probe' is violated.

CREATE TABLE _strict_probe (n TINYINT);
INSERT INTO _strict_probe (n) VALUES (99999);
-- → ERROR 1264 (22003): Out of range value for column 'n' at row 1
```

两张探针表已 `DROP`，未留痕迹。**结论：8.0.46 上 CHECK 约束和严格模式都真实生效，v2 基线依赖的这两条底层保证成立。**

### 6.4 账号权限

| 账号 | 权限 | 说明 |
|---|---|---|
| `root` | 全部 | 仅本机，运维用 |
| 应用账号 | 业务库 `SELECT/INSERT/UPDATE/DELETE` + 执行受限过程 | **不给业务快照/根表的直接 UPDATE 权限**：v2 §12 要求 worker 只能通过受限写入过程提交候选，这是数据库层的强制点，不是代码约定 |
| 备份账号 | `SELECT, LOCK TABLES, RELOAD, REPLICATION CLIENT, SHOW VIEW, EVENT, TRIGGER` | 只读 |
| 迁移账号 | DDL 权限 | 只在执行迁移时使用 |

应用账号与 worker 账号是否拆分、受限过程如何授权，取决于 tracer 中受限写入过程的实现（ORM 已由 ADR-0005 选定为 Drizzle），实施时在此补充实际授权语句。

#### 2026-09-04 现状

只建了 `hbecho_app`（镶入 `MYSQL_USER`/`MYSQL_PASSWORD` 由 MySQL 官方镜像启动时自动创建），权限是官方镜像的默认行为：`GRANT ALL PRIVILEGES ON \`hbecho\`.*`（不是 `*.*`，已用 `SHOW GRANTS` 验证）。**尚未拆分应用账号与 worker 账号、尚未建备份账号/迁移账号**——这是刻意的，因为受限写入过程的设计还没定，拆分账号前先要有过程可以授权给它。等 ORM/迁移工具选定、受限写入过程实现后回来补建。

---

## 7. OSS

hbecho 的 OSS 比 hbdam 复杂，因为它要同时承载**三种保留期完全不同**的对象。v2 §11.1 用 `object_category ∈ {ods, media, temp}` 和复合外键在数据库层强制用途隔离；OSS 侧要有对应的物理隔离，否则数据库拦得住的错误会在存储层发生。

### 7.1 三类对象的语义

| 类别 | 内容 | 保留期 | 谁负责删除 |
|---|---|---|---|
| `ods` | 供应商请求 body、响应 body、传输错误原文（压缩后） | **一年** | **应用**，按 payload → call → task → 无引用对象元数据的显式顺序（v2 §3） |
| `media` | 头像、背景图、封面、图文图片、视频、音频 | **长期，永不自动过期** | 仅在明确业务决定下人工操作 |
| `temp` | 媒资下载中转、未验证字节 | 短期（建议 1–7 天） | OSS 生命周期规则 |

### 7.2 桶拓扑：建议三桶分离

**建议（待确认）**：`ods`、`media`、`temp` 各用独立 Bucket，备份再单独一个。

理由是保留期方向相反且不可混淆。ODS 必须在一年后消失（这是对外的保留承诺），正式媒资必须长期存在。如果放在同一个桶里靠前缀区分，那么"删除 ODS"这件事就变成了一条按前缀匹配的生命周期规则或批量删除操作——**前缀写错一次，删掉的是长期媒资，而且没有任何东西能挡住它**。桶级隔离让"这个桶里的东西永不自动删除"成为一条可以验证的物理事实（§13.3 就是验证它）。

代价是三套 RAM 策略、三份配置、跨桶去重不可行（但 `media_assets` 按 SHA-256 去重本来就只在 media 桶内进行，不受影响）。

这条属于总纲 §12.2 列的"具体 OSS 厂商和部署拓扑"未决项。**若已经建好单桶，在写入第一个对象之前决定**，之后再改要同时搬对象和改 `oss_objects` 历史行。

### 7.3 创建 Bucket 的关键选项

| 字段 | 填什么 | 为什么 |
|---|---|---|
| **地域** | **与 ECS 完全同地域** | 最关键的一项。选错要重建，且已上传数据得跨区复制 |
| 读写权限 | **私有** | v2 §11.1：数据库不保存长期可访问 URL，全部走签名访问 |
| 服务端加密 | **开启**（OSS 完全托管即可） | v2 §11.1 明确要求启用服务端加密 |
| 同城冗余（ZRS） | ODS/temp 关闭；media `<待确认>` | ODS 一年后消失且可由供应商侧重放的可能性极低，但它是审计证据；media 是长期资产。ZRS 加价换可用区级冗余，按预算定 |
| 版本控制 | **不开启** | 见 §7.4，这是一个陷阱 |
| 实时日志查询 | 可开 | 便于排查访问与计费异常 |
| 阻止公共访问 | **保持开启** | 见下方说明 |

> **2025-10-13 起，通过 API / SDK / `ossutil` 新建的桶默认开启「阻止公共访问」**（按地域分批生效）。这对 hbecho 是好事——我们要的就是私有桶，等于多了一层默认保护，§13.4 的私有性验证会直接通过。要注意的是：开启状态下无法设置公共读 ACL 或允许公共访问的 Bucket Policy，所以**如果将来有任何"公开某个前缀"的需求，会被这一层挡住**，届时要显式关闭它——而关闭之前应该先问清楚为什么不能用签名 URL。

> "地域：中国内地通用"是**资源包的适用范围**，不是 Bucket 的位置。Bucket 建在哪是创建时单独选的。误建在别的地域，资源包照样抵扣存储费，但 ECS 读写它就变成跨地域公网流量，全额计费且无任何提示。

### 7.4 两个生命周期陷阱

**陷阱一：生命周期规则不能抢在应用清理之前。**

v2 §3 规定 ODS 到期按"远端原始字节 → payload → call → task → 无引用对象元数据"的显式顺序清理，**应用是权威删除方**。如果同时给 ODS 桶配一条"365 天后删除"的生命周期规则，OSS 可能先删掉字节，而数据库里 `oss_objects.status` 仍是 available、`ods_payloads` 仍在——于是系统认为证据在，实际取不到。

做法：
- ODS 桶的过期规则**只作兜底**，天数要明显长于应用清理窗口（建议 `400` 天而不是 365）；
- 兜底规则一旦真的删到东西，说明应用清理器坏了，这本身是需要告警的事件；
- **`media` 桶不配任何过期规则**。

**陷阱二：开启版本控制会让"删除"变成假删除。**

版本控制开启后，删除对象只是写一个删除标记，历史版本继续存在并继续计费。两个后果：一是 ODS 一年保留承诺被静默破坏（字节还能取回来）；二是账单里出现查不到来源的存储量。

`oss_objects.object_version` 字段的存在只是为了在启用版本控制时能精确定位对象，不是在要求启用它。正式媒资按 SHA-256 内容寻址，同一 key 不会被有意义地覆盖，版本控制对它也没有价值。

**结论：不开启版本控制。** 若将来出于其他原因必须开启，生命周期规则必须同时清理非当前版本，并在 §17 记录这次决定和它对保留承诺的影响。

### 7.5 必配的生命周期规则

| 桶 | 规则 | 值 |
|---|---|---|
| 全部桶 | 清理未完成的分片上传（碎片） | `7` 天 |
| `ods` | 兜底过期删除 | `400` 天 |
| `temp` | 过期删除 | `<待确认：1–7>` 天 |
| `media` | **无过期规则** | — |
| 备份 | 过期删除 | `<待填写：与 §11 备份周期一致>` |

碎片清理是刚需不是可选项：媒资下载和大对象上传中断都会留下未完成分片，它们**在控制台文件列表里看不到但照常计费**，不配这条会出现账单莫名增长且找不到原因。

### 7.6 endpoint：最贵的一个坑，以及 hbecho 的强化做法

同地域下从 ECS 访问 OSS **公网** endpoint 也只有几毫秒，因为物理上仍走阿里云内部骨干。也就是说 **`-internal` 漏写不会有任何报错、任何变慢**，只会在月底账单上按公网流出全额计费。

hbdam 的对策是"endpoint 集中管理 + code review 必查"。hbecho 升级为**启动期自检**：

```
应用启动时：
  若检测到运行在 ECS 上（能访问 100.100.100.200 元数据服务）
  且 OSS endpoint 不含 "-internal"
  → 直接启动失败并输出明确原因
```

人工 review 会漏，断言不会。这条自检要写进应用启动检查，而不是只写在文档里。

顺带把流量方向说清楚，避免日后误判成本：

| 路径 | 计费 |
|---|---|
| 内容平台源站 → ECS（媒资下载） | ECS 公网**入**流量，免费 |
| ECS → OSS（走 `-internal`） | 内网，免费 |
| ECS → OSS（走公网 endpoint） | **公网流出，全额计费**（这就是上面那个坑） |
| OSS → 最终用户（签名 URL 直连） | **OSS 公网流出，计费**。这是正常且预期的路径，用签名 URL 直连可以避免占用 ECS 带宽 |

### 7.7 实例 RAM 角色（免长期 AccessKey）

**不要把 OSS AccessKey 写进服务器配置文件。** 长期密钥落盘后，机器被入侵或配置误提交都会泄露一把可长期使用的凭证。实例 RAM 角色的做法是：代码向本机元数据地址取**临时凭证**（自动轮转、有有效期），机器上不存长期密钥。

权限策略按桶分开写，**不要用 `AliyunOSSFullAccess`**（那个给的是账号下所有桶的全部权限，包括删桶）。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:GetObject", "oss:PutObject", "oss:DeleteObject",
        "oss:ListObjects", "oss:GetObjectMeta",
        "oss:AbortMultipartUpload", "oss:ListParts"
      ],
      "Resource": [
        "acs:oss:*:*:<ODS桶>", "acs:oss:*:*:<ODS桶>/*",
        "acs:oss:*:*:<TEMP桶>", "acs:oss:*:*:<TEMP桶>/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "oss:GetObject", "oss:PutObject",
        "oss:ListObjects", "oss:GetObjectMeta",
        "oss:AbortMultipartUpload", "oss:ListParts"
      ],
      "Resource": [
        "acs:oss:*:*:<MEDIA桶>", "acs:oss:*:*:<MEDIA桶>/*"
      ]
    }
  ]
}
```

注意第二条**不含 `oss:DeleteObject`**。正式媒资长期保留，应用没有删它的业务动作；不给这个权限，"代码 bug 删掉长期媒资"这条故障路径就被物理堵死了。需要人工清理时用另一个具备删除权限的身份单次操作。

#### 2026-09-03 已完成

| 项 | 值 |
|---|---|
| 权限策略 | `hbecho-oss-rw`（自定义） |
| 角色 | `hbecho-ecs-role`，ARN `acs:ram::1241086349153033:role/hbecho-ecs-role` |
| 绑定 | 已绑到 `i-2zef8qpi1d2mldntjgrv`，立即生效未重启 |
| 服务器端工具 | `ossutil 2.1.2` 装在 `/usr/local/bin/ossutil`，**未配置任何 AccessKey** |

策略按桶分三段，刻意让权限不对称：

| 桶 | 读 | 写 | 删 | 理由 |
|---|---|---|---|---|
| `hbecho-ods` | ✅ | ✅ | ✅ | 应用是一年期清理的权威删除方 |
| `hbecho-temp` | ✅ | ✅ | ✅ | 中转对象用完即删 |
| `hbecho-media` | ✅ | ✅ | ❌ | **正式媒资长期保留，应用没有删它的业务动作** |
| `hbecho-backup` | ✅ | ✅ | ❌ | 备份由 OSS 生命周期过期，不由应用删 |

不给 media/backup 删除权限，"代码 bug 删掉长期资产"这条故障路径就被物理堵死了。需要人工清理时用 `hbecho-setup` 身份单次操作。

#### 实测验证

```bash
# ① 临时凭证
workbench exec -i i-2zef8qpi1d2mldntjgrv -c \
  'curl -s http://100.100.100.200/latest/meta-data/ram/security-credentials/hbecho-ecs-role'
```

返回 `AccessKeyId: STS.NXoY…`、`SecurityToken` 非空、`Expiration: 2026-09-03T15:51:49Z`、`Code: Success`。**`STS.` 前缀加上 `Expiration` 就是临时凭证的标志。**

```bash
# ② 权限边界（服务器上不配任何 AccessKey）
ossutil --endpoint oss-cn-beijing-internal.aliyuncs.com --region cn-beijing \
        --mode EcsRamRole cp /tmp/probe.txt oss://hbecho-ods/probe.txt
```

四桶逐一实测读/写/删，结果与上表**完全一致**：ods 与 temp 三项全通，media 与 backup 的删除被拒绝。

> ⚠️ `ossutil` 的 `EcsRamRole` 模式**不接受 `--ecs-role-name` 参数**（会报 `unknown flag`），它自己从元数据服务发现绑定的角色。写了那个参数会导致所有操作失败，看起来像权限问题，实际是参数错误。排查时先把命令跑一次看真实报错，不要只看成功/失败。

各语言 SDK 都支持"实例 RAM 角色"凭证提供者，配置角色名即可，SDK 负责取凭证和过期刷新。**代码里不出现任何 AccessKey。**

#### 踩到的两个授权坑

绑定角色到实例连续失败两次，都是隐式拒绝，值得记下来：

| 尝试 | 报错 | 原因 |
|---|---|---|
| `ecs:AttachInstanceRamRole` 限定实例 ARN | `Forbidden.RAM` / `ImplicitDeny` | **该 action 不支持资源级授权**，必须 `Resource: "*"`。与 `ecs-workbench` 同一类问题（§3.5） |
| 加了 `ram:PassRole` 并限定角色 ARN | `InvalidUser.PassRoleForbidden` | `ram:PassRole` 的资源级 ARN 同样不匹配。官方写法是 `Resource: "*"` + `Condition: acs:Service = ecs.aliyuncs.com` |

最终 `hbecho-setup-buildout` 走到 v5 才成功。**收紧点转移到了 `ram:PassRole` 的 Condition**——它限制"只能把角色传给 ECS 服务"，而不是靠 Resource 限制。

这已经是第三次遇到同一类问题（`ecs-workbench`、`AttachInstanceRamRole`、`PassRole`）。**规律：阿里云有相当一部分 action 不支持资源级授权，写了 ARN 会得到隐式拒绝而不是明确报错。** 遇到 `ImplicitDeny` 时，先把 Resource 放开到 `*` 验证权限链是否通，再找可用的 Condition 来收紧。

### 7.8 容量与成本预期

下面是**量级估算，不是实测**，用于设定告警阈值和判断异常增长，实际值要在跑起来后复测替换。

按 6,000 账号、每周两次同步（v2 §1.3 的参考规模）：

| 项 | 估算 | 假设 |
|---|---|---|
| ProviderCall | 每周约 1.2–2 万次，年约 60–100 万次 | 每账号每次含主页 + 列表页，详情与评论按规则圈定 |
| ODS 存储 | 年约**几十 GB** | 压缩后平均每次调用几十 KB |
| 媒资（头像/背景/封面） | 年约**百 GB 量级** | 按 SHA-256 去重，只有变化的才产生新资产 |
| 媒资（视频/音频） | **不可估，取决于规则圈定范围** | 这是唯一可能失控的一项 |

结论：**视频归档范围是 OSS 成本的主要杠杆。** 规则引擎扩大圈定范围之前，先按"新增内容数 × 平均体积"估一遍再动手；这个动作属于成本守卫（总纲 §8.2），不能在规则配置界面上随手放开。

---

### 7.9 学习平台上线清单（g-learning-min，2026-11-11）

| # | 事项 | 现状 |
|---|---|---|
| 1 | `hbecho-course` 桶 CORS | ✅ 2026-11-11 已配：`https://echo.hbmarketer.com`，PUT / GET / HEAD，头 `Content-Type`，暴露 `ETag`（真实 Chrome 直传验证通过）。**新增域名（例如正式生产域名）要同步追加来源** |
| 2 | VOD 存储桶 CORS | ✅ 无需配置：归 VOD 服务所有，实测已放行浏览器分片上传 |
| 3 | 运行期 RAM：`hbecho-ecs-role` 的 VOD 动作 | ✅ 2026-11-11 建 `hbecho-vod-runtime`（9 个动作，见 ADR-0007 补记）并挂到角色；在测试 ECS 上用实例角色实测放行 |
| 4 | 环境变量（写入 `/data/app/web.env`，root 600）：`HBECHO_LEARNING_CREDENTIALS=ecs_role`、`HBECHO_COURSE_OSS_REGION=cn-beijing`、`HBECHO_PLAYER_LICENSE_DOMAIN` / `_KEY`（见 `.env.example`） | ⏳ 随首次部署（本分支合并后）。**不要**设 `OSS_*` 的回退 |
| 5 | `learning-worker` 进程 | ⏳ 随首次部署：compose 增加服务，见 §10.3「学习平台 worker」 |
| 6 | 迁移：`0009_learning_schema`（含 6 张表） | ⏳ 随首次部署。若 `a-activity-plan` 先合并，本迁移改名为下一个序号 |
| 7 | Aliplayer License（与页面域名绑定） | ⏳ 控制台为 `echo.hbmarketer.com` 申请，填入第 4 项；未申请时本机 localhost 可播，线上是否放行**未验证** |
| 8 | 标签：上线前超管先建标签，否则无法保存任何课程 | ⏳ 超管 |

真实验证入口（人工，需要批准，不在 CI）：`HBECHO_LEARNING_SMOKE=approved pnpm learning-smoke`（真实桶，33 字节，用完即删）；`HBECHO_LEARNING_SMOKE_VOD=approved pnpm learning-smoke-vod`（真实 VOD，3 秒 MP4，需 ffmpeg，用完即删）。

## 8. 密钥与配置管理

### 8.1 当前工作区的两个真实风险

这两项是我在本工作区实际检查后确认的事实，不是假设：

| 位置 | 情况 | 状态 |
|---|---|---|
| `./.env` | 原本是 `AiMaster接口API Key：sk-…`（全角冒号），不是合法 dotenv 格式，被 5 个探针脚本用正则 `sk-[A-Za-z0-9]+` 扫出来使用 | ✅ **2026-09-03 已处理**：改为标准 `AIMASTER_API_KEY=`，文件权限 600；5 个脚本改为按键名读取；`.gitignore` 已忽略 `.env` |
| `HBECHO设计方案/archive/legacy/项目历史文档/旧项目沉淀文档/settings.local.json` | 19 行含 `password`，来自旧项目 `.claude/settings.local.json` | ✅ 已确认**不是 hbecho 的凭证**，与本项目无关，不需要轮换。仍由 `.gitignore` 忽略，不随本仓库提交 |

### 8.2 AI Master 付费调用开关

`AIMASTER_ENABLED` 在本机 `.env` 里**默认 `true`**（2026-09-03 决定）。理由是单人开发、需要频繁手工验证供应商接口，默认关会让每次探针都多一步；开关的实际定位是**止损开关**，而不是准入门槛：怀疑重试风暴或额度异常时改成 `false`，所有付费调用立刻断掉。

作用范围必须说清楚，否则会和技术基线冲突：

| 范围 | 策略 |
|---|---|
| `aimaster接口文档/scripts/` 下的手工探针 | 由 `AIMASTER_ENABLED` 控制，默认放行 |
| 未来的自动化测试套件 | **必须默认离线**（fixture / fake transport / fake OSS），且不得依赖这个开关放行真实调用 |
| CI | **禁止任何真实付费调用**，无论开关值 |

也就是说，技术基线"默认测试离线、禁止 CI 付费调用"这条没有被放宽——放宽的只是手工探针脚本，而它本来就是人工触发、人工看结果的工具。测试套件建起来时要用独立机制（fixture transport + network denied）保证离线，不是复用这个环境变量。

### 8.3 AI Master key 的现状与建议

现在 `.env` 里是一把**仍在使用中的真实 key**，此前以明文形式存在于一个非标准格式文件里、被正则扫描使用过。key 本身没有外泄证据，但两点值得处理：

1. **正式接入前轮换一次**。理由不是"已经泄露"，而是这把 key 经历过一段管理不规范的时期（明文、非法格式、多个脚本各自扫描），轮换是把它重新纳入受控状态的最低成本做法。轮换后按 §8.6 记一行。
2. **生产不复用这把 key**。开发探针和生产同步共用一把 key 时，配额、计费和限流混在一起，出问题无法归因。供应商支持多 key 时申请分开。

### 8.4 密钥分级

| 密钥 | 类型 | 存放方式 |
|---|---|---|
| OSS 访问 | 临时凭证 | 实例 RAM 角色，**机器上不存**（§7.7） |
| OSS 访问（本机 smoke） | 长期密钥（临时） | 仓库根 `.env`（权限 `600`、已被 `.gitignore` 忽略）。**2026-11-04 决策（liuxuekui）：** 先用 `hbecho-setup` 的 AccessKey 做本机 smoke；~~用完删除该 AK 并清空这两个变量~~（**2026-11-04 由 liuxuekui 修订：AK 保留在 `.env`，后续还会用到**；以后可换成只限 `hbecho-ods` 的 RAM 用户）；服务器侧仍只走实例角色，不受影响 |
| AI Master API Key | 长期密钥（供应商只提供这一种） | `/data/app/.env`，权限 `600`，owner root，不进 git |
| MySQL 应用账号密码 | 长期密钥 | 同上 |
| SSH 私钥 | 长期密钥 | 只在本机 `~/.ssh/`，不进服务器、不进 git |
| Git 部署密钥 | 长期密钥 | 服务器 `~/.ssh/`，**只读权限**（§9.5） |

### 8.5 `.env` 约定

**两份 `.env`，互不同步：**

| 位置 | 用途 | 状态 |
|---|---|---|
| 仓库根 `./.env` | 本机开发与探针脚本 | ✅ 已按标准格式创建（权限 600，已被 `.gitignore` 忽略） |
| 服务器 `/data/app/.env` | 测试运行时（当前无生产） | `<待创建>` |

服务器上的那份手工创建，不随部署覆盖：

```bash
install -m 600 -o root -g root /dev/null /data/app/.env
```

键名模板（框架未定，键名以确认过的事实为准，其余留占位）：

```ini
# ── AI Master（供应商适配层）────────────────────────
AIMASTER_BASE_URL=https://openapi.fieldshortcut.com
AIMASTER_API_KEY=<从密码管理器取>
# 成本硬上限与人工止损开关（§12.4）
AIMASTER_ENABLED=false
AIMASTER_MAX_CALLS_PER_RUN=<待定>

# ── MySQL ─────────────────────────────────────────
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=<待填写>
MYSQL_USER=<待填写>
MYSQL_PASSWORD=<从密码管理器取>

# ── OSS（服务器：不含任何 AccessKey）────────────────
OSS_REGION=<待填写>
OSS_ENDPOINT=oss-<region>-internal.aliyuncs.com
OSS_RAM_ROLE=<待填写>
OSS_BUCKET_ODS=<待填写>
OSS_BUCKET_MEDIA=<待填写>
OSS_BUCKET_TEMP=<待填写>

# ── OSS（仅仓库根 .env 的本机 smoke；服务器不放）──────
# 2026-11-04 起：本机没有实例元数据，用不了 hbecho-ecs-role（信任策略只允许 ecs.aliyuncs.com）。
# 先用 hbecho-setup 的 AK 顶替（2026-11-04 liuxuekui 修订：原"smoke 跑完即删除"作废，AK 保留在 .env，后续还会用到；
# 以后可换成只限 hbecho-ods 的 RAM 用户）。键名由 src/modules/smoke/secrets.ts 读取，
# 缺任何一个都在这构造 transport / OSS 之前失败，错误只报变量名。
OSS_ACCESS_KEY_ID=<从密码管理器取>
OSS_ACCESS_KEY_SECRET=<从密码管理器取>
# 本机走公网 endpoint（内网 endpoint 只对 ECS 有效）
OSS_ENDPOINT=oss-<region>.aliyuncs.com

# ── 本机 smoke 的数据库（pnpm smoke run 必填）──────
# 2026-11-04 决策（liuxuekui）：用本机专用持久库 hbecho_smoke，容器 hbecho-smoke-mysql（127.0.0.1:3307）。
# 与 *_test 一次性库的区别：smoke 的批次、ProviderCall 与 ODS 引用要留到复查，所以不 --rm，也不在跑前 DROP。
# 重建命令（MySQL 8.4；--skip-log-bin 是必需的——binlog 开启时非 SUPER 用户建不了迁移里的触发器）：
#   docker run -d --name hbecho-smoke-mysql -e MYSQL_ROOT_PASSWORD=<随机> -e MYSQL_DATABASE=hbecho_smoke \
#     -e MYSQL_USER=hbecho -e MYSQL_PASSWORD=<随机> -p 127.0.0.1:3307:3306 \
#     mysql:8.4 --default-time-zone=+00:00 --skip-log-bin
#   node --env-file=.env --import tsx src/db/migrate.ts
HBECHO_DATABASE_URL=mysql://hbecho:<口令>@127.0.0.1:3307/hbecho_smoke
```

`AIMASTER_ENABLED` 默认 `false` 是刻意的：默认测试必须离线、必须用 fixture/fake transport/fake OSS，**禁止 CI 或普通测试发起真实付费调用**。真实 smoke 需要人工批准、显式开关、固定预算和审计摘要。开关默认关，把"忘记关"变成"忘记开"。

### 8.6 轮换记录

任何密钥轮换都在这里追加一行，并同步更新 §17。

| 日期 | 密钥 | 原因 | 操作人 |
|---|---|---|---|
| `<待填写>` | | | |

日志与错误上报中**不得出现** API Key、Authorization、Cookie（v2 §9.5 明确 secret 不入库）。tracer 的 status 输出也有逐字段 redaction 要求，运维排查时同样不要把带密钥的 curl 完整命令贴进工单或聊天记录。

---

## 9. Git

> 当前状态：**hbecho 工作区还不是 git 仓库**（已确认 `git status` 返回 not a repository）。本章是从零建立仓库的步骤。

### 9.1 顺序与当前进度

```
1. 写 .gitignore                          ✅ 2026-09-03
2. 装 pre-commit 密钥扫描钩子              ✅ 2026-09-03
3. 核对工作区里是否还有未被忽略的密钥        ✅ 2026-09-03
4. git init                               ✅ 2026-09-03（main 分支）
5. 首次提交前逐行审查暂存内容               ✅ 86 个文件 / 0.2 MB
6. 首次提交                                ✅ 66caf30
7. 建远端（私有仓库）并推送                 ⬜ 见 §9.7
```

第 1 步必须在 `git init` 之前。一旦密钥进了任何一次 commit，即使下一次 commit 删掉它，它仍在历史里；推送出去之后唯一有效的补救是**轮换密钥**。

首次提交前的实际审查结果：

| 检查项 | 结果 |
|---|---|
| `.env` / `服务器密码` / `settings.local.json` | 全部被忽略 ✓ |
| `临时传递用的文件/*.csv`（含真实 RAM AccessKey） | 被 `*.csv` 规则忽略 ✓ |
| 暂存内容密钥特征扫描 | 唯一命中是 `.env.example` 里的 `sk-xxxx…` 占位符 ✓ |
| 11 位手机号形态 | 359 行命中，全部是 raw3 fixture 里的 10 位 epoch 与内容 ID 数字片段，非真实手机号 ✓ |
| 体积 | 86 文件 / 0.2 MB，无需 LFS |

> ⚠️ `临时传递用的文件/` 下两个 CSV 含**两个 RAM 用户的真实 AccessKey Secret**。它们已被 gitignore 排除，但仍以明文躺在工作区。凭证已经写入 `~/.workbench/config.json` 与 `~/.aliyun/config.json`，**这两个 CSV 可以删掉了**。

### 9.2 `.gitignore`

已在仓库根创建（本次同时完成）。要点：

- `.env`、`.env.*` 全部忽略，只保留 `.env.example`；
- `settings.local.json` 与 `.claude/`、`.vscode/` 等本地配置忽略；
- `*.pem`、`*.key`、`id_rsa*`、`*_ed25519*` 等凭证文件忽略；
- `.DS_Store`、`node_modules/`、`__pycache__/`、构建产物忽略。

**必须进仓库的东西**（别误加进忽略规则）：

| 内容 | 理由 |
|---|---|
| `aimaster接口文档/测试结果/raw3/*.json` | 实测证据，是权威矩阵里的 evidence 层，离线 fixture 依赖它 |
| `HBECHO设计方案/`、`CONTEXT.md`、`.kiro/specs/`、`.kiro/steering/` | 设计基线本身 |
| 迁移脚本、DDL | 数据库结构的唯一真相源 |
| `.env.example` | 键名清单（不含真实值） |

### 9.3 仓库必须是私有的

hbecho 仓库里有甲方身份、组织结构、专员手机号语义、门店编码口径，以及 AI Master 的接口合同文档。**公开仓库等于把这些一次性交出去。**

远端配置建议：一个权威远端（如阿里云 Codeup）+ 可选镜像，**两个都必须是私有**。旧项目那种 `git push all main` 一次推两个平台的写法可以继承，但它同时也是泄露传播最快的路径——加远端时确认可见性，别把镜像建成 public。

```bash
git remote add origin <私有仓库地址>
# 可选镜像
git remote add mirror <另一个私有仓库地址>
git remote add all <私有仓库地址>
git remote set-url --add all <另一个私有仓库地址>
```

### 9.4 分支与提交

- `main` 保持可用状态，**不直接往 `main` 推**；功能在分支上做，合并前自查。
- 提交信息沿用旧项目的前缀约定（成本低、可读性好）：

```
feat:     新增功能
fix:      修复缺陷
docs:     文档更新
refactor: 重构（行为不变）
chore:    配置、依赖、脚本
```

- 涉及设计基线的改动，提交里要一并更新对应文档和 [`HBECHO设计方案/INDEX.md`](../INDEX.md)，不留"代码改了文档没改"的差值。

### 9.5 提交前的密钥自查

钩子已就位：[`.githooks/pre-commit`](../../.githooks/pre-commit)，通过 `git config core.hooksPath .githooks` 启用（放在仓库内而不是 `.git/hooks/`，这样它本身能被版本管理、clone 后一条命令启用）。

要清楚它的定位：**钩子是降低失误率的手段，不是安全边界。**真正的边界是"密钥不写进仓库目录"和"泄露后轮换"。

拦截规则两类：

| 类别 | 覆盖 |
|---|---|
| 文件名 | `.env` 及变体、`settings.local.json`、`*.pem/*.p12/*.pfx`、`id_rsa`/`id_ed25519`/`*_ed25519`、`服务器密码`、`password*.txt` |
| 内容特征 | `sk-…`、`LTAI…`、`BEGIN … PRIVATE KEY`、`AccessKeySecret=` |

白名单：`.env.example` / `.env.sample` 必须能提交（键名模板），示例占位值 `sk-xxxx…`、`<PLACEHOLDER>` 不触发。

四种拦截已逐一实测有效：

```
sk- 密钥内容        ✓ 已拦住
LTAI AccessKey     ✓ 已拦住
私钥头              ✓ 已拦住
.env.production    ✓ 已拦住
.env.example       ✓ 不误拦
```

#### ⚠️ 中文路径会让文件名规则失效

写这个钩子踩到一个坑：`git diff --cached --name-only` 对含非 ASCII 的路径会**转义成八进制并加引号**：

```
"\351\241\271\347\233\256\345\216\206\345\217\262\346\226\207\346\241\243/.../.env.example"
```

结果是以 `$` 结尾的文件名正则全部匹配不上（末尾多了个 `"`），`.env.example` 被误判成凭证文件。修法是取列表时关掉转义：

```bash
staged=$(git -c core.quotepath=false diff --cached --name-only --diff-filter=ACM)
```

**本项目路径大量含中文，任何按文件名匹配的脚本都要加这一项。**

误报时用 `git commit --no-verify` 跳过；确认是真密钥时从暂存区移除并按 §8.6 轮换。

### 9.6 服务器侧凭证

服务器上的 git 凭证用**只读部署密钥**，不要把个人私钥放到服务器上。理由是服务器只需要 `git pull`；给它写权限意味着机器被入侵时攻击者能改代码仓库。

### 9.7 建私有远端仓库

本地已有一个提交，只差远端。你已有 GitHub 与 Codeup 两个平台的私有仓库经验，两者都可以，建议如下。

#### 2026-09-03 实际状态

| 远端 | 状态 |
|---|---|
| GitHub `origin` | ✅ 已建并推送。`git@github.com:ArchMan001/hbecho.git`，Private，匿名访问返回 404 确认 |
| Codeup | ⬜ 创建云效组织受阻，暂缓。原计划权威远端降级为可选镜像 |

原设计倾向 Codeup 作权威远端（服务器、OSS 都在阿里云，`git pull` 走内网更快），但**这不是硬约束**。GitHub SSH 已验证可用（`ssh -T git@github.com` 认证成功），先以它为权威远端不影响任何后续步骤——服务器只读部署密钥、`git pull` 部署流程同样适用于 GitHub。Codeup 排障通过后按下面步骤补建镜像即可，不需要迁移历史。

#### 选哪个作为权威远端（背景参考，非当前决策依据）

| | Codeup（阿里云） | GitHub |
|---|---|---|
| 国内访问速度 | 快 | 正常（非致命慢） |
| 与本项目云资源同厂商 | 是 | 否 |
| 私有仓库 | 免费 | 免费 |
| 生态与协作 | 弱 | 强 |

⚠️ **两个都必须是私有。** 本仓库含甲方身份、组织结构、专员手机号语义、门店编码口径和 AI Master 接口合同。公开等于一次性交出去。旧项目那种 `git push all main` 一次推两个平台的写法可以继承，但它同时也是泄露传播最快的路径——加远端时逐个确认可见性。

#### 步骤一：Codeup 建库（当前受阻，排障后按此操作）

Codeup 挂在云效（云效标准版）之下，建库前必须先建一个云效组织。**遇到创建失败不要换阿里云账号**——组织标识冲突、名称格式、密码强度不达标都会报错，跟账号无关；换账号只会让 ECS 那一整套 RAM 权限重新配一遍，代价远高于排查一个表单错误。常见报错与对策：

| 报错现象 | 对策 |
|---|---|
| 组织标识"已被占用" | 全局唯一，换一个更具体的，如 `hbecho-app`、`<你的域名前缀>-hbecho` |
| 名称格式错误 | 检查首尾有没有多余空格或符号 |
| 密码强度不足 | 需同时含大小写字母、数字、特殊符号中至少 3 种，8 位以上 |
| 提示账号已有组织 | 云效个人模式对同账号的组织数量可能有限制，先查该账号下是否已有组织 |

1. 打开 <https://codeup.aliyun.com>，用同一个阿里云账号登录
2. 「新建代码库」→ 「新建空白代码库」
3. 填写：

| 字段 | 填什么 |
|---|---|
| 代码库名称 | `hbecho` |
| 路径 | `hbecho` |
| 可见性 | **私有**（只有成员可访问） |
| 初始化 README | **不要勾** |
| 初始化 .gitignore / LICENSE | **不要勾** |

三个"不要勾"是因为本地已经有完整的首次提交，远端带初始文件会造成 `unrelated histories` 冲突，还得多做一次 merge。

4. 建好后复制 SSH 地址，形如
   `git@codeup.aliyun.com:<组织标识>/hbecho.git`
5. 加为镜像远端并同步一次：

```bash
cd /Users/liuxuekui/Documents/hbecho
git remote add codeup git@codeup.aliyun.com:<组织标识>/hbecho.git
# 用 SSH 密钥前先确认能连通（若提示公钥被拒，去 Codeup 个人设置 → SSH 公钥 → 添加 ~/.ssh/id_ed25519.pub）
ssh -T git@codeup.aliyun.com
git push codeup main
```

（可选）之后一条命令双推：

```bash
git remote add all git@github.com:ArchMan001/hbecho.git
git remote set-url --add all git@codeup.aliyun.com:<组织标识>/hbecho.git
git push all main
```

#### 步骤二：服务器只读部署密钥

服务器只需要 `git pull`，所以给它一把**只读**密钥，而不是你的个人密钥——泄露爆炸半径从"能改仓库"降到"只能看代码"。

```bash
# ① 在服务器上生成专用密钥（无口令，供自动化使用）
workbench exec -i i-2zef8qpi1d2mldntjgrv -c '
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f /root/.ssh/github_deploy ] || ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N "" -C "hbecho-server-deploy"
cat /root/.ssh/github_deploy.pub
'
```

② 把输出的公钥加到 GitHub：仓库 `hbecho` → Settings → Deploy keys → Add deploy key，**不勾 "Allow write access"**（默认就是只读）。

③ 服务器上配 SSH 别名并 clone：

```bash
workbench exec -i i-2zef8qpi1d2mldntjgrv -c '
cat >> /root/.ssh/config <<EOF

Host codeup.aliyun.com
    HostName github.com
    User git
    IdentityFile /root/.ssh/github_deploy
    IdentitiesOnly yes
EOF
chmod 600 /root/.ssh/config
ssh -T -o StrictHostKeyChecking=accept-new git@github.com
'
```

④ clone 到部署目录：

```bash
workbench exec -i i-2zef8qpi1d2mldntjgrv -c \
  'git clone git@github.com:ArchMan001/hbecho.git /data/app/hbecho && \
   cd /data/app/hbecho && git config core.hooksPath .githooks && git log --oneline -1'
```

> Codeup 排障通过并补建镜像后，若想把服务器切到走 Codeup 拉取，重复本节生成一把 `codeup_deploy` 密钥、加到 Codeup 部署密钥、改 `~/.ssh/config` 的 Host 即可，`/data/app/hbecho` 目录不用重建。

#### 2026-09-03 执行记录

服务器上先补装了 `git`（Alinux4 基础镜像不含）：`dnf install -y git` → `2.47.3`。

部署密钥指纹：`SHA256:8V8ryhd5I1rX0quT7Ep/JkOMwvc2ffVy1o9L4L+w9wU`。

clone 成功后做了一次**真实推送测试**以确认只读设置真的生效，而不是只看 GitHub 页面上的勾选状态：

```
git commit -m "test: 验证部署密钥只读"
git push origin main
→ ERROR: The key you are authenticating with has been marked as read only.
```

GitHub 明确拒绝，证明部署密钥的只读限制在服务端强制生效，不是仅前端隐藏了推送按钮。测试 commit 未能推送，`git reset --hard origin/main` 清理干净，服务器最终停在 `741bb16`，与远端一致。

> ⚠️ 排查记录：这次测试的 `git commit` 因为服务器上没配 `user.name`/`user.email` 而先报了一次 `fatal: unable to auto-detect email address`——**这个报错和只读测试无关**，只是本地提交失败。第一次 `reset --hard HEAD~1` 因此撤过了头（把本该是"空操作"的位置当成了"有一个测试提交"），从 `741bb16` 退到了 `66caf30`。用 `git reset --hard origin/main` 而不是 `HEAD~1` 重新对齐才是正确做法。**教训：`HEAD~1` 假设"上一次提交确实發生过"，验证失败路径时更可靠的是直接对齐到已知的远端引用。**

#### 推送后立刻做的一件事

确认远端历史里没有密钥：

```bash
git log --all --name-only --pretty=format: | sort -u | grep -E '(^|/)\.env$|服务器密码|settings\.local\.json' || echo clean
```

期望输出 `clean`。命中的话，补救是**轮换密钥**，改历史只是清理不是补救。

### 9.6 服务器 clone 后的补齐步骤

```bash
# 1. 拉代码（部署密钥，只读）
git clone <私有仓库地址> /data/app/hbecho
cd /data/app/hbecho

# 2. 放置 .env（不在仓库里，手工创建，见 §8.4）
install -m 600 /dev/null /data/app/.env
vi /data/app/.env

# 3. 后续步骤取决于最终选定的框架/依赖管理/迁移工具（未冻结）
#    确定后在此补充，并同步 §10.3
```

---

## 10. 部署

> **完整流程见 [`dev-test-deploy-workflow.md`](dev-test-deploy-workflow.md)**：verify → GitHub Actions → 测试 ECS → 生产 ECS，含当前状态、过渡期硬规则与验收方法。本章只保留部署契约、部署后必检与回滚约束。

### 10.1 现在还不能冻结什么

应用框架、ORM/迁移工具、队列实现都是**未冻结**的决定（总纲 §12.2、`tech` 基线）。因此本章**不定义容器编排拓扑**，只定义部署契约——即无论最终选什么框架，部署都必须满足的条件。

选型确定后，在 §10.3 补充实际的 compose 文件路径、服务清单和启动命令，并在 §17 记一行。

### 10.2 部署契约

| # | 约束 | 理由 |
|---|---|---|
| 1 | 应用只通过 CI 构建、推 ACR 的镜像部署（标签 = git 短 sha），服务器不构建、不用 tar/scp 覆盖代码 | 覆盖式部署会留下删除不掉的旧文件，且解包损坏无法察觉；同一个标签在测试机验证过才会上线（2026-11-11 起；此前这一条写的是 `git pull`） |
| 2 | 每次部署记录 commit SHA，服务器可回答"当前跑的是哪个提交" | 没有这条，线上行为和代码对不上时无法排查 |
| 3 | 所有配置从环境变量读，代码里不出现环境相关常量 | endpoint、桶名、开关都要能在不改代码的情况下切换 |
| 4 | 所有业务端口绑 `127.0.0.1`，对外只经反代 | 减少暴露面 |
| 5 | 数据库结构变更只走版本化迁移脚本，**禁止手工 `ALTER`** | v2 的语义大量落在 CHECK 与唯一键上，手改表会让线上结构与设计文档静默分叉 |
| 6 | 迁移脚本必须可在空库上从头执行一遍得到相同结构 | 这是"结构以仓库为准"的验证方式 |
| 7 | `/data/app/web.env`、`/data/app/migrate.env`（root 600）不在仓库里，也不随部署覆盖 | 密钥与代码分离（测试 ECS 的实际文件名；`/data/app/.env` 现在只放 `WEB_TAG`） |
| 8 | 部署不触发任何真实付费供应商调用 | `AIMASTER_ENABLED` 默认 `false`（§8.4） |

### 10.3 部署流程（测试 ECS，2026-11-11 实际跑通的步骤；一律经 Workbench，不用 SSH）
```bash
# 0. 本机：确认要发布的提交已推送、CI 的 image job 成功（run 里有「已推送 …:<sha>」）
git rev-parse --short=12 HEAD
# 1. 服务器：拉同一个标签（内网域名；pull 账号已登录，§3.7）
workbench exec -P hbecho -i i-2zef8qpi1d2mldntjgrv -c 'docker pull hbecho-registry-registry-vpc.cn-beijing.cr.aliyuncs.com/hbecho/app:<sha>'
# 2. 迁移（版本化、可在空库重放；用迁移账号，不用运行账号）
docker run --rm --network app_default --env-file /data/app/migrate.env <镜像> ./node_modules/.bin/tsx src/db/migrate.ts
# 3. 切换标签并启动（/data/app/.env 里只有 WEB_TAG=<sha>）
cd /data/app && echo WEB_TAG=<sha> > .env && docker compose up -d web
# 4. 首个超管（只在空库做一次；运行账号即可）
docker run --rm --network app_default --env-file /data/app/web.env <镜像> ./node_modules/.bin/tsx src/worker/access-main.ts token create
docker run --rm --network app_default --env-file /data/app/web.env <镜像> ./node_modules/.bin/tsx src/worker/access-main.ts bootstrap-superadmin --token <t> --phone <p> --name <n>
# 5. 清理悬空镜像
docker image prune -f
```
容器里**不经过 pnpm / corepack**（corepack 首次运行会去外网下载 pnpm）：直接调用 `./node_modules/.bin/…`。
**镜像分发**：CI（GitHub Actions）经公网域名推送，服务器经内网域名拉取（几十秒，ADR-0016）。GitHub runner → 北京 ACR 的链路本身不慢（2026-11-11 探针：300 MB 不可压缩大文件 32 秒，约 9.4 MB/s，与 hbdam 的 12 MB/s 同量级）；慢的是 docker 对「大量小文件」的单层打包压缩（同样 100 MB 数据拆成 2 万个小文件，推送 54 秒，约 1.85 MB/s），所以 node_modules 这种层首次推送要数分钟；依赖不变时层已在 ACR，推送只要约 30 秒。稳态 CI：`verify` 约 5 分钟 + `image` 约 1.5 分钟。

#### 学习平台 worker（g-learning-min，2026-11-11）
同一个镜像再起一个服务，只换启动命令（镜像里已有 `src/` 和 `tsx`）。**运行账号**即可（只用 SELECT / INSERT / UPDATE / DELETE）：
```yaml
  learning-worker:
    image: hbecho-registry-registry-vpc.cn-beijing.cr.aliyuncs.com/hbecho/app:${WEB_TAG}
    container_name: hbecho-learning-worker
    restart: unless-stopped
    env_file: /data/app/web.env
    command: ["./node_modules/.bin/tsx", "src/worker/learning-main.ts"]
    depends_on: [mysql]
```
每分钟一轮（转码回填、待删除媒体重试），每小时加一轮归档与残渣清理；日志在容器 stderr（JSON）。有步骤失败时日志级别是 error，消息 `learning_maintenance_errors`——**这是 VOD / OSS 不可用的唯一信号，需要接日志告警**。回滚 = 改回上一个 `WEB_TAG`。

#### 同步 worker（sync-worker，2026-11-13 增补）

名单「确认写入」只落 `resolve_account` 根任务；真正调 AI Master 的是 sync worker。**没有这个进程，确认后的账号会一直 pending**。它在 production 运行，启动守卫 `assertWorkerCanRun` 要求至少一个已批准的 capability（2026-11-12 起抖音 / 小红书已批准，见 `capability.ts` 的 `PRODUCTION_APPROVAL`）。

```yaml
  sync-worker:
    image: hbecho-registry-registry-vpc.cn-beijing.cr.aliyuncs.com/hbecho/app:${WEB_TAG}
    container_name: hbecho-sync-worker
    restart: unless-stopped
    env_file: /data/app/sync.env          # 独立环境文件：需要 AIMASTER_* 与 OSS 写权限，不复用 web.env
    command: ["./node_modules/.bin/tsx", "src/worker/sync-main.ts", "worker"]   # 缺子命令只会打印用法；常驻必须显式 worker
    depends_on: [mysql]
```

`/data/app/sync.env`（root 600）至少包含：`HBECHO_DATABASE_URL`、`HBECHO_ENV=production`、`AIMASTER_BASE_URL`、`AIMASTER_API_KEY`、`AIMASTER_ENABLED=true`、`OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_REGION` / `OSS_BUCKET_ODS` / `OSS_BUCKET_MEDIA`、`HBECHO_MEDIA_MAX_BYTES`，以及 tracer 的 modes / 并发 / 批次预算配置（键名见 `.env.example`）。**`HBECHO_ENV=test` 会被启动守卫拒绝**。

**预算**：`AIMASTER_ENABLED=true` 后每个 provider 调用都计费；批次上限由 tracer 配置的 `batchBudget`（调用数 / 点数）与 `breaker` 控制，需与批准预算（刘学奎 2026-11-12：上限 1 万元、有效期一年）一致。**回滚**：从 compose 中去掉 `sync-worker` 并 `docker compose up -d`，任务停在 pending，不产生调用。

**2026-11-13 部署状态**：镜像 `6368b94798ef` 已推送 ACR 并在测试 ECS 拉取；`/data/app/sync.env`（root 600）已建，含数据库 URL、`HBECHO_ENV=production`、四个模式（均 synchronous）、并发 / QPS / 熔断 / 批次预算、媒体上限与能力服务地址；`docker-compose.yml` 已追加 `sync-worker`（原文件备份 `/data/backup/docker-compose.yml.bak-20261113`，`docker compose config` 通过）。**未启动**：试运行报 `环境变量 AIMASTER_API_KEY 缺失`，另外还缺 `AIMASTER_BASE_URL`、`OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_REGION` / `OSS_BUCKET_ODS` / `OSS_BUCKET_MEDIA`，以及 Python 能力服务（`HBECHO_CAPABILITY_URL` 指向的 `capability` 容器尚未部署）。这些配好后 `docker compose up -d sync-worker` 即可。

**2026-11-13 启动完成**：sync-worker 已启动并稳定（容器 Up，最近 2 分钟 0 条 `level=50`）。启动时补齐了三项：

1. **`sync_settings` 必须手工初始化**：迁移 `0001` 明确不种入（「由运维显式配置」）。已插入 `settings_id=1`、`Asia/Shanghai`、`schedule_slots=[{"weekday":1,"time":"02:00"}]`、`initial_content_limit=20`、`list_safety_page_limit=5`、`comment_page_limit=5`、`account_resolve_max_attempts=3`、`task_max_attempts=3`、`config_version=1`；
2. **`OSS_ENDPOINT=oss-cn-beijing-internal.aliyuncs.com` 必须写进 sync.env**：不写时 ali-oss 会拼公网域名，维护任务的 `sweep_orphans` 因 DNS 失败；`docker restart` 不会重读 `env_file`，改完要用 `docker compose up -d --no-deps --force-recreate sync-worker`；
3. **sync-worker 的 image 临时固定为 `6368b94798ef`**（含 capability 放行），因为 `/data/app/.env` 的 `WEB_TAG` 仍是 `69595423c6d3`；web 升级后改回 `${WEB_TAG}`。

维护任务已验证成功：`orphans["smoke/ods/"]` 删除 14 个孤儿对象，`failedSteps` 为空。

**2026-11-13 web 与 learning-worker 同步升级**：两者也临时固定到 `6368b94798ef`（含 capability 放行与「将自动加入分公司」页面文案），`docker compose up -d web learning-worker` 完成。验证：`/api/health` 返回 `{"ok":true}`，`/login` 本机 200、公网 200，Next.js Ready。三个服务现在同镜像；`/data/app/.env` 的 `WEB_TAG` 仍是 `69595423c6d3`，升级到新 sha 后把三个服务的 image 改回 `${WEB_TAG}`。

### 10.4 部署后必检

1. 服务健康：`curl -s http://127.0.0.1:3000/api/health` 返回 `{"ok":true}`；公网 `https://echo.hbmarketer.com/login` 200 且页脚有备案号；`/users` 未登录 307 到 `/login`
2. 端口没有意外对外：`ss -tlnp | grep -v 127.0.0.1`（除 22 外不应有公网监听）
3. OSS endpoint 自检通过（§7.6 的启动断言没有被绕过）
4. `AIMASTER_ENABLED` 仍是预期值
5. 磁盘水位：`df -hT /data`

### 10.5 回滚
- **应用**：把 `/data/app/.env` 的 `WEB_TAG` 改回上一个已知好的 sha，`docker compose up -d web`。
- **nginx**：还原 `/data/backup/echo.hbmarketer.com.conf.bak-20261111`（静态占位页）并 `systemctl reload nginx`。
- **数据库**：代码回滚容易，**迁移回滚不容易**。迁移遵守「扩展 → 部署 → 收缩」：能加列不改列，能新增不删除，破坏性变更单独一次上线并提前备份。回滚前先确认目标 sha 对应的结构与当前库结构兼容。

### 10.6 对外开放的前置条件

当前没有生产 ECS；以下条件针对将来的生产环境。测试环境同样不应把业务端口暴露到公网。

⚠️ 在满足以下全部条件之前，**任何服务都不得绑 `0.0.0.0`，安全组不得开放 80/443**：

1. ICP 备案通过（§4.3）；
2. 最小访问控制闭环达成：独立用户身份、可撤销 Session、一次性激活、Capability 到 `resource.action` 的映射、各资源注册 ScopeStrategy（总纲 §8.1）；
3. 手工同步、原始载荷读取、手机号、媒资、导出、下载各有显式权限；
4. HTTPS 证书就绪，反代正确传递 `X-Forwarded-For` / `X-Forwarded-Proto`；
5. 备案号挂在站点底部并链接到 `https://beian.miit.gov.cn`（管局会复查，不挂会被撤销备案）。

第 2、3 条属于 `access-control` Spec 的验收范围，不是运维能替代的。数据底座 tracer 阶段只有内部 service principal，走 SSH 隧道访问即可，**不需要也不应该对外开放**。

### 10.7 `echo.hbmarketer.com` 占位站（2026-11-09）

ICP 备案通过后先挂一个**纯静态**占位页，把域名、证书、反代链路打通；不含任何应用与数据接口。

| 项 | 值 |
|---|---|
| 机器 | `i-2zef8qpi1d2mldntjgrv`（`182.92.223.200`） |
| nginx | 1.30.4；配置 `/etc/nginx/conf.d/echo.hbmarketer.com.conf`（80 跳 443，acme webroot 保留） |
| 页面 | `/var/www/echo/index.html`（静态；页脚含 `鲁ICP备18020147号-6` 并链接工信部） |
| 证书 | Let's Encrypt（`CN=echo.hbmarketer.com`，到 2027-02-07）；venv `/opt/certbot`；续期 crontab 03:17 `certbot renew --deploy-hook "systemctl reload nginx"` |
| 安全组 | `sg-2zeank1y5h8hsyzpqank` 开放 TCP 80 / 443（`0.0.0.0/0`） |
| 验收 | `https://echo.hbmarketer.com/` 200、`http` 301、证书链正常 |

⚠️ **这是对 §10.6 的有限例外**：开放 80/443 只为一个静态页——没有应用进程、没有数据接口、不连 MySQL。**真正上线任何业务服务之前，§10.6 第 2、3 条仍然必须满足**；届时把 `root` / `proxy_pass` 换掉即可，域名与证书不用动。

决策人：liuxuekui，2026-11-09（「先挂 echo 占位页」）。

---

## 11. 备份与恢复

### 11.1 三层备份

| 层 | 内容 | 频率 | 恢复粒度 | 状态 |
|---|---|---|---|---|
| 磁盘快照 | 系统盘 + 数据盘整盘 | 每日北京 03:00，保留 7 天 | 整盘 | ✅ 已配 |
| 逻辑备份 | `mysqldump` 全库 | 每日，保留 30 天 | 库/表/行 | ⬜ 待 MySQL 部署 |
| binlog | 增量 | 持续 | 任意时间点（PITR） | ⬜ 待 MySQL 部署 |

**快照不能替代逻辑备份**：快照是块级的，误删一张表时不会想把整盘回滚到昨天。**逻辑备份也不能替代快照**：系统被改坏时整盘回滚最省事。两者都要有。

#### 自动快照策略（2026-09-03 已配）

| 项 | 值 |
|---|---|
| 策略名 | `hbecho-daily` |
| 策略 ID | `sp-2ze7psqzmbwiw0wh1f51` |
| 执行时点 | `timePoints=["19"]` → **UTC 19:00 = 北京时间 03:00** |
| 重复 | 每天（`repeatWeekdays` 1–7） |
| 保留 | 7 天 |
| 跨地域复制 | 关闭（额外收费，本项目不需要） |
| 应用磁盘 | **两块都应用了**：`d-…kifm`（系统盘）+ `d-…kifn`（数据盘） |

```bash
aliyun ecs CreateAutoSnapshotPolicy --regionId cn-beijing \
  --autoSnapshotPolicyName hbecho-daily --timePoints '["19"]' \
  --repeatWeekdays '["1","2","3","4","5","6","7"]' --retentionDays 7 --profile hbecho-setup

aliyun ecs ApplyAutoSnapshotPolicy --regionId cn-beijing \
  --autoSnapshotPolicyId sp-2ze7psqzmbwiw0wh1f51 \
  --diskIds '["d-2zef8qpi1d2mldnqkifn","d-2zef8qpi1d2mldnqkifm"]' --profile hbecho-setup
```

两个容易出错的点：

- **`timePoints` 是 UTG 小时，不是本地时间。** 想要北京 03:00 就填 `19`（前一天 UTC 19:00）。填 `3` 得到的是北京 11:00，正好撞上业务时间。
- **`CreateAutoSnapshotPolicy` 的参数名是小写 `--regionId`**，不是其他 ECS 接口常用的 `--RegionId`。写错会报 `required parameters not assigned`。

复核（两块盘都要有 policy）：

```bash
aliyun ecs DescribeDisks --RegionId cn-beijing --InstanceId i-2zef8qpi1d2mldntjgrv \
  --profile hbecho-setup | grep -E 'DiskId|AutoSnapshotPolicyId|Type'
```

**只配系统盘是常见遗漏**，而数据库数据在数据盘，那才是最需要备份的。

### 11.2 逻辑备份

```bash
# /data/app/scripts/backup-mysql.sh（示意，落地时补齐凭证读取与错误处理）
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/data/backup/hbecho-${TS}.sql.gz
mysqldump --single-transaction --quick --routines --triggers --events \
  --set-gtid-purged=OFF -h 127.0.0.1 -u <备份账号> -p"<从env读>" <库名> \
  | gzip -c > "${OUT}"
# 上传到备份桶（走内网 endpoint）
# aliyun ossutil cp "${OUT}" oss://<备份桶>/mysql/ -e <内网endpoint>
# 本地保留窗口
find /data/backup -name 'hbecho-*.sql.gz' -mtime +7 -delete
```

`--single-transaction` 是必须的：它让导出在一个一致性快照里进行，不长时间锁表。同时注意它会开一个长事务——所以备份时段要避开同步批次，否则会撞上 §12 的长事务告警。

### 11.3 OSS 侧的备份

ODS 和媒资本身就在 OSS，**不需要再备份一份到别处**（OSS 本地冗余已经提供了持久性）。真正需要防的是"误删"，对策是 §7.7 的 RAM 策略不给 media 桶删除权限，而不是再复制一份数据。

### 11.4 跨存储恢复的坑（hbecho 特有）

MySQL 和 OSS 是**两个独立存储**，恢复时会错位。三种情形：

| 情形 | 后果 | 处置 |
|---|---|---|
| MySQL 回滚到较早时点，OSS 保持现状 | 出现"OSS 里有对象但数据库没有对应行"的孤儿对象 | 跑 ODS orphan sweeper（v2 §12.4 要求的按用途限定的清理器），不要手工按前缀删 |
| MySQL 回滚跨过了一次 ODS 到期清理 | 数据库恢复出已被应用删除的 payload/call 行，但 OSS 字节已经不在 | 恢复后必须做一次一致性校验，把取不到字节的 ODS 行按清理闭包正常化 |
| OSS 对象被误删，MySQL 完好 | `oss_objects.status` 说 available，实际取不到 | 媒资侧按 v2 的 `carried_forward` / `failed` 语义处理，**不要伪造"本轮归档成功"** |

所以恢复步骤里必须包含"恢复后一致性校验"这一步，不能只看 MySQL 起来了就结束。

### 11.5 恢复演练

**没演练过的备份不算备份。** 至少做一次完整演练并把结果记在 §17：

1. 取一份逻辑备份，导入一个临时库；
2. 验证行数与关键约束（§13.1 的 CHECK 验证在恢复库上也要通过）；
3. 记录耗时——这是将来真出事时唯一可信的 RTO 估计；
4. 删除临时库。

---

## 12. 监控与告警

告警的选择原则：**只报"会导致错误事实或错误账单"的信号**，不报单纯的资源波动。hbecho 不做打包、不做转码，CPU 高峰不是有意义的信号，所以 hbdam 那条 CPU 告警在这里换掉了。

### 12.1 基础设施告警（云监控）

2026-09-03 已配四条，全部绑定联系人组 `hbecho-ops`，采集周期 60 秒：

| RuleId | 指标 | 阈值 | 为什么是这条 |
|---|---|---|---|
| `hbecho-disk-usage` | `diskusage_utilization` | 连续 2 次 > 80% | **最关键的一条**。盘满 = MySQL 与容器一起挂，且 binlog 增长容易被忽视 |
| `hbecho-mem-usage` | `memory_usedutilization` | 连续 2 次 > 85% | buffer pool 配大了或应用泄漏，都先在这里显形 |
| `hbecho-net-out` | `VPC_PublicIP_InternetOutRate` | 连续 2 次 > 24 Mbps | 30 Mbps 的 80%。有流量在穿 ECS——媒资交付本应走 OSS 签名 URL 直连，这条报警意味着架构被绕开了 |
| `hbecho-cpu` | `CPUUtilization` | 连续 3 次 > 90% | 兜底。hbecho 不做打包和转码，这条优先级最低 |

```bash
aliyun cms PutResourceMetricRule --RuleId hbecho-disk-usage --RuleName "hbecho-磁盘使用率" \
  --Namespace acs_ecs_dashboard --MetricName diskusage_utilization --ContactGroups hbecho-ops \
  --Escalations.Critical.ComparisonOperator GreaterThanThreshold \
  --Escalations.Critical.Threshold 80 --Escalations.Critical.Statistics Average \
  --Escalations.Critical.Times 2 --Interval 60 \
  --Resources '[{"instanceId":"i-2zef8qpi1d2mldntjgrv"}]' --profile hbecho-setup
```

磁盘和内存指标依赖云监控 Agent（§12.6，已装）。没有 Agent 时只有 CPU 和网络指标，**看不到磁盘和内存**——而磁盘正是最需要看的那个。

还应补但当前缺前置条件的两条：

| 指标 | 缺什么 |
|---|---|
| 最长活动事务 > 30 秒（§12.2） | MySQL 未部署。这是"网络请求期间不持有数据库事务"被违反的直接信号 |
| 时钟偏移 > 1 秒（§12.3） | 云监控无此内置指标，需自定义上报或本地脚本 |

### 12.2 MySQL 告警

| # | 指标 | 阈值 | 为什么 |
|---|---|---|---|
| 1 | **最长活动事务时长** | > 30 秒 | hbecho 特有的正确性信号。v2 §12.4 明确"网络请求期间不持有数据库事务"。出现长事务通常意味着有人把 HTTP 调用写进了事务里，这会同时造成锁堆积和 ODS 语义破坏 |
| 2 | 连接数 | > `max_connections × 80%` | 连接池配置错或泄漏 |
| 3 | binlog 占用空间 | > `<待填写>` GB | 撑满数据盘的常见原因 |
| 4 | 复制/备份任务失败 | 立即 | — |

查最长事务：

```bash
mysql -h 127.0.0.1 -P 13307 -u <user> -p -e "
SELECT trx_id, trx_state,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec,
       LEFT(trx_query, 120) AS q
FROM information_schema.innodb_trx
ORDER BY trx_started
LIMIT 10;"
```

### 12.3 时钟告警

| 指标 | 阈值 | 为什么 |
|---|---|---|
| `chronyc tracking` 的 System time offset | 绝对值 > 1 秒 | 租约与 fencing 依赖时间（§5.4）。时钟漂移会让租约语义静默失效，而这类错误不会报错，只会产生重复或丢失的业务事实 |

```bash
ssh hbecho "chronyc tracking | awk -F: '/System time/{print \$2}'"
```

### 12.4 成本与调用告警（应用侧，随功能实现）

这一层不是云监控能提供的，需要应用自己计量。列在这里是为了不被漏掉——它属于总纲 §8.2 的最小成本门槛。

| 指标 | 作用 |
|---|---|
| ProviderCall 计数（按 action / platform / mode 分） | 每次提交、轮询、分页、重试都算一次；异常增长通常是重试风暴 |
| `ambiguous` 状态调用数 | v2 §12.4：结果不明的调用**不得盲目重发**。数量上升说明网络或供应商侧有问题，需要人工对账 |
| 媒资下载字节数与失败率 | OSS 容量与流量的主要来源 |
| OSS 存储量按桶分别统计 | ODS 桶应呈周期性平台（一年后开始有删除），media 桶单调增长。ODS 桶持续单调增长说明清理器没工作 |
| 人工止损开关状态 | `AIMASTER_ENABLED` 的实际生效值 |

**ODS 桶容量曲线是清理器的健康检查。** 上线一年内看不出来，所以别等一年——清理器实现后就要能在测试里用 fake clock 证明它会删，并在生产里按月核对 `ods_payloads` 的最早 `expires_at`。

### 12.5 通知

2026-09-03 已配：

| 项 | 值 |
|---|---|
| 联系人 | `liuxuekui`（ContactId `4300978`），描述「hbecho 项目负责人 刘学奎」 |
| 短信 | `17863267891` — 状态 **`OK`** ✅ 可用 |
| 邮箱 | `liuxuekui@hisensebosch.com` — 状态 **`PENDING`** ⚠️ 待确认，见下方排查 |
| 联系人组 | `hbecho-ops` → `liuxuekui` |

**邮箱需要点确认链接才生效**，这一点是设计如此：阿里云在写入联系人时向该邮箱发验证邮件，确认前 `ChannelsState.Mail` 保持 `PENDING`，且**查询接口不会明文回显未激活的邮箱地址**（`Channels.Mail` 显示为空字符串是隱私保护行为，不代表地址没写进去——`DeleteContact` 重建后立即查询同样是空字符串，说明这不是写入失败）。

🟡 **已搁置，人工判定为阿里云侧问题（2026-09-03）。**

排查记录：

| 尝试 | 结果 |
|---|---|
| 重新 `PutContact`（同名视为更新） | API 成功，状态仍 `PENDING` |
| `DeleteContact` 后重建 | API 成功，状态仍 `PENDING`；`Channels.Mail` 立即查询即为空 |
| 你本人在控制台手动编辑并保存 | 仍未收到确认邮件 |

排除了：邮箱格式错误（语法合法）、企业邮箱拦截（本人直接检查过收件箱，非本机推测）、短信占用额度（两个通道独立，短信已 `OK`）、接口调用失败（每次 `Success: true`）。CLI 侧未再重复尝试——控制台手动操作已经是比 API 更直接的路径，仍不通说明问题在阿里云通知服务侧。

**处置：搁置，不再自动化排查，等人工联系阿里云工单解决。** 不阻塞任何其他工作——短信通道已经 `OK`，四条告警规则都能通过短信送达；`hbecho-ops` 组当前是"短信可用、邮件待修"的降级状态，这是可接受的临时状态，不是配置缺陷。

```bash
# 阿里云侧修复后复查，期望 Mail 从 PENDING 变 OK
aliyun cms DescribeContactList --ContactName liuxuekui --profile hbecho-setup
```

```bash
# 创建方式（供复用）
aliyun cms PutContact --ContactName liuxuekui --Describe "..." \
  --Channels.SMS 17863267891 --Channels.Mail liuxuekui@hisensebosch.com \
  --Lang zh-CN --profile hbecho-setup
aliyun cms PutContactGroup --ContactGroupName hbecho-ops \
  --ContactNames.1 liuxuekui --Describe "..." --profile hbecho-setup
```

### 12.6 云监控 Agent：安装失败的根因

**已解决**（2026-09-03）。Agent 版本 `4.0.0.2`，状态 `running`，LoongCollector `3.3.2` Enabled，磁盘/内存/CPU 指标全部上线。

根因值得记下来，因为它是一个**权限缺失伪装成执行失败**的典型：

| 尝试 | 结果 |
|---|---|
| `aliyun cms InstallMonitoringAgent --Force true` | API 返回 `Success: true`，状态却是 `install_faild` / `AgentInstallErrorCode: YUNDUN.Execute` |
| 补 `ram:CreateServiceLinkedRole`，Condition 写 `cms.aliyuncs.com` + `monitor.aliyuncs.com` | 仍失败，服务关联角色没被创建 |
| 服务器侧手动下载安装脚本 | 桶存在（403），但猜测的对象路径全部 404 |
| **控制台点「安装插件」** | ✅ 成功 |

真正缺的是服务关联角色 `AliyunServiceRoleForCloudMonitor`（策略 `AliyunServiceRolePolicyForCloudMonitor`）。控制台的确认弹窗把作用写得很清楚：

> 允许云监控使用云助手执行命令，以完成自动安装主机监控插件的功能。

这就解释了 `YUNDUN.Execute`：**没有这个角色，云监控无法通过云助手下发安装命令**，所以卡在"执行"环节。

我那次补权限失败的原因是**服务名猜错了**。事后从已创建的角色里读出真实值：

```bash
aliyun ram GetRole --RoleName AliyunServiceRoleForCloudMonitor --profile hbecho-setup
#   受信服务: cloudmonitor.aliyuncs.com
```

不是 `cms.aliyuncs.com`，也不是 `monitor.aliyuncs.com`，而是 **`cloudmonitor.aliyuncs.com`**。产品的 RamCode（`cms`）和服务关联角色的服务名（`cloudmonitor.aliyuncs.com`）不一致，靠猜必然错。

正确的策略段（若要让 CLI 能自助创建）：

```json
{
  "Effect": "Allow",
  "Action": "ram:CreateServiceLinkedRole",
  "Resource": "*",
  "Condition": { "StringEquals": { "ram:ServiceName": "cloudmonitor.aliyuncs.com" } }
}
```

> **一般性教训：服务关联角色的服务名不能猜。** 先在控制台触发一次（弹窗会显式写出角色名），或查已有角色的 `AssumeRolePolicyDocument`。产品简称、API endpoint、RamCode、SLR 服务名这四者经常不同。

`argusagent` 服务显示 `inactive` 是正常的——4.x 版走 LoongCollector，不再依赖旧的 argusagent 进程。判断是否正常要看 API 的 `Status: running`，不要看那个服务名。

---

## 13. 验收清单

每次重大变更后（换 MySQL 版本、改 OSS 拓扑、重装系统、恢复演练）跑一遍。**每项都要看到期望输出，"命令没报错"不算通过。**

### 13.1 MySQL CHECK 约束真的生效

v2 把大量语义不变量放在 CHECK 里。8.0.16 之前的版本会**解析后忽略** CHECK，建表成功、约束失效、无任何警告。所以要用一次故意违规的插入来证明它在工作：

```sql
-- 用普通表而非临时表：临时表对 CHECK 的支持不作为本项验证的前提
CREATE TABLE _check_probe (
  v INT,
  CONSTRAINT ck_probe CHECK (v > 0)
);
INSERT INTO _check_probe (v) VALUES (-1);   -- 必须失败
DROP TABLE _check_probe;
```

**期望**：`INSERT` 报错 `Check constraint 'ck_probe' is violated`（错误码 3819）。
**如果插入成功**：立刻停止一切建表和迁移动作，先解决 MySQL 版本问题。整个 v2 设计在这台机器上不成立——CHECK 被接受但不执行，是最坏的一种失败方式。

### 13.2 严格模式与时区

```sql
SELECT @@version, @@sql_mode, @@global.time_zone;
```

**期望**：版本 ≥ 8.0.16；`sql_mode` 含 `STRICT_TRANS_TABLES`；`time_zone` 为 `+00:00`。

再验证一次非法值不会被静默截断：

```sql
CREATE TABLE _strict_probe (n TINYINT);
INSERT INTO _strict_probe (n) VALUES (99999);   -- 必须失败
DROP TABLE _strict_probe;
```

**期望**：报错 `Out of range value for column 'n'`（错误码 1264）。
若插入成功并被截断成 `127`，说明严格模式被关掉了——"真实 0、缺失、显式 null、非法值必须保留不同语义"这条不变量已经在存储层失效，而应用层看不到任何异常。

### 13.3 media 桶没有过期规则（验证一个"不存在"）

```bash
# 逐桶核对生命周期规则
aliyun ossutil lifecycle --method get oss://<MEDIA桶>
```

**期望**：没有任何 `Expiration` 规则；只允许存在"清理未完成分片"规则。
**这是最容易被将来某次"顺手加个清理规则"破坏的一条**，所以要显式验证，而不是假定没人会加。

同时核对 ODS 桶：

```bash
aliyun ossutil lifecycle --method get oss://<ODS桶>
```

**期望**：兜底过期规则天数明显大于应用清理窗口（建议 400 天），不是 365。

### 13.4 桶是私有的

```bash
# 匿名访问（不带签名）
curl -s -o /dev/null -w '%{http_code}\n' https://<桶>.oss-<region>.aliyuncs.com/
```

**期望**：`403`。`403` 说明桶存在且拒绝匿名访问，正是私有权限应有的表现。
`404` 说明桶名写错了；`200` 说明桶是公共读，**立即改回私有**。

### 13.5 内网 endpoint 可达

```bash
ssh hbecho 'curl -s -o /dev/null -w "内网 %{http_code} 耗时 %{time_total}s\n" \
  https://<桶>.oss-<region>-internal.aliyuncs.com/'
```

**期望**：`403` + 毫秒级耗时。
注意：公网 endpoint 也会是毫秒级（§7.6 的坑），所以这一项**只证明内网通，不能用来证明代码走的是内网**。后者靠 §7.6 的启动断言和账单核对。

### 13.6 RAM 角色临时凭证

```bash
ssh hbecho 'curl -s http://100.100.100.200/latest/meta-data/ram/security-credentials/<角色名>' | head -c 200
```

**期望**：JSON 含 `AccessKeyId`、`SecurityToken`、`Expiration`。看到 `Expiration` 才说明是临时凭证。

### 13.7 没有意外的公网监听

```bash
ssh hbecho "ss -tlnp | grep -vE '127\.0\.0\.1|\[::1\]'"
```

**期望**：只有 `sshd` 的 22。对外开放前出现任何其他公网监听都要立刻处理。

### 13.8 fd 上限真的生效

```bash
ssh hbecho 'for p in $(pgrep -d" " mysqld dockerd); do echo "== $p"; grep "open files" /proc/$p/limits; done'
```

**期望**：65535。这里是"配了但没生效"的高发点（§5.2）。

### 13.9 时钟

```bash
ssh hbecho 'chronyc tracking | grep -E "Reference ID|System time|Last offset"'
```

**期望**：有有效上游，offset 在毫秒级。

### 13.10 密钥没有进仓库

```bash
git grep -nIE 'sk-[A-Za-z0-9]{16,}|LTAI[A-Za-z0-9]{12,}' -- . ':!*.example' || echo "clean"
git log --all --name-only --pretty=format: | sort -u | grep -E '(^|/)\.env$|settings\.local\.json$' || echo "clean"
```

**期望**：两条都输出 `clean`。第二条检查的是**历史**——工作区干净不代表历史干净。命中的话，补救手段是轮换密钥，改历史只是清理，不是补救。

---

### 13.11 MySQL 8.4 LTS 约束实测（2026-11-04）

ADR-0002 把版本基线改为 8.4 LTS 后，在测试 ECS 上用**一次性容器**验证 v2 依赖的数据库能力。容器 `m84probe` 挂独立网络 `m84probe_net`、不映射宿主端口、库名 `probe_test`、root 密码在服务器上随机生成且不落盘，跑完即删除容器与网络；没有碰现有的 `hbecho-mysql`。脚本与日志在 `/data/tmp/mysql84-check/`。

启动参数注意：8.4 的时区参数是 `--default-time-zone=+00:00`，写成 `--time-zone` 会让 mysqld 直接退出。

| 检查 | 期望 | 实测（`mysql:8.4` → 8.4.13） |
|---|---|---|
| 版本、严格模式、时区 | ≥ 8.0.16；含 `STRICT_TRANS_TABLES`；`+00:00` | ✅ 8.4.13；默认 sql_mode 含 `STRICT_TRANS_TABLES`；`+00:00` |
| 生成列唯一键：外部账号（`staff_id` 为 NULL）多行并存 | 允许 | ✅ |
| 同一专员同一平台第二个账号（D-69） | `ERROR 1062` | ✅ `Duplicate entry '100-10' for key 'uq_staff_platform'` |
| 释放名额（`slot_released_at`）后再录入 | 允许 | ✅ |
| `watch_type='staff'` 但 `staff_id` 为空 | `ERROR 3819` | ✅ |
| 关闭监控但没有关闭原因 | `ERROR 3819` | ✅ |
| 复合外键：账号与平台不匹配 | `ERROR 1452` | ✅ |
| 严格模式越界写入 | `ERROR 1264` | ✅ |
| `mysql_native_password` | 默认不可用 | ✅ 插件状态 `DISABLED`；`default_authentication_plugin` 变量在 8.4 已移除（`ERROR 1193`）。应用账号用默认的 `caching_sha2_password` |

**结论**：v2 依赖的 CHECK、生成列唯一键、复合外键与严格模式在 8.4 上全部真实生效。现有 `hbecho-mysql`（8.0.46）没有业务表，首次部署应用时替换为 8.4。

## 14. 常用运维命令

```bash
# ── 连接 ─────────────────────────────────────────────
ssh hbecho

# ── 容量（最需要盯的）──────────────────────────────────
ssh hbecho 'df -hT /data /'
ssh hbecho 'du -sh /data/* 2>/dev/null | sort -rh'
ssh hbecho 'docker system df'
ssh hbecho 'ls -la /data/backup | tail -5'          # 备份是否还在产出

# ── 清理（不动运行中的容器和卷）─────────────────────────
ssh hbecho 'docker system prune -af --volumes=false'
ssh hbecho 'find /data/tmp -type f -mtime +1 -delete'

# ── 服务状态 ─────────────────────────────────────────
ssh hbecho 'docker ps -a'
ssh hbecho 'docker logs -f --tail 100 <容器名>'
ssh hbecho 'systemctl status mysqld --no-pager'      # 宿主部署时

# ── MySQL ───────────────────────────────────────────
# 最长活动事务（> 30s 需要排查，见 §12.2）
mysql -h 127.0.0.1 -P 13307 -u <user> -p -e "
SELECT trx_id, trx_state, TIMESTAMPDIFF(SECOND, trx_started, NOW()) age_sec,
       LEFT(trx_query,120) q FROM information_schema.innodb_trx
ORDER BY trx_started LIMIT 10;"

# 连接数与库体积
mysql ... -e "SHOW STATUS LIKE 'Threads_connected'; SHOW VARIABLES LIKE 'max_connections';"
mysql ... -e "SELECT table_schema, ROUND(SUM(data_length+index_length)/1024/1024) mb
              FROM information_schema.tables GROUP BY table_schema ORDER BY mb DESC;"

# ODS 清理健康度（表建好后可用）
mysql ... -e "SELECT MIN(expires_at) earliest, COUNT(*) total FROM ods_payloads;"

# ── OSS ─────────────────────────────────────────────
# 私有性验证（403 = 正常）
curl -s -o /dev/null -w '%{http_code}\n' https://<桶>.oss-<region>.aliyuncs.com/
# 生命周期核对
aliyun ossutil lifecycle --method get oss://<桶>
# 按桶看用量（成本核对）
aliyun ossutil du oss://<桶>

# ── 安全 ────────────────────────────────────────────
ssh hbecho "ss -tlnp | grep -vE '127\.0\.0\.1|\[::1\]'"
ssh hbecho 'journalctl -u sshd --since "-24h" --no-pager | grep -ciE "failed password|invalid user"'

# ── 时钟 ────────────────────────────────────────────
ssh hbecho 'chronyc tracking | grep -E "System time|Last offset"'

# ── 部署信息 ─────────────────────────────────────────
ssh hbecho 'cd /data/app/hbecho && git log --oneline -1 && git status --short'

# ── 数据盘在线扩容（控制台扩容后在系统内生效）───────────
ssh hbecho 'growpart /dev/<设备> 1 && resize2fs /dev/<设备>p1 && df -h /data'
```

---

## 15. 已知坑速查

按"会不会静默出错"排序。**前四条的共同特征是不报错**，所以只能靠制度和定期核对发现。

| # | 坑 | 后果 | 防线 |
|---|---|---|---|
| 1 | OSS endpoint 漏写 `-internal` | 无报错、无变慢，只在账单上体现 | 启动期断言（§7.6）+ 月度账单核对 |
| 2 | MySQL < 8.0.16 | CHECK 被解析后忽略，建表成功、约束全失效 | §13.1 破坏性验证 |
| 3 | `sql_mode` 移除 `STRICT_TRANS_TABLES` | 非法值静默截断，"真实 0 / 缺失 / 非法"语义合并 | §13.2 验证 |
| 4 | 时钟漂移 | 租约与 fencing 静默失效，产生重复或丢失事实 | chrony + §12.3 告警 |
| 5 | ODS 生命周期规则抢在应用清理之前 | 数据库说证据在，实际字节已被删 | 兜底规则设 400 天而非 365（§7.4） |
| 6 | 给 media 桶加了过期规则 | 长期媒资被删，无法重建（临时 URL 早已过期） | 三桶分离 + §13.3 验证"不存在" |
| 7 | 开启 OSS 版本控制 | 删除变成假删除，破坏一年保留承诺且持续计费 | 明确不开启（§7.4） |
| 8 | 不清理 OSS 未完成分片 | 控制台看不见但照常计费，账单莫名增长 | 每个桶都配碎片清理规则 |
| 9 | 容器日志不轮转 | 磁盘被日志写满，服务全挂 | `daemon.json` 的 `log-opts` |
| 10 | 安全组留着 `0.0.0.0/0` 又加窄规则 | 并集语义，等于没收紧 | 先加后验再删（§4.1） |
| 11 | 密钥进 git | 删文件改历史都无效，只能轮换 | `.gitignore` 先行 + pre-commit + 私有仓库 |
| 11b | 弱密码 + 公网 22 + 密码认证 | 会被字典暴力破解，且日志噪音掩盖真实攻击 | §3.2.1 的五步流程；hbdam 开局踩过同一个坑 |
| 11c | 把服务器密码存在工作区文本文件里 | 会被编辑器、云备份、AI 工具读到，`git init` 时可能进仓库 | 存密码管理器；`.gitignore` 兜底但不是主要防线 |
| 12 | 只给系统盘配自动快照 | 数据在数据盘，最需要备份的没备 | 两块盘都勾（§11.1） |
| 13 | 把 HTTP 调用写进数据库事务 | 锁堆积 + 破坏 raw-before-parse 语义 | §12.2 长事务告警 |
| 14 | 备份从未演练 | 真出事时才发现恢复不了 | §11.5 演练并记录耗时 |
| 15 | 照抄 hbdam 的设备名/版本号/实测值 | 手册第一章就是错的 | §1 全部实测填写 |

---

## 16. 未决项

这些不是遗漏，是**明确保持未决**的东西。运维侧不得用"已经装了什么"来代替决策。

| # | 未决项 | 影响的章节 | 何时定 |
|---|---|---|---|
| 0 | ~~**是否加挂数据盘**~~ —— 已定：已挂载并投入使用（Docker data-root、MySQL 均在 `/data`） | — | 已关闭 |
| 1 | ~~OSS 桶拓扑：三桶分离 or 单桶前缀~~ —— 已由 ADR-0001 关闭 | — | ADR-0001 |
| 2 | ~~应用框架、ORM/迁移工具、队列实现~~ —— 已由 ADR-0005 关闭 | — | ADR-0005 |
| 3 | ~~MySQL 自建 or RDS~~ —— 已由 ADR-0002 关闭：首版自建 | — | ADR-0002 |
| 4 | `innodb_buffer_pool_size`、`max_connections`、binlog 保留期 | §6.2 | 规格确认后按实际内存与连接池定 |
| 5 | media 桶是否用同城冗余（ZRS） | §7.3 | 按预算定 |
| 6 | `temp` 桶过期天数 | §7.5 | 媒资下载实现后按重试窗口定 |
| 7 | ~~AI Master 正式 QPS、并发、SLA、计费与轮询失败合同~~ —— 已关闭：认证、同步/异步、计费口径已实测；SLA 由业务接受为风险 | — | 已关闭 |
| 8 | ~~视频/音频归档范围~~ —— 已由 D-29 关闭：按规则圈定范围归档 | — | prd-platform §5.1 |
| 9 | ~~反代形态（宿主 Nginx or 容器）~~ —— 已由 ADR-0006 关闭：宿主 Nginx | — | ADR-0006 |
| 10 | 域名与备案主体 | §1.5、§4.3 | 越早查 whois 一致性越好 |
| 11 | 应用镜像形态 | §10 | **测试环境已定（2026-11-11）**：Docker 化、`node:24-slim`、两阶段、非 standalone（同一镜像要跑 `tsx` 的迁移与 access CLI）、运行阶段只装生产依赖；**生产环境形态仍未决**（含是否拆出运行镜像与工具镜像，镜像解压后约 900 MB） |

> 2026-10-28 同步：关闭 0、1、2、3、7、8、9 七项，均只标来源、不新增判断。反代形态由 [ADR-0006](../architecture/adr/0006-host-nginx-reverse-proxy.md) 定为宿主 Nginx：配置入仓库、部署脚本同步、证书续期走宿主机。

---

## 17. 变更记录

| 日期 | 变更 | 操作人 |
|---|---|---|
| 2026-08-31 | ECS 实例 `hbecho` 创建（华北2 北京 F，`ecs.g9i.2xlarge`，100 GiB ESSD AutoPL 系统盘） | — |
| 2026-09-03 | 本手册创建。基于 hbecho 当前设计基线（`CONTEXT.md`、`database-design-v2.md`、总纲）+ hbdam 手册 + 旧项目沉淀文档，取舍见 §2 | Kiro |
| 2026-09-03 | 仓库根创建 `.gitignore` 并在临时仓库实测忽略规则（`git init` 之前的前置动作，§9.2） | Kiro |
| 2026-09-03 | `.env` 由 `AiMaster接口API Key：sk-…`（全角冒号，非法 dotenv）改为标准 `AIMASTER_API_KEY=`，权限设为 600 | Kiro |
| 2026-09-03 | `aimaster接口文档/scripts/` 下 4 个脚本的 `load_api_key()` 由正则扫 `sk-` 改为按键名读取，并接入 `AIMASTER_ENABLED` 付费调用开关（默认 `false`，实测能拦住） | Kiro |
| 2026-09-03 | 外部实测：22 端口对公网开放、SSH 接受密码认证、80/443 不可达。§1.4 记录，处理顺序见 §4 | Kiro |
| 2026-09-03 | 确认 `旧项目沉淀文档/settings.local.json` 中的密码不属于 hbecho，不需要轮换；仍由 `.gitignore` 忽略 | 刘学奎 / Kiro |
| 2026-09-03 | 安装 `workbench` CLI v1.0.1 到 `/opt/homebrew/bin`（安装脚本 SHA256 校验通过）；阿里云官方 Skill 装到 `~/.kiro/skills/alibabacloud-workbench-cli/`。§3.4 按实测命令面重写 | Kiro |
| 2026-09-03 | 更正：v1.0.1 **没有**端口转发子命令，官方描述与实际命令面不符。MySQL 图形客户端仍需 SSH 隧道（§3.4） | Kiro |
| 2026-09-03 | `AIMASTER_ENABLED` 默认值由 `false` 改为 `true`（单人开发、频繁手工验证）。定位改为止损开关；测试套件与 CI 的离线要求不变（§8.2） | 刘学奎 / Kiro |
| 2026-09-03 | 🔴 发现 root 密码为字典高频模式（`品牌名+年份.`），叠加公网 22 + 密码认证开启。处置流程见 §3.2.1，**尚未处置** | Kiro |
| 2026-09-03 | 新增文档顶部 §待办清单作为唯一待办入口（P0–P4 + 待触发），§17.1 收敛为状态摘要 | Kiro |
| 2026-09-03 | 新增 §3.6：阿里云统一 CLI 建议（限时限权双身份模型、系统策略选择、我会做/不会做的边界） | Kiro |
| 2026-09-03 | §7.3 补充：2025-10-13 起 API/SDK/ossutil 新建桶默认开启「阻止公共访问」 | Kiro |
| 2026-09-03 | 安装 `aliyun` CLI 3.4.11 到 `/opt/homebrew/bin`。确认 `ossutil` 为内置子命令，§7/§13/§14 的 OSS 命令统一改为 `aliyun ossutil` | Kiro |
| 2026-09-03 | 记录账号 ID `1241086349153033`；§3.5 补齐 RAM 用户创建的逐字段说明与策略授权步骤，策略 JSON 已填入真实账号 ID 与实例 ID | Kiro |
| 2026-09-03 | 创建 RAM 用户 `hbecho-ops`、`hbecho-setup` 与策略 `hbecho-workbench-ops`、`hbecho-setup-buildout` | 刘学奎 |
| 2026-09-03 | 写入 `~/.workbench/config.json`（hbecho-ops）与 `~/.aliyun/config.json`（hbecho-setup），均 600 | Kiro |
| 2026-09-03 | ⚠️ 实测两个身份调用均被拒：`workbench exec` 403 `ImplicitDeny`、`aliyun ecs Describe*` `Forbidden.RAM`。判定为**策略未授权给用户** | Kiro |
| 2026-09-03 | 实测发现 `ecs-workbench` 不支持资源级授权（控制台标「无效授权」+ 调用 `ImplicitDeny`）。`ecs-workbench:*` 改为 `Resource:*`，收紧点转移到 `ecs:StartTerminalSession`。详见 §3.5 | Kiro |
| 2026-09-03 | 按决定给 `hbecho-setup` 加入 `RamForInstanceRole` 段；同时在 §3.6 记录其有效权限等级实为账号管理员，控制手段改为生命周期而非 action 列表 | 刘学奎 / Kiro |
| 2026-09-03 | 两个策略更新到 v2 并授权给对应用户 | 刘学奎 |
| 2026-09-03 | ✅ 两条通道实测通过：`workbench exec` 返回主机名与 uptime；`aliyun ecs DescribeInstances` 与 `aliyun ossutil ls` 正常 | Kiro |
| 2026-09-03 | 通过 `workbench exec` 采集机器内部信息，§1.1/§1.2/§1.4 全部实测填写完毕 | Kiro |
| 2026-09-03 | ✅ **更正**：数据盘并非未采购。`/dev/nvme1n1` 100 GiB 已存在但未初始化。实例详情页面板不显示未初始化磁盘，早前判断有误 | Kiro |
| 2026-09-03 | 实测 `/root/.ssh/authorized_keys` 为空 → SSH 当前只有密码一条路，因此装公钥必须早于关闭密码认证（§1.4） | Kiro |
| 2026-09-03 | 实测账号下 0 个 OSS Bucket；§1.6 按 `hbecho-*` 前缀约束给出建议桶名 | Kiro |
| 2026-09-03 | 确认三桶分离方案；创建 `hbecho-ods` / `hbecho-media` / `hbecho-temp` / `hbecho-backup`（cn-beijing，私有，Standard，LRS） | 刘学奎 / Kiro |
| 2026-09-03 | 配置四桶生命周期规则。踩坑：**同前缀两条规则被 OSS 拒绝（400）**，需把过期与碎片清理合并进同一条 `<Rule>` | Kiro |
| 2026-09-03 | OSS 验收全通过：四桶匿名 403、`BlockPublicAccess=true`、内网 endpoint 403/44ms、**`hbecho-media` 确认无过期规则** | Kiro |
| 2026-09-03 | 生成 `~/.ssh/hbecho_ed25519`，公钥装入服务器 `authorized_keys`，指纹比对一致，密钥登录实测通过；写入 `~/.ssh/config` 别名（本地端口 8081/13307，与 hbdam 错开） | Kiro |
| 2026-09-03 | 写 `/etc/ssh/sshd_config.d/90-hbecho-hardening.conf` 关闭密码认证。`sshd -t` 通过后 reload，三向验证：密钥通 / 旧密码被拒 / Workbench 不受影响 | Kiro |
| 2026-09-03 | root 密码存入 macOS 登录钥匙串（`hbecho-ecs-root`）。⚠️ 当前值仍是可猜模式，待换真随机串 | Kiro |
| 2026-09-03 | 移除安全组 `3389/0.0.0.0/0`（阿里云默认规则，Linux 无 RDP、实测无监听） | Kiro |
| 2026-09-03 | 实测出口 IP 两个：VPN 关 `223.78.94.133`（山东移动）、VPN 开 `50.7.158.251`（FDCservers 东京）。§4.1 记录 VPN 网段不可加白名单及三个方案 | Kiro |
| 2026-09-03 | 实测账号下只有 hbecho 一台实例，其他地域为 0 → hbdam 不在本账号内 | Kiro |
| 2026-09-03 | 新建 [`new-server-bootstrap-checklist.md`](new-server-bootstrap-checklist.md)：项目无关的从 0 配置清单，供 hbdam 复用 | Kiro |
| 2026-09-03 | 采用方案 A 收紧安全组 22：先加 `223.78.0.0/16`（prio 1）→ 验证 SSH → 删 `0.0.0.0/0` → 复核。入方向现只剩 22（网段内）与 ICMP | 刘学奎 / Kiro |
| 2026-09-03 | ⚠️ **更正一处机制理解**：Workbench 并非不使用入方向 22，而是从阿里云内网段（`100.104.x.x/26`）发起并**自动写入 `createdByEcsWorkbench` 安全组规则**。删掉 `0.0.0.0/0` 后首次调用失败、约 68 秒后自愈；先前判成「陈旧 session」是错的。§4.1 已按真实机制改写，并列出正确的排查顺序 | Kiro |
| 2026-09-03 | 确认 hbdam 位于**另一个阿里云账号**，ECS 与 RAM 完全独立。bootstrap 清单补充多账号共存约定并改为自包含 | 刘学奎 / Kiro |
| 2026-09-03 | 数据盘初始化：确认空盘后 GPT + ext4（label `hbecho-data`）→ fstab 用 UUID + `nofail` + `noatime` → 建 `/data/{mysql,docker,app,logs,backup,tmp}`，`mysql`/`backup` 设 700。`umount`+`mount -a` 验证重启可自动挂载；顺序写 218 MB/s | Kiro |
| 2026-09-03 | 系统参数：limits 两处 + sysctl 六项。**修正 hbdam 手册两处会出错的值**——`DefaultLimitNOFILE` 改 `65535:524288`（`65535:65535` 会把硬限从 524288 降下来）；删除 `vm.swappiness`（本机无 swap 且被 `99-apsara-sysctl.conf` 覆盖）。用重启 chronyd 验证新服务继承 | Kiro |
| 2026-09-03 | 装 Docker 28.3.3 + Compose 2.26.1（Alinux4 官方源 `moby`）。镜像加速源从**服务器侧**实测筛选，确认 `registry-1.docker.io` 不可达。`docker pull/run` 端到端验证通过，镜像层落 `/data/docker`，容器 `ulimit -n`=65535 | Kiro |
| 2026-09-03 | 建 `hbecho-oss-rw` 策略 + `hbecho-ecs-role` 角色并绑定实例。服务器装 `ossutil 2.1.2` 且**不配任何 AccessKey**，实测四桶权限边界与设计一致（media/backup 删除被拒） | Kiro |
| 2026-09-03 | 绑定角色踩到两个隐式拒绝：`ecs:AttachInstanceRamRole` 与 `ram:PassRole` **均不支持资源级 ARN**。策略迭代到 v5 才成功，收紧点转移到 `PassRole` 的 `acs:Service` Condition。§7.7 已记录规律 | Kiro |
| 2026-09-03 | 建自动快照策略 `hbecho-daily`（`sp-2ze7psqzmbwiw0wh1f51`，UTC 19:00 = 北京 03:00，保留 7 天）并应用到**两块盘**。记录 `timePoints` 是 UTC 小时、`--regionId` 参数名小写两个坑 | Kiro |
| 2026-09-03 | ⚠️ 云监控 Agent 安装失败（`YUNDUN.Execute`），已排除网络/云助手/Aegis 三个因素 | Kiro |
| 2026-09-03 | 控制台点「安装插件」成功，Agent `4.0.0.2` / LoongCollector `3.3.2` / `running`，磁盘内存 CPU 指标上线 | 刘学奎 |
| 2026-09-03 | 定位根因：缺服务关联角色 `AliyunServiceRoleForCloudMonitor`，云监控无法经云助手下发安装命令。我此前补权限失败是**服务名猜错**——真实值 `cloudmonitor.aliyuncs.com`，不是 `cms.aliyuncs.com`。§12.6 已记录 | Kiro |
| 2026-09-03 | 建告警联系人 `liuxuekui`（短信 `OK`、邮箱 `PENDING` 待确认）与联系人组 `hbecho-ops` | Kiro |
| 2026-09-03 | 配四条告警规则并绑定 `hbecho-ops`：磁盘 80%×2、内存 85%×2、公网流出 24Mbps×2、CPU 90%×3，采集周期 60s | Kiro |
| 2026-09-03 | 工作区 `服务器密码` 明文文件已删除（钥匙串保留副本） | 刘学奎 |
| 2026-09-03 | 装 `.githooks/pre-commit` 密钥扫描钩子并 `git config core.hooksPath .githooks`；四种拦截实测有效。踩坑：中文路径被 git 转义导致文件名正则失效，需 `core.quotepath=false`（§9.5） | Kiro |
| 2026-09-03 | `git init`（main）+ 首次提交 `66caf30`，86 文件 / 0.2 MB。提交前逐项审查：凭证文件全部忽略、密钥扫描仅命中 `.env.example` 占位符、359 处手机号形态确认为 fixture 数字 ID 误报 | Kiro |
| 2026-09-03 | 新增 §9.7 建私有远端仓库分步教程（Codeup 权威 + GitHub 镜像 + 服务器只读部署密钥） | Kiro |
| 2026-09-03 | Codeup 云效组织创建受阻，改为先建 GitHub `origin`（`git@github.com:ArchMan001/hbecho.git`，Private，匿名 404 确认）并推送两个提交。§9.7 改写为 GitHub 权威 + Codeup 可选镜像 | 刘学奎 / Kiro |
| 2026-09-03 | 服务器补装 `git 2.47.3`；生成部署密钥 `github_deploy`（指纹 `SHA256:8V8ryhd5I1rX0quT7Ep/JkOMwvc2ffVy1o9L4L+w9wU`），加为 GitHub 只读 Deploy Key，`clone` 到 `/data/app/hbecho` 并设 `core.hooksPath` | 刘学奎 / Kiro |
| 2026-09-03 | 用真实推送测试确认部署密钥只读在服务端强制生效（`ERROR: ... marked as read only`），非前端隐藏。修正过程中的 `HEAD~1` 误判，改用 `reset --hard origin/main` 对齐 | Kiro |
| 2026-09-03 | 邮箱告警通道 `PENDING` 问题：本人控制台手动重试仍未收到确认邮件，判定为阿里云侧问题，**搁置等工单处理**，不阻塞其他工作；短信通道已可用 | 刘学奎 |
| 2026-09-04 | 部署 MySQL 8.0.46（Docker，`mysql:8.0` 官方镜像），容器 `hbecho-mysql`，数据落 `/data/mysql`，端口仅绑 `127.0.0.1:3306`。密码经 `workbench upload` 传递，未落地明文文件、未进命令行历史，存本机 Keychain | Kiro |
| 2026-09-04 | §13.1/§13.2 破坏性验收通过：`CHECK` 约束报 `ERROR 3819`，严格模式报 `ERROR 1264`，均精确匹配预期而非泛泛"有报错"。探针表已清理 | Kiro |
| 2026-09-04 | 应用账号 `hbecho_app` 权限验证限定在 `hbecho.*`，非 `*.*`；容器 fd 上限 65535（继承 daemon.json）；`local_infile=OFF` | Kiro |
| 2026-10-25 | 新增 [`dev-test-deploy-workflow.md`](dev-test-deploy-workflow.md)：verify → CI → 测试 ECS → 生产 ECS。本章 §10 增加指针；当前只有本机 verify 与 CI 的文档/密钥检查可用，测试 ECS 与镜像链路尚未建立 | Claude |
| 2026-10-25 | **环境定位更正**：现有唯一实例 `i-2zef8qpi1d2mldntjgrv` 是**测试环境**，不是生产环境；生产 ECS 未购买。更新 §1.1、§3.1、§8.5、§10.6 与 `dev-test-deploy-workflow.md` | Claude |
| 2026-11-10 | 开通 ACR 经济版 `hbecho-registry`（`cri-e07ol87axh61gu6d`，华北2 北京，包月到期 2026-12-11）；绑定 VPC `vpc-2zevfnkvxxw6ae8gpj2f3` / `vsw-2ze1ymn3rrx0i2bivbufv`；建私有命名空间 `hbecho`。新增 §1.7 状态块与 §3.7 | 刘学奎 / Claude |
| 2026-11-10 | 建 RAM 子账号 `hbecho-acr-push` / `hbecho-acr-pull` 与两条最小权限策略（限定 `hbecho` 命名空间）；固定密码由两个子账号本人设置 | 刘学奎 |
| 2026-11-10 | 端到端验证通过：探测镜像 `hbecho/probe:probe-1` push 成功、pull 账号 pull 成功且 push 被拒；服务器登录态落 pull 账号，`/root/.docker/config.json` 600、只含内网域名 | Claude |
| 2026-11-10 | GitHub Actions secret `ACR_PUSH_PASSWORD` 已写入 `ArchMan001/hbecho`（`gh secret list` 核对，2026-11-10T14:58:54Z） | Claude |
| 2026-11-10 | 待办登记（§P5）：关闭两个子账号控制台访问、接 CI 前删公网白名单 `127.0.0.1/32` | — |
| 2026-11-10 | 新增 [ADR-0016](../architecture/adr/0016-container-registry.md)：镜像仓库自建 ACR 经济版、不复用 hbdam 实例；同步更新 ADR 索引与 `INDEX.md`（15→16 项） | 刘学奎 / Claude |
| 2026-11-10 | 刘学奎确认 ACR 自动续费已生效（到期 2026-12-11），§P5 #39 关闭 | 刘学奎 |
| 2026-11-11 | 测试 ECS 上线应用：`hbecho-mysql` 8.0.46 → 8.4.13（先备份）并加 `--log-bin-trust-function-creators=1`；建 `hbecho_web` 运行账号与迁移账号；`/data/app/web.env`、`migrate.env`（root 600，短信 AccessKey 由本机经 Workbench 上传，只在服务器落盘）；compose 增加 `web` 服务；迁移全部应用；nginx 反代到 `127.0.0.1:3000`；创建待激活的首个超管。镜像 `…/hbecho/app:cd8188516e13` | Kiro（刘学奎同意） |
| 2026-11-12 | 建 `hbecho-signals` 桶（c-signals 标准图 / 元素图；cn-beijing、私有、LRS、碎片 7 天、阻止公共访问）；`hbecho-oss-rw` v2 → v3 新增 `SignalsStdImageReadWriteDelete`（只含该桶，Resource 精确到桶名）；测试 ECS 实例角色实测：该桶写 / 列 / 读 / 删通过，`hbecho-media` 删除仍被拒（实测时在 media 留下的探针对象已用 setup 身份删除）。刘学奎 2026-11-12 事先书面同意创建桶与改 RAM | Kiro |
| 2026-11-16 | 测试 ECS 部署主数据浏览：镜像 `…/hbecho/app:8c6b2ff9e9a6`（main 合并提交 `8c6b2ff`，CI run 43803345217 已推 ACR）；内网拉取、迁移无新增（`__drizzle_migrations` 12）、只重启 web；健康检查通过（`/api/health` ok、`/login` 200、`/users` 307）。发现 compose 镜像标签写死、不读 `WEB_TAG`，与 §10.3 不一致；备份 compose 后只改 web 行，worker 仍为 `6368b94798ef`。待后续把三处改成 `${WEB_TAG}` | Claude（刘学奎同意部署） |

### 17.1 当前进度

**待办事项统一维护在文档顶部的 §待办清单**，这里只记状态摘要，不重复列条目。

**已完成**（27/34，1 项搁置）：安全组收紧、SSH 密钥登录、数据盘与系统参数、Docker、实例 RAM 角色、OSS 四桶、自动快照、云监控 Agent 与四条告警规则、GitHub 私有仓库与服务器只读部署密钥、**MySQL 8.0.46 部署并通过 CHECK/严格模式破坏性验收**。

**无阻塞**：两条自动化通道（Workbench + aliyun CLI）都通，机器内和控制台操作都能做；代码能自动拉取更新；数据库已就位可供后续开发使用。

**搁置**：🟡 邮箱告警通道 `PENDING`，判定为阿里云侧问题，等工单处理，不阻塞其他工作（短信已可用）。

**仍待你处理**（均不紧急）：换真随机 root 密码（待办 4，SSH 已不接受密码认证）；开启会话管理作为浏览器兜底通道（待办 11）；Codeup 镜像排障（待办 26 附属项）；P4 对外开放前置项待备案启动后处理。

---

*本手册随服务器与云资源变更持续更新。任何涉及服务器、云资源、密钥或部署流程的操作，做完就在 §17 追加一行。*
