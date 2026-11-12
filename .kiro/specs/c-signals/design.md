# C 识别能力（c-signals）· 设计

> **状态**：`draft`
>
> **模式**：Design-First
>
> **需求**：[`requirements.md`](requirements.md)
>
> **实施计划**：[`tasks.md`](tasks.md)（未开始）
>
> **验收**：[`acceptance.md`](acceptance.md)
>
> **所属域**：C 识别能力 · **目录命名**：`c-signals`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md) v1.2（定稿候选）
>
> **数据基线**：A 域的快照 / 媒资 / 评论 / 账号表按 [`database-design-v2.md`](../../../HBECHO设计方案/domains/data-foundation/database-design-v2.md) 与已合并的 `src/db/schema/*`；C 域的表以本文 §6 为准，不入 v2
>
> **最近核对**：2026-11-11
>
> **更新日期**：2026-11-12

## 1. Overview

本 spec 的最小纵向结果是：

```text
A 把一个内容的 current 快照推进到新批次
→ C 的扫描器看到 current 指针前移 → 归一化标题 / 正文 / 话题 → 写特征行（旧值进历史表）
→ D 通过 SignalReader 读到五态之一（valid / stale / failed / missing / not_applicable）

D 建监控判定计划 → C 建监控段 → 业务上传标准图 / 元素图（OSS 专用桶）→ D 请求补算
→ C 为「缺失的（封面 × 标准图）」建任务 → worker 签两个短期 URL → Python 匹配 → 0.0–10.0 分写结果行
→ D 轮询 readMany 直到没有 pending

D 配了音频判定项 → C 读 A 已归档的音频 → 经 AiGatewayPort：ASR → 判定 → 结构化结论写结果行
（H1 未落地时网关是 disabled：不建任务、不发调用）

能力升级 → 旧值读作 stale，什么都不自动重算 → 有权限的人带范围预览、执行重算，留记录
```

**与已有能力的关系**：

| 已有能力 | 本 spec 怎么用 | 本 spec 不做什么 |
|---|---|---|
| `contents.current_snapshot_*` 与 `selectCurrentContentSnapshot` | 读指针作为触发；沿用 `isNewer` 的排序规则判断特征行能否被覆盖 | 不改指针的写入路径，不订阅（没有事件）|
| `media_references` / `media_assets` / `oss_objects` | 读 `archived` 的原图与音频；用 `MediaObjectStore.signedGetUrl` 给 Python | 不写 A 的媒资表，不触发下载，不使用 `carried_forward` |
| `comments` | 读 `active` 评论的 `content_text` | 不建评论作者、不复制作者 ID / 点赞数 |
| `demand`（按需采集） | 不用 | 不提需求；缺素材只回报（PRD C §8.2）|
| Python 能力服务 | 新增 `/v1/image/match`；复用 `image.py` 的解码 | 不让 Python 持有 OSS 凭证、数据库凭证 |
| `ImageConverter` / `sniffImage` | 标准图上传时的可解码校验与类型嗅探 | 不改它们 |
| `canonical-json`（`jcsSha256`） | 素材指纹、参数指纹、任务幂等键 | — |
| `FakeObjectStore` / `FakeClock` / `network-deny` | 测试挂具 | — |
| `orchestrator/claim.ts` 与 `sync_tasks` | **不复用**（SG-D06） | 不改 `SYNC_TASK_ACTIONS` |

## 2. Authority and Evidence Levels

### 2.1 Decision order

1. [`CONTEXT.md`](../../../CONTEXT.md)；
2. C 域 PRD v1.2（信号目录、五态、复用键、保留期、重算、监控段生命周期）；
3. A 域已合并的 schema 与代码（C 只读）；
4. D、H、B 的 PRD（消费方与通道）；
5. 本 spec 的建议（§14 列出全部待确认项）。

### 2.2 Evidence labels

| 等级 | 含义 | 本设计中的例子 |
|---|---|---|
| `code` | 已合并代码里读到的事实 | `selectCurrentContentSnapshot` 只接受 finalized、按 `(logical_at, batch_id)` 比较；`comments` 无 `parent_id`；`HttpCapabilityClient` 的错误分类；`video-runner` 已产出 `audio` 媒资 |
| `prd` | 上游 PRD 或已编号决策 | C-D01～C-D14、复用键四元组、保留期、5 态 |
| `fixture` | 从仓库样本读到的 | 话题三种写法（`#日立中央空调 #全效Ⅱ三管制`、`#一键节能更省心#金秋焕新首选`、`#来拍照了[话题]#`）；`tag_text` 为空串的样本占多数 |
| `proposal` | 本 spec 的建议，**待评审** | 触发点、任务表、匹配分映射的形状、`retainUntil`、禁用网关 |

没有实测依据的数值（评分并发、扫描间隔、`R_FULL`）一律标为可配置初值，不当作合同。

## 3. Goals and Non-goals

### 3.1 Goals

1. 文本信号随 current 指针自动就位，一对象一行，旧值不丢；
2. 一个读取口给出五态，且读取不触发任何计算；
3. 派生信号按复用键只算一次，换图 / 升版本 / 换标准都正确分叉；
4. 监控段与标准图有完整生命周期，可清除；
5. 第 3 层在没有 H1 的情况下可完整离线证明，且不可能花钱；
6. 能力升级不静默重算；重算是带范围、带记录的显式操作；
7. 所有异步工作可崩溃恢复、无重复结果。

### 3.2 Non-goals

页面、判定与阈值、采集、H1 本身、OCR / 图片 / 视频理解、pHash 预筛、聚合比率信号、@ / POI / 外链、部署形态、真实付费 smoke。详见 requirements §1.5.2。

## 4. Ownership and Deep Modules

新增一个模块目录、一个 schema 文件、一个 Python 文件与两个 CLI 文件（目录约定见 [ADR-0013](../../../HBECHO设计方案/architecture/adr/0013-repository-layout.md)）：

| 位置 | 职责 | 对外 seam |
|---|---|---|
| `src/modules/signals/catalog.ts` | 信号目录、能力版本、平台可得性、启用判断 | `catalog.require(key)`、`platformSignals(platform)`、`isEnabled(capabilityId)` |
| `src/modules/signals/text/` | `normalizeText`、`normalizeKeyword`、话题解析（按平台）、`PLATFORM_TEXT_FIELDS` | 纯函数 |
| `src/modules/signals/facts.ts` | **A 事实读取口**：C 读 A 表的唯一入口（批量） | `contentFacts(ids)`、`commentFacts(ids)`、`coverMaterial(ids)`、`profileMaterial(accountIds, role)`、`mediaObjectOf(assetIds)`、`scopeSubjects(scope, signalKey, after, limit)`、`audioMaterial(ids)` |
| `src/modules/signals/features/` | 特征行写入（CAS + 历史）、扫描驱动、对账 | `ingestContent(tx, …)`、`runScan(deps)` |
| `src/modules/signals/segments/` | 监控段、标准图、可执行性、清除 | `createSegments(deps)` |
| `src/modules/signals/scoring/` | `requestScores`、评分 runner、匹配客户端 | `requestScores`、`createScoreRunner` |
| `src/modules/signals/speech/` | `AiGatewayPort`、禁用实现、ASR / 判定 runner、提示词 | `AiGatewayPort`、`DisabledAiGateway` |
| `src/modules/signals/reader.ts` | 五态合成；`read` / `readMany` | `SignalReader` |
| `src/modules/signals/tasks/` | 任务入队、领取、心跳、fenced 写入 | 内部 |
| `src/modules/signals/recompute.ts` | 范围展开、预览、执行、分块 | `recompute.preview/apply` |
| `src/modules/signals/retention.ts` | `retainUntil`、清理器 | — |
| `src/modules/signals/{authz,audit,errors,config,assemble}.ts` | 授权入口、审计端口、错误类、配置、装配 | `createSignals(deps)` |
| `src/db/schema/signals.ts` | 本 spec 全部新表 | — |
| `src/worker/signals-cli.ts` / `signals-main.ts` | 命令解析、常驻进程装配 | `runSignalsCli(argv, deps)` |
| `services/capability/capability/match.py` | 模板 / 元素匹配 | `POST /v1/image/match` |

**深模块设计**（窄接口、厚实现）：

- D 只知道 `SignalReader`、`requestScores`、`segments`、`executability`、`retainUntil`，不知道特征行、结果行、任务表的存在；
- `facts.ts` 是 C 与 A 之间**唯一**的耦合点：A 改表结构时只改这一个文件。评分 runner 取 object key（`mediaObjectOf`）、重算范围展开（`scopeSubjects`，含当前归属 → 门店 → 品牌）都经它，不在别处直接查 A 的表。静态护栏保证其他文件不 import A 的 schema（`reader.ts` 读特征与结果只碰 C 自己的表）；
- `reader.ts` 里五态合成是一个纯函数 `composeState(input)`，输入是已经取好的事实，便于表驱动测试。

## 5. End-to-end flow

### 5.1 文本信号

```text
signals run（常驻）每 tick：
  1. 读游标 content_scan = (watermark_at, watermark_id)
  2. 取 contents WHERE current_snapshot_id IS NOT NULL AND (selected_at, content_id) > 游标
         ORDER BY selected_at, content_id LIMIT 批量
  3. 再取「迟到提交」：selected_at 在 (游标 − 回看窗口, 游标] 内、特征行不是当前快照的内容
  4. 对每个内容：读 current 快照的 title / body / tag_text 与平台 → 算素材指纹
       → 与特征行比较 → 需要写入时：事务内锁特征行 → 排序检查 → 写历史 + 更新
  5. 游标推进到本批最后一行；每小时另跑一次对账（§7.3）
评论：同样，游标按 (last_seen_at, comment_id)
```

### 5.2 监控段与标准图

```text
D 建计划            → segments.create(actor, {planId, platform})              → 草稿 v1
业务上传封面标准图    → segments.putImage(actor, {planId, v, kind:'template', target:'cover', bytes})
                       校验 ≤10MiB、可解码 → OSS signals 桶 → 事务写 segment_images（同对象旧图先删）
D 保存信号集合       → segments.setItems(actor, {planId, v, items})            → 校验目录 / 平台 / ASR≤1
D 试跑第 2 层        → requestScores(segmentRef, subjects, ctx)                 → 见 5.3
D 发布              → segments.publish(actor, {planId, v})                    → 校验可执行 → published
D 改配置            → segments.newDraft(actor, {planId, fromVersion})          → 复制 items 与图片字节 → 草稿 v+1
D 删除计划期满       → segments.purge(planId)                                  → 删对象 → 删行（幂等）
```

### 5.3 模板 / 元素匹配

```text
requestScores(segmentRef, subjects, ctx):
  1. 读监控段（草稿或已发布）→ 取出该信号对应的图片行（参数指纹 = 图片 sha256）
  2. facts.coverMaterial / profileMaterial(subjects) → 每个主体： ready(sha, assetId) | not_applicable | missing(原因)
  3. 对 ready 主体：查结果行最高版本 → 判断是否「缺失」（§7.7）
  4. 对缺失的主体建任务（幂等键 = jcsSha256(复用键)）；已有活动任务则复用；dead 的置回 pending
  5. 返回逐主体的处置（queued / reused / not_applicable / missing(原因) / disabled）与「需要素材」清单

worker 领取任务：
  读任务 → 取候选图 object key（A 媒资）与标准图 object key（signals 桶）→ 各签短期 GET URL
  → 事务外调用 POST /v1/image/match → 校验回报的能力版本 → 短事务 + fencing：插入结果行（唯一键冲突=命中）→ 任务 succeeded
```

### 5.4 音频理解

```text
requestScores(…asr_text…):
  gateway.activeModel('asr') == null → missing(capability_disabled)，不建任务
  audioMaterial 缺 → missing(audio_not_archived)
  否则：参数指纹 = 32 个零字节；结果行已有 → reused；否则建 ASR 任务
requestScores(…asr_judgement…):
  gateway.activeModel('asr') == null 或 gateway.activeModel('judge') == null → missing(capability_disabled)，不建任务
  audioMaterial 缺 → missing(audio_not_archived)
  否则：参数指纹 = jcsSha256({standard_text(规范化), prompt_version, model_version(= activeModel('judge'))})
        结果行已有 → reused；否则建判定任务

judgement 任务：
  取 ASR 结果行 → 没有：确保 ASR 任务存在，本任务 deferred（不计重试次数）
  → gateway.judge({callKey, transcript, standardText, promptVersion}) → zod 校验输出 → 写结果行
asr_text 任务：
  signedGetUrl(audio) → gateway.transcribe({callKey, audioUrl}) → 写结果行
```

### 5.5 升级、重算、清理

```text
改 catalog 里某信号的版本号并发版        → 旧结果读作 stale；扫描器对「素材变了」的内容用新版本；其余不动
signals recompute preview --signal … --scope …   → 条数
signals recompute apply   --signal … --scope …   → 建 run 行 + 第一个 recompute_chunk 任务
  chunk 任务：处理 500 个主体 → 特征行：旧值进历史、写新版本；结果行：为（素材 × 参数）建新版本任务
              → 建下一个 chunk 或把 run 置 completed
signals run 每日：retention（按 expires_at 分块删除结果行与历史行）
```

## 6. Data model

C 域全部新表放 `src/db/schema/signals.ts`，遵守数据底座惯例：内部 ID 为 signed `BIGINT`（API 输出十进制字符串）；时间 UTC `DATETIME(6)`；状态用 `VARCHAR + CHECK`；哈希列 `BINARY(32)`；无 `ON DELETE CASCADE`。**表数 9 张**，不入 v2。

### 6.1 新表

#### `content_features`（特征行：内容的 0 档信号当前值）

| 列 | 类型 | 说明 |
|---|---|---|
| `content_id` | id PK | FK → `contents`（RESTRICT） |
| `content_snapshot_id` | id NOT NULL | 本行所基于的 current 快照；复合 FK `(content_id, content_snapshot_id)` → `content_snapshots(content_id, content_snapshot_id)`（已有唯一键 `uq_content_snapshots_content_id`） |
| `text_material_sha256` | sha256 NOT NULL | 素材指纹（§7.5） |
| `title_normalized` | longtext NULL | 仅 `text.title_normalized` 为 `valid` 时非空 |
| `body_normalized` | longtext NULL | 同上 |
| `hashtags` | json NULL | 字符串数组；仅 `text.hashtags` 为 `valid` 时非空 |
| `signals` | json NOT NULL | 信封：`{ "<signal_key>": { "state": "valid"\|"failed", "cap": "<能力标识>", "ver": <int>, "nv"?: <int>, "at": "<ISO UTC>", "code"?: "<失败码>", "detail"?: "<片段摘要>" } }`；文本类信号的条目由写入端保证带 `nv`（`text.normalize` 版本），数据库不检查 JSON 内部键 |
| `created_at` / `updated_at` | utc | |

CHECK：`JSON_TYPE(signals)='OBJECT'`；`hashtags IS NULL OR JSON_TYPE(hashtags)='ARRAY'`；**三态一致**——对三个文本信号各一条，用 MySQL 的空安全比较 `<=>`，使「信封缺条目」也得到确定的真 / 假而不是 NULL（CHECK 遇到 NULL 会放行）：`(title_normalized IS NOT NULL) = (JSON_UNQUOTE(JSON_EXTRACT(signals,'$."text.title_normalized".state')) <=> 'valid')`（`body_normalized`、`hashtags` 同理）。另加枚举约束（三个信号各一条）：`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(signals,'$."text.title_normalized".state')), 'valid') IN ('valid','failed')`，使信封里存在的条目状态只能是 `valid` / `failed`；平台没有该字段时**条目缺失、列为空**，读取时由平台字段表推出 `not_applicable`。`missing` / `stale` / `not_applicable` 不是存储态（SG-2）。

> **为什么值在列里、元数据在信封里**：0 档信号要能被 D 的第 1 层 SQL 直接 `LIKE` / `JSON_CONTAINS`（PRD C §3.2「可索引、可下推」），所以值是真列；PRD C §6.2 要求「每个信号自带版本与时间」，所以元数据按信号放信封。读取口把两者合成一个 `SignalValue`，调用方看不到这个分工。

#### `comment_features`

| 列 | 类型 | 说明 |
|---|---|---|
| `comment_id` | id PK | FK → `comments`（RESTRICT） |
| `text_material_sha256` | sha256 NOT NULL | `content_text` 的 SHA-256 |
| `text_normalized` | longtext NULL | |
| `signals` | json NOT NULL | 同上，仅 `comment.text_normalized` |
| `created_at` / `updated_at` | utc | |

CHECK：`JSON_TYPE(signals)='OBJECT'`；`(text_normalized IS NOT NULL) = (JSON_UNQUOTE(JSON_EXTRACT(signals,'$."comment.text_normalized".state')) <=> 'valid')`；`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(signals,'$."comment.text_normalized".state')), 'valid') IN ('valid','failed')`。

#### `signal_history`（被取代的旧值）

| 列 | 类型 | 说明 |
|---|---|---|
| `history_id` | id PK | |
| `subject_kind` | varchar(16) | `content` / `comment` |
| `subject_id` | id | 多态引用，不设外键（A 的主档不物理删除） |
| `subject_snapshot_id` | id NULL | 产出该值时所基于的内容快照 |
| `signal_key` | varchar(64) | |
| `state` | varchar(16) | `valid` / `failed` |
| `value` | json NULL | 归一化文本 / 话题数组（JSON 编码） |
| `capability_id` / `capability_version` | varchar(64) / int | |
| `normalizer_version` | int NULL | 文本类信号的 `nv`；非文本为空 |
| `produced_at` | utc | |
| `superseded_at` / `superseded_reason` | utc / varchar(32) | `material_changed` / `capability_upgraded` |
| `expires_at` | utc | §7.11 |

索引：`(subject_kind, subject_id, signal_key, superseded_at)`；`(expires_at)`。CHECK：`subject_kind IN ('content','comment')`；`state IN ('valid','failed')`；`superseded_reason IN ('material_changed','capability_upgraded')`；`capability_version > 0`；`normalizer_version IS NULL OR normalizer_version > 0`。

#### `signal_results`（派生信号的不可变结果行）

| 列 | 类型 | 说明 |
|---|---|---|
| `result_id` | id PK | |
| `signal_key` | varchar(64) | |
| `material_sha256` | sha256 | 素材指纹：图片 / 音频字节 |
| `param_sha256` | sha256 | 参数指纹；全局信号为 32 个零字节 |
| `capability_id` / `capability_version` | varchar(64) / int | |
| `state` | varchar(16) | `valid` / `failed` |
| `score` | decimal(4,2) NULL | 0.00–10.00，匹配分 |
| `value` | json NULL | ASR：`{text, language}`；判定：`{verdict, reason}` |
| `evidence` | json NOT NULL | §6.3；任何字段不得含签名 URL（写入前脱敏） |
| `failure_code` | varchar(64) NULL | |
| `lineage` | json NULL | `{plan_id, version, requested_by}`，仅血缘，不进复用键 |
| `produced_at` / `expires_at` / `created_at` | utc | |

唯一键 `uq_signal_results_key (signal_key, capability_id, material_sha256, param_sha256, capability_version)`（含能力标识，与 PRD 复用键四元组一致；信号键与能力标识一一对应、永不变更，由目录测试守护）；索引 `(expires_at)`。

CHECK：`state IN ('valid','failed')`；`capability_version > 0`；`score IS NULL OR (score >= 0 AND score <= 10)`；**形状**——`valid` ⇒ `failure_code IS NULL` 且 `(score IS NOT NULL) <> (value IS NOT NULL)`；`failed` ⇒ `failure_code IS NOT NULL AND score IS NULL AND value IS NULL`。

> 判定结果行必含结论、理由、模型版本、提示词版本：结论与理由在 `value`，模型与提示词版本在 `evidence`，写入前由 zod 校验（SG-6）；数据库层不检查 JSON 内部键。

#### `monitoring_segments`

| 列 | 类型 | 说明 |
|---|---|---|
| `plan_id` | id | D 分配的监控判定计划 ID，不透明，**无外键** |
| `version` | int | D 的计划版本 |
| `platform_code` | varchar(32) | `douyin` / `xiaohongshu` / `kuaishou` |
| `status` | varchar(16) | `draft` / `published` |
| `items` | json NOT NULL | §6.3 |
| `created_by_actor` | varchar(128) | |
| `published_at` | utc NULL | |
| `created_at` / `updated_at` | utc | |

主键 `(plan_id, version)`；CHECK：`status IN ('draft','published')`；`platform_code IN ('douyin','xiaohongshu','kuaishou')`；`(status='published') = (published_at IS NOT NULL)`；`JSON_TYPE(items)='ARRAY'`；`version > 0`。

#### `segment_images`

| 列 | 类型 | 说明 |
|---|---|---|
| `image_id` | id PK | |
| `plan_id` / `version` | id / int | 复合 FK → `monitoring_segments`（RESTRICT） |
| `kind` | varchar(16) | `template` / `element` |
| `target` | varchar(16) | `cover` / `background` / `avatar` |
| `element_key` | varchar(64) NOT NULL default `''` | 模板图为空串；元素图为业务标识，zod 限制 `[A-Za-z0-9_.-]{1,64}` 且不得为 `.` / `..`（它会进入 OSS 键，不能含 `/`） |
| `sha256` | sha256 | 原始字节指纹，即参数指纹 |
| `byte_length` / `width` / `height` / `mime` | | |
| `bucket` / `object_key` | varchar / varchar(512) ascii_bin | OSS 定位（§7.9 的键规则） |
| `created_by_actor` / `created_at` | | |

唯一键 `(plan_id, version, kind, target, element_key)`（同一计划版本、同一对象至多一张模板图，C-D01）；索引 `(sha256)`。CHECK：`kind IN ('template','element')`；`target IN ('cover','background','avatar')`；`(kind='template') = (element_key = '')`；`byte_length > 0`。

#### `signal_tasks`

| 列 | 类型 | 说明 |
|---|---|---|
| `task_id` | id PK | |
| `kind` | varchar(32) | `score_template` / `score_element` / `asr_text` / `asr_judgement` / `recompute_chunk` |
| `idempotency_key` | sha256 UNIQUE | `jcsSha256({v:'signal-task.v1', kind, 复用键 / 分块键})` |
| `params` | json NOT NULL | 见 §7.7～§7.10 |
| `status` | varchar(16) | `pending` / `running` / `retry_wait` / `succeeded` / `dead` |
| `priority` / `attempt_count` / `max_attempts` / `defer_count` | int | |
| `next_attempt_at` | utc NULL | |
| `lease_owner` / `lease_expires_at` / `fencing_token` | varchar(128) / utc / id | |
| `run_id` | id NULL | FK → `signal_recompute_runs` |
| `result_id` | id NULL | FK → `signal_results`，`ON DELETE SET NULL`（结果行按保留期清理，任务行可能比它活得久） |
| `last_error_code` / `last_error_detail` | varchar(128) / json | 详情写入前脱敏：URL 一律替换为 `<url>`（Python 的错误消息可能带签名 URL） |
| `created_at` / `updated_at` / `finished_at` / `expires_at` | utc | `expires_at` = 创建 + 1 年 |

索引：领取 `(status, next_attempt_at, priority, task_id)`；`(run_id)`；`(expires_at)`（清理）。CHECK：`kind IN ('score_template','score_element','asr_text','asr_judgement','recompute_chunk')`；`status IN ('pending','running','retry_wait','succeeded','dead')`；`status <> 'running' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)`；`attempt_count >= 0 AND attempt_count <= max_attempts`。

#### `signal_cursors`

`cursor_name varchar(64) PK`、`watermark_at utc`、`watermark_id id`、`updated_at utc`。取值：`content_scan`、`comment_scan`、`content_reconcile`。

#### `signal_recompute_runs`

| 列 | 类型 | 说明 |
|---|---|---|
| `run_id` | id PK | |
| `requested_by_actor` | varchar(128) | |
| `signal_key` | varchar(64) | |
| `scope` / `scope_sha256` | json / sha256 | 规范化后的范围 |
| `scope_count` | int | `apply` 时对范围展开得到的对象条数；数据不变时等于 `preview` 的条数，数据在两者之间变化时以 `apply` 时为准 |
| `from_version` | int NULL | 范围内对象所持该信号的**最低**能力版本（`apply` 时统计；范围内全无旧值则为空） |
| `to_version` | int | 目录当前版本 |
| `status` | varchar(16) | `running` / `completed` / `failed` / `cancelled`；CHECK |
| `active_key` | sha256 NULL | `running` 与 `failed` 时 = `jcsSha256({signal_key, to_version, scope})`，`completed` / `cancelled` 时置空；唯一键保证同一范围同一时刻至多一个未完成 run |
| `cursor_id` | id | 续跑游标（已处理到的主体 ID） |
| `processed_count` | int | |
| `started_at` / `finished_at` / `created_at` | utc | |

唯一键 `uq_recompute_active (active_key)`（MySQL 唯一键允许多个 NULL，所以已完成的 run 不阻止同范围再次执行）。`apply` 遇到同范围的 `running` / `failed` run 时**续跑原 run**（`failed` 置回 `running`）；永久失败的 run 用 `signals recompute cancel --run <id>` 放弃（置 `cancelled`、清 `active_key`），之后同范围可新建；遇到 `completed` 的同范围则新建 run，分块处理时跳过已经是目标版本的对象，因此范围内新进入的对象会被补上，旧对象不会重复处理。

### 6.2 对既有表的修改

只有一条（requirements R1）：`contents` 增加 `idx_contents_current_selected (current_snapshot_selected_at, content_id)`。在 `src/db/schema/content.ts` 的 `contents` 索引列表里加一行，由 `drizzle-kit generate` 生成迁移。

### 6.3 JSON 形状

**`monitoring_segments.items`**（zod 校验，条目按 `(signal, element_key)` 唯一）：

```ts
type Item =
  | { signal: 'text.title_normalized' | 'text.body_normalized' | 'text.hashtags'
              | 'comment.text_normalized' | 'content.asr_text' }
  | { signal: 'content.cover_template_score' | 'account.bg_template_score' | 'account.avatar_template_score' }
  | { signal: 'content.cover_element_score' | 'account.bg_element_score' | 'account.avatar_element_score'; element_key: string }
  | { signal: 'content.asr_judgement'; standard_text: string };   // 1..2000 字，至多一项
```

图片引用由信号键推出目标（封面 / 背景 / 头像）与种类（模板 / 元素），再按 `(kind, target, element_key)` 找 `segment_images` 行，所以条目里不存图片 ID。

**`signal_results.evidence`**：

| 信号 | 内容 |
|---|---|
| 匹配分 | `{ raw: {...Python 返回的原始度量}, preprocess: {width, height}, elapsed_ms, engine: {id, version}, source: {media_asset_id, segment_image_id} }` |
| ASR 文本 | `{ model, duration_ms, language, gateway_call_key }` |
| 判定 | `{ model, prompt_id, prompt_version, standard_sha256, transcript_result_id, gateway_call_key }` |
| 失败 | `{ failure_code, detail?（不含 URL、不含原文）}` |

### 6.4 状态与枚举

| 枚举 | 取值 | 守护 |
|---|---|---|
| 存储态 | `valid` / `failed` | CHECK |
| 读取态 | `valid` / `stale` / `failed` / `missing` / `not_applicable` | TypeScript 联合类型 |
| 监控段状态 | `draft` / `published` | CHECK |
| 任务状态 | `pending` / `running` / `retry_wait` / `succeeded` / `dead` | CHECK |
| 任务种类 | 见 `signal_tasks.kind` | CHECK |
| 失败码（写入 `failed` 行或信封的确定性失败） | `image_unreadable`、`audio_unreadable`、`model_refused`、`invalid_output`、`text_parse_error` | 代码常量 |
| 任务终态原因（`dead`，不写结果行） | `retries_exhausted`、`reference_unreadable`、`dependency_timeout`、`invalid_request`、`run_cancelled`、`run_not_running` | 代码常量 |
| `missing` 原因 | `not_computed`、`no_profile_snapshot`、`media_pending`、`media_failed`、`media_carried_forward`、`audio_not_archived`、`capability_disabled`、`compute_dead`、`failed_under_old_version` | 代码常量 |
| `not_applicable` 原因 | `platform_unsupported`、`field_absent_on_platform`、`no_reference` | 代码常量 |

## 7. Algorithms

### 7.1 文本归一化 `text.normalize@1`

```text
normalizeText(s):
  1. 删除：U+200B–U+200F、U+202A–U+202E、U+2060–U+206F、U+FEFF，以及除 \t \n \r 外的 C0/C1 控制字符
  2. s = s.normalize('NFKC')                         // 全角→半角，兼容字符折叠
  3. s = s.toLowerCase()
  4. 。→ .   、→ ,                                    // NFKC 不处理的两个 CJK 标点；其余 CJK 标点保持原样
  5. 连续空白（含换行、制表）折叠为一个空格，去首尾
```

> **2026-11-12 任务 3 订正步骤顺序**：原稿把「删除不可见字符」放在 NFKC 与小写之后。固定种子的随机串幂等测试给出反例：零宽字符把字符与组合符号隔开时，删除后二者才相邻，第二次归一化才组合（`I\u200B\u0308` 第一次得 `i` + U+0308，第二次得 `ï`），`f(f(x)) ≠ f(x)`。先删再 NFKC 后幂等成立。v1 尚无任何已存储数据，所以直接订正 v1，不升版本。

- emoji 保留（PRD C §4.2）；
- `normalizeKeyword(s)` 与 `normalizeText(s)` **是同一个函数**。D **保存关键词原文、执行时归一化**（§1.4 第 5 项）。
- **归一化实现按版本保留**：`NORMALIZERS: Record<number, (s: string) => string>`，升级只新增、不删除旧实现（一个测试断言每个已存储版本都在表里）。文本类信号的信封记录写入时所用的 `nv`，`SignalValue.normalizerVersion` 把它交给 D，D 调用 `normalizeKeyword(raw, value.normalizerVersion)`，使 `stale` 的旧文本与关键词在同一版本下比较；
- **`stale` 也看归一化版本**：文本类信号的有效值在 `nv` 低于当前 `text.normalize` 版本时读作 `stale`，即使其自身能力标识（如 `text.hashtags.douyin`）的版本没变。话题解析器依赖归一化实现，只升归一化、不升解析器时，同一份输入的话题值也会变；只看解析器版本会把旧话题值误当 current（SG-D19）；
- 版本号 `text.normalize` 当前为 1；任何一步的改动都升版；
- 标点方向见 requirements R6：NFKC 的结果是 ASCII 标点。**子串匹配**对称，不受方向影响；**`text.regex`** 不对称——正则里写的中文标点匹配不到归一化后的 ASCII 标点，D 的正则规则必须按归一化后的形态书写（§14 第 4 项）。

### 7.2 话题解析 `text.hashtags@1`（按平台变体）

对 `title`、`body`、`tag_text` 三段文本分别做：

```text
先按 normalizeText 处理（全角＃→#）
令牌 = 正则 /#([^#\s\[\]]+)(?:\[话题\]#?)?/g 的捕获组（收尾的 # 只属于 [话题]；原稿的 `#?` 会吃掉 `#a#b` 里第二个话题的 #，与下面样本表矛盾，任务 3 订正）
对每个令牌：去首尾空白与首尾标点，空串丢弃，长度 > 64 字符丢弃
合并三段结果，按首次出现顺序去重，最多保留 50 个（50 与 64 是本 spec 的建议值，待确认，§14 第 17 项）
```

样本核对（`fixture`）：

| 输入 | 结果 |
|---|---|
| `#日立中央空调 #全效Ⅱ三管制 #全屋全感3` | 三个话题（`全效ⅱ三管制` 被 NFKC 折叠，Ⅱ → ii，**这是预期**，查询侧也走同一函数） |
| `#一键节能更省心#金秋焕新首选` | 两个话题（`#` 相连） |
| `#来拍照了[话题]#` | `来拍照了` |
| 标题含 `#日立智墅全感水系统 构建集空调…` | `日立智墅全感水系统`（话题到空白为止） |

- 抖音与小红书各一个解析变体（`text.hashtags.douyin@1`、`text.hashtags.xiaohongshu@1`、`text.hashtags.kuaishou@1`），1.0 三者初始实现相同，**分开是为了让将来的平台差异不必升全平台版本**（C-D12）；能力标识含平台；
- 解析器抛错 → 该信号 `failed`，`detail` 保存出错片段的前 200 字符的 SHA-256 前缀与长度，不保存原文；
- `PLATFORM_TEXT_FIELDS`（任务 3 以 `tests/fixtures/aimaster` 的列表响应逐平台核对，结论写在 `text/fields.ts`，由 `fields.test.ts` 守护）：标题三个平台都返回（抖音 40/40、小红书 42/42、快手 63/63，快手 15 条为空串）；正文 `text.content`：抖音 1/40（字段存在，多数条目没有）、小红书 37/42、**快手 0/63（键从未出现）**。所以 `kuaishou: {title: true, body: false}`，`text.body_normalized` 对快手读作 `not_applicable(field_absent_on_platform)`，目录里该信号的可得平台不含快手。`ponytail:` 依据是 3 份快手列表 fixture 共 63 条；若真实环境出现快手正文，改 `fields.ts` 并升 `text.normalize` 版本（§14 第 6 项已关闭）。

### 7.3 扫描驱动与对账

```text
runScan(deps):                                  // 每 tick 一次
  cur  = signal_cursors['content_scan'] ?? (epoch, 0)
  rows = SELECT content_id, current_snapshot_id, current_snapshot_selected_at
         FROM contents
         WHERE current_snapshot_id IS NOT NULL
           AND (current_snapshot_selected_at, content_id) > (cur.at, cur.id)
         ORDER BY current_snapshot_selected_at, content_id LIMIT :batch
  late = SELECT … FROM contents c LEFT JOIN content_features f USING (content_id)
         WHERE c.current_snapshot_selected_at > cur.at - :lookback
           AND c.current_snapshot_selected_at <= cur.at
           AND (f.content_id IS NULL OR f.content_snapshot_id <> c.current_snapshot_id)
         LIMIT :batch
  for each in rows ∪ late: ingestContent(...)
  游标 = rows 最后一行 (selected_at, content_id)；rows 为空则不动
```

- **为什么要「迟到」查询**：`current_snapshot_selected_at` 取的是语句执行时刻，提交可能更晚；游标可能已越过一个尚未提交的更早时间戳（`ponytail:` 回看窗口内的事务才会被补上；上限 = 窗口长度。窗口外的由对账兜底）；
- **对账**：每小时按 `content_id` 分页（游标 `content_reconcile`），找 `current_snapshot_id IS NOT NULL` 且特征行缺失或所指快照不是 current 的内容，补处理。一圈跑完游标归零。对账也是首次部署时对存量内容的回填路径（游标为 epoch 时 `rows` 查询本身就会从头扫完存量）；
- `ingestContent` 的输入是 `facts.contentFacts` 批量取回的 `{contentId, platform, snapshotId, batchOrder, title, body, tagText}`；评论扫描同理（`comment_scan`，按 `(last_seen_at, comment_id)`，`status='active'`）；
- 批量默认 500、tick 间隔 30 秒、回看窗口 10 分钟（均为配置，§14 第 14 项）；
- **事务边界**：计算是纯函数，在事务之外；事务只做「锁特征行 → 排序检查 → 写历史 → 更新」，不做任何 IO。

### 7.4 特征行写入 `ingestContent`

```text
ingestContent(f, mode='normal'):
  m = jcsSha256({ platform, title: textState(f.title), body: textState(f.body), tag_text: textState(f.tagText) })
        // textState: NULL → {s:'null'}；否则 {s:'text', v: 原文}
  tx:
    row = SELECT … FROM content_features WHERE content_id = :id FOR UPDATE
    if row 存在 and mode='normal' and not isNewer(f.batchOrder, row.batchOrder): return 'skipped_older'
    if row 存在 and mode='recompute' and isOlder(f.batchOrder, row.batchOrder): return 'skipped_older'
    if row 存在 and row.text_material_sha256 == m and mode='normal':
        UPDATE content_features SET content_snapshot_id = :snap, updated_at = :now      // 素材未变：只前移所持快照
        return 'advanced'
    new = compute(f)                                  // mode='recompute' 时即使素材未变也重算；某信号抛错 → 该信号 failed
    reason = mode='recompute' ? 'capability_upgraded' : 'material_changed'
    if row 存在:
        for 每个旧信封条目 k：INSERT signal_history(value=旧值, cap/ver=旧条目, normalizer_version=旧条目.nv, reason=reason, expires_at=…)
    UPSERT content_features(…)
    return row ? 'updated' : 'created'
```

- `row.batchOrder` 经 `content_snapshots → sync_batches` 取 `(logical_at, batch_id)`；`isNewer` 直接复用 `projection/current.ts` 的导出；
- **素材未变但版本落后**：正常扫描不重算（「不主动重算历史」）。信号保持旧版本，读作 `stale`，由显式重算处理（§7.10）；
- **`mode='recompute'` 强制重算**：跳过「素材指纹相同」的短路，即使素材未变也用当前版本重算；历史原因记 `capability_upgraded`（重算触发，不是素材变化）。`ingestComment` 同口径（评论没有快照 / 批次，只有素材指纹与 `nv`）；
- **批次比较**：`mode='normal'` 用 `isNewer`（相同批次也跳过，保证重复扫描无写入）；`mode='recompute'` 用 `isOlder`（只拒绝严格更旧的批次，允许当前批次重算，否则当前 `stale` 信号会被 `skipped_older` 挡住）；
- 素材变了：三个文本信号一并用当前版本重算（它们共享素材指纹）；
- 每次 `compute` 对每个信号独立 try/catch，互不影响（SG-3 失败隔离）。

### 7.5 素材指纹与参数指纹

| 对象 | 素材指纹 | 来源 |
|---|---|---|
| 内容文本 | `jcsSha256({platform, title, body, tag_text})`（含值状态） | `content_snapshots` |
| 评论文本 | `jcsSha256({ text: textState(content_text) })`（与内容文本同一 `textState`：`NULL` 与空串指纹不同） | `comments` |
| 图片（封面 / 头像 / 背景） | 原图 `media_assets.sha256`（`BINARY(32)`） | `media_references.role ∈ {cover, avatar, background}` |
| 音频 | 音频 `media_assets.sha256` | `media_references.role = 'audio'` |

| 信号 | 参数指纹 |
|---|---|
| 模板 / 元素匹配 | `segment_images.sha256` |
| `content.asr_text`、全局信号 | 32 个零字节 |
| `content.asr_judgement` | `jcsSha256({ standard_text: normalizeText(标准文本), prompt_version, model_version })` |

- 图片素材用**原图**字节而不是 `*_normalized` 衍生图：衍生图依赖归一化版本且不是对所有引用都有，原图是 A 的稳定身份；预处理由 Python 在匹配时完成，预处理变化算能力升级；
- 抖音封面是 HEIC（ADR-0012）：Python 的解码复用 `/v1/image/normalize` 同一函数，所以匹配端点能直接吃原图。

### 7.6 五态合成 `composeState`

输入是已经取好的事实，输出 `SignalValue`。**判断顺序固定**：

```text
1. 目录：key 未注册 → 抛 signal_unregistered
2. 平台：平台的列表 / 详情没有该文本字段（PLATFORM_TEXT_FIELDS，如快手正文）→ not_applicable(field_absent_on_platform)；对象平台不在 entry.platforms → not_applicable(platform_unsupported)。前者先判：目录里该信号的可得平台已排除这个平台，后判会把它误报成 platform_unsupported（任务 5 订正）
3. 输入适用性：
     文本：PLATFORM_TEXT_FIELDS 无该字段 → not_applicable(field_absent_on_platform)
     图片：内容主体取该内容全部快照上的 cover 引用（requirements R12，2026-11-12 修订，原为「取其 current 快照的引用」）：
           优先批次最新的 archived 引用；无 archived 则取批次最新的引用按状态映射；一条都没有 → not_applicable(no_reference)
           账号主体尚无 current_profile_snapshot_id → missing(no_profile_snapshot)；有快照但无对应引用行 → not_applicable(no_reference)
     评论：content_text 为 NULL 与空串都按「平台有该字段」读作 valid 的空值（指纹区分二者）
4. 已存储的最高版本行 R（特征行信封条目 / 结果行）：
     文本类：当前 = R.ver == 当前能力版本 and R.nv == 当前 text.normalize 版本
     非文本类：当前 = R.ver == 当前能力版本
     R.state='valid'  and 当前     → valid
     R.state='valid'  and not 当前 → stale（usable 由 stalePolicy 决定）
     R.state='failed' and 当前     → failed
     R.state='failed' and not 当前 → missing(failed_under_old_version)
5. 没有 R：
     图片引用 pending / failed / carried_forward → missing(media_*)
     音频无 archived 引用                          → missing(audio_not_archived)
     能力未启用（含网关 activeModel 为 null）        → missing(capability_disabled)
     有活动任务 → missing(not_computed) + pending: queued|running
     有 dead 任务 → missing(compute_dead) + pending: dead
     否则 → missing(not_computed)
```

- 第 3、4 步在能力被关闭后**仍然生效**：读取已存储的值不受启用开关影响，开关只阻止「新计算」；
- 文本类信号的「当前」同时看 `R.nv`：只升 `text.normalize`、不升话题解析器版本时，话题信号也读作 `stale`；`nv` 缺失（正常写入不会出现）按 `stale` 处理并记告警；
- 解码失败 / 字节读不到属于确定性失败，由任务写 `failed` 结果行（第 4 步命中）；
- `readMany`：按种类分组，每组一次集合查询（`WHERE content_id IN (…)`、`material_sha256 IN (…) AND param_sha256 = ?`、活动任务 `idempotency_key IN (…)`），查询次数与主体数无关。

### 7.7 `requestScores` 与「缺失」的定义

```text
requestScores(segmentRef, subjects, ctx):
  seg = segments.load(segmentRef)                       // 草稿或已发布均可
  assert executability(seg) 可执行，否则拒绝 not_executable
  for 每个 item ∈ seg.items 中需要计算的信号（模板 / 元素 / `content.asr_text` / `content.asr_judgement`），对每个 subject：
      m = material(subject, item)                       // ready | not_applicable | missing(原因)
      if m != ready: 记录处置，continue
      R = 结果行最高版本(item.signal, m.sha, param(item))
      缺失 = R 不存在 或 (R.ver < 当前 and R.state = 'failed')
      // R.state='valid' and R.ver < 当前：stale，不补算
      // R.state='failed' and R.ver == 当前：确定性失败，不重试
      if 缺失: enqueue(idempotency = jcsSha256(复用键))
               // 已有活动任务 → 复用；dead → 置回 pending、attempt_count 清零；
               // succeeded 但 result_id 为空或结果行已被清理 → 同样置回 pending（任务比结果活得久，不能让旧任务挡住重新补算）
      else   : 处置 = reused
  返回 { items: […], needMedia: [subject…] }
```

- 主体 ≤ 5,000 一次；超过由调用方分批；`content.asr_text` 的参数指纹为零，素材是音频；它与判定共用同一套 `activeModel` 门控；
- 付费边界：模板 / 元素匹配免费；ASR 与判定任务只在 `activeModel()` 非空时才建，计费由网关负责；
- `needMedia` 列出素材为 `pending`、`failed`、`carried_forward` 或没有 `archived` 音频的主体：它们都是「本轮没有新的 verified 素材」，D 可据此向 A 提采集需求（C 自己不提）；
- 任务 `params`：`{ signal_key, material_sha256, param_sha256, source: {media_asset_id}, segment_image_id?, standard_text?, prompt_version?, model_version?, lineage: {plan_id, version, requested_by}, caller: {actor, scope_fingerprint} }`。

### 7.8 匹配端点与分数映射

**Node 侧 runner**：

```text
runScoreTask(ctx):
  params → `facts.mediaObjectOf(assetId)` 得候选 object key；查 segment_images 得标准图 key
  candidateUrl = mediaStore.signedGetUrl(key, ttl)；referenceUrl = signalsStore.signedGetUrl(key, ttl)
  res = await matcher.match({ referenceUrl, candidateUrl, mode, maxBytes })    // 事务外
  校验 res.capability.id/version == 目录当前值，不一致 → 瞬时失败
  fenced tx: INSERT signal_results … ON DUPLICATE KEY（命中即视为成功）；task → succeeded
```

**Python `POST /v1/image/match`**：

```json
// 请求
{ "reference_url": "…", "candidate_url": "…", "mode": "template" | "element", "max_bytes": 20971520 }
// 200 响应
{ "score": 8.30,
  "capability": { "id": "image.template", "version": 1 },
  "evidence": { "keypoints_reference": 812, "keypoints_candidate": 790, "good_matches": 321,
                "inliers": 280, "inlier_ratio": 0.35, "low_features": false,
                "preprocess": { "width": 540 }, "elapsed_ms": 74 } }
// 错误：JSON { code, message, side? }
```

| 错误码 | HTTP | Node 侧归类 |
|---|---|---|
| `invalid_request` | 400 | 终态（代码缺陷），任务 `dead` |
| `input_too_large` | 413 | `side=candidate`：确定性失败；`side=reference`：`dead` |
| `unsupported_media_type` / `convert_failed` | 415 / 422 | `side=candidate`：写 `failed(image_unreadable)`；`side=reference`：任务 `dead`（配置错误，标准图上传时已校验过，不该出现） |
| `source_missing`（来源返回 404） | 422，带 `side` | `side=candidate`：确定性失败，写 `failed(image_unreadable)`（A 的媒资行说已归档，对象却不在）；`side=reference`：任务 `dead(reference_unreadable)` |
| `source_unavailable`（连接失败、超时、来源 5xx） | 502 | 瞬时，重试 |
| 5xx / 超时 / 连接失败 | — | 瞬时，重试 |

**算法**（`image.template@1`，`image.element@1`）：

```text
1. 下载两张图（限 max_bytes），用 image.py 的解码转 540 宽灰度图（HEIC 经 ffmpeg）
2. SIFT（最多 1500 个特征点）；任一边 < 8 个点 → score 0.0，evidence.low_features = true
3. BFMatcher kNN(k=2) + 比率检验 0.75 → good_matches；< 4 条 → score 0.0
4. findHomography(RANSAC, 5.0px) → inliers
5. template: r = inliers / min(kp_ref, kp_cand);  score = 10 · clamp(r / R_FULL, 0, 1)
   element : 单应矩阵须非退化（把参考图四角变换后是凸四边形、面积比在 [0.02, 1.5]）；
             score = 10 · clamp((inliers − 4) / (I_FULL − 4), 0, 1)
6. score 四舍五入到两位小数
```

- `R_FULL`（初值 0.30）、`I_FULL`（初值 25）、特征点上限、比率阈值是**标定参数**，初值只为让合成图测试的排序成立；真实样本标定后写入代码并说明依据；**已上线后改任何一个都升能力版本**（§14 第 7 项）；
- **不做 pHash 预筛**（requirements R5）。`ponytail:` 日调用量估算 < 1,000 次（PRD C §2.3：约 22 万次 / 年），SIFT 在 540 宽图上单次约百毫秒量级；若日调用上到十万量级，再加预筛并升版本；
- 能力服务单进程，评分任务并发由配置限制（起始值 2），避免占满 CPU（测试机上先实测，再在 compose 设上限，ADR-0012「后果」）；
- 响应头 `X-Capability-Version` 仍是**服务版本**（现状 `0.1.0`），Node 不用它做校验；校验的是 JSON 里 `capability.{id,version}`，它是 Python 端的 per-capability 常量；Node 校验与目录一致，防止「Node 升了目录、Python 还是旧镜像」。

### 7.9 标准图存储与监控段操作

- **OSS 键**：`segments/{planId}/{version}/{target}/{kind}{-elementKey 或空}/{sha256 十六进制}`（含计划 ID、版本、图像对象、图片 SHA-256，C-D02）；
- `putImage`：`assert` → 读监控段（必须 `draft`）→ 校验平台 / 目标 / 大小 → `sniffImage` + `ImageConverter.toNormalizedJpeg` 验证可解码 → `signalsStore.put` 并回读校验大小 → **事务**：同 `(kind, target, element_key)` 旧行先删后插 → 提交后删除旧对象（事务外，失败只记录，由 `purge` 的前缀清扫兜底）；
- 事务失败：删除刚上传的对象（尽力而为）。`ponytail:` 进程在「上传之后、事务之前」崩溃会留下孤儿对象（至多 10 MiB / 个）；`purge` 按前缀 `segments/{planId}/` 列举删除时会一并清掉，不另建扫描器；
- `newDraft`：复制 `items`，对每张图 `get` 字节 → 在新版本的键下 `put` → 插行；
- `publish`：事务内再次校验 `executability`，通过则置 `published`；
- `executability(ref)` 的阻塞项：目录外信号、平台不可得、能力未启用、`content.asr_text` 的 `activeModel('asr')` 为 `null`、`content.asr_judgement` 的 `activeModel('asr')` 或 `activeModel('judge')` 为 `null`、条目引用的图片行不存在、`asr_judgement` 超过一个；
- `purge(planId)`：列举 `segments/{planId}/` 前缀逐个删除（事务外）→ 删 `segment_images` 行 → 删 `monitoring_segments` 行。任一步失败都可重试，已不存在的对象视为成功。

### 7.10 显式重算

```text
preview(actor, {signal, scope}) → { count }               // 只读
apply  (actor, {signal, scope}) →
  assert rule.definition.manage；scope 必填且展开非空
  tx: 同范围已有 running/failed 的 run（active_key 命中）→ 续跑它（failed 置回 running，并在 cursor_id 处复活/新建 chunk）；否则 INSERT signal_recompute_runs；INSERT 第一个 recompute_chunk 任务
chunk 任务（params: {run_id, after_id, limit}）:
  run = load；run.status == 'cancelled' → 任务置 dead(run_cancelled)，不处理
                      run.status != 'running' → 任务置 dead(run_not_running)，不处理（failed/completed 由 apply 重新入队或复活）
  subjects = facts.scopeSubjects(scope, signalKey, after_id, limit)     // 按主体 ID 升序；content / account / comment 的展开差异由 signalKey 决定
  特征类信号：对每个主体 ingest(mode='recompute')：即使素材指纹未变也用当前版本重算；旧值进历史（reason='capability_upgraded'）；评论类信号按内容范围展开到其评论，逐条 ingestComment(mode='recompute')
  结果类信号：对每个主体解析素材 → 对 run 记录的参数集合建新版本的评分任务
  tx: 重读 run.status；仍为 running 才 run.processed_count += n、run.cursor_id = 本块最后主体 ID、建下一个 chunk 或置 completed；
      已 cancelled / failed 则只提交本块已处理的结果，不建下一个 chunk
```

- **范围**：`contentIds` / `accountIds` / `brandId` / `publishedFrom–To`，可组合取交集；至少一项（§1.4 第 13 项）；`segmentRef` 是可选附加键，写入 `scope` 与 `scope_sha256` 并参与校验，不能单独作为范围。`brandId` 经**当前**归属（`staff_account_assignments` → 门店 → 品牌）展开，必须在操作者品牌范围内；
- 重算的参数集合：结果类信号重算需要知道「对哪些标准图」：run 的 `scope` 里可带 `segmentRef`；没带时，对范围内主体已有的所有（素材 × 参数）旧版本结果行各建一个新版本任务；
- 评论类特征信号没有独立 scope 种类：按内容范围展开出的内容取其 active 的全部评论；scope 只影响展开，不改变信号；`publishedFrom–To` 比较的是**内容 current 快照的 `published_at`**（区间 `[from, to)`），评论信号同样如此，不看评论自己的创建时间；账号类信号不支持 `publishedFrom–To` 与 `contentIds`（`scope_not_applicable`）；
- 重算不改监控段、不升计划版本、不触发 D；分块使崩溃后续跑成立（任务有租约），`processed_count` 随分块事务推进。
- **续跑 failed run**：`apply` 把 `cursor_id` 处的 chunk 任务（若 `dead`）置回 `pending` 并清零 `attempt_count`；分块键含 `run_id + after_id`，不会与其它 run 冲突。
- **取消**：`cancel(actor, {runId})` 先 `assert rule.definition.manage`；只接受 `running` / `failed`，置 `cancelled`、`active_key = NULL`、写 `finished_at`，审计 `recompute.cancel`；把该 run 的 `pending` / `retry_wait` chunk 任务置 `dead`（`last_error_code='run_cancelled'`），`tasks revive` 拒绝复活这些任务。正在执行的 chunk 不强行中断，在提交前重读 run 状态，看到 `cancelled` 就不再建下一个 chunk，本块已写入的对象不回滚（幂等；新 run 会跳过已是目标版本的对象）。已 `completed` / `cancelled` 的 run 调用 cancel 被拒绝（`run_not_cancellable`）。
- **`tasks revive` 口径**：普通任务可复活；`run_cancelled` 与指向 `completed` run 的 chunk 拒绝；`failed` run 的 chunk 由 `apply` 复活，不直接 `revive`。

### 7.11 保留期与清理

- 写入时：成功结果 `expires_at = produced_at + 1 年`；失败结果 `produced_at + 3 个月`；历史行 `expires_at = superseded_at + 1 年`；
- `retainUntil(resultIds, until)`：`UPDATE signal_results SET expires_at = GREATEST(expires_at, :until)`，只接受结果行 ID（D 从 `SignalValue.resultId` 拿到）。D 在保存判定证据时调用，`until` = 引用时刻 + 3 个月。**历史行不需要调用**：特征行的旧值在被取代时才进历史表，`expires_at` = 取代时刻 + 1 年，而取代必然晚于 D **读取**它的时刻（「引用时刻」指读取，不是保存证据的时刻），所以只要 D 在读取后一年内保存证据，1 年就覆盖 3 个月申诉期；D 的读取与证据保存在同一次执行内，远小于一年；
- 清理器（每日）：`DELETE FROM signal_results WHERE expires_at < :now ORDER BY expires_at LIMIT 1000`，循环到无行；历史表同理；任务表按 `expires_at`；
- 清理不入队、不重算；清理后读取得 `missing`；
- 特征行不清理：它是对象的当前值，随对象存在。

## 8. Failure semantics

| 场景 | 行为 |
|---|---|
| 某文本信号解析抛错 | 该信号 `failed`；其余信号与特征行照常写入；内容事实不受影响 |
| 扫描中途进程退出 | 游标只在批处理成功后推进；重启后重做同一批，`ingestContent` 幂等 |
| 旧批次迟到 | `skipped_older`，特征行不变 |
| 素材 `pending` / `failed` / `carried_forward` | 不建任务；`missing` + 原因；列入 `needMedia` |
| 候选图字节读不到（OSS 缺失）/ 解码失败 | 写 `failed(image_unreadable)`（3 个月）；不重试 |
| 能力服务不可用、超时、来源 5xx 或连接失败 | 瞬时：退避重试至 `max_attempts` → `dead`，**不写结果行** |
| 回报的能力版本与目录不一致 | 瞬时：同上 |
| 标准图（reference 侧）无法读取 / 解码 | 任务 `dead`（配置错误），告警事件；不污染候选对象的结果 |
| `ASR` / 判定网关瞬时错误 | 重试，沿用同一 `callKey`；用尽 → `dead` |
| 网关拒绝 / 输出不符合 schema | 写 `failed(model_refused` / `invalid_output)`；**不写成 `not_meets`** |
| 判定任务发现 ASR 结果缺失 | `deferred`：确保 ASR 任务存在，30 秒后重试，不计 `attempt_count`；累计 20 次仍无结果 → `dead(dependency_timeout)` |
| 结果行唯一键冲突 | 视为命中，任务置 `succeeded`；不是错误 |
| 任务 `succeeded` 但结果行已被保留期清理 | `requestScores` 把它置回 `pending` 重新补算；读取在补算前读作 `missing(not_computed)` |
| 候选图在 OSS 缺失（来源 404） | 写 `failed(image_unreadable)`，不重试；与 502（瞬时）区分 |
| 陈旧 worker 写结果 | fencing 校验失败，零写入，任务不被改动 |
| `putImage` OSS 成功、事务失败 | 尽力删除对象；失败则留给 `purge` 前缀清扫 |
| `purge` 删对象失败 | 保留数据库行；下次调用重试；已不存在视为成功 |
| 清理器中途退出 | 分块删除，幂等 |
| 授权失败 | 读库之前拒绝；越范围对象表现为未找到 |

**不吞错**：任何路径都不把瞬时失败写成 `failed` 结果，不把 `failed` 写成 0 分或空数组，不把 `capability_disabled` 当成不达标。

## 9. Authorization seam

```ts
interface SignalActor {
  actor: string;                                   // 审计主体，如 service:signals-worker / user:12
  capabilities: ReadonlySet<string>;
  brandScope: ReadonlySet<string> | "all";         // 品牌编码；仅用于重算范围展开
}
```

- `assert(actor, capability, resource?)`：先 Capability，再品牌范围，两步先于任何读库；沿用 `a-activity-plan/authz.ts` 的结构；
- 对应关系（requirements SG-14）：监控段写 / 上传 / 重算 = `rule.definition.manage`；`requestScores` = `rule.run.execute`；读取口 = `rule.definition.read`；CLI `show` = `data.content.read` / `data.account.read`；
- C 不判断监控判定计划的品牌归属（计划 ID 不透明）。D 在调用前判定用户能否操作该计划；C 在 D 的服务身份上校验 Capability；
- B 落地后（已合并，适配器随 D 的 spec 接入）：`SignalActor` 由会话经适配器构造，`assert` 退化为对 B `authorize` 的薄封装，调用方不变；
- 扫描器、清理器、worker 使用 `service:signals-worker`，不经用户范围；
- CLI 身份来自环境变量，缺任一项启动失败：`HBECHO_SIG_ACTOR`、`HBECHO_SIG_CAPABILITIES`、`HBECHO_SIG_BRAND_SCOPE`（`all` 或品牌编码，逗号分隔；不缺省为全部）。

### CLI 命令

```text
signals catalog [--object content|account|comment] [--platform douyin|xiaohongshu|kuaishou]
signals show --content <id> | --account <id> | --comment <id>        # 五态 + 证据（不含原文）
signals segment create | put-image | remove-image | set-items | publish | new-draft | show | check | purge
signals score --plan <id> --version <n> (--contents <文件|id,id> | --accounts <…>)     # 即 requestScores
signals recompute preview | apply --signal <key> --scope '<json>'
signals recompute cancel --run <id>
signals scan --once | reconcile --once | retention --once
signals tasks list [--status dead] | revive <taskId>
signals run                                                             # 常驻：扫描 + 任务 + 清理
```

输出 JSON；BIGINT 十进制字符串；退出码沿用 `plan-cli` 约定（0 / 2 校验或授权 / 3 冲突 / 4 不存在 / 1 其他）；`parseArgs` strict；没有 `--force`、`--skip-auth`、`recompute --all`。

## 10. 对既有代码与依赖的改动

| 位置 | 改动 | 类型 |
|---|---|---|
| `src/db/schema/content.ts` | `contents` 增加 `idx_contents_current_selected` | 只增索引 |
| `src/db/schema/index.ts` | `export * from "./signals"` | 导出 |
| `drizzle/NNNN_*.sql` | 新表与索引的迁移；**编号取实施时的下一个空号**（`a-activity-plan`、`g-learning-min` 各自在途，不预占） | 新增 |
| `services/capability/capability/match.py`、`app.py`、`tests/test_match.py` | 新端点；响应头 `X-Capability-Version` 保持服务版本，JSON 错误体沿用 | 新增 |
| `services/capability/pyproject.toml`、`services/capability/README.md` | 增加 `opencv-python-headless`（numpy 传递依赖）；README 端点表增加 `/v1/image/match` | 依赖 + 文档，ADR-0012 补记 |
| `package.json` | `"signals": "tsx src/worker/signals-main.ts"` | 脚本 |
| `.env.example` | 新增变量名（无值）：`OSS_BUCKET_SIGNALS`、`HBECHO_SIGNALS_*` | 配置 |
| `src/acceptance-boundaries.test.ts` | 四条静态护栏 + 反向用例 | 测试 |
| ADR-0001、ADR-0012、`server-operations-runbook.md`（桶清单） | 增补（任务 0 写 ADR 与 runbook 的计划条目；桶真正创建时再回填 runbook） | 文档 |
| `CONTEXT.md` | 增 Signal、MonitoringSegment 两条词汇（任务 0） | 文档 |

- 无新的 Node 依赖：HTTP 用内置 `fetch`，JSON 校验用已有的 `zod`，OSS 用已有的 ali-oss 封装；
- 不改 `orchestrator`、`sync-runner`、`media-archive`、`demand`、`projection`；
- 静态护栏的扫描范围是 `src/modules/signals/**` 的非测试文件（排除 `facts.ts` 对 A schema 的只读 import，该文件在白名单内）。

## 11. Testing strategy

| 层 | 内容 |
|---|---|
| `unit`（纯函数） | `normalizeText` 逐规则；话题解析（§7.2 样本表逐行 + 失败注入）；`composeState` 表驱动（§7.6 每个分支至少一例）；素材 / 参数指纹稳定性与区分度；提示词模板渲染；判定输出 zod；`ScopeResolver` 范围校验；`executability`；`requestScores` 规划（给定事实输出处置） |
| `db`（真实 MySQL） | 全部 CHECK 与唯一键；特征行 CAS（新批次覆盖 / 旧批次迟到跳过 / 素材未变只前移 / 素材变化写历史）；扫描器（游标、回看、迟到提交、对账、崩溃重做）；结果行并发写；任务租约 / fencing / 陈旧 worker；监控段状态机与 `purge`（`FakeObjectStore` 故障注入：`put` 失败、`delete` 失败、`corrupt`）；重算分块续跑；清理器（`FakeClock`）；读取口查询计数 |
| 能力服务契约 | Node `HttpImageMatcher` 对 fake `fetch`：每个错误码的归类；版本不一致；超时。Python 侧 pytest：合成纹理图（固定随机种子，程序生成，无二进制 fixture）验证排序与区间（SG-8 验收），覆盖 `side` 字段与低特征 |
| 契约（面向 D / H） | fake D 调用 `segments` → `requestScores` → `readMany` 轮询的完整序列；`AiGatewayPort` 的 fake：计费计数器、`callKey` 去重、`activeModel` 变化；`retainUntil` 语义 |
| 静态 | 四条护栏（SG-16）；`drizzle-kit generate` 无新文件 |
| 离线 | `network-deny` 沿用；`FakeObjectStore`、`FakeClock`、fake 能力服务、fake 网关 |

- 竞争用例（结果行并发写、两个 worker 抢任务）不用 `Promise.all`：先让持锁者停在 hook，再启动竞争者，最后放行（沿用 `a-activity-plan` design §11 的做法）；
- 每个 db 测试前 `resetData`；`tests/harness` 补 `insertFeature`、`insertSegment`、`FakeAiGateway`、`FakeMatcher`；
- **规模演练**（任务 13）：20 万内容的扫描吞吐；`readMany` 5,000 主体的耗时与查询次数；1 万个评分任务（fake 匹配器）的领取吞吐；记录进 §12.1；
- 合成图测试断言排序与区间，**不断言具体分值**，所以标定参数变化不会让测试失效；真实样本标定报告是独立的人工产物（acceptance MAN-2）。

## 12. Explicit non-goals and known limits

- 没有页面；证据下钻靠 CLI `signals show`；
- 没有 H1：第 3 层只在 fake 网关上证明，生产默认 disabled；
- 匹配分映射未经真实样本标定，生产启用集默认不含 `image.*`；
- 对账是回看窗口之外的唯一兜底，一圈的时间随内容总量线性增长；
- 被判定引用的结果行能否撑过申诉期，依赖 D 调用 `retainUntil`。D 不调用时，成功结果按默认 1 年清理（不会过早删除），失败结果 3 个月后清理（引用过它的判定会因此丢失证据），所以 D 的 spec 必须写明调用时机（§14 第 8 项）；
- ASR 文本的能力版本不含模型版本（模型变化靠人为升 `speech.asr` 版本），判定的参数指纹含模型版本；
- `comment.text_normalized` 绑评论最新态，评论被删后特征行保留到对象自身的保留规则，1.0 不单独清理；
- 单进程 `signals run`；多进程并行靠任务租约与扫描幂等成立，但扫描游标只有一份，并行扫描不提速；
- Python 服务单进程，评分吞吐受 CPU 限制；超过起始并发后的扩容方式是升能力服务的 worker 数，不在本 spec。

### 12.1 规模演练与实施发现

（任务 13 回填。）

## 13. Decision records

| # | 决定 | 理由 | 否决的备选 |
|---|---|---|---|
| SG-D01 | 一个 spec 覆盖 C1–C4、监控段、第 3 层编排 | 它们共用目录、读取口、任务表、复用键；拆开会各自重复这些 | 按 C1 / C2 / C3 拆三个 spec：读取口与任务表要么重复、要么被迫先建一个「公共」spec |
| SG-D02 | 存储分三类：特征行（当前值）、结果行（不可变）、历史表；存储态只有 `valid` / `failed`，五态在读取时合成 | PRD C-D13 要一对象一行；复用键天然适合不可变行；`missing` / `stale` / `not_applicable` 是「没有行」或「版本落后」的推论，存下来只会和事实漂移 | 全部信号统一为一张 EAV 表（行数一个数量级，PRD C §6.1 已否决）；存储 `stale` 态（升版本时要批量改行，和「不主动重算」冲突） |
| SG-D03 | 触发点是 current 指针推进，不是 finalized 事件 | 特征行只存 current；旧批次迟到的 finalized 快照不是 current，不该抽；A 没有事件，不改 A 的 seal 路径 | 轮询 `finalized_at`（要给 A 表加索引，且会处理非 current 快照）；让 A 在 seal 事务里调 C（跨域耦合，且 A 另有会话在改） |
| SG-D04 | 素材指纹按对象类型定义（§7.5）；文本用「含值状态的规范化 JSON」 | C-D12；NULL 与空串要能区分，否则「平台没返回」与「真的空」共享指纹 | 只哈希正文（丢掉标题 / 话题来源）；哈希归一化后文本（归一化升级后指纹不稳） |
| SG-D05 | 参数指纹：图片字节 / 零 / 标准+提示词+模型 | PRD C §3.6、§3.7、C-D14 | 用 `element_id` 当参数（换图不换 ID 会读到旧结果，PRD 已否决） |
| SG-D06 | C 自建 `signal_tasks`，不复用 `sync_tasks` | `sync_tasks` 的 `batch_id` / `provider_id` / `platform_id` 为 NOT NULL，`ck_sync_tasks_action` 是写死的 CHECK；复用要伪造批次与供应商，还要改 A 的 CHECK | 复用 `sync_tasks`（侵入 A）；抽取通用队列（重构正在运行的 orchestrator，风险与收益不成比例）。`ponytail:` 租约 / fencing 的 ~100 行在这里重写了一份；两套稳定后再评估合并 |
| SG-D07 | 匹配在 Python 内完成并回报分数与能力版本；不做 pHash 预筛 | 映射属于算法，随 Python 升版；预筛在日调用 < 1,000 次时没有收益，却多一套阈值要标定 | 在 Node 里映射分数（算法拆在两处，升版要同时发两个服务）；做预筛（多一个标定参数、多一条出错路径） |
| SG-D08 | 标准图放新桶 `hbecho-signals` | 计划物理删除要能删对象，media 桶刻意没有 `DeleteObject`；与 ADR-0001 对 `hbecho-course` 的做法一致 | 放 media 桶（破坏「media 桶永不删除」的物理保证）；放 MySQL BLOB（Python 读不到，只能由 Node 转发字节，两图一请求需要 multipart 新依赖） |
| SG-D09 | `AiGatewayPort` + 默认禁用实现 | 路线图把 C 排在 H 前面；PRD 要求调用经 H1；不能等 H1，也不能自己直连模型 | 在 C 里直接调百炼（违反 C-D14 / H-D 的「全部经 H1」、Key 无处托管）；把第 3 层推迟到 H 之后（C 的复用键、参数化、判定语义无法被验证） |
| SG-D10 | 能力启用集由配置显式给出，缺省只含文本类 | 宪法 C15、C18：未验证的不得启用；文本类是纯函数、免费 | 全部默认开（匹配分未标定即进生产） |
| SG-D11 | 读取口只读、不建任务；补算只经 `requestScores` | PRD C §12「清理与读取都不触发新的识别任务」；读路径有副作用会让 D 的试跑与执行互相污染 | 读时懒计算 |
| SG-D12 | `requestScores` 只补「缺失」；重算才覆盖 `stale` | PRD C §5.6 第 3 条与 §7.2 | 补算时顺带升版本（等于静默重算） |
| SG-D13 | 保留期用 `expires_at` + `retainUntil` | C 看不到 D 的判定，只能由 D 告知；清理器逻辑单一 | C 反查 D 的表（违反「C 不读 D 的表」）；引用计数表（需要 D 维护增减） |
| SG-D14 | 监控段以 `(plan_id, version)` 为键，计划 ID 无外键；草稿可改、已发布不可变 | D 未落地，不能建外键；PRD C-D10 「同版本更新」只发生在草稿期，已发布版本被引用着，必须稳定 | 监控段永远可改（旧版本结果无法解释）；段只存最新版本（回退无图可引） |
| SG-D15 | 瞬时失败不写结果行，确定性失败写 `failed` 行 | 一次宕机不该在结果表里固化 3 个月的「失败」 | 一律写 `failed`（宕机污染）；一律不写（图片损坏会被无限重试） |
| SG-D16 | `signals run` 是独立进程，不并入 `sync-main` | 文本信号不调供应商，不该受 `assertWorkerCanRun`（要求至少一个 approved 的供应商 capability）约束 | 并入 sync worker（C 会因 AI Master 未放行而整体不运行） |
| SG-D17 | 关键词归一化由 C 导出并按版本保留；D 保存关键词**原文**，执行时按 `SignalValue.normalizerVersion` 归一化 | 同一套实现处理库内文本与关键词是命中一致的前提；默认读到 `stale` 旧文本时，只有用同版本归一化关键词才不漂移 | D 自己写（必然漂移）；D 存归一化结果（升级后错位）；D 总用当前版本（`stale` 文本与关键词错位）；`stale` 文本一律按 unknown（是产品取舍，不能默认，PRD C-D05 默认使用旧值） |
| SG-D18 | 判定先取模型版本再算参数指纹 | 参数指纹含模型版本；先调用后算会把结果写到错误的键下 | 用响应里的模型版本回填（调用前无法判断是否命中缓存） |
| SG-D19 | 文本类信号的 `stale` 同时看归一化版本（`nv`） | 话题解析器依赖 `text.normalize`；只升归一化、不升解析器时，同一输入的话题值也会变；只看解析器版本会把旧话题值误当 current | 归一化升版时同步升所有 `text.hashtags.*` 版本（容易漏）；只看 `ver`（旧值被当 current） |

## 14. Open items

「建议」列是本 spec 的默认做法；**评审通过前不得被代码或示例默认冻结**（宪法 C18）。

**2026-11-12 刘学奎逐项确认**：第 1–5、7–10、13、15、17、18 项（共 13 项）已采纳，下表「谁来定」列已标注；第 7 项采纳的是标定的方法与门槛，**不是分数**，`image.*` 在标定报告签字前不进生产启用集。第 6、11、12、14、16 项**仍未决**，不得当作已关闭。

| # | 问题 | 影响 | 建议 | 谁来定 |
|---:|---|---|---|---|
| 1 | 标准图专用桶 `hbecho-signals`：创建桶、RAM 增加该桶读写删权限、ADR-0001 增补 | 阻塞 SG-7 的真实环境验证（离线测试不受影响） | 按 `hbecho-course` 的做法创建；任务 0 写 ADR 增补，创建与 RAM 变更逐步征得同意（`server-access.md`） | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 2 | H1 落地前，C 自己定义 `AiGatewayPort`，默认禁用 | 第 3 层不可在生产使用，直到 `h-ai-min` 实现并通过 smoke | 同意；`h-ai-min` 的 spec 以本端口为蓝本对齐 | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 3 | 不做 pHash 预筛（requirements R5） | 与 PRD C §5.1 / §5.2 字面不同 | 同意；PRD 已于 2026-11-12 升 v1.3 订正（C-D16） | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 4 | 标点统一方向（requirements R6） | 与 PRD C §4.2 字面不同；子串匹配不受影响，`text.regex` 需按归一化形态书写 | 同意，PRD 已于 2026-11-12 升 v1.3 订正（C-D17）；**`text.regex` 例外**：正则必须按归一化后的 ASCII 标点书写，D 的 spec 要在规则配置里提示（对子串匹配不受影响） | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 5 | 触发点 = current 指针推进，非 current 的 finalized 快照不抽；`contents` 加索引 | 影响特征行语义与 A 域一处索引 | 同意；PRD C §4.3「finalized 之后立即抽」已订正为「current 推进后」（C-D15，并对 C-D09 做删除线修订；requirements R9） | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 6 | `PLATFORM_TEXT_FIELDS` 与 NULL 语义 | 决定 `not_applicable` 与 `valid` 空值的分界 | ~~核对前三个平台都按「有 title / body」处理~~ 任务 3 已以 fixture 核对并回填（§7.2）：快手无正文字段，其余有；**已关闭（2026-11-12）** | 实测 |
| 7 | `image.template@1` / `image.element@1` 的 `R_FULL`、`I_FULL`、特征点上限、比率阈值 | 决定业务看到的分数分布；标定前不得进生产启用集 | 业务提供约 20 对脱敏样本（同图、轻度改动、无关图，封面 / 背景 / 头像各若干）；任务 7 标定并出报告，刘学奎签字后启用 | 业务 + 刘学奎；**已采纳方法与门槛（刘学奎，2026-11-12）；分数待标定报告并由刘学奎签字** |
| 8 | `retainUntil` 的调用约定 | D 落地前只有契约测试；D 不调用时结果最长保留 1 年 | 同意；D 的 spec 写明保存证据时调用 | 刘学奎（与 D spec 同审）；**已采纳（刘学奎，2026-11-12）** |
| 9 | `account.bg_*` / `account.avatar_*` 对小红书也是 `not_applicable` | PRD C 只点名快手；handoff 与 D PRD 说小红书没有这两项 | 同意 | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 10 | 瞬时 / 确定性失败的分界与重试用尽后的 `dead` 语义 | 影响运营能看到什么 | 同意（SG-D15） | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 11 | 监控段 / 读取口 / 补算请求的 API 形状 | D 的 spec 尚未写，现有 `rule-engine/design.md` 与 D PRD v1.1 不一致 | C 先实现并以契约测试固定；D 的 spec 开工时对齐，必要时回来修订，不在 D 里另造一份 | D spec |
| 12 | 关键词归一化出口（SG-D17）要写进 D 的 spec | 否则 D 可能自己归一化 | D 的 spec 登记：保存关键词**原文**，执行时调用 `normalizeKeyword(raw, value.normalizerVersion)`（按文本写入时的版本归一化，升级后不错位） | D spec |
| 13 | 标准图 ≤ 10 MiB、候选图上限沿用 `HBECHO_MEDIA_MAX_BYTES` | 影响可上传的图 | 同意 | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 14 | 数值起始值：扫描 tick 30 秒、批量 500、回看 10 分钟、对账每小时、评分并发 2、任务最多 3 次、租约 120 秒、签名 URL 600 秒、Python 请求超时 60 秒、判定 `deferred` 间隔 30 秒 / 上限 20 次 | 影响吞吐与成本 | 写入 `.env.example`，**不写进代码默认值**；测试机实测后调整 | 运维 + 实测 |
| 15 | 重算范围种类：`contentIds` / `accountIds` / `brandId` / `publishedFrom–To` | PRD C §7.2 写「时间 / 品牌 / 活动 / 账号 / 内容」，其中「活动」需要 D 提供主体清单 | 「活动」由 D 把名单展开成 `accountIds` 传入，C 不认识活动；`segmentRef` 为可选附加键 | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 16 | 判定调用需要的 `scope_fingerprint`（H PRD §3.5）从何而来 | H1 对范围指纹的格式未定 | `requestScores` 的 `ctx.scopeFingerprint` 由 D 传入并透传；格式由 `h-ai-min` 定 | `h-ai-min` |
| 17 | 话题上限：单个话题 ≤ 64 字符、每内容 ≤ 50 个 | PRD 没有这两个数；超出的话题会被丢弃 | 同意，或给出业务依据 | 刘学奎；**已采纳（刘学奎，2026-11-12）** |
| 18 | 评论 `content_text` 为 `NULL` 时读作 `valid` 的空值（指纹区分 `NULL` 与空串） | PRD 只写了「正文为空 → valid 空值」，没写 `NULL`；A 的评论正文列没有值状态 | 同意；若 A 日后给评论正文加值状态，改为 `missing` | 刘学奎；**已采纳（刘学奎，2026-11-12）** |

## 15. 界面

**本 spec 没有页面。**（`structure.md`：没有页面的 spec 要写明页面进入条件。）

- C 域没有独立界面（PRD C §9）。业务用户看到的是 D 的判定与证据；证据下钻里的信号、能力版本、产出时间、匹配点数量由 D 的页面调用 `SignalReader` 展示；
- **页面进入条件**：D 的 spec 完成「界面」一节并经刘学奎确认后，由 D 的页面任务消费本 spec 的读取口；本 spec 不预先设计任何页面，也不在 `ui-lab/` 放原型；
- 本轮运营查看信号用 CLI `signals show`（输出 JSON，不含内容原文）。

### 15.1 界面设计确认

不适用（无页面）。
