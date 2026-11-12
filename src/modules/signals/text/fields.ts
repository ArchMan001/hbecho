// 各平台的列表 / 详情是否返回标题与正文字段（design §7.2、§14 第 6 项）。决定 not_applicable 与 valid 空值的分界：
// 平台没有该字段 → not_applicable(field_absent_on_platform)；平台有字段但这条内容为 NULL / 空串 → valid 的空值。
//
// 依据（fixture，任务 3 逐平台核对，见 fields.test.ts）：列表条目的 title、text.content 两个字段，
//   抖音   40 条：title 40/40，body 1/40（有此字段，多数条目为空）
//   小红书 42 条：title 42/42，body 37/42
//   快手   63 条：title 63/63（15 条为空串），body 0/63（键从未出现）
// ponytail: 快手 body 的结论来自 3 份列表 fixture 共 63 条；若真实环境出现快手正文，在此改为 true 并升 text 能力版本。
export const PLATFORM_TEXT_FIELDS: Readonly<Record<string, { readonly title: boolean; readonly body: boolean }>> = {
  douyin: { title: true, body: true },
  xiaohongshu: { title: true, body: true },
  kuaishou: { title: true, body: false },
};
