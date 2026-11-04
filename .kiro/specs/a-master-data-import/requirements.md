# A 主数据导入（a-master-data-import）· 需求

> **状态**：`draft`
>
> **模式**：Design-First
>
> **实现状态**：仅定义可验收需求；尚未执行 [`tasks.md`](tasks.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-import`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10（2026-11-04，定稿候选）
>
> **相邻 PRD**：[`prd-domain-f-business-apps.md`](../../../HBECHO设计方案/prd-domain-f-business-apps.md) v1.0.1（2026-11-04，F5 界面与用户旅程）、[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21（2026-11-04，Capability 名称）
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)（draft，2026-11-04 十项修订后）
>
> **最近核对**：2026-11-04
>
> **更新日期**：2026-11-04（初建）
>
> **语言约定**：正文中文；验收标准中的规范性关键词 `SHALL` / `SHALL NOT` / `MAY` 与技术标识保留英文（对齐 `a-data-foundation-tracer` 的写法）。

## 1. 引言

### 1.1 权威顺序

冲突时按此顺序裁决，不在代码、SQL 或本 spec 里暗中选择一方：

1. [`CONTEXT.md`](../../../CONTEXT.md)：领域词汇与不变量；
2. [`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10：A 域产品语义的唯一真相源，本 spec 的导入规则以其 §4.1、§4.2、§14 A1 为准；
3. [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)：组织主档、导入批次与行结果、质量问题的物理基线；与第 1、2 项冲突时按前两项修订 v2，不在本 spec 或局部 SQL 里另建平行结构；
4. [`prd-domain-f-business-apps.md`](../../../HBECHO设计方案/prd-domain-f-business-apps.md)：F5 的界面、文件级校验与用户旅程。F-D02 明确「模板校验、判重、upsert、纠错语义全部引用 A 域」，因此 F 域只补充 A 域没写的界面边界；
5. [`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md)：Capability 名称与品牌范围求交。本 spec 只引用名称，不复制授权实现；
6. [`a-data-foundation-tracer`](../a-data-foundation-tracer/requirements.md)：共享的仓库目录、迁移、CLI 与离线验证约定；tracer 不拥有的主数据事实以本 spec 为准；
7. 本 spec：不得静默改写以上事实。

### 1.2 上游与依赖

| 依赖 | 当前状态 | 对本 spec 的影响 |
|---|---|---|
| `a-data-foundation-tracer` | spec 四件套完整，代码 0/9 | 复用其任务 2 建立的 `src/db` 迁移骨架、`src/modules/` 目录约定与 CLI 退出码约定；本 spec 不重新选型 |
| B 域访问控制 | PRD v1.21 定稿；实现未开始 | Capability 名称按 B PRD；真实用户认证与 DataScope 由 B 实现。1.0 仅允许受限服务身份，经 `AuthorizationPort` 进入 |
| F5 导入中心界面（路径 1） | 总 PRD §7.2 把「F5 路径 1」归入本 spec；UI 全局基线 `ui-foundation.md` 仍是 draft | 本轮先交付 Module seam 与 CLI；页面在 design「界面」一节占位，UI 基线定稿后补齐并另加任务（2026-11-04 审查订正：原写「F 域不在 1.0 路线图、由 F5 spec 后续接」不符合总 PRD §7.2） |
| v2 数据基线 | draft；2026-11-04 已修订十项 | 本 spec 新增三处 v2 修订要求（§1.3），实施前必须落回 v2 正文 |
| ADR-0005 / 0008 / 0010 / 0013 | accepted | 应用栈、门店身份、品牌交集、仓库目录是硬约束 |

**不依赖的东西**：AI Master、任何外部网络、OBS/OSS、AI 调用、活动计划名单。本 spec 的全部自动验收必须离线完成。

### 1.3 与 v2 基线的冲突（实施前必须修订 v2）

| # | 冲突 | 现状 | 本 spec 的修订要求 | 影响 |
|---:|---|---|---|---|
| 1 | 预检六类无处存放 | `import_row_results.outcome` 只有 `imported/unchanged/conflict/invalid`，且 `NOT NULL`；但预检要给出新增 / 更新 / 未变 / 错误 / 待确认撤店 / 需超管处理 | 增加 `precheck_class VARCHAR(32) NOT NULL`（`new/update/unchanged/error/needs_superadmin`）；`outcome` 改为可空，确认写入后才有值；待确认撤店是门店级事实，写入 `data_quality_issues`，不塞进行结果 | 预检报告、回流文件、批次详情 |
| 2 | 批次计数与六类不对应 | `import_batches` 只有 `new_rows/skipped_rows/error_rows/conflict_rows` | 改为六类各一列：`new_rows/update_rows/unchanged_rows/error_rows/needs_superadmin_rows/pending_closure_stores`；前五列是行级计数，`pending_closure_stores` 是门店级 issue 数；`total_rows` 定义为表头之后的数据行数；删除语义含混的 `skipped_rows/conflict_rows` | 预检汇总、F5 批次列表 |
| 3 | 批次操作者假设真实用户 | `uploaded_by_user_id/confirmed_by_user_id NOT NULL`，`import_row_results.resolved_by_user_id` | 与 `sync_tasks.submitted_by_actor` 对齐：增加 `uploaded_by_actor/confirmed_by_actor/resolved_by_actor VARCHAR(128)`；`*_user_id` 改为可空，B 域接入后再回填。不得用假用户 ID 冒充 | 预-B 的 CLI、审计 |
| 6 | 待确认撤店与同步批次共用 `batch_id` | `data_quality_issues.batch_id` 是同步批次引用（tracer 在用），也没有 `resolved_by_actor` | 增加 `import_batch_id BIGINT NULL`（FK → `import_batches`）与 `resolved_by_actor VARCHAR(128) NULL`；导入类 issue 只填 `import_batch_id` | 待确认撤店、关店确认 |
| 4 | v2 §12.1 与 A v1.10 不同步 | §12.1 第 9 步只列五类，缺「需超管处理」；第 8 步未写已撤店门店重新出现 | 在 v2 §12.1 同步六类、结构边界与恢复语义 | 流程基线 |
| 5 | 文件级失败与批次状态 | `import_batches.status` 有 `precheck_failed`，F §4.4 要求文件级失败「不产生批次」 | 1.0 文件级失败不建批次；`precheck_failed` 只用于已建批次后内部预检中断 | 批次账 |

> 这些是**基线修订**，不是本 spec 私有的实现细节。修订未落回 v2 正文前，不得开始写迁移或 SQL；否则会出现代码与基线各说一套。

### 1.4 PRD 真空与已定结论

下列问题 PRD 没有直接写死，但实现必须选一条。已在 2026-11-04 与刘学奎确认的，标为「已定」；其余是本 spec 的建议，评审 requirements 时一并裁决。

| # | 问题 | 结论 | 性质 |
|---:|---|---|---|
| 1 | 初次上线时，文件里的新经销商 / 板块 / 分公司 / 大区由谁建立 | 本 spec 含**仅超管可用的结构命令、一次性 bootstrap 与 `structure` 模式**；普通批量导入仍不写结构，Q 行由超管用结构命令或 `structure` 模式解决 | 已定（刘学奎，2026-11-04） |
| 2 | 本 spec 的调用入口 | 本轮 **CLI + Module seam**；F5 路径 1 页面仍归本 spec，UI 基线定稿后补「界面」一节与任务 | 已定（刘学奎，2026-11-04；页面归属 2026-11-04 审查订正） |
| 3 | 确认写入同步还是异步 | **同步、有界**：单批 ≤10,000 行、≤10 分钟；分块事务；不新增导入任务表 | 已定（刘学奎，2026-11-04） |
| 4 | 已 `closed` 的门店再次出现在导出中 | **自动恢复 `active`**，记审计；`store_id` 不变 | 已定（刘学奎，2026-11-04） |
| 5 | 模板版本怎么识别 | 输入是上游系统的**权威导出**，不是我方下载的模板，没有版本列；**表头逐列完全一致**即 `master-data-export.v1`。任何列名、列序、增删列都整批拒绝 | 本 spec 建议 |
| 6 | 示例行 | **路径 1 没有示例行**：上游导出不会带我方示例；F-D10 的示例行规则只适用于我方提供的模板（路径 2 名单）。表头之后的每一行都是数据行 | 2026-11-04 审查订正（原设计 `EXAMPLE-0001` 哨兵删除） |
| 7 | 品牌 / 板块编码 | 品牌：`hitachi`（日立）、`hisense`（海信）、`york_vrf`（约克VRF）；板块：`water`（水机）、`home`（家装）。板块编码加分公司前缀保证全局唯一：`{branch_code}-water` / `{branch_code}-home` | 本 spec 建议 |
| 8 | 同一文件重复提交 | 允许新建批次；逐行重新预检，全部 `unchanged`。`file_sha256` 命中只做提示，不直接复用旧批次 | 本 spec 建议（A §14 只要求「不产生额外数据」） |
| 9 | 预检结果有效期 | 不设固定过期时间；确认时逐行**重新校验**，条件已变化的行记 `conflict` / `precheck_stale` 且不写 | 本 spec 建议 |
| 10 | 待确认撤店的确认粒度 | 按批次列出，可逐店勾选；确认写入时同步确认所选门店；不选则一个也不关 | 本 spec 建议 |
| 11 | pre-B 审计落点 | 定义 `AuditPort`；1.0 写入结构化应用日志（稳定 `reason_code` + actor + 目标 ID）；B 域接入后换成持久化审计，不改调用方 | 本 spec 建议 |
| 12 | 结构命令的范围 | 品牌 / 大区 / 分公司 / 经销商 / 板块的建立与改名、停用启用、门店换经销商或板块、单条新建门店、单条停用启用、门店改码；以及 `structure` 模式对文件中新经销商 / 板块 / 关系的批量应用；全部仅超管 | 本 spec 建议，B PRD §7 的 `data.master_data.structure` 已给名称 |

### 1.5 范围

#### 1.5.1 范围内

- 权威主档导出的**文件级校验**、编码识别、表头处理；
- **预检**：逐行分类、持久化行结果、生成六类差异、生成待确认撤店清单；
- **确认写入**：门店 upsert、`source_batch_id`、名称/等级更新、已撤店门店恢复；
- **结构命令**：超管建立/修改大区、分公司、板块、经销商、品牌，给门店换关系，单条新建/停用/启用门店，门店改码，以及一次性 bootstrap 种子；
- **失败行与回流**：行结果长期保留、回流 CSV、按新文件重试；
- **查询与审计事件**：批次列表/详情、行详情、汇总计数、确认/关店/结构变更的审计事件；
- **CLI**：`precheck`、`confirm`、`batches`、`batch`、`rows`、`report`、`structure`、`bootstrap`。

#### 1.5.2 范围外

- 专员（`MediaStaff`）的新建、停用、改手机号：主数据导出不含专员；专员由活动名单导入（`a-activity-plan`）或超管单条新增；
- 平台账号、归属、主页快照、内容、媒资、供应商调用：tracer / full-sync 的范围；
- 活动计划、参与关系、负责人名额、名单：`a-activity-plan`；
- 本轮不实现 F5 路径 1 页面：页面归本 spec，但等 UI 全局基线定稿后再补「界面」一节与任务；路径 2（名单导入）页面归 `a-activity-plan`；
- 真实用户登录、DataScope、Capability 持久化：`b-access-control`；
- 批次回滚、批量撤销、在线编辑单元格、自动重试失败行、定时导入、API 导入、多文件合并、xlsx / Office 导入、列名别名兼容；
- 物理删除任何主档或批次；
- 来源系统的 CRM 稳定 ID、编码族推断、按编码前缀自动合并门店。

### 1.6 术语

| 术语 | 含义 | 来源 |
|---|---|---|
| 权威主档导出 | 11 列 CSV，本次导入的唯一输入 | A §4.2 |
| 预检（precheck） | 只读解析与分类；写批次和行结果，不写业务表 | A §4.2、v2 §12.1 |
| 确认写入（confirm） | 人在看到预检报告后触发的业务写入 | A §4.2、F §4.6 |
| 预检六类 | 新增 / 更新 / 未变 / 错误 / 待确认撤店 / 需超管处理 | F-D09 |
| 需超管处理（Q） | 行本身合法，但涉及结构变更，批量导入不写 | F-D08 |
| 待确认撤店（P） | 本期导出未出现、当前仍 `active` 的门店；确认后才 `closed` | A §4.2、ADR-0008 |
| 结构命令 | 仅超管可用的组织主档变更 | B PRD §7.2、F-D08 |
| bootstrap | 一次性建立 3 个品牌、4 个大区、42 个分公司与每个分公司 2 个板块的种子操作 | 本 spec |
| 回流文件 | 原文件子集 + 结果与原因列的 CSV | F §4.5、§4.7 |
| 行结果 | `import_row_results` 中一行原文与分类/结果 | v2 §9.9 |

## 2. 需求

### MD-1 · 文件级校验先于一切业务写入

**陈述**：系统 SHALL 在创建批次、逐行处理之前完成文件级校验；任一文件级检查失败时 SHALL NOT 创建批次、SHALL NOT 写业务表、SHALL NOT 写行结果。

文件级检查至少包含：

1. 文件大小 ≤ 10 MB；
2. 数据行（不含表头）≤ 10,000 行；
3. 编码可识别：BOM（UTF-8 / UTF-16）→ 严格 UTF-8 → 严格 GB18030 → 拒绝；
4. 表头逐列等于 `master-data-export.v1` 的 11 列；
5. 文件非空，且至少有一条数据行；
6. CSV 结构合法（列数与表头一致、无未闭合引号）。

**验收标准**

- 10 MB + 1 字节、10,001 行、列数不一致、引号未闭合、编码无法识别，五种输入都返回结构化错误，`import_batches` 与 `import_row_results` 行数均为 0；
- GB18030 保存的同内容文件与 UTF-8 版本产生完全相同的预检结果；
- 表头行自动跳过；路径 1 没有示例行，表头之后每一行都按数据行处理；
- 错误信息包含文件名、失败检查项和样本（编码失败时给前 200 字节的可打印表示），不包含整份文件内容。

### MD-2 · 预检只读、逐行分类且可追溯

**陈述**：预检 SHALL 只写 `import_batches` 与 `import_row_results`（以及待确认撤店所需的 `data_quality_issues`），SHALL NOT 写 `brands/regions/branches/sectors/dealers/stores` 等业务表。

每一数据行 SHALL 落入且只落入一个预检类：`new` / `update` / `unchanged` / `error` / `needs_superadmin`；待确认撤店按门店单独记录，不占用行号；批次计数列为 `pending_closure_stores`。

分类 SHALL 按固定优先级执行，前一步失败不再进入后一步：

1. 行字段完整性；
2. `撤店情况 = 无撤销`；
3. `是否数字门店 = 否`；
4. 经销商编码不是 `--` / `#N/A`；
5. `主营业务编码` 可映射到品牌与板块；
6. 品牌存在且为 `active`；
7. 品牌在操作者授权范围内；
8. 分公司编码可解析到 `active` 的分公司；
9. 板块在分公司下存在且为 `active`；
10. 经销商编码存在、为 `active` 且名称一致；
11. 门店匹配与结构边界判断。

**验收标准**

- 预检完成后，业务表 `updated_at` 全部不变，`stores` 行数不变；
- 每一数据行在 `import_row_results` 有且只有一行，`row_no` 从 1 开始、不含表头，`raw_row` 保存 11 个单元格原文；
- 五类行分类计数之和 = 文件级通过后的数据行数；`pending_closure_stores` 是门店级 issue 数，单独计数，不计入行数；`error` 行必须有 `reason_code`，`needs_superadmin` 行必须有 `reason_code`；
- 同一输入重复预检得到相同分类与相同行号；不依赖文件行顺序以外的随机因素；
- 表头不产生行结果。

### MD-3 · 映射只做精确解析，不猜

**陈述**：品牌、板块、大区 SHALL 由版本化映射与种子解析，SHALL NOT 从编码格式、名称相似度或编码族推断。

固定映射（`master-data-mapping.v1`）：

| 主营业务编码（原文去首尾空白） | 品牌 | 板块 |
|---|---|---|
| `13` | `hitachi` | `home` |
| `15` | `hitachi` | `water` |
| `23` | `hisense` | `home` |
| `25` | `hisense` | `water` |
| `33` | `york_vrf` | `home` |

- 编码按原文比较，不转数字；`013`、`13 `、`13.0` 都不是 `13`；
- 大区由 `分公司编码` 经 [`分公司-大区对照.csv`](../../../HBECHO设计方案/domains/data-foundation/seed/分公司-大区对照.csv) 解析；
- `撤店情况` 只接受字面值 `无撤销`；`是否数字门店` 只接受 `否`；
- 主营业务编码未命中一律 `error`（`main_business_code_unmapped`），不回落默认品牌或默认板块。

**验收标准**

- 五个映射组合各产生正确品牌与板块；`014`、`13.0`、空值、全角数字都记 `error`；
- 42 个分公司编码全部命中种子；未知分公司编码记 `needs_superadmin`（`branch_not_found`），不新建分公司，由超管用结构命令建立（与 design §7.3 一致）；
- 分公司**只按编码**解析；文件中的「所属分公司」名称与库中不同不阻塞，只在 `reason_detail` 记一条 `branch_name_differs` 提示（2026-11-04 审查订正：上游导出的分公司名写法与种子不一致时，按名称比较会让整份文件变成需超管处理）；
- 科龙与「中小」门店类型不在 1.0 映射中；出现即 `error`，不静默归入日立或家装；
- 映射表以代码常量或版本化配置存在，改动需要单独的提交与回归测试。

### MD-4 · 门店按 `(brand_id, store_code)` 匹配并 upsert

**陈述**：门店 SHALL 按 v2 `UQ(brand_id, store_code)` 精确匹配；命中则更新非结构字段，未命中则在结构齐全时新建。`store_id` 是身份，`store_code` 只是属性。

- 允许批量导入更新的字段：`store_name`、`store_tier`；
- 不允许批量导入更新的字段：`brand_id`、`dealer_id`、`sector_id`、`store_code`；
- 命中且经销商或板块与文件解析结果不同 → `needs_superadmin`（`store_relation_change`），不写；
- 命中且 `status='closed'`、本行合法 → 预检为 `update`（`reason_code='reactivate_store'`），确认后恢复 `active` 并记审计；
- 新建门店必须能解析出已存在的品牌、经销商、板块；不需要单独的分公司外键，分公司由板块带出；
- 每次写入门店都更新 `source_batch_id`，`unchanged` 不更新时间戳、不写 `source_batch_id`。

**验收标准**

- 同一品牌同一编码不会出现第二条门店；不同品牌同编码允许各一条；
- 改名、改等级确认后生效；经销商或板块不同进入 `needs_superadmin`，确认写入后门店字段不变；
- 已撤店门店再次出现时，确认后 `status='active'`、`store_id` 不变、有审计事件；
- `unchanged` 行的 `updated_at` 与 `source_batch_id` 均不变；
- 新建门店后 `source_batch_id` 等于本批次 ID。

### MD-5 · 批量导入不写结构；结构变更走超管命令

**陈述**：持有 `data.master_data.import` 的操作者 SHALL NOT 通过批量导入新建或修改品牌、大区、分公司、板块、经销商，SHALL NOT 给门店换经销商或板块。这些行 SHALL 分类为 `needs_superadmin` 并保留原文与原因。

系统 SHALL 提供一组仅 `data.master_data.structure` 持有的结构命令，并 SHALL 允许同一预检/确认引擎以 `structure` 模式运行；`structure` 模式 MAY 把 Q 行中的新经销商、经销商改名或启用、分公司下新板块或启用、门店换关系应用到结构主档，SHALL NOT 创建品牌、大区、分公司。普通 `import` 模式 SHALL NOT 因文件内容写任何结构。

结构命令至少覆盖：

- 品牌：新建、改名、停用 / 启用；
- 大区：新建、改名、停用 / 启用；
- 分公司：新建（指定大区）、改名、停用 / 启用；
- 板块：在分公司下新建、改名、停用 / 启用；
- 经销商：新建、改名、停用 / 启用；
- 门店：单条新建、换经销商、换板块、单条停用（`closed`）/ 启用、改码（指定 `store_id` 写新码）；
- 一次性 `bootstrap`：3 个品牌、4 个大区、42 个分公司、每个分公司 2 个板块（`water` / `home`）。

结构命令 SHALL 按自然键幂等（品牌编码、大区编码、分公司编码、板块编码、经销商编码），重复提交相同值返回原记录；编码冲突且指向不同对象时返回冲突。

**验收标准**

- 总部授权品牌内的导入遇到新经销商、缺失板块、缺失分公司、换关系，均记 `needs_superadmin`，`dealers/sectors/branches/stores` 无新增或修改；
- 超管执行结构命令后，同一文件重新预检，原 Q 行变为 `new` / `update`；
- 超管以 `structure` 模式确认时，新经销商、经销商改名、分公司下新板块、门店换关系被写入；品牌、大区、分公司数量不变；
- 同一超管以普通 `import` 模式确认同一文件时，结构类行仍为 `needs_superadmin`，经销商 / 板块 / 门店关系不改；
- `bootstrap` 重跑不产生重复品牌、大区、分公司、板块；42 个分公司各恰好 2 个板块；
- 非超管调用结构命令被拒绝，且没有业务写入；
- 结构变更有审计事件，包含 `reason_code`、actor、对象类型、对象 ID、改前/改后值（不写整行敏感内容）。

### MD-6 · 消失的门店只生成待确认，不自动关闭

**陈述**：预检 SHALL 对授权品牌范围内、`status='active'`、但本期文件中没有任何匹配 `(brand_id, store_code)` 行的门店生成待确认撤店项；SHALL NOT 自动把任何门店置为 `closed`。

- 待确认项写入 `data_quality_issues`：`issue_code='store_missing_from_export'` 或 `store_marked_withdrawn`，`entity_type='store'`，`entity_id=store_id`，`import_batch_id=批次`（v2 R6：不复用指向同步批次的 `batch_id`），`severity='warning'`，`status='open'`，`detail` 至少含 `store_code/store_name/brand_code/dealer_code/last_seen_batch_id`；
- 同一批次同一门店只生成一条；指纹由 `(batch_id, store_id, issue_code)` 决定；
- 确认写入时 MAY 勾选部分或全部待确认项；勾选的门店在写入事务中置 `closed`，issue 置 `resolved` 并写 `resolution_note`；
- 未勾选的门店保持 `active`，issue 保持 `open`；
- 已 `closed` 的门店不进入待确认列表；
- **导出里明确标为撤销**（`撤店情况 ≠ 无撤销`）且库中仍 `active` 的门店，进入待确认列表（`store_marked_withdrawn`），仍需人工勾选才关闭；该行本身照旧记 `error/row_withdrawn`、不写门店（2026-11-04 审查订正：原设计把这类行算作「在文件中出现」而排除出待确认，导致明确撤销的门店永远不会被提议关闭）。

**验收标准**

- 预检后，消失门店全部为 `active`，issue 数量等于消失门店数；
- 确认写入未勾选任何门店时，没有门店变成 `closed`；
- 勾选 3 家中 2 家，只有 2 家 `closed`，对应 issue `resolved`，第 3 家仍 `active` 且 issue `open`；
- 同一文件重复预检不会重复生成同批次 issue；
- 门店改名或改码不会产生待确认项（仍按 `(brand_id, store_code)` 匹配；改码是超管操作）。

### MD-7 · 确认写入同步、有界、幂等、可恢复

**陈述**：确认写入 SHALL 在单次命令内分块完成，单批 ≤10,000 行、≤10 分钟；SHALL NOT 读取超过限额的文件，SHALL NOT 在写入期间持有跨行的长事务。

- 批次状态：`awaiting_confirm` → `writing` → `completed`（有错误行也是 `completed`）或 `failed`（基础设施中止）；
- 写入前 SHALL 用 `SELECT … FOR UPDATE` 锁定批次行，保证同一批次只有一个写入者；
- 每行写入前 SHALL 重新校验预检前提；已变化的行记 `conflict`（`precheck_stale`），不写；
- 每块（默认 500 行）一个短事务，提交后更新批次进度；不在事务内做文件解析或任何网络 IO；
- 写入 SHALL 幂等：同一批次重跑不会产生重复门店、重复关闭或重复审计；已写成功的行再次执行结果为 `unchanged`；
- 进程中断后，批次停留在 `writing`；下一次 `confirm` 在批次锁内检测到陈旧心跳（>10 分钟）后从第一行重跑，按自然键幂等收敛；
- 单行失败 SHALL NOT 回滚其他行；批次终态必须同时表达成功数与失败数。

**验收标准**

- 10,000 行文件在测试环境完成确认写入，返回的六类计数与行结果一致；
- 写入过程中断（在第 3 块后杀进程）后重跑，门店总数、`closed` 数与审计事件数均不重复；
- 两个并发 `confirm` 只有一个进入 `writing`，另一个返回冲突或等待后看到已完成；
- 预检后人为改动一行对应门店的经销商，确认时该行 `conflict` / `precheck_stale`，门店字段不变；
- 行失败（例如唯一键竞争）不阻止后续行写入，批次仍为 `completed`，失败行可查询；
- 写入期间没有任何网络 socket。

### MD-8 · 失败行与回流文件长期可查、可重试

**陈述**：系统 SHALL 保留每一行的原文与分类/结果，SHALL 提供按批次导出的回流 CSV；回流文件 SHALL 与原文件列一致，并追加「预检分类」「结果」「原因」三列。

- 回流文件对以 `= + - @ \t \r` 开头的单元格加 `'` 前缀（F-D11），导入时按文本保留；
- 回流文件只包含 `error`、`needs_superadmin`、`conflict` 行；`new/update/unchanged` 成功行不回流；
- 业务改完回流文件后作为**新文件**重新上传，产生新批次；1.0 不支持在原批次上补传；
- 行结果与批次同寿命保留，不随门店停用或删除清理。

**验收标准**

- 任意批次都能导出回流 CSV；列名、顺序、行号与原文件一致，追加三列；
- 公式注入前缀在回流文件中存在，重新导入后原值不被执行或改写；
- 失败行在新批次中重新预检，分类可以改变；旧批次结果不变；
- 删除/停用门店不影响历史批次与行结果的查询。

### MD-9 · 授权只经 `AuthorizationPort`，品牌范围求交

**陈述**：所有命令 SHALL 在入口处经 `AuthorizationPort` 校验 Capability 与品牌范围；业务模块 SHALL NOT 直接判断角色名或自行放行。

- 批量导入：`data.master_data.import`，可写品牌 = 操作者显式品牌集合；越品牌行记 `error`（`brand_not_authorized`），不中断整批；
- 单条纠错（名称/等级）：`data.master_data.correct`，范围同上；
- 结构命令、bootstrap 与 `structure` 模式：`data.master_data.structure`，仅平台级（超管）；
- 批次与行查询：随对应导入权限，按品牌/批次过滤；
- B 域未实现前，CLI 只允许配置文件中声明的受限服务身份；服务身份必须显式声明 `actor` 与 `brand_scope`，不得缺省为「全部品牌」；
- CLI SHALL NOT 提供 `--skip-auth`、`--force` 或等价的旁路；
- 品牌范围求交按 ADR-0010：组织范围与品牌集合都满足才可写；本 spec 只实现品牌集合这一半，组织范围在 B 接入后补齐。

**验收标准**

- 品牌范围 `{hitachi}` 的操作者遇到 `hisense` 行记 `error` / `brand_not_authorized`，该品牌门店无写入；
- 结构命令对非超管身份返回授权拒绝，且没有任何业务或审计写入；
- 未声明 `brand_scope` 的服务身份启动失败，不退化成全品牌；
- 查询接口不能返回范围外批次的行结果；
- 任何路径都不存在绕过 `AuthorizationPort` 的写入口。

### MD-10 · 审计事件与批次查询

**陈述**：确认写入、待确认撤店确认、结构变更、bootstrap SHALL 产生稳定的审计事件；批次与行结果 SHALL 可按批次查询。

审计事件至少包含：`event_type`、`reason_code`、`actor`、`occurred_at`、`target_type`、`target_id`、`batch_id`（适用时）、`before/after`（仅结构字段，不含整行原文）。

查询 SHALL 提供：

- 批次列表：批次号、文件、actor、时间、状态、六类计数、是否已确认；其中前五类是行级、`pending_closure_stores` 是门店级；
- 批次详情：状态、计数、待确认撤店列表、回流文件可下载标记；
- 行详情：`row_no`、`precheck_class`、`outcome`、`reason_code`、`reason_detail`、命中 `store_id`、原文；
- 所有 BIGINT 以十进制字符串输出；手机号不在本 spec 的数据中。

**验收标准**

- 每次确认、关店、结构变更、bootstrap 都能查到对应审计事件；
- 审计事件不含完整文件内容、不含 secret；
- 批次列表的前五类行计数与行结果聚合一致，`pending_closure_stores` 与 issue 聚合一致；
- 查询不触发任何业务写入；不存在的批次返回稳定「未找到」，不返回空列表冒充成功。

### MD-11 · 默认验证离线、可重复

**陈述**：默认测试 SHALL NOT 发起任何网络请求；SHALL 使用固定 CSV fixture、真实 MySQL 测试库（本地一次性容器或 `_test` 库）与确定性时钟。

- 文件解析、编码识别、映射、分类、回流为纯函数测试；
- 门店 upsert、唯一键、批次锁、恢复为真实 MySQL 集成测试；
- 每类失败至少一个 fixture；六类各至少一个 fixture；
- 不得需要 AI Master secret、OSS 或任何外部服务；
- 测试造数不对争抢同一行锁的操作使用 `Promise.all`；发布类操作顺序 `await`。

**验收标准**

- 测试进程启动时网络 socket 被禁止；任何外联使测试失败；
- 同一 fixture 连续运行 3 次结果一致；
- 迁移在空库上 `migrate` 成功，重复执行幂等；
- 测试库名以 `_test` 结尾，结束后容器/库被清理。

### MD-12 · 批次与门店的一致性边界

**陈述**：系统 SHALL 用数据库约束与受限写入过程保证：同一品牌同一编码只有一条门店；同一批次同一行号只有一条行结果；同一批次同一门店只有一条待确认撤店 issue；已关闭门店不会被并发确认重复关闭。

- 门店写入只经 `src/db` 的受限写过程，不散落 SQL；
- 行结果以 `(import_batch_id, row_no)` 唯一；
- issue 以指纹唯一；
- 结构命令与导入写入都更新 `updated_at`，不使用 `ON DELETE CASCADE`；
- 任何停用/关闭都只改 status，不物理删除。

**验收标准**

- 并发插入同一 `(brand_id, store_code)` 只有一条成功，另一条得到稳定冲突；
- 同一批次重复确认不会产生第二条行结果或第二个 issue；
- 并发关闭同一门店只产生一个 `closed` 终态与一条审计事件；
- 数据库中没有 `ON DELETE CASCADE` 指向组织主档或批次。

## 3. PRD 验收项映射

| 上游条目 | 本 spec 需求 | 说明 |
|---|---|---|
| A §14 A1「11 列模板」 | MD-1、MD-3 | 表头逐列一致；品牌/板块/大区由映射 |
| A §14 A1「同品牌门店编码唯一」 | MD-4、MD-12 | `UQ(brand_id, store_code)` |
| A §14 A1「一个门店一个经销商/板块」 | MD-4、MD-5 | 换关系走 Q + 超管结构命令 |
| A §14 A1「预检六类、确认前不写」 | MD-2、MD-7 | 预检只写批次与行结果 |
| A §14 A1「重复导入全部未变化」 | MD-7、MD-8 | 新批次、全 `unchanged` |
| A §14 A1「消失门店不自动停用」 | MD-6 | 待确认 issue |
| A §14 A1「失败行可重试」 | MD-8 | 回流 CSV + 新批次 |
| A §14 A1「停用不物理删除」 | MD-5、MD-12 | status only |
| A §14 A1「UTF-8 / GB18030」 | MD-1、MD-11 | BOM → 严格 UTF-8 → 严格 GB18030 |
| F §9 路径 1 全部自动项 | MD-1…MD-9 | 见各条验收 |
| F-D08 / B-D34 结构边界 | MD-5、MD-9 | 批量不写结构 |
| F-D12 10 MB / 10,000 行 / 10 分钟 | MD-1、MD-7 | 超限拒绝 |
| F-D13 强制两阶段 | MD-2、MD-7 | 超管也不能一键导入 |
| ADR-0008 门店身份与编码分离 | MD-4、MD-5 | `store_id` 不变；改码走超管 |
| ADR-0010 品牌交集 | MD-9 | 品牌集合显式声明 |

## 4. 需求级完成边界

- 完成全部 MD 需求仍不自动代表 F5 可上线：页面、真实用户认证、DataScope 组织范围由 F 与 B 的 spec 承接；
- 本 spec 的「完成」指：CLI 可完成 bootstrap → 预检 → 确认 → 查询 → 回流，六类分类与结构边界有离线测试，v2 修订已落回正文；
- 未获评审批准前不开始写实现代码（见 [`tasks.md`](tasks.md)）。