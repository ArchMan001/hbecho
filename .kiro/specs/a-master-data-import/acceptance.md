# A 主数据导入（a-master-data-import）· 验收

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-import`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10（2026-11-04，定稿候选）
>
> **最近核对**：2026-11-05
>
> **更新日期**：2026-11-05（审查修订：上游列名；删除「标为撤销」；续跑与 fencing；待确认撤店范围与 issue 收敛；结构操作收窄；补本地真实文件演练）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出或表格软件中看，写明谁看、看什么、检查什么。
- `[环境]`：依赖测试机或真实数据，不能在本机离线判定；标明当前状态。
- 每条对应 requirements 的 `MD-n`；没有「看一眼就行」的条目。
- 需要 MySQL 的自动项写成 `*.db.test.ts`（`pnpm test:db`），其余是 `unit` project（`pnpm test`）；入口是 `./scripts/verify.sh`。

## 逐条结果（2026-11-05，本机 `./scripts/verify.sh` 通过）

| 组 | 结果 | 测试文件 |
|---|---|---|
| A 文件级与批次账 | 通过 | `file-parser.test.ts`、`precheck.db.test.ts`、`bootstrap.db.test.ts`（表结构） |
| B 映射与分类 | 通过 | `classify.test.ts`、`precheck.db.test.ts`、`confirm.db.test.ts`（B18） |
| C 确认写入 | 通过（C9/H10 用生成的 10,000 行；C10 由 `tests/harness/setup.ts` 禁网保证） | `confirm.db.test.ts`、`perf.db.test.ts` |
| D 结构边界与授权 | 通过 | `structure-mode.db.test.ts`、`bootstrap.db.test.ts`、`bootstrap.test.ts`、`master-data-cli.db.test.ts`、`query.db.test.ts` |
| E 待确认撤店 | 通过 | `precheck.db.test.ts`、`closure.db.test.ts` |
| F 回流与重试 | 通过 | `return-file.test.ts`、`query.db.test.ts` |
| G 查询与审计 | 通过 | `query.db.test.ts`、`closure.db.test.ts`、`master-data-cli.db.test.ts` |
| H 一致性、恢复与离线 | 通过（H6 由确定性夹具与时钟保证，未单独循环跑 3 次） | 同上、`src/db/schema.db.test.ts` |
| M6 本地真实文件演练 | 通过：8,315 / 12 / 5,275，回流 12 行（见 tasks 实施记录） | 手工 |
| M3 10,000 行记录 | 通过：本机与测试 ECS 均已记录（测试机预检 564 ms / 确认 6.9 s / RSS 277 MB） | design §12 |
| M1 | 通过：业务确认可接受（含回流文件里 `'--` 的公式前缀），2026-11-05 | `tmp/md-demo/`（本机，不入库） |
| M2 | 通过：AI 评审（刘学奎授权，审计与待办由 AI 阅读）——待确认列表含门店编码/名称/品牌/经销商/板块，`open`/`resolved` 与 `resolution_note` 一目了然，疑似不完整提示清楚 | 同上 |
| M4 | 通过：AI 评审——每条事件含 actor、时间、对象、批次、前后状态，无整行原文与文件内容；评审中发现 `store_closed` 只有内部 ID，已补 `target_code`（门店编码）使事件自身可读 | `closure.db.test.ts`、`confirm.db.test.ts` |
| M5 | 通过：3 / 4 / 42 / 84 与种子一致（自动测试与演练均已核对）；品牌 / 板块编码命名（`hitachi/hisense/york_vrf`、`{分公司}-water/home`）已由刘学奎确认（2026-11-05） | design §14 第 1 项 |
| ENV-1 / ENV-2 | 通过（2026-11-05，测试 ECS 一次性容器） | tasks 实施记录 |

## 自动项

### A. 文件级校验与批次账

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| A1 | MD-1 | 上传 10 MB + 1 字节文件 | 结构化错误 `file_too_large`；`import_batches` / `import_row_results` 行数为 0 |
| A2 | MD-1 | 上传 10,001 行文件 | `too_many_rows`；不建批次 |
| A3 | MD-1 | 上传列数不一致、引号未闭合、空文件 | 分别稳定报错；不建批次、不写行 |
| A4 | MD-1 | 同一内容分别保存为 UTF-8（带/不带 BOM）与 GB18030 | 预检结果完全相同；无替换字符 |
| A5 | MD-1 | 上传乱码字节（非法 UTF-8 且非法 GB18030） | `encoding_unrecognized`，返回前 200 字节可打印样本；无写入 |
| A6 | MD-1 | 表头列名或顺序改动一位 | 整批拒绝；展示正确 11 列 |
| A7 | MD-1 | 首行为表头 | 表头被跳过；`row_no` 从 1 开始；第二行按数据行处理 |
| A8 | MD-1 | 上传带「负责人」的 12 列文件；上传把「门店所属商家」改回「经销商名称」的文件 | 都整批拒绝；展示正确 11 列；不建批次 |
| A9 | MD-2 | 预检一份含六类的文件 | 业务表 `updated_at` 与行数不变；批次 `awaiting_confirm` |
| A10 | MD-2 | 检查行结果 | 每数据行恰好一条；`row_no` 连续；`raw_row` 11 列原文 |
| A11 | MD-2 | 聚合分类计数 | `summary` 中五类行分类之和 = 数据行数；`pending_closure_stores` 单列且等于 issue 数；`error` / `needs_superadmin` 都有 `reason_code` |
| A12 | MD-2 | 同一文件连续预检两次 | 两个批次；分类与行号一致；无业务写入 |

### B. 映射与分类

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| B1 | MD-3 | 主营业务编码 `13/15/23/25/33` | 品牌与板块分别为 日立-家装 / 日立-水机 / 海信-家装 / 海信-水机 / 约克VRF-家装 |
| B2 | MD-3 | `013`、`13.0`、`1 3`、全角 `１３`；另有空值一行、尾空格 `13 ` 一行 | 前四种 `error/main_business_code_unmapped`；空值 `error/missing_required_field`；`13 ` 去首尾空白后等于 `13`，正常命中；都不回落默认品牌 |
| B3 | MD-3 | 42 个分公司编码 | 全部命中种子并解析到大区 |
| B4 | MD-3 | 未知分公司编码 | `needs_superadmin/branch_not_found`；不新建分公司；`structure` 模式仍为 Q |
| B5 | MD-3 | 科龙 / 中小门店类型编码 | `error`；不归入日立或家装 |
| B6 | MD-3 | `撤店情况=提交初审`、`是否数字门店=是` | 分别 `error/row_withdrawn`（`reason_detail` 含原值）、`error/row_digital_store` |
| B7 | MD-3 | 商家渠道编码为 `--` / `#N/A`；另有空值一行 | `error/dealer_code_missing`；空值行按优先级先命中 `error/missing_required_field`；都不静默丢弃 |
| B8 | MD-4 | 文件内同一 `(品牌, 门店编码)` 完全相同出现两行 | 两行都 `error/duplicate_store_code_in_file` |
| B8a | MD-2 | 重复组中的一行同时缺经销商 | 两行仍都是 `error/duplicate_store_code_in_file`（重复先于结构判断） |
| B8b | MD-4 | 同品牌两门店编码仅大小写不同 | 视为两家不同门店，不报重复（按字节比较，不折叠） |
| B8c | MD-2 | 同一商家渠道编码在文件内对应两个不同商家名称 | 该编码下所有行 `error/dealer_name_conflict_in_file` |
| B9 | MD-4 | 门店已存在、名称与等级相同 | `unchanged` |
| B10 | MD-4 | 门店已存在、名称或等级不同 | `update/store_fields_changed` |
| B11 | MD-4 | 门店已存在但 `status='closed'`，本行合法 | `update/reactivate_store` |
| B12 | MD-4 | 门店已存在、经销商或板块不同 | `needs_superadmin/store_relation_change` |
| B13 | MD-4 | 门店不存在、结构齐全 | `new` |
| B14 | MD-4 | 门店不存在且经销商缺失 | `needs_superadmin/dealer_not_found`，不标 `new` |
| B15 | MD-3 | 品牌 / 分公司 / 板块 / 经销商 `status='inactive'` | 分别 `needs_superadmin` 且 reason 为 `brand_inactive` / `branch_inactive` / `sector_inactive` / `dealer_inactive` |
| B16 | MD-5 | `structure` 模式遇到 `dealer_not_found` / `dealer_inactive` / `dealer_name_mismatch` / `store_relation_change` | 分别 `new(create_dealer)` / `update(activate_dealer)` / `update(update_dealer_name)` / `update(change_store_relation)`；品牌、分公司、板块相关仍 Q |
| B17 | MD-9 | actor 品牌范围 `{hitachi}`，海信行且 `hisense` 在库中缺失或停用 | `error/brand_not_authorized`（不是 `brand_not_found` / `brand_inactive`） |
| B18 | MD-4 | `店面标准` 为空 | 行合法；确认后 `store_tier IS NULL`，不是空串 |

### C. 确认写入

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| C1 | MD-7 | 确认一个含 new/update/unchanged 的批次 | 批次 `completed`；新门店存在；改名/改级生效；`unchanged` 行不改 `updated_at`/`source_batch_id` |
| C2 | MD-7 | 检查新建门店 | `source_batch_id` 等于本批次；`store_id` 为新生成 |
| C3 | MD-7 | 恢复已撤店门店 | `status='active'`；`store_id` 不变；审计 `store_reactivated` |
| C4 | MD-7 | 同一批次连续 `confirm` 两次 | 第二次不再写；门店数、审计数不变；返回同一汇总 |
| C5 | MD-7 | 两个连接同时 `confirm` | 只有一个进入 `writing`；另一个等待后看到 `completed` 或稳定冲突 |
| C6 | MD-7 | 第 3 块写入后杀进程，再 `confirm` | 批次续跑；门店与审计不重复；终态 `completed`；**前 3 块行的 `outcome` 仍是 `imported`，`summary.imported` 等于实际写入数** |
| C7 | MD-7 | 预检后人为改一行门店的经销商，再确认 | 该行 `conflict/precheck_stale`；门店字段不变；其他行正常 |
| C8 | MD-7 | 单行唯一键竞争 | 该行 `conflict/store_unique_conflict`；其他行写入；批次 `completed` |
| C9 | MD-7 | 生成 10,000 行文件确认 | 汇总与行结果聚合一致；每块提交，无长事务 |
| C10 | MD-7 | 监视确认过程 | 无网络 socket |
| C11 | MD-7 | 租约被接手后，旧进程执行下一个块 | `lease_lost`；旧进程零写入；新进程完成批次 |
| C12 | MD-7 | 注入确定性时钟使耗时超过 10 分钟 | 命令在块边界以 `time_limit_exceeded` 退出；`heartbeat_at` 清空；立即再 `confirm` 可续跑并完成 |
| C13 | MD-7 | `structure` 模式下 `update_dealer_name` 行之后，同经销商的门店行（预检为 update）再被确认 | 不被误判为 `precheck_stale`（已收敛按 `unchanged` 处理） |

### D. 结构边界与授权

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| D1 | MD-5 | `import` 模式确认含新经销商的文件 | 经销商不新建；行 `needs_superadmin`；门店不写 |
| D2 | MD-5 | `import` 模式确认含换关系的文件 | 门店经销商/板块不变；行 `needs_superadmin` |
| D3 | MD-5 | 超管 `structure` 模式确认同一文件 | 新经销商、关系写入；品牌/大区/分公司/板块数量不变 |
| D4 | MD-5 | 重复执行同一 `structure` 模式确认（新批次） | 全 `unchanged`；无第二条记录 |
| D5 | MD-5 | 执行 `bootstrap` 两次 | 第一次 3/4/42/84；第二次计数不变且全 `unchanged`；种子 CSV 中一个分公司对应两个大区时整批失败 |
| D6 | MD-5 | 非超管执行 bootstrap / `structure` 模式 / 改码 | 授权拒绝；零业务写入 |
| D7 | MD-5 | 门店改码命令 | `store_id` 不变；新码可命中；旧码不再命中；新码与同品牌其他门店冲突时返回冲突 |
| D8 | MD-9 | actor 品牌范围 `{hitachi}` 遇 `hisense` 行 | `error/brand_not_authorized`；该品牌无写入 |
| D9 | MD-9 | 未声明 `brandScope` 的服务身份启动 | 启动失败；不退化成全部品牌 |
| D10 | MD-9 | 检查 CLI 参数 | 不存在 `--skip-auth`、`--force` 等旁路 |
| D11 | MD-9 | 用范围外 actor 查询批次 | 不可见；不返回行结果 |

### E. 待确认撤店

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| E1 | MD-6 | 预检一份少了 3 家现有门店的文件 | 3 条 `store_missing_from_export` issue；门店仍 `active` |
| E2 | MD-6 | 确认时不给 `closureStoreIds` | 没有门店 `closed`；issue 仍 `open` |
| E3 | MD-6 | 勾选 3 家中 2 家 | 只有 2 家 `closed`；对应 issue `resolved`；第 3 家 `active` 且 `open` |
| E4 | MD-6 | 传一个不属于本批次待确认的门店 ID | 整条确认拒绝；批次仍 `awaiting_confirm`；零写入 |
| E5 | MD-6 | 同一批次重复计算 / 恢复重跑 | 同批次同门店 issue 不重复（指纹唯一）；不同批次各保留一条 |
| E6 | MD-6 | 已 `closed` 的门店从文件消失 | 不生成待确认项 |
| E7 | MD-5 / MD-6 | 门店改码后，用新码的文件预检 | 命中原门店（`unchanged`）；不生成待确认项 |
| E8 | MD-2 / MD-6 | 文件里某个 `active` 门店行 `撤店情况=审核失败` | 该行 `error/row_withdrawn`；门店仍 `active`；因为它在文件中出现，**不进入**待确认撤店 |
| E9 | MD-3 | 文件中分公司名称与种子写法不同、编码相同 | 按编码解析，不进入需超管处理；`reason_detail` 记 `branch_name_differs` |
| E10 | MD-6 | actor 授权 `{hitachi, hisense}`，文件只含日立行 | 海信门店不生成 issue；`pending_closure_stores` 只含日立 |
| E11 | MD-6 | 待确认数占范围内 `active` 门店超过 20% | `summary.suspect_incomplete_export=true`；CLI 提示；仍需显式勾选才关店 |
| E12 | MD-6 | 批次 A 有 3 条 open issue；批次 B 确认时：其中 1 家被关闭、1 家在 B 文件中重新出现、1 家仍缺失 | A 的三条分别 `resolved(closed_by_other_batch)`、`resolved(store_reappeared)`、`ignored(superseded_by_batch)`；B 自己为仍缺失的门店有一条 `open` |

### F. 回流与重试

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| F1 | MD-8 | 导出回流 CSV | 11 列原文 + `预检分类/结果/原因` 三列；行号对应原文件；带 BOM 的 UTF-8 |
| F2 | MD-8 | 回流只含 error / needs_superadmin / conflict | new/update/unchanged 成功行不出现 |
| F3 | MD-8 | 单元格以 `= + - @ \t \r` 开头 | 回流加 `'` 前缀 |
| F4 | MD-8 | 把回流文件（去掉三列追加列）当新文件上传 | 新批次；分类可变化；旧批次结果不变 |
| F5 | MD-8 | 停用/关闭门店后查询旧批次 | 批次、行结果仍可查 |

### G. 查询与审计

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| G1 | MD-10 | 查询批次列表 | 汇总、状态、actor、时间齐全；前五类与行结果聚合一致，`pending_closure_stores` 与 issue 聚合一致 |
| G2 | MD-10 | 查询批次详情 | 含待确认列表、回流可下载标记；不存在的批次返回稳定「未找到」 |
| G3 | MD-10 | 查询行详情 | `row_no/precheck_class/outcome/reason_code/store_id/raw_row` 齐全 |
| G4 | MD-10 | 检查输出中的 BIGINT | 全部十进制字符串；无 JS number |
| G5 | MD-10 | 确认、关店、恢复、`structure` 模式、改码、bootstrap | 各自产生审计事件；字段符合 design §7.8 |
| G6 | MD-10 | 检查审计内容 | 无文件全文、无 secret、无整行原文 |
| G7 | MD-10 | 查询命令执行前后 | 业务表无写入；无网络 |

### H. 一致性、恢复与离线

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| H1 | MD-12 | 并发插入同一 `(brand_id, store_code)` | 一条成功，一条稳定冲突；无死锁 |
| H2 | MD-12 | 同一批次重复确认 | 行结果、issue、门店无重复 |
| H3 | MD-12 | 并发关闭同一门店 | 只一个 `closed` 终态、一条 `store_closed` |
| H4 | MD-12 | 检查 DDL | 组织主档与批次无 `ON DELETE CASCADE`；`stores.source_batch_id` 有外键 |
| H5 | MD-11 | 测试进程启动 | 网络 socket 被禁止；任何外联失败（沿用 `tests/harness/setup.ts`） |
| H6 | MD-11 | 同一 fixture 连跑 3 次 | 结果一致 |
| H7 | MD-11 | 空库 `migrate` 两次 | 第一次成功，第二次无变更；`drizzle-kit generate` 不产生新文件 |
| H8 | MD-11 | 测试库命名与清理 | 以 `_test` 结尾；结束后容器/库清理 |
| H9 | MD-11 | 全量 acceptance | 不读取 AI Master secret，不连 OSS，无付费调用 |
| H10 | MD-7 / MD-11 | 生成 10,000 行 fixture | 在 10 分钟内完成；耗时与内存记录在案（见手工项 M3） |
| H11 | MD-1 / MD-11 | 运行时直接调用 `new TextDecoder('gb18030', {fatal:true})` | 不抛 `RangeError`；GB18030 文件可解码 |
| H12 | MD-5 / MD-12 | 导入表与共享列检查 | `import_batches` 仍有 `new_rows/skipped_rows/error_rows/conflict_rows`；`precheck_class` 允许 NULL；名单导入式行（`precheck_class` 为空）可写入 |

## 手工项

| # | 需求 | 谁看 | 看什么 | 检查什么 |
|---|---|---|---|---|
| M1 | MD-1 / MD-8 | 数据运营 | 预检报告与回流 CSV（CLI 输出或导出文件） | 六类名称与业务说法一致；原因能让人知道下一步；GB18030 与 UTF-8 都能在 Excel 正常打开；回流文件直接双击不乱码 |
| M2 | MD-6 | 数据运营 / 超管 | 待确认撤店列表 | 消失门店与导出范围变化能区分；勾选关店后列表状态正确；「疑似导出不完整」提示容易看懂 |
| M3 | MD-7 / MD-11 | 实施者 | 测试机上的 10,000 行运行记录 | 耗时、内存、批次数、失败行数写进 design §12；超过 10 分钟则停下来问 |
| M4 | MD-10 | 超管 / 实施者 | 审计日志 | 确认、关店、结构变更各有一条；actor 与目标可读；无敏感内容 |
| M5 | MD-5 | 超管 | `bootstrap` 输出与组织表 | 42 个分公司、84 个板块、4 个大区、3 个品牌与种子一致 |
| M6 | MD-1…MD-7 | 实施者 + 数据运营 | 本机用真实文件演练：把 `最终的权威信息.xlsx`（本地，被 `.gitignore` 排除，不提交）的「门店信息数据」sheet 删去「负责人」列后另存为 CSV，在一次性测试库上跑 | 空库 + bootstrap 后：`import` 模式预检 = `needs_superadmin/dealer_not_found` 8,315 行 + `error/dealer_code_missing` 12 行；`structure` 模式预检 = `new` 8,315 行 + `error` 12 行，`pending_closure_stores=0`；`structure` 模式确认后 `stores=8,315`、`dealers=5,275`；再传同一文件，8,315 行全 `unchanged`；回流文件正好 12 行 |

## 环境项

| # | 需求 | 依赖 | 当前状态 |
|---|---|---|---|
| ENV-1 | MD-7 | 测试机一次性 MySQL 容器 | 已完成（2026-11-05）：112 个数据库用例通过；10,000 行预检 564 ms、确认 6.9 s、RSS 277 MB |
| ENV-2 | MD-5 | 测试机上的真实 42 行种子 | 已完成（2026-11-05）：3 / 4 / 42 / 84，重跑全部 unchanged |

## 覆盖不了

- **F5 路径 1 页面**：归属见 design §15；本轮只验收 CLI；页面验收在页面开工条件满足后增加。
- **真实用户认证与 DataScope 组织范围**：B 域未实现；本 spec 只验证服务身份与品牌集合，组织范围求交未覆盖。
- **下一期真实导出的变化**：只有一份真实样本（M6 本地演练）；新经销商比例、门店增减幅度、20% 疑似不完整阈值是否合适，要等几期真实导入后校准。
- **B 域持久化审计**：pre-B 只写应用日志；「仅超管可查、保留一年」未覆盖；bootstrap 与门店改码没有批次，日志之外无持久记录。
- **10,000 行在目标生产硬件上的性能**：只在测试机测量；生产 ECS 不跑测试。
- **文件级失败的可查询审计**：文件级失败不建批次，只有应用日志，不在数据库。
- **门店编码大小写语义的真实性**：按字节精确比较、不折叠大小写；若现实存在需要折叠的重码，需先改 ADR-0008 再加生成列，本验收不覆盖。
- **多用户并发上传同一文件**：只覆盖同一批次并发确认，不覆盖两个批次同时写同一门店的完整竞争矩阵。
- **门店数增长到接近 10,000 行**：当前 8,327 行；上限修订见 design §14 第 6 项。
