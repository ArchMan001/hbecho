# 2026-11-16 三处界面改动说明

> **状态**：2026-11-16 已并入批次分支 `fix/ui-batch-2026-11-16`（预览工作树 `~/Documents/hbecho-preview`，未推送、未部署）；效果待刘学奎调整，部分改动尚未实施（见第 4、7 节）
>
> **决策人**：刘学奎
>
> **范围**：登录页与首页品牌、主数据浏览筛选、学习平台两级标签
>
> **用途**：一份可直接评审 / 交接的改动说明；细节合同链接在各节

## 0. 一览

| # | 改动 | 影响页面 | 当前状态 | 页面地址 |
|---:|---|---|---|---|
| 1 | 登录页 / 首页 Echo 品牌与文案 | 登录页、管理端侧栏 | 已改并提交到批次分支（草稿提交 `wip(ui)`），效果待调整，未推送 | `http://localhost:3202/login`（预览）；原型 `http://localhost:4175/g-learning-tags-v2/#/login` |
| 2 | 主数据浏览：店面标准改下拉、搜索加经销商名称 / 编码 | 主数据浏览 `/master-data` | 已实现（悬停多选下拉、大区、经销商搜索），待合并部署 | 原型 `http://localhost:4175/hbecho-ui-v2/#/master`；测试 ECS `/master-data` 为上一版 |
| 3 | 学习平台两级标签 | 标签管理、新建 / 编辑课程、学习中心 | 界面已确认（2026-11-16）；已实现（迁移 `0013`），待合并部署 | `http://localhost:4175/g-learning-tags-v2/#/learning`、`/learning/tags`、`/learning/new` |

## 1. 登录页 / 首页：Echo 品牌与文案

### 1.1 背景

平台原来叫 `hbecho / 新媒体运营平台`，登录页与侧栏没有品牌标记；2026-11-11/12 已定下 Echo 品牌语言与登录页文案，但实现被回滚，线上仍是旧版。2026-11-16 重新确认品牌标记与中文名。

### 1.2 需求与定稿

| 项 | 定稿 |
|---|---|
| 产品名 | **Echo** |
| 中文名 | **新媒体营销平台**（2026-11-16 由「新媒体营销智能体」改） |
| Logo | 17 号「E + 声源点」，无边框；登录页 52px、侧栏 22px |
| 登录页品牌区 | `Echo 新媒体营销平台` **同一行**，下一行 `HISENSE · HITACHI · YORK · KELON`（新增科龙） |
| 首页侧栏 | 保持两行：`Echo` / `新媒体营销平台` |
| 登录 H1 | 内容有标准，/ 发布有回响，/ 增长有数据。 |
| 登录说明 | 从内容生产到效果度量的一站式智能体，让每个账号，都成为品牌的发声场。 |
| 事实区 | **固定展示值**：1,286 家参与门店 / 24,830 条发布视频 / 320.4 万用户互动；不按真实数据计算（推翻此前「必须真算」的写法） |
| 浏览器标题 | `Echo · 新媒体营销平台` |

颜色、登录卡结构、表单、按钮均保持原设计，没有改版。

### 1.3 怎么改

| 文件 | 改动 |
|---|---|
| `src/app/_components/echo-mark.tsx`（新） | E 三横 + 声源点的 SVG 组件，`currentColor` |
| `src/app/_components/auth-shell.tsx` | 登录品牌区：一行 Echo + 中文名、四品牌；登录 H1 / 说明改为 Echo 文案；事实区固定值 |
| `src/app/(app)/layout.tsx` | 侧栏标记换 EchoMark、名称改 Echo / 新媒体营销平台 |
| `src/app/globals.css` | `.auth-logo-mark` 去框、放大到 52px；新增 `.auth-logo-line`、`.auth-logo-brands` |
| `src/app/layout.tsx` | 站点标题改为 `Echo · 新媒体营销平台` |

### 1.4 地址与状态

- 本地完整应用：<http://localhost:3202/login>（`./scripts/preview.sh` 启动，已改）
- 原型：<http://localhost:4175/g-learning-tags-v2/#/login>（独立目录，避免缓存）
- 代码位置：预览工作树 `~/Documents/hbecho-preview` 的批次分支 `fix/ui-batch-2026-11-16`（原先分散在 `hbecho-a-activity-plan` 与 `fix/small-batch-2026-11-16` 两个工作区的未提交改动，补丁内容一致，已合成一份并提交；原目录未改动）
- 品牌文档：[`brand-language.md`](brand-language.md) 已记录中文名、Logo、固定事实区与变更记录

## 2. 主数据浏览：店面标准下拉 + 经销商搜索

### 2.1 背景

主数据浏览页现在有六项筛选：品牌（胶囊）、分公司（下拉）、板块（胶囊）、状态（胶囊）、店面标准（**胶囊**）、关键字。真实库的店面标准有十几种（一级店中店、一级直营KA专业A级店、一级经销商S级店…），用胶囊排不下；关键字目前只匹配门店编码与名称，找不到经销商。

### 2.2 需求

| # | 需求 | 结论 |
|---:|---|---|
| 1 | 店面标准筛选改为**列表 / 下拉**，与分公司筛选一致 | 待实施；无「未设置」时该选项不显示 |
| 2 | 关键字同时搜索**经销商名称 / 经销商编码** | 待实施；匹配范围 = 门店编码 / 名称 / 经销商名称 / 编码，任一命中 |

权限、品牌范围、分页、排序、其他筛选不变。

### 2.3 怎么改

| 文件 | 改动 |
|---|---|
| `src/modules/master-data-import/browse.ts` | 关键字条件增加 `dealers.dealer_name LIKE ?` 与 `dealers.dealer_code LIKE ?`；仍使用 LIKE 转义 |
| `src/app/(app)/master-data/page.tsx` | 店面标准从胶囊改为 `<select name="tier">`（全部 / 各取值 / 未设置）；搜索框 placeholder 改为「门店编码 / 名称 / 经销商」 |
| `src/modules/master-data-import/browse.db.test.ts` | 增加经销商名称 / 编码命中的用例 |
| spec | `a-master-data-browse` 的 MDB-4 与 design §5.4 增加经销商关键字；店面标准下拉与设计 §16.3 一致 |
| ui-lab | `hbecho-ui-v2/pages-m-browse.js` 同步（当前原型仍是胶囊） |

### 2.4 地址与状态

- 原型（当前版本，仍是胶囊）：<http://localhost:4175/hbecho-ui-v2/#/master>
- 测试 ECS：`https://echo.hbmarketer.com/master-data`（已部署上一版，**不含本次两项调整**）
- 状态：**未实施**；需要先改 Module 与页面，再走一批 verify / CI / 合并 / 部署。

## 3. 学习平台：两级标签

### 3.1 背景

标签原为扁平一级（`tags.name` 全局唯一），维度只能写进标签名（`平台-抖音`）；学习中心只能按单个标签筛选。业务实际按平台、板块、阶段、课程类型四个维度使用标签。

### 3.2 需求

1. 两级：一级分类 + 二级标签值；分类允许超管新增、改名，空分类可删；
2. 同一门课在同一分类下可多选；
3. 每门课至少一个标签（沿用 G-D21）；
4. 筛选同类 OR、跨类 AND；
5. 旧标签按第一个 `-` 拆分迁移，保留 `tag_id` 与课程引用；
6. 三处页面都按分类分组：标签管理、新建 / 编辑课程、学习中心筛选。

### 3.3 怎么改（摘要）

- 新增 `tag_categories`；`tags` 加 `category_id`，唯一键改为 `(category_id, name)`；`course_tags` 不变；
- 迁移 `0012`：建分类表、按前缀回填、收紧外键与唯一键；
- Module：分类 CRUD、标签带分类、多标签筛选（同类 OR / 跨类 AND）；
- 三处页面按分类分组；不新增 Capability。

### 3.4 地址与状态

- 学习中心：<http://localhost:4175/g-learning-tags-v2/#/learning>
- 标签管理：<http://localhost:4175/g-learning-tags-v2/#/learning/tags>
- 新建课程：<http://localhost:4175/g-learning-tags-v2/#/learning/new>
- 状态：原型已出，**界面待确认**；生产代码与迁移未实施；详细合同见 [`g-learning-tags-v2`](../../.kiro/specs/g-learning-tags-v2/change-summary.md)

## 4. 共同状态与下一步

| 项 | 登录 / 首页 | 主数据筛选 | 两级标签 |
|---|---|---|---|
| 设计 / 需求 | 已定 | 需求已确认，spec 待补两条 | spec 已写 |
| 原型 | 已更新 | 未更新（仍胶囊） | 已更新 |
| 本地真实应用 | 3202 已改 | 未改 | 未改 |
| 迁移 | 无 | 无 | 需新增 `0012` |
| 界面确认 | 已按你的要求改 | 无需（沿用现有页面） | **待确认** |
| 推送 / 部署 | 未推送 | 未推送 | 未推送 |

建议顺序：

1. 先确认两级标签的三处界面（design §6.6）；
2. 把主数据的两项小改与两级标签的实现一起排期（主数据是小改，标签是独立切片）；
3. 一个批次一次 verify / CI / 合并 / 部署到测试 ECS。

## 5. 地址汇总

| 用途 | 地址 |
|---|---|
| 登录页（本地真实应用） | <http://localhost:3202/login> |
| 登录页（原型） | <http://localhost:4175/g-learning-tags-v2/#/login> |
| 主数据浏览（原型，当前版本） | <http://localhost:4175/hbecho-ui-v2/#/master> |
| 主数据浏览（测试 ECS，上一版） | <https://echo.hbmarketer.com/master-data> |
| 学习中心（两级标签原型） | <http://localhost:4175/g-learning-tags-v2/#/learning> |
| 标签管理（两级标签原型） | <http://localhost:4175/g-learning-tags-v2/#/learning/tags> |
| 新建课程（两级标签原型） | <http://localhost:4175/g-learning-tags-v2/#/learning/new> |

## 6. 相关文档

- 登录品牌：[`brand-language.md`](brand-language.md)
- 主数据浏览：[`a-master-data-browse`](../../.kiro/specs/a-master-data-browse/requirements.md)
- 两级标签：[`g-learning-tags-v2`](../../.kiro/specs/g-learning-tags-v2/change-summary.md)
- 小改动批规则：[`dev-ci-cadence.md`](../../.kiro/steering/dev-ci-cadence.md) 的「小改动批」一节
- 界面预览与协作规则：[`ui-workflow.md`](../../.kiro/steering/ui-workflow.md)；本机入口：[`LOCAL-UI.md`](../../ui-lab/LOCAL-UI.md)
## 7. 批次 `fix/ui-batch-2026-11-16` 当前内容（2026-11-16）
一次验证、一次 CI、一次合并、一次部署（`dev-ci-cadence.md`「小改动批」）。
| # | 内容 | 状态 |
|---:|---|---|
| 1 | 并入 `a-activity-plan` 的 5 个提交：总部提交名单**自动加入分公司**、预检 / 确认弹窗提示「将自动加入」、production capability 按批准名单放行、运维手册记录 | 已并入（merge `7b825ff`）；部署时 web / sync-worker / learning-worker 要换成同一个标签，`sync-worker` 需要其中的 capability 放行 |
| 2 | 登录页 `e=scope` 时不再回跳 `/`（避免与 `/` 之间的刷新循环） | 已提交 |
| 3 | 第 1 项 Echo 品牌（登录页 / 侧栏 / 站点标题 / 品牌语言文档） | 草稿已提交，**待刘学奎调整** |
| 4 | 第 2 项主数据浏览（悬停多选下拉、大区、搜索含经销商）；`/master-data` 面包屑补全 | 已实现（界面 2026-11-16 确认，见 a-master-data-browse design §16.6.1） |
| 5 | 第 3 项两级标签 | **进本批**（刘学奎 2026-11-16 决定与 5 个 a-activity-plan 提交同批提交推送；带迁移与新表，走 `g-learning-tags-v2` spec，迁移号 `0013`）；部署前须在 ECS 库只读核对标签名，确认拆分后不会重名 |
| 6 | 预览统一：`./scripts/preview.sh`、预览造数、4175 总览页与 `LOCAL-UI.md` 改写、页脚与 `/api/health` 显示提交号（镜像构建传入 `GIT_SHA`） | 已提交 |
| 7 | `ui-lab/` 里散在主目录工作区的原型（e-metrics、g-learning-tags-v2、index.html 等）纳入版本管理 | 已提交 |

## 后续小改记录

| # | 日期 | 问题（提出人） | 范围 | 处理 |
|---|---|---|---|---|
| 1 | 2026-11-16 | 新增的悬停下拉筛选按钮倒角太圆（胶囊形），与平台其他选择框（`.chip`，`--radius-chip` 8px）不一致（刘学奎） | 学习中心、主数据浏览的下拉筛选按钮 `.hf-btn`；4175 原型同步 | 分支 `fix/hf-radius`：`.hf-btn` 改用 `var(--radius-chip)`；数量角标仍是小圆点。纯 CSS，无逻辑变化；仍需走一次 CI 才能合并（任何进 `main` 的提交都要 CI 绿） |
| 2 | 2026-11-17 | 部署后 3202 / ECS 上下拉面板里的选项指示框（单选）仍是圆形（刘学奎）；同时要求把「筛选控件方角」写进项目 UI 总规范 | `.hf-opt.radio .hf-box`、`.hf-panel`（14px）、`.tp-chip`（胶囊）；4175 原型同步 | 同分支 `fix/hf-radius`：指示框改 4px 方框 + 勾，面板改 12px，已选标签小条改 8px；规则写入 `ui-foundation` §0 决策记录、§6.3、§6.4「下拉」与 §9 验收清单 |
