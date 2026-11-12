// 监控段的信号集合（design §6.3）：条目形状、校验与「信号 → 图片槽位」的推导。图片引用由信号键推出目标与种类，条目里不存图片 ID。
import { z } from "zod";
import { requireSignal, type Platform } from "../catalog";
import { SignalError } from "../errors";

export type SegmentItem = { signal: string; element_key?: string; standard_text?: string };
export type ImageSlot = { kind: "template" | "element"; target: "cover" | "background" | "avatar" };

export const MAX_STANDARD_TEXT = 2000;
/** 元素键会进入 OSS 对象键，不能含 `/`，也不能是 `.` / `..`。 */
export const ELEMENT_KEY = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).refine((v) => v !== "." && v !== "..");

const itemSchema = z.object({ signal: z.string(), element_key: z.string().optional(), standard_text: z.string().optional() }).strict();

/** 图片类信号的槽位；其余信号返回 null。 */
export function imageSlotOf(signalKey: string): ImageSlot | null {
  const m = /^(?:content\.(cover)|account\.(bg|avatar))_(template|element)_score$/.exec(signalKey);
  if (!m) return null;
  return { kind: m[3] as ImageSlot["kind"], target: m[1] === "cover" ? "cover" : m[2] === "bg" ? "background" : "avatar" };
}

const invalid = (code: string, message: string): never => {
  throw new SignalError("input", code, message);
};

/** 保存与发布时的统一校验：未注册 → signal_unregistered；平台不可得；条目形状；重复；判定项至多一个。 */
export function validateItems(raw: unknown, platform: Platform): SegmentItem[] {
  if (!Array.isArray(raw)) return invalid("items_invalid", "items 必须是数组");
  const items: SegmentItem[] = raw.map((r) => {
    const p = itemSchema.safeParse(r);
    return p.success ? (p.data as SegmentItem) : invalid("item_invalid", `监控段条目不合法：${p.error.issues[0]?.message ?? ""}`);
  });
  const seen = new Set<string>();
  let judgements = 0;
  for (const it of items) {
    const entry = requireSignal(it.signal);
    if (!(entry.platforms as readonly string[]).includes(platform)) invalid("signal_not_available_on_platform", `信号 ${it.signal} 在 ${platform} 上不可用`);
    const slot = imageSlotOf(it.signal);
    if (slot?.kind === "element") {
      if (it.element_key === undefined || !ELEMENT_KEY.safeParse(it.element_key).success) invalid("element_key_invalid", `元素匹配信号 ${it.signal} 需要合法的 element_key（[A-Za-z0-9_.-]，1–64 位，不能是 . 或 ..）`);
    } else if (it.element_key !== undefined) invalid("element_key_unexpected", `信号 ${it.signal} 不接受 element_key`);
    if (it.signal === "content.asr_judgement") {
      if (++judgements > 1) invalid("too_many_judgements", "每个监控段至多一个 content.asr_judgement");
      const text = it.standard_text?.trim() ?? "";
      if (text.length < 1 || text.length > MAX_STANDARD_TEXT) invalid("standard_text_invalid", `content.asr_judgement 需要 1–${MAX_STANDARD_TEXT} 字的 standard_text`);
    } else if (it.standard_text !== undefined) invalid("standard_text_unexpected", `信号 ${it.signal} 不接受 standard_text`);
    const key = `${it.signal}\u0000${it.element_key ?? ""}`;
    if (seen.has(key)) invalid("duplicate_item", `条目重复：${it.signal}${it.element_key ? `[${it.element_key}]` : ""}`);
    seen.add(key);
  }
  return items;
}
