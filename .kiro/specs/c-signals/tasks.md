# C 识别能力（c-signals）· 实施计划

> **状态**：`draft`
>
> **执行状态**：任务 0 已完成（闸门 2026-11-12 通过：刘学奎确认 design §14 的 13 项）；任务 1 是否开始由刘学奎决定。进度以下方勾选为准
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
- [ ] 任务 2 · 骨架：目录、错误、配置、授权审计、A 事实读取口、测试挂具、静态护栏
- [ ] 任务 3 · 文本纯函数：归一化、话题解析、平台字段表
- [ ] 任务 4 · 特征行写入与扫描驱动（内容与评论）、历史表、对账
- [ ] 任务 5 · 读取口 `SignalReader` 与五态合成；CLI `show` / `catalog`（**第一条可演示的纵向**）
- [ ] 任务 6 · 监控段与标准图（含 OSS 专用桶、可执行性、清除）
- [ ] 任务 7 · Python 匹配端点、Node 客户端、真实样本标定
- [ ] 任务 8 · 任务表与租约、`requestScores`、评分 runner、结果行、派生信号读取
- [ ] 任务 9 · 音频理解：`AiGatewayPort`、ASR 与判定 runner、提示词
- [ ] 任务 10 · 能力升级、`stale` 与显式重算
- [ ] 任务 11 · 保留期、`retainUntil` 与清理器
- [ ] 任务 12 · CLI 全集与 `signals run` 装配
- [ ] 任务 13 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾（**完成后推第二次**）
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

- [ ] 2. 骨架、事实读取口、测试挂具与静态护栏
  - **Requirements:** SG-1、SG-14、SG-15、SG-16
  - **Design:** §4、§9、§10、§11
  - `catalog.ts`（12 个信号，能力标识与版本，平台可得性，`platformSignals`，启用判断）；`errors.ts`（`SignalError` 分类）；`config.ts`（zod 校验环境变量，缺必填数值即失败）；`authz.ts`（`SignalActor`、`assert`、`actorFromEnv`）；`audit.ts`（`AuditSink` 端口与日志实现）；`facts.ts`（批量只读：`contentFacts`、`commentFacts`、`coverMaterial`、`profileMaterial`、`audioMaterial`、`mediaObjectOf`、`scopeSubjects`，含素材状态映射）；`assemble.ts` 的 `createSignals(deps)` 空壳。
  - 测试挂具：`tests/harness` 补 `insertFeature`、`insertSegment`、`FakeAiGateway`（计费计数器、`callKey` 去重、可切换 `activeModel`）、`FakeMatcher`（可编程返回分数 / 错误）；沿用 `FakeObjectStore`、`FakeClock`。
  - 静态护栏（`acceptance-boundaries.test.ts`，SG-16 四条）及各自的反向用例。
  - **验证**：目录键集合与 requirements SG-1 逐项相等；`platformSignals('kuaishou')` 不含 `account.*` 与 `comment.*`；`facts` 的素材状态映射六种输入各一例（SG-2 验收第一条的输入侧）；缺 `HBECHO_SIG_*` 任一项 `actorFromEnv` 失败；缺 Capability 的调用在读库之前被拒绝（查询计数器）；四条护栏的反向用例使护栏报错。

- [ ] 3. 文本纯函数
  - **Requirements:** SG-3
  - **Design:** §7.1、§7.2
  - `normalizeText`（= `normalizeKeyword`，按版本保留实现：`NORMALIZERS`）；三个平台变体的话题解析；`PLATFORM_TEXT_FIELDS`；用 `tests/fixtures/aimaster` 里的真实样本核对每个平台的列表 / 详情是否返回标题与正文字段，把结论写回 design §7.2 与 §14 第 6 项。
  - **验证**（纯函数，`unit`）：design §7.2 样本表逐行；`＃６１８`、`#618 `、`#618[话题]#` 同值；`ＨＩＴＡＣＨＩ　空调` → `hitachi 空调`；零宽字符与控制字符被删、emoji 保留；三种连写方式；超长令牌与空令牌被丢弃；上限 50；解析器抛错时调用方拿到结构化失败（含片段哈希前缀与长度，不含原文）；`normalizeText` 幂等（`f(f(x)) === f(x)`，属性测试用固定种子）；每个已存储的 `nv` 都在 `NORMALIZERS` 里；`normalizeKeyword(raw, 旧版本)` 与旧版本写入的文本同口径。
  - **未证明**：真实平台上线后新出现的话题写法；发现后升版本。

- [ ] 4. 特征行写入与扫描驱动
  - **Requirements:** SG-3、SG-4、SG-5
  - **Design:** §5.1、§7.3、§7.4、§7.5
  - `ingestContent` / `ingestComment`（`mode='normal'|'recompute'`；锁特征行、`isNewer` 排序检查、素材指纹比较、历史写入，`recompute` 跳过素材未变的短路且历史原因记 `capability_upgraded`）；`runScan`（`content_scan`、`comment_scan` 两个游标，回看窗口「迟到」查询）；`runReconcile`（`content_reconcile` 分页）；`signal_history` 写入（含 `normalizer_version`）与 `expires_at`。
  - **验证**（`*.db.test.ts`，`FakeClock`）：新内容 → 特征行三信号 `valid`；评论正文 `NULL` 与空串指纹不同但都读 `valid` 空值；同一快照重复处理 → 无写入；新批次、素材未变 → 只前移所持快照；标题变化 → 特征行更新且历史新增一行（`material_changed`，`normalizer_version` 为写入时的 `nv`）；素材未变的 `stale` 信号在 `mode='recompute'` 下仍重算（批次相同也不被 `skipped_older` 挡住；历史 `capability_upgraded`，`nv` 更新）；批次 5 之后迟到批次 3 → `skipped_older`，特征行不变；注入话题解析异常 → `hashtags` 为 `failed`，标题与正文照常；回看窗口：构造「游标已越过、但提交更晚」的内容，下一 tick 的迟到查询补上；窗口外的由对账补上；扫描中途杀进程后重做，特征行恰好一行；`suspected_deleted` 评论不被新抽取；C 的表不含评论作者列；`content_features` 值与信封的三态一致。
  - **未证明**：真实 A 同步写入并发下的回看窗口是否足够——测试机上用 `a-full-sync` 的 smoke 数据复核一次（任务 13）。

- [ ] 5. 读取口与五态合成（第一条纵向）
  - **Requirements:** SG-2、SG-12
  - **Design:** §7.6
  - `composeState` 纯函数与 `SignalReader.read` / `readMany`（先实现特征行类信号；结果行类的取数留桩，任务 8 补齐）；`stalePolicy`；`pending` 字段；文本类信号的 `nv` / `stale` 分支；CLI `signals catalog` / `signals show --content|--comment`。
  - **验证**：`composeState` 表驱动覆盖 design §7.6 每个分支，含「平台不支持」「平台无该字段」「最高版本的 failed 读作 missing」「只升 text.normalize、话题解析器版本不变时话题读作 stale 且 normalizerVersion 为旧值」；`readMany` 对 5,000 内容的查询次数为常数（计数器）；`read` / `readMany` 不使任务表行数变化；`stalePolicy: 'as_unknown'` 时 `usable` 为 false 且不带值；目录外信号 `signal_unregistered`；**演示**：造一个内容 → 推进 current 指针 → 跑一轮扫描 → `signals show --content` 看到话题与归一化标题，版本与时间齐全。
  - **未证明**：派生信号（匹配分、ASR）的读取，任务 8、9 补齐。

- [ ] 6. 监控段与标准图
  - **Requirements:** SG-7
  - **Design:** §5.2、§7.9
  - `segments.create` / `putImage` / `removeImage` / `setItems` / `publish` / `newDraft` / `show` / `executability` / `purge`；OSS 键规则；`signalsStore`（独立于 media 的 `MediaObjectStore` 实例，桶名来自 `OSS_BUCKET_SIGNALS`）；上传校验用 `sniffImage` + `ImageConverter`。
  - **验证**（`FakeObjectStore` 故障注入）：同对象第二张模板图替换前一张且旧对象被删；元素图按 `element_key` 多张；`published` 上任何写入 `segment_immutable`；两个判定项 / 快手含 `account.bg_*` / 目录外信号被拒；超 10 MiB 与无法解码被拒且无残留；`put` 失败不留行；事务失败后对象被清理；旧对象删除失败不影响提交；关闭某能力启用开关后 `executability` 列出阻塞项而数据不变；`newDraft` 复制出的对象键与原版本不同、字节相同；`purge` 失败可重试、幂等、会清掉孤儿对象。
  - **未证明**：真实 `hbecho-signals` 桶与 RAM（任务 13 的 `[环境]` 项，需先征得同意创建）。

- [ ] 7. Python 匹配端点、Node 客户端与标定
  - **Requirements:** SG-8
  - **Design:** §7.8
  - `services/capability/capability/match.py` 与端点；`pyproject.toml` 增加 `opencv-python-headless`；`services/capability/README.md` 端点表增加 `/v1/image/match`；pytest 用程序合成的纹理图；`src/modules/signals/scoring/matcher-client.ts`（`HttpImageMatcher`，沿用 `HttpCapabilityClient` 的错误分类思路）；**标定**：业务提供的约 20 对脱敏样本在测试机上跑，产出标定报告（样本清单、分数分布、选定的 `R_FULL` / `I_FULL`、每个整数档配一张样例图的位置），刘学奎签字。
  - **验证**：pytest——同图 ≥ 9.5，缩放 + 轻度旋转 + 亮度变化 ≥ 7，无关图 < 2，嵌入场景的元素裁剪块 ≥ 6，不含该元素 < 2，低特征图 `low_features` 且 0 分；错误体 `side` 字段；`unit`（fake `fetch`）——每个错误码的归类、版本不一致、超时；`verify.sh` 的 Python 步骤（环境满足时）。
  - **未证明 / 门槛**：`image.*` **不进生产启用集**，直到标定报告签字（design §14 第 7 项）。本机无 ffmpeg ≥ 7.1 时 Python 步骤会明确打印「未验证」，不声称通过。

- [ ] 8. 任务表、`requestScores` 与评分
  - **Requirements:** SG-6、SG-8、SG-12、SG-13
  - **Design:** §5.3、§7.7、§7.8、§7.5
  - `tasks/`（入队幂等——含「任务 `succeeded` 但结果行已被清理」时置回 `pending`、`SELECT … FOR UPDATE SKIP LOCKED` 领取、心跳、fenced 写入、重试与退避、`dead`、revive；`revive` 拒绝 `run_cancelled` 任务）；`requestScores`；评分 runner；结果行写入；`SignalReader` 补齐结果行类（含 `pending` 提示）；`needMedia`。
  - `requestScores` 同时处理 `content.asr_text`（`activeModel('asr')` 为空时读作 `capability_disabled`，任务数 0）。
  - **验证**：requirements SG-8 验收第一条（100 主体：80 建任务 / 20 按映射返回，`carried_forward` 无任务）；二次请求与任务完成后再请求都不新增任务；换标准图后对同批主体新建任务；两个 worker 抢同一任务只有一个拿到，租约过期后接手，旧 worker 写入被拒绝且零写入；任务在调用返回后、事务提交前崩溃（fake 注入），重启后结果行恰好一行；版本不一致 → 瞬时失败不写结果；重试用尽 `dead` 且无结果行，`requestScores` 把它置回 `pending`；`succeeded` 但结果行已被清理时再次 `requestScores` 置回 `pending`；`dead(run_cancelled)` 的 chunk 任务 `revive` 被拒；候选图解码失败写 `failed(image_unreadable)`，标准图侧失败任务 `dead`；runner 调用能力服务期间连接池无未提交事务；同一标准图字节被两个段引用，同封面只算一次。
  - **未证明**：真实 Python 服务上的吞吐（任务 13）。

- [ ] 9. 音频理解
  - **Requirements:** SG-9
  - **Design:** §5.4、§7.5、§13（SG-D09、SG-D18）
  - `AiGatewayPort` 与 `DisabledAiGateway`；ASR runner；判定 runner（含 `deferred`）；提示词模板 `asr-judge`（版本 1）与输出 zod；`requestScores` 对音频类的规划；`SignalReader` 补齐。
  - **验证**：默认装配下请求 → 任务数 0、网关调用数 0、读作 `missing` / `capability_disabled`；fake 网关：同音频两次请求 ASR 只调一次；不同标准文本互不复用，相同标准 + 提示词版本 + 模型版本复用；模型版本 `m1 → m2` 产生新行、旧行保留；同一 `callKey` 只计费一次，崩溃重试用同一 `callKey` 结果行仍一行；输出缺 `reason` 或 `verdict` 非法 → `failed(invalid_output)`，不是 `not_meets`；网关瞬时错误重试、用尽 `dead`；ASR 缺失时判定 `deferred` 不计重试，20 次后 `dead(dependency_timeout)`；音频未归档 `missing(audio_not_archived)` 且无任务；判定行含结论、理由、模型与提示词版本；每段至多一个判定项（任务 6 已守，这里再断言一次执行路径）。
  - **未证明**：真实模型质量与计费（属于 `h-ai-min` 的 smoke）。

- [ ] 10. 能力升级、`stale` 与显式重算
  - **Requirements:** SG-10、SG-11
  - **Design:** §7.10
  - `ScopeResolver`；`recompute.preview` / `apply` / `cancel`；`recompute_chunk` runner（每块前后检查 run 状态）；`signal_recompute_runs`；审计事件（含 `recompute.cancel`）。
  - run 语义：`active_key` 唯一；同范围 `running` / `failed` 续跑原 run，`completed` 后再 `apply` 新建 run 且跳过已是目标版本的对象；`cancel` 只对 `running` / `failed` 有效，置 `cancelled`、清 `active_key`，未开始的 chunk 置 `dead(run_cancelled)`，已领取的 chunk 在分块边界停止；`tasks revive` 拒绝复活。
  - **验证**：requirements SG-10、SG-11 验收逐条——升版本后读作 `stale` 且无新任务、无新计划版本；`stalePolicy` 两种；无范围 `scope_required`；预览与执行条数一致且预览不写表；无 `rule.definition.manage` 被拒；品牌范围外的对象不在展开结果；重算后范围内 `valid`、范围外仍 `stale`；重算中途杀进程后续跑，历史表无重复；重算记录（含 `from_version` / `to_version` / `scope_count`）与审计事件各一条；failed run 可重启续跑（在 `cursor_id` 处复活/新建 chunk）；迟到 chunk 在非 `running` 的 run 上置 `dead(run_not_running)`；completed 后范围内新进入的对象再次 `apply` 能被补上且旧对象不重复；`from_version` 无旧值时为 NULL；素材未变、批次相同的 `stale` 文本信号重算后读作 `valid` 且 `normalizerVersion` 更新，历史原因 `capability_upgraded`；`comment.text_normalized` 按内容范围重算；`cancel` 后未执行的 chunk 不再运行、不产生新的历史/结果行，`revive` 拒绝，同范围可新建 run；对 `completed` / 已 `cancelled` 的 run 调用 cancel 被拒；重算不改监控段版本；`brandId` 范围经当前归属展开（造一个换店的账号验证用的是当前归属）。

- [ ] 11. 保留期与清理
  - **Requirements:** SG-10
  - **Design:** §7.11
  - 写入时的 `expires_at`；`retainUntil`；清理器（结果行、历史行、过期任务）；每日调度点。
  - **验证**（`FakeClock`）：推进 13 个月，未引用成功结果被清理；推进 4 个月，失败行被清理；`retainUntil` 延后后到原时间点仍在、传较早时间不缩短；清理后读取 `missing` 且任务表无新行；特征行不被清理；分块删除中途退出可重跑；`retainUntil` 的契约测试（fake D 的调用序列）。

- [ ] 12. CLI 全集与常驻装配
  - **Requirements:** SG-14、SG-15
  - **Design:** §9
  - `signals-cli.ts`（全部子命令）、`signals-main.ts`（装配真实依赖：池、日志、两个 OSS 实例、能力服务地址、网关选择 = 默认 `DisabledAiGateway`）、`package.json` 脚本、`.env.example` 变量名；`signals run` 的循环（扫描 tick、任务领取、每小时对账、每日清理、优雅退出）。
  - **验证**：CLI 单元 / db 测试（假依赖）——每个子命令的成功与拒绝路径、退出码、JSON 输出无原文（含 `recompute cancel` 的 `run_not_cancellable`）；缺身份环境变量启动失败；启用集里写目录外能力标识启动失败；缺必填数值配置启动失败并指出缺哪项；`signals run` 在 fake 依赖下跑完一个「入库 → 扫描 → 读到」循环并响应停止信号。
  - **未证明**：compose 服务与资源上限（本 spec 不交付部署形态）。

- [ ] 13. 全量离线验收、规模演练、测试 ECS 运行与文档收尾
  - **Requirements:** 全部
  - **Design:** §11、§12.1
  - 逐条完成 [`acceptance.md`](acceptance.md) 的 `[自动]` 项并回填结果；规模演练：20 万内容的扫描吞吐、`readMany` 5,000 主体耗时与查询次数、1 万个评分任务（fake 匹配器）的领取吞吐，数字回填 design §12.1；在测试 ECS 上（按 `server-access.md` 第 5 条的条件）跑一次全量 `verify.sh` 与一次真实 Python 匹配 smoke（无付费调用），记录通过数与耗时。smoke 分两档：**Python 自带的本地文件档**（pytest 读本地合成图，不依赖桶）必做；**Node → 签名 URL → Python 的端到端档**需要先创建 `hbecho-signals` 桶（ENV-1），桶未创建时只做前一档并如实记录；`INDEX.md` 更新状态；`server-operations-runbook.md` 桶清单回填实际状态；C PRD 版本记录补一行实现状态。
  - **验证**：`./scripts/verify.sh` 通过；Python 侧未验证时明确写出；acceptance 逐项勾选并写明尚未证明的部分。
  - **完成后推第二次**；CI 绿后按 `dev-ci-cadence` 合并（`--no-ff`）。

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
