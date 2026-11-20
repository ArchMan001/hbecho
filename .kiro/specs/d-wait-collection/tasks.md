# D 判定执行前等待采集完成（d-wait-collection）· 任务
> **状态**：T1–T4 已实现并通过离线测试（2026-11-20，本地分支 `fix/resolver-concurrency`，未推送 / 未部署）；T5 待部署后做。
>
> **更新日期**：2026-11-20

- [x] **T1 采集中查询**：`src/modules/judgement/facts.ts` 增 `collectingAccountsOf(accountIds)`，只读、分块；测试覆盖三类任务、三种状态、导入批次 `resolving`。
- [x] **T2 等待阶段**：`engine/runner.ts` 的 `PHASES_BY_KIND.execution` 在 `freeze` 后插入 `collect_wait`；截止时间落 `phase_detail`；配置 `HBECHO_JP_WAIT_COLLECT_SECONDS`（`.env.example` 建议 3600；缺失启动失败并点名）；测试见 design §5。
- [x] **T3 原因拆分**：`syncCompleteness` 增 `inFlight`，`ZeroReason` 增 `sync_pending`；`judgement-labels.ts` 文案；D 的聚合与 E 的读口（`e-metrics-lite`）一并回归。
- [x] **T4 页面文案**：执行记录状态、执行详情说明与超时提示条、点检表原因列；4400 走查。
- [ ] **T5 验收**：本机 `./scripts/verify.sh`；测试机上连续两次执行，第二次不再出现「采集中」误报（需要一次真实导入，先说明再做）。
