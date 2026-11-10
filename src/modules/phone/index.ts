// 手机号规范化 `cn-mobile.v1`：全仓库唯一的实现（b-access-control AX-D18，a-activity-plan 引用同一个函数）。
// 规则（a-activity-plan design §7.2）：
//   1. 去首尾空白；删除所有空格、'-'、不间断空格(U+00A0)
//   2. 以 '+86'、'0086' 开头则去掉；否则若恰为 13 位且以 '86' 开头，去掉前两位
//   3. 必须匹配 ^1[3-9]\d{9}$，否则无效
// Excel 把手机号当数字时常变成科学计数法（1.38E+10），按第 3 步判无效。

export const PHONE_RULE_VERSION = "cn-mobile.v1";

const CANONICAL = /^1[3-9]\d{9}$/;

/** 规范化；无效返回 null。 */
export function normalizePhone(input: string): string | null {
  let s = input.trim().replace(/[\s\u00a0-]/g, "");
  if (s.startsWith("+86")) s = s.slice(3);
  else if (s.startsWith("0086")) s = s.slice(4);
  else if (s.length === 13 && s.startsWith("86")) s = s.slice(2);
  return CANONICAL.test(s) ? s : null;
}

/** 已经是规范形态（认证库的入口只接受这个形态）。 */
export const isCanonicalPhone = (s: string): boolean => CANONICAL.test(s);
