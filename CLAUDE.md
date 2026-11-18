# hbecho · 新媒体运营平台

把组织、门店、新媒体专员、平台账号、内容与媒资采集为可追溯的事实，再用版本化规则、统一指标与受控访问串成业务链路。当前处于**阶段 1 之前的实现起点**：领域与数据底座基线已完成，基础设施已就绪，**首个纵向切片已落地**（`a-data-foundation-tracer` 任务 1–9 完成、真实 smoke 已执行，2026-11-04 合并 main，进度以其 `tasks.md` 为准）。

## 必读（每次会话）

@.kiro/steering/product.md
@.kiro/steering/tech.md
@.kiro/steering/structure.md
@.kiro/steering/data-discipline.md
@.kiro/steering/server-access.md
@.kiro/steering/no-reinventing-wheels.md
@.kiro/steering/dev-ci-cadence.md
@.kiro/steering/ui-workflow.md

## 权威顺序

冲突时按此顺序裁决，不在代码或局部 SQL 里暗中选择一方：

1. `CONTEXT.md` —— 领域词汇、语义边界、不变量
2. `HBECHO设计方案/domains/data-foundation/database-design-v2.md` —— 数据底座实施基线（35 表：29 张数据底座 + 6 张活动计划）
3. `aimaster接口文档/` 的 V1.2 文档与 `raw3` 实测 —— 外部合同与证据
4. `.kiro/specs/*` —— 各模块需求、设计、任务
5. `HBECHO设计方案/prd-platform.md` —— 产品方向与阶段
6. `HBECHO设计方案/archive/` 与 `HBECHO设计方案/archive/legacy/` —— 仅追溯，不做实现依据

文档状态与导航以 `HBECHO设计方案/INDEX.md` 为准。不可协商条款见 `HBECHO设计方案/governance/constitution.md`。难逆取舍见 `HBECHO设计方案/architecture/adr/`。

## 代码地图

应用代码从 `a-data-foundation-tracer` 开始落地（TypeScript / Node 24 / vitest / Drizzle，pnpm）。目录按 ADR-0013：`src/modules/<模块>/` 领域逻辑，`src/db/` schema，`src/worker/` Worker 与 CLI，`drizzle/` 迁移，`tests/fixtures/` 登记证据（不复制），`tests/harness/` 离线测试挂具。其余是设计基线、探针脚本与门禁脚本：

- `CONTEXT.md`：领域语言
- `HBECHO设计方案/`：唯一设计文档根 —— `INDEX.md`、总 PRD `prd-platform.md`、子 PRD `prd-domain-<代号>-<slug>.md`、数据底座基线、运维手册、开发部署流程、宪法、ADR、统一归档 `archive/`
- `.kiro/specs/`：spec 集；已实施的纵向切片有 `a-data-foundation-tracer`、`b-access-control`、`a-activity-plan`
- `src/modules/access-control/`：访问控制（登录会话、Capability / DataScope、用户管理与导入、出口框架、审计）；**模块外只能从 `index.ts` 导入**（静态护栏 B-AX-14）；CLI 是 `pnpm run access ...`（`src/worker/access-*.ts`），Web 入口：`src/app/api/{auth,health}` 两个 Route Handler，加 9 个页面（登录 / 激活 / 忘记密码 / 修改密码、用户管理、批量导入、审计日志，页面样式是已确认原型的纯 CSS）；页面只经 `src/modules/access-control/web.ts` 与 `services.ts` 取数
- `src/modules/activity-plan/`：活动计划（计划生命周期与回收站、分公司参与、负责人名额、名单导入 `roster/`：模板 → 预检 → 确认 → 解析驱动 → 归并，名单维护、查询与综合状态、`reader.rosterSnapshot` 给 D / E、每日维护 `maintenance.ts`）；`src/modules/plan-references/`：**引用计数与监控联动的唯一实现**（`reconcileAccounts`；只有它写 `unreferenced_since` 与 `unreferenced_15d`，静态护栏守护）；CLI 是 `pnpm run plan ...`（`src/worker/plan-*.ts`），解析驱动与每日维护由 sync worker 装配（`sync-main.ts`）；页面在 `src/app/(app)/{plans,batches,accounts,master-data}/`，服务端动作 `src/app/_actions/{plans,accounts,master-data}.ts`，页面进程装配 `src/app/_lib/plan.ts`（不装配付费网关）
- `.kiro/steering/`：自动加载的精简规则
- `aimaster接口文档/`：供应商合同、探针脚本与 raw3 证据
- `ui-lab/`：可点击界面原型（不进生产构建、不进 `src/app/`；ADR-0013）；本机入口与账号见 [`ui-lab/LOCAL-UI.md`](ui-lab/LOCAL-UI.md)，协作规则见 `.kiro/steering/ui-workflow.md`；`./scripts/preview.sh` 一条命令起 4100（原型）与 4400（造好数据的完整应用）
- `scripts/`：`verify.sh`（唯一验证入口）、文档/密钥门禁与 `preview.sh`（本机预览；造数在 `tests/demo/`，不进 CI、不进镜像）
- `.github/workflows/ci.yml`：CI
- `.githooks/pre-commit`：提交前密钥扫描

目录约定见 [ADR-0013](HBECHO设计方案/architecture/adr/0013-repository-layout.md)；新增一级目录要先改该 ADR。

## 命令

```bash
./scripts/verify.sh          # 唯一的本机验证入口；task 边界必跑
gh run watch <run-id> --exit-status   # 合并前等 CI
```

`verify.sh` 覆盖 Node 版本（`.node-version`，须为 24）、类型检查、离线测试（禁网）、密钥扫描、Markdown 链接、文档登记与 spec 结构。数据库集成测试只在本机一次性 docker MySQL 容器或 CI 的 MySQL 服务容器里跑；没有对应环境时不要声称「数据库测试通过」。

服务器操作一律走 Workbench，见 `.kiro/steering/server-access.md`。

## 绝不可违背（摘要）

完整清单见 `HBECHO设计方案/governance/constitution.md`。最常踩的几条：

- 平台与供应商是两个维度；组织与账号是不同实体，不压成一行
- 外部 ID 按原始文本 + 命名空间；真实 0 / 缺失 / null / 非法四态不互转
- 归属是账号上的当前单一事实；采集不抢占、改绑受审计、不物理删除
- 采集只有一份；三层是活动计划 → 监控判定计划 → 计划看板（`prd-platform.md` §6.11）
- 先落 ODS 再解析；网络 IO 期间不持有数据库事务
- 已返回的页整页处理；检查点只在整页终态后推进
- 未验证的 capability 不得启用；默认测试离线，CI 禁止真实付费调用
- 生产 ECS 永不跑测试；服务器只走 Workbench
- 未决项不得被默认值静默冻结
- 带页面的 spec：界面设计（含线框 / 原型）必须经刘学奎明确确认后才能写页面任务与页面代码；见 `.kiro/steering/structure.md` 与 `HBECHO设计方案/ui/ui-foundation.md` §1

## SDD 适配

- 产品主线：`HBECHO设计方案/prd-platform.md`（总 PRD）；子 PRD 为 `HBECHO设计方案/prd-domain-<代号>-<slug>.md`
- 完整 spec：`.kiro/specs/<name>/`（`requirements.md` / `design.md` / `tasks.md`；`acceptance.md` 在需要时增加）
- 当前实施切片：`.kiro/specs/a-data-foundation-tracer/`（status: draft；任务 1–9 已实现并合并 main，验收见 `acceptance.md`，待确认后升 current；进度看 `tasks.md`）
- 宪法：`HBECHO设计方案/governance/constitution.md`（v0，待逐条确认）
- ADR：`HBECHO设计方案/architecture/adr/README.md`
- 开发与部署流程：`HBECHO设计方案/runbooks/dev-test-deploy-workflow.md`
- 服务器与云资源：`HBECHO设计方案/runbooks/server-operations-runbook.md`
- 分支节奏：一个 spec 一条分支，推两次；详见 `dev-ci-cadence.md`

## 会话开始

先看 `git status --short`、`git log --oneline -10`，以及当前 spec 的 `tasks.md` 勾选状态；不要凭记忆续写。

## 与 Kiro 共存

`.kiro/` 下的 steering 与 specs 是 Kiro 与 Claude Code 共用的真相源：**只读引用，不复制**。同一个 spec 同一时间只用一个工具实施。修改 steering 时必须同步核对其来源文档（`HBECHO设计方案/INDEX.md` §3）。