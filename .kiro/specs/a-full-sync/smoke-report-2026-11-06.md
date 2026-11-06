# a-full-sync · 真实 smoke 报告（2026-11-06）

> **状态**：`recorded`（一次性结果记录，不是合同）
>
> **授权**：刘学奎 2026-11-06 书面授权：不限调用数 / 点数 / 金额，按规则跑，过程不再逐项确认。
>
> **规格**：[`requirements.md`](requirements.md) FS-19 · [`tasks.md`](tasks.md) 任务 11 · [`acceptance.md`](acceptance.md) ENV-2
>
> **更新日期**：2026-11-06

## 1. 怎么跑的

- **输入**：用户给的 38 条脏分享文案（小红书 6 主页 + 9 作品、快手 10 主页 + 6 作品、抖音 3 主页 + 4 作品），**原样**交给 AI Master，没有预先清洗。系统自己的 `classifyLocator` 只截掉第一个 URL 之后的文字，前缀分享文案保留。
- **走的是真实代码路径**，不是旁路脚本：
  - 入口：tracer 的 `resolve_account`（主页 + 首页列表，每个主页入口一个自有账号 / 一个专员）；
  - 周期：`supplement` 批次 → 真实 `fetch_profile` / `fetch_content_list` Runner → 账号级媒资任务；
  - 按需：`demand` 提交详情 / 评论 / 视频 / 音频 → 真实 `fetch_content_detail` / `fetch_comments` / `download_media` Runner；
  - 作品链接另做**直接探测**：把脏文案原样作为 `url` 发给 `media_stats_number`，只看供应商行为。
- **环境**：本机；真实 AI Master；ODS 写入真实 OSS（`hbecho-ods` 桶的 `smoke/fullsync-*` 前缀）；正式媒资也放同一个桶的 `smoke/fullsync-media/` 前缀（**没有写 `hbecho-media` 桶**，它永不过期）；Python 能力服务本机运行；独立的一次性 MySQL 容器（`hbecho-fullsync-smoke-mysql`，卷 `hbecho-fullsync-smoke-data`，旧 tracer smoke 库没动）。
- **环境类型**：`test`（capability 门控放行 `fixture_observed` 及以上）。production activation 一个都没动。
- **重试与翻页上限写死**：列表至多 3 页、任务至多 3 次尝试、评论至多 3 页；账号解析至多 3 次。
- **复现**：`scripts/smoke/fullsync-smoke.ts`（阶段：`setup / intake / round / demand / video / drain / probe / report`）。输入文件和报告数据在 `/tmp/fullsync-smoke/`，不进仓库。

## 2. 结果总览

| 能力 | 抖音 | 小红书 | 快手 |
|---|---|---|---|
| 主页（`media_user_info` 同步） | 3 / 3 成功 | 6 / 6 成功 | **4 / 10 成功**；6 个失败是供应商限制，见 §4.1 |
| 首页列表（建基线） | 3 / 3 | 6 / 6 | 2 / 4（账号主页成功的）；见 §4.3 |
| 命中旧边界（检查点，稳态一轮） | 3 / 3 `boundary_hit` | 6 / 6 `boundary_hit` | 1 / 1（其余账号的问题见 §4） |
| 多页翻页（把检查点锚点换成不存在的 ID，真实游标） | 3 页（`safety_limit_rebased`）+ 2 页（`end_of_list_rebased`） | 3 页 × 2 | 3 页 × 1 |
| 详情（`media_stats_number`，作品链接原样直探） | 4 / 4 | 9 / 9 | **6 / 6**（内容 URL 构造已验证，见 §3） |
| 详情（我们的 Runner，按需） | 成功 | 成功 | 成功（修复后） |
| 评论（`post_comments_list`） | 成功；触达 3 页上限 → `partial`，不标疑似删除 | 成功；全部 `partial`（总数 22 / 42 / 10，只抓到 6 / 11 / 6） | 不支持（按设计） |
| 视频下载 + 音频抽取 | 端到端通过 | 端到端通过 | 端到端通过 |
| 封面 / 头像 / 背景归档 | 成功（HEIC 16 张曾转换失败，已修，见 §3） | 成功 | 成功；1 张封面 CDN 转换不可用 |

数量：721 个图片资产（42 MB）、3 个视频（9.6 MB）、3 个音频（0.26 MB）、391 条内容、613 个内容快照、68 条评论；ODS 对象 372 个。

## 3. smoke 发现并已经修掉的问题

| # | 现象 | 处置 |
|---|---|---|
| 1 | **快手详情的内容 URL 构造**（design §14 第 2 项，tasks 必须停下来问第 10 项）有了结论：`https://www.kuaishou.com/short-video/{post_id}` 与 `https://v.m.chenzhongtech.com/fw/photo/{post_id}` 被接受；`c.kuaishou.com/fw/photo/…`、`m.gifshow.com/fw/photo/…` 被拒（`RESULT_VALIDATION_FAILED`） | `ContentUrlBuilder` 对快手返回 `short-video` 形式；快手详情同步 tuple 放行。异步 tuple 同日补测：脏文案原样 6/6、规范 URL 6/6 均成功，也放行（见 §5.1）。production 不动 |
| 2 | 抖音视频下载被拒：`v9.douyinvod.com` 不在视频 CDN 白名单。没有 `api-play.amemv.com` 候选时，`douyinvod.com` 是唯一来源（`api-hl.amemv.com` 会 302 到它） | 白名单加 `douyinvod.com` |
| 3 | **16 张抖音 HEIC 封面转换失败**（约 13%）：能力服务把图片经 `pipe:0` 喂给 ffmpeg，HEIF 的元数据在文件里的位置因文件而异，不可 seek 的管道会报 `partial file` | 改为写临时文件再转换；加了能复现的真实样本和回归用例 |
| 4 | 快手同步调用有 19–48 秒的，30 秒超时下 6 次变成 `ambiguous`（可能已计费但结果丢失） | `HttpProviderTransport` 默认超时 30 → 90 秒；`smoke` 里用环境变量可调 |

## 4. 未解决的问题（需要你或 AI Master 决定）

### 4.1 快手"自定义 ID"的主页，AI Master 解不出来（6 / 10）

快手主页分享链接 302 到 `c.kuaishou.com/fw/user/{id}`。`{id}` 是 `3x…` 形式的加密 ID 时主页成功；是自定义 ID（`P6876865`、`gyjd2068620`、`sxwoaiwojia` 等）时，`media_user_info` 稳定返回 `500 RESULT_VALIDATION_FAILED`（"Input should be a valid dict"，上游 `result` 为 null）。**换 URL 形式没用**（`c.kuaishou.com/fw/user/…`、`www.kuaishou.com/profile/…`、整段脏文案、只留 URL，结果相同）。结论：这是供应商对自定义 ID 的限制，不是我们的清洗问题。我们的系统把它按"入口无效"终止（`result_validation_exhausted`，3 次尝试），没有写任何空数据。

### 4.2 快手 `user_id` 不稳定：同一账号时而返回数字 ID、时而返回 `3x…` ID

同一账号（昵称相同）两次主页响应的 `user_id` 分别是 `2904903906` 和 `3xjetjiy84bkctq`（粉丝数、作品数相同）。我们的身份模型用一个命名空间 `kuaishou.user_id`，所以：
- 第二次入口录入：新身份 → `staff_platform_slot_taken`（该专员已有账号）；
- 周期批次：已登记数字 ID 的账号，之后的主页响应是 `3x…` ID → `profile_uid_mismatch`，该账号的主页与列表都被拦下。

这是**设计层面的缺口**：快手需要把两种 ID 当同一账号的别名（可以用列表作者 ID `3x…` 作桥接证据，类似小红书的 `dominant_list_author`），或者请 AI Master 保证返回稳定形式。**需要决定，不能由实现自行猜测**（tasks "必须停下来问"第 4 项）。

### 4.3 快手列表：两个 `3x…` ID 账号的 `user_video_list` 始终 `RESULT_VALIDATION_FAILED`；其它的很慢

- 2 个主页成功的账号，列表每次都 `provider_validation_failed`（重试到 `dead`）；
- 成功的列表调用平均 21 秒（最长 48 秒），失败的平均 47 秒（最长 84 秒），比另外两个平台慢 3–10 倍。

### 4.4 媒资吞吐

账号级媒资任务（头像 / 背景 / 约 20 张封面，下载 → 本机 ffmpeg 转换 → 两次上传 OSS）平均 227 秒，最长 1,220 秒；并发 1。**这是本机经公网上传 OSS 的数字，测试 ECS 同地域内网会快得多，但还没量**。首次上线 6,000 账号 × ~20 张封面时，需要提高媒资并发或让账号内的引用并行。

### 4.5 其它观察

- 小红书图文笔记的 `download_urls` 全是图片：对图文笔记要 `video` 会尝试下载图片，被"不是视频"拦下（安全，但白发一次请求）；
- 头像 / 背景每个批次重新下载一次（按设计）；封面只下载新内容（首次规则在稳态一轮里只新增 4 个）；
- `staff` 表的 ID 从 2^53+1 起（seed 的大 ID 副作用），不是问题。

## 5. 成本与规模

| 指标 | 数值 |
|---|---|
| 供应商调用总数 | 186（含 28 次作品探测） |
| 已计点（成功） | 1,570 点 ≈ ¥31.4 |
| `ambiguous`（可能已计费但未知，均为 30 秒超时） | 6 次，点数上界 60 点 ≈ ¥1.2 |
| 失败调用 | 51 次 `http_error`（主要是快手 `RESULT_VALIDATION_FAILED`，不计点） |
| 周期批次（13 账号，含 3 页翻页测试） | 40 次调用，410 点 |
| 按需批次（详情 + 评论 + 视频） | 17 次调用，185 点 |
| 单次延迟（均值 / 最大，成功） | 抖音 3–10 / 20 秒；小红书 4–6 / 12 秒；快手 7–21 / 48 秒 |

### 5.1 补测：快手详情异步（同日）

12 次提交（脏文案 6 + 规范 URL 6）全部成功，轮询 51 次。提交均值 0.3–0.5 秒（最长 2.6 秒），每次轮询 0.1–0.2 秒，两次轮询间隔约 2 秒，一条作品从提交到拿到结果 5–25 秒。点数 120（轮询不计点）≈ ¥2.4，本报告其他数字不含这一笔。

另补测（同日，2 次）：快手自定义 ID 主页走**异步**，提交 202 后第一次轮询就是 `failed`（`ACTION_EXECUTION_FAILED`），与同步一样。所以同步 → 异步兜底（requirements FS-12.7）救不了这 6 个主页，它们仍是供应商限制（§4.1）。

## 6. 对 capability 登记的建议

| tuple | 建议 | 说明 |
|---|---|---|
| 抖音 / 小红书 主页、列表、详情、评论（同步） | 保持 `smoke_verified` | 本次再次通过 |
| 快手 主页（同步） | `smoke_verified`，加 `knownGaps`: `vanity_id_unsupported_by_provider`、`user_id_form_unstable` | §4.1、§4.2 |
| 快手 列表（同步） | `smoke_verified`，加 `knownGaps`: `intermittent_validation_failed`、`slow_responses` | §4.3 |
| 快手 详情（同步） | **已放行**（本次修改） | §3 第 1 项 |
| 快手 详情（异步） | **已放行**（补测 12/12 成功） | §5.1 |
| 全部 production | **仍然 disabled** | 启用另走人工批准；快手在 §4.2 解决前不建议启用 |

## 6.1 调用级证据

[`smoke-calls-2026-11-06.tsv`](smoke-calls-2026-11-06.tsv)：smoke 数据库 `ods_provider_calls` 的逐调用导出（批次、任务、平台、动作、模式、尝试号、序号、状态、结果、HTTP 状态、耗时、时间），共 249 行。不含 URL、密钥、载荷。行数大于 §5 的 186，因为它还包含异步轮询（`task_lookup`，不计点）以及后续补测（快手详情异步 12 次、快手自定义 ID 主页异步 2 次）。

## 7. 清理

OSS 上 `smoke/fullsync-ods/` 与 `smoke/fullsync-media/` 前缀下共约 1,100 个对象（约 56 MB）保留，供复核；本机 MySQL 容器和卷保留（`docker rm -f -v hbecho-fullsync-smoke-mysql` 并 `docker volume rm hbecho-fullsync-smoke-data` 可清理）。
