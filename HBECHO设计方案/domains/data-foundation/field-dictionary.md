# 域 A · 字段字典

> **日期**：2026-10-28
> **作用**：定义 A 域把供应商返回的原始 JSON 规范化成什么字段、每个字段是什么意思、值状态如何保留。
> **边界**：本文只定义**观察到的事实**；不定义 OCR/ASR/视觉等派生解释（归 C），不定义业务判定（归 D），不定义指标口径（归 E）。
>
> **掌握度（2026-10-28）**：结构 **100%**，语义 **约 85%**。未确认的 10 项见 §七；核对样本见 [`aimaster接口文档/字段核对样本.md`](../../../aimaster接口文档/字段核对样本.md)。
>
> **怎么找**：其他会话从 `CLAUDE.md` → `HBECHO设计方案/INDEX.md` → 本文件。

---

## 一、谁定什么

| 层 | 拥有什么 | 例子 |
|---|---|---|
| **A 数据底座** | 原始事实的规范字段、类型、值状态、来源与观察时点 | 头像 URL、昵称、发布时间、点赞数、封面候选 |
| **C 识别** | 从事实里抽出的派生信号 | OCR 文字、ASR 转写、画面里有没有室内机、向量 |
| **D 规则** | 业务判定 | 这条内容是否命中"618 活动" |
| **E 指标** | 口径与聚合 | 完成率、互动总量怎么算、怎么上卷 |
| **CONTEXT** | 领域词汇与不变量 | 什么是 Content、MediaAsset、AccountAssignment |

**A 只回答"看到了什么"，不回答"这意味着什么"。**

**存储也归 A。** 原始 JSON 先落 ODS OSS，再由 A 规范化入业务表；媒资下载后也由 A 存 OSS。C/D/E 只读 A 提供的事实，不决定"存在哪、怎么存"。

---

## 二、主页 `media_user_info`

| 规范字段 | 来源字段 | 含义 | 值状态 |
|---|---|---|---|
| `account_id_text` | `user_id` | 平台账号 ID，原文 | 必有 |
| `nickname` | `nickname` | 昵称 | valid/missing/null |
| `signature` | `signature` | 签名，可含换行 | 同上 |
| `location` | `location`（仅抖音） | 地区 | 同上 |
| `avatar_urls` | `avatar`（仅抖音） | 头像候选 URL | missing（小红书）/valid |
| `background_urls` | `cover`（仅抖音） | 主页背景候选 URL | missing（小红书）/valid |
| `follower_count` | `follower_number` 优先，`follower_count` 回退 | 粉丝数 | valid/missing/null/invalid |
| `following_count` | 同上 | 关注数 | 同上 |
| `like_count` | 同上 | 获赞与收藏 | 同上 |
| `post_count` | 同上 | 作品数 | 同上 |
| `provider_updated_at` | `updated` | 供应商更新时间（毫秒） | valid/missing |
| `observed_at` | 系统时间 | 本次观察时点 | 必有 |

**注意**：小红书主页没有 `avatar`、`cover`、`location`。

---

## 三、内容列表 `user_video_list`

| 规范字段 | 来源字段 | 含义 | 值状态 |
|---|---|---|---|
| `platform_content_id` | `post_id` | 平台内容 ID，原文 | 必有 |
| `author_id_text` | `user_id` | **作者**的平台 ID，可能不等于被采集账号 | 必有 |
| `author_sec_uid` | `sec_uid`（仅抖音） | 作者的第二标识 | missing/valid |
| `author_name` | `author_name` | 作者昵称 | valid/missing |
| `published_at` | `created` | 发布时间（毫秒→UTC） | valid/missing |
| `publish_location` | `publish_location`（抖音） | 发布地 | valid/missing |
| `title` | `title` | 标题；小红书含 `## 标题/## 正文` 标记，A 负责拆分并保留原文 | valid/missing |
| `body_text` | `text.content`（小红书） | 正文 | valid/missing |
| `tag_text` | `tag_text` | 话题文本；小红书可能为空 | valid/missing |
| `stats.like_count` | `stats.like_count` | 点赞数 | valid/missing/unsupported |
| `stats.comment_count` | `stats.comment_count` | 评论数 | 同上 |
| `stats.collect_count` | `stats.collect_count` | 收藏数 | 同上 |
| `stats.share_count` | `stats.share_count` | 分享数 | 同上 |
| `stats.play_count` | `stats.play_count`（仅抖音） | **不支持**；抖音返回 0 是占位，小红书无字段 | unsupported |
| `cover_urls` | `cover` | 封面候选；抖音数组、小红书字符串 | valid/missing |
| `image_urls` | `images` | 图文图片候选 | valid/missing |
| `video_urls` | `video.urls` + `video.url` | 视频候选 | valid/missing |
| `audio_urls` | `audio.urls` + `audio.url` | 音频候选 | valid/missing |
| `duration_seconds` | `video.duration` | 时长（秒） | valid/missing/unknown |
| `content_kind` | **由 A 推断，不是 JSON 字段** | `video` / `image` / `text` / `unknown` | 见规范化规则 |
| `share_url` | `share_url`（抖音） | 分享页地址 | valid/missing |
| `position_in_page` | 返回顺序 | 第几条 | 必有 |
| `is_potentially_pinned` | 前三位置 | 可能置顶 | 布尔 |

**注意**：同一作品出现在两个账号的列表里时，各存一条（按账号）。

---

## 四、内容详情 `media_stats_number`

| 规范字段 | 来源字段 | 含义 |
|---|---|---|
| `platform_content_id` | `post_id` | 内容 ID |
| `author_id_text` | `user_id` | 作者 ID |
| `author_name` | `author_name` | 作者昵称 |
| `author_homepage` | `author_homepage` | 作者主页 URL（2026-10-28 新增） |
| `published_at` | `created` | 发布时间 |
| `title` / `body_text` / `tag_text` | `title` / — / `tag_text` | 文本 |
| `stats.play_count` | `play_number` 优先，`play_count` 回退 | 播放数（小红书可能为空） |
| `stats.like_count` | `like_number` 优先 | 点赞 |
| `stats.comment_count` | `comment_number` 优先 | 评论 |
| `stats.collect_count` | `collect_number` 优先 | 收藏 |
| `stats.share_count` | `share_number` 优先 | 分享（已由用户后台验证为分享数） |
| `duration_seconds` | `duration_number` 优先 | 时长 |
| `cover_urls` | `cover` | 详情里是**字符串**，需转成候选数组 |
| `video_urls` / `image_urls` | `download_urls` | 详情里是**字符串**；需结合内容形态判断 |
| `publish_location` | `publish_location` | 发布地 |
| `related_search` | `related_search_str` | 搜索推荐词，**不是内容正文** |
| `provider_updated_at` | `updated` | 供应商更新时间 |

**注意**：`*_count` 在详情里为 null，实际值在 `*_number`；`action` 返回为 `media_stats`，与请求名不同。

---

## 五、评论 `post_comments_list`

| 规范字段 | 来源字段 | 含义 |
|---|---|---|
| `comment_id` | `id` | 评论 ID |
| `content_id` | `post_id` | 所属内容 |
| `parent_comment_id` | `parent_id` | 父评论；为空表示一级评论 |
| `content_text` | `content` | 评论正文，含表情占位 |
| `author_id_text` | `author.id` | 评论作者 ID（**不建账号**） |
| `author_name` | `author.name` | 作者昵称 |
| `author_avatar_url` | `author.avatar` | 头像 URL（**不下载**） |
| `like_count` | `stats.like_count` | 点赞 |
| `reply_count` | `stats.reply_count` | 该评论的回复数 |
| `created_at` | `created` | 评论时间 |
| `provider_updated_at` | `updated` | 供应商更新时间 |
| `is_liked` | `is_liked` | 语义未确认（可能是采集账号视角） |

**注意**：`total` 是评论总数（含回复），不是本次返回条数；回复与一级评论在同一个数组里，用 `parent_id` 区分。

---

## 六、规范化规则（A 负责）

| # | 规则 |
|---|---|
| 1 | 时间戳是毫秒 epoch，统一转 UTC；`created` 是发布时间，`updated` 是供应商更新时间，不能混用。 |
| 2 | 时长统一按秒；列表 `video.duration` 是 float，详情 `duration_number` 是 int。 |
| 3 | `*_count` 与 `*_number` 同时存在时，优先取有效值，另一个作为回退；都为 null 记 missing。 |
| 4 | 真实 0、缺失、显式 null、非法值、**不支持**五态分开；列表播放数是"不支持"。 |
| 5 | 小红书 `title` 含 `## 标题/## 正文` 标记：拆成 `title` 与 `body_text`，原始文本保留在 ODS。 |
| 6 | `content_kind` 推断：**JSON 没有显式类型字段**；有视频 URL → `video`；无视频但有图片 → `image`；只有文本 → `text`；字段缺失或矛盾 → `unknown`。 |
| 7 | 多条 URL：保留全部候选。**封面只归档第 2 条**（固定 540 宽，是展示封面的压缩版）；第 1 条可能是首帧、也可能是同一张图，第 3 条尺寸不固定。**视频主地址不要用 `video.url`**——它可能指向 403 的 CDN 对象；优先可访问的 `api-play.amemv.com` / `api.amemv.com` 的 720p h264 变体。 |
| 8 | 外部 ID 一律原文；不转数字、不去前导零。 |
| 9 | 未知字段保留在 ODS，解析层忽略，不报错。 |
| 10 | 条目的字段集合不保证齐全；缺字段按 missing 处理，不假设 schema。 |

---

## 七、尚未确认的字段语义

| # | 字段 | 问题 | 影响 |
|---|---|---|---|
| 1 | ~~`cover`（抖音列表 3 条）~~ | **已确认（82 条样本，61 条可验证）**：① 有自定义封面时，cover1 = 首帧、cover2/cover3 = 选中封面；② 无自定义封面时，三张是同一张图的三个尺寸。**固定规律只有尺寸：第 2 条永远是 540 宽**。存第 2 条作为压缩封面 | 已定 |
| 2 | ~~`download_urls`（抖音列表 10 条）~~ | **已确认**：只有 4 条可下载（dl3/4=720p h264 6.45MB，dl7/8=1080p hevc 7.35MB），其余 6 条 403；**`video.url` 指向 403 对象** | 主地址用可访问的 720p 变体 |
| 3 | `red_id` | 21 条样本全部为空 | 暂不落业务字段 |
| 4 | `is_liked` | 44 条样本全部为 false | 暂不落业务字段 |
| 5 | `related_search_str` | 是搜索推荐词，不是内容正文 | 单独保存或忽略 |
| 6 | ~~`updated`~~ | **已确认**：`created` 是发布时间，`updated` 是抓取时间 | 保留两者，分开命名 |
| 7 | ~~`reply_count` vs `reply_page_count`~~ | **两次验证**：98/24/11 与 125/4/3；前者=回复条数，后者=有回复的父评论数 | 已定 |
| 8 | `audio.type` | 实测为 null | 是否需要 |
| 9 | 小红书 `share_number` | 已验证为分享数 | 已确认 |
| 10 | 小红书 `play_number` | 图文与视频均为 null | 平台不提供 |

---

## 八、A 不做的事

- 不解码图片内容（C）；
- 不做 OCR、ASR、视觉识别（C）；
- 不判断内容是否合规或达标（D）；
- 不定义互动指标怎么聚合（E）；
- 不把临时 URL 当资产身份（永不）。

## 九、平台差异（2026-10-28 实测）

| 项 | 抖音 | 小红书 | 快手 | 视频号 |
|---|---|---|---|---|
| 主页头像 / 背景 | ✅ | ❌ | ❌ | ❌（无主页接口） |
| 主页位置 | ✅ | ❌ | ❌ | — |
| 内容列表 | ✅ | ✅ | ✅（可分页，游标为科学计数法字符串） | ❌ |
| 列表封面 | 数组 3 条 | 单条字符串 | 单条字符串 | — |
| 列表下载地址 | 数组 10 条（仅 4 条可用） | 空数组 | 无数组，但有 `video.url` | — |
| 详情下载地址 | 字符串（部分 403） | 字符串 | 字符串 | **空字符串** |
| 评论 | ✅ | 部分（无法翻页） | ❌ | ❌ |
| 播放数 | 详情有 | 详情也为空 | 详情有 | 详情为 0 |
| `sec_uid` | ✅ | ❌ | ❌ | ❌ |
| `author_homepage` | ✅（详情） | ✅（详情） | ✅（详情） | ✅（详情） |

**要点**：

- 快手主页只有 12 个字段，没有头像、背景、位置；
- 视频号只有单条视频详情，没有主页、列表、评论，也没有视频下载地址；
- 快手的列表条目没有 `download_urls` 数组，但有 `video.url`。
