# 本地 UI 入口与修改指引

> **用途**：给本机开发和新会话的 AI 说明「两个本地地址分别是什么、代码在哪、怎么改、什么不能动」。
>
> **状态**：本机说明，不是生产文档；不进入生产构建。

## 两个入口

| 地址 | 是什么 | 代码在哪 | 怎么改 |
|---|---|---|---|
| <http://localhost:4175/> | **静态 UI 原型总览**：A/B v2、学习、域 D 判定计划、域 E 指标与看板等可点击原型 | 当前仓库的 [`ui-lab/`](README.md) | 直接改 HTML / CSS / JS，无构建；刷新浏览器 |
| <http://localhost:3202/login> | **真实 Next.js 应用**：活动计划、账号与监控、主数据、学习、用户与权限、审计日志 | **不在当前 checkout**，在 `~/Documents/hbecho-a-activity-plan`（`a-activity-plan` 工作树，与 `main` 同源） | 改工作树里的 `src/app/` 等，Next dev 自动重载 |

> `http://localhost:3201` 是当前 `c-signals` checkout 的旧应用，页面不全、数据库也旧，**不要用它看完整 UI**。

## 4175：静态原型

入口文件是 [`ui-lab/index.html`](index.html)，由 Python 静态服务器提供：

```bash
python3 -m http.server 4175 --directory ui-lab
```

目录：

- [`ui-lab/hbecho-ui-v2/`](hbecho-ui-v2/README.md)：A 活动计划 / B 访问控制，已确认的视觉基线；
- [`ui-lab/g-learning-min/`](g-learning-min/README.md)：G 学习平台；
- [`ui-lab/d-rule-engine/`](d-rule-engine/README.md)：D 判定计划，原型 v1，**待刘学奎确认**；
- [`ui-lab/e-metrics/`](e-metrics/README.md)：E 指标与看板，原型 v1，**已由刘学奎确认（2026-11-16）**；
- [`ui-lab/hbecho-ui/`](hbecho-ui/README.md)：v1，仅作对照。

规则：

- 原型只用于走查，**不进生产构建，不被 `src/` 引用**；
- 视觉遵循 [`HBECHO设计方案/ui/ui-foundation.md`](../HBECHO设计方案/ui/ui-foundation.md)（2026-11-10 v2 基线）；
- 域 D 的界面在 [`design.md` §15](../.kiro/specs/d-rule-engine/design.md) 有草案；**§15.6 确认表为空时，不写 D 的页面任务、不写 `src/app/` 页面代码**。
- 域 E 的界面在 [`design.md` §20](../.kiro/specs/e-metrics/design.md)；**已于 2026-11-16 由刘学奎确认（§20.6）**，超出确认范围的改动要重新确认；页面代码仍要等查询 / 导出接口（任务 6–9、10a）落地。

## 3202：真实应用

### 代码位置

```text
~/Documents/hbecho-a-activity-plan   # a-activity-plan 工作树，与 main 同源
```

**不是**当前仓库 `/Users/liuxuekui/Documents/hbecho`（当前分支 `c-signals`，缺少活动计划、账号、主数据页面）。

### 启动

```bash
set -a; . ~/Documents/hbecho-a-activity-plan/.env; set +a
pnpm --dir ~/Documents/hbecho-a-activity-plan exec next dev --webpack -p 3202
```

- 必须用 **webpack**，不要用默认 Turbopack：Turbopack dev 在登录页会反复整页重载（HMR 问题）；
- 不要用 `next start`：本地 `.env` 是 `HBECHO_SMS_MODE=fake`、`http://`，生产模式下访问控制配置会拒绝启动；
- 数据库容器：`docker start hbecho-smoke-mysql`（本机 3307，库 `hbecho_local`；**不是 ECS**）。

### 预设账号（仅本机测试库）

密码均为 `Hbecho@2026`，登录时选「密码」页签：

| 手机号 | 姓名 | 角色 |
|---|---|---|
| `13800002041` | 刘学奎 | 平台超管 |
| `13800002042` | 王敏 | 总部人员 |
| `13800002043` | 李静 | 分公司人员 |
| `13800002044` | 张伟 | 门店专员 |

本地库只有最小组织和这几个用户，**业务数据基本为空**；页面会显示空状态，富数据看 4175 的原型。

## 给新会话 AI 的说明（可直接复制）

**只改 4175 的静态原型时：**

> 只改 `ui-lab/` 下的静态原型（HTML/CSS/JS），不要动 `src/app`，不要跑构建；用 `http://localhost:4175/` 验证。视觉遵循 `HBECHO设计方案/ui/ui-foundation.md` 的 v2 基线。域 D 的原型在 `ui-lab/d-rule-engine/`，界面确认在 `design.md` §15.6 填好之前不要写页面任务或 `src/app` 代码。域 E 的原型在 `ui-lab/e-metrics/`，界面已于 2026-11-16 确认（§20.6）；页面任务已列，但页面代码要等查询 / 导出接口（任务 6–9、10a）落地。

**改 3202 的真实页面时：**

> 3202 的代码在 `~/Documents/hbecho-a-activity-plan`（`a-activity-plan` 工作树），**不在当前 checkout**。改那里的 `src/app/`，用 `pnpm --dir ~/Documents/hbecho-a-activity-plan exec next dev --webpack -p 3202` 启动并验证；不要改 `.env`、数据库容器、端口，不要提交或推送，除非我明确要求。当前 checkout 里其它会话的未提交文件也不要动。

**两个都别动的东西：**

- `~/.workbench` / `.env` / 数据库凭证；
- ECS 或生产环境；
- 当前 checkout 的未跟踪文件（D spec、`ui-lab/`、其它会话的文档移动），除非我要求；
- 域 D 的页面任务与 `src/app` D 页面代码（§15.6 未确认）。

## 已知坑

- 4175 的 Python 静态服务器可能被应用停掉；重新运行上面的 `python3 -m http.server` 即可。
- 3202 用了 webpack dev 之后，登录页不再重载；如果又出现「一直刷新」，先确认命令里带了 `--webpack`，并硬刷新浏览器。
- 当前仓库 `c-signals` 的 `src/app` 不完整；在它里面改页面，3202 不会生效。
- 本机 `gh` 直连 GitHub 会超时，需要代理：
  ```bash
  HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 gh ...
  ```
- 本机 UI 相关文件目前是未跟踪状态（`ui-lab/index.html`、`ui-lab/d-rule-engine/`、D spec），不要顺手提交或删除。