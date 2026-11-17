# A 主数据浏览（a-master-data-browse）· 设计

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-browse`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11.1（2026-11-11，定稿候选）
>
> **数据基线**：[`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) §7
>
> **界面基线**：[`ui-foundation.md`](../../../HBECHO设计方案/ui/ui-foundation.md)（2026-11-10 v2）
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16（初建；同日下午界面确认，应要求新增板块 / 店面标准筛选）

## 1. 一句话方案

在既有 `master-data-import` Module 里增加一个**只读** `browse` 读口（两组查询：门店分页、分公司分页），在 `/master-data` 增加一个服务端页面按两个视图展示；权限、品牌范围、错误类型全部复用导入已有的 `ActorContext` 与 `MasterDataError`。不新增表、不新增迁移、不新增 Capability、不引入依赖。

## 2. 形状

| 需要 | 结论 | 理由 |
|---|---|---|
| 新表 / 新列 | **不建** | 读 v2 §7 的 `brands / regions / branches / sectors / dealers / stores`；主档只保留当前值（A §4.1 第 6、7 条） |
| 迁移 | **不建** | 无 schema 变化；`verify.sh` 第 4 步应保持「不产生新迁移」 |
| 新 Capability | **不建** | 复用 `data.master_data.import`（D5）；B PRD v1.21 与 `roles.ts` 均不改 |
| 新 Module | **不建** | 在 `src/modules/master-data-import/` 增加 `browse.ts`，经 `index.ts` 导出（ADR-0013：按域分模块，不按 spec 分） |
| 新页面 | **建 1 个** | `src/app/(app)/master-data/page.tsx`，`?view=stores\|branches` |
| 新组件 | **不建** | 复用 `PageHead / DeniedState / EmptyState / Badge / ClickRow / FilterCard / Pager / Callout / Icon` 与 `.chip` 样式 |
| 新依赖 | **不建** | 8,327 行不需要表格库、搜索库或虚拟滚动 |
| 新索引 | **不建** | 见 §10 已知上限 |
| 原型 | **建 1 页** | `ui-lab/hbecho-ui-v2/` 增加主数据浏览页；仅走查，不进生产构建 |

## 3. 边界阶梯（not-reinventing-wheels）

1. **代码库里已有**：`master-data-import` 的 `ActorContext`（`actor` / `capabilities` / `brandScope`）、`assertImport`、`MasterDataError`、页面装配 `masterData()` 与 `mdActorOf`、`web().directory()`；页面骨架与组件。
2. **框架原生**：Next.js 服务端页面 + `searchParams`；Drizzle 查询构造器。
3. **标准 SQL**：`AND` 组合谓词、`LIKE`、`COUNT(*)`、`ORDER BY`、`LIMIT/OFFSET`。
4. **自建**：只有两组查询与筛选校验——它们是本项目的主档语义（品牌范围、编码按字节比较），没有现成库能替代；不引入搜索服务。

**采用**：现有 Drizzle + Next.js + 已确认 UI 组件。
**不用它做什么**：不把列表做成客户端表格（不引 TanStack Table），筛选、排序、分页全部留在服务端与 URL；不把品牌范围过滤下推给数据库视图（B 域的范围求交是唯一实现）。

## 4. 数据模型（只读）

不建表、不改列。本切片读取的列与连接：

| 视图 | 表与连接 | 用到的列 |
|---|---|---|
| 门店 | `stores s` → `brands b`（`brand_id`）→ `sectors sec`（`sector_id`）→ `branches br`（`sec.branch_id`）→ `dealers d`（`dealer_id`） | `s.store_id / store_code / store_name / store_tier / status / updated_at`；`b.brand_code / brand_name`；`sec.sector_code / sector_name`；`br.branch_code / branch_name`；`d.dealer_code / dealer_name` |
| 分公司 | `branches br` → `regions r`（`region_id`）；`LEFT JOIN sectors sec` → `LEFT JOIN stores s`（按 `sector_id`，并带品牌范围） | `br.branch_id / branch_code / branch_name / updated_at`；`r.region_name`；门店计数按 `s.status` 条件聚合 |

所有外键均为 `NOT NULL` + `RESTRICT`（`stores.dealer_id / brand_id / sector_id`），所以门店视图用 `INNER JOIN`；`dealers.dealer_code` 与 `stores.store_tier` 可空，视图层保留 `null`，**不把 null 变成空字符串或 0**。

`BIGINT` 一律以十进制字符串出 Module；时间以 ISO-8601 UTC 出 Module，页面用既有 `bjt()` 转北京时间。

## 5. 读口契约

### 5.1 类型（`src/modules/master-data-import/browse.ts`）

```ts
export type StoreStatus = "active" | "closed";
export type PageSize = 20 | 50 | 100;

export interface BrowseFilter {
  brandId?: string;      // 十进制字符串
  branchId?: string;     // 十进制字符串
  sectorName?: string;   // 板块名称，精确匹配（sectors.sector_name）
  tier?: string;         // 店面标准，精确匹配（stores.store_tier）
  tierMissing?: boolean; // IS NULL；与 tier 互斥
  status?: StoreStatus;  // 未指定 = 全部
  keyword?: string;      // 门店编码 / 名称（分公司视图：分公司编码 / 名称）
  page: number;          // 1 起
  pageSize: PageSize;
}

export interface StoreListItem {
  storeId: string; storeCode: string; storeName: string;
  brandCode: string; brandName: string;
  branchCode: string; branchName: string;
  sectorCode: string; sectorName: string;
  dealerCode: string | null; dealerName: string;
  storeTier: string | null;
  status: StoreStatus;
  updatedAt: string;     // ISO-8601 UTC
}

export interface BranchListItem {
  branchId: string; branchCode: string; branchName: string;
  regionName: string;
  activeStoreCount: number;
  closedStoreCount: number;
  updatedAt: string;
}

export interface PageResult<T> { items: T[]; total: number; page: number; pageSize: PageSize }
```

Module 出口：

```ts
browse: {
  stores(filter: BrowseFilter, actor: ActorContext): Promise<PageResult<StoreListItem>>;
  branches(filter: BrowseFilter, actor: ActorContext): Promise<PageResult<BranchListItem>>;
}
```

两个方法都先 `assertImport(actor)`（与导入同一授权入口：`import` 或 `structure`），再校验筛选，再查询。

### 5.2 筛选校验（`assertFilter`）

固定顺序、首个失败即抛 `MasterDataError("input", "invalid_filter", …)`：

1. `page`：正整数；非整数或 < 1 → 拒绝（调用方缺省给 1）。
2. `pageSize ∈ {20, 50, 100}`；其他 → 拒绝。
3. `brandId` / `branchId`：匹配 `^\d{1,19}$` 且 `BigInt` 可表示；否则拒绝。**不**接受空字符串以外的任何别名。
4. `status`：`undefined` 或 `"active"` / `"closed"`；其他 → 拒绝。**不**退化为「全部」。
5. `sectorName`：`trim()` 后 1–128 字符；空字符串视为未指定；超长 → 拒绝。
6. `tier` / `tierMissing`：`tier` 为 `trim()` 后 1–64 字符；`tierMissing === true` 表示 `IS NULL`；两者同时出现 → 拒绝（不允许「既要某个值又要空」）。
7. `keyword`：`trim()` 后长度 ≤ 64；超长 → 拒绝。`trim` 后为空 → 视为未指定。

拒绝即错误，**不静默放宽**——这是 C18「未决项不得被默认值静默冻结」与数据纪律「四种值状态不合并」的同一原则：把非法筛选当成「全部」等于悄悄改变结果集。

### 5.3 品牌范围谓词

品牌范围统一表达为**门店品牌 ID 的子查询**，两个视图共用同一写法：

```sql
stores.brand_id IN (SELECT brand_id FROM brands WHERE brand_code IN (:codes))
```

- 品牌范围来自 `toMasterDataActor`（`scope.brands` 为 `"all"` 或品牌 ID 集合，已映射为编码并复核过存在性）；本 spec 不重新实现范围求交。
- `"all"`：不加谓词。
- 空集合：显式 `FALSE`，不能生成「无谓词」而返回全部。
- 用子查询而不是在 `WHERE` 里依赖 `brands` 连接，是因为分公司查询里的门店是 `LEFT JOIN`，品牌范围必须写在连接条件里才能保持「没有授权门店的分公司仍出现、计数为 0」。

### 5.4 门店查询

```sql
SELECT s.store_id, s.store_code, s.store_name, s.store_tier, s.status, s.updated_at,
       b.brand_code, b.brand_name, sec.sector_code, sec.sector_name,
       br.branch_code, br.branch_name, d.dealer_code, d.dealer_name
FROM stores s
JOIN brands  b   ON b.brand_id   = s.brand_id
JOIN sectors sec ON sec.sector_id = s.sector_id
JOIN branches br ON br.branch_id = sec.branch_id
JOIN dealers d   ON d.dealer_id  = s.dealer_id
WHERE <brandScope> AND <brandId?> AND <branchId?> AND <sectorName?> AND <tier|tierMissing?> AND <status?> AND <keyword?>
ORDER BY b.brand_code, br.branch_code, s.store_code, s.store_id
LIMIT ? OFFSET ?;
```

- `total`：同一 `FROM/JOIN/WHERE` 的 `SELECT COUNT(*)`；**谓词只构造一次**，列表与计数共用同一个 `where` 值（ui-foundation §4.1：分页总数与表格用同一条谓词）。
- `keyword`：`(s.store_code LIKE ? ESCAPE '\\' OR s.store_name LIKE ? ESCAPE '\\')`，`? = '%' + escapeLike(kw) + '%'`；`escapeLike` 转义 `\`、`%`、`_`。不转义会让用户输入 `%` 命中全表。
- 编码列 `utf8mb4_bin`：大小写与字节精确；名称列用库默认排序规则。这是既有 schema 的事实，不在查询里统一。
- 品牌 / 分公司筛选与品牌范围是**交集**：品牌筛选值不在范围内时自然得到 0 行，与不存在的品牌表现一致，不额外报错、不泄露存在性。
- 板块筛选：`sec.sector_name = ?`，精确匹配（不是包含）；名称由数据决定（当前为「水机」「家装」，编码是 `{分公司}-water` / `{分公司}-home`），不按编码后缀做二次推断。
- 店面标准筛选：`s.store_tier = ?`；`tierMissing` 时改为 `s.store_tier IS NULL`。`store_tier` 是 `VARCHAR(64) NULL`，不是枚举，筛选值来自 §5.6 的数据驱动选项；未知值自然得到 0 行。
- 已撤店门店（`status='closed'`）正常返回；状态筛选只是收窄。

### 5.5 分公司查询

```sql
SELECT br.branch_id, br.branch_code, br.branch_name, r.region_name, br.updated_at,
       COALESCE(SUM(CASE WHEN s.status = 'active'  THEN 1 ELSE 0 END), 0) AS active_count,
       COALESCE(SUM(CASE WHEN s.status = 'closed'  THEN 1 ELSE 0 END), 0) AS closed_count
FROM branches br
JOIN regions r ON r.region_id = br.region_id
LEFT JOIN sectors sec ON sec.branch_id = br.branch_id
LEFT JOIN stores  s   ON s.sector_id = sec.sector_id AND <brandScope>
WHERE <keyword?>
GROUP BY br.branch_id, br.branch_code, br.branch_name, r.region_name, br.updated_at
ORDER BY br.branch_code, br.branch_id
LIMIT ? OFFSET ?;
```

- 分公司行**不按品牌收窄**（分公司是跨品牌共享对象，A §4.2：「大区、分公司是跨品牌共享对象」）；品牌范围只作用在门店计数的连接条件里。没有授权品牌门店的分公司仍出现，计数为 0。
- 计数口径与门店视图一致：同一品牌范围、同一门店行；在用与已撤店互斥。
- `total` = 满足 `WHERE <keyword?>` 的分公司数（`COUNT(DISTINCT br.branch_id)`，与列表同谓词）。
- 分公司状态列不展示：schema 的 `ck_branches_status` 只允许 `active`，展示一个恒为「在用」的列没有信息量。

### 5.6 筛选选项（板块 / 店面标准）

`browse.filterOptions(actor)` 返回页面的**数据驱动选项**，同样先 `assertImport(actor)`、同样按品牌范围收窄（只统计范围内门店）：

```ts
{ sectorNames: string[]; storeTiers: string[]; hasMissingTier: boolean; storeCount: number; branchCount: number }
```

- `sectorNames`：`SELECT DISTINCT sec.sector_name FROM stores s JOIN sectors sec … WHERE <brandScope> ORDER BY sec.sector_name`。
- `storeTiers`：`SELECT DISTINCT s.store_tier … WHERE <brandScope> AND s.store_tier IS NOT NULL ORDER BY s.store_tier`。
- `hasMissingTier`：同一谓词下是否存在 `store_tier IS NULL` 的门店；页面据此决定是否显示「未设置」。
- `storeCount`：授权品牌范围内的门店总数（页面视图标签「门店 · N」）；`branchCount`：分公司总数（跨品牌共享，不按品牌收窄）。
- 选项**不缓存**（8,327 行、distinct 后个位数；每次页面请求一次查询）。
- 品牌 / 分公司选项沿用 `web().directory()`（B 域已有），不在本读口重复实现。

### 5.7 排序与分页

- 门店：`brand_code → branch_code → store_code → store_id`；分公司：`branch_code → branch_id`。末位主键保证翻页稳定（同编码不同品牌 / 同名的兜底）。
- `LIMIT/OFFSET` 服务端分页，默认 20，可选 50 / 100；不做键集分页（8,327 行，深页成本可接受，见 §10）。
- 页码越界（`page` 大于总页数）由页面按 `pageOf()` 夹到最后一页——与 `users` 页同一做法，Module 不夹。

## 6. 失败语义

| 情形 | 发生什么 |
|---|---|
| 无 `import` 且无 `structure` | `MasterDataError("authorization", "forbidden")`；页面渲染 `<DeniedState>`，不查询 |
| 品牌范围无法映射为编码 | 沿用 `mdActorOf`：`configuration` / `scope_unmappable`，交给 `error.tsx`（与既有主数据页一致，不降级为全部品牌） |
| 非法筛选（页码、每页大小、ID、状态、超长关键字、LIKE 特殊字符外的格式） | `MasterDataError("input", "invalid_filter", 人话)`；页面捕获后显示 `Callout` + 空结果，**不执行**宽查询 |
| 筛选无匹配 | `items = []`、`total = 0`；页面空状态 + 「清空筛选」 |
| 数据库错误 | 不吞；交给 `error.tsx`（既有页面同一行为） |
| 越范围品牌 / 分公司筛选值 | 0 行，不报错、不提示「无权限」——与「不存在」不可区分 |

页面不把 `invalid_filter` 的原始 message 直接给用户；用固定人话「筛选条件无效」，并保留可修正的具体项（例如「状态取值无效」）。

## 7. 页面

### 7.1 路由与参数

```text
/master-data?view=stores|branches&brand=<brandId>&branch=<branchId>&status=active|closed&kw=<text>&page=<n>&size=20|50|100
```

- `view` 缺省 `stores`；未知值 → `stores`（视图只是个 tab，不是数据谓词，允许回退；与筛选值不同）。
- 其余参数原样交给 Module；Module 校验。
- URL 即状态（可分享、可后退），用 `_lib/plan-url.ts` 的 `hrefWith` / `pageOf` / `PAGE_SIZE`；**不新增 URL 工具**。

### 7.2 页面装配

- `requireUser()` → Capability 判断（`import || structure`）→ `masterData()` + `mdActorOf(ctx)`；**不新建装配**，`_lib/master-data.ts` 已具备。
- 筛选选项：`web().directory()` 取品牌 / 分公司目录；品牌只列 `ctx.scope.brands` 内的（`platform_admin` 全部），分公司全部（跨品牌共享对象）。板块 / 店面标准选项来自 `browse.filterOptions(actor)`（§5.6），同样按品牌范围收窄。与 `users` 页的 chip 写法一致。
- 页面不做 SQL；`src/app` 只调 Module 与 `web()`（静态护栏 `B-AX-14` 与既有页面一致）。

### 7.3 对既有代码的改动（逐文件）

| 文件 | 改动 | 为什么不是放宽 |
|---|---|---|
| `src/modules/master-data-import/browse.ts` | 新增只读读口 | 只增加查询；不触碰任何写入谓词、不改变预检 / 确认语义 |
| `src/modules/master-data-import/index.ts` | 增加 `browse` 导出 | 既有导出不变 |
| `src/modules/master-data-import/browse.db.test.ts` | 新增 | — |
| `src/app/(app)/master-data/page.tsx` | 新增页面 | 页面只读；Capability 判断与既有三页一致 |
| `src/app/(app)/master-data/import/page.tsx` | 顶部加共用切换控件（浏览 / 导入），PageHead 增加「浏览主数据」（界面确认后） | 纯入口与切换；不改导入流程 |
| `src/app/(app)/layout.tsx` | 「主数据」导航 `href` 改为 `/master-data`，`also` 覆盖 `/master-data/import`、`/master-data/batches`（界面确认后） | 入口不变、Capability 判断不变；只是默认落点改到浏览页 |
| `src/app/_lib/master-labels.ts` | 增加 `STORE_STATUS = { active: "在用", closed: "已撤店" }` | 纯文案 |
| `src/app/_actions/plan-actions.guard.test.ts` | 页面清单 11 → 12，加入新页面 | 护栏变严（新页面同样要求 `requireUser` + Capability + `DeniedState`） |
| `ui-lab/hbecho-ui-v2/` | 新增浏览页原型并注册到总览 | 不进生产构建 |
| `HBECHO设计方案/ui/ui-foundation.md` §3 | 拆分「主数据」行：「组织与门店浏览」归本 spec，其余仍归导入 spec | 归属订正（requirements §5） |
| `HBECHO设计方案/INDEX.md` | 增加本 spec 登记行 | 新文档登记的强制要求 |
| `.kiro/specs/a-master-data-import/design.md` §15.3 | 浏览页行标注「由本 spec 的 D5 取代：改用 `data.master_data.import`」 | 保留原行并标注，不删除（structure.md 要求） |

## 8. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数（unit） | `src/modules/master-data-import/browse.test.ts` | `escapeLike`（`\`、`%`、`_`）；`assertFilter` 的拒绝分支；`pageSize` 白名单 |
| 真实数据库（db） | `src/modules/master-data-import/browse.db.test.ts` | 品牌范围、四个筛选、排序稳定性、分页与总数同一谓词、分公司计数只含授权品牌、无 Capability 拒绝、只读（fake 审计无事件）、10,000 行分页形状 |
| 静态护栏 | `src/app/_actions/plan-actions.guard.test.ts` | 新页面先 `requireUser`、按 Capability 渲染 `DeniedState`；页面清单数量 |
| 手工 | 见 [`acceptance.md`](acceptance.md) | 页面走查、授权品牌对比、空状态、测试 ECS 真实库 |

数据库测试使用 `verify.sh` 第 5 步的一次性 MySQL 8.4 容器；种子沿用 `tests/harness/` 的组织夹具。测试禁网、无真实付费调用。

## 9. 明确不做

- 导出、纠错、结构变更、专员 / 账号 / 归属、门店详情、监控开关。
- 排序切换（列头点击）；排序固定（§5.7）。
- 筛选选项逐项计数；只显示分页总数。
- 写完再查的乐观更新、客户端缓存、虚拟滚动。
- 审计事件。
- 新索引、新迁移、新 Capability、新依赖。

## 10. 已知上限

| 上限 | 数字 / 条件 | 触顶后的处理 |
|---|---|---|
| 关键字前缀 | `LIKE '%kw%'` 无法用索引，全表扫描 | 门店数超过 10 万或查询明显变慢时，评估全文 / 前缀索引；不在本 spec |
| 深分页 | `OFFSET` 随页码线性变差 | 8,327 行下最后一页仍可接受；触顶后评估键集分页 |
| 门店规模 | 真实导出 8,327 行（导入 spec design §14 第 6 项） | 10,000 行是导入上限，不是浏览上限；浏览按当前库行数 |
| 店面标准取值 | `stores.store_tier` 是 `VARCHAR(64) NULL`，取值由导入文件决定 | 页面选项按数据驱动（§5.6）；出现新值时自动出现，不做固定枚举；「未设置」单独一个值 |
| 板块名称 | 板块是每个分公司各自的行，名称当前为「水机」「家装」 | 筛选按名称精确匹配；若将来各分公司命名不一致，选项会并列出现，不自动归并 |
| 分公司行可见性 | 所有分公司都出现，计数按授权品牌收窄 | 若业务要求隐藏「0 家授权门店的分公司」，需一次明确的产品决定 |
| 名称排序规则 | 名称列使用库默认排序规则，编码列按字节 | 若业务要求按拼音 / 中文排序，需要单独决定 |

## 11. 决策记录

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| MDB-D01 | 读口放在 `master-data-import` Module 的 `browse.ts`，不新建模块 | 同一组表、同一授权入口、同一错误类型；新建模块会产生平行主档读口。代价是模块名仍叫 import（记名债）；若将来落地结构变更，再评估拆出 `master-data` | 2026-11-16 |
| MDB-D02 | 复用 `data.master_data.import`（页面判断 `import \|\| structure`） | 刘学奎 2026-11-16 已定；不新增 Capability、不改 B PRD | 2026-11-16 |
| MDB-D03 | 分公司行不按品牌收窄，门店计数按品牌收窄 | 分公司是跨品牌共享对象（A §4.2）；「无权限不显示计数」（ui-foundation §4.1）要求计数收窄 | 2026-11-16 |
| MDB-D04 | 状态只展示 `stores.status`，不保留「撤店情况」 | 撤店情况是导入输入，不落库（v2 §7.6）；虚构第二套状态会与主档冲突 | 2026-11-16 |
| MDB-D05 | 空品牌范围生成显式 `FALSE` 谓词 | 防止「空集合 = 不加谓词 = 返回全部」的静默放宽 | 2026-11-16 |
| MDB-D06 | 非法筛选一律报错，不静默回退「全部」 | C18 与数据纪律：非法值不得被默认值吞掉 | 2026-11-16 |
| MDB-D07 | `LIKE` 关键字转义 `\` / `%` / `_` | 不转义会让用户输入 `%` 命中全表 | 2026-11-16 |
| MDB-D08 | 排序固定，不提供列头排序切换 | 本切片目标是「看到有什么」；可预测顺序优先，减少页面状态 | 2026-11-16 |
| MDB-D09 | 页面只在服务端取数，不建客户端表格 | 8,327 行不需要；保持 URL 即状态与可分享 | 2026-11-16 |
| MDB-D10 | 查看不记审计 | 只读浏览不改变事实；审计保留给写操作与导出 | 2026-11-16 |
| MDB-D11 | 不新增索引与迁移 | 现有 `idx_stores_brand_status` / `idx_stores_sector_status` 支撑品牌、板块连接；8,327 行全表扫描可接受 | 2026-11-16 |
| MDB-D12 | 导航「主数据」默认落点改为 `/master-data`，导入页与导入记录进激活范围；浏览页与导入页顶部共用「浏览 ⇄ 导入」切换（D6） | 浏览是新用户进入主数据时的第一需求；导入仍一键可达 | 2026-11-16（刘学奎确认切换形态，D6） |
| MDB-D13 | 分公司状态不展示 | `ck_branches_status` 只允许 `active`，列无信息量 | 2026-11-16 |
| MDB-D14 | 页面捕获 `invalid_filter` 并显示固定人话 | 不把内部 message 直接暴露；同时保证不执行宽查询 | 2026-11-16 |
| MDB-D15 | 筛选项全部多选（项内「或」、项间「且」），新增大区；关键字也搜经销商编码 / 名称 | 刘学奎 2026-11-16 第二次确认（§16.6.1）；大区属于分公司，经现有连接即可，不加列 | 2026-11-16 |

## 12. 未决项

1. 筛选选项逐项计数（见 requirements §8）。
2. 是否把「专员列表」并入同一浏览页形态——另立 spec。
3. 界面确认（§16.6）——未确认前页面任务不开工。
4. 是否隐藏「0 家授权门店」的分公司行——保持现状（全部出现），业务提出再改。

## 13. 与既有 spec 的接缝

- **读**：`ActorContext` / `assertImport` / `MasterDataError`（`master-data-import/authorization.ts`、`errors.ts`）；`toMasterDataActor`（`access-control/adapters.ts`）；页面装配 `masterData()` / `mdActorOf()`（`src/app/_lib/master-data.ts`）。
- **不改**：`precheck / confirm / structure / query` 的写入与批次查询语义；`roles.ts` 的能力矩阵；B 域的 DataScope 求交。
- **旧 spec 的登记**：导入 spec design §15.3 的浏览页行在本 spec 实施时标注被 D5 取代；requirements 第 15 项补上本 spec 名字。

## 14. 页面与实现顺序的关系

读口（§5）不依赖界面确认，可先实现并测试；页面（§16）必须等 §16.6 填写后开工。`tasks.md` 的依赖图按此拆边。

## 15. 术语（界面文案）

以 `ui-foundation.md` §6.6 与 `CONTEXT.md` 为准：

| 内部值 | 界面文案 |
|---|---|
| `stores.status = active` | 在用 |
| `stores.status = closed` | 已撤店 |
| `stores.store_tier` | 店面标准（取值 `NULL` 显示「未设置」） |
| `branches` | 分公司 |
| `sectors` | 板块 |
| `dealers` | 经销商（导入文件里叫「门店所属商家」） |
| `regions` | 大区 |

## 16. 界面

> **状态：已确认（2026-11-16，刘学奎）。** 确认记录见 §16.6；页面任务在 T1 读口完成后可以排期。确认时应刘学奎要求新增了板块、店面标准两个筛选项（§5.4、§5.6）。

### 16.1 页面清单

| 页面 | 角色 | 入口 | 主要操作 | 对应 Capability |
|---|---|---|---|---|
| 主数据浏览（门店视图）`/master-data?view=stores` | `platform_admin`（全部品牌）、`hq_manager`（授权品牌） | 导航「数据 → 主数据」；分公司行下钻 | 筛选（品牌 / 分公司 / 板块 / 状态 / 店面标准 / 关键字）、分页、查看门店当前值 | `data.master_data.import`（`structure` 同样放行） |
| 主数据浏览（分公司视图）`/master-data?view=branches` | 同上 | 页内标签 | 筛选、分页、跳到该分公司门店 | 同上 |

导航改动（MDB-D12、D6）：`src/app/(app)/layout.tsx` 的「主数据」一项 `href` 改为 `/master-data`，`also` 覆盖 `/master-data/import`、`/master-data/batches`。**浏览页与导入页顶部共用同一个切换控件**「主数据浏览 ⇄ 主数据导入」（刘学奎 2026-11-16 要求）；浏览为默认，导入一键可达。导入页 PageHead 增加「浏览主数据」按钮，浏览页 PageHead 主操作是「导入主数据」（两个入口指向同一个切换目标，避免用户只找按钮不找标签）。

### 16.2 用户流程

```text
总部人员登录 → 导航「主数据」→ 顶部切换停在「主数据浏览」·门店视图（全部状态，按品牌 / 分公司 / 编码排序）
  → 选品牌（授权品牌）→ 选分公司 → 选状态 → 输关键字 → 分页
  → 切到「分公司」标签：看各分公司在用 / 已撤门店数
  → 点某分公司行 → 回到门店视图，分公司筛选中选它
  → 顶部切换点「主数据导入」→ /master-data/import（既有流程）；导入页顶部同一位置可切回浏览
```

### 16.3 线框

低保真（实际视觉沿用 `ui-foundation.md` §4 列表页骨架与已确认 CSS；色板、字号、间距不在此重画）：

```text
┌ 区内切换 ────────────────────────────────────────────────────────────────┐
│ ( 主数据浏览 )   ( 主数据导入 )                                          │
├ PageHead ────────────────────────────────────────────────────────────────┤
│ 主数据浏览                                           [导入主数据]        │
│ 库里的分公司与门店当前值；只读，导入请走「主数据导入」。                 │
├ 视图与筛选 ──────────────────────────────────────────────────────────────┤
│ ( 门店 · 8,327 )   ( 分公司 · 42 )                                       │
│ 品牌 [全部 ▾]  分公司 [全部 ▾]  板块 [全部 ▾]  状态 [全部 ▾]            │
│ 店面标准 [全部 ▾]  搜索 [编码或名称____]                                 │
│ 已选：品牌 日立 ×   分公司 北京 ×   清空                                │
├ 表格 ────────────────────────────────────────────────────────────────────┤
│ 门店编码   门店名称        品牌  分公司  板块   经销商      店面标准 状态  │
│ HB-BJ-0231 日立北京朝阳店  日立  北京    水机   北京恒泰    旗舰    在用  │
│ HB-BJ-0188 日立北京海淀店  日立  北京    家装   北京恒泰    标准    已撤店│
├ Pager ───────────────────────────────────────────────────────────────────┤
│ 共 1,204 条   ‹ 1 2 3 … 61 ›   每页 [20 ▾]                               │
└──────────────────────────────────────────────────────────────────────────┘

分公司视图的表格：分公司编码 | 分公司名称 | 大区 | 在用门店 | 已撤门店 | 更新时间（行可点击）
```

可点击原型：`ui-lab/hbecho-ui-v2/pages-m-browse.js`（2026-11-16 新增，路由 `#/master`；导入移到 `#/master/import`），已在 `ui-lab/hbecho-ui-v2/README.md` 登记。**待刘学奎走查确认**。走查地址：<http://localhost:4175/hbecho-ui-v2/#/master>（4175 是 `ui-lab/` 的静态服务，与 `ui-lab/LOCAL-UI.md` 一致）。

### 16.4 状态矩阵

| 页面 | 加载 | 空 | 无权限 | 错误 | 部分成功 | 处理中 | 过期 |
|---|---|---|---|---|---|---|---|
| 主数据浏览（门店） | 骨架屏（沿用列表页） | 「没有符合条件的门店」+「清空筛选」 | 导航不显示入口；直接访问显示「无权访问」 | 一句人话 + 「重试」；非法筛选显示「筛选条件无效」并保留可修正项 | — | — | — |
| 主数据浏览（分公司） | 同上 | 「没有符合条件的分公司」+「清空筛选」 | 同上 | 同上 | — | — | — |

本切片无写操作，所以「部分成功 / 处理中 / 过期」不适用，显式写「—」，不留空。

### 16.5 字段可见性

| 字段 | `platform_admin` | `hq_manager` | `branch_manager` | `store_staff` |
|---|---|---|---|---|
| 门店编码、名称、经销商、经销商编码、店面标准、状态、更新时间 | ✅ 全部品牌 | ✅ 仅授权品牌 | — | — |
| 品牌、分公司、板块（门店行内属性） | ✅ 全部 | ✅ 仅授权品牌 | — | — |
| 分公司编码 / 名称 / 大区 | ✅ 全部 | ✅ 全部（跨品牌共享对象） | — | — |
| 分公司在用 / 已撤门店数 | ✅ 全部品牌 | ✅ 仅授权品牌内的门店 | — | — |
| 内部字段名、表名、`store_id` 之外的内部 ID | ❌ 界面显示编码与名称 | ❌ | — | — |

品牌下拉只列授权品牌；未授权品牌不显示、不显示计数（ui-foundation §4.1）。

### 16.6 界面设计确认

| 确认人 | 日期 | 确认的页面范围 | 原型 / 线框链接 | 备注 |
|---|---|---|---|---|
| 刘学奎 | 2026-11-16 | 主数据浏览：门店视图（品牌 / 分公司 / 板块 / 状态 / 店面标准 / 关键字六项筛选、分页）与分公司视图；两页顶部「主数据浏览 ⇄ 主数据导入」切换、浏览默认；导航「主数据」落到浏览页；不做逐项计数与导出 | [`ui-lab/hbecho-ui-v2/`](../../../ui-lab/hbecho-ui-v2/README.md) 的主数据浏览页（`pages-m-browse.js`，`#/master`） | 确认时应刘学奎要求**新增板块、店面标准两个筛选项**（其余按 §16.3–§16.5 定稿）；该两项的读口与选项口径见 §5.4、§5.6 |

**确认后的变更控制**：超出上表范围的界面改动需重新确认；六项筛选之外新增筛选、或把「未设置」改成别的口径，都属于超出范围。

#### 16.6.1 第二次确认（2026-11-16，刘学奎）：筛选改为悬停多选下拉，新增大区

| 确认人 | 日期 | 确认的范围 | 原型 | 备注 |
|---|---|---|---|---|
| 刘学奎 | 2026-11-16 | 门店视图筛选由芯片 / 单选下拉改为**悬停多选下拉**（品牌、板块、门店标准、状态、大区、分公司），交互沿用 hbdam 素材库（悬停展开、移开收起、数量角标）；**新增「大区」筛选**，选了大区后分公司只列该大区的；两处搜索合并为一个框，也搜**经销商编码与名称**；「检索」按钮 | `ui-lab/hbecho-ui-v2/`（`pages-m-browse.js`，4175） | 各下拉多选：同一下拉内取「或」，不同下拉之间取「且」；「未设置」与具体店面标准可同时选（并入「或」）；分公司视图不变 |

对 §5 的影响：`BrowseFilter` 各筛选项由单值改为数组（`brandIds / regionIds / branchIds / sectorNames / tiers + tierMissing / statuses`，每项最多 100 个，非法值仍报 `invalid_filter`）；门店关键字同时匹配门店编码、门店名称、经销商编码、经销商名称；`filterOptions` 增加 `regions` 与带 `regionId` 的 `branches`。URL 用重复参数（`?brand=1&brand=2`）。大区经 `sectors → branches → regions` 生效，不新增列、索引或迁移（MDB-D11 不变）。

**已确认的需求**：区内「主数据浏览 ⇄ 主数据导入」切换与「浏览默认」（2026-11-16 刘学奎提出并确认，D6）。以下是原型走查时要确认的四点。

1. 页面形态：单页两个标签（门店 / 分公司），门店为默认；线框见 §16.3。是否认可？
2. 切换与导航落点：切换控件放在标题上方、两个页面同一位置；导航「主数据」落到浏览页（MDB-D12）。是否认可？
3. 列与默认值：门店表列见 §16.3，默认状态「全部」、每页 20；分公司表展示大区与两类门店计数。是否认可？
4. 不做逐项计数与导出：筛选下拉不显示各选项命中数，只显示分页总数；页面没有「导出」。是否接受？

确认后在此表填写确认人、日期、范围与原型链接；在此之前，页面任务（tasks T3）不开工。