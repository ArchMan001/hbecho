# 模块设计 · 规则引擎

> **文档状态**：`superseded`  
> **当前替代**：[`rule-engine/design.md`](../.kiro/specs/rule-engine/design.md)  
> **保留原因**：保留早期考核项、Operator、规则版本与证据模型的设计输入。  
> **禁止用途**：不得作为当前实现合同，不得复用旧 DDL、旧 SQL、旧表名或过时组织假设；只有被当前 Spec 明确吸收的结论才生效。

---

> 上级文档：《新媒体运营赋能平台 3.0 — 产品与技术设计大纲》§4 分层能力模型 / §6.C 识别能力 / §6.D 规则引擎
> 下游文档：《模块设计 - 指标与看板》（消费本模块的判定结果）
> 撰写日期：2026-08-12｜修订：v2（引入考核项、三层向导、活动级公共条件）｜状态：待评审

---

## 1. 范围与目标

### 1.1 本文覆盖

| 层 | 内容 |
|---|---|
| 活动级公共条件 | 时间 / 平台 / 内容形态 / 板块 / 参与范围的统一圈定 |
| 考核项 | 业务侧一等概念：别名 + 判定条件 + 达标方式的封装 |
| L1 信号 | 信号定义规范、存储分工、就绪状态管理 |
| L2 算子 | 算子契约、注册规范、首批 15 个算子、新增流程 |
| L3 规则 | 表达式 DSL、三层向导、校验规则、版本与状态机 |
| L4 达标定义 | 存在量词、组合考核项 |
| 执行 | 三值逻辑求值、SQL 谓词下推、代价感知剪枝、按需识别 |
| 结果 | 判定结果与证据、批次与原子切换、重算对账、**三张表的数据来源** |

### 1.2 本文不覆盖

- **指标、报表、看板**：见《模块设计 - 指标与看板》。本文只交付判定结果与考核项元数据，不做聚合与比率计算。
- **视觉识别服务内部实现**：见《模块设计 - 视觉识别》。本文只定义"如何声明依赖某个识别信号"与"信号缺失时怎么办"。
- **数据同步与资产归档**：本文假设内容与素材已入库。但对 B5/B6 有两项接口要求，见 §10。

### 1.3 设计目标（可验证）

| # | 目标 | 验证方式 |
|---|---|---|
| 1 | 业务能独立完成「建活动 → 配公共条件 → 加考核项 → 试运行 → 发布」，无需研发介入 | 业务人员实操，全程不问研发 |
| 2 | 考核项数量与语义完全由业务定义，系统不预设任何考核项 | 建两个只差关键词的考核项，靠别名区分，报表正确显示两列 |
| 3 | 改规则不需要重新取数、不需要重新识别（除非引入新的高成本信号） | 修改关键词后重算，外部调用次数为 0 |
| 4 | 高成本识别调用量 = 公共条件圈定 × SQL 下推 × 短路剪枝后的残余，与预估偏差 < 20% | 对含视觉算子的考核项统计实际调用次数 |
| 5 | 任意历史时点、任意规则版本的判定结果可重放与对账 | 用旧系统 12 个活动数据复现，差异 100% 可解释 |
| 6 | 判定结果可下钻到「为什么这条算达标」的证据 | 任取命中记录，能看到命中了哪个算子、匹配了什么 |
| 7 | 重算过程中对外查询始终返回一致结果 | 重算期间持续查询，无空档无闪烁 |

### 1.4 与旧系统的关键差异

| 维度 | 旧系统 | 本设计 |
|---|---|---|
| **考核项** | **写死三个**：产品视频 / 活动视频 / 互动视频。报表列语义靠 `type_name === '活动视频'` 中文字面量判断 | **业务自定义，数量不限，必填别名**。报表列引用考核项 ID |
| 判定能力 | 2 种硬编码（标题关键词 OR-of-AND、背景图 SIFT） | 15 个注册算子，按成本分三层，可扩展 |
| 公共条件 | 每个视频类型各自配关键词，时间窗在活动上但平台/形态无法限定 | **活动级公共条件配一次，所有考核项继承** |
| 判定范围 | 全表扫描（`SELECT FROM videos LIMIT 500 OFFSET n`） | 公共条件圈定 + SQL 谓词下推 + 候选集收缩 |
| 信号缺失 | 无此概念（只有 title 一个输入） | 三值逻辑，`unknown` 触发按需识别 |
| 重算 | `DELETE WHERE campaign_id` 后分批 INSERT，无事务 | 新批次写入 → 校验 → 原子切换 |
| 时间窗 | JS 侧 `vDate <= endDate`（endDate 为 00:00，**活动最后一天内容被全部排除**） | 统一半开区间 `[start 00:00:00, end+1d 00:00:00)` |
| 证据 | 无 | 每个参与求值的节点都留证据，可下钻 |
| 输出 | 三个硬编码 Excel 导出接口 | **三张表的结构化数据源**，报表模板驱动渲染 |

---

## 2. 核心概念

### 2.1 概念层次

```
活动 Campaign
│
├─【活动级公共条件 CampaignScope】────────── 配一次，所有考核项继承
│   ├─ 时间区间      [start, end)
│   ├─ 平台          抖音 / 视频号 / 小红书 / 快手（允许集合，可多选）
│   ├─ 内容形态      视频 / 图文
│   ├─ 板块          氟机 / 水机
│   └─ 参与范围      品牌 → 大区 → 分公司 → 门店（层级或名单）
│        ↓ 圈定的内容集合 ＝【表1 全量数据表】的数据源
│
├─【考核项 #1】别名「5G荣耀家产品视频」  类型：内容型
│   └─ 判定条件：标题含"5G荣耀家" · 达标：存在 ≥1 条
├─【考核项 #2】别名「国庆营销视频」      类型：内容型
│   └─ 判定条件：标题含"国庆" + 话题含 #国庆 · 达标：存在 ≥1 条
├─【考核项 #3】别名「主页背景装修」      类型：账号型
│   └─ 判定条件：主页背景匹配标准图 · 达标：主账号命中
├─【考核项 #4】别名「封面含室内机」      类型：内容型
│   └─ 判定条件：封面画面包含"空调室内机" · 达标：存在 ≥1 条
└─【考核项 #5】别名「综合完成」          类型：组合型（可自动维护）
    └─ 组合：#1 AND #2 AND #3

     ↓ 命中内容集合 ＝【表2 业务明细表】的数据源
     ↓ 达标结论按组织聚合 ＝【表3 点检表】的数据源
```

### 2.2 术语定义

| 术语 | 定义 |
|---|---|
| **活动级公共条件 CampaignScope** | 圈定"本次活动关心哪些内容"的统一条件。所有考核项在此基础上叠加自己的判定 |
| **考核项 AssessmentItem** | **业务侧一等概念**。= 别名 + 判定条件（规则）+ 达标方式。业务只需理解这一个概念，不需要分别理解规则和达标定义 |
| **别名 Alias** | 考核项的业务名称，**必填且活动内唯一**。它是报表列名的唯一来源。两个只差关键词的考核项靠别名区分 |
| **判定对象 Subject** | `content`（一条内容）/ `account`（一个平台账号）/ `staff`（一个专员）/ `dealer`（一个门店） |
| **信号 Signal** | 从原始数据或素材抽取的可判定特征。有唯一 key、值类型、对象类型、成本档位 |
| **算子 Operator** | 参数化原子判定能力。输入 = 信号 + 参数，输出 = 三值结果 + 证据。研发交付 |
| **规则 Rule / 规则版本** | 作用于单一对象类型的算子实例布尔组合。不可变版本化。是考核项的技术实现 |
| **成本档位 CostTier** | 0 = 本地免费 / 1 = 库内或本地 CV / 2 = 低成本外部（OCR）/ 3 = 高成本模型（视觉、ASR） |
| **判定 Judgement** | 一个对象在一个规则版本下的判定结果 |
| **证据 Evidence** | 判定过程中实际参与求值的节点及其命中依据 |
| **判定批次 EvaluationRun** | 一次判定任务的执行记录。同一规则版本可有多个批次，仅一个生效 |

### 2.3 为什么把「考核项」提为一等概念

三个理由：

1. **它是业务的心智单位**。业务想的是"我要考核他有没有发带 618 话题的视频"，不是"我要建一条规则再建一个达标定义"。
2. **"配了啥才能看见啥"由此天然成立**。报表的可选列 = 内置基础指标 + 每个考核项派生的指标（完成人数 / 完成率 / 命中内容数）。业务不需要理解指标字典。
3. **它让报表列语义稳定**。列引用考核项 ID，业务改别名只改显示名，报表不断。这修的是旧系统靠中文字面量匹配报表列的问题。

---

## 3. 数据模型

### 3.1 活动级公共条件

```sql
CREATE TABLE campaign_scopes (
  campaign_id     INT          NOT NULL PRIMARY KEY,
  date_from       DATE         NOT NULL,
  date_to         DATE         NOT NULL,   -- 语义为半开区间右界前一天，见 §7.6
  platforms       JSON         NOT NULL,   -- 允许集合：["douyin","wechat_channels","xiaohongshu","kuaishou"]
  content_types   JSON         NOT NULL,   -- ["video","note"]
  sectors         JSON         DEFAULT NULL,   -- ["氟机"] / ["水机"] / null=不限
  brand           VARCHAR(20)  NOT NULL,
  -- 参与范围：三种表达
  participation_mode ENUM('all_brand','by_org','by_list') NOT NULL DEFAULT 'by_list',
  participation_config JSON    DEFAULT NULL,
    -- by_org:  {"region_ids":[3],"branch_ids":[21,22],"store_tiers":["A类"]}
    -- by_list: {"import_batch_id":881}
  updated_at      DATETIME     NOT NULL
);
```

**`sectors`（板块）是本轮新增**。氟机 / 水机是产品线维度，落在 `dealers.sector` 上。它同时起两个作用：限定参与门店范围、限定报表口径。**放在公共条件而不是考核项里**，因为一个活动通常只针对一条产品线。

**`store_tiers` 归入 `participation_config`** 而不做成算子。你确认没有分层考核，那门店层级的用途就是范围限定（"本次只考核 A 类店"），属于参与范围的一部分，不该让业务在每个考核项里重复配。

### 3.2 考核项

```sql
CREATE TABLE campaign_assessment_items (
  id              INT          NOT NULL PRIMARY KEY AUTO_INCREMENT,
  campaign_id     INT          NOT NULL,
  alias           VARCHAR(64)  NOT NULL,   -- 业务必填别名，报表列名来源
  item_type       ENUM('content_based','account_based','composite') NOT NULL,
  -- content_based / account_based：绑定规则版本
  rule_version_id INT          DEFAULT NULL,
  -- content_based：达标的存在量词
  min_count       INT          DEFAULT 1,
  count_window    ENUM('campaign','natural_week','custom') DEFAULT 'campaign',
  -- account_based：判哪个账号
  -- 目标平台：考核项限定单一平台（从活动允许集合中选），空=不限平台
  target_platform VARCHAR(20)  DEFAULT NULL,
  -- composite：组合其他考核项
  composite_def   JSON         DEFAULT NULL,   -- {"combinator":"and","item_ids":[11,12,13]}
  -- 元信息
  counts_toward_final TINYINT(1) NOT NULL DEFAULT 1,  -- 是否计入"综合完成"
  description     VARCHAR(500) DEFAULT NULL,          -- 业务说明，展示在报表列悬浮提示里
  sort_order      INT          NOT NULL DEFAULT 0,    -- 报表列顺序
  status          ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
  created_by      INT          NOT NULL,
  created_at      DATETIME     NOT NULL,
  UNIQUE KEY uq_campaign_alias (campaign_id, alias),
  KEY idx_campaign (campaign_id, sort_order)
);
```

**三种类型覆盖全部场景**：

| 类型 | 判定对象 | 达标语义 | 例子 |
|---|---|---|---|
| `content_based` | content | 名下账号内容中，命中规则的条数 ≥ `min_count` | 「5G荣耀家产品视频」、「封面含室内机」 |
| `account_based` | account | 该专员在 `target_platform` 上的账号命中规则 | 「抖音-主页背景装修」、「小红书-主页背景装修」 |
| `composite` | — | 组合其他考核项的达标结论（AND / OR） | 「综合完成」、「活动视频（文案版 OR 画面版）」 |

**`composite` 类型解决了跨层 OR 的表达问题**（§7.3）。

**关于 `target_platform`（业务已确认的重要简化）**：业务实际做法是**不同平台分别建立考核项**——一个专员同时有抖音和小红书账号时，不会在同一个考核项里同时点检两个平台。所以：

- 活动公共条件的 `platforms` 是**允许集合**（可多选），用于圈定表1 全量数据表的范围，让业务看到全平台数据全貌
- 每个考核项的 `target_platform` 是**单一平台**（从允许集合中选），判定范围明确
- 一个活动下可以有「抖音-主页背景装修」「小红书-主页背景装修」两个别名不同的考核项，各自判定各自平台的账号，点检表里是两组独立列

**这个约定消除了原设计中 `account_scope`（any / all / primary / by_platform）的歧义**——考核项限定平台后，`account_based` 的判定对象就是"该专员在该平台的账号"，不存在"判哪个"的问题。原 `account_scope` 与 `account_platform` 两个字段合并为 `target_platform` 一个字段，设计更简单。

仅剩一个边界情况：同一专员在同一平台有多个账号（罕见）。此时取 `staff_accounts.is_primary = 1` 的主账号，由主数据保证唯一。

**「综合完成」的处理**：系统自动维护一个别名为「综合完成」的 composite 考核项，组合所有 `counts_toward_final = 1` 的考核项（AND）。业务可以改它的别名、也可以取消某个考核项的 `counts_toward_final`。这替代了旧系统硬编码的 `final_complete`——旧系统那个还有个缺陷：分子不要求认证但分母是认证数，比率理论可 >100%。

### 3.3 信号定义与存储

信号分两类存储，**这个分工决定了执行性能**。

| 类别 | 存储位置 | 索引 | 可 SQL 下推 | 举例 |
|---|---|---|---|---|
| **结构化信号** | `contents` / `staff_accounts` 的真实列或 JSON 列 | 有（含 JSON 多值索引） | ✅ | `published_at`、`duration`、`platform`、`content_type`、`hashtags` |
| **派生信号** | `content_features` / `account_features` 的 `signals` JSON | 无 | ❌ | `asr.text`、`cover.ocr_text`、`cover.objects`、`profile.bg_sift_match` |

理由：0 档信号是 SQL 预过滤的依据（把几万条剪到几百条），必须能走索引；派生信号只在候选集内存中判定，候选集已很小，用 JSON 宽表更省行数。

```sql
CREATE TABLE signal_definitions (
  signal_key      VARCHAR(64)  NOT NULL,
  subject_type    ENUM('content','account','staff','dealer') NOT NULL,
  value_type      ENUM('string','number','bool','string_array','object') NOT NULL,
  storage         ENUM('column','json') NOT NULL,
  column_path     VARCHAR(128) DEFAULT NULL,
  cost_tier       TINYINT      NOT NULL,
  extractor       VARCHAR(64)  NOT NULL,   -- 'dwd' / 'text-extractor' / 'vision' / 'asr' / 'ocr'
  current_version INT          NOT NULL DEFAULT 1,
  applicable_to   JSON         DEFAULT NULL,  -- {"content_types":["video"]}，用于 not_applicable 判断
  display_name    VARCHAR(64)  NOT NULL,
  description     TEXT,
  PRIMARY KEY (signal_key, subject_type)
);

CREATE TABLE content_features (
  content_id  BIGINT   NOT NULL PRIMARY KEY,
  signals     JSON     NOT NULL,
  updated_at  DATETIME NOT NULL
);
```

`signals` 结构，**每个信号内嵌版本与产出时间**，升级单个识别能力时只重跑该信号：

```json
{
  "asr.text":       { "v": "今天给大家介绍...", "ver": 1, "at": "2026-08-10T02:11:00Z", "tier": 3 },
  "cover.ocr_text": { "v": "618大促 立减2000",  "ver": 1, "at": "2026-08-10T02:11:05Z", "tier": 2 },
  "cover.objects":  { "v": [{"target_id":7,"name":"空调室内机","conf":0.87}],
                      "ver": 2, "at": "2026-08-10T03:40:00Z", "tier": 3 }
}
```

**`applicable_to` 字段是本轮新增**，用于区分"信号缺失"和"信号不适用"。图文笔记没有 `duration`，这不是"还没算出来"而是"本来就没有"，算子应返回 `not_applicable` 而非 `signal_missing`（否则会触发无意义的识别任务）。

### 3.4 算子注册表

```sql
CREATE TABLE operators (
  op_key         VARCHAR(64)  NOT NULL PRIMARY KEY,
  subject_type   ENUM('content','account','staff','dealer') NOT NULL,
  cost_tier      TINYINT      NOT NULL,
  wizard_layer   TINYINT      NOT NULL,   -- 1=基础圈定 2=素材比对 3=内容理解，见 §7
  required_signals JSON       NOT NULL,
  params_schema  JSON         NOT NULL,   -- JSON Schema，前端据此自动渲染参数表单
  evidence_schema JSON        DEFAULT NULL,
  supports_sql_pushdown TINYINT(1) NOT NULL DEFAULT 0,
  display_name   VARCHAR(64)  NOT NULL,
  description    TEXT,                    -- 业务向说明，展示在向导里
  visibility     ENUM('business','admin_only') NOT NULL DEFAULT 'business',
  status         ENUM('active','deprecated') NOT NULL DEFAULT 'active',
  impl_version   INT          NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL
);
```

两个字段说明：

- **`params_schema` 决定"新增算子是否真的轻量"**。前端参数表单由它自动渲染，否则每加一个算子要写一个前端表单。
- **`wizard_layer`** 决定该算子出现在三层向导的哪一层。它与 `cost_tier` 高度相关但不完全等同（层是业务视角的分组，档是技术视角的成本）。

### 3.5 规则与版本

```sql
CREATE TABLE rules (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(64)  NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  subject_type  ENUM('content','account','staff','dealer') NOT NULL,
  brand_scope   JSON         DEFAULT NULL,   -- NULL=通用
  source        ENUM('wizard','expression') NOT NULL DEFAULT 'wizard',
  owner_user_id INT          NOT NULL,
  current_version_id INT     DEFAULT NULL,
  created_at    DATETIME NOT NULL,
  updated_at    DATETIME NOT NULL
);

CREATE TABLE rule_versions (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  rule_id       INT          NOT NULL,
  version_no    INT          NOT NULL,
  expression    JSON         NOT NULL,   -- 表达式树，见 §6
  wizard_form   JSON         DEFAULT NULL,   -- 向导原始填写内容，用于回显编辑
  status        ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  dryrun_result JSON         DEFAULT NULL,
  created_by    INT          NOT NULL,
  published_at  DATETIME     DEFAULT NULL,
  created_at    DATETIME     NOT NULL,
  UNIQUE KEY uq_rule_version (rule_id, version_no)
);
```

**`wizard_form` 是本轮新增**：向导填写内容与生成的表达式树都存。编辑时用 `wizard_form` 回显（业务看到的是自己填的表单，不是表达式树），执行时用 `expression`。这样向导与底层解耦，向导升级不影响历史规则执行。

### 3.6 判定结果与批次

```sql
CREATE TABLE evaluation_runs (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  campaign_id       INT            NOT NULL,
  assessment_item_id INT           DEFAULT NULL,  -- 归属考核项（composite 类型也有批次）
  target_version_id INT            DEFAULT NULL,  -- rule_version_id
  scope_snapshot    JSON           NOT NULL,      -- 执行时的公共条件快照
  trigger_type      ENUM('incremental','item_publish','manual','scheduled','signal_refresh') NOT NULL,
  status            ENUM('running','validating','active','superseded','failed','cancelled') NOT NULL,
  is_active         TINYINT(1)     NOT NULL DEFAULT 0,
  subject_total     INT            DEFAULT NULL,  -- 公共条件圈定的对象数
  subject_candidate INT            DEFAULT NULL,  -- SQL 下推后候选数
  subject_matched   INT            DEFAULT NULL,
  subject_pending   INT            DEFAULT NULL,
  tier3_calls       INT            DEFAULT 0,
  cost_amount       DECIMAL(10,4)  DEFAULT 0,
  started_at        DATETIME       NOT NULL,
  finished_at       DATETIME       DEFAULT NULL,
  error_msg         TEXT,
  KEY idx_item_active (assessment_item_id, is_active)
);

CREATE TABLE judgements (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id            BIGINT       NOT NULL,
  assessment_item_id INT         NOT NULL,
  subject_type      ENUM('content','account','staff','dealer') NOT NULL,
  subject_id        BIGINT       NOT NULL,
  result            ENUM('matched','not_matched','pending','not_applicable') NOT NULL,
  confidence        DECIMAL(5,4) DEFAULT NULL,
  evidence          JSON         DEFAULT NULL,
  org_snapshot      JSON         DEFAULT NULL,  -- 判定时点的组织归属
  evaluated_at      DATETIME     NOT NULL,
  UNIQUE KEY uq_run_subject (run_id, subject_type, subject_id),
  KEY idx_item_lookup (assessment_item_id, subject_type, subject_id),
  KEY idx_result (run_id, result)
) PARTITION BY RANGE (TO_DAYS(evaluated_at)) (...);
```

两处关键设计：

**`org_snapshot`**：考核归集必须按判定时点的归属解析。门店换分公司后，历史考核结果应保留在原分公司名下。如果每次查询都 JOIN 当前归属表，历史数据会被静默改写。

**被 SQL 预过滤剪掉的对象没有判定记录**。所以申诉场景（"我这条为什么没算"）必须支持**对单个对象按需重算并展示完整求值路径**，不能只依赖持久化结果。成本极低（单账号约 30 条内容、0 档信号已缓存、毫秒级），但功能上必须有。见 §9.6。

### 3.7 受控标的库

针对 `vision.content_contains` 的参数指纹稳定性。

```sql
CREATE TABLE vision_targets (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  code           VARCHAR(64)  NOT NULL UNIQUE,   -- 'indoor_unit'
  name           VARCHAR(64)  NOT NULL,          -- '空调室内机'
  prompt_text    TEXT         NOT NULL,          -- 给视觉模型的标准化描述（受控）
  aliases        JSON         DEFAULT NULL,      -- ["室内机","内机"]，仅用于业务搜索
  category       VARCHAR(32)  DEFAULT NULL,      -- '产品'/'场景'/'标识'/'人物'
  recommended_confidence DECIMAL(3,2) DEFAULT 0.70,
  prompt_version INT          NOT NULL DEFAULT 1,   -- 变更时递增 → 缓存键变化
  status         ENUM('active','deprecated') NOT NULL DEFAULT 'active',
  created_at     DATETIME NOT NULL
);
```

规则引用 `target_id`，参数指纹 = `target_id + prompt_version`。业务改叫法（aliases）不击穿缓存，只有运营主动修订 `prompt_text` 时才失效。

### 3.8 素材标准图

`profile_bg.matches_template` / `avatar.matches_template` / `vision.similar_to_template` 都需要标准图。

```sql
CREATE TABLE reference_assets (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  campaign_id   INT          DEFAULT NULL,   -- NULL=全局标准图
  asset_role    ENUM('profile_bg','avatar','cover_template') NOT NULL,
  media_asset_id BIGINT      NOT NULL,       -- 指向 media_assets
  sector        VARCHAR(20)  DEFAULT NULL,   -- 氟机/水机可能有不同标准图
  match_method  ENUM('sift','phash') NOT NULL DEFAULT 'sift',
  min_score     INT          NOT NULL,
  name          VARCHAR(128) NOT NULL,
  status        ENUM('active','archived') NOT NULL DEFAULT 'active',
  uploaded_by   INT          NOT NULL,
  created_at    DATETIME NOT NULL,
  KEY idx_campaign_role (campaign_id, asset_role)
);
```

**标准图按活动 × 板块存**。氟机和水机的活动主视觉可能不同，旧系统只有一张全局标准图（存在 `settings` 表的 base64 里），无法支撑。

---

## 4. 算子清单（首批 15 个）

### 4.1 算子契约

```typescript
interface Operator<P, S extends SubjectType> {
  key: string;
  subjectType: S;
  costTier: 0 | 1 | 2 | 3;
  wizardLayer: 1 | 2 | 3;
  paramsSchema: ZodSchema<P>;
  requiredSignals: SignalKey[];

  /** 仅可下推算子提供：把判定下推为 SQL 谓词，用于候选集预过滤 */
  sqlFilter?(params: P, ctx: SqlContext): SqlFragment;

  /** 内存求值。纯函数，无副作用，禁止发起任何外部调用 */
  evaluate(subject: SubjectSnapshot, params: P): OperatorResult;
}

type OperatorResult =
  | { status: 'ok'; matched: boolean; confidence?: number; evidence?: unknown }
  | { status: 'signal_missing'; missing: SignalKey[] }   // 信号未就绪 → unknown → 触发识别
  | { status: 'not_applicable'; reason: string };        // 信号不适用 → 等价 false，不触发识别
```

**`evaluate` 绝对不发起外部调用**——这是识别与判定解耦的硬约束。高档算子读特征表里已有的识别结果，没有就返回 `signal_missing`，由引擎去派发识别任务。这样求值器永远是快的、纯的、可单测的。

**`not_applicable` 是本轮新增的第三种返回**。小红书图文笔记没有时长、没有可 ASR 的音轨——这些是"不适用"而非"未就绪"。混为一谈会触发大量无意义的识别任务（对图文笔记反复排队做 ASR）。

### 4.2 第 1 层 · 基础圈定（0 档，免费，可 SQL 下推）

| op_key | 中文名 | 对象 | 参数 | 依赖信号 | 证据 |
|---|---|---|---|---|---|
| `published.within_window` | 发布时间在窗口内 | content | `{window:"campaign"\|"custom", from?, to?}` | `attr.published_at` | 实际发布时间 + 生效窗口边界 |
| `platform.in_list` | 发布平台属于 | content | `{platforms:string[]}` | `attr.platform` | — |
| `content_type.equals` | 内容形态等于 | content | `{type:"video"\|"note"}` | `attr.content_type` | — |
| `duration.between` | 视频时长在区间 | content | `{min_sec?, max_sec?}` | `attr.duration` | 实际时长 |
| `text.contains_all` | 文本含全部关键词 | content | `{keywords:string[], fields:string[], case_sensitive?}` | `text.title` / `text.body` | 每个词的命中片段 |
| `text.contains_any` | 文本含任一关键词 | content | 同上 | 同上 | 命中的词 + 片段 |
| `hashtag.includes_all` | 含全部指定话题 | content | `{hashtags:string[]}` | `text.hashtags` | 命中话题 + 该内容完整话题列表 |
| `hashtag.includes_any` | 含任一指定话题 | content | 同上 | 同上 | 同上 |
| `in_campaign.is_true` | 在活动参与范围内 | staff / dealer | `{campaign_id}` | — | — |

**注意事项**

- `published.within_window` 的 `window:"campaign"` 从活动公共条件动态解析，不写死参数，这样规则可跨活动复用。
- `text.contains_any` 下推成 `(title LIKE '%a%' OR title LIKE '%b%')`，词多了走不了索引。所以它**必须和时间窗一起用**才有意义——这由三层向导的结构天然保证。
- 旧系统有个隐式行为：**关键词含空格时被拆成子词，子词全部要出现**（如 `"海信 中央空调"` 实为两个词都要在）。迁移时要**显式化**：导入时把带空格的关键词拆成 `keywords` 数组的多项，语义一目了然。
- `duration.between` 遇图文笔记返回 `not_applicable`（不是 `signal_missing`）。
- `in_campaign.is_true` 与 `platform.in_list` / `content_type.equals` 在实际执行中**由公共条件自动注入**，业务不需要在每个考核项里配。它们注册为算子是为了让表达式树完整可执行、可回放。

### 4.3 第 2 层 · 素材比对（1~2 档，便宜，OpenCV / OCR）

| op_key | 中文名 | 档 | 对象 | 参数 | 依赖信号 | 证据 |
|---|---|---|---|---|---|---|
| `profile_bg.matches_template` | 主页背景匹配标准图 | 1 | account | `{reference_asset_id, min_score?, method?}` | `profile.bg_sift_match` | 匹配点数 + 标准图 ID + **被判定的背景图版本 ID** + 阈值 |
| `avatar.matches_template` | 头像匹配标准图 | 1 | account | `{reference_asset_id, min_score?}` | `profile.avatar_sift_match` | 匹配点数 + 标准图 ID |
| `vision.similar_to_template` | 封面匹配模板 | 1 | content | `{reference_asset_id, min_score?, method?}` | `cover.sift_match` | 匹配分数 + 方法 |
| `ocr.contains` | 素材文字含关键词 | 2 | content / account | `{keywords:string[], mode:"all"\|"any", asset:"cover"\|"profile_bg"}` | `cover.ocr_text` / `profile.bg_ocr_text` | 命中词 + OCR 全文 |

**注意事项**

- **主页装修语义已确认为"当前图匹配标准图"**（不是"活动期间换过图"），所以不需要 `profile_bg.changed_within_window`。资产管道仍保留背景图历史版本，供追溯与将来扩展。
- `min_score` 默认取 `reference_assets.min_score`，业务可覆盖但要看到提示。旧系统的阈值 30 是经验值，**迁移时必须用历史数据验证**——SIFT 匹配点数受图片压缩与缩放影响，不同来源的图分数不可直接比。
- `method:"phash"` 可作为 SIFT 的快速预筛：pHash 完全不像的直接判 false，不跑 SIFT。
- `ocr.contains` 对艺术字、渐变字、竖排文字识别率明显下降，而营销素材恰恰大量使用艺术字。**建议作为加分项或辅助证据，不适合单独作为一票否决的考核依据**，这点要向业务说明。

### 4.4 第 3 层 · 内容理解（3 档，贵，多模态大模型）

| op_key | 中文名 | 对象 | 参数 | 依赖信号 | 证据 |
|---|---|---|---|---|---|
| `vision.content_contains` | 画面包含指定内容 | content / account | `{target_id, asset:"cover"\|"frames"\|"profile_bg", min_confidence?}` | `cover.objects` / `frames.objects` / `profile.bg_objects` | 标的名 + 置信度 + 模型判断依据文字 + 素材 ID + 模型与 prompt 版本 |
| `speech.contains` | 口播提到关键词 | content | `{keywords:string[], mode:"all"\|"any"}` | `asr.text` | 命中词 + 转写片段 + 时间点 |

**注意事项**

- `target_id` 引用**受控标的库**而非自由文本，这是缓存稳定的前提。
- `min_confidence` 默认取 `vision_targets.recommended_confidence`。**阈值是业务决策不是技术决策**——0.70 和 0.85 会导致明显不同的达标率，UI 上要让业务看到这个影响。
- **`asset:"frames"` 比 `"cover"` 贵一个数量级**（抽 10 帧 = 10 次调用）。建议首版只开放 `cover` 与 `profile_bg`，`frames` 需超管授权。
- **`speech.contains` 有一个连锁依赖**，见 §10.2：它需要视频源文件，而当前下载策略只覆盖互动量前 10%，会导致大面积 `pending`。视频下载策略必须扩展。

### 4.5 已排除的能力及其归属

以下能力经评审移出规则引擎，归入更合适的模块：

| 能力 | 移至 | 理由 |
|---|---|---|
| `profile_bg.is_placeholder`（识别下载失败的占位图） | **B5 资产归档管道** | 获取失败返回的是**固定图片**，`sha256` 精确匹配即可，零成本、无需 CV。应在下载时就判定为"获取失败、待重试"，**不写入有效背景图版本**。这样规则引擎里根本看不到占位图，业务不需要在每个考核项里记得排除它 |
| `sync_health.is_ok`（账号同步状态正常） | **候选集界定时自动注入** | 数据采集异常的账号不应被判为"业务不达标"。但这个条件几乎所有考核都要，让业务每次记得加 = 旧系统"每个路由手写 brand 过滤"漏了 5 个的翻版 |
| `metric.rank_top_percent`（排名前 N%） | **B6 视频筛选任务** | 排序取前 N% 直接 SQL 即可，不需要规则判定的版本 / 证据 / 批次全套 |
| `post_freq.gte`（发布频率） | 用考核项的 `min_count + count_window` 表达 | 功能重叠，且不需要额外预计算信号 |
| `staff_attr.equals`（通用属性判定） | 删除 | 通用 `field/value` 算子无法做参数校验、无法给友好 UI、无法做血缘追踪，是设计偷懒 |
| `store_tier.in_list`（门店层级） | **活动公共条件的 `participation_config`** | 已确认无分层考核，其用途是范围限定，属参与范围的一部分 |
| `text.regex` | 注册但 `visibility='admin_only'` | 正则出错方式隐蔽（贪婪匹配、转义、`.` 匹配任意字符），业务写错不报错只静默漏判，且不可下推。保留作研发应急口子 |

### 4.6 挂起待议

`metric.gte`（互动指标不低于）—— 业务当前用不到，且依赖未定的成熟期 N（见大纲 §13.2-1）。框架已预留，随时可开。开启时**证据必须带观测时点**，否则无法回答"我明明有 150 赞怎么显示 80"（答案是"那是三周前的观测值，之后内容滑出 API 窗口数值冻结了"）。

### 4.7 新增算子的交付清单

| # | 步骤 | 说明 |
|---|---|---|
| 1 | 定义参数 Zod schema | 同时导出 JSON Schema 供前端自动渲染表单 |
| 2 | 声明 `subjectType` / `costTier` / `wizardLayer` / `requiredSignals` | |
| 3 | 若依赖新信号，先注册 `signal_definitions` 并实现抽取器 | 信号与算子是两件事，分开提交 |
| 4 | 实现 `evaluate`（纯函数，禁止 IO） | 三种返回状态都要处理 |
| 5 | 可下推的实现 `sqlFilter` | 不实现则失去预过滤能力，PR 里需说明理由 |
| 6 | 定义 evidence 结构写入 `evidence_schema` | 证据要能支撑业务申诉 |
| 7 | 单测：正例 / 负例 / `signal_missing` / `not_applicable` / 参数边界 / **SQL 下推与内存求值等价** | 第 7 项最关键，见下 |
| 8 | 注册到 `operators` 表（含中文名与业务向说明） | 向导里业务看到的就是这段说明 |

**第 7 步的"下推与内存求值等价"是最重要的测试**。如果 `sqlFilter` 比 `evaluate` 更严格，会错误排除本应命中的对象，且这种 bug 极难发现（结果只是"少了一些"）。测试方式：对同一批样本分别走 SQL 过滤与全量内存求值，断言 **SQL 结果 ⊇ 内存命中结果**。

---

## 5. 表达式 DSL

### 5.1 节点类型

```typescript
type Expr =
  | { type: 'and';  children: Expr[] }
  | { type: 'or';   children: Expr[] }
  | { type: 'not';  child: Expr }
  | { type: 'op';   op: string; params: Record<string, unknown>; id: string };
```

`op` 节点的 `id` 是节点内唯一标识（`n1`、`n2`…），用于证据回填与向导定位。

### 5.2 考核项「国庆营销视频」的表达式

向导填写：平台/形态/板块继承活动公共条件；标题含"国庆"；话题含 #国庆。生成：

```json
{
  "type": "and",
  "children": [
    { "type": "op", "id": "n1", "op": "published.within_window",
      "params": { "window": "campaign" } },
    { "type": "op", "id": "n2", "op": "platform.in_list",
      "params": { "platforms": "$scope.platforms" } },
    { "type": "op", "id": "n3", "op": "content_type.equals",
      "params": { "type": "$scope.content_type" } },
    { "type": "op", "id": "n4", "op": "text.contains_any",
      "params": { "keywords": ["国庆"], "fields": ["title"] } },
    { "type": "op", "id": "n5", "op": "hashtag.includes_any",
      "params": { "hashtags": ["#国庆"] } }
  ]
}
```

`$scope.xxx` 是**公共条件占位符**，执行时从 `campaign_scopes` 解析。这样公共条件改了（比如活动延期），所有考核项自动跟随，不需要逐个改规则版本。

### 5.3 校验规则（保存时强制）

| # | 规则 | 理由 |
|---|---|---|
| 1 | 所有 `op` 的 `subject_type` 必须等于规则的 `subject_type` | 不能在内容规则里混用账号算子 |
| 2 | 所有 `op` 的 `status` 必须为 `active` | 禁止引用废弃算子 |
| 3 | `params` 必须通过算子的 `params_schema` 校验 | |
| 4 | 树深 ≤ 5，`op` 节点 ≤ 30 | 可理解性与执行成本上限 |
| 5 | `and` / `or` 的 children ≥ 2，单子节点自动展平 | |
| 6 | **必须至少含一个 `cost_tier = 0` 的 `op`** | 否则会在全量对象上跑高成本算子。三层向导的结构天然满足此条 |
| 7 | 含 `cost_tier ≥ 2` 的算子时，必须先完成试运行才可发布 | 强制业务看到费用预估 |
| 8 | 向导生成的表达式：层间只能是 `and`，层内可 `and`/`or` | 见 §7.3 的取舍论证 |

### 5.4 三值逻辑

求值结果是 `true` / `false` / `unknown`（Kleene 三值逻辑）：

| 节点 | 规则 |
|---|---|
| `and` | 任一子 `false` → `false`；否则任一子 `unknown` → `unknown`；否则 `true` |
| `or` | 任一子 `true` → `true`；否则任一子 `unknown` → `unknown`；否则 `false` |
| `not` | `not unknown = unknown` |
| `op` | `signal_missing` → `unknown`；`not_applicable` → `false`；`ok` → 按 matched |

**顶层为 `unknown` 的对象判定为 `pending`**，引擎收集缺失信号，批量派发识别任务，完成后重新判定。

这套逻辑同时实现三件事：**避免误判**（信号缺失不当作不命中）、**按需触发识别**（unknown 自动驱动抽取）、**代价剪枝**（短路时不求值高档算子）。

---

## 6. 达标定义

达标定义**内嵌在考核项里**（`min_count` / `count_window` / `target_platform` / `composite_def` 四个字段），业务不需要单独理解这个概念。

### 6.1 三种达标语义

| 考核项类型 | 达标计算 |
|---|---|
| `content_based` | 该专员名下账号（受公共条件的平台/形态限定）的内容中，`result='matched'` 的条数 ≥ `min_count`，统计窗口为 `count_window` |
| `account_based` | 该专员在 `target_platform` 上的账号命中规则。同平台多账号时取 `is_primary = 1` 的主账号 |
| `composite` | 按 `composite_def.combinator` 组合其他考核项的达标结论 |

### 6.2 计算方式

达标判定**不重新求值规则表达式**，只读规则层的判定结果做聚合：

```sql
-- content_based 的达标计算
SELECT j.org_snapshot->>'$.staff_id' AS staff_id, COUNT(*) AS hit_count
FROM judgements j
JOIN evaluation_runs r ON r.id = j.run_id AND r.is_active = 1
WHERE j.assessment_item_id = ?
  AND j.result = 'matched'
  AND <count_window 时间条件>
GROUP BY staff_id
HAVING hit_count >= ?
```

所以达标重算极快（纯 SQL 聚合，零外部调用）。规则层判定完成后自动触发依赖它的考核项达标重算，再触发 composite 考核项重算。

### 6.3 平台归属（已确认）

业务实际做法是**不同平台分别建立考核项**，所以 `account_based` 考核项的判定对象由 `target_platform` 唯一确定，不存在"一个专员多平台账号判哪个"的歧义。详见 §3.2 的说明。

「主页背景装修」的判定结果按 `活动 × 考核项 × 账号` 存储（`judgements` 表），所以：

- 同一账号在不同活动的装修结论互不覆盖（修的是旧系统存在 `dealer_staff.bg_match_standard` 单字段被下个活动覆盖的问题）
- 同一专员的抖音账号与小红书账号，由两个不同考核项分别判定，结论独立
- 标准图也按 `活动 × 板块` 存（`reference_assets`），氟机/水机可用不同主视觉

---

## 7. 配置流程与三层向导

### 7.1 业务的完整配置流程

```
① 建活动
   名称、品牌、说明
        ↓
② 配活动级公共条件（配一次，所有考核项继承）
   时间区间  →  2026-09-25 ~ 2026-10-10
   平台      →  抖音 · 视频号
   内容形态  →  视频
   板块      →  水机
   参与范围  →  按分公司（华东全部）/ 按名单（导入批次）
        ↓  圈定 6,842 条内容 ＝【表1 全量数据表】
        ↓
③ 逐个添加考核项（每个必填别名）
   ┌─ 考核项「5G荣耀家产品视频」
   │    第1层：标题含"5G荣耀家"
   │    达标：存在 ≥1 条
   ├─ 考核项「国庆营销视频」
   │    第1层：标题含"国庆" + 话题含 #国庆
   │    达标：存在 ≥1 条
   ├─ 考核项「主页背景装修」
   │    第2层：主页背景匹配「2026国庆水机标准图」
   │    达标：主账号命中
   └─ 考核项「封面含室内机」
        第1层：（继承公共条件）
        第3层：封面画面包含"空调室内机"
        达标：存在 ≥1 条
        ↓
④ 每个考核项试运行 → 看命中数、抽样证据、费用预估
        ↓
⑤ 发布活动 → 判定执行 → 三张表可用
```

**关键：时间 / 平台 / 形态 / 板块 / 参与范围只在第 ② 步配一次。** 添加第二个考核项时不需要重复选。这是对旧系统的实质改进——旧系统三个视频类型各自配关键词，但平台与形态压根无法限定。

### 7.2 单个考核项的三层向导

三层的划分与你描述的业务心智一致，也恰好对应成本档位：

```
━━━ 第 1 层 · 基础圈定 ━━━━━━━━━━━━━━━━━━━━━ 免费（SQL 直接过滤）
   ▸ 继承自活动公共条件：时间区间 · 平台 · 内容形态 · 板块 · 参与范围
   ▸ 本考核项专属：
       标题关键词      text.contains_all / contains_any
       话题标签        hashtag.includes_all / includes_any
       视频时长（可选） duration.between
                              ↓ 显示「圈定 137 条」

━━━ 第 2 层 · 素材比对 ━━━━━━━━━━━━━━━━━━━━━ 便宜（OpenCV / OCR）
       主页背景匹配标准图  profile_bg.matches_template
       头像匹配标准图     avatar.matches_template
       封面匹配模板       vision.similar_to_template
       素材文字含关键词    ocr.contains
                              ↓ 显示「需比对 137 条」

━━━ 第 3 层 · 内容理解 ━━━━━━━━━━━━━━━━━━━━━ 贵（多模态大模型）
       画面包含指定内容    vision.content_contains
       口播提到关键词      speech.contains
                              ↓ 显示「需模型判定 89 条 · 预估 ¥1.8」
```

**这个结构比通用表达式树编辑器好在四点：**

1. **与业务心智模型一致**，业务不需要理解布尔树嵌套
2. **成本对业务直觉可见**——层级越深越贵，天然形成节制
3. **"必须有第 1 层"由 UI 结构天然保证**，不用靠保存校验去拦（校验规则 6 成为结构性保证）
4. **每层实时显示候选集规模**，业务边配边看漏斗收窄

### 7.3 层间只支持 AND 的取舍论证

向导生成的表达式，**层间是 AND，层内可 AND/OR**。这意味着跨层 OR 表达不了，例如：

```
时间窗 AND 话题 AND ( 标题含"新风" OR 封面含室内机 )
                      ↑第1层        ↑第3层
```

**不支持跨层 OR 是有意的**，理由是成本：`关键词 OR 画面识别` 意味着**所有关键词不命中的都要跑视觉**，这恰好是最贵的组合方式。而层层收窄的 AND 漏斗成本递减。让业务能轻易配出反成本模式的规则，不是好设计。

真需要"文案命中**或**画面命中都算达标"时，正确做法是配两个考核项 + 一个 composite 考核项：

```
考核项 A「国庆视频·文案版」  第1层：话题 #国庆 + 标题含"国庆"
考核项 B「国庆视频·画面版」  第1层：话题 #国庆     第3层：画面含国庆主视觉
考核项 C「国庆视频完成」     composite: A OR B    ← 报表用这一列
```

这样每个考核项的成本独立可见可控，业务能看到"B 这条要花 3 块钱"。而且报表里可以同时展示 A、B、C 三列，业务还能看出"靠文案达标的多还是靠画面达标的多"，信息量反而更大。

**底层数据结构不变**——仍是通用表达式树。向导只是"生成受限结构表达式树"的一种方式。保留**高级模式**（直接编辑表达式树，`visibility='admin_only'`）覆盖极端情况，不阻塞业务。

### 7.4 别名的规则

| 约束 | 说明 |
|---|---|
| 必填 | 不允许留空，不提供默认值（避免出现一堆"考核项1""考核项2"） |
| 活动内唯一 | `UNIQUE (campaign_id, alias)` |
| 长度 ≤ 64 字符 | 报表列宽约束 |
| 可修改 | 修改只改显示名，不影响判定结果与报表列绑定（列引用考核项 ID） |
| 建议命名 | UI 上给示例提示："建议包含判定要点，如『5G荣耀家产品视频』而非『视频1』" |

---

## 8. 执行引擎

### 8.1 整体流程

```
输入：campaign_id + assessment_item_id
     ▼
① 创建批次     evaluation_runs（status=running，快照公共条件）
     ▼
② 公共条件圈定  时间 + 平台 + 形态 + 板块 + 参与范围 + 同步状态正常
                109 万条全库  →  6,842 条（本活动全量）
     ▼
③ SQL 谓词下推  沿表达式树 AND 路径收集可下推算子 → 追加 WHERE
                6,842 条  →  137 条候选
     ▼
④ 装载信号      批量读 contents 列 + content_features.signals（一次 IN 查询）
     ▼
⑤ 三值求值      惰性 + 按 costTier 排序 + 短路
                ├─ true / false        → 写 judgements（decided）
                ├─ unknown             → 记录缺失信号，写 pending
                └─ not_applicable      → 写 not_applicable
     ▼
⑥ 派发识别      pending 按缺失信号分组 → 查缓存 → 未命中的投递识别任务（过配额守卫）
     ▼
⑦ 回调重算      识别完成 → 仅对该批 pending 重新求值 → 更新为 decided
     ▼
⑧ 校验          规模偏离、命中率突变、pending 占比、错误率
     ▼
⑨ 原子切换      事务内：旧 run.is_active=0，新 run.is_active=1
     ▼
⑩ 触发下游      达标聚合 → composite 考核项 → 指标预聚合（E 层）
```

### 8.2 步骤② 公共条件圈定

公共条件生成的是**所有考核项共享的基础 WHERE**，执行时自动注入，业务不感知：

```sql
FROM contents c
JOIN staff_accounts a  ON a.id = c.account_id
JOIN staffs s          ON s.id = a.staff_id
JOIN staff_store_relations r ON r.staff_id = s.id
     AND r.effective_from <= c.published_at
     AND (r.effective_to IS NULL OR r.effective_to > c.published_at)   -- 按发布时点解析归属
JOIN dealers d         ON d.id = r.dealer_id
WHERE d.brand = '海信'
  AND c.published_at >= '2026-09-25 00:00:00'
  AND c.published_at <  '2026-10-11 00:00:00'        -- 半开区间，见 §8.6
  AND c.platform     IN ('douyin','wechat_channels')
  AND c.content_type IN ('video')
  AND d.sector       IN ('水机')                      -- 板块
  AND <参与范围条件>                                   -- by_org / by_list
  AND a.sync_status  = 'ok'                           -- 自动注入：排除采集异常账号
```

三点说明：

- **归属按发布时点解析**（`effective_from/to`），不按当前归属。门店换分公司后历史考核不被改写。
- **`sync_status = 'ok'` 自动注入**，业务不需要在每个考核项里记得排除采集异常账号。这是把原 `sync_health.is_ok` 算子的职责下沉到框架。
- 这个圈定结果**就是【表1 全量数据表】的数据源**，会被物化以供报表与稽核使用（见 §9）。

### 8.3 步骤③ SQL 谓词下推提取

**算法**：从表达式树根开始，**只沿 `and` 路径下行**，收集路径上所有提供 `sqlFilter` 的 `op` 节点。遇到 `or` 或 `not` 节点即停止下行。

**为什么只沿 AND 路径**：只有 AND 链上的条件才是命中的**必要条件**。OR 分支里的条件不必要（另一支可能成立），NOT 内部语义翻转。收集必要条件构成的 WHERE 是**保守的**——可能少剪一些，绝不会错剪。

考核项「封面含室内机」的下推：

```
and
├─ n1 published.within_window    ✅ 已在公共条件覆盖
├─ n2 hashtag.includes_any        ✅ 可下推 → JSON_OVERLAPS(hashtags, '["#国庆"]')
└─ n3 vision.content_contains     ❌ 不可下推（3 档）
```

`hashtags` 走 MySQL 8 **JSON 多值索引**：

```sql
ALTER TABLE contents ADD INDEX idx_hashtags ( (CAST(hashtags AS CHAR(64) ARRAY)) );
```

### 8.4 步骤⑤ 三值求值与剪枝

两条优化：**子节点按 costTier 升序求值**（便宜的先跑，短路时跳过的是贵的）；**短路即返回**。

以考核项 A「国庆视频·文案版」与 B「国庆视频·画面版」为例，公共条件圈定 6,842 条：

| 考核项 | 层 | 剪枝后 | 付费调用 |
|---|---|---|---|
| A 文案版 | 第1层（话题 + 关键词） | 137 条命中 | **0 次** |
| B 画面版 | 第1层（话题）→ 892 条 → 第3层（视觉） | 892 条需判定，缓存命中 803 条 | **89 次** |

伪代码：

```typescript
function evaluate(node: Expr, subject: SubjectSnapshot, trace: Node[]): Tri {
  switch (node.type) {
    case 'op': {
      const op = registry.get(node.op);
      const r  = op.evaluate(subject, resolveScopePlaceholders(node.params));
      if (r.status === 'signal_missing') {
        trace.push({ id: node.id, op: node.op, result: 'unknown', missing: r.missing });
        return 'unknown';
      }
      if (r.status === 'not_applicable') {
        trace.push({ id: node.id, op: node.op, result: 'n/a', reason: r.reason });
        return 'false';
      }
      trace.push({ id: node.id, op: node.op, result: r.matched,
                   confidence: r.confidence, evidence: r.evidence });
      return r.matched ? 'true' : 'false';
    }
    case 'and': {
      let sawUnknown = false;
      for (const child of sortByCost(node.children)) {
        const r = evaluate(child, subject, trace);
        if (r === 'false')   return 'false';          // 短路
        if (r === 'unknown') sawUnknown = true;
      }
      return sawUnknown ? 'unknown' : 'true';
    }
    case 'or': {
      let sawUnknown = false;
      for (const child of sortByCost(node.children)) {
        const r = evaluate(child, subject, trace);
        if (r === 'true')    return 'true';           // 短路
        if (r === 'unknown') sawUnknown = true;
      }
      return sawUnknown ? 'unknown' : 'false';
    }
    case 'not': {
      const r = evaluate(node.child, subject, trace);
      return r === 'unknown' ? 'unknown' : (r === 'true' ? 'false' : 'true');
    }
  }
}
```

`trace` 只记录**实际参与求值的节点**，所以证据天然反映执行路径——看证据就知道走了哪条分支、有没有跑视觉。

### 8.5 步骤⑥ 按需识别与缓存

```
pending 892 条，缺 cover.objects（target_id=7）
  → 查 vision_cache（缓存键见下）→ 命中 803 条直接回填
  → 剩 89 条投递视觉识别任务（batch）
  → 过配额守卫：预算检查 + 限流
  → 结果写 content_features.signals['cover.objects'] + vision_cache
  → 回调步骤⑦，仅对这 89 条重新求值
```

**缓存键契约**（详见《模块设计 - 视觉识别》）：

```
cache_key = hash( asset_sha256 + capability + capability_version + params_fingerprint )
params_fingerprint = hash( target_id + vision_targets.prompt_version )
```

用 `target_id + prompt_version` 而非自然语言描述，业务在 `aliases` 加同义词不击穿缓存；只有运营主动修订 `prompt_text` 并递增 `prompt_version` 时才失效，这是有意的。

**pending 收尾策略**：

| 情形 | 处理 |
|---|---|
| 识别成功 | 更新为 `decided` |
| 识别失败（可重试） | 重试 ≤ 3 次，指数退避 |
| 识别失败（不可重试，素材已失效） | 标 `decided` + `not_matched`，证据记明"素材缺失无法判定"，进 B7 稽核清单 |
| 配额耗尽 | 保持 `pending`，批次标 `partial` 并告警；配额恢复后续跑 |
| 超时未完成（> 24h） | 批次仍可切换为 active，但 pending 数展示在报表与看板上 |

**关键产品决策：pending 不阻塞批次生效。** 否则一次识别故障会让整个考核数据不可用。报表上显式展示"待定 N 条"比让数据不可见更好。

### 8.6 时间窗语义（修正旧系统 bug）

旧系统两处不一致：SQL 侧 `< DATE_ADD(end_date, INTERVAL 1 DAY)`（正确），JS 侧 `vDate <= new Date(endDate)`（endDate 解析为当日 00:00，导致**活动最后一天发布的内容全部被排除**）。

**统一为半开区间，只在 SQL 层实现**：

```
[ date_from 00:00:00.000 , date_to + 1 day 00:00:00.000 )     时区 Asia/Shanghai
```

不在 JS 侧做日期换算（旧系统另一个坑：mysql2 配 `timezone:'+08:00'` 取出的 Date 再 `toISOString()` 会倒退 8 小时跨日界）。

### 8.7 原子切换

```sql
START TRANSACTION;
  UPDATE evaluation_runs SET is_active = 0, status = 'superseded'
   WHERE assessment_item_id = ? AND is_active = 1;
  UPDATE evaluation_runs SET is_active = 1, status = 'active' WHERE id = ?;
COMMIT;
```

所有对外查询 `JOIN evaluation_runs r ON r.id = j.run_id AND r.is_active = 1`，切换瞬时，无中间态。这是对旧系统「先 DELETE 全部再分批 INSERT」的直接修正——那个做法重算期间数据是空的，中途失败则永久丢失。

**切换前校验闸门**：

| 检查 | 阻断条件 |
|---|---|
| 候选集规模 | 与上一生效批次偏离 > 50% → 人工确认 |
| 命中率 | 偏离 > 30%（可配）→ 人工确认并填原因 |
| pending 占比 | > 20% → 警告（不阻断） |
| 算子异常率 | > 1% → 阻断，批次标 failed |

### 8.8 触发时机

| 触发类型 | 时机 | 范围 |
|---|---|---|
| `incremental` | 周末同步完成、新内容入库后 | 新增内容 × 进行中活动的全部考核项 |
| `item_publish` | 考核项发布或规则版本变更 | 该活动公共条件圈定范围内全部对象 |
| `scheduled` | 每周同步后例行重算 | 进行中的活动 |
| `manual` | 业务点"重算" | 用户指定范围 |
| `signal_refresh` | 识别能力升级导致信号版本变更 | 依赖该信号的考核项 × 受影响对象 |

`signal_refresh` 与大范围 `manual` **必须走费用预估与审批**（§9.4）。

### 8.9 并发与幂等

- 同一 `assessment_item_id` 同时只允许一个 running 批次。Redis 分布式锁 + 数据库唯一约束双保险（旧系统用 `SELECT ... WHERE status IN ('pending','running')` 检查，非原子，存在竞态）。
- `judgements` 的 `UNIQUE (run_id, subject_type, subject_id)` 保证批次内幂等，Worker 重启后可安全续跑。
- 批次内按 subject_id 分片并行，分片间无共享状态。

---

## 9. 输出：三张表的数据来源

规则引擎的最终产出是三张表的数据源。**表的渲染、列配置、样式、导出由 E 层负责**，本节只定义数据契约。

### 9.1 产出链路

```
【活动级公共条件】
      ↓ SQL 圈定（§8.2）
┌─────────────────────────────────────────┐
│ 表1 全量数据表                            │
│ 本活动关心的全部内容（含未命中任何考核项的）  │
│ 一行 = 一条内容                           │
└─────────────────────────────────────────┘
      ↓ 各考核项判定（三层漏斗）
┌─────────────────────────────────────────┐
│ 表2 业务明细表                            │
│ 命中至少一个考核项的内容                    │
│ 一行 = 一条命中内容 + 命中的考核项别名        │
└─────────────────────────────────────────┘
      ↓ 达标聚合 + 组织归集（按 org_snapshot）
┌─────────────────────────────────────────┐
│ 表3 点检表                                │
│ 一行 = 一个组织节点（大区/分公司/门店）        │
│ 列 = 参与专员数 + 各考核项（完成人数/完成率）   │
└─────────────────────────────────────────┘
```

### 9.2 表1 全量数据表的数据契约

| 项 | 内容 |
|---|---|
| 定义 | 符合活动级公共条件的**全部内容**，不做考核项过滤 |
| 一行 | 一条内容 |
| 规模估算 | 3,000 账号 × 活动窗 ~15 天 ≈ **4~7 万行/活动** |
| 提供的数据 | 组织字段（品牌/大区/分公司/板块/门店）+ 专员字段 + 账号字段（昵称/粉丝/主页链接/同步状态）+ 内容字段（标题/发布时间/时长/话题/互动数据/封面）+ **各考核项的命中标记（命中/未命中/待定/不适用）** |
| 关键价值 | ① 表3 分母的可核查依据（业务质疑完成率时可下钻）② 数据完整性核查（谁没发、谁的数据没同步上）③ 未命中原因分析 |
| 对应旧系统 | `full-detail.xlsx` |

**它和表2 的本质区别：表1 包含未命中任何考核项的内容。** 这是它最重要的价值——业务需要看到"他发了 5 条但一条都不符合要求"，而不只是"他有 0 条达标"。

### 9.3 表2 业务明细表的数据契约

| 项 | 内容 |
|---|---|
| 定义 | 命中**至少一个**考核项的内容 |
| 一行 | 一条命中内容 |
| 规模估算 | 表1 的 10~30% |
| 提供的数据 | 表1 的全部字段 + **命中的考核项别名列表** + 每个命中的证据摘要 + 可选嵌入封面图 |
| 支持操作 | 按考核项筛选；展开看完整证据（§9.6）；按互动量排序 |
| 对应旧系统 | `video-detail.xlsx` |

### 9.4 表3 点检表的数据契约

| 项 | 内容 |
|---|---|
| 定义 | 按组织维度汇总的达标情况 |
| 一行 | 一个组织节点（大区 → 分公司 → 可下钻门店） |
| 列结构 | **由考核项动态生成，不写死** |
| 提供的数据 | 每个组织节点 × 每个考核项 → `{完成人数, 参与人数, 完成率, 待定人数}`；加基础指标（总点赞、总互动、最佳作品） |
| 归集依据 | `judgements.org_snapshot`（判定时点的归属） |
| 对应旧系统 | `checklist.xlsx`（14 列固定） |

**与旧系统的关键区别**：旧系统 14 列写死在代码里（含靠 `type_name === '活动视频'` 中文字面量决定第 6 列语义）。新设计的列 = 考核项列表动态生成，考核项别名作为主表头，「完成人数 / 完成率」作为子表头。业务加一个考核项，点检表自动多两列。

### 9.5 对外查询接口

```typescript
// 表1 数据源
queryCampaignFullContents(campaignId, filters, pagination)
  → { rows: ContentRow[], total }
  // ContentRow 含 assessment_results: { [itemId]: 'matched'|'not_matched'|'pending'|'n/a' }

// 表2 数据源
queryCampaignMatchedContents(campaignId, { itemIds?, ...filters }, pagination)
  → { rows: MatchedContentRow[], total }
  // 含 matched_items: { itemId, alias, evidenceSummary }[]

// 表3 数据源（E 层预聚合前的原始达标结论）
queryCampaignAchievements(campaignId, { orgLevel, orgIds? })
  → { rows: { orgKey, itemId, achievedCount, participantCount, pendingCount }[] }

// 考核项元数据（供 E 层生成报表列与派生指标）
listAssessmentItems(campaignId)
  → { id, alias, itemType, sortOrder, description, countsTowardFinal }[]
```

所有查询强制经过 DataScope（品牌 + 组织层级 + 经销商仅本人）。

### 9.6 单对象按需重算（申诉支撑）

被 SQL 预过滤剪掉的对象**没有判定记录**，所以申诉场景必须支持按需重算：

```typescript
explainJudgement(assessmentItemId, subjectType, subjectId)
  → {
      finalResult: 'matched' | 'not_matched' | 'pending' | 'not_applicable',
      excludedBy?: 'campaign_scope' | 'sql_prefilter',   // 在哪一步被排除
      excludedReason?: string,                            // '平台不在活动范围（快手）'
      trace: [ { nodeId, op, displayName, result, evidence, skipped?, skipReason? } ]
    }
```

成本极低（单账号约 30 条内容，0 档信号已在库），毫秒级。展示形态见 §10.5。

---

## 10. 编排器与产品交互

### 10.1 考核项列表页

活动详情下的考核项管理：

| 列 | 说明 |
|---|---|
| 别名 | 可编辑，活动内唯一 |
| 类型 | 内容型 / 账号型 / 组合型 |
| 判定摘要 | 自动生成的人类可读摘要，如"标题含『国庆』且话题含 #国庆，存在 ≥1 条" |
| 最深层级 | 1 / 2 / 3，含成本提示 |
| 命中情况 | 命中内容数 / 达标人数 / 待定数 |
| 计入综合完成 | 开关 |
| 报表列顺序 | 拖拽排序，直接决定点检表列序 |
| 状态 | 草稿 / 生效 / 已归档 |

### 10.2 试运行（含 2 档以上算子时强制）

| 输出 | 说明 |
|---|---|
| 各层候选集规模 | 公共条件圈定 → 第1层后 → 第2层后 → 第3层需判定 |
| 命中数与命中率 | |
| **高成本调用预估** | 3 档调用次数 = 残余候选 × (1 − 缓存命中率) |
| **费用预估** | 按当前模型单价 |
| 抽样命中列表 | 20 条命中 + 20 条未命中，每条可展开看证据 |
| 与上一版本差异 | 新增命中、丢失命中、结论翻转的对象清单 |

**试运行只跑缓存命中的高档信号，不发起新的付费调用**（否则试运行本身就是开销）。未缓存部分用统计估算并明示"其中 N 条需实际识别后才能确定"。

### 10.3 命中率突变告警

考核项发布后首次判定完成时，与上一生效批次对比命中率。偏离超阈值（默认 30%）：

- 不自动切换生效批次，进入 `validating`
- 在考核项详情中向创建者展示差异清单（哪些对象结论翻转）
- 需人工确认并填原因才切换

这是对「规则错了不会报错、只会静默产出错误考核结果」的主要防线。典型场景：业务把「含全部关键词」和「含任一关键词」配反，命中数从 600 掉到 3，这里能拦住。

### 10.4 大范围重算的审批闸门

新增算子或升级识别能力后，业务的第一反应是"把历史全部重跑看看"。一次全量回溯可能是数十万次视觉调用。

重算任务必须：

1. **强制指定范围**（活动 / 时间 / 板块 / 组织），不提供"全部"选项
2. **展示预估**：涉及对象数、3 档调用次数、费用、耗时
3. **超阈值走审批**（阈值走配置中心，如预估费用 > 500 元）
4. **过配额中心硬限**：超预算直接拒绝，不是告警

### 10.5 证据下钻

从表1 / 表2 的任意一行都能展开：

```
内容《国庆钜惠 海信水机新风系统》 · 考核项「国庆营销视频」 · 判定：命中

✅ n1 发布时间在活动窗内
      实际 2026-10-02 14:32，窗口 [2026-09-25 00:00, 2026-10-11 00:00)
✅ n4 标题含任一关键词
      命中「国庆」（片段："...国庆钜惠 海信水机..."）
✅ n5 含任一指定话题
      命中 #国庆（该内容话题：#国庆 #中央空调 #新风）

────────────────────────────────────────
同一内容 · 考核项「封面含室内机」 · 判定：未命中

✅ n1 发布时间在活动窗内
✅ n2 含任一指定话题     命中 #国庆
❌ n3 画面包含指定内容
      标的「空调室内机」置信度 0.41 < 阈值 0.70
      模型判断：画面主体为门店外景与促销横幅，未见室内机
      判定素材：封面图 asset#99120 · 模型 qwen-vl · prompt v1
```

**未求值的节点也要显示并标注原因**。业务常困惑"我配了封面识别为什么没生效"，答案往往是被 OR 短路了或被前置条件排除了——这个信息必须可见。

### 10.6 编辑体验要点

- **向导表单由 `params_schema` 自动渲染**，算子上线即可用，前端不需逐个适配
- **成本档位可视化**：第 3 层的算子节点带明显成本标识，考核项列表页显示"最深层级"
- **实时校验**：违反 §5.3 任一条即时提示，不等保存
- **判定摘要自动生成**：把表达式树翻译成人类可读的一句话，用于列表页与报表列悬浮提示
- **公共条件继承可视化**：第 1 层显示"继承自活动：抖音·视频号 / 视频 / 水机"，灰色不可编辑，但有"仅本考核项覆盖"的入口

---

## 11. 与其他模块的接口

### 11.1 依赖方向

| 方向 | 模块 | 契约 |
|---|---|---|
| 依赖 | B4 DWD（`contents` / `staff_accounts`） | 结构化信号真实列；`published_at` 时区与半开区间语义；`hashtags` JSON 多值索引；`sync_status` |
| 依赖 | A2 组织主数据 | `staff_store_relations` 的生效区间，用于按发布时点解析归属 |
| 依赖 | C1/C2/C3 识别能力 | 读 `content_features.signals`；调 `requestExtraction(subjectIds, signalKeys, params)` 派发 + 完成回调 |
| 依赖 | A8 配额中心 | 识别派发前 `checkQuota(tier, count, attribution)`；硬限返回拒绝 |
| 依赖 | A7 媒资服务 | `reference_assets` 指向的标准图读取 |
| 被依赖 | **E 层 指标与看板** | §9.5 的四个查询接口 + 考核项元数据（派生指标的来源） |
| 被依赖 | F2 活动管理 | 活动公共条件与考核项的 CRUD |
| 被依赖 | F3/F4 账号档案与内容库 | 按考核项命中筛选；展示判定证据 |
| 被依赖 | H8 规则辅助生成 | 提供算子清单与 schema，AI 生成的规则落为 `draft` |

### 11.2 对 B5 / B6 的两项新增要求

**要求一：B5 资产归档要拦截失败占位图**

背景图 / 头像获取失败时返回**固定图片**。B5 在下载后按 `sha256` 比对已知占位图指纹清单（清单存 A5 配置中心，各平台可能不同）：

- 命中 → 判为"获取失败"，标记待重试，**不写入有效素材版本**
- 未命中 → 正常入库

这样规则引擎里根本看不到占位图，业务不需要在每个考核项里排除它。零成本、零业务感知。

**要求二：B6 视频筛选下载要接受规则引擎的按需请求**

`speech.contains`（口播判定）需要视频源文件才能做 ASR。当前下载策略只覆盖互动量前 10%，会导致 90% 内容的 `asr.text` 永远缺失 → 大面积 `pending`。

所以 B6 的下载筛选条件要从「互动前 10%」扩展为：

```
互动量前 N%  OR  落在某个含 ASR 算子的考核项候选集内
```

量级估算：

| 项 | 估算 |
|---|---|
| 一个活动的 ASR 候选集 | 3,000 账号 × 窗内 ~15 条 × 话题命中率 ~15% ≈ **6,000 条** |
| 视频源下载增量 | 6,000 × 6MB ≈ **36GB / 活动** |
| 一年 6 个活动 | ≈ **220GB/年** 增量 |
| ASR 成本 | qwen3-asr-flash 单价低，约几十元/活动 |

**结论：成本可接受，但架构联动必须建立**——B6 需要提供 `requestSourceDownload(contentIds, reason, priority)` 接口，由规则引擎在发现 ASR 信号缺失时调用。

---

## 12. 验收标准

| # | 项 | 标准 |
|---|---|---|
| 1 | 业务自助 | 业务独立完成「建活动 → 配公共条件 → 加 4 个考核项 → 试运行 → 发布」，全程无研发介入 |
| 2 | 考核项自定义 | 建两个只差关键词的考核项（如「5G荣耀家产品视频」与「国庆营销视频」），报表正确显示为两组独立列，别名正确 |
| 3 | 公共条件继承 | 第二个考核项不需重复配时间/平台/形态/板块；改活动时间区间后所有考核项自动跟随 |
| 4 | 历史复现 | 用旧系统 12 个活动数据配置等价考核项，判定结果与旧 `video_type_matches` 逐条对比，**差异 100% 可解释**（不要求零差异：旧系统有时间窗少一天等已知缺陷，新结果应更正确） |
| 5 | 改规则零外部调用 | 修改 0 档参数（关键词/话题）后重算，外部调用次数 = 0 |
| 6 | 代价控制 | 含 3 档算子的考核项，实际调用次数与试运行预估偏差 < 20% |
| 7 | 三值逻辑 | 单测覆盖 and/or/not 全部三值组合；`signal_missing` 不产生 `not_matched`；`not_applicable` 不触发识别任务 |
| 8 | 下推等价性 | 每个提供 `sqlFilter` 的算子有测试断言「SQL 过滤结果 ⊇ 内存命中结果」 |
| 9 | 重算原子性 | 重算期间持续查询无空档无闪烁；杀掉 Worker 后批次可续跑或安全丢弃 |
| 10 | 时间窗正确性 | 活动首日 00:00:00 与末日 23:59:59 发布的内容均被正确纳入 |
| 11 | 证据完整性 | 任取命中/未命中记录能看到参与求值的全部节点及短路跳过的节点；被公共条件或预过滤排除的对象能通过 `explainJudgement` 得到排除原因 |
| 12 | 突变防线 | 构造一条「含全部/含任一配反」的考核项，发布后被命中率突变告警拦住，不自动生效 |
| 13 | 三张表 | 表1 包含未命中内容且行数等于公共条件圈定数；表2 行数等于命中去重数；表3 列数 = 考核项数 × 2 + 基础列 |
| 14 | 板块隔离 | 配置 `sectors=["水机"]` 的活动，氟机门店的内容不进任何表 |

---

## 13. 遗留问题

### 13.1 已确认

| # | 事项 | 结论 |
|---|---|---|
| 1 | 平台枚举 | **抖音 / 视频号 / 小红书 / 快手**。无公众号，`content_type` 只需 `video` / `note`，不需要 `article` |
| 2 | 考核项与平台的关系 | **不同平台分别建立考核项**。活动 `platforms` 为允许集合，考核项 `target_platform` 为单一平台。原 `account_scope` 歧义消除，字段合并为 `target_platform` |
| 3 | 主页装修的判定与存储 | 语义为「当前图匹配标准图」；判定结果按 `活动 × 考核项 × 账号` 存储；标准图按 `活动 × 板块` 存储 |
| 4 | 视频源下载条件 | 扩展为「互动量前 N% **OR** 落在含 ASR 算子的考核项候选集内」，见 §11.2 |

### 13.2 待议

| # | 问题 | 需要谁 | 状态 |
|---|---|---|---|
| 1 | 「综合完成」是否需要业务可自定义组合逻辑（当前设计为自动 AND 所有 `counts_toward_final`） | 业务 | 倾向自动，但保留 composite 类型可手工建 |
| 2 | `metric.gte` 的开启时机与 `basis` 默认值 | 业务 | 依赖成熟期 N 的确认 |
| 3 | 通用规则的品牌可见性：`brand_scope` 为 NULL 时四品牌是否都可引用 | 业务 | 倾向可见可引用，引用时提示"通用规则，改动影响多品牌" |
| 4 | 是否支持"考核项跨活动复制"（复制上次活动的整套考核项，只改关键词与标准图） | 产品 | 强烈建议做，业务实际诉求 |
| 5 | 试运行的抽样策略（规模超过多少时抽样、如何保证代表性） | 技术 | 实现阶段定，建议 > 5 万对象时按账号分层抽样 |
| 6 | **四平台的 `hashtags` 语义差异**：抖音与快手的话题机制不同、视频号话题较弱、小红书话题与关键词耦合。抽取器需按平台适配并归一化 | 技术 | 接入 API 时实测确认，优先用供应商返回的结构化话题字段 |
| 7 | 视频号是否提供主页背景图 | 供应商 / 实测 | 若不提供，视频号的装修类考核项无法配置，需业务知晓 |

---

## 14. 下一步

1. 本文评审，落定 §13 第 1、2、3、6 项
2. 产出 `packages/rules` 接口定义（Operator 契约、Expr 类型、三值求值器、公共条件占位符解析）
3. 产出首批 15 个算子的参数 schema 与 evidence schema
4. 产出规则域 Prisma schema（与《数据模型详细设计》合并评审）
5. 三层向导交互原型（重点：公共条件继承的可视化、层级成本提示、试运行结果展示）
6. 与《模块设计 - 视觉识别》对齐：缓存键契约、`requestExtraction` 接口、配额守卫调用时机
7. 与 B5 / B6 对齐 §11.2 的两项新增要求
