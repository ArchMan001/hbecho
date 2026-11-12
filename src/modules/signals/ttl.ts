// 保留期（design §7.11）：成功结果与历史行 1 年，失败结果 3 个月。UTC 日历加法，不依赖进程时区。
const plusMonths = (d: Date, n: number): Date => {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
};
export const successExpiry = (producedAt: Date): Date => plusMonths(producedAt, 12);
export const failureExpiry = (producedAt: Date): Date => plusMonths(producedAt, 3);
/** 历史行：取代时刻 + 1 年。 */
export const historyExpiry = successExpiry;
