# G Learning Min Design

> **状态**：`draft`
> **需求**：[`requirements.md`](requirements.md)
> **上游 PRD**：[`prd-domain-g-learning.md`](../../../HBECHO设计方案/prd-domain-g-learning.md) v0.4
> **所属域**：G 学习平台 · **目录命名**：新名 `g-learning-min`，符合 `<代号>-<切片>`
> **最近核对**：2026-10-29
> **更新日期**：2026-10-29

## 1. 形状

| 类别 | 内容 | 说明 |
|---|---|---|
| 新增模块 | `courses`、`learning-progress`、`learning-summary`、`learning-tags` | 按资源聚合，不建「学习中心」大模块 |
| 新增表 | `courses`、`course_brand_scopes`、`tags`、`course_tags`、`learning_progress` | 5 张，全部新表，不改 A/B 域既有表 |
| 复用 | B 域 Capability / DataScope / 审计表；OSS SDK；VOD SDK | 不新建权限或审计实现 |
| 不建 | 事件表、物化汇总表、版本表、下载中心、消息通知 | 见 §9 |

技术栈沿用 ADR-0005：Node/TypeScript + Next.js + Drizzle + better-auth。本 spec 不引入新的框架级依赖。

## 2. 边界阶梯

| 能力 | 停在哪一级 | 具体 |
|---|---|---|
| 视频上传与播放凭证 | 云厂商官方 SDK | 阿里云 VOD SDK（`CreateUploadVideo`、`GetVideoPlayAuth`、`DeleteVideo`） |
| 视频播放器 | 官方 SDK | VOD Web 播放器 SDK；不自研 HLS |
| 资料与封面的对象存储 | 云厂商官方 SDK | 阿里云 OSS SDK，签名 URL |
| PDF 预览 | 浏览器原生 | `<iframe>` / `<embed>`，不引第三方 PDF 渲染库 |
| 进度与续播 | 自建（第 8 级） | 业务语义（位置保护、去重、汇总口径）没有现成库能表达 |
| 标签与课程 CRUD | 框架原生 | Drizzle + Next.js route handler |

## 3. 数据模型

规范来源：`database-design-v2.md` §5。所有表：内部 ID 为 signed `BIGINT`，API 输出十进制字符串；时间为 UTC `DATETIME(6)`；状态用 `VARCHAR + CHECK`；**不使用** `ON DELETE CASCADE`。

### 3.1 `courses`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | BIGINT | PK | |
| `title` | VARCHAR(200) | NOT NULL | |
| `kind` | VARCHAR(16) | NOT NULL, CHECK in ('video','document') | |
| `description` | TEXT | NULL | 纯文本 |
| `status` | VARCHAR(16) | NOT NULL, CHECK in ('published','unpublished') | 无草稿态 |
| `brand_scope` | VARCHAR(16) | NOT NULL, CHECK in ('specified','all') | |
| `cover_key` | VARCHAR(512) | NOT NULL | OSS object key |
| `vod_video_id` | VARCHAR(64) | NULL | video 必填，document 必须为 NULL |
| `vod_video_status` | VARCHAR(16) | NULL, CHECK in ('uploading','transcoding','normal','failed') | video 必填 |
| `file_key` | VARCHAR(512) | NULL | document 必填 |
| `file_mime` | VARCHAR(128) | NULL | `application/pdf` / `image/jpeg` / `image/png` |
| `file_size` | BIGINT | NULL | 字节 |
| `duration_sec` | INT | NULL | 由 VOD 转码结果回填 |
| `created_by` | BIGINT | NOT NULL | User ID |
| `created_at` | DATETIME(6) | NOT NULL | |
| `updated_at` | DATETIME(6) | NOT NULL | |

CHECK 组合约束：
- `kind='video'` → `vod_video_id`、`vod_video_status` 非空，`file_key` 为空；
- `kind='document'` → `file_key`、`file_mime`、`file_size` 非空，`vod_video_id` 为空；
- `brand_scope='all'` → `course_brand_scopes` 无行（由应用约束 + 测试保证，MySQL 无跨表 CHECK）。

### 3.2 `course_brand_scopes`

| 列 | 类型 | 约束 |
|---|---|---|
| `course_id` | BIGINT | FK → `courses.id`，ON DELETE RESTRICT |
| `brand_id` | BIGINT | FK → A 域品牌表，ON DELETE RESTRICT |

主键 (`course_id`, `brand_id`)。`brand_scope='all'` 时不写行。

### 3.3 `tags` 与 `course_tags`

| 表 | 列 | 说明 |
|---|---|---|
| `tags` | `id` BIGINT PK、`name` VARCHAR(32) UNIQUE、`created_at` DATETIME(6) | 只有超管可写 |
| `course_tags` | `course_id`、`tag_id`，复合 PK，FK RESTRICT | |

删除被引用的标签由应用拒绝（409），不加级联。

### 3.4 `learning_progress`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | BIGINT | PK |
| `user_id` | BIGINT | NOT NULL |
| `course_id` | BIGINT | FK → `courses.id` RESTRICT |
| `position_sec` | INT | NOT NULL DEFAULT 0 |
| `watched_sec` | BIGINT | NOT NULL DEFAULT 0 |
| `play_count` | INT | NOT NULL DEFAULT 0 |
| `first_learned_at` | DATETIME(6) | NOT NULL |
| `last_learned_at` | DATETIME(6) | NOT NULL |

唯一键 (`user_id`, `course_id`)。资料课程只更新首末时间与 `watched_sec` 不增长。

### 3.5 索引

- `courses(status, updated_at)`：列表默认排序；
- `course_brand_scopes(brand_id, course_id)`：按品牌反查；
- `course_tags(tag_id)`：单标签筛选；
- `learning_progress(user_id, last_learned_at)`：在学标记与筛选。

### 3.6 存储归属

| 内容 | 位置 | 理由 |
|---|---|---|
| 课程视频 | VOD（媒资地域华北2） | ADR-0007 |
| 资料文件 | `hbecho-media` 桶，前缀 `course/` | 复用 ADR-0001 的「长期保留、无自动过期」语义，不新增第五个桶 |
| 封面 | `hbecho-media` 桶，前缀 `course/cover/` | 同上 |

课程对象**不写入** A 域的 `media_assets` / `oss_objects` 表；两者只是共用同一个私有桶。

## 4. 关键流程

### 4.1 创建视频课程

```text
1. 客户端请求上传凭证 → 服务端校验 Capability、品牌、上限 → 调 VOD CreateUploadVideo
   （带 TemplateGroupId = hbecho-course 模板组）
2. 返回 UploadAuth / UploadAddress / VideoId
3. 客户端直传 VOD（服务端不中转字节）
4. 客户端通知「上传完成」→ 服务端查询视频状态
5. 状态 normal 或 transcoding → 创建 courses 行（vod_video_status 对应）
6. 转码完成后由轮询把 duration_sec 与最终状态回填
```

服务端不持有视频字节；上传失败不创建课程行。

### 4.2 创建资料课程

```text
1. 客户端请求签名直传地址（OSS PutObject，前缀 course/）
2. 客户端直传 → 服务端 HEAD 校验 size / content-type
3. 校验通过 → 创建 courses 行
```

### 4.3 播放

```text
1. 校验 learning.read + 课程品牌范围 + 状态 published
2. kind=document → 返回短期签名 URL（预览）
3. kind=video → 校验 vod_video_status
   - transcoding → 返回 202 + 状态，不返回凭证
   - failed → 返回 409
   - normal → 调 GetVideoPlayAuth，返回凭证与时长
4. 不缓存凭证；失败不缓存失败结果
```

### 4.4 进度上报

```text
POST /api/learning/progress
{ courseId, positionSec, deltaWatchedSec }
→ 校验范围与课程状态 → upsert learning_progress
```

幂等键为 (`user_id`, `course_id`)；并发请求按最后写入时间取胜。

## 5. 算法

### 5.1 可见范围

```text
visible(course, user) =
  course.status = 'published'
  AND ( course.brand_scope = 'all'
        OR EXISTS course_brand_scopes(course.id, b) WHERE b ∈ user.brandScope )
```

`user.brandScope` 由 B 域 DataScope 提供，不在本域重算组织关系。

### 5.2 续播位置保护

```text
newPos = max(0, positionSec)
if newPos < oldPos - 30 AND 本次上报无 seek 标记:
    keep oldPos
else:
    take newPos
```

阈值 30 秒是「明显回退」的经验值，放在配置里。

### 5.3 汇总

```sql
-- 课程数
SELECT COUNT(*) FROM courses c
WHERE c.status='published'
  AND (c.brand_scope='all' OR EXISTS (
    SELECT 1 FROM course_brand_scopes s JOIN <user_brand_scope> u ON s.brand_id=u.brand_id
    WHERE s.course_id=c.id));

-- 学习人数 / 时长 / 次数
SELECT COUNT(DISTINCT p.user_id), SUM(p.watched_sec), SUM(p.play_count)
FROM learning_progress p JOIN courses c ON c.id=p.course_id
WHERE c.status='published' AND <同上范围条件>;
```

1.0 不建物化表：数据量远低于需要预聚合的规模；接口保留 `range` 参数但只接受 `all`。

### 5.4 全部品牌

`brand_scope='all'` 是一个标记，不是快照。查询时直接放行，因此新增品牌自动可见，无需数据迁移。

## 6. 失败语义

| 场景 | 结果 |
|---|---|
| VOD 上传凭证失败 | 500 + 可重试标记；不创建课程行 |
| 上传成功但转码失败 | 课程行存在，`vod_video_status='failed'`；学员看到「暂不可播放」，维护者可替换文件 |
| 转码中请求播放 | 202 + 状态；不返回凭证 |
| 播放凭证过期 | 前端重新请求；服务端不缓存 |
| OSS 直传成功但 HEAD 校验失败 | 删除对象，课程不创建 |
| 替换时旧视频删除失败 | 新课程照常生效；记录失败事件并进重试队列；审计保留旧 VideoId |
| 课程已下架但持有直链 | 403 |
| 品牌范围变更后学员不再覆盖 | 立即 403；进度保留 |
| 汇总查询超时 | 返回 503，不返回部分数字 |

**不产生「静默空值」**：转码中、失败、无权限、无内容必须是四种不同响应。

## 7. 与相邻域的边界

| 相邻域 | 交互 |
|---|---|
| B 访问控制 | 只调 Capability 与 DataScope；审计写 B 域审计表，不自建审计 |
| A 数据底座 | 只读品牌列表与 `User → brandScope`（经 B 域）；**不写** `media_assets` / `oss_objects` |
| E 指标 | 无交互；学习数据不进指标 |
| I 运维 | VOD 与 OSS 成本、备份、清理归 I 域 |

## 8. 测试策略

| 类型 | 覆盖 |
|---|---|
| 纯函数 | 可见范围、续播保护、上限校验、汇总口径 |
| 真库 | Drizzle 迁移、CHECK 约束、唯一键、RESTRICT 外键 |
| fake VOD | 凭证成功/失败、转码中、失败、删除失败 |
| fake OSS | 签名 URL、HEAD 校验、下载审计 |
| 手工 | 手机浏览器播放、倍速、拖动、续播；PDF 预览 |

默认测试禁用网络；VOD 与 OSS 全部走 fake transport。真实 smoke 需人工批准并记录预算。

## 9. 明确不做与已知上限

| # | 不做 | 原因 |
|---|---|---|
| 1 | 事件流水表 | 1.0 只需当前进度；流水没有查询入口 |
| 2 | 物化汇总表 | 数据量不足以证明需要；先写简单聚合 |
| 3 | 课程版本表 | G-D10 替换即覆盖 |
| 4 | 下载中心 / 批量下载 | 单文件下载足够 |
| 5 | 消息通知 | 无下游需求 |
| 6 | 多码率手动切换 | VOD 播放器自动选择 |
| 7 | 防刷与异常学习检测 | 无积分，无动机；只记录 |
| 8 | 跨品牌内容审核 | G-D08 明确不做审批 |

已知上限：
- 汇总为全表聚合，课程数上万时需要改预聚合；
- 进度写入为逐次 upsert，高频上报会产生写放大，必要时前端节流；
- 替换时旧 VOD 视频删除是异步补偿，极端情况下会残留孤儿视频（成本影响，不影响正确性）。

## 10. 决策记录

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| D1 | 资料与封面放 `hbecho-media` 桶的 `course/` 前缀，不新增桶 | 复用「长期保留」语义；避免改 ADR-0001 与 RAM 策略 | 2026-10-29 |
| D2 | 不建学习事件流水表 | 1.0 无查询需求；进度只需当前值 | 2026-10-29 |
| D3 | 不建物化汇总 | 量小；先简单聚合，按实测再优化 | 2026-10-29 |
| D4 | 视频字节不在服务端中转 | 浏览器直传 VOD，减少 ECS 带宽与故障面 | 2026-10-29 |
| D5 | 转码中返回 202 而非错误 | 「还没好」与「坏了」必须可区分 | 2026-10-29 |
| D6 | 续播回退阈值 30 秒 | 防拖动清零，又不妨碍正常后退 | 2026-10-29 |