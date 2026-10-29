# 子 PRD 草案（待复核）

> **状态**：`draft`
> **建立日期**：2026-10-26
> **决定人**：刘学奎
> **它推翻的旧写法**：这批文件此前被登记为 `superseded` / `archived`（2026-09-02），放在 `archive/legacy/` 下当作历史沉淀；现恢复为**待复核的设计稿**。

## 这是什么

2026-08 写的一批产品与模块设计稿。它们不是历史沉淀，而是**子 PRD 的素材**，只是内容尚未逐条确认。

| 文件 | 原模块 | 对应将来的子 PRD | 规模 |
|---|---|---|---|
| [hbecho-设计大纲.md](hbecho-设计大纲.md) | 全平台 | 总 PRD 的补充素材（不是替代品） | 852 行 |
| [hbecho-平台底座首版产品设计.md](hbecho-平台底座首版产品设计.md) | A 平台底座 | 访问控制 | — |
| [hbecho-模块设计-权限中心.md](hbecho-模块设计-权限中心.md) | A3 权限中心 | 访问控制 | — |
| [hbecho-模块设计-规则引擎.md](hbecho-模块设计-规则引擎.md) | D 规则引擎 | 规则与考核 | — |
| [hbecho-模块设计-指标与看板.md](hbecho-模块设计-指标与看板.md) | E 指标与看板 | 指标、报表与看板 | — |

## 使用规则

1. **不是实现依据**。任何建表、接口、权限判断都不得直接照抄，尤其是其中的旧表名、旧角色矩阵、旧技术选型。
2. **冲突时以当前文档为准**：总 PRD 是 [`../prd-platform.md`](../prd-platform.md)，数据底座是 [`../domains/data-foundation/database-design-v2.md`](../domains/data-foundation/database-design-v2.md)，各域技术设计在 `.kiro/specs/*/design.md`。
3. **逐份复核后升级**：确认通过的内容写进对应的 `prd-domain-<代号>-<slug>.md`，本文档保留原样；不要直接改本文档的结论后当作新版 PRD。
4. **明确作废的结论要写下来**：复核时发现与当前基线冲突的条目，记录到对应子 PRD 的「不继承」清单，而不是静默删除。

## 已经知道与当前基线冲突的地方

详见 [`INDEX.md`](../INDEX.md) §8.4。摘要：

- 技术选型（NestJS / Prisma / BullMQ / Redis / Dify）已被 ADR-0004 延迟决定取代；
- 数据模型（`staffs` / `staff_accounts` / `staff_store_relations`）已被 v2 的 28 表取代；
- 个人权限覆盖、20 条窗口上限、pHash 去重、旧库存量迁移等假设均与当前基线冲突。