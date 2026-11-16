# A 主数据浏览（a-master-data-browse）· 需求

> **状态**：`draft`
>
> **模式**：Design-First
>
> **实现状态**：未实施；界面设计已确认（2026-11-16，design §16.6），读口（T1）与页面（T3）任务可以排期
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-browse`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11.1（2026-11-11，定稿候选）
>
> **相邻 PRD**：[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21（2026-11-04，定稿；Capability 名称与角色矩阵）
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)（§7 组织主档）
>
> **界面基线**：[`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md)（2026-11-10 v2）
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16（初建）
>
> **语言约定**：正文中文；验收标准中的规范性关键词 `SHALL` / `SHALL NOT` / `MAY` 与技术标识保留英文（对齐既有 spec）。

## 1. 引言

### 1.1 为什么有这个 spec

`a-master-data-import` 交付了权威主档的**写入**路径（预检、确认、批次），并在其 requirements 第 15 项与 design §14.5 明确：本 spec 只拥有「导入页 + 批次列表 / 详情」，「组织与门店浏览」另立 spec。该决定经刘学奎 2026-11-05 确认；2026-11-12 的界面确认再次把「组织与门店浏览」排除在导入 spec 的确认范围之外。

运营现在的缺口是：库里有 8,000 多家门店与 40 多个分公司，但在界面上只能看到「导入过什么」，看不到「库里现在有什么」。本 spec 交付这个只读结果。

### 1.2 权威顺序

冲突时按此顺序裁决，不在代码或局部 SQL 里暗中选择一方：

1. [`CONTEXT.md`](../../../CONTEXT.md)：`Store`、`Branch`、`Brand`、`Sector`、`Dealer` 的词汇与不变量；
2. [`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11.1：§4.1 业务规则、§4.2 主数据语义、§14 A1 验收；
3. [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)：§7 组织七表是物理基线；本 spec 只读，不新增表、不改列；
4. [`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21：Capability 名称与角色矩阵；本 spec 复用 `data.master_data.import`，不新增 Capability；
5. [`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md)：导航、列表骨架、筛选与表格交互；
6. [`a-master-data-import`](../a-master-data-import/requirements.md)：已合并的导入实现与 Module 契约；本 spec 在同一 Module 内增加只读口，不改其写入行为；
7. 本 spec：不得静默改写以上事实。

### 1.3 上游与依赖

| 依赖 | 当前状态（2026-11-16 核对） | 对本 spec 的影响 |
|---|---|---|
| `a-data-foundation-tracer` | 已合并 `main` | 复用 `src/db`、`src/modules/`、测试挂具与 `./scripts/verify.sh` |
| `a-master-data-import` | 已合并 `main`（`fd1dd7d`），任务 0–8 与页面 P1 已完成 | 复用 `master-data-import` Module、`ActorContext`（含 `brandScope`）、`MasterDataError`、页面装配 `masterData()` 与 `mdActorOf` |
| `b-access-control` | 已合并 `main`，9 个页面已建成 | 复用登录会话、`AuthContext`、`toMasterDataActor`、`web().directory()`、UI 组件与 CSS |
| v2 数据基线 | draft，35 表已落地 | 本 spec 不新增表、不新增迁移；只读 §7 的组织七表 |
| ADR-0013 | accepted | 模块放在 `src/modules/master-data-import/`，页面放 `src/app/(app)/master-data/` |

**不依赖的东西**：AI Master、网络 IO、OSS、任务队列、活动计划、指标与看板。全部自动验收离线完成（真实数据库容器由 `verify.sh` 提供）。

## 2. 范围边界

### 2.1 做什么

1. 一个只读页面 `/master-data`，以两个视图查看**分公司**与**门店**：
   - 门店视图（默认）：门店编码、名称、品牌、分公司、板块、经销商、经销商编码、店面标准、状态、更新时间；
   - 分公司视图：分公司编码、名称、大区、在用门店数、已撤门店数、更新时间。
2. 门店筛选：品牌、分公司、板块、状态（全部 / 在用 / 已撤店）、店面标准（含「未设置」）、关键字（门店编码或名称包含匹配）；分公司筛选：关键字（编码或名称）。
3. 服务端分页（默认 20，可选 50 / 100），URL 即状态。
4. 权限与 `a-master-data-import` 完全一致：页面与读口只认 `data.master_data.import`（结构身份亦可，沿用现有页面写法）；总部人员只看到授权品牌内的门店与计数。
5. 从分公司行下钻到「该分公司的门店」（同一页面的门店视图 + 分公司筛选）。
6. 「主数据」区内提供**浏览 ⇄ 导入**切换：两个页面顶部共用同一个切换控件，浏览默认，导入一键可达（刘学奎 2026-11-16 要求，取代原「只从导航进入导入」的形态）。

### 2.2 明确不做

| 不做 | 原因 / 归属 |
|---|---|
| 导出（CSV / Excel） | 导出是 `data.export` 的另一个权限，与「和导入一致」冲突；由 E 域的导出与下载中心承担 |
| 单条纠错（改名、改级、停用/启用） | `data.master_data.correct` / `structure` 的写路径；不在只读切片 |
| 结构变更（经销商 / 板块 / 分公司 / 大区、换关系、改码） | 另立 spec（导入 spec design §15.3 已如此建议） |
| 专员列表、平台账号、账号归属 | 分别属于主数据修正与账号域；本 spec 只做分公司 + 门店 |
| 经销商、板块、大区作为独立浏览表 | 只作为门店行的属性列展示，不单独成表 |
| 门店详情页、历史归属快照 | 主档只保留当前值（A §4.1 第 6、7 条）；历史在采集与归属域 |
| 任何写操作、任何审计事件 | 只读；查看行为不记审计 |
| 监控开关的展示与操作 | 属于 `data.monitoring.manage` 与账号域页面 |
| 筛选选项的逐项计数 | 只显示分页总数；逐项计数留待确有需要时再加（见 design §16.6 待确认项） |

### 2.3 页面与实现闸门

本 spec **有页面**。按 `.kiro/steering/structure.md`：design 的「界面」一节须经刘学奎明确确认（§16.6 填写确认人、日期、范围、原型链接）后才能写页面任务与 `src/app/` 页面代码。**已满足**：2026-11-16 design §16.6 已填写，范围含门店六项筛选与分公司视图；页面任务现在可以排期。读口（Module 层）本来不受此限。

## 3. 已定决策

| # | 决策 | 决策人 · 日期 | 推翻 / 取代了什么 |
|---:|---|---|---|
| D1 | 「主数据浏览」新开 spec `a-master-data-browse`，不并入 `a-master-data-import` | 刘学奎 · 2026-11-16 | 不改动导入 spec 已关闭的验收边界；把其 design §15.3「组织与门店浏览……另立 spec（建议，待确认）」从建议变为已确认 |
| D2 | 浏览实体只做**分公司 + 门店**；品牌、板块、经销商、大区只作行内属性 | 刘学奎 · 2026-11-16 | — |
| D3 | 门店状态展示与筛选要做（全部 / 在用 / 已撤店） | 刘学奎 · 2026-11-16 | — |
| D4 | 总部人员按**授权品牌**过滤；分行、门店专员不可见 | 刘学奎 · 2026-11-16 | — |
| D5 | 权限**完全复用** `data.master_data.import`，不新增 Capability | 刘学奎 · 2026-11-16 | 取代导入 spec design §15.3 对浏览页使用 `data.master_data.correct` 的旧建议 |
| D6 | 「主数据」区内用切换按钮在「主数据浏览」与「主数据导入」之间切换，浏览为默认 | 刘学奎 · 2026-11-16 | 取代「主数据只有一个导入入口」的现状；不是新增导航项 |
| D7 | 门店视图增加**板块**与**店面标准**两个筛选项（店面标准含「未设置」） | 刘学奎 · 2026-11-16 | 界面确认时追加；其余界面按 design §16 定稿 |

> 以上均为**决策**（产品拍板），不是事实订正。旧文档的对应行按 `.kiro/steering/structure.md` 的要求在同一批改动里标注被取代，不静默改写。

## 4. PRD 真空与待确认

PRD 没有写死、但实现必须选一条的条目。本表 10 项已于 2026-11-16 由刘学奎逐条确认（按 design 的建议采纳）；之后若要调整，按 `.kiro/steering/structure.md` 的决策修订流程处理，不改本表原行。

| # | 问题 | 结论 | 性质 |
|---:|---|---|---|
| 1 | 浏览页的 Capability | 复用 `data.master_data.import`；页面判断沿用现有三页的 `import \|\| structure` | 已定（D5，2026-11-16） |
| 2 | 浏览哪些实体 | 分公司 + 门店 | 已定（D2，2026-11-16） |
| 3 | 门店状态取值 | 展示 `stores.status`：`active`（在用）/ `closed`（已撤店）；「撤店情况」列是导入输入，不落库、不展示 | 已定（刘学奎，2026-11-16；design MDB-D04） |
| 4 | 默认视图与默认状态筛选 | 默认门店视图、状态「全部」 | 已定（刘学奎，2026-11-16；design §16.1） |
| 5 | 关键字匹配方式 | 编码 / 名称包含匹配；`trim` 后为空则不过滤；上限 64 字符；编码列 `utf8mb4_bin` 区分大小写 | 已定（刘学奎，2026-11-16；design MDB-D07） |
| 6 | 分公司列表是否按品牌收窄 | 分公司行不按品牌收窄（跨品牌共享对象）；门店计数只统计授权品牌内门店 | 已定（刘学奎，2026-11-16；design MDB-D06） |
| 7 | 排序 | 门店：品牌编码 → 分公司编码 → 门店编码 → `store_id`；分公司：分公司编码 → `branch_id` | 已定（刘学奎，2026-11-16；design MDB-D08） |
| 8 | 导航与区内切换 | 导航「数据 → 主数据」指向浏览页 `/master-data`；浏览页与导入页顶部共用「浏览 ⇄ 导入」切换（D6），导入页与导入记录并入其激活范围 | 已定（D6，2026-11-16） |
| 9 | 查看是否记审计 | 不记；只读浏览不产生审计事件 | 已定（刘学奎，2026-11-16；design MDB-D10） |
| 10 | 是否新增索引或迁移 | 不新增；8,327 行量级 + 现有 `idx_stores_*` 足够 | 已定（刘学奎，2026-11-16；design MDB-D14） |

## 5. 上游冲突与需要同步修订的文档

| # | 冲突 | 以谁为准 | 处理 |
|---:|---|---|---|
| 1 | [`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md) §3 页面地图把「组织与门店浏览」的**业务归属**写成 `a-master-data-import` | 本 spec（D1） | 同批改动把该行拆开：「组织与门店浏览」归 `a-master-data-browse`，其余主数据页面仍归 `a-master-data-import`。这是**归属订正**，不是新决策 |
| 2 | 导入 spec design §15.3 建议浏览页用 `data.master_data.correct` | 本 spec（D5） | 在导入 spec 的该行标注「由 a-master-data-browse 的 D5 于 2026-11-16 取代，改用 `data.master_data.import`」；不删原行 |
| 3 | 导入 spec 的 requirements 第 15 项写「另立 spec」但未指明名字 | 本 spec | 在实施分支上补一句指向 `a-master-data-browse`；不改原结论 |

## 6. 需求条目

每条含一句陈述与可判定的验收标准；`[自动]` 指离线测试可判定，`[手工]` 指需要人在页面或测试机上查看。

### MDB-1 访问控制

系统 SHALL 只允许持有 `data.master_data.import` 或 `data.master_data.structure` 的主体读取主数据浏览；其他角色不得读到任何行。

- `[自动]` 无这两个 Capability 的 Actor 调用读口 → `MasterDataError`，`category = "authorization"`、`code = "forbidden"`，不返回数据。
- `[自动]` 页面守卫：无权限时渲染「无权访问」，不发起查询；导航不显示入口（沿用现有页面的入口裁剪）。
- `[手工]` 以分公司人员 / 门店专员账号直接访问 `/master-data` → 「无权访问」；导航无「主数据」。

### MDB-2 品牌范围

总部人员 SHALL 只能读到授权品牌内的门店；平台超管读全部品牌。

- `[自动]` `brandScope` 为品牌编码集合时，读口只返回这些品牌的门店；`brandScope = "all"` 时返回全部。
- `[自动]` 越范围门店不出现在任何一页结果里，也不计入任何总数或分公司计数。
- `[自动]` 品牌范围无法映射为品牌编码时，整体报 `configuration` 错误，不降级为全部品牌（沿用 `mdActorOf` 与 `toMasterDataActor` 的既有语义）。
- `[手工]` 以总部人员账号打开页面，品牌下拉只有授权品牌；选择未授权品牌编码作为关键字搜索 → 0 行。

### MDB-3 门店表格

系统 SHALL 在门店视图按固定列展示当前库中的门店，并给出稳定排序。

- `[自动]` 返回字段：`storeId`（十进制字符串）、`storeCode`、`storeName`、`brandCode`、`brandName`、`branchCode`、`branchName`、`sectorCode`、`sectorName`、`dealerCode`（可空）、`dealerName`、`storeTier`（可空）、`status`、`updatedAt`（ISO-8601 UTC）。
- `[自动]` 排序：`brandCode` → `branchCode` → `storeCode` → `storeId` 升序；同一数据集两次查询顺序一致。
- `[自动]` 已撤店（`status = "closed"`）的门店仍在结果中（A §14 A1「停用的门店不物理删除，历史数据仍可查」）。

### MDB-4 门店筛选

系统 SHALL 支持品牌、分公司、板块、状态、店面标准、关键字六个筛选条件，且筛选只收窄、不放宽数据范围。

- `[自动]` 品牌筛选：只返回该品牌门店；品牌不在读取者范围内时返回 0 行（与不存在的品牌表现一致）。
- `[自动]` 分公司筛选：只返回该分公司（经 `sectors.branch_id`）的门店。
- `[自动]` 板块筛选：按 `sectors.sector_name` 精确匹配；未知名称返回 0 行，不报错。
- `[自动]` 店面标准筛选：按 `stores.store_tier` 精确匹配；「未设置」= `store_tier IS NULL`；`tier` 与 `tierMissing` 同时出现 → `invalid_filter`。
- `[自动]` 筛选选项（板块 / 店面标准）由读口给出，只统计授权品牌内门店；`storeTiers` 不含 `NULL`，`hasMissingTier` 表示范围内是否存在空值。
- `[自动]` 状态筛选：`active` / `closed` / 未指定（全部）；其他取值 → `MasterDataError`，`category = "input"`、`code = "invalid_filter"`，**不得**退化为「全部」。
- `[自动]` 关键字：`store_code LIKE '%kw%' OR store_name LIKE '%kw%'`；`trim` 后为空则视为未指定；超过 64 字符 → `invalid_filter`。
- `[自动]` 品牌 / 分公司筛选值为非十进制 ID → `invalid_filter`，不静默忽略。
- `[自动]` 筛选条件可组合，结果等于各条件的交集。

### MDB-5 分公司表格

系统 SHALL 在分公司视图按固定列展示分公司及其门店计数。

- `[自动]` 返回字段：`branchId`（十进制字符串）、`branchCode`、`branchName`、`regionName`、`activeStoreCount`、`closedStoreCount`、`updatedAt`（ISO-8601 UTC）。
- `[自动]` 计数口径：`activeStoreCount` = 该分公司下 `status = "active"` 的门店数；`closedStoreCount` = `status = "closed"` 的门店数；两者互斥且都只统计读取者授权品牌内的门店。
- `[自动]` 关键字筛选同 MDB-4（编码或名称包含）。排序：`branchCode` → `branchId`。

### MDB-6 分页与总数

系统 SHALL 服务端分页，且总数与列表使用同一条谓词。

- `[自动]` 默认每页 20，允许 20 / 50 / 100；其他值 → `invalid_filter`。
- `[自动]` 返回的 `total` 等于同一筛选条件下不分页的行数；`items.length` ≤ 每页大小。
- `[自动]` `offset` 分页：第 N 页与全量切片一致，页与页之间不重不漏（按 MDB-3 排序）。
- `[自动]` 在 10,000 行门店数据下，单页查询返回行数 ≤ 每页大小（不把全表读进内存）。

### MDB-7 只读

系统 SHALL NOT 在本切片内写入任何业务表或审计事件。

- `[自动]` 用 fake 审计 sink 调用读口 → 不产生审计事件。
- `[自动]` 读口只执行 `SELECT`；`browse` 模块源码不出现 `.insert(` / `.update(` / `.delete(` / `.transaction(` / `sql\`INSERT` 等写语句（静态断言）。

### MDB-8 页面状态

页面 SHALL 覆盖加载、空、无权限、错误四种状态；本切片没有写操作，因此没有「处理中 / 部分成功 / 过期」。

- `[自动]` 页面守卫测试覆盖：先 `requireUser()`，再按 Capability 渲染 `<DeniedState>`（沿用 `plan-actions.guard.test.ts` 的写法，并把新页面加入其页面清单）。
- `[手工]` 无匹配条件时显示空状态与「清空筛选」；筛选条件进 URL，刷新与后退保持。

### MDB-9 界面确认

页面 SHALL 按 design §16.6 已确认的范围实现；超出该范围（新增筛选、改变「未设置」口径、增加导出等）SHALL 重新确认后再改。

- `[手工]` 2026-11-16 已由刘学奎确认，范围见 design §16.6（含板块、店面标准两个筛选）。实施时逐项对照 §16.3–§16.5，不夹带未确认的字段或操作。
- `[手工]` 若走查中发现需要超出范围的改动，先回到 §16.6 重新确认，不在实现里顺手加。

### MDB-10 规模与查询形状

系统 SHALL 在真实数据量级（约 8,327 家门店、40 多个分公司）下使用服务端分页与数据库过滤。

- `[自动]` 列表查询带 `LIMIT`/`OFFSET`；总数用 `COUNT(*)`；不在应用层对全表做 `filter` / `slice` 后再分页。
- `[手工]` 测试 ECS 真实库上打开页面，首屏可用；分公司计数与门店视图的总数一致。

## 7. PRD 验收项映射

| PRD 条目 | 本 spec 的承载 | 说明 |
|---|---|---|
| A §14 A1「停用的门店/专员不物理删除，历史数据仍可查」 | MDB-3、MDB-5 | 已撤店门店仍在浏览结果中，并可被状态筛出 |
| A §4.1「一个门店只属于一个品牌、一个经销商、一个板块」 | MDB-3 | 表格按门店单行展示当前品牌 / 经销商 / 板块，不重建关系 |
| A §4.2「已有记录要改怎么办」 | 范围外 | 单条纠错与结构变更是写路径，见 §2.2 |
| B v1.21 §7.3 能力矩阵 | MDB-1、MDB-2 | 复用 `data.master_data.import`；不新增 Capability |
| ui-foundation §2「没有 Capability 的入口不显示」 | MDB-1 | 导航裁剪沿用现有实现 |
| ui-foundation §4 列表页骨架、§4.1 筛选与表格 | MDB-4、MDB-6、MDB-8 | 筛选一行、URL 即状态、数字右对齐、分页 |
| ui-foundation §4.1「无权限不显示任何计数」 | MDB-2、MDB-5 | 未授权品牌既不出现在筛选，也不计入计数 |

## 8. 未决项

以下不在本 spec 决定，实施时若被触发按 `.kiro/steering/structure.md` 的决策修订流程处理：

1. 筛选选项的逐项计数（每个品牌 / 板块 / 分公司选项旁显示命中数）：本切片不做；若业务坚持，另立切片。
2. 「专员列表」是否沿用同一浏览页形态：另立 spec（导入 spec 已把「专员列表」与浏览并列）。
3. 门店详情页（平台账号、归属、监控开关）：属于账号域页面。
4. 数据量与性能上限：真实门店数超过 10 万，或关键字查询成为瓶颈时，评估索引或搜索方案；本 spec 不预置。