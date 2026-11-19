# F 经销商视频广场（f-video-square）· 任务

> **状态**：`draft`。界面已由刘学奎于 2026-11-19 确认（[design §10.6](design.md)），页面任务已追加在文末（P1–P4）。
>
> **分支与 worktree**：`f-video-square`，预览工作树 `~/Documents/hbecho-preview`（见 `.kiro/steering/ui-workflow.md`）。节奏见 `.kiro/steering/dev-ci-cadence.md`：每个 task 边界本机跑 `./scripts/verify.sh`；**本 spec 只在全部做完后推一次**（刘学奎 2026-11-19：CI 额度不够，能不推就不推；不再有「建表后先推一次」）。
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

- [x] **T0 文档登记**（2026-11-18 起草，2026-11-19 订正）：`INDEX.md` 登记本 spec；`prd-platform.md` F4 行注明首个切片；`ui-lab/README.md` 状态表登记原型；F PRD 版本记录补 F4 首个切片提前（F-D17）。
- [x] **T1 迁移**：`square_brand_policies`（`src/db/schema/square.ts`，迁移 `0015_f_square_policies`）；`square-schema.db.test.ts` 覆盖 CHECK、外键、RESTRICT、一品牌一行；`drizzle-kit generate` 无新差异。
- [x] **T2 B 改动**：`roles.ts` 增加 `square.read`（四个角色）；`RESOURCE_KEYS` 增加 `content_square`；`capability-matrix.v1.json` 同步（30 项）；B PRD v1.22 / B-D39；`roles.test.ts`、`acceptance-boundaries.test.ts` 改为 30 项并把 `square` 前缀纳入 Capability 字符串扫描。
- [x] **T3 policy**：`policy.ts`（`visibleBrands`、`setBrandPolicy`、`listBrandPolicies`、`createSquareStrategy`）；CLI `pnpm square policy list | set --brand <编码> --mode all|own`（`worker/square-cli.ts`、`square-main.ts`）；审计事件 `square_policy_changed`（高风险，同事务）。
- [x] **T4 filter**：`filter.ts`（校验、`LIKE` 转义、`watchUrl` 白名单、点赞区间）；`filter.test.ts`。
- [x] **T5 读口**：`browse.ts`（`list` / `options` / `get`）、`assemble.ts`（封面签名器来自 `OSS_BUCKET_MEDIA`，缺配置时全部占位并告警）；`browse.db.test.ts`。
- [x] **T6 验收**：`acceptance.md` A1–A19 自动验收已通过；本机 `./scripts/verify.sh` 通过（2026-11-19，Python 侧未验证）；推送一次。合并与部署另行：CI 绿后 `--no-ff` 合并，部署前先说明并得到同意。部署只需：迁移 0015 前做逻辑备份；`/data/app/web.env` 追加 `HBECHO_SQUARE_CREDENTIALS=ecs_role`（实例角色 `hbecho-ecs-role` 对 `hbecho-media` 已有读权限，2026-11-19 用 `ossutil --mode EcsRamRole` 实测可列可读，不改 RAM；地域沿用已有的 `HBECHO_COURSE_OSS_REGION`）；`pnpm square policy set` 按需给品牌设 `own`。Python 侧同日已验证（36 例通过）。

## 页面任务（界面已确认，依赖 T5）

- [x] **P1 `/square` 页面**：`src/app/(app)/square/page.tsx` + `_card.tsx` + `loading.tsx`；筛选与分页走 URL（`_lib/square-url.ts`，含 kind=all 必须保留的处理，`square-url.test.ts`）；状态矩阵：骨架、两种空态、无权限、「筛选条件无效」、单卡封面占位、「观看」置灰；「参与活动计划」置灰「暂未开放」；「官媒阵地」灰色标签。
- [x] **P2 「AI分析」弹窗与界面示意页**：`_components/square.tsx`（弹窗、下拉、灰色标签）+ `(app)/square/[id]/ai/page.tsx`（D10）。
- [x] **P3 导航与外壳**：`(app)/layout.tsx` 按 `square.read` 显示「视频广场」（四个角色都有，含门店专员）；`shell.tsx` 面包屑；新增 `external` / `thumb` / `comment` / `send` 图标。
- [x] **P4 预览造数与走查**：`tests/demo/preview.ts` 增加广场样本（四个品牌 × 三个平台、点赞边界、缺链接 / 缺评论 / 缺封面、外部账号）；本机在临时端口用真实登录抓取页面 HTML 与无头 Chrome 截图核对过列表页与示意页，并用 CLI 把品牌设为 `own` 验证页面收窄。**4400 上的走查与截图存档（`ui-foundation.md` §9 清单）由刘学奎对重启后的预览完成。**
