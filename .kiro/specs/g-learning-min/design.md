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
| `status` | VARCHAR(16) | NOT NULL, CHECK in ('published','unpublished','archived') | 无草稿态；`archived` 由下架满 30 天的清理任务自动置位 |
| `brand_scope` | VARCHAR(16) | NOT NULL, CHECK in ('specified','all') | |
| `audience_level` | VARCHAR(24) | NOT NULL DEFAULT 'all', CHECK in ('all','branch_and_above','hq_and_above') | 适用人员级别（G-D40） |
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

> **暂不建到 `brands` 的外键**（D15，2026-10-30）：A 域的 `brands` 表尚未落地，G 只存 `brand_id` 并由应用层校验；A 域建表后补一条 FK 迁移。不建平行品牌表。

> **`user_id` 同样暂不建到 B 域用户表的外键**（D15）：B 域用户表尚无迁移。

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
| 课程视频与封面 | VOD（媒资地域华北2） | ADR-0007；封面用 VOD 图片媒资 |
| 资料文件 | **`hbecho-course` 桶**（2026-10-30 已建），前缀 `doc/` | 资料需要替换时删除旧对象；`hbecho-media` 的 RAM 策略明确没有 `DeleteObject`，不能复用（ADR-0001 现行承诺） |

课程对象**不写入** A 域的 `media_assets` / `oss_objects` 表。新增 `hbecho-course` 桶需要在 ADR-0001 补一条修订，并为应用角色 `hbecho-ecs-role` 增加该桶的 `Put/Get/Delete/List` 权限。

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

**幂等**：创建请求必须携带客户端生成的 `Idempotency-Key`，同一 key 的重复提交返回第一次的结果，不重复建课。key 保留 24 小时。

### 4.2 创建资料课程

```text
1. 客户端请求签名直传地址（OSS PutObject，hbecho-course 桶，前缀 doc/）
2. 客户端直传 → 服务端 HEAD 校验 size / content-type，并读取对象头校验**文件魔数**
   （PDF `%PDF-`、JPEG `FF D8 FF`、PNG `89 50 4E 47`）
3. 校验通过 → 创建 courses 行；魔数不符则删除对象并拒绝
```

### 4.3 播放

```text
1. 校验 learning.read + 课程品牌范围 + 状态
   - `status='archived'` → 403（媒体已删除，不可恢复）
   - `status='unpublished'` → 403
2. kind=document → 返回短期签名 URL（预览）
3. kind=video → 校验 vod_video_status
   - transcoding → 返回 202 + 状态，不返回凭证
   - failed → 返回 409
   - normal → 调 GetVideoPlayAuth，返回凭证与时长；**有效期直接用 VOD 返回值**，不自定义（D14）
4. 不缓存凭证；失败不缓存失败结果
```

**学员只看可播**：课程列表对学员只返回 `vod_video_status='normal'` 的视频课与全部资料课；维护者列表可见 `transcoding` 与 `failed`。

**下架时正在播放**：已签发的凭证在有效期内继续可用，允许看完当前这段；下一次取凭证时返回 403。服务端不主动中断播放。

### 4.4 进度上报

```text
POST /api/learning/progress
{ courseId, positionSec, deltaWatchedSec }
→ 校验范围与课程状态 → upsert learning_progress
```

幂等键为 (`user_id`, `course_id`)；并发请求按最后写入时间取胜。

## 5. 算法

### 5.1 可见范围

**所有**课程查询（列表、搜索、详情、播放、下载、汇总）必须经过同一个范围过滤器，不允许各写各的条件。漏一处就是跨品牌内容泄露。

```text
visible(course, user) =
  course.status = 'published'
  AND course.audience_level IN allowedLevels(user.role)
  AND ( course.brand_scope = 'all'
        OR EXISTS course_brand_scopes(course.id, b) WHERE b ∈ user.brandScope )

allowedLevels(store_staff)      = ('all')
allowedLevels(branch_manager)   = ('all','branch_and_above')
allowedLevels(hq_manager)       = ('all','branch_and_above','hq_and_above')
allowedLevels(platform_admin)   = ('all','branch_and_above','hq_and_above')
```

角色到级别的映射只在这一处定义，不散落到各接口。`user.brandScope` 由 B 域 DataScope 提供，不在本域重算组织关系。品牌名称与品牌列表缓存 5 分钟（D22）；可见性用的是品牌 ID 集合，缓存过期后重建。

**越权测试是必做项**：用 A 品牌的账号逐接口访问 B 品牌的课程，详情、播放、下载、搜索、汇总都必须 403 或不返回。

### 5.2 续播位置

**不做回退保护**（G-D18）：`position_sec` 始终取最后一次上报的值，只有超出 `duration_sec` 时才截断到片长。

```text
newPos = min(max(0, positionSec), durationSec)
keep newPos
```

代价：用户误拖到开头后，下次从开头继续。这是有意选择的简单行为——没有隐藏规则，也没有「为什么它把我拉回去了」的解释成本。

### 5.3 汇总

```sql
-- 课程数：只算已发布且学员可播的（G-D27）
SELECT COUNT(*) FROM courses c
WHERE c.status='published'
  AND (c.kind='document' OR c.vod_video_status='normal')
  AND (c.brand_scope='all' OR EXISTS (
    SELECT 1 FROM course_brand_scopes s JOIN <user_brand_scope> u ON s.brand_id=u.brand_id
    WHERE s.course_id=c.id));

-- 学习人数 / 时长 / 次数：含已下架课程，历史只增不减（G-D20）
SELECT COUNT(DISTINCT p.user_id), SUM(p.watched_sec), SUM(p.play_count)
FROM learning_progress p JOIN courses c ON c.id=p.course_id
WHERE c.brand_scope='all' OR EXISTS (
  SELECT 1 FROM course_brand_scopes s JOIN <user_brand_scope> u ON s.brand_id=u.brand_id
  WHERE s.course_id=c.id);
```

下架课程仍保留 `course_brand_scopes`，所以范围条件照常生效；不按 `status` 过滤，避免「累计」数字因下架而下降。

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
| 审计写入失败 | **不阻断业务**；写应用日志并触发告警，不重试（G-D24） |
| 上传中断留下的 VOD 视频 | 定时任务扫描无课程引用的 `VideoId`，超过 24 小时删除并记日志（G-D23） |
| 下架满 30 天的课程 | 删除视频/资料文件，`status` 置 `archived`；进度、汇总、审计保留（G-D37）。媒体删除失败时课程仍归档、记录失败并重试 |

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
| 9 | 按具体分公司/大区定向发课 | 1.0 只有品牌与角色级别；组织级定向留 2.0（G-D40） |

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
| D6 | 续播不做回退保护 | G-D18；少一个分支，行为可预测 | 2026-10-29 |
| D7 | 资料放新增的 `hbecho-course` 桶 | media 桶无删除权限，资料替换必须能删 | 2026-10-29 |
| D8 | 汇总人数/时长/次数含已下架课程 | 「累计」不应因下架而减少 | 2026-10-29 |
| D9 | 单次增量超 60 秒截断 | 防节流补报与前端异常撑大时长 | 2026-10-29 |
| D10 | 并发编辑不处理 | 已知风险，见 PRD §6.7；维护者少 | 2026-10-29 |
| D11 | 审计失败不阻断业务 | 可用性优先；日志 + 告警留证 | 2026-10-29 |
| D12 | 上传残渣定时清理 | 避免无引用视频长期计费 | 2026-10-29 |
| D13 | 资料与封面校验文件魔数 | 只信扩展名会被改名文件绕过 | 2026-10-30 |
| D14 | 播放凭证有效期用 VOD 默认 | 少一个配置，行为与官方播放器一致 | 2026-10-30 |
| D15 | 暂不建跨域外键（`brand_id`、`user_id`） | 对端表尚未落地；不建平行主档，落地后补迁移 | 2026-10-30 |
| D16 | B 域权限用薄适配层接入 | B 域 Capability 名已在 PRD 定稿，先按接口写，实现后替换 | 2026-10-30 |
| D17 | 课程不物理删除，下架满 30 天转 `archived` 并删媒体 | 保住进度、汇总与审计；存储真正释放 | 2026-10-30 |
| D18 | 视频上传校验 MP4/H.264/AAC | 提高转码成功率，失败可排查 | 2026-10-30 |
| D19 | 微信内下载改为「去浏览器打开」提示 | 微信不允许网页触发文件下载，适配无法绕过 | 2026-10-30 |
| D20 | 课程数不统计 `archived`；人数/时长/次数**仍计入** | 归档只是删媒体，学习历史仍然存在，不能让「累计」下降 | 2026-10-30 |
| D21 | 所有课程查询走统一范围过滤器 | 条件散落在各接口必有遗漏；配越权测试兜底 | 2026-10-30 |
| D22 | 品牌名称与列表缓存 5 分钟 | 品牌极少变化；接受新品牌最多 5 分钟延迟生效 | 2026-10-30 |
| D23 | 不预留学习明细表 | 1.0 用不到；2.0 需要时再加，不影响现有累计值 | 2026-10-30 |
| D24 | 课程可见性增加「适用人员级别」，与品牌取交集 | 管理类内容不该给门店看；复用 RoleCode，不建职级字段、不挂 DataScope | 2026-10-30 |