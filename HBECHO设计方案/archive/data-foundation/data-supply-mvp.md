# media-platform 3.0：数据供给 MVP 设计

> **状态：`superseded`（2026-09-02）**  
> **替代文档**：[`database-design-v2.md`](../../domains/data-foundation/database-design-v2.md) 与 [`a-data-foundation-tracer`](../../../.kiro/specs/a-data-foundation-tracer/)  
> **保留原因**：追溯 MVP 阶段关于本地 fixture、失败分类、反腐层和 raw-before-parse 的早期思路。  
> **禁止用途**：本文件不是当前实现依据；其中的表名、同步模式、LONGBLOB ODS、组织模型和供应商合同假设均不得直接实施。冲突时以 [`HBECHO设计方案/INDEX.md`](../../INDEX.md) 的权威顺序为准。

> **文档定位**：这是一份可以直接开始开发的数据供给 MVP 方案，只回答四个问题：API 怎么调用、原始响应要不要保存、JSON 数据如何落库、前端以后如何使用这些数据。
>
> **详细版参考**：归档文件 [`data-supply-and-assets.md`](data-supply-and-assets.md)。MVP 不实现详细版中的不可变 revision、复杂血缘、事件总线、完整资产目录和多供应商治理。
>
> **事实基线**：FieldShortcut A Master API V1.2 及当前已保存的真实响应；供应商调用默认使用 `async=false`；数据库使用 MySQL 8。

---

## 0. 先给结论

### 0.1 原始 JSON 要不要保存？

**要，而且每一次 API 调用都要保存，包括成功、业务失败、HTTP 错误和非 JSON 响应。**

原因很直接：

1. 每次调用都可能产生费用，解析代码出错时应从本地原始响应重新处理，不能再次付费调用；
2. 供应商文档与真实返回已经存在字段名、类型、时间单位和游标差异；
3. 以后出现数据争议时，需要核对当时供应商到底返回了什么；
4. HTML 错误页、空 502、截断 JSON 也有排障价值，不能只保存成功 JSON。

MVP 的做法：

- MySQL `api_call_record` 保存调用元数据；
- 响应原始 bytes 先 gzip，再保存到 `LONGBLOB`；
- **原始响应提交成功后才允许 JSON 解析**；
- API Key、Authorization、Cookie 不得保存；
- 业务页面绝不直接查询原始响应，而是查询账号、内容、指标和评论表。

### 0.2 JSON 数据怎么保存？

采用“两份数据”原则：

| 数据 | 保存位置 | 用途 |
|---|---|---|
| 供应商原始请求与响应 | `api_call_record` | 重放、排错、对账、字段变更核对 |
| 解析后的业务数据 | `platform_account`、`media_content`、`content_metric_snapshot`、`media_comment` | 页面展示、检索、统计、规则计算 |

不要只存原始 JSON，也不要只存拆解后的字段。只存原始 JSON 会导致页面查询困难；只存拆解字段会丢失证据和未识别的新字段。

### 0.3 MVP 一共需要几张表？

只需要 7 张核心表：

1. `data_sync_run`：一次批量同步；
2. `data_sync_task`：批次中的单个账号任务；
3. `api_call_record`：每一次真实 API 调用及原始响应；
4. `platform_account`：账号当前资料；
5. `media_content`：作品当前基础信息；
6. `content_metric_snapshot`：作品互动数据的历史快照；
7. `media_comment`：结构化评论当前数据。

### 0.4 哪些数据覆盖更新，哪些数据追加？

| 数据 | MVP 写法 | 原因 |
|---|---|---|
| 账号昵称、简介、头像、粉丝数 | 更新 `platform_account` 当前值 | 页面通常只需要当前资料 |
| 作品标题、正文、封面、资源 URL | 更新 `media_content` 当前值 | 详情结果优先于列表结果，保留原始响应即可追溯 |
| 点赞、评论、收藏、分享、播放量 | 每次新增 `content_metric_snapshot` | 指标会变化，覆盖后无法看趋势 |
| 评论正文、作者展示信息、点赞/回复数 | 按评论 ID upsert 当前值 | MVP 暂不做评论版本历史 |
| 原始请求与响应 | 每次新增 `api_call_record` | 不能覆盖过去的付费调用证据 |

### 0.5 图片、视频要不要马上下载？

MVP **不全量下载**。先在 `media_content` 中保存封面、图片、视频、音频和下载地址的 JSON URL 数组。只有内容进入优秀案例、AI 识别或用户明确使用时，后续再增加下载和资产表。

---

## 1. MVP 范围

### 1.1 当前使用的接口

| 业务目的 | 接口 action | MVP 用法 |
|---|---|---|
| 获取账号资料 | `media_user_info` | 首次添加账号、定期刷新资料 |
| 获取账号作品 | `user_video_list` | 日常同步的主入口，支持分页 |
| 获取作品详情和精确指标 | `media_stats_number` | 只对新增内容或用户主动刷新调用 |
| 获取结构化评论 | `post_comments_list` | 只对选中的抖音/小红书内容调用 |
| 获取评论拼接文本 | `media_comments` | 默认不调用；已有结构化评论时本地拼接 |

### 1.2 当前能力边界

| 平台 | 主页 | 作品列表 | 作品详情 | 结构化评论 |
|---|---|---|---|---|
| 抖音 | 可用，按现有证据灰度 | 已有同步成功样本 | 支持，按需调用 | 支持，按需调用 |
| 小红书 | 已有同步成功样本 | 已有同步成功样本 | 已有同步成功样本 | 已有同步成功样本 |
| 快手 | 可用，按现有证据灰度 | 可用，按现有证据灰度 | 可用 | **不支持，不调用** |
| 视频号 | 暂不作为同步保证 | **主页作品列表不支持** | 有历史成功样本 | 未验证，不调用 |

能力不明确时，MVP 默认不调用，避免把付费请求当作探测工具。

### 1.3 MVP 明确不做

- 不建设 Kafka、数据湖或独立数仓；
- 不建设复杂的 ODS/DWD revision 体系；
- 不保存同一业务字段的多版本解释；
- 不建设完整的素材/资产目录；
- 不自动下载所有头像、封面、图片和视频；
- 不建设多供应商自动切换；
- 不让前端打开页面时实时调用 2,000 个外部账号；
- 不对所有作品全量抓详情和评论。

---

## 2. 一次同步到底怎么执行

### 2.1 最小主流程

```text
创建同步批次 data_sync_run
  → 为每个账号创建 data_sync_task
  → 队列按有限并发取任务
  → 调用供应商 async=false
  → 原始响应先写 api_call_record
  → 解析并验证 code/status/error/result
  → 按接口写账号、内容、指标或评论表
  → 根据 has_more 和 cursor 决定是否翻页
  → 更新账号任务状态
  → 汇总同步批次状态
```

### 2.2 每一次 API 调用的固定顺序

必须严格按下面的顺序实现：

1. 在 `api_call_record` 创建 `started` 记录，保存脱敏后的请求信息；
2. 发起 `async=false` HTTP 请求；
3. 收到响应后，取得原始 response bytes；
4. 对原始 bytes 计算 sha256、gzip 压缩；
5. 将 HTTP 状态、headers、原始响应 gzip 和 hash 写入 `api_call_record` 并提交；
6. **提交成功后**才执行 JSON 解析；
7. 校验 HTTP、`code`、`data.status`、`data.error` 和 `data.result`；
8. 在一个业务事务中写入账号、内容、指标或评论；
9. 更新 `api_call_record` 的解析状态和任务状态。

如果第 5 步失败，停止后续解析和业务写入。不能出现“业务数据已经入库，但原始响应没有保存”的情况。

### 2.3 前端如何使用

- 账号列表读 `platform_account`；
- 内容列表和详情读 `media_content`；
- 最新互动量读 `content_metric_snapshot` 中该内容最新一条；
- 趋势图读取某个时间范围的多条指标快照；
- 评论列表读 `media_comment`；
- 同步进度读 `data_sync_run` 和 `data_sync_task`；
- `api_call_record` 仅供后台排错、重放和费用核对，不直接提供给普通业务页面。

---

## 3. 原始响应保存方案

### 3.1 保存什么

每次请求至少保存：

- 内部批次 ID、账号任务 ID、调用记录 ID；
- 平台、operation、endpoint、目标账号或作品；
- 请求开始和响应到达时间；
- 脱敏后的 URL 和请求 JSON；
- HTTP status、Content-Type、供应商 request/task ID；
- 原始 response bytes 的 gzip；
- 原始 bytes 的 sha256 和字节数；
- `succeeded/transport_failed/http_failed/business_failed/protocol_failed/outcome_unknown` 主状态；
- `not_started/json_succeeded/envelope_succeeded/schema_succeeded/failed` 解析阶段；
- parser 版本和错误信息。

### 3.2 不保存什么

- API Key；
- Authorization header；
- Cookie；
- 包含签名/token 的完整 URL query；
- 为了“方便”而重新格式化后的 JSON 替代原始 body。

### 3.3 为什么使用 `LONGBLOB`，不直接使用 MySQL `JSON`

原始响应可能是：

- 正常 JSON；
- HTML 网关错误页；
- 空 body；
- 截断 JSON；
- 未知编码的文本。

因此原始内容使用 `LONGBLOB` 保存 gzip bytes，业务字段再使用普通列或 MySQL `JSON`。原始表不做字段查询，不需要把 body 存成可查询 JSON。

### 3.4 保留时间

MVP 建议：

- 默认在线保留 90 天，实际值由数据合规和排障需要确认；
- 到期前若仍需长期重放，可将 gzip body 迁移到 OSS，只在 MySQL 保留 URI、hash 和调用元数据；
- 评论原始数据可能包含个人信息，保留期应单独配置；
- 在保留策略未确认前，不要写死“永久保存”。

当 `api_call_record` 明显拖慢 MySQL 备份，或 raw body 总量达到团队难以维护的规模时，再迁移 OSS；MVP 首期不必同时建设两套存储。

---

## 4. JSON 到数据库的映射规则

### 4.1 先处理统一包络

供应商同步成功不能只判断 HTTP 200，必须同时满足：

```text
HTTP 为 2xx
AND response 是 JSON object
AND code = 0
AND data.status = "succeeded"
AND data.error IS NULL
AND data.result 类型符合当前 operation
```

统一包络字段写入 `api_call_record`：

| JSON 路径 | 数据库字段 |
|---|---|
| `code` | `provider_code` |
| `data.task_id` | `provider_task_id` |
| `request_id` | `provider_request_id` |
| `data.action` | `provider_action` |
| `data.status` | `provider_status` |
| `data.error` | `error_message` 或从原始 body 查看 |
| 完整响应 bytes | `response_body_gzip` |

当前样本中 `task_id` 可能等于 `request_id`，但仍应分别保存，不能把它当作永久规则。

### 4.2 账号资料 `media_user_info`

写入 `platform_account`：

| JSON 字段 | 数据库字段 | 规则 |
|---|---|---|
| `user_id` | `provider_user_id` | 与平台一起使用，不能跨平台唯一 |
| 抖音 `sec_uid` 或已解析平台 ID | `platform_native_id` | 优先作为稳定平台身份 |
| `nickname` | `nickname` | 可覆盖当前值 |
| `signature` | `signature` | 空串保留为空串；缺键不覆盖旧值 |
| `location` | `location_text` | 可空 |
| `avatar` | `avatar_url` | 只存 URL |
| `cover` | `profile_cover_url` | 只存 URL |
| `follower_number` | `follower_count` | 首选数值字段 |
| `following_number` | `following_count` | 首选数值字段 |
| `like_number` | `like_count` | 首选数值字段 |
| `post_number` | `post_count` | 首选数值字段 |
| 整个 result 未映射字段 | `extra_json` | 只放确实需要保留的少量平台差异；完整原文已在 raw 表 |

当 `*_number` 缺失或为 `null` 时，才尝试严格解析对应的 `*_count`。`*_number` 为非空非法类型时属于 schema 漂移，记录 `protocol_failed`，不能静默回退到旧字段，也不能写成 0。

### 4.3 作品列表 `user_video_list`

每个 `result[]` item 写入两处：

1. 作品基础信息 upsert 到 `media_content`；
2. `stats` 中的互动量新增一条 `content_metric_snapshot`。

| JSON 字段 | 数据库字段 |
|---|---|
| `post_id` | `platform_post_id` |
| `user_id` | `platform_author_id` |
| `author_name` | `author_name` |
| `created` | `published_at` |
| `title` | `title` |
| `text.content` | `body_text` |
| `tag_text` | `tags_text` |
| `publish_location` | `publish_location` |
| `cover` | `cover_urls`，统一转成 JSON array |
| `images` | `image_urls` |
| `video.url/video.urls` | `video_urls` |
| `audio.url/audio.urls` | `audio_urls` |
| `download_urls` | `download_urls`，array 保序；string 按换行拆成多个 URL 后存 JSON array |
| `share_url` | `share_url` |
| `stats.play_count` | 指标快照 `play_count` |
| `stats.like_count` | 指标快照 `like_count` |
| `stats.comment_count` | 指标快照 `comment_count` |
| `stats.collect_count` | 指标快照 `collect_count` |
| `stats.share_count` | 指标快照 `share_count` |

### 4.4 作品详情 `media_stats_number`

- 使用详情中的非空标题、正文、封面和资源地址补全 `media_content`；
- 详情字段优先于列表字段；
- 新值为 `null` 或缺键时，不覆盖已有非空内容；
- 每次详情调用都新增一条 `content_metric_snapshot`；
- raw 保存后、业务写入前，必须校验详情 `result.post_id` 与请求目标作品 ID 一致；不一致时不更新内容/指标，任务记 `partial` 并记录身份错误；
- 计数优先使用 `play_number/like_number/comment_number/collect_number/share_number`；
- `_number` 只有在缺失或为 `null` 时才尝试兼容 `_count`；非空但类型非法属于协议漂移，不能静默回退；
- `duration_number` 在供应商确认单位前只写 `duration_value`，并令 `duration_unit='unknown'`，不得作为秒数参与页面或指标计算；
- `data.action` 可能是 `media_stats`，不能要求它一定等于请求路径 `media_stats_number`。

### 4.5 评论 `post_comments_list`

写入 `media_comment`：

| JSON 字段 | 数据库字段 |
|---|---|
| `id` | `platform_comment_id` |
| `post_id` | 先定位 `media_content.id` |
| `content` | `content_text` |
| `author.id` | `author_platform_id` |
| `author.name` | `author_name` |
| `author.avatar` | `author_avatar_url` |
| `stats.like_count` | `like_count` |
| `stats.reply_count` | `reply_count` |
| `created` | `published_at` |
| `updated` | `source_updated_at` |

raw 保存后、业务写入前，先校验页级 `result.post_id`（若返回）以及每个 comment item 的 `post_id` 都与请求目标内容一致。任一 item 指向其他作品时，不得按返回的另一 `post_id` 写库；隔离该 item（高比例异常时隔离整页），任务记 `partial` 并记录身份错误。

评论唯一键使用 `(platform, content_id, platform_comment_id)`。相同评论再次出现时更新当前展示值，不新增重复评论。

### 4.6 通用类型转换

#### 时间

- 13 位时间戳按毫秒转换；
- 10 位时间戳按秒转换；
- 数据库存 UTC `DATETIME(3)`；
- 原始整数始终可从 `api_call_record` 找回。

#### 计数

- `null`：未知或未提供；
- `0`：真实返回的零值；
- `""`：空文本，不是 0；
- 缺键：本次没有返回，不覆盖旧值；
- 数字字符串：只在完整匹配非负整数时转换；
- 首选 `*_number` 为非法非空值时立即记录协议错误，只有缺失或 `null` 才回退 `*_count`。

#### URL 数组

- 普通 URL 字段：string URL 转为单元素数组；array 保持顺序并过滤非字符串；
- `download_urls` 是特殊 union：array 按普通规则处理；string 需按换行拆分、逐项 `strip`、过滤空行并保持原顺序。实测详情可能用双换行拼接多个 URL，不能把整段字符串当作一个 URL；
- `null` 保持未知；
- 空数组或空字符串表示供应商明确返回无元素；
- 不按 URL 文件名判断资源唯一性。

### 4.7 内容更新优先级

同一个作品可能先从列表发现，再调用详情。MVP 使用以下优先级：

```text
详情非空字段 > 列表非空字段 > 已有非空字段 > null/缺键
```

注意：`null` 和缺键都不能把已有非空字段覆盖掉；只有平台明确提供删除语义时，才清空字段。

---

## 5. 身份、分页和幂等规则

### 5.1 身份规则

- 账号唯一身份使用 `(platform, platform_native_id)`；
- 作品唯一身份使用 `(platform, platform_post_id)`；
- 评论唯一身份使用 `(platform, content_id, platform_comment_id)`；
- 昵称、标题、主页 URL都不是稳定主键；
- 列表 item 的 `user_id/sec_uid` 与目标账号明显不一致时：原始整页照常保存，但该 item 不写 `media_content`，账号任务标记 `partial` 并记录错误；
- 详情 `result.post_id` 必须等于请求目标 `post_id`，否则整份详情不写业务表；
- 评论页级及 item 级 `post_id` 必须指向请求目标内容，异作品 item 隔离且不参与评论结果；
- 不允许按昵称、标题或供应商返回的另一 ID 自动改绑。

### 5.2 分页规则

- 第一页传 `max_cursor=0`；
- 下一页优先使用响应中的非空 `max_cursor`；
- `max_cursor` 为空时兼容非空 `cursor`；
- 游标按原 JSON 类型保存到 `data_sync_task.next_cursor_json`，不能把字符串游标转整数；
- `has_more=false/0`：供应商已耗尽，正常完成；
- `has_more=true/1`：有有效下一页游标才继续；
- `has_more=null/缺键`：停止继续付费，任务记 `partial`，不能伪装完整；
- 游标重复、回到初始 0 或超过最大页数：停止并记 `partial`；
- 小红书实测页内发布时间乱序，因此不能因为“本页出现旧时间”就提前停止。

### 5.3 幂等规则

- `media_content` 依靠唯一键 upsert；
- `media_comment` 依靠唯一键 upsert；
- `content_metric_snapshot` 使用 `(content_id, source_call_id)` 唯一，避免同一 raw 重放产生重复快照；
- 同一账号、operation、游标在同一时刻只能有一个 in-flight 调用；
- parser 或数据库写入失败时，从已有 `api_call_record` 重放，不能重新调用供应商；
- 网络请求已经发出但本方 read timeout 时标 `outcome_unknown`，不要自动盲目重试，因为可能重复计费。

---

## 6. MySQL 8 表结构

### 6.1 表关系

```text
data_sync_run
  └─ data_sync_task ── platform_account
       └─ api_call_record

platform_account
  └─ media_content
       ├─ content_metric_snapshot
       └─ media_comment

api_call_record 作为 account/content/metric/comment 的 source_call_id 来源
```

### 6.2 `data_sync_run`：同步批次

```sql
CREATE TABLE data_sync_run (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_type VARCHAR(24) NOT NULL COMMENT 'scheduled/manual/retry/backfill',
  requested_scope JSON NOT NULL COMMENT 'profile/list/detail/comments 采集范围',
  status VARCHAR(24) NOT NULL COMMENT 'pending/running/succeeded/partial/failed/cancelled',
  total_accounts INT UNSIGNED NOT NULL DEFAULT 0,
  succeeded_accounts INT UNSIGNED NOT NULL DEFAULT 0,
  partial_accounts INT UNSIGNED NOT NULL DEFAULT 0,
  failed_accounts INT UNSIGNED NOT NULL DEFAULT 0,
  requested_by BIGINT UNSIGNED NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_sync_run_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 6.3 `platform_account`：平台账号当前资料

> 如果项目已有 A2 `PlatformAccount` 主表，可将下面的资料字段拆到 `platform_account_data`，并以现有账号 ID 作为主键；不要再创建第二套账号主档。

```sql
CREATE TABLE platform_account (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  platform VARCHAR(32) NOT NULL COMMENT 'douyin/kuaishou/xiaohongshu/wechat_channels',
  platform_native_id VARCHAR(191) NULL COMMENT 'sec_uid/平台稳定用户 ID',
  provider_user_id VARCHAR(191) NULL COMMENT '供应商 result.user_id',
  homepage_url TEXT NOT NULL,
  nickname VARCHAR(255) NULL,
  signature TEXT NULL,
  location_text VARCHAR(255) NULL,
  avatar_url TEXT NULL,
  profile_cover_url TEXT NULL,
  follower_count BIGINT UNSIGNED NULL,
  following_count BIGINT UNSIGNED NULL,
  like_count BIGINT UNSIGNED NULL,
  post_count BIGINT UNSIGNED NULL,
  extra_json JSON NULL COMMENT '少量需要业务使用的平台差异字段',
  status VARCHAR(24) NOT NULL DEFAULT 'enabled'
    COMMENT 'enabled/disabled/conflicted',
  profile_source_call_id BIGINT UNSIGNED NULL,
  profile_fetched_at DATETIME(3) NULL,
  content_synced_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_account_native_id (platform, platform_native_id),
  KEY idx_account_platform_status (platform, status),
  KEY idx_account_provider_user (platform, provider_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

首次录入时 `platform_native_id` 可以为空；主页或列表成功解析后再填充。MySQL 唯一索引允许多个 `NULL`，因此未解析账号不会互相冲突。

### 6.4 `data_sync_task`：批次中的账号任务

```sql
CREATE TABLE data_sync_task (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sync_run_id BIGINT UNSIGNED NOT NULL,
  platform_account_id BIGINT UNSIGNED NOT NULL,
  requested_scope JSON NOT NULL,
  status VARCHAR(24) NOT NULL
    COMMENT 'pending/queued/running/succeeded/partial/failed/cancelled',
  current_operation VARCHAR(32) NULL,
  next_cursor_json JSON NULL COMMENT '保留游标原 JSON 类型和值',
  has_more TINYINT NULL COMMENT '1/0/null；null 不代表 false',
  pages_fetched INT UNSIGNED NOT NULL DEFAULT 0,
  new_content_count INT UNSIGNED NOT NULL DEFAULT 0,
  stop_reason VARCHAR(64) NULL,
  last_error_code VARCHAR(64) NULL,
  last_error_message TEXT NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_sync_task_run_account (sync_run_id, platform_account_id),
  KEY idx_sync_task_status (status, updated_at),
  CONSTRAINT fk_sync_task_run
    FOREIGN KEY (sync_run_id) REFERENCES data_sync_run(id),
  CONSTRAINT fk_sync_task_account
    FOREIGN KEY (platform_account_id) REFERENCES platform_account(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 6.5 `api_call_record`：真实 API 调用和原始响应

```sql
CREATE TABLE api_call_record (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sync_task_id BIGINT UNSIGNED NULL,
  platform_account_id BIGINT UNSIGNED NULL,
  platform VARCHAR(32) NOT NULL,
  operation VARCHAR(32) NOT NULL
    COMMENT 'media_user_info/user_video_list/media_stats_number/post_comments_list',
  endpoint VARCHAR(255) NOT NULL,
  target_type VARCHAR(24) NOT NULL COMMENT 'account/content',
  target_ref VARCHAR(255) NOT NULL COMMENT '内部 ID 或脱敏后的目标引用',
  execution_mode VARCHAR(16) NOT NULL DEFAULT 'sync',
  request_url_redacted TEXT NOT NULL,
  request_body JSON NOT NULL,
  status VARCHAR(32) NOT NULL
    COMMENT 'started/raw_saved/succeeded/transport_failed/http_failed/business_failed/protocol_failed/outcome_unknown',
  http_status SMALLINT UNSIGNED NULL,
  response_content_type VARCHAR(255) NULL,
  response_headers_json JSON NULL COMMENT '只保留安全白名单 headers',
  response_body_gzip LONGBLOB NULL COMMENT '原始 HTTP entity bytes 的 gzip',
  response_body_sha256 CHAR(64) NULL COMMENT '压缩前原始 bytes 的 sha256',
  response_body_bytes BIGINT UNSIGNED NULL COMMENT '压缩前字节数',
  provider_code INT NULL,
  provider_status VARCHAR(32) NULL,
  provider_action VARCHAR(64) NULL,
  provider_task_id VARCHAR(191) NULL,
  provider_request_id VARCHAR(191) NULL,
  parse_status VARCHAR(24) NOT NULL DEFAULT 'not_started'
    COMMENT 'not_started/json_succeeded/envelope_succeeded/schema_succeeded/failed',
  parser_version VARCHAR(32) NULL,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  elapsed_ms BIGINT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL,
  response_received_at DATETIME(3) NULL,
  raw_saved_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_api_call_task (sync_task_id, id),
  KEY idx_api_call_account_time (platform_account_id, started_at),
  KEY idx_api_call_operation_status (platform, operation, status, started_at),
  KEY idx_api_call_provider_request (provider_request_id),
  CONSTRAINT fk_api_call_task
    FOREIGN KEY (sync_task_id) REFERENCES data_sync_task(id),
  CONSTRAINT fk_api_call_account
    FOREIGN KEY (platform_account_id) REFERENCES platform_account(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

实现规则：`status` 表示本次调用的最终结果，`parse_status` 只表示 JSON→包络→operation schema 的解析进度。明确未送达为 `transport_failed`；收到非 2xx 为 `http_failed`；HTTP 2xx 但 JSON/包络/schema 不合法为 `protocol_failed`；`code!=0/status!=succeeded/error!=null` 为 `business_failed`；请求可能已送达但没有响应为 `outcome_unknown`。operation-specific schema 通过后先写 `parse_status=schema_succeeded`，但主状态仍保持 `raw_saved`；只有后续业务事务成功，才把 `status` 改为 `succeeded`。

`response_body_gzip` 只能从 `NULL` 写入一次；重放 parser 只更新 `parse_status/parser_version/error_*` 和最终状态，不改原始 body、hash、HTTP 元数据。

### 6.6 `media_content`：作品当前基础信息

```sql
CREATE TABLE media_content (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  platform_account_id BIGINT UNSIGNED NOT NULL,
  platform VARCHAR(32) NOT NULL,
  platform_post_id VARCHAR(191) NOT NULL,
  platform_author_id VARCHAR(191) NULL,
  content_type VARCHAR(24) NOT NULL DEFAULT 'unknown'
    COMMENT 'video/image_text/unknown',
  author_name VARCHAR(255) NULL,
  title TEXT NULL,
  body_text LONGTEXT NULL,
  tags_text TEXT NULL,
  publish_location VARCHAR(255) NULL,
  published_at DATETIME(3) NULL,
  source_url TEXT NULL,
  share_url TEXT NULL,
  cover_urls JSON NULL,
  image_urls JSON NULL,
  video_urls JSON NULL,
  audio_urls JSON NULL,
  download_urls JSON NULL,
  extra_json JSON NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active'
    COMMENT 'active/deleted/hidden',
  latest_source_call_id BIGINT UNSIGNED NOT NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_platform_post (platform, platform_post_id),
  KEY idx_content_account_published (platform_account_id, published_at),
  KEY idx_content_status_updated (status, updated_at),
  CONSTRAINT fk_content_account
    FOREIGN KEY (platform_account_id) REFERENCES platform_account(id),
  CONSTRAINT fk_content_source_call
    FOREIGN KEY (latest_source_call_id) REFERENCES api_call_record(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### 6.7 `content_metric_snapshot`：互动指标快照

```sql
CREATE TABLE content_metric_snapshot (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_id BIGINT UNSIGNED NOT NULL,
  source_call_id BIGINT UNSIGNED NOT NULL,
  source_operation VARCHAR(32) NOT NULL COMMENT 'user_video_list/media_stats_number',
  play_count BIGINT UNSIGNED NULL,
  like_count BIGINT UNSIGNED NULL,
  comment_count BIGINT UNSIGNED NULL,
  collect_count BIGINT UNSIGNED NULL,
  share_count BIGINT UNSIGNED NULL,
  duration_value DECIMAL(20, 3) NULL COMMENT '供应商原始数值；单位未确认时不参与计算',
  duration_unit VARCHAR(16) NULL COMMENT 'seconds/milliseconds/unknown',
  observed_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_metric_content_call (content_id, source_call_id),
  KEY idx_metric_content_observed (content_id, observed_at),
  CONSTRAINT fk_metric_content
    FOREIGN KEY (content_id) REFERENCES media_content(id),
  CONSTRAINT fk_metric_source_call
    FOREIGN KEY (source_call_id) REFERENCES api_call_record(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

为什么单独建表：点赞等数据每天都会变化；如果直接覆盖在 `media_content`，后续无法展示增长趋势，也无法核对某次规则计算使用的指标。

### 6.8 `media_comment`：结构化评论当前数据

```sql
CREATE TABLE media_comment (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_id BIGINT UNSIGNED NOT NULL,
  platform VARCHAR(32) NOT NULL,
  platform_comment_id VARCHAR(191) NOT NULL,
  parent_platform_comment_id VARCHAR(191) NULL,
  root_platform_comment_id VARCHAR(191) NULL,
  author_platform_id VARCHAR(191) NULL,
  author_name VARCHAR(255) NULL,
  author_avatar_url TEXT NULL,
  content_text LONGTEXT NULL,
  like_count BIGINT UNSIGNED NULL,
  reply_count BIGINT UNSIGNED NULL,
  published_at DATETIME(3) NULL,
  source_updated_at DATETIME(3) NULL,
  last_source_call_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active'
    COMMENT 'active/deleted/hidden',
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_comment_identity (platform, content_id, platform_comment_id),
  KEY idx_comment_content_published (content_id, published_at),
  KEY idx_comment_author (platform, author_platform_id),
  CONSTRAINT fk_comment_content
    FOREIGN KEY (content_id) REFERENCES media_content(id),
  CONSTRAINT fk_comment_source_call
    FOREIGN KEY (last_source_call_id) REFERENCES api_call_record(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

评论表包含个人展示信息，普通页面查询必须经过权限控制；默认不要下载评论头像，也不要将作者 ID 批量导出。

---

## 7. 最小处理代码结构

### 7.1 外部只需要一个调用入口

调用方只需要表达“同步哪个账号、同步哪些范围”，不应知道供应商字段和分页细节：

```python
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class SyncRequest:
    platform_account_id: int
    include_profile: bool = False
    include_content_list: bool = True
    detail_policy: Literal["none", "new_only"] = "new_only"
    comment_policy: Literal["none", "selected"] = "none"


def request_account_sync(request: SyncRequest) -> int:
    """创建 data_sync_run/data_sync_task 并返回任务 ID，不在 Web 请求里等待供应商。"""
    return sync_repository.enqueue(request)
```

### 7.2 单次付费调用：必须先保存 raw

```python
from __future__ import annotations

import gzip
import hashlib
import json
from typing import Any


class ProviderProtocolError(RuntimeError):
    pass


class ProviderHttpError(RuntimeError):
    pass


class ProviderBusinessError(RuntimeError):
    pass


def execute_paid_call(
    *,
    call_id: int,
    operation: str,
    endpoint: str,
    request_body: dict[str, Any],
) -> dict[str, Any]:
    started = clock.now()
    try:
        response = http_client.post(
            endpoint,
            params={"async": "false"},
            json=request_body,
        )
    except ConnectBeforeSendError as exc:
        call_repository.mark_transport_failed(call_id, str(exc))
        raise
    except RequestOutcomeUnknownError as exc:
        call_repository.mark_outcome_unknown(call_id, str(exc))
        raise

    raw_body = response.content
    raw_sha256 = hashlib.sha256(raw_body).hexdigest()

    # 这一步必须提交成功；失败时不能继续 JSON 解析。
    call_repository.save_raw_and_commit(
        call_id=call_id,
        http_status=response.status_code,
        safe_headers=select_safe_headers(response.headers),
        body_gzip=gzip.compress(raw_body),
        body_sha256=raw_sha256,
        body_bytes=len(raw_body),
        elapsed_ms=clock.elapsed_ms(started),
    )

    try:
        payload = json.loads(raw_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        if not 200 <= response.status_code < 300:
            call_repository.mark_http_failed(
                call_id,
                http_status=response.status_code,
                parse_error=str(exc),
            )
            raise ProviderHttpError(
                f"HTTP {response.status_code}；非 JSON 原始响应已保存"
            ) from exc
        call_repository.mark_protocol_failed(
            call_id,
            parser_version=parser_version(),
            stage="json",
            message=str(exc),
        )
        raise ProviderProtocolError("响应不是有效 JSON；已保存原始响应") from exc

    if not 200 <= response.status_code < 300:
        call_repository.mark_http_failed(
            call_id,
            http_status=response.status_code,
            parsed_error=payload,
        )
        raise ProviderHttpError(f"HTTP {response.status_code}；详细内容见 api_call_record")

    if not isinstance(payload, dict):
        call_repository.mark_protocol_failed(
            call_id,
            parser_version=parser_version(),
            stage="envelope",
            message="top level is not object",
        )
        raise ProviderProtocolError("响应顶层不是 object")

    if payload.get("code") != 0:
        call_repository.mark_business_failed(call_id, payload)
        raise ProviderBusinessError("供应商 code 非 0；详细内容见 api_call_record")

    data = payload.get("data")
    if not isinstance(data, dict):
        call_repository.mark_protocol_failed(
            call_id,
            parser_version=parser_version(),
            stage="envelope",
            message="data is not object",
        )
        raise ProviderProtocolError("data 缺失或不是 object")

    if data.get("status") != "succeeded" or data.get("error") is not None:
        call_repository.mark_business_failed(call_id, payload)
        raise ProviderBusinessError("供应商任务未成功；详细内容见 api_call_record")

    result = data.get("result")
    if not isinstance(result, dict):
        call_repository.mark_protocol_failed(
            call_id,
            parser_version=parser_version(),
            stage="envelope",
            message=f"result is {type(result).__name__}, expected object",
        )
        raise ProviderProtocolError("成功包络的 result 不是 object")

    try:
        parsed_result = operation_parsers.parse(operation, result)
    except (TypeError, ValueError, ProviderProtocolError) as exc:
        call_repository.mark_protocol_failed(
            call_id,
            parser_version=parser_version(),
            stage="operation_schema",
            message=str(exc),
        )
        raise ProviderProtocolError("operation schema 校验失败；已保存原始响应") from exc

    # 只有 JSON、统一包络和 operation-specific schema 都通过后才标解析完成；
    # 整体 status 仍保持 raw_saved，待后续业务事务成功后再改为 succeeded。
    call_repository.mark_schema_succeeded(
        call_id=call_id,
        parser_version=parser_version(),
        provider_code=payload["code"],
        provider_status=data["status"],
        provider_action=data.get("action"),
        provider_task_id=data.get("task_id"),
        provider_request_id=payload.get("request_id"),
    )
    return parsed_result
```

这段代码只表达顺序。生产实现还要配置 connect/read timeout、令牌桶、有限 worker 和安全日志，但不能把保存 raw 移到解析之后。

### 7.3 类型转换函数

```python
from datetime import datetime, timezone
from typing import Any


MISSING = object()


def _strict_count(value: Any, *, field_name: str) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    raise ProviderProtocolError(f"{field_name} 是非法非空计数: {value!r}")


def nullable_int(
    number_value: Any = MISSING,
    count_value: Any = MISSING,
    *,
    number_field: str = "*_number",
    count_field: str = "*_count",
) -> int | None:
    # 新数值字段只在缺失或 null 时才允许回退；非法非空值必须暴露 schema 漂移。
    if number_value is not MISSING and number_value is not None:
        return _strict_count(number_value, field_name=number_field)
    if count_value is MISSING or count_value is None:
        return None
    return _strict_count(count_value, field_name=count_field)


def timestamp_to_utc(value: Any) -> datetime | None:
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    seconds = value / 1000 if value >= 100_000_000_000 else value
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def url_list(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return None


def download_url_list(value: Any) -> list[str] | None:
    if isinstance(value, str):
        return [part.strip() for part in value.splitlines() if part.strip()]
    return url_list(value)
```

### 7.4 解析成功后的事务

每一页或每一个详情响应使用一个业务事务：

```text
BEGIN
  → upsert platform_account 或 media_content
  → insert content_metric_snapshot（如有）
  → upsert media_comment（如有）
  → 更新 data_sync_task 页数、游标和计数
  → 将 api_call_record 标为 succeeded
COMMIT
```

业务事务失败时回滚业务表，但已提交的原始响应保留。修复程序后根据 `api_call_record.id` 重新处理，不发新的供应商请求。

---

## 8. 四类接口的落库流程

### 8.1 主页资料

```text
media_user_info
  → raw 写 api_call_record
  → 校验 result.user_id
  → 更新 platform_account 当前资料
  → profile_source_call_id = 本次 call_id
  → profile_fetched_at = 本次观测时间
```

不需要每天调用所有账号主页。首次录入、用户主动刷新或按配置周期刷新即可。

### 8.2 作品列表

```text
user_video_list 第一页
  → raw 写 api_call_record
  → 逐 item 校验账号身份
  → upsert media_content
  → 每个有效 item 插入指标快照
  → 判断 has_more 和 next_cursor
  → 必要时请求下一页
```

MVP 必须保存每页独立的 `api_call_record`。不能把多页响应拼成一个无法核对的大 JSON。

### 8.3 作品详情

```text
列表发现新 post_id
  → 根据平台规则取得详情 URL
  → media_stats_number
  → raw 写 api_call_record
  → 校验 result.post_id = 请求目标 post_id
  → 用详情非空字段补全 media_content
  → 新增 content_metric_snapshot
```

默认只对新内容调用详情。旧内容只有用户主动刷新或业务明确需要最新指标时才调用。

### 8.4 评论

```text
内容被选中需要评论
  → 检查平台 capability
  → post_comments_list，默认 reply_pages=-1
  → raw 写 api_call_record
  → 校验页级及每条评论 post_id = 请求目标内容
  → upsert media_comment
  → 按 has_more/cursor 决定是否继续
```

- 快手评论直接拒绝，不请求供应商；
- 小红书和抖音按需采集；
- 默认不抓回复，避免调用时间、数据量和费用扩大；
- 已有结构化评论时，展示文本由本地拼接，不再调用 `media_comments`。

---

## 9. 2,000 个账号怎么跑

### 9.1 页面查看和数据采集分开

用户打开“2,000 个账号列表”时，页面只查询 MySQL，不立即触发 2,000 次供应商请求。账号数据由定时同步和少量手工刷新提前写入数据库。

### 9.2 建议的 MVP 频率

以下只是初始业务配置，不是供应商合同：

| 数据 | 建议初始频率 |
|---|---|
| 作品列表第一页 | 日常批次，根据业务新鲜度配置 |
| 主页资料 | 首次录入 + 较低频刷新 |
| 列表后续页 | 有新内容、has_more 为真且未达到页数/预算上限时 |
| 作品详情 | 仅新增内容或用户主动刷新 |
| 评论 | 仅被选中的内容 |

### 9.3 并发方式

- 2,000 个账号先生成 2,000 个 `data_sync_task`；
- 交给 BullMQ 或现有任务队列；
- worker 数和 QPS 使用配置，不写死；
- 供应商未确认 QPS 前从低并发灰度；
- 按 provider + platform + operation 限流；
- 遇到 429 按 `Retry-After` 降速；
- 禁止 `Promise.all(2000)` 或在一个 Web 请求里串行等待全部账号。

### 9.4 控制调用费用

1. 同一个账号/operation/cursor 防止重复 in-flight；
2. 详情只抓新增内容；
3. 评论只抓选中内容；
4. 同一作品只调用 `media_stats_number`，不再重复调用 `media_stats`；
5. 已有结构化评论时不调用评论文本接口；
6. parser 失败从 raw 重放；
7. 快手评论和视频号主页列表在调用前阻断；
8. 未确认价格和分页计费前设置 `max_pages_per_task` 和批次调用上限；
9. 每次调用保存 `task_id/request_id`，但最终费用仍以供应商账单为准。

---

## 10. 查询示例

### 10.1 内容列表及最新指标

```sql
SELECT
  c.id,
  c.platform,
  c.platform_post_id,
  c.title,
  c.cover_urls,
  c.published_at,
  m.play_count,
  m.like_count,
  m.comment_count,
  m.collect_count,
  m.share_count,
  m.observed_at
FROM media_content AS c
LEFT JOIN content_metric_snapshot AS m
  ON m.id = (
    SELECT m2.id
    FROM content_metric_snapshot AS m2
    WHERE m2.content_id = c.id
    ORDER BY m2.observed_at DESC, m2.id DESC
    LIMIT 1
  )
WHERE c.platform_account_id = ?
  AND c.status = 'active'
ORDER BY c.published_at DESC, c.id DESC
LIMIT ? OFFSET ?;
```

MVP 数据量下可以先使用该查询；若后续性能不足，再增加 `latest_metric_snapshot_id` 缓存指针或专用读模型，不必首期实现。

### 10.2 指标趋势

```sql
SELECT
  observed_at,
  play_count,
  like_count,
  comment_count,
  collect_count,
  share_count
FROM content_metric_snapshot
WHERE content_id = ?
  AND observed_at >= ?
  AND observed_at < ?
ORDER BY observed_at ASC, id ASC;
```

---

## 11. 异常如何处理

| 异常 | MVP 处理 |
|---|---|
| DNS/TCP 等明确未送达 | 无 response body，标 `transport_failed`，按预算策略有限重试 |
| HTTP 非 2xx，但有响应 body | 先保存 raw，再标 `http_failed` |
| HTTP 200，`code!=0` 或任务 failed | 保存 raw，标 `business_failed`，不写业务表 |
| HTML 或空 502 等非 2xx body | 保存 raw，主状态 `http_failed`；JSON 无法解析时 `parse_status=failed` |
| HTTP 2xx 但 JSON 截断/顶层/包络/schema 非法 | 保存 raw，标 `protocol_failed`，不写业务表 |
| 请求写出后 read timeout/连接重置 | 标 `outcome_unknown`，不盲目自动重试 |
| `result` 或 operation 字段类型变化 | 保存 raw，标 `protocol_failed/parse_status=failed`，等待 parser 修复 |
| 列表账号、详情作品或评论所属作品身份不一致 | raw 保留，异常数据不入业务表，任务 `partial` 并记录身份错误 |
| `has_more=true` 但游标为空 | 停止翻页，任务 `partial` |
| `has_more=null/缺键` | 停止继续付费，任务 `partial` |
| 业务事务失败 | 回滚业务表，从同一 raw 重放 |
| 快手评论/视频号主页列表 | 调用前拒绝，不产生费用 |

---

## 12. 开发顺序

按下面顺序实现，任何一步都可独立验收：

1. 创建 7 张表；
2. 实现 `api_call_record` 的 started、raw save、parse status；
3. 使用已有本地 JSON 完成四类 parser，不调用真实 API；
4. 实现账号和内容 upsert；
5. 实现指标快照追加；
6. 实现评论 upsert；
7. 实现游标分页和 `data_sync_task` 状态；
8. 接入 BullMQ/现有队列和有限并发；
9. 完成账号列表、内容详情和同步状态查询；
10. 经用户批准后做最小真实 smoke，不做 2,000 账号真实压测。

### 12.1 parser 测试直接复用现有 raw

至少覆盖：

- 抖音列表 20 条、integer `max_cursor`；
- 小红书列表 22 条、string `max_cursor`；
- 小红书主页粉丝 48、作品 317；
- 小红书详情点赞 45、评论 9、收藏 44、分享 37；
- 小红书评论 5 条主评论、`total=9`、`has_more=0`；
- 抖音列表中的异 `sec_uid` item 不进入目标账号内容；
- `cover` 的 string/list 差异；
- 详情 `download_urls` 的双换行字符串被拆成有序 URL array；
- `*_number` 非空非法类型不能静默回退到 `*_count`；
- 未确认单位的 `duration_number` 只保存中性值并标 `unknown`；
- 详情和评论返回异 `post_id` 时不写目标作品；
- `null/0/空串/缺键`；
- 非 JSON、空 body 和截断 JSON先保存再按 HTTP/协议状态分类。

这些测试全部使用本地文件，不产生 API 费用。

---

## 13. MVP 完成定义

满足以下条件即可认为数据供给 MVP 完成：

- [ ] 所有供应商调用显式使用 `async=false`；
- [ ] 每个收到的 HTTP 响应都在解析前保存原始 bytes、hash 和脱敏请求；
- [ ] parser 失败可从 `api_call_record` 本地重放，不重新调用供应商；
- [ ] 账号资料能落入 `platform_account`；
- [ ] 作品列表/详情能 upsert 到 `media_content`；
- [ ] 每次互动数据能追加到 `content_metric_snapshot`；
- [ ] 结构化评论能 upsert 到 `media_comment`；
- [ ] integer/string 游标均能原样分页并检测循环；
- [ ] `has_more=null/缺键` 不会被误判为完整；
- [ ] `null` 不会被自动改成 0，非法非空 `*_number` 不会静默回退；
- [ ] 列表异账号 item、详情异 `post_id`、评论异作品 item 都不会污染目标数据；
- [ ] `download_urls` 的 array 与多行 string 都能归一为正确的有序 URL array；
- [ ] 未确认单位的 `duration_number` 不会被当作秒参与计算；
- [ ] transport/HTTP/business/protocol/outcome_unknown 状态分类一致，operation schema 通过后才标解析完成；
- [ ] 快手评论、视频号主页列表会在调用前阻断；
- [ ] 2,000 个账号通过队列和有限并发运行，页面不等待外部 API；
- [ ] 内容详情页能组合展示内容基础数据、最新指标和评论；
- [ ] API Key 不进入数据库、日志或文档。

---

## 14. 什么时候再升级到详细版

出现下面任一情况时，再从本 MVP 演进，而不是现在一次性全部建设：

| 触发条件 | 后续升级 |
|---|---|
| raw body 明显影响 MySQL 备份和存储 | response gzip 迁移 OSS，MySQL 只留 URI/hash |
| parser v2 与 v1 结果都必须长期可查询 | 增加不可变 normalization revision/current projection |
| 接入第二家数据供应商 | 增加正式 capability registry 和 provider adapter |
| 大量系统订阅内容变化 | 增加 transactional outbox，必要时再接 Kafka |
| 需要稳定下载、去重和管理视频/图片 | 增加 Asset/AssetBinding/sha256 资产目录 |
| AI 摘要、改写、分镜、生成视频正式上线 | 增加 DerivedAsset 和输入/模型/Prompt 血缘 |
| 评论删除必须跨搜索、向量和 AI 链路传播 | 增加正式 privacy deletion workflow |

在这些需求真正出现前，7 张表和一条清晰的数据处理链路足以支撑当前 MVP。

---

## 15. 仍需向供应商确认

以下问题不影响先实现 MVP，但不能由代码自行猜测：

1. 各平台、各接口的 QPS、burst 和最大并发；
2. 单价、分页计费、失败计费、重试计费；
3. `task_id/request_id` 与账单的关联方式；
4. `created/updated` 的正式时间单位；
5. `duration_number` 的正式单位；
6. `has_more/max_cursor/cursor` 的稳定合同；
7. 评论 `total` 是否包含回复；
8. signed URL 的有效期和下载许可；
9. 快手评论、视频号各项能力的正式支持矩阵。

在这些信息确认前，生产配置必须采用保守并发、页数上限和预算上限。