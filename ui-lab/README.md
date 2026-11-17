# ui-lab · 界面原型

> **本地入口与修改指引**：[`LOCAL-UI.md`](LOCAL-UI.md)（4175 静态原型 / 3202 真实应用、代码位置、启动命令、预设账号、给 AI 的复制说明）。
>
> **状态**：已有四个已确认原型：[`hbecho-ui/`](hbecho-ui/README.md)（2026-11-08，v1，保留作对照）、[`hbecho-ui-v2/`](hbecho-ui-v2/README.md)（2026-11-10，**已由刘学奎确认**为 A/B 页面界面基线；其中「主数据浏览」页为 2026-11-16 新增，**待刘学奎走查确认**）、[`g-learning-min/`](g-learning-min/README.md)（2026-11-10，学习平台 1.0，**已由刘学奎确认**）。域 D 的 [`d-rule-engine/`](d-rule-engine/README.md) 原型 v1 为 2026-11-12 新增，**待刘学奎走查确认**；域 E 的 [`e-metrics/`](e-metrics/README.md) 原型 v1 为 2026-11-16 新增，**已由刘学奎确认**；其余 spec 的原型仍未开始。

## 本地总览（4175）

[`index.html`](index.html) 是本目录的**唯一本地入口**：`python3 -m http.server 4175 --directory ui-lab` 后打开 <http://localhost:4175/>。它列出：

- **完整应用**：<http://localhost:3202/> —— 用与 `main` 同源的 `a-activity-plan` 工作树启动的真实页面（活动计划、账号与监控、主数据、学习、用户与权限、审计日志）；需要登录，和 ECS 上的版本同源；
- **可点击原型**：A/B v2、学习平台 1.0、A/B v1 对照、域 D（进行中）、域 E（已确认）。

完整应用的启动命令：

```bash
pnpm --dir ~/Documents/hbecho-a-activity-plan exec next dev -p 3202
```

当前分支 `c-signals` 尚未包含 `main` 上的活动计划与主数据页面，所以本地完整应用从 `main` 工作树启动，不在本仓库的工作区里合并。

## 本地预设账号（仅本机测试库）

完整应用 `http://localhost:3202/` 的本地账号，密码均为 `Hbecho@2026`，登录时选「密码」页签：

| 手机号 | 姓名 | 角色 |
|---|---|---|
| `13800002041` | 刘学奎 | 平台超管 |
| `13800002042` | 王敏 | 总部人员 |
| `13800002043` | 李静 | 分公司人员 |
| `13800002044` | 张伟 | 门店专员 |

这些账号种在本地库 `hbecho_local`（Docker 容器 `hbecho-smoke-mysql`，端口 3307），**不是 ECS 或生产数据**。若登录失败，先确认容器在运行：

```bash
docker start hbecho-smoke-mysql
```

种子脚本只在本地执行过，没有提交；账号仅用于本机界面走查。

## 作用

存放带页面的 spec 的**可点击原型与线框**，让业务能按真实任务走一遍，再请刘学奎确认界面设计（`HBECHO设计方案/ui/ui-foundation.md` §1）。

## 规则

- 不放生产代码；`src/` 不得引用本目录；原型通过后，页面由对应 spec 在 `src/app/` 重新实现；
- 视觉与交互遵守 `ui-foundation.md`；偏离要先改该文档；
- 依赖（若有）自带 `package.json`，不进根 `package.json`，不进 CI 构建；新增依赖仍要按 `no-reinventing-wheels` 登记；
- 按 spec 分目录：`ui-lab/<spec 名>/`，内含原型与 `README.md`（说明走查的任务、走查日期、结论）；
- 线框截图放在对应 spec 的 `wireframes/`，原型只在这里。
