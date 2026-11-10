# A 活动计划（a-activity-plan）· 设计

> **状态**：`draft`
>
> **模式**：Design-First
>
> **需求**：[`requirements.md`](requirements.md)
>
> **实施计划**：[`tasks.md`](tasks.md)（仅规划，尚未执行）
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-activity-plan`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11（定稿候选）§4.2、§5.3、§11
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)（draft）；本 spec 的表与列修订见 §6.3
>
> **最近核对**：2026-11-06（`main` 在 `a-full-sync` 合并之后）
>
> **更新日期**：2026-11-06

## 1. Overview

本 spec 的最小纵向结果是：

```text
总部创建活动计划（品牌 · 平台 · 板块 · 起止日期）
→ 分公司加入
→ 下载名单模板，填 门店编码 / 专员姓名 / 手机号 / 主页链接
→ 文件级校验 → 预检（只读：可写入 / 将新建专员 / 错误，不调供应商）
→ 确认写入（占用负责人名额；自动新建专员；入口命中已有账号的行直接引用；其余行挂 resolve_account 根任务）
→ 名单解析驱动逐个运行根任务（只调主页信息接口）→ 结果归并回行结果与名单
→ 引用计数驱动监控开关：导入即开；显式移出 / 退出 / 删除立即关；暂停 / 到期满 15 天关；恢复重开
→ 每日维护：15 天扫描 + 回收站清除
```

**与已合并 spec 的关系**：

| 已有能力 | 本 spec 怎么用 | 本 spec 不做什么 |
|---|---|---|
| tracer `resolve_account` 根任务 | 每个需要解析的行一个根任务，`profile_only` | 不重写判重、归属冲突、D-69 名额冲突，全部由 `intakeAccount` 裁判 |
| `import_batches` / `import_row_results` | `import_kind='roster'`，沿用确认租约写法 | 不复制 master-data 的汇总形状与查询 |
| `monitoring.explain` | 读取排除原因，合成「XX 被关闭」 | 不改五级开关与目标解析 |
| `supplement --only full --if-older-than` | 对已存在账号请求补抓 | 不创建详情 / 评论任务（`demand` 的静态护栏） |
| `monitoring_enabled` / `monitoring_closed_reason` | 只在引用规则里写 `unreferenced_15d`，只重开该原因 | 不改 `manual` 的语义 |

## 2. Authority and Evidence Levels

### 2.1 Decision order

1. [`CONTEXT.md`](../../../CONTEXT.md)；
2. A 域 PRD v1.11 §11（计划、参与、名额、名单、联动）；
3. v2（账号、归属、专员、导入批次）及本 spec 提出的修订（§6.3）；
4. F 域 PRD v1.0.2（F5 路径 2 的分类、限额、回流）；与 A 冲突时按 A，唯一例外是表头处理（requirements R5，已列待确认）；
5. B 域 PRD v1.21（Capability 与资源谓词）；
6. `a-master-data-import` / `a-full-sync` / tracer 的已合并实现；
7. 本 spec。

### 2.2 Evidence labels

| 等级 | 含义 | 本设计中的例子 |
|---|---|---|
| `code` | 已合并代码里读到的事实 | `runTracerRoot` 只被测试与 `scripts/smoke/fullsync-smoke.ts` 调用；`finishRoot` 的终态字段；`supplement` 的输入形状 |
| `prd` | 上游 PRD 或已编号决策 | 引用定义、15 天、2 个负责人、1,200 软提示、2,000 行 |
| `proposal` | 本 spec 的建议，**待评审** | 名额占用时机、推广的重开规则、模板版本口径 |

没有实测依据的数值（并发 2、块大小 200）一律标为可配置默认值，不当作合同。

## 3. Goals and Non-goals

### 3.1 Goals

1. 计划、参与、负责人、名单的状态机完整、可审计、不留自相矛盾的存法；
2. 名单导入严格两阶段：预检零业务写入；确认后才写专员与挂起解析；
3. 账号解析复用 tracer 根任务，**有人驱动**，并受同一套成本与限流护栏；
4. 监控开关与名单的联动由**一个**函数计算，所有事件走同一条路；
5. 每日维护不依赖 OSS，可重复执行；
6. 给 D / E 留下清晰的只读名单契约与下游端口。

### 3.2 Non-goals

页面、修改主页链接、监控判定计划的任何字段、判定与指标、用户登录与 DataScope 持久化、专员停用、改绑、真实付费 smoke 的自动化。详见 requirements §1.5.2。

## 4. Ownership and Deep Modules

新增三个模块目录与一处抽取（目录约定见 ADR-0013）：

| 模块 | 职责 | 对外 seam | 依赖 |
|---|---|---|---|
| `src/modules/csv-file/`（**抽取**） | 编码识别、CSV 严格解析、回流单元格转义 | `decodeText(bytes)`、`parseCsv(bytes, {header, limits})`、`csvCell`、`buildCsv` | `csv-parse` |
| `src/modules/plan-references/` | **引用计数与监控联动的唯一实现**：引用定义、`reconcileAccounts`、`computeStopAt`、无引用起点 | `reconcileAccounts(tx, ids, ctx)`、`referenceCount`、`markGrace(tx, id, now)` | `src/db` |
| `src/modules/activity-plan/` | 计划、参与、名额、名单导入、解析驱动、维护、查询 | `createActivityPlan(deps)` 返回 `{ plans, branches, owners, roster, accounts, maintenance, query, reader }` | `plan-references`、`csv-file`、`monitoring`、`tracer-command`、`orchestrator`、`sync-schedule` |
| CLI（`src/worker/plan-cli.ts` / `plan-main.ts`） | 命令解析与退出码 | `runCli(argv, deps)` | `activity-plan` |

**为什么 `plan-references` 单独成模块**：`monitoring/set-switch`（手动开启无引用账号时要重置起点）和 `activity-plan`（所有名单事件）都要调它；若放进 `activity-plan`，`monitoring` 反过来依赖 `activity-plan`，而 `activity-plan` 又依赖 `monitoring.explain`，形成环。它只依赖数据库 schema。

**深模块设计**（对齐 `codebase-design` 的做法：窄接口、厚实现）：

- `roster.precheck(file, plan, actor)`：调用方不知道 CSV、分类优先级、哈希复核；
- `roster.confirm(batchId, actor)`：调用方不知道租约、分块、根任务；
- `reconcileAccounts`：调用方只说「这些账号、这个事件」，不知道引用 SQL；
- `reader.rosterSnapshot(planId)`：D 不知道名单的物理形状。

## 5. End-to-end flow

### 5.1 计划与参与

```text
create(plan) → status=collecting；sectors 写入；change: plan_created
branch join  → participation joined（幂等）
owner       → 提交时占用；创建者 / 超管可 replace
pause/archive → 冻结名单；引用重算（timer）
resume       → 解冻；引用重算（gained → 重开）
delete       → 预览 → apply：status=deleted + purge_after；引用重算（immediate）；downstream.onDeleted
restore      → 30 天内：status=status_before_delete；引用重算；downstream.onRestored
purge(daily) → 期满：先 downstream.purge（事务外，幂等），成功后物理清除计划层对象
```

### 5.2 名单导入

```text
precheck(file, planId)
  ├ 文件级校验（失败：无批次）
  ├ 计划须 collecting；单一分公司操作者的分公司须 joined（失败：无批次）
  ├ 内存里完成全部行的分类（含「将新建专员」数 ≤ 1,000 检查；超限：无批次）
  └ 单次写入：import_batches(prechecking→awaiting_confirm) + import_row_results

confirm(batchId)
  ├ 前置检查：状态 / 计划 collecting / joined / capability 放行 / 名额（整批失败，零写入）
  ├ 取租约（writing_token）
  ├ 块循环（每块一个短事务）
  │    重分类（stale → conflict）→ 新建专员 → 入口本地命中？
  │      命中同专员：归并为 unchanged（必要时恢复名单项）
  │      命中他人：conflict
  │      未命中：建 resolve_account 根任务(profile_only) → pending_account
  │    reconcile 本块已归并的账号
  └ 汇总：status = resolving（仍有 pending）| completed

resolver tick（sync worker 进程内）
  └ 对 pending_account 行：runTracerRoot → 终态 → settle 事务（归并）→ 批次无 pending 则 completed
     └ completed 时：对 unchanged 的账号一次 supplement(--only full --if-older-than 168)
```

### 5.3 名单维护与联动

```text
remove(accountIds|staffIds) → state=removed → reconcile(immediate)
branch exit                  → 该分公司在名单项全部 removed → 释放名额 → reconcile(immediate)
plan 状态变化 / 改结束日       → reconcile(timer / gained)
daily scan                   → 补记起点；满 15 天关闭
```

## 6. Data model

### 6.1 新表

通用约定沿用 `src/db/columns.ts`：signed BIGINT 内部 ID，API 十进制字符串；时间 UTC `DATETIME(6)`；日期（计划起止）是**北京时间自然日**，用 `DATE`，无时区换算；状态 `VARCHAR + CHECK`；业务表无 `ON DELETE CASCADE`；约束命名 `uq_/idx_/ck_/fk_<表缩写>_<含义>`。

**`activity_plans`**

| 列 | 说明 |
|---|---|
| `plan_id BIGINT PK` | |
| `plan_name VARCHAR(200) NOT NULL`、`description VARCHAR(2000) NULL` | 说明仅展示，不参与判定 |
| `brand_id BIGINT NOT NULL`、`platform_id BIGINT NOT NULL` | FK → `brands`、`platforms`（RESTRICT）；创建后不可改（无更新路径 + 测试守护） |
| `starts_on DATE NOT NULL`、`ends_on DATE NULL` | `CHECK (ends_on IS NULL OR ends_on >= starts_on)` |
| `status VARCHAR(16) NOT NULL` | `collecting` / `paused` / `archived` / `deleted` |
| `status_changed_at DATETIME(6) NOT NULL` | 无引用起点的计算依据 |
| `status_before_delete VARCHAR(16) NULL`、`deleted_at`、`deleted_by_actor`、`purge_after DATETIME(6) NULL` | `CHECK ((status='deleted') = (deleted_at IS NOT NULL AND status_before_delete IS NOT NULL AND purge_after IS NOT NULL))` |
| `created_by_actor VARCHAR(128) NOT NULL`、`created_by_user_id BIGINT NULL` | 创建者谓词比较 `created_by_actor`；B 接入后回填 user ID，不造假 |
| `created_at`、`updated_at` | |

约束 / 索引：`UQ(plan_id, platform_id)`（供名单项的复合外键）；`IDX(brand_id, status)`；`IDX(created_by_actor, status)`；`IDX(status, purge_after)`。

**`activity_plan_sectors`**：`(plan_id, sector_key)` 主键；`sector_key IN ('water','home')`（与 `master-data-import` 的 `SectorKey` 同一套）；FK → `activity_plans`（RESTRICT）。创建时写入，之后只读。门店属于哪个种类由板块编码 `{分公司编码}-{种类}` 推出，复用 `sectorCodeOf` 的反函数 `sectorKeyOf(sectorCode)`，在 bootstrap 种子上有测试守护。

**`activity_plan_branches`**（参与关系）：主键 `(plan_id, branch_id)`；`status IN ('joined','exited')`；`joined_at`、`joined_by_actor`、`exited_at NULL`、`exited_by_actor NULL`；`CHECK ((status='exited') = (exited_at IS NOT NULL))`；`updated_at`；`IDX(branch_id, status)`。该行也是名额与名单操作的**串行化锁点**（`SELECT … FOR UPDATE`）。

**`activity_plan_owners`**（负责人名额）：主键 `(plan_id, branch_id, slot_no)`，`slot_no IN (1,2)`；`owner_actor VARCHAR(128) NOT NULL`、`owner_user_id BIGINT NULL`、`owner_display_name VARCHAR(100) NULL`；`claimed_at`、`claimed_via IN ('import','replace')`、`claimed_batch_id BIGINT NULL`（FK → `import_batches`）；`UQ(plan_id, branch_id, owner_actor)`；FK `(plan_id, branch_id)` → `activity_plan_branches`。行存在即占用；释放 = 删除该行并写变更记录（历史在 `activity_plan_changes`，名额表只保当前态）。

**`activity_plan_roster`**（名单项 = 计划 × 账号）：

| 列 | 说明 |
|---|---|
| `roster_entry_id BIGINT PK` | |
| `plan_id`、`platform_id` | 复合 FK `(plan_id, platform_id)` → `activity_plans(plan_id, platform_id)`：**数据库保证名单项的平台等于计划平台** |
| `account_id BIGINT NOT NULL` | 复合 FK `(account_id, platform_id)` → `external_accounts` |
| `branch_id`、`store_id`、`staff_id` | FK → `branches`、`stores`、`media_staff`（RESTRICT）；`branch_id` 是**加入名单当时**门店所属分公司，用于可见范围；之后门店换板块不改它 |
| `entry_state VARCHAR(16) NOT NULL` | `in_roster` / `removed` |
| `added_at`、`added_by_actor`、`added_batch_id`（FK → `import_batches`） | |
| `removed_at`、`removed_by_actor`、`removed_reason` | `removed_reason IN ('manual_remove','branch_exit')`；`CHECK ((entry_state='removed') = (removed_at IS NOT NULL))` |
| `updated_at` | |

约束 / 索引：`UQ(plan_id, account_id)`（恢复原行，不新增第二行）；`IDX(plan_id, branch_id, entry_state)`；`IDX(account_id, entry_state)`（引用计数）；`IDX(staff_id)`。

**名单项只在账号解析成功后创建**：账号层的失败（归属冲突、入口无效、技术失败）只留在 `import_row_results`，不进名单（A §11.6：链接无效不建账号；归属冲突拒绝）。这样名单里永远没有「半成品」状态，也不需要「待解析」这个名单状态（AP-D01）。

**`activity_plan_changes`**（变更记录，页面第 ⑤ 标签）：`change_id PK`；`plan_id`（FK RESTRICT）；`branch_id NULL`；`event_type VARCHAR(48)`；`actor VARCHAR(128)`；`occurred_at`；`detail JSON NULL`（仅关键字段，不含整行原文）；`IDX(plan_id, occurred_at)`。随计划一起清除。它与审计日志并存：审计面向安全追溯（仅超管，B §11），变更记录面向业务查看。

### 6.2 对既有表的修改

| 表 | 修改 |
|---|---|
| `staff_account_assignments` | 增加 `unreferenced_since DATETIME(6) NULL`；增加 `IDX(watch_type, monitoring_enabled, unreferenced_since)`（每日扫描） |
| `import_batches` | `status` CHECK 增加 `resolving`；增加 `submitter_branch_id BIGINT NULL`（FK → `branches`，仅 roster）与 `IDX(plan_id, submitter_branch_id)`；增加 `CHECK (import_kind <> 'roster' OR plan_id IS NOT NULL)`；`plan_id` **不加外键** |
| `import_row_results` | `precheck_class` CHECK 增加 `new_staff`；`outcome` CHECK 增加 `pending_account`、`suspected_empty`、`resolve_failed`；增加 `resolve_task_id BIGINT NULL`（FK → `sync_tasks`，`ON DELETE SET NULL`，与 `parent_task_id` 同一做法）与 `IDX(resolve_task_id)` |

**roster 批次的 `summary` 形状**（与 master-data 的 `BatchSummary` 互不兼容，查询按 `import_kind` 分开）：

```json
{
  "mode": "roster",
  "plan_id": "…", "plan_name": "（快照）", "platform": "douyin", "brand_code": "（快照）",
  "template_version": "roster-import.v1",
  "precheck": { "new": 0, "new_staff": 0, "update": 0, "unchanged": 0, "error": 0,
                "possible_new_accounts": 0, "plan_entries_now": 0, "plan_entries_after": 0,
                "soft_cap_exceeded": false },
  "confirm": { "imported": 0, "unchanged": 0, "conflict": 0, "invalid": 0,
               "suspected_empty": 0, "resolve_failed": 0, "pending_account": 0,
               "staff_created": 0, "owner_claimed": false }
}
```

`plan_name` 与 `platform` 是写入时的**快照**：计划被清除后批次仍能自描述。

### 6.3 对 v2 / 上游文档的修订清单（任务 0）

| # | 目标 | 内容 |
|---:|---|---|
| R1 | v2 | 新增 §13「活动计划」：六张新表（§6.1）；开头第 10 条改为已定义；概述表数口径 +6 |
| R2 | v2 §8.3 | `unreferenced_since`；说明 `unreferenced_15d` 沿用为「因无计划引用而关闭」 |
| R3 | v2 §9.8 | `resolving`、`submitter_branch_id`、roster 必填 `plan_id` 的 CHECK；说明 `plan_id` 不加外键的原因 |
| R4 | v2 §9.9 | `new_staff`、三个新 `outcome`、`resolve_task_id` |
| R5 | A §11.2.2 | 第一层「表头行检测 → 拒绝」改为「表头必须存在并逐列一致，自动跳过；与模板示例行相同的行标为示例行」，并注明依据 F-D10 |
| R6 | A §11.9 | 第 5 条核对引用定义（A v1.10 已改正文） |
| R7 | CONTEXT | 增加 Participation、PlanOwner、Roster 三条词汇 |
| R8 | INDEX | 登记（本次初建已完成）；随状态更新 |

### 6.4 状态与枚举

```text
活动计划：collecting ⇄ paused；collecting ⇄ archived；任一 → deleted → （30 天内）status_before_delete
参与关系：joined ⇄ exited（exited 再加入回到 joined）
名单项  ：in_roster ⇄ removed（removed 经重新提交恢复）
批次    ：prechecking → awaiting_confirm → writing → resolving → completed
          prechecking → precheck_failed；writing/resolving 的基础设施中止 → failed（可续跑）
行      ：precheck_class ∈ new | new_staff | update | unchanged | error
          outcome ∈ NULL | pending_account | imported | unchanged | conflict | invalid | suspected_empty | resolve_failed
```

## 7. Algorithms

### 7.1 预检：行分类优先级

固定顺序，首个命中即停。`reason_code` 为 snake_case、无前缀（对齐 master-data）；`reason_detail` ≤ 1024。

| # | 检查 | 命中 → |
|---:|---|---|
| 1 | 四列均非空（去首尾空白后） | `error` / `required_missing`（detail 写缺哪列） |
| 2 | 手机号规范化（§7.2）；专员姓名 ≤ 100 字；主页链接 ≤ 2,048 | `phone_invalid` / `name_too_long` / `locator_too_long` |
| 3 | 门店按 `(plan.brand_id, 门店编码)` 精确匹配（编码去首尾空白，字节比较） | 未命中：`store_not_found`；该编码存在于操作者**品牌范围内**的另一品牌：`store_brand_mismatch`（范围外的品牌一律报 `store_not_found`，不泄露） |
| 4 | 门店 `status='active'` | `store_closed` |
| 5 | 门店板块种类 ∈ 计划板块 | `store_sector_not_in_plan` |
| 6 | 门店所属分公司 ∈ 操作者分公司范围（范围为「全部」则通过） | `store_branch_not_authorized`（提示联系管理员） |
| 7 | 该分公司在本计划为 `joined` | `branch_not_joined` |
| 8 | 手机号在有效专员中：属于**另一**门店 | `phone_belongs_to_other_store`（提示联系超管） |
| 9 | 同门店存在同号**已停用**专员 | `staff_inactive_restore_needed`（提示联系总部或超管恢复原专员；本 spec 不新建第二条） |
| 10 | 链接是视频 / 笔记：`classifyLocator`（纯函数，复用 tracer）返回 `reject` | `non_home_locator`（回流文案：不是主页链接） |
| 11 | `checkLocatorPlatform(plan.platform)`：域名属于另一平台 → `platform_mismatch`（**不默认成抖音**）；入口含 URL 但域名不属于任何支持平台（用 `detectLocatorPlatform`，见 §10.2）→ `platform_unrecognized` | `platform_mismatch` / `platform_unrecognized` |
| 12 | 文件内重复（对通过 1–11 的行成组判断，整组报错） | 同手机号两行：`duplicate_phone_in_file`；同手机号不同姓名：`phone_name_conflict_in_file`（优先于前者）；同一清洗后入口两行：`duplicate_locator_in_file` |
| 13 | 本地账号命中（§7.3）+ 名单项状态 | 见下 |

> 步骤 10–11 是本地能做的**全部**链接判断：`classifyLocator` 对没有 URL 的文本（纯分享口令）一律 `send/unknown`，无法本地识别，放行交供应商判断；对含 URL 的入口，`PLATFORM_DOMAINS` 已含各平台的短链域名（`xhslink.com`、`v.kuaishou.com` 经 `kuaishou.com`、`v.douyin.com` 经 `douyin.com`），所以「含 URL 但域名不属于任何平台」可以安全地判错，对应 A §11.2.2 第二层「域名识别不出 → 错误」。A 第三层的「链接格式不认 → 链接格式错误」**没有本地实现**：认不出的纯口令由供应商判断，落为解析后的 `invalid`（`result_validation_exhausted`）。这是对 PRD 第三层的如实收窄，已列入 §14 第 11 项。

第 13 步分支：

```text
专员已存在 且 本地命中账号 且 该账号在本计划名单 in_roster 且专员一致 → unchanged / already_in_roster
专员已存在 且 本地命中账号 且 该账号在本计划名单 removed 且专员一致   → update   / restore_roster_entry
本地命中账号 且 账号当前归属他人                                     → new（专员已存在）或 new_staff，reason_code=known_account_other_owner（提示：确认后将成为归属冲突）
本地命中账号 且 专员一致 但不在本计划名单                             → new，reason_code=known_account_same_owner
专员不存在                                                            → new_staff
其余                                                                  → new
```

「同一专员在同一平台已有另一个账号」**不在预检拒绝**：专员已有账号 A1（入口 L1），本行用同一账号的另一种链接文本 L2，真实结果应是「已存在并引用」；若预检按文本不同就拒绝会误杀。该冲突交给解析后的 `intakeAccount`（落为 `conflict` / `staff_platform_slot_taken`），代价是多花一次主页调用，罕见。

批次级检查（在内存里完成，**任一失败不建批次**）：「将新建专员」> 1,000（可配置，`MAX_NEW_STAFF`）→ `too_many_new_staff`。

### 7.2 手机号规范化 `cn-mobile.v1`（临时规则，待 B 对齐；B 已于 2026-11-10 把同一条规则落到 `src/modules/phone`，A 实施时改为引用它）

```text
1. 去首尾空白；删除所有空格、'-'、不间断空格(U+00A0)
2. 若以 '+86'、'0086' 开头，去掉；否则若恰为 13 位且以 '86' 开头，去掉前两位
3. 必须匹配 ^1[3-9]\d{9}$，否则 phone_invalid
```

Excel 把手机号当数字时常变成科学计数法（`1.38E+10`），按第 3 步判无效并在回流文案里提示「先把列设为文本」。规范化后的值是 `media_staff.phone` 的唯一比较值；行结果 `raw_row` 保存原文。实现位于 `src/modules/phone/`，与 `b-access-control` 共用同一个函数（AX-D18）。

### 7.3 主页入口与本地账号命中

- 清洗：`classifyLocator(original).cleaned`——保留前缀分享文案、只截掉第一个 URL 之后的字符；没有 URL 的文本原样返回。tracer 把原文写进 `current_home_locator`、清洗值（`pair.locator`）写进 `resolved_home_url`，所以两个哈希都要查；
- 命中：在 `staff_account_assignments` 里按 `(platform_id, resolved_home_url_sha256)` 或 `(platform_id, current_home_locator_sha256)` 查；**哈希命中后复核原文**（工作区纪律：外部 ID 与入口文本按原文比较，哈希只是索引）；
- 命中不会替代账号 ID 判重：它只用来**省掉一次付费的主页调用**。没命中的行照常调用，由 `intakeAccount` 按账号 ID 最终裁判；
- 纯分享口令、没出现过的短链无法本地命中，通常要调用一次；**同一入口文本再次提交**（例如上次导入过同一短链）则 `current_home_locator` 哈希可以命中，不再调用。

### 7.4 负责人名额占用

在确认写入的第一个短事务里（取租约之前）：

```text
lock activity_plan_branches(plan, branch) FOR UPDATE
if actor.branchScope == "all"                 → 不占用（总部 / 超管豁免）
if actor ∈ owners(plan, branch)               → 不占用
possibly_new = count(rows: precheck_class ∈ {new,new_staff} 且 reason_code ∉ {known_account_same_owner, known_account_other_owner})
if possibly_new == 0                          → 不占用
if |owners| >= 2                              → 抛 owner_slots_full {owner names}   （零写入）
else INSERT 最小空槽, change: owner_claimed
```

- 提交人的分公司即 `import_batches.submitter_branch_id`；
- 占用发生在写入前并持久化；之后确认中断续跑不重复占用（`actor ∈ owners`）；
- 并发：两个提交都先锁同一个参与关系行，后者看到前者已占用的结果；
- 已知偏差（requirements §1.4 第 7 项）：一批全是已存在账号但入口文本不同，也会占用；创建者或超管可替换；`ponytail:` 注释标明上限，升级路径是「解析完成后再按实际新建数结算并回收」，代价是名额检查不能再在写入前整批失败。

### 7.5 确认写入

沿用 `master-data-import/confirm.ts` 的写法（租约、fencing、块边界、SAVEPOINT），差异如下。

1. **前置检查**（零写入，失败直接返回）：批次存在且 `import_kind='roster'`，操作者能看到该批次（范围外 = 未找到）；状态为 `awaiting_confirm` 或 `writing`（可续跑）；`resolving` / `completed` 返回「已确认」结果；计划 `collecting`；分公司 `joined`；`capabilityGate.require({platform, action:'media_user_info', mode: config.modes.media_user_info, environment})` 放行；名额检查（§7.4）。
2. **取租约**：同 master-data：`writing_token` 是 fencing token，心跳超过 2 分钟视为陈旧才可接手，每块事务开头 `FOR UPDATE` 核对 token。
3. **同步批次**：整个导入批次共用一个 `sync_batches` 行（`purpose='intake'`、`trigger_type='manual'`、`batch_key` 由导入批次 ID 推出，唯一，所以续跑不重复创建），用于成本预算与状态聚合。
4. **块**（默认 200 行）：一个事务内——`FOR SHARE` 锁计划行并复核 `collecting`（暂停会等块提交，下一块即看到并中止）；取 `outcome IS NULL AND precheck_class IN (new,new_staff,update,unchanged)` 的行；对每行用**实时**引用读取器重分类，与预检类不一致记 `conflict / precheck_stale`；
   - `new_staff`：`INSERT media_staff` 放进 SAVEPOINT，遇 `ER_DUP_ENTRY`（`active_phone`）回滚到保存点，行记 `conflict / staff_phone_conflict`；成功写审计 `staff_created`，回填行的 `staff_id`；
   - 本地命中账号：同专员 → 写或恢复名单项、`outcome=unchanged`（reason `restored_roster_entry` / `already_in_roster` / `existing_account_referenced`）；他人 → `outcome=conflict / assignment_conflict`，不调用；
   - 未命中：`submitRoster`（§10）在**同一事务**里创建根任务，`outcome=pending_account`，回填 `resolve_task_id`；
   - 块内已归并的账号集合，在同一事务末尾调用 `reconcileAccounts`（`trigger='import'`）；
   - 块尾更新心跳。
5. **收尾**：核对 token；按 `outcome` 聚合写 `summary.confirm`；`status = pending>0 ? 'resolving' : 'completed'`；写 `confirmed_by_actor` / `confirmed_at`；写审计 `roster_batch_confirmed`。
6. 超时、续跑、`lease_lost`、重复确认的语义与 master-data 一致（MD-7）。

### 7.6 解析驱动与结果归并

```text
resolver.runOnce({ limit, concurrency, deps }):
  rows = pending_account 行，批次 status='resolving'，按 (批次 ID, 行号) 升序，limit 条
  对每行（有界并发）：
     run = runTracerRoot(tracerDeps, row.resolve_task_id)
     if run.kind ∈ {succeeded, blocked, failed, cancelled, already_terminal} → settle(row)
     else（busy / stale / retry_wait）→ 留待下个 tick
  对 pending=0 的 resolving 批次 → finalize(batch)

settle(row)   -- 一个短事务
  锁批次行；若 row.outcome 已不是 pending_account → 返回（幂等）
  读根任务：status、stop_reason、result_summary.entry_outcome、result_summary.account_created、account_id
  锁计划行(FOR SHARE) + 参与关系行：计划非 collecting 或分公司非 joined → outcome=conflict / plan_state_changed，结束
  按下表映射；成功分支：upsert 名单项 → 开启账号并清起点 → reconcileAccounts(trigger='import') → 审计
  更新 outcome / reason / account_id；更新批次 summary 计数

finalize(batch)
  summary.confirm 重算；status='completed'
  对 outcome=unchanged 且有 account_id 的账号：supplement({accountIds, only:'full', ifOlderThanHours:168, apply:true, idempotencyKey:'roster-refresh:<批次ID>'})
```

**映射表**（`code`：根任务终态字段来自 `finishRoot`）：

| 根任务 `status` | `stop_reason` | `entry_outcome` | `summary.account_created` | 行 `outcome` / `reason_code` |
|---|---|---|---|---|
| succeeded | — | `normal` | true | `imported` |
| succeeded | — | `normal` | false | `unchanged` / `existing_account_referenced` |
| succeeded | `suspected_empty` | `suspected_empty` | 任意 | `suspected_empty` |
| failed | `assignment_conflict` | — | — | `conflict` / `assignment_conflict` |
| failed | `staff_platform_slot_taken` | — | — | `conflict` / `staff_platform_slot_taken` |
| failed | `invalid_link` | `invalid_link` | — | `invalid`，`reason_code` 取根任务 `last_error_code`（`non_home_locator` / `platform_mismatch` / `result_validation_exhausted`） |
| failed / dead / cancelled | 其他 | — | — | `resolve_failed` / `root_failed` 或 `root_cancelled`，detail 写错误类别 |

- **疑似空账号**：账号与名单项照常创建，监控开关保持开启；是否采集由 `intake_status` 门控（实际监控 = 开关开 ∧ 上级链有效 ∧ `normal`），所以不会被采集，直到 AP-10 的人工确认；
- **没有 `summary.account_created`**：这是现有根任务不写的字段，§10 要求补上；缺失时（旧根任务）按 `external_accounts.first_seen_at >= 根任务创建时间` 兜底判断；
- **根任务已被清理**：`resolve_task_id IS NULL`（一年保留期后 `SET NULL`）而行仍是 `pending_account` → 落为 `resolve_failed / root_expired`；
- **幂等**：settle 只处理 `outcome='pending_account'` 的行；名单项 `UQ(plan_id, account_id)`；重复运行不产生第二份结果；
- **不自动重试**技术失败；业务改回流文件后作为新文件重传，产生新批次、新根任务（幂等键含新批次 ID）。

驱动的并发、限流、熔断、预算全部走 sync worker 现有的同一套（`a-full-sync` FS-16）；它**不**绕过 capability gate，gate 在 `submitRoster` 与 `runTracerRoot` 内各检查一次。吞吐量按现网限速（QPS≈2）估算：2,000 行约需 17 分钟以上，行结果会持续从 `pending_account` 变成终态，页面（将来）显示「解析中 N」。

### 7.7 引用计数与联动：`reconcileAccounts`

唯一的实现点，位于 `plan-references`。

```ts
type ReconcileCtx = {
  now: Date;
  trigger: 'import' | 'explicit_remove' | 'plan_state' | 'scan' | 'manual_enable';
  mode: 'immediate' | 'timer';        // immediate：引用为 0 时立即关；timer：只记起点
  since?: Date;                        // 显式给出的无引用起点（缺省 now；scan 用 computeStopAt）
  resetSince?: boolean;                // manual_enable：无条件把起点重置为 now
};
reconcileAccounts(tx, accountIds: bigint[], ctx): Promise<ReconcileReport>
```

对每个账号（`SELECT … FOR UPDATE` 归属行；按 `account_id` 升序加锁，避免死锁）：

```text
跳过：无归属 | watch_type='external'
everInRoster = EXISTS(roster 项，任意状态)
若 !everInRoster 且 trigger != 'import'：跳过   // 保护 tracer/运维直接提交的账号

refs = COUNT(roster 项 in_roster ∧ plan.status='collecting' ∧ (ends_on IS NULL ∨ ends_on >= today_bjt))

若 refs > 0:
   unreferenced_since = NULL
   若 monitoring_enabled=false ∧ reason='unreferenced_15d' → 重开(enabled=true, reason=NULL)  审计 monitoring_reopened_on_reference
   若 trigger='import' 且 monitoring_enabled=false ∧ reason='manual' → 重开 + 审计 monitoring_reopened_by_import(previous_reason='manual')   // 已接受风险
   若 trigger='import' 且 monitoring_enabled=true → 仅清起点
否则 (refs = 0):
   若 resetSince 或 unreferenced_since IS NULL → unreferenced_since = ctx.since ?? now
   若 monitoring_enabled ∧ (mode='immediate' ∨ unreferenced_since + 15 天 <= now):
        monitoring_enabled=false, reason='unreferenced_15d'；审计 monitoring_closed_unreferenced
```

- **事件到参数的映射**：

| 事件 | trigger / mode |
|---|---|
| 解析成功归并、本地命中归并 | `import` / （refs>0 必然成立） |
| 单条或批量移出、分公司退出、计划删除 | `explicit_remove`（删除用 `plan_state`）/ `immediate` |
| 计划暂停、归档 | `plan_state` / `timer`（`since=now`） |
| 计划恢复、从回收站恢复 | `plan_state` / `timer` |
| 改结束日 | `plan_state` / `timer`，`since=computeStopAt`（缩短到过去时，起点是「结束日次日北京时间 00:00」，不是编辑时刻；延长使引用恢复时走「重开」分支） |
| 每日扫描 | `scan` / `timer`（`since=computeStopAt`） |
| `monitoring set` 手动开启 | `manual_enable` / `timer`（`resetSince`） |

- `computeStopAt(account)`：账号全部名单项（含已移出）各自「不再被引用的时刻」的最大值——计划已删除取 `deleted_at`；暂停 / 归档取 `status_changed_at`；采集中但已过结束日取「结束日次日北京时间 00:00」换算 UTC；已移出项取 `removed_at`；无项时取 `now`。这样「自然到期」的计时从到期日启动（A §11.5），而不是从扫描那天启动；
- **幂等**：同一事件重复调用，后续调用在 `refs` 与状态不变时不写、不审计；
- **一个事务处理 ≤ 10,000 个账号**（单计划的账号数一般 ≤ 1,200）；`ponytail:` 超过时分块并在计划上记 `reconcile_pending`，由每日维护补跑，目前不需要；
- **上级关闭优先**：本函数不读上级开关；账号即使引用数 > 0 也不会因本规则打开上级。实际是否采集仍由 `monitoring.explain` 决定。

### 7.8 每日维护

```text
planMaintenance.runDaily(now):
  北京时间 < 04:00 或 今日已成功 或 退避中 → 不运行
  step "scan_unreferenced":
     候选 = 归属型 ∧ 监控开关开 ∧ everInRoster ∧ 引用数=0 的账号（分块 500）
     reconcileAccounts(chunk, {trigger:'scan', mode:'timer', since: computeStopAt})
  step "purge_trash":
     计划 status='deleted' ∧ purge_after <= now，逐个：
        ① downstream.purge(planId)        —— 事务之外（可能是跨域调用，不得持有数据库事务）；幂等
        ② 失败 → 本次不清除、计划行保留，记审计，下次维护重试
        ③ 成功 → 一个事务内按 FK 顺序 changes → roster → owners → branches → sectors → plan
        （这是显式 DELETE，不是级联；import_batches / row_results / 账号 / 归属 / 专员 / 门店不动）
        崩溃在 ① 与 ③ 之间：计划行仍在，下次再调 ①（幂等）再删
  每步独立 try/catch；失败入 failedSteps；失败退避 10 分钟重试
```

- 与 `maintenance.ts` **分开**：后者构造时必须有 OSS `store`，没有 OSS 配置时整个禁用，不能连带禁用 15 天停采（AP-D15）。两者都挂在 `runForever` 的 `extras` 里，各自幂等；
- `lastDoneDay` 在进程内，重启当天可能再跑一次；两步幂等，所以无副作用；
- 手动命令 `plan maintain` 立即运行一轮。

### 7.9 删除、恢复与清除

- **预览**：返回 `{ plan, downstream: summarize(planId), roster: {in_roster, accounts_to_close}, apply: false }`；`accounts_to_close` 是「只被本计划引用」的账号数；
- **执行**（`--apply`，一个事务）：锁计划行；`summarize.running > 0` 则拒绝；写 `status='deleted'`、`status_before_delete`、`deleted_at`、`purge_after = deleted_at + 30 天`；`reconcileAccounts(本计划名单账号, {trigger:'plan_state', mode:'immediate'})`；变更记录；事务提交后 `downstream.onDeleted`（失败只记日志与审计，不回滚：D/E 侧的回收站标记可由它们自己的每日维护补齐，契约见 §10.4）；
- **恢复**：`now < purge_after`；`status = status_before_delete`；清空删除字段；`reconcileAccounts(…, {trigger:'plan_state', mode:'timer'})`（引用恢复 → 重开因无引用关闭的账号）；`downstream.onRestored`；
- **清除**：§7.8；
- 回收站内的计划不出现在任何业务查询、名单读取、批次查询中：所有读路径统一走 `visiblePlans(actor)`，它过滤 `status <> 'deleted'`；回收站列表是唯一例外且只给创建者与超管。

### 7.10 综合账号状态（读取时计算）

纯函数 `composeStatus(facts)`，按 A §11.6 优先级取第一条命中：

| 优先级 | 条件 | 显示 |
|---:|---|---|
| 1 | 行级：`outcome='invalid'` | 链接无效 |
| 2 | `intake_status='suspected_empty'` | 疑似空账号 |
| 3 | `monitoring.explain` 排除原因为分公司 / 经销商 / 门店 / 专员关闭 | XX 被关闭（取最上级）；对应「已停用 / 已撤店」的原因显示为业务状态文案（`staff_inactive` → 专员已停用，`store_closed` → 门店已撤，`brand_inactive` → 品牌已停用，`region_inactive` → 大区已停用，`branch_inactive` / `dealer_inactive` 同理），属显示扩展；`explain` 返回的全部排除原因都必须有文案（遗漏使测试失败） |
| 4 | 账号自身开关关闭 | 被停止监控（附原因：人工 / 无引用） |
| 5 | 名单项 `removed` | 已移出活动计划 |
| 6 | 否则 | 正常采集 |

三个维度（录入状态、名单状态、监控状态）各自存储，**不合成一列存**。

## 8. Failure semantics

| 场景 | 行为 |
|---|---|
| 文件级校验失败 | 不建批次；结构化错误（含文件名、失败项、样本） |
| 计划非 collecting / 分公司未加入（预检） | 不建批次；`plan_not_collecting` / `branch_not_joined` |
| 将新建专员 > 1,000 | 不建批次；`too_many_new_staff` |
| 预检中途数据库异常 | 批次置 `precheck_failed`，已写行保留；重传得到新批次 |
| capability 未放行（确认） | 零写入；`unsupported_capability` |
| 名额已满（确认） | 零写入；`owner_slots_full`（带现有负责人） |
| 预检后计划被暂停 / 删除 | 确认被拒绝；写入中则下一块中止，已写行保留，批次停在 `writing`，恢复计划后可续跑 |
| 确认进程崩溃 | 批次停在 `writing`；心跳陈旧后续跑；专员 / 根任务 / 行结果不重复 |
| 旧进程被接手 | 下一块 `lease_lost`，零写入 |
| 专员新建遇手机号唯一键冲突 | 该行 `conflict / staff_phone_conflict`，其余行继续 |
| 根任务技术失败 | 行 `resolve_failed`；不自动重试；批次仍可 `completed` |
| 解析驱动崩溃 | 根任务由租约接手；settle 幂等 |
| 解析时计划已暂停 / 分公司已退出 | 行 `conflict / plan_state_changed`，不建名单项；账号与归属已由根任务建立，保留（停用不删除） |
| 分公司退出时仍有 `pending_account` 行 | 这些行的根任务照常跑完；settle 时发现分公司已退出，落为 `conflict / plan_state_changed`，不建名单项 |
| 下游端口失败（删除 / 恢复） | 本 spec 的事务已提交；失败写审计；`onDeleted` / `onRestored` 是**加速通知**，真相是 `activity_plans.status`，D / E 必须能据此自行对账（`reader.statusOf(planId)`），所以不需要本 spec 再设重试载体 |
| 下游 `purge` 失败 | 计划行保留，下次维护重试；`purge` 在数据库事务之外调用 |
| 每日维护某步失败 | 另一步不受影响；退避重试 |
| 授权失败 | 读库之前拒绝；越范围对象表现为未找到 |
| 并发抢名额 | 参与关系行锁串行化，后者得到 `owner_slots_full` |

**不吞错**：任何路径都不把技术失败写成「链接无效」「疑似空账号」或空名单；`resolve_failed` 与 `invalid` 是两个不同的结果。

## 9. Authorization seam

```ts
interface PlanActor {
  actor: string;                         // 审计主体，如 service:plan-cli
  capabilities: ReadonlySet<string>;
  brandScope: ReadonlySet<string> | "all";     // 品牌编码
  branchScope: ReadonlySet<bigint> | "all";    // 分公司 ID；hq / 超管为 "all"
  platformAdmin: boolean;                // 创建者谓词的超管旁路，显式声明，缺省 false
}
```

- 授权入口 `assert(actor, capability, resource)`：先 Capability，再 actor 自带的品牌 / 分公司范围，这两步先于任何数据库读取；再读计划行判断资源谓词（创建者、对象状态），读发生在任何业务写入之前（越权对象表现为未找到）；业务模块**只**调它；
- **与 B 的关系**：`assert` 是本模块的入口，不是第二个独立的授权体系。[`b-access-control`](../b-access-control/design.md) 落地后，`assert` 的 Capability / 范围 / 谓词判定委托给 B 的 `authorize`（`activity_plan` 注册为 `ScopeStrategy`，创建者与分公司判断注册为谓词 `plan_creator` / `plan_branch`），`assert` 退化为一层薄封装；B 的「唯一授权入口」措辞因此成立；
- 创建者谓词：`plan.created_by_actor === actor.actor || actor.platformAdmin`；
- 名额豁免：`branchScope === "all"`；
- CLI 身份来自环境变量，缺任一启动失败：`HBECHO_AP_ACTOR`、`HBECHO_AP_CAPABILITIES`、`HBECHO_AP_BRAND_SCOPE`（`all` 或品牌编码，逗号分隔）、`HBECHO_AP_BRANCH_SCOPE`（`all` 或分公司编码，逗号分隔，启动时解析成 ID）、`HBECHO_AP_PLATFORM_ADMIN`（`true` / `false`，缺省 `false`）；
- 解析驱动与每日维护使用固定服务身份 `service:plan-worker`，不经用户范围；
- B 接入时：`PlanActor` 由会话构造（[`b-access-control`](../b-access-control/design.md) §9.1 的 `toPlanActor`，规范主体 `user:<id>`），`created_by_user_id` 回填，`assert` 内部改读 B 的 DataScope；调用方不变。

### CLI 命令

```text
plan create | edit | show | list | pause | archive | resume | delete [--apply] | restore | trash
plan branch join | exit [--apply]
plan owner list | assign | replace [--apply]
plan roster template | precheck | confirm | batches | batch | rows | report | list | remove [--apply]
plan account confirm-empty
plan resolve --once
plan maintain
```

输出 JSON；BIGINT 十进制字符串；退出码沿用 master-data 约定（0 / 2 / 3 / 4 / 5 / 1）；`parseArgs` strict；没有 `--force`、`--skip-auth`。

## 10. 对既有代码与依赖的改动

### 10.1 抽取 `csv-file`

把 `master-data-import/file-parser.ts` 的 `decode`、`printableSample` 与 CSV 解析（`csv-parse` 严格选项），以及 `return-file.ts` 的 `csvCell`、BOM、CRLF 写法，移到 `src/modules/csv-file/`。`HEADER`、`parseFile`、`buildReturnFile` 保留为 master-data 自己的薄封装，**行为不变**，既有测试保持绿（先改封装、再抽取）。不新增依赖。

### 10.2 tracer / orchestrator

| 改动 | 内容 |
|---|---|
| `TracerCommands.submitRoster(tx, items)` | 在传入事务里批量创建根任务：共享一个 `intake` 同步批次（`batch_key` 由导入批次推出）；每项幂等键 `roster:<导入批次>:<行号>`；canonical command 用新 schema `roster-resolve.v1`（平台、专员、入口原文、导入批次、行号），不与 `data-foundation-tracer-command.v1` 碰撞；`taskParameters.profile_only=true`。把现有 `insertOrReuse` 的批次创建拆成可传入已有批次 ID |
| `runTracerRoot` | `profile_only`：在 `isExternal` 分支旁增加同类分支——主页快照写完即以 `entryOutcome:'normal'`、`stopReason:'profile_only'` 终止，不建列表子任务；**仍检查 D-69 名额与归属冲突**（外部分支不检查） |
| `finishRoot` 调用点 | 成功终态的 `summary` 增加 `account_created`、`assignment_created`（来自 `IntakeResult`），疑似空账号终态同样补上 |
| `provider-adapter/locator.ts` | 导出纯函数 `detectLocatorPlatform(original): Platform \| "no_url" \| null`（`null` = 含 URL 但域名不属于任何平台），复用现有 `PLATFORM_DOMAINS` 与 `platformOfHost`；不改 `classifyLocator` / `checkLocatorPlatform` 的行为 |
| 不改 | 判重、归属冲突、名额冲突的裁判；`eligibility`（sync worker 仍不领取 `resolve_account`，根任务由本 spec 的驱动进程内运行） |

### 10.3 monitoring 与 sync

| 改动 | 内容 |
|---|---|
| `monitoring/set-switch.ts` | 账号级**开启**时调用 `plan-references.markGrace(tx, accountId, now)`（引用数为 0 且出现过名单项时，把 `unreferenced_since` 重置为现在）。账号级关闭不变（仍写 `manual`） |
| `sync-wiring.ts` / `sync-main.ts` | `runForever` 的 `extras` 增加 `resolveRosters`（名单解析驱动）与 `planMaintain`（计划每日维护）；装配时共用 `buildSyncApp` 里的网关与护栏 |
| 静态护栏 | `acceptance-boundaries.test.ts`：① `activity-plan` 目录的 `*.db.test.ts` 加入 `Promise.all` 扫描；② 对 `unreferenced_since` 列和 `monitoring_closed_reason='unreferenced_15d'` 的**写赋值**只允许出现在 `plan-references`（扫描范围是 `src/modules/**` 的非测试文件，**排除** `src/db/schema/` 与 `drizzle/`——schema 与迁移里本来就有这个取值的 CHECK；匹配的是写位置，如 `set({… unreferencedSince …})`、`monitoringClosedReason: "unreferenced_15d"`，不是任意出现）；并配一条反向用例：往扫描范围内放一个故意违规的临时文件，护栏必须报错；③ `activity-plan` 不得调用 `insertDemandTask` |

### 10.4 下游端口（D / E 未建）

```ts
interface PlanDownstream {
  summarize(planId: bigint): Promise<{ judgementPlans: number; results: number; running: number }>;
  onDeleted(planId: bigint): Promise<void>;
  onRestored(planId: bigint): Promise<void>;
  purge(planId: bigint): Promise<void>;
}
```

默认实现 `noDownstream`：全部返回 0 / 空操作。D / E 落地时实现并在装配处替换。端口契约：`onDeleted` / `onRestored` / `purge` 必须幂等；`purge` 在数据库事务之外调用，失败时本 spec **不**清除计划（下次维护重试）；`onDeleted` / `onRestored` 只是加速通知，D / E 以 `activity_plans.status` 为准对账。**契约测试**用一个记录调用顺序的 fake 验证本 spec 的调用时机。

### 10.5 命名与依赖

- 无新依赖；GB18030 仍用 `TextDecoder`；
- CLI 脚本 `package.json` 增加 `"plan": "tsx src/worker/plan-main.ts"`；
- 迁移文件 `drizzle/NNNN_activity_plan_*.sql`，`drizzle-kit generate` 生成，`verify.sh` 第 4 步守护；
- fixture：`tests/fixtures/roster/`（脱敏造数，`README.md` 说明），不复制真实 xlsx。

## 11. Testing strategy

| 层 | 内容 |
|---|---|
| `unit`（纯函数） | 手机号规范化；预检分类（逐码一个用例，含优先级冲突组合）；文件内重复分组；入口命中分支；根任务终态映射；`composeStatus`；`computeStopAt`；引用定义与日期边界（结束日当天仍算引用）；模板示例行识别；回流文件转义 |
| `db`（真实 MySQL） | 计划状态机与冻结语义；参与加入 / 退出 / 重新加入；名额占用、已满、豁免、替换、释放；预检零业务写入；确认租约 / 续跑 / `lease_lost` / 重复确认；专员新建与唯一键冲突；根任务批量创建与幂等；settle 全部映射；`reconcileAccounts` 全部事件矩阵；每日维护；删除 / 恢复 / 清除；越范围查询；`rosterSnapshot`；CHECK 与复合外键（平台不一致的名单项被数据库拒绝） |
| 驱动 | fixture transport + `FakeClock` 跑完一批：六种结果各一行；崩溃重启；`busy` / `retry_wait` 留待下个 tick |
| 契约 | 下游端口调用顺序；`rosterSnapshot` 形状 |
| 静态 | §10.3 三条护栏；`drizzle-kit generate` 无新文件 |
| 离线 | `network-deny` 沿用；无真实供应商 |

- **名额并发**不用 `Promise.all`：先启动持锁者并让它停在 hook，再启动竞争者（它必须阻塞于参与关系行锁），最后放行持锁者，断言恰好一个成功；
- 每个 db 测试前 `resetData`；`tests/harness` 需要补 `insertStore` / `insertStaff`（现仅 `seed.ts` 可造组织与专员）；
- 规模：2,000 行预检 / 确认 / 解析（fixture transport）与 1,200 账号的引用重算，记录耗时进入 §12（任务 12）。

## 12. Explicit non-goals and known limits

- 名额占用的已知偏差（§7.4）；
- 主页链接修改不做（§1.4 第 11 项）；
- 同一专员已有账号的冲突需要一次多余的主页调用才能发现（§7.1）；
- 解析吞吐受现网 QPS≈2 限制，2,000 行约 17 分钟以上；production capability 放行前不运行；
- 单次引用重算 ≤ 10,000 个账号（§7.7）；
- 综合状态里对「已停用 / 已撤店」的文案是显示扩展，不是 PRD 原文；
- `owner_actor` 在 B 接入前是自由文本的服务身份标识，不能证明负责人真的是该分公司的人；B 接入时补校验；
- 手机号规则是临时规则（§1.4 第 14 项）；
- 下游端口默认空实现，计划删除对 D / E 的级联在它们落地前没有实际效果；
- 回收站期满清除是显式 DELETE：计划层对象的行数（至多数千）在一个事务内删除，超过时需要分块（`ponytail:`）。

## 13. Decision records

状态列：`proposed` = 本 spec 建议；`prd` = 上游已定。**2026-11-06 刘学奎已确认全部 `proposed` 与「待确认」项按建议采纳**。

| 编号 | 决定 | 理由 | 状态 |
|---|---|---|---|
| AP-D01 | 名单项只在账号解析成功后创建；失败只留在行结果 | 名单里没有半成品状态；对齐 A §11.6（链接无效不建账号、归属冲突拒绝） | proposed |
| AP-D02 | 复用 `resolve_account` 根任务，新增 `profile_only` 与批量创建，一个导入批次一个同步批次 | 不重写判重与冲突；避免 2,000 行产生 2,000 个批次污染状态查询；成本预算按导入批次聚合 | proposed |
| AP-D03 | 入口文本本地命中时省去供应商调用 | A 要求已存在账号「不再采集」；每周补报名单会重复大量已有账号；哈希命中后复核原文 | proposed |
| AP-D04 | 名额在确认写入时按本地可知事实占用 | A 要求「整批失败」，只能发生在写入前；账号是否已存在要调用后才知道 | proposed（待确认） |
| AP-D05 | 引用与联动集中在 `reconcileAccounts`，一个函数、一个模块 | 联动事件多（导入、移出、退出、删除、暂停、到期、恢复、手动开启），分散判断必然漂移 | proposed |
| AP-D06 | 「引用从 0 变为大于 0」一律重开因无引用关闭的账号 | A 只写了计划恢复；延长结束日、恢复回收站、重新加入同属一类，派生规则最简单 | proposed（待确认） |
| AP-D07 | 名单导入重开人工关闭账号并写审计 | 沿用已接受风险（R4-01 选 B）；审计使它可见，不收紧 | prd（审计事件为本 spec 追加） |
| AP-D08 | `import_batches.plan_id` 不加外键；计划层对象期满显式 DELETE | 批次是历史事实，应比计划活得久；加 RESTRICT 外键会让清除永远失败，加 CASCADE 违反「历史事实不级联」 | proposed |
| AP-D09 | D / E 通过下游端口接入，默认空实现 | D / E 未建；删除 / 恢复 / 清除的时机必须现在就固定 | proposed |
| AP-D10 | `PlanActor` 含分公司范围；创建者谓词比较 `created_by_actor` | 现有两种 `ActorContext` 都没有分公司维度；B 接入后换构造方式不换调用方 | proposed |
| AP-D11 | 手机号规则 `cn-mobile.v1` | `media_staff` 目前没有写入代码，必须选一条；B 域未给格式 | proposed（待确认） |
| AP-D12 | 模板版本 = 表头四列逐列一致；表头自动跳过；示例行逐格相同才识别 | 4 列 CSV 没有版本单元格；采用 F-D10 | proposed（待确认，R5） |
| AP-D13 | 暂停与归档两个值、行为相同；只经「采集中」往返 | A §11.7 表格合并为一行；少一条转换边 | proposed |
| AP-D14 | 疑似空账号确认用 `data.account.manage` | B v1.8 把质量问题处置并入它；不新开 Capability | proposed（待确认） |
| AP-D15 | 计划每日维护独立于 `createMaintenance` | 后者没有 OSS 配置就整体禁用，不能连带禁用 15 天停采 | proposed |
| AP-D16 | 页面本轮不交付 | UI 基线 draft、B 未可登录、界面须经确认；对齐 MD-D18 | proposed |
| AP-D17 | 批次状态增加 `resolving` | `completed` 不能同时表示「写完」与「解析完」；批次详情要能说清「还有 N 行解析中」 | proposed |
| AP-D18 | 解析驱动跑在 sync worker 进程，共用网关与护栏 | 付费调用只能有一套限流、熔断与预算；另起进程会绕开 | proposed |
| AP-D19 | 引用重算单事务 ≤ 10,000 账号 | 计划规模一般 ≤ 1,200；分块 + `reconcile_pending` 现在是过度设计 | proposed |
| AP-D20 | 变更记录表与审计日志并存 | 页面「变更记录」是业务视图；审计只给超管且面向安全追溯 | prd（A §11.8 页面 ⑤） |
| AP-D21 | 「老账号满一周立即采」用 `supplement --only full --if-older-than 168` | FS-13.4 为此预留；PRD 没写老账号立即采什么，按完整采集是默认而非 PRD 原文 | prd 入口 + proposed 默认 |
| AP-D22 | 预检不按文本拒绝「专员已有另一账号」 | 同账号的不同链接文本会被误杀；交给解析后的 `intakeAccount` 裁判 | proposed |
| AP-D23 | 名单项可见范围按**加入时**的 `branch_id` 快照算，不跟随门店后来换分公司 | A §11.3「分公司只看自己报的」讲的是谁报的；快照稳定，不让历史名单在换分公司时在两个分公司之间跳 | proposed |
| AP-D24 | 回收站清除：先调下游 `purge`（事务外），成功后再删；下游 `onDeleted` / `onRestored` 为加速通知，以计划状态对账 | 数据库事务内不做跨域调用；不引入 outbox 表 | proposed |
| AP-D25 | 批次在计划清除后由 `summary` 快照（计划名、平台、品牌）自描述，按提交分公司 / 品牌 / 超管可见 | 批次是历史事实，比计划活得久 | proposed |
| AP-D26 | 链接域名识别按 A §11.2.2 第二层：含 URL 且域名未知 → 错误；纯口令放行 | 保留 PRD 的明确规则；`PLATFORM_DOMAINS` 已含短链域名 | proposed（待确认） |

## 14. Open items

**2026-11-06 刘学奎：待裁决项全部按本 spec 的建议采纳**（含标「待确认」的各项）。下表保留原问题与采纳的写法，作为记录；之后要改某项，走修订并保留原行。

| # | 问题 | 本 spec 当前写法 | 影响 |
|---:|---|---|---|
| 1 | 活动计划的页面与名单导入页面何时开工 | 本轮没有页面（AP-D16）；进入条件：B 可登录 ∧ `ui-foundation.md` 定稿 ∧ ui-lab 原型走查 ∧ §15 N.6 填写确认 | 页面任务 |
| 2 | 表头处理：A §11.2.2「拒绝」vs F-D10「自动跳过」 | 采用 F-D10（R5、AP-D12） | AP-5、模板 |
| 3 | 修改已录账号的主页链接（B-D19 / A §5.7） | 本轮不做；变通：移出后用新链接重新提交 | AP-10 |
| 4 | 名额占用时机与「已存在行」的口径 | 确认写入时按本地可知事实判定（AP-D04） | AP-4 |
| 5 | 引用恢复时重开账号的推广规则 | 派生规则，所有 0→>0 事件重开（AP-D06） | AP-11 |
| 6 | 疑似空账号确认的 Capability | `data.account.manage`（AP-D14） | AP-10、B 域清单 |
| 7 | 手机号规范化规则 | `cn-mobile.v1`（AP-D11） | AP-6、AP-7，与 B 的用户手机号规则对齐 |
| 8 | 解析驱动的并发默认值与块大小 | 并发 2、块 200，均为可配置默认，不是合同 | AP-8、AP-9 |
| 9 | 真实付费 smoke 是否在本 spec 内做 | 不做；需要时按 `a-full-sync` 的批准式 smoke 另行申请 | AP-15 |
| 10 | 计划起始日期是否允许早于今天 | 允许（跨年与回填场景）；不校验 | AP-1 |
| 11 | A §11.2.2 第二、三层的链接判断 | 第二层「域名识别不出」：含 URL 且域名未知 → `platform_unrecognized`（需要导出 `detectLocatorPlatform`）；纯口令放行。第三层「链接格式错误」：本地不实现，认不出的由供应商判断，落为解析后的 `invalid`（§7.1 步骤 10–11 的说明） | AP-6、AP-9 |
| 12 | 名单可见范围用加入时快照还是当前组织 | 快照（AP-D23） | AP-13 |

## 15. 界面

> **已确认（2026-11-10，刘学奎）。** 页面清单、流程、状态与可见性经 v2 原型确认；页面任务仍未编写，按本 spec 的排期另行追加。确认记录见 §15.6；视觉以 `ui-foundation.md`（2026-11-10 版）为准。

### 15.1 页面清单

| 页面 | 角色 | 入口 | 主要操作 | 对应 Capability |
|---|---|---|---|---|
| 活动计划列表 | 超管、总部、分公司 | 一级导航「活动计划」 | 筛选（品牌 → 平台 → 状态）、新建、进入详情、加入 | `activity_plan.create` / `join` |
| 新建活动计划 | 超管、总部 | 列表主按钮 | 填品牌、平台、板块（默认全选）、名称、说明、起止日期；提交即发布 | `activity_plan.create` |
| 计划详情（标签页：基本信息 / 参与分公司 / 名单 / 下游判定计划 / 变更记录） | 同上 | 列表行 | 编辑、暂停 / 归档 / 恢复、删除（弹窗写明 N 个判定计划、M 条结果）、替换负责人、加入 / 退出、移出名单 | 同上 |
| 名单导入（F5 路径 2）向导 | 分公司、总部、超管 | 导航「导入中心」→「活动名单」；或详情页「上传名单」 | 选计划 → 下载模板 → 上传 → 预检报告 → 确认写入 → 批次详情 | `activity_plan.join` |
| 批次列表 / 详情 | 同上 | 导入中心 | 看分类与结果计数、解析中进度、下载回流文件 | 随 `join` |
| 回收站 | 创建者、超管 | 列表右上角 | 恢复 | `activity_plan.create` |
| 账号列表（综合状态列）、五级开关、疑似空账号确认、单账号补抓 | 超管、总部、分公司 | 导航「账号与监控」 | 综合状态筛选、开关、确认疑似空账号 | `data.monitoring.manage` / `data.account.manage` |

### 15.2 用户流程

```text
总部：新建计划 → 详情看「本计划需要 2 份监控判定计划：家装、水机」→ 去 D 域创建
分公司：列表 → 加入 → 导入向导 → 预检报告（可写入 / 将新建专员 / 错误）
        → 确认 → 批次详情（解析中 N → 已导入 / 已存在并引用 / 归属冲突 / 链接无效 / 疑似空账号）
        → 下载回流文件 → 改完作为新文件重传
```

### 15.3 线框

**2026-11-08 第一版原型**：[`ui-lab/hbecho-ui/`](../../../ui-lab/hbecho-ui/README.md)。覆盖登录（B 域）、计划列表、计划详情、名单导入、批次详情、账号与监控、用户管理等；只抄 hbdam 当前 UI 的结构与组件，业务按本 spec。保留作对照。

**2026-11-10 第二版原型（已确认）**：[`ui-lab/hbecho-ui-v2/`](../../../ui-lab/hbecho-ui-v2/README.md)。在 v1 上重做视觉层并清理界面里的内部术语与 ID：计划列表、新建计划、计划详情（五个标签）、名单导入向导、批次列表与详情、回收站、账号与监控。建议业务按「总部建一个 618 计划 → 分公司导入 200 行含 5 个新专员、3 个归属冲突 → 看批次详情 → 下载回流文件」走一遍。

### 15.4 状态矩阵

| 页面 | 加载 | 空 | 无权限 | 错误 | 部分成功 | 处理中 | 过期 |
|---|---|---|---|---|---|---|---|
| 计划列表 | 骨架屏 | 「还没有计划」+ 新建（有权限者） | 「无权访问」页 | 一句人话 + 错误码 + 重试 | — | — | 已过结束日的计划标「已到期」 |
| 计划详情 | 骨架屏 | 名单为空：「去导入名单」 | 同上 | 同上 | — | 删除 / 退出提交后「处理中」 | 暂停 / 归档：名单区只读提示 |
| 名单导入向导 | — | 无已加入计划：「先加入计划」 | 无 `join` 不显示入口 | 文件级错误展示失败项与样本 | 预检含错误行：仍可确认其余行 | 确认后立即返回批次号 | 计划被暂停：确认被拒并说明 |
| 批次详情 | 骨架屏 | — | 范围外批次 = 未找到 | 同上 | 「新增 800、失败 20」是正常终态 | 「解析中 N」持续刷新 | — |

### 15.5 字段可见性

| 字段 | platform_admin | hq_manager | branch_manager | store_staff |
|---|---|---|---|---|
| 计划（授权品牌内） | ✅ 全部 | ✅ | 采集中的本品牌计划 | — |
| 名单逐行（含手机号明文） | ✅ | ✅ 授权品牌 | 仅本分公司 | — |
| 批次汇总 | ✅ | ✅ 授权品牌 | 本分公司 | — |
| 批次逐行明细 | ✅ | ❌（只看汇总） | ✅ 本分公司 | — |
| 其他分公司的名单与批次 | ✅ | ✅ | ❌ | — |
| 负责人姓名 | ✅ | ✅ | 仅本分公司的槽位 | — |
| 变更记录 | ✅ | ✅ 授权品牌 | 仅本分公司相关条目 | — |
| 回收站 | ✅ | 仅自己创建的 | ❌ | — |
| 内部字段名、表名、`reason_code` | ❌ 界面显示人话 + 稳定错误码 | ❌ | ❌ | — |

### 15.6 界面设计确认

| 确认人 | 日期 | 确认的页面范围 | 原型 / 线框链接 | 备注 |
|---|---|---|---|---|
| 刘学奎 | 2026-11-10 | 活动计划列表、新建计划、计划详情（基本信息 / 参与分公司 / 名单 / 下游判定计划 / 变更记录）、名单导入向导、批次列表与详情、回收站、账号与监控 | [`ui-lab/hbecho-ui-v2/`](../../../ui-lab/hbecho-ui-v2/README.md) | 视觉按 `ui-foundation.md` 2026-11-10 版；v1 原型保留为对照。页面任务另行排期 |
