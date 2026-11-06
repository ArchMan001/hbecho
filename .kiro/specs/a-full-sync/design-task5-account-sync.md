# a-full-sync 任务 5 · 账号采集实施设计

> **状态**：已实现（2026-11-05，任务 5 第 1–9 步）；实现记录见 §15
>
> **性质**：[`design.md`](design.md) §5.2、§7.6、§7.6.1、§7.6.2、§7.7 的**实施级补充**。只写模块拆分、事务边界、测试矩阵和需要澄清的地方；不复制 design 的判定表原文。冲突时按 `CONTEXT.md` → PRD v1.11 → v2 → [requirements](requirements.md) / [design](design.md) / [tasks](tasks.md) / [acceptance](acceptance.md) 的顺序裁决。
>
> **范围**：[tasks.md 任务 5](tasks.md)；需求 FS-4、FS-5、FS-6、FS-7。
>
> **为什么单独成文**：design.md 已有 761 行，且 §7.6 是合同级描述；本文是「怎么落成代码」。需要修正的合同条文列在 §13，确认后**只在 design.md 里改那几处**，本文不替代它。
>
> **更新日期**：2026-11-05

## 1. 文件与模块

新增（均在 `src/modules/sync-runner/`，测试与源码同目录）：

| 文件 | 职责 | 纯函数 / 数据库 |
|---|---|---|
| `decide-after-page.ts` | 9 行判定表 | 纯 |
| `list-progress.ts` | `list-walk-progress.v1` 的 zod schema、初始值、读写 | 纯 |
| `identity-check.ts` | 主页标识、主页残缺、列表作者三态 | 纯 |
| `call.ts` | 一次供应商调用的共用步骤：能力门控、attempt 号、`gateway.execute`、`interpretCaptured`、失败码映射、异步轮询 | 需要 db / gateway |
| `profile-runner.ts` | `fetch_profile` | db |
| `list-walker.ts` | `fetch_content_list` | db |
| `seal.ts` | 账号级封口、失败 / 取消的可靠条目封口、条件清除 `building`、孤儿清扫 | db |
| `self-check.ts` | 自比对 | db |
| `account-runners.ts` | `createAccountRunners(deps) → RunnerRegistry` | 装配 |

修改既有文件（全部只增不改行为）：

| 文件 | 改动 | tracer 影响 |
|---|---|---|
| `sync-runner/types.ts`、`run-task.ts` | `failure` 结果新增可选 `onTerminal`（§2） | 无（可选字段） |
| `sync-runner/failure-map.ts` | 新增 `locator_unavailable`、`task_parameters_invalid`（无调用、不重试） | 无 |
| `projection/content-list.ts` | `building` 模式、`positionOffset`、跨页合并（§10） | 默认参数保持原路径 |
| `projection/checkpoint.ts` | 新增 `advanceCheckpoint`（§7） | 无（`establishInitial` 不动） |
| `sync-runner/index.ts`、`projection/index.ts` | 导出 | 无 |
| `worker/sync-wiring.ts`、`sync-main.ts` | worker 命令装配 Runner（§11） | 无 |

`registry.ts` 的 `RUNNERS` 保持冻结的空对象：Runner 需要注入 gateway，不能是模块级常量。`createAccountRunners` 的结果由 `buildSyncApp({ runners })` 传入。

## 2. Runner 合同的一处扩展

**问题**：失败任务的终态是**框架**在 `run-task.ts` 的 `applyFailure` 里写的。Runner 不知道本次失败是 `retry_wait`（不能封口，任务还要续跑）还是 `failed` / `dead`（必须封口）。若 Runner 先封口再返回 `failure`，封口与终态就不在同一个 fenced 事务里，违反第一条事务边界。

**扩展**：

```ts
// types.ts
| { kind: "failure"; code: FailureCode; retryAfterMs?: number; detail?: Record<string, unknown>;
    /** 仅当本次失败使任务进入 failed / dead / cancelled 时，在写终态的同一个 fenced 事务里执行。retry_wait 不执行。 */
    onTerminal?: (tx: DbTx, ctx: { status: "failed" | "dead" | "cancelled"; now: Date }) => Promise<void> }
```

`applyFailure` 在 `withFences` 内、更新任务行之后调用它。回调抛错则整笔回滚；**框架捕获这次异常，记日志，然后不带回调重做一次终态写入**（封口缺失留下的 `building` 行由 §7.4 孤儿清扫收拾）。否则一个确定性抛错的回调会让任务永远停在 `running`、反复被领取、每次都不消耗额度。

**使用者**：`provider_input_inaccessible`（记 `account_inaccessible_suspected`）、`list_author_mismatch`（条件清除 `building`）、列表任务的 `failed` / `dead`（封口可靠条目）。

**外部取消**（`cancelBatch` 把任务置 `cancelled`）没有 fence，Runner 只会看到 `heartbeat → cancelled` 并返回 `abandoned`。这条路径留下的 `building` 行由 §7.4 的孤儿清扫处理。

## 3. ProfileRunner

输入：`sync-profile-task.v1` `{ mode }`（zod 校验；非法 → `task_parameters_invalid`）。

| # | 步骤 | 事务 / IO | 带 fence |
|---|---|---|---|
| 1 | 读平台、`assignment`（`resolved_home_url`，空则 `classifyLocator(current_home_locator).cleaned`；都没有 → `locator_unavailable`）、账号在主页命名空间下的已登记标识 | 只读，无事务 | 否 |
| 2 | `capabilityGate.require({platform, action:'media_user_info', mode, environment})`，失败 → `capability_disabled` | 内存 | 否 |
| 3 | `ctx.heartbeat()`，非 `ok` → `abandoned` | 单条 UPDATE | 是（token） |
| 4 | `callOnce`：`gateway.execute`（先落 ODS → in_flight → 网络 → 落 ODS）→ `interpretCaptured`；异步则提交为 seq 1，每次轮询 seq 递增、各自是独立 ProviderCall | **网络 IO，不持有事务** | 网关内校验 |
| 5 | 分类：`cls.category≠none` → 失败码（§11）；`account.id` 非 `value` → `schema_drift` | 内存 | 否 |
| 6 | `checkProfileIdentity(registered, actual)`：不等 → fenced 短事务记 `profile_uid_mismatch`（期望值、实际值、发送入口、ProviderCall），返回 `failure profile_uid_mismatch`（不写快照、不动登记值） | 短事务 | 是 |
| 7 | `checkProfileFields(data)`：四项均非 `value` → fenced 短事务记 `profile_fields_missing`，返回可重试 `failure profile_fields_missing` | 短事务 | 是 |
| 8 | **终态事务**（一个 `withFences`）：`projectProfile`（含 current CAS、头像 / 背景引用；已存在则不重写）→ 自动解决该账号 open / acknowledged 的 `account_inaccessible_suspected`（`resolved_by_actor='system:recovered'`）→ 任务置 `succeeded`、写 `result_summary.identity_check` → 自比对触发（§8.3） | 短事务 | 是 |

第 6、7 步记问题与返回失败不在同一事务：问题指纹按 `(code, batch, account)` 去重，崩溃重放最多多发一次调用，不会重复记问题。

`provider_validation_failed` / `provider_null_result` / 有界重试的 `provider_task_failed`：若 `task.attemptCount + 1 >= task.maxAttempts`（本次失败会耗尽额度），返回 `provider_input_inaccessible`（stable → `failed`）并带 `onTerminal` 记 `account_inaccessible_suspected`；否则返回原码走 `retry_wait`。账号状态永不被改写。

## 4. ListWalker

输入：`sync-list-task.v1`（`mode`、`initial_content_limit`、`safety_page_limit`、`anchor_snapshot`）。`anchor_snapshot` 是规划时冻结的旧检查点：边界判断和检查点版本比较都只用它，不读活的检查点，所以重试与续跑看到同一旧边界。

| # | 步骤 | 事务 / IO | 带 fence |
|---|---|---|---|
| 0 | 解析任务参数与 `result_summary` 里的进度；capability 门控；读 `locator`。若进度 `identity_check.state='mismatch'` → 直接到第 8 步失败；若 `stop≠null` → 直接到第 7 步封口 | 只读 | 否 |
| 1 | `ctx.shouldStop()` → `abandoned('shutdown')`；`ctx.heartbeat()` | 单条 UPDATE | 是 |
| 2 | 请求第 `pages_done+1` 页：游标取 `next_cursor`（无则整数 `0`，与 tracer 一致）；`call_sequence = 页号`，`attempt_no = task.attemptCount+1` | **网络 IO，不持有事务** | 网关内校验 |
| 3 | `interpretCaptured(decodeVideoList)`；`cls.category≠none` → 失败码；`outcome≠decoded` → `schema_drift`（**不会变成空列表**） | 内存 | 否 |
| 4 | **页事务**（一个 `withFences`，锁列表任务）：见下 | 短事务 | 是 |
| 5 | 页事务提交后：`progress.stop==null` → 回第 1 步；否则进入第 6 步 | | |
| 6 | 页事务内已经写下了判定；这里只是读取它 | | |
| 7 | **封口事务**（§7）：定稿 + current CAS + 检查点 + 任务终态，一个 `withFences` | 短事务 | 是 |
| 8 | 失败：返回 `failure`，`onTerminal` 带封口 / 清除（§7.3） | 框架的 `applyFailure` 事务 | 是 |

**页事务内容**（顺序固定）：

1. 读本任务**开始时**登记的作者标识快照（§8.2），在任何绑定之前；
2. `projectContentPage(mode:'building', pageNo-1, positionOffset=progress.entries_done)`；
3. 仅第 1 页：`strategy.listBindings` 并绑定（小红书主导作者、抖音 `sec_uid`；快手为空），冲突记 `identity_conflict`；
4. `processedEntries !== returnedEntries` → 抛 `PageIncompleteError`，整笔回滚 → 失败码 `page_projection_failed`；
5. 记页级问题：不可投影条目、重复条目（沿用 tracer 的 `field_contract_anomaly` 区分符）、游标 / `has_more` 异常；
6. 更新列表作者计数，判定三态（§8.2）；
7. `decideAfterPage(...)`（纯函数，§5）；
8. 写进度（§6）与任务计数列（`page_count`、`fetched_item_count`、`has_more_at_stop`、最旧 / 最新发布时间）。

`ctx.shouldStop()` 只在页与页之间检查；一旦请求已发出就等它落 ODS 并投影完这一页（已返回的页必须整页处理）。

## 5. decideAfterPage

### 5.1 签名

```ts
export type AnchorView =
  | { mode: "none" }                                                    // 无旧检查点：首次基线
  | { mode: "empty" }
  | { mode: "time"; highWatermarkMs: bigint; contentIds: ReadonlySet<string> }
  | { mode: "id_window"; contentIds: ReadonlySet<string> };

export interface PageFacts {
  pageNo: number;                                   // 1 基
  entries: ReadonlyArray<{ position: number; contentId: string | null; publishedAtMs: bigint | null }>; // 已用 validPublishedAtMs 归一
  hasMore: ValueState<boolean>;
  cursor: TypedCursor;
}
export interface DecideConfig { safetyPageLimit: number; initialContentLimit: number; blocked: boolean }

export type Anomaly = { code: "cursor_no_more_with_has_more"; cursorKind: string } | { code: "has_more_invalid"; state: string };
export type Decision =
  | { action: "continue"; nextCursor: RequestCursor; anomalies: [] }
  | { action: "stop"; outcome: "success" | "gap" | "blocked";
      stopReason: string; anchor: "rebuild" | "keep_old" | "empty"; windowOverflow: boolean; anomalies: Anomaly[] };

export interface WalkTotals { cumulativeEntries: number; pinnedIdMatch: boolean }
export function decideAfterPage(anchor: AnchorView, page: PageFacts, totals: WalkTotals, cfg: DecideConfig): Decision;
```

`cumulativeEntries` 含本页，是**返回的条目总数**（不是去重后的内容数，与 `initial_content_limit` 的「完整条目数」一致）。`pinnedIdMatch` 是此前页（实际只有第 1 页）里置顶位置条目的 ID 是否命中旧 ID 集合，存在进度里（§6），供 G 步使用。`blocked=true` 时有效页数上限取 `1`（§13.3）。

### 5.2 判定顺序

保留原 9 行的**结果**，把顺序改成无歧义的 A→G（理由见 §13.1）：

| 步 | 条件 | 结果 | 原行 |
|---|---|---|---|
| A | 归一 `has_more`：`true` 且游标不可用（`no_more`、`null`、缺失、非法、空串）→ `cursor_no_more_with_has_more`；`has_more` 非 `value`（缺失 / `null` / 非法）→ `has_more_invalid`；两者都当作 `false` | 异常列表 | 1 |
| B | 锚点 `empty`：只处理首个完整页，无视 `has_more` | 有条目 → `success`、`baseline`、重建锚点；0 条 → `success`、`empty_list`、保持 `empty`；都不是缺口 | 7、9 的 `empty` 部分 |
| C | 本任务累计 0 条，且（`has_more` 为 `false` 或已到页数上限） | 锚点 `time`/`id_window` → `blocked`、`empty_window_not_rebased`、保持旧锚点；锚点 `none` → `success`、`empty_list`、建立 `empty` | 8、9 |
| D | 锚点 `time`/`id_window` 且本页命中 | `success`、`boundary_hit`、重建 | 2 |
| E | 锚点 `none` 且累计 ≥ `initial_content_limit` | `success`、`initial_limit`、重建 | 3 |
| F | `has_more=true`：`pageNo < cap` → `continue`；否则 `gap`、`safety_limit_rebased`、`windowOverflow=true`、重建 | | 4、5 |
| G | `has_more=false`：锚点 `time`/`id_window` → `gap`、`end_of_list_rebased`（A 中出现游标异常则 `cursor_anomaly_rebased`）、重建；锚点 `none` → `success`、`end_of_list`、重建 | | 6、7 |

**命中**（D）：条目 `contentId ∈ 旧 ID 集合`；`time` 模式另加 `publishedAtMs < 旧高水位`（严格）。等于高水位且 ID 不在集合内不命中。第 1 页 `position < 3` 的条目**不参与**命中。G 里锚点为 `time`/`id_window` 时有一个例外：到自然结束时整张列表都已读完，若本页命中、或 `pinnedIdMatch` 为真（置顶位置的**内容 ID** 命中旧集合），说明旧边界仍在、其后的全部内容都已读到，按 `success` / `boundary_hit` 处理，不记缺口；时间早于高水位不作为置顶位置的证据（§13.2）。

### 5.3 表驱动测试

一个 `decide-after-page.test.ts`，用例 = `{ name, row, anchor, page, cumulative, cfg, expect }`，`row` 是原 9 行编号（B 用 `"empty"`）。覆盖矩阵：

| 行 | 用例 |
|---|---|
| 1 | `has_more=true` + `no_more`（快手 K3）；`has_more=true` + `null` / 空串 / 缺失游标；`has_more` 缺失 / `null` / 非法；`has_more=false` + `no_more` **不是**异常；各自再叠加 `time` 命中、`time` 未命中、`none` 三种锚点 |
| 2 | `time` 严格更早命中；`time` 以 ID 命中；`id_window` 命中；**等于高水位时间但 ID 不在集合内 → 不命中、继续**；第 1 页位置 0–2 的命中被忽略、位置 3 起生效；第 2 页位置 0 **不是**置顶；条目无有效时间时只看 ID |
| 3 | `none` + 累计 = limit / limit−1 / 单页超过 limit（21 > 20，整页已处理仍停）；`has_more=true` 也不算缺口 |
| 4、5 | `pageNo` = cap−1 / cap；`cap=1`；`cap=2` 三页（E7） |
| 6 | `time` / `id_window` 未命中；游标异常时 `cursor_anomaly_rebased`；第 1 页不足 4 条（E19）：ID 在置顶位置命中 → `success`，不在 → `gap` |
| 7 | `none` + `has_more=false` + 有条目 |
| 8 | `time` / `id_window` + 空页：`has_more=false`、`has_more=true` 到上限、快手 K6（空 + `no_more`） |
| 9 | `none` + 空页 → `empty`；快手 K6 首次 |
| empty | `empty` + 5 条 + `has_more=false` / `true`（E24，`baseline`，无缺口）；`empty` + 空页 + `has_more=false` / `true`（E25） |
| blocked | `blocked=true` 时 cap=1：命中 → `success`；未命中 + `has_more=true` → `safety_limit_rebased`；+ `has_more=false` → `end_of_list_rebased` |

另加两条性质断言（不是表项）：`continue` 的 `nextCursor` 永远是 `integer` / `string` 且非空；`windowOverflow=true` 蕴含 `outcome='gap'`（对应表 `ck_sync_tasks_overflow` 与 `ck_sync_tasks_gap`）。

## 6. 页进度与崩溃恢复

`result_summary`（`list-walk-progress.v1`，在**每个页事务里**与投影一起提交）：

```json
{ "schema": "list-walk-progress.v1",
  "pages_done": 2, "entries_done": 41, "pinned_id_match": false,
  "next_cursor": {"kind":"string","value":"1.785394950371E12"} | null,
  "stop": null,
  "stop_detail": { "outcome": "success|gap|blocked", "stop_reason": "...", "anchor": "rebuild|keep_old|empty", "window_overflow": false },
  "anomalies": [ {"code":"…"} ],
  "last_cursor": {"kind":"string","value":"…"} | null,
  "identity_check": { "baseline_has_registered": true, "known_author_entries": 12, "matched_entries": 12, "state": "pending|verified|unverifiable|mismatch" },
  "last_page_call_id": "123" }
```

- `stop≠null` 的含义是「判定已作出」，不是「任务已结束」。任务终态只由封口事务写。
- **恢复**：领取 → 框架先 `recoverInFlightForTasks` → Runner 读进度。`stop≠null` 直接封口，不发请求；否则从 `pages_done+1` 页和 `next_cursor` 继续。已提交页不重复请求（E14）。
- **页内崩溃**：页事务回滚，进度未变。若响应已落 ODS，同一 `(task, attempt, seq)` 再 `execute` 返回已捕获结果，**不再付费**。
- **重试语义**：每次失败消耗一个 attempt（框架），下一轮 `attempt_no` 自然 +1；`call_sequence` 仍是页号，所以 `(task, attempt, seq)` 唯一。
- **ambiguous**：同一 `(task, seq)` 下已有 ≥ 2 个 `ambiguous` 调用时**不再发起**，直接返回 `ambiguous_unresolved`（不发请求，消耗一次 attempt，额度用尽后 `dead`）；因此「因 ambiguous 最多重发一次」成立，不用 `resendAfterAmbiguous`（避免它的 `attempt_no+1` 与任务级 attempt 号冲突）。
- **关停**：`shouldStop()` 在页间返回 `abandoned('shutdown')`，进度完整，租约过期后任意 worker 续跑。

## 7. 账号级封口

### 7.1 成功封口（`sealSuccess`）

一个 `withFences(db, clock, [{ listTask, token }], …)`，顺序：

1. 读该账号本批次的 `building` 快照：`content_snapshots JOIN contents ON account_id=A WHERE batch_id=B AND snapshot_status='building'`；
2. 定稿：`UPDATE content_snapshots SET snapshot_status='finalized', finalized_at=now … WHERE content_snapshot_id IN (…) AND snapshot_status='building' AND batch_id=B`（条件再写一遍，防御重放）；
3. 逐内容 `selectCurrentContentSnapshot`（`(logical_at, batch_id)` 严格更新，旧批次不回退）；
4. 重建锚点（`stop_detail.anchor='rebuild'`）：在**同一事务内**读本批次本账号 `building`/刚定稿快照的 `(published_at, platform_content_id)`；有有效时间 → `computeInitialAnchor(全部)`；否则用 `content_discoveries WHERE page_no=0` 的内容 ID 作 `id_window`；
5. `advanceCheckpoint`（§7.2）；
6. 记质量问题：`gap` → `continuity_gap`（`safety_limit_rebased` 另加 `window_overflow`）；`blocked` → `empty_window_not_rebased`；
7. 写任务终态：`succeeded` / `succeeded_with_gap`（后者同时写 `continuity_gap_detected`、`window_overflow_detected`、`stop_reason`，满足 `ck_sync_tasks_gap` / `ck_sync_tasks_overflow`）、清租约、`finished_at`、最终 `result_summary`；
8. 触发自比对（§8.3）。

**不调用** tracer 的 `settleBatch`：批次汇总由 `sync-schedule` 的 `finalizeAll`（`tick`）负责。

### 7.2 检查点推进

`advanceCheckpoint(tx, { accountId, providerId, expectedVersion, next })`，**两个条件缺一不可**：

- **任务 fencing**：函数只在封口事务（已持有列表任务 fence）内调用，类型上要求传入 `FencedTx` 标记，不提供无 fence 的入口；
- **version 乐观比较**：`expectedVersion = anchor_snapshot.checkpoint_version`（规划时冻结）。`UPDATE … SET …, version=version+1 WHERE account_id=… AND provider_id=… AND action=… AND scope=… AND version=:expected`，`affectedRows≠1` → 拒绝。规划时无检查点（`expectedVersion=null`）则先 `SELECT … FOR UPDATE`，行已存在 → 拒绝，否则 `INSERT`（`version=1`）。

拒绝**不是失败**：快照照常定稿、任务照常 `succeeded`，`result_summary.checkpoint='stale_rejected'`，不记缺口。含义是别的批次已经推进了该账号检查点，这一次的结果不能让它倒退（E16）。

| 结局 | `anchor_mode` / 高水位 | `continuity_status` | `last_gap_at` | `cursor_*` | `last_successful_*` |
|---|---|---|---|---|---|
| `success` + rebuild | 重建值 | `ready` | 不变 | 末页游标（不可用则 NULL） | 本批次 / 本任务 |
| `gap` | 重建值 | `rebased_after_gap` | `now` | 同上 | 本批次 / 本任务 |
| `blocked` | **不动** | `blocked` | 不变 | 不变 | 不变 |
| `success` + `empty` | `empty` | `ready` | 不变 | 末页游标 | 本批次 / 本任务 |

### 7.3 失败 / 取消的封口（`onTerminal`）

框架在 `applyFailure` 的 fenced 事务里调用 `sealFailed`：

- **可靠条目** = 该账号本批次所有 `building` 快照（只有整页事务提交的页才会留下，所以天然可靠）。定稿 + current CAS，**不动检查点**；
- `list_author_mismatch`：改调 `purgeBuilding`。**只**执行
  `DELETE … FROM content_snapshots WHERE snapshot_status='building' AND batch_id=B AND content_id IN (SELECT content_id FROM contents WHERE account_id=A)`，先删这些快照的 `pending` 媒资引用（外键无级联）。已定稿的快照、其他批次的快照、其他账号的内容都不会匹配（第三条事务边界）。`contents` 与 `content_discoveries` 保留（只追加的历史，规则禁止 `CASCADE`）；
- 没有 `building` 行时什么都不做。

### 7.4 孤儿清扫

`sweepOrphanBuilding(db, clock)`：找 `building` 快照所属（批次、账号）对应的列表任务已是 `failed` / `dead` / `cancelled` 的情形，对每个任务 `SELECT … FOR UPDATE` 并确认仍为终态，再按 §7.3 处理（该任务的 `result_summary.identity_check.state='mismatch'` 则清除，否则封口）。孤儿的唯一来源是外部取消（`cancelBatch` 把任务置 `cancelled`，没有 fence）；失败路径的封口与终态同事务，不会留孤儿。清扫没有 fence 但安全：终态任务不可能再有 fenced 写入。

任务 5 实现并测试这个函数，Runner 在 `heartbeat→cancelled` 时对自己的任务调用一次；周期调用交任务 9 的 `maintain`（§13.9）。

## 8. 身份与残缺校验、自比对

### 8.1 主页（`identity-check.ts`）

```ts
checkProfileIdentity(input: { registered: readonly string[]; actual: ValueState<string> }):
  | { state: "verified" } | { state: "mismatch"; expected: readonly string[]; actual: string | null }
checkProfileFields(d: Pick<ProfileData, "followerCount"|"followingCount"|"likeCount"|"postCount">): "ok" | "all_invalid"
```

入参里**没有** locator，函数签名即 D11 的断言。`registered` 为空（账号没有主页命名空间的登记值，不应发生）按 `mismatch` 处理并在 `expected` 里如实给出空数组：宁可停采集也不写一份无法归属的快照。

### 8.2 列表作者（三态）

```ts
checkListAuthors(c: { baselineHasRegistered: boolean; knownAuthorEntries: number; matchedEntries: number; minEntries?: 5 }):
  "pending" | "verified" | "unverifiable" | "mismatch"
```

- **基线**：第 1 页事务一开始、绑定之前，读该账号在列表作者命名空间下的已登记标识，写入 `identity_check.baseline_has_registered`。抖音含 `douyin.user_id`、`douyin.sec_uid`；小红书是 `xiaohongshu.content.user_id`；快手是 `kuaishou.user_id`。
- **匹配**：条目作者 ID（抖音另看 `sec_uid`）∈ 登记集合。登记集合在后续页用当前值，但 `baseline_has_registered=false` 时整次任务都是 `unverifiable`——小红书首次主导作者绑定是本次任务自己造的，用它去「验证」本次列表是循环论证。
- **计数口径**：只数作者 ID 为 `value` 的条目（`known_author_entries`）。≥ 5 且 `matched=0` → `mismatch`；< 5 → `unverifiable`。字段整体缺失不算 `mismatch`（那是契约漂移，不是串号）。见 §13.5。
- 每页事务内更新；一旦 `mismatch` 立即停止翻页并失败，不再为同一个错号付费。

### 8.3 自比对（`self-check.ts`，只告警）

`runSelfCheck(tx, { batchId, accountId })`，**幂等**，在两个位置触发：封口事务末尾；`ProfileRunner` 终态事务末尾。两处都先检查另一半是否已完成（本批次主页快照存在、列表任务已成功或正在被本事务置成功），任一缺失则直接返回。这样不依赖两个任务谁先结束。

规则按 FS-5.14：`prev` = 该账号 `(logical_at, batch_id)` 严格更早的最近一份主页快照（补抓批次也算，不要求其为有效值）；`prev.post_state` 与本批次 `post_state` 均为 `value` 且 `k = cur − prev > 0`；`discovered = COUNT(contents WHERE account_id=A AND first_seen_at > prev.response_received_at)`；`discovered < k` → `recordIssue('suspected_missing_content', warning, { k, discovered, 两份主页快照 ID })`。**首次基线（`anchor_snapshot=null`）跳过**：基线受 `initial_content_limit` 限制，发现数少于作品数增量是设计内的结果，不是漏采（§13.7）。

写问题是它唯一的副作用：不改任务状态、不改检查点、不进批次终态。

## 9. 三平台差异落点

| 差异 | 落点 |
|---|---|
| 游标类型：抖音整数、小红书 / 快手字符串 | `cursorEnvelopeOf` ↔ `RequestCursor`，不互转；进度里存信封；`buildRequest` 已按 `kind` 写字面量 |
| 小红书主导作者 | 仅**第 1 页事务**调 `DEFAULT_STRATEGIES.xiaohongshu.listBindings`（首页完整页上算一次）；拒绝时记 `dominant_author_rejected` |
| 抖音第二标识 | 同上，第 1 页；`same_payload` 绑定 `douyin.sec_uid`，多值冲突记 `identity_conflict` |
| 快手无绑定 | 策略返回空；`no_more` 在 `decideAfterPage` 的步骤 A 归一，**从不进入请求游标** |
| 头像 / 背景 | 由 `decodeProfile` 的 `mediaCandidates` 决定（抖音有，其余无），Runner 不分平台 |
| 异作者 | 保留内容，不建账号（沿用 tracer 的 `projectContentPage`） |
| 列表播放数 | `unsupported`（投影沿用） |
| 外部型账号 | 规划不生成列表任务，Runner 不处理；防御：`assignment.watch_type='external'` 的 `fetch_content_list` → `unsupported_action` |

## 10. `projection/content-list.ts` 的改动

`ProjectPageInput` 增加两个可选字段，默认值保持 tracer 行为：

| 字段 | 默认 | 作用 |
|---|---|---|
| `mode: "final" \| "building"` | `"final"` | `final`：写 `finalized` 并立刻 `selectCurrentContentSnapshot`（现行路径，一字不改）。`building`：写 `building`（`finalized_at=NULL`），**不**选 current |
| `positionOffset: number` | `0` | `absolute_position = positionOffset + firstPosition`；`position_in_page` 仍是页内位置 |

`building` 模式的三处差异：

1. **快照**：`SELECT … WHERE batch_id AND content_id FOR UPDATE`；无则插入；有且为 `building` 则逐列合并——文本 / 作者 / 时间用 `COALESCE(新值, 旧值)`，计数 / 时长的 `(value,state)` 对按 `later(prev,next)`（新值为 `value`，或旧值不是 `value` 时取新；否则保留旧），作者标识成对更新，列表溯源列更新为最新一页。已为 `finalized` 的行**不改**（理论上不会发生，保险）；
2. **discovery**：`INSERT … ON DUPLICATE KEY UPDATE discovery_id=discovery_id`，保留首次出现的位置（FS-5.11）；
3. **封面引用**：该快照已有 `cover` 引用则不再插入；加一个可选钩子 `skipCover?(tx, contentId): Promise<boolean>`，任务 7 实现封面首次规则，任务 5 默认不跳过。

**保证 tracer 路径不变**：`mode` 默认 `final`，`final` 分支的代码不动，只把现有 `insertSnapshot` 的 `snapshotStatus` / `finalizedAt` 参数化。tracer 的 `tracer-flow.*.db.test.ts`、`projection.db.test.ts` 不改一行；`verify.sh` 里它们必须全部仍通过。新增 `content-list.building.db.test.ts` 覆盖：building 不选 current、跨页重复合并（一条内容 / 一份快照 / 一条 discovery，且缺失值不擦除有效值、后到的真实 `0` 覆盖）、`positionOffset`、封面不重复、finalized 行不被改写。

## 11. 调用与失败码

### 11.1 `call.ts`

- 每次调用前：`ctx.heartbeat()`、`capabilityGate.require`（`mode` 取任务参数，`environment` 取注入）；
- `attempt_no = task.attemptCount + 1`；`call_sequence`：主页同步 1；主页异步 提交 1、轮询 `1+k`；列表 = 页号；
- 异步轮询复用 `DEFAULT_ASYNC`（`pollIntervalMs` / `maxPolls` / `maxWaitMs`），等待经注入的 `sleep`；超时 → `transport_timeout`。**不复用 tracer 的闭包**（它绑定了 tracer 的局部状态，抽出来是改 tracer），`call.ts` 里是一份约 40 行的独立实现。

### 11.2 结果 → `FailureCode`

| 来源 | 码 |
|---|---|
| `not_sent: cancelled` / `stale` | `abandoned` |
| `not_sent: policy:*`（`isBudgetReason`） | `budget_exhausted` |
| `transport_failed` 已知未送达 | `transport_failure`（`kind==='timeout'` → `transport_timeout`） |
| `transport_failed` ambiguous、`capture_failed`、`ambiguous`、`in_progress` | `ambiguous_unresolved` |
| 分类 `provider_request_rejected` / `provider_auth` / `invalid_response` | 同名 |
| `provider_validation_failed` / `provider_null_result` / `provider_task_failed` | 同名；主页额度耗尽时 `provider_input_inaccessible`（§3） |
| `rate_limited` / `provider_server_error` | 同名 |
| 解码 `schema_drift` / `invalid_response` / `not_succeeded` 非等待态 | `schema_drift` |
| 页事务失败 | `page_projection_failed` |
| 任务参数不合法 / 缺入口 | `task_parameters_invalid` / `locator_unavailable` |
| 其他异常 | 框架的 `runner_error` |

`captured` 但 `fenceValid=false` → `ctx.heartbeat()` 区分 `cancelled` / `stale`，返回 `abandoned`，**不投影**。

### 11.3 装配

`createAccountRunners({ db, gateway, strategies?, environment, clock, sleep, async?, hooks? })`。生产装配放在 `worker/sync-runner-wiring.ts`：读 AI Master 与 OSS 的 secret（沿用 `SMOKE_ENV_VARS` 的变量名），`HttpProviderTransport` 外包 `rateLimitedTransport`，网关挂 `createBatchBudgetPolicy`。**只有 `worker` 命令装配它**；`tick`、`status` 等不读 secret。**启动守卫**：`worker` 启动时对配置的 `environment` 和两个动作的 `mode` 检查 `capabilityGate`，三平台里一个已批准的 tuple 都没有就拒绝启动并说明原因（现状：production 全部 `disabled`，等于拒绝启动）。否则一次误启动会把整个周期批次的任务全部写成 `failed/capability_disabled`，批次终态变成 `failed`，看起来像一次真实的采集故障。默认测试永远不走这条，用 `FixtureTransport` 与 `FakeObjectStore`；装配本身只测配置缺失时的报错与「不在构造阶段发请求」。

## 12. 验证清单映射

[tasks.md 任务 5「验证」](tasks.md) 的 11 条与测试：

| 清单 | 测试文件 | 关键断言 |
|---|---|---|
| `decide-after-page` 表驱动 | `decide-after-page.test.ts`（unit） | §5.3 矩阵；E2–E6、E19、E24–E26 的纯函数部分 |
| 三平台端到端 | `account-sync.db.test.ts` | 用真实 `createBatchPlanner` + `createSyncWorker.run({untilIdle:true})` + fixture transport。抖音 raw3 20 条含异作者；小红书 raw3 21 条整页；快手 raw13 L3（23 条，游标 `1.785394950371E12`）+ L4（20 条）两页，K3（20 条 + `no_more`）、K6（0 条 + `no_more`）。已核对 manifest：条数与清单一致。注意：`initial_content_limit ≤ 20`，所以**首次基线的任何平台都在第 1 页停**（23 ≥ 20、21 ≥ 20）；快手两页要用「旧 `time` / `id_window` 锚点、第 1 页不命中」触发，`safety_page_limit=2` 时 L4 之后得到 `safety_limit_rebased` |
| 多页合成 | `list-walker.db.test.ts` | 基于 `tests/harness/list-bytes.ts` 拼 3 页（文件头注明「合成，条目取自 raw3 形态」）：命中在第 2 页、第 3 页；cap=2 → 缺口并重建；E7–E9、E17 |
| 空窗口 | 同上 | 旧锚点非空 + 空页 → `blocked`、旧锚点未覆盖、`succeeded_with_gap`（E10）；`empty` 锚点（E24、E25） |
| 快手 `no_more` | 同上 | K3 / K6：停止翻页、记问题、请求体中从无 `no_more`、游标字符串原样回发（G4–G6、E26） |
| 崩溃恢复 | 同上，`afterPageProjection` 钩子抛错 | 第二次运行只请求第 2 页；`stop≠null` 后崩溃 → 不发请求直接封口；响应已落 ODS 但页事务未提交 → 不再付费（E14） |
| 失败隔离 | `account-sync.db.test.ts` | 一个账号反复 500 → `dead`，其余账号成功，批次经 `finalizeAll` 为 `partial_succeeded` |
| 技术失败不改状态；`account_inaccessible_suspected` | `profile-runner.db.test.ts` | D4–D6：传输错误 / 429 / 5xx / 解析失败 / 存储失败；`RESULT_VALIDATION_FAILED` 耗尽 → `failed/provider_input_inaccessible`；下一批次成功 → `system:recovered` |
| current 不倒退 | `seal.db.test.ts` | 先新批次后旧批次（F4、E16）；检查点版本拒绝 |
| 身份校验五用例 | `identity-check.test.ts` + `list-walker.db.test.ts` + `profile-runner.db.test.ts` | `profile_uid_mismatch` / `profile_fields_missing` / `list_author_mismatch` / `verified` / `unverifiable`；mismatch 后库里无本批次 `finalized` 快照、登记标识未变（D9–D11、E20、E21） |
| 自比对 | `self-check.db.test.ts` | +5 / 发现 2 → 警告；+0、负增长、上周 `missing` → 不报；两种完成顺序都触发且只记一次；首次基线跳过 |
| `./scripts/verify.sh` | — | 全绿后才说「通过」 |

另加（不在清单、事务边界的直接证据）：

- `seal.db.test.ts`：封口与终态同事务（封口中途抛错 → 快照仍 `building`、任务仍 `running`）；陈旧 token 的封口什么都不写；`purgeBuilding` 不碰已定稿快照 / 其他批次 / 其他账号（边界 1、3）；
- `checkpoint` 用例：version 不符 → 拒绝；token 陈旧 → 整笔不写（边界 2）；
- `run-task` 用例：`onTerminal` 只在 `failed` / `dead` / `cancelled` 时执行，抛错则整笔回滚。

## 13. 对 design §7.6 / §7.6.1 / §7.7 的澄清（需要你确认）

| # | 含糊或矛盾 | 我的处理 | 影响 |
|---|---|---|---|
| 13.1 | 表按序读时，第 4 行（`has_more=true` → 继续）排在第 8、9 行（0 条）之前，于是旧锚点 + 空页 + `has_more=true` 会一直翻到上限；第 7、9 行写了「旧锚点为 `empty`」，却被后面「`empty` 无视 `has_more`」的段落架空；FS-5.7 只定义了 `has_more=false` 的空页 | 重排为 §5.2 的 A→G：`empty` 最先；0 条且（`has_more=false` 或到上限）先于第 4、5 行。**有一处结果确实变了，是有意的**：旧锚点非空、累计 0 条、`has_more=true` 且已到页数上限时，原顺序（第 5 行先于第 8 行）得到 `safety_limit_rebased`（缺口并**用空窗口重建锚点**），新顺序得到 `blocked`（保持旧锚点）。前者违反 CONTEXT「空窗口不能覆盖已有的非空锚点」，所以按新顺序。其余各行结果不变 | 改 design §7.6 表的排序说明 |
| 13.2 | 「第 1 页位置 1–3 不作边界证据」与 E19「第 1 页不足 4 条不误判缺口」冲突：账号只有 ≤ 3 条作品且旧高水位就在其中时，每周都会判 `end_of_list_rebased`，是周周误报 | 到自然结束时整张列表已读完，**置顶位置的 ID 命中**也算证据（不看时间）。继续翻页的判断仍严格排除置顶位置 | 改 §7.6 命中细则一句 |
| 13.3 | 检查点 `blocked` 之后「只抓首页」（v2 §9.4 第 11 条、FS-5.7）在判定表里没有对应行 | `blocked` → 有效页数上限 = 1，其余走原行：命中 → `success`；未命中 + `has_more=true` → 行 5（`safety_limit_rebased`）；`has_more=false` → 行 6。不新增行 | 补一句到 §7.6 |
| 13.4 | 检查点 CAS 被拒绝时任务怎么算，FS-5.10 与 §7.6 都没写 | 任务照常 `succeeded`，快照照常定稿，`result_summary.checkpoint='stale_rejected'`，不记缺口 | 补一句到 §7.7 |
| 13.5 | 列表作者校验「累计条目 ≥ 5」按返回条目数还是有作者 ID 的条目数？按前者，作者字段整体缺失（契约漂移）会被判成串号并清库 | 只数作者 ID 为 `value` 的条目。另外小红书首次主导作者绑定在本任务内产生，不能拿来验证本任务（§8.2）；与 E21「无登记作者标识 → `unverifiable`」一致 | 改 §7.6.1 一句 |
| 13.6 | 列表任务遇到 `RESULT_VALIDATION_FAILED` 耗尽怎么办：FS-4.5 只管主页 | 按框架默认（`dead`，保留已封口的条目），**不**产生 `account_inaccessible_suspected`（该问题的自动解决只挂主页成功，列表产生它会被主页成功错误地解决） | 补一句到 §8 |
| 13.7 | 自比对依赖「本批次主页」，列表任务可能先结束；首次基线受 `initial_content_limit` 限制，必然 `discovered < k` | 双位置触发的幂等检查；首次基线跳过 | 补到 §7.6.2 |
| 13.8 | §7.7 第 4 条把失败任务的封口写成列表任务自己的事，但失败终态由框架写；外部取消没有 fence；「恢复时清除」没说谁来恢复 | §2 的 `onTerminal` 扩展 + §7.4 孤儿清扫 | 改 §7.7 第 4 条；动 task 4 的 `types.ts` / `run-task.ts` |
| 13.9 | 孤儿清扫由谁定期调用 | 任务 5 提供函数并在 `cancelled` 时调用；定期调用写入任务 9 的 `maintain` 清单 | tasks.md 任务 9 加一行 |
| 13.10 | v2 §9.4 的 `stop_reason` 只列了三个缺口值；本任务用到 `cursor_anomaly_rebased`、`baseline`、`boundary_hit`、`initial_limit`、`end_of_list`、`empty_list` | 列在 v2 §9.4 末尾的「取值」注记里（`stop_reason` 是 `VARCHAR(64)`，无 CHECK，不需要迁移） | 改 v2 一行 |

## 14. 实施顺序

每一步结束跑该步相关测试；只有第 9 步结束才跑完整 `./scripts/verify.sh`。

1. `decide-after-page.ts` + 表驱动测试（纯函数，零依赖）。
2. `list-progress.ts`、`identity-check.ts` + 单测。
3. 投影：`content-list.ts` building 模式、`checkpoint.ts` 的 `advanceCheckpoint` + db 测试；**先跑一遍 tracer 全部测试确认不变**。
4. 合同扩展：`onTerminal`、新失败码 + `run-task` 测试。
5. `call.ts` + `ProfileRunner` + 测试（含 D 组）。
6. `seal.ts` + `ListWalker` + 测试（含 E、F 组）。
7. 自比对、孤儿清扫。
8. 三平台端到端、崩溃恢复、故障注入（`account-sync.db.test.ts`）。
9. `createAccountRunners`、`sync-runner-wiring`、文档回写（design §7.6/§7.6.1/§7.7/§7.6.2 的 §13 各处、v2 §9.4、tasks.md 勾选与 acceptance 结果）、`./scripts/verify.sh`。

**停下来问**的触发点（tasks.md「必须停下来问」）：快手 / 小红书 fixture 条数与清单不符；需要新表；需要自动设置 `unavailable` / `deleted`；需要新的 Node 依赖。

本设计**没有新表、没有新依赖、没有页面**。

## 15. 实现记录（与上文不同或上文没写的地方）

| 项 | 实现 |
|---|---|
| `profile_uid_mismatch` | 不是「fenced 短事务记问题再返回失败」，而是失败结果的 `onTerminal`：它是稳定失败，必然终态，所以问题与终态同一事务（比 §3 第 6 步更强） |
| 进度字段 | `identity` 改名 `identity_check`（与 acceptance 的 `result_summary.identity_check` 一致）；新增 `last_cursor`（检查点 cursor 列用）与封口写入的可选 `final`（检查点结局、定稿数） |
| 重建结果为空而旧锚点非空 | 返回了条目但没有一条能投影出内容 ID：封口时改判 `blocked` / `empty_window_not_rebased`，不用 `empty` 覆盖非空锚点 |
| 列表异步 | `mode≠synchronous` → `capability_disabled`（detail `list_async_not_supported`）：异步轮询的 `call_sequence` 会与下一页冲突，design §14 第 4 项也规定周期列表只走同步 |
| 自比对串行化 | 两个终态事务（主页、列表封口）最开始先 `lockAccount`；见 §8.3。与规划器的「先锁账号再改任务优先级」顺序相反，只在补抓提升优先级时有极小的死锁窗口，MySQL 会回滚其中一个，Runner 按 `runner_error` 有界重试 |
| `AccountRunnerDeps.projector` | 新增注入点，默认真实投影；测试用来注入「第 N 条失败」 |
| worker 启动守卫 | `assertWorkerCanRun`：真实装配拒绝 `HBECHO_ENV=test`（test 的 capability 只对应 fixture transport），且要求 production 至少有一个已批准 tuple；当前 production 全部 disabled，所以**真实 worker 现在不会启动**，启用需要任务 11 的批准式 smoke 与单独的人工批准。先于读 secret、先于建连接池 |
| 孤儿清扫的调用点 | `sweepOrphanBuilding` 的 `scope` 选项限定到一个（批次, 账号）；ListWalker 在发现任务被取消（`heartbeat→cancelled`、页事务 / 封口事务 fence 返回 `cancelled`）而放弃时对自己的（批次, 账号）调用一次；定期的全局清扫写入任务 9 的 `maintain` |
