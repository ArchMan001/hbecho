import { LearningError } from "./errors";

const MAX_SIGNED_BIGINT = 9223372036854775807n;

/** API 里的内部 ID 是十进制字符串；严格解析，不经过 Number。 */
export function parseId(raw: unknown, field: string): bigint {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,18}$/.test(raw)) throw new LearningError("input", "invalid_id", `${field} 不是合法的 ID`);
  const v = BigInt(raw);
  if (v > MAX_SIGNED_BIGINT) throw new LearningError("input", "invalid_id", `${field} 不是合法的 ID`);
  return v;
}
