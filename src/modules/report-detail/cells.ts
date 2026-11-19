// 单元格规则（requirements EL-3 / EL-4 / EL-5；纯函数）。D「不把没拿到写成 0」：获取失败写原因码，缺失留空，绝不写 0。
import type { ConditionDesc } from "../judgement/config";
import type { AbilityResult } from "../judgement/engine/pure/ability";
import type { ContentEvidence } from "../judgement/outcomes";
import type { Cell, Tone } from "./types";

export const SKIPPED_TEXT = "前置条件未满足，不进行计算";
const t = (text: string, tone: Tone = "plain"): Cell => ({ text, tone });
export const emptyCell = (): Cell => t("");

/** 仅 http / https 才输出链接，其余（javascript:、data:、空）一律不输出。 */
export function httpUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}
const BJT = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** UTC 时刻 → 北京时间 `YYYY-MM-DD HH:mm`；缺失留空。 */
export function fmtBjt(d: Date | null | undefined): string {
  if (!d) return "";
  const s = BJT.format(d); // sv-SE：`2026-11-18 20:20`
  return s.replace(/\u00a0/g, " ");
}
/** 公式注入：以 = + - @ \t \r 开头的文本前加 '（ADR-0011，与 F-D11 一致）。数字单元格不经过这里。 */
export function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
/** 值状态四态：value → 数字（真实 0 显示 0）；invalid → 「无效」；missing / explicit_null / unsupported → 空。 */
export function valueCell(state: string, value: bigint | number | null | undefined): Cell {
  if (state === "invalid") return t("无效", "unobtained");
  if (state !== "value" || value === null || value === undefined) return t("");
  const big = typeof value === "bigint" ? value : BigInt(value);
  const c: Cell = t(big.toString());
  if (big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= 0n) c.num = Number(big);
  return c;
}
/** D 的秒数是 DECIMAL 文本（如 "30.000000"）：去掉多余的小数零；不是数字就原样。 */
export const secondsText = (s: string): string => (Number.isFinite(Number(s)) && s.trim() !== "" ? String(Number(s)) : s);
export const kindLabel = (k: string): string => (k === "video" ? "视频" : k === "image" || k === "text" ? "图文" : "未知");

/** 一条内容行里单元格规则用到的部分。 */
export interface ContentCellInput {
  final: string | null;
  /** 停在第几层（"0"–"3"）；走完全部层为 null */
  stopLayer: string | null;
  reasonCode: string | null;
  evidence: ContentEvidence;
  comments: { total: number | null; pass: number | null };
}
const LAYER_OF = (c: ConditionDesc): number => (c.layer === "comment" ? 2.5 : c.layer);
/**
 * 没评估到：更早的层是**获取失败**而停下（发布时间缺失、形态未知、第 1/2 层未获取成功……）→ 该行原因码（获取失败）；
 * 否则（被更早的层判定不通过、没被数量要求选中）→ 前置条件未满足。D 的每一行都有明确的停层位置，所以不存在无法解释的空。
 */
function notEvaluated(f: ContentCellInput, c: ConditionDesc): Cell {
  if (f.final === "unobtained" && f.stopLayer !== null && Number(f.stopLayer) < LAYER_OF(c)) return t(f.reasonCode ?? "unknown", "unobtained");
  return t(SKIPPED_TEXT, "skipped");
}
interface Entry { state: string; hit?: string[]; seconds?: string; reason?: string; score?: string; verdict?: string }
export function contentCell(c: ConditionDesc, f: ContentCellInput): Cell {
  if (c.layer === "comment") {
    if (f.comments.total !== null) return t(`命中 ${f.comments.pass ?? 0} / 共 ${f.comments.total} 条`);
    return notEvaluated(f, c);
  }
  const e: Entry | undefined =
    c.layer === 1 ? f.evidence.l1?.find((x) => x.idx === Number(c.key.slice(3)))
    : c.layer === 2 ? f.evidence.l2?.find((x) => `l2.${x.id}` === c.key)
    : f.evidence.l3;
  if (!e) return notEvaluated(f, c);
  if (e.state === "unobtained") return t(e.reason ?? f.reasonCode ?? "unknown", "unobtained");
  const tone: Tone = e.state === "pass" ? "pass" : "fail";
  switch (c.kind) {
    case "text":
    case "hashtags":
      return t(e.hit?.length ? e.hit.join("、") : "未命中", tone);
    case "duration":
      return t(e.seconds !== undefined ? `${secondsText(e.seconds)} 秒` : "", tone);
    case "asr":
      return t(e.verdict === "meets" ? "达标" : "不达标", tone);
    default:
      return t(e.score ?? "", tone); // 整图 / 元素对比：显示分数，颜色表示是否达到阈值
  }
}
const OUT: Record<string, [string, Tone]> = {
  success: ["通过", "pass"],
  not_met: ["不通过", "fail"],
  unobtained: ["获取失败", "unobtained"],
  skipped: [SKIPPED_TEXT, "skipped"],
};
/** 账号维度：每个条件四态；abilityResults 为 null（旧执行）整列空。 */
export function accountCell(c: ConditionDesc, results: readonly AbilityResult[] | null): Cell {
  if (results === null) return emptyCell();
  const r = results.find((x) => x.key === c.key);
  if (!r) return emptyCell();
  const [text, tone] = OUT[r.result]!;
  return t(r.result === "unobtained" && r.reason ? `${text}：${r.reason}` : text, tone);
}
/** 判定结果 = D 的 plan_result：成功 → 通过、不达标 → 不通过、未获取成功 → 获取失败。 */
export function resultCell(plan: string): Cell {
  const [text, tone] = OUT[plan] ?? ["", "plain" as Tone];
  return t(text, tone);
}
export const SYNC_LABEL = { ok: "是", partial: "部分（有缺口）", failed: "否", none: "无记录" } as const;
