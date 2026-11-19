# 经销商视频广场 · 界面原型（f-video-square）

> **状态**：`原型 v1 · 已确认`（2026-11-18 起草，刘学奎 2026-11-19 确认，design §10.6）。确认范围不含「AI分析示意页」（正式页面不做）。本目录不进生产构建，不被 `src/` 引用。
>
> **依据**：[`design.md` §10](../../.kiro/specs/f-video-square/design.md)、[`requirements.md`](../../.kiro/specs/f-video-square/requirements.md)、[`ui-foundation.md`](../../HBECHO设计方案/ui/ui-foundation.md)（v2 基线）。
>
> **结构**：以 [`../hbecho-ui-v2/`](../hbecho-ui-v2/README.md) 为底的独立拷贝（避免与其它分支对共享原型文件的改动冲突，做法同 `g-learning-tags-v2`）；视觉、外壳、角色切换沿用 v2。新增文件只有 `pages-f-square.js`，其余是 `app.js` / `ui.js` / `store.js` / `styles.css` 里的少量增补（搜 `sq` / `square`）。

## 怎么打开

本地 UI 入口是 4100（见 [`ui-lab/LOCAL-UI.md`](../LOCAL-UI.md)）：

```bash
python3 -m http.server 4100 --directory ui-lab
```

- 广场列表：<http://localhost:4100/f-video-square/#/square>
- AI分析界面示意：<http://localhost:4100/f-video-square/#/square/ai/v1>

## 走查要点

- 默认条件：全部品牌 / 全部平台 / **视频** / 其余全部；按点赞从高到低；每页 20 条。
- 三行芯片与四个下拉都是单选；改动立即刷新；标题搜索点「搜索」或回车生效；「重置」全部回默认。
- 「参与活动计划」默认置灰（提示「暂未开放」；打开条件见 requirements U2）；列表右上「原型：预览上线后的效果」可看打开后的样子。
- 悬浮卡片出现「观看」「AI分析」；窄屏 / 触屏按钮常驻。「AI分析」弹「功能正在开发中」；弹窗里的「原型：查看界面示意」进入示意页，**正式页面不做该示意页**（design U5）。
- 顶部「官媒阵地」灰色不可点；卡片没有收藏星标。
- 左下「原型控制」可切换角色与加载 / 空 / 无权限 / 错误状态。

演示数据（标题、账号名、数字）全部虚构。
