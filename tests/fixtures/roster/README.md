# 名单导入 fixture（`a-activity-plan`）

全部为**脱敏造数**：门店编码、姓名、手机号、主页链接都是假的，不含真实人员或账号。不提交、不复制真实 xlsx。

- `template-header.utf8.csv`：只有模板表头（`roster-import.v1`，4 列）。
- `basic.utf8.csv` / `basic.utf8-bom.csv` / `basic.gb18030.csv`：同一份内容的三种编码，预检结果必须完全相同。
- `garbage.bin`：既不是合法 UTF-8 也不是合法 GB18030 的字节，应报 `encoding_unrecognized`。
- `mixed.utf8.csv`：含示例行（会被跳过）+ 各类预检结果，对应 `tests/harness/roster.ts` 的 `rosterWorld()` 种子。预期：`new_staff` 1、`new` 1、`unchanged` 1、`update` 1、`error` 5。
- 每个错误码的单元用例在 `classify.test.ts` 里用内存构造，不另存文件。
