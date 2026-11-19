# F 经销商视频广场（f-video-square）· 设计

> **状态**：`draft`（界面已确认，见 §10.6）
>
> **权威来源**：[requirements.md](requirements.md)；数据基线 [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md)；界面基线 [`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md)
>
> **更新日期**：2026-11-19（经审查订正：D 状态、ScopeStrategy、平台枚举、字段出处；界面确认入档）

## 1. 一句话方案

新增一个只读 Module `src/modules/video-square/`：按筛选条件查询「可见品牌内、有归属、点赞 >50」的内容 current 快照，返回卡片所需的最少字段；一个服务端页面 `/square` 渲染筛选与卡片网格。权限用新 Capability `square.read`，跨品牌范围由一张小表 `square_brand_policies` 控制。不引入新依赖，不改既有表。

## 2. 形状

| 需要 | 结论 | 理由 |
|---|---|---|
| Module | **新建** `src/modules/video-square/`（`browse.ts`、`policy.ts`、`filter.ts`、`index.ts`） | 查询、策略、筛选校验三个职责；不并入 `learning` 或 `master-data-import` |
| 页面 | **新建** `src/app/(app)/square/page.tsx` + 一个客户端组件文件（下拉筛选、「AI分析」弹窗、灰色标签提示）+ `src/app/(app)/square/[id]/ai/page.tsx`（AI分析界面示意页） | 筛选与分页走 URL，其余服务端渲染 |
| 表 | **新增 1 张** `square_brand_policies` | 控制「哪个品牌能看别的品牌」；Capability 是角色矩阵，表达不了品牌维度 |
| 依赖 | **无新增** | drizzle、既有 `MediaObjectStore.signedGetUrl`、既有 UI 组件 |
| 原型 | **已建** `ui-lab/f-video-square/`（独立目录，`pages-f-square.js`），路由 `#/square`、`#/square/ai/<id>` | 走查用，不进生产构建 |

## 3. 边界阶梯（no-reinventing-wheels）

1. **代码库已有**：`createAuthorizer` + `createEgress`（学习模块的装配方式）、`DataScope.brands`、`MediaObjectStore.signedGetUrl`、`FilterCard` / `Dialog` / `EmptyState` / `DeniedState` / `PageHead`、`_lib/plan-url.ts` 的 `hrefWith` / `pageOf`、`valueStateCheck` 的五态约定。
2. **标准库 / 框架**：筛选与分页放 URL（Next.js `searchParams`），不引客户端状态库。
3. **开源**：不适用；列表查询是本项目数据模型上的一条 SQL，没有现成库可替代。
4. 结论：**自建 Module，无新依赖**。「不用它做什么」：不用全文检索引擎做标题搜索（见 §9 上限）。

## 4. 数据模型

### 4.1 新表

```sql
square_brand_policies (
  brand_id          BIGINT PK  → brands(brand_id) RESTRICT   -- 观看者品牌
  view_mode         VARCHAR(8) NOT NULL CHECK (view_mode IN ('all','own'))
  updated_by_actor  VARCHAR(128) NOT NULL
  created_at        DATETIME(6) NOT NULL   -- UTC
  updated_at        DATETIME(6) NOT NULL
)
```

没有行 = `all`。表里只有「被限制」的品牌才需要行（`own`）；设回 `all` 可以更新为 `all`，也可以保留行，读口只看值。

### 4.2 读取的既有数据（只读）

| 卡片 / 筛选 | 来源 |
|---|---|
| 内容与类型 | `contents`（`status='active'`、`content_kind`、`current_snapshot_id`、`platform_id`） |
| 标题、发布时间、点赞、评论、链接 | `content_snapshots`，经 `contents.current_snapshot_id` 联接，只取 `snapshot_status='finalized'` |
| 账号名 | `external_accounts.current_profile_snapshot_id` → `account_profile_snapshots.nickname` |
| 品牌 / 分公司（当前归属） | `staff_account_assignments`（`watch_type='staff'`、`slot_released_at IS NULL`、`UQ(account_id)`）→ `media_staff` → `stores`（`brand_id`、`sector_id`）→ `sectors.branch_id` → `branches` |
| 封面 | `media_references`（`content_snapshot_id` = 当前快照、`role='cover_normalized'`、`slot_index=0`、`archive_status IN ('archived','carried_forward')`）→ `media_assets.oss_object_id` → `oss_objects.object_key` → `signedGetUrl` |
| 平台 | `platforms` |

品牌与分公司取**当前归属**（D4）。理由：一次联接即可，不必在 `content_discoveries` 的多批次行里挑一行。已知差异：账号改绑后，旧作品跟随新归属。

## 5. Module 契约

### 5.1 类型（`src/modules/video-square/browse.ts`）

```ts
export interface SquareFilter {
  brandId?: string;            // 十进制字符串；缺省 = 全部（在可见集合内）
  platformCode?: (typeof SEGMENT_PLATFORMS)[number];   // 复用 db/schema/signals 的代码枚举，不另写字面量；选项仍数据驱动（§5.6）
  kind: 'video' | 'image' | 'all';          // 缺省 'video'
  branchId?: string;
  withinDays?: 7 | 30 | 90 | 180;
  likeBand?: '51-100' | '101-300' | '301-500' | '501+';
  activityPlanId?: string;     // 本切片内传入即抛 plan_filter_unavailable（U2 定后打开）
  q?: string;                  // ≤100 字
  page: number;                // 1 起；每页固定 20
}
export interface SquareCard {
  contentId: string;
  title: string;
  likeCount: string;           // 十进制字符串，总是 state=value 的值
  commentCount: string | null; // 非 value 为 null，页面显示 —
  brand: { id: string; name: string };
  accountName: string | null;
  platform: { code: string; name: string };
  kind: 'video' | 'image';     // text 并入 image
  coverUrl: string | null;     // 签名 URL；缺失或签名失败为 null
  watchUrl: string | null;     // 仅 http/https；否则 null
  publishedAt: string | null;  // ISO UTC
}
browse.list(actor, filter): Promise<{ items: SquareCard[]; total: number; page: number; pageCount: number }>
browse.options(actor):      Promise<{ brands; platforms; branches }>   // 数据驱动，按可见范围收窄
```

### 5.2 授权与可见品牌

```text
list/options:
  1. authorizer.require(actor, 'square.read', resource 'content_square')     // 无则抛授权错误
  2. scope = actor.dataScope；isEmptyScope(scope) → 授权错误（不回退为全部）
  3. visibleBrands = policy.visibleBrands(scope)                              // §5.3
  4. 校验 filter（§5.4）；brandId 不在 visibleBrands → invalid_filter
  5. 查询（§5.5）
```

`content_square` 的 ScopeStrategy 照 `learning/visibility.ts` 同构：`constraint: constraintOf`（如实反映 B 授予的范围，空范围 `empty:true`；它是同步纯函数，读不了策略表，所以**不**把策略并进去，也**不**恒返回 `brands:'all'`），`contains(scope, {brandId})` 为「范围非空且 `brandId ∈ policy.visibleBrands(scope)`」（`contains` 是异步，可读策略表）。可见品牌**只有一个来源**：`policy.visibleBrands`，列表 SQL、`options`、`contains` 都从它取。注意：广场可见范围可以**宽于** B 的范围（策略为 `all` 时），所以下游不得拿 `scopeFor('content_square')` 当可见范围用；要判断某品牌的作品能否被某人看到，调 `contains`。装配沿用 `learning/runtime.ts` 的 `defaultRegistry.registerScopeStrategy` 写法。

### 5.3 `policy.visibleBrands(scope)`

```text
scope.brands == 'all'                         → 全部品牌
scope.brands 为空集合                          → 空（调用方当作授权错误）
任一 b ∈ scope.brands 其策略 ≠ 'own'（含无行）  → 全部品牌
否则（全部授权品牌都是 'own'）                   → scope.brands
```

对多品牌用户取并集（更宽松），已写入 requirements R2.3。`setBrandPolicy(actor, brandId, mode)` 要求超管，同事务写策略与 `square_policy_changed` 审计，不跨网络 IO。

### 5.4 筛选校验

固定顺序，首个失败即抛 `SquareError("input", "invalid_filter", …)`：`kind`、`platformCode` 取值；`brandId`、`branchId` 是合法十进制且在可见集合；`withinDays`、`likeBand` 在固定枚举；`q` ≤100 字；`activityPlanId` 非空 → `plan_filter_unavailable`；`page` ≥1。**拒绝即错误，不静默放宽**。

### 5.5 查询（概要）

```sql
SELECT c.content_id, s.title, s.like_value, s.comment_value, s.comment_state, s.share_url,
       s.published_at, c.content_kind, pl.code, b.brand_id, b.brand_name, p.nickname, ...
FROM contents c
JOIN content_snapshots s  ON s.content_id = c.content_id AND s.content_snapshot_id = c.current_snapshot_id
JOIN external_accounts a  ON a.account_id = c.account_id
LEFT JOIN account_profile_snapshots p ON p.profile_snapshot_id = a.current_profile_snapshot_id
JOIN staff_account_assignments sa ON sa.account_id = c.account_id
     AND sa.watch_type='staff' AND sa.slot_released_at IS NULL
JOIN media_staff ms ON ms.staff_id = sa.staff_id
JOIN stores st      ON st.store_id = ms.store_id
JOIN brands b       ON b.brand_id = st.brand_id
JOIN sectors sec    ON sec.sector_id = st.sector_id
WHERE c.status='active'
  AND s.snapshot_status='finalized'
  AND c.content_kind IN (:kinds)                          -- kind=video → ('video'); image → ('image','text'); all → 三者
  AND s.like_state='value' AND s.like_value > 50          -- 恒定条件
  AND (:visibleBrands IS 'all' OR st.brand_id IN (:visibleBrands))
  AND (:brandId IS NULL OR st.brand_id = :brandId)
  AND (:platform IS NULL OR c.platform_id = :platformId)
  AND (:branchId IS NULL OR sec.branch_id = :branchId)
  AND (:withinDays IS NULL OR s.published_at >= :utcNowMinusDays)
  AND (:likeBand IS NULL OR s.like_value BETWEEN :lo AND :hi)
  AND (:q IS NULL OR s.title LIKE :likePattern ESCAPE '\\')
ORDER BY s.like_value DESC, c.content_id DESC
LIMIT 20 OFFSET :offset
```

- 点赞的 `like_state='value'` 与数值条件**必须同时写**，不依赖 NULL 语义（五态约定，见 `valueStateCheck`）。
- 总数与列表用**同一条 WHERE**（拆出共用的条件构造函数），保证「共 N 条」与分页一致。
- 封面在列表取出 `content_snapshot_id` 后一次批量查 `media_references`，再逐个签名；任一签名失败只让该卡片 `coverUrl=null`。
- `watchUrl`：解析 `shareUrl`，仅 `http:` / `https:` 时返回，否则 `null`。
- `likeCount`、各 ID 以十进制字符串出 Module（BIGINT 约定）。

### 5.6 `options(actor)`

在同一可见范围与恒定条件下取 `DISTINCT` 品牌、平台、分公司，供芯片与下拉。单独一条查询，不随筛选联动（单选芯片不做互相收窄，避免「选了品牌后平台只剩一个」的跳变；可以以后再做）。

## 6. 为「参与活动计划」预留的契约（U2 定后启用）

D 的设计里「某内容在某执行中合格」是 `run_contents.final='pass'`；某判定计划当前结果是最近一次 `completed` 的 `execution`（d-rule-engine design §7.11），**不按版本号取**。启用时在 §5.5 追加：

```sql
AND EXISTS (
  SELECT 1 FROM judgement_plans jp
  JOIN judgement_runs r ON r.plan_id = jp.plan_id AND r.run_kind='execution' AND r.status='completed'
        AND (r.completed_at, r.run_id) = ( 最近完成的那次 )           -- 每个判定计划取一次
  JOIN run_contents rc ON rc.run_id = r.run_id AND rc.content_id = c.content_id AND rc.final='pass'
  WHERE jp.activity_plan_id = :activityPlanId
)
```

要点：一个活动计划下有 1..n 个判定计划，取「任一通过」（未决 U2）；`run_contents` 只保留每个（判定计划，版本）最近若干次执行的内容级行（d-rule-engine §7.13），被清理的执行不参与。**U2 未定之前，页面置灰、读口拒绝该参数，不写占位 SQL。**（D 已实现；真正启用时优先走 D 对外的读结果端口，不直读 `run_contents`，上面的 SQL 只表达语义。）

## 7. 失败语义

见 requirements §6。读口抛 `SquareError(kind, code)`：`auth`（无权限 / 空范围）、`input`（`invalid_filter` / `plan_filter_unavailable`）、`unavailable`（数据库不可用）。页面对 `input` 显示固定人话「筛选条件无效」，不展示内部 message。

## 8. 测试策略（全部离线）

| 层 | 覆盖 |
|---|---|
| 单元 | 筛选校验（非法值逐项）；`q` 的 `LIKE` 转义；点赞区间边界（50、51、100、101、300、301、500、501）；`watchUrl` 协议白名单；`visibleBrands` 四种情形 |
| 数据库（`verify.sh` 的 MySQL 8.4 容器） | 种子：4 品牌 × 3 平台 × 多种点赞状态（value、0、missing、explicit_null、invalid）、released 名额、external 账号、非 active 内容、非 finalized 当前快照；断言：点赞 ≤50 与非 value 不出现、external 与 released 不出现、品牌策略 `own` 时看不到别的品牌、总数与列表一致、排序与翻页稳定 |
| 授权 | 无 `square.read`、空范围、非超管改策略均被拒绝；能力矩阵 fixture 30 项逐行对照 |
| 页面 | 无页面逻辑测试之外的单测；走查按 §10.4 状态矩阵与 `ui-foundation.md` §9 清单 |

禁网、无真实付费调用；封面签名用 fake `MediaObjectStore`。

## 9. 已知上限

| 上限 | 触顶后 |
|---|---|
| 标题搜索是 `LIKE '%…%'`，只能扫描已被其他条件缩小的集合 | 当可见作品数达到数十万、搜索明显变慢时，改 MySQL `FULLTEXT ... WITH PARSER ngram`（需要迁移与 ADR）；`ponytail:` 注释写在查询处 |
| `OFFSET` 分页，深页变慢 | 单页 20 条、业务不会翻很深；真有需要再改键集分页 |
| 品牌 / 分公司取当前归属 | 改绑后旧作品跟新归属；业务需要「发布当时归属」时改读 `content_discoveries.owner_*` |
| 多品牌观看者取策略并集 | 业务需要更严格时改为取交集（需要重新确认 R2.3） |
| 主查询没有专门覆盖索引（`like_value DESC` + `snapshot_status` + 当前快照联接） | 可见作品数增大后实测 `EXPLAIN`，再迁移补索引；v1 靠 `status='active'` 与点赞 >50 先收窄 |
| 封面只取 `cover_normalized`，不回退原始 `cover` | 未跑规格化的内容显示占位图；规格化覆盖率低时再评估回退 |
| 手动停采（`monitoring_enabled=false`）账号的历史作品仍展示 | 业务要求隐藏时在 §5.5 加 `monitoring_enabled` 条件（requirements U3） |

## 10. 界面

> **状态：已确认（2026-11-19，§10.6）。** 确认范围之外的界面改动要重新确认。

### 10.1 页面清单

| 页面 | 角色 | 入口 | 主要操作 | 对应 Capability |
|---|---|---|---|---|
| 经销商视频广场 `/square` | 四个角色 | 左侧导航「视频广场」（与「学习」同组；门店端也有入口）；页面内第一个大块标签才叫「经销商视频广场」 | 筛选、搜索、翻页、「观看」、「AI分析」弹窗 | `square.read` |
| AI分析界面示意 `/square/<contentId>/ai` | 四个角色 | 「AI分析」弹窗里的「查看界面示意」 | 切换「AI分析作品内容 / AI仿写」标签（占位示例，输入与发送不可用）、返回广场、「观看」原作品 | `square.read` |
| 官媒阵地（同页第二个标签） | — | 标签灰色，写「暂未开放」，不可点 | — | — |

AI分析界面示意页是正式页面（刘学奎 2026-11-19，requirements D10 / R5.5），内容是静态占位，不发请求；作品信息由读口 `get` 提供，可见条件与广场相同。

### 10.2 用户流程

```text
进入广场（默认：全部品牌 / 全部平台 / 视频 / 全部其他条件，点赞从高到低）
  → 点芯片或改下拉：立即刷新，回到第 1 页
  → 输入标题关键词 → 点「搜索」（或回车）→ 刷新
  → 点「重置」：全部条件回默认
  → 悬浮卡片（触屏：常驻按钮）
       ├ 观看 → 新标签页打开原平台作品链接
       └ AI分析 → 弹窗「AI分析功能正在开发中」→ 知道了
```

### 10.3 线框与原型

- 用户线框：2026-11-18 对话中的两张图（广场整体 + AI分析模块），未入库。
- **可点击原型**：[`ui-lab/f-video-square/`](../../../ui-lab/f-video-square/README.md)（以 v2 为底的独立拷贝，页面在 `pages-f-square.js`）。走查地址（4100 是 `ui-lab/` 的静态服务，见 `ui-lab/LOCAL-UI.md`）：<http://localhost:4100/f-video-square/#/square>，AI分析示意页 <http://localhost:4100/f-video-square/#/square/ai/v1>。原型右上「原型：预览上线后的效果」可打开置灰的活动计划下拉。
- 页面顶部是两个整行对半的大块标签：「经销商视频广场」（选中）与「官媒阵地」（灰色，暂未开放，点击只提示）；AI分析示意页同样用两个大块标签「AI分析作品内容」「AI仿写」。
- 筛选区沿用已确认的芯片样式（浅底 `#E9F5F6`、文字 `#0A6F74`、1px 青绿描边，不用渐变）；卡片白底 12px 圆角 1px 边线，无常驻阴影；「搜索」是深色按钮，「重置」是描边按钮。
- 卡片网格：`repeat(auto-fill, minmax(220px, 1fr))`，1440 宽下每行 4 个；1700 以上 5–6 个。

### 10.4 状态矩阵

| 页面 | 加载 | 空 | 无权限 | 错误 | 部分成功 | 处理中 | 过期 |
|---|---|---|---|---|---|---|---|
| `/square` | 卡片骨架屏（20 块） | ① 有条件无结果：「没有符合条件的视频」+「重置」按钮；② 系统里还没有可展示作品：「采集到作品后会出现在这里」 | 「当前账号没有视频广场入口」，无任何计数 | 通用错误态 + 重试 | 单卡封面失败 → 占位；单卡无链接 → 「观看」置灰 | — | — |

「处理中」「过期」不适用（只读列表），显式写 —。

### 10.5 字段可见性

| 字段 | `platform_admin` | `hq_manager` | `branch_manager` | `store_staff` |
|---|---|---|---|---|
| 标题、点赞、评论、品牌标签、账号名、封面、平台与类型角标 | 可见 | 可见 | 可见 | 可见 |
| 可见品牌范围 | 全部 | 按品牌策略 | 按品牌策略 | 按品牌策略 |
| 专员姓名、门店名与编码、账号内部 ID | 不返回 | 不返回 | 不返回 | 不返回 |

「按品牌策略」：该观看者品牌被设为 `own` 时只见本品牌，默认见全部（R2）。

### 10.6 界面设计确认

| 确认人 | 日期 | 确认的页面范围 | 原型 / 线框链接 | 备注 |
|---|---|---|---|---|
| 刘学奎 | 2026-11-19 | `/square` 广场页：三行芯片与四个下拉的单选筛选、标题搜索与重置、卡片网格（含悬浮 / 触屏按钮）、「观看」新标签页、「AI分析」只弹「功能正在开发中」、「参与活动计划」置灰、「官媒阵地」灰色不可点、无收藏星标；四种状态（加载 / 空 / 无权限 / 错误）。**含**原型里的「AI分析界面示意页」（`/square/<contentId>/ai`，刘学奎同日更正：要做，requirements D10）。 | [`ui-lab/f-video-square/`](../../../ui-lab/f-video-square/README.md) 原型 v1 | 对话中口头确认（「UI 原型我已确认没问题」）。2026-11-19 同日仅把置灰下拉的提示由「判定计划上线后开放」改为「暂未开放」（原提示在 D 已实现后不准确）；其余未动 |

## 11. 决策记录

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| SQ-D01 | 观看范围用「每观看者品牌一行策略」，不用 Capability 变体 | Capability 是角色矩阵，不含品牌维度；学习模块的 `brandScope` 先例是对象侧，这里是观看者侧 | 2026-11-18 |
| SQ-D02 | 多品牌观看者取策略并集 | 简单；业务要求更严再改交集 | 2026-11-18 |
| SQ-D03 | 品牌与分公司取当前归属 | 一次联接；与 D 域「执行时当前归属」同口径 | 2026-11-18 |
| SQ-D04 | 筛选选项不随其他筛选联动 | 避免选项跳变；可以以后加 | 2026-11-18 |
| SQ-D05 | 点赞 `>50` 写在 SQL 恒定条件里，不做成可配置项 | 刘学奎的业务规则；改阈值走决策修订 | 2026-11-18 |
| SQ-D06 | 「参与活动计划」置灰且读口拒绝参数，不写占位 SQL | U2（列哪些计划、「合格」取任一还是全部）未定；数据纪律「未决项不得被默认冻结」。**理由订正 2026-11-19**：原写「D 未实现」，D 已实现并合并，结论不变 | 2026-11-18 |
| SQ-D07 | 「AI分析」点击只弹窗；**2026-11-19 订正**：弹窗里加入口，静态示意页也做成正式页面（D10） | 刘学奎 2026-11-18 / 2026-11-19 | 2026-11-18 |
| SQ-D08 | `content_square` 的 `constraint` 用 `constraintOf`，策略只进 `contains` 与 `policy.visibleBrands`；不恒返回 `all` | `constraint` 同步、读不了策略表；恒 `all` 会让下游把它当真实范围而过度授权。照学习模块同构 | 2026-11-19 |

## 12. 与既有 spec 的接缝

- **读** A：`contents`、`content_snapshots`、`external_accounts`、`account_profile_snapshots`、`staff_account_assignments`、`media_references`、`media_assets`；**读** org：`media_staff`、`stores`、`brands`、`sectors`、`branches`。
- **改** B：Capability + 资源键（§5 of requirements），走 B 评审；不改 B 的授权语义。
- **将来读** D：`run_contents`、`judgement_runs`（§6）。
- **与 `a-master-data-browse` 不重叠**：它浏览主数据，本 spec 浏览作品；可复用其筛选与分页的 URL 写法。
- **与 E 的「命中内容」不同**：命中内容是按判定执行、按报表授权的明细；广场是跨品牌公共借鉴，E 的 E-D09 原文也是 1.0 不做全量内容明细（2026-11-19 E-D23 修订：全量明细改由 [`e-metrics-lite`](../e-metrics-lite/requirements.md) 交付，按报表授权，与本广场互不引用）。
