# 经销商社媒监控系统（lxk-BigSpard）

自动化监控多品牌（海信、日立、约克）经销商门店在各社媒平台（抖音、视频号、小红书）的运营数据。**手动触发**采集粉丝数、视频列表、互动量等指标，通过 Web 管理界面查阅，并支持营销活动（春节、五一、国庆等）期间的分品牌、分平台关键词命中视频统计。

---

## 项目背景

公司旗下三大品牌（海信、日立、约克）共有 100+ 家经销商/门店，各门店在多个社媒平台独立运营账号。需要：
- 统一监控各账号运营数据（粉丝增长、视频更新、互动量）
- 结合门店业务字段（大区、分公司、品牌、门店编码等）进行分析
- 追踪重大营销节点（春节、五一、国庆）期间的账号表现

---

## 技术栈

| 层 | 技术 |
|---|---|
| 爬虫 | Node.js + Puppeteer-core + puppeteer-extra-plugin-stealth |
| 浏览器 | Chromium（容器内）/ Google Chrome（本地） |
| 数据库 | MySQL 8.0 |
| Web 服务 | Node.js + Express + 登录页会话鉴权 |
| 前端 | 纯 HTML/CSS/JS |
| 容器化 | Docker + Docker Compose |
| 反向代理 | Nginx（宝塔面板管理） |
| AI 赋能 | 阿里云通义千问（DashScope）— qwen-plus / qwen3-asr-flash |

---

## 项目结构

```
lxk-BigSpard/
├── docker-compose.yml         # 生产环境编排（3个服务）
├── docker-compose.dev.yml     # 本地开发（仅启动 MySQL）
├── .env                       # 环境变量（不提交 git）
├── .env.example               # 环境变量模板
│
├── scraper/                   # 爬虫服务
│   ├── Dockerfile
│   └── src/
│       ├── index.js               # 入口（--test / --run-now / --campaign / --daemon）
│       ├── scheduler.js           # 全量爬取逻辑（批次/重试/浏览器重启，手动触发）
│       ├── scraper.js             # 完整爬虫（profile + 视频列表），XHR 拦截模式，抖音专用
│       ├── scraperBg.js           # 背景图爬虫（profile only，SSR 解析，5-8s/账号），抖音专用
│       ├── accountLoader.js       # 从 DB 读取待爬 dealer_staff 批次
│       ├── db.js                  # MySQL 连接池
│       ├── imageDownloader.js     # 头像/背景图下载
│       ├── importAccounts.js      # 批量导入社媒账号（支持多平台，已废弃，改用 importCampaignMembers）
│       ├── importDealers.js       # 从「全部字段.csv」导入经销商业务数据（仅门店档案）
│       └── importCampaignMembers.js # 从活动 CSV 导入门店+专员+账号+活动打标（一步到位）
│
├── web/                       # Web 管理服务
│   └── src/
│       ├── server.js          # Express 入口 + 登录会话鉴权
│       ├── db.js              # MySQL 连接池
│       ├── public/            # 前端静态文件
│       │   ├── index.html     # 账号列表（粉丝/视频排行）
│       │   ├── videos.html    # 视频列表
│       │   ├── campaigns.html # 活动管理（营销节点统计）
│       │   ├── excellent-videos.html # 优秀视频赋能（AI 分析、仿写脚本）
│       │   ├── logs.html      # 爬取日志
│       │   └── settings.html  # 系统配置
│       └── routes/
│           ├── accounts.js    # 账号列表/详情（JOIN dealer_staff + dealers）
│           ├── videos.js      # 视频列表
│           ├── campaigns.js   # 活动 CRUD + 成员打标 + 统计计算
│           ├── excellent-videos.js # 优秀视频列表（按点赞排序，含 AI 字段）
│           ├── ai.js          # AI 赋能接口（ASR 转写、内容分析、仿写脚本）
│           ├── snapshots.js   # 每日快照（趋势）
│           ├── keywords.js    # 关键词配置
│           ├── logs.js        # 爬取日志
│           └── settings.js    # 系统配置
│
├── mysql/
│   └── init.sql               # 建库建表 + 默认配置（首次启动自动执行）
│
├── cookies/
│   ├── douyin_cookies.json    # 抖音登录 Cookie（不提交 git）
│   └── HOW_TO_EXPORT_COOKIES.md
│
├── images/                    # 头像/背景图本地缓存（volume 挂载）
└── scripts/                   # 运维脚本
```

---

## 数据库设计

> 📖 **详细文档**：`HBECHO设计方案/database-design.md`（旧项目原始路径，未随本仓库迁移；本文仅作历史记录，当前基线见 [`HBECHO设计方案/domains/data-foundation/database-design-v2.md`](../../../../domains/data-foundation/database-design-v2.md)） - 包含完整 ER 图、字段说明、表关系、常见查询示例

### 表概览

| 表名 | 说明 |
|---|---|
| `dealers` | 物理门店主档（品牌、大区、门店编码等业务字段，不含人员信息） |
| `dealer_staff` | 门店专员 + 社媒账号（一行 = 一人 + 一平台，含 `is_certified`/`bg_match_standard` 字段） |
| `videos` | 视频记录（只存命中关键词的视频，关联 `dealer_staff.id`） |
| `account_snapshots` | 每日快照（粉丝/点赞趋势，关联 `dealer_staff.id`） |
| `keywords` | 全局关键词过滤配置（为空时不过滤） |
| `scrape_logs` | 爬取批次日志（成功/失败均记录，含重试批次） |
| `settings` | 全局配置（KV，可动态调整） |
| `campaign_events` | 营销活动主表（春节/五一/国庆等） |
| `campaign_video_types` | 活动视频类型（如"活动视频"/"产品视频"），活动点检表列的依据 |
| `campaign_type_keywords` | 视频类型关键词（OR-of-AND：同 `rule_group` AND，组间 OR） |
| `video_type_matches` | 视频命中记录（权威匹配表，取代旧的 `videos.matched_keywords`） |
| `dealer_campaign_membership` | 门店级活动打标（粗粒度） |
| `staff_campaign_membership` | 专员/账号级活动打标（细粒度），含 `qualified_video_count` 命中视频数 |
| `dealer_campaign_stats` | 活动时间窗内的聚合统计（可反复重算） |
| `admin_users` | 后台管理员表（Web 管理界面用户账号） |

### 核心关系

```
dealers (物理门店)
  │  brand = 海信 / 日立 / 约克
  │  store_code（唯一，无联系人字段，人员信息在 dealer_staff）
  │
  └── dealer_staff (专员+社媒账号，一对多)
        │  contact_name, contact_phone  — 专员信息
        │  platform = douyin / wechat_video / xiaohongshu
        │  account_identifier = 平台唯一ID（抖音=sec_uid）
        │  home_url, nickname, follower_count ...
        │  last_scrape_error             — 最近失败原因（成功后清空）
        │
        ├── videos (视频记录，仅存命中关键词的视频)
        │     aweme_id（唯一）, title, like_count, matched_keywords,
        │     cover_url, cover_local ...
        │
        └── account_snapshots (每日快照)
              snapshot_date, follower_count, video_count ...

dealers     ──FK── dealer_campaign_membership ──FK── campaign_events
dealers     ──FK── dealer_campaign_stats      ──FK── campaign_events
dealer_staff──FK── staff_campaign_membership  ──FK── campaign_events
                     └─ qualified_video_count  — 该账号在该活动下命中关键词的视频数（每次爬取后精确重算覆盖）

campaign_events ──FK── campaign_video_types（活动视频类型：活动视频/产品视频...）
                           └── campaign_type_keywords（关键词，OR-of-AND：同 rule_group AND，组间 OR）

videos ──FK── video_type_matches ──FK── campaign_video_types  ← 权威命中记录（取代 matched_keywords）
                └── campaign_id（用于按活动过滤）
```

### dealers 表字段

```
id, brand                        — 门店ID、品牌（海信/日立/约克）
region, branch, sector           — 大区、分公司、板块
dealer_name, store_code          — 经销商名称、门店编码（唯一键）
store_name, store_tier           — 门店名称、店面标准
created_at, updated_at

注：联系人信息（姓名/电话）已移至 dealer_staff，dealers 只存纯门店档案。
```

### dealer_staff 表字段（核心表）

```
id, dealer_id                    — 账号ID、所属门店FK
contact_name, contact_phone      — 专员姓名（VARCHAR 50）、联系方式（VARCHAR 100）
platform                         — 平台: douyin / wechat_video / xiaohongshu
account_identifier               — 平台唯一ID（抖音=sec_uid，其他平台TBD）
home_url                         — 账号主页链接（platform+home_url 唯一键）
raw_home_url                     — 导入原始链接/口令文本（短链二次解析用）
nickname, signature              — 昵称、简介（爬虫回写）
avatar_url/local, bg_url/local   — 头像/背景图（URL+本地缓存路径）
bg_match_standard                — 主页背景是否符合标准图（1=符合，0=不符合，NULL=未比对）；由 compare_bg.py 写入；是"主页装修完成"的唯一判定条件
bg_match_score                   — SIFT 特征匹配点数量
is_certified                     — 是否认证通过（1=通过）；活动点检表完成率的分母
follower_count, total_favorited  — 粉丝数、总获赞
video_count, video_total_count   — 平台显示视频数、系统存储视频数
keyword_video_count              — 命中关键词的视频数（全局，跨活动）
resolve_status                   — done / pending（sec_uid是否已解析）
resolve_error                    — 链接解析失败原因（如 no_url_found / shortlink_unresolved / self_profile_url）
status                           — active / error / pending
last_scraped_at                  — 最近爬取时间
last_attempt_at                  — 最近一次尝试时间（成功或失败）
last_attempt_status              — 最近一次尝试结果（success / error）
last_success_at                  — 最近一次成功时间
has_success                      — 是否曾成功采集（0/1）
earliest_captured_video_at       — 当前API窗口内最早视频发布时间（通常是第20条）
last_scrape_error                — 最近一次失败原因（TEXT，成功后由爬虫清空为 NULL）
```

### videos 表补充说明

```
douyin_created_at                — 视频发布日期（抖音 create_time / 小红书 note.time）
```

- 命中视频写入时会保存 `douyin_created_at`
- 若同一视频重复爬取（ON DUPLICATE KEY UPDATE），也会更新 `douyin_created_at`（有新值时覆盖）

### videos 表新增字段（AI 赋能，2026-06）

```
video_local       — 本地视频/音频文件路径（相对 IMAGES_DIR），如 videos/7649xxx.mp3
video_dl_status   — 下载状态：none / downloading / done / error
video_dl_error    — 下载失败原因（TEXT）
ai_transcript     — ASR 语音转文字结果（qwen3-asr-flash，存原始转写文本）
ai_analysis       — AI 内容分析结果（Markdown，含亮点/脚本结构/优缺点）
ai_script         — AI 仿写脚本（Markdown，含分镜表格和完整口播文案）
ai_analyzed_at    — 最近一次 AI 分析/ASR 的时间戳
```

### staff_campaign_membership 表字段

```
id, campaign_id, staff_id        — 活动ID、专员账号ID
is_participating                 — 1=参与，0=排除
qualified_video_count            — 该账号在该活动下命中关键词的视频数（每次爬取后精确重算覆盖）
tagged_by, tagged_at, source     — 操作信息（manual/rule/import）
```

---

## 多平台扩展

### 接入新平台的步骤

**第一步：导入账号**（无需改代码，立即可用）

```bash
# 视频号：每行一个视频号主页链接
node src/importAccounts.js 视频号链接.txt --platform wechat_video

# 小红书：每行一个主页链接
node src/importAccounts.js 小红书链接.txt --platform xiaohongshu

# 如果所有账号属于同一门店（已知门店ID=5）
node src/importAccounts.js 链接.txt --platform wechat_video --dealer-id 5
```

**第二步：实现爬虫**（待开发，参照 `scraper.js` 抖音实现）

新建 `scraper/src/scrapers/wechat_video.js`，实现：
```js
async function scrapeAccount(account) {
  // account.home_url, account.account_identifier, account.id
  // 爬取逻辑：拦截 API / 解析页面 / 回写 dealer_staff + videos
}
```

在 `scraper.js` 中按 `platform` 路由到不同爬虫即可：
```js
if (account.platform === 'douyin') { ... }
else if (account.platform === 'wechat_video') { ... }
```

> 数据库结构已完全支持多平台，只有爬虫逻辑需要按平台实现。

### 当前平台支持状态

| 平台 | 导入账号 | 爬虫采集 | 备注 |
|---|---|---|---|
| 抖音 (douyin) | ✅ | ✅ | 完整支持 |
| 视频号 (wechat_video) | ✅ | 🔲 待开发 | 账号可导入，暂无爬虫 |
| 小红书 (xiaohongshu) | ✅ | 🔲 待开发 | 账号可导入，暂无爬虫 |

---

## 爬虫工作原理（抖音）

1. **账号加载**：从 `dealer_staff` 表读取 `platform='douyin'`、`status IN ('active','pending')` 的账号，按 `batch_size`（默认 100）分批
2. **页面访问**：用 Puppeteer 访问 `home_url`，注入登录 Cookie（从 `cookies/douyin_cookies.json` 读取，重启浏览器无需重新登录）
3. **API 拦截**：监听网络响应，捕获两个关键 API（第一阶段最多等待 30 秒）：
   - `/aweme/v1/web/user/profile/` — 账号信息（粉丝数、头像等）
   - `/aweme/v1/web/aweme/post/` — 视频列表（一次约返回 20 条）
   - **自动翻页**（活动模式专用）：若第一页 > 17 条且最早视频晚于活动 `start_date`，则滚动到底部触发第二页 XHR（带 `max_cursor`），第二阶段额外等待最多 60 秒。两页数据合并去重后统一处理，上限 `max_videos_per_account`（默认 40）。全量模式（`--run-now`）不触发翻页。
4. **关键词匹配**：对每个视频的标题/描述，依次匹配 `campaign_type_keywords` 中的规则（OR-of-AND：同 `rule_group` 的关键词全部命中才算该组成立，组间取 OR；关键词内空格拆成子词，每个子词都必须出现）。命中结果写入 `video_type_matches` 表（而非旧的 `videos.matched_keywords`），并精确重算覆盖 `staff_campaign_membership.qualified_video_count`。通过 Web 界面也可触发全量重匹配（`POST /api/keywords/rematch?campaign_id=X`，SSE 推送进度）
5. **封面下载**：命中关键词的视频会提取抖音封面 URL，下载到本地 `images/<日期>/<aweme_id>/cover.jpg`，并写入 `videos.cover_url`、`videos.cover_local`
6. **数据落地**：更新 `dealer_staff`、`videos`、`account_snapshots`、`scrape_logs`
   - 失败时写 `dealer_staff.last_scrape_error`，成功时清空
7. **失败重试**：所有批次跑完后，将本轮失败账号集中做一次重试（最多重试一次，按 100 分批）

### 账号身份校验（防止静默采集错误账号）

爬虫每次采集成功后，会比对 profile API 返回的 `sec_uid`（**实际采到的账号**）
与 `dealer_staff.account_identifier`（**导入链接登记的账号**）：

- 两者一致 → 正常
- 两者不一致 → 输出 `⚠ 账号身份不一致` 告警，活动模式在批次结束时汇总列出

不一致通常意味着 `home_url` 指向的不是登记账号，最常见原因是专员换号后链接未更新。
这类账号「采集成功」但数据属于别的账号，**不可直接用于活动统计**。

注意此处**不会**用采集结果覆盖 `account_identifier`：保留原值才能留下比对线索，
若用采到的 `sec_uid` 覆盖，错配痕迹会被抹掉，问题将再也无法被发现。

批量核查（只读，不改库）：

```bash
cd scraper

# 核查 home_url 与 raw_home_url 的真实指向是否一致
node scripts/audit_home_url.js --only-mismatch --out=../核查结果.csv

# 只核查某活动的参与账号
node scripts/audit_home_url.js --campaign=camp_20260810_KXLK --out=../核查.csv
```

脚本会重新解析 `raw_home_url`，与当前 `home_url` 比对，输出不一致清单
（含 staff_id、门店编码、专员、爬虫实际访问的号、原始链接应指向的号）。

判断某账号「抓的对不对」只需看一件事：`home_url` 末段是否等于
`raw_home_url` 重新解析出的 sec_uid。

排查时可结合视频明细表的「导出 Excel → 全量明细」，汇总页的**链接一致性**列会直接标红。

### 反检测措施

- `puppeteer-extra-plugin-stealth`：抹去自动化特征
- 注入登录 Cookie，模拟真实用户
- 账号间随机延迟 **5~10 秒**
- 每 100 个账号一批，**批次结束后关闭/重启浏览器实例**（清除 session 状态和指纹）
- 批次间随机等待 **1~3 分钟**
- 时区 `Asia/Shanghai`，语言 `zh-CN`
- **无自动定时任务**，需手动触发，避免 Cookie 在不确定时间被消耗

---

## 活动管理（campaigns）

营销节点（春节、五一、国庆等）的数据统计：

### 数据导入方式（推荐）

```bash
# 从活动 CSV 一步导入：门店档案 + 专员账号 + 活动打标
cd scraper
node src/importCampaignMembers.js ../活动数据.csv \
  --campaign-code=hitachi_51_2026 \
  --campaign-name="日立2026年五一活动" \
  --start-date=2026-05-01 \
  --end-date=2026-05-05 \
  --encoding=gbk
```

导入器链接解析策略（2026-05-13 起）：
- 支持从分享文案中提取多个 URL，优先直链 `/user/<sec_uid>`。
- 对 `v.douyin.com` 短链执行多跳重定向解析（移动/桌面 UA 双通道）。
- 解析失败时保留 `raw_home_url` 并写 `resolve_error`，便于后续批量补解析。

链接字段更新规则（2026-08-11 起，重要）：
- **解析成功时，`home_url` 与 `account_identifier` 成对覆盖**，以最新导入为准。
  专员换号后重新导入新链接即可生效。
- 解析失败时两者都保留原值（不用 `null` 覆盖有效值），仅更新 `raw_home_url` / `resolve_error`。
- 若新链接与同门店其它专员冲突（触发 `(dealer_id, platform, home_url)` 唯一约束），
  **保留原链接并告警**，不覆盖，交人工核对是否两人链接录反。
- 导入结束时输出「换号明细」与「链接一致性校验」，换号账号建议重新采集。

> **此前的缺陷**：`home_url` 与 `account_identifier` 曾都用 `COALESCE(旧值, 新值)` 保护，
> 而 `raw_home_url` 用新值覆盖。结果专员换号、重新导入后，`raw_home_url` 更新了，
> 但爬虫真正访问的 `home_url` 仍停在旧号——爬虫照常报「采集成功」，抓的却是别人的账号，
> 全程无任何报错。同时 `resolvePendingHomeUrls.js` 里 `home_url` 无条件覆盖、
> `account_identifier` 却被保护，会留下两者互相错位的记录。两处均已修正为成对更新。

二次补解析（针对 pending 且 raw_home_url 非空账号）：
```bash
# 仅预览（默认，不落库）
node src/resolvePendingHomeUrls.js --campaign-code=hitachi_51_2026 --limit=200

# 执行写回
node src/resolvePendingHomeUrls.js --campaign-code=hitachi_51_2026 --limit=200 --apply=true
```

### 活动专项爬取

```bash
# 只爬取参与该活动的账号，只保存命中 match_keywords 的视频
cd scraper
MYSQL_PASSWORD=<密码> node src/index.js --campaign hitachi_51_2026

# 测试时限制数量
MYSQL_PASSWORD=<密码> node src/index.js --campaign hitachi_51_2026 --limit 10

# 增量续爬（默认）：只爬 3天内未成功爬取 的账号（含从未爬过、error 账号）
MYSQL_PASSWORD=<密码> node src/index.js --campaign hitachi_315_2026 hitachi_51_2026 --mode incremental --limit 100

# 全量重爬：包括3天内已成功爬取的账号
MYSQL_PASSWORD=<密码> node src/index.js --campaign hitachi_315_2026 hitachi_51_2026 --mode full --limit 100
# 等价参数：--full-refresh
```

爬取过程中：
- 命中关键词的视频写入 `videos`；命中的类型写入 `video_type_matches`（`videos.matched_keywords` 字段为历史遗留，不再用于统计）
- 命中视频会保存 `douyin_created_at`（发布日期）
- 同时下载并落库视频封面（`cover_url` / `cover_local`）
- `staff_campaign_membership.qualified_video_count` 每次爬取后精确重算覆盖（幂等）
- 失败账号在所有批次跑完后自动重试一次

### 统计维度（dealer_campaign_stats，可反复重算）

- `total_videos_in_window` — 时间窗内发布视频总数
- `keyword_videos_in_window` — 命中关键词视频数
- `total_like/comment/share_in_window` — 互动合计

---

## 爬取任务配置

> 定时任务已移除，所有爬取均为**手动触发**，防止 Cookie 在不确定时间自动消耗。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `batch_size` | 100 | 每批账号数，批次结束后重启浏览器 |
| `max_videos_per_account` | 40 | 每账号最多处理视频数（活动模式下可能抓取两页共约 40 条） |

动态调整（无需重启）：
```sql
UPDATE settings SET value = '30' WHERE `key` = 'max_videos_per_account';
```

**触发方式：**
```bash
# 全量爬取（所有 active 账号）
MYSQL_PASSWORD=<密码> node src/index.js --run-now

# 活动专项爬取（支持单个或多个活动 code）
MYSQL_PASSWORD=<密码> node src/index.js --campaign <campaign_code...>

# 活动专项爬取（默认增量：3天内未成功爬取的账号）
MYSQL_PASSWORD=<密码> node src/index.js --campaign <campaign_code...> --mode incremental

# 活动专项爬取（全量重爬）
MYSQL_PASSWORD=<密码> node src/index.js --campaign <campaign_code...> --mode full

# 多活动并行匹配（一次 API 扫描，分别匹配多个活动关键词）
MYSQL_PASSWORD=<密码> node src/index.js --campaign hitachi_315_2026 hitachi_51_2026

# 单账号测试
MYSQL_PASSWORD=<密码> node src/index.js --test <抖音主页URL>
```

---

## 本地开发运行

### 前提条件

- Node.js >= 18
- Docker Desktop
- Google Chrome（本地爬虫测试用）

### 1. 克隆项目并配置环境变量

```bash
git clone <repo>
cd lxk-BigSpard
cp .env.example .env
# 编辑 .env，填入数据库密码等
```

### 2. 启动本地 MySQL

```bash
docker compose -f docker-compose.dev.yml up -d
```

### 3. 安装依赖

```bash
cd scraper && npm install
cd ../web && npm install
```

### 4. 导出抖音 Cookie

参考 `cookies/HOW_TO_EXPORT_COOKIES.md`，将 Cookie 保存到 `cookies/douyin_cookies.json`

### 5. 单账号测试爬虫

```bash
cd scraper
node src/index.js --test "https://www.douyin.com/user/MS4wLjABAAAA..."
```

### 6. 立即触发全量爬取

```bash
node src/index.js --run-now
```

### 7. 启动 Web 管理界面

```bash
cd web
node src/server.js
# 访问 http://localhost:3004
# 账号密码来自 .env 的 WEB_AUTH_USER / WEB_AUTH_PASS
```

### 8. 导入数据

```bash
cd scraper

# 导入门店业务数据（全部字段.csv）
node src/importDealers.js ../全部字段.csv

# 导入抖音账号链接
node src/importAccounts.js ../抖音主页链接.csv

# 导入视频号账号（自动创建门店存根）
node src/importAccounts.js ../视频号链接.txt --platform wechat_video

# 导入小红书账号（全部归属到已知门店 ID=5）
node src/importAccounts.js ../小红书链接.txt --platform xiaohongshu --dealer-id 5
```

---

## 生产部署

### 服务器信息

| 项目 | 值 |
|---|---|
| 服务商 | 阿里云香港 ECS |
| IP | 47.83.139.171 |
| 系统 | Linux |
| 面板 | 宝塔（管理 Nginx） |
| 访问域名 | `ai.liuxuekui.click` |

### 端口约定

| 服务 | 容器端口 | 说明 |
|---|---|---|
| douyin-web | 3004 | Web 管理界面（Nginx 反代） |
| douyin-db | 3306 | MySQL（仅内网） |

> 3000/3001 为 promo-platform 占用，3002/3003 为 site2 预留。

### 容器结构

```
douyin-db       MySQL 8.0，数据持久化到 volume douyin-db-data
douyin-scraper  Node.js 爬虫，任务型容器（按命令触发，执行完成即退出）
douyin-web      Express Web 服务，端口 3004
```

### Nginx 反代配置

宝塔面板 → 网站 → `ai.liuxuekui.click` → 反向代理：
- 所有请求 → `http://127.0.0.1:3004`
- 已配置 HTTPS（Let's Encrypt）

### 部署步骤（首次）

```bash
# 1. 打包上传（排除敏感文件和大体积数据文件）
# 注：cookies 文件会随代码同步到云服务器（覆盖云上旧 cookie）
tar --exclude='.git' --exclude='node_modules' --exclude='.env' \
    --exclude='images' \
    --exclude='*.xlsx' --exclude='*.csv' --exclude='*.png' --exclude='*.jpg' \
    --exclude='.DS_Store' \
    -czf /tmp/douyin-scraper.tar.gz .

scp /tmp/douyin-scraper.tar.gz root@47.83.139.171:/tmp/
ssh root@47.83.139.171 "mkdir -p /opt/douyin-scraper && \
    cd /opt/douyin-scraper && tar -xzf /tmp/douyin-scraper.tar.gz"

# 2. 上传 .env 和 Cookie
scp .env root@47.83.139.171:/opt/douyin-scraper/.env
scp cookies/douyin_cookies.json root@47.83.139.171:/opt/douyin-scraper/cookies/douyin_cookies.json

# 3. 启动容器
ssh root@47.83.139.171 "cd /opt/douyin-scraper && docker compose up -d --build"

# 4. 导入门店数据
ssh root@47.83.139.171 "
    docker cp /opt/douyin-scraper/全部字段.csv douyin-scraper:/app/全部字段.csv && \
    docker exec douyin-scraper node src/importDealers.js '/app/全部字段.csv'
"
```

### 代码更新

```bash
# 全量同步（改动较多时）
# 注：cookies 文件会随代码同步到云服务器（覆盖云上旧 cookie）
# .env 不同步，云服务器有自己的配置
tar --exclude='.git' --exclude='node_modules' --exclude='.env' \
    --exclude='images' \
    --exclude='*.xlsx' --exclude='*.csv' --exclude='*.png' --exclude='*.jpg' \
    --exclude='.DS_Store' \
    -czf /tmp/douyin-scraper.tar.gz . && \
scp /tmp/douyin-scraper.tar.gz root@47.83.139.171:/tmp/ && \
ssh root@47.83.139.171 "cd /opt/douyin-scraper && \
    tar -xzf /tmp/douyin-scraper.tar.gz && rm /tmp/douyin-scraper.tar.gz && \
    docker compose up -d --build"

# ⚠️ 覆盖后验证关键文件未损坏（tar 偶发前缀字符问题）
ssh root@47.83.139.171 "head -1 /opt/douyin-scraper/scraper/src/index.js"
# 正常应输出: 'use strict';

# 热更新单文件（无需重建镜像）
scp scraper/src/scraper.js root@47.83.139.171:/tmp/scraper.js
ssh root@47.83.139.171 "docker cp /tmp/scraper.js douyin-scraper:/app/src/scraper.js"

# web 新增 npm 依赖后需在容器内安装（如 ali-oss、axios）
ssh root@47.83.139.171 "docker exec douyin-web sh -c 'cd /app && npm install ali-oss axios --save'"

# 数据库结构有变更时，需执行 ALTER（不影响数据）示例：
# ssh root@47.83.139.171 "docker exec -i douyin-db mysql -u douyin_user -p'<密码>' douyin_scraper" << 'EOF'
# ALTER TABLE dealer_staff MODIFY contact_phone VARCHAR(100) NOT NULL DEFAULT '';
# EOF

# 数据同步（settings / dealer_staff / videos 等业务数据）
# 本地导出：
# mysqldump -h 127.0.0.1 -u douyin_user -p'<密码>' --no-create-info --replace \
#   douyin_scraper settings dealer_staff videos > /tmp/sync_data.sql
# 上传导入：
# scp /tmp/sync_data.sql root@47.83.139.171:/tmp/
# ssh root@47.83.139.171 "docker cp /tmp/sync_data.sql douyin-db:/tmp/ && \
#   docker exec douyin-db sh -c 'mysql -u douyin_user -p\"\$MYSQL_PASSWORD\" douyin_scraper < /tmp/sync_data.sql'"
```

---

## 常用运维命令

```bash
# 查看容器状态
ssh root@47.83.139.171 "docker ps"

# 查看爬虫实时日志
ssh root@47.83.139.171 "docker logs -f douyin-scraper"

# 手动触发全量爬取
ssh root@47.83.139.171 "docker exec douyin-scraper node src/index.js --run-now 2>&1"

# 爬取结果统计（通过 dealer_staff）
ssh root@47.83.139.171 "docker exec -i douyin-db mysql --default-character-set=utf8mb4 \
  -u douyin_user -p'<密码>' douyin_scraper -e \"
    SELECT platform, COUNT(*) AS 账号数,
           SUM(status='active') AS 已爬取,
           SUM(status='error') AS 失败,
           SUM(status='pending') AS 待爬取
    FROM dealer_staff GROUP BY platform;
    SELECT COUNT(*) AS 命中视频总数 FROM videos;
    SELECT campaign_code, campaign_name, SUM(qualified_video_count) AS 命中视频数
    FROM staff_campaign_membership scm
    JOIN campaign_events ce ON ce.id = scm.campaign_id
    GROUP BY ce.id;
\""

# 按品牌统计门店数
ssh root@47.83.139.171 "docker exec -i douyin-db mysql --default-character-set=utf8mb4 \
  -u douyin_user -p'<密码>' douyin_scraper -e \"
    SELECT brand, COUNT(*) AS 门店数 FROM dealers GROUP BY brand;
\""

# 调整每账号最大视频数
ssh root@47.83.139.171 "docker exec -i douyin-db mysql --default-character-set=utf8mb4 \
  -u douyin_user -p'<密码>' douyin_scraper -e \
  \"UPDATE settings SET value='30' WHERE \`key\`='max_videos_per_account';\""
```

---

## 数据现状（截至 2026-06-21）

| 项目 | 数量 | 备注 |
|---|---|---|
| dealers（物理门店） | 735 条 | 全部品牌=日立 |
| dealer_staff（专员+账号） | 762 条 | 含双平台专员 |
| staff_campaign_membership | 1898 条 | 三个活动打标合计 |
| videos | 14,683 条 | 只存命中关键词视频 |
| video_type_matches | 2,741 条 | 权威命中记录 |
| account_snapshots | — | 按需生成 |
| scrape_logs | — | 成功/失败/重试均记录 |

**已导入活动：**

| campaign_code | 活动名 | 时间窗 | 参与账号数 |
|---|---|---|---|
| `hitachi_315_2026` | 日立2026年315活动 | 2026-03-15 | 634 |
| `hitachi_51_2026` | 日立2026年五一活动 | 2026-05-01~05 | 745 |
| `hitachi_618_2026` | 日立2026年618活动 | 2026-06-01~18 | — |

---

## 背景图比对工具（bg_comparator.py）

对账号主页背景图进行 SIFT 特征比对，判断是否与标准装修背景图一致。结果写入 `dealer_staff.bg_match_standard`（1=匹配/0=自定义/−1=需补爬）和 `bg_match_score`（特征匹配点数量）。

> **与 scraperBg.js 的分工：**
> - `scraperBg.js`（背景图爬虫）：负责从抖音爬取账号主页装修背景图（`coverAndHeadImageInfo.profile_cover_list`），压缩后上传 OSS
> - `bg_comparator.py`（背景图比对）：对已下载的背景图与标准图做 SIFT 比对，结果写回数据库

### 标准图配置（settings 表）

| key | 说明 |
|---|---|
| `standard_bg_image` | 全局默认标准图（base64） |
| `standard_bg_image_<campaign_code>` | 活动专属标准图（优先于全局，每个活动可配不同标准图） |
| `failure_bg_image` | 失败占位图（用于检测下载失败账号，结果写 −1） |

上传活动专属标准图示例（Python）：
```python
import base64, mysql.connector
with open('618标准背景图.png', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')
# 写入 settings 表 key = 'standard_bg_image_camp_20260611_NATP'
```

### 背景图爬取

```bash
cd scraper

# 按活动维度爬取背景图（推荐）
node src/scraperBg.js --campaign camp_20260611_NATP --mode full
node src/scraperBg.js --campaign camp_20260611_NATP --mode incremental

# 单账号测试
node src/scraperBg.js --test "https://www.douyin.com/user/..."
```

### SIFT 比对运行方式

```bash
cd scraper

# 按活动维度比对（推荐，不同活动标准图不同）
python3 src/bg_comparator.py --campaign-id=12
python3 src/bg_comparator.py --campaign-code=camp_20260611_NATP

# 强制重新比对（不跳过已有结果）
python3 src/bg_comparator.py --campaign-code=camp_20260611_NATP --force

# 全局比对（不按活动筛选）
python3 src/bg_comparator.py --force

# 限量测试
python3 src/bg_comparator.py --campaign-id=12 --limit=20

# 指定账号
python3 src/bg_comparator.py --ids=100,101,102
```

### 阈值说明

默认阈值 `BG_MATCH_THRESHOLD=200`（可通过环境变量调整）：SIFT 特征匹配点 ≥ 200 则视为匹配。可根据实际标准图和账号图片质量调整。

```bash
BG_MATCH_THRESHOLD=300 python3 src/bg_comparator.py --campaign-id=12
```

---

## 视频明细导出

`数据管理 → 视频明细表`（`/video-detail.html`）提供命中活动关键词的视频明细预览与 Excel 导出。

### 预览字段

序号 / 大区 / 分公司 / **分公司认证通过专员人数** / **分公司主页装修完成人数** / **分公司活动视频完成人数** / **分公司新品视频完成人数** / 门店名称 / 专员姓名 / 联系方式 / **视频封面** / **视频标题名称** / **视频链接** / 视频类型 / 点赞 / 互动数 / 收藏 / 平台 / 最近爬取 / 背景图是否一致 / 背景图图片

> 分公司聚合字段（认证人数、装修完成人数、活动/新品视频完成人数）复用活动点检表的统计逻辑，数据口径一致。

### Excel 导出

点击「导出 Excel」后弹出选项：

| 选项 | 范围 | 说明 |
|---|---|---|
| 无图下载 | 仅命中视频 | 仅数据，生成速度快，文件小 |
| 全部下载（含背景图） | 仅命中视频 | 嵌入视频封面图 + 主页背景图，需从 OSS 下载图片，约 30~60 秒 |
| **全量明细** | **本次采集的全部视频** | 三工作表，含未命中视频，用于数据核查，约 10~40 秒 |

- 下载期间页面中央显示**红色等待提示**，完成后自动消失
- Excel 内「视频链接」列为可点击超链接
- 背景图是否一致列：绿色=匹配，红色=不匹配，黄色=需补爬

### 全量明细（数据核查用）

前两个选项只导出**命中活动关键词**的视频，面向活动考核汇报；「全量明细」导出参与账号
**本次采集到的全部视频**（不限是否命中），面向问题排查：能看出账号是否停更、
话术是否用错、账号链接是否错配、是否存在漏采。

三个工作表：

| 工作表 | 内容 |
|---|---|
| 经销商与专员 | 每账号一行：门店业务字段 + 专员信息 + 主页链接 + 粉丝/作品数 + 认证与背景图状态 + 最近爬取时间与错误 |
| 视频明细 | 每视频一行：门店/专员归属 + 标题 + 发布时间 + 视频链接 + 互动数据 + 是否在活动窗内 + 命中类型 |
| 汇总 | 每账号一行：平台作品数 vs 本次采集数 vs 活动窗内数 vs 命中数 + 最新视频发布日 + **链接一致性** |

关键排查列：

- **链接一致性** — `home_url` 与 `account_identifier` 是否指向同一账号。标红的「不一致⚠」
  说明爬虫访问的地址与导入链接的真实指向不符，很可能在采集**别的账号**，需核对专员是否已换号
  （详见「账号身份校验」章节）
- **平台作品数 vs 本次采集数** — 差距过大可能是接口只返回首页或账号异常
- **最新视频发布日** — 停留在数月前说明账号已停更，或库里存的是旧号
- **命中数为 0 但活动窗内有视频** — 话术用错，或关键词 `rule_group` 配置成了 AND

命中行整行标绿；活动窗外的视频在「是否在活动窗内」列标黄；本次未采到视频的账号在汇总页标黄。
汇总页末尾附口径说明（活动时间窗、采集范围、账号与视频总数、链接不一致账号数）。

### 接口

```
GET  /api/export/video-detail         — JSON 预览数据
GET  /api/export/video-detail.xlsx    — Excel 下载（?campaign_id=&include_bg=1）
GET  /api/export/full-detail.xlsx     — 全量明细下载（?campaign_id=&scraped_since=YYYY-MM-DD）
```

`full-detail.xlsx` 的 `scraped_since` 可选：不传时自动取「该活动账号最近一次采集日」当天起，
避免把历史多轮采集的数据混在一起；需要看更早的数据时显式指定日期。

两个导出均按当前登录品牌（`req.brand`）过滤，跨品牌的账号不会出现在结果中。

> 命令行等价工具：`scraper/scripts/export_staff_videos.py`，支持按活动或按门店编码导出
> 相同结构的 Excel，用于批量/离线场景：
> ```bash
> python3 scripts/export_staff_videos.py --campaign-code=<code> --scraped-since=2026-08-10 --out=../x.xlsx
> python3 scripts/export_staff_videos.py --store-codes=<编码1,编码2> --campaign-code=<code> --out=../y.xlsx
> ```
> 与 Web 端的差异：命令行版不做品牌过滤，导出活动下全部参与账号。

---

对命中关键词的视频进行 AI 深度分析，生成内容分析报告和仿写脚本，赋能经销商内容创作。

### 功能概览

| 功能 | 说明 |
|---|---|
| 优秀视频列表 | 按点赞数排序展示命中视频，支持按活动/品牌/时间窗口过滤 |
| ASR 语音转写 | 调用 `qwen3-asr-flash` 对本地视频/音频文件做语音识别，存入 `videos.ai_transcript` |
| AI 内容分析 | 调用 `qwen-plus` 流式输出内容亮点、脚本结构还原、优缺点分析（SSE），存入 `videos.ai_analysis` |
| AI 仿写脚本 | 基于分析结果生成分镜脚本表格和完整口播文案（SSE），存入 `videos.ai_script` |

### API 接口

```
GET  /api/excellent-videos           — 优秀视频列表（?campaign_id=&window_days=30&limit=20）
POST /api/ai/parse-video             — ASR 语音转文字（同步，body: {video_id}）
POST /api/ai/analyze-video           — AI 内容分析（SSE 流式，body: {video_id, transcript?}）
POST /api/ai/rewrite-script          — AI 仿写脚本（SSE 流式，body: {video_id, analysis?, transcript?, requirement?}）
```

### 视频下载

视频文件需先下载到本地后才能做 ASR 转写。下载后存于 `images/videos/<aweme_id>.mp3`（或 .mp4），路径写入 `videos.video_local`。

- `video_dl_status` = `none / downloading / done / error`
- 文件大小限制：`qwen3-asr-flash` 接口上限 **10MB**，超出需用 ffmpeg 压缩或提取音频轨道

### 环境变量

```env
DASHSCOPE_API_KEY=sk-xxx         # 阿里云百炼 API Key（https://dashscope.console.aliyun.com/）
DASHSCOPE_MODEL=qwen-plus        # 文本模型（qwen-turbo / qwen-plus / qwen-max）
VIDEO_BASE_URL=https://...       # 公网域名（ASR URL 传递用，本地开发留空则用 base64）
```

---

## Cookie 维护

抖音 Cookie 有效期约 **60 天**，到期后爬取退化为未登录状态。

更新步骤：
1. Chrome 安装 `Cookie-Editor` 插件，登录抖音后导出 JSON，保存到本地 `cookies/douyin_cookies.json`
2. 同步到云服务器（两种方式任选其一）：
   ```bash
   # 方式一：随全量代码同步一起上传（cookies 不在排除列表中）
   # 直接执行「代码更新」章节的 tar + scp 命令即可

   # 方式二：单独上传 cookie 文件
   scp cookies/douyin_cookies.json root@47.83.139.171:/opt/douyin-scraper/cookies/douyin_cookies.json
   ```
3. 无需重启容器，下次爬取自动加载

---

## OSS 对象存储（图片卸载）

服务器带宽仅 1Mbps，封面图/头像/背景图已全部迁移至阿里云 OSS，不再消耗服务器出口带宽。

### 配置

| 配置项 | 说明 |
|---|---|
| Bucket | `lxk-douyin-covers`（华东2 上海，同城冗余，**私有读**） |
| Endpoint | `oss-cn-shanghai.aliyuncs.com` |
| OSS 路径前缀 | `covers/<yyyy-mm-dd>/<id>/cover.jpg` |

### 相关环境变量（`.env`）

```env
OSS_REGION=oss-cn-shanghai
OSS_BUCKET=lxk-douyin-covers
OSS_ACCESS_KEY_ID=<AccessKey ID>
OSS_ACCESS_KEY_SECRET=<AccessKey Secret>
OSS_BASE_URL=https://lxk-douyin-covers.oss-cn-shanghai.aliyuncs.com
```

### 工作原理

- **新爬取**：`scraper/src/imageDownloader.js` 检测到 `OSS_BUCKET` 配置时，自动将下载的封面/头像/背景图**压缩**（最大宽 800px，JPEG quality 72）后上传 OSS，返回 OSS 公网 URL 存入数据库（`cover_local` / `avatar_local` / `bg_local`）
- **前端读取**：所有页面的图片拼接逻辑均已做兼容处理，用 `startsWith('http')` 判断——是 OSS URL 直接使用，是相对路径才拼 `/images/` 前缀，两种格式均可正常显示
- **服务端读取（Excel 导出）**：Bucket 为私有权限，`web/src/routes/export.js` 通过 `ali-oss` SDK（使用 AccessKey 鉴权）直接读取图片 buffer 嵌入 Excel，而非通过公网 URL 访问
- **历史图片迁移**：一次性迁移脚本 `scripts/migrate-covers-to-oss.js`，将本地 `./images/` 已有图片批量上传并更新数据库

### 历史图片迁移

#### 本地环境（有图片文件）

用迁移脚本，图片从本地 `./images/` 上传到 OSS，同时更新数据库路径：

```bash
# 试运行（不写库，只打印）
node scripts/migrate-covers-to-oss.js

# 正式执行
node scripts/migrate-covers-to-oss.js --apply

# 限量测试
node scripts/migrate-covers-to-oss.js --apply --limit=100
```

#### 云服务器（图片已在 OSS，只需更新数据库路径）

图片文件已经由本地迁移脚本上传到 OSS，云服务器只需执行 3 条 SQL 将数据库里的相对路径更新为 OSS URL：

```sql
-- 视频封面
UPDATE videos
SET cover_local = CONCAT('https://lxk-douyin-covers.oss-cn-shanghai.aliyuncs.com/covers/', cover_local)
WHERE cover_local IS NOT NULL AND cover_local != '' AND cover_local NOT LIKE 'http%';

-- 账号头像
UPDATE dealer_staff
SET avatar_local = CONCAT('https://lxk-douyin-covers.oss-cn-shanghai.aliyuncs.com/covers/', avatar_local)
WHERE avatar_local IS NOT NULL AND avatar_local != '' AND avatar_local NOT LIKE 'http%';

-- 账号背景图
UPDATE dealer_staff
SET bg_local = CONCAT('https://lxk-douyin-covers.oss-cn-shanghai.aliyuncs.com/covers/', bg_local)
WHERE bg_local IS NOT NULL AND bg_local != '' AND bg_local NOT LIKE 'http%';
```

执行方式：

```bash
ssh root@47.83.139.171 "docker exec -i douyin-db mysql --default-character-set=utf8mb4 \
  -u douyin_user -p'<密码>' douyin_scraper < migrate.sql"
```

**已迁移数据（2026-06-22）：** 视频封面 14,677 条、头像/背景图各 579 条全部完成。

---

## 登录限速（防暴力破解）

`web/src/server.js` 内置基于 IP 的登录限速，无需外部依赖。

### 规则

| 参数 | 值 |
|---|---|
| 5 分钟内最大失败次数 | 5 次 |
| 触发后锁定时长 | 15 分钟 |
| 计数维度 | 来源 IP（经 `X-Forwarded-For` 获取） |
| 登录成功后 | 立即清除该 IP 的失败记录 |

触发后返回 HTTP 429，错误提示：`登录失败次数过多，请 X 分钟后再试`

### 存储方式

失败记录存在**服务器内存**中，不依赖 Redis 等外部组件。

> **注意**：重启 `douyin-web` 容器会清空所有锁定记录，可用于紧急解锁（自己被锁时重启容器即可）。

```bash
# 紧急解锁：重启容器清空所有失败记录
docker restart douyin-web
# 或通过 SSH
ssh root@47.83.139.171 "docker restart douyin-web"
```

---

## 注意事项

- `.env` 和 `cookies/douyin_cookies.json` 已加入 `.gitignore`，**绝不提交**
- 服务器内存仅 1.8GB，跑 Chromium 时建议暂停其他非必要容器
- 新平台爬虫开发时，`videos.douyin_created_at` 字段名为历史遗留，可视为通用的 `published_at`
- OSS AccessKey 请定期轮换，更新 `.env` 后重启 `douyin-web` 和 `douyin-scraper` 容器生效

