// 值状态（五态）→ 数据库列的映射。真实 0 是 value；其余四态 value 列为空；超出 BIGINT 的数记 invalid，不让整页写入失败。
import type { ValueState } from "../provider-adapter";

const MAX_BIGINT = 9223372036854775807n;

export interface CountColumns {
  value: bigint | null;
  state: "value" | "missing" | "explicit_null" | "invalid" | "unsupported";
}

export function countColumns(s: ValueState<bigint>): CountColumns {
  if (s.state === "value") return s.value >= 0n && s.value <= MAX_BIGINT ? { value: s.value, state: "value" } : { value: null, state: "invalid" };
  return { value: null, state: s.state };
}

export function textOrNull(s: ValueState<string>): string | null {
  return s.state === "value" ? s.value : null;
}

/** DECIMAL(20,6) 容纳 14 位整数：更长的整数部分记 invalid，而不是让整页写入失败。 */
export function decimalColumns(s: ValueState<string>): { value: string | null; state: CountColumns["state"] } {
  if (s.state !== "value") return { value: null, state: s.state };
  const int = s.value.split(".")[0]!;
  return int.length <= 14 ? { value: s.value, state: "value" } : { value: null, state: "invalid" };
}


/** 毫秒 → UTC Date；不在 MySQL DATETIME 范围内（<=0 或 >9999 年）返回 null。 */
export function msToDate(s: ValueState<bigint>): Date | null {
  return s.state === "value" && s.value > 0n && s.value <= 253402300799999n ? new Date(Number(s.value)) : null;
}

/** 超长文本不让整笔投影失败：这些展示用的短列放不下就记空，原文仍在 ODS（一年）。 */
export function fit(v: string | null, max: number): string | null {
  return v !== null && v.length <= max ? v : null;
}
