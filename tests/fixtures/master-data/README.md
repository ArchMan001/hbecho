# master-data 测试夹具

全部是**脱敏造数**（商家名、编码都是虚构的），用来验证编码识别与表头校验。

- `small.utf8.csv` / `small.utf8-bom.csv` / `small.gb18030.csv`：同一份内容的三种编码；
- `with-owner-12cols.csv`：多出「负责人」列的 12 列文件，应整批拒绝；
- `garbage.bin`：既不是合法 UTF-8 也不是合法 GB18030 的字节。

真实权威导出（`最终的权威信息.xlsx` 等）被 `.gitignore` 排除，不得复制到本目录。
