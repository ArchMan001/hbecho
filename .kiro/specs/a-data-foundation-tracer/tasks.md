# A Data Foundation Tracer Implementation Plan

> **状态**：`draft`  
> **执行状态**：任务 1 已完成（离线合同层，1/9）；任务 2 未开始  
> **需求**：[`requirements.md`](requirements.md)  
> **设计**：[`design.md`](design.md)  
> **验收**：[`acceptance.md`](acceptance.md)  
> **所属域**：A 数据底座 · **目录命名**：`a-data-foundation-tracer`，符合 `<代号>-<切片>`  
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10（2026-11-04，定稿候选）  
> **最近核对**：2026-11-04（A v1.10；v2 六项冲突已修订；design §18 P0 已按默认值关闭）  
> **更新日期**：2026-11-04

## Planning rules

- 以下任务按纵向结果排序；完成一个任务时应留下可运行、可观察的增量，而不是只创建空表或空 Interface。
- 默认验收必须离线：fixture transport、fake clock、fake lease、fake OSS、network denied；不得需要 AI Master secret。
- 每个任务完成前运行其离线 acceptance，记录尚未证明的供应商 capability；通过 fixture 不等于生产能力已验证。
- 应用栈已由 ADR-0005 冻结（Next.js + Drizzle + better-auth + MySQL 任务表）；任务中不重新选型。目录约定按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)：领域代码在 `src/modules/`，离线 fixture 在 `tests/fixtures/`。
- 所有内部 BIGINT transport 值输出十进制字符串；外部 ID 始终保留原始文本。
- requirements §1.2 的六项基线冲突已于 2026-11-04 在 v2 修订；实现以 v2 修订稿为准，见 requirements §1.2 的注。第 7 项是 tracer 与名单导入的范围区别，不阻塞本 spec。
- 任务边界跑 `./scripts/verify.sh`；它已含 Node 版本、类型检查与离线测试，真实 MySQL 集成测试从任务 2 起才有，在此之前不声称“数据库测试通过”。

## Tasks

- [x] 1. 锁定离线 fixture、供应商合同与值状态边界
  - **Requirements:** R2, R5, R6, R9, R10, R11, R13, R16, R19
  - 建立抖音/小红书 `media_user_info` 与 `user_video_list` fixture 清单、来源、checksum 和 evidence label；明确 raw3 是解析后包络，raw4/raw5/raw8 是保存的请求/响应样本，都不替代实现层 raw-before-parse 故障注入。
  - 定义 versioned Adapter 输入/输出合同：requested action、expected response action、captured actual response action、五态值状态（`value/missing/explicit_null/invalid/unsupported`）、外部 ID text、identifier namespace、`content_kind`、完整 entries 和 typed cursor；expected/actual 必须分列，mismatch 保留两值并分类。
  - 锁定主页入口类型（`home/video/note/unknown`）、最小清洗规则（截掉路径之后的分享文案，原值与清洗值都保留），以及非主页入口不建账号/归属/不重试的合同。
  - 入口识别（2026-11-04 定）：本地只按 URL 路径特征识别**明确**的视频/笔记链接（如 `douyin.com/video/`、`xiaohongshu.com/explore/`、`/discovery/item/`），直接拒绝、不发请求；短链与分享口令记 `unknown` 照常调 `media_user_info`。目前没有「把非主页链接传给 `media_user_info`」的供应商样本，因此「供应商返回非主页账号 → 终止」这条在任务 9 smoke 拿到样本后再补；缺口记入 capability 证据。最小清洗只截掉第一个 URL 路径之后的字符，前缀分享文案保留（raw3 实测整段发送成功）。
  - fixture 不复制：`tests/fixtures/aimaster/manifest.json` 登记来源路径、SHA-256 与 evidence label，loader 直接读 `aimaster接口文档/测试结果/` 并校验哈希。
  - 单一解析策略：清洗后直接调 `media_user_info`，其返回即主页投影来源；「最多三次」是对 `RESULT_VALIDATION_FAILED` 的有界重试；成功路径调用数固定为主页 1 + 列表 1。
  - 实现 Xiaohongshu dominant-author policy `xhs-dominant-author.v1`：唯一最高、候选至少出现 3 次且占非空作者条目 ≥ 80%；两项阈值均为配置。
  - 定义 platform × action × mode × environment capability registry，显式区分 `supplier_declared/fixture_observed/smoke_verified` 与 `production approved`；按 raw4/raw5/raw8 固化“同步主页/列表、异步主页可用；异步列表 provider-failed”的 tuple 结论；所有 production activation 保持 `disabled`。
  - 固定测试 harness 的 network-denied、fixture transport、fake clock/fake OSS seam，并确保 fixture 与日志不含 secret。
  - **Offline acceptance:**
    - 抖音 fixture 被识别为 target `HITACHI1`、20 entries、foreign author `HITACHI2023`、integer cursor；`content_kind` 按条目规则推断；列表播放数为 `unsupported`；
    - 小红书 fixture 被识别为 profile `49328995493`、dominant author `5decba2300000000010007e1`、21 entries、string cursor；无 avatar/background 引用；封面取单值 `cover`；
    - 成功路径 ProviderCall 数 = 主页 1 + 列表 1；重复提交不增加调用；
    - 主导作者：21/21 绑定；唯一最高但低于 80%、tie、空作者均拒绝；
    - 非主页入口、`unknown` 入口类型和三次失败都不产生账号/归属；
    - fixture-observed tuple 不能在 production environment 激活；尝试真实 socket 或未注册 platform/action/mode 时测试立即失败，且没有付费调用。
  - **完成记录（2026-11-04）：** 本任务只在**合同层**证明，没有数据库、没有 ProviderCall 持久化。`./scripts/verify.sh` 通过（Node 24.22.2；typecheck；11 个测试文件 134 条用例，离线、禁网）。
  - **Requirements → 覆盖测试**（只列任务 1 实际覆盖的条款；其余条款由后续任务覆盖）：

    | Requirement | 任务 1 覆盖的部分 | 测试 |
    |---|---|---|
    | R2.6 / R2.8 / R2.9 | 解码结果记录 Adapter 版本；fixture 与请求不含认证头与云凭证特征；manifest 声明 raw3 是解析后包络、不替代 raw-before-parse | `decode-profile.test.ts`、`tests/harness/fixtures.test.ts` |
    | R3.1–R3.5 / R3.10 | 入口类型 `home/video/note/unknown`；最小清洗读法（前缀保留、截掉第一个 URL 之后）；非主页入口拒绝且不可重试；最多三次 = 对 `RESULT_VALIDATION_FAILED` 的有界重试；成功路径 = 主页 1 + 列表 1 | `locator.test.ts`、`strategy.test.ts` |
    | R4.1 / R4.2 | 三次耗尽的终态决定与被拒入口的结果里没有任何账号/归属/快照字段（类型与键集合断言）；真正「库里无新增」由任务 4/5 验证 | `strategy.test.ts`、`locator.test.ts` |
    | R5.1 / R5.5 / R5.6 / R5.7 | 外部 ID 与整数游标按文本/原文保留（含 > 2^53）；真实 0 / 缺失 / null / 非法 / `unsupported` 五态；列表播放数恒为 `unsupported`；缺 `text` 等按条目容错 | `lossless-json.test.ts`、`value-state.test.ts`、`decode-video-list.test.ts`、`decode-profile.test.ts` |
    | R5.2 / R5.3 / R5.4 | 解码阶段为每个 ID 标注 namespace（`douyin.user_id` / `douyin.sec_uid` / `xiaohongshu.profile.user_id` / `xiaohongshu.content.user_id`）；查找、哈希复核、绑定在任务 4/5 | `decode-profile.test.ts`、`decode-video-list.test.ts` |
    | R6.1 / R6.2 / R6.5 / R6.6 | `xhs-dominant-author.v1`：唯一最高、候选 ≥ 3 次且 ≥ 80%（含边界）；tie / 空作者 / 样本不足 / 低占比拒绝；证据含精确计数、分母、policy 版本；21/21 正例；绑定到同一账号与 JCS 证据在任务 5 | `src/modules/identity/dominant-author.test.ts` |
    | R9.2 / R9.4 / R9.6–R9.9 / R9.11 | 解码不截断：抖音 20、小红书 21 条全部返回；重复 post_id 不去重；`content_kind` 推断表且不输出 `mixed`；抖音封面取数组第 2 条、小红书取单值 `cover`；0 条 + `has_more=false` 是真实空列表，`result` 非数组是 `schema_drift` | `decode-video-list.test.ts` |
    | R10.4 / R10.9 | 抖音 `max_cursor` 为 integer（`1782701295000`），小红书为 string；请求回发保持类型，超大整数不丢精度 | `decode-video-list.test.ts`、`request.test.ts` |
    | R11.4（解码部分） | 抖音 19 条 `HITACHI1` + 1 条 `HITACHI2023`，异作者保留；不创建账号在任务 4 | `decode-video-list.test.ts`、`dominant-author.test.ts` |
    | R13.1 / R13.4–R13.8 | 仅两个 action 的路径；`async` 取自 mode 不写死；production 8 个 tuple 全部拒绝；fixture_observed 不能激活 production；异步列表两平台 `provider_failed`；证据引用与 manifest 文件内容互相核对；认证头矛盾与非主页链接响应缺口记入 `knownGaps` | `request.test.ts`、`capability.test.ts` |
    | R16.1 / R16.2 / R16.3 / R16.4 | 禁网（外部 fetch / net.connect / http.get 立即失败，且测试期间任何被拒尝试都会使测试失败）；fixture transport 未登记请求立即失败；抖音/小红书 fixture 断言（HITACHI1、20/21 条、异作者、游标类型、`content_kind`、`unsupported`、封面规则、无头像/背景候选） | `tests/harness/harness.test.ts`、`decode-*.test.ts` |
    | R19.2（取值部分） | 粉丝 0 且作品 0（均为真实 0）才是疑似空账号；缺失 / null / 非法不是；写 issue 与 `intake_status` 在任务 4 | `decode-profile.test.ts` |

  - **任务 1 未覆盖、已转交后续任务的验收项：** 「重复提交不增加调用」需要幂等存储 → 任务 2（acceptance A2）；「三次失败/非主页入口后库里无账号与归属」需要数据库 → 任务 4/5；fixture 经过真实 ODS 捕获再解码的顺序与故障注入 → 任务 3。
  - **仍开放的证据缺口（记入 capability `knownGaps`）：** 供应商对「视频/笔记链接传给 `media_user_info`」的真实响应没有样本，因此 `unknown`（短链、口令）照常发送，「返回非主页账号则终止」待任务 9 smoke 补；文档 Bearer 与实测 `X-Api-Key` 矛盾，保存的样本请求头里不含认证头。
  - **实现留下的取舍（供复核）：** ① 外部 ID 字段为空串记 `invalid`，不当作 `missing`；② 主导作者策略的分母是非空作者条目（与 v2 evidence 的 `non_empty_author_entry_count` 一致）；复核后补充「候选至少 3 次」，「1 条非空 + 20 条空」因此以 `insufficient_samples` 拒绝；③ 拒绝原因枚举（`no_non_empty_author` / `tie_for_highest` / `insufficient_samples` / `below_threshold`）为本任务暂定，任务 5 做 evidence schema 时需与 v2 核对；④ 回环地址不受禁网限制（后续任务要连本机一次性 MySQL）。

- [ ] 2. 建立 tracer 命令、幂等根任务与本地状态纵向骨架
  - **Requirements:** R1, R15, R18
  - 实现 `AccountTracerCommandModule` 和 `TracerStatusQuery`，入口为 CLI `pnpm tracer submit|status|cancel`（design §14），不做 HTTP。
  - 建立 Drizzle schema 与迁移（本任务首次建表）：v2 中 tracer 用到的表；验证 drizzle-kit 能否生成 CHECK、复合外键、生成列唯一键与受限写入过程，不支持的部分写手写 SQL 迁移，并把结论回填 ADR-0005「已知坑」第 7 行（R6-06）。
  - 准备测试种子：品牌、大区、分公司、板块、经销商、门店、`MediaStaff` 各若干行（复用 `seed/分公司-大区对照.csv`），只用于离线测试与测试机一次性库。
  - 在任何网络行为前执行 service-principal Capability、目标 scope、capability gate、canonical payload 和 idempotency 校验；同账号同动作已有活动任务时复用。
  - 将 canonical command 固定映射为 root SyncTask：platform、`subject_type='media_staff'`、staff subject ID、原始 locator，以及通过两字段 `data-foundation-tracer-task-parameters.v1` persistence-projection schema 校验的 effective limit；再组装独立五字段 `data-foundation-tracer-command.v1` aggregate，摘要严格按 v2 §5.5 的 RFC 8785 JCS UTF-8 bytes 计算，不做 Unicode normalization，并锁定 command 跨实现 digest vector。
  - 建立 root/stage 状态、logical-effect key、cancel、lease/fencing 和 audit-safe event；一年窗口内相同 key+payload 返回同一 root，不同 payload 返回 conflict，窗口外按新命令处理。
  - Status 从本地事实组装 structured/media/failure 进度与 entry outcome，执行 scope/redaction；查询路径不得调用 provider 或 media origin。为 secret、raw body、完整 ODS key、临时 URL、越权 account/assignment ID 建立逐字段 deny/redaction policy。
  - **Offline acceptance:** duplicate submission、key conflict、unauthorized/unsupported preflight、cancel、同账号同动作复用和 unknown/out-of-scope status 均有稳定结果；TypeScript 实现对 v2 §5.5 两个固定向量的 exact JCS bytes 产生文档指定的 SHA-256，覆盖 Unicode、转义、key 输入顺序、BIGINT decimal string、integer 与 absent/null/unknown-field rejection；redaction fixture 证明上述敏感字段不出现在 body/log；fake clock 证明一年内返回原 root、到期后旧 status 不再承诺且复用 key 创建新 root 仍不重复长期业务事实；对 status query 断言 ProviderTransport 调用次数为 0。

- [ ] 3. 打通 raw-before-parse ProviderCall 纵向链路
  - **Requirements:** R2, R13, R14, R16, R18
  - 实现 `RawCaptureGateway` 与 `CapturedProviderResult` seam：发送前 request bytes + prepared ProviderCall intent 先进入私有 ODS/数据库；完整 response bytes 或 transfer error 也先落 ODS，再允许 versioned Adapter decode。
  - 每个 submit/poll/retry 使用独立 ProviderCall，分列记录 requested action、immutable expected response action 与 captured actual response action，并记录 `prepared/in_flight/terminal/ambiguous`、mode、attempt、timing、bytes、hash、safe metadata、root/task correlation 和 Adapter version；排除认证 header/secret。
  - 让 fake OSS 支持 request-intent failure、durable-write failure、hash mismatch、truncated body、in-flight process loss 和 terminal-capture failure；解析可从 captured ref 重放但不覆盖旧 lineage。
  - 实现一年保留期的 payload→call→task 清理闭包及 ODS orphan sweeper；证明不会删除长期 snapshot/assignment/discovery/checkpoint/media facts，且清理可幂等重跑。
  - 确保所有网络等待发生在数据库事务之外，提交结果时复核 lease/fence；发送前取消、预算或本地策略封口把 durable intent 置为 `terminal/not_sent`；已知未送达的 transport failure 与远端结果不明的 `ambiguous` 分开，后者永久保持 ambiguous；因 tracer 的 action 都是只读查询，允许在有界重试内新发一次 ProviderCall（计入预算），不实现对账（requirements 2.7）。
  - 将 HTTP 400 `INVALID_REQUEST`、HTTP 500 `RESULT_VALIDATION_FAILED`、间歇性 `result: null` 分类到不同的 retry policy；`RESULT_VALIDATION_FAILED` 有界重试，重试耗尽后由业务层决定 `invalid_link`，不得在首次响应时断言账号不存在。
  - 成功解析后，locator 与账号 ID 必须在同一条 captured terminal payload 的同一短事务中成对写入；不得跨调用拼接。
  - **Offline acceptance:** request intent 未提交时 network send=0；prepared 后取消得到 `terminal/not_sent` 且 send=0；终态 ODS write/integrity failure 时 decoder/projector=0；expected/actual action mismatch 同时保留两值并进入 `invalid_response`；完整响应、known non-delivery transport error、timeout/process-loss ambiguous 都满足 v2 字段/nullability/payload 矩阵；ambiguous 后最多再发一次新 ProviderCall，原调用不被改写，业务事实不重复；resume 不重复已完成的付费 effect；stale worker 不能提交可变状态；fake clock 推进一年清理后长期业务事实仍存在；locator/account ID 跨调用拼接的负例被拒绝。

- [ ] 4. 打通抖音账号 tracer 纵向切片
  - **Requirements:** R3, R4, R5, R7, R8, R9, R10, R11, R14, R18, R19
  - 实现抖音 Home locator 策略、入口类型识别与最多三次尝试；非主页入口、平台错配和三次失败终态都不得产生 account/identifier/assignment/snapshot/discovery/checkpoint。
  - 通过 captured `media_user_info` 创建/复用 namespaced ExternalAccount 标识，并在同一账号记录、同一短事务中成对写入当前入口与当前归属，投影 finalized profile snapshot 和抖音头像/背景 media references；若 locator 阶段已产生同一 captured profile payload 必须复用。
  - 覆盖已有其他 MediaStaff 当前归属的情况：保留原归属、root 进入 blocked conflict、submitted staff 不成为 owner，默认不再发后续付费调用。
  - 通过 captured `user_video_list` 处理完整 20 entries，按账号粒度创建/复用 ContentSnapshot 与 ContentDiscovery，保留 target 与 returned author 两份事实；按规则推断 `content_kind`；列表播放数记 `unsupported`；封面选第 2 条候选。
  - 对 `HITACHI2023` 只记录 returned-author content fact，不创建账号/归属，也不单凭差异创建质量问题。
  - 在全页投影完成后按 `time` / `id_window` / `empty` 规则建立 integer cursor checkpoint；用 fence 防止旧 run 回退 current/checkpoint。
  - 计算首次录入结果：正常、`invalid_link` 或 `suspected_empty`；后两者之外写归属行 `intake_status`；`suspected_empty` 另写 `data_quality_issues`，实际监控 = 开关打开且 `intake_status='normal'`，不关开关、不改账号状态。
  - 一专员一平台一账号（D-69）：专员在抖音已占用名额时，提交另一个抖音账号进入阻塞终态 `staff_platform_slot_taken`，不建归属、不继续付费。
  - **Offline acceptance:** 一次命令得到 target `HITACHI1`、1 个当前归属、1 个 finalized profile、20/20 processed entries、20 个预期账号级 discovery、无 `HITACHI2023` ExternalAccount、integer checkpoint、正确的 `content_kind` 与 `unsupported` 播放数、第 2 条封面引用、可查询的 entry outcome；ProviderCall 数符合任务 1 锁定策略，duplicate/resume 无重复业务事实；assignment-conflict fixture 保持旧 owner 且不会继续付费；疑似空账号 fixture 产生 issue、`intake_status='suspected_empty'`、不进入常规采集，账号 status 不变；同专员同平台第二个账号被阻塞且无新归属。

- [ ] 5. 打通小红书多命名空间身份纵向切片
  - **Requirements:** R3, R4, R5, R6, R7, R8, R9, R10, R14, R18, R19
  - 实现小红书 Home locator 的平台校验、入口类型识别、最多三次解析和成功证据复用；覆盖平台错配、非主页入口与三次失败，三者都不得创建 account/identifier/assignment/snapshot/discovery/checkpoint。
  - 投影 profile ID `49328995493` 到 v2 `xiaohongshu.profile.user_id` namespace，不把它与列表作者 ID 做字符串或昵称猜测。
  - 在完整第一页上统计 exact non-empty author IDs；唯一主导作者 `5decba2300000000010007e1` 只有通过 versioned policy 后，才以 `dominant_list_author` evidence 绑定到同一 ExternalAccount 的 `xiaohongshu.content.user_id` namespace。
  - 成功绑定使用 v2 `dominant-list-author-evidence.v1`，将 policy version、accepted reason、candidate、exact counts、总 entries、非空 denominator、RFC 8785 JCS evidence SHA-256 与长期 batch 引用写入同一 `external_account_identifiers` 行；后续 replay 不覆盖首次绑定证据。
  - 对 tie、empty、唯一但低占比或其他 policy rejection fail closed，不创建猜测 identifier；使用同一 evidence schema 将 rejected reason、policy version、counts、denominator 和长期 batch 引用写入 `data_quality_issues`；minority authors 只进内容事实。
  - 覆盖既有 Assignment 冲突，与抖音执行同一不抢占/默认停止付费语义。
  - 小红书主页响应不返回头像与背景，不生成 avatar/background 引用；小红书列表的 `cover` 是单个字符串（实测 21/21，576 宽 WebP），直接作为封面引用；`images[*]` 是详情图，不当封面。
  - 处理已返回 21 entries，即使 `initial_content_limit <= 20`；建立 string cursor checkpoint，并计算 entry outcome（含 `suspected_empty` 路径）。
  - **Offline acceptance:** 一个 ExternalAccount 同时拥有两个不同 namespace 的预期 ID、21/21 entries 被投影、没有 minority-author account、cursor 保持 string、无 avatar/background 引用、封面取单值 `cover`；TypeScript 实现对 v2 evidence 固定向量的 exact JCS bytes 产生文档指定的 SHA-256，覆盖 key 输入顺序、exact identifier、integer、candidate null 与 absent/unknown-field rejection，且成功 evidence 的 shape、列值和计数总和均可验证；tie/empty/唯一低占比 fixture 均无绑定且 rejected evidence/problem 可见；平台错配、非主页入口、三次失败和 assignment conflict 均无错误 owner 或后续付费副作用；fake clock 推进超过一年并清理 task/call/raw 后，成功 identifier 仍能仅凭长期 evidence 与 batch 解释 policy、candidate、exact counts、denominator 和 accepted reason。

- [ ] 6. 完成跨平台完整页、按账号内容与 typed checkpoint 契约
  - **Requirements:** R8, R9, R10, R11, R14, R18
  - 抽取 `ContentListProjector` 和 `CheckpointModule` 的平台无关 Interface；停止判断只能发生在完整页提交之后。
  - 明确 content identity、按账号粒度的 immutable snapshot、target-list Discovery、returned author 和 assignment context 的 grain；不同账号的同一 content 各保留一份 snapshot/discovery；同一 batch+账号的重复 entry 全部处理但只生成一个 discovery，重复位置/count 进入 page/call evidence 和质量摘要。
  - 实施同批次合并：后到有效值（含真实 0）覆盖；后到 `missing/explicit_null/invalid/unsupported` 不擦除已有有效值；`content_kind` 按 `video/image/text/unknown` 输出，不输出 `mixed`。
  - 将 v2 长期 checkpoint 限定为 account/provider/action/scope、typed `cursor_envelope`、anchor/high-watermark、batch、continuity、version 和 updated time；按 `time` / `id_window` / `empty` 建立初始锚点；`has_more`、page/processed count、ProviderCall 与 Adapter version 留在一年期 task/call lineage，不另建平行 checkpoint。
  - 覆盖 empty-success（0 条 + `has_more=false` → `empty` 锚点）、entry projection failure、duplicate entry、same content across accounts、null/empty/long cursor、旧批次迟到和 cancellation。
  - **Offline acceptance:** contract checks 证明 returned count 等于 required processed count 后才推进；同一列表重复 content ID 不丢 entry 处理证据也不违反 discovery 唯一键；同一 content 在两个账号各有一份 snapshot/discovery；21-entry page 不被 local limit 截断；integer/string round-trip 不互转；三种 anchor mode 均可重建；任一 entry 失败或 stale fence 时 checkpoint version 不前进。

- [ ] 7. 打通正式媒资归档与独立进度
  - **Requirements:** R8, R12, R15, R16, R18
  - 从 profile/content snapshot 产生 avatar、background、cover 的 versioned MediaReference；抖音生成 avatar/background，小红书不生成；封面数组选第 2 条（抖音），单值 `cover` 直接用（小红书）；临时 URL 只作 source locator。
  - 实现 `MediaArchiveModule`：idempotent demand、bounded fake/real download seam、私有临时对象、完整 bytes SHA-256、size/type verification、formal MediaAsset dedupe 和 verified binding。
  - 生成标准化衍生图（JPEG q80、540 宽）作为独立资产，计算独立 SHA-256；原始字节与衍生图都保留，互不替代。抖音封面是 HEVC 编码的 HEIC：解码走 Python 能力服务的 ffmpeg（ADR-0012，D-57 修订）；小红书 WebP 用 sharp。离线测试用 fake 能力服务，另加一条带真实 HEIC 样本的 Python 侧单测。
  - 实施 scheme/host/redirect/size/content-type/timeout/SSRF guard；网络期间不持有数据库事务，签名 URL 不进长期事实；重试必须重新获取有效地址。
  - Root/status 分开显示 structured checkpoint 与 media pending/archived/carried_forward/retryable/terminal warning；media failure 不回滚结构化结果；续用旧资产标 `carried_forward`，不表示本轮成功。
  - **Offline acceptance:** fake OSS 下相同 bytes 去重、不同 bytes 不按 URL 合并；过期 URL/超限/截断/失败都保留 snapshot 和 warning；衍生图有独立 SHA-256 且原图仍在；小红书无 avatar/background 引用；默认测试无网络媒体请求。

- [ ] 8. 补齐同步/异步、租约、重试、取消与恢复
  - **Requirements:** R2, R13, R14, R15, R18
  - 对 verified synchronous action 实现单次 captured terminal result；对 verified asynchronous profile 实现 captured submission + persisted task ID + each-poll ProviderCall + bounded terminal handling；`user_video_list` 异步按 raw4/raw5/raw8 结论保持 disabled。
  - 将 provider auth（400）、provider input/inaccessible（500）、间歇性 `RESULT_VALIDATION_FAILED`、quota/rate、transport、ODS、parse/schema、identity、assignment、projection、media、stale fence 分类到稳定 reason/retry policy；技术失败绝不映射为空 profile/list，也不改账号状态；`in_flight` 失联进入 ambiguous 且无 reconcile 证据时不自动重发。
  - 实现 stage lease heartbeat、monotonic fence、retry wait、deadline、cancel 和 crash resume；同账号同动作复用活动任务；已完成付费 effect 不重复，结果不明的远端 effect 不盲重试，迟到 worker 不回退 current/checkpoint。
  - 为 call/page/poll/media 设置硬上限和 cost counters；超限在下一次调用前停止。同步或异步生产 tuple 都必须达到 `smoke_verified + production approved`，不能由 fixture evidence 启用。
  - **Offline acceptance:** fake async pending→success、pending→provider failure、timeout、rate limit、crash-before-send、crash-after-send-before-terminal-capture、crash-after-project、cancel-during-poll、lease takeover 全部可重复运行；crash-after-send-before-terminal-capture 的调用保持 ambiguous，最多再发一次新调用，全程无重复业务事实或 stale publication；`RESULT_VALIDATION_FAILED` 在有界重试内可恢复，重试耗尽才进入业务 `invalid_link`。

- [ ] 9. 建立人工批准、预算受限的真实 smoke
  - **Requirements:** R2, R13, R14, R17
  - 提供独立于默认 tests/CI 的 smoke 入口；启动前强制 human approval、显式 runtime switch、locator/action/mode allowlist、secret provider、固定 call/cost budget 和 deadline。
  - 首轮只验证最小 `media_user_info`/`user_video_list` tuple；同时实测异步 profile 的 terminal schema、TTL 与合适的轮询间隔，写回 capability 证据；异步 profile 必须作为独立 smoke，不因同步成功而启用；异步列表保持 disabled。
  - 每个真实 submit/poll/retry 仍走 RawCaptureGateway、ProviderCall、cost guard 和 redacted audit；达到预算或 deadline 时在下一次调用前停止。
  - 使用 A v1.10 §6.2 点数表估算成本（抖音主页 10、列表 10/页；小红书主页 15、列表 15/页），单价 0.02 元/点（1 元 = 50 点，2026-11-04）；QPS 仍未知。
  - 输出 audit summary：实际 tuple、calls、polls、latency、bytes、estimated points、result category、schema/Adapter version 和 evidence refs，不含 secret/full payload。
  - 将实测结果更新为对应 capability 的 evidence；认证 header（raw4 为 `X-Api-Key`）、QPS、task TTL 或 schema 差异继续显式记录，不能自动外推；单价已确认 0.02 元/点。
  - **Manual acceptance:** 审批记录、预算预览、停止行为、raw-before-parse evidence 和审计摘要均由操作人确认；没有批准时命令必须在任何网络调用前失败。

## 实施前必须关闭的文档冲突（2026-11-04 已关闭）

requirements §1.2 的第 1～6 项已于 2026-11-04 在 v2 修订；实现以 v2 修订稿为准。下表保留为追溯，不再是阻塞项：

| # | 冲突 | v2 修订位置（2026-11-04） | 影响的 tracer 能力 |
|---|---|---|---|
| 1 | 归属仍是 v2 独立表 + 时间区间 | v2 §8.3：账号一行当前归属，去掉区间；新增 `platform_id` | 账号当前归属的持久化 |
| 2 | 内容快照按 `(batch, content)` 共享；发现已按 assignment 区分，但快照不按账号 | v2 §10.1：`contents` 增加 `account_id`；§10.2 快照键不变 | 按账号保存的 content snapshot |
| 3 | 值状态缺 `unsupported` | v2 §5.2：增加 `unsupported` | 列表播放数 |
| 4 | `content_kind` 含 `mixed` | v2 §10.1：去掉 `mixed` | `content_kind` 投影 |
| 5 | 无录入状态载体 | v2 §8.3：归属行增加 `intake_status` | `suspected_empty` 的名单级表达 |
| 6 | 无封面衍生图 role/lineage | v2 §11.3：增加 `*_normalized` 角色 | 标准化衍生图 |

## Final implementation acceptance

完成全部任务仍不自动代表 Feature 可发布。发布评审必须逐条回看 [`requirements.md`](requirements.md) 的 R1–R19，并提供：

1. 默认离线 suite 的网络禁用证明与 fixture 结果；
2. 抖音 20 条、小红书 21 条、异作者/主导作者、typed cursor、三种 anchor mode、`content_kind` 与 `unsupported` 的实际断言；
3. ODS-before-decode 故障注入、assignment conflict、resume 和 stale-fence 结果；
4. entry outcome 与 quality issue 的可查询证据，以及“技术失败不改账号状态”的负例；
5. 按账号内容 grain、封面第 2 条与标准化衍生图的验收结果；
6. structured/media 独立状态与本地 status 无供应商调用的证据；
7. 若启用任何生产 capability，对应批准式 smoke、固定预算和审计摘要；
8. 所有仍开放决定的显式清单，确保未被实现默认值静默冻结。