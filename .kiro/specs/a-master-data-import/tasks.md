# A 主数据导入（a-master-data-import）· 实施计划

> **状态**：`draft`
>
> **执行状态**：任务 0–8 已实现并推送分支 `a-master-data-import`，本机 `./scripts/verify.sh` 与 CI 通过，测试 ECS 上的运行已做（2026-11-05）；未合并；人工项 M1/M2/M4/M5 待业务/超管，见文末「实施记录」
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-import`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.10（2026-11-04，定稿候选）
>
> **最近核对**：2026-11-05
>
> **更新日期**：2026-11-05（审查修订：贴合已落地的 tracer 代码与测试布局；任务 0 增列名订正与待确认闸门；任务 5/6/7/8 随设计收窄）

## 进度

- [x] 任务 0 · 文档前置（v2 修订、列名订正、ADR-0014、INDEX、待确认闸门）
- [x] 任务 1 · schema 与迁移
- [x] 任务 2 · bootstrap 与组织种子
- [x] 任务 3 · 文件解析、映射与预检
- [x] 任务 4 · `import` 模式确认写入
- [x] 任务 5 · 待确认撤店、issue 收敛与审计
- [x] 任务 6 · `structure` 模式与门店改码
- [x] 任务 7 · 查询与回流
- [x] 任务 8 · 全量离线验收、限额与本地真实文件演练
- [x] ENV-1 · 测试 ECS 上的 10,000 行运行（2026-11-05：预检 564 ms，确认 6.9 s，RSS 277 MB；见文末「实施记录」）
- [ ] 人工验收 M1 / M2 / M4 / M5（需要业务或超管看，清单见 acceptance）

## Planning rules

- 每个任务是一个纵向切片：完成后应能运行一条命令、看到可验证的结果，而不是只建空表或空 Interface。
- 任务边界跑 `./scripts/verify.sh`（已覆盖 typecheck、单元测试、迁移一致、数据库测试、密钥与文档检查）。
- 默认验收离线：不连 AI Master、不连 OSS、不发起任何外网请求；MySQL 只用 `scripts/with-test-mysql.sh` 的一次性容器或 `_test` 库。
- 目录按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md) 与现有布局：领域代码在 `src/modules/master-data-import/`，测试与源码同目录（纯函数 `*.test.ts`，需要 MySQL 的 `*.db.test.ts`，对应 vitest 的 `unit` / `db` project），迁移在 `drizzle/`，CLI 在 `src/worker/`，fixture 在 `tests/fixtures/master-data/`，测试设施复用 `tests/harness/`。
- 不新增未登记的依赖；`csv-parse` 必须先经 ADR-0014 接受；GB18030 解码用 ADR-0005 已定的 Node `TextDecoder`，不引入 iconv-lite。
- 所有内部 BIGINT 在 CLI/JSON 输出为十进制字符串；外部编码保留原文。
- 任务 0 未完成前不写迁移；v2 修订未落回正文前不写 SQL。
- fixture 一律脱敏造数；真实文件 `最终的权威信息.xlsx` 只在本机做 M6 演练，不提交、不复制进仓库。

## 依赖图

```text
任务 0（v2 修订 + 列名订正 + ADR-0014 + INDEX + 待确认闸门）
   ↓
任务 1（schema / 迁移）
   ├──→ 任务 2（bootstrap + 组织种子）
   │        ↓
   └──→ 任务 3（文件解析 + 预检） ←── 任务 2
            ↓
         任务 4（import 模式确认写入）
            ├──→ 任务 5（待确认撤店 + 审计）
            └──→ 任务 6（structure 模式 + 门店改码）
                     ↓
                  任务 7（查询 + 回流）
                     ↓
                  任务 8（全量离线验收 + 限额 + 本地真实文件演练）
```

容易画错的边：

- 任务 3 **不依赖**任务 6：预检的 Q 行只读结构，不需要 `structure` 模式已实现；
- 任务 4 **不依赖**任务 5：确认写入先处理门店 upsert，待确认撤店是独立选择项；
- 任务 6 依赖任务 4 的确认管线，但**不重写**它；结构动作挂在同一行的保存点内；
- 任务 7 的回流文件内容依赖任务 4 的 `outcome`，所以排在 4 之后，不和 3 并行。

## 任务 0 · 文档前置：v2 修订、列名订正、ADR-0014、INDEX 登记、待确认闸门

- [x] **任务 0 已完成**（2026-11-05；本机 `verify.sh` 通过）

**目标**：让后面的代码有合法的基线，不让实现偷偷定义列或依赖。

**动作**

- 在 [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) 落回 design §6.2 的 R1–R6：
  - R1：`import_row_results.precheck_class`（可空，CHECK）、`outcome` 可空；
  - R2：`import_batches.summary`、`writing_token`、`heartbeat_at`（不删现有四个计数列）；
  - R3：三个 actor 字段，`*_user_id` 改可空；
  - R4：`data_quality_issues.import_batch_id`（FK）、`resolved_by_actor`、两种批次引用互斥 CHECK；
  - R5：§12.1 同步（列名、撤店情况只会是「无撤销」、六类、已撤店恢复、结构边界）；
  - R6：`stores.source_batch_id` 外键。
- 订正列名「经销商名称 / 经销商编码」→「门店所属商家 / 门店所属商家渠道编码」：A 域 PRD §4.2 第 196 行、v2 §12.1 第 924 行（只改这两处文字，其余引用处按搜索结果补）；F 域 PRD 若出现同一列名一并订正。PRD 改动补版本记录。
- ✅ 已完成（2026-11-05）：`HBECHO设计方案/architecture/adr/0014-csv-parser-dependency.md` accepted，采用 `csv-parse`（⭐ 4,288，MIT）；同日 steering `no-reinventing-wheels` 第 6 级星标线由 5,000 下调为 3,000，不再有例外。
- ✅ 已完成（2026-11-05）：INDEX 的本 spec 描述与 ADR 索引已更新；路线图顺序不变（本 spec 仍是第 2 位）。
- ✅ 已完成（2026-11-05）：v2 R1–R6 落回正文（header 修订项 15–18、§9.7、§9.8、§9.9、§12.1；R6 的外键 v2 §7.6 本来就写了，是代码补）；A 域 PRD 升 v1.10.1、F 域 PRD 升 v1.0.2，列名订正并补版本记录。
- ✅ **待确认闸门已通过**（2026-11-05）：requirements §1.4 第 6、14、15 项与 design §13 MD-D18，刘学奎在审阅我的意见后指示按计划执行任务 1–8，按「同意」记录。
- 任务 0 收尾：跑一次 `./scripts/verify.sh`（任务 1 开工前）。

**验证**

- [x] `./scripts/verify.sh` 通过；
- [x] v2 修订逐条与 design §6.2 对应，没有多改或少改；
- [x] ADR-0014 状态 `accepted`，有决策人与日期（已满足）；
- [x] 全仓库搜索「经销商名称、经销商编码」，除历史归档外没有旧的 11 列写法（已满足）。

**Requirements:** 全部；**Design:** §6.2、§10。

## 任务 1 · schema 与迁移

- [x] **任务 1 已完成**（2026-11-05；本机 `verify.sh` 通过）

**目标**：空库一次迁移成功，导入表存在，约束能挡住重复与非法状态。

**新增/修改**

- `src/db/schema/import.ts`：`import_batches`、`import_row_results`（含 R1–R3）；
- `src/db/schema/org.ts`：`stores.source_batch_id` 补外键（R6，替换现有「暂不挂外键」注释）；
- `src/db/schema/sync.ts`：`data_quality_issues` 补 `import_batch_id`、`resolved_by_actor` 与互斥 CHECK（R4）；
- 在 schema 汇总导出处登记新表；
- `drizzle/`：`drizzle-kit generate` 生成的迁移 SQL + 手写 CHECK/外键（登记 ADR-0005 已知坑）；
- `src/db/repositories/` 或 `src/modules/master-data-import/` 内的受限写过程：门店插入（先 INSERT，捕获 1062）、批次锁与租约、行结果批量写；
- `src/db/schema.db.test.ts` 同层补 `master-data-schema.db.test.ts`。

**行为**

- 迁移可重复执行（第二次为空操作）；
- `import_row_results.precheck_class` 只接受五个值或 NULL，`outcome` 允许 NULL；
- `import_batches` 状态只接受六个值；现有四个计数列仍在；
- `data_quality_issues` 的两种批次引用不得同时非空；
- 所有指向组织主档/批次的外键不使用 `ON DELETE CASCADE`。

**验证**

- [x] 空库 `migrate` → 成功；再跑一次 → 成功且无变更；`drizzle-kit generate` 不产生新文件；
- [x] 插入重复 `(brand_id, store_code)` 只有一条成功；
- [x] 插入非法 `precheck_class` / status 被 CHECK 拒绝；`precheck_class` 为 NULL 的行（名单导入式）可写入；
- [x] 两种批次引用同时非空被 CHECK 拒绝；
- [x] `./scripts/verify.sh` 通过。

**Requirements:** MD-12；**Design:** §6.1–§6.4。

## 任务 2 · bootstrap 与组织种子

- [x] **任务 2 已完成**（2026-11-05；本机 `verify.sh` 通过）

**目标**：一条命令建立 3 个品牌、4 个大区、42 个分公司、84 个板块；重复执行全部 `unchanged`。

**新增/修改**

- `src/modules/master-data-import/bootstrap.ts`：种子读取与 upsert；
- `src/modules/master-data-import/mappings.v1.ts`：品牌/板块常量与种子解析；
- `src/worker/master-data-cli.ts`：新 CLI 入口（沿用 `cli.ts` 的 `runCli` + JSON 输出 + 退出码约定）与 `bootstrap` 子命令；`package.json` 增加 `master-data` script；
- 同目录 `bootstrap.test.ts`、`mappings.test.ts`、`bootstrap.db.test.ts`。

**行为**

- 读取 [`分公司-大区对照.csv`](../../../HBECHO设计方案/domains/data-foundation/seed/分公司-大区对照.csv)；
- 品牌：`hitachi/日立`、`hisense/海信`、`york_vrf/约克VRF`；
- 大区：CSV 去重 4 个；分公司：42 个，逐个挂到大区；
- 板块：每个分公司 `water/水机`、`home/家装`，编码 `{branch_code}-water` / `-home`；
- 一个事务；重复执行 `unchanged`；自然键存在但字段不同 → `conflict`，不覆盖；
- 审计事件 `bootstrap_completed`，含四类计数。

**验证**

- [x] 空库跑一次：`brands=3`、`regions=4`、`branches=42`、`sectors=84`；
- [x] 再跑一次：计数不变，全部 `unchanged`；
- [x] 种子 CSV 中一个分公司对应两个大区时整批失败（种子损坏负例）；
- [x] 非超管 actor 调用被拒绝，库中无写入。

**Requirements:** MD-5、MD-9；**Design:** §7.2、§7.7。

## 任务 3 · 文件解析、映射与预检

- [x] **任务 3 已完成**（2026-11-05；本机 `verify.sh` 通过）

**前置：任务 0 的待确认闸门已通过（2026-11-05）。**

**目标**：`precheck` 对一份文件给出六类报告、行结果与待确认撤店清单，业务表零写入。

**新增/修改**

- `src/modules/master-data-import/file-parser.ts`：编码判定、CSV 解析、11 列表头、限额；
- `src/modules/master-data-import/precheck.ts`：分类优先级（design §7.3 的 22 步）、映射、范围、文件内重复与经销商名称冲突、结构解析；
- `src/modules/master-data-import/closure.ts`：待确认撤店的识别（范围 = 文件中出现的品牌、疑似不完整提示）与 issue 写入（只识别，不关店）；
- `src/modules/master-data-import/index.ts`：Module 导出；
- `src/worker/master-data-cli.ts`：`precheck --file --mode import|structure`；
- `tests/fixtures/master-data/*.csv`（脱敏造数）；
- 同目录 `file-parser.test.ts`（含 `TextDecoder('gb18030', {fatal:true})` 可用性测试）、`precheck.test.ts`、`precheck.db.test.ts`。

**行为**

- 文件级失败不建批次、不写行；
- 通过后建批次、写行原文与 `precheck_class`、写 `summary`、写待确认 issue；
- `structure` 模式按 design §7.4 调整经销商与关系类分类，但**不写结构**（写入在任务 6）；
- 预检结束批次为 `awaiting_confirm`；
- 业务表零写入。

**验证**

- [x] UTF-8 与 GB18030 同内容产生相同结果；12 列（带「负责人」）与旧列名文件被整批拒绝；
- [x] 六类各至少一个 fixture，`summary` 与行结果聚合一致；
- [x] 映射未命中、跨品牌、范围外品牌、结构缺失、重复门店编码、经销商名称冲突、已撤店恢复各自分类正确；
- [x] 只含一个品牌的文件不会为其他品牌生成待确认；
- [x] 预检前后 `stores/dealers/sectors/branches` 的 `updated_at` 与行数不变；
- [x] 同一文件重复预检产生两个批次，分类一致。

**Requirements:** MD-1、MD-2、MD-3、MD-4（预检部分）、MD-6（识别部分）、MD-9、MD-10（部分）；**Design:** §7.1–§7.5。

## 任务 4 · `import` 模式确认写入

- [x] **任务 4 已完成**（2026-11-05；本机 `verify.sh` 通过）

**目标**：确认一个批次，门店按 `(brand_id, store_code)` upsert；重跑、续跑与租约接手不产生重复事实、不改写已有结果。

**新增/修改**

- `src/modules/master-data-import/confirm.ts`：批次锁与租约（`writing_token`、`heartbeat_at`）、分块事务、逐行重校验、保存点、续跑、超时停止；
- `src/modules/master-data-import/authorization.ts`：1.0 服务身份策略与 `assertAllowed`；
- `src/modules/master-data-import/audit.ts`：`audit(event)` 与 pino 日志实现（任务 5 之前可先接内存 sink）；
- `src/worker/master-data-cli.ts`：`confirm --batch [--close-store ID]...`；
- 同目录 `confirm.db.test.ts`、`recovery.db.test.ts`。

**行为**

- 批次 `awaiting_confirm` → `writing` → `completed`；
- `new` 先 INSERT 建门店，1062 记 `conflict`；`update` 改名称/等级、恢复 `closed`；`unchanged` 不写；
- 预检后事实变化 → `conflict/precheck_stale`；
- 同批次并发确认只有一个写入者；
- 进程中断后重跑，只处理 `outcome IS NULL` 的行，已有 `imported` 不被改写；
- 租约陈旧（心跳 > 2 分钟）可接手；旧进程下一个块 `lease_lost` 退出；
- 总耗时 > 10 分钟在块边界以 `time_limit_exceeded` 退出且可续跑；
- 品牌范围过滤；
- 批次完成写 `import_confirmed` 审计事件与 `summary` 确认部分。

**验证**

- [x] 生成 10,000 行 fixture 在本机和测试 ECS 上完成确认，汇总与行结果一致；
- [x] 改名 / 改级 / 恢复已撤店各自生效，`store_id` 不变；
- [x] 中断恢复后门店数、审计数不重复，前几块行的 `outcome` 仍为 `imported`；
- [x] 并发确认只有一个成功进入 `writing`；
- [x] 租约被接手后旧进程零写入；
- [x] 跨品牌行不写；
- [x] 写入期间无网络。

**Requirements:** MD-4、MD-7、MD-9、MD-12；**Design:** §7.6、§9。

## 任务 5 · 待确认撤店确认、issue 收敛与审计

- [x] **任务 5 已完成**（2026-11-05；本机 `verify.sh` 通过）

**目标**：消失门店只生成 issue；确认关店才 `closed`；旧批次遗留 issue 不永远 `open`；恢复与关店都有审计。

**新增/修改**

- `src/modules/master-data-import/closure.ts`：确认关店、issue 解决与收敛（`closed_by_other_batch` / `store_reappeared` / `superseded_by_batch`）、恢复；
- `src/worker/master-data-cli.ts`：`--close-store` 参数；待确认列表并入 `batch` 详情；
- 同目录 `closure.db.test.ts`、`audit.test.ts`。

**行为**

- 确认时只关闭 `closureStoreIds` 中、且属于本批次 issue 的门店；
- 不在列表中的 ID → 整条命令在进入 `writing` 前拒绝；
- 关店写 `store_closed`；恢复写 `store_reactivated`；
- 未勾选的门店保持 active、issue 保持 open；
- 确认完成时按 design §7.5 收敛其他批次遗留 issue；
- 审计事件不含整行原文与文件内容。

**验证**

- [x] 预检不关任何店；
- [x] 勾选 3 中 2，只有 2 家 closed，issue 状态对应；
- [x] 非法 store ID 使整条确认拒绝，零写入；
- [x] 恢复已撤店后审计事件存在，`store_id` 不变；
- [x] 旧批次 issue 三种收敛各一例；
- [x] 审计日志字段与 design §7.8 一致。

**Requirements:** MD-6、MD-10；**Design:** §7.5、§7.8。

## 任务 6 · `structure` 模式与门店改码

- [x] **任务 6 已完成**（2026-11-05；本机 `verify.sh` 通过）

**目标**：超管能把 Q 行中的经销商与关系变更写入；能给单个门店改码。

**新增/修改**

- `src/modules/master-data-import/structure.ts`：`MasterDataStructure.changeStoreCode`；与 bootstrap（任务 2）同一 Module；
- `src/modules/master-data-import/confirm.ts`：`structure` 模式的保存点分支（`create_dealer`、`activate_dealer`、`update_dealer_name`、`change_store_relation`；不重写 import 流程）；
- `src/worker/master-data-cli.ts`：`store change-code --store-id --new-code`；
- 同目录 `structure.test.ts`、`structure-mode.db.test.ts`。

**行为**

- `structure` 模式确认：新建经销商、更新经销商名与启用、换门店关系；不创建品牌、大区、分公司、板块；
- 同一经销商被多行引用时，后一行复用前一行已建的经销商；
- 所有动作自然键幂等；重复相同值 `unchanged`；
- 门店改码：`store_id` 不变，新码冲突返回冲突；
- 非超管拒绝；审计 `structure_changed`。

**验证**

- [x] 同一文件先 `import` 模式确认：结构类行全部 Q，结构表不变；
- [x] 再以 `structure` 模式确认：经销商/关系写入，品牌/大区/分公司/板块数量不变；
- [x] `update_dealer_name` 行之后的同经销商门店行不被误判 `precheck_stale`；
- [x] 门店改码后 `store_id` 不变，旧码不再命中；
- [x] 非超管调用零写入。

**Requirements:** MD-5、MD-9、MD-10；**Design:** §7.4、§7.7。

## 任务 7 · 查询与回流

- [x] **任务 7 已完成**（2026-11-05；本机 `verify.sh` 通过）

**目标**：批次列表、批次详情、行详情、回流 CSV 可用，BIGINT 为十进制字符串。

**新增/修改**

- `src/modules/master-data-import/query.ts`：`ImportBatchQuery`，含 `returnFile`（回流 CSV、BOM、公式注入前缀）；
- `src/worker/master-data-cli.ts`：`batches`、`batch`、`rows`、`report`；
- 同目录 `query.db.test.ts`、`return-file.test.ts`。

**行为**

- 范围过滤按 actor 品牌；
- 汇总来自 `summary`，并与行结果聚合一致；
- 回流列 = 原 11 列 + `预检分类`、`结果`、`原因`；
- 单元格以 `= + - @ \t \r` 开头时加 `'`；
- 回流文件为带 BOM 的 UTF-8；
- 不存在的批次返回稳定「未找到」。

**验证**

- [x] 批次列表 / 详情 / 行详情字段与 design 一致；
- [x] 回流 CSV 带 BOM、公式前缀生效（用 Excel 实际打开由业务验，见验收 M1，未勾）；
- [x] 范围外批次不可见；
- [x] 查询不产生写入，不触发网络。

**Requirements:** MD-8、MD-10；**Design:** §7.8、§8。

## 任务 8 · 全量离线验收、限额与本地真实文件演练

- [x] **任务 8 已完成**（2026-11-05；本机 `verify.sh` 通过，测试 ECS 运行通过）

**目标**：acceptance.md 的全部自动项可一条命令跑完；本机用真实文件演练一遍。

**新增/修改**

- `src/modules/master-data-import/acceptance.db.test.ts`：覆盖 acceptance 自动项里前面任务尚未覆盖的条目；
- 10,000 行性能测量：生成 fixture 的脚本或测试，在测试机运行（经 Workbench，按 `server-access.md`；测试机一次性库，用完清理），结果回填 design §12；
- `HBECHO设计方案/runbooks/dev-test-deploy-workflow.md`：补一行本机验证命令与测试机运行方式（如已有章节）；
- 不新增禁网设施（`tests/harness/setup.ts` 已提供）；`scripts/verify.sh` 已覆盖，不改入口。

**验证**

- [x] `./scripts/verify.sh` 通过；
- [x] 全部自动验收通过；
- [x] 10,000 行在测试机的耗时、内存、批次数记录在案（见文末「实施记录」）；
- [x] 手工项 M6：本机用真实文件在一次性测试库上演练，数字与 acceptance 一致（8,315 / 12 / 5,275）；
- [x] 空库迁移 + bootstrap + 预检 + 确认 + 查询 + 回流一条龙可重复。

**Requirements:** MD-11 及全部；**Design:** §11、§12。

## 对已有代码与测试的改动（实施时登记）

| 任务 | 可能触到的既有文件 | 说明 |
|---|---|---|
| 0 | `HBECHO设计方案/domains/data-foundation/database-design-v2.md`、`prd-domain-a-data-foundation.md`、`INDEX.md`、新增 ADR-0014 | 只改基线与登记，不改代码 |
| 1 | `src/db/schema/org.ts`、`src/db/schema/sync.ts`、`drizzle/*`、schema 汇总导出 | 补 FK / 补列；不改 tracer 已有列语义 |
| 2、3 | `package.json`（`master-data` script、`csv-parse`） | 新增；不改 tracer 的 script |
| 3 | `src/worker/` 新增 `master-data-cli.ts` | 新增 CLI，不改 `tracer-cli.ts` / `cli.ts` |

## 必须停下来问

出现以下任一情况，停止实现，先问，不自行决定：

1. v2 的 R1–R6 未落回正文，或评审要求不同写法；
2. `csv-parse` 的版本、许可证或维护状态在安装时与 ADR-0014 不符；
3. requirements §1.4 第 6、14、15 项或 MD-D18 仍未确认就要进入任务 3；
4. 真实导出出现设计未覆盖的编码、列值或结构（例如列名变化、编码大小写重码、商家渠道编码为纯空白）；
5. `structure` 模式需要创建品牌、大区、分公司或板块才能继续；
6. 10,000 行超过 10 分钟，或文件行数逼近 10,000 需要提高限额（需按已编号决策修订 F-D12）；
7. 需要新增表、列或改变门店匹配语义（含引入 `store_code_match`，须先改 ADR-0008）；
8. B 域 Capability 名称或品牌范围语义发生变化；
9. 名单导入（`a-activity-plan`）对 `import_batches` / `import_row_results` 提出与 R1–R3 冲突的需求；
10. 任何需要网络、真实用户或生产数据的验证。

**小的判断自己做**：reason code 命名、fixture 具体值、索引名、分块大小（100–1,000 之间）、日志字段顺序、CLI 帮助文案。

## 页面任务（待补）

F5 路径 1 的页面归属见 design §15。进入条件：B 域可登录、`ui-foundation.md` 定稿、原型走查通过。本轮任务 0～8 只交付 CLI 与 Module。

## 完成定义

- 全部任务完成，不等于 F5 可上线；
- 只有 acceptance.md 的自动项全绿、手工项 M6 通过、v2 修订已落回、ADR-0014 已接受，才可进入合并评审；
- 合并前按 `dev-ci-cadence.md` 等 CI 绿，并写 run id 与本机 `verify.sh` 结果。

## 实施记录（2026-11-05）

任务 0–8 已按计划实现。本机 `./scripts/verify.sh` 全绿：类型检查、311 个单元测试、迁移一致、325 个数据库测试（含本 spec 的 8 个 `*.db.test.ts`）、密钥、文档链接与登记、Python 侧。

**与计划的差异（均不改变设计语义）**

- `drizzle-kit generate` 直接生成了全部 CHECK、外键和索引，没有手写 SQL；ADR-0005「已知坑」无需追加。迁移文件为 `drizzle/0003_import_batches_and_row_results.sql`。
- `import_batches` 里批次的操作模式放在 `summary.mode`，品牌范围放在已有的 `brand_scope`（`"all"` 或品牌编码数组）；没有新增列。
- 测试用钩子：`ConfirmDeps.hooks.afterChunk`（模拟进程被杀、推进时钟、模拟接手）与 `hooks.beforeApply`（制造唯一键竞争）。生产装配不传。
- 勾选关店的校验用「本批全部 issue（含已解决）」而不是「仅 open」，这样续跑时前一次已关闭的门店不会让命令被拒。
- `runbooks/dev-test-deploy-workflow.md` 里没有按 spec 列 CLI 的位置，所以没有补行；CLI 用法见下。
- 回流文件的 `原因` 列带中文提示（`REASON_TEXT`）加括号里的稳定代码，供业务阅读。

**CLI 用法**（环境变量：`HBECHO_DATABASE_URL`、`HBECHO_MD_ACTOR`、`HBECHO_MD_CAPABILITIES`、`HBECHO_MD_BRAND_SCOPE`，后三个缺一个就启动失败）

```text
pnpm master-data bootstrap [--seed <csv>]
pnpm master-data precheck --file <csv> --mode import|structure
pnpm master-data confirm --batch <id> [--close-store <store_id>]...
pnpm master-data batches | batch <id> | rows <id> | report <id> --out <csv>
pnpm master-data store change-code --store-id <id> --new-code <code>
```

**测量（本机 Mac + docker MySQL 8.4，非测试 ECS）**

- 10,000 行 / 5,000 个经销商，`structure` 模式：预检约 0.5 秒，确认约 18–20 秒，进程 RSS 约 180–250 MB；
- 真实导出（8,327 行，本机 GB18030 CSV，临时文件已删除）：`import` 模式预检 = 需超管处理 8,315 + 错误 12；`structure` 模式预检 = 新增 8,315 + 错误 12；确认约 15 秒；库中 `stores=8,315`、`dealers=5,275`、`brands=3`、`sectors=84`；再传同一文件 = 未变 8,315 + 错误 12；回流文件 12 行。

**测试 ECS 运行（2026-11-05，刘学奎授权）**

- 环境：测试 ECS（i-2zef8qpi1d2mldntjgrv，一次性 mysql:8.4 + node:24-slim 容器，共享网络命名空间，用完即删）；库只在容器内 `127.0.0.1`，不映射端口，不碰现有的 `hbecho-mysql`；node 容器内存上限 8g、整体超时 1200 s；
- 结果：本 spec 的 4 个单元测试文件（39 个用例）与 9 个数据库测试文件（112 个用例，含 `src/db` 旧 schema 测试）全部通过，用时 20.7 s；
- 10,000 行 / 5,000 个经销商，`structure` 模式：预检 564 ms，确认 6,934 ms，进程 RSS 277 MB（本机分别约 0.5 s / 18–20 s / 180–250 MB，差别来自 docker for Mac 的磁盘）；
- ENV-2：`bootstrap` 用仓库里的 42 行真实种子在测试机一次性库上跑通（3 / 4 / 42 / 84），重跑全部 unchanged；
- 清理：两个容器退出即删，工作目录与临时文件已删除；只留下 `node:24-slim` 镜像（约 230 MB）。

**CI**：分支 `a-master-data-import` 第一次推送失败——`*.csv` 被 `.gitignore` 忽略，测试夹具没进仓库，本机因为文件存在而没发现；已加例外（`!tests/fixtures/master-data/*.csv`）并补夹具说明，第二次推送 run 41962704511 成功。

**未做**

- 人工项 M1（业务看预检报告与回流文件是否好懂）、M2、M4、M5；样例已生成在本机 `tmp/md-demo/`（被忽略，不入库）；
- 页面（design §15）。
