# D 判定执行前等待采集完成（d-wait-collection）· 设计
> **状态**：`draft`。**界面未确认**，页面相关任务不得展开（见 §界面 N.6）。
>
> **权威来源**：[requirements.md](requirements.md)；D 的阶段机见 `src/modules/judgement/engine/runner.ts`；同步完整谓词见 `src/modules/judgement/engine/pure/sync.ts`
>
> **更新日期**：2026-11-20

## 1. 方案
在执行（`execution`）的阶段序列里，`freeze` 之后、`scope` 之前插入**等待阶段 `collect_wait`**（`judgement_runs.phase` 是普通 `varchar(32)`，无 CHECK，不需要迁移）：

```text
freeze → collect_wait → scope → layer1 → select → scores → demand → layer3 → comments → aggregate → finalize
```
- `collect_wait` 读冻结后的参与账号集合（`run_participants`），查「采集中」账号数（WC-2）：
  - 0 个 → 直接 `advance` 到 `scope`；
  - > 0 且未到截止 → `waiting`，`phase_detail = { waiting_on: "collection", pending_accounts: N, deadline: <ISO> }`，`next_tick_at = now + poll_seconds`；
  - 到截止仍 > 0 → 在 `phase_detail` 记 `collection_timeout = { pending_accounts: N }` 并 `advance`；
- 截止时间在**第一次进入**阶段时写入（`phase_detail.deadline`），重放不重置；
- 等待上限来自配置 `HBECHO_JP_COLLECT_WAIT_MINUTES`（没有默认值写进代码；`.env.example` 建议 60），遵守「花钱 / 等待上限不静默默认」的项目约定。
- `circle` / `compare`（圈定 / 试跑）不加等待阶段（它们不依赖列表是否采完，且用户在向导里要快速反馈）。

## 2. 「采集中」的查询（只读）
```sql
SELECT COUNT(DISTINCT t.account_id)
FROM sync_tasks t
WHERE t.account_id IN (<参与账号>)
  AND t.requested_action IN ('fetch_content_list','fetch_profile','resolve_account')
  AND t.status IN ('pending','running','retry_wait')
```
外加：名单项来自 `import_batches.status = 'resolving'` 且账号还没有任何终态列表任务的账号。分块（每块 500）、不逐账号往返。

## 3. 原因拆分
`aggregate` 的 `syncCompleteness`（`sync.ts`）新增入参 `inFlight: boolean`：
```text
latest 为空 / 失败，且 inFlight → reason = "sync_pending"   // 新增
latest 为空 / 失败，且 !inFlight → reason = "sync_failed"
```
`ZeroReason` 增加 `sync_pending`；`run_participants.sync_reason` 是 `varchar(32)`，无 CHECK。`judgement-labels.ts`：`sync_pending: "采集中"`、`sync_failed: "采集失败"`。E 的点检表 / 全量明细（`e-metrics-lite`）读同一字段，显示文案同步。

## 4. 失败语义
| 场景 | 行为 |
|---|---|
| 读任务表出错 | 本阶段失败，整次执行 `failed`，原因 `collect_wait_read_failed`；不当作 0 个采集中 |
| 等待中被取消 | 同现有 `waiting` 的取消 |
| 进程崩溃 / worker 换手 | 阶段可重放：截止时间已落库，重新计数即可 |
| 超时 | 继续；`phase_detail.collection_timeout` 供页面提示；仍在采集的账号在 `aggregate` 时被记 `sync_pending` |

## 5. 测试策略（离线，真实 MySQL）
- 0 个采集中 → 不进入 waiting；
- N 个采集中 → `waiting` + `waiting_on = collection`；任务转终态后下一 tick 前进；
- 超时 → 前进，`collection_timeout` 有值，对应账号 `sync_pending`；
- 终态失败的账号不阻塞，原因 `sync_failed`；
- 重放不重置截止时间；取消；
- `circle` / `compare` 不含该阶段。

## 6. 界面
> 沿用现有「等待」状态与执行详情页，**只新增一种等待原因**；没有新页面、没有新按钮。

### 6.1 状态与文案（待确认）
| 位置 | 内容 |
|---|---|
| 执行记录列表 · 状态列 | 新增「等待列表采集」（琥珀色，同「等待采集 / 等待识别」） |
| 执行详情页 · 状态说明 | 「等待参与账号的视频列表采集完成（还有 N 个账号在采集，已等待 mm 分钟；最多等 60 分钟，超时后按现有数据继续判定）。」 |
| 执行详情页 · 超时后的提示条 | 「执行时仍有 N 个账号在采集，这些账号记为『采集中』，结果可能不完整；采完后重新执行即可。」 |
| 点检表 / 账号维度 · 原因列 | `sync_pending` →「采集中」；`sync_failed` →「采集失败」；两者分开计数 |
| 判定计划页「执行」按钮 | **不变**（点击后进入等待，不弹窗、不灰掉） |

### 6.2 状态矩阵
| 状态 | 展示 |
|---|---|
| 排队 | 现有 |
| 等待列表采集 | 上表第 1–2 行，可「取消」 |
| 执行中 / 完成 / 失败 / 取消 | 现有 |
| 完成（含超时） | 顶部提示条（第 3 行） |

### 6.3 N.6 界面设计确认
**未确认**。确认人、日期、范围待刘学奎填写；确认前不得写页面相关任务与代码。
