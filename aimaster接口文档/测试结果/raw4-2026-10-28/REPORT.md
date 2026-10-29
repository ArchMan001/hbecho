# AI Master 实测报告 · raw4

> **日期**：2026-10-28
> **执行**：11 个用例，实际调用 14 次（含 1 次重试、2 次异步轮询）
> **预算**：上限 40 次，未触及
> **证据**：本目录下 `C01`–`C11` 的逐次请求与响应原文；`SUMMARY.json` 为汇总

## 一、结果总表

| # | 平台 | 动作 | 模式 | 结果 | 关键数据 |
|---|---|---|---|---|---|
| C01 | 抖音 | 主页信息 | 同步 | ✅ | 15 个字段 |
| C02 | 小红书 | 主页信息 | 同步 | ✅ | 12 个字段 |
| C03 | 抖音 | 内容列表 | 同步 | ✅ | 20 条，`has_more=true`，游标 **int** |
| C04 | 小红书 | 内容列表 | 同步 | ✅ | 21 条，`has_more=true`，游标 **str** |
| C05 | 抖音 | 视频详情 | 同步 | ✅ | 25 个字段；返回 action 为 `media_stats` |
| C06 | 小红书 | 笔记详情 | 同步 | ✅ | 23 个字段；返回 action 为 `media_stats` |
| C07 | 抖音 | 视频评论 | 同步 | ✅ | 20 条 / 共 125 条，`has_more=1`，游标 `"20"` |
| C08 | 小红书 | 笔记评论 | 同步 | ✅（第 2 次） | 1 条 / 共 2 条；**第 1 次失败** |
| C09 | 抖音 | 主页信息 | 异步 | ✅ | 提交 `running` → 10 秒后 `succeeded` |
| C10 | 小红书 | 内容列表 | 异步 | ❌ | 提交 `running` → 轮询得 `failed` |
| C11 | 抖音 | 主页信息 | 同步 | ✅ | 与 C01 一致，15 个字段 |

## 二、六个结论

### 1. 认证方式：`X-Api-Key` 可用

所有成功调用都只带 `X-Api-Key`，没有使用 Bearer。**文档写的 Bearer 与实测不一致，以实测为准。**

### 2. 请求动作与返回动作仍不一致

`media_stats_number` 请求，返回的 `action` 是 **`media_stats`**。这不是新问题，raw3 已记录；本次确认仍然存在。

**影响**：Adapter 必须把"请求动作"与"实际响应动作"分列，不能要求相等。

### 3. 视频详情新增了一个字段

`media_stats` 的结果里出现 **`author_homepage`**，raw3 的 25 个样本里没有。

**影响**：Adapter 不能假设字段集合固定；未知字段应保留在 ODS，解析层忽略或按版本映射。

### 4. 评论结果少了一个字段

raw3 的评论结果有 `cursor`，raw4 只有 `max_cursor`。**`cursor` 已被移除。**

**影响**：Adapter 只依赖 `max_cursor` 与 `has_more`，不要依赖 `cursor`。

### 5. 评论数据形态

| 平台 | 返回条数 | 总数 | `has_more` | 游标 |
|---|---|---|---|---|
| 抖音 | 20 | 125 | 1 | `"20"`（字符串） |
| 小红书 | 1 | 2 | 0 | `""`（空字符串） |

- 抖音的评论游标是**字符串**，不是数字；
- 小红书的 `total=2` 但只返回 1 条，需要后续确认是过滤（如作者本人）还是分页行为；
- `reply_page_count=0`：传 `reply_pages=-1` 时不取回复。

### 6. 异步模式：一个可用，一个失败

| 用例 | 提交 | 轮询 | 结论 |
|---|---|---|---|
| C09 抖音主页 | `running` | `succeeded` | ✅ 可用 |
| C10 小红书内容列表 | `running` | `failed` | ❌ 供应商 bug |

C10 的错误：

```
RESULT_VALIDATION_FAILED
Input should be a valid dictionary or instance of UserVideoListOpenAPIResult
input_value='{"result":[{"post_id":"6...'  input_type=str
```

**供应商把结果序列化成了字符串，而不是对象。** 同步模式同一接口正常，说明是异步路径的缺陷。

## 三、一次间歇性失败

C08 小红书评论第一次返回：

```
code: RESULT_VALIDATION_FAILED
message: Input should be a valid dictionary ... input_value=None
```

即供应商返回了 `result: null`。**重试后成功**。

**影响**：`RESULT_VALIDATION_FAILED` 应视为**可重试**（有界），而不是终态失败。

## 四、与 raw3 的字段差异

| 用例 | raw4 新增 | raw3 有、raw4 没有 |
|---|---|---|
| C05 抖音视频详情 | `author_homepage` | — |
| C06 小红书笔记详情 | `author_homepage` | — |
| C07 / C08 评论 | — | `cursor` |

其余用例字段集合与 raw3 完全一致（主页 15/12、列表 4）。

## 五、capability 结论

| 平台 × 动作 × 模式 | 证据等级 | 能否用于 1.0 |
|---|---|---|
| 抖音 × 主页信息 × 同步 | `smoke_verified` | ✅ |
| 抖音 × 内容列表 × 同步 | `smoke_verified` | ✅ |
| 抖音 × 视频详情 × 同步 | `smoke_verified` | ✅（注意 action 不一致） |
| 抖音 × 视频评论 × 同步 | `smoke_verified` | ✅ |
| 小红书 × 主页信息 × 同步 | `smoke_verified` | ✅ |
| 小红书 × 内容列表 × 同步 | `smoke_verified` | ✅ |
| 小红书 × 笔记详情 × 同步 | `smoke_verified` | ✅ |
| 小红书 × 笔记评论 × 同步 | `smoke_verified`（间歇） | ✅ 必须带重试 |
| 抖音 × 主页信息 × 异步 | `smoke_verified` | ✅ |
| 小红书 × 内容列表 × 异步 | `provider_failed` | ❌ 保持 disabled |
| 其余异步组合 | `unknown` | ❌ |

## 六、对实现的要求

1. **重试策略**必须把 `RESULT_VALIDATION_FAILED` 纳入可重试（建议最多 2 次）；
2. **请求动作与响应动作分列**，不一致时保留两值；
3. **评论只依赖 `max_cursor` 与 `has_more`**，不依赖已移除的 `cursor`；
4. **未知字段不报错**：保留在 ODS，解析层按版本映射；
5. **异步按 tuple 启用**：小红书列表异步保持 disabled，直到供应商修复。

## 七、未覆盖

- 评论回复（`reply_pages=-2`）；
- 列表第二页；
- 视频号、快手；
- 失败响应（4xx/5xx）的真实形态；
- 异步其他 tuple。

这些不阻塞 1.0，但应作为 capability registry 中的 `unknown` 保留。