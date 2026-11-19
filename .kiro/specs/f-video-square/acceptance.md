# F 经销商视频广场（f-video-square）· 验收

> **状态**：`draft`（实现已完成，自动验收见下表；手工验收待 4400 走查）。
>
> **更新日期**：2026-11-19

## 1. 自动验收（本机 `./scripts/verify.sh`，离线、禁网）

| # | 对应需求 | 验收 | 结果 |
|---:|---|---|---|
| A1 | R1.1–R1.3 | 无 `square.read`、空范围均被拒绝；四个角色返回的字段集合完全相同 | 通过（browse.db.test.ts「授权与范围」） |
| A2 | R2.1–R2.3 | 品牌策略四种情形：无行 = 全部；单品牌 `own` = 只本品牌；多品牌任一非 `own` = 全部；超管不受影响 | 通过（policy.db.test.ts「visibleBrands」） |
| A3 | R2.4 | 品牌选项不含不可见品牌；不可见品牌的 `brandId` 筛选报 `invalid_filter` | 通过（browse.db.test.ts「观看品牌范围」） |
| A4 | R2.5 | 非超管改策略被拒绝；改策略写审计事件 | 通过（policy.db.test.ts「setBrandPolicy」、worker/square-cli.db.test.ts） |
| A5 | R3.1–R3.2 | `unknown` 类型、非 `active`、无 finalized 当前快照、外部账号、已释放名额账号的内容都不出现 | 通过（browse.db.test.ts「展示的作品集合」） |
| A6 | R3.3 | 点赞 50 不出现，51 出现；点赞为 0、missing、explicit_null、invalid、unsupported 都不出现 | 通过（browse.db.test.ts「展示的作品集合」） |
| A7 | R3.4 | 「视频」只含 `video`；「图文」含 `image` 与 `text` | 通过（browse.db.test.ts「展示的作品集合」+ filter.test.ts） |
| A8 | R4.1 | 每个非法筛选值逐项报 `invalid_filter`，不返回宽结果 | 通过（filter.test.ts + browse.db.test.ts「筛选与搜索」） |
| A9 | R4.2–R4.3 | 发布时间边界；点赞区间 50 / 51 / 100 / 101 / 300 / 301 / 500 / 501 | 通过（browse.db.test.ts「筛选与搜索」） |
| A10 | R4.4 | `q` 含 `%`、`_`、`\` 按字面匹配；101 字报错 | 通过（browse.db.test.ts + filter.test.ts） |
| A11 | R4.6 | 平台与品牌选项只含已有内容的值；视频号不出现 | 通过（browse.db.test.ts「选项」） |
| A12 | R5.2–R5.3 | 评论非 `value` 返回 `null`；`shareUrl` 为 `javascript:` / 空 → `watchUrl=null` | 通过（browse.db.test.ts「卡片字段」+ filter.test.ts） |
| A13 | R5.1 | 封面签名失败只影响单卡 | 通过（browse.db.test.ts「封面」） |
| A14 | R6.2 | 传入 `activityPlanId` 返回 `plan_filter_unavailable` | 通过（filter.test.ts（读口层；页面层把未知的 plan 参数当作无关参数丢弃）） |
| A15 | R7 | 读口返回类型里没有专员、门店、账号内部 ID 字段（类型测试 + 序列化快照） | 通过（browse.db.test.ts「返回值里没有…」（序列化内容断言；无类型层测试）） |
| A16 | 设计 §5.5 | 总数与列表同一条件；点赞降序、`content_id` 降序，翻页稳定无重复 | 通过（browse.db.test.ts「排序、分页与总数」） |
| A17 | 迁移 | `drizzle-kit generate` 无新差异；`square_brand_policies` CHECK 与外键被数据库拒绝非法行 | 通过（square-schema.db.test.ts + verify.sh 第 4 步） |
| A18 | R5.5 | 「AI分析」界面示意页：可见作品返回详情（含分公司名）；不可见或不存在一律 not_found | 通过（browse.db.test.ts「get」；页面层 404 由 `notFound()` 承担） |
| A19 | SQ-D08、B-D39 | `content_square` 的 `constraint` 如实反映 B 的范围、`contains` 走策略；Capability 注册表 30 项与 fixture 逐行一致 | 通过（policy.db.test.ts「ScopeStrategy」、roles.test.ts、acceptance-boundaries.test.ts） |

## 2. 手工验收（界面已于 2026-11-19 确认）

| # | 验收 | 结果 |
|---:|---|---|
| M1 | 按 design §10.3 原型走一遍：默认条件、芯片与下拉单选、搜索、重置、翻页 | 部分通过：服务端渲染结果与无头 Chrome 截图与原型一致（列表页、示意页）；交互（下拉跳转、弹窗）待 4400 走查 |
| M2 | 1440 宽每行 4 个卡片；悬浮显示「观看」「AI分析」；窄屏 / 触屏按钮常驻 | 未执行 |
| M3 | 「观看」新标签页打开原平台；「AI分析」弹「功能正在开发中」 | 未执行 |
| M4 | 用 `own` 策略的品牌账号登录，只看到本品牌；用超管账号看到全部 | 部分通过：2026-11-19 在临时端口用真实登录 + CLI 设策略验证（日立设为 own 后，总部 / 分公司 / 门店三个日立账号都只看到日立，超管仍看到全部）；4400 上的走查待刘学奎 |
| M5 | `ui-foundation.md` §9 清单逐条勾 | 未执行 |
