# A 主数据导入（a-master-data-import）· 需求

> **状态**：`draft`
>
> **模式**：Design-First
>
> **实现状态**：任务 0–8 已实现，本机 verify 通过（2026-11-05）；详见 [`tasks.md`](tasks.md) 文末「实施记录」
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-import`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10（2026-11-04，定稿候选）
>
> **相邻 PRD**：[`prd-domain-f-business-apps.md`](../../../HBECHO设计方案/prd-domain-f-business-apps.md) v1.0.1（2026-11-04，F5 界面与用户旅程）、[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21（2026-11-04，Capability 名称）
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)（draft，2026-11-04 十项修订后）
>
> **最近核对**：2026-11-05
>
> **更新日期**：2026-11-05（审查修订：表头改为上游 xlsx 原名；删除「标为撤销」机制；去掉 `store_code_match`；结构命令收窄；v2 修订重列为 R1–R6；见 design §13 MD-D12～D20）
>
> **语言约定**：正文中文；验收标准中的规范性关键词 `SHALL` / `SHALL NOT` / `MAY` 与技术标识保留英文（对齐 `a-data-foundation-tracer` 的写法）。

## 1. 引言

### 1.1 权威顺序

冲突时按此顺序裁决，不在代码、SQL 或本 spec 里暗中选择一方：

1. [`CONTEXT.md`](../../../CONTEXT.md)：领域词汇与不变量；
2. [`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10：A 域产品语义的唯一真相源，本 spec 的导入规则以其 §4.1、§4.2、§14 A1 为准；**例外**：第 5、6 列以上游 xlsx 的列名「门店所属商家 / 门店所属商家渠道编码」为准（§1.4 第 5 项；PRD A v1.10.1、F v1.0.2、v2 §12.1 已于 2026-11-05 订正）；
3. [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)：组织主档、导入批次与行结果、质量问题的物理基线；与第 1、2 项冲突时按前两项修订 v2，不在本 spec 或局部 SQL 里另建平行结构；
4. [`prd-domain-f-business-apps.md`](../../../HBECHO设计方案/prd-domain-f-business-apps.md)：F5 的界面、文件级校验与用户旅程。F-D02 明确「模板校验、判重、upsert、纠错语义全部引用 A 域」，因此 F 域只补充 A 域没写的界面边界；
5. [`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md)：Capability 名称与品牌范围求交。本 spec 只引用名称，不复制授权实现；
6. [`a-data-foundation-tracer`](../a-data-foundation-tracer/requirements.md)：共享的仓库目录、迁移、CLI 与离线验证约定；tracer 不拥有的主数据事实以本 spec 为准；
7. 本 spec：不得静默改写以上事实。

### 1.2 上游与依赖

| 依赖 | 当前状态（2026-11-05 核对） | 对本 spec 的影响 |
|---|---|---|
| `a-data-foundation-tracer` | 任务 1–9 已合并 `main` | 复用已有的 `src/db`（迁移、schema；组织七表与 `media_staff` 已建，`stores.source_batch_id` 暂无外键）、`src/modules/` 目录约定、`src/worker/` 的 CLI 与退出码约定、`tests/harness/` 的禁网与 fake 设施、`./scripts/verify.sh`；本 spec 不重新选型 |
| B 域访问控制 | PRD v1.21 定稿；实现未开始 | Capability 名称按 B PRD；真实用户认证与 DataScope 由 B 实现。1.0 仅允许受限服务身份，经授权入口进入 |
| F5 导入中心界面（路径 1） | 总 PRD §7.2 把「F5 路径 1」归入本 spec；UI 全局基线 `ui-foundation.md` 仍是 draft；页面需要登录，而 B 排在路线图第 4 位 | 本轮先交付 Module seam 与 CLI；页面不在本轮任务内（design §15、MD-D18） |
| v2 数据基线 | draft；2026-11-04 已修订十项 | 本 spec 要求六项 v2 修订（§1.3），实施前必须落回 v2 正文 |
| ADR-0005 / 0008 / 0010 / 0013 | accepted | 应用栈、门店身份、品牌交集、仓库目录是硬约束 |

**不依赖的东西**：AI Master、任何外部网络、OBS/OSS、AI 调用、活动计划名单。本 spec 的全部自动验收必须离线完成。

### 1.3 与 v2 基线的冲突（实施前必须修订 v2）

`import_batches` 与 `import_row_results` 是主数据导入与名单导入共用的表（v2 §9.8）。下列修订只增列、放宽约束，不删除名单导入已在用的列。

| # | 冲突 | 现状 | 本 spec 的修订要求 | 影响 |
|---:|---|---|---|---|
| R1 | 预检分类无处存放 | `import_row_results.outcome` 只有 `imported/unchanged/conflict/invalid` 且 `NOT NULL`；预检要给出新增 / 更新 / 未变 / 错误 / 需超管处理 | 增加 `precheck_class VARCHAR(32) NULL`，CHECK 为 `NULL` 或 `new/update/unchanged/error/needs_superadmin`；`outcome` 改为可空，确认写入后才有值。主数据行的 `precheck_class` 非空由应用保证；名单导入沿用 `outcome`，需要预检类时由其 spec 扩展 CHECK | 预检报告、回流文件、批次详情 |
| R2 | 批次计数与分类不对应；确认租约无处存放 | `import_batches` 只有 `new_rows/skipped_rows/error_rows/conflict_rows` | **不删除**这四列（名单导入在用）。增加 `summary JSON NULL`：主数据批次在预检时写 `{new, update, unchanged, error, needs_superadmin, pending_closure_stores, suspect_incomplete_export}`，确认完成时追加 `{imported, unchanged_written, conflict}`。增加 `writing_token VARCHAR(36) NULL` 与 `heartbeat_at DATETIME(6) NULL`（确认租约与 fencing）。主数据批次不使用那四列（保持 0）；`total_rows` 定义为表头之后的数据行数 | 预检汇总、批次列表、确认恢复 |
| R3 | 批次与行结果的操作者假设真实用户 | `uploaded_by_user_id/confirmed_by_user_id NOT NULL`；`import_row_results.resolved_by_user_id` | 与 `sync_tasks.submitted_by_actor` 对齐：增加 `uploaded_by_actor VARCHAR(128) NOT NULL`、`confirmed_by_actor VARCHAR(128) NULL`、`import_row_results.resolved_by_actor VARCHAR(128) NULL`；三个 `*_user_id` 改为可空，B 域接入后回填。不得用假用户 ID 冒充 | 预-B 的 CLI、审计 |
| R4 | 待确认撤店与同步批次共用 `batch_id` | `data_quality_issues.batch_id` 是同步批次引用（tracer 在用），也没有 `resolved_by_actor` | 增加 `import_batch_id BIGINT NULL`（FK → `import_batches`）与 `resolved_by_actor VARCHAR(128) NULL`；导入类 issue 只填 `import_batch_id`；`CHECK (batch_id IS NULL OR import_batch_id IS NULL)` | 待确认撤店、关店确认 |
| R5 | v2 §12.1 与 A v1.10 / 上游导出不同步 | §12.1 第 9 步只列五类，缺「需超管处理」；第 8 步未写已撤店门店重新出现；第 5、6 列名写作「经销商名称 / 经销商编码」 | 在 v2 §12.1 同步：六类（含需超管处理）、结构边界、已 `closed` 门店恢复，以及上游真实列名 | 流程基线 |
| R6 | `stores.source_batch_id` 没有外键 | `src/db/schema/org.ts` 因 `import_batches` 未建而暂不挂 FK | 随 `import_batches` 建表补 `FK → import_batches`（RESTRICT） | 门店溯源 |

> 门店匹配键保持 v2 现状 `UQ(brand_id, store_code)`（`store_code` 为 `utf8mb4_bin`，按字节精确比较），**不新增** `store_code_match` 生成列（MD-D12 修订）。原因：ADR-0008「另存匹配值」是后果描述，不是硬约束；真实导出 8,327 行中没有大小写差异、首尾空白或重复编码；加列意味着一次迁移和第二套匹配语义。
>
> 这些是**基线修订**，不是本 spec 私有的实现细节。修订未落回 v2 正文前，不得开始写迁移或 SQL；否则会出现代码与基线各说一套。

### 1.4 PRD 真空与已定结论

下列问题 PRD 没有直接写死，但实现必须选一条。已确认的，标为「已定」；其余是本 spec 的建议，评审 requirements 时一并裁决。

| # | 问题 | 结论 | 性质 |
|---:|---|---|---|
| 1 | 初次上线时，文件里的新经销商 / 板块 / 分公司 / 大区由谁建立 | 品牌、大区、分公司、板块由 **bootstrap** 种子建立（新增分公司 = 在种子 CSV 加一行后重跑 bootstrap）；经销商由超管以 **`structure` 模式**确认文件时建立；普通批量导入不写结构，Q 行由超管用 `structure` 模式或 bootstrap 解决 | 已定（刘学奎，2026-11-04；命令族收窄 2026-11-05） |
| 2 | 本 spec 的调用入口 | 本轮 **CLI + Module seam**；F5 路径 1 页面归属见第 15 项 | 已定（刘学奎，2026-11-04） |
| 3 | 确认写入同步还是异步 | **同步、有界**：单批 ≤10,000 行、≤10 分钟；分块事务；不新增导入任务表。超时则停下并可续跑（MD-7） | 已定（刘学奎，2026-11-04） |
| 4 | 已 `closed` 的门店再次出现在导出中 | **自动恢复 `active`**，记审计；`store_id` 不变 | 已定（刘学奎，2026-11-04） |
| 5 | 表头与列名 | 输入是上游权威导出，**列名以上游 xlsx 为准**，共 11 列（业务在转 CSV 前已删去「负责人」）：`门店名称、撤店情况、是否数字门店、门店编码、门店所属商家、门店所属商家渠道编码、所属分公司、分公司编码、主营业务、主营业务编码、店面标准`。**逐列完全一致**即 `master-data-export.v1`；列名、列序、增删列（含多出「负责人」）都整批拒绝。系统内「门店所属商家」就是经销商（Dealer），「门店所属商家渠道编码」就是经销商编码 | 已定（刘学奎，2026-11-05：选列名方案 A，以 xlsx 为准） |
| 6 | 示例行 | **路径 1 没有示例行**：上游导出不会带我方示例；F-D10 的示例行规则只适用于我方提供的模板（路径 2 名单）。表头之后的每一行都是数据行 | 已定（刘学奎，2026-11-05：审阅意见后指示按计划执行） |
| 7 | 品牌 / 板块编码 | 品牌：`hitachi`（日立）、`hisense`（海信）、`york_vrf`（约克VRF）；板块：`water`（水机）、`home`（家装）。板块编码加分公司前缀保证全局唯一：`{branch_code}-water` / `{branch_code}-home` | 本 spec 建议 |
| 8 | 同一文件重复提交 | 允许新建批次；逐行重新预检，全部 `unchanged`。`file_sha256` 命中只做提示，不直接复用旧批次 | 本 spec 建议（A §14 只要求「不产生额外数据」） |
| 9 | 预检结果有效期 | 不设固定过期时间；确认时逐行**重新校验**，条件已变化的行记 `conflict` / `precheck_stale` 且不写 | 本 spec 建议 |
| 10 | 待确认撤店的确认粒度 | 按批次列出，可逐店勾选；确认写入时同步确认所选门店；不选则一个也不关 | 本 spec 建议 |
| 11 | pre-B 审计落点 | 一个 `AuditSink` 函数；1.0 写入结构化应用日志（稳定 `reason_code` + actor + 目标 ID）；B 域接入后换成持久化审计，不改调用方。批次与行结果本身就是持久记录（`confirmed_by_actor`） | 本 spec 建议 |
| 12 | 结构变更的范围 | 1.0 只做：**bootstrap**、**`structure` 模式**（新建经销商、经销商改名与启用、门店换经销商或板块）、**门店改码**（`store change-code`）。品牌 / 大区 / 分公司 / 板块 / 经销商的单条建立、改名、停用启用命令族**延后**到页面开工时再做。全部仅超管 | 刘学奎同意审查意见，2026-11-05 |
| 13 | 导出里的「撤店情况」 | 最终导出里**只会是「无撤销」**，即当前正常运营；「提交初审 / 审核失败 / 撤销成功 / 已升级 / 审核中 / 提交初始 / 审核通过」都是未正常营业，不会出现在导入文件里。因此**不设** `store_marked_withdrawn`；万一出现非「无撤销」，该行记 `error/row_withdrawn` 并在 `reason_detail` 写原值，不进入待确认撤店 | 已定（刘学奎，2026-11-05；取代 2026-11-04 审查提出的「标为撤销也进待确认」） |
| 14 | 分公司名称与库中不同 | 只按分公司编码解析；名称差异不阻塞，只在 `reason_detail` 记 `branch_name_differs` | 已定（刘学奎，2026-11-05） |
| 15 | F5 路径 1 页面的范围 | 建议：本 spec 只拥有「导入页 + 批次列表 / 详情」；「组织与门店浏览」「结构变更」两页另立 spec；页面任务在 B 可登录、UI 基线定稿、原型走查之后再写。**「组织与门店浏览」由 `a-master-data-browse` 实施（2026-11-16）** | 已定（刘学奎，2026-11-05） |
| 16 | 文件格式 | 系统只收 **CSV**（UTF-8 / GB18030）。业务从上游 xlsx 的「门店信息数据」sheet 删去「负责人」列后「另存为 CSV」；编码、门店编码、商家渠道编码按文本保留 | 已定（xlsx 排除见总 PRD T-03）；操作步骤待写入模板说明 |
| 17 | 门店改码 | 上游编码以最终 11 列为准，**不预期**出现新旧编码成对出现的情形；改码只留超管单条命令（ADR-0008 第 4 条），不做「疑似换码」提示 | 已定（刘学奎，2026-11-05） |

### 1.5 范围

#### 1.5.1 范围内

- 权威主档导出的**文件级校验**、编码识别、表头处理；
- **预检**：逐行分类、持久化行结果、生成六类差异、生成待确认撤店清单；
- **确认写入**：门店 upsert、`source_batch_id`、名称/等级更新、已撤店门店恢复；
- **结构**：`bootstrap`（3 个品牌、4 个大区、42 个分公司、84 个板块）、`structure` 模式、门店改码；
- **失败行与回流**：行结果长期保留、回流 CSV、按新文件重试；
- **查询与审计事件**：批次列表/详情、行详情、汇总计数、确认/关店/结构变更的审计事件；
- **CLI**：`precheck`、`confirm`、`batches`、`batch`、`rows`、`report`、`bootstrap`、`store change-code`；
- **F5 路径 1 页面**：归属本 spec（以第 15 项为准），本轮不交付。路径 2（名单导入）页面归 `a-activity-plan`。

#### 1.5.2 范围外

- 专员（`MediaStaff`）的新建、停用、改手机号：主数据导出不含专员；
- 平台账号、归属、主页快照、内容、媒资、供应商调用：tracer / full-sync 的范围；
- 活动计划、参与关系、负责人名额、名单：`a-activity-plan`；
- 真实用户登录、DataScope、Capability 持久化：`b-access-control`；
- 品牌 / 大区 / 分公司 / 板块 / 经销商的单条结构命令族、单条门店新建 / 停用 / 纠错：延后（第 12 项）；
- 批次回滚、批量撤销、在线编辑单元格、自动重试失败行、定时导入、API 导入、多文件合并、xlsx / Office 导入、列名别名兼容；
- 物理删除任何主档或批次；
- 来源系统的 CRM 稳定 ID、编码族推断、按编码前缀自动合并门店、「疑似换码」提示。

### 1.6 术语

| 术语 | 含义 | 来源 |
|---|---|---|
| 权威主档导出 | 11 列 CSV，本次导入的唯一输入 | A §4.2 |
| 门店所属商家 | 文件列名；即经销商（Dealer）。「门店所属商家渠道编码」即经销商编码 | 上游 xlsx |
| 预检（precheck） | 只读解析与分类；写批次和行结果，不写业务表 | A §4.2、v2 §12.1 |
| 确认写入（confirm） | 人在看到预检报告后触发的业务写入 | A §4.2、F §4.6 |
| 预检六类 | 新增 / 更新 / 未变 / 错误 / 待确认撤店 / 需超管处理 | F-D09 |
| 需超管处理（Q） | 行本身合法，但涉及结构变更，批量导入不写 | F-D08 |
| 待确认撤店（P） | 本期导出未出现、当前仍 `active` 的门店；确认后才 `closed` | A §4.2、ADR-0008 |
| bootstrap | 一次性（可重跑）建立 3 个品牌、4 个大区、42 个分公司与每个分公司 2 个板块的种子操作 | 本 spec |
| 回流文件 | 原文件子集 + 结果与原因列的 CSV | F §4.5、§4.7 |
| 行结果 | `import_row_results` 中一行原文与分类/结果 | v2 §9.9 |

## 2. 需求

### MD-1 · 文件级校验先于一切业务写入

**陈述**：系统 SHALL 在创建批次、逐行处理之前完成文件级校验；任一文件级检查失败时 SHALL NOT 创建批次、SHALL NOT 写业务表、SHALL NOT 写行结果。

文件级检查至少包含：

1. 文件大小 ≤ 10 MB；
2. 数据行（不含表头）≤ 10,000 行；
3. 编码可识别：BOM（UTF-8 / UTF-16）→ 严格 UTF-8 → 严格 GB18030 → 拒绝；
4. 表头逐列等于 `master-data-export.v1` 的 11 列（第 1.4 节第 5 项）；多一列、少一列、改名、换序都拒绝；
5. 文件非空，且至少有一条数据行；
6. CSV 结构合法（列数与表头一致、无未闭合引号）。

**验收标准**

- 10 MB + 1 字节、10,001 行、列数不一致、引号未闭合、编码无法识别，五种输入都返回结构化错误，`import_batches` 与 `import_row_results` 行数均为 0；
- 带「负责人」的 12 列文件、把「门店所属商家」改回「经销商名称」的文件，都被整批拒绝，并展示正确的 11 列；
- GB18030 保存的同内容文件与 UTF-8 版本产生完全相同的预检结果；
- 表头行自动跳过；路径 1 没有示例行，表头之后每一行都按数据行处理；
- 错误信息包含文件名、失败检查项和样本（编码失败时给前 200 字节的可打印表示），不包含整份文件内容。

### MD-2 · 预检只读、逐行分类且可追溯

**陈述**：预检 SHALL 只写 `import_batches` 与 `import_row_results`（以及待确认撤店所需的 `data_quality_issues`），SHALL NOT 写 `brands/regions/branches/sectors/dealers/stores` 等业务表。

每一数据行 SHALL 落入且只落入一个预检类：`new` / `update` / `unchanged` / `error` / `needs_superadmin`；待确认撤店按门店单独记录，不占用行号；批次汇总里为 `pending_closure_stores`。

分类 SHALL 按固定优先级执行，前一步命中即停（完整表见 design §7.3，两处必须一致）：

1. 行字段完整性（除「店面标准」外 10 列必填）；
2. `撤店情况 = 无撤销`；
3. `是否数字门店 = 否`；
4. 商家渠道编码不是 `--` / `#N/A`；
5. `主营业务编码` 可映射到品牌与板块；
6. 品牌在操作者授权范围内（只用映射出的品牌编码判断，先于任何库内查询，避免向范围外操作者泄露其他品牌的状态）；
7. 文件内 `(品牌, 门店编码)` 不重复；
8. 文件内同一商家渠道编码的商家名称一致；
9. 品牌存在且为 `active`；
10. 分公司编码可解析到 `active` 的分公司；
11. 板块在分公司下存在且为 `active`；
12. 经销商编码存在、为 `active` 且名称一致；
13. 门店匹配与结构边界判断。

**验收标准**

- 预检完成后，业务表 `updated_at` 全部不变，`stores` 行数不变；
- 每一数据行在 `import_row_results` 有且只有一行，`row_no` 从 1 开始、不含表头，`raw_row` 保存 11 个单元格原文；
- 五类行分类计数之和 = 文件级通过后的数据行数；`pending_closure_stores` 是门店级 issue 数，单独计数，不计入行数；`error` 与 `needs_superadmin` 行必须有 `reason_code`；
- 同一输入重复预检得到相同分类与相同行号；
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
- 42 个分公司编码全部命中种子；未知分公司编码记 `needs_superadmin`（`branch_not_found`），不新建分公司；处理方式是在种子 CSV 补一行后重跑 bootstrap；
- 分公司**只按编码**解析；文件中的「所属分公司」名称与库中不同不阻塞，只在 `reason_detail` 记 `branch_name_differs`；
- 科龙与「中小」门店类型不在 1.0 映射中；出现即 `error`，不静默归入日立或家装；
- 映射表以代码常量存在，改动需要单独的提交与回归测试。

### MD-4 · 门店按 `(brand_id, store_code)` 匹配并 upsert

**陈述**：门店 SHALL 按 v2 `UQ(brand_id, store_code)` 精确匹配（门店编码去首尾空白后按字节比较，不做大小写或其他规范化）；命中则更新非结构字段，未命中则在结构齐全时新建。`store_id` 是身份，`store_code` 只是属性。

- 允许批量导入更新的字段：`store_name`、`store_tier`；
- 不允许批量导入更新的字段：`brand_id`、`dealer_id`、`sector_id`、`store_code`；
- 命中且经销商或板块与文件解析结果不同 → `needs_superadmin`（`store_relation_change`），不写；
- 命中且 `status='closed'`、本行合法 → 预检为 `update`（`reason_code='reactivate_store'`），确认后恢复 `active` 并记审计；
- 新建门店必须能解析出已存在的品牌、经销商、板块；分公司由板块带出；
- 每次写入门店都更新 `source_batch_id`，`unchanged` 不更新时间戳、不写 `source_batch_id`；
- `店面标准` 为空时 `store_tier` 写 `NULL`。

**验收标准**

- 同一品牌同一编码不会出现第二条门店；不同品牌同编码允许各一条；
- 改名、改等级确认后生效；经销商或板块不同进入 `needs_superadmin`，确认写入后门店字段不变；
- 已撤店门店再次出现时，确认后 `status='active'`、`store_id` 不变、有审计事件；
- `unchanged` 行的 `updated_at` 与 `source_batch_id` 均不变；
- 新建门店后 `source_batch_id` 等于本批次 ID。

### MD-5 · 批量导入不写结构；结构变更走 bootstrap、`structure` 模式与改码命令

**陈述**：持有 `data.master_data.import` 的操作者 SHALL NOT 通过批量导入新建或修改品牌、大区、分公司、板块、经销商，SHALL NOT 给门店换经销商或板块。这些行 SHALL 分类为 `needs_superadmin` 并保留原文与原因。

系统 SHALL 提供仅 `data.master_data.structure` 持有的三类结构操作：

- `bootstrap`：3 个品牌、4 个大区、42 个分公司、每个分公司 2 个板块（`water` / `home`）。只新增或确认，不改名、不停用；
- `structure` 模式：同一预检/确认引擎以 `structure` 模式运行时，MAY 把 Q 行中的**新经销商、经销商改名或启用、门店换经销商或板块**应用到主档，SHALL NOT 创建品牌、大区、分公司、板块；
- `store change-code`：对指定 `store_id` 写入新的 `store_code`，`store_id` 不变。

普通 `import` 模式 SHALL NOT 因文件内容写任何结构。

**验收标准**

- 授权品牌内的导入遇到新经销商、缺失板块、缺失分公司、换关系，均记 `needs_superadmin`，`dealers/sectors/branches/stores` 无新增或修改；
- 超管以 `structure` 模式确认后，同一文件重新预检，原 Q 行变为 `new` / `update` / `unchanged`；品牌、大区、分公司、板块数量不变；
- 同一超管以普通 `import` 模式确认同一文件时，结构类行仍为 `needs_superadmin`；
- `bootstrap` 重跑不产生重复；42 个分公司各恰好 2 个板块；种子 CSV 损坏（一个分公司对应两个大区）时整批失败；
- 非超管调用 bootstrap、`structure` 模式或改码命令被拒绝，且没有业务写入；
- 改码后 `store_id` 不变，新码可命中，旧码不再命中；新码与同品牌其他门店冲突时返回冲突；
- 结构变更有审计事件，包含 `reason_code`、actor、对象类型、对象 ID、改前/改后值（不写整行内容）。

### MD-6 · 消失的门店只生成待确认，不自动关闭

**陈述**：预检 SHALL 对「本期文件里出现的品牌」且在操作者授权范围内、`status='active'`、但本期文件中没有任何匹配 `(brand_id, store_code)` 的门店生成待确认撤店项；SHALL NOT 自动把任何门店置为 `closed`。

- 范围只取**文件中实际出现的品牌**：文件里没有某品牌的任何行，该品牌的门店不进入待确认（避免一份只含日立的文件把全部海信门店列为消失）；
- 待确认项写入 `data_quality_issues`：`issue_code='store_missing_from_export'`，`entity_type='store'`，`entity_id=store_id`，`import_batch_id=批次`（v2 R4：不复用指向同步批次的 `batch_id`），`severity='warning'`，`status='open'`，`detail` 至少含 `store_code/store_name/brand_code/dealer_code/last_seen_batch_id`；
- 同一批次同一门店只生成一条；指纹由 `(issue_code, import_batch_id, store_id)` 决定；
- 待确认数占范围内 `active` 门店比例超过 20% 时，批次 `summary.suspect_incomplete_export=true`，CLI 在预检与确认时提示「疑似导出不完整」；这是提示，不阻止确认（勾选仍必须显式）；
- 确认写入时 MAY 勾选部分或全部待确认项；勾选的门店置 `closed`，issue 置 `resolved`；未勾选的门店保持 `active`；
- 已 `closed` 的门店不进入待确认列表；
- 非「无撤销」的行记 `error/row_withdrawn`，其门店只要在文件里出现就不算消失，也不进入待确认（第 1.4 节第 13 项）；
- 确认完成时 SHALL 收敛旧批次遗留的 open issue（design §7.5）：门店已被关闭 → `resolved`（`closed_by_other_batch`）；门店在本批文件中重新出现 → `resolved`（`store_reappeared`）；其余 → `ignored`（`superseded_by_batch`，由本批自己的待确认项接续）。

**验收标准**

- 预检后，消失门店全部为 `active`，issue 数量等于消失门店数；
- 只含日立行的文件，不会为海信门店生成 issue；
- 确认写入未勾选任何门店时，没有门店变成 `closed`；
- 勾选 3 家中 2 家，只有 2 家 `closed`，对应 issue `resolved`，第 3 家仍 `active` 且 issue `open`；
- 同一文件重复预检不会重复生成同批次 issue；不同批次对同一门店各有一条，但确认后旧批次的 issue 不再停留在 `open`；
- 门店改名不会产生待确认项（仍按 `(brand_id, store_code)` 匹配；改码是超管单条命令）。

### MD-7 · 确认写入同步、有界、幂等、可恢复

**陈述**：确认写入 SHALL 在单次命令内分块完成，单批 ≤10,000 行、≤10 分钟；SHALL NOT 读取超过限额的文件，SHALL NOT 在写入期间持有跨行的长事务。

- 批次状态：`awaiting_confirm` → `writing` → `completed`（有错误行也是 `completed`）或 `failed`（基础设施中止）；
- 进入 `writing` 时 SHALL 用 `SELECT … FOR UPDATE` 锁定批次行，写入新的 `writing_token` 与 `heartbeat_at`；之后**每个块的事务开头**重新锁批次行并核对 `writing_token` 仍是自己的，否则中止（`lease_lost`），保证被接手的旧进程不会继续写（fencing）；
- 每行写入前 SHALL 重新校验预检前提；已变化的行记 `conflict`（`precheck_stale`），不写；
- 每块（默认 500 行）一个短事务，提交后更新 `heartbeat_at`；不在事务内做文件解析或任何网络 IO；
- 写入 SHALL 幂等并可续跑：只处理 `outcome IS NULL` 的行，且行的 `outcome` 与它的门店写入在同一事务里提交；已有 `outcome` 的行恢复时 SHALL NOT 被重新写入或覆盖；
- 进程中断后，批次停留在 `writing`；`heartbeat_at` 超过 2 分钟视为陈旧，下一次 `confirm` 在批次锁内换发新 `writing_token` 后从未处理的行继续；
- 总耗时超过 10 分钟时，命令 SHALL 在块边界停下、清空 `heartbeat_at`（立即可被续跑）并以稳定错误码退出；不得无限运行；
- 单行失败 SHALL NOT 回滚其他行；批次终态必须同时表达成功数与失败数（`summary` 的确认部分）。

**验收标准**

- 10,000 行文件在测试环境完成确认写入，返回的汇总与行结果聚合一致；
- 写入过程中断（在第 3 块后杀进程）后重跑：门店总数、`closed` 数与审计事件数均不重复，**且前 3 块行的 `outcome` 仍是 `imported`（没有被改写成 `unchanged`）**，汇总的 `imported` 数等于实际写入数；
- 两个并发 `confirm` 只有一个进入 `writing`，另一个返回冲突或等待后看到已完成；
- 旧进程的心跳陈旧、被新进程接手后，旧进程的下一个块被拒绝（`lease_lost`），不产生写入；
- 预检后人为改动一行对应门店的经销商，确认时该行 `conflict` / `precheck_stale`，门店字段不变；
- 行失败（例如唯一键竞争）不阻止后续行写入，批次仍为 `completed`，失败行可查询；
- 写入期间没有任何网络 socket。

### MD-8 · 失败行与回流文件长期可查、可重试

**陈述**：系统 SHALL 保留每一行的原文与分类/结果，SHALL 提供按批次导出的回流 CSV；回流文件 SHALL 与原文件列一致，并追加「预检分类」「结果」「原因」三列。

- 回流文件对以 `= + - @ \t \r` 开头的单元格加 `'` 前缀（F-D11）；该前缀是展示保护，业务改完后重新上传前需去掉；
- 回流文件编码为带 BOM 的 UTF-8，保证 Excel 直接打开不乱码；
- 回流文件只包含 `error`、`needs_superadmin`、`conflict` 行；`new/update/unchanged` 成功行不回流；
- 业务改完回流文件后作为**新文件**重新上传，产生新批次；1.0 不支持在原批次上补传；
- 行结果与批次同寿命保留，不随门店停用或删除清理。

**验收标准**

- 任意批次都能导出回流 CSV；列名、顺序、行号与原文件一致，追加三列；
- 公式注入前缀在回流文件中存在；
- 失败行在新批次中重新预检，分类可以改变；旧批次结果不变；
- 删除/停用门店不影响历史批次与行结果的查询。

### MD-9 · 授权只经统一入口，品牌范围求交

**陈述**：所有命令 SHALL 在入口处经授权入口校验 Capability 与品牌范围；业务模块 SHALL NOT 直接判断角色名或自行放行。

- 批量导入：`data.master_data.import`，可写品牌 = 操作者显式品牌集合；越品牌行记 `error`（`brand_not_authorized`），不中断整批；
- bootstrap、`structure` 模式与改码命令：`data.master_data.structure`，仅平台级（超管）；
- 批次与行查询：随对应导入权限，按品牌/批次过滤；
- B 域未实现前，CLI 只允许配置文件中声明的受限服务身份；服务身份必须显式声明 `actor` 与 `brand_scope`，不得缺省为「全部品牌」；
- CLI SHALL NOT 提供 `--skip-auth`、`--force` 或等价的旁路；
- 品牌范围求交按 ADR-0010：组织范围与品牌集合都满足才可写；本 spec 只实现品牌集合这一半，组织范围在 B 接入后补齐。

**验收标准**

- 品牌范围 `{hitachi}` 的操作者遇到 `hisense` 行记 `error` / `brand_not_authorized`，即使该品牌在库中不存在或已停用也是这个原因；该品牌门店无写入；
- 结构操作对非超管身份返回授权拒绝，且没有任何业务或审计写入；
- 未声明 `brand_scope` 的服务身份启动失败，不退化成全品牌；
- 查询接口不能返回范围外批次的行结果；
- 任何路径都不存在绕过授权入口的写入口。

### MD-10 · 审计事件与批次查询

**陈述**：确认写入、待确认撤店确认、结构变更、bootstrap SHALL 产生稳定的审计事件；批次与行结果 SHALL 可按批次查询。

审计事件至少包含：`event_type`、`reason_code`、`actor`、`occurred_at`、`target_type`、`target_id`、`batch_id`（适用时）、`before/after`（仅结构字段，不含整行原文）。

查询 SHALL 提供：

- 批次列表：批次号、文件、actor、时间、状态、分类汇总（来自 `summary`）、是否已确认；其中前五类是行级、`pending_closure_stores` 是门店级；
- 批次详情：状态、汇总、待确认撤店列表、回流文件可下载标记；
- 行详情：`row_no`、`precheck_class`、`outcome`、`reason_code`、`reason_detail`、命中 `store_id`、原文；
- 所有 BIGINT 以十进制字符串输出。

**验收标准**

- 每次确认、关店、结构变更、bootstrap 都能查到对应审计事件；
- 审计事件不含完整文件内容、不含 secret；
- 批次汇总的前五类与行结果聚合一致，`pending_closure_stores` 与 issue 聚合一致；
- 查询不触发任何业务写入；不存在的批次返回稳定「未找到」，不返回空列表冒充成功。

### MD-11 · 默认验证离线、可重复

**陈述**：默认测试 SHALL NOT 发起任何网络请求；SHALL 使用固定 CSV fixture、真实 MySQL 测试库（本地一次性容器或 `_test` 库）与确定性时钟。

- 文件解析、编码识别、映射、分类、回流为纯函数测试（`unit` project）；
- 门店 upsert、唯一键、批次锁、租约、恢复为真实 MySQL 集成测试（文件名 `*.db.test.ts`，`db` project）；
- 每类失败至少一个 fixture；六类各至少一个 fixture；
- 不得需要 AI Master secret、OSS 或任何外部服务；
- 测试造数不对争抢同一行锁的操作使用 `Promise.all`；发布类操作顺序 `await`。

**验收标准**

- 测试进程启动时网络 socket 被禁止（沿用 `tests/harness/setup.ts`）；任何外联使测试失败；
- 同一 fixture 连续运行 3 次结果一致；
- 迁移在空库上 `migrate` 成功，重复执行幂等；
- 测试库名以 `_test` 结尾，结束后容器/库被清理。

### MD-12 · 批次与门店的一致性边界

**陈述**：系统 SHALL 用数据库约束与受限写入过程保证：同一品牌同一编码只有一条门店；同一批次同一行号只有一条行结果；同一批次同一门店只有一条待确认撤店 issue；已关闭门店不会被并发确认重复关闭。

- 门店写入只经 `src/db` 的受限写过程，不散落 SQL；
- 新建门店先 `INSERT`，遇唯一键冲突（MySQL 1062）在保存点内回滚并记 `conflict`，不先 `SELECT … FOR UPDATE` 一个不存在的键（避免间隙锁死锁）；
- 行结果以 `(import_batch_id, row_no)` 唯一；
- issue 以指纹唯一；
- 结构操作与导入写入都更新 `updated_at`，不使用 `ON DELETE CASCADE`；
- 任何停用/关闭都只改 status，不物理删除。

**验收标准**

- 并发插入同一 `(brand_id, store_code)` 只有一条成功，另一条得到稳定冲突；
- 同一批次重复确认不会产生第二条行结果或第二个 issue；
- 并发关闭同一门店只产生一个 `closed` 终态与一条审计事件；
- 数据库中没有 `ON DELETE CASCADE` 指向组织主档或批次。

## 3. PRD 验收项映射

| 上游条目 | 本 spec 需求 | 说明 |
|---|---|---|
| A §14 A1「11 列模板」 | MD-1、MD-3 | 表头逐列一致（上游原名）；品牌/板块/大区由映射 |
| A §14 A1「同品牌门店编码唯一」 | MD-4、MD-12 | `UQ(brand_id, store_code)` |
| A §14 A1「一个门店一个经销商/板块」 | MD-4、MD-5 | 换关系走 Q + `structure` 模式 |
| A §14 A1「预检六类、确认前不写」 | MD-2、MD-7 | 预检只写批次与行结果 |
| A §14 A1「重复导入全部未变化」 | MD-7、MD-8 | 新批次、全 `unchanged` |
| A §14 A1「消失门店不自动停用」 | MD-6 | 待确认 issue |
| A §14 A1「失败行可重试」 | MD-8 | 回流 CSV + 新批次 |
| A §14 A1「停用不物理删除」 | MD-5、MD-12 | status only |
| A §14 A1「UTF-8 / GB18030」 | MD-1、MD-11 | BOM → 严格 UTF-8 → 严格 GB18030 |
| F §9 路径 1 全部自动项 | MD-1…MD-9 | 见各条验收 |
| F-D08 / B-D34 结构边界 | MD-5、MD-9 | 批量不写结构 |
| F-D12 10 MB / 10,000 行 / 10 分钟 | MD-1、MD-7 | 超限拒绝；真实文件 8,327 行，余量约 17%（design §14 第 6 项） |
| F-D13 强制两阶段 | MD-2、MD-7 | 超管也不能一键导入 |
| ADR-0008 门店身份与编码分离 | MD-4、MD-5 | `store_id` 不变；改码走超管 |
| ADR-0010 品牌交集 | MD-9 | 品牌集合显式声明 |

## 4. 需求级完成边界

- 完成全部 MD 需求仍不自动代表 F5 可上线：F5 路径 1 页面本轮不交付（design §15）；真实用户认证、DataScope 组织范围由 `b-access-control` 承接；路径 2 页面归 `a-activity-plan`；
- 本 spec 的「完成」指：CLI 可完成 bootstrap → 预检 → 确认 → 查询 → 回流，五类行分类、待确认撤店与结构边界有离线测试，v2 六项修订已落回正文；
- 未获评审批准前不开始写实现代码（见 [`tasks.md`](tasks.md)）。
