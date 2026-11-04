# AI Master 实测计划 · raw4

> **日期**：2026-10-28
> **目的**：复测历史 25 个成功样本（raw3）之外的两类能力——**具体视频详情**与**具体视频评论**；同时补测从未验证过的**异步模式**。
> **前置开关**：`.env` 中 `AIMASTER_ENABLED=true`。
> **预算上限**：40 次调用（含重试与轮询）；预计 15–22 次。
> **执行方式**：串行，不并发。每次调用落一份请求与响应原文。

## 一、用例与顺序

| # | 平台 | 动作 | 模式 | 输入 | 目的 |
|---|---|---|---|---|---|
| C1 | 抖音 | `media_user_info` | 同步 | 历史主页分享文本 | 验证认证方式（`X-Api-Key` 还是 Bearer）与基础返回 |
| C2 | 小红书 | `media_user_info` | 同步 | 历史主页分享文本 | 验证 profile ID 与字段 |
| C3 | 抖音 | `user_video_list` | 同步 | 同 C1 | 条目数、`max_cursor` 类型（预期数字） |
| C4 | 小红书 | `user_video_list` | 同步 | 同 C2 | 条目数、`max_cursor` 类型（预期字符串） |
| C5 | 抖音 | `media_stats_number` | 同步 | 历史视频分享文本 | **具体视频详情**：字段、互动数、作者 |
| C6 | 小红书 | `media_stats_number` | 同步 | 历史笔记分享文本 | 同上 |
| C7 | 抖音 | `post_comments_list` | 同步 | 同 C5，`max_cursor=0`，`reply_pages=-1` | **具体视频评论**：一级评论数、游标、字段 |
| C8 | 小红书 | `post_comments_list` | 同步 | 同 C6，同上 | 同上 |
| C9 | 抖音 | `media_user_info?async=true` | 异步 | 同 C1 | 提交 → 轮询 → 终态结构 |
| C10 | 小红书 | `user_video_list?async=true` | 异步 | 同 C2 | 提交 → 轮询 → 终态结构 |
| C11 | 抖音 | `media_user_info` | 同步 | 同 C1 | 控制组：与 C1 对比，验证同一输入是否稳定 |

**不测**：视频号、快手、评论回复（`reply_pages=-2`）、分页翻到第二页。这些不影响 1.0 的验收，且会增加预算。

## 二、重试策略

| 情况 | 是否重试 | 次数 | 间隔 | 说明 |
|---|---|---|---|---|
| 连接超时 / 连接重置 | ✅ | 最多 2 次 | 2s、8s | 每次重试记录为独立 attempt |
| HTTP 429 | ✅ | 最多 2 次 | 优先 `Retry-After`，否则 30s | 记录 `Retry-After` |
| HTTP 5xx | ✅ | 最多 2 次 | 5s、20s | |
| HTTP 400 / 422 | ❌ | — | — | 输入问题，重试无意义 |
| HTTP 401 / 403 | ❌ | — | — | 认证问题，**立即停止全部用例** |
| HTTP 404 | ❌ | — | — | 链接失效或内容不存在 |
| 响应 schema 不符 | ❌ | — | — | 保留原文，记为 `schema_error` |
| 发送后无法确认远端结果 | ❌ | — | — | 记为 `ambiguous`，不盲目重发 |
| 异步任务 pending | — | 最多 6 次轮询 | 10s | 仍 pending 记 `async_timeout` |
| 异步任务 failed | ❌ | — | — | 记录供应商失败原因 |

**全局停止条件**：任一 401/403；连续 3 个逻辑用例失败；累计调用达到 40 次。

## 三、失败分类

每次调用落一个分类：

`success` / `auth_error` / `input_error` / `not_found` / `rate_limited` / `provider_error` / `transport_error` / `schema_error` / `ambiguous` / `async_timeout`

## 四、每次调用记录什么

- 用例号、平台、动作、模式、attempt 序号；
- 请求 body 原文；
- 响应 body 原文（完整字节）与 SHA-256；
- HTTP 状态、响应中声明的 action、供应商错误码；
- 开始/结束时间、耗时、字节数；
- 解析摘要：条目数、游标类型与值、内容 ID、任务 ID；
- 重试决定与原因。

## 五、产物

```
aimaster接口文档/测试结果/raw4-2026-10-28/
├── PLAN.md          本文件
├── C01-douyin-profile-sync.json
├── ...
└── REPORT.md        结果对照表 + 与 raw3 的差异 + capability 结论
```

## 六、与 raw3 的对照维度

| 维度 | 对照什么 |
|---|---|
| 认证 | `X-Api-Key` 是否被接受；Bearer 是否需要 |
| 响应 action | 请求动作与实际返回动作是否一致 |
| 游标 | 抖音数字、小红书字符串是否保持 |
| 条目数 | 是否仍为 20 / 21 |
| 视频详情 | `media_stats_number` 的字段与互动数是否变化 |
| 评论 | 一级评论数、游标、`reply_count` 语义 |
| 异步 | 提交结构、任务状态序列、终态耗时 |

## 七、批准

运行前需要：

- [ ] 人工批准：预计 15–22 次调用，上限 40 次
- [ ] 确认 `.env` 中的 `AIMASTER_API_KEY` 仍有效
- [ ] 确认使用历史 4 条链接，或提供新的一批