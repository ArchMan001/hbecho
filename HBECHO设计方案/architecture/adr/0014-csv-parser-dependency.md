# ADR-0014 · CSV 解析用 csv-parse

- **状态**：accepted
- **日期**：2026-11-05
- **决策人**：刘学奎
- **关闭**：`a-master-data-import` 任务 0 的依赖前置
- **与 ADR-0005 的关系**：ADR-0005 已决定导入只用 CSV、GB18030 解码用 Node 内置 `TextDecoder`。本 ADR 只补「谁来解析 CSV 文本」。

## 背景

主数据导入（`a-master-data-import`）和之后的名单导入（`a-activity-plan`）都要读用户上传的 CSV：权威导出约 8,300 行，文件级校验要求列数与表头一致、引号必须闭合，错了要整批拒绝而不是悄悄吞掉。手写 CSV 解析器要处理引号内换行、转义引号、BOM、`\r\n`，是典型的「不要自己造」。

## 决定

采用：csv-parse 7.x（⭐ 4,288，MIT；仓库 adaltas/node-csv，2026-11-03 仍有提交；2026-11-05 核对）

用途：把已经解码成字符串的 CSV 文本解析为行与单元格，使用严格模式：每行列数必须一致，未闭合的引号报错。

不用它做什么：

- **不做编码判定**。BOM → 严格 UTF-8 → 严格 GB18030 的顺序由 `ImportFileParser` 用 Node 内置 `TextDecoder('…', {fatal:true})` 完成，解码失败整批拒绝（ADR-0005、F-D11）；
- **不做业务分类、不写库、不做公式注入处理**；
- **不让其他模块直接依赖它**：只有 `ImportFileParser` 导入 `csv-parse`，其余代码拿到的是项目自己的行结构。

## 备选与不选原因

| 候选 | 不选原因 |
|---|---|
| PapaParse（⭐ 13k+） | 默认宽容：列数不一致、引号问题只放进 `errors` 数组，需要自己再写一遍严格校验；主要面向浏览器 |
| fast-csv（⭐ 1.7k） | 星标低于阈值，维护不如 csv-parse 活跃 |
| iconv-lite / 编码探测库 | 与 ADR-0005 的 `TextDecoder` 形成第二套解码路径；探测库引入不确定性 |
| 手写解析 | 引号、换行、转义的边界多，违反「不造轮子」 |

## 例外说明

2026-11-05 刘学奎把 `no-reinventing-wheels` 第 6 级的星标线由 5,000 下调为 3,000，csv-parse 满足新阈值，**不再是例外**。

## 后果

- `package.json` 添加 `csv-parse`（精确版本，不加 `^`）；
- `ImportFileParser` 的测试必须覆盖：列数不一致、未闭合引号、引号内换行、BOM、`\r\n`；
- 升级大版本前重跑这些测试。

## 现在谁在守

- `a-master-data-import` 任务 3 的解析测试；
- 代码审查：`csv-parse` 只出现在 `file-parser.ts`。
