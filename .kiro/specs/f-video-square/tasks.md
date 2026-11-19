# F 经销商视频广场（f-video-square）· 任务

> **状态**：`draft`。界面已由刘学奎于 2026-11-19 确认（[design §10.6](design.md)），页面任务已追加在文末（P1–P4）。
>
> **分支与 worktree**：`f-video-square`，预览工作树 `~/Documents/hbecho-preview`（见 `.kiro/steering/ui-workflow.md`）。节奏见 `.kiro/steering/dev-ci-cadence.md`：每个 task 边界本机跑 `./scripts/verify.sh`；整个 spec 推两次（建表迁移完成后一次，收尾一次）。
>
> **更新日期**：2026-11-19

## 依赖图

```text
T0 文档登记 ─┐
T1 迁移（square_brand_policies）─┐
T2 B 改动（Capability / 资源键）─┼→ T3 policy ─→ T5 browse（读口）
                                  └→ T4 filter ──┘
T5 ─→ P1 页面 ─→ P2 AI分析弹窗 ─→ P3 导航与外壳 ─→ P4 预览造数与走查
```

## 任务

- [x] **T0 文档登记**（2026-11-18 起草，2026-11-19 订正）：`INDEX.md` 登记本 spec；`prd-platform.md` F4 行注明首个切片；`ui-lab/README.md` 状态表登记原型；F PRD 版本记录补 F4 首个切片提前（F-D17）。`./scripts/verify.sh` 以批次末次结果为准，见合并说明。
- [ ] **T1 迁移**：新增 `square_brand_policies`（drizzle schema、迁移文件、`brand_id` RESTRICT 外键、`view_mode` CHECK）；`drizzle-kit generate` 不产生新差异；数据库测试覆盖 CHECK 与外键拒绝。推送点 1：本任务完成后推一次。
- [ ] **T2 B 改动（走 B 评审）**：`roles.ts` 增加 `square.read` 授予四个角色；`RESOURCE_KEYS` 增加 `content_square`；`capability-matrix.v1.json` 同步；B PRD §7.3 与全仓库「29 项」措辞同批改为 30 项；B 的静态护栏与矩阵测试全绿。
- [ ] **T3 policy**：`visibleBrands(scope)`（四种情形）、`setBrandPolicy`（仅超管、同事务写审计 `square.policy.change`）、一个 CLI 入口供超管设置（沿用既有 CLI 写法）。测试：requirements R2 全部条目。
- [ ] **T4 filter**：筛选校验与 `LIKE` 转义、`watchUrl` 协议白名单；单测覆盖 R4、R5.3 的全部边界。
- [ ] **T5 读口**：`browse.list` / `browse.options`（design §5）；ScopeStrategy 注册与装配（`constraint: constraintOf`，`contains` 走 `policy.visibleBrands`，见 design §5.2、SQ-D08）；封面批量签名；数据库测试覆盖 design §8 的断言清单。
- [ ] **T6 验收**：对照 `acceptance.md` 逐条自检；`./scripts/verify.sh` 通过；推送点 2。

## 页面任务（界面已确认，依赖 T5）

- [ ] **P1 `/square` 页面**：`src/app/(app)/square/page.tsx`；筛选与分页走 URL（复用 `_lib/plan-url.ts` 的 `hrefWith` / `pageOf`、`FilterCard` / `EmptyState` / `DeniedState` / `PageHead`）；卡片网格；状态矩阵（design §10.4）：加载骨架、两种空态、无权限、错误重试、单卡封面失败占位、「观看」置灰；「参与活动计划」置灰提示「暂未开放」；「官媒阵地」灰色标签。
- [ ] **P2 「AI分析」弹窗**：一个客户端组件，只负责弹窗（「AI分析功能正在开发中」，不发请求）；悬浮出现、触屏 / 窄屏常驻按钮。
- [ ] **P3 导航与外壳**：左侧导航「视频广场」（与「学习」同组，门店端也有入口，按 `square.read` 显示）；`shell.tsx` 面包屑映射。
- [ ] **P4 预览造数与走查**：`tests/demo/preview.ts` 增加广场样本（多品牌、多平台、点赞边界、无链接 / 无封面各一条、一个 `own` 策略品牌）；4400 上按 `ui-foundation.md` §9 清单走一遍并截图；对照 `acceptance.md` M1–M5。
