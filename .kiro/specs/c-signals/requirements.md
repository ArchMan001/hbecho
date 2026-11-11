# C 识别能力（c-signals）· 需求

> **状态**：`draft`
>
> **模式**：Design-First
>
> **实现状态**：未开始（2026-11-11 初建；任务 0 的待确认闸门未通过前不写迁移与代码）
>
> **所属域**：C 识别能力 · **目录命名**：`c-signals`，符合 `<代号>-<切片>`；路线图第 6 位（[`INDEX.md`](../../../HBECHO设计方案/INDEX.md) §7）
>
> **上游 PRD**：[`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md) v1.2（定稿候选），产品语义以它为准；本 spec 只补实现层的取舍
>
> **相邻 PRD**：[`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md) v1.1（信号的消费方与监控段的驱动方）、[`prd-domain-h-ai.md`](../../../HBECHO设计方案/prd-domain-h-ai.md) v0.2（ASR 与大模型调用通道）、[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21（Capability）、[`prd-platform.md`](../../../HBECHO设计方案/prd-platform.md) §6.11（三层对象）
>
> **供数说明**：[`domain-a-handoff-to-c.md`](../../../HBECHO设计方案/domain-a-handoff-to-c.md)（draft，部分内容已过时，见 §1.3 R4；**以已合并代码为准**）
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)（draft）。C 域的表**不入 v2**，以本 spec design §6 为准（与 B 域做法一致）；对 A 域表只有一处加索引的修订（§1.3 R1）
>
> **最近核对**：2026-11-11（核对对象：`src/db/schema/{content,media,accounts,sync}.ts`、`src/modules/{projection,media-archive,sync-runner,demand,orchestrator,cost-guard,provider-adapter}`、`services/capability/`）
>
> **更新日期**：2026-11-11
>
> **语言约定**：正文中文；验收标准中的规范性关键词 `SHALL` / `SHALL NOT` / `MAY` 与技术标识保留英文（对齐 `a-activity-plan` 的写法）。

## 1. 引言

### 1.1 权威顺序

冲突时按此顺序裁决，不在代码、SQL 或本 spec 里暗中选择一方：

1. [`CONTEXT.md`](../../../CONTEXT.md)：领域词汇与不变量（尤其 MediaAsset、ContentSnapshot、CurrentContent、不变量 12、17、18、20）；
2. [`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md)：C 域产品语义的唯一真相源。信号目录、五态、复用键、标准图、保留期、重算、监控段生命周期以它为准；
3. [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)：快照、媒资、评论、账号的物理基线。C 只读这些表；
4. [`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md)、[`prd-domain-h-ai.md`](../../../HBECHO设计方案/prd-domain-h-ai.md)：消费方与调用通道的产品语义；C 与它们冲突时先停下来协调；
5. [`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md)：Capability 名称。本 spec 只引用名称，不复制授权实现；
6. [`a-data-foundation-tracer`](../a-data-foundation-tracer/requirements.md)、[`a-full-sync`](../a-full-sync/requirements.md)、[`b-access-control`](../b-access-control/requirements.md)：已合并的实现与约定；
7. 本 spec：不得静默改写以上事实。

### 1.2 上游与依赖

| 依赖 | 当前状态（2026-11-11 核对） | 对本 spec 的影响 |
|---|---|---|
| A：finalized 快照与 current 指针 | 已合并 `main`。`contents.current_snapshot_id` / `current_snapshot_selected_at` 只由 `selectCurrentContentSnapshot` 推进，且只接受 finalized、按 `(logical_at, batch_id)` 严格更新 | C 的触发点就是这个指针（SG-D03）。**没有 finalized 事件、钩子或 outbox**，只能轮询；`current_snapshot_selected_at` **没有索引**（§1.3 R1） |
| A：媒资 | 已合并。`media_references.role` 含 `avatar` / `background` / `cover` / `video` / `audio` 及三个 `*_normalized`；状态 `pending` / `archived` / `carried_forward` / `failed`；字节身份是 `media_assets.sha256` | 待比对图读 `archived` 的原图；音频读 `role='audio'`、`archived`。C 不写这些表，不触发下载（PRD C §8.2） |
| A：评论 | 已合并。`comments` 只有一级评论的**最新态**，没有 `parent_id`，没有回复树，没有按批次的版本 | `comment.text_normalized` 绑评论记录，不绑快照（§1.3 R4） |
| A：按需采集（CollectionDemand） | 已合并（`demand.submit` / `get`），提出方是 D | C **不提需求**。音频不在库时，C 报 `missing` 与原因，由 D 去提需求 |
| A：音频抽取 | 已合并。`video-runner` 已经按「Node 传短期签名 URL 给 Python」产出 `audio` 媒资 | ADR-0012 补记第 1 条已定此做法；C 沿用，不改 |
| Python 能力服务 | 已存在：`/v1/image/normalize`、`/v1/audio/extract`；依赖只有 FastAPI、uvicorn（pytest 为开发依赖）；**没有 OpenCV、没有匹配端点** | 本 spec 新增 `/v1/image/match`，并安装 `opencv-python-headless`（ADR-0012 已登记；numpy 是其传递依赖，需补记） |
| B：Capability | 已合并（2026-11-10）。`rule.definition.manage` 授予 `platform_admin`、`hq_manager`；`data.content.read`、`data.account.read` 授予所有角色 | 与 `a-activity-plan` 同一做法：本 spec 走 `SignalActor` + Capability 字符串的 seam，不依赖 B 的会话 |
| H：AI 网关（`h-ai-min`，路线图第 10 位） | **未开始，仓库里没有任何网关代码** | 路线图把本 spec 排在它之前。C 定义 `AiGatewayPort`，**默认实现是 disabled**；第 3 层在 H1 落地并通过 smoke 之前不会发出任何付费调用（SG-D09） |
| D：规则与考核（`d-rule-engine`，第 7 位） | **未开始**；现有 `rule-engine/design.md` 与 D PRD v1.1 不一致 | 监控段 API、读取口、补算请求都是**面向 D 的端口**，由 C 先定义、D 落地时对齐（design §14 第 11 项） |
| `a-activity-plan` | 在分支 `a-activity-plan`，未合并 | 不依赖。监控判定计划 ID 对 C 是 D 分配的不透明 `BIGINT` |
| 付费调用 | production capability 全部 disabled | C 自己**不调用 AI Master**；ASR 与大模型只经 `AiGatewayPort` |

**不依赖的东西**：真实用户登录、DataScope 持久化、H1 网关、D 的任何表、AI Master 真实调用、ODS（C 读的是长期保留的结构化快照与正式媒资）。

### 1.3 与 v2 基线及上游文档的冲突（实施前必须修订）

| # | 位置 | 现状 | 本 spec 的修订要求 |
|---:|---|---|---|
| R1 | v2 `contents` / `src/db/schema/content.ts` | `current_snapshot_selected_at` 无索引。C 的增量扫描按它排序，不加索引会全表扫描 | 增加 `idx_contents_current_selected (current_snapshot_selected_at, content_id)`。**只增索引**，不改列、不改语义、不改 `selectCurrentContentSnapshot` |
| R2 | [`ADR-0001`](../../../HBECHO设计方案/architecture/adr/0001-oss-bucket-topology.md) | 五个桶。`hbecho-media` 的 RAM 策略刻意没有 `DeleteObject` | 标准图 / 元素图随监控判定计划物理删除（PRD C §5.5、D PRD §2.0），不能放进 media 桶。增补第六个桶 `hbecho-signals`，做法同 `hbecho-course`（私有、无过期规则、应用角色额外授予 `DeleteObject`、不写 A 域的 `media_assets` / `oss_objects`）。**创建桶与改 RAM 需要刘学奎批准**（`server-access.md`） |
| R3 | [`ADR-0012`](../../../HBECHO设计方案/architecture/adr/0012-python-capability-service.md) | 契约只列了归一化与音频抽取；OpenCV 已登记，numpy 未提 | 补记：① 新增 `POST /v1/image/match`，请求是 JSON（两个短期签名 URL），响应是 JSON；沿用「Python 不持有 OSS 凭证」；② numpy 是 `opencv-python-headless` 的传递依赖，随它一起采用，不单独选型；③ 匹配的 0–10 分映射在 Python 内，能力版本由它回报 |
| R4 | [`domain-a-handoff-to-c.md`](../../../HBECHO设计方案/domain-a-handoff-to-c.md) | ① §一.4 写评论有 `parent_id`；② §二写信号状态为 `ready` / `waiting` / `unavailable` | ① 代码里评论**没有** `parent_id` 与回复树（`comments` 表，`content.ts`），以代码为准；② 以 C PRD §3.3 的五态为准。该文档按 `structure.md` 的做法在文首补「已知过时内容」，不改正文 |
| R5 | C PRD v1.2 §5.1 / §5.2 | pHash 在档 1 里「内部预筛」 | 本 spec 的 `image.template@1` **不实现 pHash 预筛**（理由与上限见 design SG-D07）。PRD 在确认后升 v1.3 订正；确认前 PRD 原文不动 |
| R6 | C PRD v1.2 §4.2 | 「中文标点与英文标点统一为中文标点」 | 本 spec 以 NFKC 的方向统一（结果是 ASCII 标点），并只补两个 CJK 字符的映射（design §7.1）。匹配是对称的（规则关键词走同一函数），方向不影响命中。待确认后 PRD 订正措辞 |
| R7 | `CONTEXT.md` 跨域消费词汇 | 没有 Signal、MonitoringSegment | 增加两条词汇，只写语义（任务 0） |
| R8 | `INDEX.md` §5 / §7.1 | 路线图第 6 位已预占 `c-signals`，无 spec 条目 | 登记本 spec 的四件套与状态（本次初建已完成） |

> R1 是对 A 域表的唯一修改。C 的其余表全部新增，不改 A 的任何列、状态或约束。

### 1.4 PRD 真空与本 spec 的解释

PRD 没有直接写死、但实现必须选一条的地方。「已定」表示 PRD 或已合并 spec 已有结论；「本 spec 建议」表示这是本 spec 的解释，**待刘学奎评审时确认**（design §14 逐项列出）。

| # | 问题 | 结论 | 性质 |
|---:|---|---|---|
| 1 | 什么事件触发文本信号抽取 | 内容的 **current 指针推进**（`current_snapshot_selected_at` 之后的内容），不是「某个快照 finalized」。旧批次迟到的 finalized 快照不是 current，不抽取。理由：特征主表一对象一行只存当前值（C-D13） | 本 spec 建议 |
| 2 | 为什么不用事件 | A 没有 finalized 事件，改 A 的 seal 路径风险大、且 A 的另一个会话可能正在改。C 用 `(selected_at, content_id)` 游标 + 回看窗口 + 每小时对账（design §7.3） | 本 spec 建议 |
| 3 | 文本字段为 NULL 的语义 | A 的 `title` / `body` / `tag_text` 没有值状态列，NULL 无法区分「平台没有这个字段」「字段缺失」「真的为空」。C 按平台字段表（`PLATFORM_TEXT_FIELDS`，任务 2 用 fixture 核对）判定：平台没有该字段 → `not_applicable`；平台有该字段但值为 NULL → `valid` 的空值（PRD C §4.4「正文为空 → valid 的空值」） | 本 spec 建议；字段表待实测 |
| 4 | 话题从哪抽 | 标题、正文与 A 的 `tag_text` 三处的并集，去重，保持首次出现顺序。fixture 里同时出现 `#日立中央空调 #全效Ⅱ三管制`、`#a#b`（无空格相连）、`#来拍照了[话题]#`（小红书）三种写法 | 本 spec 建议（依据 `tests/fixtures` 与 `aimaster接口文档` 的样本） |
| 5 | 关键词用什么归一化 | C 导出 `normalizeKeyword()`，与特征落库用**同一个函数**；D 保存规则时用它归一化关键词。D 若自己写一份，大小写与全半角必然漂移 | 本 spec 建议（需写进 D spec） |
| 6 | 账号头像 / 背景的平台范围 | `account.bg_*` / `account.avatar_*` 只对抖音有输入。快手（PRD C §2.4）与小红书（handoff §五.1、D PRD §2.3）一律 `not_applicable` | 本 spec 建议（PRD C 只点名了快手） |
| 7 | 素材状态到信号状态的映射 | 引用行不存在 → `not_applicable`；`pending` → `missing`（`media_pending`）；`failed` → `missing`（`media_failed`）；`carried_forward` → `missing`（`media_carried_forward`，PRD C §5.5 禁止当作当前图）；`archived` 但字节读不到或解码失败 → `failed` | 已定（PRD C §5.8）；原因码为本 spec 的 |
| 8 | 音频从哪来 | 读 A 已归档的 `audio` 媒资（该内容任一快照下的 `archived` 引用均可：音频字节不随快照变化）。没有 → `missing`（`audio_not_archived`）。C 不提采集需求、不写同步任务 | 已定（PRD C §8.2）；读取范围为本 spec 的 |
| 9 | 第 3 层在 H1 落地之前怎么办 | C 定义 `AiGatewayPort`，默认实现 `DisabledAiGateway`（`activeModel()` 返回 `null`）。信号 `missing`（`capability_disabled`），不创建任务，不发调用。第 3 层的编排、参数化、缓存、失败语义全部用 fake 网关在离线测试里证明 | 本 spec 建议（**待确认**，design §14 第 2 项） |
| 10 | 补算「缺失」的定义 | 在 `requestScores` 中，「缺失」= 该（素材 × 参数）在**当前能力版本下**没有结果行，且最高版本的行不是 `valid`。已有旧版本的有效值（`stale`）**不**补算——那是显式重算的事（PRD C §7.2） | 已定（PRD C §5.6 第 3 条、C-D05）；边界为本 spec 的 |
| 11 | 瞬时失败与确定性失败 | 能力服务不可用、超时、读不到来源是**瞬时**失败：任务重试，用尽后任务 `dead`，**不写结果行**（信号保持 `missing`，原因 `compute_dead`）。图片损坏、解码失败是**确定性**失败：写 `failed` 结果行（保留 3 个月）。避免把一次宕机固化成「失败」 | 本 spec 建议 |
| 12 | 保留期里「被判定引用」怎么知道 | C 看不到 D 的判定。C 给 D 一个 `retainUntil(resultIds, date)`：D 在保存判定证据时调用，把结果行的 `expires_at` 延长；C 的清理器只看 `expires_at` | 本 spec 建议（**待确认**，design §14 第 8 项）；D 落地前该端口只有契约测试 |
| 13 | 重算的「范围」 | 至少给出以下之一，否则拒绝：监控判定计划（经 D 提供的主体清单）、品牌、账号集合、内容集合、发布时间窗；可以组合（取交集）。**没有「全部」选项** | 已定（PRD C §7.2）；范围种类为本 spec 的 |
| 14 | 标准图的上限 | 单张 ≤ 10 MiB，必须能被 `ImageConverter` 解码；格式不限制，由 ffmpeg 能解的为准 | 本 spec 建议 |
| 15 | 页面 | C 没有独立界面（PRD C §9）。证据下钻在 D 的判定页里；本 spec **没有页面** | 已定 |

### 1.5 范围

#### 1.5.1 范围内

- **信号目录**：代码内唯一目录，12 个 1.0 信号；平台可得性；未注册即拒绝；
- **文本信号（C1）**：标题 / 正文归一化、话题；评论正文归一化；平台版本化的解析；
- **特征存储（C4）**：一对象一行的当前值、按信号的版本与时间、历史表、复用键结果表、保留期与清理；
- **监控段**：创建 / 编辑 / 发布 / 新草稿 / 查看 / 可执行性 / 清除；标准图与元素图的上传、校验与存储；
- **素材比对（C2 档 1）**：模板匹配与元素匹配的补算请求、素材状态映射、Python `/v1/image/match`、0.0–10.0 分；
- **音频理解（C3，仅音频）**：`content.asr_text`、`content.asr_judgement` 的编排、参数化与复用；`AiGatewayPort`；默认 disabled；
- **读取口**：`SignalReader`（五态合成、`stale` 策略、`pending` 提示）、`requestScores`、`executability`；
- **版本与重算**：能力版本、`stale`、显式受控重算（预览、范围、记录）；
- **任务执行**：C 自己的任务表，租约与 fencing，重试与失败语义；
- **CLI**：`pnpm signals`；常驻进程 `signals run`；
- **对既有代码的小改动**：`contents` 加一条索引；Python 服务加端点与依赖（design §10）。

#### 1.5.2 范围外

- 页面、判定、阈值、命中、达标（D）；完成率、点检表、看板（E）；
- **采集**：不调 AI Master，不提采集需求，不写 A 的任何表，不下载媒资；
- **H1 网关本身**（Key、路由、成本、审计、降级）：`h-ai-min`。C 只定义调用它的端口；
- OCR、图片理解、视频理解、抽帧（2.0）；pHash 作为独立能力或判同依据；图像向量化、以图搜图（不做）；
- PRD C §3.7 标「搁置」的六个聚合信号，以及 @ 提及、POI、外链、账号昵称 / 签名的归一化（C-D06，2.0）；
- 业务与对话大模型协作定标准（C-D11，2.0）；
- 部署形态（compose 服务、资源上限）：与 `a-full-sync` 一样，本 spec 不交付可上线的部署，只交付可运行的进程入口；
- 真实付费 smoke 的自动化。

### 1.6 术语

| 术语 | 含义 | 来源 |
|---|---|---|
| 信号 | 从事实或素材抽出的、可被规则直接比较的测量值；不是判定 | PRD C §3.1 |
| 五态 | `valid` / `missing` / `not_applicable` / `failed` / `stale` | PRD C §3.3 |
| 能力 | 产出信号的一段算法，由「能力标识 + 整数版本」标识，如 `image.template@1` | PRD C §3.4 |
| 素材指纹 | 被抽取对象的内容指纹：文本 = 规范化 JSON 的 SHA-256；图片 / 音频 = 完整字节的 SHA-256 | PRD C §3.6、C-D12 |
| 参数指纹 | 同一素材可有多份结果的参数：标准图 / 元素图字节的 SHA-256；判定 = 标准文本 + 提示词版本 + 模型版本 | PRD C §3.7 |
| 复用键 | 信号标识 + 素材指纹 + 参数指纹 + 能力版本 | PRD C §3.6 |
| 特征行 | 一个内容（或评论）在特征主表里的一行：当前快照的 0 档结构化信号 | PRD C §6.1、C-D13 |
| 结果行 | 派生信号（匹配分、ASR、判定）按复用键存的不可变一行 | 本 spec |
| 监控段 | 监控判定计划中归 C 的一半：信号集合、标准图 / 元素图；与 D 的判定段 1:1，共用计划 ID 与版本 | PRD C §11.1、C-D10 |
| 补算 | `requestScores`：只对「缺失」的（素材 × 参数）建任务；免费 | PRD C §5.6、C-D09 |
| 重算 | 显式、带范围、带记录的重新计算，会覆盖 `stale` | PRD C §7.2 |

## 2. 需求

### SG-1 · 信号目录与注册

**陈述**：系统 SHALL 在代码中维护唯一的信号目录。每个目录项 SHALL 声明：信号键、对象类型（`content` / `account` / `comment`）、能力标识、当前能力版本（正整数）、成本档（0 / 1 / 2 / 3）、作用域（`global` / `parameterized`）、可得平台集合、存储位置（`feature_row` / `result`）。**未在目录中的信号 SHALL NOT 可读、不可请求、不可写进监控段**（PRD C §9「未注册即拒绝」）。

1.0 目录恰好包含以下 12 项：

| 对象 | 信号键 | 作用域 | 成本档 | 可得平台 | 存储 |
|---|---|---|---|---|---|
| content | `text.title_normalized` | global | 0 | 按 `PLATFORM_TEXT_FIELDS` | feature_row |
| content | `text.body_normalized` | global | 0 | 按 `PLATFORM_TEXT_FIELDS` | feature_row |
| content | `text.hashtags` | global | 0 | 抖音、小红书、快手 | feature_row |
| content | `content.cover_template_score` | parameterized | 1 | 抖音、小红书、快手 | result |
| content | `content.cover_element_score` | parameterized | 1 | 抖音、小红书、快手 | result |
| content | `content.asr_text` | global | 2 | 抖音、小红书、快手 | result |
| content | `content.asr_judgement` | parameterized | 3 | 抖音、小红书、快手 | result |
| account | `account.bg_template_score` / `account.bg_element_score` | parameterized | 1 | 抖音 | result |
| account | `account.avatar_template_score` / `account.avatar_element_score` | parameterized | 1 | 抖音 | result |
| comment | `comment.text_normalized` | global | 0 | 抖音、小红书 | feature_row |

> 账号四项占一行，实际是四个信号键，合计 12 个。快手没有评论采集（`comments/policy.ts`），所以 `comment.text_normalized` 不含快手。

- 目录项 SHALL 能导出「某平台下可用的信号集合」，供 D 的规则配置过滤（PRD C §3.7「平台不支持的信号在规则配置中不可选」）；
- PRD C §3.7 标「搁置」或「2.0」的信号 SHALL NOT 出现在目录里（C-D06）；
- 能力版本只在代码里改；改版本号是「能力升级」（SG-10）。

**验收标准**

- 读取、请求补算、保存监控段时引用目录外的信号键，一律以 `signal_unregistered` 拒绝；
- 目录的键集合与上表逐项相等（测试对照一份独立转写的清单）；
- `platformSignals('kuaishou')` 不含任何 `account.*` 与 `comment.*`；`platformSignals('xiaohongshu')` 不含 `account.*`；
- 目录里没有 OCR、`vision_*`、`ai_judgement` 与六个聚合比率。

### SG-2 · 信号五态

**陈述**：读取口 SHALL 对任意（对象、信号键、参数）返回五态之一，且 SHALL NOT 把 `missing`、`failed`、`not_applicable` 合并成同一个空值（PRD C §3.3、§8.1）。存储 SHALL 只保存有结论的结果：

| 态 | 怎么得出 |
|---|---|
| `valid` | 存在当前能力版本的有效结果 |
| `stale` | 存在有效结果，但其能力版本低于目录当前版本 |
| `failed` | 当前能力版本下的确定性失败结果行 |
| `not_applicable` | 输入本来就不存在（平台没有该字段 / 该对象、内容没有封面、账号没有自定义背景）；**不存储**，读取时由输入事实推出 |
| `missing` | 该有但还没有：没有结果行、输入素材尚未归档、最高版本的行是旧版本的失败、能力未启用、任务还在排队 |

- 「最高版本的行决定」：同一（素材、参数、信号）有多个版本的行时，只看版本最高的一行。旧版本的 `failed` 不是新代码的证据，按 `missing` 报告并带原因 `failed_under_old_version`；
- `missing` SHALL 带稳定原因码，并带 `pending` 提示（`queued` / `running` / `dead` / 无）；
- `failed` SHALL 带失败码与证据，**不得**写成 0 分、空数组或空字符串；
- `stale` SHALL 带旧值，并由调用方参数决定是否可用（SG-12）。

**验收标准**

- 同一内容的封面信号在「无封面引用 / 引用 `pending` / 引用 `failed` / 引用 `carried_forward` / 已归档但字节读不到 / 已计算」六种输入下，依次得到 `not_applicable` / `missing` / `missing` / `missing` / `failed` / `valid`，原因码各不相同；
- 提升目录中某信号的版本号后，该信号的旧结果读作 `stale`，不会变成 `missing`，也不会被重算；
- 数据库里不存在 `status='missing'`、`'stale'` 或 `'not_applicable'` 的存储行（CHECK）；
- 失败结果行的 `score` 与 `value` 为空（CHECK），读取时不会得到 `0`。

### SG-3 · 文本信号（C1）

**陈述**：系统 SHALL 为每个内容的 current 快照抽取 `text.title_normalized`、`text.body_normalized`、`text.hashtags`，写入特征行。

- **触发**：内容 current 指针推进后（SG-D03）。只处理 finalized 的 current 快照；`building` 与非 current 的快照不处理；
- **输入**：当前快照的 `title`、`body`、`tag_text`、平台；
- **归一化**（`text.normalize@1`）：Unicode NFKC；英文转小写；去掉不可见字符；连续空白折叠为一个空格并去首尾；补两个 CJK 标点映射。**原文永远保留在 A 的快照里**，C 只存归一化副本（PRD C §4.2）；
- **话题**（`text.hashtags@1` 的平台变体）：从标题、正文、`tag_text` 抽 `#话题`；`#a#b`、`#a #b`、`#a[话题]#` 三种写法都要正确；归一化、去重、保持首次出现顺序；
- **平台版本化**：解析器按平台分变体，能力标识含平台（C-D12：「平台解析差异进能力标识」），如 `text.hashtags.xiaohongshu@1`；
- **幂等**：素材指纹（标题、正文、`tag_text` 的规范化 JSON 的 SHA-256）与各信号能力版本都没变时，不写入、不产生历史；
- **失败隔离**：某信号抽取抛错时，该信号记 `failed`（带失败码与原始片段摘要），其余信号照常写入，内容事实不受影响（PRD C §4.4）；
- **1.0 不抽取**：@ 提及、POI、外链、账号昵称 / 签名（C-D06）。

**验收标准**

- `#618`、`＃６１８`、`#618 `、`#618[话题]#` 抽出同一个话题值 `618`；`#日立中央空调品牌月#日立中央空调` 抽出两个话题；
- 标题含 `ＨＩＴＡＣＨＩ　空调` 时，`title_normalized` 为 `hitachi 空调`；原文仍在 `content_snapshots.title`；
- 正文为空且平台有该字段：`body_normalized` 为 `valid` 的空字符串、`hashtags` 为空数组（不是 `failed`）；平台没有该字段：`not_applicable`；
- 注入一个会抛错的话题解析器，`hashtags` 为 `failed`，标题与正文信号仍为 `valid`，特征行已写入；
- 同一快照重复处理、或新批次的快照文本未变，特征行内容与 `updated_at` 之外的字段不变，历史表不新增行；
- 抖音与小红书的话题解析使用不同的能力标识，且在目录导出里可区分。

### SG-4 · 评论文本信号

**陈述**：系统 SHALL 为 `active` 状态的评论抽取 `comment.text_normalized`，写入评论特征行。评论正文在评论入库后尽快抽取（PRD C §4.3）。

- 评论是最新态，没有快照版本。素材指纹 = `content_text` 的 SHA-256；正文变了就重算，旧值进历史表；
- 触发：扫描 `comments.last_seen_at` 之后的评论（该列已有索引 `idx_comments_last_seen`），不新增索引；
- `suspected_deleted` 与 `deleted` 的评论 SHALL NOT 新抽取；已有特征行保留（评论删除不是特征的删除理由，保留期按 SG-10）；
- 快手没有评论，目录里不含快手；
- 评论作者 ID、昵称、点赞数是 A 的事实，C 不复制（C-D07）。

**验收标准**

- 评论入库后下一轮扫描产生特征行；同一评论正文不变再次出现，不写入；
- 评论正文被平台修改后，特征行更新，旧值进历史表；
- `suspected_deleted` 的评论不被新抽取；
- C 的任何表都不含评论作者 ID、昵称、点赞数列。

### SG-5 · 特征存储与版本

**陈述**：系统 SHALL 用「特征行」存 0 档结构化信号的**当前值**，用「历史表」存被取代的旧值（C-D13）。

- 内容特征行一个内容一行，记录它所基于的 `content_snapshot_id`；值写在可下推的列里（`title_normalized`、`body_normalized`、`hashtags`），每个信号自己的状态、能力标识、能力版本、产出时间写在 `signals` 信封里（PRD C §6.2）；
- **不倒退**：特征行只接受比当前所持快照「更新」的快照，比较规则与 `selectCurrentContentSnapshot` 相同——`(batch.logical_at, batch_id)` 严格更大。旧批次迟到不得覆盖（`data-discipline.md` 纪律 5）；
- **只有素材变了或显式重算才写**：快照推进但素材指纹不变时，只更新所持 `content_snapshot_id`，不写值、不写历史；
- 值被取代（素材变了、显式重算升到新能力版本）时，旧值 SHALL 在同一事务内写入历史表，带取代原因与保留期；
- **版本精确到单个信号**：`signals` 信封里每个信号独立记能力标识与版本；升级话题解析不改变标题归一化信号的版本，也不让匹配分变成 `stale`；
- 特征读取 SHALL NOT 依赖 ODS 是否仍在。

**验收标准**

- 一个内容在数据库里只有一行特征行（主键 `content_id`）；信封里每个信号都有 `state`、`cap`、`ver`、`at`；
- 先写入批次 5 的快照特征，再迟到处理批次 3 的快照：特征行不变，仍指向批次 5；
- 标题改了：特征行更新为新值，历史表新增一行（取代原因 `material_changed`），其中是旧标题的归一化值；
- 只把 `text.hashtags` 的版本从 1 升到 2：标题与正文信号读作 `valid`，话题读作 `stale`，`content.cover_template_score` 不受影响；
- 删除 ODS 对象后读取特征不受影响（读取路径不引用 ODS 表）。

### SG-6 · 复用键与派生结果

**陈述**：派生信号（匹配分、ASR 文本、判定）SHALL 存为不可变的结果行，复用键为：

```text
信号键 + 素材指纹（SHA-256） + 参数指纹（SHA-256） + 能力版本
```

- 同一复用键只有一行（唯一键）。再次请求直接命中，**不产生第二次计算**；
- 参数指纹：模板 / 元素匹配 = 标准图 / 元素图**字节**的 SHA-256；`content.asr_text` 与其他全局信号 = 32 个零字节；`content.asr_judgement` = 标准文本、提示词版本、模型版本三者规范化 JSON 的 SHA-256；
- 标准图换了就是新的参数指纹，必须重算，不读旧结果；同一张标准图被多个监控判定计划引用时共享结果；
- 监控判定计划 ID 与版本只作血缘，写入结果行的 `lineage`，**不进入复用键**；
- 结果行**不更新**：升级能力版本产生版本更高的新行，旧行保持原样（它就是历史）。「当前值」= 同（信号、素材、参数）下版本最高的行；
- 匹配分存 `DECIMAL(4,2)`，连续 0.00–10.00；11 个整数档只用于界面展示，不进存储（C-D08）；
- 结果行带证据（原始相似度、匹配点数、内点率、预处理尺寸、耗时、能力版本；判定的结论、理由、模型版本、提示词版本）。

**验收标准**

- 同一（信号、素材、参数、版本）并发写入两次，数据库只有一行，第二次是命中而不是错误；
- 换一张标准图后，同一张封面得到一行新的结果，旧行保留；
- 两个监控判定计划引用同一张标准图（字节相同），对同一封面只计算一次；
- 结果行 `lineage` 里有计划 ID 与版本，但复用键不含它们；
- 匹配分 `10.00` 与 `0.00` 合法，`10.01` 与 `-0.01` 被 CHECK 拒绝；
- 判定结果行必有结论、理由、模型版本、提示词版本，缺一项被 CHECK 或写入前校验拒绝。

### SG-7 · 监控段与标准图

**陈述**：系统 SHALL 提供监控段：由 D 驱动、C 执行。监控段由（监控判定计划 ID、版本）标识，计划 ID 是 D 分配的不透明 `BIGINT`，C 不为它建外键。

- 监控段 SHALL 有 `draft` 与 `published` 两个状态。`draft` 可改信号集合与图；`published` 不可改（改配置 = D 发新版本 = C 复制出新草稿）；
- **信号集合**：条目引用目录中的信号键；保存与发布时校验：未注册 → 拒绝；信号在计划平台不可得 → 拒绝；`content.asr_judgement` 至多一个（PRD C §12「每计划最多一个 ASR 考核项」）；
- **标准图 / 元素图**：按图像对象（封面 / 背景 / 头像）各一张模板图，元素图按元素键多张。**同一计划版本内每个图像对象至多一张模板图**（C-D01），由唯一键保证；背景与头像只对抖音计划可用；
- **上传校验**：单张 ≤ 10 MiB；必须能被 `ImageConverter` 解码；记录原始字节 SHA-256、尺寸、MIME；
- **OSS 定位**：对象键含「监控判定计划 ID + 版本 + 图像对象 + 图片 SHA-256」（C-D02）；旧版本不覆盖；新草稿复制图片字节到新键（每行独占自己的对象）；
- **发布**：校验通过后置 `published`；已发布版本的图与信号集合不可变；
- **可执行性**：`executability(planId, version)` SHALL 按**当前目录与当前启用配置**即时计算，返回是否可执行与阻塞项（C-D10：C 删除信号后，引用它的已发布计划读作不可执行；保存与发布新版本被拒绝）；不存储该状态，也不自动改监控段；
- **清除**：`purge(planId)` SHALL 物理删除该计划全部版本的监控段、图片行与 OSS 对象，幂等；对象删除在数据库事务之外进行（失败则保留数据库行，下次重试）。**不级联删除结果行**：结果行按复用键共享，由保留期清理。

**验收标准**

- 同一草稿同一对象上传第二张模板图：替换前一张（先删后插在同一事务，OSS 旧对象删除在事务外），数据库中仍只有一张；元素图按 `element_key` 可有多张；
- 对 `published` 版本调用 `putImage` / `setItems` / `removeImage`，拒绝 `segment_immutable`；
- 发布时含两个 `content.asr_judgement`，拒绝；快手计划含 `account.bg_template_score`，拒绝；
- 超过 10 MiB 与无法解码的图被拒绝，数据库与 OSS 都没有残留；
- 把目录里某信号的启用开关关掉，已发布计划的 `executability` 变为不可执行并列出该信号，监控段数据不变；
- `purge` 之后监控段、图片行、OSS 对象都不存在；对象删除失败时数据库行仍在，重试后清除；
- 新草稿复制出的图片对象键与原版本不同、字节相同，旧版本的图仍可读取。

### SG-8 · 素材比对（模板匹配与元素匹配）

**陈述**：系统 SHALL 提供 `requestScores`，对给定监控段与主体清单，补算**缺失**的匹配分（PRD C §5.6 第 3 条）。

- **主体与素材**：内容主体 → 其 current 快照的 `cover` 引用；账号主体 → `external_accounts.current_profile_snapshot_id` 对应主页快照的 `background` / `avatar` 引用。素材指纹 = 原图 `media_assets.sha256`；
- **素材状态映射**：按 §1.4 第 7 项。`carried_forward` 的引用 SHALL NOT 参与匹配（PRD C §5.5）；缺素材的主体返回 `missing` 与原因，并在返回里列出「需要素材」的主体，供 D 向 A 提需求（C 自己不提）；
- **补算**：只对「缺失」建任务（§1.4 第 10 项）；已有分数（含 `stale`）不重算；任务按复用键幂等，重复请求不产生重复任务；
- **计算**：C 的任务 runner 为两张图各生成短期签名 URL，调用 Python `POST /v1/image/match`；Python 返回 0.0–10.0 分与证据，并回报能力标识与版本；C 校验回报的版本与目录一致，不一致按瞬时失败处理（防部署错位）；
- **输出**：得分、证据、能力版本、产出时间；**不输出「匹配 / 不匹配」**，阈值归 D（PRD C §5.4、§3.5）；
- **范围**：整图相似度（模板）与局部元素是否出现（元素）。不做局部区域匹配、多标准图选优、复杂变换（PRD C §5.4）；
- 网络调用期间 SHALL NOT 持有数据库事务（`data-discipline.md` 纪律 2）。

**验收标准**

- 对 100 个内容主体请求补算，其中 10 个无封面引用、5 个 `pending`、5 个 `carried_forward`：80 个建任务，20 个按映射返回，且 `carried_forward` 主体没有任务；
- 第二次对同一批主体请求补算：不新增任务；任务完成后再请求：不新增任务；
- 换标准图后再请求：对同一批主体新建任务；
- 能力服务回报的版本与目录不一致：任务按瞬时失败重试，不写结果行；
- Python 对「同一张图」打分不低于 9.5，对「缩放 + 轻度旋转 + 轻度亮度变化」后的同图不低于 7，对无关图低于 2；对嵌入场景图的元素裁剪块（元素匹配）不低于 6，对不含该元素的场景图低于 2（用程序合成的纹理图离线断言**排序与大致区间**，不冻结具体数值；真实样本标定见 SG-15）；
- 任务 runner 调用能力服务的过程中，数据库连接池里没有未提交的事务。

### SG-9 · 音频理解（ASR 与大模型判定）

**陈述**：系统 SHALL 支持 `content.asr_text` 与 `content.asr_judgement` 的编排，所有模型调用 SHALL 经 `AiGatewayPort`（PRD C §11.1）。

- `AiGatewayPort`：`activeModel(purpose)` 返回当前已验证可用的模型版本或 `null`；`transcribe(...)`；`judge(...)`。每次调用带 `callKey`（等于任务幂等键的十六进制），网关对相同 `callKey` SHALL 返回同一结果且不重复计费（H PRD §4.6）；
- **默认 disabled**：默认实现 `DisabledAiGateway.activeModel()` 返回 `null`。此时两个信号读作 `missing`（`capability_disabled`），**不创建任务、不发任何调用**（D PRD D-D15、宪法 C15）；
- **ASR**：素材 = 音频媒资字节 SHA-256；全局信号，所有监控判定计划共享一份；输出转写文本、语言、时长；
- **判定**：参数 = 标准文本 + 提示词版本 + 模型版本；模型版本来自 `activeModel()`，**先取模型版本再算参数指纹**；输出结构化结论 `{verdict: 'meets' | 'not_meets', reason}`，带模型版本与提示词版本；模型拒绝或输出不符合 schema → 确定性失败（`model_refused` / `invalid_output`），**不写成不达标**；
- **提示词**：1.0 的判定提示词与输出 schema 由 C 保管，随代码版本化（`prompt_version` 整数）；H2 落地后再迁移存放，迁移不改变已有结果；
- ASR 转写不存在时，判定任务 SHALL 先依赖 ASR 结果（同一请求内两步顺序执行，ASR 未完成时判定读作 `missing`、`pending: queued`）；
- 每个监控段至多一个判定项（SG-7）；
- 音频不在库（A 未归档）：`missing`（`audio_not_archived`），不建任务。

**验收标准**

- 默认装配（`DisabledAiGateway`）下，请求补算 ASR 与判定：任务数为 0，网关调用数为 0，读作 `missing` / `capability_disabled`；
- 使用 fake 网关：同一音频两次请求，ASR 只调用一次；不同标准文本的判定互不复用，相同标准文本 + 提示词版本 + 模型版本的判定复用；
- fake 网关把 `activeModel` 的模型版本从 `m1` 换成 `m2`：新请求产生新的判定结果行，`m1` 的行保留；
- fake 网关对同一 `callKey` 两次调用只计费一次（fake 的计数器断言）；任务在 ASR 调用成功后、写结果前崩溃，重启重试用同一 `callKey`，结果行只有一行；
- 模型输出缺 `reason` 或 `verdict` 非法：结果行为 `failed`（`invalid_output`），不是 `not_meets`；
- 网关抛瞬时错误：任务重试；用尽后 `dead`，没有结果行；
- 判定结果行必含结论、理由、模型版本、提示词版本。

### SG-10 · 能力版本、`stale` 与保留期

**陈述**：

- **所有信号跟随最新能力版本**（C-D03）；监控段不存固定能力版本；每次计算把实际版本写进结果与证据；
- **能力升级不升计划版本**（C-D04），不触发 D 的计划重算，不主动重算任何历史（PRD C §7.2）；
- **`stale` 策略由读取方指定**：`use_stale`（默认，旧值可用并标 `stale`）或 `as_unknown`（旧值不可用，读作不可用）；C 不替 D 决定单个计划的策略（C-D05）；
- **保留期**（PRD C §6.4）：

| 对象 | 规则 | 实现 |
|---|---|---|
| 未被判定引用的结果行 | 1 年 | `expires_at = produced_at + 1 年` |
| 失败结果行 | 3 个月 | `expires_at = produced_at + 3 个月` |
| 被判定引用的结果行与历史行 | 3 个月（申诉期），自引用时起算 | D 调用 `retainUntil` 延长 `expires_at`（取较大值，只增不减） |
| 历史表里的旧值 | 同上；无判定引用后清理 | `expires_at` |
| 特征行（当前值） | 随内容存在，不清理 | — |

- 清理器 SHALL 分块删除 `expires_at` 已过的结果行与历史行，幂等，可重复运行；
- 清理后，该信号读作 `missing`；**清理与读取都不触发新的识别任务**（PRD C §12）。

**验收标准**

- 升级某信号版本后，历史结果读作 `stale`，没有新任务产生，没有新的监控段版本；
- `stalePolicy: 'as_unknown'` 时，`stale` 行返回 `usable: false` 且不带值；`use_stale` 时返回旧值与 `stale` 标记；
- 用 `FakeClock` 推进 13 个月：未引用的结果行被清理；推进 4 个月：失败行被清理；
- `retainUntil` 把一行的 `expires_at` 延后后，到原时间点仍保留；传入较早时间不会缩短；
- 结果行被清理后，读取得到 `missing`，任务表中没有新任务；
- 特征行不被清理器删除。

### SG-11 · 显式受控重算

**陈述**：系统 SHALL 提供受控重算，且 SHALL NOT 提供「重算全部」。

- **范围必填**：至少给出一种范围（§1.4 第 13 项）；没有范围或范围展开后为空，拒绝；
- **先预览后执行**：`preview` 返回将处理的对象条数与涉及的信号；`apply` 才写入。1.0 只展示条数；档 1 免费，不展示费用（PRD C §7.2 第 2 条）；
- **授权**：`rule.definition.manage`，且范围受操作者品牌范围约束（C 不扩大权限）；
- **记录**：每次执行写一行重算记录，含操作者、信号、范围、预览条数、起止能力版本、起止时间、状态；同时写审计事件；
- **效果**：重算只处理范围内的对象，把该信号升到当前能力版本；旧值进历史表（特征行）或保留为旧版本行（结果行）；**不升计划版本**；
- 重算与补算的区别：补算只填缺失，重算会覆盖 `stale`；
- 重算期间 D 继续读旧值并标 `stale`（PRD C §7.3）；
- 范围展开分块执行，崩溃后可续跑，不重复处理。

**验收标准**

- 不带范围调用 `apply`，拒绝 `scope_required`；
- `preview` 与随后 `apply` 的条数一致；`preview` 不写任何表；
- 无 `rule.definition.manage` 的操作者被拒绝；品牌范围外的对象不在展开结果里；
- 重算后，范围内对象读作 `valid`，范围外的同信号仍读 `stale`；
- 重算记录与审计事件各有一条，含操作者与范围；
- 重算中途杀进程，重启后续跑并最终完成，每个对象只被处理一次（历史表无重复）；
- 重算不改变任何监控段的版本。

### SG-12 · 读取口与补算请求（给 D 的契约）

**陈述**：系统 SHALL 提供三个面向 D 的函数，D 不直接读 C 的表（PRD C §11「C 不写 A 的表，D 不写 C 的表」）：

```ts
SignalReader.read(subject, signalKey, { param?, stalePolicy }): SignalValue
SignalReader.readMany(subjects, signalKey, { param?, stalePolicy }): Map<subject, SignalValue>
requestScores(segmentRef, subjects): RequestResult        // 补缺失，免费
executability(segmentRef): Executability
retainUntil(resultIds, until): void
```

- `SignalValue` 含：`state`、`usable`、`value`（`usable` 时）、`score`、`evidence`、`capability: {id, version}`、`producedAt`、`reason`（`missing` / `failed` / `not_applicable`）、`pending`、`resultId`（派生信号）；
- `param` 对参数化信号必填：模板 / 元素 = 监控段中的图片引用；判定 = 监控段中的判定项。缺参数拒绝 `param_required`；
- 读取口 **SHALL NOT** 创建任务、**SHALL NOT** 调用能力服务或网关；补算只经 `requestScores`；
- 读取 `readMany` 一次最多 5,000 个主体，单次查询解决，不逐个往返；
- 1.0 完成通知用**轮询**（PRD C §13.6）：D 反复调用 `readMany`，`pending` 提示区分「排队 / 运行中 / 已死亡 / 无任务」；
- 读取的返回里**不含内容原文**；证据下钻时的字段可见性随调用方对象的读取权限，由调用方（D）负责（PRD C §9）。

**验收标准**

- `read` 与 `readMany` 在任意状态下都不使 `signal_tasks` 行数变化、不使能力服务与网关的调用数变化；
- `readMany` 对 5,000 个主体的数据库查询次数为常数（不随主体数增长）；
- 参数化信号缺 `param` 被拒绝；
- 排队中的任务让对应主体返回 `missing` + `pending: queued`；任务 `dead` 时返回 `pending: dead` 与原因；
- `requestScores` 对草稿与已发布的监控段都可用（业务进入第 2 层时就要试跑，不等发布，PRD C §5.6）；监控段不存在、`executability` 为不可执行、或主体清单超过 5,000 时拒绝。

### SG-13 · 任务执行：租约、fencing、幂等

**陈述**：C 的异步工作（匹配、ASR、判定、重算分块）SHALL 走 C 自己的任务表，不复用 `sync_tasks`（它的 `batch_id` / `provider_id` 为 NOT NULL，会迫使 C 伪造批次与供应商）。

- 任务有幂等键（复用键的哈希），重复入队返回既有任务；
- 领取使用租约与递增的 fencing 令牌；陈旧 worker 的结果写入 SHALL 被拒绝（宪法 C14）；
- 瞬时失败按退避重试，至多 `max_attempts` 次后置 `dead`；`dead` 任务可由 `requestScores` 重新激活（计数清零）；
- 任务进程崩溃：租约过期后被接手，结果行唯一键保证不重复；
- **网络调用不持有事务**：「读输入 → 事务外调用 → 短事务带 fencing 写结果」；
- 任务保留一年（与 ODS 同寿命），期满清理；
- 不修改 `orchestrator/claim.ts`、`SYNC_TASK_ACTIONS` 与 `ck_sync_tasks_action`。

**验收标准**

- 两个 worker 抢同一个任务，只有一个拿到；租约过期后另一个接手，旧 worker 的写入被拒绝且零写入；
- 任务在调用返回之后、事务提交之前崩溃，重启后结果行恰好一行；
- 重试用尽后任务为 `dead`，`requestScores` 再次请求把它置回 `pending`；
- 静态检查：`signals` 模块不 import `orchestrator/claim`，不写 `sync_tasks`。

### SG-14 · 授权与审计

**陈述**：

- C 的函数 SHALL 经 `assert(actor, capability, resource)` 入口授权，先 Capability、再 actor 自带的品牌范围，两步都先于任何数据库读取（沿用 `a-activity-plan` 的写法）；
- Capability 对应：监控段写入、上传标准图、重算 = `rule.definition.manage`；`requestScores` = `rule.run.execute`；读取口与证据读取 = `rule.definition.read`（D 以服务身份调用）；CLI 的 `show` = `data.content.read` / `data.account.read`；
- 能力版本升级、`retainUntil`、清理器、扫描器使用固定服务身份 `service:signals-worker`，不经用户范围；
- 审计事件（结构化日志，沿用 `AuditSink` 端口）至少覆盖：监控段创建 / 发布 / 清除、标准图上传 / 删除、重算预览 / 执行、任务 `dead`；事件不含图片字节、文本原文、签名 URL、模型 Key；
- CLI 身份来自环境变量，缺任一项启动失败（不退化成全部范围）。

**验收标准**

- 缺 Capability 的调用在任何读库之前被拒绝（以查询计数器断言）；
- 越出品牌范围的对象表现为「未找到」，不泄露存在性；
- 审计事件字段里没有签名 URL、文本原文；
- 缺任一身份环境变量，CLI 启动失败，退出码非零。

### SG-15 · 配置、门控与默认离线

**陈述**：

- **启用开关**：每个能力有启用状态，由环境变量 `HBECHO_SIGNALS_ENABLED`（能力标识逗号分隔）显式给出，**缺省只启用文本类能力**（免费、纯函数）。`image.template`、`image.element` 在真实样本标定完成并由刘学奎签字之前**不得**加入生产启用集；`speech.asr`、`speech.judge` 另需网关 `activeModel()` 非空；
- 未启用的能力：信号读作 `missing`（`capability_disabled`），不建任务；
- 成本与并发类数值（评分任务并发、重试次数、租约时长、签名 URL 有效期）**没有代码默认值**，必须在配置里显式给出；起始值写在 design §14 的建议里，不当作合同；
- **默认测试离线**：fake 能力服务、fake 网关、fake OSS、`FakeClock`；`network-deny` 沿用；CI 不发起任何真实调用；
- **真实 smoke**：ASR / 大模型的真实调用不在本 spec 内；属于 `h-ai-min`，需要人工批准、显式开关、固定预算与审计摘要；
- 标定样本由业务提供，仓库只存脱敏后的样本清单与标定报告，不存业务原图。

**验收标准**

- 默认配置下，目录中只有文本类信号为已启用；图像与语音类读作 `missing` / `capability_disabled`；
- 启用集里写目录外的能力标识，启动失败；
- 缺少必填的数值配置，启动失败并指出缺哪一项；
- 测试进程启动时网络 socket 被禁止；
- `./scripts/verify.sh` 通过；Python 侧未验证时明确写出，不声称通过。

### SG-16 · 对既有代码的改动与护栏

**陈述**：

- 对 A 域代码的改动只有两处：`contents` 表加一条索引（R1）；`src/db/schema/index.ts` 导出新 schema 文件；
- Python 服务新增 `match.py` 与端点；`pyproject.toml` 增加 `opencv-python-headless`；
- 静态护栏（加入 `acceptance-boundaries.test.ts`）：① `signals` 模块不得对 A 域表（`contents`、`content_snapshots`、`comments`、`media_*`、`external_accounts` 等）做 `insert` / `update` / `delete`；② `signals` 模块不得 import `provider-adapter` 的供应商调用或 `raw-capture` 网关；③ `signals` 下的 `*.db.test.ts` 加入 `Promise.all` 扫描；④ 网络调用只允许出现在 `matcher-client`（能力服务）里，AI 只经 `AiGatewayPort`。每条护栏配一个故意违规的反向用例。

**验收标准**

- `drizzle-kit generate` 不产生新迁移；迁移在空库上成功并幂等；
- 四条静态护栏各有一个反向用例，违规时护栏报错；
- 既有测试（`pnpm test`、`pnpm test:db`）保持通过。

## 3. PRD 验收项映射

C PRD §十二的验收清单与本 spec 需求的对应：

| PRD 验收分组 | 本 spec 需求 |
|---|---|
| C1 文本信号 | SG-1、SG-3、SG-4 |
| C2 档 1 模板匹配 | SG-6、SG-8 |
| C3 音频（1.0） | SG-9 |
| C4 特征存储 | SG-5、SG-6 |
| 版本与重算 | SG-10、SG-11 |
| 标准图与监控段 | SG-7 |

PRD 里的 `[手工]` 项「运营能在一个对象下看到用了哪版能力、什么时候算的、匹配点数量」本 spec 不交付页面，用 CLI `signals show` 输出代替，由评审人在测试机上看一次（acceptance M1）。

## 4. 需求级完成边界

- 完成全部 SG 需求**不自动代表** C 域对业务可用：D 未落地，没有消费方；H1 未落地，第 3 层默认 disabled；图像匹配的分数映射需要真实样本标定后才能进生产启用集；标准图专用桶未创建；
- 本 spec 的「完成」指：文本信号随 current 指针自动产出并可读；监控段与标准图可建、可发布、可清除；模板 / 元素匹配在离线与测试机上可算；ASR 与判定在 fake 网关上完整可证；`stale`、重算、保留期、五态有离线测试；读取口与补算请求有契约测试；
- 本 spec 不关闭 design §14 中标「待确认」的各项；它们的结论由刘学奎在评审时给出，给出前相应条目保持 `draft`。
