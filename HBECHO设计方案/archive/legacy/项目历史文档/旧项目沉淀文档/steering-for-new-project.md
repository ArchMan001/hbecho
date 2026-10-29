# 新媒体赋能平台 — AI 上下文记忆文件

> **用途：** 此文件放入新项目 `media-platform/.kiro/steering/project-context.md`，Kiro 每次对话自动加载，无需重复解释背景。

---

## 项目身份

这个项目叫 **media-platform**，是对旧项目 **lxk-BigSpard** 的完整重构升级。

旧项目是总部内部工具（约10-20人使用），新项目是面向总部、分公司、经销商三级用户的完整平台（约2000+人使用）。

**开发者：** 刘雪奎，独立开发，Mac 本地开发，Docker 容器化部署。

---

## 业务背景

**甲方：** 海信日立公司，旗下三大品牌：海信、日立、约克。

**业务场景：** 全国 42 个分公司，近万家门店，约 2000 名门店新媒体专员，每逢五一、618、双11 等营销节点，需要在抖音发布 3-5 条短视频并更换主页背景图，为活动造势。

**原有痛点：**
- 总部/分公司人工点检 2000 个账号，一个活动点检 4 次，耗费大量人力
- 无精确视频数据，无效果评估
- 脚本建议基本不被采纳，内容质量差
- 没有优化闭环

---

## 三级用户体系（核心设计）

```
角色               数据范围                  典型操作
──────────────────────────────────────────────────────
hq_admin          所有品牌/分公司/门店数据   管理活动、下发脚本、查看全国排名
branch_manager    本分公司下属门店数据        查看本区数据、给经销商发通知
dealer_staff      只有自己绑定的账号数据      查看自己的视频数据、接收脚本任务
```

**数据范围隔离原则：前端控制"看到什么菜单"，后端通过 `getDataScope(user)` 中间件控制"能拿到什么数据"，每个接口都必须加范围过滤，绝对不能依赖前端控制数据安全。**

**登录方式：** 邀请制 + 手机号 + 密码。管理员批量导入用户（手机号+角色），用户收到邀请后设置密码。不接入飞书/微信，完全自主可控。

---

## 旧项目数据库（可直接复用的资产）

旧项目数据库名：`douyin_scraper`，MySQL 8.0，15张表。新项目共用同一个 MySQL 实例，扩展旧表结构。

### 核心表说明

**`dealers`** — 物理门店主档
```
id, brand(海信/日立/约克), region(大区), branch(分公司名，字符串，待改造为外键),
sector, dealer_name, store_code(唯一键), store_name, store_tier
```
⚠️ 注意：`branch` 字段当前是纯字符串，新平台需要新增 `branches` 表并改为外键关联，以支持分公司级别的权限绑定。

**`dealer_staff`** — 专员+社媒账号（一行=一人+一平台）
```
id, dealer_id(FK→dealers), contact_name, contact_phone,
platform(douyin/wechat_video/xiaohongshu), account_identifier(抖音=sec_uid),
home_url, nickname, avatar_url/local, bg_url/local,
bg_match_standard(1=背景图符合标准/0=不符合/NULL=未比对),
is_certified(1=认证通过，活动点检的分母),
follower_count, total_favorited, video_count,
status(active/error/pending), last_scraped_at, last_scrape_error
```
⚠️ 注意：`contact_phone VARCHAR(100) NOT NULL DEFAULT ''` 设计有问题，空字符串和 NULL 语义混乱，新平台改造时需修复为 `DEFAULT NULL`。

**`videos`** — 视频记录（只存命中关键词的视频）
```
id, staff_id(FK), aweme_id(唯一键), title, like_count, comment_count,
share_count, cover_url, cover_local(OSS URL或相对路径),
douyin_created_at(字段名历史遗留，实为通用发布时间),
ai_transcript, ai_analysis, ai_script(AI赋能字段，已存在)
```

**`campaign_events`** — 营销活动主表
```
id, campaign_code(唯一，如hitachi_51_2026), campaign_name, start_date, end_date, status
```

**`campaign_video_types`** + **`campaign_type_keywords`** — 三层关键词体系
```
活动 → 视频类型（活动视频/产品视频）→ 关键词（OR-of-AND匹配）
同一 rule_group 的关键词 AND，不同 rule_group 之间 OR
关键词内空格拆成子词，子词之间 AND
```

**`video_type_matches`** — 权威命中记录
```
id, video_id(FK), campaign_id(FK), video_type_id(FK), matched_at
```
⚠️ 已知 Bug：唯一键是 `(video_id, video_type_id)`，缺少 `campaign_id`，导致同一视频在不同活动下命中同一类型时第二条插不进去。新平台改造时必须修复为 `(video_id, campaign_id, video_type_id)`。

**`staff_campaign_membership`** — 账号级活动打标
```
id, campaign_id, staff_id, is_participating, qualified_video_count(每次爬取后精确重算)
```

**`scrape_jobs`** — 爬取任务队列（旧项目已有，新平台可升级为 BullMQ）
```
id, mode(full/campaign/bg-rescrape/bg-rematch), campaign_id, status(pending/running/done/error),
progress_total, progress_done, progress_success, progress_error
```

**`admin_users`** — 旧项目的管理员表（新平台用新的 `users` 表替代）

### 数据库改造要点（新平台启动时必做）

1. 新增 `branches` 表（分公司主档），`dealers.branch` 字符串改为 `branch_id` 外键
2. 新增 `users` 表（三级用户，替代 `admin_users`），字段含 `role/branch_id/staff_id/mobile/invite_token`
3. 修复 `video_type_matches` 唯一键（加上 `campaign_id`）
4. 修复 `dealer_staff.contact_phone`（NOT NULL DEFAULT '' → DEFAULT NULL）
5. 新增 `script_tasks` 表（AI脚本任务）和 `script_assignments` 表（任务分配给专员）
6. MySQL 配置升级：`innodb-buffer-pool-size` 从 128M → 512M，`max-connections` 从 30 → 100

---

## 旧项目可复用的代码资产

| 资产 | 路径（旧项目） | 复用方式 |
|------|------|------|
| 爬虫核心逻辑 | `scraper/src/scraper.js` | 整个 scraper 目录复制过来，只改触发方式 |
| 背景图比对 | `scraper/src/bg_comparator.py` | 直接复用 |
| OSS 图片上传 | `scraper/src/imageDownloader.js` | 直接复用 |
| 活动关键词匹配算法 | `web/src/routes/keywords.js` | 复用匹配逻辑 |
| AI 接口（ASR+分析） | `web/src/routes/ai.js` | 复用 SSE 流式输出模式 |
| Excel 导出 | `web/src/routes/export.js` | 复用 ExcelJS 导出逻辑 |
| 数据库连接池 | `web/src/db.js` | 直接复用 |
| Docker 部署配置 | `docker-compose.yml` | 在此基础上扩展 |

---

## 技术栈

```
前端：     Vite + Vue 3 + Element Plus + Vue Router + Pinia
后端：     Node.js + Express
队列：     BullMQ + Redis（替代旧项目的手动触发爬虫）
数据库：   MySQL 8.0（共用旧项目的数据库实例，扩展表结构）
AI平台：   Dify（私有化部署，Docker Compose，含知识库）
AI模型：   阿里云 DashScope（qwen-plus/qwen-vl/qwen3-asr-flash）
图片存储： 阿里云 OSS（bucket: lxk-douyin-covers）
部署：     Docker Compose + Nginx + 阿里云 ECS（4核8G，香港）
```

**关键决策：**
- **不换 PostgreSQL**：Dify 自带独立 PostgreSQL，业务数据继续用 MySQL，两者完全隔离
- **不用 React**：Vue 3 + Element Plus 对企业后台更合适，学习曲线平滑
- **Dify 而非 LangChain**：Dify 可视化编排工作流，含知识库，调用后给 Express 一个 API，语言无关
- **8G 内存够用**：峰值约 5GB（MySQL 300M + Redis 50M + Node 250M + Dify 1.5G + Chromium 800M）

---

## 服务器信息

**新服务器（即将租用）：**
- 阿里云 ECS，4核8G，50G ESSD，香港节点
- 新旧项目共存，共用 MySQL 实例
- Nginx 反代（宝塔管理），HTTPS

**旧服务器（现有）：**
- 阿里云香港，1.8G 内存，IP: 47.83.139.171
- 域名：ai.liuxuekui.click
- 旧项目新平台稳定后停掉旧服务容器，MySQL 数据迁移到新服务器

---

## 当前开发阶段

**阶段零（当前）：** 搭环境，新项目骨架。

**阶段一（下一步）：** 数据库改造 + 三级权限体系 + 数据看板。这是最优先的工作，必须先把数据库改造和三级权限设计清楚，其他所有模块都依赖这个基础。

详细的分阶段计划见：`HBECHO设计方案/product-plan.md`

---

## 编码规范

- 后端：CommonJS（`require/module.exports`），与旧项目保持一致
- 文件名：驼峰命名（`accountLoader.js`，`getDataScope.js`）
- 数据库查询：直接用 `mysql2`，不引入 ORM
- 错误处理：所有 async 路由必须 try-catch，有全局错误中间件兜底
- 注释：中文注释，保持与旧项目风格一致
- 敏感信息：数据库密码、API Key、OSS Key 全部走 `.env`，绝不硬编码
