# B 访问控制（b-access-control）· 验收

> **状态**：`draft`
>
> **需求**：[`requirements.md`](requirements.md)
>
> **设计**：[`design.md`](design.md)
>
> **任务**：[`tasks.md`](tasks.md)
>
> **所属域**：B 访问控制 · **目录命名**：`b-access-control`，符合 `<代号>-<切片>`
>
> **上游 PRD**：[`prd-domain-b-access-control.md`](../../../HBECHO设计方案/prd-domain-b-access-control.md) v1.21 §14（B1–B8 与「2026-11-02 盘问新增验收」）
>
> **最近核对**：2026-11-06
>
> **更新日期**：2026-11-10（任务 1–12 实施完成，逐条结果见下；人工项与环境项的状态以各自表为准）

## 怎么用

- `[自动]`：可在离线测试或本机命令中判定；命令与断言写在条目里。
- `[手工]`：需要人在 CLI 输出或表格软件中看，写明谁看、看什么、检查什么。
- `[环境]`：依赖测试机、真实服务或外部审批，不能在本机离线判定；标明当前状态。
- 每条对应 requirements 的 `AX-n`；没有「看一眼就行」的条目。
- 需要 MySQL 与真实 better-auth 的自动项写成 `*.db.test.ts`（`pnpm test:db`），其余是 `unit` project（`pnpm test`）；入口是 `./scripts/verify.sh`。
- 页面验收见文末「页面验收（ui-foundation §9）」；本 spec 的 AX 验收项仍只覆盖 Module / CLI / 认证端点。
- **真实短信发送不是自动验收**，见 `[环境]` 组。

## 逐条结果
2026-11-10。方法：先由一个独立的只读审计逐行对照测试（只看断言，不看标题），得出 125 行已覆盖、43 行部分、11 行缺失、3 行不可离线判定；随后补了 `acceptance-gaps.db.test.ts` 等并订正了 5 处规格措辞。下面是**补完后的诚实状态**：通过 = 有测试断言了该行的预期；「部分」写明还缺什么；没有把任何未运行的项写成通过。

| 组 | 结果 | 主要测试文件 |
|---|---|---|
| A 认证与会话 | A1–A13 通过（A1–A3、A12 在 `acceptance-gaps` 用生产配置补测；A11 = 端点 404 + 静态：CLI / 管理函数无密码） | `http.db`、`authenticate.db`、`auth-flows.db`、`acceptance-gaps`、`acceptance-boundaries` |
| B 开户、激活、首个超管 | B1–B13 通过（B1 在 `acceptance-gaps`；B7 订正措辞） | `users/bootstrap.db`、`users/admin.db`、`auth-flows.db`、`acceptance-gaps` |
| C 登录保护与短信 | C1–C5、C8–C9、C11–C12、C14–C16、C19 通过；C10 补了到期时间 = 创建 + 300 秒；**部分**：C6 / C7（状态不变、无 IP 列只有间接证据）、C13（被抑制请求计入每日上限未单测）、C17（未单测「纯小写 8 位通过」）、C18（日志未扫，审计已扫） | `auth-flows.db`、`linkage.db`、`config.test`、`sms-aliyun.test`、`acceptance-gaps` |
| D 用户生命周期 | D1–D13、D15–D17 通过（D6 用触发器注入墓碑失败；D7 补了不变式；D15 补了流程）；**部分**：D14（并发互停恰好一个成功 + 陈旧上下文顺序交错，没有「持锁者停在 hook」的确定性交错） | `users/shared.db`、`users/admin.db`、`linkage.db`、`authenticate.db`、`acceptance-gaps`、`acceptance-boundaries` |
| E Capability 与授权入口 | E1、E2、E4、E5、E6、E7、E9–E14、E16、E17、E18 通过（E6 补了 HTTP 映射；E9 补了 `monitoringLevelPredicate`；E18 逐函数 forbidden）；**部分**：E3（只有 `role_invalid`，没有多角色输入）、E8（谓词体由 A 域提供，B 侧用测试谓词）、E15（总部导入越品牌行被拒在 `import.db` 的 H5 覆盖，master-data 侧的端到端不在 B）、E19（Capability 层通过；没有以 `service:plan-worker` 实跑 supplement） | `roles.test`、`authorize.test`、`grants.test`、`adapters.db`、`acceptance-gaps`、`acceptance-boundaries` |
| F DataScope 与资源策略 | F1–F4、F7–F13 通过；**部分**：F5（缺 `ambiguous` 多条绑定用例）、F6（只测到门店级，未测同店两专员互不可见）；**依赖所属域，B 内无法验证**：F14（人员级别过滤，需要课程资源）、F15（改绑后的历史快照，需要 identity / projection）、F16（手机号随行返回，需要列表资源） | `scope.test`、`scope.db`、`authorize.test`、`authenticate.db` |
| G 管理范围与授权变更 | G1–G13 通过（G10 补了 `changeAccess` / `restore` / 导入确认的审计失败回滚）；**部分**：G14（同 D14） | `users/admin.db`、`grants.test`、`users/import.db`、`acceptance-gaps` |
| H 用户批量导入 | H1–H17 通过（H5 补了 `scope_exceeds_boundary`；H9 订正措辞；H13 补了列、范围与 `data.export` 的断言） | `users/import.db`、`users/import.perf.db`、`access-cli.db`、`acceptance-gaps` |
| I 数据出口 | I1–I14 通过（I14 改为「审计总数不变」的负向断言） | `egress.db`、`acceptance-gaps` |
| J 审计 | J3–J8、J10、J11 通过（J6、J11 静态；J8 补了授权变更 / 恢复 / 导入）；**部分**：J1（没有独立的「会话撤销」事件，实现里没有该事件）、J2（导入整行原文不入审计只有间接证据）、J9（未断言 pino 有记录）、J12（`fromPlanAudit` 只用了一个假定形状的事件，等 A 落地用其夹具） | `audit.db`、`db/access-schema.db`、`acceptance-gaps` |
| K 对既有模块的接入与入口 | K1–K5、K7–K9、K11、K13–K15 通过（K2、K8、K13 补实现 / 订正后）；**部分**：K10（直接调函数而非路由文件）、K12（CLI 层缺项键名没测）；**不可离线判定**：K6（靠既有测试一个断言未改 + git diff）、K16（`pnpm typecheck` 在 `verify.sh` 第 2 步） | `adapters.db`、`access-cli.db`、`audit-wiring.db`、`http.db`、`acceptance-boundaries`、`acceptance-gaps` |
| L 离线、一致性与边界 | L1、L2、L4、L5、L6、L7、L8、L10 通过（L7 = 并发创建同号恰好一个成功，另一个 `phone_exists`；L10 订正措辞）；L3 由 `verify.sh` 第 4 步判定（`drizzle-kit generate` 不产生新文件）；**不可离线判定**：L9（`./scripts/verify.sh` 本身） | `db/access-schema.db`、`tests/harness`、`acceptance-gaps`、`acceptance-boundaries` |

**未闭合的部分项合计**：C6、C7、C13、C17、C18、D14、E3、E8、E15、E19、F5、F6、G14、J1、J2、J9、K10、K12，加上依赖所属域的 F14、F15、F16、J12。这些都是断言偏弱或依赖尚未实现的域，**没有一项是已知的行为错误**；是否要在合并前补齐，由你决定（见 tasks 实施记录的「待决项」）。

## 自动项

### A. 认证与会话（AX-1）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| A1 | AX-1 | 手机号 + 密码登录（fixture 用户） | 得到会话；到期日 = 登录时间 + 15 天 |
| A2 | AX-1 | 24 小时内第二次认证请求；距上次刷新满 24 小时后的首次请求（改库时间戳模拟，库用真实时钟） | 前者不写库；后者把到期日刷新到当时 + 15 天 |
| A3 | AX-1 | 连续 15 天不登录 | 会话到期，需重新登录 |
| A4 | AX-1 | 用户停用后下一次 `authenticate`（cookie 仍在） | 未认证 |
| A5 | AX-1 | 修改密码 | 其他会话被撤销，当前会话保留 |
| A6 | AX-1 | 重置密码 | 全部会话失效 |
| A7 | AX-1 | 退出登录 | 当前会话删除 |
| A8 | AX-1 | 会话配置 | 无 cookie 缓存；`HttpOnly`；生产 `Secure`；`SameSite=Lax` |
| A9 | AX-1 | Origin 不在 `trustedOrigins` 的状态变更请求 | 拒绝 |
| A10 | AX-1 | 全仓库搜索 `adminAc`、`set-password`、`impersonate`、`defaultRole`、`adminRoles` | 无使用 |
| A11 | AX-1 | 管理员路径 | 没有返回或设置用户密码的函数 / 命令 / 端点 |
| A12 | AX-1 | 不限并发会话；不设绝对有效期 | 同一用户 3 个并发会话都有效；持续活跃 100 天仍可续期 |
| A13 | AX-1 | 全局请求限流 | 已启用；与账号锁定互不依赖 |

### B. 开户、激活、首个超管（AX-2）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| B1 | AX-2 | 代码与数据库 | 没有默认管理员账号与默认密码 |
| B2 | AX-2 | 无令牌 / 令牌错误 / 令牌已用 / 已有未停用超管，各执行 `bootstrap-superadmin` | 各自被拒，零写入 |
| B3 | AX-2 | 令牌有效且无超管 | 创建待激活超管；令牌 `consumed`；同一令牌再用被拒；审计 `bootstrap_superadmin` |
| B4 | AX-2 | 令牌过期（`FakeClock` 推进 25 小时） | 拒绝 |
| B5 | AX-2 | 创建用户 | 状态待激活；**没有发出短信**（`FakeSms` 为空） |
| B6 | AX-2 | 创建 `store_staff`：同门店两名专员，各自手机号 | 各自定位成功，绑定不同 `MediaStaff` |
| B7 | AX-2 | 创建 `store_staff`：手机号不存在 / 手机号不在该编码的门店 / 专员已停用 | 创建失败（`staff_not_found` / `staff_inactive`），不建用户 |
| B8 | AX-2 | 待激活用户用验证码设置密码 | 状态 `active`；可密码登录；`activated_at` 有值；审计 `user_activated` |
| B9 | AX-2 | 待激活用户走密码登录 | 响应（状态码与文案）与「手机号或密码错误」一致 |
| B10 | AX-2 | 待激活用户改手机号；有效用户改手机号 | 前者成功且授权表与认证表一致；后者被拒并提示删旧建新 |
| B11 | AX-2 | 待激活不自动过期（`FakeClock` 推进 1 年） | 仍可激活；用户管理能看到「待激活天数」 |
| B12 | AX-2 | 批量停用长期待激活用户 | 成功；停用用户不占号 |
| B13 | AX-2 | 激活走的库路径 | 与「验证码重置密码」是同一条（没有额外激活端点） |

### C. 登录保护与短信（AX-4）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| C1 | AX-4 | 连续 5 次密码失败，第 6 次用正确密码 | 被拒（锁定） |
| C2 | AX-4 | 锁定后 `FakeClock` 推进 15 分钟 | 可登录；失败计数清零 |
| C3 | AX-4 | 锁定期间短信登录 | 成功（锁定只限制密码登录） |
| C4 | AX-4 | 锁定期间短信重置密码成功 | 立即可用密码登录（唯一提前解锁路径）；其他会话失效 |
| C5 | AX-4 | 不存在的手机号与存在的手机号各失败 5 次 | 响应与计数行为一致 |
| C6 | AX-4 | 连续失败对用户状态 | 不修改业务用户状态 |
| C7 | AX-4 | 不存在 IP 维度封禁 | 同一 IP 对不同手机号的失败互不累计（静态与行为断言） |
| C8 | AX-4 | 60 秒内重发 | 被拒；60 秒后可发 |
| C8a | AX-4 | 首次请求后每 30 秒连续重试（`FakeClock`） | 被拒的重试不延长窗口；首次请求后 60 秒的那次重试成功 |
| C8b | AX-4 | 重发验证码 | 旧验证码立即失效，新验证码有效 |
| C9 | AX-4 | 同一手机号一天第 11 次 | 被拒 |
| C10 | AX-4 | 验证码 5 分钟过期 | 过期后验证失败 |
| C11 | AX-4 | 连续输错 5 次 | 验证码作废，第 6 次用正确码也失败；需重新获取 |
| C12 | AX-4 | 对不存在 / 停用手机号请求发送 | 响应与成功一致；`FakeSms` 无记录；`access_sms_sends.outcome=suppressed` |
| C13 | AX-4 | 存在与不存在手机号的 60 秒 / 每日计数 | 一致（`sent` 与 `suppressed` 同样计入；`rate_limited` 不计入） |
| C19 | AX-4 | `access maintain` 清理 | `access_sms_sends` 超 35 天、`access_login_failures` 的零计数 7 天与陈旧计数 90 天、`access_bootstrap_tokens` 已用 / 过期 30 天的行被清理；未到期的保留；锁定中的行不被清理 |
| C14 | AX-4 | 全局每日上限达到 | 短信类请求「暂不可用」+ 告警事件 `sms_daily_cap_reached`；密码登录仍成功 |
| C15 | AX-4 | 短信发送失败 | 用户得到通用提示；`outcome=failed`；不计入全局 `sent` |
| C16 | AX-4 | 生产模式缺发送器配置 | 进程启动失败；`fake` 仅在测试环境允许 |
| C17 | AX-4 | 密码长度 | 8 位通过，7 位被拒；不强制组合与定期改密 |
| C18 | AX-4 | 验证码在日志、审计、`access_sms_sends` 中 | 不出现（字符串扫描） |

### D. 用户生命周期（AX-5）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| D1 | AX-5 | 停用用户 | 会话全部失效；认证表登录手机号为墓碑值；原号保留在授权表；审计同事务 |
| D2 | AX-5 | 停用后同号新建用户 | 成功（停用不占号）；旧用户用原号无法登录也收不到验证码 |
| D3 | AX-5 | 恢复：`OrgDirectory` 故障注入使一个引用「无法映射」+ 另一个品牌被停用（存在） | 前者去掉并记审计，后者保留；用户为有效（授权明细表的 RESTRICT 外键保留，用例不靠关外键） |
| D4 | AX-5 | 停用前是待激活的用户恢复 | 回到待激活 |
| D5 | AX-5 | 恢复时同号已有待激活 / 有效用户 | 被拒；状态不变 |
| D6 | AX-5 | 墓碑改写失败 | 整个停用事务回滚，用户仍有效 |
| D7 | AX-5 | 不变式：非停用用户的登录手机号 = 授权表手机号；停用的 = 墓碑 | 对测试期间全部状态组合成立 |
| D8 | AX-5 | 专员停用后该用户下一次请求 | 被自动停用并撤销会话（懒执行）；审计 `media_staff_disabled`（`service:access-worker`） |
| D9 | AX-5 | 从未登录的 `store_staff`，专员停用 | 补偿任务停用 |
| D10 | AX-5 | 专员恢复 | 因该专员自动停用的恢复；人工停用的不恢复 |
| D11 | AX-5 | 专员恢复但同号已有有效用户 | 保持停用；一条质量问题 `user_auto_restore_blocked_phone_in_use` |
| D12 | AX-5 | 人工恢复时绑定的专员已停用 | 用户有效，本人范围请求被拒绝，提示联系管理员（专员行不会消失：`media_staff_id` 有外键） |
| D13 | AX-5 | 最后一个可用超管停用 | 被拒；超管停用自己被拒 |
| D14 | AX-5 | 两个超管顺序交错互停（持锁者停在 hook） | 恰好一个成功 |
| D15 | AX-5 | 换门店 / 品牌 | 删旧建新：旧用户停用，新用户同号待激活，须重新激活；旧用户数据不迁移，两者无关联字段 |
| D16 | AX-5 | 全仓库 | 没有删除用户行的路径 |
| D17 | AX-5 | 用户状态变化对采集 | 不触碰任何监控开关（静态：无对 `monitoring_enabled` 的写） |

### E. Capability 与授权入口（AX-6）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| E1 | AX-6 | 注册表对照 `capability-matrix.v1.json` | 29 项逐行一致；增删改任一项测试失败 |
| E2 | AX-6 | 四类角色 × 29 项授予 | 与 PRD §7.3 一致 |
| E3 | AX-6 | 多角色输入 | 被拒绝（一个用户一个角色） |
| E4 | AX-6 | 未知 Capability | `capability_unknown` |
| E5 | AX-6 | 角色未持有 | `capability_not_granted`（403） |
| E6 | AX-6 | 停用 / 无会话 | `user_not_active` / `unauthenticated`（401） |
| E7 | AX-6 | 资源未注册 | `scope_unregistered`（403），**含超管** |
| E8 | AX-6 | 谓词失败（他人创建的计划） | `predicate_failed`；`hq_manager` 能看到但不能编辑他人创建的计划 |
| E9 | AX-6 | `monitoring_level` 谓词 | 经销商级监控开关只有超管通过；总部、分公司被拒 |
| E10 | AX-6 | 对象不在范围 | 对外「未找到」 |
| E11 | AX-6 | 超管路径 | 静态扫描没有 `if (admin) return true` 一类旁路；超管同样先过 `authorize` |
| E12 | AX-6 | 业务模块里的角色字面量比较 | 静态护栏：出现即失败（`access-control` 内除外） |
| E13 | AX-6 | 业务代码里注册表以外的 Capability 字符串 | 静态护栏：出现即失败 |
| E14 | AX-6 | `learning.report.read`、`learning.tag.manage`、`ai.content.assist`、`data.master_data.structure`、`monitor.external.manage` 的授予 | 与矩阵一致：分别拒绝分公司 / 总部 / 分公司与门店 / 总部 / 总部与分公司 |
| E15 | AX-6 | `data.master_data.import` / `correct` 对总部 | 授予，但越品牌的行被拒（范围由 `ScopeStrategy` 执行）；`structure` 总部被拒 |
| E16 | AX-6 | 计划任务服务身份调用 `data.export`、`data.raw_payload.read`、`user.manage`、`audit.read`、`config.manage` | 被拒（`service_principal_forbidden`） |
| E17 | AX-6 | 服务身份白名单常量 | 枚举断言不含上述七项高敏 Capability |
| E19 | AX-6 | `service:plan-worker` 白名单 | 含 `activity_plan.join` 与 `data.sync.trigger`；用它发起 supplement 被放行；调用 `data.export` 被拒 |
| E18 | AX-6 | 前端隐藏按钮不构成授权 | 后端每个写动作独立 `authorize`（对每个命令函数的静态覆盖测试：未经 `authorize` 的导出命令函数为 0） |

### F. DataScope 与资源策略（AX-7）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| F1 | AX-7 | 北京分公司有海信门店 A、日立门店 B；分公司经理品牌=海信 | 只见 A |
| F2 | AX-7 | 品牌集合为空 | 合法空结果，不是全量 |
| F3 | AX-7 | 组织 / 品牌引用无法映射 | 403 + 质量问题 `access_scope_not_resolvable`；不是空列表 |
| F4 | AX-7 | 品牌 / 分公司停用 | 已授予用户仍能读；恢复收窄不去掉停用对象 |
| F5 | AX-7 | `store_staff`：绑定缺失 / 已停用专员 / 多条 | 三种情况都拒绝本人范围，不回退本门店 / 本品牌 |
| F6 | AX-7 | `store_staff` 看本人账号 | 只含自己专员名下 |
| F7 | AX-7 | 四类角色的 `DataScope` | 与 design §7.4 表一致；`level` 为 1 / 2 / 3 / 3 |
| F8 | AX-7 | 分公司经理看不到其他分公司的账号与内容 | 成立 |
| F9 | AX-7 | 外部监控账号：`hq_manager`、`branch_manager` 持有 `data.account.read` | 不可见；超管可见 |
| F10 | AX-7 | 重复注册同一资源键 | 失败；删除注册后同一请求失败 |
| F11 | AX-7 | 四个自带策略 `user`、`audit_log`、`external_account`、`raw_payload` | 可用；其余资源键注册前被拒 |
| F12 | AX-7 | 角色或范围变更后同一会话的下一次请求 | 使用新范围（无需重新登录） |
| F13 | AX-7 | 范围不跨请求缓存 | 同一进程内两次请求之间改库，第二次可见（无陈旧缓存） |
| F14 | AX-7 | 人员级别：对 `branch_and_above` 的课程，`store_staff` 不可见；对 `hq_and_above` 的课程，`branch_manager` 不可见 | 成立（级别来自角色映射，不新增用户字段） |
| F15 | AX-7 | 改绑账号归属后 | 历史列表出现事实的归属快照不变；授权收缩后查询结果立即缩小，历史事实不删除 |
| F16 | AX-7 | 手机号 | 随所在行的范围返回；分公司看不到其他分公司或他人名单中的手机号；查看手机号不产生逐条审计 |

### G. 管理范围与授权变更（AX-8）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| G1 | AX-8 | 总部创建总部 / 超管；分公司创建分公司；非超管创建超管 | 各被拒 |
| G2 | AX-8 | 超管创建任意角色；超管管理其他超管 | 成功 |
| G3 | AX-8 | 同级用户在列表中 | 不可见；按 ID 访问 = 未找到；分公司经理不能停用同分公司另一位经理 |
| G4 | AX-8 | 自己在列表中 | 可见、只读；不能改自己的角色 / 范围 / 状态 |
| G5 | AX-8 | proposed 超出边界（授予自己没有的品牌或分公司） | 整个变更拒绝；库中无变化 |
| G6 | AX-8 | current 不通过（目标不是自己的严格下级） | 拒绝 |
| G7 | AX-8 | 列表可见集合与可操作集合 | 集合相等（可见 = 可操作 ∪ 自己） |
| G8 | AX-8 | 批量 3 行含 1 行越权 | 2 成功、1 进跳过清单，整批不失败 |
| G9 | AX-8 | 角色降级后 | 目标用户同一会话的下一次请求按新能力判断；现有会话未被撤销 |
| G10 | AX-8 | 变更事务 | 用户行、品牌 / 分公司集合、审计同时成功或同时保持旧状态（注入审计失败验证） |
| G11 | AX-8 | `store_staff` 的门店 / 品牌原地修改 | 被拒并提示删旧建新；改姓名可原地改 |
| G12 | AX-8 | 强制下线 | 目标全部会话失效；审计 `force_logout`；越边界被拒 |
| G13 | AX-8 | 总部能管理的范围 | 分公司人员与门店专员，且其品牌 ⊆ 总部品牌 |
| G14 | AX-8 | 并发改同一用户（持锁者停在 hook） | 后者基于新状态重新校验 |

### H. 用户批量导入（AX-3）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| H1 | AX-3 | 1,001 行 / 10 MB + 1 字节 / 表头不符 / 编码无法识别 / 引号未闭合 | 各整批拒绝；`import_batches` 行数为 0 |
| H2 | AX-3 | UTF-8、BOM、GB18030 同内容 | 预检结果完全相同 |
| H3 | AX-3 | 预检只读 | 用户、认证行、授权集合行数不变；`FakeSms` 为空 |
| H4 | AX-3 | 总部导入含 `hq_manager` / `platform_admin` 行 | 这些行进跳过清单（`role_not_grantable`）；其余行正常；整批不失败 |
| H5 | AX-3 | 分公司导入含他分公司门店、超出自己品牌的行 | `scope_exceeds_boundary` / `store_not_in_scope` |
| H6 | AX-3 | 手机号已被待激活 / 有效用户占用 | `phone_exists`；不静默改角色或范围 |
| H7 | AX-3 | 停用用户的号码 | 不占号，可新建 |
| H8 | AX-3 | 同文件内同号两行 | 两行都报 `duplicate_phone_in_file` |
| H9 | AX-3 | `store_staff` 定位失败：手机号不存在 / 手机号在别的门店（填错门店编码）/ 专员停用 / 门店不在操作者范围 | 分别为 `staff_not_found` / `staff_not_found` / `staff_inactive` / `store_not_in_scope`；不建用户（2026-11-10 订正：定位键是「手机号 + 门店编码」，所以「不在该门店」与「不存在」同为 `staff_not_found`；`store_not_in_scope` 只表示专员已定位到、但其门店超出操作者范围） |
| H10 | AX-3 | 角色与列取值不匹配（hq 填分公司、staff 填品牌等） | `scope_fields_not_allowed` |
| H11 | AX-3 | 预检后有人先建同号用户，再确认 | 该行 `conflict`；不重复创建 |
| H12 | AX-3 | 确认写入 | 每个新用户走与单个邀请相同的创建逻辑；每条有审计；批次 `completed` |
| H13 | AX-3 | 回流文件 | 列与原文件一致并追加「结果 / 原因 / 指引」；提交人可下载，他人被拒；不要求 `data.export`；只含本次提交的行；手机号明文 |
| H14 | AX-3 | 回流文件改后作为新文件重传 | 新批次；旧批次结果不变 |
| H15 | AX-3 | 重复提交同一文件 | 第二次全部 `phone_exists`，无额外用户 |
| H16 | AX-3 | 不提供「一键改成新增」 | 不存在这样的命令（静态） |
| H17 | AX-3 | 默认测试 | 导入过程中无短信、无网络 |

### I. 数据出口（AX-9）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| I1 | AX-9 | 10 个出口各一条守卫用例（fake 出口） | 动作权限 + 范围都检查 |
| I2 | AX-9 | 提交时撤权 / 执行时撤权 / 交付前撤权 | 三处任一，产物不交付 |
| I3 | AX-9 | 提交后扩权 | 旧任务有效范围不变 |
| I4 | AX-9 | 提交后撤权 | 有效范围 = 交集（收窄）；为空则取消并审计 `delivery_scope_shrunk` |
| I5 | AX-9 | `recheckDelivery`：产物范围 ⊆ 当前 / 不⊆但可重建 / 不可重建 | `deliver` / `rebuild` / `deny` |
| I6 | AX-9 | 停用用户 | 该用户未完成任务被取消；计划任务不受影响 |
| I7 | AX-9 | canceller 部分失败 | 告警 + 审计；停用事务已提交不回滚 |
| I8 | AX-9 | 用户触发任务身份 | 继承提交者，不用服务身份；撤权后交付前被拒 |
| I9 | AX-9 | 计划任务身份调用导出 / 原始载荷 | 被拒 |
| I10 | AX-9 | 签名链接 | 短期有效；撤权后不能续签（fake 签发器） |
| I11 | AX-9 | AI 工具取数 / 通知 | 返回数据 / 发送对象不超出调用者或接收者当前范围（fake） |
| I12 | AX-9 | `data.export` 与 `report.export` | 按导出物主结构划分；点检表下钻明细算 `report.export` |
| I13 | AX-9 | 学习资料下载 | 记审计：操作者、课程、文件标识、时间、结果 |
| I14 | AX-9 | 查看手机号 | 不逐条审计；批量导出时记 |

### J. 审计（AX-10）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| J1 | AX-10 | 事件覆盖：登录成功 / 失败、会话撤销、强制下线、用户创建 / 导入 / 停用 / 恢复、授权变更、导入确认、回流下载、手工同步、导出、授权拒绝 | 各至少一条 |
| J2 | AX-10 | 全部事件夹具字符串扫描 | 无密码、令牌、Cookie、验证码；手机号按明文；无整行原文与文件内容 |
| J3 | AX-10 | 重复写入同一幂等键 | 只落一条 |
| J4 | AX-10 | `UPDATE audit_events`；`DELETE` 未到期行 | 被触发器拒绝 |
| J5 | AX-10 | 清理：366 天前 / 364 天前 | 只删前者；产生一条 `audit_purged`（系统身份，含条数与截止时间） |
| J6 | AX-10 | 不存在单条或界面删除 | 静态：无按 ID 删除的函数 |
| J7 | AX-10 | 非超管读取审计 | 被拒；超管可读 |
| J8 | AX-10 | 高风险事件审计写入失败（用户管理、授权变更、停用恢复、导入确认） | 业务写入一并回滚 |
| J9 | AX-10 | 低风险审计写入失败（登录成功） | 业务继续；pino 有记录；失败计数 +1 |
| J10 | AX-10 | 现有三类审计事件经适配器 | 落入 `audit_events`；可按 actor / 对象 / 批次查询；`actor` 为规范主体字符串 |
| J11 | AX-10 | `reason_code` | 全部为系统生成的稳定枚举；调用方无法传入自由文本 |
| J12 | AX-10 | 活动计划与监控判定计划的创建 / 删除 / 恢复 / 期满清除事件 | 通过 `fromPlanAudit` 落库（以 `a-activity-plan` 的事件夹具） |

### K. 对既有模块的接入与入口（AX-11、AX-12）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| K1 | AX-11 | `toPlanActor` 对四类角色 | 输出与 `a-activity-plan` 的授权期望一致（契约 fixture） |
| K2 | AX-11 | `toMasterDataActor` 对四类角色 | 超管 `all`、总部为授权品牌编码；分公司人员 / 门店专员 → `no_import_capability`（无 `import` Capability，不可适配） |
| K3 | AX-11 | `toTracerActor`：超管 / 范围 all 的主体 | 产出全范围 actor |
| K4 | AX-11 | `toTracerActor`：分公司人员 | `Unadaptable('partial_scope_not_supported')`，不降级 |
| K5 | AX-11 | 仓库中全部已用 Capability 字符串 | 都在注册表中 |
| K6 | AX-11 | 现有模块（tracer、sync、master-data）的既有测试 | 全绿，一个断言都不改 |
| K7 | AX-11 | `userIdOf` | `user:<id>` → ID；`service:*` → null；历史行不回填 |
| K8 | AX-11 | 环境变量声明的 CLI 身份 | 仍可用（现有 CLI 一行未改）；审计里被规范化为 `service:<名称>`（适配器 `canonicalActor`），范围不超过声明（B 不放宽任何范围） |
| K9 | AX-12 | 直接调用 Route Handler（`new Request()`）登录、读会话、退出 | 状态码与 `Set-Cookie` 符合预期 |
| K10 | AX-12 | `GET /api/health` | 200；不写库 |
| K11 | AX-12 | `src/app` | 无 SQL、无 `db.insert`（静态） |
| K12 | AX-12 | CLI 缺环境变量 | 启动失败；列出缺项键名，不打印值 |
| K13 | AX-12 | 影响多个对象的 CLI 命令不带 `--apply` | 库中无变化 |
| K14 | AX-12 | CLI 参数 | 没有 `--force`、`--skip-auth`（传入即报错） |
| K15 | AX-12 | 本轮没有对外的管理 HTTP 接口 | 路由表只含 `auth/*` 与 `health` |
| K16 | AX-12 | `pnpm typecheck` | 通过 |

### L. 离线、一致性与边界（AX-13）

| # | 需求 | 断言 | 预期 |
|---|---|---|---|
| L1 | AX-13 | 测试进程启动时 | 网络 socket 被禁止；任何外联使测试失败 |
| L2 | AX-13 | 同一 fixture 连续运行 3 次 | 结果一致 |
| L3 | AX-13 | `migrate` 空库两次；`drizzle-kit generate` | 成功且幂等；无新迁移文件；`auth_*` 表结构与手工 schema 一致 |
| L4 | AX-13 | 测试库名 | 以 `_test` 结尾；结束后清理 |
| L5 | AX-13 | 任务 1 的 `__spike__` 用例 | 保留为回归并全绿 |
| L6 | AX-13 | `access-control` 的 `*.db.test.ts` 中的 `Promise.all` | 静态扫描为 0 |
| L7 | AX-13 | `access_users.active_phone` 唯一键 | 并发（持锁者停在 hook）创建同号，一条成功、另一条稳定冲突 |
| L8 | AX-13 | `ON DELETE CASCADE` | 本 spec 的表没有 |
| L9 | AX-13 | `./scripts/verify.sh` | 通过；Python 侧未验证时明确写出，不声称通过 |
| L10 | AX-13 | 真实短信发送器 | 测试环境从不构造真实 SDK 客户端（静态：测试不 import `@alicloud/*`；`AliyunSmsSender` 只能以注入的假客户端构造；2026-11-10 订正：原文「不 import `AliyunSmsSender`」会禁掉对它自己的离线测试） |

## 手工项

| # | 需求 | 谁看什么 | 通过标准 |
|---|---|---|---|
| M1 | AX-2、AX-3、AX-8 | 业务人员用 CLI 走一遍：引导超管 → 激活 → 邀请总部与分公司人员 → 分公司导入 20 行专员（含 2 个越权、1 个手机号已存在）→ 看批次与回流文件 | 报告里的分类与原因他们看得懂；越权行确实没有建用户 |
| M2 | AX-3 | 在 Excel 里打开回流文件 | 不乱码；以 `=` 开头的单元格显示为文本；原因与指引能让业务知道下一步 |
| M3 | AX-10 | 评审审计样例（激活、授权变更、停用、导入确认、强制下线） | 每条含 actor、时间、对象、结果与稳定 `reason_code`；没有秘密 |
| M4 | AX-7 | 业务确认 `store_staff` 的范围由门店推出（门店换板块会立即改变其范围）可接受（design §14 第 11 项） | 刘学奎给出结论 |
| M5 | AX-4 | 业务确认「连续 5 次失败」不加时间窗口可接受（design §14 第 9 项） | 刘学奎给出结论 |

## 环境项

| # | 需求 | 内容 | 当前状态 |
|---|---|---|---|
| ENV-1 | AX-13 | 测试 ECS 上一次性库容器跑 `pnpm test:db`（仅 Workbench；`_test` 库；用完 `down -v`） | 未执行 |
| ENV-2 | AX-12 | 本地一次性 `next build` 通过（不进 `verify.sh`） | **通过**（2026-11-10，约 4 秒；路由表只有 `/api/auth/[...all]` 与 `/api/health`；`next build` 会改写 `tsconfig.json` 并生成 `next-env.d.ts`，已还原 / 删除，不入库） |
| ENV-3 | AX-4 | **真实短信发送**：阿里云短信签名与模板可用后，在批准的条数内发送一条验证码并完成激活 | **不属于自动验收**；签名与模板已申请（2026-11-06，刘学奎告知），名称与编码待提供，CLI 无 `dysms` 查询权限；需要刘学奎批准、显式开关、固定条数与审计摘要；批准前生产不得启用真实发送器 |
| ENV-4 | AX-10 | 部署账号具备 `TRIGGER` 权限，审计触发器在测试 ECS 上生效 | 未执行 |
| ENV-5 | AX-1 | 在 Nginx 之后（ADR-0006）确认 `Secure` cookie 与 `trustedOrigins` 在真实域名下工作 | 未执行；域名与 ICP 备案外部阻塞 |

## 不在本 spec 验收内

- 页面（登录、激活、忘记密码、修改密码、用户管理、审计日志）：见文末「页面验收」（2026-11-11 起）；
- 管理类 HTTP 接口；
- 各业务资源的 `ScopeStrategy` 与各出口的业务实现：所属域的 spec；
- 手机号改绑、SSO、MFA、动态角色、个人权限覆盖（PRD 明确不做）；
- 配置中心与短信额度的配置实现（I 域）。

## 与 B PRD §14 的对照

| PRD 条目 | 验收项 |
|---|---|
| B1 开户与激活 | B1–B13、H1–H17 |
| B2 登录与会话 | A1–A13、C1–C18 |
| B3 用户生命周期 | D1–D17 |
| B4 功能权限 | E1–E18 |
| B5 数据范围 | F1–F16 |
| B6 管理范围 | G1–G14 |
| B7 数据出口 | I1–I14 |
| B8 审计 | J1–J12 |
| 2026-11-02 盘问新增（25 条） | 散见于上；「一个 User 一个 RoleCode」E3、「同级不可见」G3、「超管不能停用自己」D13、「手机号唯一 / 不占号」D2 / H7、「滑动续期每天一次」A2、「不存在 IP 维度」C7、「创建者谓词」E8、「品牌求交」F1、「无法映射 403」F3、「停用后仍可读」F4、「通知复查」I11、「撤权取消任务」I6、「reason_code 与不逐条审计」I14 / J11 |

## 页面验收（ui-foundation §9）

> 2026-11-11。方法：本机一次性 MySQL 8.4 + `next dev`，Chrome（Playwright）按真实流程点击，逐步断言；镜像另做冒烟。**没有**在测试 ECS 上做点击走查之前，下表「测试 ECS」列为空。`—` 表示不适用，`未验证` 表示没有验过，不是通过。

| 项 | 结果 | 依据 |
|---|---|---|
| 页面在 design §15.6 确认范围内 | 通过 | 9 个页面，与确认记录逐项对应；未做活动计划 / 判定计划 / 门店端 |
| 用 §4 骨架（列表页、导入流程、登录） | 通过 | 用户列表 = 列表页；导入 = 导入流程；登录 / 激活 / 找回 = 登录骨架 |
| 空 / 无权限 / 错误 / 部分成功 / 处理中 / 过期 | 部分通过 | 空（无下级用户、无匹配）、无权限（非超管访问 `/audit`、非管理者访问 `/users`）、错误（服务端动作失败留在弹窗并显示错误码）、部分成功（导入预检含错误 / 跳过）已走查；「处理中」只有按钮文字 `处理中…`，批量停用没有独立的进度态（同步完成）；「过期」（审计一年窗口）只有文案 |
| 计数与分页总数同一条谓词 | 通过 | 用户列表先过滤再分页；审计 `count` 与 `list` 共用同一个 `auditConds` 函数（代码层保证，没有单独的等价测试） |
| 无权限态不出现真实计数 | 通过 | `/audit` 对非超管只渲染无权访问卡片，未调用 `count` |
| 不出现越范围内容 | 通过 | 分公司人员的列表 / 新建表单只含自己范围内的品牌与分公司；同级与上级详情 = 未找到；导入批次仅提交人可见（`web.db.test.ts`） |
| 内部 ID / 字段名 / 权限码不出现在界面 | 通过（有一处例外已登记） | 界面显示姓名、品牌名、分公司名；原因列「人话 + 稳定码」是 ui-foundation §6.6 允许的稳定错误码，不是内部字段 |
| 颜色、字号、圆角只用 §6 token | 通过 | 沿用已确认原型的 CSS 变量 |
| 渐变只用于按钮与反馈；选中芯片浅底 | 通过 | 同上 |
| 角色标识用中性标签 | 通过 | `RoleTag` |
| 返回链接统一 34px 控件；页头危险按钮白底红字 | 通过 | `BackLink`、`btn-danger` 页头样式 |
| 对比度数值 | 未验证 | 没有用设计工具实测；沿用 ui-foundation §11 第 4 项的估算 |
| 键盘可完成主要操作、焦点圈 | 未验证 | 未做键盘走查；原型 CSS 有 `:focus-visible` |
| 手机宽度（管理端不专门优化） | 未验证 | 只截了 1440 宽 |
| 筛选 / 排序 / 分页进 URL | 通过 | 用户列表、审计日志；导入批次进 `?batch=` |
| 按钮禁用态可读 | 通过 | 分页禁用用 `disabled` 按钮样式，不是降透明度 |
| 删除 / 停用 / 强制下线有带影响范围的确认弹窗，按钮写动作名 | 通过 | `停用用户`、`恢复用户`、`强制下线`、`停用 N 个用户` |
| 异步动作提交后给出去处 | — | 本 spec 的动作全部同步完成 |
| 术语与 §6.6 一致 | 通过 | 专员、平台超管等 |
| ICP 备案号页脚（运维手册 §10.6 第 5 条） | 通过 | 登录类页面与管理端页脚，链接工信部；备案号来自环境变量 `HBECHO_ICP_NUMBER` |
| 测试 ECS 上走查 | （见 tasks 实施记录） | |
