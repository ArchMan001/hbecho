# A 活动计划（a-activity-plan）· 验收

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-activity-plan`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11（定稿候选）§14 A1、A2 与 §11
>
> **最近核对**：2026-11-06
>
> **更新日期**：2026-11-11（任务 12 回填：`[自动]` 项逐条通过；`[手工]` 项未执行；`[环境]` 见文末）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出或表格软件中看，写明谁看、看什么、检查什么。
- `[环境]`：依赖测试机或真实数据，不能在本机离线判定；标明当前状态。
- 每条对应 requirements 的 `AP-n`；没有「看一眼就行」的条目。
- 需要 MySQL 的自动项写成 `*.db.test.ts`（`pnpm test:db`），其余是 `unit` project（`pnpm test`）；入口是 `./scripts/verify.sh`。
- 页面归本 spec（界面设计已于 2026-11-10 确认，design §15.6）；页面任务 P1–P5 于 2026-11-12 实施，其验证见 tasks「页面任务」与「页面实施记录」，本文的条目仍只覆盖 Module / CLI；页面的 `ui-foundation.md` §9 清单逐项勾选留给 `[手工]` 走查。
- 付费调用的真实 smoke **不是**自动验收，见 L 组与「环境项」。

## 逐条结果

2026-11-11 回填。本机 `./scripts/verify.sh` 通过（类型检查 + 离线单元测试 853 个 + 数据库测试 1,095 个通过 / 1 个既有 skip + 迁移一致 + 文档与密钥；Python 侧已验证）。`[自动]` 项全部有对应测试，**通过**；`[手工]` 项**未执行**（M1–M5 需要业务人员或评审人）；`[环境]` 见文末。

| 组 | 结果 | 测试文件（`src/` 下） |
|---|---|---|
| A 计划创建与状态 | 通过 | `modules/activity-plan/plans.db.test.ts`、`worker/plan-cli.db.test.ts`（A4 的命令行入口） |
| B 参与与名额 | 通过 | `modules/activity-plan/participation.db.test.ts`（含 B15 显式闸门并发）、`roster/confirm.db.test.ts`（B8–B12 确认时占用） |
| C 模板与文件级校验 | 通过 | `roster/template.test.ts`、`roster/return-file.test.ts`（C10）、`roster/precheck.db.test.ts` |
| D 预检 | 通过 | `roster/classify.test.ts`（D4–D25 逐码）、`roster/precheck.db.test.ts`（D1–D3、D26–D30、真实库原因）、`acceptance-gaps.db.test.ts`（D24、D25） |
| E 专员新建与确认写入 | 通过 | `roster/confirm.db.test.ts`（含 2,000 行、第 3 块后杀进程、租约接手、超时续跑）、`orchestrator/tracer-flow.profile-only.db.test.ts` |
| F 解析与归并 | 通过 | `roster/resolver.db.test.ts`、`roster/settle.test.ts`、`acceptance-gaps.db.test.ts`（F14 用真实 `supplement`、F17、F18） |
| G 名单维护 | 通过 | `roster/maintain.db.test.ts` |
| H 监控联动与引用计数 | 通过 | `plan-references/rules.test.ts`、`plan-references/reconcile.db.test.ts`、`acceptance-gaps.db.test.ts`（H13）、`roster/resolver.db.test.ts`、`plans.db.test.ts` |
| I 每日维护 | 通过 | `maintenance.db.test.ts`、`acceptance-gaps.db.test.ts`（I6）、`acceptance-boundaries.test.ts`（I8 装配静态检查） |
| J 查询与读取契约 | 通过 | `query.db.test.ts`、`status.test.ts`、`roster/return-file.test.ts`、`acceptance-gaps.db.test.ts`（J5、J7、J18） |
| K 授权与审计 | 通过 | `authz.test.ts`、`acceptance-gaps.db.test.ts`（K2 查询计数器、K2a 与 B 的 `authorize` 契约、K8、K10）、`worker/plan-cli.db.test.ts`（K3–K6） |
| L 离线与一致性 | 通过 | `db/activity-plan-schema.db.test.ts`（L3–L7）、`acceptance-boundaries.test.ts`（L8–L10）、全量 `verify.sh`（L11–L12） |

说明：

- K3「缺 `HBECHO_AP_BRANCH_SCOPE` 启动失败」由 `actorFromEnv` 的单元测试守护（`authz.test.ts`）；`plan-main.ts` 在它抛错时直接 `exit(1)`，进程级入口本身没有自动化测试；
- D18（解析后判为无效的行是 `invalid` 而不是预检错误）由 `roster/settle.test.ts` 的映射表和 `resolver.db.test.ts` 的 `invalid` 行覆盖；
- L13（production capability 保持 disabled）：本 spec 没有改动 `provider-adapter/capability.ts`；`plan resolve --once` 与 sync worker 的名单驱动都在 `assertWorkerCanRun` 之后才装配，没有已批准 capability 时不会运行。

## 自动项

### A. 计划创建与状态（AP-1、AP-2）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| A1 | AP-1 | 创建：缺品牌 / 品牌越范围 / 平台为视频号 / 板块空集 / 名称空白 / 名称 201 字 / 说明 2,001 字 / 结束日早于开始日 | 各自稳定报错；`activity_plans` 行数为 0 |
| A2 | AP-1 | 合法创建（不带板块参数） | 状态 `collecting`；板块行 = 水机 + 家装；返回「需要 2 份监控判定计划：家装、水机」 |
| A3 | AP-1 | 只选水机 | 板块行 1；返回「需要 1 份：水机」 |
| A4 | AP-1 | 命令行带 `--brand` / `--platform` / `--sectors` 修改已有计划 | `immutable_field`；库中无变化；代码中不存在更新这三列的路径（静态搜索） |
| A5 | AP-1 | 创建者改名称 / 说明 / 起止日期 | 成功；变更记录一条，含操作者与时间 |
| A6 | AP-1 | 非创建者、非超管改他人计划；`hq_manager` 在授权品牌内改他人计划 | 拒绝；能看到该计划 |
| A7 | AP-2 | `collecting → paused`、`→ archived`、各自恢复 | 成功；`status_changed_at` 更新 |
| A8 | AP-2 | `paused → archived`（不经 collecting）；`deleted → paused` | 拒绝 `invalid_transition` |
| A9 | AP-2 | 暂停后：名单预检 / 确认、移出、加入、退出、替换负责人 | 全部 `plan_not_collecting`；恢复后可用 |
| A10 | AP-2 | 删除不带 `--apply` | 只返回预览（下游数、名单数、将关闭的账号数）；库中无变化 |
| A11 | AP-2 | 删除 `--apply`，下游 fake 报告 `running=1` | 拒绝 `downstream_running`；状态不变 |
| A12 | AP-2 | 删除 `--apply` | 计划不再出现在列表、详情、名单读取、批次查询；回收站可见（仅创建者 / 超管） |
| A13 | AP-2 | 删除后 29 天恢复 / 31 天恢复 | 成功且回到删除前状态 / 拒绝 `not_in_trash` |
| A14 | AP-2 | 删除、清除前后的账号 / 归属 / 专员 / 门店 / 批次 / 行结果行数 | 完全不变 |
| A15 | AP-2 | 删除、恢复调用下游端口的时机 | `onDeleted` / `onRestored` 在本 spec 事务提交之后；失败不回滚本 spec 事务，写审计 |
| A16 | AP-1 | 起始日期早于今天 | 允许（design §14 第 10 项） |

### B. 参与关系与负责人名额（AP-3、AP-4）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| B1 | AP-3 | 同品牌同平台的任意分公司加入；重复加入 | 成功；重复为空操作 |
| B2 | AP-3 | 未加入的分公司提交名单（预检） | 整个预检拒绝 `branch_not_joined`；无批次 |
| B3 | AP-3 | 分公司退出（预览 / apply） | 预览零变化；apply 后该分公司名单项全部 `removed(branch_exit)`、带时间与操作者；名额全部释放 |
| B4 | AP-3 | 退出后仅被本计划引用的账号 / 另被其他有效计划引用的账号 | 前者立即关闭监控；后者保持开启 |
| B5 | AP-3 | 重新加入后名单状态 | 仍为 `removed`；不新增第二行 |
| B6 | AP-3 | 重新提交其中 3 行 | 这 3 行恢复 `in_roster`（`UQ(plan_id, account_id)` 下无第二行）；其余仍 `removed` |
| B7 | AP-3 | 退出时仍有 `pending_account` 行 | 这些行 settle 时 `conflict / plan_state_changed`，不建名单项 |
| B8 | AP-4 | 第 1、2 位分公司人员各提交一批含新增行的文件并确认 | 各占一个槽；变更记录各一条 |
| B9 | AP-4 | 第 3 位提交含新增行的批次并确认 | 整批失败 `owner_slots_full`，提示现有两位负责人；专员 / 名单 / 根任务 / 行状态均无新增 |
| B10 | AP-4 | 一批全部是名单内已有行（`unchanged`）或入口文本命中已有账号的行 | 不占用名额 |
| B11 | AP-4 | 已是负责人的人再次提交 | 不重复占用 |
| B12 | AP-4 | 总部 / 超管（分公司范围 all）提交含新增行的批次 | 不占用 |
| B13 | AP-4 | 创建者替换某槽；分公司人员替换 | 成功并记变更 / 拒绝 |
| B13a | AP-4 | 创建者给空槽指派（`owner assign`）；分公司人员指派 | 成功并记变更 / 拒绝；非 `collecting` 被拒 |
| B14 | AP-4 | 暂停 / 归档 / 删除状态下替换 | 拒绝 `plan_not_collecting` |
| B15 | AP-4 | 两个提交（独立连接）抢最后一个槽，用显式闸门交错 | 恰好一个成功，另一个 `owner_slots_full` |
| B16 | AP-4 | 负责人是否因此获得额外权限 | 否：负责人名单变化不改变任何 `assert` 的结果（权限只取决于 Capability + 范围 + 谓词） |

### C. 模板与文件级校验（AP-5）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| C1 | AP-5 | 上传 10 MB + 1 字节文件 | `file_too_large`；批次与行结果行数 0 |
| C2 | AP-5 | 上传 2,001 个数据行 | `too_many_rows`；不建批次 |
| C3 | AP-5 | 列数不一致、引号未闭合、空文件、只有表头 | 各自稳定报错；不建批次 |
| C4 | AP-5 | 同一内容保存为 UTF-8、UTF-8 BOM、GB18030 | 预检结果完全相同；无替换字符 |
| C5 | AP-5 | 乱码字节 | `encoding_unrecognized`，返回前 200 字节可打印样本；无写入 |
| C6 | AP-5 | 表头改名、换序、多一列、少一列 | `header_mismatch`，展示正确 4 列与「请重新下载模板（roster-import.v1）」；不建批次 |
| C7 | AP-5 | 下载的模板原样上传 | 表头跳过；示例行被标出（不产生行结果）；其余行照常预检 |
| C8 | AP-5 | 示例行只改了一个单元格 | 不再被识别为示例行，按数据行预检 |
| C9 | AP-5 | 单元格含前导零的门店编码、手机号 | 按文本保留；`raw_row` 与文件原文逐字相同 |
| C10 | AP-5 | 回流文件中以 `= + - @ \t \r` 开头的单元格 | 带 `'` 前缀 |
| C11 | AP-5 | 模板说明文本 | 含「另存为 CSV」「先设为文本格式」两条 |

### D. 预检（AP-6）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| D1 | AP-6 | 预检一份含各类的文件 | 专员 / 账号 / 归属 / 名单 / 负责人 / 同步任务行数不变；批次 `awaiting_confirm` |
| D2 | AP-6 | 行结果 | 每数据行恰好一行；`row_no` 从 1 连续；`raw_row` 保存 4 列原文；表头与示例行无结果 |
| D3 | AP-6 | 各类计数 | `new + new_staff + update + unchanged + error` = 数据行数；`error` 都有 `reason_code` |
| D4 | AP-6 | 四列任一为空 | `error / required_missing`，detail 指明列 |
| D5 | AP-6 | 手机号 `1.38E+10`、10 位、`+8613800138000`（合法）、`138-0013-8000`（合法） | 前两种 `phone_invalid`；后两种规范化为 11 位后通过 |
| D6 | AP-6 | 门店编码不存在 / 属于另一品牌（操作者有该品牌范围）/ 属于范围外品牌 | `store_not_found` / `store_brand_mismatch` / `store_not_found`（不泄露） |
| D7 | AP-6 | 门店已撤（`closed`） | `store_closed` |
| D8 | AP-6 | 门店板块种类不在计划板块 | `store_sector_not_in_plan` |
| D9 | AP-6 | 他分公司的门店（分公司范围单一） / 总部与超管 | `store_branch_not_authorized` / 不受此限 |
| D10 | AP-6 | 分公司未加入（总部提交他分公司门店） | `branch_not_joined` |
| D11 | AP-6 | 手机号属于另一门店的有效专员 | `phone_belongs_to_other_store` |
| D12 | AP-6 | 同门店同号已停用专员 | `staff_inactive_restore_needed`；不新建第二条 |
| D13 | AP-6 | 手机号在有效专员中不存在 | `new_staff` |
| D14 | AP-6 | 手机号属于本门店有效专员 | `new`；姓名不同只在 detail 写 `staff_name_differs`，不阻塞 |
| D15 | AP-6 | 链接是视频 / 笔记 | `non_home_locator` |
| D16 | AP-6 | 抖音计划里填小红书主页链接 | `platform_mismatch`；**不默认成抖音** |
| D17 | AP-6 | 没有 URL 的纯分享口令 | 通过（交供应商判断），预检不拒绝；预检里不存在「链接格式错误」这个原因码 |
| D17a | AP-6 | 含 URL 但域名不属于任何支持平台（如 `https://example.com/user/1`） | `platform_unrecognized` |
| D17b | AP-6 | 各平台短链域名：`v.douyin.com`、`xhslink.com`、`v.kuaishou.com` | 域名可识别，通过（平台一致时）；平台不一致时报 `platform_mismatch` |
| D18 | AP-6 | 同上的行解析后被供应商判为无效 | 行 `invalid`（F5），不是预检错误 |
| D19 | AP-6 | 同一手机号两行（姓名相同 / 不同） | 两行都报 `duplicate_phone_in_file` / `phone_name_conflict_in_file` |
| D20 | AP-6 | 同一清洗后入口两行 | 两行都报 `duplicate_locator_in_file` |
| D21 | AP-6 | 优先级组合：手机号无效且门店不存在；重复组中一行另有门店错误 | 先报手机号；该行保留较早的错误，其余组员报重复 |
| D22 | AP-6 | 账号已在本计划名单且专员一致 / 已被移出且专员一致 | `unchanged` / `update (restore_roster_entry)` |
| D23 | AP-6 | 入口文本命中已有账号：同专员不在本计划 / 属于他人 | `new` + `known_account_same_owner` / `new` 或 `new_staff` + `known_account_other_owner`（预检类不变） |
| D24 | AP-6 | 哈希命中但原文不同 | 不视为命中（复核原文） |
| D25 | AP-6 | 同一专员已有另一账号（入口文本不同） | **预检不拒绝**（design AP-D22）；留给解析后 `intakeAccount` |
| D26 | AP-6 | 1,001 个「将新建专员」 | 整批拒绝 `too_many_new_staff`；无批次 |
| D27 | AP-6 | 计划已有 1,150 个账号，再提交 100 行 | 摘要 `soft_cap_exceeded=true`，可继续确认 |
| D28 | AP-6 | 计划非 collecting | 拒绝 `plan_not_collecting`；无批次 |
| D29 | AP-6 | 同一文件连续预检两次 | 两个批次；分类与行号一致；无业务写入 |
| D30 | AP-6 | 预检期间不发生供应商调用 | `network-deny` 通过；`ods_provider_calls` 行数不变 |

### E. 专员自动新建与确认写入（AP-7、AP-8）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| E1 | AP-7 | 确认含 `new_staff` 行的批次 | 新建有效专员，姓名取文件原文（去首尾空白）；审计 `staff_created`（门店、专员、批次）；行 `staff_id` 已填 |
| E2 | AP-7 | 预检与确认之间有人先建了同号专员 | 该行 `conflict / staff_phone_conflict`；仅一名专员；其余行继续 |
| E3 | AP-7 | 预检与确认之间同号专员被他人建到另一门店 | 该行 `conflict / precheck_stale`；不新建 |
| E4 | AP-7 | 已存在专员姓名与文件不同 | 不覆盖；行结果含 `staff_name_differs` |
| E5 | AP-7 | 确认后检查登录账号 / 用户行 | 没有创建任何登录账号或用户 |
| E6 | AP-8 | 状态为 `precheck_failed` / 非 roster 批次 / 范围外批次确认 | 拒绝 / 未找到 |
| E7 | AP-8 | capability 未放行时确认 | `unsupported_capability`；零写入（无专员、无根任务、行 `outcome` 全空、名额未占） |
| E8 | AP-8 | 名额已满 | `owner_slots_full`；零写入 |
| E9 | AP-8 | 预检后计划被暂停 / 删除 / 分公司退出 | 确认被拒；已在写入的批次下一块中止，已写行保留，批次停在 `writing` |
| E10 | AP-8 | 2,000 行文件确认完成 | 汇总（`summary.confirm`）与行结果聚合一致 |
| E11 | AP-8 | 第 3 块后抛错（`afterChunk` 注入）再确认 | 专员数、根任务数、行结果数不重复；前 3 块行 `outcome` 不被改写 |
| E12 | AP-8 | 两个确认顺序交错（先者持锁停在 hook） | 恰好一个进入 `writing`；另一个得到 `batch_in_progress`，或放行后看到已确认 |
| E13 | AP-8 | 心跳陈旧后被接手，旧进程继续下一块 | `lease_lost`；零写入 |
| E14 | AP-8 | 超过 10 分钟（fake clock） | 块边界停下、清空心跳、`time_limit_exceeded`；立即可续跑 |
| E15 | AP-8 | 已 `resolving` / `completed` 的批次再次确认 | 返回已确认结果；不重复写入 |
| E16 | AP-8 | 入口文本命中同专员已有账号 | 不创建根任务；`unchanged`；必要时恢复名单项 |
| E17 | AP-8 | 入口文本命中他人账号 | 不创建根任务；`conflict / assignment_conflict` |
| E18 | AP-8 | 未命中的行 | 根任务数 = 需要解析的行数；全部挂在**一个** `intake` 同步批次；幂等键 `roster:<批次>:<行号>`；重复确认不新增 |
| E19 | AP-8 | 写入期间的网络 | 无任何 socket |
| E20 | AP-8 | 重分类与预检类不一致（例如门店在预检后被撤） | `conflict / precheck_stale`，不写 |
| E21 | AP-8 | 全部行本地归并（没有任何根任务） | 批次直接 `completed` |

### F. 账号解析与结果归并（AP-9）

用 fixture transport 与 `FakeClock`，不发真实调用。

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| F1 | AP-9 | 新账号 | 行 `imported`；名单项 `in_roster`；账号监控开关开；只有主页调用，**没有**列表任务 |
| F2 | AP-9 | 账号已存在、同一专员（入口文本未命中） | 行 `unchanged / existing_account_referenced`；名单项建立 |
| F3 | AP-9 | 归属他人 | 行 `conflict / assignment_conflict`；无名单项；问题记录已有（tracer 写） |
| F4 | AP-9 | 专员在该平台已有另一账号 | 行 `conflict / staff_platform_slot_taken`；无新账号（孤儿账号不产生） |
| F5 | AP-9 | 入口无效（非主页 / 平台不符 / 解析耗尽） | 行 `invalid`，`reason_code` 取根任务错误码；无账号、无归属 |
| F6 | AP-9 | 疑似空账号 | 行 `suspected_empty`；名单项存在；监控目标解析**不含**该账号 |
| F7 | AP-9 | 技术失败（限流耗尽、5xx） | 行 `resolve_failed`；**不**标成 `invalid`；不自动重试 |
| F8 | AP-9 | 根任务被取消 | 行 `resolve_failed / root_cancelled` |
| F9 | AP-9 | settle 时计划已暂停 / 分公司已退出 | 行 `conflict / plan_state_changed`；无名单项；账号与归属保留 |
| F10 | AP-9 | settle 重复运行 | 无重复名单项、无重复审计（幂等） |
| F11 | AP-9 | 驱动抛错后重跑 | 已归并的行不重复处理；未完成根任务继续 |
| F12 | AP-9 | 根任务 `busy` / `retry_wait` | 行保持 `pending_account`，下个 tick 再处理 |
| F13 | AP-9 | 全部行终态 | 批次 `resolving → completed`；`summary.confirm.pending_account=0` |
| F14 | AP-9 | 批次完成时有 `unchanged` 账号，上次采集 > 7 天 / 未满 7 天 | `supplement` 返回 `queued` / `not_due`；仅调用一次，幂等键 `roster-refresh:<批次>` |
| F15 | AP-9 | 新建账号 | 不触发 `supplement` |
| F16 | AP-9 | capability 未放行（驱动运行时） | 根任务不运行；行保持 `pending_account`；不报错退出 |
| F17 | AP-9 | 驱动并发 | 同时处理的根任务数 ≤ 配置值；与周期同步共用同一网关实例（同一熔断 / 预算对象） |
| F18 | AP-9 | `summary.account_created` 缺失的旧根任务 | 按 `first_seen_at >= 根任务创建时间` 兜底判断 |
| F19 | AP-9 | 行为 `pending_account` 但 `resolve_task_id` 为空（根任务已过一年保留期被清理） | 驱动将该行落为 `resolve_failed / root_expired`，不悬挂 |

### G. 名单维护（AP-10）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| G1 | AP-10 | 按账号单条移出（预览 / apply） | 预览零变化；apply 后名单项 `removed(manual_remove)`，带时间与操作者 |
| G2 | AP-10 | 按专员批量移出 | 该专员的名单项全部移出 |
| G3 | AP-10 | 分公司人员移出他分公司的项 | 拒绝；零写入 |
| G4 | AP-10 | 总部 / 超管按授权品牌移出 | 成功 |
| G5 | AP-10 | 暂停状态移出 | `plan_not_collecting` |
| G6 | AP-10 | 同账号在计划 A、B：先后移出 | 第一次保持开启；第二次立即关闭（`unreferenced_15d`） |
| G7 | AP-10 | 疑似空账号确认（范围内 / 跨分公司） | `intake_status='normal'` + 审计 / 拒绝零写入 |
| G8 | AP-10 | 确认前后监控目标解析 | 确认前不含；确认后含 |
| G9 | AP-10 | 名单项永不物理删除 | 移出、退出后行数不减（计划清除除外） |

### H. 监控联动与引用计数（AP-11）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| H1 | AP-11 | 引用定义边界：结束日前一天 / 当天 / 后一天；无结束日 | 当天仍算引用；后一天不算；无结束日持续引用 |
| H2 | AP-11 | 暂停 / 归档 / 删除的计划 | 都不算引用 |
| H3 | AP-11 | 暂停：账号 | 保持开启；`unreferenced_since` = 暂停时刻；不立即关闭 |
| H4 | AP-11 | 暂停满 15 天后每日维护 | 关闭，原因 `unreferenced_15d` |
| H5 | AP-11 | 暂停中恢复 | 因 `unreferenced_15d` 关闭的立即重开；`manual` 关闭的不动；起点清空 |
| H6 | AP-11 | 删除 / 退出 / 单条移出 | 无其他引用 → **立即**关闭；有其他有效引用 → 保持开启 |
| H7 | AP-11 | 删除后 30 天内恢复（删除前为 collecting） | 因无引用关闭的账号重开 |
| H8 | AP-11 | 延长已到期计划的结束日 | 引用恢复，因无引用关闭的账号重开 |
| H9 | AP-11 | 缩短结束日到过去（编辑发生在结束日之后第 3 天） | 不立即关闭；起点 = 结束日次日北京时间 00:00（**不是**编辑时刻）；起点后第 15 天扫描关闭，即编辑后第 12 天 |
| H10 | AP-11 | 计划自然过结束日 | 起点取「结束日次日北京时间 00:00」；第 15 天扫描关闭 |
| H11 | AP-11 | 外部监控账号；从未入过名单的账号 | 不被任何联动关闭 |
| H12 | AP-11 | 导入已存在的、被人工关闭的账号 | 重开自身开关；审计 `monitoring_reopened_by_import`（含原关闭原因） |
| H13 | AP-11 | 导入遇到上级关闭（门店 / 专员 / 分公司 / 经销商） | 不改上级；行结果 / 批次详情提示关闭层级（取 `monitoring.explain` 最上级） |
| H14 | AP-11 | `monitoring set` 手动开启一个无引用账号 | 起点重置为当下；当天扫描不关闭；满 15 天后关闭 |
| H15 | AP-11 | 同一事件重复调用 | 账号状态与审计不重复变化 |
| H16 | AP-11 | 暂停期间重新加入分公司后提交 | 不补采中断期间历史；只从加入时刻起（不创建任何补采任务） |
| H17 | AP-11 | 新账号首次导入 | 立即只采主页（F1）；列表仍按每周节奏 |
| H18 | AP-11 | 引用数 > 0 但上级关闭 | 本规则不打开上级；`monitoring.explain` 仍返回上级原因 |

### I. 每日维护（AP-12）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| I1 | AP-12 | 起点后第 14 天 / 第 15 天运行 | 不关闭 / 关闭 |
| I2 | AP-12 | 起点缺失的候选 | 补记为 `computeStopAt`；报告「补记起点数」 |
| I3 | AP-12 | 删除后 29 天 / 31 天运行 | 不清除 / 清除；清除后计划层对象行数为 0；账号 / 归属 / 专员 / 批次 / 行结果不变 |
| I3a | AP-12 | 清除顺序 | 先调下游 `purge`，且调用发生时没有打开的数据库事务（hook 断言）；成功后才删除；崩溃在两步之间，重跑后幂等完成 |
| I4 | AP-12 | 下游 `purge` 失败 | 计划保留；下次重试；报告含失败步骤 |
| I5 | AP-12 | 一步失败 | 另一步照常；10 分钟退避重试 |
| I6 | AP-12 | 同一天重复运行；进程重启后同日再跑 | 不重复关闭、不重复清除、不重复审计 |
| I7 | AP-12 | 北京时间 04:00 前 | 不运行（`not_due`） |
| I8 | AP-12 | 装配里没有 OSS 配置 | 计划维护仍被调度（静态 + 装配测试） |
| I9 | AP-12 | `plan maintain` 手动命令 | 立即运行一轮，输出报告 JSON |

### J. 查询与读取契约（AP-13）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| J1 | AP-13 | 分公司 A 的人查同计划下分公司 B 的名单 / 批次 | 看不到；越范围 = 稳定「未找到」 |
| J2 | AP-13 | 总部查批次 | 有汇总；拿不到逐行明细 |
| J3 | AP-13 | 分公司人员查本分公司批次 | 能看到（不限于上传人） |
| J4 | AP-13 | 计划详情 | 规模计数（账号数、分公司数、板块数、待处理数）；**没有任何比率字段** |
| J5 | AP-13 | 回收站内计划 | 不出现在列表、详情、名单读取、批次查询；回收站列表仅创建者与超管 |
| J6 | AP-13 | 综合状态六取值 + 优先级冲突组合 | 与 A §11.6 一致（链接无效 > 疑似空账号 > XX 被关闭 > 被停止监控 > 已移出 > 正常采集） |
| J7 | AP-13 | 三个维度的存储 | 录入状态、名单状态、监控状态各自存储，不存合成列（schema 检查） |
| J8 | AP-13 | `rosterSnapshot` | 只含 `in_roster`；含专员、门店、分公司、账号、实际监控状态；移出后立即消失；暂停时仍可读 |
| J9 | AP-13 | 下游端口契约 | 默认空实现；fake 记录的调用顺序符合 A15 |
| J10 | AP-13 | 所有 BIGINT 输出 | 十进制字符串，无前导零 |
| J11 | AP-13 | 回流文件 | 列 / 顺序 / 行号与原文件一致，追加「预检分类 / 结果 / 原因」；只含 `error`、`conflict`、`invalid`、`resolve_failed`；BOM + CRLF |
| J12 | AP-13 | 回流文件改后作为新文件重传 | 新批次；分类可以改变；旧批次结果不变 |
| J13 | AP-13 | 每个 `reason_code` 的原因文案 | 全部存在（遗漏使测试失败）；界面 / 文件不出现内部字段名 |
| J14 | AP-13 | 查询是否写业务表 | 否（前后行数快照相等） |
| J15 | AP-13 | 下载回流文件 / 预检报告 | 随 `activity_plan.join`，不要求 `data.export`；写审计（操作者、批次、时间） |
| J16 | AP-13 | 计划被清除后查询其批次 | 批次与行结果仍在；`summary` 的计划名 / 平台 / 品牌快照可读；分公司人员按 `submitter_branch_id` 能看到自己提交的，总部按快照品牌，超管全部；不出现在任何以计划为入口的查询里 |
| J17 | AP-13 | `composeStatus` 对 `explain` 返回的全部排除原因（含 `brand_inactive`、`region_inactive`） | 每个原因都有文案；遗漏使测试失败 |
| J18 | AP-13 | 名单项可见范围 | 按加入时的 `branch_id` 快照；门店后来换分公司，名单项仍只对原分公司可见（AP-D23） |

### K. 授权与审计（AP-14）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| K1 | AP-14 | 无 capability / 越品牌 / 越分公司 / 非创建者各一次 | 稳定拒绝；除审计外零写入；越权对象表现为未找到 |
| K2 | AP-14 | 授权顺序 | 缺 Capability、品牌 / 分公司范围不符（来自 actor）的调用**不产生任何数据库读**（用查询计数器断言）；需要读计划行的谓词（创建者、对象状态）读发生在任何业务写入之前；谓词失败时库中无业务写入 |
| K2a | AP-14 | `assert` 与 B 的 `authorize` | `assert` 与 B 的 `authorize` 对「四类角色 × activity_plan.create / join」结论一致(契约测试)。**本轮没有把 `assert` 改成委托 `authorize`**：`PlanActor` 由 `toPlanActor` 从 `AuthContext` 适配而来，创建者与分公司谓词仍在 `assert` 里自己判断（谓词 `plan_creator` / `plan_branch` 未注册到 B），契约测试也不覆盖谓词；委托留到页面接入时(那时才有 `AuthContext` 贯穿到模块入口) |
| K3 | AP-14 | CLI 缺 `HBECHO_AP_BRANCH_SCOPE` / `BRAND_SCOPE` / `CAPABILITIES` / `ACTOR` | 启动失败，不退化成全部 |
| K4 | AP-14 | `HBECHO_AP_PLATFORM_ADMIN` 缺省 | 视为 false |
| K5 | AP-14 | CLI 是否存在 `--skip-auth` / `--force` | 不存在（参数解析 strict，传入即报错） |
| K6 | AP-14 | 删除、退出、批量移出、替换负责人不带 `--apply` | 库中无变化 |
| K7 | AP-14 | 审计覆盖 | 计划创建 / 编辑 / 状态 / 删除 / 恢复 / 清除、分公司加入 / 退出、负责人占用 / 替换 / 释放、批次预检完成 / 确认 / 拒绝、专员新建、名单移出、监控开启 / 关闭 / 重开、疑似空账号确认，各至少一条 |
| K8 | AP-14 | 审计内容 | 含 actor、时间、对象、批次、关键前后值；不含整行原文、文件内容、secret；手机号明文（D-42） |
| K9 | AP-14 | 变更记录 | 计划相关事件各一条，随计划清除 |
| K10 | AP-14 | 解析驱动与每日维护的身份 | 固定服务身份 `service:plan-worker`，审计中可见 |

### L. 离线、一致性与边界（AP-15）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| L1 | AP-15 | 测试进程启动时 | 网络 socket 被禁止；任何外联使测试失败 |
| L2 | AP-15 | 同一 fixture 连续运行 3 次 | 结果一致 |
| L3 | AP-15 | `migrate` 空库两次；`drizzle-kit generate` | 成功且幂等；无新迁移文件 |
| L4 | AP-15 | 测试库名 | 以 `_test` 结尾；结束后清理 |
| L5 | AP-15 | 数据库中是否有 `ON DELETE CASCADE` 指向组织主档 / 批次 / 账号 / 名单项 | 没有 |
| L6 | AP-15 | 名单项平台与计划平台不一致 | 数据库复合外键拒绝 |
| L7 | AP-15 | 并发插入同 `(plan_id, account_id)` | 一条成功，另一条稳定冲突 |
| L8 | AP-15 | `activity-plan` 的 `*.db.test.ts` 中的 `Promise.all` | 静态扫描为 0 |
| L9 | AP-15 | `unreferenced_since` 与 `monitoring_closed_reason='unreferenced_15d'` 的写赋值位置 | 只在 `plan-references`（静态护栏，扫描 `src/modules/**` 非测试文件，排除 `src/db/schema/` 与 `drizzle/`）；反向用例：放入故意违规的临时文件时护栏报错 |
| L10 | AP-15 | `activity-plan` 是否调用 `insertDemandTask` | 否（静态护栏） |
| L11 | AP-15 | master-data-import 与 tracer / full-sync 既有测试 | 全绿，一个断言都不改（抽取与 tracer 小改动不改变行为） |
| L12 | AP-15 | `./scripts/verify.sh` | 通过；Python 侧未验证时明确写出，不声称通过 |
| L13 | AP-15 | production capability | 保持 disabled；没有任何文件启用它 |

## 手工项

| # | 需求 | 谁看什么 | 通过标准 |
|---|---|---|---|
| M1 | AP-6、AP-9 | 业务人员用 CLI 走一遍：创建计划 → 加入 → 下载模板 → 填 20 行（含 3 个新专员、2 个错误）→ 预检 → 确认 → 看批次 | 预检报告的分类和原因他们看得懂；确认前库中确实没有新专员（再跑一次预检对照） |
| M2 | AP-5 | 在 Excel 里打开模板，填数据，另存为 CSV（UTF-8 与「CSV（逗号分隔）」默认 GBK 各一次）再上传 | 两次都能识别；门店编码、手机号的前导零没丢（按模板说明先设文本格式） |
| M3 | AP-13 | 在 Excel 里打开回流文件 | 不乱码；以 `=` 开头的链接显示为文本而不是公式；原因列的文案能让业务知道下一步 |
| M4 | AP-14 | 评审审计日志样例（计划创建、名单确认、专员新建、监控重开） | 每条含 actor、时间、对象、批次；没有整行原文 |
| M5 | AP-4 | 业务确认「名额按本地可知事实占用」的口径可接受（design AP-D04） | 刘学奎在 design §14 第 4 项给出结论 |

## 环境项

| # | 需求 | 内容 | 当前状态 |
|---|---|---|---|
| ENV-1 | AP-8 | 测试 ECS 上 2,000 行文件的预检 / 确认 / 解析耗时与内存（fixture transport） | **已执行（2026-11-11）**：预检 156 ms、确认 1.24 s、解析 24.9 s（并发 2，20 个 tick），进程 RSS 222 → 344 MB；1,200 账号引用重算 129 ms。本机（Mac）同一用例：172 ms / 2.5 s / 36 s / 206 → 248 MB / 271 ms。详见 design §12.1 |
| ENV-2 | AP-15 | 测试 ECS 一次性库容器跑 `pnpm test:db`（仅 Workbench；`_test` 库；用完 `down -v`） | **已执行（2026-11-11）**：84 个测试文件、1,096 个用例全部通过，472 秒（含 a-full-sync 的 6,000 账号演练）；容器内存峰值 node 840 MiB、MySQL 720 MiB。第一次运行发现 `*.csv` 被 `.gitignore` 排除、roster 夹具没有提交（15 个用例 ENOENT），已修复后重跑 |
| ENV-3 | AP-9 | **真实付费 smoke**：用少量真实主页入口走完整条链路 | **不属于本 spec 的自动验收。** 需要刘学奎批准、显式开关、固定预算与审计摘要，通过 `a-full-sync` 的批准式 smoke 机制另行申请；批准前 production capability 保持 disabled |

## 不在本 spec 验收内

- 页面（计划列表 / 详情、名单导入向导、账号列表）：已于 2026-11-12 实施（tasks P1–P5）；页面验收见 tasks，业务走查未做；
- 监控判定计划的创建与字段、判定、指标、看板、导出：D / C / E；
- 真实用户登录、DataScope、持久化审计：`b-access-control`；
- 修改已录账号的主页链接（design §14 第 3 项）；
- 路径 1（权威主档）：`a-master-data-import`。
