// 窗口换算：北京时间自然日（闭区间）→ UTC 半开区间 [from, to)。Asia/Shanghai 固定 +08:00，没有夏令时。
const BJT_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 北京日期 → 当日 00:00+08 的 UTC 时刻；非法日期（含 2026-02-30）抛错。 */
export function bjtDayStartUtc(day: string): Date {
  const m = DATE_RE.exec(day);
  if (!m) throw new Error(`日期格式必须是 YYYY-MM-DD：${day}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new Error(`不存在的日期：${day}`);
  return new Date(probe.getTime() - BJT_MS);
}

/** to 缺省 = 到冻结时刻；否则 min(to 次日零点, 冻结时刻)。 */
export function bjtDaysToUtc(w: { from: string; to?: string | undefined }, frozenAt: Date): { fromUtc: Date; toUtc: Date } {
  const fromUtc = bjtDayStartUtc(w.from);
  if (w.to === undefined) return { fromUtc, toUtc: frozenAt };
  const end = new Date(bjtDayStartUtc(w.to).getTime() + DAY_MS);
  return { fromUtc, toUtc: end.getTime() < frozenAt.getTime() ? end : frozenAt };
}
