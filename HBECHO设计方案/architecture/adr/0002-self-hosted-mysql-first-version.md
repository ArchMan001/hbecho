# ADR-0002 · 首版自建 MySQL 8.0，不用 RDS

- **状态**：accepted
- **日期**：2026-09-04
- **决策人**：刘学奎
- **替代**：无（首版基线选择）

## 背景

v2 基线要求 MySQL **8.0.16+**，因为整个设计把大量语义不变量放在 CHECK 约束里（归档状态与 asset/error 的组合、`window_overflow` 必须伴随 `continuity_gap`、`object_category` 隔离等）。8.0.16 之前的版本会解析后忽略 CHECK，建表成功、约束失效、无任何警告。

当时资产只有一台 ECS 与 OSS，没有 RDS 实例。

## 决定

首版自建 MySQL：

- 镜像 `mysql:8.0`，实测 `8.0.46`
- 容器 `hbecho-mysql`，数据目录 `/data/mysql`
- 端口只绑 `127.0.0.1:3306`
- `time_zone=+00:00`、`utf8mb4`、严格模式保留、`local_infile=OFF`
- 应用账号 `hbecho_app` 只授权 `hbecho.*`，不是 `*.*`

## 备选与不选原因

| 方案 | 不选原因 |
|---|---|
| RDS MySQL | 首版没有 RDS 资产；参数、备份、监控与验收方式都要整体重写，收益在当前规模不明显 |

## 后果

- 备份、PITR、高可用、版本升级都由本项目承担。
- 切换到 RDS 不是改几行配置：runbook §6、§11、§13 要整体重写。
- 数据盘满会同时影响数据库与容器，磁盘水位是最关键的单指标。

## 现在谁在守

- runbook §13.1：CHECK 约束破坏性验收，实测报 `ERROR 3819`。
- runbook §13.2：严格模式破坏性验收，实测报 `ERROR 1264`。
- 容器 fd 上限、`local_infile=OFF` 已实测。

## 原文

`HBECHO设计方案/runbooks/server-operations-runbook.md` §6、§13.1、§13.2；`database-design-v2.md` §5。