# G 学习平台 · 两级标签（g-learning-tags-v2）· 设计

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **上游 PRD**：[`prd-domain-g-learning.md`](../../../HBECHO设计方案/prd-domain-g-learning.md) v1.0.1（本 spec 按 2026-11-16 决定修订其 §3.3 与 G-D14）
>
> **最近核对**：2026-11-16 · **更新日期**：2026-11-16（初建）

## 1. 一句话方案

在 `tags` 之上增加 `tag_categories`；标签变成「分类 + 值」，课程仍用 `course_tags` 多对多。三处界面按分类分组；筛选改为多标签，**同类 OR、跨类 AND**。迁移按现有标签名的第一个 `-` 拆分，保留 `tag_id` 与课程引用。

## 2. 形状

| 需要 | 结论 | 理由 |
|---|---|---|
| 新表 | `tag_categories` | 分类可新增、可改名，需要独立身份与排序 |
| 改表 | `tags` 增加 `category_id`；唯一键改为 `(category_id, name)` | 同名标签只在同分类内冲突 |
| 迁移 | 新增 `0012_learning_tag_categories.sql` | 建表、回填、加约束；保留现有 `tag_id` |
| 新 Capability | 不新增 | 沿用 `learning.read` / `learning.manage` / `learning.tag.manage` |
| Module | 改 `learning/tags.ts`、`read.ts`、`manage.ts`、`course-common.ts`、`index.ts` | 分类 CRUD、多标签筛选、标签分组合法性 |
| 页面 | 改 3 处（标签管理、课程表单、学习中心） | 需求 TL-6 |
| 新组件 | 1 个多选筛选项组件；现有 `TagManager` / `CourseForm` 扩展 | 学习中心需要多选，原生 `select` 不够 |
| 新依赖 | 不引入 | 原生 React + 现有 CSS |

## 3. 边界阶梯

1. **已有**：Drizzle、现有 `tags` / `course_tags`、`TagManager`、`CourseForm`、服务端分页与 URL 状态。
2. **框架原生**：React 服务端组件 + 少量客户端组件（多选浮层）。
3. **标准 SQL**：`EXISTS` 子查询做分类内 OR、分类间 AND。
4. **自建**：仅分类 CRUD 与筛选组合；无成熟库可替代且不引入新依赖。

## 4. 数据模型

### 4.1 `tag_categories`

| 列 | 类型 | 约束 |
|---|---|---|
| `category_id` | BIGINT | PK，自增 |
| `name` | VARCHAR(32) | NOT NULL，`UQ(name)` |
| `sort_order` | INT | NOT NULL；新分类 = 当前最大值 + 10 |
| `created_at` | DATETIME(6) | NOT NULL |

不加 `updated_at`：分类只改显示名，审计已记录变更；需要时再加。删除语义：分类下有标签 → 拒绝（应用 409；FK RESTRICT 兜底）。

### 4.2 `tags` 变更

| 变更 | 内容 |
|---|---|
| 新增列 | `category_id BIGINT NOT NULL`，`FK → tag_categories(category_id)` RESTRICT |
| 唯一键 | 删除 `UQ(name)`；新增 `UQ(category_id, name)` |
| 索引 | `IDX(category_id)` |
| 既有列 | `name` 仍是 VARCHAR(32)，规则不变 |

`course_tags` 不变：`(course_id, tag_id)` 复合 PK，FK RESTRICT。

### 4.3 迁移 `0012_learning_tag_categories.sql`

顺序：

1. 建 `tag_categories`；
2. 插入种子分类：平台 / 板块 / 阶段 / 课程类型（`sort_order` 10/20/30/40），以及「未分类」（90）；使用 `INSERT … ON DUPLICATE KEY UPDATE name=name` 保证幂等；
3. `tags` 增加可空 `category_id`；
4. 回填：`prefix = TRIM(SUBSTRING_INDEX(name, '-', 1))`，`value = TRIM(SUBSTRING(name, LOCATE('-', name) + 1))`；
   - 有 `-` 且 prefix 非空 → 建或取该分类，标签名改为 `value`；
   - 无 `-` 或 prefix 为空 → 归「未分类」，标签名保持不变；
   - **保留 `tag_id`**，只改 `name` / `category_id`，`course_tags` 不动；
5. 把 `category_id` 改为 `NOT NULL`，加外键与索引；
6. 删除旧唯一键 `uq_tags_name`，加 `uq_tags_category_name(category_id, name)`。

**重复冲突**：如果拆分后在同一分类出现同名（例如 `平台-抖音` 与 `平台-抖音` 的变体），第 6 步唯一键会让迁移失败；这是预期行为——先在库副本上查重复并人工处理，不静默合并。

## 5. 接口与算法

### 5.1 Module 形状

```ts
export interface TagCategoryView { categoryId: string; name: string; sortOrder: number; tagCount?: number }
export interface TagView { tagId: string; name: string; categoryId: string; categoryName: string; courseCount?: number }
```

新增：

- `listTagCategories(deps, ctx, { withCounts? })`：`learning.read`；管理页要 `learning.tag.manage` 并可带标签数。
- `createTagCategory / renameTagCategory / deleteTagCategory`：`learning.tag.manage`；写审计 `learning_tag_category_created / _renamed / _deleted`。
- `createTag(deps, ctx, categoryId, name)`：原签名加分类；
- `listTags` 返回分类信息，排序：`category.sort_order, category.name, tag.name`。

### 5.2 课程标签校验

- `tagIdsInput` 保持 `.min(1).max(20)`（G-D21）；
- `resolveTags` 额外返回每个标签的 `categoryId`，确保标签存在；不要求每个分类都有值；
- 同一分类多选正常写入 `course_tags`；数据库复合主键天然去重。

### 5.3 学习中心多标签筛选

解析：

- `tag` 参数可重复，最多 20 个；去重后逐个 `parseId`；
- 移除 `multiple_tags` 错误（G-D14 被推翻）；
- 无 `tag` → 不加标签条件。

构造：

1. 查出所选标签的 `category_id`；
2. 按 `category_id` 分组；
3. 对每个分类生成一个 `EXISTS`：
   ```sql
   EXISTS (
     SELECT 1 FROM course_tags ct
     JOIN tags t ON t.tag_id = ct.tag_id
     WHERE ct.course_id = courses.course_id
       AND t.category_id = :categoryId
       AND ct.tag_id IN (:tagIdsOfCategory)
   )
   ```
4. 所有分类的 `EXISTS` 用 `AND` 组合（跨类 AND）；分类内 `IN` 即 OR。

分页与排序沿用现有实现；标题搜索、「只看在学」与标签条件叠加。

### 5.4 失败语义

| 情形 | 结果 |
|---|---|
| 非超管写分类/标签 | 403 |
| 分类名重复 / 标签同分类内重复 | 409 |
| 删除仍有标签的分类 | 409，`{ tagCount }` |
| 删除被课程引用的标签 | 409，`{ referenceCount }`（沿用） |
| 课程 0 个标签 | 400 `invalid_input`（G-D21） |
| 课程标签 ID 不存在 | 400 `tag_not_found` |
| 筛选标签 ID 非法 | 400 |
| 分类/标签不存在 | 404 |

## 6. 界面

> **状态：未确认。** 本节是提案；§6.6 为空时页面任务与页面代码不得开工。

### 6.1 页面清单

| 页面 | 角色 | 入口 | 改动 |
|---|---|---|---|
| 标签管理 `/learning/tags` | `platform_admin` | 学习 → 标签管理 | 按分类分组；新建分类、改名、删除空分类；每组内新建 / 改名 / 删除标签 |
| 新建 / 编辑课程 `/learning/manage/new`、`/learning/manage/[id]` | `platform_admin`、`hq_manager` | 课程管理 | 标签按分类分组多选；已选可逐个移除；至少一个 |
| 学习中心 `/learning` | 四类角色 | 导航「学习」 | 每个分类一个多选筛选；已选胶囊；清空；与搜索 / 只看在学叠加 |

### 6.2 用户流程

```text
超管：标签管理 → 新建分类「平台」→ 在平台下新建「抖音」「小红书」→ 课程引用
总部：新建课程 → 平台选「抖音 + 小红书」→ 板块选「短视频 + 直播」→ 保存
学员：学习中心 → 平台选「抖音」→ 板块选「直播」→ 列表同时满足两类
```

### 6.3 线框（文字）

**标签管理**

```text
[+ 新建分类]
平台（4 个标签）                    [改名分类] [删除分类]
  抖音       引用 12  [改名][删除]
  小红书      引用 8  [改名][删除]
  [新标签名称____] [新建标签]
板块（3 个标签） …
```

**新建课程 · 标签**

```text
平台      [抖音✓] [小红书] [视频号] [GEO]
板块      [账号] [短视频✓] [直播✓] [投流]
阶段      [基础✓] [进阶]
课程类型  [课件✓] [视频] [图片]
已选 5 个标签；至少选 1 个
```

**学习中心筛选**

```text
[搜索标题____]  平台 [抖音 ▾]  板块 [直播 ▾]  阶段 [全部 ▾]  课程类型 [全部 ▾]  [只看在学] [筛选]
已选：平台 抖音 ×   板块 直播 ×   清空
```

### 6.4 状态矩阵

| 页面 | 加载 | 空 | 无权限 | 错误 |
|---|---|---|---|---|
| 标签管理 | 骨架屏 | 「还没有分类／标签」+ 新建入口 | 非超管显示无权访问 | 一句人话 + 重试；删除冲突显示引用数 |
| 新建课程 | 骨架屏 | 没有任何标签 → 提示先由超管建标签，保存按钮禁用 | 无 `learning.manage` → 无权访问 | 字段级错误；0 标签提示「至少选 1 个」 |
| 学习中心 | 骨架屏 | 「本品牌还没有课程」+ 新建入口 | 未登录跳登录 | 一句人话 + 重试 |

### 6.5 字段可见性

| 内容 | platform_admin | hq_manager | branch_manager | store_staff |
|---|---|---|---|---|
| 分类与标签（筛选 / 课程展示） | ✅ | ✅ | ✅ | ✅ |
| 标签管理（分类与标签增删改） | ✅ | ❌ | ❌ | ❌ |
| 课程表单里的标签选择 | ✅ | ✅ | ❌ | ❌ |

### 6.6 界面设计确认

| 确认人 | 日期 | 确认的页面范围 | 原型 / 线框链接 | 备注 |
|---|---|---|---|---|
| （待确认） | | | | |

## 7. 对既有代码的改动

| 文件 | 改动 | 为什么不是放宽 |
|---|---|---|
| `src/db/schema/learning.ts` | 新增 `tagCategories`；`tags` 加 `categoryId`、换唯一键 | 收紧结构；旧 `name` 全局唯一被分类内唯一取代 |
| `drizzle/0012_learning_tag_categories.sql` | 新迁移 | 只增表/列并回填；保留 `tag_id` |
| `src/modules/learning/tags.ts` | 分类 CRUD；标签带分类；审计事件 | 权限不变；分类写操作仅超管 |
| `src/modules/learning/read.ts` | 多 `tag` 参数、按分类 AND/OR | 原先拒绝多标签；这是需求变更，不是静默放宽 |
| `src/modules/learning/course-common.ts` | `resolveTags` 返回分类 | 校验仍要求标签存在、至少 1 个 |
| `src/modules/learning/manage.ts` | 课程标签读写带分类信息 | 写入逻辑不变 |
| `src/modules/learning/index.ts` | 导出新类型与函数 | — |
| `src/app/(app)/learning/tags/page.tsx`、`_components/learning/tag-manager.tsx` | 分类分组 UI | 权限判断不变 |
| `src/app/(app)/learning/manage/new/page.tsx`、`[id]/page.tsx`、`_components/learning/course-form.tsx` | 分组多选 | 至少一个标签的校验不变 |
| `src/app/(app)/learning/page.tsx` | 多选筛选；URL 重复 `tag` | 新组件只做展示与提交 |
| `src/app/_actions/learning.ts` | 分类动作；标签动作带分类 | 仍经 `run()` 与 Capability |
| `src/app/_components/learning/tag-filter.tsx` | 新增多选浮层 | 原生 select 不支持多选 |
| 测试 | `tags.db.test.ts`、`read.db.test.ts`、`manage.db.test.ts` 扩展 | 覆盖新语义 |

## 8. 测试策略

| 层 | 覆盖 |
|---|---|
| 纯函数（unit） | 分类名/标签名校验；筛选参数解析（重复 tag、去重、上限、非法 ID） |
| 数据库（db） | 分类 CRUD 与权限；分类/标签唯一性；删除冲突；课程多标签保存；同类 OR / 跨类 AND；至少一个标签 |
| 迁移（环境） | 在测试 ECS 的库副本上演练：标签数、`course_tags` 行数、`tag_id` 前后一致；重复执行幂等 |
| 手工 | 三处页面的分组、多选、冲突提示、空状态 |

## 9. 明确不做与已知上限

- 不做标签合并、同义词、颜色、排序拖拽、分类树（最多两级）。
- 分类数量与标签数量不设硬上限；课程标签仍限 20 个。
- 迁移遇到拆分后同分类重名会失败，需要人工处理；这是有意的保守行为。
- 标签筛选只按标签 ID，不提供「按分类全选」的快捷参数。

## 10. 决策记录

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| TLD-01 | 两级：分类 + 标签值；分类可新增 | 刘学奎 2026-11-16 确认；固定四类不够用 | 2026-11-16 |
| TLD-02 | 同一分类内可多选 | 图示课程跨平台、跨板块 | 2026-11-16 |
| TLD-03 | 筛选同类 OR、跨类 AND | 符合多维筛选直觉；分类之间是不同维度 | 2026-11-16 |
| TLD-04 | 保留至少一个标签 | G-D21 仍然成立 | 2026-11-16 |
| TLD-05 | 旧标签按第一个 `-` 拆分，无前缀归「未分类」 | 现有标签命名已带维度前缀；保留 `tag_id` | 2026-11-16 |
| TLD-06 | 分类删除只允许空分类 | 避免标签被级联删除或悬空 | 2026-11-16 |
| TLD-07 | 分类改名不迁移课程引用 | 引用的是 `tag_id`，与分类名无关 | 2026-11-16 |