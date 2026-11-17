# G 学习平台 · 两级标签（g-learning-tags-v2）· 实施计划

> **状态**：`implemented-pending-deploy`
>
> **执行状态**：任务 0–5 已完成并通过离线测试（2026-11-16）；界面于同日经刘学奎确认（design §6.6）。待 CI、合并、部署后做任务 6。
>
> **需求**：[`requirements.md`](requirements.md) · **设计**：[`design.md`](design.md) · **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：G 学习平台 · **更新日期**：2026-11-16（初建）

## 进度

- [x] 任务 0 · 文档前置与闸门（G PRD §3.3 / G-D14 修订、旧 spec 标注、INDEX 登记、界面确认）
- [x] 任务 1 · `tag_categories` 表、`tags.category_id` 与迁移 `0013`（含库副本演练）
- [x] 任务 2 · Module：分类 CRUD、标签带分类、审计
- [x] 任务 3 · 课程标签校验与多选保存
- [x] 任务 4 · 学习中心多标签筛选（同类 OR、跨类 AND）
- [x] 任务 5 · 三处页面（依赖任务 0 的界面确认）
- [ ] 任务 6 · 验收回填、INDEX 状态与实施记录

## 依赖图

```text
T0 ──► T1 ──► T2 ──► T3 ──► T5 ──► T6
              └────► T4 ──┘
```

容易画错的边：

- **T5 等 T0 的界面确认**：不是「看过图」就算，design §6.6 必须填写确认人、日期与范围。
- **T1 的迁移演练必须在库副本上做**，不直接改测试 ECS 的 `hbecho` 库；迁移失败时唯一键会拒绝重复，先查重。
- **T4 不能沿用 `multiple_tags` 错误**：单测里要删掉旧的「多标签被拒」断言，换成新语义。
- **T2/T3 不改可见性**：标签仍不参与品牌/级别过滤。

## 任务 0 · 文档前置与闸门

1. 按 `structure.md` 的决策修订流程更新 G PRD §3.3 与 G-D14：原行保留、加删除线并写「由 g-learning-tags-v2 于 2026-11-16 修订」；版本记录加一条。
2. 在 `g-learning-min` design §3.3、requirements G-3 标注被本 spec 取代的条目。
3. `INDEX.md` 登记本 spec。
4. 请刘学奎确认 design §6 的界面提案（三处页面），填写 §6.6。

**验证**：`./scripts/verify.sh` 的文档检查；§6.6 非空。

## 任务 1 · 表结构与迁移

- 修改 `src/db/schema/learning.ts`：`tagCategories`、`tags.categoryId`、唯一键与索引。
- 新增 `drizzle/0013_learning_tag_categories.sql`：建表、种子分类、回填、约束切换。
- 迁移脚本必须保留 `tag_id`；回填规则按 design §4.3。

**测试/验证**：

- 在一次性 MySQL 容器里对**迁移前的库副本**执行 0013，核对标签数、`course_tags` 行数、`tag_id` 集合不变；重复执行幂等。
- `drizzle-kit generate` 不产生额外迁移（verify 第 4 步）。

**对应**：TL-5；design §4。

## 任务 2 · Module：分类与标签

- `tags.ts`：`listTagCategories`、`createTagCategory`、`renameTagCategory`、`deleteTagCategory`；`createTag(categoryId, name)`；`listTags` 返回分类；审计事件。
- `index.ts` 导出；`_actions/learning.ts` 增加分类动作、标签动作加 `categoryId`。
- 测试 `tags.db.test.ts`：权限、唯一性、删除冲突、分类改名不影响引用、审计。

**验证**：`pnpm typecheck`；`./scripts/with-test-mysql.sh pnpm exec vitest --run --project db src/modules/learning/tags.db.test.ts`。

**对应**：TL-1、TL-2；design §5.1、§5.4。

## 任务 3 · 课程标签多选

- `course-common.ts`：`resolveTags` 返回分类信息；仍要求至少 1 个、最多 20 个、全部存在。
- `manage.ts`：创建/编辑保存多标签；编辑整组替换。
- 测试：`manage.db.test.ts` 增加同分类多选、跨分类、0 标签、失效标签。

**验证**：同上；`manage.db.test.ts`。

**对应**：TL-3；design §5.2。

## 任务 4 · 学习中心筛选

- `read.ts`：重复 `tag` 参数、去重、上限 20；按分类分组生成 `EXISTS`；删除 `multiple_tags`。
- 测试：`read.db.test.ts` 覆盖同类 OR、跨类 AND、无标签、非法 ID、与搜索/在学叠加。

**验证**：`read.db.test.ts`。

**对应**：TL-4；design §5.3。

## 任务 5 · 三处页面

**前置**：T0 的 §6.6 已确认；T1–T4 完成。

- 标签管理：分类分组、分类增改删、每组标签增改删与引用数。
- 课程表单：按分类分组多选；0 标签禁用保存并提示。
- 学习中心：每个分类一个多选浮层；已选胶囊；URL 重复 `tag`；清空。
- 页面守卫测试与现有学习页面一致（`requireUser` + Capability）。

**验证**：`./scripts/verify.sh`；本机 `next dev` 真实登录走查三处。

**对应**：TL-6；design §6。

## 任务 6 · 验收与收尾

- 按 [`acceptance.md`](acceptance.md) 逐条执行；迁移在测试 ECS 的库副本上演练并记录；INDEX 状态与实施记录。

## 必须停下来问的条件

1. design §6.6 为空 → 不写页面任务、不写 `src/app` 代码。
2. 迁移回填出现同分类重名 → 停止，列出重复项请业务决定合并方式；不静默合并。
3. 分类是否允许改名/删除的规则被业务推翻 → 回到 requirements。
4. 需要新增 Capability 或改变标签参与可见性 → 回到 B 域与需求决策。

## 小的判断自己做

- 分类/标签的排序值、文案措辞、空状态文案。
- 多选浮层的交互细节（点击外部关闭、已选计数）。
- 测试夹具的分类与标签名。

## 对已有代码与测试的改动

| 文件 | 改动 | 任务 |
|---|---|---|
| `src/db/schema/learning.ts` | 分类表、`tags.categoryId`、唯一键 | T1 |
| `drizzle/0013_learning_tag_categories.sql` | 新迁移 | T1 |
| `src/modules/learning/tags.ts` / `index.ts` / `_actions/learning.ts` | 分类 CRUD、标签带分类 | T2 |
| `src/modules/learning/course-common.ts` / `manage.ts` | 多选校验与保存 | T3 |
| `src/modules/learning/read.ts` | 多标签筛选 | T4 |
| `src/app/(app)/learning/**`、`_components/learning/**` | 三处页面 | T5 |
| 测试：`tags.db.test.ts`、`manage.db.test.ts`、`read.db.test.ts` | 新语义 | T2–T4 |

## 实施记录

（待实施后填写）