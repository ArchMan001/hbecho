# ADR-0003 · GitHub 作为权威远端，Codeup 降级为可选镜像

- **状态**：accepted
- **日期**：2026-09-03
- **决策人**：刘学奎
- **替代**：runbook 原计划中「Codeup 权威远端 + GitHub 镜像」的倾向

## 背景

原设计倾向阿里云 Codeup：服务器与 OSS 都在阿里云，`git pull` 走内网更快。但 2026-09-03 云效组织创建受阻，而仓库必须私有（含甲方身份、组织结构、手机号语义、门店编码口径与 AI Master 接口合同）。GitHub SSH 已实测可用。

## 决定

- `origin` = `git@github.com:ArchMan001/hbecho.git`，Private。
- 服务器使用**只读部署密钥** clone 到 `/data/app/hbecho`。
- Codeup 排障通过后作为**可选镜像**补建，不迁移历史；若切换，只换服务器 `~/.ssh/config` 的 Host，不重建目录。

## 备选与不选原因

| 方案 | 不选原因 |
|---|---|
| 等 Codeup 排障完成再建远端 | 阻塞后续所有工作，且 Codeup 不是硬约束 |
| 公开仓库 | 一次性泄露甲方身份、组织结构与接口合同 |

## 后果

- 服务器拉取走公网 GitHub，而不是阿里云内网；当前规模可接受。
- 部署密钥只读是服务端强制的，已用真实推送测试确认。
- 两个远端都必须私有；`git push all` 是泄露传播最快的路径。

## 现在谁在守

- 匿名访问返回 404（已实测）。
- 服务器写权限实测被 GitHub 拒绝（`marked as read only`）。
- runbook §9.7 记录 clone 与验证步骤。

## 原文

`HBECHO设计方案/runbooks/server-operations-runbook.md` §9.3、§9.6、§9.7。