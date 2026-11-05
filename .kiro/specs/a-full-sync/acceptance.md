# A 全量周期同步（a-full-sync）· 验收

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-full-sync`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11（2026-11-05，定稿候选）§14 A3–A7
>
> **最近核对**：2026-11-05
>
> **更新日期**：2026-11-05（外部审查两轮后新增 A15–A17、B12、E24–E26、H14、K19–K20，修正 C3、J10、M11，D 组去掉重复的 D4 并重排；初建；同日吸收旧系统经验，新增 C13–C15、D10–D12、E20–E22、N9、O6–O7；尚未实施，所有结果列为「待实施」）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出或文件中看，写明谁看、看什么、检查什么。
- `[环境]`：依赖测试机、真实 OSS / Python 服务或真实供应商，不能在本机离线判定；标明当前状态。
- 每条对应 requirements 的 `FS-n`；没有「看一眼就行」的条目。
- 需要 MySQL 的自动项写成 `*.db.test.ts`（`pnpm test:db`），其余是 `unit` project（`pnpm test`）；入口是 `./scripts/verify.sh`。
- 时间一律注入 fake clock；供应商一律 fixture transport；OSS、媒资、能力服务一律 fake。

## 逐条结果

| 组 | 结果 | 测试文件 |
|---|---|---|
| D 组（FS-4，任务 5） | 通过（D1–D11） | `profile-runner.db.test.ts`、`identity-check.test.ts` |
| E 组（FS-5，任务 5） | 通过（E1–E22、E24–E26；E23 仅纯函数层） | `decide-after-page.test.ts`、`list-walker.db.test.ts`、`list-walker.recovery.db.test.ts`、`self-check.db.test.ts` |
| F 组（FS-6，任务 5） | 部分（F1、F2、F4、F6、F7 通过；F3 无读取接口、F5 等任务 6/7） | `list-walker.recovery.db.test.ts`、`seal.db.test.ts`、`full-sync-projection.db.test.ts`、`projection.db.test.ts` |
| G 组（FS-7，任务 5 部分） | 部分（G3–G6 通过；G7 的列表 `video.url` 部分等任务 7；G8、G9 等任务 6） | `list-walker.db.test.ts`、`account-sync.db.test.ts` |
| H–J 组（FS-8～10，任务 6） | 已落地，逐条对照待任务 10 补齐（代表性用例已通过：处置七类、幂等与重放、复用与「本轮」、种子快照、详情失败、评论完整性口径、`get`） | `demand/demand.db.test.ts`、`comments/comments.db.test.ts`、`comments/policy.test.ts` |
| K 组（FS-11，任务 7） | 部分（K1、K2、K4、K7、K8、K11–K14、K16、K20 通过；K5、K6 由 tracer 的 `archive.db.test.ts` 与本任务的「相同字节复用」共同覆盖；K3、K9、K10、K15 的视频路径、K17、K18 的 DNS 解析部分、K19 待任务 10 对照补证） | `sync-runner/media.db.test.ts`、`media-archive/video.unit.test.ts`、`raw-capture/oss-store.test.ts`、`media-archive/archive.db.test.ts` |
| 其余自动项 | 待实施 | — |
| 手工项 MAN1–MAN6 | 待实施 | — |
| 环境项 ENV-1～ENV-5 | 待实施 | — |

实施完成后，把每组的测试文件名与「通过」写在这里，并在下方「验收中发现并修复的缺口」登记差异。

## 自动项

### A. 计划与批次生命周期（FS-1）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| A1 | FS-1.1 | fake clock 推到配置时点，连续调用 `tick` 三次 | 只有一个 `purpose='full'` 批次；`batch_key` 由时点 UTC 值确定 |
| A2 | FS-1.1 | 两个时点（周一 02:00、周四 02:00）的配置，跨周推进 | 各时点各一个批次；周日 23:59 与周一 00:00 边界正确 |
| A3 | FS-1.2 | 批次创建后修改 `sync_settings.list_safety_page_limit` | 该批次任务读到的仍是冻结值；新批次读到新值 |
| A4 | FS-1.3 | 时点已过 30 分钟（超出容忍窗口）才首次 `tick` | 不创建批次，不补跑 |
| A5 | FS-1.4 | 批次 1 运行中，第二个时点到来 | 批次 2 `queued`，无任务 |
| A6 | FS-1.4 | 批次 1 运行，并存在一个**未到期**的排队批次（手工放置，逻辑时点不早于当前时点），新触发到来 | 新批次 `skipped`，`skip_reason='queue_full'`，无任务 |
| A7 | FS-1.5 | 批次 1 终态后 `tick` | 批次 2 立即 `running` 并规划；规划用的是**此刻**的目标集（排队期间关闭的门店不在其中） |
| A8 | FS-1.6 | 批次 2 排队至下一个时点仍未开始 | 批次 2 `expired`，状态查询可见 |
| A9 | FS-1.7 | 全成功 / 有缺口且有成功 / 全失败 / 零任务 | 分别 `succeeded` / `partial_succeeded` / `failed` / `succeeded` |
| A10 | FS-1.7 | 三个任务因监控资格失效取消 | 计入 `skipped_task_count`；批次终态不受影响 |
| A11 | FS-1.8 | 结构化任务全终态，媒资任务仍在跑 | 批次已终态；`media_finished_at` 为空；媒资任务继续被领取；全部终态后写入 |
| A12 | FS-1.9 | 在规划第 3 块之后终止，再 `tick` | `planned` 批次被恢复；任务总数 = 目标数 ×（1 或 2），无重复 |
| A13 | FS-1.10 | 查询任意时刻 `running` 的 `full` 批次数 | ≤ 1（含并发 `tick` 的顺序触发） |
| A14 | FS-1 | 时区配置为 `UTC` 启动 | 启动失败，错误说明只支持 `Asia/Shanghai` |
| A15 | FS-1.7、R8 | 规划了 5 个任务且全部因监控资格失效取消；另一批次没有任何有效目标 | 前者 `skipped/all_targets_closed`（存在 5 个已取消任务行），后者 `skipped/no_targets`（零任务行）；都不是 `succeeded` |
| A17 | FS-8.4 | 构造「上一批次排队 3 小时才晋升」：上一批次在其 `logical_at` 与 `started_at` 之间完成了某内容的详情 | 本轮（以新批次 `started_at` 为起点）**不**复用该详情；用 `logical_at` 会误复用 |
| A18 | FS-1.4、FS-1.6 | 批次 1 运行、批次 2 排队，下一个时点到来（正常时点序列） | 批次 2 先 `expired`，新批次接替并 `queued`；**不得**出现 `queue_full`（防止有人把顺序改成先创建后过期） |
| A16 | R4 | 在已有 tracer / smoke 批次行的库上应用 `purpose` 迁移 | 迁移成功；既有行 `purpose='intake'`；列为 NOT NULL 且无 DEFAULT；`drizzle-kit generate` 无新文件 |

### B. 实际监控目标（FS-2）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| B1 | FS-2.1 | 构造 分公司→板块→门店→专员→账号 全链有效 | 账号在目标集 |
| B2 | FS-2.1 | 依次关闭：分公司开关 / 经销商开关 / 门店开关 / 专员开关 / 账号开关 | 每次该账号都不在目标集，`explain` 返回对应 `*_off` |
| B3 | FS-2.1 | 依次停用：分公司 / 经销商 / 门店 / 专员 | 不在目标集；`explain` 返回 `*_inactive` / `store_closed` / `staff_inactive` |
| B4 | FS-2.2 | `external` 账号：关闭其「所属」分公司、门店（它没有） | 仍在目标集；只受账号状态与自身开关约束 |
| B5 | FS-2.3 | `status='deleted'`、`intake_status='suspected_empty'` | 不在目标集；原因码 `deleted` / `suspected_empty` |
| B6 | FS-2.3 | 专员停用 / 门店停用 | 名下账号不在目标集；归属行、历史快照不变 |
| B7 | FS-2.3 | `status='unavailable'` 的账号 | 仍在目标集（PRD §5.5 仍按周重试） |
| B8 | FS-2.4 | 同时关闭分公司与账号开关 | 原因码为 `branch_off`（最上级优先） |
| B9 | FS-2.5 | 关闭分公司，下级门店自身开关为开 | 下级值不被改写；恢复分公司后按下级原值继续 |
| B10 | FS-2.6 | 任务已规划，领取前关闭其门店 | 任务 `cancelled/monitoring_closed`；transport 调用数为 0；计入 `skipped_task_count` |
| B11 | FS-2.7 | 规划 1,200 个账号 | 事务分块（每块 ≤ 500）；没有单个事务写完全部任务 |
| B12 | FS-2.1、FS-2.4 | 品牌停用；大区停用 | 名下账号不在目标集；原因码分别为 `brand_inactive`、`region_inactive`（品牌 / 大区没有监控开关） |

### C. 任务图、幂等、租约与并发（FS-3）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| C1 | FS-3.1 | 对同一批次重复规划 | 任务数不变；幂等键冲突被吞掉 |
| C2 | FS-3.1 | `external` 账号的任务 | 只有 `fetch_profile` |
| C3 | FS-3.2 | 两个连接顺序领取 20 个任务 | 无任务被领取两次；顺序为 `priority DESC, attempt_count ASC, task_id` |
| C4 | FS-3.2 | 批次 `queued` / `skipped` / `cancelled` 下的 pending 任务 | 不被领取；终态批次的 `download_media` 可被领取 |
| C5 | FS-3.3 | worker 1 领取后租约过期，worker 2 领取 | fencing token 递增；worker 1 的页投影、检查点、封口、媒资终态全部整笔失败 |
| C6 | FS-3.4 | 取消批次后，在途任务下一次发调用前 | 心跳返回 `cancelled`；transport 不再被调用 |
| C7 | FS-3.5 | 周期任务 pending 时对同账号 `supplement` | 返回已有任务引用并提升优先级；不新建第二个任务 |
| C8 | FS-3.6 | 全流程期间监控数据库事务 | 没有事务跨越 transport / OSS / 媒资下载 / 能力服务调用（用测试 transport 在调用时断言无打开的事务） |
| C9 | FS-3.8 | 缺少 `HBECHO_SYNC_CONCURRENCY` / `HBECHO_SYNC_PROVIDER_QPS` 启动 | 失败并列出缺项；不使用默认值 |
| C10 | FS-3.8 | 并发上限 2、QPS 5，调度 20 个任务 | 同时在途 ≤ 2；每秒发起 ≤ 5（fake clock 断言令牌桶） |
| C11 | FS-3.9 | 发 `SIGTERM`（测试用 `stop(graceMs)`） | 不再领取；宽限期内完成在途；放弃的任务状态不变、租约过期后可被重新领取 |
| C12 | FS-3.10 | 在 `in_flight` 后丢进程，重新领取 | 先恢复该调用为 `ambiguous`，只读重发至多一次；已提交的页不重新请求 |
| C13 | FS-3.2、FS-12.2 | 10 个任务，第 3 个首次失败（可重试） | 其余 9 个先完成首次尝试，第 3 个的第二次尝试排在最后；没有「立即重试」 |
| C14 | FS-3.7 | 连续 K 次 5xx / 429 / 超时 | provider 熔断：停止领取，任务保持 `pending`，`attempt_count` 不变；冷却后只放行一个探测，成功恢复；探测失败则重新计时 |
| C15 | FS-3.7 | 连续出现大量 `RESULT_VALIDATION_FAILED` / HTTP 400 / 身份不符 | 不触发熔断（账号级失败） |

### D. 账号主页采集（FS-4）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| D1 | FS-4.1 | 抖音 / 小红书 / 快手各一个账号跑 `fetch_profile` | 每账号每批次一份快照；current 指向它；ODS 先于解码 |
| D2 | FS-4.1 | 同一批次同一账号重复运行 | 仍只有一份快照 |
| D3 | FS-4.2 | 真实 0 / 缺失 / 显式 `null` / 非法值 | 四种状态分别保留，不互转 |
| D4 | FS-4.4 | 注入传输错误、429、5xx、解析失败、存储失败 | 无空快照，指标不为 0；账号 `status` 不变 |
| D5 | FS-4.5 | 对已有账号连续返回 `RESULT_VALIDATION_FAILED` 直至额度耗尽 | 任务 `failed/provider_input_inaccessible`；`account_inaccessible_suspected` 存在；账号状态不变 |
| D6 | FS-4.5 | 下一批次该账号主页成功 | 上条质量问题自动 `resolved`，`resolved_by_actor='system:recovered'` |
| D7 | FS-4.6 | 已有账号主页粉丝与作品数均为 `0` | 照常写快照；`intake_status` 不变 |
| D8 | FS-4.7 | 抖音 / 小红书 / 快手主页的媒资引用 | 抖音有头像、背景；小红书、快手无 |
| D9 | FS-4.3 | 主页响应的账号标识与已登记值不同 | 不写快照、不下载媒资；任务 `failed`；`profile_uid_mismatch` 带期望值、实际值、ProviderCall 引用；已登记标识**未被改写** |
| D10 | FS-4.8 | 主页响应账号标识有效，但四项指标全是 `null` / 缺失 | 不写快照；任务按可重试的 `profile_fields_missing` 处理；不出现「全部缺失」的快照 |
| D11 | FS-4.3 | 身份校验函数的入参 | 基准只来自本次响应与 `external_account_identifiers` 登记值；不读取 `current_home_locator`、`resolved_home_url` 等可被覆盖的字段（函数签名 + 单测断言） |

### E. 列表多页、检查点与缺口（FS-5）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| E1 | FS-5.1 | 小红书 21 条首页，`initial_content_limit=20` | 21 条全部投影；不为凑 20 条而丢第 21 条 |
| E2 | FS-5.2 | 旧锚点（`time`）的最高时间 ID 出现在首页位置 1–2 | 不停止；继续按正常时间序列判断 |
| E3 | FS-5.3 | `time` 模式：条目发布时间严格早于旧高水位 | 命中；处理完当前整页后 `succeeded`，不请求下一页 |
| E4 | FS-5.3 | `time` 模式：条目时间等于高水位但 ID 不在旧集合 | 不命中，继续 |
| E5 | FS-5.3 | `id_window` 模式：条目 ID 在旧窗口 | 命中 |
| E6 | FS-5.3 | `empty` 锚点 | 只抓首个完整页；不翻页 |
| E7 | FS-5.4 | 安全页数 = 2，3 页都未命中且 `has_more=true` | 任务 `succeeded_with_gap`，`window_overflow_detected`，`stop_reason='safety_limit_rebased'`；`continuity_gap` 质量问题；批次 `partial_succeeded` |
| E8 | FS-5.5 | `has_more=false` 仍未命中 | `succeeded_with_gap`，`end_of_list_rebased`，`window_overflow_detected=FALSE` |
| E9 | FS-5.6 | E7 / E8 之后读检查点 | 新锚点由本轮已获取内容重建；`continuity_status='rebased_after_gap'`；下一轮不追旧缺口 |
| E10 | FS-5.7 | 旧锚点非空，本轮首页 0 条 | 旧锚点未被覆盖；检查点 `blocked`；任务 `succeeded_with_gap`，`empty_window_not_rebased` |
| E11 | FS-5.7 | 首次采集空列表且 `has_more=false` | 建 `empty` 锚点；任务 `succeeded` |
| E12 | FS-5.8 | 没有检查点的账号，首页 20 条且 `has_more=true` | 达到 `initial_content_limit` 即停止并建基线；不算缺口 |
| E13 | FS-5.9 | 抖音 / 小红书 / 快手的游标 | 整数 / 字符串 / 字符串（科学计数法）原样保存与回发；不互转 |
| E14 | FS-5.9 | 第 1 页提交后丢进程再运行 | 只请求第 2 页，不重复请求第 1 页；ProviderCall 数符合预期 |
| E15 | FS-5.10 | 第 N 条投影抛错 | 检查点不推进；已提交页保留；任务重试后幂等 |
| E16 | FS-5.10 | 较新批次先完成，较旧批次后完成 | 检查点版本比较拒绝旧推进；current 不倒退 |
| E17 | FS-5.11 | 同一内容在第 1 页与第 2 页各出现一次（分页漂移） | 一条内容、一份快照、一条 discovery；两次出现都被处理 |
| E18 | FS-5.12 | 小红书首页主导作者 / 抖音第二标识 / 异作者 | 与 tracer 行为一致；异作者内容保留且不建账号 |
| E19 | FS-5 | 第一页不足 4 条，`has_more=false` | 完整处理；不因前三条置顶而误停或误判缺口 |
| E20 | FS-5.13 | 20 条列表，无一条由登记作者创作 | `list_author_mismatch`：本批次该账号 `building` 快照被清除，检查点不推进，任务 `failed` |
| E21 | FS-5.13 | 20 条中 1 条异作者（共创）；3 条列表；无登记作者标识 | 分别为 `verified`、`unverifiable`、`unverifiable`；不判错；三态写入 `result_summary.identity_check` |
| E22 | FS-5.14 | 主页作品数比上周 +5，本批次首次发现 2 条 | 警告级 `suspected_missing_content`（k=5、发现 2）；任务与检查点不受影响；+0、负增长、上周主页 `missing` 时不报 |
| E23 | FS-5.9 | 列表响应 `has_more` 缺失 / 非法 | 停止翻页；`has_more_invalid`；按自然结束处理锚点；不猜测 |
| E24 | FS-5.3 | 旧锚点为 `empty`，本轮首页返回 5 条（`has_more=false`；另一用例 `has_more=true`） | 任务 `succeeded`；锚点重建为 `time` / `id_window`；**没有** `continuity_gap`、没有 `gap_task_count`；`has_more=true` 时也不翻页（`stop_reason='baseline'`） |
| E25 | FS-5.7 | 旧锚点为 `empty`，本轮仍返回空且 `has_more=false` | 保持 `empty`；任务 `succeeded`；检查点 `ready`（不是 `blocked`） |
| E26 | FS-5.9、FS-7.4 | 有旧锚点（`time`）+ 首页 + `has_more=true` 且 `max_cursor='no_more'`（raw12 K3 形态），分别构造「命中旧边界」与「未命中」 | 命中 → `succeeded`，仍记 `cursor_no_more_with_has_more`；未命中 → `succeeded_with_gap`、`stop_reason='cursor_anomaly_rebased'`、`window_overflow=FALSE`；两种都不回发 `no_more` |

### F. 内容快照定稿与 current（FS-6）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| F1 | FS-6.1 | 列表任务终态前后读快照 | 终态前 `building`，终态后（同一事务）`finalized` 且 current 已切换 |
| F2 | FS-6.2 | 第 2 页失败、任务 `dead` | 第 1 页的可靠条目被定稿；检查点未推进；没有残留的无事实 `building` 行 |
| F3 | FS-6.3 | 下游读取接口 / 查询 | 只返回 `finalized`；`building` 不可见 |
| F4 | FS-6.4 | 旧批次迟到定稿 | 历史保留；`contents.current_snapshot_id` 与检查点不变 |
| F5 | FS-6.5 | 评论、媒资任务仍在跑 | 快照已定稿，current 已更新 |
| F6 | FS-6.6 | 同批次后到的缺失 / `null` / 非法 / 不支持值 | 不擦除先前有效值；真实 `0` 覆盖；列表播放数保持 `unsupported` |
| F7 | FS-6 | 同一作品出现在两个被监控账号 | 两条内容、两份快照；不跨账号合并 |

### G. 快手（FS-7）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| G1 | FS-7.1 | capability 查询：快手 × 主页 / 列表 / 详情 × 同步；主页 / 详情 × 异步 | 通过（test 环境）；production `disabled` |
| G2 | FS-7.1 | 快手 × 列表 × 异步；快手 × 评论 | 发请求前被拒绝 |
| G3 | FS-7.2 | 快手主页 + 列表作者 | 同为 `kuaishou.user_id`；不做第二标识绑定 |
| G4 | FS-7.3 | 列表游标 `1.785394950371E12` | 作为字符串保存、回发；不转数字 |
| G5 | FS-7.4 | raw12 K3：20 条 + `has_more=true` + `no_more` | 20 条全处理；停止翻页；`cursor_no_more_with_has_more`；锚点按自然结束处理；请求中从未出现 `no_more` |
| G6 | FS-7.4 | raw12 K6：0 条 + `has_more=true` + `no_more` | 等价于空窗口：首次建 `empty`（记游标异常）；有旧锚点则 `blocked` |
| G7 | FS-7.5 | 快手主页 / 列表 `video.url` / `audio.url` | 无头像 / 背景引用；视频来源选择不取列表 `video.url` |
| G8 | FS-7.6 | 对快手内容提交 `comments` 需求 | `unsupported_platform`；不生成任务 |
| G9 | FS-7.7 | 对快手内容提交 `detail` 需求（smoke 前） | `capability_disabled`；不生成任务 |

### H. 按需采集需求（FS-8）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| H1 | FS-8.1 | 同一 actor + `demandKey` + 同载荷提交两次 | 返回同一按需批次 |
| H2 | FS-8.1 | 同键不同载荷 | 稳定的幂等冲突原因，无新批次 |
| H3 | FS-8.2 | 提交带 `ruleDecisionId` / `ruleVersion` | 每个任务保留这两个值；A 不解释其内容 |
| H4 | FS-8.3 | 七类处置各构造一个用例 | `queued` / `reused` / `already_pending` / `unsupported_platform` / `capability_disabled` / `content_not_found` / `out_of_scope` 全部可达 |
| H5 | FS-8.3 | 引用只有 `building` 快照的内容 | `content_not_found`（没有 finalized 快照） |
| H6 | FS-8.4 | 同一轮内两个计划先后对同一内容提交 `detail` | 只有一次详情 ProviderCall；第二次 `reused` |
| H7 | FS-8.4 | 下一个 `full` 批次开始后再提交 | 重新抓取 |
| H8 | FS-8.4 | `audio` 需求 | 展开为 detail → video → audio；已有视频资产则只做 audio |
| H9 | FS-8.5 | 按需批次与 `full` 批次同时存在 | 按需批次不被串行规则排队；其任务先于周期任务被领取 |
| H10 | FS-8.6 | 提交 2,000 项并在第 2 块后丢进程，同键重放 | 补齐缺失任务，无重复 |
| H11 | FS-8.7 | `get` 对每种状态 | 返回 `pending / running / ready / failed / unsupported / reused_ready` 与读取指针；调用数为 0 |
| H12 | FS-8.8 | 批次点数上限在中途耗尽 | 余下任务 `budget_exhausted`，`get` 如实展示，不静默丢弃 |
| H13 | FS-8.1 | 一次提交 5,001 项 | 稳定的校验错误，无批次 |
| H14 | FS-8.4 | 上一轮由**按需批次**产生了该内容的详情，本轮没有；本轮再提交 | 不复用，重新抓取（不得因批次用途是 `demand` 而永久复用） |

### I. 内容详情（FS-9）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| I1 | FS-9.1 | 三平台详情 fixture | `*_number` 优先；`*_count` 全 `null` 不当作独立指标；请求动作 `media_stats_number`、响应动作 `media_stats` 分列 |
| I2 | FS-9.2 | 详情成功 | 新增一行 `finalized` 快照，`seeded_from_snapshot_id` 非空，`list_observed=FALSE`，`detail_observed=TRUE`；current 比较后切换 |
| I3 | FS-9.2 | 列表独有字段（例如小红书正文）在详情快照里 | 保留种子值，不变成 `missing` |
| I4 | FS-9.2 | 详情缺失 / `null` 值 | 不擦除种子里的有效值 |
| I5 | FS-9.3 | 详情 `RESULT_VALIDATION_FAILED` 重试耗尽 | 无种子快照残留；内容 `status` 不变；`detail_inaccessible`；不写 `0` |
| I6 | FS-9.4 | `cover` / `download_urls` 为字符串、换行字符串 | 展开为候选集，全部保留 |
| I7 | FS-9.4 | 小红书图文 `play_number=null` | `explicit_null` |
| I8 | FS-9.5 | 详情作者 ≠ 被采集账号 | 返回作者按 tracer 规则保存；不建账号 |
| I9 | FS-9.6 | 响应带未知新增字段 | 解析层忽略；ODS 保留 |

### J. 评论（FS-10）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| J1 | FS-10.1 | 抖音评论 fixture（两页，游标 `"20"` → `"40"`） | 游标字符串保真；`has_more` 的 `0/1` 归一；请求 `reply_pages=-1` |
| J2 | FS-10.2 | 结果中混入 `parent_id` 条目 | 被忽略并计数；不建作者账号、不下载头像 |
| J3 | FS-10.3 | 同一评论二次出现 | 幂等 upsert；先前 `suspected_deleted` 的恢复 `active` 并清除时间 |
| J4 | FS-10.4 | 抖音翻完（`has_more=0`、未触达上限），上次存在而本次缺失的评论 | 标记 `suspected_deleted` |
| J5 | FS-10.4 | 触达 `page_limit` / `item_limit` | 不标记任何评论 |
| J6 | FS-10.4 | 传输失败 / 解析失败后 | 不标记任何评论 |
| J7 | FS-10.4 | 小红书（`total=28`、返回 2 条、`has_more=0`） | 不标记疑似删除；不视为完整 |
| J8 | FS-10.5 | `total>0` 且结果为空数组 | `comments_total_mismatch`；不记 0 条评论 |
| J9 | FS-10.5 | 小红书 `total` 大于已抓条数 | `comment_coverage_incomplete`（带 reported_total、fetched、reason） |
| J10 | FS-10.6 | 小红书第一次 `RESULT_VALIDATION_FAILED`，重试成功 | 任务 `retry_wait` 回队尾，之后从已提交页的下一游标继续；没有进程内原地重试；最终评论落库 |
| J11 | FS-10.7 | 评论抓取期间 | 内容快照结构化字段不变；不阻塞定稿 |

### K. 媒资归档（FS-11）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| K1 | FS-11.1 | 同一内容连续两个批次出现，封面首次成功 | 第二个批次不建 `cover` 引用 |
| K2 | FS-11.1 | 首次封面下载失败，下一批次再出现 | 用新地址重建引用并重试 |
| K3 | FS-11.1 | 抖音账号两个批次 | 头像、背景每批次各一次重新下载并计算 SHA-256 |
| K4 | FS-11.2 | 结构化阶段完成、媒资未完成 | 批次已终态；媒资进度独立可查 |
| K5 | FS-11.3 | 相同字节的两张图（不同临时 URL） | 一份正式资产，两个引用 |
| K6 | FS-11.3 | 临时 URL 变化、字节相同 | 不产生新资产；临时 URL 不出现在长期业务事实 |
| K7 | FS-11.4 | 快手封面 fake CDN 成功 | 原始 KVIF 为原始资产；CDN JPEG 经转换生成 JPEG q80 / 540 宽衍生资产，二者 SHA-256 不同、互不替代 |
| K8 | FS-11.4 | 快手 CDN 转换失败 | 衍生引用 `failed`；`media_cover_unavailable`；内容与原始封面不受影响 |
| K9 | FS-11.5 | 抖音视频候选 | 优先 `api-play.amemv.com` / `api.amemv.com`；从不选 `video.url` |
| K10 | FS-11.5 | 小红书 / 快手视频 | 取详情 `download_urls`；快手不取列表 `video.url` |
| K11 | FS-11.6 | 200 MB fake 视频流式下载 | 进程缓冲有上限、不随文件线性增长；SHA-256 与整文件一致 |
| K12 | FS-11.6 | 超 `maxBytes` / `Content-Length` 不符 | 中止、删除临时文件；`too_large` / `truncated` |
| K13 | FS-11.7 | 有音轨的视频 | 音频经签名 URL + fake 能力服务生成独立正式资产（m4a） |
| K14 | FS-11.7 | 无音轨视频 | `no_audio_track` 终态，不重试，不计失败 |
| K15 | FS-11.8 | 下载失败且有旧资产 | `carried_forward`，记录本轮失败；不表示为本轮成功；结构化快照不受影响 |
| K16 | FS-11.9 | `source_expired` | 重新取详情拿新地址再重试（有界）；不复用旧地址 |
| K17 | FS-11.10 | 规则未圈中的内容 | 视频从不被下载 |
| K18 | FS-11.10 | URL 指向私网 / 回环 / DNS 解析到内网 | 被拒绝，`url_rejected` |
| K19 | FS-11.1 | 抖音列表封面数组 3 条；小红书 / 快手单值 | 抖音选第 2 条；小红书、快手取单值；首次规则不改变选择 |
| K20 | FS-11.7 | 音频抽取 | `maxBytes` = 源视频字节数与 `HBECHO_MEDIA_MAX_BYTES` 的较小者；`no_audio_track` 的引用为 `failed` + 该错误码，`media-failure` 分类为 `informational`，批次媒资失败数不含它 |

### L. 失败、重试与补跑（FS-12）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| L1 | FS-12.1 | 触发每个新增失败类别 | 任务带稳定 `last_error_code` |
| L2 | FS-12.2 | 429、5xx、已知未送达的传输失败 | 退避重试，每次新 ProviderCall；达到额度 `dead` |
| L3 | FS-12.2 | HTTP 400 `INVALID_REQUEST` | 不重试，`failed`，不当作空数据 |
| L4 | FS-12.3 | 已发送、结果不明的只读调用 | `ambiguous` 保留；最多再发一次；计入调用与点数预算 |
| L5 | FS-12.4 | 任一技术失败 | 无空主页、空列表、空评论、真实 `0`、账号不存在 |
| L6 | FS-12.5 | `batch retry-failed`（最新 `full` 批次） | `failed/dead` 任务回到 `pending`；成功任务不重复；列表任务不重复已提交页；记审计 |
| L7 | FS-12.5 | 下一个 `full` 批次已开始，或非最新批次 | 被拒绝，原因明确 |
| L8 | FS-12.6 | 批次取消 | 未开始任务 `cancelled`；已落 ODS 与已提交事实保留 |

### M. 补抓、取消与外部监控账号（FS-13）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| M1 | FS-13.1 | 无运行中 `full` 时 `supplement` 一个有效账号 | `purpose='supplement'` 批次 `running`；优先级高于周期任务 |
| M2 | FS-13.1 | `supplement` 一个被关闭 / 已删除的账号 | 拒绝并给出原因码 |
| M3 | FS-13.2 | 有 `full` 运行时 `supplement` 不带 `--on-busy` | 默认 `run_now`：与 `full` 并行执行，两个批次互不阻塞；`full` 的任务数与终态不受影响 |
| M4 | FS-13.2 | `--on-busy queue` | 批次 `queued`，`full` 结束后开始 |
| M5 | FS-13.2 | `--on-busy cancel_current` | 当前 `full` 取消并审计，补抓开始 |
| M6 | FS-13.5 | 超管创建外部账号（含短链、非主页入口） | ≤3 次解析、非主页拒绝、链接与账号成对写入；`watch_type='external'`，owner 快照为空 |
| M7 | FS-13.5 | 分公司 / 总部主体创建外部账号 | 授权拒绝，发生在任何供应商调用之前 |
| M8 | FS-13.6 | 一轮周期批次包含外部账号 | 只有 `fetch_profile`（及头像 / 背景媒资）；无列表 / 内容 / 详情任务 |
| M9 | FS-13.6 | 以分公司主体列出账号 | 外部账号不可见 |
| M10 | FS-13.7 | 外部账号启停 | 只改自身开关；关闭写 `manual` |
| M11 | FS-13.4 | `supplement --only profile` 对一个新账号；`--if-older-than 168`（`full`）对「主页 3 天前、列表 3 天前」「主页 3 天前、列表 10 天前」「从未同步」三个账号；`--only profile --if-older-than 168` 对「主页 3 天前、列表 10 天前」的账号 | `--only profile` 只生成 `fetch_profile`；`full` 三个账号依次 `not_due` / `queued`（取主页与列表中较早的时间）/ `queued`；`--only profile` 那个账号 `not_due`（只看主页）；`not_due` 不创建任务；不在目标集返回 `not_eligible` |

### N. 运营处置命令（FS-14）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| N1 | FS-14.1 | `account rebind` 到名额空闲的专员 | 更新归属行；审计含操作者、时间、原 → 新；不强制填原因；既有 discovery 的 owner 快照不变 |
| N2 | FS-14.1 | 新专员同平台已有账号 | 拒绝（名额已占） |
| N3 | FS-14.2 | `account confirm-deleted` | 状态 `deleted`、`slot_released_at` 写入、归属保留；该专员可再录同平台账号；之后不被规划 |
| N4 | FS-14.3 | `issue set-status` 三种目标状态 | 状态与 `resolved_by_actor` 正确；业务数据不被删除 |
| N5 | FS-14.4 | `monitoring set` 五级 | 各级可写；账号级关闭写 `manual`；上级关闭不改下级值 |
| N6 | FS-14.4 | 分公司主体设经销商级 | 拒绝 |
| N7 | FS-14.5 | 查找停用专员的命令 | 不存在 |
| N8 | FS-14.7 | 缺 Capability / 超出品牌或平台范围 | 全部在任何供应商请求前拒绝；拒绝也写审计 |
| N9 | FS-14.6 | `monitoring set`（分公司 / 经销商 / 门店 / 专员级）、`batch cancel`、`batch retry-failed` 不带 `--apply` | 数据库零写入；输出受影响数与前 20 个示例；带 `--apply` 才生效并审计 |

### O. 查询与成本（FS-15）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| O1 | FS-15.1 | `status` / `batch <id>` | 含批次状态与用途、动作 × 状态计数、缺口数、失败原因分布、媒资进度、调用数、估算点数与金额；供应商调用数为 0 |
| O2 | FS-15.2 | `account <id>` | 含最近批次的主页 / 列表结果、锚点模式、游标类型、连续性状态、最后缺口时间、被排除原因、相关质量问题 |
| O3 | FS-15.3 | `freshness` | 列出超过一个计划间隔未成功同步的有效监控账号数与明细 |
| O4 | FS-15.4 | 全部查询输出 | 不含凭证、原始载荷、完整 OSS key、临时 URL |
| O5 | FS-15.5 | 含 `ambiguous` 调用的批次 | 点数分「已计点」与「可能已计费但未知」；上界由调用数硬上限兜底 |
| O6 | FS-15.7 | 批次含 verified / unverifiable / mismatch 各若干账号 | `status` / `account` 分三类展示；`unverifiable` 不并入 `verified` |
| O7 | FS-15.8 | `sample --n 5`（本批次成功账号 ≥ 5 / < 5） | 随机 5 个 / 全部；含入口、标识、最新摘要；供应商调用数为 0；无临时 URL |

### P. capability 与成本硬上限（FS-16）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| P1 | FS-16.1 | capability 表 | 与 FS-16.1 逐行一致（含 provider-failed 与不登记） |
| P2 | FS-16.2 | `fixture_observed` / `smoke_verified` + production 环境 | 仍被拒绝（`disabled`） |
| P3 | FS-16.3 | 点数表 | 抖音 10 / 10 / 10 / 5，小红书 15 / 15 / 15 / 15，快手 10 / 10 / 10 / 无；失败、超时、429、轮询 0 点 |
| P4 | FS-16.4 | 批次点数上限 = 100，每次 10 点 | 第 10 次成功后，第 11 次调用**未发出**（transport 计数）；余下任务 `budget_exhausted`；批次如实标记 |
| P5 | FS-16.4 | 批次调用数上限 | 同上，针对 `ambiguous` 的上界 |
| P6 | FS-16.5 | 配置某 action 为异步 / 同步 | 按配置执行；提交与每次轮询分别是 ProviderCall；代码里没有写死的全局模式 |

### Q. 定时清理（FS-17）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| Q1 | FS-17.1 | fake clock 推到 04:00 后 `maintain` 两次 | 第一次清理到期 payload → call → task → 无引用 object；第二次无新增删除 |
| Q2 | FS-17.2 | 清理前后对比 | 快照、归属、评论、检查点、正式媒资行数不变；`media` 对象未被触碰 |
| Q3 | FS-17.3 | 注入 OSS 删除失败 | 保留现场，下次重试；不级联删除业务数据 |
| Q4 | FS-17.4 | `smoke/ods/` 前缀下的孤儿对象 | 被清扫 |
| Q5 | FS-17.4 | 启动时 `HBECHO_MEDIA_TMP_DIR` 中超过 24 小时的 `.part` 文件 | 被清理 |

### R. 离线、安全与规模（FS-18、FS-20）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| R1 | FS-18.1 | 默认测试中尝试非回环网络连接 / 缺少 AI Master secret | 测试失败 / 套件仍通过 |
| R2 | FS-18.2 | fixture 覆盖清单 | 三平台 × 主页 / 多页列表 / 详情 / 评论、`RESULT_VALIDATION_FAILED`、HTTP 400 均有用例 |
| R3 | FS-18.3 | 故障矩阵 8 项 | 每项一个用例，断言「不重复付费、不产生重复事实、证据保留」 |
| R4 | FS-18.4 | 6,000 账号 / 三平台规模演练 | 无重复任务；规划耗时、峰值内存、行数已回填 design §12 |
| R5 | FS-18.5 | 搜索新增测试 | 没有用 `Promise.all` 抢同一行锁 |
| R6 | FS-20.1 | 每个入口缺 Capability / 越权 | 在供应商与媒资请求之前拒绝 |
| R7 | FS-20.2 | 周期任务身份 | 固定服务身份 `service:sync-worker`；没有任何交付出口 |
| R8 | FS-20.4 | 审计事件内容 | 含 actor、时间、对象、批次 / 任务、前后状态；不含 secret、原始载荷、临时 URL |
| R9 | FS-20.5 | 假提出方绕过 `submit` 直接写任务表 | 不存在这样的写接口（模块边界测试：只有 `demand` 模块能建按需任务） |

## 手工项

| # | 需求 | 谁看 | 看什么 | 检查什么 |
|---|---|---|---|---|
| MAN1 | FS-15 | 运营 | `sync status`、`batch <id>`、`account <id>` 的 CLI 输出 | 能回答「本周到哪了、缺了什么、哪个账号为什么没数据、花了多少」；失败原因不是内部堆栈；A §14 A4 的 `[手工]` 项通过 |
| MAN2 | FS-15.3 | 运营 | `freshness` 输出 | 能看出哪些账号该关注；条数与明细一致 |
| MAN3 | FS-8.7 | 规则域实施者 | `demand get` 的输出 | 逐项状态、失败原因、读取指针足够规则域据此判定「已获取 / 未获取成功」 |
| MAN4 | FS-20.4 | 超管 / 实施者 | 改绑、确认已删除、监控开关、`retry-failed` 的审计日志 | 每条含 actor、时间、对象、前后状态；无敏感内容 |
| MAN5 | FS-19 | 刘学奎 | smoke 审计摘要 | 调用数、点数、金额、延迟、字节数在批准预算内；无 secret |
| MAN6 | FS-18.4 | 实施者 | 规模演练记录 | 数字与 design §12 一致；无异常峰值 |

## 环境项

| # | 需求 | 依赖 | 当前状态 |
|---|---|---|---|
| ENV-1 | FS-18 | 测试 ECS 一次性 MySQL 容器：本 spec 的 `*.db.test.ts` 与 6,000 账号演练 | 待实施（需刘学奎授权） |
| ENV-2 | FS-19 | 真实 AI Master：快手主页 / 列表 / 详情、三平台详情与评论、两页以上列表 | 待实施（需批准预算与 allowlist） |
| ENV-3 | FS-11.7 | ffmpeg ≥ 7.1 + 真实 FastAPI 外壳：图片标准化与音频抽取 | 待实施（本机有则 `verify` 第 9 步覆盖；CI 不验 Python 侧） |
| ENV-4 | FS-11.6 | 真实 OSS（测试桶）：分片上传与签名 URL 读取 | 待实施（需授权；`media` 桶不设过期规则） |
| ENV-5 | FS-16.2 | production activation | 保持 `disabled`；启用另走人工批准，不在本 spec 完成时发生 |

## 覆盖不了

- **供应商的真实限流、超时与 5xx 行为**：429、真实 5xx、超时没有样本；只用故障注入验证我方处理，不证明供应商表现；
- **视频 URL 有效期、异步任务 TTL、QPS**：只有 smoke 能给线索，且线索不是合同；
- **快手详情的内容 URL 构造**：smoke 前无证据，快手详情与快手视频按需归档保持 disabled；
- **小红书评论的真实覆盖率**：口径是保守的「永不完整」，实际能抓到多少取决于供应商；
- **规模数字的外推**：演练在测试机上用 fake transport；真实供应商延迟下的总耗时无法离线得到；
- **多 worker 进程**：1.0 单进程；跨进程限流、跨进程公平性未覆盖；
- **CLI 的服务身份没有范围约束**：`pnpm sync` 的调用者是全平台、全专员范围的服务身份（持有数据库凭证的人即有此权限）；批次级命令因此只对全范围身份开放，范围收窄要等 B 域；
- **B 域真实用户与 DataScope**：只验证服务身份与品牌 / 平台范围，组织范围求交未覆盖；
- **B 域持久化审计**：pre-B 审计只写应用日志；「仅超管可查、保留一年」未覆盖；
- **规则域的真实圈定逻辑**：只用假提出方验证接入契约，D 的 spec 落地后需要再做一次联调验收；
- **C 域的读取**：只保证 finalized 与媒资读取方式，C 的信号抽取不在范围；
- **活动计划联动**：15 天无引用停采、计划恢复重开、计划删除，不在本 spec，由 `a-activity-plan` 验收；
- **页面**：本 spec 没有页面，F3 台账与处置工作台不在范围。

## 验收中发现并修复的缺口

实施完成后在此登记（编号、现象、修复、对应测试）。当前为空。
