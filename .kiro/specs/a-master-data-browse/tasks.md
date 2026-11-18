# A 主数据浏览（a-master-data-browse）· 实施计划

> **状态**：`draft`
>
> **执行状态**：未实施。requirements/design 边界与界面已于 2026-11-16 经刘学奎确认（design §16.6，含板块 / 店面标准两个筛选），T1 与 T2 可开工；T2 的原型已建并确认。
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-browse`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11.1（2026-11-11，定稿候选）
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16（初建）

## 进度

- [x] 任务 0 · 文档前置与闸门（INDEX、ui-foundation 归属、导入 spec 标注，2026-11-16）
- [x] 任务 1 · Module 读口 `browse`（门店 / 分公司查询 + 六项筛选与选项校验）+ 测试（2026-11-16）
- [x] 任务 2 · `ui-lab` 原型走查与界面确认（design §16.6，2026-11-16）
- [x] 任务 3 · 页面 `/master-data`（2026-11-16）
- [~] 任务 4 · 验收回填、INDEX 状态更新与实施记录（本机全部通过；E1/E2 待部署测试 ECS）

## 依赖图

```text
T0 ──► T1 ──► T3 ──► T4
T2（已完成，2026-11-16 界面确认）
```

- **T1 现在可开工**：读口不依赖界面；六项筛选与选项口径已定（requirements MDB-4、design §5）。
- **T3 只等 T1**：T2 已完成，design §16.6 已填写；页面实现按已确认范围，不再夹带新字段。
- **容易画错的边**：T2 是**确认闸门**而不是「设计工作」——§16.6 的确认人 / 日期 / 范围 / 原型链接已填（2026-11-16），T3 才成立；口头同意不算（`.kiro/steering/structure.md`）。
- **另一条易错边**：T0 的文档改动与 T1 的代码改动会碰同一个 Module 目录（`index.ts`），实施时按任务顺序提交，不要并行写同一文件。

## 任务 0 · 文档前置与闸门

**做什么**

1. 本 spec 四件套交刘学奎审 requirements §2 范围边界、§3 已定决策、design §5 读口契约与 §16 界面；边界批准后才进 T1/T2。
2. `HBECHO设计方案/INDEX.md` 登记本 spec（四件套链接、状态 `draft（未实施；界面未确认）`、路线图位置写「A 域主数据只读浏览」）。
3. `HBECHO设计方案/ui/ui-foundation.md` §3 页面地图拆分「主数据」行（requirements §5 第 1 项）。
4. 在实施分支上，把 `.kiro/specs/a-master-data-import/design.md` §15.3「组织与门店浏览」行标注「由 `a-master-data-browse` 的 D5 于 2026-11-16 取代：改用 `data.master_data.import`；本页归 `a-master-data-browse`」；在该 spec requirements 第 15 项补上本 spec 名字。原行保留。

**文件**：`HBECHO设计方案/INDEX.md`、`HBECHO设计方案/ui/ui-foundation.md`、`.kiro/specs/a-master-data-import/design.md`、`.kiro/specs/a-master-data-import/requirements.md`。

**验证**：`./scripts/verify.sh`（第 7、8 步覆盖链接与登记；第 1–6 步应仍全绿）。

**对应**：requirements §2、§3、§5；design §13。

## 任务 1 · Module 读口 `browse`

**做什么**

1. 新增 `src/modules/master-data-import/browse.ts`：
   - `StoreStatus` / `PageSize` / `BrowseFilter` / `StoreListItem` / `BranchListItem` / `PageResult` 类型；
   - `escapeLike`（转义 `\`、`%`、`_`）与 `assertFilter`（§5.2 的五条，纯函数，导出供单测）；
   - `createBrowse(db)`：`stores(filter, actor)`、`branches(filter, actor)`、`filterOptions(actor)`，按 design §5.3–§5.7 实现；三个方法先 `assertImport(actor)`。
2. `src/modules/master-data-import/index.ts` 增加 `browse: createBrowse(db)`。
3. 测试：
   - `browse.test.ts`（unit）：`escapeLike`、`assertFilter` 的全部拒绝分支、`pageSize` 白名单；
   - `browse.db.test.ts`（db）：用 `tests/harness/` 的组织夹具构造 2 个品牌 × 2 个分公司 × 若干门店（含 `closed`）：
     - 品牌范围：`brandScope` 集合 / `"all"` / 空集合（0 行）；
     - 六个筛选与组合（品牌 / 分公司 / 板块 / 店面标准 / 状态 / 关键字）；非法状态 / 非法 ID / `tier` 与 `tierMissing` 同时给 / 超长关键字 → `invalid_filter`；
     - `filterOptions`：板块名与店面标准只含授权品牌内门店，`storeTiers` 不含空值，`hasMissingTier` 正确；
     - 排序稳定（两次查询同序）、分页不重不漏、`total` 与全量一致；
     - 分公司计数只含授权品牌；无授权门店的分公司计数为 0；
     - 无 Capability → `authorization / forbidden`；
     - 只读：fake 审计 sink 不收到事件；源码静态断言无写语句；
     - 10,000 行规模下单页返回 ≤ pageSize。

**文件**：上列新增/修改；测试文件同目录。

**验证**：`pnpm exec vitest --run --project unit src/modules/master-data-import/browse.test.ts`；`./scripts/with-test-mysql.sh pnpm exec vitest --run --project db src/modules/master-data-import/browse.db.test.ts`；任务边界跑 `./scripts/verify.sh`。

**实施结果（2026-11-16）**：`browse.ts`、`browse.test.ts`（9 例）、`browse.db.test.ts`（11 例）已落地；`index.ts` 导出 `browse`。typecheck 通过，unit 9/9、db 11/11。全量 verify 的数据库步骤受 `activity-plan/scale.perf.db.test.ts` 已知并发抖动影响（与本节改动无关），见文末实施记录。

**对应**：requirements MDB-1～MDB-7、MDB-10；design §5、§6、§8、§11。

## 任务 2 · 原型走查与界面确认

**做什么**

1. 在 `ui-lab/hbecho-ui-v2/` 新增主数据浏览原型（`pages-m-browse.js`），演示两个视图、筛选、分页、空状态与无权限状态；两页顶部有「主数据浏览 ⇄ 主数据导入」共用切换（D6）；数据为虚构，量级取 8,327 家门店 / 42 个分公司。
2. 注册到 `ui-lab/index.html` 与 `ui-lab/hbecho-ui-v2/README.md`。
3. 请刘学奎按「门店视图 → 筛选 → 分公司视图 → 下钻」走一遍，逐条回答 design §16.6 的四个待确认点。
4. 确认后填写 design §16.6（确认人、日期、范围、原型链接）；未确认则**停在这里**，不写 T3。

**当前状态**：已完成（2026-11-16）。原型入口 <http://localhost:4100/hbecho-ui-v2/#/master>；§16.6 已由刘学奎确认，范围含板块、店面标准两个筛选项。

**文件**：`ui-lab/hbecho-ui-v2/` 下新增与登记；`.kiro/specs/a-master-data-browse/design.md` §16.6。

**验证**：`python3 -m http.server 4100 --directory ui-lab` 打开走查；`./scripts/verify.sh` 第 7、8 步。

**对应**：requirements MDB-9；design §16。

## 任务 3 · 页面 `/master-data`

**前置**：T1 完成（T2 已完成，design §16.6 已确认，含板块 / 店面标准筛选）。

**做什么**

1. 新增 `src/app/(app)/master-data/page.tsx`（服务端页面）：
   - `requireUser()` + `import || structure` 判断 + `<DeniedState>`；
   - `masterData()` / `mdActorOf(ctx)`；`view` / 筛选 / 分页参数解析，非法筛选捕获 `MasterDataError("input","invalid_filter")` 显示固定人话；
   - 两个视图的表格、`Pager`、空状态、「清空筛选」；六项筛选的 chip / 下拉与选项（品牌按 `ctx.scope.brands` 裁剪；板块 / 店面标准来自 `browse.filterOptions`）；
   - 分公司行点击 → `?view=stores&branch=<id>`。
2. `src/app/(app)/layout.tsx`：导航 `href` 改 `/master-data`，`also` 覆盖导入与批次。
3. 新增 `src/app/_components/master/tabs.tsx`（`MasterTabs`），导入页顶部接入同一个切换，默认停在「浏览」。
4. `src/app/_lib/master-labels.ts`：增加 `STORE_STATUS`。
5. `src/app/_actions/plan-actions.guard.test.ts`：页面清单与数量 11 → 12。
6. `src/app/globals.css`：增加 `.md-tabs` 样式（复用 `.chip`）。

**文件**：上列。新增 1 个组件、1 个页面；其余是既有文件的小改。

**验证**：`pnpm typecheck`；`./scripts/verify.sh`；本机 `next dev` + 真实登录会话走查（至少：超管、总部人员、分公司人员三种账号）。

**实施结果（2026-11-16）**：页面、切换组件、导航、标签、护栏测试与 `.md-tabs` 已落地。`pnpm typecheck` 通过；unit `browse.test.ts` + `plan-actions.guard.test.ts` 27/27；db `browse.db.test.ts` 11/11；本机 3204 真实登录（平台超管）走查：门店 / 分公司视图、六项筛选、未设置、空状态、分公司行下钻、切换导入页、导航激活均正常。**本机走查发现并修正**：列表 chip 缺 `key` 的 React 警告；`HBECHO_PUBLIC_ORIGIN` 须与端口一致，否则完整刷新时页面内容停在流式占位（与页面代码无关，`/users` 同样表现）。

**对应**：requirements MDB-1、MDB-2、MDB-8、MDB-9；design §7、§16。

## 任务 4 · 验收回填与收尾

**做什么**

1. 按 [`acceptance.md`](acceptance.md) 逐条执行，填写结果与命令 / 文件；未执行的项写明原因，不写「应该通过」。
2. 更新 `HBECHO设计方案/INDEX.md` 本 spec 状态（实现到哪、验证结果、已知未决）。
3. 在本文末写「实施记录」：任务完成情况、改动文件、测试计数、与计划的偏差。
4. 跑一次收尾 `./scripts/verify.sh`。

**验证**：`./scripts/verify.sh`；合并前等 CI（`gh run watch <run-id> --exit-status`）。

**对应**：requirements 全部；acceptance.md。

## 对已有代码与测试的改动（实施时逐条登记）

| 文件 | 改动 | 任务 |
|---|---|---|
| `src/modules/master-data-import/index.ts` | 增加 `browse` 导出 | T1 |
| `src/app/(app)/layout.tsx` | 主数据导航默认落点与 `also` | T3 |
| `src/app/(app)/master-data/import/page.tsx` | 顶部接入 `MasterTabs`（浏览 ⇄ 导入） | T3 |
| `src/app/_components/master/tabs.tsx` | 新增共用切换控件 | T3 |
| `src/app/globals.css` | 增加 `.md-tabs` 样式 | T3 |
| `src/app/_lib/master-labels.ts` | 增加 `STORE_STATUS` 文案 | T3 |
| `src/app/_actions/plan-actions.guard.test.ts` | 页面清单 11 → 12 | T3 |
| `HBECHO设计方案/ui/ui-foundation.md` §3 | 拆分主数据归属行 | T0 |
| `.kiro/specs/a-master-data-import/design.md` §15.3 / `requirements.md` 第 15 项 | 标注被取代、补 spec 名 | T0 |
| `HBECHO设计方案/INDEX.md` | 登记与状态更新 | T0 / T4 |

## 必须停下来问的条件

1. design §16.6 为空，或确认范围不包括本页面 —— 不写页面任务、不写 `src/app/` 代码。
2. 发现需要新增 Capability、修改 `roles.ts` 或 B PRD —— 回到 requirements 决策流程。
3. 发现需要新增表、列、索引或迁移 —— 先改 v2 基线与 ADR，不在本 spec 里直接写。
4. 品牌范围、分公司计数或状态取值出现两种都说得通的读法 —— 用 `AskUserQuestion` 或请刘学奎裁决，不自行冻结。
5. 真实数据出现与设计冲突的形态（例如 `dealer_code` 大量为空、门店跨品牌数据异常）—— 先报告，再决定是否调整列或文案。

## 小的判断自己做

- 排版、列宽、文案标点、空状态措辞（在 design §15 术语内）。
- 测试夹具的具体门店数量与编码（只要覆盖两类状态、两个品牌、两个分公司）。
- `escapeLike` 实现细节、SQL 子句顺序（不改变语义）。
- 页面组件的拆分方式（只要不新增顶层布局、不复制 CSS）。

## 实施记录

### 2026-11-16 · T1 读口

- 新增：`src/modules/master-data-import/browse.ts`、`browse.test.ts`、`browse.db.test.ts`；`index.ts` 增加 `browse` 导出。
- 验证：`pnpm typecheck` 通过；unit `browse.test.ts` 9/9；db `browse.db.test.ts` 11/11（一次性 MySQL 8.4 容器）。
- 已知：全量 `verify.sh` 的数据库步骤在 `src/modules/activity-plan/scale.perf.db.test.ts` 上出现并发抖动（两次全量各失败 1 例，单独复跑 2/2 通过），不在本 spec 范围；未修改该测试。
- 分支说明：T1 最初在 `c-signals` checkout 实施；T3 开工时从 `origin/main` 建工作树 `/Users/liuxuekui/Documents/hbecho-a-master-data-browse`（分支 `a-master-data-browse`），`browse.ts` 与测试、spec 四件套一并迁入（新增文件 + `index.ts` 一行导出，无冲突）。

### 2026-11-16 · T0 / T3 文档与页面

- 分支：`a-master-data-browse`（工作树从 `origin/main` 建）。T0 的 INDEX 登记、ui-foundation 归属拆分、导入 spec 的 design §14.5 / §15.1 与 requirements 第 15 项标注均已完成。
- 新增：`src/app/(app)/master-data/page.tsx`、`src/app/_components/master/tabs.tsx`。
- 修改：`src/app/(app)/layout.tsx`（导航落点与 `also`）、`src/app/(app)/master-data/import/page.tsx`（接入切换）、`src/app/_lib/master-labels.ts`（`STORE_STATUS`）、`src/app/globals.css`（`.md-tabs`）、`src/app/_actions/plan-actions.guard.test.ts`（页面清单 11 → 12）。
- 验证：`pnpm typecheck` 通过；unit `browse.test.ts` + `plan-actions.guard.test.ts` 27/27；db `browse.db.test.ts` 11/11；本机 3204 真实登录（平台超管）走查：门店 / 分公司视图、六项筛选、未设置、空状态、分公司行下钻、切换导入页、导航激活均正常。
- 本机走查发现并修正：列表 chip 缺 `key` 的 React 警告；`HBECHO_PUBLIC_ORIGIN` 必须与端口一致，否则完整刷新时页面内容停在流式占位（既有 `/users` 同样表现，与页面代码无关）。

### 2026-11-16 · T4 验收与收尾

- A19：新增 10,000 行规模用例；db `browse.db.test.ts` 12/12 通过。
- M3 / M4：本机 3204 用李静（分公司，`13800002043`）与王敏（总部，`13800002042`）走查；导航裁剪、直接访问「无权访问」、品牌范围与门店数均符合预期。
- 第一次推送的 CI：run `43797106972` 通过（`verify` 9m26s、`image` 1m36s；分支不推 ACR）。
- 收尾全量 `verify.sh`：unit 1028 通过；db 1455 通过 / 1 跳过 / **1 失败**，失败项是 `src/modules/activity-plan/scale.perf.db.test.ts` 的已知并发抖动（单独复跑 2/2 通过），不在本 spec 范围，未修改该测试；Python 侧本机未验证（工作树环境缺 pytest/ffmpeg，CI 也不验）。
- E1 / E2：2026-11-16 已部署测试 ECS（`…/hbecho/app:8c6b2ff9e9a6`，迁移无新增、只重启 web；健康 ok、新路由未登录 307）；E1 部分完成，登录后的首屏 / 计数与 E2 总部账号对照仍待做（需可用账号）。部署记录见 runbook P6 #47 与 §17。