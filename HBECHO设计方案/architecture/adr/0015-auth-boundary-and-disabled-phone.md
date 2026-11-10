# ADR-0015 · 认证边界：better-auth 拥有 user / session，授权表自有；停用用户的登录手机号改写为墓碑值

- **状态**：accepted（2026-11-10，刘学奎确认；验证码明文取舍选 A：接受）
- **日期**：2026-11-10（实测日期）
- **决策人**：刘学奎
- **关闭**：`b-access-control` 任务 1 的出口条件（[design §6.5](../../../.kiro/specs/b-access-control/design.md)）
- **与 ADR-0005 的关系**：ADR-0005 已选 better-auth 并列出「已知坑」。本 ADR 补上它没验证的部分：库在本仓库的版本、MySQL 8.4 + Drizzle + BIGINT ID 下的真实行为，以及我们必须在库外补的几处。

## 背景

`b-access-control` 要用 better-auth 做手机号密码登录、短信验证码、15 天滑动会话，授权（Capability、DataScope）自建。设计里有九处行为标为 `library`（来自官方文档、未在本仓库验证），其中认证表 ID 是否能用 BIGINT 一旦不成立就要停下（R7）。2026-11-10 在 better-auth **1.7.18**、MySQL 8.4、Node 24 上逐条做了离线验证：`src/modules/access-control/__spike__/` 下 4 个文件、38 个用例，全部通过。验证用例保留，作为库升级的回归测试。

## 决定

采用：better-auth 1.7.18（⭐ 见 ADR-0005，MIT）+ `@better-auth/drizzle-adapter` 1.7.18（随主包安装）

**版本**：`package.json` 精确锁定 `1.7.18`（2026-11-05 发布）。同日检索到的 1.7.19 发布不足一天，被 pnpm 的 `minimumReleaseAge` 拦下，**没有加入豁免**，退回上一版。升级前重跑 `__spike__` 全部用例。

**用它做什么**：`user` / `session` / `account` / `verification` 四张表的读写；手机号 + 密码登录；短信验证码的生成、校验、尝试次数与过期；验证码重置密码（无凭据时自动建凭据，同时即「激活」）；会话的创建、15 天有效期、每日至多一次的滑动刷新、删行即撤销；`Request → Response` 的处理器。

**不用它做什么**（仍然自建，原因是库没有或做不对）：

- 授权：角色矩阵、Capability、DataScope、资源谓词、`access_users` 扩展表。库的 admin / organization 插件不用；
- 登录失败锁定（按规范化手机号计数，库只按 IP + 路径限流）；
- 发送资格校验与短信限频（库的 `send-otp` 不查用户是否存在）；
- 停用 / 恢复 / 强制下线 / 最后一个超管保护；
- 手机号格式校验的**全覆盖**（库自带的校验器只覆盖两个端点，见下）；
- 在线改号（库默认允许，我们拒绝）。

### 九项验证的结论

| # | 结论 | 说明 |
|---|---|---|
| S1 | **通过，有天花板** | `advanced.database.generateId: "serial"`；MySQL 里是 `BIGINT AUTO_INCREMENT`；库对外给出的 `user.id`、`session.id` 都是十进制**字符串**。库内部把 ID 和外键值按 JS `Number` 处理，所以精确范围是 ≤ 2^53−1（9007199254740991）。自增 ID 走不到那里；但把自增起点抬到 2^53 以上时，`createUser` 会陷入内存耗尽的异步死循环（4 GB 堆占满，进程 SIGABRT）。**规则：认证表的 ID 只能由数据库自增，不得设置 `AUTO_INCREMENT` 起点，不得写入指定 ID。** Drizzle 列用 `bigint({ mode: "bigint" })`，授权表的 `user_id` 同型，用 `BigInt(id)` 对接 |
| S2 | 通过 | 不用库的 `fields` 映射：Drizzle 表的 TS 属性名取库的字段名（camelCase），列名用 snake_case。`user.modelName = "auth_users"` 等四项配置之后，传给适配器的 `schema` 对象**必须以新模型名为键**（`auth_users: authUsers`），否则报 “model not found”。库有自带的 schema 一致性检查，缺表时在日志里报 “Drizzle schema mismatch” |
| S3 | 通过，有 5 处要补 | ① `sendOTP` 回调拿到明文码；② `allowedAttempts` / `expiresIn` / `otpLength` 可配，输错 5 次后正确的码也作废；③ 验证码重置密码对无凭据用户自动建凭据，随后可密码登录；④ `revokeSessionsOnPasswordReset: true` 在同一事务里撤销该用户全部会话；⑤ 不存在 / 无凭据 / 密码错误三种登录失败，错误码与消息一致。**要补的**见下面「必须在库外补的五处」 |
| S4 | 通过 | 全局 `hooks.before` / `hooks.after`（`createAuthMiddleware`）能在任何端点前后插入逻辑：before 可抛 `APIError` 拒绝、也可 `ctx.json(...)` 直接返回成功样式的响应而不执行库的端点；after 通过 `ctx.context.returned instanceof APIError` 区分成功与失败。因此不需要 Route Handler 包装层 |
| S5 | 通过 | `expiresIn = 15 天`、`updateAge = 1 天`：新会话 `Max-Age=1296000`；24 小时内重复读会话不写库；距上次刷新满 24 小时后第一次读刷新回 15 天，随后再读不再写。**刷新判据是 `expiresAt − expiresIn + updateAge ≤ now`，即从上次刷新起算的滚动 24 小时，不是自然日零点**（`session.mjs`）；PRD / requirements 的「自然日」措辞已于 2026-11-10 订正。`cookieCache` 关闭：删除会话行后旧 cookie 的下一次请求立即失效。`auth.api.getSession({ headers })` 可在 Route Handler 之外调用 |
| S6 | 通过，有 1 处缺口 | 把 `auth_users.phone_number` 改写为 `disabled:<用户ID>` 并删会话后：旧用户无法用原号登录；原号码可新建用户（得到新 ID）；验证码只命中新用户；恢复时原号已被占用则唯一键报 1062，未被占用可写回。库不对该列做格式校验。**缺口**：库的 `phoneNumberValidator` 只在 `sign-in/phone-number` 与 `phone-number/send-otp` 里调用，`request-password-reset`、`verify`、`reset-password` 不调用，墓碑值可以走到这三条路径（`request-password-reset` 实测会触发发送回调）。补法见下 |
| S7 | 通过 | 库要求 `email` 必填且唯一，不可为空。写入不可路由的合成值 `<随机UUID>@hbecho.invalid`；不展示、不用于找回。**不能用手机号或用户 ID 推导**：ID 在插入前未知；手机号推导会让「停用后同号新建用户」撞邮箱唯一键（实测，见 S6 同号新建用例）。design §6.2 原写的 `u<ID>@hbecho.invalid` 因此改为随机值 |
| S8 | 通过，有 1 处必须显式配置 | `auth.handler(new Request(...))` 与 `better-auth/next-js` 的 `toNextJsHandler(auth)` 在 vitest（Node，**未安装 `next`**）里都可直接调用，返回 `Set-Cookie`（`HttpOnly`、`SameSite=Lax`、`Max-Age=1296000`）。**库在 `NODE_ENV=test` 时默认关闭来源 / CSRF 检查**（`create-context.mjs`：`isTest() ? true : false`），不是生产行为。认证实例必须显式写 `advanced.disableOriginCheck: false` 并配置 `trustedOrigins`，测试也用同一份配置；显式打开后，缺 `Origin` 或来自未受信 `Origin` 的带 cookie 的 POST 被拒（4xx） |
| S9 | 通过，有 1 处要调 | 请求限流可启用，按「IP + 路径」计数，同一手机号换 IP 不被限；因此账号锁定仍须自建（与 B-D14 一致，不冲突）。**手机号插件自带 `/phone-number*` 每 60 秒 10 次**，公司出口 NAT 后多人同时激活会被误伤；用 `rateLimit.customRules` 对 `/phone-number/send-otp` 等路径调高（实测可生效）。洪水兜底仍交给 Nginx（ADR-0006） |

### 必须在库外补的五处

1. **统一的手机号格式校验**：全局 `hooks.before` 对 `/sign-in/phone-number` 与所有 `/phone-number*` 路径，用 `src/modules/phone/` 的 `cn-mobile.v1` 校验 `body.phoneNumber`，不合格抛 `INVALID_PHONE_NUMBER`。实测可同时挡住 `request-password-reset`、`verify`、`reset-password`、`send-otp` 上的墓碑值，且不写 `verification`、不触发发送。
2. **拒绝在线改号**：库的 `verify` 带 `updatePhoneNumber: true` 且已登录时，凭新号码的验证码即可改号，默认放行。`hooks.before` 对该参数返回 403。与 PRD「手机号变更只做删旧建新」一致。
3. **发送资格校验**：`send-otp` 与 `request-password-reset` 不查用户是否存在，对任何号码都写一行 `verification`。`hooks.before` 在端点执行前判断「规范化 → 用户存在且 pending / active」，不满足则 `ctx.json(...)` 直接返回成功样式的响应，**响应体必须与该端点的真实成功响应同形**：`send-otp` 是 `{ message: "code sent" }`，`request-password-reset` 是 `{ status: true }`（形状不同会让「存在 / 不存在」可区分），不写库、不回调发送，并记 `suppressed`。
4. **验证码登录不得放过待激活用户**：`verify` 对已存在的用户直接建会话，不看 `access_users.status`。`hooks.before` 对 `status != active` 的用户拒绝（待激活只能走重置密码路径激活）。
5. **激活后置 `active`**：`hooks.after` 在 `/phone-number/reset-password` 成功后，若 `access_users.status = pending_activation` 则置 `active`、写 `activated_at` 与审计。

### 验证码在库里是明文（2026-11-10 刘学奎选 A：接受）

`auth_verifications.value` 保存 `<验证码>:<已输错次数>`，**明文，库没有哈希选项**。窗口是 5 分钟（`expiresIn = 300`），过期行由库在任何一次验证码查找时顺带删除（实测，`verification.disableCleanup` 未开），不依赖定时任务。风险：能读这张表的人在 5 分钟内可以接管正在激活 / 重置的账号。

| 选项 | 代价 |
|---|---|
| **A（已选）：接受** | 无额外代码。补偿：应用数据库账号之外无人可读（ADR-0002 自建 MySQL，部署账号最小权限，v2 §19 第 9 项）；审计与日志永不含验证码（已是 AX 验收项）；不对库开 `disableCleanup` |
| B：绕开库的 `send-otp`，自建发码端点、哈希存储，库只负责会话与密码 | 要自建发送、校验、次数、过期，等于重写手机号插件的一半，且丢掉库升级的修复；与「不造轮子」冲突 |

## 备选与不选原因

| 候选 | 不选原因 |
|---|---|
| 认证表 ID 用字符串 / UUID | R7：`data_quality_issues.entity_id` 等处是 BIGINT，且全仓库内部 ID 都是 BIGINT；S1 证明库能在自增 BIGINT 上工作，没有理由放弃 |
| 库的 `fields` 映射改列名 | 增加一层映射，且 Drizzle 属性名与列名分离后更难核对；直接用 Drizzle 的列名参数即可（S2） |
| Route Handler 包装层拦截端点 | 全局 `hooks.before / after` 已够用，少一层路由代码 |
| 墓碑方案换成「停用用户保留原号 + 每个查询加 `status` 条件」 | 库自己的查找（登录、发码、重置）不带我们的条件，必须逐个端点打补丁；墓碑方案让「登录只匹配非停用记录」由数据结构保证 |
| 关闭库的请求限流，全部交给 Nginx | 库限流可用，只需调高 `/phone-number*` 的 `customRules`；Nginx 仍是洪水兜底 |

## 后果

- `b-access-control` 任务 2 的认证实例必须包含：`generateId: "serial"`、四个 `modelName`、以新模型名为键的 `schema`、`advanced.disableOriginCheck: false` 与 `trustedOrigins`、`session.expiresIn = 15 天 / updateAge = 1 天 / cookieCache 关闭`、`emailAndPassword.revokeSessionsOnPasswordReset: true`、手机号插件 `expiresIn = 300 / allowedAttempts = 5`、`/phone-number*` 的 `customRules`、以及上面「库外补的五处」的 `hooks`；
- 任务 2 落地真实 `auth_*` 迁移后，`__spike__/spike-auth.ts` 里的验证用 DDL 必须改为引用真实 schema 并删除。为防误删，`createSpikeTables` / `dropSpikeTables` 在发现没有 `COMMENT='hbecho-spike'` 标记的同名表时直接抛错，不执行 DROP；
- `package.json` 精确锁定 `better-auth@1.7.18`（不加 `^`）；升级需重跑 `__spike__` 全部用例并更新本 ADR 的结论；
- `access maintain` **不需要**清理 `auth_verifications`（库自带）；仍需清理 `access_sms_sends`、`access_login_failures`、`access_bootstrap_tokens`（design §7.10）；
- 验证码明文问题按选项 A 处理（已确认）；
- ADR-0005 已知坑 4（`reset-password` 无凭据时自动建行）已被验证为真；已知坑 5（限流）无变化。

## 现在谁在守

- `src/modules/access-control/__spike__/*.db.test.ts`（38 个用例，随 `pnpm test:db` 与 CI 运行）；
- 任务 2 的认证实例装配测试与任务 5 的流程测试；
- 代码审查：认证表 ID 不得人为设置；认证实例不得省略 `disableOriginCheck: false`。
