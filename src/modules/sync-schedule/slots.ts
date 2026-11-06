// 周期时点计算（FS-1、design §7.1）。Asia/Shanghai 自 1991 年起无夏令时，按固定 UTC+8 计算，不引入时区库。
// 每周一周从北京时间周一 00:00 开始；weekday 是 ISO 编号（周一=1 … 周日=7）。
import { z } from "zod";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** 北京时间 = UTC + 8h，固定偏移。 */
const BEIJING_OFFSET = 8 * HOUR;

export const slotSchema = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time 必须是 HH:MM（24 小时制）"),
});
/** 每周 1–2 个时点（D-30），不得重复。 */
export const slotsSchema = z
  .array(slotSchema)
  .min(1)
  .max(2)
  .refine((s) => s.length < 2 || s[0]!.weekday !== s[1]!.weekday || s[0]!.time !== s[1]!.time, "时点重复");
export type Slot = z.infer<typeof slotSchema>;

/** 包含 t 的那一周的起点：北京时间周一 00:00（返回 UTC 时刻）。 */
export function weekStart(t: Date): Date {
  const day = Math.floor((t.getTime() + BEIJING_OFFSET) / DAY); // 北京日历日，自 1970-01-01（周四）起
  const sinceMonday = (day + 3) % 7; // 1970-01-01 是周四 → 周一为 0 的星期序号
  return new Date((day - sinceMonday) * DAY - BEIJING_OFFSET);
}

export function slotInstant(start: Date, slot: Slot): Date {
  const [hh, mm] = slot.time.split(":").map(Number) as [number, number];
  return new Date(start.getTime() + (slot.weekday - 1) * DAY + hh * HOUR + mm * 60_000);
}

function candidates(t: Date, slots: readonly Slot[], weekOffsets: readonly number[]): Date[] {
  const base = weekStart(t).getTime();
  return weekOffsets.flatMap((w) => slots.map((s) => slotInstant(new Date(base + w * WEEK), s)));
}

/** 不晚于 now 的最近一个时点（含恰好等于 now）。 */
export function latestSlotAtOrBefore(now: Date, slots: readonly Slot[]): Date {
  const hit = candidates(now, slots, [-1, 0]).filter((c) => c.getTime() <= now.getTime());
  return new Date(Math.max(...hit.map((c) => c.getTime())));
}

/** 严格晚于 t 的最近一个时点。 */
export function nextSlotAfter(t: Date, slots: readonly Slot[]): Date {
  const hit = candidates(t, slots, [0, 1]).filter((c) => c.getTime() > t.getTime());
  return new Date(Math.min(...hit.map((c) => c.getTime())));
}
