# user-import 夹具

用户批量导入（`user-import.v1`）的脱敏造数，**手机号、姓名均为虚构**。品牌 / 分公司 / 门店编码对应 `tests/harness/access.ts` 的 `seedAccessOrg`。

- `basic.utf8.csv`、`basic.utf8-bom.csv`、`basic.gb18030.csv`：同一份 3 行内容的三种编码（总部人员、分公司人员、经销商人员各一行）；预检结果必须完全相同；
- `garbage.bin`：无法识别编码的字节。

其余用例（1,001 行、10 MB + 1、表头不符、引号未闭合、越权行等）在测试里按需生成，不落盘。
