# C 识别能力（c-signals）· 实施计划

> **状态**：`draft`
>
> **执行状态**：任务 0、1 已完成（闸门 2026-11-12 通过：刘学奎确认 design §14 的 13 项；任务 1 于同日完成并推第一次）；任务 2–13 已完成（任务 7 的标定报告待业务样本，见其完成记录；第二次 push 与合并 `main` 已完成,见任务 13 完成记录末条）。进度以下方勾选为准。**新会话先读 [`handoff-2026-11-12-b.md`](handoff-2026-11-12-b.md)**
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：C 识别能力 · **目录命名**：`c-signals`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md) v1.2（定稿候选）
>
> **最近核对**：2026-11-11
>
> **更新日期**：2026-11-12

## 进度

- [x] 任务 0 · 文档前置（ADR 增补、CONTEXT 词汇、handoff 订正、INDEX、待确认闸门）
- [x] 任务 1 · schema 与迁移（2026-11-12 完成并推第一次）
- [x] 任务 2 · 骨架：目录、错误、配置、授权审计、A 事实读取口、测试挂具、静态护栏
- [x] 任务 3 · 文本纯函数：归一化、话题解析、平台字段表
- [x] 任务 4 · 特征行写入与扫描驱动（内容与评论）、历史表、对账
- [x] 任务 5 · 读取口 `SignalReader` 与五态合成；CLI `show` / `catalog`（**第一条可演示的纵向**）
- [x] 任务 6 · 监控段与标准图（含 OSS 专用桶、可执行性、清除）
- [x] 任务 7 · Python 匹配端点、Node 客户端、真实样本标定
- [x] 任务 8 · 任务表与租约、`requestScores`、评分 runner、结果行、派生信号读取
- [x] 任务 9 · 音频理解：`AiGatewayPort`、ASR 与判定 runner、提示词
- [x] 任务 10 · 能力升级、`stale` 与显式重算
- [x] 任务 11 · 保留期、`retainUntil` 与清理器
- [x] 任务 12 · CLI 全集与 `signals run` 装配
- [x] 任务 13 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾（**完成后推第二次**）
- [ ] 页面任务：**无**。本 spec 没有页面（design §15）

## Planning rules

- 每个任务是一个纵向切片：完成后能运行一条命令、看到可验证的结果，而不是只建空表或空 interface。
- 任务边界跑 `./scripts/verify.sh`（typecheck、单元测试、迁移一致、数据库测试、密钥、链接、文档登记）。**不 push**；一个 spec 一条分支 `c-signals`，只推两次：任务 1 完成后（迁移在干净库跑通，同时异地备份）与任务 13 收尾（`dev-ci-cadence`）。分支从 `main` 切出。
- 默认验收离线：不连 AI Master、不连模型、不连真实 OSS、不发起任何外网请求；MySQL 只用 `scripts/with-test-mysql.sh` 的一次性容器或 `_test` 库。
- 目录按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)：领域代码在 `src/modules/signals/`，schema 在 `src/db/schema/signals.ts`，测试与源码同目录（纯函数 `*.test.ts`，需要 MySQL 的 `*.db.test.ts`），CLI 在 `src/worker/`，Python 在 `services/capability/`。
- **迁移编号取实施时的下一个空号**。`a-activity-plan`（已用 0009）与 `g-learning-min` 各自在途，本 spec 不预占编号；合并前若撞号，由后合并者重新生成。
- 不新增未登记的依赖。Node 侧无新依赖；Python 侧只增 `opencv-python-headless`（ADR-0012 已登记，numpy 为传递依赖，任务 0 补记）。
- 所有内部 BIGINT 在 CLI / JSON 输出为十进制字符串；外部标识保留原文。
- 数据库测试里对争抢同一行锁的操作顺序 `await`，不用 `Promise.all`；并发用例用显式闸门（design §11）。
- **网络 IO 期间不持有数据库事务**（`data-discipline.md` 纪律 2）。
- C 不写 A 的表、不调 AI Master、不提采集需求；模型调用只经 `AiGatewayPort`（静态护栏守，任务 2）。
- 成本与并发类数值没有代码默认值，进配置（design §14 第 14 项）。
- 任务 0 未完成前不写迁移。
- fixture 一律脱敏、程序合成；不提交业务原图。

## 依赖图

```text
任务 0（文档前置 + 待确认闸门）
   ↓
任务 1（schema / 迁移）
   ↓
任务 2（骨架 + 事实读取口 + 挂具 + 护栏）
   ├──→ 任务 3（文本纯函数）──→ 任务 4（特征行 + 扫描）──→ 任务 5（读取口 + 五态；text 端到端）
   │                                                           │
   │                                                           ├──→ 任务 10（升级 / stale / 重算；依赖 4、5、8）
   │                                                           │
   ├──→ 任务 6（监控段 + 标准图）──┐                             │
   │                               ├──→ 任务 8（任务表 + requestScores + 评分）──→ 任务 9（ASR + 判定）
   └──→ 任务 7（Python 匹配 + 客户端）┘                                    │
                                                                            ↓
                                              任务 11（保留期 + 清理；依赖 4、8、9）
                                                                            ↓
                                              任务 12（CLI 全集 + run 装配）──→ 任务 13（验收 + 收尾）
```

任务 3 与任务 6、7 可并行（互不依赖）；其余按箭头顺序。

## Tasks

- [x] 0. 文档前置与待确认闸门
  - **Requirements:** 全部（§1.3 R2–R10）
  - **Design:** §10、§14
  - 写 ADR-0001 增补（第六个桶 `hbecho-signals`，做法同 `hbecho-course`，不含创建动作）；写 ADR-0012 补记（`POST /v1/image/match` 的 JSON 契约、签名 URL 沿用、numpy 随 OpenCV 采用，按「采用 / 用途 / 不用它做什么」格式；同时把背景里「pHash 预筛」改写为「1.0 不做预筛」）；`server-operations-runbook.md` 桶清单增加 `hbecho-signals` 的计划条目（标注「未创建」）；`CONTEXT.md` 增加 Signal、MonitoringSegment 两条词汇（只写语义）；`domain-a-handoff-to-c.md` 文首补「已知过时内容」（评论无 `parent_id`、状态词以 C PRD 五态为准）；`INDEX.md` §5、§7.1 随状态更新；ADR README 索引。
  - **待确认闸门**：design §14 第 1–5、7–10、13、15、17、18 项由刘学奎逐项答复（采纳 / 修改 / 否决）；第 6 项在任务 3 以 fixture 核对，第 11、12 项在 D 的 spec 里关闭，第 14 项在任务 13 实测后定，第 16 项的格式在 `h-ai-min` 关闭。**AI 不得把「没有反对」当作确认。**
  - 闸门通过后，C PRD 升 v1.3：订正 pHash 预筛、标点方向（§4.2）与触发点（§4.3「finalized 之后立即抽」）的措辞（若第 3、4、5 项被采纳），并在版本记录写明。
  - **验证**：`./scripts/verify.sh`（链接、登记、密钥）通过；`grep` 全仓库无指向不存在 ADR 的链接。
  - **未证明**：创建 `hbecho-signals` 桶与 RAM 变更本任务**不做**（需要单独说明并得到同意，见「必须停下来问的条件」）。
  - **完成记录（2026-11-12）**：闸门——刘学奎确认第 1–5、7–10、13、15、17、18 项（13 项）按建议采纳；第 7 项采纳的是标定的方法与门槛，不是分数；第 6、11、12、14、16 项仍未决。文档动作——ADR-0001 增补（第六个桶，未创建）、ADR-0012 补记（`/v1/image/match`、numpy、不做预筛、header 语义）、`CONTEXT.md` 增 Signal / MonitoringSegment、`domain-a-handoff-to-c.md` 文首标注过时内容、`server-operations-runbook.md` 桶清单登记（标「未创建」）、`INDEX.md` 状态更新、C PRD 升 v1.3（C-D15～C-D20；C-D09 前半句按 `structure.md` 加删除线并注明修订；D PRD §2.3 的 pHash 同步标注）、requirements 补 R11、design §14 标注已采纳。文档检查（链接、登记、密钥）通过。

- [x] 1. schema 与迁移
  - **Requirements:** SG-5、SG-6、SG-7、SG-13、SG-16
  - **Design:** §6
  - 新增 `src/db/schema/signals.ts`（九张表，含全部 CHECK、唯一键、复合外键、`ON DELETE SET NULL` 的任务→结果引用）；`contents` 增加 `idx_contents_current_selected`；`src/db/schema/index.ts` 导出；`drizzle-kit generate` 生成迁移；`pnpm db:migrate` 在干净库上通过。
  - **验证**（`signals-schema.db.test.ts`）：干净库连续迁移两次幂等；`drizzle-kit generate` 无新文件；`content_features` 的三态一致 CHECK（`title_normalized` 非空而信封说 `failed` → 数据库拒绝）；`signal_results` 的形状 CHECK（`failed` 带 `score` → 拒绝；`valid` 同时有 `score` 与 `value` → 拒绝；`score = 10.01` → 拒绝）；唯一键 `uq_signal_results_key` 拒绝重复；`segment_images` 同对象第二张模板图被唯一键拒绝、模板图带 `element_key` 被 CHECK 拒绝；复合外键拒绝指向别的内容的快照；删除被引用的 `monitoring_segments` 行被 RESTRICT 拒绝；`signal_tasks` 的租约 CHECK。
  - **完成后推第一次**（迁移在干净库跑通；异地备份）。
  - **完成记录（2026-11-12）**：分支 `c-signals`（从 `main@718a8a4` 起）。新增 `src/db/schema/signals.ts`（九张表）、迁移 `drizzle/0011_c_signals_schema.sql`（`drizzle-kit generate` 生成）、`contents` 上的 `idx_contents_current_selected`；新增 `src/db/signals-schema.db.test.ts`（26 个用例，逐条覆盖上面的验证项，另含"九张表存在且无级联""contents 索引列序"）。两处既有的表数 / `SET NULL` 计数断言随之更新：`schema.db.test.ts` 与 `bootstrap.db.test.ts` 把 C 的九张表并入"非 v2 表"排除清单（与 B、G 同一做法），全库 `SET NULL` 计数 11 → 12（`signal_tasks.result_id`，注释说明理由）。本机 `./scripts/verify.sh` 通过：数据库测试 1265 通过 / 1 个既有 skip，迁移一致，文档与密钥，Python 18 通过。
  - **观察到的偶发失败（与本任务无关，但如实记录）**：第一次完整 verify 中，`activity-plan/scale.perf.db.test.ts` 的"并发解析"用例失败过一次（`sync_batches` 更新处的事务错误，完整错误被截断，未取到锁类型）；随后单独重跑，本分支 1/2 次失败、之后 4/4 通过，干净的 `main` 工作树上 4/4 通过，第二次完整 verify 全绿。它不碰 C 的任何表；但无法证明与新增的 `contents` 索引无关，所以留一条给 a-activity-plan 的维护者核对（并发解析的死锁重试）。

- [x] 2. 骨架、事实读取口、测试挂具与静态护栏
  - **Requirements:** SG-1、SG-14、SG-15、SG-16
  - **Design:** §4、§9、§10、§11
  - `catalog.ts`（12 个信号，能力标识与版本，平台可得性，`platformSignals`，启用判断）；`errors.ts`（`SignalError` 分类）；`config.ts`（zod 校验环境变量，缺必填数值即失败）；`authz.ts`（`SignalActor`、`assert`、`actorFromEnv`）；`audit.ts`（`AuditSink` 端口与日志实现）；`facts.ts`（批量只读：`contentFacts`、`commentFacts`、`coverMaterial`、`profileMaterial`、`audioMaterial`、`mediaObjectOf`、`scopeSubjects`，含素材状态映射）；`assemble.ts` 的 `createSignals(deps)` 空壳。
  - 测试挂具：`tests/harness` 补 `insertFeature`、`insertSegment`、`FakeAiGateway`（计费计数器、`callKey` 去重、可切换 `activeModel`）、`FakeMatcher`（可编程返回分数 / 错误）；沿用 `FakeObjectStore`、`FakeClock`。
  - 静态护栏（`acceptance-boundaries.test.ts`，SG-16 四条）及各自的反向用例。
  - **验证**：目录键集合与 requirements SG-1 逐项相等；`platformSignals('kuaishou')` 不含 `account.*` 与 `comment.*`；`facts` 的素材状态映射六种输入各一例（封面取全部快照上的引用，requirements R12）（SG-2 验收第一条的输入侧）；缺 `HBECHO_SIG_*` 任一项 `actorFromEnv` 失败；四条护栏的反向用例使护栏报错。（「缺 Capability 的调用在读库之前被拒绝（查询计数器）」移到任务 5、6、8、10：任务 2 没有会读库的对外入口，不为勾选造假入口；`QueryCounter` 挂具已就绪。）

  - **完成记录（2026-11-12）**：本机 `./scripts/verify.sh` 通过。新增 `src/modules/signals/`：`errors.ts`、`catalog.ts`（12 个信号、能力版本表、`platformSignals`、启用集解析）、`config.ts`（11 项数值配置无代码默认值，缺项一次列全）、`authz.ts`、`audit.ts`、`facts.ts`（`contentFacts`、`commentFacts`、`coverMaterial`、`profileMaterial`、`audioMaterial`、`mediaObjectOf`、`scopeSubjects`、素材状态映射 `materialOf`）、`assemble.ts` 空壳、端口 `scoring/ports.ts` 与 `speech/ports.ts`；挂具 `tests/harness/signals.ts`（`insertFeature`、`insertSegment`、`insertMediaReference`、`QueryCounter`、`FakeAiGateway`、`FakeMatcher`）；SG-16 四条静态护栏与反向用例。facts 的关键断言做过变异检查（区间端点、finalized 过滤、评论 active 过滤、音频取最新批次，改坏后用例失败）。
  - **与 design 的偏差（已回写文档）**：① **封面素材（requirements R12）**：A 的封面首次规则使 current 快照常无 `cover` 引用，原写法会把多数有封面的内容读成 `not_applicable`；改为取该内容全部快照上的 `cover` 引用，优先批次最新的 `archived`，无则取批次最新的引用按状态映射，一条都没有才是 `not_applicable`（requirements §1.4 第 7 项、SG-8、design §7.6 已按 `structure.md` 加删除线修订，acceptance 增 B1a；PRD C 不需改）。该问题由 AI 发现、独立审查复核证据后采纳。② `AiGatewayPort.activeModel` 返回 `Promise<string | null>`。③ 静态护栏比 SG-16 ① 更严（对齐 design §4）：除 `facts.ts` 外的 signals 文件不得以具名 import、命名空间 import 或裸 SQL 的 FROM / JOIN 引用 A 域表，所以任务 4 的扫描查询（`contents` 游标、特征行所基于快照的批次序）要加成 `facts` 的读取函数，不放宽护栏；对 `projection`、`media-archive` 等 A 域**代码模块**的 import 不设限（任务 4 要复用 `isNewer`，任务 6 要复用 `sniffImage` / `ImageConverter`）。④ `scopeSubjects`：范围一项都没给 → `scope_required`；账号类信号带 `publishedFrom/To` 或 `contentIds` → `scope_not_applicable`；发布时间 `[from, to)`，比较的是内容 current 快照的 `published_at`（评论信号同样，已写入 design §7.10）；`brandId` 是内部品牌 ID（编码到 ID 与品牌范围校验归任务 10）。⑤ 素材 `archived` 但资产 `quarantined` 读作 `missing(media_failed)`。
  - **未证明**：「缺 Capability 的调用在读库之前被拒绝」（见上，移到任务 5、6、8、10 的第一个对外入口）；`.env.example` 的新变量名按计划随任务 12 添加。

- [x] 3. 文本纯函数
  - **Requirements:** SG-3
  - **Design:** §7.1、§7.2
  - `normalizeText`（= `normalizeKeyword`，按版本保留实现：`NORMALIZERS`）；三个平台变体的话题解析；`PLATFORM_TEXT_FIELDS`；用 `tests/fixtures/aimaster` 里的真实样本核对每个平台的列表 / 详情是否返回标题与正文字段，把结论写回 design §7.2 与 §14 第 6 项。
  - **验证**（纯函数，`unit`）：design §7.2 样本表逐行；`＃６１８`、`#618 `、`#618[话题]#` 同值；`ＨＩＴＡＣＨＩ　空调` → `hitachi 空调`；零宽字符与控制字符被删、emoji 保留；三种连写方式；超长令牌与空令牌被丢弃；上限 50；解析器抛错时调用方拿到结构化失败（含片段哈希前缀与长度，不含原文）；`normalizeText` 幂等（`f(f(x)) === f(x)`，属性测试用固定种子）；每个已存储的 `nv` 都在 `NORMALIZERS` 里；`normalizeKeyword(raw, 旧版本)` 与旧版本写入的文本同口径。
  - **未证明**：真实平台上线后新出现的话题写法；发现后升版本。

  - **完成记录（2026-11-12）**：新增 `text/normalize.ts`（`NORMALIZERS`、`normalizeKeyword(raw, version?)`、`normalizeText`）、`text/hashtags.ts`（三平台解析器表、`extractHashtags`，解析器可注入）、`text/fields.ts`（`PLATFORM_TEXT_FIELDS`）；测试 68 例全过（unit）。**两处订正 design**：① 幂等性的固定种子属性测试（5000 个串）找到反例，删不可见字符改到 NFKC 之前（v1 尚无存储数据，直接订正 v1）；② 话题正则原稿的 `#?` 会吃掉 `#a#b` 的第二个 `#`，改为 `(?:\[话题\]#?)?`。**§14 第 6 项关闭**：fixture 核对结果——快手列表 63 条从未返回正文，`text.body_normalized` 对快手读作 `not_applicable`，目录里该信号的可得平台随之不含快手（`catalog` 由 `PLATFORM_TEXT_FIELDS` 派生）；依据由 `fields.test.ts` 逐平台重算守护。
  - **未证明**：真实平台上线后新出现的话题写法；快手正文结论仅来自 3 份快手列表 fixture（63 条）。

- [x] 4. 特征行写入与扫描驱动
  - **Requirements:** SG-3、SG-4、SG-5
  - **Design:** §5.1、§7.3、§7.4、§7.5
  - `ingestContent` / `ingestComment`（`mode='normal'|'recompute'`；锁特征行、`isNewer` 排序检查、素材指纹比较、历史写入，`recompute` 跳过素材未变的短路且历史原因记 `capability_upgraded`）；`runScan`（`content_scan`、`comment_scan` 两个游标，回看窗口「迟到」查询）；`runReconcile`（`content_reconcile` 分页）；`signal_history` 写入（含 `normalizer_version`）与 `expires_at`。
  - **验证**（`*.db.test.ts`，`FakeClock`）：新内容 → 特征行三信号 `valid`；评论正文 `NULL` 与空串指纹不同但都读 `valid` 空值；同一快照重复处理 → 无写入；新批次、素材未变 → 只前移所持快照；标题变化 → 特征行更新且历史新增一行（`material_changed`，`normalizer_version` 为写入时的 `nv`）；素材未变的 `stale` 信号在 `mode='recompute'` 下仍重算（批次相同也不被 `skipped_older` 挡住；历史 `capability_upgraded`，`nv` 更新）；批次 5 之后迟到批次 3 → `skipped_older`，特征行不变；注入话题解析异常 → `hashtags` 为 `failed`，标题与正文照常；回看窗口：构造「游标已越过、但提交更晚」的内容，下一 tick 的迟到查询补上；窗口外的由对账补上；扫描中途杀进程后重做，特征行恰好一行；`suspected_deleted` 评论不被新抽取；C 的表不含评论作者列；`content_features` 值与信封的三态一致。
  - **未证明**：真实 A 同步写入并发下的回看窗口是否足够——测试机上用 `a-full-sync` 的 smoke 数据复核一次（任务 13）。

  - **完成记录（2026-11-12）**：新增 `features/compute.ts`（纯计算：素材指纹、三个文本信号、评论信号、信封）、`features/ingest.ts`（`ingestContent` / `ingestComment`，`normal` 与 `recompute` 两种模式，事务内只做锁行、排序检查、写历史、更新，死锁重试）、`features/scan.ts`（`scanContents`、`scanComments`、`reconcileContents` 及三个游标）、`ttl.ts`（保留期）；`facts.ts` 增加扫描读取函数（`batchOrders`、`contentsAfter`、`contentsLate`、`contentPage`、`commentsAfter`、`commentsInWindow`），护栏要求的“A 域表只经 facts”由此保持。`features.db.test.ts` 20 例：新内容三信号 valid；NULL 与空串素材指纹不同；快手无正文条目；重复处理无写入；新批次素材未变只前移快照；标题变化写 3 行历史（material_changed、nv、一年保留）；批次 5 后迟到批次 3 → skipped_older；话题解析器抛错 → hashtags failed、标题正文照常、失败详情不含原文；recompute 在批次相同时仍重算（capability_upgraded），且已是目标版本则不再写；**真实的 text.normalize 1→2 版本升级**（测试内临时改版本表并注册 v2 实现，历史保留 nv=1）；评论 NULL/空串/改正文/suspected_deleted/快手；游标与空转；回看窗口迟到；窗口外由对账补；对账分页与归零；游标未推进时重做恰好一行。做过三处变异检查（去掉排序检查、去掉迟到查询、去掉“素材未变只前移”，对应用例失败）。**偏差**：`recompute` 在素材未变且信封已是当前版本时返回 `unchanged`（不写空历史）；对账多读一行才判断一圈是否结束（刚好满页不误判）；评论的“迟到”查询按“特征行缺失或 `comments.updated_at` 晚于特征行”判断（评论没有快照，无法在 SQL 里比指纹）。**未证明**：真实 A 同步并发写入下回看窗口是否足够（任务 13 在测试机用 `a-full-sync` 的 smoke 数据复核）；评论 runner 每次看到是否 bump `updated_at` 未核对（只影响重复比较的开销，不影响正确性）。

- [x] 5. 读取口与五态合成（第一条纵向）
  - **Requirements:** SG-2、SG-12
  - **Design:** §7.6
  - `composeState` 纯函数与 `SignalReader.read` / `readMany`（先实现特征行类信号；结果行类的取数留桩，任务 8 补齐）；`stalePolicy`；`pending` 字段；文本类信号的 `nv` / `stale` 分支；CLI `signals catalog` / `signals show --content|--comment`。
  - **验证**：`composeState` 表驱动覆盖 design §7.6 每个分支，含「平台不支持」「平台无该字段」「最高版本的 failed 读作 missing」「只升 text.normalize、话题解析器版本不变时话题读作 stale 且 normalizerVersion 为旧值」；`readMany` 对 5,000 内容的查询次数为常数（计数器）；`read` / `readMany` 不使任务表行数变化；`stalePolicy: 'as_unknown'` 时 `usable` 为 false 且不带值；目录外信号 `signal_unregistered`；缺 Capability 的 `read` / `readMany` 在读库之前被拒绝（`QueryCounter` 断言零查询）；**演示**：造一个内容 → 推进 current 指针 → 跑一轮扫描 → `signals show --content` 看到话题与归一化标题，版本与时间齐全。
  - **未证明**：派生信号（匹配分、ASR）的读取，任务 8、9 补齐。

  - **完成记录（2026-11-12）**：新增 `compose.ts`（`composeState` 纯函数、`SignalValue` 与原因码）、`reader.ts`（`createReader` → `read` / `readMany`，`ResultLookup` 接口留给任务 8，`stalePolicy` 缺省 `use_stale`，`requires` 让 CLI 用 `data.*.read`）、`facts.platformsOf`、`src/worker/signals-cli.ts`（`catalog`、`show`，退出码与 plan-cli 一致）、`signals-main.ts`、`package.json` 的 `signals` 脚本。测试：`compose.test.ts` 16 例表驱动覆盖 §7.6 每个分支（含平台不支持、平台无字段、最高版本 failed 读作 missing、只升 text.normalize 时话题 stale 且 normalizerVersion 为旧值、已存储的值不受启用开关影响、素材缺口优先于开关）；`reader.db.test.ts` 15 例（纵向：造内容→推进 current→扫描→读到并再推进读到新值；真实的版本表临时升级得到 stale / failed_under_old_version；`readMany` 查询次数与主体数无关；读取不改任务表；缺 Capability / 目录外信号 / 缺 param / 主体种类不符 / 超 5,000 都在读库之前被拒绝——**任务 2 遗留的“读库前拒绝”用 `QueryCounter` 在这里首次落地**；封面五种素材情形的原因码互不相同；语音类要网关 activeModel 非空，只有 ASR 模型时转写可用、判定 capability_disabled）；`signals-cli.db.test.ts` 6 例（演示：`signals show --content` 看到归一化标题与话题、版本与时间；BIGINT 输出十进制字符串；缺 Capability 退出码 2 且零查询；不存在 4）。**偏差**：design §7.6 第 2 步“字段缺失”先于“平台不支持”判断（已回写）；读取返回按主体 ID 为键（同一信号的主体种类一致），不是 `Map<subject,…>`；`show` 输出归一化后的值（C 自己的派生值），不含 A 的原文。**未证明**：派生信号（匹配分、ASR、判定）的取数，任务 8、9 补齐；5,000 主体的实际耗时（任务 13 规模演练，目前只证明了查询次数为常数）。

- [x] 6. 监控段与标准图
  - **Requirements:** SG-7
  - **Design:** §5.2、§7.9
  - `segments.create` / `putImage` / `removeImage` / `setItems` / `publish` / `newDraft` / `show` / `executability` / `purge`；OSS 键规则；`signalsStore`（独立于 media 的 `MediaObjectStore` 实例，桶名来自 `OSS_BUCKET_SIGNALS`）；上传校验用 `sniffImage` + `ImageConverter`。
  - **验证**（`FakeObjectStore` 故障注入）：同对象第二张模板图替换前一张且旧对象被删；元素图按 `element_key` 多张；`published` 上任何写入 `segment_immutable`；两个判定项 / 快手含 `account.bg_*` / 目录外信号被拒；超 10 MiB 与无法解码被拒且无残留；`put` 失败不留行；事务失败后对象被清理；旧对象删除失败不影响提交；关闭某能力启用开关后 `executability` 列出阻塞项而数据不变；`newDraft` 复制出的对象键与原版本不同、字节相同；`purge` 失败可重试、幂等、会清掉孤儿对象。
  - **未证明**：真实 `hbecho-signals` 桶与 RAM（任务 13 的 `[环境]` 项，需先征得同意创建）。

  - **完成记录（2026-11-12）**：新增 `segments/items.ts`（条目 zod 与校验、`imageSlotOf` 由信号键推导图片槽位）与 `segments/index.ts`（`createSegments`：`create`、`setItems`、`putImage`、`removeImage`、`show`、`executability`、`publish`、`newDraft`、`purge`；标准图桶是注入的独立 `ObjectStore`，桶名由调用方给，OSS 键 `segments/{planId}/{version}/{target}/{template|element-<key>}/{sha256}`）。`segments.db.test.ts` 21 例：同对象第二张模板图替换（旧对象在事务外删）、元素图多张、同字节替换不误删对象、快手/小红书背景头像被拒、10 MiB 恰好可过而超限 / 无法解码 / 非图片 / 空文件被拒且无残留、`put` 失败与写后校验不一致（corrupt）不留行、事务失败清理刚上传的对象且不伤旧图、旧对象删除失败不影响提交、`removeImage`、发布前缺图 → `not_executable` 带阻塞项、已发布后三类写入都是 `segment_immutable`、关掉某能力的启用开关后 `executability` 列出阻塞项而数据不变、语音类按网关 `activeModel` 阻塞（只有 ASR 模型时判定仍阻塞）、目录里删掉的信号读作阻塞且发布被拒、`newDraft`（版本 +1、键不同字节相同、旧版本不动、源对象缺失时回滚并清理）、`purge`（含孤儿对象、不混淆 `segments/12/` 与 `segments/123/`、删除失败保留行并可重试、幂等）。变异检查：去掉“仍被引用则不清理”与“旧键==新键不删”各使对应用例失败。**偏差**：① 图片宽高记录的是 `ImageConverter` 解码后的标准化图尺寸（Node 侧没有解码器取原图尺寸；原图尺寸在匹配证据的 `preprocess` 里）；② 版本号由 C 分配（`create` 为 1，`newDraft` 为现有最高版本 +1），D 读返回值，不由 D 传入；③ 保存时不要求图片已上传（草稿逐步补图），缺图是发布时 / `executability` 的阻塞项；④ 判定项重复先报 `too_many_judgements`（优先于 `duplicate_item`）；⑤ 增加测试注入点 `hooks.beforeImageCommit` 用来触发“上传后事务失败”。**未证明**：真实 `hbecho-signals` 桶与 RAM（桶未创建，创建需先征得同意，见任务 13 的 `[环境]` 项）。

- [x] 7. Python 匹配端点、Node 客户端与标定
  - **Requirements:** SG-8
  - **Design:** §7.8
  - `services/capability/capability/match.py` 与端点；`pyproject.toml` 增加 `opencv-python-headless`；`services/capability/README.md` 端点表增加 `/v1/image/match`；pytest 用程序合成的纹理图；`src/modules/signals/scoring/matcher-client.ts`（`HttpImageMatcher`，沿用 `HttpCapabilityClient` 的错误分类思路）；**标定**：业务提供的约 20 对脱敏样本在测试机上跑，产出标定报告（样本清单、分数分布、选定的 `R_FULL` / `I_FULL`、每个整数档配一张样例图的位置），刘学奎签字。
  - **验证**：pytest——同图 ≥ 9.5，缩放 + 轻度旋转 + 亮度变化 ≥ 7，无关图 < 2，嵌入场景的元素裁剪块 ≥ 6，不含该元素 < 2，低特征图 `low_features` 且 0 分；错误体 `side` 字段；`unit`（fake `fetch`）——每个错误码的归类、版本不一致、超时；`verify.sh` 的 Python 步骤（环境满足时）。
  - **未证明 / 门槛**：`image.*` **不进生产启用集**，直到标定报告签字（design §14 第 7 项）。本机无 ffmpeg ≥ 7.1 时 Python 步骤会明确打印「未验证」，不声称通过。

  - **完成记录（2026-11-12）**：Python：新增 `services/capability/capability/match.py`（下载 → 540 宽灰度 → SIFT ≤1500 → kNN 比率 0.75 → RANSAC 5px → 模板按内点比率 / 元素按内点数映射为 0.00–10.00；元素匹配检查单应矩阵凸性与面积比；低特征图 `low_features` 且 0 分）与 `POST /v1/image/match`（错误体带 `side`，只接受 http/https，来源 404 → `source_missing`，字节不是图片 → 415），`pyproject.toml` 增加 `opencv-python-headless>=4.10`（本机 .venv 装到 5.0.0.93 + numpy 2.5.4），README 端点表与错误码表更新，`calibrate.py`（标定工具）。`tests/test_match.py` 18 例（pytest 全套 36 通过）：合成纹理图（固定种子、程序生成）——同图 ≥ 9.5、缩放旋转亮度变化 ≥ 7、JPEG q35 重压缩加模糊 ≥ 7、无关图 < 2、排序单调、嵌入元素 ≥ 6、不含元素 < 2、低特征图；HTTP 契约——响应形状、六类错误码带 side、超限、连接拒绝、非法请求（含 `file://`）。Node：`scoring/matcher-client.ts`（`HttpImageMatcher`，signals 里唯一发网络请求的文件；超时 → `timeout`，连接失败 / 无法解析的响应 / 未知错误码 / 不符合契约的成功体 → `unavailable`；错误消息经 `redact.ts` 把 URL 替换为 `<url>`），`matcher-client.test.ts` 12 例（fake `fetch`）与 `redact.test.ts`。**标定**：业务样本（约 20 对脱敏样本）尚未提供，**标定报告没有产出**——已备好 `calibrate.py` 与 [`calibration-report.md`](calibration-report.md)（状态 `未标定`、参数初值、样本要求、步骤、签字栏）。**`image.template` / `image.element` 不进生产启用集，直到报告填完并由刘学奎签字**（`HBECHO_SIGNALS_ENABLED` 缺省不含它们）。**偏差**：版本一致性校验放在任务 8 的 runner（客户端只传输与分类）；`calibrate.py` 与报告模板是为“可复现地标定”多做的两个文件。**未证明**：真实封面 / 背景 / 头像上的分数分布（初值只在合成图上成立）；真实 HEIC 在 `/v1/image/match` 里的路径（复用 `image.to_normalized_jpeg`，本机有 ffmpeg 8.1 但本任务测试用的是 PNG）；CI 的 verify 不安装 Python 依赖，Python 步骤在 CI 里按既有逻辑会打印“未验证”，Python 侧通过只在本机（及后续测试机）有证据。

- [x] 8. 任务表、`requestScores` 与评分
  - **Requirements:** SG-6、SG-8、SG-12、SG-13
  - **Design:** §5.3、§7.7、§7.8、§7.5
  - `tasks/`（入队幂等——含「任务 `succeeded` 但结果行已被清理」时置回 `pending`、`SELECT … FOR UPDATE SKIP LOCKED` 领取、心跳、fenced 写入、重试与退避、`dead`、revive；`revive` 拒绝 `run_cancelled` 任务）；`requestScores`；评分 runner；结果行写入；`SignalReader` 补齐结果行类（含 `pending` 提示）；`needMedia`。
  - `requestScores` 同时处理 `content.asr_text`（`activeModel('asr')` 为空时读作 `capability_disabled`，任务数 0）。
  - **验证**：requirements SG-8 验收第一条（100 主体：80 建任务 / 20 按映射返回，`carried_forward` 无任务）；二次请求与任务完成后再请求都不新增任务；换标准图后对同批主体新建任务；两个 worker 抢同一任务只有一个拿到，租约过期后接手，旧 worker 写入被拒绝且零写入；任务在调用返回后、事务提交前崩溃（fake 注入），重启后结果行恰好一行；版本不一致 → 瞬时失败不写结果；重试用尽 `dead` 且无结果行，`requestScores` 把它置回 `pending`；`succeeded` 但结果行已被清理时再次 `requestScores` 置回 `pending`；`dead(run_cancelled)` 的 chunk 任务 `revive` 被拒；候选图解码失败写 `failed(image_unreadable)`，标准图侧失败任务 `dead`；runner 调用能力服务期间连接池无未提交事务；同一标准图字节被两个段引用，同封面只算一次。
  - **未证明**：真实 Python 服务上的吞吐（任务 13）。

  - **完成记录（2026-11-12）**：新增 `tasks/queue.ts`（幂等入队 `enqueueMany`：created / reused / revived（dead 置回 pending 并清零计数）/ requeued（succeeded 但结果行已被清理）；`claim`：`FOR UPDATE SKIP LOCKED`、租约、fencing 令牌 +1、每次领取算一次尝试（崩溃接手同样计数，用完直接 dead）；`fenced` / `succeed` / `failTransient`（指数退避）/ `failDead`；`pendingHints`）、`scoring/params.ts`（参数指纹与监控段解析，请求与读取共用；判定先取模型版本再算指纹）、`scoring/results.ts`（同键最高版本一行）、`scoring/lookup.ts`（读取口的结果行取数 + pending 提示）、`scoring/request.ts`（`requestScores`：素材状态映射、只补缺失、同素材同参数只建一个任务、`needMedia`）、`scoring/runner.ts`（评分 runner：事务外调用能力服务、能力版本校验、候选图确定性失败写 `failed(image_unreadable)`、标准图侧失败 dead、瞬时失败重试、证据与错误详情脱敏）、`assemble.ts` 装配（`createSignals` 现在返回 `segments`、`reader`、`requestScores`、`scoreRunner`）。`scoring.db.test.ts` 20 例：100 主体（10 无引用 / 5 pending / 5 carried_forward / 80 已归档）→ 80 任务、20 按映射返回、carried_forward 无任务且在 needMedia；二次请求与完成后再请求都不新增任务；同封面只算一次、两个监控段引用同字节标准图共享结果（血缘记第一次的计划，不进复用键）；换标准图新建任务且旧结果保留；账号主体与平台不符；缺 Capability 零查询、超 5,000、监控段不存在、不可执行；完成后读取口读到 valid（分数、证据、能力版本、`resultId`），排队时 `pending: queued`，升级版本后 `stale` 且不重算；版本不一致重试（退避 1×、2×）→ dead → 再请求置回 pending；瞬时错误分类；候选图四类确定性失败写 failed 且不重试、证据无 URL；标准图侧失败与被清除的标准图 → dead(reference_unreadable)；A 的对象不可用 → failed；**调用能力服务期间无未提交事务**（`innodb_trx` 断言）；两 worker 抢任务只有一个拿到、租约过期接手、旧 worker 写入被拒且零写入；调用返回后崩溃 → 恰好一行；反复崩溃最终 dead；同键并发写命中；结果行被清理后置回 pending。变异检查四处（去掉 fencing、去掉版本校验、去掉 requeue、去掉接手时的次数检查，各使对应用例失败）。**偏差 / 补充**：① 配置新增两个必填项 `HBECHO_SIGNALS_RETRY_BACKOFF_MS`、`HBECHO_MEDIA_MAX_BYTES`，并要求租约大于匹配超时（已写入 design §14 第 14 项）；② 判定的读取在网关 `activeModel('judge')` 为空时算不出参数指纹，读作 `capability_disabled`（已存的旧模型结果要在有模型后按其版本重新请求）；③ `requestScores` 对 ASR 文本也会建任务（运行在任务 9）；④ 返回的 `items[].subjects` 用数组而不是 Map。**未证明**：真实 Python 服务上的吞吐（任务 13）；真实 OSS 签名 URL 下 Python 能否读到两个桶（任务 13 的端到端档，桶未创建）；评分并发在多个 worker 进程下的吞吐（只证明了 SKIP LOCKED 的互斥）。

- [x] 9. 音频理解
  - **Requirements:** SG-9
  - **Design:** §5.4、§7.5、§13（SG-D09、SG-D18）
  - `AiGatewayPort` 与 `DisabledAiGateway`；ASR runner；判定 runner（含 `deferred`）；提示词模板 `asr-judge`（版本 1）与输出 zod；`requestScores` 对音频类的规划；`SignalReader` 补齐。
  - **验证**：默认装配下请求 → 任务数 0、网关调用数 0、读作 `missing` / `capability_disabled`；fake 网关：同音频两次请求 ASR 只调一次；不同标准文本互不复用，相同标准 + 提示词版本 + 模型版本复用；模型版本 `m1 → m2` 产生新行、旧行保留；同一 `callKey` 只计费一次，崩溃重试用同一 `callKey` 结果行仍一行；输出缺 `reason` 或 `verdict` 非法 → `failed(invalid_output)`，不是 `not_meets`；网关瞬时错误重试、用尽 `dead`；ASR 缺失时判定 `deferred` 不计重试，20 次后 `dead(dependency_timeout)`；音频未归档 `missing(audio_not_archived)` 且无任务；判定行含结论、理由、模型与提示词版本；每段至多一个判定项（任务 6 已守，这里再断言一次执行路径）。
  - **未证明**：真实模型质量与计费（属于 `h-ai-min` 的 smoke）。

  - **完成记录（2026-11-12）**：新增 `speech/disabled.ts`（`DisabledAiGateway`：`activeModel` 恒为 null，`createSignals` 缺省装配它）、`speech/prompt.ts`（判定提示词 `asr-judge` v1 的渲染与输出 zod：缺 `reason`、`verdict` 非法、多余字段都不通过）、`speech/runner.ts`（`createSpeechRunner`：ASR 与判定 runner、`callKey` = 任务幂等键十六进制、模型拒绝 → `failed(model_refused)`、输出非法 → `failed(invalid_output)`、网关瞬时错误重试后 dead 且不写结果行、判定在 ASR 缺失时 `defer`（撤销尝试计数，`HBECHO_SIGNALS_DEFER_*`，超限 `dead(dependency_timeout)`）、没有 ASR 模型时 runner 一个语音任务都不领）；`tasks/queue.ts` 增 `defer`；`scoring/result-row.ts` 抽出结果行构造，评分 runner 改用它；测试世界抽到 `tests/harness/signals-world.ts`（任务 8 的测试改用，仍 20 例通过）。`speech.db.test.ts` 16 例：默认装配下请求被拒（`model_unavailable`）、任务 0、读作 `capability_disabled`；同音频两次请求 ASR 只调一次，ASR 结果跨监控段共享；音频未归档 → `missing(audio_not_archived)` 无任务且列入 `needMedia`；**调用成功后写结果前崩溃，重启用同一 callKey，计费一次、结果一行**；输出非法 / 拒绝 → failed（不是 0 / 空文本 / not_meets）；网关瞬时错误 → dead 且错误详情无签名 URL；判定 deferred（`attemptCount` 0、`deferCount` 1、30 秒后再试）并按需建 ASR 任务；ASR 完成后判定结果行含结论、理由、模型、提示词 ID 与版本、标准文本哈希、转写结果 ID、`callKey`；不同标准文本互不复用，相同标准（规范化后）+ 提示词版本 + 模型版本跨监控段复用；模型 m1→m2 产生新行、m1 保留；请求后运行前换模型 → `dead(model_changed)`；转写失败 → 判定 failed 保留原失败码；ASR 任务已 dead → 判定自己 dead 且不复活 ASR；延后超限 → dead；只有 ASR 模型时判定被 `executability` 阻塞。变异检查三处（去掉 defer 的计数撤销、去掉模型变更检查、让非法输出不判失败，各使对应用例失败）。**偏差**：① `AiGatewayPort` 的 `judge` 改为 C 渲染提示词（`promptId`/`promptVersion`/`system`/`user`）、网关返回**原始结构化输出**由 C 校验（任务 2 的草案是 `transcript`/`standardText`，无法满足“输出不符合 schema → invalid_output”由 C 判定）；新增 `GatewayRefusedError` 表示模型拒绝；② 新增死亡原因 `model_changed`（已写入 design §6.4）；③ ASR 能力版本不含模型版本（design §12 已写明），换 ASR 模型靠人为升 `speech.asr` 版本。**未证明**：真实模型质量与计费（属 `h-ai-min` 的 smoke）；真实 OSS 签名 URL 能否被网关读取。

- [x] 10. 能力升级、`stale` 与显式重算
  - **Requirements:** SG-10、SG-11
  - **Design:** §7.10
  - `ScopeResolver`；`recompute.preview` / `apply` / `cancel`；`recompute_chunk` runner（每块前后检查 run 状态）；`signal_recompute_runs`；审计事件（含 `recompute.cancel`）。
  - run 语义：`active_key` 唯一；同范围 `running` / `failed` 续跑原 run，`completed` 后再 `apply` 新建 run 且跳过已是目标版本的对象；`cancel` 只对 `running` / `failed` 有效，置 `cancelled`、清 `active_key`，未开始的 chunk 置 `dead(run_cancelled)`，已领取的 chunk 在分块边界停止；`tasks revive` 拒绝复活。
  - **验证**：requirements SG-10、SG-11 验收逐条——升版本后读作 `stale` 且无新任务、无新计划版本；`stalePolicy` 两种；无范围 `scope_required`；预览与执行条数一致且预览不写表；无 `rule.definition.manage` 被拒；品牌范围外的对象不在展开结果；重算后范围内 `valid`、范围外仍 `stale`；重算中途杀进程后续跑，历史表无重复；重算记录（含 `from_version` / `to_version` / `scope_count`）与审计事件各一条；failed run 可重启续跑（在 `cursor_id` 处复活/新建 chunk）；迟到 chunk 在非 `running` 的 run 上置 `dead(run_not_running)`；completed 后范围内新进入的对象再次 `apply` 能被补上且旧对象不重复；`from_version` 无旧值时为 NULL；素材未变、批次相同的 `stale` 文本信号重算后读作 `valid` 且 `normalizerVersion` 更新，历史原因 `capability_upgraded`；`comment.text_normalized` 按内容范围重算；`cancel` 后未执行的 chunk 不再运行、不产生新的历史/结果行，`revive` 拒绝，同范围可新建 run；对 `completed` / 已 `cancelled` 的 run 调用 cancel 被拒；重算不改监控段版本；`brandId` 范围经当前归属展开（造一个换店的账号验证用的是当前归属）。

  - **完成记录（2026-11-12）**：新增 `recompute/scope.ts`（范围校验与规范化：至少一项、ID 为不带前导零的正整数、品牌编码解析并校验操作者品牌范围、把操作者的品牌范围固化进 run 的 `restrict_brand_ids`，chunk 无需操作者在场）、`recompute/index.ts`（`preview`、`apply`、`cancel`、`runBatch` / `runChunk`；run 记录含操作者、信号、范围、`scope_count`、`from_version`（apply 时范围内最低版本，无旧值为 NULL）、`to_version`；分块 500 个主体（可注入），推进游标 / 建下一块 / 任务 succeeded 同一事务，提交前重读 run 状态）、`tasks/revive.ts`（`tasks revive`：非 dead、`run_cancelled`、已完成 / 已取消 / failed run 的 chunk 一律拒绝）；`tasks/queue.ts` 增 `enqueueIn`（在调用方事务里入队）；`scoring/request.ts` 增内部入口 `requestAsService`（`includeStale` 把旧版本有效值也当缺失、`only` 限定信号）；`facts` 增 `brandIdsOf`、`materialForSignal`、`restrictBrandIds`；`assemble` 返回 `recompute` 与 `tasks.revive`。`recompute.db.test.ts` 15 例：升版本后读作 stale（两种 stalePolicy）且无新任务 / 无新监控段版本 / 扫描器不重算；`scope_required`（含只有 segmentRef）/ `scope_empty` / `signal_unregistered` / `scope_invalid`（前导零 ID）/ `segment_ref_required`；缺 Capability 零查询；preview 不写任何表且与 apply 条数一致，run 记录与审计事件齐全；范围内重算后 valid（nv=2、历史 `capability_upgraded` 且保留 nv=1、素材未变批次相同也重算）、范围外仍 stale、监控段不变；**5 对象 / 每块 2 个 + 两次中途杀进程（含“对象已处理、游标未提交”）续跑，历史表恰好 15 行**；同范围 running 续跑原 run、completed 后新建 run 并补上新进入的 stale 对象而不重复处理旧对象；failed run 再 apply 在 cursor 处复活 chunk 并完成，且不能直接 revive；取消（未执行 chunk → dead(run_cancelled)、revive 被拒、不再运行、同范围新建 run、对 completed / cancelled 再取消被拒、正在执行的 chunk 看到 cancelled 不建下一块）；品牌范围外的对象不在展开结果（含账号换到别的品牌门店后跟着走）、brandCode 越权被拒；评论类按内容范围重算；**派生信号**：image.template 升 2 后旧结果 stale、补算不覆盖、重算建 v2 任务、旧行保留、读到 v2。变异检查三处（去掉提交前的 run 状态重读、去掉品牌范围约束、让重算走 normal 模式，各使对应用例失败）。**偏差（已回写 design §7.10）**：① 派生信号重算必须带 `segmentRef`；② 重算特征信号以“行”为单位，三个文本信号一并升级；③ 对外范围用 `brandCode`；④ 增加 `chunkSize` 注入点便于测试多块续跑。**未证明**：200 万级对象的重算吞吐（规模演练只覆盖 20 万内容扫描等，见任务 13）；真实 failed 状态的触发路径只在测试里用直接改库模拟了“chunk 用尽重试”的结果（runner 观察到 dead 时置 failed 的代码路径由 `failTransient` 分支覆盖，没有专门的故障注入用例）。

- [x] 11. 保留期与清理
  - **Requirements:** SG-10
  - **Design:** §7.11
  - 写入时的 `expires_at`；`retainUntil`；清理器（结果行、历史行、过期任务）；每日调度点。
  - **验证**（`FakeClock`）：推进 13 个月，未引用成功结果被清理；推进 4 个月，失败行被清理；`retainUntil` 延后后到原时间点仍在、传较早时间不缩短；清理后读取 `missing` 且任务表无新行；特征行不被清理；分块删除中途退出可重跑；`retainUntil` 的契约测试（fake D 的调用序列）。
  - **完成记录（2026-11-12）**：新增 `retention.ts`：`retainUntil(actor, resultIds, until)`（`UPDATE … SET expires_at = GREATEST(expires_at, :until)`，只接受结果行 ID、去重、每 1000 个一批；授权 `rule.run.execute`，先于读库；`until` 非法 → `invalid_until`）与 `purgeExpired({chunkSize?, shouldStop?})`（按 `expires_at` 升序分块删除结果行、历史行、**终态**任务 `succeeded` / `dead`，每块 1000，循环到该表无过期行；`shouldStop` 在每块之后检查，返回 `completed: false`，重跑从剩下的继续；不入队、不调能力服务）；`assemble` 返回 `retention.{retainUntil, purgeExpired}`；`index.ts` 导出。写入时的 `expires_at`（结果 +1 年 / 失败 +3 个月 / 历史 +1 年 / 任务 +1 年）在任务 4、8 已落地，本任务不改。`retention.db.test.ts` 6 例：推进 4 个月只清失败行、13 个月清成功行与任务，清理后读取 `missing(not_computed)`、任务表无新行、没有再调用能力服务；运行中的过期任务不删、重复运行幂等；特征行不被清理，历史行按取代时刻 +1 年清理，`chunkSize=2` 删完第一块就停，再跑清完；`retainUntil` 延后后到原时间点仍在、较早时间不缩短、过新时间点才被清；fake D 的调用序列（读取 → 对 `resultId` 去重 → `retainUntil(读取时刻 + 3 个月)`，已清理的 ID 不报错，不碰历史与别的结果行）；缺 Capability 与非法 `until` 在读库前被拒（以“碰库即抛错”的代理断言）。变异检查两处（`GREATEST` 改为直接赋值、任务清理不限终态，各使对应用例失败）。**偏差**：① `retainUntil` 返回 `{ matched }`（命中的行数）而不是“实际延长的行数”：连接按命中行计数，值未变的行也算，要精确区分需要多一次查询，D 用不到；② `retainUntil` 的 Capability 定为 `rule.run.execute`，已写入 requirements SG-14；③ 清理器的每日调度点不在本任务，放在任务 12 的 `signals run`（`signals retention --once` 调 `purgeExpired`）；④ `chunkSize` 与 `shouldStop` 是为测试和优雅退出加的注入点，`chunkSize` 缺省是 design 写死的 1000。**未证明**：真实数据量下清理的耗时与锁等待（任务 13 规模演练里补一次大批量过期行的删除耗时）；`retainUntil` 与清理器并发（同一行被同时延长与删除）只靠单语句的原子性保证，没有并发测试。

- [x] 12. CLI 全集与常驻装配
  - **Requirements:** SG-14、SG-15
  - **Design:** §9
  - `signals-cli.ts`（全部子命令）、`signals-main.ts`（装配真实依赖：池、日志、两个 OSS 实例、能力服务地址、网关选择 = 默认 `DisabledAiGateway`）、`package.json` 脚本、`.env.example` 变量名；`signals run` 的循环（扫描 tick、任务领取、每小时对账、每日清理、优雅退出）。
  - **验证**：CLI 单元 / db 测试（假依赖）——每个子命令的成功与拒绝路径、退出码、JSON 输出无原文（含 `recompute cancel` 的 `run_not_cancellable`）；缺身份环境变量启动失败；启用集里写目录外能力标识启动失败；缺必填数值配置启动失败并指出缺哪项；`signals run` 在 fake 依赖下跑完一个「入库 → 扫描 → 读到」循环并响应停止信号。
  - **未证明**：compose 服务与资源上限（本 spec 不交付部署形态）。
  - **完成记录（2026-11-12）**：`src/worker/signals-cli.ts` 重写为全集：`catalog`、`show`（原有）、`segment create | set-items | put-image | remove-image | show | check | publish | new-draft | purge`、`score`（`--contents` / `--accounts`，值是 ID 清单或文件）、`recompute preview | apply | cancel`、`scan | reconcile | retention --once`、`tasks list | revive`、`run`；`parseArgs` strict，输出 JSON、BIGINT 为十进制字符串，退出码沿用 plan-cli；`score` 只输出每个信号的处置与原因分布和 `needMedia`，不逐主体展开；没有 `--force` / `--skip-auth` / `recompute --all`，`--scope` 只认六个已知键。新增 `src/worker/signals-loop.ts`（`runSignalsLoop`：每 `scanIntervalMs` 扫描内容与评论，每 `reconcileIntervalMs` 对账，启动时与此后每 24 小时清理，再各跑一轮评分 / 语音 / 重算 runner；没领到任务才睡 `scanIntervalMs`；某一步抛错只记日志；停止信号打断睡眠并让清理在块间退出）；`signals-main.ts` 装配真实依赖（连接池、pino、两个 `OssObjectStore`、`HttpCapabilityClient` 当转换器、`HttpImageMatcher`、缺省 `DisabledAiGateway`），数值配置走 `parseSignalsConfig`；`signals run` 缺 OSS / 能力服务变量直接失败并点名，其余命令缺这些时只在真正用到时报“未配置”；`assemble.ts` 增 `scanner.{contents,comments,reconcile}`；新增 `tasks/list.ts`（`tasks.list`，不返回 params）；`.env.example` 增全部变量名（无值，起始值写在上方注释并声明不是合同）。测试：`signals-cli.commands.db.test.ts` 8 例（segment 全流程含发布后写入被拒、`purge` 无 `--apply` 不删；`score` 清单 / 文件输入与分布输出；`tasks list` / `revive` 的成功与拒绝；`recompute` 的范围拒绝、apply、cancel 与重复 cancel 的 `run_not_cancellable`；`scan` / `reconcile` / `retention` 的 `--once` 与授权；输出不含标题原文；`run` 与严格解析）、`signals-loop.db.test.ts` 4 例（入库 → 扫描 → 读到、任务被执行、首轮清理、空闲睡眠后停止；间隔门控；步骤抛错不退出；已停止时不执行）、`signals-main.db.test.ts` 2 例（真实入口以子进程启动：缺库地址 / 缺身份 / 缺数值配置 / 启用集写目录外标识都退出码 1 并点名；`catalog`、`tasks list`、`segment check` 不需要 OSS，`run` 缺 OSS 变量失败）；原 `signals-cli.db.test.ts` 改用 `createSignals` 装配。变异检查三处（步骤不捕获异常、`purge` 不要求 `--apply`、空闲不睡眠，各使对应用例失败 / 挂起）。**偏差 / 取舍**：① CLI 的 `scan` / `reconcile` / `retention` / `run` 要求操作者持有 `rule.definition.manage`（design 只说这些由 `service:signals-worker` 执行；CLI 入口加一道运维闸，执行本身仍是固定服务身份）；② `segment purge` 不可恢复且没有预览，要求显式 `--apply`；③ `tasks list` 需要新增 Module 函数（CLI 不直接读库），要求 `rule.definition.manage`，默认 `--limit 50`、上限 500；④ 所有 CLI 命令现在都要求完整数值配置（fail closed），连 `catalog` 也一样；⑤ 清理固定每 24 小时，没有配置项。**未证明**：真实 OSS / 能力服务上的 `segment put-image` 与 `run`（桶未创建，任务 13 的 `[环境]` 项）；`run` 在多进程并发运行时的行为只证明了任务领取互斥，扫描器多进程重复扫描靠 `ingest` 幂等，没有专门的并发测试；compose 服务与资源上限（本 spec 不交付）。

- [x] 13. 全量离线验收、规模演练、测试 ECS 运行与文档收尾
  - **Requirements:** 全部
  - **Design:** §11、§12.1
  - 逐条完成 [`acceptance.md`](acceptance.md) 的 `[自动]` 项并回填结果；规模演练：20 万内容的扫描吞吐、`readMany` 5,000 主体耗时与查询次数、1 万个评分任务（fake 匹配器）的领取吞吐，数字回填 design §12.1；在测试 ECS 上（按 `server-access.md` 第 5 条的条件）跑一次全量 `verify.sh` 与一次真实 Python 匹配 smoke（无付费调用），记录通过数与耗时。smoke 分两档：**Python 自带的本地文件档**（pytest 读本地合成图，不依赖桶）必做；**Node → 签名 URL → Python 的端到端档**需要先创建 `hbecho-signals` 桶（ENV-1），桶未创建时只做前一档并如实记录；`INDEX.md` 更新状态；`server-operations-runbook.md` 桶清单回填实际状态；C PRD 版本记录补一行实现状态。
  - **验证**：`./scripts/verify.sh` 通过；Python 侧未验证时明确写出；acceptance 逐项勾选并写明尚未证明的部分。
  - **完成后推第二次**；CI 绿后按 `dev-ci-cadence` 合并（`--no-ff`）。
  - **完成记录（2026-11-12）**：
    - **验收**：[`acceptance.md`](acceptance.md)「逐条结果」逐条回填了 A–P 全部 `[自动]` 项（每条写明被哪个测试覆盖）。原先没有覆盖或只间接覆盖的补了测试：`acceptance.db.test.ts`（D4 / D7、E6、G6、G11、G12、I12 执行路径、K12、fake D 的调用序列 L8 兼 L5 / H13 / M7 / N5）、`acceptance-boundaries.test.ts`（E5；护栏 ③ 的扫描范围扩到 `src/worker/signals-*.db.test.ts`）、`text/hashtags.test.ts`（O5）。部分证明的条目（◐）：E4、F6、F9、K2、K15、N2，原因写在各条里。手工项与环境项的状态已更新。
    - **规模演练**：新增 `scale.perf.db.test.ts`（默认缩小规模，`HBECHO_SIGNALS_DRILL=full` 为 20 万内容 / 5,000 主体 / 1 万任务 / 1,000 个端到端任务），数字与说明回填 [design §12.1](design.md)。
    - **测试 ECS**（只经 Workbench；条件见 `server-access.md` 第 5 条）：`scripts/ecs-test.sh` 扩展出 `SUITE=full`（先跑类型检查与离线单元）、`SIGNALS_DRILL=full`、`PY=1`；提交 `b04b308` 的归档上，类型检查通过、单元 996 通过（9 秒）、数据库测试 1429 通过 + 1 个既有 skip（547 秒，含完整演练）。Python：`test_match.py` 18 通过（宿主机无 ffmpeg，venv 里的 imageio-ffmpeg 提供 ffmpeg 9.0.2，未改系统）。**HEIC 路径（`test_image.py` / `test_app.py`）没有在 ECS 上跑。**
    - **`hbecho-signals` 桶与 RAM**（刘学奎事先书面同意）：创建桶（cn-beijing、私有、Standard、LRS、阻止公共访问、碎片 7 天）；`hbecho-oss-rw` v2 → v3 只追加 `SignalsStdImageReadWriteDelete`；测试 ECS 实例角色实测放行读写删，`hbecho-media` 删除仍被拒（实测时在 media 桶留下的一个探针对象已用 setup 身份删除，核对为 0）。运维手册 §1.6、§17、ADR-0001 已回填。
    - **端到端 smoke**：新增 `src/worker/signals-smoke.ts`（`pnpm signals-smoke`，需 `HBECHO_SIGNALS_SMOKE=approved`、桶名必须是 `hbecho-signals`；3 个 ≤ 5 MiB 的对象、2 次匹配，用完即删，不发付费调用）。测试 ECS 上（实例角色 + 内网 endpoint + ECS 上的 Python）：同图 10.00、无关图 0.22、无残留；本机重复一次同形。MAN-5：本机用 CLI 对真实桶 `put-image` → `show` → `purge --apply`，键含计划 ID、版本、图像对象、SHA-256，清除后 0 个对象。
    - **顺带的改动**：`signals show` 增加 `--plan --version`（MAN-1 要求在 CLI 看到匹配点数与能力版本，而 `show` 原先不读参数化信号）；`test_match.py` 的响应头断言改为大小写无关（ECS 上暴露）；`.env.example`、`INDEX.md`、运维手册、ADR-0001、C PRD 版本记录已更新。
    - **本机 `./scripts/verify.sh` 全绿**：类型检查、单元 996、迁移一致、数据库测试 1429（+1 个既有 skip）、密钥、链接、登记、Python 36。更早的一次本机运行与第一次 ECS 运行撞上 `activity-plan/scale.perf.db.test.ts` 的偶发失败（与 C 无关），重跑通过。
    - **与 design 的偏差 / 取舍**：① `signals-main` 只支持 AccessKey 环境变量，实例角色凭证没有接入（ECS 上没有 AccessKey，所以 CLI 的 `put-image` 没在 ECS 上做，由 `signals-smoke` 走实例角色代替；接入属于部署形态）；② 规模演练的评分用进程内 `FakeMatcher`，不含真实 Python 的吞吐；③ MAN-1、MAN-4、ENV-6 需要一个带 C 的表和真实同步数据的库，测试 ECS 的 `hbecho` 库没有迁移 C 的表，对现有库做 DDL 需另行同意，所以没有做。
    - **推送与合并(2026-11-12)**:第二次 push 后 `c-signals` 分支 CI run 43200930507 全绿(verify + image);因 `main` 已前进 8 个提交,先在独立 worktree 里把 `c-signals` 以 `--no-ff` 合入 `origin/main`(无冲突),推到 `merge/c-signals` 分支,合并后的树 CI run 43209822790 全绿(verify + image),再把该合并提交快进推到 `main`(`5e9897b`)。刘学奎事先同意合并。
    - **后续增量(2026-11-12,分支 `fix/c-signals-request-scores-only`)**:D 的 spec 提出 `requestScores` / `executability` 需要 `only`(付费边界:第 2 层不能为第 1 层通过的全部内容顺带建 ASR / 判定任务,判定模型丢失不能连带阻塞封面比对)。核对属实:`plan` 对监控段全部结果类条目逐个处理、`executability` 整段判断。实现:`parseOnly`(空数组 `only_empty`、目录外键 `signal_unregistered`)、`RequestContext.only`、`executability(actor, k, { only })`;内部 `requestAsService` 的单个 `only` 同步成集合,重算的可执行性也只看它。纯增量,不传 only 行为不变,无迁移。测试 `only.db.test.ts` 6 例 + 两处变异检查。D 提的其余形状差异(`readMany` 的键、`score` 类型、`RequestResult.items`)不改 C,由 D 适配层处理。
    - **未证明**：匹配分标定（缺业务样本，`image.template` / `image.element` 不进生产启用集）；HEIC 封面经 ffmpeg ≥ 7.1 的匹配；回看窗口在真实同步并发下是否足够；真实 Python 上的评分吞吐；D 对读取口 / 监控段 / `retainUntil` 的消费（`d-rule-engine` 未实施）；ASR 与判定的真实模型质量与计费（`h-ai-min`）。

## 对已有代码与测试的改动

| 位置 | 改动 | 任务 |
|---|---|---|
| `src/db/schema/content.ts` | `contents` 增加一条索引 | 1 |
| `src/db/schema/index.ts` | 导出 `signals` | 1 |
| `src/acceptance-boundaries.test.ts` | 四条护栏与反向用例 | 2 |
| `tests/harness/*` | 新增 `insertFeature` 等工厂与两个 fake | 2 |
| `services/capability/**` | 新端点、依赖、测试 | 7 |
| `package.json`、`.env.example` | 脚本与变量名 | 12 |
| `HBECHO设计方案/architecture/adr/*`、`CONTEXT.md`、`domain-a-handoff-to-c.md`、`INDEX.md`、C PRD、`server-operations-runbook.md`、`services/capability/README.md` | 增补 / 订正 | 0、7、13 |

不改 `orchestrator`、`sync-runner`、`media-archive`、`demand`、`projection`、`cost-guard`、`provider-adapter`。

## 必须停下来问的条件

- 需要修改 A 域表的**列、状态或约束**（本 spec 只允许加一条索引）；
- 需要创建 `hbecho-signals` 桶、改 RAM、改安全组或动系统服务（`server-access.md`：先说明并得到同意）；
- 要把 `image.template` / `image.element` 加入**生产**启用集（需要标定报告签字）；
- 要让 C 自己直连任何模型供应商，或在 `AiGatewayPort` 之外发起付费调用；
- `h-ai-min` 或 `d-rule-engine` 的 spec 与本 spec 的端口形状冲突（先协调，不各自修改）；
- 发现 C PRD 与 A 已合并代码矛盾（例如素材状态语义）；
- 需要新增 Node 或 Python 依赖。

小的判断自己做：索引命名、错误码文案、批量大小、测试用例命名、合成图的随机种子。

## 实施记录

（任务执行时回填：日期、分支、`verify.sh` 结果、测试 ECS 运行记录、规模演练数字、与 design 的偏差。）

- **2026-11-12 · 验收补做**（刘学奎同意在测试 ECS 的 `hbecho` 库建 C 的表，并做 MAN-1 / MAN-4 / ENV-6）：
  - **测试 ECS 迁移**：`hbecho` 库从 11 条迁移补到 12 条（0011），9 张表与 `contents` 上的 `idx_contents_current_selected` 均已建；迁移前备份 `/data/backup/pre-c-signals-20261112.sql.gz`（22 KB）。做法：ACR 里没有含 0011 的镜像（CI 的 image job 在 `48c8850` 上因「应用路径没有变化」跳过构建），把 `main` 的 `drizzle/` 目录打包上传到 `/tmp/c-signals-drizzle` 并只读挂载进既有镜像跑 `src/db/migrate.ts`；`__drizzle_migrations` 现为 12 条，以后的正规部署会从同一版本继续。
  - **数据位置**：该库 `contents = 0`（上线以来没有真实同步写入），真实同步数据只在 2026-11-06 本机 smoke 的一次性库里。按 `server-access.md`「测试机不放未脱敏生产数据」，没有导入 ECS；MAN-1 / MAN-4 / ENV-6 在本机副本 `hbecho_c_verify`（391 内容 / 68 评论，迁到 0011）上做，acceptance 已注明位置偏离。
  - **MAN-4**：391 条用项目自己的 `normalizeText` / `extractHashtags` 重算，与特征行 0 差异；另抽样 12 条（每平台 4 条）人工对照全部对得上。小红书 title 自带的 `## 标题` / `## 正文` 标记与 `#茶知识[话题]#` 后缀均按规则正确处置。
  - **MAN-1**：plan 901 v1，用 content 2 的真实封面作标准图；`show --content 2 --plan 901 --version 1` 输出能力 `image.template@1`、`producedAt`、`score 10`、`evidence.raw.inliers 1502`、`inlier_ratio 1`、`low_features false`；同时算的无关图得 0.09 / 0.17。
  - **ENV-6**：真实 391 条的批次 `logical_at` → current 推进延迟最大 221 秒、平均 85 秒，0 条超过 600 秒；受控实验确认窗口内迟到由扫描补回、窗口外由 `reconcile` 兜底。多批次真并发的乱序未验证（真实 worker 在 test 环境被 `assertWorkerCanRun` 拒绝）。
  - **清理**：`segment purge --plan 901 --apply` 删除 1 个标准图对象，桶内 `segments/901/` 残留 0；本机能力服务已停止；临时脚本已删除，未进仓库。
