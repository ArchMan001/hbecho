# E 全量明细与导出（e-metrics-lite）· 任务

> **状态**：`draft`。**界面已确认（2026-11-19，design §10.6）**，U1–U5 与命名已答复（requirements §7）；页面任务可展开。
>
> **分支与 worktree**：分支 `e-metrics-lite`，纯文档与读口 / 导出阶段用独立工作树 `../hbecho-e-lite`；进入页面阶段后，页面任务在预览工作树 `~/Documents/hbecho-preview` 做（见 `.kiro/steering/ui-workflow.md`）。节奏见 `.kiro/steering/dev-ci-cadence.md`：每个 task 边界本机 `./scripts/verify.sh`；**本 spec 只在全部做完后推一次**；「推送到 GitHub」须刘学奎明确说出口。
>
> **前置**：D 的任务 17（JP-22）先做完并合并。任务 T1–T3 不依赖 D 的任务 17，可并行。
>
> **更新日期**：2026-11-19

## 依赖图

```text
T0 文档登记与决策订正 ──────────────────────────────┐
D17（D 的 JP-22：读口 + ability_results 迁移与聚合）─┼→ T4 read（编排）──┬→ T6 导出路由 ─→ T7 CLI ─→ T8 验收
T1 report 策略 ─┐                                    │                  │
T2 列与单元格纯函数 ┼────────────────────────────────┤                  │
T3 A 侧读取（facts）┘                                 └────────────────┘
T5 exceljs 与导出器 ────────────────────────────────────────→ T6
P0 原型与界面确认（闸门）──→ P1…（确认后才展开）
```

## 任务

- [x] **T0 文档登记与决策订正**（2026-11-19）：
  - `INDEX.md`：登记本 spec（§5 表、§7 路线图、§7.1 命名表）；E PRD 行补「1.0 全量明细由 `e-metrics-lite` 交付」；
  - `prd-domain-e-metrics.md`：E-D02、E-D09 原行保留加删除线并写「由 E-D23 于 2026-11-19 修订」；新增 E-D23；版本记录 v1.1.3；§6.3、§十 不做表第 4 项、§十二 修订清单第 1 项、范围表同步标注；
  - `e-metrics` requirements / design 凡引用 E-D02 / E-D09 / 全量内容明细处加注；`f-video-square` design 第 280 行加注；
  - D：`requirements.md` 追加 JP-22；`design.md` §10.4 增加第 7–9 项与 D-D23；`tasks.md` 追加任务 17；
  - 本地 `python3 scripts/check-doc-links.py` 与 `check-doc-registry.py` 通过；全量 `./scripts/verify.sh` 见 T8。
- [ ] **T1 `report` 范围策略**（对应 EL-9）：`src/modules/report-detail/authz.ts`（`ReportRef`、`reportStrategy`、`registerReportAuthz` 先查再注册）；页面进程与 CLI 装配处调用。测试：`contains` 对品牌 × 分公司的组合（范围 `all` / 子集 / 空）、`constraint` 等于 `constraintOf`、重复注册不抛、四个角色经 `authorize(report.read)` 的结果、`store_staff` 的 `report.export` 被拒。
- [ ] **T2 列与单元格纯函数**（对应 EL-3、EL-4、EL-5）：`columns.ts`（固定列常量逐字对照需求表；`baseName`、`dedupe` 在全集上算再取子集；昵称列头随平台）、`cells.ts`（`contentCell`、`accountCell`、`safeText`、北京时间格式化、互动值四态）。测试：列头四条规则各一例 + 两表同条件列头一致；每种条件 × 每种状态 × 「没评估到」两来源；`unobtained` 写原因码、绝不写 `0`；19 位 ID 作文本；公式前缀。**纯函数，不依赖数据库。**
- [ ] **T3 A 侧读取**（对应 EL-3、EL-5、EL-7、EL-10）：`facts.ts`：组织与专员名称、内容与冻结快照、cutoff 之前最新主页快照（`ROW_NUMBER()` 取 `(logical_at, batch_id)` 最新）、主页链接、两类采集状态、已采集作品数（U2 默认口径）、封面 / 头像 / 背景引用与签名。数据库测试（`*.db.test.ts`）：cutoff 之后到达的批次与快照不被选中；`archived` / `carried_forward` 取、`failed` / `pending` 不取；采集状态四种（是 / 部分 / 否 / 无记录）；缺失值留空并计入 `missingRows`；一页一类一条查询（断言查询数，防 N+1）。
- [ ] **D17 D 的 JP-22**（在 D 的 `tasks.md` 任务 17 里实施，本 spec 依赖它）：读口三处补全 + 迁移 `0016_d_ability_results` + `abilityOutcomes` 纯函数与聚合接入；`/judgement/results/[runId]` 占位页改跳转（EL-D18：**不在 D 页面加「全量明细」按钮**）。验收见 D 的 JP-22。**不改任何判定语义**：D 现有全部测试须原样通过。
- [ ] **T4 编排**（对应 EL-1、EL-2、EL-5、EL-6、EL-10、EL-11；依赖 T1–T3、D17）：`read.ts`：`videos` / `accounts` / `executions` 与 §5.2 的十步；`ReportError` 的全部码；`videosAvailable` / `abilityResultsAvailable` 标志。测试：fake `JudgementOutcomeReader` 覆盖无执行、历史执行切换、内容级行已清理、旧执行无 `ability_results`、四个角色的行集与总数、越范围 `not_found`；契约测试与 D 真实实现共用一份 shape 测试（含 `ConditionDesc.key ↔ evidence.l1.idx`）。
- [ ] **T5 exceljs 与导出器**（对应 EL-8；U1 已确认走同步流式，EL-D16；同时在 ADR-0011 补两处：豁免条件、「流式写入器实测后定」改由本任务回填）：`package.json` 加 `exceljs` **精确 `4.4.0`**（不加 `^`）；`export.ts` 用 `stream.xlsx.WorkbookWriter` 写两个 sheet；`safeText`、文本单元格、着色、冻结首行。测试：往返读回（读取代码只在测试里，生产代码零 `xlsx.read` / `xlsx.load`，加一条静态检查）、`addImage` 零调用、`export_row_limit` 不产生字节、并发上限 `export_busy`、中途失败终止连接。**规模实测**：用 D 的规模演练数据（D design §12.1）与一份 1.4 万行视频的夹具，记录耗时与峰值 RSS；超过 design §7.2 的阈值就停下来找刘学奎改异步。
- [ ] **T6 导出路由与出口守卫**（对应 EL-8、EL-9；依赖 T4、T5）：`src/app/(app)/reports/[planId]/export/route.ts`：参数 zod、`guardExit(4)`、行数预检、响应头与文件名、警告头 `X-Report-Warning`、审计。测试：`store_staff` 被拒并记审计；撤权后的提交；范围收缩；文件名非法字符。**这是路由，不是页面：不含任何 UI。**
- [ ] **T7 CLI**（对应 EL-3 至 EL-8，页面确认之前的验证手段）：`src/worker/report-cli.ts`、`report-main.ts`、`package.json` 的 `report` 脚本：`pnpm report columns --plan <id> [--run <id>]` 打印两张表的表头；`pnpm report export --plan <id> [--run <id>] --actor <用户> --out <文件>` 以指定用户身份导出到本地文件。测试：离线、fake 依赖；沿用 `judgement-cli` 的装配方式与退出码。
- [ ] **T8 验收**：`acceptance.md` 的 A1–A22 自动项全绿；本机 `./scripts/verify.sh` 通过；规模实测结果写入 design §7.1 / §12；对着一份真实执行（日立或海信）与旧系统导出核对行数与至少三个账号（M1、M2，需测试 ECS 数据，先说明并得到同意，`server-access.md`）。**页面验收在页面任务做完之后单独记。**

## 页面任务（界面确认后才展开）

- [x] **P0 原型与界面确认（闸门）**（2026-11-19）：原型 `ui-lab/e-metrics-lite/`（4100：<http://localhost:4100/e-metrics-lite/#/results>）经刘学奎确认，记录见 design §10.6；确认时的修改：导航与页面标题「活动计划判定结果」，导出文件名保留「全量明细」，D 的页面不加按钮。确认范围之外的界面改动要重新确认。
- [ ] **P1 导航与落地页**（依赖 T4）：`(app)/layout.tsx` 与 `shell.tsx` 增加「活动计划判定结果」导航（四个角色都有，门店端也有；Capability `report.read`）；`/results` 落地页列出范围内的判定计划（别名、活动计划、平台、最近一次完成、状态），无已完成执行的计划也能点进去。
- [ ] **P2 `/reports/[planId]` 页面**：两个标签（视频明细、账号维度）、执行切换、筛选（大区 → 分公司 → 板块 → 门店级联 + 专员搜索）、分页（URL 参数）、能力列与单元格着色、「跳到能力列」、缩略图放大、四类提示条；状态矩阵（design §10.4）全部实现；导出按钮对无 `report.export` 的角色隐藏。
- [ ] **P3 导出对话框与下载**：导出弹窗（sheet 与表头预览、行数、文件名、`export_row_limit` 与不生成 sheet 的提示）；点「开始导出」走 T6 的路由下载。
- [ ] **P4 D 占位页跳转**：`/judgement/results/[runId]` 改为跳转到 `/reports/<planId>`（EL-D18，不加按钮），属 D 任务 17 的页面部分。
- [ ] **P5 预览造数与走查**：`tests/demo/preview.ts` 增加：一个有 3 次执行（最近一次完整、旧执行无 `ability_results`、内容已清理）的判定计划与一个无已完成执行的判定计划；4400 上按 `ui-foundation.md` §9 清单走查，截图存档；业务走一遍（M5）。

## 不在本 spec 的任务

- 下载中心、异步导出、点检表 / 看板 / 指标字典：归 `e-metrics`（「报表与看板」导航也归它；本 spec 只加「活动计划判定结果」）；
- 对 `ui-foundation.md` 的修改：本 spec 沿用现有组件，图片放大已在 P0 原型里确认，实现时若需要新组件，再落 `ui-foundation.md`。
