# C 识别能力（c-signals）· 验收

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **所属域**：C 识别能力 · **目录命名**：`c-signals`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-c-signals.md`](../../../HBECHO设计方案/prd-domain-c-signals.md) v1.2（定稿候选）§十二
>
> **最近核对**：2026-11-11
>
> **更新日期**：2026-11-11（初建；尚未实施，所有条目未执行）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出或样本图上看，写明谁看、看什么、检查什么。
- `[环境]`：依赖测试机、真实桶或后续 spec，不能在本机离线判定；标明当前状态。
- 每条对应 requirements 的 `SG-n`；没有「看一眼就行」的条目。
- 需要 MySQL 的自动项写成 `*.db.test.ts`（`pnpm test:db`），其余是 `unit` project（`pnpm test`）；Python 侧是 `services/capability` 的 pytest；入口是 `./scripts/verify.sh`。
- 本 spec **没有页面**（design §15），不出现页面条目。
- 真实模型调用与真实付费 smoke **不是**本 spec 的验收，属于 `h-ai-min`；见「环境项」。
- 合成图测试断言**排序与大致区间**，不断言具体分值（标定参数变化不应使测试失效）。

## 逐条结果

（任务 13 回填：每组通过 / 未通过、对应测试文件、本机 `verify.sh` 的测试数、测试 ECS 的通过数与耗时。）

## 自动项

### A. 信号目录（SG-1）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| A1 | SG-1 | 目录键集合对照独立转写的 12 项清单 | 逐项相等，无多无少 |
| A2 | SG-1 | 读取、请求补算、保存监控段时引用目录外键（如 `content.cover_ocr_text`、`content.engagement_ratio`、`text.mentions`） | 全部 `signal_unregistered` |
| A3 | SG-1 | 目录中查找 OCR、`vision_*`、`ai_judgement`、六个聚合比率、@ / POI / 外链 / 昵称 / 签名 | 一个都没有 |
| A4 | SG-1 | `platformSignals('kuaishou')` | 不含任何 `account.*`、`comment.*`；含文本三项、封面两项、ASR 两项 |
| A5 | SG-1 | `platformSignals('xiaohongshu')` | 不含任何 `account.*`；含 `comment.text_normalized` |
| A6 | SG-1 | `platformSignals('douyin')` | 12 项全部可得 |

### B. 五态（SG-2）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| B1 | SG-2 | 同一内容的封面信号，依次在「无封面引用 / 引用 `pending` / 引用 `failed` / 引用 `carried_forward` / 已归档但字节读不到 / 已计算」下读取 | `not_applicable` / `missing` / `missing` / `missing` / `failed` / `valid`；原因码各不相同（`no_reference`、`media_pending`、`media_failed`、`media_carried_forward`、`image_unreadable`、无） |
| B2 | SG-2 | 提升目录中某信号版本号后读取旧结果 | `stale`，带旧值与旧版本；不是 `missing`；任务表无新行 |
| B3 | SG-2 | 数据库插入 `state='missing'`、`'stale'`、`'not_applicable'` 的结果行 | CHECK 拒绝 |
| B4 | SG-2 | `failed` 结果行带 `score` 或 `value` | CHECK 拒绝 |
| B5 | SG-2 | 读取一条 `failed` 结果 | 返回 `failed` 与失败码，`score` / `value` 不存在，**不是 0** |
| B6 | SG-2 | 最高版本的行是旧版本的 `failed` | 读作 `missing`，原因 `failed_under_old_version` |
| B7 | SG-2 | 有一条排队中的任务 / 一条 `dead` 的任务 | `missing` + `pending: queued` / `missing` + `pending: dead` + `compute_dead` |
| B8 | SG-2 | 能力被关闭后读取已存储的有效值 | 仍返回 `valid`；关闭只阻止新计算 |
| B9 | SG-2 | 能力被关闭且无已存储值 | `missing`，`capability_disabled` |

### C. 文本信号（SG-3）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| C1 | SG-3 | 一个抖音内容 current 推进、跑一轮扫描 | 特征行存在；`signals show --content` 单独给出话题与归一化标题 / 正文，无需解析原始 JSON |
| C2 | SG-3 | `#618`、`＃６１８`、`#618 `、`#618[话题]#` | 同一话题值 `618` |
| C3 | SG-3 | `#日立中央空调品牌月#日立中央空调`、`#a #b`、`#来拍照了[话题]#` | 分别得到 2 个、2 个、1 个话题 |
| C4 | SG-3 | 标题 `ＨＩＴＡＣＨＩ　空调` | `title_normalized` 为 `hitachi 空调`；`content_snapshots.title` 原文不变 |
| C5 | SG-3 | 正文为空、平台有该字段 | `body_normalized` 为 `valid` 的空字符串；`hashtags` 为空数组；不是 `failed` |
| C6 | SG-3 | 平台没有标题字段（按 `PLATFORM_TEXT_FIELDS`） | `text.title_normalized` 读作 `not_applicable` |
| C7 | SG-3 | 注入一个抛错的话题解析器 | `hashtags` 为 `failed`（含片段哈希前缀与长度，不含原文）；标题与正文 `valid`；特征行已写入；内容仍在库 |
| C8 | SG-3 | 同一快照重复处理；新批次快照文本未变 | 值与信封不变（仅所持快照前移）；历史表无新行 |
| C9 | SG-3 | 抖音与小红书内容的话题能力标识 | 不同（`text.hashtags.douyin` / `text.hashtags.xiaohongshu`），目录导出里可区分 |
| C10 | SG-3 | `normalizeText(normalizeText(x)) === normalizeText(x)`，固定种子的随机串集合 | 恒成立 |
| C11 | SG-3 | `normalizeKeyword` 与库内归一化使用同一函数 | 同一函数引用（静态断言导出相同） |
| C12 | SG-3 | `building` 状态的快照、非 current 的 finalized 快照 | 不产生特征行 |
| C13 | SG-3 | 快手内容 | 文本三信号为 `valid`（或按平台字段表 `not_applicable`）；`account.*` 为 `not_applicable` |

### D. 评论文本信号（SG-4）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| D1 | SG-4 | 评论入库后跑一轮评论扫描 | `comment_features` 有一行，`comment.text_normalized` 为 `valid` |
| D2 | SG-4 | 同一评论正文再次出现（`last_seen_at` 前移） | 不写入 |
| D3 | SG-4 | 评论正文被平台修改 | 特征行更新；历史表新增一行（`material_changed`） |
| D4 | SG-4 | `suspected_deleted` / `deleted` 的评论 | 不被新抽取；已有特征行保留 |
| D5 | SG-4 | 检查 C 的全部表的列 | 无评论作者 ID、昵称、点赞数 |
| D6 | SG-4 | 快手内容的评论信号 | `not_applicable`（`platform_unsupported`） |

### E. 特征存储与版本（SG-5）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| E1 | SG-5 | 一个内容反复推进 current | `content_features` 中仍只有一行（主键 `content_id`）；信封每个信号都有 `state` / `cap` / `ver` / `at` |
| E2 | SG-5 | 先写批次 5 的快照特征，再迟到处理批次 3 | 特征行不变，仍指向批次 5（`skipped_older`） |
| E3 | SG-5 | 标题改了 | 特征行为新值；历史表新增一行，内容为旧标题的归一化值，原因 `material_changed` |
| E4 | SG-5 | 只把 `text.hashtags` 版本 1 → 2 | 标题、正文读作 `valid`；话题读作 `stale`；`content.cover_template_score` 不受影响 |
| E5 | SG-5 | 删除 ODS 相关对象与表数据后读取特征 | 读取不受影响（读取路径不引用 ODS） |
| E6 | SG-5 | 检查 `content_features` / `comment_features` / `signal_results` 的列 | 不含 `published_at`、互动数、作者 ID 等 A 的事实字段 |
| E7 | SG-5 | 值与信封不一致（`title_normalized` 非空而信封 `failed`） | CHECK 拒绝 |
| E8 | SG-5 | 复合外键：特征行指向别的内容的快照 | 数据库拒绝 |
| E9 | SG-5 | 扫描中途杀进程后重做同一批 | 特征行恰好一行，历史无重复 |
| E10 | SG-5 | 游标已越过、但提交更晚的内容（回看窗口内 / 窗口外） | 窗口内由「迟到」查询补上；窗口外由对账补上 |

### F. 复用键与结果行（SG-6）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| F1 | SG-6 | 同一（信号、素材、参数、版本）顺序写入两次 | 数据库只有一行；第二次为命中，不是错误 |
| F2 | SG-6 | 换一张标准图（字节不同）后对同一封面补算 | 新增一行结果，旧行保留 |
| F3 | SG-6 | 两个监控段引用同一张标准图（字节相同），对同一封面各请求补算 | 只有一个任务、一行结果 |
| F4 | SG-6 | 结果行 `lineage` 与复用键 | `lineage` 含计划 ID 与版本；唯一键列不含它们 |
| F5 | SG-6 | 匹配分 `10.00`、`0.00`；`10.01`、`-0.01` | 前两者合法；后两者 CHECK 拒绝 |
| F6 | SG-6 | 判定结果行缺结论 / 理由 / 模型版本 / 提示词版本任一项 | 写入前 zod 拒绝，库中无行 |
| F7 | SG-6 | 升级能力版本后再次计算同一（素材、参数） | 新增一行（版本更高）；旧行未被修改 |
| F8 | SG-6 | 素材指纹稳定性：同样的标题 / 正文 / `tag_text` 字符串，`NULL` 与空串 | 同值得到同指纹；`NULL` 与空串指纹不同 |

### G. 监控段与标准图（SG-7）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| G1 | SG-7 | 同一草稿同一对象上传第二张模板图 | 替换前一张；数据库仍只有一张；旧 OSS 对象被删 |
| G2 | SG-7 | 封面、背景、头像各一张模板图；封面再加三张不同 `element_key` 的元素图 | 全部成功；同一对象再加第二张模板图是替换，不是并存 |
| G3 | SG-7 | OSS 对象键 | 含计划 ID、版本、图像对象、图片 SHA-256 |
| G4 | SG-7 | 对 `published` 版本调用 `putImage` / `setItems` / `removeImage` | `segment_immutable` |
| G5 | SG-7 | 保存含两个 `content.asr_judgement` 的信号集合 | 拒绝 |
| G6 | SG-7 | 快手计划保存 `account.bg_template_score`；小红书计划保存 `account.avatar_element_score` | 均拒绝 |
| G7 | SG-7 | 上传 > 10 MiB；上传无法解码的字节 | 均拒绝；数据库与 OSS 都无残留 |
| G8 | SG-7 | 关闭目录中某能力的启用开关 | 已发布计划的 `executability` 为不可执行并列出该信号；监控段数据未变；保存与发布新版本被拒绝 |
| G9 | SG-7 | `newDraft` | 新版本 `items` 与图片字节与原版本一致，对象键不同；旧版本的图仍可读取 |
| G10 | SG-7 | `purge`（含 OSS `delete` 故障注入一次） | 第一次失败后数据库行仍在；重试后监控段、图片行、对象均不存在；已不存在的对象视为成功；孤儿对象一并清掉 |
| G11 | SG-7 | `purge` 之后查询结果行 | 结果行仍在（由保留期清理，不级联） |
| G12 | SG-7 | D 建计划 → `create`；D 改信号集合 → `setItems`；D 改图 → `putImage`（同版本草稿） | 同一 `(plan_id, version)` 行被更新，不产生新版本；`version` 只在 `newDraft` 时增加 |
| G13 | SG-7 | 上传前 `putImage` 的 OSS `put` 失败 | 数据库无行，旧图保持 |
| G14 | SG-7 | `putImage` 事务失败（注入） | 刚上传的对象被尽力删除；旧图保持 |

### H. 素材比对（SG-8）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| H1 | SG-8 | 100 个内容主体请求补算：10 个无封面引用、5 个 `pending`、5 个 `carried_forward`、80 个已归档 | 80 个建任务；其余 20 个按映射返回；`carried_forward` 主体无任务且在 `needMedia` 中 |
| H2 | SG-8 | 同一批主体第二次请求；任务完成后再请求 | 均不新增任务 |
| H3 | SG-8 | 换标准图后再请求 | 对同一批主体新建任务 |
| H4 | SG-8 | 能力服务回报的版本与目录不一致 | 任务按瞬时失败重试；不写结果行 |
| H5 | SG-8 | Python：同一张图自比 | ≥ 9.5 |
| H6 | SG-8 | Python：同图缩放 + 轻度旋转 + 轻度亮度变化 | ≥ 7 |
| H7 | SG-8 | Python：无关图 | < 2 |
| H8 | SG-8 | Python 元素模式：嵌入场景图的元素裁剪块；不含该元素的场景图 | ≥ 6；< 2 |
| H9 | SG-8 | Python：特征点极少的纯色图 | 0 分，`low_features: true`，不是错误 |
| H10 | SG-8 | Python：候选图无法解码 / 参考图无法解码 | 422 `convert_failed`，`side` 分别为 `candidate` / `reference` |
| H11 | SG-8 | 候选图解码失败 | 写 `failed(image_unreadable)`；读作 `failed`；不重试 |
| H12 | SG-8 | 标准图（reference 侧）读取失败 | 任务 `dead(reference_unreadable)`；候选对象无 `failed` 结果行 |
| H13 | SG-8 | 结果行与返回值 | 有得分与能力版本、证据；没有「匹配 / 不匹配」字段 |
| H14 | SG-8 | runner 调用能力服务期间 | 连接池内无未提交事务（测试钩子在调用点检查） |
| H15 | SG-8 | 账号主体（抖音）背景 / 头像 | 经 `current_profile_snapshot_id` 找引用；无引用 → `not_applicable` |
| H16 | SG-8 | 超过 5,000 主体 | 拒绝 |

### I. 音频理解（SG-9）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| I1 | SG-9 | 默认装配（`DisabledAiGateway`）下请求 ASR 与判定 | 任务数 0；网关调用数 0；读作 `missing` / `capability_disabled` |
| I2 | SG-9 | fake 网关：同一音频两次请求 | ASR 只调用一次；`content.asr_text` 全局共享（不同监控段共用一行） |
| I3 | SG-9 | fake 网关：两个不同标准文本 | 各自一行判定，互不复用；相同标准文本 + 提示词版本 + 模型版本复用 |
| I4 | SG-9 | fake 网关把 `activeModel` 从 `m1` 换成 `m2` | 新请求产生新判定行；`m1` 的行保留 |
| I5 | SG-9 | 同一 `callKey` 两次调用 | 网关只计费一次；任务在调用成功后、写结果前崩溃，重启重试用同一 `callKey`，结果行恰好一行 |
| I6 | SG-9 | 模型输出缺 `reason` / `verdict` 非法 / 模型拒绝 | 结果为 `failed(invalid_output)` / `failed(model_refused)`；**不是 `not_meets`** |
| I7 | SG-9 | 网关抛瞬时错误 | 任务重试；用尽 `dead`；无结果行 |
| I8 | SG-9 | ASR 结果缺失时运行判定任务 | `deferred`，不计重试；确保 ASR 任务存在；累计 20 次仍无结果 → `dead(dependency_timeout)` |
| I9 | SG-9 | 音频未归档 | `missing(audio_not_archived)`；无任务；C 不调用 `demand` |
| I10 | SG-9 | 判定结果行内容 | 含结论、理由、模型版本、提示词版本 |
| I11 | SG-9 | 判定的参数指纹 | 先取 `activeModel()` 再计算；`activeModel()` 为 `null` 时不计算、不建任务 |
| I12 | SG-9 | 每监控段至多一个判定项 | 第二个被拒绝（执行路径与保存路径各断言一次） |
| I13 | SG-9 | 静态检查 | `signals` 模块不 import 任何模型 SDK / `fetch` 到模型域名；AI 调用只出现在 `AiGatewayPort` 的实现处 |

### J. 能力版本、`stale` 与保留期（SG-10）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| J1 | SG-10 | 升级某信号版本 | 历史结果读 `stale`；无新任务；监控段版本不变 |
| J2 | SG-10 | `stalePolicy: 'use_stale'` / `'as_unknown'` | 前者返回旧值与 `stale` 标记且 `usable: true`；后者 `usable: false` 且不带值 |
| J3 | SG-10 | `FakeClock` 推进 13 个月 | 未引用的成功结果行被清理 |
| J4 | SG-10 | `FakeClock` 推进 4 个月 | 失败结果行被清理；成功行仍在 |
| J5 | SG-10 | `retainUntil` 延后一行的 `expires_at` | 到原时间点仍保留；传入较早时间不会缩短 |
| J6 | SG-10 | 清理后读取该信号 | `missing`；`signal_tasks` 无新行 |
| J7 | SG-10 | 清理器 | 不删除特征行；分块删除中途退出后可重跑 |
| J8 | SG-10 | 写入时 `expires_at` | 成功 = 产出 + 1 年；失败 = 产出 + 3 个月；历史行 = 取代 + 1 年 |
| J9 | SG-10 | 升级后补算（`requestScores`） | 不对 `stale` 的（素材、参数）建任务 |

### K. 显式重算（SG-11）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| K1 | SG-11 | `apply` 不带范围 | `scope_required` |
| K2 | SG-11 | `preview` 与随后 `apply` | 条数一致；`preview` 不写任何表 |
| K3 | SG-11 | 无 `rule.definition.manage` 的操作者 | 拒绝（读库之前） |
| K4 | SG-11 | 品牌范围受限的操作者，范围含范围外对象 | 范围外对象不在展开结果里 |
| K5 | SG-11 | 重算后 | 范围内读作 `valid`，范围外同信号仍 `stale` |
| K6 | SG-11 | 重算记录与审计事件 | 各一条，含操作者、信号、范围、预览条数、起止版本 |
| K7 | SG-11 | 中途杀进程后重启 | 续跑完成；每个对象只被处理一次（历史表无重复） |
| K8 | SG-11 | 重算前后监控段的版本 | 不变 |
| K9 | SG-11 | `brandId` 范围，账号在重算前换过店 | 用**当前**归属展开 |
| K10 | SG-11 | 同一 `(信号, 目标版本, 范围)` 再次 `apply` | 返回既有 run（幂等），不重复处理 |
| K11 | SG-11 | CLI 不提供 `--all` / 全量重算入口 | `parseArgs` strict 拒绝 |
| K12 | SG-11 | 重算期间读取 | 仍读到旧值并标 `stale`，不阻塞 |

### L. 读取口与补算请求（SG-12）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| L1 | SG-12 | `read` / `readMany` 在任意状态下 | `signal_tasks` 行数不变；能力服务与网关调用数不变 |
| L2 | SG-12 | `readMany` 5,000 个主体 | 数据库查询次数为常数（计数器） |
| L3 | SG-12 | 参数化信号缺 `param` | `param_required` |
| L4 | SG-12 | 排队中 / `dead` 的任务 | `pending: queued` / `pending: dead` |
| L5 | SG-12 | `requestScores` 对草稿与已发布监控段 | 均可用 |
| L6 | SG-12 | `requestScores` 对不存在的监控段、不可执行的监控段、超 5,000 主体 | 拒绝 |
| L7 | SG-12 | 返回值 | 不含内容原文 |
| L8 | SG-12 | fake D 契约：`create → putImage → setItems → requestScores → readMany 轮询 → publish → newDraft → purge` | 序列通过，轮询最终无 `pending` |

### M. 任务执行（SG-13）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| M1 | SG-13 | 两个 worker 抢同一任务（显式闸门，不用 `Promise.all`） | 只有一个拿到 |
| M2 | SG-13 | 租约过期后另一个 worker 接手 | 接手成功；旧 worker 的写入被拒绝且零写入 |
| M3 | SG-13 | 任务在调用返回之后、事务提交之前崩溃 | 重启后结果行恰好一行 |
| M4 | SG-13 | 重试用尽 | `dead`，无结果行；`requestScores` 再次请求把它置回 `pending` 且 `attempt_count` 清零 |
| M5 | SG-13 | 静态检查 | `signals` 模块不 import `orchestrator/claim`，不写 `sync_tasks` |
| M6 | SG-13 | 重复入队同一复用键 | 返回既有任务 |
| M7 | SG-13 | 任务保留期 | `expires_at` = 创建 + 1 年；过期任务被清理器删除 |

### N. 授权与审计（SG-14）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| N1 | SG-14 | 缺 Capability 的调用 | 读库之前被拒绝（查询计数器为 0） |
| N2 | SG-14 | 越品牌范围的重算对象 | 表现为「未找到」 |
| N3 | SG-14 | 审计事件字段 | 无签名 URL、无文本原文、无图片字节、无模型 Key |
| N4 | SG-14 | 缺 `HBECHO_SIG_ACTOR` / `_CAPABILITIES` / `_BRAND_SCOPE` 任一项 | CLI 启动失败，退出码非零；`_BRAND_SCOPE` 缺省不退化为全部 |
| N5 | SG-14 | 审计事件覆盖 | 监控段创建 / 发布 / 清除、标准图上传 / 删除、重算预览 / 执行、任务 `dead` 各有事件 |

### O. 配置、门控与离线（SG-15）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| O1 | SG-15 | 默认配置下目录的启用状态 | 仅文本类已启用；图像与语音类读作 `missing` / `capability_disabled` |
| O2 | SG-15 | `HBECHO_SIGNALS_ENABLED` 含目录外能力标识 | 启动失败 |
| O3 | SG-15 | 缺必填数值配置 | 启动失败并指出缺哪一项 |
| O4 | SG-15 | 测试进程 | 网络 socket 被禁止；任何外联使测试失败 |
| O5 | SG-15 | 同一 fixture 连续运行 3 次 | 结果一致 |
| O6 | SG-15 | `./scripts/verify.sh` | 通过；Python 侧未验证时明确写出，不声称通过 |
| O7 | SG-15 | `.env.example` 与测试夹具 | 不含任何真实 Key、Secret、签名 URL |

### P. 一致性与护栏（SG-16）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| P1 | SG-16 | `drizzle-kit generate` | 不产生新迁移 |
| P2 | SG-16 | 迁移在空库上 `migrate` 两次 | 成功并幂等 |
| P3 | SG-16 | 护栏 1：`signals` 非测试文件对 A 域表 `insert` / `update` / `delete` | 违规时报错；反向用例通过 |
| P4 | SG-16 | 护栏 2：import `provider-adapter` 供应商调用或 `raw-capture` 网关 | 违规时报错；反向用例通过 |
| P5 | SG-16 | 护栏 3：`signals` 下 `*.db.test.ts` 含 `Promise.all` | 违规时报错；反向用例通过 |
| P6 | SG-16 | 护栏 4：`fetch(` 只出现在 `matcher-client`；AI 调用只经 `AiGatewayPort` | 违规时报错；反向用例通过 |
| P7 | SG-16 | 既有测试 | `pnpm test`、`pnpm test:db` 保持通过 |
| P8 | SG-16 | 对 A 域的改动范围 | `git diff` 中 A 域 schema 只多一行索引 |

## PRD 验收清单对照

C PRD §十二的每一条都有对应：

| PRD 条目 | 对应验收 |
|---|---|
| C1：话题与归一化标题 / 正文可单独查出 | C1 |
| C1：1.0 不产出 @ / POI / 外链 / 昵称 / 签名 | A3 |
| C1：`#618` 与 `＃６１８` 同值 | C2 |
| C1：原文与归一化分别可查 | C4 |
| C1：正文为空 → `valid` 空值 | C5 |
| C1：解析器报错 → 该信号 `failed`，其余不受影响 | C7 |
| C1：重复入库不重复抽取 | C8、E9 |
| C1：快手文本 `valid`，账号图片信号 `not_applicable` | C13、A4 |
| C1：六个聚合信号不产出 | A3 |
| C2：同标准图同背景图只算一次 | F1、H2 |
| C2：换标准图重算 | F2、H3 |
| C2：`carried_forward` 不参与 | H1 |
| C2：返回得分与版本，不返回匹配 / 不匹配 | H13 |
| C2：图片不可读 → `failed`，不是 0 | B5、H11 |
| C2：`[手工]` 运营看到版本、时间、匹配点数 | 手工 M1 |
| C3：ASR 转写，`asr_text` 全局共享 | I2 |
| C3：结构化判定含结论 / 理由 / 模型版本 / 提示词版本 | I10 |
| C3：不同标准 / 提示词 / 模型不复用 | I3、I4 |
| C3：每计划至多一个 ASR 考核项 | G5、I12 |
| C3：未验证时第 3 层 disabled，不发起付费调用 | I1 |
| C4：一对象一行当前值，旧版本进历史表 | E1、E3 |
| C4：升级文本能力不使模板匹配 `stale` | E4 |
| C4：特征查询不依赖 ODS | E5 |
| C4：A 的事实字段不出现在 C 的特征表 | E6 |
| 版本：升级后历史变 `stale`，不自动重算 | B2、J1 |
| 版本：升级不产生新计划版本 | J1、K8 |
| 版本：重算不升计划版本，旧值进历史表 | K8、E3 |
| 版本：默认使用 `stale`，配置为 unknown 时不使用 | J2 |
| 版本：旧值过保留期清理后 `missing`，不触发识别 | J6 |
| 版本：重算必须带范围，没有全量入口 | K1、K11 |
| 版本：重算记录含操作者、范围、时间、能力版本 | K6 |
| 监控段：封面 / 背景 / 头像各至多一张，元素图多张 | G1、G2 |
| 监控段：OSS 定位键含计划 ID、版本、图像对象、SHA-256 | G3 |
| 监控段：匹配分连续 0.0–10.0 | F5 |
| 监控段：D 建计划同步建 C 段；D 改信号集合 / 图时 C 段同版本更新 | G12 |
| 监控段：C 删除信号后已发布计划不可执行，保存与发布被拒 | G8 |
| 监控段：同素材、同能力版本、同参数只算一次，换图或升版本会重算 | F1、F2、F7 |

## 手工项

| # | 需求 | 谁看 | 在哪看 | 检查什么 |
|---|---|---|---|---|
| M1 | SG-8 | 评审人 | 测试 ECS，CLI `signals show --content <id>` | 一个已计算的内容下能看到：用了哪版能力、什么时候算的、匹配点数量与内点率；输出里没有内容原文 |
| M2 | SG-8 | 业务 + 刘学奎 | 标定报告 | 约 20 对脱敏样本的分数分布合理（同图高、轻度改动居中、无关图低）；每个整数档配有一张样例图；`R_FULL` / `I_FULL` 的取值有依据；刘学奎签字后才可把 `image.*` 加入生产启用集 |
| M3 | SG-8 | 业务 | 样本图 | 纯色 logo、文字类元素在元素模式下得分很低且 `low_features` 为真——确认这符合 PRD C §5.1 对元素图适用边界的描述 |
| M4 | SG-3 | 评审人 | 测试 ECS，用 `a-full-sync` 已有的真实同步数据 | 抽查 10 个内容：话题与原文标题 / 正文 / `tag_text` 对得上，无漏抽 / 错抽；抖音、小红书、快手各至少 3 个 |
| M5 | SG-7 | 评审人 | 测试 ECS | 标准图上传后，CLI `segment show` 列出的对象键含计划 ID、版本、图像对象与 SHA-256；`segment purge` 后桶内无残留（需先有真实桶，见 E1） |

## 环境依赖项（不能离线验证）

| # | 依赖 | 当前状态 | 何时可验 |
|---|---|---|---|
| E1 | 真实 `hbecho-signals` 桶与 RAM（读写删） | **未创建**；需刘学奎同意并走 `server-access.md` 的逐步确认 | 桶创建后，任务 13 在测试 ECS 上验 M5 |
| E2 | Python 服务上的 OpenCV 匹配（真实 ffmpeg ≥ 7.1 + HEIC 封面） | 能力服务已存在，无匹配端点 | 任务 7 之后；测试 ECS 上用合成图 + 一张 HEIC 样例跑一次 |
| E3 | 匹配分标定 | 未开始，等业务提供样本 | 任务 7；M2 通过前 `image.*` 不进生产启用集 |
| E4 | 真实 ASR / 大模型 | **`h-ai-min` 未开始**；本 spec 的网关默认 disabled | `h-ai-min` 落地并通过其 smoke 后，另行验证 C 的第 3 层端到端 |
| E5 | D 的消费 | **`d-rule-engine` 未开始** | D 的 spec 对齐端口形状后（design §14 第 11 项） |
| E6 | 扫描回看窗口在真实同步写入并发下是否足够 | 未验证 | 任务 13：测试 ECS 上跑一轮 `a-full-sync` 的 smoke 数据并观察「迟到」查询的补回数量 |
| E7 | 规模与吞吐 | 未实测 | 任务 13 回填 design §12.1 |

## 覆盖不了的

- 真实模型的转写与判定质量、成本与延迟：属于 `h-ai-min`，本 spec 只证明编排、参数化、缓存、失败语义；
- 匹配分对真实业务图的区分度：只由人工标定（M2）证明，合成图只证明排序；
- 页面上的信号展示：本 spec 无页面，D 的页面验收另立；
- 多进程并行扫描的性能：游标只有一份，并行不提速；正确性靠租约与幂等，性能不声称；
- 生产部署形态与资源上限：不在本 spec。
