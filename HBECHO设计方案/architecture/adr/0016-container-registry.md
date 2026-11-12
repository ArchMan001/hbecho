# ADR-0016 · 容器镜像仓库：hbecho 自建阿里云 ACR 经济版，不复用 hbdam 的实例

- **状态**：accepted（2026-11-10，刘学奎）
- **日期**：2026-11-10（开通与实测日期）
- **决策人**：刘学奎
- **关闭**：`dev-test-deploy-workflow.md` 原「镜像仓库开通前单独决定并记 ADR」的欠账
- **与 ADR-0005 / ADR-0006 的关系**：不改应用栈，也不改宿主机反代形态；只决定镜像放在哪里、由谁拉取。应用镜像形态（是否 Docker 化、基础镜像、构建上下文）仍是未决项（`server-operations-runbook.md` §16 #11）

## 背景

hbdam 与 hbecho 是**两个不同的阿里云账号**（`1967785122003299` / `1241086349153033`）。hbdam 已有 ACR 企业版经济版（`cri-a85sb5oodyoolhea`，华北2，内网域名绑定 `vpc-2zeyhxf9ftlyeq1gr3vgx`，解析到 `172.24.60.202`）。hbecho 的测试 ECS `i-2zef8qpi1d2mldntjgrv` 在 `vpc-2zevfnkvxxw6ae8gpj2f3`（`172.25.70.146`），属于另一个账号、另一个 VPC。

hbdam 的实测结论已经排除了 ghcr：北京 ECS 从 ghcr 拉约 4 GB 的私有镜像只有约 150 KB/s，不能用于分发（`dev-test-deploy-workflow.md` §11）。因此需要一个同地域、可内网拉取的仓库。

## 决定

**采用**：阿里云容器镜像服务（ACR）企业版**经济版**，开在 **hbecho 自己的账号**下，华北2（北京）。

| 项 | 值 |
|---|---|
| 实例 | `hbecho-registry`，ID `cri-e07ol87axh61gu6d` |
| 规格 | 经济版，包月，到期 2026-12-11；**自动续费已于 2026-11-10 确认**（刘学奎） |
| 容量 | 仓库 200、命名空间 5、并发拉取 30 QPS；公开匿名拉取关闭 |
| 公网域名 | `hbecho-registry-registry.cn-beijing.cr.aliyuncs.com`（CI 推送） |
| 内网域名 | `hbecho-registry-registry-vpc.cn-beijing.cr.aliyuncs.com`（服务器拉取，→ `172.25.70.147`） |
| VPC 绑定 | `vpc-2zevfnkvxxw6ae8gpj2f3` / `vsw-2ze1ymn3rrx0i2bivbufv`，配额 1/1 |
| 命名空间 | `hbecho`（私有） |
| 凭证 | RAM 子账号 `hbecho-acr-push` / `hbecho-acr-pull`，各自最小权限，见 `server-operations-runbook.md` §3.7 |

**用它做什么**：存放应用镜像；GitHub Actions 经公网域名推送，服务器经内网域名拉取；标签 = git 短 sha（main 上额外 `main-latest`）。

**不用它做什么**（仍然空着或不归它管）：

- **不做跨账号共享**：不把 hbdam 的实例授权给 hbecho，也不把 hbecho 的镜像放进 hbdam 的仓库；
- **不用镜像同步、多地域同步、Helm Chart、交付链**：当前只有一个环境、一台测试机；
- **不开漏洞扫描**：经济版默认关闭，等有正式上线流程再评估；
- **不在服务器上构建镜像**：构建位置与镜像形态一起等第一个可运行镜像再定；
- **不把 ghcr 作为分发或兜底目标**。

## 备选与不选原因

| 候选 | 不选原因 |
|---|---|
| 复用 hbdam 的 ACR（RAM 跨账号授权 + 公网拉取） | 即使授权能打通，**内网域名跨账号 VPC 不可达**；经济版 VPC 访问控制配额只有 1，已绑给 hbdam 自己的 VPC，改绑会动 hbdam 现网。退回公网则要重新测速、走公网流量，且 CI/服务器要持有另一个账号的凭证，计费、配额、续费、删除全在 hbdam 侧 |
| 用 hbdam 实例把镜像同步到 hbecho 自有仓库 | 同步的目标仍然是一个 hbecho 自己的仓库，等于多一层复制和一份凭证，没有收益 |
| ghcr（GitHub Container Registry） | hbdam 实测北京机器拉大镜像约 150 KB/s，不能用于分发 |
| 服务器本地 `docker build` | 可行，但没有 CI 溯源与「构建一次、到处用同一标签」的约束；留作镜像形态确定后的兜底，不作为分发方案 |
| ACR 个人版 | 免费但共享实例、无 SLA；hbdam 的账号是企业认证、开不了个人版，hbdam 的结论是企业认证账号开不了个人版；hbecho 的控制台是否提供该选项**未单独核实**，价格与功能都不如经济版的隔离性，所以没有追 |
| 企业版基础版 / 标准版 | 价格更高，多出来的扫描、同步、更大配额当前都用不上；经济版足够，后续可原地升级 |

## 后果

- **成本**：约 ¥117/月（含 1 个 VPC 访问控制配额；这是下单页的报价，**未经账单核对**，第一次扣款后以账单为准）；自动续费已开，仍建议每季度核对一次扣款。
- **公网暴露**：公网访问入口已开启，但白名单当前只有 `127.0.0.1/32`，等于对外关闭。接 CI 前必须删掉这条（否则 GitHub runner 连不上）；删除后公网任何人可探测到 `/v2/`（返回 401），靠 registry 固定密码鉴权，push/pull 策略各自限定在 `hbecho` 命名空间。
- **VPC 配额只有 1**：换绑 VPC 必须先删旧绑定；未来若引入新 VPC（例如生产环境独立 VPC），需要重新评估规格。
- **域名里有两个 `registry`**：实例名以 `registry` 结尾，产品又追加 `-registry[-vpc]` 后缀，得到 `hbecho-registry-registry…`。实例名创建后不可改，为这个重建实例不值得；所有文档、CI 与命令以控制台显示为准。
- **凭证**：新增两个 RAM 子账号，纳入 `§8.4` 密钥分级与轮换流程；push 的固定密码进 GitHub Actions secret `ACR_PUSH_PASSWORD`（2026-11-10 已写入），pull 的只在服务器上交互登录。
- **构建与推送的触发（2026-11-12）**：分支 push 只构建 + 冒烟，不推 ACR；`main` 和手动触发（`workflow_dispatch`）才推。跨境推送最后一层（`.next` 构建产物，每次都变）整层重推，单次可超 25 分钟，重试后可到 50 分钟；而 `--no-ff` 合并后 main 的 sha 与分支 sha 不同，分支镜像并不是最终上线的镜像。保留分支上的构建 + 冒烟，是因为 `verify.sh` 不含 `next build` 与「生产配置启动」。根因（runner 到北京 ACR 的链路）没有解决：先观察 main 的推送耗时，再考虑瘦身最后一层或自托管 runner，另行决定。
- **镜像链路已启用（2026-11-11 订正）**：`Dockerfile` 与 CI `image` job 已存在，镜像 `…/hbecho/app:<git 短 sha>` 已推送并在测试 ECS 运行（`server-operations-runbook.md` §P6、§10.3）。推送速度：GitHub runner → 北京 ACR 的链路本身不慢（2026-11-11 探针：300 MB 不可压缩大文件 32 秒，约 9.4 MB/s，与 hbdam 的 12 MB/s 同量级）；慢的是 docker 对「大量小文件」的单层打包压缩（同样 100 MB 数据拆成 2 万个小文件，推送 54 秒，约 1.85 MB/s），所以 node_modules 这种层首次推送要数分钟；依赖不变时层已在 ACR，推送只要约 30 秒；镜像因此采用两阶段构建、运行阶段只装生产依赖，job 超时 30 分钟；公网白名单的 `127.0.0.1/32` 已于 2026-11-11 删除。形态上是「非 standalone 的 `next start` + `tsx`（迁移与 CLI 共用同一镜像）」，仅测试环境；生产形态仍未决。

## 它推翻了什么

- 推翻 `dev-test-deploy-workflow.md` 中「镜像与镜像仓库：无应用镜像；ACR 未登记、未使用」与「ACR 企业版分发：暂缓，按需决定」的现状描述，改为「已开通并验证，未启用」（2026-11-10）。
- 推翻「优先同地域 ACR 内网地址、开通前单独决定并记 ADR」中的欠账部分：ADR 即本文件，但**开通与 ADR 的先后被颠倒**（2026-11-10 先开通、后补记）。这是流程偏离，不是决定内容的变化。

## 现在谁在守

- `HBECHO设计方案/runbooks/server-operations-runbook.md` §1.7（实例与域名状态）、§3.7（凭证与策略）、§P5（待办：关控制台访问、删公网白名单、续费核对）；
- 实例侧的 RAM 最小权限（两个子账号各自限定 `hbecho` 命名空间）；
- 2026-11-10 的端到端实测：探测镜像 push 成功、pull 成功、pull 账号 push 被拒（`unauthorized: authentication required`）；
- 未来的 CI 镜像 job：只在镜像相关路径变化时构建，推同一标签。