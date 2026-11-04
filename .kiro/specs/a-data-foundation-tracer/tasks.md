# A Data Foundation Tracer Implementation Plan

> **状态**：`current`（2026-11-04 实现完成，已合并 main）  
> **执行状态**：任务 1–9 的**实现范围**已完成（9/9）；任务 9 的**真实 smoke 已执行完毕**（2026-11-04，抖音同步 / 小红书同步 / 抖音异步共 4 次运行、7 次调用，1 次连接超时、其余成功）；capability 仍全部 `activation=disabled`  
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
- [x] 7. 打通正式媒资归档与独立进度
  - **Requirements:** R8, R12, R15, R16, R18
  - 从 profile/content snapshot 产生 avatar、background、cover 的 versioned MediaReference；抖音生成 avatar/background，小红书不生成；封面数组选第 2 条（抖音），单值 `cover` 直接用（小红书）；临时 URL 只作 source locator。
  - 实现 `MediaArchiveModule`：idempotent demand、bounded fake/real download seam、私有临时对象、完整 bytes SHA-256、size/type verification、formal MediaAsset dedupe 和 verified binding。
  - 生成标准化衍生图（JPEG q80、540 宽）作为独立资产，计算独立 SHA-256；原始字节与衍生图都保留，互不替代。抖音封面是 HEVC 编码的 HEIC：解码走 Python 能力服务的 ffmpeg（ADR-0012，D-57 修订）；小红书 WebP 用 sharp。离线测试用 fake 能力服务，另加一条带真实 HEIC 样本的 Python 侧单测。
  - 实施 scheme/host/redirect/size/content-type/timeout/SSRF guard；网络期间不持有数据库事务，签名 URL 不进长期事实；重试必须重新获取有效地址。
  - Root/status 分开显示 structured checkpoint 与 media pending/archived/carried_forward/retryable/terminal warning；media failure 不回滚结构化结果；续用旧资产标 `carried_forward`，不表示本轮成功。
  - **Offline acceptance:** fake OSS 下相同 bytes 去重、不同 bytes 不按 URL 合并；过期 URL/超限/截断/失败都保留 snapshot 和 warning；衍生图有独立 SHA-256 且原图仍在；小红书无 avatar/background 引用；默认测试无网络媒体请求。

  - **完成记录（2026-11-04）：** `./scripts/verify.sh` 通过（unit 18 个文件 231 条；db 11 个文件 208 条，其中媒资归档 19 条；Python 侧 `services/capability` pytest 7 条，用真实 HEIC 样本，本机已验证；**CI 不验 Python 侧**，见下）。对 12 处关键逻辑做了变异检查（资产按 SHA 去重、同次运行重试上限、轮次上限、续用旧资产、失败重试范围、衍生图复用、转换结果类型校验、白名单、重定向逐跳校验、截断检测、过期状态码），1 个幸存的是等价变异；转换结果类型校验最初幸存，补了「转换服务返回非 JPEG」用例后被杀。Python 侧另做 2 处变异（qscale、目标宽度），均被杀。
  - **Requirements → 覆盖测试**：

    | Requirement | 任务 7 覆盖的部分 | 测试 |
    |---|---|---|
    | R8.5 / R12.1 | 头像 / 背景 / 封面引用在任务 4–5 已按版本化快照创建（`pending`）；归档把它们推进为 `archived`，临时 URL 只留在 `source_locator` | `archive.db.test.ts` |
    | R12.2 | 抖音 22 个引用（头像 + 背景 + 20 封面）；小红书只有 21 个封面，没有 avatar / background（含衍生角色） | 同上 |
    | R12.3 | 封面引用的是第 2 条候选（任务 4 已断言），归档下载的就是该地址 | 同上 |
    | R12.4 | 完整字节的 SHA-256 判同：20 个封面 URL 各异、字节相同 → 1 份资产；不同字节 → 不同资产；新批次 URL 变了、字节没变 → 不产生新资产；对象 key 内容寻址（`media/<sha[0:2]>/<sha>`），不含任何主机 / 查询串；读回校验 | 同上 |
    | R12.5 | 标准化衍生图（JPEG、540×960）是独立资产、独立 SHA-256，原图仍在，两者互不替代；用 `*_normalized` 角色的引用指向衍生资产；转换按唯一原图做一次，已有衍生图则复用 | 同上 |
    | R12.5（真实 HEIC） | 真实抖音封面（HEVC 编码的 HEIC）经 ffmpeg 转为 540 宽 JPEG（估算质量 ≈ 79）；更宽的输入等比缩到 540；乱码 / 空 / 截断输入是 `ConversionError`，不是空图 | `services/capability/tests/test_image.py` |
    | R12.6 | 结构化先完成，根状态 `structured_succeeded_media_pending`；归档不下载、不改写已终态的主页 / 内容快照与检查点；归档后 `succeeded` | 同上 |
    | R12.8 | 过期 URL（403 / 404 / 410）→ `failed / source_expired`，不用同一个 URL 重试，下一轮也不重试；可重试错误（超时 / 重置 / 5xx / 429 / 截断）同次运行内最多 2 次、最多 3 轮，之后 `rounds_exhausted` 不再请求；超限 / 非图片 / 被守卫拒绝 → 终态，不重试；下载失败且上一快照有已验证资产 → `carried_forward`（原图与衍生图都续用，保留本轮失败码，不算本轮归档成功） | 同上 |
    | R12.9 / R16.2 | 全程 fake 媒资 transport / fake 转换器 / fake OSS；未登记 URL 立即失败；网络拒绝挂具仍然生效 | 同上 |
    | R15.2 / R15.3 | status 的媒资进度分开显示 `pending / archived / carriedForward / failed`，失败再分 `retryable / needsFreshUrl / terminal`；`succeeded_with_warnings` 在存在失败或续用时出现 | 同上、`status.db.test.ts` |
    | R18.1 / R18.2 / R18.5 | 每个引用一个短事务，先按 `download_media` 子任务 fencing 校验；被取代的 worker 不创建资产、不改引用；下载 / 转换期间数据库没有打开的事务（`information_schema.innodb_trx` 断言） | 同上 |
    | design §12.3 | URL 守卫：只允许 http(s)，白名单为 fixture 里出现的 CDN（`douyinpic.com`、`rednotecdn.com`），拒绝 IP 字面量 / localhost / 内网名 / 凭据 / 非默认端口；重定向最多 3 跳、逐跳重新校验；20 MB 上限；按字节嗅探类型（HTML 错误页即使 200 也拒绝） | `media-archive.unit.test.ts` |

  - **任务 7 未覆盖、已转交后续任务的验收项：** 真实 HTTP 下载 transport、Python 能力服务的 HTTP 外壳与 Node 客户端、真实 OSS（媒资桶）实现 → 与任务 9 之后的部署一起；真实媒资 URL 有效期（ENV8）和真实下载 → 需要批准的 smoke；`download_media` 的 worker 调度与取消协作 → 任务 8。
  - **实现留下的取舍（供复核）：** ① **没有引入 sharp**：ADR-0005 登记了它，但你批准的依赖清单里没有；衍生图的所有格式（含 WebP / JPEG）都走 `ImageConverter` 端口，由 Python 能力服务的 ffmpeg 承担。需要 sharp 的话请告诉我。② Python 侧只实现了转换**函数**与单测，没有 FastAPI 外壳（没有可测的部分，不写没人验证的代码）；`pyproject.toml` 的运行时依赖为空，开发依赖只有 pytest。③ ffmpeg 的 mjpeg 只有整数 qscale，「q80」取 qscale 6（实测约 q79，qscale 5 约 q82），单测允许 77–83。④ 衍生图**总是**缩放到 540 宽（含比 540 小的图），与「标准化」一致。⑤ **没有「私有临时对象」暂存**：下载上限 20 MB，整份在内存里校验；对象 key 内容寻址，重复写是幂等的，所以不需要先落临时再搬运。媒资桶没有 orphan sweeper（ODS sweeper 只扫 `ods/`）：对象写成功而数据库事务失败时会留下一个以 SHA 命名的孤儿，下次同字节会复用它。⑥ 每轮一个 `download_media` 子任务（idempotency key 含轮次），最多 3 轮；重试不重开终态任务。子任务总是 `succeeded`，媒资失败只是警告。⑦ 衍生引用在**归档时**才创建（`pending` 阶段只有原始引用），所以归档前 `media.total` 是 22，归档后是 44。⑧ 失败码分三类（见 `media-failure`）：`retryable` / `needs_fresh_url` / `terminal`；DB 的 `archive_status` 仍只有 v2 的四个值，类别由 `last_error_code` 推出；**未登记的失败码按 terminal 统计**，不假定可重试。⑨ 续用只在**下载失败**时发生；转换失败不续用（原图本轮已拿到）。⑩ `verify.sh` 新增第 9 步 Python 单测：需要 pytest（`services/capability/.venv`）与 ffmpeg ≥ 7.1，不满足时打印 `SKIPPED（Python 侧未验证）` 且最终一行写「Python 侧未验证」；**CI 的 ubuntu 自带 ffmpeg 6.x，所以 CI 不验 Python 侧**（dev-ci-cadence 已有「CI 绿 ≠ Python 侧验过」的提醒）。要让 CI 验，需要在 workflow 里装静态 ffmpeg ≥ 7.1，这会引入一个新的下载源，我没有擅自加。
- [x] 8. 补齐同步/异步、租约、重试、取消与恢复
  - **Requirements:** R2, R13, R14, R15, R18
  - 对 verified synchronous action 实现单次 captured terminal result；对 verified asynchronous profile 实现 captured submission + persisted task ID + each-poll ProviderCall + bounded terminal handling；`user_video_list` 异步按 raw4/raw5/raw8 结论保持 disabled。
  - 将 provider auth（400）、provider input/inaccessible（500）、间歇性 `RESULT_VALIDATION_FAILED`、quota/rate、transport、ODS、parse/schema、identity、assignment、projection、media、stale fence 分类到稳定 reason/retry policy；技术失败绝不映射为空 profile/list，也不改账号状态；`in_flight` 失联进入 ambiguous 且无 reconcile 证据时不自动重发。
  - 实现 stage lease heartbeat、monotonic fence、retry wait、deadline、cancel 和 crash resume；同账号同动作复用活动任务；已完成付费 effect 不重复，结果不明的远端 effect 不盲重试，迟到 worker 不回退 current/checkpoint。
  - 为 call/page/poll/media 设置硬上限和 cost counters；超限在下一次调用前停止。同步或异步生产 tuple 都必须达到 `smoke_verified + production approved`，不能由 fixture evidence 启用。
  - **Offline acceptance:** fake async pending→success、pending→provider failure、timeout、rate limit、crash-before-send、crash-after-send-before-terminal-capture、crash-after-project、cancel-during-poll、lease takeover 全部可重复运行；crash-after-send-before-terminal-capture 的调用保持 ambiguous，最多再发一次新调用，全程无重复业务事实或 stale publication；`RESULT_VALIDATION_FAILED` 在有界重试内可恢复，重试耗尽才进入业务 `invalid_link`。

  - **完成记录（2026-11-04）：** `./scripts/verify.sh` 通过（unit 19 个文件 233 条；db 12 个文件 234 条，其中本任务 26 条；Python 侧 7 条）。对 13 处关键逻辑做了变异检查（心跳、指数退避、ambiguous 重发上限、接手时恢复失联调用、已知未送达的传输失败重试、运行期 capability 门、异步任务 ID 配对、总截止时间、调用预算、轮询上限、任务 ID 路径安全、`retry_wait` 未到点不领取、轮询被限流继续）。第一轮有 3 个幸存：`retry_wait` 未到点不领取与「轮询被限流继续」补用例后被杀；心跳返回值检查是等价变异——网关发送前的 fencing 校验会同样把调用封口为 `not_sent`，保留它是为了在创建 intent 之前就停下。
  - **Requirements → 覆盖测试**（只列任务 8 新增或补强的部分）：

    | Requirement | 任务 8 覆盖的部分 | 测试 |
    |---|---|---|
    | R13.2 | 同步主页 / 列表仍是单次 captured 终态结果，无多余轮询（任务 4–5 的主路径） | `tracer-flow.douyin/xiaohongshu.db.test.ts` |
    | R13.3 | 异步主页：提交 1 次（HTTP 202）+ 每次轮询一条独立 ProviderCall（`task_lookup`，`call_sequence` 递增，GET `/openapi/v1/tasks/{id}`）；供应商任务 ID 落在提交调用的 `provider_task_id`；账号来自轮询终态 payload，locator 来自提交调用，二者靠任务 ID 精确相等配对（不一致 → `pairing_mismatch`，无业务身份）；任务 ID 含路径字符时不拼进 URL | `tracer-flow.resilience.db.test.ts` |
    | R13.4 / R13.5 / R13.7 | 异步列表在运行期同样 fail closed（不发任何调用）；production 环境没有已批准 tuple，运行期再过一次 capability 门，不发任何调用；`async` 取自配置，不写死 | 同上 |
    | R13.9 / R14.3 | 异步任务以 `RESULT_VALIDATION_FAILED` 失败与同步 HTTP 500 同义：重新提交的有界重试（3 次），耗尽后才 `invalid_link`；其他任务失败不重试，`provider_task_failed` 稳定分类 | 同上 |
    | R14.1 / R14.3 | 限流（429）、5xx、已知未送达的传输失败：进入 `retry_wait`（释放租约、记录下一次尝试时间），退避 5s、10s，未到点再运行不领取、不换 fencing token、不产生新调用；到点后从第一个没有调用的尝试继续；三次耗尽后失败；列表阶段限流只补列表，不重新调主页；轮询被限流不算失败 | 同上 |
    | R14.2 / R14.7 | 技术失败（含轮询超时、预算封口、截止时间）不产生空主页 / 空列表，无业务身份，不改账号状态 | 同上 |
    | R14.5 / R2.7 | crash-before-send：接手后只发送一次；crash-after-send-before-terminal-capture：原调用 `ambiguous` 且不被改写，最多再发一次新调用（新 attempt），业务事实只有一份；重发后又 ambiguous → `provider_outcome_unknown`，不再盲重发；crash-after-project：重新运行得到 `already_terminal`，事实与调用数不变 | 同上 |
    | R14.6 | 轮询期间取消：不再轮询，返回 `cancelled`，无业务身份 | 同上 |
    | R15.2 / R15.3 | `retry_wait` 状态与 `failure.retryable`；`provider_timeout`、`policy`、`deadline`、`provider_outcome_unknown` 等稳定类别 | 同上 |
    | R17.3（上限部分） | 预算：`maxCalls`、`maxPolls`、`maxPoints`（抖音 10+10、小红书 15+15，失败 / 429 / 轮询不计点）在**下一次调用前**封口（`not_sent`），主页事实保留；点数表与单价单测 | 同上、`cost-guard.test.ts` |
    | R18.1 / R18.2 / R18.3 | 租约 + 单调 fencing：接手使旧 token 失效（w1=1、w2=2）；停滞的 worker1 醒来后的投影被拒绝，事实只有一份，worker2 复用 worker1 已捕获的主页证据；心跳续租：轮询等待比租约长时，另一个 worker 始终得到 `busy`；总截止时间超过则不再发任何调用 | 同上 |

  - **任务 8 未覆盖、已转交后续任务的验收项：** 真实 worker 入口 / 任务领取循环（`SKIP LOCKED`、死信）与 CLI `run`：需要真实 OSS 与真实 transport，不在默认环境 → 部署阶段；`download_media` 子任务的取消协作；异步任务的供应商 TTL 与合适轮询间隔 → 任务 9 smoke。
  - **实现留下的取舍（供复核）：** ① 退避是确定性的指数（无抖动）：重放时可重新算出同一个等待时间；`ponytail` 上限：多个 worker 同时限流时会同步重试，升级路径是按调用 ID 加确定性抖动。② 校验类失败（含异步任务校验失败、`result:null`）**立即**重试，不退避；限流 / 5xx / 已知未送达才退避。③ 同一个逻辑请求的 `attempt_no` 在校验重试、限流重试、ambiguous 重发之间共享，总数上限 3；所以「ambiguous 重发一次」也消耗这 3 次里的一次。④ ambiguous 的判定不依赖超时阈值：持有 root 租约的 worker 接手时，把该 root 家族里停在 `in_flight` 的调用一律标 `ambiguous`（旧 worker 的 fencing token 已失效，它之后写不进终态）。⑤ 异步轮询里某次轮询失联（ambiguous / 传输失败）不重发，下一次轮询就是新调用（GET 幂等）；总等待用「间隔 × 次数」估算，不读时钟。⑥ 异步提交 202 也计一次点数（`outcome=succeeded` 的 `media_user_info`），轮询不计；供应商对异步提交是否计费未知，按保守估计。⑦ 默认值：退避 5s 起、封顶 300s；轮询间隔 2s、最多 30 次、最长 120s；总截止 24h——全部是配置（`TracerConfig`），**不是产品合同**，任务 9 smoke 后再定。⑧ 预算策略 `createBudgetPolicy` 由调用方装进网关，编排器本身不内置默认上限；任务 9 的 smoke 入口会强制装配。⑨ 重试耗尽后失败的 root 没有自动「重新提交」入口（需要新的幂等 key 或到期后重提），属于运维动作。
- [x] 9. 建立人工批准、预算受限的真实 smoke（本轮只实现入口与门槛，未发任何真实调用）
  - **Requirements:** R2, R13, R14, R17
  - 提供独立于默认 tests/CI 的 smoke 入口；启动前强制 human approval、显式 runtime switch、locator/action/mode allowlist、secret provider、固定 call/cost budget 和 deadline。
  - 首轮只验证最小 `media_user_info`/`user_video_list` tuple；同时实测异步 profile 的 terminal schema、TTL 与合适的轮询间隔，写回 capability 证据；异步 profile 必须作为独立 smoke，不因同步成功而启用；异步列表保持 disabled。
  - 每个真实 submit/poll/retry 仍走 RawCaptureGateway、ProviderCall、cost guard 和 redacted audit；达到预算或 deadline 时在下一次调用前停止。
  - 使用 A v1.10 §6.2 点数表估算成本（抖音主页 10、列表 10/页；小红书主页 15、列表 15/页），单价 0.02 元/点（1 元 = 50 点，2026-11-04）；QPS 仍未知。
  - 输出 audit summary：实际 tuple、calls、polls、latency、bytes、estimated points、result category、schema/Adapter version 和 evidence refs，不含 secret/full payload。
  - 将实测结果更新为对应 capability 的 evidence；认证 header（raw4 为 `X-Api-Key`）、QPS、task TTL 或 schema 差异继续显式记录，不能自动外推；单价已确认 0.02 元/点。
  - **Manual acceptance:** 审批记录、预算预览、停止行为、raw-before-parse evidence 和审计摘要均由操作人确认；没有批准时命令必须在任何网络调用前失败。

  - **完成记录（2026-11-04）：** 本轮范围按约定只做 smoke **入口、审批开关、allowlist、预算与停止逻辑**，**没有发任何真实 AI Master 调用，没有读取任何 secret**。`./scripts/verify.sh` 通过（unit 21 个文件 253 条；db 13 个文件 250 条；Python 7 条）。对 11 处关键逻辑做了变异检查（开关、审批过期、审批有效期上限、审批绑定计划摘要、已知失败 tuple、预算放不下、出站请求核对、deadline、轮询上限、异步条目才允许轮询、未接线时停止），全部被杀。
  - **覆盖测试：**

    | 要求 | 覆盖 | 测试 |
    |---|---|---|
    | R17.1 排除在默认测试 / CI 之外；需要人工批准与显式运行时开关 | 入口是独立的 `pnpm smoke`（不在 `pnpm test` / verify 的执行路径里）；开关 `HBECHO_SMOKE=approved-paid-calls`（`1` / `true` 不行）；审批记录必须有批准人、原因、有效期（≤ 24 小时、未过期、未来时间不行），且**绑定到计划的 JCS SHA-256**——改任何一处（locator、预算、allowlist、deadline）审批作废 | `preflight.test.ts`、`smoke-cli.test.ts` |
    | R17.2 allowlist + 固定预算 + secret 在源码之外 | allowlist 只允许有实测证据且无已知供应商失败的 tuple（异步列表被拒）、不允许重复；预算 `max_calls / max_polls / max_points` 与 `deadline_ms` 必须有限且在硬上限内，且放得下名义用量；secret 通过 `secrets.apiKey()` 注入，**只在全部门槛通过之后才读取**，只交给 transport 工厂 | 同上、`smoke.db.test.ts` |
    | R17.2 / M1 没有批准 → 任何网络调用之前失败 | 6 类拒绝（开关、无审批、审批过期、计划不符、异步列表、预算不足）：transport 0 次（含 `rejected` 0 次）、secret 读取 0 次、transport 工厂 0 次、批次 / ProviderCall / ODS 对象 / 日志 0 行；CLI 在开关缺失时连审批文件都不读，`execute` 永远不被调用 | 同上 |
    | R17.3 / M1 上限在下一次调用前停止 | deadline 超过后下一条在发送前被封口（`terminal/not_sent`，transport 只有 1 次）；`max_polls` 到达后第 3 次轮询在发送前封口（`stoppedBy=poll_budget`）；调用 / 点数上限由 `createBudgetPolicy` 在每次调用前检查（任务 8） | `smoke.db.test.ts` |
    | design §16.3 / 每个调用仍走 RawCaptureGateway | smoke 的每个 submit / poll 都经网关：请求字节先落 ODS → prepared → in_flight → 响应字节落 ODS → 才解码；响应不是合法信封时先落 ODS 再报告 `decoded=false`；**不写任何业务事实**（账号 / 归属 / 快照 / 内容 / 检查点均为 0 行）；`AllowlistTransport` 在出站前再核对一次路径、`async`、`url`，即使执行器有缺陷也不会向 allowlist 之外发请求 | 同上 |
    | R17.4 / M2 审计摘要 | `SmokeSummary`：实际 tuple、调用数、轮询数、延迟、字节数、估算点数与金额（0.02 元/点）、结果类别、Adapter 版本、证据引用（ProviderCall ID + 响应字节 SHA-256 前缀）、`stoppedBy`；**不含 secret、完整载荷、locator 原文**（只有 SHA-256 前缀），ODS 证据字节里也没有 secret | 同上 |
    | R17.5 不自动启用 capability | smoke 不写任何 capability；成功只在摘要里列出实际 exercise 的 tuple，capability 表仍全部 production `disabled`，更新证据需要人工 | 设计约束，无自动路径 |
    | R17.6 点数表与单价 | 抖音 10 / 10、小红书 15 / 15、异步提交计点、轮询与失败不计点、0.02 元/点；预览显示逐项与合计金额 | `preflight.test.ts`、`cost-guard.test.ts` |

  - **真实 smoke 需要你批准的内容（建议首轮，均为最小 tuple，不自动重试）：**
    1. **同步轮（抖音）**：`douyin / media_user_info / synchronous` ×1 + `douyin / user_video_list / synchronous` ×1，locator 用 raw3 的 `HITACHI1` 分享文本；调用数上限 2、轮询 0、**预算 20 点（0.4 元）**，deadline 120 秒。
    2. **同步轮（小红书）**（可选）：`xiaohongshu / media_user_info / synchronous` ×1 + `xiaohongshu / user_video_list / synchronous` ×1，日立中央空调分享文本；调用数上限 2、**预算 30 点（0.6 元）**。
    3. **异步主页独立一轮**（单独批准，不因同步成功而启用）：`douyin / media_user_info / asynchronous` ×1 提交 + 最多 5 次轮询；调用数上限 1、`max_polls=5`、**预算 10 点（0.2 元）**，轮询间隔 2 秒，deadline 120 秒。用来实测终态 schema、任务 TTL 与合适轮询间隔（任务 8 的默认值全部待此定）。
    4. 异步列表保持 disabled，不 smoke。
    5. 审批记录由你签发（`approved_by`、`reason`、`expires_at` ≤ 24 小时），并绑定计划摘要：先 `pnpm smoke preview --plan plan.json` 取得 `plan_sha256`。
    6. 合计首轮最多约 **60 点 ≈ 1.2 元**。QPS 仍未知，并发为 1。
  - **接线缺口（执行前必须先做，需要你批准的依赖 / 工作）：** ① 真实 `ProviderTransport`（HTTP + `X-Api-Key` 认证头注入）；② 真实私有 ODS 的 `ObjectStore`（`ali-oss`，ADR-0005 已登记但**未批准安装**）；③ secret provider（从环境 / 密钥库读取，不进仓库）。三者没有接线之前，`pnpm smoke run` 通过门槛后以**退出码 5**（`executor_not_wired`）停止，不会发出任何调用——这是刻意的。
  - **接线完成记录（2026-11-04，决策人 liuxuekui：本机 smoke 先用 `hbecho-setup` 的 AccessKey，覆盖运维手册 §8.4/§8.5 原先「OSS 不含任何 AccessKey」的绝对写法）：** ① 真实 `ProviderTransport`（`src/modules/raw-capture/http-transport.ts`：注入 `X-Api-Key`；4xx/5xx 是已捕获响应，不是传输失败；连接类错误 `delivered=no`、超时与中断 `delivered=unknown`）；② 真实私有 ODS 的 `ObjectStore`（`src/modules/raw-capture/oss-store.ts`，`ali-oss` 6.23.0 + `@types/ali-oss`，ADR-0005 已登记；错误信息只留错误码）；③ secret provider（`src/modules/smoke/secrets.ts`：只读环境变量，缺失即失败，消息只含变量名）；④ 装配在 `src/worker/smoke-wiring.ts`，**只在 preflight 通过后**才打开连接池、构造 SDK；⑤ `.env` 由 Node `loadEnvFile` 载入（不引 dotenv）；⑥ smoke 的 ODS 对象键统一加 `smoke/` 前缀（`GatewayDeps.keyPrefix`，键原样写入 `oss_objects.object_key`）。已验证：`pnpm smoke preview` 通过（20 点 / 0.4 元）；真实 OSS 只读自检通过（`hbecho-ods` 当前 0 对象）；本机 `verify.sh` 通过。**仍未发出任何真实 AI Master 调用。** 真实 smoke 还缺 `HBECHO_DATABASE_URL`（用哪个库未定）与审批签发。
  - **本机 smoke 数据库（2026-11-04，liuxuekui 定）：** 用本机专用持久库 `hbecho_smoke`，容器 `hbecho-smoke-mysql`（`127.0.0.1:3307`，MySQL 8.4）；迁移已跑通（27 张表含 `__drizzle_migrations`、4 个平台、1 个供应商、1 个触发器、UTC）。容器用 `--skip-log-bin` 启动：binlog 开启时非 SUPER 用户无法执行迁移里的 `CREATE TRIGGER`，而应用账号不应拿 SUPER。重建命令见运维手册 §8.5。
  - **首轮真实 smoke 结果（2026-11-04，liuxuekui 签发；抖音同步 2 次调用 / 预算 20 点）：**
    - `douyin / media_user_info / synchronous`：`transport_failed` → `ambiguous`。ODS 里的 transport_error 为 `{"kind":"timeout","delivered":"unknown","message":"供应商请求失败（timeout/UND_ERR_CONNECT_TIMEOUT）"}`——undici 的 10 秒连接超时。同期 `curl` 实测 connect 约 50 ms、TLS < 1 s，属一次偶发，不是链路整体不可达。**请求字节已落 ODS，但没有响应证据；供应商是否已处理未知**（smoke 不自动重试）。
    - `douyin / user_video_list / synchronous`：HTTP 200、187,726 字节、20 条；`result` 的键（`result / has_more / cursor / max_cursor`）与首条字段与 raw3 样本一致；`provider_task_id` 存在。计 10 点。
    - 合计 2 次调用、估算 10 点（约 0.2 元），预算未用尽。证据：ProviderCall 1/2、ODS 对象 4 个（`smoke/ods/20261104/...`）。**未写任何业务事实**（账号 / 归属 / 快照 / 内容 / 检查点）。
    - 由本轮暴露并修复的缺陷：`UND_ERR_CONNECT_TIMEOUT` 原先被归为 `delivered=unknown`，把「请求确定没发出、可安全重试」误判成 ambiguous；已改为 `delivered=no` 并补用例。
    - 观察：`async=false` 的 `user_video_list` 响应仍是**任务信封**（`data.task_id / status / result`），与 raw3 样本一致——同步模式不是裸结果，解码器按信封处理才是对的。
  - **后续三轮真实 smoke（2026-11-04，liuxuekui 授权「抖音和小红书直接跑，不再逐轮签发」）：**
    - `douyin / media_user_info / synchronous`（补跑）：HTTP 200、1,025 字节、解码成功、6.8 s，10 点。
    - `xiaohongshu / media_user_info / synchronous` + `user_video_list / synchronous`：均 HTTP 200、解码成功（7.16 s / 6.50 s），合计 40,341 字节，30 点。
    - `douyin / media_user_info / asynchronous`：提交 HTTP **202**（2.30 s）+ 1 次轮询（0.16 s）即 `succeeded`，10 点（轮询不计点）。
    - 本批合计 5 次调用、1 次轮询、估算 50 点（1.0 元）。证据：ProviderCall 3–7，ODS 对象共 14 个。**业务表仍全为 0**（账号 / 归属 / 快照 / 内容 / 发现 / 检查点）。
    - **异步实测结论：** ① 终态 schema 与同步一致（`data.result` 含 `user_id / nickname / signature / location / avatar / cover / follower_count / following_count / like_count / post_count`）；② 任务约 2–3 秒完成，2 秒轮询间隔在首次轮询即命中终态；③ **响应里的 `created_at / updated_at` 是 +08:00 本地时间且不带偏移**（`2026-11-04T22:58:53`，对应 UTC 14:58:53）——解析时不能当 UTC；④ 响应里**没有 TTL 字段**，任务保留时长仍未知，不能外推。轮询默认值（2 s / 最多 30 次 / 最长 120 s）本轮未被证伪，保留。
    - capability 登记表本来就把这些 tuple 标为 `smoke_verified`，本轮只是补了 2026-11-04 的实跑证据；`activation` 仍全部 `disabled`，**没有自动升级为 `approved`**。
  - **实现留下的取舍（供复核）：** ① 开关值是一个不会被随手设成 `1` 的字符串。② 审批绑定计划摘要，所以「批准之后改 locator / 预算」不可能；审批有效期最长 24 小时。③ smoke 创建的批次 / 任务只用于挂 ProviderCall 与成本累计（`subject_type='smoke'`），结束后标记 `succeeded` 以便一年清理回收；预算是**全局**的（所有条目挂在同一个 smoke 根任务下）。④ smoke **不重试**（包括校验失败与 429）：失败如实进摘要，由操作人决定；ambiguous 同样不重发。⑤ smoke 里 locator 原样发送（不做最小清洗），因为 allowlist 按原文核对；`AllowlistTransport` 对轮询只检查路径形态与「计划里存在异步条目」，任务 ID 的归属由执行器保证。⑥ CLI 的 `preview` 不需要审批与开关：它只校验计划和算预算，没有副作用。⑦ 「将实测结果更新为对应 capability 的 evidence」没有自动化：真实 smoke 之后由人把摘要里的证据引用写回 `capability.ts` / manifest，并记录认证头、QPS、TTL、schema 差异——避免自动外推。

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