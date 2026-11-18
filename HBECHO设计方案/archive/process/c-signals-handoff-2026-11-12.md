# C 识别能力（c-signals）· 交接说明

> **archived**（2026-11-18 文档瘦身归档）：新会话交接说明（任务 2 开工前），任务 0–13 已完成并合并。
> **替代**：[`c-signals` tasks.md](../../../.kiro/specs/c-signals/tasks.md) 的完成记录与 [`acceptance.md`](../../../.kiro/specs/c-signals/acceptance.md)。
> **禁止用途**：不得据此判断当前进度或作为实现依据；只作追溯。

> **superseded**：任务 2–10 已完成，最新状态与任务 11–13 的交接见 [`handoff-2026-11-12-b.md`](c-signals-handoff-2026-11-12-b.md)。本文只保留作任务 2 开工前的历史记录；其中“任务 2–13 未开始”“迟到提交的 `25c3a10` 未推”等已过时。禁止据此判断当前进度。

> **日期**：2026-11-12
> **用途**：让新会话接着做任务 2–13。这是进度与注意事项，不是需求；冲突时以 [`requirements.md`](../../../.kiro/specs/c-signals/requirements.md)、[`design.md`](../../../.kiro/specs/c-signals/design.md)、[`tasks.md`](../../../.kiro/specs/c-signals/tasks.md) 为准。
> **状态**：`draft`（随任务推进由 tasks.md 的完成记录取代，不必维护本文件）

## 1. 先读什么（按顺序）

1. [`tasks.md`](../../../.kiro/specs/c-signals/tasks.md)：进度勾选、各任务的验证项、已做任务的**完成记录**。接着做的是任务 2。
2. [`design.md`](../../../.kiro/specs/c-signals/design.md)：§4 模块划分、§6 数据模型、§7 算法、§8 失败语义、§13 决策记录、§14 未决项。
3. [`requirements.md`](../../../.kiro/specs/c-signals/requirements.md)：§1.3 R 表（对 PRD 与既有文件的偏差）、§1.4 解释、SG-1～SG-16。
4. `.kiro/steering/`（自动注入）：`data-discipline`（六条编码纪律）、`dev-ci-cadence`、`structure`、`tech`、`no-reinventing-wheels`、`server-access`。
5. 需要时再查：[C PRD v1.3](../../prd-domain-c-signals.md)（产品语义的唯一真相源；C-D15～C-D20 是 2026-11-12 订正）、[`acceptance.md`](../../../.kiro/specs/c-signals/acceptance.md)（161 余条验收，任务 13 逐条回填）。

不要通读 PRD 全文；遇到冲突再查对应章节。

## 2. 现在的状态

| 项 | 状态 |
|---|---|
| 任务 0（文档前置与闸门） | **完成**。刘学奎 2026-11-12 确认 design §14 的 13 项（第 1–5、7–10、13、15、17、18 项） |
| 任务 1（schema 与迁移） | **完成**。九张表、迁移 `drizzle/0011_c_signals_schema.sql`、`contents` 上的 `idx_contents_current_selected`、26 个 db 用例 |
| 任务 2–13 | **未开始**，下一个是任务 2（骨架、A 事实读取口、测试挂具、静态护栏） |
| 分支 | `c-signals`，从 `main@718a8a4` 起 |
| 提交 | `e6e4a84`（任务 0 文档）→ `a1c1f77`（任务 1，**已推**，CI 绿）→ `25c3a10`（任务 1 审查修订，**只在本地，未推**） |
| 本机验证 | `./scripts/verify.sh` 全绿：db 1265 通过 / 1 既有 skip、Python 18 |

**未推的 `25c3a10`**：补了 `signal_history` 的 `normalizer_version` CHECK、删了冗余索引，并**原地重新生成了迁移 0011**。`dev-ci-cadence` 规定一个 spec 只推两次，所以它留到任务 13 收尾时与其余工作一起推。远端暂时是旧版 0011，没有人在用，影响为零。

## 3. 仍未决的项（不得当作已关闭）

| design §14 | 内容 | 谁关闭 | 何时 |
|---:|---|---|---|
| 6 | `PLATFORM_TEXT_FIELDS`：各平台是否返回标题 / 正文；核对前三个平台都按「有 title / body」处理 | 实测 | **任务 3**，用 `tests/fixtures/aimaster` 逐平台核对，把结论写回 design §7.2 |
| 11 | 监控段 / 读取口 / 补算请求的 API 形状 | D 的 spec | D 开工时对齐；C 先实现并用契约测试固定 |
| 12 | 关键词归一化出口（`normalizeKeyword(raw, value.normalizerVersion)`） | D 的 spec | D 的 spec 里登记 |
| 14 | 数值起始值（扫描间隔、批量、回看窗口、并发、租约、超时等） | 运维 + 实测 | **任务 13**；写 `.env.example`，**不写代码默认值** |
| 16 | `scope_fingerprint` 格式 | `h-ai-min` | 之后 |

另有三条硬门槛：

- **`image.template` / `image.element` 不进生产启用集**，直到刘学奎对标定报告签字（任务 7 产出报告）。
- **`hbecho-signals` 桶未创建**，不要动服务器、RAM、安全组；创建要先说明并逐步得到同意（`server-access.md`）。任务 6 的真实环境验证等桶建好后做，离线测试用 fake OSS。
- **不发任何付费调用**：C 不调用 AI Master；ASR 与大模型只经 `AiGatewayPort`，默认 `DisabledAiGateway`（`activeModel()` 返回 `null`，不建任务、不发调用）。

## 4. 工作区与协作注意

- **同一个目录里还有别的会话**（目前是 D 域 spec）。未提交的文件里 `.kiro/specs/d-rule-engine/`、`.kiro/specs/rule-engine/design.md`、`HBECHO设计方案/INDEX.md` 的 D 相关行、`ui-lab/`、根目录若干 `*审查*.md` **都不是 C 的**，不要提交、不要改。
- **提交只用 `git add <具体文件>`**，不要 `git add -A` / `.`。
- **`INDEX.md` 里混有别的会话的未提交改动**。要只提交 C 的那一处：取 `git show HEAD:<path>` 的内容做精确替换，`git hash-object -w --stdin` 得到 blob，再 `git update-index --cacheinfo 100644,<blob>,<path>`；工作区文件保持原样。上次任务 1 就是这样做的。
- 若别的会话直接 `git commit`，会落在当前的 `c-signals` 分支上（同一个工作树）。开工前先 `git status`、`git branch --show-current` 确认。
- 迁移编号取**实施时的下一个空号**（当前最大是 `0011`，已被 C 占用）；别的分支可能撞号，由后合并者重新生成。

## 5. 本项目里验证过的做法（省得重新摸索）

### 命令

```bash
pnpm -s typecheck                                  # tsc --noEmit
pnpm test                                          # unit 项目（离线、禁网）
./scripts/with-test-mysql.sh pnpm exec vitest --run --project db <文件>   # 单个 db 测试，起一次性 MySQL 8.4 容器
./scripts/verify.sh                                # 完整验证，约 5–6 分钟；任务边界跑，不要每改一行就跑
pnpm db:generate --name <名字>                      # 生成迁移；verify 第 4 步要求 schema 与迁移一致
python3 scripts/check-doc-links.py && python3 scripts/check-doc-registry.py && bash scripts/check-secrets.sh   # 纯文档改动只跑这三个
```

- 在 `git worktree` 里跑测试时，`pnpm exec` 会触发依赖检查失败，改用 `./node_modules/.bin/vitest`（把主目录 `node_modules` 软链过去）。
- macOS 的 BSD `sed -i` 需要后缀参数，改文件用 python 或编辑工具，不要 `sed -i 's/...'`。

### 写 db 测试

- 用 `useTestDb()`、`expectRejected(op, "约束名")`（`tests/harness/db.ts`）；工厂在 `tests/harness/factories.ts`（`insertAccount`、`insertBatch`、`insertContent`、`insertContentSnapshot`、`sha` 等）。
- **一次写入同时违反多条 CHECK 时，MySQL 只报告其中一条**。要测某一条，必须让其余的都满足（任务 1 的用例踩过 4 次）。确实无法隔离时用 `signals-schema.db.test.ts` 里的 `expectRejectedByAny`。
- MySQL 的 CHECK 遇到 NULL 会**放行**；涉及 JSON 路径的比较用空安全的 `<=>`。
- 竞争用例不用 `Promise.all`；用显式闸门（先让持锁者停住，再启动竞争者，最后放行）。
- 默认测试离线：`FakeObjectStore`、`FakeClock`、`network-deny` 已在挂具里。

### 既有断言会被新表影响

两处按表数 / 外键规则断言的测试会随新增表变化，任务 1 已更新：`src/db/schema.db.test.ts`（“35 张 v2 表”排除清单、全库 `SET NULL` 计数现为 12）、`src/modules/master-data-import/bootstrap.db.test.ts`（排除清单）。以后再加表或外键要同步这两处。

## 6. A 域已合并代码里 C 要用的东西（来自 2026-11-11 的代码调查，已核对）

| 要什么 | 在哪 | 备注 |
|---|---|---|
| 内容 / 快照 / 评论表 | `src/db/schema/content.ts` | `contents.current_snapshot_id` / `current_snapshot_selected_at`；快照 `snapshot_status`（`building` / `finalized`）；评论**无** `parent_id` |
| 排序规则 | `src/modules/projection/current.ts` 的 `isNewer`、`selectCurrentContentSnapshot` | 特征行覆盖判断复用 `isNewer`；`logical_at` 在 `sync_batches`，要连表 |
| 媒资 | `src/db/schema/media.ts`；`src/modules/media-archive/`（`mediaKey`、`assetBySha`、`sniffImage`、`HttpCapabilityClient`、`ImageConverter`） | 读 `archived` 的原图 / 音频；`carried_forward` 不能当当前图 |
| 签名 URL / 对象存储 | `src/modules/raw-capture/ports.ts` 的 `MediaObjectStore`（`get`、`put`、`delete`、`list`、`signedGetUrl`）；`OssObjectStore` 按桶构造 | C 需要两个实例：media 桶（只读）、signals 桶（读写删） |
| 音频抽取 | `src/modules/sync-runner/video-runner.ts` | 已按「Node 传签名 URL 给 Python」实现，C 不改 |
| 指纹 | `src/modules/canonical-json`（`jcsSha256`、`sha256Utf8`） | |
| 授权写法 | `src/modules/activity-plan/authz.ts`（`assert`、`actorFromEnv`） | C 的 `SignalActor` 沿用同一结构 |
| 审计端口 | `src/modules/tracer-command/audit.ts`（`AuditSink`） | |
| CLI 模式 | `src/worker/plan-cli.ts` + `plan-main.ts` | 每个 CLI 两个文件：`*-cli.ts`（可测）+ `*-main.ts`（装配） |
| Capability 名 | `src/modules/access-control/roles.ts` | `rule.definition.manage` / `.read`、`rule.run.execute`、`data.content.read` |
| Python 服务 | `services/capability/`（`app.py`、`image.py`、`audio.py`） | 现只有 `/v1/image/normalize`、`/v1/audio/extract`；**没有 OpenCV**；匹配端点是任务 7 |

**不存在的东西**（别假设有）：finalized 事件 / 钩子；H1 AI 网关；`production_approved` 字面量（实际是 `evidenceLevel` + `activation`）；D 的任何表；`hbecho-signals` 桶。

## 7. 已知偶发失败

`src/modules/activity-plan/scale.perf.db.test.ts` 的“并发解析”用例偶发失败（`sync_batches` 更新处的事务错误，完整错误类型未取到）。它不碰 C 的表；单独重跑通常通过，干净的 `main` 上也通过。出现时先单独重跑一次再判断，不要当成 C 的回归。留给 a-activity-plan 维护者按 `tracer-flow` 的死锁重试路径核对。

## 8. 约定速查

- 每完成一个任务：在 tasks.md 勾选并写**完成记录**（日期、验证结果、与 design 的偏差、未证明的部分），本地提交（只暂存自己的文件）。
- 任务 2 开始写代码，注意：**网络 IO 期间不持有数据库事务**；成本与并发类数值**不写代码默认值**；业务代码里不出现角色名；所有 BIGINT 在 JSON / CLI 输出为十进制字符串。
- 推送：任务 13 收尾才推第二次，推之前等 `verify.sh` 全绿；合并用 `--no-ff`，CI 绿后才合 `main`。
- 修订已编号决策（如 C-D09）要走 `structure.md` 的四步：原行删除线并注明修订、全仓库搜编号、补版本记录、跑检查。
- 回复与文档用中文；不写“Great question”之类客套话。
