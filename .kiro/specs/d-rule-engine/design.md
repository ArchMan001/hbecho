# D 规则与考核（d-rule-engine）· 设计

> **状态**：`draft`
>
> **模式**：Design-First
>
> **需求**：[`requirements.md`](requirements.md)
>
> **实施计划**：[`tasks.md`](tasks.md)（未开始）
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：D 规则与考核 · **目录命名**：`d-rule-engine`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md) v1.2（定稿候选）
>
> **数据基线**：A 域的名单 / 内容 / 评论 / 归属 / 同步表按 [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) 与已合并的 `src/db/schema/*`；D 域的表以本文 §6 为准，不入 v2
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16

## 1. Overview

本 spec 的最小纵向结果是：

```text
创建者在活动计划下建判定计划 → D 落行，C 建监控段草稿 v1（同 ID、同版本号）
→ 第 1 页：时间窗 / 形态 / 关键词 / 话题 / 时长 → 圈定（同步；只读 A 快照与 C 文本信号；零外部调用）→ 条数
→ 第 2 页：选对比元素、传标准图 / 元素图（经 C）、调阈值 → 试跑（C 补算，D 轮询）→ 0–10 分布与固定 5 个样例槽位
→ 第 3 页：ASR 标准 / 评论要求 → 确认执行：草稿发布为新版本（C.publish）→ 新建执行
→ worker：冻结名单 / 当前归属 / 组织链 / 内容快照 → 第 1 层 → 第 2 层 → （A 采音频与评论 → C 判定）→ 专员聚合 → completed
→ E 轮询 listCompleted，经 JudgementOutcomeReader 取参与专员与内容
```

**与已有能力的关系**：

| 已有能力 | 本 spec 怎么用 | 本 spec 不做什么 |
|---|---|---|
| A `createPlanReader.rosterSnapshot / statusOf` | 名单来源；回收站对账 | 不改名单，不加锁（§14 第 4 项） |
| A `PlanDownstream` | 实现并注入（`summarize / onDeleted / onRestored / purge`） | 不改 A 的删除流程 |
| A `demand.submit / get` | 向 A 提「音频」「评论」需求并轮询 | 不提封面 / 头像 / 背景需求（不在 `wants` 里）；不直接抓取 |
| A 内容 / 账号 / 评论 / 归属 / 同步表 | **只在 `facts.ts` 里读** | 不写；不 import 供应商调用 |
| C `SignalReader / requestScores / executability / segments / retainUntil / normalizeKeyword` | 全部信号经此取；监控段随计划同 ID 同版本 | 不读 C 的表；不抽取、不匹配、不调模型 |
| B `createAuthorizer / AuditWriter / defaultRegistry` | D 的全部授权与审计 | 不写角色名；不再用 A 那种 `assert` seam |
| E | 提供 `JudgementOutcomeReader`；E6 出文件 | 不出文件、不算比率、不激活投影 |
| 租约 + fencing 的写法（`orchestrator/claim.ts`、`signal_tasks`） | 在 `judgement_runs` 上重写一份（运行很少，不需要独立队列表） | 不复用 `sync_tasks`；不改它们 |

## 2. Authority and Evidence Levels

### 2.1 Decision order

1. [`CONTEXT.md`](../../../CONTEXT.md)；
2. D 域 PRD v1.2（判定模型、达标方式、零内容、版本语义、下载走 E6）；
3. A 域已合并的 schema 与代码（D 只读）；C 的 spec（接口）；
4. E、B、H 的 PRD（消费方、授权、通道）；
5. 本 spec 的建议（§14 列出全部待确认项）。

### 2.2 Evidence labels

| 等级 | 含义 | 本设计中的例子 |
|---|---|---|
| `code` | 已合并代码里读到的事实 | `rosterSnapshot` 不含平台 / 起止日期；`rebind` 只改 `staff_account_assignments.staff_id`，不回写名单项；`demand` 幂等作用域含 `actorId`，一次 ≤ 5,000 项；`PREDICATE_NAMES` 有 `plan_creator` 却无人注册谓词体；`SERVICE_PRINCIPALS` 里没有 `rule.*` 的持有者；`activity_plans` 有 `uq_plans_id_platform`；`durationUnit` 目前只有 `seconds` / `unknown` |
| `prd` | 上游 PRD 或已编号决策 | D-D01～D-D17、D-69、D-71、D-72、三值表、零内容、AND3、不达标优先 |
| `spec` | C / A / B 已定稿 spec 的合同 | `SignalReader.readMany` ≤ 5,000、`requestScores` 对草稿可用、`executability`、`retainUntil`、`normalizeKeyword(raw, version)`（C-D17） |
| `proposal` | 本 spec 的建议，**待评审** | 第 3 页确认即发布、回退只作用于草稿、同步完整谓词、评论缺口计入 U、继承提交人身份、Outcome 读取口形状 |

没有实测依据的数值（块大小、轮询间隔、等待上限、保留个数）一律标为可配置初值，不当作合同。

## 3. Goals and Non-goals

### 3.1 Goals

1. 业务能配出「带 #618 **且**封面合规的视频 ≥ 3 条」这类要求，并得到与 PRD 三值表逐格一致的结论；
2. 判定可解释：每条内容的每层、每个条件都有自包含的证据；
3. 判定可复现：名单、归属、组织链、窗口、内容快照一次冻结，之后数据怎么变本次结果都不变；
4. 圈定与试跑不花钱；付费只发生在第 3 层，且只对通过前两层的内容发生；
5. 版本语义清楚：草稿可改、已发布不可变、执行不升版；
6. 执行可崩溃恢复、无重复结果、可取消；
7. 给 E 一个稳定的只读口，给 A 一个可信的「有没有在途执行」。

### 3.2 Non-goals

页面、指标与导出文件、信号实现、采集、模型调用、刷流量与互动基线、否定条件、播放量条件、OCR、图片 / 视频理解、多轮对话、定时自动判定、评论作者是否为指定账号。详见 requirements §1.5.2。

## 4. Ownership and Deep Modules

新增一个模块目录、一个 schema 文件、两个 CLI 文件（目录约定见 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)）：

| 位置 | 职责 | 对外 seam |
|---|---|---|
| `src/modules/judgement/config.ts` | 配置 zod schema、平台可得性校验、规范化与 `config_sha256`、推导 C 的 `items` | `parseConfig`、`validateConfig(cfg, platform, signals)`、`deriveItems(cfg)` |
| `src/modules/judgement/plans.ts` | 判定计划生命周期、与 C 的 provisioning、归档 | `createPlans(deps)` |
| `src/modules/judgement/versions.ts` | 草稿配置、传图转发、向导进度、回退、`newDraft`、发布协议 | `createVersions(deps)` |
| `src/modules/judgement/facts.ts` | **A 事实读取口**：D 读 A 表的唯一入口（批量） | `rosterOf`、`assignmentsOf`、`orgChainOf`、`contentsOf`（含 `like_value` / `like_state`）、`snapshotsOf`、`commentsOf`、`profileOf`、`syncCompleteness` |
| `src/modules/judgement/engine/pure/` | **纯函数**：`and3`、`evaluateMethod`、各条件求值、信号状态映射、窗口换算、分布统计 | 无 IO，表驱动测试 |
| `src/modules/judgement/engine/runner.ts` | 阶段机：`tick(run)`、各阶段的 enter / poll / complete | `createRunner(deps)` |
| `src/modules/judgement/engine/claim.ts` | 运行的租约、fencing、`active_key`、提交人复核 | 内部 |
| `src/modules/judgement/engine/deps.ts` | 对 C / A 的依赖协调：分批、幂等键、轮询、超时 | 内部 |
| `src/modules/judgement/outcomes.ts` | `JudgementOutcomeReader`、`explain` | 对 E |
| `src/modules/judgement/downstream.ts` | A 的 `PlanDownstream` 实现 | 对 A |
| `src/modules/judgement/ports.ts` | `SignalsPort`、`DemandPort`、`FactsPort` 类型；`fakes.ts` 为 fake 实现 | seam |
| `src/modules/judgement/{authz,audit,errors,env,assemble}.ts` | B 授权适配、审计、错误类、配置、装配 | `createJudgement(deps)` |
| `src/db/schema/judgement.ts` | 本 spec 全部新表 | — |
| `src/worker/judgement-cli.ts` / `judgement-main.ts` | 命令解析、常驻进程装配 | `runJudgementCli(argv, deps)` |

**深模块设计**（窄接口、厚实现）：

- 页面 / CLI 只知道 `plans`、`versions`、`runs`（开始、取消、查询）、`outcomes`；不知道阶段机；
- `facts.ts` 是 D 与 A 之间**唯一**的表耦合点；其余文件不 import A 的 schema（护栏守）。名单读取走 A 的 `PlanReader`（函数，不是表）；
- `engine/pure/` 不依赖数据库、不依赖 C 的类型细节（只依赖 `SignalValueLike` 最小接口），三值逻辑与达标方式的正确性只在这里证明；
- 对 C、A 的调用只出现在 `engine/deps.ts` 与 `versions.ts`；事务回调里不允许出现它们（护栏守）。

### 4.1 端口（seam）

```ts
// D 需要的 C 的最小子集；真实实现是 C 模块（已合入 main，2026-11-16 核对）的薄封装，fake 供离线测试。形状与 C 现状的差异见 §10.3
interface SignalsPort {
  platformSignals(platform: string): readonly string[];
  executability(ref: SegmentRef, o?: { only?: readonly string[] }): Promise<{ executable: boolean; blockers: { code: string; signal?: string; detail?: string }[] }>;   // C：segments.executability(actor, ref, { only })
  segments: {
    create(a: { planId: bigint; platform: string }): Promise<{ version: number; created: boolean }>;
    putImage(a: ImageArgs): Promise<void>;  removeImage(a: ImageKey): Promise<void>;
    setItems(a: { planId: bigint; version: number; items: SegmentItem[] }): Promise<void>;
    publish(a: SegmentRef): Promise<void>;
    newDraft(a: { planId: bigint; fromVersion: number }): Promise<{ version: number }>;
    show(a: SegmentRef): Promise<{ status: 'draft' | 'published'; items: SegmentItem[]; images: ImageMeta[] }>;
    purge(planId: bigint): Promise<void>;
  };
  // only：本次只补算这些信号键，`not_executable` 也只看它们（C 的 RequestContext.only，已在 main）；
  // 不传会为 C1 全部内容连带建第 3 层（付费）任务，D 的调用一律必传
  requestScores(ref: SegmentRef, subjects: Subject[], ctx: { caller: string; scopeFingerprint: string; only: readonly string[] }): Promise<RequestResult>;
  readMany(subjects: Subject[], key: string, o: { param?: Param; stalePolicy: 'use_stale' }): Promise<Map<bigint, SignalValue>>;   // 与 C 一致：键是主体 ID（同一次调用的主体种类相同）
  normalizeKeyword(raw: string, version?: number): string;
  retainUntil(resultIds: bigint[], until: Date): Promise<void>;
}
interface DemandPort {   // A 的 demand 模块的薄封装；actor 为提交人身份译成的 A 侧 ActorContext（design §9）
  submit(input: SubmitDemand): Promise<SubmitResult>;
  get(batchId: string): Promise<DemandView>;
}
```

## 5. End-to-end flow

### 5.1 判定计划与草稿

```text
create(actor, {activityPlanId, alias}):
  authorize(rule.definition.manage, judgement_plan, predicates=[plan_creator])        // 读库之前
  tx: 读活动计划（status=collecting、未删除）→ INSERT judgement_plans(status=provisioning) → INSERT versions(v1,draft, config=空模板, window 默认拷贝活动计划起止日)
  事务外: signals.segments.create({planId, platform})        // 已存在视为成功
  tx: status → active
config set / image put / image remove:
  authorize → 读草稿（必须 draft）→ zod 校验 → 平台可得性 → tx: 写 config、按失效矩阵回退向导进度并删除失效的运行
  config set 之后事务外: segments.setItems(deriveItems(config))
  image put/remove 只是转发给 C，D 记失效矩阵
```

### 5.2 圈定（同步）

```text
circle(actor, planId):
  authorize(manage) → 读草稿 → INSERT judgement_runs(kind=circle, status=running, 租约=调用方) → 同一引擎跑 freeze → scope → layer1 → finalize
  → 草稿 wizard_step = circled；返回 {c1, participants, contents, unobtained, byReason}
```

### 5.3 试跑（异步）

```text
trial(actor, planId):
  authorize(manage) → 草稿必须 circled
  signals.executability(ref, only = 第 2 层能力用到的信号键) 不可执行 → 拒绝并返回 blockers（如 image.* 未标定），不建运行、不返回全 0
  → INSERT judgement_runs(kind=compare, status=planned)
  scores 阶段若 C 仍整批拒绝 not_executable（建运行之后能力才丢失）→ 运行 failed(not_executable)，已定的行保留
  worker: freeze → scope → layer1（试跑自己重做一遍：只读、无外部调用，读取的是此刻的数据，不拷贝圈定运行）→ scores(requestScores + 轮询) → finalize
  → 草稿 wizard_step = compared；trial-report(runId) 出分布与样例
```

### 5.4 确认执行（发布 + 执行）

```text
confirm(actor, planId, idempotencyKey):
  authorize(run.execute + plan_creator) → 草稿存在且进度足够（§7.9）
  signals.executability(ref) 不可执行 → 拒绝并返回 blockers（不改任何状态）
  tx: version.status = publishing                                                    // 高风险审计同事务
  事务外: signals.segments.publish(ref)                                              // C 内部再校验 executability
  tx: version.status = published；INSERT judgement_runs(kind=execution, status=planned, idempotency_key)  // 同事务
execute(actor, planId, idempotencyKey):           // 无草稿时对最近已发布版本重新执行
  authorize(run.execute + plan_creator) → INSERT judgement_runs(kind=execution, status=planned)
```

### 5.5 执行（worker）

```text
claimNextRun(workerId) → tick(run) → 写阶段进度 → status = running | waiting → 下一个 tick
阶段：freeze → scope → layer1 → scores → demand → layer3 → comments → aggregate → finalize   (详见 §7.2)
```

### 5.6 输出与清除

```text
E: listCompleted(after) → describe(id) → streamParticipants / streamContents(constraint)       // 只读
A: 删除活动计划 → downstream.summarize() 判断在途 → onDeleted；期满 → downstream.purge()
```

## 6. Data model

D 域全部新表放 `src/db/schema/judgement.ts`，遵守数据底座惯例：内部 ID 为 signed `BIGINT`（API 输出十进制字符串）；时间 UTC `DATETIME(6)`；状态用 `VARCHAR + CHECK`；哈希列 `BINARY(32)`；业务表无 `ON DELETE CASCADE`。**表数 5 张**，不入 v2。

### 6.1 新表

#### `judgement_plans`

| 列 | 类型 | 说明 |
|---|---|---|
| `plan_id` | id PK autoincrement | **同时是 C 监控段的计划 ID** |
| `activity_plan_id` / `platform_id` | id | 复合外键 → `activity_plans(plan_id, platform_id)`（已有 `uq_plans_id_platform`），RESTRICT：平台与活动计划一致由数据库保证；A 物理清除前 D 必须先 `purge` |
| `alias` | varchar(200) | 别名；唯一键 `(activity_plan_id, alias)` |
| `description` | varchar(2000) NULL | |
| `status` | varchar(16) | `provisioning` / `active` / `archived`；CHECK |
| `latest_version` | int | 当前最大版本号 |
| `created_by_actor` / `created_by_user_id` | varchar(128) / id NULL | 后者 B 接入后回填，不造假 |
| `created_at` / `updated_at` | utc | |

索引：`(activity_plan_id, status)`。

#### `judgement_plan_versions`

| 列 | 类型 | 说明 |
|---|---|---|
| `plan_id` / `version` | id / int | 复合主键；外键 → `judgement_plans` |
| `status` | varchar(16) | `draft` / `publishing` / `published`；CHECK |
| `wizard_step` | varchar(16) | `draft` / `circled` / `compared`；CHECK（对已发布版本只作记录） |
| `config` | json NOT NULL | 判定段配置（§7.1） |
| `config_schema_version` | int | |
| `config_sha256` | sha256 | 规范化 JSON 的哈希 |
| `based_on_version` | int NULL | `newDraft` 的来源 |
| `draft_key` | id，生成列 | `CASE WHEN status IN ('draft','publishing') THEN plan_id END`；唯一键保证每计划至多一个草稿（沿用 `staff_account_assignments.active_staff_platform` 的写法） |
| `published_at` / `published_by_actor` | utc NULL / varchar | CHECK：`(status='published') = (published_at IS NOT NULL)` |
| `created_by_actor` / `created_at` / `updated_at` | | |

#### `judgement_runs`

| 列 | 类型 | 说明 |
|---|---|---|
| `run_id` | id PK | **`run_kind='execution'` 时即 E 所说的「判定执行 ID」** |
| `plan_id` / `version` | id / int | 外键 → `judgement_plan_versions`（RESTRICT） |
| `run_kind` | varchar(16) | `circle` / `compare` / `execution`；CHECK |
| `status` | varchar(16) | `planned` / `running` / `waiting` / `completed` / `failed` / `cancelled`；CHECK |
| `phase` / `phase_cursor` / `phase_detail` | varchar(32) / id / json | 阶段、阶段内游标、阶段内的依赖句柄（demand 批次 ID、已提交标志、等待截止时间、`waiting_on ∈ null / signals / demand`：界面「等待采集」只看它，不看 `status = waiting`） |
| `frozen` | json NOT NULL | 窗口（UTC 与北京日期）、`frozen_at`、平台、活动计划起止日、`config_sha256`、C 监控段引用 |
| `idempotency_key` | sha256 NULL | 唯一键 = `jcsSha256({plan_id, version, actor, key})`（`version`：`confirm` 时是草稿版本，`execute` 时是最近已发布版本；调用方传入的 `--key` 只在「同一计划、同一版本、同一提交人」内有意义，换计划或换版本用同一个稳定 key 不会命中旧运行）：重复提交同一次「开始执行」返回已有运行 |
| `active_key` | sha256 NULL | 未终态时 = `jcsSha256({plan_id, version})`，终态置空；**唯一键保证同版本至多一个未终态运行**；CHECK：`(status IN ('planned','running','waiting')) = (active_key IS NOT NULL)` |
| `submitted_by_actor` / `submitted_by_user_id` / `scope_summary` | varchar / id NULL / json | 提交人与授权摘要（JP-15 复核用） |
| `lease_owner` / `lease_expires_at` / `fencing_token` | varchar(128) / utc / id | 租约；CHECK：`status <> 'running' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)` |
| `next_tick_at` | utc NULL | 下一次可被领取的时间（轮询节奏） |
| `attempt_count` / `last_error_code` / `last_error_detail` | int / varchar / json | 阶段重试；详情写入前脱敏 |
| `participant_count` / `content_total` / `c1_count` / `c2_count` / `c3_count` / `stale_used` | int… / bool | 完成时回填的汇总（描述符用） |
| `started_at` / `completed_at` / `created_at` / `updated_at` | utc | |
| `expires_at` | utc NULL | 仅 `circle` / `compare`：保留期（JP-19） |

索引：领取 `(status, next_tick_at, run_id)`；`(plan_id, version, run_kind, status)`；`(run_kind, status, completed_at, run_id)`（`listCompleted`）。

#### `run_participants`

一次运行冻结的参与专员（含冻结的组织链，即 E 需要的归属快照）。主键 `(run_id, account_id)`，唯一键 `(run_id, staff_id)`。

| 列 | 说明 |
|---|---|
| `staff_id` / `store_id` / `dealer_id` / `brand_id` / `sector_id` / `branch_id` / `region_id` | 冻结的组织链，各自外键 RESTRICT；`dealer` 是交叉维度，不参与上卷 |
| `sync_complete` / `sync_reason` | 窗口内同步是否完整（§7.5）；`sync_reason ∈ sync_failed / sync_gap / no_sync_in_window`，完整时为空 |
| `content_total` / `content_pass` / `content_fail` / `content_unobtained` / `content_skipped` | 内容要求的 T、P、F、U 与未选中数；P / F / U 取 `final`（`unobtained` 含 `l0 / l1 / l2 / l3` 任一层），`T = P + F + U`，`content_skipped` 不入 T；**零内容 = 参与内容行数（`T + content_skipped`）为 0**；内容要求未启用时全部为 NULL |
| `c1_count` / `c2_count` / `c3_count` | 各层通过条数；`c1_count` = `l1='pass' ∧ layer1_selected=true` 的内容数 |
| `comment_total` / `comment_pass` / `comment_unobtained` | 未配置评论要求时为 NULL |
| `content_result` / `comment_result` / `account_result` | `success` / `not_met` / `unobtained`；NULL = 没配这类要求 |
| `plan_result` | 同上；聚合前为 NULL，**完成的执行里不为 NULL** |
| `primary_reason` / `reason_detail` | 主要未获取原因与各类原因的计数 JSON；含 `like_not_value`（进入排序的内容里点赞值状态不是 `value` 的条数） |
| `account_detail` | 账号要求各条件的分数与结果 |
| `stale_used` | bool |
| `state` | `pending` / `done` |

索引：`(run_id, plan_result)`、`(run_id, branch_id)`、`(run_id, store_id)`。

#### `run_contents`

一次运行里一条参与内容一行。主键 `(run_id, content_id)`；外键 `(run_id, account_id)` → `run_participants`；`content_snapshot_id` → `content_snapshots`。

| 列 | 说明 |
|---|---|
| `account_id` / `content_snapshot_id` / `published_at` | 冻结的快照与发布时间 |
| `like_value` / `like_state` | 冻结快照的点赞量与值状态；列类型与 CHECK 沿用 A 的 `id()` 与 `valueStateCheck`（`value` 时非空且 ≥ 0，其余四态 `missing / explicit_null / invalid / unsupported` 时为空）；非 `value` 不当作 0 |
| `layer1_selected` / `layer1_rank` | 是否被第 1 层数量要求选中、按点赞排序的名次。**只对 `l1='pass'` 的行有值**；`l0 / l1` 非通过的行为 NULL；未配置 N 时 `l1='pass'` 的行全部选中、rank 为 NULL。CHECK：`layer1_selected IS NOT NULL ⇒ l1='pass'`；`layer1_rank IS NOT NULL ⇒ layer1_selected IS NOT NULL` |
| `l0` / `l1` / `l2` / `l3` | `pass` / `fail` / `unobtained` / `skipped` / `not_configured`；**NULL = 还没评估**（阶段内以 NULL 作待办标记）；`l0` 只有 `pass` / `unobtained` |
| `final` | `pass` / `fail` / `unobtained` / `skipped`；全部层评估完成后一次写入；`skipped` 只用于第 1 层数量截断未选中的内容。CHECK：`(final='skipped') = (l1='pass' ∧ layer1_selected=FALSE)` |
| `reason_code` / `stop_layer` | 停在哪一层、为什么 |
| `stale` | bool |
| `cm_total` / `cm_pass` / `cm_unobtained` / `cm_samples` | 评论计数与至多 3 个命中评论 ID（NULL = 没配评论要求或不在 C2） |
| `evidence` | json，§7.4 |

索引：`(run_id, account_id, final)`、`(run_id, l1)`、`(run_id, account_id, layer1_selected)`。

### 6.2 对既有表的修改

**没有**。D 对 A、B、C 的表零修改。外键只指向 A 的表（`activity_plans`、组织表、`content_snapshots`），方向是 D → A。

### 6.3 JSON 形状

**配置**（`judgement_plan_versions.config`，zod `strict`，`schema_version = 1`）：

```ts
type Config = {
  window: { from: 'YYYY-MM-DD'; to?: 'YYYY-MM-DD' };              // 北京时间自然日，闭区间
  kinds: Array<'video' | 'image'>;                                  // 图文 = A 的 image + text
  layer1: {
    text: Array<{ alias?: string; fields: Array<'title' | 'body'>; mode: 'all' | 'any'; keywords: string[] }>;
    hashtags: Array<{ alias?: string; mode: 'all' | 'any'; values: string[] }>;
    duration?: { alias?: string; minSeconds?: number; maxSeconds?: number };   // 仅 kinds = ['video']
    quantity?: { n: number };                                      // 整层共享；1–1000；缺省 = 不截断；只在 text / hashtags 至少一项时可存在
  };
  layer2: {
    abilities: Array<{
      abilityId: string;                                           // D 生成的稳定标识，不进 config_sha256
      alias?: string;
      kind: 'whole_image' | 'image_element';                       // image_text 是 2.0，1.0 不接受
      target: 'avatar' | 'cover' | 'background';
      threshold: string;
      elementKey?: string;                                         // image_element：上传字节的 SHA-256 十六进制（D 在上传时写入；草稿可暂缺，发布前必须有）
    }>;
  };
  contentRequirement?: { layer3?: { alias?: string; standardText: string } };   // 内容达标方式按 quantity 推导；内容要求是否启用见 §7.1
  commentRequirement?: { alias?: string; mode: 'all' | 'any'; keywords: string[]; method: Method };
};
type Method = { type: 'at_least_n'; n: number } | { type: 'all' } | { type: 'any' } | { type: 'ratio'; bp: number }; // 仅评论
```

**内容行证据**（`run_contents.evidence`，**不含正文 / 评论原文 / 作者**）：

```ts
type Evidence = {
  l1?: { text?: Array<{ idx: number; hit: string[]; state: 'pass'|'fail'|'unobtained' }>; hashtags?: Array<{ idx: number; hit: string[]; state }>; duration?: { seconds: string; state } };
  l2?: { abilities?: Array<{ id: string; kind: string; target: string; score?: string; state; reason?: string; resultId?: string; cap?: {id; version} }> };
  l3?: { verdict?: 'meets'|'not_meets'; reason?: string; model?: string; promptVersion?: number; state; resultId?: string };
  dep?: { audio?: string; comments?: string };                       // 需求结果：ready / failed:原因 / unsupported:原因
  stale?: boolean;
};
```

### 6.4 状态与枚举

| 枚举 | 取值 | 守护 |
|---|---|---|
| 判定计划状态 | `provisioning` / `active` / `archived` | CHECK |
| 版本状态 | `draft` / `publishing` / `published` | CHECK + 生成列唯一键 |
| 向导进度 | `draft` / `circled` / `compared` | CHECK |
| 运行种类 / 状态 | 见 `judgement_runs` | CHECK |
| 层结果 | `pass` / `fail` / `unobtained` / `skipped` / `not_configured` | CHECK |
| 专员结果 | `success` / `not_met` / `unobtained` | CHECK |
| 未获取成功原因（D 自有） | `published_at_missing`、`content_kind_unknown`、`duration_unit_unknown`、`duration_missing`、`dependency_timeout`、`demand_failed`、`unsupported_platform`、`content_not_found`、`account_unavailable`、`sync_failed`、`sync_gap`、`no_sync_in_window`、`comments_incomplete` | 代码常量 |
| 跳过原因 | `layer1_not_selected` | 代码常量；只用于 `final=skipped` |
| 未获取成功原因（沿用 C） | `not_computed`、`no_profile_snapshot`、`media_pending`、`media_failed`、`media_carried_forward`、`audio_not_archived`、`capability_disabled`、`compute_dead`、`failed_under_old_version`、`no_reference`、`image_unreadable`、`model_refused`、`invalid_output`、`field_absent_on_platform`、`platform_unsupported` | 代码常量，**逐字沿用**，不在 D 里改名 |
| 运行失败原因 | `participant_conflict`、`no_staff_assignment`、`plan_not_found`、`not_executable`、`submitter_revoked`、`internal_error` | 代码常量 |

## 7. Algorithms

### 7.1 配置规范化与 `items` 推导

- **规范化**：键排序、数组保持业务顺序（关键词顺序不重要但保留原样，`config_sha256` 对数组顺序敏感，按保存顺序）、阈值规范化为两位小数字符串（`"8"` → `"8.00"`）、窗口日期校验；`config_sha256 = jcsSha256(canonical)`（沿用 `canonical-json`）。**能力别名与 `abilityId` 从 canonical 中剔除**：别名只随版本保存用于显示，`abilityId` 只是稳定标识；改别名不触发重新圈定 / 试跑。只改别名再发布会得到哈希相同的新版本，这是允许的（别名在版本配置里，旧执行仍显示旧别名），审计记别名差异。
- **推导 `items`**（交给 C `setItems`）：

| 配置里有 | `items` 里加 |
|---|---|
| `layer1.text` 的字段含 title / body | `text.title_normalized` / `text.body_normalized` |
| `layer1.hashtags` | `text.hashtags` |
| `layer2` 能力 `kind='whole_image', target='cover'` | `content.cover_template_score` |
| `layer2` 能力 `kind='whole_image', target='avatar'` | `account.avatar_template_score` |
| `layer2` 能力 `kind='whole_image', target='background'` | `account.bg_template_score` |
| `layer2` 能力 `kind='image_element', target='cover'` | `content.cover_element_score` + `element_key` |
| `layer2` 能力 `kind='image_element', target='avatar'` | `account.avatar_element_score` + `element_key` |
| `layer2` 能力 `kind='image_element', target='background'` | `account.bg_element_score` + `element_key` |
| `commentRequirement` | `comment.text_normalized` |
| `contentRequirement.layer3` | `content.asr_judgement`（`standard_text`）；同时 `content.asr_text` 不单独列（C 的判定任务自带依赖） |

- **内容要求启用规则**（D-D21）：`contentRequirementEnabled(cfg) = text.length > 0 ∨ hashtags.length > 0 ∨ duration ∨ quantity ∨ abilities.some(target = 'cover') ∨ layer3`。未启用时 `run_participants.content_*` 与 `content_result` 为 NULL，不参与 `and3`；`validateConfig` 要求内容 / 评论 / 账号三类至少启用一类；`quantity` 要求 `text` 或 `hashtags` 至少一项（D-D22）；圈定、试跑、执行、页面共用这一个函数。
- **元素图与 `elementKey`**：`images.putElement(planId, abilityId, bytes)`：算 `sha256(bytes)` 十六进制作 `elementKey`；同一 `target` 下已有相同 key → `element_duplicate`；事务外先 `segments.putImage(kind='element', target, elementKey)`，再事务内把 key 写入该 `abilityId` 的能力并按失效矩阵处理；若该能力原有旧 key，则在写入成功后 `segments.removeImage` 旧 key；两步之间崩溃由 `reconcile` 以 C 的 `show().images` 与配置对账（C 有而配置无 → 删；配置有而 C 无 → 清掉该能力的 `elementKey`）。`whole_image` 无 key，一能力一图，按 `target` 覆盖。
- **平台可得性**：`validateConfig` 用 `signals.platformSignals(platform)` 逐项核对 `items`；C 的目录是唯一真相。快手 + 评论、小红书 / 快手 + 账号自然落在这里被拒，不在 D 里写平台常量。
- **关键词**：保存原文。比较时 `normalizeKeyword(raw, value.normalizerVersion)`；话题先去掉首尾 `#` 与空白再归一化。

### 7.2 运行与阶段机

**领取**（沿用 `claimNext` 的写法）：

```text
claimNextRun(workerId, now):
  SELECT run_id FROM judgement_runs
   WHERE status IN ('planned','running','waiting') AND (next_tick_at IS NULL OR next_tick_at <= now)
     AND (status IN ('planned','waiting') OR lease_expires_at <= now)       -- running 的只有租约过期（持有者失联）才可接手
   ORDER BY run_id LIMIT n FOR UPDATE SKIP LOCKED
  → status='running', lease_owner, lease_expires_at, fencing_token += 1
```

`running` 只表示「有 worker 正持有租约」。

**tick**：`tick(run)` 做一个阶段的有界工作（预算由 `HBECHO_JP_TICK_BUDGET` 约束），每次写入都在短事务里带 fencing 校验（`WHERE run_id=? AND fencing_token=?`，影响 0 行 = 陈旧，整笔放弃）；结束时**释放租约**（`lease_owner`、`lease_expires_at` 置空，保持 `fencing_token` 不回退），`status` 置 `waiting`：还有活则 `next_tick_at = now`（立即可再领，不必等租约到期），在等依赖则 `next_tick_at = now + 轮询间隔`；或进入终态。

**`waiting_on`**：进入 `waiting` 时，在同一短事务里以 JSON 合并（不覆盖 `phase_detail` 的其他键）写 `phase_detail.waiting_on`：`'demand'` = 在等 A 的 demand 批次（`demand` 阶段）；`'signals'` = 在等 C 的补算或信号读取（`layer1 / scores / layer3 / comments`）；`null` = 只是还有本地活或轮询间隔、没有外部依赖。进入 `running` 或终态时置回 `null`。**网络 / 跨模块调用（对 C、A）发生在事务之外**。

| 阶段 | 进入（幂等） | 轮询 / 推进 | 完成条件 | 持久化的进度 |
|---|---|---|---|---|
| `freeze` | 读名单（A `rosterSnapshot`）→ 当前归属 → 组织链 → 校验不变量（§7.3）→ 写 `frozen` 与 `run_participants`（分块） | — | 全部参与专员落库 | `phase_cursor` = 已处理账号 ID |
| `scope` | 对每块账号读内容与冻结快照 → 写 `run_contents`（`l0`）、`sync_complete` | — | 全部账号处理完 | `phase_cursor` |
| `layer1` | 对 `l0=pass ∧ l1 IS NULL` 的内容按块 `readMany` 文本信号并求值（§7.4）；`l1` 置值；停层的后续层置 `skipped` | 「在等」的信号（`not_computed`）保持 `l1 IS NULL`，下个 tick 重读，直到信号等待上限；全部求值后按专员对 `l1=pass` 的内容按点赞排序，写 `layer1_selected` / `layer1_rank`；未选中的 `l2/l3` 置 `skipped`、`final=skipped`、原因 `layer1_not_selected` | 无 `l1 IS NULL` 的 `l0=pass` 行，且所有 `l1=pass` 行已写选中标记 | 行本身（NULL 即待办） |
| `scores` | 对 `l1=pass ∧ layer1_selected=true ∧ l2 IS NULL`（第 2 层有条件时）的内容、对账号能力的账号主体，分批 `requestScores(only = 第 2 层能力用到的信号键)`；记 `phase_detail.scores_requested` | 轮询 `readMany`；条件齐全的行求值；超过上限的置 `dependency_timeout` | 无 `l2 IS NULL` 的待办行，且账号要求都有结果 | 行 + `phase_detail` |
| `demand` | 若有 ASR 判定或评论要求：对 C2 内容分批 `demand.submit`（键 `exec:{id}:l3:{n}` / `exec:{id}:cm:{n}`），批次 ID 记入 `phase_detail` | 轮询 `demand.get`；各项终态写入 `evidence.dep` | 所有需求终态或超过采集等待上限 | `phase_detail.demand_batches` |
| `layer3` | 进入前重调 `executability(ref, { only: ['content.asr_judgement'] })`（只看第 3 层，第 2 层图片能力的丢失不能误伤它）；`dep.audio = ready` 的内容分批 `requestScores(only = ['content.asr_judgement'])`；其余置 `unobtained`。C 若整批拒绝 `not_executable`（段不可执行，含网关 `activeModel` 变为空），本阶段剩余内容记 `capability_disabled`，不重试 | 轮询 `readMany`，求值 | 无 `l3 IS NULL` 的待办行 | 行 |
| `comments` | 对 `dep.comments` 终态的 C2 内容读评论（A）→ `readMany(comment.text_normalized)` → 逐条求值 → 写 `cm_*` | 评论信号 `not_computed` 视为在等，有上限 | 无待办 | 行 |
| `aggregate` | 逐专员块：内容 `final`、P/U/F/T、达标方式、评论 / 账号结果、零内容、计划总结果（§7.6） | — | 全部专员 `state=done` | 参与专员行 |
| `finalize` | 汇总回填、`status=completed`、`completed_at`、审计 | — | — | — |

`retainUntil` **不在 `finalize` 调**：C 约定 `until = 读取时刻 + 3 个月`，所以每个求值块在写完证据后立刻按块调用（`resultId` 去重，`until` = 该块读取 C 的时刻 + 3 个月）；调用失败使该块重试。这样被取消 / 失败、没走到 `finalize` 的执行也已延长了它们读过的结果行。

- 圈定运行只跑 `freeze → scope → layer1 → finalize`；试跑运行跑 `freeze → scope → layer1 → scores → finalize`（第 1 层自己重做，不拷贝圈定运行；不聚合、不 demand、不第 3 层、不评论）。圈定与试跑之间若 A 有新同步，两者的 C1 条数可能略有差异，试跑报告以试跑自己的 C1 为准；
- 每个阶段的 enter 只做「还没做的部分」，重进是幂等的；崩溃后下一个领取者从持久化的游标 / NULL 标记继续；
- 阶段失败（C / A 的瞬时异常）：`attempt_count += 1`，退避重试；超过 `HBECHO_JP_PHASE_MAX_ATTEMPTS` 置 `failed`（原因 `internal_error` 或依赖的稳定码），已定的行保留，可 `resume`；
- 提交人复核在每个 tick 开头做（JP-15）。

### 7.3 冻结与范围构建

```text
freeze(run):
  cfg   = versions.config                                       // 来自 (plan_id, version)
  win   = bjtDaysToUtc(cfg.window, frozen_at)                   // [from 00:00+08, min(to+1d 00:00+08, frozen_at)) 的 UTC 值
  ap    = activity_plans(activity_plan_id)                      // 平台、起止日期（记录）
  roster= A.rosterSnapshot(activity_plan_id)                    // in_roster 项，按 account_id 升序
  asg   = facts.assignmentsOf(roster.accountIds)                // staff_id / watch_type / platform_id / slot_released_at
  校验: 每个名单账号 watch_type='staff'；platform_id = 计划平台；两个账号不得解析到同一 staff
        → 违反: run failed(participant_conflict | no_staff_assignment)，详情只记账号 ID
  chain = facts.orgChainOf(staffIds)                            // staff → store → dealer/brand/sector → branch → region
  INSERT run_participants（每块 200，短事务，带 fencing）
scope(run, accounts 块):
  rows = facts.contentsOf(accounts)                             // contents ⋈ 当前 finalized 快照；status='active'；排除无当前快照者（计数）
  kind 映射: video→video；image、text→image；unknown→无法归类
  for each content:
    publishedAt = null  → l0 = unobtained(published_at_missing)
    publishedAt ∉ [from_utc, to_utc) → 不参与（丢弃，不落行）
    kind 无法归类且 kinds 不含全部形态 → l0 = unobtained(content_kind_unknown)
    kind 不在 cfg.kinds → 不参与
    否则 l0 = pass
  INSERT run_contents（content_snapshot_id = 此刻的 current 快照，冻结；like_value / like_state 取该快照）
  sync_complete = facts.syncCompleteness(accounts, window)      // §7.5，每位专员都算
```

- `contentsOf` 对 `status<>'active'` 的内容、没有 finalized 当前快照的内容**不落行**，只在 `reason_detail` 里累计 `excluded_status` / `excluded_no_snapshot` 计数（可见，但不入 T）；
- 发布时间 `NULL` 与形态 `unknown` 的内容落行（`l0 = unobtained`），因为它们**可能**属于窗口（不吞）；
- `freeze` 是**全有或全无**：它在多个短事务里分块写 `run_participants`，全部落库后才在最后一个事务里写 `frozen`（含 `roster_sha256` = 名单账号 ID 升序拼接的哈希，与 `freeze_done = true`）。崩溃在中途、`frozen` 尚未写入时，下一个领取者**删除本运行已写的 `run_participants` 后整段重做**（此时还没有任何下游行，重做安全；名单可能已变，以重做时读到的为准）。`frozen` 一旦写入，后续阶段只读它，不再读名单。

### 7.4 层求值（纯函数）

**信号状态 → 条件输入**（`fromSignal`）：

```text
state ∈ {valid, stale(usable)}      → value（stale 时置 stale=true）
state = missing                      → unobtained(reason)；awaiting = reason ∈ {not_computed, failed_under_old_version} 或 pending ∈ {queued, running}
state = failed                       → unobtained(C 的失败码)
state = not_applicable               → unobtained(C 的原因码)         // PRD §1.4：结构不适用 → 未获取成功
```

**条件**（返回 `pass | fail | unobtained`）：

- **关键词**：选中字段各自取 `fromSignal`；对每个关键词 `hit = 任一可用字段（归一化文本）含 normalizeKeyword(kw, 该字段的 normalizerVersion)`。`all`：每词都命中 → pass；否则若存在不可用字段 → unobtained，否则 fail。`any`：有命中 → pass；否则若存在不可用字段 → unobtained，否则 fail。（单调：不可用字段不会把本该 pass 的变成 unobtained。）
- **话题**：`text.hashtags` 的值集合与配置话题（去 `#`、归一化）做**整体相等**比较，`all` / `any` 同上；信号不可用 → unobtained。
- **时长**：取冻结快照的 `duration_state / duration_value / duration_unit`：`state ≠ value` → unobtained(`duration_missing`)；`unit ≠ seconds` → unobtained(`duration_unit_unknown`)；否则 `min ≤ 秒 ≤ max`（含边界，缺省端不限）。真实 0 秒是有效值。
- **图片分数**：分数字符串 → 整数百分位，`score_cents ≥ threshold_cents` → pass，否则 fail；信号不可用 → unobtained。
- **ASR 判定**：`meets` → pass；`not_meets` → fail；其余 → unobtained。

**层结果**（同层多条件）：`AND3`；**提前终止**：任一条件 fail → 层 fail，即使其余条件还在等；否则任一条件在等 → 本层仍待办；否则 `AND3`。

**逐层**：层结果为 pass 或 not_configured → 进入下一层；fail → `final = fail`，其后各层 `skipped`；unobtained → `final = unobtained`，其后各层 `skipped`。`final` 在内容停层或走完全部层时写入。

**第 1 层数量选择**（`layer1.quantity.n`）：

```text
selectLayer1(staff):
  rows = l1 = pass 的内容（已经满足全部文本 / 话题 / 时长条件）
  sort rows by:
    like_state = value 在前，按 like_value 降序；
    其余状态（missing / explicit_null / invalid / unsupported）在后；
    同组按 published_at 降序、content_id 升序
  if n 存在: selected = rows.slice(0, n)
  else:      selected = rows
  n 存在时写 layer1_rank（从 1 起）与 layer1_selected；n 缺省时全部 layer1_selected=true、rank=NULL；未选中的行 l2/l3 = skipped、final = skipped、reason = layer1_not_selected
  C1 = selected.length
```

- 点赞值来自冻结快照；真实 `0` 是有效值，非 `value` 的状态不当作 0；排序按专员各自进行；进入排序的行里点赞值状态非 `value` 的条数写入该专员 `reason_detail.like_not_value`；
- N 是整层唯一值；不按文本 / 话题能力分别计数；
- 数量结果同时作为内容达标方式 `at_least_n N`，N 缺省为 1（见 §7.6）。

### 7.5 同步完整谓词

只读 A 的 `sync_tasks`、`sync_batches`、`sync_checkpoints`。对每位参与专员的账号，窗口 `[from_utc, to_utc)`：

```text
L = 该账号 requested_action = 'fetch_content_list' 的任务，按 coalesce(finished_at, created_at) 升序（任何 purpose 的批次）
latest = L 的最后一条
sinceWin = L 中所属批次 logical_at ≥ from_utc 的任务

cp = sync_checkpoints 中该账号 action = 'fetch_content_list' ∧ checkpoint_scope = 'default' 的行（provider 为该账号所用的 aimaster）

按顺序判，首个不满足的给出原因：
 1. latest.status ∈ {failed, dead, cancelled} 或无任何 L                       → sync_failed
 2. latest.status = 'succeeded_with_gap'
    或 sinceWin 中有 status = 'succeeded_with_gap' / continuity_gap_detected
    或 cp.continuity_status = 'blocked'
    或 (cp.continuity_status = 'rebased_after_gap' ∧ cp.last_gap_at ≥ from_utc) → sync_gap
 3. sinceWin 中没有任何 status ∈ {succeeded}                                    → no_sync_in_window
 全部通过 → complete
```

（`succeeded_with_gap` 虽然在 A 的 `freshness` 里算「成功」，但它带着连续性缺口，对「确实没发」的断言必须判为 `sync_gap`，不能算完整。）

- 一次批量 SQL 对一批账号求值，不逐账号往返；
- 「窗口前发生的缺口不影响本窗口」；「最近一次失败」比「中间某次失败后来又成功了」更严重——后者检查点只在成功时推进，连续性没断；
- **比 PRD 字面宽松的一处**：PRD D-D14 写「窗口内的周期同步都成功」，这里允许「窗口内某次失败、之后又成功且无缺口」判完整。理由是检查点语义保证了连续性，但这是一个产品解释，单独登记在 §14 第 26 项；
- 谓词偏**保守**：拿不准就判不完整（未获取成功不惩罚专员）。`T > 0` 时只存不用（§14 第 7 项）；
- `ponytail:` 它依赖 A 的任务与检查点语义；A 若提供只读口应改调它（§14 第 11 项）。

### 7.6 达标方式与聚合（纯函数）

```text
evaluateMethod(m, P, U, F, T):                                  // 全部整数
  if T = 0: return ZERO                                         // 由调用方按零内容规则处理
  at_least_n(n): P ≥ n → success；P + U < n → not_met；else unobtained
  all:           F ≥ 1 → not_met；else U ≥ 1 → unobtained；else (P = T) → success
  any:           P ≥ 1 → success；else U = 0 → not_met；else unobtained
  ratio(bp):     P·10000 ≥ bp·T → success；(P+U)·10000 < bp·T → not_met；else unobtained

and3(xs): 任一 not_met → not_met；else 任一 unobtained → unobtained；else success     // 不达标优先
```

- **内容要求**（仅 `contentRequirementEnabled` 时计算）：对该专员每条参与内容行取 `final`：`pass` → P，`fail` → F，`unobtained` → U（含 `l0`、`l1`、`l2`、`l3` 任一层），`skipped` → 只计 `content_skipped`；`T = P + U + F`；**零内容 = 参与内容行数（T + content_skipped）为 0**，此时走零内容规则；`T > 0` 而 `P = 0` 时按 `at_least_n` 判（P + U < n → 不达标），不走零内容；方式固定 `at_least_n N`（N = `layer1.quantity.n` ?? 1），其他方式只用于评论；`l0 / l1` 的未获取成功不参与点赞排名但计入 U（不被静默排除）；
- **零内容规则**：`sync_complete` → `not_met`；否则 `unobtained`，原因 = `sync_reason`；
- **评论要求**：见 §7.7；**账号要求**：由 `layer2.abilities` 中 `target="avatar"` / `"background"` 的能力按阈值 AND，见 §7.7；
- **计划总结果** = `and3(已配置的 content / comment / account 结果)`；
- **主要原因** `primary_reason`：取第一个 `unobtained` 的类（content > comment > account）；内容类取 `final=unobtained` 行里条数最多的 `reason_code`（并列取字典序）；零内容取 `sync_reason`；`reason_detail` 存各类原因的计数；
- `stale_used`：该专员任一证据用了 `stale`；
- 属性测试：评论四种方式 × T ≤ 5 的 (P, U, F) 穷举与手写参照实现逐格相等；`ratio` 边界；内容 `at_least_n` 边界；`and3` 3×3 全表。

### 7.7 评论要求与账号要求

**评论**：

```text
C2(staff) = 该专员 l1 ∈ {pass, not_configured} ∧ l2 ∈ {pass, not_configured} 的内容    // 不依赖第 3 层
demand 阶段: C2 内容 → wants=['comments']
comments 阶段: 对每条 C2 内容
  dep.comments:
    ready      → 读 A 的一级评论（status=active）→ readMany(comment.text_normalized) → 逐条关键词求值
                 cm_total += n；cm_pass += 命中；cm_unobtained += 信号不可用者
                 覆盖 partial/unknown: 缺口 g = max(1, reportedTotal − fetchedCount)（总数已知）或 1；cm_total += g；cm_unobtained += g；原因 comments_incomplete
    failed / unsupported / content_not_found / timeout → cm_total += 1；cm_unobtained += 1；原因随 dep
聚合: T,P,U 累加；F = T − P − U
  T = 0:
     若该专员有参与内容在 L1/L2 ended unobtained → unobtained
     否则若该专员根本没有参与内容 → 零内容规则
     否则 → not_met           // 候选全部确定性地没通过，评论无从满足
  T > 0: evaluateMethod
```

**账号**：

```text
account_result(staff):
  assignment.slot_released_at ≠ NULL → unobtained(account_unavailable)
  无 current_profile_snapshot_id      → unobtained(no_profile_snapshot)
  否则 对 layer2.abilities 中 target='avatar'|'background' 的能力：
       whole_image   → account.avatar_template_score / account.bg_template_score
       image_element → account.avatar_element_score / account.bg_element_score + element_key
       分数 ≥ 阈值（整数百分位）→ pass；不可用 → unobtained；全部能力 and3
```

账号能力在 `scores` 阶段与封面能力并行请求和求值，不依赖内容层。`image_text` 不在 1.0。

### 7.8 依赖协调：分批、幂等、等待

- 分批：`requestScores` / `readMany` ≤ `HBECHO_JP_SIGNAL_BATCH`（≤ 5,000）；`demand.submit` ≤ `HBECHO_JP_DEMAND_BATCH`（≤ 5,000）；
- 幂等：`demand` 的 `demandKey = exec:{runId}:{l3|cm}:{n}`（`n` 为块序号，块划分由内容 ID 升序固定），重复提交得到同一批次；`requestScores` 对 C 本身幂等；
- `ruleDecisionId = run:{runId}`、`ruleVersion = {planId}@{version}`、`requester = { kind: 'judgement-plan', ref: String(planId), version: String(version) }`；
- `scopeFingerprint = sha256({run_id, plan_id, version, config_sha256})`，随 `requestScores` 透传给 C（C design §14 第 16 项）；
- 「在等」的判断见 §7.4；两类上限独立：`HBECHO_JP_WAIT_SIGNAL_SECONDS`（C 的补算与文本信号）、`HBECHO_JP_WAIT_DEMAND_SECONDS`（A 的采集）；上限从该阶段第一次进入时起算（记入 `phase_detail.wait_deadline`），重启不重置；
- 取消：不再提交新批次；已提交的由 A / C 自己跑完（共享，不浪费）。

### 7.9 向导进度、回退与发布协议

**失效矩阵**（草稿上改配置时）：

| 改了什么 | 圈定运行 | 试跑运行 | 进度回到 |
|---|---|---|---|
| `window`、`kinds`、`layer1.*`（含 `quantity`） | 删除 | 删除 | `draft` |
| 能力别名、`abilityId` | 保留 | 保留 | 不变（不进 `config_sha256`） |
| 第 2 层能力的**结构**（增删能力、改 `kind` / `target` / `elementKey`）、标准图 / 元素图 | 保留 | 删除 | `min(当前, circled)` |
| **阈值**（任何层）、评论达标方式、`layer3`、`commentRequirement` | 保留 | 保留（报告用当前阈值重算） | 不变 |

阈值虽然也写在 `layer2.abilities` 里，但归第三行：分数由 C 按复用键共享，换阈值只是换比较，不需要重新试跑。

**进度**：圈定成功 → `circled`；试跑成功 → `compared`；第 2 页无条件（`layer2.abilities` 为空）→ 圈定后即视为 `compared`。确认执行要求进度 ≥ 所需进度。

**回退**：`rollback(planId, apply)`：只对草稿；`compared → circled`（删除试跑运行）、`circled → draft`（删除圈定与试跑运行）；预览返回将删除的运行数与行数（`run_contents` 行数），`--apply` 才删除（分块、显式 DELETE）。已发布版本不能回退，返回 `version_immutable` 并提示 `new-draft`。

> 这与 PRD 字面「第 3 页回退到第 2 页」的差异：执行发生在发布之后，发布后的版本不可改（C-D10、D-D08），所以「回退」在发布后的唯一含义是「基于它开一个新草稿并落到目标页」，旧版本的执行结果按 D-D08「保留可查」。回退直接删除后续结果的 2026-10-30 决定，落在草稿的圈定 / 试跑结果上。待确认（§14 第 3 项）。

**发布协议**（`confirm`）：

```text
1 tx : 校验草稿（config、进度、signals.executability 的结果由调用方先取）→ version.status = publishing（draft_key 仍占位）→ 审计(high)
2 事务外: signals.segments.publish(ref)                       // C 事务内再校验；失败 → 回到 1 之前的状态（draft）并返回 blockers
3 tx : version.status = published, published_at；plans.latest_version 不变；INSERT 执行运行（idempotency_key 唯一）
崩溃恢复 reconcile: version.status = publishing → 查 C show(ref).status：published → 补第 3 步（幂等键防重复建运行）；draft → 回到 draft
```

**新建草稿**：`newDraft(planId, fromVersion?)`：`fromVersion` 缺省为最近已发布版本，**可指定任意已发布版本**（PRD §2.3「计划回退到某一版时，引用该版的标准图，不重新上传」）；前提是没有草稿、计划未归档 → 事务外 `segments.newDraft({fromVersion})` 得到版本号 `v` → tx：INSERT `(plan_id, v, draft, step=draft, config=来源版本配置, based_on_version=fromVersion)`；`v` 必须等于 `latest_version + 1`，否则报 `version_mismatch` 并停止（不静默对齐）。

### 7.10 试跑报告

`trialReport(runId)`：从 `run_contents.evidence.l2` 取每个条件的分数（字符串 → 整数百分位）：

- 分布：11 档，档 `k` = `[k, k+1)`（k = 0..9），档 10 = `[10.00]`；
- 样例：每档至多 5 个内容 ID（按内容 ID 升序取，确定性）；第 2 页的样例槽位固定为 5 个。
- 通过数：用**当前**阈值对分数重算（换阈值无需重新试跑）；
- 未获取成功条数与原因分布。

### 7.11 对 E 的读取口与解释

- `listCompleted(after, limit)`：`run_kind='execution' AND status='completed' AND (completed_at, run_id) > (after.completedAt, after.executionId) ORDER BY completed_at, run_id`。**游标是完成时间 + ID，不是 `run_id`**：不同判定计划的执行并行，完成顺序与创建顺序无关，按 `run_id` 会让 E 的游标越过尚未完成的较小 ID 而永远漏掉它；游标由 E 持有。`completed_at` 在 `finalize` 的事务里取值，提交先后仍可能与取值先后相差毫秒级，所以建议 E 每次从游标回退一小段重叠窗口再读，靠 E 自己的幂等键（执行 ID，E-D11）去重；
- `streamParticipants / streamContents`：游标分页（主键升序），按冻结组织链与 `ResourceConstraint` 过滤（`empty` → 空；`brands / branches` → 对应列；`self` → `staff_id`）；
- `explain(executionId, {contentId | staffId})`：读 `run_contents.evidence` / `run_participants.*`，逐层逐条件输出；调用方需 `rule.definition.read` + 对该专员 / 内容的 `data.content.read` 范围；
- `streamCircleRows(runId, constraint)`：圈定运行的行（含未通过 / 未获取者及其结果、`layer1_selected` / `layer1_rank`），供 E6 生成第 1 页下载；
- 以上函数只读，不创建任务，不调 C、A。

### 7.12 下游端口与清除

```text
summarize(activityPlanId): judgementPlans = COUNT(plans)；results = SUM(参与专员行，仅 run_kind='execution' 且 status='completed'；圈定 / 试跑的试验数据不算业务结果)；running = COUNT(runs WHERE status IN planned/running/waiting)
onDeleted / onRestored: 幂等空操作（以 activity_plans.status 为准）；可记一条审计
purge(activityPlanId):                                  // 事务之外；幂等；失败抛出
  for each plan: signals.segments.purge(planId)          // C 删 OSS 对象与行（幂等）
  分块显式 DELETE: run_contents → run_participants → judgement_runs → judgement_plan_versions → judgement_plans   // 每块一个事务
```

### 7.13 保留与清理

- `circle` / `compare` 运行：`expires_at = created_at + HBECHO_JP_TRIAL_RETENTION_DAYS`；每日 `maintain` 删除期满者，也随草稿回退 / 重新圈定 / 清除删除；
- `execution` 运行：行本身与 `run_participants` **长期保留**；`run_contents` 只保留每个（判定计划，版本）最近 `HBECHO_JP_KEEP_CONTENT_RUNS` 个已完成执行，更早的由 `maintain` 分块删除内容级行（`streamContents` 对它们返回 `content_rows_pruned`）；
- 取消 / 失败的执行：`HBECHO_JP_FAILED_RETENTION_DAYS` 后清理其内容级行；
- 清理分块、幂等、可重复运行。

## 8. Failure semantics

| 场景 | 行为 |
|---|---|
| 名单账号解析到同一专员 / 无专员归属 | 冻结失败，运行 `failed(participant_conflict / no_staff_assignment)`，不产生半截参与专员 |
| 内容发布时间缺失 / 形态无法归类 | 参与但 `l0=unobtained`，计入 T 与 U |
| 内容无 finalized 当前快照 / 非 active | 不入 T，计数可见 |
| 文本信号 `not_computed` | 在等；超过信号等待上限 → `dependency_timeout` |
| 素材 `pending / failed / carried_forward`、无主页快照、音频未归档 | 终态未获取成功，C 的原因码，不触发采集 |
| 候选图 / 音频确定性失败（C 的 `failed`） | 未获取成功（不是不通过） |
| C 的 `capability_disabled`（执行中途） | 该层剩余内容 `capability_disabled`，不发调用 |
| 发布 / 开始执行时 `executability` 不可执行 | 拒绝并返回 blockers，不改状态 |
| A 的需求 `content_not_found / unsupported_platform / capability_disabled / out_of_scope` | 该内容对应层 / 评论未获取成功，原因随需求 |
| A 的需求超过采集等待上限 | `dependency_timeout`，运行继续 |
| C / A 的瞬时异常 | 阶段退避重试；超过 `PHASE_MAX_ATTEMPTS` → 运行 `failed`，可 `resume` |
| 陈旧 worker 写入 | fencing 校验失败，零写入，行不变 |
| 同版本已有未终态运行 | `run_active`（`active_key` 唯一键）；同幂等键返回已有运行 |
| 提交人被停用 / 撤权 | 下一个 tick 取消运行，审计 `submitter_revoked` |
| 发布时 C 拒绝 | D 回到 `draft`，返回 blockers |
| D 已落行、C 未建段 | `provisioning`；`reconcile` 补齐 |
| `newDraft` 版本号与 C 不一致 | `version_mismatch`，停止，不静默对齐 |
| `purge` 中途失败 | 抛出，A 不清除活动计划；重试幂等 |
| 授权失败 | 读库之前拒绝；越范围对象表现为未找到 |
| E 读取未完成 / 取消 / 失败的执行 | 错误 `execution_not_completed` |

**不吞错**：任何路径都不把依赖失败写成「不通过」，不把「没拿到」写成 0，不把 `capability_disabled` 当成不达标，不把采集失败当成「没发内容」。

## 9. Authorization seam 与 CLI

```ts
// D 的授权入口：B 的 authorize（与 learning 同一做法）
await authz.require(ctx, 'rule.definition.manage', { key: 'judgement_plan', ref: planRef, predicates: ['plan_creator'] });
type JudgementPlanRef = { brandId: bigint; branchIds: readonly bigint[]; planCreatorActor: string };
```

- `judgement_plan` 的 `ScopeStrategy.contains(scope, ref)`：品牌 ∈ `scope.brands`（或 `all`）∧（`scope.branches = 'all'` ∨ `ref.branchIds` 中有一个 ∈ `scope.branches`）；`branchIds` = 所属活动计划已加入（`joined`）的分公司；
- `plan_creator` 谓词体：`ctx.platformAdmin ∨ ctx.actor === ref.planCreatorActor`；装配处先查再注册；
- **继承提交人身份**（不新增服务身份）：运行存 `submitted_by_actor = user:<id>`；每个 tick 用 B 的 `contextForUser(userId, null)` 现建 `AuthContext`（B 的注释写明这是给用户触发的后台任务用的入口）。D 自己的函数用这个 ctx 走 `authorize`；
- `toDemandActor(ctx)`：A 的 `ActorContext`（`{ actorId, capabilities, platformAdmin, scope: { platformCodes, mediaStaffIds } }`）没有品牌维度，B 的 `toTracerActor` 只给「全品牌、全分公司、无本人范围」的用户适配，品牌受限的 `hq_manager` 会被拒。D 的窄适配：`actorId = ctx.actor`、`capabilities = ctx.capabilities`（必须含 `data.sync.trigger`）、`platformAdmin = (ctx.role = 'platform_admin')`、`scope = { platformCodes: 'all', mediaStaffIds: 'all' }`；放宽只发生在这一处，且 D 提交的主体只来自已冻结的、提交人已授权范围内的名单，不会因此多采集；这是对 B「只收窄不放宽」原则的一处有意偏离，登记在 §14 第 31 项，待 A 的 `ActorContext` 补品牌维度后改回 B 的适配器；
- `toSignalActor(ctx)`：把 `AuthContext` 译成 C 的 `SignalActor`（`actor`、`capabilities`，`brandScope` 把品牌 ID 译成品牌编码，译不了就拒绝，不降级）；D 调 C 的所有函数都用它；
- CLI 身份：只有 `HBECHO_JP_ACTOR=user:<id>`，CLI 用 `contextForUser` 取该用户当前的 `AuthContext`，走与页面相同的 `authorize`——CLI 没有任何绕过，也没有自带 Capability / 范围的环境变量；`actor` 不是 `user:<id>` 一律拒绝启动；测试注入 fake 解析器；
- 审计：B 的 `AuditWriter`，高风险事件与业务写入同事务（`tx` 传入）；
- 提交人复核：每个 tick 的 `contextForUser` 本身就是复核（用户非 active、专员失效、范围无法解析都返回失败）；再检查 ctx 仍持有该类运行所需的 Capability。

### CLI 命令

```text
judgement plan create --activity-plan <id> --alias <名> [--description <说明>]
judgement plan show <planId> | list [--activity-plan <id>] [--status <状态>]
judgement plan archive|unarchive <planId>
judgement plan reconcile [--plan <id>]
judgement config show <planId> [--version <n>] | set <planId> --file <config.json>
judgement image put <planId> --kind template|element --target cover|avatar|background [--element-key <k>] --file <路径>
judgement image remove <planId> --kind … --target … [--element-key <k>]
judgement circle <planId>
judgement trial <planId> [--wait] | trial-report <runId>
judgement rollback <planId> [--apply]
judgement new-draft <planId> [--from <已发布版本>]
judgement confirm <planId> --key <幂等键> [--apply]      # 无 --apply 只预览：将发布的版本与阻塞项
judgement execute <planId> --key <幂等键>                # 对最近已发布版本重新执行
judgement run show <runId> | list --plan <id> | cancel <runId> [--apply] | resume <runId>
judgement result summary <executionId> | participants <executionId> [--result …] | contents <executionId> [--staff <id>] [--final …] | circle <runId>
judgement explain --execution <id> (--content <cid> | --staff <sid>)
judgement serve                      # 常驻：领取运行 + tick + 每日 maintain
judgement maintain --once
```

输出一行 JSON；BIGINT 十进制字符串；退出码沿用 `plan-cli`（0 成功 / 2 校验或授权 / 3 冲突 / 4 不存在 / 5 超限 / 1 其他）；`parseArgs` strict；没有 `--force`、`--skip-auth`；身份来自 `HBECHO_JP_ACTOR / CAPABILITIES / BRAND_SCOPE / BRANCH_SCOPE / PLATFORM_ADMIN`，缺任一项启动失败。

## 10. 对既有代码与依赖的改动

### 10.1 改动清单

| 位置 | 改动 | 类型 |
|---|---|---|
| `src/db/schema/index.ts` | `export * from "./judgement"` | 导出 |
| `drizzle/NNNN_*.sql` | 新表与索引；**编号取实施时的下一个空号**（`main` 当前最大 0010；0011 是 C 在 `c-signals` 分支上的迁移，尚未合并——D 从 `main` 切分支会生成 0011，与 C 撞号，C 先合入则 D 重新生成；不预占） | 新增 |
| `src/worker/plan-main.ts`（及将来的页面进程装配） | 构造 `createJudgement(...)` 并把 `downstream` 传给 `createActivityPlan` | 装配 |
| `package.json` | `"judgement": "tsx src/worker/judgement-main.ts"` | 脚本 |
| `.env.example` | 新增变量名（无值）：`HBECHO_JP_*` | 配置 |
| `src/acceptance-boundaries.test.ts` | 五条静态护栏 + 反向用例 | 测试 |
| `scripts/check-doc-registry.py` | `DESIGN_ONLY_SPECS` 去掉 `rule-engine`（任务 0 归档旧 design 时） | 脚本 |
| `CONTEXT.md` | 增 JudgementExecution 一条词汇（任务 0） | 文档 |
| `INDEX.md`、`prd-domain-d-rule-engine.md`、`prd-domain-c-signals.md`、子 PRD 草案、`metrics-and-dashboard/design.md` | 旧路径链接改到新目录或归档位置；PRD D §七第 6 行闭合（任务 0） | 文档 |

- 无新依赖：JSON 校验用已有 `zod`；规范化哈希用 `canonical-json`；CLI 用 `node:util`；
- 不改 A 的任何表与模块；不改 `orchestrator`、`demand`、`activity-plan`（只用其导出）；
- 静态护栏的扫描范围是 `src/modules/judgement/**` 的非测试文件（排除 `facts.ts` 对 A schema 的只读 import，该文件在白名单内）。

### 10.2 D 为 A 提供的东西

`PlanDownstream` 的实现（JP-17）。`plan-main.ts` 目前没有传 `downstream`，D 落地时补上；E 也需要一个下游（清理投影），所以装配处用一个**组合下游**（按顺序调用，任一失败整体失败）。

### 10.3 对 C 的对齐请求

C 的 design §14 第 11 项把「监控段 / 读取口 / 补算请求的 API 形状」留给本 spec 关闭，条件是「C 先实现并以契约测试固定，D 开工时对齐，必要时回来修订，不在 D 里另造一份」。D 需要（除第 11 条把「能否执行」的判定限定在 `only` 的信号内、属于语义细化外，均为形状）。**2026-11-16 起 C 已合入 `main`，下表是初建时的请求原文，逐条复核结果见表后「对照 main 的复核」；以复核结果为准，D 适配 C，不要求 C 为 D 改形状。**

| # | 请求 | 原因 |
|---:|---|---|
| 1 | `segments.create` 幂等：已存在且平台相同返回 `{ created: false }`，平台不同报 `segment_exists` | JP-1 的 provisioning 恢复 |
| 2 | `segments.show` 返回 `{ status, items, images: [{kind, target, elementKey, sha256}] }` | `reconcile`、发布前校验 |
| 3 | `executability` 返回 `{ executable: boolean, blockers: [{ signal, code }] }` | JP-3、JP-12 的阻塞项展示 |
| 4 | `SignalValue.score` 为**两位小数字符串**（或整数百分位），不用 JS 浮点；`value`：文本 `string`、话题 `string[]`；判定 `{ verdict: 'meets' \| 'not_meets', reason, model, promptVersion }` | 阈值比较与证据，C 的 `DECIMAL(4,2)` 存储本来就是定点 |
| 5 | `readMany` 返回 `Map<string, SignalValue>`，键 `${kind}:${id}` | 避免 bigint 作 Map 键的引用比较问题 |
| 6 | `RequestResult.items[]` = `{ subject, disposition: 'queued' \| 'reused' \| 'not_applicable' \| 'missing' \| 'disabled', reason? }` + `needMedia` | D 区分「在等」与「终态」 |
| 7 | `segments.newDraft` 返回新版本号 | JP-3 的版本一致检查 |
| 8 | `stalePolicy` 取值字面量 `'use_stale' \| 'as_unknown'`（D 只用前者） | C requirements SG-10 |
| 9 | D 的 `FakeSignals` 与 C 的真实实现**共用同一份契约测试**（`tests/contracts/signals-port.contract.ts`） | 防止两边悄悄分叉 |
| 10 | 服务身份：C 文档里的 `service:signals-worker` 同样不在 B 的 `SERVICE_PRINCIPALS`——属于 C 的任务，这里只提醒 | 与 R4 同类 |
| **11** | **（已满足）`requestScores` 与 `executability` 都增加 `only: string[]`（本次只补算 / 只检查这些信号键），`not_executable` 的判定只看 `only` 里的信号。** 现状是对监控段 items 里的**全部**信号逐主体处理且整段不可执行就整批拒绝 | 没有它，第 2 层的请求会为 C1 全部内容连带建 `content.asr_judgement`（付费）任务，包括随后在第 2 层不通过的内容，违反 PRD「第 2 层未获取成功的内容不进入第 3 层、不发起 ASR 调用」；整段拒绝还会让「ASR 能力中途丢失」连带阻塞第 2 层的免费比对。~~**这条优先级最高，应最先发给 C 的实施会话**~~ 2026-11-16 复核：`main` 上已有（见复核表） |
| 12 | `requestScores` / 读取口在段不可执行时返回稳定码 `not_executable` 与 blockers（而不是逐主体的 `capability_disabled`） | D 在 `layer3` 前重调 `executability`、捕获 `not_executable` 把剩余内容记 `capability_disabled`（§7.2） |
| 13 | 账号类信号的 `SignalValue.evidence` 带所用主页快照 ID 或素材 `sha256` | D 记录账号要求实际用了哪一版素材（§12 已知限制：C 按读取时的 `current_profile_snapshot_id` 取素材，D 无法替它固定） |
| 14 | `segments.newDraft({ fromVersion })` 接受**任意已发布版本**，不限最新版本，并复制该版本的信号集合与图片字节 | `new-draft --from`（PRD §2.3「回退到某一版」） |

**对照 `main` 的复核（2026-11-16）**：

| # | 结论 | D 的处理 |
|---:|---|---|
| 1 | **不同**：`segments.create` 重复创建抛 `segment_exists`，不返回 `created:false` | D 的 `reconcile` 捕获 `segment_exists` 后用 `show` 核对平台一致即视为成功 |
| 3 | 近似：`blockers` 是 `{ code, signal?, detail? }` | `SignalsPort` 已按此形状（§4.1） |
| 4 | **不同**：`SignalValue.score` 是 `number`（来自 `DECIMAL(4,2)`，恰为两位小数） | D 在读取边界唯一一处 `Math.round(score * 100)` 转整数百分位，之后全部整数比较；证据存两位小数字符串 |
| 5 | **不同**：`readMany` 返回 `Map<bigint, SignalValue>`（一次调用的主体种类相同，键是主体 ID） | `SignalsPort` 已按此形状 |
| 6 | **不同**：`RequestResult.items[] = { signal, elementKey?, subjects: [{ id, disposition, reason? }] }` + `needMedia` + `tasks` | D 的 `deps.ts` 适配这个形状 |
| 7、8、14 | 已满足：`newDraft` 返回含版本号的 `SegmentKey`；`StalePolicy = 'use_stale' \| 'as_unknown'`；`newDraft({ fromVersion })` 可指定任意已有版本 | — |
| 11 | **已满足**：`RequestContext.only` 与 `executability(actor, ref, { only })`，`not_executable` 只看 `only` 内的信号 | `SignalsPort` 调用必传 `only` |
| 12 | 已满足：段不可执行时抛 `SignalError('conflict', 'not_executable', …, blockers)` | D 捕获该码 |
| 2、9、10、13 | 未逐项核对 | 任务 12 的契约测试里确认；`SignalValue.evidence` 目前类型为 `unknown`，第 13 条能否满足待核对 |

### 10.4 对 E 的对齐请求

| # | 请求 | 原因 |
|---:|---|---|
| 1 | E 的 spec 采用 `JudgementOutcomeReader`（JP-16），弃用 `RuleOutcomeReader / OutcomeSet / ItemOutcomeFact` | PRD D v1.1 没有考核项与 item→run 映射 |
| 2 | `AttributionSnapshot` 的 owner = D 的 `run_participants`（冻结组织链）；E 只读不建 | E PRD 修订清单第 9 项要求在 E spec 开工前定 |
| 3 | 完成通知用轮询（`listCompleted` 游标），事件机制 2.0。E 每次从游标回退一段重叠窗口再读（建议 ≥ 1 分钟，大于 D `finalize` 事务的最长时长），靠执行 ID 幂等去重；该数值写进 E 的 spec，不留给 E 猜 | 与 C、A 一致 |
| 4 | 判定结果下载与第 1 页圈定下载经 E6，Capability = `report.export`；E6 的执行者按提交人范围 ∩ 执行时范围复核 | E-D04、B 的出口守卫 |
| 5 | `ContentFact.final` 增加 `skipped`（第 1 层未被选中，原因 `layer1_not_selected`），并带 `layer1_selected` / `layer1_rank`；E 的 C1 = 被第 1 层选中的条数，不再是「通过第 1 层的全部条数」；E 的明细 / 导出与投影的 `final` 枚举要同步 | 2026-11-13 第 1 层数量要求（D-D18）；E 的 spec 里 `l1/l2/l3/final` 枚举需加 `skipped` |
| 6 | `ExecutionDescriptor` 带能力的 `abilityId / kind / target / 别名`；E 的点检表仍按判定计划分组，**不按能力分列**（E-D16 / E-D21），能力别名只用于明细与导出的列头 | PRD D-D20 的显示位置（2026-11-16 补充） |

## 11. Testing strategy

| 层 | 内容 |
|---|---|
| `unit`（纯函数） | `and3` 全表；`evaluateMethod` 四种方式 × (P,U,F,T) 穷举对照参照实现；零内容；条件求值（关键词的单调性、话题整体相等、时长边界与单位、分数阈值整数比较、ASR 结论映射）；`fromSignal` 每个分支；窗口换算（北京日→UTC 半开区间，含 `to` 缺省）；配置 zod（每条校验规则一例）；规范化哈希稳定性；分布分档（0.00 / 9.99 / 10.00）；`items` 推导 |
| `db`（真实 MySQL） | 全部 CHECK 与唯一键（`draft_key`、`active_key`、`uq (run_id, staff_id)`、复合外键）；plans / versions 状态机与 C 的 provisioning（fake `SignalsPort` 故障注入）；冻结（改绑 / 移出 / 换店 / 同专员冲突）；范围构建（NULL 发布时间、unknown 形态、非 active、无快照）；阶段机的续跑（逐阶段杀进程）；租约与 fencing；`active_key` 并发；取消；提交人复核；聚合落库；Outcome 流式读取与范围约束；`purge` 分块与幂等；保留清理；回退预览 / 执行 |
| 契约（面向 C / A / E） | `SignalsPort` 契约测试（fake 与真实共用）；`DemandPort` 对真实 `demand` 模块（离线 fake transport）；fake E 消费者走 `listCompleted → describe → streams`；`PlanDownstream` 的调用时机（记录调用顺序的 fake 对照 A 的 `plans.remove` / `maintenance`） |
| 静态 | 五条护栏（JP-21）；`drizzle-kit generate` 无新文件 |
| 离线 | `network-deny` 沿用；`FakeClock`；fake `SignalsPort`、fake `DemandPort`、fake 授权 / 审计 |

- 同一用例里的争抢同一行锁的操作顺序 `await`，不用 `Promise.all`；并发用例用显式闸门；
- 测试数据工厂放 `tests/harness`：造活动计划 + 名单 + 账号 + 内容 + 快照 + 信号值；
- 规模演练（任务 12）：2,000 名单账号 × 平均 20 条内容 = 40,000 行，记录各阶段耗时与内存，填 §12.1。

## 12. Explicit non-goals and known limits

- 离线验收不替代页面验收；页面按 §15 的已确认界面实现，页面任务见 tasks.md；图片文字对比 / OCR 是 2.0，1.0 不启用；
- 新建草稿后向导进度归零，圈定与试跑要重做（圈定同步、试跑因 C 结果共享而不重复付费，成本低）；
- 点赞会随同步变化：圈定条数是圈定当时的快照，执行时重新冻结，两者的前 N 集合可能不同；
- 同步完整谓词（§7.5）读 A 的任务与检查点表，A 改语义时要同步改 `facts.ts`；
- `run_contents` 随执行次数线性增长，靠 `KEEP_CONTENT_RUNS` 控制；`ponytail:` 单计划每周执行、保留 5 次时约 5 × 4 万行 / 计划；
- 评论按计数而非逐条落库，无法在 D 里重放「哪几条评论命中」之外的细节（证据里只有至多 3 个评论 ID）；
- 执行是单 worker 顺序处理各阶段；吞吐受 A 的采集速度（QPS≈2）和 C 的评分并发限制，不受 D 限制；
- 不阻止 A 在执行期间修改名单（§14 第 4 项）；结果以冻结为准；
- **账号要求使用的主页素材无法由 D 固定**：C 按读取时的 `current_profile_snapshot_id` 取头像 / 背景，执行跨越采集等待（最长数小时）期间指针可能移动，账号要求结果不能保证逐字节复现。内容类结果不受影响（内容快照已冻结）。靠 §10.3 第 13 条让 C 回报实际素材指纹，D 记入 `account_detail`；
- `config_sha256` 对数组顺序敏感：重排关键词会被当作配置变化，触发失效矩阵（语义可接受，页面应提示）；
- `provisioning` 的 `reconcile` 清除顺序：先删该计划的版本行，再删计划行（外键 RESTRICT）；C 侧若已建段则先 `segments.purge`。

### 12.1 规模演练与实施发现

（任务 12 回填。）

## 13. Decision records

状态列：`proposed` = 本 spec 建议；`prd` = 上游已定。

| # | 决定 | 理由 | 否决的备选 | 状态 |
|---|---|---|---|---|
| JP-D01 | 一个 spec 覆盖判定计划、配置、圈定、试跑、执行、聚合、对 E 的输出 | 它们共用同一份冻结输入与同一个引擎；拆开后引擎要重复或被迫先建「公共」spec | 按页面 / 层拆（引擎被切开） | proposed |
| JP-D02 | 圈定、试跑、执行共用一个引擎，差别只在「走到哪个阶段」 | 同一份逻辑才能保证圈定条数 = 执行时 C1 条数；少一份重复 | 圈定另写一套 SQL（会与执行漂移） | proposed |
| JP-D03 | 运行表即队列：`judgement_runs` 带租约与 fencing，不另建任务表 | 运行数量很少（每周几个）；阶段进度本来就要持久化在运行上 | 复用 `sync_tasks`（要伪造批次与供应商）；仿 C 建 `judgement_tasks`（多一张表、多一层） | proposed |
| JP-D04 | 每个阶段用「行上的 NULL 标记」作待办，而不是另存待办列表 | 崩溃续跑天然成立；没有「列表与行不一致」 | 内存队列（崩溃丢进度）；另表（要同步） | proposed |
| JP-D05 | 第 3 页确认执行即发布；草稿存在即发布为新版本，无草稿 = 对最近版本重新执行 | PRD 的向导里没有单独的「发布」步骤，D-D08 又要求版本只由发布产生；这样版本只在用户改过配置后才增长 | 每次执行都升版（违反 D-D08）；单独加「发布」按钮（PRD 没有） | proposed（§14 第 2 项） |
| JP-D06 | 回退只作用于草稿；发布后改配置 = 新建草稿 | 已发布版本不可变（C-D10）；旧版本结果保留可查（D-D08） | 回退删除已发布版本的执行结果（E 的投影、点检表会悬空） | proposed（§14 第 3 项） |
| JP-D07 | 配置里的时间窗独立于活动计划日期 | PRD §2.2 把时间窗列为判定计划的条件；活动计划日期可编辑，不应让已发布版本的口径随之漂移 | 引用活动计划日期（编辑活动计划会悄悄改历史口径） | proposed（§14 第 5 项） |
| JP-D08 | 一次冻结：名单、当前归属、组织链、窗口、内容快照 | 可复现；E 要冻结的归属；`data-discipline` 纪律 5 | 执行中沿 current 指针读（结果随同步漂移） | prd（PRD §2.0.1）+ proposed（组织链归 D） |
| JP-D09 | 归属取 `staff_account_assignments.staff_id`（当前），不取名单项的 `staffId` | `rebind` 只改前者；PRD「按执行时的归属算」 | 取名单项（改绑后算到旧专员） | prd |
| JP-D10 | 发布时间缺失 / 形态无法归类的内容「参与但未获取成功」 | 它们可能属于窗口；排除会悄悄缩小分母，纳入为「不通过」会冤枉专员 | 一律排除；一律当不通过 | proposed（§14 第 6 项） |
| JP-D11 | 层求值用单调三值逻辑，层内提前终止 | 任一条件已 fail 就不必等其余依赖；不可用字段不能把本该 pass 的变成 unobtained | 等所有条件再合成（白等） | prd + proposed |
| JP-D12 | 达标方式与比较全部整数运算：阈值整数百分位，比例万分比 | `data-discipline` 纪律 3；浮点边界会让「恰好等于阈值」不稳定 | 浮点比较 | proposed |
| JP-D13 | 同步完整谓词对每位专员都算并存，`T>0` 时不改三值 | PRD 只在零内容用它；存下来既可提示又为日后扩展留口 | 现在就扩展（改 PRD 语义，需要决策人） | proposed（§14 第 7 项） |
| JP-D14 | 执行前 `executability` 不可执行即拒绝（发布与开始执行） | 用户立刻看到原因，不花钱；中途丢失才记未获取成功 | 一律放行并全部记未获取成功（业务以为跑了，结果全是空） | proposed（§14 第 8 项） |
| JP-D15 | 评论按计数落库，覆盖不全的缺口计入 U | 评论量大；缺口计入 U 才不会把「没抓全」判成不达标（D-D05） | 逐条落库（行数爆炸）；忽略缺口 | proposed（§14 第 9、10 项） |
| JP-D16 | 对 C / A 的调用一律事务外，且只在 `engine/deps.ts` 与 `versions.ts` | `data-discipline` 纪律 2 | 事务内调用（锁堆积） | prd |
| JP-D17 | ~~D 调 C / A 用服务身份 `service:judgement`~~ —— **2026-11-16 修订（刘学奎采纳）**：D 的后台运行继承提交人身份；每个 tick 用 B 的 `contextForUser` 重建，失败即取消；对 A 的 `ActorContext` 用 D 的窄适配（§9） | B 已写明「用户触发的后台任务继承提交者身份、不用服务身份」；不改 B；调用范围受提交人限制；`demand` 幂等作用域因提交人固定而稳定 | 新增 `service:judgement`（要改 B，且 D 检查出错时后台可越权）；把页面会话透传（异步执行时会话可能已失效） | 刘学奎（§14 第 14 项） |
| JP-D18 | 写操作要求「活动计划创建者或超管」，读按 B-D21 | PRD「只能选本人创建的活动计划」，每次复核最简单 | 引入「判定计划负责人」新概念 | proposed（§14 第 13 项） |
| JP-D19 | 同（计划，版本）至多一个未终态运行，`active_key` 唯一键 | 防止重复点击、重复付费；沿用 C 的 `active_key` 写法 | 应用层检查（竞态） | proposed（§14 第 15 项） |
| JP-D20 | 失败子集重试 = 续跑 + C / A 的复用，不做专门模式 | 效果等价且少一条代码路径 | 专门的「只重跑未获取成功行」模式 | proposed（§14 第 16 项） |
| JP-D21 | D 提供组织链冻结（AttributionSnapshot），E 只读 | E 需要冻结的归属，D 本来就要冻结参与专员 | 由 E 再冻结一份（两份可能不一致） | proposed（§14 第 17 项） |
| JP-D22 | 不阻止 A 修改名单，只冻结 | A 没有钩子；冻结已达到「结果可复现」的目的 | 给 A 加 D 的锁端口（侵入 A，且 A 已合并） | proposed（§14 第 4 项） |
| JP-D23 | 数值类配置没有代码默认值 | 宪法 C18；起始值写文档 | 代码里写默认值（会被当成合同） | prd |
| JP-D24 | 第 1 层数量要求是**整层共享的一个 N**；先按全部条件 AND 过滤，再按点赞降序取前 N 条进入下一层；N 同时是 `at_least_n N` 的达标门槛 | 用户 2026-11-13 定；多个文本 / 话题能力不各自计数；点赞排序减少下一层处理量 | 每个能力各自 N / 只做上限 / 只做门槛 | 刘学奎（2026-11-13） |
| JP-D25 | 第 2 层改为 `abilities[]`：整张图片对比 / 图片元素对比，每个能力带 `target=avatar|cover|background`；图片文字对比是 2.0，1.0 不启用 | 统一对象与能力，不再用固定封面 + 账号要求两套结构；C 1.0 没有 OCR | 保留旧 `template/elements/accountRequirement` 四套结构 | 刘学奎（2026-11-13） |
| JP-D26 | 内容达标方式由 `layer1.quantity.n` 固定为 `at_least_n N`（缺省 1）；`all/any/ratio` 只留给评论要求 | UI 已移除计划级方式；数量 N 是业务门槛 + 截断；避免两处配置 | 继续保留计划级方式卡 | 刘学奎（2026-11-13） |
| JP-D27 | 能力别名随版本保存但不参与 `config_sha256`；改别名不触发重新圈定 / 试跑 | 别名只影响显示（点检表 / E 列头），不影响判定；避免为改名付重算成本 | 别名纳入哈希（会强制重跑） | 刘学奎（2026-11-13） |
| JP-D28 | 内容要求的启用规则：第 1 层有条件、或设置了 N、或第 2 层有封面能力、或有 ASR 即启用；否则内容结果为 NULL | 绝大多数计划只考核「发了几条带指定话题的内容」；只考评论 / 账号的计划不应被多加一条「至少 1 条内容」 | 一律启用内容要求（只考账号会被额外要求发内容）；用显式开关（多一个配置项且易与条件不一致） | 刘学奎（2026-11-16） |
| JP-D29 | N 只依附文本 / 话题能力；删掉最后一张文本 / 话题卡片时一并清掉 N，不弹提示；无文本 / 话题能力不能保存 N | 原型里 N 没有独立位置；隐藏的 N 会在业务看不见时截断内容 | N 提到「第 1 层能力」区头（要重新确认界面，留待有「只考发布数量」需求时再议） | 刘学奎（2026-11-16） |
| JP-D30 | 内容要求的 P / U / F 取每条参与内容的 `final`；`unobtained` 含任一层；`skipped` 单独计数；零内容 = 参与内容行数为 0 | 初稿的 T 漏掉第 1 层不通过 / 未获取的内容，会把 N=3、2 条通过 + 1 条未获取误判不达标，并把「没命中话题」误走零内容分支 | T = 选中 + `l0` 未获取（初稿） | 审查修订（刘学奎 2026-11-16 采纳） |
| JP-D31 | 取前 N 按专员各自计算；N 既是上限也是门槛，「至少 N 条」等价于「这 N 条全通过」，不替补 | D-D18 的直接结果；PRD 已写明 | 门槛与截断条数拆成两个数 | 审查修订（刘学奎 2026-11-16 采纳） |
| JP-D32 | `abilityId` 稳定标识 + 上传时由 D 以字节 SHA-256 写入 `elementKey`；换图换 key、同 `target` 相同字节拒绝 | 别名可空可重名，证据与 E 需要稳定的能力指代；C 的 `element_key` 是业务标识，D 来生成 | 用户填 `elementKey`；以数组下标指代能力 | 审查修订（刘学奎 2026-11-16 采纳） |

## 14. Open items

「建议」列是本 spec 的默认做法；**评审通过前不得被代码或示例默认冻结**（宪法 C18）。

> **2026-11-16 答复（刘学奎）**：第 2、3、4、7、8、26 项及其余标「刘学奎」的项**全部按建议采纳**；第 14 项改为「继承提交人身份」；第 28–30 项已采纳；第 31 项按默认继续、待确认。标「外部」的项（17、21、23、24）转交各自所有者，不阻塞任务 1、3。标「刘学奎」的是产品 / 取舍类，标「外部」的是别的 spec 的所有者。

| # | 问题 | 影响 | 建议 | 谁来定 |
|---:|---|---|---|---|
| 1 | 旧 `rule-engine/design.md` 被本 spec 取代：初建时只在其文首加了说明；闸门通过后（任务 0）移到 `HBECHO设计方案/archive/`，并修复 4 处链接与登记脚本 | 文档结构；涉及 PRD C、E 的 design 等别的会话在编辑的文件 | 同意 | 刘学奎 |
| 2 | 「发布」落在第 3 页确认执行：草稿存在即发布为新版本；无草稿 = 对最近版本重新执行（§1.4 第 1 项） | 版本何时增长；页面上要不要单独的「发布」按钮 | 同意 | 刘学奎 |
| 3 | 回退只作用于草稿；发布后改配置 = 新建草稿；已发布版本的执行结果不因回退删除（§1.4 第 2 项） | PRD 字面「第 3 页回退到第 2 页，删除后续结果」 | 同意；若坚持字面，则「回退已发布版本」要删除该版本的全部执行结果，E 的投影与点检表会悬空，需要 E 先定义「结果被删」的呈现 | 刘学奎 |
| 4 | 「执行期间名单锁定：运行中不允许修改本计划的名单」：A 没有钩子，D 只冻结不阻止 | 字面要求未实现；结果的可复现性不受影响 | 接受冻结语义；若必须阻止，需要 A 提供 `isRosterLocked` 端口并让 D 实现（改 A，已合并） | 刘学奎 + A |
| 5 | 时间窗是判定段配置，创建时拷贝活动计划起止日，之后脱钩 | 活动计划改日期不影响已建判定计划 | 同意 | 刘学奎 |
| 6 | 参与内容边界：发布时间缺失 / 形态无法归类 → 参与但未获取成功；`status≠active` 与无当前快照不入 T 但计数可见；`image` 与 `text` 都算图文 | T 的口径，影响「全部通过」「比例」 | 同意 | 刘学奎 |
| 7 | **PRD 之外的发现**：`T>0` 但窗口内同步有缺口时，「不达标」可能是误判（缺失的内容本来可能让专员达标）。PRD 只在零内容时区分同步失败 | 不达标可能偏低，点检表会冤枉专员 | 先按 PRD（不扩展），但每位专员存 `sync_complete / sync_reason` 并在导出与明细里提示；是否把「不完整同步下的不达标」改判为未获取成功，由你定 | 刘学奎 |
| 8 | 第 3 层 / 图片能力不可执行时：发布与开始执行**被拒**，不是照跑并记未获取成功 | H1 未落地、图片分数未标定的整个期间，含第 2、3 层的计划无法发布；只有第 1 层（文本）的计划能真正跑 | 同意；PRD 验收里「记未获取成功 / 不支持」只落在中途丢失 | 刘学奎 |
| 9 | 评论覆盖不全的缺口计入 U：总数已知取 `max(1, 总数 − 已取)`，未知取 1 | 评论要求的未获取 / 不达标边界 | 同意 | 刘学奎 |
| 10 | 评论候选（C2）为空时：有候选在第 1、2 层未获取 → 未获取成功；没有任何参与内容 → 零内容规则；其余 → 不达标 | 评论要求的边界 | 同意 | 刘学奎 |
| 11 | 同步完整谓词的定义（§7.5）与「是否让 A 提供只读口」 | D 读 A 的同步表，A 改语义会失配 | 先在 `facts.ts` 实现并加契约测试；A 的后续 spec 若提供只读口再切换 | 刘学奎 + A |
| 12 | 归属取执行时的当前归属，并冻结组织链；两个名单账号指向同一专员 → 冻结失败 | 不变量被破坏时的处理 | 同意（失败而不是静默取一个，C18） | 刘学奎 |
| 13 | 写操作 / 执行要求「所属活动计划的创建者或超管」；读按 B-D21 | 谁能改一个判定计划 | 同意 | 刘学奎 |
| 14 | ~~新增服务身份 `service:judgement`~~ → **继承提交人身份**；D 注册 `plan_creator` 谓词与 `judgement_plan` 策略 | B 零改动 | 已采纳（2026-11-16） | 刘学奎 |
| 15 | 同（计划，版本）至多一个未终态运行；不同版本可并行 | 并发 | 同意 | 刘学奎 |
| 16 | 「执行失败只重跑失败子集」= 同次执行续跑 + 重新执行靠 C / A 复用，不做专门模式 | PRD 要求的是效果 | 同意 | 刘学奎 |
| 17 | `AttributionSnapshot` 的 owner = D 的 `run_participants`；`JudgementOutcomeReader` 形状；完成通知用轮询 | E 的 spec 开工前必须定 | 同意；E 的 spec 对齐 | 外部（E）+ 刘学奎 |
| 18 | 判定计划归档 / 取消归档（E PRD 需要，D PRD 没写） | 归档语义 | 同意：不可新建草稿 / 执行，历史可读 | 刘学奎 |
| 19 | 保留：圈定 / 试跑运行 N 天；每个（计划，版本）保留最近 K 个已完成执行的内容级行；参与专员级长期保留 | 存储增长 | 起始 N = 30、K = 5（配置，不写进代码）；先看 12.1 的实测 | 刘学奎 + 运维 |
| 20 | 图文 = A 的 `image` + `text`；`unknown` 无法归类 | 形态过滤 | 同意 | 刘学奎 |
| 21 | 对 C 的对齐请求（§10.3）：C 已合入 `main`，复核后 D 按 C 的现状适配（`segment_exists`、`score` 为 number、`Map<bigint>`、`RequestResult` 形状），`only` 已满足；剩余 2、9、10、13 项在任务 12 的契约测试里确认 | 以 C 的代码为准，不再要求 C 改形状 | 任务 12 复核；外部（C）只在发现合同缺口时介入 |
| 22 | 数值起始值：块大小 200、信号批 1,000、需求批 1,000、轮询间隔 30 秒、信号等待上限 10 分钟、采集等待上限 2 小时、租约 120 秒、tick 预算 5 秒、阶段最多重试 5 次、每档样例固定 5 个（不进环境变量）、关键词 / 话题每项 50 个、单个 64 字符 | 吞吐与等待 | 写入 `.env.example`，**不写进代码默认值**；测试机实测后调整 | 运维 + 实测 |
| 23 | 评论作者是否为指定账号（PRD §5.8）：A 验证 ID 命名空间前，配置里**没有**该条件 | 能力范围 | 同意 | 外部（A 验证） |
| 24 | 下载结果与第 1 页圈定下载的 Capability = `report.export`（E 的合同）；`streamCircleRows` 本身只对 E6 的服务调用开放 | 出口 | 同意；E 的 spec 写明 | 外部（E、B） |
| 25 | 界面设计确认（§15.6）：页面清单、向导流程、状态、可见性；规则复杂，先做 `ui-lab` 可点击原型让业务走一遍 | **页面任务的进入条件** | 见 §15；已于 2026-11-13 确认 | 刘学奎（已确认 2026-11-13） |
| 26 | 同步完整谓词比 PRD D-D14 字面宽松：窗口内某次列表同步失败、之后又成功且无缺口，判完整（PRD 写「周期同步都成功」） | 零内容专员判不达标还是未获取成功的边界 | 同意宽松版（检查点只在成功时推进，连续性没断）；若要字面版，窗口内任何一次非 `succeeded` 的列表任务都判 `sync_failed`，会有更多专员落入未获取成功 | 刘学奎 |
| 27 | 「回退到某一版」：PRD §2.3 暗示可以回到历史版本；本 spec 允许 `new-draft --from <任意已发布版本>`，不另做「恢复旧版本」动作 | 版本恢复语义 | 同意 | 刘学奎 |
| 28 | 内容要求启用规则（JP-D28）与 N 的依附规则（JP-D29） | 计划能否保存、内容结果是否为空 | 已采纳 | 刘学奎（2026-11-16） |
| 29 | 取前 N 按专员各自计算；N 同时是上限与门槛（前 N 条必须全部通过，不替补）（JP-D31）；PRD 已补写 | D-D18 的解释与后果 | 已采纳；若日后要「选前 M 条、至少 N 条通过」需拆成两个数并重新确认界面 | 刘学奎（2026-11-16 采纳审查建议） |
| 30 | 原型的能力别名提示文案「显示在点检表与 E 的列头」与 E 的点检表按计划分组不一致 | 已确认界面里的一句文案 | 改成「显示在配置页、证据与导出明细中」（方案 A） | 已采纳并已改 `precision/app.js`（刘学奎 2026-11-16 确认）；v1 原型 `ui-lab/d-rule-engine/app.js` 是已归档的对照稿，不改 |
| 31 | A 的 `ActorContext` 没有品牌维度，B 的 `toTracerActor` 不给品牌受限的 `hq_manager` 适配；D 的 `demand` 调用用窄适配（范围全平台，主体清单由 D 限定在已授权名单内）。偏离 B「只收窄不放宽」一处 | 品牌受限的 `hq_manager` 能否执行含评论 / ASR 的计划；放宽只在 D 提交的主体上 | 采用窄适配；日后 A 给 `ActorContext` 加品牌维度再换回 B 的适配器。备选：让 B 提供「受委托的 demand 适配器」（改 B） | 刘学奎（待确认；按默认继续） |

## 15. 界面

> **已确认（2026-11-13，刘学奎）。** 本节按 [`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md) §8 模板写成；确认版本为 [`ui-lab/d-rule-engine/precision/`](../../../ui-lab/d-rule-engine/README.md)（A · 精密工作台，v15），v1 保留用于对照。§15.6 记录了确认范围；超出范围的界面改动需要重新确认。全量视频明细视图归 E 域，D 不实现明细表，也不在本版 D 原型中加入口；待 E 视图定义后另行确认入口。
>
> **进入条件（已满足）**：① 在 `ui-lab/` 做出三页向导的可点击原型；② 请业务走一遍；③ 刘学奎明确确认并填写 §15.6（2026-11-13）；④ 界面改动超出确认范围要重新确认。

### 15.1 页面清单

| 页面 | 角色 | 入口 | 主要操作 | 对应 Capability |
|---|---|---|---|---|
| 判定计划列表 | `platform_admin`、`hq_manager`；`branch_manager` 只读 | 一级导航「判定计划」；活动计划详情的「下游判定计划」标签 | 按活动计划 / 状态筛选；进入详情；新建；归档 | `rule.definition.read` / `manage` |
| 新建判定计划 | `platform_admin`、`hq_manager` | 列表主按钮 | 选活动计划（**只列本人创建的**，超管全部）、填别名与说明 | `rule.definition.manage` |
| 向导第 1 页 · 圈定 | 同上 | 判定计划详情 | 时间窗、形态（必选）；按需添加文本识别 / 话题识别 / 视频时长能力（可删除，文本与话题可多个，时长一个）；文本 / 话题卡片显示**整层共享**的「至少 N 条内容命中」，同层条件 AND 后按点赞取前 N 条；确认圈定；看条数与未获取原因；下载圈定结果（经 E6） | `rule.definition.manage`；下载 `report.export` |
| 向导第 2 页 · 比对 | 同上 | 第 1 页确认后 | 按需添加整张图片对比 / 图片元素对比能力（图片文字对比是 2.0，1.0 不启用）；每个能力先选对比元素（头像 / 封面 / 主页背景），再上传标准图 / 元素图；试跑；看 0–10 分布与 11 档样例（每档固定 5 个样例槽位）；阈值可拖动或直接输入 | 同上 |
| 向导第 3 页 · 理解与执行 | 同上 | 第 2 页确认后 | 按需添加音频 ASR / 评论要求能力；填 ASR 标准（暂不可用时说明原因）、评论关键词与达标方式；确认执行（弹窗写明将执行的内容条数，**不展示费用**，D-72） | `rule.run.execute` |
| 执行记录与结果入口 | 同上；`branch_manager` 只读 | 判定计划详情 | 看执行状态与进度、取消、重新执行、新建草稿（即「回退」）；跳转 E 的点检表 / 下载判定结果；**全量视频明细表本身在 E 域实现，D 不实现** | `rule.run.execute` / `report.read` |
| 回退 / 新建草稿确认弹窗 | 同上 | 向导与执行记录 | 写明将删除哪些圈定 / 试跑结果、旧版本结果保留；按钮写动作名 | `rule.definition.manage` |

导航按角色裁剪：`store_staff` 没有入口；`branch_manager` 只看到所在分公司参与的活动计划下的判定计划，只读。页面文案使用 `ui-foundation.md` §6.6 的术语，**不出现内部字段名、表名、内部 ID**，稳定错误码可在人话下方显示。

第 1 页的时间窗与内容形态是**必选计划级条件**；文本识别、话题识别、视频时长是**按需添加的能力卡片**（文本与话题可多个，时长一个）。第 2、3 页同样按「添加能力」组织：第 2 页可选整张图片对比、图片元素对比，每个能力选择对比元素后才出现上传与阈值；图片文字对比是 2.0，1.0 界面置灰或不出现在添加菜单；第 3 页可选音频 ASR、评论要求。**数量要求并入第 1 页文本 / 话题能力卡片：整层共享一个 N；同层条件先 AND，再按点赞取前 N 条进入下一层；N 同时是 at_least_n 的达标门槛**（2026-11-13 刘学奎确认）。**N 只依附文本 / 话题能力卡片：删掉最后一张文本 / 话题卡片时，页面在同一次保存里把 N 一并清掉，不弹提示；没有文本 / 话题卡片时不显示 N、不能保存 N**（D-D22，2026-11-16 刘学奎确认）。**新建计划只带必选的时间窗与内容形态，不预置任何可选能力**（2026-11-12 刘学奎要求）。确认 / 回退在向导页的**右上角和底部各一组**；第 1 页没有回退（第一层没有可回退步骤）。能力别名随版本保存用于显示，**不参与 `config_sha256`**（2026-11-13 刘学奎确认）；别名显示在 D 的配置页、证据与导出明细的列头，**E 的点检表按判定计划分组、不按能力分列**，原型里「显示在点检表与 E 的列头」的提示文案以此为准（2026-11-16，刘学奎确认改为「能力别名，显示在配置页、证据与导出明细中」，已改 `precision/app.js`）。

### 15.2 用户流程

```text
创建者：判定计划 → 新建（选自己创建的活动计划、别名）→ 第 1 页选时间窗 / 形态并添加筛选能力 → 确认圈定（看条数、可下载）
        → 第 2 页按需添加比对能力、选对比元素、传标准图 / 元素图、试跑、看分布与样例、调阈值 → 第 3 页按需添加 ASR / 评论能力并填写要求
        → 确认执行（弹窗写「发布 vN 并执行」与将执行的内容条数）→ 「已提交」→ 执行记录（排队 / 执行中 / 等待采集 / 已完成；「等待采集」只在 `phase_detail.waiting_on` 非空时显示）
        → 已完成 → 去 E 的点检表 / 下载判定结果
创建者：执行记录 → 新建草稿（= 回退）→ 选从哪个已发布版本复制、落到第几页 → 弹窗写明影响 → 改配置 → 重新圈定 / 试跑 → 确认执行（产生新版本）
任一角色：执行记录 → 取消（有在途时弹窗写明）
```

### 15.3 线框

可点击原型（2026-11-13 已确认）：[`ui-lab/d-rule-engine/precision/`](../../../ui-lab/d-rule-engine/precision/)（A · 精密工作台 v15）；v1 保留对照。覆盖判定计划列表、新建、三页阻塞式向导、执行记录、专员证据抽屉、回退 / 新建草稿弹窗；E 域的点检表与下钻是占位页。走查任务与状态覆盖见 `ui-lab/d-rule-engine/README.md`。

2026-11-13 按刘学奎选定的 **A · 精密工作台** 方向重做了三页向导的可点击版本 [`ui-lab/d-rule-engine/precision/`](../../../ui-lab/d-rule-engine/precision/)（行式能力条、上传与阈值同条、数字步进 + 刻度尺；列表 / 详情 / 执行记录同步使用该主题）。该版本已于 2026-11-13 经刘学奎确认（见 §15.6），页面任务见 tasks 13–16。

### 15.4 状态矩阵

| 页面 | 加载 | 空 | 无权限 | 错误 | 部分成功 | 处理中 | 过期 |
|---|---|---|---|---|---|---|---|
| 判定计划列表 | 骨架屏 | 「这个活动计划还没有判定计划」+ 新建 | 无 Capability = 无入口；直链「无权访问」页 | 一句人话 + 错误码 + 重试 | — | — | — |
| 第 1 页 · 圈定 | 骨架屏 | 圈定为 0：「没有内容满足条件」+ 提示检查窗口与形态 | 同上 | 同上 | 「N 条未获取成功」分原因展示，是正常结果 | 圈定同步，转圈不超过数秒 | — |
| 第 2 页 · 比对 | 骨架屏 | 未上传标准图时只显示上传区 | 同上 | 上传失败 / 图片过大 / 无法解码；能力未启用时说明并禁用试跑 | 试跑完成但部分素材未归档：分原因展示 | 试跑中显示进度与「等待素材」 | — |
| 第 3 页 · 理解与执行 | 骨架屏 | — | 同上 | 阻塞项清单（如「音频理解暂不可用」） | — | 提交后给出去处（执行记录），不停在转圈页 | — |
| 执行记录 | 骨架屏 | 「还没有执行过」 | 同上 | 失败显示稳定原因与「续跑」 | 完成但含未获取成功：计数与原因分布 | 排队（`planned`）/ 执行中（`running`，或 `waiting` 且 `waiting_on = null`）/ 等待采集（`waiting_on = 'demand'`）/ 等待识别（`waiting_on = 'signals'`） | 被取消 / 提交人失效显示原因 |

### 15.5 字段可见性

| 字段 | platform_admin | hq_manager | branch_manager | store_staff |
|---|---|---|---|---|
| 判定计划列表与配置 | ✅ 全部品牌 | ✅ 授权品牌 | ✅ 只读（所在分公司参与的活动计划） | —（无入口） |
| 创建 / 改配置 / 圈定 / 试跑 / 回退 / 新建草稿 | ✅ | ✅ 且为活动计划创建者 | ❌ | ❌ |
| 确认执行 / 取消 / 重新执行 | ✅ | ✅ 且为活动计划创建者 | ❌ | ❌ |
| 标准图 / 元素图预览 | ✅ | ✅ | 只读 | ❌ |
| 执行记录与未获取成功原因 | ✅ | ✅ | ✅ 只读 | ❌ |
| 内容证据下钻（命中的词、分数、判定理由） | ✅ | ✅ | 本分公司范围内 | ❌ |
| 内容正文 / 评论原文 | ❌ 任何页面都不出现（读取口不返回） | ❌ | ❌ | ❌ |
| 费用、模型 Key | ❌ 1.0 不展示 | ❌ | ❌ | ❌ |
| 内部字段名、表名、`reason_code` | ❌ 界面显示人话 + 稳定错误码 | ❌ | ❌ | — |

### 15.6 界面设计确认

| 确认人 | 日期 | 确认的页面范围 | 原型 / 线框链接 | 备注 |
|---|---|---|---|---|
| 刘学奎 | 2026-11-13 | 判定计划列表、新建、三页向导（第 1 页能力 / 数量要求、第 2 页整张图片对比 / 图片元素对比 + 对比元素 + 阈值（图片文字对比 2.0，1.0 不启用）、第 3 页 ASR / 评论）、执行记录与执行详情、专员证据抽屉、回退 / 新建草稿弹窗；E 的点检表入口；全量视频明细归 E，D 不实现 | [ui-lab/d-rule-engine/precision/](../../../ui-lab/d-rule-engine/precision/)（A · 精密工作台 v15） | 定稿 A 精密方向；全量视频明细视图归 E，D 不实现明细表，本版不加入口；超出本范围需重新确认 |
