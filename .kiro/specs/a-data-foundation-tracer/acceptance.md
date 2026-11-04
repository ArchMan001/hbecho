# A Data Foundation Tracer Acceptance

> **状态**：`draft`（任务 1–9 已实现并合并 main；离线验收结果见 acceptance.md，待确认后升 `current`）  
> **需求**：[`requirements.md`](requirements.md)  
> **设计**：[`design.md`](design.md)  
> **任务**：[`tasks.md`](tasks.md)  
> **所属域**：A 数据底座 · **目录命名**：`a-data-foundation-tracer`，符合 `<代号>-<切片>`  
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10（2026-11-04，定稿候选）  
> **最近核对**：2026-11-04（逐条验收，结果见下）  
> **更新日期**：2026-11-04

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在界面上看，写明谁看、看哪个页面、检查什么。
- `[环境]`：依赖已开通的云资源或真实供应商，不能离线验证；标明当前状态。
- 每条都对应 requirements 的编号。没有“看一眼就行”的条目。

## 验收结果（2026-11-04）

- **自动项 A–J 全部通过**。依据：本机 `./scripts/verify.sh` —— 类型检查、unit 272、db 251（含本次新增）、迁移一致、密钥扫描、文档链接与登记、Python 7；每条的覆盖测试见各表最后一列。
- **手工项**：M1、M2、M4 通过；M3、M5 的"页面"部分不适用（本 spec 没有界面），以命令/查询层替代，页面验收留给后续界面 spec。
- **环境项**：ENV1、ENV2（抖音）、ENV4、ENV7 已验证；ENV3 保持 disabled；ENV5、ENV6（业务确认）、ENV8 未验证。
- **验收中发现并已修复的缺口：**
  1. R19.4 / I3：媒资失败原先只体现在 `media_references` 与状态页上，没有写 `data_quality_issues`；现在写 `media_archive_failed`(含续用旧资产的本轮失败与衍生图失败)，按批次 / 账号可查，重放不重复。
  2. R5.2 / C2：哈希命中后复核原文的代码存在，但没有测试；已补 `identity/repository.db.test`。
  3. smoke 的任务 / 批次状态原先无论结果都写 `succeeded`；现在如实写 `failed` / `cancelled` / `partial_succeeded`。
- **已知缺口（不阻塞本 spec，已登记）：**
  - `continuity_gap` 问题码未实现：本 spec 只建首屏基线(E9 明确不算缺口，E11 记为 `field_contract_anomaly`)，对已有检查点的连续性判断属于 `a-full-sync`；R19.4 里"连续性缺口"一项因此在本 spec 内不产生。
  - 连接阶段超时 `UND_ERR_CONNECT_TIMEOUT → delivered=no` 依赖 undici 行为，没有真实 undici 的离线用例。
  - 成本守卫只给 `succeeded` 的调用计点：`ambiguous` 与 `delivered=no` 按 0 点计，`max_points` 不是对"可能已计费"的上界(硬上限是 `max_calls`)。
  - `sweepOrphans` 默认只扫 `ods/`，扫不到 `smoke/ods/` 下的孤儿对象(桶的 400 天兜底规则覆盖)。
  - capability 的 smoke 证据只写在 `tasks.md`，没有结构化 `evidenceRef`；异步任务 TTL 未知；非主页链接的供应商响应未观察。
  - 真实 smoke 的审批为委托授权(AI 按用户口头授权生成)，不是用户逐轮签发。
- **状态：** 保持 `draft`。升为 `current` 需要用户确认；同时注意上游 PRD A v1.10 与 `database-design-v2.md` 在 `INDEX.md` 里仍是 draft。

## 自动项

### A. 命令、幂等与状态骨架

| # | 需求 | 命令 / 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| A1 | R1.1 | 提交完整命令 | 返回一个十进制字符串 `root_task_id`，只持久化一条 canonical command | 通过 · commands.db「A1 提交」 |
| A2 | R1.2 | 同一 actor + key + payload 连提两次 | 返回同一 root；供应商调用数为 0 增量；无重复业务事实 | 通过 · commands.db「A2/A3 幂等」 |
| A3 | R1.3 | 同一 actor + key、不同 payload | 稳定 idempotency-conflict；不新建 root | 通过 · commands.db「A2/A3 幂等」(idempotency_conflict) |
| A4 | R1.4–1.5 | 无 scope / 未验证 platform×action×mode | 在任何网络调用前拒绝，ProviderCall 数为 0 | 通过 · commands.db「A4 预检」、strategy.test(异步列表被拒，transport=0) |
| A5 | R1.8 | 同账号同动作已有活动任务时再提交 | 复用原任务，不创建并发任务 | 通过 · commands.db「A5/R1.8」 |
| A6 | R1.9 / R14.6 | prepared 后取消 | call 进入 `terminal/not_sent`，send=0 | 通过 · gateway.db「A6/R14.6」(prepared 后取消 → not_sent) |
| A7 | R15.1 | 查询 status | ProviderTransport 调用次数为 0 | 通过 · status.db「A7」(整个查询只 SELECT) |
| A8 | R15.3–15.4 | 构造 structured success + media pending、冲突、重试、终态失败、取消 | status 分别可区分；body/log 无 secret、raw body、完整 ODS key、临时 URL | 通过 · status.db「A8 状态可区分」「脱敏」 |
| A9 | R15.5 | 查询未知 / 超过一年 / 越权 root | non-disclosing 的 not-found / expired / denied；不从长期业务事实反推 | 通过 · status.db「A9」 |
| A10 | R1.7 | fake clock 推进超过一年后用同 key 新 payload | 允许新 root；旧 status 不再承诺；长期业务事实不重复 | 通过 · commands.db「A10/R1.7」 |

### B. 主页入口解析

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| B1 | R3.1 | 提交主页 URL | 入口原文完整保留，kind=`home` | 通过 · locator.test「入口类型」 |
| B2 | R3.2 | 提交视频 / 笔记 / 作品分享文本 | 终态 `invalid_link`；不建账号、归属、快照；不重试 | 通过 · locator.test、tracer-flow.douyin.db「视频链接」(调用 0) |
| B3 | R3.3 | 提交短链 | 不出现自建 redirect follower / 平台 HTML 解析；由 `media_user_info` 处理 | 通过 · locator.test「短链 → unknown 照常发送」；provider-adapter 内无 redirect follower / HTML 解析(代码检索) |
| B4 | R3.4 | 带分享文案的链接 | 只做最小清洗；路径、查询参数与标识语义不变；原值与清洗值都保留 | 通过 · locator.test「最小清洗」 |
| B5 | R3.5 / R4.1 | 连续三次解析失败 | 三次独立 ProviderCall；终态失败；账号/归属/快照/发现/检查点均为 0 | 通过 · tracer-flow.douyin.db「连续三次 RESULT_VALIDATION_FAILED」 |
| B6 | R3.8 | 解析结果属于另一平台 | 拒绝；不静默切换平台 | 通过 · tracer-flow.douyin.db / xiaohongshu.db「平台错配」 |
| B7 | R3.9 | 同一 root 恢复 | 复用已成功证据；不重复付费调用 | 通过 · tracer-flow.douyin.db「重复提交与恢复」 |
| B8 | R3.10 | locator 阶段已产生 captured terminal `media_user_info` | 复用该 payload；不额外发 profile 请求 | 通过 · tracer-flow.douyin.db「接手：主页事实已提交后崩溃」、strategy.test(成功路径 2 次调用) |
| B9 | R3.7 | 正常解析成功 | locator 与账号 ID 来自同一条 captured terminal payload，并在同一事务写入；跨调用拼接的负例被拒绝 | 通过 · gateway.db「R3.7 / B9」 |

### C. 身份、值状态与归属

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| C1 | R5.1 | 19 位外部 ID | 以原始文本保存；无 JS number 转换或精度丢失 | 通过 · schema.db「19 位外部 ID」、tracer-flow.douyin.db 主路径 |
| C2 | R5.2 | 相同字符串、不同 namespace 查找 | 视为不同身份；hash 命中后复核原文 | 通过 · schema.db 唯一键(namespace+摘要)；**新增** identity/repository.db.test「摘要相同、原文不同 → identifier_text_mismatch」 |
| C3 | R5.3 | 同一 payload 明确给出多个官方 ID | 绑定到一个 ExternalAccount，记录 binding method/confidence | 通过 · tracer-flow.xiaohongshu.db 主路径、decode-video-list.test(sec_uid) |
| C4 | R5.4 | 无已批准规则的两 namespace 相同字符串 | 保持分离 | 通过 · schema.db(相同文本、不同 namespace 允许共存)、tracer-flow.xiaohongshu.db(两个 namespace 分别记录) |
| C5 | R5.5 | 构造 value / missing / explicit_null / invalid / unsupported | 五态分别保留；真实 0 为 `value` | 通过 · value-state.test、schema.db「值状态 CHECK」 |
| C6 | R5.6 / R9.7 | 抖音列表返回 0、播放数、小红书缺字段 | 记为 `unsupported`；不写成 0 / missing / invalid | 通过 · decode-video-list.test、merge.test |
| C7 | R5.7 / R9.10 | 一条 entry 缺 `text` | 该 entry 按容错解析，其他 entry 不受影响 | 通过 · decode-video-list.test「按条目容错」 |
| C8 | R6.1 / R6.4 | 小红书 fixture 21/21 同作者 | profile ID 与 dominant author 在各自 namespace，绑定到同一账号 | 通过 · tracer-flow.xiaohongshu.db 主路径 |
| C9 | R6.2 | tie / 空作者 / 唯一低占比 | 不绑定；写 `data_quality_issues`，含 policy version、counts、denominator、reason | 通过 · dominant-author.test、tracer-flow.xiaohongshu.db「主导作者策略：少数作者与拒绝」 |
| C10 | R6.3 | minority author | 只保留在内容事实；不创建账号 | 通过 · tracer-flow.xiaohongshu.db(20/21，少数作者只进内容快照) |
| C11 | R7.1 | 账号无冲突归属 | 同一短事务写当前归属与入口；无时间区间 | 通过 · tracer-flow.douyin.db 主路径 |
| C12 | R7.2 | 账号已属于同一 MediaStaff | 幂等复用，无第二条归属 | 通过 · tracer-flow.douyin.db「账号已归属同一专员」 |
| C13 | R7.3–7.4 | 账号已属于他人 | 原 owner 不变；提交者不是 owner；冲突可处理；默认停止后续付费 | 通过 · tracer-flow.douyin.db / xiaohongshu.db「账号已归属他人」 |
| C16 | R7.8 | 专员在同一平台已有另一个账号 | 根任务阻塞为 `staff_platform_slot_taken`；不建归属；不继续付费 | 通过 · tracer-flow.douyin.db / xiaohongshu.db(staff_platform_slot_taken)、schema.db D-69 |
| C14 | R7.6 / R18.4 | 采集后管理员改绑 | 历史 discovery 的归属快照不变 | 通过 · schema.db「content_discoveries：采集当时的归属快照」 |
| C15 | R7.7 | 首次录入 | current 入口写入，previous 为空 | 通过 · tracer-flow.douyin.db 主路径(previous 为空) |

### D. 快照、完整页与按账号内容

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| D1 | R8.6 | 同一账号同一批次重复采集 | 最多一份 finalized profile snapshot | 通过 · tracer-flow.douyin.db 重复提交、schema.db(同账号同批次一份快照) |
| D2 | R8.1–8.2 | profile 含 0 / missing / null / invalid | snapshot 绑定 call/ODS/Adapter/account/时间；值状态保真 | 通过 · tracer-flow.douyin.db 主路径、decode-profile.test、schema.db |
| D3 | R8.4 | 旧 run 迟到 | 不能回退 current pointer | 通过 · tracer-flow.douyin.db「旧批次迟到」 |
| D4 | R9.1–9.2 | 抖音 fixture 返回 20 条 | 20/20 全部处理；limit 不切片 | 通过 · tracer-flow.douyin.db 主路径、decode-video-list.test(20/20) |
| D5 | R9.11 | 小红书 fixture 返回 21 条，limit≤20 | 21/21 全部处理；不因本地 limit 丢第 21 条 | 通过 · tracer-flow.xiaohongshu.db(21/21，limit=5)、page-contract.db(25 条，limit=1) |
| D6 | R9.3 | 同一作品出现在两个账号列表 | 两个账号各一份 snapshot 与 discovery；不跨账号合并 | 通过 · projection.db「按账号的内容 grain」 |
| D7 | R9.4 | 同一 batch+账号重复 content ID | 每个 entry 都验证和计数；只一个 discovery；重复位置进入 page/call evidence | 通过 · projection.db、page-contract.db「重复条目」 |
| D8 | R9.5 | 先有效值、后 missing/null/invalid/unsupported | 后到值不擦除已有有效值；后到真实 0 覆盖 | 通过 · merge.test、projection.db「合并后的值落库」 |
| D9 | R9.6 | 有视频 / 无视频有图 / 只有文本 / 缺失或矛盾 | 分别输出 `video` / `image` / `text` / `unknown`；不输出 `mixed` | 通过 · decode-video-list.test「content_kind 推断表」 |
| D10 | R9.8 / R12.3 | 封面候选数组 3 条 | cover 引用固定第 2 条；全部候选作为证据保留 | 通过 · decode-video-list.test、archive.db(封面取第 2 条) |
| D11 | R9.9 | 0 条 + `has_more=false` | 真实空列表，任务成功，不记技术失败 | 通过 · page-contract.db「空列表是真实空页」 |
| D12 | R11.1–11.2 | 抖音 fixture 命中 `HITACHI2023` | 内容事实与 returned author 保留；不创建第二账号；不单凭差异报质量问题 | 通过 · tracer-flow.douyin.db(HITACHI2023 只在内容事实，不建第二账号) |

### E. 检查点与锚点

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| E1 | R10.1–10.2 | 整页全部 entry 到达终态 | 原子建立 checkpoint；字段符合 v2（cursor/anchor/batch/continuity/version） | 通过 · projection.db「检查点」、tracer-flow.douyin.db |
| E2 | R10.4 / R10.9 | 抖音 `max_cursor` | 持久化与后续请求都保持 integer | 通过 · projection.db「整数游标」、tracer-flow.douyin.db |
| E3 | R10.4 / R10.9 | 小红书 `max_cursor` | 持久化与后续请求都保持 string | 通过 · tracer-flow.xiaohongshu.db「游标保持字符串」 |
| E4 | R10.5 | 任一 entry 投影失败 | checkpoint version 不前进 | 通过 · page-contract.db「条目投影失败 / 页未处理完」 |
| E5 | R10.6 | stale fence worker 完成 | 迟到 cursor 可留证据，但不覆盖更高 version | 通过 · tracer-flow.douyin.db「fencing 与取消」「旧批次迟到」、projection.db「已存在检查点：不改写」 |
| E6 | R10.7 | 有有效 `published_at` | `anchor_mode='time'`，最大时间 + 同刻 ID 集合 | 通过 · anchor.test、projection.db |
| E7 | R10.7 | 无有效时间、有内容 ID | `anchor_mode='id_window'`，第一页全部 ID | 通过 · anchor.test、projection.db |
| E10 | R10.10 | 首屏不足 limit 且 `has_more=true` | 不请求第二页；按首屏建立基线 | 通过 · page-contract.db「首屏不足 limit 且 has_more=true」 |
| E11 | R10.11 | `has_more=true` 但游标为空 / null | 记质量问题；按已处理页建立基线；不再请求 | 通过 · page-contract.db(问题码为 field_contract_anomaly，reason=cursor_missing_while_has_more) |
| E8 | R10.7 | 首屏 0 条、`has_more=false` | `anchor_mode='empty'`，任务成功 | 通过 · page-contract.db、anchor.test |
| E9 | R10.8 | 首屏完整处理达到 limit | 停止并建立基线；不把供应商仍有历史页记为缺口 | 通过 · page-contract.db「limit 只决定是否请求下一页」 |

### F. 正式媒资与标准化衍生图

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| F1 | R12.2 | 抖音 profile 含头像/背景 | 生成 avatar/background 引用 | 通过 · archive.db「抖音：原始字节与标准化衍生图」 |
| F2 | R12.2 | 小红书 profile | 不生成 avatar/background 引用，不补造占位图 | 通过 · archive.db「小红书：没有头像 / 背景引用」、decode-profile.test |
| F3 | R12.3 | 内容封面 | 引用第 2 条候选（540 宽） | 通过 · archive.db、decode-video-list.test |
| F4 | R12.4 | 相同字节的两张图 | 只产生一份 MediaAsset，多个引用共享 | 通过 · archive.db(相同字节只一份资产) |
| F5 | R12.4 | 临时 URL 变化、字节相同 | 不产生新资产 | 通过 · archive.db「字节相同、URL 不同」 |
| F6 | R12.5 | 生成标准化衍生图 | 独立 SHA-256、独立资产；原始字节仍存在；两者不互相替代 | 通过 · archive.db(衍生图独立 SHA-256，原图仍在)；services/capability pytest 7 条 |
| F7 | R12.6 | structured 完成、media 仍 pending | root 可先成功；media 进度独立可见 | 通过 · archive.db「结构化先完成、媒资仍 pending」、status.db |
| F8 | R12.8 | 下载失败且有旧资产 | 快照成功；`carried_forward`，本轮失败可见；不表示为归档成功 | 通过 · archive.db「carried_forward」 |
| F9 | R12.8 | 下载失败且无旧资产 | 快照成功；media 失败可见 | 通过 · archive.db「签名 URL 过期」(无旧资产 → failed) |
| F10 | R12.9 / R16.2 | 默认测试 | fake OSS / fake media；无真实网络下载 | 通过 · archive.db(fake OSS / fake media)、harness.test(network-deny) |

### G. 能力门控与错误语义

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| G1 | R13.7 | 请求抖音/小红书 `user_video_list` 异步 | capability gate 拒绝；ProviderCall=0 | 通过 · capability.test、commands.db A4、tracer-flow.resilience.db「user_video_list 异步永远不被允许」 |
| G2 | R13.2 | 同步 profile/list | 单次 captured terminal result；无多余轮询 | 通过 · tracer-flow.douyin.db「ProviderCall 数 = 主页 1 + 列表 1」 |
| G3 | R13.3 | 异步 profile | 提交 1 次 + 每次轮询独立 ProviderCall；持久化 task ID | 通过 · tracer-flow.resilience.db「异步主页」(真实异步 smoke 也观察到 202 + 1 次轮询) |
| G4 | R13.5–13.6 | fixture_observed tuple 在 production 环境 | 拒绝；fixture 不自动激活生产 | 通过 · capability.test「仅 fixture_observed 不能在 production 激活」 |
| G5 | R13.8 | 认证 header 配置 | 使用 `X-Api-Key`；Bearer 文档矛盾被记录；生产仍需批准式 smoke | 通过 · capability.test(R13.8)、http-transport.test(X-Api-Key)；真实 smoke 实测 200 |
| G6 | R13.9 / R14.3 | HTTP 500 `RESULT_VALIDATION_FAILED` | 有界重试；每次新 ProviderCall；重试耗尽后才由业务层判 `invalid_link` | 通过 · tracer-flow.douyin.db、gateway.db「RESULT_VALIDATION_FAILED 重试」 |
| G7 | R14.1 | HTTP 400 `INVALID_REQUEST` | 认证/请求错误分类；不当作输入错误或账号不存在 | 通过 · tracer-flow.douyin.db「HTTP 400 INVALID_REQUEST」 |
| G8 | R14.2 / R14.7 | transport / ODS / parse / timeout 失败 | 不产生空 profile/list；不改账号 status | 通过 · gateway.db H1/H4、tracer-flow.resilience.db(poll_timeout 无业务身份)；代码中没有任何路径把账号置为 unavailable / deleted(检索) |
| G9 | R14.4–14.5 | 崩溃后 resume | 从 durable 事实继续；不重复已完成付费 effect | 通过 · tracer-flow.resilience.db「崩溃与恢复」 |
| G10 | R14.6 | 取消 | 禁止新付费调用；fence 拒绝迟到写；证据保留 | 通过 · tracer-flow.douyin.db「fencing 与取消」、gateway.db |

### H. ODS 顺序与保留期

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| H1 | R2.1–2.2 | 发送前 | request intent + request bytes 已持久化且已提交 | 通过 · gateway.db「H1 / H2」 |
| H2 | R2.3 | 收到完整响应 | response bytes 先落 ODS 并验证，之后才 decode | 通过 · gateway.db「H1 / H2」 |
| H3 | R2.5 | ODS 写失败 / 完整性失败 | decoder 与 projector 调用次数均为 0 | 通过 · gateway.db「响应写 ODS 失败 / 哈希不一致 / 截断」 |
| H4 | R2.4 | 传输失败 | 结构化 transport-error artifact 已保存 | 通过 · gateway.db「H4：传输失败」。**注：** 连接阶段超时 UND_ERR_CONNECT_TIMEOUT 现落 terminal/transport_error(delivered=no)；请求发出后的超时才是 ambiguous |
| H5 | R2.7 | 发送后远端结果不明 | 原调用标 `ambiguous` 并保留；最多再发一次新 ProviderCall，计入预算；业务事实不重复 | 通过 · gateway.db「H5 / H6 / R2.7」 |
| H6 | R2.8 | 一年清理 | 只删 payload → call → task；snapshot/assignment/discovery/checkpoint/media 仍在 | 通过 · retention.db「一年清理」 |
| H7 | R2.10 | 清理重复执行 | 幂等；无重复删除或残留；可审计 | 通过 · retention.db(远端删除失败后重跑完成；恰好到期边界) |
| H8 | R2.8 | ODS metadata / 日志 | 无 `X-Api-Key`、Bearer、Cookie、secret | 通过 · gateway.db H8、smoke.db(ODS 证据无 secret)；真实 smoke 未见 secret 落盘 |

### I. 首次录入结果与质量问题

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| I1 | R19.1 | 正常 profile（非 0/0） | entry outcome=`normal` | 通过 · tracer-flow.douyin.db 主路径 |
| I2 | R19.2 | follower=0 且 post=0、主页可访问 | outcome=`suspected_empty`；写 `data_quality_issues`；不自动纳入监控 | 通过 · tracer-flow.douyin.db / xiaohongshu.db「疑似空账号」 |
| I3 | R19.4 | 身份冲突 / 字段异常 / 连续性缺口 / 媒资失败 | 各产生可查询 issue；不删改业务数据 | 通过(连续性缺口除外) · identity_conflict / field_contract_anomaly / assignment_conflict 有测试；**media_archive_failed 为本次补齐**(archive.db 新增断言)。连续性缺口：本 spec 只建首屏基线，E9 明确不算缺口，E11 记为 field_contract_anomaly；`continuity_gap` 问题码留给 a-full-sync(见下「已知缺口」) |
| I4 | R19.5 | 任意技术失败 | `ExternalAccount.status` 不变；不自动 `unavailable` / `deleted` | 通过 · 静态：externalAccounts 只更新 current 指针与 last_seen；tracer-flow.douyin.db(账号 status 保持 active) |
| I5 | R19.6 | 按 account / batch / ProviderCall 查询 issue | 保留期内可查 | 通过 · status.db(按批次)、schema 索引 idx_issues_account / idx_issues_call、page-contract.db(provider_call_id 非空) |
| I6 | R19.7–19.8 | 正常账号与疑似空账号各一 | 归属行 `intake_status` 分别为 `normal` / `suspected_empty`；后者不进入常规采集，监控开关不被关闭 | 通过 · tracer-flow.douyin.db / xiaohongshu.db |

### J. 离线、安全与并发

| # | 需求 | 断言 | 预期 | 结果 / 证据 |
|---|---|---|---|---|
| J1 | R16.1–16.2 | 默认 suite | 网络禁用；无 AI Master secret；真实请求即失败 | 通过 · harness.test「network-deny」；verify.sh 全程禁网 |
| J2 | R18.5 / C7 | 网络 IO 期间 | 数据库事务未开启 | 通过 · gateway.db「J2」、archive.db「下载网络等待期间没有打开的数据库事务」 |
| J3 | R18.1–18.2 | lease 过期 / 更高 fence | stale worker 不能提交 current、checkpoint、assignment 或 media 终态 | 通过 · tracer-flow.douyin.db / resilience.db「租约接管」 |
| J4 | R18.3 | 两个 worker 重放同一 logical effect | 最多一个业务事实；两次尝试都可见 | 通过 · gateway.db「J4」 |
| J5 | R18.6 | 同账号同动作并发提交 | 复用活动任务，不并发执行 | 通过 · commands.db「A5 / R1.8 / R18.6」 |

## 手工项

| # | 需求 | 谁看 | 在哪看 | 检查什么 | 结果 / 证据 |
|---|---|---|---|---|---|
| M1 | R17.1–17.3 | 集成负责人 | smoke 启动页 / 终端 | 审批记录、allowlist、预算与 deadline；无批准时任何网络调用前失败 | 通过 · preflight.test、smoke-cli.test、smoke.db(无批准 → 任何网络调用前失败)；2026-11-04 真实运行 4 次。**审批为委托授权**(AI 按用户口头授权生成)，见 tasks.md「审查订正」6 |
| M2 | R17.4 | 集成负责人 | smoke 审计摘要 | 实际 tuple、calls、polls、latency、bytes、estimated points、result category、evidence refs；无 secret/full payload | 通过 · smoke.db(摘要字段齐全、无 secret / 载荷 / locator 原文)；审查时用库内证据复核了 7 次调用 |
| M3 | R15.6 | 平台运营 | tracer 状态页 | 能看到批次级与账号级结果、entry outcome、返回/投影条数、失败原因与媒资警告 | **本 spec 无页面**：以 `tracer status` 查询(status.db A8/A9)代替；面向运营的状态页留给后续界面 spec |
| M4 | R12 / A v1.10 §10.2 | 平台运营 | 媒资结果 | tracer 不调用任何 OCR、ASR 或视觉识别能力；衍生图只是格式转换（平台 ASR 归 C 域） | 通过 · 代码检索：无 OCR / ASR / 视觉调用；衍生图只是 HEIC→JPEG 格式转换(services/capability) |
| M5 | R3.2 | 平台运营 | 入口提交页 | 视频/笔记链接被明确提示“非主页入口”，没有被当作主页重试 | **页面部分不适用**；CLI/命令层已验证 invalid_link(locator.test、tracer-flow.douyin.db)，提示文案属于后续界面 spec |

## 环境依赖项（不能离线验证）

| # | 依赖 | 当前状态（2026-11-04） | 何时可验 |
|---|---|---|---|
| ENV1 | AI Master 同步主页 / 列表真实调用 | **已验证**：抖音主页 + 列表、小红书主页 + 列表各至少 1 次 HTTP 200，适配器重放全部 `decoded`；capability 仍全部 `activation=disabled` | 生产启用需单独批准式 smoke |
| ENV2 | AI Master 异步主页真实调用 | **已验证**（抖音）：提交 202 + 1 次轮询即 `succeeded`；终态 schema 与同步一致；时间戳为 +08:00 无偏移；任务 TTL 仍未知。小红书异步主页未实跑 | 小红书异步、TTL 需另行 smoke |
| ENV3 | AI Master 异步列表 | raw4 / raw5 / raw8 均失败；保持 disabled | 供应商修复后重新评估 |
| ENV4 | OSS 私有 ODS 真实写入与完整性校验 | **已验证**：14 个 `smoke/ods/` 对象，审查时回读字节长度与库中 `byte_length` 一致，适配器可解码 | — |
| ENV5 | 真实媒资下载与标准化衍生图 | 未执行（只有 fake 媒资与 HEIC fixture 的离线验证） | 真实封面归档后 |
| ENV6 | 小红书 dominant-author policy 阈值 | 默认 80% / 候选至少 3 次已实现并版本化(`xhs-dominant-author.v1`)；**业务确认待办** | 业务确认后 |
| ENV7 | v2 六项基线冲突修订 | **已修订**(2026-11-04，requirements §1.2) | — |
| ENV8 | 真实媒资 URL 有效期 | 未确认（可能 7–15 天） | 观察真实过期与重取行为后 |

## 覆盖不了的

- **生产 QPS 与并发**：点数表与单价(0.02 元/点，2026-11-04 确认)已知，QPS 仍未获得；预算只是估算，供应商对账单为准。
- **异步列表**：三平台列表异步均失败，保持 disabled；不使用“异步全平台可用”的表述。
- **快手**：属于 `a-full-sync`，本 spec 不验收。
- **跨账号内容 grain**：tracer 只有单账号，无法用真实数据证明“同一作品在两个账号各存一条”；该条由 v2 修订与 `a-full-sync` 覆盖。
- **图文图片、视频源、音频**：属于 `a-full-sync` 与 2.0 图文归档。
- **活动计划、名单导入、外部监控账号**：不在本 spec。
- **账号改绑、停用/删除处置、质量问题处置工作台**：不在本 spec；只验证“不自动改状态”和 issue 可查询。
- **手机浏览器 / 前端交互**：tracer 首版可由 service principal 调用，没有面向真实用户的页面。