# F 经销商视频广场（f-video-square）· 任务

> **状态**：`draft`。只列**不依赖界面**的任务。页面任务（`/square` 页面、导航入口、AI分析弹窗）**不得写入本文件**，直到 [design §10.6](design.md) 由刘学奎填写确认。
>
> **分支与 worktree**：`f-video-square`，`../hbecho-f-video-square`。节奏见 `.kiro/steering/dev-ci-cadence.md`：每个 task 边界本机跑 `./scripts/verify.sh`；整个 spec 推两次（建表迁移完成后一次，收尾一次）。
>
> **更新日期**：2026-11-18

## 依赖图

```text
T0 文档登记 ─┐
T1 迁移（square_brand_policies）─┐
T2 B 改动（Capability / 资源键）─┼→ T3 policy ─→ T5 browse（读口）
                                  └→ T4 filter ──┘
（页面任务：等 §10.6 确认后追加，依赖 T5）
```

## 任务

- [ ] **T0 文档登记**（本批已做）：`INDEX.md` 登记本 spec；`prd-platform.md` F4 行注明首个切片；`ui-lab/hbecho-ui-v2/README.md` 登记原型；`./scripts/verify.sh` 通过。
- [ ] **T1 迁移**：新增 `square_brand_policies`（drizzle schema、迁移文件、`brand_id` RESTRICT 外键、`view_mode` CHECK）；`drizzle-kit generate` 不产生新差异；数据库测试覆盖 CHECK 与外键拒绝。推送点 1：本任务完成后推一次。
- [ ] **T2 B 改动（走 B 评审）**：`roles.ts` 增加 `square.read` 授予四个角色；`RESOURCE_KEYS` 增加 `content_square`；`capability-matrix.v1.json` 同步；B PRD §7.3 与全仓库「29 项」措辞同批改为 30 项；B 的静态护栏与矩阵测试全绿。
- [ ] **T3 policy**：`visibleBrands(scope)`（四种情形）、`setBrandPolicy`（仅超管、同事务写审计 `square.policy.change`）、一个 CLI 入口供超管设置（沿用既有 CLI 写法）。测试：requirements R2 全部条目。
- [ ] **T4 filter**：筛选校验与 `LIKE` 转义、`watchUrl` 协议白名单；单测覆盖 R4、R5.3 的全部边界。
- [ ] **T5 读口**：`browse.list` / `browse.options`（design §5）；ScopeStrategy 注册与装配；封面批量签名；数据库测试覆盖 design §8 的断言清单。
- [ ] **T6 验收**：对照 `acceptance.md` 逐条自检；`./scripts/verify.sh` 通过；推送点 2。

## 页面任务（待界面确认后追加）

页面实现要覆盖：`/square` 页面与筛选 URL、卡片网格与悬浮 / 触屏按钮、「AI分析」弹窗、导航入口（含门店端）、`shell.tsx` 面包屑映射、状态矩阵（design §10.4）、`ui-foundation.md` §9 验收清单。**这些条目在 §10.6 填写前不进本文件。**
