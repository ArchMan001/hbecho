# Data Foundation Tracer Implementation Plan

> **状态**：`draft`  
> **执行状态**：本文件只规划；本轮文档重组**不执行任何实现任务**  
> **需求**：[`requirements.md`](requirements.md)  
> **设计**：[`design.md`](design.md)  
> **更新日期**：2026-09-02

## Planning rules

- 以下任务按纵向结果排序；完成一个任务时应留下可运行、可观察的增量，而不是只创建空表或空 Interface。
- 默认验收必须离线：fixture transport、fake clock、fake lease、fake OSS、network denied；不得需要 AI Master secret。
- 每个任务完成前运行其离线 acceptance，记录尚未证明的供应商 capability；通过 fixture 不等于生产能力已验证。
- 不在任务中预选应用框架、ORM、队列或缓存。若实现前必须做难逆选择，应单独提出决策，而不是隐藏在脚手架里。
- 所有内部 BIGINT transport 值输出十进制字符串；外部 ID 始终保留原始文本。

## Tasks

- [ ] 1. 锁定离线 fixture 与供应商合同边界
  - **Requirements:** R2, R5, R6, R9, R10, R11, R13, R16
  - 建立抖音/小红书 `media_user_info` 与 `user_video_list` fixture 清单、来源、checksum 和 evidence label；明确现有 `raw3` 是解析后包络，不标成原始 HTTP capture。
  - 定义 versioned Adapter 输入/输出合同：requested action、expected response action、captured actual response action、ValueState、外部 ID text、identifier namespace、完整 entries 和 typed cursor；expected/actual 必须分列，mismatch 保留两值并分类。
  - 锁定哪些 Home locator strategy 会产生 captured terminal `media_user_info` payload；已有 payload 必须复用，只有没有 payload 的 strategy 才允许一次独立 profile fetch，并明确每种策略的预期 ProviderCall 数。
  - 锁定首版 Xiaohongshu dominant-author policy（唯一最高、最低占比/绝对多数、空值与异常分布）及 policy version；未决时绑定 capability 保持 disabled。
  - 定义 platform × action × mode × environment capability registry，显式区分 `supplier_declared/fixture_observed/smoke_verified` 与 `production approved`；raw3 只能赋予 fixture evidence，未验证异步的 evidence 保持 unknown，所有 production activation 保持 `disabled`。
  - 固定测试 harness 的 network-denied、fixture transport、fake clock/fake OSS seam，并确保 fixture 与日志不含 secret。
  - **Offline acceptance:**
    - 抖音 fixture 被识别为 target `HITACHI1`、20 entries、foreign author `HITACHI2023`、integer cursor；
    - 小红书 fixture被识别为 profile `49328995493`、dominant author `5decba2300000000010007e1`、21 entries、string cursor；
    - 已选 locator/profile 策略的 ProviderCall 数与锁定合同一致，重复提交或已有 captured profile payload 不增加调用；
    - fixture-observed tuple 不能在 production environment 激活；尝试真实 socket 或未注册 platform/action/mode 时测试立即失败，且没有付费调用。

- [ ] 2. 建立 tracer 命令、幂等根任务与本地状态纵向骨架
  - **Requirements:** R1, R15, R18
  - 实现 `AccountTracerCommandModule` 和 `TracerStatusQuery` 的稳定 Interface；HTTP path 或其他 transport 在本任务中按评审结果冻结，但 transport 不泄漏到 Module 内部。
  - 在任何网络行为前执行 service-principal Capability、目标 scope、capability gate、canonical payload 和 idempotency 校验。
  - 将 canonical command 固定映射为 root SyncTask：platform、`subject_type='media_staff'`、staff subject ID、原始 locator，以及通过两字段 `data-foundation-tracer-task-parameters.v1` persistence-projection schema 校验的 effective limit；再组装独立五字段 `data-foundation-tracer-command.v1` aggregate，摘要严格按 v2 §5.5 的 RFC 8785 JCS UTF-8 bytes 计算，不做 Unicode normalization，并锁定 command 跨实现 digest vector。
  - 建立 root/stage 状态、logical-effect key、cancel、lease/fencing 和 audit-safe event；一年窗口内相同 key+payload 返回同一 root，不同 payload 返回 conflict，窗口外按新命令处理。
  - Status 从本地事实组装 structured/media/failure 进度，执行 scope/redaction；查询路径不得调用 provider 或 media origin。为 secret、raw body、完整 ODS key、临时 URL、越权 account/assignment ID 建立逐字段 deny/redaction policy。
  - **Offline acceptance:** duplicate submission、key conflict、unauthorized/unsupported preflight、cancel 和 unknown/out-of-scope status 均有稳定结果；TypeScript/Python/SQL fixture 对 v2 command exact JCS bytes 产生同一 SHA-256，覆盖 Unicode、转义、key 输入顺序、BIGINT decimal string、integer 与 absent/null/unknown-field rejection；redaction fixture 证明上述敏感字段不出现在 body/log；fake clock 证明一年内返回原 root、到期后旧 status 不再承诺且复用 key 创建新 root 仍不重复长期业务事实；对 status query 断言 ProviderTransport 调用次数为 0。

- [ ] 3. 打通 raw-before-parse ProviderCall 纵向链路
  - **Requirements:** R2, R13, R14, R16, R18
  - 实现 `RawCaptureGateway` 与 `CapturedProviderResult` seam：发送前 request bytes + prepared ProviderCall intent 先进入私有 ODS/数据库；完整 response bytes 或 transfer error 也先落 ODS，再允许 versioned Adapter decode。
  - 每个 submit/poll/retry 使用独立 ProviderCall，分列记录 requested action、immutable expected response action 与 captured actual response action，并记录 `prepared/in_flight/terminal/ambiguous`、mode、attempt、timing、bytes、hash、safe metadata、root/task correlation 和 Adapter version；排除认证 header/secret。
  - 让 fake OSS 支持 request-intent failure、durable-write failure、hash mismatch、truncated body、in-flight process loss 和 terminal-capture failure；解析可从 captured ref 重放但不覆盖旧 lineage。
  - 实现一年保留期的 payload→call→task 清理闭包及 ODS orphan sweeper；证明不会删除长期 snapshot/assignment/discovery/checkpoint/media facts。
  - 确保所有网络等待发生在数据库事务之外，提交结果时复核 lease/fence；发送前取消、预算或本地策略封口把 durable intent 置为 `terminal/not_sent`；已知未送达的 transport failure 与远端结果不明的 `ambiguous` 分开，后者没有供应商幂等或 reconcile 证据时不得盲目重发。
  - **Offline acceptance:** request intent 未提交时 network send=0；prepared 后取消得到 `terminal/not_sent` 且 send=0；终态 ODS write/integrity failure 时 decoder/projector=0；expected/actual action mismatch 同时保留两值并进入 `invalid_response`；完整响应、known non-delivery transport error、timeout/process-loss ambiguous 及 reconciled 两种终态都满足 v2 字段/nullability/payload 矩阵；self-reference、仅 correlation ID、不同 task/provider/platform、pending/invalid 或无完整 terminal payload 的 reconcile call 均不能终态化 ambiguous，只有同 logical effect 的 captured terminal call 经 versioned mapping 后可以；resume 不重复已完成或结果不明的付费 effect；stale worker 不能提交可变状态；fake clock 推进一年清理后长期业务事实仍存在。

- [ ] 4. 打通抖音账号 tracer 纵向切片
  - **Requirements:** R3, R4, R5, R7, R8, R9, R10, R11, R14, R18
  - 实现抖音 Home locator 策略与最多三次解析；三次失败终态不得产生 account/identifier/assignment/snapshot/discovery/checkpoint。
  - 通过 captured `media_user_info` 创建/复用 namespaced ExternalAccount 标识，建立无冲突 AccountAssignment，投影 finalized profile snapshot 和 profile media references；若 locator 阶段已产生同一 captured profile payload 必须复用。
  - 覆盖已有其他 MediaStaff 有效归属：保留旧 Assignment、root 进入 blocked conflict、submitted staff 不成为 owner，默认不再发后续付费调用。
  - 通过 captured `user_video_list` 处理完整 20 entries，按 v2 创建/复用 ContentSnapshot 与每条批次级 ContentDiscovery，保留 target 与 returned author 两份事实。
  - 对 `HITACHI2023` 只记录 returned-author content fact，不创建账号/归属，也不单凭差异创建质量问题。
  - 在全页投影完成后保存 integer cursor checkpoint；用 fence 防止旧 run 回退 current/checkpoint。
  - **Offline acceptance:** 一次命令得到 target `HITACHI1`、1 个有效 assignment、1 个 finalized profile、20/20 processed entries、20 个预期批次级 discovery、无 `HITACHI2023` ExternalAccount、integer checkpoint；ProviderCall 数符合任务 1 锁定策略，duplicate/resume 无重复业务事实；assignment-conflict fixture 保持旧 owner 且不会继续付费。

- [ ] 5. 打通小红书多命名空间身份纵向切片
  - **Requirements:** R3, R4, R5, R6, R7, R8, R9, R10, R14, R18
  - 实现小红书 Home locator 的平台校验、最多三次解析和成功证据复用；覆盖平台错配与三次失败，二者都不得创建 account/identifier/assignment/snapshot/discovery/checkpoint。
  - 投影 profile ID `49328995493` 到 v2 `xiaohongshu.profile.user_id` namespace，不把它与列表作者 ID 做字符串或昵称猜测。
  - 在完整第一页上统计 exact non-empty author IDs；唯一主导作者 `5decba2300000000010007e1` 只有通过 versioned policy 后，才以 `dominant_list_author` evidence 绑定到同一 ExternalAccount 的 `xiaohongshu.content.user_id` namespace。
  - 成功绑定使用 v2 `dominant-list-author-evidence.v1`，将 policy version、accepted reason、candidate、exact counts、总 entries、非空 denominator、RFC 8785 JCS evidence SHA-256 与长期 batch 引用写入同一 `external_account_identifiers` 行；后续 replay 不覆盖首次绑定证据。
  - 对 tie、empty、唯一但低占比或其他 policy rejection fail closed，不创建猜测 identifier；使用同一 evidence schema 将 rejected reason、policy version、counts、denominator 和长期 batch 引用写入 `data_quality_issues`；minority authors 只进内容事实。
  - 覆盖既有 Assignment 冲突，与抖音执行同一不抢占/默认停止付费语义。
  - 处理已返回 21 entries，即使 `initial_content_limit <= 20`；建立 string cursor checkpoint。
  - **Offline acceptance:** 一个 ExternalAccount 同时拥有两个不同 namespace 的预期 ID、21/21 entries 被投影、没有 minority-author account、cursor 保持 string；TypeScript/Python/SQL fixture 对 v2 evidence exact JCS bytes 产生同一 SHA-256，覆盖 key 输入顺序、exact identifier、integer、candidate null 与 absent/unknown-field rejection，且成功 evidence 的 shape、列值和计数总和均可验证；tie/empty/唯一低占比 fixture 均无绑定且 rejected evidence/problem 可见；平台错配、三次失败和 assignment conflict 均无错误 owner 或后续付费副作用；fake clock 推进超过一年并清理 task/call/raw 后，成功 identifier 仍能仅凭长期 evidence 与 batch 解释 policy、candidate、exact counts、denominator 和 accepted reason。

- [ ] 6. 完成跨平台完整页、Discovery 与 typed checkpoint 契约
  - **Requirements:** R8, R9, R10, R11, R14, R18
  - 抽取 `ContentListProjector` 和 `CheckpointModule` 的平台无关 Interface；停止判断只能发生在完整页提交之后。
  - 明确 content identity、immutable snapshot、target-list Discovery、returned author 和 assignment context 的 grain；不同 Assignment 的同一 content 保留多个 Discovery，同一 batch+Assignment 的重复 entry 全部处理但只生成一个 Discovery，重复位置/count 进入 page/call evidence 和质量摘要。
  - 将 v2 长期 checkpoint 限定为 account/provider/action/scope、typed `cursor_envelope`、anchor/high-watermark、batch、continuity、version 和 updated time；`has_more`、page/processed count、ProviderCall 与 Adapter version 留在一年期 task/call lineage，不另建平行 checkpoint。
  - 覆盖 empty-success、entry projection failure、duplicate entry、same content across assignments、null/empty/long cursor、旧批次迟到和 cancellation。
  - **Offline acceptance:** contract checks 证明 returned count 等于 required processed count 后才推进；同一列表重复 content ID 不丢 entry 处理证据也不违反 v2 Discovery 唯一键；21-entry page 不被 local limit 截断；integer/string round-trip 不互转；任一 entry 失败或 stale fence 时 checkpoint version 不前进。

- [ ] 7. 打通正式媒资归档与独立进度
  - **Requirements:** R8, R12, R15, R16, R18
  - 从 profile/content snapshot 产生 avatar、background、cover 的 versioned MediaReference；临时 URL 只作 source locator。
  - 实现 `MediaArchiveModule`：idempotent demand、bounded fake/real download seam、私有临时对象、完整 bytes SHA-256、size/type verification、formal MediaAsset dedupe 和 verified binding。
  - 实施 scheme/host/redirect/size/content-type/timeout/SSRF guard；网络期间不持有数据库事务，签名 URL 不进长期事实。
  - Root/status 分开显示 structured checkpoint 与 media pending/archived/retryable/terminal warning；media failure 不回滚结构化结果。
  - **Offline acceptance:** fake OSS 下相同 bytes 去重、不同 bytes 不按 URL 合并；过期 URL/超限/截断/失败都保留 snapshot 和 warning；默认测试无网络媒体请求。

- [ ] 8. 补齐同步/异步、租约、重试、取消与恢复
  - **Requirements:** R2, R13, R14, R15, R18
  - 对 verified synchronous action 实现单次 captured terminal result；对 test-only asynchronous capability 实现 captured submission + persisted task ID + each-poll ProviderCall + bounded terminal handling。
  - 将 provider auth、quota/rate、transport、ODS、parse/schema、identity、assignment、projection、media、stale fence 分类到稳定 reason/retry policy；技术失败绝不映射为空 profile/list，`in_flight` 失联进入 ambiguous 且无 reconcile 证据时不自动重发。
  - 实现 stage lease heartbeat、monotonic fence、retry wait、deadline、cancel 和 crash resume；已完成付费 effect 不重复，结果不明的远端 effect 不盲重试，迟到 worker 不回退 current/checkpoint。
  - 为 call/page/poll/media 设置硬上限和 cost counters；超限在下一次调用前停止。同步或异步生产 tuple 都必须达到 `smoke_verified + production approved`，不能由 fixture evidence 启用。
  - **Offline acceptance:** fake async pending→success、pending→provider failure、timeout、rate limit、crash-before-send、crash-after-send-before-terminal-capture、crash-after-project、cancel-during-poll、lease takeover 全部可重复运行；provider idempotency/correlation 只能授权安全 retry 或 reconcile lookup，ambiguous 原调用只有引用同 logical effect 的 captured terminal reconcile call 且通过 versioned outcome mapping 才可终态化，并且全程无重复业务事实或 stale publication。

- [ ] 9. 建立人工批准、预算受限的真实 smoke
  - **Requirements:** R2, R13, R14, R17
  - 提供独立于默认 tests/CI 的 smoke 入口；启动前强制 human approval、显式 runtime switch、locator/action/mode allowlist、secret provider、固定 call/cost budget 和 deadline。
  - 首轮只验证最小 `media_user_info`/`user_video_list` tuple；异步 mode 必须作为独立 smoke，不因同步成功而启用。
  - 每个真实 submit/poll/retry 仍走 RawCaptureGateway、ProviderCall、cost guard 和 redacted audit；达到预算或 deadline 时在下一次调用前停止。
  - 输出 audit summary：实际 tuple、calls、polls、latency、bytes、estimated cost、result category、schema/Adapter version 和 evidence refs，不含 secret/full payload。
  - 将实测结果更新为对应 capability 的 evidence；认证 header、QPS、计费、task TTL 或 schema 差异继续显式记录，不能自动外推。
  - **Manual acceptance:** 审批记录、预算预览、停止行为、raw-before-parse evidence 和审计摘要均由操作人确认；没有批准时命令必须在任何网络调用前失败。

## Final implementation acceptance

完成全部任务仍不自动代表 Feature 可发布。发布评审必须逐条回看 [`requirements.md`](requirements.md) 的 R1–R18，并提供：

1. 默认离线 suite 的网络禁用证明与 fixture 结果；
2. 抖音 20 条、小红书 21 条、异作者/主导作者和 typed cursor 的实际断言；
3. ODS-before-decode 故障注入、assignment conflict、resume 和 stale-fence 结果；
4. structured/media 独立状态与本地 status 无供应商调用的证据；
5. 若启用任何生产 capability，对应批准式 smoke、固定预算和审计摘要；
6. 所有仍开放决定的显式清单，确保未被实现默认值静默冻结。