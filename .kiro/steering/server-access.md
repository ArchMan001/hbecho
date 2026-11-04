---
title: "服务器访问：一律走 Workbench，不用 SSH"
inclusion: always
---

# 服务器访问：一律走 Workbench，不用 SSH

适用于 hbecho 与 hbdam 两台 ECS，以及将来购买的 hbecho 测试 ECS。**来源：liuxuekui 2026-10-14 明确要求**（原文在 hbdam `.kiro/steering/server-access.md`，本条对 hbecho 同样生效）。

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
   | hbecho 测试（当前唯一实例） | `hbecho` | `i-2zef8qpi1d2mldntjgrv` | cn-beijing |
   | hbecho 生产（**未购买**） | 待定 | 待定 | cn-beijing |

3. **默认只读**。创建或修改文件、重启或删除容器、改配置、数据库备份与迁移、部署，都要先说明要做什么、预期看到什么，**得到明确同意后**才做；不批量执行。

4. **单条命令有 30 秒超时**。长任务用 `nohup … > 日志文件 2>&1 &` 放后台，再分段查看；输出过长先 `| head` / `| tail`。首次调用报 `unknown error` 时按 runbook §4.1 的顺序排查，不要立刻怀疑权限。

5. **测试的运行位置**（2026-10-25 按用户更正）：
   - **当前唯一实例 `i-2zef8qpi1d2mldntjgrv` 是测试 ECS**，不是生产机。它允许跑全部测试，前提全部满足：
     1. 测试只连**测试机上自己起的一次性库容器**（独立 docker 网络、不映射到宿主端口、库名以 `_test` 结尾、用完 `down -v`）；默认不连现有的 `hbecho` 库，不连任何跨机地址。要清空 `hbecho` 库必须先确认无数据需要保留并已备份。
     2. 测试机上不放生产凭证、不放未脱敏生产数据。
     3. 测试用的 `.env` 不是 production；AI Master 等付费开关默认关闭或 mock。
     4. 长任务照第 4 条放后台；`pytest` / vitest 要有超时与内存上限，别把测试机本身打满。
   - 测试机上与测试相关的容器、镜像、临时文件，创建与清理**不再逐次征求同意**（第 3 条对测试机的这部分放开）。改安全组、改 RAM、动系统服务、释放实例等仍然要先说明并得到同意。
   - **生产 ECS 尚未购买。** 未来购买并登记后：生产机永远不跑测试（`npm test` / `vitest` / `npm run verify` / `pytest` / 迁移演练）。
   - 在本机（Mac）判断「测试会不会清表」的依据：看它连的是哪个库，而不是看它跑在哪台机器上。

6. **凭证**：只用本机已配好的 profile（`~/.workbench`、`~/.aliyun` 的 `hbecho` / `hbecho-setup`）。不把 AccessKey、`.env` 内容写进仓库、日志或回复；读 `.env` 时只列键名。RAM 没权限的接口不要换更高权限账号去试，告诉用户去控制台看。

## 已知后果

Workbench CLI **没有端口转发**。因此 AI 不能替用户开隧道看服务器上的网页或连图形数据库客户端；需要时由用户在控制台或另行决定访问方式。