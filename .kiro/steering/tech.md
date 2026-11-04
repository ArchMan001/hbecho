---
inclusion: always
---

# 技术基线

- 数据获取与资产域当前基线是 `HBECHO设计方案/domains/data-foundation/database-design-v2.md`；不要在下游模块重建平行的组织、专员、平台账号或媒资主档。
- MySQL 基线为 8.4 LTS InnoDB（ADR-0002，2026-11-04；CHECK 强制执行要求 ≥ 8.0.16）：内部 ID 使用 signed `BIGINT`，API 输出十进制字符串；时间保存 UTC `DATETIME(6)`；状态使用 `VARCHAR + CHECK`，不用 MySQL `ENUM`。
- 外部 ID 始终按原始文本处理；哈希命中后复核原文。真实 `0`、字段缺失、显式 null、非法值必须保留不同语义。
- 网络请求期间不持有数据库事务。供应商请求/响应 body 或传输错误必须先以原始字节可靠落入私有 ODS OSS，再运行版本化适配器。
- ODS 调用、任务和原始载荷保留一年；结构化快照、历史归属和正式媒资长期保留。临时 URL 不是媒资身份，正式媒资按完整字节 SHA-256 判同。
- 任务必须幂等并使用租约与 fencing；旧批次迟到不得让 current 指针倒退；业务主档和历史事实不使用 `ON DELETE CASCADE`。
- 默认测试必须离线并使用 fixture/fake transport/fake OSS；禁止 CI 或普通测试发起真实、付费 AI Master 调用。真实 smoke 需要人工批准、显式开关、固定预算和审计摘要。
- 不把 `async=false` 或 `async=true` 写死为生产总策略。同步/异步按已验证 capability 配置，提交、轮询、分页和重试分别记录 ProviderCall。
- 应用栈已由 ADR-0005（2026-10-27）冻结：Node/TypeScript + Next.js + Drizzle + better-auth；队列为 MySQL 任务表。新增依赖必须先在 ADR 登记；未登记的不得宣称已选型。
