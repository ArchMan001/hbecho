# A 活动计划（a-activity-plan）· 实施计划

> **状态**：`draft`
>
> **执行状态**：实施中（2026-11-11 起，分支 `a-activity-plan`）。任务 0 已完成（闸门 2026-11-06 通过；v2 §22 与 R2–R4、A v1.11.1、CONTEXT 三条词汇于 2026-11-11 落回）。进度以下方勾选为准
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-activity-plan`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11（定稿候选）
>
> **最近核对**：2026-11-06
>
> **更新日期**：2026-11-06

## 进度

- [x] 任务 0 · 文档前置（v2 修订、A / CONTEXT 订正、INDEX、待确认闸门）
- [x] 任务 1 · schema 与迁移（**完成后推第一次**）
- [x] 任务 2 · `csv-file` 抽取、授权 / 审计 / 错误骨架、测试挂具补充
- [x] 任务 3 · `plan-references`：引用计数与联动内核
- [x] 任务 4 · 计划生命周期：创建、编辑、状态、删除、回收站、变更记录、下游端口
- [x] 任务 5 · 参与关系与负责人名额
- [ ] 任务 6 · 名单模板、文件级校验与预检
- [ ] 任务 7 · 专员自动新建与确认写入（含 tracer 小改动）
- [ ] 任务 8 · 名单解析驱动与结果归并
- [ ] 任务 9 · 名单维护：移出、疑似空账号确认
- [ ] 任务 10 · 每日维护：15 天扫描与回收站清除
- [ ] 任务 11 · 查询、综合状态、名单读取契约、回流文件与 CLI
- [ ] 任务 12 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾（**完成后推第二次**）
- [ ] 页面任务：**本轮不写**。界面设计已于 2026-11-10 确认（design §15.6）；页面任务另行排期，按确认范围拆

## Planning rules

- 每个任务是一个纵向切片：完成后能运行一条命令、看到可验证的结果，而不是只建空表或空 interface。
- 任务边界跑 `./scripts/verify.sh`（typecheck、单元测试、迁移一致、数据库测试、密钥、链接、文档登记）。**不 push**；一个 spec 一条分支 `a-activity-plan`，只推两次：任务 1 完成后（迁移在干净库跑通，同时异地备份）与任务 12 收尾（`dev-ci-cadence`）。
- 默认验收离线：不连 AI Master、不连 OSS、不发起任何外网请求；MySQL 只用 `scripts/with-test-mysql.sh` 的一次性容器或 `_test` 库。
- 目录按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)：领域代码在 `src/modules/activity-plan/`、`src/modules/plan-references/`、`src/modules/csv-file/`，测试与源码同目录（纯函数 `*.test.ts`，需要 MySQL 的 `*.db.test.ts`），迁移在 `drizzle/`，CLI 在 `src/worker/`，fixture 在 `tests/fixtures/roster/`，测试设施复用并补充 `tests/harness/`。
- 不新增未登记的依赖。`csv-parse` 已由 ADR-0014 接受；GB18030 用 Node `TextDecoder`。
- 所有内部 BIGINT 在 CLI / JSON 输出为十进制字符串；外部标识（门店编码、手机号、主页入口）保留原文。
- 数据库测试里对争抢同一行锁的操作顺序 `await`，不用 `Promise.all`；并发用例用显式闸门（design §11）。
- **网络 IO 期间不持有数据库事务**；根任务由 `runTracerRoot` 在事务外运行，settle 才开短事务。
- 付费调用只经现有网关与 capability gate；任何任务都不绕过它，也不新增详情 / 评论任务（`demand` 的静态护栏）。
- 任务 0 未完成前不写迁移；v2 修订未落回正文前不写 SQL。
- fixture 一律脱敏造数；不提交、不复制真实 xlsx。

## 依赖图

```text
任务 0（v2 修订 + 订正 + INDEX + 待确认闸门）
   ↓
任务 1（schema / 迁移）
   ↓
任务 2（csv-file 抽取 + 授权 / 审计 / 错误骨架 + 测试挂具）
   ├──→ 任务 3（plan-references 内核）
   │        ├──→ 任务 4（计划生命周期）──→ 任务 5（参与 + 名额）
   │        │                                   ↓
   │        └──→ 任务 10（每日维护；依赖 3、4）  任务 6（模板 + 预检；依赖 2、4、5）
   │                                              ↓
   │                                           任务 7（专员新建 + 确认写入；依赖 3、6）
   │                                              ↓
   │                                           任务 8（解析驱动 + 归并；依赖 3、7）
   │                                              ↓
   │                                           任务 9（名单维护；依赖 3、8）
   └──────────────────────────────────────────────┐
                                                  ↓
                          任务 11（查询 + 读取契约 + 回流 + CLI；依赖 4、6、8、9、10）
                                                  ↓
                          任务 12（全量离线验收 + 规模演练 + ECS + 文档收尾）
```

容易画错的边：

- 任务 3 **先于**任务 4：计划的暂停 / 删除 / 恢复都要调 `reconcileAccounts`，所以内核先行，生命周期后写；
- 任务 5 的「分公司退出」会移出名单项并重算引用，依赖任务 3；但名单项的**创建**要到任务 7 / 8 才有，所以退出的测试用工厂直接造名单项；
- 任务 6（预检）**不依赖**任务 7：预检只读；
- 任务 10 **不依赖**任务 6～9：它只扫描名单项与计划，测试用工厂造数；
- 任务 8 依赖任务 7 的 `submitRoster` 与 tracer 改动；
- 任务 11 的回流文件依赖任务 8 的 `outcome` 全集，所以排在 8 之后。

## 任务 0 · 文档前置：v2 修订、订正、INDEX、待确认闸门

**目标**：让后面的代码有合法的基线，不让实现偷偷定义表、列或口径。

**动作**

- [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) 落回 design §6.3 的 R1–R4：
  - R1：新增 §22「活动计划」（v2 的 §13 已被「核心查询」占用，2026-11-11 订正），六张新表的字段、约束、索引照抄 design §6.1；开头第 10 条改为「已由 `a-activity-plan` 定义」；概述表数口径先按实际建表数统一（v2 第 8 行写 28、第 56 行与 §4.1 写 30，自相矛盾），再 +6，各处同改；
  - R2：`staff_account_assignments.unreferenced_since` 与索引；注明 `unreferenced_15d` 沿用为「因无计划引用而关闭」，v2 第 487 行关于「恢复时只重开该原因」的描述保持；
  - R3：`import_batches` 增加 `resolving`、`submitter_branch_id`、roster 必填 `plan_id` 的 CHECK，并写明 `plan_id` 不加外键的原因；
  - R4：`import_row_results` 增加 `new_staff`、三个新 `outcome`、`resolve_task_id`；删除「名单导入由 `a-activity-plan` 扩展自己的分类」这句待办。
- [`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md)：
  - R5：§11.2.2 第一层「表头行检测 → 拒绝」改写为「表头必须存在并逐列一致，自动跳过；与模板示例行相同的行标为示例行」，注明依据 F-D10；
  - R6：核对 §11.9 第 5 条已指向 §11.5 的引用定义；
  - 补版本记录（升 v1.11 之后的下一版，标明「订正，非新规则」）。
- [`CONTEXT.md`](../../../CONTEXT.md) 跨域消费词汇增加 Participation、PlanOwner、Roster 三条（R7），只写语义，不写表名。
- `HBECHO设计方案/INDEX.md`：核对本 spec 的登记（初建时已加）；路线图第 5 位状态改为「spec 草案已写」。
- **待确认闸门**：由刘学奎对 design §14 第 2、4、5、6、7 项逐项回复（同意或给出修改）；第 3 项（不做修改主页链接）与第 1 项（本轮无页面）需明确知悉。回复记录写进 design §14 对应行与 §13 的状态列。**✅ 闸门已通过（2026-11-06，刘学奎：design §14 全部按建议采纳；第 1、3 项已知悉）。**
- 若闸门回复改变了 requirements 的解释（例如改成「解析完成后才占名额」），先改 requirements / design 再继续，不让代码走在文档前面。

**验证**

- [ ] `./scripts/verify.sh` 通过；
- [ ] v2 修订逐条与 design §6.1 / §6.2 对应，没有多改或少改；
- [ ] 全仓库搜索「名单导入由 `a-activity-plan` 扩展」「表头行检测」，没有残留的旧写法；
- [ ] design §14 第 2、4、5、6、7 项都有结论与日期。

**Requirements:** 全部；**Design:** §6.3、§13、§14。

## 任务 1 · schema 与迁移

**目标**：空库一次迁移成功；六张新表与三处既有表修改存在；约束能挡住非法状态、重复与平台不一致。

**新增 / 修改**

- `src/db/schema/activity-plan.ts`（新）：`activity_plans`、`activity_plan_sectors`、`activity_plan_branches`、`activity_plan_owners`、`activity_plan_roster`、`activity_plan_changes`；在 `src/db/schema/index.ts` 登记；
- `src/db/schema/accounts.ts`：`staff_account_assignments.unreferenced_since` 与索引；
- `src/db/schema/import.ts`：`IMPORT_STATUSES` 加 `resolving`；`PRECHECK_CLASSES` 加 `new_staff`；`ROW_OUTCOMES` 加三个值；`import_batches.submitter_branch_id`；`import_row_results.resolve_task_id`；roster 必填 `plan_id` 的 CHECK；
- `drizzle/NNNN_activity_plan_schema.sql`：`drizzle-kit generate` 生成；修改既有 CHECK 的部分检查生成结果是 drop / add 而不是重建表；
- `src/db/schema.db.test.ts` 同层补 `activity-plan-schema.db.test.ts`。

**行为**

- 迁移可重复执行（第二次为空操作）；`drizzle-kit generate` 不产生新文件；
- 状态、种类、槽位号、`removed_reason` 等只接受设计里的值；
- `activity_plan_roster` 的 `(plan_id, platform_id)` 复合外键使「平台与计划不一致的名单项」被数据库拒绝；
- `UQ(plan_id, account_id)` 保证同一账号在同一计划里只有一行；
- `(plan_id, branch_id, slot_no)` 主键 + `slot_no IN (1,2)` 保证至多 2 个槽；`UQ(plan_id, branch_id, owner_actor)` 保证同一人不占两个槽；
- `status='deleted'` 当且仅当删除字段齐备（CHECK）；
- 所有指向组织主档 / 批次 / 账号的外键不使用 `ON DELETE CASCADE`；`resolve_task_id` 使用 `ON DELETE SET NULL`；
- 现有的 master-data 与 tracer 测试保持绿（既有 CHECK 的放宽不破坏它们）。

**验证**

- [ ] 空库 `migrate` 成功，再跑一次无变更；
- [ ] 名单项平台与计划平台不一致 → 复合外键拒绝；
- [ ] 同账号同计划插入两行 → 唯一键拒绝；
- [ ] 第三个槽、重复负责人被拒绝；
- [ ] roster 批次缺 `plan_id` 被 CHECK 拒绝；master_data 批次不受影响；
- [ ] `./scripts/verify.sh` 通过；
- [ ] **推第一次**（分支 `a-activity-plan`），`gh run watch <run-id> --exit-status` 等 CI（只在合并前那一次必须等）。

**Requirements:** AP-1～AP-4、AP-6、AP-8、AP-11；**Design:** §6.1、§6.2。

## 任务 2 · `csv-file` 抽取、授权 / 审计 / 错误骨架、测试挂具

**目标**：把后面所有任务要用的地基一次放好；抽取不改变 master-data 的任何行为。

**新增 / 修改**

- 先在 `master-data-import` 里把 `decode` / CSV 解析 / `csvCell` 等改为只经薄封装调用，再把共用部分（文件移动 + 修复 import）移到 `src/modules/csv-file/`，每一步之后跑 master-data 的全部测试（`decodeText`、`parseCsv(bytes, {header, limits})`、`printableSample`、`csvCell`、`buildCsv`）；`master-data-import` 的 `HEADER`、`parseFile`、`buildReturnFile` 保留；
- `src/modules/activity-plan/errors.ts`：`PlanError(category, code, message, detail?)`，category 同 `MasterDataError`（input / authorization / conflict / not_found / limit / configuration）；
- `src/modules/activity-plan/authz.ts`：`PlanActor`、`assert`（Capability → 范围 → 资源谓词，先于任何读库）、`actorFromEnv`（缺任一环境变量启动失败，`platformAdmin` 缺省 false，无全局默认）；
- `src/modules/activity-plan/audit.ts`：`PlanAuditSink` 与事件类型联合（design §9 / AP-14 列出的事件）、`createLogAudit`；
- `src/modules/activity-plan/constants.ts`：限额与版本常量（`TEMPLATE_VERSION='roster-import.v1'`、2,000 行、10 MB、`MAX_NEW_STAFF`、软提示 1,200、块 200、租约 2 分钟、10 分钟、15 天、30 天、示例行）；
- `tests/harness/`：补 `insertStore`、`insertStaff`、`insertPlan`（带板块 / 参与 / 名单项的工厂）、`planActor`（hq / branch / admin / 无范围）、`MemoryPlanAudit`；
- `tests/fixtures/roster/`：脱敏 CSV 骨架与 `README.md`。

**行为**

- 抽取后 `master-data-import` 的全部既有测试不改一行就通过；
- `assert` 对「无 capability」「越品牌」「越分公司」「非创建者」各返回稳定错误，且发生在任何数据库读取之前；
- `actorFromEnv` 缺 `HBECHO_AP_BRANCH_SCOPE` 时失败，不退化成 `all`；
- 审计事件不含整行原文、不含文件内容。

**验证**

- [ ] `pnpm test` 与 `pnpm test:db` 中 master-data 的用例全绿（抽取无行为变化）；
- [ ] `authz.test.ts`：四种拒绝各一个用例；`actorFromEnv` 缺项各一个用例；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-5、AP-14、AP-15；**Design:** §4、§9、§10.1。

## 任务 3 · `plan-references`：引用计数与联动内核

**目标**：所有联动事件走同一个函数；它的事件矩阵被完整测试。

**新增 / 修改**

- `src/modules/plan-references/rules.ts`（纯）：引用定义（含「结束日当天仍算引用」的北京时间日期比较）、事件到 `ReconcileCtx` 的映射常量；
- `src/modules/plan-references/reconcile.ts`：`reconcileAccounts(tx, ids, ctx)`（按 `account_id` 升序加锁；幂等；返回报告）、`referenceCount`、`computeStopAt`、`markGrace`；
- `src/modules/monitoring/set-switch.ts`：账号级**开启**时调用 `markGrace`（design §10.3）；
- `src/acceptance-boundaries.test.ts`：增加护栏——对 `unreferenced_since` 与 `monitoring_closed_reason='unreferenced_15d'` 的写赋值只允许在 `plan-references`（扫描 `src/modules/**` 非测试文件，排除 `src/db/schema/` 与 `drizzle/`，并加反向用例）；`activity-plan` 的 `*.db.test.ts` 纳入 `Promise.all` 扫描；`activity-plan` 不得调用 `insertDemandTask`。

**行为**（逐条对应 AP-11）

- 引用 = 在名单 ∧ 计划采集中（未删除）∧（无结束日 ∨ 今日 ≤ 结束日）；
- `immediate`：引用为 0 且开关开 → 关闭，原因 `unreferenced_15d`；
- `timer`：引用为 0 → 记起点，不关闭；起点 + 15 天已过才关闭；
- 引用 > 0：清起点；因 `unreferenced_15d` 关闭的重开；`manual` 的不动，除非 `trigger='import'`（重开并写 `monitoring_reopened_by_import`）；
- 外部型、无归属、从未入过名单（且非 import）的账号跳过；
- `computeStopAt` 取全部名单项「不再被引用时刻」的最大值；
- `markGrace`：引用为 0 且出现过名单项时把起点重置为现在；
- 同一事件重复调用不写、不审计；
- 上级开关不读不写。

**验证**

- [ ] `rules.test.ts`：结束日前一天 / 当天 / 后一天；无结束日；暂停；删除；
- [ ] `reconcile.db.test.ts`：design §7.7 事件表的每一行各一个用例，加「两个计划引用」「人工关闭不被重开（非 import）」「import 重开人工关闭并有审计」「外部型不动」「从未入名单不动」「重复调用幂等」「`computeStopAt` 取最大值」；
- [ ] `set-switch` 手动开启无引用账号后起点被重置，当天扫描不关闭；
- [ ] 三条静态护栏生效（故意违规的临时代码能让测试失败，提交前撤掉）；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-11；**Design:** §7.7、§10.3。

## 任务 4 · 计划生命周期

**目标**：计划能创建、编辑、暂停 / 归档 / 恢复、删除、从回收站恢复；每一步有变更记录、审计与引用重算。

**新增 / 修改**

- `src/modules/activity-plan/plans.ts`：`create`、`edit`、`setStatus`（pause / archive / resume）、`delete`（预览 / apply）、`restore`、`trash`；
- `src/modules/activity-plan/changes.ts`：变更记录写入；
- `src/modules/activity-plan/downstream.ts`：`PlanDownstream` 与 `noDownstream`；
- `src/modules/activity-plan/visibility.ts`：`visiblePlans(actor)`（过滤 deleted、品牌范围、创建者 / 超管例外）；
- 对应 `*.test.ts` / `*.db.test.ts`。

**行为**（AP-1、AP-2）

- 创建校验：品牌在范围内、平台在支持集合内、板块非空子集、名称 / 说明长度、日期顺序；初始 `collecting`；
- 品牌 / 平台 / 板块没有任何更新路径；命令带这些参数被拒（`immutable_field`）；
- 状态转换仅设计允许的边；非 `collecting` 时冻结相关操作的守卫函数导出供任务 5、7、9 使用；
- 删除：预览不写；apply 在一个事务内：下游在途检查 → 写删除字段 → `reconcileAccounts(immediate)` → 变更记录；事务提交后调用 `onDeleted`；
- 恢复：`now < purge_after`；状态回到 `status_before_delete`；`reconcileAccounts(timer)`；`onRestored`；
- 改结束日后立即对名单账号 `reconcileAccounts(timer)`；
- 创建者谓词：创建者或超管；`hq_manager` 在授权品牌内可见但不可改他人计划。

**验证**

- [ ] 创建的每一种非法输入各被拒绝且零写入；
- [ ] 状态机：全部合法边与至少三条非法边；
- [ ] 删除预览零写入；apply 后计划不出现在 `visiblePlans`；有在途执行（fake 下游）被拒；
- [ ] 删除立即关闭只被本计划引用的账号，另一个有效计划引用的保持开启；
- [ ] 29 天可恢复、31 天不可；恢复后因无引用关闭的账号重开；
- [ ] 下游契约测试：`onDeleted` / `onRestored` 的调用时机在事务提交之后；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-1、AP-2、AP-14；**Design:** §5.1、§7.9。

## 任务 5 · 参与关系与负责人名额

**目标**：分公司能加入 / 退出 / 重新加入；名额占用、已满、豁免、替换、释放都正确，且并发安全。

**新增 / 修改**

- `src/modules/activity-plan/participation.ts`：`join`、`exit`（预览 / apply）；
- `src/modules/activity-plan/owners.ts`：`claimIfNeeded(tx, {plan, branch, actor, possiblyNew})`（design §7.4，锁参与关系行）、`assign`（空槽指派与替换同一命令）、`replace`、`list`、`releaseAll`；
- 对应测试。

**行为**（AP-3、AP-4）

- 加入：计划 `collecting`、分公司有效、范围内；已加入为空操作；
- 退出：事务内——参与关系置 `exited`；该分公司全部 `in_roster` 名单项置 `removed(branch_exit)`；释放全部名额；`reconcileAccounts(immediate)`；变更记录；
- 重新加入：回到 `joined`；名单项保持 `removed`；
- `claimIfNeeded`：豁免（范围 all）、已是负责人、无可能新增行 → 不占；两槽已满 → `owner_slots_full`（带姓名）；否则占用最小空槽；
- `replace`：创建者 / 超管；`collecting` 才可；
- 并发：两个调用抢最后一个槽，恰好一个成功。

**验证**

- [ ] 第 1、2 位占用，第 3 位 `owner_slots_full`，零写入；
- [ ] 豁免、已是负责人、无新增行三种不占用；
- [ ] 退出后名额为空、名单项全部 `removed`、仅本计划引用的账号立即关闭；重新加入后名单项仍为 `removed`；
- [ ] 非 `collecting` 时加入 / 退出 / 替换被拒；
- [ ] 并发抢槽用例（显式闸门，不用 `Promise.all`）；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-3、AP-4；**Design:** §6.1、§7.4。

## 任务 6 · 名单模板、文件级校验与预检

**目标**：上传一份名单，得到一份只读、可追溯的两阶段预检报告；零业务写入。

**新增 / 修改**

- `src/modules/activity-plan/roster/template.ts`：模板（表头、示例行常量）、`buildTemplate()`、`parseRosterFile(bytes)`（经 `csv-file`：大小 / 行数 / 编码 / CSV 结构 / 表头逐列一致 / 自动跳过表头 / 示例行识别）；
- `src/modules/phone/`：`normalizePhone`（`cn-mobile.v1`），与 [`b-access-control`](../b-access-control/design.md)（AX-D18）共用的单一来源；谁先落地谁建，另一方直接引用，不各写一份；
- `roster/classify.ts`（纯）：design §7.1 的 1–13 步，输入行 + 引用读取器（预检用内存快照，确认用事务内实时读取），输出 `{cls, reason, detail, staffId?, storeId?, branchId?}`；文件内重复分组；
- `src/modules/provider-adapter/locator.ts`：导出纯函数 `detectLocatorPlatform`（design §10.2），不改 `classifyLocator` / `checkLocatorPlatform` 行为，补单测（含 `v.douyin.com`、`xhslink.com`、`v.kuaishou.com`、未知域名、无 URL）；
- `roster/local-match.ts`：入口清洗 + 哈希命中 + 原文复核（design §7.3）；
- `roster/precheck.ts`：计划与分公司前置检查 → 内存分类 → 将新建专员 ≤ `MAX_NEW_STAFF` → 单次写入批次与行结果；摘要（含软提示）；
- `tests/fixtures/roster/*.csv`：UTF-8 / BOM / GB18030 同内容；每个错误码至少一个；6 种分类各一。

**行为**（AP-5、AP-6）

- 文件级失败不建批次；
- 预检完成后专员、账号、归属、名单项、负责人行数不变；
- 每个数据行恰好一行结果；`row_no` 从 1；表头与示例行不产生结果；
- 分类优先级与 design §7.1 一致；`known_account_*` 提示不改变预检类；
- 同一输入重复预检结果相同。

**验证**

- [ ] 文件级：10 MB + 1、2,001 行、列数不一致、引号未闭合、编码无法识别、表头改名 / 换序 / 多列 / 少列，逐项零批次；
- [ ] GB18030 与 UTF-8 同内容结果完全相同；
- [ ] `phone.test.ts`：合法（含 `+86`、分隔符）与非法（科学计数法、10 位、非 1[3-9] 开头）；
- [ ] `classify.test.ts`：design §7.1 每个 `reason_code` 一个用例；优先级冲突组合（如手机号无效且门店不存在 → 报手机号）；整组报错三种；
- [ ] 将新建专员 1,001 个整批拒绝且无批次；
- [ ] 预检前后业务表行数快照相等；
- [ ] 软提示：计划已有 1,150 个账号、再提交 100 行 → 摘要 `soft_cap_exceeded=true`，仍可确认；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-5、AP-6；**Design:** §7.1–§7.3。

## 任务 7 · 专员自动新建与确认写入

**目标**：确认后专员建好、能本地归并的行归并完、其余行挂上根任务；中断可续跑。

**新增 / 修改**

- `src/modules/tracer-command/`：`submitRoster(tx, items)` 与 `roster-resolve.v1` canonical command；`insertOrReuse` 拆出「使用已有批次」的变体（design §10.2）；
- `src/modules/orchestrator/tracer-flow.ts`：`profile_only` 分支；成功终态 `summary` 增加 `account_created` / `assignment_created`（design §10.2）；
- `src/modules/activity-plan/roster/confirm.ts`：前置检查 → 名额（任务 5）→ 取租约 → 块循环（design §7.5）→ 收尾；
- `roster/staff.ts`：专员新建（SAVEPOINT + 唯一键冲突 → `conflict`）与审计；
- 对应测试，含 `hooks.afterChunk` / `beforeApply` 注入点（沿用 master-data 的测试手法）。

**行为**（AP-7、AP-8）

- 前置检查任一失败零写入：状态、计划、参与、capability、名额；
- 租约 / fencing / 超时 / 重复确认语义与 master-data 一致；
- 重分类与预检不一致 → `conflict / precheck_stale`；
- 新建专员逐条审计；已存在专员姓名不覆盖，行结果 `staff_name_differs`；
- 本地命中：同专员归并、他人冲突；未命中：根任务挂在同一个 `intake` 同步批次下，幂等键 `roster:<批次>:<行号>`；
- 块内归并的账号 `reconcileAccounts(import)`；
- 批次终态 `resolving` 或 `completed`。

**验证**

- [ ] 2,000 行文件确认完成，汇总与行结果聚合一致；
- [ ] 第 3 块后杀进程再确认：专员数、根任务数、行结果数不重复，前 3 块行的 `outcome` 不被改写；
- [ ] 并发确认只有一个进入 `writing`；接手后旧进程下一块 `lease_lost`；
- [ ] capability 未放行 / 名额已满 / 计划已暂停：各自零写入；
- [ ] 预检与确认之间有人先建了同号专员 → 该行 `conflict`，不产生第二名专员；
- [ ] 根任务数 = 需要解析的行数，且只有一个同步批次；
- [ ] tracer 既有测试全绿（`profile_only` 为新增分支，外部分支行为不变）；
- [ ] 写入期间没有网络 socket；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-7、AP-8；**Design:** §7.5、§10.2。

## 任务 8 · 名单解析驱动与结果归并

**目标**：挂起的行被逐个解析，结果完整归并回行结果、名单与监控；整批完成后一次补抓。

**新增 / 修改**

- `src/modules/activity-plan/roster/resolver.ts`：`runOnce({limit, concurrency})`；
- `roster/settle.ts`：design §7.6 的映射与事务；
- `roster/finalize.ts`：批次完成与 `supplement` 调用（`only:'full'`、`ifOlderThanHours:168`、`apply:true`、幂等键 `roster-refresh:<批次ID>`）；
- `src/worker/sync-wiring.ts` / `sync-main.ts`：`extras.resolveRosters` 装配，共用网关与护栏；`plan resolve --once` 命令所需的装配函数；
- 对应测试（fixture transport）。

**行为**（AP-9）

- 映射表每一行各一个用例；
- 新账号只产生主页调用，没有列表任务；
- 已存在账号在批次完成时触发一次 `supplement`，未满 7 天返回 `not_due`；
- settle 幂等；崩溃重启后已归并的行不重复处理；`resolve_task_id` 为空的 `pending_account` 行落为 `resolve_failed / root_expired`；
- 计划已暂停 / 分公司已退出：`conflict / plan_state_changed`，不建名单项；
- 技术失败不自动重试，行为 `resolve_failed`；
- 驱动不绕过 capability gate；缺 capability 时根任务不运行，行保持 `pending_account`。

**验证**

- [ ] 一批六行（新账号、已存在同专员、归属冲突、专员名额冲突、入口无效、疑似空账号）跑完，行结果 / 名单项 / 账号 / 监控开关逐项符合映射；
- [ ] 疑似空账号：名单项存在，监控目标解析**不含**它；
- [ ] 驱动中途抛错再跑：无重复名单项、无重复审计；
- [ ] `busy` / `retry_wait` 的根任务留待下个 tick；
- [ ] 批次 `resolving → completed`，`summary.confirm.pending_account=0`；
- [ ] 默认测试没有真实供应商调用；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-9、AP-11；**Design:** §7.6。

## 任务 9 · 名单维护：移出、疑似空账号确认

**目标**：业务能把账号移出名单、确认疑似空账号；联动正确。

**新增 / 修改**

- `src/modules/activity-plan/roster/maintain.ts`：`remove`（按账号 / 专员，预览 / apply）、`confirmEmpty`；
- 对应测试。

**行为**（AP-10）

- 移出：状态置 `removed(manual_remove)`，记时间与操作者，`reconcileAccounts(immediate)`；非 `collecting` 被拒；分公司只能移出本分公司项；
- `confirmEmpty`：`data.account.manage` + 账号所属分公司范围；`intake_status` 置 `normal`；审计；
- 重新提交恢复走任务 6 / 7 的 `update` 路径，这里不再造命令。

**验证**

- [ ] 同账号在两个计划：先后移出，第一次保持开启、第二次立即关闭；
- [ ] 暂停状态下移出被拒；
- [ ] 跨分公司移出 / 确认被拒且零写入；
- [ ] 确认前监控目标解析不含疑似空账号，确认后包含；
- [ ] 恢复：移出后重新提交，名单项回到 `in_roster`，不新增第二行；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-10、AP-11；**Design:** §5.3。

## 任务 10 · 每日维护：15 天扫描与回收站清除

**目标**：每天一次、不依赖 OSS、可重复；关闭满 15 天无引用的账号；清除期满的已删除计划。

**新增 / 修改**

- `src/modules/activity-plan/maintenance.ts`：`createPlanMaintenance({db, clock, downstream, audit, config})` → `{ runDaily, runNow }`；两步各自 try/catch；
- `src/worker/sync-wiring.ts` / `sync-main.ts`：`extras.planMaintain` 装配；`plan maintain` 命令；
- 对应测试（`FakeClock`）。

**行为**（AP-12）

- 扫描候选与 `reconcileAccounts(scan, timer, since=computeStopAt)`；
- 清除：先在事务外调下游 `purge`，成功后再在一个事务内按 FK 顺序显式 DELETE；下游失败则不清除该计划（计划行保留，下次重试）；崩溃在两步之间可重入；
- 北京时间 04:00 后每天一次；退避；
- 无 OSS 配置时仍运行。

**验证**

- [ ] 起点后第 14 天不关、第 15 天关；
- [ ] 计划过结束日 15 天后关闭；无结束日不触发；
- [ ] 删除后 30 天内不清除，之后清除；账号 / 归属 / 专员 / 批次行数不变；
- [ ] 下游 `purge` 失败：计划保留，下次重试；
- [ ] 一步失败不影响另一步，报告列出失败步骤；
- [ ] 同一天重复运行不重复关闭、不重复清除；
- [ ] 无 OSS 的装配下维护仍被调度；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-12；**Design:** §7.8。

## 任务 11 · 查询、综合状态、名单读取契约、回流文件与 CLI

**目标**：全部命令可从命令行驱动；读取按范围过滤；D / E 有可依赖的只读契约。

**新增 / 修改**

- `src/modules/activity-plan/query.ts`：计划列表 / 详情（规模计数、参与与槽位、需要的监控判定计划、变更记录）、名单、批次列表 / 详情 / 行、回收站；
- `src/modules/activity-plan/status.ts`：`composeStatus`（纯）；
- `src/modules/activity-plan/reader.ts`：`rosterSnapshot(planId)`；
- `roster/return-file.ts`：回流文件（原 4 列 + 预检分类 / 结果 / 原因；BOM、CRLF、`'` 前缀；原因文案表覆盖全部 `reason_code`）；
- `src/worker/plan-cli.ts` / `plan-main.ts`：design §9 的全部命令；`package.json` 增加 `plan` 脚本；
- 对应测试。

**行为**（AP-13、AP-14）

- 越范围对象表现为稳定的「未找到」；总部批次只给汇总；分公司看到本分公司批次（不限上传人）；
- `composeStatus` 六种取值与 A §11.6 优先级一致；
- `rosterSnapshot` 只含 `in_roster`，移出后立即消失；暂停期间也可读；
- 回流文件只含 `error`、`conflict`、`invalid`、`resolve_failed` 行；
- 影响多个对象的命令默认只预览；无 `--force` / `--skip-auth`；
- 手机号明文输出（D-42）；回流 / 预检下载记审计。

**验证**

- [ ] 分公司 A 看不到分公司 B 的名单与批次；总部拿不到逐行；
- [ ] `composeStatus` 六个 fixture + 优先级冲突组合；
- [ ] `rosterSnapshot` 契约测试；
- [ ] 回流文件：列 / 顺序 / 行号与原文件一致，追加三列；`=cmd` 带 `'` 前缀；
- [ ] CLI：退出码、JSON、未知子命令；缺环境变量启动失败；
- [ ] 所有原因码都有文案（遗漏的测试失败）；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** AP-5、AP-13、AP-14；**Design:** §7.10、§9。

## 任务 12 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾

**目标**：[`acceptance.md`](acceptance.md) 的全部 `[自动]` 项逐条通过；规模数字记录在案；文档状态与索引一致。

**动作**

- 逐条核对 `acceptance.md` 的 `[自动]` 项与测试映射，缺的补测试；
- 规模演练（fixture transport）：2,000 行预检 / 确认 / 解析；1,200 账号的引用重算；记录耗时与内存到 design §12；
- 测试 ECS 上跑 `pnpm test:db`（`server-access.md`：仅 Workbench；一次性库容器、`_test` 库、用完 `down -v`）；
- 人工项 `[手工]`：CLI 走查（M1）、Excel 打开模板并另存为 CSV（M2）、回流文件在 Excel 里打开（M3）；
- 文档收尾：INDEX（§5 矩阵、§7.1 目录登记）、`CLAUDE.md` 代码地图、tracer / full-sync / master-data 的 INDEX 说明中提到「待 `a-activity-plan`」的措辞核对；
- `./scripts/verify.sh` 全绿；**推第二次**；`gh run watch <run-id> --exit-status`；CI 绿后以 `--no-ff` 合并 `main`，合并说明写 run id 与本机 verify 结果。

**验证**

- [ ] `acceptance.md` 所有 `[自动]` 项通过；
- [ ] 规模数字已写入 design §12；
- [ ] 测试 ECS 运行记录（通过数与耗时）已写入 tasks 文末「实施记录」；
- [ ] INDEX 与本 spec 状态一致；
- [ ] 没有 `[环境]` 项被写成已通过而实际未运行。

**Requirements:** 全部；**Design:** §11、§12。

## 需要停下来并报告的情况

出现下列任一情况，停止实现，先改文档或找刘学奎：

1. 需要改 `monitoring_enabled` / `monitoring_closed_reason` 的语义，或与 `a-full-sync` FS-14 冲突（`a-full-sync/tasks.md` 第 9 条）；
2. tracer 改动使既有 tracer / full-sync 测试的期望需要修改（`profile_only` 与 `summary` 字段应是纯新增）；
3. 需要新依赖，或需要网络、真实用户、真实供应商、生产数据的验证；
4. v2 / CONTEXT 与本 spec 冲突，或 B 域 Capability 名称 / 范围语义变化；
5. 想让 `activity-plan` 直接创建详情 / 评论任务，或绕过网关发供应商请求；
6. 单次引用重算超过 10,000 个账号（需要分块与 `reconcile_pending`，design §7.7）；
7. 在界面设计确认范围（design §15.6）之外写页面任务或页面代码；超出已确认范围要先重新确认；
8. 名额占用口径、重开推广规则、表头处理的结论与 design 写法不同（回到任务 0 的闸门）。

## 实施记录

（未开始）
