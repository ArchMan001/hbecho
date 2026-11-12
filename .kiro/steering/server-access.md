---
title: "服务器访问：一律走 Workbench，不用 SSH"
inclusion: always
---

# 服务器访问：一律走 Workbench，不用 SSH

适用于 hbecho 与 hbdam 两台 ECS，以及将来购买的 hbecho 测试 ECS。**来源：liuxuekui 2026-10-14 明确要求**（原文在 hbdam `.kiro/steering/server-access.md`，本条对 hbecho 同样生效）。

> **2026-11-12 修订（刘学奎）**：hbecho 唯一实例现在承载线上站点 `echo.hbmarketer.com` 与线上库，按生产环境对待，不再作为测试机；第 2、5 条已改写，推翻 2026-10-25 的「当前唯一实例是测试 ECS」。

> ⚠️ **与 runbook §3.1 存在已知冲突**：hbecho 运维手册仍保留 `Host hbecho` 的 SSH 别名与端口转发示例。按 2026-10-14 的决定，**以本文件为准**；runbook 的同步修订单独进行，不阻塞当前工作。

## 规则

1. **所有服务器操作只用 Workbench CLI**：读状态、跑命令、传文件、部署、看日志。
   - 命令：`workbench exec -P hbecho -i <实例ID> -c '<命令>'`
   - 文件：`workbench upload` / `workbench download`
   - 列实例：`workbench list -P hbecho -r cn-beijing`
   - **禁止**：`ssh`、`scp`、`sftp`、`rsync -e ssh`、SSH 端口转发（含 8081 / 13307），以及任何经 SSH 连数据库的做法
   - 不在此限的是 **git 到 GitHub 的 SSH**（`git@github.com`）：那是连 GitHub，不是连服务器

2. **实例对照**（实例 ID 不是密钥，runbook 里本来就有）

   | 项目 | profile | 实例 ID | 地域 |
   |---|---|---|---|
   | hbecho 唯一实例（承载 `echo.hbmarketer.com` 与线上库） | `hbecho` | `i-2zef8qpi1d2mldntjgrv` | cn-beijing |

   目前没有独立的 hbecho 测试机或生产机；这台就是线上站点所在机器。

3. **默认只读**。创建或修改文件、重启或删除容器、改配置、数据库备份与迁移、部署，都要先说明要做什么、预期看到什么，**得到明确同意后**才做；不批量执行。

4. **单条命令有 30 秒超时**。长任务用 `nohup … > 日志文件 2>&1 &` 放后台，再分段查看；输出过长先 `| head` / `| tail`。首次调用报 `unknown error` 时按 runbook §4.1 的顺序排查，不要立刻怀疑权限。

5. **测试的运行位置**（2026-11-12 由刘学奎修订，推翻 2026-10-25 的「当前唯一实例是测试 ECS，允许跑全部测试」）：
   - 唯一实例 `i-2zef8qpi1d2mldntjgrv` **承载线上站点与线上库**，按生产环境对待：**永远不在这台机器上跑测试**（`npm test` / `vitest` / `npm run verify` / `pytest` / 迁移演练），也不在它上面起一次性库容器做试验。
   - 测试只在两处跑：本机（Mac）的一次性 docker MySQL 容器，或 CI 的 MySQL 服务容器。在本机判断「测试会不会清表」的依据是它连的是哪个库，而不是它跑在哪台机器上。
   - 若将来购买独立的测试 ECS：先在本文件与 runbook 登记实例 ID，再恢复「测试机可跑测试」的规则（一次性库容器、独立网络、不映射宿主端口、库名以 `_test` 结尾、用完 `down -v`；不放生产凭证与未脱敏数据）。
   - 在这台实例上创建或修改文件、起停容器、改配置、迁移、部署，一律按第 3 条先说明并得到明确同意。

6. **凭证**：只用本机已配好的 profile（`~/.workbench`、`~/.aliyun` 的 `hbecho` / `hbecho-setup`）。不把 AccessKey、`.env` 内容写进仓库、日志或回复；读 `.env` 时只列键名。RAM 没权限的接口不要换更高权限账号去试，告诉用户去控制台看。

## 已知后果

Workbench CLI **没有端口转发**。因此 AI 不能替用户开隧道看服务器上的网页或连图形数据库客户端；需要时由用户在控制台或另行决定访问方式。