# A Data Foundation Tracer Implementation Plan

> **状态**：`draft`  
> **执行状态**：任务 1–6 已完成（6/9）；任务 7 未开始  
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

- [x] 2. 建立 tracer 命令、幂等根任务与本地状态纵向骨架
  - **Requirements:** R1, R15, R18
  - 实现 `AccountTracerCommandModule` 和 `TracerStatusQuery`，入口为 CLI `pnpm tracer submit|status|cancel`（design §14），不做 HTTP。
  - 建立 Drizzle schema 与迁移（本任务首次建表）：v2 中 tracer 用到的表；验证 drizzle-kit 能否生成 CHECK、复合外键、生成列唯一键与受限写入过程，不支持的部分写手写 SQL 迁移，并把结论回填 ADR-0005「已知坑」第 7 行（R6-06）。
  - 准备测试种子：品牌、大区、分公司、板块、经销商、门店、`MediaStaff` 各若干行（复用 `seed/分公司-大区对照.csv`），只用于离线测试与测试机一次性库。
  - 在任何网络行为前执行 service-principal Capability、目标 scope、capability gate、canonical payload 和 idempotency 校验；同账号同动作已有活动任务时复用。
  - 将 canonical command 固定映射为 root SyncTask：platform、`subject_type='media_staff'`、staff subject ID、原始 locator，以及通过两字段 `data-foundation-tracer-task-parameters.v1` persistence-projection schema 校验的 effective limit；再组装独立五字段 `data-foundation-tracer-command.v1` aggregate，摘要严格按 v2 §5.5 的 RFC 8785 JCS UTF-8 bytes 计算，不做 Unicode normalization，并锁定 command 跨实现 digest vector。
  - 建立 root/stage 状态、logical-effect key、cancel、lease/fencing 和 audit-safe event；一年窗口内相同 key+payload 返回同一 root，不同 payload 返回 conflict，窗口外按新命令处理。
  - Status 从本地事实组装 structured/media/failure 进度与 entry outcome，执行 scope/redaction；查询路径不得调用 provider 或 media origin。为 secret、raw body、完整 ODS key、临时 URL、越权 account/assignment ID 建立逐字段 deny/redaction policy。
  - **Offline acceptance:** duplicate submission、key conflict、unauthorized/unsupported preflight、cancel、同账号同动作复用和 unknown/out-of-scope status 均有稳定结果；TypeScript 实现对 v2 §5.5 两个固定向量的 exact JCS bytes 产生文档指定的 SHA-256，覆盖 Unicode、转义、key 输入顺序、BIGINT decimal string、integer 与 absent/null/unknown-field rejection；redaction fixture 证明上述敏感字段不出现在 body/log；fake clock 证明一年内返回原 root、到期后旧 status 不再承诺且复用 key 创建新 root 仍不重复长期业务事实；对 status query 断言 ProviderTransport 调用次数为 0。

  - **完成记录（2026-11-04）：** `./scripts/verify.sh` 通过（Node 24.22.2；类型检查；unit 13 个文件 173 条；迁移与 schema 一致；MySQL 8.4.11 上 db 4 个文件 76 条；密钥、链接、登记）。另对 5 处关键逻辑做了变异检查（到期边界、fencing 递增、范围检查、活动状态集合、唯一键竞争重试），每个变异都被测试杀掉。
  - **Drizzle 约束验证结论**（详见 ADR-0005「已知坑 7 的验证结论」）：CHECK（94 条）、复合与循环外键、STORED 生成列唯一键（D-69、D-70）、`ON DELETE SET NULL`、带 `collate` 的自定义列类型都能由 drizzle-kit 生成且被 MySQL 强制；触发器、种子数据不支持，用 `generate --custom` 手写；受限写入过程（存储过程）**未实现**，fencing 与 finalized-only current 由 `src/modules` 的仓储事务保证。
  - **Requirements → 覆盖测试**（只列任务 2 实际覆盖的部分）：

    | Requirement | 任务 2 覆盖的部分 | 测试 |
    |---|---|---|
    | R1.1 | 提交返回十进制字符串 root_task_id；一个 manual 批次 + 一个根 `resolve_account` 任务；原始 locator 逐码点保留；两字段 task_parameters；canonical command 摘要 = JCS(五字段) 的 SHA-256；staff ID > 2^53 不丢精度；limit 缺省取冻结的 sync_settings、显式 1–20 覆盖 | `commands.db.test.ts`（A1 组） |
    | R1.2 / R1.3 | 同 actor+key+payload 返回原 root 且无新增事实或调用；同 key 不同 payload（locator / limit / staff / platform）→ `idempotency_conflict`；key 按 actor 隔离 | `commands.db.test.ts`（A2/A3 组） |
    | R1.4 / R1.5 | 缺 Capability → `forbidden`；平台或专员越权 → `out_of_scope`；快手、视频号、production 环境、异步列表 → `unsupported_capability`；均在任何写入与供应商调用之前拒绝 | `commands.db.test.ts`（A4 组） |
    | R1.6 | 接受 / 去重 / 复用 / 拒绝各一条审计事件；事件不含 locator 原文与幂等 key 原文 | `commands.db.test.ts`（R1.6 组） |
    | R1.7 | 一年窗口内返回原 root；恰好到期（`expires_at <= now`）即过期，同 key 视为新命令，旧 root 的 key 被释放；长期业务表不动 | `commands.db.test.ts`（A10 组） |
    | R1.8 / R18.6 | 不同 key、相同 canonical command 在活动状态（pending/leased/running/retry_wait）期间复用；终态后才新建；两个相同提交并发到达只产生一个 root | `commands.db.test.ts`（A5 组 + 并发用例） |
    | R1.9（部分） | 取消使 root 与子任务进入 `cancelled`、fencing token 递增、租约清空；重复取消与取消终态是 no-op | `commands.db.test.ts`（取消组）；「prepared 的 ProviderCall 关闭为 `terminal/not_sent`」在任务 3 |
    | R15.1 | 状态查询只执行 SELECT；依赖里没有 ProviderTransport；测试期间任何被拒网络尝试都会使用例失败 | `status.db.test.ts`（A7） |
    | R15.2 / R15.3 | root 状态、阶段状态与尝试次数、目标账号与归属、返回/投影条数、检查点与游标类型、媒资汇总、质量问题、稳定失败原因；`accepted / in_progress / retry_wait / structured_succeeded_media_pending / succeeded / succeeded_with_warnings / blocked_* / failed / cancelled` 彼此可区分 | `status.db.test.ts`（A8 组） |
    | R15.4 | 原始 body、认证头、完整 ODS key、临时 URL、locator、供应商错误详情、账号状态原因都不出现在输出；未授权的 owner ID 不出现 | `status.db.test.ts`（脱敏组、归属冲突用例） |
    | R15.5 | 未知、越权、非 root → `not_found`（不可探测存在性）；一年后 → `expired`；过期后不从长期事实反推旧状态 | `status.db.test.ts`（A9 组） |
    | R15.6（数据面） | 账号级与批次级结果可从本地事实组装；页面形态（M3）不属于本 spec | `status.db.test.ts` |
    | R18.1–R18.3（部分） | 表级支撑：`lease_owner/expires` CHECK、`fencing_token` 非负且取消时递增、`idempotency_key` 唯一；陈旧 worker 被 fence 拒绝的行为在任务 3/8 | `schema.db.test.ts`、`commands.db.test.ts` |
    | R18.5 | 提交与取消只有几条短事务，没有网络 IO | 代码结构；任务 3 起由 ProviderCall 流程测试断言 |
    | v2 §5.5 向量 1、2 | exact JCS bytes 与 SHA-256 与文档一致；key 输入顺序、Unicode 不归一化、转义、BIGINT 十进制 string、整数、absent/null/unknown-field 拒绝；evidence 由 21 条小红书 fixture 经主导作者决定生成，摘要等于向量 2 | `canonical-json/jcs.test.ts`、`identity/evidence.test.ts` |
    | CLI（design §14） | `submit / status / cancel`，JSON 输出，退出码 0/2/3/4/1；未知参数与子命令；意外错误不泄露堆栈；真实进程入口冒烟 | `src/worker/cli.db.test.ts` |
    | v2 基线（表、约束） | 26 张表、无 ENUM、无 CASCADE、94 条 CHECK、循环 current 指针、D-69/D-70 唯一键、ProviderCall 状态矩阵、ODS/媒资用途隔离、BIGINT 与 UTC 往返、SET NULL 清理语义 | `src/db/schema.db.test.ts` |

  - **任务 2 未覆盖、已转交后续任务的验收项：** 「陈旧 worker 提交可变状态被拒」「prepared 取消得到 not_sent」归任务 3 / 8；「非主页入口（视频/笔记）」的拒绝与 `invalid_link` 终态由编排器在任务 4 落地（提交阶段不预判入口类型，避免两处各写一份）。
  - **实现留下的取舍（供复核）：** ① 审计是一个端口，默认实现写 pino 结构化日志，**没有新建审计表**（B 域审计流水尚不存在）；② Capability 沿用 B 域 PRD 的 `data.sync.trigger`，状态查询与取消也要求它，没有另造名称；③ 状态查询对「未知」与「越权」都返回 `not_found`，只有范围内的调用方才可能看到 `expired`；④ 活动任务复用以 canonical command 摘要为键，因此后到的 key 不会被记录到被复用的 root 上；⑤ 窗口到期后同 key 重提：旧 root 的 actor / key / 摘要三列被置空以释放唯一键，旧 root 本身保留到 ODS 清理；⑥ `sync_settings` 不由迁移种入（`list_safety_page_limit` 等 v2 未定，不静默冻结），未配置时提交返回 `sync_settings_missing`；⑦ 迁移种入四个平台与 `aimaster` 供应商（`base_endpoint` 取自 raw 证据中的主机名）；⑧ 新增 `idx_sync_tasks_canonical_command`（v2 未列，查询所需）；⑨ `stores.source_batch_id` 暂不挂 FK（`import_batches` 属于 a-master-data-import）；⑩ CLI 的 `HBECHO_ENV` 缺省为 `production`，而 production 没有任何已批准的 capability，所以忘记设置时命令会被拒绝（fail closed）；⑪ 三项 v2 文字与 MySQL 不一致（`reconciled_by` 的 SET NULL 与 CHECK、CHECK 不能引用自增列、`oss_objects` 唯一键超长）已按 ADR-0005 记录的方式处理，**v2 §9.5、§11.1 已于 2026-11-04 同步修订**（同次还给 `content_discoveries` 补了 `owner_*` 三列、给 `resolved_home_url` 补了说明，见 v2 文首修订 11–14）。

- [x] 3. 打通 raw-before-parse ProviderCall 纵向链路
  - **Requirements:** R2, R13, R14, R16, R18
  - 实现 `RawCaptureGateway` 与 `CapturedProviderResult` seam：发送前 request bytes + prepared ProviderCall intent 先进入私有 ODS/数据库；完整 response bytes 或 transfer error 也先落 ODS，再允许 versioned Adapter decode。
  - 每个 submit/poll/retry 使用独立 ProviderCall，分列记录 requested action、immutable expected response action 与 captured actual response action，并记录 `prepared/in_flight/terminal/ambiguous`、mode、attempt、timing、bytes、hash、safe metadata、root/task correlation 和 Adapter version；排除认证 header/secret。
  - 让 fake OSS 支持 request-intent failure、durable-write failure、hash mismatch、truncated body、in-flight process loss 和 terminal-capture failure；解析可从 captured ref 重放但不覆盖旧 lineage。
  - 实现一年保留期的 payload→call→task 清理闭包及 ODS orphan sweeper；证明不会删除长期 snapshot/assignment/discovery/checkpoint/media facts，且清理可幂等重跑。
  - 确保所有网络等待发生在数据库事务之外，提交结果时复核 lease/fence；发送前取消、预算或本地策略封口把 durable intent 置为 `terminal/not_sent`；已知未送达的 transport failure 与远端结果不明的 `ambiguous` 分开，后者永久保持 ambiguous；因 tracer 的 action 都是只读查询，允许在有界重试内新发一次 ProviderCall（计入预算），不实现对账（requirements 2.7）。
  - 将 HTTP 400 `INVALID_REQUEST`、HTTP 500 `RESULT_VALIDATION_FAILED`、间歇性 `result: null` 分类到不同的 retry policy；`RESULT_VALIDATION_FAILED` 有界重试，重试耗尽后由业务层决定 `invalid_link`，不得在首次响应时断言账号不存在。
  - 成功解析后，locator 与账号 ID 必须在同一条 captured terminal payload 的同一短事务中成对写入；不得跨调用拼接。
  - **Offline acceptance:** request intent 未提交时 network send=0；prepared 后取消得到 `terminal/not_sent` 且 send=0；终态 ODS write/integrity failure 时 decoder/projector=0；expected/actual action mismatch 同时保留两值并进入 `invalid_response`；完整响应、known non-delivery transport error、timeout/process-loss ambiguous 都满足 v2 字段/nullability/payload 矩阵；ambiguous 后最多再发一次新 ProviderCall，原调用不被改写，业务事实不重复；resume 不重复已完成的付费 effect；stale worker 不能提交可变状态；fake clock 推进一年清理后长期业务事实仍存在；locator/account ID 跨调用拼接的负例被拒绝。

  - **完成记录（2026-11-04）：** `./scripts/verify.sh` 通过（unit 15 个文件 192 条；db 6 个文件 117 条，其中本任务新增 41 条）。对 9 处关键逻辑做了变异检查，8 个被杀；幸存的 1 个（去掉 `put` 返回摘要的校验）是等价变异——其后的读回校验同样会拦住损坏与截断，属于有意的双重校验。
  - **Requirements → 覆盖测试**（只列任务 3 实际覆盖的部分）：

    | Requirement | 任务 3 覆盖的部分 | 测试 |
    |---|---|---|
    | R2.1 / R2.2 | 发送前请求字节已在私有 ODS 且读回校验、prepared→in_flight 已提交；每次提交/重试/续发都是独立 ProviderCall；requested / expected / actual action 分列 | `gateway.db.test.ts`（H1/H2 组、H5 组） |
    | R2.3 / R2.5 | 完整响应字节先落 ODS 并读回校验，才提交终态并允许解析；ODS 写失败 / 哈希不一致 / 截断 → decoder 与 projector 调用数为 0、调用进入 ambiguous 且无响应 payload；请求意图落地失败 → 发送次数 0、无调用行 | `gateway.db.test.ts` |
    | R2.4 | 传输失败先落结构化 artifact（含响应中断时的部分字节）再分类：已知未送达 → `terminal/transport_error`；超时/重置/未知异常 → `ambiguous`；artifact 写失败 → ambiguous 且不分类 | `gateway.db.test.ts`（H4 组） |
    | R2.6 | 解析后 payload 行记录首次解释的 Adapter 版本与状态；新版本重放得到新的 lineage（调用 ID、payload ID、SHA-256、版本），不改写 payload 行、不新增 ODS 对象；`loadCaptured` 重读 ODS 并校验，被篡改 → `integrity_mismatch` | `gateway.db.test.ts`（解释组） |
    | R2.7 | in_flight 失联 → 恢复扫描标 ambiguous（幂等）；之后允许一次新的 ProviderCall（attempt_no+1），原调用不被改写；第二次又 ambiguous 后拒绝；非只读 action、非 ambiguous 调用拒绝；不实现对账 | `gateway.db.test.ts`（H5/H6 组） |
    | R2.8 | 认证头、Cookie、Bearer、形似密钥的 token 不出现在 ODS、调用元数据与错误 artifact | `gateway.db.test.ts`（H8） |
    | R2.9 | manifest 声明 raw3/raw4 只是样本证据，不证明 raw-before-parse | `tests/harness/fixtures.test.ts`（任务 1） |
    | R2.10 | payload → call → task 清理；多 payload 调用按整体判断；只有 request payload 的调用按自身截止时间；非终态到期任务不删；reconcile 引用顺序；远端删除失败可重试；幂等重跑；长期快照/归属/发现/检查点/质量问题/正式媒资保留且来源引用被置空；orphan sweeper 只扫 `ods/` | `retention.db.test.ts` |
    | R3.7 | locator 与账号 ID 来自同一条 captured terminal payload：同调用配对成功，跨调用拼接、账号 ID 缺失/非法都被拒绝 | `gateway.db.test.ts`（配对组） |
    | R13.9 | HTTP 400 `INVALID_REQUEST`（不重试、不断言输入或认证）、HTTP 500 `RESULT_VALIDATION_FAILED`（有界重试，首次不断言账号不存在）、间歇性 `result:null`、429、其他 5xx、异步任务失败各自分类；重试耗尽才进入业务 `invalid_link`（衔接任务 1 的 `afterProfileAttempt`） | `failure.test.ts`、`peek.test.ts`、`gateway.db.test.ts` |
    | R14.1–R14.3（响应层） | 传输、授权、限流、schema/解析、供应商校验失败的稳定类别；技术失败不会变成空主页或空列表（decode 为 `schema_drift` / 调用为 ambiguous） | `failure.test.ts`、`gateway.db.test.ts` |
    | R14.6 | 发送前取消 / fence 被取代 / 本地策略（预算）封口 → `terminal/not_sent`，发送次数 0，只有 request payload | `gateway.db.test.ts`（A6 组） |
    | R16.5（部分） | ODS-before-parse 顺序、恢复、陈旧 fencing、非主页之外的故障注入 | 同上 |
    | R18.1 / R18.2 | 租约有效 + fencing token 一致才能创建 intent 或切 in_flight；陈旧或过期 → `StaleFenceError` / not_sent；发送后被取代 → 证据仍落地但 `fenceValid=false`，project 不执行 | `gateway.db.test.ts` |
    | R18.3 | 两个 worker 重放同一 logical effect：唯一键 + 条件更新保证只发送一次，另一个得到 `in_progress` 或已捕获的结果 | `gateway.db.test.ts`（J4） |
    | R18.5 | 网络 IO 期间没有打开的数据库事务（用事务计数代理断言） | `gateway.db.test.ts`（J2） |

  - **任务 3 未覆盖、已转交后续任务的验收项：** 真实 OSS（`ali-oss`）的 `ObjectStore` 实现与桶权限验证（ENV4，批准的 smoke 之后）；异步提交与每次轮询（GET `/tasks/{id}`）的 ProviderCall 编排与 deadline 在任务 8；预算 / 调用上限的计数器在任务 8（本任务只提供 `SendPolicy` 封口接口）；`ambiguous` 的对账不实现（只读查询例外）。
  - **实现留下的取舍（供复核）：** ① 响应字节落 ODS 并校验**之后**，用 `peekResponseMeta` 提取 `response_action / provider_code / provider_task_id / provider_request_id / provider_task_status` 写入调用元数据——这是元数据提取，不是业务解释；② 陈旧 worker 在发送之后到达的终态证据**照常记录**（不可变观察，R18.4），只是结果标 `fenceValid=false`，由调用方决定不投影；这比「陈旧就拒绝写证据」更安全，因为拒绝会把已经付费的调用丢成 ambiguous；③ 响应已收到但 ODS 写入或校验失败时，调用标 `ambiguous`（远端已执行，但没有可靠证据），不分类、不解析；④ `oss_objects` 里 `storage_class=Standard`、`encryption_mode=SSE-OSS`、`content_type=application/octet-stream` 是占位值，真实 OSS 适配器落地时按桶配置核对；⑤ ODS 对象键布局 `ods/<yyyymmdd>/<role>/<sha256>-<uuid>`（ASCII，含角色与摘要）；⑥ `task_lookup` 被列入只读 action 集合（任务 8 的轮询用）；⑦ 清理中，被未入选调用 reconcile 引用的调用本次保留（`blockedByReference`），下次运行再处理；⑧ 恢复扫描 `recoverInFlightCalls` 的阈值由调用方传入，未硬编码。

- [x] 4. 打通抖音账号 tracer 纵向切片
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

  - **完成记录（2026-11-04）：** `./scripts/verify.sh` 通过（Node 24.22.2；类型检查；unit 16 个文件 208 条；迁移一致；MySQL 8.4 上 db 7 个文件 144 条，其中编排器 24 条）。对 11 处关键逻辑做了变异检查：归属冲突判断、名额检查、可能置顶边界、整数游标转字符串、current 倒退、疑似空账号跳过列表、平台校验、归属快照、有界重试、fencing 校验。第一轮变异里「去掉 fencing 校验」幸存，说明测试只靠网关的 `fenceValid` 拦截，没有覆盖「响应已捕获、投影事务之前被取代」；已补 `beforeIntake / beforePageProjection` 钩子与三条用例，再变异即被杀掉。「重放时整页已投影」的门在当前流程里不可达（整页与 root 终态在同一个事务里），变异存活后按 YAGNI 删除。
  - **Requirements → 覆盖测试**（只列任务 4 实际覆盖的部分，全部是抖音）：

    | Requirement | 任务 4 覆盖的部分 | 测试 |
    |---|---|---|
    | R3.1 / R3.2 / R3.8 | 视频链接直接 `invalid_link`（调用 0）；平台错配（抖音命令 + 小红书链接 / 短链）拒绝，不静默切换；无法识别的主机不算错配；真实域名后缀判断 | `locator.test.ts`（`checkLocatorPlatform`）、`tracer-flow.douyin.db.test.ts` |
    | R3.4 / R3.7 / R3.9 / R3.10 | 清洗值写入 `resolved_home_url`、原文写入 `current_home_locator`；locator 与账号 ID 来自同一条 captured payload；崩溃后接手复用主页证据，调用数仍是 2；成功路径主页 1 + 列表 1，请求同步、游标整数 0 | `tracer-flow.douyin.db.test.ts` |
    | R4.1 / R4.2 / R4.4 | 三次 `RESULT_VALIDATION_FAILED`：三条独立 ProviderCall，终态 `invalid_link`，库里账号 / 标识 / 归属 / 快照 / 内容 / 发现 / 检查点 / 媒资引用全为 0；前两次失败第三次成功则继续；HTTP 400 不重试、不当作 `invalid_link` | 同上 |
    | R5.1 / R5.2 / R5.3 / R5.8 | 标识按 (命名空间, 原文) 查找并复核原文；`douyin.user_id=HITACHI1` 与同 payload 的 `douyin.sec_uid` 绑定到同一账号（`same_payload`）；再次提交不新增账号 / 标识 | 同上 |
    | R5.5 / R5.6 / R5.7 | 点赞等真实值、列表播放数 `unsupported`、转发 `unsupported`；时长只在有视频时读取；条目缺字段按条目容错（任务 1 的解码测试） | 同上、`decode-video-list.test.ts` |
    | R7.1 / R7.2 / R7.3 / R7.4 / R7.7 / R7.8 | 无冲突时账号与当前归属同一事务写入，入口成对；同一专员再次提交 no-op；已归属他人：原 owner 不变、提交者不是 owner、只调主页 1 次、记 `assignment_conflict`；同专员同平台第二个账号：`staff_platform_slot_taken`，无新账号 / 归属 | 同上 |
    | R7.6 | 发现的归属快照三列写入（专员 / 门店 / 品牌）；改绑后的不变性在任务 4 前置提交的 `schema.db.test.ts` | 同上、`schema.db.test.ts` |
    | R8.1–R8.7 | 每账号每批次一份 finalized 主页快照，绑定调用 / Adapter 版本；值状态保真；旧批次迟到不让 current 倒退；头像 / 背景引用 `pending` | 同上 |
    | R9.1–R9.3 / R9.6–R9.8 | 20/20 条全部处理；按被观察账号保存内容；第二次提交复用内容、新批次新快照；`content_kind` 推断；封面第 2 条，role=cover；同一页重复 post_id 的合并（任务 6 补完整用例） | 同上、`anchor.test.ts` |
    | R10.1 / R10.2 / R10.4 / R10.7 / R10.9 / R10.10 | 整页之后才建立检查点；整数游标原文 `1782701295000`；`time` 锚点 = 最大发布时间 + 同刻内容 ID；不请求第二页；已存在检查点时不改写；`id_window` / `empty` 的纯函数测试 | 同上、`anchor.test.ts` |
    | R11.1 / R11.2 / R11.4 | `HITACHI2023` 的条目保留在内容事实，返回作者在快照里；不建账号、不绑标识、不报质量问题 | 同上 |
    | R14.2 / R14.7 | 技术失败（400 等）不产生空主页 / 空列表，账号状态不变 | 同上 |
    | R18.1 / R18.2 / R18.5 | 领取使 fencing token 递增；投影事务先锁定 root（列表阶段还有子任务）并校验租约，被取代 / 已取消的 worker 什么都不写；整页回滚；租约未到期时另一个 worker 得到 `busy` | 同上 |
    | R19.1 / R19.2 / R19.3 / R19.7 / R19.8 | `normal` / `suspected_empty` 写入归属行 `intake_status`；疑似空账号写 `suspected_empty_account`，监控开关不关、账号状态不变、不发列表、无检查点；只有粉丝 0（作品不为 0）不算 | 同上 |
    | R15（status 部分） | 结构化成功 + 媒资待办、cursor 类型、录入结果、目标账号与 owner、冲突状态；运行前后查询不增加 transport 调用 | 同上 |

  - **任务 4 未覆盖、已转交后续任务的验收项：** 同批次内重复 post_id、同内容跨账号各一份、`id_window` / `empty` 的入库、空 / null 游标 + `has_more=true` 的质量问题、整页内单条投影失败 → 任务 6；异步主页、心跳、重试退避、崩溃恢复策略（`ambiguous` 的有界重发已由网关支持，编排层的接手策略在任务 8；当前编排器把 `ambiguous` / `in_progress` / 传输错误一律映射为稳定失败码，不盲重发）→ 任务 8；媒资归档 → 任务 7；小红书 → 任务 5。
  - **实现留下的取舍（供复核）：** ① 列表条目新增解码 `publish_location / tag_text / share_url / related_search_terms / video.duration`，主页新增 `location`：这些是快照列，ODS 一年后消失，不解码就永久丢失；时长只在有视频素材时读取（没有视频的条目 `video.duration` 是 0 占位，记 `missing`，不当作真实 0 秒），单位记 `seconds`；`Adapter` 版本号未升（尚无已落库的解释）。② 抖音 `douyin.sec_uid` 以 `same_payload` 绑定：只取目标账号自己条目里的 `sec_uid`，唯一才绑，多个不同值记 `identity_conflict`；异作者的 `sec_uid` 不绑。③ 归属冲突时**不写**主页快照：快照要挂在账号当前归属上，而那是别人的归属；证据留在 ODS、标识观察时间更新、记 `assignment_conflict` 问题，root 的 `account_id` 指向目标账号以便 status 显示 owner。④ 名额已满时**不创建账号**（避免留下无人归属的孤儿账号），只记 `staff_platform_slot_taken` 问题；问题的 `assignment_id` 指向占用名额的那条归属。⑤ 疑似空账号**不发列表调用**、不建检查点（「不进入常规采集」按首次采集也不进入解读）；已有 `suspected_empty` 归属的账号重新提交同样停在主页。⑥ `has_more` 为真也只建立基线，`stop_reason='first_page_baseline'`。⑦ 检查点只建立、不推进：已存在则不改写，`result_summary.checkpoint='exists'`；内容 ID 集合用平台内容 ID 原文；`version` 从 1 起；`cursor_sha256` 是游标信封 JCS 的 SHA-256。⑧ 平台错配只能在发送前按入口主机名判断（响应里没有 platform 字段），已记入 capability `knownGaps: response_platform_unobservable`；错配的录入结果记为 `invalid_link`，错误码 `platform_mismatch`。⑨ `invalid_link` 的 root 终态是 `failed` + `stop_reason='invalid_link'`；`blocked_*` 状态是 `failed` + `stop_reason`。⑩ 内容快照直接以 `finalized` 插入（单列表任务、无详情依赖），`merge_policy_version='list-merge.v1'`；封面只存被选中的第 2 条引用，`source_json_path` 指向它在响应里的原始下标，其余候选保留在 ODS（一年）。⑪ 子任务 `fetch_content_list` 的 `task_parameters` 是 `data-foundation-tracer-list-task.v1`（v2 只定义了 root 的 schema，此处是实现补充）。⑫ 编排器的异步配置（任一 action 为 `asynchronous`）直接以 `execution_mode_unavailable` 失败，不悄悄走同步。⑬ 本任务没有给 CLI 增加 `run`：真实 OSS 与真实 transport 都不在默认环境里，worker 入口随任务 8 一起落地。

- [x] 5. 打通小红书多命名空间身份纵向切片
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

  - **完成记录（2026-11-04）：** `./scripts/verify.sh` 通过（unit 16 个文件 208 条；db 8 个文件 167 条，其中小红书切片 23 条）。对 6 处关键逻辑做了变异检查：主导作者拒绝后仍绑定、写入前的批次一致性校验、重放覆盖首次 evidence、告警缺失、只看前 20 条算作者分布，5 个被杀；幸存 1 个是等价变异（`p.batchId + 0n`）。
  - **Requirements → 覆盖测试**（只列任务 5 新增的部分；与抖音相同的入口 / 归属 / 投影语义由同一条流程承担，在 `tracer-flow.xiaohongshu.db.test.ts` 里对小红书再断言一遍）：

    | Requirement | 任务 5 覆盖的部分 | 测试 |
    |---|---|---|
    | R3.1 / R3.2 / R3.8 | 小红书命令 + 抖音链接：平台错配，调用 0；笔记链接（`explore` / `discovery/item`）：非主页入口，调用 0；三次 `RESULT_VALIDATION_FAILED`：`invalid_link`，三条独立调用；三者都无任何业务身份 | `tracer-flow.xiaohongshu.db.test.ts` |
    | R5.2 / R5.4 | profile ID `49328995493` 在 `xiaohongshu.profile.user_id`（`same_payload`），主导作者 `5decba2300000000010007e1` 在 `xiaohongshu.content.user_id`（`dominant_list_author`），两者绑定到同一个账号，没有任何字符串 / 昵称猜测 | 同上 |
    | R6.1 / R6.3 / R6.4 | 21/21 同一作者通过；20 条同一作者 + 1 条少数作者仍通过（20/21），少数作者只进内容快照，不建账号、不绑标识 | 同上 |
    | R6.2 / R6.5 / R6.6 | tie、全部为空、唯一但低于 80%、样本不足：不绑定、不创建猜测标识；rejected evidence（策略版本、精确计数、分母、原因、长期批次）写入 `data_quality_issues.detail`，同一份 closed schema；问题可按账号 / 批次 / 来源调用查询；根任务带 `dominant_author_rejected` 警告；内容与检查点照常投影 | 同上 |
    | R6.5（长期可解释） | fake clock 推进 366 天并清理 task / call / raw 后：成功绑定的标识行里 evidence、策略版本、批次引用、JCS 摘要仍完整可验证；拒绝决定的问题行 detail 仍是完整 rejected evidence，来源调用引用被置空 | 同上 |
    | v2 §8.2 受限身份写入 | 写入前校验：closed schema 的形状 / 计数 / 排序 / 候选一致、必须 accepted、批次与参数一致；method / policy / evidence / 摘要 / 批次全部由 evidence 推出；重放只更新观察时间，不覆盖首次证据；已绑定到另一账号则不改绑 | 同上 |
    | v2 §5.5 向量 2 | 任务 2 已用 21 条 fixture 的决定生成 evidence 并对上文档摘要；任务 5 复核成功行里存的摘要等于重新计算的 JCS 摘要 | `identity/evidence.test.ts`、同上 |
    | R7.3 / R7.4 / R7.8 | 账号已归属他人：原 owner 不变、只调主页 1 次、没有内容 / 检查点 / 内容作者标识；同专员在小红书已占名额：无新账号 / 归属 / 标识 | 同上 |
    | R9.2 / R9.8 / R9.11 | `initial_content_limit=5` 时仍处理 21/21 条，且没有多请求；封面取单值 `cover`（21 条，role=cover，下标路径 `…result[i].cover`）；主页无头像 / 背景引用 | 同上 |
    | R10.4 / R10.9 | 游标保持字符串 `6a5098aa000000001603fb07`（`cursor_sha256` = 信封的 JCS 摘要）；请求首页游标是整数 0 | 同上 |
    | R19.2 / R19.7 | 小红书疑似空账号：问题、`intake_status`、不发列表、无检查点 | 同上 |

  - **任务 5 未覆盖、已转交后续任务的验收项：** 同批次重复内容、空 / null 游标、`id_window` / `empty` 入库 → 任务 6；小红书封面 WebP 的下载与衍生图 → 任务 7；异步与恢复策略 → 任务 8。
  - **实现留下的取舍（供复核）：** ① 拒绝决定的问题码是 `dominant_author_rejected`（design 只列了「至少覆盖」的五个码，这是新增的）；`discriminator` = 策略版本 + 拒绝原因，所以同一批次同一原因重放不重复。② 拒绝决定**不让 root 失败**：账号、主页快照、内容和检查点照常建立，root 为 `succeeded` 并带 `dominant_author_rejected` 警告；因为 R6.2 只要求「不猜测绑定并创建质量问题」。③ 主导作者绑定的 `confidence` 记 `observed`（不是 `verified`），后续人工裁决可升级。④ 抖音与小红书共用同一条流程，平台差异只在 `PlatformStrategy.listBindings`（抖音：`sec_uid`；小红书：主导作者）；`DEFAULT_STRATEGIES` 现在包含小红书。⑤ 小红书列表条目还有 `red_id`（小红书号），不在 D-25 的命名空间枚举里，没有处理。
- [x] 6. 完成跨平台完整页、按账号内容与 typed checkpoint 契约
  - **Requirements:** R8, R9, R10, R11, R14, R18
  - 抽取 `ContentListProjector` 和 `CheckpointModule` 的平台无关 Interface；停止判断只能发生在完整页提交之后。
  - 明确 content identity、按账号粒度的 immutable snapshot、target-list Discovery、returned author 和 assignment context 的 grain；不同账号的同一 content 各保留一份 snapshot/discovery；同一 batch+账号的重复 entry 全部处理但只生成一个 discovery，重复位置/count 进入 page/call evidence 和质量摘要。
  - 实施同批次合并：后到有效值（含真实 0）覆盖；后到 `missing/explicit_null/invalid/unsupported` 不擦除已有有效值；`content_kind` 按 `video/image/text/unknown` 输出，不输出 `mixed`。
  - 将 v2 长期 checkpoint 限定为 account/provider/action/scope、typed `cursor_envelope`、anchor/high-watermark、batch、continuity、version 和 updated time；按 `time` / `id_window` / `empty` 建立初始锚点；`has_more`、page/processed count、ProviderCall 与 Adapter version 留在一年期 task/call lineage，不另建平行 checkpoint。
  - 覆盖 empty-success（0 条 + `has_more=false` → `empty` 锚点）、entry projection failure、duplicate entry、same content across accounts、null/empty/long cursor、旧批次迟到和 cancellation。
  - **Offline acceptance:** contract checks 证明 returned count 等于 required processed count 后才推进；同一列表重复 content ID 不丢 entry 处理证据也不违反 discovery 唯一键；同一 content 在两个账号各有一份 snapshot/discovery；21-entry page 不被 local limit 截断；integer/string round-trip 不互转；三种 anchor mode 均可重建；任一 entry 失败或 stale fence 时 checkpoint version 不前进。

  - **完成记录（2026-11-04）：** `./scripts/verify.sh` 通过（unit 17 个文件 218 条；db 10 个文件 189 条，其中模块级 12 条、编排层页契约 11 条）。对 11 处关键逻辑做了变异检查（处理数校验、重复条目问题、游标异常问题及其 `has_more` 条件与空串条件、合并规则、`post_id` 上限、处理数统计、锚点回退、检查点不改写、投影异常处理），全部被杀。**诚实说明：** 任务 4 为了让抖音链路能跑通，已经把页投影、检查点与合并写成了平台无关的实现，所以任务 6 的大部分用例在补充实现之前就是绿的；真正红的是：超长 `post_id`、`processedEntries` 与页完整性校验、`ContentListProjector` / `CheckpointModule` 接口与注入、重复条目的质量摘要、`has_more=true` 配空 / null / 缺失游标的质量问题、投影异常 → `page_projection_failed`。
  - **Requirements → 覆盖测试**（只列任务 6 新增或补强的部分）：

    | Requirement | 任务 6 覆盖的部分 | 测试 |
    |---|---|---|
    | R9.3 | 同一作品出现在两个账号的列表：各一条内容、一份快照、一条发现，不跨账号合并（直接对 `projectContentPage` 断言） | `projection.db.test.ts` |
    | R9.4 | 同一 batch + 账号的重复条目：全部处理（`processedEntries` 含重复），一个内容 / 快照 / 发现，发现记首次位置；重复位置进入子任务 `result_summary.duplicate_entries` 与 `field_contract_anomaly` 质量问题 | `projection.db.test.ts`、`tracer-flow.page-contract.db.test.ts` |
    | R9.5 | 合并后落库：后到真实 0 覆盖先到的 5；后到 missing / null / invalid 不擦除已有有效值；先到的非有效态被后到的有效值替换；播放数恒 `unsupported` | `merge.test.ts`、`projection.db.test.ts` |
    | R9.6 | `content_kind` 后到的 `unknown` 不覆盖已推断的形态，不输出 `mixed` | `merge.test.ts` |
    | R9.9 | 0 条 + `has_more=false`：任务成功、`empty` 锚点、无内容 / 发现 / 引用 / 质量问题 | `tracer-flow.page-contract.db.test.ts` |
    | R9.1 / R9.2 / R9.11 | 25 条一页、limit=1：25 条全部处理，只请求一页；21 条页不截断（合并层） | 同上、`merge.test.ts` |
    | R10.1 / R10.5 | 检查点只在 `processedEntries === returnedEntries` 之后建立；整页投影在事务里失败（写完全部内容后注入失败）→ 整页回滚，无内容 / 发现 / 引用 / 检查点，主页事实保留，root 以 `projection / page_projection_failed` 失败；已处理数不足 → `page_incomplete`，无检查点 | 同上、`projection.db.test.ts`（整页原子） |
    | R10.2 / R10.3 | 长期检查点只有 v2 列（列集合断言）；`has_more` / 页数 / 处理条数只在一年期任务 lineage | `projection.db.test.ts` |
    | R10.4 | 整数游标超过 2^53 仍保持原文；字符串游标（含空串）、`{kind:null}`；缺失 / 非法游标不存；超长（8000 字符）游标往返不变；integer 与 string 不互转 | 同上 |
    | R10.6 | 已存在检查点不被改写（版本、游标、锚点不变）；较新批次先到、较旧批次后到时检查点与 current 都不倒退（任务 4 的编排用例） | 同上、`tracer-flow.douyin.db.test.ts` |
    | R10.7 | `time` / `id_window` / `empty` 三种锚点入库并可重建；无效发布时间（0、负数、超出 DATETIME、非 value）不参与取最大值 | 同上、`anchor.test.ts` |
    | R10.8 / R10.10 | 首屏不足 limit 且 `has_more=true`：不请求第二页，按首屏建立基线，不记连续性缺口 | `tracer-flow.page-contract.db.test.ts` |
    | R10.11 | `has_more=true` 配 null / 空串 / 缺失游标：质量问题（`cursor_missing_while_has_more`），按已处理页建立基线，不再请求；`has_more=false` 时空 / null 是正常结束 | 同上 |
    | R18.2 / R18.4 | 陈旧 fence 不写（任务 4 已覆盖）；整页事务与 root 终态原子，所以「检查点推进但页未完成」不可表达 | 同上 |

  - **任务 6 未覆盖、已转交后续任务的验收项：** 取消发生在整页事务进行中（事务是原子的，取消只会发生在其前后，前后两种在任务 4 已覆盖）；「条目内重复位置进入 ProviderCall evidence」只做到了子任务摘要与质量问题，ProviderCall 行本身不增加列。
  - **实现留下的取舍（供复核）：** ① 不可投影的条目（缺失 / 非法 / 超长 `post_id`）计入「已处理」并留一条 `field_contract_anomaly`，**不阻塞检查点**——否则一条坏数据会让这个账号永远无法建立基线；证据仍在 ODS（一年）。② 重复条目、不可投影条目、游标异常都用 `field_contract_anomaly`，靠 `detail.reason` 区分，没有新增问题码；根任务警告阶段名为 `list`（身份类问题为 `identity`）。③ 投影抛出的任何异常都映射成 `projection / page_projection_failed`，root 与子任务 `failed`，没有重试——重试策略在任务 8；基础设施类异常（断连）会被同样处理，任务 8 要区分。④ `ContentListProjector` / `CheckpointModule` 是接口 + 默认实现，编排器通过 `deps.projector` 注入（仅测试使用）；没有为 `CheckpointModule` 加注入点（暂无测试需要）。
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