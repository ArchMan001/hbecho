# Data Foundation Tracer Requirements

> **状态**：`draft`  
> **模式**：Design-First  
> **实现状态**：仅定义可验收需求；尚未执行 [`tasks.md`](tasks.md)  
> **更新日期**：2026-09-02

## 1. Introduction

`data-foundation-tracer` 证明数据底座的第一条纵向链路：一个已授权的内部调用方提交 `MediaStaff + 平台 + 主页入口` 后，系统能够追踪到稳定的 `ExternalAccount`，建立或复用 `AccountAssignment`，保存主页快照，完整处理首个已返回列表页，建立后续同步检查点，并异步归档头像、背景图和内容封面。

首版验收平台是抖音和小红书。AI Master 只是本 Feature 内部的供应商 Adapter；需求不建设通用供应商 API 平台，也不宣称支持尚未实测的平台或 action。

### 1.1 Authority

冲突时按以下顺序裁决：

1. [`CONTEXT.md`](../../../CONTEXT.md)：领域词汇、身份、归属、发现、快照、媒资和时间不变量；
2. [`database-design-v2.md`](../../../docs/domains/data-foundation/database-design-v2.md)：数据底座当前实施基线；
3. [AI Master V1.2 文档](<../../../aimaster接口文档/FieldShortcut A Master API 开发文档 V1.2.md>)：供应商声明的候选合同；
4. 已保存的抖音与小红书 [`raw3` 证据](../../../aimaster接口文档/测试结果/raw3/)：已观察响应形态，但它们是解析后 JSON 包络，不是原始 HTTP bytes；
5. 本 Requirements 与 [`design.md`](design.md)：本 Feature 的需求和设计；
6. `docs/archive/` 及 `项目历史文档/`：仅作历史输入，不能覆盖前述来源。

供应商文档与实测证据冲突时，不得静默猜测；应能力门控、记录差异并保留为未决合同。

## 2. Scope

### 2.1 In scope

- 受控提交、幂等根任务和本地状态查询；
- 主页入口解析，单个根任务最多三次解析尝试；
- AI Master `media_user_info`、`user_video_list` 以及异步任务查询；
- 每次供应商调用 raw-before-parse；
- 平台命名空间下的账号身份、标识绑定和冲突处理；
- `MediaStaff` 到 `ExternalAccount` 的历史归属；
- 主页快照、完整首屏内容快照和 `ContentDiscovery`；
- 类型保真的首个检查点；
- 头像、背景图和封面正式媒资的异步归档进度；
- 离线 fixture 验收，以及独立、人工批准、预算受限的真实 smoke。

### 2.2 Out of scope

- 第二页及以后完整增量同步策略、周期调度和全平台普适爬取；
- 内容详情、评论、OCR、ASR、活动考核、指标、看板和导出；
- 通用 AI Master 代理、管理后台或供应商能力市场；
- 重建品牌、组织、门店、`MediaStaff`、`ExternalAccount` 或媒资的平行主档；
- 冻结应用框架、ORM、迁移工具、队列或部署拓扑；
- 解决 `User ↔ MediaStaff` 的最终产品映射；首个实现可由用途受限的内部主体调用。

## 3. Glossary

| 术语 | 本 Spec 中的含义 |
|---|---|
| `root_task_id` | 一次 tracer 工作流的稳定内部 ID；对外以十进制字符串返回 |
| Home locator | 用户提交的主页 URL、平台分享文本或其他受支持入口的原始文本 |
| Parse attempt | 将 Home locator 解析为供应商可接受主页入口的一次有记录尝试 |
| `ProviderCall` | 一次提交、轮询、分页或重试供应商请求的事实 |
| ODS payload | 在解析前保存于私有对象存储的请求/响应原始 bytes 或传输错误证据 |
| Identifier namespace | 平台内某类外部标识的语义空间；相同字符串跨 namespace 不自动等同 |
| Dominant list author | 同一完整列表页中出现次数唯一最高、且通过版本化 policy 的非空作者 ID |
| Complete returned page | 一次成功列表响应已经返回的全部条目；不能按本地目标数量截断 |
| Initial checkpoint | 首个完整返回页投影成功后建立的 v2 长期 cursor/anchor/version；`has_more` 与页覆盖摘要保留在一年期任务/调用 lineage |
| Formal media asset | 下载完整 bytes、计算 SHA-256 并验证后形成的长期媒资身份 |
| Capability gate | 对平台、action、同步/异步模式和解析方式的已验证能力配置 |

## 4. Requirements

### Requirement 1: Authorized and idempotent submission

**User Story:** As an authorized internal operator, I want to submit one account tracer command safely, so that retries cannot create duplicate workflows or paid calls.

#### Acceptance Criteria

1. WHEN an authorized caller submits `platform`, `media_staff_id`, `home_locator`, `idempotency_key` and optional `initial_content_limit`, THE Tracer SHALL persist one canonical command and return one `root_task_id` as a decimal string.
2. WHEN the same caller repeats the same canonical payload with the same `idempotency_key` within the one-year root-task retention window, THE Tracer SHALL return the original `root_task_id` and SHALL NOT create duplicate workflow facts or supplier calls.
3. WHEN the same caller reuses an `idempotency_key` with a different canonical payload within that retention window, THE Tracer SHALL reject the request with a stable idempotency-conflict reason.
4. IF the caller lacks the required capability or target scope, THEN THE Tracer SHALL reject the command before any supplier or media request.
5. IF the platform or required action is not enabled by a verified capability, THEN THE Tracer SHALL reject the command as unsupported rather than attempting a best-effort call.
6. WHEN a command is accepted or rejected, THE Tracer SHALL append an audit-safe outcome without recording credentials or complete sensitive payloads.
7. WHEN the one-year root-task retention window has expired, THE Tracer MAY accept reuse of the caller key as a new command and SHALL NOT promise the old root status; stable account, assignment, snapshot and content idempotency SHALL still prevent duplicate business facts.

### Requirement 2: Raw-before-parse for every supplier call

**User Story:** As a data steward, I want every supplier interaction captured before interpretation, so that parsing defects and contract drift remain auditable.

#### Acceptance Criteria

1. BEFORE the Tracer sends a supplier submission, poll, page request or retry, THE Tracer SHALL create a durable `ProviderCall` intent and persist the exact request body bytes in private ODS.
2. WHEN the Tracer performs the prepared supplier interaction, THE Tracer SHALL record request action, expected response action, attempt, timing and correlation metadata on that distinct ProviderCall.
3. WHEN a supplier response body is received, THE Tracer SHALL durably store the exact received bytes in private ODS object storage before any versioned Adapter parses them.
4. WHEN a transport fails before a complete response body exists, THE Tracer SHALL persist a structured transport-error artifact before classifying or retrying the call.
5. IF request-intent, response/error ODS persistence or integrity verification fails, THEN THE Tracer SHALL NOT parse or project that supplier result.
6. WHEN a payload is parsed, THE Tracer SHALL record the ODS reference, byte SHA-256 and Adapter version used for that interpretation.
7. WHEN a sent call loses its terminal result, THE Tracer SHALL mark the outcome ambiguous and SHALL NOT blindly retry without provider idempotency or reconciliation evidence.
8. THE Tracer SHALL retain ProviderCall, task and ODS payload facts for one year and SHALL keep credentials and authorization headers out of retained bodies and metadata.
9. THE Tracer SHALL treat existing `raw3` JSON files as parsed evidence only and SHALL NOT claim they prove production raw-before-parse behavior.

### Requirement 3: Bounded home-locator parsing

**User Story:** As an operator, I want shared or redirected homepage inputs resolved predictably, so that malformed inputs cannot cause unbounded calls.

#### Acceptance Criteria

1. WHEN a command starts, THE Tracer SHALL preserve the original `home_locator` text and select only a platform-approved parsing strategy.
2. WHEN parsing requires multiple attempts, THE Tracer SHALL perform at most three parse attempts for the root task and SHALL stop after the first verified homepage locator.
3. WHEN a parse attempt performs network IO, THE Tracer SHALL represent it as a ProviderCall-equivalent captured interaction and SHALL NOT hold a database transaction during that IO.
4. IF a parsing result belongs to a different platform or unsupported locator kind, THEN THE Tracer SHALL reject that result and SHALL NOT silently switch platforms.
5. WHEN the same root task resumes, THE Tracer SHALL reuse successful parse evidence rather than repeating a paid or network attempt.
6. IF locator resolution already produced a captured terminal `media_user_info` payload for the target homepage, THEN THE Tracer SHALL reuse that payload for profile projection and SHALL NOT issue a duplicate profile request; otherwise the configured strategy SHALL permit exactly one separately recorded profile fetch for that stage.

### Requirement 4: No business identity after unresolved parsing

**User Story:** As a data owner, I want failed locator resolution to leave no partial business identity, so that an unverified homepage cannot pollute master data.

#### Acceptance Criteria

1. IF all three parse attempts fail or no verified locator is produced, THEN THE Tracer SHALL end in a terminal parse-failed state with a stable reason and attempt summary.
2. IF Requirement 4.1 applies, THEN THE Tracer SHALL NOT create an `ExternalAccount`, account identifier, `AccountAssignment`, profile snapshot, content snapshot, `ContentDiscovery` or checkpoint.
3. WHEN parse evidence was captured before terminal failure, THE Tracer SHALL retain that operational evidence according to ODS retention without promoting it to business master data.

### Requirement 5: Namespaced, text-preserving account identity

**User Story:** As a data model owner, I want external identifiers interpreted by platform and namespace, so that look-alike IDs are not incorrectly merged.

#### Acceptance Criteria

1. WHEN the supplier returns an external ID, THE Tracer SHALL preserve its original textual representation and SHALL NOT coerce it through a JavaScript-safe integer or other lossy numeric type.
2. WHEN an identifier is stored or looked up, THE Tracer SHALL include platform and identifier namespace; a hash hit SHALL be accepted only after exact original-text comparison.
3. WHEN the same payload explicitly relates multiple official identifiers, THE Tracer SHALL bind them to one `ExternalAccount` with the observed binding method and confidence.
4. WHEN identifiers originate from different namespaces without an approved binding rule, THE Tracer SHALL keep them distinct even if their strings match.
5. WHEN a field is real `0`, absent, explicit `null` or invalid, THE Tracer SHALL preserve those four different states through Adapter output and projection.
6. THE Tracer SHALL make identity mutation idempotent; replaying the same observed identifier SHALL update observation metadata without creating duplicate accounts or identifiers.

### Requirement 6: Xiaohongshu dominant-author binding

**User Story:** As a data model owner, I want the observed Xiaohongshu profile ID and list-author ID linked only with evidence, so that two namespaces can describe one homepage without unsafe guessing.

#### Acceptance Criteria

1. WHEN a complete Xiaohongshu first page has one non-empty author ID with a uniquely highest occurrence count and that distribution passes the versioned dominant-author policy, THE Tracer SHALL bind that list-author identifier to the profile `ExternalAccount` using the dedicated author namespace and `dominant_list_author` evidence.
2. IF the highest author count is tied, empty or rejected by the versioned dominant-author policy, THEN THE Tracer SHALL NOT guess a binding and SHALL create a data-quality issue with evidence counts.
3. WHEN minority authors appear on the same page, THE Tracer SHALL preserve them on their returned content facts but SHALL NOT create `ExternalAccount` records for them.
4. GIVEN the saved Hitachi Xiaohongshu fixtures, WHEN the page is processed, THE Tracer SHALL keep profile ID `49328995493` and dominant list-author ID `5decba2300000000010007e1` in different namespaces while binding both to the same target `ExternalAccount`.
5. WHEN a dominant-author decision is made or rejected, THE Tracer SHALL retain the policy version, exact author counts, denominator and rejection reason in traceable evidence.

### Requirement 7: Assignment creation without ownership theft

**User Story:** As a business owner, I want tracer assignment to respect existing ownership, so that ingestion cannot silently transfer an account between staff members.

#### Acceptance Criteria

1. WHEN a resolved account has no conflicting effective assignment, THE Tracer SHALL create or reuse an `AccountAssignment` to the submitted `MediaStaff` with a traceable start and source.
2. WHEN the same effective assignment already exists, THE Tracer SHALL reuse it idempotently rather than append an equivalent duplicate.
3. IF the account is effectively assigned to a different `MediaStaff`, THEN THE Tracer SHALL preserve the existing assignment, SHALL NOT auto-close or overwrite it, and SHALL expose an assignment-conflict outcome for authorized resolution.
4. WHEN an assignment conflict occurs, THE Tracer SHALL retain supplier evidence and identity observations but SHALL NOT represent the submitted `MediaStaff` as the account owner.
5. THE Tracer SHALL NOT create a parallel natural-person `Staff`, platform-account or account-dealer binding model.

### Requirement 8: Finalized homepage snapshot

**User Story:** As a downstream consumer, I want one immutable homepage observation, so that later rules and metrics can cite what the tracer actually saw.

#### Acceptance Criteria

1. WHEN `media_user_info` succeeds and identity is resolved, THE Tracer SHALL project one immutable profile snapshot linked to the exact ProviderCall, ODS payload, Adapter version, account and observation time.
2. WHEN optional profile fields are absent, null, invalid or zero, THE Tracer SHALL preserve their ValueState rather than invent defaults.
3. WHEN a duplicate workflow observes the same provider fact, THE Tracer SHALL reuse or deduplicate it according to the v2 identity while retaining call lineage.
4. WHEN a newer run finalizes before an older delayed run, THE Tracer SHALL use fencing and observation ordering so the delayed run cannot move a current pointer backward.
5. WHEN the profile contains avatar or background candidates, THE Tracer SHALL create media references without treating temporary URLs as formal asset identity.

### Requirement 9: Complete first-page processing

**User Story:** As a downstream consumer, I want the complete page already returned by the provider, so that local limits do not silently discard valid observations.

#### Acceptance Criteria

1. WHEN `user_video_list` returns a successful page, THE Tracer SHALL inspect and project every returned entry before deciding whether to request another page or stop.
2. THE Tracer SHALL apply `initial_content_limit` only between complete page requests; it SHALL NOT slice an already returned page.
3. WHEN multiple entries in the same account list and batch refer to one platform content identity, THE Tracer SHALL process every entry, SHALL keep one v2 `ContentDiscovery` for that batch + assignment + content, and SHALL retain duplicate positions/counts in page or ProviderCall evidence with a quality summary; entries discovered through different assignments SHALL remain separate discoveries.
4. WHEN each entry is projected, THE Tracer SHALL link its content snapshot and discovery to the target account, assignment context, batch/page and exact ProviderCall lineage.
5. GIVEN the saved Xiaohongshu Hitachi list fixture with 21 entries, WHEN `initial_content_limit <= 20`, THE Tracer SHALL still process all 21 returned entries and SHALL NOT request continuation solely to compensate for local slicing.

### Requirement 10: Type-preserving initial checkpoint

**User Story:** As a synchronization owner, I want an exact initial checkpoint after the first page, so that later pagination can resume without cursor corruption or lost observations.

#### Acceptance Criteria

1. WHEN every entry in a returned page has reached its required structured terminal state, THE Tracer SHALL atomically establish or advance the v2 checkpoint for that target account, provider, action and scope.
2. The long-lived checkpoint SHALL preserve the type-safe `cursor_envelope`, cursor hash, anchor/high-watermark semantics, long-lived batch reference, continuity state, monotonic version and update time defined by v2.
3. The one-year task/ProviderCall lineage SHALL preserve page count, processed-entry count, `has_more`, source task/call and Adapter version for operational replay; expiration of that lineage SHALL NOT invalidate the long-lived checkpoint or structured business facts.
4. THE Tracer SHALL NOT coerce an integer cursor to string or a string cursor to integer for storage, comparison or subsequent requests.
5. IF any required page entry fails projection, THEN THE Tracer SHALL NOT advance the durable checkpoint beyond that page.
6. WHEN an older fenced worker finishes after a newer checkpoint version, THE Tracer SHALL reject the stale advancement.
7. GIVEN the saved fixtures, THE Tracer SHALL preserve the Douyin `max_cursor` as integer and the Xiaohongshu `max_cursor` as string.

### Requirement 11: Returned foreign-author content without account creation

**User Story:** As a content analyst, I want co-created or foreign-authored list entries preserved, so that homepage coverage is complete without inventing monitored accounts.

#### Acceptance Criteria

1. WHEN a returned entry author differs from the target account identity, THE Tracer SHALL still persist the content snapshot and its discovery from the target homepage list.
2. WHEN Requirement 11.1 applies, THE Tracer SHALL preserve the returned author identifier as an observed content fact in its namespace but SHALL NOT create or assign an `ExternalAccount` for that author from list evidence alone.
3. A well-formed differing author on a target homepage list SHALL NOT by itself be classified as a data-quality failure; malformed or ambiguous identity data MAY be classified separately.
4. GIVEN the saved Douyin fixture, THE Tracer SHALL resolve target account `HITACHI1`, process all 20 returned entries, preserve the entry authored by `HITACHI2023`, and SHALL NOT create a second ExternalAccount for `HITACHI2023`.

### Requirement 12: Asynchronous formal-media archiving

**User Story:** As an asset consumer, I want referenced profile and cover media archived formally, so that expiring provider URLs do not become long-term identity.

#### Acceptance Criteria

1. WHEN profile or list projection yields avatar, background or cover candidates, THE Tracer SHALL create versioned media references tied to their source snapshot and semantic role.
2. WHEN structured snapshots and checkpoint are committed, THE Tracer SHALL be allowed to finish the root structured result before media downloads complete and SHALL expose separate media progress.
3. WHEN media is downloaded, THE Tracer SHALL archive complete bytes to private storage, compute full-byte SHA-256, verify integrity and use that digest as the formal deduplication identity.
4. THE Tracer SHALL NOT use a temporary URL as `MediaAsset` identity and SHALL NOT write long-lived signed URLs into business facts.
5. IF a media download fails or its URL expires, THEN THE Tracer SHALL preserve the structured snapshot, classify media state separately and retry only under bounded policy.
6. WHEN tests run by default, THE Tracer SHALL use fake OSS and SHALL NOT download network media.

### Requirement 13: Capability-driven synchronous and asynchronous supplier execution

**User Story:** As an integration owner, I want supplier execution selected from verified capabilities, so that production does not assume one unproven mode.

#### Acceptance Criteria

1. THE Tracer SHALL use AI Master only through `POST /openapi/v1/media_user_info`, `POST /openapi/v1/user_video_list`, and, when required, `GET /openapi/v1/tasks/{task_id}`.
2. WHEN an action is configured as verified synchronous, THE Tracer SHALL capture and parse its terminal submission response without unnecessary polling.
3. WHEN an action is configured as verified asynchronous, THE Tracer SHALL capture the submission separately, persist the provider task identifier, and capture every poll as a distinct ProviderCall until a terminal result or bounded timeout.
4. THE Tracer SHALL NOT hard-code `async=false` or `async=true` as a production-wide strategy.
5. IF the requested platform/action/mode combination lacks the required evidence level or environment approval, THEN THE Tracer SHALL fail capability gating before a paid request.
6. THE Tracer SHALL distinguish supplier-declared, fixture-observed, smoke-verified and production-enabled states; fixture evidence alone SHALL NOT enable a production tuple.
7. THE Tracer SHALL NOT infer asynchronous correctness solely from existing `raw3` evidence, because all saved probes used `async=false`.

### Requirement 14: Explicit failure, retry and recovery semantics

**User Story:** As an operator, I want failures classified and recoverable, so that technical errors never masquerade as absent business data.

#### Acceptance Criteria

1. WHEN a failure occurs, THE Tracer SHALL classify it at least as input, authorization, unsupported capability, provider authentication, quota/rate limit, transport, raw persistence, schema/parse, identity ambiguity, assignment conflict, structured projection or media failure.
2. THE Tracer SHALL NOT translate transport, raw-persistence, parse, schema, storage or timeout failures into an empty profile, empty list or business-level “not found”.
3. WHEN a failure is retryable and the previous remote outcome is known, THE Tracer SHALL apply bounded attempts and backoff while creating a new ProviderCall for each supplier attempt; an ambiguous sent call SHALL require provider idempotency or reconciliation safety evidence before any retry, and correlation IDs alone SHALL NOT terminalize it. WHEN reconciliation determines the outcome, THE Tracer SHALL reference a distinct captured terminal ProviderCall for the same logical remote effect and SHALL validate its versioned success/failure mapping before changing the original ambiguous call.
4. WHEN a failure is terminal, THE Tracer SHALL retain completed immutable facts, mark incomplete stages explicitly and avoid advancing an unearned checkpoint.
5. WHEN a workflow is resumed after process loss, THE Tracer SHALL continue from durable stage facts and SHALL NOT repeat completed paid effects.
6. WHEN cancellation is requested, THE Tracer SHALL prevent new paid calls and use fencing to reject late writes while retaining audit and evidence; IF a durable ProviderCall intent has not entered `in_flight`, THEN THE Tracer SHALL close it as `terminal/not_sent` rather than leave a sendable prepared intent.

### Requirement 15: Local, redacted status query

**User Story:** As an operator, I want one local status view, so that I can understand identity, structured progress, media progress and failure without causing more supplier cost.

#### Acceptance Criteria

1. WHEN an authorized caller queries `root_task_id`, THE Tracer SHALL answer only from local workflow and data-foundation facts and SHALL NOT call AI Master or media origins.
2. THE status SHALL expose root state, stage states, attempts, target account and assignment references when authorized, profile/list/checkpoint counts, media totals by state, warnings, stable failure reason and relevant timestamps.
3. THE status SHALL distinguish structured success with media pending, complete success, blocked conflict, retry wait, terminal failure and cancellation.
4. THE status SHALL redact credentials, raw payload bodies, complete private object keys, temporary URLs and unauthorized business identifiers.
5. WHEN `root_task_id` is unknown, expired from the one-year task retention window or outside caller scope, THE Tracer SHALL return a non-disclosing not-found/expired/denied result according to access policy and SHALL NOT reconstruct operational status from unrelated long-lived business facts.

### Requirement 16: Offline-by-default fixture verification

**User Story:** As a developer, I want deterministic offline verification, so that ordinary development and CI never depend on paid or mutable supplier behavior.

#### Acceptance Criteria

1. WHEN the default verification suite runs, THE Tracer SHALL block network access and use fixture transport, fake clock, fake leases and fake OSS.
2. THE default suite SHALL NOT require an AI Master credential and SHALL fail if a real supplier or media request is attempted.
3. The Douyin fixture acceptance SHALL assert target account `HITACHI1`, 20 processed entries, preserved foreign author `HITACHI2023`, no account creation for that author, and integer cursor type.
4. The Xiaohongshu fixture acceptance SHALL assert profile ID `49328995493`, dominant-author ID `5decba2300000000010007e1` in a different namespace on the same account, 21 processed entries, and string cursor type.
5. Offline verification SHALL cover ODS-before-parse ordering, duplicate submission, resume, stale fencing, assignment conflict, ambiguous dominant author, cursor type and media failure independently of real network behavior.

### Requirement 17: Explicitly approved paid smoke

**User Story:** As an integration owner, I want a narrowly controlled real smoke path, so that external-contract health can be checked without accidental spend or data leakage.

#### Acceptance Criteria

1. THE paid smoke SHALL be excluded from default tests and CI and SHALL require human approval plus an explicit runtime switch.
2. BEFORE the first call, THE smoke SHALL require an allowlisted platform/action/locator set, a fixed maximum call count or cost budget, and a valid secret supplied outside source control.
3. WHEN the budget, deadline or call limit is reached, THE smoke SHALL stop before issuing another supplier call.
4. WHEN the smoke completes or aborts, THE Tracer SHALL emit an audit summary containing action, counts, latency, bytes, estimated cost, result category and retained evidence references without secrets or full payloads.
5. A successful smoke SHALL validate only the exercised platform/action/mode and SHALL NOT automatically enable untested capabilities.

### Requirement 18: Leases, fencing and monotonic publication

**User Story:** As a platform operator, I want concurrent and delayed workers contained, so that retries cannot corrupt current state or checkpoints.

#### Acceptance Criteria

1. WHEN a worker claims a mutable stage, THE Tracer SHALL use a time-bounded lease and monotonically increasing fencing token or an equivalent stale-writer guard.
2. IF a lease expires or a higher fencing token exists, THEN the stale worker SHALL NOT publish a profile current pointer, list completion, checkpoint, assignment mutation or media terminal state.
3. WHEN two workers replay the same logical effect, THE Tracer SHALL use stable idempotency keys so at most one business fact is created while both attempts remain observable.
4. WHEN an older batch arrives after a newer finalized observation, THE Tracer SHALL preserve the older immutable history but SHALL NOT move current state backward.
5. THE Tracer SHALL NOT hold a database transaction while waiting for supplier or media network IO.

## 5. Requirement-level completion boundary

This Requirements document is satisfied only when every SHALL above has an executable acceptance check or an explicitly approved manual smoke check. A successful HTTP response alone is insufficient: identity, assignment, complete-page cardinality, cursor type, ODS ordering, checkpoint safety, media state and no-extra-account invariants must all be observed.