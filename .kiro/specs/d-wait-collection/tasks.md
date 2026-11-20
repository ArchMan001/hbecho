# D 判定执行前等待采集完成（d-wait-collection）· 任务
> **状态**：`draft`。T1–T3 无页面，可先做；T4 涉及页面文案，**界面确认（design §6.3）之后才展开**。
>
> **更新日期**：2026-11-20

- [ ] **T1 采集中查询**：`src/modules/judgement/facts.ts` 增 `collectingAccountsOf(accountIds)`，只读、分块；测试覆盖三类任务、三种状态、导入批次 `resolving`。
- [ ] **T2 等待阶段**：`engine/runner.ts` 的 `PHASES_BY_KIND.execution` 在 `freeze` 后插入 `collect_wait`；截止时间落 `phase_detail`；配置 `HBECHO_JP_COLLECT_WAIT_MINUTES`（`.env.example` 建议 60；缺失启动失败并点名）；测试见 design §5。
- [ ] **T3 原因拆分**：`syncCompleteness` 增 `inFlight`，`ZeroReason` 增 `sync_pending`；`judgement-labels.ts` 文案；D 的聚合与 E 的读口（`e-metrics-lite`）一并回归。
- [ ] **T4 页面文案**（界面确认后）：执行记录状态、执行详情说明与超时提示条、点检表原因列；4400 走查。
- [ ] **T5 验收**：本机 `./scripts/verify.sh`；测试机上连续两次执行，第二次不再出现「采集中」误报（需要一次真实导入，先说明再做）。
