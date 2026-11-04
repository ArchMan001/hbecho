# A 数据底座 Tracer（a-data-foundation-tracer）· 需求

> **状态**：`draft`
>
> **模式**：Design-First
>
> **实现状态**：仅定义可验收需求；尚未执行 [`tasks.md`](tasks.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-data-foundation-tracer`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10（2026-11-04，定稿候选）
>
> **最近核对**：2026-11-04（按 A v1.10 与 raw4/raw5/raw8 校准）
>
> **更新日期**：2026-11-04（第二次：关闭 P0 默认值；一专员一平台一账号；只读查询有界重发；单一解析策略；CLI 调用；录入状态与实际监控）
>
> **语言约定**：正文中文；验收标准中的规范性关键词 `SHALL` / `SHALL NOT` / `MAY` 与技术标识保留英文（对齐 hbdam spec 的写法）。

## 1. 引言

`a-data-foundation-tracer` 证明数据底座的第一条纵向链路：一个已授权的内部调用方提交 `MediaStaff + 平台 + 主页入口` 后，系统能够追踪到稳定的 `ExternalAccount`，建立或复用账号并写入其当前归属，保存主页快照，完整处理首个已返回列表页，建立后续同步检查点，并异步归档头像、背景图和内容封面。

首版验收平台是抖音和小红书。快手属于 `a-full-sync` 的范围（A v1.10 §13.1、D-47），本 spec 不验收。AI Master 只是本 Feature 内部的供应商 Adapter；需求不建设通用供应商 API 平台，也不宣称支持尚未实测的平台或 action。

### 1.1 权威顺序

冲突时按以下顺序裁决：

1. [`CONTEXT.md`](../../../CONTEXT.md)：领域词汇、身份、归属、发现、快照、媒资和时间不变量；
2. [`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md)：A 域产品语义的唯一真相源（v1.10）；它决定“做什么、给什么反馈、明确不做什么”；
3. [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)：数据底座技术基线。与第 1、2 项冲突时，按前两项修订 v2，不得在代码或局部 SQL 里暗中选择一方；
4. [AI Master V1.2 文档](<../../../aimaster接口文档/FieldShortcut A Master API 开发文档 V1.2.md>) 与已保存的 [`raw3`](../../../aimaster接口文档/测试结果/raw3/)、[`raw4`](../../../aimaster接口文档/测试结果/raw4-2026-10-28/)、[`raw5`](../../../aimaster接口文档/测试结果/raw5-2026-10-28/)、[`raw8`](../../../aimaster接口文档/测试结果/raw8-2026-10-28/) 证据：供应商声明与实测；二者冲突时必须显式记录，样本行为不能外推为长期合同；
5. 本需求文档与 [`design.md`](design.md)：本 Feature 的需求和设计；
6. `HBECHO设计方案/archive/` 及 `HBECHO设计方案/archive/legacy/项目历史文档/`：仅作历史输入，不能覆盖前述来源。

供应商文档与实测证据冲突时，不得静默猜测；应能力门控、记录差异并保留为未决合同。

### 1.2 基线冲突（2026-11-04 已全部修订）与范围区别

下表第 1～6 项是本 spec 编写时与 v2 的冲突，**已于 2026-11-04 在 v2 修订**，保留为追溯；实现以 v2 修订稿为准。第 7 项是范围区别，仍然有效：

| # | 冲突 / 区别 | 以谁为准 | 处理 |
|---|---|---|---|
| 1 | v2 `staff_account_assignments` 仍保留独立表与 `valid_from/valid_to` 区间语义；CONTEXT 与 A v1.10 §5.3 规定归属是账号上的当前单一事实 | CONTEXT / A v1.10 | v2 修订前不得据 v2 建此表；tracer 按“账号当前归属”实现 |
| 2 | v2 `content_snapshots` 按 `(batch, content)` 共享内容快照；CONTEXT §Content 与 A v1.10 §3.4/§9.2 规定按被观察账号分别保存，不跨账号合并。`content_discoveries` 已按 assignment 区分，但快照本身不区分账号 | CONTEXT / A v1.10 | v2 修订前，tracer 只在单账号场景验收，不得把“跨账号共享快照”当成已确认语义 |
| 3 | v2 `ValueState` 只有 `value/missing/explicit_null/invalid`；A v1.10 §9.2 规定列表接口播放数是“不支持”，不得写成 0 或 missing | A v1.10 | 需新增 `unsupported` 值状态并扩展 v2 CHECK；tracer 不得用 0/missing 冒充 |
| 4 | v2 `contents.content_kind` 包含 `mixed`；A v1.10 §9.2 只定义 `video/image/text/unknown` 的推断规则 | A v1.10 | tracer 按 A 的四类规则输出；`mixed` 不启用 |
| 5 | v2 没有“录入状态”（正常录入 / 链接无效 / 疑似空账号）字段或表 | A v1.10 §11.6 | tracer 用命令结果 + `data_quality_issues` 观察，不新增账号状态列；名单级录入状态留给后续导入 spec |
| 6 | v2 `media_references.role` 没有封面标准化衍生图角色 | A v1.10 §10.2 | 需要新增独立资产与引用语义；tracer 至少保证衍生图有独立 SHA-256 且不替代原始字节 |
| 7 | A v1.10 §11.2 的名单导入首次只调主页接口做账号核对，内容按周节奏；v2 §12.2 的单账号录入立即执行主页 + 首个完整返回列表页 | 本 spec 按 `prd-platform.md` §7.2 的 tracer 验收边界 | tracer 是单账号录入链路，不是名单导入；它的验收包含首个完整返回页。名单导入的“只调主页”留给后续导入 spec，不在此实现 |

第 1～6 项在 v2 的落点：① 归属行每账号一行（`UQ(account_id)`），无区间，带 `platform_id`；② `contents` 带 `account_id`，按被观察账号的内容根，快照键 `(batch_id, content_id)` 不变；③ `unsupported`；④ 去掉 `mixed`；⑤ 归属行 `intake_status`（`normal` / `suspected_empty`）；⑥ `*_normalized` 媒资角色。

## 2. 范围

### 2.1 范围内

- 受控提交、幂等根任务和本地状态查询；
- 主页入口类型识别、最小清洗和最多三次解析；
- AI Master `media_user_info`、`user_video_list` 以及异步任务查询；
- 每次供应商调用 raw-before-parse；
- 平台命名空间下的账号身份、标识绑定和冲突处理；
- `MediaStaff` 到 `ExternalAccount` 的当前归属；
- 主页快照、完整首屏内容快照和 `ContentDiscovery`；
- 类型保真的首个检查点与初始锚点；
- 头像、背景图和封面正式媒资的异步归档进度；
- 首次录入结果（正常录入 / 链接无效 / 疑似空账号）的可观察判定；
- 质量问题记录（身份冲突、字段异常、媒资失败、疑似空账号）；
- 离线 fixture 验收，以及独立、人工批准、预算受限的真实 smoke。

### 2.2 范围外

- 第二页及以后完整增量同步策略、周期调度和全平台普适爬取；
- 内容详情、评论、视频源、音频、OCR、ASR、活动考核、指标、看板和导出；
- 快手（由 `a-full-sync` 验收）和视频号（2.0）；
- 外部监控账号（`watch_type='external'`）及其监控清单；
- 活动计划、监控判定计划与名单导入；
- 图文的完整图片归档（2.0）；
- 账号改绑、账号停用/删除处置和处置工作台；
- 通用 AI Master 代理、管理后台或供应商能力市场；
- 重建品牌、组织、门店、`MediaStaff`、`ExternalAccount` 或媒资的平行主档；
- 解决 `User ↔ MediaStaff` 的最终产品映射；本 spec 只由用途受限的服务身份通过 CLI 调用，不提供 HTTP 接口与页面。

## 3. 术语

| 术语 | 本 Spec 中的含义 |
|---|---|
| `root_task_id` | 一次 tracer 工作流的稳定内部 ID；对外以十进制字符串返回 |
| Home locator | 用户提交的主页 URL、平台分享文本或其他受支持入口的原始文本 |
| Home locator kind | 入口类型：`home` / `video` / `note` / `unknown`；判断以供应商返回为准，不解析平台 HTML |
| Parse attempt | 将 Home locator 解析为供应商可接受主页入口的一次有记录尝试 |
| `ProviderCall` | 一次提交、轮询、分页或重试供应商请求的事实 |
| ODS payload | 在解析前保存于私有对象存储的请求/响应原始 bytes 或传输错误证据 |
| Identifier namespace | 平台内某类外部标识的语义空间；相同字符串跨 namespace 不自动等同 |
| Dominant list author | 同一完整列表页中出现次数唯一最高、且通过版本化 policy 的非空作者 ID |
| Complete returned page | 一次成功列表响应已经返回的全部条目；不能按本地目标数量截断 |
| Initial checkpoint | 首个完整返回页投影成功后建立的 v2 长期 cursor/anchor/version；`has_more` 与页覆盖摘要保留在一年期任务/调用 lineage |
| Entry value state | 一个字段的语义状态：`value`（含真实 0）、`missing`、`explicit_null`、`invalid`、`unsupported`（接口/平台不提供该指标） |
| Formal media asset | 下载完整 bytes、计算 SHA-256 并验证后形成的长期媒资身份 |
| Normalized derivative | 由原始媒资生成的标准化衍生图（JPEG q80、540 宽），独立 SHA-256、独立资产，不替代原始字节 |
| 录入状态 | 首次录入判定的业务结果：`normal` / `invalid_link` / `suspected_empty` |
| 疑似空账号 | 主页可访问但粉丝数为 0 且作品数为 0 的账号；人工确认前不自动纳入监控 |
| Capability gate | 对平台、action、同步/异步模式和解析方式的已验证能力配置 |

## 4. 需求

### 需求 1 · 授权与幂等提交

**用户故事**：作为已授权的内部操作者，我希望安全地提交一条账号 tracer 命令，以便重试不会创建重复的工作流或付费调用。

#### 验收标准

1. 当已授权的调用方提交 `platform`、`media_staff_id`、`home_locator`、`idempotency_key` 和可选的 `initial_content_limit` 时，Tracer SHALL 持久化一条 canonical command，并返回一个十进制字符串形式的 `root_task_id`。
2. 当同一调用方在一年 root 任务保留窗口内，用相同 `idempotency_key` 重复提交相同 canonical payload 时，Tracer SHALL 返回原 `root_task_id`，SHALL NOT 创建重复的工作流事实或供应商调用。
3. 当同一调用方在该保留窗口内复用 `idempotency_key` 但 canonical payload 不同，Tracer SHALL 以稳定的 idempotency-conflict 原因拒绝该请求。
4. 如果调用方缺少所需 capability 或目标范围，则 Tracer SHALL 在任何供应商或媒资请求之前拒绝该命令。
5. 如果平台或所需 action 未由已验证的 capability 启用，则 Tracer SHALL 将其作为 unsupported 拒绝，而不是尝试尽力调用。
6. 当命令被接受或拒绝时，Tracer SHALL 追加一条审计安全的结果，不记录凭证或完整的敏感载荷。
7. 当一年 root 任务保留窗口已过期时，Tracer MAY 接受调用方 key 作为新命令复用，且 SHALL NOT 承诺旧的 root 状态；稳定的账号、归属、快照与内容幂等仍 SHALL 防止重复业务事实。
8. 当同一账号和同一请求动作已有活动的 `SyncTask` 时，Tracer SHALL 复用该任务，而不是创建并发重复任务（v2 §9.3）。
9. 当命令在某个阶段开始前被取消时，Tracer SHALL 阻止该命令产生新的付费调用，同时保留已捕获的证据。

### 需求 2 · 每次供应商调用先落原始载荷再解析

**用户故事**：作为数据管理员，我希望每次供应商交互在解释之前被捕获，以便解析缺陷和合同漂移可审计。

#### 验收标准

1. 在 Tracer 发送供应商提交、轮询、分页请求或重试之前，Tracer SHALL 创建一条持久化的 `ProviderCall` 意图，并将准确的请求 body 字节持久化到私有 ODS。
2. 当 Tracer 执行已准备的供应商交互时，Tracer SHALL 在该条独立 ProviderCall 上记录请求 action、期望响应 action、尝试次数、时间与关联元数据。
3. 当收到供应商响应 body 时，Tracer SHALL 在任何版本化 Adapter 解析之前，将准确接收到的字节持久化到私有 ODS 对象存储。
4. 当传输在完整响应 body 出现之前失败时，Tracer SHALL 在分类或重试该调用之前，持久化一份结构化的传输错误制品。
5. 如果请求意图、响应/错误 ODS 持久化或完整性校验失败，则 Tracer SHALL NOT 解析或投影该供应商结果。
6. 当载荷被解析时，Tracer SHALL 记录该次解释所用的 ODS 引用、字节 SHA-256 与 Adapter 版本。
7. 当已发送的调用失去终态结果时，Tracer SHALL 将该调用标记为 ambiguous 并永久保留该记录。由于 `media_user_info`、`user_video_list` 与任务查询都是只读查询（重发不产生供应商侧副作用，业务事实按幂等键去重），Tracer MAY 在有界重试策略内发起一次新的 ProviderCall，计入调用与成本预算；同一逻辑效果因 ambiguous 最多重发 1 次。本 spec 不实现 ambiguous 对账；有副作用的供应商调用不适用本条。
8. Tracer SHALL 将 ProviderCall、任务与 ODS 载荷事实保留一年，并 SHALL 确保凭证与授权头不出现在保留的 body 和元数据中。
9. Tracer SHALL 仅将现有 `raw3`/`raw4` JSON 文件视为已保存的证据，SHALL NOT 声称它们证明了本实现的 raw-before-parse 行为。
10. 当一年保留期到期时，Tracer SHALL 按 payload → call → task 的顺序清理，SHALL 使清理幂等且可审计，且 SHALL NOT 级联删除长期快照、归属、发现、检查点或正式媒资。

### 需求 3 · 有界的主页入口解析

**用户故事**：作为操作者，我希望主页输入可预测地被解析，以便畸形输入不会造成无界调用或创建残缺身份。

#### 验收标准

1. 当命令开始时，Tracer SHALL 完整保留原始 `home_locator` 文本，并将观察到的 locator 类型记录为 `home` / `video` / `note` / `unknown`；类型应根据供应商行为判断，而不是解析平台 HTML。
2. 如果输入是视频、笔记或作品分享文本而不是主页入口，则 Tracer SHALL 将其作为非主页 locator 拒绝，SHALL NOT 创建账号或归属，也 SHALL NOT 将其作为主页重试。
3. Tracer SHALL 让 AI Master 为 `media_user_info` 处理短链跳转，SHALL NOT 实现自己的 redirect follower、双 user-agent 下载器或平台 HTML 解析器。
4. 在发送之前，Tracer SHALL 只执行 A 域 PRD 定义的最小分享文案清洗（截断路径之后的非路径字符），并 SHALL 同时保留原值与清洗值；清洗 SHALL NOT 改变路径、查询或标识语义。
5. 当解析需要多次尝试时，Tracer SHALL 对 root 任务最多执行三次解析尝试，并在第一个已验证的主页 locator 之后停止。
6. 当一次解析尝试执行网络 IO 时，Tracer SHALL 将其表示为已捕获的 `ProviderCall`，且 SHALL NOT 在该 IO 期间持有数据库事务。
7. 当解析成功时，Tracer SHALL 在同一个短事务中，从同一条已捕获的终态载荷写入提交的 locator 与解析出的外部账号标识；SHALL NOT 将一次调用的 locator 与另一次调用的标识配对。
8. 如果解析结果所属平台与命令不一致，则 Tracer SHALL 拒绝该结果，且 SHALL NOT 静默切换平台。
9. 当同一 root 任务恢复时，Tracer SHALL 复用成功的解析证据，而不是重复付费或网络尝试。
10. 首版只有一种解析策略：最小清洗后直接调用 `media_user_info`。该调用成功返回的已捕获终态载荷同时作为主页投影来源，Tracer SHALL NOT 为主页再发一次请求。成功路径的供应商调用数因此固定为：主页 1 次 + 列表 1 页（不含有界重试）。

### 需求 4 · 解析未决时不产生业务身份

**用户故事**：作为数据所有者，我希望 locator 解析失败不留下残缺的业务身份，以便未验证的主页不能污染主数据。

#### 验收标准

1. 如果三次解析尝试全部失败或未产生已验证的 locator，则 Tracer SHALL 以稳定的原因和尝试摘要进入终态 parse-failed。
2. 如果需求 4.1 适用，则 Tracer SHALL NOT 创建 `ExternalAccount`、账号标识、当前归属、主页快照、内容快照、`ContentDiscovery` 或检查点。
3. 当终态失败之前已捕获解析证据时，Tracer SHALL 按 ODS 保留期保留该操作证据，但 SHALL NOT 将其提升为业务主数据。
4. 当需求 4.1 适用于首次录入时，Tracer SHALL 将录入结果暴露为 `invalid_link`，且不创建账号；失败行或命令 SHALL 保留操作证据并可重试。
5. Tracer SHALL NOT 仅因尝试失败而物理删除失败尝试的证据。

### 需求 5 · 带命名空间、保留文本的账号身份与值状态

**用户故事**：作为数据模型所有者，我希望外部标识和观察值在解释时不丢失也不臆造，以便相似 ID 和不可用指标不会被静默合并或归零。

#### 验收标准

1. 当供应商返回外部 ID 时，Tracer SHALL 保留其原始文本表示，SHALL NOT 通过 JavaScript 安全整数或其他有损数值类型转换。
2. 当标识被存储或查找时，Tracer SHALL 包含 platform 与 identifier namespace；哈希命中只有在原文精确比较之后才可接受。
3. 当同一载荷明确关联多个官方标识时，Tracer SHALL 以观察到的绑定方法与置信度将它们绑定到一个 `ExternalAccount`。
4. 当标识来自不同 namespace 且没有已批准的绑定规则时，Tracer SHALL 保持它们分离，即使字符串相同。
5. 当字段是真实 `0`、缺失、显式 `null`、非法或接口不支持时，Tracer SHALL 在 Adapter 输出与投影中保留这五种不同状态；真实 `0` SHALL 保持为有效值。
6. 当列表接口不提供某指标时（例如抖音列表播放数返回 `0`，小红书省略该字段），Tracer SHALL 将该状态记录为 `unsupported`，SHALL NOT 记录为 `0`、`missing` 或 `invalid`，也 SHALL NOT 让下游消费者将其视为真实观察值。
7. 当某条列表条目缺少其他条目提供的字段时，Tracer SHALL 对该条目做逐条容错解析，SHALL NOT 假设每条条目都有固定 schema。
8. Tracer SHALL 使身份变更幂等；重放同一观察到的标识 SHALL 更新观察元数据，而不创建重复账号或标识。

### 需求 6 · 小红书主导作者绑定

**用户故事**：作为数据模型所有者，我希望观察到的 profile ID 与列表作者 ID 只在有证据时关联，以便两个 namespace 可以在不做不安全猜测的情况下描述同一个主页。

#### 验收标准

1. 当一个完整的小红书首页有一个非空作者 ID，其出现次数唯一最高，且该分布通过版本化主导作者策略时，Tracer SHALL 使用专用 author namespace 与 `dominant_list_author` 证据，将该列表作者标识绑定到 profile `ExternalAccount`。
2. 如果最高作者次数并列、为空或被版本化主导作者策略拒绝，则 Tracer SHALL NOT 猜测绑定，并 SHALL 创建一条带证据计数的数据质量问题。
3. 当同一页出现少数作者时，Tracer SHALL 将其保留在各自返回的内容事实上，但 SHALL NOT 为它们创建 `ExternalAccount` 记录。
4. 给定已保存的日立小红书 fixture，当处理该页时，Tracer SHALL 将 profile ID `49328995493` 与主导列表作者 ID `5decba2300000000010007e1` 保留在不同 namespace 中，同时将两者绑定到同一个目标 `ExternalAccount`。
5. 当主导作者决定被做出或被拒绝时，Tracer SHALL 在可追溯证据中保留策略版本、准确作者计数、分母与拒绝原因。
6. 首版主导作者策略 `xhs-dominant-author.v1`（2026-11-04）：非空作者 ID 中出现次数**唯一最高**，且占非空作者条目 **≥ 80%** 时才绑定；否则拒绝并记质量问题。阈值是配置项，调整阈值必须升策略版本。

### 需求 7 · 当前归属且不抢占所有权

**用户故事**：作为业务所有者，我希望 tracer 归属尊重既有所有权，以便采集不会在专员之间静默转移账号。

#### 验收标准

1. 当已解析账号没有冲突的当前归属时，Tracer SHALL 创建或复用该账号，并在同一条记录中将当前归属记到提交的 `MediaStaff`，作为单一当前事实，同时记录归属来源与时间；SHALL NOT 开启有时间区间的归属。
2. 当账号已归属于同一 `MediaStaff` 时，Tracer SHALL 将该调用视为 no-op，而不是写入平行的归属事实。
3. 如果账号当前归属于另一位 `MediaStaff`，则 Tracer SHALL 保留既有所有者，SHALL NOT 自动改绑、关闭或覆盖，并 SHALL 暴露 assignment-conflict 结果供授权处理。
4. 当发生归属冲突时，Tracer SHALL 保留供应商证据与身份观察，但 SHALL NOT 将提交的 `MediaStaff` 表示为账号所有者。
5. Tracer SHALL NOT 创建平行的自然人员工 `Staff`、平台账号或账号-经销商绑定模型。
6. 当投影内容与发现时，Tracer SHALL 记录采集当时观察到的归属快照值，以便后续受审计改绑不会改写历史发现。
7. 当首次录入被接受时，Tracer SHALL 将提交的 locator 持久化为当前主页 locator，并将上一 locator 留空；入口变更不在本 spec 范围内。
8. 如果提交的 `MediaStaff` 在同一平台已经占用一个账号名额（D-69：一专员一平台一账号），且解析出的账号不是该账号，则 Tracer SHALL 以稳定的 `staff_platform_slot_taken` 原因进入阻塞终态，SHALL NOT 创建归属，并 SHALL 默认停止后续付费阶段；已捕获的证据保留。

### 需求 8 · 终态主页快照

**用户故事**：作为下游消费者，我希望只有一份不可变的主页观察，以便后续规则和指标可以引用 tracer 实际看到的内容。

#### 验收标准

1. 当 `media_user_info` 成功且身份已解析时，Tracer SHALL 投影一份不可变的主页快照，关联到准确的 ProviderCall、ODS 载荷、Adapter 版本、账号与观察时间。
2. 当可选主页字段缺失、null、非法或为零时，Tracer SHALL 保留其值状态，而不是臆造默认值。
3. 当重复工作流观察到同一供应商事实时，Tracer SHALL 按 v2 身份复用或去重，同时保留调用 lineage。
4. 当较新的运行在较旧的延迟运行之前终态化时，Tracer SHALL 使用 fencing 与观察排序，使延迟运行不能将 current 指针倒退。
5. 当主页包含头像或背景候选时，Tracer SHALL 创建媒资引用，但 SHALL NOT 将临时 URL 视为正式资产身份。
6. Tracer SHALL 为每个账号每个批次最多创建一份终态主页快照。
7. 当主页快照终态化后，Tracer SHALL NOT 让后续媒资归档状态变化改写其结构化字段。

### 需求 9 · 完整首页处理与按账号的内容

**用户故事**：作为下游消费者，我希望每条返回条目都按被观察账号保留，以便本地限制和跨账号合并不会静默丢失或混淆观察。

#### 验收标准

1. 当 `user_video_list` 返回成功页时，Tracer SHALL 在决定是否请求下一页或停止之前，检查并投影每一条返回条目。
2. Tracer SHALL 只在完整页请求之间应用 `initial_content_limit`；SHALL NOT 截断已经返回的页。
3. Tracer SHALL 按被观察账号保存内容事实：同一平台作品出现在两个被监控账号时，SHALL 为每个账号各产生一条内容事实，SHALL NOT 跨账号合并；同一 batch + account + content SHALL 最多产生一份最终内容快照和一条 discovery。
4. 当同一 batch + account 列表中的多个条目指向同一平台内容身份时，Tracer SHALL 处理每一条条目，SHALL 为该 batch + account + content 保留一条 discovery，并在页或 ProviderCall 证据中保留重复位置/计数与质量摘要。
5. 当同一内容在同一批次中稍后再次被观察时，Tracer SHALL 让后到的有效值（包括真实 `0`）覆盖先前的值；后到的 `missing`、`explicit_null`、`invalid` 或 `unsupported` 值 SHALL NOT 擦除先前的有效值。
6. 当投影条目时，Tracer SHALL 在存在视频素材时推断 `content_kind` 为 `video`，在存在图片且无视频时为 `image`，在只有文本时为 `text`，在信号缺失或矛盾时为 `unknown`；SHALL NOT 输出 `mixed`。
7. 当列表接口返回播放数时，Tracer SHALL 适用需求 5.6，将其记录为 `unsupported`，而不是 `0` 或 `missing`。
8. 当条目携带多个封面 URL 候选（抖音为 3 条数组）时，Tracer SHALL 保留完整候选集，并 SHALL 选择第二个封面候选（540 宽封面）作为归档的封面引用；第一个候选可能是视频首帧，第三个候选是大尺寸原图。当 `cover` 是单个字符串（小红书，实测 21/21）时，SHALL 直接以它作为封面引用。
9. 当成功列表响应返回 0 条且 `has_more=false` 时，Tracer SHALL 将其视为真实空列表，而不是技术失败。
10. 当投影每条条目时，Tracer SHALL 将其内容快照与 discovery 关联到目标账号、归属快照、batch/page 与准确的 ProviderCall lineage。
11. 给定已保存的 21 条小红书日立列表 fixture，当 `initial_content_limit <= 20` 时，Tracer 仍 SHALL 处理全部 21 条返回条目，且 SHALL NOT 仅为补偿本地截断而请求续页。

### 需求 10 · 类型保真的初始检查点

**用户故事**：作为同步所有者，我希望在首页之后有一个准确的初始检查点，以便后续分页可以在不损坏游标或不丢失观察的情况下继续。

#### 验收标准

1. 当返回页中的每条条目都到达其所需的结构化终态时，Tracer SHALL 以原子方式为该目标账号、provider、action 与 scope 建立或推进 v2 检查点。
2. 长期检查点 SHALL 保留 v2 定义的类型安全 `cursor_envelope`、游标哈希、anchor/高水位语义、长期批次引用、连续性状态、单调版本与更新时间。
3. 一年期任务/ProviderCall lineage SHALL 保留页数、已处理条目数、`has_more`、源任务/调用与 Adapter 版本，供操作重放；该 lineage 过期 SHALL NOT 使长期检查点或结构化业务事实失效。
4. Tracer SHALL NOT 在存储、比较或后续请求中，将整数游标强制转为字符串，或将字符串游标强制转为整数。
5. 如果任何必需页条目投影失败，则 Tracer SHALL NOT 推进持久检查点越过该页。
6. 当较旧的 fenced worker 在较新的检查点版本之后完成时，Tracer SHALL 拒绝该陈旧推进。
7. 当建立首个检查点时，Tracer SHALL 确定性地选择锚点：当存在任何有效发布时间时，使用 `time`，取最大有效 `published_at` 与该时刻的内容 ID 集合；当没有有效发布时间但存在内容 ID 时，使用 `id_window`，取首页内容 ID 集合；当首页确实返回 0 条时，使用 `empty`。
8. 当首页在完整处理之后达到有效 `initial_content_limit` 时，Tracer SHALL 停止并建立基线；在本 spec 中，供应商仍有更多历史 SHALL NOT 被归类为连续性缺口。
9. 给定已保存的 fixture，Tracer SHALL 将抖音 `max_cursor` 保留为整数，将小红书 `max_cursor` 保留为字符串。
10. Tracer SHALL NOT 请求第二页：首个完整返回页处理完即建立基线，后续翻页属于 `a-full-sync`。
11. 当 `has_more=false` 时，空或 null 游标视为正常结束；当 `has_more=true` 但游标为空或 null 时，Tracer SHALL 记录一条质量问题并按已处理页建立基线（与 D-53 一致）。

### 需求 11 · 保留异作者内容但不创建账号

**用户故事**：作为内容分析师，我希望共创或异作者列表条目被保留，以便主页覆盖完整而不臆造被监控账号。

#### 验收标准

1. 当返回条目的作者与目标账号身份不同时，Tracer 仍 SHALL 从目标主页列表持久化内容快照及其 discovery。
2. 当需求 11.1 适用时，Tracer SHALL 在其 namespace 中将返回作者标识保留为观察到的内容事实，但 SHALL NOT 仅凭列表证据为该作者创建或分配 `ExternalAccount`。
3. 目标主页列表中格式良好的异作者本身 SHALL NOT 被归类为数据质量失败；格式异常或歧义的身份数据 MAY 单独分类。
4. 给定已保存的抖音 fixture，Tracer SHALL 解析目标账号 `HITACHI1`，处理全部 20 条返回条目，保留由 `HITACHI2023` 创作的条目，且 SHALL NOT 为 `HITACHI2023` 创建第二个 ExternalAccount。

### 需求 12 · 异步正式媒资归档

**用户故事**：作为资产消费者，我希望被引用的主页与封面媒资被正式归档，以便过期的供应商 URL 不会成为长期身份。

#### 验收标准

1. 当主页或列表投影产生头像、背景或封面候选时，Tracer SHALL 创建版本化媒资引用，并绑定到其源快照与语义角色。
2. 当归档抖音主页时，Tracer SHALL 创建头像与背景引用；小红书主页响应不返回头像或背景，因此 Tracer SHALL NOT 为小红书臆造这些引用。
3. 当归档内容封面时，Tracer SHALL 使用需求 9.8 选出的第二个封面候选，并 SHALL 将其余候选保留为观察证据。
4. 当媒资被下载时，Tracer SHALL 将完整字节归档到私有存储，计算整字节 SHA-256，校验完整性，并将该摘要作为正式去重身份。
5. 当生成标准化衍生图（JPEG q80、540 宽）时，Tracer SHALL 将其作为独立资产存储，带独立 SHA-256，并 SHALL 同时保留原始字节与衍生图；两者 SHALL NOT 互相替代。
6. 当结构化快照与检查点提交后，Tracer SHALL 被允许在媒资下载完成之前完成 root 结构化结果，并 SHALL 暴露独立的媒资进度。
7. Tracer SHALL NOT 将临时 URL 用作 `MediaAsset` 身份，也 SHALL NOT 将长期签名 URL 写入业务事实。
8. 如果媒资下载失败或其 URL 过期，则 Tracer SHALL 保留结构化快照，单独分类媒资状态，并只在有界策略下重试；当复用先前已验证资产时，Tracer SHALL 将其标记为 carried forward，且 SHALL NOT 将其报告为本轮成功归档。
9. 当默认测试运行时，Tracer SHALL 使用 fake OSS 与 fake 媒资传输，且 SHALL NOT 下载网络媒资。

### 需求 13 · 由 capability 驱动的同步与异步供应商执行

**用户故事**：作为集成所有者，我希望供应商执行由已验证 capability 选择，以便生产不假设某一种未经验证的模式。

#### 验收标准

1. Tracer SHALL 仅通过 `POST /openapi/v1/media_user_info`、`POST /openapi/v1/user_video_list`，以及在需要时通过 `GET /openapi/v1/tasks/{task_id}` 使用 AI Master。
2. 当一个 action 被配置为已验证同步时，Tracer SHALL 捕获并解析其终态提交响应，不做不必要的轮询。
3. 当一个 action 被配置为已验证异步时，Tracer SHALL 单独捕获提交，持久化供应商任务标识，并将每次轮询捕获为独立的 ProviderCall，直到终态结果或有界超时。
4. Tracer SHALL NOT 将 `async=false` 或 `async=true` 硬编码为生产全局策略。
5. 如果请求的 platform/action/mode 组合缺少所需证据等级或环境批准，则 Tracer SHALL 在付费请求之前完成 capability gating 并失败。
6. Tracer SHALL 区分 `supplier_declared`、`fixture_observed`、`smoke_verified` 与 `production_approved`；仅 fixture 证据 SHALL NOT 启用生产 tuple。
7. 给定已保存的 raw4/raw5/raw8 证据，Tracer SHALL 将以下项视为 `smoke_verified` 但不自动生产批准：抖音与小红书的 `media_user_info` 和 `user_video_list` 同步模式；抖音与小红书的 `media_user_info` 异步模式。`user_video_list` 异步模式对两个平台均为供应商失败，应保持 disabled。
8. 给定 raw4 证据，Tracer SHALL 使用 `X-Api-Key` 作为观察到的认证头，应将供应商文档中的 Bearer 描述记录为矛盾，并且仍要求在生产启用前完成一次批准的 smoke 运行。
9. 当供应商返回 `RESULT_VALIDATION_FAILED` 时，Tracer SHALL 将其分类为可在有界策略内重试，而不是立即终态失败；同一错误类也可能表示无效、私密或已删除的主页，因此 Tracer SHALL NOT 仅凭状态码或错误码决定业务含义。

### 需求 14 · 显式失败、重试与恢复语义

**用户故事**：作为操作者，我希望失败被分类且可恢复，以便技术错误永远不会伪装成业务数据缺失。

#### 验收标准

1. 当失败发生时，Tracer SHALL 至少将其分类为：输入、非主页 locator、授权、不支持的 capability、供应商认证、配额/限流、传输、原始载荷持久化、schema/解析、身份歧义、归属冲突、结构化投影或媒资失败。
2. Tracer SHALL NOT 将传输、原始载荷持久化、解析、schema、存储或超时失败转成空主页、空列表、业务级「未找到」或账号状态变更。
3. 当失败可重试且先前远端结果已知时，Tracer SHALL 应用有界尝试与退避，同时为每次供应商尝试创建新的 ProviderCall；已发送但结果不明的只读查询按需求 2.7 处理：原调用保持 ambiguous，新尝试是独立 ProviderCall，不改写原调用。
4. 当失败为终态时，Tracer SHALL 保留已完成的不可变事实，显式标记未完成阶段，并避免推进未获得的检查点。
5. 当工作流在进程丢失后恢复时，Tracer SHALL 从持久阶段事实继续，且 SHALL NOT 重复已完成的付费效果。
6. 当请求取消时，Tracer SHALL 阻止新的付费调用，并使用 fencing 拒绝迟到写入，同时保留审计与证据；如果持久 ProviderCall 意图尚未进入 `in_flight`，则 Tracer SHALL 将其关闭为 `terminal/not_sent`，而不是留下可发送的 prepared 意图。
7. 当现有账号发生技术失败时，Tracer SHALL NOT 改变账号状态；只有已确认的供应商声明 MAY 设置 `unavailable`，只有授权人员 MAY 设置 `deleted`。
8. 当首次解析在有界重试后失败时，Tracer SHALL NOT 创建账号，并 SHALL 将 `invalid_link` 暴露为录入结果。
9. 当首次主页解析成功但账号被确认不可访问时，Tracer SHALL 遵循需求 4 与 PRD §11.2.1（不建账号），而不是从不可验证身份创建 `unavailable` 账号。

### 需求 15 · 本地、脱敏的状态查询

**用户故事**：作为操作者，我希望有一个本地状态视图，以便理解身份、结构化进度、媒资进度与失败，而不产生更多供应商成本。

#### 验收标准

1. 当已授权调用方查询 `root_task_id` 时，Tracer SHALL 仅根据本地工作流与数据底座事实回答，SHALL NOT 调用 AI Master 或媒资源站。
2. 状态 SHALL 在授权时暴露 root 状态、阶段状态、尝试次数、目标账号与归属引用、主页/列表/检查点计数、按状态汇总的媒资总量、警告、稳定失败原因与相关时间戳。
3. 状态 SHALL 区分「结构化成功但媒资待完成」「完全成功」「阻塞冲突」「重试等待」「终态失败」与「取消」。
4. 状态 SHALL 脱敏凭证、原始载荷 body、完整私有对象 key、临时 URL 与未授权的业务标识。
5. 当 `root_task_id` 未知、已超过一年任务保留窗口或超出调用方范围时，Tracer SHALL 根据访问策略返回不泄露信息的 not-found/expired/denied 结果，且 SHALL NOT 从无关的长期业务事实重建操作状态。
6. 状态 SHALL 暴露账号级与批次级结果，足以让操作者看到目标账号、录入结果、返回/投影条目数以及任何连续性或媒资警告。

### 需求 16 · 默认离线的 fixture 验证

**用户故事**：作为开发者，我希望确定性的离线验证，以便日常开发和 CI 永不依赖付费或可变的供应商行为。

#### 验收标准

1. 当默认验证套件运行时，Tracer SHALL 阻断网络访问，并使用 fixture transport、fake clock、fake lease 与 fake OSS。
2. 默认套件 SHALL NOT 要求 AI Master 凭证，且如果尝试真实供应商或媒资请求 SHALL 失败。
3. 抖音 fixture 验收 SHALL 断言目标账号 `HITACHI1`、处理 20 条条目、保留异作者 `HITACHI2023`、不为该作者创建账号、整数游标类型、推断的 `content_kind` 与列表播放状态 `unsupported`。
4. 小红书 fixture 验收 SHALL 断言 profile ID `49328995493`、主导作者 ID `5decba2300000000010007e1` 在同一账号的不同 namespace、处理 21 条条目、字符串游标类型、无头像/背景引用，以及封面取单值 `cover`（小红书列表的 `cover` 是单个字符串，不是数组）。
5. 离线验证 SHALL 独立于真实网络行为，覆盖 ODS-before-parse 顺序、重复提交、恢复、陈旧 fencing、归属冲突、歧义主导作者、游标类型、媒资失败、非主页 locator、疑似空账号、`content_kind` 推断与 `unsupported` 值状态。

### 需求 17 · 显式批准的付费 smoke

**用户故事**：作为集成所有者，我希望有一条窄范围受控的真实 smoke 路径，以便在不意外花费或泄露数据的情况下检查外部合同健康度。

#### 验收标准

1. 付费 smoke SHALL 被排除在默认测试与 CI 之外，并 SHALL 要求人工批准与显式运行时开关。
2. 在首次调用之前，smoke SHALL 要求一个 allowlist 的 platform/action/locator 集合、固定的最大调用次数或成本预算，以及在源码控制之外提供的有效 secret。
3. 当预算、截止时间或调用上限达到时，smoke SHALL 在发出下一次供应商调用之前停止。
4. 当 smoke 完成或中止时，Tracer SHALL 输出审计摘要，包含 action、计数、延迟、字节数、估算成本、结果类别与保留的证据引用，但不含 secret 或完整载荷。
5. 成功的 smoke SHALL 只验证实际执行的 platform/action/mode，且 SHALL NOT 自动启用未测试的 capability。
6. 当估算成本时，smoke SHALL 使用 A v1.10 §6.2 的点数表（抖音主页 10、列表 10/页；小红书主页 15、列表 15/页），并 SHALL 使用已确认的单价 0.02 元/点（1 元 = 50 点，2026-11-04）；QPS 仍标记为 unknown。

### 需求 18 · 租约、fencing 与单调发布

**用户故事**：作为平台操作者，我希望并发与延迟 worker 被约束，以便重试不会破坏 current 状态或检查点。

#### 验收标准

1. 当 worker 认领一个可变阶段时，Tracer SHALL 使用有时间上限的 lease 与单调递增的 fencing token，或等价的陈旧写入防护。
2. 如果 lease 过期或存在更高的 fencing token，则陈旧 worker SHALL NOT 发布主页 current 指针、列表完成、检查点、归属变更或媒资终态。
3. 当两个 worker 重放同一逻辑效果时，Tracer SHALL 使用稳定幂等键，使最多创建一条业务事实，同时两次尝试都可观察。
4. 当较旧批次在较新终态观察之后到达时，Tracer SHALL 保留较旧的不可变历史，但 SHALL NOT 将 current 状态倒退。
5. Tracer SHALL NOT 在等待供应商或媒资网络 IO 时持有数据库事务。
6. Tracer SHALL NOT 并发运行同一账号与同一 action；该账号/action 的活动任务应被复用。

### 需求 19 · 首次录入结果与质量问题

**用户故事**：作为操作者，我希望首次录入结果与任何质量问题可见，而不静默改变业务状态，以便我知道账号是否可用、需要关注什么。

#### 验收标准

1. 当首次解析与主页投影成功时，Tracer SHALL 将录入结果确定为 `normal`、`invalid_link` 或 `suspected_empty` 之一。
2. 当主页可访问且粉丝数与作品数均为真实 `0` 时，Tracer SHALL 将录入结果标记为 `suspected_empty`，创建可观察的数据质量问题，且 SHALL NOT 自动将该账号纳入监控。
3. 当录入被接受时，只有在它不是 `suspected_empty` 且身份已验证时，才 SHALL 记录为 `normal`。
4. 当发生身份冲突、字段合同异常、连续性缺口或媒资失败时，Tracer SHALL 记录一条带可追溯证据的数据质量问题，而不是删除或改写业务数据。
5. Tracer SHALL NOT 因质量问题将 `ExternalAccount.status` 改为 `unavailable` 或 `deleted`；人工处置与改绑不在本 spec 范围内。
6. 当记录质量问题时，SHALL 可在适用保留窗口内按账号、批次与源 ProviderCall 查询。
7. 当账号被接受时，Tracer SHALL 在归属行写入 `intake_status`：`normal` 或 `suspected_empty`；`invalid_link` 不建归属行，只出现在根任务结果中。
8. `suspected_empty` 的账号 SHALL NOT 进入常规采集：实际监控 = 监控开关打开 **且** `intake_status='normal'`。Tracer SHALL NOT 为此关闭监控开关；人工确认入口属于 `a-activity-plan`。

## 5. 需求级完成边界

只有当上文每一条规范性要求都有可执行的验收检查或显式批准的人工 smoke 检查时，本需求文档才算满足。仅有成功的 HTTP 响应不够：身份、归属、录入结果、完整页基数、游标类型与锚点模式、ODS 顺序、检查点安全、值状态（包括 `unsupported`）、按账号内容、媒资状态与「不产生额外账号」不变量都必须被观察到。

§1.2 的六项基线冲突已在 v2 修订；第 7 项范围区别仍然有效，不得由实现静默改变。
