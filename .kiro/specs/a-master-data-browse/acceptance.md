# A 主数据浏览（a-master-data-browse）· 验收

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-master-data-browse`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11.1（2026-11-11，定稿候选）
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16（初建；尚无实施，全部自动项状态为「未执行」）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在页面上看，写明谁看、看什么、检查什么。
- `[环境]`：依赖测试 ECS 或真实数据，不能在本机离线判定；标明当前状态。
- 每条对应 requirements 的 `MDB-n`；没有「看一眼就行」的条目。
- 需要 MySQL 的自动项写成 `*.db.test.ts`（`pnpm test:db` 或 `scripts/with-test-mysql.sh pnpm exec vitest --run --project db`）；其余是 unit project（`pnpm test`）；统一入口 `./scripts/verify.sh`。
- **已实施（T1 读口、T3 页面，2026-11-16）**；下表状态是本机结果，T4 统一复核与环境项回填。

## 自动项

| # | 需求 | 检查 | 命令 / 断言 | 状态 |
|---:|---|---|---|---|
| A1 | MDB-1 | 无 Capability 的 Actor 被拒绝 | `browse.db.test.ts`：`category === "authorization"`、`code === "forbidden"`，无数据返回 | 通过 |
| A2 | MDB-1 | 页面先 `requireUser` 再按 Capability 渲染 `DeniedState` | `plan-actions.guard.test.ts` 新页面用例 | 通过 |
| A3 | MDB-2 | 品牌范围集合只返回该品牌门店 | `browse.db.test.ts`：构造 2 品牌，`brandScope` 只含其一 | 通过 |
| A4 | MDB-2 | `brandScope = "all"` 返回全部 | 同上 | 通过 |
| A5 | MDB-2 | 空品牌范围返回 0 行（显式 `FALSE`，不是「不加谓词」） | `browse.db.test.ts` | 通过 |
| A6 | MDB-2 | 越范围门店不计入总数与分公司计数 | `browse.db.test.ts`：`total` 与 `activeStoreCount` 都排除 | 通过 |
| A7 | MDB-3 | 返回字段齐全且 BIGINT 为十进制字符串、时间为 ISO UTC | `browse.db.test.ts` 断言类型与样例 | 通过 |
| A8 | MDB-3 | 排序恒定：品牌编码 → 分公司编码 → 门店编码 → `store_id` | 两次查询结果同序；乱序插入夹具后断言 | 通过 |
| A9 | MDB-3 | 已撤店门店仍在结果中 | 夹具含 `closed`，不筛选时出现 | 通过 |
| A10 | MDB-4 | 品牌 / 分公司 / 板块 / 店面标准 / 状态 / 关键字筛选各自收窄 | `browse.db.test.ts` 逐项断言 | 通过 |
| A11 | MDB-4 | 非法状态值报 `invalid_filter`，不退化为全部 | `browse.test.ts` + `browse.db.test.ts` | 通过 |
| A12 | MDB-4 | 非十进制品牌 / 分公司 ID 报 `invalid_filter` | `browse.test.ts` | 通过 |
| A13 | MDB-4 | 关键字包含匹配；`trim` 空视为未指定；超 64 字符报错 | `browse.test.ts` + `browse.db.test.ts` | 通过 |
| A14 | MDB-4 | LIKE 特殊字符被转义（`%` / `_` / `\` 不命中全表） | `browse.test.ts` `escapeLike`；db 用例：关键字 `%` 只命中字面含 `%` 的行 | 通过 |
| A15 | MDB-5 | 分公司字段与计数口径正确 | `browse.db.test.ts`：在用 / 已撤互斥且等于夹具 | 通过 |
| A16 | MDB-5 | 分公司关键字筛选与排序 | `browse.db.test.ts` | 通过 |
| A17 | MDB-6 | 默认 20、可选 50 / 100；其他值报 `invalid_filter` | `browse.test.ts` + `browse.db.test.ts` | 通过 |
| A18 | MDB-6 | `total` 与同一谓词的全量一致；分页不重不漏 | `browse.db.test.ts`：逐页合并等于全量切片 | 通过 |
| A19 | MDB-6 | 10,000 行下单页返回 ≤ pageSize | `browse.db.test.ts` 规模用例 | 未执行（夹具 30 行；规模项留 T4） |
| A20 | MDB-7 | 读口不产生审计事件 | fake 审计 sink 断言无调用 | 通过（读口不接审计；测试断言业务表不变） |
| A21 | MDB-10 | 查询带 `LIMIT/OFFSET` 与 `COUNT(*)`，不在应用层切全表 | `browse.db.test.ts` 返回行数 + 源码静态断言（无 `filter(...).slice` 模式） | 通过（返回行数；源码静态断言未单独写） |
| A22 | MDB-4 | 板块筛选按 `sector_name` 精确匹配；未知名称 → 0 行 | `browse.db.test.ts` | 通过 |
| A23 | MDB-4 | 店面标准精确匹配；「未设置」= `IS NULL`；`tier` 与 `tierMissing` 同时给 → `invalid_filter` | `browse.test.ts` + `browse.db.test.ts` | 通过 |
| A24 | MDB-4 | `filterOptions` 只统计授权品牌；`storeTiers` 不含 `NULL`；`hasMissingTier` 正确 | `browse.db.test.ts` | 通过 |

## 手工项

| # | 需求 | 谁看 | 看哪里 | 检查什么 | 状态 |
|---:|---|---|---|---|---|
| M1 | MDB-8 | 刘学奎或测试人员 | `/master-data` | 默认门店视图、状态列显示「在用 / 已撤店」；筛选后 URL 与计数一致；分页可用；刷新与后退保持条件 | 通过（2026-11-16，本机 3204 超管；本机库仅 1 家门店，翻页未触发） |
| M2 | MDB-8 | 同上 | `/master-data` | 无匹配时显示空状态与「清空筛选」，不是空白表 | 通过（`?status=closed` 触发空状态，清空后恢复） |
| M3 | MDB-1 | 同上 | 分公司人员账号 | 导航没有「主数据」；直接输入 `/master-data` 显示「无权访问」 | 未执行（需分公司账号；页面守卫由 A2 覆盖） |
| M4 | MDB-2 | 同上 | 总部人员账号 | 品牌下拉只有授权品牌；未授权品牌的门店不出现、计数不包含 | 未执行（需总部账号；读口范围由 A3–A6 覆盖） |
| M5 | MDB-5 | 同上 | 分公司视图 | 分公司行可点击并跳到门店视图且分公司筛选生效；计数与门店视图总数一致 | 通过（北京分公司 1 / 0，下钻后门店视图 1 行、select 回填） |
| M6 | MDB-9 | 实施者 | design §16.6 | 页面任务开工前确认表非空且范围覆盖本页 | 通过（2026-11-16，刘学奎；含板块 / 店面标准筛选） |
| M7 | MDB-3 | 同上 | 导入页 | 导入页顶部有同样的「浏览 ⇄ 导入」切换；导入流程本身不变 | 通过（切换可用、导入向导与步骤条未变） |

## 环境项

| # | 需求 | 环境 | 检查什么 | 状态 |
|---:|---|---|---|---|
| E1 | MDB-10 | 测试 ECS 真实库（约 8,327 家门店、40 多个分公司） | 页面首屏可用；总数与分公司计数和门店视图一致；浏览器控制台无错误 | 未执行（待部署） |
| E2 | MDB-2 | 测试 ECS，使用总部人员账号 | 授权品牌下拉与门店结果的交集正确；与数据库只读查询对照 | 未执行（待部署） |

## 覆盖不了

1. **与导入文件逐行对账**：本切片没有导出，无法用「下载回流 / 导出与界面逐行比对」证明完整一致；只能验证「读口返回的行数等于库中满足条件的行数」。若业务需要对账，先做导出切片。
2. **真实数据里的异常形态**：`dealer_code` 为空、门店跨品牌异常、编码含不可见字符等，只能靠环境项 E1 的人工走查发现，离线夹具覆盖不到全部真实形态。
3. **性能**：只验证查询形状与 10,000 行下的返回行数，不在本机断言响应时间；真实性能看 E1 的主观可用性与后续观测。
4. **浏览器兼容性**：只以本机 Chrome / Safari 走查为准，不做多浏览器矩阵。
5. **权限的穷举**：只覆盖四种角色 × 两个视图的代表性组合；不做全角色全资源组合的自动化矩阵（B 域有独立验收）。

## 逐条结果

| 组 | 结果 | 测试文件 / 证据 |
|---|---|---|
| 自动项 A1–A24 | 通过 23；A19 未执行（没有 10,000 行规模用例） | `browse.test.ts`（9）、`browse.db.test.ts`（11）、`plan-actions.guard.test.ts` |
| 手工项 M1–M7 | M1 / M2 / M5 / M6 / M7 通过；M3 / M4 未执行（需分公司 / 总部账号） | 本机 3204 真实登录（2026-11-16） |
| 环境项 E1–E2 | 未执行（待部署测试 ECS） | — |

（T4 收尾时补：全量 verify 的命令与通过数、测试 ECS 回填、A19 规模项。）