# A 主数据导入（a-master-data-import）· 实施计划

> **状态**：`draft`
>
> **执行状态**：任务 0 是文档前置；代码从任务 1 开始；当前尚未开始
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
> **最近核对**：2026-11-04
>
> **更新日期**：2026-11-04（初建）

## Planning rules

- 每个任务是一个纵向切片：完成后应能运行一条命令、看到可验证的结果，而不是只建空表或空 Interface。
- 任务边界跑 `./scripts/verify.sh`；应用代码落地后它扩展为 typecheck + tests，**在扩展之前不声称「测试通过」**。
- 默认验收离线：不连 AI Master、不连 OSS、不发起任何外网请求；MySQL 只用本地一次性容器或 `_test` 库。
- 目录按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)：领域代码在 `src/modules/`，迁移在 `drizzle/`，CLI 在 `src/worker/`，fixture 在 `tests/fixtures/`。
- 不新增未登记的依赖；`csv-parse` 必须先经 ADR-0014 接受；GB18030 解码用 ADR-0005 已定的 Node `TextDecoder`，不引入 iconv-lite。
- 所有内部 BIGINT 在 CLI/JSON 输出为十进制字符串；外部编码保留原文。
- 任务 0 未完成前不写迁移；v2 修订未落回正文前不写 SQL。

## 依赖图

```text
任务 0（v2 修订 + ADR-0014 + INDEX）
   ↓
任务 1（schema / 迁移）
   ├──→ 任务 2（bootstrap + 组织种子）
   │        ↓
   └──→ 任务 3（文件解析 + 预检） ←── 任务 2
            ↓
         任务 4（import 模式确认写入）
            ├──→ 任务 5（待确认撤店 + 审计）
            └──→ 任务 6（structure 模式 + 结构命令）
                     ↓
                  任务 7（查询 + 回流）
                     ↓
                  任务 8（全量离线验收 + 限额 + verify 扩展）
```

容易画错的边：

- 任务 3 **不依赖**任务 6：预检的 Q 行只读结构，不需要结构命令已实现；
- 任务 4 **不依赖**任务 5：确认写入先处理门店 upsert，待确认撤店是独立选择项；
- 任务 6 依赖任务 4 的确认管线，但**不重写**它；结构动作挂在同一行的保存点内；
- 任务 7 的回流文件内容依赖任务 4 的 `outcome`，所以排在 4 之后，不和 3 并行。

## 任务 0 · 文档前置：v2 修订、ADR-0014、INDEX 登记

**目标**：让后面的代码有合法的基线，不让实现偷偷定义列或依赖。

**动作**

- 在 [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) 落回 design §6.2 的 R1–R6：
  - `import_row_results.precheck_class`、`outcome` 可空；
  - `import_batches` 六类计数与 actor 字段；
  - `stores.store_code_match` 生成列与唯一键；
  - `import_row_results.resolved_by_actor`；
  - §12.1 第 8、9 步与结构边界；
  - `data_quality_issues.import_batch_id` 与 `resolved_by_actor`（R6）。
- 新建 `HBECHO设计方案/architecture/adr/0014-csv-parser-dependency.md`：
  - 采用 `csv-parse`；
  - 写明不用它做什么、为什么编码判定仍走 ADR-0005 的 `TextDecoder`、为什么不引入 iconv-lite 或探测库；
  - 核对星标、许可证、近 6 个月维护：2026-11-04 实测 node-csv ⭐ 4,289，低于 5,000 线，ADR 里写明例外理由或改选 PapaParse。
- 更新 [`INDEX.md`](../../../HBECHO设计方案/INDEX.md)：
  - §3 文档状态表登记本 spec（2026-11-04 初建时已登记，v2 修订后复核描述）；
  - §7.1 现有 spec 目录登记（同上）；
  - §7 路线图的顺序说明不变（本 spec 仍是第 2 位）。
- 确认 `./scripts/verify.sh` 自动识别新 spec 四件套（2026-11-04 初建后已通过；v2 与 ADR 改动后再跑一次）。

**验证**

- `./scripts/verify.sh` 通过；
- v2 修订逐条与 design §6.2 对应，没有多改或少改；
- ADR-0014 状态 `accepted`，有决策人与日期。

**Requirements:** 全部；**Design:** §6.2、§10。

## 任务 1 · schema 与迁移

**目标**：空库一次迁移成功，导入表与门店匹配列存在，约束能挡住重复与非法状态。

**新增/修改**

- `src/db/schema/master-data.ts`（或 tracer 的 schema 模块中的组织表文件）：`brands/regions/branches/sectors/dealers/stores` 的 Drizzle 定义；`stores.store_code_match` 生成列；
- `src/db/schema/import.ts`：`import_batches`、`import_row_results` 修订版；
- `drizzle/`：生成的迁移 SQL + 手写 CHECK/生成列/唯一键；
- `src/db/repositories/master-data.ts`：受限写过程（门店按匹配键查找/插入/更新）与读过程；
- `src/db/repositories/import.ts`：批次锁、行结果批量写、计数更新；
- `tests/db/master-data-schema.test.ts`、`tests/db/import-schema.test.ts`。

**行为**

- 迁移可重复执行（第二次为空操作）；
- `UQ(brand_id, store_code_match)` 生效；`store_code` 原文与匹配值分别可读；
- `import_row_results.outcome` 允许 null；`precheck_class` 只接受五个值；
- `import_batches` 状态只接受六个值；
- 所有指向组织主档/批次的外键不使用 `ON DELETE CASCADE`。

**验证**

- 空库 `migrate` → 成功；再跑一次 → 成功且无变更；
- 插入重复 `(brand_id, store_code)` 只有一条成功；
- 插入非法 `precheck_class` / status 被 CHECK 拒绝；
- `./scripts/verify.sh` 通过（此时可能还未扩展 tests，单独跑 db 测试）。

**Requirements:** MD-12；**Design:** §6.1–§6.4。

## 任务 2 · bootstrap 与组织种子

**目标**：一条命令建立 3 个品牌、4 个大区、42 个分公司、84 个板块；重复执行全部 `unchanged`。

**新增/修改**

- `src/modules/master-data-import/bootstrap.ts`：种子读取与 upsert；
- `src/modules/master-data-import/mappings.v1.ts`：品牌/板块/大区常量与种子解析；
- `src/worker/cli/master-data.ts`：`bootstrap` 子命令；
- `tests/unit/bootstrap.test.ts`、`tests/unit/mappings.test.ts`。

**行为**

- 读取 [`分公司-大区对照.csv`](../../../HBECHO设计方案/domains/data-foundation/seed/分公司-大区对照.csv)；
- 品牌：`hitachi/日立`、`hisense/海信`、`york_vrf/约克VRF`；
- 大区：CSV 去重 4 个；分公司：42 个，逐个挂到大区；
- 板块：每个分公司 `water/水机`、`home/家装`，编码 `{branch_code}-water` / `-home`；
- 一个事务；重复执行 `unchanged`；
- 审计事件 `bootstrap_completed`，含四类计数。

**验证**

- 空库跑一次：`brands=3`、`regions=4`、`branches=42`、`sectors=84`；
- 再跑一次：计数不变，全部 `unchanged`；
- 种子 CSV 中一个分公司对应两个大区时整批失败（种子损坏负例）；
- 非超管 actor 调用被拒绝，库中无写入。

**Requirements:** MD-5、MD-9；**Design:** §7.2、§7.7。

## 任务 3 · 文件解析、映射与预检

**目标**：`precheck` 对一份文件给出六类报告、行结果与待确认撤店清单，业务表零写入。

**新增/修改**

- `src/modules/master-data-import/file-parser.ts`：编码判定、CSV 解析、表头、限额；
- `src/modules/master-data-import/precheck.ts`：分类优先级、映射、范围、结构解析、重复检测；
- `src/modules/master-data-import/closure.ts`：待确认撤店的识别与 issue 写入（只识别，不关店）；
- `src/modules/master-data-import/index.ts`：Module 导出；
- `src/worker/cli/master-data.ts`：`precheck --file --mode import|structure`；
- `tests/fixtures/master-data/*.csv`；
- `tests/unit/file-parser.test.ts`（含 `TextDecoder('gb18030', {fatal:true})` 可用性测试）、`tests/unit/precheck.test.ts`、`tests/integration/precheck.test.ts`。

**行为**

- 文件级失败不建批次、不写行；
- 通过后建批次、写行原文与 `precheck_class`、写六类计数、写待确认 issue；
- `structure` 模式按 design §7.4 调整结构类分类，但**不写结构**（写入在任务 6）；
- 预检结束批次为 `awaiting_confirm`；
- 业务表零写入。

**验证**

- UTF-8 与 GB18030 同内容产生相同结果；
- 六类各至少一个 fixture，计数与行结果一致；
- 映射未命中、跨品牌、结构缺失、重复门店编码、已撤店恢复各自分类正确；
- 预检前后 `stores/dealers/sectors/branches` 的 `updated_at` 与行数不变；
- 同一文件重复预检产生两个批次，分类一致。

**Requirements:** MD-1、MD-2、MD-3、MD-4（预检部分）、MD-6（识别部分）、MD-9、MD-10（部分）；**Design:** §7.1–§7.5。

## 任务 4 · `import` 模式确认写入

**目标**：确认一个批次，门店按 `(brand_id, store_code_match)` upsert；重跑与中断恢复不产生重复事实。

**新增/修改**

- `src/modules/master-data-import/confirm.ts`：批次锁、分块事务、逐行重校验、保存点、恢复；
- `src/modules/master-data-import/authorization.ts`：1.0 服务身份策略；
- `src/worker/cli/master-data.ts`：`confirm --batch [--close-store ID]...`；
- `tests/integration/confirm.test.ts`、`tests/integration/recovery.test.ts`。

**行为**

- 批次 `awaiting_confirm` → `writing` → `completed`；
- `new` 建门店；`update` 改名称/等级、恢复 `closed`；`unchanged` 不写；
- 预检后事实变化 → `conflict/precheck_stale`；
- 同批次并发确认只有一个写入者；
- 进程中断后重跑，按自然键收敛；
- 品牌范围过滤；
- 批次完成写 `import_confirmed` 审计事件（任务 5 接 AuditPort；本任务可用临时 sink）。

**验证**

- 10,000 行 fixture 在测试机完成确认，六类计数与行结果一致；
- 改名 / 改级 / 恢复已撤店各自生效，`store_id` 不变；
- 中断恢复后门店数、审计数不重复；
- 并发确认只有一个成功进入 `writing`；
- 跨品牌行不写；
- 写入期间无网络。

**Requirements:** MD-4、MD-7、MD-9、MD-12；**Design:** §7.6、§9。

## 任务 5 · 待确认撤店、恢复与审计

**目标**：消失门店只生成 issue；确认关店才 `closed`；恢复与关店都有审计。

**新增/修改**

- `src/modules/master-data-import/closure.ts`：确认关店、issue 解决、恢复；
- `src/modules/master-data-import/audit.ts`：`AuditPort` 与结构化日志实现；
- `src/worker/cli/master-data.ts`：`--close-store` 参数与 `closure` 查询；
- `tests/integration/closure.test.ts`、`tests/unit/audit.test.ts`。

**行为**

- 确认时只关闭 `closureStoreIds` 中、且属于本批次 issue 的门店；
- 不在列表中的 ID → 整条命令拒绝；
- 关店写 `store_closed`；恢复写 `store_reactivated`；
- 未勾选的门店保持 active、issue 保持 open；
- 审计事件不含整行原文与文件内容。

**验证**

- 预检不关任何店；
- 勾选 3 中 2，只有 2 家 closed，issue 状态对应；
- 非法 store ID 使整条确认拒绝，零写入；
- 恢复已撤店后审计事件存在，`store_id` 不变；
- 审计日志字段与 design §7.8 一致。

**Requirements:** MD-6、MD-10；**Design:** §7.5、§7.8。

## 任务 6 · `structure` 模式与结构命令

**目标**：超管能把 Q 行中的经销商、板块、关系变更写入；单条结构命令可建 / 改 / 停用组织。

**新增/修改**

- `src/modules/master-data-import/structure.ts`：`MasterDataStructureModule`；
- `src/modules/master-data-import/confirm.ts`：`structure` 模式的保存点分支（不重写 import 流程）；
- `src/worker/cli/master-data.ts`：`structure` 子命令族；
- `tests/unit/structure.test.ts`、`tests/integration/structure-mode.test.ts`。

**行为**

- 单条命令：品牌 / 大区 / 分公司 / 板块 / 经销商的新建、改名、停用启用；门店单条新建、换关系、停用启用、改码；
- `structure` 模式确认：新建经销商、更新经销商名、建板块、更新分公司名、换门店关系；
- 所有命令自然键幂等；重复相同值 `unchanged`；
- 非超管拒绝；审计 `structure_changed`。

**验证**

- 同一文件先 `import` 模式确认：结构类行全部 Q，结构表不变；
- 再以 `structure` 模式确认：经销商/板块/关系写入，品牌/大区/分公司数量不变；
- 单条结构命令重复执行 `unchanged`；
- 门店改码后 `store_id` 不变，旧码不再命中；
- 非超管调用零写入。

**Requirements:** MD-5、MD-9、MD-10；**Design:** §7.4、§7.7。

## 任务 7 · 查询与回流

**目标**：批次列表、批次详情、行详情、回流 CSV 可用，BIGINT 为十进制字符串。

**新增/修改**

- `src/modules/master-data-import/query.ts`：`ImportBatchQuery`；
- `src/modules/master-data-import/return-file.ts`：回流 CSV 与公式注入前缀；
- `src/worker/cli/master-data.ts`：`batches`、`batch`、`rows`、`report`；
- `tests/integration/query.test.ts`、`tests/unit/return-file.test.ts`。

**行为**

- 范围过滤按 actor 品牌；
- 六类计数从行结果聚合，与批次列一致；
- 回流列 = 原 11 列 + `预检分类`、`结果`、`原因`；
- 单元格以 `= + - @ \t \r` 开头时加 `'`；
- 不存在的批次返回稳定「未找到」。

**验证**

- 批次列表 / 详情 / 行详情字段与 design 一致；
- 回流 CSV 可在 Excel 打开，前缀生效；
- 范围外批次不可见；
- 查询不产生写入，不触发网络。

**Requirements:** MD-8、MD-10；**Design:** §7.8、§8。

## 任务 8 · 全量离线验收、限额与 verify 扩展

**目标**：acceptance.md 的全部自动项可一条命令跑完；`verify.sh` 接入 typecheck + tests。

**新增/修改**

- `tests/acceptance/master-data-import.test.ts`：覆盖 acceptance 自动项；
- `tests/harness/network-denied.ts`：网络禁用；
- `scripts/verify.sh`：应用代码落地后扩展 typecheck + tests（按项目 CLAUDE.md 的唯一入口）；
- `HBECHO设计方案/runbooks/dev-test-deploy-workflow.md`：记录本机验证命令与测试机运行方式（如已有章节，补一行）；
- `tests/perf/10k.test.ts` 或脚本：10,000 行耗时测量，结果回填设计 §12。

**验证**

- `./scripts/verify.sh` 通过；
- 全部自动验收通过；
- 10,000 行在测试机的耗时、内存、批次数记录在案；
- 网络禁用证明存在；
- 空库迁移 + bootstrap + 预检 + 确认 + 查询 + 回流一条龙可重复。

**Requirements:** MD-11 及全部；**Design:** §11、§12。

## 对已有代码与测试的改动（实施时登记）

| 任务 | 可能触到的既有文件 | 说明 |
|---|---|---|
| 0 | `HBECHO设计方案/domains/data-foundation/database-design-v2.md`、`INDEX.md`、`scripts/check-doc-registry.py`、新增 ADR-0014 | 只改基线与登记，不改代码 |
| 1 | tracer 任务 2 建立的 `src/db/schema/*`、`drizzle/*` | 补列 / 补表；不改 tracer 已有列语义 |
| 3 | `src/worker/cli/` 的入口注册 | 新增子命令，不改 tracer 子命令 |
| 8 | `scripts/verify.sh` | 扩展为 typecheck + tests；保持唯一入口 |

## 必须停下来问

出现以下任一情况，停止实现，先问，不自行决定：

1. v2 的 R1–R6 未落回正文，或评审要求不同写法；
2. ADR-0014 未被接受，或依赖的星标/许可证/维护状态不符合 `no-reinventing-wheels`；
3. 真实导出出现设计未覆盖的编码、列值或结构（例如同一编码大小写不同、经销商编码为纯空白）；
4. `structure` 模式需要创建品牌、大区或分公司才能继续；
5. 10,000 行超过 10 分钟，或需要提高限额；
6. 需要新增表、列或改变 `store_code_match` 的大小写语义（后者先改 ADR-0008）；
7. B 域 Capability 名称或品牌范围语义发生变化；
8. 任何需要网络、真实用户或生产数据的验证。

**小的判断自己做**：reason code 命名、fixture 具体值、索引名、分块大小（100–1,000 之间）、日志字段顺序、CLI 帮助文案。

## 页面任务（待补）

F5 路径 1 的页面归本 spec（design §15）。UI 全局基线定稿后在此增加任务；本轮任务 0～8 只交付 CLI 与 Module。

## 完成定义

- 全部任务完成，不等于 F5 可上线；
- 只有 acceptance.md 的自动项全绿、v2 修订已落回、ADR-0014 已接受，才可进入合并评审；
- 合并前按 `dev-ci-cadence.md` 等 CI 绿，并写 run id 与本机 `verify.sh` 结果。