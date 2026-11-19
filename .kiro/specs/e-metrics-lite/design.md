# E 全量明细与导出（e-metrics-lite）· 设计

> **状态**：`draft`（界面原型 v1 已做，待刘学奎确认，见 §10.6）
>
> **权威来源**：[requirements.md](requirements.md)；D 的读口以 [`d-rule-engine`](../d-rule-engine/design.md) §7.11 / §10.4 与 `src/modules/judgement/outcomes.ts` 为准；数据基线 [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)；界面基线 [`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md)
>
> **更新日期**：2026-11-19

## 1. 一句话方案

新增只读 Module `src/modules/report-detail/`：以「一个判定计划的一次已完成执行」为对象，经 D 的 `JudgementOutcomeReader` 取内容行与参与账号行，经 A 的表补齐名称、快照、采集状态与图片，按「每个条件一列」的规则渲染成两张表（视频明细、账号维度）；一个服务端页面 `/reports/<判定计划>` 浏览，一个导出路由生成两 sheet 的 `.xlsx`（无图）。**不新增表、不新增 Capability、不做投影。** D 侧补三处读口（JP-22），其中账号级「每能力一个结果」由 D 在聚合阶段算好并存一列。

## 2. 形状

| 需要 | 结论 | 理由 |
|---|---|---|
| Module | **新建** `src/modules/report-detail/`：`types.ts`、`columns.ts`（纯）、`cells.ts`（纯）、`facts.ts`（A 侧只读）、`read.ts`（编排）、`authz.ts`、`export.ts`、`index.ts` | 列与单元格规则是纯函数，便于穷举测试；A 侧读取集中在一个文件，不散到页面 |
| 页面 | **新建** `src/app/(app)/reports/[planId]/page.tsx` 与一个客户端组件文件；导出走 `route.ts`（`src/app/(app)/reports/[planId]/export/route.ts`） | 筛选与分页走 URL；导出需要流式响应，Server Action 不适合 |
| CLI | **新建** `src/worker/report-cli.ts`、`report-main.ts`：`pnpm report columns|export` | 页面确认之前就能用真实 / 演示数据验证列与导出；与 `judgement-cli` 同构 |
| 表 | **0 张**；D 的 `run_participants` 加 1 列（迁移 `0016`） | 展示只读；账号能力结果必须由 D 一次算好 |
| 依赖 | **新增 `exceljs@4.4.0`（精确版本）**，已有 ADR-0011 | 不是新选型，是兑现已接受的 ADR |
| 原型 | 待做：`ui-lab/e-metrics-lite/`（A 类，见 §10.6） | 页面规则不复杂，但属于新页面，需先确认 |

## 3. 边界阶梯（no-reinventing-wheels）

1. **代码库已有**：`createAuthorizer`、`createEgress`、`constraintOf`、`registerScopeStrategy`、`JudgementOutcomeReader`、`contentOutcome` / `evaluateMethod`（D 纯函数）、`MediaObjectStore.signedGetUrl` 与 `parseSquareEnv`（video-square）、`_lib/plan-url.ts` 的 `hrefWith` / `pageOf`、`FilterCard` / `EmptyState` / `DeniedState` / `PageHead`。
2. **标准库 / 框架**：筛选与分页走 URL；流式响应用 Web `ReadableStream`；时间格式化用 `Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' })`。
3. **已安装依赖**：drizzle、zod。
4. **成熟开源**：

```
采用：exceljs 4.4.0（MIT，ADR-0011 已接受）
用途：在导出路由里用流式写入器 stream.xlsx.WorkbookWriter 写两个 sheet（冻结首行、字体着色、文本单元格）
不用它做什么：不读取任何外部 xlsx；不嵌图片；不负责范围过滤、列规则、公式前缀（本 spec 自建，见 §7.3）
```

5. 自建部分：列头规则、单元格规则、账号能力结果规则是本项目判定语义的展示合同，没有通用库。

```
自建：列头与单元格规则（report-detail/columns.ts、cells.ts）
搜索过的开源方案：通用表格 / 报表库（如 react-table 类）只管渲染，不认识「能力别名、重名加序号、四态」；数据透视类库会引入聚合，与「不重算」冲突
自建理由：规则几十行纯函数，且必须与 D 的语义逐字对应
```

## 4. D 侧改动（JP-22）

本节是对 D 的**对齐请求**的实现细则，真正的需求与验收写在 D 的 `requirements.md` JP-22；D 的任务 17 实施。**不改任何判定语义。**

### 4.1 读口形状

```ts
// ---- 新增类型 ----
type ConditionKey = string;   // 'l1.<idx>' | 'l2.<abilityId>' | 'l3' | 'comment'
interface ConditionDesc {
  key: ConditionKey;
  layer: 1 | 2 | 3 | "comment";
  kind: "text" | "hashtags" | "duration" | "whole_image" | "image_element" | "asr" | "comment";
  target: "avatar" | "cover" | "background" | null;     // 仅第 2 层
  subject: "content" | "account";                         // 头像、主页背景 = account
  alias: string | null;                                   // 执行所用版本的别名（冻结）
}
interface ContentEvidence {                               // 白名单：不含正文 / 评论原文 / 作者 / 第 3 层模型理由
  l1?: Array<{ idx: number; state: "pass" | "fail" | "unobtained"; hit?: string[]; seconds?: string; reason?: string }>;
  l2?: Array<{ id: string; state: "pass" | "fail" | "unobtained"; score?: string; reason?: string }>;
  l3?: { state: "pass" | "fail" | "unobtained"; verdict?: "meets" | "not_meets" };
}
type AbilityOutcome = "success" | "not_met" | "unobtained" | "skipped";   // D 的 Outcome 加 skipped
interface AbilityResult { key: ConditionKey; result: AbilityOutcome; reason?: string }

// ---- 扩展现有类型 ----
ExecutionDescriptor.config += { conditions: ConditionDesc[] }              // 展示顺序：第 1 层（按 idx）→ 第 2 层内容类 → 第 2 层账号类 → 第 3 层 → 评论
ContentFact += { contentSnapshotId: bigint; staffId: bigint; org: {…六个冻结 ID}; evidence: ContentEvidence | null }
ParticipantFact += { abilityResults: AbilityResult[] | null }              // null = 执行早于 JP-22

// ---- 新增读口 ----
type OrgFilter = { regionId?: bigint; branchId?: bigint; sectorId?: bigint; storeId?: bigint; staffIds?: bigint[] };
executionsOf(planId): Promise<ExecutionDescriptor[]>                        // 该判定计划已 completed 的执行，completed_at 倒序
planRefOf(planId): Promise<{ ref: JudgementPlanRef; alias: string; activityPlanId: bigint; platform: string }>   // 越范围 / 不存在统一 not_found
listContents(executionId, constraint, filter, { offset, limit }): Promise<{ rows: ContentFact[]; total: number }>
listParticipants(executionId, constraint, filter, { offset, limit }): Promise<{ rows: ParticipantFact[]; total: number }>
streamContents / streamParticipants 增加可选 filter 参数                      // 导出用，仍是键集分页
```

- `evidence.l1` 的 `idx` 是 D 现有写法：第 1 层条件**按「文本 → 话题 → 时长」展平**后的位置（`runner.ts` layer1 阶段 `conds.map((c, idx) => …)`）。`ConditionDesc.key = 'l1.<idx>'` 与之一一对应；这是本 spec 与 D 之间唯一的编号契约，契约测试断言它。
- 第 2 层 `evidence.l2[].id` 是 `abilityId`，`key = 'l2.<abilityId>'`。
- 第 3 层 `evidence.l3.reason` 是模型输出的理由文本，**不出读口**；需要原因码时取行的 `reasonCode`。
- 排序（`listContents` / `listParticipants`）：`brand_id, region_id, branch_id, sector_id, store_id, staff_id`（冻结 ID，升序），内容再按 `published_at DESC, content_id`。用 ID 排序是因为 D 不 JOIN 名称表；按名称排序是已知上限（§12）。
- 总数与列表共用同一个 WHERE（拆出共用的条件构造函数），分页与「共 N 条」一致。

### 4.2 `ability_results` 的写入

在 `runner.ts` 的 `aggregate` 阶段，每位参与专员处理时调用新纯函数 `abilityOutcomes(cfg, rows, counts, zero, accountDetail, commentResult)`（放 `engine/pure/aggregate.ts`），结果写入 `run_participants.ability_results`（与现有 `contentResult` 等同一个 UPDATE，同一个 fencing 事务）。

```text
abilityOutcomes(conditions, rows, N, zero):
  for 每个内容类条件 c（第 1 层 / 第 2 层封面 / 第 3 层）:
    P = F = U = 0
    for row in rows:
      s = stateOf(c, row)                       // 从 evidence 取该条件状态；没有 → undefined
      if s == 'pass' P++ ; elif s == 'fail' F++ ; elif s == 'unobtained' U++
      elif s == undefined and row.final == 'unobtained' U++     // 没评估到、但可能通过（与 D 的内容聚合一致）
    if c.layer == 1:
      result = contentOutcome({p:P, u:U, f:F, skipped:0, rows: rows.length}, N, zero)   // rows == 0 → 零内容规则（D 现有函数）
    else:
      result = (P + U + F == 0) ? 'skipped'
             : evaluateMethod({type:'at_least_n', n:N}, {p:P, u:U, f:F}) 映射 success / not_met / unobtained
  for 账号类条件（头像 / 主页背景）:
    result = 取 accountDetail.abilities 里同 id 的 state → pass/fail/unobtained → success/not_met/unobtained；reason 同带
    // accountDetail 为空（账号要求未启用或没算）时不写该条
  comment:
    result = 取 commentResult（NULL 表示未配置，不写）
```

- `stateOf(c, row)`：第 1 层取 `evidence.l1` 里 `idx` 相等的一项；第 2 层取 `evidence.l2` 里 `id` 相等的一项；第 3 层取 `evidence.l3.state`。注意 `l3` 在「没配第 3 层」时 D 写 `l3 = 'not_configured'`，此时没有第 3 层条件，不进入本函数。
- 第 2、3 层条件的评估集不用显式过滤「被选中」：没被选中的行没有该条件的证据（`s == undefined`），且最终结果是 `skipped`（不是 `unobtained`），自然不计。
- 每位专员一次 O(行数 × 条件数)，与 D 现有 `aggregate` 同量级；规模演练（2,001 专员 × 40,000 行，D design §12.1）下增加的是内存里的循环，不增加 SQL。
- 迁移 `0016_d_ability_results.sql`：`ALTER TABLE run_participants ADD COLUMN ability_results JSON NULL`，**只加列**；旧执行为 NULL，读口返回 `null`；`ability_results` 没有 CHECK（JSON 形状由 zod 在写入处校验）。

### 4.3 为什么放在 D，不在 E 重算

E 只读 `run_contents.evidence` 也能算出同样的结果，但那会让「至少 N 条、零内容、未获取成功计入 U」这套规则在两处各写一遍，D 将来改规则 E 就会悄悄对不上；而内容级行还会被保留期清理，账号级结果若靠它重算，旧执行的账号维度就没了。存在 D 的参与专员行里（长期保留），读口只读，是唯一不会漂移的做法。

## 5. Module 契约（`src/modules/report-detail/`）

### 5.1 类型

```ts
export interface ReportContext { ctx: AuthContext; planId: bigint }
export interface ReportFilter { regionId?: string; branchId?: string; sectorId?: string; storeId?: string; staffQuery?: string }   // 十进制字符串；staffQuery 解析为 staffIds
export interface PageArgs { executionId?: string; filter: ReportFilter; page: number }   // page 从 1 起，每页 50

export interface ColumnDef { key: string; header: string; kind: "fixed" | "condition"; conditionKey?: ConditionKey }
export interface Cell { text: string; tone: "pass" | "fail" | "unobtained" | "skipped" | "plain"; link?: string }   // link 仅 http(s)

export interface ReportHeader {                     // 页面顶部与导出文件名所需
  planAlias: string; version: number; executionId: string; completedAt: string;   // ISO UTC
  cutoffAt: string; window: { fromBjt: string; toBjt: string }; platformName: string;
  videosAvailable: boolean;                          // false = 内容级行已被清理
  abilityResultsAvailable: boolean;                  // false = 执行早于 JP-22
}
export interface TableView { header: ReportHeader; columns: ColumnDef[]; rows: ViewRow[]; total: number; page: number; pageCount: number; missingRows: number }
export interface ViewRow { cells: Record<string, Cell>; images: { cover?: string; avatar?: string; background?: string } }   // 图片是签名 URL；缺失省略
```

`read.ts`：

```ts
videos(rc, args):    Promise<TableView>
accounts(rc, args):  Promise<TableView>
executions(rc):      Promise<Array<{ executionId: string; completedAt: string; version: number; isLatest: boolean; contentsPruned: boolean }>>
exportWorkbook(rc, args, sink): Promise<{ videoRows: number; accountRows: number }>   // §7
```

### 5.2 读流程（videos / accounts 共用前半）

```text
1. planRef = outcomes.planRefOf(planId)                                  // 越范围 / 不存在 → not_found
2. authorizer.authorize(ctx, 'report.read', { key: 'report', ref: toReportRef(planRef) })
3. constraint = constraintOf(ctx.scope)                                  // empty → 授权错误，不回退为全部
4. execs = outcomes.executionsOf(planId)；空 → ReportError('no_completed_execution')
5. exec = args.executionId ? execs 里同 ID（找不到 → not_found） : execs[0]
6. filter 解析：organization 过滤直接传；staffQuery → A 里按姓名 / 编码查 staffIds（≤200，超出提示「请缩小关键字」）
7. videos: outcomes.listContents(...)   accounts: outcomes.listParticipants(...)
   contents 被清理 → D 抛 content_rows_pruned → ReportHeader.videosAvailable=false，视频明细返回空表 + 说明
8. facts.load(rows, exec.cutoffAt)                                       // §5.3，批量，不逐行查
9. columns = buildColumns(kind, exec.config.conditions, platformName)    // §5.4 纯函数
10. rows = rows.map(r => renderRow(columns, r, facts))                   // §5.5 纯函数
```

网络 IO（签名）发生在 DB 读取之后，不持有事务（读路径本来也不开事务）。

### 5.3 A 侧批量读取（`facts.ts`）

输入：一页行里出现的 ID 集合（内容 ID、内容快照 ID、账号 ID、专员 ID、组织 ID）。每类一条 `inArray` 查询（ID 集合 ≤ 500，沿用 D 的 `PAGE`）。

| 需要 | 来源与规则 |
|---|---|
| 组织与专员名称 | `brands / regions / branches / sectors / dealers / stores / media_staff` 按冻结 ID 取**当前名称**（名称改动会反映，ID 与归属不变；已知上限 §12） |
| 内容 | `contents`（`platform_content_id` 原文、`content_kind`）+ `content_snapshots` 按 `run_contents.content_snapshot_id`：标题、发布时间、分享链接、四个互动值与状态、`snapshot_at`。**不读 current** |
| 昵称、粉丝、总获赞、作品数 | `account_profile_snapshots`：每个账号在 `finished_at ≤ cutoff` 的批次里按 `(logical_at DESC, batch_id DESC)` 取最新一条（`ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY b.logical_at DESC, b.batch_id DESC)`，MySQL 8.4 窗口函数）。取不到 → 对应列空 |
| 主页链接 | `staff_account_assignments.resolved_home_url`（当前归属）；仅 http(s) |
| 主页 / 视频列表采集状态 | `sync_tasks`：账号 + `requested_action IN ('fetch_profile','fetch_content_list')` + 终态（`succeeded`、`succeeded_with_gap`、`failed`、`dead`、`cancelled`）+ `finished_at ≤ cutoff`，每个 (账号, 动作) 取 `finished_at` 最大一条；走已有索引 `idx_sync_tasks_account_action` |
| 已采集视频数 | `contents`：账号下 `status='active'` 且存在 `finalized_at ≤ cutoff` 的 finalized 快照的内容数（U2 默认含图文）。`GROUP BY account_id` 一条查询 |
| 封面 | `media_references`：`content_snapshot_id` = 冻结快照、`role='cover_normalized'`、`slot_index=0`、`archive_status IN ('archived','carried_forward')` → `media_assets` → `oss_objects` → `signedGetUrl` |
| 头像 / 主页背景 | 同上，按选出的 `profile_snapshot_id`，`role IN ('avatar_normalized','background_normalized')` |
| 平台名 | `platforms.platform_name` |

- 所有 ID 作为十进制字符串出 Module；外部 ID 原样文本，不经 `Number`；
- 任一类查询失败 → 整页错误（不静默当空）；单个值缺失 → 该格空并计入 `missingRows`；
- 签名器来自 `parseSquareEnv(process.env)`；缺配置时全部占位并告警一次（沿用 `assembleSquare` 的做法）。

### 5.4 列规则（`columns.ts`，纯函数）

```text
buildColumns(kind: 'videos'|'accounts', conditions: ConditionDesc[], platformName):
  fixed = kind == 'videos' ? VIDEO_FIXED : ACCOUNT_FIXED         // 表头常量，逐字等于 requirements EL-3 / EL-5；「昵称」列头 = `${platformName}昵称`
  allNames = dedupe(conditions.map(baseName), fixedHeaders(kind 无关的并集))   // 在全集上算：别名 ?? 默认名；重名全员加 ` #k`；撞固定列加 `（能力）`
  conds    = conditions.filter(c => kind == 'accounts' || c.subject == 'content')
  return [...fixed, ...conds.map(c => ({ key: c.key, header: allNames[indexOf(c, conditions)], kind: 'condition', conditionKey: c.key }))]
          + (kind == 'accounts' ? [判定结果] : [])
```

- 默认名：`文本关键词` / `话题` / `时长` / `整图对比·{对象}` / `元素对比·{对象}` / `语音判定` / `评论要求`；对象 `封面` / `头像` / `主页背景`。
- `dedupe` 先算出全部名字、再统计重复，**一次**完成，重复的每一列都加序号（不会出现「第一个不加、后面的加」）。
- **去重总是在 `conditions` 全集上算，再按子集取列头**：账号维度含头像、主页背景条件，视频明细不含。若各自在子集上去重，同一个条件在两张表里可能得到不同序号。因此 `names` 先对全集算好，两张表各取自己需要的那几项。

### 5.5 单元格规则（`cells.ts`，纯函数）

```text
contentCell(cond: ConditionDesc, row: ContentFact, ev: ContentEvidence | null) -> Cell
  if ev == null                      → plain 空                  // 执行没有证据（早于 JP-22 或证据缺失），不当作未评估（EL-4 最后一条）
  if cond.kind == 'comment':
      if row.comments.total != null  → plain `命中 ${pass} / 共 ${total} 条`
      else                           → 走下面「没评估到」的同一条规则（评论候选 = 走完第 2 层的内容，所以 stopLayer < 2.5 且 final == unobtained 时写原因码，否则 skipped）
  entry = lookup(cond, ev)                                   // l1 按 idx；l2 按 abilityId；l3 取 ev.l3
  if entry == undefined:
      // 没评估到：区分两种来源
      if row.final == 'unobtained' 且 row.stopLayer 早于该条件所在层 → unobtained(row.reasonCode ?? 'unknown')   // ② 更早的层获取失败（如发布时间缺失 l0）
      else                                                          → skipped(SKIPPED_TEXT)                       // ① 被更早的层判定不通过 / 未被选中
  state = pass | fail  → 按 kind 渲染（命中词 / 秒 / 分数 / 达标或不达标），tone = state
  state = unobtained   → text = entry.reason ?? row.reasonCode ?? 'unknown'，tone = 'unobtained'
```

- `SKIPPED_TEXT = '前置条件未满足，不进行计算'`；
- 「没评估到」不是空：D 的每一行内容都有明确的停层位置（`stopLayer`），所以一个内容类条件的单元格只有「有证据」「更早层获取失败」「被更早层挡住」三种可能，不存在无法解释的空；
- 分数文本原样用 D 的两位小数字符串；`tone` 取该条件 `state`（通过绿、不通过红）。
- 时长为 `seconds` 字符串原值；话题 / 文本为 `hit.join('、')`，`fail` 且 `hit` 为空 → `未命中`。
- 账号维度单元格：`accountCell(cond, abilityResults)`：`success`→`通过`、`not_met`→`不通过`、`unobtained`→`获取失败`（带 `reason` 时写成 `获取失败：<reason>`）、`skipped`→`前置条件未满足，不进行计算`；`abilityResults == null` → 空。
- 所有写入单元格的文本经 `safeText`（§7.3）。

## 6. 授权（`authz.ts`）

```ts
export interface ReportRef { brandId: bigint; branchIds: readonly bigint[]; activityPlanId?: bigint }
export const reportStrategy: ScopeStrategy<ReportRef> = { contains: 同 judgementPlanStrategy, constraint: constraintOf };
export function registerReportAuthz(registry: AccessRegistry): void {
  if (!registry.scopeStrategy("report")) registry.registerScopeStrategy("report", reportStrategy as ScopeStrategy<never>);
}
```

- **先查再注册**：`e-metrics` 开工时直接复用，不重复注册（它的 design §8.1 要求的 `ref` 比本 spec 多 `activityPlanId`，本 spec 已把它设为可选）；
- Capability：读 `report.read`，导出 `report.export` + 出口 4 的 `guardExit`；**不新增 Capability**，`roles.ts` 不改；
- 越范围的判定计划：`planRefOf` 与 `authorize` 都表现为 `not_found`；
- 范围约束只在 D 读口里生效（按冻结的组织链）。本 spec 不在 SQL 里再写一份范围过滤，避免两处口径；
- 装配：页面进程与 CLI 各调 `registerReportAuthz`，与 `registerJudgementAuthz` 同位。

## 7. 导出（`export.ts` 与路由）

### 7.1 流程（U1 默认路径：同步流式）

```text
GET /reports/<planId>/export?run=&filters…
  1. 解析与校验参数（zod）；planRef、execs、exec 同 §5.2 第 1–5 步
  2. d = egress.guardExit(4, ctx, { capability: 'report.export', resource: { key: 'report', ref }, audit: {...} })
     不通过 → 403（拒绝已记审计）
  3. 行数预检：total = listContents/Participants(..., {offset:0, limit:0}).total；
       videos > 50,000 或 accounts > 5,000 → 409 export_row_limit（不生成任何字节）
  4. 并发上限：进程内计数器 ≤ 2 个同时导出，超出 → 429 export_busy（保护内存）
  5. 响应头：Content-Type = xlsx；Content-Disposition 带 UTF-8 文件名（RFC 5987）
  6. wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: 响应流, useStyles: true })
     sheet「视频明细」：addRow(表头) → 冻结首行 → 逐页 streamContents(filter) → facts.load → renderRow → addRow(...).commit()
     sheet「账号维度」：同上
     await wb.commit()
  7. 完成 / 中途失败都写一条审计与日志（行数、耗时）；中途失败 → 终止连接（客户端得到不完整文件时表现为下载失败，而不是一份「看起来完整」的文件）
```

- 视频明细在 `videosAvailable=false` 时**不生成**该 sheet，响应头 `X-Report-Warning: videos_pruned`，页面据此提示；
- 账号能力结果不可用（旧执行）时账号能力列写空，同样带警告头；
- 流式写入器逐行 `commit()` 释放内存，峰值与单页（500 行）而非全表成正比；
- **没有任何网络 IO 持有数据库事务**：读取是只读语句，签名不发生（导出无图）；
- 规模参照：日立一次 ≈ 13,500 行视频 + 660 账号；本机与测试 ECS 的实测（耗时、峰值 RSS）写入 acceptance 与 §12。

### 7.2 为什么默认同步（以及何时改异步）

ADR-0011 写「不在 Web 请求进程里生成大文件」，针对**带图**的大工作簿（内存是整本在内存里建）。本路径是无图、流式、有硬上限、单次最多两个并发，内存与一页数据成正比。同步路径不新增表与桶，也不依赖 `e-metrics` 的 E6。**这是对 ADR-0011 的有条件豁免，须刘学奎确认（U1）并在 ADR-0011 补一行；确认前该路由不得合并。**

改异步的触发条件（任一）：任务 8 实测单次导出 > 20 秒或峰值 RSS > 300 MB；nginx 的 `proxy_read_timeout` 不能满足；业务要把上限提到 5 万行以上。异步形态 = `e-metrics` 的 E6（任务表 + 私有桶 + 下载链接），届时本 spec 的 `exportWorkbook(rc, args, sink)` 的 `sink` 换成写 OSS 的流，列与单元格规则不变。

### 7.3 单元格安全与格式

- `safeText(s)`：以 `= + - @ \t \r` 开头 → 前加 `'`（ADR-0011；与 F-D11 一致）。适用于**所有来自数据的文本**（标题、昵称、专员姓名、经销商与门店名、命中词、原因码）；数字单元格不经此函数；
- 内容 ID、门店编码、门店编码类字符串：以文本单元格写入（`numFmt: '@'`），避免 19 位 ID 被科学计数法吞掉精度；
- 时间：北京时间文本，不写 Excel 日期序列；
- 互动值：数字单元格，`invalid` 写「无效」，非 `value` 空；
- 着色：`tone` → 字体颜色（通过 `#1B7F3B`、不通过 `#C0362C`、获取失败 `#8A8F98`、未评估 `#B5BAC2`）；不填充背景，保持可打印；
- 首行冻结；列宽按表头与前 100 行估算上限 60 字符；不设置自动筛选（用户可自行加）。

## 8. 失败语义与并发

| 情形 | 错误码 | 行为 |
|---|---|---|
| 无已完成执行 | `no_completed_execution` | 页面空态；导出 409 |
| 执行不存在 / 越范围 | `not_found` | 不泄露存在性 |
| 内容级行已清理 | `content_rows_pruned`（D） | 视频明细空表 + 说明；账号维度正常 |
| 行数超限 | `export_row_limit` | 409，不生成字节 |
| 并发导出过多 | `export_busy` | 429 |
| 授权失败 / 空范围 | `denied_*` | 403；导出的拒绝记审计 |
| D 或 A 读取失败 | `unavailable` | 页面错误态 + 重试；导出中断连接 |
| 单图签名失败 | — | 仅该图占位 |

- 读路径全部是只读，无写入、无锁；与 D 的执行并行时，D 读口只对 `completed` 的执行可见，且 `run_participants` / `run_contents` 在 `completed` 之后不再被写（`maintain` 只会在保留期后整体删除内容级行，读到半途被清理时 D 抛 `content_rows_pruned`，页面按 EL-10 处理）；
- 活动计划被删除进回收站：D 读口对其执行不可见，`planRefOf` 返回 `not_found`；恢复后自然恢复。

## 9. 测试策略（全部离线）

| 层 | 覆盖 |
|---|---|
| 单元（纯函数） | `columns.ts`：别名、默认名、重名加序号（含别名撞默认名、别名撞别名）、撞固定列、两表同一条件列头一致、昵称列头随平台；`cells.ts`：每种条件 × 每种状态 × 「没评估到」两种来源、`unobtained` 写原因码不写 0、分数 / 秒 / 命中词 / 评论 `x / y`、互动值四态、旧执行无证据为空；`abilityOutcomes`：(P, U, F, rows, N, 零内容) 穷举与 D 的 `contentOutcome` 对照参照实现；`safeText` |
| 数据库（`verify.sh` 的 MySQL 8.4 容器） | `facts.ts`：as-of 主页快照（cutoff 之后到达的批次不被选中、`(logical_at, batch_id)` 取最新）、同步状态四态与 `无记录`、已采集作品数口径、封面 / 头像 / 背景的引用选择（`archived` / `carried_forward` 取，`failed` / `pending` 不取）；D 的 `ability_results` 迁移与聚合（真实 `runner`） |
| 契约 | fake 的 `JudgementOutcomeReader` 与 D 真实实现共用一份 shape 测试，覆盖 `ConditionDesc.key ↔ evidence.l1.idx` 的编号对应、`planRefOf` 越范围、`listContents` 的总数 = 无分页流式总数 |
| 授权 | 四个角色各一例（总部、分公司、门店本人、平台管理员）的行集与总数；空范围、无 `report.read`、`store_staff` 导出被拒并记审计；`registerReportAuthz` 重复调用不抛 |
| 导出 | 往返（测试里用独立读取读回，不进生产代码）；上限拒绝不产生字节；`xlsx.read` / `xlsx.load` 全仓零命中的静态检查；`addImage` 零调用；导出并发上限；中途失败连接被终止 |
| 离线 | `network-deny`、`FakeClock`、fake OSS 签名器；不发任何真实采集 / AI 调用 |
| 手工 / 环境 | 对着一份真实执行（日立或海信）核对行数、个别账号与旧系统导出；页面走查（界面确认后）；规模与耗时实测（本机 + 测试 ECS） |

## 10. 界面

> **状态：待确认（§10.6 为空）。** 页面任务不得展开。属 `ui-workflow.md` 的 A 类（新页面）：先在 4100 做原型，请业务走一遍，刘学奎明确确认。

### 10.1 页面清单

| 页面 | 角色 | 入口 | 主要操作 | Capability |
|---|---|---|---|---|
| 全量明细 `/reports/<判定计划>` | 四个角色（门店只看本人范围） | ① D 的判定计划详情与执行记录页新增「全量明细」按钮；② D 现有 `/judgement/results/[runId]` 占位页改为跳转到本页并带 `?run=`；③ **门店专员没有 D 的页面，入口待定（requirements U6）**：建议门店端导航加「全量明细」（原型里已临时放了一个） | 切换执行、切换标签、筛选、翻页、放大看图、导出 | `report.read`；导出 `report.export` |

没有第二个页面。本期**不加**左侧导航入口（避免与 `e-metrics` 的「报表与看板」入口冲突，U 项之外的导航由 `e-metrics` 统一设计）。

### 10.2 流程

```text
判定计划详情 / 执行记录 → 全量明细（默认最近一次完成的执行，默认「视频明细」标签）
  → 切换「账号维度」标签：保留已选的组织筛选
  → 切换执行：下拉列出该计划的历史执行（完成时间、版本）；切换后回到第 1 页
  → 筛选：大区 → 分公司 → 板块 → 门店（级联）、专员搜索；任一变化回到第 1 页
  → 点缩略图 → 放大
  → 导出 Excel：导出当前执行与当前筛选；浏览器直接下载
```

### 10.3 线框（文字版，原型待做）

```text
┌ 全量明细 ─ <判定计划别名>  v3 ───────────────────────── [导出 Excel] ┐
│ 执行：[2026-11-18 18:20 完成 · v3（最近）▾]   窗口 2026-11-01～11-17  │
│ 数据截止 2026-11-18 12:00 · 共 13,543 行 · 平台 抖音                    │
├ [视频明细] [账号维度] ─────────────────────────────────────────────────┤
│ 大区[全部▾] 分公司[全部▾] 板块[全部▾] 门店[全部▾] 专员[搜索…] [重置]     │
├────┬────┬────┬─…─┬──────┬─…─┬───────┬────────┬──────────┬──────┤
│封面│品牌│大区│…… │标题   │…… │话题 #1 │整图对比·封面│语音判定   │…     │
├────┼────┼────┼─…─┼──────┼─…─┼───────┼────────┼──────────┼──────┤
│ ▢  │日立│北区│…… │……     │…… │海信、…  │7.80（绿）  │前置条件未满足，不进行计算│…│
└────┴────┴────┴─…─┴──────┴─…─┴───────┴────────┴──────────┴──────┘
                                  共 13,543 行 · 第 1 / 271 页 [上一页][下一页]
```

- 表格横向滚动，前两列（封面或头像 + 专员姓名）固定在左；能力列在固定列之后，列头 = 别名或默认名；
- 账号维度：左侧头像与主页背景缩略图两列，其后固定列、能力列、判定结果；
- 单元格着色同导出（文字始终可读）；`前置条件未满足，不进行计算` 用浅灰；
- 顶部提示条（按需出现，互斥）：执行早于 JP-22（账号能力列空）、内容明细已过保留期、N 行有缺失数据。

### 10.4 状态矩阵

| 页面 | 加载 | 空 | 无权限 | 错误 | 部分成功 | 处理中 | 过期 |
|---|---|---|---|---|---|---|---|
| 全量明细 | 表格骨架（10 行）；顶部信息条骨架 | ① 无已完成执行：「还没有完成的执行」+ 去判定计划；② 筛选无结果：「没有符合条件的行」+「重置」 | 「当前账号没有查看权限」/ 越范围按「找不到」；导出按钮对无 `report.export` 的角色**隐藏**（不是置灰） | 通用错误态 + 重试 | 单图占位；顶部「N 行有缺失数据」；账号能力列因旧执行为空时的提示条 | 导出请求进行中：按钮显示「正在生成…」并禁用，完成后恢复；失败有提示 | 内容明细已过保留期：视频明细标签显示说明，账号维度可用 |

### 10.5 字段可见性

| 字段 | `platform_admin` | `hq_manager` | `branch_manager` | `store_staff` |
|---|---|---|---|---|
| 两张表的全部列、图片 | 可见（全部范围） | 可见（按品牌范围） | 可见（本分公司） | 可见（仅本人） |
| 「导出 Excel」 | 有 | 有 | 有 | **无**（`report.export` 不含该角色，U5） |
| 联系方式、证据正文 | 不返回 | 不返回 | 不返回 | 不返回 |

### 10.6 界面设计确认

| 确认人 | 日期 | 确认的页面范围 | 原型 / 线框链接 | 备注 |
|---|---|---|---|---|
| （待确认） | | | [`ui-lab/e-metrics-lite/`](../../../ui-lab/e-metrics-lite/README.md) 原型 v1（2026-11-19 起草；4100：<http://localhost:4100/e-metrics-lite/#/judgement>） | AI 不得把「没有反对」当作确认。走查要点见原型 README；确认范围含：入口按钮、两个标签与全部列规则、历史执行切换、导出弹窗、状态矩阵、四个角色的可见性；U6（门店入口）与 U1–U5 同时需要答复 |

## 11. 决策记录

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| EL-D01 | 导出对象 = 一个判定计划的一次已完成执行；不跨计划合并 | 能力列属于具体计划；多计划会重名且口径不同（刘学奎） | 2026-11-19 |
| EL-D02 | 不新增表、不做投影，直接读 D 的执行结果 | 简版只展示全量；投影与重算归 `e-metrics`（刘学奎） | 2026-11-19 |
| EL-D03 | 账号能力结果由 D 算好并存 `ability_results`，E 只读 | 规则只写一处；内容级行会被清理，账号级结果须长期可读（EL-6、§4.3） | 2026-11-19 |
| EL-D04 | 账号能力结果四态 = 通过 / 不通过 / 获取失败 / 前置条件未满足，不进行计算；未被评估的内容单元格同一文案 | 刘学奎 2026-11-19 | 2026-11-19 |
| EL-D05 | 评估规则复用 D 的 `at_least_n` 与零内容规则，N = `quantity ?? 1`；没评估到但最终 `unobtained` 的行计 U | 与 D 的内容聚合一致，避免展示口径与判定口径分叉 | 2026-11-19 |
| EL-D06 | 不新增 Capability，复用 `report.read` / `report.export`；`report` 策略先查再注册 | `e-metrics` 之后复用；B 零改动（刘学奎同意沿用范围规则） | 2026-11-19 |
| EL-D07 | 没有已完成执行时不允许导出，不拼只有基础列的表 | 刘学奎 2026-11-19 | 2026-11-19 |
| EL-D08 | 导出默认同步流式、无图、硬上限；对 ADR-0011 有条件豁免，待 U1 确认 | 不新增表与桶；内存与单页成正比；超限或实测超时再改异步 | 2026-11-19 |
| EL-D09 | 账号维度采集状态取数据截止时点前最近的终态同步任务；无记录显示「无记录」 | 与 `e-metrics` 的 as-of 观测同口径；不把「没记录」当「失败」 | 2026-11-19 |
| EL-D10 | 视频明细只在内容级行未被清理时可用；不为已清理的执行重建 | 重建需要重跑判定，违背「只读展示」 | 2026-11-19 |
| EL-D11 | 评论要求单元格写 `命中 x / 共 y 条`（U3） | 评论达标方式是账号级，内容级没有「达标」 | 2026-11-19 |

## 12. 已知上限

| 上限 | 触顶后 |
|---|---|
| 排序用冻结 ID，不是名称 | 业务要按名称排序时，在 `facts.ts` 取名后内存排序（单页内）或让 D 读口 JOIN 名称（需 D 评审） |
| 组织名称取**当前**主档名称，ID 取冻结值 | 业务需要「执行当时的名称」时让 D 冻结名称 |
| `OFFSET` 分页，深页变慢 | 单页 50 行，业务靠筛选；5 万行内 `OFFSET` 在 PK 范围上可接受，真有需要改键集分页 |
| 同步导出受 nginx 与浏览器超时约束 | 见 §7.2 的改异步触发条件 |
| `staffQuery` 最多解析 200 个专员 | 超出提示缩小关键字 |
| 已采集作品数按 `contents.status` 的当前值，不是 cutoff 时的状态 | 与 `e-metrics` 已知上限 11 同源（A 没有保存内容的历史状态） |
| D 只保留最近 K 次执行的内容级行 | 业务要更久的视频明细时调大 `HBECHO_JP_KEEP_CONTENT_RUNS`（容量见 D design §12.1，约 27 MB / 次） |
| 头像 / 背景图随主页快照，D 无法固定「比对时用的那一张」 | D design §12 已知限制 13；本 spec 展示的是 cutoff 前最新主页快照 |

## 13. 与既有 spec 的接缝

- **读** D：`JudgementOutcomeReader`（JP-16 + JP-22）；**不 JOIN D 的表**；
- **读** A：`contents`、`content_snapshots`、`account_profile_snapshots`、`sync_batches`、`sync_tasks`、`staff_account_assignments`、`media_references` / `media_assets` / `oss_objects`、`platforms`、组织主档；**不写 A**；
- **改** D：迁移 `0016`、`runner.ts` 聚合、`outcomes.ts` 读口、`/judgement/results/[runId]` 占位页改跳转、判定计划详情与执行记录页加入口按钮（D 的页面改动属小改，放 D 任务 17 并在界面确认范围里一并确认）；
- **与 `e-metrics`**：并存。`e-metrics` 的 `JudgementOutcomeReader` 适配器与本 spec 共用同一份读口；`report` 策略共用；导出库共用；两者的导出路径不同（本 spec 无图同步，`e-metrics` 带图异步），不共用文件生成代码；
- **与 `f-video-square`**：共用封面签名器；广场跨品牌公共借鉴，本 spec 按报表授权，二者范围策略不同，互不引用。
