# ui-lab · 界面原型
> **本地入口与修改指引**：[`LOCAL-UI.md`](LOCAL-UI.md)（4175 原型 / 3202 完整应用的启动命令、预设账号、与 ECS 的差异、给 AI 的复制说明）。
>
> **协作规则**：[`.kiro/steering/ui-workflow.md`](../.kiro/steering/ui-workflow.md)（改动分类、原型到线上的流转、原型与真实页面的关系）。2026-11-16 起，4175 与 3202 来自**同一个预览工作树**（`~/Documents/hbecho-preview`），用 `./scripts/preview.sh` 一条命令起。

## 原型状态表

新增或归档原型时先改这张表，再放文件。状态含义：**已确认**（刘学奎确认过的设计）、**待确认**、**已实现，归档**（页面已在 `src/app/` 落地并部署，以真实页面为准，原型不再维护）、**对照**（只保留作比较）。

| 目录 | 内容 | 状态 | 实现 / 备注 |
|---|---|---|---|
| [`hbecho-ui/`](hbecho-ui/README.md) | A / B 页面 v1（2026-11-08） | 对照 | 被 v2 取代 |
| [`hbecho-ui-v2/`](hbecho-ui-v2/README.md) | A / B 页面界面基线（2026-11-10） | 已确认；已实现，归档 | 活动计划、账号与监控、主数据导入、用户与权限、审计已在 `src/app/` 落地。**主数据浏览**页（2026-11-16 第二次确认：悬停多选下拉、新增大区、搜索含经销商）已实现，待合并部署 |
| [`g-learning-min/`](g-learning-min/README.md) | 学习平台 1.0（2026-11-10） | 已确认；已实现，归档 | 同目录的 Echo 登录页原型（`#/login`，2026-11-12）为品牌草稿，待调整 |
| [`g-learning-tags-v2/`](g-learning-tags-v2/README.md) | 学习平台两级标签（2026-11-16） | 已确认（2026-11-16）；已实现，待合并部署 | `.kiro/specs/g-learning-tags-v2/`；迁移 `0013`；学习中心、新建课程、标签管理三处页面已落地 |
| [`d-rule-engine/`](d-rule-engine/README.md) | 判定计划：`precision/`（v15，2026-11-13 确认）；根目录 v1 与 `explore/` | `precision/` 已确认；已实现，归档 | 任务 13–16 于 2026-11-16 合并并部署到测试 ECS；截图存档 `app-shots/`。v1 与 `explore/` 为对照 |
| [`e-metrics/`](e-metrics/README.md) | 指标与看板（2026-11-16） | 已确认 | 页面代码等查询 / 导出接口落地后再写 |

## 本地总览（4175）

[`index.html`](index.html) 是本目录的**唯一本地入口**：`./scripts/preview.sh` 起来后打开 <http://localhost:4175/>。它列出：**完整应用**（<http://localhost:3202/>，真实 Next 应用，造好的数据）和上表里的**可点击原型**。

## 作用

存放带页面的 spec 的**可点击原型与线框**，让业务能按真实任务走一遍，再请刘学奎确认界面设计（`HBECHO设计方案/ui/ui-foundation.md` §1）。

## 规则

- 不放生产代码；`src/` 不得引用本目录；原型通过后，页面由对应 spec 在 `src/app/` 重新实现；
- 视觉与交互遵守 `ui-foundation.md`；偏离要先改该文档；
- 依赖（若有）自带 `package.json`，不进根 `package.json`，不进 CI 构建；新增依赖仍要按 `no-reinventing-wheels` 登记；
- 按 spec 分目录：`ui-lab/<spec 名>/`，内含原型与 `README.md`（说明走查的任务、走查日期、结论）；
- 线框截图放在对应 spec 的 `wireframes/`，原型只在这里。
