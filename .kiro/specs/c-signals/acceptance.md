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
> **更新日期**：2026-11-12（初建于 11-11，经三轮审查修订；任务 13 回填了逐条结果、手工项与环境项的状态）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出或样本图上看，写明谁看、看什么、检查什么；编号 `MAN-n`。
- `[环境]`：依赖测试机、真实桶或后续 spec，不能在本机离线判定；标明当前状态；编号 `ENV-n`。
- 自动项按字母分组编号（A–P），与 `MAN-n`、`ENV-n` 不会重号。
- 每条对应 requirements 的 `SG-n`；没有「看一眼就行」的条目。
- 需要 MySQL 的自动项写成 `*.db.test.ts`（`pnpm test:db`），其余是 `unit` project（`pnpm test`）；Python 侧是 `services/capability` 的 pytest；入口是 `./scripts/verify.sh`。
- 本 spec **没有页面**（design §15），不出现页面条目。
- 真实模型调用与真实付费 smoke **不是**本 spec 的验收，属于 `h-ai-min`；见「环境项」。
- 合成图测试断言**排序与大致区间**，不断言具体分值（标定参数变化不应使测试失效）。

## 逐条结果

> 回填于 2026-11-12（任务 13）。图例：✅ 已被离线测试证明（写明测试）；◐ 部分证明（写明缺什么）；⏳ 依赖环境或他人，未证明。测试文件名省略目录：`src/modules/signals/` 下的 `catalog.test.ts`、`compose.test.ts`、`reader.db.test.ts`、`facts.db.test.ts`、`features/features.db.test.ts`、`scoring/scoring.db.test.ts`、`speech/speech.db.test.ts`、`segments/segments.db.test.ts`、`recompute/recompute.db.test.ts`、`retention.db.test.ts`、`acceptance.db.test.ts`、`text/*.test.ts`；`src/db/signals-schema.db.test.ts`（简称 schema）；`src/worker/signals-*.test.ts`（简称 cli / cli.commands / loop / main）；`src/acceptance-boundaries.test.ts`（简称 boundaries）；Python 是 `services/capability/tests/test_match.py`（简称 pytest）。引号里是用例名片段。
>
> **验证数字**见本节末尾；任务 13 不靠印象打勾，原先没有覆盖的 D4 / D7、E5、E6、G6、G11、G12、H13、I12（执行路径）、K12、L5、L8、M7、N5、O5 由 `acceptance.db.test.ts`、`boundaries`、`text/hashtags.test.ts` 新增用例补上。

### A. 信号目录（SG-1）

| # | 结果 | 覆盖 |
|---|---|---|
| A1 | ✅ | catalog「键集合与 requirements 逐项相等」（独立转写的 12 项） |
| A2 | ✅ | catalog「目录外的信号键一律 signal_unregistered」；读取 reader.db「目录外信号」；保存 segments.db「setItems 校验」；重算 recompute.db「signal_unregistered」。补算请求的信号键只来自监控段条目，所以由保存路径覆盖 |
| A3 | ✅ | A1 的 12 项相等即无多余项；catalog「没有 OCR、vision_*、ai_judgement 与聚合比率」 |
| A4 | ✅（按实现订正） | catalog「platformSignals」：快手不含 `account.*`、`comment.*`，含标题与话题、封面两项、ASR 两项；**不含 `text.body_normalized`**（快手列表从不返回正文，任务 3 用 fixture 核对），验收原文“含文本三项”以此为准 |
| A5 | ✅ | 同上，小红书不含 `account.*`、含 `comment.text_normalized` |
| A6 | ✅ | 同上，抖音 12 项 |

### B. 五态（SG-2）

| # | 结果 | 覆盖 |
|---|---|---|
| B1 | ✅ | 六种情形由三个用例合起来证明（不是同一内容上的顺序演示）：reader.db「封面：无引用 / pending / failed / carried_forward / 已归档」；scoring.db「A 的媒资行说已归档、但对象不可用：写 failed(image_unreadable)」「完成后读取口读到 valid」；原因码互不相同 |
| B1a | ✅ | facts.db「coverMaterial：封面素材（requirements R12）」全部用例 |
| B2 | ✅ | recompute.db「升版本后读作 stale」；scoring.db「升级能力版本后旧结果读作 stale」；compose |
| B3 | ✅ | schema「存储态只有 valid / failed；能力版本为正」 |
| B4 | ✅ | schema「形状：valid 恰好有 score 或 value 之一；failed 必带失败码且不带值」 |
| B5 | ✅ | compose「当前版本的 failed → failed」；scoring.db「候选图的确定性失败」（`failed`、`usable: false`、无分数） |
| B6 | ✅ | compose「最高版本的 failed 是旧版本的」；reader.db「旧版本留下的 failed 读作 missing」 |
| B7 | ✅ | compose「排队 / 运行中 → not_computed + pending；dead → compute_dead」；scoring.db「版本不一致……dead」 |
| B8 | ✅ | compose「已存储的值不受启用开关影响」；reader.db「已存储的值不受开关影响」 |
| B9 | ✅ | reader.db「能力未启用 → capability_disabled」 |
| B10 | ✅ | facts.db「profileMaterial」；compose「账号尚无当前主页快照」；cli「账号没有当前主页快照 → missing」 |

### C. 文本信号（SG-3）

| # | 结果 | 覆盖 |
|---|---|---|
| C1 | ✅ | reader.db「推进 current → 扫描 → 读到」；cli「show 看到话题与归一化标题」 |
| C2 | ✅ | text/hashtags「＃６１８、#618 、#618[话题]# 抽出同一个值」 |
| C3 | ✅ | text/hashtags「无空格连写」「# 相连的两个话题」「#xxx[话题]# 写法」 |
| C4 | ✅ | text/normalize「全角转半角……」；原文不变由 boundaries 护栏 ①（signals 不写 A 域表）保证 |
| C5 | ✅ | features「NULL 标题 / 正文在有字段的平台读作 valid 的空串」；reader.db |
| C6 | ✅ | compose「平台没有该字段 → not_applicable」；reader.db「快手：正文 not_applicable」。三个平台都有标题字段，机制由“快手无正文”演示 |
| C7 | ✅ | features「话题解析器抛错」；text/hashtags「解析器抛错」（片段哈希前缀与长度，不含原文）；reader.db |
| C8 | ✅ | features「同一快照重复处理」「新批次、素材未变」 |
| C9 | ✅ | catalog「话题的能力标识含平台」 |
| C10 | ✅ | text/normalize「幂等」（固定种子随机串） |
| C11 | ✅ | text/normalize「normalizeKeyword 与 normalizeText 是同一个函数」 |
| C12 | ✅ | facts.db「current 不是 finalized 的内容不在结果里」；features「没有 current 指针的内容不扫」 |
| C13 | ✅ | reader.db「快手」；compose（快手 `account.*` → `platform_unsupported`） |
| C14 | ✅ | text/hashtags「超过 64 字符的令牌丢弃」「每个内容至多 50 个」（实现上限 64，验收原文 65 字符的例子在内） |

### D. 评论文本信号（SG-4）

| # | 结果 | 覆盖 |
|---|---|---|
| D1 | ✅ | features「评论扫描：新评论产生特征行」；reader.db「评论文本：valid」 |
| D2 | ✅ | features「正文 NULL 与空串……」中的重复处理为 `unchanged` |
| D3 | ✅ | features「正文改了更新并写历史」 |
| D4 | ✅ | features「suspected_deleted / deleted 的评论不新抽取」；acceptance.db「D4 / D7」（已有特征行保留） |
| D5 | ✅ | features（列）；acceptance.db「E6」 |
| D6 | ✅ | features「快手没有评论」；reader.db「评论信号对快手 platform_unsupported」 |
| D7 | ✅ | features「NULL 与空串都读 valid 但指纹不同」；acceptance.db「D4 / D7」（NULL → 空串触发一次重算并写历史） |

### E. 特征存储与版本（SG-5）

| # | 结果 | 覆盖 |
|---|---|---|
| E1 | ✅ | features「新内容：……信封带 cap / ver / nv / at」；schema「一个内容只有一行」 |
| E2 | ✅ | features「批次 5 之后迟到批次 3」 |
| E3 | ✅ | features「标题改了……历史新增三行」（每个信号一行，共三行；验收原文“一行”指标题那行） |
| E4 | ◐ | reader.db「只升话题解析器版本」：标题、正文 valid，话题 stale。封面信号不受影响由特征行与结果行分表保证，没有单独断言 |
| E5 | ✅ | boundaries「E5：读取路径不引用 ODS 表」（静态）。没有做“删 ODS 数据后再读”的动态用例：读取路径不引用 ODS 表，动态用例不会比静态检查多证明什么 |
| E6 | ✅ | acceptance.db「E6」（四张表的列里没有发布时间、互动数、作者、昵称） |
| E7 | ✅ | schema「值列与信封必须一致」（含信封缺条目）；评论特征行同 |
| E8 | ✅ | schema「所基于的快照必须属于同一个内容（复合外键）」 |
| E9 | ✅ | features「扫描中途杀进程后重做」 |
| E10 | ✅ | features「回看窗口」「窗口之外的迟到由对账补上」 |
| E11 | ✅ | schema「信封里的状态只能是 valid / failed」（内容与评论） |
| E12 | ✅ | compose「只升 text.normalize ……」；text/normalize「按版本保留实现」 |
| E13 | ✅ | reader.db「只升 text.normalize、话题解析器版本不变」；compose |

### F. 复用键与结果行（SG-6）

| # | 结果 | 覆盖 |
|---|---|---|
| F1 | ✅ | scoring.db「同一结果行并发写入两次」；schema「复用键唯一」 |
| F2 | ✅ | scoring.db「换标准图后再请求」 |
| F3 | ✅ | scoring.db「同一张封面被两个内容引用……两个监控段引用同一张标准图字节」 |
| F4 | ✅ | 同上（`lineage` 记第一次计算的计划）；schema（唯一键列不含血缘） |
| F5 | ✅ | schema「分数范围 0.00–10.00」 |
| F6 | ◐ | speech.db「模型输出缺 reason / verdict 非法 / 模型拒绝 → failed」：模型输出经 zod 校验，不合规写 `failed(invalid_output)`，不会成为 valid 行；模型版本与提示词版本由 C 自己写入，不经模型，所以不会缺。验收原文“写入前 zod 拒绝、库中无行”对应的是模型输出这一侧 |
| F7 | ✅ | scoring.db「升级能力版本后……」；recompute.db「image.template 升到 2……旧行保留」 |
| F8 | ✅ | features「NULL 与空串的素材指纹不同」「同一快照重复处理：无写入」 |
| F9 | ◐ | schema「换能力标识都是新行」；catalog「版本表里没有目录用不到的能力」「话题的能力标识含平台」。“信号键与能力标识一一对应、不可变更”没有写成一条断言 |

### G. 监控段与标准图（SG-7）

| # | 结果 | 覆盖 |
|---|---|---|
| G1 | ✅ | segments.db「同一对象第二张模板图替换前一张」 |
| G2 | ✅ | segments.db「元素图按 element_key 可有多张；背景 / 头像对象各自独立」 |
| G3 | ✅ | segments.db（对象键 `segments/12/1/cover/template/<sha256>`）；真实桶：本机 CLI 对 `hbecho-signals` 实测同形（见 MAN-5） |
| G4 | ✅ | segments.db「已发布后……segment_immutable」 |
| G5 | ✅ | segments.db「setItems 校验」（两个判定项） |
| G6 | ✅ | segments.db「setItems 校验」（快手）；acceptance.db「G6」（小红书） |
| G7 | ✅ | segments.db「超过 10 MiB、无法解码、不是图片：被拒绝，数据库与 OSS 都没有残留」 |
| G8 | ✅ | segments.db「关掉某能力的启用开关」「目录里删掉的信号」 |
| G9 | ✅ | segments.db「新草稿：版本 +1……」 |
| G10 | ✅ | segments.db「purge：删除全部版本……」「purge 删除对象失败：数据库行保留，重试后清除」 |
| G11 | ✅ | acceptance.db「G11」 |
| G12 | ✅ | acceptance.db「fake D 的调用序列」（同版本草稿改图，只有 version 1） |
| G13 | ✅ | segments.db「put 失败：不留行」「事务失败……不伤旧图」 |
| G14 | ✅ | segments.db「事务失败：刚上传的对象被清理」 |
| G15 | ✅ | segments.db「setItems 校验」（`a/b`、`..`、`.`、空串、65 字符被拒，`logo` 通过；`logo-1_A.v2` 同属允许的字符集） |

### H. 素材比对（SG-8）

| # | 结果 | 覆盖 |
|---|---|---|
| H1 | ✅ | scoring.db「100 个内容主体……」 |
| H2 | ✅ | scoring.db「第二次请求：不新增任务；任务全部完成后再请求」 |
| H3 | ✅ | scoring.db「换标准图后再请求」 |
| H4 | ✅ | scoring.db「能力服务回报的版本与目录不一致」 |
| H5 | ✅ | pytest「test_same_image_scores_near_full」；真实桶端到端 smoke 得 10 |
| H6 | ✅ | pytest「test_scaled_rotated_brighter_still_matches」；另有「test_recompressed_and_blurred」 |
| H7 | ✅ | pytest「test_unrelated_image_scores_low」；真实桶端到端 smoke 得 0.22 |
| H8 | ✅ | pytest「test_element_embedded_in_scene_scores_high_and_absent_scores_low」 |
| H9 | ✅ | pytest「test_low_feature_image_scores_zero_and_is_flagged」 |
| H10 | ✅ | pytest「test_error_codes_carry_side」（`side` 为 `candidate` / `reference`） |
| H11 | ✅ | scoring.db「候选图的确定性失败写 failed(image_unreadable)」 |
| H12 | ✅ | scoring.db「标准图（reference）侧失败是配置错误」 |
| H13 | ✅ | scoring.db「完成后读取口读到 valid」；acceptance.db「fake D 的调用序列」（返回值与证据里没有匹配 / 不匹配字段） |
| H14 | ✅ | scoring.db「runner 调用能力服务期间，连接池里没有未提交的事务」（`innodb_trx`） |
| H15 | ✅ | scoring.db「账号主体（抖音头像）」；facts.db「profileMaterial」 |
| H16 | ✅ | scoring.db「拒绝：……超过 5,000」 |
| H17 | ✅ | pytest「test_error_codes_carry_side」（404 → `source_missing`）「test_connection_refused_is_source_unavailable」；scoring.db「能力服务不可用 / 超时 / 来源 5xx 都是瞬时失败」；matcher-client.test |

### I. 音频理解（SG-9）

| # | 结果 | 覆盖 |
|---|---|---|
| I1 | ✅ | speech.db「默认装配（DisabledAiGateway）：不建任务、不发调用」 |
| I2 | ✅ | speech.db「同一音频两次请求，ASR 只调用一次」 |
| I3 | ✅ | speech.db「不同标准文本互不复用；相同标准文本 + 提示词版本 + 模型版本复用」 |
| I4 | ✅ | speech.db「模型版本 m1 → m2」 |
| I5 | ✅ | speech.db「同一 callKey 只计费一次：调用成功后、写结果前崩溃」 |
| I6 | ✅ | speech.db「输出不合法 → failed(invalid_output)；模型拒绝 → failed(model_refused)」「模型输出缺 reason / verdict 非法 / 模型拒绝 → failed，不是 not_meets」 |
| I7 | ✅ | speech.db「网关瞬时错误：重试，用尽后 dead，没有结果行」 |
| I8 | ✅ | speech.db「ASR 缺失时判定 deferred」「延后累计超过上限 → dead(dependency_timeout)」 |
| I9 | ✅ | speech.db「音频未归档：missing(audio_not_archived)，无任务」 |
| I10 | ✅ | speech.db「ASR 完成后判定完成，结果行含结论、理由、模型与提示词版本」 |
| I11 | ✅ | speech.db「默认装配」（模型为空不建任务）「请求之后、运行之前模型换了」 |
| I12 | ✅ | 保存路径 segments.db「setItems 校验」；执行路径 acceptance.db「I12（执行路径）」 |
| I13 | ✅ | boundaries 护栏 ④（及反向用例） |
| I14 | ✅ | speech.db「ASR 文本」（启用）；「默认装配」（禁用，`executability` 阻塞） |
| I15 | ✅ | speech.db「只有 ASR 模型、判定模型为空」 |

### J. 能力版本、`stale` 与保留期（SG-10）

| # | 结果 | 覆盖 |
|---|---|---|
| J1 | ✅ | recompute.db「升版本后读作 stale ……没有新任务、没有新的监控段版本」 |
| J2 | ✅ | 同上（两种 `stalePolicy`）；compose |
| J3 | ✅ | retention.db「推进 4 个月……推进 13 个月」 |
| J4 | ✅ | 同上 |
| J5 | ✅ | retention.db「延后后到原时间点仍在；传较早时间不缩短」 |
| J6 | ✅ | retention.db「清理后读取 missing(not_computed)，任务表无新行」 |
| J7 | ✅ | retention.db「特征行不被清理……分块删除中途退出后可重跑」 |
| J8 | ✅ | retention.db（成功 +1 年）；scoring.db「候选图的确定性失败」（失败 +3 个月）；features「标题改了」（历史 +1 年） |
| J9 | ✅ | scoring.db「升级能力版本后旧结果读作 stale，不会被 requestScores 重算」 |
| J10 | ✅ | scoring.db「任务 succeeded 但结果行已被保留期清理」 |

### K. 显式重算（SG-11）

| # | 结果 | 覆盖 |
|---|---|---|
| K1 | ✅ | recompute.db「没有范围或只有 segmentRef：scope_required」 |
| K2 | ◐ | recompute.db「preview 与随后 apply 的条数一致；preview 不写任何表」：apply 在执行时重新展开范围（以 apply 时的条数为准）；两次调用之间数据变化的情形没有单独断言 |
| K3 | ✅ | recompute.db「无 rule.definition.manage：先于任何读库被拒绝」 |
| K4 | ✅ | recompute.db「品牌范围外的对象不在展开结果里」 |
| K5 | ✅ | recompute.db「重算后范围内读作 valid……范围外仍 stale」 |
| K6 | ✅ | recompute.db「preview ……apply 写一行记录和审计事件」 |
| K7 | ✅ | recompute.db「多块 + 中途杀进程续跑」 |
| K8 | ✅ | recompute.db「不改监控段」 |
| K9 | ✅ | recompute.db「brandId 经当前归属展开」；facts.db「品牌经账号的当前归属展开」 |
| K10 | ✅ | recompute.db「同范围 running 的 run 再次 apply 续跑原 run」 |
| K11 | ✅ | cli.commands「没有范围 / 未知键被拒（没有 --all）」 |
| K12 | ✅ | acceptance.db「K12」 |
| K13 | ✅ | recompute.db「failed 的 run 再次 apply 续跑」 |
| K14 | ✅ | recompute.db「completed 之后再 apply 新建 run」 |
| K15 | ◐ | recompute.db「范围内全无旧值时 from_version 为 NULL」：断言了 `from_version` 与不报错；“对象按补算落到目标版本”没有单独断言 |
| K16 | ✅ | recompute.db「取消 running 的 run」「正在执行的 chunk 在提交前看到 cancelled」 |
| K17 | ✅ | recompute.db「对 completed / cancelled 再取消被拒」；cli.commands（`run_not_cancellable`） |
| K18 | ✅ | recompute.db「重算后范围内读作 valid ……素材未变批次相同也重算」；features「mode=recompute」 |
| K19 | ✅ | recompute.db「评论类信号按内容范围重算」 |

### L. 读取口与补算请求（SG-12）

| # | 结果 | 覆盖 |
|---|---|---|
| L1 | ✅ | reader.db「read / readMany 不创建任务」；读取口没有能力服务与网关依赖（类型上无法调用） |
| L2 | ✅ | reader.db「readMany 的查询次数与主体数无关」；规模演练 5,000 主体 2 次查询 |
| L3 | ✅ | reader.db「缺 param」 |
| L4 | ✅ | compose；scoring.db |
| L5 | ✅ | acceptance.db「fake D 的调用序列」（可执行的草稿与已发布都可请求）；scoring.db「不可执行（默认启用集不含图像类）」被拒 |
| L6 | ✅ | scoring.db「拒绝：缺 Capability、超过 5,000、监控段不存在、不可执行」 |
| L7 | ✅ | cli.commands「score」（输出只有分布与 `needMedia`）；返回类型不含文本字段 |
| L8 | ✅ | acceptance.db「fake D 的调用序列」 |
| L9 | ✅ | only.db「only=[封面]」：只建封面任务，判定（付费）一个都不建；不传 only 行为不变；再请求 only=[判定] 只多出判定任务 |
| L10 | ✅ | only.db「判定模型中途丢失……」「封面标准图缺失……」：`executability` 与 `not_executable` 只看 only 里的信号 |
| L11 | ✅ | only.db「参数检查」「executability 的 only 同样做参数检查，且仍先于读库做授权」 |

### M. 任务执行（SG-13）

| # | 结果 | 覆盖 |
|---|---|---|
| M1 | ✅ | scoring.db「两个 worker 抢同一个任务：只有一个拿到」（顺序闸门） |
| M2 | ✅ | 同上（租约过期接手，旧 worker 的写入被拒且零写入） |
| M3 | ✅ | scoring.db「任务在调用返回之后、事务提交之前崩溃」 |
| M4 | ✅ | scoring.db「版本不一致……用尽后 dead」「反复崩溃的任务最终 dead」 |
| M5 | ✅ | boundaries 护栏 ①（`syncTasks` 在 A 域表清单里）与 ② |
| M6 | ✅ | scoring.db「第二次请求：不新增任务」；schema「幂等键唯一」 |
| M7 | ✅ | acceptance.db（创建时 `expires_at` = +1 年）；retention.db「只删终态任务」 |
| M8 | ✅ | recompute.db「取消……revive 被拒」「tasks revive」 |

### N. 授权与审计（SG-14）

| # | 结果 | 覆盖 |
|---|---|---|
| N1 | ✅ | reader.db / recompute.db / scoring.db / cli「零查询」；retention.db（以“碰库即抛错”的代理断言） |
| N2 | ◐ | recompute.db「品牌范围外的对象不在展开结果里」（等同于未找到）；authz.test「hide 表现为未找到」。`brandCode` 这个**参数**越权返回 `brand_out_of_scope`（拒绝），不是“未找到”：它是调用方传入的范围，不是已有对象 |
| N3 | ✅ | redact.test；matcher-client.test「错误消息里的签名 URL 被脱敏」；scoring.db（证据无 URL）；speech.db（错误详情无签名 URL）；acceptance.db（审计事件无 URL） |
| N4 | ✅ | authz.test「缺 … 启动失败，不退化成全部范围」；main「缺任一身份变量……退出码 1」 |
| N5 | ✅ | 创建 / 发布 / 清除 / 上传 / 删除：acceptance.db「fake D 的调用序列」与 segments.db；预览 / 执行 / 取消：recompute.db；`task_dead`：scoring.db |

### O. 配置、门控与离线（SG-15）

| # | 结果 | 覆盖 |
|---|---|---|
| O1 | ✅ | catalog「启用集：缺省或空白只有文本类」；reader.db「默认配置下图像类读作 capability_disabled」 |
| O2 | ✅ | catalog「含目录外的能力标识：启动失败并点名」；config.test；main |
| O3 | ✅ | config.test「缺 … 启动失败并指出缺哪一项」；main |
| O4 | ✅ | `tests/harness/harness.test.ts`（network-deny）；`tests/harness/setup.ts` 对每个测试进程生效 |
| O5 | ✅ | text/hashtags「O5：同一组样本连续运行 3 次」；`verify.sh` 在任务 2–13 的每个边界重复运行结果一致 |
| O6 | ✅ | 见下方验证数字 |
| O7 | ✅ | `scripts/check-secrets.sh`（verify 第 6 步，含 git 历史）；`.env.example` 的新变量全部无值 |

### P. 一致性与护栏（SG-16）

| # | 结果 | 覆盖 |
|---|---|---|
| P1 | ✅ | verify 第 4 步（`drizzle-kit generate` 不产生新文件） |
| P2 | ✅ | schema「可重复执行：第二次迁移不改变任何东西」 |
| P3 | ✅ | boundaries「① ……」「① 反向用例」 |
| P4 | ✅ | boundaries「② ……」「② 反向用例」 |
| P5 | ✅ | boundaries「③ ……」「③ 反向用例」；任务 13 起扫描范围含 `src/worker/signals-*.db.test.ts` |
| P6 | ✅ | boundaries「④ ……」「④ 反向用例」 |
| P7 | ✅ | verify 第 3、5 步全量通过 |
| P8 | ✅ | `git diff 718a8a4 -- src/db/schema/content.ts`：一行注释加一行索引；schema「contents 上多了且只多了一条索引」 |

### PRD 验收清单

PRD 清单每一条对应上表的条目（映射见下方“PRD 验收清单对照”）。其中 `C2：[手工] 运营看到版本、时间、匹配点数` 对应 MAN-1。

### 手工项与环境项

见文末“手工项”“环境依赖项”两节，状态已更新。

### 验证数字

- **本机 `./scripts/verify.sh`**（2026-11-12，提交 `b04b308` 之后）：类型检查通过；离线单元 **996** 通过；迁移与 schema 一致；数据库测试 **1429** 通过、1 个既有 skip；密钥扫描、链接、文档登记通过；Python **36** 通过；`verify: OK`。同一天更早的一次本机运行撞上 `activity-plan/scale.perf.db.test.ts` 的偶发失败（A 的并发解析，更新 `sync_batches` 处的事务错误，与 C 无关；机器上有别的会话在跑测试时更容易出现，单独重跑 3 次里 1 次通过），重跑后全绿。
- **测试 ECS**（`i-2zef8qpi1d2mldntjgrv`，只经 Workbench；一次性 MySQL 8.4 与 `node:24-slim` 容器，独立网络、不映射宿主端口、库名 `hbecho_test`，用完即删；容器内存峰值 Node 866 MiB、MySQL 713 MiB）：`scripts/ecs-test.sh start`（`SUITE=full SIGNALS_DRILL=full`），提交 `b04b308` 的归档——类型检查通过；离线单元 **996** 通过（9 秒）；数据库测试 **1429** 通过、1 个既有 skip（**547 秒**，含 20 万内容的完整规模演练）。首次运行（提交 `346da58`）数据库测试 1427 通过、2 失败：一个是上述偶发失败，另一个是规模演练的 `beforeEach` 清库在 ECS 上超过 10 秒（上一用例留下 20 万行），已改为在本文件的 `afterEach` 里清库并给足超时。
- **测试 ECS 上的 Python**（宿主机 Python 3.11.6、`opencv-python-headless` 5.0.0.93、numpy 2.4.6；宿主机没有 ffmpeg，ffmpeg 9.0.2 由 venv 里的 `imageio-ffmpeg` 提供，没有改系统）：`services/capability/tests/test_match.py` **18** 通过。这次运行暴露了测试对响应头大小写的依赖（uvicorn 只装 h11 时头名是小写），已修（`b04b308`）。**没有在 ECS 上跑** `test_image.py` / `test_app.py`（HEIC、音频抽取），所以“HEIC 封面经 ffmpeg ≥ 7.1 解码再匹配”没有在 ECS 上证明。
- **真实桶 + 真实能力服务的端到端 smoke**（`pnpm signals-smoke`，不发付费调用，用完即删）：在测试 ECS 上用**实例角色**（`hbecho-ecs-role`，内网 endpoint）对 `hbecho-signals` 桶写 3 个对象、签名 GET URL、经 `HttpImageMatcher` 调 ECS 上的 Python 服务——同图 **10.00**、无关图 **0.22**（能力 `image.template@1`，内点比率 0.895），桶内无残留；在本机用 `hbecho-setup` 身份重复一次，结果同形（同图 10.00、无关图 0.22）。
- **规模演练**（design §12.1 有数字与说明）：20 万内容扫描、`readMany` 5,000 主体、1 万任务领取、1,000 个评分任务端到端，本机与测试 ECS 各一次，均通过。

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
| B1 | SG-2 | 同一内容的封面信号，依次在「无封面引用 / 引用 `pending` / 引用 `failed` / 引用 `carried_forward` / 已归档且补算任务因 OSS 对象缺失而失败 / 已计算」六种情形下读取（第 5 种需先 `requestScores` 并让任务跑一次） | `not_applicable` / `missing` / `missing` / `missing` / `failed` / `valid`；原因码各不相同（`no_reference`、`media_pending`、`media_failed`、`media_carried_forward`、`image_unreadable`、无） |
| B1a | SG-2、SG-8 | 内容的封面在第一个批次归档、之后两个批次的快照都没有 `cover` 引用（A 的封面首次规则）；另一内容更新批次有 `pending` 引用而更早批次已归档 | 两者都读作可用封面（`facts.coverMaterial` 为 ready），不是 `not_applicable`，也不是 `media_pending`（requirements R12） |
| B2 | SG-2 | 提升目录中某信号版本号后读取旧结果 | `stale`，带旧值与旧版本；不是 `missing`；任务表无新行 |
| B3 | SG-2 | 数据库插入 `state='missing'`、`'stale'`、`'not_applicable'` 的结果行 | CHECK 拒绝 |
| B4 | SG-2 | `failed` 结果行带 `score` 或 `value` | CHECK 拒绝 |
| B5 | SG-2 | 读取一条 `failed` 结果 | 返回 `failed` 与失败码，`score` / `value` 不存在，**不是 0** |
| B6 | SG-2 | 最高版本的行是旧版本的 `failed` | 读作 `missing`，原因 `failed_under_old_version` |
| B7 | SG-2 | 有一条排队中的任务 / 一条 `dead` 的任务 | `missing` + `pending: queued` / `missing` + `pending: dead` + `compute_dead` |
| B8 | SG-2 | 能力被关闭后读取已存储的有效值 | 仍返回 `valid`；关闭只阻止新计算 |
| B9 | SG-2 | 能力被关闭且无已存储值 | `missing`，`capability_disabled` |
| B10 | SG-2 | 抖音账号：尚无 current 主页快照 / 有快照但无背景引用 | `missing(no_profile_snapshot)` / `not_applicable(no_reference)` |

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
| C14 | SG-3 | 话题长度 65 字符的令牌；一个内容含 60 个不同话题 | 超长令牌被丢弃；保留前 50 个且顺序为首次出现顺序（常量待确认，见 design §14 第 17 项） |

### D. 评论文本信号（SG-4）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| D1 | SG-4 | 评论入库后跑一轮评论扫描 | `comment_features` 有一行，`comment.text_normalized` 为 `valid`，信封带 `nv` |
| D2 | SG-4 | 同一评论正文再次出现（`last_seen_at` 前移） | 不写入 |
| D3 | SG-4 | 评论正文被平台修改 | 特征行更新；历史表新增一行（`material_changed`） |
| D4 | SG-4 | `suspected_deleted` / `deleted` 的评论 | 不被新抽取；已有特征行保留 |
| D5 | SG-4 | 检查 C 的全部表的列 | 无评论作者 ID、昵称、点赞数 |
| D6 | SG-4 | 快手内容的评论信号 | `not_applicable`（`platform_unsupported`） |
| D7 | SG-4 | 评论 `content_text` 为 `NULL` 与空串 | 两者信号都读 `valid` 空值；素材指纹不同；从 `NULL` 变空串会触发一次重算并写历史 |

### E. 特征存储与版本（SG-5）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| E1 | SG-5 | 一个内容反复推进 current | `content_features` 中仍只有一行（主键 `content_id`）；信封里存在的每个信号都有 `state`（只能是 `valid` / `failed`）/ `cap` / `ver` / `at`，文本类信号还有 `nv` |
| E2 | SG-5 | 先写批次 5 的快照特征，再迟到处理批次 3 | 特征行不变，仍指向批次 5（`skipped_older`） |
| E3 | SG-5 | 标题改了 | 特征行为新值；历史表新增一行，内容为旧标题的归一化值，原因 `material_changed`；历史行的 `normalizer_version` 为写入时的 `nv` |
| E4 | SG-5 | 只把 `text.hashtags` 版本 1 → 2 | 标题、正文读作 `valid`；话题读作 `stale`；`content.cover_template_score` 不受影响 |
| E5 | SG-5 | 删除 ODS 相关对象与表数据后读取特征 | 读取不受影响（读取路径不引用 ODS） |
| E6 | SG-5 | 检查 `content_features` / `comment_features` / `signal_results` 的列 | 不含 `published_at`、互动数、作者 ID 等 A 的事实字段 |
| E7 | SG-5 | 值与信封不一致：`title_normalized` 非空而信封 `failed`；`title_normalized` 非空而信封**缺条目**；`title_normalized` 为空而信封 `valid`（评论特征行同样三种） | 均被 CHECK 拒绝（含信封缺条目这一格，空安全比较保证不被 NULL 放行） |
| E8 | SG-5 | 复合外键：特征行指向别的内容的快照 | 数据库拒绝 |
| E9 | SG-5 | 扫描中途杀进程后重做同一批 | 特征行恰好一行，历史无重复 |
| E10 | SG-5 | 游标已越过、但提交更晚的内容（回看窗口内 / 窗口外） | 窗口内由「迟到」查询补上；窗口外由对账补上 |
| E11 | SG-5 | 信封里写入 `state='missing'` 或 `'stale'`（特征行与评论特征行） | CHECK 拒绝（只允许 `valid` / `failed`） |
| E12 | SG-5 | `text.title_normalized` 用旧归一化版本写入（`nv=1`）；目录升到 `nv=2` 后 D 读到 `stale` 值 | `SignalValue.normalizerVersion` 为 1；`normalizeKeyword(raw, 1)` 与该值同口径；`NORMALIZERS` 含 1 与 2 |
| E13 | SG-5 | `text.hashtags.douyin` 解析器版本仍为 1、`nv=1`；只把 `text.normalize` 升到 2 | 话题读作 `stale`；`capability.version` 仍为 1；`normalizerVersion` 为 1；`normalizeKeyword(raw, 1)` 与旧话题同口径 |

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
| F9 | SG-6 | 同一（信号键、素材、参数、版本）、能力标识不同的两行 | 可并存；目录测试断言信号键与能力标识一一对应、不可变更 |

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
| G15 | SG-7 | `element_key` 为 `a/b`、`..`、空串（元素图）、65 字符 | 均被 zod 拒绝；合法值 `logo-1_A.v2` 通过 |

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
| H17 | SG-8 | Python 取候选图返回 404 / 取候选图连接超时 | 前者 422 `source_missing`（`side=candidate`）→ 写 `failed(image_unreadable)`、不重试；后者 502 `source_unavailable` → 瞬时重试 |

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
| I14 | SG-9 | 监控段只配 `content.asr_text`：fake 网关启用 / 默认禁用 | 启用时 `requestScores` 建 ASR 任务并最终读到转写；禁用时 `executability` 列出阻塞项、任务数 0、读作 `capability_disabled` |
| I15 | SG-9 | `activeModel('asr')` 非空而 `activeModel('judge')` 为空 | `content.asr_text` 可请求并计算；`content.asr_judgement` 读作 `capability_disabled`、不建任务；ASR 文本的参数指纹为零，不含任何模型版本 |

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
| J10 | SG-10 | 失败结果行被清理而其任务行仍为 `succeeded`，再次 `requestScores` | 任务被置回 `pending` 并重新补算，不会永久 `missing` |

### K. 显式重算（SG-11）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| K1 | SG-11 | `apply` 不带范围 | `scope_required` |
| K2 | SG-11 | 数据不变时 `preview` 与随后 `apply` | 条数一致；`preview` 不写任何表；两者之间数据变化时以 `apply` 时的 `scope_count` 为准 |
| K3 | SG-11 | 无 `rule.definition.manage` 的操作者 | 拒绝（读库之前） |
| K4 | SG-11 | 品牌范围受限的操作者，范围含范围外对象 | 范围外对象不在展开结果里 |
| K5 | SG-11 | 重算后 | 范围内读作 `valid`，范围外同信号仍 `stale` |
| K6 | SG-11 | 重算记录与审计事件 | 各一条，含操作者、信号、范围、`scope_count`、`from_version`（范围内最低版本；全无旧值时为 NULL）与 `to_version` |
| K7 | SG-11 | 中途杀进程后重启 | 续跑完成；每个对象只被处理一次（历史表无重复） |
| K8 | SG-11 | 重算前后监控段的版本 | 不变 |
| K9 | SG-11 | `brandId` 范围，账号在重算前换过店 | 用**当前**归属展开 |
| K10 | SG-11 | 同范围 `running` 的 run 再次 `apply` | 返回并续跑既有 run，不重复处理 |
| K11 | SG-11 | CLI 不提供 `--all` / 全量重算入口 | `parseArgs` strict 拒绝 |
| K12 | SG-11 | 重算期间读取 | 仍读到旧值并标 `stale`，不阻塞 |
| K13 | SG-11 | 同范围 `failed` 的 run 再次 `apply` | 置回 `running`，在 `cursor_id` 处复活/新建 chunk 并续跑 |
| K14 | SG-11 | 同范围 `completed` 后范围内新进入对象，再次 `apply` | 新建 run，只处理仍低于目标版本的对象；旧对象不重复处理、历史无重复 |
| K15 | SG-11 | 范围内全无旧值（对象从未计算过该信号）时 `apply` | `from_version` 为 `NULL`；对象按补算同样落到目标版本；不报错 |
| K16 | SG-11 | `recompute cancel` 放弃一个 `running` 的 run（队列里还有 chunk）；之后同范围再次 `apply` | run 置 `cancelled` 且 `active_key` 清空；未开始的 chunk 置 `dead(run_cancelled)` 不再执行；已领取的 chunk 在下一个分块边界停止，不建新 chunk、不产生新的历史/结果行；新建 run，不续跑已放弃的 |
| K17 | SG-11 | 对 `completed` / 已 `cancelled` 的 run 调用 `recompute cancel` | 拒绝 `run_not_cancellable`；状态不变 |
| K18 | SG-11 | 素材未变、批次与特征行相同的文本信号已 `stale`；`apply` 重算 | 该信号读作 `valid`、`normalizerVersion` 更新为当前；历史行 `superseded_reason='capability_upgraded'`；不因素材指纹相同或批次相同而跳过 |
| K19 | SG-11 | `comment.text_normalized` 按内容范围重算 | 范围内内容的评论特征行更新；范围外不变；评论数不影响内容信号 |

### L. 读取口与补算请求（SG-12）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| L1 | SG-12 | `read` / `readMany` 在任意状态下 | `signal_tasks` 行数不变；能力服务与网关调用数不变 |
| L2 | SG-12 | `readMany` 5,000 个主体 | 数据库查询次数为常数（计数器） |
| L3 | SG-12 | 参数化信号缺 `param` | `param_required` |
| L4 | SG-12 | 排队中 / `dead` 的任务 | `pending: queued` / `pending: dead` |
| L5 | SG-12 | `requestScores` 对**可执行的**草稿与已发布监控段 | 均可用；不可执行的草稿被拒绝（`not_executable`） |
| L6 | SG-12 | `requestScores` 对不存在的监控段、不可执行的监控段、超 5,000 主体 | 拒绝 |
| L7 | SG-12 | 返回值 | 不含内容原文 |
| L8 | SG-12 | fake D 契约：`create → putImage → setItems → requestScores → readMany 轮询 → publish → newDraft → purge` | 序列通过，轮询最终无 `pending` |
| L9 | SG-12 | 监控段含封面比对与 ASR 判定，主体都有封面与音频；`requestScores(only=[封面])` | 只建封面任务，不建判定 / ASR 任务；不传 `only` 时两类都建；之后 `only=[判定]` 只多出判定任务 |
| L10 | SG-12 | 判定模型丢失 / 封面标准图缺失时，`executability(only=…)` 与 `requestScores(only=…)` | 不传 only 时整段仍不可执行；only 不含出问题的信号时可执行；only 含它时阻塞项只有它自己的 |
| L11 | SG-12 | `only=[]`、目录外键、监控段没配的键；无 Capability | `only_empty`、`signal_unregistered`、不报错且无任务；授权先于读库 |

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
| M8 | SG-13 | `signals tasks revive` 一个 `dead(run_cancelled)` 的 chunk 任务 | 拒绝；不复活已取消 run 的分块 |

### N. 授权与审计（SG-14）

| # | 需求 | 命令 / 断言 | 预期 |
|---|---|---|---|
| N1 | SG-14 | 缺 Capability 的调用 | 读库之前被拒绝（查询计数器为 0） |
| N2 | SG-14 | 越品牌范围的重算对象 | 表现为「未找到」 |
| N3 | SG-14 | 审计事件字段；`signal_tasks.last_error_detail`；结果行 `evidence` | 无签名 URL（统一替换为 `<url>`）、无文本原文、无图片字节、无模型 Key；对含签名 URL 的 Python 错误消息做断言 |
| N4 | SG-14 | 缺 `HBECHO_SIG_ACTOR` / `_CAPABILITIES` / `_BRAND_SCOPE` 任一项 | CLI 启动失败，退出码非零；`_BRAND_SCOPE` 缺省不退化为全部 |
| N5 | SG-14 | 审计事件覆盖 | 监控段创建 / 发布 / 清除、标准图上传 / 删除、重算预览 / 执行 / 取消、任务 `dead` 各有事件 |

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
| C2：`[手工]` 运营看到版本、时间、匹配点数 | MAN-1 |
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

| # | 需求 | 谁看 | 在哪看 | 检查什么 | 状态（2026-11-12） |
|---|---|---|---|---|---|
| MAN-1 | SG-8 | 评审人 | 测试 ECS，CLI `signals show --content <id> --plan <id> --version <n>` | 一个已计算的内容下能看到：用了哪版能力、什么时候算的、匹配点数量与内点率；输出里没有内容原文 | ◐ CLI 路径已由 `signals-cli.commands.db.test.ts`「show --plan --version」证明（分数、能力版本、时间、匹配点证据，不含原文）。**评审人在测试 ECS 的真实数据上抽查未做**：测试 ECS 的 `hbecho` 库没有迁移 C 的表（对现有库做 DDL 需另行同意） |
| MAN-2 | SG-8 | 业务 + 刘学奎 | 标定报告 | 约 20 对脱敏样本的分数分布合理（同图高、轻度改动居中、无关图低）；每个整数档配有一张样例图；`R_FULL` / `I_FULL` 的取值有依据；刘学奎签字后才可把 `image.*` 加入生产启用集 | ⏳ 缺业务样本，[`calibration-report.md`](calibration-report.md) 状态“未标定” |
| MAN-3 | SG-8 | 业务 | 样本图 | 纯色 logo、文字类元素在元素模式下得分很低且 `low_features` 为真——确认这符合 PRD C §5.1 对元素图适用边界的描述 | ⏳ 同上 |
| MAN-4 | SG-3 | 评审人 | 测试 ECS，用 `a-full-sync` 已有的真实同步数据 | 抽查 10 个内容：话题与原文标题 / 正文 / `tag_text` 对得上，无漏抽 / 错抽；抖音、小红书、快手各至少 3 个 | ⏳ 同 MAN-1：需要有 C 的表的库与真实同步数据 |
| MAN-5 | SG-7 | 评审人 | 测试 ECS | 标准图上传后，CLI `segment show` 列出的对象键含计划 ID、版本、图像对象与 SHA-256；`segment purge` 后桶内无残留（需先有真实桶，见 ENV-1） | ✅（在本机而不是测试 ECS 上做的）：用 CLI 对真实 `hbecho-signals` 桶 `put-image`，`show` 列出键 `segments/901/1/cover/template/<sha256>`，`purge --apply` 后桶内 0 个对象。没在 ECS 上做是因为 `signals-main` 目前只支持 AccessKey 环境变量，ECS 上没有 AccessKey（实例角色凭证未接入，见 tasks 任务 13 记录） |

## 环境依赖项（不能离线验证）

| # | 依赖 | 状态（2026-11-12） | 说明 |
|---|---|---|---|
| ENV-1 | 真实 `hbecho-signals` 桶与 RAM（读写删） | ✅ | 刘学奎事先书面同意后创建：cn-beijing、私有、Standard、LRS、阻止公共访问、碎片 7 天；`hbecho-oss-rw` v3 新增 `SignalsStdImageReadWriteDelete`（仅该桶）。测试 ECS 实例角色实测：写 / 列 / 读 / 删通过，`hbecho-media` 删除仍被拒。记录在运维手册 §1.6、§17 与 ADR-0001 |
| ENV-2 | Python 服务上的 OpenCV 匹配（真实 ffmpeg ≥ 7.1 + HEIC 封面） | ◐ | ECS 上 `test_match.py` 18 通过（OpenCV 5.0.0.93、ffmpeg 9.0.2 由 venv 提供）；端到端 smoke 通过（同图 10.00、无关图 0.22）。**HEIC 封面未在 ECS 上验证**（宿主机没有 ffmpeg，`test_image.py` / `test_app.py` 未跑） |
| ENV-3 | 匹配分标定 | ⏳ | 等业务提供样本；MAN-2 通过前 `image.*` 不进生产启用集 |
| ENV-4 | 真实 ASR / 大模型 | ⏳ | `h-ai-min` 未开始；本 spec 的网关默认 disabled，没有发过任何付费调用 |
| ENV-5 | D 的消费 | ⏳ | `d-rule-engine` 未实施；`retainUntil`、读取口、监控段由契约测试固定 |
| ENV-6 | 扫描回看窗口在真实同步写入并发下是否足够 | ⏳ | 未验证：需要在带 C 的表的库上跑真实同步数据（见 MAN-1） |
| ENV-7 | 规模与吞吐 | ✅ | 数字已回填 [design §12.1](design.md)（本机与测试 ECS） |

## 覆盖不了的

- 真实模型的转写与判定质量、成本与延迟：属于 `h-ai-min`，本 spec 只证明编排、参数化、缓存、失败语义；
- 匹配分对真实业务图的区分度：只由人工标定（MAN-2）证明，合成图只证明排序；
- 页面上的信号展示：本 spec 无页面，D 的页面验收另立；
- 多进程并行扫描的性能：游标只有一份，并行不提速；正确性靠租约与幂等，性能不声称；
- 生产部署形态与资源上限：不在本 spec。
