# D 规则与考核（d-rule-engine）· 需求

> **状态**：`draft`
>
> **模式**：Design-First
>
> **实现状态**：未开始。界面设计已于 2026-11-13 确认（design §15.6，`precision/` v15），页面任务见 tasks 13–16；design §14 其他项按任务边界处理
>
> **所属域**：D 规则与考核 · **目录命名**：`d-rule-engine`，符合 `<代号>-<切片>`；路线图第 7 位（[`INDEX.md`](../../../HBECHO设计方案/INDEX.md) §7）。取代旧目录 `rule-engine`（已归档，见 §1.3 R1）
>
> **上游 PRD**：[`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md) v1.2（定稿候选），产品语义以它为准；本 spec 只补实现层的取舍与 PRD 没写死的真空
>
> **相邻 PRD**：[`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md) v1.3（信号、监控段）、[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11（活动计划、按需采集）、[`prd-domain-e-metrics.md`](../../../HBECHO设计方案/prd-domain-e-metrics.md)（结果的消费方与导出出口）、[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21（Capability）、[`prd-domain-h-ai.md`](../../../HBECHO设计方案/prd-domain-h-ai.md)（模型通道）、[`prd-platform.md`](../../../HBECHO设计方案/prd-platform.md) §6.11（三层对象）
>
> **相邻 spec**：[`c-signals`](../c-signals/requirements.md)（监控段与信号读取口；**D 是它的唯一消费方，接口以它为准，缺口走 design §10.3 的对齐请求**）、[`a-activity-plan`](../a-activity-plan/requirements.md)（名单读取口与下游端口）、[`b-access-control`](../b-access-control/requirements.md)
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)（draft）。D 的表**不入 v2**，以本 spec design §6 为准（与 B、C 同一做法）；对 A 域表**没有任何修改**
>
> **最近核对**：2026-11-16（核对对象：`src/db/schema/{activity-plan,content,accounts,sync,org}.ts`、`src/modules/{activity-plan,demand,access-control,sync-ops,sync-runner}`、`src/worker/plan-cli.ts`；C 以 `main` 上已合入的代码为准（2026-11-16 复核：`src/modules/signals`，`requestScores` 的 `RequestContext.only`、`segments.executability(actor, ref, { only })` 均已存在）；D 对 C 的调用形状见 design §4.1）
>
> **更新日期**：2026-11-16
>
> **语言约定**：正文中文；验收标准中的规范性关键词 `SHALL` / `SHALL NOT` / `MAY` 与技术标识保留英文（对齐 `c-signals` 的写法）。

## 1. 引言

### 1.1 权威顺序

冲突时按此顺序裁决，不在代码、SQL 或本 spec 里暗中选择一方：

1. [`CONTEXT.md`](../../../CONTEXT.md)：领域词汇与不变量（尤其 4、8、14、19、20，以及 MonitoringJudgementPlan、AssessmentItem、Unobtained、Participant 词条）；
2. [`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md) v1.2：D 域产品语义的唯一真相源。判定模型（§2.0.2）、三层条件、达标方式、零内容、版本与回退、结果下载走 E6 以它为准；
3. [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) 与已合并的 `src/db/schema/*`：快照、归属、评论、同步任务的物理基线。D 只读这些表；
4. [`c-signals`](../c-signals/requirements.md) spec 与 [`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md)：信号、监控段、补算与读取口的合同；
5. [`prd-domain-e-metrics.md`](../../../HBECHO设计方案/prd-domain-e-metrics.md)、[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md)、[`prd-domain-h-ai.md`](../../../HBECHO设计方案/prd-domain-h-ai.md)：消费方、授权与模型通道的产品语义；D 与它们冲突时先停下来协调；
6. [`a-activity-plan`](../a-activity-plan/requirements.md)、[`a-full-sync`](../a-full-sync/requirements.md)、[`b-access-control`](../b-access-control/requirements.md)：已合并的实现与约定；
7. 本 spec：不得静默改写以上事实。旧 [`rule-engine` design](../../../HBECHO设计方案/archive/rule-engine-design-2026-09-02.md)（已于 2026-11-16 归档）只作历史素材，其中的 `AssessmentItem`、`composite`、分项率、同平台多账号聚合、`OutcomeSet` 的 item→run 映射都**不再成立**。

### 1.2 上游与依赖

| 依赖 | 当前状态（2026-11-12 核对） | 对本 spec 的影响 |
|---|---|---|
| A：活动计划（`a-activity-plan`） | 已合并 `main`（迁移 0009）。`reader.rosterSnapshot(planId)` 返回在名单项（`staffId / storeId / branchId / accountId / effectiveMonitoring`，**加入名单当时的快照**）；`statusOf`；`PlanDownstream`（`summarize / onDeleted / onRestored / purge`）默认 `noDownstream`，`plan-main.ts` 未传入 | D 的名单来源。D 实现 `PlanDownstream` 并在装配处注入（JP-17）。`rosterSnapshot` **不含**平台、品牌、起止日期，D 另查 `activity_plans`。`plans.remove` 只靠 `summarize().running` 判断「有判定在执行」，什么算在途由 D 定义 |
| A：按需采集（`demand`） | 已合并。`submit` 需 Capability `data.sync.trigger`，`requester` 是自由结构（`kind / ref / version`），幂等作用域含 `actorId`，一次 ≤ 5,000 项，`wants ∈ detail / comments / video / audio`；`get` 只能查自己提交的批次；**没有回调，只能轮询** | D 向 A 提出「音频」「评论」需求（JP-12、JP-10）。封面、头像、背景不是 `wants`：它们由 A 的常态采集归档，D 只能读状态（JP-6） |
| A：内容 / 账号 / 评论 / 归属 / 同步任务 | 已合并。`contents.current_snapshot_id` 指向 finalized 快照；评论只有最新态；`staff_account_assignments.staff_id` 是**当前**归属，改绑只改它（`sync-ops` 的 `rebind`），**不回写**名单项的 `staffId / storeId / branchId` | 归属以执行时的当前归属为准（PRD D §2.0.1）；名单项里的组织字段只是加入当时快照，仅用于可见范围。**A 没有「账号在时间窗内同步是否完整」的查询**（`sync-status.freshness` 只看最近成功时间且把 `succeeded_with_gap` 算成功），D 自建谓词（JP-9、design §7.5） |
| C：识别能力（`c-signals`） | **已实现并合入 `main`**（2026-11-16 复核，接口以代码为准；`readMany` 返回 `Map<bigint, SignalValue>`，`requestScores` 与 `executability` 都支持 `only`）。`SignalReader.read / readMany`、`requestScores`、`executability`、`retainUntil`、`segments.*`、`normalizeKeyword` 是 D 的唯一入口；C 的 `SignalActor` seam 在 B 落地后改为适配器 | D 只经这些函数取信号，不读 C 的表。C 的 design §14 第 11、12 项明确留给本 spec 关闭（design §10.3）。D 的离线测试用 fake `SignalsPort`，契约测试在 fake 与 C 的真实实现之间共享 |
| B：访问控制 | 已合并。29 项 Capability；`rule.*` 只有 `definition.read / definition.manage / run.execute` 三项；`createAuthorizer`、`AuditWriter`、`defaultRegistry` 可用；`PREDICATE_NAMES` 含 `plan_creator` 但**没有人注册谓词体**；`SERVICE_PRINCIPALS` 里**没有任何持有 `rule.*` 的服务身份**；`RESOURCE_KEYS` 已含 `judgement_plan`、`rule_config`、`report` | D 走 B 的 `authorize`（与 `learning` 同一做法，不再走 A 那种 `assert` seam）。D 需要：注册 `judgement_plan` 的 ScopeStrategy、注册 `plan_creator` 谓词；后台运行继承提交人身份（`contextForUser`，JP-18），B 零改动 |
| E：指标与看板（`e-metrics`，第 8 位） | **PRD 定稿候选；spec 未开始**；旧 `metrics-and-dashboard/design.md` 仍写 `RuleOutcomeReader / OutcomeSet / ItemOutcome / AttributionSnapshot（owner 未决）` | D 先定义 `JudgementOutcomeReader`（JP-16），E 的 spec 开工时对齐。**本 spec 关闭 `AttributionSnapshot` 的 owner 问题**：D 在每次执行里冻结参与专员的组织链（design §6），E 只读不建（建议，待 E 确认，design §14 第 17 项） |
| H：AI 网关（`h-ai-min`，第 10 位） | 未开始，仓库无网关代码 | D 不直接调模型。第 3 层经 C 的 `AiGatewayPort`，默认 disabled；有第 3 层条件的计划在 H1 落地并通过 smoke 之前**无法发布**（JP-12） |
| 付费调用 | production capability 全部 disabled | D 自己不发任何供应商调用。第 2 层匹配分免费；第 3 层 ASR 与判定付费，只经 C。默认测试离线 |
| 界面基线 | [`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md) `current`（2026-11-10）；D 原型为 [`precision/`](../../../ui-lab/d-rule-engine/precision/) v15 | **已确认（2026-11-13）**；页面任务见 tasks 13–16 |

**不依赖的东西**：真实用户登录页面、E 的投影、真实 AI Master 调用、ODS、H1 网关、C 的真实 Python 服务（D 的离线测试用 fake）。

### 1.3 与 v2 基线及上游文档的冲突（实施前必须修订）

| # | 位置 | 现状 | 本 spec 的修订要求 |
|---:|---|---|---|
| R1 | 旧 `.kiro/specs/rule-engine/design.md`；`INDEX.md` 第 16 行、第 92 行、§5 规则引擎行、§7.1 偏差行；`scripts/check-doc-registry.py` 的 `DESIGN_ONLY_SPECS` | 旧 design 仍写 `AssessmentItem`、`composite`、分项率、同平台多账号聚合 | 初建时**只在旧 design 文首加了「已被取代」说明**并在 INDEX 登记本 spec；**归档**（移到 `HBECHO设计方案/archive/rule-engine-design-2026-09-02.md`、写 `superseded` 头、修复 PRD D / PRD C / 子 PRD 草案 / `metrics-and-dashboard/design.md` 里的 4 处链接、`DESIGN_ONLY_SPECS` 去掉 `rule-engine`；INDEX 里的链接初建时已改）留给任务 0，闸门通过后做——这些文件里有些正被别的会话编辑，不在写 spec 时顺手动 |
| R2 | PRD D §2.0.1「执行期间名单锁定：运行中不允许修改本计划的名单」 | A 没有任何「D 正在执行」的钩子；`plans.remove` 只检查删除 | D **冻结**名单快照，使运行中的名单变化不影响本次结果；**不**阻止 A 修改名单。字面要求「不允许修改」未实现，留作 design §14 第 4 项，建议接受冻结语义 |
| R3 | B PRD §7.3「`rule.run.execute` 只作用于已发布版本；试运行复用 `rule.definition.manage`」 与 C SG-12「`requestScores` = `rule.run.execute`，草稿也可调」 | 两处对草稿试跑的 Capability 说法不同 | D 在**自己的边界**按 B 授权（试跑 = `manage`，执行 = `execute`）；D 的后台运行继承提交人身份（JP-18），C 的 Capability 检查对提交人生效：执行需 `rule.run.execute`，试跑的提交人需同时持有 `rule.definition.manage` 与 `rule.run.execute`（现有角色里二者同属 platform_admin 与 hq_manager） |
| R4 | `src/modules/access-control/service-principals.ts` | 无 `rule.*` 持有者 | **不新增服务身份**（2026-11-16 修订，原拟 `service:judgement`）：D 的后台运行继承提交人身份，B 零改动；A 的 `ActorContext` 不能表达品牌范围，B 的 `toTracerActor` 对非全范围用户拒绝适配，D 的 `demand` 调用用自己的窄适配（design §9，§14 第 31 项） |
| R5 | `src/modules/access-control/scope.ts` | `plan_creator` 谓词已登记名字但无体；`judgement_plan` 资源键无 ScopeStrategy | D 在装配处各注册一次（`defaultRegistry`，先查再注册，沿用 `learning/runtime.ts` 的写法） |
| R6 | `metrics-and-dashboard/design.md` §8.1 / §8.3 与 PRD D v1.1 | E 的旧 design 按 `OutcomeSet / ItemOutcomeFact` 写，D v1.1 已没有考核项与 item | D 定义 `JudgementOutcomeReader`（JP-16）；E 的 spec 开工时对齐，不在 D 里保留旧形状 |
| R7 | `CONTEXT.md` 跨域消费词汇 | 没有「判定执行」 | 增加 JudgementExecution 一条，只写语义（任务 0） |
| R8 | `INDEX.md` §5 / §7 / §7.1 | 路线图第 7 位预占 `d-rule-engine`，无 spec 条目 | 登记本 spec 的四件套与状态（本次初建已完成） |
| R9 | PRD D §七第 6 行「`rule-engine/design.md` 待订正」 | 现在由本 spec 取代 | 该行改为「已闭合（`d-rule-engine`，2026-11-12）」并指向新目录（任务 0） |
| R10 | PRD D §2.0.1 圈定 / 比对 / 执行与「状态流转：草稿 → 已圈定 → 已比对 → 执行中 → 已完成」 vs D-D08「计划版本只由配置变更并发布产生」 | PRD 没有写「发布」发生在向导的哪一步 | 本 spec 解释为：**第 3 页「确认执行」即发布**（JP-3），详见 §1.4 第 1、2 项；待确认 |

> D 对 A 域的表、C 域的表**零修改**（只读 A，只经函数调用 C）。

### 1.4 PRD 真空与本 spec 的解释

PRD 没有直接写死、但实现必须选一条的地方。「已定」表示 PRD 或已合并 spec 已有结论；「本 spec 建议」表示这是本 spec 的解释，**评审通过前不得被代码或示例默认冻结**（宪法 C18），汇总在 design §14。

| # | 问题 | 结论 | 性质 |
|---:|---|---|---|
| 1 | 「发布」发生在向导哪一步 | **第 3 页确认执行即发布**：存在草稿时，确认把草稿发布为新版本并冻结、同时开始执行；没有草稿时，「重新执行」对最近已发布版本再跑一次，不升版。草稿只来自「新建草稿」（用户要改配置），所以版本只在用户改过配置后增长；圈定、试跑、执行都不升版（D-D08） | 本 spec 建议 |
| 2 | 回退删什么 | 回退只作用于**草稿**：删除后续步骤产生的圈定 / 试跑结果与该步的配置选择。**已发布版本的执行结果不因回退被删**（它们是旧版本，「重算的旧版本结果保留可查」，D-D08）；发布后要改配置，是「新建草稿」（v+1），草稿落在目标页。不保留被回退的草稿结果的历史（2026-10-30 决定） | 本 spec 建议（与 PRD 字面「第 3 页回退到第 2 页」的差异见 design §7.9） |
| 3 | 时间窗放哪 | 时间窗是判定段**配置字段**（第 1 页配置，创建时默认拷贝活动计划起止日，之后与活动计划脱钩）；北京时间自然日，闭区间；`to` 为空 = 到执行冻结时刻 | 本 spec 建议（PRD §2.2 表写「时间窗：计划级」） |
| 4 | 参与内容的边界 | 参与内容 = 账号名下 `status='active'`、有 finalized current 快照的内容，且**发布时间落在窗口内**，且**形态符合计划级形态条件**。发布时间缺失、形态 `unknown`（计划只要视频或只要图文时）的内容**无法归入也无法排除**，按「参与但未获取成功」处理，原因 `published_at_missing` / `content_kind_unknown`，计入 T 与 U（不吞掉） | 本 spec 建议 |
| 5 | 内容快照固定到哪一个 | 范围构建时把每条参与内容的 `current_snapshot_id` 冻结进执行（`content_snapshot_id`），之后 current 指针移动不影响本次执行（`data-discipline` 纪律 5） | 本 spec 建议 |
| 6 | 「归属」用哪个 | 参与专员 = 名单账号在**执行冻结时**的 `staff_account_assignments.staff_id`（当前归属），不是名单项里的 `staffId`；组织链从该专员当前的门店向上取并冻结。两个名单账号解析到同一专员 = 不变量被破坏，冻结失败并报问题，**不静默取一个** | 已定（PRD D §2.0.1）；冲突处理为本 spec 的 |
| 7 | 文本条件怎么匹配 | 关键词按「所选字段（标题 / 正文）中任一字段含该词」判命中，`all` = 每个词都命中，`any` = 至少一个；话题按**归一化后整体相等**比较，不做子串；关键词与话题保存**原文**，执行时按 `SignalValue.normalizerVersion` 调 `normalizeKeyword`（C-D17） | 已定（C）；匹配语义为本 spec 的 |
| 8 | 信号状态怎么映射成层结果 | `valid`、`stale`（C 默认可用，D-D13）→ 评估为通过 / 不通过；`missing`、`failed`、`not_applicable` → **未获取成功**（PRD §1.4：结构不适用也归未获取成功），原因码沿用 C 的；`not_applicable` 在配置阶段已被平台可得性挡掉，运行时只会来自「这条内容没有封面」之类的个体情形 | 已定（PRD D §1.4）；映射细则为本 spec 的 |
| 9 | 什么算「还在等」 | 信号 `missing` 且原因为 `not_computed` / `failed_under_old_version`，或 `pending ∈ {queued, running}`，是**在等**；其余原因（`media_*`、`audio_not_archived`、`no_profile_snapshot`、`capability_disabled`、`compute_dead` 等）对本次执行是**终态**，直接记未获取成功。在等的依赖有上限等待时间（配置），超时记 `dependency_timeout`（PRD：不等待策略，指的是不为「素材没归档」无限等待） | 本 spec 建议 |
| 10 | 第 3 层 / 图片能力未启用时 | `executability` 不可执行时**拒绝发布与拒绝开始执行**，并列出阻塞项（用户立刻看到原因，不花一分钱）；执行**中途**能力丢失（网关变为 disabled）则该层剩余内容记 `capability_disabled`，不发调用 | 本 spec 建议（PRD 验收「记未获取成功 / 不支持」落在后一半；前一半是更早的拒绝） |
| 11 | 评论覆盖不全怎么算 | 评论条数 T、命中 P、未获取 U 按内容累加；某内容评论覆盖 `partial` / `unknown` 时，缺口按 `max(1, reportedTotal − fetchedCount)`（总数已知）或 `1`（总数未知）计入 U，使「至少 N 条」等方式不会把「没抓全」判成不达标 | 本 spec 建议 |
| 12 | 同步完整的谓词 | 只用于零内容专员（D-D14），**每位参与专员都算并存**（`sync_complete` + 原因），UI 与导出可提示「同步有缺口，结果可能偏低」。谓词定义见 design §7.5；`T > 0` 时**不**用它改写 PRD 的三值表（PRD 没有这样写），是否扩展见 design §14 第 7 项 | 本 spec 建议 |
| 13 | 谁能改一个判定计划 | 创建判定计划与之后所有写 / 执行 / 取消，都要求操作者是**所属活动计划的创建者或超管**（沿用 PRD「只能选本人创建的活动计划」，每次都复核）；读取按 B-D21：所属活动计划的可见范围 ∩ 规则适用品牌 | 本 spec 建议 |
| 14 | 一个计划同时几个运行 | 同一（判定计划，版本）同一时刻至多一个未终态的运行（圈定、试跑、执行共用一个唯一键）；不同版本可并行（已发布 vN 在执行、草稿 vN+1 在圈定） | 本 spec 建议 |
| 15 | 「失败子集重试」 | 判定按内容粒度落库，**同一次执行崩溃后续跑**不重算已定的内容；重新执行（新建运行）因 C 的结果按复用键共享、A 的采集本轮复用，成本上等价于只重跑缺失部分。不另做「只重试未获取成功行」的专门模式 | 本 spec 建议（PRD 要求的是效果） |
| 16 | 判定计划归档 | E PRD 提到「判定计划归档后历史投影仍可解释，新配置不能选它」；D PRD 没写。本 spec 提供 `archive / unarchive`：归档的计划不可新建草稿、不可新建执行，历史执行照常可读 | 本 spec 建议（E 的需要） |
| 17 | 评论作者是否为指定账号 | 评论作者 ID 与 `external_accounts` 是否同命名空间未验证（PRD D §5.8）。配置里**没有**这个条件，等 A 验证后另开需求 | 已定（PRD） |
| 18 | 页面 | D 有三页向导；界面设计已于 2026-11-13 确认，页面任务见 tasks 13–16 | 已定（`structure.md`） |

### 1.5 范围

#### 1.5.1 范围内

- **监控判定计划**：创建、改名、归档 / 取消归档；与 C 监控段同 ID、同版本的协议；
- **判定段配置**：时间窗、形态、第 1 层（关键词、话题、时长、整层数量 N）、第 2 层（图片能力 + 对比元素 + 阈值）、第 3 层（ASR 判定标准）、评论要求；内容方式由 N 推导；校验；
- **版本与草稿**：草稿、发布（第 3 页确认即发布）、新建草稿、回退（删除草稿的后续结果）；
- **圈定（第 1 页）与试跑（第 2 页）**：同步圈定，异步试跑，分布与样例，圈定行的数据口（供 E6 下载）；
- **执行**：输入冻结（名单、当前归属、组织链、窗口、内容快照）、内容逐层过滤、依赖协调（C 补算、A 按需采集、轮询与超时）、专员级聚合、计划总结果、零内容与同步完整、评论与账号要求、证据、取消 / 续跑；
- **对 E 的输出**：执行描述、参与专员、内容、完成通知（轮询）、解释；
- **对 A 的下游端口**：`summarize / onDeleted / onRestored / purge`；
- **授权与审计**：B 的 `authorize`、`AuditWriter`、`contextForUser`（提交人身份）、`judgement_plan` 范围策略；
- **CLI**：`pnpm judgement`；常驻进程 `judgement run`；
- **对既有代码的小改动**：`plan-main.ts` 装配 `downstream`；INDEX / 登记脚本 / CONTEXT / PRD 链接。

#### 1.5.2 范围外

- 页面（向导三页、执行记录、结果入口）按 tasks 13–16 实现；离线验收不替代页面验收；
- 指标、点检表、专员明细页、看板、导出文件、下载中心：E。D 只提供数据口；
- 信号抽取、匹配、ASR、判定的实现与重算：C；模型调用与计费：H1；
- 采集：A。D 不调供应商、不下载媒资、不写 A 的表；
- 刷流量、互动基线、否定条件、播放量条件、发布时段、置顶处理、OCR、图片 / 视频理解、多轮对话、`text.regex`（PRD §2.2、§三、§四）；
- 「作者是否为指定账号」（§1.4 第 17 项）；
- 定时自动判定：**没有**，全部手动触发（PRD §2.0.1）；
- 部署形态（compose 服务、资源上限）：与 `a-full-sync`、`c-signals` 一样，只交付可运行的进程入口；
- 真实付费 smoke 的自动化。

### 1.6 术语

| 术语 | 含义 | 来源 |
|---|---|---|
| 判定计划 | 监控判定计划的判定段与生命周期；与 C 的监控段同 ID、同版本 | CONTEXT、PRD D §2.0 |
| 配置 | 判定段的全部可编辑内容，一份 JSON，带 schema 版本 | 本 spec |
| 版本 | `(判定计划, 整数)`；草稿或已发布；已发布不可改 | D-D08 |
| 运行 | 一次圈定、试跑或执行，统称 run；执行的 run ID 即 E 所说的「判定执行 ID」 | 本 spec |
| 参与专员 | 执行冻结时名单里的专员；一个计划平台上最多一个账号 | CONTEXT |
| 参与内容 | 窗口内、形态符合、有 finalized 当前快照的账号内容（含时间 / 形态无法归类者，按未获取成功计） | §1.4 第 4 项 |
| C1 / C2 / C3 | 通过第 1 层 / 通过第 1、2 层 / 通过全部内容层的内容集合 | PRD D §2.0.2 |
| P / U / T / F | 某专员某类要求下的通过 / 未获取成功 / 总数 / 不通过条数；T = P + U + F | 本 spec |
| 三值与 AND3 | 通过 / 不通过 / 未获取成功；`AND3`：任一不通过 → 不通过，否则任一未获取 → 未获取，否则通过 | PRD D-D04 |
| 同步完整 | 专员账号在窗口内的内容列表同步没有失败、没有缺口（design §7.5） | D-D14 |

## 2. 需求

### JP-1 · 判定计划对象与创建

**陈述**：系统 SHALL 提供「判定计划」：属于且仅属于一个活动计划，平台等于活动计划的平台，ID 由 D 分配并作为 C 监控段的计划 ID。

- 创建字段：所属活动计划、别名（去首尾空白后 1–200 字，**同一活动计划内唯一**；E 用它作列头）、可选说明；
- 创建的前置条件：活动计划存在且未删除；状态为 `collecting`（`paused / archived` 不能新建，但仍可对**已有**判定计划触发执行，PRD D §2.0）；操作者持有 `rule.definition.manage`，且是该活动计划的创建者或超管（JP-18）；
- 创建时：D 先落自己的行（状态 `provisioning`），再调 C `segments.create` 建草稿 v1，成功后置 `active` 并建 D 的草稿 v1（配置为空模板，时间窗默认拷贝活动计划起止日）。`provisioning` 的行可由 `judgement plan reconcile` 补完或清掉；C 报「已存在」视为成功；
- `archive / unarchive`：归档后不可新建草稿与执行，历史可读；不改任何版本与结果；
- 不提供单个判定计划的物理删除；整体清除只随活动计划期满清除（JP-17）；
- 查询「某活动计划下的判定计划」时，若活动计划处于回收站，一律不可见（以 `activity_plans.status` 为准）。

**验收标准**

- 活动计划为 `paused` / `archived` / `deleted` 时创建被拒；非创建者且非超管被拒；别名在同一活动计划内重复被拒（数据库唯一键）；
- 创建后 D 与 C 各有一份草稿 v1，计划 ID 相同；在「D 已落行、C 调用失败」的情形下 `reconcile` 补齐，重复创建不产生第二份 C 草稿；
- 归档后创建草稿 / 执行被拒，历史执行仍可读；取消归档恢复；
- 判定计划的 `platform_id` 与活动计划一致（复合外键保证）；活动计划进入回收站后，判定计划不出现在任何列表与读取里。

### JP-2 · 判定段配置模型与校验

**陈述**：配置 SHALL 是一份带 `schema_version` 的 JSON，由 zod 校验，字段为：

- `window`：`{ from, to? }`，北京时间自然日（`YYYY-MM-DD`），闭区间；`to` 缺省 = 到执行冻结时刻；
- `kinds`：`['video' | 'image']` 的非空子集（PRD「视频 / 图文」）；
- `layer1`：`text[]`（每项 `{ alias?, fields: ('title'|'body')[], mode: 'all'|'any', keywords: string[] }`）、`hashtags[]`（`{ alias?, mode, values }`）、`duration?`（`{ alias?, minSeconds?, maxSeconds? }`，仅 `kinds = ['video']` 时允许）、`quantity?`（`{ n: number }`，整层共享一个数量要求；见 JP-2a）；
- `layer2`：`{ abilities: Array<{ abilityId, alias?, kind: 'whole_image'|'image_element', target: 'avatar'|'cover'|'background', threshold, elementKey? }> }`；`image_text` 是 2.0 能力，1.0 不得保存或启用；`abilityId` 是 D 在创建能力时生成的稳定标识（`newDraft` 沿用，不进 `config_sha256`），证据与对 E 的输出用它指代能力，别名可为空也可重名；`elementKey` 由 D 在上传元素图时写入，值为上传字节的 SHA-256 十六进制（64 位，满足 C 的 `element_key` 正则），不由用户填写；
- `contentRequirement?`：`{ layer3?: { alias?, standardText } }`（`layer3` 只有 ASR 判定一种）；内容达标方式不再存配置，按 `layer1.quantity.n` 推导为 `at_least_n n`，缺省时为 `at_least_n 1`；
- **内容要求启用规则**（D-D21）：下列任一成立即启用内容要求——`layer1.text` / `layer1.hashtags` / `layer1.duration` 有任一项；`layer1.quantity` 存在；`layer2.abilities` 中有 `target='cover'` 的能力；`contentRequirement.layer3` 存在。都不成立时内容结果为 NULL，不参与计划总结果，也不要求「至少 1 条内容」。纯函数 `contentRequirementEnabled(cfg)` 是唯一判定入口，圈定、试跑、执行、页面共用；
- `commentRequirement?`：`{ alias?, mode: 'all'|'any', keywords: string[], method }`；
- `method`（只用于评论要求）：`{ type: 'at_least_n', n } | { type: 'all' } | { type: 'any' } | { type: 'ratio', bp }`，`n` 为 ≥ 1 的整数，`bp` 为 1–10000 的整数（万分比，**不用浮点**）；
- `alias`：每个能力可选的显示名，1–200 字；跟随判定计划保存并随版本冻结，但**不参与 `config_sha256`**（只影响显示，不影响判定）；没有别名时用能力类型名显示。
- 阈值是 0.00–10.00 的两位小数（以字符串保存，以整数百分位比较，不用浮点）。

校验规则：

- 至少启用内容（D-D21 的规则）/ 评论 / 账号三类要求中的一类，否则圈定 / 试跑 / 发布被拒（草稿编辑途中允许暂时为空，例如刚建好或刚删掉最后一个能力）；账号要求 = `layer2.abilities` 中有 `target='avatar'|'background'` 的能力；
- **平台可得性**：配置引用的每个信号必须在 C 的 `platformSignals(平台)` 里；快手不能配评论要求；小红书、快手不能配账号要求；
- **数量上限**：`whole_image` 对同一 `target` 至多一个；`image_element` 按 `target + elementKey` 唯一；ASR 判定项至多一个；`standardText` 1–2000 字；关键词 / 话题每项至多 50 个、单个 1–64 字符（数值为配置项，见 JP-19）；
- **数量要求**：`layer1.quantity.n` 为 1–1000 的整数；整层只允许一个值，UI 中文本 / 话题卡片显示同一个 N；`quantity` 缺省时不做截断，内容达标方式按 `at_least_n 1`；**`quantity` 只在 `layer1.text` 或 `layer1.hashtags` 至少有一项时可存在**，否则校验拒绝（D-D22）；页面删掉最后一张文本 / 话题卡片时，由页面在同一次保存里把 `quantity` 一并删掉，不弹提示；
- **层内组合**：同一层所有文本 / 话题 / 时长条件对同一条内容 AND；`quantity` 不是第 4 个内容条件，而是对通过全部条件的内容做“按点赞取前 N 条”的层级规则；
- **图片文字对比**：1.0 不提供；`kind='image_text'` 或任何 OCR 信号出现在配置里时，校验拒绝并指出 2.0 capability，不得静默降级为其他能力；
- 关键词与话题**保存原文**，不保存归一化结果（C-D17）；
- 评论要求的「作者是否为指定账号」**不存在**（§1.4 第 17 项）；`text.regex` 不提供；
- `contentRequirement` 缺省而 `commentRequirement` 存在时，第 1、2 层仍定义评论的候选内容（PRD D-D12）；
- 配置的规范化 JSON 的 SHA-256 存为 `config_sha256`，用于判断「配置是否变化」（JP-3）；
- 由配置推出 C 监控段的信号集合（`items`）：D 负责推导，业务不直接填信号键；
- **元素图与 `elementKey` 的写入流程**：能力在草稿里可以先没有 `elementKey`（尚未上传），草稿允许这种不完整状态；上传元素图时 D 计算字节 SHA-256 作为 `elementKey`，调用 C `putImage`，并把它写进对应 `abilityId` 的能力；换图 = 新字节 = 新 key：先写新图，再删旧 key 对应的 C 图行，并更新该能力；同一 `target` 下上传字节相同的元素图被拒绝（`element_duplicate`，提示「这张图已经作为元素上传」）；删除能力同时删除它的 C 图行；发布前所有能力必须有 `elementKey` 且 C 侧图片存在，否则被 `executability` 的 `image_missing` 挡住；
- 数量要求、能力别名、内容要求启用规则的改动按 design §7.9 的失效矩阵处理。

**验收标准**

- 缺窗口起点、`kinds` 为空、`n = 0`、`bp = 10001`、阈值 `10.01`、关键词空、`standardText` 超长，各被拒并指出字段路径；
- 内容要求启用规则：只配评论 → 内容结果为 NULL；只配头像 / 背景 → 内容结果为 NULL；只配话题 → 启用；只配视频时长 → 启用；只配 `target='cover'` 的第 2 层能力 → 启用；只配 ASR → 启用；什么要求都没有 → 草稿可保存，圈定 / 发布被拒；
- `quantity` 存在而 `layer1.text` 与 `layer1.hashtags` 都为空 → 被拒；删掉最后一个文本 / 话题项且同一次保存里去掉 `quantity` → 通过；
- ASR 的 `layer3.alias` 可保存；两个能力同名、别名为空都允许，证据靠 `abilityId` 区分；
- 元素图：上传字节的 SHA-256 作为 `elementKey`，满足 C 的正则；相同字节在同一 `target` 重复上传被拒；换图后旧 key 的 C 图行被删、能力的 `elementKey` 更新；草稿里缺 `elementKey` 的能力可保存但不能发布；
- 快手 + 评论要求、小红书 + 账号要求、`kinds` 含图文 + 时长条件，各被拒；
- 两个 ASR 判定项、同一 `target` 两个 `whole_image`、同一 `target + elementKey` 重复被拒；`quantity.n = 0`、别名超过 200 字被拒；`kind="image_text"` 或引用 OCR 被拒并指出 2.0 capability；
- 同一配置的两次序列化（键序不同）得到相同的 `config_sha256`；改 `quantity.n` 后哈希必变；只改别名时哈希不变、不触发重新圈定 / 试跑；
- 配置里没有 `regex`、否定、播放量、发布时段、作者为指定账号的任何字段（zod `strict`）；
- 由配置推出的 `items` 与 C 目录逐项对得上（`platformSignals` 之外的信号一个都不会出现）。

### JP-2a · 第 1 层数量要求与点赞截断

**陈述**：

- 第 1 层只有一个**整层共享**的数量要求 `layer1.quantity.n`；文本 / 话题能力卡片显示同一个 N，不按能力分别计数；
- 同层所有条件（文本、话题、时长）对同一条内容 **AND**；先得到满足全部条件的候选内容，再应用数量要求；
- **按专员各自取前 N 条**（D-D18 的解释，已写入 PRD §2.2）；每个专员的应用顺序：
  1. 冻结参与内容与当前快照；
  2. 按第 1 层条件过滤；
  3. 对通过全部条件的内容按**点赞量降序**排序；点赞量取冻结快照的 `like_value`，且 `like_state='value'`（A 的值状态词表：`value / missing / explicit_null / invalid / unsupported`）；**非 `value` 的状态一律**排在有效值之后，不当作 0；
  4. 有效值相同、或都无效时，按 `published_at` 降序、`content_id` 升序打破平局；
  5. 若有 N，取前 N 条进入下一层；不足 N 条时全部进入；若没有 N，不截断，全部进入；
- **N 同时是达标门槛**：内容结果按 `at_least_n N` 计算（P ≥ N 成功；P + U < N 不达标；其余未获取成功）；N 缺省时按 `at_least_n 1`，即至少一条内容通过全部内容层；N 只影响“进入下一层的集合”，不改变内容级三值；页面上的“留空 = 不限条数”只表示不截断，不代表不做内容达标；
- 第 1 层通过但未被选中的内容 **保留在运行行里**，记 `layer1_selected=false`、`layer1_rank`、`final=skipped`、原因 `layer1_not_selected`，不进入第 2 层；`C1` 条数以 `layer1_selected=true` 计数；E 读取时能看到选中标记与原因；
- 数量要求进入规范化配置与 `config_sha256`；能力别名随版本配置保存但不进 `config_sha256`。修改 N 视为配置变化，发布时按 D-D08 升版；改别名只换显示名；
- **N 只依附文本 / 话题能力**（D-D22）：配置里 `quantity` 只在有文本或话题项时可存在（JP-2）；因此「第 1 层没有任何条件却设置了 N」不会出现，`selectLayer1` 只需处理 `l1 = pass` 的行；
- **N 既是上限也是门槛的后果**：只有前 N 条进入下一层，`P ≥ N` 等价于「这 N 条全部通过」，第 N+1 位不替补（PRD §2.0.2）；
- **U / T 的口径**：内容要求的 P、U、F 取每条参与内容的 `final`（`pass` / `unobtained` / `fail`），`unobtained` 包含 `l0`、`l1`、`l2`、`l3` 任一层的未获取成功；`final='skipped'`（未被选中）单独计数，不入 P / U / F；零内容 = 参与内容行数为 0；
- **无点赞数据的可见性**：每位专员的 `reason_detail` 记 `like_not_value`（进入排序的内容中点赞值状态不是 `value` 的条数），运行汇总可见，避免全部缺失时静默退化成按发布时间排序；
- 该规则对圈定、试跑、执行**同一实现**；试跑的 C1 与执行一样是截断后的集合；点赞随同步变化，圈定与执行各自重新冻结，圈定条数是圈定当时的快照。

**验收标准**

- 某专员 10 条满足全部第 1 层条件，N=6：取点赞最高的 6 条进入第 2 层，`C1=6`；未选中的 4 条 `layer1_selected=false`，不产生 C2；
- 10 条中点赞为 `null` / `missing` / `explicit_null` / `invalid` / `unsupported` 的排在有效值之后；真实 `0` 是有效值，排在它们前面；有效值相同按 `published_at` 降序、`content_id` 升序；
- N 大于候选数（如 N=1000、候选 4 条）：全部进入，内容门槛仍按 N 判；
- 3 条第 1 层通过的内容 + 1 条第 1 层读不到文本信号、N=3：选中 3 条；若这 3 条全部通过，P=3、U=1，成功；若其中 1 条在第 2 层不通过，P=2、U=1，P+U=3 不小于 3，未获取成功，不是不达标；
- 参与内容 10 条、没有一条命中话题、N=3、同步有缺口：T>0，P=0、U=0，判不达标（不走零内容分支）；
- 文本 / 话题能力全部删除后 N 被清掉，下一次保存的配置里没有 `quantity`；
- 只有 4 条满足、N=6：4 条全部进入第 2 层，内容结果按 `at_least_n 6` 判不达标（若没有未获取成功）；
- 文本与话题两个能力同时配置：内容必须同时命中；数量 N 只有一个，按通过两者的候选排序后取前 N；
- 修改 N：`config_sha256` 变化，圈定 / 试跑失效并按矩阵回退；只改别名：哈希不变，圈定 / 试跑不失效；
- 配置 `kind='image_text'` 或引用 OCR：校验拒绝（2.0 capability），不产生运行。

### JP-3 · 版本、草稿与发布

**陈述**：

- 版本只有两种状态：`draft`、`published`。每个判定计划任一时刻至多一个草稿；
- **草稿**可改配置、可上传 / 删除标准图与元素图（经 C 的 `putImage / removeImage`，D 转发并校验）、可圈定、可试跑；
- **发布发生在第 3 页「确认执行」**（§1.4 第 1 项）：
  - `confirm`：存在草稿 → 草稿发布为该版本号并冻结（C `segments.publish`，其内部再校验 `executability`），然后新建执行；
  - `execute`：没有草稿 → 对**最近已发布版本**新建一次执行，**不升版**；
  - 尚无已发布版本且无草稿不可能出现（创建时自带草稿 v1）；
- 发布协议两阶段：D 先把草稿置 `publishing` → 调 C `publish` → D 置 `published` 并建执行；崩溃后 `reconcile` 以 C 的状态为准补完；
- **新建草稿**（`newDraft(planId, fromVersion?)`）：`fromVersion` 缺省为最近已发布版本，也可指定任意已发布版本（PRD §2.3「回退到某一版时引用该版的标准图」）；来源版本 vN → 草稿 v(最新+1)（C `newDraft` 复制信号集合与图片字节，D 复制配置）；草稿的向导进度归零（圈定 / 试跑结果不带过去，它们属于旧配置）；版本号必须与 C 返回的一致，不一致报冲突并停止；
- 已发布版本的配置、信号集合、图片不可变；执行、重算、试跑、圈定都不升版（D-D08）；
- 发布被 C 拒绝（不可执行：第 3 层能力未启用、图片能力未启用、引用的图片行不存在）时，D 的草稿保持原状，错误里带阻塞项清单。

**验收标准**

- 草稿 v1 `confirm` 后再 `execute` 两次：只有一个已发布版本、三次执行（`execute` 不升版）；
- `new-draft` → 改一个阈值 → `confirm`：版本号 +1，旧版本及其执行保持可读；
- 草稿存在时再次 `newDraft` 被拒；归档的计划 `newDraft` 被拒；
- 在「C 已发布、D 未置 published」处杀进程，`reconcile` 后 D 为 `published` 且恰有一次执行（幂等键保证不重复建执行）；
- 已发布版本上任何写配置 / 写图片的路径被拒（`version_immutable`）；
- 计划含 ASR 判定项而 C 报网关未启用：发布被拒，错误列出 `capability_disabled`，草稿与 C 侧均未变；
- D 与 C 的版本号始终相同（对每个计划断言）。

### JP-4 · 向导进度与回退

**陈述**：草稿 SHALL 有向导进度 `draft → circled → compared`，**阻塞式**：

- `draft → circled`：圈定成功（JP-5）；`circled → compared`：至少完成一次试跑（JP-6）；第 2、3 页**可以空配置直接确认**（PRD：空层 = 没有这一层），此时对应步骤视为自动通过；
- 确认执行要求进度已到 `compared`（或第 2 页配置为空）；
- 修改**会使后续结果失效**的配置（第 1 页条件、窗口、形态、数量 N → 圈定与试跑结果失效；第 2 层能力的**结构**（增删能力、改 kind / target / elementKey）或标准图 / 元素图 → 试跑结果失效；**仅改阈值、评论达标方式、第 3 层、评论要求、能力别名不使任何结果失效**，试跑报告用当前阈值重算）时，进度回到对应步骤并删除失效的结果；
- **回退**每次只退一层（`compared → circled`，`circled → draft`），不能跳层；回退前 SHALL 先预览：将删除哪些运行与多少行；`--apply` 才执行；回退删除的是**草稿**的圈定 / 试跑运行（§1.4 第 2 项），不保留历史；
- 回退后第 3 页 → 第 2 页：A 已获取的详情、视频与评论**不重复抓取**（A 的复用保证，D 不做特殊处理）。

**验收标准**

- 未圈定时试跑 / 确认执行被拒；跳层回退被拒；
- 回退预览不改任何表；`--apply` 后被回退步骤的运行与行全部消失，进度正确；
- 改关键词后圈定结果被删、进度回到 `draft`；只改第 3 页的 ASR 标准不动圈定与试跑结果；
- 已发布版本的执行结果在回退（对草稿）后仍可读；
- 第 2 页与第 3 页都没有配置时，可在圈定后直接确认执行。

### JP-5 · 圈定（第 1 页）

**陈述**：圈定 SHALL 是同步运算，只使用第 1 层与计划级条件：

- 输入：活动计划的名单（`rosterSnapshot`）、当前归属、窗口、形态、关键词 / 话题 / 时长、整层数量要求 N；
- **不触发任何外部调用**：不调 A 的 `demand`、不调 C 的 `requestScores`、不读图、不调模型（PRD §2.2）；只读 A 的快照与 C 的文本信号（`readMany`）；
- 输出：圈定条数（C1 = 截断后 `layer1_selected=true` 的条数）、参与专员数、参与内容数、未获取成功条数与按原因分布；运行 ID；所有第 1 层通过的行都保留，未选中的标 `layer1_selected=false` 与 `layer1_rank`；
- 圈定写一个 `circle` 运行（与执行共用引擎，只到第 1 层），保留行级结果供 E6 导出（D 提供 `streamCircleRows`，不自己出文件，D-D09）；
- 同一草稿重新圈定会**替换**上一个圈定运行；圈定运行有保留期（JP-19），草稿被回退 / 清除时随之删除；
- 圈定使用的名单、归属、内容快照在运行开始时冻结，与执行同一套逻辑（JP-7）。

**验收标准**

- 圈定期间能力服务、网关、`demand.submit`、`requestScores` 的调用数均为 0（计数器）；
- 播放量、评论正文、第 2 层以上的条件无法出现在第 1 层配置里；
- 话题 / 关键词的 `all` 与 `any`、字段选择、时长边界（含边界、单位未知）各有用例；
- 一条带话题但封面不合规、另一条封面合规但没带话题的内容，在同时配了两层条件时都不进 C2；
- 重新圈定后旧运行的行全部消失；
- 圈定结果的条数 = `streamCircleRows` 里 `l1 = pass` 且 `layer1_selected = true` 的行数；未选中的 `l1 = pass` 行仍在导出里，但带选中标记。

### JP-6 · 比对试跑（第 2 页）

**陈述**：试跑 SHALL 对**圈定留下的 C1** 做第 2 层比对：

- 草稿的 C 监控段在业务上传标准图 / 元素图后即可 `requestScores`（C 允许草稿，不等发布）；D 对 C1 的内容主体调用 `requestScores`（≤ 5,000 / 次，**`only` 限定为第 2 层能力用到的信号**，不得连带第 3 层信号），再轮询 `readMany` 直到没有「在等」的依赖或超过等待上限（§1.4 第 9 项）；
- `target="avatar"` / `"background"` 的能力（整图 / 元素）属于账号要求，同样试跑：对名单账号调 `requestScores`；
- 试跑运行自己重做一遍冻结、范围构建与第 1 层（只读、无外部调用），不拷贝圈定运行；两者之间若有新同步，C1 条数可能略有差异，报告以试跑自己的 C1 为准；
- 试跑返回**连续 0.00–10.00 的分布**（按第 2 层能力分别统计）与 **11 档样例**（每个整数档 `[k, k+1)`，10 档含 10.00，每档固定最多 5 个样例内容 ID；不足 5 个时返回实际数量；样例槽位位置固定，不按数量平均分布）；不返回「匹配 / 不匹配」；
- 阈值可在试跑后调整并再次试跑（不升版）；调整阈值**不需要**重新计算分数（C 的结果按复用键共享，换阈值只是换比较）；内容数量 N 改动会使圈定 / 试跑失效；
- `needMedia`（封面 / 头像 / 背景未归档）原样汇总为「未获取成功」条数与原因，D 不提采集需求（图片不属于 `demand` 的 `wants`）；
- 试跑运行与圈定运行同样保留 / 替换 / 随回退删除；**试跑不触发第 3 层**，不发任何付费调用；
- 试跑创建运行**之前**先调 `executability(ref, only = 第 2 层能力用到的信号)`，不可执行则拒绝并返回阻塞项；创建之后才丢能力则运行 `failed(not_executable)`；`image_text` / OCR 在 1.0 不可执行，试跑必须被拒；
- 试跑是 `rule.definition.manage` 能力（B PRD §7.3），不是 `rule.run.execute`。

**验收标准**

- 对 C1 的 N 个内容主体恰好调用一次 `requestScores`（分批时每批一次）；换阈值再试跑不新增 C 任务；换标准图再试跑对同批主体新建任务（C 侧行为，D 断言只是再次调用）；
- 分布统计对 `10.00` 与 `0.00` 正确入档；样例每档最多 5 个，不足时只返回实际数量；
- 素材 `pending / failed / carried_forward` 的主体被计入未获取成功并带 C 的原因码，不触发采集需求；
- 试跑期间网关调用数为 0、`demand.submit` 调用数为 0；
- 能力未启用（`image.*` 在标定前）时试跑被拒并列出阻塞项，而不是返回全 0。

### JP-7 · 执行输入冻结

**陈述**：执行开始时 SHALL 冻结（写入 `judgement_runs` 与 `run_participants` / `run_contents`）：

- 配置版本与 `config_sha256`、C 监控段引用 `(planId, version)`；
- 窗口：北京时间自然日按 Asia/Shanghai 换算为 **UTC 半开区间** `[from_utc, to_utc)`，`to_utc = min(to 次日零点, frozen_at)`；
- 活动计划的平台与起止日期（只作记录）；
- **名单快照**：`rosterSnapshot` 的 `in_roster` 项；每个名单账号取执行时的当前归属（`staff_account_assignments`），再取该专员当前的门店 → 经销商 / 品牌 / 板块 / 分公司 / 大区，**一次冻结，写入参与专员行**（E 的 AttributionSnapshot，§1.2）；
- 每个参与专员的参与内容及其 `content_snapshot_id`（JP-8 之前的范围构建）；
- 提交人（`submitted_by_actor`）与授权摘要。

其余规则：

- 执行期间其他活动计划的名单变化、改绑、门店换分公司**不影响本次执行**；已保存的历史结果不因改绑改写；移出名单的账号不参与本次执行，其历史内容保留但不进入结果，也不触发重采（PRD D §2.0.1）；
- 两个名单账号解析到同一专员，或名单账号没有 `watch_type = 'staff'` 的归属，是不变量被破坏：**冻结失败**，运行置 `failed`，原因 `participant_conflict` / `no_staff_assignment`，不静默丢弃；
- 账号已释放名额（`slot_released_at` 非空，确认已删除）的名单账号仍是参与专员，账号要求读作未获取成功（`account_unavailable`）；
- 冻结是**确定性**的：同一时刻同一数据两次冻结得到相同的参与专员集合。

**验收标准**

- 冻结后改绑账号、移出名单、门店换分公司，本次执行结果不变；新执行按新状态算；
- 改绑后参与专员的 `staff_id` 与组织链取自新专员（而不是名单项里的旧快照）；
- 窗口 `to = 2026-11-10` 的闭区间换算为 `[…10 日 00:00+08, 11 日 00:00+08)` 的 UTC 值；`to` 缺省时上界为冻结时刻；
- 构造两个名单账号指向同一专员：冻结失败，运行 `failed`，不产生半截参与专员；
- 冻结后移动 `contents.current_snapshot_id`，执行读到的仍是冻结的快照。

### JP-8 · 内容逐层过滤

**陈述**：对每个专员的参与内容，引擎 SHALL 逐层评估，层间 AND、层内同一条内容 AND：

```text
L0  范围：时间 / 形态无法归类 → 未获取成功（published_at_missing / content_kind_unknown）
L1  第 1 层条件（同一条内容全部满足）→ 通过 / 不通过 / 未获取成功
L2  第 2 层条件（只对 L1 通过者）
L3  第 3 层条件（只对 L2 通过者；1.0 仅 ASR 判定）
```

- 条件内部：多条件用 `AND3`（任一不通过 → 不通过；否则任一未获取 → 未获取；否则通过）；
- **只有「通过」的内容进入下一层**；「不通过」「未获取成功」停在本层，后续层记 `skipped`；**未获取成功的内容不触发下一层的采集与付费调用**；
- 空层（没配条件）= `not_configured`，内容原样传下去；
- 每条内容的最终结果：全部层通过 → `pass`；在某层不通过 → `fail`；在某层未获取 → `unobtained`；
- 每层结果、每个条件的证据（命中的词 / 话题、分数、判定结论）写进内容行（JP-14）；
- 信号读取一律 `use_stale`，结果带 `stale` 标记（D-D13）；
- 单位 / 值状态纪律：时长必须 `state = value` 且单位已知才可比较，否则未获取成功（`duration_unit_unknown` 等）；真实 `0` 是有效值；比较阈值用整数百分位。

**验收标准**

- 表驱动：每层的「通过 / 不通过 / 未获取成功」× 下一层是否被调用（`requestScores` 与 `demand.submit` 的主体清单只含上一层通过者）；
- 第 2 层未获取成功的内容不进入第 3 层、不出现在 ASR 的 `requestScores` 主体里；
- `AND3` 全表（3×3）；同一层两个条件，一个不通过一个未获取 → 不通过；
- 时长恰好等于边界通过；时长单位未知 → 未获取成功；真实 0 播放（不适用）与缺失不混淆；
- `stale` 信号使用后结果带 `stale = true`，三态不变。

### JP-9 · 专员级达标方式、零内容与计划总结果

**陈述**：对每位参与专员、每类已配置的要求，系统 SHALL 按 PRD D §2.0.2 的表计算，P / U / F / T 均为整数。**内容要求的达标方式在 1.0 固定为 `at_least_n N`**，N 取 `layer1.quantity.n`，缺省为 1；`all` / `any` / `ratio` 只保留给评论要求，不再由第 2/3 页单独配置。

| 方式 | 成功 | 不达标 | 未获取成功 |
|---|---|---|---|
| `at_least_n` | P ≥ n | P + U < n | 其余 |
| `all` | F = 0 ∧ U = 0 ∧ P = T ∧ T > 0 | F ≥ 1 | F = 0 ∧ U ≥ 1 |
| `any` | P ≥ 1 | P = 0 ∧ U = 0 | P = 0 ∧ U ≥ 1 |
| `ratio(bp)` | P × 10000 ≥ bp × T | (P + U) × 10000 < bp × T | 其余 |

- **内容要求的 P / U / F / T**：对该专员每条参与内容取 `final`——`pass` 计 P，`fail` 计 F，`unobtained`（`l0` / `l1` / `l2` / `l3` 任一层）计 U；`final='skipped'`（第 1 层未被选中）不计入 P / U / F，另记 `content_skipped`；`T = P + U + F`；
- **零内容**指**参与内容行数为 0**（不是 T = 0，也不是「没有内容通过第 1 层」）；它覆盖上表：窗口内同步完整 → 不达标；否则 → 未获取成功，原因 `sync_failed` / `sync_gap` / `no_sync_in_window`（D-D14）；
- **同步完整谓词**（design §7.5）对每位参与专员计算并存（`sync_complete`、原因），`T > 0` 时只作提示、不改三值（§1.4 第 12 项）；
- **账号能力**不用达标方式：`target="avatar"|"background"` 的 `layer2.abilities` 按阈值 `AND3`；
- **计划总结果** = 已配置的内容 / 评论 / 账号三项结果的 `AND3`，**不达标优先**（D-D04）；没配的对象不参与；
- 每个参与专员保存：三项结果、各自 P / U / F / T、C1 / C2 / C3 条数、计划总结果、主要未获取原因（优先级：内容 > 评论 > 账号；同一对象内取条数最多的原因，并列取字典序）、`sync_complete`、`stale_used`；`l0 / l1` 的未获取成功不参与点赞排名，但计入 U（不会被静默排除）；
- **只有计划总完成率**：成功专员数 ÷ 参与专员数（不设分项率，D-D03 修订）；D 保存数，比率由 E 算；
- 全部整数运算，不用浮点。

**验收标准**

- 内容（端到端）：N=5、候选 10 条，取前 5 条，5 条全部通过 → 成功；其中 1 条第 2 层不通过 → P=4、U=0，不达标；N=6、候选只有 4 条且全通过 → P=4 → 不达标；N=3、2 条通过 + 1 条第 1 层未获取 → 未获取成功；N=3、参与内容 10 条都没命中话题 → 不达标（T > 0）；参与内容 0 条 + 同步完整 → 不达标；
- 内容（纯函数 `evaluateMethod`，不经过截断）：P=6、N=5 → 成功；P=4、N=6 → 不达标；P=5、U=1、N=6 → 未获取成功；
- 评论：`all` / `any` / `ratio` 各保留表驱动用例；账号只判唯一账号；零内容两种；总结果 `AND3` 与不达标优先；`stale` 标记；
- 评论四种方式 × (P, U, F, T) 的穷举小表（T ≤ 5）与手写参照实现逐格相等（属性测试，固定种子）；内容 `at_least_n` 边界单独表驱动；
- `ratio` 边界：`P × 10000 = bp × T` 判成功；
- 零内容 + 同步有缺口 → 未获取成功，原因 `sync_gap`；零内容 + 同步失败 → `sync_failed`；
- 同一专员内容 / 评论 / 账号三项分别为 成功 / 不达标 / 未获取成功 → 总结果不达标；成功 / 未获取成功 / 成功 → 未获取成功。

### JP-10 · 评论要求

**陈述**：

- 评论的候选内容 = 该专员的 **C2**（通过第 1、2 层）（D-D12）；评论不反过来过滤内容；
- 对 C2 内容向 A 提出 `comments` 需求（`demand.submit`，≤ 5,000 项 / 次，键 `exec:{runId}:cm:{n}`），轮询 `demand.get` 直到全部终态或超时；`unsupported_platform`（快手）在配置阶段已被挡住，运行时出现则记 `unsupported_platform`；`content_not_found`、`capability_disabled`、`out_of_scope` 各记对应原因；
- 评论取自 A 的一级评论最新态（`status = 'active'`）；条件是**单条评论**上的关键词命中，经 C 的 `comment.text_normalized`（`readMany`，评论主体）与 `normalizeKeyword(raw, normalizerVersion)` 判定；评论信号 `missing(not_computed)` 视为「在等」（评论刚入库、C 扫描尚未到），有上限等待；
- T / P / U 按 §1.4 第 11 项累加，覆盖不全的内容加缺口 U；达标方式同 JP-9；某内容的评论需求根本没拿到（采集失败 / 不支持 / 超时）时，按公式得「不达标」的改判为未获取成功（未知评论数没有上界；成功仍可成立）；
- 评论条数很大时，每条内容保存 `comment_total / pass / unobtained` 与至多 3 个命中评论 ID（证据）；**不**逐条评论落库；
- 不保存评论原文与作者信息（只存 ID 与计数）。

**验收标准**

- 评论 `demand` 的主体只含 C2 内容；C2 以外的内容没有评论需求；
- 评论覆盖 `complete` 时 T = 评论条数；`partial` 且总数已知时缺口 = 总数 − 已取条数；总数未知时缺口 = 1；
- 「至少 3 条评论含关键词」：命中 2 条 + 缺口 1 → 未获取成功；命中 2 条 + 覆盖完整 → 不达标；
- 快手计划保存评论要求被拒（JP-2）；运行时 `unsupported_platform` 记原因；
- 评论候选（C2）为空时（design §7.7）：有候选内容在第 1、2 层未获取成功 → 未获取成功；该专员根本没有参与内容 → 按 JP-9 零内容规则；其余（候选全部确定性地没通过）→ 不达标；
- 证据里只有评论 ID 与计数，不含评论原文、作者。

### JP-11 · 账号要求

**陈述**：

- 每个参与专员只判**一个账号**（计划平台上的唯一账号，D-69）；使用执行时该账号的**最新 finalized 主页快照**（`external_accounts.current_profile_snapshot_id`）所对应的头像 / 背景素材；
- 条件经 C 的 `account.avatar_* / account.bg_*`（`requestScores` 对账号主体 + `readMany`）；多个条件 `AND3`；
- 账号没有当前主页快照 → 未获取成功 `no_profile_snapshot`；素材未归档 / 失败 / `carried_forward` → 未获取成功（C 的原因码）；
- 账号要求**不依赖内容层**，与内容逐层过滤并行；
- 小红书、快手不可配（JP-2）。

**验收标准**

- 账号要求与内容要求互不影响（内容全部未获取时账号要求仍给出自己的结果）；
- 无主页快照 / 素材缺失 / 分数低于阈值各自的结果与原因码；
- 阈值边界（分数等于阈值判通过）；
- 账号名额已释放（`slot_released_at` 非空）时记 `account_unavailable`，不调 C。

### JP-12 · 第 3 层：ASR 判定

**陈述**：

- 1.0 第 3 层只有「音频 ASR + 大模型判定」，标准是表单里的一段自然语言（D-D11），不做多轮对话，D **不调模型**；
- **执行前门控**：`executability(segmentRef)` 不可执行（`capability_disabled` 等）→ 发布与开始执行**被拒**并列出阻塞项（§1.4 第 10 项）；
- 对 C2 内容向 A 提出 `audio` 需求（`demand.submit`，键 `exec:{runId}:l3:{n}`），轮询到终态；`ready` 的内容才调 `requestScores(asr_judgement)`；需求失败 / 不支持 / 内容没有 finalized 快照 → 该内容 L3 未获取成功（`demand_failed` / `unsupported_platform` / `content_not_found`）；
- 进入第 3 层前重调 `executability`；C 对不可执行的段整批拒绝 `not_executable`（执行中途网关被关）→ 该层剩余内容记 `capability_disabled`，**不发调用**；`requestScores` 的 `only` 限定为 `content.asr_judgement`，使第 2 层请求不会连带建第 3 层任务；
- 判定结论 `meets` → 通过，`not_meets` → 不通过；C 的 `failed(model_refused / invalid_output)` → 未获取成功（**不是**不通过）；
- 证据保存结论、理由、模型版本、提示词版本（PRD §2.5 缺一不可）与 `resultId`；
- 每计划至多一个 ASR 判定项（JP-2）。

**验收标准**

- 默认装配（C 网关 disabled）：含第 3 层的计划发布被拒，`demand.submit` 与 `requestScores` 调用数为 0；
- 不含第 3 层的计划在同一环境照常发布与执行；
- fake C：中途把 `requestScores` 切为 `capability_disabled`，剩余内容 L3 记 `capability_disabled`；
- `not_meets` → 内容不通过；`failed(invalid_output)` → 未获取成功；
- 证据里有四样东西（结论、理由、模型版本、提示词版本）；缺一样的判定不被当作通过；
- `demand` 的音频需求主体只含 C2。

### JP-13 · 依赖协调：补算、采集、轮询与超时

**陈述**：

- D 与 C、A 的所有调用 SHALL 在 D 的数据库事务**之外**进行（`data-discipline` 纪律 2）：它们内部各有事务与队列；
- 执行是一个**可续跑的阶段机**（design §7.2）：每个阶段把进度写进运行行，worker 反复 tick；等待依赖时运行状态为 `waiting`，不占线程；
- 等待有两个**独立上限**（配置，无代码默认值）：信号 / 补算类（C）与采集需求类（A）；超过上限的内容记 `dependency_timeout`，运行继续（不挂死）；
- 轮询间隔与批大小是配置；同一阶段内同一依赖不重复提交（幂等键 `exec:{runId}:…`）；
- 执行中任何依赖的**瞬时错误**（C / A 的内部异常）按退避重试阶段，不改写已定的内容结果；
- 取消：`cancel` 后不再提交新依赖，已提交的依赖由 A / C 自己跑完（共享，不浪费）。

**验收标准**

- fake C / fake A 模拟「N 次轮询后就绪」「永远 pending」「中途报错」：分别得到正常完成、超时后 `dependency_timeout`、阶段重试后完成；
- 杀进程后续跑：已定的内容不重算，已提交的需求不重复提交（`demand` 批次 ID 与幂等键断言）；
- 静态检查：`judgement` 目录中没有任何在 `db.transaction(...)` 回调里调用 `SignalsPort` / `DemandPort` 的路径（护栏）；
- 等待上限为 0 的配置下，所有「在等」的依赖立即记 `dependency_timeout`。

### JP-14 · 证据与可解释

**陈述**：

- 每条参与内容的行 SHALL 保存 **自包含的证据**：各层结果、每个条件的输入与结论（命中的关键词 / 话题——**不含正文原文**；分数两位小数；判定结论 / 理由 / 模型版本 / 提示词版本）、`stale` 标记、C 的 `resultId`、能力版本；
- 证据在 C 清理结果行之后仍可解释（不依赖 C 的行存活）；
- D 在每个求值块写完证据后**立即**调用 C `retainUntil(resultIds, 引用时刻 + 3 个月)`，引用时刻 = D **读取**该值的时刻（C 采纳项），不攒到 `finalize`，所以取消 / 失败的执行也已覆盖；调用失败使该块重试，不丢失；
- `explain(executionId, contentId | staffId)` 返回逐层、逐条件的解释；字段可见性随调用方对 `data.content.read` 的范围（本人只看自己），内容原文**不出现**；
- 日志与审计不写签名 URL、评论原文、模型 Key。

**验收标准**

- 解释结果包含「用了哪些条件、各自输入、结论、跳过了哪层、为什么停」；
- 删除 C 的结果行（fake）后，D 的解释依然完整；
- `retainUntil` 的调用主体恰为本次读取到的 `resultId`（去重），时间为读取时刻 + 3 个月；
- 越范围的专员 / 内容表现为「未找到」，不泄露存在性；
- 证据 JSON 中不出现 `title / body / content_text` 原文字段（schema 断言）。

### JP-15 · 执行生命周期：租约、fencing、幂等、取消、续跑

**陈述**：

- 执行是 D 自己表里的一行运行，由 worker 通过**租约与递增 fencing 令牌**领取；陈旧 worker 的写入 SHALL 被拒绝并零写入（宪法 C14）；
- 同一（判定计划，版本）同时至多一个未终态运行（唯一键，§1.4 第 14 项）；开始执行带幂等键，重复提交返回已有运行；
- 状态：`planned → running ↔ waiting → completed`；终态还有 `failed`、`cancelled`；
- `cancel`：把未终态运行置 `cancelled`、清活动键；在途阶段在下一个块边界停止；**取消的运行不对 E 可见**；
- `resume`：`failed` 的运行可在原行上续跑（从持久化的阶段与游标），已定的内容不重算；
- 在途定义（供 A 的删除检查）：状态 ∈ {`planned`, `running`, `waiting`} 的执行 / 试跑 / 圈定运行（JP-17）；
- 执行时复核提交人：每个 tick 检查提交人仍有效且仍持有 `rule.run.execute`；被停用 / 撤权则取消该运行（B-D28）；
- 所有状态变更与终态写入在短事务内，带 fencing 校验。

**验收标准**

- 两个 worker 抢同一运行只有一个拿到；租约过期后另一个接手，旧 worker 的写入被拒绝且零写入；
- 同版本两次并发「确认执行」只产生一个运行（唯一键 + 幂等键）；
- 阶段中途杀进程，重启后续跑，`run_contents` 每行最多写一次，参与专员行不重复；
- 取消后不再提交新依赖；取消的运行不出现在 `listCompleted`；
- 提交人被停用（fake B）后下一 tick 运行被取消，审计留痕；
- 终态运行不能再被领取。

### JP-16 · 对 E 的输出契约

**陈述**：D SHALL 提供只读的 `JudgementOutcomeReader`，E 不 JOIN D 的表：

```ts
listCompleted(after: { completedAt: Date; executionId: bigint } | null, limit: number): Promise<ExecutionDescriptor[]>   // 轮询完成通知；游标是 (完成时间, ID)，不是 run_id：并行的执行完成顺序与创建顺序无关
describe(executionId: bigint): Promise<ExecutionDescriptor>
streamParticipants(executionId, constraint: ResourceConstraint): AsyncIterable<ParticipantFact>
streamContents(executionId, constraint): AsyncIterable<ContentFact>          // 每条参与内容一行，含各层结果与证据摘要
streamCircleRows(runId, constraint): AsyncIterable<CircleRow>                // 第 1 页下载，经 E6
```

- `ExecutionDescriptor`：`executionId`、`planId`、`version`、`planAlias`、`activityPlanId`、`platform`、`window`（UTC 区间 + 北京日期）、`frozenAt`、`completedAt`、`cutoffAt`（数据截止：冻结时刻）、`participantCount`、各 C1 / C2 / C3 总数、`staleUsed`、配置摘要（数量 N、内容要求是否启用、每个能力的 `abilityId` / `kind` / `target` / 阈值 / **能力别名**（执行所用版本的别名，冻结）、评论达标方式）；
- `ParticipantFact`：专员与组织链（冻结的稳定 ID：region / branch / sector / store / dealer / brand / staff / account）、三项结果、计划总结果与主要原因、P / U / F / T 与 C1 / C2 / C3 条数、`sync_complete`、`stale_used`；
- `ContentFact`：专员、账号、内容 ID、各层结果、最终结果（`pass` / `fail` / `unobtained` / `skipped`）、`layer1_selected`、`layer1_rank`、点赞值与值状态、`stale`、证据摘要入口；`skipped` 的原因是 `layer1_not_selected`；E 的 C1 = 被第 1 层选中的条数；
- 所有 stream 接收 E 传入的范围约束（B 的 `ResourceConstraint`），D 按**冻结的组织链**过滤，专员级范围（`self`）按 `staff_id` 过滤；
- **只对 `completed` 的执行可见**；`cancelled / failed` 不可见；同一计划最新的 `completed` 执行即 E 的当前结果，D 不做「激活」（E 自己自动激活，E-D11）；
- D 不出文件（D-D09、E-D04）：「下载结果」由页面调 E6 的导出提交，数据经本接口流式读取；导出的 Capability 是 `report.export`（E 的合同）。

**验收标准**

- 未完成 / 取消 / 失败的执行不出现在 `listCompleted`、`describe` 返回错误；
- `streamParticipants` 的条数 = 冻结的参与专员数；每个 `achieved`（成功）的专员都在其中（分子 ⊆ 分母）；成功 + 不达标 + 未获取成功 = 参与专员数；
- 组织链取自冻结值：执行后改绑 / 换店，流出的组织链不变；
- 范围约束：`branches` 限定、`self` 限定、`empty` 约束下各自只流出范围内的专员 / 内容；
- `streamCircleRows` 只对圈定运行有效，行 = 圈定条数（`l1 = pass ∧ layer1_selected`）+ 未选中的（`skipped`）+ 未通过 / 未获取的行（均带结果与原因）；
- `skipped` 行在 `streamContents` 里照常流出，且不计入 P / U / F；
- 契约测试用 fake E 消费者走一遍完整序列（轮询 → describe → streams）。

### JP-17 · 下游端口：与活动计划的生命周期联动

**陈述**：D SHALL 实现 A 的 `PlanDownstream`，并在装配处注入（`plan-main.ts` 与页面进程）：

- `summarize(activityPlanId)`：`judgementPlans` = 该活动计划下的判定计划数；`results` = 其下已完成**执行**的参与专员行总数（圈定 / 试跑的试验数据不算业务结果）；`running` = 未终态的运行数（执行、试跑、圈定）；
- `onDeleted / onRestored`：幂等通知，D 不改自己的状态（以 `activity_plans.status` 为准，读路径统一过滤回收站）；
- `purge(activityPlanId)`：**在数据库事务之外**、幂等、可重试：对每个判定计划先调 C `segments.purge(planId)`，再分块显式删除 D 的行（`run_contents → run_participants → judgement_runs → judgement_plan_versions → judgement_plans`），不使用级联；失败时抛出，A 不清除活动计划；
- 删除一个活动计划**不触发**采集数据与 C 的全局信号清理（platform §6.11 第 5 条）；C 的结果行按自己的保留期；
- 活动计划有在途运行（`running > 0`）时 A 拒绝删除；D 的 `summarize` 必须在运行落到终态后立刻反映；
- D 的行对 `activity_plans` 有 RESTRICT 外键：D 的 `purge` 未完成时，A 的物理删除会失败而不是留下孤儿。

**验收标准**

- `summarize` 对「有执行中的运行」返回 `running ≥ 1`；终态后回到 0；
- `purge` 删除全部 D 行与 C 监控段；第二次调用无副作用；中途失败（C 或数据库）后重试完成；
- `onDeleted / onRestored` 重复调用无副作用，且恢复后判定计划立即可读；
- 活动计划进入回收站后，读取接口、E 的 `listCompleted` 不再返回其结果；恢复后返回；
- 契约测试：用记录调用顺序的 fake 验证 A 的调用时机（`summarize` → 删除 → `onDeleted`；期满 → `purge` → 删除）。

### JP-18 · 授权与审计

**陈述**：

- D 的函数 SHALL 经 B 的 `authorize(ctx, { capability, resource })` 入口授权，先于任何读库；资源键 `judgement_plan`，引用 `{ brandId, branchIds, planCreatorActor }`；
- Capability 对应：创建 / 改配置 / 传图 / 圈定 / 试跑 / 回退 / 新建草稿 / 归档 = `rule.definition.manage`；确认执行（含发布）/ 重新执行 / 取消 / 续跑 = `rule.run.execute`；读取 / 解释 = `rule.definition.read`（证据下钻另需 `data.content.read` 且受 DataScope 约束）；
- **写类操作**额外要求谓词 `plan_creator`：操作者是所属活动计划的创建者或超管（§1.4 第 13 项）；读取不要求；
- `judgement_plan` 的 ScopeStrategy：品牌 ∈ 范围品牌，且（范围分公司为 `all`，或活动计划的某个已加入分公司 ∈ 范围分公司）；范围解析失败 → 403 + 质量问题（B-D26）；
- D 的异步运行**继承提交人身份**：运行行记 `submitted_by_actor`（必须是 `user:<id>`）；每个 tick 用 `contextForUser` 现建 `AuthContext`，失败（用户停用、范围无法解析）或不再持有该类运行所需的 Capability（执行 = `rule.run.execute`，试跑 = `rule.definition.manage`）就取消运行；D 调 C 用由该 ctx 译成的 `SignalActor`（品牌范围按 ctx 译成品牌编码）；调 A 的 `demand` 用 `actorId` = 提交人、`capabilities` = 提交人当前的 Capability、范围为全平台的 `ActorContext`——A 的 `ActorContext` 没有品牌维度，主体清单由 D 限定在已授权的名单内（design §9）；`demand` 的幂等作用域含 `actorId`，同一运行的提交人不变，因此稳定；
- 审计经 B 的 `AuditWriter`：创建 / 发布 / 开始执行 / 取消 / 回退（删除结果）/ 归档 / 期满清除 为 `high`（与业务写入同事务）；试跑、圈定为 `low`；`reasonCode` 为稳定枚举；不含配置原文以外的内容（配置里的关键词可记），不含评论原文；
- 提交人复核见 JP-15。

**验收标准**

- 缺 Capability 的调用在任何读库之前被拒绝（查询计数器）；
- 非活动计划创建者的 `hq_manager` 能读但不能写、不能执行；`branch_manager` 只能读其所在分公司参与的活动计划的判定计划；`store_staff` 一律被拒；
- 越范围的判定计划表现为「未找到」；
- 运行期间提交人被停用 / 撤权 / 范围无法解析：下一个 tick 取消运行，审计 `submitter_revoked`；B 的 `SERVICE_PRINCIPALS` 无任何改动（枚举测试原样通过）；
- 高风险审计在事务回滚时一并回滚（写入失败使整笔业务写入失败）；
- 审计 `detail` 里没有签名 URL、评论原文、模型 Key。

### JP-19 · 配置、门控与默认离线

**陈述**：

- 下列数值**没有代码默认值**，必须在环境变量里显式给出，缺任一项启动失败并指出缺哪一项：圈定 / 范围构建的块大小、`readMany` 批大小（≤ 5,000）、`demand` 批大小（≤ 5,000）、轮询间隔、信号类等待上限、采集类等待上限、租约时长、每 tick 阶段预算、关键词 / 话题数量与长度上限、圈定与试跑运行的保留天数、已完成执行保留内容级行的个数；起始值写在 design §14 的建议里，不当作合同；
- 默认测试离线：fake `SignalsPort`、fake `DemandPort`、fake 授权与审计、`FakeClock`；`network-deny` 沿用；CI 不发起任何真实调用；
- D 自己不读 AI Master / 模型 / OSS 的 secret；
- 真实 smoke（C 的真实服务、A 的真实采集）不在本 spec 内。

**验收标准**

- 缺任一必填数值，`judgement run` 与 CLI 启动失败；
- 测试进程启动时网络 socket 被禁止；
- 默认配置下不存在任何路径会让 `requestScores` / `demand.submit` 在 `executability` 不可执行时被调用；
- `./scripts/verify.sh` 通过；与 C 的真实契约未验证时明确写「未验证」，不声称通过。

### JP-20 · CLI

**陈述**：`pnpm judgement <命令>`，只调用 Module，输出一行 JSON（BIGINT 十进制字符串），退出码沿用 `plan-cli`（0 成功 / 2 输入或授权 / 3 冲突 / 4 不存在 / 5 超限 / 1 配置与其他）；`parseArgs` strict；影响多个对象的命令（回退、清除、取消）默认只预览，`--apply` 才写；没有 `--force`、`--skip-auth`；身份只来自环境变量 `HBECHO_JP_ACTOR=user:<id>`（用该用户当前的 `AuthContext` 走与页面相同的授权；没有自带 Capability / 范围的环境变量，服务身份不能用），缺失或不合法启动失败。命令清单见 design §9。

**验收标准**

- 每条命令至少一条 CLI 级测试（成功、输入错误、授权错误）；
- 缺身份环境变量启动失败且退出码非零；
- 回退 / 取消不带 `--apply` 时不改任何表。

### JP-21 · 对既有代码的改动与护栏

**陈述**：

- 对 A、C 的表与代码**零修改**。对既有代码的改动只有：`plan-main.ts` 装配 `downstream`；`src/db/schema/index.ts` 导出；`package.json` 脚本；`.env.example` 变量名；INDEX / 登记脚本 / CONTEXT / PRD 链接；
- 静态护栏（`acceptance-boundaries.test.ts`，各配一个故意违规的反向用例）：① `judgement` 模块不得对 A 的表、C 的表做 `insert / update / delete`，读 A 的表只允许出现在 `facts.ts`；② 不得 import `provider-adapter` 的供应商调用、`raw-capture`、`orchestrator/claim`，不得写 `sync_tasks`；③ 不得在 `db.transaction` 回调里调用 `SignalsPort` / `DemandPort`；④ `judgement` 下的 `*.db.test.ts` 加入 `Promise.all` 扫描；⑤ 配置与证据 schema 中不得出现原文字段；
- 无新依赖。

**验收标准**

- `drizzle-kit generate` 不产生新迁移（迁移与 schema 一致）；迁移在空库上成功并幂等；
- 五条护栏各有反向用例，违规时护栏报错；
- 既有测试（`pnpm test`、`pnpm test:db`）保持通过。

## 3. PRD 验收项映射

D PRD §六的验收清单与本 spec 需求的对应：

| PRD 验收分组 | 本 spec 需求 |
|---|---|
| 第 1 层 | JP-2、JP-5、JP-8 |
| 第 2 层 | JP-6、JP-8、JP-11 |
| 第 3 层 | JP-12、JP-10 |
| 专员级判定与完成率 | JP-9 |
| 计划流程与版本 | JP-3、JP-4、JP-7、JP-15、JP-17 |
| 评论对象 | JP-10 |

PRD 里的 `[手工]` 项（业务在界面上配出条件并看到圈定条数；上传标准图后看分布）依赖页面；页面任务见 `tasks.md` 任务 13–16，离线验收先用 CLI 输出代替（acceptance MAN-1、MAN-2），页面可用后再补页面验收。

## 4. 需求级完成边界

- 完成全部 JP 需求**不自动代表** D 域对业务可用：C 的真实实现、H1 网关、图像匹配分的标定、页面验收都不在本 spec 的离线验收内；因此生产里第 2 层与第 3 层默认无法发布，只有第 1 层（文本）的计划能真正跑通；
- 本 spec 的「完成」指：配置、版本、圈定、试跑、执行、聚合、评论、账号、证据、对 E 的输出、对 A 的下游端口都有离线测试；与 C 的 fake / 真实契约测试共享同一份；CLI 可演示「建计划 → 圈定 → 确认执行 → 看结果」；
- 本 spec 不关闭 design §14 中标「外部」的条目（C 的接口对齐、E 的对齐、A 的名单锁定）；它们关闭前相应条目保持 `draft`。
