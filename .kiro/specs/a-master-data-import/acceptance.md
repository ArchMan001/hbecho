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
> **最近核对**：2026-11-04
>
> **更新日期**：2026-11-04（初建）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出或表格软件中看，写明谁看、看什么、检查什么。
- `[环境]`：依赖测试机或真实数据，不能在本机离线判定；标明当前状态。
- 每条对应 requirements 的 `MD-n`；没有「看一眼就行」的条目。

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
| A9 | MD-2 | 预检一份含六类的文件 | 业务表 `updated_at` 与行数不变；批次 `awaiting_confirm` |
| A10 | MD-2 | 检查行结果 | 每数据行恰好一条；`row_no` 连续；`raw_row` 11 列原文 |
| A11 | MD-2 | 聚合分类计数 | 五类行分类之和 = 数据行数；`pending_closure_stores` 单列且等于 issue 数；`error` / `needs_superadmin` 都有 `reason_code` |
| A12 | MD-2 | 同一文件连续预检两次 | 两个批次；分类与行号一致；无业务写入 |

### B. 映射与分类

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| B1 | MD-3 | 主营业务编码 `13/15/23/25/33` | 品牌与板块分别为 日立-家装 / 日立-水机 / 海信-家装 / 海信-水机 / 约克VRF-家装 |
| B2 | MD-3 | `013`、`13.0`、`13 `、全角 `１３`、空值 | 全部 `error/main_business_code_unmapped`；不回落默认品牌 |
| B3 | MD-3 | 42 个分公司编码 | 全部命中种子并解析到大区 |
| B4 | MD-3 | 未知分公司编码 | `error/branch_code_unmapped`；不新建分公司 |
| B5 | MD-3 | 科龙 / 中小门店类型编码 | `error`；不归入日立或家装 |
| B6 | MD-3 | `撤店情况=已撤销`、`是否数字门店=是` | 分别 `error/row_withdrawn`、`error/row_digital_store` |
| B7 | MD-3 | 经销商编码为 `--` / `#N/A`；另有空值一行 | `error/dealer_code_missing`；空值行按优先级先命中 `error/missing_required_field`；都不静默丢弃 |
| B8 | MD-4 | 文件内同一 `(brand, store_code)` 出现两行，仅大小写或空格不同 | 两行都 `error/duplicate_store_code_in_file` |
| B9 | MD-4 | 门店已存在、名称与等级相同 | `unchanged` |
| B10 | MD-4 | 门店已存在、名称或等级不同 | `update/store_fields_changed` |
| B11 | MD-4 | 门店已存在但 `status='closed'`，本行合法 | `update/reactivate_store` |
| B12 | MD-4 | 门店已存在、经销商或板块不同 | `needs_superadmin/store_relation_change` |
| B13 | MD-4 | 门店不存在、结构齐全 | `new` |
| B14 | MD-4 | 门店不存在且经销商或板块缺失 | `needs_superadmin`，不标 `new` |
| B15 | MD-3 | 品牌 / 分公司 / 板块 / 经销商 `status='inactive'` | 分别 `needs_superadmin` 且 reason 为 `brand_inactive` / `branch_inactive` / `sector_inactive` / `dealer_inactive` |
| B16 | MD-5 | `structure` 模式遇到 `dealer_inactive` / `sector_inactive` | 分别 `update/activate_dealer`、`update/activate_sector`；品牌与分公司停用仍 Q |

### C. 确认写入

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| C1 | MD-7 | 确认一个含 new/update/unchanged 的批次 | 批次 `completed`；新门店存在；改名/改级生效；`unchanged` 行不改 `updated_at`/`source_batch_id` |
| C2 | MD-7 | 检查新建门店 | `source_batch_id` 等于本批次；`store_id` 为新生成 |
| C3 | MD-7 | 恢复已撤店门店 | `status='active'`；`store_id` 不变；审计 `store_reactivated` |
| C4 | MD-7 | 同一批次连续 `confirm` 两次 | 第二次不再写；门店数、审计数不变；返回同一汇总 |
| C5 | MD-7 | 两个连接同时 `confirm` | 只有一个进入 `writing`；另一个等待后看到 `completed` 或稳定冲突 |
| C6 | MD-7 | 第 3 块写入后杀进程，再 `confirm` | 批次恢复；门店与审计不重复；终态 `completed` |
| C7 | MD-7 | 预检后人为改一行门店的经销商，再确认 | 该行 `conflict/precheck_stale`；门店字段不变；其他行正常 |
| C8 | MD-7 | 单行唯一键竞争 | 该行 `conflict`；其他行写入；批次 `completed` |
| C9 | MD-7 | 10,000 行文件确认 | 六类计数与行结果一致；无长事务（每块提交） |
| C10 | MD-7 | 监视确认过程 | 无网络 socket |

### D. 结构边界与授权

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| D1 | MD-5 | `import` 模式确认含新经销商的文件 | 经销商不新建；行 `needs_superadmin`；门店不写 |
| D2 | MD-5 | `import` 模式确认含换关系的文件 | 门店经销商/板块不变；行 `needs_superadmin` |
| D3 | MD-5 | 超管 `structure` 模式确认同一文件 | 新经销商、板块、关系写入；品牌/大区/分公司数量不变 |
| D4 | MD-5 | 重复执行同一结构命令 | `unchanged`；无第二条记录 |
| D5 | MD-5 | 执行 `bootstrap` 两次 | 第一次 3/4/42/84；第二次计数不变且全 `unchanged` |
| D6 | MD-5 | 非超管执行结构命令 / `structure` 模式 | 授权拒绝；零业务写入 |
| D7 | MD-5 | 门店改码命令 | `store_id` 不变；新码可命中；旧码不再命中 |
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
| E4 | MD-6 | 传一个不属于本批次待确认的门店 ID | 整条确认拒绝；零写入 |
| E5 | MD-6 | 同一批次重复计算 / 恢复重跑 | 同批次同门店 issue 不重复（指纹唯一）；不同批次各保留一条 |
| E6 | MD-6 | 已 `closed` 的门店从文件消失 | 不生成待确认项 |
| E7 | MD-6 | 门店改码 | 不生成待确认项；按新码匹配 |
| E8 | MD-2 / MD-6 | 文件里某个 `active` 门店 `撤店情况=已撤销` | 该行 `error/row_withdrawn`；门店不自动 `closed`；**进入待确认**（`store_marked_withdrawn`），勾选后才关闭 |
| E9 | MD-3 | 文件中分公司名称与种子写法不同、编码相同 | 按编码解析，不进入需超管处理；`reason_detail` 记 `branch_name_differs` |

### F. 回流与重试

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| F1 | MD-8 | 导出回流 CSV | 11 列原文 + `预检分类/结果/原因` 三列；行号对应原文件 |
| F2 | MD-8 | 回流只含 error / needs_superadmin / conflict | new/update/unchanged 成功行不出现 |
| F3 | MD-8 | 单元格以 `= + - @ \t \r` 开头 | 回流加 `'` 前缀；重新导入保留原文 |
| F4 | MD-8 | 把回流文件当新文件上传 | 新批次；分类可变化；旧批次结果不变 |
| F5 | MD-8 | 停用/关闭门店后查询旧批次 | 批次、行结果仍可查 |

### G. 查询与审计

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| G1 | MD-10 | 查询批次列表 | 六类计数、状态、actor、时间齐全；前五类与行结果聚合一致，`pending_closure_stores` 与 issue 聚合一致 |
| G2 | MD-10 | 查询批次详情 | 含待确认列表、回流可下载标记；不存在的批次返回稳定「未找到」 |
| G3 | MD-10 | 查询行详情 | `row_no/precheck_class/outcome/reason_code/store_id/raw_row` 齐全 |
| G4 | MD-10 | 检查输出中的 BIGINT | 全部十进制字符串；无 JS number |
| G5 | MD-10 | 确认、关店、恢复、结构命令、bootstrap | 各自产生审计事件；字段符合 design §7.8 |
| G6 | MD-10 | 检查审计内容 | 无文件全文、无 secret、无整行原文 |
| G7 | MD-10 | 查询命令执行前后 | 业务表无写入；无网络 |

### H. 一致性、恢复与离线

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| H1 | MD-12 | 并发插入同一 `(brand_id, store_code_match)` | 一条成功，一条稳定冲突 |
| H2 | MD-12 | 同一批次重复确认 | 行结果、issue、门店无重复 |
| H3 | MD-12 | 并发关闭同一门店 | 只一个 `closed` 终态、一条 `store_closed` |
| H4 | MD-12 | 检查 DDL | 组织主档与批次无 `ON DELETE CASCADE` |
| H5 | MD-11 | 测试进程启动 | 网络 socket 被禁止；任何外联失败 |
| H6 | MD-11 | 同一 fixture 连跑 3 次 | 结果一致 |
| H7 | MD-11 | 空库 `migrate` 两次 | 第一次成功，第二次无变更 |
| H8 | MD-11 | 测试库命名与清理 | 以 `_test` 结尾；结束后容器/库清理 |
| H9 | MD-11 | 全量 acceptance | 不读取 AI Master secret，不连 OSS，无付费调用 |
| H10 | MD-7 / MD-11 | 10,000 行 fixture | 在 10 分钟内完成；耗时与内存记录在案（见手工项 M3） |
| H11 | MD-1 / MD-11 | 运行时直接调用 `new TextDecoder('gb18030', {fatal:true})` | 不抛 `RangeError`；GB18030 文件可解码（full-icu 可用） |

## 手工项

| # | 需求 | 谁看 | 看什么 | 检查什么 |
|---|---|---|---|---|
| M1 | MD-1 / MD-8 | 数据运营 | 预检报告与回流 CSV（CLI 输出或导出文件） | 六类名称与业务说法一致；原因能让人知道下一步；GB18030 与 UTF-8 都能在 Excel 正常打开 |
| M2 | MD-6 | 数据运营 / 超管 | 待确认撤店列表 | 消失门店与导出范围变化能区分；勾选关店后列表状态正确 |
| M3 | MD-7 / MD-11 | 实施者 | 测试机上的 10,000 行运行记录 | 耗时、内存、批次数、失败行数写进 design §12；超过 10 分钟则停下来问 |
| M4 | MD-10 | 超管 / 实施者 | 审计日志 | 确认、关店、结构变更各有一条；actor 与目标可读；无敏感内容 |
| M5 | MD-5 | 超管 | `bootstrap` 输出与组织表 | 42 个分公司、84 个板块、4 个大区、3 个品牌与种子一致 |

## 环境项

| # | 需求 | 依赖 | 当前状态 |
|---|---|---|---|
| ENV-1 | MD-7 | 测试机一次性 MySQL 容器 | 未开始；任务 8 在测试机运行并记录 |
| ENV-2 | MD-5 | 测试机上的真实 42 行种子 | 种子文件在仓库；尚未在测试机跑 bootstrap |

## 覆盖不了

- **F5 路径 1 页面**：归本 spec，但本轮只验收 CLI；页面验收在 UI 基线定稿、补齐 design §15 后增加。
- **真实用户认证与 DataScope 组织范围**：B 域未实现；本 spec 只验证服务身份与品牌集合，组织范围求交未覆盖。
- **真实权威导出的分布**：仓库里没有生产导出样本；编码、大小写、空值分布只能等首次真实导入验证。
- **B 域持久化审计**：pre-B 只写应用日志；「仅超管可查、保留一年」未覆盖。
- **10,000 行在目标生产硬件上的性能**：只在测试机测量；生产 ECS 不跑测试。
- **文件级失败的可查询审计**：文件级失败不建批次，只有应用日志，不在数据库。
- **门店编码大小写语义的真实性**：按 ADR-0008 使用 `LOWER(TRIM())`；若现实存在大小写区分的两家门店，需先改 ADR，本验收不覆盖该反例。
- **多用户并发上传同一文件**：只覆盖同一批次并发确认，不覆盖两个批次同时写同一门店的完整竞争矩阵。