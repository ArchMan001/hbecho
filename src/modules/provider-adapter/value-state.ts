// 五态值状态（v2 §5.2）。真实 0、缺失、显式 null、非法、接口不支持互不转换。
// readXxx 只会产出前四种；unsupported 由接口语义决定（例如列表播放数），不由取值产生。
import { JsonNumber, type JsonObject, type JsonValue } from "./lossless-json";

export type ValueState<T> =
  | { state: "value"; value: T }
  | { state: "missing" }
  | { state: "explicit_null" }
  | { state: "invalid"; raw: string }
  | { state: "unsupported" };

export type CountState = ValueState<bigint>;

export const UNSUPPORTED = Object.freeze({ state: "unsupported" }) as { state: "unsupported" };

/** 非法值的原文表示，仅用于 invalid 状态的留痕。 */
export function rawOf(v: JsonValue): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof JsonNumber) return v.source;
  if (Array.isArray(v)) return "<array>";
  if (typeof v === "object" && v !== null) return "<object>";
  return String(v);
}

const has = (obj: JsonObject, key: string) => Object.hasOwn(obj, key);

function classifyCount(obj: JsonObject, key: string): CountState {
  if (!has(obj, key)) return { state: "missing" };
  const v = obj[key] as JsonValue;
  if (v === null) return { state: "explicit_null" };
  if (v instanceof JsonNumber && /^\d+$/.test(v.source)) return { state: "value", value: BigInt(v.source) };
  // 供应商以十进制字符串给出的同一事实（profile 的 *_count）；拒绝前导零与非数字
  if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)) return { state: "value", value: BigInt(v) };
  return { state: "invalid", raw: rawOf(v) };
}

/** 非负整数计数。多个候选字段时，第一个有效值胜出；否则取 invalid > explicit_null > missing 中最强的。 */
export function readCount(obj: JsonObject, ...keys: string[]): CountState {
  const results = keys.map((k) => classifyCount(obj, k));
  const valid = results.find((r) => r.state === "value");
  if (valid) return valid;
  return (
    results.find((r) => r.state === "invalid") ??
    results.find((r) => r.state === "explicit_null") ??
    ({ state: "missing" } as const)
  );
}

/** 外部 ID：一律文本。字符串原样，整数 token 取原文；空串与其他类型为 invalid。 */
export function readExternalId(obj: JsonObject, key: string): ValueState<string> {
  if (!has(obj, key)) return { state: "missing" };
  const v = obj[key] as JsonValue;
  if (v === null) return { state: "explicit_null" };
  if (typeof v === "string" && v.length > 0) return { state: "value", value: v };
  if (v instanceof JsonNumber && /^\d+$/.test(v.source)) return { state: "value", value: v.source };
  return { state: "invalid", raw: rawOf(v) };
}

/** 普通文本字段：空串是有效文本。 */
export function readText(obj: JsonObject, key: string): ValueState<string> {
  if (!has(obj, key)) return { state: "missing" };
  const v = obj[key] as JsonValue;
  if (v === null) return { state: "explicit_null" };
  if (typeof v === "string") return { state: "value", value: v };
  return { state: "invalid", raw: rawOf(v) };
}
