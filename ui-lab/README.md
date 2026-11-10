# ui-lab · 界面原型

> **状态**：已有三个原型：[`hbecho-ui/`](hbecho-ui/README.md)（2026-11-08，v1，保留作对照）、[`hbecho-ui-v2/`](hbecho-ui-v2/README.md)（2026-11-10，**已由刘学奎确认**为 A/B 页面界面基线）、[`g-learning-min/`](g-learning-min/README.md)（2026-11-10，学习平台 1.0，**已由刘学奎确认**）。其余 spec 的原型仍未开始。

## 作用

存放带页面的 spec 的**可点击原型与线框**，让业务能按真实任务走一遍，再请刘学奎确认界面设计（`HBECHO设计方案/ui/ui-foundation.md` §1）。

## 规则

- 不放生产代码；`src/` 不得引用本目录；原型通过后，页面由对应 spec 在 `src/app/` 重新实现；
- 视觉与交互遵守 `ui-foundation.md`；偏离要先改该文档；
- 依赖（若有）自带 `package.json`，不进根 `package.json`，不进 CI 构建；新增依赖仍要按 `no-reinventing-wheels` 登记；
- 按 spec 分目录：`ui-lab/<spec 名>/`，内含原型与 `README.md`（说明走查的任务、走查日期、结论）；
- 线框截图放在对应 spec 的 `wireframes/`，原型只在这里。
