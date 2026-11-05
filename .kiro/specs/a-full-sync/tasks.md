# A 全量周期同步（a-full-sync）· 实施计划

> **状态**：`draft`
>
> **执行状态**：任务 0、1 已完成（2026-11-05）。任务 0：文档前置、编码命名确认、`a-master-data-import` 已合并 `main`（`fd1dd7d`）、本分支已变基。任务 1：迁移 `0004`、证据登记、本机 `./scripts/verify.sh` 全绿（312 单元 / 330 数据库测试）。任务 2：Adapter 扩展完成。任务 3：监控目标集、批次生命周期、调度、补抓、取消完成。任务 4：worker 运行时完成（Runner 注册表为空，worker 暂不领取任何任务）。下一步任务 5。
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：A 数据底座 · **目录命名**：`a-full-sync`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-a-data-foundation.md`](../../../HBECHO设计方案/prd-domain-a-data-foundation.md) v1.11（2026-11-05，定稿候选）
>
> **最近核对**：2026-11-05
>
> **更新日期**：2026-11-05（初建；同日闸门通过；外部审查后修订（requirements §1.8）；吸收旧系统经验：队尾重试、provider 熔断、身份与残缺校验、自比对、默认预览、抽样对账）

## 进度

- [x] 任务 0 · 文档前置（v2 修订、A PRD §7.1 放宽、CONTEXT、ADR-0012 补记、INDEX、分支与编码命名确认）
- [x] 任务 1 · schema 与迁移、证据登记
- [x] 任务 2 · Adapter 扩展（快手、详情、评论）
- [x] 任务 3 · 监控目标、批次生命周期与调度
- [x] 任务 4 · Worker 运行时（领取、并发、速率、恢复、预算）
- [x] 任务 5 · 账号采集（主页、多页列表、检查点、封口）
- [x] 任务 6 · 按需采集（需求、详情、评论）
- [ ] 任务 7 · 媒资（封面首次、快手、视频、音频）
- [ ] 任务 8 · Python 能力服务 HTTP 外壳与 Node 客户端
- [ ] 任务 9 · 运营命令、查询与定时清理
- [ ] 任务 10 · 全量离线验收、故障注入与规模演练
- [ ] 任务 11 · 批准式 smoke（人工批准，付费）

## Planning rules

- 每个任务是一个纵向切片：完成后能运行一条命令、看到可验证的结果，而不是只建空表或空 Interface。
- 任务边界跑 `./scripts/verify.sh`（类型检查、单元、迁移一致、数据库测试、密钥、文档链接与登记、Python 侧）。**不要在 verify 全绿之前说「测试通过」。**
- 默认验收离线：不连 AI Master、不连 OSS、不连真实媒资源站、不起真实 Python 服务；MySQL 只用 `scripts/with-test-mysql.sh` 的一次性容器或 `_test` 库。任务 11 是唯一的付费任务。
- 目录按 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md) 与现有布局：领域代码在 `src/modules/<模块>/`，测试与源码同目录（纯函数 `*.test.ts` → `unit`，需要 MySQL 的 `*.db.test.ts` → `db`），迁移在 `drizzle/`，CLI 在 `src/worker/`，fixture 在 `tests/fixtures/`，设施复用 `tests/harness/`，Python 在 `services/capability/`。
- **没有新的 Node 依赖**。Python 侧只加 FastAPI（ADR-0012 已批准）与 uvicorn（任务 0 先在 ADR-0012 登记）。任何其他新依赖先走 ADR。
- 所有内部 BIGINT 在 CLI / JSON 输出为十进制字符串；外部 ID 保留原文；时间保存 UTC `DATETIME(6)`。
- 任务 0 的闸门未通过之前不写迁移；v2 修订未落回正文之前不写 SQL。
- 网络 IO 期间不持有数据库事务；供应商响应先落 ODS 再解码；current 只接受 finalized（data-discipline）。
- 并发测试用两个独立连接顺序触发，不用 `Promise.all` 抢同一行锁（dev-ci-cadence 第 3 条）。
- 推送节奏（dev-ci-cadence 第 5 条）：一个 spec 推两次——任务 1 做完后推一次（迁移在干净库上跑通 + 异地备份），任务 10 收尾推一次；中间不推。

## 依赖图

```text
任务 0（文档 + 闸门 + 分支）
   ↓
任务 1（迁移 + 证据）──────────────────────────┐
   ↓                                          │
任务 2（Adapter）          任务 8（Python 外壳）│  （8 可与 2–6 并行，只依赖 0）
   ↓                                          │
任务 3（目标 + 批次 + 调度）                   │
   ↓                                          │
任务 4（Worker 运行时）                        │
   ↓                                          │
任务 5（账号采集）                             │
   ├──→ 任务 6（按需采集）                     │
   └──→ 任务 7（媒资）←───────────────────────┘
            ↓
任务 9（运营命令 + 查询 + 清理）← 任务 6
            ↓
任务 10（全量离线验收 + 规模）
            ↓
任务 11（批准式 smoke，人工）
```

## 任务 0 · 文档前置：v2 修订、CONTEXT、ADR-0012 补记、INDEX、待确认闸门、分支

**目标**：让后面的代码有合法的基线，不让实现偷偷定义列、依赖或口径。

**动作**

- **分支**：当前本地分支 `a-full-sync` 是从未合并的 `a-master-data-import` 分出来的（文档已提交，未推送）。开工前先把 `a-master-data-import` 合并 `main`（它的任务 0–8 已实现、CI 绿），再把 `a-full-sync` 变基到 `main`；代码不写在 `a-master-data-import` 上。
- 在 [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) 落回 requirements §1.3 的 R1–R8：
  - R1：`content_snapshots.seeded_from_snapshot_id` 及 §10.2 增补第 12 条；
  - R2：§10.2 第 6、7 条**与 §12.3 第 6 条**改为账号级封口；
  - R3：§11.3 封面范围与 A §10.1 对齐；
  - R4：`sync_batches.purpose`；
  - R5：`sync_batches.finished_at` 语义与 `media_finished_at`；
  - R6：`kuaishou.user_id`（同步 §6.3 命名空间枚举与 CONTEXT）；
  - R7：§8.3 / §12.3 外部型只采主页；
  - R8：§12.3 第 2 条补 `queued` / `skipped` / `expired`，与 §9.2 一致；§9.2 的 `skipped` 放宽为「没有执行任何任务的批次」；
  - header 修订项 + 版本记录补一行。
- [`CONTEXT.md`](../../../CONTEXT.md)：登记「采集需求（CollectionDemand）」「同步轮次」两个词汇，只写语义，不写表名；`ExternalAccountIdentifier` 一节补快手命名空间。
- [`ADR-0012`](../../../HBECHO设计方案/architecture/adr/0012-python-capability-service.md)：补记两件事——① A 域音频抽取先按「Node 传短期签名 URL」实现（Python 不持有 OSS 凭证），`c-signals` 沿用或修订；② 登记 uvicorn（FastAPI 运行服务器）的采用记录；③ 图片标准化接口使用二进制 body + `Content-Type` 而不是 JSON（base64 膨胀 33%），作为 ADR-0012「JSON 契约」的例外；按 [`no-reinventing-wheels`](../../steering/no-reinventing-wheels.md) 的格式写「采用 / 用途 / 不用它做什么」。
- [`INDEX.md`](../../../HBECHO设计方案/INDEX.md)：§5 权威矩阵加本 spec 四件套一行；§7.1 现有 spec 登记加一行；更新日期。
- **A 域 PRD 修订（升 v1.11 并补版本记录，决策人：刘学奎，2026-11-05）**：① §7.1 手工补抓改为三项（`run_now` 默认 / `queue` / `cancel_current`），写明「D-33 的串行只约束全量批次」；② **§7.3 一次同步做什么**去掉「列表处理完后按规则拉详情 / 评论 → 详情 / 评论完成后内容定稿」，改为周期同步只做主页 → 列表 → 账号级定稿 → 媒资 → 批次汇总，详情 / 评论 / 视频 / 音频按需触发；同步检查 `prd-platform.md` D-33 的措辞与 INDEX。
- **待确认闸门（已通过，2026-11-05，刘学奎全部采纳建议）**：requirements §1.5 第 1–7 项。数值起步值见 design §14 第 6 项，由运维写入配置，**不写进代码默认值**；熔断阈值与冷却期在任务 4 开工前由运维给出。
- **分支与编码命名**：合并 `a-master-data-import` 前，请刘学奎确认品牌 / 板块编码命名（`hitachi` / `hisense` / `york_vrf`，`{分公司}-water` / `{分公司}-home`）。
- 任务 0 收尾：跑 `./scripts/verify.sh`。

**验证**

- [x] `./scripts/verify.sh` 通过（2026-11-05：311 单元、325 数据库测试、链接 103 文件、spec 结构 7 个、Python 7 项）；
- [x] v2 修订逐条与 requirements §1.3（R1–R8）对应；A PRD 的 P1、P2 两处修订完成且升版。**一处连带**：v2 §12.5 / §12.6 里「内容终态等待详情依赖」的旧写法与 R2 同义，一并改为账号级封口与按需种子快照；
- [x] `CONTEXT.md` 没有出现表名、字段名、框架或接口；
- [x] ADR-0012 有补记与决策日期（2026-11-05，含 uvicorn 登记）；
- [x] INDEX 两处登记完成（A PRD 版本与本 spec 行同步为 v1.11），链接检查通过；
- [x] A PRD 升版并补版本记录，`prd-platform.md` D-33 加澄清并升 v1.0.9；
- [x] §1.5 第 1–7 项的结论已写回 requirements / design（已于 2026-11-05 完成）；
- [x] **分支**：编码命名已确认（刘学奎，2026-11-05）→ `a-master-data-import` 合并 `main`（分支 CI run 41965348342 绿；合并后本机 verify 全绿：311 单元 / 325 数据库测试）→ `a-full-sync` 已变基到 `main`。

**Requirements:** §1.3、§1.5；**Design:** §6.1、§10、§13。

## 任务 1 · schema 与迁移、证据登记

**目标**：空库一次迁移成功；新列与约束能挡住非法状态；新 tuple 的证据进了 manifest。

**新增 / 修改**

- `src/db/schema/content.ts`：`content_snapshots.seeded_from_snapshot_id`（自引用 FK，RESTRICT；CHECK：非空 ⇒ `list_observed=FALSE AND detail_observed=TRUE`）；
- `src/db/schema/sync.ts`：`sync_batches.purpose`（CHECK `full/supplement/demand/intake`）、`media_finished_at`、`IDX(purpose, status, logical_at)`；**迁移文件手工改成三步**（可空列 → 回填 `intake` → NOT NULL，无 DEFAULT），改完 `drizzle-kit generate` 不得再产生新文件；
- `src/db/schema/accounts.ts`：`IDENTIFIER_NAMESPACES` 增加 `kuaishou.user_id`（同步 CHECK）；
- 既有写入 `sync_batches` 的 tracer 代码补 `purpose='intake'`（`tracer-command`、`smoke`）；
- `drizzle/`：`drizzle-kit generate` 生成迁移；`schema.db.test.ts` 同层补用例；
- `tests/fixtures/aimaster/manifest.json`：登记 requirements §2.2 证据清单中的 raw 文件（详情 raw3 / raw4、评论 raw3 / raw4 / raw6 / raw10 / raw11、异步 raw9、快手 raw12 / raw13 / raw14），每条带 platform / action / mode / `knownGaps`；

**行为**

- 迁移可重复执行（第二次为空操作）；`drizzle-kit generate` 不产生新文件；
- `purpose` 只接受四个值；既有 tracer 路径写 `intake`；
- `seeded_from_snapshot_id` 非空时拒绝 `list_observed=TRUE` 或 `detail_observed=FALSE`；
- `kuaishou.user_id` 标识可写入，其他未登记 namespace 被拒；
- 所有新外键不使用 `ON DELETE CASCADE`。

**验证**

- [x] 空库 migrate → 成功；再跑一次 → 无变更（`migration-0004.db.test.ts`；`drizzle-kit generate` 无新文件）；
- [x] **有数据的库**：先迁移到 0003 并插入两条 tracer / smoke 形态的批次行，再应用本迁移 → 成功且这些行 `purpose='intake'`、列 NOT NULL 无 DEFAULT（同一文件，独立库 `hbecho_migrate_test`）。**测试 ECS 的 `hbecho` 库未演练**：该库是现有数据，动它需要先备份并得到同意，本机演练已覆盖同一迁移路径；
- [x] 非法 `purpose` / 种子快照组合被 CHECK 拒绝；种子快照不能被物理删除（`schema.db.test.ts`）；
- [x] tracer 全部既有用例仍通过（`purpose='intake'`，`commands.db.test.ts` 新增断言）；
- [x] manifest 新增 51 条，文件路径与 SHA-256 由既有测试逐条校验；新条目均带 `knownGaps`；
- [x] `./scripts/verify.sh` 通过；
- [ ] 按推送节奏推第一次，等 CI 绿不阻塞后续任务（只在合并前等）。

**Requirements:** FS-1、FS-7、FS-9、§1.3；**Design:** §6。

## 任务 2 · Adapter 扩展（快手、详情、评论）

**目标**：三平台 × 主页 / 列表 / 详情 / 评论的解码、请求构造、capability 与点数表全部就位，纯离线可验证。

**新增 / 修改**

- `provider-adapter/contract.ts`：`Platform` 加 `kuaishou`；`AiMasterAction` 加 `media_stats_number`、`post_comments_list`；`IdentifierNamespace` 加 `kuaishou.user_id`；新增 `DetailData`、`CommentsData`、`CommentEntry` 类型；
- `decode-profile.ts` / `decode-video-list.ts`：快手分支（12 字段主页，无头像 / 背景 / 位置；列表条目逐条容错；游标保留字符串，`no_more` 识别为 `TypedCursor` 的异常种类并交给 `ListWalker`）；
- `decode-detail.ts`（新）：`media_stats` 解码；`*_number` 优先、`*_count` 回退；`cover` / `download_urls` 字符串或换行字符串展开为候选集；`play_number=null` 保持 `explicit_null`；`author_homepage` 保存；
- `decode-comments.ts`（新）：`has_more` 的 `0/1` 归一；`max_cursor` 字符串；`total`；带 `parent_id` 的条目分流计数；评论 `id` 作为外部 ID 保留原文；
- `request.ts`：详情与评论请求体（`url`、`max_cursor`、`reply_pages=-1`）；
- `content-url.ts`（新）：`ContentUrlBuilder`——抖音 `share_url` → `https://www.douyin.com/video/{id}`；小红书 `https://www.xiaohongshu.com/explore/{id}`；快手返回 `unavailable`；
- `video-source.ts`（新）：`pickVideoSource(platform, candidates)` 纯函数（抖音主机优先级且排除 `video.url`；小红书 / 快手取详情 `download_urls`）；
- `capability.ts`：登记 requirements FS-16.1 的全部 tuple（同步 / 异步 / provider-failed / 不登记），`evidenceRef` 指向 manifest，`knownGaps` 写明快手内容 URL 未验证与认证头文档矛盾；production 全部 `disabled`；
- `cost-guard/index.ts`：点数表扩展（FS-16.3）；
- `strategies.ts`：快手策略（无第二标识绑定，author 与 profile 同命名空间）；
- `tests/harness/fixtures.ts`：加载新 fixture 的辅助。

**行为**

- 每个解码器对每个平台的 fixture 产出稳定输出；未知字段被忽略，保留在 ODS；
- 快手 `max_cursor='no_more'` 与 `has_more=true` 同时出现时，解码器给出「游标异常」标记而不是整数 / 字符串游标；
- 小红书图文笔记 `play_number=null` → `explicit_null`，不是 `0`；
- 抖音列表 `play_count=0` 仍是 `unsupported`（tracer 行为不变）；
- capability：快手评论、三平台列表异步、抖音评论异步 → 调用前被拒绝；production 一律 `disabled`。

**验证**

- [x] 解码单元测试：抖音 / 小红书 / 快手 × 主页 / 列表 / 详情 / 评论 的固定字节 fixture 全部断言（`decode-detail` / `decode-comments` / `decode-kuaishou` 测试；值状态、候选集、游标类型、`parent_id` 分流、`has_more` 归一）。**抖音 / 小红书的主页与列表沿用 tracer 既有测试**；
- [x] 快手 K3 / K6 的 `no_more` 用例；快手 L3 / L4 的科学计数法游标原样保真；
- [x] `pickVideoSource`、`ContentUrlBuilder` 表驱动测试；
- [x] capability 测试覆盖 FS-16.1 的每一行（含 production 全部拒绝）；
- [x] 点数表测试：详情 / 评论 / 快手价目；失败 / 轮询 0 点沿用 `tracer-flow.resilience.db.test.ts` 的既有用例；
- [x] `./scripts/verify.sh` 通过（见执行状态）。

**实施中的判断（自行决定项）**

- 快手详情 capability 在 `test` 环境也保持 `disabled`（`content_url_construction_unverified`），对应 FS-7.7；解码器与 fixture 测试不经 capability 门控，不受影响。
- 列表播放数对三个平台一律 `unsupported`（FS-6.6）。快手列表 `stats.play_count` 有非零值（K3 为 2048），但未验证其语义，播放数以详情为准。
- `TypedCursor` 增加 `no_more` 种类（任何平台的字符串 `"no_more"` 都归此类）；`RequestCursor` 不包含它，构造请求时抛错。
- `locator` 识别 `kuaishou.com`：`/profile/…` 为主页，`/short-video/…` 为视频（拒绝），`v.kuaishou.com` 短链本地无法判断照常发送。
- 快手 `media_user_info` / `user_video_list` 登记后，tracer 的 `submit --platform kuaishou` 在 `test` 环境会通过 capability 预检（production 仍全部拒绝）；快手的单账号端到端流程在任务 5 才有测试。两处旧测试把「未登记平台」从快手改为视频号（`commands.db.test.ts`、`cli.db.test.ts`）。
- manifest 补登记了抖音评论异步失败样本 raw8 A3（`raw8.A3.submit` / `raw8.A3.poll1`），用于 provider-failed 登记。

**Requirements:** FS-7、FS-9、FS-10、FS-16；**Design:** §2.2、§7.9、§7.10、§10。

## 任务 3 · 监控目标、批次生命周期与调度

**目标**：到点能生成批次，排队 / 跳过 / 过期 / 取消 / 补抓都对；批次启动时能规划出正确的任务集，每个被排除的账号能解释原因。

**新增**

- `src/modules/sync-schedule/`：`slots.ts`（固定 UTC+8 时点计算）、`scheduler.ts`（`tick`、创建 / 晋升 / 过期、`planned` 恢复）、`planner.ts`（分块规划任务）、`summary.ts`（终态与计数汇总、`media_finished_at`）、`commands.ts`（`createSupplement`，含 `--only profile|full` 与 `--if-older-than`；`cancelBatch`；影响面 > 1 的命令默认预览）；
- `src/modules/monitoring/`：`resolver.ts`（`targets`、`explain`，design §7.3 的 SQL）、`reasons.ts`（原因码与优先级）；
- 配置：`sync_settings` 读取与校验（`schedule_slots` 的 zod schema；`timezone` 非 `Asia/Shanghai` 拒绝）；批次创建时冻结到 `settings_snapshot`；
- `src/worker/sync-cli.ts`（先实现 `tick`、`supplement`、`batch cancel`、`batches`）。

**行为**

- `tick` 幂等；同一时点重复调用只有一个批次；超出容忍窗口不补跑；
- 有运行中 `full` → 新批次 `queued`；队列已满 → `skipped`（摘要行、无任务）；上一批次终态 → 排队批次立即晋升并规划；到下一个时点仍未开始 → `expired`；
- 规划按 500 一块；崩溃后 `planned` 批次被恢复，任务不重复；
- 目标集只含满足 FS-2.1 全部条件的账号；external 只有 `fetch_profile`；
- `supplement`：默认 `run_now` 立即 `running`、与运行中的 `full` 并行；`queue` 排到 `full` 结束后；`cancel_current` 取消当前 `full`（需 `--apply`）并审计；
- 所有迁移在 `sync_settings` 行锁的短事务内完成，事务里无 IO。

**验证**

- [x] 时点计算：跨周、两个时点、周日 23:59 与周一 00:00 边界、错过不补跑（`slots.test.ts`、`scheduler.db.test.ts`）；
- [x] 队列语义（fake clock）：第一个运行、第二个排队、上一个结束后同一次 tick 晋升、排队过期；**「第三个跳过」见下方「实施中发现」**；
- [x] 目标集：逐级关闭 / 停用，断言目标集与原因码（最上级优先）；专员停用、门店撤店、`deleted`、`suspected_empty`、`unavailable` 仍采；external 不受五级影响；`targets` 与 `explain` 逐项一致（`resolver.db.test.ts`、`reasons.test.ts`）；
- [x] 规划崩溃恢复：在第 2 块之前终止，再 `tick`，任务总数正确且无重复；规划到一半的批次仍占运行名额；
- [x] `supplement` 路径：空闲 / `run_now` 并行 / 活动任务复用 / `queue` / `cancel_current` 预览与 apply；
- [x] `--only profile` 只建 `fetch_profile`；`--if-older-than`：近期同步过 → `not_due`，不在目标集 → `not_eligible`，其余 `queued`；
- [x] 批次终态：全部任务被跳过 → `skipped/all_targets_closed`；没有目标 → `skipped/no_targets`；媒资不决定终态、`media_finished_at` 独立写入；
- [x] `./scripts/verify.sh` 通过。

**实施中发现（需要你知道）**

- **`queue_full` 在正常时点序列里几乎不可达。** A PRD §7.1 同时写了「队列里已有 1 个在等 → 本次触发跳过」和「排队到下一个时点仍未开始 → 过期，由新的触发接替」。排队批次的「下一个时点」恰好就是下一次触发的时点，所以 tick 按「先过期、再创建」处理时，新触发总是接替过期的批次并排队，不会跳过。我选择了这个顺序（符合「由新的触发接替」，也比两个批次都落空更有用）；跳过路径保留为防御，用手工放置的未过期排队批次验证。若你希望 acceptance A6 的字面行为（第三个触发被跳过、排队批次同时过期），把 `scheduler.ts` 里「创建」挪到「过期」前即可，一行调整。
- tick 的顺序是「汇总 → 过期 / 晋升 / 创建 → 规划」：先汇总，上一批次进入终态的同一次 tick 就能晋升排队批次（FS-1.5「立即」）。
- 补抓的任务全部复用了已有活动任务时，补抓批次本身没有任务，状态为 `skipped / no_targets`。
- `run_now` 并行时，若账号在全量批次里仍有活动任务，补抓只是把它们提升到优先级 100 并返回任务引用，不重复建任务。

**Requirements:** FS-1、FS-2、FS-13（补抓与取消）；**Design:** §5.1、§5.3、§7.1–§7.4、§7.12。

## 任务 4 · Worker 运行时（领取、并发、速率、恢复、预算）

**目标**：一个常驻进程能把任务表里的任务安全地领出来执行；崩溃、抢占、取消、预算都有确定行为。

**新增**

- `orchestrator/claim.ts`：`claimNext`（design §7.5 的 SQL，排序键含 `attempt_count`，重试回队尾；`EXPLAIN` 复核，必要时加索引）；
- `src/worker/provider-breaker.ts`：provider 熔断状态机（design §7.5.1）；
- `src/modules/sync-runner/`：`run-task.ts`（按动作分派，先占位调用任务 5–7 的 Runner）、`eligibility.ts`（领取时资格复核）、`failure-map.ts`（统一把失败映射到 `retry_wait / failed / dead / cancelled`）、`budget.ts`（批次作用域的调用数 / 点数检查，复用 `createBudgetPolicy`）；
- `src/worker/sync-worker.ts`：执行循环、进程内信号量、provider 令牌桶、心跳、优雅停机；
- `src/worker/sync-config.ts`：环境变量的 zod 校验（design §10），缺失即启动失败；
- `src/worker/sync-wiring.ts`、`sync-main.ts`：依赖装配、`pnpm sync worker`、`run-once`（跑到队列空，供测试与演练）。

**行为**

- **环境**：`HBECHO_ENV=staging` 目前没有任何 capability 行（tracer 起只有 test + production），所有任务会 `unregistered`，即 fail closed。worker 配置校验应直接拒绝 `staging`（或明确登记 staging 行，默认 disabled），不要让它启动后全部失败；
- 领取按 `priority DESC, attempt_count ASC, task_id`（重试任务回到队尾）；只领 `running` 批次，媒资任务可领已终态未取消批次；
- 租约过期的任务可被另一个 worker 领取，fencing token 递增；陈旧 token 的写入整笔失败；
- 并发与 QPS 受配置约束，无配置不启动；
- `SIGTERM` 后停止领取，宽限期内完成在途，放弃的任务不改状态；
- 重新领取先恢复 `in_flight` 调用（ambiguous → 只读最多重发一次）；
- 领取时资格失效 → `cancelled/monitoring_closed`，零调用；
- 批次调用数 / 点数达到上限 → 下一次调用前停止，任务 `failed/budget_exhausted`；
- 退避、`dead`、`failed` 的分类按 FS-12；
- 熔断：连续 K 次供应商级失败后停止为该 provider 领取，任务保持 `pending` 且不消耗额度；冷却后单探测，成功恢复；账号级失败不计入。

**验证**

- [x] 两个连接顺序领取同一批任务：无任务被领取两次，合起来恰好是全部（`sync-worker.db.test.ts`）；
- [x] 租约过期被抢后，原 worker 的心跳、fenced 写入全部被拒，任务状态没有被陈旧写入改动；
- [x] 取消批次后，在途任务的下一次心跳得到 `cancelled`；
- [x] 预算：达到点数 / 调用数上限时，下一次调用未发出（断言 transport 调用数，`budget.db.test.ts`）；失败（429）不计点；
- [x] 资格复核：领取前关闭账号监控，任务 `cancelled/monitoring_closed`，Runner 一次不调用；
- [x] 优雅停机（放弃的任务不改状态，租约到期后可被重新领取）与崩溃恢复（接手后 `in_flight` 调用标为 `ambiguous`、原调用保留）；
- [x] 重试队尾：第 3 个任务首次失败，其余都先完成首次尝试，它的第二次尝试排在最后（断言领取顺序）；
- [x] 熔断：连续 K 次供应商级失败后不再领取、其余任务 `attempt_count` 不变；冷却后只放一个探测，探测失败重新计时，成功后恢复；账号级失败连续出现不触发；
- [x] 缺少任一必需环境变量（含熔断阈值与冷却期），进程启动失败并一次列出所有缺项（`sync-config.test.ts`）；
- [x] `./scripts/verify.sh` 通过。

**实施中的判断（自行决定项）**

- **Runner 合同**：Runner 返回 `done`（自己在 fenced 事务里写成功终态，含封口 / 检查点）/ `failure`（框架按 `FAILURE_SPECS` 映射）/ `abandoned`（不改状态）。成功终态不由框架代写，因为任务 5 的封口必须与终态在同一个事务里。
- **只领已注册的动作**：`RUNNERS` 现在为空，所以 worker 什么都不领，未实现的动作不会被领走后失败。任务 5–7 依次注册。
- **只领 `full` / `supplement` / `demand` 批次**：tracer 的 `intake` 批次（`resolve_account` 根任务）由 tracer 自己的入口驱动，worker 不碰。
- **熔断只拦调用供应商的动作**：媒资下载不调供应商，熔断期间仍可领取。账号级失败对熔断是中性的（既不计数也不清零）；探测任务以账号级失败结束只释放探测名额。
- **点数预算按「放得下就继续」**：某次调用会超出上限就在发送前封口，更便宜的后续调用仍可进行；总花费不超过上限。批次预算每次检查聚合该批次的调用（`ponytail:` O(批次内调用数)，QPS≈2 可接受，见 `budget.ts`）。
- **Runner 抛出未预期异常**映射为 `runner_error`：有界重试、不计熔断、错误详情只记异常类型不记消息（消息可能含 secret）。
- **`HBECHO_ENV=staging` 被拒绝启动**（没有 capability 行）。
- **`EXPLAIN` 复核**（`claimNext` 的排序是否需要新索引）留到任务 10 的规模演练：几十行的表上优化器的选择没有参考意义。
- 网关的 ambiguous 有界重发名单补入详情与评论（`media_stats_number`、`post_comments_list` 都是只读查询）。

**Requirements:** FS-3、FS-12、FS-16.4、FS-2.6；**Design:** §7.5、§7.5.1、§7.11、§8、§10。

## 任务 5 · 账号采集（主页、多页列表、检查点、封口）

**目标**：一个 `running` 批次里，每个账号的主页和列表被采全，缺口被记录，快照定稿，current 不倒退；三个平台都过。

**新增 / 修改**

- `sync-runner/profile-runner.ts`：已存在账号的 `fetch_profile`（解码 → 身份一致性 → 主页快照 → current CAS → 头像 / 背景引用）；`RESULT_VALIDATION_FAILED` 耗尽的 `account_inaccessible_suspected` 与自动 `resolved`；
- `sync-runner/list-walker.ts` + `decide-after-page.ts`（纯函数，design §7.6 的 9 行判定表）；页进度写 `result_summary`（`list-walk-progress.v1`）；
- `sync-runner/seal.ts`：账号级封口（定稿、current CAS、检查点推进 / 重建 / blocked、失败列表任务的可靠条目封口、清残留 `building`）；
- `projection/content-list.ts`：支持 `building` 写入、多页续写、跨页重复合并；封面规则的钩子（任务 7 实现）；
- `sync-runner/identity-check.ts`（纯函数 + 持久化）：主页标识校验、主页残缺校验、列表作者校验，三态结果写 `result_summary.identity_check`（design §7.6.1）；
- `sync-runner/self-check.ts`：主页 `post_value` 增量 vs 本批次新发现内容（design §7.6.2）；
- 质量问题码：`continuity_gap`、`window_overflow`、`empty_window_not_rebased`、`cursor_no_more_with_has_more`、`has_more_invalid`、`account_inaccessible_suspected`、`identity_conflict`、`profile_uid_mismatch`、`profile_fields_missing`、`list_author_mismatch`、`suspected_missing_content`；
- 平台策略接入：小红书主导作者（首页完整页上算一次）、抖音第二标识、快手无绑定。

**行为**

- 严格按 design §7.6：整页投影 → 判定 → 继续 / 封口；`initial_content_limit` 只在首次基线时使用；
- 第一页位置 1–3 不作为边界证据；
- 命中边界、安全页数缺口、列表结束缺口、空窗口、游标异常、首次基线、首次空列表，七种结局的任务状态、`stop_reason`、检查点状态、质量问题与 `gap_task_count` 全部符合 FS-5；
- 进程在两页之间终止，重新领取后从 `next_cursor` 继续，已提交页不重复请求；
- 任一条目投影失败 → 检查点不推进；
- 旧批次迟到：保留历史，不回退 current 与检查点；
- 身份校验：主页标识不符 → 不写快照、不下数据、登记值不被改写；四项指标全无效 → 可重试失败；列表累计 ≥ 5 条且无一条由登记作者创作 → 清除 `building`、检查点不推进；< 5 条 → `unverifiable`；
- 自比对只告警，不改任务结果与检查点。

**验证**（证据：`./scripts/verify.sh` 全绿，536 单元 / 498 数据库测试；任务 4 结束时是 459 / 419）

- [x] `decide-after-page` 表驱动（`decide-after-page.test.ts`）：9 行判定 × 三种锚点模式 × 置顶位置，含「等于高水位时间但 ID 不在集合内则继续」；`empty` 锚点 + 本轮有内容 → 成功并重建锚点、无缺口；`empty` + 仍为空 → 保持 `empty`、成功；有旧锚点 + 首页 + `no_more` → 命中则成功、未命中则 `cursor_anomaly_rebased`；`has_more` 缺失 / 非法同上（数据库层只覆盖 `no_more`，缺失 / 非法在纯函数层）；
- [x] 三平台端到端（`account-sync.db.test.ts`、`list-walker.db.test.ts`）：抖音 20 条含异作者、小红书 21 条整页、快手 K3 / K6 / L3（23 条）+ L4（20 条）两页；批次由 `tick` 汇总为 `succeeded`；
- [x] 多页（`list-walker.db.test.ts`，页内容**合成**，结构取自 raw3 形态，文件头注明）：命中边界在第 2、3 页；安全页数 2 → 缺口并重建锚点；`has_more=false` 未命中 → `end_of_list_rebased`；
- [x] 空窗口：旧锚点非空 + 空页 → `blocked`、旧锚点未被覆盖；`empty` 锚点两种用例；
- [x] 快手 `no_more`：停止翻页、记质量问题、锚点按自然结束处理，请求体里从无 `no_more`，游标 `1.785394950371E12` 作为字符串回发；
- [x] 崩溃恢复（`list-walker.recovery.db.test.ts`）：第 1 页提交后丢进程，第二次运行只请求第 2 页；判定已落进度、封口前丢进程，不再发请求直接封口；
- [x] 失败隔离（`account-sync.db.test.ts`）：一个账号主页 `dead`，其余不受影响，批次 `partial_succeeded`；带缺口的列表任务使批次 `partial_succeeded`；
- [x] 技术失败不改账号状态（`profile-runner.db.test.ts`）：传输错误 / 超时 / 429 / 5xx / 解析失败 / ODS 写失败；`account_inaccessible_suspected` 的创建与下一批次的自动解决；
- [x] current 不倒退：旧批次迟到（`list-walker.recovery.db.test.ts`）；检查点 version 拒绝与 fencing 双重校验（`full-sync-projection.db.test.ts`、`seal.db.test.ts`）；
- [x] 身份校验五用例：`profile_uid_mismatch` / `profile_fields_missing`（`profile-runner.db.test.ts`）、`list_author_mismatch`（20 条无一条登记作者；mismatch 后无本批次 `finalized` 快照，登记标识未变）/ `verified`（抖音 20 条含 1 条异作者）/ `unverifiable`（3 条列表、小红书无登记作者）；
- [x] 自比对（`self-check.db.test.ts`）：+5、发现 2 → 警告；+0、负增长、发现数足够、上周 `missing` → 不报；两种完成顺序都只报一次；
- [x] `./scripts/verify.sh` 通过。

**未被本任务覆盖、转交后续任务的验收项**：acceptance F3（下游读取接口只返回 `finalized`：还没有读取接口，本任务只证明 `building` 不会成为 current）、F5（评论 / 媒资不阻塞定稿：任务 6、7）、G7 的列表 `video.url` 部分（任务 7）、E23 的数据库层用例（纯函数层已覆盖）。

**实施中的判断（自行决定项；细节见 [design-task5-account-sync.md](design-task5-account-sync.md) §13、§15）**

- **Runner 合同扩展**：失败结果加可选 `onTerminal`，框架只在终态时、在写终态的同一事务里执行；钩子抛错则回滚并不带钩子重写终态。这是对任务 4 的 `types.ts` / `run-task.ts` 的增量改动（既有测试不变）。
- **判定表按 A→G 顺序实现**，结果集不变，只有「旧锚点 + 累计 0 条 + `has_more=true` 且到上限」改为 `blocked`（原顺序会用空窗口覆盖非空锚点）；已回写 design §7.6。
- **attempt 规则**：`attempt_no = task.attemptCount + 1`，`call_sequence = 页号`；同一 `(task, seq)` 已有 ≥ 2 个 `ambiguous` 调用时不再发起，所以不用 `resendAfterAmbiguous`。
- **自比对串行化**：主页与列表封口两个终态事务最开始先锁同一个账号行。
- **worker 启动守卫**：`assertWorkerCanRun` 拒绝 `HBECHO_ENV=test`，并要求 production 至少有一个已批准 tuple。**当前 production 全部 disabled，真实 worker 现在不会启动**（启用 = 任务 11 的批准式 smoke + 单独的人工批准）；`tick` 与运营命令不受影响。
- **孤儿清扫**：任务 5 提供 `sweepOrphanBuilding` 并在 ListWalker 发现任务被取消时对自己的（批次, 账号）调用；定期的全局清扫在任务 9 的 `maintain` 里调用。
- 列表任务 `mode≠synchronous` → `capability_disabled`（周期列表只走同步）；列表 `RESULT_VALIDATION_FAILED` 耗尽按框架默认 `dead`，不产生 `account_inaccessible_suspected`。

**Requirements:** FS-4、FS-5、FS-6、FS-7；**Design:** §5.2、§7.6、§7.6.1、§7.6.2、§7.7。

## 任务 6 · 按需采集（需求、详情、评论）

**目标**：规则域能提交需求并查到结果；本轮已有的复用，没有的才抓；详情落种子快照，评论落最新态。

**新增**

- `src/modules/demand/`：`submit.ts`（规范化、幂等、范围校验、依赖展开、复用判定、分块建任务）、`get.ts`、`reuse.ts`（`round_start` 与复用条件的纯函数 + SQL）；
- `sync-runner/detail-runner.ts`：URL 构造 → `media_stats_number` → 种子快照 → 合并 → 定稿 → current CAS；失败清理；
- `src/modules/comments/`：`comments-runner.ts`、`project.ts`（upsert、疑似删除、恢复）、`policy.ts`（完整性口径）；
- 质量问题码：`detail_inaccessible`、`comments_total_mismatch`、`comment_coverage_incomplete`；
- `sync-cli.ts`：`demand submit --file`、`demand get`；
- `tests/harness/fake-rule-source.ts`：测试用假提出方（固定圈定若干内容，提交需求）。

**行为**

- **按需任务必须写 `account_id`**（从内容反查所属账号，同时写 `content_id`）：领取时的监控资格复核靠它；缺 `account_id` 的详情 / 评论任务会被 worker 以 `monitoring_closed`（`no_account_reference`）取消，不会调用供应商（fail closed）；
- **批次终态**：`sync-schedule/summary.ts` 当前只汇总 `purpose IN ('full','supplement')`，按需批次有任务后会永远停在 `running`。本任务必须扩展汇总到 `demand`（按其详情 / 评论 / 媒资任务的终态判定，规则见 FS-8），并有测试；
- 提交：逐项处置七类全部可达；同键同载荷返回原批次，同键异载荷冲突；范围外内容 `out_of_scope`；快手评论 `unsupported_platform`；快手详情 `capability_disabled`；
- 复用：本轮已有 → `reused`；活动任务 → `already_pending`；视频 / 音频已有资产 → `reused`；`audio` 隐含 `video`，`video` 隐含 `detail`；
- 详情：种子快照拷贝全部 value / state，`list_observed=FALSE`、`detail_observed=TRUE`、`seeded_from_snapshot_id` 非空；详情有效值覆盖，缺失 / null 不擦除；定稿并参与 current 比较；失败 → 不留种子快照、内容 `status` 不变；
- 评论：一级过滤、幂等 upsert、完整性口径（抖音自然翻完为完整，小红书与触达上限不完整）；疑似删除只在完整抓取后；重新出现恢复；`total>0` 与空结果、`total` 大于已抓 → 质量问题；
- `get` 只读本地，返回读取指针；预算耗尽的项如实展示。

**验证**（证据：`./scripts/verify.sh` 全绿，553 单元 / 522 数据库测试）

- [x] 提交处置矩阵：七类处置各一个用例；幂等（含 items / wants 顺序不同）与冲突；崩溃重放补齐缺失任务不重复；越权 / 非法输入（`demand/demand.db.test.ts`）；
- [x] 复用：同一轮内两个计划先后提交同一内容，只有一次详情 ProviderCall；下一个 `full` 批次开始后再提交，重新抓取（**包括上一轮由按需批次产生的详情**）；
- [x] 种子快照：`snapshot_at` = 详情响应接收时间、`merge_policy_version` = `list-merge.v1`；`source_content_snapshot_id` 指向种子；列表独有字段（正文、分享页地址）不丢；current 切到详情快照后列表字段仍可读；小红书 `play_number=null` → `explicit_null`（`projection/detail.test.ts` 覆盖合并规则）；
- [x] 详情失败：`RESULT_VALIDATION_FAILED` 耗尽 → `failed/detail_inaccessible`，无种子快照残留，内容状态未变，质量问题存在；post_id 不符不合并；预算封口 `budget_exhausted` 在 `get` 里如实展示；
- [x] 评论（`comments/comments.db.test.ts`、`comments/policy.test.ts`）：抖音两页翻完 → 完整；下一轮少一条 → 疑似删除，再下一轮出现 → 恢复；小红书 `total=28` 只返回 2 → 不标记、`comment_coverage_incomplete`；触达 `page_limit` → 不标记；`total>0` 而空 → `comments_total_mismatch` 且不标记；`parent_id` 条目被忽略并计数；间歇 `RESULT_VALIDATION_FAILED` 回队尾后重试成功；崩溃后从已提交页的下一游标继续；
- [x] 按需批次不受全量串行约束，优先级高于周期任务（断言领取顺序）；`tick` 汇总按需批次（`succeeded` / `partial_succeeded`）；
- [x] `./scripts/verify.sh` 通过。

**视频 / 音频的需求侧（依赖展开、复用、后续媒资任务）已在本任务实现，端到端验证在任务 7**（那里才有 `download_media` Runner）。

**实施中的判断（自行决定项）**

- **`comments` 表补建**（迁移 `0005_full_sync_comments`）：v2 §10.4 已定义，tracer 的初始迁移没建。逐字按 v2，不是新设计；按 tasks「必须停下来问」第 3 条，这一点需要你知道——如果你认为它应先单独评审，回退这个迁移即可（它是纯新增表，无数据迁移）。
- **详情的种子快照直接以 `finalized` 写入**：种子拷贝 → 合并 → 定稿 → current 比较在同一个 fenced 事务里，`building` 的中间态外部不可见，所以不单独落一个 `building` 行。
- **按需任务的 `mode`**（详情 / 评论）来自新增的必填配置 `HBECHO_SYNC_DETAIL_MODE` / `HBECHO_SYNC_COMMENTS_MODE`，不写死；评论翻页的 `call_sequence` 是页号，所以评论和周期列表一样只走同步（异步 → `capability_disabled`）。
- **视频 / 音频任务由详情成功时创建**（下载地址是详情带来的）：详情任务参数里带 `followups.roles`，成功的终态事务里同时写 `video` 引用并建 `download_media` 任务（有序候选来源放进任务参数）；本轮已有带下载地址的详情则提交时直接建媒资任务。别的计划的活动详情不借用（`ponytail:` 极少数并发下可能多一次详情调用）。
- 完整性边界：恰好在上限页自然翻完（`has_more=0`）算完整——读完了就是读完了；只有「还有更多却停了」才算触达上限。
- `url_form` 任务参数省略（运行时按内容重新构造 URL）。

**Requirements:** FS-8、FS-9、FS-10；**Design:** §5.4、§7.8、§7.9。

## 任务 7 · 媒资（封面首次、快手、视频、音频）

**目标**：头像 / 背景每周、封面首次、快手封面可用、视频与音频按需入库，失败如实标记，批次媒资进度独立可查。

**新增 / 修改**

- `projection/content-list.ts`：封面首次规则（R3）；
- `media-failure/index.ts`：新增 `informational` 分类（`no_audio_track`），`classifyMediaFailure` 与 `isRetryableWithSameUrl` 的用例补齐；
- `media-archive/`：`account-batch.ts`（周期媒资任务：处理该账号本批次所有 `pending` 引用，等 profile 与 list 都终态后可领）、`kuaishou-cover.ts`（CDN 转换来源）、`video.ts`（流式下载到 `HBECHO_MEDIA_TMP_DIR`、边写边算 SHA-256、完整性校验、`finally` 删除、启动清理）、`audio.ts`（签名 URL → `CapabilityClient.extractAudio` → 正式资产；`no_audio_track` 终态）；
- `raw-capture/oss-store.ts`：`putFile`（ali-oss `multipartUpload`）与 `signedGetUrl`（`signatureUrl`）；`ports.ts` 同步；
- `media-archive/ports.ts`：`VideoTransport.stream`、`CapabilityClient`；`tests/harness/fake-media.ts` 扩展流式 fake、`fake-capability.ts`；
- `sync-summary`：批次媒资汇总与 `media_finished_at`；
- 质量问题码：`media_cover_unavailable`、`media_archive_failed`（沿用）。

**行为**

- **媒资失败分流**：`failure-map` 只有可重试的 `media_download_failed`。`classifyMediaFailure` 判为 terminal 的原因（`too_large`、`url_rejected`、`content_type_not_allowed` 等）必须映射成不可重试的稳定失败码（在 `FAILURE_SPECS` 里新增），不能走 `media_download_failed` 被重试到 `dead`；
- **视频多候选**：`rankVideoSources` 返回全部可用候选；下载必须按顺序逐个尝试，一个失败（含过期）换下一个，全部失败才算失败，不能只取第一个；
- 同一内容连续两个批次出现：第一次建并下载封面，第二次不建新引用；第一次下载失败，第二次用新地址重建引用；
- 快手封面：原始 KVIF 为原始资产；CDN JPEG 经 `ImageConverter` 生成 JPEG q80 / 540 宽衍生资产；转换失败标记「封面不可用」，内容不受影响；
- 视频：来源选择遵守 `pickVideoSource`；峰值内存不随文件大小增长（用大文件 fake 断言缓冲上限）；超 `maxBytes` 中止并删除临时文件；`Content-Length` 不符 → `truncated`；相同字节命中 `UQ(sha256)` 复用资产；
- 音频：只在视频入库成功后抽取；无音轨 → `no_audio_track` 终态、不重试、不计失败；
- `source_expired`：重新取详情拿新地址（有界）；
- 规则未圈中的视频从不下载；
- 媒资失败不影响结构化快照；续用旧资产标记 `carried_forward` 并记录本轮失败。

**验证**

- [ ] 封面首次规则的四种序列（成功 / 成功、失败 / 成功、成功 / 失败）；
- [ ] 快手封面链路（fake CDN）与失败路径；
- [ ] 视频流式：fake 源 200 MB（生成），进程缓冲小于阈值；中止、截断、超限、过期各一个用例；
- [ ] 音频：有音轨 / 无音轨 / 能力服务不可用（可重试）；`no_audio_track` 分类为 `informational`，不重试、不计入批次媒资失败数；
- [ ] 相同字节两条引用 → 一份资产；临时 URL 变化 → 不产生新资产；
- [ ] 批次终态后媒资任务仍被领取；全部终态后 `media_finished_at` 写入；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** FS-11；**Design:** §7.10。

## 任务 8 · Python 能力服务 HTTP 外壳与 Node 客户端

**目标**：生产环境里图片标准化与音频抽取有一个真正在跑的服务，契约稳定，默认测试不依赖它。

**新增**

- `services/capability/capability/app.py`：FastAPI，`POST /v1/image/normalize`、`POST /v1/audio/extract`、`GET /healthz`；
- `services/capability/capability/audio.py`：`ffmpeg -i <url> -vn -c:a copy -f ipod`，带超时与最大字节；无音轨返回结构化错误；
- `services/capability/tests/`：外壳契约测试（`TestClient`）、音频抽取的真实 ffmpeg 小样本测试（ffmpeg ≥ 7.1 才跑）；
- `src/modules/media-archive/capability-client.ts`：`HttpCapabilityClient`（Node 内置 `fetch`，无新依赖），错误码映射到 `converter_unavailable / convert_failed / no_audio_track`；
- 服务只在 compose 内网暴露，**不映射宿主端口、无数据库 / OSS 凭证**（compose 文件属 I 域，本任务只在 README 写约束）。

**行为**

- 契约失败返回 `{code}`，不靠日志文本；
- 请求体大小与超时有上限；
- `HttpCapabilityClient` 在服务不可用时抛出可重试错误；
- 默认测试用 fake，不起 Python 服务。

**验证**

- [ ] `pytest`：外壳契约、图片标准化（沿用 HEIC 样本）、音频抽取（有音轨 / 无音轨 / 非法 URL）；
- [ ] Node 侧：`HttpCapabilityClient` 对本地 fake HTTP 服务器的契约测试（回环地址，允许）；
- [ ] `./scripts/verify.sh` 第 9 步在 ffmpeg ≥ 7.1 环境下通过；环境不满足时明确打印「未验证」。

**Requirements:** FS-11.4、FS-11.7；**Design:** §7.10。

## 任务 9 · 运营命令、查询与定时清理

**目标**：运营能查到本周同步到哪、缺什么、花多少；能做授权范围内的处置；清理按时运行。

**新增 / 修改**

- `src/modules/sync-status/`：`status`、`batch`、`account`、`freshness`、`sample`（本地聚合、点数估算、脱敏、三态校验汇总、随机抽样对账）；
- `src/modules/sync-ops/`：`rebind`、`confirmDeleted`、`setIssueStatus`、`externalAdd/enable/disable/list`、`retryFailed`（调用 `sync-schedule`）；
- `monitoring/set-switch.ts`：五级开关写入（经销商级仅超管；账号级关闭写 `monitoring_closed_reason='manual'`）；
- `identity/repository.ts` 与 `orchestrator/tracer-flow.ts`：`external` 入口分支（≤3 次解析、非主页拒绝、成对写入、无名额检查、owner 快照为空、只写主页快照、不请求列表）；
- `src/modules/maintenance/`：`runDaily`；
- `sync-cli.ts`：补全 design §15 的全部命令；退出码沿用 tracer；
- 审计事件：全部处置命令走 `AuditSink`。

**行为**

- 查询只读本地，不触发供应商调用，输出脱敏；
- `rebind` 校验新专员名额、不改写已发生 discovery 的 owner 快照；`confirm-deleted` 写 `slot_released_at` 释放名额、归属保留；
- `issue set-status` 不删除业务数据；
- `monitoring set` 不改写下级值；分公司主体不能设经销商级；
- 外部账号只由超管创建，分公司 / 总部不可见；
- `retry-failed` 条件与效果按 FS-12.5；
- 影响面 > 1 的命令（`monitoring set` 在非账号级、`batch cancel`、`batch retry-failed`）默认只预览，`--apply` 才写；
- `sample --n` 只读，随机抽 N 个本批次成功账号，输出入口、标识与最新摘要；
- `maintain` 每日一次、幂等、有界、写日志；其中调用任务 5 的 `sweepOrphanBuilding`（外部取消留下的 `building` 行，有界批量）。

**验证**

- [ ] `status` / `batch` / `account` / `freshness` 的输出对照固定数据断言（含 ambiguous 与点数估算）；
- [ ] `rebind`：成功、新专员名额已占、记审计；`confirm-deleted` 后该专员可再录同平台账号；
- [ ] 监控开关：五级各一个用例，经销商级权限，上级关闭后下级值不变；
- [ ] 外部账号：创建、只生成 `fetch_profile`、在目标集中、对非超管不可见；
- [ ] `retry-failed`：只放回 `failed/dead`、不重复成功任务、非最新批次被拒；
- [ ] `maintain`：用 fake clock 跑两次，第二次无新增删除；不动快照与媒资；
- [ ] 预览：不带 `--apply` 时数据库零写入（对比前后行数 / 更新时间），输出受影响数与前 20 个示例；
- [ ] `sample`：N 超过成功账号数时返回全部；输出不含临时 URL；三态校验在 `status` / `account` 中不合并；
- [ ] CLI 退出码；
- [ ] `./scripts/verify.sh` 通过。

**Requirements:** FS-13、FS-14、FS-15、FS-17、FS-20；**Design:** §7.13、§9、§15。

## 任务 10 · 全量离线验收、故障注入与规模演练

**目标**：requirements 的每条 SHALL 有离线检查；6,000 账号规模的数字有记录。

**动作**

- 按 [`acceptance.md`](acceptance.md) 逐条补齐缺失的测试，把「逐条结果」表填上测试文件；
- 故障矩阵（FS-18.3）：ODS 写失败、`in_flight` 后丢进程、租约被抢、陈旧 token、页投影中途失败、媒资失败 / 过期、预算耗尽、取消；
- 规模演练（FS-18.4）：生成 6,000 账号 / 三平台组织与账号，fake transport 跑一轮周期批次，记录规划耗时、峰值内存、`sync_tasks` / `content_snapshots` 行数、是否出现重复任务；结果写入 design §12；
- **测试 ECS 运行**（需要刘学奎授权）：一次性 MySQL 容器上跑本 spec 的 `*.db.test.ts` 与规模演练，记录耗时与内存（server-access 第 5 条）；
- 回填 INDEX 与本 spec 状态；
- 按推送节奏推第二次，**合并前**等 CI 绿（`gh run watch --exit-status`），合并提交写 run id 与本机 verify 结果。

- 规模演练同时记录：`claimNext` 的 `EXPLAIN`（是否需要新索引）；批次预算「实际花费 / 上限」的比值（`spentForBatch` 把在途调用也按保守口径计入，并发 C 时多占最多 C−1 次调用的额度，是瞬时占用，不是永久损耗）；
**验证**

- [ ] acceptance 自动项全部有对应测试且通过；
- [ ] 规模演练无重复任务，数字已回填；超出预期（例如规划超过 10 分钟或内存异常）则停下来问；
- [ ] `./scripts/verify.sh` 通过；
- [ ] CI 绿。

**Requirements:** FS-18；**Design:** §11、§12。

## 任务 11 · 批准式 smoke（人工批准，付费）

**目标**：用最小预算在真实供应商上验证新 tuple 的实际行为，回填未知项；**不自动启用任何 production**。

**前置**：任务 10 完成；刘学奎书面批准预算与 allowlist；显式运行时开关；密钥在源码控制之外（server-access 第 6 条）。

**动作**（沿用 `src/modules/smoke`，扩展 allowlist 与摘要）

- 快手：主页、列表（观察 `no_more` 与翻页）、详情（**验证内容 URL 构造方式**）；
- 抖音 / 小红书：详情、评论（小红书翻页行为）；
- 一次视频下载 + 音频抽取（选小文件）；
- 一次两页以上的列表走法，观察检查点命中；
- 记录：调用数、延迟、字节数、估算点数 / 金额、视频 URL 有效期线索、QPS 线索、异步轮询 TTL；
- 输出审计摘要，回填 design §14 第 2、5、7 项与 capability `knownGaps`；
- production activation 保持 `disabled`，启用另走人工批准。

**验证**

- [ ] 预算 / 调用上限在发出下一次调用前生效；
- [ ] 摘要不含 secret 与完整载荷；
- [ ] 快手内容 URL 构造方式有结论（可用 / 不可用 / 需要别的形式），写入 ADR 或 design 并更新 `ContentUrlBuilder`；
- [ ] 未执行的 tuple 仍为 disabled。

**Requirements:** FS-19；**Design:** §14。

## 对已有代码与测试的改动（实施时登记）

| 任务 | 可能触到的既有文件 | 说明 |
|---|---|---|
| 0 | v2、`CONTEXT.md`、ADR-0012、`INDEX.md` | 只改基线与登记，不改代码 |
| 1 | `src/db/schema/{content,sync,accounts}.ts`、`drizzle/*`、`tracer-command`、`smoke` 的批次写入 | 补 `purpose='intake'`；不改 tracer 语义 |
| 2 | `provider-adapter/*`、`cost-guard`、`tests/harness/fixtures.ts` | 扩展枚举与表；tracer 既有 fixture 断言不变 |
| 4 | `orchestrator/claim.ts` | 新增 `claimNext`，不改 `claimTask` |
| 5 | `projection/content-list.ts` | `building` 与多页；tracer 单页路径的行为不变（既有 tracer 测试必须仍通过） |
| 7 | `projection/content-list.ts`（封面）、`media-archive/*`、`raw-capture/oss-store.ts` | 封面首次规则只影响「已有成功封面」的内容；tracer 首次入库行为不变 |
| 9 | `identity/repository.ts`、`orchestrator/tracer-flow.ts` | `external` 分支只在 `watchType='external'` 时进入 |

## 必须停下来问

出现以下任一情况，停止实现，先问，不自行决定：

1. requirements §1.5 的结论被推翻，或评审要求不同写法；
2. v2 的 R1–R7 未落回正文，或评审要求不同写法；
3. 需要新增表、改变门店 / 账号 / 归属语义，或把 `unavailable` / `deleted` 改为自动设置；
4. 供应商返回的字段与 fixture 不符（尤其详情 / 评论的新字段、快手列表第三页之后的行为）；
5. 任何需要网络、真实用户、真实密钥或生产数据的验证（任务 11 之外）；
6. 规划 6,000 账号超过 10 分钟，或 worker 峰值内存异常；
7. 视频下载需要突破 2GB / 技术上限，或能力服务需要持有 OSS / 数据库凭证；
8. 需要新增 Node 依赖，或 Python 侧除 FastAPI / uvicorn 外的新依赖；
9. `a-activity-plan` 对 `monitoring_enabled` / `monitoring_closed_reason` 提出与 FS-14 冲突的需求；
10. `ContentUrlBuilder` 对快手需要猜测 URL 形式（只有 smoke 证据才能放行）。

**小的判断自己做**：reason code 命名、fixture 具体值、索引名、规划分块大小（100–500）、日志字段顺序、CLI 帮助文案、令牌桶实现细节。

## 页面任务

本 spec 没有页面（design §15）。运营入口只有 CLI；将来的同步 / 账号 / 外部账号页面由后续 UI spec 承接，该 spec 需先完成界面设计并经刘学奎确认（`structure` steering）才能写页面任务。

## 完成定义

- 全部任务 0–10 完成，不等于生产可用：production capability 仍 `disabled`，启用需要任务 11 的 smoke 与单独的人工批准；
- acceptance.md 的自动项全绿、手工项通过、v2 修订已落回、ADR-0012 补记已完成，才可进入合并评审；
- 合并前按 `dev-ci-cadence.md` 等 CI 绿，并在合并提交写 run id 与本机 `verify.sh` 结果；涉及测试机验证的再写通过数与耗时；
- 合并后：INDEX 状态由「未开始」改为实际状态，路线图第 3 位标注结果。
