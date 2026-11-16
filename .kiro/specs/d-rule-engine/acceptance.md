# D 规则与考核（d-rule-engine）· 验收

> **状态**：`draft`（引擎与 CLI 的自动项已验收，页面项与 MAN / 部分 ENV 未做；见「逐条结果」）
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **所属域**：D 规则与考核 · **目录命名**：`d-rule-engine`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md) v1.2（定稿候选）§六
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16（任务 12：引擎、CLI、下游端口的离线验收已回填「逐条结果」；页面项未做）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出上看，写明谁看、看什么、检查什么；编号 `MAN-n`。
- `[环境]`：依赖测试机、C 的真实实现、E 或后续 spec，不能在本机离线判定；标明当前状态；编号 `ENV-n`。
- 自动项按字母分组编号（A–U），与 `MAN-n`、`ENV-n` 不会重号；每组对应 requirements 的一个 `JP-n`。
- 需要 MySQL 的自动项写成 `*.db.test.ts`（`pnpm test:db`），其余是 `unit` project（`pnpm test`）；入口是 `./scripts/verify.sh`。
- 默认测试用 `FakeSignals` / `FakeDemand` / `FakeClock`；与 C 真实实现的契约未验证时明确写「未验证」，不声称通过。
- 页面实现见 `tasks.md` 任务 13–16；离线验收先用 CLI 输出代替依赖页面的 `[手工]` 项（MAN-1、MAN-2），页面可用后补页面验收。全量视频明细归 E，D 不实现。
- 凡涉及三值结果的断言，同时断言**原因码**，不只断言结果。

## 逐条结果
**2026-11-16 · 任务 12 · 分支 `d-rule-engine`（引擎、CLI、下游端口、离线验收；页面项见 ENV-9，未做）**

### 运行记录
| 项 | 结果 |
|---|---|
| 本机 `./scripts/verify.sh`（任务 12 收尾时，合入 `origin/main` 之前的 `052d0e9` 之后） | **OK**：类型检查；unit 100 个文件 **1149** 例；迁移一致；db 128 个文件 **1666** 例（1 skipped）；密钥 / 链接 / 登记；**Python 侧未验证**（本机无 pytest / ffmpeg）；「静态门禁」在 `verify.sh` 里仍是占位，D 的五条静态护栏在 unit 的 `src/acceptance-boundaries.test.ts` 里。第一次运行曾有 1 个失败：`activity-plan/scale.perf.db.test.ts`（A 的 2,000 行并发解析在 `sync_batches` 上死锁，A 的代码，本分支未改）；同文件单独连跑 3 次全过，第二次整套全过，按**间歇性失败（A 的既有问题）**记录，未处理 |
| 测试 ECS 全量测试（ENV-2） | **通过**。实例 `i-2zef8qpi1d2mldntjgrv`，经 Workbench；一次性容器：`mysql:8.4`（独立网络、不映射宿主端口、库名 `hbecho_test`）+ `node:24-slim`（与 MySQL 共用网络命名空间，经回环访问，满足 `_test` 与回环闸门）；源码为 `git archive f5c80e7`；`pnpm install --frozen-lockfile` 15 s；typecheck + unit **1149** 例 + db **1666** 例（1 skipped）全部通过，db 370 s；容器、网络、源码目录已删除；宿主 `hbecho-mysql` 与 `hbecho` 库未触碰；没有 `.env`、没有任何凭证进入测试容器 |
| 规模演练（ENV-3） | 2,000 账号 × 20 条 = 40,000 行：**本机 32.3 s**，**测试 ECS 18.7 s**（峰值 RSS 449 MB）；表大小、阶段耗时与发现见 design §12.1 |
| 对真实 C 的契约（ENV-1，部分） | `tests/contracts/signals-port.contract.ts` 的 7 条同时对 `FakeSignals` 与**真实 `createSignals`（真实 MySQL + FakeObjectStore / FakeMatcher）**通过，发现并修正 fake 的两处差异（空 `only`、按监控段过滤阻塞项）。**仍未验证**：真实 OSS、真实图像匹配服务、真实模型 / 网关（C 的 `DisabledAiGateway` 下语音类信号读作 `capability_disabled`），以及真实采集下的评分延迟 |
| A 的真实 `plans.delete / restore` 与 `maintenance.runNow` + D 的真实下游（ENV-4） | `downstream.db.test.ts` 10 例（含 `plan_purged` 高风险审计）；与上面同一套全量测试在 ECS 通过 |
| 真实付费调用 | **没有，也不需要**：D 不发供应商调用；C 的网关默认 disabled；测试进程 `network-deny` |

### 自动项覆盖（212 条；按验收条目逐条映射测试，见任务 12 的覆盖映射）
映射方法：逐条读 `it(...)` 标题与断言，判定「已覆盖 / 部分覆盖 / 未覆盖」；拿不准的记「部分覆盖」。映射时 145 / 55 / 12；补测与修复后下表。

| 组 | 已覆盖 | 部分 | 未覆盖 | 主要测试文件 |
|---|---:|---:|---:|---|
| A 判定计划与创建 | 7 | 1 | 0 | `plans.db` |
| B 配置与校验 | 11 | 7 | 0 | `config.test`、`versions.db` |
| C 版本、草稿、发布 | 8 | 3 | 0 | `versions.db`、`execute.db` |
| D 向导进度与回退 | 6 | 4 | 0 | `versions.db` |
| E 圈定 | 17 | 1 | 0 | `circle.db`、`select.test`、`acceptance-gaps.db` |
| F 试跑 | 5 | 5 | 0 | `trial.db`、`trial.test` |
| G 执行输入冻结 | 10 | 1 | 0 | `facts.db`、`circle.db`、`acceptance-gaps.db` |
| H 内容逐层过滤 | 10 | 0 | 0 | `layer.test`、`circle.db`、`acceptance-gaps.db` |
| I 专员级达标与计划总结果 | 19 | 3 | 0 | `aggregate.test`、`execute.db` |
| J 评论要求 | 8 | 0 | 0 | `layer3-comments.db`、`acceptance-gaps.db` |
| K 账号要求 | 7 | 0 | 0 | `execute.db`、`acceptance-gaps.db` |
| L 第 3 层 | 7 | 1 | 0 | `layer3-comments.db`、`acceptance-gaps.db` |
| M 依赖协调 | 4 | 3 | 0 | `layer3-comments.db`、`acceptance-gaps.db` |
| N 证据与可解释 | 5 | 1 | 1 | `outcomes.db`、`layer3-comments.db` |
| O 运行生命周期 | 7 | 2 | 0 | `circle.db`、`judgement-loop.db` |
| P 对 E 的输出契约 | 8 | 2 | 2 | `outcomes.db` |
| Q 下游端口 | 8 | 0 | 0 | `downstream.db`、`judgement-wiring.db` |
| R 授权与审计 | 5 | 3 | 1 | `authz.test`、`audit.test`、各 `*.db` 的授权用例 |
| S 配置、门控与默认离线 | 2 | 2 | 1 | `env.test`、`judgement-main.db` |
| T CLI | 4 | 2 | 0 | `judgement-cli.db`、`judgement-main.db`、`judgement-loop.db` |
| U 对既有代码的改动与护栏 | 5 | 1 | 2 | `acceptance-boundaries.test`、`judgement-schema.db` |
| **合计** | **163** | **42** | **7** | |

**任务 12 补测的 16 条**（`acceptance-gaps.db.test.ts`，每条都对照设计里的预期，不是照着实现写）：E13、E18、G6、G11、H1、H2、J1、J4、J8、K3、K4、K7、L2、L6、M7、I16；并给 E1、F4 补上标题声称却没有的 `demand.submitted == 0` 断言。**修复的空转测试 6 处**：`versions.db` 的失效矩阵只跑首个分支；`outcomes.db` 的改绑被 `.catch` 吞掉；`circle.db` / `trial.db` 缺 `demand.submitted == 0`；`facts.db` 没有真正移动 current 指针；`execute.db` 的「改阈值再确认」没改配置（改为改数量 N 并断言配置哈希不同）。

**仍然只有「部分覆盖」的 42 条**（场景已基本覆盖，缺的是个别断言，**不声称通过**）：A6、B2、B6、B10、B11、B12、B16、B18、C4、C9、C11、D3、D5、D6、D8、E4、F3、F5、F8、F9、F10、G1、I12、I13、I14、L1、M1、M3、M4、N3、O4、O9、P1、P11、R6、R7、R9、S2、S4、T4、T6、U1。其中对业务结果影响最大的是：**C4**（`publishing` 处中断后对账恰有一次执行：现有用例的钩子抛错使整笔回滚，没有走到「C 已发布、D 未置位」）、**M3 / M4 / O4**（没有「逐阶段首次调用抛错一次」的续跑矩阵，没有「提交之后、记批次 ID 之前中断」）、**I13**（主要原因优先级只验了内容 > 评论）、**G1**（运行中改名单 / 换店后只验了分公司没验门店）、**R6**（审计写失败使业务写入回滚，没有注入审计失败的用例）。

**没有任何测试的 7 条**：
| 编号 | 原因 / 现状 |
|---|---|
| N7、R7 | 审计 detail 与日志不含签名 URL / 评论原文 / 模型 Key：没有机器化扫描。代码里没有写这些字段（静态护栏 ⑤ 禁止原文字段进配置与证据 schema），但没有对运行时输出的正则扫描 |
| P7、P8 | 「最新 completed 即当前结果、D 不激活」「D 不产出文件」：没有断言。`outcomes.ts` 的导出里没有 activate / setCurrent，D 不 import xlsx / 写文件库——靠人读，没有静态护栏 |
| R5、U7 | B 的服务身份名单零改动、A / C 零修改：**手工核对**——相对分叉点 `git diff`，A、B、C、`demand`、`orchestrator` 的模块目录零改动，`src/db/schema/` 只有 `index.ts` 加了一行导出；既有代码的其余改动只有 `plan-main.ts`（装配下游）、`package.json`、`.env.example`、两个表数量测试、`acceptance-boundaries.test.ts`、`check-doc-registry.py`。没有机器化 |
| S5、U8 | `verify.sh` 通过、既有测试保持通过：是运行结果，见上表（本机与 ECS 各一次） |

### 手工项与环境项
| 项 | 状态 |
|---|---|
| MAN-1 ～ MAN-4 | **未做**：需要业务代表与评审人在测试机上用 CLI 走查；真实 C 的图像比对与真实采集未接通，MAN-2 标「未验证」 |
| MAN-5 | design §14 各项已答复并回写；第 31 项（`toDemandActor` 的窄适配）待确认 |
| MAN-6、ENV-9 | 页面任务 13–16 未开始 |
| ENV-5、ENV-6、ENV-7、ENV-8 | 属于 E、`h-ai-min`、C 的任务 7，未验证 |

## 自动项

### A. 判定计划与创建（JP-1）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| A1 | JP-1 | 活动计划分别为 `paused` / `archived` / `deleted` 时创建 | 全部被拒；库中无判定计划行 |
| A2 | JP-1 | 非活动计划创建者的 `hq_manager` 创建；超管创建；创建者创建 | 前者被拒；后两者成功 |
| A3 | JP-1 | 同一活动计划内重复别名 | 被拒（唯一键） |
| A4 | JP-1 | 创建成功后的 D 与 C | D 有 `provisioning → active` 的计划与草稿 v1；`FakeSignals` 收到一次 `segments.create`，计划 ID 与 D 的相同 |
| A5 | JP-1 | 在「D 已落行、C 调用失败」处中断，运行 `reconcile`；再次创建同一别名 | `reconcile` 后状态 `active`；`FakeSignals` 上只有一份草稿；重复创建被别名唯一键拒 |
| A6 | JP-1 | 归档后创建草稿 / 执行；取消归档后再试 | 归档时被拒（`plan_archived`）；历史执行仍可读；取消归档后恢复 |
| A7 | JP-1 | `judgement_plans.platform_id` 与活动计划不一致 | 复合外键拒绝 |
| A8 | JP-1 | 活动计划进入回收站后读取列表 / 详情 / `listCompleted` | 全部不可见；恢复后可见 |

### B. 配置与校验（JP-2）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| B1 | JP-2 | 缺窗口起点、`kinds` 为空、`n = 0`、`bp = 10001`、阈值 `10.01`、关键词为空、`standardText` 超长 | 各被拒，错误指出字段路径 |
| B2 | JP-2 | 配置里放播放量、评论正文条件、否定、发布时段、`regex`、「作者是否为指定账号」 | zod `strict` 全部拒绝（没有这些字段） |
| B3 | JP-2 | 快手 + 评论要求；小红书 + 账号要求；快手 + 账号要求 | 全部被拒（`platformSignals` 不含对应信号） |
| B4 | JP-2 | 小红书范围下配头像 / 背景条件 | 被拒 |
| B5 | JP-2 | `kinds` 含图文 + 时长条件 | 被拒 |
| B6 | JP-2 | 两个 ASR 判定项；同一 `target` 两个 `whole_image`；同一 `target + elementKey` 重复 | 全部被拒 |
| B7 | JP-2 | 同一配置键序不同的两次序列化 | `config_sha256` 相同；阈值 `"8"` 与 `"8.00"` 规范化后相同；只改别名时哈希不变 |
| B8 | JP-2 | 图片 / 视频理解、多轮对话、OCR 相关字段 | 不存在，无法配置；`kind="image_text"` 被拒并指出 2.0 capability |
| B11 | JP-2 | `layer1.quantity.n = 0` / 非整数 / 两个不同的 N；quantity 缺省 | 前三者被拒；缺省通过校验，不截断，内容方式按 `at_least_n 1` |
| B12 | JP-2 | 能力别名 1 / 200 / 201 字；两个能力同名 | 1、200 字通过；201 字被拒；同名允许（别名不是唯一键） |
| B13 | JP-2 | `layer2.abilities` 的 `target=avatar|background` 在小红书 / 快手 | 被拒（平台信号不可得） |
| B9 | JP-2 | `deriveItems` 与 `FakeSignals.platformSignals` | 推导出的每个信号都在平台可得集合里；配置不引用目录外信号 |
| B10 | JP-2 | 配置保存的是关键词 / 话题**原文** | 取回配置与输入逐字相同（未被归一化） |
| B14 | JP-2 / D-D21 | 内容要求启用：只配评论；只配头像或背景；只配话题；只配视频时长；只配 `target=cover` 的第 2 层能力；只配 ASR；什么要求都没有 | 内容结果 NULL；NULL；启用；启用；启用；启用；草稿可保存，圈定 / 发布被拒（`no_requirement`） |
| B15 | JP-2 / D-D22 | `quantity` 存在而 `text`、`hashtags` 都为空；删掉最后一个文本 / 话题项并同一次保存去掉 `quantity` | 被拒；通过 |
| B16 | JP-2 | ASR 的 `layer3.alias`；两个能力同别名；别名为空 | 都可保存；证据靠 `abilityId` 区分 |
| B17 | JP-2 | 元素图上传：字节 SHA-256 作 `elementKey`（64 位十六进制）；同 `target` 重复字节；换图；草稿里缺 `elementKey` 的能力 | 通过 C 的正则；`element_duplicate`；新 key、旧 C 图行被删、能力的 key 更新；可保存、不能发布（`image_missing`） |
| B18 | JP-2 | 只改别名后再发布 | `config_sha256` 不变；新版本号 +1；旧执行仍显示旧别名；审计记别名差异 |

### C. 版本、草稿、发布（JP-3）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| C1 | JP-3 | 草稿 v1 `confirm` 后再 `execute` 两次 | 一个已发布版本（v1）、三次执行；`execute` 不升版 |
| C2 | JP-3 | `new-draft` → 改阈值 → `confirm` | 版本 v2；v1 及其执行仍可读 |
| C3 | JP-3 | 草稿存在时再次 `new-draft`；归档计划 `new-draft` | 被拒 |
| C11 | JP-3 | `new-draft --from <较早的已发布版本>` | 草稿 v(最新+1) 的配置与来源版本相同，`based_on_version` 为来源，C 侧图片取自来源版本 |
| C4 | JP-3 | 在 `publishing` 处杀进程后 `reconcile` | D 为 `published`，恰有一次执行（幂等键防重复） |
| C5 | JP-3 | 已发布版本上写配置 / 写图片 | `version_immutable` |
| C6 | JP-3 | 含 ASR 判定项而 `FakeSignals.executability` 不可执行时 `confirm` | 被拒，错误列出阻塞项（`capability_disabled`）；D 草稿与 `FakeSignals` 均未变 |
| C7 | JP-3 | `FakeSignals.segments.newDraft` 返回的版本号与 D 的 `latest_version + 1` 不一致 | `version_mismatch`，停止，不静默对齐 |
| C8 | JP-3 | 任意时刻 D 与 C 的版本号 | 对每个计划逐版本相等 |
| C9 | JP-3 | 圈定、试跑、执行、重新执行 | 版本号不变（D-D08） |
| C10 | JP-3 | 同一计划同时两个草稿 | 数据库拒绝（`draft_key`） |

### D. 向导进度与回退（JP-4）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| D1 | JP-4 | 未圈定时试跑 / `confirm` | 被拒（`wizard_step_required`） |
| D2 | JP-4 | 改关键词 / 数量 N | 圈定与试跑运行及其行全部删除；进度回到 `draft` |
| D2a | JP-4 | 只改能力别名 | 圈定与试跑结果保留；进度不变；`config_sha256` 不变 |
| D3 | JP-4 | 改标准图 | 试跑运行被删；圈定保留；进度回到 `circled` |
| D4 | JP-4 | 只改 ASR 标准 / 阈值 / 评论达标方式 | 圈定与试跑结果保留；进度不变；试跑报告用新阈值重算 |
| D5 | JP-4 | `compared → circled`；`circled → draft`；跳层回退 | 前两者成功；跳层被拒 |
| D6 | JP-4 | 回退不带 `--apply` | 返回将删除的运行数与行数；任何表无变化 |
| D7 | JP-4 | 回退带 `--apply` | 被回退步骤的运行与行全部消失；不留历史 |
| D8 | JP-4 | 对已发布版本回退 | `version_immutable`，提示 `new-draft`；其执行结果不受影响 |
| D9 | JP-4 | 第 2、3 页都没有配置 | 圈定后可直接 `confirm` |

### E. 圈定（JP-5）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| E1 | JP-5 | 圈定期间 `FakeSignals.requestScores`、`FakeDemand.submit`、网关调用计数 | 全部为 0 |
| E2 | JP-5 | 话题 / 关键词 `all` 与 `any`；少一个词 | `all` 不通过，`any` 通过 |
| E3 | JP-5 | 话题 `618` 与内容话题 `618大促` | 不匹配（整体相等） |
| E4 | JP-5 | 关键词只选标题 / 只选正文 / 两者 | 命中取所选字段 |
| E5 | JP-5 | 时长恰好等于边界；单位 `unknown`；状态 `missing` | 边界通过；后两者 `unobtained`，原因 `duration_unit_unknown` / `duration_missing` |
| E6 | JP-5 | 文本信号 `not_computed` | 在等；超过信号等待上限记 `dependency_timeout` |
| E7 | JP-5 | 重新圈定 | 旧运行的行全部消失 |
| E8 | JP-5 | `streamCircleRows` 中 `l1 = pass` 且 `layer1_selected = true` 的行数 | 等于圈定条数；未选中的 `l1 = pass` 行带 `layer1_selected = false`、`final = skipped`、原因 `layer1_not_selected` |
| E9 | JP-5 | 关键词用旧归一化版本写入的文本 | 关键词按文本的 `normalizerVersion` 归一化（命中一致） |
| E10 | JP-2a / JP-5 | 某专员 10 条满足全部第 1 层条件，N=6 | 按点赞降序取前 6 条；`C1=6`；未选中的 4 条 `layer1_selected=false`、`final=skipped`、原因 `layer1_not_selected`、`layer2=skipped` |
| E11 | JP-2a / JP-5 | 点赞为 `0` / `null` / `missing` / 非法值 | 真实 0 是有效值；missing / invalid 排在有效值之后；不当作 0 |
| E12 | JP-2a / JP-5 | 只有 4 条满足、N=6 | 4 条全部进入第 2 层；内容结果按 `at_least_n 6` 判不达标（无未获取时） |
| E13 | JP-2a / JP-5 | 文本与话题两个能力同时配置 | 内容必须两者都命中；数量只有一个 N，按 AND 后的候选排序取前 N |
| E14 | JP-2a | 点赞相同的多条内容 | 按 `published_at` 降序、`content_id` 升序，结果确定 |
| E15 | JP-2a | 点赞值状态为 `explicit_null` / `unsupported` / `invalid` / `missing` | 均排在有效值（含真实 0）之后；`reason_detail.like_not_value` 记条数 |
| E16 | JP-2a | N 大于候选数（N=1000，候选 4 条）；N 的上界 1000 与下界 1 | 全部进入；`n=1001` 被拒 |
| E17 | JP-2a | 两位专员各有 10 条候选、N=6 | 每位专员各取自己的前 6 条（按专员各自计算） |
| E18 | JP-2a | 圈定后又有新同步改变点赞，再执行 | 圈定条数是当时快照；执行重新冻结，二者前 N 可以不同 |

### F. 试跑（JP-6）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| F1 | JP-6 | 对 C1 的 N 个内容主体 | 内容主体的 `requestScores` 恰调用 `ceil(N / 批大小)` 次，主体只含 C1（账号主体的调用另计，见 F8） |
| F9 | JP-6 / JP-12 | 监控段同时含封面比对与 ASR 判定项，跑试跑与执行的第 2 层 | 每次 `requestScores` 的 `only` 只含第 2 层能力的信号键，**不含** `content.asr_judgement`；`FakeSignals` 没有为任何内容建第 3 层任务（直到该内容通过第 2 层并进入 `layer3` 阶段） |
| F2 | JP-6 | 换阈值再试跑 | `FakeSignals` 不产生新任务；分布不变，通过数按新阈值 |
| F3 | JP-6 | 分数 0.00 与 10.00 | 分别落入档 0 与档 10；每档样例最多 5 个；不足时只返回实际数量；确定性（内容 ID 升序）；样例槽位固定 5 个 |
| F4 | JP-6 | 素材 `pending` / `failed` / `carried_forward` | 计入未获取成功，原因码与 `FakeSignals` 返回一致；`FakeDemand.submit` 调用数 0 |
| F5 | JP-6 | 试跑期间网关调用计数 | 0（试跑不触发第 3 层） |
| F6 | JP-6 | `FakeSignals.executability` 不可执行（`image.*` 未启用） | 试跑被拒并列出阻塞项，不返回全 0 |
| F7 | JP-6 | 报告里的字段 | 只有连续分数与档位，没有「匹配 / 不匹配」 |
| F8 | JP-6 | 账号能力试跑（`target=avatar|background`） | 对名单账号调用 `requestScores`；头像 / 背景分别统计 |
| F10 | JP-6 | 添加 `image_text` / OCR 能力 | 1.0 不可添加；若配置里出现则试跑被拒（2.0 capability） |

### G. 执行输入冻结（JP-7）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| G1 | JP-7 | 冻结后改绑账号、移出名单、门店换分公司 | 本次执行的参与专员与组织链不变；新执行按新状态 |
| G2 | JP-7 | 改绑后新执行 | 参与专员 `staff_id` 与组织链取自新专员及其当前门店，而不是名单项里的旧快照 |
| G3 | JP-7 | 窗口 `to = 2026-11-10` | `to_utc` = `2026-11-10 16:00:00Z`；`to` 缺省时上界 = 冻结时刻 |
| G4 | JP-7 | 两个名单账号指向同一专员 | 运行 `failed(participant_conflict)`；不产生半截参与专员 |
| G5 | JP-7 | 名单账号没有专员归属 | 运行 `failed(no_staff_assignment)` |
| G6 | JP-7 | 冻结后移动 `contents.current_snapshot_id` | 执行读到的仍是冻结的 `content_snapshot_id` |
| G7 | JP-7 | 账号名额已释放（`slot_released_at` 非空） | 仍是参与专员；账号要求 `unobtained(account_unavailable)` |
| G8 | JP-7 | 同一冻结输入跑两次 | `run_participants` 与 `run_contents` 逐行相同（可复现） |
| G9 | JP-7 | 发布时间缺失 / 形态 `unknown` / 状态非 active / 无当前快照 | 前两者落行为 `l0=unobtained` 计入 T；后两者不入 T 且计数可见 |
| G10 | JP-7 | 窗口外的内容 | 不落行 |
| G11 | JP-7 | 执行期间其他活动计划的名单变化 | 不影响本次执行 |

### H. 内容逐层过滤（JP-8）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| H1 | JP-8 | 一条带话题但封面分数低、另一条封面分数高但没带话题 | 两条都不进 C2（同一条内容须满足全部层条件） |
| H2 | JP-8 | 第 2 层 `unobtained` 的内容 | 不出现在后续任何 `requestScores` / `demand.submit` 的主体里；`l3 = skipped` |
| H3 | JP-8 | 表驱动：每层 {通过, 不通过, 未获取} × 下一层 | 只有通过者进入下一层；其余 `final` 与 `reason_code` 正确 |
| H4 | JP-8 | `and3` 全表 3×3 | 逐格符合（不通过 > 未获取 > 通过） |
| H5 | JP-8 | 同层两个条件：一个不通过、一个仍在等 | 层结果立即为不通过（提前终止），不等 |
| H6 | JP-8 | 空层（没配条件） | `not_configured`，内容原样进入下一层 |
| H7 | JP-8 | 信号为 `stale`（可用） | 结果带 `stale = true`，三态不变 |
| H8 | JP-8 | 信号 `failed` / `not_applicable` / `missing(media_pending)` | 均为 `unobtained`，原因码逐字沿用 C 的 |
| H9 | JP-8 | 关键词条件：一个字段不可用但另一字段已命中 | 通过（单调）；两字段都不可用 → 未获取 |
| H10 | JP-8 | 分数 `"8.00"` 对阈值 `"8"` | 通过（整数百分位比较，等于判通过） |

### I. 专员级达标方式与计划总结果（JP-9）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| I1 | JP-9 | 内容（端到端）：N=5、候选 10 条，取前 5 条且全部通过；前 5 条里 1 条第 2 层不通过；N=6、候选只有 4 条且全通过 | 成功；不达标（第 6 名不替补）；不达标 |
| I1b | JP-9 | 内容（纯函数 `evaluateMethod`，不经过截断）：P=6、N=5；P=4、N=6；P=5、U=1、N=6 | 成功；不达标；未获取成功 |
| I2 | JP-9 | 内容：截断后 2 通过 + 1 条第 2 层缺素材、N=3 | 未获取成功（不是不达标） |
| I1a | JP-9 / JP-2a | 第 1 层只有 4 条满足条件（未触发截断）、N=6 | 4 条全部进入第 2 层，C1=4；内容结果不达标（无未获取时） |
| I1c | JP-9 | N=3、2 条通过 + 1 条第 1 层读不到文本信号（`l1=unobtained`） | 未获取成功（P+U=3），不是不达标；该条计入 U |
| I1d | JP-9 | N=3、参与内容 10 条都没命中话题、同步有缺口 | 不达标（T>0，不走零内容分支） |
| I1e | JP-9 | 参与内容 0 条；窗口内同步完整 / 有缺口 | 不达标 / 未获取成功 `sync_gap` |
| I1f | JP-9 | 被第 1 层未选中的内容（`final=skipped`） | 不计入 P / U / F / T，记入 `content_skipped` |
| I3 | JP-9 | 评论：全部通过：任一不通过；全通过；有未获取但无不通过 | 不达标；成功；未获取成功 |
| I4 | JP-9 | 评论：任一条通过：有通过；无通过无未获取；无通过有未获取 | 成功；不达标；未获取成功 |
| I5 | JP-9 | 评论：比例阈值：`P·10000 = bp·T` | 成功（边界含等号）；`(P+U)·10000 < bp·T` 不达标；其余未获取 |
| I6 | JP-9 | 评论四种方式 × T ≤ 5 的 (P,U,F) 穷举；内容 at_least_n 边界 | 与手写参照实现逐格相等（固定种子的属性测试） |
| I7 | JP-9 | 零内容 + 同步完整 | 不达标 |
| I8 | JP-9 | 零内容 + 最近一次列表任务失败 / 有缺口 / 窗口内无成功同步 | 未获取成功，原因 `sync_failed` / `sync_gap` / `no_sync_in_window` |
| I9 | JP-9 | `T > 0` 且同步有缺口 | 三值按 PRD 表计算不变，`sync_complete = false` 与原因被存下（§14 第 7 项） |
| I10 | JP-9 | 内容 / 评论 / 账号三项：成功 / 不达标 / 未获取成功 | 总结果不达标 |
| I11 | JP-9 | 成功 / 未获取成功 / 成功 | 未获取成功 |
| I12 | JP-9 | 只配了两类要求 | 没配的对象不参与合成，其结果列为 NULL |
| I13 | JP-9 | 主要原因 | 优先级 内容 > 评论 > 账号；内容类取条数最多的原因，并列取字典序 |
| I14 | JP-9 | 完成的执行里 | 成功 + 不达标 + 未获取成功 = 参与专员数；没有分项率字段 |
| I15 | JP-9 | 同步完整谓词：最近一次 `succeeded` / 最近一次 `failed` / **最近一次 `succeeded_with_gap`** / 窗口内有 `succeeded_with_gap` 而最近一次 `succeeded` / 检查点 `blocked` / 检查点 `rebased_after_gap` 且缺口早于窗口 / 窗口内无任何 `succeeded` / 窗口内某次失败之后又 `succeeded` 且无缺口 | 完整 / `sync_failed` / `sync_gap` / `sync_gap` / `sync_gap` / 完整 / `no_sync_in_window` / 完整（宽松版，design §14 第 26 项） |
| I16 | JP-9 | 谓词读检查点时 | 只取 `action = fetch_content_list ∧ checkpoint_scope = default` 的行 |

### J. 评论要求（JP-10）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| J1 | JP-10 | 评论 `demand` 的主体 | 只含 C2 内容（通过第 1、2 层者），不含第 3 层 |
| J2 | JP-10 | 覆盖 `complete` / `partial`（总数已知）/ `unknown` | T = 评论条数 / T 含缺口 `总数 − 已取` / T 含缺口 1 |
| J3 | JP-10 | 「至少 3 条评论含关键词」：命中 2 + 缺口 1；命中 2 + 覆盖完整 | 未获取成功；不达标 |
| J4 | JP-10 | 评论信号 `not_computed` | 在等，超限记 `dependency_timeout` |
| J5 | JP-10 | `demand` 处置 `unsupported_platform` / `content_not_found` / `capability_disabled` / 失败 / 超时 | 该内容评论记未获取，原因逐一对应；这类专员的评论结果不会是不达标（只可能成功或未获取成功） |
| J6 | JP-10 | 评论候选为空：有候选在第 1、2 层未获取；根本无参与内容；候选全部确定性不通过 | 未获取成功；按零内容规则；不达标 |
| J7 | JP-10 | 证据与落库 | 只有评论 ID（≤ 3）与计数；无评论原文、作者、点赞数 |
| J8 | JP-10 | 评论结果是否反过来过滤内容 | 否（内容 `final` 不受评论影响） |

### K. 账号要求（JP-11）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| K1 | JP-11 | 内容全部未获取成功时的账号能力 | 账号能力仍给出自己的结果，互不影响 |
| K2 | JP-11 | 无当前主页快照 | `unobtained(no_profile_snapshot)` |
| K3 | JP-11 | 素材 `pending` / `failed` / `carried_forward` | `unobtained`，原因逐字沿用 C 的 |
| K4 | JP-11 | `target=avatar` 与 `target=background` 两个能力：一个不通过、一个未获取 | 不通过（AND3） |
| K7 | JP-11 | `kind=image_element, target=avatar` | 读取 `account.avatar_element_score` + elementKey；阈值边界通过 |
| K5 | JP-11 | 分数等于阈值 | 通过 |
| K6 | JP-11 | 每个专员判几个账号 | 一个（计划平台上的唯一账号） |

### L. 第 3 层（JP-12）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| L1 | JP-12 | 默认装配（`FakeSignals.executability` 不可执行）：含第 3 层的计划发布 | 被拒；`demand.submit`、`requestScores` 调用数 0 |
| L2 | JP-12 | 同一环境下不含第 3 层的计划 | 照常发布与执行 |
| L3 | JP-12 | 执行中途 `FakeSignals` 切为不可执行（`requestScores` 整批拒绝 `not_executable`）；`layer3` 入口重调 `executability` 也不可执行 | 剩余内容 `l3 = unobtained(capability_disabled)`，其后不再发调用；第 2 层已定的结果不受影响 |
| L4 | JP-12 | 判定 `meets` / `not_meets` / `failed(invalid_output)` / `failed(model_refused)` | 通过 / 不通过 / 未获取 / 未获取（**不是**不通过） |
| L5 | JP-12 | 证据 | 含结论、理由、模型版本、提示词版本；缺一样的判定不被当作通过 |
| L6 | JP-12 | 音频 `demand` 的主体 | 只含 C2 |
| L7 | JP-12 | 音频需求 `failed` / `unsupported` / `content_not_found` | 该内容 L3 未获取，原因对应 |
| L8 | JP-12 | 第 3 层不通过的内容 | `final = fail`；不影响评论候选（评论只看 C2） |

### M. 依赖协调（JP-13）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| M1 | JP-13 | `FakeSignals` 模拟「3 次轮询后就绪」 | 正常完成；`requestScores` 只调用一次 |
| M2 | JP-13 | 「永远 pending」 | 超过等待上限后 `dependency_timeout`，运行继续并完成 |
| M3 | JP-13 | 「中途抛瞬时错误」 | 阶段退避重试后完成；`attempt_count` 增加；已定行不改写 |
| M4 | JP-13 | 杀进程后续跑 | 已定内容不重算；`demandKey` 相同、批次 ID 相同，`FakeDemand` 不收到重复提交 |
| M5 | JP-13 | 静态：`db.transaction` 回调里调用 `SignalsPort` / `DemandPort` | 护栏报错（含反向用例） |
| M6 | JP-13 | 等待上限为 0 | 所有「在等」的依赖立即 `dependency_timeout` |
| M7 | JP-13 | 取消 | 不再提交新批次；已提交的不撤销 |

### N. 证据与可解释（JP-14）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| N1 | JP-14 | `explain` 一条内容 | 逐层逐条件：用了什么条件、输入、结论、跳过了哪层、为什么停 |
| N2 | JP-14 | 删除 `FakeSignals` 里的结果行后 `explain` | 依然完整（证据自包含） |
| N3 | JP-14 | `retainUntil` 的调用 | 每个求值块写完证据后立即调用，主体恰为该块读取到的 `resultId`（去重），时间 = 该块读取时刻 + 3 个月；在 `finalize` 之前取消的执行也已调用过 |
| N4 | JP-14 | `retainUntil` 失败 | 阶段重试，不丢证据 |
| N5 | JP-14 | 越范围的专员 / 内容 | 表现为未找到 |
| N6 | JP-14 | 证据 JSON 的 schema | 不含 `title` / `body` / `content_text` / 作者字段 |
| N7 | JP-14 | 日志与审计 | 无签名 URL、评论原文、模型 Key |

### O. 运行生命周期（JP-15）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| O1 | JP-15 | 两个 worker 抢同一运行 | 只有一个拿到 |
| O2 | JP-15 | 租约过期后另一个接手 | 旧 worker 的写入被拒绝且零写入 |
| O3 | JP-15 | 同版本两次并发「确认执行」 | 只产生一个运行（`active_key` + 幂等键）；第二次返回已有运行或 `run_active` |
| O4 | JP-15 | 逐阶段杀进程后续跑 | `run_contents` 每行最多写一次；参与专员行不重复；最终结果与不中断一致 |
| O5 | JP-15 | 取消 | 状态 `cancelled`、`active_key` 清空；不出现在 `listCompleted` |
| O6 | JP-15 | 提交人被停用（fake B） | 下一个 tick 运行被取消，审计 `submitter_revoked` |
| O7 | JP-15 | 终态运行再被领取 | 不会 |
| O8 | JP-15 | `failed` 的运行 `resume` | 从持久化阶段继续，已定内容不重算 |
| O9 | JP-15 | 不同版本并行（v1 执行中、v2 草稿圈定） | 允许 |

### P. 对 E 的输出契约（JP-16）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| P1 | JP-16 | 未完成 / 取消 / 失败的执行 | 不在 `listCompleted`；`describe` 返回 `execution_not_completed` |
| P2 | JP-16 | `streamParticipants` 条数 | = 冻结的参与专员数；成功 + 不达标 + 未获取成功 = 参与专员数；每个成功专员都在其中 |
| P3 | JP-16 | 执行后改绑 / 换店再读 | 组织链仍为冻结值 |
| P4 | JP-16 | 约束 `empty` / `branches` / `self` | 分别流出 0 条 / 范围内专员 / 本人 |
| P5 | JP-16 | `streamCircleRows` | 仅圈定运行有效；行含未通过与未获取者及其结果 |
| P6 | JP-16 | fake E 消费者 | `listCompleted → describe → streams` 全序列通过；游标续传不重不漏 |
| P9 | JP-16 | 计划 A 的执行（`run_id` 小）比计划 B 的执行（`run_id` 大）**后完成**；E 在 B 完成后读一次、A 完成后再读一次 | 两次读合起来恰好得到 A、B 各一次，A 不被漏掉（游标是完成时间 + ID） |
| P7 | JP-16 | 最新 `completed` 执行 | 即当前结果；D 不做「激活」 |
| P10 | JP-16 | `streamContents` 含 `skipped` 行 | 流出，带 `layer1_selected=false`、`layer1_rank`、原因 `layer1_not_selected`、点赞值与状态；`skipped` 不影响 P2 的人数恒等式 |
| P11 | JP-16 | `ExecutionDescriptor` 的配置摘要 | 含数量 N、内容要求是否启用、每个能力的 `abilityId` / `kind` / `target` / 阈值 / 别名（执行所用版本冻结的别名） |
| P12 | JP-16 | `streamCircleRows` | 行 = 被选中 + 未选中（`skipped`）+ 未通过 / 未获取，均带结果与原因 |
| P8 | JP-16 | D 是否产出文件 | 否（没有任何写文件 / 生成 xlsx 的代码路径） |

### Q. 下游端口（JP-17）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| Q1 | JP-17 | `summarize`：有 `planned` / `running` / `waiting` 的运行；终态后 | `running ≥ 1`；回到 0；`results` 只数已完成执行的参与专员行，不含圈定 / 试跑运行 |
| Q2 | JP-17 | A 的 `plans.remove --apply` 在有在途时 | 被拒 `downstream_running`；取消后可删 |
| Q3 | JP-17 | `purge` | 删除全部 D 行并调用 `segments.purge`；第二次调用无副作用 |
| Q4 | JP-17 | `purge` 中途（C 或数据库）失败 | 抛出，A 不清除活动计划；重试完成 |
| Q5 | JP-17 | `onDeleted` / `onRestored` 重复调用 | 无副作用；恢复后判定计划立即可读 |
| Q6 | JP-17 | 调用时机契约 | `summarize` → 删除 → `onDeleted`；期满 → `purge` → 删除（记录顺序的 fake 对照） |
| Q7 | JP-17 | D 未清除时 A 物理删除活动计划 | 外键 RESTRICT 拒绝，不留孤儿 |
| Q8 | JP-17 | 活动计划删除不触发采集数据与 C 全局信号的清理 | 只调用 `segments.purge`，不调用任何 C 的清理器 |

### R. 授权与审计（JP-18）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| R1 | JP-18 | 缺 Capability 的任一入口 | 在任何读库之前被拒绝（查询计数器） |
| R2 | JP-18 | `hq_manager`（非创建者）读 / 写 / 执行 | 可读；写与执行被拒（`plan_creator` 失败） |
| R3 | JP-18 | `branch_manager` | 只读其所在分公司参与的活动计划下的判定计划；无写；他处表现为未找到 |
| R4 | JP-18 | `store_staff` | 一律被拒 |
| R5 | JP-18 | B 的服务身份名单 | 无任何改动（`SERVICE_PRINCIPALS` 与 `authorize.test.ts` 在 D 的分支上无 diff） |
| R6 | JP-18 | 高风险审计与业务写入 | 同事务；审计写失败使整笔写入失败 |
| R7 | JP-18 | 审计事件 | 创建 / 发布 / 开始执行 / 取消 / 回退 / 归档 / 清除 均有；`reasonCode` 匹配稳定枚举格式；`detail` 无签名 URL、评论原文、模型 Key |
| R8 | JP-18 | D 调 C / A 的身份 | 继承提交人：调 C 的 `SignalActor.actor` 与调 A 的 `ActorContext.actorId` 都是 `user:<提交人>`；同一运行内不变（`demand` 幂等稳定）；提交人被停用 / 撤权 / 范围无法解析后下一 tick 运行被取消；`toDemandActor` 缺 `data.sync.trigger` 被拒 |
| R9 | JP-18 | `judgement_plan` 范围策略无法解析（品牌映射失败） | 403 + 质量问题，不回退为空或全量 |

### S. 配置、门控与默认离线（JP-19）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| S1 | JP-19 | 缺任一必填数值 | CLI 与 `serve` 启动失败并指出缺哪项 |
| S2 | JP-19 | 代码中搜索数值类默认值（块大小、轮询间隔、等待上限、K 等） | 没有 |
| S3 | JP-19 | 测试进程启动 | 网络 socket 被禁止（`network-deny`） |
| S4 | JP-19 | `executability` 不可执行时 | 任何路径都不会调用 `requestScores` / `demand.submit` |
| S5 | JP-19 | `./scripts/verify.sh` | 通过；未验证项明确写出 |

### T. CLI（JP-20）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| T1 | JP-20 | design §9 的每条命令 | 至少一条 CLI 级测试（成功、输入错误、授权错误） |
| T2 | JP-20 | 缺身份环境变量 | 启动失败，退出码非零 |
| T3 | JP-20 | `rollback` / `cancel` 不带 `--apply` | 不改任何表 |
| T4 | JP-20 | 退出码 | 2（校验 / 授权）、3（冲突）、4（不存在）、5（超限）、1（其他）与 `plan-cli` 一致 |
| T5 | JP-20 | 没有 `--force`、`--skip-auth` | `parseArgs` strict 拒绝 |
| T6 | JP-20 | `serve` 收到 SIGTERM | 释放租约后退出 |

### U. 对既有代码的改动与护栏（JP-21）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| U1 | JP-21 | `drizzle-kit generate` | 无新文件；迁移在空库上成功且幂等 |
| U2 | JP-21 | 护栏 ①：D 对 A / C 的表 `insert / update / delete`；`facts.ts` 以外读 A 的表 | 违规报错（含反向用例） |
| U3 | JP-21 | 护栏 ②：import `provider-adapter` 的供应商调用、`raw-capture`、`orchestrator/claim`；写 `sync_tasks` | 违规报错 |
| U4 | JP-21 | 护栏 ③：事务回调里调用 `SignalsPort` / `DemandPort` | 违规报错 |
| U5 | JP-21 | 护栏 ④：`judgement` 下 `*.db.test.ts` 的 `Promise.all` | 违规报错 |
| U6 | JP-21 | 护栏 ⑤：配置 / 证据 schema 出现原文字段 | 违规报错 |
| U7 | JP-21 | A、C 的表与模块 | 零修改（D 的分支上对它们无 diff）；只允许改装配处（`plan-main.ts`）（B 零改动） |
| U8 | JP-21 | 既有测试 | `pnpm test`、`pnpm test:db` 保持通过 |

## 手工项

| # | 谁看 | 看什么 | 通过标准 |
|---|---|---|---|
| MAN-1 | 业务代表 + 评审人，在测试机上用 CLI | 建一个判定计划，配「时间窗 + 话题 + 标题关键词」，`judgement circle`，对照他们手里的内容数 | 圈定条数与业务人工核对一致（抽样 20 条）；未获取成功的原因看得懂 |
| MAN-2 | 同上 | 传一张标准封面，`judgement trial --wait` + `trial-report`（需 C 的真实匹配已可用且 `image.*` 已启用，否则本项标「未验证」） | 分布与样例槽位（每档最多 5 个，固定位置）对业务有意义；换阈值后通过数合理变化 |
| MAN-3 | 评审人 | 一次完整执行后 `result summary / participants`，随机抽 5 个专员 `explain` | 每个结论都能从证据复述出来（哪层、哪个条件、什么输入） |
| MAN-4 | 评审人 | 取一个「零内容」专员和一个「同步有缺口」专员 | 结果与原因符合 D-D14；`sync_complete` 提示可读 |
| MAN-5 | 刘学奎 | design §14 各项的答复 | 全部有答复；第 2、3、4、7、8 项的答复回写 requirements |
| MAN-6 | 业务代表 + 评审人 | 按 `ui-lab/d-rule-engine/precision/`（v15）走查页面：列表 → 新建 → 三页向导 → 执行记录 → 证据抽屉 | 与已确认界面一致；不出现内部字段名 / 表名；数量 N、对比元素、5 个样例槽位可理解；删掉最后一张文本 / 话题卡片后 N 消失且无弹窗 |

## 环境项

| # | 内容 | 当前状态 |
|---|---|---|
| ENV-1 | C 的真实实现与 `tests/contracts/signals-port.contract.ts` 的契约测试 | **部分验证**（2026-11-16）：7 条契约对 fake 与真实 `createSignals`（真实 MySQL + FakeObjectStore / FakeMatcher）通过；真实 OSS、匹配服务、模型 / 网关未验证 |
| ENV-2 | 测试 ECS 上的全量测试（一次性 `_test` 库容器） | **通过**（2026-11-16）：unit 1149、db 1666（1 skipped），db 370 s；详见「逐条结果」 |
| ENV-3 | 规模演练（2,000 账号 × 20 条）与表大小 | **完成**（2026-11-16）：本机 32.3 s、测试 ECS 18.7 s；数字见 design §12.1 |
| ENV-4 | A 的真实 `plans.remove / maintenance` + D 的真实 `downstream` 端到端 | **完成**：本机离线（任务 10），测试 ECS 随全量测试通过 |
| ENV-5 | E 的真实消费者（`e-metrics` spec 对齐后） | 后续 spec |
| ENV-6 | 结果下载经 E6 的三个 sheet（PRD D §六最后一条） | 属于 E 的验收；D 只证明数据口（P 组） |
| ENV-7 | H1 网关落地后第 3 层的真实 smoke | 属于 `h-ai-min`，需要人工批准、显式开关、固定预算与审计摘要 |
| ENV-8 | `image.*` 标定签字后的真实试跑 | 属于 C 的任务 7 |
| ENV-9 | 页面验收（三页向导、执行记录） | 界面设计 2026-11-13 已确认；页面任务 13–16，尚未开始 |

## 与 PRD D §六验收清单的对照

| PRD 条目 | 验收项 |
|---|---|
| 只配第 1 层时试运行无外部接口调用 | E1 |
| 播放量、评论正文不能作为第 1 层条件；点赞可用于数量排序 | B2、E10 |
| 话题 / 关键词多值全含 / 任一 | E2、E3、H9 |
| 非文本条件不提供多值组合 | B1（配置 schema 里时长、阈值是单值） |
| `[手工]` 配出时间 + 话题 + 标题关键词并看到圈定条数 | MAN-1 |
| 同一层多个条件作用在同一条内容上（AND）；数量 N 整层共享 | H1、H5、E13 |
| 第 1 层数量按点赞取前 N；按专员各自计算；N 不足 / 超候选；平局；非 `value` 点赞排后；未选中的内容不进入下一层 | E10–E17 |
| 至少 N 条：前 N 条全通过才成功，第 N+1 名不替补 | I1、I1b |
| 内容要求启用规则；N 依附文本 / 话题能力 | B14、B15 |
| 内容要求的 U 含任一层未获取；零内容只在参与内容为 0 | I1c、I1d、I1e、I1f |
| 只有第 1 层通过的内容进入第 2 层；第 2 层未获取成功的不进入第 3 层、不发 ASR | H2、H3 |
| `[手工]` 上传标准图后给出连续 0–10 分分布 | MAN-2、F3 |
| 再次执行时缺失匹配分自动补算；已有不重算 | F1、F2（D 每次调用 `requestScores`，复用由 C 保证，见 ENV-1） |
| 同一图像对象只能一张标准图；模板项每对象最多一个 | B6 |
| 元素图按条件多张；换元素图旧结果不复用 | B6；复用键由 C 保证（ENV-1） |
| 匹配结果返回连续得分与版本，不返回「匹配 / 不匹配」 | F7 |
| 小红书范围下头像、背景不可选 | B4 |
| 素材未归档的对象按三值阈值处理 | I2、F4 |
| 1.0 只开放音频 ASR + 大模型判定与评论项 | B8 |
| 表单填标准后 C 判定并产出四要素 | L5 |
| 每计划最多一个 ASR 考核项 | B6 |
| ASR 转写全局共享；判定按标准参数化 | C 的验收（ENV-1）；D 只传 `standardText` |
| capability 未验证时第 3 层不可执行，不发付费调用 | L1、L3 |
| 评论考核项只对通过前两层的内容采集评论 | J1 |
| 评论作者 ID 对齐前「作者是否为指定账号」禁用 | B2 |
| 内容至少 N 条；评论全部通过 / 任一条 / 比例阈值 | I1、I2、I3、I4、I5、I6 |
| 账号级项只判唯一账号，用最新已终态主页快照 | K1–K6 |
| 零内容专员 | I7、I8 |
| 至少 3 条：2 通过 + 1 缺素材 → 未获取成功 | I2 |
| 只有计划总完成率；每专员保存 C1 / C2 / C3 条数 | I14 |
| 计划总结果三值 AND，不达标优先 | I10、I11 |
| stale 旧值使用时带标记，仍可成功 / 不达标 | H7 |
| 配置变更并发布产生新版本；执行 / 重算 / 试跑不升版 | C1、C2、C9 |
| 回退一层删除后续结果，不保留旧版本 | D5–D8（草稿；已发布版本见 design §14 第 3 项） |
| 执行期间名单锁定；移出账号不参与 | G1、G11（冻结语义；字面「不允许修改」见 design §14 第 4 项） |
| 按执行时归属算，历史结果不因改绑改写 | G1、G2 |
| 删除活动计划进回收站 30 天；期满清除 | Q3、Q6、Q8（30 天计时归 A） |
| 有在途执行时不能删除 | Q1、Q2 |
| 圈定下载与最终下载都走 E6 | P5、P8（D 只提供数据口；E6 本身属 ENV-6） |
| 结果文件含汇总、明细、未获取成功三个 sheet | ENV-6 |
| 评论可按正文关键词判定 | J2、J3 |

## 未证明的事

- C 的真实实现与 `FakeSignals` 的一致性（ENV-1）；
- 真实采集、真实模型、真实匹配分的质量与成本（ENV-7、ENV-8，属于 A、C、H）；
- E 的消费行为与投影一致性（ENV-5）；
- 页面（ENV-9）；
- 执行期间 A 并发写入对冻结一致性的影响：冻结在多个短事务内完成，以 `frozen.roster_sha256` 与快照 ID 固定输入；高并发同步下的一致性只在测试机上用 smoke 数据复核一次（任务 12）。
