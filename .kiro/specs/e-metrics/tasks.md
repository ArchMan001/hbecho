# E 指标与看板（e-metrics）· 任务

> **状态**：`draft`
>
> **执行状态**：未开始。任务 0 的门禁（requirements §8 待确认的 2、5、11、12，以及 design §18 对应各项）未通过前，不进入任务 1。**界面设计已于 2026-11-16 由刘学奎确认（design §20.6；原型 `ui-lab/e-metrics/`）**；页面任务 P1–P6 已列在本文件，但页面代码仍要等对应的查询 / 导出接口（任务 6–9、10a）落地。
>
> **D 闸门（2026-11-12 修订）**：闸门只拦**任务 5b**——真实适配器、跨域契约测试，以及 acceptance X3 的端到端验收；它们要等 `d-rule-engine` 的 spec 闸门通过、JP-16 冻结（含 `listPlans`、`explain` 调用方参数、`describeRun`）。其余任务（含 4a、4b、5、10a、10b）按 JP-16 的形状对 **fake 端口**开发并验收，可以标完成；完成时必须写明「对 fake 验收，未对真实 D 验证」。**fake 通过不等于 D 的真实行为已被证明。** 旧写法把 4、5 整体拦住，导致依赖投影的 7–9、11、13 在文件头说不受限、依赖图里却受限，现已改正
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **所属域**：E 指标、报表与看板 · **目录命名**：`e-metrics`，符合 `<代号>-<切片>`
>
> **上游依赖**：`b-access-control`（已合并）、`a-activity-plan`（已合并）、`d-rule-engine`（**spec 未实施**；E 用 fake 端口验收，端到端延后）
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16

## Planning rules

- 任务按纵向结果排序：每个任务结束时留下可运行、可观察的增量，不建空表或空接口。
- 默认验收离线：D 的读取口、OSS、媒资全部走 fake；`verify.sh` 的数据库测试用一次性 MySQL 8.4 容器。
- 不在任务中重新选型；技术栈沿用 ADR-0005；目录以 ADR-0013 为准。
- 所有内部 `BIGINT` 输出十进制字符串；时间 UTC `DATETIME(6)`；状态 `VARCHAR + CHECK`；无 `ON DELETE CASCADE`。
- 每个任务结束跑 `./scripts/verify.sh`，并在本文件勾选、写下「未证明」的部分。
- 任务 12 之前不声称任何性能数字；任务 12 之后把实测值写回 design §10.4 与 requirements E-VIEW-12。
- **页面任务**：界面设计已于 2026-11-16 确认（design §20.6）；P1–P6 在「页面任务」一节。页面代码必须等对应查询 / 导出接口（6–9、10a）完成，不先造静态页面或假接口。

## 依赖图

```text
0 门禁与登记
└─ 1 建表与约束
   ├─ 2 指标字典与节点级求值
   ├─ 3 A 事实读取口（as-of）
   │    2、3 ─→ 4a 入队、领取、冻结输入 ─→ 4b 分块构建与指标计算 ─→ 5 校验与自动激活
   └─ 6 授权、范围与审计
      └─ 7 点检表（依赖 5 或 harness 造的投影）─┬─ 8 专员明细与命中内容
                                                └─ 9 计划看板
10a 三类报表导出（依赖 5、6、7、8）─→ 10b 判定结果与圈定结果
11 生命周期与清理（依赖 4a、5、6）
12 限额与容量实测（依赖 7、8、10a）
13 CLI 与常驻进程（依赖 5、10a、11）
5b D 真实适配器与跨域契约  ← D 闸门（唯一被拦的任务；依赖 4b、5、10b）
P1 组织点检表（依赖 6、7）；P2 专员明细 / P3 命中内容（依赖 6、8）；
P4 计划看板（依赖 6、9）；P5 指标字典（依赖 2、6）；P6 下载中心（依赖 6、10a）
```

**容易画错的边**：

- 4a / 4b 读 A 的事实（3）与 D 的端口（对 fake）。先做 3，再做 4。
- 7–9 的测试用 5 产出的真实投影（对 fake D）。不要手造投影行：手造等于绕开构建器，证明不了查询与构建的一致。
- 6 必须在 7 之前：`report` / `metric_config` 策略未注册时，查询整条链路 fail closed，7 无法验收。
- 10a / 10b 依赖 7 / 8 的查询接口，不复制查询逻辑；导出必须与页面同值，否则「同口径」无法证明。
- 11 的 `purge` 必须在 A 删计划行之前运行；组合器的归属见 design §15.2（确认前 E 先提供，D 落地时只留一份）。
- 11 的回收站逻辑**不依赖** `onDeleted` 通知：读路径看实时计划状态（design §11）。

## Tasks

- [ ] 0. 门禁、依赖与文档登记
  - **Requirements:** 无（工程任务）
  - **Design:** §14、§18
  - 完成：① 三项确认——E-SD-01 投影范围、E-SD-04 导出桶、E-SD-05 上限初值；② 若确认新增桶，按 ADR-0001 的格式增补第七桶 `hbecho-export`（状态 `proposed`，不创建）；③ 向 D 提出 `listPlans` 对齐请求并记入 D 的 design §10.4；④ `INDEX.md` 登记 `e-metrics` 与归档旧 design；⑤ `scripts/check-doc-registry.py` 的 `DESIGN_ONLY_SPECS` 去掉 `metrics-and-dashboard`；⑥ `prd-domain-e-metrics.md` 与 `prd-platform.md` 的旧链接改到归档 / 新 spec。
  - **已完成（2026-11-12）**：旧 design 原计划归档，2026-11-18 改为删除（最后版本见 git 提交 8e5ab70）（`superseded` 头、链接已修）；④⑤⑥ 已做；`verify.sh` 的文档链接与登记检查通过。
  - **2026-11-12 评审后追加**：⑦ 向 D 提三项对齐请求（`listPlans`、`explain` 增加调用方参数、`describeRun`），记入 D 的 design §10.4；⑧ 提请确认 requirements §8 的 9–14 项；⑨ `prd-domain-e-metrics.md` §13 第 9 项已恢复为「建议已提出，待 D 的 §14 第 17 项确认」，并补版本记录 v1.1.1「订正引用，非新规则」；⑩ ADR-0001 增补第七桶时同时写明已评估 `hbecho-temp`（3 天过期）不合适。
  - **待做**：①②③⑦⑧⑩（需要刘学奎与 D 的答复）。
  - **验证**：`./scripts/verify.sh` 第 7、8 步通过；`grep -rn "metrics-and-dashboard/design.md"` 只剩归档文档与历史记录。
  - **完成（待填）**：

- [ ] 1. 建表与约束（15 张表；`projections` 含 `frozen_inputs`，**没有** `deleted_at` 与 `quality` 列）
  - **Requirements:** E-CAT-2、E-PRJ-1～3、E-EXP-1、E-LIFE-1～5
  - **Design:** §5
  - 迁移新增 15 张表（指标 4 张：`metric_definitions`、`metric_revisions`、`metric_brand_scopes`、`observation_policy_revisions`；投影 9 张：`latest_executions`、`projections`、`projection_executions`、`projection_metrics`、`projection_orgs`、`projection_staff`、`projection_staff_observations`、`projection_hits`、`projection_quality`；导出 2 张：`export_jobs`、`export_artifacts`；见 design §5）。含全部 CHECK、唯一键、生成列 `active_key`、RESTRICT 外键。
  - **验证**：干净库连跑两次迁移幂等；逐条故意违反 CHECK / UQ 被拒绝；删被引用的活动计划被 RESTRICT 拒绝；`drizzle-kit generate` 无新文件。
  - **完成（待填）**：

- [ ] 2. 指标字典与节点级求值
  - **Requirements:** E-CAT-1～8、E-OBS-3
  - **Design:** §6.1～6.6、§5.1
  - 落地 `catalog.ts` / `catalog-pure.ts` / `values.ts`：内置四指标（`interactions_total` 为 `disabled`）、派生指标随计划惰性生成（`judgement.<planId>.<metric>`）、自定义指标 AST、**节点级求值（精确有理数）**、绑定 `base` / 判定计划与 `cross_plan_operands` 拒绝、依赖图与成环、分子 ⊆ 分母、影响面、revision 发布与归档、品牌适用范围。
  - **验证**：`catalog.test.ts` 覆盖 §6.5 的每条校验；`values.test.ts` 覆盖定点换算、舍入、分量求和、除零，以及 design §6.5 的两个反例（乘法得 4、部分重叠的 `rate₁+rate₂` 得 3/2），每个用例断言「节点值 = 同一节点上操作数值的运算」；`catalog.db.test.ts` 覆盖 UQ、两条 CHECK（`derived` 必有计划、`builtin` 必无计划）、归档后新配置拒绝、影响面计算。
  - **完成（待填）**：

- [ ] 3. A 事实读取口
  - **Requirements:** E-CAT-3、E-OBS-1、E-OBS-2、E-PRJ-10
  - **Design:** §4.1、§6.7、§7.9
  - 落地 `facts.ts`：活动计划与已加入分公司、组织名称、主页快照（last_observed 与边界，**按批次 `finished_at ≤ cutoff ∧ logical_at ≤ cutoff` 回溯**）、内容快照计数（**按 `finalized_at ≤ cutoff` 取最后一个快照，不读 `current_snapshot_id`**）、内容显示字段、同步质量。**只在这一个文件里 import A 的 schema**。动手前先对照 A 现有的 current 指针选择规则（`sync-schedule`）核对「已终态批次」的定义，不一致以 A 为准并回写 design §6.7。
  - **验证**：`facts.db.test.ts` 覆盖：截止时点前的终态选择、真实 0 与缺失、活动开始前无快照、窗口边界（北京日 → UTC 半开）、**cutoff 之后才完成的批次 / 才 finalized 的快照不影响结果**、同步成功率（无终态任务 → `no_data`）、组织链批量读取；静态护栏：其他文件不 import `src/db/schema/{org,accounts,content,sync}.ts`。
  - **完成（待填）**：

- [ ] 4a. 入队、领取与冻结输入
  - **Requirements:** E-PRJ-1、E-PRJ-2、E-PRJ-4、E-PRJ-11、E-PRJ-12、E-CAT-4
  - **Design:** §7.1～7.3
  - 落地 `projection/reader.ts`（D 端口 + fake，含 `listPlans` / `explain` 调用方参数 / `describeRun`）、`poll.ts`、`enqueue.ts`、`claim.ts`：轮询游标与 ≥ 60 秒重叠、`latest_executions` upsert、**入队时冻结 `frozen_inputs`**、幂等键、入队合并（已有未领取的 planned 行则原地更新）、对账（无 active 也无未终态投影的活动补入队）、租约与 fencing、冲突行为（`cancelled` 重置、`failed` / `rejected` 原样返回）、指标目录同步（派生指标）。
  - **验证**：`enqueue.db.test.ts` 用 fake D 覆盖：一次入队三计划、重复触发一份、并发领取一个成功、入队后新执行到达时构建仍用冻结输入且 descriptor 与键一致、连续完成合并为一次构建、对账补入队、`cancelled` 被重置而 `failed` 不被重复构建；`reader.contract.test.ts` 是 fake 的 shape 测试（与 5b 共用）。
  - **完成（待填）**：对 fake 验收；未对真实 D 验证。

- [ ] 4b. 分块构建与指标计算
  - **Requirements:** E-PRJ-3、E-PRJ-8～10、E-PRJ-12、E-CAT-3、E-CAT-5、E-OBS-1、E-OBS-2、E-VIEW-2（行集）、E-VIEW-4
  - **Design:** §6、§7.4
  - 落地 `projection/build.ts`：读 `frozen_inputs`、核对 `describe` 与流出行数（`descriptor_mismatch`）、`pendingPlans`、逐块写 `projection_staff` / `projection_staff_observations` / `projection_hits` / `projection_orgs`（joined ∪ 冻结链、`membership`）/ `projection_metrics`（四层；分量先写、自定义指标按依赖顺序节点级求值、绑定计划的基础指标重算）/ `projection_quality`；板块种类复用 `sectorKeyOf`；组织链不完整降级为 `attribution_issue`。
  - **验证**：`build.db.test.ts` 用 fake D 覆盖：行集来自冻结名单（新增门店不凭空出现、执行后退出的分公司仍有行并标 `exited`）、两个板块各自的分母、基础指标按账号并集只计一次、绑定计划的自定义指标取该计划参与者、§6.5 两个反例在数据库里端到端成立、构建中断续跑、缺少执行 → `rejected(no_execution)`、活动删除中 → `cancelled`、`describe` 与流出行数不符 → `descriptor_mismatch`、构建之后到达的新批次不改变重建结果。
  - **完成（待填）**：对 fake 验收；未对真实 D 验证。

- [ ] 5. 校验与自动激活
  - **Requirements:** E-PRJ-5～7、E-VIEW-1（token）、E-VIEW-6（stale）、E-LIFE-3（`running = 0`）
  - **Design:** §7.5～7.8
  - 落地 `projection/validate.ts`、`activate.ts`：§7.6 的「拒绝」类校验与「降级」类处理、原子切换（**SQL 不对生成列赋值**）、`active_key` 并发兜底、失败 → `rejected` / `failed` + `stale_since`、`not_ready`、手工重算入口（`metric.catalog.manage`、客户端请求 ID）与审计。
  - **验证**：`activate.db.test.ts` 覆盖每个拒绝类失败码、**降级类（组织链不完整、缺快照、操作数 partial）不拒绝且计数正确**、并发两个激活只有一个成功、激活期间旧投影继续服务、`stale` 与 `not_ready` 的查询结果、重算产生新投影且旧的可查、`branch_manager` 发起重算被拒、同一请求 ID 只产生一份、审计事件。
  - **完成（待填）**：对 fake 验收。

- [ ] 6. 授权、范围与审计
  - **Requirements:** E-AUTH-1～6、E-EXP-3（快照）、E-EXP-4（执行时收窄）
  - **Design:** §8.1、§9
  - 注册 `report` / `metric_config` 策略（先查再注册）；接入 `authorize`、`createEgress`、`AuditWriter`；增加 `service:metrics-worker`；落地 `authz.ts` / `audit.ts` 与 §8.1 的**范围合取与「本范围合计」重算**（供 7–9 共用）。
  - **验证**：`authz.test.ts` 覆盖四类角色的可见范围、`self` 只匹配本人、未注册 fail closed、空范围返回空、跨分公司 403、`brands / branches / self` 合取；`scope-rollup.test.ts` 覆盖受限范围的重算与全局范围逐值相等；`egress.test.ts` 覆盖出口 3 / 4 / 7 的允许与拒绝、服务身份不能走出口 4；审计事件逐条可查。
  - **完成（待填）**：

- [ ] 7. 组织点检表
  - **Requirements:** E-VIEW-1～6、E-VIEW-9（可选列）、E-AUTH-6
  - **Design:** §8.1～8.2、§8.5
  - 落地 `query/checklist.ts`：按板块分表、组织行、计划列组与「同一人群」分组、基础指标固定列、自定义指标可选列、未参与、`pendingPlans` 提示、排序 / 分页 / 筛选、页脚、受限范围的「本范围合计」。用任务 5 产出的投影（对 fake D），不手造投影行。
  - **验证**：`checklist.db.test.ts` 覆盖：大区率 = 分量相除 ≠ 平均、分母 0 显示 `—`、未参与不显示 0、同人群共用分母标注、冻结行集、**`branch_manager` 的大区行与页脚不含范围外分公司**、**`store_staff` 一行且祖先无数字**、`self` 与 `branches` 合取、页脚字段齐全、计划删除且 `onDeleted` 未被调用时仍 410、同一投影下与看板 / 导出同值。
  - **完成（待填）**：

- [ ] 8. 专员明细与命中内容
  - **Requirements:** E-VIEW-7～11
  - **Design:** §8.3～8.4
  - 落地 `query/staff.ts`、`query/hits.ts`：一行一专员、多计划列组、三项结果与 C1/C2/C3、结果筛选、下钻同 token、命中内容行集 = 内容级 pass、证据入口（查看者身份调 `explain`，无权限不展示）与 `content_rows_pruned`、分页与排序、部分数据标记。
  - **验证**：`staff.db.test.ts` / `hits.db.test.ts` 覆盖：多账号合并一行不重复分母、筛「未达标 / 未获取成功」、下钻带同一 `projectionId`、证据过期仍保留行、`store_staff` 无证据入口且不报错、同一作品在不同账号各一行、分页稳定。
  - **完成（待填）**：

- [ ] 9. 计划看板
  - **Requirements:** E-BOARD-1～4、E-AUTH-6
  - **Design:** §8.5
  - 落地 `query/board.ts`：六张卡片、未选计划时不给合并比率、跨板块不合并、范围过滤与受限范围重算（卡片 5 / 6 的隐藏规则）、缓存键含范围指纹且授权与计划状态先于缓存。
  - **验证**：`board.db.test.ts` 覆盖六卡片的空 / 有数据、总部与分公司同配置不同范围、**受限范围下卡片 1 / 2 / 3 / 6 不含范围外数据、卡片 5 只显示 `stale`**、不可见组织不出现、缓存不复用其他范围的数据、命中缓存也不绕过 410。
  - **完成（待填）**：

- [ ] 10a. 三类报表导出
  - **Requirements:** E-EXP-1～11、E-AUTH-3（出口 4）
  - **Design:** §10.1～10.5
  - 增加 `exceljs` 4.4.0（精确版本）；落地 `export/jobs.ts`、`runner.ts`、`workbook.ts`、`deliver.ts`、`caps.ts`：组织点检表 / 专员明细 / 命中内容三类导出、提交冻结、执行时范围收窄、交付前复查、Excel 保真、嵌图与降级、上限、下载中心后端；`expires_at` 在成功时写。
  - **验证**：`export.db.test.ts` 覆盖：三类文件生成（fake store 内存工作簿）、幂等提交、撤权取消、范围收缩按新范围、受限范围导出的合计与页面「本范围合计」一致、过期 410、排队后成功的 `expires_at`、图片超限 warning、公式注入前缀、文件名清洗、行数超限拒绝；静态：无 `xlsx.read` / `xlsx.load`，导出代码不 import schema。
  - **完成（待填）**：对 fake 验收。

- [ ] 10b. 判定结果与圈定结果导出
  - **Requirements:** E-EXP-1、E-EXP-12
  - **Design:** §10.1、§10.6、§15.1（第 6 项）
  - 在 10a 的基础上加判定结果（3 sheet）与圈定结果两类；`streamContents` / `streamCircleRows` 经端口流式读取；`describeRun` 校验圈定运行属于该活动计划且种类 / 状态正确；`content_rows_pruned` 与 `circle_run_expired` 的处理。
  - **验证**：`export-d.db.test.ts` 覆盖：判定结果三 sheet、汇总与点检表一致、D 清理后 warning、`circle_run_id` 属于别的活动 / 种类不对 / 未完成 → 404、`describeRun` 缺失时圈定导出不可用而其余不受影响。
  - **完成（待填）**：对 fake 验收；未对真实 D 验证。

- [ ] 11. 生命周期与清理
  - **Requirements:** E-LIFE-1～5、E-PRJ-10（质量保留）
  - **Design:** §11、§15.2
  - 落地 `downstream.ts`（片段 + 组合器；`summarize` 恒返回 0，`onDeleted` 只取消在途工作，`onRestored` 空操作）、`lifecycle.ts`、`maintenance.ts`：**读路径实时计划状态**（不依赖通知）、分块 purge（先取消在途 + 递增 fencing）、投影保留 N、导出件过期与对象删除、`plan-main.ts` 注入组合器、恢复后的对账补入队。
  - **验证**：`lifecycle.db.test.ts` 覆盖：**不调用 `onDeleted` / `onRestored` 也能删除即 410、恢复即可查**、恢复后被取消的构建被补入队、purge 分块与重跑、迟到 Worker 写入被 fencing 拒绝、RESTRICT 不阻塞、`summarize` 不挡住删除、保留 N + active + 被任务引用者不删、过期对象删除失败重试；`downstream.test.ts` 覆盖组合器的调用顺序与失败传播。
  - **完成（待填）**：

- [ ] 12. 限额与容量实测
  - **Requirements:** E-VIEW-12、E-EXP-10
  - **Design:** §10.4、§7.10
  - 造 43 分公司 × 20 指标 × 万级命中内容的投影，实测：点检表 P50 / P95（含受限范围的重算路径）、专员明细与命中内容分页、导出的行 / 图 / 文件 / 时长 / **Worker 内存**；决定无图大表是否改用 `WorkbookWriter`；把实测值与调整后的上限写回 design §10.4、requirements E-VIEW-12 与 `.env.example`。
  - **验证**：规模脚本输出表格；结论写进本任务；未达 P95 < 2 秒时写明实测值与处理方案（不静默改目标）。
  - **完成（待填）**：

- [ ] 13. CLI 与常驻进程装配
  - **Requirements:** E-OPS-1～4
  - **Design:** §4、§14
  - 落地 `metrics-cli.ts`、`metrics-main.ts`、`assemble.ts`、`config.ts`：catalog / projection / report / export / maintain 命令，常驻轮询 + 构建 + 导出 + 每日维护；`package.json` 增加 `metrics` 脚本；`.env.example` 增加变量（不含真实值）。
  - **验证**：`metrics-cli.test.ts` 覆盖命令解析与错误码、缺配置启动失败点名；`metrics-main.db.test.ts` 覆盖两个 Worker 并发不重复激活 / 不重复执行、杀死一个后接管、每日维护幂等。
  - **完成（待填）**：

- [ ] 5b. D 真实适配器与跨域契约  ← **D 闸门**
  - **进入条件**：`d-rule-engine` 的 spec 闸门通过、JP-16 冻结（含 `listPlans`、`explain` 调用方参数、`describeRun` 有结论），且 D 已实施。
  - **Requirements:** E-PRJ-1～5（真实 D 下）、E-VIEW-8、E-EXP-12
  - **Design:** §4.1、§15.1
  - 落地 `projection/reader.d.ts`（真实适配器）；把 4a 的 `reader.contract.test.ts` 同时跑在 fake 与真实适配器上；用真实 D 走「轮询 → describe → streams → 构建 → 激活 → 查询 → 导出」一遍。
  - **验证**：契约测试两侧全绿；acceptance X3 的端到端用例；D 清理内容行后的 `content_rows_pruned` 在真实 D 下成立。
  - **完成（待填）**：

## 页面任务（P1–P6，界面已于 2026-11-16 确认）

> **取数边界**：页面只经 `src/modules/metrics/web.ts` 取数与提交（仿 `access-control` 的 `web.ts`），不 import `query/*`、`export/*`、schema 或 D 端口；Route Handler 只做参数解析、授权与序列化，不复制查询逻辑。三视图与导出必须带同一个 `projectionId`。
>
> **验收方式**：按 `ui-lab/e-metrics/` 对应路径与真实任务走一遍；design §20.4 的状态矩阵（加载 / 空 / 无权限 / 错误 / 处理中 / stale）逐项可见；页面与导出同值。

- [ ] P1. 组织点检表页面
  - **Requirements:** E-VIEW-1～6、E-VIEW-9、E-AUTH-6
  - **Design:** §8.1～8.2、§8.5、§20.1～20.5
  - **页面文件:** `src/app/(app)/reports/checklist/page.tsx`；只读 Route Handler `src/app/api/reports/checklist/route.ts`；新建 `src/modules/metrics/web.ts`
  - **可点击验收:** `/reports/checklist?activityPlanId=<id>&sector=home|water`；筛选 / 排序 / 分页进 URL；点组织行的完成率 → `/reports/staff?...&projectionId=<id>`；页脚口径、`samePeopleAs`、未参与、已退出、部分覆盖、受限范围「本范围合计」与 `store_staff` 本人一行
  - **依赖:** 任务 6、7
  - **完成（待填）**：

- [ ] P2. 专员明细页面
  - **Requirements:** E-VIEW-7～11
  - **Design:** §8.3、§8.5、§20.1～20.5
  - **页面文件:** `src/app/(app)/reports/staff/page.tsx`；只读 Route Handler `src/app/api/reports/staff/route.ts`；`web.ts`
  - **可点击验收:** `/reports/staff?activityPlanId=<id>&planId=<id>&result=all|success|not_met|unobtained&org=...&platform=...&page=1`；一行一专员、多账号合并、三项层结果与 C1/C2/C3、最后观测；点行 → `/reports/hits?...&staffId=<id>&projectionId=<id>`
  - **依赖:** 任务 6、8
  - **完成（待填）**：

- [ ] P3. 命中内容页面
  - **Requirements:** E-VIEW-8～11
  - **Design:** §8.4、§20.1～20.5
  - **页面文件:** `src/app/(app)/reports/hits/page.tsx`；只读 Route Handler `src/app/api/reports/hits/route.ts`；证据入口 `src/app/api/reports/evidence/route.ts`（以查看者自己的 AuthContext 调 `explain`）
  - **可点击验收:** `/reports/hits?activityPlanId=<id>&planId=<id>&org=...&staffId=...`；证据抽屉显示圈定 / 内容 / 评论 / 账号四段且不出现正文与评论原文；`content_rows_pruned` 显示「证据已过期」而行保留；`store_staff` 无证据入口且不报错；同一作品在不同账号各一行
  - **依赖:** 任务 6、8
  - **完成（待填）**：

- [ ] P4. 计划看板页面
  - **Requirements:** E-BOARD-1～4、E-AUTH-6
  - **Design:** §8.5、§20.1～20.5
  - **页面文件:** `src/app/(app)/board/page.tsx`；只读 Route Handler `src/app/api/reports/board/route.ts`
  - **可点击验收:** `/board?activityPlanId=<id>&planId=all|<id>`；六张卡片读同一投影；未选单个计划时不显示合并比率；受限范围只含可见分公司、卡片 5 只显示 stale、卡片 6 只显示时间与状态
  - **依赖:** 任务 6、9
  - **完成（待填）**：

- [ ] P5. 指标字典与自定义指标页面
  - **Requirements:** E-CAT-1～8、E-AUTH-4
  - **Design:** §6.5、§9、§20.1～20.5
  - **页面文件:** `src/app/(app)/metrics/page.tsx`；写操作 `src/app/_actions/metrics.ts`（server actions）；如需客户端筛选，只加只读 `src/app/api/metrics/route.ts`
  - **可点击验收:** `/metrics`；内置 / 派生 / 自定义三块；新建自定义指标（两操作数 + 一个运算符、成环拒绝、除零 `—`）；发布产生新 revision 并写审计；归档保留历史可读；`branch_manager` 只读、`store_staff` 无入口；影响面确认弹窗
  - **依赖:** 任务 2、6
  - **完成（待填）**：

- [ ] P6. 下载中心页面
  - **Requirements:** E-EXP-1～11、E-EXP-3、E-EXP-4
  - **Design:** §10、§20.1～20.5
  - **页面文件:** `src/app/(app)/exports/page.tsx`；`src/app/api/exports/route.ts`（列表 / 提交）；`src/app/api/exports/[id]/route.ts`（下载 / 取消 / 重试）
  - **可点击验收:** 从 P1–P3 提交导出后出现在 `/exports`；状态（排队中 / 执行中 / 成功 / 失败 / 已过期 / 含 warning）与行数、大小、过期时间；重新下载返回短期签名地址；取消排队中、重试失败；过期不可下载；无 `report.export` 时导航不出现
  - **依赖:** 任务 6、10a
  - **完成（待填）**：

## 对已有代码与测试的改动（实施时登记）

| 文件 | 改动 | 任务 |
|---|---|---|
| `package.json` | 增加 `exceljs: "4.4.0"`（精确）与 `metrics` 脚本 | 10a / 13 |
| `src/db/schema/index.ts` | 导出 `metrics` | 1 |
| `src/modules/access-control/service-principals.ts` | 增加 `service:metrics-worker` | 6 |
| `src/worker/plan-main.ts` | 注入 `composeDownstream([metrics.downstream])` | 11 |
| `src/modules/activity-plan/downstream.ts` | （待确认，requirements §8 第 12 项）把 `composeDownstream` 放进端口所有者；确认前 E 在 `metrics/downstream.ts` 提供 | 11 |
| `scripts/check-doc-registry.py` | 去掉 `metrics-and-dashboard` | 0 |
| `scripts/` 静态护栏 | 四条：模块边界、A schema 只在 `facts.ts`、导出不碰 schema、除构建器外无代码写 `projection_staff` / `projection_hits`（E-PRJ-12） | 3 / 4b / 10a |
| `.env.example` | `HBECHO_METRICS_*`、`OSS_BUCKET_EXPORT` | 13 |
| `HBECHO设计方案/INDEX.md`、`prd-domain-e-metrics.md`、`prd-platform.md` | 登记与链接 | 0 |

## 必须停下来问

1. **D 的闸门未通过、JP-16 未冻结** → 不开工任务 5b，也不对外声称「已对真实 D 验证」。4a、4b、5、10a、10b 对 fake 端口开发并验收，完成时写明「对 fake 验收」。
2. E-SD-01 投影范围未确认 → 不写任务 4a / 4b 的主循环（其余可以先把表与纯函数做完）。
3. E-SD-04 导出桶未确认 → 任务 10a / 10b 只做 fake store 的离线部分，不做真实桶 smoke。
4. E-SD-05 上限未确认 → 任务 10a 用 design §10.4 的初值，任务 12 实测后调整，不把初值写成「已确认」。
5. D 的 `listPlans` / `explain` 调用方参数 / `describeRun` 任一未提供 → 分别按 design §15.1 退化（列头「判定计划 #ID」并告警；证据入口不展示；圈定导出不可用），不因此改 D 的表；若 D 提供，按它的形状校准。
5a. E-SD-11② 自定义指标的绑定规则未确认 → 任务 2 的绑定与 `cross_plan_operands` 先实现、不对外承诺。
5b. 「已终态批次」的定义与 A 的 current 指针规则不一致（任务 3 核对时发现）→ 停；以 A 为准，回写 design §6.7，并告知刘学奎。
6. 界面设计已于 2026-11-16 确认（design §20.6）→ 可以写 P1–P6 的页面代码，但必须等对应查询 / 导出接口（6–9、10a）完成；界面改动超出 §20.6 的确认范围 → 停，重新请刘学奎确认。
7. 出现「需要改 A / B / D 的表或行为」的想法 → 停；按 design §14 的「不改」清单处理，或另开对齐请求。
8. 出现「用浮点 / `COALESCE(...,0)` / 平均百分比 / 先在专员粒度算自定义指标再求和」的简便写法 → 停；这是指标口径的硬约束（CONTEXT 不变量 14、E §3.6、design §6.5）。
9. 出现「用 `onDeleted` / `onRestored` 通知决定数据能否被查到」「读 `contents.current_snapshot_id` 作基础指标」「预存汇总直接给受限范围」的写法 → 停；见 design §11、§6.3、§8.1。

## 小的判断自己做

- 变量命名、文件拆分、测试组织、日志字段取舍；
- 查询的 SQL 写法与索引选择（只要不改语义）；
- 分块大小、重试节奏（在配置内）；
- 列顺序、页脚文案（不改变口径）；
- 错误码字符串（按 `MetricError` 的类别，稳定后可复用）。