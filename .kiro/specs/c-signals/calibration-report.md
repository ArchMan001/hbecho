# image.template@1 / image.element@1 · 标定报告

> **状态**：`draft` · **未标定**。在业务提供样本、本报告填完并由刘学奎签字之前，`image.template` / `image.element` **不得进生产启用集**（design §14 第 7 项，requirements SG-15）。
>
> **关联**：[`design.md`](design.md) §7.8、§14 第 7 项；[`tasks.md`](tasks.md) 任务 7；工具 [`services/capability/calibrate.py`](../../../services/capability/calibrate.py)。
>
> **更新日期**：2026-11-12

## 1. 当前参数（初值，未经真实样本验证）

| 参数 | 初值 | 位置 | 含义 |
|---|---|---|---|
| `R_FULL` | 0.30 | `match.py` | 模板匹配：内点数 / min(两图特征点数) 达到它即满分 |
| `I_FULL` | 25 | `match.py` | 元素匹配：内点数达到它即满分 |
| `MAX_KEYPOINTS` | 1500 | `match.py` | SIFT 特征点上限 |
| `RATIO` | 0.75 | `match.py` | kNN 比率检验阈值 |

初值只为让合成纹理图的排序成立（同图 ≥ 9.5，缩放旋转亮度变化 ≥ 7，无关图 < 2，嵌入元素 ≥ 6，不含元素 < 2）；**它们没有被任何真实封面、背景、头像证明过**。已上线后改任何一个都要升 `capability.version`。

## 2. 需要的样本（业务提供，脱敏）

约 20 对，覆盖：同图、轻度改动（裁剪 / 压缩 / 加水印 / 调色）、无关图；封面、背景、头像各若干；元素图至少含「在场景里」与「不在」各数对。仓库只存样本清单（`pairs.json`：路径、标签、对象），不存业务原图。

## 3. 标定步骤

1. 在测试机上 `cd services/capability && .venv/bin/python calibrate.py pairs.json`；
2. 把每对的分数、内点比率、内点数、特征点数贴进 §4；
3. 选定参数使「同图 / 轻度改动」与「无关图」的分数分布分开，并说明依据与余量；
4. 为每个整数档（0–10）配一张样例图的位置（业务界面展示用）；
5. 刘学奎签字后，把选定值写进 `match.py`，必要时升版本，再把 `image.template` / `image.element` 加入生产的 `HBECHO_SIGNALS_ENABLED`。

## 4. 结果

（待填：样本清单、分数分布、选定的 `R_FULL` / `I_FULL`、每个整数档的样例位置。）

## 5. 签字

| 角色 | 姓名 | 日期 | 结论 |
|---|---|---|---|
| 业务验收 | | | |
| 签字 | 刘学奎 | | |
