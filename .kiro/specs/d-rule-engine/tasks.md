# D 规则与考核（d-rule-engine）· 实施计划

> **状态**：`draft`
>
> **执行状态**：未开始。界面设计闸门已通过（2026-11-13，design §15.6）；design §14 其余项按任务边界处理。**待确认闸门未全部通过前不写迁移**；进度以下方勾选为准
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：D 规则与考核 · **目录命名**：`d-rule-engine`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-d-rule-engine.md`](../../../HBECHO设计方案/prd-domain-d-rule-engine.md) v1.2（定稿候选）
>
> **最近核对**：2026-11-16
>
> **更新日期**：2026-11-16
>
> **2026-11-16 审查修订**（刘学奎采纳）：内容要求启用规则（D-D21）；N 只依附文本 / 话题能力、删最后一张卡时清掉（D-D22）；内容 P / U / F 取 `final`，零内容 = 参与内容为 0；`like_state='value'`；`abilityId` 与 `elementKey` 的上传流程；C 已合入 `main`，D 按 C 的现状适配（design §10.3 复核表）。任务 1、3、4、5、6、7、9、13、14 已同步。
>
> **2026-11-13 模型修订**：第 1 层增加整层共享数量 N（AND 后按点赞取前 N，N 同时是 at_least_n 门槛）；第 2 层改为 `abilities[]`（整张图片对比 / 图片元素对比 + 对比元素）；图片文字对比 2.0 不启用；能力别名随版本保存但不进 `config_sha256`；试跑每档固定 5 个样例槽位。requirements / design 已同步；任务 3、5、6、7 的实现内容按此修订，新增页面任务 13–16。

## 进度

- [x] 任务 0 · 文档前置与待确认闸门（2026-11-16 完成：旧 design 归档、链接修复、CONTEXT 词条、PRD D 第 6 行；§14 闸门已答复）
- [x] 任务 1 · schema 与迁移（2026-11-16：迁移 `0012_d_judgement_schema`，`judgement-schema.db.test.ts` 19 例；**完成后推第一次**）
- [x] 任务 2 · 骨架：错误、配置、端口与 fake、B 授权接入、审计、`facts.ts`、测试挂具、静态护栏（2026-11-16 完成；`assemble.ts` 随任务 4 起逐步装配；真实 C 的契约测试在任务 12）
- [x] 任务 3 · 纯函数：配置、三值逻辑、条件求值、达标方式、窗口、分布（2026-11-16：`src/modules/judgement/{config,engine/pure/*}`，unit 84 例）
- [x] 任务 4 · 判定计划、草稿与版本（含与 C 的 provisioning、发布协议、回退）（2026-11-16：`plans.ts` / `versions.ts`，`plans.db` 14 + `versions.db` 32 例；与 C 真实 `segments` 的一致性在任务 12 的契约测试里确认）
- [ ] 任务 5 · 运行内核与圈定（**第一条可演示的纵向**）
- [ ] 任务 6 · 试跑（第 2 层）：依赖协调、等待、报告
- [ ] 任务 7 · 执行（第 1、2 层 + 账号要求）：确认执行、聚合、零内容、计划总结果
- [ ] 任务 8 · 第 3 层与评论：采集需求、ASR 判定、评论要求
- [ ] 任务 9 · 对 E 的读取口、解释、保留与清理
- [ ] 任务 10 · 下游端口与清除
- [ ] 任务 11 · CLI 全集与 `judgement serve` 装配
- [ ] 任务 12 · 全量离线验收、规模演练、测试 ECS 运行与文档收尾（**完成后推第二次**）
- [ ] 任务 13 · 页面基础、判定计划列表与详情
- [ ] 任务 14 · 三页向导页面
- [ ] 任务 15 · 执行记录、证据抽屉与 E 入口
- [ ] 任务 16 · 页面验收与视觉回归
- [ ] 页面任务：已展开为任务 13–16（界面设计 2026-11-13 已确认，design §15.6；确认版本 `ui-lab/d-rule-engine/precision/` v15）。全量视频明细视图归 E，D 不实现明细表。

## Planning rules

- 每个任务是一个纵向切片：完成后能运行一条命令、看到可验证的结果，而不是只建空表或空 interface。
- 任务边界跑 `./scripts/verify.sh`（typecheck、单元测试、迁移一致、数据库测试、密钥、链接、文档登记）。**不 push**；一个 spec 一条分支 `d-rule-engine`，只推两次：任务 1 完成后（迁移在干净库跑通，同时异地备份）与任务 12 收尾（`dev-ci-cadence`）。分支从 `main` 切出。
- 默认验收离线：不连 AI Master、不连模型、不连真实 OSS、不发起任何外网请求；MySQL 只用 `scripts/with-test-mysql.sh` 的一次性容器或 `_test` 库。D 对 C、A 的调用在测试里用 fake 端口。
- 目录按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)：领域代码在 `src/modules/judgement/`，schema 在 `src/db/schema/judgement.ts`，测试与源码同目录（纯函数 `*.test.ts`，需要 MySQL 的 `*.db.test.ts`），CLI 在 `src/worker/`，测试挂具在 `tests/harness/`，契约测试在 `tests/contracts/`。
- **迁移编号取实施时的下一个空号**（`main` 当前最大 0010；0011 是 C 在 `c-signals` 分支上的迁移，未合并——D 从 `main` 切分支会生成 0011，与 C 撞号；C 先合入则 D 重新生成，不预占）。
- 不新增未登记的依赖：无新 Node 依赖，无 Python 变更。
- 所有内部 BIGINT 在 CLI / JSON 输出为十进制字符串；外部标识保留原文；**阈值与比例一律整数运算**（整数百分位、万分比），代码里不出现对分数或比例的浮点比较。
- 数据库测试里对争抢同一行锁的操作顺序 `await`，不用 `Promise.all`；并发用例用显式闸门。
- **网络 / 跨模块调用不在事务内**（`data-discipline` 纪律 2）：对 `SignalsPort`、`DemandPort` 的调用只出现在 `engine/deps.ts` 与 `versions.ts`（护栏守）。
- D 不写 A 的表、不写 C 的表、不调 AI Master、不调模型、不提封面 / 头像 / 背景的采集需求。
- 数值类配置没有代码默认值，进配置（design §14 第 22 项）。
- 任务 0 的闸门未通过前不写迁移。
- fixture 一律脱敏、程序合成；不提交业务原图。
- 与 C 的接口以 C 的代码为准（`main`）；发现实现与 `SignalsPort` 形状不一致，先改契约测试和本 spec（design §10.3），形状上的差异（`Map<bigint>`、`score` 为 number、`RequestResult` 形状、`segment_exists`）由 D 的 `SignalsPort` 真实封装一处吸收，不在业务代码里到处适配。

## 依赖图

```text
任务 0（文档前置 + 待确认闸门）
   ↓
任务 1（schema / 迁移）
   ↓
任务 2（骨架 + facts + 授权 + 挂具 + 护栏）      任务 3（纯函数；与任务 2 并行）
   └──────────────┬─────────────────────────────────┘
                  ↓
任务 4（判定计划 / 草稿 / 版本 / 与 C 的协议）
                  ↓
任务 5（运行内核 + 圈定）── 任务 10（下游端口 + 清除；依赖 4、5）
                  ↓
任务 6（试跑）
                  ↓
任务 7（执行：L1/L2 + 账号 + 聚合）
        ├──→ 任务 8（第 3 层 + 评论）
        └──→ 任务 9（对 E 的读取口 + 解释 + 保留；证据部分依赖 8）
                  ↓
任务 11（CLI 全集 + serve）──→ 任务 12（验收 + 收尾）
任务 5/6/7/9 ───────────────→ 任务 13/14/15（页面）──→ 任务 16（页面验收）
```

容易画错的边：

- 任务 3 **不依赖**数据库，可与任务 2 同时开始；任务 4 起所有任务都用到它；
- 任务 5 的圈定已经用到 `facts.ts`（任务 2）与纯函数（任务 3）；它是第一个能端到端演示的切片；
- 任务 10 只要有运行表和计划表就能做（`summarize` 要数在途运行），不必等试跑与执行；
- 任务 9 的 `explain` 要覆盖第 3 层 / 评论证据，所以证据部分排在 8 之后，读取口骨架可先行；
- 与 C 的真实实现（已合入 `main`）的契约测试在任务 12 一并跑；SignalsPort 形状已按 C 的现状写（design §10.3 复核表），2、9、10、13 项在那里确认。

## Tasks

- [x] 0. 文档前置与待确认闸门
  - **Requirements:** 全部（§1.3 R1–R10）
  - **Design:** §10、§14
  - **已完成（2026-11-12，spec 初建时）**：旧 `.kiro/specs/rule-engine/design.md` 文首加「已被 `d-rule-engine` 取代」说明（正文未改）；`INDEX.md` 登记 `d-rule-engine` 并把旧行标为被取代。
  - **待做（闸门通过后；这些文件有的正被别的会话编辑，所以初建时没动）**：
    1. 旧 design 移到 `HBECHO设计方案/archive/rule-engine-design-2026-09-02.md`，文首写 `superseded` 头与替代文档，修正文内相对链接的层级；`scripts/check-doc-registry.py` 的 `DESIGN_ONLY_SPECS` 去掉 `rule-engine`；修复 4 处链接：`prd-domain-d-rule-engine.md` 第 7 行、`prd-domain-c-signals.md` 第 11 行、`prd-drafts-子PRD草案/hbecho-模块设计-规则引擎.md` 第 5 行、`metrics-and-dashboard/design.md` 第 37 行（INDEX 里的链接初建时已改到新目录）；
    2. `CONTEXT.md` 增加 JudgementExecution（判定执行）一条词汇（只写语义：一次冻结了名单、归属、窗口与内容快照的判定运行；不写表）；
    3. PRD D §七第 6 行改为「已闭合（`d-rule-engine`）」，PRD C §十三第 7 行同步；闸门通过后在 PRD D 版本记录写明「第 3 页确认即发布、回退只作用于草稿」的解释（决策人刘学奎），避免日后按字面再提；
    4. `metrics-and-dashboard/design.md` 文首登记「`RuleOutcomeReader / OutcomeSet` 已被 `JudgementOutcomeReader` 取代，见 d-rule-engine design §10.4」（只登记，不改正文）。
  - **待确认闸门**：design §14 标「刘学奎」的各项由刘学奎逐项答复（采纳 / 修改 / 否决），其中第 2、3、7、8、26 项会改变产品行为，第 27 项依赖 C，第 4 项涉及 A；第 25 项（页面设计确认）已于 2026-11-13 通过；第 28、29 项已于 2026-11-16 采纳；第 30 项（原型里别名提示文案）已于 2026-11-16 采纳并改原型；标「外部」的项（第 14、17、21、23、24）转交各自所有者，**不阻塞任务 1，但阻塞对应任务**（第 14 项阻塞任务 2 的 B 加法，第 21 项只剩任务 12 的契约核对）。**AI 不得把「没有反对」当作确认。**
  - 闸门通过后，若第 2、3、4 项的答复与建议不同，回写 requirements §1.4、JP-3、JP-4 与 design §7.9、§13，并在对应 PRD 版本记录写明。
  - **验证**：`./scripts/verify.sh`（链接、登记、密钥）通过；`grep` 全仓库无指向 `.kiro/specs/rule-engine/` 的 Markdown 链接（归档目录内的历史引用与修订清单里的反引号路径除外）。

- [x] 1. schema 与迁移
  - **Requirements:** JP-1、JP-3、JP-7、JP-15、JP-16、JP-17
  - **Design:** §6
  - 新增 `src/db/schema/judgement.ts`（五张表，含全部 CHECK、唯一键、生成列 `draft_key`、`active_key` 与其 CHECK、复合外键 `(activity_plan_id, platform_id)`；`run_contents` 增加 `like_value / like_state / layer1_selected / layer1_rank`，含 design §6.1 的 CHECK；`run_participants` 增加 `content_skipped`）；`src/db/schema/index.ts` 导出；`drizzle-kit generate` 生成迁移；`pnpm db:migrate` 在干净库上通过。
  - **验证**（`judgement-schema.db.test.ts`）：干净库连续迁移两次幂等；`drizzle-kit generate` 无新文件；`(activity_plan_id, alias)` 重复被拒；`platform_id` 与活动计划不一致被复合外键拒；同计划第二个草稿被 `draft_key` 拒；同（计划，版本）第二个未终态运行被 `active_key` 拒、终态后可再建；`active_key` 与状态不一致的行被 CHECK 拒；`running` 缺租约被拒；`run_participants` 同一运行同一专员两行被拒；`run_contents` 引用不存在的参与专员被复合外键拒；`run_contents.like_state` 沿用 A 的 `valueStateCheck`（`value` 才非空，`explicit_null` 等四态为空）；`layer1_selected` 非空必须 `l1='pass'`；`final='skipped'` 当且仅当 `l1='pass' ∧ layer1_selected=FALSE`；`run_contents.final` 允许 `skipped`（只由第 1 层数量截断产生）；对已被运行引用的版本 / 计划做 DELETE 被 RESTRICT 拒；层结果 / 专员结果取值 CHECK；`judgement_plans` 引用的活动计划被 A 物理删除时被 RESTRICT 拒（模拟 A 的 purge 在 D 未清除时失败）。
  - **完成后推第一次**（迁移在干净库跑通；异地备份）。

- [x] 2. 骨架、端口、授权、`facts.ts`、测试挂具与静态护栏
  - **Requirements:** JP-13、JP-18、JP-19、JP-21
  - **Design:** §4、§9、§10、§11
  - `errors.ts`（`JudgementError` 分类 + 稳定码，退出码映射）；`env.ts`（zod 校验环境变量；缺任一必填数值即失败并指出缺哪一项）；`ports.ts`（`SignalsPort`、`DemandPort`、`FactsPort` 类型）与 `fakes.ts`（`FakeSignals`：可编程返回各状态的 `SignalValue`、记录调用、可切换 `executability`；`FakeDemand`：可编程终态序列）；`authz.ts`（`createJudgementAuthz(authorizer)`：`require(ctx, capability, ref)`；`judgement_plan` 的 `ScopeStrategy`；`plan_creator` 谓词体，先查再注册；`toSignalActor`、`toDemandActor`；提交人复核：每 tick 用 B 的 `contextForUser` 重建并检查 Capability）；`audit.ts`（B 的 `AuditWriter` 适配，事件枚举与 `reasonCode`）；**B 零改动**（2026-11-16：继承提交人身份，不新增服务身份）；`facts.ts`（批量只读：`rosterOf`（经 A 的 `PlanReader`）、`assignmentsOf`、`orgChainOf`、`contentsOf`（含点赞值 / 值状态）、`snapshotsOf`、`commentsOf`、`profileOf`、`syncCompleteness`）；`assemble.ts` 的 `createJudgement(deps)` 空壳。
  - 测试挂具：`tests/harness` 补 `insertJudgementWorld`（造活动计划 + 名单 + 专员 + 账号 + 内容 + 快照 + 评论 + 同步任务的工厂）、`FakeClock` 沿用。
  - 静态护栏（`acceptance-boundaries.test.ts`，JP-21 五条）及各自的反向用例。
  - 契约测试骨架 `tests/contracts/signals-port.contract.ts`（先对 `FakeSignals` 跑；C 落地后对真实实现跑）。
  - **验证**：缺 Capability 的调用在任何读库之前被拒绝（查询计数器）；`hq_manager` 非活动计划创建者能读不能写；`branch_manager` 只读其分公司参与的活动计划下的判定计划；越范围表现为未找到；`plan_creator` 重复注册不抛（先查再注册）；`facts` 的每个读取函数一例（改绑后 `assignmentsOf` 返回新专员、`orgChainOf` 沿专员当前门店向上、`contentsOf` 排除非 active 与无当前快照并计数、`syncCompleteness` 覆盖 §7.5 的五种结局）；缺任一必填环境变量启动失败；五条护栏的反向用例使护栏报错；`toDemandActor` 缺 `data.sync.trigger` 被拒、`actorId` 等于提交人；提交人被停用 / 范围无法解析时 `contextForUser` 失败使运行被取消；`SERVICE_PRINCIPALS` 无 diff。
  - **未证明**：真实 C 的签名与 `FakeSignals` 一致（任务 12）。

- [x] 3. 纯函数
  - **Requirements:** JP-2、JP-8、JP-9、JP-6
  - **Design:** §7.1、§7.4、§7.6、§7.10
  - `config.ts`（zod schema、`validateConfig`、规范化与 `config_sha256`、`deriveItems`；别名不进哈希；第 1 层 `quantity`；第 2 层 `abilities`；`image_text`/OCR 拒绝）；`engine/pure/`：`and3`、`evaluateMethod`、`fromSignal`、条件求值（关键词、话题、时长、分数阈值、ASR 结论）、层求值（提前终止）、`contentRequirementEnabled(cfg)`、`selectLayer1`（按专员各自点赞排序取前 N；非 `value` 状态排后，真实 0 有效；平局按发布时间降序、内容 ID 升序）、`bjtDaysToUtc`、`bucketize`（分布与样例，每档最多 5 个）。
  - **验证**（纯函数，`unit`）：requirements JP-2 / JP-2a / JP-8 / JP-9 验收逐条；`contentRequirementEnabled` 的 7 种组合；`quantity` 无文本 / 话题被拒；`evaluateMethod(at_least_n)` 的 P=6、N=5 等纯函数例子（不经过截断）；`and3` 3×3 全表；`evaluateMethod` 四种方式 × T ≤ 5 的 (P,U,F) 穷举与手写参照实现逐格相等（固定种子的属性测试）；`ratio` 边界（`P·10000 = bp·T` 判成功）；关键词单调性（一个字段不可用不会把本该 pass 的变成 unobtained）；话题整体相等（`618` 不匹配 `618大促`）；时长边界 / 单位未知 / 真实 0 秒；分数 `"8.00"` 等于阈值 `"8"` 判通过；窗口换算（含 `to` 缺省、跨月、`2026-11-10` 闭区间的 UTC 上界）；分布分档（0.00 → 档 0，9.99 → 档 9，10.00 → 档 10）；`deriveItems` 与 C 目录（`FakeSignals.platformSignals`）逐项对得上；规范化哈希与键序无关；配置里没有 `regex` / 否定 / 播放量 / 发布时段 / 作者字段（`strict`）。

- [x] 4. 判定计划、草稿与版本
  - **Requirements:** JP-1、JP-2、JP-3、JP-4
  - **Design:** §5.1、§5.4、§7.1、§7.9
  - `plans.ts`（`create`、`show`、`list`、`archive / unarchive`、`reconcile`；provisioning）；`versions.ts`（`setConfig`、`putImage / removeImage`（转发 C 并按失效矩阵回退进度；元素图用 `putElement(planId, abilityId, bytes)`：SHA-256 作 `elementKey`，同 `target` 重复拒绝，换图换 key 并删旧 C 图行，`reconcile` 以 C 的 `show().images` 对账）、`rollback`（预览 / 应用）、`newDraft(planId, fromVersion?)`、`confirm` 的发布半段（`publishing → C.publish → published`，运行的创建留给任务 7，这里先用桩）、`reconcile`）。
  - **验证**（`*.db.test.ts`，`FakeSignals`、`FakeClock`）：JP-1 全部验收（`reconcile` 捕获 C 的 `segment_exists` 后核对平台；活动计划状态限制、创建者谓词、别名唯一、provisioning 恢复、重复创建不产生第二份 C 草稿、归档语义、回收站不可见）；JP-3 全部验收中与发布相关的部分（已发布不可变、ASR 判定项 + C 报不可执行 → 发布被拒且 D 与 C 均不变、`newDraft` 版本号与 C 一致 / 不一致报 `version_mismatch`、在 `publishing` 处杀进程后 `reconcile`）；JP-4 的失效矩阵（改关键词 / 改数量 N → 圈定与试跑结果被删；只改能力别名 → 不动；只改 ASR 标准 → 不动）、回退只退一层、跳层被拒、预览不写表、已发布版本回退返回 `version_immutable`；`setConfig` 之后 `setItems` 调用的 `items` 与 `deriveItems` 一致；写 C 的调用都在事务之外（护栏）。
  - **未证明**：与 C 真实 `segments` 的行为一致（任务 12）。

- [ ] 5. 运行内核与圈定（第一条纵向）
  - **Requirements:** JP-5、JP-7、JP-8（第 1 层）、JP-15
  - **Design:** §5.2、§7.2、§7.3、§7.4、§7.5
  - `engine/claim.ts`（领取、租约、fencing、`active_key`、取消、续跑、提交人复核）；`engine/runner.ts` 的 `freeze → scope → layer1（含按点赞取前 N、写 layer1_selected/rank）→ finalize` 阶段；`circle` 命令；`circle` 运行的保留与替换；CLI 骨架与 `judgement circle`。
  - **验证**（`*.db.test.ts`）：JP-5 验收逐条（圈定期间 `FakeSignals.requestScores` / `FakeDemand.submit` 调用数 0；话题 / 关键词 `all` / `any`、字段选择、时长边界与单位；带话题封面不合规 + 封面合规没带话题的两条内容在两层都配时都不进 C2——此条放在任务 7 补全，这里先证第 1 层的 AND；**数量 N：10 条满足取点赞前 6、未选中的 4 条 layer1_selected=false 且不进入第 2 层；N 不足时全部进入；点赞 missing/invalid 排在 valid 之后，真实 0 有效**）；JP-7 验收逐条（冻结后改绑 / 移出 / 换店不影响本次；改绑后取新专员及其门店的组织链；窗口 UTC 换算；两个名单账号指向同一专员 → `failed(participant_conflict)`；冻结后移动 `current_snapshot_id` 读到的仍是冻结快照）；范围构建（NULL 发布时间 → `unobtained(published_at_missing)` 计入 T；`unknown` 形态；非 active 与无当前快照不入 T 且计数可见）；JP-15 验收（两个 worker 抢同一运行、租约过期接手旧 worker 零写入、同版本并发两次开始只有一个、阶段中途杀进程后续跑且每行最多写一次、取消、提交人被停用后下一 tick 取消、终态不可再领取）；`judgement circle` 的 CLI 级测试（成功、输入错误、授权错误）。
  - **演示**：造一个活动计划（20 个专员、每人 10 条内容）→ `judgement plan create` → `config set` → `judgement circle` → 看到圈定条数与按原因的未获取分布。
  - **未证明**：真实 A 同步写入并发下的冻结一致性——测试机上用 `a-full-sync` 的 smoke 数据复核一次（任务 12）。

- [ ] 6. 试跑（第 2 层）
  - **Requirements:** JP-6、JP-13
  - **Design:** §5.3、§7.2（`scores` 阶段）、§7.8、§7.10
  - `engine/deps.ts`（分批、`requestScores` / `readMany` 轮询、两类等待上限、`dependency_timeout`）；`scores` 阶段（截断后的内容 C1 + `target=avatar|background` 的账号能力主体）；`compare` 运行（自己重做冻结、范围构建与第 1 层，不拷贝圈定运行）；`trialReport`（每档最多 5 个样例）；向导进度 `circled → compared`；`trial` / `trial-report` 命令。
  - **验证**：JP-6 验收逐条（对 C1 恰好一次 `requestScores`，且 `only` 不含第 3 层信号（acceptance F9）；换阈值再试跑不新增 C 任务；0.00 / 10.00 入档；样例每档最多 5 个；素材 `pending / failed / carried_forward` 记未获取并带 C 的原因码；试跑期间网关与 `demand.submit` 调用数 0；能力未启用时被拒并列阻塞项）；JP-13 验收（`FakeSignals` 模拟「N 次轮询后就绪」「永远 pending」「中途抛错」→ 正常完成 / `dependency_timeout` / 阶段重试后完成；杀进程后续跑不重复提交；等待上限为 0 时立即超时；事务内无跨模块调用的护栏）。
  - **未证明**：真实评分耗时（任务 12）。

- [ ] 7. 执行：第 1、2 层与账号要求
  - **Requirements:** JP-3（confirm / execute）、JP-7、JP-8、JP-9、JP-11、JP-14（证据与 `retainUntil`）、JP-15
  - **Design:** §5.4、§7.4、§7.5、§7.6、§7.7（账号）
  - `confirm`（发布半段 + 创建执行运行，同事务带幂等键）与 `execute`；`aggregate`、`finalize` 阶段；内容 `at_least_n N`（N 来自 quantity）与评论 `evaluateMethod` 落库；零内容与同步完整；计划总结果；`primary_reason`；证据写入与 `retainUntil`（按块、去重）；`cancel` / `resume` 命令；`run show / list`。
  - **验证**：JP-9 验收全部（PRD D §六「专员级判定」九条逐条成为测试，含「至少 3 条：2 通过 + 1 第 2 层缺素材 → 未获取成功」「零内容：同步完整 / 失败 / 有缺口」「总结果 AND3 与不达标优先」）；JP-11 验收（账号要求与内容要求互不影响；无主页快照 / 素材缺失 / 阈值边界；名额已释放不调 C）；JP-8 验收（表驱动：每层三态 × 下一层是否被调用；第 2 层未获取的内容不出现在后续 `requestScores` 主体里）；内容 T / U 口径（第 1 层未获取成功计 U：N=3、2 通过 + 1 条第 1 层未获取 → 未获取成功；参与内容 10 条都没命中话题 → 不达标，不走零内容；参与内容 0 条才走零内容；`skipped` 不计 P / U / F）；内容要求未启用的计划（只配评论 / 只配头像）内容结果为 NULL 且不拖累总结果；JP-3（草稿 `confirm` 后再 `execute` 两次 → 一个已发布版本、三次执行；`new-draft` 改阈值 `confirm` 版本 +1；同幂等键重复 `confirm` 只一个运行）；JP-14（证据自包含：删除 `FakeSignals` 的结果后 `explain` 数据仍完整；`retainUntil` 主体恰为读取到的 `resultId` 去重；证据 JSON 无原文字段的 schema 断言）；JP-15（取消后不再提交新依赖）；执行可复现：同一冻结输入跑两次，`run_participants` 与 `run_contents` 逐行相同。
  - **演示**：`judgement confirm … --apply` → `judgement serve --once` → `judgement result summary` 看到成功 / 不达标 / 未获取成功人数与主要原因。

- [ ] 8. 第 3 层与评论
  - **Requirements:** JP-10、JP-12
  - **Design:** §7.2（`demand / layer3 / comments` 阶段）、§7.7、§7.8
  - `DemandPort` 的真实封装（提交人身份译成的 A 侧 `ActorContext`，`actorId` = 提交人，见 design §9）；`demand` 阶段（分批、键 `exec:{id}:l3:{n}` / `exec:{id}:cm:{n}`、`requester` / `ruleDecisionId` / `ruleVersion`）；`layer3` 阶段（`requestScores(asr_judgement)`、求值、四要素证据）；`comments` 阶段（读 A 的一级评论、`readMany(comment.text_normalized)`、`cm_*`、覆盖缺口）；评论零候选规则；`content_not_found / unsupported_platform / capability_disabled / out_of_scope` 的处置。
  - **验证**：JP-12 验收逐条（默认装配下含第 3 层的计划发布被拒且 `demand.submit` / `requestScores` 调用数 0；不含第 3 层的计划照常；中途 `capability_disabled` 剩余内容记原因且不发调用；`not_meets` → 不通过、`failed(invalid_output)` → 未获取；证据四要素；音频需求主体只含 C2）；JP-10 验收逐条（评论 `demand` 主体只含 C2；覆盖 `complete / partial / unknown` 的缺口；「至少 3 条评论含关键词」三种情形；快手配置期被拒、运行时 `unsupported_platform`；评论零候选三种分支；证据里只有 ID 与计数）；`demand` 幂等：杀进程后续跑不重复提交（批次 ID 与 `demandKey` 断言）；`out_of_scope` 不会出现（服务身份全范围）的断言。
  - **未证明**：真实采集与真实模型（`h-ai-min` 与任务 12 的 `[环境]` 项）。

- [ ] 9. 对 E 的读取口、解释、保留与清理
  - **Requirements:** JP-14、JP-16
  - **Design:** §7.11、§7.13
  - `outcomes.ts`：`listCompleted`（游标为 (completed_at, run_id)，acceptance P9）`/ describe / streamParticipants / streamContents / streamCircleRows`（游标分页、冻结组织链 + `ResourceConstraint` 过滤；圈定行带 `layer1_selected / layer1_rank`）；`explain`；`maintain`（圈定 / 试跑期满、内容级行按 `KEEP_CONTENT_RUNS` 修剪、失败运行清理，分块、幂等）；`result *` 命令。
  - **验证**：JP-16 验收逐条（未完成 / 取消 / 失败的执行不可见；成功 + 不达标 + 未获取 = 参与专员数；组织链取冻结值、改绑 / 换店后不变；`empty / branches / self` 三种约束的过滤；`streamCircleRows` 的行数（含 `skipped` 行）；`ContentFact` 带 `final='skipped'`、`layer1_selected`、`layer1_rank`、点赞值与状态；`ExecutionDescriptor` 带能力的 `abilityId / 别名`；fake E 消费者走完整序列）；JP-14（`explain` 逐层逐条件、越范围表现为未找到）；`maintain`：用 `FakeClock` 推进，期满的圈定 / 试跑运行被删，修剪后 `streamContents` 返回 `content_rows_pruned`，参与专员级数据保留；清理幂等、可重复、中途退出可续。
  - **未证明**：E 的真实消费者（`e-metrics` 的 spec 对齐后）。

- [ ] 10. 下游端口与清除
  - **Requirements:** JP-17
  - **Design:** §7.12、§10.2
  - `downstream.ts`（`summarize / onDeleted / onRestored / purge`）；`plan-main.ts` 装配（与 E 的下游以组合下游注入，E 尚无则只有 D）；`purge` 的 C 调用与分块删除。
  - **验证**：JP-17 验收逐条（`summarize` 的在途数随运行状态变化；`purge` 删除全部 D 行与 C 监控段、第二次无副作用、中途失败后重试完成；`onDeleted / onRestored` 重复调用无副作用；活动计划在回收站时读取与 `listCompleted` 不返回其结果，恢复后返回）；调用时机契约测试（记录顺序的 fake 对照 A 的 `plans.remove` 与 `maintenance`）；用 A 的真实 `plans.remove` / `maintenance` + D 的真实 `downstream`（`FakeSignals`）端到端走一遍「有在途 → 删除被拒 → 取消 → 删除 → 期满清除」。

- [ ] 11. CLI 全集与 `judgement serve` 装配
  - **Requirements:** JP-20、JP-19
  - **Design:** §9
  - `judgement-cli.ts` 补齐 design §9 的全部命令；`judgement-main.ts` 装配（pino 日志、连接池、环境变量身份、`serve` 的领取循环与每日 `maintain`）；`package.json` 脚本；`.env.example`。
  - **验证**：每条命令一个 CLI 级测试（成功、输入错误、授权错误）；缺身份环境变量启动失败且退出码非零；`rollback` / `cancel` 不带 `--apply` 不改任何表；退出码映射表；`serve` 在 SIGTERM 时释放租约后退出；缺必填数值配置时 `serve` 与 CLI 启动失败并指出缺哪项。

- [ ] 12. 全量离线验收、规模演练、测试 ECS 运行与文档收尾
  - **Requirements:** 全部
  - **Design:** §11、§12.1
  - 跑通 acceptance 全部 `[自动]` 项；规模演练（2,000 名单账号 × 平均 20 条内容 = 40,000 行：各阶段耗时、峰值内存、`run_contents` 行大小与表大小），回填 design §12.1；测试 ECS 上按 `server-access.md` 第 5 条运行全量测试（只连一次性 `_test` 库容器）；对 C 的真实实现跑 `tests/contracts/signals-port.contract.ts`（C 未合并则明确写「未验证」）；回填 acceptance 的「逐条结果」；INDEX 状态、tasks 实施记录、design §14 的采纳记录；`dev-ci-cadence`：CI 绿后合并。
  - **验证**：`./scripts/verify.sh` 通过，写明测试数；Python 侧不涉及；规模演练数字进入 design §12.1。
  - **完成后推第二次**。

- [ ] 13. 页面基础、判定计划列表与详情
  - **Requirements:** JP-1、JP-2、JP-3、JP-4
  - **Design:** §15.1、§15.4、§15.5
  - 在 `src/app/` 建判定计划路由与页面：列表（筛选 / 新建入口 / 状态 / 最近执行）、新建弹窗、详情（基本信息 / 版本 / 执行记录入口）；只经 Module 的查询服务取数，不直接查 A/C 表；按 B 的 DataScope 裁剪；沿用已确认的精密版视觉变量与组件，不重建一套样式。
  - **验证**：角色可见性（门店无入口、分公司只读、总部/超管可写）；加载 / 空 / 错误 / 无权限；新建、归档、查看详情；列表筛选与分页；页面不出现内部字段名 / 表名 / 内部 ID。

- [ ] 14. 三页向导页面
  - **Requirements:** JP-2、JP-2a、JP-3、JP-4、JP-5、JP-6
  - **Design:** §15.1、§15.2、§15.4、§15.5、§7.9
  - 第 1 页：日期范围、内容形态、能力卡片、整层数量 N、圈定结果；第 2 页：`abilities[]`（1.0 只有整张图片对比 / 图片元素对比）、对比元素、上传、可拖动阈值、试跑分布与固定 5 个样例槽位；第 3 页：ASR / 评论能力、确认执行；确认 / 回退在右上角与底部；改配置按失效矩阵提示并回退进度；图片文字对比不出现或置灰说明 2.0。
  - **验证**：新建空计划 → 第 1 页添加能力 / 设置 N → 圈定 → 第 2 页选对比元素 / 上传 / 试跑 → 第 3 页确认执行的完整流程；阈值拖动与直接输入同步；数量 N 改动触发重新圈定；删掉最后一张文本 / 话题卡片时 N 被一并清掉且不弹提示，没有文本 / 话题卡片时不显示 N；图片文字对比在 1.0 不可添加 / 不可执行；5 个样例槽位固定、少时从第一个槽位起。

- [ ] 15. 执行记录、证据抽屉与 E 入口
  - **Requirements:** JP-7、JP-9、JP-11、JP-14、JP-15、JP-16
  - **Design:** §15.1、§15.4、§15.5
  - 执行记录列表与详情、参与专员结果、证据抽屉、取消 / 重新执行 / 新建草稿；跳转 E 的点检表；**不做全量视频明细表**（E 域实现，D 本版不加入口）。
  - **验证**：成功 / 不达标 / 未获取成功、等待采集 / 等待识别、失败 / 取消、只读角色；证据不含正文 / 评论原文；E 入口是占位，不出现 500。

- [ ] 16. 页面验收与视觉回归
  - **Requirements:** 全部页面相关验收
  - **Design:** §15.6
  - 以 `ui-lab/d-rule-engine/precision/`（v15）为视觉基线，补页面级验收与截图；确认超出范围要重新确认。
  - **验证**：关键页面 1440×900 与 390×844 截图；无横向溢出；权限、空 / 错误 / 加载状态；页面只读 Module 服务，静态护栏通过。

## 必须停下来问的条件

出现以下任一情况，停止实现并说明，不要自行选一边：

1. design §14 的答复与建议不同（尤其第 2、3、4、7、8 项）；
2. C 的真实接口与 `SignalsPort` 或 design §10.3 的对齐请求冲突，且 C 一侧不愿意改；
3. 需要修改 A 的表或 A 的模块（含给名单加锁端口）；
4. 需要修改 B 的授权逻辑或 A 的 `ActorContext`（D 的 `toDemandActor` 窄适配已登记为 design §14 第 31 项）；
5. 需要引入新依赖；
6. 需要发起任何真实的付费或外网调用；
7. 在已确认的界面范围（design §15.6，2026-11-13）之外写页面任务或页面代码；超出范围先重新确认；
8. 发现 PRD D 与 PRD E / C / A 之间的新冲突（先登记再问）；
9. 需要创建桶、改 RAM、动系统服务、改安全组（`server-access.md`）。

## 实施记录

（实施时按任务回填：本机 `verify.sh` 的测试数、测试 ECS 的通过数与耗时、与计划不同的地方、没有做的事。）
