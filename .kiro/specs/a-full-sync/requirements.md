# A 全量周期同步（a-full-sync）· 需求

> **状态**：`draft`
>
> **模式**：Design-First
>
> **实现状态**：仅定义可验收需求；尚未执行 [`tasks.md`](tasks.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-full-sync`，符合 `<代号>-<切片>`；路线图第 3 位（[`prd-platform.md`](../../../HBECHO设计方案/prd-platform.md) §7.2）
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11（2026-11-05，定稿候选）§5.5–§5.6、§6、§7、§8、§9、§10
>
> **相邻 PRD**：[`prd-platform.md`](../../../HBECHO设计方案/prd-platform.md) v1.0.9 §6.11（常态与按需采集）、[`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md) v1.1（按需采集的提出方）、[`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md) v0.4（finalized 快照与媒资的读取方）、[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21（Capability 名称）、[`prd-domain-i-ops.md`](../../../HBECHO设计方案/prd-domain-i-ops.md) v0.1（硬上限、ODS 清理）
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)（draft）§8–§12
>
> **最近核对**：2026-11-05
>
> **更新日期**：2026-11-05（初建；同日 §1.5 闸门通过；吸收旧系统 lxk-BigSpard 经验，见 §1.7；外部审查两轮后修订：见 §1.8）
>
> **语言约定**：正文中文；验收标准中的规范性关键词 `SHALL` / `SHALL NOT` / `MAY` 与技术标识保留英文（对齐 `a-data-foundation-tracer`、`a-master-data-import` 的写法）。

## 1. 引言

`a-full-sync` 把 tracer 证明过的单账号链路变成**每周自动运行的全量同步**：到点生成批次，算出哪些账号该采，按并发与速率逐个采主页和内容列表，用检查点证明没有漏采，把内容快照定稿并更新 current，归档头像、背景、封面；并为规则域提供**按需采集**（详情、评论、视频源、音频）的受控入口。快手加入支持平台，外部监控账号走同一条链路（只采主页）。

它回答 A 域 PRD 的第四个问题：**采到了吗**——批次、任务、检查点、连续性缺口、质量问题都能被运营查到，失败能在下一周期前重试完成。

### 1.1 权威顺序

冲突时按此顺序裁决，不在代码、SQL 或本 spec 里暗中选择一方：

1. [`CONTEXT.md`](../../../CONTEXT.md)：领域词汇与不变量；
2. [`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11：A 域产品语义的唯一真相源。本 spec 的同步规则以其 §5.5、§7、§9、§10 为准；
3. [`prd-platform.md`](../../../HBECHO设计方案/prd-platform.md) §6.11：常态采集与按需采集的分工、按需采集幂等（本 spec 的 FS-8 实现这一节中属于 A 的部分）；
4. [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)：同步控制、内容、评论、媒资的物理基线。与第 1–3 项冲突时按前三项修订 v2，不在局部 SQL 里另建平行结构；
5. AI Master V1.2 文档与已保存的 [`raw4`](../../../aimaster接口文档/测试结果/raw4-2026-10-28/)、[`raw5`](../../../aimaster接口文档/测试结果/raw5-2026-10-28/)、[`raw6`](../../../aimaster接口文档/测试结果/raw6-2026-10-28/)、[`raw9`](../../../aimaster接口文档/测试结果/raw9-2026-10-28/)、[`raw10`](../../../aimaster接口文档/测试结果/raw10-2026-10-28/)、[`raw12`](../../../aimaster接口文档/测试结果/raw12-2026-10-28/)、[`raw13`](../../../aimaster接口文档/测试结果/raw13-2026-10-28/)、[`raw14`](../../../aimaster接口文档/测试结果/raw14-2026-10-28/) 实测，以及 [`返回字段与特殊情况.md`](../../../aimaster接口文档/返回字段与特殊情况.md)：外部合同与证据。样本行为不能外推为供应商长期合同；
6. [`a-data-foundation-tracer`](../a-data-foundation-tracer/requirements.md)、[`a-master-data-import`](../a-master-data-import/requirements.md)：共享的目录、迁移、CLI、离线验证与已实现的 Module；本 spec 复用而不重选型；
7. 本 spec：不得静默改写以上事实。

### 1.2 上游与依赖

| 依赖 | 当前状态（2026-11-05 核对） | 对本 spec 的影响 |
|---|---|---|
| `a-data-foundation-tracer` | 任务 1–9 已合并 `main` | 复用 `RawCaptureGateway`、`provider-adapter`、`identity`、`projection`、`media-archive`、`orchestrator`（claim/fence）、`cost-guard`、`tests/harness`。其中 `projection/content-list` 的封面规则与 `tracer-flow` 的外部账号分支需要修改（§1.3 R3、R7；design §10） |
| `a-master-data-import` | 任务 0–8 已实现，2026-11-05 已合并 `main`（`fd1dd7d`） | 组织七表与监控开关列（`monitoring_enabled`）来自它之前的 tracer 迁移；`a-full-sync` 已变基到合并后的 `main` |
| 活动计划（`a-activity-plan`） | 路线图第 5 位，未开始 | 本 spec **不**实现 15 天无引用停采、计划删除联动、名单导入、疑似空账号人工确认；只读取已存在的 `monitoring_enabled` 与 `intake_status`，并提供改开关的命令（FS-14） |
| D 域（规则与考核） | PRD v1.1；实现路线图第 7 位 | D 是按需采集的提出方。本 spec 只定义**接入契约**（FS-8）与测试用的假提出方，不实现任何圈定、判定逻辑 |
| C 域（识别） | PRD v0.4；实现路线图第 6 位 | C 读取 finalized 快照与正式媒资字节。本 spec 保证 finalized 状态、媒资读取方式（短期签名 URL）与音频轨可用，不实现信号 |
| B 域访问控制 | PRD v1.21 定稿；实现未开始 | 沿用 tracer 的受限服务身份；Capability 名称按 B PRD。真实用户与 DataScope 由 B 实现 |
| Python 能力服务（ADR-0012） | 仓库里只有 `image.py` 与测试，**没有 HTTP 外壳** | 本 spec 建最小 FastAPI 外壳（图片标准化、音频抽取），ADR-0012 已批准 FastAPI，不新增依赖选型（design §7.10、FS-D11） |
| v2 数据基线 | draft；2026-11-04 十项、2026-11-05 六项修订后 | 本 spec 要求八项 v2 修订与两处 A PRD 修订（§1.3），实施前必须落回 v2 正文 |
| ADR-0005 / 0008 / 0010 / 0012 / 0013 | accepted | 应用栈、门店身份、品牌交集、能力服务、仓库目录是硬约束 |

**不依赖**：任何真实用户、页面、真实供应商（默认验收）、真实 OSS（默认验收）。

### 1.3 与 v2 基线的冲突与缺口（实施前必须修订 v2）

下列修订只增列、放宽约束或澄清文字，不删除既有列。未落回 v2 正文前，不得写迁移或 SQL。

> **落回状态（2026-11-05，任务 0）**：R1–R8 已全部落回 v2 正文（见 v2 文首「2026-11-05 修订」第 19–26 项）；P1、P2 已落回 A PRD v1.11；`prd-platform.md` D-33 已加澄清（v1.0.9）。落回时 v2 §12.5 / §12.6 里与 R2 同义的「内容终态等待详情依赖」旧写法一并改为账号级封口与按需种子快照，属于 R2 的必要连带，不是新增修订。

| # | 冲突 / 缺口 | 现状 | 本 spec 的修订要求 | 影响 |
|---:|---|---|---|---|
| R1 | 按需详情的落点没有定义 | v2 §10.2 只描述周期批次内「列表 + 详情」合并，并说「后续人工重抓使用新批次」；`content_snapshots` 一个批次一内容一行，finalized 后不可改 | 增加 `content_snapshots.seeded_from_snapshot_id BIGINT NULL`（FK → 同表，RESTRICT）；§10.2 增补第 12 条：按需批次为内容建一行 `building` 快照，**以该内容当前 finalized 快照的值与状态为种子**，再按 LaterValidValueWins 合并详情，定稿后可成为 current（FS-D05） | FS-8、FS-9 |
| R2 | 「列表阶段封口」的单位 | v2 §10.2 第 6、7 条与 **§12.3 第 6 条**都写成「批次中所有 / 全部列表任务终态后」，是 D-23 之前按内容跨账号合并的写法 | 澄清为**账号级封口**（§10.2 第 6、7 条与 §12.3 第 6 条一并改）：一个账号的列表任务终态（含失败 / 取消）后，该账号本批次的 `building` 快照即可定稿；不做跨账号 fan-in。按需详情不在周期批次内等待（FS-D04） | FS-6 |
| R3 | 封面下载范围与 A 不一致 | v2 §11.3 写「所有列表内容下载封面」，且 tracer 对每个快照都建 `cover` 引用 | 与 A §10.1 对齐：封面**首次入库**时下载；内容已有 `archived` / `carried_forward` 封面时不再为新快照建 `cover` 引用；此前没有成功过（`pending` / `failed`）时，下一次出现在列表就用新地址重建引用（FS-D09） | FS-11 |
| R4 | 批次用途无法区分 | `sync_batches.trigger_type` 只有 `scheduled` / `manual`；tracer 的单账号录入、补抓、按需批次都是 `manual` | 增加 `purpose VARCHAR(32) NOT NULL`（**迁移分三步：先建可空列 → 回填已有批次为 `intake` → 改 NOT NULL**，不留 DEFAULT，避免新代码漏写时静默变成 `intake`），CHECK 为 `full` / `supplement` / `demand` / `intake`；tracer 创建的根批次为 `intake`；只有 `full` 受「全量批次串行」约束（FS-D02） | FS-1、FS-13 |
| R5 | 批次「结束」不含媒资 | `sync_batches.finished_at` 语义未定；媒资下载是该批次的子任务 | `finished_at` = 结构化阶段（profile / list）结束；增加 `media_finished_at DATETIME(6) NULL`，媒资任务全部终态时写入（FS-D13） | FS-1、FS-11 |
| R6 | 快手账号标识命名空间 | v2 §6.3 只写了「视频号、快手账号空间」，没有给出命名空间代码；代码枚举 `IDENTIFIER_NAMESPACES` 与 0000 迁移的 CHECK **已含** `kuaishou.user_id`（tracer 阶段已预留） | 在 v2 §6.3 写明 `kuaishou.user_id`；CONTEXT 同步登记；**不需要改 schema 或迁移**（任务 1 只补测试）。快手主页与列表作者同一命名空间，没有第二官方标识（A §5.2） | FS-7 |
| R7 | 外部监控账号的采集范围 | v2 §8.3 说外部型「采集与自有账号走同一条链路」，§12.3 步骤 5 对所有 active 账号生成主页 + 列表任务 | 澄清：`watch_type='external'` **只生成 `fetch_profile`**（及头像 / 背景媒资），不生成列表、内容、详情任务（A §5.6：1.0 只采主页快照） | FS-13 |
| R8 | 批次排队语义缺失 | v2 §12.3 第 2 条写「已有全量批次运行 → 记录 skipped」，没有 `queued` / `expired`；§9.2、A §7.1、D-33 都是「排队 1 个、队列满才跳过、排到下一时点仍未开始则过期」 | §12.3 第 2 条改为与 §9.2 一致：无运行 → 创建并开始；有运行且队列空 → `queued`；队列满 → `skipped`；排队过期 → `expired`。**§9.2 的 `skipped` 语义同步放宽**：由「队列已满时创建摘要、不创建任务」扩展为「没有执行任何任务的批次」，`skip_reason` 取 `queue_full` / `no_targets`（没有有效监控目标）/ `all_targets_closed`（规划了任务但全部在领取前因监控资格失效被取消）；后一种批次里存在已取消的任务行 | FS-1 |


**对 A 域 PRD 的修订**（产品语义的唯一真相源，任务 0 同步改，升 v1.11 并补版本记录）：

| # | 位置 | 现写法 | 改为 | 依据 |
|---|---|---|---|---|
| P1 | §7.1 手工补抓 | 当前有批次在跑时，运营选择「排队」或「取消当前批次」 | 增加第三项 `run_now`（默认，并行）；写明 D-33 的串行只约束全量批次 | 刘学奎 2026-11-05 |
| P2 | §7.3 一次同步做什么 | 「列表处理完后：按规则决定哪些内容要拉详情 / 评论 → 详情 / 评论完成后：内容定稿」 | 周期同步只做「主页 → 列表 → 账号级定稿 → 媒资（头像 / 背景 / 封面）→ 批次汇总」；详情、评论、视频、音频由监控判定计划按需触发，不在周期批次内等待 | D-31、D-68、PRD §6.11 第 1 条；刘学奎 2026-11-05 采纳 |

> 这些是**基线修订**，不是本 spec 私有的实现细节。修订未落回 v2 / A PRD 正文前，不得开始写迁移或 SQL。

### 1.4 PRD 真空与已定结论

下列问题 PRD 没有直接写死，但实现必须选一条。「已定」来自 PRD、既有决策或刘学奎 2026-11-05 对本 spec 全部建议的采纳（design §13 对应 FS-Dnn）。

| # | 问题 | 结论 | 性质 |
|---:|---|---|---|
| 1 | 单账号补抓遇到全量批次正在跑 | 运营可选 `run_now`（并行执行，**默认**；一个账号只有两次调用）、`queue`（排到全量批次结束后）、`cancel_current`（取消当前全量批次）。`run_now` 是对 A §7.1 的放宽，任务 0 修订 A PRD §7.1 并补版本记录 | 已定（刘学奎，2026-11-05 采纳建议） |
| 2 | 按需采集批次是否受「全量批次串行」约束 | 不受：它不是全量批次（D-33 只约束全量批次），优先级高于周期任务，共用同一并发与速率上限 | 已定（刘学奎，2026-11-05 采纳；FS-D17） |
| 3 | 按需采集如何落到快照 | 新建按需批次（`purpose='demand'`），为被请求的内容建种子快照并合并详情，定稿后参与 current 比较 | 已定（刘学奎，2026-11-05 采纳；FS-D05） |
| 4 | 「本轮已有则复用」的「本轮」 | 本轮 = 最近一个已开始的 `full` 批次的 `started_at` 起（不是 `logical_at`：排队几小时才晋升的批次，计划时点早于真正开始，用 `logical_at` 会把上一批次的结果算进本轮），到下一个 `full` 批次开始为止；详情与评论在本轮内有成功任务即复用；视频 / 音频只要已有已验证资产就复用（字节不随时间变化） | 已定（刘学奎，2026-11-05 采纳；FS-D06） |
| 5 | 账号状态 `unavailable` 谁设置 | 本 spec **从不自动设置**账号或内容的 `unavailable` / `deleted`：供应商对无效链接、私密、已删除返回同一个 500，无法区分（A §9.2、D-54）。技术与业务不可访问都只记质量问题 | 已定（D-38、D-54） |
| 6 | 评论「自然翻完」何时可信 | 抖音：`has_more` 为 0 即自然结束，可标记疑似删除；小红书：**永远视为覆盖不完整**（D-50，实测 `has_more=0` 但 `total` 远大于返回），不标记疑似删除；达到页数 / 条数上限也不标记 | 已定（刘学奎，2026-11-05 采纳；FS-D08） |
| 7 | 周期同步是否带详情 | 否。周期批次只做主页 + 列表 + 头像 / 背景 / 封面；详情、评论、视频、音频全部由按需需求触发（D-31、PRD §6.11 第 1 条） | 已定 |
| 8 | 失败任务如何在下一周期前重试 | 提供 `batch retry-failed` 命令（运营触发），把 `failed` / `dead` 的任务放回队列并增加尝试额度；只在同一批次仍是最新 `full` 批次、下一个 `full` 批次尚未开始时允许。不做自动二轮重试 | 已定（刘学奎，2026-11-05 采纳；FS-D16） |
| 9 | 调度时区 | `Asia/Shanghai` 无夏令时，按固定 UTC+8 计算时点；`sync_settings.timezone` 为其他值时拒绝启动 | 已定（刘学奎，2026-11-05 采纳；FS-D15） |
| 10 | 视频 / 音频下载方式 | 视频流式写临时文件并边写边算 SHA-256，再分片上传 OSS；音频由 Python 能力服务通过**短期签名 URL** 读取已入库视频并返回 m4a 字节 | 已定（刘学奎，2026-11-05 采纳；FS-D10） |
| 11 | 按需详情 / 评论 / 视频请求如何拼 `url` | 供应商详情与评论接口要内容 `url`。抖音用列表观察到的 `share_url`，缺失时回退到 `https://www.douyin.com/video/{post_id}`；小红书用 `https://www.xiaohongshu.com/explore/{post_id}`（raw6 评论样本用过）；**快手没有可用样本**，快手详情在 smoke 证实构造方式之前保持 `disabled` | 已知缺口（design §14 第 2 项） |
| 12 | 运营处置命令是否属于本 spec | 属于：A §7.6「处理归属冲突」、§5.3 改绑、§5.5 确认已删除、§9.4 质量问题状态、§4.3 监控开关五级，路线图里没有别的 spec 拥有它们；页面不做 | 已定（刘学奎，2026-11-05 采纳；FS-D19） |

### 1.5 已确认事项（刘学奎，2026-11-05，全部采纳建议）

| # | 事项 | 结论 | 影响任务 |
|---:|---|---|---|
| 1 | 单账号补抓遇到全量批次 | 增加第三项 `run_now`（默认，并行）；A PRD §7.1 在任务 0 修订并补版本记录 | 任务 0、3 |
| 2 | 按需详情的落点 | 种子快照方案（FS-D05）；`content_snapshots.seeded_from_snapshot_id`（v2 R1） | 任务 1、6 |
| 3 | 评论完整性口径 | 抖音自然翻完为完整；小红书永不完整；触达上限不完整（FS-D08） | 任务 6 |
| 4 | 视频 / 音频方案 | 流式临时文件 + 分片上传；音频走短期签名 URL；ADR-0012 补记（FS-D10） | 任务 7、8 |
| 5 | 运营处置命令纳入本 spec | 纳入，只做 CLI（FS-D19） | 任务 9 |
| 6 | 数值配置 | **没有默认值**，缺失启动失败。smoke 前的起步值已采纳（见 design §14 第 6、7 项），不写进代码默认值 | 任务 4、5 |
| 7 | 分支 | 先把 `a-master-data-import` 合并 `main`，再切 `a-full-sync`；同时确认其品牌 / 板块编码命名（`hitachi` / `hisense` / `york_vrf`，`{分公司}-water` / `{分公司}-home`） | 任务 0 |

### 1.6 范围

#### 1.6.1 范围内

- 周期计划、批次生命周期（排队 / 跳过 / 过期 / 取消 / 补抓）；
- 有效监控目标集（五级 + 账号状态 + 录入状态）与领取时复核；
- 任务图、MySQL 任务表领取、租约、fencing、并发与速率、优雅停机；
- 抖音、小红书、**快手**的主页与内容列表多页采集、检查点、连续性缺口、游标异常；
- 内容快照定稿、current 选择（账号级封口）；
- 按需采集接入契约：详情、评论、视频源、音频（FS-8～FS-10）；
- 媒资：头像 / 背景（周）、封面（首次）、视频与音频（按需）、快手封面经 CDN 转换、续用旧资产；
- 失败分类、有界重试、死信、`retry-failed`；
- 手工补抓、批次取消、外部监控账号（只采主页）；
- 运营处置命令与查询、成本与新鲜度；
- ODS 一年清理的定时执行（A5、I5）；
- Python 能力服务的 HTTP 外壳（图片标准化、音频抽取）；
- CLI：`pnpm sync …`。

#### 1.6.2 范围外

- 活动计划、名单导入、15 天停采、计划恢复重开、疑似空账号人工确认：`a-activity-plan`；
- 圈定逻辑、判定、规则：`d-rule-engine`；信号抽取：`c-signals`；
- 真实用户登录、DataScope、持久化审计：`b-access-control`；
- 页面、台账、处置工作台：F3 / 2.0；
- 视频号（2.0）；图文图片归档（2.0）；评论回复树与评论作者账号；
- 同步频率超过每周两个时点、全局提频；
- 自动二轮重试、自动对账 ambiguous 调用（只读查询按 tracer 规则有界重发一次）；
- 多 worker 进程的分布式限流（1.0 单 worker 进程，见 design §12）；
- 生产部署、compose、告警渠道（I 域）；
- 修改 tracer 已验收的语义（封面规则与外部账号分支除外，见 §1.3）。

### 1.7 旧系统（lxk-BigSpard）经验的吸收

依据：[`爬虫四环节问题复盘与解法.md`](../../../HBECHO设计方案/archive/legacy/项目历史文档/爬虫四环节问题复盘与解法.md)、[`项目全面复盘与重构建议.md`](../../../HBECHO设计方案/archive/legacy/项目历史文档/项目全面复盘与重构建议.md)。逐条对照见 design §2.3。本 spec 因此新增或收紧的要求：

| 旧系统教训 | 本 spec 的吸收 |
|---|---|
| 失败账号放批次队尾统一重试，不立即重试 | FS-12.2、FS-3.2 |
| 供应商整体故障时逐账号重试只会烧额度 | FS-3.7（provider 熔断） |
| 「成功」不等于「对」：抓到别人的号没有报错 | FS-4.3、FS-5.13、FS-15.7 |
| 厂商返回 200 但字段残缺会静默写入 | FS-4.8 |
| 平台声称的作品数从未用来校验 | FS-5.14 |
| `has_more` 缺失时只能猜 | FS-5.9 |
| 批量写库默认 dry-run | FS-14.6 |
| 商用 API 无法验证对不对，需要抽样对账 | FS-15.8 |

### 1.8 外部审查修订记录（2026-11-05）

对一份外部审查意见逐条核对原文后的采纳结果（审查基于 requirements / design 的同日初稿）：

| 审查项 | 结论 | 落点 |
|---|---|---|
| v2 §12.3 第 2、6 条未进修订清单 | 属实，采纳 | §1.3 R2 扩展、新增 R8 |
| 列表判定表对 `empty` 锚点、游标异常、`empty` 再返回空的处理 | 属实，采纳 | FS-5.3、FS-5.7；design §7.6 |
| 按需复用的「永久复用」口子 | 属实，采纳 | FS-8.4；design §7.8 |
| `purpose NOT NULL` 迁移无回填 | 属实，采纳 | R4；tasks 任务 1 |
| A PRD §7.3 与 spec 采集分工冲突 | 属实，采纳 | §1.3 P2；tasks 任务 0 |
| 重试回队尾在混合优先级下 | 部分成立（同优先级内成立），采纳为澄清 | FS-12.2 |
| 全部取消的批次判 `succeeded` | 属实，采纳 | FS-1.7 |
| 品牌状态无原因码、`account_unavailable_excluded` 无触发 | 属实，采纳；并补充大区状态（C5 链） | FS-2.1、FS-2.4 |
| 封面「数组第 2 条」未显式保留 | 实现未丢（解码器不变），文档缺，采纳 | FS-11.1 |
| 名单导入后立即采集无入口 | 属实，采纳 | FS-13.4 |
| 页面归属与 ui-foundation 冲突 | 属实（仅「账号与监控」一行），采纳 | ui-foundation §3 |
| INDEX 与 tasks 状态矛盾；§1.4 与 §1.5 不同步 | 属实，采纳 | INDEX、§1.4 |
| `terminal` 语义 | 措辞问题，实现不需新列，采纳澄清 | FS-11.7；design §7.10 |
| tracer 校验类立即重试 vs 回队尾 | 属实，采纳 | FS-12.2 |
| 种子快照必填列 | 属实，采纳 | design §7.8 |
| `source_content_snapshot_id` 与 `seeded_from_snapshot_id` 职责重叠 | 属实，采纳（解释区别） | design §7.8 |
| ADR-0012 二进制 body 例外 | 属实，采纳 | tasks 任务 0；design §7.10 |
| acceptance 内部不一致（D4 / D10、C3 排序） | 属实，采纳 | acceptance D 组、C3 |
| `has_more` 缺失进判定表；`empty` 再返回空 | 属实，采纳 | design §7.6 第 1、9 行 |
| 自比对「上一周」口径 | 属实，采纳 | FS-5.14；design §7.6.2 |
| 音频无字节上限 | 属实，采纳 | FS-11.7；design §7.10 |
| 任务 0 分支动作与现状冲突 | 属实，采纳 | tasks 任务 0 |

**实施期复核（任务 2、3 之后，同日）**：对一份外部评审意见逐条核对代码与原文后的结论：

| 评审意见 | 结论 | 落点 |
|---|---|---|
| tick 顺序应保持「先过期、后创建」，改文档而非代码 | 采纳 | FS-1.4；acceptance A6、A18 |
| `cancelBatch` 与 `cancel_current` 没有范围校验 | 属实，采纳：批次级命令 1.0 只允许全范围服务身份，受限身份在任何读写前拒绝 | FS-20.1；`commands.ts` |
| `demand` 批次没有终态归属 | 属实，登记到任务 6（`summary.ts` 当前只汇总 `full` / `supplement`） | tasks 任务 6 |
| R6 现状写错（代码里早有 `kuaishou.user_id`） | 属实，已改正；任务 1 的结论本来就是不需要新迁移 | R6 |
| `*_number=null` + `*_count=0` 会得到真实 0 | 属实（仅限详情）：优先字段显式 null 时不再回退 | `decode-detail.ts` |
| `--if-older-than` 取较早者 spec 没写 | **不成立**：FS-13.4 已写（「主页与列表两者中较早的那个」） | — |
| `--only profile` 的依据是延伸 | **不成立**：A §11.2 第 ⑥ 步与要点写了「只调主页接口、内容采集不在此刻触发」，FS-D30 已引用 | — |
| 补抓 `dup` 重放不会推进 `planned` 批次 | **不成立**：`out.status === 'planned'` 对重放同样成立，会再规划一次（幂等） | — |
| `explain` 对断链的 staff 型报 `brand_inactive` | **不成立**：`stores` 的 dealer / brand / sector 与上级外键都是 NOT NULL，链不可能断；缺失只会来自归属行不存在（`no_assignment`） | — |
| `staging` 没有 capability 行 | 非缺陷：tracer 起就是「test + production」两行，staging 一律 `unregistered`，即 fail closed；任务 4 的 worker 配置决定是否拒绝 `HBECHO_ENV=staging` | tasks 任务 4 |
| 非抖音多候选视频默认取第一个 | 部分成立：小红书 / 快手的候选在样本里没有可区分的优先级依据（同主机、无分辨率标记）；`rankVideoSources` 返回全部可用候选，任务 7 的下载必须按顺序逐个尝试，失败换下一个，不能只取第一个 | FS-11.5；tasks 任务 7 |

**任务 4 之后的复核（同日）**：对第二份外部评审意见逐条核对后的结论：

| 评审意见 | 结论 | 落点 |
|---|---|---|
| CLI 仍允许 `staging`，只有 worker 拒绝 | 属实，采纳：运营命令也拒绝 | `sync-main.ts` |
| 按需详情 / 评论缺 `account_id` 时资格复核直接放行 | 属实，采纳：框架 fail closed；任务 6 必须写 `account_id` | `eligibility.ts`；tasks 任务 6 |
| `claimNext` 没有过滤 `expires_at` | 采纳（一行） | `claim.ts` |
| 媒资 terminal 失败会被重试到 dead | 属实，登记到任务 7 | tasks 任务 7 |
| 预算保守口径使并发 4 时实际可用约 1/4 | **夸大**：在途调用只占用最多 C−1 次调用的额度，是瞬时的；任务 10 记录比值即可 | tasks 任务 10 |
| 重试退避没有环境变量 | design §7.11 已写沿用 `DEFAULT_RETRY`；§10 补一句 | design §10 |
| 令牌桶 `acquire` 不能被停机中断 | 接受，QPS 很低时最多等一个间隔 | — |

**第二轮复核（同日）**：

| 审查项 | 结论 | 落点 |
|---|---|---|
| `--only profile` 的依据是虚构的 | **部分不成立**：语义在 A §11.2 第 ⑥ 步与要点里（只调主页接口、内容采集不在此刻触发），但本 spec 把出处写成了 §11.5；出处已改正。老账号满一周「立即采」PRD 没说采什么，已注明是本 spec 的默认 | FS-13.4；FS-D30 |
| v2 §9.2 `skipped` 的语义没改 | 属实，采纳 | §1.3 R8 |
| design §7.11 / §7.5 仍写「所有未重试任务之后」 | 属实，采纳 | design §7.5、§7.11 |
| `round_start` 用 `started_at` 而 §1.4 写 `logical_at` | 属实，采纳 `started_at`（理由见 §1.4 第 4 项） | §1.4、术语表 |
| `informational` 在 `media-failure` 里不存在 | 属实，采纳（任务 7 新增该分类） | design §7.10；tasks 任务 7 |
| `empty` 模式 `has_more=true` 措辞矛盾 | 属实，采纳 | design §7.6 |
| `--if-older-than` 的「最近成功同步时间」未定义 | 属实，采纳 | FS-13.4 |
| acceptance 编号乱序 | 属实，采纳（D 组重排、H14 移位） | acceptance |
| 品牌 / 大区没有「各自开关」，与宪法 C5 措辞不符 | 属实；刘学奎选 A（改宪法措辞），已执行 | §1.9；constitution v1.1 |

### 1.9 已裁决（刘学奎，2026-11-05）

外部审查发现：宪法 C5 原写「完整归属链的业务状态与**各自开关**」，但 `CONTEXT.md` 与 D-36 只有五级开关，`brands` / `regions` 没有 `monitoring_enabled` 列。**裁决：A**——修订宪法 C5 为「监控开关只有五级，品牌与大区只有业务状态、没有开关」（constitution v1.1 已改，变更记录已登记）；目标集保持现状，对品牌与大区只检查业务状态（`brand_inactive` / `region_inactive`）。不给 `brands` / `regions` 加开关列，D-36 不扩展。

## 2. 术语

| 术语 | 含义 | 来源 |
|---|---|---|
| 全量批次（`full`） | 到点生成的周期批次，全系统同一时刻只允许一个运行 | A §7.1 |
| 补抓批次（`supplement`） | 运营对单个（或少数）账号手工触发的批次 | A §7.6、§11.5 |
| 按需批次（`demand`） | 规则域提出采集需求时创建的批次 | PRD §6.11；本 spec |
| 同步轮次（round） | 最近一个已开始的 `full` 批次起到下一个 `full` 批次开始为止的时间段；按需采集的复用边界 | 本 spec FS-D06 |
| 有效监控目标 | 五级业务状态与开关、账号状态、录入状态共同算出的「本轮该采」的账号集合 | CONTEXT EffectiveMonitoring |
| 账号级封口 | 一个账号的列表任务终态后，其本批次 `building` 快照定稿并参与 current 比较 | 本 spec FS-D04 |
| 种子快照 | 按需批次里以内容当前 finalized 快照的值与状态为起点建立的 `building` 快照 | 本 spec FS-D05 |
| 采集需求（CollectionDemand） | 规则域向 A 提出的「这批内容要详情 / 评论 / 视频 / 音频」，A 只执行不决定 | PRD §6.11 |
| 死信（`dead`） | 有界重试耗尽的任务；`failed` 指不可重试的稳定失败 | v2 §9.3 |
| 视频源 / 音频轨 | 按需归档的正式媒资；音频是从视频抽出的 m4a / AAC 原样 | A §10 |

## 3. 需求

### 需求 FS-1 · 周期计划与全量批次生命周期

**用户故事**：作为平台运营，我希望每周到点系统自动开始一轮全量同步，上一轮没跑完时不无限堆积，也不悄悄丢失，以便我知道每个时点发生了什么。

#### 验收标准

1. 当 `Asia/Shanghai` 时间命中 `sync_settings.schedule_slots` 的某个时点（每周 1–2 个）时，同步调度 SHALL 为该时点创建恰好一个 `scheduled` / `full` 批次，批次键由时点 UTC 值确定性生成；同一时点重复触发 SHALL 返回已有批次，SHALL NOT 创建第二个。
2. 创建批次时，调度 SHALL 冻结 `sync_settings` 与运行时配置到 `settings_snapshot`，之后批次内所有任务只读取该快照，SHALL NOT 读取实时设置。
3. 错过的时点（调度器当时未运行且超出容忍窗口）SHALL NOT 自动补跑。
4. 当没有运行中的 `full` 批次时，新批次 SHALL 进入 `running`；当已有一个运行中批次且队列为空时，新批次 SHALL 进入 `queued`；当队列里已有一个**未到期**的等待批次时，新触发 SHALL 创建 `status='skipped'` 的摘要批次（`skip_reason='queue_full'`），SHALL NOT 创建任务。排队批次到下一个计划时点即到期（第 6 条），而新触发恰好发生在这个时点，所以 SHALL 先处理过期、再创建：到点时排队批次先 `expired`，新触发接替并排队（A §7.1「由新的触发接替」）；`queue_full` 只在存在尚未到期的排队批次时出现。
5. 当上一个 `full` 批次进入终态时，调度 SHALL 立即把排队批次提升为 `running`；提升时才规划任务（FS-2），SHALL NOT 使用排队期间过期的目标集。
6. 当排队批次到下一个计划时点仍未开始时，调度 SHALL 将其标记为 `expired` 并让运营可见。
7. `full` 批次的终态 SHALL 由结构化任务（`fetch_profile` / `fetch_content_list`）决定：全部成功且无连续性缺口为 `succeeded`；有失败、死信或缺口且至少一个成功为 `partial_succeeded`；没有成功且有失败为 `failed`。因监控资格失效而取消的任务 SHALL 计入 `skipped_task_count`，SHALL NOT 影响终态判定；但规划了任务而**全部**被跳过（没有任何成功与失败）时，批次 SHALL 为 `skipped`、`skip_reason='all_targets_closed'`，SHALL NOT 记为 `succeeded`；规划任务数为 0（没有有效监控目标）的批次同样为 `skipped`、`skip_reason='no_targets'`。
8. 媒资下载任务 SHALL NOT 决定批次终态；批次终态后媒资继续推进，全部终态时写入 `media_finished_at`（v2 R5）。
9. 调度器崩溃或重启后，处于 `planned`（任务规划到一半）的批次 SHALL 被恢复并继续规划，已规划的任务不重复。
10. 同一时刻 SHALL 至多一个 `purpose='full'` 的批次处于 `running`。

### 需求 FS-2 · 实际监控目标集

**用户故事**：作为平台运营，我希望系统只采该采的账号，上级关闭、专员离职、门店撤店时账号立即停采且归属不变，以便不白花调用也不丢身份。

#### 验收标准

1. 批次规划 SHALL 为每个满足下列全部条件的账号生成任务：账号 `status IN ('active','unavailable')`；归属行 `monitoring_enabled=TRUE`；`intake_status='normal'`；对 `watch_type='staff'` 另需专员、门店、经销商、分公司（经板块）的业务状态均为有效且各自 `monitoring_enabled=TRUE`，并且门店所属**品牌**与分公司所属**大区**的业务状态为有效（C5 的完整归属链；品牌与大区没有监控开关）。
2. `watch_type='external'` 的账号 SHALL 只受账号状态与自身开关约束，SHALL NOT 受五级开关与「15 天无引用」约束。
3. `status='deleted'`、`intake_status='suspected_empty'` 的账号 SHALL NOT 被规划；专员或门店停用后其名下账号 SHALL NOT 被规划，归属与历史数据保持不变。
4. 规划结果 SHALL 能解释每个被排除账号的原因，按「最上级优先」取一个原因码（`branch_off` / `dealer_off` / `store_off` / `staff_off` / `account_off` / `staff_inactive` / `store_closed` / `dealer_inactive` / `branch_inactive` / `region_inactive` / `brand_inactive` / `deleted` / `suspected_empty`），供状态查询与「XX 被关闭」展示。
5. 上级开关关闭后下级自身开关值 SHALL NOT 被改写；上级恢复后按下级原值继续。
6. 任务被领取、发出任何付费调用之前，worker SHALL 复核该账号当前是否仍有效监控；失效时任务 SHALL 以 `cancelled` / `monitoring_closed` 结束且不发起调用，并计入 `skipped_task_count`。
7. 目标集规划 SHALL 在事务外分块（每块至多 500 个账号），SHALL NOT 一个事务写完全部任务。

### 需求 FS-3 · 任务图、幂等、租约与并发

**用户故事**：作为运维，我希望 worker 崩溃、重复触发、两个 worker 抢同一任务时不会重复付费，也不会出现两份结果。

#### 验收标准

1. 每个目标账号 SHALL 在批次内至多有一个 `fetch_profile` 任务和一个 `fetch_content_list` 任务；`external` 账号只有 `fetch_profile`。任务幂等键 SHALL 由 `batch_id + account_id + action`（按需任务另含 `content_id` 与角色）确定性生成，重复规划不产生重复任务。
2. worker SHALL 用 `SELECT … FOR UPDATE SKIP LOCKED` 从 MySQL 任务表领取，按 `priority DESC, attempt_count ASC, task_id` 排序（**重试过的任务排在所有未重试任务之后，即回到队尾**，见 FS-12.2）；只领取 `running` 批次的任务，媒资任务另允许领取已终态（未取消）批次的任务。
3. 领取 SHALL 写入限时租约与单调递增的 fencing token；租约过期的任务 SHALL 可被另一个 worker 领取；陈旧 worker 的任何写入（页投影、检查点、current、媒资终态）SHALL 在 token 不匹配时整笔失败。
4. 每次发起供应商调用或下载之前，worker SHALL 先心跳续租；续租失败（已取消或被取代）SHALL 立即停止，不再发起调用。
5. 同账号同动作已有活动任务（跨批次）时，创建任务 SHALL 复用而不是并发重复；复用 SHALL 在持有账号行锁的短事务内判断。
6. 网络 IO（供应商调用、媒资下载、OSS 上传、能力服务调用）期间 SHALL NOT 持有数据库事务。
7. worker SHALL 区分**账号级失败**（`RESULT_VALIDATION_FAILED`、身份不符、字段缺失）与**供应商级失败**（429、5xx、传输错误、超时）。连续 K 次供应商级失败（K 为配置，无默认值）SHALL 打开 provider 熔断：暂停领取该 provider 的新任务一个冷却期，冷却后只放行一个探测任务，成功才恢复；账号级失败 SHALL NOT 计入熔断。熔断期间任务保持 `pending`，SHALL NOT 消耗尝试额度。
8. worker SHALL 受全局并发上限与按 provider 的速率上限约束；两项数值没有默认值，缺失时启动失败（C18）。
9. worker 收到停机信号后 SHALL 停止领取新任务，在宽限期内完成或放弃在途任务；放弃的任务保持租约过期后可被重新领取，SHALL NOT 留下无法恢复的状态。
10. 进程崩溃后重新领取任务时，SHALL 先恢复该任务 `in_flight` 的供应商调用（标为 ambiguous 并按只读查询规则最多重发一次），再继续；已完成的页 SHALL NOT 重新请求。

### 需求 FS-4 · 账号主页周期采集

**用户故事**：作为数据下游，我希望每个账号每周有一份不可变的主页快照，采集失败时不变成「粉丝数为 0」或账号状态变化。

#### 验收标准

1. `fetch_profile` SHALL 对已存在账号调用 `media_user_info`，经 capability 门控、raw-before-parse、版本化解码，写一份主页快照并按 `(logical_at, batch_id)` 比较更新 current；每账号每批次至多一份。
2. 值状态 SHALL 保留真实 `0` / 缺失 / 显式 `null` / 非法 / 不支持，SHALL NOT 互相转换。
3. 主页返回的账号 ID 与任务账号已登记的标识不一致时 SHALL 视为 `profile_uid_mismatch`：不写快照、不下载媒资、任务终态失败；记质量问题并保存证据（期望标识、实际标识、发送的入口、ProviderCall 引用）；SHALL NOT 改写已登记的标识（保留原值才留得下线索），SHALL NOT 自动绑定、换号或新建账号。身份校验的基准 SHALL 是本次供应商返回的标识，SHALL NOT 用库里被覆盖过的值兜底。
4. 技术失败（传输、限流、5xx、解析、存储、超时）SHALL NOT 改变账号状态，SHALL NOT 产生空快照或把指标写成 `0`。
5. 对已存在账号，`RESULT_VALIDATION_FAILED` 在有界重试耗尽后 SHALL 以 `failed` / `provider_input_inaccessible` 结束并记质量问题 `account_inaccessible_suspected`，SHALL NOT 设置 `unavailable` 或 `deleted`；之后某次主页成功 SHALL 自动将该问题标记为已解决（`resolved_by_actor='system:recovered'`）。
6. 主页成功但粉丝与作品数均为 `0` 的已有账号 SHALL 照常写快照，SHALL NOT 变更 `intake_status`。
7. 抖音主页 SHALL 产生头像、背景媒资引用；小红书与快手主页 SHALL NOT 臆造这两类引用。
8. 主页响应的账号标识有效，但粉丝、关注、获赞、作品数四项**全部**不是有效值（缺失 / `null` / 非法）时，SHALL 视为响应残缺：不写快照，任务按可重试的 `profile_fields_missing` 处理，SHALL NOT 写出「全部缺失」的快照冒充成功（旧系统教训：厂商返回 200 但字段残缺会静默写入）。

### 需求 FS-5 · 内容列表多页采集、检查点与连续性缺口

**用户故事**：作为数据下游，我希望每周只抓新增部分，但能证明没有漏；漏了就明确记缺口，不假装完整。

#### 验收标准

1. `fetch_content_list` SHALL 从第一页开始，对每个返回页**整页处理**（内容身份、`building` 快照候选、discovery）后，才判断是否继续；`initial_content_limit` 与任何本地上限 SHALL NOT 截断已返回页（C8）。
2. 第一页位置 1–3 SHALL 标记为可能置顶并正常入库，SHALL NOT 单独作为停止依据；第一页第 4 条起和后续页所有条目按时间序列判断。
3. 有旧锚点时，边界判断 SHALL 为：`time` 模式下出现旧高水位 ID，或 `published_at` 严格早于旧高水位时间；`id_window` 模式下出现旧 ID 窗口任一 ID；`empty` 模式没有边界，只抓首个完整页：本轮有内容时，处理完整页后任务 `succeeded` 并**重建锚点**（`time` 或 `id_window`），SHALL NOT 记缺口（上一次本来就没有内容，不存在被漏掉的区间）。命中后处理完当前整页，任务 `succeeded`，不再请求下一页。
4. 未命中且 `has_more=true` 时 SHALL 继续翻页；达到 `list_safety_page_limit` 仍未命中时，任务 SHALL 为 `succeeded_with_gap`，`window_overflow_detected=TRUE`、`stop_reason='safety_limit_rebased'`，记质量问题 `continuity_gap`，不自动续跑。
5. `has_more=false` 仍未命中旧边界时，任务 SHALL 为 `succeeded_with_gap`，`stop_reason='end_of_list_rebased'`，`window_overflow_detected=FALSE`，记 `continuity_gap`。
6. 缺口发生后 SHALL 用本轮已获取的全部内容重建锚点（有有效发布时间用 `time`，否则用首页内容 ID 作 `id_window`），检查点置 `rebased_after_gap`，下一周不追旧缺口。
7. 本轮返回空列表而已有非空旧锚点时，SHALL NOT 覆盖旧锚点：检查点置 `blocked`，任务 `succeeded_with_gap`，`stop_reason='empty_window_not_rebased'`；之后仍只抓首页，直到获得可用时间或 ID。首次采集（无旧锚点）或旧锚点本身是 `empty` 而本轮仍返回空列表且 `has_more=false` 时，建立 / 保持 `empty` 锚点，任务成功，检查点 `ready`。
8. 没有旧检查点的账号（例如名单导入后第一次周期同步）SHALL 按首次采集处理：整页处理，累计条目达到 `initial_content_limit` 即停止并建立基线，供应商仍有更多历史 SHALL NOT 算缺口。
9. 游标 SHALL 类型保真：抖音整数、小红书字符串、快手科学计数法字符串；SHALL NOT 互转。`has_more` 缺失或非法 SHALL 按游标异常处理（停止翻页、记 `cursor_no_more_with_has_more` 或 `has_more_invalid`，按自然结束处理锚点），SHALL NOT 猜测。进程中断后 SHALL 从已提交页的下一游标继续，不重复请求已提交的页。
10. 检查点 SHALL 仅在该账号本批次全部已返回页的必需投影成功后推进；任一条目投影失败 SHALL NOT 推进检查点；较旧批次或陈旧 worker 的推进 SHALL 被版本比较拒绝。
11. 跨页重复出现的内容 SHALL 在同一批次同一账号内合并为一条内容、一份快照、一条 discovery，每个出现都被处理且位置证据保留在调用 / 页摘要中。
12. 小红书列表 SHALL 沿用主导作者策略 `xhs-dominant-author.v1`（首页完整页上计算一次）；抖音 SHALL 沿用 `same_payload` 的第二标识绑定；异作者内容保留但不建账号（沿用 tracer）。
13. 列表身份交叉校验：已知该账号的作者标识（抖音 `user_id` / `sec_uid`、小红书已绑定的内容作者 ID、快手 `user_id`）且本任务累计条目 ≥ 5 时，若**没有任何一条**由这些标识创作，SHALL 判 `list_author_mismatch`：该账号本批次已投影的 `building` 快照 SHALL 被清除，检查点 SHALL NOT 推进，任务终态失败，记质量问题（带条数与期望标识）；条目不足 5 条或尚无已知作者标识时记为「无法判定」，SHALL NOT 判错。校验结果（`verified` / `unverifiable` / `mismatch`）SHALL 写入任务 `result_summary`，供 FS-15 汇总。
14. 自比对：列表任务成功后，若本批次主页的 `post_value` 比该账号**上一份更早的主页快照**多 k（k > 0）条，而**自那份快照的接收时间以来**首次发现的内容少于 k 条（不限批次，补抓批次发现的也算），SHALL 记警告级质量问题 `suspected_missing_content`（带 k 与实际发现数）；两周主页任一不是有效值则不比对；负增长不报。该问题 SHALL NOT 使任务失败或改变检查点。

### 需求 FS-6 · 内容快照定稿与 current

**用户故事**：作为下游消费者，我希望只读到已定稿的内容快照，旧批次迟到不会让 current 倒退。

#### 验收标准

1. 内容快照 SHALL 先以 `building` 写入；一个账号的 `fetch_content_list` 任务进入终态（成功、带缺口、失败、取消）后，SHALL 在一个短事务内按任务 fencing 把该账号本批次所有 `building` 快照定稿（账号级封口），并对每个内容按 `(batch.logical_at, batch_id)` 严格更新规则切换 current。
2. 列表任务失败或取消时，已投影的**可靠**条目 SHALL 仍被定稿（它们是供应商已返回的事实），检查点 SHALL NOT 推进；没有任何可靠条目的残留 `building` 行 SHALL 在恢复时清除。身份校验判为 `mismatch`（FS-5.13）的条目 SHALL NOT 算可靠，不被定稿。
3. 只有 `finalized` 快照 SHALL 成为 current；`building` 快照 SHALL NOT 被下游读取。
4. 旧批次（`logical_at` 更小）晚于新批次定稿时，SHALL 保留历史快照，SHALL NOT 回退 current 或检查点。
5. 评论、媒资下载 SHALL NOT 阻塞快照定稿。
6. 同一批次后到的有效值（含真实 `0`）覆盖先前值；后到的缺失 / `null` / 非法 / 不支持 SHALL NOT 擦除先前有效值；列表播放数 SHALL 保持 `unsupported`。

### 需求 FS-7 · 快手

**用户故事**：作为平台运营，我希望快手账号和抖音、小红书一样进入周期同步，快手没有的东西（评论、头像、背景）不被臆造。

#### 验收标准

1. 系统 SHALL 在 capability 表中登记快手 × `media_user_info` / `user_video_list` / `media_stats_number` 的同步模式与 `media_user_info` / `media_stats_number` 的异步模式为 `smoke_verified`（raw12、raw13、raw14），快手 × `user_video_list` 异步 SHALL 登记为 provider-failed 并保持 disabled；快手 × `post_comments_list` SHALL 不登记，任何调用在发请求前被拒绝。
2. 账号标识命名空间 SHALL 为 `kuaishou.user_id`（主页与列表作者同一空间），SHALL NOT 做第二标识绑定，昵称与主页链接不是绑定证据。
   > **待决（2026-11-06 smoke）**：该前提被真实数据推翻——同一快手账号的主页响应会在数字 ID（`2904903906`）与 `3x…` ID 之间变化。4 个成功入库的快手账号里 2 个出现 `profile_uid_mismatch`（主页与列表被拦下）。本条在决定前保持原样（不默认冻结任何别名绑定方案），按本条运行时约一半的快手账号会被反复拦下，见 [smoke 报告](smoke-report-2026-11-06.md) §4.2。
3. 快手列表游标 SHALL 作为字符串保真保存与回发（如 `1.785394950371E12`）。
4. 当快手列表返回 `max_cursor='no_more'` 且 `has_more=true`（raw12 K3、K6）时，系统 SHALL 停止翻页、记质量问题 `cursor_no_more_with_has_more`（D-53），并按「列表自然结束」处理锚点与缺口；SHALL NOT 回发 `no_more`。空列表 + `no_more` SHALL 等价于空窗口（FS-5 第 7 条）。
5. 快手主页 SHALL NOT 产生头像、背景引用；快手列表 `video.url` / `audio.url` SHALL NOT 作为视频或音频下载来源（D-48）。
6. 依赖评论的需求落在快手内容上 SHALL 在提交时返回 `unsupported_platform`，不生成评论任务（D-51）。
7. ~~快手详情请求的内容 `url` 构造方式未验证（§1.4 第 11 项）：在 smoke 证实前，快手详情 capability SHALL 保持 disabled，需求返回 `capability_disabled`。~~ 由 2026-11-06 真实 smoke 修订：`https://www.kuaishou.com/short-video/{post_id}` 被供应商接受（`https://v.m.chenzhongtech.com/fw/photo/{post_id}` 同样可用；`c.kuaishou.com/fw/photo/…`、`m.gifshow.com/fw/photo/…` 被拒绝），快手详情**同步**与**异步**模式都已放行（异步于同日用该形式真实验证：脏文案原样 6/6、规范 URL 6/6，提交 0.3–0.5 秒，轮询约 2 秒一次、不计点，端到端 5–25 秒）。见 [smoke 报告](smoke-report-2026-11-06.md)。

### 需求 FS-8 · 按需采集需求（Demand）

**用户故事**：作为规则域，我希望把「这批内容要详情 / 评论 / 视频 / 音频」交给 A 去办，A 先看本轮有没有，没有才抓，多个计划共享同一份。

#### 验收标准

1. A SHALL 提供 `submitDemand`：输入 `demandKey`（调用方幂等键）、提出方引用（`kind`、`ref`、`version`）、`ruleDecisionId`、`ruleVersion`、至多 5,000 条 `{ contentId, wants[] }`，`wants` 取 `detail` / `comments` / `video` / `audio`；同一 actor + `demandKey` + 相同规范化载荷 SHALL 返回原按需批次，载荷不同 SHALL 以稳定的幂等冲突原因拒绝。
2. A SHALL 只执行不决定：SHALL NOT 解释圈定条件、阈值或规则语义，SHALL NOT 在 A 域配置业务阈值；`ruleDecisionId` 与 `ruleVersion` SHALL 写入每个任务并随之保留。
3. 对每个 `{contentId, want}`，提交 SHALL 在创建任务前确定处置：`queued`（新建任务）、`reused`（本轮已有结果）、`already_pending`（已有活动任务，复用）、`unsupported_platform`、`capability_disabled`、`content_not_found`、`out_of_scope`（内容所属账号不在 actor 范围）。
4. 复用判定 SHALL 为：详情 / 评论 —— 存在该内容的 `succeeded` 任务且其**完成时间 ≥ 本轮起点**（不论任务属于周期、补抓还是按需批次；更早轮次的结果 SHALL NOT 复用，FS-D06）；视频 / 音频 —— 该内容已有已验证正式资产。`audio` SHALL 隐含 `video`，`video` SHALL 隐含 `detail`（需要新鲜下载地址）。
5. 按需批次 SHALL 是 `purpose='demand'` 的 `manual` 批次，不受全量串行约束，任务优先级高于周期任务；同一内容同一动作的活动任务跨批次 SHALL 复用。
6. 一次提交 SHALL 在事务外分块创建任务；崩溃后重放 SHALL 补齐缺失任务而不重复。
7. A SHALL 提供 `getDemand`：返回每个 `{contentId, want}` 的状态（`pending` / `running` / `ready` / `failed` / `unsupported` / `reused_ready`）、稳定失败原因，以及可读取结果的指针（内容快照 ID、评论抓取时间与覆盖口径、正式媒资 ID）。查询 SHALL 只读本地事实，SHALL NOT 调用供应商。
8. 单次提交的付费上限 SHALL 受批次点数上限约束；达到上限后未创建调用的任务 SHALL 以 `budget_exhausted` 终态，且 `getDemand` 如实展示，SHALL NOT 静默丢弃。

### 需求 FS-9 · 内容详情

**用户故事**：作为规则域，我希望圈定后的内容有详情（播放数、时长、下载地址），而且不破坏已有的列表事实。

#### 验收标准

1. `fetch_content_detail` SHALL 调用 `media_stats_number`（返回动作 `media_stats`，请求与响应动作分列），经 capability 门控与 raw-before-parse；`*_number` 优先、`*_count` 为回退，两者不并列为独立指标。
2. 按需批次 SHALL 为每个被请求内容建一行以当前 finalized 快照为种子的 `building` 快照（`seeded_from_snapshot_id` 非空，`list_observed=FALSE`，`detail_observed=TRUE`），再把详情有效值按 LaterValidValueWins 合并；详情成功后定稿并参与 current 比较。
3. 详情失败（含内容不可访问）SHALL 清除该内容的种子快照，SHALL NOT 改变内容 `status`（D-54），记质量问题 `detail_inaccessible` 或对应失败码；SHALL NOT 把失败写成播放数 `0`。
4. 详情的 `cover` / `download_urls` 在详情里是字符串（可能换行分隔），SHALL 展开为候选集后保留全部；小红书图文笔记 `play_number=null` SHALL 保持 `explicit_null`。
5. 详情的作者可能与被采集账号不同（共创），SHALL 沿用 tracer 的返回作者规则，SHALL NOT 创建账号。
6. 不依赖 `play_count` 等 `*_count` 全 `null` 的历史形态；未知新增字段 SHALL 保留在 ODS 并被解析层忽略。

### 需求 FS-10 · 评论

**用户故事**：作为规则域，我希望拿到内容的一级评论最新态，并清楚知道这份评论完整不完整。

#### 验收标准

1. `fetch_comments` SHALL 调用 `post_comments_list`（`reply_pages=-1`，不取回复），游标按字符串保真，`has_more` 的 `0/1` 整数归一为布尔；SHALL 受 `comment_page_limit` / `comment_item_limit`（至少配置一项）约束。
2. 只保存一级评论最新态；结果中带 `parent_id` 的条目 SHALL 被忽略并计数；SHALL NOT 创建评论作者账号、下载评论头像或建回复树。
3. 评论按 `(content_id, platform_comment_id)` 幂等 upsert；同一评论再次出现 SHALL 恢复 `active` 并清除疑似删除时间。
4. 仅当本次抓取被判定为**完整**（FS-D08：抖音自然翻完 `has_more=0`，且未触达页数 / 条数上限）时，先前存在而本次未出现的评论 SHALL 标记 `suspected_deleted`；部分抓取、触达上限、传输 / 解析失败、小红书 SHALL NOT 作为删除证据。
5. `total>0` 而结果为空数组 SHALL 记质量问题 `comments_total_mismatch`，SHALL NOT 记为 0 条评论；小红书 `total` 大于已抓取条数 SHALL 记 `comment_coverage_incomplete`，D / E 不得把小红书评论总数当完整（D-50）。
6. 小红书评论 `RESULT_VALIDATION_FAILED` 间歇出现 SHALL 在有界策略内重试（raw6）：任务回队尾后从已提交页的下一游标继续（FS-12.2），不在进程内原地重试；快手 SHALL 被 FS-7 第 6 条拒绝。
7. 评论抓取 SHALL NOT 写内容快照结构化字段，SHALL NOT 阻塞快照定稿。

### 需求 FS-11 · 媒资归档

**用户故事**：作为资产消费者，我希望头像、背景、封面、视频、音频都进入正式资产，按字节判同，失败时如实告诉我是不是在用旧的。

#### 验收标准

1. 封面来源沿用 tracer：抖音列表取封面数组**第 2 条**（540 宽），小红书 / 快手取单值；R3 只改变「何时建引用」，SHALL NOT 改变「选哪一条」。头像与背景（抖音）SHALL 每批次重新下载并计算 SHA-256；封面 SHALL 在内容**首次入库**时下载（v2 R3）；内容已有 `archived` / `carried_forward` 封面时 SHALL NOT 为新快照再建 `cover` 引用；上一次没有成功的封面 SHALL 在下次出现时用新地址重建引用。
2. 媒资下载 SHALL 作为独立 `download_media` 任务异步推进（每账号每批次一个，按需视频 / 音频另有任务），SHALL NOT 阻塞结构化阶段，状态独立可查。
3. 正式资产 SHALL 按完整字节 SHA-256 判同；同一字节多个引用共享一份资产；临时 URL SHALL NOT 成为身份，SHALL NOT 写入长期业务事实。
4. 快手封面（KVIF）SHALL 取 CDN `x-oss-process` 转换的 JPEG 作为标准化衍生图的来源，原始字节与衍生图同为独立资产；转换失败 SHALL 标记「封面不可用」并写质量问题 `media_cover_unavailable`，SHALL NOT 阻塞内容（D-62）。
5. 视频 SHALL 按平台选择来源：抖音优先 `api-play.amemv.com` / `api.amemv.com` 候选，SHALL NOT 用 `video.url`；小红书与快手用详情 `download_urls`（720p h264），快手 SHALL NOT 用列表 `video.url`；候选集 SHALL 全部保留；小红书 / 快手的候选没有可区分的优先级依据，SHALL 按响应顺序依次尝试，一个失败换下一个（A §9.2 不得「默认只取第一条」）。
6. 视频 SHALL 流式写临时文件并边写边算 SHA-256，再分片上传正式媒资桶并校验；单文件与单批次总字节受可配置技术上限约束；内存占用 SHALL NOT 随文件大小线性增长。
7. 音频轨 SHALL 由 Python 能力服务经短期签名 URL 读取已入库视频后抽取为 m4a / AAC 原样，作为独立正式资产保存；视频没有音轨 SHALL 记 `no_audio_track` 终态（引用 `failed` + 该错误码，按 `media-failure` 分类为 informational），SHALL NOT 重试、SHALL NOT 计入失败数；音频字节上限 = 源视频字节数（`-c:a copy` 不会比源更大）且不超过 `HBECHO_MEDIA_MAX_BYTES`。
8. 下载失败 SHALL NOT 影响结构化快照；上一份已验证资产可续用，但 SHALL 标记 `carried_forward` 并记录本轮失败，SHALL NOT 表示为本轮归档成功。
9. 下载 URL 过期（`source_expired`）SHALL 触发重新获取详情拿新地址再重试（有界），SHALL NOT 复用过期地址；其余失败按 `media-failure` 的分类处理。
10. 下载受超时、大小、类型、重定向与目标地址（含 DNS 解析后拒绝私网 / 回环 / 链路本地）限制；规则未圈中的视频 SHALL NOT 被下载。

### 需求 FS-12 · 失败分类、重试、死信与补跑

**用户故事**：作为运营，我希望失败有明确的原因和去向：能自动重试的重试，不能的停下来，周期结束前我能一键补跑。

#### 验收标准

1. 失败 SHALL 沿用 tracer 的分类并补充：`provider_input_inaccessible`、`cursor_anomaly`、`comment_coverage_incomplete`、`budget_exhausted`、`monitoring_closed`、`capability_disabled`、`unsupported_platform`、`content_url_unavailable`；每个任务终态 SHALL 带稳定的 `last_error_code`。
2. 可重试失败（限流、5xx、已知未送达的传输失败、间歇 `RESULT_VALIDATION_FAILED`）SHALL **不立即重试**：任务 `attempt_count + 1`，置 `retry_wait` 并回到本批次队尾（FS-3.2 的排序保证它排在所有未重试任务之后），再按退避设置 `next_attempt_at`；因此一个批次先把全部账号采一遍，再依次做第 2、3 轮重试（排序在**同优先级**内成立；被补抓提升过优先级的任务重试时仍排在更高优先级一档，这是运营显式要求的）。full-sync 的 Runner SHALL NOT 使用 tracer 的进程内 `attemptLoop` 原地重试；tracer 单账号录入流程保持原行为。每次尝试是新的 ProviderCall；达到 `task_max_attempts` SHALL 进入 `dead`；不可重试的稳定失败 SHALL 进入 `failed`。列表与评论任务重试时 SHALL 从已提交页的下一游标继续。
3. 已发送但结果不明的只读调用 SHALL 标记 `ambiguous`，最多再发一次，计入调用与点数预算；有副作用的调用不适用（本 spec 没有）。
4. 技术失败 SHALL NOT 转成空主页、空列表、空评论、真实 `0` 或「账号不存在」。
5. `batch retry-failed` SHALL 把本批次 `failed` / `dead` 任务放回 `pending` 并重置本轮尝试额度，条件是：该批次是最新 `full` 批次，且下一个 `full` 批次尚未开始；SHALL 记审计，SHALL NOT 重复已成功的任务。
6. 批次取消 SHALL 使未开始任务 `cancelled`、在途任务因租约失效而停止，已落 ODS 与已提交事实保留。
7. **同步 → 异步兜底**（刘学奎 2026-11-06 确认）：对**主页**（`media_user_info`）与**详情**（`media_stats_number`），配置为同步的任务在第 1 次尝试因超时、结果不明（`ambiguous`）或 `RESULT_VALIDATION_FAILED` 失败后，第 2、3 次尝试 SHALL 改走异步（提交 + 轮询各自是独立 ProviderCall），前提是该平台 × 动作的异步 capability 在当前环境已放行，否则保持配置的模式。其它失败（429、5xx、已知未送达的传输失败）SHALL 保持原模式。列表与评论 SHALL NOT 兜底（`call_sequence` 是页号；三平台异步列表稳定失败）。兜底之后的尝试沿用既有排序（`attempt_count` 升序），所以排在同优先级未重试任务之后。

### 需求 FS-13 · 手工补抓、批次取消与外部监控账号

**用户故事**：作为运营，我看到某门店数据没更新时能单独补一次；超管能把竞品和官方号放进来长期看主页。

#### 验收标准

1. `supplement` SHALL 对给定账号创建 `purpose='supplement'` 批次，任务与周期任务同类（主页 + 列表），优先级高于周期任务；账号不在有效监控目标集时 SHALL 拒绝并说明原因（FS-2 第 4 条）。
2. 当有 `full` 批次正在运行时，`supplement` SHALL 支持 `run_now`（默认，与全量批次并行）、`queue`（排到全量批次结束后）、`cancel_current`（取消当前全量批次后开始，需 `--apply`，记审计）；补抓批次 SHALL NOT 计入「同一时刻只允许一个全量批次」（该约束只针对 `purpose='full'`）。
3. 同账号同动作已有活动任务时，`supplement` SHALL 复用并提升其优先级，返回已有任务引用（FS-3 第 5 条）。
4. `supplement` SHALL 支持 `--only profile|full`（默认 `full`）与 `--if-older-than <小时>`：后者对每个账号检查「最近一次成功同步」时间，更近的账号 SHALL 被跳过；该时间的定义为：`--only profile` 取最近一份主页快照的接收时间；`full` 取**主页与列表两者中较早的那个**（任一过期就视为过期；从未成功过视为无限久）。被跳过的账号并返回 `not_due`，不创建任务。这是 `a-activity-plan` 实现 A 域 PRD 的调用入口：**§11.2 第 ⑥ 步与要点**规定名单导入后的首次采集「只调主页信息接口、内容采集仍按每周节奏、不在此刻触发」（对应 `--only profile`）；**§11.5 采集触发规则**规定新账号立即（异步）、老账号距上次采集已满一周立即、未满一周不立即（对应 `--if-older-than 168`；PRD 没写老账号立即采什么，本 spec 按完整采集 `full` 处理，是默认而非 PRD 原文）。本 spec 不实现计划联动，只提供该入口与逐账号处置（`queued` / `not_due` / `not_eligible`）。
5. 外部监控账号 SHALL 仅由超管（`monitor.external.manage`）创建，复用 tracer 的解析流程（≤3 次、非主页入口拒绝、成对写入），不要求专员；创建后 `watch_type='external'`，无组织链，owner 快照为空。
6. 外部监控账号 SHALL 只生成 `fetch_profile`（及头像 / 背景媒资），SHALL NOT 生成列表、内容、详情任务；SHALL 对 `hq_manager` / `branch_manager` 不可见（B-D22）。
7. 外部账号的启停 SHALL 只改自身开关（`monitoring_closed_reason='manual'`）。

### 需求 FS-14 · 运营处置命令

**用户故事**：作为运营，我需要在归属冲突、账号注销、监控范围变化时有受审计的处置手段，而不是改库。

#### 验收标准

1. `account rebind` SHALL 只由持有 `data.account.manage` 的主体执行：更新归属行的 `staff_id`，记审计（操作者、时间、原归属 → 新归属），不强制填原因；SHALL 校验新专员在该平台名额为空；SHALL NOT 改写已发生的 discovery 归属快照。
2. `account confirm-deleted` SHALL 将账号置 `deleted`、写 `slot_released_at` 释放该专员该平台名额、保留归属记录，记审计；SHALL NOT 物理删除任何数据。
3. `issue set-status` SHALL 允许把质量问题置为 `acknowledged` / `ignored` / `resolved`，记 `resolved_by_actor`；SHALL NOT 通过删除业务数据修复问题。
4. `monitoring set` SHALL 支持分公司、经销商、门店、专员、账号五级开关；经销商级仅超管；关闭账号级 SHALL 写 `monitoring_closed_reason='manual'`；上级关闭 SHALL NOT 改写下级开关值。
5. 分公司主体 SHALL NOT 停用专员主档；本 spec 不提供停用专员命令（主数据修正归 `a-master-data-import` 的范围）。
6. 影响面不止一个对象的命令（`monitoring set` 在分公司 / 经销商 / 门店 / 专员级、`batch cancel`、`batch retry-failed`）SHALL 默认只做预览（输出受影响的账号数 / 任务数与前 20 个示例），SHALL 在显式带 `--apply` 时才写入（旧系统教训：批量写库默认 dry-run）。
7. 全部命令 SHALL 经受限服务身份、Capability 校验、品牌 / 平台范围校验，并写审计事件。

### 需求 FS-15 · 状态查询、成本与新鲜度

**用户故事**：作为运营，我希望一眼知道本周同步到哪了、缺了什么、花了多少，以及哪些账号太久没更新。

#### 验收标准

1. `sync status` / `batch <id>` SHALL 只读本地事实，返回：批次状态与用途、各动作 × 状态的任务计数、缺口数、失败原因分布、媒资进度（总 / 待 / 已归档 / 续用 / 失败）、已发出调用数与按点数表估算的点数与金额；SHALL NOT 调用供应商。
2. `account <id>` SHALL 返回该账号最近若干批次的主页 / 列表结果、检查点状态（锚点模式、游标类型、连续性状态、最后缺口时间）、被排除原因、相关质量问题。
3. `freshness` SHALL 列出「最近成功主页与列表同步时间」超过一个计划间隔的有效监控账号数与明细。
4. 状态 SHALL 脱敏凭证、原始载荷、完整 OSS key、临时 URL。
5. 成本估算 SHALL 区分「已计点（成功）」与「可能已计费但未知（ambiguous）」；`ambiguous` 的上界由调用数硬上限兜底（沿用 tracer 已登记的缺口）。
6. 批次级结果 SHALL 能回答 A 域 PRD §14 A4 的 `[手工]` 项：运营能看到批次级与账号级结果，以及失败原因。
7. 状态 SHALL 把身份校验结果分三类展示：`verified`（一致）、`unverifiable`（无法判定）、`mismatch`（不一致），**无法判定 SHALL NOT 与一致合并**（旧系统教训：分母为 0 的 `null` 与真实 0% 混在一起）。
8. `sample --n <N>` SHALL 随机抽 N 个本批次成功的账号，输出入口、账号标识与最新主页 / 列表摘要，供人工打开主页对账；只读，SHALL NOT 调用供应商。

### 需求 FS-16 · capability 门控与成本硬上限

**用户故事**：作为集成所有者，我希望新增的动作与平台在被验证前不会真的发出付费请求，花费有硬上限。

#### 验收标准

1. capability 表 SHALL 扩展到：`media_stats_number`（抖音 / 小红书 / 快手，同步与异步）、`post_comments_list`（抖音 / 小红书，同步与异步）、快手 `media_user_info` / `user_video_list`。证据等级 SHALL 按 §1.1 第 5 项与 A §6.3 登记：同步与已验证的异步 tuple 为 `smoke_verified`，抖音评论异步、三平台列表异步 SHALL 登记为 provider-failed 且保持 disabled；快手评论 SHALL 不登记。
2. 全部 `production` activation SHALL 保持 `disabled`，直到对应 tuple 的批准式 smoke 完成（FS-19）；`fixture_observed` 与 `smoke_verified` SHALL NOT 自动启用 production。
3. 点数表 SHALL 扩展为 A §6.2 的 1.0 数值（抖音：主页 10 / 列表 10 页 / 详情 10 条 / 评论 5 页；小红书：15 / 15 / 15 / 15；快手：10 / 10 / 10 / 不支持），单价 0.02 元 / 点；失败、超时、429、异步轮询 SHALL 不计点。
4. 每个批次 SHALL 有调用数与点数硬上限（运行时配置，无默认值）；达到上限 SHALL 在**下一次调用前**停止，后续任务以 `budget_exhausted` 终态，批次如实标记，SHALL NOT 告警后继续。
5. 同步 / 异步 SHALL 按 capability 与配置选择，SHALL NOT 把任一种写死为生产总策略；异步时提交与每次轮询分别是 ProviderCall。

### 需求 FS-17 · ODS 清理的定时执行

**用户故事**：作为运维，我希望一年前的原始证据自动清理，而且清理从不动结构化快照和正式媒资。

#### 验收标准

1. `maintain` SHALL 每日（北京时间 04:00，可配置）运行 ODS 清理（payload → call → task → 无引用 object）与孤儿对象清扫，可重跑、有界批量、写运维日志与计数。
2. 清理 SHALL NOT 删除结构化快照、归属、评论、检查点、正式媒资；`media` 桶 SHALL NOT 参与清理。
3. 清理失败 SHALL 保留现场并在下一次运行重试，SHALL NOT 级联删除业务数据。
4. 孤儿清扫 SHALL 覆盖 `smoke/ods/` 前缀（tracer acceptance 登记的缺口），不因前缀不同而漏扫；视频临时文件在 worker 本地磁盘，启动时清理超过 24 小时的残留，不属于 OSS 孤儿清扫。

### 需求 FS-18 · 默认离线验证与规模演练

**用户故事**：作为开发者，我希望整套同步逻辑在没有网络、没有付费的情况下可以被反复验证。

#### 验收标准

1. 默认套件 SHALL 阻断网络，使用 fixture transport、fake clock、fake lease、fake OSS、fake 媒资传输、fake 能力服务；SHALL NOT 要求 AI Master 凭证。
2. fixture SHALL 覆盖：抖音、小红书、快手各自的主页 / 多页列表（含边界命中、缺口、空窗口、`no_more`）、详情、评论（抖音可翻页、小红书部分覆盖、`parent_id` 条目）、错误路径（`RESULT_VALIDATION_FAILED`、HTTP 400）。
3. 故障注入 SHALL 覆盖：ODS 写失败、`in_flight` 后进程丢失、worker 租约过期被抢、陈旧 token 提交、页投影中途失败、媒资下载失败 / URL 过期、预算耗尽、批次取消。
4. SHALL 有一个 6,000 账号 / 三平台的规模演练（fake transport）：规划耗时、峰值内存、DB 行数、全程无并发重复任务；结果写入 design §12，超出预期则停下来问。
5. 本 spec 的新增代码 SHALL 复用 `tests/harness`，SHALL NOT 在测试里用 `Promise.all` 抢同一行锁（dev-ci-cadence 第 3 条）。

### 需求 FS-19 · 显式批准的付费 smoke

**用户故事**：作为集成所有者，我希望在不意外花费的前提下，验证新 tuple 在真实供应商上的行为。

#### 验收标准

1. smoke SHALL 排除在默认测试与 CI 之外，要求人工批准、显式开关、固定调用 / 点数预算与 allowlist（沿用 tracer 的 `smoke` 模块）。
2. smoke SHALL 至少覆盖：快手主页 + 列表（含 `no_more` 行为）、三平台详情（含快手内容 `url` 构造方式）、抖音与小红书评论（含小红书翻页行为）、一次视频下载 + 音频抽取（小文件）、两页以上列表的检查点命中。
3. 完成后 SHALL 输出审计摘要（action、计数、延迟、字节数、估算点数与金额、结果类别），不含 secret 与完整载荷。
4. 成功的 smoke SHALL 只验证实际执行的 tuple，SHALL NOT 自动启用未测试 capability；production 启用需要单独的人工批准。

### 需求 FS-20 · 授权与审计

**用户故事**：作为安全负责人，我希望每个命令都先校验身份与范围，并留下可追溯的事件。

#### 验收标准

1. 所有 CLI / Module 入口 SHALL 先校验 Capability 与范围，失败 SHALL 在任何供应商、媒资请求之前拒绝：补抓与取消 `data.sync.trigger`；改绑与确认删除、质量问题状态 `data.account.manage`；监控开关 `data.monitoring.manage`（经销商级仅超管）；外部账号 `monitor.external.manage`；调度参数与预算 `config.manage`。影响整个批次的命令（`batch cancel`、`supplement --on-busy cancel_current`）在 1.0 只允许全平台、全专员范围的服务身份，受限身份 SHALL 在任何读写之前以 `out_of_scope` 拒绝；B 域接入后再按批次内账号集合细化。
2. 周期任务 SHALL 以固定服务身份（`service:sync-worker`）运行，范围覆盖全平台被监控账号，且没有任何把数据交给某个人的出口（B PRD §10.3）。
3. 用户触发的任务 SHALL 继承提交者范围，交付前复查（B 域接入后生效；本 spec 先记录提交者 actor）。
4. 审计事件 SHALL 含 actor、时间、对象、批次 / 任务、前后状态，SHALL NOT 含 secret、原始载荷、临时 URL。
5. 按需采集的提出方 SHALL 经一个服务身份入口进入，SHALL NOT 绕过 A 直接取数或写任务表。

## 4. 需求级完成边界

只有当上文每一条 SHALL 都有可执行的离线检查或显式批准的 smoke 检查时，本需求才算满足。HTTP 成功不够：必须观察到整页基数、游标类型、锚点模式、缺口记录、账号级封口、current 不倒退、复用判定、评论完整性口径、媒资续用标记、预算停止点与「不改账号状态」。

§1.3 的八项 v2 修订与两处 A PRD 修订在落地前不得被实现默认值悄悄冻结；§1.5 的结论已确认，数值配置不得写成代码默认值。
