# a-full-sync · 交付与审查报告（2026-11-06）

> **状态**：`recorded`（一次性报告，供独立审查；不是合同，不替代 requirements / design）
>
> **用途**：交给另一位审查者（DeepSeek）独立核查 `a-full-sync` 的实现、验证证据与已知缺口。报告里每个数字都标了来源，审查者应当复核，而不是采信。
>
> **仓库状态**：`main` = `35959a8`（2026-11-06）。CI 最近四次均为 success：`42169820893`（`ba1eb49`）、`42172801179`（`1ea5d20`）、`42178035982`（`35959a8`）。
>
> **相关文档**：[requirements](requirements.md) · [design](design.md) · [design-task5](design-task5-account-sync.md) · [tasks](tasks.md) · [acceptance](acceptance.md) · [smoke 报告](smoke-report-2026-11-06.md)

## 1. 这个 spec 要交付什么

**目标**：把 A 域的"周期采集"补全，使抖音、小红书、快手三个平台的账号能被周期同步，并支持规则域按需提出详情 / 评论 / 视频 / 音频采集。

**范围内**：
- 周期计划与全量批次（FS-1）、实际监控目标集（FS-2）、任务图 / 幂等 / 租约 / 并发（FS-3）。
- 主页周期采集（FS-4）、多页列表与检查点与连续性缺口（FS-5）、内容快照定稿与 current（FS-6）。
- 快手接入（FS-7）、按需采集 Demand（FS-8）、详情（FS-9）、评论（FS-10）、媒资归档（FS-11）。
- 失败分类 / 重试 / 死信 / 补跑（FS-12）、补抓 / 取消 / 外部监控账号（FS-13）、运营命令（FS-14）、状态查询与成本（FS-15）。
- capability 门控与成本硬上限（FS-16）、ODS 清理定时执行（FS-17）、离线验证与规模演练（FS-18）、付费 smoke（FS-19）、授权与审计（FS-20）。

**非目标**：页面（本 spec 没有页面）；活动计划联动（`a-activity-plan`）；B 域真实用户与 DataScope；规则域的真实圈定逻辑；C 域信号抽取；production 启用（见 §7）。

**技术约束**（工作区规则，审查时应对照）：MySQL 8.4 InnoDB；外部 ID 一律文本；供应商请求 / 响应字节先落私有 ODS 再解析；网络 IO 期间不持有数据库事务；任务幂等 + 租约 + fencing；current 只接受 finalized 且旧批次不得倒退；默认测试离线；未登记的 platform × action × mode 在发请求前被拒绝。

## 2. 交付清单

| 任务 | 提交 | 内容 |
|---|---|---|
| 0 | `ea02dfc` `daac32e` `50ed9c3` | 文档前置：v2 基线 R1–R8 落回、A PRD v1.11、CONTEXT、ADR-0012 补记；吸收一轮外部审查 |
| 1 | `e386886` | schema 与迁移 `0004`：`sync_batches.purpose` / `media_finished_at`、`content_snapshots.seeded_from_snapshot_id`、AI Master 证据登记 |
| 2 | `3403440` | Adapter：快手 / 详情 / 评论解码，请求构造，capability 与点数表 |
| 3 | `c27e12b` `d4bd4d8` | 监控目标集、批次生命周期与调度 |
| 4 | `57508c8` `956c80a` | Worker 运行时：领取、熔断、失败映射、批次预算、资格复核、优雅停机 |
| 5 | `6b1f2e8` `d29e2e6` `01cbd4b` | 账号采集：主页、多页列表、检查点、封口、身份校验、自比对 |
| 6 | `bfa5397` `304bc63` | 按需采集：demand 提交 / 查询、详情种子快照、评论最新态、`comments` 表迁移 `0005`、CLI |
| 7 | `33ac4fb` | 媒资：账号级媒资任务对账、快手封面链、视频流式下载、音频抽取 |
| 8 | `4745f1a` | Python 能力服务 HTTP 外壳、Node 客户端、真实媒资 transport |
| 9 | `e6cd7a2` `4f275b1` | 运营命令、状态查询、每日维护、外部账号 |
| 10 | `805d66d` `cf3599c` `8601b43` | 离线验收补缺口、6,000 账号规模演练、页事务死锁重试、测试 ECS 脚本 |
| 11 | `6c3dd94` | 真实 AI Master smoke（刘学奎授权）及其发现的修复、smoke 报告 |
| 后续 | `f4566f9` `83a9ee5` | 放行快手详情异步；主页 / 详情同步失败后改走异步兜底 |

**规模**：自 spec 起点到 `main`，`src / scripts / services / tests / drizzle / spec 文档` 合计 212 个文件、+32,224 / −170 行（含测试与文档）。新增迁移两个：`0004_full_sync_batch_purpose_and_seed.sql`、`0005_full_sync_comments.sql`。新增 `src/modules` 子模块：`sync-schedule`、`sync-runner`、`monitoring`、`demand`、`comments`、`sync-status`、`sync-ops`、`maintenance`，以及 `provider-adapter` / `media-archive` / `raw-capture` 的扩展。

## 3. 关键设计与审查者应核对的不变量

下面每条都对应工作区的编码纪律；请抽查代码是否真的做到，而不是只看文档说了什么。

1. **先落 ODS，再解析**：`raw-capture/gateway.ts` 的顺序是 请求字节 → ODS → `prepared` → `in_flight` → 网络 → 响应字节 / 传输错误原文 → ODS → 终态 → 适配器解码。网络期间无事务。入口：`sync-runner/call.ts`（`callDecoded`、`poll`）与 `orchestrator/tracer-flow.ts`。
2. **结果不明（ambiguous）**：超时后原调用永久保持 `ambiguous`，**不对账**（1.0 明确不做）；只读动作最多因 ambiguous 重发 1 次（`call.ts` 的 `ambiguousCount(taskId, seq) >= 2`）。点数按"可能已计费"的上限计。
3. **整页处理**：列表已返回的页整页投影，本地 limit 只决定是否请求下一页；检查点只在全部条目终态后前进（`sync-runner/list-walker.ts`、`decide-after-page.ts`）。
4. **current 只接受 finalized，旧批次不倒退**：封口与 current 比较在同一个 fenced 事务里（`sync-runner/seal.ts`、`projection/`）。
5. **租约与 fencing**：`orchestrator/claim.ts` 每次领取 `fencing_token + 1`；所有终态写入走 `withFences`。
6. **capability 门控**：`provider-adapter/capability.ts`；production 全部 `disabled`。
7. **成本硬上限**：`sync-runner/budget.ts` 在**下一次调用前**封口；点数表在 `cost-guard`（抖音 10/10/10/评论 5，小红书各 15，快手 10/10/10，单价 ¥0.02/点）。
8. **页事务死锁重试**：`db/deadlock.ts` 的 `retryOnDeadlock`（并发 4 时约 5–9% 的页事务死锁，修复后 6,000 账号零失败）。

## 4. 验证证据

| 层 | 结果 | 来源 / 复核方法 |
|---|---|---|
| 本机 `./scripts/verify.sh`（最近一次，2026-11-06） | 603 单元 + 573 数据库（另 1 个手动演练跳过）+ 18 Python，全绿 | 重跑 `./scripts/verify.sh` |
| CI | `main` 最近四次 success（run id 见文首） | `gh run list --branch main` |
| 测试 ECS（`i-2zef8qpi1d2mldntjgrv`） | 573 通过 / 1 跳过，92.9 秒（最后一次）；含演练的一次 570 通过 | `./scripts/ecs-test.sh start` / `log` |
| 6,000 账号演练（fake transport） | 本机：规划 1.06 秒，12,000 任务执行 229 秒，RSS 403 MB，零重复；ECS：规划 1.36 秒，执行 253 秒，node 容器峰值约 696 MiB | design §12.1 |
| 真实 smoke | 见 §5 | [smoke 报告](smoke-report-2026-11-06.md) |

**这些证据证明不了的**（acceptance 的"覆盖不了"章节有完整列表）：真实供应商的 429 / 5xx / 超时行为；视频 URL 有效期、异步任务 TTL、QPS；多 worker 进程（1.0 只支持单进程，限流桶与熔断器都是进程内状态）；真实延迟下的总耗时（演练用零延迟 fake transport，数字只是下限）。

## 5. 真实 AI Master smoke（2026-11-06）

**授权**：刘学奎书面授权不限调用数 / 点数 / 金额，过程不逐项确认。**输入**：38 条未清洗的分享文案（小红书 6 主页 + 9 作品，快手 10 主页 + 6 作品，抖音 3 主页 + 4 作品），原样交给 AI Master。**环境**：本机；真实 AI Master；ODS 写入真实 OSS 的 `hbecho-ods` 桶的 `smoke/fullsync-*` 前缀（没有写永不过期的 `hbecho-media` 桶）；独立一次性 MySQL 容器；`environment: "test"`。

| 能力 | 抖音 | 小红书 | 快手 |
|---|---|---|---|
| 主页 | 3/3 | 6/6 | **4/10**（6 个自定义 ID 主页供应商解不出） |
| 稳态一轮命中旧边界 | 3/3 | 6/6 | 1/1 |
| 多页游标（篡改锚点后翻 3 页） | 通过 | 通过 | 通过 |
| 作品详情（原样脏文案直探） | 4/4 | 9/9 | 6/6 |
| 视频 + 音频端到端 | 通过 | 通过 | 通过 |

**成本**：smoke 主体 186 次供应商调用，1,570 点 ≈ ¥31.4；另 6 次 `ambiguous` 的点数上限 60 点。后续补测：快手详情异步 12 次（120 点）、快手自定义 ID 主页异步 2 次（失败不计点，≤ 20 点）。合计约 1,710 点 ≈ ¥34。**注意：点数是系统按本地价目表对成功调用累加的估算，没有与 AI Master 账单核对。**

**smoke 发现并已修复的问题**：

| # | 问题 | 修复 |
|---|---|---|
| 1 | 快手详情内容 URL 构造无样本 | 验证后 `ContentUrlBuilder` 对快手返回 `https://www.kuaishou.com/short-video/{id}`（`c.kuaishou.com/fw/photo`、`m.gifshow.com/fw/photo` 被供应商拒绝） |
| 2 | 抖音视频下载被拒：`douyinvod.com` 不在白名单 | 加入 `DEFAULT_VIDEO_POLICY` |
| 3 | 约 13% 的抖音 HEIC 封面转换失败：能力服务用 `pipe:0` 喂 ffmpeg，HEIF 元数据位置因文件而异，不可 seek 的管道报 `partial file` | `services/capability/capability/image.py` 改写临时文件；补真实样本回归用例 |
| 4 | 快手同步调用 19–48 秒，30 秒超时造成 6 次 `ambiguous` | 供应商默认超时 30 → 90 秒（`raw-capture/http-transport.ts`） |

**smoke 暴露但未解决的问题**（需要决定或需要供应商配合）：

1. **快手 `user_id` 不稳定**：同一账号时而返回数字 ID（`2904903906`）、时而返回 `3x…` ID。身份模型只有一个命名空间 `kuaishou.user_id`，所以会触发 `staff_platform_slot_taken` 与 `profile_uid_mismatch`。需要别名绑定设计，tasks"必须停下来问"第 4 项保留给产品负责人。
2. **快手自定义 ID 主页**（6/10）：同步与异步都失败（同步 `RESULT_VALIDATION_FAILED`，异步 `ACTION_EXECUTION_FAILED`），属供应商限制。
3. **快手列表**：两个 `3x…` 账号的 `user_video_list` 稳定 `RESULT_VALIDATION_FAILED`；成功调用也慢（均值 21 秒，最长 48 秒）。
4. **小红书图片 CDN 慢**：账号级媒资任务里，小红书平均约 9 秒 / 张（实测 TLS 握手 6–26 秒），抖音约 0.35 秒 / 张。本机与测试 ECS 上都复现。smoke 中媒资并发写死为 1（脚本参数，不是系统限制）。

## 6. 本轮会话内的最后两项变更（请重点审查）

### 6.1 放行快手详情异步（`f4566f9`）
去掉 `capability.ts` 里的 `disabledInTest` 与 `async_not_smoke_verified_with_canonical_url`。补测 12 次真实调用全部成功（脏文案 6 + 规范 URL 6）；提交均值 0.3–0.5 秒，轮询约 2 秒一次、不计点，端到端 5–25 秒。production 仍全部 `disabled`。

### 6.2 同步 → 异步兜底（`83a9ee5`，需求 FS-12.7）

**规则**（刘学奎确认）：仅主页（`media_user_info`）与详情（`media_stats_number`）；配置为同步的任务在第 1 次尝试因 **超时、结果不明（`ambiguous`）、`RESULT_VALIDATION_FAILED`** 失败后，第 2、3 次尝试改走异步；其它失败（429、5xx、已知未送达）保持同步；异步 capability 未放行则保持原模式；列表与评论不兜底。"放队尾"沿用既有排序 `priority DESC, attempt_count ASC`，没有新增机制。

**实现**：
- `provider-adapter/mode-fallback.ts`：`effectiveMode()`、`asyncApproved()`（纯函数 + 不抛异常的 capability 查询）。
- `sync-runner/profile-runner.ts`、`detail-runner.ts`：用 `effectiveMode` 决定本次模式；失败时把 `mode_used` 写进 `last_error_detail`，使"已进入异步"在下一次尝试保持（粘性），第 3 次不会退回同步。
- `orchestrator/tracer-flow.ts`（入口根任务 `resolve_account`）：进程内 `attemptLoop` 里用闭包变量 `fallbackToAsync`；触发来自 `Step.fallback`（结果不明，或确认为超时的传输失败）与 `validation` 步骤；`attempts.ts` 的 `Step` 加了可选字段 `fallback`。
- 6 个既有用例被改（它们原来假设三次尝试都是同步）：`demand.db.test.ts`、`profile-runner.db.test.ts`、`tracer-flow.douyin / xiaohongshu / resilience.db.test.ts`。新增 `mode-fallback.test.ts`（5 个纯函数用例）与 `mode-fallback.db.test.ts`（4 个数据库用例）。

**已知限制与审查提示**：
- 对快手自定义 ID 主页没有收益：异步同样失败（2/2 真实验证），调用次数与改动前相同（1 次同步 + 2 次异步，失败不计点）。
- `ambiguousCount(taskId, seq)` 只按 `seq` 计数，不区分模式：同步的 ambiguous 与异步提交的 ambiguous 共用"最多 2 次"的额度。这是现有语义的自然延伸，未专门测试。
- 详情的兜底只被"RVF 耗尽"一条用例覆盖（`demand.db.test.ts`），**没有"同步失败 → 异步成功"的详情用例**；主页有。
- 根任务的兜底状态存在闭包里。重放安全的论证是：第 1 次尝试永远同步，网关对已存在的调用原样返回，所以重新运行会按相同顺序走到相同模式。崩溃恢复（ambiguous）路径有用例覆盖；"跨 `retry_wait` 重新运行 + 校验失败触发"的路径没有专门用例。
- 异步轮询期间 worker 的并发槽被占用，最长 120 秒（`DEFAULT_ASYNC.maxWaitMs`）。小规模没问题，6,000 账号上线前需结合并发数评估。
- `video-runner` 在"下载地址过期后重新取详情"时用的是配置的 `detail_mode`，没有接入兜底（有意不改）。

## 7. 尚未具备的能力与诚实的边界

- **真实 worker 现在不会在任何环境启动**：`assertWorkerCanRun` 拒绝 `HBECHO_ENV=test`，并要求 production 至少有一个已批准 tuple；而 production 全部 `disabled`。真实 smoke 用的是自带装配的脚本 `scripts/smoke/fullsync-smoke.ts`（`environment: "test"`、并发 2 + 媒资并发 1、QPS 3），不是生产 worker 入口。启用 production 需要单独的人工批准，不在本 spec 内。
- **没有部署形态**：没有应用镜像 / compose；`HBECHO_SYNC_CONCURRENCY`、`HBECHO_SYNC_MEDIA_CONCURRENCY`、`HBECHO_SYNC_PROVIDER_QPS` 刻意无默认值（成本相关，必须显式配置），现在没有任何环境配过。
- **单进程**：限流令牌桶与熔断器是进程内状态，N 个进程的实际 QPS 是 N 倍。
- **CLI 服务身份无范围约束**：`pnpm sync` 的调用者拥有全平台、全专员范围；批次级命令因此只对全范围身份开放。
- **pre-B 审计只写应用日志**：持久化审计与"仅超管可查、保留一年"留给 B 域。
- **`comments` 表**由本 spec 的迁移 `0005` 补建（v2 §10.4 已定义、tracer 迁移未建）；列、约束、索引逐字按 v2，是纯新增表。tasks 当时按"需要新增表"的规则标注为"需要你知道"，2026-11-06 与产品负责人讨论后按默认保留（对方没有要求回退，但也不是正式评审结论，审查者可以独立判断）。
- **遗留临时数据**：OSS `hbecho-ods` 桶 `smoke/fullsync-ods/`、`smoke/fullsync-media/` 前缀下约 1,100 个对象（约 56 MB）；本机 MySQL 容器 `hbecho-fullsync-smoke-mysql` 与卷 `hbecho-fullsync-smoke-data`。清理命令见 smoke 报告 §7。

## 8. 建议审查重点

按"出错代价 × 测试没覆盖的程度"排序：

1. **兜底的重放与计数语义**（§6.2）：`tracer-flow.ts` 里 `fallbackToAsync` 的重放正确性；`ambiguousCount` 跨模式共用额度是否合理；`effectiveMode` 的粘性是否会在某条失败返回路径上漏写 `mode_used`（profile-runner / detail-runner 里所有 `kind: "failure"` 分支）。
2. **ambiguous 的计费口径**：点数把 `ambiguous` 按上限计入预算（`budget.ts`），但原调用永不对账。请判断这在 6,000 账号规模下是否会让预算系统性地高估或让重发系统性地多付费。
3. **快手身份模型**（§5 未解决 1）：单命名空间假设已被真实数据推翻，请评估别名绑定的可行方案与对 `identity/repository.ts`、`profile-runner` 的 `checkProfileIdentity` 的影响。
4. **并发与锁**：`retryOnDeadlock` 只包了列表页事务；请检查其它"先 `SELECT … FOR UPDATE` 再 `INSERT`"的路径（详情种子快照、评论 upsert、账号级封口）在并发下是否同样会死锁。
5. **媒资的延迟型瓶颈**：账号内的图片是 `for` 循环串行处理（`sync-runner/account-media-runner.ts`），加上小红书 CDN 每张 2–34 秒。请评估账号内并行 + 跨账号并发的改法对 `putVerified`（put + 读回校验）、`derivedMemo`、fenced 事务的影响。
6. **文档与代码一致性**：requirements FS-12.7、design §7.11、acceptance L9–L13、smoke 报告 §5.1 是否与实现一致；`HBECHO设计方案/INDEX.md` 的 a-full-sync 行是否登记了本报告。
7. **测试质量**：6 个被改的既有用例是否仍在验证原本的意图，而不是被改成了"跟着实现走"。

## 9. 复现与取证

```bash
# 本机全量验证（类型检查、单元、迁移一致、数据库、文档与密钥、Python）
./scripts/verify.sh

# 兜底相关测试
pnpm exec vitest --run --project unit src/modules/provider-adapter/mode-fallback.test.ts
./scripts/with-test-mysql.sh pnpm exec vitest --run --project db \
  src/modules/sync-runner/mode-fallback src/modules/sync-runner/profile-runner

# 测试 ECS（只用 Workbench，不用 SSH）
./scripts/ecs-test.sh start && ./scripts/ecs-test.sh log

# 看 smoke 的原始证据（本机，未入库）
ls /tmp/fullsync-smoke/          # intake-*.json、round.json、probe*.json、report.json、*.log
docker exec hbecho-fullsync-smoke-mysql ...   # 库 hbecho_fullsync_smoke，表 ods_provider_calls / sync_tasks
```

`/tmp/fullsync-smoke/` 与 smoke 数据库不进仓库，会随本机清理消失；smoke 报告里的数字是当时从该库查询所得。审查者需要原始调用级证据时，应在清理之前查询 `ods_provider_calls`（含 `call_status`、`outcome`、`elapsed_seconds`）。
